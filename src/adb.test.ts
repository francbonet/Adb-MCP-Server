import assert from "node:assert/strict";
import test from "node:test";
import { AdbClient, CommandRunner } from "./adb.js";

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

function capabilityRunner(devicesOutput: string, commandsBySerial: Record<string, Set<string>>): CommandRunner {
  return async (_executable, args) => {
    if (args.join(" ") === "devices -l") return ok(devicesOutput);
    const serial = args[1];
    const command = args[5];
    if (args[0] === "-s" && args[2] === "shell" && args[3] === "command" && args[4] === "-v") {
      return commandsBySerial[serial]?.has(command) ? ok(`/system/bin/${command}\n`) : missing();
    }
    if (args[0] === "-s" && args[2] === "shell" && args[3] === "getprop") {
      return ok("[ro.build.version.sdk]: [35]\n[ro.product.model]: [Android TV]\n");
    }
    return missing();
  };
}

test("detectCapabilities reports a full Android userspace", async () => {
  const commands = new Set([
    "dumpsys",
    "uiautomator",
    "logcat",
    "input",
    "screencap",
    "am",
    "monkey",
    "getprop",
    "wm",
  ]);
  const adb = new AdbClient({
    runner: capabilityRunner("List of devices attached\nemulator-5554 device model:Android_TV\n", {
      "emulator-5554": commands,
    }),
  });

  const capabilities = await adb.detectCapabilities("emulator-5554");

  assert.equal(capabilities.platform, "android");
  assert.equal(capabilities.hasDumpsys, true);
  assert.equal(capabilities.hasUiAutomator, true);
  assert.equal(capabilities.hasLogcat, true);
  assert.equal(capabilities.hasInput, true);
  assert.equal(capabilities.hasScreencap, true);
});

test("listDevicesWithCapabilities identifies Vega virtual devices with missing Android tools", async () => {
  const adb = new AdbClient({
    runner: capabilityRunner(
      "List of devices attached\nemulator-5554 device model:VirtualDevice:\n",
      { "emulator-5554": new Set() }
    ),
  });

  const devices = await adb.listDevicesWithCapabilities();

  assert.equal(devices.length, 1);
  assert.equal(devices[0].serial, "emulator-5554");
  assert.equal(devices[0].capabilities.platform, "vega");
  assert.equal(devices[0].capabilities.hasDumpsys, false);
  assert.equal(devices[0].capabilities.hasUiAutomator, false);
  assert.equal(devices[0].capabilities.hasInput, false);
});

test("listDevicesWithCapabilities handles mixed Android and Vega devices", async () => {
  const androidCommands = new Set([
    "dumpsys",
    "uiautomator",
    "logcat",
    "input",
    "screencap",
    "am",
    "monkey",
    "getprop",
    "wm",
  ]);
  const adb = new AdbClient({
    runner: capabilityRunner(
      [
        "List of devices attached",
        "emulator-5554 device model:VirtualDevice:",
        "emulator-5556 device model:Android_TV",
      ].join("\n"),
      {
        "emulator-5554": new Set(),
        "emulator-5556": androidCommands,
      }
    ),
  });

  const devices = await adb.listDevicesWithCapabilities();

  assert.deepEqual(
    devices.map((device) => [device.serial, device.capabilities.platform]),
    [
      ["emulator-5554", "vega"],
      ["emulator-5556", "android"],
    ]
  );
});
