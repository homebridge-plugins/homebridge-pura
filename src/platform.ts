import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { PuraPlatformAccessory } from './platformAccessory.js';
import { PuraNightlightAccessory } from './puraNightlightAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { PuraApi } from './puraApi.js';
import { PuraDevice, PuraConfig } from './puraTypes.js';
import { fetchLatestCognitoConfig } from './pypuraLookup.js';

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
  private refreshInterval: NodeJS.Timeout | null = null;
  private cognitoRefreshInterval: NodeJS.Timeout | null = null;
  private attemptedCognitoUpdate = false;
  private latestCognitoVersion: string | null = null;

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
      if (this.refreshInterval) {
        clearInterval(this.refreshInterval);
      }
      if (this.cognitoRefreshInterval) {
        clearInterval(this.cognitoRefreshInterval);
      }
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
      await this.puraApi.authenticate(this.puraConfig.username, this.puraConfig.password);
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

    // Nightlight accessory (one per device)
    await this.registerNightlightAccessory(device);
  }

  private async registerDiffuserAccessory(device: PuraDevice) {
    const deviceName = device.name || `Pura ${device.id}`;
    const baseName = deviceName.endsWith('Diffuser') ? deviceName : `${deviceName} Diffuser`;
    const accessoryName = baseName;
    const uniqueId = `${device.id}-diffuser`;
    const uuid = this.api.hap.uuid.generate(uniqueId);

    const existingAccessory = this.accessories.get(uuid);
    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      existingAccessory.context.device = device;
      this.api.updatePlatformAccessories([existingAccessory]);
      (existingAccessory as any).handler = new PuraPlatformAccessory(this, existingAccessory, this.puraApi);
    } else {
      this.log.info('Adding new accessory:', accessoryName);
      const accessory = new this.api.platformAccessory(accessoryName, uuid);
      accessory.context.device = device;
      (accessory as any).handler = new PuraPlatformAccessory(this, accessory, this.puraApi);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    this.discoveredCacheUUIDs.push(uuid);
  }

  private async registerNightlightAccessory(device: PuraDevice) {
    const deviceName = device.name || `Pura ${device.id}`;
    const baseName = deviceName.endsWith('Diffuser') ? deviceName : `${deviceName} Diffuser`;
    const accessoryName = `${baseName} Nightlight`;
    const uniqueId = `${device.id}-nightlight`;
    const uuid = this.api.hap.uuid.generate(uniqueId);

    const existingAccessory = this.accessories.get(uuid);
    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      existingAccessory.context.device = device;
      this.api.updatePlatformAccessories([existingAccessory]);
      (existingAccessory as any).handler = new PuraNightlightAccessory(this, existingAccessory, this.puraApi);
    } else {
      this.log.info('Adding new accessory:', accessoryName);
      const accessory = new this.api.platformAccessory(accessoryName, uuid);
      accessory.context.device = device;
      (accessory as any).handler = new PuraNightlightAccessory(this, accessory, this.puraApi);
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
    const interval = (this.puraConfig.refreshInterval || 300) * 1000; // Convert to milliseconds
    this.log.debug(`Setting up refresh interval: ${interval / 1000} seconds`);

    this.refreshInterval = setInterval(async () => {
      try {
        this.log.debug('Refreshing device status...');
        await this.refreshDeviceStatus();
      } catch (error) {
        this.log.error('Failed to refresh device status:', error);
      }
    }, interval);
  }

  private setupCognitoRefreshInterval() {
    const intervalSeconds = this.puraConfig.cognitoRefreshInterval ?? 3600;
    if (intervalSeconds <= 0) {
      this.log.debug('Cognito refresh interval disabled');
      return;
    }
    const interval = intervalSeconds * 1000;
    this.log.debug(`Setting up Cognito refresh interval: ${intervalSeconds} seconds`);
    this.cognitoRefreshInterval = setInterval(async () => {
      try {
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
      } catch (error) {
        this.log.debug('Cognito refresh check failed:', error);
      }
    }, interval);
  }

  /**
   * Refresh status of all devices
   */
  private async refreshDeviceStatus() {
    try {
      const devices = await this.puraApi.getDevices();
      
      for (const device of devices) {
        await this.updateDiffuserAccessory(device);
        await this.updateNightlightAccessory(device);
      }
    } catch (error) {
      this.log.debug('Device status refresh failed:', error);
      // Try to refresh tokens if authentication failed
      if (error instanceof Error && error.message.includes('authentication')) {
        try {
          await this.puraApi.refreshToken();
          this.log.debug('Token refresh successful');
        } catch (refreshError) {
          this.log.error('Token refresh failed:', refreshError);
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
    const accessory = this.accessories.get(uuid);

    if (accessory) {
      accessory.context.device = device;
      this.api.updatePlatformAccessories([accessory]);
      const handler = (accessory as any).handler as PuraPlatformAccessory | undefined;
      if (handler) {
        handler.updateDevice(device);
      }
    }
  }

  private async updateNightlightAccessory(device: PuraDevice) {
    const uniqueId = `${device.id}-nightlight`;
    const uuid = this.api.hap.uuid.generate(uniqueId);
    const accessory = this.accessories.get(uuid);

    if (accessory) {
      accessory.context.device = device;
      this.api.updatePlatformAccessories([accessory]);
      const handler = (accessory as any).handler as PuraNightlightAccessory | undefined;
      if (handler) {
        handler.updateDevice(device);
      }
    }
  }
}
