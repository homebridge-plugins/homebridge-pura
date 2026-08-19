import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { PuraPlatform } from './platform.js';
import { PuraApi } from './puraApi.js';
import { PuraBay, PuraDevice } from './puraTypes.js';

export interface FragranceAccessoryContext {
  device: PuraDevice;
  accessoryType: 'fragrance';
  parentDeviceId: string;
  fragranceId: string;
  fragranceName: string;
  rememberedIntensity?: number;
  remainingPercent?: number;
  loggedRemainingPercent?: number;
  lowFragrance?: boolean;
}

type FragranceAccessory = PlatformAccessory & {
  context: FragranceAccessoryContext;
};

/**
 * Shared command/state backend for all fragrance accessories belonging to one
 * physical diffuser. This is deliberately device-scoped: HomeKit accessories
 * remain fragrance-scoped, while writes to the one physical diffuser cannot
 * race each other.
 */
export class PuraFragranceController {
  private device: PuraDevice;
  private readonly handlers = new Map<string, PuraFragranceAccessory>();
  private writeQueue: Promise<void> = Promise.resolve();
  private selectionHold?: { fragranceId: string; intensity: number; until: number };

  constructor(
    private readonly platform: PuraPlatform,
    private readonly puraApi: PuraApi,
    device: PuraDevice,
  ) {
    this.device = device;
  }

  attach(handler: PuraFragranceAccessory) {
    this.handlers.set(handler.fragranceId, handler);
    handler.updateDevice(this.device);
  }

  detach(fragranceId: string) {
    this.handlers.delete(fragranceId);
  }

  updateDevice(device: PuraDevice) {
    this.device = this.stabilizeDuringSelection(device);
    for (const handler of this.handlers.values()) {
      handler.updateDevice(this.device);
    }
  }

  getDevice(): PuraDevice {
    return this.device;
  }

  getBay(fragranceId: string): { number: 1 | 2; bay: PuraBay } | undefined {
    if (this.device.bay1?.fragrance?.id === fragranceId) {
      return { number: 1, bay: this.device.bay1 };
    }
    if (this.device.bay2?.fragrance?.id === fragranceId) {
      return { number: 2, bay: this.device.bay2 };
    }
    return undefined;
  }

  isUnavailable(): boolean {
    return this.device.online === false;
  }

  enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.writeQueue.then(operation, operation);
    this.writeQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async activate(fragranceId: string, intensity: number): Promise<void> {
    const match = this.getBay(fragranceId);
    if (!match || this.isUnavailable()) {
      this.publish();
      throw this.communicationError();
    }

    const normalizedIntensity = this.clampIntensity(intensity);
    this.platform.recordIntent(this.device.id, true);
    if (this.shouldResetAwayMode()) {
      await this.puraApi.setAwayMode(this.device.id, false);
    }
    const selected = await this.puraApi.setAlwaysOn(this.device.id, match.number);
    const adjusted = selected && await this.puraApi.setIntensity(
      this.device.id,
      match.number,
      normalizedIntensity,
      this.device.controller || 'default',
    );
    if (!adjusted) {
      this.publish();
      throw this.communicationError();
    }

    this.device = {
      ...this.device,
      bay1: this.device.bay1
        ? {
          ...this.device.bay1,
          active: match.number === 1,
          intensity: match.number === 1 ? normalizedIntensity : 0,
        }
        : undefined,
      bay2: this.device.bay2
        ? {
          ...this.device.bay2,
          active: match.number === 2,
          intensity: match.number === 2 ? normalizedIntensity : 0,
        }
        : undefined,
    };
    this.selectionHold = {
      fragranceId,
      intensity: normalizedIntensity,
      until: Date.now() + 15000,
    };
    this.handlers.get(fragranceId)?.rememberIntensity(normalizedIntensity);
    this.publish();
    this.platform.requestRefreshSoon(2000);
    this.platform.log.info(
      `${this.device.name || this.device.id} selected fragrance ` +
      `${match.bay.fragrance?.name ?? fragranceId} at intensity ${normalizedIntensity}.`,
    );
  }

  async deactivate(fragranceId: string): Promise<void> {
    const match = this.getBay(fragranceId);
    if (!match || !match.bay.active) {
      this.publish();
      return;
    }
    if (this.isUnavailable()) {
      throw this.communicationError();
    }
    this.platform.recordIntent(this.device.id, false);
    if (!await this.puraApi.stopAll(this.device.id)) {
      this.publish();
      throw this.communicationError();
    }
    this.selectionHold = undefined;
    this.device = {
      ...this.device,
      bay1: this.device.bay1 ? { ...this.device.bay1, active: false, intensity: 0 } : undefined,
      bay2: this.device.bay2 ? { ...this.device.bay2, active: false, intensity: 0 } : undefined,
    };
    this.publish();
    this.platform.requestRefreshSoon(2000);
  }

