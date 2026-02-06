import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PuraPlatform } from './platform.js';
import { PuraApi } from './puraApi.js';
import { PuraDevice } from './puraTypes.js';

/**
 * Pura Platform Accessory
 * An instance of this class is created for each Pura device
 * Each accessory exposes a Fan service (On/Off + Speed) and a bay selector switch.
 */
export class PuraPlatformAccessory {
  private fanService: Service;
  private lightService: Service | null = null;
  private baySwitchService: Service | null = null;
  private device: PuraDevice;

  /**
   * Track the current state of the diffuser
   */
  private currentState = {
    On: false,
  };
  private lastKnownIntensity = 60;
  private selectedBay = 1;

  constructor(
    private readonly platform: PuraPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly puraApi: PuraApi,
  ) {
    this.device = accessory.context.device;
    this.lastKnownIntensity = accessory.context.lastKnownIntensity || 60;
    this.selectedBay = accessory.context.selectedBay || 1;

    // Set accessory information
    const safeModel = this.device.type && this.device.type.length > 1 ? this.device.type : 'Pura Diffuser';
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Pura')
      .setCharacteristic(this.platform.Characteristic.Model, safeModel)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, this.device.state?.firmwareVersion || '1.0.0');

    // Remove legacy AirPurifier service if present
    const legacyPurifier = this.accessory.getService(this.platform.Service.AirPurifier);
    if (legacyPurifier) {
      this.accessory.removeService(legacyPurifier);
    }

    // Get the Fan service if it exists, otherwise create it
    this.fanService = this.accessory.getService(this.platform.Service.Fan) ||
      this.accessory.addService(this.platform.Service.Fan);

