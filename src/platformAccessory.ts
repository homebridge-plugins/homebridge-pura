import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PuraPlatform } from './platform.js';
import { PuraApi } from './puraApi.js';
import { PuraDevice } from './puraTypes.js';

/**
 * Pura Platform Accessory
 * An instance of this class is created for each Pura device
 * Each accessory exposes an AirPurifier service (On/Off only) to represent the diffuser
 */
export class PuraPlatformAccessory {
  private purifierService: Service;
  private lightService: Service | null = null;
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

    // Remove legacy Fan service if present
    const legacyFan = this.accessory.getService(this.platform.Service.Fan);
    if (legacyFan) {
      this.accessory.removeService(legacyFan);
    }

    // Get the AirPurifier service if it exists, otherwise create it
    this.purifierService = this.accessory.getService(this.platform.Service.AirPurifier) ||
      this.accessory.addService(this.platform.Service.AirPurifier);

    // Set the service name
    this.purifierService.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    // Register handlers for the On/Off Characteristic
    this.purifierService.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.purifierService.getCharacteristic(this.platform.Characteristic.CurrentAirPurifierState)
      .onGet(this.getCurrentPurifierState.bind(this));

    this.purifierService.getCharacteristic(this.platform.Characteristic.TargetAirPurifierState)
      .onGet(() => this.platform.Characteristic.TargetAirPurifierState.MANUAL)
      .onSet(() => undefined);

    // Initialize current state from device
    this.updateCurrentState();

    // Lightbulb service for nightlight
    this.lightService = this.accessory.getService(this.platform.Service.Lightbulb) ||
      this.accessory.addService(this.platform.Service.Lightbulb, `${accessory.displayName} Nightlight`);
    this.lightService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setNightlight.bind(this))
      .onGet(this.getNightlight.bind(this));
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
    this.purifierService.updateCharacteristic(this.platform.Characteristic.Active,
      this.currentState.On ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
    this.purifierService.updateCharacteristic(this.platform.Characteristic.CurrentAirPurifierState,
      this.currentState.On
        ? this.platform.Characteristic.CurrentAirPurifierState.PURIFYING_AIR
        : this.platform.Characteristic.CurrentAirPurifierState.INACTIVE,
    );

    if (this.lightService) {
      const lightOn = Boolean(this.device.nightlight?.active);
      this.lightService.updateCharacteristic(this.platform.Characteristic.On, lightOn);
    }
  }

  /**
   * Handle "SET" requests from HomeKit for On/Off
   */
  async setOn(value: CharacteristicValue) {
    const isOn = (value as number) === this.platform.Characteristic.Active.ACTIVE;
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
        // Turn off all diffusion
        const success = await this.puraApi.stopAll(this.device.id);
        
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
    return isOn ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
  }

  async getCurrentPurifierState(): Promise<CharacteristicValue> {
    return this.currentState.On
      ? this.platform.Characteristic.CurrentAirPurifierState.PURIFYING_AIR
      : this.platform.Characteristic.CurrentAirPurifierState.INACTIVE;
  }

  /**
   * Update device data and refresh state
   */
  updateDevice(device: PuraDevice) {
    this.device = device;
    this.accessory.context.device = device;
    this.updateCurrentState();
  }

  async setNightlight(value: CharacteristicValue) {
    const isOn = Boolean(value);
    const brightness = this.device.nightlight?.brightness ?? 10;
    const color = this.device.nightlight?.color ?? 'ffffff';
    const success = await this.puraApi.setNightlight(this.device.id, isOn, brightness, color);
    if (!success) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getNightlight(): Promise<CharacteristicValue> {
    return Boolean(this.device.nightlight?.active);
  }

}
