import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PuraPlatform } from './platform.js';
import { PuraApi } from './puraApi.js';
import { PuraDevice } from './puraTypes.js';

/**
 * Nightlight accessory (Lightbulb service).
 */
export class PuraNightlightAccessory {
  private service: Service;
  private device: PuraDevice;

  constructor(
    private readonly platform: PuraPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly puraApi: PuraApi,
  ) {
    this.device = accessory.context.device;

    this.service = this.accessory.getService(this.platform.Service.Lightbulb) ||
      this.accessory.addService(this.platform.Service.Lightbulb);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setNightlight.bind(this))
      .onGet(this.getNightlight.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setNightlightBrightness.bind(this))
      .onGet(this.getNightlightBrightness.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.Hue)
      .onSet(this.setNightlightHue.bind(this))
      .onGet(this.getNightlightHue.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.Saturation)
      .onSet(this.setNightlightSaturation.bind(this))
      .onGet(this.getNightlightSaturation.bind(this));

    this.updateState();
  }

  updateDevice(device: PuraDevice) {
    this.device = device;
    this.accessory.context.device = device;
    this.updateState();
  }

  private updateState() {
    const cachedOn = this.accessory.context.nightlightLastOn;
    const deviceActive = this.device.nightlight?.active;
    const lightOn = typeof cachedOn === 'boolean'
      ? cachedOn
      : (typeof deviceActive === 'boolean' ? deviceActive : false);

    const cachedBrightness = this.accessory.context.nightlightBrightness;
    const deviceBrightness = this.device.nightlight?.brightness;
    const brightness = Number.isFinite(cachedBrightness)
      ? cachedBrightness
      : (Number.isFinite(deviceBrightness) ? deviceBrightness : 10);

    const cachedHue = this.accessory.context.nightlightHue;
    const cachedSaturation = this.accessory.context.nightlightSaturation;
    const deviceColor = this.device.nightlight?.color ?? 'ffffff';
    const { hue, saturation } = this.hexToHsv(deviceColor);

    if (typeof cachedOn !== 'boolean' && typeof deviceActive === 'boolean') {
      this.accessory.context.nightlightLastOn = deviceActive;
    }
    if (!Number.isFinite(cachedBrightness) && Number.isFinite(deviceBrightness)) {
      this.accessory.context.nightlightBrightness = deviceBrightness;
    }
    if (!Number.isFinite(cachedHue)) {
      this.accessory.context.nightlightHue = hue;
    }
    if (!Number.isFinite(cachedSaturation)) {
      this.accessory.context.nightlightSaturation = saturation;
    }

    this.service.updateCharacteristic(this.platform.Characteristic.On, lightOn);
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
    this.service.updateCharacteristic(this.platform.Characteristic.Hue, hue);
    this.service.updateCharacteristic(this.platform.Characteristic.Saturation, saturation);
  }

  async setNightlight(value: CharacteristicValue) {
    const isOn = Boolean(value);
    const brightness = this.accessory.context.nightlightBrightness ?? 10;
    const color = this.device.nightlight?.color ?? 'ffffff';
    const controller = this.device.controller ?? 'default';
    this.device.nightlight = {
      ...(this.device.nightlight ?? { color, brightness }),
      active: isOn,
      brightness,
      color,
    };
    const success = await this.puraApi.setNightlight(this.device.id, isOn, brightness, color, controller);
    if (!success) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.accessory.context.nightlightLastOn = isOn;
    this.service.updateCharacteristic(this.platform.Characteristic.On, isOn);
  }

  async getNightlight(): Promise<CharacteristicValue> {
    if (typeof this.device.nightlight?.active === 'boolean') {
      return this.device.nightlight.active;
    }
    return this.accessory.context.nightlightLastOn ?? false;
  }

  async setNightlightBrightness(value: CharacteristicValue) {
    const brightness = Math.max(0, Math.min(100, Number(value) || 0));
    this.accessory.context.nightlightBrightness = brightness;
    this.accessory.context.nightlightLastOn = true;
    this.device.nightlight = {
      ...(this.device.nightlight ?? { color: 'ffffff', brightness }),
      brightness,
      active: true,
    };
    await this.setNightlight(true);
  }

  async getNightlightBrightness(): Promise<CharacteristicValue> {
    return this.accessory.context.nightlightBrightness ?? 10;
  }

  async setNightlightHue(value: CharacteristicValue) {
    const hue = Math.max(0, Math.min(360, Number(value) || 0));
    this.accessory.context.nightlightHue = hue;
    this.accessory.context.nightlightLastOn = true;
    const saturation = this.accessory.context.nightlightSaturation ?? 0;
    const color = this.hsvToHex(hue, saturation);
    const brightness = this.accessory.context.nightlightBrightness ?? this.device.nightlight?.brightness ?? 10;
    this.device.nightlight = {
      ...(this.device.nightlight ?? { brightness, active: true }),
      brightness,
      color,
    };
    await this.setNightlight(true);
  }

  async getNightlightHue(): Promise<CharacteristicValue> {
    return this.accessory.context.nightlightHue ?? this.hexToHsv(this.device.nightlight?.color ?? 'ffffff').hue;
  }

  async setNightlightSaturation(value: CharacteristicValue) {
    const saturation = Math.max(0, Math.min(100, Number(value) || 0));
    this.accessory.context.nightlightSaturation = saturation;
    this.accessory.context.nightlightLastOn = true;
    const hue = this.accessory.context.nightlightHue ?? 0;
    const color = this.hsvToHex(hue, saturation);
    const brightness = this.accessory.context.nightlightBrightness ?? this.device.nightlight?.brightness ?? 10;
    this.device.nightlight = {
      ...(this.device.nightlight ?? { brightness, active: true }),
      brightness,
      color,
    };
    await this.setNightlight(true);
  }

  async getNightlightSaturation(): Promise<CharacteristicValue> {
    return this.accessory.context.nightlightSaturation ??
      this.hexToHsv(this.device.nightlight?.color ?? 'ffffff').saturation;
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
    return `${toHex(r)}${toHex(g)}${toHex(b)}`;
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
