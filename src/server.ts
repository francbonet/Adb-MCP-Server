import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AdbClient,
  AdbCommandError,
  AdbDevice,
  assertComponent,
  assertPackageName,
  assertSerial,
  encodeInputText,
  resolveApkPath,
} from "./adb.js";
import { BuildCommandError, BuildRunner } from "./build.js";
import { EmulatorManager } from "./emulator.js";
import { ObsController, ObsTarget } from "./obs.js";
import { optimizeScreenshot } from "./screenshot.js";

const DEVICE_CATALOG_URI = "adb://devices";
const KEY_EVENTS = {
  HOME: 3,
  BACK: 4,
  ENTER: 66,
  MENU: 82,
  SEARCH: 84,
  MEDIA_PLAY_PAUSE: 85,
  MEDIA_STOP: 86,
  MEDIA_NEXT: 87,
  MEDIA_PREVIOUS: 88,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CHANNEL_UP: 166,
  CHANNEL_DOWN: 167,
} as const;

type KeyEventName = keyof typeof KEY_EVENTS;

export interface SessionState {
  activeSerial?: string;
  projectRoot?: string;
}

export interface ServerDependencies {
  adb: AdbClient;
  apkRoot: string;
  screenshotMaxBytes: number;
  screenshotOutputMaxBytes: number;
  screenshotMaxWidth: number;
  screenshotMaxHeight: number;
  emulatorManager?: EmulatorManager;
  obsController?: ObsController;
  buildRunner?: BuildRunner;
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function formatDevice(device: AdbDevice): string {
  const detail = [device.model, device.product, device.device].filter(Boolean).join(" / ");
  return `- **${device.serial}** — ${device.state}, ${device.connectionType}${detail ? `, ${detail}` : ""}`;
}

function renderDeviceCatalog(devices: AdbDevice[], activeSerial?: string): string {
  const lines = ["# ADB devices", ""];
  if (devices.length === 0) {
    lines.push("No emulators or physical devices are visible to ADB.");
  } else {
    lines.push(...devices.map(formatDevice));
  }
  lines.push("", `Active device: ${activeSerial ?? "none"}`);
  return lines.join("\n");
}

function renderBuildProfiles(buildRunner?: BuildRunner): string {
  if (!buildRunner) {
    return "No build profiles are configured. Create adb-mcp.config.json or set ADB_BUILD_CONFIG.";
  }
  const profiles = buildRunner.listProfiles();
  if (profiles.length === 0) {
    return "No build profiles are configured.";
  }
  return [
    "# Build profiles",
    "",
    ...profiles.map((profile) => {
      const parts = [
        `- **${profile.name}**`,
        profile.description ? `: ${profile.description}` : "",
        `\n  Command: ${[profile.executable, ...profile.args].join(" ")}`,
        profile.cwd ? `\n  CWD: ${profile.cwd}` : "",
        profile.artifactPath ? `\n  Artifact: ${profile.artifactPath}` : "",
      ];
      return parts.join("");
    }),
  ].join("\n");
}

async function resolveDevice(
  adb: AdbClient,
  state: SessionState,
  requested?: string
): Promise<string> {
  const devices = await adb.listDevices();
  const serial = requested ? assertSerial(requested) : state.activeSerial;

  if (serial) {
    const device = devices.find((candidate) => candidate.serial === serial);
    if (!device) {
      throw new AdbCommandError(`Device ${serial} is not currently visible to ADB`);
    }
    if (device.state !== "device") {
      throw new AdbCommandError(`Device ${serial} is ${device.state}, not ready`);
    }
    state.activeSerial = serial;
    return serial;
  }

  const ready = devices.filter((device) => device.state === "device");
  if (ready.length === 1) {
    state.activeSerial = ready[0].serial;
    return ready[0].serial;
  }
  if (ready.length === 0) {
    throw new AdbCommandError(
      "No ready ADB devices found. Start an emulator, connect a USB device, or call connect_device for ADB over TCP."
    );
  }
  throw new AdbCommandError(
    `Multiple devices are ready (${ready.map((device) => device.serial).join(", ")}). Call select_device or pass device_serial.`
  );
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new AdbCommandError(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new AdbCommandError(`${key} must be a string`);
  return value;
}

async function resolveProjectRoot(projectPath: string): Promise<string> {
  const requested = projectPath.trim();
  if (!path.isAbsolute(requested)) {
    throw new AdbCommandError("project_path must be an absolute path on the MCP server machine");
  }
  let resolved: string;
  try {
    resolved = await realpath(requested);
  } catch {
    throw new AdbCommandError(`Project path does not exist: ${requested}`);
  }
  const projectStat = await stat(resolved);
  if (!projectStat.isDirectory()) {
    throw new AdbCommandError(`Project path must point to a directory: ${resolved}`);
  }
  return resolved;
}

function requiredEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[]
): T {
  const value = requiredString(args, key);
  if (!values.includes(value as T)) {
    throw new AdbCommandError(`${key} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function boundedInteger(
  args: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  fallback?: number
): number {
  const value = args[key] ?? fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new AdbCommandError(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function parseProperties(output: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^\[([^\]]+)\]: \[(.*)\]$/.exec(line.trim());
    if (match) properties[match[1]] = match[2];
  }
  return properties;
}

const deviceInputSchema = {
  type: "string",
  description:
    "ADB serial such as emulator-5554, a USB serial, or host:port. If omitted, the active device is used; a sole ready device is selected automatically.",
} as const;

export function createAdbMcpServer(
  dependencies: ServerDependencies,
  state: SessionState = {}
): Server {
  const {
    adb,
    apkRoot,
    screenshotMaxBytes,
    screenshotOutputMaxBytes,
    screenshotMaxWidth,
    screenshotMaxHeight,
    emulatorManager,
    obsController,
    buildRunner,
  } = dependencies;
  const server = new Server(
    { name: "adb-mcp-server", version: "0.1.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "Use set_project_root with the user-confirmed repository path before installing an APK from a project other than the configured default. Use list_devices before interacting when device context is unclear. Use list_avds and start_emulator when an Android Emulator must be started. Select the intended emulator or physical device explicitly when more than one is connected. Prefer screenshot and dump_ui to inspect state, then use concrete navigation tools. Never assume an install, uninstall, launch, tap, key press, or recording succeeded: inspect the resulting state afterwards. Use get_logcat around failures to provide diagnostic context.",
    }
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: DEVICE_CATALOG_URI,
        name: "ADB Device Catalog",
        description: "Live catalog of Android emulators and physical devices visible to ADB.",
        mimeType: "text/markdown",
      },
    ],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== DEVICE_CATALOG_URI) {
      throw new McpError(ErrorCode.InvalidParams, `Resource ${request.params.uri} not found`);
    }
    const devices = await adb.listDevices();
    return {
      contents: [
        {
          uri: DEVICE_CATALOG_URI,
          mimeType: "text/markdown",
          text: renderDeviceCatalog(devices, state.activeSerial),
        },
      ],
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_devices",
        description:
          "List Android emulators, USB devices, and network-connected devices visible to ADB, including authorization state.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "list_avds",
        description: "List configured Android Virtual Devices and report which ones are currently running.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "start_emulator",
        description:
          "Start an Android Virtual Device with quick or cold boot, wait for Android to finish booting, and select it as active.",
        inputSchema: {
          type: "object",
          properties: {
            avd_name: { type: "string", description: "AVD name returned by list_avds" },
            boot_mode: {
              type: "string",
              enum: ["quick", "cold"],
              default: "cold",
              description: "Use cold to skip loading snapshots; quick allows the emulator to restore one",
            },
            headless: {
              type: "boolean",
              default: false,
              description: "Start without a window. Keep false when OBS needs to capture the emulator window.",
            },
            timeout_ms: { type: "integer", minimum: 30_000, maximum: 600_000, default: 180_000 },
          },
          required: ["avd_name"],
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      {
        name: "connect_device",
        description:
          "Connect ADB to a physical device or emulator already listening on TCP using host:port.",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "Network target such as 192.168.1.50:5555 or android-lab.local:5555",
            },
          },
          required: ["target"],
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      {
        name: "disconnect_device",
        description: "Disconnect an ADB-over-TCP target. This does not affect USB devices.",
        inputSchema: {
          type: "object",
          properties: { target: { type: "string", description: "Connected host:port target" } },
          required: ["target"],
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      {
        name: "select_device",
        description: "Select an emulator or physical device as active for this MCP session.",
        inputSchema: {
          type: "object",
          properties: { device_serial: deviceInputSchema },
          required: ["device_serial"],
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "clear_active_device",
        description: "Clear the active device for this MCP session.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "set_project_root",
        description:
          "Set the user-confirmed repository root for this MCP session. install_apk will only accept APKs contained within this directory.",
        inputSchema: {
          type: "object",
          properties: {
            project_path: {
              type: "string",
              description: "Absolute path to an existing project directory on the MCP server machine",
            },
          },
          required: ["project_path"],
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "get_device_info",
        description:
          "Read model, manufacturer, Android version, SDK, screen size/density, and whether the target reports itself as an emulator.",
        inputSchema: { type: "object", properties: { device_serial: deviceInputSchema } },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "screenshot",
        description:
          "Capture the current screen, resize and compress it as an analysis-friendly PNG, and return it directly to the agent.",
        inputSchema: { type: "object", properties: { device_serial: deviceInputSchema } },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "get_current_activity",
        description: "Read the currently resumed Android activity/window for diagnosis and assertions.",
        inputSchema: { type: "object", properties: { device_serial: deviceInputSchema } },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "dump_ui",
        description: "Return the current Android UI Automator hierarchy as XML when supported by the device.",
        inputSchema: { type: "object", properties: { device_serial: deviceInputSchema } },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "press_key",
        description: "Send a safe, named Android key event, including D-pad and Fire TV remote navigation keys.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", enum: Object.keys(KEY_EVENTS), description: "Named remote/key event" },
            device_serial: deviceInputSchema,
          },
          required: ["key"],
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      {
        name: "tap",
        description: "Tap an absolute screen coordinate.",
        inputSchema: {
          type: "object",
          properties: {
            x: { type: "integer", minimum: 0, maximum: 10000 },
            y: { type: "integer", minimum: 0, maximum: 10000 },
            device_serial: deviceInputSchema,
          },
          required: ["x", "y"],
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      {
        name: "swipe",
        description: "Swipe between two absolute screen coordinates with a bounded duration.",
        inputSchema: {
          type: "object",
          properties: {
            x1: { type: "integer", minimum: 0, maximum: 10000 },
            y1: { type: "integer", minimum: 0, maximum: 10000 },
            x2: { type: "integer", minimum: 0, maximum: 10000 },
            y2: { type: "integer", minimum: 0, maximum: 10000 },
            duration_ms: { type: "integer", minimum: 50, maximum: 5000, default: 300 },
            device_serial: deviceInputSchema,
          },
          required: ["x1", "y1", "x2", "y2"],
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      {
        name: "type_text",
        description:
          "Type restricted plain text into the focused field. Shell metacharacters are rejected for safety.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", maxLength: 500 }, device_serial: deviceInputSchema },
          required: ["text"],
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      {
        name: "install_apk",
        description:
          "Install an APK contained within the active session project root, or the configured ADB_APK_ROOT when no session root is set.",
        inputSchema: {
          type: "object",
          properties: {
            apk_path: { type: "string", description: "Absolute path or path relative to the server process" },
            replace: { type: "boolean", default: true, description: "Replace an existing application" },
            allow_test: { type: "boolean", default: true, description: "Allow test-only APKs" },
            grant_permissions: { type: "boolean", default: false, description: "Grant runtime permissions" },
            device_serial: deviceInputSchema,
          },
          required: ["apk_path"],
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      {
        name: "uninstall_app",
        description: "Uninstall an Android application by package name.",
        inputSchema: {
          type: "object",
          properties: {
            package_name: {
              type: "string",
              description: "Android package to uninstall, for example com.example.tv",
            },
            keep_data: {
              type: "boolean",
              default: false,
              description: "Keep the application's data and cache directories after uninstalling",
            },
            device_serial: deviceInputSchema,
          },
          required: ["package_name"],
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      {
        name: "launch_app",
        description: "Launch an app by package name, optionally using a specific Android activity component.",
        inputSchema: {
          type: "object",
          properties: {
            package_name: { type: "string", description: "Android package, for example com.example.tv" },
            activity: {
              type: "string",
              description: "Optional full component, for example com.example.tv/.MainActivity",
            },
            device_serial: deviceInputSchema,
          },
          required: ["package_name"],
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      {
        name: "stop_app",
        description: "Force-stop an Android application by package name.",
        inputSchema: {
          type: "object",
          properties: {
            package_name: { type: "string" },
            device_serial: deviceInputSchema,
          },
          required: ["package_name"],
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      {
        name: "get_logcat",
        description:
          "Read recent logcat lines, optionally retaining only lines containing a case-insensitive text fragment.",
        inputSchema: {
          type: "object",
          properties: {
            lines: { type: "integer", minimum: 1, maximum: 5000, default: 500 },
            contains: { type: "string", maxLength: 200 },
            device_serial: deviceInputSchema,
          },
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "get_obs_status",
        description: "Report whether OBS WebSocket is reachable and whether OBS is currently recording.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "open_obs",
        description: "Open OBS if necessary and optionally select the configured emulator or physical-device scene.",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["emulator", "physical_device"] },
            timeout_ms: { type: "integer", minimum: 5_000, maximum: 120_000, default: 30_000 },
          },
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      {
        name: "start_obs_recording",
        description:
          "Select and verify the configured OBS source for an emulator or physical device, then start recording.",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["emulator", "physical_device"] },
            avd_name: {
              type: "string",
              description: "For emulator targets, match the OBS window/application property to this AVD when provided",
            },
            launch_if_needed: { type: "boolean", default: true },
            timeout_ms: { type: "integer", minimum: 5_000, maximum: 120_000, default: 30_000 },
          },
          required: ["target"],
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      {
        name: "stop_obs_recording",
        description: "Stop and finalize the current OBS recording, returning the saved video path.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      {
        name: "list_build_profiles",
        description:
          "List the server-side build profiles that this MCP instance is allowed to execute, such as debug or release.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "run_build",
        description:
          "Run a configured server-side build profile. Optionally install the resulting APK when the profile declares artifactPath.",
        inputSchema: {
          type: "object",
          properties: {
            profile: { type: "string", description: "Configured build profile name, for example debug or release" },
            install_after_build: {
              type: "boolean",
              default: false,
              description: "Install the built APK on the selected device after a successful build",
            },
            device_serial: deviceInputSchema,
          },
          required: ["profile"],
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case "list_devices": {
          const devices = await adb.listDevices();
          return textResult(renderDeviceCatalog(devices, state.activeSerial));
        }
        case "list_avds": {
          if (!emulatorManager) throw new AdbCommandError("Android Emulator support is not configured");
          const avds = await emulatorManager.listAvds();
          return textResult(
            avds.length
              ? JSON.stringify({ avds }, null, 2)
              : "No allowed Android Virtual Devices were reported by the emulator executable."
          );
        }
        case "start_emulator": {
          if (!emulatorManager) throw new AdbCommandError("Android Emulator support is not configured");
          const bootMode =
            args.boot_mode === undefined
              ? "cold"
              : requiredEnum(args, "boot_mode", ["quick", "cold"] as const);
          const timeout = boundedInteger(args, "timeout_ms", 30_000, 600_000, 180_000);
          const result = await emulatorManager.start({
            avdName: requiredString(args, "avd_name"),
            bootMode,
            headless: args.headless === true,
            timeoutMs: timeout,
          });
          state.activeSerial = result.serial;
          return textResult(
            [
              result.alreadyRunning
                ? `AVD ${result.avdName} was already running; no new ${bootMode} boot was performed.`
                : `AVD ${result.avdName} started successfully with ${bootMode} boot.`,
              `Active device: ${result.serial}`,
              result.pid ? `Emulator PID: ${result.pid}` : undefined,
              `Headless: ${result.headless}`,
            ]
              .filter(Boolean)
              .join("\n")
          );
        }
        case "connect_device": {
          const target = requiredString(args, "target");
          const result = await adb.connect(target);
          const devices = await adb.listDevices();
          const connected = devices.find((device) => device.serial === target.trim() && device.state === "device");
          if (connected) state.activeSerial = connected.serial;
          return textResult(`${result}\n${connected ? `Active device: ${connected.serial}` : "The target is not ready yet; call list_devices to inspect its state."}`);
        }
        case "disconnect_device": {
          const target = requiredString(args, "target");
          const result = await adb.disconnect(target);
          if (state.activeSerial === target.trim()) state.activeSerial = undefined;
          return textResult(result || `Disconnected ${target}`);
        }
        case "select_device": {
          const serial = await resolveDevice(adb, state, requiredString(args, "device_serial"));
          return textResult(`Active ADB device set to ${serial} for this MCP session.`);
        }
        case "clear_active_device": {
          const previous = state.activeSerial;
          state.activeSerial = undefined;
          return textResult(previous ? `Cleared active device ${previous}.` : "No active device was set.");
        }
        case "set_project_root": {
          const projectRoot = await resolveProjectRoot(requiredString(args, "project_path"));
          state.projectRoot = projectRoot;
          return textResult(
            `Active project root set to ${projectRoot}. install_apk is now restricted to APKs inside this directory for this MCP session.`
          );
        }
        case "get_device_info": {
          const serial = await resolveDevice(adb, state, optionalString(args, "device_serial"));
          const [propertyOutput, size, density] = await Promise.all([
            adb.text(["shell", "getprop"], { serial }),
            adb.text(["shell", "wm", "size"], { serial }),
            adb.text(["shell", "wm", "density"], { serial }),
          ]);
          const properties = parseProperties(propertyOutput);
          const isEmulator = properties["ro.kernel.qemu"] === "1" || serial.startsWith("emulator-");
          return textResult(
            [
              `# Device ${serial}`,
              `- Type: ${isEmulator ? "emulator" : "physical device"}`,
              `- Manufacturer: ${properties["ro.product.manufacturer"] || "unknown"}`,
              `- Model: ${properties["ro.product.model"] || "unknown"}`,
              `- Product: ${properties["ro.product.name"] || "unknown"}`,
              `- Android: ${properties["ro.build.version.release"] || "unknown"} (SDK ${properties["ro.build.version.sdk"] || "unknown"})`,
              `- Build: ${properties["ro.build.fingerprint"] || "unknown"}`,
              `- ${size || "Screen size unavailable"}`,
              `- ${density || "Screen density unavailable"}`,
            ].join("\n")
          );
        }
        case "screenshot": {
          const serial = await resolveDevice(adb, state, optionalString(args, "device_serial"));
          const result = await adb.run(["exec-out", "screencap", "-p"], {
            serial,
            maxOutputBytes: screenshotMaxBytes,
          });
          const optimized = await optimizeScreenshot(result.stdout, {
            maxBytes: screenshotOutputMaxBytes,
            maxWidth: screenshotMaxWidth,
            maxHeight: screenshotMaxHeight,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `Screenshot captured from ${serial}.`,
                  `Original: ${optimized.originalWidth}x${optimized.originalHeight}, ${optimized.originalBytes} bytes.`,
                  `Delivered: ${optimized.width}x${optimized.height}, ${optimized.data.length} bytes, PNG palette up to ${optimized.colours} colours.`,
                ].join("\n"),
              },
              { type: "image" as const, data: optimized.data.toString("base64"), mimeType: "image/png" },
            ],
          };
        }
        case "get_current_activity": {
          const serial = await resolveDevice(adb, state, optionalString(args, "device_serial"));
          const output = await adb.text(["shell", "dumpsys", "activity", "activities"], { serial });
          const lines = output
            .split(/\r?\n/)
            .filter((line) => /topResumedActivity|mResumedActivity|ResumedActivity/.test(line))
            .slice(0, 10);
          return textResult(lines.length ? lines.join("\n") : "No resumed activity was reported.");
        }
        case "dump_ui": {
          const serial = await resolveDevice(adb, state, optionalString(args, "device_serial"));
          const output = await adb.text(["exec-out", "uiautomator", "dump", "/dev/tty"], {
            serial,
            maxOutputBytes: 2 * 1024 * 1024,
          });
          const xmlStart = output.indexOf("<?xml");
          return textResult(xmlStart >= 0 ? output.slice(xmlStart) : output);
        }
        case "press_key": {
          const serial = await resolveDevice(adb, state, optionalString(args, "device_serial"));
          const key = requiredString(args, "key") as KeyEventName;
          if (!(key in KEY_EVENTS)) throw new AdbCommandError(`Unsupported key: ${key}`);
          await adb.text(["shell", "input", "keyevent", String(KEY_EVENTS[key])], { serial });
          return textResult(`Pressed ${key} on ${serial}.`);
        }
        case "tap": {
          const serial = await resolveDevice(adb, state, optionalString(args, "device_serial"));
          const x = boundedInteger(args, "x", 0, 10000);
          const y = boundedInteger(args, "y", 0, 10000);
          await adb.text(["shell", "input", "tap", String(x), String(y)], { serial });
          return textResult(`Tapped (${x}, ${y}) on ${serial}.`);
        }
        case "swipe": {
          const serial = await resolveDevice(adb, state, optionalString(args, "device_serial"));
          const x1 = boundedInteger(args, "x1", 0, 10000);
          const y1 = boundedInteger(args, "y1", 0, 10000);
          const x2 = boundedInteger(args, "x2", 0, 10000);
          const y2 = boundedInteger(args, "y2", 0, 10000);
          const duration = boundedInteger(args, "duration_ms", 50, 5000, 300);
          await adb.text(
            ["shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), String(duration)],
            { serial }
          );
          return textResult(`Swiped (${x1}, ${y1}) → (${x2}, ${y2}) in ${duration} ms on ${serial}.`);
        }
        case "type_text": {
          const serial = await resolveDevice(adb, state, optionalString(args, "device_serial"));
          const text = requiredString(args, "text");
          if (text.length > 500) throw new AdbCommandError("text must not exceed 500 characters");
          await adb.text(["shell", "input", "text", encodeInputText(text)], { serial });
          return textResult(`Typed ${text.length} characters on ${serial}.`);
        }
        case "install_apk": {
          const serial = await resolveDevice(adb, state, optionalString(args, "device_serial"));
          const activeApkRoot = state.projectRoot ?? apkRoot;
          const apkPath = await resolveApkPath(requiredString(args, "apk_path"), activeApkRoot);
          const installArgs = ["install"];
          if (args.replace !== false) installArgs.push("-r");
          if (args.allow_test !== false) installArgs.push("-t");
          if (args.grant_permissions === true) installArgs.push("-g");
          installArgs.push(apkPath);
          const output = await adb.text(installArgs, { serial, timeoutMs: 180_000 });
          return textResult(
            `${output || "APK installed successfully."}\nDevice: ${serial}\nProject root: ${activeApkRoot}\nAPK: ${apkPath}`
          );
        }
        case "uninstall_app": {
          const serial = await resolveDevice(adb, state, optionalString(args, "device_serial"));
          const packageName = assertPackageName(requiredString(args, "package_name"));
          const uninstallArgs = ["uninstall"];
          if (args.keep_data === true) uninstallArgs.push("-k");
          uninstallArgs.push(packageName);
          const output = await adb.text(uninstallArgs, { serial, timeoutMs: 180_000 });
          if (!/^Success$/m.test(output)) {
            throw new AdbCommandError(
              `ADB did not confirm that ${packageName} was uninstalled${output ? `: ${output}` : ""}`
            );
          }
          return textResult(
            `${packageName} uninstalled successfully from ${serial}.${args.keep_data === true ? " Application data was kept." : ""}`
          );
        }
        case "launch_app": {
          const serial = await resolveDevice(adb, state, optionalString(args, "device_serial"));
          const packageName = assertPackageName(requiredString(args, "package_name"));
          const activity = optionalString(args, "activity");
          const output = activity
            ? await adb.text(["shell", "am", "start", "-n", assertComponent(activity)], { serial })
            : await adb.text(
                ["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"],
                { serial }
              );
          return textResult(`${output}\nLaunch requested for ${packageName} on ${serial}.`);
        }
        case "stop_app": {
          const serial = await resolveDevice(adb, state, optionalString(args, "device_serial"));
          const packageName = assertPackageName(requiredString(args, "package_name"));
          await adb.text(["shell", "am", "force-stop", packageName], { serial });
          return textResult(`Force-stopped ${packageName} on ${serial}.`);
        }
        case "get_logcat": {
          const serial = await resolveDevice(adb, state, optionalString(args, "device_serial"));
          const lineCount = boundedInteger(args, "lines", 1, 5000, 500);
          const contains = optionalString(args, "contains")?.trim().toLowerCase();
          if (contains && contains.length > 200) {
            throw new AdbCommandError("contains must not exceed 200 characters");
          }
          const output = await adb.text(["logcat", "-d", "-v", "threadtime", "-t", String(lineCount)], {
            serial,
            maxOutputBytes: 10 * 1024 * 1024,
          });
          const filtered = contains
            ? output.split(/\r?\n/).filter((line) => line.toLowerCase().includes(contains)).join("\n")
            : output;
          return textResult(filtered || "No matching logcat lines found.");
        }
        case "get_obs_status": {
          if (!obsController) throw new AdbCommandError("OBS support is not configured");
          return textResult(JSON.stringify(await obsController.status(), null, 2));
        }
        case "open_obs": {
          if (!obsController) throw new AdbCommandError("OBS support is not configured");
          const requestedTarget = optionalString(args, "target");
          if (requestedTarget && !["emulator", "physical_device"].includes(requestedTarget)) {
            throw new AdbCommandError("target must be one of: emulator, physical_device");
          }
          const timeout = boundedInteger(args, "timeout_ms", 5_000, 120_000, 30_000);
          const status = await obsController.open(requestedTarget as ObsTarget | undefined, timeout);
          return textResult(`OBS is ready.\n${JSON.stringify(status, null, 2)}`);
        }
        case "start_obs_recording": {
          if (!obsController) throw new AdbCommandError("OBS support is not configured");
          const target = requiredEnum(args, "target", ["emulator", "physical_device"] as const);
          const avdName = optionalString(args, "avd_name");
          if (target === "physical_device" && avdName) {
            throw new AdbCommandError("avd_name can only be used when target is emulator");
          }
          const timeout = boundedInteger(args, "timeout_ms", 5_000, 120_000, 30_000);
          const result = await obsController.startRecording(target, {
            avdName,
            launchIfNeeded: args.launch_if_needed !== false,
            timeoutMs: timeout,
          });
          return textResult(
            `${result.alreadyRecording ? "OBS was already recording." : "OBS recording started."}\n${JSON.stringify(result, null, 2)}`
          );
        }
        case "stop_obs_recording": {
          if (!obsController) throw new AdbCommandError("OBS support is not configured");
          const result = await obsController.stopRecording();
          return textResult(
            `${result.stopped ? `OBS recording saved to ${result.outputPath}` : "OBS was not recording."}\n${JSON.stringify(result.status, null, 2)}`
          );
        }
        case "list_build_profiles": {
          return textResult(renderBuildProfiles(buildRunner));
        }
        case "run_build": {
          if (!buildRunner) {
            throw new BuildCommandError("No build profiles are configured. Create adb-mcp.config.json or set ADB_BUILD_CONFIG.");
          }
          const profileName = requiredString(args, "profile");
          const installAfterBuild = args.install_after_build === true;
          const serial = installAfterBuild
            ? await resolveDevice(adb, state, optionalString(args, "device_serial"))
            : undefined;

          const build = await buildRunner.run(profileName);
          const lines = [
            `Build profile ${build.profile.name} completed successfully.`,
            `CWD: ${build.cwd}`,
          ];
          if (build.stdout) lines.push("", "stdout:", build.stdout);
          if (build.stderr) lines.push("", "stderr:", build.stderr);
          if (build.artifactPath) lines.push("", `Artifact: ${build.artifactPath}`);

          if (installAfterBuild) {
            if (!build.artifactPath) {
              throw new BuildCommandError(
                `Build profile ${build.profile.name} does not declare artifactPath, so it cannot be installed automatically.`
              );
            }
            const apkPath = await resolveApkPath(build.artifactPath, apkRoot);
            const output = await adb.text(["install", "-r", "-t", apkPath], { serial, timeoutMs: 180_000 });
            lines.push("", `Installed on ${serial}.`, output || "ADB install completed successfully.");
          }

          return textResult(lines.join("\n"));
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof McpError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return textResult(message, true);
    }
  });

  return server;
}
