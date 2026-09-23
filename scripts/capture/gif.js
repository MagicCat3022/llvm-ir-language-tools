'use strict';

// Encodes PNG frames into an animated GIF. Identical consecutive frames are
// merged into one longer frame, which keeps pauses cheap.
const { PNG } = require('pngjs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

function encodeGif(frames, { holdLastMs = 1500 } = {}) {
  const decoded = [];
  for (const frame of frames) {
    const previous = decoded[decoded.length - 1];
    if (previous && previous.png.equals(frame.png)) { previous.delay += frame.delay; continue; }
    decoded.push({ png: frame.png, delay: frame.delay });
  }
  if (!decoded.length) throw new Error('No frames to encode.');
  decoded[decoded.length - 1].delay += holdLastMs;
  const gif = GIFEncoder();
  let width, height;
  for (const frame of decoded) {
    const image = PNG.sync.read(frame.png);
    // Frames can differ by a pixel when a widget resizes; the first sets the size.
    width ??= image.width; height ??= image.height;
    const data = image.width === width && image.height === height ? image.data : crop(image, width, height);
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), width, height, { palette, delay: Math.max(20, Math.round(frame.delay)) });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

function crop(image, width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < Math.min(height, image.height); y++) {
    const row = image.data.subarray(y * image.width * 4, y * image.width * 4 + Math.min(width, image.width) * 4);
    data.set(row, y * width * 4);
  }
  return data;
}

module.exports = { encodeGif };
