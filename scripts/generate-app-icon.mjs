import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const size = 256;
const pixels = Buffer.alloc(size * size * 4);

function mix(a, b, amount) {
  return a.map((value, index) => Math.round(value + (b[index] - value) * amount));
}

function setPixel(x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const index = (Math.floor(y) * size + Math.floor(x)) * 4;
  const alpha = color[3] / 255;
  pixels[index] = Math.round(color[0] * alpha + pixels[index] * (1 - alpha));
  pixels[index + 1] = Math.round(color[1] * alpha + pixels[index + 1] * (1 - alpha));
  pixels[index + 2] = Math.round(color[2] * alpha + pixels[index + 2] * (1 - alpha));
  pixels[index + 3] = Math.round(color[3] + pixels[index + 3] * (1 - alpha));
}

function roundedRect(x, y, width, height, radius, color) {
  for (let py = Math.floor(y); py < y + height; py += 1) {
    for (let px = Math.floor(x); px < x + width; px += 1) {
      const dx = Math.max(x + radius - px, 0, px - (x + width - radius));
      const dy = Math.max(y + radius - py, 0, py - (y + height - radius));
      if (dx * dx + dy * dy <= radius * radius) setPixel(px, py, color);
    }
  }
}

function line(x1, y1, x2, y2, width, color) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.ceil(length * 2);
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    for (let py = Math.floor(y - width / 2); py <= y + width / 2; py += 1) {
      for (let px = Math.floor(x - width / 2); px <= x + width / 2; px += 1) {
        if (Math.hypot(px - x, py - y) <= width / 2) setPixel(px, py, color);
      }
    }
  }
}

function arc(cx, cy, radius, start, end, width, color) {
  const steps = Math.ceil(Math.abs(end - start) * radius * 1.4);
  for (let step = 0; step <= steps; step += 1) {
    const angle = start + ((end - start) * step) / steps;
    line(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, cx + Math.cos(angle) * radius + 0.1, cy + Math.sin(angle) * radius + 0.1, width, color);
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return output;
}

function createPng() {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    rows[row] = 0;
    pixels.copy(rows, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const dark = [13, 15, 19, 255];
const blue = [104, 182, 255, 255];
const blueSoft = [166, 218, 255, 255];
const orange = [242, 164, 99, 255];
const orangeSoft = [255, 207, 160, 255];

roundedRect(0, 0, size, size, 54, dark);
for (let radius = 105; radius >= 42; radius -= 1) {
  const shade = Math.max(0, 1 - (105 - radius) / 70);
  arc(128, 128, radius, -0.73, 0.28, 1, [...mix([13, 15, 19], [22, 34, 49], shade), 55]);
}
arc(128, 128, 92, -2.5, -0.32, 6, blue);
arc(128, 128, 92, 0.64, 2.82, 6, orange);
arc(128, 128, 92, -0.35, 0.38, 3, blueSoft);
arc(128, 128, 92, 2.78, 3.52, 3, orangeSoft);

line(80, 86, 112, 128, 12, blue);
line(112, 128, 80, 170, 12, blueSoft);
line(142, 85, 142, 171, 11, orange);
line(181, 85, 181, 171, 11, orangeSoft);
line(142, 128, 181, 128, 11, orange);

const outputDir = path.resolve("assets");
await mkdir(outputDir, { recursive: true });
const png = createPng();
await writeFile(path.join(outputDir, "icon.png"), png);

const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
icoHeader[6] = 0;
icoHeader[7] = 0;
icoHeader[8] = 0;
icoHeader[9] = 0;
icoHeader.writeUInt16LE(1, 10);
icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(png.length, 14);
icoHeader.writeUInt32LE(22, 18);
await writeFile(path.join(outputDir, "icon.ico"), Buffer.concat([icoHeader, png]));
