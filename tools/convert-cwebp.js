#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { inflateSync } = require("zlib");

const TOOL_VERSION = "0.4.8";
const REPORT_SCHEMA_VERSION = 5;
const CONVERSION_SUCCESS = new Set(["converted", "exists", "exists-missing-old"]);
const HASH_RE = /^[a-f0-9]{64}$/i;
const FOUNDRY_V13_PUBLIC_DIRS = new Set(["cards", "css", "fonts", "icons", "lang", "scripts", "sounds", "ui"]);
const ARG_SPEC = Object.freeze({
  manifest: "value",
  audit: "value",
  cleanup: "value",
  restore: "value",
  data: "value",
  cwebp: "value",
  dwebp: "value",
  quality: "value",
  method: "value",
  out: "value",
  quarantine: "value",
  "world-id": "value",
  help: "boolean",
  lossless: "boolean",
  overwrite: "boolean",
  delete: "boolean",
  "permanent-delete": "boolean",
  "allow-larger": "boolean",
  "trust-existing": "boolean",
  "dry-run": "boolean",
  "include-local-paths": "boolean",
  "force-data-root": "boolean"
});

function isFoundryCorePublicPath(value) {
  let normalized = String(value ?? "").trim().replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  const first = normalized.split("/").find(Boolean)?.toLowerCase();
  return !!first && FOUNDRY_V13_PUBLIC_DIRS.has(first);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      if (index !== argv.length - 1) throw new Error(`Unexpected positional argument: ${argv[index + 1]}`);
      break;
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected positional argument: ${token}`);
    const equals = token.indexOf("=");
    const key = token.slice(2, equals < 0 ? undefined : equals);
    if (!Object.hasOwn(ARG_SPEC, key)) throw new Error(`Unknown option: --${key}`);
    if (Object.hasOwn(args, key)) throw new Error(`Option specified more than once: --${key}`);
    const kind = ARG_SPEC[key];
    if (kind === "boolean") {
      if (equals >= 0) throw new Error(`Boolean option --${key} does not accept a value.`);
      args[key] = true;
      continue;
    }
    if (equals >= 0) {
      const value = token.slice(equals + 1);
      if (!value) throw new Error(`Option --${key} requires a value.`);
      args[key] = value;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Option --${key} requires a value.`);
    args[key] = next;
    index += 1;
  }
  return args;
}

function printHelp() {
  console.log(`FBL WebP Migrator cwebp tool ${TOOL_VERSION}

Convert:
  node tools/convert-cwebp.js --manifest manifest.json --data "C:\\FoundryVTT\\Data" --cwebp "D:\\libwebp\\bin\\cwebp.exe" --quality 85

Consistency audit:
  node tools/convert-cwebp.js --audit manifest.json --data "C:\\FoundryVTT\\Data" --world-id "my-world"

Conversion preview:
  node tools/convert-cwebp.js --manifest manifest.json --data "C:\\FoundryVTT\\Data" --cwebp "D:\\libwebp\\bin\\cwebp.exe" --dry-run

Cleanup dry-run:
  node tools/convert-cwebp.js --cleanup migration-report.json --data "C:\\FoundryVTT\\Data"

Move verified PNG to quarantine:
  node tools/convert-cwebp.js --cleanup migration-report.json --data "C:\\FoundryVTT\\Data" --delete

Permanent deletion (not recoverable):
  node tools/convert-cwebp.js --cleanup migration-report.json --data "C:\\FoundryVTT\\Data" --delete --permanent-delete

Restore quarantined PNG:
  node tools/convert-cwebp.js --restore cleanup-report.json --data "C:\\FoundryVTT\\Data"

Options:
  --manifest <file>       Manifest exported by Foundry
  --audit <file>          Check PNG/WEBP references against files on disk
  --cleanup <file>        Migration report exported after Foundry updates
  --restore <file>        Cleanup report containing quarantined files
  --data <folder>         Foundry UserData/Data folder
  --cwebp <file>          Full path to cwebp.exe, or cwebp from PATH
  --dwebp <file>          Decoder (default: beside cwebp, or dwebp from PATH)
  --quality <1..100>      Lossy quality, default 85
  --method <0..6>         Compression method, default 6
  --lossless              Use lossless WebP
  --overwrite             Replace an existing WEBP
  --trust-existing        Accept an existing WEBP older than its PNG source
  --allow-larger          Accept WEBP files larger than their PNG source
  --dry-run               Preview any mode; never convert, move, or delete assets
  --delete                During cleanup, move PNG to quarantine
  --permanent-delete      With --delete, unlink PNG instead of quarantine
  --quarantine <folder>   Relative folder inside Data for quarantined PNG
  --world-id <id>         Require manifest/report to match this world ID
  --force-data-root       Override Data-root/world binding checks (dangerous)
  --include-local-paths   Include absolute local paths in generated reports
  --out <file>            Explicit report path
  --help                  Show this help

Safety:
  - --audit only reads and reports files; it never converts, moves, or deletes them.
  - Strict argument parsing rejects unknown options and values for boolean flags.
  - APNG is rejected before existing-WEBP handling.
  - PNG and WEBP must fully decode; dimensions and hashes are rechecked.
  - Symlinks and junction-like path escapes below Data are rejected.
  - Cleanup uses only the concrete file list recorded during conversion.
  - Source and target SHA-256 hashes must still match before cleanup.
  - --delete quarantines files by default; permanent deletion needs a second flag.`);
}

function fail(message, code = 1) {
  console.error(`ERROR: ${message}`);
  process.exit(code);
}

function readJson(file) {
  const absolute = path.resolve(file);
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

function writeJson(file, data) {
  const absolute = path.resolve(file);
  const directory = path.dirname(absolute);
  // On Windows, fs.mkdirSync("D:\\", {recursive:true}) can throw EPERM even
  // though the drive root already exists. Only create a parent directory when
  // it is actually missing. This also keeps root-level --out paths valid.
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(absolute, JSON.stringify(data, null, 2), "utf8");
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizeForHash(value) {
  const text = process.platform === "win32" ? value.toLowerCase() : value;
  return text.replace(/\\/g, "/");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    do {
      bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes) hash.update(buffer.subarray(0, bytes));
    } while (bytes);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function validateDataRoot(input) {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) throw new Error(`Data root does not exist: ${resolved}`);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`--data must point to a folder: ${resolved}`);
  const real = fs.realpathSync.native(resolved);
  return {
    resolved,
    real,
    id: `sha256:${sha256Text(normalizeForHash(real))}`
  };
}

function normalizeRelativePath(value) {
  const original = String(value ?? "");
  if (!original || original.length > 4096 || original.includes("\0")) throw new Error(`Invalid local path: ${original}`);
  if (/^(?:https?:|data:|blob:|file:|ftp:|s3:)/i.test(original)) throw new Error(`Not a local Foundry Data path: ${original}`);
  if (/^(?:[a-z]:[\\/]|[a-z]:(?![\\/])|[\\/]{2})/i.test(original)) throw new Error(`Absolute, drive-relative, or UNC path is not allowed: ${original}`);

  let relative = original.replace(/\\/g, "/").replace(/^\/+/, "");
  while (relative.startsWith("./")) relative = relative.slice(2);
  relative = relative.replace(/\/{2,}/g, "/");
  const segments = [];
  for (const segment of relative.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." || segment === "__proto__" || segment === "prototype" || segment === "constructor" || /^[a-z]:$/i.test(segment)) {
      throw new Error(`Unsafe relative path: ${original}`);
    }
    segments.push(segment);
  }
  if (!segments.length) throw new Error(`Empty relative path: ${original}`);
  return segments.join("/");
}

function normalizeRelativeDirectory(value) {
  const normalized = normalizeRelativePath(value);
  if (/[*?]/.test(normalized)) throw new Error(`Wildcards are not allowed in directory paths: ${value}`);
  return normalized.replace(/\/+$/, "");
}

