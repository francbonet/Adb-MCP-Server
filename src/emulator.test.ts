import assert from "node:assert/strict";
import test from "node:test";
import { parseAvdList } from "./emulator.js";

test("parseAvdList removes empty lines and surrounding whitespace", () => {
  assert.deepEqual(parseAvdList(" Television_1080p_API_34 \n\nPixel_API_35\r\n"), [
    "Television_1080p_API_34",
    "Pixel_API_35",
  ]);
});
