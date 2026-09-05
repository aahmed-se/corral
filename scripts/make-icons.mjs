// Generates the extension icons (public/icons/icon-{16,32,48,128}.png)
// without any image dependency: shapes are rasterized as signed distance
// fields at 4x supersampling, then encoded as PNG through node:zlib.
// The glyph matches the brand: a white lasso on the indigo gradient.
// Usage: node scripts/make-icons.mjs
// Bookmark OS: node scripts/make-icons.mjs --bookmark-os

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOOKMARK_OS = process.argv.includes('--bookmark-os');
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', BOOKMARK_OS ? 'bookmark-os' : 'public', 'icons');
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

// Brand palette (styles.css --accent range).
const GRADIENT_TOP = [0x8f, 0x9a, 0xf8];
const GRADIENT_BOTTOM = [0x4f, 0x46, 0xe5];
const GLYPH = [0xff, 0xff, 0xff];

// --- PNG encoding ------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
  return Buffer.concat([header, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- geometry ------------------------------------------------------------------

function roundedRectDistance(x, y, half, radius) {
  const qx = Math.abs(x - half) - (half - radius);
  const qy = Math.abs(y - half) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1)));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

/** The lasso in unit coordinates: an open loop, a tail curling toward the
 * corner, and the honda knot where the tail leaves the loop. */
function lassoGeometry() {
  const center = [0.44, 0.44];
  const radius = 0.265;
  const points = [];
  // Loop with its gap facing down-right (where the tail attaches).
  for (let degrees = 72; degrees <= 378; degrees += 4) {
    const angle = (degrees * Math.PI) / 180;
    points.push([[center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]]);
  }
  const loop = points.map((entry) => entry[0]);
  // Tail: quadratic curve from the loop's end down to the corner.
  const start = loop[loop.length - 1];
  const control = [0.68, 0.6];
  const end = [0.87, 0.9];
  const tail = [];
  for (let step = 0; step <= 20; step += 1) {
    const t = step / 20;
    const inverse = 1 - t;
    tail.push([
      inverse * inverse * start[0] + 2 * inverse * t * control[0] + t * t * end[0],
      inverse * inverse * start[1] + 2 * inverse * t * control[1] + t * t * end[1],
    ]);
  }
  return { loop, tail, knot: start };
}

function polylineDistance(x, y, points) {
  let best = Infinity;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const [ax, ay] = points[index];
    const [bx, by] = points[index + 1];
    const distance = segmentDistance(x, y, ax, ay, bx, by);
    if (distance < best) best = distance;
  }
  return best;
}

// --- rendering -----------------------------------------------------------------

function render(size) {
  const scale = size * SUPERSAMPLE;
  const { loop, tail, knot } = lassoGeometry();
  const toScale = (points) => points.map(([x, y]) => [x * scale, y * scale]);
  const loopScaled = toScale(loop);
  const tailScaled = toScale(tail);
  const knotScaled = [knot[0] * scale, knot[1] * scale];
  // Slightly heavier rope at tiny sizes, or it dissolves at 16px.
  const strokeHalf = (size <= 32 ? 0.052 : 0.042) * scale;
  const knotRadius = strokeHalf * 1.7;
  const cornerRadius = 0.22 * scale;
  const half = scale / 2;

  const rgba = Buffer.alloc(size * size * 4);
  const accumulator = new Float64Array(4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      accumulator.fill(0);
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = px * SUPERSAMPLE + sx + 0.5;
          const y = py * SUPERSAMPLE + sy + 0.5;
          if (roundedRectDistance(x, y, half, cornerRadius) > 0) continue;
          const t = (x + y) / (2 * scale);
          let color = GRADIENT_TOP.map((top, channel) => top + (GRADIENT_BOTTOM[channel] - top) * t);
          const glyphDistance = Math.min(
            polylineDistance(x, y, loopScaled) - strokeHalf,
            polylineDistance(x, y, tailScaled) - strokeHalf,
            Math.hypot(x - knotScaled[0], y - knotScaled[1]) - knotRadius,
          );
          if (glyphDistance < 0) color = GLYPH;
          accumulator[0] += color[0];
          accumulator[1] += color[1];
          accumulator[2] += color[2];
          accumulator[3] += 255;
        }
      }
      const offset = (py * size + px) * 4;
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const covered = accumulator[3] / 255;
      // PNG wants straight alpha: the color channels are the average over the
      // covered subsamples only; coverage lives in the alpha channel alone.
      rgba[offset] = covered > 0 ? Math.round(accumulator[0] / covered) : 0;
      rgba[offset + 1] = covered > 0 ? Math.round(accumulator[1] / covered) : 0;
      rgba[offset + 2] = covered > 0 ? Math.round(accumulator[2] / covered) : 0;
      rgba[offset + 3] = Math.round((covered / samples) * 255);
    }
  }
  return encodePng(size, rgba);
}

// A solid ribbon keeps its notch legible at 16px. Render directly at each
// target size with supersampling, rather than shrinking a large bitmap.
function renderBookmarkOS(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          const edge = roundedRectDistance(x, y, 0.5, 0.22);
          if (edge > 0) continue;
          let color = [23, 36, 59].map((top, channel) => top + ([8, 13, 24][channel] - top) * y);
          if (edge > -0.025) color = [51, 69, 101];
          // SVG-equivalent path: M8 6 H24 V26 L16 21 L8 26 Z.
          const bottom = 21 / 32 + Math.abs(x - 0.5) * 5 / 8;
          if (x >= 0.25 && x <= 0.75 && y >= 6 / 32 && y <= bottom) {
            const t = Math.max(0, Math.min(1, (y - 6 / 32) / (20 / 32)));
            color = [241, 205, 120].map((top, channel) => top + ([212, 168, 67][channel] - top) * t);
          }
          for (let channel = 0; channel < 3; channel++) sum[channel] += color[channel];
          covered++;
        }
      }
      const offset = (py * size + px) * 4;
      for (let channel = 0; channel < 3; channel++) rgba[offset + channel] = covered ? Math.round(sum[channel] / covered) : 0;
      rgba[offset + 3] = Math.round(255 * covered / samples);
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, BOOKMARK_OS ? renderBookmarkOS(size) : render(size));
  console.log('wrote', file);
}