  private publish() {
    for (const handler of this.handlers.values()) {
      handler.updateDevice(this.device);
    }
  }

  private stabilizeDuringSelection(incoming: PuraDevice): PuraDevice {
    const hold = this.selectionHold;
    if (!hold || hold.until <= Date.now()) {
      this.selectionHold = undefined;
      return incoming;
    }
    const match = incoming.bay1?.fragrance?.id === hold.fragranceId
      ? 1
      : incoming.bay2?.fragrance?.id === hold.fragranceId
        ? 2
        : undefined;
    if (!match) {
      return incoming;
    }
    const selectedBay = match === 1 ? incoming.bay1 : incoming.bay2;
    if (selectedBay?.active && selectedBay.intensity > 0) {
      this.selectionHold = undefined;
      return incoming;
    }
    return {
      ...incoming,
      bay1: incoming.bay1
        ? { ...incoming.bay1, active: match === 1, intensity: match === 1 ? hold.intensity : 0 }
        : undefined,
      bay2: incoming.bay2
        ? { ...incoming.bay2, active: match === 2, intensity: match === 2 ? hold.intensity : 0 }
        : undefined,
    };
  }

  private shouldResetAwayMode(): boolean {
    const raw = this.device.__raw as Record<string, unknown> | undefined;
    const value = raw?.awayMode ?? this.device.awayMode;
    if (typeof value === 'boolean') {
      return value;
    }
    return true;
  }

  private clampIntensity(value: number): number {
    return Math.max(1, Math.min(100, Number(value) || 60));
  }

  private communicationError() {
    return new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  }
}

/** One first-class HomeKit accessory whose identity follows a Pura fragrance ID. */
export class PuraFragranceAccessory {
  private readonly service: Service;
  private readonly batteryService: Service;
  private device: PuraDevice;

  constructor(
    private readonly platform: PuraPlatform,
    private readonly accessory: FragranceAccessory,
    private readonly controller: PuraFragranceController,
  ) {
    this.device = controller.getDevice();
    const context = accessory.context;
    const name = context.fragranceName;
    const info = accessory.getService(this.platform.Service.AccessoryInformation)!;
    info
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Pura')
      .setCharacteristic(this.platform.Characteristic.Model, `${this.device.type || 'Pura'} Fragrance`)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `${context.parentDeviceId}:${context.fragranceId}`);

    this.service = accessory.getService(this.platform.Service.Fanv2)
      || accessory.addService(this.platform.Service.Fanv2, name);
    this.setServiceName(this.service, name);
    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onSet(this.setRotationSpeed.bind(this))
      .onGet(this.getRotationSpeed.bind(this));

    this.batteryService = accessory.getService(this.platform.Service.Battery)
      || accessory.addService(this.platform.Service.Battery, `${name} Remaining`);
    this.setServiceName(this.batteryService, `${name} Remaining`);
    this.batteryService.getCharacteristic(this.platform.Characteristic.BatteryLevel)
      .onGet(this.getRemaining.bind(this));
    this.batteryService.getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .onGet(this.getLowStatus.bind(this));
    this.batteryService.getCharacteristic(this.platform.Characteristic.ChargingState)
      .onGet(() => this.platform.Characteristic.ChargingState.NOT_CHARGEABLE);
    this.service.addLinkedService(this.batteryService);

