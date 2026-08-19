import assert from 'node:assert/strict';

import {
  Accessory,
  Categories,
  Characteristic,
  HapStatusError,
  HAPStatus,
  Service,
  uuid,
} from '@homebridge/hap-nodejs';

import { PuraFragranceAccessory, PuraFragranceController } from '../dist/fragranceAccessory.js';

const saltId = '28642bae-45e2-4801-a52b-5e44c61ffa6f';
const vetiverId = '702e183c-2a16-4dd1-86ad-656088700c49';
const deviceId = 'pura-plus-test';

const makeDevice = ({ swapped = false, saltInstalled = true } = {}) => ({
  id: deviceId,
  name: 'Pura Plus',
  type: 'Pura Plus',
  version: '1',
  state: {},
  controller: 'test',
  online: true,
  bay1: swapped
    ? { id: 1, active: false, intensity: 0, fragrance: { id: vetiverId, name: 'White Vetiver' }, remainingPercent: 100 }
    : saltInstalled
      ? { id: 1, active: true, intensity: 30, fragrance: { id: saltId, name: 'Salt' }, remainingPercent: 98 }
      : undefined,
  bay2: swapped
    ? saltInstalled
      ? { id: 2, active: true, intensity: 30, fragrance: { id: saltId, name: 'Salt' }, remainingPercent: 97 }
      : undefined
    : { id: 2, active: false, intensity: 0, fragrance: { id: vetiverId, name: 'White Vetiver' }, remainingPercent: 100 },
});

const calls = [];
const puraApi = {
  async setAwayMode() {
    return true;
  },
  async setAlwaysOn(_deviceId, bay) {
    calls.push(['select', bay]);
    return true;
  },
  async setIntensity(_deviceId, bay, intensity) {
    calls.push(['intensity', bay, intensity]);
    return true;
  },
  async stopAll() {
    calls.push(['stop']);
    return true;
  },
};

const platform = {
  Service,
  Characteristic,
  api: { hap: { HapStatusError, HAPStatus } },
  log: { info() {}, debug() {}, warn() {}, error() {} },
  recordIntent() {},
  requestRefreshSoon() {},
  persistAccessoryIfRegistered() {},
};

const createFragranceAccessory = (controller, fragranceId, fragranceName, remainingPercent, rememberedIntensity) => {
  const accessory = new Accessory(
    fragranceName,
    uuid.generate(`${deviceId}-fragrance-${fragranceId}`),
    Categories.FAN,
  );
  accessory.context = {
    device: controller.getDevice(),
    accessoryType: 'fragrance',
    parentDeviceId: deviceId,
    fragranceId,
    fragranceName,
    remainingPercent,
    rememberedIntensity,
  };
  const handler = new PuraFragranceAccessory(platform, accessory, controller);
  return { accessory, handler };
};

const controller = new PuraFragranceController(platform, puraApi, makeDevice());
const salt = createFragranceAccessory(controller, saltId, 'Salt', 98, 30);
const vetiver = createFragranceAccessory(controller, vetiverId, 'White Vetiver', 100, 50);

assert.notEqual(salt.accessory.UUID, vetiver.accessory.UUID, 'fragrance IDs must produce distinct accessory UUIDs');
assert.equal(
  salt.accessory.getService(Service.Battery).getCharacteristic(Characteristic.BatteryLevel).value,
  98,
);
assert.equal(
  vetiver.accessory.getService(Service.Battery).getCharacteristic(Characteristic.BatteryLevel).value,
  100,
);

await controller.enqueue(() => controller.activate(vetiverId, 50));
assert.deepEqual(calls.slice(-2), [['select', 2], ['intensity', 2, 50]]);
assert.equal(controller.getBay(vetiverId).bay.active, true);
assert.equal(controller.getBay(saltId).bay.active, false);

controller.updateDevice(makeDevice({ swapped: true }));
assert.equal(controller.getBay(saltId).number, 2, 'Salt identity must follow the vial to bay 2');
assert.equal(controller.getBay(vetiverId).number, 1, 'White Vetiver identity must follow the vial to bay 1');
assert.equal(
  salt.accessory.getService(Service.Battery).getCharacteristic(Characteristic.BatteryLevel).value,
  97,
);
assert.equal(
  vetiver.accessory.getService(Service.Battery).getCharacteristic(Characteristic.BatteryLevel).value,
  100,
);

controller.updateDevice(makeDevice({ swapped: true, saltInstalled: false }));
assert.equal(controller.getBay(saltId), undefined, 'removed Salt vial must become unavailable');
assert.equal(controller.getBay(vetiverId).number, 1, 'removing Salt must not corrupt White Vetiver');
assert.equal(
  vetiver.accessory.getService(Service.Battery).getCharacteristic(Characteristic.BatteryLevel).value,
  100,
);

const restarted = new PuraFragranceController(platform, puraApi, makeDevice({ swapped: true }));
const restartedSalt = createFragranceAccessory(restarted, saltId, 'Salt', 97, 30);
const restartedVetiver = createFragranceAccessory(restarted, vetiverId, 'White Vetiver', 100, 50);
assert.equal(restartedSalt.accessory.UUID, salt.accessory.UUID, 'Salt UUID must survive restart');
assert.equal(restartedVetiver.accessory.UUID, vetiver.accessory.UUID, 'White Vetiver UUID must survive restart');
assert.equal(
  restartedSalt.accessory.getService(Service.Battery).getCharacteristic(Characteristic.BatteryLevel).value,
  97,
);
assert.equal(
  restartedVetiver.accessory.getService(Service.Battery).getCharacteristic(Characteristic.BatteryLevel).value,
  100,
);
