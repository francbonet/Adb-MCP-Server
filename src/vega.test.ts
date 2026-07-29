import assert from "node:assert/strict";
import test from "node:test";
import { CommandRunner } from "./adb.js";
import { VegaClient } from "./vega.js";

const ok = (stdout = "") => ({
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
  exitCode: 0,
});

test("VegaClient routes remote input through inputd-cli", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_executable, args) => {
    calls.push([...args]);
    return ok();
  };
  const vega = new VegaClient({ runner });

  await vega.pressKey("emulator-5554", "DPAD_LEFT");
  await vega.tap("emulator-5554", 10, 20);
  await vega.typeText("emulator-5554", "hello");

  assert.deepEqual(calls, [
    ["exec", "vda", "-s", "emulator-5554", "shell", "inputd-cli", "button_press", "KEY_LEFT"],
    ["exec", "vda", "-s", "emulator-5554", "shell", "inputd-cli", "touch", "10", "20"],
    ["exec", "vda", "-s", "emulator-5554", "shell", "inputd-cli", "send_text", "hello"],
  ]);
});

test("VegaClient routes logs through loggingctl", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_executable, args) => {
    calls.push([...args]);
    return ok("line one\nline two\n");
  };
  const vega = new VegaClient({ runner });

  const output = await vega.logs("emulator-5554", 1024);

  assert.equal(output, "line one\nline two");
  assert.deepEqual(calls, [
    ["exec", "vda", "-s", "emulator-5554", "shell", "loggingctl", "log", "-o", "short_precise"],
  ]);
});

test("VegaClient launches the package main component", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_executable, args) => {
    calls.push([...args]);
    return ok("launched");
  };
  const vega = new VegaClient({ runner });

  const output = await vega.launchApp("emulator-5554", "com.example.app");

  assert.equal(output, "launched");
  assert.deepEqual(calls, [
    ["device", "launch-app", "--device", "emulator-5554", "--appName", "com.example.app.main"],
  ]);
});
