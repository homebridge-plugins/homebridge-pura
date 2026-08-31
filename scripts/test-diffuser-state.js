/**
 * Coverage for diffuser state normalisation and realtime timer handling.
 *
 * These are the read-path behaviours that changed independently of any per-bay or per-fragrance
 * control surface: how numeric intensity is scaled, how long a standard-mode session stays active,
 * and how a realtime TIMER event is folded into the cached device record.
 *
 * Also covers per-bay control, where the recurring defect has been a guard applied to one write
 * path but not its sibling: which bay reads as on, which bay a write lands on, and what happens
 * when a bay has nothing to diffuse.
 */

import assert from 'node:assert/strict';
import { exit, stdout } from 'node:process';

import {
  Accessory,
  Characteristic,
  HapStatusError,
  HAPStatus,
  Service,
  uuid,
} from '@homebridge/hap-nodejs';

import {
  DEVICE_LIST_ENDPOINTS,
  mapPuraNumericIntensityToHomeKit,
  PuraApi,
  isAutoAlternateMode,
  DIFFUSION_MODE_ALTERNATING,
  DIFFUSION_MODE_SINGLE_BAY,
} from '../dist/puraApi.js';
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
// Observed during a Pura outage: users/devices answers 400 getDevicesAndMigrate() and devices
// answers 404. Trying retired endpoints only delays a failing cycle and buries the real cause.
for (const retired of ['users/devices', 'devices']) {
  assert.equal(
    DEVICE_LIST_ENDPOINTS.includes(retired),
    false,
    `${retired} is retired server-side and must not be tried`,
  );
}

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

// --- Concurrent bays in oscillation modes ------------------------------------------------------
// Pura runs both bays at once in oscillation-multi-bay, each at its own intensity. Forcing a single
// active bay discarded half the device, and picked a different half depending on whether activeAt
// happened to be present. Standard mode really is one-at-a-time, so the collapse stays there.
assert.equal(isAutoAlternateMode('oscillation-multi-bay'), true);
assert.equal(isAutoAlternateMode('standard'), false);
assert.equal(isAutoAlternateMode(undefined), false, 'an unknown mode must take the conservative path');
assert.equal(isAutoAlternateMode('some-future-mode'), false);

{
  const bothRunning = {
    id: 'dev-1', model: 1, deviceVer: 'v48', connected: true,
    bay1: { id: 1, activeAt: now }, bay2: { id: 2, activeAt: now },
    oscillation: { states: [{ bay: 1, active: true, intensity: 1 }, { bay: 2, active: true, intensity: 10 }] },
  };

  const oscillating = api.normalizeDeviceRecord({ ...bothRunning, diffusionMode: 'oscillation-multi-bay' });
  assert.equal(oscillating.bay1.active, true, 'bay 1 stays active in oscillation mode');
  assert.equal(oscillating.bay2.active, true, 'bay 2 stays active in oscillation mode');
  assert.equal(oscillating.bay1.exactIntensity, 20, 'each bay keeps its own intensity');
  assert.equal(oscillating.bay2.exactIntensity, 100, 'each bay keeps its own intensity');

  const standard = api.normalizeDeviceRecord({ ...bothRunning, diffusionMode: 'standard' });
  const stillActive = [standard.bay1.active, standard.bay2.active].filter(Boolean).length;
  assert.equal(stillActive, 1, 'standard mode still collapses to a single active bay');

  const unknownMode = api.normalizeDeviceRecord({ ...bothRunning, diffusionMode: undefined });
  assert.equal(
    [unknownMode.bay1.active, unknownMode.bay2.active].filter(Boolean).length,
    1,
    'an unknown mode keeps the conservative single-bay collapse',
  );
}

