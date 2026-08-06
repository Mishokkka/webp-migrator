import test from "node:test";
import assert from "node:assert/strict";

import {
  applyMigration,
  createAssumedConversionReport,
  mergeMigrationReports,
  recoverPendingPackLocks,
  rollbackMigration,
  sanitizeConversionReport,
  sanitizeMigrationReportForRollback
} from "../scripts/migration.mjs";
import { collectPngReferences } from "../scripts/path-utils.mjs";

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

function installMockGame(document, extras = {}) {
  globalThis.game = {
    user: { isGM: true },
    world: { id: "world-a", title: "World A" },
    packs: new Map(),
    settings: extras.settings,
    ...extras.game
  };
  globalThis.fromUuid = async (uuid) => uuid === document?.uuid ? document : null;
}

function mockDocument(source, { beforeUpdate = null, normalize = null } = {}) {
  let data = structuredClone(source);
  return {
    uuid: "Actor.A",
    id: "A",
    documentName: "Actor",
    name: "Actor A",
    pack: null,
    toObject: () => structuredClone(data),
    async update(updateData) {
      beforeUpdate?.(data);
      for (const [key, value] of Object.entries(updateData)) applyDotted(data, key, normalize ? normalize(key, value) : value);
      return this;
    },
    current: () => structuredClone(data)
  };
}

function manifestFor(refs, overrides = {}) {
  return {
    type: "fbl-webp-migrator-manifest",
    manifestId: "manifest-a",
    version: "0.3.0",
    worldId: "world-a",
    worldTitle: "World A",
    entries: [{ oldPath: "art/a.png", newPath: "art/a.webp", wildcard: false, refs }],
    ...overrides
  };
}

function concreteFile(overrides = {}) {
  return {
    oldPath: "art/a.png",
    newPath: "art/a.webp",
    status: "converted",
    oldSize: 100,
    newSize: 50,
    oldSha256: "a".repeat(64),
    newSha256: "b".repeat(64),
    oldMtimeMs: 1,
    newMtimeMs: 2,
    oldWidth: 10,
    oldHeight: 20,
    newWidth: 10,
    newHeight: 20,
    sourceAnimated: false,
    provenance: "converted",
    ...overrides
  };
}

function reportFor(overrides = {}) {
  return {
    type: "fbl-webp-migrator-conversion-report",
    sourceManifestId: "manifest-a",
    sourceWorldId: "world-a",
    dataRootId: `sha256:${"c".repeat(64)}`,
    entries: [{
      oldPath: "art/a.png",
      newPath: "art/a.webp",
      status: "converted",
      files: [concreteFile()]
    }],
    ...overrides
  };
}

function exactRef(oldValue = "art/a.png", newValue = "art/a.webp") {
  return {
    uuid: "Actor.A", documentName: "Actor", fieldPath: ["img"], fieldLabel: "img", rootField: "img",
    mode: "exact", oldValue, newValue, oldPath: "art/a.png", newPath: "art/a.webp"
  };
}

test("conversion report cannot inject document refs or trusted summary", () => {
  globalThis.game = { world: { id: "world-a" } };
  const manifest = manifestFor([]);
  const raw = reportFor();
  raw.entries[0].refs = [{ uuid: "Actor.Evil", fieldPath: ["name"], oldValue: "x", newValue: "y" }];
  raw.summary = { converted: 999999 };
  raw.options = JSON.parse('{"__proto__":{"polluted":true},"quality":85}');
  const clean = sanitizeConversionReport(raw, manifest, "world-a");
  assert.equal("refs" in clean.entries[0], false);
  assert.equal(clean.summary.converted, 1);
  assert.equal(clean.summary.verifiedEntries, 1);
  assert.deepEqual(clean.options, { quality: 85 });
  assert.equal({}.polluted, undefined);
});

test("imported assume-existing entries are rejected, internal assumption remains migration-only", () => {
  globalThis.game = { world: { id: "world-a" } };
  const manifest = manifestFor([exactRef()]);
  const raw = reportFor({ entries: [{ oldPath: "art/a.png", newPath: "art/a.webp", status: "assume-existing" }] });
  const clean = sanitizeConversionReport(raw, manifest, "world-a");
  assert.equal(clean.entries.length, 0);
  const internal = createAssumedConversionReport(manifest);
  assert.equal(internal.entries[0].status, "assume-existing");
  assert.equal(internal.summary.cleanupEligibleFiles, 0);
});

