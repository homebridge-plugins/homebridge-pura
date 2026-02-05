# Homebridge Pura

A Homebridge plugin for Pura smart fragrance diffusers.

This plugin allows you to control your Pura smart fragrance diffusers through Apple HomeKit. Each fragrance bay on your Pura device will appear as a separate fan in the Home app, where you can:

- Turn the diffuser on/off
- Adjust the fragrance intensity (0-100%)
- Monitor the current state of your diffusers

## Installation

1. Install this plugin using: `npm install -g homebridge-pura`
2. Edit your `config.json` file (see sample config below)
3. Run Homebridge

## Configuration

Add the following platform to your `config.json`:

```json
{
  "platforms": [
    {
      "name": "Pura Fragrance Diffuser",
      "platform": "PuraFragranceDiffuser",
      "username": "your-pura-email@example.com",
      "password": "your-pura-password",
      "refreshInterval": 300,
      "userPoolId": "us-east-1_LaB718hYv",
      "clientId": "4iekubat0jb5iljfbaalsiqf9j",
      "baseUrl": "https://trypura.io/mobile/api/",
      "autoUpdateCognito": true
    }
  ]
}
```

### Configuration Options

- **username**: Your Pura app username (email address) - *required*
- **password**: Your Pura app password - *required*
- **refreshInterval**: How often to refresh device status in seconds (default: 300, min: 30, max: 3600)
- **userPoolId**: Override the default Cognito User Pool ID (advanced)
- **clientId**: Override the default Cognito Client ID (advanced)
- **baseUrl**: Override the API base URL (advanced)
- **autoUpdateCognito**: If authentication fails, fetch the latest Cognito IDs from the pypura PyPI release and retry once (advanced, default: true; requires outbound HTTPS to PyPI on failure)

## Features

- **Multiple Device Support**: Automatically discovers all Pura devices on your account
- **Bay-Level Control**: Each fragrance bay appears as a separate fan accessory
- **Intensity Control**: Use the fan speed slider to adjust fragrance intensity
- **Real-Time Status**: Automatically refreshes device status
- **HomeKit Integration**: Full integration with Apple HomeKit and the Home app

## Usage

Once configured, your Pura diffusers will appear in the Home app as fans. Each fragrance bay will be a separate accessory (e.g., "Living Room Pura Bay 1", "Living Room Pura Bay 2").

### Controls

- **Power**: Turn the diffuser on/off
- **Fan Speed**: Adjust the fragrance intensity (0-100%)

### Device Management

The plugin will automatically:
- Discover all Pura devices on your account
- Create accessories for each fragrance bay
- Update device status based on the configured refresh interval
- Handle authentication and token refresh

## Troubleshooting

### Authentication Issues

If you encounter authentication errors:
1. Verify your username and password are correct
2. Check that your Pura account is active and can log in to the mobile app
3. Ensure your internet connection is stable
4. If the error mentions a Cognito client or user pool, either enable `autoUpdateCognito` (default) or set `clientId` and `userPoolId` to the latest values

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

For issues and feature requests, please use the [GitHub Issues](https://github.com/pradeepmouli/homebridge-pura/issues) page.

## Development

### Release Process

This project uses automated releases via GitHub Actions. To create a new release:

1. Update the version in `package.json`
2. Commit your changes: `git commit -am "Release v1.x.x"`
3. Create and push a version tag: `git tag v1.x.x && git push origin v1.x.x`

The GitHub Actions workflow will automatically:
- Build and test the code
- Create a GitHub release
- Publish the package to npm

**Note**: Make sure the version in `package.json` matches the tag version (without the 'v' prefix). The workflow will verify this and fail if they don't match.

### Prerequisites for Publishing

To publish releases, repository maintainers need to configure:
- `NPM_TOKEN`: A valid npm authentication token with publish permissions

## Credits

This plugin is inspired by and based on the [pypura](https://github.com/natekspencer/pypura) Python library by @natekspencer.

## License

Apache-2.0
