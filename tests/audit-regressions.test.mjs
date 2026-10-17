import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import cli from "../tools/convert-cwebp.js";
import { makePng, makeWebp, makeHeaderOnlyWebp, pngChunk } from "./image-fixtures.mjs";
import { collectPngReferences, collectWebpReferences, setAtPath } from "../scripts/path-utils.mjs";
import { groupReferences, sanitizeManifest } from "../scripts/scanner.mjs";
import { applyMigration, createAssumedConversionReport, mergeMigrationReports, rollbackMigration, sanitizeConversionReport, sanitizeMigrationReportForRollback } from "../scripts/migration.mjs";
import { applyConsistencyRepairs, applyMissingPlaceholderRepairs, sanitizeConsistencyReport } from "../scripts/consistency.mjs";

const worldId = "audit-world";
const rootId = `sha256:${"a".repeat(64)}`;
function document(id, source, { afterUpdate, rewrite, pack } = {}) {
  let data = structuredClone(source);
  return {
    id, uuid: `Actor.${id}`, documentName: "Actor", name: id, compendium: pack,
    toObject: () => structuredClone(data),
    current: () => structuredClone(data),
    async update(update) {
      // Foundry does not support numeric leaf updates inside ArrayField or
      // arrays stored in flags. Reject that payload rather than emulate support.
      for (const [key, value] of Object.entries(update)) {
        assert.ok(!key.split(".").some((segment) => /^\d+$/.test(segment)), `Unsafe array update: ${key}`);
        setAtPath(data, key.split("."), structuredClone(value));
      }
      rewrite?.(data);
      afterUpdate?.();
    }
  };
}
function installGame(documents) {
  globalThis.game = { user: { isGM: true }, world: { id: worldId }, packs: new Map() };
  globalThis.fromUuid = async (uuid) => documents.find((doc) => doc.uuid === uuid) ?? null;
}
function manifest(documents) {
  const collect = (fn) => documents.flatMap((doc) => fn(doc.toObject(), { documentInfo: { uuid: doc.uuid, rootUuid: doc.uuid, documentName: doc.documentName } }));
  return {
    type: "fbl-webp-migrator-manifest", schemaVersion: 4, manifestId: "audit-manifest", worldId,
    capabilities: { pngReferenceScan: true, webpReferenceScan: true, consistencyAudit: true },
    entries: groupReferences(collect(collectPngReferences)).entries,
    webpEntries: groupReferences(collect(collectWebpReferences)).entries
  };
}
function concrete(oldPath, overrides = {}) {
  return {
    oldPath, newPath: oldPath.replace(/\.png$/i, ".webp"), status: "converted", decoderVerified: true,
    oldSize: 100, newSize: 50, oldSha256: "a".repeat(64), newSha256: "b".repeat(64),
    oldWidth: 10, oldHeight: 20, newWidth: 10, newHeight: 20, oldMtimeMs: 1, newMtimeMs: 2,
    ...overrides
  };
}
function rawConversion(source, filesFor = (entry) => [concrete(entry.oldPath)]) {
  return {
    type: "fbl-webp-migrator-conversion-report", schemaVersion: 5, sourceManifestId: source.manifestId,
    sourceWorldId: worldId, dataRootId: rootId,
    entries: source.entries.map((entry) => ({ ...entry, status: "converted", files: filesFor(entry) }))
  };
}
function rawConsistency(source, filesFor = (entry) => [{ oldPath: entry.oldPath, newPath: entry.newPath, png: { exists: false }, webp: { exists: false } }]) {
  return {
    type: "fbl-webp-migrator-consistency-report", schemaVersion: 5, sourceManifestId: source.manifestId,
    sourceWorldId: worldId, dataRootId: rootId,
    entries: [...source.entries, ...source.webpEntries].map((entry) => ({ ...entry, files: filesFor(entry) }))
  };
}
async function temporary(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fwm-regression-"));
  const write = (relative, bytes) => {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  };
  try { return await run(directory, write); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); process.exitCode = undefined; }
}

