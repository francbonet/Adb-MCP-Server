# ADB MCP Server

MCP server for controlling Android, Fire TV, and Android TV devices through ADB.

The intended setup is a local machine in the office, for example a Mac Mini with Android emulators or physical Fire TV devices. A remote agent can start an AVD, inspect and control the selected device, install and uninstall applications, capture optimized screenshots, record evidence through OBS, and collect logcat context around failures.

## Installation

This server uses the MCP stdio transport. Build it once, then configure each MCP client to start `dist/index.js` with Node.js.

Prerequisites:

- Node.js `18.17` or newer.
- ADB installed and able to see the intended devices.
- Android Emulator installed when using `list_avds` or `start_emulator`.
- OBS Studio 28 or newer when using the OBS recording tools.

Prepare the server:

```bash
git clone <repo-url> adb-mcp-server
cd adb-mcp-server
npm install
npm run build
```

Find the absolute paths you will need in desktop apps:

```bash
pwd
which node
which adb
```

Use absolute paths for desktop clients. On macOS, GUI apps often do not inherit your shell `PATH`, so `node`, `adb`, the Android Emulator, or OBS may not be found unless you configure explicit paths.

### OpenAI Codex CLI, IDE extension, and ChatGPT desktop app

Codex CLI, the Codex IDE extension, and the ChatGPT desktop app share Codex MCP configuration through `config.toml`. You can add the server with the CLI:

```bash
codex mcp add adb \
  --env ADB_EXECUTABLE=/absolute/path/to/adb \
  -- /absolute/path/to/node /absolute/path/to/adb-mcp-server/dist/index.js
```

Then verify it:

```bash
codex mcp list
```

For explicit configuration, edit `~/.codex/config.toml` or a trusted project-scoped `.codex/config.toml`:

```toml
[mcp_servers.adb]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/adb-mcp-server/dist/index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 300

[mcp_servers.adb.env]
ADB_EXECUTABLE = "/absolute/path/to/adb"
ADB_PROJECT_ROOT = "/absolute/path/to/android-project"
ADB_APK_ROOT = "/absolute/path/to/android-project"
ANDROID_EMULATOR_EXECUTABLE = "/absolute/path/to/emulator"
ADB_ALLOWED_AVDS = "Television_1080p_API_34"
```

Optional OBS variables can be added to the same `env` table:

```toml
# Add these under [mcp_servers.adb.env] when OBS recording is needed.
OBS_EXECUTABLE = "/Applications/OBS.app"
OBS_WEBSOCKET_URL = "ws://127.0.0.1:4455"
OBS_WEBSOCKET_PASSWORD = "replace-with-the-local-password"
OBS_EMULATOR_SCENE = "Android Emulator"
OBS_EMULATOR_SOURCE = "Android Emulator Capture"
OBS_PHYSICAL_DEVICE_SCENE = "Physical Device - HDMI"
OBS_PHYSICAL_DEVICE_SOURCE = "Capture Card"
```

In the Codex TUI, use `/mcp` to inspect connected servers. In the Codex IDE extension or ChatGPT desktop app, open settings, add an MCP server, choose STDIO, and use the same command, args, and environment values shown above.

ChatGPT web does not read local Codex MCP configuration. To use this local stdio server with OpenAI clients, use Codex CLI, the IDE extension, or the ChatGPT desktop app on the machine that has ADB access.

### Claude Code

Claude Code can install this server as a local stdio MCP server:

```bash
claude mcp add --scope user --transport stdio \
  --env ADB_EXECUTABLE=/absolute/path/to/adb \
  --env ADB_PROJECT_ROOT=/absolute/path/to/android-project \
  --env ADB_APK_ROOT=/absolute/path/to/android-project \
  adb \
  -- /absolute/path/to/node /absolute/path/to/adb-mcp-server/dist/index.js
```

Use `--scope user` to make it available in all your Claude Code projects. Use `--scope local` for only the current project, or `--scope project` to create a shared `.mcp.json` in the repository.

Manage and verify the server:

```bash
claude mcp list
claude mcp get adb
```

Inside Claude Code, use `/mcp` to inspect server status and approve or authenticate servers when needed.

Project-scoped Claude Code configuration can also be committed as `.mcp.json`, but avoid hard-coding machine-specific absolute paths in shared repositories unless every developer uses the same layout:

