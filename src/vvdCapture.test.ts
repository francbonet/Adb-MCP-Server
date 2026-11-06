import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { CommandResult, CommandRunner } from "./adb.js";
import {
  SCREEN_RECORDING_DENIED_MESSAGE,
  captureVvdScreen,
  computeVvdCrop,
  cropVvdCapture,
  findVvdProcess,
  parseSkinLayout,
  selectVvdWindow,
  vvdConsolePort,
} from "./vvdCapture.js";

/** Verbatim copy of vvd/images/tv/vmtools/agent/skins/tv-remote/layout from Vega SDK 0.24. */
const TV_REMOTE_LAYOUT = `parts {

    device {
        display {
            width   1920
            height  1080
            x       0
            y       0
        }
    }
    
    remote_control {
        background {
            image   remote-controller.png
        }
        buttons {

            LINUX_KEY_UP {
                note    "KEY_UP"
                image   key.png
                x       129
                y       250
            }

            LINUX_KEY_LEFT {
                note    "KEY_LEFT"
                image   key.png
                x       51
                y       332
            }

            LINUX_KEY_DOWN {
                note    "KEY_DOWN"
                image   key.png
                x       128
                y       407
            }

            LINUX_KEY_RIGHT {
                note    "KEY_RIGHT"
                image   key.png
                x       207
                y       332
            }

            LINUX_KEY_KPENTER {
                note    "KEY_KPENTER"
                image   key-lg.png
                x       104
                y       303
            }

            LINUX_KEY_BACK {
                note    "KEY_BACK"
                image   key.png
                x       44
                y       500
            }

            LINUX_KEY_HOMEPAGE {
                note    "KEY_HOMEPAGE"
                image   key.png
                x       127
                y       500
            }

            LINUX_KEY_MENU {
                note    "KEY_MENU"
                image   key.png
                x       207
                y       500
            }

            LINUX_KEY_REWIND {
                note    "KEY_REWIND"
                image   key.png
                x       44
                y       575
            }

            LINUX_KEY_PLAYPAUSE {
                note    "KEY_PLAYPAUSE"
                image   key.png
                x       127
                y       575
            }

            LINUX_KEY_FASTFORWARD {
                note    "KEY_FASTFORWARD"
                image   key.png
                x       207
                y       575
            }

        }
    }
}

layouts {
    portrait {
        width     2320
        height    1080
        color     0xe0e0e0
        
        part1 {
            name    device
            x       0
            y       0
        }
        
        part2 {
            name    remote_control
            x       1960
            y       10
        }
    }
}
`;

const SKIN_DIR = "/Users/me/vega/sdk/vega-sdk/main/0.24.12044/vvd/images/tv/vmtools/agent/skins";
const VVD_PS_LINE = `46508 /Users/me/vega/sdk/vega-sdk/main/0.24.12044/vvd/images/tv/vmtools/agent/qemu/darwin-aarch64/vega-virtual-device -avd-arch arm64 -skindir ${SKIN_DIR} -skin tv-remote -ports 5556,5557 -dns-server auto -qemu -qmp unix:/tmp/qmp-socket-5556.sock,server,nowait`;

const ok = (stdout = ""): CommandResult => ({ stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode: 0 });
const failed = (stderr: string, exitCode = 1): CommandResult => ({
  stdout: Buffer.alloc(0),
  stderr: Buffer.from(stderr),
  exitCode,
});

/** 2320x1136 window capture: 56 px black title bar, then the 1920x1080 TV picture (red) and the remote area (white). */
async function syntheticWindowCapture(): Promise<Buffer> {
  const width = 2320;
  const height = 1136;
  const titleBar = 56;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = titleBar; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      if (x < 1920) {
        pixels[offset] = 255;
      } else {
        pixels.fill(255, offset, offset + 3);
      }
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function assertAllRed(png: Buffer, width: number, height: number): Promise<void> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, width);
  assert.equal(info.height, height);
  for (let offset = 0; offset < data.length; offset += 3) {
    if (data[offset] !== 255 || data[offset + 1] !== 0 || data[offset + 2] !== 0) {
      const pixel = offset / 3;
      assert.fail(`pixel (${pixel % width}, ${Math.floor(pixel / width)}) is not red`);
    }
  }
}

