import sharp from "sharp";

export interface ScreenshotOptimizationOptions {
  maxBytes: number;
  maxWidth: number;
  maxHeight: number;
}

export interface OptimizedScreenshot {
  data: Buffer;
  originalBytes: number;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  colours: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_INPUT_PIXELS = 50_000_000;

function isPng(data: Buffer): boolean {
  return data.length >= PNG_SIGNATURE.length && data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

export async function optimizeScreenshot(
  input: Buffer,
  options: ScreenshotOptimizationOptions
): Promise<OptimizedScreenshot> {
  if (!isPng(input)) throw new Error("Device did not return a valid PNG screenshot");
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < 64 * 1024) {
    throw new Error("Screenshot output limit must be at least 65536 bytes");
  }
  if (!Number.isInteger(options.maxWidth) || options.maxWidth < 320) {
    throw new Error("Screenshot maximum width must be at least 320 pixels");
  }
  if (!Number.isInteger(options.maxHeight) || options.maxHeight < 180) {
    throw new Error("Screenshot maximum height must be at least 180 pixels");
  }

  const metadata = await sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  if (metadata.format !== "png" || !metadata.width || !metadata.height) {
    throw new Error("Device did not return a decodable PNG screenshot");
  }

  let width = Math.min(metadata.width, options.maxWidth);
  let height = Math.min(metadata.height, options.maxHeight);
  const colourLevels = [256, 128, 64, 32];

  while (width >= 320 && height >= 180) {
    for (const colours of colourLevels) {
      const output = await sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
        .resize({
          width,
          height,
          fit: "inside",
          withoutEnlargement: true,
          kernel: sharp.kernel.lanczos3,
        })
        .png({
          palette: true,
          colours,
          quality: 90,
          compressionLevel: 9,
          adaptiveFiltering: true,
          effort: 7,
          dither: 0.5,
        })
        .toBuffer({ resolveWithObject: true });

      if (output.data.length <= options.maxBytes) {
        return {
          data: output.data,
          originalBytes: input.length,
          originalWidth: metadata.width,
          originalHeight: metadata.height,
          width: output.info.width,
          height: output.info.height,
          colours,
        };
      }
    }

    width = Math.floor(width * 0.85);
    height = Math.floor(height * 0.85);
  }

  throw new Error(
    `Unable to optimize screenshot below ${options.maxBytes} bytes without reducing it below 320x180`
  );
}
