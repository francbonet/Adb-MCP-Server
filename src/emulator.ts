import { spawn } from "node:child_process";
import { AdbClient } from "./adb.js";

export type EmulatorBootMode = "quick" | "cold";

export interface AvdStatus {
  name: string;
  running: boolean;
  serial?: string;
  state?: string;
}

export interface StartEmulatorOptions {
  avdName: string;
  bootMode: EmulatorBootMode;
  headless: boolean;
  timeoutMs: number;
}

export interface StartEmulatorResult {
  avdName: string;
  serial: string;
  bootMode: EmulatorBootMode;
  headless: boolean;
  alreadyRunning: boolean;
  pid?: number;
}

export class EmulatorCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmulatorCommandError";
  }
}

export function parseAvdList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runCommand(executable: string, args: readonly string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const finishWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(error);
    };
    const timer = setTimeout(
      () => finishWithError(new EmulatorCommandError(`Emulator command timed out after ${timeoutMs} ms`)),
      timeoutMs
    );

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", finishWithError);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(
          new EmulatorCommandError(
            `Emulator command failed with exit code ${code ?? -1}${errorOutput ? `: ${errorOutput}` : ""}`
          )
        );
        return;
      }
      resolve(output);
    });
  });
}

export class EmulatorManager {
  private readonly allowedAvds?: ReadonlySet<string>;

  constructor(
    private readonly executable: string,
    private readonly adb: AdbClient,
    allowedAvds: readonly string[] = []
  ) {
    this.allowedAvds = allowedAvds.length ? new Set(allowedAvds) : undefined;
  }

  private async installedAvds(): Promise<string[]> {
    const avds = parseAvdList(await runCommand(this.executable, ["-list-avds"]));
    return this.allowedAvds ? avds.filter((name) => this.allowedAvds?.has(name)) : avds;
  }

  private async runningAvds(): Promise<Map<string, { serial: string; state: string }>> {
    const devices = (await this.adb.listDevices()).filter((device) => device.connectionType === "emulator");
    const entries = await Promise.all(
      devices.map(async (device) => {
        try {
          const output = await this.adb.text(["emu", "avd", "name"], {
            serial: device.serial,
            timeoutMs: 5_000,
          });
          const name = output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line && line !== "OK");
          return name ? ([name, { serial: device.serial, state: device.state }] as const) : undefined;
        } catch {
          return undefined;
        }
      })
    );
    return new Map(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined));
  }

  async listAvds(): Promise<AvdStatus[]> {
    const [installed, running] = await Promise.all([this.installedAvds(), this.runningAvds()]);
    return installed.map((name) => {
      const active = running.get(name);
      return {
        name,
        running: Boolean(active),
        ...(active ? { serial: active.serial, state: active.state } : {}),
      };
    });
  }

  async start(options: StartEmulatorOptions): Promise<StartEmulatorResult> {
    const avdName = options.avdName.trim();
    if (!avdName || avdName.length > 200) {
      throw new EmulatorCommandError("avd_name must be between 1 and 200 characters");
    }
    const installed = await this.installedAvds();
    if (!installed.includes(avdName)) {
      throw new EmulatorCommandError(`Unknown or disallowed AVD: ${avdName}`);
    }

    const running = await this.runningAvds();
    const existing = running.get(avdName);
    let pid: number | undefined;
    let processExitCode: number | null | undefined;

    if (!existing) {
      const emulatorArgs = ["-avd", avdName, "-no-boot-anim"];
      if (options.bootMode === "cold") emulatorArgs.push("-no-snapshot-load");
      if (options.headless) emulatorArgs.push("-no-window");

      const child = spawn(this.executable, emulatorArgs, {
        detached: true,
        shell: false,
        stdio: "ignore",
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      pid = child.pid;
      child.once("exit", (code) => {
        processExitCode = code;
      });
      child.unref();
    }

    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      const active = (await this.runningAvds()).get(avdName);
      if (active?.state === "device") {
        const bootCompleted = await this.adb
          .text(["shell", "getprop", "sys.boot_completed"], {
            serial: active.serial,
            timeoutMs: 5_000,
          })
          .catch(() => "");
        if (bootCompleted.trim() === "1") {
          return {
            avdName,
            serial: active.serial,
            bootMode: options.bootMode,
            headless: options.headless,
            alreadyRunning: Boolean(existing),
            ...(pid ? { pid } : {}),
          };
        }
      }
      if (processExitCode !== undefined && processExitCode !== null) {
        throw new EmulatorCommandError(
          `Emulator ${avdName} exited with code ${processExitCode} before completing boot`
        );
      }
      await delay(1_000);
    }

    throw new EmulatorCommandError(
      `Emulator ${avdName} did not complete boot within ${options.timeoutMs} ms`
    );
  }
}
