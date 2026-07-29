import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AdbCommandError, assertSerial, CommandResult, CommandRunner, defaultCommandRunner } from "./adb.js";

export class VegaCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number
  ) {
    super(message);
    this.name = "VegaCommandError";
  }
}

export interface VegaClientOptions {
  executable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  runner?: CommandRunner;
}

const VEGA_KEY_EVENTS = {
  HOME: "KEY_HOME",
  BACK: "KEY_BACK",
  ENTER: "KEY_ENTER",
  MENU: "KEY_MENU",
  SEARCH: "KEY_SEARCH",
  MEDIA_PLAY_PAUSE: "KEY_PLAYPAUSE",
  MEDIA_STOP: "KEY_STOP",
  MEDIA_NEXT: "KEY_NEXTSONG",
  MEDIA_PREVIOUS: "KEY_PREVIOUSSONG",
  DPAD_UP: "KEY_UP",
  DPAD_DOWN: "KEY_DOWN",
  DPAD_LEFT: "KEY_LEFT",
  DPAD_RIGHT: "KEY_RIGHT",
  DPAD_CENTER: "KEY_ENTER",
  VOLUME_UP: "KEY_VOLUMEUP",
  VOLUME_DOWN: "KEY_VOLUMEDOWN",
  POWER: "KEY_POWER",
  CHANNEL_UP: "KEY_CHANNELUP",
  CHANNEL_DOWN: "KEY_CHANNELDOWN",
} as const;

export type VegaKeyEventName = keyof typeof VEGA_KEY_EVENTS;

export class VegaClient {
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly runner: CommandRunner;

  constructor(options: VegaClientOptions = {}) {
    this.executable = options.executable ?? "vega";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 5 * 1024 * 1024;
    this.runner = options.runner ?? defaultCommandRunner;
  }

  async run(
    args: readonly string[],
    options: { timeoutMs?: number; maxOutputBytes?: number } = {}
  ): Promise<CommandResult> {
    const result = await this.runner(this.executable, [...args], {
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? this.maxOutputBytes,
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
      throw new VegaCommandError(
        `Vega command failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ""}`,
        result.exitCode
      );
    }
    return result;
  }

  async text(
    args: readonly string[],
    options: { timeoutMs?: number; maxOutputBytes?: number } = {}
  ): Promise<string> {
    const result = await this.run(args, options);
    return result.stdout.toString("utf8").trim();
  }

  async launchApp(serial: string, packageName: string): Promise<string> {
    return this.text(["device", "launch-app", "--device", assertSerial(serial), "--appName", `${packageName}.main`], {
      timeoutMs: 60_000,
    });
  }

  async pressKey(serial: string, key: VegaKeyEventName): Promise<string> {
    return this.inputd(serial, ["button_press", VEGA_KEY_EVENTS[key]]);
  }

  async tap(serial: string, x: number, y: number): Promise<string> {
    return this.inputd(serial, ["touch", String(x), String(y)]);
  }

  async swipe(
    serial: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number
  ): Promise<string> {
    return this.inputd(serial, [
      "swipe",
      String(x1),
      String(y1),
      String(x2),
      String(y2),
      "--interval",
      String(durationMs * 1000),
    ]);
  }

  async typeText(serial: string, text: string): Promise<string> {
    return this.inputd(serial, ["send_text", text]);
  }

  async logs(serial: string, maxOutputBytes: number): Promise<string> {
    return this.vdaShellText(serial, ["loggingctl", "log", "-o", "short_precise"], {
      timeoutMs: 15_000,
      maxOutputBytes,
    });
  }

  async screenshot(serial: string, maxOutputBytes: number): Promise<Buffer> {
    const remotePath = `/tmp/adb-mcp-screenshot-${process.pid}-${Date.now()}.png`;
    const localDir = await mkdtemp(path.join(os.tmpdir(), "adb-mcp-vega-"));
    const localPath = path.join(localDir, "screenshot.png");
    try {
      try {
        await this.vdaShellText(serial, ["gwsi-tool-screenshooter", remotePath], {
          timeoutMs: 15_000,
          maxOutputBytes: 256 * 1024,
        });
      } catch (error) {
        if (!(error instanceof AdbCommandError) && !(error instanceof VegaCommandError)) throw error;
      }
      await this.text(["exec", "vda", "-s", assertSerial(serial), "pull", remotePath, localPath], {
        timeoutMs: 30_000,
        maxOutputBytes,
      });
      return await readFile(localPath);
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      throw new VegaCommandError(
        `Vega screenshot requires gwsi-tool-screenshooter on a physical Vega/Kepler device; Amazon documentation states this tool is not supported on Vega Virtual Device.${detail}`
      );
    } finally {
      await rm(localDir, { recursive: true, force: true });
    }
  }

  private async inputd(serial: string, args: readonly string[]): Promise<string> {
    return this.vdaShellText(serial, ["inputd-cli", ...args], { timeoutMs: 15_000 });
  }

  private async vdaShellText(
    serial: string,
    command: readonly string[],
    options: { timeoutMs?: number; maxOutputBytes?: number } = {}
  ): Promise<string> {
    return this.text(["exec", "vda", "-s", assertSerial(serial), "shell", ...command], options);
  }
}