// Bay identity is positional. It used to carry Pura's internal record id, which is meaningless as
// a bay number and about to become load-bearing.
{
  const withRecordIds = api.normalizeDeviceRecord({
    id: 'dev-1', model: 1, deviceVer: 'v48', connected: true, diffusionMode: 'standard',
    bay1: { id: 1774673211, activeAt: now }, bay2: { id: 1774673244 },
  });
  assert.equal(withRecordIds.bay1.id, 1, 'bay1.id is the bay number');
  assert.equal(withRecordIds.bay2.id, 2, 'bay2.id is the bay number');
}

// --- Auto-alternate control --------------------------------------------------------------------
// The switch writes Pura's diffusion mode, which is the same setting that decides whether both bays
// run at once - so the two must agree on what the strings mean.
assert.equal(isAutoAlternateMode(DIFFUSION_MODE_ALTERNATING), true, 'switch on means the device alternates');
assert.equal(isAutoAlternateMode(DIFFUSION_MODE_SINGLE_BAY), false, 'switch off means a single pinned bay');
{
  const modeApi = new PuraApi(silentLog);
  const posted = [];
  modeApi.makeRequest = async (method, endpoint, body) => {
    posted.push({ method, endpoint, mode: body.mode });
    return { success: true };
  };
  assert.equal(await modeApi.setDiffusionMode('dev-1', DIFFUSION_MODE_ALTERNATING), true);
  assert.equal(await modeApi.setDiffusionMode('dev-1', DIFFUSION_MODE_SINGLE_BAY), true);
  assert.deepEqual(posted, [
    { method: 'POST', endpoint: 'v3/diffusion/dev-1/mode', mode: 'oscillation-multi-bay' },
    { method: 'POST', endpoint: 'v3/diffusion/dev-1/mode', mode: 'standard' },
  ]);
}

