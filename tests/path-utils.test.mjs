import test from "node:test";
import assert from "node:assert/strict";

import {
  collectPngReferences,
  collectWebpReferences,
  findRichPngReferences,
  findRichWebpReferences,
  getAtPath,
  isFoundryCorePublicAssetReference,
  normalizePhysicalPath,
  normalizeWebpPhysicalPath,
  replaceTextReference,
  sanitizeJsonValue,
  setAtPath,
  splitPathSuffix,
  toPngPhysicalPath,
  toPngReference,
  toWebpReference
} from "../scripts/path-utils.mjs";
import { iterateDocumentTree } from "../scripts/scanner.mjs";

test("normalizes local paths, collapses dot segments, and preserves suffixes", () => {
  assert.equal(normalizePhysicalPath("/assets/NPC/./Test.png?v=2#x"), "assets/NPC/Test.png");
  assert.equal(normalizeWebpPhysicalPath("assets/NPC/./Test.webp?v=2"), "assets/NPC/Test.webp");
  assert.equal(toWebpReference("assets/NPC/Test.PNG?v=2"), "assets/NPC/Test.webp?v=2");
  assert.equal(splitPathSuffix("tokens/icon?.png").path, "tokens/icon?.png");
  assert.equal(splitPathSuffix("tokens/hash#name.png").path, "tokens/hash#name.png");
  assert.equal(splitPathSuffix("tokens/icon?.webp").path, "tokens/icon?.webp");
  assert.equal(splitPathSuffix("art/hash#name.webp").path, "art/hash#name.webp");
  assert.deepEqual(splitPathSuffix("art/a.webp?v=2#x"), { path: "art/a.webp", suffix: "?v=2#x" });
  assert.deepEqual(splitPathSuffix("art/a.webp?fallback=b.png"), { path: "art/a.webp", suffix: "?fallback=b.png" });
  assert.deepEqual(splitPathSuffix("art/a.png?fallback=b.webp"), { path: "art/a.png", suffix: "?fallback=b.webp" });
  assert.equal(normalizePhysicalPath("https://example.com/test.png"), null);
  assert.equal(normalizePhysicalPath("../outside.png"), null);
  assert.equal(normalizePhysicalPath("\\\\server\\share\\a.png"), null);
  assert.equal(normalizePhysicalPath("C:relative.png"), null);
});


test("Foundry Core Data public paths are excluded from asset migration", () => {
  assert.equal(isFoundryCorePublicAssetReference("icons/svg/mystery-man.svg"), true);
  assert.equal(isFoundryCorePublicAssetReference("/ui/denim075.png?v=1"), true);
  assert.equal(isFoundryCorePublicAssetReference("cards/default.png"), true);
  assert.equal(isFoundryCorePublicAssetReference("worlds/world-a/icons/custom.png"), false);
  assert.equal(isFoundryCorePublicAssetReference("3_F00L/icons/custom.png"), false);

  const pngRefs = collectPngReferences({
    img: "icons/core/default.png",
    background: "ui/background.png",
    custom: "3_F00L/art/hero.png",
    html: '<img src="icons/core/rich.png"><img src="worlds/world-a/art/rich.png">'
  }, { documentInfo: { uuid: "Actor.A", documentName: "Actor" } });
  assert.deepEqual(pngRefs.map((ref) => ref.oldPath).sort(), ["3_F00L/art/hero.png", "worlds/world-a/art/rich.png"]);

  const webpRefs = collectWebpReferences({
    img: "icons/core/default.webp",
    background: "ui/background.webp",
    custom: "3_F00L/art/hero.webp",
    html: '<img src="icons/core/rich.webp"><img src="worlds/world-a/art/rich.webp">'
  }, { documentInfo: { uuid: "Actor.A", documentName: "Actor" } });
  assert.deepEqual(webpRefs.map((ref) => ref.newPath).sort(), ["3_F00L/art/hero.webp", "worlds/world-a/art/rich.webp"]);
});

test("trailing whitespace produces a real WebP replacement instead of a no-op", () => {
  const refs = collectPngReferences({ img: "art/a.png \t" }, {
    documentInfo: { uuid: "Actor.A", documentName: "Actor" }
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].oldValue, "art/a.png \t");
  assert.equal(refs[0].newValue, "art/a.webp \t");
  assert.notEqual(refs[0].oldValue, refs[0].newValue);
});

