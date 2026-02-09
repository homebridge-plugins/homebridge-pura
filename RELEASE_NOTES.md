# Release Notes

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
