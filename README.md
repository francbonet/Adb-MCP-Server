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

### Usage skills

This repository includes a Codex/OpenAI skill template at `.agents/skills/adb-mcp-server`. The MCP server can be configured globally, but the skill should be installed in the app repository where the agent is doing the Android work.

For OpenAI Codex, Codex IDE extension, and ChatGPT desktop app, install it as a repo-local skill under `.agents/skills`:

```bash
mkdir -p /absolute/path/to/android-project/.agents/skills
cp -R .agents/skills/adb-mcp-server /absolute/path/to/android-project/.agents/skills/
```

Then commit it in the target repository so the team gets the same workflow:

```bash
cd /absolute/path/to/android-project
git add .agents/skills/adb-mcp-server
git commit -m "docs: add ADB MCP usage skill"
```

For a personal Codex/OpenAI skill available across all repositories, copy the same folder to `~/.agents/skills/adb-mcp-server` instead:

```bash
mkdir -p ~/.agents/skills
cp -R .agents/skills/adb-mcp-server ~/.agents/skills/
```

For Claude Code, install the same instructions as a Claude project skill under `.claude/skills`:

```bash
mkdir -p /absolute/path/to/android-project/.claude/skills/adb-mcp-server
cp .agents/skills/adb-mcp-server/SKILL.md /absolute/path/to/android-project/.claude/skills/adb-mcp-server/SKILL.md
```

Then commit it in the target repository:

```bash
cd /absolute/path/to/android-project
git add .claude/skills/adb-mcp-server/SKILL.md
git commit -m "docs: add ADB MCP Claude skill"
```

For a personal Claude Code skill available across all repositories, copy it to `~/.claude/skills/adb-mcp-server/SKILL.md` instead:

```bash
mkdir -p ~/.claude/skills/adb-mcp-server
cp .agents/skills/adb-mcp-server/SKILL.md ~/.claude/skills/adb-mcp-server/SKILL.md
```

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

- `list_devices`: list ADB-visible devices, detected platform, and Android shell utility capabilities.
- `list_avds`: list configured Android Virtual Devices and their running state.
- `start_emulator`: start an AVD with quick or cold boot and select it as the active device.
- `connect_device` / `disconnect_device`: manage ADB-over-TCP targets.
- `select_device` / `clear_active_device`: set session device context.
- `set_project_root`: set the user-confirmed repository root for this MCP session.
- `get_device_info`: read device model, Android version, screen size, density, and build info.
- `screenshot`: capture and optimize a PNG screenshot for agent analysis; pass `save_path` to also write that PNG to disk.
- `dump_ui`: return UI Automator XML when supported by the target.
- `wait_for_ui_node`: wait until UI Automator XML contains a node matching exact text, resource ID, content description, and/or focus state.
- `assert_ui_node`: assert that the current UI Automator XML does or does not contain a matching node.
- `get_current_activity`: inspect the current resumed activity.
- `press_key`: send safe remote-control key events, including D-pad.
- `press_key_sequence`: send a bounded timed sequence of safe key events.
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

## Vega and Kepler devices

The server detects device capabilities before running Android-specific tools. Ready devices are classified as `android`, `vega`, or `unknown`, and `list_devices` reports whether the target exposes `dumpsys`, `uiautomator`, `logcat`, `input`, and `screencap`.

When a Vega/Kepler device is detected, the server uses the Vega CLI backend where Amazon documents an equivalent:

