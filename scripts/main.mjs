import { MODULE_ID, MODULE_TITLE, MODULE_VERSION } from "./constants.mjs";
import { WebpMigratorApp } from "./app.mjs";
import { applyMigration, sanitizeConversionReport } from "./migration.mjs";
import { sanitizeScanOptions, scanFoundry } from "./scanner.mjs";

let appInstance = null;

function requireGM() {
  if (!game.user?.isGM) throw new Error(`${MODULE_TITLE} доступен только GM.`);
}

function openApp() {
  requireGM();
  appInstance ??= new WebpMigratorApp();
  appInstance.render({ force: true });
  return appInstance;
}

Hooks.once("init", () => {
  game.settings.registerMenu(MODULE_ID, "migrator", {
    name: "PNG → WebP Migrator",
    label: "Открыть мигратор",
    hint: "Сканирование PNG-ссылок, внешний cwebp и безопасная миграция путей.",
    icon: "fas fa-file-image",
    type: WebpMigratorApp,
    restricted: true
  });
});

Hooks.once("ready", () => {
  game.fblWebpMigrator = Object.freeze({
    version: MODULE_VERSION,
    open: openApp,
    async scanToManifest(options = {}) {
      requireGM();
      return scanFoundry(sanitizeScanOptions(options));
    },
    async applyManifestReport(manifest, rawReport, options = {}) {
      requireGM();
      const report = sanitizeConversionReport(rawReport, manifest);
      return applyMigration(manifest, report, options);
    }
  });
  console.info(`${MODULE_TITLE} ${MODULE_VERSION} ready. Open with game.fblWebpMigrator.open()`);
});