test("A01: array updates and rollback preserve siblings, metadata and nested arrays", async () => {
  const before = { flags: { gallery: [{ img: "art/a.png", caption: "keep", variants: ["art/b.png", "other.jpg"] }, { img: "art/c.png", caption: "also keep" }] }, faces: [{ img: "art/d.png", name: "Ace", text: "valuable" }, { img: "other.jpg", name: "King" }] };
  const doc = document("Array", before);
  installGame([doc]);
  const source = manifest([doc]);
  const report = await applyMigration(source, createAssumedConversionReport(source));
  assert.equal(report.summary.errors, 0);
  assert.equal(report.changedRefs.length, 4);
  assert.deepEqual(doc.current(), JSON.parse(JSON.stringify(before).replaceAll(".png", ".webp")));
  assert.equal((await rollbackMigration(report)).errors, 0);
  assert.deepEqual(doc.current(), before);
});

test("normalized exact array leaves retain rollback history across report export and import", async () => {
  const before = {
    img: "art/a.png ",
    flags: { gallery: [{ img: "art/a.png ", caption: "keep", variants: ["art/b.png ", "other.jpg"] }, { img: "other.jpg", caption: "also keep" }] }
  };
  const doc = document("Normalized", before, { rewrite: (data) => {
    data.img = data.img.trim();
    data.flags.gallery[0].img = data.flags.gallery[0].img.trim();
    data.flags.gallery[0].variants[0] = data.flags.gallery[0].variants[0].trim();
  } });
  installGame([doc]);
  const source = manifest([doc]);
  const report = await applyMigration(source, sanitizeConversionReport(rawConversion(source), source, worldId));
  assert.equal(report.summary.errors, 0);
  assert.equal(report.changedRefs.length, 3);
  assert.equal(report.unverifiedWrites.length, 0);
  assert.equal(report.cleanupFiles.length, 2);
  assert.equal(source.entries[0].refs[0].newValue, "art/a.webp ", "manifest stays unchanged");
  const imported = sanitizeMigrationReportForRollback(JSON.parse(JSON.stringify(report)), worldId);
  const rollback = await rollbackMigration(imported);
  assert.equal(rollback.changed, 3);
  assert.equal(rollback.errors + rollback.stale, 0);
  const expected = structuredClone(before);
  expected.img = "art/a.png";
  expected.flags.gallery[0].img = "art/a.png";
  expected.flags.gallery[0].variants[0] = "art/b.png";
  assert.deepEqual(doc.current(), expected);
  assert.equal((await rollbackMigration(imported)).already, 3);
});

test("normalized exact rollback refuses later edits and unrelated saved-value metadata", async () => {
  const doc = document("EditedNormalized", { faces: [{ img: "art/a.png " }] }, {
    rewrite: (data) => { data.faces[0].img = data.faces[0].img.trim(); }
  });
  installGame([doc]);
  const source = manifest([doc]);
  const report = await applyMigration(source, createAssumedConversionReport(source));
  await doc.update({ faces: [{ img: "art/a.webp?user-edit=1" }] });
  assert.equal((await rollbackMigration(report)).stale, 1);
  assert.equal(doc.current().faces[0].img, "art/a.webp?user-edit=1");
  await doc.update({ faces: [{ img: "art/unrelated.webp" }] });
  report.changedRefs[0].savedValue = "art/unrelated.webp";
  const imported = sanitizeMigrationReportForRollback(JSON.parse(JSON.stringify(report)), worldId);
  assert.equal((await rollbackMigration(imported)).stale, 1);
  assert.equal(doc.current().faces[0].img, "art/unrelated.webp");
});

test("normalized reverse repair inside an array retains its forward rollback", async () => {
  const doc = document("ReverseNormalized", { faces: [{ img: "art/a.webp ", name: "keep" }] }, {
    rewrite: (data) => { data.faces[0].img = data.faces[0].img.trim(); }
  });
  installGame([doc]);
  const source = manifest([doc]);
  const raw = rawConsistency(source, (entry) => [{ oldPath: entry.oldPath, newPath: entry.newPath,
    png: { exists: true, checked: true, valid: true, decoded: true, width: 10, height: 20, size: 100, sha256: "a".repeat(64), mtimeMs: 1 },
    webp: { exists: false } }]);
  const report = await applyConsistencyRepairs(source, sanitizeConsistencyReport(raw, source, worldId));
  assert.equal(report.summary.errors, 0);
  assert.equal(report.changedRefs.length, 1);
  assert.equal(report.changedRefs[0].appliedDirection, "reverse");
  assert.equal(doc.current().faces[0].img, "art/a.png");
  const imported = sanitizeMigrationReportForRollback(JSON.parse(JSON.stringify(report)), worldId);
  assert.equal((await rollbackMigration(imported)).changed, 1);
  assert.deepEqual(doc.current().faces, [{ img: "art/a.webp", name: "keep" }]);
  assert.equal((await rollbackMigration(imported)).already, 1);
});

