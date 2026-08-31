/**
 * Coverage for diffuser state normalisation and realtime timer handling.
 *
 * These are the read-path behaviours that changed independently of any per-bay or per-fragrance
 * control surface: how numeric intensity is scaled, how long a standard-mode session stays active,
 * and how a realtime TIMER event is folded into the cached device record.
 */

import assert from 'node:assert/strict';
import { exit } from 'node:process';

import {
  Accessory,
  Characteristic,
  HapStatusError,
  HAPStatus,
  Service,
  uuid,
} from '@homebridge/hap-nodejs';

import { DEVICE_LIST_ENDPOINTS, mapPuraNumericIntensityToHomeKit, PuraApi } from '../dist/puraApi.js';
import { buildTimerRealtimeDeviceUpdate, PuraPlatform } from '../dist/platform.js';

const silentLog = { info() {}, debug() {}, warn() {}, error() {} };
const api = new PuraApi(silentLog);
const now = Math.floor(Date.now() / 1000);

const normalize = (overrides) => api.normalizeDeviceRecord({
  id: 'dev-1',
  model: 3,
  deviceVer: 'plus_1',
  diffusionMode: 'standard',
  connected: true,
  ...overrides,
});

// --- Numeric intensity is read on Pura's 1-10 scale -----------------------------------------
// Previously every level from 1 to 10 fell into the old `<= 33` branch, so a diffuser running at
// maximum output reported "subtle".
assert.deepEqual(
  Array.from({ length: 10 }, (_, index) => mapPuraNumericIntensityToHomeKit(index + 1)),
  [20, 40, 40, 60, 60, 80, 80, 100, 100, 100],
);
assert.equal(mapPuraNumericIntensityToHomeKit(0), null);
assert.equal(mapPuraNumericIntensityToHomeKit(11), null, 'percentages must not be read as levels');
assert.equal(mapPuraNumericIntensityToHomeKit('nonsense'), null);

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
  const normalized = normalize({
    bay1: { id: 1, activeAt: now },
    deviceDefaults: { bay1Intensity: rawIntensity },
  });
  assert.equal(normalized.bay1.intensity, expectedCoarse, `coarse intensity for level ${rawIntensity}`);
  assert.equal(normalized.bay1.exactIntensity, expectedExact, `exact intensity for level ${rawIntensity}`);
}

// Percentage-scaled payloads keep their previous coarse buckets.
for (const [percent, expectedCoarse] of [[30, 30], [50, 50], [66, 50], [67, 100], [100, 100]]) {
  const normalized = normalize({
    bay1: { id: 1, activeAt: now },
    deviceDefaults: { bay1Intensity: percent },
  });
  assert.equal(normalized.bay1.intensity, expectedCoarse, `coarse intensity for ${percent}%`);
}

// Coarse string labels must not claim an exact position.
const coarseOnly = normalize({
  bay1: { id: 1, activeAt: now },
  deviceDefaults: { bay1Intensity: 'medium' },
});
assert.equal(coarseOnly.bay1.intensity, 50);
assert.equal(coarseOnly.bay1.exactIntensity, undefined);

// --- Standard-mode sessions stay active for their whole run ---------------------------------
// Pura holds activeAt at the session's original start time and clears it to 0 on stop, so a short
// window reported long-running sessions as OFF. The window is widened, not removed.
assert.equal(
  normalize({ bay1: { id: 1, activeAt: now - (22 * 60) }, deviceDefaults: { bay1Intensity: 'subtle' } }).bay1.active,
  true,
  'a 22 minute session must still read as active',
);
assert.equal(
  normalize({ bay1: { id: 1, activeAt: now - (6 * 3600) }, deviceDefaults: { bay1Intensity: 'subtle' } }).bay1.active,
  true,
  'a 6 hour session must still read as active',
);
assert.equal(
  normalize({ bay1: { id: 1, activeAt: now - (36 * 3600) }, deviceDefaults: { bay1Intensity: 'subtle' } }).bay1.active,
  false,
  'a stale activeAt must eventually age out rather than pinning the diffuser on forever',
);
assert.equal(
  normalize({ bay1: { id: 1, activeAt: 0 }, deviceDefaults: { bay1Intensity: 'subtle' } }).bay1.active,
  false,
  'activeAt 0 represents stopped diffusion',
);
assert.equal(
  normalize({ bay1: { id: 1, activeAt: now, active: false }, deviceDefaults: { bay1Intensity: 'subtle' } }).bay1.active,
  false,
  'an explicit active flag always wins over inference',
);

