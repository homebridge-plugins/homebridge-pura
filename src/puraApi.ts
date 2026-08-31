/**
 * Pura API Client
 * Based on pypura library: https://github.com/natekspencer/pypura
 */

import { Logging } from 'homebridge';
import { 
  CognitoUserPool, 
  CognitoUser, 
  AuthenticationDetails,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';
import fetch, { RequestInit } from 'node-fetch';
import { PuraBay, PuraDevice, PuraAuthTokens, PuraNightlight, PuraTimer, PuraFragrance } from './puraTypes.js';

// Defaults from pypura
const DEFAULT_USER_POOL_ID = 'us-east-1_LaB718hYv'; // Base64 decoded from pypura
const DEFAULT_CLIENT_ID = '4iekubat0jb5iljfbaalsiqf9j'; // Base64 decoded from pypura
const DEFAULT_BASE_URL = 'https://trypura.io/mobile/api/';

export function mapPuraNumericIntensityToHomeKit(intensity: unknown): 20 | 40 | 60 | 80 | 100 | null {
  const numeric = Number(intensity);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 10) {
    return null;
  }
  if (numeric <= 1) {
    return 20;
  }
  if (numeric <= 3) {
    return 40;
  }
  if (numeric <= 5) {
    return 60;
  }
  if (numeric <= 7) {
    return 80;
  }
  return 100;
}

/**
 * Device list endpoints, tried in order.
 *
 * `v3/accounts/v2/devices` is what pypura moved to in August 2026, replacing `v2/users/devices` in a
 * change it described as a fix for "compatibility and reliability when loading devices". Note the
 * path still says v2 for the device representation: it is the v3 accounts service returning the
 * same device shape, which is why pypura changed only the URL and no response parsing.
 *
 * `v2/users/devices` is kept behind it so a v3 failure degrades rather than losing every accessory.
 *
 * Two older paths used to sit behind those and have been removed: during a Pura outage they were
 * observed returning `400 {"message":"getDevicesAndMigrate() Error"}` and
 * `404 Cannot GET /mobile/api/devices` respectively. They are retired server-side, so trying them
 * only added latency to an already failing cycle and buried the real cause behind a 404.
 */
export const DEVICE_LIST_ENDPOINTS = [
  'v3/accounts/v2/devices',
  'v2/users/devices',
];

export class PuraApi {
  private userPool: CognitoUserPool;
  private cognitoUser: CognitoUser | null = null;
  private session: CognitoUserSession | null = null;
  private refreshInFlight: Promise<PuraAuthTokens> | null = null;
  private readonly log: Logging;
  private readonly baseUrl: string;
  private userPoolId: string;
  private clientId: string;
  private lastDevicesFetchDegraded = false;
  private lastDevicesEndpoint: string | null = null;

  constructor(log: Logging) {
    this.log = log;
    this.userPoolId = DEFAULT_USER_POOL_ID;
    this.clientId = DEFAULT_CLIENT_ID;
    this.baseUrl = DEFAULT_BASE_URL;

    this.userPool = new CognitoUserPool({
      UserPoolId: this.userPoolId,
      ClientId: this.clientId,
    });
  }

  /**
   * Adopt Cognito IDs discovered from pypura. Returns whether anything actually changed.
   *
   * pypura publishes releases regularly without touching these IDs, so keying off its version
   * alone discarded a working session and forced a full re-authentication for nothing.
   */
  updateCognitoConfig(userPoolId: string, clientId: string): boolean {
    if (this.userPoolId === userPoolId && this.clientId === clientId) {
      return false;
    }
    this.userPoolId = userPoolId;
    this.clientId = clientId;
    this.userPool = new CognitoUserPool({
      UserPoolId: userPoolId,
      ClientId: clientId,
    });
    this.cognitoUser = null;
    this.session = null;
    this.refreshInFlight = null;
    return true;
  }

  /**
   * Authenticate with Pura API
   */
  async authenticate(username: string, password: string): Promise<PuraAuthTokens> {
    return new Promise((resolve, reject) => {
      const authenticationDetails = new AuthenticationDetails({
        Username: username,
        Password: password,
      });

      this.cognitoUser = new CognitoUser({
        Username: username,
        Pool: this.userPool,
      });

      this.cognitoUser.authenticateUser(authenticationDetails, {
        onSuccess: (session) => {
          this.session = session;
          this.log.debug('Pura authentication successful');
          resolve({
            accessToken: session.getAccessToken().getJwtToken(),
            idToken: session.getIdToken().getJwtToken(),
            refreshToken: session.getRefreshToken().getToken(),
          });
        },
        onFailure: (err) => {
          this.log.error('Pura authentication failed:', err.message);
          reject(new Error(`Pura authentication failed: ${err.message}`));
        },
      });
    });
  }