test("array normalization allowance rejects sibling edits, missing elements and modified text", async () => {
  const rewrites = [
    (data) => { data.flags.gallery[0].caption = "changed"; },
    (data) => { data.flags.gallery.pop(); },
    (data) => { data.flags.gallery.reverse(); },
    (data) => { data.flags.gallery[0].img = "art/unexpected.webp"; },
    (data) => { data.flags.gallery[0].html += "<p>Unrelated edit</p>"; }
  ];
  for (const rewrite of rewrites) {
    const doc = document("Damaged", { flags: { gallery: [
      { img: "art/a.png ", caption: "keep", html: '<img src="art/b.png">' },
      { img: "other.jpg", caption: "keep too" }
    ] } }, { rewrite: (data) => {
      data.flags.gallery[0].img = data.flags.gallery[0].img.trim();
      rewrite(data);
    } });
    installGame([doc]);
    const source = manifest([doc]);
    const report = await applyMigration(source, sanitizeConversionReport(rawConversion(source), source, worldId));
    assert.equal(report.summary.errors, 2);
    assert.equal(report.changedRefs.length, 0);
    assert.equal(report.unverifiedWrites.length, 2);
    assert.deepEqual(report.cleanupFiles, []);
  }
});

test("A02: an unmigrated exact alias blocks cleanup authorized by an overlapping wildcard", async () => {
  const wildcard = document("Wildcard", { img: "art/*.png" });
  const locked = document("Locked", { img: "art/a.png" }, { pack: { collection: "module.locked", locked: true, metadata: { packageType: "module" } } });
  installGame([wildcard, locked]);
  const source = manifest([wildcard, locked]);
  const conversion = sanitizeConversionReport(rawConversion(source, () => [concrete("art/a.png")]), source, worldId);
  const report = await applyMigration(source, conversion);
  assert.equal(wildcard.current().img, "art/*.webp");
  assert.equal(locked.current().img, "art/a.png");
  assert.deepEqual(report.cleanupFiles, []);
  const old = { ...report, cleanupFiles: [{ ...concrete("art/a.png"), manifestOldPath: "art/*.png" }] };
  const merged = mergeMigrationReports(old, { ...report, migrated: [], skipped: [{ oldPath: "art/a.png" }], changedRefs: [] });
  assert.deepEqual(merged.cleanupFiles, []);
});

test("A03: partial rollback revokes cleanup before any document changes", async () => {
  const doc = document("Partial", { img: "art/a.png" });
  installGame([doc]);
  const source = manifest([doc]);
  const report = await applyMigration(source, sanitizeConversionReport(rawConversion(source), source, worldId));
  assert.equal(report.cleanupFiles.length, 1);
  await doc.update({ img: "user-edit.webp" });
  assert.equal((await rollbackMigration(report)).stale, 1);
  assert.deepEqual(report.cleanupFiles, []);
  assert.equal(report.summary.cleanupEligibleFiles, 0);
  assert.equal(report.changedRefs.length, 1);
});

test("A04: an undecodable WebP cannot authorize conversion, audit or deletion", () => temporary(async (directory, write) => {
  const png = write("art/a.png", makePng(64, 64));
  const webp = write("art/a.webp", makeHeaderOnlyWebp());
  const root = cli.validateDataRoot(directory);
  assert.equal(cli.inspectWebp(webp).valid, false);
  assert.equal(cli.convertConcrete(root, "art/a.png", {}).status, "failed");
  assert.equal(cli.auditConcrete(root, "art/a.png", "art/a.webp").forwardSafe, false);
  const cleanup = cli.cleanupConcrete(root, cli.sanitizeCleanupFile({ ...concrete("art/a.png"), oldSize: fs.statSync(png).size, newSize: fs.statSync(webp).size, oldSha256: cli.sha256File(png), newSha256: cli.sha256File(webp) }), { mode: "delete" });
  assert.equal(cleanup.status, "skipped");
  assert.ok(fs.existsSync(png));
}));

