import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { optimizeScreenshot, saveScreenshot } from "./screenshot.js";

test("optimizes a large PNG to the configured dimensions and byte limit", async () => {
  const width = 1920;
  const height = 1080;
  const pixels = Buffer.alloc(width * height * 3);
  let value = 0x12345678;
  for (let index = 0; index < pixels.length; index += 1) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    pixels[index] = value & 0xff;
  }
  const source = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();

  const result = await optimizeScreenshot(source, {
    maxBytes: 1024 * 1024,
    maxWidth: 1280,
    maxHeight: 720,
  });

  assert.ok(result.data.length <= 1024 * 1024);
  assert.ok(result.width <= 1280);
  assert.ok(result.height <= 720);
  assert.equal(result.originalWidth, 1920);
  assert.equal(result.originalHeight, 1080);
  assert.equal((await sharp(result.data).metadata()).format, "png");
});

test("rejects data that is not a PNG", async () => {
  await assert.rejects(
    optimizeScreenshot(Buffer.from("not a png"), {
      maxBytes: 1024 * 1024,
      maxWidth: 1280,
      maxHeight: 720,
    }),
    /valid PNG/
  );
});

test("saves a screenshot inside the save root and creates parent folders", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adb-mcp-save-"));
  try {
    const saved = await saveScreenshot(Buffer.from("png-bytes"), "bug-12/before.png", root);
    assert.equal(saved, path.join(await realpath(root), "bug-12", "before.png"));
    assert.equal((await readFile(saved)).toString(), "png-bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects save paths outside the save root or without a .png extension", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adb-mcp-save-"));
  try {
    await assert.rejects(saveScreenshot(Buffer.from("x"), "../escape.png", root), /inside the screenshot save root/);
    await assert.rejects(saveScreenshot(Buffer.from("x"), "/tmp/escape.png", root), /inside the screenshot save root/);
    await assert.rejects(saveScreenshot(Buffer.from("x"), "shot.jpg", root), /must end in \.png/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
