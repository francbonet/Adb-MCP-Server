---
name: adb-mcp-server
description: Use when Codex needs to operate Android emulators, Fire TV, Android TV, APK installs, screenshots, UI dumps, logcat, OBS recording, or configured build profiles through the ADB MCP server.
---

# ADB MCP Server

Use the `adb` MCP server as the source of truth for Android device state and device-side actions. Prefer MCP tools over ad hoc shell commands when the server exposes the needed operation.

## Core Workflow

1. Call `list_devices` before device operations when device context is unclear.
2. If an emulator is needed, call `list_avds`, then `start_emulator`.
3. Select the intended device explicitly when more than one ready device is visible.
4. Before installing APKs from a non-default app repository, call `set_project_root` with the user-confirmed absolute repository path.
5. Prefer `run_build` with declared build profiles over arbitrary shell build commands.
6. After install, uninstall, launch, stop, tap, swipe, text input, or key press, verify the result with `screenshot`, `dump_ui`, or `get_current_activity`.
7. Use `get_logcat` around failures and return focused diagnostic context, not large raw logs.
8. Use OBS tools only when evidence recording is requested or useful for reproduction.

## Tool Routing

Use this section to choose the right tool group. Do not memorize or duplicate schemas here; MCP tool metadata provides exact arguments at call time.

- Discovery: use `list_devices` for ADB-visible targets, `list_avds` for configured emulators, and `get_device_info` for model, build, screen, density, and emulator/physical details.
- Device context: use `select_device` when the intended target is known, and `clear_active_device` when the session should stop reusing a previous target.
- Emulator startup: use `start_emulator` when an AVD must be running; use a non-headless emulator when OBS needs to capture the emulator window.
- Project scoping: use `set_project_root` before installing APKs from the active app repo; this restricts `install_apk` to files under that repo for the session.
- Screen inspection: use `screenshot` for visual state, `dump_ui` for UI hierarchy when available, and `get_current_activity` for the resumed Android activity.
- Remote input: use `press_key` for D-pad, media, back, home, and other key events; use `tap`, `swipe`, and `type_text` for bounded direct input when inspection supports it.
- APK lifecycle: use `install_apk`, `uninstall_app`, `launch_app`, and `stop_app` for app control, then verify the result with inspection tools.
- Diagnostics: use `get_logcat` with focused filters, recent line counts, or failure windows instead of returning broad logs.
- Evidence recording: use `get_obs_status`, `open_obs`, `start_obs_recording`, and `stop_obs_recording` only when recording is requested or useful to preserve reproduction evidence.
- Builds: use `list_build_profiles` to discover allowed builds and `run_build` to run configured profiles; use `install_after_build` only when the target device and install intent are clear.

## Safety Rules

- Do not guess package names, APK paths, device serials, project roots, OBS scenes, OBS sources, or AVD names.
- Treat `install_apk`, `uninstall_app`, `run_build` with `install_after_build`, and OBS recording as actions that need clear user intent.
- Do not assume command completion means success; inspect resulting screen, activity, device list, OBS status, or log output.
- Use `set_project_root` for the active app repo instead of broadening `ADB_APK_ROOT` when the agent is working outside the MCP server repository.
- Keep protected content constraints intact. Do not try to bypass DRM, HDCP, app protections, or platform security.

## Common Patterns

Install an APK from the current app repo:

1. Ask for or infer the app repo path only when it is already visible in the workspace context.
2. Call `set_project_root` with that absolute path.
3. Call `list_devices` and select the intended device if needed.
4. Call `install_apk` with a relative APK path under the project root.
5. Verify with `get_current_activity`, `screenshot`, or `dump_ui`.

Capture a useful failure report:

1. Reproduce the issue with concrete navigation tools.
2. Capture `screenshot` and `get_current_activity`.
3. Call `get_logcat` with a focused filter or recent line count.
4. Summarize observed state, expected state, and the most relevant log lines.

Record evidence with OBS:

1. Call `get_obs_status` before starting.
2. Call `open_obs` when OBS is not reachable and recording is needed.
3. Call `start_obs_recording` with `target` and `avd_name` when recording an emulator.
4. Reproduce the behavior.
5. Call `stop_obs_recording` and report the output path.
