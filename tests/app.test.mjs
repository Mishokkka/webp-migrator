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

function rollbackRef() {
  return {
    uuid: "Actor.A",
    documentName: "Actor",
    rootUuid: "Actor.A",
    rootDocumentName: "Actor",
    packageType: "world",
    sourceFormat: "png",
    fieldPath: ["img"],
    fieldLabel: "img",
    rootField: "img",
    mode: "exact",
    oldValue: "art/a.png",
    newValue: "art/a.webp",
    oldPath: "art/a.png",
    newPath: "art/a.webp",
    appliedDirection: "forward"
  };
}

function installRollbackGame(currentValue) {
  let data = { img: currentValue };
  const document = {
    uuid: "Actor.A",
    id: "A",
    documentName: "Actor",
    name: "Actor A",
    pack: null,
    toObject: () => structuredClone(data),
    async update(updateData) {
      if (Object.hasOwn(updateData, "img")) data.img = updateData.img;
      return this;
    }
  };
  globalThis.game = {
    user: { isGM: true },
    world: { id: "world-a", title: "World A" },
    packs: new Map(),
    i18n: { localize: (key) => key, format: (key) => key }
  };
  globalThis.fromUuid = async (uuid) => uuid === document.uuid ? document : null;
  globalThis.ui = { notifications: { error() {}, warn() {}, info() {} } };
  return document;
}

test("closing a confirmation is treated as cancellation, not an error", async () => {
  installRollbackGame("art/a.webp");
  globalThis.confirm = () => false;
  const app = new WebpMigratorApp();
  app._viewState = {
    busy: false,
    status: "",
    lastError: "",
    options: {},
    rollbackReport: { worldId: "world-a", changedRefs: [rollbackRef()] },
    migrationReport: { marker: true },
    rollbackSummary: null
  };

  await WebpMigratorApp._onRollbackAction.call(app, { preventDefault() {} });
  assert.equal(app._viewState.status, "Действие отменено.");
  assert.equal(app._viewState.lastError, "");
  assert.ok(app._viewState.rollbackReport);
  assert.equal(app._viewState.busy, false);
});

test("partial rollback keeps reports available for retry", async () => {
  installRollbackGame("art/other.webp");
  globalThis.confirm = () => true;
  const app = new WebpMigratorApp();
  const report = { worldId: "world-a", changedRefs: [rollbackRef()], cleanupFiles: [{ oldPath: "art/a.png" }], summary: { cleanupEligibleFiles: 1 } };
  app._viewState = {
    busy: false,
    status: "",
    lastError: "",
    options: {},
    rollbackReport: report,
    migrationReport: report,
    rollbackSummary: null
  };

  await WebpMigratorApp._onRollbackAction.call(app, { preventDefault() {} });
  assert.equal(app._viewState.rollbackSummary.stale, 1);
  assert.equal(app._viewState.rollbackReport, report);
  assert.equal(app._viewState.migrationReport, report);
  assert.deepEqual(report.cleanupFiles, []);
  assert.equal(report.summary.cleanupEligibleFiles, 0);
});

test("cancel action aborts an active operation and clears its controller", async () => {
  installRollbackGame("art/a.webp");
  const app = new WebpMigratorApp();
  app._viewState = {
    busy: false,
    status: "",
    lastError: "",
    options: {},
    rollbackReport: null,
    migrationReport: null,
    rollbackSummary: null
  };

  const running = app._runAction("Working", async (_options, signal) => {
    await new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException("Cancelled", "AbortError"));
      signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    });
  });
  await Promise.resolve();
  WebpMigratorApp._onCancelAction.call(app, { preventDefault() {} });
  await running;

  assert.equal(app._viewState.status, "Действие отменено.");
  assert.equal(app._viewState.busy, false);
  assert.equal(app._activeController, null);
});
