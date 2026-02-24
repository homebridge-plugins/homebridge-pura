# Release Notes

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
