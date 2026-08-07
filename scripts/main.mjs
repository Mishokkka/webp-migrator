import { MODULE_ID, MODULE_TITLE, MODULE_VERSION, PENDING_RELOCKS_SETTING } from "./constants.mjs";
import { WebpMigratorApp } from "./app.mjs";
import {
  applyMigration,
  recoverPendingPackLocks,
  rollbackMigration,
  sanitizeConversionReport,
  sanitizeMigrationReportForRollback
} from "./migration.mjs";
import {
  applyConsistencyRepairs,
  applyMissingPlaceholderRepairs,
  sanitizeConsistencyReport
} from "./consistency.mjs";
import { sanitizeManifest, sanitizeScanOptions, scanFoundry } from "./scanner.mjs";

let appInstance = null;

function tr(key, fallback, data = null) {
  const i18n = globalThis.game?.i18n;
  if (!i18n) return fallback;
  try {
    const translated = data ? i18n.format(key, data) : i18n.localize(key);
    return translated && translated !== key ? translated : fallback;
  } catch {
    return fallback;
  }
}

function requireGM() {
  if (!game.user?.isGM) throw new Error(`${MODULE_TITLE} доступен только GM.`);
}

function openApp() {
  requireGM();
  appInstance ??= new WebpMigratorApp();
  appInstance.render({ force: true });
  return appInstance;
}

function createApi() {
  return Object.freeze({
    version: MODULE_VERSION,
    open: openApp,
    sanitizeManifest,
    sanitizeConversionReport,
    sanitizeConsistencyReport,
    sanitizeMigrationReportForRollback,
    async scanToManifest(options = {}, hooks = {}) {
      requireGM();
      return scanFoundry(sanitizeScanOptions(options), hooks);
    },
    async applyManifestReport(manifestInput, rawReport, options = {}, hooks = {}) {
      requireGM();
      const manifest = sanitizeManifest(manifestInput, game.world?.id ?? null);
      const report = sanitizeConversionReport(rawReport, manifest, game.world?.id ?? null);
      return applyMigration(manifest, report, options, hooks);
    },
    async auditRepair(manifestInput, rawReport, options = {}, hooks = {}) {
      requireGM();
      const manifest = sanitizeManifest(manifestInput, game.world?.id ?? null);
      const report = sanitizeConsistencyReport(rawReport, manifest, game.world?.id ?? null);
      return applyConsistencyRepairs(manifest, report, options, hooks);
    },
    async repairMissingAssets(manifestInput, rawReport, options = {}, hooks = {}) {
      requireGM();
      const manifest = sanitizeManifest(manifestInput, game.world?.id ?? null);
      const report = sanitizeConsistencyReport(rawReport, manifest, game.world?.id ?? null);
      return applyMissingPlaceholderRepairs(manifest, report, options, hooks);
    },
    async rollbackReport(rawReport, options = {}, hooks = {}) {
      requireGM();
      const report = sanitizeMigrationReportForRollback(rawReport, game.world?.id ?? null);
      return rollbackMigration(report, options, hooks);
    }
  });
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, PENDING_RELOCKS_SETTING, {
    scope: "world",
    config: false,
    type: Array,
    default: []
  });
  game.settings.registerMenu(MODULE_ID, "migrator", {
    name: "FWM.Menu.Name",
    label: "FWM.Menu.Label",
    hint: "FWM.Menu.Hint",
    icon: "fas fa-file-image",
    type: WebpMigratorApp,
    restricted: true
  });
});

Hooks.once("ready", async () => {
  // Publish the API before attempting recovery. A settings or pack failure must
  // not make the module unavailable for diagnostics and manual recovery.
  const api = createApi();
  game.fblWebpMigrator = api;
  const module = game.modules?.get(MODULE_ID);
  if (module) module.api = api;

  try {
    const recovery = await recoverPendingPackLocks();
    if (recovery.issues.length) {
      console.error(`${MODULE_TITLE} | Failed to recover compendium locks`, recovery.issues);
      ui.notifications.error(tr(
        "FWM.Status.LockRecoveryFailed",
        `FBL WebP Migrator: failed to restore ${recovery.issues.length} compendium locks. See console.`,
        { count: recovery.issues.length }
      ));
    } else if (recovery.restored) {
      ui.notifications.info(tr(
        "FWM.Status.LockRecoveryDone",
        `FBL WebP Migrator restored compendium locks: ${recovery.restored}.`,
        { count: recovery.restored }
      ));
    }
  } catch (error) {
    console.error(`${MODULE_TITLE} | Unexpected compendium lock recovery failure`, error);
    ui.notifications.error(tr(
      "FWM.Status.LockRecoveryUnexpected",
      "FBL WebP Migrator: compendium lock recovery failed unexpectedly. See console."
    ));
  }

  console.info(`${MODULE_TITLE} ${MODULE_VERSION} ready. Open with game.fblWebpMigrator.open()`);
});
