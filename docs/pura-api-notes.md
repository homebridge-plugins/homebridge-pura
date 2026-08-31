# Pura API field notes

Observed behaviour of Pura's API, gathered from live device logs rather than documentation. Pura
publishes no public API spec, so everything here was derived by instrumenting the plugin and
watching a real diffuser respond. Recorded because it is expensive to re-derive and easy to get
subtly wrong.

Primary reference implementations, both of which talk to the same API and are worth checking before
guessing:

- [`pypura`](https://github.com/natekspencer/pypura) — the Python client this plugin is based on
- [`ha-pura`](https://github.com/natekspencer/ha-pura) — the Home Assistant integration built on it

Verified against a **Pura 4** (`hwVersion 4.3`, `deviceVer v48`, firmware 7.5.3) in August 2026.

## Authentication

Requests authenticate with the Cognito **ID token**, not the access token.

Sending the access token returns `401` even when it has just been issued, and refreshing does not
help — the refreshed access token is rejected too. Only the ID token succeeds. pypura does the same
(`auth_token_type=TokenType.ID_TOKEN`).

Getting this wrong is expensive but silent: the plugin previously sent the access token, took a 401,
refreshed, took a second 401, and only then fell back to the ID token. Three HTTP round trips and an
unnecessary Cognito refresh on *every* call, with nothing in the logs to indicate it.

## Endpoints

| Endpoint | Notes |
| --- | --- |
| `v3/accounts/v2/devices` | Device list. pypura moved here in Aug 2026 from `v2/users/devices`, describing it as a fix for "compatibility and reliability when loading devices". The path still says `v2` for the device representation — it is the v3 *accounts* service returning the same shape, which is why pypura changed only the URL and no parsing. |
| `v3/diffusion/{deviceId}/mode` | Set diffusion mode. See below. |
| `devices/{id}/always-on` | Select a bay. |
| `devices/{id}/intensity` | `{bay, controller, intensity}`. |
| `devices/{id}/nightlight` | `{active, brightness, color, controller}`. Brightness is 1–10. |
| `devices/{id}/timer` | `{bay, intensity, start, end, validateOverride}`. |
| `devices/{id}/stop-all` | Stop diffusion. |
| `devices/{id}/awayMode` | |
| `devices/{id}/ambientMode` | Not currently implemented by this plugin. |

Everything except the two `v3/` paths is unversioned. "Moving to v3" means adopting two newer
service paths, not an API migration.

Two older device-list paths are **retired server-side** and should not be used as fallbacks. During
a Pura outage they answered:

```
users/devices   400  {"message":"getDevicesAndMigrate() Error"}
devices         404  Cannot GET /mobile/api/devices
```

Only `v3/accounts/v2/devices` and `v2/users/devices` are live.

The device list response is keyed by device family rather than being a flat array —
`{ wall: [...], plus: [...], car: [...] }`. `extractDevices` scans every top-level array, skipping
`car`, so a new family (a new product line) is picked up without code changes.

## Diffusion mode

`diffusionMode` is the **"Auto-alternate fragrances"** toggle in the Pura app. Two values:

| `diffusionMode` | Pura app | Bay behaviour |
| --- | --- | --- |
| `oscillation-multi-bay` | Auto-alternate **on** | Both bays in rotation, **independent intensities**, one diffusing at a time |
| `standard` | Auto-alternate **off** | A single pinned bay |

Confirmed by ha-pura, which exposes it as a switch named "Auto-alternate fragrances" and toggles
between exactly these two strings.

**Auto-alternate is about rotation over time, not concurrency.** Only one bay diffuses at a time in
*either* mode — verified against the Pura app, which showed a single running bay while the record
reported two. Alternating means the device puts both bays in the rotation and swaps between them
periodically.

### `active` and `activeAt` mean different things

This is the trap, and it is easy to get backwards:

- **`bay.active`** means the bay is *in the rotation*. In auto-alternate mode both bays carry it.
- **`bay.activeAt`** is stamped on the bay that is *currently diffusing*, and moves when the device
  swaps.

So `active` alone does not identify the running bay, and it does not even establish that the
diffuser is running. The rule that fits every observation:

```
no activeAt on any bay -> nothing is diffusing, however many bays report active
otherwise              -> the bay with the latest activeAt is the one running
```

A bay reporting `active: true` with no `activeAt` is **armed for the rotation, not diffusing** —
verified against the Pura app, which showed the diffuser stopped while the record had a lone
`active: true` bay. The stamp is cleared when diffusion stops, so its absence everywhere is a
reliable idle signal.

Do not put a recency bound on `activeAt`. It holds the session's start time, so a bay running a long
session carries a stamp many minutes old; a five-minute window would read it as stopped.

**Auto-alternate and bay selection are independent.** Toggling the mode does not change which bay
is running, and selecting a single bay does not turn alternation off — a timer targeting one bay
leaves `diffusionMode` at `oscillation-multi-bay`, and the Pura app behaves the same way. Pulling a
vial does not touch the toggle either.

## Intensity

Pura's app exposes **five** positions. They map to numeric levels `1, 3, 5, 7, 10`:

| App position | Numeric level | HomeKit RotationSpeed |
| ---: | ---: | ---: |
| 1 | 1 | 20 |
| 2 | 3 | 40 |
| 3 | 5 | 60 |
| 4 | 7 | 80 |
| 5 | 10 | 100 |

Writes take the numeric level. pypura types the parameter as `int`.

The coarse string labels are also accepted, but they only reach **three** of the five positions:

| Label | Resulting level |
| --- | ---: |
| `subtle` | 1 |
| `medium` | 5 |
| `strong` | 10 |

Levels 3 and 7 are unreachable through the labels, so five-position control requires numeric writes.
Confirmed by driving the HomeKit slider and reading back what the device reported.

### Reads are scale-dependent and lossy

The two transports disagree, and this is the crux of any five-position control:

- **Realtime (websocket)** carries the exact numeric level — `oscillation=7(number)`
- **REST** collapses to three coarse labels — `oscillation="medium"(string)`

REST genuinely cannot distinguish the five positions: levels 5 and 7 both come back `"medium"`,
levels 1 and 3 both come back `"subtle"`.

Because a realtime update schedules a reconciling REST refresh ~2 seconds later, **an exact value
observed from realtime survives about two seconds before REST overwrites it with a coarse label**.
Any five-position control must therefore treat the exact value as sticky per bay: replace it only
with a newer exact observation, or with a coarse value that falls in a *different* bucket. A coarse
`"medium"` arriving after an exact `7` carries strictly less information and must not win.

### Which field carries it

Not consistent. Observed on `deviceDefaults.bayNIntensity` and `oscillation`, occasionally on the
bay's own `intensity`, and mixed within a single payload (one field numeric while another is a
string). Check all sources rather than binding to one.

Numeric values in `1..10` are levels, not percentages — no real device sits at 1–10 percent, so
that range can be read as levels unambiguously.

### Fragrance remaining

`bay.remaining.percent` is a 0-100 percentage. `bay.lowFragrance` flips to `true` at **10%** -
observed on a bay crossing from 11 to 10.

## Timers

Timer state is **not** exposed per bay. `bay.timer` is never populated, even while a timer runs.

The signal that a timer is running is `device.controller === "timer"`.

`controller` describes whoever last changed the device — observed values include `default`, `timer`,
`away`, and numeric strings (schedule numbers). Both this plugin and ha-pura echo it back on writes;
ha-pura substitutes the schedule number when it reads `"schedule"`, and refuses intensity changes
outright when it reads `"away"`.

Realtime `TIMER` frames carry a payload on `INSERT` and `MODIFY`, but **not** on `REMOVE`:

```
INSERT  keys=[uid,deviceId,eventType,recordType,timestamp,timerRecord]
        timerRecord={"bay":2,"start":...,"end":...,"intensity":5}
MODIFY  same shape - fires when a running timer's intensity is changed
REMOVE  keys=[uid,deviceId,eventType,recordType,timestamp]   (no timerRecord)
```

`start` and `end` are epoch seconds. `intensity` is a numeric level, same 1/3/5/7/10 scale as
everywhere else.

So `INSERT` and `MODIFY` can be applied optimistically — the bay named by the timer goes active at
that intensity, with `activeAt` taken from `start`. `REMOVE` carries nothing to apply and is best
handled by falling through to a normal refresh, which is what happens and works: the refresh two
seconds later reports both bays stopped.

## Realtime frames

Envelope: `{uid, deviceId, eventType, recordType, timestamp, <payload?>}`.

- `DEVICE` / `MODIFY` carries `deviceRecord` and is the main state channel
- `TIMER` carries `timerRecord` on `INSERT` and `MODIFY`, nothing on `REMOVE` (above)

A single user action often produces several frames in the same second — starting a timer emits a
`TIMER/INSERT` followed by a `DEVICE/MODIFY`, and each schedules its own reconciling refresh.

Realtime device frames can **lag actual state**. At a timer expiry, the accompanying `DEVICE/MODIFY`
still reported both bays active; only the REST refresh two seconds later showed them stopped. This
is the argument for keeping the reconciling refresh even though it is also what destroys exact
intensity.

The socket closes roughly **every ten minutes** with code `1001 "Going away"` and reconnects within a
few seconds. Observed thirteen times across a 2.5 hour idle window, so it is routine rather than a
fault — but it is frequent enough to matter: each cycle drops polling to the disconnected interval
and back, and any refresh scheduled in between has to be moved onto the new cadence or it fires at
the short interval anyway.

## Models

`hwVersion` major maps to product name:

| Major | Model |
| ---: | --- |
| 1 | Pura Car |
| 2, 3 | Pura 3 |
| 4 | Pura 4 |
| 22 | Pura Plus |
| 26 | Pura Mini |
| 27 | Pura Car Pro |

**Pura Home is not in this map** — its hardware major is unknown, so it falls through to a generic
`Pura <major>` label. It has two bays and a nightlight; a `hwVersion` from an owner's debug log is
all that is needed to name it correctly.

Nightlight support is inferred as "everything except Pura Plus / hardware major 22". This is
permissive by design, so unknown hardware gets controls offered rather than withheld.

## Payloads are partial, and silence is not information

Neither transport reports a complete bay every time, and the gaps do **not** mean what they look
like. All of the following were observed while a full 100% vial was physically seated:

| Source | What arrives | What it is not |
| --- | --- | --- |
| Realtime `deviceRecord` | bay present with `intensity`, **no** `fragrance`, `remaining`, or `lowFragrance` | not an empty bay |
| Reconciling REST refresh | bay key **absent entirely** from the record | not a removed bay |
| REST at startup | bay complete, with fragrance and remaining | — |

The reconciling refresh dropping a bay is the surprising one: the same endpoint returned that bay
fully populated seconds earlier. Bay data has to be treated as sticky — carry the last thing the
device actually said until it says something new — or a bay loses its name, reads off, and refuses
to run every time one of these lands.

A bay carried forward from cache should be marked inactive: in every observation the dropped bay was
not the one diffusing.

### `vialId` is the empty-bay signal

Absence never means empty, but `vialId` does. Verified as a controlled comparison — same bay, same
transport, same fragrance-absent realtime shape — with the vial out and then re-seated:

| | `vialId` | `isSmartVial` | `wearingTime` | `code` |
| --- | --- | --- | ---: | --- |
| vial seated | `"E00208…"` | `true` | non-zero | set |
| vial pulled | `""` | `false` | `0` | `""` |

A seated vial reports its hardware id **even in the realtime frames that omit the fragrance block**,
so `vialId` survives exactly the partial payloads that defeat everything else. An empty bay reports
an empty string with every other field zeroed.

So there are two positive empty signals, and only these two:

```
bay.vialId === ''            -> empty, no vial seated
bay.remaining.percent === 0  -> seated but spent
```

Everything else — a missing fragrance block, `bay: null`, a bay dropped from a refresh — occurs
routinely with a full vial in and must not be read as empty.

`vialId` is also the right cache key for anything remembered per bay: a changed id is a new vial, so
a remembered fragrance name must not carry across it.

## Fragrance remaining cannot be shown in the Home app

Tried three ways during 1.8.0's alphas and abandoned. Recorded so nobody spends the time again:

| Service | What Home does |
| --- | --- |
| `FilterMaintenance` (per bay, linked to the bay's control) | Renders **nothing**. Home surfaces filter state only inside an air purifier. Eve and Controller for HomeKit do show it. |
| `Battery` (per bay) | Renders **one** figure for the whole accessory — both bay tiles showed the same number, whichever service Home picked. |
| `Battery` (one, lowest seated bay) | Works, but says nothing about *which* bay. |
| `AirPurifier` for each bay | Not attempted. It is the one place Home shows filter state, but it makes a diffuser an "air purifier" to Home and Siri and drags in a required Auto/Manual control with no per-bay meaning — and it may still show only a replace flag rather than a percentage. |

The remaining option that does render per bay is putting the percentage in the service name
(`Volcano 24%`), which works — `ConfiguredName` updates propagate, see below — but degrades Siri
matching and fights a user who renames a tile.

`remaining.percent` and `lowFragrance` are still parsed: a bay reporting 0% is one of the two signals
that it cannot diffuse. They are simply not published as a HomeKit service.

## HomeKit naming (not Pura, but equally expensive to re-derive)

**The Home app does follow a `ConfiguredName` update on an existing service.** This was the open
question behind naming bays after their fragrance, and it was not safe to assume either way — Home
caches service names and is widely reported to ignore later changes, particularly once a user has
renamed something themselves.

Verified on a Pura 4 with two bay tiles:

1. Both bays held the same scent, so both tiles correctly showed `Bay 1` / `Bay 2` (a shared name
   does not distinguish the bays, so the plugin falls back to positional).
2. Pulling the vial from bay 2 made bay 1's scent distinguishing. Bay 1 renamed to
   `Coconut Milk Mango` and **Home picked it up**.
3. Inserting a different vial in bay 2 renamed that tile to `Volcano`, again reflected in Home.

So a fragrance-derived name can be kept current across a vial swap and does not go stale. Two
caveats worth keeping in mind:

- `Name` alone is not enough. Home ignores `Name` for services nested inside an accessory; the
  rename only lands because `ConfiguredName` is set alongside it.
- This was observed on services the plugin had created in that same install. A user who renames a
  tile themselves in Home may well pin it, which the plugin cannot detect. Renames are logged
  (`renamed bay N from "X" to "Y"`) so a divergence is at least visible in the log.

## Known rough edges

Things confirmed to be wrong or incoherent, left in place because fixing them changes visible
behaviour:

- **`normalizeDeviceRecord` still collapses bays in `standard` mode.** When both bays report active
  it zeroes one, chosen by `activeAt` and then by intensity, which also discards that bay's
  intensity. Disabled in auto-alternate mode, where per-bay intensities have to survive. Harmless
  today because per-bay reads fall back to the cached intensity, but it is a lossy step that only
  exists to prop up the single-accessory view.
- **`exactIntensity` survives that collapse**, so a zeroed bay reads
  `active: false, intensity: 0, exactIntensity: 60`.
- **`bay.id`** is Pura's internal record id (a large integer), not the bay number.
- **`device.awayMode`** is typed `boolean` but arrives as an object, e.g. `{away, enabled}`.