// --- Bay naming ---------------------------------------------------------------------------------
// A fragrance name is only used when it tells the bays apart. Running the same scent in both bays
// is ordinary, and naming both after it is longer without being clearer.
{
  const { PuraPlatformAccessory } = await import('../dist/platformAccessory.js');
  const nameFor = PuraPlatformAccessory.prototype.getBayServiceName;
  const named = (f1, f2) => {
    const ctx = {
      device: {
        bay1: f1 ? { fragrance: { name: f1 } } : {},
        bay2: f2 ? { fragrance: { name: f2 } } : {},
      },
    };
    return [nameFor.call(ctx, 1), nameFor.call(ctx, 2)];
  };
  assert.deepEqual(named('Vetiver', 'Salt'), ['Vetiver', 'Salt'], 'distinct scents name the bays');
  assert.deepEqual(named('Coconut', 'Coconut'), ['Bay 1', 'Bay 2'], 'identical scents fall back to positional');
  assert.deepEqual(named('vetiver', 'Vetiver'), ['Bay 1', 'Bay 2'], 'the comparison ignores case');
  assert.deepEqual(named('Vetiver', undefined), ['Vetiver', 'Bay 2'], 'an empty bay is positional');
  assert.deepEqual(named(undefined, undefined), ['Bay 1', 'Bay 2'], 'no fragrances at all is positional');
  assert.deepEqual(named('   ', 'Salt'), ['Bay 1', 'Salt'], 'a blank name is not a name');
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

// --- Bay usability ------------------------------------------------------------------------------
// An empty bay cannot diffuse, and the plugin has to treat "no vial" and "the device has not said
// yet" as different things - defaulting an unknown remaining to empty would disable working bays.
{
  const { PuraPlatformAccessory } = await import('../dist/platformAccessory.js');
  const usable = (bay1) => PuraPlatformAccessory.prototype.isBayUsable.call({ device: { bay1 } }, 1);

  // vialId is the one field that positively separates an empty bay from a quiet payload, verified
  // by reading the same realtime shape with the vial in and out.
  assert.equal(usable({ vialId: '', isSmartVial: false }), false, 'an empty vialId is Pura saying the bay is empty');
  assert.equal(
    usable({ vialId: 'E0020809D739EBF2', isSmartVial: true }),
    true,
    'a seated vial reports its id even when the fragrance block is absent',
  );

  // Remaining is Pura's estimate from wearing time, not a measurement, and the device diffuses
  // straight through zero - a Mini was seen running a bay at 0%. Calling that unusable showed it
  // off in HomeKit while it ran, with no way to stop it.
  assert.equal(
    usable({ fragrance: { name: 'Volcano' }, remainingPercent: 0, lowFragrance: true, active: true }),
    true,
    'a bay at 0% is still usable - the device keeps running it',
  );
  assert.equal(usable({ fragrance: { name: 'Vetiver' }, remainingPercent: 1 }), true, '1% left still diffuses');

  // Everything below is a partial payload observed from hardware while a full vial was seated.
  // Reading any of them as empty disabled a working bay and refused to turn it on.
  assert.equal(usable(undefined), true, 'a refresh that drops the bay says nothing about the vial');
  assert.equal(usable({}), true, 'a bay reported with no fields at all is unknown, not empty');
  assert.equal(
    usable({ active: true, intensity: 30 }),
    true,
    'a realtime frame carries intensity but omits the fragrance block',
  );
  assert.equal(
    usable({ fragrance: { name: 'Vetiver' }, remainingPercent: undefined }),
    true,
    'an unreported remaining is unknown, not empty',
  );
}

// --- Bay existence ------------------------------------------------------------------------------
// getConfiguredBayNumbers decides whether a bay's service is torn off the accessory, and Pura drops
// bays from payloads transiently. Removing a service loses its name in Home and any automation
// pointing at it, so a bay that has been seen once has to stay.
{
  const { PuraPlatformAccessory } = await import('../dist/platformAccessory.js');
  const { getConfiguredBayNumbers } = PuraPlatformAccessory.prototype;
  const ctx = { accessory: { context: {} }, device: {} };
  const configured = (bay1, bay2) => {
    ctx.device = { bay1, bay2 };
    return getConfiguredBayNumbers.call(ctx);
  };

  assert.deepEqual(configured({ id: 1 }, { id: 2 }), [1, 2], 'both bays reported');
  assert.deepEqual(configured({ id: 1 }, undefined), [1, 2], 'a dropped bay keeps its service');
  assert.deepEqual(configured(undefined, undefined), [1, 2], 'so does a payload that drops both');

  const single = { accessory: { context: {} }, device: {} };
  assert.deepEqual(
    getConfiguredBayNumbers.call({ ...single, device: { bay1: { id: 1 } } }),
    [1],
    'a single-bay diffuser never grows a second bay',
  );
  assert.deepEqual(
    getConfiguredBayNumbers.call({ accessory: { context: {} }, device: {} }),
    [1],
    'a diffuser with nothing reported still gets one bay',
  );
}

// --- Partial payload stickiness -----------------------------------------------------------------
// Realtime frames omit the fragrance block and a reconciling refresh sometimes drops the bay
// outright, both while a vial is seated. Bays are physical and do not come and go, so what the
// device last said has to survive - otherwise the tile loses its name and reads empty every time
// one of those arrives.
{
  const { PuraPlatformAccessory } = await import('../dist/platformAccessory.js');
  const { retainKnownBays } = PuraPlatformAccessory.prototype;
  const ctx = { accessory: { context: {} } };
  const apply = (device) => retainKnownBays.call(ctx, device);

  const volcano = { id: 2, active: true, intensity: 30, activeAt: 1788157375, fragrance: { name: 'Volcano' }, remainingPercent: 100 };
  assert.equal(apply({ bay2: volcano }).bay2.fragrance.name, 'Volcano', 'a full report passes through');

  // Realtime: bay present, fragrance block gone.
  const fromRealtime = apply({ bay2: { id: 2, active: true, intensity: 30 } });
  assert.equal(fromRealtime.bay2.fragrance.name, 'Volcano', 'the known fragrance is carried over');
  assert.equal(fromRealtime.bay2.remainingPercent, 100, 'so is the remaining percentage');
  assert.equal(fromRealtime.bay2.intensity, 30, 'without discarding what the frame did report');
  assert.equal(fromRealtime.bay2.active, true, 'and without overriding the reported state');

  // Refresh drops the bay entirely.
  const dropped = apply({ bay2: undefined });
  assert.equal(dropped.bay2.fragrance.name, 'Volcano', 'a dropped bay is restored, not treated as gone');
  assert.equal(dropped.bay2.active, false, 'and carried forward as idle - a dropped bay is never the running one');
  assert.equal(dropped.bay2.activeAt, undefined, 'with no stale activeAt to mistake for a new session');

  // A genuine change replaces the cache rather than being masked by it.
  assert.equal(apply({ bay2: { id: 2, fragrance: { name: 'Salt' }, remainingPercent: 90 } }).bay2.fragrance.name, 'Salt', 'a new vial wins');
  assert.equal(apply({ bay2: { id: 2 } }).bay2.fragrance.name, 'Salt', 'and becomes what is carried over');

  // A positive zero is real information and must survive the merge.
  assert.equal(apply({ bay2: { id: 2, remainingPercent: 0 } }).bay2.remainingPercent, 0, 'a reported zero survives the merge');
}

// --- Vial identity vs the cache -------------------------------------------------------------------
// The cache exists to survive silence, not to contradict the device. An empty vialId is Pura saying
// the bay is empty, and a different id is a different vial - carrying the old fragrance into either
// would describe a vial that is not there.
{
  const { PuraPlatformAccessory } = await import('../dist/platformAccessory.js');
  const { retainKnownBays } = PuraPlatformAccessory.prototype;
  const ctx = { accessory: { context: {} } };
  const apply = (bay2) => retainKnownBays.call(ctx, { bay2 }).bay2;

  apply({ id: 2, vialId: 'VIAL-A', fragrance: { name: 'Volcano' }, remainingPercent: 100 });

  // Same vial, fragrance omitted: the realtime shape. Carry the name over.
  const quiet = apply({ id: 2, vialId: 'VIAL-A' });
  assert.equal(quiet.fragrance.name, 'Volcano', 'the same vial keeps its name through a quiet frame');
  assert.equal(quiet.remainingPercent, 100, 'and its remaining');

  // Vial pulled: do not resurrect Volcano.
  const pulled = apply({ id: 2, vialId: '', isSmartVial: false });
  assert.equal(pulled.fragrance, undefined, 'an emptied bay is not given the old fragrance back');
  assert.equal(pulled.remainingPercent, undefined, 'nor its old remaining');

  // A later refresh that drops the bay must not resurrect it either.
  assert.equal(apply(undefined).fragrance, undefined, 'and the emptied state is what gets cached');

  // A different vial with no fragrance yet: report the new vial, not the old scent.
  const swapped = apply({ id: 2, vialId: 'VIAL-B' });
  assert.equal(swapped.fragrance, undefined, 'a different vial does not inherit the previous name');

  // A payload with no vialId at all cannot contradict the cache, so the merge still applies.
  const noIdCtx = { accessory: { context: {} } };
  retainKnownBays.call(noIdCtx, { bay2: { id: 2, fragrance: { name: 'Salt' }, remainingPercent: 80 } });
  assert.equal(
    retainKnownBays.call(noIdCtx, { bay2: { id: 2 } }).bay2.fragrance.name,
    'Salt',
    'a payload that does not mention vialId still gets the cached fragrance',
  );

  // A bay never seen is not invented - a single-bay diffuser must not grow a second one.
  const fresh = { accessory: { context: {} } };
  assert.equal(retainKnownBays.call(fresh, { bay1: { id: 1 } }).bay2, undefined, 'an unseen bay stays absent');
}

// --- New diffusion session ----------------------------------------------------------------------
// Starting a bay from the Pura app that HomeKit already shows as active changes nothing the plugin
// tracks except a fresh activeAt stamp. That is the only signal the nightlight auto-off can arm on.
{
  const { PuraPlatformAccessory } = await import('../dist/platformAccessory.js');
  const { consumeNewBayActivation } = PuraPlatformAccessory.prototype;
  const ctx = { lastBayActiveAt: {}, device: {} };
  const seeing = (bay1, bay2) => {
    ctx.device = { bay1, bay2 };
    return consumeNewBayActivation.call(ctx);
  };

  // Startup: whatever the device is already doing is not a new session.
  assert.equal(seeing({ activeAt: undefined }, { activeAt: 1788157375 }), false, 'first sighting never fires');
  assert.equal(seeing({ activeAt: undefined }, { activeAt: 1788157375 }), false, 'an unchanged view is quiet');

  // Bay 2's frame drops activeAt without diffusion having restarted anywhere.
  assert.equal(seeing({ activeAt: undefined }, { activeAt: undefined }), false, 'a stamp going away is not a start');

  // Bay 1 starts in the Pura app: idle -> stamped, on the bay already showing active.
  assert.equal(seeing({ activeAt: 1788158575 }, { activeAt: undefined }), true, 'a fresh stamp is a new session');
  assert.equal(seeing({ activeAt: 1788158575 }, { activeAt: undefined }), false, 'and only reports once');

  // A bay missing from the payload must not clear what was known about it.
  assert.equal(seeing({ activeAt: 1788158575 }, undefined), false, 'an absent bay is not a change');
  assert.equal(seeing({ activeAt: 1788158575 }, { activeAt: 1788157375 }), false, 'bay 2 returning at its old stamp is quiet');
}

// --- Bay active state ---------------------------------------------------------------------------
// Modes that run one bay at a time follow the single active bay. Oscillation modes genuinely run
// both, so each bay reports its own state. Either way an unusable bay reads off.
{
  const { PuraPlatformAccessory } = await import('../dist/platformAccessory.js');
  const { isBayActive, isBayUsable } = PuraPlatformAccessory.prototype;
  const vial = { fragrance: { name: 'Vetiver' }, remainingPercent: 50 };
  const activeIn = (diffusionMode, bay1, bay2, effectiveActiveBay, bay) =>
    isBayActive.call({ device: { diffusionMode, bay1, bay2 }, isBayUsable }, bay, effectiveActiveBay);
  const running = { ...vial, active: true };

  // Exactly one bay diffuses, in either mode.
  assert.equal(activeIn('standard', running, running, 1, 1), true, 'standard follows the active bay');
  assert.equal(activeIn('standard', running, running, 1, 2), false, 'standard keeps the other bay off');
  assert.equal(
    activeIn('oscillation-multi-bay', running, running, 2, 2),
    true,
    'auto-alternate lights the bay that is currently running',
  );
  assert.equal(
    activeIn('oscillation-multi-bay', running, running, 2, 1),
    false,
    'auto-alternate leaves the bay that is only in the rotation off - both report active:true, ' +
    'and following that flag lit two tiles while the Pura app showed one running bay',
  );

  // Nothing running at all.
  assert.equal(activeIn('oscillation-multi-bay', running, running, undefined, 1), false, 'no active bay means off');

  // A bay with no vial is off in either mode, even when the device claims it is the active one.
  const empty = { active: true, vialId: '' };
  assert.equal(activeIn('standard', empty, running, 1, 1), false, 'an empty bay reads off in standard mode');
  assert.equal(activeIn('oscillation-multi-bay', empty, running, 1, 1), false, 'an empty bay reads off when alternating');
}

// --- Nothing diffusing --------------------------------------------------------------------------
// With auto-alternate on, every bay in the rotation reports active:true whether or not anything is
// coming out. Only activeAt says a bay is running, and it is cleared when diffusion stops - so no
// stamp anywhere means the diffuser is idle, however many bays claim to be active.
{
  const { PuraPlatformAccessory } = await import('../dist/platformAccessory.js');
  const { hasNoBayDiffusing } = PuraPlatformAccessory.prototype;
  const idle = (diffusionMode, bay1, bay2) => hasNoBayDiffusing.call({ device: { diffusionMode, bay1, bay2 } });
  const armed = { active: true, intensity: 50 };

  assert.equal(
    idle('oscillation-multi-bay', armed, null),
    true,
    'a bay armed for the rotation with no stamp is not diffusing - the Pura app showed it stopped',
  );
  assert.equal(idle('oscillation-multi-bay', armed, armed), true, 'two armed bays with no stamp is still idle');
  assert.equal(
    idle('oscillation-multi-bay', { ...armed, activeAt: 1788158575 }, armed),
    false,
    'a stamp anywhere means the diffuser is running',
  );

  // Scoped to auto-alternate: standard mode keeps its own long-running-session handling, where
  // active is meaningful on its own.
  assert.equal(idle('standard', armed, null), false, 'standard mode is left alone');
  assert.equal(idle(undefined, armed, null), false, 'an unknown mode is left alone');
}

// --- Active bay resolution ----------------------------------------------------------------------
// The device marks every bay in the rotation `active`, and stamps activeAt on the one currently
// diffusing. Both observations from hardware have to resolve the same way.
{
  const { PuraPlatformAccessory } = await import('../dist/platformAccessory.js');
  const { getActiveBayNumber } = PuraPlatformAccessory.prototype;
  const resolve = (bay1, bay2) => getActiveBayNumber.call({
    device: { diffusionMode: 'oscillation-multi-bay', bay1, bay2 },
    fillBayIntensityFromCache: (bay) => bay,
    hasNoBayDiffusing: PuraPlatformAccessory.prototype.hasNoBayDiffusing,
  });

  assert.equal(
    resolve({ active: true, activeAt: undefined, intensity: 50 }, { active: true, activeAt: 1788157375, intensity: 100 }),
    2,
    'when both are in the rotation, activeAt picks the bay that is running',
  );
  assert.equal(
    resolve({ active: true, activeAt: 1788157193, intensity: 30 }, { active: true, activeAt: undefined, intensity: 100 }),
    1,
    'and it wins over the higher intensity',
  );
  assert.equal(
    resolve({ active: true, activeAt: undefined, intensity: 50 }, undefined),
    undefined,
    'a lone active bay with no stamp is armed, not running - confirmed against the Pura app',
  );
  assert.equal(resolve({ active: false }, { active: false }), undefined, 'nothing running resolves to no bay');
}

// --- Intensity targeting ------------------------------------------------------------------------
// Writes must land on the bay the caller named. Falling back to whichever bay happens to be present
// wrote to the wrong bay while the caller logged success against the one it asked for.
{
  const { PuraPlatformAccessory } = await import('../dist/platformAccessory.js');
  const { setIntensityAcrossAvailableBays, getAvailableBays, getBayLogLabel } = PuraPlatformAccessory.prototype;
  const writes = [];
  const warnings = [];
  const ctx = {
    device: { id: 'dev-1', bay1: { id: 1 } },
    getAvailableBays,
    getBayLogLabel,
    getDiffuserLogLabel: () => 'Office Diffuser',
    platform: { log: { warn: (message) => warnings.push(message) } },
    puraApi: {
      setIntensity: async (_id, bay, intensity) => {
        writes.push([bay, intensity]);
        return true;
      },
    },
  };

  assert.equal(await setIntensityAcrossAvailableBays.call(ctx, 1, 50, 'default', false), true);
  assert.deepEqual(writes, [[1, 50]], 'the named bay is written');

  writes.length = 0;
  assert.equal(
    await setIntensityAcrossAvailableBays.call(ctx, 2, 50, 'default', false),
    false,
    'a bay that is not present fails rather than retargeting',
  );
  assert.deepEqual(writes, [], 'nothing is written to the wrong bay');
  assert.equal(warnings.length, 1, 'the skipped write is reported');
}

// --- Empty bay write refusal --------------------------------------------------------------------
// Both bay write paths have to refuse an unusable bay. The ON handler did and the speed handler did
// not, and the speed handler is the more damaging of the two: it re-arms the bay with setAlwaysOn
// first, so a slider drag on an empty bay pinned the device to it and stopped the bay that was
// actually diffusing.
{
  const { PuraPlatformAccessory } = await import('../dist/platformAccessory.js');
  const proto = PuraPlatformAccessory.prototype;

  const makeContext = (bay2) => {
    const calls = [];
    return {
      calls,
      context: {
        device: { id: 'dev-1', diffusionMode: 'standard', bay1: { id: 1, active: true }, bay2 },
        useFanService: true,
        enableBayControl: true,
        currentStateActive: true,
        bayServices: { 1: undefined, 2: undefined },
        isBayUsable: proto.isBayUsable,
        isHapStatusError: proto.isHapStatusError,
        describeIntensityLevel: proto.describeIntensityLevel,
        summarizeBayDebugState: proto.summarizeBayDebugState,
        mapRotationToIntensity: proto.mapRotationToIntensity,
        mapIntensityToRotation: proto.mapIntensityToRotation,
        getBayLogLabel: proto.getBayLogLabel,
        getDiffuserLogLabel: () => 'Office Diffuser',
        getEffectiveActiveBayNumber: () => 1,
        getAvailableBays: proto.getAvailableBays,
        setIntensityAcrossAvailableBays: proto.setIntensityAcrossAvailableBays,
        setStoredBayIntensity: () => {},
        clearPendingSecondaryBayIntensitySync: () => {},
        cancelPendingPowerOnIntensityLog: () => {},
        shouldResetAwayModeBeforeActivating: () => false,
        isDeviceUnavailable: () => false,
        hasNoScentVialsDetected: () => false,
        applyCurrentState: () => {},
        updateFaultState: () => {},
        enqueueRotationWrite: (work) => work(),
        accessory: { context: {} },
        platform: {
          log: {
            info: () => {},
            debug: () => {},
            warn: () => {},
            error: (...args) => calls.push(`error:${args[0]}`),
          },
          isDebugEnabled: () => false,
          requestRefreshSoon: () => {},
          api: { hap: { HapStatusError, HAPStatus } },
        },
        puraApi: {
          setAlwaysOn: async (_id, bay) => {
            calls.push(`alwaysOn:${bay}`);
            return true;
          },
          setIntensity: async (_id, bay, intensity) => {
            calls.push(`intensity:${bay}:${intensity}`);
            return true;
          },
          setAwayMode: async () => true,
        },
      },
    };
  };

  // A bay with no vial is refused as missing, not as a communication failure.
  const empty = makeContext({ id: 2, vialId: '', isSmartVial: false });
  await assert.rejects(
    () => proto.setBayRotationSpeed.call(empty.context, 2, 60),
    (error) => error.hapStatus === HAPStatus.RESOURCE_DOES_NOT_EXIST,
    'an empty bay is refused',
  );
  assert.deepEqual(empty.calls, [], 'an empty bay is never re-armed and never written');

  // A bay whose payload simply says nothing about a vial is unknown, not empty, and must go
  // through - refusing it locked out a bay holding a full vial.
  const quiet = makeContext({ id: 2, active: true, intensity: 30 });
  await proto.setBayRotationSpeed.call(quiet.context, 2, 60);
  assert.deepEqual(quiet.calls, ['alwaysOn:2', 'intensity:2:50'], 'a bay with no fragrance reported still works');

  // A usable bay still goes through, so the guard is not simply blocking everything.
  const usable = makeContext({ id: 2, fragrance: { name: 'Volcano' }, remainingPercent: 40 });
  await proto.setBayRotationSpeed.call(usable.context, 2, 60);
  assert.deepEqual(
    usable.calls,
    ['alwaysOn:2', 'intensity:2:50'],
    'a usable bay is re-armed and written at the mapped intensity (60 snaps to medium)',
  );
}

stdout.write('All diffuser state checks passed.\n');

// The webhook handler schedules a reconciling refresh; exit rather than let it fire.
exit(0);
