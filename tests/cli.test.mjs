import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cli = require("../tools/convert-cwebp.js");

function chunk(type, data = Buffer.alloc(0), endian = "be") {
  const length = Buffer.alloc(4);
  if (endian === "le") length.writeUInt32LE(data.length);
  else length.writeUInt32BE(data.length);
  const crc = endian === "be" ? Buffer.alloc(4) : Buffer.alloc(data.length % 2);
  return Buffer.concat([length, Buffer.from(type, "ascii"), data, crc]);
}

function webpChunk(type, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length);
  const pad = Buffer.alloc(data.length % 2);
  return Buffer.concat([Buffer.from(type, "ascii"), length, data, pad]);
}

function makePng(width = 2, height = 3, { animated = false, payload = 1 } = {}) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunks = [chunk("IHDR", ihdr)];
  if (animated) {
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(2, 0);
    actl.writeUInt32BE(0, 4);
    chunks.push(chunk("acTL", actl));
  }
  chunks.push(chunk("IDAT", Buffer.alloc(payload, 0x01)));
  chunks.push(chunk("IEND"));
  return Buffer.concat([signature, ...chunks]);
}

function makeWebp(width = 2, height = 3, { junk = 0 } = {}) {
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  const vp8l = Buffer.alloc(5);
  vp8l[0] = 0x2f;
  vp8l[1] = widthMinusOne & 0xff;
  vp8l[2] = ((widthMinusOne >> 8) & 0x3f) | ((heightMinusOne & 0x03) << 6);
  vp8l[3] = (heightMinusOne >> 2) & 0xff;
  vp8l[4] = (heightMinusOne >> 10) & 0x0f;
  const chunks = [webpChunk("VP8L", vp8l)];
  if (junk) chunks.push(webpChunk("JUNK", Buffer.alloc(junk, 0x55)));
  const payload = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(payload.length, 0);
  return Buffer.concat([Buffer.from("RIFF"), riffSize, payload]);
}

function makeVp8xOnly(width = 2, height = 3) {
  const data = Buffer.alloc(10);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  const payload = Buffer.concat([Buffer.from("WEBP"), webpChunk("VP8X", data)]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length, 0);
  return Buffer.concat([Buffer.from("RIFF"), size, payload]);
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fwm-cli-"));
}