// --- Fragrance remaining is surfaced from the API --------------------------------------------
const withRemaining = normalize({
  bay1: { id: 1, activeAt: now, remaining: { percent: 42 }, lowFragrance: true },
});
assert.equal(withRemaining.bay1.remainingPercent, 42);
assert.equal(withRemaining.bay1.lowFragrance, true);
assert.equal(
  normalize({ bay1: { id: 1, activeAt: now } }).bay1.remainingPercent,
  undefined,
  'a missing remaining block must stay undefined rather than defaulting to 0',
);

// --- Authenticated requests use the ID token ---------------------------------------------------
// Pura's API rejects the access token even when freshly issued; pypura authenticates with the ID
// token for the same reason. Getting this backwards costs three round trips on every single call,
// and the previous code carried a confident comment asserting the opposite - hence the test.
{
  const authApi = new PuraApi(silentLog);
  authApi.session = {
    isValid: () => true,
    getAccessToken: () => ({ getExpiration: () => 0, getJwtToken: () => 'ACCESS_TOKEN' }),
    getIdToken: () => ({ getExpiration: () => 0, getJwtToken: () => 'ID_TOKEN' }),
  };
  assert.equal(authApi.getAuthHeader(), 'Bearer ID_TOKEN', 'requests must default to the ID token');
  assert.equal(authApi.getAuthHeader('access'), 'Bearer ACCESS_TOKEN', 'the access token stays available as a fallback');
}

// --- Device list endpoint order ----------------------------------------------------------------
// pypura moved off v2/users/devices in August 2026 for reliability. v3 is tried first, but the
// older paths stay behind it so a v3 failure degrades rather than losing every accessory.
assert.equal(DEVICE_LIST_ENDPOINTS[0], 'v3/accounts/v2/devices', 'v3 must be tried first');
assert.ok(
  DEVICE_LIST_ENDPOINTS.includes('v2/users/devices'),
  'the previous endpoint must remain as a fallback',
);

// --- Nightlight brightness units ---------------------------------------------------------------
// setNightlight takes a 0-100 percentage and scales it to Pura's 1-10 level. Callers that pass a
// level straight through silently divide the user's brightness by ten, which is what forced
// nightlight-off used to do.
{
  const nightApi = new PuraApi(silentLog);
  const sent = [];
  nightApi.makeRequest = async (_method, _endpoint, body) => {
    sent.push(body.brightness);
    return { success: true };
  };
  for (const percent of [10, 20, 50, 80, 100]) {
    await nightApi.setNightlight('dev-1', false, percent, 'ffffff', 'default');
  }
  assert.deepEqual(sent, [1, 2, 5, 8, 10], 'brightness percentages map onto Pura levels 1-10');
  sent.length = 0;
  await nightApi.setNightlight('dev-1', false, 8, 'ffffff', 'default');
  assert.deepEqual(sent, [1], 'a 1-10 level passed as a percentage collapses - callers must convert');
}

