import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PuraPlatform } from './platform.js';
import { PuraApi } from './puraApi.js';
import type { PuraDevice } from './puraTypes.js';

export class PuraNightlightAccessory {
  private service: Service;
  private device: PuraDevice;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly platform: PuraPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly puraApi: PuraApi,
  ) {
    this.device = accessory.context.device as PuraDevice;

    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    const safeModel = this.device.type && this.device.type.length > 1 ? this.device.type : 'Pura Diffuser';
    infoService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Pura')
      .setCharacteristic(this.platform.Characteristic.Model, `${safeModel} Nightlight`)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `${this.device.id}-nightlight`);

    // Ensure this accessory only exposes Lightbulb.
    const fanService = this.accessory.getService(this.platform.Service.Fanv2);
    const switchService = this.accessory.getService(this.platform.Service.Switch);
    if (fanService) {
      this.accessory.removeService(fanService);
    }
    if (switchService) {
      this.accessory.removeService(switchService);
    }

    this.service = this.accessory.getService(this.platform.Service.Lightbulb) ||
      this.accessory.addService(this.platform.Service.Lightbulb);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setNightlightOn.bind(this))
      .onGet(this.getNightlightOn.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .setProps({ minStep: 10 })
      .onSet(this.setNightlightBrightness.bind(this))
      .onGet(this.getNightlightBrightness.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.Hue)
      .onSet(this.setNightlightHue.bind(this))
      .onGet(this.getNightlightHue.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.Saturation)
      .onSet(this.setNightlightSaturation.bind(this))
      .onGet(this.getNightlightSaturation.bind(this));

    this.applyNightlightState();
  }

  updateDevice(device: PuraDevice) {
    this.device = device;
    this.accessory.context.device = device;
    this.applyNightlightState();
  }

  private isDeviceOffline(): boolean {
    return this.device.online === false;
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

  private normalizeNightlightLevel(level: unknown): number | undefined {
    const numeric = Number(level);
    if (!Number.isFinite(numeric)) {
      return undefined;
    }
    return Math.max(1, Math.min(10, Math.round(numeric)));
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

  private normalizeNightlightColor(color: unknown): string {
    if (typeof color !== 'string') {
      return 'ffffff';
    }
    const normalized = color.replace('#', '').trim().toLowerCase();
    return /^[0-9a-f]{6}$/.test(normalized) ? normalized : 'ffffff';
  }

  private hexToHsv(hexColor: string): { h: number; s: number; v: number } {
    const hex = this.normalizeNightlightColor(hexColor);
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0;

    if (delta !== 0) {
      switch (max) {
      case r:
        h = ((g - b) / delta) % 6;
        break;
      case g:
        h = (b - r) / delta + 2;
        break;
      default:
        h = (r - g) / delta + 4;
      }
      h *= 60;
      if (h < 0) {
        h += 360;
      }
    }

    const s = max === 0 ? 0 : (delta / max) * 100;
    const v = max * 100;
    return { h: Math.round(h), s: Math.round(s), v: Math.round(v) };
  }

  private hsvToHex(h: number, s: number, v = 100): string {
    const hue = ((h % 360) + 360) % 360;
    const sat = Math.max(0, Math.min(100, s)) / 100;
    const val = Math.max(0, Math.min(100, v)) / 100;

    const c = val * sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = val - c;

    let r: number;
    let g: number;
    let b: number;

    if (hue < 60) {
      r = c; g = x; b = 0;
    } else if (hue < 120) {
      r = x; g = c; b = 0;
    } else if (hue < 180) {
      r = 0; g = c; b = x;
    } else if (hue < 240) {
      r = 0; g = x; b = c;
    } else if (hue < 300) {
      r = x; g = 0; b = c;
    } else {
      r = c; g = 0; b = x;
    }

    const toHex = (value: number) => Math.round((value + m) * 255).toString(16).padStart(2, '0');
    return `${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  private applyNightlightState() {
    const isOn = Boolean(this.device.nightlight?.active);
    const brightness = isOn ? this.nightlightLevelToPercent(this.device.nightlight?.brightness) : 0;
    const color = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
    const hsv = this.hexToHsv(color);

    this.service.updateCharacteristic(this.platform.Characteristic.On, isOn);
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
    this.service.updateCharacteristic(this.platform.Characteristic.Hue, hsv.h);
    this.service.updateCharacteristic(this.platform.Characteristic.Saturation, hsv.s);
  }

  private async enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(async () => task());
    this.writeQueue = next.catch(() => undefined);
    await next;
  }

  async setNightlightOn(value: CharacteristicValue) {
    if (!this.supportsNightlightControl()) {
      return;
    }
    if (this.isDeviceOffline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    await this.enqueueWrite(async () => {
      this.platform.recordNightlightInteraction(this.device.id);
      const active = Boolean(value);
      const brightnessPercent = this.nightlightLevelToPercent(this.device.nightlight?.brightness ?? 10);
      const sentLevel = this.percentToNightlightLevel(brightnessPercent);
      const color = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
      const currentActive = Boolean(this.device.nightlight?.active);
      const currentLevel = this.normalizeNightlightLevel(this.device.nightlight?.brightness) ?? sentLevel;
      const currentColor = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
      if (currentActive === active && currentLevel === sentLevel && currentColor === color) {
        if (this.platform.isDebugEnabled()) {
          this.platform.log.debug(
            `[Nightlight] Skipping redundant On write for ${this.accessory.displayName} -> ${active} ` +
            `(level=${sentLevel}, color=${color}).`,
          );
        }
        this.applyNightlightState();
        return;
      }
      const success = await this.puraApi.setNightlight(
        this.device.id,
        active,
        brightnessPercent,
        color,
        this.device.controller || 'default',
      );
      if (!success) {
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      this.device.nightlight = { active, brightness: sentLevel, color };
      this.applyNightlightState();
    });
  }

  async getNightlightOn(): Promise<CharacteristicValue> {
    if (this.isDeviceOffline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return Boolean(this.device.nightlight?.active);
  }

  async setNightlightBrightness(value: CharacteristicValue) {
    if (!this.supportsNightlightControl()) {
      return;
    }
    if (this.isDeviceOffline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    await this.enqueueWrite(async () => {
      this.platform.recordNightlightInteraction(this.device.id);
      const brightnessPercent = Math.max(0, Math.min(100, Number(value) || 0));
      const turningOff = brightnessPercent <= 0;
      const level = turningOff ? (this.normalizeNightlightLevel(this.device.nightlight?.brightness) ?? 1)
        : this.percentToNightlightLevel(brightnessPercent);
      const active = !turningOff;
      const apiPercent = this.nightlightLevelToPercent(level);
      const color = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
      const currentActive = Boolean(this.device.nightlight?.active);
      const currentLevel = this.normalizeNightlightLevel(this.device.nightlight?.brightness) ?? level;
      const currentColor = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
      if (currentActive === active && currentLevel === level && currentColor === color) {
        if (this.platform.isDebugEnabled()) {
          this.platform.log.debug(
            `[Nightlight] Skipping redundant Brightness write for ${this.accessory.displayName} -> ${apiPercent}% ` +
            `(level=${level}, active=${active}).`,
          );
        }
        this.applyNightlightState();
        return;
      }
      const success = await this.puraApi.setNightlight(
        this.device.id,
        active,
        apiPercent,
        color,
        this.device.controller || 'default',
      );
      if (!success) {
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      this.device.nightlight = { active, brightness: level, color };
      this.applyNightlightState();
    });
  }

  async getNightlightBrightness(): Promise<CharacteristicValue> {
    if (this.isDeviceOffline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return this.device.nightlight?.active === true
      ? this.nightlightLevelToPercent(this.device.nightlight?.brightness)
      : 0;
  }

  async setNightlightHue(value: CharacteristicValue) {
    if (!this.supportsNightlightControl()) {
      return;
    }
    if (this.isDeviceOffline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    await this.enqueueWrite(async () => {
      this.platform.recordNightlightInteraction(this.device.id);
      const hue = Math.max(0, Math.min(360, Number(value) || 0));
      const current = this.hexToHsv(this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff'));
      const nextColor = this.hsvToHex(hue, current.s);
      await this.setNightlightColor(nextColor);
    });
  }

  async getNightlightHue(): Promise<CharacteristicValue> {
    if (this.isDeviceOffline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    const hsv = this.hexToHsv(this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff'));
    return hsv.h;
  }

  async setNightlightSaturation(value: CharacteristicValue) {
    if (!this.supportsNightlightControl()) {
      return;
    }
    if (this.isDeviceOffline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    await this.enqueueWrite(async () => {
      this.platform.recordNightlightInteraction(this.device.id);
      const saturation = Math.max(0, Math.min(100, Number(value) || 0));
      const current = this.hexToHsv(this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff'));
      const nextColor = this.hsvToHex(current.h, saturation);
      await this.setNightlightColor(nextColor);
    });
  }

  async getNightlightSaturation(): Promise<CharacteristicValue> {
    if (this.isDeviceOffline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    const hsv = this.hexToHsv(this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff'));
    return hsv.s;
  }

  private async setNightlightColor(color: string) {
    const normalizedColor = this.normalizeNightlightColor(color);
    const level = this.normalizeNightlightLevel(this.device.nightlight?.brightness) ?? 10;
    const active = true;
    const currentActive = Boolean(this.device.nightlight?.active);
    const currentLevel = this.normalizeNightlightLevel(this.device.nightlight?.brightness) ?? level;
    const currentColor = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
    if (currentActive === active && currentLevel === level && currentColor === normalizedColor) {
      if (this.platform.isDebugEnabled()) {
        this.platform.log.debug(
          `[Nightlight] Skipping redundant Color write for ${this.accessory.displayName} -> ${normalizedColor}.`,
        );
      }
      this.applyNightlightState();
      return;
    }
    const success = await this.puraApi.setNightlight(
      this.device.id,
      active,
      this.nightlightLevelToPercent(level),
      normalizedColor,
      this.device.controller || 'default',
    );
    if (!success) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.device.nightlight = { active, brightness: level, color: normalizedColor };
    this.applyNightlightState();
  }
}