```json
{
  "mcpServers": {
    "adb": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/adb-mcp-server/dist/index.js"],
      "env": {
        "ADB_EXECUTABLE": "/absolute/path/to/adb",
        "ADB_PROJECT_ROOT": "/absolute/path/to/android-project",
        "ADB_APK_ROOT": "/absolute/path/to/android-project"
      },
      "timeout": 300000
    }
  }
}
```

### Claude Desktop

Claude Desktop supports local MCP servers through desktop extensions and through manual JSON configuration. This repository does not currently ship a `.mcpb` desktop extension, so use manual configuration.

Open Claude Desktop settings, go to the Developer section, and edit `claude_desktop_config.json`. Common locations:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add this server:

```json
{
  "mcpServers": {
    "adb": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/adb-mcp-server/dist/index.js"],
      "env": {
        "ADB_EXECUTABLE": "/absolute/path/to/adb",
        "ADB_PROJECT_ROOT": "/absolute/path/to/android-project",
        "ADB_APK_ROOT": "/absolute/path/to/android-project",
        "ANDROID_EMULATOR_EXECUTABLE": "/absolute/path/to/emulator"
      }
    }
  }
}
```

Restart Claude Desktop after saving the file. In a conversation, open the connectors/tools menu and confirm the `adb` server is connected.

## Tools

- `list_devices`: list ADB-visible devices.
- `list_avds`: list configured Android Virtual Devices and their running state.
- `start_emulator`: start an AVD with quick or cold boot and select it as the active device.
- `connect_device` / `disconnect_device`: manage ADB-over-TCP targets.
- `select_device` / `clear_active_device`: set session device context.
- `get_device_info`: read device model, Android version, screen size, density, and build info.
- `screenshot`: capture and optimize a PNG screenshot for agent analysis.
- `dump_ui`: return UI Automator XML when supported by the target.
- `get_current_activity`: inspect the current resumed activity.
- `press_key`: send safe remote-control key events, including D-pad.
- `tap`, `swipe`, `type_text`: perform bounded input operations.
- `install_apk`: install an APK from the configured APK root.
- `uninstall_app`: uninstall an application by package name, optionally retaining its data.
- `launch_app`, `stop_app`: control an installed application.
- `get_logcat`: read recent logcat lines with optional text filtering.
- `get_obs_status`: inspect the active OBS scene and recording state.
- `open_obs`: open OBS and optionally select a configured capture scene.
- `start_obs_recording`: verify the configured emulator or physical-device source and start recording.
- `stop_obs_recording`: stop recording and return the saved video path.
- `list_build_profiles`: show configured build profiles.
- `run_build`: run a configured build profile and optionally install the resulting APK.

## Android emulators

`list_avds` calls the Android Emulator executable to list the available AVDs and correlates them with ADB devices. Running entries include their `emulator-XXXX` serial and current ADB state.

`start_emulator` starts an AVD and waits until `sys.boot_completed` reports that Android is ready. The resulting emulator is selected as the active device for the MCP session:

```json
{
  "avd_name": "Television_1080p_API_34",
  "boot_mode": "cold",
  "headless": false,
  "timeout_ms": 180000
}
```

- `boot_mode: "quick"` allows the emulator to restore a Quick Boot snapshot.
- `boot_mode: "cold"` uses `-no-snapshot-load` and performs a full boot without loading a snapshot. State may still be saved when the emulator exits.
- `headless: true` adds `-no-window`. Do not use it when OBS must capture the emulator window.

The operation is idempotent. If the requested AVD is already running, the existing serial is selected and a second instance is not started. In that case a requested cold boot is not performed.

Use `ADB_ALLOWED_AVDS` in shared environments to restrict which AVD names an agent may start.

## Screenshot optimization

The `screenshot` tool captures a raw PNG with `adb exec-out screencap -p`, then processes it before returning it to the agent. By default it:

- Fits the image inside `1280x720` without enlarging smaller screenshots.
- Uses an indexed PNG palette with up to 256 colours.
- Applies adaptive filtering and maximum PNG compression.
- Reduces the colour palette and then the resolution progressively if needed.
- Enforces a final binary PNG limit of `1048576` bytes (1 MiB).
- Removes incidental metadata during re-encoding.

The tool response reports the original and delivered dimensions and byte sizes. The Base64 representation used by MCP is approximately 33% larger than the binary PNG; `ADB_SCREENSHOT_OUTPUT_MAX_BYTES` controls the decoded PNG size, not the complete JSON payload.

