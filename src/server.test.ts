import assert from "node:assert/strict";
import test from "node:test";
import { AdbClient, CommandRunner } from "./adb.js";
import { createAdbMcpServer } from "./server.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ok = (stdout = "") => ({
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
  exitCode: 0,
});

const missing = () => ({
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  exitCode: 1,
});

function vegaRunner(): CommandRunner {
  return async (_executable, args) => {
    if (args.join(" ") === "devices -l") {
      return ok("List of devices attached\nemulator-5554 device model:VirtualDevice:\n");
    }
    if (args[0] === "-s" && args[2] === "shell" && args[3] === "command" && args[4] === "-v") {
      return missing();
    }
    return ok("");
  };
}

async function callTool(server: unknown, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const handlers = (server as { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<ToolResult>> })
    ._requestHandlers;
  const handler = handlers.get("tools/call");
  assert.ok(handler, "tools/call handler should exist");
  return handler({ method: "tools/call", params: { name, arguments: args } }, {});
}

test("dump_ui returns structured unsupported response when uiautomator is unavailable", async () => {
  const server = createAdbMcpServer({
    adb: new AdbClient({ runner: vegaRunner() }),
    apkRoot: process.cwd(),
    screenshotMaxBytes: 1024 * 1024,
    screenshotOutputMaxBytes: 1024 * 1024,
    screenshotMaxWidth: 1280,
    screenshotMaxHeight: 720,
  });

  const result = await callTool(server, "dump_ui", { device_serial: "emulator-5554" });
  const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;

  assert.equal(result.isError, true);
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, "unsupported");
  assert.equal(payload.device_serial, "emulator-5554");
  assert.equal(payload.platform, "vega");
  assert.equal(payload.missing_capability, "uiautomator");
  assert.match(String(payload.message), /dump_ui requires uiautomator/);
});

test("list_devices includes platform and Android utility capabilities", async () => {
  const server = createAdbMcpServer({
    adb: new AdbClient({ runner: vegaRunner() }),
    apkRoot: process.cwd(),
    screenshotMaxBytes: 1024 * 1024,
    screenshotOutputMaxBytes: 1024 * 1024,
    screenshotMaxWidth: 1280,
    screenshotMaxHeight: 720,
  });

  const result = await callTool(server, "list_devices");
  const text = result.content[0].text;

  assert.match(text, /Platform: vega/);
  assert.match(text, /dumpsys: no/);
  assert.match(text, /uiautomator: no/);
  assert.match(text, /screencap: no/);
});
