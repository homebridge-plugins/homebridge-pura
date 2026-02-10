# Release Notes

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
