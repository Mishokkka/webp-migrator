import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";

export function pngChunk(type, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const bytes = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, bytes, checksum]);
}

export function makePng(width = 2, height = 3, { animated = false, payload = 1 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunks = [pngChunk("IHDR", ihdr)];
  if (animated) {
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(1, 0);
    chunks.push(pngChunk("acTL", actl));
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(width, 4);
    fctl.writeUInt32BE(height, 8);
    fctl.writeUInt16BE(1, 20);
    fctl.writeUInt16BE(10, 22);
    chunks.push(pngChunk("fcTL", fctl));
  }
  const pixels = Buffer.alloc(height * (1 + width * 4), 0xff);
  for (let y = 0; y < height; y += 1) pixels[y * (1 + width * 4)] = 0;
  chunks.push(pngChunk("IDAT", deflateSync(pixels)));
  if (payload > 1) chunks.push(pngChunk("tEXt", Buffer.from(`padding\0${"x".repeat(payload)}`)));
  chunks.push(pngChunk("IEND"));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

export function webpChunk(type, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(type, "ascii"), length, data, Buffer.alloc(data.length % 2)]);
}

const webpCache = new Map();
export function makeWebp(width = 2, height = 3, { junk = 0 } = {}) {
  const key = `${width}x${height}`;
  if (!webpCache.has(key)) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fwm-image-fixture-"));
    try {
      const input = path.join(directory, "input.png");
      const output = path.join(directory, "output.webp");
      fs.writeFileSync(input, makePng(width, height));
      const result = spawnSync(process.env.FWM_CWEBP || "cwebp", ["-quiet", "-lossless", input, "-o", output], { encoding: "utf8", windowsHide: true });
      if (result.error || result.status !== 0) throw new Error(`Image tests require real libwebp tools on PATH (or FWM_CWEBP/FWM_DWEBP). ${result.error?.message ?? result.stderr}`);
      webpCache.set(key, fs.readFileSync(output));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  const bytes = Buffer.from(webpCache.get(key));
  if (!junk) return bytes;
  const output = Buffer.concat([bytes, webpChunk("JUNK", Buffer.alloc(junk, 0x55))]);
  output.writeUInt32LE(output.length - 8, 4);
  return output;
}

export function makeHeaderOnlyWebp(width = 64, height = 64) {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
  const data = Buffer.alloc(5);
  data[0] = 0x2f;
  data.writeUInt32LE(bits, 1);
  const payload = Buffer.concat([Buffer.from("WEBP"), webpChunk("VP8L", data)]);
  const header = Buffer.alloc(8);
  header.write("RIFF");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
