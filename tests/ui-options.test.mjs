import test from "node:test";
import assert from "node:assert/strict";
import { readScanOptionsFromRoot } from "../scripts/ui-options.mjs";

const defaults = { worldActors: true, worldItems: true, worldScenes: true };

test("reads live checkbox values instead of defaults", () => {
  const checked = { worldActors: false, worldItems: false, worldScenes: true };
  const root = {
    querySelector(selector) {
      const key = selector.match(/name="([^"]+)"/)?.[1];
      return key in checked ? { checked: checked[key] } : null;
    }
  };
  assert.deepEqual(readScanOptionsFromRoot(root, defaults, defaults), checked);
});

test("preserves stored values when a checkbox is temporarily absent", () => {
  const root = { querySelector: () => null };
  const current = { worldActors: false, worldItems: true, worldScenes: false };
  assert.deepEqual(readScanOptionsFromRoot(root, current, defaults), current);
});