    // Set the service name
    this.fanService.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    // Register handlers for the Fan On/Off + Speed
    this.fanService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setRotationSpeed.bind(this))
      .onGet(this.getRotationSpeed.bind(this));

    // Initialize current state from device
    this.updateCurrentState();

    // Lightbulb service for nightlight
    this.lightService = this.accessory.getService(this.platform.Service.Lightbulb) ||
      this.accessory.addService(this.platform.Service.Lightbulb, `${accessory.displayName} Nightlight`);
    this.lightService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setNightlight.bind(this))
      .onGet(this.getNightlight.bind(this));
    this.lightService.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setNightlightBrightness.bind(this))
      .onGet(this.getNightlightBrightness.bind(this));
    this.lightService.getCharacteristic(this.platform.Characteristic.Hue)
      .onSet(this.setNightlightHue.bind(this))
      .onGet(this.getNightlightHue.bind(this));
    this.lightService.getCharacteristic(this.platform.Characteristic.Saturation)
      .onSet(this.setNightlightSaturation.bind(this))
      .onGet(this.getNightlightSaturation.bind(this));

    // Bay selector switch
    if (this.device.bay2) {
      this.baySwitchService = this.accessory.getService(this.platform.Service.Switch) ||
        this.accessory.addService(this.platform.Service.Switch, `${accessory.displayName} Bay 2`);
      this.baySwitchService.getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setBaySwitch.bind(this))
        .onGet(this.getBaySwitch.bind(this));
    }
  }

  /**
   * Update current state from device data
   */
  private updateCurrentState() {
    const bay1Intensity = Number.isFinite(this.device.bay1?.intensity) ? this.device.bay1!.intensity : 0;
    const bay2Intensity = Number.isFinite(this.device.bay2?.intensity) ? this.device.bay2!.intensity : 0;
    const isOn = Boolean(this.device.bay1?.active) || Boolean(this.device.bay2?.active) ||
      bay1Intensity > 0 || bay2Intensity > 0;

    if (bay2Intensity > 0 || Boolean(this.device.bay2?.active)) {
      this.selectedBay = 2;
      this.accessory.context.selectedBay = 2;
    } else if (bay1Intensity > 0 || Boolean(this.device.bay1?.active)) {
      this.selectedBay = 1;
      this.accessory.context.selectedBay = 1;
    }

    if (bay1Intensity > 0 || bay2Intensity > 0) {
      this.lastKnownIntensity = Math.max(bay1Intensity, bay2Intensity);
      this.accessory.context.lastKnownIntensity = this.lastKnownIntensity;
    }

    this.currentState.On = isOn;
    this.fanService.updateCharacteristic(this.platform.Characteristic.On, this.currentState.On);
    this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.lastKnownIntensity);

    if (this.lightService) {
      const lightOn = Boolean(this.device.nightlight?.active);
      const brightness = this.device.nightlight?.brightness ?? 10;
      const { hue, saturation } = this.hexToHsv(this.device.nightlight?.color ?? 'ffffff');
      this.accessory.context.nightlightBrightness = brightness;
      this.accessory.context.nightlightHue = hue;
      this.accessory.context.nightlightSaturation = saturation;
      this.lightService.updateCharacteristic(this.platform.Characteristic.On, lightOn);
      this.lightService.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
      this.lightService.updateCharacteristic(this.platform.Characteristic.Hue, hue);
      this.lightService.updateCharacteristic(this.platform.Characteristic.Saturation, saturation);
    }

    if (this.baySwitchService) {
      this.baySwitchService.updateCharacteristic(this.platform.Characteristic.On, this.selectedBay === 2);
    }
  }

  /**
   * Handle "SET" requests from HomeKit for On/Off
   */
  async setOn(value: CharacteristicValue) {
    const isOn = Boolean(value);
    this.platform.log.debug(`Set Characteristic On for ${this.accessory.displayName} ->`, value);

    try {
      if (isOn) {
        const intensity = this.lastKnownIntensity || 60;
        const success = await this.setSelectedBayIntensity(intensity);
        
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
    return isOn;
  }

  async setRotationSpeed(value: CharacteristicValue) {
    const intensity = Math.max(0, Math.min(100, Number(value) || 0));
    this.platform.log.debug(`Set Characteristic RotationSpeed for ${this.accessory.displayName} ->`, intensity);
    this.lastKnownIntensity = intensity;
    this.accessory.context.lastKnownIntensity = intensity;
    if (intensity === 0) {
      await this.puraApi.stopAll(this.device.id);
      this.currentState.On = false;
      this.fanService.updateCharacteristic(this.platform.Characteristic.On, false);
      return;
    }
    const success = await this.setSelectedBayIntensity(intensity);
    if (!success) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getRotationSpeed(): Promise<CharacteristicValue> {
    return this.lastKnownIntensity;
  }

  /**
   * Update device data and refresh state
   */
  updateDevice(device: PuraDevice) {
    this.device = device;
    this.accessory.context.device = device;
    this.updateCurrentState();
  }

  private async setSelectedBayIntensity(intensity: number): Promise<boolean> {
    await this.puraApi.stopAll(this.device.id);
    const bay = this.selectedBay === 2 && this.device.bay2 ? 2 : 1;
    return this.puraApi.setIntensity(this.device.id, bay, intensity);
  }

  async setBaySwitch(value: CharacteristicValue) {
    this.selectedBay = Boolean(value) && this.device.bay2 ? 2 : 1;
    this.accessory.context.selectedBay = this.selectedBay;
    if (this.currentState.On) {
      await this.setSelectedBayIntensity(this.lastKnownIntensity || 60);
    }
  }

  async getBaySwitch(): Promise<CharacteristicValue> {
    return this.selectedBay === 2;
  }

  async setNightlight(value: CharacteristicValue) {
    const isOn = Boolean(value);
    const brightness = this.device.nightlight?.brightness ?? this.accessory.context.nightlightBrightness ?? 10;
    const color = this.device.nightlight?.color ?? '#ffffff';
    const controller = this.device.controller ?? 'default';
    const success = await this.puraApi.setNightlight(this.device.id, isOn, brightness, color, controller);
    if (!success) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getNightlight(): Promise<CharacteristicValue> {
    return Boolean(this.device.nightlight?.active);
  }

  async setNightlightBrightness(value: CharacteristicValue) {
    const brightness = Math.max(0, Math.min(100, Number(value) || 0));
    this.accessory.context.nightlightBrightness = brightness;
    this.device.nightlight = {
      ...(this.device.nightlight ?? { color: '#ffffff', active: true }),
      brightness,
    };
    await this.setNightlight(Boolean(this.device.nightlight.active));
  }

  async getNightlightBrightness(): Promise<CharacteristicValue> {
    return this.device.nightlight?.brightness ?? this.accessory.context.nightlightBrightness ?? 10;
  }

  async setNightlightHue(value: CharacteristicValue) {
    const hue = Math.max(0, Math.min(360, Number(value) || 0));
    const saturation = this.accessory.context.nightlightSaturation ?? 0;
    const color = this.hsvToHex(hue, saturation);
    this.accessory.context.nightlightHue = hue;
    this.device.nightlight = {
      ...(this.device.nightlight ?? { brightness: 10, active: true }),
      color,
    };
    await this.setNightlight(Boolean(this.device.nightlight.active));
  }

  async getNightlightHue(): Promise<CharacteristicValue> {
    return this.accessory.context.nightlightHue ?? this.hexToHsv(this.device.nightlight?.color ?? '#ffffff').hue;
  }

  async setNightlightSaturation(value: CharacteristicValue) {
    const saturation = Math.max(0, Math.min(100, Number(value) || 0));
    const hue = this.accessory.context.nightlightHue ?? 0;
    const color = this.hsvToHex(hue, saturation);
    this.accessory.context.nightlightSaturation = saturation;
    this.device.nightlight = {
      ...(this.device.nightlight ?? { brightness: 10, active: true }),
      color,
    };
    await this.setNightlight(Boolean(this.device.nightlight.active));
  }

  async getNightlightSaturation(): Promise<CharacteristicValue> {
    return this.accessory.context.nightlightSaturation ??
      this.hexToHsv(this.device.nightlight?.color ?? '#ffffff').saturation;
  }

  private hsvToHex(h: number, s: number): string {
    const saturation = Math.max(0, Math.min(100, s)) / 100;
    const value = 1;
    const c = value * saturation;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = value - c;
    let r = 0;
    let g = 0;
    let b = 0;
    if (h < 60) {
      r = c; g = x; b = 0;
    } else if (h < 120) {
      r = x; g = c; b = 0;
    } else if (h < 180) {
      r = 0; g = c; b = x;
    } else if (h < 240) {
      r = 0; g = x; b = c;
    } else if (h < 300) {
      r = x; g = 0; b = c;
    } else {
      r = c; g = 0; b = x;
    }
    const toHex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  private hexToHsv(hex: string): { hue: number; saturation: number } {
    const normalized = hex.replace('#', '');
    const r = parseInt(normalized.slice(0, 2), 16) / 255;
    const g = parseInt(normalized.slice(2, 4), 16) / 255;
    const b = parseInt(normalized.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;
    if (delta !== 0) {
      if (max === r) {
        hue = 60 * (((g - b) / delta) % 6);
      } else if (max === g) {
        hue = 60 * ((b - r) / delta + 2);
      } else {
        hue = 60 * ((r - g) / delta + 4);
      }
    }
    if (hue < 0) {
      hue += 360;
    }
    const saturation = max === 0 ? 0 : (delta / max) * 100;
    return { hue, saturation };
  }

}
