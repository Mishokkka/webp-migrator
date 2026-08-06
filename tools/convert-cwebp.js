#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const TOOL_VERSION = "0.2.1";
const SUCCESS = new Set(["converted", "exists", "exists-missing-old"]);

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function printHelp() {
  console.log(`FBL WebP Migrator cwebp tool ${TOOL_VERSION}

Convert:
  node tools/convert-cwebp.js --manifest manifest.json --data "C:\\FoundryVTT\\Data" --cwebp "D:\\libwebp\\bin\\cwebp.exe" --quality 85

Cleanup dry-run:
  node tools/convert-cwebp.js --cleanup migration-report.json --data "C:\\FoundryVTT\\Data"

Delete migrated PNG:
  node tools/convert-cwebp.js --cleanup migration-report.json --data "C:\\FoundryVTT\\Data" --delete

Options:
  --manifest <file>   Manifest exported by Foundry
  --cleanup <file>    Migration report exported after Foundry updates
  --data <folder>     Foundry UserData/Data folder
  --cwebp <file>      Full path to cwebp.exe, or cwebp from PATH
  --quality <1..100>  Lossy quality, default 85
  --method <0..6>     Compression method, default 6
  --lossless          Use lossless WebP
  --overwrite         Replace an existing valid WEBP
  --delete            Actually delete PNG during cleanup
  --out <file>        Explicit report path
  --help              Show this help

Safety:
  - WEBP is written to a temporary file and validated before replacement.
  - Existing WEBP must contain RIFF/WEBP magic.
  - Cleanup refuses to delete PNG if matching WEBP is absent or invalid.
  - APNG is skipped because cwebp would not preserve its animation.
  - Wildcards * and ? are expanded below the Data root.`);
}

