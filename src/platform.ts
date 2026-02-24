import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import WebSocket from 'ws';

import { PuraPlatformAccessory } from './platformAccessory.js';
import { PuraNightlightAccessory } from './nightlightAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { PuraApi } from './puraApi.js';
import { PuraDevice, PuraConfig } from './puraTypes.js';
import { fetchLatestCognitoConfig } from './pypuraLookup.js';

type DiffuserAccessory = PlatformAccessory & {
  context: {
    device: PuraDevice;
    accessoryType?: 'diffuser' | 'nightlight';
    serviceMode?: 'switch' | 'fan';
  };
  handler?: PuraPlatformAccessory | PuraNightlightAccessory;
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

  private readonly puraApi: PuraApi;
  private readonly puraConfig: PuraConfig;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshBaseIntervalSeconds = 30;
  private refreshFailures = 0;
  private refreshInFlight: Promise<void> | null = null;
  private refreshQueued = false;
  private lastRefreshAt = 0;
  private debugEnabled = process.argv.includes('-D') || process.argv.includes('--debug');
  private realtimeConnected = false;
  private realtimeStableTimer: NodeJS.Timeout | null = null;
  private cognitoRefreshInterval: NodeJS.Timeout | null = null;
  private attemptedCognitoUpdate = false;
  private latestCognitoVersion: string | null = null;
  private authInFlight: Promise<void> | null = null;
  private webhookRefreshTimer: NodeJS.Timeout | null = null;
  private webhookRefreshDueAt: number | null = null;
  private webhookReceived = false;
  private intentWindowMs = 8000;
  private lastIntentAt: Map<string, { state: boolean; at: number }> = new Map();
  private realtimeSocket: WebSocket | null = null;
  private realtimeReconnectTimer: NodeJS.Timeout | null = null;
  private realtimeFailures = 0;
  private realtimeConnectionAnnounced = false;
  private disabledDueToConfig = false;
  private preservingAccessoriesDueToDegradedDiscovery = false;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.puraConfig = {
      ...(config as PuraConfig),
      username: typeof config.username === 'string' ? config.username : '',
      password: typeof config.password === 'string' ? config.password : '',
    };
    this.puraApi = new PuraApi(this.log);

    // Validate configuration without crashing Homebridge startup.
    const missingConfig = this.getMissingRequiredConfig();
    if (missingConfig.length > 0) {
      this.disabledDueToConfig = true;
      this.log.error(
        `Plugin disabled: missing required configuration value(s): ${missingConfig.join(', ')}.`,
      );
      this.log.error(
        `Update your Homebridge config for platform "${PLATFORM_NAME}" and restart Homebridge.`,
      );
    }

    this.log.debug('Pura API config: using default baseUrl');

    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      if (this.disabledDueToConfig) {
        this.log.warn('Skipping device discovery because plugin configuration is incomplete.');
        return;
      }
      // run the method to discover / register your devices as accessories
      void this.discoverDevices();
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
      this.stopRealtimeSubscriber();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.debug('Loading accessory from cache:', accessory.displayName);
    const infoService = accessory.getService(this.Service.AccessoryInformation);
    if (infoService) {
      const context = accessory.context as Record<string, unknown>;
      const cachedDevice = context.device as Record<string, unknown> | undefined;
      const cachedState = cachedDevice?.state as Record<string, unknown> | undefined;
      const cachedRaw = cachedDevice?.__raw as Record<string, unknown> | undefined;
      const currentFirmware = this.normalizeRevision(
        infoService.getCharacteristic(this.Characteristic.FirmwareRevision).value,
      );
      const currentSoftware = this.normalizeRevision(
        infoService.getCharacteristic(this.Characteristic.SoftwareRevision).value,
      );
      const currentHardware = this.normalizeRevision(
        infoService.getCharacteristic(this.Characteristic.HardwareRevision).value,
      );
      const firmware = this.normalizeRevision(
        context.firmwareRevision ??
        cachedState?.firmwareVersion ??
        cachedRaw?.firmwareVersion ??
        cachedRaw?.fwVersion ??
        currentFirmware ??
        currentSoftware,
      );
      const hardware = this.normalizeRevision(context.hardwareRevision ?? cachedRaw?.hwVersion ?? currentHardware);
      if (firmware) {
        infoService.setCharacteristic(this.Characteristic.FirmwareRevision, firmware);
        infoService.updateCharacteristic(this.Characteristic.FirmwareRevision, firmware);
        infoService.setCharacteristic(this.Characteristic.SoftwareRevision, firmware);
        infoService.updateCharacteristic(this.Characteristic.SoftwareRevision, firmware);
      }
      if (hardware) {
        infoService.setCharacteristic(this.Characteristic.HardwareRevision, hardware);
        infoService.updateCharacteristic(this.Characteristic.HardwareRevision, hardware);
      }
      if (firmware || hardware) {
        this.api.updatePlatformAccessories([accessory]);
        if (this.isDebugEnabled()) {
          this.log.debug(
            `Hydrated cached revisions for ${accessory.displayName}: firmware=${firmware ?? 'none'}, hardware=${hardware ?? 'none'}, ` +
            `currentFirmware=${currentFirmware ?? 'none'}, currentSoftware=${currentSoftware ?? 'none'}, currentHardware=${currentHardware ?? 'none'}`,
          );
        }
      } else if (this.isDebugEnabled()) {
        this.log.debug(
          `No cached revisions available for ${accessory.displayName} during restore; ` +
          `currentFirmware=${currentFirmware ?? 'none'}, currentSoftware=${currentSoftware ?? 'none'}, currentHardware=${currentHardware ?? 'none'}`,
        );
      }
    }

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  private normalizeRevision(value: unknown): string | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return undefined;
    }
    const normalized = String(value).trim();
    if (!normalized) {
      return undefined;
    }
    const lowered = normalized.toLowerCase();
    if (lowered === '0' || /^0(?:\.0+)+$/.test(lowered)) {
      return undefined;
    }
    if (lowered === 'unknown' || lowered === 'null' || lowered === 'undefined' || lowered === 'n/a') {
      return undefined;
    }
    const withoutVPrefix = normalized.replace(/^[vV]/, '');
    if (!/^\d+(?:\.\d+){0,3}$/.test(withoutVPrefix)) {
      return undefined;
    }
    if (withoutVPrefix === '0' || /^0(?:\.0+)+$/.test(withoutVPrefix)) {
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

  /**
   * Discover and register Pura devices
   */
  async discoverDevices(): Promise<void> {
    if (this.disabledDueToConfig) {
      return;
    }
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
      const discoveredUuids = new Set<string>();
      for (const device of devices) {
        const uuids = await this.registerDevice(device);
        for (const uuid of uuids) {
          discoveredUuids.add(uuid);
        }
      }

      // Remove accessories that are no longer present
      if (!this.shouldPreserveAccessoriesOnEmptyDiscovery(devices)) {
        this.removeStaleAccessories(discoveredUuids);
      }

      // Set up refresh interval
      this.setupRefreshInterval();
      this.setupCognitoRefreshInterval();
      this.setupRealtimeSubscriber();
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

  private getMissingRequiredConfig(): string[] {
    const missing: string[] = [];
    if (!this.puraConfig.username.trim()) {
      missing.push('username');
    }
    if (!this.puraConfig.password.trim()) {
      missing.push('password');
    }
    return missing;
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
  private async registerDevice(device: PuraDevice): Promise<string[]> {
    this.log.debug('Registering device:', device.name, device.id);

    const uuids: string[] = [];
    uuids.push(await this.registerDiffuserAccessory(device));
    if ((this.puraConfig.enableNightlightAccessory ?? false) && this.supportsNightlightAccessory(device)) {
      uuids.push(await this.registerNightlightAccessory(device));
    } else {
      this.unregisterNightlightAccessory(device.id);
    }
    return uuids;
  }

  private getDiffuserServiceMode(): 'switch' | 'fan' {
    const fanEnabled = Boolean(
      this.puraConfig.enableFanService ?? this.puraConfig.useFanService,
    );
    return fanEnabled ? 'fan' : 'switch';
  }

  private getDiffuserUniqueId(deviceId: string, serviceMode = this.getDiffuserServiceMode()): string {
    return `${deviceId}-diffuser-${serviceMode}`;
  }

  private getLegacyDiffuserUniqueId(deviceId: string): string {
    return `${deviceId}-diffuser`;
  }

  private async registerDiffuserAccessory(device: PuraDevice): Promise<string> {
    const deviceName = device.name || `Pura ${device.id}`;
    const baseName = deviceName.endsWith('Diffuser') ? deviceName : `${deviceName} Diffuser`;
    const accessoryName = baseName;
    const serviceMode = this.getDiffuserServiceMode();
    const uniqueId = this.getDiffuserUniqueId(device.id, serviceMode);
    const uuid = this.api.hap.uuid.generate(uniqueId);
    const legacyUuid = this.api.hap.uuid.generate(this.getLegacyDiffuserUniqueId(device.id));
    const alternateMode = serviceMode === 'fan' ? 'switch' : 'fan';
    const alternateUuid = this.api.hap.uuid.generate(this.getDiffuserUniqueId(device.id, alternateMode));

    const existingAccessory = this.accessories.get(uuid) as DiffuserAccessory | undefined;
    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      existingAccessory.context.device = device;
      existingAccessory.context.accessoryType = 'diffuser';
      existingAccessory.context.serviceMode = serviceMode;
      this.api.updatePlatformAccessories([existingAccessory]);
      existingAccessory.handler = new PuraPlatformAccessory(this, existingAccessory, this.puraApi);
    } else {
      if (this.accessories.has(legacyUuid) || this.accessories.has(alternateUuid)) {
        this.log.info(
          `Migrating ${accessoryName} to ${serviceMode} service mode; replacing cached diffuser accessory.`,
        );
      }
      this.log.info('Adding new accessory:', accessoryName);
      const accessory = new this.api.platformAccessory(accessoryName, uuid) as DiffuserAccessory;
      accessory.context.device = device;
      accessory.context.accessoryType = 'diffuser';
      accessory.context.serviceMode = serviceMode;
      accessory.handler = new PuraPlatformAccessory(this, accessory, this.puraApi);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    }

    return uuid;
  }

  private async registerNightlightAccessory(device: PuraDevice): Promise<string> {
    const deviceName = device.name || `Pura ${device.id}`;
    const accessoryName = `${deviceName} Nightlight`;
    const uniqueId = `${device.id}-nightlight`;
    const uuid = this.api.hap.uuid.generate(uniqueId);

    const existingAccessory = this.accessories.get(uuid) as DiffuserAccessory | undefined;
    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      existingAccessory.context.device = device;
      existingAccessory.context.accessoryType = 'nightlight';
      this.api.updatePlatformAccessories([existingAccessory]);
      existingAccessory.handler = new PuraNightlightAccessory(this, existingAccessory, this.puraApi);
    } else {
      this.log.info('Adding new accessory:', accessoryName);
      const accessory = new this.api.platformAccessory(accessoryName, uuid) as DiffuserAccessory;
      accessory.context.device = device;
      accessory.context.accessoryType = 'nightlight';
      accessory.handler = new PuraNightlightAccessory(this, accessory, this.puraApi);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    }

    return uuid;
  }

  private unregisterNightlightAccessory(deviceId: string) {
    const uuid = this.api.hap.uuid.generate(`${deviceId}-nightlight`);
    const accessory = this.accessories.get(uuid);
    if (!accessory) {
      return;
    }
    this.log.info('Removing existing accessory from cache:', accessory.displayName);
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.delete(uuid);
  }

  private supportsNightlightAccessory(device: PuraDevice): boolean {
    const model = device.type?.toLowerCase() ?? '';
    if (model.includes('plus')) {
      return false;
    }
    const raw = device.__raw as Record<string, unknown> | undefined;
    const hwVersion = typeof raw?.hwVersion === 'string' ? raw.hwVersion : undefined;
    if (!hwVersion) {
      return true;
    }
    const major = Number(hwVersion.split('.')[0]);
    return !(Number.isFinite(major) && major === 22);
  }


  /**
   * Remove accessories that are no longer present
   */
  private removeStaleAccessories(discoveredUuids: Set<string>) {
    for (const [uuid, accessory] of this.accessories) {
      if (!discoveredUuids.has(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }

  private async reconcileDiscoveredDevices(devices: PuraDevice[]): Promise<void> {
    if (this.shouldPreserveAccessoriesOnEmptyDiscovery(devices)) {
      return;
    }
    const discoveredUuids = new Set<string>();
    for (const device of devices) {
      const diffuserUuid = this.api.hap.uuid.generate(this.getDiffuserUniqueId(device.id));
      discoveredUuids.add(diffuserUuid);
      if ((this.puraConfig.enableNightlightAccessory ?? false) && this.supportsNightlightAccessory(device)) {
        const nightlightUuid = this.api.hap.uuid.generate(`${device.id}-nightlight`);
        discoveredUuids.add(nightlightUuid);
      }
      if (!this.accessories.has(diffuserUuid)) {
        await this.registerDevice(device);
      }
    }
    this.removeStaleAccessories(discoveredUuids);
  }

  private shouldPreserveAccessoriesOnEmptyDiscovery(devices: PuraDevice[]): boolean {
    const shouldPreserve = this.puraApi.wasLastDevicesFetchDegraded()
      && devices.length === 0
      && this.accessories.size > 0;
    if (shouldPreserve && !this.preservingAccessoriesDueToDegradedDiscovery) {
      this.log.warn(
        'Received an empty device list after a degraded API fetch. Preserving cached accessories until recovery.',
      );
    } else if (!shouldPreserve && this.preservingAccessoriesDueToDegradedDiscovery) {
      this.log.info('Device discovery recovered; stale accessory reconciliation resumed.');
    }
    this.preservingAccessoriesDueToDegradedDiscovery = shouldPreserve;
    return shouldPreserve;
  }

  /**
   * Set up periodic refresh of device status
   */
  private setupRefreshInterval() {
    this.refreshBaseIntervalSeconds = 15;
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
    setTimeout(() => {
      const ageMs = Date.now() - this.lastRefreshAt;
      if (!this.realtimeConnected && ageMs > 60000) {
        void doRefresh('delayed');
      }
    }, 15000);
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
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }
    try {
      this.refreshInFlight = (async () => {
        this.log.debug('Refreshing device status...');
        await this.refreshDeviceStatus();
      })();
      await this.refreshInFlight;
      this.refreshFailures = 0;
      this.scheduleNextRefresh(this.getRefreshIntervalWithJitter());
    } catch (error) {
      this.log.error('Failed to refresh device status:', error);
      this.refreshFailures += 1;
      this.scheduleNextRefresh(this.getRefreshIntervalWithBackoff());
    } finally {
      this.refreshInFlight = null;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        this.scheduleNextRefresh(0);
      }
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

  private setupRealtimeSubscriber() {
    if (this.realtimeSocket || this.realtimeReconnectTimer) {
      return;
    }
    this.connectRealtimeSubscriber();
  }

  private connectRealtimeSubscriber() {
    const token = this.puraApi.getIdToken();
    if (!token) {
      this.log.warn('Realtime updates unavailable: missing ID token. Will retry.');
      this.scheduleRealtimeReconnect();
      return;
    }

    this.log.debug('Connecting to Pura realtime updates...');
    const socket = new WebSocket('wss://socket.trypura.io', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    this.realtimeSocket = socket;

    socket.on('open', () => {
      this.realtimeFailures = 0;
      this.realtimeConnected = true;
      this.updatePollingForRealtime();
      if (this.debugEnabled) {
        this.log.info('Connected to Pura realtime updates.');
      } else if (!this.realtimeConnectionAnnounced) {
        this.log.info('Realtime updates active.');
        this.realtimeConnectionAnnounced = true;
      }
      this.scheduleRealtimeStableLog();
    });

    socket.on('message', (data: WebSocket.RawData) => {
      const payload = this.parseRealtimePayload(data);
      if (payload !== undefined) {
        void this.handleWebhookPayload(payload);
      }
    });

    socket.on('error', (error: Error) => {
      this.log.debug('Realtime socket error:', error);
      if (this.realtimeConnected) {
        this.realtimeConnected = false;
        if (this.realtimeStableTimer) {
          clearTimeout(this.realtimeStableTimer);
          this.realtimeStableTimer = null;
        }
        this.updatePollingForRealtime();
      }
      if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
        socket.terminate();
      }
      this.scheduleRealtimeReconnect();
    });

    socket.on('close', (code: number, reason: Buffer) => {
      this.realtimeSocket = null;
      this.realtimeConnected = false;
      if (this.realtimeStableTimer) {
        clearTimeout(this.realtimeStableTimer);
        this.realtimeStableTimer = null;
      }
      this.updatePollingForRealtime();
      const detail = reason ? ` (${reason.toString()})` : '';
      if (this.debugEnabled) {
        this.log.warn(`Realtime updates disconnected (code ${code})${detail}; will retry.`);
      } else if (code !== 1000 && code !== 1001) {
        this.log.warn('Realtime updates temporarily disconnected; retrying automatically.');
      }
      this.scheduleRealtimeReconnect();
    });
  }

  private stopRealtimeSubscriber() {
    if (this.realtimeReconnectTimer) {
      clearTimeout(this.realtimeReconnectTimer);
      this.realtimeReconnectTimer = null;
    }
    if (this.realtimeStableTimer) {
      clearTimeout(this.realtimeStableTimer);
      this.realtimeStableTimer = null;
    }
    if (this.realtimeSocket) {
      try {
        this.realtimeSocket.close();
      } catch (error) {
        this.log.debug('Failed to close realtime socket:', error);
      }
      this.realtimeSocket = null;
    }
    if (this.realtimeConnected) {
      this.realtimeConnected = false;
      this.updatePollingForRealtime();
    }
  }

  private scheduleRealtimeReconnect() {
    if (this.realtimeReconnectTimer) {
      return;
    }
    this.realtimeFailures += 1;
    const delaySeconds = Math.min(60, Math.max(5, 2 ** this.realtimeFailures));
    this.realtimeReconnectTimer = setTimeout(() => {
      this.realtimeReconnectTimer = null;
      this.connectRealtimeSubscriber();
    }, delaySeconds * 1000);
  }

  private parseRealtimePayload(data: WebSocket.RawData): unknown | undefined {
    if (typeof data === 'string') {
      try {
        return JSON.parse(data);
      } catch (error) {
        this.log.debug('Realtime payload was not valid JSON:', error);
        return undefined;
      }
    }
    if (Buffer.isBuffer(data)) {
      try {
        return JSON.parse(data.toString('utf-8'));
      } catch (error) {
        this.log.debug('Realtime payload was not valid JSON:', error);
        return undefined;
      }
    }
    return data as unknown;
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
      this.log.debug('Realtime payload had unexpected shape; forcing refresh.');
      this.triggerWebhookRefresh();
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
        this.log.info(`Received first realtime payload for device ${deviceId}.`);
      } else {
        this.log.info('Received first realtime payload.');
      }
    }

    if (deviceId && deviceRecord && recordType === 'DEVICE' && eventType === 'MODIFY') {
      const updated = this.applyDeviceRecord(deviceId, deviceRecord);
      if (updated) {
        const intent = this.lastIntentAt.get(deviceId);
        const now = Date.now();
        if (intent && now - intent.at <= this.intentWindowMs) {
          if (this.debugEnabled) {
            this.log.debug(
              `Skipping immediate refresh for ${deviceId} during intent window ` +
              `(ageMs=${now - intent.at}).`,
            );
          }
          return;
        }
        this.triggerWebhookRefreshWithDelay(2000);
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
    const intent = this.lastIntentAt.get(deviceId);
    const now = Date.now();
    if (intent && now - intent.at <= this.intentWindowMs) {
      const incomingMerged = this.deepMerge(
        (current.__raw ?? {}) as Record<string, unknown>,
        deviceRecord,
      );
      const incomingNormalized = this.puraApi.normalizeDeviceRecord({ ...incomingMerged, id: deviceId });
      if (incomingNormalized) {
        const incomingState = this.getDeviceActiveState(incomingNormalized);
        if (incomingState !== null && incomingState !== intent.state) {
          return false;
        }
      }
    }
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
    void this.updateNightlightAccessory(normalized);
    return true;
  }

  private findAccessoryByDeviceId(deviceId: string): DiffuserAccessory | undefined {
    for (const accessory of this.accessories.values()) {
      const diffuser = accessory as DiffuserAccessory;
      if (diffuser.context?.accessoryType === 'nightlight') {
        continue;
      }
      if (diffuser.context?.device?.id === deviceId) {
        return diffuser;
      }
    }
    return undefined;
  }

  private getDeviceActiveState(device: PuraDevice): boolean | null {
    const bay1 = device.bay1;
    const bay2 = device.bay2;
    if (!bay1 && !bay2) {
      return null;
    }
    if (bay1?.active || bay2?.active) {
      return true;
    }
    return false;
  }

  recordIntent(deviceId: string, state: boolean) {
    this.lastIntentAt.set(deviceId, { state, at: Date.now() });
  }

  private triggerWebhookRefresh() {
    this.triggerWebhookRefreshWithDelay(2000);
  }

  private triggerWebhookRefreshWithDelay(delayMs: number) {
    const dueAt = Date.now() + delayMs;
    if (this.webhookRefreshDueAt !== null && this.webhookRefreshDueAt <= dueAt) {
      return;
    }
    if (this.webhookRefreshTimer) {
      clearTimeout(this.webhookRefreshTimer);
    }
    this.webhookRefreshDueAt = dueAt;
    this.webhookRefreshTimer = setTimeout(() => {
      this.webhookRefreshTimer = null;
      this.webhookRefreshDueAt = null;
      void this.runRefreshCycle();
    }, Math.max(0, dueAt - Date.now()));
  }

  private updatePollingForRealtime() {
    const nextBase = this.realtimeConnected ? 300 : 15;
    if (this.refreshBaseIntervalSeconds === nextBase) {
      return;
    }
    this.refreshBaseIntervalSeconds = nextBase;
    this.refreshFailures = 0;
    const label = this.realtimeConnected ? 'realtime connected' : 'realtime disconnected';
    this.log.debug(`Adjusting polling interval to ${nextBase}s (${label}).`);
    const ageMs = Date.now() - this.lastRefreshAt;
    if (!this.refreshInFlight && ageMs > 60000) {
      this.scheduleNextRefresh(0);
    }
  }

  isDebugEnabled(): boolean {
    return this.debugEnabled;
  }

  private scheduleRealtimeStableLog() {
    if (this.realtimeStableTimer) {
      clearTimeout(this.realtimeStableTimer);
    }
    this.realtimeStableTimer = setTimeout(() => {
      this.realtimeStableTimer = null;
      if (this.realtimeConnected) {
        this.log.info('Realtime connection stable for 60 minutes.');
        this.scheduleRealtimeStableLog();
      }
    }, 60 * 60 * 1000);
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
      await this.reconcileDiscoveredDevices(devices);
      
      for (const device of devices) {
        await this.updateDiffuserAccessory(device);
        await this.updateNightlightAccessory(device);
      }
      this.lastRefreshAt = Date.now();
    } catch (error) {
      this.log.debug('Device status refresh failed:', error);
      // Try to re-authenticate if authentication failed, then retry once
      if (this.isAuthError(error)) {
        const reauthed = await this.ensureAuthenticatedForRefresh();
        if (reauthed) {
          try {
            const devices = await this.puraApi.getDevices();
            await this.reconcileDiscoveredDevices(devices);
            for (const device of devices) {
              await this.updateDiffuserAccessory(device);
              await this.updateNightlightAccessory(device);
            }
            this.lastRefreshAt = Date.now();
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
    const uniqueId = this.getDiffuserUniqueId(device.id);
    const uuid = this.api.hap.uuid.generate(uniqueId);
    let accessory = this.accessories.get(uuid) as DiffuserAccessory | undefined;
    if (!accessory) {
      const legacyUuid = this.api.hap.uuid.generate(this.getLegacyDiffuserUniqueId(device.id));
      accessory = this.accessories.get(legacyUuid) as DiffuserAccessory | undefined;
    }

    if (accessory) {
      const intent = this.lastIntentAt.get(device.id);
      const now = Date.now();
      if (intent && now - intent.at <= this.intentWindowMs) {
        const incomingState = this.getDeviceActiveState(device);
        if (incomingState !== null && incomingState !== intent.state) {
          return;
        }
      }
      accessory.context.device = device;
      this.api.updatePlatformAccessories([accessory]);
      const handler = accessory.handler;
      if (handler) {
        handler.updateDevice(device);
      }
    }
  }

  private async updateNightlightAccessory(device: PuraDevice) {
    const uniqueId = `${device.id}-nightlight`;
    const uuid = this.api.hap.uuid.generate(uniqueId);
    const accessory = this.accessories.get(uuid) as DiffuserAccessory | undefined;
    if (!accessory) {
      return;
    }
    accessory.context.device = device;
    this.api.updatePlatformAccessories([accessory]);
    const handler = accessory.handler;
    if (handler) {
      handler.updateDevice(device);
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
