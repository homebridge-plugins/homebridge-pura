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
  runsBaysConcurrently,
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
assert.equal(runsBaysConcurrently('oscillation-multi-bay'), true);
assert.equal(runsBaysConcurrently('standard'), false);
assert.equal(runsBaysConcurrently(undefined), false, 'an unknown mode must take the conservative path');
assert.equal(runsBaysConcurrently('some-future-mode'), false);

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
assert.equal(runsBaysConcurrently(DIFFUSION_MODE_ALTERNATING), true, 'switch on means concurrent bays');
assert.equal(runsBaysConcurrently(DIFFUSION_MODE_SINGLE_BAY), false, 'switch off means one bay at a time');
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

  assert.equal(usable(undefined), false, 'an absent bay is not usable');
  assert.equal(usable({}), false, 'a bay with no fragrance block has no vial seated');
  assert.equal(usable({ fragrance: { name: 'Vetiver' }, remainingPercent: 0 }), false, 'a spent vial is not usable');
  assert.equal(usable({ fragrance: { name: 'Vetiver' }, remainingPercent: 1 }), true, '1% left still diffuses');
  assert.equal(
    usable({ fragrance: { name: 'Vetiver' }, remainingPercent: undefined }),
    true,
    'an unreported remaining is unknown, not empty',
  );
  assert.equal(usable({ fragrance: { id: 'abc' } }), true, 'a fragrance id alone is enough to be seated');
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

  // standard: exclusive, driven by the resolved active bay
  const std = { ...vial, active: true };
  assert.equal(activeIn('standard', std, std, 1, 1), true, 'standard follows the active bay');
  assert.equal(activeIn('standard', std, std, 1, 2), false, 'standard keeps the other bay off');

  // oscillation: concurrent, each bay reports itself
  assert.equal(
    activeIn('oscillation-multi-bay', { ...vial, active: true }, { ...vial, active: true }, 1, 2),
    true,
    'oscillation reports a second running bay regardless of the active bay',
  );
  assert.equal(
    activeIn('oscillation-multi-bay', { ...vial, active: true }, { ...vial, active: false }, 1, 2),
    false,
    'oscillation still reports a stopped bay as off',
  );

  // an empty bay is off in either mode, even when the device claims it is running
  const empty = { active: true };
  assert.equal(activeIn('standard', empty, std, 1, 1), false, 'an empty bay reads off in standard mode');
  assert.equal(activeIn('oscillation-multi-bay', empty, std, 1, 1), false, 'an empty bay reads off in oscillation mode');
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

  // Bay 2 holds no vial: refuse, and touch nothing.
  const empty = makeContext(undefined);
  await assert.rejects(
    () => proto.setBayRotationSpeed.call(empty.context, 2, 60),
    (error) => error.hapStatus === HAPStatus.RESOURCE_DOES_NOT_EXIST,
    'an empty bay is refused as missing, not as a communication failure',
  );
  assert.deepEqual(empty.calls, [], 'an empty bay is never re-armed and never written');

  // A spent vial is refused the same way.
  const spent = makeContext({ id: 2, fragrance: { name: 'Volcano' }, remainingPercent: 0 });
  await assert.rejects(
    () => proto.setBayRotationSpeed.call(spent.context, 2, 60),
    (error) => error.hapStatus === HAPStatus.RESOURCE_DOES_NOT_EXIST,
    'a spent vial is refused too',
  );
  assert.deepEqual(spent.calls, [], 'a spent bay is never re-armed and never written');

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
