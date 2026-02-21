import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PuraPlatform } from './platform.js';
import { PuraApi } from './puraApi.js';
import { PuraConfig, PuraDevice, PuraBay } from './puraTypes.js';

/**
 * Pura Platform Accessory
 * One Switch service per diffuser (On/Off) by default.
 */
export class PuraPlatformAccessory {
  private service: Service;
  private device: PuraDevice;
  private useFanService: boolean;

  private currentStateActive = false;
  private lastNightlightOffAt = 0;
  private lastAwayModeEnabledState: boolean | null = null;
  private lastAutoAlternativeOffState: boolean | null = null;

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

    this.updateCurrentState();
    this.updateFaultState();
    this.logRecommendationHints(this.device);
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
    this.updateFaultState();
  }

  private hasNoScentVialsDetected(): boolean {
    return !this.device.bay1 && !this.device.bay2;
  }

  private isDeviceOffline(): boolean {
    return this.normalizeOnlineState(this.device.online) === false;
  }

  private updateFaultState() {
    if (!this.service.testCharacteristic(this.platform.Characteristic.StatusFault)) {
      return;
    }
    const nextFault = (this.hasNoScentVialsDetected() || this.isDeviceOffline())
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
        const deviceOffline = this.isDeviceOffline();
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
        if (noScentVialsDetected || deviceOffline) {
          this.enforceOffVisualState();
          this.updateFaultState();
          if (deviceOffline) {
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
        if (this.isDeviceOffline()) {
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
    if (this.isDeviceOffline()) {
      this.updateFaultState();
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    const isActive = this.getCurrentStateValue();
    this.platform.log.debug(`Get Characteristic Active for ${this.accessory.displayName} ->`, isActive);
    return isActive;
  }

  updateDevice(device: PuraDevice) {
    const previousOnline = this.normalizeOnlineState(this.device.online);
    const nextOnline = this.normalizeOnlineState(device.online);
    this.logOnlineStateTransition(previousOnline, nextOnline);
    this.logRecommendationHints(device);
    this.device = device;
    this.accessory.context.device = device;
    this.updateAccessoryInformation();
    if (this.platform.isDebugEnabled()) {
      this.platform.log.debug('Device snapshot:', this.summarizeDevice(device));
    }
    this.updateCurrentState();
    void this.maybeForceNightlightOff();
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
    const mode = (device.diffusionMode ?? '').toLowerCase();
    return mode === 'standard';
  }

  private normalizeOnlineState(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
      return value;
    }
    return undefined;
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
