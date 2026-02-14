# Release Notes

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