function write(root, relative, data) {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

function makeFakeCwebp(root, webpBytes) {
  const script = path.join(root, "fake-cwebp.js");
  const base64 = webpBytes.toString("base64");
  fs.writeFileSync(script, `#!/usr/bin/env node\nconst fs=require('fs');\nif(process.argv.includes('-version')){console.log('fake-cwebp 1.0');process.exit(0);}\nconst i=process.argv.indexOf('-o');\nif(i<0)process.exit(3);\nfs.writeFileSync(process.argv[i+1],Buffer.from('${base64}','base64'));\n`, "utf8");
  fs.chmodSync(script, 0o755);
  return script;
}

function withCleanup(fn) {
  const root = tempDir();
  try { return fn(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); process.exitCode = undefined; }
}

test("strict argument parser rejects unknown flags and boolean values", () => {
  assert.deepEqual(cli.parseArgs(["--delete"]), { delete: true });
  assert.throws(() => cli.parseArgs(["--delete=false"]), /does not accept a value/);
  assert.throws(() => cli.parseArgs(["--delete", "false"]), /Unexpected positional/);
  assert.throws(() => cli.parseArgs(["--qualty", "85"]), /Unknown option/);
  assert.throws(() => cli.parseArgs(["--quality", "--lossless"]), /requires a value/);
});

test("path parser preserves wildcard question marks and literal hash characters", () => {
  assert.equal(cli.normalizeRelativePath("tokens/icon?.png"), "tokens/icon?.png");
  assert.equal(cli.normalizeRelativePath("tokens/hash#name.png"), "tokens/hash#name.png");
  assert.equal(cli.pngToWebp("tokens/icon?.png"), "tokens/icon?.webp");
  assert.throws(() => cli.normalizeRelativePath("C:relative.png"), /drive-relative/);
  assert.throws(() => cli.normalizeRelativePath("\\\\server\\share\\a.png"), /UNC/);
});

test("PNG and WebP inspection rejects truncated or container-only fakes", () => withCleanup((root) => {
  const png = write(root, "a.png", makePng(7, 9));
  const apng = write(root, "animated.png", makePng(7, 9, { animated: true }));
  const badPng = write(root, "bad.png", makePng(7, 9).subarray(0, 40));
  const webp = write(root, "a.webp", makeWebp(7, 9));
  const magicOnly = write(root, "magic.webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]));
  const vp8xOnly = write(root, "vp8x.webp", makeVp8xOnly(7, 9));

  assert.deepEqual(cli.inspectPng(png), { valid: true, width: 7, height: 9, animated: false });
  assert.equal(cli.inspectPng(apng).animated, true);
  assert.equal(cli.inspectPng(badPng).valid, false);
  assert.equal(cli.inspectWebp(webp).valid, true);
  assert.equal(cli.inspectWebp(magicOnly).valid, false);
  assert.equal(cli.inspectWebp(vp8xOnly).valid, false);
}));

test("APNG is skipped even when a valid WebP sibling already exists", () => withCleanup((rootPath) => {
  fs.mkdirSync(path.join(rootPath, "Data"));
  const data = path.join(rootPath, "Data");
  write(data, "art/a.png", makePng(2, 3, { animated: true }));
  write(data, "art/a.webp", makeWebp(2, 3));
  const root = cli.validateDataRoot(data);
  const result = cli.convertConcrete(root, "art/a.png", {
    overwrite: false, trustExisting: true, allowLarger: true, dryRun: false
  });
  assert.equal(result.status, "skipped");
  assert.match(result.error, /APNG/);
}));

test("missing PNG with a valid WebP is accepted without touching disk", () => withCleanup((rootPath) => {
  const data = path.join(rootPath, "Data");
  fs.mkdirSync(data);
  write(data, "art/a.webp", makeWebp(2, 3));
  const root = cli.validateDataRoot(data);
  const result = cli.convertConcrete(root, "art/a.png", { overwrite: false, trustExisting: false, allowLarger: false, dryRun: false });
  assert.equal(result.status, "exists-missing-old");
  assert.equal(result.oldSha256, null);
  assert.match(result.newSha256, /^[a-f0-9]{64}$/);
}));

test("failed validation leaves an existing WebP intact during overwrite", () => withCleanup((rootPath) => {
  const data = path.join(rootPath, "Data");
  fs.mkdirSync(data);
  write(data, "art/a.png", makePng(2, 3));
  const oldWebp = makeWebp(2, 3);
  const target = write(data, "art/a.webp", oldWebp);
  const root = cli.validateDataRoot(data);
  assert.throws(() => cli.convertConcrete(root, "art/a.png", {
    cwebp: "fake", quality: 85, method: 6, lossless: false, overwrite: true,
    trustExisting: false, allowLarger: false, dryRun: false,
    runner: ({ output }) => fs.writeFileSync(output, makeWebp(2, 3, { junk: 200 }))
  }), /larger than/);
  assert.deepEqual(fs.readFileSync(target), oldWebp);
  assert.equal(fs.readdirSync(path.dirname(target)).some((name) => name.includes(".fwm-")), false);
}));

test("symlink paths escaping Data are rejected", (t) => withCleanup((rootPath) => {
  const data = path.join(rootPath, "Data");
  const outside = path.join(rootPath, "outside");
  fs.mkdirSync(data);
  fs.mkdirSync(outside);
  write(outside, "secret.png", makePng());
  try {
    fs.symlinkSync(outside, path.join(data, "link"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`Symlink creation unavailable: ${error.message}`);
    return;
  }
  const root = cli.validateDataRoot(data);
  assert.throws(() => cli.toAbsolute(root, "link/secret.png"), /Symlink|Real path escapes/);
}));

test("full conversion handles wildcard ? and writes a bound report", () => withCleanup((rootPath) => {
  const data = path.join(rootPath, "Data");
  fs.mkdirSync(data);
  write(data, "tokens/icon1.png", makePng(4, 5, { payload: 200 }));
  write(data, "tokens/iconA.png", makePng(4, 5, { payload: 200 }));
  fs.mkdirSync(path.join(data, "worlds", "world-a"), { recursive: true });
  const manifestPath = path.join(rootPath, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    type: "fbl-webp-migrator-manifest",
    manifestId: "manifest-a",
    worldId: "world-a",
    entries: [{ oldPath: "tokens/icon?.png", newPath: "tokens/icon?.webp" }]
  }));
  const cwebp = makeFakeCwebp(rootPath, makeWebp(4, 5));
  const out = path.join(rootPath, "conversion.json");
  const report = cli.convert({ manifest: manifestPath, data, cwebp, out, quality: "85", "world-id": "world-a" });
  assert.equal(report.summary.converted, 1);
  assert.equal(report.summary.concreteFiles, 2);
  assert.equal(report.summary.cleanupEligibleFiles, 2);
  assert.match(report.dataRootId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(report.sourceManifest, undefined);
  assert.equal(report.dataRoot, undefined);
  assert.equal(fs.existsSync(path.join(data, "tokens", "icon1.webp")), true);
  assert.equal(fs.existsSync(path.join(data, "tokens", "iconA.webp")), true);
}));

test("cleanup quarantines only concrete reported files and restore reverses it", () => withCleanup((rootPath) => {
  const data = path.join(rootPath, "Data");
  fs.mkdirSync(path.join(data, "worlds", "world-a"), { recursive: true });
  const oldA = write(data, "tokens/a.png", makePng(3, 4, { payload: 100 }));
  const newA = write(data, "tokens/a.webp", makeWebp(3, 4));
  write(data, "tokens/new-after-report.png", makePng(3, 4, { payload: 100 }));
  write(data, "tokens/new-after-report.webp", makeWebp(3, 4));
  const root = cli.validateDataRoot(data);
  const pngInfo = cli.inspectPng(oldA);
  const webpInfo = cli.inspectWebp(newA);
  const migrationPath = path.join(rootPath, "migration.json");
  fs.writeFileSync(migrationPath, JSON.stringify({
    type: "fbl-webp-migrator-migration-report",
    sourceManifestId: "manifest-a",
    sourceDataRootId: root.id,
    worldId: "world-a",
    cleanupFiles: [{
      oldPath: "tokens/a.png",
      newPath: "tokens/a.webp",
      oldSha256: cli.sha256File(oldA),
      newSha256: cli.sha256File(newA),
      oldSize: fs.statSync(oldA).size,
      newSize: fs.statSync(newA).size,
      oldWidth: pngInfo.width,
      oldHeight: pngInfo.height,
      newWidth: webpInfo.width,
      newHeight: webpInfo.height
    }]
  }));

  const dryOut = path.join(rootPath, "cleanup-dry.json");
  const dry = cli.cleanup({ cleanup: migrationPath, data, out: dryOut, "world-id": "world-a" });
  assert.equal(dry.summary.wouldQuarantine, 1);
  assert.equal(fs.existsSync(oldA), true);

  const cleanupOut = path.join(rootPath, "cleanup.json");
  const cleanup = cli.cleanup({ cleanup: migrationPath, data, out: cleanupOut, delete: true, "world-id": "world-a" });
  assert.equal(cleanup.summary.quarantined, 1);
  assert.equal(fs.existsSync(oldA), false);
  assert.equal(fs.existsSync(path.join(data, "tokens", "new-after-report.png")), true);
  const quarantined = cleanup.entries[0].quarantinePath;
  assert.equal(fs.existsSync(path.join(data, ...quarantined.split("/"))), true);

  const restoreOut = path.join(rootPath, "restore.json");
  const restored = cli.restore({ restore: cleanupOut, data, out: restoreOut, "world-id": "world-a" });
  assert.equal(restored.summary.restored, 1);
  assert.equal(fs.existsSync(oldA), true);
}));

test("cleanup refuses changed hashes and permanent deletion needs two flags", () => withCleanup((rootPath) => {
  const data = path.join(rootPath, "Data");
  fs.mkdirSync(path.join(data, "worlds", "world-a"), { recursive: true });
  const oldA = write(data, "a.png", makePng(2, 2));
  const newA = write(data, "a.webp", makeWebp(2, 2));
  const root = cli.validateDataRoot(data);
  const migrationPath = path.join(rootPath, "migration.json");
  fs.writeFileSync(migrationPath, JSON.stringify({
    type: "fbl-webp-migrator-migration-report",
    sourceDataRootId: root.id,
    worldId: "world-a",
    cleanupFiles: [{
      oldPath: "a.png", newPath: "a.webp",
      oldSha256: "0".repeat(64), newSha256: cli.sha256File(newA),
      oldSize: fs.statSync(oldA).size, newSize: fs.statSync(newA).size,
      oldWidth: 2, oldHeight: 2, newWidth: 2, newHeight: 2
    }]
  }));
  assert.throws(() => cli.cleanup({ cleanup: migrationPath, data, "permanent-delete": true }), /requires --delete/);
  const report = cli.cleanup({ cleanup: migrationPath, data, delete: true, out: path.join(rootPath, "cleanup.json") });
  assert.equal(report.summary.skipped, 1);
  assert.equal(fs.existsSync(oldA), true);
}));

test("consistency audit identifies safe forward and reverse path repairs", () => withCleanup((rootPath) => {
  const data = path.join(rootPath, "Data");
  fs.mkdirSync(path.join(data, "worlds", "world-a"), { recursive: true });
  write(data, "art/forward.webp", makeWebp(4, 5));
  write(data, "art/reverse.png", makePng(6, 7));
  write(data, "art/stable.webp", makeWebp(8, 9));

  const ref = (format, oldPath, newPath) => ({
    uuid: `Actor.${oldPath}`,
    rootField: "img",
    fieldPath: ["img"],
    mode: "exact",
    sourceFormat: format,
    oldValue: oldPath,
    newValue: newPath,
    oldPath,
    newPath
  });
  const manifestPath = path.join(rootPath, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    type: "fbl-webp-migrator-manifest",
    schemaVersion: 4,
    version: "0.4.0",
    manifestId: "manifest-a",
    worldId: "world-a",
    capabilities: { pngReferenceScan: true, webpReferenceScan: true, consistencyAudit: true },
    entries: [{
      oldPath: "art/forward.png",
      newPath: "art/forward.webp",
      refs: [ref("png", "art/forward.png", "art/forward.webp")]
    }],
    webpEntries: [
      {
        oldPath: "art/reverse.png",
        newPath: "art/reverse.webp",
        refs: [ref("webp", "art/reverse.png", "art/reverse.webp")]
      },
      {
        oldPath: "art/stable.png",
        newPath: "art/stable.webp",
        refs: [ref("webp", "art/stable.png", "art/stable.webp")]
      },
      {
        oldPath: "art/missing.png",
        newPath: "art/missing.webp",
        refs: [ref("webp", "art/missing.png", "art/missing.webp")]
      }
    ]
  }));

  const out = path.join(rootPath, "consistency.json");
  const report = cli.audit({ audit: manifestPath, data, out, "world-id": "world-a" });
  assert.equal(report.summary.forwardRepairPaths, 1);
  assert.equal(report.summary.reverseRepairPaths, 1);
  assert.equal(report.summary.consistentPaths, 1);
  assert.equal(report.summary.unresolvedPaths, 1);
  assert.equal(report.entries.find((entry) => entry.oldPath === "art/forward.png").status, "repair-to-webp");
  assert.equal(report.entries.find((entry) => entry.oldPath === "art/reverse.png").status, "repair-to-png");
  assert.equal(report.entries.find((entry) => entry.oldPath === "art/stable.png").status, "consistent");
  assert.equal(report.entries.find((entry) => entry.oldPath === "art/missing.png").status, "unresolved");
  assert.match(report.dataRootId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(out), true);
}));

test("consistency audit refuses manifests without a complete WebP-reference scan", () => withCleanup((rootPath) => {
  const data = path.join(rootPath, "Data");
  fs.mkdirSync(path.join(data, "worlds", "world-a"), { recursive: true });
  const manifestPath = path.join(rootPath, "manifest-old.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    type: "fbl-webp-migrator-manifest",
    manifestId: "manifest-old",
    worldId: "world-a",
    entries: [],
    webpEntries: []
  }));
  assert.throws(() => cli.audit({ audit: manifestPath, data, "world-id": "world-a" }), /complete WebP-reference scan/);
}));
