import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PuraPlatform } from './platform.js';
import { PuraApi } from './puraApi.js';
import { PuraConfig, PuraDevice, PuraBay } from './puraTypes.js';

/**
 * Pura Platform Accessory
 * One diffuser service per device, with optional Nightlight Control service.
 */
export class PuraPlatformAccessory {
  private service: Service;
  private nightlightService?: Service;
  private device: PuraDevice;
  private useFanService: boolean;
  private enableNightlightAccessory: boolean;

  private currentStateActive = false;
  private lastNightlightOffAt = 0;
  private inferredOfflineFromStaleState = false;
  private lastAwayModeEnabledState: boolean | null = null;
  private lastAutoAlternativeOffState: boolean | null = null;
  private nightlightWriteQueue: Promise<void> = Promise.resolve();
  private pendingNightlightActive?: boolean;
  private pendingNightlightIntent?: {
    at: number;
    active: boolean;
    level: number;
    color: string;
  };
  private lastNightlightCommand?: {
    at: number;
    action: 'brightness' | 'on';
    requestedOn: boolean;
    hkBrightnessPercent: number;
    sentLevel: number;
  };

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
      this.platform.api.updatePlatformAccessories([this.accessory]);
      if (this.platform.isDebugEnabled()) {
        this.platform.log.debug(
          `Persisted accessory metadata for ${this.accessory.displayName} (startup): ` +
          `revisionChanged=${revisionChanged}, contextChanged=${contextChanged}`,
        );
      }
    }

    this.useFanService = Boolean((this.platform.config as PuraConfig).useFanService);
    this.enableNightlightAccessory = Boolean((this.platform.config as PuraConfig).enableNightlightAccessory);
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

    this.configureNightlightService();
    this.updateCurrentState();
    this.updateFaultState();
    this.logRecommendationHints(this.device);
  }

  private configureNightlightService() {
    const existing = this.accessory.getServiceById(this.platform.Service.Lightbulb, 'nightlight');
    if (!this.enableNightlightAccessory || !this.supportsNightlightControl()) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      this.nightlightService = undefined;
      return;
    }

    const name = `${this.accessory.displayName} Nightlight Control`;
    this.nightlightService = existing || this.accessory.addService(this.platform.Service.Lightbulb, name, 'nightlight');
    this.nightlightService.setCharacteristic(this.platform.Characteristic.Name, name);
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

  private updateCurrentState() {
    const activeBay = this.getActiveBay();
    this.currentStateActive = Boolean(activeBay?.active);
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
    const bay1 = this.device.bay1;
    const bay2 = this.device.bay2;
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
    return undefined;
  }

  async setOn(value: CharacteristicValue) {
    const isOn = this.useFanService
      ? value === this.platform.Characteristic.Active.ACTIVE
      : Boolean(value);
    this.platform.log.debug(`Set Characteristic Active for ${this.accessory.displayName} ->`, value);
    this.platform.recordIntent(this.device.id, isOn);

    try {
      if (isOn) {
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
            `No bay payload available for ${this.accessory.displayName}; using fallback bay ${targetBay}.`,
          );
        }
        const candidateIntensity = bay && Number.isFinite(bay.intensity) && bay.intensity > 0
          ? bay.intensity
          : undefined;
        const preferredIntensity = Number.isFinite(this.accessory.context.lastIntensity) && this.accessory.context.lastIntensity > 0
          ? this.accessory.context.lastIntensity
          : undefined;
        const intensity = Math.max(1, Math.min(100, preferredIntensity ?? candidateIntensity ?? 60));
        if (noScentVialsDetected || deviceUnavailable) {
          this.enforceOffVisualState();
          this.updateFaultState();
          if (deviceUnavailable) {
            this.platform.log.warn(`${this.accessory.displayName} appears offline (Wi-Fi lost or unplugged).`);
            // Surface an actionable HomeKit error when the device is unreachable.
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          } else {
            this.platform.log.warn(
              `${this.accessory.displayName} was turned on, but no scent vials were detected. ` +
              'The accessory was turned off as a result.',
            );
          }
          return;
        }

        await this.puraApi.stopAll(this.device.id);
        await this.puraApi.setAwayMode(this.device.id, false);
        const alwaysOn = await this.puraApi.setAlwaysOn(this.device.id, targetBay);
        const controller = this.device.controller || 'default';
        const success = alwaysOn && await this.puraApi.setIntensity(this.device.id, targetBay, intensity, controller);
        if (success) {
          this.currentStateActive = true;
          this.accessory.context.lastIntensity = intensity;
          this.accessory.context.lastBay = targetBay;
          this.platform.log.debug(`Successfully turned on ${this.accessory.displayName} with intensity ${intensity}`);
          this.applyCurrentState();
          this.platform.log.info(`${this.accessory.displayName} turned on.`);
          if ((this.platform.config as PuraConfig).forceNightlightOff && this.supportsNightlightControl()) {
            await this.ensureNightlightOff();
          }
        } else {
          this.platform.log.error(`Failed to turn on ${this.accessory.displayName}`);
          throw new Error('Failed to turn on device');
        }
      } else {
        if (this.isDeviceUnavailable()) {
          this.enforceOffVisualState();
          this.updateFaultState();
          this.platform.log.warn(`${this.accessory.displayName} appears offline (Wi-Fi lost or unplugged).`);
          return;
        }
        const success = await this.puraApi.stopAll(this.device.id);
        if (success) {
          this.currentStateActive = false;
          this.platform.log.debug(`Successfully turned off ${this.accessory.displayName}`);
          this.applyCurrentState();
          this.platform.log.info(`${this.accessory.displayName} turned off.`);
        } else {
          this.platform.log.error(`Failed to turn off ${this.accessory.displayName}`);
          throw new Error('Failed to turn off device');
        }
      }
    } catch (error) {
      if (error instanceof this.platform.api.hap.HapStatusError) {
        throw error;
      }
      this.platform.log.error(`Error setting On state for ${this.accessory.displayName}:`, error);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    if (this.isDeviceUnavailable()) {
      this.updateFaultState();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    const isActive = this.getCurrentStateValue();
    this.platform.log.debug(`Get Characteristic Active for ${this.accessory.displayName} ->`, isActive);
    return isActive;
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
      const active = Boolean(value);
      const currentRawBrightness = this.normalizeNightlightLevel(this.device.nightlight?.brightness);
      const brightnessPercent = this.nightlightLevelToPercent(currentRawBrightness ?? 10);
      const sentLevel = this.percentToNightlightLevel(brightnessPercent);
      const controller = this.device.controller || 'default';
      const color = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
      this.pendingNightlightActive = active;

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
      this.pendingNightlightIntent = {
        at: Date.now(),
        active,
        level: sentLevel,
        color,
      };
      this.recordNightlightCommand('on', active, brightnessPercent, sentLevel);
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
      const brightnessPercent = Math.max(0, Math.min(100, Number(value) || 0));
      const turningOff = brightnessPercent <= 0;
      const apiLevel = turningOff
        ? (this.normalizeNightlightLevel(this.device.nightlight?.brightness) ?? 1)
        : this.percentToNightlightLevel(brightnessPercent);
      const snappedPercent = turningOff ? 0 : this.nightlightLevelToPercent(apiLevel);
      const active = turningOff ? false : (this.pendingNightlightActive ?? Boolean(this.device.nightlight?.active));
      const controller = this.device.controller || 'default';
      const color = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
      const apiBrightnessPercent = this.nightlightLevelToPercent(apiLevel);

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
      this.pendingNightlightIntent = {
        at: Date.now(),
        active,
        level: apiLevel,
        color,
      };
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
    const brightness = Boolean(this.device.nightlight?.active)
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
    const stabilizedDevice = this.stabilizeNightlightDuringIntentWindow(device);
    const previousNightlight = this.device.nightlight;
    const previousOnline = this.normalizeOnlineState(this.device.online);
    const nextOnline = this.normalizeOnlineState(stabilizedDevice.online);
    this.logOnlineStateTransition(previousOnline, nextOnline);
    this.device = stabilizedDevice;
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
    this.logNightlightProfileRoundTrip(previousNightlight, stabilizedDevice.nightlight);
    this.updateCurrentState();
    void this.maybeForceNightlightOff();
  }

  private logInferredOfflineTransition() {
    const inferredOffline = this.isLikelyOfflineFromStaleStatus();
    if (inferredOffline === this.inferredOfflineFromStaleState) {
      return;
    }
    this.inferredOfflineFromStaleState = inferredOffline;
    if (inferredOffline) {
      this.platform.log.warn(
        `${this.accessory.displayName} appears offline (cloud status may be stale; reported online without bay payload).`,
      );
    } else {
      this.platform.log.info(`${this.accessory.displayName} cloud status appears current again.`);
    }
  }

  private logRecommendationHints(device: PuraDevice) {
    const awayModeEnabled = this.isAwayModeEnabled(device);
    if (awayModeEnabled !== this.lastAwayModeEnabledState) {
      const isInitialLog = this.lastAwayModeEnabledState === null;
      this.lastAwayModeEnabledState = awayModeEnabled;
      if (awayModeEnabled) {
        this.platform.log.warn(
          isInitialLog
            ? `Away mode is currently enabled on ${this.accessory.displayName}. ` +
              'For best results, please disable it in the Pura app.'
            : `Away mode was enabled on ${this.accessory.displayName}. ` +
              'For best results, please disable it in the Pura app.',
        );
      }
    }

    const autoAlternativeLikelyOff = this.isAutoAlternativeLikelyOff(device);
    if (autoAlternativeLikelyOff !== this.lastAutoAlternativeOffState) {
      const isInitialLog = this.lastAutoAlternativeOffState === null;
      this.lastAutoAlternativeOffState = autoAlternativeLikelyOff;
      if (autoAlternativeLikelyOff) {
        this.platform.log.warn(
          isInitialLog
            ? `Auto-alternate fragrances is currently disabled on ${this.accessory.displayName}. ` +
              'For best results, please enable it in the Pura app.'
            : `Auto-alternate fragrances was disabled on ${this.accessory.displayName}. ` +
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
    if (previousOnline === undefined || nextOnline === undefined || previousOnline === nextOnline) {
      return;
    }
    if (nextOnline) {
      this.platform.log.info(`${this.accessory.displayName} is back online.`);
      return;
    }
    this.platform.log.warn(`${this.accessory.displayName} appears offline (Wi-Fi lost or unplugged).`);
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
      this.platform.api.updatePlatformAccessories([this.accessory]);
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
        activeAt: bay.activeAt,
        timerActive: bay.timer?.active,
        fragrance: bay.fragrance?.name,
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
    const now = Date.now();
    if (now - this.lastNightlightOffAt < 30000) {
      return;
    }
    this.lastNightlightOffAt = now;
    await this.ensureNightlightOff();
  }

  private getCurrentStateValue(): CharacteristicValue {
    if (this.useFanService) {
      return this.currentStateActive
        ? this.platform.Characteristic.Active.ACTIVE
        : this.platform.Characteristic.Active.INACTIVE;
    }
    return this.currentStateActive;
  }

  private applyCurrentState() {
    const value = this.getCurrentStateValue();
    const activeCharacteristic = this.useFanService
      ? this.platform.Characteristic.Active
      : this.platform.Characteristic.On;
    this.service.updateCharacteristic(activeCharacteristic, value);
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
    this.lastNightlightCommand = {
      at: Date.now(),
      action,
      requestedOn,
      hkBrightnessPercent,
      sentLevel,
    };
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
    this.pendingNightlightIntent = {
      at: Date.now(),
      active,
      level: apiLevel,
      color: normalizedColor,
    };
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

  private stabilizeNightlightDuringIntentWindow(device: PuraDevice): PuraDevice {
    if (!this.pendingNightlightIntent) {
      return device;
    }
    const ageMs = Date.now() - this.pendingNightlightIntent.at;
    if (ageMs > 5000) {
      this.pendingNightlightIntent = undefined;
      return device;
    }
    if (!device.nightlight) {
      return device;
    }

    const intent = this.pendingNightlightIntent;
    const incomingLevel = this.normalizeNightlightLevel(device.nightlight.brightness);
    const incomingActive = Boolean(device.nightlight.active);
    const incomingColor = this.normalizeNightlightColor(device.nightlight.color);
    const matchesIntent = incomingActive === intent.active
      && incomingLevel === intent.level
      && incomingColor === intent.color;
    if (matchesIntent) {
      this.pendingNightlightIntent = undefined;
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

  private async ensureNightlightOff() {
    try {
      await this.sleep(1500);
      const controller = this.device.controller || 'default';
      const brightness = this.device.nightlight?.brightness ?? 1;
      const color = this.device.nightlight?.color ?? 'ffffff';
      await this.puraApi.setNightlight(this.device.id, false, brightness, color, controller);
    } catch (error) {
      this.platform.log.debug(`Failed to force nightlight off for ${this.accessory.displayName}:`, error);
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
