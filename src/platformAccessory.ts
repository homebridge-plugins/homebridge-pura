import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PuraPlatform } from './platform.js';
import {
  DIFFUSION_MODE_ALTERNATING,
  DIFFUSION_MODE_SINGLE_BAY,
  PuraApi,
  runsBaysConcurrently,
} from './puraApi.js';
import { PuraConfig, PuraDevice, PuraBay } from './puraTypes.js';

/**
 * Pura Platform Accessory
 * One diffuser service per device, with optional Nightlight Control service.
 */
export class PuraPlatformAccessory {
  private service: Service;
  private nightlightService?: Service;
  private autoAlternateService?: Service;
  private device: PuraDevice;
  private useFanService: boolean;
  private enableBoundNightlightService: boolean;

  private currentStateActive = false;
  private lastNightlightOffAt = 0;
  private inferredOfflineFromStaleState = false;
  private lastAwayModeEnabledState: boolean | null = null;
  private lastAutoAlternativeOffState: boolean | null = null;
  private recentIntensityHold?: { until: number; level: number };
  private nightlightWriteQueue: Promise<void> = Promise.resolve();
  private pendingNightlightActive?: boolean;
  private lastNightlightApiWrite?: {
    at: number;
    active: boolean;
    level: number;
    color: string;
    reason: 'on' | 'brightness' | 'hue' | 'saturation';
  };
  private lastNightlightColorLogAt = 0;
  private lastNightlightLog?: { at: number; active: boolean; level: number };
  private pendingNightlightOnLog?: { at: number; brightnessPercent: number };
  private pendingNightlightOnLogTimer?: ReturnType<typeof setTimeout>;
  private pendingNightlightIntent?: {
    at: number;
    ttlMs: number;
    active: boolean;
    level: number;
    color: string;
  };
  private recentNightlightHold?: { until: number; level: number };
  private lastNightlightCommand?: {
    at: number;
    action: 'brightness' | 'on';
    requestedOn: boolean;
    hkBrightnessPercent: number;
    sentLevel: number;
  };
  private pendingIntensityIntent?: {
    at: number;
    ttlMs: number;
    intensity: number;
    bay?: 1 | 2;
  };
  private pendingPowerOnIntensityIntent?: {
    at: number;
    ttlMs: number;
    intensity: number;
  };
  private pendingPowerOnIntensityLog?: {
    at: number;
    intensity: number;
  };
  private pendingPowerOnIntensityLogTimer?: ReturnType<typeof setTimeout>;
  private lastDiffuserActivatedAt?: number;
  private activeBayNumber?: 1 | 2;
  private lastSuccessfulOnWriteAt?: number;
  private lastSetOnCommandAt?: number;
  private lastRotationWriteAt?: number;
  private lastRequestedOnIntensity?: number;
  private secondaryBaySyncQueue: Promise<void> = Promise.resolve();
  private pendingSecondaryBaySync?: {
    bays: Array<1 | 2>;
    intensity: number;
    controller: string;
  };
  private pendingSecondaryBaySyncTimer?: ReturnType<typeof setTimeout>;
  private lastUnavailableCommandWarnAt = 0;
  private lastNoScentVialsWarnAt = 0;
  private rotationWriteQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly platform: PuraPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly puraApi: PuraApi,
  ) {
    this.device = accessory.context.device;

    const safeModel = this.device.type && this.device.type.length > 1 ? this.device.type : 'Pura Diffuser';
    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    const firmwareRevision = this.getFirmwareRevision();
    const hardwareRevision = this.getHardwareRevision();
    infoService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Pura')
      .setCharacteristic(this.platform.Characteristic.Model, safeModel)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id);
    const revisionChanged = this.applyRevisionCharacteristics(infoService, firmwareRevision, hardwareRevision);
    const contextChanged = this.persistRevisionContext(firmwareRevision, hardwareRevision);
    if (revisionChanged || contextChanged) {
      this.platform.persistAccessoryIfRegistered(this.accessory);
      if (this.platform.isDebugEnabled()) {
        this.platform.log.debug(
          `Persisted accessory metadata for ${this.accessory.displayName} (startup): ` +
          `revisionChanged=${revisionChanged}, contextChanged=${contextChanged}`,
        );
      }
    }

    this.useFanService = Boolean(
      (this.platform.config as PuraConfig).enableFanService ??
      (this.platform.config as PuraConfig).useFanService,
    );
    // Nightlight controls can be exposed on this diffuser accessory when configured in bound mode.
    this.enableBoundNightlightService = this.shouldUseBoundNightlightService();
    const fanService = this.accessory.getService(this.platform.Service.Fanv2);
    const switchService = this.accessory.getService(this.platform.Service.Switch);
    if (this.useFanService) {
      if (switchService) {
        this.accessory.removeService(switchService);
      }
      this.service = fanService || this.accessory.addService(this.platform.Service.Fanv2);
    } else {
      if (fanService) {
        this.accessory.removeService(fanService);
      }
      this.service = switchService || this.accessory.addService(this.platform.Service.Switch);
    }

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    const activeCharacteristic = this.useFanService
      ? this.platform.Characteristic.Active
      : this.platform.Characteristic.On;
    this.service.getCharacteristic(activeCharacteristic)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));
    if (this.useFanService) {
      this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .setProps({
          minValue: 0,
          maxValue: 100,
          minStep: 1,
        })
        .onSet(this.setRotationSpeed.bind(this))
        .onGet(this.getRotationSpeed.bind(this));
    }

    this.configureNightlightService();
    this.configureAutoAlternateService();
    this.updateCurrentState();
    this.updateFaultState();
    this.logRecommendationHints(this.device);
  }

  private configureNightlightService() {
    const existing = this.accessory.getServiceById(this.platform.Service.Lightbulb, 'nightlight');
    if (!this.enableBoundNightlightService || !this.supportsNightlightControl()) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      this.nightlightService = undefined;
      return;
    }

    // Same reasoning as the auto-alternate switch: without ConfiguredName the Home app names this
    // after the accessory, so it read as "Diffuser" alongside the diffuser's own tile. The prefix
    // goes too, since Home already shows it nested under the accessory.
    const name = 'Nightlight';
    this.nightlightService = existing || this.accessory.addService(this.platform.Service.Lightbulb, name, 'nightlight');
    this.setServiceName(this.nightlightService, name);
    this.nightlightService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setNightlightOn.bind(this))
      .onGet(this.getNightlightOn.bind(this));
    this.nightlightService.getCharacteristic(this.platform.Characteristic.Brightness)
      .setProps({ minStep: 10 })
      .onSet(this.setNightlightBrightness.bind(this))
      .onGet(this.getNightlightBrightness.bind(this));
    this.nightlightService.getCharacteristic(this.platform.Characteristic.Hue)
      .onSet(this.setNightlightHue.bind(this))
      .onGet(this.getNightlightHue.bind(this));
    this.nightlightService.getCharacteristic(this.platform.Characteristic.Saturation)
      .onSet(this.setNightlightSaturation.bind(this))
      .onGet(this.getNightlightSaturation.bind(this));
  }

  private isNightlightControlEnabled(): boolean {
    return Boolean((this.platform.config as PuraConfig).enableNightlightAccessory ?? false);
  }

  private hasSeparateNightlightAccessoryConfigured(): boolean {
    // Nightlight controls are locked to single-tile (bound) mode.
    return false;
  }

  private shouldUseBoundNightlightService(): boolean {
    return this.isNightlightControlEnabled();
  }

  /**
   * Name a service so the Home app shows it. Setting only `Name` is not enough for a service inside
   * an accessory - Home falls back to the accessory's own name, which is why extra services all read
   * as "Diffuser". `ConfiguredName` is the characteristic it actually reads, and it stays editable,
   * so a name the user sets themselves still wins.
   */
  private setServiceName(service: Service, name: string) {
    service.displayName = name;
    service.setCharacteristic(this.platform.Characteristic.Name, name);
    service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
    service.setCharacteristic(this.platform.Characteristic.ConfiguredName, name);
  }

  private isAutoAlternateControlEnabled(): boolean {
    return Boolean((this.platform.config as PuraConfig).enableAutoAlternate ?? false);
  }

  /** Only multi-bay hardware has anything to alternate between. */
  private supportsAutoAlternate(): boolean {
    const raw = this.device.__raw as Record<string, unknown> | undefined;
    return Boolean((this.device.bay1 && this.device.bay2) || (raw?.bay1 && raw?.bay2));
  }

  /**
   * Exposes Pura's "Auto-alternate fragrances" setting as a switch. The plugin previously only
   * detected this being off and asked the user to go and change it in the Pura app; the API can set
   * it directly, and it is the setting that decides whether both bays run at once.
   */
  private configureAutoAlternateService() {
    const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'auto-alternate');
    if (!this.isAutoAlternateControlEnabled() || !this.supportsAutoAlternate()) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      this.autoAlternateService = undefined;
      return;
    }

    // Named without the diffuser prefix: Home already shows it under the accessory, so repeating
    // it reads as "Hallway Diffuser > Hallway Diffuser Auto-Alternate". The wording matches the
    // Pura app's own label for the setting.
    const name = 'Auto-Alternate Fragrances';
    this.autoAlternateService = existing
      || this.accessory.addService(this.platform.Service.Switch, name, 'auto-alternate');
    this.setServiceName(this.autoAlternateService, name);
    this.autoAlternateService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setAutoAlternate.bind(this))
      .onGet(this.getAutoAlternate.bind(this));
    this.applyAutoAlternateState();
  }

  private applyAutoAlternateState() {
    this.autoAlternateService?.updateCharacteristic(
      this.platform.Characteristic.On,
      runsBaysConcurrently(this.device.diffusionMode),
    );
  }

  private async getAutoAlternate(): Promise<CharacteristicValue> {
    if (this.isDeviceUnavailable()) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return runsBaysConcurrently(this.device.diffusionMode);
  }

  private async setAutoAlternate(value: CharacteristicValue) {
    const enabled = Boolean(value);
    const mode = enabled ? DIFFUSION_MODE_ALTERNATING : DIFFUSION_MODE_SINGLE_BAY;
    if (this.isDeviceUnavailable()) {
      this.logUnavailableCommandWarning();
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    if (!await this.puraApi.setDiffusionMode(this.device.id, mode)) {
      this.applyAutoAlternateState();
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    // Reflect it immediately rather than waiting for the poll, then reconcile. The mode changes
    // how bay state is interpreted, so a stale value here misreads the whole device.
    this.device = { ...this.device, diffusionMode: mode };
    this.applyAutoAlternateState();
    this.platform.requestRefreshSoon(2000);
    this.platform.log.info(
      `${this.getDiffuserLogLabel()} auto-alternate fragrances turned ${enabled ? 'on' : 'off'}.`,
    );
  }

  private updateCurrentState() {
    const activeBay = this.getActiveBay();
    this.currentStateActive = Boolean(activeBay);
    this.activeBayNumber = activeBay
      ? (activeBay === this.device.bay1 ? 1 : 2)
      : undefined;
    if (activeBay) {
      this.accessory.context.lastBay = activeBay === this.device.bay1 ? 1 : 2;
      if (Number.isFinite(activeBay.intensity) && activeBay.intensity > 0) {
        this.accessory.context.lastIntensity = activeBay.intensity;
      }
    }
    this.applyCurrentState();
    this.applyNightlightState();
    this.updateFaultState();
  }

  private mapRotationToIntensity(speed: number): number {
    const clamped = Math.max(0, Math.min(100, Number(speed) || 0));
    if (clamped <= 0) {
      return 0;
    }
    if (clamped <= 33) {
      return 30;
    }
    if (clamped <= 66) {
      return 50;
    }
    return 100;
  }

  private mapIntensityToRotation(intensity: number): number {
    const clamped = Math.max(0, Math.min(100, Number(intensity) || 0));
    if (clamped <= 40) {
      return 30;
    }
    if (clamped <= 75) {
      return 50;
    }
    return 100;
  }

  private getCurrentIntensityValue(): number | undefined {
    const pendingIntentIntensity = this.getPendingIntensityIntentValue();
    if (pendingIntentIntensity !== undefined) {
      return pendingIntentIntensity;
    }
    const activeBay = this.getActiveBay();
    const bayIntensity = activeBay?.intensity;
    if (typeof bayIntensity === 'number' && Number.isFinite(bayIntensity) && bayIntensity > 0) {
      return bayIntensity;
    }
    const cachedIntensity = Number(this.accessory.context.lastIntensity);
    if (Number.isFinite(cachedIntensity) && cachedIntensity > 0) {
      return cachedIntensity;
    }
    return undefined;
  }

  private hasNoScentVialsDetected(): boolean {
    return !this.device.bay1 && !this.device.bay2;
  }

  private isDeviceOffline(): boolean {
    return this.normalizeOnlineState(this.device.online) === false;
  }

  private isLikelyOfflineFromStaleStatus(): boolean {
    if (this.normalizeOnlineState(this.device.online) !== true) {
      return false;
    }
    if (!this.hasNoScentVialsDetected()) {
      return false;
    }
    const ageMs = this.getLastSeenAgeMs();
    return ageMs !== undefined && ageMs > 120000;
  }

  private isDeviceUnavailable(): boolean {
    return this.isDeviceOffline() || this.isLikelyOfflineFromStaleStatus();
  }

  private shouldResetAwayModeBeforeActivating(): boolean {
    const raw = this.device.__raw as Record<string, unknown> | undefined;
    const awayModeValue = raw?.awayMode ?? this.device.awayMode;
    if (typeof awayModeValue === 'boolean') {
      return awayModeValue;
    }
    if (awayModeValue && typeof awayModeValue === 'object') {
      const awayModeRecord = awayModeValue as Record<string, unknown>;
      const away = typeof awayModeRecord.away === 'boolean' ? awayModeRecord.away : undefined;
      const enabled = typeof awayModeRecord.enabled === 'boolean' ? awayModeRecord.enabled : undefined;
      if (away !== undefined || enabled !== undefined) {
        return Boolean(away || enabled);
      }
    }
    // If away-mode state is unknown, preserve existing behavior and clear it before activation.
    return true;
  }

  private updateFaultState() {
    if (!this.service.testCharacteristic(this.platform.Characteristic.StatusFault)) {
      return;
    }
    const nextFault = (this.hasNoScentVialsDetected() || this.isDeviceUnavailable())
      ? this.platform.Characteristic.StatusFault.GENERAL_FAULT
      : this.platform.Characteristic.StatusFault.NO_FAULT;
    this.service.updateCharacteristic(this.platform.Characteristic.StatusFault, nextFault);
  }

  private enforceOffVisualState() {
    this.currentStateActive = false;
    this.applyCurrentState();
    // Home may optimistically show ON after onSet succeeds; push OFF again on next tick.
    setTimeout(() => {
      this.currentStateActive = false;
      this.applyCurrentState();
    }, 100);
  }

  private getActiveBay(): PuraBay | undefined {
    const bay1 = this.fillBayIntensityFromCache(this.device.bay1);
    const bay2 = this.fillBayIntensityFromCache(this.device.bay2);
    if (bay1?.active && !bay2?.active) {
      return bay1;
    }
    if (bay2?.active && !bay1?.active) {
      return bay2;
    }
    if (bay1?.active && bay2?.active) {
      const bay1ActiveAt = bay1.activeAt ?? 0;
      const bay2ActiveAt = bay2.activeAt ?? 0;
      if (bay1ActiveAt !== bay2ActiveAt) {
        return bay1ActiveAt > bay2ActiveAt ? bay1 : bay2;
      }
      return bay1.intensity >= bay2.intensity ? bay1 : bay2;
    }
    const bay1HasIntensity = Number.isFinite(bay1?.intensity) && Number(bay1?.intensity) > 0;
    const bay2HasIntensity = Number.isFinite(bay2?.intensity) && Number(bay2?.intensity) > 0;
    if (bay1HasIntensity && !bay2HasIntensity) {
      return bay1;
    }
    if (bay2HasIntensity && !bay1HasIntensity) {
      return bay2;
    }
    if (bay1HasIntensity && bay2HasIntensity) {
      const bay1ActiveAt = bay1?.activeAt ?? 0;
      const bay2ActiveAt = bay2?.activeAt ?? 0;
      if (bay1ActiveAt !== bay2ActiveAt) {
        return bay1ActiveAt > bay2ActiveAt ? bay1 : bay2;
      }
      return (bay1?.intensity ?? 0) >= (bay2?.intensity ?? 0) ? bay1 : bay2;
    }
    // Fallback: some payloads clear active/intensity but still include a recent activeAt.
    const inferred = this.getActiveBayFromActiveAt(bay1, bay2);
    if (inferred) {
      return inferred;
    }
    return undefined;
  }

  private getAvailableBays(): Array<1 | 2> {
    const bays: Array<1 | 2> = [];
    if (this.device.bay1) {
      bays.push(1);
    }
    if (this.device.bay2) {
      bays.push(2);
    }
    return bays;
  }

  private areAllAvailableBaysAtIntensity(intensity: number): boolean {
    const bays = this.getAvailableBays();
    if (bays.length === 0) {
      return false;
    }
    return bays.every((bay) => {
      const payload = bay === 1 ? this.device.bay1 : this.device.bay2;
      return Number(payload?.intensity) === intensity;
    });
  }

  private async setIntensityAcrossAvailableBays(
    targetBay: 1 | 2,
    intensity: number,
    controller: string,
    syncSecondary = true,
  ): Promise<boolean> {
    const availableBays = this.getAvailableBays();
    if (availableBays.length === 0) {
      return false;
    }
    const orderedBays = availableBays.includes(targetBay)
      ? [targetBay, ...availableBays.filter((bay) => bay !== targetBay)]
      : availableBays;
    const [primaryBay, ...secondaryBays] = orderedBays;

    const primarySuccess = await this.puraApi.setIntensity(this.device.id, primaryBay, intensity, controller);
    if (!primarySuccess) {
      return false;
    }

    if (syncSecondary && secondaryBays.length > 0) {
      // Do not block the primary command path on secondary bay sync; this keeps HomeKit writes responsive.
      void this.syncSecondaryBayIntensities(secondaryBays, intensity, controller);
    }

    return true;
  }

  private async syncSecondaryBayIntensities(
    bays: Array<1 | 2>,
    intensity: number,
    controller: string,
  ): Promise<void> {
    const failedBays: Array<1 | 2> = [];
    for (const bay of bays) {
      const success = await this.puraApi.setIntensity(this.device.id, bay, intensity, controller);
      if (!success) {
        failedBays.push(bay);
      }
    }
    if (failedBays.length > 0) {
      this.platform.log.warn(
        `${this.getDiffuserLogLabel()} intensity synced to active bay, but failed on bay(s): ${failedBays.join(', ')}.`,
      );
      return;
    }
    if (this.platform.isDebugEnabled()) {
      this.platform.log.debug(
        `${this.getDiffuserLogLabel()} intensity synced to secondary bay(s): ${bays.join(', ')}.`,
      );
    }
  }

  private queueSecondaryBayIntensitySync(
    bays: Array<1 | 2>,
    intensity: number,
    controller: string,
  ): void {
    if (bays.length === 0) {
      return;
    }
    this.pendingSecondaryBaySync = {
      bays: [...bays],
      intensity,
      controller,
    };
    if (this.pendingSecondaryBaySyncTimer) {
      clearTimeout(this.pendingSecondaryBaySyncTimer);
      this.pendingSecondaryBaySyncTimer = undefined;
    }
    const debounceMs = 750;
    this.pendingSecondaryBaySyncTimer = setTimeout(() => {
      const pending = this.pendingSecondaryBaySync;
      this.pendingSecondaryBaySync = undefined;
      if (this.pendingSecondaryBaySyncTimer) {
        clearTimeout(this.pendingSecondaryBaySyncTimer);
        this.pendingSecondaryBaySyncTimer = undefined;
      }
      if (!pending) {
        return;
      }
      if (!this.currentStateActive) {
        if (this.platform.isDebugEnabled()) {
          this.platform.log.debug(
            `[Diffuser] Skipping deferred secondary bay intensity sync for ${this.getDiffuserLogLabel()} while inactive.`,
          );
        }
        return;
      }
      const run = async () => {
        await this.syncSecondaryBayIntensities(pending.bays, pending.intensity, pending.controller);
      };
      const queued = this.secondaryBaySyncQueue.then(run, run);
      this.secondaryBaySyncQueue = queued.then(
        () => undefined,
        () => undefined,
      );
      void queued;
    }, debounceMs);
  }

  private clearPendingSecondaryBayIntensitySync() {
    this.pendingSecondaryBaySync = undefined;
    if (this.pendingSecondaryBaySyncTimer) {
      clearTimeout(this.pendingSecondaryBaySyncTimer);
      this.pendingSecondaryBaySyncTimer = undefined;
    }
  }

  async setOn(value: CharacteristicValue) {
    await this.enqueueRotationWrite(async () => {
      const diffuserLabel = this.getDiffuserLogLabel();
      const isOn = this.useFanService
        ? value === this.platform.Characteristic.Active.ACTIVE
        : Boolean(value);
      this.lastSetOnCommandAt = Date.now();
      this.platform.log.debug(`Set Characteristic Active for ${diffuserLabel} ->`, value);
      this.platform.recordIntent(this.device.id, isOn);

      try {
        if (isOn) {
          if (this.currentStateActive) {
            this.applyCurrentState();
            if (this.platform.isDebugEnabled()) {
              this.platform.log.debug(
                `[Diffuser] Ignoring redundant ON command for ${diffuserLabel} because it is already active.`,
              );
            }
            return;
          }
          if (this.useFanService && this.service.testCharacteristic(this.platform.Characteristic.RotationSpeed)) {
            // Home commonly sets RotationSpeed=100 when turning the accessory on via icon tap.
            // Capture that value early so we turn on at 100 without briefly showing the cached intensity.
            const readMappedIntensity = () => {
              const currentValue = this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed).value;
              const numericSpeed = Math.max(0, Math.min(100, Number(currentValue) || 0));
              return this.mapRotationToIntensity(numericSpeed);
            };

            const firstMapped = readMappedIntensity();
            if (firstMapped > 0) {
              this.pendingPowerOnIntensityIntent = {
                at: Date.now(),
                ttlMs: 12000,
                intensity: firstMapped,
              };
              this.lastRequestedOnIntensity = firstMapped;
            }

            // Home may send RotationSpeed shortly after Active=1, and the characteristic value can lag slightly.
            // Give it a brief settle window, then prefer the latest non-zero mapped intensity.
            await new Promise((resolve) => setTimeout(resolve, 350));
            const secondMapped = readMappedIntensity();
            if (secondMapped > 0 && secondMapped !== this.pendingPowerOnIntensityIntent?.intensity) {
              this.pendingPowerOnIntensityIntent = {
                at: Date.now(),
                ttlMs: 12000,
                intensity: secondMapped,
              };
              this.lastRequestedOnIntensity = secondMapped;
            }
          }
          const preferredBay = this.accessory.context.lastBay;
          const normalizedPreferred = preferredBay === 1 || preferredBay === 2 ? preferredBay : undefined;
          const targetBay = normalizedPreferred && (normalizedPreferred === 1 ? this.device.bay1 : this.device.bay2)
            ? normalizedPreferred
            : (this.device.bay1 ? 1 : this.device.bay2 ? 2 : 1);
          const bay = targetBay === 1 ? this.device.bay1 : this.device.bay2;
          const noScentVialsDetected = this.hasNoScentVialsDetected();
          const deviceUnavailable = this.isDeviceUnavailable();
          if (!bay && this.platform.isDebugEnabled()) {
            this.platform.log.warn(
              `No bay payload available for ${diffuserLabel}; using fallback bay ${targetBay}.`,
            );
          }
          const candidateIntensity = bay && Number.isFinite(bay.intensity) && bay.intensity > 0
            ? bay.intensity
            : undefined;
          const preferredIntensity = Number.isFinite(this.accessory.context.lastIntensity) && this.accessory.context.lastIntensity > 0
            ? this.accessory.context.lastIntensity
            : undefined;
          const defaultIntensity = this.useFanService ? 100 : 60;
          const fallbackIntensity = Math.max(
            1,
            Math.min(100, preferredIntensity ?? candidateIntensity ?? defaultIntensity),
          );
          this.lastRequestedOnIntensity = fallbackIntensity;
          if (noScentVialsDetected || deviceUnavailable) {
            this.enforceOffVisualState();
            this.updateFaultState();
            if (deviceUnavailable) {
              this.logUnavailableCommandWarning();
              throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
              );
            } else {
              this.logNoScentVialsWarning();
            }
            return;
          }

          if (this.shouldResetAwayModeBeforeActivating()) {
            await this.puraApi.setAwayMode(this.device.id, false);
          }
          const alwaysOn = await this.puraApi.setAlwaysOn(this.device.id, targetBay);
          const requestedPowerOnIntensity = this.getPendingPowerOnIntensityIntentValue();
          const intensity = Math.max(1, Math.min(100, requestedPowerOnIntensity ?? fallbackIntensity));
          const controller = this.device.controller || 'default';
          const success = alwaysOn && await this.setIntensityAcrossAvailableBays(targetBay, intensity, controller, true);
          if (success) {
            this.currentStateActive = true;
            const activatedAt = Date.now();
            this.lastSuccessfulOnWriteAt = activatedAt;
            this.lastDiffuserActivatedAt = activatedAt;
            this.pendingPowerOnIntensityIntent = undefined;
            this.accessory.context.lastIntensity = intensity;
            this.accessory.context.lastBay = targetBay;
            this.pendingIntensityIntent = {
              at: Date.now(),
              ttlMs: 15000,
              intensity,
              bay: targetBay,
            };
            this.platform.log.debug(`Successfully turned on ${diffuserLabel} with intensity ${intensity}`);
            this.applyCurrentState();
            this.platform.log.info(`${diffuserLabel} turned on.`);
            // When Home turns the fan accessory on, it commonly sends RotationSpeed writes that we may suppress
            // as "pending intent". Debounce this log so quick follow-up RotationSpeed writes emit one final value.
            if (this.useFanService) {
              this.queuePendingPowerOnIntensityLog(intensity);
            }
            if ((this.platform.config as PuraConfig).forceNightlightOff && this.supportsNightlightControl()) {
              await this.ensureNightlightOff();
            }
          } else {
            this.platform.log.error(`Failed to turn on ${diffuserLabel}`);
            throw new Error('Failed to turn on device');
          }
        } else {
          this.pendingIntensityIntent = undefined;
          this.pendingPowerOnIntensityIntent = undefined;
          this.clearPendingSecondaryBayIntensitySync();
          this.cancelPendingPowerOnIntensityLog();
          if (!this.currentStateActive) {
            this.applyCurrentState();
            if (this.platform.isDebugEnabled()) {
              this.platform.log.debug(
                `[Diffuser] Ignoring redundant OFF command for ${diffuserLabel} because it is already inactive.`,
              );
            }
            return;
          }
          if (this.isDeviceUnavailable()) {
            this.enforceOffVisualState();
            this.updateFaultState();
            this.logUnavailableCommandWarning();
            throw new this.platform.api.hap.HapStatusError(
              this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
            );
            return;
          }
          if (this.shouldSuppressConflictingOffCommand('setOn')) {
            this.applyCurrentState();
            return;
          }
          const success = await this.puraApi.stopAll(this.device.id);
          if (success) {
            this.currentStateActive = false;
            this.lastSuccessfulOnWriteAt = undefined;
            // Diffuser OFF often changes nightlight state in cloud. Clear local nightlight intent/hold so
            // OFF snapshots are not treated as stale and logs can reflect the transition.
            this.pendingNightlightIntent = undefined;
            this.recentNightlightHold = undefined;
            this.platform.log.debug(`Successfully turned off ${diffuserLabel}`);
            this.applyCurrentState();
            this.platform.log.info(`${diffuserLabel} turned off.`);
            // Reconcile Pura state after power-off. Nightlight state is sometimes omitted from realtime payloads.
            this.platform.requestRefreshSoon(2500);
          } else {
            this.platform.log.error(`Failed to turn off ${diffuserLabel}`);
            throw new Error('Failed to turn off device');
          }
        }
      } catch (error) {
        if (this.isHapStatusError(error)) {
          throw error;
        }
        this.platform.log.error(`Error setting On state for ${diffuserLabel}:`, error);
        // Fail soft to avoid Home app "No Response" on transient API errors.
        this.applyCurrentState();
      }
    });
  }

  async getOn(): Promise<CharacteristicValue> {
    const diffuserLabel = this.getDiffuserLogLabel();
    if (this.isDeviceUnavailable()) {
      this.updateFaultState();
      this.platform.log.debug(
        `Get Characteristic Active for ${diffuserLabel} -> unavailable (service communication failure)`,
      );
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    const isActive = this.getCurrentStateValue();
    this.platform.log.debug(`Get Characteristic Active for ${diffuserLabel} ->`, isActive);
    return isActive;
  }

  async getRotationSpeed(): Promise<CharacteristicValue> {
    if (!this.useFanService) {
      return 0;
    }
    if (this.isDeviceUnavailable()) {
      this.updateFaultState();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (!this.currentStateActive) {
      return 0;
    }
    const intensity = this.getCurrentIntensityValue();
    if (typeof intensity !== 'number') {
      const currentValue = this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed).value;
      const numericCurrentValue = Number(currentValue);
      return Number.isFinite(numericCurrentValue) ? numericCurrentValue : 0;
    }
    return this.mapIntensityToRotation(intensity);
  }

  async setRotationSpeed(value: CharacteristicValue) {
    await this.enqueueRotationWrite(async () => {
      const diffuserLabel = this.getDiffuserLogLabel();
      try {
        if (!this.useFanService) {
          return;
        }
        this.lastRotationWriteAt = Date.now();
        const speed = Math.max(0, Math.min(100, Number(value) || 0));
        const mappedIntensity = this.mapRotationToIntensity(speed);
        const snappedSpeed = mappedIntensity <= 0 ? 0 : this.mapIntensityToRotation(mappedIntensity);
        if (speed <= 0) {
          this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, 0);
          this.pendingIntensityIntent = undefined;
          this.pendingPowerOnIntensityIntent = undefined;
          this.cancelPendingPowerOnIntensityLog();
          if (!this.currentStateActive) {
            this.applyCurrentState();
            return;
          }
          if (this.isDeviceUnavailable()) {
            this.enforceOffVisualState();
            this.updateFaultState();
            this.logUnavailableCommandWarning();
            throw new this.platform.api.hap.HapStatusError(
              this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
            );
            return;
          }
          if (this.shouldSuppressConflictingOffCommand('rotation')) {
            this.applyCurrentState();
            return;
          }
          this.platform.recordIntent(this.device.id, false);
          const success = await this.puraApi.stopAll(this.device.id);
          if (success) {
            this.currentStateActive = false;
            this.lastSuccessfulOnWriteAt = undefined;
            this.pendingNightlightIntent = undefined;
            this.recentNightlightHold = undefined;
            this.platform.log.debug(`Successfully turned off ${diffuserLabel} via RotationSpeed=0`);
            this.platform.log.info(`${diffuserLabel} turned off.`);
          } else {
            this.platform.log.warn(
              `Failed to turn off ${diffuserLabel} via RotationSpeed=0; preserving current state.`,
            );
          }
          this.applyCurrentState();
          return;
        }
        if (mappedIntensity > 0) {
          this.pendingPowerOnIntensityIntent = {
            at: Date.now(),
            ttlMs: 20000,
            intensity: mappedIntensity,
          };
        }
        const onCommandAgeMs = this.lastSetOnCommandAt ? Date.now() - this.lastSetOnCommandAt : undefined;
        const isLikelyHomeImplicitOnSpeed = !this.currentStateActive
          && speed === 100
          && onCommandAgeMs !== undefined
          && onCommandAgeMs >= 0
          && onCommandAgeMs <= 1500;
        if (isLikelyHomeImplicitOnSpeed) {
          if (this.platform.isDebugEnabled()) {
            this.platform.log.debug(
              `[Diffuser] Deferring implicit power-on RotationSpeed=100 for ${diffuserLabel} ` +
              `(ageMs=${onCommandAgeMs}). Pending power-on intensity=${mappedIntensity}.`,
            );
          }
          return;
        }
        if (this.platform.isDebugEnabled()) {
          this.platform.log.debug(
            `[Diffuser] Set RotationSpeed for ${diffuserLabel}: ` +
            `raw=${value} normalized=${speed} snapped=${snappedSpeed} mappedIntensity=${mappedIntensity}`,
          );
        }
        this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, snappedSpeed);
        const sinceLastOnMs = this.lastSuccessfulOnWriteAt !== undefined
          ? Date.now() - this.lastSuccessfulOnWriteAt
          : undefined;
        const pendingIntentIntensity = this.getPendingIntensityIntentValue();
        const likelyStalePostOnDownshift = this.currentStateActive
          && sinceLastOnMs !== undefined
          && sinceLastOnMs >= 0
          && sinceLastOnMs <= 1500
          && pendingIntentIntensity !== undefined
          && mappedIntensity > 0
          && mappedIntensity < pendingIntentIntensity;
        if (likelyStalePostOnDownshift) {
          if (this.platform.isDebugEnabled()) {
            this.platform.log.debug(
              `[Diffuser] Ignoring likely stale post-ON RotationSpeed for ${diffuserLabel}: ` +
              `incoming=${mappedIntensity} retained=${pendingIntentIntensity} sinceLastOnMs=${sinceLastOnMs}`,
            );
          }
          this.service.updateCharacteristic(
            this.platform.Characteristic.RotationSpeed,
            this.mapIntensityToRotation(pendingIntentIntensity),
          );
          this.applyCurrentState();
          return;
        }
        if (pendingIntentIntensity === mappedIntensity) {
          this.applyCurrentState();
          if (this.platform.isDebugEnabled()) {
            this.platform.log.debug(
              `[Diffuser] Skipping duplicate intensity write for ${diffuserLabel}: ${mappedIntensity} (pending intent)`,
            );
          }
          return;
        }
        const allowWhileInactive = this.shouldAllowRotationWriteWhileInactive(onCommandAgeMs);
        if (!allowWhileInactive) {
          if (this.platform.isDebugEnabled()) {
            this.platform.log.debug(
              `[Diffuser] Ignoring RotationSpeed write for ${diffuserLabel} while inactive ` +
              `(raw=${value}, snapped=${snappedSpeed}, onAgeMs=${onCommandAgeMs ?? 'n/a'}).`,
            );
          }
          return;
        }
        this.accessory.context.lastIntensity = mappedIntensity;
        if (this.isDeviceUnavailable()) {
          this.updateFaultState();
          this.logUnavailableCommandWarning();
          if (this.platform.isDebugEnabled()) {
            this.platform.log.debug(
              `${diffuserLabel} appears unavailable while adjusting intensity; preserving current state.`,
            );
          }
          this.applyCurrentState();
          throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
          );
        }
        if (this.hasNoScentVialsDetected()) {
          this.enforceOffVisualState();
          this.updateFaultState();
          this.logNoScentVialsWarning();
          return;
        }
        const preferredBay = this.accessory.context.lastBay;
        const normalizedPreferred = preferredBay === 1 || preferredBay === 2 ? preferredBay : undefined;
        const targetBay = normalizedPreferred && (normalizedPreferred === 1 ? this.device.bay1 : this.device.bay2)
          ? normalizedPreferred
          : (this.device.bay1 ? 1 : this.device.bay2 ? 2 : 1);
        if (!this.currentStateActive) {
          // Stale cloud snapshots can temporarily mark the diffuser inactive even while HomeKit is actively controlling it.
          // Re-assert Always On before applying intensity to avoid dropped writes and slider bounce.
          this.platform.recordIntent(this.device.id, true);
          if (this.shouldResetAwayModeBeforeActivating()) {
            await this.puraApi.setAwayMode(this.device.id, false);
          }
          const alwaysOn = await this.puraApi.setAlwaysOn(this.device.id, targetBay);
          if (!alwaysOn) {
            this.platform.log.warn(
              `${diffuserLabel} could not be re-armed while setting intensity; preserving current state.`,
            );
            this.applyCurrentState();
            return;
          }
          this.currentStateActive = true;
          const activatedAt = Date.now();
          this.lastSuccessfulOnWriteAt = activatedAt;
          this.lastDiffuserActivatedAt = activatedAt;
        }
        if (this.areAllAvailableBaysAtIntensity(mappedIntensity)) {
          this.applyCurrentState();
          if (this.platform.isDebugEnabled()) {
            this.platform.log.debug(
              `[Diffuser] Skipping duplicate intensity write for ${diffuserLabel}: ${mappedIntensity} (already active)`,
            );
          }
          return;
        }
        const controller = this.device.controller || 'default';
        const previousPendingIntent = this.pendingIntensityIntent;
        this.pendingIntensityIntent = {
          at: Date.now(),
          ttlMs: 15000,
          intensity: mappedIntensity,
          bay: targetBay,
        };
        // Keep the active bay write in the foreground for HomeKit responsiveness.
        // Secondary bays are synced in a debounced background queue so auto-alternate does not revive stale intensity.
        const success = await this.setIntensityAcrossAvailableBays(targetBay, mappedIntensity, controller, false);
        if (!success) {
          this.pendingIntensityIntent = previousPendingIntent;
          this.platform.log.warn(
            `${diffuserLabel} intensity write failed (raw=${value}, snapped=${snappedSpeed}, targetBay=${targetBay}). ` +
            'Keeping last known state to avoid HomeKit no-response.',
          );
          this.applyCurrentState();
          return;
        }
        this.accessory.context.lastBay = targetBay;
        const secondaryBays = this.getAvailableBays().filter((bay) => bay !== targetBay);
        this.queueSecondaryBayIntensitySync(secondaryBays, mappedIntensity, controller);
        this.pendingIntensityIntent = {
          at: Date.now(),
          ttlMs: 15000,
          intensity: mappedIntensity,
          bay: targetBay,
        };
        this.recentIntensityHold = { until: Date.now() + 15000, level: mappedIntensity };
        this.cancelPendingPowerOnIntensityLog();
        this.platform.log.info(
          `${diffuserLabel} intensity set to ${mappedIntensity} ` +
          `(${this.describeIntensityLevel(mappedIntensity)}).`,
        );
        this.applyCurrentState();
      } catch (error) {
        if (this.isHapStatusError(error)) {
          throw error;
        }
        this.platform.log.error(`Error setting RotationSpeed for ${diffuserLabel}:`, error);
        // Fail soft for slider writes to avoid Home app "No Response" for transient intensity update errors.
        this.applyCurrentState();
      }
    });
  }

  private isHapStatusError(error: unknown): boolean {
    if (error instanceof this.platform.api.hap.HapStatusError) {
      return true;
    }
    return typeof error === 'object'
      && error !== null
      && 'hapStatus' in error;
  }

  async setNightlightOn(value: CharacteristicValue) {
    if (!this.nightlightService || !this.supportsNightlightControl()) {
      return;
    }
    if (this.isDeviceUnavailable()) {
      this.updateFaultState();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    await this.enqueueNightlightWrite(async () => {
      this.platform.recordNightlightInteraction(this.device.id);
      const active = Boolean(value);
      const currentActive = Boolean(this.device.nightlight?.active);
      const currentRawBrightness = this.normalizeNightlightLevel(this.device.nightlight?.brightness);
      const characteristicBrightnessValue = Number(
        this.nightlightService?.getCharacteristic(this.platform.Characteristic.Brightness).value,
      );
      const characteristicBrightnessPercent = Number.isFinite(characteristicBrightnessValue)
        ? Math.max(0, Math.min(100, Math.round(characteristicBrightnessValue)))
        : 0;
      const storedBrightnessPercent = this.nightlightLevelToPercent(currentRawBrightness ?? 10);
      const brightnessPercent = active && !currentActive
        ? (characteristicBrightnessPercent > 0 ? characteristicBrightnessPercent : 100)
        : storedBrightnessPercent;
      const sentLevel = this.percentToNightlightLevel(brightnessPercent);
      const controller = this.device.controller || 'default';
      const color = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
      this.pendingNightlightActive = active;

      // HomeKit commonly sends On=true right after setting Brightness/Color; skip the redundant API write.
      if (this.shouldSkipRedundantNightlightOnWrite(active)) {
        this.platform.log.debug(
          `[Nightlight] Skipping redundant On write for ${this.accessory.displayName} -> ${active} (recent api write).`,
        );
        this.device.nightlight = {
          active,
          brightness: sentLevel,
          color,
        };
        this.pendingNightlightIntent = {
          at: Date.now(),
          ttlMs: active ? 20000 : 15000,
          active,
          level: sentLevel,
          color,
        };
        this.logNightlightToggle(active, brightnessPercent);
        this.applyNightlightState();
        return;
      }

      this.platform.log.debug(
        `[Nightlight] Set On for ${this.accessory.displayName} -> ${active}; ` +
        `rawBrightness=${currentRawBrightness ?? 'unknown'} mappedBrightness=${brightnessPercent}% color=${color}`,
      );

      const success = await this.puraApi.setNightlight(this.device.id, active, brightnessPercent, color, controller);
      if (!success) {
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }

      this.device.nightlight = {
        active,
        brightness: sentLevel,
        color,
      };
      this.recentNightlightHold = active ? { until: Date.now() + 20000, level: sentLevel } : undefined;
      this.lastNightlightApiWrite = {
        at: Date.now(),
        active,
        level: sentLevel,
        color,
        reason: 'on',
      };
      this.pendingNightlightIntent = {
        at: Date.now(),
        ttlMs: active ? 20000 : 15000,
        active,
        level: sentLevel,
        color,
      };
      this.recordNightlightCommand('on', active, brightnessPercent, sentLevel);
      const nightlightLabel = this.getNightlightLogLabel();
      if (active) {
        this.platform.log.info(`${nightlightLabel} turned on.`);
      } else {
        this.platform.log.info(this.getNightlightOffLogMessage(nightlightLabel));
      }
      this.applyNightlightState();
    });
  }

  async getNightlightOn(): Promise<CharacteristicValue> {
    if (this.isDeviceUnavailable()) {
      this.updateFaultState();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    const active = Boolean(this.device.nightlight?.active);
    this.platform.log.debug(`[Nightlight] Get On for ${this.accessory.displayName} -> ${active}`);
    return active;
  }

  async setNightlightBrightness(value: CharacteristicValue) {
    if (!this.nightlightService || !this.supportsNightlightControl()) {
      return;
    }
    if (this.isDeviceUnavailable()) {
      this.updateFaultState();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    await this.enqueueNightlightWrite(async () => {
      this.platform.recordNightlightInteraction(this.device.id);
      const brightnessPercent = Math.max(0, Math.min(100, Number(value) || 0));
      const turningOff = brightnessPercent <= 0;
      const apiLevel = turningOff
        ? (this.normalizeNightlightLevel(this.device.nightlight?.brightness) ?? 1)
        : this.percentToNightlightLevel(brightnessPercent);
      const snappedPercent = turningOff ? 0 : this.nightlightLevelToPercent(apiLevel);
      // In HomeKit, setting a non-zero brightness implies turning the light on.
      const active = turningOff ? false : true;
      const controller = this.device.controller || 'default';
      const color = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
      const apiBrightnessPercent = this.nightlightLevelToPercent(apiLevel);
      this.pendingNightlightActive = active;

      // HomeKit scenes/automations can emit redundant brightness writes. Skipping them reduces out-of-order
      // cloud snapshots that look like "bouncing" in the Home app.
      const currentActive = Boolean(this.device.nightlight?.active);
      const currentLevel = this.normalizeNightlightLevel(this.device.nightlight?.brightness) ?? 10;
      const currentColor = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
      const isRedundant = currentActive === active && currentLevel === apiLevel && currentColor === color;
      if (isRedundant) {
        this.platform.log.debug(
          `[Nightlight] Skipping redundant Brightness write for ${this.accessory.displayName} -> ${brightnessPercent}% ` +
          `(snapped=${snappedPercent}%, mappedLevel=${apiLevel}, active=${active}, color=${color}).`,
        );
        this.pendingNightlightIntent = {
          at: Date.now(),
          ttlMs: active ? 20000 : 15000,
          active,
          level: apiLevel,
          color,
        };
        if (!active) {
          this.logNightlightToggle(false, 0);
        } else if (!currentActive) {
          this.logNightlightToggle(true, snappedPercent);
        }
        this.applyNightlightState();
        this.nightlightService?.updateCharacteristic(this.platform.Characteristic.Brightness, snappedPercent);
        return;
      }

      this.platform.log.debug(
        `[Nightlight] Set Brightness for ${this.accessory.displayName} -> ${brightnessPercent}% ` +
        `(snapped=${snappedPercent}%, apiBrightness=${apiBrightnessPercent}%, mappedLevel=${apiLevel}, active=${active}, color=${color})`,
      );

      const success = await this.puraApi.setNightlight(this.device.id, active, apiBrightnessPercent, color, controller);
      if (!success) {
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }

      this.device.nightlight = {
        active,
        brightness: apiLevel,
        color,
      };
      this.recentNightlightHold = active ? { until: Date.now() + 20000, level: apiLevel } : undefined;
      this.lastNightlightApiWrite = {
        at: Date.now(),
        active,
        level: apiLevel,
        color,
        reason: 'brightness',
      };
      this.pendingNightlightIntent = {
        at: Date.now(),
        ttlMs: active ? 20000 : 15000,
        active,
        level: apiLevel,
        color,
      };
      if (!active) {
        this.logNightlightToggle(false, 0);
      } else if (!currentActive) {
        this.logNightlightToggle(true, snappedPercent);
      }
      this.recordNightlightCommand('brightness', active, snappedPercent, apiLevel);
      this.applyNightlightState();
      this.nightlightService?.updateCharacteristic(this.platform.Characteristic.Brightness, snappedPercent);
    });
  }

  async getNightlightBrightness(): Promise<CharacteristicValue> {
    if (this.isDeviceUnavailable()) {
      this.updateFaultState();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    const brightness = this.device.nightlight?.active === true
      ? this.nightlightLevelToPercent(this.device.nightlight?.brightness)
      : 0;
    this.platform.log.debug(
      `[Nightlight] Get Brightness for ${this.accessory.displayName} -> ${brightness}% ` +
      `(raw=${this.device.nightlight?.brightness ?? 'unknown'})`,
    );
    return brightness;
  }

  async setNightlightHue(value: CharacteristicValue) {
    if (!this.nightlightService || !this.supportsNightlightControl()) {
      return;
    }
    if (this.isDeviceUnavailable()) {
      this.updateFaultState();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    await this.enqueueNightlightWrite(async () => {
      this.platform.recordNightlightInteraction(this.device.id);
      // In HomeKit, setting color implies turning the light on.
      this.pendingNightlightActive = true;
      const hue = Math.max(0, Math.min(360, Number(value) || 0));
      const currentColor = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
      const currentHsv = this.hexToHsv(currentColor);
      const nextColor = this.hsvToHex(hue, currentHsv.s);
      await this.applyNightlightColor(nextColor, 'hue', hue, currentHsv.s);
    });
  }

  async getNightlightHue(): Promise<CharacteristicValue> {
    if (this.isDeviceUnavailable()) {
      this.updateFaultState();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    const color = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
    const hsv = this.hexToHsv(color);
    return hsv.h;
  }

  async setNightlightSaturation(value: CharacteristicValue) {
    if (!this.nightlightService || !this.supportsNightlightControl()) {
      return;
    }
    if (this.isDeviceUnavailable()) {
      this.updateFaultState();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    await this.enqueueNightlightWrite(async () => {
      this.platform.recordNightlightInteraction(this.device.id);
      // In HomeKit, setting color implies turning the light on.
      this.pendingNightlightActive = true;
      const saturation = Math.max(0, Math.min(100, Number(value) || 0));
      const currentColor = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
      const currentHsv = this.hexToHsv(currentColor);
      const nextColor = this.hsvToHex(currentHsv.h, saturation);
      await this.applyNightlightColor(nextColor, 'saturation', currentHsv.h, saturation);
    });
  }

  async getNightlightSaturation(): Promise<CharacteristicValue> {
    if (this.isDeviceUnavailable()) {
      this.updateFaultState();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    const color = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
    const hsv = this.hexToHsv(color);
    return hsv.s;
  }

  updateDevice(device: PuraDevice) {
    const previousDiffuserActive = this.currentStateActive;
    const previousActiveBayNumber = this.activeBayNumber;
    const nightlightStabilizedDevice = this.clampNightlightDuringHold(
      this.stabilizeNightlightDuringIntentWindow(device),
    );
    const stabilizedDevice = this.stabilizeIntensityDuringIntentWindow(nightlightStabilizedDevice);
    const previousNightlight = this.device.nightlight;
    const previousOnline = this.normalizeOnlineState(this.device.online);
    const nextOnline = this.normalizeOnlineState(stabilizedDevice.online);
    this.logOnlineStateTransition(previousOnline, nextOnline);
    this.device = stabilizedDevice;
    this.configureAutoAlternateService();
    if (typeof stabilizedDevice.nightlight?.active === 'boolean') {
      this.pendingNightlightActive = stabilizedDevice.nightlight.active;
    }
    this.logInferredOfflineTransition();
    this.logRecommendationHints(stabilizedDevice);
    this.accessory.context.device = stabilizedDevice;
    this.updateAccessoryInformation();
    if (this.platform.isDebugEnabled()) {
      this.platform.log.debug('Device snapshot:', this.summarizeDevice(stabilizedDevice));
    }
    const previousNightlightActive = Boolean(previousNightlight?.active);
    const nextNightlightActive = Boolean(stabilizedDevice.nightlight?.active);
    const hasDedicatedNightlightAccessory = this.hasSeparateNightlightAccessoryConfigured();
    if (!hasDedicatedNightlightAccessory && previousNightlightActive !== nextNightlightActive) {
      const nextBrightness = nextNightlightActive
        ? this.nightlightLevelToPercent(stabilizedDevice.nightlight?.brightness)
        : 0;
      this.logNightlightToggle(nextNightlightActive, nextBrightness);
    }
    this.logNightlightProfileRoundTrip(previousNightlight, stabilizedDevice.nightlight);
    this.updateCurrentState();
    // Pura re-syncs the nightlight whenever diffusion starts on a bay - which includes switching
    // from one bay to the other while already running, as a timer or the auto-alternate cycle does.
    // Arming only on an off->on transition missed those, so the nightlight came on and stayed on.
    const diffuserJustActivated = !previousDiffuserActive && this.currentStateActive;
    const activeBayJustChanged = this.currentStateActive
      && previousActiveBayNumber !== undefined
      && this.activeBayNumber !== undefined
      && previousActiveBayNumber !== this.activeBayNumber;
    if (diffuserJustActivated || activeBayJustChanged) {
      this.lastDiffuserActivatedAt = Date.now();
    }
    if (previousDiffuserActive && !this.currentStateActive) {
      this.cancelPendingPowerOnIntensityLog();
    }
    void this.maybeForceNightlightOff();
  }

  private logInferredOfflineTransition() {
    const diffuserLabel = this.getDiffuserLogLabel();
    const inferredOffline = this.isLikelyOfflineFromStaleStatus();
    if (inferredOffline === this.inferredOfflineFromStaleState) {
      return;
    }
    this.inferredOfflineFromStaleState = inferredOffline;
    if (inferredOffline) {
      this.platform.log.warn(
        `${diffuserLabel} appears offline (cloud status may be stale; reported online without bay payload).`,
      );
    } else {
      this.platform.log.info(`${diffuserLabel} cloud status appears current again.`);
    }
  }

  private logRecommendationHints(device: PuraDevice) {
    const diffuserLabel = this.getDiffuserLogLabel();
    const awayModeEnabled = this.isAwayModeEnabled(device);
    if (awayModeEnabled !== this.lastAwayModeEnabledState) {
      const isInitialLog = this.lastAwayModeEnabledState === null;
      this.lastAwayModeEnabledState = awayModeEnabled;
      if (awayModeEnabled) {
        this.platform.log.warn(
          isInitialLog
            ? `Away mode is currently enabled on ${diffuserLabel}. ` +
              'For best results, please disable it in the Pura app.'
            : `Away mode was enabled on ${diffuserLabel}. ` +
              'For best results, please disable it in the Pura app.',
        );
      }
    }

    // With the auto-alternate switch exposed there is nothing to nag about: the setting is right
    // there in HomeKit rather than buried in the Pura app.
    if (this.isAutoAlternateControlEnabled() && this.supportsAutoAlternate()) {
      this.lastAutoAlternativeOffState = null;
      return;
    }

    const autoAlternativeLikelyOff = this.isAutoAlternativeLikelyOff(device);
    if (autoAlternativeLikelyOff !== this.lastAutoAlternativeOffState) {
      const isInitialLog = this.lastAutoAlternativeOffState === null;
      this.lastAutoAlternativeOffState = autoAlternativeLikelyOff;
      if (autoAlternativeLikelyOff) {
        this.platform.log.warn(
          isInitialLog
            ? `Auto-alternate fragrances is currently disabled on ${diffuserLabel}. ` +
              'For best results, please enable it in the Pura app.'
            : `Auto-alternate fragrances was disabled on ${diffuserLabel}. ` +
              'For best results, please re-enable it in the Pura app.',
        );
      }
    }
  }

  private isAwayModeEnabled(device: PuraDevice): boolean {
    const rawAwayMode = device.__raw?.awayMode;
    if (typeof rawAwayMode === 'boolean') {
      return rawAwayMode;
    }
    if (rawAwayMode && typeof rawAwayMode === 'object') {
      const record = rawAwayMode as Record<string, unknown>;
      if (typeof record.enabled === 'boolean') {
        return record.enabled;
      }
    }
    return Boolean(device.awayMode);
  }

  private isAutoAlternativeLikelyOff(device: PuraDevice): boolean {
    // Auto-alternate is currently supported on newer models only.
    const model = (device.type ?? '').toLowerCase();
    const supportsAutoAlternate = model.includes('pura 4') || model.includes('pura plus');
    if (!supportsAutoAlternate) {
      return false;
    }

    // Guard for malformed payloads on supported models.
    const appearsSingleBayModel = model.includes('mini') || model.includes('car');
    const hasSecondBay = Boolean(device.bay2 || (device.__raw as Record<string, unknown> | undefined)?.bay2);
    if (appearsSingleBayModel || !hasSecondBay) {
      return false;
    }
    const mode = (device.diffusionMode ?? '').toLowerCase();
    return mode === 'standard';
  }

  private normalizeOnlineState(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
      return value;
    }
    return undefined;
  }

  private getLastSeenAgeMs(): number | undefined {
    const raw = this.device.state?.lastSeen;
    if (!raw) {
      return undefined;
    }
    const trimmed = String(raw).trim();
    if (!trimmed) {
      return undefined;
    }
    const numeric = Number(trimmed);
    let timestampMs: number;
    if (Number.isFinite(numeric)) {
      timestampMs = numeric > 1e12 ? numeric : numeric * 1000;
    } else {
      const parsed = Date.parse(trimmed);
      if (!Number.isFinite(parsed)) {
        return undefined;
      }
      timestampMs = parsed;
    }
    return Date.now() - timestampMs;
  }

  private logOnlineStateTransition(previousOnline?: boolean, nextOnline?: boolean) {
    const diffuserLabel = this.getDiffuserLogLabel();
    if (previousOnline === undefined || nextOnline === undefined || previousOnline === nextOnline) {
      return;
    }
    if (nextOnline) {
      this.platform.log.info(`${diffuserLabel} is back online.`);
      return;
    }
    this.lastUnavailableCommandWarnAt = Date.now();
    this.platform.log.warn(`${diffuserLabel} appears offline (Wi-Fi lost or unplugged).`);
  }

  private logUnavailableCommandWarning() {
    const now = Date.now();
    const warnThrottleMs = 60000;
    if (now - this.lastUnavailableCommandWarnAt < warnThrottleMs) {
      return;
    }
    this.lastUnavailableCommandWarnAt = now;
    const diffuserLabel = this.getDiffuserLogLabel();
    this.platform.log.warn(`${diffuserLabel} appears offline (Wi-Fi lost or unplugged).`);
  }

  private logNoScentVialsWarning() {
    const now = Date.now();
    const warnThrottleMs = 5000;
    if (now - this.lastNoScentVialsWarnAt < warnThrottleMs) {
      return;
    }
    this.lastNoScentVialsWarnAt = now;
    const diffuserLabel = this.getDiffuserLogLabel();
    this.platform.log.warn(
      `${diffuserLabel} was turned on, but no scent vials were detected. ` +
      'The accessory was turned off as a result.',
    );
  }

  private updateAccessoryInformation() {
    const safeModel = this.device.type && this.device.type.length > 1 ? this.device.type : 'Pura Diffuser';
    const firmware = this.resolveFirmwareRevision();
    const hardware = this.resolveHardwareRevision();
    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    infoService.setCharacteristic(this.platform.Characteristic.Model, safeModel);
    const revisionChanged = this.applyRevisionCharacteristics(infoService, firmware.value, hardware.value);
    const contextChanged = this.persistRevisionContext(firmware.value, hardware.value);
    if (revisionChanged || contextChanged) {
      this.platform.persistAccessoryIfRegistered(this.accessory);
      if (this.platform.isDebugEnabled()) {
        this.platform.log.debug(
          `Persisted accessory metadata for ${this.accessory.displayName}: revisionChanged=${revisionChanged}, ` +
          `contextChanged=${contextChanged}`,
        );
      }
    }
    if (this.platform.isDebugEnabled()) {
      this.platform.log.debug(
        `Revision trace for ${this.accessory.displayName}: firmware=${firmware.value ?? 'none'} (${firmware.source}), ` +
        `hardware=${hardware.value ?? 'none'} (${hardware.source}), ` +
        `cachedFirmware=${this.accessory.context.firmwareRevision ?? 'none'}, ` +
        `cachedHardware=${this.accessory.context.hardwareRevision ?? 'none'}`,
      );
    }
  }

  private applyRevisionCharacteristics(infoService: Service, firmwareRevision?: string, hardwareRevision?: string): boolean {
    let changed = false;
    if (firmwareRevision) {
      const currentFirmware = this.normalizeFirmwareRevision(
        infoService.getCharacteristic(this.platform.Characteristic.FirmwareRevision).value,
      );
      const currentSoftware = this.normalizeFirmwareRevision(
        infoService.getCharacteristic(this.platform.Characteristic.SoftwareRevision).value,
      );
      changed = changed || currentFirmware !== firmwareRevision || currentSoftware !== firmwareRevision;
      // Keep revision fields in sync so cached accessories do not retain stale "0.0" values.
      infoService.setCharacteristic(this.platform.Characteristic.FirmwareRevision, firmwareRevision);
      infoService.updateCharacteristic(this.platform.Characteristic.FirmwareRevision, firmwareRevision);
      infoService.setCharacteristic(this.platform.Characteristic.SoftwareRevision, firmwareRevision);
      infoService.updateCharacteristic(this.platform.Characteristic.SoftwareRevision, firmwareRevision);
    }
    if (hardwareRevision) {
      const currentHardware = this.normalizeFirmwareRevision(
        infoService.getCharacteristic(this.platform.Characteristic.HardwareRevision).value,
      );
      changed = changed || currentHardware !== hardwareRevision;
      infoService.setCharacteristic(this.platform.Characteristic.HardwareRevision, hardwareRevision);
      infoService.updateCharacteristic(this.platform.Characteristic.HardwareRevision, hardwareRevision);
    }
    return changed;
  }

  private getFirmwareRevision(): string | undefined {
    return this.resolveFirmwareRevision().value;
  }

  private resolveFirmwareRevision(): { value?: string; source: 'state' | 'raw' | 'cache' | 'none' } {
    const current = this.normalizeFirmwareRevision(this.device.state?.firmwareVersion);
    if (current) {
      return { value: current, source: 'state' };
    }
    const raw = this.device.__raw as Record<string, unknown> | undefined;
    const fromRaw = this.normalizeFirmwareRevision(raw?.firmwareVersion ?? raw?.fwVersion);
    if (fromRaw) {
      return { value: fromRaw, source: 'raw' };
    }
    const cached = this.normalizeFirmwareRevision(this.accessory.context.firmwareRevision);
    if (cached) {
      return { value: cached, source: 'cache' };
    }
    return { source: 'none' };
  }

  private getHardwareRevision(): string | undefined {
    return this.resolveHardwareRevision().value;
  }

  private resolveHardwareRevision(): { value?: string; source: 'raw' | 'cache' | 'none' } {
    const raw = this.device.__raw as Record<string, unknown> | undefined;
    const current = this.normalizeFirmwareRevision(raw?.hwVersion);
    if (current) {
      return { value: current, source: 'raw' };
    }
    const cached = this.normalizeFirmwareRevision(this.accessory.context.hardwareRevision);
    if (cached) {
      return { value: cached, source: 'cache' };
    }
    return { source: 'none' };
  }

  private persistRevisionContext(firmwareRevision?: string, hardwareRevision?: string): boolean {
    let changed = false;
    if (firmwareRevision && this.accessory.context.firmwareRevision !== firmwareRevision) {
      this.accessory.context.firmwareRevision = firmwareRevision;
      changed = true;
    }
    if (hardwareRevision && this.accessory.context.hardwareRevision !== hardwareRevision) {
      this.accessory.context.hardwareRevision = hardwareRevision;
      changed = true;
    }
    if (changed && this.platform.isDebugEnabled()) {
      this.platform.log.debug(
        `Persisted revision context for ${this.accessory.displayName}: ` +
        `firmware=${this.accessory.context.firmwareRevision ?? 'none'}, ` +
        `hardware=${this.accessory.context.hardwareRevision ?? 'none'}`,
      );
    }
    return changed;
  }

  private normalizeFirmwareRevision(value: unknown): string | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return undefined;
    }
    const normalized = String(value).trim();
    if (!normalized) {
      return undefined;
    }
    const lowered = normalized.toLowerCase();
    if (this.isZeroVersion(lowered)) {
      return undefined;
    }
    if (lowered === 'unknown' || lowered === 'null' || lowered === 'undefined' || lowered === 'n/a') {
      return undefined;
    }
    const withoutVPrefix = normalized.replace(/^[vV]/, '');
    if (!/^\d+(?:\.\d+){0,3}$/.test(withoutVPrefix)) {
      return undefined;
    }
    if (this.isZeroVersion(withoutVPrefix)) {
      return undefined;
    }
    if (/^\d+$/.test(withoutVPrefix)) {
      return `${withoutVPrefix}.0.0`;
    }
    if (/^\d+\.\d+$/.test(withoutVPrefix)) {
      return `${withoutVPrefix}.0`;
    }
    return withoutVPrefix;
  }

  private isZeroVersion(value: string): boolean {
    if (value === '0') {
      return true;
    }
    return /^0(?:\.0+)+$/.test(value);
  }

  private summarizeDevice(device: PuraDevice) {
    const raw = device.__raw ?? {};
    const rawRecord = raw as Record<string, unknown>;
    const modelFields = {
      type: rawRecord.type,
      model: rawRecord.model,
      deviceVer: rawRecord.deviceVer,
      version: rawRecord.version,
      hwVersion: rawRecord.hwVersion,
      deviceName: rawRecord.deviceName,
      displayName: rawRecord.displayName,
      firmwareVersion: rawRecord.firmwareVersion ?? rawRecord.fwVersion,
    };
    const baySummary = (bay?: PuraBay) => {
      if (!bay) {
        return null;
      }
      return {
        id: bay.id,
        active: bay.active,
        intensity: bay.intensity,
        exactIntensity: bay.exactIntensity,
        activeAt: bay.activeAt,
        timerActive: bay.timer?.active,
        fragrance: bay.fragrance?.name,
        remainingPercent: bay.remainingPercent,
        lowFragrance: bay.lowFragrance,
      };
    };
    return {
      id: device.id,
      name: device.name,
      online: device.online,
      awayMode: device.awayMode,
      ambientMode: device.ambientMode,
      diffusionMode: device.diffusionMode,
      nightlight: {
        active: device.nightlight?.active,
        brightnessRaw: device.nightlight?.brightness,
        brightnessPercent: this.nightlightLevelToPercent(device.nightlight?.brightness),
        color: device.nightlight?.color,
      },
      modelFields,
      bay1: baySummary(device.bay1),
      bay2: baySummary(device.bay2),
    };
  }

  private async maybeForceNightlightOff() {
    const forceOff = (this.platform.config as PuraConfig).forceNightlightOff;
    if (!forceOff) {
      return;
    }
    if (!this.supportsNightlightControl()) {
      return;
    }
    if (!this.currentStateActive || !this.device.nightlight?.active) {
      return;
    }
    const activatedAt = this.lastDiffuserActivatedAt;
    if (activatedAt === undefined) {
      return;
    }
    const now = Date.now();
    const sinceActivationMs = now - activatedAt;
    const activationWindowMs = 15000;
    if (sinceActivationMs < 0 || sinceActivationMs > activationWindowMs) {
      return;
    }
    if (this.lastNightlightOffAt >= activatedAt) {
      return;
    }
    const forcedOff = await this.ensureNightlightOff();
    if (forcedOff) {
      this.lastNightlightOffAt = Date.now();
    }
  }

  private getCurrentStateValue(): CharacteristicValue {
    if (this.useFanService) {
      return this.currentStateActive
        ? this.platform.Characteristic.Active.ACTIVE
        : this.platform.Characteristic.Active.INACTIVE;
    }
    return this.currentStateActive;
  }

  private isHomeKitShowingActive(): boolean {
    const activeCharacteristic = this.useFanService
      ? this.platform.Characteristic.Active
      : this.platform.Characteristic.On;
    const currentValue = this.service.getCharacteristic(activeCharacteristic).value;
    if (this.useFanService) {
      return currentValue === this.platform.Characteristic.Active.ACTIVE
        || currentValue === 1
        || currentValue === true;
    }
    return Boolean(currentValue);
  }

  private shouldAllowRotationWriteWhileInactive(onCommandAgeMs?: number): boolean {
    if (this.currentStateActive) {
      return true;
    }
    if (this.isHomeKitShowingActive()) {
      return true;
    }
    if (this.getPendingPowerOnIntensityIntentValue() !== undefined) {
      return true;
    }
    if (this.getPendingIntensityIntentValue() !== undefined) {
      return true;
    }
    return onCommandAgeMs !== undefined && onCommandAgeMs >= 0 && onCommandAgeMs <= 15000;
  }

  private shouldSuppressConflictingOffCommand(origin: 'setOn' | 'rotation'): boolean {
    const diffuserLabel = this.getDiffuserLogLabel();
    if (!this.currentStateActive) {
      return false;
    }
    const recentNightlightInteraction = this.platform.getRecentNightlightInteraction(this.device.id);
    if (this.lastSuccessfulOnWriteAt === undefined) {
      return false;
    }
    const now = Date.now();
    const sinceLastOnMs = now - this.lastSuccessfulOnWriteAt;
    // Guard against controller bounce where a stale OFF arrives immediately after a successful ON.
    if (sinceLastOnMs < 0 || sinceLastOnMs > 5000) {
      return false;
    }
    const pendingIntensity = this.getPendingIntensityIntentValue();
    const pendingPowerOnIntensity = this.getPendingPowerOnIntensityIntentValue();
    if (pendingIntensity === undefined && pendingPowerOnIntensity === undefined) {
      return false;
    }
    if (this.platform.isDebugEnabled()) {
      this.platform.log.debug(
        `[Diffuser] Suppressing conflicting OFF command for ${diffuserLabel} ` +
        `(origin=${origin}, sinceLastOnMs=${sinceLastOnMs}, pendingIntensity=${pendingIntensity ?? 'none'}, ` +
        `recentNightlightAgeMs=${recentNightlightInteraction?.ageMs ?? 'none'}).`,
      );
    }
    return true;
  }

  private applyCurrentState() {
    const value = this.getCurrentStateValue();
    const activeCharacteristic = this.useFanService
      ? this.platform.Characteristic.Active
      : this.platform.Characteristic.On;
    this.service.updateCharacteristic(activeCharacteristic, value);
    if (this.useFanService && this.service.testCharacteristic(this.platform.Characteristic.RotationSpeed)) {
      let speed = 0;
      if (this.currentStateActive) {
        const intensity = this.getCurrentIntensityValue();
        if (typeof intensity === 'number') {
          speed = this.mapIntensityToRotation(intensity);
        } else {
          const currentValue = this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed).value;
          const numericCurrentValue = Number(currentValue);
          speed = Number.isFinite(numericCurrentValue) ? numericCurrentValue : 0;
        }
      }
      this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, speed);
    }
  }

  private applyNightlightState() {
    if (!this.nightlightService) {
      return;
    }
    const isOn = Boolean(this.device.nightlight?.active);
    const brightness = isOn
      ? this.nightlightLevelToPercent(this.device.nightlight?.brightness)
      : 0;
    const color = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
    const hsv = this.hexToHsv(color);
    this.nightlightService.updateCharacteristic(this.platform.Characteristic.On, isOn);
    this.nightlightService.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
    this.nightlightService.updateCharacteristic(this.platform.Characteristic.Hue, hsv.h);
    this.nightlightService.updateCharacteristic(this.platform.Characteristic.Saturation, hsv.s);
  }

  private normalizeNightlightLevel(level: unknown): number | undefined {
    const numeric = Number(level);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return undefined;
    }
    if (numeric <= 10) {
      return Math.max(1, Math.min(10, Math.round(numeric)));
    }
    return Math.max(1, Math.min(10, Math.round((numeric / 100) * 10)));
  }

  private nightlightLevelToPercent(level: unknown): number {
    const normalized = this.normalizeNightlightLevel(level);
    if (normalized === undefined) {
      return 100;
    }
    return Math.max(1, Math.min(100, Math.round((normalized / 10) * 100)));
  }

  private percentToNightlightLevel(percent: number): number {
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    return Math.max(1, Math.min(10, Math.round((clamped / 100) * 10)));
  }

  private recordNightlightCommand(
    action: 'brightness' | 'on',
    requestedOn: boolean,
    hkBrightnessPercent: number,
    sentLevel: number,
  ) {
    const previousCommand = this.lastNightlightCommand;
    this.lastNightlightCommand = {
      at: Date.now(),
      action,
      requestedOn,
      hkBrightnessPercent,
      sentLevel,
    };
    if (action === 'on') {
      return;
    }
    if (!requestedOn || Math.round(hkBrightnessPercent) <= 0) {
      // For OFF transitions, emit the OFF log only (avoid duplicate "brightness set to 0%").
      return;
    }
    const suppressBrightnessLogAfterOnMs = 3000;
    const previousWasRecentOn = previousCommand
      && previousCommand.action === 'on'
      && previousCommand.requestedOn
      && (Date.now() - previousCommand.at) <= suppressBrightnessLogAfterOnMs;
    if (previousWasRecentOn) {
      return;
    }
    const nightlightLabel = this.getNightlightLogLabel();
    this.platform.log.info(`${nightlightLabel} brightness set to ${Math.round(hkBrightnessPercent)}%.`);
  }

  private getDiffuserLogLabel(): string {
    const name = this.accessory.displayName.trim();
    if (/diffuser/i.test(name)) {
      return name;
    }
    if (/nightlight/i.test(name)) {
      return name.replace(/nightlight/i, 'Diffuser Nightlight');
    }
    return `${name} Diffuser`;
  }

  private getNightlightLogLabel(): string {
    const name = this.accessory.displayName.trim();
    const hasNightlight = /nightlight/i.test(name);
    const hasDiffuser = /diffuser/i.test(name);
    if (hasNightlight && hasDiffuser) {
      return name;
    }
    if (hasNightlight) {
      return name.replace(/nightlight/i, 'Diffuser Nightlight');
    }
    if (hasDiffuser) {
      return `${name} Nightlight`;
    }
    return `${name} Diffuser Nightlight`;
  }

  private getNightlightOffLogMessage(label: string): string {
    if (this.platform.consumeRecentNightlightAutoOff(this.device.id)) {
      return `${label} automatically turned off (auto-off enabled).`;
    }
    return `${label} turned off.`;
  }

  private logNightlightToggle(active: boolean, brightnessPercent: number) {
    // Avoid double-logging when a dedicated nightlight accessory handles logs.
    if (this.hasSeparateNightlightAccessoryConfigured() && this.supportsNightlightControl()) {
      return;
    }
    const now = Date.now();
    const roundedPercent = Math.round(brightnessPercent);

    if (!active) {
      this.pendingNightlightOnLog = undefined;
      if (this.pendingNightlightOnLogTimer) {
        clearTimeout(this.pendingNightlightOnLogTimer);
        this.pendingNightlightOnLogTimer = undefined;
      }
      this.emitNightlightToggleLog(false, 0, now);
      return;
    }

    // active=true: coalesce intermediate brightness values into a single "turned on" message.
    if (this.pendingNightlightOnLog) {
      this.pendingNightlightOnLog.at = now;
      this.pendingNightlightOnLog.brightnessPercent = roundedPercent;
    } else {
      this.pendingNightlightOnLog = { at: now, brightnessPercent: roundedPercent };
    }

    if (roundedPercent >= 100) {
      const pending = this.pendingNightlightOnLog;
      this.pendingNightlightOnLog = undefined;
      if (this.pendingNightlightOnLogTimer) {
        clearTimeout(this.pendingNightlightOnLogTimer);
        this.pendingNightlightOnLogTimer = undefined;
      }
      if (pending) {
        this.emitNightlightToggleLog(true, pending.brightnessPercent, now);
      }
      return;
    }

    // Debounce so rapid HomeKit bursts log the final brightness value.
    const debounceMs = 1200;
    if (this.pendingNightlightOnLogTimer) {
      clearTimeout(this.pendingNightlightOnLogTimer);
      this.pendingNightlightOnLogTimer = undefined;
    }
    this.pendingNightlightOnLogTimer = setTimeout(() => {
      const pending = this.pendingNightlightOnLog;
      this.pendingNightlightOnLog = undefined;
      this.pendingNightlightOnLogTimer = undefined;
      if (pending) {
        this.emitNightlightToggleLog(true, pending.brightnessPercent, Date.now());
      }
    }, debounceMs);
  }

  private emitNightlightToggleLog(active: boolean, brightnessPercent: number, now = Date.now()) {
    const roundedPercent = Math.round(brightnessPercent);
    const last = this.lastNightlightLog;
    if (last && last.active === active && Math.round(last.level) === roundedPercent) {
      const age = now - last.at;
      if (age < 1500) {
        return;
      }
    }
    this.lastNightlightLog = { at: now, active, level: roundedPercent };

    const label = this.getNightlightLogLabel();
    if (active) {
      this.platform.log.info(`${label} turned on.`);
    } else {
      this.platform.log.info(this.getNightlightOffLogMessage(label));
    }
  }

  private emitNightlightColorChangedLog() {
    const now = Date.now();
    if (now - this.lastNightlightColorLogAt < 1200) {
      return;
    }
    this.lastNightlightColorLogAt = now;
    const label = this.getNightlightLogLabel();
    this.platform.log.info(`${label} color was changed.`);
  }

  private async applyNightlightColor(
    color: string,
    action: 'hue' | 'saturation',
    hue: number,
    saturation: number,
  ) {
    const normalizedColor = this.normalizeNightlightColor(color);
    const apiLevel = this.normalizeNightlightLevel(this.device.nightlight?.brightness) ?? 10;
    const brightnessPercent = this.nightlightLevelToPercent(apiLevel);
    const active = this.pendingNightlightActive ?? Boolean(this.device.nightlight?.active);
    const controller = this.device.controller || 'default';

    this.platform.log.debug(
      `[Nightlight] Set ${action} for ${this.accessory.displayName} -> ` +
      `h=${Math.round(hue)} s=${Math.round(saturation)} color=${normalizedColor} ` +
      `(active=${active}, level=${apiLevel})`,
    );

    const success = await this.puraApi.setNightlight(
      this.device.id,
      active,
      brightnessPercent,
      normalizedColor,
      controller,
    );
    if (!success) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    this.device.nightlight = {
      active,
      brightness: apiLevel,
      color: normalizedColor,
    };
    this.lastNightlightApiWrite = {
      at: Date.now(),
      active,
      level: apiLevel,
      color: normalizedColor,
      reason: action,
    };
    this.pendingNightlightIntent = {
      at: Date.now(),
      ttlMs: active ? 20000 : 15000,
      active,
      level: apiLevel,
      color: normalizedColor,
    };
    this.emitNightlightColorChangedLog();
    this.applyNightlightState();
  }

  private async enqueueNightlightWrite(task: () => Promise<void>): Promise<void> {
    const run = this.nightlightWriteQueue.then(task, task);
    this.nightlightWriteQueue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private async enqueueRotationWrite(task: () => Promise<void>): Promise<void> {
    const run = this.rotationWriteQueue.then(task, task);
    this.rotationWriteQueue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private stabilizeNightlightDuringIntentWindow(device: PuraDevice): PuraDevice {
    if (!this.pendingNightlightIntent && device.nightlight) {
      const forceNightlightOff = Boolean((this.platform.config as PuraConfig).forceNightlightOff);
      const recentNightlightInteraction = this.platform.getRecentNightlightInteraction(this.device.id);
      const previousNightlightActive = Boolean(this.device.nightlight?.active);
      const incomingNightlightActive = Boolean(device.nightlight.active);
      const sinceDiffuserOnMs = this.lastSuccessfulOnWriteAt !== undefined
        ? Date.now() - this.lastSuccessfulOnWriteAt
        : undefined;
      const inDiffuserOnStabilizationWindow = sinceDiffuserOnMs !== undefined
        && sinceDiffuserOnMs >= 0
        && sinceDiffuserOnMs <= 1000;
      // Some devices briefly report nightlight=on when a diffuser starts even when no HomeKit
      // nightlight command was sent. Hold the prior OFF state during the startup window.
      if (!forceNightlightOff
        && !this.hasSeparateNightlightAccessoryConfigured()
        && inDiffuserOnStabilizationWindow
        && !recentNightlightInteraction
        && !previousNightlightActive
        && incomingNightlightActive) {
        if (this.platform.isDebugEnabled()) {
          this.platform.log.debug(
            `[Nightlight] Suppressing transient ON snapshot for ${this.accessory.displayName} ` +
            `(sinceDiffuserOnMs=${sinceDiffuserOnMs}).`,
          );
        }
        return {
          ...device,
          nightlight: {
            ...device.nightlight,
            active: false,
          },
        };
      }
    }

    if (!this.pendingNightlightIntent) {
      return device;
    }
    const ageMs = Date.now() - this.pendingNightlightIntent.at;
    if (ageMs > this.pendingNightlightIntent.ttlMs) {
      this.pendingNightlightIntent = undefined;
      return device;
    }
    if (!device.nightlight) {
      return device;
    }
    const intent = this.pendingNightlightIntent;
    const recentNightlightInteraction = this.platform.getRecentNightlightInteraction(this.device.id);
    const passiveIntentMaxAgeMs = intent.active ? 9000 : 3500;
    if (!recentNightlightInteraction && ageMs > passiveIntentMaxAgeMs) {
      this.pendingNightlightIntent = undefined;
      return device;
    }

    const incomingLevel = this.normalizeNightlightLevel(device.nightlight.brightness);
    const incomingActive = Boolean(device.nightlight.active);
    const incomingColor = this.normalizeNightlightColor(device.nightlight.color);
    const matchesIntent = incomingActive === intent.active
      && incomingLevel === intent.level
      && incomingColor === intent.color;
    if (matchesIntent) {
      return device;
    }

    if (this.platform.isDebugEnabled()) {
      this.platform.log.debug(
        `[Nightlight] Ignoring stale cloud snapshot for ${this.accessory.displayName}: ` +
        `incoming(active=${incomingActive}, level=${incomingLevel ?? 'unknown'}) ` +
        `expected(active=${intent.active}, level=${intent.level}, color=${intent.color}) ageMs=${ageMs}`,
      );
    }

    return {
      ...device,
      nightlight: {
        ...device.nightlight,
        active: intent.active,
        brightness: intent.level,
        color: intent.color,
      },
    };
  }

  private clampNightlightDuringHold(device: PuraDevice): PuraDevice {
    if (!this.recentNightlightHold) {
      return device;
    }
    const now = Date.now();
    if (now > this.recentNightlightHold.until) {
      this.recentNightlightHold = undefined;
      return device;
    }
    if (!device.nightlight || device.nightlight.active !== true) {
      return device;
    }
    const incomingLevel = this.normalizeNightlightLevel(device.nightlight.brightness) ?? 1;
    if (incomingLevel >= this.recentNightlightHold.level) {
      return device;
    }
    if (this.platform.isDebugEnabled()) {
      this.platform.log.debug(
        `[Nightlight] Clamping brightness for ${this.accessory.displayName} during hold: ` +
        `incoming=${incomingLevel} intentHold=${this.recentNightlightHold.level}`,
      );
    }
    return {
      ...device,
      nightlight: {
        ...device.nightlight,
        brightness: this.recentNightlightHold.level,
      },
    };
  }

  private getPendingIntensityIntentValue(): number | undefined {
    if (!this.pendingIntensityIntent) {
      return undefined;
    }
    const ageMs = Date.now() - this.pendingIntensityIntent.at;
    if (ageMs > this.pendingIntensityIntent.ttlMs) {
      this.pendingIntensityIntent = undefined;
      return undefined;
    }
    return this.pendingIntensityIntent.intensity;
  }

  private getPendingPowerOnIntensityIntentValue(): number | undefined {
    if (!this.pendingPowerOnIntensityIntent) {
      return undefined;
    }
    const ageMs = Date.now() - this.pendingPowerOnIntensityIntent.at;
    if (ageMs > this.pendingPowerOnIntensityIntent.ttlMs) {
      this.pendingPowerOnIntensityIntent = undefined;
      return undefined;
    }
    return this.pendingPowerOnIntensityIntent.intensity;
  }

  private describeIntensityLevel(intensity: number): 'subtle' | 'medium' | 'strong' {
    if (intensity <= 30) {
      return 'subtle';
    }
    if (intensity <= 50) {
      return 'medium';
    }
    return 'strong';
  }

  private queuePendingPowerOnIntensityLog(intensity: number) {
    const normalizedIntensity = Math.max(1, Math.min(100, Math.round(Number(intensity) || 0)));
    this.pendingPowerOnIntensityLog = {
      at: Date.now(),
      intensity: normalizedIntensity,
    };
    if (this.pendingPowerOnIntensityLogTimer) {
      clearTimeout(this.pendingPowerOnIntensityLogTimer);
      this.pendingPowerOnIntensityLogTimer = undefined;
    }
    const debounceMs = 3500;
    this.pendingPowerOnIntensityLogTimer = setTimeout(() => {
      const pending = this.pendingPowerOnIntensityLog;
      this.pendingPowerOnIntensityLog = undefined;
      if (this.pendingPowerOnIntensityLogTimer) {
        clearTimeout(this.pendingPowerOnIntensityLogTimer);
        this.pendingPowerOnIntensityLogTimer = undefined;
      }
      if (!pending) {
        return;
      }
      const diffuserLabel = this.getDiffuserLogLabel();
      this.platform.log.info(
        `${diffuserLabel} intensity set to ${pending.intensity} ` +
        `(${this.describeIntensityLevel(pending.intensity)}).`,
      );
    }, debounceMs);
  }

  private cancelPendingPowerOnIntensityLog() {
    this.pendingPowerOnIntensityLog = undefined;
    if (this.pendingPowerOnIntensityLogTimer) {
      clearTimeout(this.pendingPowerOnIntensityLogTimer);
      this.pendingPowerOnIntensityLogTimer = undefined;
    }
  }

  private stabilizeIntensityDuringIntentWindow(device: PuraDevice): PuraDevice {
    const intentIntensity = this.getPendingIntensityIntentValue();
    if (intentIntensity === undefined || !this.pendingIntensityIntent) {
      return this.clampIntensityDuringHold(device);
    }
    if (!device.bay1 && !device.bay2) {
      return this.clampIntensityDuringHold(device);
    }

    const intentBay = this.pendingIntensityIntent.bay;
    const ageMs = Date.now() - this.pendingIntensityIntent.at;
    const incomingBay = intentBay === 1
      ? device.bay1
      : intentBay === 2
        ? device.bay2
        : this.getActiveBayFromDevice(device);
    const incomingIntensity = incomingBay?.intensity;
    const incomingMatchesIntentIntensity = Number.isFinite(incomingIntensity) && Number(incomingIntensity) === intentIntensity;
    if (intentBay === 1 || intentBay === 2) {
      const targetBay = intentBay === 1 ? device.bay1 : device.bay2;
      const otherBay = intentBay === 1 ? device.bay2 : device.bay1;
      const targetActive = Boolean(targetBay?.active);
      const otherActive = Boolean(otherBay?.active);
      if (incomingMatchesIntentIntensity && targetActive && !otherActive) {
        return device;
      }
    } else if (incomingMatchesIntentIntensity) {
      return device;
    }

    const presentBays = [device.bay1, device.bay2].filter((bay): bay is PuraBay => Boolean(bay));
    const incomingHasAnyActiveBay = presentBays.some((bay) => Boolean(bay.active));
    const incomingHasAnyPositiveIntensity = presentBays.some(
      (bay) => Number.isFinite(bay.intensity) && Number(bay.intensity) > 0,
    );
    const incomingLooksFullyOff = presentBays.length > 0 && !incomingHasAnyActiveBay && !incomingHasAnyPositiveIntensity;
    const acceptExternalOffAfterMs = 5000;
    if (incomingLooksFullyOff && ageMs >= acceptExternalOffAfterMs) {
      if (this.platform.isDebugEnabled()) {
        this.platform.log.debug(
          `[Diffuser] Accepting external OFF snapshot for ${this.getDiffuserLogLabel()}; ` +
          `clearing pending intensity intent (ageMs=${ageMs}).`,
        );
      }
      this.pendingIntensityIntent = undefined;
      this.pendingPowerOnIntensityIntent = undefined;
      return this.clampIntensityDuringHold(device);
    }

    if (this.platform.isDebugEnabled()) {
      this.platform.log.debug(
        `[Diffuser] Ignoring stale intensity snapshot for ${this.getDiffuserLogLabel()}: ` +
        `incoming=${incomingIntensity ?? 'unknown'} expected=${intentIntensity} ` +
        `bay=${intentBay ?? 'auto'} ageMs=${ageMs}`,
      );
    }

    if (intentBay === 1 && device.bay1) {
      return this.clampIntensityDuringHold({
        ...device,
        bay1: { ...device.bay1, intensity: intentIntensity, active: true },
        bay2: device.bay2 ? { ...device.bay2, active: false } : device.bay2,
      });
    }
    if (intentBay === 2 && device.bay2) {
      return this.clampIntensityDuringHold({
        ...device,
        bay1: device.bay1 ? { ...device.bay1, active: false } : device.bay1,
        bay2: { ...device.bay2, intensity: intentIntensity, active: true },
      });
    }
    if (device.bay1) {
      return this.clampIntensityDuringHold({ ...device, bay1: { ...device.bay1, intensity: intentIntensity } });
    }
    if (device.bay2) {
      return this.clampIntensityDuringHold({ ...device, bay2: { ...device.bay2, intensity: intentIntensity } });
    }
    return this.clampIntensityDuringHold(device);
  }

  private getActiveBayFromDevice(device: PuraDevice): PuraBay | undefined {
    const bay1 = this.fillBayIntensityFromCache(device.bay1);
    const bay2 = this.fillBayIntensityFromCache(device.bay2);
    if (bay1?.active && !bay2?.active) {
      return bay1;
    }
    if (bay2?.active && !bay1?.active) {
      return bay2;
    }
    if (bay1?.active && bay2?.active) {
      const bay1ActiveAt = bay1.activeAt ?? 0;
      const bay2ActiveAt = bay2.activeAt ?? 0;
      if (bay1ActiveAt !== bay2ActiveAt) {
        return bay1ActiveAt > bay2ActiveAt ? bay1 : bay2;
      }
      return bay1.intensity >= bay2.intensity ? bay1 : bay2;
    }
    const bay1HasIntensity = Number.isFinite(bay1?.intensity) && Number(bay1?.intensity) > 0;
    const bay2HasIntensity = Number.isFinite(bay2?.intensity) && Number(bay2?.intensity) > 0;
    if (bay1HasIntensity && !bay2HasIntensity) {
      return bay1;
    }
    if (bay2HasIntensity && !bay1HasIntensity) {
      return bay2;
    }
    if (bay1HasIntensity && bay2HasIntensity) {
      const bay1ActiveAt = bay1?.activeAt ?? 0;
      const bay2ActiveAt = bay2?.activeAt ?? 0;
      if (bay1ActiveAt !== bay2ActiveAt) {
        return bay1ActiveAt > bay2ActiveAt ? bay1 : bay2;
      }
      return (bay1?.intensity ?? 0) >= (bay2?.intensity ?? 0) ? bay1 : bay2;
    }
    const inferred = this.getActiveBayFromActiveAt(bay1, bay2);
    if (inferred) {
      return inferred;
    }
    return undefined;
  }

  private getActiveBayFromActiveAt(bay1?: PuraBay, bay2?: PuraBay): PuraBay | undefined {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowSec = 6 * 60 * 60; // treat as active if activeAt is within the last 6 hours
    const chooseIntensity = (): number => {
      const cached = Number(this.accessory.context.lastIntensity);
      if (Number.isFinite(cached) && cached > 0) {
        return cached;
      }
      return 30;
    };

    const bay1Recent = bay1?.activeAt && Math.abs(nowSec - bay1.activeAt) < windowSec;
    const bay2Recent = bay2?.activeAt && Math.abs(nowSec - bay2.activeAt) < windowSec;

    if (bay1Recent && !bay2Recent) {
      return { ...bay1, active: true, intensity: bay1?.intensity && bay1.intensity > 0 ? bay1.intensity : chooseIntensity() };
    }
    if (bay2Recent && !bay1Recent) {
      return { ...bay2, active: true, intensity: bay2?.intensity && bay2.intensity > 0 ? bay2.intensity : chooseIntensity() };
    }
    if (bay1Recent && bay2Recent) {
      const bay1ActiveAt = bay1?.activeAt ?? 0;
      const bay2ActiveAt = bay2?.activeAt ?? 0;
      if (bay1ActiveAt !== bay2ActiveAt) {
        return bay1ActiveAt > bay2ActiveAt
          ? { ...bay1, active: true, intensity: bay1?.intensity && bay1.intensity > 0 ? bay1.intensity : chooseIntensity() }
          : { ...bay2, active: true, intensity: bay2?.intensity && bay2.intensity > 0 ? bay2.intensity : chooseIntensity() };
      }
      // If timestamps equal, prefer higher intensity (or fallback).
      const bay1Intensity = bay1?.intensity && bay1.intensity > 0 ? bay1.intensity : chooseIntensity();
      const bay2Intensity = bay2?.intensity && bay2.intensity > 0 ? bay2.intensity : chooseIntensity();
      return bay1Intensity >= bay2Intensity
        ? { ...bay1, active: true, intensity: bay1Intensity }
        : { ...bay2, active: true, intensity: bay2Intensity };
    }

    return undefined;
  }

  private fillBayIntensityFromCache(bay?: PuraBay): PuraBay | undefined {
    if (!bay) {
      return bay;
    }
    if (bay.active && (!Number.isFinite(bay.intensity) || bay.intensity <= 0)) {
      const cached = Number(this.accessory.context.lastIntensity);
      const fallback = Number.isFinite(cached) && cached > 0 ? cached : 30;
      return { ...bay, intensity: fallback };
    }
    return bay;
  }

  private clampIntensityDuringHold(device: PuraDevice): PuraDevice {
    if (!this.recentIntensityHold) {
      return this.clampRecentOnDrop(device);
    }
    const now = Date.now();
    if (now > this.recentIntensityHold.until) {
      this.recentIntensityHold = undefined;
      return this.clampRecentOnDrop(device);
    }
    const hold = this.recentIntensityHold.level;
    const clampBay = (bay?: PuraBay) => {
      if (!bay || !bay.active) {
        return bay;
      }
      if (!Number.isFinite(bay.intensity) || bay.intensity < hold) {
        return { ...bay, intensity: hold };
      }
      return bay;
    };
    return this.clampRecentOnDrop({
      ...device,
      bay1: clampBay(device.bay1),
      bay2: clampBay(device.bay2),
    });
  }

  private clampRecentOnDrop(device: PuraDevice): PuraDevice {
    if (!this.lastRequestedOnIntensity || this.lastRequestedOnIntensity <= 0) {
      return device;
    }
    const recentIntentAt = Math.max(
      this.lastSetOnCommandAt ?? 0,
      this.lastRotationWriteAt ?? 0,
    );
    if (recentIntentAt === 0) {
      return device;
    }
    const ageMs = Date.now() - recentIntentAt;
    if (ageMs > 20000) {
      return device;
    }
    const minLevel = this.lastRequestedOnIntensity;
    const clampBay = (bay?: PuraBay) => {
      if (!bay || !bay.active) {
        return bay;
      }
      if (!Number.isFinite(bay.intensity) || bay.intensity < minLevel) {
        return { ...bay, intensity: minLevel };
      }
      return bay;
    };
    return {
      ...device,
      bay1: clampBay(device.bay1),
      bay2: clampBay(device.bay2),
    };
  }

  private normalizeNightlightColor(color: unknown): string {
    if (typeof color !== 'string') {
      return 'ffffff';
    }
    const normalized = color.replace('#', '').trim().toLowerCase();
    if (/^[0-9a-f]{6}$/.test(normalized)) {
      return normalized;
    }
    return 'ffffff';
  }

  private shouldSkipRedundantNightlightOnWrite(active: boolean): boolean {
    if (!this.lastNightlightApiWrite) {
      return false;
    }
    const ageMs = Date.now() - this.lastNightlightApiWrite.at;
    if (ageMs > 2000) {
      return false;
    }
    if (this.lastNightlightApiWrite.active !== active) {
      return false;
    }
    // On writes are often emitted after Brightness/Color writes; skip if the device was just set to that state.
    return this.lastNightlightApiWrite.reason !== 'on';
  }

  private hexToHsv(hex: string): { h: number; s: number } {
    const normalized = this.normalizeNightlightColor(hex);
    const r = parseInt(normalized.slice(0, 2), 16) / 255;
    const g = parseInt(normalized.slice(2, 4), 16) / 255;
    const b = parseInt(normalized.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h = 0;
    if (delta !== 0) {
      if (max === r) {
        h = 60 * (((g - b) / delta) % 6);
      } else if (max === g) {
        h = 60 * (((b - r) / delta) + 2);
      } else {
        h = 60 * (((r - g) / delta) + 4);
      }
    }
    if (h < 0) {
      h += 360;
    }
    const s = max === 0 ? 0 : (delta / max) * 100;
    return {
      h: Math.round(h),
      s: Math.round(s),
    };
  }

  private hsvToHex(h: number, s: number): string {
    const hue = ((Number(h) % 360) + 360) % 360;
    const sat = Math.max(0, Math.min(100, Number(s) || 0)) / 100;
    const c = sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = 1 - c;

    let rPrime = 0;
    let gPrime = 0;
    let bPrime = 0;
    if (hue < 60) {
      rPrime = c;
      gPrime = x;
    } else if (hue < 120) {
      rPrime = x;
      gPrime = c;
    } else if (hue < 180) {
      gPrime = c;
      bPrime = x;
    } else if (hue < 240) {
      gPrime = x;
      bPrime = c;
    } else if (hue < 300) {
      rPrime = x;
      bPrime = c;
    } else {
      rPrime = c;
      bPrime = x;
    }

    const r = Math.round((rPrime + m) * 255);
    const g = Math.round((gPrime + m) * 255);
    const b = Math.round((bPrime + m) * 255);
    return [r, g, b]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
  }

  private logNightlightProfileRoundTrip(previous?: PuraDevice['nightlight'], next?: PuraDevice['nightlight']) {
    if (!this.platform.isDebugEnabled()) {
      return;
    }
    if (!this.lastNightlightCommand) {
      return;
    }
    const ageMs = Date.now() - this.lastNightlightCommand.at;
    if (ageMs > 20000) {
      this.lastNightlightCommand = undefined;
      return;
    }

    const previousRaw = this.normalizeNightlightLevel(previous?.brightness);
    const nextRaw = this.normalizeNightlightLevel(next?.brightness);
    const previousPercent = this.nightlightLevelToPercent(previousRaw);
    const nextPercent = this.nightlightLevelToPercent(nextRaw);
    const brightnessChanged = previousRaw !== nextRaw || previousPercent !== nextPercent;
    const activeChanged = Boolean(previous?.active) !== Boolean(next?.active);
    if (!brightnessChanged && !activeChanged) {
      return;
    }

    const cmd = this.lastNightlightCommand;
    this.platform.log.debug(
      `[Nightlight Profile] ${this.accessory.displayName} action=${cmd.action} ` +
      `hk=${Math.round(cmd.hkBrightnessPercent)}% sentLevel=${cmd.sentLevel} sentOn=${cmd.requestedOn} ` +
      `-> cloudRaw=${nextRaw ?? 'unknown'} cloudPercent=${nextPercent}% cloudOn=${Boolean(next?.active)} ` +
      `(prevRaw=${previousRaw ?? 'unknown'} prevPercent=${previousPercent}% ageMs=${ageMs})`,
    );
    this.lastNightlightCommand = undefined;
  }

  private async ensureNightlightOff(): Promise<boolean> {
    try {
      await this.sleep(1500);
      const controller = this.device.controller || 'default';
      // setNightlight takes a 0-100 percentage and scales it down to Pura's 1-10 level. The device
      // reports brightness already on the 1-10 scale, so it has to be converted first - passing the
      // level straight through made every forced off divide the user's brightness by ten.
      const brightness = this.nightlightLevelToPercent(this.device.nightlight?.brightness);
      const color = this.device.nightlight?.color ?? 'ffffff';
      const success = await this.puraApi.setNightlight(this.device.id, false, brightness, color, controller);
      if (success) {
        this.platform.recordNightlightAutoOff(this.device.id);
        return true;
      }
      return false;
    } catch (error) {
      this.platform.log.debug(`Failed to force nightlight off for ${this.accessory.displayName}:`, error);
      return false;
    }
  }

  private supportsNightlightControl(): boolean {
    const model = this.device.type?.toLowerCase() ?? '';
    if (model.includes('plus')) {
      return false;
    }
    const raw = this.device.__raw as Record<string, unknown> | undefined;
    const hwVersion = typeof raw?.hwVersion === 'string' ? raw.hwVersion : undefined;
    if (!hwVersion) {
      return true;
    }
    const major = Number(hwVersion.split('.')[0]);
    return !(Number.isFinite(major) && major === 22);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }


}
