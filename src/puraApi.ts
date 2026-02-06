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

export class PuraApi {
  private userPool: CognitoUserPool;
  private cognitoUser: CognitoUser | null = null;
  private session: CognitoUserSession | null = null;
  private readonly log: Logging;
  private readonly baseUrl: string;

  constructor(log: Logging) {
    this.log = log;
    const userPoolId = DEFAULT_USER_POOL_ID;
    const clientId = DEFAULT_CLIENT_ID;
    this.baseUrl = DEFAULT_BASE_URL;

    this.userPool = new CognitoUserPool({
      UserPoolId: userPoolId,
      ClientId: clientId,
    });
  }

  updateCognitoConfig(userPoolId: string, clientId: string): void {
    this.userPool = new CognitoUserPool({
      UserPoolId: userPoolId,
      ClientId: clientId,
    });
    this.cognitoUser = null;
    this.session = null;
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
   * Get authorization header for API requests
   */
  private getAuthHeader(): string {
    if (!this.session) {
      throw new Error('Not authenticated');
    }
    return `Bearer ${this.session.getIdToken().getJwtToken()}`;
  }

  /**
   * Make authenticated API request
   */
  private async makeRequest(
    method: string,
    endpoint: string,
    data?: unknown,
  ): Promise<unknown> {
    const url = new URL(endpoint, this.baseUrl).toString();
    
    const options: RequestInit = {
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.getAuthHeader(),
      },
      // timeout: 10000, // Not supported in fetch
    };

    if (data && method.toLowerCase() !== 'get') {
      options.body = JSON.stringify(data);
    }

    this.log.info(`Making ${method} request to ${url}`, data ? { payload: data } : {});

    try {
      const response = await fetch(url, options);
      
      const responseText = await response.text();
      this.log.info(`API response status: ${response.status}`, {
        url,
        body: responseText.length > 2000 ? `${responseText.slice(0, 2000)}…` : responseText,
      });

      if (!response.ok) {
        this.log.error(`API request failed: ${response.status} - ${responseText}`);
        throw new Error(`API request failed: ${response.status} - ${responseText}`);
      }

      try {
        const result = responseText ? JSON.parse(responseText) : {};
        this.log.info('API response parsed:', result);
        return result;
      } catch (error) {
        this.log.warn('API response was not JSON', { url });
        return responseText;
      }
    } catch (error) {
      this.log.error('API request error:', error);
      throw error;
    }
  }

  /**
   * Get all devices
   */
  async getDevices(): Promise<PuraDevice[]> {
    try {
      const response = await this.makeRequest('GET', 'v2/users/devices') as Record<string, unknown>;
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
    } catch (error) {
      this.log.error('Failed to get devices:', error);
      throw error;
    }
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


    const firmwareVersion = (record.fwVersion || record.firmwareVersion) as string | undefined;
    const deviceVersion = (record.deviceVer || record.version) as string | undefined;
    const type = (record.type || record.model || 'Pura Diffuser') as string;

    const defaultNightlight = (record.deviceDefaults as Record<string, unknown> | undefined)?.nightlight;
    const nightlight = (record.nightlight ?? defaultNightlight) as PuraNightlight | undefined;

    return {
      id,
      name: name ?? `Pura ${id}`,
      type: this.normalizeModel(type),
      version: deviceVersion ?? '',
      controller: typeof record.controller === 'string' ? record.controller : undefined,
      state: {
        battery: (record.batteryRemaining || record.battery) as number | undefined,
        firmwareVersion,
        lastSeen: record.lastConnectedAt ? String(record.lastConnectedAt) : undefined,
        online: (record.connected || record.online) as boolean | undefined,
      },
      bay1: this.normalizeBay(record, record.bay1, 1),
      bay2: this.normalizeBay(record, record.bay2, 2),
      nightlight,
      awayMode: record.awayMode as boolean | undefined,
      ambientMode: record.ambientMode as boolean | undefined,
      online: (record.connected || record.online) as boolean | undefined,
    };
  }