// --- Cognito config changes -------------------------------------------------------------------
// pypura publishes releases regularly without touching the Cognito IDs. Keying off its version
// alone discarded a working session and forced a full re-authentication for nothing.
{
  const cognitoApi = new PuraApi(silentLog);
  assert.equal(
    cognitoApi.updateCognitoConfig('us-east-1_LaB718hYv', '4iekubat0jb5iljfbaalsiqf9j'),
    false,
    'adopting the IDs already in use must report no change',
  );
  assert.equal(
    cognitoApi.updateCognitoConfig('us-east-1_Different', '4iekubat0jb5iljfbaalsiqf9j'),
    true,
    'a changed user pool must report a change',
  );
  assert.equal(
    cognitoApi.updateCognitoConfig('us-east-1_Different', 'differentclientid'),
    true,
    'a changed client id must report a change',
  );
  assert.equal(
    cognitoApi.updateCognitoConfig('us-east-1_Different', 'differentclientid'),
    false,
    'repeating the same update must report no change',
  );
}

// --- Realtime timer events ---------------------------------------------------------------------
const timerNow = 10_000;
assert.deepEqual(buildTimerRealtimeDeviceUpdate({ bay: 1, intensity: 7, start: 1234 }, timerNow), {
  bay1: { active: true, intensity: 7, activeAt: 1234, timer: { bay: 1, intensity: 7, start: 1234 } },
});
assert.equal(buildTimerRealtimeDeviceUpdate({ bay: 3, intensity: 7 }, timerNow), undefined);
assert.equal(buildTimerRealtimeDeviceUpdate(null, timerNow), undefined);
assert.equal(
  buildTimerRealtimeDeviceUpdate({ bay: 1, intensity: 7, start: timerNow + 3600 }, timerNow),
  undefined,
  'a timer scheduled for later must not mark the bay active yet',
);
assert.equal(
  buildTimerRealtimeDeviceUpdate({ bay: 1, intensity: 7, start: 100, end: 200 }, timerNow),
  undefined,
  'an elapsed timer must not mark the bay active',
);

// A synthetic update is deep-merged into the cached __raw, so it must never invent top-level
// device fields. `controller` matters most: every write path resolves device.controller.
for (const key of ['controller', 'deviceActiveState']) {
  assert.equal(
    key in buildTimerRealtimeDeviceUpdate({ bay: 1, intensity: 7, start: 1234 }, timerNow),
    false,
    `timer updates must not synthesise ${key}`,
  );
}

// --- The same guarantee, end to end through the platform --------------------------------------
{
  class FakePlatformAccessory extends Accessory {
    constructor(displayName, UUID) {
      super(displayName, UUID);
      this.UUID = UUID;
      this.context = {};
      this._associatedPlugin = 'test-plugin';
    }
  }

  const platform = new PuraPlatform(
    silentLog,
    { platform: 'PuraSmartDiffuser', name: 'Pura', username: 'user', password: 'pass' },
    {
      hap: { Service, Characteristic, uuid, HapStatusError, HAPStatus },
      platformAccessory: FakePlatformAccessory,
      on: () => {},
      registerPlatformAccessories: () => {},
      updatePlatformAccessories: () => {},
      unregisterPlatformAccessories: () => {},
    },
  );

  await platform.registerDevice({
    id: 'dev-1',
    name: 'Office',
    type: 'Pura 4',
    version: '4',
    state: {},
    online: true,
    controller: 'default',
    diffusionMode: 'standard',
    bay1: { id: 1, active: false, intensity: 0 },
    bay2: { id: 2, active: false, intensity: 0 },
    __raw: { controller: 'default' },
  });
  const accessory = [...platform.accessories.values()][0];

  await platform.handleWebhookPayload({
    recordType: 'TIMER',
    eventType: 'INSERT',
    deviceId: 'dev-1',
    timerRecord: { bay: 2, intensity: 7, start: now },
  });

  assert.equal(accessory.context.device.bay2.active, true, 'the timed bay should read as active');
  assert.equal(
    accessory.context.device.controller,
    'default',
    'a timer event must not rewrite the device controller',
  );
  assert.equal(
    accessory.context.device.__raw.deviceActiveState,
    undefined,
    'a timer event must not synthesise deviceActiveState',
  );
}

// The webhook handler schedules a reconciling refresh; exit rather than let it fire.
exit(0);