test("a forged in-memory assume-existing report cannot call the mutation API", async () => {
  const document = mockDocument({ img: "art/a.png" });
  installMockGame(document);
  const manifest = manifestFor([exactRef()]);
  const forged = {
    type: "fbl-webp-migrator-conversion-report",
    sourceManifestId: "manifest-a",
    sourceWorldId: "world-a",
    entries: [{ oldPath: "art/a.png", newPath: "art/a.webp", status: "assume-existing", files: [] }]
  };
  await assert.rejects(() => applyMigration(manifest, forged, {}), /нет подтвержденных WEBP/);
  assert.equal(document.current().img, "art/a.png");
});

test("apply uses leaf updates, preserves concurrent unrelated changes, and rollback reverses changed refs", async () => {
  const document = mockDocument(
    { _id: "A", img: "art/a.png", flags: { mod: { html: '<img src="art/a.png">', untouched: 1 } } },
    { beforeUpdate: (data) => { data.flags.mod.untouched = 99; } }
  );
  installMockGame(document);
  const refs = [
    exactRef(),
    {
      uuid: "Actor.A", documentName: "Actor", fieldPath: ["flags", "mod", "html"], fieldLabel: "flags.mod.html", rootField: "flags",
      mode: "text", oldValue: "art/a.png", newValue: "art/a.webp", oldPath: "art/a.png", newPath: "art/a.webp"
    }
  ];
  const manifest = manifestFor(refs);
  const report = sanitizeConversionReport(reportFor(), manifest, "world-a");
  const migration = await applyMigration(manifest, report, {});
  assert.equal(document.current().img, "art/a.webp");
  assert.match(document.current().flags.mod.html, /a\.webp/);
  assert.equal(document.current().flags.mod.untouched, 99);
  assert.equal(migration.summary.changedReferences, 2);
  assert.equal(migration.summary.fullyMigratedPngPaths, 1);
  assert.equal(migration.summary.cleanupEligibleFiles, 1);

  const rollback = await rollbackMigration(migration, {});
  assert.equal(rollback.changed, 2);
  assert.equal(document.current().img, "art/a.png");
  assert.match(document.current().flags.mod.html, /a\.png/);
  assert.equal(document.current().flags.mod.untouched, 99);
});

test("trailing whitespace is migrated and normalized save values are accepted", async () => {
  const source = { img: "art/a.png " };
  const refs = collectPngReferences(source, { documentInfo: { uuid: "Actor.A", documentName: "Actor" } });
  const document = mockDocument(source, { normalize: (_key, value) => typeof value === "string" ? value.trim() : value });
  installMockGame(document);
  const manifest = manifestFor(refs);
  const report = sanitizeConversionReport(reportFor(), manifest, "world-a");
  const migration = await applyMigration(manifest, report, {});
  assert.equal(document.current().img, "art/a.webp");
  assert.equal(migration.summary.changedReferences, 1);
  assert.equal(migration.summary.fullyMigratedPngPaths, 1);
});

test("stale values are not overwritten and block cleanup eligibility", async () => {
  const document = mockDocument({ _id: "A", img: "art/new-choice.png" });
  installMockGame(document);
  const manifest = manifestFor([exactRef()]);
  const report = sanitizeConversionReport(reportFor(), manifest, "world-a");
  const migration = await applyMigration(manifest, report, {});
  assert.equal(document.current().img, "art/new-choice.png");
  assert.equal(migration.summary.staleReferences, 1);
  assert.equal(migration.summary.fullyMigratedPngPaths, 0);
  assert.equal(migration.cleanupFiles.length, 0);
});

test("apply validates manifest/report pairing inside the mutation API", async () => {
  const document = mockDocument({ img: "art/a.png" });
  installMockGame(document);
  const manifest = manifestFor([exactRef()]);
  const report = sanitizeConversionReport(reportFor(), manifest, "world-a");
  report.sourceManifestId = "other";
  await assert.rejects(() => applyMigration(manifest, report, {}), /другого manifest/);
  assert.equal(document.current().img, "art/a.png");
});

test("migration reports merge rollback refs across repeated runs and manifests", () => {
  const first = { type: "fbl-webp-migrator-migration-report", worldId: "world-a", sourceManifestId: "m1", changedRefs: [exactRef()], summary: { changedReferences: 1 } };
  const secondRef = { ...exactRef("art/b.png", "art/b.webp"), fieldPath: ["system", "portrait"], rootField: "system", fieldLabel: "system.portrait", oldPath: "art/b.png", newPath: "art/b.webp" };
  const second = { type: "fbl-webp-migrator-migration-report", worldId: "world-a", sourceManifestId: "m2", changedRefs: [secondRef], summary: { changedReferences: 1 } };
  const merged = mergeMigrationReports(first, second);
  assert.equal(merged.changedRefs.length, 2);
  assert.deepEqual(merged.sourceManifestIds.sort(), ["m1", "m2"]);
});