test("vvdConsolePort reads the console port from emulator serials only", () => {
  assert.equal(vvdConsolePort("emulator-5556"), 5556);
  assert.equal(vvdConsolePort("emulator-abc"), undefined);
  assert.equal(vvdConsolePort("192.168.1.20:5555"), undefined);
  assert.equal(vvdConsolePort("G070VM1234"), undefined);
});

test("parseSkinLayout reads the real tv-remote layout", () => {
  assert.deepEqual(parseSkinLayout(TV_REMOTE_LAYOUT), {
    width: 2320,
    height: 1080,
    deviceX: 0,
    deviceY: 0,
    displayX: 0,
    displayY: 0,
    displayWidth: 1920,
    displayHeight: 1080,
  });
});

test("parseSkinLayout rejects layouts without the required geometry", () => {
  assert.equal(parseSkinLayout(""), undefined);
  assert.equal(parseSkinLayout("layouts { portrait { width 100 height 50 } }"), undefined);
  assert.equal(parseSkinLayout("parts { device { display { width 10 height 10 } }"), undefined);
  assert.equal(parseSkinLayout(TV_REMOTE_LAYOUT.replace("width     2320", "width     wide")), undefined);
});

test("computeVvdCrop scales the layout and skips the title bar", () => {
  const layout = parseSkinLayout(TV_REMOTE_LAYOUT);
  assert.ok(layout);
  assert.deepEqual(computeVvdCrop(2320, 1136, layout), { left: 0, top: 56, width: 1920, height: 1080 });
  // Window at 1x (1160x568 points): scale 0.5, 28 point title bar.
  assert.deepEqual(computeVvdCrop(1160, 568, layout), { left: 0, top: 28, width: 960, height: 540 });
  // A capture shorter than the scaled layout is clamped to the image.
  assert.deepEqual(computeVvdCrop(2320, 1000, layout), { left: 0, top: 0, width: 1920, height: 1000 });
});

test("cropVvdCapture keeps only the TV picture of a synthetic window capture", async () => {
  const cropped = await cropVvdCapture(await syntheticWindowCapture(), parseSkinLayout(TV_REMOTE_LAYOUT));
  await assertAllRed(cropped, 1920, 1080);
});

test("cropVvdCapture returns the capture unchanged without a layout", async () => {
  const capture = await syntheticWindowCapture();
  assert.equal(await cropVvdCapture(capture, undefined), capture);
});

test("findVvdProcess matches the VVD for its console port and extracts the skin", () => {
  const psOutput = [
    "  1 /sbin/launchd",
    " 812 /Users/me/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd TV -ports 5554,5555",
    "45001 /opt/vega-virtual-device -skindir /other -skin other -ports 55560,55561",
    "45002 /opt/vega-virtual-device -skindir /single -skin single -ports 5558",
    VVD_PS_LINE,
  ].join("\n");

  assert.deepEqual(findVvdProcess(psOutput, 5556), { pid: 46508, skinDir: SKIN_DIR, skin: "tv-remote" });
  assert.deepEqual(findVvdProcess(psOutput, 5558), { pid: 45002, skinDir: "/single", skin: "single" });
  assert.equal(findVvdProcess(psOutput, 5554), undefined, "Android emulator is not a VVD");
  assert.equal(findVvdProcess(psOutput, 5557), undefined, "ADB port is not the console port");
  assert.equal(findVvdProcess(psOutput, 5560), undefined);
});

test("findVvdProcess keeps skin directories that contain spaces", () => {
  const line = "77 /Apps/vega-virtual-device -skindir /Users/me/My SDK/skins -skin tv-remote -ports 5556,5557";
  assert.deepEqual(findVvdProcess(line, 5556), { pid: 77, skinDir: "/Users/me/My SDK/skins", skin: "tv-remote" });
});

