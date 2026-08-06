import test from "node:test";
import assert from "node:assert/strict";

import {
  applyMigration,
  rollbackMigration,
  sanitizeConversionReport
} from "../scripts/migration.mjs";

function installMockGame(document) {
  globalThis.game = {
    user: { isGM: true },
    world: { id: "world-a", title: "World A" },
    packs: new Map()
  };
  globalThis.fromUuid = async (uuid) => uuid === document.uuid ? document : null;
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
      data = { ...data, ...structuredClone(updateData) };
      return this;
    },
    current: () => structuredClone(data)
  };
}

function manifestFor(refs) {
  return {
    type: "fbl-webp-migrator-manifest",
    manifestId: "manifest-a",
    version: "0.2.0",
    worldId: "world-a",
    worldTitle: "World A",
    entries: [{ oldPath: "art/a.png", newPath: "art/a.webp", refs }]
  };
}

function reportFor() {
  return {
    type: "fbl-webp-migrator-conversion-report",
    sourceManifestId: "manifest-a",
    sourceWorldId: "world-a",
    entries: [{ oldPath: "art/a.png", newPath: "art/a.webp", status: "converted" }]
  };
}

test("conversion report cannot inject document refs", () => {
  globalThis.game = { world: { id: "world-a" } };
  const manifest = manifestFor([]);
  const raw = reportFor();
  raw.entries[0].refs = [{ uuid: "Actor.Evil", fieldPath: ["name"], oldValue: "x", newValue: "y" }];
  const clean = sanitizeConversionReport(raw, manifest, "world-a");
  assert.equal("refs" in clean.entries[0], false);
});

test("apply verifies current values, updates valid refs, and rollback reverses only changed refs", async () => {
  const document = mockDocument({ _id: "A", img: "art/a.png", flags: { mod: { html: '<img src="art/a.png">' } } });
  installMockGame(document);
  const refs = [
    {
      uuid: "Actor.A", documentName: "Actor", fieldPath: ["img"], fieldLabel: "img", rootField: "img",
      mode: "exact", oldValue: "art/a.png", newValue: "art/a.webp", oldPath: "art/a.png", newPath: "art/a.webp"
    },
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
  assert.equal(migration.summary.changedReferences, 2);
  assert.equal(migration.summary.fullyMigratedPngPaths, 1);

  const rollback = await rollbackMigration(migration, {});
  assert.equal(rollback.changed, 2);
  assert.equal(document.current().img, "art/a.png");
  assert.match(document.current().flags.mod.html, /a\.png/);
});

test("stale values are not overwritten and block cleanup eligibility", async () => {
  const document = mockDocument({ _id: "A", img: "art/new-choice.png" });
  installMockGame(document);
  const ref = {
    uuid: "Actor.A", documentName: "Actor", fieldPath: ["img"], fieldLabel: "img", rootField: "img",
    mode: "exact", oldValue: "art/a.png", newValue: "art/a.webp", oldPath: "art/a.png", newPath: "art/a.webp"
  };
  const manifest = manifestFor([ref]);
  const report = sanitizeConversionReport(reportFor(), manifest, "world-a");
  const migration = await applyMigration(manifest, report, {});
  assert.equal(document.current().img, "art/new-choice.png");
  assert.equal(migration.summary.staleReferences, 1);
  assert.equal(migration.summary.fullyMigratedPngPaths, 0);
});