test("collects exact, rich-text, bare filename, and array references", () => {
  const source = {
    img: "actors/hero.png",
    system: {
      portrait: "custom/system-face.png?rev=3",
      gallery: ["bare.png", "art/second.png"]
    },
    content: '<p><img src="journals/map.png"><img src="dragon.png"></p><style>.x{background:url(tiles/floor.png)}</style>',
    items: [{ img: "embedded/skip.png" }]
  };
  const refs = collectPngReferences(source, {
    richText: true,
    skipRootFields: new Set(["items"]),
    documentInfo: { uuid: "Actor.A", documentName: "Actor" }
  });
  assert.deepEqual(refs.map((ref) => ref.oldPath).sort(), [
    "actors/hero.png",
    "art/second.png",
    "bare.png",
    "custom/system-face.png",
    "dragon.png",
    "journals/map.png",
    "tiles/floor.png"
  ]);
  assert.equal(refs.find((ref) => ref.oldPath === "journals/map.png").mode, "text");
  assert.equal(refs.find((ref) => ref.oldPath === "bare.png").mode, "exact");
});


test("ignores Image Hover's path/image.png sentinel without hiding real specific-art paths", () => {
  const source = {
    img: "path/image.png",
    prototypeToken: { flags: { "image-hover": { specificArt: "path/image.png" } } },
    tokenOverride: { flags: { "image-hover": { specificArt: "portraits/hover.png" } } }
  };
  const refs = collectPngReferences(source, {
    documentInfo: { uuid: "Actor.A", documentName: "Actor" }
  });
  assert.deepEqual(refs.map((ref) => ref.oldPath).sort(), ["path/image.png", "portraits/hover.png"]);
  assert.equal(refs.some((ref) => ref.fieldLabel === "prototypeToken.flags.image-hover.specificArt"), false);
  assert.equal(refs.some((ref) => ref.fieldLabel === "tokenOverride.flags.image-hover.specificArt"), true);
});

test("collects WebP references as canonical PNG/WebP pairs", () => {
  const source = {
    img: "actors/hero.webp ",
    system: { gallery: ["bare.webp", "art/second.webp?v=2"] },
    content: '<img src="journals/map.webp"><style>.x{background:url(tiles/floor.webp)}</style>'
  };
  const refs = collectWebpReferences(source, {
    richText: true,
    documentInfo: { uuid: "Actor.A", documentName: "Actor" }
  });
  assert.deepEqual(refs.map((ref) => ref.oldPath).sort(), [
    "actors/hero.png",
    "art/second.png",
    "bare.png",
    "journals/map.png",
    "tiles/floor.png"
  ]);
  const exact = refs.find((ref) => ref.oldPath === "actors/hero.png");
  assert.equal(exact.sourceFormat, "webp");
  assert.equal(exact.oldValue, "actors/hero.png ");
  assert.equal(exact.newValue, "actors/hero.webp ");
  assert.equal(toPngReference("art/a.webp?v=2"), "art/a.png?v=2");
  assert.equal(toPngPhysicalPath("art/a.webp?v=2"), "art/a.png");
});

test("finds PNG and WebP references without accepting remote URLs", () => {
  const png = findRichPngReferences('url("a/b.png") https://site/x.png src="local/c.png?x=1" <img src="dragon.png">').sort();
  assert.deepEqual(png, ["a/b.png", "dragon.png", "local/c.png?x=1"]);
  const webp = findRichWebpReferences('<img src="a.webp"> url("art/b.webp?v=2") https://site/x.webp').sort();
  assert.deepEqual(webp, ["a.webp", "art/b.webp?v=2"]);
});

test("safe path access supports arrays and rejects prototype paths", () => {
  const source = { flags: { mod: [{ img: "a.png" }] } };
  assert.equal(getAtPath(source, ["flags", "mod", 0, "img"]), "a.png");
  setAtPath(source, ["flags", "mod", 0, "img"], "a.webp");
  assert.equal(source.flags.mod[0].img, "a.webp");
  assert.throws(() => setAtPath(source, ["__proto__", "polluted"], true));
  assert.equal({}.polluted, undefined);
});

test("recursive JSON sanitization removes dangerous keys", () => {
  const raw = JSON.parse('{"safe":1,"__proto__":{"polluted":true},"nested":{"constructor":{"x":1},"ok":2}}');
  const clean = sanitizeJsonValue(raw);
  assert.deepEqual(clean, { safe: 1, nested: { ok: 2 } });
  assert.equal({}.polluted, undefined);
});

test("text replacement is bounded on both sides", () => {
  assert.deepEqual(replaceTextReference("(x/a.png) y", "x/a.png", "x/a.webp"), { status: "changed", value: "(x/a.webp) y" });
  assert.equal(replaceTextReference("(x/a.webp) y", "x/a.png", "x/a.webp").status, "already");
  assert.equal(replaceTextReference("extra/x/a.png", "x/a.png", "x/a.webp").status, "stale");
  assert.equal(replaceTextReference("x/a.png.backup", "x/a.png", "x/a.webp").status, "stale");
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
