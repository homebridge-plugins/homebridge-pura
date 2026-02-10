import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';

import { PuraPlatformAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { PuraApi } from './puraApi.js';
import { PuraDevice, PuraConfig } from './puraTypes.js';
import { fetchLatestCognitoConfig } from './pypuraLookup.js';

type DiffuserAccessory = PlatformAccessory & {
  context: {
    device: PuraDevice;
  };
  handler?: PuraPlatformAccessory;
};

/**
 * PuraPlatform
 * This class is the main constructor for the Pura plugin, this is where we
 * authenticate with Pura and discover/register accessories with Homebridge.
 */
export class PuraPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  private readonly puraApi: PuraApi;
  private readonly puraConfig: PuraConfig;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshBaseIntervalSeconds = 30;
  private refreshFailures = 0;
  private cognitoRefreshInterval: NodeJS.Timeout | null = null;
  private attemptedCognitoUpdate = false;
  private latestCognitoVersion: string | null = null;
  private authInFlight: Promise<void> | null = null;
  private webhookServer: http.Server | null = null;
  private webhookRefreshTimer: NodeJS.Timeout | null = null;
  private webhookReceived = false;
  private webhookToken?: string;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    // Validate configuration
    if (!config.username || !config.password) {
      this.log.error('Username and password are required in the config');
      throw new Error('Username and password are required in the config');
    }

    this.puraConfig = config as PuraConfig;
    this.puraApi = new PuraApi(this.log);

    this.log.info('Pura API config: using default baseUrl');

    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });

    // Clean up on shutdown
    this.api.on('shutdown', () => {
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
      }
      if (this.cognitoRefreshInterval) {
        clearInterval(this.cognitoRefreshInterval);
      }
      if (this.webhookRefreshTimer) {
        clearTimeout(this.webhookRefreshTimer);
      }
      this.stopWebhookServer();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Discover and register Pura devices
   */
  async discoverDevices(): Promise<void> {
    try {
      // Authenticate with Pura
      this.log.info('Authenticating with Pura...');
      await this.withAuthLock(async () => {
        await this.puraApi.authenticate(this.puraConfig.username, this.puraConfig.password);
      });
      this.log.info('Pura authentication successful');

      // Get devices
      this.log.info('Discovering Pura devices...');
      const devices = await this.puraApi.getDevices();
      this.log.info(`Found ${devices.length} Pura device(s)`);

      // Register each device
      for (const device of devices) {
        await this.registerDevice(device);
      }

      // Remove accessories that are no longer present
      this.removeStaleAccessories();

      // Set up refresh interval
      this.setupRefreshInterval();
      this.setupCognitoRefreshInterval();
      await this.setupWebhookServer();
      // Force an immediate refresh after startup, then a short delayed retry
      this.scheduleInitialRefreshes();

    } catch (error) {
      const retried = await this.tryAutoUpdateCognito(error);
      if (retried) {
        return this.discoverDevices();
      }
      this.log.error('Failed to discover Pura devices:', error);
    }
  }

  private async tryAutoUpdateCognito(error: unknown): Promise<boolean> {
    if (this.attemptedCognitoUpdate) {
      return false;
    }
    if (!(error instanceof Error) || !error.message.toLowerCase().includes('authentication')) {
      return false;
    }

    this.attemptedCognitoUpdate = true;
    this.log.warn('Authentication failed. Attempting to fetch latest Cognito IDs from pypura...');
    const latest = await fetchLatestCognitoConfig(this.log);
    if (!latest) {
      this.log.warn('Unable to refresh Cognito IDs from pypura.');
      return false;
    }

    this.puraApi.updateCognitoConfig(latest.userPoolId, latest.clientId);
    this.latestCognitoVersion = latest.version;
    this.log.info(`Updated Cognito IDs from pypura ${latest.version}. Retrying authentication...`);
    return true;
  }

  /**
   * Register a Pura device as a HomeKit accessory
   */
  private async registerDevice(device: PuraDevice) {
    this.log.debug('Registering device:', device.name, device.id);

    // Single diffuser accessory (On/Off)
    await this.registerDiffuserAccessory(device);

    // No nightlight accessory (diffuser switch only)
  }

  private async registerDiffuserAccessory(device: PuraDevice) {
    const deviceName = device.name || `Pura ${device.id}`;
    const baseName = deviceName.endsWith('Diffuser') ? deviceName : `${deviceName} Diffuser`;
    const accessoryName = baseName;
    const uniqueId = `${device.id}-diffuser`;
    const uuid = this.api.hap.uuid.generate(uniqueId);

    const existingAccessory = this.accessories.get(uuid) as DiffuserAccessory | undefined;
    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      existingAccessory.context.device = device;
      this.api.updatePlatformAccessories([existingAccessory]);
      existingAccessory.handler = new PuraPlatformAccessory(this, existingAccessory, this.puraApi);
    } else {
      this.log.info('Adding new accessory:', accessoryName);
      const accessory = new this.api.platformAccessory(accessoryName, uuid) as DiffuserAccessory;
      accessory.context.device = device;
      accessory.handler = new PuraPlatformAccessory(this, accessory, this.puraApi);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    this.discoveredCacheUUIDs.push(uuid);
  }


  /**
   * Remove accessories that are no longer present
   */
  private removeStaleAccessories() {
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  /**
   * Set up periodic refresh of device status
   */
  private setupRefreshInterval() {
    const configuredSeconds = 30;
    this.refreshBaseIntervalSeconds = configuredSeconds;
    this.refreshFailures = 0;
    this.log.debug(`Setting up refresh interval: ${this.refreshBaseIntervalSeconds} seconds (base)`);

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.scheduleNextRefresh(0);
  }

  private scheduleInitialRefreshes() {
    const doRefresh = async (label: string) => {
      try {
        this.log.debug(`Initial device status refresh (${label})...`);
        await this.refreshDeviceStatus();
      } catch (error) {
        this.log.debug(`Initial device status refresh (${label}) failed:`, error);
      }
    };
    void doRefresh('immediate');
    setTimeout(() => void doRefresh('delayed'), 15000);
  }

  private scheduleNextRefresh(delaySeconds: number) {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      void this.runRefreshCycle();
    }, Math.max(0, delaySeconds) * 1000);
  }

  private getRefreshIntervalWithJitter(): number {
    const jitterMax = Math.min(this.refreshBaseIntervalSeconds * 0.5, 30);
    const jitter = Math.random() * jitterMax;
    const interval = this.refreshBaseIntervalSeconds + jitter;
    this.log.debug(
      `Next refresh in ${interval.toFixed(1)}s (base ${this.refreshBaseIntervalSeconds}s, jitter ${jitter.toFixed(1)}s)`,
    );
    return interval;
  }

  private getRefreshIntervalWithBackoff(): number {
    const maxBackoff = Math.max(this.refreshBaseIntervalSeconds * 2, 300);
    const backoff = Math.min(2 ** this.refreshFailures, maxBackoff);
    const interval = this.refreshBaseIntervalSeconds + backoff;
    this.log.debug(
      `Refresh failed (attempt ${this.refreshFailures}); next refresh in ${interval}s`,
    );
    return interval;
  }

  private async runRefreshCycle() {
    try {
      this.log.debug('Refreshing device status...');
      await this.refreshDeviceStatus();
      this.refreshFailures = 0;
      this.scheduleNextRefresh(this.getRefreshIntervalWithJitter());
    } catch (error) {
      this.log.error('Failed to refresh device status:', error);
      this.refreshFailures += 1;
      this.scheduleNextRefresh(this.getRefreshIntervalWithBackoff());
    }
  }

  private setupCognitoRefreshInterval() {
    const intervalSeconds = 3600;
    const interval = intervalSeconds * 1000;
    this.log.debug(`Setting up Cognito refresh interval: ${intervalSeconds} seconds`);
    this.cognitoRefreshInterval = setInterval(async () => {
      try {
        await this.withAuthLock(async () => {
          const latest = await fetchLatestCognitoConfig(this.log);
          if (!latest) {
            return;
          }
          if (this.latestCognitoVersion === latest.version) {
            return;
          }
          this.log.warn(`Detected new pypura version ${latest.version}; refreshing Cognito IDs...`);
          this.puraApi.updateCognitoConfig(latest.userPoolId, latest.clientId);
          this.latestCognitoVersion = latest.version;
          try {
            await this.puraApi.authenticate(this.puraConfig.username, this.puraConfig.password);
            this.log.info('Re-authenticated with refreshed Cognito IDs.');
            this.attemptedCognitoUpdate = false;
          } catch (authError) {
            this.log.warn('Re-authentication failed after Cognito refresh:', authError);
          }
        });
      } catch (error) {
        this.log.debug('Cognito refresh check failed:', error);
      }
    }, interval);
  }

  private async setupWebhookServer() {
    if (this.webhookServer) {
      return;
    }

    const port = 3001;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      this.log.warn('Invalid webhook port configured; webhook server not started.');
      return;
    }

    const path = '/pura';
    const { token } = await this.getWebhookToken();
    this.webhookToken = token;

    this.webhookServer = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }

      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname !== path) {
        res.writeHead(404);
        res.end();
        return;
      }

      if (token) {
        const headerToken = req.headers['x-webhook-token'];
        const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;
        const queryToken = url.searchParams.get('token') ?? undefined;
        if (token !== (provided ?? queryToken)) {
          res.writeHead(401);
          res.end();
          return;
        }
      }

      let body = '';
      const maxBytes = 512 * 1024;
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > maxBytes) {
          res.writeHead(413);
          res.end();
          req.destroy();
        }
      });

      req.on('end', () => {
        if (!body) {
          res.writeHead(400);
          res.end();
          return;
        }

        try {
          const payload = JSON.parse(body) as unknown;
          void this.handleWebhookPayload(payload);
          res.writeHead(200);
          res.end();
        } catch (error) {
          this.log.debug('Webhook payload was not valid JSON:', error);
          res.writeHead(400);
          res.end();
        }
      });
    });

    this.webhookServer.listen(port, () => {
      const address = this.webhookServer?.address();
      const resolvedPort = typeof address === 'object' && address ? address.port : port;
      this.logInfo(`Webhook server listening on port ${resolvedPort} at path ${path}`);
      this.logInfo(`Webhook URL: http://<homebridge-host>:${resolvedPort}${path}`);
      if (token) {
        this.logInfo('Webhook token is required (X-Webhook-Token header or ?token= query param).');
      } else {
        this.logInfo('Webhook token is not configured; requests are unauthenticated.');
      }
    });
  }

  private stopWebhookServer() {
    if (!this.webhookServer) {
      return;
    }
    try {
      this.webhookServer.close();
    } catch (error) {
      this.log.debug('Failed to close webhook server:', error);
    }
    this.webhookServer = null;
  }

  private async getWebhookToken(): Promise<{ token?: string }> {
    try {
      const storagePath = this.api.user.storagePath();
      const tokenPath = path.join(storagePath, 'pura-webhook.json');
      try {
        const existing = await fs.readFile(tokenPath, 'utf-8');
        const parsed = JSON.parse(existing) as { token?: string };
        if (parsed.token && typeof parsed.token === 'string') {
          return { token: parsed.token };
        }
      } catch {
        // Ignore missing/invalid file and generate a new token below.
      }

      const generated = randomBytes(24).toString('hex');
      await fs.mkdir(storagePath, { recursive: true });
      await fs.writeFile(tokenPath, JSON.stringify({ token: generated }, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      this.logInfo(`Generated webhook token and stored it at ${tokenPath}.`);
      return { token: generated };
    } catch (error) {
      this.logWarn('Failed to load or create webhook token; continuing without token.', error);
      return { token: undefined };
    }
  }

  private logInfo(...args: unknown[]) {
    const redacted = this.redactLogArgs(args);
    if (redacted.length === 0) {
      return;
    }
    const [message, ...rest] = redacted;
    const params = [String(message), ...rest] as [string, ...unknown[]];
    this.log.info(...params);
  }

  private logWarn(...args: unknown[]) {
    const redacted = this.redactLogArgs(args);
    if (redacted.length === 0) {
      return;
    }
    const [message, ...rest] = redacted;
    const params = [String(message), ...rest] as [string, ...unknown[]];
    this.log.warn(...params);
  }

  private redactLogArgs(args: unknown[]): unknown[] {
    if (!this.webhookToken) {
      return args;
    }
    return args.map((arg) => this.redactValue(arg, new WeakSet<object>()));
  }

  private redactValue(value: unknown, seen: WeakSet<object>): unknown {
    if (!this.webhookToken) {
      return value;
    }
    if (typeof value === 'string') {
      return value.split(this.webhookToken).join('[redacted]');
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: this.redactValue(value.message, seen),
        stack: value.stack ? this.redactValue(value.stack, seen) : value.stack,
      };
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item, seen));
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = this.redactValue(entry, seen);
    }
    return output;
  }

  private async handleWebhookPayload(payload: unknown) {
    if (Array.isArray(payload)) {
      for (const item of payload) {
        await this.handleWebhookPayload(item);
      }
      return;
    }

    if (payload && typeof payload === 'object') {
      const recordList = (payload as Record<string, unknown>).records;
      if (Array.isArray(recordList)) {
        for (const item of recordList) {
          await this.handleWebhookPayload(item);
        }
        return;
      }
    }

    if (!payload || typeof payload !== 'object') {
      this.log.debug('Ignoring webhook payload with unexpected shape');
      return;
    }

    const record = payload as Record<string, unknown>;
    const recordType = record.recordType;
    const eventType = record.eventType;
    const deviceId = String(record.deviceId ?? '');
    const deviceRecord = (record.deviceRecord ?? record.device) as Record<string, unknown> | undefined;

    if (!this.webhookReceived) {
      this.webhookReceived = true;
      if (deviceId) {
        this.logInfo(`Received first webhook payload for device ${deviceId}.`);
      } else {
        this.logInfo('Received first webhook payload.');
      }
    }

    if (deviceId && deviceRecord && recordType === 'DEVICE' && eventType === 'MODIFY') {
      const updated = this.applyDeviceRecord(deviceId, deviceRecord);
      if (updated) {
        return;
      }
    }

    this.triggerWebhookRefresh();
  }

  private applyDeviceRecord(deviceId: string, deviceRecord: Record<string, unknown>): boolean {
    const accessory = this.findAccessoryByDeviceId(deviceId);
    if (!accessory) {
      this.log.debug(`Webhook update for unknown device ${deviceId}; scheduling refresh.`);
      return false;
    }

    const current = accessory.context.device;
    const merged = this.deepMerge(
      (current.__raw ?? {}) as Record<string, unknown>,
      deviceRecord,
    );
    const normalized = this.puraApi.normalizeDeviceRecord({ ...merged, id: deviceId });
    if (!normalized) {
      this.log.debug(`Webhook update for device ${deviceId} could not be normalized.`);
      return false;
    }

    void this.updateDiffuserAccessory(normalized);
    return true;
  }

  private findAccessoryByDeviceId(deviceId: string): DiffuserAccessory | undefined {
    for (const accessory of this.accessories.values()) {
      const diffuser = accessory as DiffuserAccessory;
      if (diffuser.context?.device?.id === deviceId) {
        return diffuser;
      }
    }
    return undefined;
  }

  private triggerWebhookRefresh() {
    if (this.webhookRefreshTimer) {
      return;
    }
    this.webhookRefreshTimer = setTimeout(() => {
      this.webhookRefreshTimer = null;
      void this.refreshDeviceStatus();
    }, 1000);
  }

  private deepMerge(
    base: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Record<string, unknown> {
    const output: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(update)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const existing = output[key];
        output[key] = this.deepMerge(
          existing && typeof existing === 'object' && !Array.isArray(existing)
            ? (existing as Record<string, unknown>)
            : {},
          value as Record<string, unknown>,
        );
      } else {
        output[key] = value;
      }
    }
    return output;
  }

  /**
   * Refresh status of all devices
   */
  private async refreshDeviceStatus() {
    await this.waitForAuth();
    try {
      const devices = await this.puraApi.getDevices();
      
      for (const device of devices) {
        await this.updateDiffuserAccessory(device);
        // No nightlight accessory
      }
    } catch (error) {
      this.log.debug('Device status refresh failed:', error);
      // Try to re-authenticate if authentication failed, then retry once
      if (this.isAuthError(error)) {
        const reauthed = await this.ensureAuthenticatedForRefresh();
        if (reauthed) {
          try {
            const devices = await this.puraApi.getDevices();
            for (const device of devices) {
              await this.updateDiffuserAccessory(device);
            }
          } catch (retryError) {
            this.log.debug('Device status refresh retry failed:', retryError);
          }
        }
      }
    }
  }

  /**
   * Update a device accessory with fresh device data
   */
  private async updateDiffuserAccessory(device: PuraDevice) {
    const uniqueId = `${device.id}-diffuser`;
    const uuid = this.api.hap.uuid.generate(uniqueId);
    const accessory = this.accessories.get(uuid) as DiffuserAccessory | undefined;

    if (accessory) {
      accessory.context.device = device;
      this.api.updatePlatformAccessories([accessory]);
      const handler = accessory.handler;
      if (handler) {
        handler.updateDevice(device);
      }
    }
  }

  private async waitForAuth(): Promise<void> {
    if (this.authInFlight) {
      await this.authInFlight;
    }
  }

  private async withAuthLock<T>(task: () => Promise<T>): Promise<T> {
    if (this.authInFlight) {
      await this.authInFlight;
    }
    let release!: () => void;
    this.authInFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      return await task();
    } finally {
      release();
      this.authInFlight = null;
    }
  }

  private isAuthError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const message = error.message.toLowerCase();
    return message.includes('authentication') ||
      message.includes('unauthorized') ||
      message.includes('not authenticated') ||
      message.includes('401');
  }

  private async ensureAuthenticatedForRefresh(): Promise<boolean> {
    return this.withAuthLock(async () => {
      try {
        await this.puraApi.refreshToken();
        this.log.debug('Token refresh successful');
        return true;
      } catch (refreshError) {
        this.log.warn('Token refresh failed during status refresh:', refreshError);
      }

      try {
        await this.puraApi.authenticate(this.puraConfig.username, this.puraConfig.password);
        this.log.info('Re-authenticated with Pura during status refresh.');
        this.attemptedCognitoUpdate = false;
        return true;
      } catch (authError) {
        const retried = await this.tryAutoUpdateCognito(authError);
        if (retried) {
          try {
            await this.puraApi.authenticate(this.puraConfig.username, this.puraConfig.password);
            this.log.info('Re-authenticated after Cognito refresh.');
            this.attemptedCognitoUpdate = false;
            return true;
          } catch (retryAuthError) {
            this.log.error('Re-authentication failed after Cognito refresh:', retryAuthError);
          }
        } else {
          this.log.error('Re-authentication failed during status refresh:', authError);
        }
      }

      return false;
    });
  }

  // Nightlight accessory removed
}
