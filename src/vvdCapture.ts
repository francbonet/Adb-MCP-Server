import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { CommandResult, CommandRunner, defaultCommandRunner } from "./adb.js";

/**
 * Host-side screenshots of the Vega Virtual Device (VVD) on macOS.
 *
 * The VVD renders on the GPU, so device-side tools and QEMU screendump cannot see the picture. Instead this
 * module finds the VVD's QEMU process for an `emulator-<port>` serial, captures its on-screen window with
 * `screencapture -l`, and crops the TV display out of the skin (title bar and remote control removed).
 */

export class VvdCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VvdCaptureError";
  }
}

export const SCREEN_RECORDING_DENIED_MESSAGE =
  "macOS denied window capture: grant Screen Recording to the app that launched this MCP server (System Settings → Privacy & Security → Screen & System Audio Recording), then restart that app.";

export interface VvdProcess {
  pid: number;
  skinDir?: string;
  skin?: string;
}

export interface VvdWindow {
  id: number;
  pid: number;
  owner?: string;
  layer: number;
  width: number;
  height: number;
}

/** Geometry from a skin `layout` file, in layout units. */
export interface SkinLayout {
  width: number;
  height: number;
  /** Position of the part named `device` inside the first layout. */
  deviceX: number;
  deviceY: number;
  /** `parts.device.display` geometry; its x/y offset the display inside the device part. */
  displayX: number;
  displayY: number;
  displayWidth: number;
  displayHeight: number;
}

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface VvdCaptureOptions {
  runner?: CommandRunner;
  /** Reject captures larger than this many bytes. */
  maxBytes?: number;
}

const PS_EXECUTABLE = "/bin/ps";
const OSASCRIPT_EXECUTABLE = "/usr/bin/osascript";
const SCREENCAPTURE_EXECUTABLE = "/usr/sbin/screencapture";

/** JXA that lists on-screen windows as JSON; CGWindowListCopyWindowInfo needs no extra permission for this. */
export const WINDOW_LIST_JXA = [
  "ObjC.import('CoreGraphics');",
  "const l = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));",
  "const out = [];",
  "for (let i = 0; i < l.count; i++) { const w = l.objectAtIndex(i); const b = w.objectForKey('kCGWindowBounds');",
  "  out.push({ id: ObjC.unwrap(w.objectForKey('kCGWindowNumber')), pid: ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')), owner: ObjC.unwrap(w.objectForKey('kCGWindowOwnerName')), layer: ObjC.unwrap(w.objectForKey('kCGWindowLayer')), width: ObjC.unwrap(b.objectForKey('Width')), height: ObjC.unwrap(b.objectForKey('Height')) }); }",
  "JSON.stringify(out);",
].join("\n");

/** Console port of an `emulator-<port>` serial, or undefined for any other serial. */
export function vvdConsolePort(serial: string): number | undefined {
  const match = /^emulator-(\d{1,5})$/.exec(serial.trim());
  if (!match) return undefined;
  const port = Number(match[1]);
  return port > 0 && port <= 65535 ? port : undefined;
}

/**
 * Find the VVD QEMU process for a console port in `ps -axo pid=,command=` output. The process command contains
 * `vega-virtual-device` and `-ports <console>,<adb>` (or just `-ports <console>`).
 */
export function findVvdProcess(psOutput: string, port: number): VvdProcess | undefined {
  const portsPattern = new RegExp(`(?:^|\\s)-ports\\s+${port}(?:,|\\s|$)`);
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const command = match[2];
    if (!command.includes("vega-virtual-device") || !portsPattern.test(command)) continue;
    return {
      pid: Number(match[1]),
      // ps does not quote arguments: take everything up to the next " -flag" so paths with spaces survive.
      skinDir: /(?:^|\s)-skindir\s+(.+?)(?=\s+-[A-Za-z]|$)/.exec(command)?.[1],
      skin: /(?:^|\s)-skin\s+(\S+)/.exec(command)?.[1],
    };
  }
  return undefined;
}

/** Pick the VVD's main window (layer 0, owned by `pid`) from the JXA window list; the largest wins on ties. */
export function selectVvdWindow(windowsJson: string, pid: number): VvdWindow | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(windowsJson);
  } catch {
    throw new VvdCaptureError("Could not read the macOS window list: osascript did not return JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new VvdCaptureError("Could not read the macOS window list: osascript did not return a JSON array.");
  }
  const candidates = parsed.filter(
    (window): window is VvdWindow =>
      typeof window === "object" &&
      window !== null &&
      window.pid === pid &&
      window.layer === 0 &&
      Number.isInteger(window.id) &&
      typeof window.width === "number" &&
      typeof window.height === "number"
  );
  candidates.sort((a, b) => b.width * b.height - a.width * a.height);
  return candidates[0];
}

