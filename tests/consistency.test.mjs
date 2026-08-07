import test from "node:test";
import assert from "node:assert/strict";

import {
  applyConsistencyRepairs,
  applyMissingPlaceholderRepairs,
  sanitizeConsistencyReport
} from "../scripts/consistency.mjs";
import { rollbackMigration } from "../scripts/migration.mjs";

function applyDotted(target, key, value) {
  const segments = key.split(".").map((segment) => /^\d+$/.test(segment) ? Number(segment) : segment);
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = segments[index + 1];
    current[segment] ??= typeof next === "number" ? [] : {};
    current = current[segment];
  }
  current[segments.at(-1)] = structuredClone(value);
}

function mockDocument(source) {
  let data = structuredClone(source);
  return {
    uuid: "Actor.A",
    id: "A",
    documentName: "Actor",
    name: "Actor A",
    pack: null,
    toObject: () => structuredClone(data),
    async update(updateData) {
      for (const [key, value] of Object.entries(updateData)) applyDotted(data, key, value);
      return this;
    },
    current: () => structuredClone(data)
  };
}

function installMockGame(document) {
  globalThis.game = {
    user: { isGM: true },
    world: { id: "world-a", title: "World A" },
    packs: new Map()
  };
  globalThis.fromUuid = async (uuid) => uuid === document.uuid ? document : null;
}

function ref(oldPath, newPath, fieldPath, sourceFormat) {
  return {
    uuid: "Actor.A",
    documentName: "Actor",
    fieldPath,
    fieldLabel: fieldPath.join("."),
    rootField: fieldPath[0],
    mode: "exact",
    sourceFormat,
    oldValue: oldPath,
    newValue: newPath,
    oldPath,
    newPath
  };
}

function manifest() {
  const forward = ref("art/forward.png", "art/forward.webp", ["img"], "png");
  const reverse = ref("art/reverse.png", "art/reverse.webp", ["system", "back"], "webp");
  return {
    type: "fbl-webp-migrator-manifest",
    schemaVersion: 4,
    version: "0.4.0",
    manifestId: "manifest-a",
    worldId: "world-a",
    worldTitle: "World A",
    capabilities: { pngReferenceScan: true, webpReferenceScan: true, consistencyAudit: true },
    entries: [{ oldPath: forward.oldPath, newPath: forward.newPath, wildcard: false, refs: [forward] }],
    webpEntries: [{ oldPath: reverse.oldPath, newPath: reverse.newPath, wildcard: false, refs: [reverse] }]
  };
}

function rawReport() {
  const valid = (width, height) => ({
    exists: true,
    valid: true,
    animated: false,
    width,
    height,
    size: 100,
    mtimeMs: 1,
    sha256: "a".repeat(64)
  });
  const missing = { exists: false, valid: false, animated: false, width: null, height: null, size: null, mtimeMs: null, sha256: null };
  return {
    type: "fbl-webp-migrator-consistency-report",
    schemaVersion: 4,
    version: "0.4.0",
    producer: "test",
    sourceManifestId: "manifest-a",
    sourceWorldId: "world-a",
    dataRootId: `sha256:${"c".repeat(64)}`,
    // These forged flags and summary must not be trusted by the Foundry side.
    summary: { forwardRepairPaths: 0, reverseRepairPaths: 0 },
    entries: [
      {
        oldPath: "art/forward.png",
        newPath: "art/forward.webp",
        forwardAuthorized: false,
        reverseAuthorized: true,
        files: [{
          oldPath: "art/forward.png",
          newPath: "art/forward.webp",
          png: missing,
          webp: valid(10, 20)
        }]
      },
      {
        oldPath: "art/reverse.png",
        newPath: "art/reverse.webp",
        forwardAuthorized: true,
        reverseAuthorized: false,
        files: [{
          oldPath: "art/reverse.png",
          newPath: "art/reverse.webp",
          png: valid(30, 40),
          webp: missing
        }]
      }
    ]
  };
}

test("consistency report authorization is recalculated from verified file states", () => {
  globalThis.game = { world: { id: "world-a", title: "World A" } };
  const clean = sanitizeConsistencyReport(rawReport(), manifest(), "world-a");
  const forward = clean.entries.find((entry) => entry.oldPath === "art/forward.png");
  const reverse = clean.entries.find((entry) => entry.oldPath === "art/reverse.png");
  assert.equal(forward.forwardAuthorized, true);
  assert.equal(forward.reverseAuthorized, false);
  assert.equal(forward.status, "repair-to-webp");
  assert.equal(reverse.forwardAuthorized, false);
  assert.equal(reverse.reverseAuthorized, true);
  assert.equal(reverse.status, "repair-to-png");
  assert.equal(clean.summary.forwardRepairPaths, 1);
  assert.equal(clean.summary.reverseRepairPaths, 1);
});