The raw ADB capture limit and final optimized-image limit are intentionally separate. A large source PNG can be accepted and then compressed instead of failing before processing.

## OBS evidence recording

OBS control uses the WebSocket interface built into OBS Studio 28 and later. Before using the recording tools:

1. Open OBS and enable its WebSocket server under **Tools → WebSocket Server Settings**.
2. Keep authentication enabled and provide the password through `OBS_WEBSOCKET_PASSWORD`.
3. On macOS, grant OBS the Screen & System Audio Recording permission.
4. Create the scenes and sources that represent the emulator and/or physical device.
5. Configure the exact scene and source names in the MCP server environment.

Example configuration:

```bash
OBS_WEBSOCKET_URL=ws://127.0.0.1:4455
OBS_WEBSOCKET_PASSWORD=replace-with-the-local-password
OBS_EMULATOR_SCENE="Android Emulator"
OBS_EMULATOR_SOURCE="Android Emulator Capture"
OBS_PHYSICAL_DEVICE_SCENE="Physical Device - HDMI"
OBS_PHYSICAL_DEVICE_SOURCE="Capture Card"
```

The server does not expose the WebSocket password to agents. Keep the WebSocket listener bound to localhost unless remote OBS control is explicitly required and secured separately.

### Emulator source

Create a `macOS Screen Capture` source in the configured emulator scene. Application Capture is convenient when only one emulator runs at a time. Window Capture is preferable when multiple AVDs may be open.

When `avd_name` is supplied, `start_obs_recording` reads the source's available `window` and `application` property values and selects the item containing that AVD name. It then activates the configured scene, confirms that the source is active, and requests a preview image from OBS before starting the recording. If the expected source or AVD window cannot be confirmed, the tool fails without recording another window.

The scene and source must be created once in OBS; the MCP server selects and updates them but does not create platform-specific capture sources from scratch.

```json
{
  "target": "emulator",
  "avd_name": "Television_1080p_API_34",
  "launch_if_needed": true,
  "timeout_ms": 30000
}
```

### Physical-device source

For a physical Android or Fire TV device, configure one of these as the source in the physical-device scene:

- A USB HDMI capture device exposed to OBS as a Video Capture Device.
- A mirroring application such as `scrcpy`, captured as a window.

ADB itself is not an OBS video source. Protected DRM/HDCP content may appear black and this server does not attempt to bypass content protection.

```json
{
  "target": "physical_device",
  "launch_if_needed": true
}
```

`open_obs` starts OBS when necessary and waits for WebSocket to become ready. `start_obs_recording` is idempotent when OBS is already recording the configured scene; it refuses to switch scenes during a different active recording. `stop_obs_recording` finalizes the recording and returns the path reported by OBS.

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
- `ADB_SCREENSHOT_MAX_BYTES`: maximum raw PNG size accepted from `adb screencap`. Defaults to `33554432`, allowing 4K captures to be processed before applying the smaller delivery limit.
- `ADB_SCREENSHOT_OUTPUT_MAX_BYTES`: maximum optimized PNG size. Defaults to `1048576`.
- `ADB_SCREENSHOT_MAX_WIDTH`: maximum delivered screenshot width. Defaults to `1280`.
- `ADB_SCREENSHOT_MAX_HEIGHT`: maximum delivered screenshot height. Defaults to `720`.
- `ANDROID_EMULATOR_EXECUTABLE`: Android Emulator executable. Defaults to `$ANDROID_SDK_ROOT/emulator/emulator`, `$ANDROID_HOME/emulator/emulator`, or `emulator` from `PATH`.
- `ADB_ALLOWED_AVDS`: optional comma-separated allowlist of AVD names.
- `OBS_EXECUTABLE`: OBS application name, `.app` path, or executable path. Defaults to `OBS` on macOS and `obs` elsewhere.
- `OBS_WEBSOCKET_URL`: OBS WebSocket endpoint. Defaults to `ws://127.0.0.1:4455`.
- `OBS_WEBSOCKET_PASSWORD`: OBS WebSocket authentication password.
- `OBS_EMULATOR_SCENE` / `OBS_EMULATOR_SOURCE`: configured OBS scene and source for emulator recording.
- `OBS_PHYSICAL_DEVICE_SCENE` / `OBS_PHYSICAL_DEVICE_SOURCE`: configured OBS scene and source for physical-device recording.

## Local Development

```bash
npm install
npm run build
npm test
```
