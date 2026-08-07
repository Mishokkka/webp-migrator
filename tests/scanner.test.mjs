import test from "node:test";
import assert from "node:assert/strict";

import { groupReferences, sanitizeManifest, scanFoundry } from "../scripts/scanner.mjs";

function actorDocument(img = "art/a.png") {
  class MockActor {}
  MockActor.metadata = { embedded: {} };
  return {
    uuid: "Actor.A",
    id: "A",
    name: "Actor A",
    documentName: "Actor",
    constructor: MockActor,
    toObject: () => ({ _id: "A", img })
  };
}

function installGame({ actor = actorDocument(), messages = [], packs = [] } = {}) {
  globalThis.game = {
    user: { isGM: true },
    version: "13.351",
    world: { id: "world-a", title: "World A" },
    system: { id: "forbidden-lands", version: "13.0.5" },
    actors: actor ? [actor] : [],
    items: [], scenes: [], journal: [], tables: [], cards: [], macros: [], users: [],
    messages,
    playlists: [], combats: [], folders: [],
    packs: new Map(packs.map((pack) => [pack.collection, pack]))
  };
}

test("scanFoundry sanitizes options at its public boundary", async () => {
  installGame();
  const manifest = await scanFoundry({
    worldActors: "yes",
    worldItems: false,
    chatMessages: 1,
    packageCompendiums: true,
    unknownOption: true
  });
  assert.equal(manifest.options.worldActors, true);
  assert.equal(manifest.options.worldItems, false);
  assert.equal(manifest.options.chatMessages, false);
  assert.equal("unknownOption" in manifest.options, false);
  assert.equal(manifest.summary.uniquePngPaths, 1);
});

test("unknown package types are never treated as writable package compendiums", async () => {
  let loaded = false;
  const pack = {
    collection: "mystery.pack",
    title: "Mystery",
    documentName: "Actor",
    metadata: { packageType: "mystery" },
    async getDocuments() { loaded = true; return [actorDocument()]; }
  };
  installGame({ actor: null, packs: [pack] });
  const manifest = await scanFoundry({ worldActors: false, packageCompendiums: true });
  assert.equal(loaded, false);
  assert.equal(manifest.summary.uniquePngPaths, 0);
});

test("chat coverage is explicitly limited to loaded messages", async () => {
  const message = {
    ...actorDocument("chat/image.png"),
    uuid: "ChatMessage.M",
    id: "M",
    name: "Message",
    documentName: "ChatMessage"
  };
  installGame({ actor: null, messages: [message] });
  const manifest = await scanFoundry({ worldActors: false, chatMessages: true });
  assert.equal(manifest.summary.uniquePngPaths, 1);
  assert.ok(manifest.notes.some((note) => /currently loaded/i.test(note)));
});

test("imported manifests cannot redirect an authorized asset reference to another field value", () => {
  installGame();
  const raw = {
    type: "fbl-webp-migrator-manifest",
    manifestId: "m1",
    worldId: "world-a",
    entries: [{
      oldPath: "art/a.png",
      newPath: "art/a.webp",
      refs: [{
        uuid: "Actor.A",
        rootField: "name",
        fieldPath: ["name"],
        mode: "exact",
        oldValue: "innocent",
        newValue: "evil",
        oldPath: "art/a.png",
        newPath: "art/a.webp"
      }]
    }]
  };
  const clean = sanitizeManifest(raw, "world-a");
  assert.equal(clean.entries.length, 0);
  assert.equal(clean.ignored.length, 1);
});

test("scanFoundry records WebP references and consistency capabilities", async () => {
  installGame({ actor: actorDocument("art/a.webp") });
  const manifest = await scanFoundry({ worldActors: true });
  assert.equal(manifest.summary.uniquePngPaths, 0);
  assert.equal(manifest.summary.uniqueWebpPaths, 1);
  assert.equal(manifest.summary.webpDocumentReferences, 1);
  assert.equal(manifest.webpEntries[0].oldPath, "art/a.png");
  assert.equal(manifest.webpEntries[0].newPath, "art/a.webp");
  assert.equal(manifest.webpEntries[0].refs[0].sourceFormat, "webp");
  assert.deepEqual(manifest.capabilities, {
    pngReferenceScan: true,
    webpReferenceScan: true,
    consistencyAudit: true
  });
});

test("imported duplicate manifest entries are merged without duplicating references", () => {
  installGame();
  const baseRef = {
    uuid: "Actor.A",
    rootField: "img",
    fieldPath: ["img"],
    mode: "exact",
    sourceFormat: "png",
    oldValue: "art/a.png",
    newValue: "art/a.webp",
    oldPath: "art/a.png",
    newPath: "art/a.webp"
  };
  const raw = {
    type: "fbl-webp-migrator-manifest",
    schemaVersion: 4,
    manifestId: "m1",
    worldId: "world-a",
    capabilities: { pngReferenceScan: true, webpReferenceScan: true, consistencyAudit: true },
    entries: [
      { oldPath: "art/a.png", newPath: "art/a.webp", refs: [baseRef] },
      { oldPath: "art/a.png", newPath: "art/a.webp", refs: [baseRef] }
    ],
    webpEntries: []
  };
  const clean = sanitizeManifest(raw, "world-a");
  assert.equal(clean.entries.length, 1);
  assert.equal(clean.entries[0].refs.length, 1);
});


test("case-folded groups retain every reference's original path spelling", () => {
  const upper = {
    uuid: "Actor.A",
    rootField: "img",
    fieldPath: ["img"],
    mode: "exact",
    sourceFormat: "png",
    oldValue: "Art/A.png",
    newValue: "Art/A.webp",
    oldPath: "Art/A.png",
    newPath: "Art/A.webp"
  };
  const lower = {
    ...upper,
    uuid: "Actor.B",
    oldValue: "art/a.png",
    newValue: "art/a.webp",
    oldPath: "art/a.png",
    newPath: "art/a.webp"
  };
  const grouped = groupReferences([upper, lower], { caseInsensitive: true });
  assert.equal(grouped.entries.length, 1);
  assert.equal(grouped.entries[0].oldPath, "Art/A.png");
  assert.deepEqual(grouped.entries[0].refs.map((ref) => ref.oldPath), ["Art/A.png", "art/a.png"]);
});

test("case-folded aliases survive manifest sanitization on case-insensitive platforms", () => {
  installGame();
  const upper = {
    uuid: "Actor.A",
    rootField: "img",
    fieldPath: ["img"],
    mode: "exact",
    sourceFormat: "png",
    oldValue: "Art/A.png",
    newValue: "Art/A.webp",
    oldPath: "Art/A.png",
    newPath: "Art/A.webp"
  };
  const lower = {
    ...upper,
    uuid: "Actor.B",
    oldValue: "art/a.png",
    newValue: "art/a.webp",
    oldPath: "art/a.png",
    newPath: "art/a.webp"
  };
  const raw = {
    type: "fbl-webp-migrator-manifest",
    schemaVersion: 4,
    manifestId: "m-case",
    worldId: "world-a",
    capabilities: { pngReferenceScan: true, webpReferenceScan: true, consistencyAudit: true },
    entries: [{ oldPath: "Art/A.png", newPath: "Art/A.webp", refs: [upper, lower] }],
    webpEntries: []
  };
  const clean = sanitizeManifest(raw, "world-a", { caseInsensitive: true });
  assert.equal(clean.entries.length, 1);
  assert.equal(clean.entries[0].refs.length, 2);
  assert.deepEqual(clean.entries[0].refs.map((ref) => ref.oldPath), ["Art/A.png", "art/a.png"]);
});