test("selectVvdWindow picks the layer-0 window owned by the VVD process", () => {
  const windows = JSON.stringify([
    { id: 10, pid: 46508, owner: "vega-virtual-device", layer: 25, width: 40, height: 22 },
    { id: 11, pid: 999, owner: "Finder", layer: 0, width: 1200, height: 800 },
    { id: 12, pid: 46508, owner: "vega-virtual-device", layer: 0, width: 300, height: 200 },
    { id: 13, pid: 46508, owner: "vega-virtual-device", layer: 0, width: 1160, height: 568 },
  ]);
  assert.equal(selectVvdWindow(windows, 46508)?.id, 13);
  assert.equal(selectVvdWindow(windows, 1234), undefined);
  assert.throws(() => selectVvdWindow("not json", 46508), /window list/);
});

function captureRunner(calls: string[][], screencapture: (args: readonly string[]) => Promise<CommandResult>): CommandRunner {
  return async (executable, args) => {
    calls.push([executable, ...args]);
    if (executable.endsWith("/ps")) return ok(`${VVD_PS_LINE}\n`);
    if (executable.endsWith("/osascript")) {
      return ok(JSON.stringify([{ id: 4242, pid: 46508, owner: "vega-virtual-device", layer: 0, width: 1160, height: 568 }]));
    }
    if (executable.endsWith("/screencapture")) return screencapture(args);
    return failed(`unexpected ${executable}`);
  };
}

test("captureVvdScreen captures the VVD window and crops it with the skin layout", async () => {
  const skinRoot = await mkdtemp(path.join(tmpdir(), "adb-mcp-vvd-skin-"));
  try {
    await mkdir(path.join(skinRoot, "tv-remote"));
    await writeFile(path.join(skinRoot, "tv-remote", "layout"), TV_REMOTE_LAYOUT);
    const capture = await syntheticWindowCapture();
    const calls: string[][] = [];
    const runner: CommandRunner = async (executable, args, options) => {
      if (executable.endsWith("/ps")) {
        calls.push([executable, ...args]);
        return ok(`${VVD_PS_LINE.replace(SKIN_DIR, skinRoot)}\n`);
      }
      return captureRunner(calls, async (screencaptureArgs) => {
        await writeFile(screencaptureArgs[screencaptureArgs.length - 1], capture);
        return ok();
      })(executable, args, options);
    };

    const screenshot = await captureVvdScreen("emulator-5556", { runner });

    await assertAllRed(screenshot, 1920, 1080);
    const screencaptureCall = calls.find(([executable]) => executable.endsWith("/screencapture"));
    assert.deepEqual(screencaptureCall?.slice(1, 5), ["-x", "-o", "-l", "4242"]);
  } finally {
    await rm(skinRoot, { recursive: true, force: true });
  }
});

test("captureVvdScreen explains how to grant Screen Recording when capture is denied", async () => {
  const runner = captureRunner([], async () => failed("could not create image from window"));
  await assert.rejects(captureVvdScreen("emulator-5556", { runner }), (error: Error) => {
    assert.ok(error.message.startsWith(SCREEN_RECORDING_DENIED_MESSAGE), error.message);
    assert.match(error.message, /System Settings → Privacy & Security → Screen & System Audio Recording/);
    return true;
  });

  const silentRunner = captureRunner([], async () => ok("could not create image from window"));
  await assert.rejects(captureVvdScreen("emulator-5556", { runner: silentRunner }), /grant Screen Recording/);
});

test("captureVvdScreen reports a missing VVD process or window", async () => {
  await assert.rejects(
    captureVvdScreen("emulator-5554", { runner: captureRunner([], async () => ok()) }),
    /No Vega Virtual Device process found for emulator-5554/
  );

  const hiddenWindowRunner: CommandRunner = async (executable, args, options) =>
    executable.endsWith("/osascript")
      ? ok("[]")
      : captureRunner([], async () => ok())(executable, args, options);
  await assert.rejects(
    captureVvdScreen("emulator-5556", { runner: hiddenWindowRunner }),
    /minimized or on another Space/
  );
});
