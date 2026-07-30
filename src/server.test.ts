import assert from "node:assert/strict";
import test from "node:test";
import { AdbClient, CommandRunner } from "./adb.js";
import { createAdbMcpServer } from "./server.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type ToolListResult = {
  tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
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

function androidInputRunner(calls: string[][]): CommandRunner {
  return async (_executable, args) => {
    calls.push([...args]);
    if (args.join(" ") === "devices -l") {
      return ok("List of devices attached\nemulator-5554 device model:Pixel_8:\n");
    }
    if (args[0] === "-s" && args[2] === "shell" && args[3] === "command" && args[4] === "-v") {
      return args[5] === "input" ? ok("/system/bin/input\n") : missing();
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

async function listTools(server: unknown): Promise<ToolListResult> {
  const handlers = (server as { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<ToolListResult>> })
    ._requestHandlers;
  const handler = handlers.get("tools/list");
  assert.ok(handler, "tools/list handler should exist");
  return handler({ method: "tools/list", params: {} }, {});
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

test("press_key_sequence is listed with bounded sequence schema", async () => {
  const server = createAdbMcpServer({
    adb: new AdbClient({ runner: vegaRunner() }),
    apkRoot: process.cwd(),
    screenshotMaxBytes: 1024 * 1024,
    screenshotOutputMaxBytes: 1024 * 1024,
    screenshotMaxWidth: 1280,
    screenshotMaxHeight: 720,
  });

  const result = await listTools(server);
  const tool = result.tools.find((candidate) => candidate.name === "press_key_sequence");

  assert.ok(tool, "press_key_sequence should be listed");
  const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.sequence.minItems, 1);
  assert.equal(properties.sequence.maxItems, 20);
});

test("press_key_sequence sends Android events through one shell command", async () => {
  const calls: string[][] = [];
  const server = createAdbMcpServer({
    adb: new AdbClient({ runner: androidInputRunner(calls) }),
    apkRoot: process.cwd(),
    screenshotMaxBytes: 1024 * 1024,
    screenshotOutputMaxBytes: 1024 * 1024,
    screenshotMaxWidth: 1280,
    screenshotMaxHeight: 720,
  });

  const result = await callTool(server, "press_key_sequence", {
    device_serial: "emulator-5554",
    sequence: [
      { key: "BACK", delay_ms_after: 1000 },
      { key: "BACK" },
    ],
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, "Pressed sequence on emulator-5554: BACK -> BACK.");
  assert.deepEqual(calls.at(-1), [
    "-s",
    "emulator-5554",
    "shell",
    "input keyevent 4; sleep 1.000; input keyevent 4",
  ]);
});

test("press_key_sequence rejects excessive total delay", async () => {
  const calls: string[][] = [];
  const server = createAdbMcpServer({
    adb: new AdbClient({ runner: androidInputRunner(calls) }),
    apkRoot: process.cwd(),
    screenshotMaxBytes: 1024 * 1024,
    screenshotOutputMaxBytes: 1024 * 1024,
    screenshotMaxWidth: 1280,
    screenshotMaxHeight: 720,
  });

  const result = await callTool(server, "press_key_sequence", {
    device_serial: "emulator-5554",
    sequence: [
      { key: "BACK", delay_ms_after: 5000 },
      { key: "BACK", delay_ms_after: 5000 },
      { key: "BACK", delay_ms_after: 5000 },
      { key: "BACK", delay_ms_after: 1 },
    ],
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Total sequence delay must not exceed 15000 ms/);
  assert.deepEqual(calls, [["devices", "-l"]]);
});
