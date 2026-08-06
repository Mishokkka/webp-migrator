import test from "node:test";
import assert from "node:assert/strict";

class MockApplicationV2 {
  constructor() {
    this.rendered = false;
    this.element = null;
    this.form = null;
  }
  _canRender() { return true; }
  async _onRender() {}
  async render() { this.rendered = true; return this; }
}

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: MockApplicationV2,
      HandlebarsApplicationMixin: (Base) => class extends Base {}
    }
  },
  utils: { deepClone: (value) => structuredClone(value) }
};
globalThis.game = {
  user: { isGM: true },
  world: { id: "world-a", title: "World A" },
  i18n: {
    localize: (key) => key,
    format: (key) => key
  }
};

const { WebpMigratorApp } = await import("../scripts/app.mjs");

test("ApplicationV2 class loads against the Foundry v13 API shape", async () => {
  const app = new WebpMigratorApp();
  assert.equal(app._canRender({}), true);
  const context = await app._prepareContext({});
  assert.match(context.conversionCommand, /--world-id "world-a"/);
  assert.match(context.cleanupCommand, /world-a-webp-migration-report\.json/);
  assert.equal(context.canCancel, false);
  assert.equal(WebpMigratorApp.DEFAULT_OPTIONS.actions.cancel, WebpMigratorApp._onCancelAction);
});
