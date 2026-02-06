/**
 * Type definitions for Pura API
 */

import { PlatformConfig } from 'homebridge';

export interface PuraConfig extends PlatformConfig {
  username: string;
  password: string;
  refreshInterval?: number;
}

export interface PuraDevice {
  id: string;
  name: string;
  type: string;
  version: string;
  state: PuraDeviceState;
  controller?: string;
  bay1?: PuraBay;
  bay2?: PuraBay;
  nightlight?: PuraNightlight;
  awayMode?: boolean;
  ambientMode?: boolean;
  online?: boolean;
}

export interface PuraDeviceState {
  battery?: number;
  firmwareVersion?: string;
  lastSeen?: string;
  online?: boolean;
}

export interface PuraBay {
  id: number;
  name?: string;
  active: boolean;
  intensity: number;
  timer?: PuraTimer;
  fragrance?: PuraFragrance;
}

export interface PuraTimer {
  active: boolean;
  start?: number;
  end?: number;
  intensity?: number;
}

export interface PuraFragrance {
  id: string;
  name: string;
  color?: string;
}

export interface PuraNightlight {
  active: boolean;
  brightness: number;
  color: string;
}

export interface PuraAuthTokens {
  accessToken: string;
  idToken: string;
  refreshToken: string;
}

export interface PuraApiResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}