test("safe consistency repairs work in both directions and rollback restores both fields", async () => {
  const document = mockDocument({ img: "art/forward.png", system: { back: "art/reverse.webp" } });
  installMockGame(document);
  const sourceManifest = manifest();
  const clean = sanitizeConsistencyReport(rawReport(), sourceManifest, "world-a");
  const migration = await applyConsistencyRepairs(sourceManifest, clean, {});

  assert.equal(document.current().img, "art/forward.webp");
  assert.equal(document.current().system.back, "art/reverse.png");
  assert.equal(migration.summary.changedReferences, 2);
  assert.equal(migration.summary.consistencyForwardPaths, 1);
  assert.equal(migration.summary.consistencyReversePaths, 1);
  assert.equal(migration.cleanupFiles.length, 0);
  assert.deepEqual(migration.changedRefs.map((item) => item.appliedDirection).sort(), ["forward", "reverse"]);

  const rollback = await rollbackMigration(migration, {});
  assert.equal(rollback.changed, 2);
  assert.equal(document.current().img, "art/forward.png");
  assert.equal(document.current().system.back, "art/reverse.webp");
});

test("old manifests cannot authorize a consistency repair", () => {
  globalThis.game = { world: { id: "world-a", title: "World A" } };
  const oldManifest = { ...manifest(), capabilities: { pngReferenceScan: true }, webpEntries: [] };
  assert.throws(() => sanitizeConsistencyReport(rawReport(), oldManifest, "world-a"), /полного сканирования WEBP/);
});

test("incomplete file evidence cannot authorize a path change", () => {
  globalThis.game = { world: { id: "world-a", title: "World A" } };
  const raw = rawReport();
  const file = raw.entries[0].files[0].webp;
  file.sha256 = null;
  const clean = sanitizeConsistencyReport(raw, manifest(), "world-a");
  const forward = clean.entries.find((entry) => entry.oldPath === "art/forward.png");
  assert.equal(forward.forwardAuthorized, false);
  assert.equal(forward.status, "unresolved");
  assert.match(forward.files[0].webp.error, /metadata is incomplete/);
});

test("missing or non-numeric schema versions cannot authorize consistency repair", () => {
  globalThis.game = { world: { id: "world-a", title: "World A" } };
  const noManifestSchema = { ...manifest() };
  delete noManifestSchema.schemaVersion;
  assert.throws(() => sanitizeConsistencyReport(rawReport(), noManifestSchema, "world-a"), /полного сканирования WEBP/);

  const noReportSchema = rawReport();
  delete noReportSchema.schemaVersion;
  assert.throws(() => sanitizeConsistencyReport(noReportSchema, manifest(), "world-a"), /устарел/);

  const invalidReportSchema = { ...rawReport(), schemaVersion: "not-a-number" };
  assert.throws(() => sanitizeConsistencyReport(invalidReportSchema, manifest(), "world-a"), /устарел/);
});

test("both-missing references can be replaced with the Foundry placeholder and rolled back", async () => {
  const document = mockDocument({ img: "art/missing.png", system: { back: "art/missing.webp" } });
  installMockGame(document);
  const pngRef = ref("art/missing.png", "art/missing.webp", ["img"], "png");
  const webpRef = ref("art/missing.png", "art/missing.webp", ["system", "back"], "webp");
  const sourceManifest = {
    type: "fbl-webp-migrator-manifest",
    schemaVersion: 4,
    version: "0.4.2",
    manifestId: "manifest-a",
    worldId: "world-a",
    worldTitle: "World A",
    capabilities: { pngReferenceScan: true, webpReferenceScan: true, consistencyAudit: true },
    entries: [{ oldPath: "art/missing.png", newPath: "art/missing.webp", wildcard: false, refs: [pngRef] }],
    webpEntries: [{ oldPath: "art/missing.png", newPath: "art/missing.webp", wildcard: false, refs: [webpRef] }]
  };
  const missing = { exists: false, valid: false, animated: false, width: null, height: null, size: null, mtimeMs: null, sha256: null };
  const raw = {
    type: "fbl-webp-migrator-consistency-report",
    schemaVersion: 4,
    version: "0.4.2",
    producer: "test",
    sourceManifestId: "manifest-a",
    sourceWorldId: "world-a",
    dataRootId: `sha256:${"c".repeat(64)}`,
    entries: [{
      oldPath: "art/missing.png",
      newPath: "art/missing.webp",
      files: [{ oldPath: "art/missing.png", newPath: "art/missing.webp", png: missing, webp: missing }]
    }]
  };

  const clean = sanitizeConsistencyReport(raw, sourceManifest, "world-a");
  assert.equal(clean.summary.placeholderRepairPaths, 1);
  assert.equal(clean.entries[0].placeholderAuthorized, true);
  assert.equal(clean.entries[0].status, "repair-to-placeholder");

  const migration = await applyMissingPlaceholderRepairs(sourceManifest, clean, {});
  assert.equal(document.current().img, "icons/svg/mystery-man.svg");
  assert.equal(document.current().system.back, "icons/svg/mystery-man.svg");
  assert.equal(migration.summary.changedReferences, 2);
  assert.equal(migration.summary.consistencyPlaceholderPaths, 1);
  assert.deepEqual(migration.changedRefs.map((item) => item.appliedDirection), ["placeholder", "placeholder"]);

  const rollback = await rollbackMigration(migration, {});
  assert.equal(rollback.changed, 2);
  assert.equal(document.current().img, "art/missing.png");
  assert.equal(document.current().system.back, "art/missing.webp");
});