function insideRoot(root, absolute) {
  const relative = path.relative(root.real, absolute);
  if (process.platform === "win32") {
    const lower = relative.toLowerCase();
    return lower === "" || (!lower.startsWith("..") && !path.isAbsolute(relative));
  }
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertNoSymlinkPath(root, absolute, { allowMissingLeaf = false } = {}) {
  if (!insideRoot(root, absolute)) throw new Error(`Path escapes Data root: ${absolute}`);
  const relative = path.relative(root.real, absolute);
  const segments = relative ? relative.split(path.sep) : [];
  let current = root.real;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    if (!fs.existsSync(current)) {
      if (allowMissingLeaf) break;
      throw new Error(`Path does not exist: ${current}`);
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Symlink or junction path is not allowed below Data: ${current}`);
  }
  const existing = fs.existsSync(absolute) ? absolute : path.dirname(absolute);
  if (fs.existsSync(existing)) {
    const real = fs.realpathSync.native(existing);
    if (!insideRoot(root, real)) throw new Error(`Real path escapes Data root: ${absolute}`);
  }
}

function toAbsolute(root, relative, { allowMissingLeaf = false } = {}) {
  const normalized = normalizeRelativePath(relative);
  const absolute = path.resolve(root.real, ...normalized.split("/"));
  if (!insideRoot(root, absolute)) throw new Error(`Path escapes Data root: ${relative}`);
  assertNoSymlinkPath(root, absolute, { allowMissingLeaf });
  return absolute;
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function readExact(fd, length, position) {
  const buffer = Buffer.alloc(length);
  const bytes = fs.readSync(fd, buffer, 0, length, position);
  return bytes === length ? buffer : null;
}

let decoderCommands = null;

function defaultDecoders(args = {}) {
  const cwebp = String(args.cwebp || process.env.FWM_CWEBP || "cwebp");
  const sibling = /[\\/]/.test(cwebp) ? path.join(path.dirname(cwebp), process.platform === "win32" ? "dwebp.exe" : "dwebp") : "dwebp";
  return { cwebp, dwebp: String(args.dwebp || process.env.FWM_DWEBP || sibling) };
}

function configureDecoders(args = {}) {
  const commands = defaultDecoders(args);
  for (const [name, command] of Object.entries(commands)) {
    const probe = spawnSync(command, ["-version"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    if (probe.error || probe.status !== 0) throw new Error(`${name} is unavailable: ${command}. Supply --${name} or add libwebp to PATH. ${probe.error?.message ?? probe.stderr ?? ""}`);
  }
  decoderCommands = commands;
  return commands;
}

function decodeImage(file, format) {
  const commands = decoderCommands ?? defaultDecoders();
  const sink = process.platform === "win32" ? "NUL" : "/dev/null";
  const command = format === "png" ? commands.cwebp : commands.dwebp;
  // PPM avoids Windows WIC's seekable-output requirement when writing to NUL.
  const args = format === "png" ? ["-quiet", "-q", "0", "-m", "0", file, "-o", sink] : [file, "-quiet", "-ppm", "-o", sink];
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
  if (result.error || result.signal) {
    const error = new Error(`Cannot validate ${format.toUpperCase()} with ${command}: ${result.error?.message ?? result.signal}`);
    error.decoderUnavailable = true;
    throw error;
  }
  return { valid: result.status === 0, error: result.status === 0 ? undefined : (result.stderr || "Image decoder rejected the file.").trim() };
}

const MAX_PNG_DECODE_BYTES = 512 * 1024 * 1024;
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function pngCrc(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePngPixels(ihdr, idat) {
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const color = ihdr[9];
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[color];
  if (!channels || !depths.includes(depth) || ihdr[10] !== 0 || ihdr[11] !== 0 || ihdr[12] > 1) throw new Error("Invalid PNG color, depth, compression or interlace method.");
  const passes = ihdr[12] === 0 ? [[0, 0, 1, 1]] : [
    [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]
  ];
  const rows = passes.map(([x, y, dx, dy]) => {
    const columns = Math.max(0, Math.ceil((width - x) / dx));
    const count = Math.max(0, Math.ceil((height - y) / dy));
    return { count: columns ? count : 0, stride: 1 + Math.ceil(columns * channels * depth / 8) };
  });
  const expected = rows.reduce((sum, row) => sum + row.count * row.stride, 0);
  if (!expected || expected > MAX_PNG_DECODE_BYTES) throw new Error("PNG validation exceeds the 512 MiB decoded-data limit.");
  const pixels = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (pixels.length !== expected) throw new Error("PNG image data is incomplete or exceeds its declared dimensions.");
  let position = 0;
  for (const { count, stride } of rows) {
    for (let row = 0; row < count; row += 1, position += stride) {
      if (pixels[position] > 4) throw new Error("PNG contains an invalid row filter.");
    }
  }
}

function inspectPng(file) {
  let fd;
  let animated = false;
  const invalid = (error, animated = false) => ({ valid: false, animated, error });
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return invalid("Source path is not a regular file.");
    if (stat.size < 45) return invalid("File is too small to be a complete PNG.");
    fd = fs.openSync(file, "r");
    const signature = readExact(fd, 8, 0);
    const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!signature?.equals(expected)) return invalid("File has a .png path but does not contain a PNG signature.");

    let position = 8;
    let width = null;
    let height = null;
    let sawIhdr = false;
    let sawIdat = false;
    let sawIend = false;
    let ihdr = null;
    const idat = [];
    while (position + 12 <= stat.size) {
      const header = readExact(fd, 8, position);
      if (!header) return invalid("PNG chunk header is truncated.", animated);
      const length = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      const end = position + 12 + length;
      if (end > stat.size) return invalid(`PNG chunk ${type || "<unknown>"} is truncated.`, animated);
      if (length > MAX_PNG_DECODE_BYTES) return invalid("PNG chunk exceeds validation memory limit.", animated);
      const chunk = readExact(fd, length + 4, position + 4);
      const checksum = readExact(fd, 4, position + 8 + length);
      if (!chunk || !checksum || pngCrc(chunk) !== checksum.readUInt32BE(0)) return invalid(`PNG chunk ${type} has an invalid CRC.`, animated);
      if (!sawIhdr && type !== "IHDR") return invalid("PNG does not start with an IHDR chunk.", animated);
      if (type === "IHDR") {
        if (sawIhdr || length !== 13) return invalid("PNG contains an invalid IHDR chunk.", animated);
        const data = readExact(fd, 13, position + 8);
        if (!data) return invalid("PNG IHDR data is truncated.", animated);
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        ihdr = data;
        sawIhdr = true;
      } else if (type === "acTL") animated = true;
      else if (type === "IDAT") { sawIdat = true; idat.push(chunk.subarray(4)); }
      else if (type === "IEND") {
        if (length !== 0) return invalid("PNG contains an invalid IEND chunk.", animated);
        sawIend = true;
        position = end;
        break;
      }
      position = end;
    }
    if (!width || !height || !sawIhdr) return invalid("PNG is missing valid dimensions or IHDR metadata.", animated);
    if (!sawIdat) return invalid("PNG does not contain image data (IDAT).", animated);
    if (!sawIend) return invalid("PNG does not contain a complete IEND chunk.", animated);

    // Some otherwise decodable PNG files contain harmless bytes after IEND.
    // cwebp/libpng tolerate these in practice, and rejecting them during a
    // dry-run creates false negatives even though conversion succeeds. The
    // complete file is still fingerprinted for cleanup safety.
    // Windows WIC may accept truncated IDAT streams. Check CRCs, inflate length
    // and row filters independently before asking the platform decoder to read.
    validatePngPixels(ihdr, idat);
    const decoded = decodeImage(file, "png");
    return { ...decoded, decoded: decoded.valid, width, height, animated };
  } catch (error) {
    if (error.decoderUnavailable) throw error;
    return invalid(error?.message ?? String(error), animated);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function inspectWebp(file) {
  let fd;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 20) return { valid: false };
    fd = fs.openSync(file, "r");
    const header = readExact(fd, 12, 0);
    if (!header || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WEBP") return { valid: false };
    if (header.readUInt32LE(4) + 8 !== stat.size) return { valid: false };

    let position = 12;
    let width = null;
    let height = null;
    let animated = false;
    let imageChunk = null;
    while (position + 8 <= stat.size) {
      const chunkHeader = readExact(fd, 8, position);
      if (!chunkHeader) return { valid: false };
      const type = chunkHeader.toString("ascii", 0, 4);
      const length = chunkHeader.readUInt32LE(4);
      const dataPosition = position + 8;
      const paddedLength = length + (length % 2);
      if (dataPosition + paddedLength > stat.size) return { valid: false };

      if (type === "VP8X") {
        const data = readExact(fd, Math.min(length, 10), dataPosition);
        if (!data || data.length < 10) return { valid: false };
        animated = !!(data[0] & 0x02);
        width = 1 + data.readUIntLE(4, 3);
        height = 1 + data.readUIntLE(7, 3);
      } else if (type === "VP8L") {
        const data = readExact(fd, Math.min(length, 5), dataPosition);
        if (!data || data.length < 5 || data[0] !== 0x2f) return { valid: false };
        width = 1 + (data[1] | ((data[2] & 0x3f) << 8));
        height = 1 + ((data[2] >> 6) | (data[3] << 2) | ((data[4] & 0x0f) << 10));
        imageChunk = "VP8L";
      } else if (type === "VP8 ") {
        const data = readExact(fd, Math.min(length, 10), dataPosition);
        if (!data || data.length < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) return { valid: false };
        width = data.readUInt16LE(6) & 0x3fff;
        height = data.readUInt16LE(8) & 0x3fff;
        imageChunk = "VP8";
      } else if (type === "ANIM" || type === "ANMF") animated = true;

      position = dataPosition + paddedLength;
    }
    if (!(width && height && imageChunk && !animated && position === stat.size)) return { valid: false, width, height, animated, imageChunk };
    const decoded = decodeImage(file, "webp");
    return { ...decoded, decoded: decoded.valid, width, height, animated, imageChunk };
  } catch (error) {
    if (error.decoderUnavailable) throw error;
    return { valid: false };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isValidWebp(file) {
  return inspectWebp(file).valid;
}

function isAnimatedPng(file) {
  return inspectPng(file).animated;
}

function globToRegExp(pattern) {
  let output = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        output += ".*";
        index += 1;
      } else output += "[^/]*";
    } else if (char === "?") output += "[^/]";
    else output += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  output += "$";
  return new RegExp(output, process.platform === "win32" ? "i" : "");
}

function walkFiles(root, folder, output) {
  if (!fs.existsSync(folder)) return;
  assertNoSymlinkPath(root, folder);
  for (const dirent of fs.readdirSync(folder, { withFileTypes: true })) {
    const absolute = path.join(folder, dirent.name);
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) walkFiles(root, absolute, output);
    else if (dirent.isFile()) output.push(absolute);
  }
}

function listFiles(root, folder, cache) {
  const key = normalizeForHash(folder);
  if (cache?.has(key)) return cache.get(key);
  const output = [];
  walkFiles(root, folder, output);
  if (cache) cache.set(key, output);
  return output;
}

function expandPattern(root, pattern, { cache = null } = {}) {
  const relativePattern = normalizeRelativePath(pattern);
  if (!/[*?]/.test(relativePattern)) {
    const absolute = toAbsolute(root, relativePattern, { allowMissingLeaf: true });
    return fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? [relativePattern] : [];
  }

  const firstWildcard = relativePattern.search(/[*?]/);
  const slash = relativePattern.lastIndexOf("/", firstWildcard);
  const baseRelative = slash >= 0 ? relativePattern.slice(0, slash) : "";
  const baseAbsolute = baseRelative ? toAbsolute(root, baseRelative, { allowMissingLeaf: true }) : root.real;
  if (!fs.existsSync(baseAbsolute) || !fs.statSync(baseAbsolute).isDirectory()) return [];
  const candidates = listFiles(root, baseAbsolute, cache);
  const regex = globToRegExp(relativePattern);
  return candidates
    .map((absolute) => path.relative(root.real, absolute).split(path.sep).join("/"))
    .filter((relative) => regex.test(relative))
    .sort((a, b) => a.localeCompare(b));
}

function pngToWebp(relative) {
  if (!/\.png$/i.test(relative)) throw new Error(`PNG extension expected: ${relative}`);
  return relative.replace(/\.png$/i, ".webp");
}

function runCwebp({ cwebp, input, output, quality, method, lossless }) {
  const args = lossless
    ? ["-lossless", "-exact", "-q", String(quality), "-m", String(method), "-mt", input, "-o", output]
    : ["-q", String(quality), "-m", String(method), "-alpha_q", "100", "-mt", input, "-o", output];
  const result = spawnSync(cwebp, args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `cwebp exited with ${result.status}`).trim());
}

function atomicConvert({ root, cwebp, oldAbs, newAbs, quality, method, lossless, overwrite, runner = runCwebp, validateTemp = null }) {
  const nonce = `${process.pid}-${crypto.randomUUID()}`;
  const temp = `${newAbs}.fwm-${nonce}.tmp.webp`;
  const backup = `${newAbs}.fwm-${nonce}.backup.webp`;
  let movedExisting = false;
  try {
    fs.mkdirSync(path.dirname(newAbs), { recursive: true });
    assertNoSymlinkPath(root, path.dirname(newAbs));
    runner({ cwebp, input: oldAbs, output: temp, quality, method, lossless });
    assertNoSymlinkPath(root, temp);
    if (!isValidWebp(temp)) throw new Error("cwebp output is missing or is not a structurally valid static WEBP.");
    if (typeof validateTemp === "function") validateTemp(temp);
    if (fs.existsSync(newAbs)) {
      if (!overwrite) throw new Error("WEBP already exists and --overwrite was not specified.");
      fs.renameSync(newAbs, backup);
      movedExisting = true;
    }
    try {
      fs.renameSync(temp, newAbs);
    } catch (error) {
      if (movedExisting && fs.existsSync(backup) && !fs.existsSync(newAbs)) fs.renameSync(backup, newAbs);
      movedExisting = false;
      throw error;
    }
    if (movedExisting && fs.existsSync(backup)) fs.rmSync(backup, { force: true });
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    if (fs.existsSync(backup) && fs.existsSync(newAbs)) fs.rmSync(backup, { force: true });
    if (fs.existsSync(backup) && !fs.existsSync(newAbs)) fs.renameSync(backup, newAbs);
  }
}

function percent(oldSize, newSize) {
  if (!Number.isFinite(oldSize) || !Number.isFinite(newSize) || oldSize <= 0) return null;
  return Number((((oldSize - newSize) / oldSize) * 100).toFixed(2));
}

function fingerprintFile(file, prefix, inspection = {}) {
  const stat = fs.statSync(file);
  return {
    [`${prefix}Size`]: stat.size,
    [`${prefix}MtimeMs`]: stat.mtimeMs,
    [`${prefix}Sha256`]: sha256File(file),
    [`${prefix}Width`]: inspection.width ?? null,
    [`${prefix}Height`]: inspection.height ?? null
  };
}

function makeConcreteResult(relativeOld, relativeNew, status, oldAbs, newAbs, pngInfo, webpInfo, extra = {}) {
  return {
    oldPath: relativeOld,
    newPath: relativeNew,
    status,
    ...(oldAbs && fs.existsSync(oldAbs) ? fingerprintFile(oldAbs, "old", pngInfo) : {
      oldSize: null, oldMtimeMs: null, oldSha256: null, oldWidth: null, oldHeight: null
    }),
    ...(newAbs && fs.existsSync(newAbs) ? fingerprintFile(newAbs, "new", webpInfo) : {
      newSize: null, newMtimeMs: null, newSha256: null, newWidth: null, newHeight: null
    }),
    sourceAnimated: pngInfo?.animated === true,
    decoderVerified: webpInfo?.decoded === true && (status === "exists-missing-old" || pngInfo?.decoded === true),
    savedPercent: percent(oldAbs ? fileSize(oldAbs) : null, newAbs ? fileSize(newAbs) : null),
    ...extra
  };
}

function convertConcrete(root, relativeOld, options) {
  const oldAbs = toAbsolute(root, relativeOld, { allowMissingLeaf: true });
  const relativeNew = pngToWebp(relativeOld);
  const newAbs = toAbsolute(root, relativeNew, { allowMissingLeaf: true });
  const oldExists = fs.existsSync(oldAbs);
  const newExists = fs.existsSync(newAbs);

  if (!oldExists) {
    if (newExists) {
      const webpInfo = inspectWebp(newAbs);
      if (webpInfo.valid) return makeConcreteResult(relativeOld, relativeNew, "exists-missing-old", null, newAbs, null, webpInfo, { provenance: "existing" });
    }
    return { oldPath: relativeOld, newPath: relativeNew, status: "failed", error: `PNG is missing under the selected --data root and no valid WEBP exists: ${relativeOld}` };
  }

  const pngInfo = inspectPng(oldAbs);
  if (!pngInfo.valid) return { oldPath: relativeOld, newPath: relativeNew, status: "failed", error: `Source file is not a valid PNG: ${pngInfo.error ?? "unknown PNG validation error"}` };
  if (pngInfo.animated) return makeConcreteResult(relativeOld, relativeNew, "skipped", oldAbs, newExists ? newAbs : null, pngInfo, newExists ? inspectWebp(newAbs) : null, {
    error: "APNG detected. Static cwebp conversion would discard animation."
  });

  if (newExists && !options.overwrite) {
    const webpInfo = inspectWebp(newAbs);
    if (!webpInfo.valid) return makeConcreteResult(relativeOld, relativeNew, "failed", oldAbs, newAbs, pngInfo, webpInfo, { error: "Existing WEBP is invalid. Use --overwrite to replace it." });
    if (webpInfo.width !== pngInfo.width || webpInfo.height !== pngInfo.height) {
      return makeConcreteResult(relativeOld, relativeNew, "failed", oldAbs, newAbs, pngInfo, webpInfo, { error: "Existing WEBP dimensions do not match the PNG source." });
    }
    const oldStat = fs.statSync(oldAbs);
    const newStat = fs.statSync(newAbs);
    if (!options.trustExisting && newStat.mtimeMs + 1 < oldStat.mtimeMs) {
      return makeConcreteResult(relativeOld, relativeNew, "failed", oldAbs, newAbs, pngInfo, webpInfo, { error: "Existing WEBP is older than the PNG source. Use --overwrite or --trust-existing after manual verification." });
    }
    const status = newStat.size > oldStat.size && !options.allowLarger ? "larger" : "exists";
    return makeConcreteResult(relativeOld, relativeNew, status, oldAbs, newAbs, pngInfo, webpInfo, {
      provenance: "existing",
      error: status === "larger" ? "WEBP is larger than PNG. Use --allow-larger to accept it." : undefined
    });
  }

  if (options.dryRun) return makeConcreteResult(relativeOld, relativeNew, "would-convert", oldAbs, newExists ? newAbs : null, pngInfo, newExists ? inspectWebp(newAbs) : null);

  atomicConvert({
    root,
    cwebp: options.cwebp,
    oldAbs,
    newAbs,
    quality: options.quality,
    method: options.method,
    lossless: options.lossless,
    overwrite: options.overwrite,
    runner: options.runner,
    validateTemp: (temp) => {
      const tempInfo = inspectWebp(temp);
      if (!tempInfo.valid) throw new Error("Converted WEBP failed structural validation.");
      if (tempInfo.width !== pngInfo.width || tempInfo.height !== pngInfo.height) throw new Error("Converted WEBP dimensions do not match the PNG source.");
      if (!options.allowLarger && fileSize(temp) > fileSize(oldAbs)) throw new Error("Converted WEBP is larger than the PNG source. Use --allow-larger to accept it.");
    }
  });
  const webpInfo = inspectWebp(newAbs);
  if (!webpInfo.valid) throw new Error("Converted WEBP failed structural validation.");
  if (webpInfo.width !== pngInfo.width || webpInfo.height !== pngInfo.height) throw new Error("Converted WEBP dimensions do not match the PNG source.");
  return makeConcreteResult(relativeOld, relativeNew, "converted", oldAbs, newAbs, pngInfo, webpInfo, {
    provenance: "converted"
  });
}

function aggregateEntryStatus(files) {
  if (!files.length) return "failed";
  if (files.every((file) => file.status === "skipped")) return "skipped";
  if (files.every((file) => file.status === "would-convert")) return "would-convert";
  if (files.some((file) => file.status === "failed" || file.status === "skipped")) return "failed";
  if (files.some((file) => file.status === "larger")) return "larger";
  if (files.some((file) => file.status === "converted")) return "converted";
  if (files.every((file) => file.status === "exists-missing-old")) return "exists-missing-old";
  return "exists";
}

function convertManifestEntry(root, entry, options, walkCache = new Map()) {
  const oldPattern = normalizeRelativePath(entry.oldPath);
  const newPattern = normalizeRelativePath(entry.newPath);
  const expectedNew = pngToWebp(oldPattern);
  if (normalizeForHash(newPattern) !== normalizeForHash(expectedNew)) throw new Error(`newPath must be the exact .webp counterpart of oldPath: ${entry.oldPath}`);
  const oldFiles = expandPattern(root, oldPattern, { cache: walkCache }).filter((file) => /\.png$/i.test(file));
  const children = [];

  if (!oldFiles.length && /[*?]/.test(oldPattern)) {
    const existingWebp = expandPattern(root, newPattern).filter((file) => /\.webp$/i.test(file));
    for (const relativeNew of existingWebp) {
      const relativeOld = relativeNew.replace(/\.webp$/i, ".png");
      const newAbs = toAbsolute(root, relativeNew);
      const webpInfo = inspectWebp(newAbs);
      children.push(webpInfo.valid
        ? makeConcreteResult(relativeOld, relativeNew, "exists-missing-old", null, newAbs, null, webpInfo, { provenance: "existing" })
        : { oldPath: relativeOld, newPath: relativeNew, status: "failed", error: "Existing WEBP is invalid." });
    }
  } else {
    for (const relativeOld of oldFiles) children.push(convertConcrete(root, relativeOld, options));
  }

  if (!children.length && !/[*?]/.test(oldPattern)) children.push(convertConcrete(root, oldPattern, options));
  const status = aggregateEntryStatus(children);
  const oldSizes = children.filter((file) => Number.isFinite(file.oldSize));
  const newSizes = children.filter((file) => Number.isFinite(file.newSize));
  const oldSize = oldSizes.length ? oldSizes.reduce((sum, file) => sum + file.oldSize, 0) : null;
  const newSize = newSizes.length ? newSizes.reduce((sum, file) => sum + file.newSize, 0) : null;
  return {
    oldPath: oldPattern,
    newPath: newPattern,
    wildcard: /[*?]/.test(oldPattern),
    status,
    verified: CONVERSION_SUCCESS.has(status),
    oldSize,
    newSize,
    savedPercent: percent(oldSize, newSize),
    files: children,
    error: ["failed", "larger"].includes(status) ? "One or more concrete files were not accepted." : undefined
  };
}

function uniqueEntries(entries) {
  const map = new Map();
  for (const entry of entries ?? []) {
    if (!entry?.oldPath || !entry?.newPath) continue;
    const oldPath = normalizeRelativePath(entry.oldPath);
    const newPath = normalizeRelativePath(entry.newPath);
    if (isFoundryCorePublicPath(oldPath) || isFoundryCorePublicPath(newPath)) continue;
    if (normalizeForHash(pngToWebp(oldPath)) !== normalizeForHash(newPath)) {
      throw new Error(`Invalid oldPath/newPath pair: ${entry.oldPath} -> ${entry.newPath}`);
    }
    const key = oldPath;
    const existing = map.get(key);
    if (existing && normalizeForHash(existing.newPath) !== normalizeForHash(newPath)) {
      throw new Error(`Conflicting duplicate manifest path: ${oldPath}`);
    }
    if (!existing) map.set(key, { oldPath, newPath });
  }
  return [...map.values()];
}

function uniqueAuditEntries(manifest) {
  const map = new Map();
  const add = (entries, format) => {
    for (const input of entries ?? []) {
      if (!input?.oldPath || !input?.newPath) continue;
      const oldPath = normalizeRelativePath(input.oldPath);
      const newPath = normalizeRelativePath(input.newPath);
      if (isFoundryCorePublicPath(oldPath) || isFoundryCorePublicPath(newPath)) continue;
      if (normalizeForHash(pngToWebp(oldPath)) !== normalizeForHash(newPath)) {
        throw new Error(`Invalid oldPath/newPath pair: ${input.oldPath} -> ${input.newPath}`);
      }
      const key = normalizeForHash(oldPath);
      if (!map.has(key)) {
        map.set(key, {
          oldPath,
          newPath,
          wildcard: /[*?]/.test(oldPath),
          pngRefCount: 0,
          webpRefCount: 0
        });
      }
      const pair = map.get(key);
      if (normalizeForHash(pair.newPath) !== normalizeForHash(newPath)) throw new Error(`Conflicting manifest pair: ${oldPath}`);
      const count = Array.isArray(input.refs) ? input.refs.length : 0;
      if (format === "webp") pair.webpRefCount += count;
      else pair.pngRefCount += count;
    }
  };
  add(manifest.entries, "png");
  add(manifest.webpEntries, "webp");
  return [...map.values()].sort((a, b) => a.oldPath.localeCompare(b.oldPath));
}

function auditFileState(root, relative, format) {
  const absolute = toAbsolute(root, relative, { allowMissingLeaf: true });
  if (!fs.existsSync(absolute)) {
    return { exists: false, valid: false, animated: false, width: null, height: null, size: null, mtimeMs: null, sha256: null };
  }
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) {
    return { exists: true, valid: false, checked: true, animated: false, width: null, height: null, size: stat.size, mtimeMs: stat.mtimeMs, sha256: null, error: "Path is not a regular file." };
  }
  const inspection = format === "png" ? inspectPng(absolute) : inspectWebp(absolute);
  return {
    exists: true,
    valid: inspection.valid === true,
    checked: true,
    decoded: inspection.decoded === true,
    animated: format === "png" && inspection.animated === true,
    width: inspection.width ?? null,
    height: inspection.height ?? null,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: sha256File(absolute),
    error: inspection.valid === true ? undefined : `File is not a valid ${format.toUpperCase()} image.`
  };
}

function auditDimensionsMatch(file) {
  if (!file.png.valid || !file.webp.valid) return null;
  return file.png.width === file.webp.width && file.png.height === file.webp.height;
}

function auditCategory(file) {
  const { png, webp } = file;
  if (!png.exists && !webp.exists) return "both-missing";
  if (png.exists && !png.valid && webp.exists && !webp.valid) return "both-invalid";
  if (png.exists && !png.valid) return webp.valid ? "invalid-png-valid-webp" : "invalid-png";
  if (webp.exists && !webp.valid) return png.valid ? "valid-png-invalid-webp" : "invalid-webp";
  if (png.valid && webp.valid) {
    if (png.animated) return "apng-and-webp";
    return auditDimensionsMatch(file) ? "both-valid" : "dimension-mismatch";
  }
  if (png.valid) return "png-only";
  if (webp.valid) return "webp-only";
  return "unresolved";
}

function auditForwardSafe(file) {
  if (!file.webp.valid || file.png.animated) return false;
  if (!file.png.valid) return true;
  return auditDimensionsMatch(file) === true && file.webp.mtimeMs + 1 >= file.png.mtimeMs;
}

function auditReverseSafe(file) {
  return file.png.valid === true && file.webp.valid !== true;
}

function auditConcrete(root, oldPath, newPath) {
  const file = {
    oldPath,
    newPath,
    png: auditFileState(root, oldPath, "png"),
    webp: auditFileState(root, newPath, "webp")
  };
  file.dimensionsMatch = auditDimensionsMatch(file);
  file.category = auditCategory(file);
  file.forwardSafe = auditForwardSafe(file);
  file.reverseSafe = auditReverseSafe(file);
  return file;
}

function auditManifestEntry(root, entry, walkCache = new Map()) {
  const oldPattern = normalizeRelativePath(entry.oldPath);
  const newPattern = normalizeRelativePath(entry.newPath);
  const concrete = new Map();
  if (/[*?]/.test(oldPattern)) {
    for (const oldPath of expandPattern(root, oldPattern, { cache: walkCache }).filter((value) => /\.png$/i.test(value))) {
      concrete.set(normalizeForHash(oldPath), { oldPath, newPath: pngToWebp(oldPath) });
    }
    for (const newPath of expandPattern(root, newPattern, { cache: walkCache }).filter((value) => /\.webp$/i.test(value))) {
      const oldPath = newPath.replace(/\.webp$/i, ".png");
      const key = normalizeForHash(oldPath);
      const existing = concrete.get(key);
      concrete.set(key, { oldPath: existing?.oldPath ?? oldPath, newPath });
    }
  } else {
    concrete.set(normalizeForHash(oldPattern), { oldPath: oldPattern, newPath: newPattern });
  }
  const files = [...concrete.values()].sort((a, b) => a.oldPath.localeCompare(b.oldPath)).map((file) => auditConcrete(root, file.oldPath, file.newPath));
  const forwardAuthorized = entry.pngRefCount > 0 && files.length > 0 && files.every(auditForwardSafe);
  const reverseAuthorized = entry.webpRefCount > 0 && files.length > 0 && files.every(auditReverseSafe);
  const placeholderAuthorized = !entry.wildcard
    && (entry.pngRefCount + entry.webpRefCount) > 0
    && files.length > 0
    && files.every((file) => file.category === "both-missing");
  const currentPngValid = entry.pngRefCount === 0 || (files.length > 0 && files.every((file) => file.png.valid));
  const currentWebpValid = entry.webpRefCount === 0 || (files.length > 0 && files.every((file) => file.webp.valid));
  const status = forwardAuthorized
      ? "repair-to-webp"
      : reverseAuthorized
        ? "repair-to-png"
        : placeholderAuthorized
          ? "repair-to-placeholder"
          : currentPngValid && currentWebpValid
            ? "consistent"
            : "unresolved";
  return { ...entry, status, forwardAuthorized, reverseAuthorized, placeholderAuthorized, files };
}

function summarizeAudit(entries) {
  const files = entries.flatMap((entry) => entry.files ?? []);
  const categories = {};
  for (const file of files) categories[file.category] = (categories[file.category] ?? 0) + 1;
  return {
    pairs: entries.length,
    concreteFiles: files.length,
    pngReferences: entries.reduce((sum, entry) => sum + entry.pngRefCount, 0),
    webpReferences: entries.reduce((sum, entry) => sum + entry.webpRefCount, 0),
    forwardRepairPaths: entries.filter((entry) => entry.forwardAuthorized).length,
    reverseRepairPaths: entries.filter((entry) => entry.reverseAuthorized).length,
    placeholderRepairPaths: entries.filter((entry) => entry.placeholderAuthorized).length,
    consistentPaths: entries.filter((entry) => entry.status === "consistent").length,
    unresolvedPaths: entries.filter((entry) => entry.status === "unresolved" || entry.status === "conflict").length,
    categories
  };
}

function summarizeConversion(entries) {
  const summary = {
    input: entries.length,
    converted: entries.filter((entry) => entry.status === "converted").length,
    exists: entries.filter((entry) => entry.status === "exists").length,
    existsMissingOld: entries.filter((entry) => entry.status === "exists-missing-old").length,
    wouldConvert: entries.filter((entry) => entry.status === "would-convert").length,
    larger: entries.filter((entry) => entry.status === "larger").length,
    failed: entries.filter((entry) => entry.status === "failed").length,
    skipped: entries.filter((entry) => entry.status === "skipped").length,
    concreteFiles: entries.flatMap((entry) => entry.files ?? []).length,
    cleanupEligibleFiles: entries.flatMap((entry) => entry.files ?? []).filter((file) => ["converted", "exists"].includes(file.status)).length,
    totalOldSize: 0,
    totalNewSize: 0,
    totalSavedBytes: 0,
    totalSavedPercent: 0
  };
  for (const entry of entries) {
    if (!Number.isFinite(entry.oldSize) || !Number.isFinite(entry.newSize)) continue;
    summary.totalOldSize += entry.oldSize;
    summary.totalNewSize += entry.newSize;
  }
  summary.totalSavedBytes = summary.totalOldSize - summary.totalNewSize;
  summary.totalSavedPercent = summary.totalOldSize > 0 ? Number(((summary.totalSavedBytes / summary.totalOldSize) * 100).toFixed(2)) : 0;
  return summary;
}

function reportLocalPath(include, value) {
  return include ? value : undefined;
}

function convert(args) {
  if (!args.manifest) throw new Error("--manifest is required.");
  if (!args.data) throw new Error("--data is required.");
  const manifestPath = path.resolve(args.manifest);
  const manifest = readJson(manifestPath);
  if (manifest.type !== "fbl-webp-migrator-manifest") throw new Error("Input is not a FBL WebP Migrator manifest.");
  if (!manifest.manifestId) throw new Error("Manifest is obsolete and has no manifestId. Rescan with module 0.3.0 or newer.");

  const root = validateDataRoot(args.data);
  if (args["world-id"] && manifest.worldId !== args["world-id"]) {
    throw new Error(`Manifest worldId ${manifest.worldId ?? "<none>"} does not match --world-id ${args["world-id"]}.`);
  }
  if (!args["force-data-root"] && manifest.worldId) {
    const worldRelative = normalizeRelativeDirectory(`worlds/${manifest.worldId}`);
    const worldAbsolute = toAbsolute(root, worldRelative, { allowMissingLeaf: true });
    if (!fs.existsSync(worldAbsolute) || !fs.statSync(worldAbsolute).isDirectory()) {
      throw new Error(`World folder is missing from this Data root: ${worldRelative}`);
    }
  }
  const quality = Number(args.quality ?? 85);
  const method = Number(args.method ?? 6);
  if (!Number.isFinite(quality) || quality < 1 || quality > 100) throw new Error("--quality must be 1..100.");
  if (!Number.isFinite(method) || method < 0 || method > 6) throw new Error("--method must be 0..6.");
  const dryRun = args["dry-run"] === true;
  const { cwebp } = configureDecoders(args);
  const options = {
    cwebp,
    quality,
    method,
    lossless: args.lossless === true,
    overwrite: args.overwrite === true,
    allowLarger: args["allow-larger"] === true,
    trustExisting: args["trust-existing"] === true,
    dryRun
  };
  const manifestEntries = uniqueEntries(manifest.entries);
  const entries = [];
  const walkCache = new Map();

  console.log(`${dryRun ? "Previewing" : "Converting"} ${manifestEntries.length} manifest paths with ${options.lossless ? "lossless WebP" : `quality ${quality}`}...`);
  for (let index = 0; index < manifestEntries.length; index += 1) {
    const entry = manifestEntries[index];
    let result;
    try {
      result = convertManifestEntry(root, entry, options, walkCache);
    } catch (error) {
      result = { oldPath: entry.oldPath, newPath: entry.newPath, status: "failed", error: error.message ?? String(error), files: [] };
    }
    entries.push(result);
    const line = `[${index + 1}/${manifestEntries.length}] ${result.status.toUpperCase()} ${entry.oldPath}`;
    console.log(result.error ? `${line} :: ${result.error}` : line);
    for (const file of result.files ?? []) if (file.error) console.log(`  ${file.status.toUpperCase()} ${file.oldPath} :: ${file.error}`);
  }

  const report = {
    type: "fbl-webp-migrator-conversion-report",
    schemaVersion: REPORT_SCHEMA_VERSION,
    version: TOOL_VERSION,
    producer: "fbl-webp-migrator-cwebp",
    createdAt: new Date().toISOString(),
    sourceManifestId: manifest.manifestId,
    sourceWorldId: manifest.worldId ?? null,
    dataRootId: root.id,
    caseInsensitivePaths: process.platform === "win32",
    dryRun,
    options: {
      quality,
      method,
      lossless: options.lossless,
      overwrite: options.overwrite,
      allowLarger: options.allowLarger,
      trustExisting: options.trustExisting,
      cwebp: args["include-local-paths"] ? cwebp : path.basename(cwebp)
    },
    summary: summarizeConversion(entries),
    entries,
    sourceManifest: reportLocalPath(args["include-local-paths"], manifestPath),
    dataRoot: reportLocalPath(args["include-local-paths"], root.real)
  };
  const output = args.out ? path.resolve(args.out) : path.join(path.dirname(manifestPath), `conversion-report-${stamp()}.json`);
  writeJson(output, report);
  console.log(`\nConversion report: ${output}`);
  console.log(JSON.stringify(report.summary, null, 2));
  if (report.summary.failed || report.summary.skipped || report.summary.larger) process.exitCode = 2;
  return report;
}

function audit(args) {
  if (!args.audit) throw new Error("--audit is required.");
  if (!args.data) throw new Error("--data is required.");
  const manifestPath = path.resolve(args.audit);
  const manifest = readJson(manifestPath);
  if (manifest.type !== "fbl-webp-migrator-manifest") throw new Error("Input is not a FBL WebP Migrator manifest.");
  if (!manifest.manifestId) throw new Error("Manifest is obsolete and has no manifestId. Rescan with module 0.4.0 or newer.");
  if (!(Number(manifest.schemaVersion) >= 4) || manifest.capabilities?.webpReferenceScan !== true || manifest.capabilities?.consistencyAudit !== true || !Array.isArray(manifest.webpEntries)) {
    throw new Error("Manifest has no complete WebP-reference scan. Rescan with module 0.4.0 or newer before using --audit.");
  }

  const root = validateDataRoot(args.data);
  if (args["world-id"] && manifest.worldId !== args["world-id"]) {
    throw new Error(`Manifest worldId ${manifest.worldId ?? "<none>"} does not match --world-id ${args["world-id"]}.`);
  }
  if (!args["force-data-root"] && manifest.worldId) {
    const worldRelative = normalizeRelativeDirectory(`worlds/${manifest.worldId}`);
    const worldAbsolute = toAbsolute(root, worldRelative, { allowMissingLeaf: true });
    if (!fs.existsSync(worldAbsolute) || !fs.statSync(worldAbsolute).isDirectory()) {
      throw new Error(`World folder is missing from this Data root: ${worldRelative}`);
    }
  }

  configureDecoders(args);
  const pairs = uniqueAuditEntries(manifest);
  const walkCache = new Map();
  const entries = [];
  console.log(`Auditing ${pairs.length} PNG/WEBP path pairs...`);
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    let result;
    try {
      result = auditManifestEntry(root, pair, walkCache);
    } catch (error) {
      result = { ...pair, status: "unresolved", forwardAuthorized: false, reverseAuthorized: false, files: [], error: error.message ?? String(error) };
    }
    entries.push(result);
    const line = `[${index + 1}/${pairs.length}] ${result.status.toUpperCase()} ${pair.oldPath}`;
    console.log(result.error ? `${line} :: ${result.error}` : line);
    for (const file of result.files ?? []) {
      if (file.category !== "both-valid") console.log(`  ${file.category.toUpperCase()} ${file.oldPath}`);
    }
  }

  const report = {
    type: "fbl-webp-migrator-consistency-report",
    schemaVersion: REPORT_SCHEMA_VERSION,
    version: TOOL_VERSION,
    producer: "fbl-webp-migrator-audit",
    createdAt: new Date().toISOString(),
    sourceManifestId: manifest.manifestId,
    sourceWorldId: manifest.worldId ?? null,
    dataRootId: root.id,
    caseInsensitivePaths: process.platform === "win32",
    summary: summarizeAudit(entries),
    entries,
    sourceManifest: reportLocalPath(args["include-local-paths"], manifestPath),
    dataRoot: reportLocalPath(args["include-local-paths"], root.real)
  };
  const output = args.out ? path.resolve(args.out) : path.join(path.dirname(manifestPath), `consistency-report-${stamp()}.json`);
  writeJson(output, report);
  console.log(`\nConsistency report: ${output}`);
  console.log(JSON.stringify(report.summary, null, 2));
  return report;
}

function validateWorldBinding(root, report, args) {
  if (args["world-id"] && report.worldId !== args["world-id"]) throw new Error(`Report worldId ${report.worldId ?? "<none>"} does not match --world-id ${args["world-id"]}.`);
  if (args["force-data-root"]) return;
  if (!report.sourceDataRootId) throw new Error("Migration report has no verified Data-root binding. Cleanup is refused. Use a real conversion report, not WEBP already ready.");
  if (report.sourceDataRootId !== root.id) throw new Error("Migration report was produced for a different Foundry Data root. Use --force-data-root only after manual verification.");
  if (report.worldId) {
    const worldRelative = normalizeRelativeDirectory(`worlds/${report.worldId}`);
    const worldAbsolute = toAbsolute(root, worldRelative, { allowMissingLeaf: true });
    if (!fs.existsSync(worldAbsolute) || !fs.statSync(worldAbsolute).isDirectory()) {
      throw new Error(`World folder is missing from this Data root: ${worldRelative}`);
    }
  }
}

function sanitizeCleanupFile(file) {
  const oldPath = normalizeRelativePath(file?.oldPath);
  const newPath = normalizeRelativePath(file?.newPath);
  if (/[*?]/.test(oldPath) || /[*?]/.test(newPath)) throw new Error(`Cleanup file paths must be concrete: ${oldPath}`);
  if (pngToWebp(oldPath) !== newPath) throw new Error(`Cleanup newPath mismatch: ${oldPath}`);
  if (!HASH_RE.test(String(file?.oldSha256 ?? "")) || !HASH_RE.test(String(file?.newSha256 ?? ""))) {
    throw new Error(`Cleanup fingerprints are missing for: ${oldPath}`);
  }
  return {
    oldPath,
    newPath,
    oldSha256: String(file.oldSha256).toLowerCase(),
    newSha256: String(file.newSha256).toLowerCase(),
    oldSize: Number.isFinite(file.oldSize) ? file.oldSize : null,
    newSize: Number.isFinite(file.newSize) ? file.newSize : null,
    oldWidth: Number.isInteger(file.oldWidth) ? file.oldWidth : null,
    oldHeight: Number.isInteger(file.oldHeight) ? file.oldHeight : null,
    newWidth: Number.isInteger(file.newWidth) ? file.newWidth : null,
    newHeight: Number.isInteger(file.newHeight) ? file.newHeight : null
  };
}

function quarantineDestination(root, quarantineRoot, relativeOld) {
  const destinationRelative = `${quarantineRoot}/${relativeOld}`.replace(/\/{2,}/g, "/");
  const destination = toAbsolute(root, destinationRelative, { allowMissingLeaf: true });
  return { destinationRelative, destination };
}

function cleanupConcrete(root, file, action) {
  const oldAbs = toAbsolute(root, file.oldPath, { allowMissingLeaf: true });
  const newAbs = toAbsolute(root, file.newPath, { allowMissingLeaf: true });
  if (!fs.existsSync(oldAbs)) return { ...file, status: "missing-old" };
  const pngInfo = inspectPng(oldAbs);
  if (!pngInfo.valid || pngInfo.animated) return { ...file, status: "skipped", error: "Source is invalid or is APNG. PNG was not touched." };
  if (file.oldSize != null && fileSize(oldAbs) !== file.oldSize) return { ...file, status: "skipped", error: "PNG size changed after conversion." };
  if (sha256File(oldAbs) !== file.oldSha256) return { ...file, status: "skipped", error: "PNG content changed after conversion." };
  const webpInfo = inspectWebp(newAbs);
  if (!webpInfo.valid) return { ...file, status: "skipped", error: "Matching WEBP is absent, animated, or invalid." };
  if (file.newSize != null && fileSize(newAbs) !== file.newSize) return { ...file, status: "skipped", error: "WEBP size changed after conversion." };
  if (sha256File(newAbs) !== file.newSha256) return { ...file, status: "skipped", error: "WEBP content changed after conversion." };
  if (file.oldWidth && (pngInfo.width !== file.oldWidth || pngInfo.height !== file.oldHeight)) return { ...file, status: "skipped", error: "PNG dimensions changed after conversion." };
  if (file.newWidth && (webpInfo.width !== file.newWidth || webpInfo.height !== file.newHeight)) return { ...file, status: "skipped", error: "WEBP dimensions changed after conversion." };
  if (pngInfo.width !== webpInfo.width || pngInfo.height !== webpInfo.height) return { ...file, status: "skipped", error: "PNG and WEBP dimensions no longer match." };

  if (action.mode === "dry-run") return { ...file, status: "would-quarantine" };
  if (action.mode === "delete") {
    fs.unlinkSync(oldAbs);
    return { ...file, status: "deleted" };
  }

  const { destinationRelative, destination } = quarantineDestination(root, action.quarantineRoot, file.oldPath);
  if (fs.existsSync(destination)) return { ...file, status: "skipped", error: `Quarantine destination already exists: ${destinationRelative}` };
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  assertNoSymlinkPath(root, path.dirname(destination));
  fs.renameSync(oldAbs, destination);
  return { ...file, status: "quarantined", quarantinePath: destinationRelative };
}

function cleanup(args) {
  if (!args.cleanup) throw new Error("--cleanup is required.");
  if (!args.data) throw new Error("--data is required.");
  if (args["permanent-delete"] && !args.delete) throw new Error("--permanent-delete requires --delete.");
  const migrationPath = path.resolve(args.cleanup);
  const migration = readJson(migrationPath);
  if (migration.type !== "fbl-webp-migrator-migration-report") throw new Error("Input is not a FBL WebP Migrator migration report.");
  if (!(Number(migration.schemaVersion) >= 5)) throw new Error("Migration report predates the safety fixes. Repeat scan, conversion verification and migration with 0.4.8+ before cleanup.");
  if (migration.cleanupRevoked === true) throw new Error("Cleanup authorization was revoked by rollback. Export a new report after a new scan and migration.");
  const root = validateDataRoot(args.data);
  validateWorldBinding(root, migration, args);
  if (!Array.isArray(migration.cleanupFiles)) throw new Error("Migration report has no concrete cleanupFiles list. Cleanup is refused.");

  const map = new Map();
  for (const input of migration.cleanupFiles) {
    const file = sanitizeCleanupFile(input);
    const oldPathKey = migration.caseInsensitivePaths === true ? file.oldPath.toLowerCase() : file.oldPath;
    map.set(`${oldPathKey}|${file.oldSha256}`, file);
  }
  const files = [...map.values()];
  configureDecoders(args);
  const doDelete = args.delete === true && args["dry-run"] !== true;
  const permanent = args["permanent-delete"] === true;
  const quarantineRoot = normalizeRelativeDirectory(args.quarantine || `.fbl-webp-migrator-quarantine/${stamp()}`);
  const action = { mode: !doDelete ? "dry-run" : permanent ? "delete" : "quarantine", quarantineRoot };
  console.log(`${action.mode === "dry-run" ? "Dry-run cleanup for" : action.mode === "delete" ? "Permanently deleting" : "Quarantining"} ${files.length} verified PNG files...`);

  const entries = [];
  for (const file of files) {
    let result;
    try {
      result = cleanupConcrete(root, file, action);
    } catch (error) {
      result = { ...file, status: "failed", error: error.message ?? String(error) };
    }
    entries.push(result);
    console.log(`${result.status.toUpperCase()} ${file.oldPath}${result.error ? ` :: ${result.error}` : ""}`);
  }

  const report = {
    type: "fbl-webp-migrator-cleanup-report",
    schemaVersion: REPORT_SCHEMA_VERSION,
    version: TOOL_VERSION,
    createdAt: new Date().toISOString(),
    sourceManifestId: migration.sourceManifestId ?? null,
    sourceDataRootId: migration.sourceDataRootId ?? null,
    worldId: migration.worldId ?? null,
    dataRootId: root.id,
    caseInsensitivePaths: process.platform === "win32",
    mode: action.mode,
    quarantineRoot: action.mode === "quarantine" ? quarantineRoot : null,
    summary: {
      concreteFiles: entries.length,
      quarantined: entries.filter((file) => file.status === "quarantined").length,
      deleted: entries.filter((file) => file.status === "deleted").length,
      wouldQuarantine: entries.filter((file) => file.status === "would-quarantine").length,
      skipped: entries.filter((file) => file.status === "skipped").length,
      missingOld: entries.filter((file) => file.status === "missing-old").length,
      failed: entries.filter((file) => file.status === "failed").length
    },
    entries,
    sourceMigrationReport: reportLocalPath(args["include-local-paths"], migrationPath),
    dataRoot: reportLocalPath(args["include-local-paths"], root.real)
  };
  const output = args.out ? path.resolve(args.out) : path.join(path.dirname(migrationPath), `cleanup-report-${stamp()}.json`);
  writeJson(output, report);
  console.log(`\nCleanup report: ${output}`);
  console.log(JSON.stringify(report.summary, null, 2));
  if (report.summary.failed || report.summary.skipped) process.exitCode = 2;
  return report;
}

function restoreConcrete(root, entry, { dryRun = false } = {}) {
  const oldPath = normalizeRelativePath(entry.oldPath);
  const quarantinePath = normalizeRelativePath(entry.quarantinePath);
  const oldAbs = toAbsolute(root, oldPath, { allowMissingLeaf: true });
  const quarantineAbs = toAbsolute(root, quarantinePath, { allowMissingLeaf: true });
  if (!fs.existsSync(quarantineAbs)) return { oldPath, quarantinePath, status: "missing-quarantine" };
  if (fs.existsSync(oldAbs)) return { oldPath, quarantinePath, status: "skipped", error: "Original PNG path is occupied. Nothing was overwritten." };
  if (!HASH_RE.test(String(entry.oldSha256 ?? "")) || sha256File(quarantineAbs) !== String(entry.oldSha256).toLowerCase()) {
    return { oldPath, quarantinePath, status: "skipped", error: "Quarantined file hash does not match cleanup report." };
  }
  if (dryRun) return { oldPath, quarantinePath, status: "would-restore" };
  fs.mkdirSync(path.dirname(oldAbs), { recursive: true });
  assertNoSymlinkPath(root, path.dirname(oldAbs));
  fs.renameSync(quarantineAbs, oldAbs);
  return { oldPath, quarantinePath, status: "restored" };
}

function restore(args) {
  if (!args.restore) throw new Error("--restore is required.");
  if (!args.data) throw new Error("--data is required.");
  const cleanupPath = path.resolve(args.restore);
  const cleanupReport = readJson(cleanupPath);
  if (cleanupReport.type !== "fbl-webp-migrator-cleanup-report") throw new Error("Input is not a FBL WebP Migrator cleanup report.");
  if (args["world-id"] && cleanupReport.worldId !== args["world-id"]) {
    throw new Error(`Cleanup report worldId ${cleanupReport.worldId ?? "<none>"} does not match --world-id ${args["world-id"]}.`);
  }
  const root = validateDataRoot(args.data);
  if (!args["force-data-root"] && cleanupReport.dataRootId && cleanupReport.dataRootId !== root.id) throw new Error("Cleanup report belongs to a different Data root.");
  const entries = [];
  for (const input of cleanupReport.entries ?? []) {
    if (input?.status !== "quarantined" || !input.quarantinePath) continue;
    let result;
    try {
      result = restoreConcrete(root, input, { dryRun: args["dry-run"] === true });
    } catch (error) {
      result = { oldPath: input.oldPath, quarantinePath: input.quarantinePath, status: "failed", error: error.message ?? String(error) };
    }
    entries.push(result);
    console.log(`${result.status.toUpperCase()} ${result.oldPath}${result.error ? ` :: ${result.error}` : ""}`);
  }
  const report = {
    type: "fbl-webp-migrator-restore-report",
    schemaVersion: REPORT_SCHEMA_VERSION,
    version: TOOL_VERSION,
    createdAt: new Date().toISOString(),
    dataRootId: root.id,
    caseInsensitivePaths: process.platform === "win32",
    summary: {
      input: entries.length,
      wouldRestore: entries.filter((entry) => entry.status === "would-restore").length,
      restored: entries.filter((entry) => entry.status === "restored").length,
      skipped: entries.filter((entry) => entry.status === "skipped").length,
      missingQuarantine: entries.filter((entry) => entry.status === "missing-quarantine").length,
      failed: entries.filter((entry) => entry.status === "failed").length
    },
    entries,
    sourceCleanupReport: reportLocalPath(args["include-local-paths"], cleanupPath),
    dataRoot: reportLocalPath(args["include-local-paths"], root.real)
  };
  const output = args.out ? path.resolve(args.out) : path.join(path.dirname(cleanupPath), `restore-report-${stamp()}.json`);
  writeJson(output, report);
  console.log(`\nRestore report: ${output}`);
  console.log(JSON.stringify(report.summary, null, 2));
  if (report.summary.failed || report.summary.skipped) process.exitCode = 2;
  return report;
}

function validateModeOptions(args) {
  const mode = ["manifest", "audit", "cleanup", "restore"].find((key) => args[key]);
  const shared = [mode, "data", "out", "world-id", "dry-run", "include-local-paths", "force-data-root", "help"];
  const allowed = new Set([...shared, ...({
    manifest: ["cwebp", "dwebp", "quality", "method", "lossless", "overwrite", "trust-existing", "allow-larger"],
    audit: ["cwebp", "dwebp"],
    cleanup: ["cwebp", "dwebp", "delete", "permanent-delete", "quarantine"],
    restore: []
  }[mode] ?? [])]);
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error(`--${key} cannot be used with --${mode}.`);
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    fail(error.message);
  }
  const modes = [args.manifest, args.audit, args.cleanup, args.restore].filter(Boolean).length;
  if (args.help || modes === 0) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  if (modes !== 1) fail("Use exactly one of --manifest, --audit, --cleanup, or --restore.");
  try {
    validateModeOptions(args);
    if (args.manifest) convert(args);
    else if (args.audit) audit(args);
    else if (args.cleanup) cleanup(args);
    else restore(args);
  } catch (error) {
    fail(error.message ?? String(error));
  }
}

module.exports = {
  TOOL_VERSION,
  parseArgs,
  configureDecoders,
  validateModeOptions,
  normalizeRelativePath,
  validateDataRoot,
  toAbsolute,
  inspectPng,
  inspectWebp,
  isValidWebp,
  isAnimatedPng,
  globToRegExp,
  expandPattern,
  pngToWebp,
  atomicConvert,
  convertConcrete,
  convertManifestEntry,
  uniqueEntries,
  uniqueAuditEntries,
  auditFileState,
  auditConcrete,
  auditManifestEntry,
  summarizeAudit,
  summarizeConversion,
  sanitizeCleanupFile,
  cleanupConcrete,
  restoreConcrete,
  convert,
  audit,
  cleanup,
  restore,
  main,
  sha256File
};

if (require.main === module) main();
