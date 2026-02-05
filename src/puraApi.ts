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
import { PuraDevice, PuraAuthTokens } from './puraTypes.js';

// Defaults from pypura
const DEFAULT_USER_POOL_ID = 'us-east-1_LaB718hYv'; // Base64 decoded from pypura
const DEFAULT_CLIENT_ID = '4iekubat0jb5iljfbaalsiqf9j'; // Base64 decoded from pypura
const DEFAULT_BASE_URL = 'https://trypura.io/mobile/api/';

export interface PuraApiOptions {
}

export class PuraApi {
  private userPool: CognitoUserPool;
  private cognitoUser: CognitoUser | null = null;
  private session: CognitoUserSession | null = null;
  private readonly log: Logging;
  private readonly baseUrl: string;

  constructor(log: Logging, options: PuraApiOptions = {}) {
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

    this.log.debug(`Making ${method} request to ${url}`);

    try {
      const response = await fetch(url, options);
      
      if (!response.ok) {
        const errorText = await response.text();
        this.log.error(`API request failed: ${response.status} - ${errorText}`);
        throw new Error(`API request failed: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      this.log.debug('API response:', result);
      return result;
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
      const devices = (response as { devices?: PuraDevice[] }).devices;
      if (Array.isArray(devices)) {
        return devices;
      }
      const flattened: PuraDevice[] = [];
      for (const value of Object.values(response)) {
        if (Array.isArray(value)) {
          flattened.push(...(value as PuraDevice[]));
        }
      }
      return flattened;
    } catch (error) {
      this.log.error('Failed to get devices:', error);
      throw error;
    }
  }

  /**
   * Set device intensity
   */
  async setIntensity(deviceId: string, bay: number, intensity: number): Promise<boolean> {
    try {
      const response = await this.makeRequest('POST', `devices/${deviceId}/intensity`, {
        bay,
        controller: 'mobile',
        intensity,
      }) as { success?: boolean };
      return response.success === true;
    } catch (error) {
      this.log.error(`Failed to set intensity for device ${deviceId}:`, error);
      return false;
    }
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
