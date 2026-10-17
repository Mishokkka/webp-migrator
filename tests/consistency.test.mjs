import test from "node:test";
import assert from "node:assert/strict";

import {
  applyConsistencyRepairs,
  applyMissingPlaceholderRepairs,
  repairImageHoverSpecificArtOverrides,
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
    schemaVersion: 5,
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
    checked: true,
    decoded: true,
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
    schemaVersion: 5,
    version: "0.4.0",
    producer: "test",
    caseInsensitivePaths: true,
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
    schemaVersion: 5,
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
    schemaVersion: 5,
    version: "0.4.2",
    producer: "test",
    caseInsensitivePaths: true,
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

test("missing Image Hover specific-art overrides reset to the module sentinel instead of mystery-man", async () => {
  const document = mockDocument({
    prototypeToken: { flags: { "image-hover": { specificArt: "art/deleted.png" } } }
  });
  installMockGame(document);
  const hoverRef = ref(
    "art/deleted.png",
    "art/deleted.webp",
    ["prototypeToken", "flags", "image-hover", "specificArt"],
    "png"
  );
  const sourceManifest = {
    type: "fbl-webp-migrator-manifest",
    schemaVersion: 5,
    version: "0.4.4",
    manifestId: "manifest-hover",
    worldId: "world-a",
    worldTitle: "World A",
    capabilities: { pngReferenceScan: true, webpReferenceScan: true, consistencyAudit: true },
    entries: [{ oldPath: "art/deleted.png", newPath: "art/deleted.webp", wildcard: false, refs: [hoverRef] }],
    webpEntries: []
  };
  const missing = { exists: false, valid: false, animated: false, width: null, height: null, size: null, mtimeMs: null, sha256: null };
  const raw = {
    type: "fbl-webp-migrator-consistency-report",
    schemaVersion: 5,
    version: "0.4.4",
    producer: "test",
    caseInsensitivePaths: true,
    sourceManifestId: "manifest-hover",
    sourceWorldId: "world-a",
    dataRootId: `sha256:${"c".repeat(64)}`,
    entries: [{
      oldPath: "art/deleted.png",
      newPath: "art/deleted.webp",
      files: [{ oldPath: "art/deleted.png", newPath: "art/deleted.webp", png: missing, webp: missing }]
    }]
  };

  const clean = sanitizeConsistencyReport(raw, sourceManifest, "world-a");
  const migration = await applyMissingPlaceholderRepairs(sourceManifest, clean, {});
  assert.equal(document.current().prototypeToken.flags["image-hover"].specificArt, "path/image.png");
  assert.equal(migration.changedRefs[0].placeholderValue, "path/image.png");

  const rollback = await rollbackMigration(migration, {});
  assert.equal(rollback.changed, 1);
  assert.equal(document.current().prototypeToken.flags["image-hover"].specificArt, "art/deleted.png");
});

test("repairs legacy 0.4.2/0.4.3 mystery-man Image Hover overrides", async () => {
  const document = mockDocument({
    prototypeToken: { flags: { "image-hover": { specificArt: "icons/svg/mystery-man.svg" } } }
  });
  installMockGame(document);
  globalThis.game.actors = new Map([[document.id, document]]);
  globalThis.game.scenes = new Map();

  const result = await repairImageHoverSpecificArtOverrides({
    worldActors: true,
    worldScenes: true,
    worldCompendiums: false,
    packageCompendiums: false
  });
  assert.equal(result.scannedReferences, 1);
  assert.equal(result.changed, 1);
  assert.equal(result.errors, 0);
  assert.equal(document.current().prototypeToken.flags["image-hover"].specificArt, "path/image.png");
});

test("placeholder repair resolves case-only PNG/WEBP aliases on case-insensitive platforms", async () => {
  const originalProcess = globalThis.process;
  try {
    globalThis.process = { ...originalProcess, platform: "win32" };
    const document = mockDocument({ img: "Art/Missing.png", system: { back: "art/missing.webp" } });
    installMockGame(document);
    const pngRef = ref("Art/Missing.png", "Art/Missing.webp", ["img"], "png");
    pngRef.oldPath = "Art/Missing.png";
    pngRef.newPath = "Art/Missing.webp";
    pngRef.oldValue = "Art/Missing.png";
    pngRef.newValue = "Art/Missing.webp";
    const webpRef = ref("art/missing.png", "art/missing.webp", ["system", "back"], "webp");
    webpRef.oldPath = "art/missing.png";
    webpRef.newPath = "art/missing.webp";
    webpRef.oldValue = "art/missing.png";
    webpRef.newValue = "art/missing.webp";
    const sourceManifest = {
      type: "fbl-webp-migrator-manifest",
      schemaVersion: 5,
      version: "0.4.3",
      manifestId: "manifest-a",
      worldId: "world-a",
      worldTitle: "World A",
      capabilities: { pngReferenceScan: true, webpReferenceScan: true, consistencyAudit: true },
      entries: [{ oldPath: "Art/Missing.png", newPath: "Art/Missing.webp", wildcard: false, refs: [pngRef] }],
      webpEntries: [{ oldPath: "art/missing.png", newPath: "art/missing.webp", wildcard: false, refs: [webpRef] }]
    };
    const missing = { exists: false, valid: false, animated: false, width: null, height: null, size: null, mtimeMs: null, sha256: null };
    const raw = {
      caseInsensitivePaths: true,
      type: "fbl-webp-migrator-consistency-report",
      schemaVersion: 5,
      version: "0.4.3",
      producer: "test",
    caseInsensitivePaths: true,
      sourceManifestId: "manifest-a",
      sourceWorldId: "world-a",
      dataRootId: `sha256:${"c".repeat(64)}`,
      entries: [{
        oldPath: "Art/Missing.png",
        newPath: "Art/Missing.webp",
        files: [{ oldPath: "Art/Missing.png", newPath: "Art/Missing.webp", png: missing, webp: missing }]
      }]
    };

    const clean = sanitizeConsistencyReport(raw, sourceManifest, "world-a");
    const migration = await applyMissingPlaceholderRepairs(sourceManifest, clean, {});
    assert.equal(document.current().img, "icons/svg/mystery-man.svg");
    assert.equal(document.current().system.back, "icons/svg/mystery-man.svg");
    assert.equal(migration.summary.changedReferences, 2);
  } finally {
    globalThis.process = originalProcess;
  }
});


test("Image Hover recovery ignores ordinary scan checkboxes and repairs embedded Token plus ActorDelta remnants", async () => {
  let tokenData = {
    _id: "T",
    flags: { "image-hover": { specificArt: "icons/svg/mystery-man.svg" } },
    delta: {
      _id: "D",
      prototypeToken: { flags: { "image-hover": { specificArt: "icons/svg/mystery-man.svg" } } }
    }
  };

  const scene = {
    uuid: "Scene.S",
    id: "S",
    documentName: "Scene",
    name: "Scene S",
    pack: null,
    tokens: new Map(),
    toObject: () => ({ _id: "S", tokens: [structuredClone(tokenData)] }),
    getEmbeddedDocument(documentName, id) {
      if (documentName === "Token" && id === "T") return token;
      return null;
    },
    *traverseEmbeddedDocuments() {
      yield ["Token", token];
      yield ["ActorDelta", delta];
    },
    async updateEmbeddedDocuments(documentName, updates) {
      assert.equal(documentName, "Token");
      for (const update of updates) {
        assert.equal(update._id, "T");
        for (const [key, value] of Object.entries(update)) {
          if (key !== "_id") applyDotted(tokenData, key, value);
        }
      }
      return [token];
    }
  };
  const token = {
    uuid: "Scene.S.Token.T",
    id: "T",
    documentName: "Token",
    name: "Token T",
    parent: scene,
    pack: null,
    constructor: { metadata: { embedded: { ActorDelta: "delta" } } },
    toObject: () => structuredClone(tokenData)
  };
  const delta = {
    uuid: "Scene.S.Token.T.ActorDelta.D",
    id: "D",
    documentName: "ActorDelta",
    name: "Delta D",
    parent: token,
    pack: null,
    toObject: () => structuredClone(tokenData.delta)
  };
  scene.tokens.set(token.id, token);

  globalThis.game = {
    user: { isGM: true },
    world: { id: "world-a", title: "World A" },
    actors: new Map(),
    scenes: new Map([[scene.id, scene]]),
    packs: new Map()
  };
  globalThis.fromUuid = async (uuid) => uuid === scene.uuid ? scene : null;

  const result = await repairImageHoverSpecificArtOverrides({
    worldActors: false,
    worldScenes: false,
    worldCompendiums: false,
    packageCompendiums: false
  });

  assert.equal(result.scannedReferences, 2);
  assert.equal(result.changed, 2);
  assert.equal(result.errors, 0);
  assert.equal(tokenData.flags["image-hover"].specificArt, "path/image.png");
  assert.equal(tokenData.delta.prototypeToken.flags["image-hover"].specificArt, "path/image.png");
});