  private normalizeModel(value: unknown): string {
    if (typeof value === 'string' && value.trim().length > 1) {
      return value.trim();
    }
    if (typeof value === 'number') {
      return `Model ${value}`;
    }
    return 'Pura Diffuser';
  }

  private normalizeBay(parent: Record<string, unknown>, value: unknown, bayNumber: number): PuraBay | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const active = record.active ?? record.enabled ?? record.on ?? record.isOn ?? (Number(record.activeAt) > 0);
    const intensityFromRecord = this.normalizeBayIntensity(record.intensity ?? record.level ?? record.strength);
    const intensityFromDefaults = this.normalizeBayIntensity(
      (parent.deviceDefaults as Record<string, unknown> | undefined)?.[`bay${bayNumber}Intensity`],
    );
    const intensityFromOscillation = this.normalizeOscillationIntensity(parent.oscillation, bayNumber);
    const normalizedIntensity = intensityFromRecord ?? intensityFromOscillation ?? intensityFromDefaults ?? 0;
    return {
      id: typeof record.id === 'number' ? record.id : bayNumber,
      name: typeof record.name === 'string' ? record.name : undefined,
      active: Boolean(active),
      intensity: Math.max(0, Math.min(100, normalizedIntensity)),
      timer: record.timer as PuraTimer | undefined,
      fragrance: record.fragrance as PuraFragrance | undefined,
    };
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
        return 60;
      }
      if (normalized === 'strong') {
        return 100;
      }
      const asNumber = Number(normalized);
      if (Number.isFinite(asNumber)) {
        return asNumber <= 10 ? asNumber * 10 : asNumber;
      }
      return null;
    }
    const asNumber = Number(value);
    if (!Number.isFinite(asNumber)) {
      return null;
    }
    return asNumber <= 10 ? asNumber * 10 : asNumber;
  }

  private normalizeOscillationIntensity(value: unknown, bayNumber: number): number | null {
    if (!value || typeof value !== 'object') {
      return null;
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
      return this.normalizeBayIntensity(match.intensity);
    }
    const state = record.state as Record<string, unknown> | undefined;
    if (state && state.currentIndex === bayNumber) {
      return this.normalizeBayIntensity(state.intensity);
    }
    return null;
  }

  /**
   * Set device intensity
   */
  async setIntensity(deviceId: string, bay: number, intensity: number): Promise<boolean> {
    try {
      const { apiIntensity, controller } = this.normalizeIntensity(intensity);
      const response = await this.makeRequest('POST', `devices/${deviceId}/intensity`, {
        bay,
        controller,
        intensity: apiIntensity,
      }) as { success?: boolean };
      this.log.info('Pura intensity response:', { deviceId, bay, intensity: apiIntensity, controller, success: response.success });
      return response.success === true;
    } catch (error) {
      this.log.error(`Failed to set intensity for device ${deviceId}:`, error);
      return false;
    }
  }

  private normalizeIntensity(intensity: number): { apiIntensity: string; controller: string } {
    const clamped = Math.max(0, Math.min(100, Number(intensity) || 0));
    let apiIntensity: string = 'medium';
    if (clamped <= 33) {
      apiIntensity = 'subtle';
    } else if (clamped <= 66) {
      apiIntensity = 'medium';
    } else {
      apiIntensity = 'strong';
    }
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
      const response = await this.makeRequest('POST', `devices/${deviceId}/always-on`, {
        bay,
      }) as { success?: boolean };
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
      const response = await this.makeRequest('POST', `devices/${deviceId}/stop-all`) as { success?: boolean };
      return response.success === true;
    } catch (error) {
      this.log.error(`Failed to stop all for device ${deviceId}:`, error);
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
      const response = await this.makeRequest('POST', `devices/${deviceId}/nightlight`, {
        active,
        brightness: scaledBrightness,
        color: normalizedColor,
        controller,
      }) as { success?: boolean };
      return response.success === true;
    } catch (error) {
      this.log.error(`Failed to set nightlight for device ${deviceId}:`, error);
      return false;
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