test("A04: malformed PNG CRC, zlib stream and row filters are rejected even by permissive platform decoders", () => temporary(async (_directory, write) => {
  const bytes = makePng(2, 3);
  const crc = Buffer.from(bytes); crc[29] ^= 1;
  assert.equal(cli.inspectPng(write("crc.png", crc)).valid, false);
  const broken = Buffer.concat([bytes.subarray(0, 33), pngChunk("IDAT", Buffer.from([1])), pngChunk("IEND")]);
  assert.equal(cli.inspectPng(write("zlib.png", broken)).valid, false);
  const pixels = Buffer.alloc(27); pixels[0] = 5;
  const badFilter = Buffer.concat([bytes.subarray(0, 33), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND")]);
  assert.equal(cli.inspectPng(write("filter.png", badFilter)).valid, false);
  const actl = Buffer.alloc(8); actl.writeUInt32BE(1);
  const animated = Buffer.concat([bytes.subarray(0, 33), pngChunk("acTL", actl), pngChunk("IDAT", Buffer.from([1])), pngChunk("IEND")]);
  assert.equal(cli.inspectPng(write("broken-apng.png", animated)).animated, true);
}));

test("A05: cancellation returns the partial journal and permits rollback", async () => {
  const controller = new AbortController();
  const first = document("First", { img: "art/a.png" }, { afterUpdate: () => controller.abort() });
  const second = document("Second", { img: "art/b.png" });
  installGame([first, second]);
  const source = manifest([first, second]);
  const report = await applyMigration(source, createAssumedConversionReport(source), {}, { signal: controller.signal });
  assert.equal(report.cancelled, true);
  assert.equal(report.changedRefs.length, 1);
  assert.equal(first.current().img, "art/a.webp");
  assert.equal(second.current().img, "art/b.png");
  await rollbackMigration(report);
  assert.equal(first.current().img, "art/a.png");
});

test("A06: placeholder rollback restores distinct URLs and a pre-existing identical placeholder", async () => {
  const original = '<img src="missing/a.png"><img src="missing/b.png"><img src="icons/svg/mystery-man.svg">';
  const doc = document("Text", { html: original });
  installGame([doc]);
  const source = manifest([doc]);
  const report = await applyMissingPlaceholderRepairs(source, sanitizeConsistencyReport(rawConsistency(source), source, worldId));
  assert.equal(report.changedRefs.length, 2);
  assert.equal(report.textChanges.length, 1);
  const imported = sanitizeMigrationReportForRollback(JSON.parse(JSON.stringify(report)), worldId);
  const rollback = await rollbackMigration(imported);
  assert.equal(rollback.errors + rollback.stale, 0);
  assert.equal(rollback.changed, 2);
  assert.equal(doc.current().html, original);
});

test("text journal merge unwinds sequential operations in reverse order and refuses later edits", async () => {
  const original = '<img src="art/a.png"><img src="missing/b.png">';
  const doc = document("TextChain", { html: original });
  installGame([doc]);
  const source = manifest([doc]);
  source.entries = source.entries.filter((entry) => entry.oldPath === "art/a.png");
  const first = await applyMigration(source, createAssumedConversionReport(source));
  const next = manifest([doc]);
  const second = await applyMissingPlaceholderRepairs(next, sanitizeConsistencyReport(rawConsistency(next), next, worldId));
  const merged = mergeMigrationReports(first, second);
  assert.equal(merged.textChanges.length, 2);
  const edited = `${doc.current().html}<p>User edit</p>`;
  await doc.update({ html: edited });
  assert.ok((await rollbackMigration(merged)).stale > 0);
  assert.equal(doc.current().html, edited);
  await doc.update({ html: second.textChanges[0].after });
  assert.equal((await rollbackMigration(merged)).stale, 0);
  assert.equal(doc.current().html, original);
  // A caller may retry using the original exported report, without updated
  // in-memory rolledBack flags. The continuous history is still recognized.
  const retry = mergeMigrationReports(first, second);
  for (const change of retry.textChanges) delete change.rolledBack;
  assert.equal((await rollbackMigration(retry)).stale, 0);
  assert.equal(doc.current().html, original);
});

test("legacy ambiguous placeholder reports cannot replace every identical SVG in text", async () => {
  const doc = document("Legacy", { html: '<img src="missing/a.png"><img src="icons/svg/mystery-man.svg">' });
  installGame([doc]);
  const source = manifest([doc]);
  const report = await applyMissingPlaceholderRepairs(source, sanitizeConsistencyReport(rawConsistency(source), source, worldId));
  const after = doc.current().html;
  delete report.textChanges;
  assert.equal((await rollbackMigration(report)).stale, 1);
  assert.equal(doc.current().html, after);
});

test("A07: executable cleanup and restore honor --dry-run including permanent-delete", () => temporary(async (directory, write) => {
  fs.mkdirSync(path.join(directory, "worlds", worldId), { recursive: true });
  const png = write("art/a.png", makePng());
  const webp = write("art/a.webp", makeWebp());
  const file = { ...concrete("art/a.png"), oldSize: fs.statSync(png).size, newSize: fs.statSync(webp).size, oldWidth: 2, oldHeight: 3, newWidth: 2, newHeight: 3, oldSha256: cli.sha256File(png), newSha256: cli.sha256File(webp) };
  const migration = write("migration.json", JSON.stringify({ type: "fbl-webp-migrator-migration-report", schemaVersion: 5, worldId, sourceDataRootId: cli.validateDataRoot(directory).id, cleanupFiles: [file] }));
  const run = (args) => {
    const result = spawnSync(process.execPath, [path.resolve("tools/convert-cwebp.js"), ...args, "--data", directory], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  };
  const cleanupOut = path.join(directory, "cleanup.json");
  run(["--cleanup", migration, "--delete", "--permanent-delete", "--dry-run", "--out", cleanupOut]);
  assert.ok(fs.existsSync(png));
  assert.equal(JSON.parse(fs.readFileSync(cleanupOut)).mode, "dry-run");
  run(["--cleanup", migration, "--delete", "--out", cleanupOut]);
  assert.equal(fs.existsSync(png), false);
  const restoreOut = path.join(directory, "restore.json");
  run(["--restore", cleanupOut, "--dry-run", "--out", restoreOut]);
  assert.equal(fs.existsSync(png), false);
  assert.equal(JSON.parse(fs.readFileSync(restoreOut)).summary.wouldRestore, 1);
  run(["--restore", cleanupOut, "--out", restoreOut]);
  assert.ok(fs.existsSync(png));
}));

test("A08: verification blocks cleanup when a hook leaves the original PNG in HTML", async () => {
  const doc = document("Hook", { html: '<img src="art/a.png">' }, { rewrite: (data) => { data.html += '<img src="art/a.png">'; } });
  installGame([doc]);
  const source = manifest([doc]);
  const report = await applyMigration(source, sanitizeConversionReport(rawConversion(source), source, worldId));
  assert.equal(report.cleanupFiles.length, 0);
  assert.equal(report.summary.errors, 1);
  assert.equal(report.unverifiedWrites.length, 1);
});

test("A09: prose ending in an image URL stays a text reference during placeholder repair", async () => {
  const original = "Illustration: art/normal.png";
  const doc = document("Prose", { text: original });
  installGame([doc]);
  const source = manifest([doc]);
  assert.equal(source.entries[0].oldPath, "art/normal.png");
  assert.equal(source.entries[0].refs[0].mode, "text");
  const report = await applyMissingPlaceholderRepairs(source, sanitizeConsistencyReport(rawConsistency(source), source, worldId));
  assert.equal(doc.current().text, "Illustration: icons/svg/mystery-man.svg");
  await rollbackMigration(report);
  assert.equal(doc.current().text, original);
});

test("A10: incomplete fingerprints, dimensions, decoder evidence or root never become verified", () => {
  const source = manifest([document("Evidence", { img: "art/a.png" })]);
  for (const field of ["oldSize", "newSize", "oldSha256", "newSha256", "oldWidth", "newHeight", "oldMtimeMs", "newMtimeMs", "decoderVerified"]) {
    const raw = rawConversion(source); delete raw.entries[0].files[0][field];
    assert.equal(sanitizeConversionReport(raw, source, worldId).entries[0].verified, false, field);
  }
  const raw = rawConversion(source); delete raw.dataRootId;
  assert.throws(() => sanitizeConversionReport(raw, source, worldId), /Data root/);
  const old = rawConversion(source); old.schemaVersion = 4;
  assert.throws(() => sanitizeConversionReport(old, source, worldId), /устарел/);
  const mixed = rawConversion(source); mixed.entries[0].files.push(concrete("elsewhere.png"));
  assert.equal(sanitizeConversionReport(mixed, source, worldId).entries[0].verified, false);
});

test("A11: absent or malformed existence evidence is unknown, not both-missing", () => {
  const source = manifest([document("Unknown", { img: "art/a.png" })]);
  for (const png of [undefined, {}, { exists: "false" }, { valid: false }]) {
    const raw = rawConsistency(source, (entry) => [{ oldPath: entry.oldPath, newPath: entry.newPath, png, webp: { exists: false } }]);
    const entry = sanitizeConsistencyReport(raw, source, worldId).entries[0];
    assert.equal(entry.placeholderAuthorized, false);
    assert.equal(entry.forwardAuthorized, false);
    assert.equal(entry.files[0].category, "unresolved");
  }
  const raw = rawConsistency(source);
  raw.entries[0].files[0].png = { exists: true, checked: true, valid: true, decoded: true };
  raw.entries[0].files[0].webp = { exists: true, checked: true, valid: true, decoded: true, width: 10, height: 20, size: 50, sha256: "a".repeat(64), mtimeMs: 1 };
  assert.equal(sanitizeConsistencyReport(raw, source, worldId).entries[0].forwardAuthorized, false);
});

test("A12: an older WebP with matching dimensions is blocked by CLI and imported audit", () => temporary(async (directory, write) => {
  const png = write("art/a.png", makePng());
  const webp = write("art/a.webp", makeWebp());
  fs.utimesSync(webp, new Date(10000), new Date(10000));
  fs.utimesSync(png, new Date(20000), new Date(20000));
  const file = cli.auditConcrete(cli.validateDataRoot(directory), "art/a.png", "art/a.webp");
  assert.equal(file.forwardSafe, false);
  const source = manifest([document("Stale", { img: "art/a.png" })]);
  assert.equal(sanitizeConsistencyReport(rawConsistency(source, () => [file]), source, worldId).entries[0].forwardAuthorized, false);
}));

test("A13: wildcard import uses server case semantics and scans retain case aliases", async () => {
  const docs = [document("Lower", { img: "caps/*.png" }), document("Upper", { img: "Caps/Hero.PNG" })];
  const source = manifest(docs);
  assert.equal(source.entries.length, 2);
  const raw = rawConversion(source, () => [concrete("Caps/Hero.PNG")]);
  raw.caseInsensitivePaths = true;
  const report = sanitizeConversionReport(raw, source, worldId);
  assert.equal(report.summary.verifiedEntries, 2);
  raw.caseInsensitivePaths = false;
  assert.equal(sanitizeConversionReport(raw, source, worldId).entries.find((entry) => entry.wildcard).verified, false);
  installGame(docs);
  const migrated = await applyMigration(source, report);
  assert.equal(migrated.changedRefs.length, 2);
  assert.equal(migrated.cleanupFiles.length, 1);
});

test("cleanup deduplicates case aliases only under the report case rule", () => temporary(async (directory, write) => {
  fs.mkdirSync(path.join(directory, "worlds", worldId), { recursive: true });
  const pngBytes = makePng();
  const webpBytes = makeWebp();
  // Both spellings exist on Linux; on Windows they address the same files.
  write("art/A.png", pngBytes);
  write("art/A.webp", webpBytes);
  const png = write("art/a.png", pngBytes);
  const webp = write("art/a.webp", webpBytes);
  const file = { ...concrete("art/a.png"), oldSize: pngBytes.length, newSize: webpBytes.length,
    oldWidth: 2, oldHeight: 3, newWidth: 2, newHeight: 3,
    oldSha256: cli.sha256File(png), newSha256: cli.sha256File(webp) };
  const migration = { type: "fbl-webp-migrator-migration-report", schemaVersion: 5, worldId,
    sourceDataRootId: cli.validateDataRoot(directory).id,
    cleanupFiles: [{ ...file, oldPath: "art/A.png", newPath: "art/A.webp" }, file] };
  const reportPath = path.join(directory, "migration.json");
  const out = path.join(directory, "cleanup.json");
  for (const caseInsensitivePaths of [undefined, false, true]) {
    write("migration.json", JSON.stringify({ ...migration, caseInsensitivePaths }));
    const dry = cli.cleanup({ cleanup: reportPath, data: directory, out, "dry-run": true });
    assert.equal(dry.summary.concreteFiles, caseInsensitivePaths === true ? 1 : 2);
    assert.equal(dry.summary.wouldQuarantine, dry.summary.concreteFiles);
    assert.ok(fs.existsSync(png));
  }
  const quarantined = cli.cleanup({ cleanup: reportPath, data: directory, out, delete: true });
  assert.equal(quarantined.summary.quarantined, 1);
  assert.equal(quarantined.summary.missingOld, 0);
  assert.equal(quarantined.entries.length, 1);
  assert.equal(fs.existsSync(png), false);
  assert.equal(cli.restore({ restore: out, data: directory, out: path.join(directory, "restore.json") }).summary.restored, 1);
  const deleted = cli.cleanup({ cleanup: reportPath, data: directory, out, delete: true, "permanent-delete": true });
  assert.equal(deleted.summary.deleted, 1);
  assert.equal(deleted.summary.missingOld, 0);
  assert.equal(deleted.entries.length, 1);
  assert.equal(fs.existsSync(png), false);
}));

test("A14: URL decoding happens once through scan, import, CLI, migration and rollback", () => temporary(async (directory, write) => {
  write("percent/foo%20bar.png", makePng(8, 8, { payload: 200 }));
  const doc = document("Percent", { img: "percent/foo%2520bar.png?v=1#preview" });
  installGame([doc]);
  const source = sanitizeManifest(manifest([doc]), worldId);
  assert.equal(source.entries[0].oldPath, "percent/foo%20bar.png");
  const converted = cli.convertManifestEntry(cli.validateDataRoot(directory), source.entries[0], { cwebp: process.env.FWM_CWEBP || "cwebp", quality: 85, method: 6 });
  assert.equal(converted.status, "converted");
  const raw = rawConversion(source); raw.entries = [converted];
  const report = await applyMigration(source, sanitizeConversionReport(raw, source, worldId));
  assert.equal(doc.current().img, "percent/foo%2520bar.webp?v=1#preview");
  assert.ok(fs.existsSync(path.join(directory, "percent/foo%20bar.webp")));
  await rollbackMigration(report);
  assert.equal(doc.current().img, "percent/foo%2520bar.png?v=1#preview");
}));

test("legacy case-folded manifests preserve every alias when imported on a different client OS", () => {
  const docs = [document("Lower", { img: "art/a.png" }), document("Upper", { img: "Art/A.PNG" })];
  const source = manifest(docs);
  source.entries = groupReferences(source.entries.flatMap((entry) => entry.refs), { caseInsensitive: true }).entries;
  assert.equal(source.entries.length, 1);
  const imported = sanitizeManifest(source, worldId);
  assert.equal(imported.entries.length, 2);
  assert.equal(imported.entries.flatMap((entry) => entry.refs).length, 2);
});

test("literal percent-encoded Core directory names are not URL-decoded on manifest import", () => {
  const source = manifest([document("Literal", { img: "%2569cons/a.png" })]);
  assert.equal(source.entries[0].oldPath, "%69cons/a.png");
  assert.equal(sanitizeManifest(source, worldId).entries[0].oldPath, "%69cons/a.png");
});

test("consistency cancellation preserves the first phase's journal for rollback", async () => {
  const controller = new AbortController();
  const first = document("Forward", { img: "art/a.png" }, { afterUpdate: () => controller.abort() });
  const second = document("Reverse", { img: "art/b.webp" });
  installGame([first, second]);
  const source = manifest([first, second]);
  const valid = { exists: true, checked: true, decoded: true, valid: true, width: 10, height: 20, size: 50, sha256: "a".repeat(64), mtimeMs: 1 };
  const raw = rawConsistency(source, (entry) => [{ oldPath: entry.oldPath, newPath: entry.newPath,
    png: entry.oldPath === "art/a.png" ? { exists: false } : valid,
    webp: entry.oldPath === "art/a.png" ? valid : { exists: false } }]);
  const report = await applyConsistencyRepairs(source, sanitizeConsistencyReport(raw, source, worldId), {}, { signal: controller.signal });
  assert.equal(report.cancelled, true);
  assert.equal(report.changedRefs.length, 1);
  assert.equal(second.current().img, "art/b.webp");
  await rollbackMigration(report);
  assert.equal(first.current().img, "art/a.png");
});

test("invalid or missing decoder executables stop validation instead of authorizing repairs", () => {
  assert.throws(() => cli.configureDecoders({ cwebp: "fwm-nonexistent-decoder" }), /unavailable/);
});

test("mode-incompatible CLI flags are rejected", () => {
  assert.throws(() => cli.validateModeOptions({ restore: "report.json", delete: true }), /cannot be used/);
  assert.throws(() => cli.validateModeOptions({ audit: "manifest.json", overwrite: true }), /cannot be used/);
});

test("sanitized audit evidence can be re-imported without losing validation markers", () => {
  const source = manifest([document("Twice", { img: "art/a.png" })]);
  const raw = rawConsistency(source);
  raw.entries[0].files[0].webp = { exists: true, checked: true, valid: true, decoded: true, width: 10, height: 20, size: 50, sha256: "a".repeat(64), mtimeMs: 1 };
  const first = sanitizeConsistencyReport(raw, source, worldId);
  const second = sanitizeConsistencyReport(JSON.parse(JSON.stringify(first)), source, worldId);
  assert.equal(second.entries[0].forwardAuthorized, true);
});

test("a current conversion failure revokes older overlapping wildcard cleanup after report merge", async () => {
  const doc = document("FailedEvidence", { img: "art/*.png", flags: { img: "art/a.png" } });
  installGame([doc]);
  const source = manifest([doc]);
  const raw = rawConversion(source, (entry) => [concrete("art/a.png", entry.wildcard ? {} : { status: "failed" })]);
  const current = await applyMigration(source, sanitizeConversionReport(raw, source, worldId));
  const previous = { worldId, cleanupFiles: [{ ...concrete("art/a.png"), manifestOldPath: "art/*.png" }], changedRefs: [] };
  assert.equal(current.skipped.length, 1);
  assert.equal(mergeMigrationReports(previous, current).cleanupFiles.length, 0);
});

test("a fresh verified migration can grant cleanup again after rollback", async () => {
  const doc = document("Again", { img: "art/a.png" });
  installGame([doc]);
  const source = manifest([doc]);
  const conversion = sanitizeConversionReport(rawConversion(source), source, worldId);
  const first = await applyMigration(source, conversion);
  await rollbackMigration(first);
  const second = await applyMigration(source, conversion);
  const merged = mergeMigrationReports(first, second);
  assert.equal(merged.cleanupFiles.length, 1);
  assert.equal(merged.cleanupRevoked, false);
});

test("prose detection preserves apostrophes and spaces in actual image filenames", () => {
  const refs = collectPngReferences({ img: "art/Bob's shield.png", html: '<img src="art/Bob\'s shield.png">' });
  assert.equal(refs.length, 2);
  assert.equal(refs.find((ref) => ref.mode === "exact").oldPath, "art/Bob's shield.png");
  assert.equal(refs.find((ref) => ref.mode === "text").oldPath, "art/Bob's shield.png");
});
