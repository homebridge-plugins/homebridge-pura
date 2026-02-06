import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PuraPlatform } from './platform.js';
import { PuraApi } from './puraApi.js';
import { PuraDevice } from './puraTypes.js';

/**
 * Pura Platform Accessory
 * An instance of this class is created for each Pura device
 * Each accessory exposes a Fan service (On/Off only) to represent the diffuser
 */
export class PuraPlatformAccessory {
  private service: Service;
  private device: PuraDevice;

  /**
   * Track the current state of the diffuser
   */
  private currentState = {
    On: false,
  };
  private lastKnownIntensity = 60;

  constructor(
    private readonly platform: PuraPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly puraApi: PuraApi,
  ) {
    this.device = accessory.context.device;
    this.lastKnownIntensity = accessory.context.lastKnownIntensity || 60;

    // Set accessory information
    const safeModel = this.device.type && this.device.type.length > 1 ? this.device.type : 'Pura Diffuser';
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Pura')
      .setCharacteristic(this.platform.Characteristic.Model, safeModel)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, this.device.state?.firmwareVersion || '1.0.0');

    // Get the Fan service if it exists, otherwise create a new Fan service
    this.service = this.accessory.getService(this.platform.Service.Fan) || 
                   this.accessory.addService(this.platform.Service.Fan);

    // Set the service name
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    // Register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    // Initialize current state from device
    this.updateCurrentState();
  }

  /**
   * Update current state from device data
   */
  private updateCurrentState() {
    const bay1Intensity = Number.isFinite(this.device.bay1?.intensity) ? this.device.bay1!.intensity : 0;
    const bay2Intensity = Number.isFinite(this.device.bay2?.intensity) ? this.device.bay2!.intensity : 0;
    const isOn = Boolean(this.device.bay1?.active) || Boolean(this.device.bay2?.active) ||
      bay1Intensity > 0 || bay2Intensity > 0;

    if (bay1Intensity > 0 || bay2Intensity > 0) {
      this.lastKnownIntensity = Math.max(bay1Intensity, bay2Intensity);
      this.accessory.context.lastKnownIntensity = this.lastKnownIntensity;
    }

    this.currentState.On = isOn;
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.currentState.On);
  }

  /**
   * Handle "SET" requests from HomeKit for On/Off
   */
  async setOn(value: CharacteristicValue) {
    const isOn = value as boolean;
    this.platform.log.debug(`Set Characteristic On for ${this.accessory.displayName} ->`, value);

    try {
      if (isOn) {
        const intensity = this.lastKnownIntensity || 60;
        const success1 = this.device.bay1
          ? await this.puraApi.setIntensity(this.device.id, 1, intensity)
          : true;
        const success2 = this.device.bay2
          ? await this.puraApi.setIntensity(this.device.id, 2, intensity)
          : true;
        const success = success1 && success2;
        
        if (success) {
          this.currentState.On = true;
          this.platform.log.debug(`Successfully turned on ${this.accessory.displayName} with intensity ${intensity}`);
        } else {
          this.platform.log.error(`Failed to turn on ${this.accessory.displayName}`);
          throw new Error('Failed to turn on device');
        }
      } else {
        // Turn off by setting intensity to 0
        const success1 = this.device.bay1
          ? await this.puraApi.setIntensity(this.device.id, 1, 0)
          : true;
        const success2 = this.device.bay2
          ? await this.puraApi.setIntensity(this.device.id, 2, 0)
          : true;
        const success = success1 && success2;
        
        if (success) {
          this.currentState.On = false;
          this.platform.log.debug(`Successfully turned off ${this.accessory.displayName}`);
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

  /**
   * Handle the "GET" requests from HomeKit for On/Off
   */
  async getOn(): Promise<CharacteristicValue> {
    const isOn = this.currentState.On;
    this.platform.log.debug(`Get Characteristic On for ${this.accessory.displayName} ->`, isOn);
    return isOn;
  }

  /**
   * Update device data and refresh state
   */
  updateDevice(device: PuraDevice) {
    this.device = device;
    this.accessory.context.device = device;
    this.updateCurrentState();
  }

}