type LayoutValue = string | LayoutBlock;
type LayoutBlock = Array<[string, LayoutValue]>;
type LayoutToken = { value: string; brace: boolean };

function tokenizeLayout(text: string): LayoutToken[] {
  const tokens: LayoutToken[] = [];
  for (const match of text.matchAll(/"([^"]*)"|([{}])|([^\s{}"]+)/g)) {
    tokens.push(
      match[2] !== undefined ? { value: match[2], brace: true } : { value: match[1] ?? match[3], brace: false }
    );
  }
  return tokens;
}

function parseLayoutBlock(tokens: LayoutToken[], start: number, nested: boolean): [LayoutBlock, number] {
  const block: LayoutBlock = [];
  let index = start;
  while (index < tokens.length) {
    const key = tokens[index];
    if (key.brace && key.value === "}") {
      if (!nested) throw new Error("Unexpected } in skin layout");
      return [block, index + 1];
    }
    if (key.brace) throw new Error("Unexpected { in skin layout");
    const next = tokens[index + 1];
    if (!next) throw new Error(`Missing value for ${key.value} in skin layout`);
    if (next.brace && next.value === "{") {
      const [child, after] = parseLayoutBlock(tokens, index + 2, true);
      block.push([key.value, child]);
      index = after;
    } else if (next.brace) {
      throw new Error(`Missing value for ${key.value} in skin layout`);
    } else {
      block.push([key.value, next.value]);
      index += 2;
    }
  }
  if (nested) throw new Error("Unterminated block in skin layout");
  return [block, index];
}

function blockValue(block: LayoutBlock | undefined, key: string): LayoutValue | undefined {
  return block?.find(([name]) => name === key)?.[1];
}

function childBlock(block: LayoutBlock | undefined, key: string): LayoutBlock | undefined {
  const value = blockValue(block, key);
  return Array.isArray(value) ? value : undefined;
}