- `press_key`, `press_key_sequence`, `tap`, `swipe`, and `type_text` use `inputd-cli` through `vega exec vda -s <serial> shell`.
- `get_logcat` uses `loggingctl log` through the Vega device shell.
- `launch_app` uses `vega device launch-app --device <serial> --appName <package>.main`.
- `screenshot` uses `gwsi-tool-screenshooter` through VDA on physical Vega/Kepler devices and then pulls the PNG for optimization. On a Vega Virtual Device under macOS it captures the VVD window instead; see [Vega Virtual Device](#vega-virtual-device-vvd).

`wait_for_ui_node`, `assert_ui_node`, and `dump_ui` require Android `uiautomator`. On Vega/Kepler targets that do not expose that Android utility, these tools return a structured unsupported response.

The Vega CLI backends run through `vega`, so set `VEGA_EXECUTABLE` to the absolute path of the Vega CLI (for example `/Users/<you>/vega/bin/vega`) in the MCP server's `env` when `vega` is not on the `PATH` of the app that launches the server. GUI apps such as Claude Desktop usually do not inherit your shell `PATH`.

On unsupported targets, and whenever a required Android shell utility is unavailable, the MCP tool returns a structured unsupported response instead of surfacing raw `/bin/sh: command not found` output:

```json
{
  "ok": false,
  "reason": "unsupported",
  "message": "dump_ui requires uiautomator, which is not available on this Vega/Kepler device.",
  "device_serial": "emulator-5554",
  "platform": "vega",
  "missing_capability": "uiautomator"
}
```

### Vega Virtual Device (VVD)

The Vega Virtual Device from Vega SDK 0.24 appears in `adb devices -l` as a bare emulator serial, for example `emulator-5556 device transport_id:4`, without the `model:VirtualDevice` detail that older SDKs reported. Its shell has no `getprop` but provides `inputd-cli`, so the server classifies a device as `vega` when `getprop` is missing and `inputd-cli` is present. Input, logs, and app launch then use the Vega CLI backends above.

Device-side screenshots do not work on the VVD: Amazon documents `gwsi-tool-screenshooter` as unsupported there, `screenshooter` cannot write its buffer file, and QEMU `screendump` returns a black frame because the picture is rendered on the GPU. On macOS the `screenshot` tool therefore captures the VVD window on the host:

1. It finds the `vega-virtual-device` process started with `-ports <port>,...` for the `emulator-<port>` serial.
2. It looks up that process's on-screen window and captures it with `screencapture -x -o -l <window id>`.
3. It reads the skin `layout` file from the process's `-skindir` and `-skin` arguments and crops the capture to the TV display, removing the window title bar and the on-screen remote control. If the layout cannot be read, the uncropped window is returned.

The result reports `Source: VVD window capture.` and is then optimized and saved through `save_path` like any other screenshot. `gwsi-tool-screenshooter` is not called for the VVD.

Requirements:

- **Screen Recording permission.** macOS only allows window capture for apps that have Screen Recording access. Grant it to the app that launches this MCP server (for example Claude Desktop, your terminal, or your IDE) in System Settings → Privacy & Security → Screen & System Audio Recording, then restart that app. Without it, `screenshot` returns an unsupported response that says so.
- **A visible VVD window.** The window must be on screen on the current Space. A minimized window, or one on another Space, cannot be captured, and the response says so. Other windows may overlap it.

If the window capture fails and `OBS_EMULATOR_SCENE` / `OBS_EMULATOR_SOURCE` are configured, the server falls back to an OBS frame; otherwise it returns the capture error as a structured unsupported response. Physical Vega/Kepler devices, and VVDs on hosts other than macOS, keep using `gwsi-tool-screenshooter` with the existing OBS fallback for emulator serials.

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

## UI waits and assertions

Use `wait_for_ui_node` and `assert_ui_node` to verify Android UI state from the UI Automator hierarchy instead of relying on screenshots or OCR. Matching is exact for `text`, `resource_id`, and `content_desc`; `focused` matches a boolean focus state. At least one of those filters is required.

`wait_for_ui_node` polls until a match appears or the timeout expires:

```json
{
  "device_serial": "emulator-5554",
  "text": "All The Channels",
  "timeout_ms": 3000,
  "poll_interval_ms": 150
}
```

When a match is found, the response includes a summarized node:

```json
{
  "found": true,
  "elapsed_ms": 420,
  "node": {
    "text": "All The Channels",
    "resource_id": "rail-title",
    "content_desc": "",
    "class": "android.widget.TextView",
    "focused": false,
    "bounds": "[100,210][1920,250]"
  }
}
```

If no node matches before the timeout, the response is non-error JSON with `found: false`.

`assert_ui_node` checks the current hierarchy once and returns an MCP error when the assertion fails:

```json
{
  "device_serial": "emulator-5554",
  "content_desc": "Home",
  "focused": true
}
```

To assert absence, set `should_exist` to `false`:

```json
{
  "device_serial": "emulator-5554",
  "text": "Search page",
  "should_exist": false
}
```

Typical TV navigation flow:

```json
{
  "sequence": [
    { "key": "BACK", "delay_ms_after": 1000 },
    { "key": "BACK" }
  ]
}
```

Then verify the result:

```json
{
  "text": "All The Channels",
  "timeout_ms": 3000
}
```

## Screenshot optimization

The `screenshot` tool captures a raw PNG with `adb exec-out screencap -p` on Android devices, the Vega screenshot backend on supported physical Vega/Kepler devices, or the macOS window capture of a Vega Virtual Device, then processes it before returning it to the agent. By default it:

- Fits the image inside `1280x720` without enlarging smaller screenshots.
- Uses an indexed PNG palette with up to 256 colours.
- Applies adaptive filtering and maximum PNG compression.
- Reduces the colour palette and then the resolution progressively if needed.
- Enforces a final binary PNG limit of `1048576` bytes (1 MiB).
- Removes incidental metadata during re-encoding.

The tool response reports the original and delivered dimensions and byte sizes. The Base64 representation used by MCP is approximately 33% larger than the binary PNG; `ADB_SCREENSHOT_OUTPUT_MAX_BYTES` controls the decoded PNG size, not the complete JSON payload.

The raw ADB capture limit and final optimized-image limit are intentionally separate. A large source PNG can be accepted and then compressed instead of failing before processing.

Pass the optional `save_path` argument to also write the delivered PNG to disk, for example to attach it to a merge request:

```json
{
  "save_path": "bug-12/before.png"
}
```

`save_path` must end in `.png` and must be inside `ADB_SCREENSHOT_SAVE_ROOT`. Relative paths resolve against that root, parent folders are created, and an existing file is replaced. Paths that escape the root, including through symbolic links, are rejected. The response adds a `Saved: <absolute path>` line. The saved file is the optimized PNG the agent receives, not the raw capture.

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

The `screenshot` tool can also use the configured `OBS_EMULATOR_SCENE` / `OBS_EMULATOR_SOURCE` as a host-side fallback for Vega Virtual Device screenshots when the built-in macOS window capture fails or the host is not macOS. This requests a single PNG frame through OBS WebSocket and does not start recording. The source should be a reusable window/application capture input; the MCP attempts to point it at the active emulator window using the selected device serial and ADB details.

## Installing and uninstalling applications

`set_project_root` sets the user-confirmed repository root for the active MCP session. After it is set, `install_apk` only accepts APK paths contained inside that directory:

```json
{
  "project_path": "/absolute/path/to/MyAndroidTvApp"
}
```

Use this when the agent is working in a different app repository from the MCP server's configured default root.

`install_apk` installs an APK located inside the active session project root, or inside the configured `ADB_APK_ROOT` when no session project root is set. It supports replacing an existing application, installing test-only APKs, and granting runtime permissions:

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

The `device_serial` field is optional for install and uninstall operations. When omitted, the active device is used, or the only ready device is selected automatically.

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
- `VEGA_EXECUTABLE`: Vega CLI executable path used for Vega/Kepler backends (input, logs, app launch, and physical-device screenshots). Defaults to `vega` from `PATH`; set an absolute path such as `/Users/<you>/vega/bin/vega` when the launching app does not have the Vega SDK on its `PATH`.
- `ADB_PROJECT_ROOT`: project root used for default config and APK root. Defaults to the server working directory.
- `ADB_APK_ROOT`: directory from which APK installation is allowed. Defaults to `ADB_PROJECT_ROOT`.
- `ADB_BUILD_CONFIG`: path to build profile JSON. Defaults to `adb-mcp.config.json` in the server working directory when present.
- `ADB_TIMEOUT_MS`: default ADB command timeout. Defaults to `30000`.
- `ADB_MAX_OUTPUT_BYTES`: default ADB output limit. Defaults to `5242880`.
- `ADB_SCREENSHOT_MAX_BYTES`: maximum raw PNG size accepted from `adb screencap`, the Vega backend, or the VVD window capture. Defaults to `33554432`, allowing 4K captures to be processed before applying the smaller delivery limit.
- `ADB_SCREENSHOT_OUTPUT_MAX_BYTES`: maximum optimized PNG size. Defaults to `1048576`.
- `ADB_SCREENSHOT_MAX_WIDTH`: maximum delivered screenshot width. Defaults to `1280`.
- `ADB_SCREENSHOT_MAX_HEIGHT`: maximum delivered screenshot height. Defaults to `720`.
- `ADB_SCREENSHOT_SAVE_ROOT`: directory inside which `screenshot` may write files through `save_path`. Created at startup if missing. Defaults to `<system temp>/adb-mcp-screenshots`.
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
