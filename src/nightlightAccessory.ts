import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PuraPlatform } from './platform.js';
import { PuraApi } from './puraApi.js';
import type { PuraDevice } from './puraTypes.js';

export class PuraNightlightAccessory {
  private service: Service;
  private device: PuraDevice;
  private writeQueue: Promise<void> = Promise.resolve();
  private pendingNightlightIntent?: {
    at: number;
    ttlMs: number;
    active: boolean;
    level: number;
    color: string;
  };
  private recentNightlightHold?: { until: number; level: number };
  private lastNightlightApiWrite?: {
    at: number;
    active: boolean;
    level: number;
    color: string;
    reason: 'on' | 'brightness' | 'color';
  };
  private lastNightlightLog?: { at: number; active: boolean; level: number };
  private pendingNightlightLog?: { at: number; kind: 'on' | 'brightness'; brightnessPercent: number };
  private pendingNightlightLogTimer?: ReturnType<typeof setTimeout>;
  private lastDiffuserActive = false;
  private lastDiffuserOnAt?: number;

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

    this.lastDiffuserActive = this.isDiffuserActive(this.device);
    this.applyNightlightState();
  }

  updateDevice(device: PuraDevice) {
    const previousNightlight = this.device.nightlight;
    const incomingDiffuserActive = this.isDiffuserActive(device);
    if (incomingDiffuserActive && !this.lastDiffuserActive) {
      this.lastDiffuserOnAt = Date.now();
    }
    if (!incomingDiffuserActive && this.lastDiffuserActive) {
      const recentNightlightInteraction = this.platform.getRecentNightlightInteraction(this.device.id);
      // When the diffuser turns off, cloud nightlight OFF should win unless HomeKit just issued
      // a direct nightlight command for this same device.
      if (!recentNightlightInteraction) {
        this.pendingNightlightIntent = undefined;
        this.recentNightlightHold = undefined;
      }
    }
    const stabilized = this.clampNightlightDuringHold(this.stabilizeNightlightDuringIntentWindow(device));
    this.device = stabilized;
    this.lastDiffuserActive = this.isDiffuserActive(stabilized);
    this.accessory.context.device = stabilized;
    const previousNightlightActive = Boolean(previousNightlight?.active);
    const nextNightlightActive = Boolean(stabilized.nightlight?.active);
    if (previousNightlightActive !== nextNightlightActive) {
      if (nextNightlightActive) {
        this.queueNightlightLog('on', this.nightlightLevelToPercent(stabilized.nightlight?.brightness));
      } else {
        this.emitNightlightOffLog();
      }
    }
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
      const currentActive = Boolean(this.device.nightlight?.active);
      const characteristicBrightnessValue = Number(
        this.service.getCharacteristic(this.platform.Characteristic.Brightness).value,
      );
      const characteristicBrightnessPercent = Number.isFinite(characteristicBrightnessValue)
        ? Math.max(0, Math.min(100, Math.round(characteristicBrightnessValue)))
        : 0;
      const storedBrightnessPercent = this.nightlightLevelToPercent(this.device.nightlight?.brightness ?? 10);
      const brightnessPercent = active && !currentActive
        ? (characteristicBrightnessPercent > 0 ? characteristicBrightnessPercent : 100)
        : storedBrightnessPercent;
      const sentLevel = this.percentToNightlightLevel(brightnessPercent);
      const color = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
      const currentLevel = this.normalizeNightlightLevel(this.device.nightlight?.brightness) ?? sentLevel;
      const currentColor = this.normalizeNightlightColor(this.device.nightlight?.color ?? 'ffffff');
      if (currentActive === active && currentLevel === sentLevel && currentColor === color) {
        if (this.platform.isDebugEnabled()) {
          this.platform.log.debug(
            `[Nightlight] Skipping redundant On write for ${this.accessory.displayName} -> ${active} ` +
            `(level=${sentLevel}, color=${color}).`,
          );
        }
        this.pendingNightlightIntent = {
          at: Date.now(),
          ttlMs: active ? 20000 : 15000,
          active,
          level: sentLevel,
          color,
        };
        this.recentNightlightHold = active ? { until: Date.now() + 20000, level: sentLevel } : undefined;
        if (currentActive !== active) {
          if (active) {
            this.queueNightlightLog('on', brightnessPercent);
          } else {
            this.emitNightlightOffLog();
          }
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
      this.recentNightlightHold = active ? { until: Date.now() + 20000, level: sentLevel } : undefined;
      this.pendingNightlightIntent = {
        at: Date.now(),
        ttlMs: active ? 20000 : 15000,
        active,
        level: sentLevel,
        color,
      };
      this.lastNightlightApiWrite = { at: Date.now(), active, level: sentLevel, color, reason: 'on' };
      if (currentActive !== active) {
        if (active) {
          this.queueNightlightLog('on', brightnessPercent);
        } else {
          this.emitNightlightOffLog();
        }
      }
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
        this.pendingNightlightIntent = {
          at: Date.now(),
          ttlMs: active ? 20000 : 15000,
          active,
          level,
          color,
        };
        this.recentNightlightHold = active ? { until: Date.now() + 20000, level } : undefined;
        if (currentActive !== active) {
          if (active) {
            this.queueNightlightLog('on', apiPercent);
          } else {
            this.emitNightlightOffLog();
          }
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
      this.recentNightlightHold = active ? { until: Date.now() + 20000, level } : undefined;
      this.pendingNightlightIntent = {
        at: Date.now(),
        ttlMs: active ? 20000 : 15000,
        active,
        level,
        color,
      };
      this.lastNightlightApiWrite = { at: Date.now(), active, level, color, reason: 'brightness' };
      if (!active) {
        this.emitNightlightOffLog();
      } else if (!currentActive) {
        this.queueNightlightLog('on', apiPercent);
      } else {
        this.queueNightlightLog('brightness', apiPercent);
      }
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
    this.recentNightlightHold = active ? { until: Date.now() + 20000, level } : undefined;
    this.pendingNightlightIntent = {
      at: Date.now(),
      ttlMs: 20000,
      active,
      level,
      color: normalizedColor,
    };
    this.lastNightlightApiWrite = { at: Date.now(), active, level, color: normalizedColor, reason: 'color' };
    if (!currentActive) {
      // A color write also implicitly turns the light on; treat this as a turn-on event.
      this.queueNightlightLog('on', this.nightlightLevelToPercent(level));
    }
    this.applyNightlightState();
  }

  private stabilizeNightlightDuringIntentWindow(device: PuraDevice): PuraDevice {
    if (!this.pendingNightlightIntent) {
      return device;
    }
    const ageMs = Date.now() - this.pendingNightlightIntent.at;
    if (ageMs > this.pendingNightlightIntent.ttlMs) {
      this.pendingNightlightIntent = undefined;
      return device;
    }
    if (!device.nightlight) {
      return device;
    }
    const intent = this.pendingNightlightIntent;
    const incomingLevel = this.normalizeNightlightLevel(device.nightlight.brightness);
    const incomingActive = Boolean(device.nightlight.active);
    const incomingColor = this.normalizeNightlightColor(device.nightlight.color);
    const sinceDiffuserOnMs = this.lastDiffuserOnAt !== undefined
      ? Date.now() - this.lastDiffuserOnAt
      : undefined;
    const recentNightlightInteraction = this.platform.getRecentNightlightInteraction(this.device.id);
    // Pending intent should only dominate for a short window unless we are still handling
    // a direct nightlight interaction. Keep ON intents longer to prevent brief OFF flicker
    // from delayed cloud snapshots, while expiring OFF intents quickly.
    const passiveIntentMaxAgeMs = intent.active ? 9000 : 3500;
    if (!recentNightlightInteraction && ageMs > passiveIntentMaxAgeMs) {
      this.pendingNightlightIntent = undefined;
      return device;
    }
    const inDiffuserStartupWindow = sinceDiffuserOnMs !== undefined
      && sinceDiffuserOnMs >= 0
      && sinceDiffuserOnMs <= 6000;
    const incomingDiffuserActive = this.isDiffuserActive(device);
    // Diffuser startup can legitimately flip the nightlight ON without a HomeKit nightlight command.
    // If cloud reports ON shortly after startup, prefer cloud truth over stale local OFF intent.
    if (!intent.active && incomingActive && inDiffuserStartupWindow && !recentNightlightInteraction) {
      if (this.platform.isDebugEnabled()) {
        this.platform.log.debug(
          `[Nightlight] Accepting cloud ON snapshot for ${this.accessory.displayName} ` +
          `(clearing stale OFF intent, sinceDiffuserOnMs=${sinceDiffuserOnMs}, ageMs=${ageMs}).`,
        );
      }
      this.pendingNightlightIntent = undefined;
      return device;
    }
    // If diffuser is off and cloud reports nightlight OFF, prefer cloud truth over stale ON intent.
    if (intent.active && !incomingActive && !incomingDiffuserActive && !recentNightlightInteraction) {
      if (this.platform.isDebugEnabled()) {
        this.platform.log.debug(
          `[Nightlight] Accepting cloud OFF snapshot for ${this.accessory.displayName} ` +
          `(clearing stale ON intent, ageMs=${ageMs}).`,
        );
      }
      this.pendingNightlightIntent = undefined;
      this.recentNightlightHold = undefined;
      return device;
    }
    const matchesIntent = incomingActive === intent.active
      && incomingLevel === intent.level
      && incomingColor === intent.color;
    if (matchesIntent) {
      return device;
    }
    if (this.platform.isDebugEnabled()) {
      this.platform.log.debug(
        `[Nightlight] Ignoring stale cloud snapshot for ${this.accessory.displayName}: ` +
        `incoming(active=${incomingActive}, level=${incomingLevel ?? 'unknown'}) ` +
        `expected(active=${intent.active}, level=${intent.level}, color=${intent.color}) ageMs=${ageMs}`,
      );
    }
    return {
      ...device,
      nightlight: {
        ...device.nightlight,
        active: intent.active,
        brightness: intent.level,
        color: intent.color,
      },
    };
  }

  private clampNightlightDuringHold(device: PuraDevice): PuraDevice {
    if (!this.recentNightlightHold) {
      return device;
    }
    const now = Date.now();
    if (now > this.recentNightlightHold.until) {
      this.recentNightlightHold = undefined;
      return device;
    }
    if (!device.nightlight || device.nightlight.active !== true) {
      return device;
    }
    const incomingLevel = this.normalizeNightlightLevel(device.nightlight.brightness) ?? 1;
    if (incomingLevel >= this.recentNightlightHold.level) {
      return device;
    }
    if (this.platform.isDebugEnabled()) {
      this.platform.log.debug(
        `[Nightlight] Clamping brightness for ${this.accessory.displayName} during hold: ` +
        `incoming=${incomingLevel} hold=${this.recentNightlightHold.level}`,
      );
    }
    return {
      ...device,
      nightlight: {
        ...device.nightlight,
        brightness: this.recentNightlightHold.level,
      },
    };
  }

  private isDiffuserActive(device: PuraDevice): boolean {
    const bay1 = device.bay1;
    const bay2 = device.bay2;
    if (!bay1 && !bay2) {
      return false;
    }
    if (bay1?.active || bay2?.active) {
      return true;
    }
    const bay1HasIntensity = Number.isFinite(bay1?.intensity) && Number(bay1?.intensity) > 0;
    const bay2HasIntensity = Number.isFinite(bay2?.intensity) && Number(bay2?.intensity) > 0;
    return bay1HasIntensity || bay2HasIntensity;
  }

  private emitNightlightOffLog() {
    this.cancelPendingNightlightLog();
    this.emitNightlightLog('off', 0);
  }

  private queueNightlightLog(kind: 'on' | 'brightness', brightnessPercent: number) {
    const now = Date.now();
    const existing = this.pendingNightlightLog;
    if (existing) {
      existing.at = now;
      existing.brightnessPercent = brightnessPercent;
      if (kind === 'on') {
        existing.kind = 'on';
      }
    } else {
      this.pendingNightlightLog = { at: now, kind, brightnessPercent };
    }

    // Debounce so rapid HomeKit bursts (On -> Brightness, or multiple Brightness writes) log the final value.
    const debounceMs = 1200;
    if (this.pendingNightlightLogTimer) {
      clearTimeout(this.pendingNightlightLogTimer);
      this.pendingNightlightLogTimer = undefined;
    }
    this.pendingNightlightLogTimer = setTimeout(() => this.flushPendingNightlightLog(), debounceMs);
  }

  private flushPendingNightlightLog() {
    const pending = this.pendingNightlightLog;
    this.pendingNightlightLog = undefined;
    if (this.pendingNightlightLogTimer) {
      clearTimeout(this.pendingNightlightLogTimer);
      this.pendingNightlightLogTimer = undefined;
    }
    if (!pending) {
      return;
    }
    if (pending.kind === 'on') {
      this.emitNightlightLog('on', pending.brightnessPercent);
      return;
    }
    this.emitNightlightLog('brightness', pending.brightnessPercent);
  }

  private cancelPendingNightlightLog() {
    this.pendingNightlightLog = undefined;
    if (this.pendingNightlightLogTimer) {
      clearTimeout(this.pendingNightlightLogTimer);
      this.pendingNightlightLogTimer = undefined;
    }
  }

  private getNightlightLogLabel(): string {
    const name = this.accessory.displayName.trim();
    const hasNightlight = /nightlight/i.test(name);
    const hasDiffuser = /diffuser/i.test(name);
    if (hasNightlight && hasDiffuser) {
      return name;
    }
    if (hasNightlight) {
      return name.replace(/nightlight/i, 'Diffuser Nightlight');
    }
    if (hasDiffuser) {
      return `${name} Nightlight`;
    }
    return `${name} Diffuser Nightlight`;
  }

  private getNightlightOffLogMessage(label: string): string {
    if (this.platform.consumeRecentNightlightAutoOff(this.device.id)) {
      return `${label} automatically turned off (auto-off enabled).`;
    }
    return `${label} turned off.`;
  }

  private emitNightlightLog(kind: 'on' | 'off' | 'brightness', brightnessPercent: number) {
    const now = Date.now();
    const roundedPercent = Math.round(brightnessPercent);
    const last = this.lastNightlightLog;
    const active = kind !== 'off';
    if (last && last.active === active && Math.round(last.level) === roundedPercent) {
      const age = now - last.at;
      if (age < 1500) {
        return;
      }
    }
    this.lastNightlightLog = { at: now, active, level: roundedPercent };

    const label = this.getNightlightLogLabel();
    if (kind === 'on') {
      this.platform.log.info(`${label} turned on (${roundedPercent}% brightness).`);
      return;
    }
    if (kind === 'brightness') {
      this.platform.log.info(`${label} brightness set to ${roundedPercent}%.`);
      return;
    }
    {
      this.platform.log.info(this.getNightlightOffLogMessage(label));
    }
  }
}
