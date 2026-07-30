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

const uiXml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <node text="All The Channels" resource-id="rail-title" content-desc="" class="android.widget.TextView" focused="false" bounds="[100,210][1920,250]" />
  <node text="" resource-id="rail-tile-BBC1HD" content-desc="LIVE, BBC One HD" class="android.view.View" focused="true" bounds="[100,260][420,520]" />
</hierarchy>`;

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

function uiAutomatorRunner(calls: string[][], xml = uiXml): CommandRunner {
  return async (_executable, args) => {
    calls.push([...args]);
    if (args.join(" ") === "devices -l") {
      return ok("List of devices attached\nemulator-5554 device model:Pixel_8:\n");
    }
    if (args[0] === "-s" && args[2] === "shell" && args[3] === "command" && args[4] === "-v") {
      return args[5] === "uiautomator" ? ok("/system/bin/uiautomator\n") : missing();
    }
    if (args[0] === "-s" && args[2] === "exec-out" && args[3] === "uiautomator") {
      return ok(`UI hierchary dumped to: /dev/tty\n${xml}`);
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

function testServer(runner: CommandRunner) {
  return createAdbMcpServer({
    adb: new AdbClient({ runner }),
    apkRoot: process.cwd(),
    screenshotMaxBytes: 1024 * 1024,
    screenshotOutputMaxBytes: 1024 * 1024,
    screenshotMaxWidth: 1280,
    screenshotMaxHeight: 720,
  });
}

test("dump_ui returns structured unsupported response when uiautomator is unavailable", async () => {
  const result = await callTool(testServer(vegaRunner()), "dump_ui", { device_serial: "emulator-5554" });
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
  const result = await callTool(testServer(vegaRunner()), "list_devices");
  const text = result.content[0].text;

  assert.match(text, /Platform: vega/);
  assert.match(text, /dumpsys: no/);
  assert.match(text, /uiautomator: no/);
  assert.match(text, /screencap: no/);
});

test("UI node tools are listed", async () => {
  const result = await listTools(testServer(vegaRunner()));
  const toolNames = result.tools.map((tool) => tool.name);

  assert.ok(toolNames.includes("wait_for_ui_node"));
  assert.ok(toolNames.includes("assert_ui_node"));
});

test("wait_for_ui_node finds a node by exact text", async () => {
  const calls: string[][] = [];
  const result = await callTool(testServer(uiAutomatorRunner(calls)), "wait_for_ui_node", {
    device_serial: "emulator-5554",
    text: "All The Channels",
    timeout_ms: 0,
  });
  const payload = JSON.parse(result.content[0].text) as { found: boolean; node: Record<string, unknown> };

  assert.equal(result.isError, undefined);
  assert.equal(payload.found, true);
  assert.equal(payload.node.text, "All The Channels");
  assert.equal(payload.node.resource_id, "rail-title");
});

test("assert_ui_node finds a node by exact resource_id", async () => {
  const calls: string[][] = [];
  const result = await callTool(testServer(uiAutomatorRunner(calls)), "assert_ui_node", {
    device_serial: "emulator-5554",
    resource_id: "rail-tile-BBC1HD",
  });
  const payload = JSON.parse(result.content[0].text) as { ok: boolean; node: Record<string, unknown> };

  assert.equal(result.isError, undefined);
  assert.equal(payload.ok, true);
  assert.equal(payload.node.resource_id, "rail-tile-BBC1HD");
});

test("wait_for_ui_node finds a focused node", async () => {
  const calls: string[][] = [];
  const result = await callTool(testServer(uiAutomatorRunner(calls)), "wait_for_ui_node", {
    device_serial: "emulator-5554",
    focused: true,
    timeout_ms: 0,
  });
  const payload = JSON.parse(result.content[0].text) as { found: boolean; node: Record<string, unknown> };

  assert.equal(result.isError, undefined);
  assert.equal(payload.found, true);
  assert.equal(payload.node.focused, true);
  assert.equal(payload.node.content_desc, "LIVE, BBC One HD");
});

test("wait_for_ui_node returns found false when no node matches before timeout", async () => {
  const calls: string[][] = [];
  const result = await callTool(testServer(uiAutomatorRunner(calls)), "wait_for_ui_node", {
    device_serial: "emulator-5554",
    text: "Missing",
    timeout_ms: 0,
  });
  const payload = JSON.parse(result.content[0].text) as { found: boolean; message: string };

  assert.equal(result.isError, undefined);
  assert.equal(payload.found, false);
  assert.equal(payload.message, "No UI node matched before timeout");
});

test("assert_ui_node supports should_exist false", async () => {
  const calls: string[][] = [];
  const result = await callTool(testServer(uiAutomatorRunner(calls)), "assert_ui_node", {
    device_serial: "emulator-5554",
    text: "Search page",
    should_exist: false,
  });
  const payload = JSON.parse(result.content[0].text) as { ok: boolean; found: boolean; should_exist: boolean };

  assert.equal(result.isError, undefined);
  assert.equal(payload.ok, true);
  assert.equal(payload.found, false);
  assert.equal(payload.should_exist, false);
});

test("assert_ui_node fails when the assertion does not match the current UI", async () => {
  const calls: string[][] = [];
  const result = await callTool(testServer(uiAutomatorRunner(calls)), "assert_ui_node", {
    device_serial: "emulator-5554",
    text: "All The Channels",
    should_exist: false,
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /UI node assertion failed/);
});

test("UI node tools reject queries without filters", async () => {
  const calls: string[][] = [];
  const result = await callTool(testServer(uiAutomatorRunner(calls)), "wait_for_ui_node", {
    device_serial: "emulator-5554",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /At least one UI node filter is required/);
  assert.deepEqual(calls, []);
});

test("wait_for_ui_node rejects timeout and poll interval outside range", async () => {
  const calls: string[][] = [];
  const server = testServer(uiAutomatorRunner(calls));
  const timeoutResult = await callTool(server, "wait_for_ui_node", {
    text: "All The Channels",
    timeout_ms: 30_001,
  });
  const pollResult = await callTool(server, "wait_for_ui_node", {
    text: "All The Channels",
    poll_interval_ms: 49,
  });

  assert.equal(timeoutResult.isError, true);
  assert.match(timeoutResult.content[0].text, /timeout_ms must be an integer between 0 and 30000/);
  assert.equal(pollResult.isError, true);
  assert.match(pollResult.content[0].text, /poll_interval_ms must be an integer between 50 and 1000/);
  assert.deepEqual(calls, []);
});

test("press_key_sequence is listed with bounded sequence schema", async () => {
  const result = await listTools(testServer(vegaRunner()));
  const tool = result.tools.find((candidate) => candidate.name === "press_key_sequence");

  assert.ok(tool, "press_key_sequence should be listed");
  const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.sequence.minItems, 1);
  assert.equal(properties.sequence.maxItems, 20);
});

test("press_key_sequence sends Android events through one shell command", async () => {
  const calls: string[][] = [];
  const result = await callTool(testServer(androidInputRunner(calls)), "press_key_sequence", {
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
  const result = await callTool(testServer(androidInputRunner(calls)), "press_key_sequence", {
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