test("sanitized migration report only retains valid rollback references", () => {
  globalThis.game = { world: { id: "world-a", title: "World A" } };
  const raw = {
    type: "fbl-webp-migrator-migration-report",
    worldId: "world-a",
    changedRefs: [exactRef(), { ...exactRef(), fieldPath: ["__proto__", "x"] }]
  };
  const clean = sanitizeMigrationReportForRollback(raw, "world-a");
  assert.equal(clean.changedRefs.length, 1);
});

test("pending world-pack locks are recovered after an interrupted migration", async () => {
  let pending = ["world.pack"];
  const pack = {
    collection: "world.pack",
    metadata: { packageType: "world" },
    locked: false,
    async configure({ locked }) { this.locked = locked; }
  };
  installMockGame(null, {
    game: { packs: new Map([[pack.collection, pack]]) },
    settings: {
      get: () => pending,
      async set(_module, _key, value) { pending = value; }
    }
  });
  const result = await recoverPendingPackLocks();
  assert.equal(result.restored, 1);
  assert.equal(pack.locked, true);
  assert.deepEqual(pending, []);
});

test("opposite mutations cancel rollback state and reverse repairs revoke cleanup", () => {
  const forward = { ...exactRef(), appliedDirection: "forward" };
  const reverse = { ...exactRef(), appliedDirection: "reverse" };
  const cleanupFile = {
    oldPath: "art/a.png",
    newPath: "art/a.webp",
    oldSha256: "a".repeat(64),
    newSha256: "b".repeat(64),
    manifestOldPath: "art/a.png"
  };
  const first = {
    type: "fbl-webp-migrator-migration-report",
    worldId: "world-a",
    sourceManifestId: "m1",
    sourceDataRootId: `sha256:${"c".repeat(64)}`,
    changedRefs: [forward],
    cleanupFiles: [cleanupFile],
    migrated: [{ oldPath: "art/a.png", direction: "png-to-webp" }],
    summary: { changedReferences: 1, cleanupEligibleFiles: 1 }
  };
  const second = {
    type: "fbl-webp-migrator-migration-report",
    worldId: "world-a",
    sourceManifestId: "m2",
    sourceDataRootId: `sha256:${"c".repeat(64)}`,
    changedRefs: [reverse],
    cleanupFiles: [],
    migrated: [{ oldPath: "art/a.png", direction: "webp-to-png" }],
    summary: { changedReferences: 1, cleanupEligibleFiles: 0 }
  };
  const merged = mergeMigrationReports(first, second);
  assert.equal(merged.changedRefs.length, 0);
  assert.equal(merged.cleanupFiles.length, 0);
  assert.equal(merged.summary.changedReferences, 0);
  assert.equal(merged.summary.cleanupEligibleFiles, 0);
  assert.equal(merged.migrated[0].direction, "webp-to-png");
});

test("merged reports preserve cleanup binding unless Data roots conflict", () => {
  const cleanupFile = {
    oldPath: "art/a.png",
    newPath: "art/a.webp",
    oldSha256: "a".repeat(64),
    newSha256: "b".repeat(64)
  };
  const rootA = `sha256:${"c".repeat(64)}`;
  const rootB = `sha256:${"d".repeat(64)}`;
  const first = {
    type: "fbl-webp-migrator-migration-report",
    worldId: "world-a",
    sourceManifestId: "m1",
    sourceDataRootId: rootA,
    changedRefs: [],
    cleanupFiles: [cleanupFile],
    summary: { changedReferences: 0, cleanupEligibleFiles: 1 }
  };
  const sameRoot = mergeMigrationReports(first, {
    type: first.type,
    worldId: "world-a",
    sourceManifestId: "m2",
    sourceDataRootId: null,
    changedRefs: [],
    cleanupFiles: [],
    summary: { changedReferences: 0, cleanupEligibleFiles: 0 }
  });
  assert.equal(sameRoot.sourceDataRootId, rootA);
  assert.equal(sameRoot.cleanupFiles.length, 1);

  const conflict = mergeMigrationReports(first, {
    type: first.type,
    worldId: "world-a",
    sourceManifestId: "m3",
    sourceDataRootId: rootB,
    changedRefs: [],
    cleanupFiles: [],
    summary: { changedReferences: 0, cleanupEligibleFiles: 0 }
  });
  assert.equal(conflict.sourceDataRootId, null);
  assert.equal(conflict.cleanupFiles.length, 0);
  assert.ok(conflict.issues.some((issue) => issue.status === "merge-data-root-conflict"));
});