  /**
   * Refresh authentication tokens
   */
  async refreshToken(): Promise<PuraAuthTokens> {
    if (!this.cognitoUser || !this.session) {
      throw new Error('Not authenticated');
    }

    return new Promise((resolve, reject) => {
      const refreshToken = this.session!.getRefreshToken();
      
      this.cognitoUser!.refreshSession(refreshToken, (err, session) => {
        if (err) {
          this.log.error('Token refresh failed:', err.message);
          reject(new Error(`Token refresh failed: ${err.message}`));
          return;
        }

        this.session = session;
        this.log.debug('Pura token refresh successful');
        resolve({
          accessToken: session.getAccessToken().getJwtToken(),
          idToken: session.getIdToken().getJwtToken(),
          refreshToken: session.getRefreshToken().getToken(),
        });
      });
    });
  }

  /**
   * Describe the current session's expiry without ever emitting the tokens themselves. Cognito
   * expirations are epoch seconds; a negative remaining value means the token is genuinely stale.
   */
  private describeSessionState(): string {
    if (!this.session) {
      return 'no session';
    }
    try {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const accessExp = this.session.getAccessToken().getExpiration();
      const idExp = this.session.getIdToken().getExpiration();
      return (
        `session.isValid=${this.session.isValid()} ` +
        `accessTokenExpiresIn=${accessExp - nowSeconds}s ` +
        `idTokenExpiresIn=${idExp - nowSeconds}s`
      );
    } catch (error) {
      return `session state unavailable (${error instanceof Error ? error.message : String(error)})`;
    }
  }

  private async refreshTokenWithLock(): Promise<PuraAuthTokens> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.refreshToken().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  /**
   * Get authorization header for API requests
   */
  /**
   * Pura's API authenticates with the Cognito ID token, not the access token. pypura does the
   * same (`auth_token_type=TokenType.ID_TOKEN`). Sending the access token returns 401 even when it
   * is freshly issued, so it is kept only as a fallback in case an endpoint ever disagrees.
   */
  private getAuthHeader(tokenType: 'id' | 'access' = 'id'): string {
    if (!this.session) {
      throw new Error('Not authenticated');
    }
    if (tokenType === 'access') {
      return `Bearer ${this.session.getAccessToken().getJwtToken()}`;
    }
    return `Bearer ${this.session.getIdToken().getJwtToken()}`;
  }

  getIdToken(): string | null {
    if (!this.session) {
      return null;
    }
    return this.session.getIdToken().getJwtToken();
  }

  /**
   * Make authenticated API request
   */
  private async makeRequest(
    method: string,
    endpoint: string,
    data?: unknown,
    options?: { suppressHttpErrorLog?: boolean; suppressTransportErrorLog?: boolean; timeoutMs?: number },
  ): Promise<unknown> {
    const url = new URL(endpoint, this.baseUrl).toString();
    const timeoutMs = Math.max(1000, options?.timeoutMs ?? 5000);

    const isGet = method.toLowerCase() === 'get';
    const buildOptions = (authorization: string): RequestInit => {
      const options: RequestInit = {
        method: method.toUpperCase(),
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
        },
      };
      if (data && !isGet) {
        options.body = JSON.stringify(data);
      }
      return options;
    };

