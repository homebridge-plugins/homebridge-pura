# Release Notes

## Unreleased
- Draw the custom UI's icons inline instead of relying on the Homebridge UI's icon font. The plugin's settings page runs in an iframe and has no icon font of its own, and the host appears to inject only the glyphs it uses itself: `fa-eye` and `fa-spinner` rendered while `fa-user-circle` did not, leaving the Verify button showing a missing-glyph box. The icons are now self-contained SVG that inherit the button's colour, so they cannot regress when the host changes.

## 1.7.0 - 2026-08-30
- Stop trying two retired device-list endpoints. A Pura outage revealed that `users/devices` answers `400 getDevicesAndMigrate() Error` and `devices` answers `404`, so walking them only delayed an already failing cycle. The failure reported is now the primary endpoint's rather than the last one's, which also stops a transient timeout being misreported as a hard failure and losing the degraded-fetch handling that preserves cached accessories.
- Stop a realtime reconnect firing an extra poll. Pura's socket closes every few minutes, and each close left a refresh scheduled at the disconnected 15s cadence which still fired after reconnecting. An idle diffuser was making roughly twice the API requests it needed.
- Only re-authenticate when pypura's Cognito IDs actually change. The hourly check compared pypura's version string alone, so every unrelated release discarded a working session and forced a full re-authentication. Authentication recovery no longer retries with IDs that are already in use either, since that cannot succeed.
- Fetch the device list from `v3/accounts/v2/devices`, the endpoint pypura moved to in August 2026 to fix "compatibility and reliability when loading devices". The previous `v2/users/devices` path is retained as a fallback, and the endpoint that actually served the list is reported in debug output.
- Authenticate API requests with the Cognito ID token. Pura rejects the access token even when it is freshly issued, so every request was answered with a 401, followed by a needless token refresh, a second 401, and only then a successful retry. Each call cost three round trips instead of one. The access token is retained as a fallback. (pypura authenticates the same way.)
- Report numeric bay intensity on Pura's 1-10 scale. Every level from 1 to 10 previously fell into the same coarse bucket, so a diffuser running at maximum output reported "Subtle" in HomeKit. ([#35](https://github.com/homebridge-plugins/homebridge-pura/pull/35))
- Keep standard-mode diffusion active for the whole session. Pura holds `activeAt` at the session's original start time and clears it to `0` on stop, so the previous 15-minute window reported long-running sessions as off. The window is widened rather than removed, so a stale timestamp still ages out instead of pinning the diffuser on. ([#35](https://github.com/homebridge-plugins/homebridge-pura/pull/35))
- Apply realtime `TIMER` events immediately, so a timed diffusion started from the Pura app shows up in HomeKit without waiting for the next poll. Timers scheduled for later, or already elapsed, are ignored.
- Read fragrance remaining level, low-fragrance status and exact intensity from the API. These are recorded in debug output and are not yet surfaced as HomeKit characteristics. ([#35](https://github.com/homebridge-plugins/homebridge-pura/pull/35))
- Add `npm test`, covering intensity scaling, session-state inference and realtime timer handling.
- Replace the supported-devices image in the README with a table listing each diffuser's bays, intensity control and nightlight support.
- Refresh runtime dependencies: `tar`, `ws` and `amazon-cognito-identity-js` (which picks up `js-cookie` 3.x).
- Refresh development dependencies: `typescript-eslint`, `@types/node` and `nodemon` (which picks up `brace-expansion` 5.0.8).
- Drop `@types/tar`. `tar` v7 ships its own type definitions, so the DefinitelyTyped stub was stale v6 typing shadowing the real thing.
- Drop the `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` development dependencies. Only the `typescript-eslint` meta-package is imported by `eslint.config.js`, and declaring all three pinned conflicting versions that blocked dependency updates.

## 1.6.10 - 2026-06-30
- Fix accessory persistence on Homebridge 2.1+. The diffuser was re-created on every child-bridge restart, logging `Cannot serialize accessory … - missing associated plugin` and a spurious switch-mode "migration". The accessory handler no longer persists revision metadata before the accessory is registered, so Homebridge can serialize the cached accessories successfully. ([#24](https://github.com/homebridge-plugins/homebridge-pura/issues/24))
- Bump the `homebridge` development/test dependency to `2.1.0` so CI exercises the stable release users run.

## 1.6.9 - 2026-03-01
- Treat transient Pura cloud HTTP failures (`408`, `429`, `500`, `502`, `503`, `504`) as temporary availability issues during device refresh.
- Reduce error-log noise for transient device-list fetch failures while preserving retry/fallback behavior and degraded-cycle handling.
- Update Homebridge UI input field styling to use `0.25rem` corner radius.
- Refine Homebridge UI form spacing by tightening helper-text line height and label bottom margin.

## 1.6.6 - 2026-02-26
- Introduce **Intensity Control** mode that changes each diffuser from an on/off switch to a HomeKit fan accessory.
- Map fan `RotationSpeed` to Pura intensity levels (`30` subtle, `50` medium, `100` strong), with multi-bay syncing.
- Improve fan-mode startup behavior and logging so quick power-on + slider updates settle to the final intended intensity.
- Improve unavailable/offline handling for diffuser controls so Home app behavior is more consistent during disconnects.
- Improve nightlight synchronization and logging around diffuser transitions, including clearer auto-off messaging when enabled.
- Refresh Homebridge UI option wording/documentation for the Intensity Control fan accessory mode.

## 1.6.6-alpha.0 - 2026-02-24
- Infer diffuser on-state from recent `activeAt` timestamps even when intensity briefly reports `0`, preventing false-off in HomeKit during realtime dropouts.
- Same nightlight improvements from 1.6.4 (snap levels, color, bounce mitigation, UI toggles).

## 1.6.4 - 2026-02-24
- Add optional `Nightlight Control` light service (opt-in via `enableNightlightAccessory`) for compatible diffusers.
- Support nightlight On/Off, Brightness (snapped to 10-step levels: 10%, 20%, ..., 100%), and Color (Hue/Saturation).
- Reduce HomeKit state bouncing during nightlight changes by serializing writes and stabilizing against out-of-order cloud updates.
- Update Homebridge UI config to include nightlight toggles and allow saving without re-verifying credentials when unchanged.
- Update README and config schema for the new nightlight controls.

## 1.6.4-alpha.0 - 2026-02-24
- Add optional Nightlight Lightbulb service (opt-in via `enableNightlightAccessory` config).
- Add detailed nightlight debug logging and round-trip profiling to map HomeKit brightness writes to cloud-reported levels.
- Add API-side nightlight request/response debug payload logging for level-mapping diagnostics.
- Update config schema and README for the new nightlight accessory option.

## 1.6.3 - 2026-02-21
- Improve offline inference when cloud `online` status appears stale:
  - Treat devices as unavailable when payload reports `online=true` but bay payload is empty for an extended period.
  - Surface this inferred unavailable state consistently in HomeKit read paths to reduce false "online" behavior.

## 1.6.2 - 2026-02-20
- Limit auto-alternate recommendation messaging to models that support the feature (Pura 4 / Pura Plus).

## 1.6.1 - 2026-02-20
- Merge dependency update PR:
  - `tar` from `7.5.7` to `7.5.8`.
- Improve offline detection reliability by preserving explicit `online=false` values from API payloads.
- Improve Home app behavior for unavailable devices:
  - Turn-on attempts now short-circuit cleanly when device is offline or no scent vials are detected.
  - Force visual state back to off to reduce optimistic on-state flicker.
- Improve user-facing recommendation logs for Away mode and Auto-alternate fragrances, including clearer wording and webhook-transition messaging.
- Update README guidance.

## 1.6.0 - 2026-02-19
- Improve no-vial handling so turn-on requests short-circuit cleanly instead of cascading API errors.
- Keep Home app behavior stable when no vials are installed or device is offline (avoid error-driven flicker/no-response behavior from this path).
- Surface HomeKit fault state (`StatusFault`) for no-vial and offline conditions so users get a visible in-app problem indicator.
- Add clearer runtime messaging for unavailable conditions:
  - `No scent vials detected on <Device Name>.`
  - `<Device Name> appears offline (Wi-Fi lost or unplugged).`

## 1.5.5 - 2026-02-18
- Improve device-list fetch resiliency when Pura API returns transient `ThingTypeError` during add/remove device changes:
  - Retry `v2/users/devices` after a short delay.
  - Fall back to compatibility endpoints (`users/devices`, `devices`) when needed.
  - Gracefully skip the cycle (instead of hard-failing) when backend thing-type mismatches persist.
- Reconcile accessories on every refresh cycle so newly added devices are auto-registered and removed devices are unregistered without manual accessory-cache cleanup.
- Skip forced nightlight-off requests for Pura Plus devices (including `hwVersion` major `22`) to avoid `400` route errors on unsupported nightlight control.

## 1.5.0 - 2026-02-14
- Improve firmware revision reliability across restarts by hydrating cached Accessory Information revisions at startup.
- Persist accessory cache updates when revision characteristics change to prevent stale `0.0` display.
- Add debug revision tracing and persistence logs for faster diagnosis of firmware metadata issues.
- Update Homebridge schema branding/header behavior and banner sizing for better UI compatibility.
- Bump Homebridge dev dependency to `2.0.0-beta.71`.

## 1.4.10 - 2026-02-14
- Fix CI/npm install failure by restoring ESLint toolchain compatibility:
  - `eslint` reverted to `^9.39.2`
  - `@eslint/js` reverted to `^9.39.2`
- Keep `typescript-eslint@^8.55.0` peer dependency constraints satisfied.

## 1.4.9 - 2026-02-14
- Fix firmware/hardware revision cache persistence by avoiding premature context writes before change detection.
- Preserve firmware revision values across Homebridge restarts to prevent fallback to `0.0` on cached accessories.
- Update schema branding raw GitHub URLs to use the `latest` branch path.

## 1.4.8 - 2026-02-14
- Fix cached accessory firmware revision propagation by updating both `FirmwareRevision` and `SoftwareRevision`.
- Prefer API `firmwareVersion` over `fwVersion` in debug snapshot model fields.
- Add `.nvmrc` pinned to Node `24.13.0` for consistent local development setup.

## 1.4.7 - 2026-02-12
- Prefer API `firmwareVersion` with `fwVersion` fallback to improve firmware extraction reliability.
- Stop defaulting firmware to `1.0.0`; only set HomeKit firmware when a validated value exists.
- Add raw payload and last-known-good fallback in accessory firmware mapping to avoid transient `1.0` display.

## 1.4.6 - 2026-02-12
- Use only API `firmwareVersion` for HomeKit firmware reporting and remove alternate firmware-field fallbacks.
- Stop writing `SoftwareRevision`/`HardwareRevision`; update only `FirmwareRevision` to avoid `0.0` display conflicts.
- Include README documentation updates.

## 1.4.5 - 2026-02-11
- Tighten firmware-version normalization to prevent `0.0` regressions from non-firmware fields.
- Refresh branding assets and README image usage updates.

## 1.4.4 - 2026-02-11
- Prevent startup crash-restart loops when required config is missing.
- Validate missing `username`/`password` at startup, log actionable errors, and disable discovery safely instead of throwing.

## 1.4.3 - 2026-02-11
- Fix config schema `required` validation by using object-level required fields.
- Add/adjust GitHub Actions release workflow to auto-create GitHub Releases from pushed version tags.

## 1.4.2 - 2026-02-11
- Force Accessory Information revision propagation by updating `FirmwareRevision`, `SoftwareRevision`, and `HardwareRevision` (when available) on initialization and refresh.
- Use `updateCharacteristic` alongside `setCharacteristic` for revision fields to improve Home app refresh behavior.

## 1.4.1 - 2026-02-11
- Set both `FirmwareRevision` and `SoftwareRevision` in Accessory Information to improve Home app version display consistency.
- Harden firmware normalization to reject all-zero version forms (for example `0.0`, `0.00`, `0.0.0`) and add `swVersion`/`softwareVersion` fallback fields.
- Switch schema branding image/icon references to absolute GitHub raw URLs for better Homebridge UI compatibility.

## 1.4.0 - 2026-02-11
- Reduce realtime websocket log noise in normal mode; keep close-code details in debug mode.
- Preserve last known good firmware revision and ignore placeholder values (for example `0`).
- Improve Homebridge UI branding compatibility by using `branding/*` asset paths and additional schema key variants.

## 1.3.11 - 2026-02-10
- Use `./img/` relative paths for branding assets in schema.

## 1.3.10 - 2026-02-10
- Add banner image branding path for UI X.

## 1.3.9 - 2026-02-10
- Resize branding icons to 256x256 for UI compatibility.

## 1.3.8 - 2026-02-10
- Add `x-icon`/`iconPath` hints for Homebridge UI icon compatibility.

## 1.3.7 - 2026-02-10
- Add `img/icon.png` and schema branding path for UI icon compatibility.

## 1.3.6 - 2026-02-10
- Reduce log noise; keep device snapshots and API details in debug mode.
- Add concise on/off action logs and hourly realtime stability info.

## 1.3.5 - 2026-02-10
- Add intent settle window to suppress stale refresh/realtime updates after a user toggle.

## 1.3.4 - 2026-02-10
- Use Switch service by default to reduce HomeKit bounce; `useFanService` can restore Fanv2.

## 1.3.3 - 2026-02-10
- Revert to v1.2.3 behavior for stability (realtime + polling balance).

## 1.2.3 - 2026-02-10
- Further reduce startup refresh chatter when realtime connects quickly.
- Reduce duplicate refreshes by debouncing realtime-triggered refreshes.
- Avoid redundant startup refreshes when realtime is connected.
- Remove legacy Switch service to avoid duplicate accessories.

## 1.1.17 - 2026-02-09
- Enforce `forceNightlightOff` on status refresh when the diffuser is turned on from the Pura app.

## 1.1.16 - 2026-02-09
- Only use `activeAt` to infer on-state for standard diffusion mode to avoid stale "on" after manual off.

## 1.1.15 - 2026-02-09
- Use a 60-minute `activeAt` window for standard diffusion mode only when online.

## 1.1.14 - 2026-02-09
- Map diffuser models from `hwVersion` major value (Pura 3/4/Plus/Mini/etc.), with fallbacks.

## 1.1.13 - 2026-02-09
- Add debug logging of model-related fields from the raw API payload.

## 1.1.12 - 2026-02-09
- Treat inferred activity as on even if bay reports active=false when other signals indicate it is running.

## 1.1.11 - 2026-02-09
- Treat oscillation state as active when diffusion mode is multi-bay.

## 1.1.10 - 2026-02-09
- Treat bay `activeAt` timestamps within 5 minutes (past or future) as active to handle clock skew.

## 1.1.9 - 2026-02-09
- Add debug logging for bay status to diagnose startup state mismatches.

## 1.1.8 - 2026-02-09
- Trigger immediate and delayed status refresh on startup to avoid stale "off" states.

## 1.1.7 - 2026-02-09
- Serialize authentication refresh/update to avoid "Not authenticated" races during status refresh.

## 1.1.6 - 2026-02-09
- Use access token for API auth and retry on 401 with refresh + ID-token fallback.

## 1.1.5 - 2026-02-07
- Fix bay active inference null check to satisfy TypeScript and ensure reliable inference.

## 1.1.4 - 2026-02-07
- Improve status refresh reliability by retrying authentication on auth failures.
- Infer active bay from non-zero intensity when the API omits explicit active flags, reducing "stuck off" states after bay switches.