    this.controller.attach(this);
  }

  get fragranceId(): string {
    return this.accessory.context.fragranceId;
  }

  rememberIntensity(intensity: number) {
    this.accessory.context.rememberedIntensity = this.clampIntensity(intensity);
    this.platform.persistAccessoryIfRegistered(this.accessory);
  }

  updateDevice(device: PuraDevice) {
    this.device = device;
    this.accessory.context.device = device;
    const match = this.controller.getBay(this.fragranceId);
    const installed = Boolean(match);
    const active = Boolean(match?.bay.active);
    if (match?.bay.intensity && match.bay.intensity > 0) {
      this.rememberIntensity(match.bay.intensity);
    }
    if (match?.bay.remainingPercent !== undefined) {
      const remaining = this.clampPercent(match.bay.remainingPercent);
      this.accessory.context.remainingPercent = remaining;
      if (this.accessory.context.loggedRemainingPercent !== remaining) {
        this.accessory.context.loggedRemainingPercent = remaining;
        this.platform.log.info(`${this.accessory.context.fragranceName} remaining: ${remaining}%.`);
      }
    }
    if (match?.bay.lowFragrance !== undefined) {
      this.accessory.context.lowFragrance = match.bay.lowFragrance;
    }
    this.service.updateCharacteristic(
      this.platform.Characteristic.Active,
      active ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE,
    );
    this.service.updateCharacteristic(
      this.platform.Characteristic.RotationSpeed,
      this.mapIntensityToRotation(this.getRememberedIntensity(match?.bay)),
    );
    this.applyFault(this.service, installed);

    const remaining = this.getCachedRemaining();
    if (remaining !== undefined) {
      this.batteryService.updateCharacteristic(this.platform.Characteristic.BatteryLevel, remaining);
    }
    this.batteryService.updateCharacteristic(
      this.platform.Characteristic.StatusLowBattery,
      this.accessory.context.lowFragrance
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    this.batteryService.updateCharacteristic(
      this.platform.Characteristic.ChargingState,
      this.platform.Characteristic.ChargingState.NOT_CHARGEABLE,
    );
    this.applyFault(this.batteryService, installed && remaining !== undefined);
    this.platform.persistAccessoryIfRegistered(this.accessory);
  }

  private async setActive(value: CharacteristicValue) {
    const active = value === this.platform.Characteristic.Active.ACTIVE;
    await this.controller.enqueue(() => active
      ? this.controller.activate(this.fragranceId, this.getRememberedIntensity(this.controller.getBay(this.fragranceId)?.bay))
      : this.controller.deactivate(this.fragranceId));
  }

  private async getActive(): Promise<CharacteristicValue> {
    const match = this.requireInstalledBay();
    return match.active
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  private async setRotationSpeed(value: CharacteristicValue) {
    const intensity = this.mapRotationToIntensity(Number(value));
    if (intensity <= 0) {
      await this.controller.enqueue(() => this.controller.deactivate(this.fragranceId));
      return;
    }
    this.rememberIntensity(intensity);
    await this.controller.enqueue(() => this.controller.activate(this.fragranceId, intensity));
  }

  private async getRotationSpeed(): Promise<CharacteristicValue> {
    const bay = this.requireInstalledBay();
    return this.mapIntensityToRotation(this.getRememberedIntensity(bay));
  }

  private async getRemaining(): Promise<CharacteristicValue> {
    this.requireInstalledBay();
    const remaining = this.getCachedRemaining();
    if (remaining === undefined) {
      throw this.communicationError();
    }
    return remaining;
  }

  private async getLowStatus(): Promise<CharacteristicValue> {
    this.requireInstalledBay();
    return this.accessory.context.lowFragrance
      ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  private requireInstalledBay(): PuraBay {
    const match = this.controller.getBay(this.fragranceId);
    if (!match || this.controller.isUnavailable()) {
      throw this.communicationError();
    }
    return match.bay;
  }

  private getRememberedIntensity(bay?: PuraBay): number {
    const stored = Number(this.accessory.context.rememberedIntensity);
    const reported = Number(bay?.intensity);
    return this.clampIntensity(
      Number.isFinite(stored) && stored > 0
        ? stored
        : Number.isFinite(reported) && reported > 0
          ? reported
          : 60,
    );
  }

  private getCachedRemaining(): number | undefined {
    const value = this.accessory.context.remainingPercent;
    if (value === null || value === undefined) {
      return undefined;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? this.clampPercent(numeric) : undefined;
  }

  private applyFault(service: Service, healthy: boolean) {
    if (service.testCharacteristic(this.platform.Characteristic.StatusFault)) {
      service.updateCharacteristic(
        this.platform.Characteristic.StatusFault,
        healthy && !this.controller.isUnavailable()
          ? this.platform.Characteristic.StatusFault.NO_FAULT
          : this.platform.Characteristic.StatusFault.GENERAL_FAULT,
      );
    }
  }

  private setServiceName(service: Service, name: string) {
    service.displayName = name;
    service.setCharacteristic(this.platform.Characteristic.Name, name);
    service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
    service.setCharacteristic(this.platform.Characteristic.ConfiguredName, name);
  }

  private mapRotationToIntensity(speed: number): number {
    const value = Math.max(0, Math.min(100, Number(speed) || 0));
    if (value <= 0) {
      return 0;
    }
    if (value <= 33) {
      return 30;
    }
    if (value <= 66) {
      return 50;
    }
    return 100;
  }

  private mapIntensityToRotation(intensity: number): number {
    const value = Math.max(0, Math.min(100, Number(intensity) || 0));
    if (value <= 40) {
      return 30;
    }
    if (value <= 75) {
      return 50;
    }
    return 100;
  }

  private clampIntensity(value: number): number {
    return Math.max(1, Math.min(100, Number(value) || 60));
  }

  private clampPercent(value: number): number {
    return Math.max(0, Math.min(100, Number(value)));
  }

  private communicationError() {
    return new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  }
}
