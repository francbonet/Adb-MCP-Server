import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface CommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface RunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options: RunOptions
) => Promise<CommandResult>;

export class AdbCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number
  ) {
    super(message);
    this.name = "AdbCommandError";
  }
}

export const defaultCommandRunner: CommandRunner = (executable, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const finishWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(error);
    };

    const timer = setTimeout(() => {
      finishWithError(
        new AdbCommandError(`ADB command timed out after ${options.timeoutMs} ms`)
      );
    }, options.timeoutMs);

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        finishWithError(
          new AdbCommandError(
            `ADB command exceeded the ${options.maxOutputBytes} byte output limit`
          )
        );
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", finishWithError);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: code ?? -1,
      });
    });
  });

export type ConnectionType = "emulator" | "usb" | "network";

export interface AdbDevice {
  serial: string;
  state: string;
  connectionType: ConnectionType;
  product?: string;
  model?: string;
  device?: string;
  transportId?: string;
}

export interface AdbClientOptions {
  executable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  runner?: CommandRunner;
}

const SERIAL_PATTERN = /^[A-Za-z0-9._:-]+$/;
const NETWORK_TARGET_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\]):([1-9]\d{0,4})$/;
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const COMPONENT_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+\/(?:\.?[A-Za-z][A-Za-z0-9_.$]*|[A-Za-z][A-Za-z0-9_.$]*(?:\.[A-Za-z0-9_.$]+)*)$/;
const SAFE_TEXT_PATTERN = /^[A-Za-z0-9 _.,@:/+\-=]*$/;

export function assertSerial(serial: string): string {
  const value = serial.trim();
  if (!SERIAL_PATTERN.test(value)) {
    throw new AdbCommandError(`Invalid ADB device serial: ${serial}`);
  }
  return value;
}

export function assertNetworkTarget(target: string): string {
  const value = target.trim();
  const match = NETWORK_TARGET_PATTERN.exec(value);
  if (!match || Number(match[1]) > 65535) {
    throw new AdbCommandError(
      "Network target must be a hostname, IPv4 address, or bracketed IPv6 address followed by a valid port"
    );
  }
  return value;
}

export function assertPackageName(packageName: string): string {
  const value = packageName.trim();
  if (!PACKAGE_PATTERN.test(value)) {
    throw new AdbCommandError(`Invalid Android package name: ${packageName}`);
  }
  return value;
}

export function assertComponent(component: string): string {
  const value = component.trim();
  if (!COMPONENT_PATTERN.test(value)) {
    throw new AdbCommandError(
      "Activity must use Android component syntax, for example com.example.app/.MainActivity"
    );
  }
  return value;
}

export function encodeInputText(text: string): string {
  if (!SAFE_TEXT_PATTERN.test(text)) {
    throw new AdbCommandError(
      "Text contains unsupported characters. Allowed: letters, numbers, spaces, and _ . , @ : / + - ="
    );
  }
  return text.replace(/ /g, "%s");
}

export function parseDevices(output: string): AdbDevice[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices attached") && !line.startsWith("* daemon"))
    .map((line) => {
      const [serial, state = "unknown", ...detailTokens] = line.split(/\s+/);
      const details = Object.fromEntries(
        detailTokens
          .map((token) => token.split(/:(.*)/s))
          .filter((parts) => parts.length >= 2 && parts[0] && parts[1])
          .map(([key, value]) => [key, value])
      );
      const connectionType: ConnectionType = serial.startsWith("emulator-")
        ? "emulator"
        : serial.includes(":")
          ? "network"
          : "usb";

      return {
        serial,
        state,
        connectionType,
        product: details.product,
        model: details.model,
        device: details.device,
        transportId: details.transport_id,
      };
    });
}

export async function resolveApkPath(apkPath: string, allowedRoot: string): Promise<string> {
  const candidate = await realpath(path.resolve(apkPath));
  const root = await realpath(path.resolve(allowedRoot));
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AdbCommandError(`APK must be inside the allowed root: ${root}`);
  }
  if (path.extname(candidate).toLowerCase() !== ".apk") {
    throw new AdbCommandError("Install path must point to an .apk file");
  }
  const fileStat = await stat(candidate);
  if (!fileStat.isFile()) {
    throw new AdbCommandError("Install path must point to a regular file");
  }
  return candidate;
}

export class AdbClient {
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly runner: CommandRunner;

  constructor(options: AdbClientOptions = {}) {
    this.executable = options.executable ?? "adb";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 5 * 1024 * 1024;
    this.runner = options.runner ?? defaultCommandRunner;
  }

  async run(
    args: readonly string[],
    options: { serial?: string; timeoutMs?: number; maxOutputBytes?: number } = {}
  ): Promise<CommandResult> {
    const commandArgs = options.serial
      ? ["-s", assertSerial(options.serial), ...args]
      : [...args];
    const result = await this.runner(this.executable, commandArgs, {
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? this.maxOutputBytes,
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
      throw new AdbCommandError(
        `ADB command failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ""}`,
        result.exitCode
      );
    }
    return result;
  }

  async text(
    args: readonly string[],
    options: { serial?: string; timeoutMs?: number; maxOutputBytes?: number } = {}
  ): Promise<string> {
    const result = await this.run(args, options);
    return result.stdout.toString("utf8").trim();
  }

  async listDevices(): Promise<AdbDevice[]> {
    return parseDevices(await this.text(["devices", "-l"]));
  }

  async connect(target: string): Promise<string> {
    return this.text(["connect", assertNetworkTarget(target)]);
  }

  async disconnect(target: string): Promise<string> {
    return this.text(["disconnect", assertNetworkTarget(target)]);
  }
}
