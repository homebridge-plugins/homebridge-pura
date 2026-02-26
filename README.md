<img src="branding/icon.png" alt="Pura Logo" width="125" />

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

**A Homebridge plugin for Pura smart fragrance diffusers.**

By default this plugin exposes a single on/off switch per diffuser. It’s designed to be used with Pura’s away mode and scheduling features disabled, so HomeKit can act as the primary automation layer.

You can optionally enable:
- Intensity Control: fan-style accessory with Subtle/Medium/Strong intensity levels.
- Nightlight Control: supports on/off, Brightness (snapped to Pura's 10-step brightness levels), and color in either separate-accessory or bound-to-diffuser mode.

## Supported Diffusers
This plugin has been designed and tested for the following diffusers.

<img src="branding/supported-devices.png" alt="Supported Pura Diffusers" />

## Installation

1. Install this plugin using: `npm install -g @homebridge-plugins/homebridge-pura`
2. Edit your `config.json` file (see sample config below)
3. Run Homebridge

## Configuration

Add the following platform to your `config.json`:

```json
{
  "platforms": [
    {
      "name": "Pura Smart Diffuser",
      "platform": "PuraSmartDiffuser",
      "username": "your-pura-email@example.com",
      "password": "your-pura-password",
      "forceNightlightOff": false,
      "enableFanService": false,
      "enableNightlightAccessory": false,
      "nightlightMode": "separate"
    }
  ]
}
```

### Configuration Options

- **username**: Your Pura email - *required*
- **password**: Your Pura password - *required*
- **forceNightlightOff**: Pura turns the nightlight on/off with the diffuser. Enable to prevent the light from staying on. (default: false)
- **enableFanService (Enable Intensity Control)**: Changes the diffuser from an on/off switch to a fan accessory that controls intensity (Subtle, Medium, Strong). For multi-bay diffusers, HomeKit intensity changes are applied across available bays to keep auto-alternate behavior consistent. (default: false)
- **enableNightlightAccessory**: Enables nightlight controls (On/Brightness/Color) for compatible diffusers. (default: false)
- **nightlightMode**: Nightlight control layout when enabled:
  - `separate` (default): creates a dedicated `Nightlight Control` accessory tile.
  - `bound`: attaches the light service to the diffuser accessory (switch/fan tile).
  Changing modes may require updating HomeKit scenes or automations.

## Usage

By default, each diffuser appears as a single switch in HomeKit (e.g., "Living Room Diffuser").

If `enableFanService` is set to `true`, each diffuser uses intensity control mode instead, with RotationSpeed mapped to:
- Subtle: 30
- Medium: 50
- Strong: 100

For multi-bay diffusers, intensity changes from HomeKit are synced across available bays.

Switching accessory types will require recreating HomeKit scenes and automations for all Pura diffusers in this plugin.

If `enableNightlightAccessory` is set to `true`, `nightlightMode` controls how nightlight appears:
- `separate`: each compatible diffuser includes a separate `Nightlight Control` accessory tile.
- `bound`: a light service is attached directly to the diffuser accessory.

### Controls

- **Power (default mode)**: Turn the diffuser on/off using the switch accessory
- **Intensity Control (optional mode)**: Use the fan-style accessory and set intensity to Subtle, Medium, or Strong
- **Nightlight Control (optional)**:
  - On/Off
  - Brightness (snapped to Pura's 10-step brightness levels)
  - Color (Hue/Saturation)

### Device Management

The plugin will automatically:
- Discover all Pura devices on your account
- Create one diffuser accessory per device:
  - Switch by default
  - Intensity control accessory when `enableFanService=true`
- Optionally add nightlight control on compatible models when enabled:
  - Separate `Nightlight Control` accessory (`nightlightMode=separate`)
  - Bound light service on the diffuser accessory (`nightlightMode=bound`)
- Update device status via realtime updates with a 5-minute polling fallback (15s when realtime is down)
- Handle authentication and token refresh (including periodic Cognito refresh polling)

## Recommended Usage

- Use this plugin in lieu of Pura schedules or away mode.
- Enable **Auto-alternative fragrances** in the Pura app to ensure equal scent distribution.

## Troubleshooting

### Authentication Issues

If you encounter authentication errors:
1. Verify your username and password are correct
2. Check that your Pura account is active and can log in to the mobile app
3. Ensure your internet connection is stable

### Device Not Appearing

If your Pura device doesn't appear in HomeKit:
1. Check that the device is online and connected to WiFi
2. Verify it appears in the Pura mobile app
3. Check Homebridge logs for error messages
4. Try restarting Homebridge

### Connectivity Issues

If the plugin loses connection:
1. Check your internet connection
2. Verify Pura services are operational
3. Try restarting the plugin by restarting Homebridge

## Support

For issues and feature requests, please use the [GitHub Issues](https://github.com/homebridge-plugins/homebridge-pura/issues) page.

## Credits

This plugin is inspired by and based on the [pypura](https://github.com/natekspencer/pypura) Python library by @natekspencer.

## License

Apache-2.0
