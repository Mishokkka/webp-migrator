// Optional integration check against a licensed local Foundry installation.
// FWM_FOUNDRY_APP points to its resources/app directory; no world is opened.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectPngReferences } from "../scripts/path-utils.mjs";
import { groupReferences } from "../scripts/scanner.mjs";
import { applyMigration, createAssumedConversionReport, rollbackMigration } from "../scripts/migration.mjs";

const directory = process.env.FWM_FOUNDRY_APP ?? process.argv[2];
if (!directory) throw new Error("Set FWM_FOUNDRY_APP to Foundry v13 resources/app, or pass that directory as the first argument.");
const load = (relative) => import(pathToFileURL(path.join(directory, relative)));
const helpers = await load("common/utils/helpers.mjs");
await load("common/primitives/array.mjs");
const fields = await load("common/data/fields.mjs");
const { default: DataModel } = await load("common/abstract/data.mjs");
globalThis.foundry = { utils: helpers, data: { fields }, abstract: { DataModel } };

class TestModel extends DataModel {
  static defineSchema() {
    return {
      flags: new fields.ObjectField(),
      faces: new fields.ArrayField(new fields.SchemaField({ img: new fields.StringField(), name: new fields.StringField(), text: new fields.StringField() }))
    };
  }
}
const model = new TestModel({
  flags: { gallery: [{ img: "art/a.png", caption: "keep", variants: ["art/b.png", "other.jpg"] }, { img: "other.jpg", caption: "keep too" }] },
  faces: [{ img: "art/a.png", name: "Ace", text: "valuable" }, { img: "art/c.png", name: "King", text: "also valuable" }]
});
const before = model.toObject();
const updates = [];
const document = {
  uuid: "Cards.A", id: "A", documentName: "Cards", name: "Array safety",
  toObject: () => model.toObject(),
  async update(data) { updates.push(structuredClone(data)); model.updateSource(data); }
};
globalThis.game = { user: { isGM: true }, world: { id: "integration" }, packs: new Map() };
globalThis.fromUuid = async (uuid) => uuid === document.uuid ? document : null;
const refs = collectPngReferences(before, { documentInfo: { uuid: document.uuid, rootUuid: document.uuid, documentName: "Cards" } });
const manifest = { type: "fbl-webp-migrator-manifest", schemaVersion: 4, manifestId: "integration", worldId: "integration", entries: groupReferences(refs).entries };
const report = await applyMigration(manifest, createAssumedConversionReport(manifest));
assert.equal(report.changedRefs.length, 4);
assert.equal(report.summary.errors, 0);
assert.deepEqual(model.toObject(), JSON.parse(JSON.stringify(before).replaceAll(".png", ".webp")));
assert.deepEqual(Object.keys(updates[0]).sort(), ["faces", "flags.gallery"]);
assert.equal((await rollbackMigration(report)).errors, 0);
assert.deepEqual(model.toObject(), before);
console.log("PASS: real Foundry DataModel ArrayField/ObjectField migration and rollback preserve all elements and metadata.");
