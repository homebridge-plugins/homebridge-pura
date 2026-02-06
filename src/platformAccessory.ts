import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PuraPlatform } from './platform.js';
import { PuraApi } from './puraApi.js';
import { PuraConfig, PuraDevice, PuraBay } from './puraTypes.js';
import { PuraNightlightAccessory } from './puraNightlightAccessory.js';

/**
 * Pura Platform Accessory
 * One Switch service per diffuser (On/Off).
 */
export class PuraPlatformAccessory {
  private service: Service;
  private device: PuraDevice;

  private currentState = {
    On: false,
  };

  constructor(
    private readonly platform: PuraPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly puraApi: PuraApi,
  ) {
    this.device = accessory.context.device;

    const safeModel = this.device.type && this.device.type.length > 1 ? this.device.type : 'Pura Diffuser';
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Pura')
      .setCharacteristic(this.platform.Characteristic.Model, safeModel)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, this.device.state?.firmwareVersion || '1.0.0');

    this.service = this.accessory.getService(this.platform.Service.Switch) ||
      this.accessory.addService(this.platform.Service.Switch);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.updateCurrentState();
  }

  private updateCurrentState() {
    const activeBay = this.getActiveBay();
    this.currentState.On = activeBay ? Boolean(activeBay.active) : false;
    if (activeBay) {
      this.accessory.context.lastBay = activeBay === this.device.bay1 ? 1 : 2;
      if (Number.isFinite(activeBay.intensity) && activeBay.intensity > 0) {
        this.accessory.context.lastIntensity = activeBay.intensity;
      }
    }
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.currentState.On);
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
    const isOn = value as boolean;
    this.platform.log.debug(`Set Characteristic On for ${this.accessory.displayName} ->`, value);

    try {
      if (isOn) {
        await this.logDeviceSnapshot('before-on');
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
        this.platform.log.info('Pura control context:', {
          deviceId: this.device.id,
          bay: targetBay,
          controller,
          diffusionMode: this.device.diffusionMode,
        });
        const success = alwaysOn && await this.puraApi.setIntensity(this.device.id, targetBay, intensity, controller);
        if (success) {
          this.currentState.On = true;
          this.accessory.context.lastIntensity = intensity;
          this.accessory.context.lastBay = targetBay;
          this.platform.log.debug(`Successfully turned on ${this.accessory.displayName} with intensity ${intensity}`);
          await this.syncNightlightWithDiffuser(true);
          if ((this.platform.config as PuraConfig).forceNightlightOffOnDiffuserOn) {
            await this.ensureNightlightOff();
          }
          await this.logDeviceSnapshot('after-on');
          await this.logDeviceSnapshot('after-on-post');
        } else {
          this.platform.log.error(`Failed to turn on ${this.accessory.displayName}`);
          throw new Error('Failed to turn on device');
        }
      } else {
        const success = await this.puraApi.stopAll(this.device.id);
        if (success) {
          this.currentState.On = false;
          this.platform.log.debug(`Successfully turned off ${this.accessory.displayName}`);
          await this.syncNightlightWithDiffuser(false);
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
    const isOn = this.currentState.On;
    this.platform.log.debug(`Get Characteristic On for ${this.accessory.displayName} ->`, isOn);
    return isOn;
  }

  updateDevice(device: PuraDevice) {
    this.device = device;
    this.accessory.context.device = device;
    this.updateCurrentState();
  }

  private async ensureNightlightOff() {
    const nightUuid = this.platform.api.hap.uuid.generate(`${this.device.id}-nightlight`);
    const nightAccessory = this.platform.accessories.get(nightUuid);
    if (!nightAccessory) {
      return;
    }
    const nightHandler = (nightAccessory as any).handler as PuraNightlightAccessory | undefined;
    if (!nightHandler) {
      return;
    }
    try {
      await this.sleep(1500);
      await nightHandler.setNightlight(false);
    } catch (error) {
      this.platform.log.debug(`Failed to force nightlight off for ${this.accessory.displayName}:`, error);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async syncNightlightWithDiffuser(isOn: boolean) {
    const syncMode = (this.platform.config as PuraConfig).nightlightSyncMode ?? 'diffuser';
    if (syncMode !== 'diffuser') {
      return;
    }
    const nightUuid = this.platform.api.hap.uuid.generate(`${this.device.id}-nightlight`);
    const nightAccessory = this.platform.accessories.get(nightUuid);
    if (!nightAccessory) {
      return;
    }
    nightAccessory.context.nightlightLastOn = isOn;
    const service = nightAccessory.getService(this.platform.Service.Lightbulb);
    if (service) {
      service.updateCharacteristic(this.platform.Characteristic.On, isOn);
    }
  }

  private async logDeviceSnapshot(label: string) {
    try {
      const devices = await this.puraApi.getDevices();
      const match = devices.find((device) => device.id === this.device.id);
      if (!match) {
        this.platform.log.debug(`Pura device snapshot ${label}: device not found for ${this.device.id}`);
        return;
      }
      this.platform.log.debug(`Pura device snapshot ${label}:`, JSON.stringify({
        id: match.id,
        name: match.name,
        controller: match.controller,
        diffusionMode: match.diffusionMode,
        awayMode: match.awayMode,
        ambientMode: match.ambientMode,
        nightlight: match.nightlight,
        bay1: match.bay1,
        bay2: match.bay2,
      }, null, 2));
    } catch (error) {
      this.platform.log.debug(`Failed to capture Pura device snapshot ${label}:`, error);
    }
  }

}
