import test from "node:test";
import assert from "node:assert/strict";

import {
  collectPngReferences,
  findRichPngReferences,
  getAtPath,
  normalizePhysicalPath,
  replaceTextReference,
  setAtPath,
  toWebpReference
} from "../scripts/path-utils.mjs";
import { iterateDocumentTree } from "../scripts/scanner.mjs";

test("normalizes physical paths and preserves reference suffix", () => {
  assert.equal(normalizePhysicalPath("/assets/NPC/Test.png?v=2#x"), "assets/NPC/Test.png");
  assert.equal(toWebpReference("assets/NPC/Test.PNG?v=2"), "assets/NPC/Test.webp?v=2");
  assert.equal(normalizePhysicalPath("https://example.com/test.png"), null);
  assert.equal(normalizePhysicalPath("../outside.png"), null);
});

test("collects exact and rich-text PNG references", () => {
  const source = {
    img: "actors/hero.png",
    system: { portrait: "custom/system-face.png?rev=3" },
    content: '<p><img src="journals/map.png"></p><style>.x{background:url(tiles/floor.png)}</style>',
    items: [{ img: "embedded/skip.png" }]
  };
  const refs = collectPngReferences(source, {
    richText: true,
    skipRootFields: new Set(["items"]),
    documentInfo: { uuid: "Actor.A", documentName: "Actor" }
  });
  assert.equal(refs.length, 4);
  assert.deepEqual(refs.map((ref) => ref.oldPath).sort(), [
    "actors/hero.png",
    "custom/system-face.png",
    "journals/map.png",
    "tiles/floor.png"
  ]);
  assert.equal(refs.find((ref) => ref.oldPath === "journals/map.png").mode, "text");
});

test("finds multiple rich references without accepting remote URLs", () => {
  const refs = findRichPngReferences('url("a/b.png") https://site/x.png src="local/c.png?x=1"');
  assert.deepEqual(refs, ["a/b.png", "local/c.png?x=1"]);
});

test("safe path access supports arrays and rejects prototype paths", () => {
  const source = { flags: { mod: [{ img: "a.png" }] } };
  assert.equal(getAtPath(source, ["flags", "mod", 0, "img"]), "a.png");
  setAtPath(source, ["flags", "mod", 0, "img"], "a.webp");
  assert.equal(source.flags.mod[0].img, "a.webp");
  assert.throws(() => setAtPath(source, ["__proto__", "polluted"], true));
  assert.equal({}.polluted, undefined);
});

test("text replacement distinguishes changed, already and stale", () => {
  assert.deepEqual(replaceTextReference("x/a.png y", "x/a.png", "x/a.webp"), { status: "changed", value: "x/a.webp y" });
  assert.equal(replaceTextReference("x/a.webp y", "x/a.png", "x/a.webp").status, "already");
  assert.equal(replaceTextReference("none", "x/a.png", "x/a.webp").status, "stale");
});

test("document tree fallback traverses embedded collections once", () => {
  class MockActor {}
  MockActor.metadata = { embedded: { Item: "items" } };
  class MockItem {}
  MockItem.metadata = { embedded: {} };
  const item = { uuid: "Actor.A.Item.I", id: "I", documentName: "Item", constructor: MockItem, toObject: () => ({ _id: "I", img: "i.png" }) };
  const actor = { uuid: "Actor.A", id: "A", documentName: "Actor", constructor: MockActor, items: [item], toObject: () => ({ _id: "A", img: "a.png", items: [] }) };
  assert.deepEqual(iterateDocumentTree(actor).map((doc) => doc.uuid), ["Actor.A", "Actor.A.Item.I"]);
});