    const doRequest = async (authorization: string) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        const response = await fetch(url, { ...buildOptions(authorization), signal: controller.signal });
        const responseText = await response.text();
        return { response, responseText };
      } finally {
        clearTimeout(timeout);
      }
    };

    try {
      // First attempt with the ID token, which is what Pura's API accepts.
      let { response, responseText } = await doRequest(this.getAuthHeader());

      // If unauthorized, try refresh then retry once.
      if (response.status === 401) {
        // A 401 here should be rare. Report the session's own view of expiry so a genuinely
        // expired token can be told apart from one Pura rejects for another reason.
        this.log.debug(
          `[Auth] 401 on ${method.toUpperCase()} ${endpoint} using the ID token. ` +
          `${this.describeSessionState()}. Refreshing and retrying.`,
        );
        try {
          await this.refreshTokenWithLock();
          ({ response, responseText } = await doRequest(this.getAuthHeader()));
          this.log.debug(
            `[Auth] Retry after refresh returned ${response.status} for ${endpoint}. ` +
            `${this.describeSessionState()}`,
          );
        } catch (refreshError) {
          this.log.debug('Token refresh failed during request retry:', refreshError);
        }
      }

      // If still unauthorized, fall back to the access token in case an endpoint disagrees.
      if (response.status === 401) {
        this.log.debug(
          `[Auth] Still 401 after refresh on ${endpoint}; falling back to the access token. ` +
          'If this is the path that succeeds, this endpoint wants the access token and the ' +
          'token preference needs revisiting.',
        );
        ({ response, responseText } = await doRequest(this.getAuthHeader('access')));
        this.log.debug(`[Auth] Access token fallback returned ${response.status} for ${endpoint}.`);
      }

      if (!response.ok) {
        if (!options?.suppressHttpErrorLog) {
          this.log.error(`API request failed: ${response.status} - ${responseText}`);
        }
        throw new Error(`API request failed: ${response.status} - ${responseText}`);
      }

      try {
        const result = responseText ? JSON.parse(responseText) : {};
        return result;
      } catch (error) {
        this.log.warn('API response was not JSON', { url });
        return responseText;
      }
    } catch (error) {
      if (!options?.suppressTransportErrorLog) {
        this.log.error('API request error:', error);
      }
      throw error;
    }
  }

  /**
   * Get all devices
   */
  async getDevices(): Promise<PuraDevice[]> {
    this.lastDevicesFetchDegraded = false;
    const endpoints = DEVICE_LIST_ENDPOINTS;
    let lastError: unknown;
    // Errors from later endpoints say nothing useful about why the request failed, and letting one
    // of them decide the outcome misreports a transient primary timeout as a hard failure.
    let primaryError: unknown;

    for (let i = 0; i < endpoints.length; i++) {
      const endpoint = endpoints[i];
      try {
        const response = await this.makeRequest('GET', endpoint, undefined, {
          suppressHttpErrorLog: true,
          suppressTransportErrorLog: true,
          timeoutMs: 7000,
        }) as Record<string, unknown>;
        const devices = this.extractDevices(response);
        if (this.lastDevicesEndpoint !== endpoint) {
          this.lastDevicesEndpoint = endpoint;
          this.log.debug(`[Devices] Served by ${endpoint} (${devices.length} device(s)).`);
        }
        return devices;
      } catch (error) {
        lastError = error;
        const isPrimaryEndpoint = i === 0;
        if (isPrimaryEndpoint) {
          primaryError = error;
        }
        if (this.isTransientNetworkError(error)) {
          this.log.warn(`Pura devices endpoint temporarily unavailable (${endpoint}). Retrying shortly...`);
          await this.delay(1500);
          try {
            const retryResponse = await this.makeRequest('GET', endpoint, undefined, {
              suppressHttpErrorLog: true,
              suppressTransportErrorLog: true,
              timeoutMs: 7000,
            }) as Record<string, unknown>;
            return this.extractDevices(retryResponse);
          } catch (retryError) {
            lastError = retryError;
          }
          if (!isPrimaryEndpoint) {
            this.log.debug(`Compatibility endpoint timeout (${endpoint}):`, lastError);
            continue;
          }
          this.log.warn('Primary devices endpoint still timing out. Trying compatibility endpoint.');
          continue;
        }
        if (isPrimaryEndpoint && this.isThingTypeError(error)) {
          this.log.warn('Pura devices endpoint returned ThingTypeError. Retrying primary endpoint after brief delay.');
          await this.delay(1500);
          try {
            const retryResponse = await this.makeRequest('GET', endpoint, undefined, {
              suppressHttpErrorLog: true,
              suppressTransportErrorLog: true,
              timeoutMs: 7000,
            }) as Record<string, unknown>;
            return this.extractDevices(retryResponse);
          } catch (retryError) {
            lastError = retryError;
          }
          this.log.warn('Primary endpoint still failing after ThingTypeError retry. Trying compatibility endpoint.');
          continue;
        }
        if (!isPrimaryEndpoint) {
          this.log.debug(`Compatibility endpoint failed (${endpoint}):`, error);
          continue;
        }
        throw error;
      }
    }

    const reportedError = primaryError ?? lastError;

    if (this.isTransientNetworkError(reportedError)) {
      this.lastDevicesFetchDegraded = true;
      this.log.warn('Pura devices endpoint temporarily unavailable. Returning no device updates this cycle.');
      return [];
    }

    if (this.isThingTypeError(reportedError)) {
      this.lastDevicesFetchDegraded = true;
      this.log.warn('Pura API rejected one or more device thing types. Returning no devices this cycle.');
      return [];
    }

    throw (reportedError instanceof Error ? reportedError : new Error('Failed to get devices'));
  }

  wasLastDevicesFetchDegraded(): boolean {
    return this.lastDevicesFetchDegraded;
  }

  private extractDevices(response: Record<string, unknown>): PuraDevice[] {
    const devices = (response as { devices?: unknown[] }).devices;
    const rawDevices: unknown[] = [];
    if (Array.isArray(devices)) {
      rawDevices.push(...devices);
    } else {
      for (const [key, value] of Object.entries(response)) {
        if (key === 'car') {
          continue;
        }
        if (Array.isArray(value)) {
          rawDevices.push(...value);
        }
      }
    }
    return rawDevices
      .map((device) => this.normalizeDevice(device))
      .filter((device): device is PuraDevice => device !== null);
  }

  private isThingTypeError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    return error.message.toLowerCase().includes('thingtypeerror');
  }

  private isTransientNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const message = error.message.toLowerCase();
    const httpStatusMatch = message.match(/api request failed:\s*(\d{3})/i);
    if (httpStatusMatch) {
      const status = Number(httpStatusMatch[1]);
      if ([408, 429, 500, 502, 503, 504].includes(status)) {
        return true;
      }
    }
    return message.includes('etimedout')
      || message.includes('econnreset')
      || message.includes('eai_again')
      || message.includes('fetch failed')
      || message.includes('network timeout')
      || message.includes('socket hang up')
      || message.includes('aborted')
      || message.includes('aborterror');
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private normalizeDevice(device: unknown): PuraDevice | null {
    if (!device || typeof device !== 'object') {
      return null;
    }
    const record = device as Record<string, unknown>;
    const id = (record.id || record.deviceId) as string | undefined;
    if (!id) {
      return null;
    }

    const displayName = record.displayName;
    let name: string | undefined;
    if (typeof displayName === 'string') {
      name = displayName;
    } else if (displayName && typeof displayName === 'object') {
      const displayRecord = displayName as Record<string, unknown>;
      if (typeof displayRecord.name === 'string') {
        name = displayRecord.name;
      } else if (typeof displayRecord.value === 'string') {
        name = displayRecord.value;
      }
    }
    const deviceName = typeof record.deviceName === 'string' ? record.deviceName : undefined;
    if (!name && deviceName) {
      name = deviceName;
    }


    const firmwareVersion =
      this.normalizeFirmwareVersion(record.firmwareVersion) ??
      this.normalizeFirmwareVersion(record.fwVersion);
    const deviceVersion = (record.deviceVer || record.version) as string | undefined;
    const hwVersion = record.hwVersion as string | undefined;
    const type = (record.type || record.model || 'Pura Diffuser') as string;

    const defaultNightlight = (record.deviceDefaults as Record<string, unknown> | undefined)?.nightlight;
    const nightlight = (record.nightlight ?? defaultNightlight) as PuraNightlight | undefined;

    const bay1 = this.normalizeBay(record, record.bay1, 1);
    const bay2 = this.normalizeBay(record, record.bay2, 2);
    if (bay1 && bay2 && bay1.active && bay2.active) {
      const bay1Stamp = bay1.activeAt ?? 0;
      const bay2Stamp = bay2.activeAt ?? 0;
      const keepBay = bay1Stamp === bay2Stamp
        ? (bay1.intensity >= bay2.intensity ? 1 : 2)
        : (bay1Stamp > bay2Stamp ? 1 : 2);
      if (keepBay === 1) {
        bay2.active = false;
        bay2.intensity = 0;
      } else {
        bay1.active = false;
        bay1.intensity = 0;
      }
    }

    const onlineState = this.resolveOnlineState(record);

    return {
      id,
      name: name ?? `Pura ${id}`,
      type: this.normalizeModel(this.resolveModelLabel(type, deviceVersion, hwVersion)),
      version: deviceVersion ?? '',
      controller: typeof record.controller === 'string' ? record.controller : undefined,
      diffusionMode: typeof record.diffusionMode === 'string' ? record.diffusionMode : undefined,
      state: {
        battery: (record.batteryRemaining || record.battery) as number | undefined,
        firmwareVersion,
        lastSeen: record.lastConnectedAt ? String(record.lastConnectedAt) : undefined,
        online: onlineState,
      },
      bay1,
      bay2,
      nightlight,
      awayMode: record.awayMode as boolean | undefined,
      ambientMode: record.ambientMode as boolean | undefined,
      online: onlineState,
      __raw: record,
    };
  }

  public normalizeDeviceRecord(device: unknown): PuraDevice | null {
    return this.normalizeDevice(device);
  }

  private normalizeFirmwareVersion(value: unknown): string | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return undefined;
    }
    const normalized = String(value).trim();
    if (!normalized) {
      return undefined;
    }
    const lowered = normalized.toLowerCase();
    if (this.isZeroVersion(lowered)) {
      return undefined;
    }
    if (lowered === 'unknown' || lowered === 'null' || lowered === 'undefined' || lowered === 'n/a') {
      return undefined;
    }
    const withoutVPrefix = normalized.replace(/^[vV]/, '');
    if (!/^\d+(?:\.\d+){0,3}$/.test(withoutVPrefix)) {
      return undefined;
    }
    if (this.isZeroVersion(withoutVPrefix)) {
      return undefined;
    }
    if (/^\d+$/.test(withoutVPrefix)) {
      return `${withoutVPrefix}.0.0`;
    }
    if (/^\d+\.\d+$/.test(withoutVPrefix)) {
      return `${withoutVPrefix}.0`;
    }
    return withoutVPrefix;
  }

  private isZeroVersion(value: string): boolean {
    if (value === '0') {
      return true;
    }
    return /^0(?:\.0+)+$/.test(value);
  }

  private normalizeModel(value: unknown): string {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 1) {
        return trimmed;
      }
      const asNumber = Number(trimmed);
      if (Number.isFinite(asNumber)) {
        return `Pura ${asNumber}`;
      }
    }
    if (typeof value === 'number') {
      return `Pura ${value}`;
    }
    return 'Pura';
  }

  private resolveModelLabel(modelValue: unknown, deviceVersion?: string, hwVersion?: string): unknown {
    if (typeof hwVersion === 'string') {
      const major = Number(hwVersion.split('.')[0]);
      if (Number.isFinite(major)) {
        const map: Record<number, string> = {
          1: 'Pura Car',
          2: 'Pura 3',
          3: 'Pura 3',
          4: 'Pura 4',
          22: 'Pura Plus',
          26: 'Pura Mini',
          27: 'Pura Car Pro',
        };
        return map[major] ?? `Pura ${major}`;
      }
    }
    if (typeof deviceVersion === 'string') {
      const normalized = deviceVersion.trim().toLowerCase();
      const map: Record<string, string> = {
        v48: 'Pura 4',
      };
      if (map[normalized]) {
        return map[normalized];
      }
    }
    if (modelValue === null || modelValue === undefined) {
      return 'Pura';
    }
    return modelValue;
  }

  private normalizeBay(parent: Record<string, unknown>, value: unknown, bayNumber: number): PuraBay | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const remaining = record.remaining && typeof record.remaining === 'object'
      ? record.remaining as Record<string, unknown>
      : undefined;
    const activeAtRaw = Number(record.activeAt);
    const activeAt = Number.isFinite(activeAtRaw) && activeAtRaw > 0 ? activeAtRaw : undefined;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const diffusionMode = typeof parent.diffusionMode === 'string' ? parent.diffusionMode : undefined;
    const standardMode = diffusionMode === 'standard';
    const online = this.resolveOnlineState(parent) !== false;
    // In standard mode, Pura keeps activeAt at the session's original start time and clears it to 0
    // only when diffusion stops, so a 15 minute window reported long-running sessions as OFF. The
    // window is widened rather than removed: if activeAt is ever left stale by the cloud, an
    // unbounded check would pin the diffuser ON in HomeKit with no way to recover.
    // Other modes use activeAt as time-bounded evidence because their payload semantics differ.
    const activeAtWindowSeconds = standardMode
      ? (online ? 43200 : 300)
      : (online ? 300 : 120);
    const activeAtRecent = activeAt !== undefined &&
      Math.abs(nowSeconds - activeAt) < activeAtWindowSeconds;
    const explicitActiveValues = [
      this.normalizeBooleanish(record.active),
      this.normalizeBooleanish(record.enabled),
      this.normalizeBooleanish(record.on),
      this.normalizeBooleanish(record.isOn),
    ];
    const explicitActive = explicitActiveValues.find((state): state is boolean => state !== undefined);
    const hasExplicitActiveSignal = explicitActive !== undefined;
    const recordIntensityValue = record.intensity ?? record.level ?? record.strength;
    const defaultsIntensityValue =
      (parent.deviceDefaults as Record<string, unknown> | undefined)?.[`bay${bayNumber}Intensity`];
    const parentStateIntensityValue = this.resolveParentStateIntensityValue(parent, bayNumber);
    const oscillationIntensityValue = this.resolveOscillationIntensityValue(parent.oscillation, bayNumber);
    const intensityFromRecord = this.normalizeBayIntensity(recordIntensityValue);
    const intensityFromDefaults = this.normalizeBayIntensity(
      defaultsIntensityValue,
    );
    const intensityFromParentState = this.normalizeBayIntensity(parentStateIntensityValue);
    const oscillationActive = this.normalizeOscillationActive(parent.oscillation, bayNumber);
    const intensityFromOscillation = this.normalizeBayIntensity(oscillationIntensityValue);
    const intensityEvidence = (
      (intensityFromRecord !== null && Number.isFinite(intensityFromRecord) && intensityFromRecord > 0) ||
      (intensityFromOscillation !== null && Number.isFinite(intensityFromOscillation) && intensityFromOscillation > 0) ||
      (intensityFromParentState !== null && Number.isFinite(intensityFromParentState) && intensityFromParentState > 0)
    );
    const inferredActive = oscillationActive ||
      (standardMode && !hasExplicitActiveSignal && activeAtRecent) ||
      (activeAtRecent && intensityEvidence);
    const active = explicitActive ?? inferredActive;
    // Preserve reported intensity even when the active flag is stale/missing. The accessory layer
    // can use this as secondary evidence for current diffusion state.
    const reportedIntensity = intensityFromRecord ?? intensityFromOscillation ?? 0;
    const normalizedIntensity = active
      ? (intensityFromRecord ?? intensityFromOscillation ?? intensityFromParentState ?? intensityFromDefaults ?? 0)
      : reportedIntensity;
    const exactIntensity = active
      ? (
        mapPuraNumericIntensityToHomeKit(recordIntensityValue) ??
        mapPuraNumericIntensityToHomeKit(oscillationIntensityValue) ??
        mapPuraNumericIntensityToHomeKit(parentStateIntensityValue) ??
        mapPuraNumericIntensityToHomeKit(defaultsIntensityValue) ??
        undefined
      )
      : (
        mapPuraNumericIntensityToHomeKit(recordIntensityValue) ??
        mapPuraNumericIntensityToHomeKit(oscillationIntensityValue) ??
        undefined
      );
    // Diagnostic for Pura's intensity scale. The app exposes five positions but the REST payload
    // reports them inconsistently across fields, so log every raw candidate alongside what we
    // resolved from it. This is what tells us whether all five positions are recoverable.
    this.log.debug(
      `[Intensity] device=${parent.deviceId ?? parent.id ?? 'unknown'} bay=${bayNumber} ` +
      `active=${Boolean(active)} | raw: record=${this.describeRaw(recordIntensityValue)} ` +
      `defaults=${this.describeRaw(defaultsIntensityValue)} ` +
      `parentState=${this.describeRaw(parentStateIntensityValue)} ` +
      `oscillation=${this.describeRaw(oscillationIntensityValue)} ` +
      `| resolved: coarse=${Math.max(0, Math.min(100, normalizedIntensity))} ` +
      `exact=${exactIntensity ?? 'none'}`,
    );

    return {
      id: typeof record.id === 'number' ? record.id : bayNumber,
      name: typeof record.name === 'string' ? record.name : undefined,
      active: Boolean(active),
      intensity: Math.max(0, Math.min(100, normalizedIntensity)),
      exactIntensity,
      activeAt,
      timer: record.timer as PuraTimer | undefined,
      fragrance: record.fragrance as PuraFragrance | undefined,
      remainingPercent: this.normalizePercentage(remaining?.percent),
      lowFragrance: this.normalizeBooleanish(record.lowFragrance),
    };
  }

  /** Render a raw payload value with its type, so `5` and `"5"` are distinguishable in logs. */
  private describeRaw(value: unknown): string {
    if (value === undefined) {
      return 'absent';
    }
    if (value === null) {
      return 'null';
    }
    return `${JSON.stringify(value)}(${typeof value})`;
  }

  private normalizePercentage(value: unknown): number | undefined {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
      return undefined;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return undefined;
    }
    return Math.max(0, Math.min(100, numeric));
  }

  private resolveOnlineState(source: Record<string, unknown>): boolean | undefined {
    const connected = source.connected;
    if (typeof connected === 'boolean') {
      return connected;
    }
    const online = source.online;
    if (typeof online === 'boolean') {
      return online;
    }
    return undefined;
  }

  private normalizeBayIntensity(value: unknown): number | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === 'string') {
      const normalized = value.toLowerCase().trim();
      if (normalized === 'subtle') {
        return 30;
      }
      if (normalized === 'medium') {
        return 50;
      }
      if (normalized === 'strong') {
        return 100;
      }
      const asNumber = Number(normalized);
      if (Number.isFinite(asNumber)) {
        return this.normalizeNumericBayIntensity(asNumber);
      }
      return null;
    }
    const asNumber = Number(value);
    if (!Number.isFinite(asNumber)) {
      return null;
    }
    return this.normalizeNumericBayIntensity(asNumber);
  }

  /**
   * Pura reports numeric intensity on two different scales depending on the field and model: a
   * 1-10 level, or a 0-100 percentage. They only overlap at 1-10, and a real device never sits at
   * 1-10 percent, so treating that range as levels is the correct read. Without it every level
   * from 1 to 10 fell into the old `<= 33` branch and the diffuser reported "subtle" even at
   * maximum output.
   */
  private normalizeNumericBayIntensity(asNumber: number): number {
    if (asNumber <= 0) {
      return 0;
    }
    if (asNumber <= 10) {
      if (asNumber <= 3) {
        return 30;
      }
      if (asNumber <= 7) {
        return 50;
      }
      return 100;
    }
    if (asNumber <= 33) {
      return 30;
    }
    if (asNumber <= 66) {
      return 50;
    }
    return 100;
  }

  private normalizeBooleanish(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      if (value === 1) {
        return true;
      }
      if (value === 0) {
        return false;
      }
      return undefined;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'on', 'yes', 'active', 'enabled'].includes(normalized)) {
        return true;
      }
      if (['false', '0', 'off', 'no', 'inactive', 'disabled'].includes(normalized)) {
        return false;
      }
    }
    return undefined;
  }

  private resolveParentStateIntensityValue(parent: Record<string, unknown>, bayNumber: number): unknown {
    const states = Array.isArray(parent.states) ? parent.states : [];
    const match = states.find((state) => {
      if (!state || typeof state !== 'object') {
        return false;
      }
      const stateRecord = state as Record<string, unknown>;
      return stateRecord.bay === bayNumber;
    }) as Record<string, unknown> | undefined;
    if (match) {
      return match.intensity ?? match.level ?? match.strength;
    }
    const state = parent.state as Record<string, unknown> | undefined;
    if (!state || typeof state !== 'object') {
      return undefined;
    }
    const currentIndex = Number(state.currentIndex ?? state.bay ?? state.activeBay);
    if (Number.isFinite(currentIndex) && currentIndex === bayNumber) {
      return state.intensity ?? state.level ?? state.strength;
    }
    return undefined;
  }

  private resolveOscillationIntensityValue(value: unknown, bayNumber: number): unknown {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const states = Array.isArray(record.states) ? record.states : [];
    const match = states.find((state) => {
      if (!state || typeof state !== 'object') {
        return false;
      }
      const stateRecord = state as Record<string, unknown>;
      return stateRecord.bay === bayNumber;
    }) as Record<string, unknown> | undefined;
    if (match) {
      return match.intensity;
    }
    const state = record.state as Record<string, unknown> | undefined;
    if (state && state.currentIndex === bayNumber) {
      return state.intensity;
    }
    return undefined;
  }

  private normalizeOscillationActive(value: unknown, bayNumber: number): boolean {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const record = value as Record<string, unknown>;
    const states = Array.isArray(record.states) ? record.states : [];
    const match = states.find((state) => {
      if (!state || typeof state !== 'object') {
        return false;
      }
      const stateRecord = state as Record<string, unknown>;
      return stateRecord.bay === bayNumber;
    });
    if (match) {
      return true;
    }
    const state = record.state as Record<string, unknown> | undefined;
    return state?.currentIndex === bayNumber;
  }

  /**
   * Set device intensity
   */
  async setIntensity(deviceId: string, bay: number, intensity: number, controller?: string): Promise<boolean> {
    try {
      const { apiIntensity, controller: defaultController } = this.normalizeIntensity(intensity);
      const resolvedController = controller || defaultController;
      const response = await this.makeRequest(
        'POST',
        `devices/${deviceId}/intensity`,
        {
          bay,
          controller: resolvedController,
          intensity: apiIntensity,
        },
        { timeoutMs: 3500 },
      ) as { success?: boolean };
      this.log.debug('Pura intensity response:', {
        deviceId,
        bay,
        intensity: apiIntensity,
        controller: resolvedController,
        success: response.success,
      });
      return response.success === true;
    } catch (error) {
      this.log.error(`Failed to set intensity for device ${deviceId}:`, error);
      return false;
    }
  }

  private normalizeIntensity(intensity: number): { apiIntensity: string; controller: string } {
    const clamped = Math.max(0, Math.min(100, Number(intensity) || 0));
    const apiIntensity = clamped <= 33 ? 'subtle' : clamped <= 66 ? 'medium' : 'strong';
    return {
      apiIntensity,
      controller: 'default',
    };
  }

  /**
   * Set always on mode
   */
  async setAlwaysOn(deviceId: string, bay: number): Promise<boolean> {
    try {
      const response = await this.makeRequest(
        'POST',
        `devices/${deviceId}/always-on`,
        { bay },
        { timeoutMs: 3500 },
      ) as { success?: boolean };
      return response.success === true;
    } catch (error) {
      this.log.error(`Failed to set always on for device ${deviceId}:`, error);
      return false;
    }
  }

  /**
   * Stop all diffusion
   */
  async stopAll(deviceId: string): Promise<boolean> {
    try {
      const response = await this.makeRequest(
        'POST',
        `devices/${deviceId}/stop-all`,
        undefined,
        { suppressHttpErrorLog: true, timeoutMs: 3500 },
      ) as { success?: boolean };
      return response.success === true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isBenignStopFailure = message.includes('API request failed: 500')
        && message.toLowerCase().includes('could not stop device');
      if (isBenignStopFailure) {
        this.log.debug(`Stop-all returned benign 500 for device ${deviceId}; treating as already stopped.`);
        return true;
      }
      this.log.error(`Failed to stop all for device ${deviceId}:`, error);
      return false;
    }
  }

  async setAwayMode(deviceId: string, awayMode: boolean): Promise<boolean> {
    try {
      const response = await this.makeRequest(
        'POST',
        `devices/${deviceId}/awayMode`,
        { awayMode },
        { timeoutMs: 3500 },
      ) as { success?: boolean };
      return response.success === true;
    } catch (error) {
      this.log.error(`Failed to set away mode for device ${deviceId}:`, error);
      return false;
    }
  }

  async setNightlight(
    deviceId: string,
    active: boolean,
    brightness = 10,
    color = 'ffffff',
    controller = 'default',
  ): Promise<boolean> {
    try {
      const clamped = Math.max(0, Math.min(100, Number(brightness) || 0));
      const scaledBrightness = Math.max(1, Math.min(10, Math.round((clamped / 100) * 10)));
      const normalizedColor = color.replace('#', '');
      this.log.debug(
        `[Nightlight] Request device=${deviceId} active=${active} ` +
        `inputBrightness=${brightness} clampedBrightness=${clamped} scaledBrightness=${scaledBrightness} ` +
        `color=${normalizedColor} controller=${controller}`,
      );
      const response = await this.makeRequest('POST', `devices/${deviceId}/nightlight`, {
        active,
        brightness: scaledBrightness,
        color: normalizedColor,
        controller,
      }, { timeoutMs: 3500 }) as Record<string, unknown>;
      const success = response.success === true;
      this.log.debug(
        `[Nightlight] Response device=${deviceId} success=${success} payload=${this.formatDebugPayload(response)}`,
      );
      return success;
    } catch (error) {
      this.log.error(`Failed to set nightlight for device ${deviceId}:`, error);
      return false;
    }
  }

  private formatDebugPayload(payload: unknown): string {
    try {
      return JSON.stringify(payload);
    } catch {
      return String(payload);
    }
  }

  /**
   * Set timer
   */
  async setTimer(
    deviceId: string,
    bay: number,
    intensity: number,
    durationMinutes: number,
  ): Promise<boolean> {
    try {
      const start = Math.floor(Date.now() / 1000);
      const end = start + (durationMinutes * 60);
      
      const response = await this.makeRequest('POST', `devices/${deviceId}/timer`, {
        bay,
        intensity,
        start,
        end,
        validateOverride: true,
      }) as { success?: boolean };
      return response.success === true;
    } catch (error) {
      this.log.error(`Failed to set timer for device ${deviceId}:`, error);
      return false;
    }
  }
}
