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
    this.applyRevisionCharacteristics(infoService, firmwareRevision, hardwareRevision);

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
          : (this.device.bay1 ? 1 : 2);
        const bay = targetBay === 1 ? this.device.bay1 : this.device.bay2;
        if (!bay) {
          this.platform.log.error(`No bay data available for ${this.accessory.displayName}`);
          throw new Error('No bay data available');
        }
        const candidateIntensity = bay?.intensity;
        const intensity = Math.max(1, Math.min(100, (
          this.accessory.context.lastIntensity ??
          (Number.isFinite(candidateIntensity) ? candidateIntensity : 0) ??
          60
        )));
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
          if ((this.platform.config as PuraConfig).forceNightlightOff) {
            await this.ensureNightlightOff();
          }
        } else {
          this.platform.log.error(`Failed to turn on ${this.accessory.displayName}`);
          throw new Error('Failed to turn on device');
        }
      } else {
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
      this.platform.log.error(`Error setting On state for ${this.accessory.displayName}:`, error);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    const isActive = this.getCurrentStateValue();
    this.platform.log.debug(`Get Characteristic Active for ${this.accessory.displayName} ->`, isActive);
    return isActive;
  }

  updateDevice(device: PuraDevice) {
    this.device = device;
    this.accessory.context.device = device;
    this.updateAccessoryInformation();
    if (this.platform.isDebugEnabled()) {
      this.platform.log.debug('Device snapshot:', this.summarizeDevice(device));
    }
    this.updateCurrentState();
    void this.maybeForceNightlightOff();
  }

  private updateAccessoryInformation() {
    const safeModel = this.device.type && this.device.type.length > 1 ? this.device.type : 'Pura Diffuser';
    const firmwareRevision = this.getFirmwareRevision();
    const hardwareRevision = this.getHardwareRevision();
    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    infoService.setCharacteristic(this.platform.Characteristic.Model, safeModel);
    this.applyRevisionCharacteristics(infoService, firmwareRevision, hardwareRevision);
  }

  private applyRevisionCharacteristics(infoService: Service, firmwareRevision?: string, hardwareRevision?: string) {
    if (firmwareRevision) {
      // Keep revision fields in sync so cached accessories do not retain stale "0.0" values.
      infoService.setCharacteristic(this.platform.Characteristic.FirmwareRevision, firmwareRevision);
      infoService.updateCharacteristic(this.platform.Characteristic.FirmwareRevision, firmwareRevision);
      infoService.setCharacteristic(this.platform.Characteristic.SoftwareRevision, firmwareRevision);
      infoService.updateCharacteristic(this.platform.Characteristic.SoftwareRevision, firmwareRevision);
    }
    if (hardwareRevision) {
      infoService.setCharacteristic(this.platform.Characteristic.HardwareRevision, hardwareRevision);
      infoService.updateCharacteristic(this.platform.Characteristic.HardwareRevision, hardwareRevision);
    }
  }

  private getFirmwareRevision(): string | undefined {
    const current = this.normalizeFirmwareRevision(this.device.state?.firmwareVersion);
    if (current) {
      this.accessory.context.firmwareRevision = current;
      return current;
    }
    const raw = this.device.__raw as Record<string, unknown> | undefined;
    const fromRaw = this.normalizeFirmwareRevision(raw?.firmwareVersion ?? raw?.fwVersion);
    if (fromRaw) {
      this.accessory.context.firmwareRevision = fromRaw;
      return fromRaw;
    }
    const cached = this.normalizeFirmwareRevision(this.accessory.context.firmwareRevision);
    if (cached) {
      return cached;
    }
    return undefined;
  }

  private getHardwareRevision(): string | undefined {
    const raw = this.device.__raw as Record<string, unknown> | undefined;
    const current = this.normalizeFirmwareRevision(raw?.hwVersion);
    if (current) {
      this.accessory.context.hardwareRevision = current;
      return current;
    }
    const cached = this.normalizeFirmwareRevision(this.accessory.context.hardwareRevision);
    if (cached) {
      return cached;
    }
    return undefined;
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }


}
