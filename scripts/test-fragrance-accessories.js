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

import {
  PuraFragranceAccessory,
  PuraFragranceController,
  resolveFragranceIntensity,
  snapFragranceIntensity,
} from '../dist/fragranceAccessory.js';
import {
  mapHomeKitIntensityToPuraLevel,
  mapPuraNumericIntensityToHomeKit,
  PuraApi,
} from '../dist/puraApi.js';
import { buildTimerRealtimeDeviceUpdate, resolveRefreshBaseIntervalSeconds } from '../dist/platform.js';

const saltId = '28642bae-45e2-4801-a52b-5e44c61ffa6f';
const vetiverId = '702e183c-2a16-4dd1-86ad-656088700c49';
const deviceId = 'pura-plus-test';

assert.equal(resolveRefreshBaseIntervalSeconds(false, false), 15);
assert.equal(resolveRefreshBaseIntervalSeconds(false, true), 15);
assert.equal(resolveRefreshBaseIntervalSeconds(true, false), 300);
assert.equal(resolveRefreshBaseIntervalSeconds(true, true), 15);

assert.deepEqual(
  Array.from({ length: 10 }, (_, index) => mapPuraNumericIntensityToHomeKit(index + 1)),
  [20, 40, 40, 60, 60, 80, 80, 100, 100, 100],
);
assert.deepEqual(
  [20, 40, 60, 80, 100].map(mapHomeKitIntensityToPuraLevel),
  [1, 3, 5, 7, 10],
);
assert.equal(snapFragranceIntensity(30), 40, 'legacy Subtle values migrate to native button 2');
assert.equal(snapFragranceIntensity(50), 60, 'legacy Medium values migrate to native button 3');
assert.equal(resolveFragranceIntensity(undefined, 30, 20), 20, 'compatible exact Subtle must survive coarse REST');
assert.equal(resolveFragranceIntensity(undefined, 30, 40), 40, 'compatible exact Subtle must survive coarse REST');
assert.equal(resolveFragranceIntensity(undefined, 50, 80), 80, 'compatible exact Medium must survive coarse REST');
assert.equal(resolveFragranceIntensity(undefined, 100, 80), 100, 'a changed broad group must replace remembered state');
assert.equal(resolveFragranceIntensity(60, 50, 80), 60, 'exact realtime must replace remembered state');

assert.deepEqual(buildTimerRealtimeDeviceUpdate({ bay: 1, intensity: 7, start: 1234 }), {
  controller: 'timer',
  deviceActiveState: { activeBay: 1, activeBayIntensity: 7 },
  bay1: { activeAt: 1234, timer: { bay: 1, intensity: 7, start: 1234 } },
});
assert.equal(buildTimerRealtimeDeviceUpdate({ bay: 3, intensity: 7 }), undefined);

const apiLog = { info() {}, debug() {}, warn() {}, error() {} };
const realApi = new PuraApi(apiLog);
const intensityRequests = [];
realApi.makeRequest = async (method, endpoint, body) => {
  intensityRequests.push({ method, endpoint, body });
  return { success: true };
};
for (const intensity of [20, 40, 60, 80, 100]) {
  assert.equal(await realApi.setIntensity(deviceId, 1, intensity, 'test'), true);
}
assert.deepEqual(
  intensityRequests.map((request) => request.body.intensity),
  [1, 3, 5, 7, 10],
  'production intensity writes must use Pura numeric levels',
);

const now = Math.floor(Date.now() / 1000);
for (const [rawIntensity, expectedCoarse, expectedExact] of [
  [1, 30, 20],
  [2, 30, 40],
  [3, 30, 40],
  [4, 50, 60],
  [5, 50, 60],
  [6, 50, 80],
  [7, 50, 80],
  [8, 100, 100],
  [9, 100, 100],
  [10, 100, 100],
]) {
  const normalized = realApi.normalizeDeviceRecord({
    id: deviceId,
    model: 3,
    deviceVer: 'plus_1',
    diffusionMode: 'standard',
    connected: true,
    bay1: { id: 1, activeAt: now },
    deviceDefaults: { bay1Intensity: rawIntensity },
    deviceActiveState: { activeBay: 1, activeBayIntensity: rawIntensity },
  });
  assert.equal(normalized.bay1.intensity, expectedCoarse);
  assert.equal(normalized.bay1.exactIntensity, expectedExact);
}
const coarseOnly = realApi.normalizeDeviceRecord({
  id: deviceId,
  model: 3,
  deviceVer: 'plus_1',
  diffusionMode: 'standard',
  connected: true,
  bay1: { id: 1, activeAt: now },
  deviceDefaults: { bay1Intensity: 'medium' },
});
assert.equal(coarseOnly.bay1.intensity, 50);
assert.equal(coarseOnly.bay1.exactIntensity, undefined, 'coarse REST labels must not claim exact state');

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

assert.equal(salt.accessory.context.rememberedIntensity, 40, 'legacy remembered Subtle must migrate');
assert.equal(vetiver.accessory.context.rememberedIntensity, 60, 'legacy remembered Medium must migrate');
assert.equal(
  salt.accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.RotationSpeed).value,
  40,
);
assert.equal(
  salt.accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.RotationSpeed).props.minStep,
  20,
);

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
assert.deepEqual(calls.slice(-2), [['select', 2], ['intensity', 2, 60]]);
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

controller.updateDevice({
  ...makeDevice({ swapped: true }),
  bay2: { ...makeDevice({ swapped: true }).bay2, active: true, intensity: 30, exactIntensity: 20 },
});
assert.equal(salt.accessory.context.rememberedIntensity, 20, 'exact realtime must update remembered intensity');
controller.updateDevice({
  ...makeDevice({ swapped: true }),
  bay2: { ...makeDevice({ swapped: true }).bay2, active: true, intensity: 30 },
});
assert.equal(salt.accessory.context.rememberedIntensity, 20, 'coarse REST must retain compatible exact intensity');
controller.updateDevice({
  ...makeDevice({ swapped: true }),
  bay2: { ...makeDevice({ swapped: true }).bay2, active: true, intensity: 50 },
});
assert.equal(salt.accessory.context.rememberedIntensity, 20, 'fresh exact intensity must survive a conflicting coarse refresh');
controller.updateDevice({
  ...makeDevice({ swapped: true }),
  bay2: { ...makeDevice({ swapped: true }).bay2, active: true, intensity: 50, exactIntensity: 80 },
});
assert.equal(salt.accessory.context.rememberedIntensity, 80, 'a newer exact realtime value must replace the hold');

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
