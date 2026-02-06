<img src="Pura_black_Logo.jpg" alt="Pura Logo" width="275" />

**A Homebridge plugin for Pura smart fragrance diffusers.**

This plugin is intentionally simple. It exposes a single on/off switch per diffuser, allowing you to control each device using HomeKit automations.

It’s designed to be used with Pura’s auto-away and scheduling features disabled, so HomeKit can act as the primary automation layer.

While all Pura diffusers are supported, this plugin is best suited for newer Pura models that support auto-alternating fragrances, ensuring equal distribution while the diffuser is running.

## Installation

1. Install this plugin using: `npm install -g @qandnotu/homebridge-pura`
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
      "refreshInterval": 90,
      "forceNightlightOffOnDiffuserOn": false
    }
  ]
}
```

### Configuration Options

- **username**: Your Pura app username (email address) - *required*
- **password**: Your Pura app password - *required*
- **refreshInterval**: How often to refresh device status in seconds (default: 90, min: 60, max: 3600)
- **forceNightlightOffOnDiffuserOn**: By default, Pura turns the nightlight on/off with the diffuser. Enable this to force the nightlight off after the diffuser turns on (default: false)

## Features

- **Multiple Device Support**: Automatically discovers all Pura devices on your account
- **Simple On/Off Control**: One switch per diffuser for HomeKit automations
- **Real-Time Status**: Automatically refreshes device status

## Usage

Once configured, your Pura diffusers will appear in the Home app as a single switch per diffuser (e.g., "Living Room Diffuser").

### Controls

- **Power**: Turn the diffuser on/off

### Device Management

The plugin will automatically:
- Discover all Pura devices on your account
- Create one switch per diffuser
- Update device status based on the configured refresh interval
- Handle authentication and token refresh

## Recommended Usage

- Use this plugin in lieu of Pura schedules or auto-away.
- Enable **Auto-Alternative Fragrances** in the Pura app for best results.
- By default, Pura turns the nightlight on/off with the diffuser. If you want to prevent the light from staying on, enable `forceNightlightOffOnDiffuserOn`.

## Troubleshooting

### Authentication Issues

If you encounter authentication errors:
1. Verify your username and password are correct
2. Check that your Pura account is active and can log in to the mobile app
3. Ensure your internet connection is stable
4. If the error mentions a Cognito client or user pool, the plugin will attempt to fetch the latest Cognito IDs from the pypura PyPI release and retry once (requires outbound HTTPS to PyPI on failure)

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

For issues and feature requests, please use the [GitHub Issues](https://github.com/QandnotU/homebridge-pura/issues) page.

## Credits

This plugin is inspired by and based on the [pypura](https://github.com/natekspencer/pypura) Python library by @natekspencer.

## License

Apache-2.0