function numberValue(block: LayoutBlock | undefined, key: string, fallback?: number): number | undefined {
  const value = blockValue(block, key);
  if (value === undefined) return fallback;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parse an emulator skin `layout` file. Uses the first layout's width/height, the x/y of its part named
 * `device`, and `parts.device.display`. Returns undefined when any of these is missing or malformed.
 */
export function parseSkinLayout(text: string): SkinLayout | undefined {
  let root: LayoutBlock;
  try {
    [root] = parseLayoutBlock(tokenizeLayout(text), 0, false);
  } catch {
    return undefined;
  }
  const firstLayout = childBlock(root, "layouts")?.find(([, value]) => Array.isArray(value))?.[1];
  if (!Array.isArray(firstLayout)) return undefined;
  const devicePart = firstLayout
    .map(([, value]) => value)
    .find((value): value is LayoutBlock => Array.isArray(value) && blockValue(value, "name") === "device");
  const display = childBlock(childBlock(childBlock(root, "parts"), "device"), "display");
  if (!devicePart || !display) return undefined;

  const layout = {
    width: numberValue(firstLayout, "width"),
    height: numberValue(firstLayout, "height"),
    deviceX: numberValue(devicePart, "x", 0),
    deviceY: numberValue(devicePart, "y", 0),
    displayX: numberValue(display, "x", 0),
    displayY: numberValue(display, "y", 0),
    displayWidth: numberValue(display, "width"),
    displayHeight: numberValue(display, "height"),
  };
  const values = Object.values(layout);
  if (values.some((value) => value === undefined)) return undefined;
  const complete = layout as SkinLayout;
  if (complete.width <= 0 || complete.height <= 0 || complete.displayWidth <= 0 || complete.displayHeight <= 0) {
    return undefined;
  }
  return complete;
}

/**
 * Crop rectangle of the TV display inside a window capture. The capture is the skin layout scaled by
 * s = imageWidth / layoutWidth, plus a title bar on top that takes the remaining height.
 */
export function computeVvdCrop(imageWidth: number, imageHeight: number, layout: SkinLayout): CropRect | undefined {
  const scale = imageWidth / layout.width;
  const titleBar = imageHeight - Math.round(layout.height * scale);
  const rawLeft = Math.round((layout.deviceX + layout.displayX) * scale);
  const rawTop = titleBar + Math.round((layout.deviceY + layout.displayY) * scale);
  const left = Math.min(Math.max(rawLeft, 0), imageWidth);
  const top = Math.min(Math.max(rawTop, 0), imageHeight);
  const width = Math.min(Math.round(layout.displayWidth * scale) - (left - rawLeft), imageWidth - left);
  const height = Math.min(Math.round(layout.displayHeight * scale) - (top - rawTop), imageHeight - top);
  if (width <= 0 || height <= 0) return undefined;
  return { left, top, width, height };
}

/** Crop a VVD window capture to the TV display; returns the capture unchanged when no layout is available. */
export async function cropVvdCapture(png: Buffer, layout: SkinLayout | undefined): Promise<Buffer> {
  if (!layout) return png;
  const metadata = await sharp(png).metadata();
  if (!metadata.width || !metadata.height) return png;
  const rect = computeVvdCrop(metadata.width, metadata.height, layout);
  if (!rect) return png;
  return sharp(png).extract(rect).png().toBuffer();
}

async function readSkinLayout(vvd: VvdProcess): Promise<SkinLayout | undefined> {
  if (!vvd.skinDir || !vvd.skin) return undefined;
  try {
    return parseSkinLayout(await readFile(path.join(vvd.skinDir, vvd.skin, "layout"), "utf8"));
  } catch {
    return undefined;
  }
}

function outputText(result: CommandResult): string {
  return [result.stderr.toString("utf8").trim(), result.stdout.toString("utf8").trim()].filter(Boolean).join("\n");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Capture the TV picture of the Vega Virtual Device behind an `emulator-<port>` serial (macOS only):
 * find its QEMU process, capture its window with screencapture, and crop away the title bar and remote.
 */
export async function captureVvdScreen(serial: string, options: VvdCaptureOptions = {}): Promise<Buffer> {
  const runner = options.runner ?? defaultCommandRunner;
  const port = vvdConsolePort(serial);
  if (port === undefined) {
    throw new VvdCaptureError(`${serial} is not a Vega Virtual Device serial; expected emulator-<port>.`);
  }

  const ps = await runner(PS_EXECUTABLE, ["-axo", "pid=,command="], { timeoutMs: 5_000, maxOutputBytes: 4 * 1024 * 1024 });
  if (ps.exitCode !== 0) {
    throw new VvdCaptureError(`Could not list host processes with ps: ${outputText(ps) || `exit code ${ps.exitCode}`}`);
  }
  const vvd = findVvdProcess(ps.stdout.toString("utf8"), port);
  if (!vvd) {
    throw new VvdCaptureError(
      `No Vega Virtual Device process found for ${serial}: no running vega-virtual-device has -ports ${port}. Start the VVD for this serial and retry.`
    );
  }

  const windowList = await runner(OSASCRIPT_EXECUTABLE, ["-l", "JavaScript", "-e", WINDOW_LIST_JXA], {
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
  });
  if (windowList.exitCode !== 0) {
    throw new VvdCaptureError(
      `Could not list macOS windows with osascript: ${outputText(windowList) || `exit code ${windowList.exitCode}`}`
    );
  }
  const window = selectVvdWindow(windowList.stdout.toString("utf8"), vvd.pid);
  if (!window) {
    throw new VvdCaptureError(
      `The Vega Virtual Device window for ${serial} (pid ${vvd.pid}) is not on screen: it is minimized or on another Space. Restore it on the current Space and retry.`
    );
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "adb-mcp-vvd-"));
  const capturePath = path.join(tempDir, "window.png");
  try {
    let capture: CommandResult;
    try {
      capture = await runner(SCREENCAPTURE_EXECUTABLE, ["-x", "-o", "-l", String(window.id), capturePath], {
        timeoutMs: 15_000,
        maxOutputBytes: 64 * 1024,
      });
    } catch (error) {
      throw new VvdCaptureError(`${SCREEN_RECORDING_DENIED_MESSAGE} (screencapture: ${errorText(error)})`);
    }
    const detail = outputText(capture);
    if (capture.exitCode !== 0 || /could not create image/i.test(detail)) {
      throw new VvdCaptureError(
        `${SCREEN_RECORDING_DENIED_MESSAGE} (screencapture: ${detail || `exit code ${capture.exitCode}`})`
      );
    }
    const png = await readFile(capturePath).catch(() => Buffer.alloc(0));
    if (png.length === 0) {
      throw new VvdCaptureError(`${SCREEN_RECORDING_DENIED_MESSAGE} (screencapture wrote no image)`);
    }
    if (options.maxBytes !== undefined && png.length > options.maxBytes) {
      throw new VvdCaptureError(
        `VVD window capture is ${png.length} bytes, above the ${options.maxBytes}-byte screenshot limit.`
      );
    }
    return await cropVvdCapture(png, await readSkinLayout(vvd));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
