import { DEFAULT_SCAN_OPTIONS, MODULE_ID, MODULE_TITLE } from "./constants.mjs";
import { createAssumedConversionReport, applyMigration, rollbackMigration, sanitizeConversionReport } from "./migration.mjs";
import { sanitizeScanOptions, scanFoundry } from "./scanner.mjs";
import { deepClone } from "./path-utils.mjs";
import { readScanOptionsFromRoot } from "./ui-options.mjs";

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function saveJsonFile(data, filename) {
  const json = JSON.stringify(data, null, 2);
  if (typeof globalThis.saveDataToFile === "function") return globalThis.saveDataToFile(json, "application/json", filename);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function confirmAction({ title, content, yes = "Продолжить" }) {
  const DialogV2 = foundry.applications.api.DialogV2;
  if (typeof DialogV2?.confirm === "function") {
    return DialogV2.confirm({
      window: { title },
      content,
      yes: { label: yes, icon: "fas fa-check" },
      no: { label: "Отмена", icon: "fas fa-xmark" }
    });
  }
  if (typeof globalThis.Dialog?.confirm === "function") return Dialog.confirm({ title, content, yes: () => true, no: () => false, defaultYes: false });
  return globalThis.confirm?.(content) ?? false;
}

function optionRows(options) {
  return [
    ["worldActors", "Actors в мире", "Actor, prototype token, embedded Items и Active Effects"],
    ["worldItems", "Items в мире", "Изображения Item, flags, system и Active Effects"],
    ["worldScenes", "Scenes", "Фон/передний план, Tokens, Tiles, Drawings, Notes, Templates, Regions и другие данные Scene"],
    ["worldJournals", "Journal", "Страницы image/video/PDF и PNG-ссылки внутри HTML/Markdown"],
    ["worldTables", "Roll Tables", "Изображения таблиц и результатов"],
    ["worldCards", "Cards", "Стопки, карты, faces и backs"],
    ["worldMacros", "Macros", "Иконки и локальные PNG-пути внутри command"],
    ["worldUsers", "Users", "Аватары пользователей; выключено по умолчанию"],
    ["worldOther", "Playlists, Combats, Folders", "Редкие PNG-пути в flags и дополнительных полях"],
    ["chatMessages", "Chat Messages", "Исторические HTML-карточки; может быть медленно"],
    ["worldCompendiums", "World Compendiums", "Поддерживаемые паки мира; заблокированные паки временно открываются при применении"],
    ["packageCompendiums", "System/Module Compendiums", "Сканируются, но запись выключена по умолчанию"],
    ["richText", "Искать внутри текста", "HTML, Markdown, Macro command, flags и system strings"],
    ["autoUnlockWorldPacks", "Временно открывать world packs", "После миграции исходная блокировка восстанавливается"],
    ["allowPackageCompendiumWrites", "Разрешить запись в package packs", "Опасно: обновление модуля или системы может затереть изменения"]
  ].map(([key, label, hint]) => ({ key, label, hint, checked: !!options[key] }));
}

function previewManifest(manifest) {
  return (manifest?.entries ?? []).slice(0, 150).map((entry) => ({
    oldPath: entry.oldPath,
    newPath: entry.newPath,
    refCount: entry.refs?.length ?? 0,
    wildcard: entry.wildcard ? "Да" : ""
  }));
}

function previewConversion(report) {
  return (report?.entries ?? []).slice(0, 150).map((entry) => ({
    oldPath: entry.oldPath,
    status: entry.status,
    oldSize: entry.oldSize ?? "",
    newSize: entry.newSize ?? "",
    savedPercent: Number.isFinite(entry.savedPercent) ? `${entry.savedPercent}%` : ""
  }));
}


function createInitialState() {
  return {
    busy: false,
    status: "Готово.",
    lastError: "",
    options: deepClone(DEFAULT_SCAN_OPTIONS),
    manifest: null,
    conversionReport: null,
    migrationReport: null,
    rollbackSummary: null
  };
}

function previewMigration(report) {
  return (report?.migrated ?? []).slice(0, 150).map((entry) => ({
    oldPath: entry.oldPath,
    newPath: entry.newPath,
    refCount: entry.refCount,
    changed: entry.changed,
    already: entry.already
  }));
}

export class WebpMigratorApp extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  static _sharedState = createInitialState();

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-app`,
    tag: "form",
    classes: ["fwm-window"],
    window: {
      title: "PNG → WebP Migrator",
      icon: "fas fa-file-image",
      resizable: true
    },
    position: { width: 1080, height: 820 },
    form: {
      closeOnSubmit: false,
      submitOnChange: false,
      handler: WebpMigratorApp._onSubmit
    },
    actions: {
      scan: WebpMigratorApp._onScanAction,
      exportManifest: WebpMigratorApp._onExportManifestAction,
      assumeConverted: WebpMigratorApp._onAssumeConvertedAction,
      applyReport: WebpMigratorApp._onApplyReportAction,
      exportMigrationReport: WebpMigratorApp._onExportMigrationReportAction,
      rollback: WebpMigratorApp._onRollbackAction,
      reset: WebpMigratorApp._onResetAction
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/app.hbs` }
  };

  constructor(options = {}) {
    super(options);
    this._viewState = WebpMigratorApp._sharedState;
    this._fileChangeHandler = (event) => this._importConversionReport(event);
    this._renderListeners = null;
    this._optionChangeHandler = (event) => {
      if (!event.target?.matches?.("input[type='checkbox'][name]")) return;
      this._readOptions();
    };
  }

  _canRender(options) {
    if (!game.user?.isGM) throw new Error("FBL WebP Migrator доступен только GM.");
    return super._canRender(options);
  }

  static async _onSubmit(event) {
    event?.preventDefault?.();
  }

  async _prepareContext(options) {
    const state = this._viewState;
    return {
      moduleId: MODULE_ID,
      busy: state.busy,
      status: state.status,
      lastError: state.lastError,
      optionRows: optionRows(state.options),
      manifest: state.manifest,
      conversionReport: state.conversionReport,
      migrationReport: state.migrationReport,
      rollbackSummary: state.rollbackSummary,
      hasManifest: !!state.manifest,
      hasReport: !!state.conversionReport,
      hasMigrationReport: !!state.migrationReport,
      canExportManifest: !state.busy && !!state.manifest,
      canAssumeConverted: !state.busy && !!state.manifest,
      canApplyReport: !state.busy && !!state.conversionReport,
      canExportMigrationReport: !state.busy && !!state.migrationReport,
      canRollback: !state.busy && !!state.migrationReport,
      manifestSummary: state.manifest?.summary ?? null,
      conversionSummary: state.conversionReport?.summary ?? null,
      migrationSummary: state.migrationReport?.summary ?? null,
      manifestPreview: previewManifest(state.manifest),
      conversionPreview: previewConversion(state.conversionReport),
      migrationPreview: previewMigration(state.migrationReport)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._renderListeners?.abort();
    this._renderListeners = new AbortController();
    const { signal } = this._renderListeners;
    const input = this.element.querySelector("input[name='conversionReportFile']");
    input?.addEventListener("change", this._fileChangeHandler, { once: true, signal });
    this.element.addEventListener("change", this._optionChangeHandler, { signal });
  }

  _readOptions() {
    const root = this.form ?? this.element;
    this._viewState.options = readScanOptionsFromRoot(root, this._viewState.options, DEFAULT_SCAN_OPTIONS);
    return deepClone(this._viewState.options);
  }

  async _renderNow() {
    if (this.rendered) await this.render({ force: true });
  }

  async _runAction(initialStatus, task) {
    if (this._viewState.busy) return;

    // Snapshot the live checkbox values before the busy render replaces the form DOM.
    // Without this, ApplicationV2 redraws the old state first and the scan silently
    // falls back to DEFAULT_SCAN_OPTIONS.
    const actionOptions = this._readOptions();

    this._viewState.busy = true;
    this._viewState.status = initialStatus;
    this._viewState.lastError = "";
    await this._renderNow();
    try {
      await task(actionOptions);
    } catch (error) {
      console.error(`${MODULE_TITLE} | Action failed`, error);
      this._viewState.lastError = error?.message ?? String(error);
      this._viewState.status = "Ошибка. Подробности записаны в консоль.";
      ui.notifications.error(this._viewState.lastError);
    } finally {
      this._viewState.busy = false;
      await this._renderNow();
    }
  }

  static _onScanAction(event) {
    event.preventDefault();
    return this._runAction("Сканирую документы Foundry...", async (options) => {
      const manifest = await scanFoundry(options, {
        onProgress: ({ phase, current, total, label }) => {
          this._viewState.status = phase === "pack"
            ? `Читаю compendium ${current}/${total}: ${label}`
            : `Сканирую ${current}/${total}: ${label}`;
        }
      });
      this._viewState.manifest = manifest;
      this._viewState.conversionReport = null;
      this._viewState.migrationReport = null;
      this._viewState.rollbackSummary = null;
      this._viewState.status = `Готово: ${manifest.summary.uniquePngPaths} PNG-путей, ${manifest.summary.documentReferences} ссылок, ${manifest.summary.scannedDocumentsIncludingEmbedded} документов.`;
    });
  }

  static _onExportManifestAction(event) {
    event.preventDefault();
    if (this._viewState.busy) return;
    try {
      const manifest = this._viewState.manifest;
      if (!manifest) return ui.notifications.warn("Сначала выполни сканирование.");
      saveJsonFile(manifest, `${game.world?.id ?? "world"}-webp-manifest-${nowStamp()}.json`);
    } catch (error) {
      console.error(`${MODULE_TITLE} | Export manifest failed`, error);
      ui.notifications.error(error?.message ?? String(error));
    }
  }

  static _onAssumeConvertedAction(event) {
    event.preventDefault();
    return this._runAction("Подтверждаю существование WEBP...", async () => {
      const manifest = this._viewState.manifest;
      if (!manifest) throw new Error("Сначала выполни сканирование.");
      const confirmed = await confirmAction({
        title: "WEBP уже существуют?",
        content: `<p>Foundry не может проверить диск. Путь будет заменен для <strong>${manifest.summary.documentReferences}</strong> ссылок только по текущему manifest.</p><p>Используй это действие только после успешной внешней конвертации.</p>`,
        yes: "Считать WEBP готовыми"
      });
      if (!confirmed) {
        this._viewState.status = "Действие отменено.";
        return;
      }
      this._viewState.conversionReport = createAssumedConversionReport(manifest);
      this._viewState.migrationReport = null;
      this._viewState.status = `Создан внутренний отчет для ${manifest.summary.uniquePngPaths} путей. Проверки файлов не было.`;
    });
  }

  static _onApplyReportAction(event) {
    event.preventDefault();
    return this._runAction("Применяю .webp-пути...", async (options) => {
      const manifest = this._viewState.manifest;
      const report = this._viewState.conversionReport;
      if (!manifest || !report) throw new Error("Нужны текущий manifest и подтвержденный conversion report.");
      const confirmed = await confirmAction({
        title: "Применить миграцию",
        content: `<p>Будут обновлены только поля, которые все еще содержат значения из текущего manifest.</p><p>Изменившиеся после сканирования поля будут помечены как stale и не перезаписаны.</p>`,
        yes: "Применить пути"
      });
      if (!confirmed) {
        this._viewState.status = "Миграция отменена.";
        return;
      }
      const migration = await applyMigration(manifest, report, options, {
        onProgress: ({ current, total, label }) => {
          this._viewState.status = `Обновляю ${current}/${total}: ${label}`;
        }
      });
      this._viewState.migrationReport = migration;
      this._viewState.rollbackSummary = null;
      this._viewState.status = `Миграция завершена: ${migration.summary.fullyMigratedPngPaths} путей готовы к cleanup, ${migration.summary.changedReferences} ссылок изменено, ${migration.summary.staleReferences} устарело, ${migration.summary.errors} ошибок.`;
    });
  }

  static _onExportMigrationReportAction(event) {
    event.preventDefault();
    if (this._viewState.busy) return;
    try {
      const report = this._viewState.migrationReport;
      if (!report) return ui.notifications.warn("Сначала примени миграцию.");
      saveJsonFile(report, `${game.world?.id ?? "world"}-webp-migration-${nowStamp()}.json`);
    } catch (error) {
      console.error(`${MODULE_TITLE} | Export migration report failed`, error);
      ui.notifications.error(error?.message ?? String(error));
    }
  }

  static _onRollbackAction(event) {
    event.preventDefault();
    return this._runAction("Откатываю измененные пути...", async (options) => {
      const report = this._viewState.migrationReport;
      if (!report) throw new Error("Нет migration report текущего запуска.");
      const confirmed = await confirmAction({
        title: "Откатить пути",
        content: "<p>Будут возвращены только ссылки, которые изменил текущий запуск. Файлы на диске не изменяются.</p>",
        yes: "Откатить"
      });
      if (!confirmed) {
        this._viewState.status = "Откат отменен.";
        return;
      }
      const result = await rollbackMigration(report, options, {
        onProgress: ({ current, total, label }) => {
          this._viewState.status = `Откат ${current}/${total}: ${label}`;
        }
      });
      this._viewState.rollbackSummary = result;
      this._viewState.status = `Откат завершен: ${result.changed} возвращено, ${result.already} уже было PNG, ${result.stale} устарело, ${result.errors} ошибок.`;
    });
  }

  static _onResetAction(event) {
    event.preventDefault();
    if (this._viewState.busy) return;
    const options = this._readOptions();
    Object.assign(this._viewState, createInitialState(), {
      status: "Состояние сброшено.",
      options
    });
    return this._renderNow();
  }

  async _importConversionReport(event) {
    const file = event.target.files?.[0];
    if (!file || this._viewState.busy) return;
    await this._runAction("Импортирую conversion report...", async () => {
      const manifest = this._viewState.manifest;
      if (!manifest) throw new Error("Сначала выполни сканирование и оставь этот manifest активным.");
      const raw = JSON.parse(await file.text());
      const report = sanitizeConversionReport(raw, manifest);
      this._viewState.conversionReport = report;
      this._viewState.migrationReport = null;
      this._viewState.rollbackSummary = null;
      this._viewState.status = `Отчет принят: ${report.entries.length} совпавших путей, ${report.ignored.length} чужих или устаревших записей отклонено.`;
    });
    event.target.value = "";
  }
}
