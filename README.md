<img src="branding/icon.png" alt="Pura Logo" width="125" />

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

**A Homebridge plugin for Pura smart fragrance diffusers.**

This plugin is intentionally simple. It exposes a single on/off switch per diffuser, allowing you to control each device using HomeKit.

It’s designed to be used with Pura’s auto-away and scheduling features disabled, so HomeKit can act as the primary automation layer.

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
      "email": "your-pura-email@example.com",
      "password": "your-pura-password",
      "forceNightlightOff": false
    }
  ]
}
```

### Configuration Options

- **username**: Your Pura email - *required*
- **password**: Your Pura password - *required*
- **forceNightlightOff**: Pura turns the nightlight on/off with the diffuser. Enable to prevent the light from staying on. (default: false)

## Usage

Once configured, your Pura diffusers will appear in the Home app as a single switch per diffuser (e.g., "Living Room Diffuser").

### Controls

- **Power**: Turn the diffuser on/off

### Device Management

The plugin will automatically:
- Discover all Pura devices on your account
- Create one switch per diffuser
- Update device status via realtime updates with a 5-minute polling fallback (15s when realtime is down)
- Handle authentication and token refresh (including periodic Cognito refresh polling)

## Recommended Usage

- Use this plugin in lieu of Pura schedules or auto-away.
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
