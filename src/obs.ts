import { spawn } from "node:child_process";
import OBSWebSocket from "obs-websocket-js";

export type ObsTarget = "emulator" | "physical_device";

export interface ObsSourceMapping {
  sceneName: string;
  sourceName: string;
}

export interface ObsControllerOptions {
  websocketUrl: string;
  websocketPassword?: string;
  executable: string;
  emulator?: ObsSourceMapping;
  physicalDevice?: ObsSourceMapping;
}

export interface ObsStatus {
  connected: boolean;
  sceneName?: string;
  recording?: boolean;
  paused?: boolean;
  timecode?: string;
  durationMs?: number;
  outputBytes?: number;
  detail?: string;
}

export interface StartObsRecordingResult {
  target: ObsTarget;
  sceneName: string;
  sourceName: string;
  selectedWindow?: string;
  alreadyRecording: boolean;
  status: ObsStatus;
}

export interface ObsScreenshotResult {
  target: ObsTarget;
  sceneName: string;
  sourceName: string;
  selectedWindow?: string;
  data: Buffer;
}

export class ObsCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObsCommandError";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ObsController {
  constructor(private readonly options: ObsControllerOptions) {}

  /** Whether a scene/source mapping exists for the target, i.e. whether OBS capture can be attempted. */
  isConfigured(target: ObsTarget): boolean {
    return Boolean(target === "emulator" ? this.options.emulator : this.options.physicalDevice);
  }

  private mapping(target: ObsTarget): ObsSourceMapping {
    const mapping = target === "emulator" ? this.options.emulator : this.options.physicalDevice;
    if (!mapping) {
      const prefix = target === "emulator" ? "OBS_EMULATOR" : "OBS_PHYSICAL_DEVICE";
      throw new ObsCommandError(
        `OBS target ${target} is not configured. Set ${prefix}_SCENE and ${prefix}_SOURCE.`
      );
    }
    return mapping;
  }

  private async connectOnce(): Promise<OBSWebSocket> {
    const client = new OBSWebSocket();
    try {
      await client.connect(this.options.websocketUrl, this.options.websocketPassword);
      return client;
    } catch (error) {
      await client.disconnect().catch(() => undefined);
      throw error;
    }
  }

  private async connectWithRetry(timeoutMs: number): Promise<OBSWebSocket> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.connectOnce();
      } catch (error) {
        lastError = error;
        await delay(500);
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
    throw new ObsCommandError(
      `OBS WebSocket was not ready at ${this.options.websocketUrl} within ${timeoutMs} ms: ${detail}`
    );
  }

  private async launch(sceneName?: string): Promise<void> {
    const obsArgs = sceneName ? ["--scene", sceneName] : [];
    if (process.platform === "darwin" && !this.options.executable.includes("/")) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("/usr/bin/open", ["-a", this.options.executable, "--args", ...obsArgs], {
          shell: false,
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code === 0) resolve();
          else reject(new ObsCommandError(`Unable to open OBS; open exited with code ${code ?? -1}`));
        });
      });
      return;
    }

    if (process.platform === "darwin" && this.options.executable.endsWith(".app")) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("/usr/bin/open", [this.options.executable, "--args", ...obsArgs], {
          shell: false,
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code === 0) resolve();
          else reject(new ObsCommandError(`Unable to open OBS; open exited with code ${code ?? -1}`));
        });
      });
      return;
    }

    const child = spawn(this.options.executable, obsArgs, {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  }

  private async selectEmulatorWindow(
    client: OBSWebSocket,
    sourceName: string,
    avdName: string
  ): Promise<string> {
    return this.selectSourceWindow(client, sourceName, [avdName], `AVD ${avdName}`);
  }

  private async selectSourceWindow(
    client: OBSWebSocket,
    sourceName: string,
    matchTerms: readonly string[],
    description: string
  ): Promise<string> {
    await client.call("GetInputSettings", { inputName: sourceName });
    const normalizedTerms = matchTerms
      .map((term) => term.trim().toLowerCase())
      .filter((term) => term.length >= 3);
    if (normalizedTerms.length === 0) {
      throw new ObsCommandError("At least one OBS window match term must be provided");
    }

    for (const propertyName of ["window", "application"] as const) {
      try {
        const response = await client.call("GetInputPropertiesListPropertyItems", {
          inputName: sourceName,
          propertyName,
        });
        const items = response.propertyItems as Array<{
          itemName?: unknown;
          itemValue?: unknown;
          itemEnabled?: unknown;
        }>;
        const match = items.find((item) => {
          const itemName = typeof item.itemName === "string" ? item.itemName.toLowerCase() : "";
          return item.itemEnabled !== false && normalizedTerms.some((term) => itemName.includes(term));
        });
        if (!match || (typeof match.itemValue !== "string" && typeof match.itemValue !== "number")) {
          continue;
        }
        await client.call("SetInputSettings", {
          inputName: sourceName,
          inputSettings: { [propertyName]: match.itemValue },
          overlay: true,
        });
        return String(match.itemName);
      } catch {
        // Input kinds expose different properties across platforms; try the next supported property.
      }
    }

    throw new ObsCommandError(
      `OBS source ${sourceName} does not expose a window or application matching ${description}`
    );
  }

  private async verifySource(client: OBSWebSocket, sourceName: string): Promise<void> {
    const active = await client.call("GetSourceActive", { sourceName });
    if (!active.videoActive) {
      throw new ObsCommandError(`OBS source ${sourceName} is not active in the selected program scene`);
    }
    const preview = await client.call("GetSourceScreenshot", {
      sourceName,
      imageFormat: "png",
      imageWidth: 320,
      imageHeight: 180,
      imageCompressionQuality: 80,
    });
    const encoded = preview.imageData.includes(",")
      ? preview.imageData.slice(preview.imageData.indexOf(",") + 1)
      : preview.imageData;
    if (Buffer.from(encoded, "base64").length < 100) {
      throw new ObsCommandError(`OBS source ${sourceName} did not produce a valid preview image`);
    }
  }

  private async sourceScreenshot(
    client: OBSWebSocket,
    sourceName: string,
    width: number,
    height: number
  ): Promise<Buffer> {
    const screenshot = await client.call("GetSourceScreenshot", {
      sourceName,
      imageFormat: "png",
      imageWidth: width,
      imageHeight: height,
      imageCompressionQuality: 100,
    });
    const encoded = screenshot.imageData.includes(",")
      ? screenshot.imageData.slice(screenshot.imageData.indexOf(",") + 1)
      : screenshot.imageData;
    const data = Buffer.from(encoded, "base64");
    if (data.length < 100) {
      throw new ObsCommandError(`OBS source ${sourceName} did not produce a valid screenshot`);
    }
    return data;
  }

  private async readStatus(client: OBSWebSocket): Promise<ObsStatus> {
    const [scene, record] = await Promise.all([
      client.call("GetCurrentProgramScene"),
      client.call("GetRecordStatus"),
    ]);
    return {
      connected: true,
      sceneName: scene.sceneName,
      recording: record.outputActive,
      paused: record.outputPaused,
      timecode: record.outputTimecode,
      durationMs: record.outputDuration,
      outputBytes: record.outputBytes,
    };
  }

  async status(): Promise<ObsStatus> {
    let client: OBSWebSocket | undefined;
    try {
      client = await this.connectOnce();
      return await this.readStatus(client);
    } catch (error) {
      return {
        connected: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await client?.disconnect().catch(() => undefined);
    }
  }

  async open(target?: ObsTarget, timeoutMs = 30_000): Promise<ObsStatus> {
    const mapping = target ? this.mapping(target) : undefined;
    let client: OBSWebSocket | undefined;
    try {
      client = await this.connectOnce().catch(() => undefined);
      if (!client) {
        await this.launch(mapping?.sceneName);
        client = await this.connectWithRetry(timeoutMs);
      }
      if (mapping) {
        const current = await this.readStatus(client);
        if (current.recording && current.sceneName !== mapping.sceneName) {
          throw new ObsCommandError(
            `OBS is already recording scene ${current.sceneName}; refusing to switch to ${mapping.sceneName}`
          );
        }
        await client.call("SetCurrentProgramScene", { sceneName: mapping.sceneName });
      }
      return await this.readStatus(client);
    } finally {
      await client?.disconnect().catch(() => undefined);
    }
  }

  async startRecording(
    target: ObsTarget,
    options: { avdName?: string; launchIfNeeded: boolean; timeoutMs: number }
  ): Promise<StartObsRecordingResult> {
    const mapping = this.mapping(target);
    let client: OBSWebSocket | undefined;
    try {
      client = await this.connectOnce().catch(() => undefined);
      if (!client) {
        if (!options.launchIfNeeded) {
          throw new ObsCommandError("OBS is not reachable through WebSocket and launch_if_needed is false");
        }
        await this.launch(mapping.sceneName);
        client = await this.connectWithRetry(options.timeoutMs);
      }

      const before = await client.call("GetRecordStatus");
      if (before.outputActive) {
        const currentScene = await client.call("GetCurrentProgramScene");
        if (currentScene.sceneName !== mapping.sceneName) {
          throw new ObsCommandError(
            `OBS is already recording scene ${currentScene.sceneName}; refusing to switch to ${mapping.sceneName}`
          );
        }
        await this.verifySource(client, mapping.sourceName);
        return {
          target,
          sceneName: mapping.sceneName,
          sourceName: mapping.sourceName,
          alreadyRecording: true,
          status: await this.readStatus(client),
        };
      }

      await client.call("SetCurrentProgramScene", { sceneName: mapping.sceneName });
      const selectedWindow =
        target === "emulator" && options.avdName
          ? await this.selectEmulatorWindow(client, mapping.sourceName, options.avdName)
          : undefined;
      await this.verifySource(client, mapping.sourceName);

      await client.call("StartRecord");
      const status = await this.readStatus(client);
      if (!status.recording) throw new ObsCommandError("OBS did not confirm that recording started");

      return {
        target,
        sceneName: mapping.sceneName,
        sourceName: mapping.sourceName,
        ...(selectedWindow ? { selectedWindow } : {}),
        alreadyRecording: false,
        status,
      };
    } finally {
      await client?.disconnect().catch(() => undefined);
    }
  }

  async captureScreenshot(
    target: ObsTarget,
    options: {
      avdName?: string;
      windowMatchTerms?: string[];
      launchIfNeeded: boolean;
      timeoutMs: number;
      width: number;
      height: number;
    }
  ): Promise<ObsScreenshotResult> {
    const mapping = this.mapping(target);
    let client: OBSWebSocket | undefined;
    try {
      client = await this.connectOnce().catch(() => undefined);
      if (!client) {
        if (!options.launchIfNeeded) {
          throw new ObsCommandError("OBS is not reachable through WebSocket and launch_if_needed is false");
        }
        await this.launch(mapping.sceneName);
        client = await this.connectWithRetry(options.timeoutMs);
      }

      await client.call("SetCurrentProgramScene", { sceneName: mapping.sceneName });
      const selectedWindow =
        target === "emulator" && options.avdName
          ? await this.selectEmulatorWindow(client, mapping.sourceName, options.avdName)
          : target === "emulator" && options.windowMatchTerms?.length
            ? await this.selectSourceWindow(
                client,
                mapping.sourceName,
                options.windowMatchTerms,
                options.windowMatchTerms.join(", ")
              )
          : undefined;
      await this.verifySource(client, mapping.sourceName);
      const data = await this.sourceScreenshot(client, mapping.sourceName, options.width, options.height);
      return {
        target,
        sceneName: mapping.sceneName,
        sourceName: mapping.sourceName,
        ...(selectedWindow ? { selectedWindow } : {}),
        data,
      };
    } finally {
      await client?.disconnect().catch(() => undefined);
    }
  }

  async stopRecording(): Promise<{ stopped: boolean; outputPath?: string; status: ObsStatus }> {
    let client: OBSWebSocket | undefined;
    try {
      client = await this.connectOnce().catch(() => undefined);
      if (!client) throw new ObsCommandError("OBS is not reachable through WebSocket");
      const before = await client.call("GetRecordStatus");
      if (!before.outputActive) {
        return { stopped: false, status: await this.readStatus(client) };
      }
      const result = await client.call("StopRecord");
      return {
        stopped: true,
        outputPath: result.outputPath,
        status: await this.readStatus(client),
      };
    } finally {
      await client?.disconnect().catch(() => undefined);
    }
  }
}