function fail(message, code = 1) {
  console.error(`ERROR: ${message}`);
  process.exit(code);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function writeJson(file, data) {
  const absolute = path.resolve(file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, JSON.stringify(data, null, 2), "utf8");
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function validateDataRoot(input) {
  const root = path.resolve(input);
  if (!fs.existsSync(root)) throw new Error(`Data root does not exist: ${root}`);
  if (!fs.statSync(root).isDirectory()) throw new Error(`--data must point to a folder: ${root}`);
  return root;
}

function stripSuffix(value) {
  return String(value ?? "").split(/[?#]/, 1)[0];
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeRelativePath(value) {
  let relative = decodePath(stripSuffix(value)).replace(/\\/g, "/").replace(/^\/+/, "");
  while (relative.startsWith("./")) relative = relative.slice(2);
  relative = relative.replace(/\/{2,}/g, "/");
  if (!relative || /^(?:https?:|data:|blob:|file:|ftp:)/i.test(relative) || /^[a-z]:\//i.test(relative)) {
    throw new Error(`Not a local Foundry Data path: ${value}`);
  }
  const segments = relative.split("/");
  if (segments.some((segment) => segment === ".." || segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
    throw new Error(`Unsafe relative path: ${value}`);
  }
  return relative;
}

function insideRoot(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toAbsolute(root, relative) {
  const absolute = path.resolve(root, ...normalizeRelativePath(relative).split("/"));
  if (!insideRoot(root, absolute)) throw new Error(`Path escapes Data root: ${relative}`);
  return absolute;
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function isValidWebp(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 12) return false;
    const fd = fs.openSync(file, "r");
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    fs.closeSync(fd);
    return header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP";
  } catch {
    return false;
  }
}

function isAnimatedPng(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const signature = Buffer.alloc(8);
    if (fs.readSync(fd, signature, 0, 8, 0) !== 8) return false;
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!signature.equals(pngSignature)) return false;

    let position = 8;
    const header = Buffer.alloc(8);
    const size = fs.fstatSync(fd).size;
    while (position + 12 <= size) {
      if (fs.readSync(fd, header, 0, 8, position) !== 8) break;
      const length = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      if (type === "acTL") return true;
      if (type === "IDAT" || type === "IEND") return false;
      position += 12 + length;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
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

function walkFiles(folder, output) {
  if (!fs.existsSync(folder)) return;
  for (const dirent of fs.readdirSync(folder, { withFileTypes: true })) {
    const absolute = path.join(folder, dirent.name);
    if (dirent.isDirectory()) walkFiles(absolute, output);
    else if (dirent.isFile()) output.push(absolute);
  }
}

function expandPattern(root, pattern) {
  const relativePattern = normalizeRelativePath(pattern);
  if (!/[*?]/.test(relativePattern)) {
    const absolute = toAbsolute(root, relativePattern);
    return fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? [relativePattern] : [];
  }

  const firstWildcard = relativePattern.search(/[*?]/);
  const slash = relativePattern.lastIndexOf("/", firstWildcard);
  const baseRelative = slash >= 0 ? relativePattern.slice(0, slash) : "";
  const baseAbsolute = baseRelative ? toAbsolute(root, baseRelative) : root;
  const candidates = [];
  walkFiles(baseAbsolute, candidates);
  const regex = globToRegExp(relativePattern);
  return candidates
    .map((absolute) => path.relative(root, absolute).split(path.sep).join("/"))
    .filter((relative) => regex.test(relative))
    .sort((a, b) => a.localeCompare(b));
}

function pngToWebp(relative) {
  if (!/\.png$/i.test(relative)) throw new Error(`PNG extension expected: ${relative}`);
  return relative.replace(/\.png$/i, ".webp");
}

function validateCwebp(command) {
  const explicit = command.includes("/") || command.includes("\\") || /\.exe$/i.test(command);
  if (explicit) {
    const absolute = path.resolve(command);
    if (!fs.existsSync(absolute)) throw new Error(`cwebp executable does not exist: ${absolute}`);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) throw new Error(`--cwebp points to a folder. Specify the executable itself, for example: ${path.join(absolute, "cwebp.exe")}`);
    command = absolute;
  }
  const probe = spawnSync(command, ["-version"], { encoding: "utf8", windowsHide: true });
  if (probe.error) {
    if (probe.error.code === "ENOENT") throw new Error(`cwebp was not found: ${command}. Pass the full path to cwebp.exe with --cwebp.`);
    throw probe.error;
  }
  if (probe.status !== 0) throw new Error(`cwebp failed its version check (${probe.status}): ${(probe.stderr || probe.stdout || "").trim()}`);
  return command;
}

function runCwebp({ cwebp, input, output, quality, method, lossless }) {
  const args = lossless
    ? ["-lossless", "-exact", "-q", String(quality), "-m", String(method), "-mt", input, "-o", output]
    : ["-q", String(quality), "-m", String(method), "-alpha_q", "100", "-mt", input, "-o", output];
  const result = spawnSync(cwebp, args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `cwebp exited with ${result.status}`).trim());
}

function atomicConvert({ cwebp, oldAbs, newAbs, quality, method, lossless, overwrite }) {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const temp = `${newAbs}.fwm-${nonce}.tmp.webp`;
  const backup = `${newAbs}.fwm-${nonce}.backup.webp`;
  let movedExisting = false;
  try {
    fs.mkdirSync(path.dirname(newAbs), { recursive: true });
    runCwebp({ cwebp, input: oldAbs, output: temp, quality, method, lossless });
    if (!isValidWebp(temp)) throw new Error("cwebp output is missing or does not contain a valid RIFF/WEBP header.");
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
  }
}

function percent(oldSize, newSize) {
  if (!Number.isFinite(oldSize) || !Number.isFinite(newSize) || oldSize <= 0) return null;
  return Number((((oldSize - newSize) / oldSize) * 100).toFixed(2));
}

function summarizeConversion(entries) {
  const summary = {
    input: entries.length,
    converted: entries.filter((entry) => entry.status === "converted").length,
    exists: entries.filter((entry) => entry.status === "exists").length,
    existsMissingOld: entries.filter((entry) => entry.status === "exists-missing-old").length,
    failed: entries.filter((entry) => entry.status === "failed").length,
    skipped: entries.filter((entry) => entry.status === "skipped").length,
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

function aggregateEntryStatus(files) {
  if (!files.length) return "failed";
  if (files.every((file) => file.status === "skipped")) return "skipped";
  if (files.some((file) => file.status === "failed" || file.status === "skipped")) return "failed";
  if (files.some((file) => file.status === "converted")) return "converted";
  if (files.every((file) => file.status === "exists-missing-old")) return "exists-missing-old";
  return "exists";
}

function convertConcrete(root, relativeOld, options) {
  const oldAbs = toAbsolute(root, relativeOld);
  const relativeNew = pngToWebp(relativeOld);
  const newAbs = toAbsolute(root, relativeNew);
  const oldExists = fs.existsSync(oldAbs);
  const newExists = fs.existsSync(newAbs);
  const output = {
    oldPath: relativeOld,
    newPath: relativeNew,
    oldSize: oldExists ? fileSize(oldAbs) : null,
    newSize: newExists ? fileSize(newAbs) : null
  };

  if (!oldExists) {
    if (newExists && isValidWebp(newAbs)) output.status = "exists-missing-old";
    else {
      output.status = "failed";
      output.error = "PNG is missing and no valid WEBP exists.";
    }
    return output;
  }

  if (newExists && !options.overwrite) {
    if (!isValidWebp(newAbs)) {
      output.status = "failed";
      output.error = "Existing WEBP is invalid. Use --overwrite to replace it.";
      return output;
    }
    output.status = "exists";
    output.newSize = fileSize(newAbs);
    output.savedPercent = percent(output.oldSize, output.newSize);
    return output;
  }

  if (isAnimatedPng(oldAbs)) {
    output.status = "skipped";
    output.error = "APNG detected. Static cwebp conversion would discard animation.";
    return output;
  }

  atomicConvert({
    cwebp: options.cwebp,
    oldAbs,
    newAbs,
    quality: options.quality,
    method: options.method,
    lossless: options.lossless,
    overwrite: options.overwrite
  });
  output.status = "converted";
  output.newSize = fileSize(newAbs);
  output.savedPercent = percent(output.oldSize, output.newSize);
  return output;
}

function convertManifestEntry(root, entry, options) {
  const oldPattern = normalizeRelativePath(entry.oldPath);
  const newPattern = normalizeRelativePath(entry.newPath);
  let oldFiles = expandPattern(root, oldPattern).filter((file) => /\.png$/i.test(file));
  const children = [];

  if (!oldFiles.length && /[*?]/.test(oldPattern)) {
    const existingWebp = expandPattern(root, newPattern).filter((file) => /\.webp$/i.test(file));
    for (const relativeNew of existingWebp) {
      const newAbs = toAbsolute(root, relativeNew);
      children.push({
        oldPath: relativeNew.replace(/\.webp$/i, ".png"),
        newPath: relativeNew,
        oldSize: null,
        newSize: fileSize(newAbs),
        status: isValidWebp(newAbs) ? "exists-missing-old" : "failed",
        error: isValidWebp(newAbs) ? undefined : "Existing WEBP is invalid."
      });
    }
  } else {
    for (const relativeOld of oldFiles) children.push(convertConcrete(root, relativeOld, options));
  }

  if (!children.length && !/[*?]/.test(oldPattern)) children.push(convertConcrete(root, oldPattern, options));
  const status = aggregateEntryStatus(children);
  const oldSizes = children.filter((file) => Number.isFinite(file.oldSize));
  const pairedSizes = children.filter((file) => Number.isFinite(file.oldSize) && Number.isFinite(file.newSize));
  const oldSize = oldSizes.length ? oldSizes.reduce((sum, file) => sum + file.oldSize, 0) : null;
  const newSize = pairedSizes.length ? pairedSizes.reduce((sum, file) => sum + file.newSize, 0) : null;
  return {
    oldPath: entry.oldPath,
    newPath: entry.newPath,
    wildcard: /[*?]/.test(oldPattern),
    status,
    oldSize,
    newSize,
    savedPercent: percent(oldSize, newSize),
    files: children,
    error: status === "failed" ? "One or more concrete files failed or were skipped." : undefined
  };
}

function uniqueEntries(entries) {
  const map = new Map();
  for (const entry of entries ?? []) {
    if (!entry?.oldPath || !entry?.newPath) continue;
    map.set(entry.oldPath, { oldPath: entry.oldPath, newPath: entry.newPath });
  }
  return [...map.values()];
}

function convert(args) {
  if (!args.manifest) fail("--manifest is required.");
  if (!args.data) fail("--data is required.");
  const manifestPath = path.resolve(args.manifest);
  const manifest = readJson(manifestPath);
  if (manifest.type !== "fbl-webp-migrator-manifest") fail("Input is not a FBL WebP Migrator manifest.");
  if (!manifest.manifestId) fail("Manifest is obsolete and has no manifestId. Rescan with module 0.2.0 or newer.");

  let root;
  let cwebp;
  try {
    root = validateDataRoot(args.data);
    cwebp = validateCwebp(String(args.cwebp || "cwebp"));
  } catch (error) {
    fail(error.message);
  }

  const quality = Number(args.quality ?? 85);
  const method = Number(args.method ?? 6);
  if (!Number.isFinite(quality) || quality < 1 || quality > 100) fail("--quality must be 1..100.");
  if (!Number.isFinite(method) || method < 0 || method > 6) fail("--method must be 0..6.");
  const options = { cwebp, quality, method, lossless: !!args.lossless, overwrite: !!args.overwrite };
  const manifestEntries = uniqueEntries(manifest.entries);
  const entries = [];

  console.log(`Converting ${manifestEntries.length} manifest paths with ${options.lossless ? "lossless WebP" : `quality ${quality}`}...`);
  for (let index = 0; index < manifestEntries.length; index += 1) {
    const entry = manifestEntries[index];
    let result;
    try {
      result = convertManifestEntry(root, entry, options);
    } catch (error) {
      result = { oldPath: entry.oldPath, newPath: entry.newPath, status: "failed", error: error.message ?? String(error), files: [] };
    }
    entries.push(result);
    const line = `[${index + 1}/${manifestEntries.length}] ${result.status.toUpperCase()} ${entry.oldPath}`;
    console.log(result.error ? `${line} :: ${result.error}` : line);
    for (const file of result.files ?? []) {
      if (file.error) console.log(`  ${file.status.toUpperCase()} ${file.oldPath} :: ${file.error}`);
    }
  }

  const report = {
    type: "fbl-webp-migrator-conversion-report",
    schemaVersion: 2,
    version: TOOL_VERSION,
    createdAt: new Date().toISOString(),
    sourceManifest: manifestPath,
    sourceManifestId: manifest.manifestId,
    sourceWorldId: manifest.worldId ?? null,
    dataRoot: root,
    options: { ...options, cwebp },
    summary: summarizeConversion(entries),
    entries
  };
  const output = args.out ? path.resolve(args.out) : path.join(path.dirname(manifestPath), `conversion-report-${stamp()}.json`);
  writeJson(output, report);
  console.log(`\nConversion report: ${output}`);
  console.log(JSON.stringify(report.summary, null, 2));
  if (report.summary.failed || report.summary.skipped) process.exitCode = 2;
}

function cleanupConcrete(root, relativeOld, doDelete) {
  const relativeNew = pngToWebp(relativeOld);
  const oldAbs = toAbsolute(root, relativeOld);
  const newAbs = toAbsolute(root, relativeNew);
  const oldExists = fs.existsSync(oldAbs);
  if (!oldExists) return { oldPath: relativeOld, newPath: relativeNew, status: "missing-old" };
  if (!isValidWebp(newAbs)) return { oldPath: relativeOld, newPath: relativeNew, status: "skipped", error: "Matching WEBP is absent or invalid. PNG was not deleted." };
  if (!doDelete) return { oldPath: relativeOld, newPath: relativeNew, status: "would-delete" };
  fs.unlinkSync(oldAbs);
  return { oldPath: relativeOld, newPath: relativeNew, status: "deleted" };
}

function aggregateCleanupStatus(files, doDelete) {
  if (!files.length) return "missing-old";
  if (files.some((file) => file.status === "failed" || file.status === "skipped")) return "skipped";
  if (files.every((file) => file.status === "missing-old")) return "missing-old";
  return doDelete ? "deleted" : "would-delete";
}

function cleanup(args) {
  if (!args.cleanup) fail("--cleanup is required.");
  if (!args.data) fail("--data is required.");
  const migrationPath = path.resolve(args.cleanup);
  const migration = readJson(migrationPath);
  if (migration.type !== "fbl-webp-migrator-migration-report") fail("Input is not a FBL WebP Migrator migration report.");
  let root;
  try {
    root = validateDataRoot(args.data);
  } catch (error) {
    fail(error.message);
  }
  const doDelete = !!args.delete;
  const entries = [];
  const migrated = uniqueEntries(migration.migrated);
  console.log(`${doDelete ? "Deleting" : "Dry-run cleanup for"} ${migrated.length} migrated PNG paths...`);

  for (const entry of migrated) {
    let result;
    try {
      const pattern = normalizeRelativePath(entry.oldPath);
      const concrete = expandPattern(root, pattern).filter((file) => /\.png$/i.test(file));
      const files = concrete.length
        ? concrete.map((relativeOld) => cleanupConcrete(root, relativeOld, doDelete))
        : (!/[*?]/.test(pattern) ? [cleanupConcrete(root, pattern, doDelete)] : []);
      result = {
        oldPath: entry.oldPath,
        newPath: entry.newPath,
        wildcard: /[*?]/.test(pattern),
        status: aggregateCleanupStatus(files, doDelete),
        files
      };
    } catch (error) {
      result = { oldPath: entry.oldPath, newPath: entry.newPath, status: "failed", error: error.message ?? String(error), files: [] };
    }
    entries.push(result);
    console.log(`${result.status.toUpperCase()} ${entry.oldPath}${result.error ? ` :: ${result.error}` : ""}`);
    for (const file of result.files ?? []) {
      if (file.error) console.log(`  ${file.status.toUpperCase()} ${file.oldPath} :: ${file.error}`);
    }
  }

  const flat = entries.flatMap((entry) => entry.files ?? []);
  const report = {
    type: "fbl-webp-migrator-cleanup-report",
    schemaVersion: 2,
    version: TOOL_VERSION,
    createdAt: new Date().toISOString(),
    sourceMigrationReport: migrationPath,
    sourceManifestId: migration.sourceManifestId ?? null,
    dataRoot: root,
    dryRun: !doDelete,
    summary: {
      manifestPaths: entries.length,
      concreteFiles: flat.length,
      deleted: flat.filter((file) => file.status === "deleted").length,
      wouldDelete: flat.filter((file) => file.status === "would-delete").length,
      skipped: flat.filter((file) => file.status === "skipped").length,
      missingOld: flat.filter((file) => file.status === "missing-old").length,
      failed: entries.filter((entry) => entry.status === "failed").length
    },
    entries
  };
  const output = args.out ? path.resolve(args.out) : path.join(path.dirname(migrationPath), `cleanup-report-${stamp()}.json`);
  writeJson(output, report);
  console.log(`\nCleanup report: ${output}`);
  console.log(JSON.stringify(report.summary, null, 2));
  if (report.summary.failed || report.summary.skipped) process.exitCode = 2;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.manifest && !args.cleanup)) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  if (args.manifest && args.cleanup) fail("Use either --manifest or --cleanup, not both.");
  if (args.manifest) convert(args);
  else cleanup(args);
}

main();
