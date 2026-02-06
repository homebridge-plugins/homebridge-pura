import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PuraPlatform } from './platform.js';
import { PuraApi } from './puraApi.js';
import { PuraDevice, PuraBay } from './puraTypes.js';

/**
 * Pura Platform Accessory
 * One Fan service per bay (On/Off + Speed).
 */
export class PuraPlatformAccessory {
  private service: Service;
  private device: PuraDevice;
  private bayNumber: number;

  private currentState = {
    On: false,
    RotationSpeed: 0,
  };

  constructor(
    private readonly platform: PuraPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly puraApi: PuraApi,
  ) {
    this.device = accessory.context.device;
    this.bayNumber = accessory.context.bayNumber;

    const safeModel = this.device.type && this.device.type.length > 1 ? this.device.type : 'Pura Diffuser';
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Pura')
      .setCharacteristic(this.platform.Characteristic.Model, safeModel)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, this.device.state?.firmwareVersion || '1.0.0');

    this.service = this.accessory.getService(this.platform.Service.Fan) ||
      this.accessory.addService(this.platform.Service.Fan);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setRotationSpeed.bind(this))
      .onGet(this.getRotationSpeed.bind(this));

    this.updateCurrentState();
  }

  private updateCurrentState() {
    const bay = this.getBay();
    if (!bay) {
      return;
    }
    this.currentState.On = Boolean(bay.active);
    const intensity = Number.isFinite(bay.intensity) ? bay.intensity : 0;
    this.currentState.RotationSpeed = Math.max(0, Math.min(100, intensity));

    this.service.updateCharacteristic(this.platform.Characteristic.On, this.currentState.On);
    this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.currentState.RotationSpeed);
  }

  private getBay(): PuraBay | undefined {
    return this.bayNumber === 1 ? this.device.bay1 : this.device.bay2;
  }

  async setOn(value: CharacteristicValue) {
    const isOn = value as boolean;
    this.platform.log.debug(`Set Characteristic On for ${this.accessory.displayName} ->`, value);

    try {
      if (isOn) {
        const intensity = this.currentState.RotationSpeed || this.accessory.context.lastKnownIntensity || 60;
        await this.puraApi.stopAll(this.device.id);
        await this.puraApi.setAwayMode(this.device.id, false);
        const alwaysOn = await this.puraApi.setAlwaysOn(this.device.id, this.bayNumber);
        const success = alwaysOn && await this.puraApi.setIntensity(this.device.id, this.bayNumber, intensity);
        if (success) {
          this.currentState.On = true;
          this.currentState.RotationSpeed = intensity;
          this.accessory.context.lastKnownIntensity = intensity;
          await this.turnOffOtherBay();
          this.platform.log.debug(`Successfully turned on ${this.accessory.displayName} with intensity ${intensity}`);
        } else {
          this.platform.log.error(`Failed to turn on ${this.accessory.displayName}`);
          throw new Error('Failed to turn on device');
        }
      } else {
        const success = await this.puraApi.stopAll(this.device.id);
        if (success) {
          this.currentState.On = false;
          this.currentState.RotationSpeed = 0;
          this.platform.log.debug(`Successfully turned off ${this.accessory.displayName}`);
          await this.turnOffOtherBay();
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

  async setRotationSpeed(value: CharacteristicValue) {
    const intensity = Math.max(0, Math.min(100, Number(value) || 0));
    this.platform.log.debug(`Set Characteristic RotationSpeed for ${this.accessory.displayName} ->`, intensity);

    try {
      if (intensity === 0) {
        const success = await this.puraApi.stopAll(this.device.id);
        if (success) {
          this.currentState.On = false;
          this.currentState.RotationSpeed = 0;
          this.service.updateCharacteristic(this.platform.Characteristic.On, false);
          await this.turnOffOtherBay();
          return;
        }
        throw new Error('Failed to set intensity');
      }

      await this.puraApi.stopAll(this.device.id);
      await this.puraApi.setAwayMode(this.device.id, false);
      const alwaysOn = await this.puraApi.setAlwaysOn(this.device.id, this.bayNumber);
      const success = alwaysOn && await this.puraApi.setIntensity(this.device.id, this.bayNumber, intensity);
      if (success) {
        this.currentState.RotationSpeed = intensity;
        this.currentState.On = true;
        this.accessory.context.lastKnownIntensity = intensity;
        await this.turnOffOtherBay();
        this.service.updateCharacteristic(this.platform.Characteristic.On, true);
        this.platform.log.debug(`Successfully set intensity for ${this.accessory.displayName} to ${intensity}`);
      } else {
        this.platform.log.error(`Failed to set intensity for ${this.accessory.displayName}`);
        throw new Error('Failed to set intensity');
      }
    } catch (error) {
      this.platform.log.error(`Error setting RotationSpeed for ${this.accessory.displayName}:`, error);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getRotationSpeed(): Promise<CharacteristicValue> {
    const intensity = this.currentState.RotationSpeed;
    this.platform.log.debug(`Get Characteristic RotationSpeed for ${this.accessory.displayName} ->`, intensity);
    return intensity;
  }

  updateDevice(device: PuraDevice) {
    this.device = device;
    this.accessory.context.device = device;
    this.updateCurrentState();
  }

  private async turnOffOtherBay() {
    const otherBay = this.bayNumber === 1 ? 2 : 1;
    const otherUuid = this.platform.api.hap.uuid.generate(`${this.device.id}-bay${otherBay}`);
    const otherAccessory = this.platform.accessories.get(otherUuid);
    if (otherAccessory) {
      const service = otherAccessory.getService(this.platform.Service.Fan);
      if (service) {
        service.updateCharacteristic(this.platform.Characteristic.On, false);
        service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, 0);
      }
      otherAccessory.context.device = {
        ...this.device,
        bay1: otherBay === 1 ? { ...this.device.bay1, active: false, intensity: 0 } : this.device.bay1,
        bay2: otherBay === 2 ? { ...this.device.bay2, active: false, intensity: 0 } : this.device.bay2,
      };
    }
  }
}
