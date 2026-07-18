# ADB MCP Server

MCP server for controlling Android, Fire TV, and Android TV devices through ADB.

The intended setup is a local machine in the office, for example a Mac Mini with one or more physical Fire TV devices connected over USB. A remote agent can use this MCP server to inspect the device, install and uninstall applications, navigate with D-pad input, capture screenshots, and collect logcat context around failures.

## Tools

- `list_devices`: list ADB-visible devices.
- `connect_device` / `disconnect_device`: manage ADB-over-TCP targets.
- `select_device` / `clear_active_device`: set session device context.
- `get_device_info`: read device model, Android version, screen size, density, and build info.
- `screenshot`: capture a PNG screenshot.
- `dump_ui`: return UI Automator XML when supported by the target.
- `get_current_activity`: inspect the current resumed activity.
- `press_key`: send safe remote-control key events, including D-pad.
- `tap`, `swipe`, `type_text`: perform bounded input operations.
- `install_apk`: install an APK from the configured APK root.
- `uninstall_app`: uninstall an application by package name, optionally retaining its data.
- `launch_app`, `stop_app`: control an installed application.
- `get_logcat`: read recent logcat lines with optional text filtering.
- `list_build_profiles`: show configured build profiles.
- `run_build`: run a configured build profile and optionally install the resulting APK.

## Installing and uninstalling applications

`install_apk` installs an APK located inside the configured `ADB_APK_ROOT`. It supports replacing an existing application, installing test-only APKs, and granting runtime permissions:

```json
{
  "apk_path": "artifacts/app-debug.apk",
  "replace": true,
  "allow_test": true,
  "grant_permissions": false,
  "device_serial": "192.168.1.50:5555"
}
```

`uninstall_app` removes an installed application using its Android package name:

```json
{
  "package_name": "com.example.tv",
  "keep_data": false,
  "device_serial": "192.168.1.50:5555"
}
```

The `device_serial` field is optional for both tools. When omitted, the active device is used, or the only ready device is selected automatically.

By default, `uninstall_app` removes the application and its data. Set `keep_data` to `true` to retain its data and cache directories using `adb uninstall -k`. Package names are validated before invoking ADB, and the tool only reports success when ADB explicitly returns `Success`.

Both installation and uninstallation are exposed as destructive MCP operations. Agents should verify the intended device and package before calling them.

## Build Profiles

Builds are intentionally not arbitrary shell commands sent by the agent. The server owner declares allowed profiles in `adb-mcp.config.json`, and the MCP tool can only run those profiles.

Example:

```json
{
  "projectRoot": "../MyAndroidTvApp",
  "profiles": [
    {
      "name": "debug",
      "description": "Gradle debug APK",
      "executable": "./gradlew",
      "args": ["app:assembleDebug"],
      "cwd": ".",
      "artifactPath": "app/build/outputs/apk/debug/app-debug.apk",
      "timeoutMs": 600000
    },
    {
      "name": "release",
      "description": "Gradle release APK",
      "executable": "./gradlew",
      "args": ["app:assembleRelease"],
      "cwd": ".",
      "artifactPath": "app/build/outputs/apk/release/app-release.apk",
      "timeoutMs": 900000
    }
  ]
}
```

`run_build` can be called with `install_after_build: true` when the profile declares an APK `artifactPath`.

## Configuration

Environment variables:

- `ADB_EXECUTABLE`: ADB executable path. Defaults to `adb`.
- `ADB_PROJECT_ROOT`: project root used for default config and APK root. Defaults to the server working directory.
- `ADB_APK_ROOT`: directory from which APK installation is allowed. Defaults to `ADB_PROJECT_ROOT`.
- `ADB_BUILD_CONFIG`: path to build profile JSON. Defaults to `adb-mcp.config.json` in the server working directory when present.
- `ADB_TIMEOUT_MS`: default ADB command timeout. Defaults to `30000`.
- `ADB_MAX_OUTPUT_BYTES`: default ADB output limit. Defaults to `5242880`.
- `ADB_SCREENSHOT_MAX_BYTES`: maximum raw PNG size accepted from `adb screencap`. Defaults to `8388608`. The current implementation does not resize or recompress the screenshot.

## Local Development

```bash
npm install
npm run build
npm start
```

Configure your MCP client to run:

```bash
node /absolute/path/to/adb-mcp-server/dist/index.js
```
