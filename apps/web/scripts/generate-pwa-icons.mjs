// Generates Aurora's dependency-free PNG app icons from the same geometric mark as aurora.svg.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(scriptDirectory, "../public/icons");
mkdirSync(outputDirectory, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1)
    crc = (crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1) >>> 0;
  return crc;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function blend(pixel, color, opacity = 1) {
  const alpha = opacity * (color[3] / 255);
  pixel[0] = Math.round(pixel[0] * (1 - alpha) + color[0] * alpha);
  pixel[1] = Math.round(pixel[1] * (1 - alpha) + color[1] * alpha);
  pixel[2] = Math.round(pixel[2] * (1 - alpha) + color[2] * alpha);
  pixel[3] = 255;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function insideTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) =>
    (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign([px, py], a, b);
  const d2 = sign([px, py], b, c);
  const d3 = sign([px, py], c, a);
  return !(d1 < 0 || d2 < 0 || d3 < 0) || !(d1 > 0 || d2 > 0 || d3 > 0);
}

function createIcon(size, maskable = false) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size / 512;
  const radius = (maskable ? 0 : 112) * scale;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const edgeX = Math.min(x, size - 1 - x);
      const edgeY = Math.min(y, size - 1 - y);
      const cornerX = Math.max(0, radius - edgeX);
      const cornerY = Math.max(0, radius - edgeY);
      const outsideRoundedCorner =
        radius > 0 && Math.hypot(cornerX, cornerY) > radius;
      const offset = (y * size + x) * 4;
      if (outsideRoundedCorner) continue;

      const glow = Math.max(
        0,
        1 - Math.hypot(x - size * 0.34, y - size * 0.18) / (size * 0.92),
      );
      const pixel = [9 + glow * 30, 11 + glow * 39, 16 + glow * 67, 255];
      const px = x / scale;
      const py = y / scale;
      const left = distanceToSegment(px, py, 116, 365, 256, 112) <= 29;
      const right = distanceToSegment(px, py, 256, 112, 396, 365) <= 29;
      const crossbar =
        insideTriangle(px, py, [190, 276], [322, 276], [307, 306]) && py >= 263;
      if (left || right || crossbar) {
        const gradient = Math.max(0, Math.min(1, (px + (512 - py)) / 1024));
        blend(pixel, [
          108 - gradient * 15,
          158 + gradient * 82,
          255 - gradient * 47,
          255,
        ]);
      }
      const waveY = 346 - 0.0009 * (px - 256) ** 2;
      if (px >= 142 && px <= 370 && Math.abs(py - waveY) <= 9)
        blend(pixel, [238, 248, 255, 255], 0.82);
      pixels[offset] = pixel[0];
      pixels[offset + 1] = pixel[1];
      pixels[offset + 2] = pixel[2];
      pixels[offset + 3] = pixel[3];
    }
  }

  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    scanlines[row] = 0;
    pixels.copy(scanlines, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const [name, size, maskable] of [
  ["aurora-192.png", 192, false],
  ["aurora-512.png", 512, false],
  ["aurora-maskable-512.png", 512, true],
  ["apple-touch-icon.png", 180, false],
]) {
  writeFileSync(resolve(outputDirectory, name), createIcon(size, maskable));
}
