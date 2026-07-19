#!/usr/bin/env node

import path from "node:path";
import { realpath } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AdbClient } from "./adb.js";
import { BuildRunner, fileExists, loadBuildConfig } from "./build.js";
import { EmulatorManager } from "./emulator.js";
import { ObsController, ObsSourceMapping } from "./obs.js";
import { createAdbMcpServer } from "./server.js";

function environmentInteger(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function obsMapping(prefix: "OBS_EMULATOR" | "OBS_PHYSICAL_DEVICE"): ObsSourceMapping | undefined {
  const sceneName = process.env[`${prefix}_SCENE`]?.trim();
  const sourceName = process.env[`${prefix}_SOURCE`]?.trim();
  if (Boolean(sceneName) !== Boolean(sourceName)) {
    throw new Error(`${prefix}_SCENE and ${prefix}_SOURCE must be configured together`);
  }
  return sceneName && sourceName ? { sceneName, sourceName } : undefined;
}

async function maybeCreateBuildRunner(projectRoot: string): Promise<BuildRunner | undefined> {
  const configuredPath = process.env.ADB_BUILD_CONFIG;
  const configPath = configuredPath
    ? path.resolve(configuredPath)
    : path.resolve(process.cwd(), "adb-mcp.config.json");

  if (!configuredPath && !(await fileExists(configPath))) {
    return undefined;
  }

  const config = await loadBuildConfig(configPath, projectRoot);
  return new BuildRunner(config.projectRoot, config.profiles);
}

async function main(): Promise<void> {
  const projectRoot = await realpath(path.resolve(process.env.ADB_PROJECT_ROOT ?? process.cwd()));
  const apkRoot = await realpath(path.resolve(process.env.ADB_APK_ROOT ?? projectRoot));
  const screenshotMaxBytes = environmentInteger("ADB_SCREENSHOT_MAX_BYTES", 32 * 1024 * 1024, 1024 * 1024);
  const screenshotOutputMaxBytes = environmentInteger(
    "ADB_SCREENSHOT_OUTPUT_MAX_BYTES",
    1024 * 1024,
    64 * 1024
  );
  const screenshotMaxWidth = environmentInteger("ADB_SCREENSHOT_MAX_WIDTH", 1280, 320);
  const screenshotMaxHeight = environmentInteger("ADB_SCREENSHOT_MAX_HEIGHT", 720, 180);
  const timeoutMs = environmentInteger("ADB_TIMEOUT_MS", 30_000, 1_000);
  const maxOutputBytes = environmentInteger("ADB_MAX_OUTPUT_BYTES", 5 * 1024 * 1024, 1024);
  const buildRunner = await maybeCreateBuildRunner(projectRoot);
  const adb = new AdbClient({
    executable: process.env.ADB_EXECUTABLE || "adb",
    timeoutMs,
    maxOutputBytes,
  });
  const sdkRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  const emulatorExecutable =
    process.env.ANDROID_EMULATOR_EXECUTABLE ||
    (sdkRoot ? path.join(sdkRoot, "emulator", "emulator") : "emulator");
  const allowedAvds = (process.env.ADB_ALLOWED_AVDS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  const server: Server = createAdbMcpServer({
    adb,
    apkRoot,
    screenshotMaxBytes,
    screenshotOutputMaxBytes,
    screenshotMaxWidth,
    screenshotMaxHeight,
    emulatorManager: new EmulatorManager(emulatorExecutable, adb, allowedAvds),
    obsController: new ObsController({
      websocketUrl: process.env.OBS_WEBSOCKET_URL || "ws://127.0.0.1:4455",
      websocketPassword: process.env.OBS_WEBSOCKET_PASSWORD,
      executable: process.env.OBS_EXECUTABLE || (process.platform === "darwin" ? "OBS" : "obs"),
      emulator: obsMapping("OBS_EMULATOR"),
      physicalDevice: obsMapping("OBS_PHYSICAL_DEVICE"),
    }),
    buildRunner,
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
