import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PuraPlatform } from './platform.js';
import { PuraApi } from './puraApi.js';
import { PuraDevice, PuraBay } from './puraTypes.js';

/**
 * Pura Platform Accessory
 * An instance of this class is created for each bay of each Pura device
 * Each accessory exposes a Fan service to represent the fragrance diffuser
 */
export class PuraPlatformAccessory {
  private service: Service;
  private device: PuraDevice;
  private bayNumber: number;

  /**
   * Track the current state of the diffuser
   */
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

    // Register handlers for the RotationSpeed Characteristic (represents intensity)
    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setRotationSpeed.bind(this))
      .onGet(this.getRotationSpeed.bind(this));

    // Initialize current state from device
    this.updateCurrentState();
  }

  /**
   * Update current state from device data
   */
  private updateCurrentState() {
    const bay = this.getBay();
    if (bay) {
      this.currentState.On = Boolean(bay.active);
      const intensity = Number.isFinite(bay.intensity) ? bay.intensity : 0;
      this.currentState.RotationSpeed = Math.max(0, Math.min(100, intensity));
      
      // Update HomeKit with current state
      this.service.updateCharacteristic(this.platform.Characteristic.On, this.currentState.On);
      this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.currentState.RotationSpeed);
    }
  }

  /**
   * Get the bay data for this accessory
   */
  private getBay(): PuraBay | undefined {
    return this.bayNumber === 1 ? this.device.bay1 : this.device.bay2;
  }

  /**
   * Handle "SET" requests from HomeKit for On/Off
   */
  async setOn(value: CharacteristicValue) {
    const isOn = value as boolean;
    this.platform.log.debug(`Set Characteristic On for ${this.accessory.displayName} ->`, value);

    try {
      if (isOn) {
        // Turn on with current intensity or default to 50%
        const intensity = this.currentState.RotationSpeed || 50;
        const success = await this.puraApi.setIntensity(this.device.id, this.bayNumber, intensity);
        
        if (success) {
          this.currentState.On = true;
          this.currentState.RotationSpeed = intensity;
          this.platform.log.debug(`Successfully turned on ${this.accessory.displayName} with intensity ${intensity}`);
        } else {
          this.platform.log.error(`Failed to turn on ${this.accessory.displayName}`);
          throw new Error('Failed to turn on device');
        }
      } else {
        // Turn off by setting intensity to 0
        const success = await this.puraApi.setIntensity(this.device.id, this.bayNumber, 0);
        
        if (success) {
          this.currentState.On = false;
          this.currentState.RotationSpeed = 0;
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
   * Handle "SET" requests from HomeKit for RotationSpeed (intensity)
   */
  async setRotationSpeed(value: CharacteristicValue) {
    const intensity = Math.max(0, Math.min(100, Number(value) || 0));
    this.platform.log.debug(`Set Characteristic RotationSpeed for ${this.accessory.displayName} ->`, intensity);

    try {
      const success = await this.puraApi.setIntensity(this.device.id, this.bayNumber, intensity);
      
      if (success) {
        this.currentState.RotationSpeed = intensity;
        this.currentState.On = intensity > 0;
        
        // Update the On characteristic to reflect the new state
        this.service.updateCharacteristic(this.platform.Characteristic.On, this.currentState.On);
        
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

  /**
   * Handle the "GET" requests from HomeKit for RotationSpeed (intensity)
   */
  async getRotationSpeed(): Promise<CharacteristicValue> {
    const intensity = this.currentState.RotationSpeed;
    this.platform.log.debug(`Get Characteristic RotationSpeed for ${this.accessory.displayName} ->`, intensity);
    return intensity;
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
