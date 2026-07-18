#!/usr/bin/env node

import path from "node:path";
import { realpath } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AdbClient } from "./adb.js";
import { BuildRunner, fileExists, loadBuildConfig } from "./build.js";
import { createAdbMcpServer } from "./server.js";

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
  const screenshotMaxBytes = Number.parseInt(process.env.ADB_SCREENSHOT_MAX_BYTES ?? "", 10) || 8 * 1024 * 1024;
  const timeoutMs = Number.parseInt(process.env.ADB_TIMEOUT_MS ?? "", 10) || 30_000;
  const maxOutputBytes = Number.parseInt(process.env.ADB_MAX_OUTPUT_BYTES ?? "", 10) || 5 * 1024 * 1024;
  const buildRunner = await maybeCreateBuildRunner(projectRoot);

  const server: Server = createAdbMcpServer({
    adb: new AdbClient({
      executable: process.env.ADB_EXECUTABLE || "adb",
      timeoutMs,
      maxOutputBytes,
    }),
    apkRoot,
    screenshotMaxBytes,
    buildRunner,
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
