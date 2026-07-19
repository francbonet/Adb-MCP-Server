import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { optimizeScreenshot } from "./screenshot.js";

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
