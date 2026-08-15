import { DEFAULT_SCAN_OPTIONS, MODULE_ID, MODULE_TITLE } from "./constants.mjs";
import {
  applyMigration,
  createAssumedConversionReport,
  countCorePublicPlaceholderReferences,
  mergeMigrationReports,
  rollbackCorePublicPlaceholders,
  rollbackMigration,
  withoutCorePublicPlaceholderReferences,
  sanitizeConversionReport,
  sanitizeMigrationReportForRollback
} from "./migration.mjs";
import {
  applyConsistencyRepairs,
  applyMissingPlaceholderRepairs,
  repairImageHoverSpecificArtOverrides,
  sanitizeConsistencyReport
} from "./consistency.mjs";
import { sanitizeManifest, scanFoundry } from "./scanner.mjs";
import { deepClone } from "./path-utils.mjs";
import { readScanOptionsFromRoot } from "./ui-options.mjs";

const PREVIEW_LIMIT = 150;

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

function safeFilenamePart(value, fallback = "report") {
  const cleaned = String(value ?? "").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function saveJsonFile(data, filename) {
  const json = JSON.stringify(data, null, 2);
  if (typeof globalThis.saveDataToFile === "function") {
    return globalThis.saveDataToFile(json, "application/json", filename);
  }
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

async function readJsonFile(file) {
  if (!file) throw new Error(tr("FWM.Errors.NoFile", "Файл не выбран."));
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(tr("FWM.Errors.InvalidJson", `Не удалось прочитать JSON: ${error.message}`, { message: error.message }));
  }
}

async function confirmAction({ title, content, yes = null }) {
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  const yesLabel = yes ?? tr("FWM.Actions.Continue", "Продолжить");
  if (typeof DialogV2?.confirm === "function") {
    return DialogV2.confirm({
      window: { title },
      content,
      yes: { label: yesLabel, icon: "fas fa-check" },
      no: { label: tr("FWM.Actions.Cancel", "Отмена"), icon: "fas fa-xmark" },
      defaultYes: false,
      rejectClose: false,
      modal: true
    });
  }
  if (typeof globalThis.Dialog?.confirm === "function") {
    return globalThis.Dialog.confirm({
      title,
      content,
      yes: () => true,
      no: () => false,
      defaultYes: false
    });
  }
  return globalThis.confirm?.(content) ?? false;
}

function optionRows(options) {
  const rows = [
    ["worldActors", "FWM.Options.WorldActors.Label", "Actors в мире", "FWM.Options.WorldActors.Hint", "Actor, prototype token, embedded Items и Active Effects"],
    ["worldItems", "FWM.Options.WorldItems.Label", "Items в мире", "FWM.Options.WorldItems.Hint", "Изображения Item, flags, system и Active Effects"],
    ["worldScenes", "FWM.Options.WorldScenes.Label", "Scenes", "FWM.Options.WorldScenes.Hint", "Фон, foreground, Tokens, Tiles, Drawings, Notes, Templates, Regions и другие данные Scene"],
    ["worldJournals", "FWM.Options.WorldJournals.Label", "Journal", "FWM.Options.WorldJournals.Hint", "Страницы image/video/PDF и PNG-ссылки внутри HTML/Markdown"],
    ["worldTables", "FWM.Options.WorldTables.Label", "Roll Tables", "FWM.Options.WorldTables.Hint", "Изображения таблиц и результатов"],
    ["worldCards", "FWM.Options.WorldCards.Label", "Cards", "FWM.Options.WorldCards.Hint", "Стопки, карты, faces и backs"],
    ["worldMacros", "FWM.Options.WorldMacros.Label", "Macros", "FWM.Options.WorldMacros.Hint", "Иконки и локальные PNG-пути внутри command"],
    ["worldUsers", "FWM.Options.WorldUsers.Label", "Users", "FWM.Options.WorldUsers.Hint", "Аватары пользователей; выключено по умолчанию"],
    ["worldOther", "FWM.Options.WorldOther.Label", "Playlists, Combats, Folders", "FWM.Options.WorldOther.Hint", "Редкие PNG-пути в flags и дополнительных полях"],
    ["chatMessages", "FWM.Options.ChatMessages.Label", "Chat Messages", "FWM.Options.ChatMessages.Hint", "Только сообщения, загруженные в текущую сессию Foundry"],
    ["worldCompendiums", "FWM.Options.WorldCompendiums.Label", "World Compendiums", "FWM.Options.WorldCompendiums.Hint", "Поддерживаемые паки мира; заблокированные паки временно открываются при применении"],
    ["packageCompendiums", "FWM.Options.PackageCompendiums.Label", "System/Module Compendiums", "FWM.Options.PackageCompendiums.Hint", "Сканируются только при явном включении"],
    ["richText", "FWM.Options.RichText.Label", "Искать внутри текста", "FWM.Options.RichText.Hint", "HTML, Markdown, Macro command, flags и system strings"],
    ["autoUnlockWorldPacks", "FWM.Options.AutoUnlock.Label", "Временно открывать world packs", "FWM.Options.AutoUnlock.Hint", "После миграции исходная блокировка восстанавливается"],
    ["allowPackageCompendiumWrites", "FWM.Options.PackageWrites.Label", "Разрешить запись в package packs", "FWM.Options.PackageWrites.Hint", "Только уже разблокированные паки. Обновление системы или модуля может затереть изменения"]
  ];
  return rows.map(([key, labelKey, label, hintKey, hint]) => ({
    key,
    label: tr(labelKey, label),
    hint: tr(hintKey, hint),
    checked: !!options[key],
    dangerous: key === "allowPackageCompendiumWrites"
  }));
}

function previewRows(rows, mapper) {
  const source = Array.isArray(rows) ? rows : [];
  return {
    rows: source.slice(0, PREVIEW_LIMIT).map(mapper),
    shown: Math.min(source.length, PREVIEW_LIMIT),
    total: source.length,
    truncated: source.length > PREVIEW_LIMIT
  };
}

function previewManifest(manifest) {
  const rows = [
    ...(manifest?.entries ?? []).map((entry) => ({ ...entry, sourceFormat: "PNG" })),
    ...(manifest?.webpEntries ?? []).map((entry) => ({ ...entry, sourceFormat: "WEBP" }))
  ].sort((a, b) => a.oldPath.localeCompare(b.oldPath) || a.sourceFormat.localeCompare(b.sourceFormat));
  return previewRows(rows, (entry) => ({
    sourceFormat: entry.sourceFormat,
    oldPath: entry.oldPath,
    newPath: entry.newPath,
    refCount: entry.refs?.length ?? 0,
    wildcard: entry.wildcard ? tr("FWM.Common.Yes", "Да") : ""
  }));
}

function previewConversion(report) {
  return previewRows(report?.entries, (entry) => ({
    oldPath: entry.oldPath,
    status: entry.status,
    oldSize: entry.oldSize ?? "",
    newSize: entry.newSize ?? "",
    savedPercent: Number.isFinite(entry.savedPercent) ? `${entry.savedPercent}%` : "",
    detail: entry.error ?? entry.files?.find((file) => file.error)?.error ?? ""
  }));
}

function previewMigration(report) {
  return previewRows(report?.migrated, (entry) => ({
    oldPath: entry.oldPath,
    newPath: entry.newPath,
    refCount: entry.refCount,
    changed: entry.changed,
    already: entry.already,
    cleanupFiles: entry.cleanupEligibleFiles ?? 0,
    direction: entry.direction ?? "png-to-webp"
  }));
}

function previewConsistency(report) {
  return previewRows(report?.entries, (entry) => ({
    oldPath: entry.oldPath,
    newPath: entry.newPath,
    status: entry.status,
    pngRefs: entry.pngRefCount,
    webpRefs: entry.webpRefCount,
    files: entry.files?.length ?? 0,
    repair: entry.forwardAuthorized
      ? tr("FWM.Consistency.ToWebp", "PNG → WEBP")
      : entry.reverseAuthorized
        ? tr("FWM.Consistency.ToPng", "WEBP → PNG")
        : entry.placeholderAuthorized
          ? tr("FWM.Consistency.ToPlaceholder", "→ Заглушка")
          : ""
  }));
}

function collectManifestIssues(manifest) {
  return previewRows(manifest?.skipped, (issue) => ({
    scope: issue.uuid ?? issue.pack ?? issue.label ?? "Manifest",
    status: issue.status ?? "skipped",
    detail: issue.error ?? issue.reason ?? ""
  }));
}

function collectConversionIssues(report) {
  const issues = [];
  for (const entry of report?.entries ?? []) {
    if (["failed", "skipped", "larger"].includes(entry.status)) {
      issues.push({ scope: entry.oldPath, status: entry.status, detail: entry.error ?? "" });
    }
    for (const file of entry.files ?? []) {
      if (!["failed", "skipped", "larger"].includes(file.status)) continue;
      issues.push({ scope: file.oldPath ?? entry.oldPath, status: file.status, detail: file.error ?? "" });
    }
  }
  return previewRows(issues, (issue) => issue);
}

function collectMigrationIssues(report) {
  return previewRows(report?.issues, (issue) => ({
    scope: issue.uuid ?? issue.pack ?? issue.oldPath ?? "Migration",
    status: issue.status ?? "issue",
    detail: [issue.fieldLabel, issue.error].filter(Boolean).join(": ")
  }));
}

function collectRollbackIssues(summary) {
  return previewRows(summary?.issues, (issue) => ({
    scope: issue.ref?.uuid ?? issue.pack ?? "Rollback",
    status: issue.status ?? "issue",
    detail: [issue.ref?.fieldLabel, issue.error].filter(Boolean).join(": ")
  }));
}

function collectConsistencyIssues(report) {
  const issues = [];
  for (const entry of report?.entries ?? []) {
    if (["unresolved", "conflict"].includes(entry.status)) {
      issues.push({
        scope: entry.oldPath,
        status: entry.status,
        detail: tr("FWM.Consistency.UnresolvedDetail", "Автоматическое исправление для всей пары небезопасно.")
      });
    }
    for (const file of entry.files ?? []) {
      if (["both-valid", "png-only", "webp-only"].includes(file.category)) continue;
      issues.push({
        scope: file.oldPath,
        status: file.category,
        detail: file.category === "both-missing" && entry.placeholderAuthorized
          ? tr("FWM.Consistency.BothMissingRepairable", "Оба файла отсутствуют; доступна безопасная замена ссылки на заглушку.")
          : [file.png?.error, file.webp?.error].filter(Boolean).join("; ")
      });
    }
  }
  for (const issue of report?.ignored ?? []) {
    issues.push({ scope: issue.oldPath ?? "Consistency", status: "ignored", detail: issue.reason ?? "" });
  }
  return previewRows(issues, (issue) => issue);
}

function createInitialState() {
  return {
    busy: false,
    status: tr("FWM.Status.Ready", "Готово."),
    lastError: "",
    options: deepClone(DEFAULT_SCAN_OPTIONS),
    manifest: null,
    consistencyReport: null,
    conversionReport: null,
    migrationReport: null,
    rollbackReport: null,
    rollbackSummary: null
  };
}

const ApplicationV2 = globalThis.foundry?.applications?.api?.ApplicationV2;
const HandlebarsApplicationMixin = globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin;

export class WebpMigratorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static _sharedState = createInitialState();

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-app`,
    tag: "form",
    classes: ["fwm-window"],
    window: {
      title: "FWM.WindowTitle",
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
      applyConsistency: WebpMigratorApp._onApplyConsistencyAction,
      applyMissingPlaceholder: WebpMigratorApp._onApplyMissingPlaceholderAction,
      repairImageHover: WebpMigratorApp._onRepairImageHoverAction,
      applyReport: WebpMigratorApp._onApplyReportAction,
      exportMigrationReport: WebpMigratorApp._onExportMigrationReportAction,
      rollback: WebpMigratorApp._onRollbackAction,
      rollbackCorePublic: WebpMigratorApp._onRollbackCorePublicAction,
      cancel: WebpMigratorApp._onCancelAction,
      reset: WebpMigratorApp._onResetAction
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/app.hbs` }
  };

  constructor(options = {}) {
    super(options);
    this._viewState = WebpMigratorApp._sharedState;
    this._renderListeners = null;
    this._activeController = null;
    this._lastProgressPaint = 0;
    this._optionChangeHandler = (event) => {
      if (!event.target?.matches?.("input[type='checkbox'][name]")) return;
      this._readOptions();
    };
  }

  _canRender(options) {
    if (!game.user?.isGM) throw new Error(tr("FWM.Errors.GmOnly", "FBL WebP Migrator доступен только GM."));
    return super._canRender(options);
  }

  static async _onSubmit(event) {
    event?.preventDefault?.();
  }

  async _prepareContext(options) {
    const state = this._viewState;
    const manifestPreview = previewManifest(state.manifest);
    const conversionPreview = previewConversion(state.conversionReport);
    const consistencyPreview = previewConsistency(state.consistencyReport);
    const migrationPreview = previewMigration(state.migrationReport);
    const manifestIssues = collectManifestIssues(state.manifest);
    const conversionIssues = collectConversionIssues(state.conversionReport);
    const consistencyIssues = collectConsistencyIssues(state.consistencyReport);
    const migrationIssues = collectMigrationIssues(state.migrationReport);
    const rollbackIssues = collectRollbackIssues(state.rollbackSummary);
    const worldPart = safeFilenamePart(game.world?.id, "world");
    const manifestName = `${worldPart}-webp-manifest.json`;
    const migrationName = `${worldPart}-webp-migration-report.json`;

    return {
      moduleId: MODULE_ID,
      busy: state.busy,
      status: state.status,
      lastError: state.lastError,
      optionRows: optionRows(state.options),
      manifest: state.manifest,
      conversionReport: state.conversionReport,
      consistencyReport: state.consistencyReport,
      migrationReport: state.migrationReport,
      rollbackSummary: state.rollbackSummary,
      hasManifest: !!state.manifest,
      hasReport: !!state.conversionReport,
      hasConsistencyReport: !!state.consistencyReport,
      hasMigrationReport: !!state.migrationReport,
      hasRollbackReport: !!state.rollbackReport?.changedRefs?.length,
      canExportManifest: !state.busy && !!state.manifest,
      canAssumeConverted: !state.busy && !!state.manifest,
      canApplyReport: !state.busy && !!state.manifest && !!state.conversionReport,
      canApplyConsistency: !state.busy
        && !!state.manifest
        && !!state.consistencyReport
        && ((state.consistencyReport.summary?.forwardRepairPaths ?? 0) + (state.consistencyReport.summary?.reverseRepairPaths ?? 0) > 0),
      canApplyMissingPlaceholder: !state.busy
        && !!state.manifest
        && !!state.consistencyReport
        && (state.consistencyReport.summary?.placeholderRepairPaths ?? 0) > 0,
      canRepairImageHover: !state.busy,
      canExportMigrationReport: !state.busy && !!state.migrationReport,
      canRollback: !state.busy && !!state.rollbackReport?.changedRefs?.length,
      canRollbackCorePublic: !state.busy && countCorePublicPlaceholderReferences(state.rollbackReport) > 0,
      corePublicRollbackCount: countCorePublicPlaceholderReferences(state.rollbackReport),
      canCancel: state.busy && !!this._activeController,
      manifestSummary: state.manifest?.summary ?? null,
      conversionSummary: state.conversionReport?.summary ?? null,
      consistencySummary: state.consistencyReport?.summary ?? null,
      migrationSummary: state.migrationReport?.summary ?? null,
      manifestPreview: manifestPreview.rows,
      conversionPreview: conversionPreview.rows,
      consistencyPreview: consistencyPreview.rows,
      migrationPreview: migrationPreview.rows,
      manifestPreviewMeta: manifestPreview,
      conversionPreviewMeta: conversionPreview,
      consistencyPreviewMeta: consistencyPreview,
      migrationPreviewMeta: migrationPreview,
      manifestIssues: manifestIssues.rows,
      conversionIssues: conversionIssues.rows,
      consistencyIssues: consistencyIssues.rows,
      migrationIssues: migrationIssues.rows,
      rollbackIssues: rollbackIssues.rows,
      manifestIssuesMeta: manifestIssues,
      conversionIssuesMeta: conversionIssues,
      consistencyIssuesMeta: consistencyIssues,
      migrationIssuesMeta: migrationIssues,
      rollbackIssuesMeta: rollbackIssues,
      manifestName,
      migrationName,
      conversionCommand: `node tools/convert-cwebp.js --manifest "${manifestName}" --data "C:\\FoundryVTT\\Data" --world-id "${worldPart}" --cwebp "C:\\libwebp\\bin\\cwebp.exe" --quality 85`,
      consistencyCommand: `node tools/convert-cwebp.js --audit "${manifestName}" --data "C:\\FoundryVTT\\Data" --world-id "${worldPart}"`,
      cleanupCommand: `node tools/convert-cwebp.js --cleanup "${migrationName}" --data "C:\\FoundryVTT\\Data" --world-id "${worldPart}"`,
      quarantineCommand: `node tools/convert-cwebp.js --cleanup "${migrationName}" --data "C:\\FoundryVTT\\Data" --world-id "${worldPart}" --delete`,
      restoreCommand: `node tools/convert-cwebp.js --restore "cleanup-report-....json" --data "C:\\FoundryVTT\\Data" --world-id "${worldPart}"`
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._renderListeners?.abort();
    this._renderListeners = new AbortController();
    const { signal } = this._renderListeners;
    const bindFile = (name, handler) => {
      this.element.querySelector(`input[name='${name}']`)?.addEventListener("change", handler, { signal });
    };
    bindFile("manifestFile", (event) => this._importManifest(event));
    bindFile("conversionReportFile", (event) => this._importConversionReport(event));
    bindFile("consistencyReportFile", (event) => this._importConsistencyReport(event));
    bindFile("migrationReportFile", (event) => this._importMigrationReport(event));
    this.element.addEventListener("change", this._optionChangeHandler, { signal });
  }

  _readOptions() {
    const root = this.form ?? this.element;
    this._viewState.options = readScanOptionsFromRoot(root, this._viewState.options, DEFAULT_SCAN_OPTIONS);
    return deepClone(this._viewState.options);
  }

  _paintStatus() {
    const statusNode = this.element?.querySelector?.("[data-fwm-status-text]");
    if (statusNode) statusNode.textContent = this._viewState.status;
    const errorNode = this.element?.querySelector?.("[data-fwm-error-text]");
    if (errorNode) {
      errorNode.textContent = this._viewState.lastError;
      errorNode.hidden = !this._viewState.lastError;
    }
    this.element?.querySelector?.("[data-fwm-status]")?.classList?.toggle("is-error", !!this._viewState.lastError);
  }

  _setStatus(status, { error = "", force = false } = {}) {
    this._viewState.status = status;
    this._viewState.lastError = error;
    const now = Date.now();
    if (force || now - this._lastProgressPaint >= 80) {
      this._lastProgressPaint = now;
      this._paintStatus();
    }
  }

  async _renderNow() {
    if (this.rendered) await this.render({ force: true });
  }

  async _runAction(initialStatus, task) {
    if (this._viewState.busy) return;
    const actionOptions = this._readOptions();
    this._viewState.busy = true;
    this._activeController = new AbortController();
    this._setStatus(initialStatus, { force: true });
    await this._renderNow();
    try {
      await task(actionOptions, this._activeController.signal);
    } catch (error) {
      if (error?.name === "AbortError") {
        this._setStatus(tr("FWM.Status.Cancelled", "Действие отменено."), { force: true });
        return;
      }
      console.error(`${MODULE_TITLE} | Action failed`, error);
      const message = error?.message ?? String(error);
      this._setStatus(tr("FWM.Status.Error", "Ошибка. Подробности записаны в консоль."), { error: message, force: true });
      ui.notifications.error(message);
    } finally {
      this._activeController = null;
      this._viewState.busy = false;
      await this._renderNow();
    }
  }

  static _onCancelAction(event) {
    event.preventDefault();
    if (!this._activeController || this._activeController.signal.aborted) return;
    this._activeController.abort();
    this._setStatus(tr("FWM.Status.Cancelling", "Останавливаю операцию..."), { force: true });
  }

  async _importManifest(event) {
    const input = event.currentTarget;
    const file = input?.files?.[0];
    if (!file) return;
    await this._runAction(tr("FWM.Status.ImportingManifest", "Импортирую manifest..."), async () => {
      const raw = await readJsonFile(file);
      const manifest = sanitizeManifest(raw, game.world?.id ?? null);
      this._viewState.manifest = manifest;
      this._viewState.options = { ...this._viewState.options, ...manifest.options };
      this._viewState.conversionReport = null;
      this._viewState.consistencyReport = null;
      this._viewState.migrationReport = null;
      this._viewState.rollbackSummary = null;
      this._setStatus(tr(
        "FWM.Status.ManifestImported",
        `Manifest импортирован: ${manifest.summary.uniquePngPaths} PNG-путей и ${manifest.summary.uniqueWebpPaths} WEBP-путей.`,
        { count: manifest.summary.uniquePngPaths, webpCount: manifest.summary.uniqueWebpPaths }
      ), { force: true });
    });
    if (input) input.value = "";
  }

  async _importConversionReport(event) {
    const input = event.currentTarget;
    const file = input?.files?.[0];
    if (!file) return;
    await this._runAction(tr("FWM.Status.ImportingConversion", "Импортирую conversion report..."), async () => {
      if (!this._viewState.manifest) throw new Error(tr("FWM.Errors.ImportManifestFirst", "Сначала создай или импортируй manifest."));
      const raw = await readJsonFile(file);
      const report = sanitizeConversionReport(raw, this._viewState.manifest, game.world?.id ?? null);
      this._viewState.conversionReport = report;
      this._viewState.migrationReport = null;
      this._viewState.rollbackSummary = null;
      this._setStatus(tr("FWM.Status.ConversionImported", `Conversion report импортирован: ${report.summary.verifiedEntries} подтвержденных записей.`, { count: report.summary.verifiedEntries }), { force: true });
    });
    if (input) input.value = "";
  }

  async _importConsistencyReport(event) {
    const input = event.currentTarget;
    const file = input?.files?.[0];
    if (!file) return;
    await this._runAction(tr("FWM.Status.ImportingConsistency", "Импортирую consistency report..."), async () => {
      if (!this._viewState.manifest) throw new Error(tr("FWM.Errors.ImportManifestFirst", "Сначала создай или импортируй manifest."));
      const raw = await readJsonFile(file);
      const report = sanitizeConsistencyReport(raw, this._viewState.manifest, game.world?.id ?? null);
      this._viewState.consistencyReport = report;
      this._viewState.rollbackSummary = null;
      this._setStatus(tr(
        "FWM.Status.ConsistencyImported",
        `Проверка импортирована: ${report.summary.forwardRepairPaths} путей можно перевести на WEBP, ${report.summary.reverseRepairPaths} вернуть на PNG, ${report.summary.placeholderRepairPaths ?? 0} заменить на заглушку.`,
        { forward: report.summary.forwardRepairPaths, reverse: report.summary.reverseRepairPaths, placeholder: report.summary.placeholderRepairPaths ?? 0 }
      ), { force: true });
    });
    if (input) input.value = "";
  }

  async _importMigrationReport(event) {
    const input = event.currentTarget;
    const file = input?.files?.[0];
    if (!file) return;
    await this._runAction(tr("FWM.Status.ImportingMigration", "Импортирую migration report..."), async () => {
      const raw = await readJsonFile(file);
      const report = sanitizeMigrationReportForRollback(raw, game.world?.id ?? null);
      this._viewState.rollbackReport = mergeMigrationReports(this._viewState.rollbackReport, report);
      this._viewState.rollbackSummary = null;
      this._setStatus(tr("FWM.Status.MigrationImported", `Migration report импортирован: ${report.changedRefs.length} ссылок доступны для отката.`, { count: report.changedRefs.length }), { force: true });
    });
    if (input) input.value = "";
  }

  static _onScanAction(event) {
    event.preventDefault();
    return this._runAction(tr("FWM.Status.Scanning", "Сканирую документы Foundry..."), async (options, signal) => {
      const manifest = await scanFoundry(options, {
        onProgress: ({ phase, current, total, label }) => {
          const status = phase === "pack-document"
            ? tr("FWM.Status.ScanningPackDocument", `Compendium ${label}: документ ${current}/${total}`, { label, current, total })
            : phase === "pack"
              ? tr("FWM.Status.ScanningPack", `Читаю compendium ${current}/${total}: ${label}`, { current, total, label })
              : tr("FWM.Status.ScanningDocument", `Сканирую ${current}/${total}: ${label}`, { current, total, label });
          this._setStatus(status);
        },
        signal
      });
      this._viewState.manifest = manifest;
      this._viewState.conversionReport = null;
      this._viewState.consistencyReport = null;
      this._viewState.migrationReport = null;
      this._viewState.rollbackSummary = null;
      this._setStatus(
        tr("FWM.Status.ScanDone", `Готово: ${manifest.summary.uniquePngPaths} PNG-путей, ${manifest.summary.uniqueWebpPaths} WEBP-путей, ${manifest.summary.documentReferences} PNG-ссылок, ${manifest.summary.webpDocumentReferences} WEBP-ссылок, ${manifest.summary.scannedDocumentsIncludingEmbedded} документов.`, {
          paths: manifest.summary.uniquePngPaths,
          webpPaths: manifest.summary.uniqueWebpPaths,
          refs: manifest.summary.documentReferences,
          webpRefs: manifest.summary.webpDocumentReferences,
          documents: manifest.summary.scannedDocumentsIncludingEmbedded
        }),
        { force: true }
      );
    });
  }

  static _onExportManifestAction(event) {
    event.preventDefault();
    if (this._viewState.busy) return;
    const manifest = this._viewState.manifest;
    if (!manifest) return ui.notifications.warn(tr("FWM.Errors.ScanFirst", "Сначала выполни сканирование."));
    const filename = `${safeFilenamePart(game.world?.id, "world")}-webp-manifest.json`;
    saveJsonFile(manifest, filename);
    this._setStatus(tr("FWM.Status.ManifestExported", `Manifest сохранен как ${filename}.`, { filename }), { force: true });
  }

  static _onAssumeConvertedAction(event) {
    event.preventDefault();
    return this._runAction(tr("FWM.Status.PreparingAssumed", "Готовлю предположительный отчет..."), async () => {
      const manifest = this._viewState.manifest;
      if (!manifest) throw new Error(tr("FWM.Errors.ScanFirst", "Сначала выполни сканирование."));
      const confirmed = await confirmAction({
        title: tr("FWM.Confirm.AssumeTitle", "WEBP уже готовы?"),
        content: `<p>${tr("FWM.Confirm.AssumeBody", "Foundry не может проверить файлы на диске. Этот режим разрешает заменить ссылки, но не дает файлам права на cleanup. Используй его только после ручной проверки WEBP.")}</p>`,
        yes: tr("FWM.Actions.UseAssumption", "Использовать предположение")
      });
      if (!confirmed) {
        this._setStatus(tr("FWM.Status.Cancelled", "Действие отменено."), { force: true });
        return;
      }
      this._viewState.conversionReport = createAssumedConversionReport(manifest);
      this._viewState.migrationReport = null;
      this._setStatus(tr("FWM.Status.AssumedReady", "Предположительный отчет готов. Cleanup для таких файлов запрещен."), { force: true });
    });
  }

  static _onApplyConsistencyAction(event) {
    event.preventDefault();
    return this._runAction(tr("FWM.Status.ApplyingConsistency", "Исправляю рассинхронизированные пути..."), async (options, signal) => {
      const { manifest, consistencyReport } = this._viewState;
      if (!manifest || !consistencyReport) throw new Error(tr("FWM.Errors.ManifestAndConsistencyRequired", "Нужны manifest и consistency report."));
      const confirmed = await confirmAction({
        title: tr("FWM.Confirm.ConsistencyTitle", "Исправить рассинхронизацию"),
        content: `<p>${tr("FWM.Confirm.ConsistencyBody", "Будут изменены только безопасно подтвержденные случаи: PNG-путь при существующем корректном WEBP и WEBP-путь при отсутствующем или поврежденном WEBP, если корректный PNG сохранился. Неоднозначные случаи останутся без изменений.")}</p>`,
        yes: tr("FWM.Actions.ApplyConsistency", "Исправить безопасные случаи")
      });
      if (!confirmed) {
        this._setStatus(tr("FWM.Status.Cancelled", "Действие отменено."), { force: true });
        return;
      }
      if (options.allowPackageCompendiumWrites) {
        const packageConfirmed = await confirmAction({
          title: tr("FWM.Confirm.PackageTitle", "Запись в system/module compendiums"),
          content: `<p><strong>${tr("FWM.Confirm.PackageBody", "Будут изменены только уже разблокированные package packs. Обновление соответствующего модуля или системы может затереть изменения.")}</strong></p>`,
          yes: tr("FWM.Actions.AcceptRisk", "Принять риск")
        });
        if (!packageConfirmed) {
          this._setStatus(tr("FWM.Status.Cancelled", "Действие отменено."), { force: true });
          return;
        }
      }
      const current = await applyConsistencyRepairs(manifest, consistencyReport, options, {
        onProgress: ({ current: index, total, label }) => {
          this._setStatus(tr("FWM.Status.ApplyingDocument", `Обновляю ${index}/${total}: ${label}`, { current: index, total, label }));
        },
        signal
      });
      const merged = mergeMigrationReports(this._viewState.rollbackReport, current);
      this._viewState.migrationReport = merged;
      this._viewState.rollbackReport = merged;
      this._viewState.rollbackSummary = null;
      this._setStatus(tr(
        "FWM.Status.ConsistencyApplied",
        `Исправлено ссылок: ${current.summary.changedReferences}. На WEBP: ${current.summary.consistencyForwardPaths}. На PNG: ${current.summary.consistencyReversePaths}.`,
        {
          changed: current.summary.changedReferences,
          forward: current.summary.consistencyForwardPaths,
          reverse: current.summary.consistencyReversePaths
        }
      ), { force: true });
    });
  }

  static _onApplyMissingPlaceholderAction(event) {
    event.preventDefault();
    return this._runAction(tr("FWM.Status.ApplyingMissingPlaceholder", "Заменяю ссылки на давно удаленные файлы..."), async (options, signal) => {
      const { manifest, consistencyReport } = this._viewState;
      if (!manifest || !consistencyReport) throw new Error(tr("FWM.Errors.ManifestAndConsistencyRequired", "Нужны manifest и consistency report."));
      const confirmed = await confirmAction({
        title: tr("FWM.Confirm.MissingPlaceholderTitle", "Заменить отсутствующие файлы"),
        content: `<p>${tr("FWM.Confirm.MissingPlaceholderBody", "Для путей, где отсутствуют и PNG, и WEBP, обычные ссылки Foundry будут заменены на icons/svg/mystery-man.svg. Поле Image Hover → Specific image on hover вместо этого будет сброшено к его нейтральному значению path/image.png, чтобы не перекрывать арт Actor/Token. Wildcard-пути и неоднозначные случаи не изменяются. Операция записывается в migration report и поддерживает откат.")}</p>`,
        yes: tr("FWM.Actions.ApplyMissingPlaceholder", "Заменить на заглушку")
      });
      if (!confirmed) {
        this._setStatus(tr("FWM.Status.Cancelled", "Действие отменено."), { force: true });
        return;
      }
      if (options.allowPackageCompendiumWrites) {
        const packageConfirmed = await confirmAction({
          title: tr("FWM.Confirm.PackageTitle", "Запись в system/module compendiums"),
          content: `<p><strong>${tr("FWM.Confirm.PackageBody", "Будут изменены только уже разблокированные package packs. Обновление соответствующего модуля или системы может затереть изменения.")}</strong></p>`,
          yes: tr("FWM.Actions.AcceptRisk", "Принять риск")
        });
        if (!packageConfirmed) {
          this._setStatus(tr("FWM.Status.Cancelled", "Действие отменено."), { force: true });
          return;
        }
      }
      const current = await applyMissingPlaceholderRepairs(manifest, consistencyReport, options, {
        onProgress: ({ current: index, total, label }) => {
          this._setStatus(tr("FWM.Status.ApplyingDocument", `Обновляю ${index}/${total}: ${label}`, { current: index, total, label }));
        },
        signal
      });
      const merged = mergeMigrationReports(this._viewState.rollbackReport, current);
      this._viewState.migrationReport = merged;
      this._viewState.rollbackReport = merged;
      this._viewState.rollbackSummary = null;
      this._setStatus(tr(
        "FWM.Status.MissingPlaceholderApplied",
        `На заглушку заменено ссылок: ${current.summary.changedReferences}; путей: ${current.summary.consistencyPlaceholderPaths ?? 0}.`,
        { changed: current.summary.changedReferences, paths: current.summary.consistencyPlaceholderPaths ?? 0 }
      ), { force: true });
    });
  }

  static _onRepairImageHoverAction(event) {
    event.preventDefault();
    return this._runAction(tr("FWM.Status.RepairingImageHover", "Исправляю ошибочные overrides Image Hover..."), async (options, signal) => {
      const confirmed = await confirmAction({
        title: tr("FWM.Confirm.ImageHoverTitle", "Исправить Image Hover overrides"),
        content: `<p>${tr("FWM.Confirm.ImageHoverBody", "Версии 0.4.2/0.4.3 могли записать icons/svg/mystery-man.svg в Image Hover → Specific image on hover. Восстановление теперь независимо от обычных галочек сканирования: оно проверит все world Actors, все токены и вложенные ActorDelta во всех world Scenes, а также world Actor/Scene compendiums. Будут сброшены только поля specificArt, которые сейчас ТОЧНО равны этой заглушке. Они вернутся к path/image.png. Если вы намеренно выбирали mystery-man.svg именно как Specific image on hover, такие поля тоже будут сброшены.")}</p>`,
        yes: tr("FWM.Actions.RepairImageHover", "Исправить Image Hover")
      });
      if (!confirmed) {
        this._setStatus(tr("FWM.Status.Cancelled", "Действие отменено."), { force: true });
        return;
      }
      if (options.allowPackageCompendiumWrites) {
        const packageConfirmed = await confirmAction({
          title: tr("FWM.Confirm.PackageTitle", "Запись в system/module compendiums"),
          content: `<p><strong>${tr("FWM.Confirm.PackageBody", "Будут изменены только уже разблокированные package packs. Обновление соответствующего модуля или системы может затереть изменения.")}</strong></p>`,
          yes: tr("FWM.Actions.AcceptRisk", "Принять риск")
        });
        if (!packageConfirmed) {
          this._setStatus(tr("FWM.Status.Cancelled", "Действие отменено."), { force: true });
          return;
        }
      }
      const result = await repairImageHoverSpecificArtOverrides(options, {
        onProgress: ({ current, total, label }) => {
          if (current && total) this._setStatus(tr("FWM.Status.ApplyingDocument", `Обновляю ${current}/${total}: ${label}`, { current, total, label }));
        },
        signal
      });
      this._setStatus(tr(
        "FWM.Status.ImageHoverRepaired",
        `Image Hover: найдено ${result.scannedReferences}, исправлено ${result.changed}, stale ${result.stale}, ошибок ${result.errors}.`,
        { found: result.scannedReferences, changed: result.changed, stale: result.stale, errors: result.errors }
      ), { force: true });
      if (result.errors || result.lockRestoreErrors) {
        console.warn(`${MODULE_TITLE} | Image Hover compatibility repair issues`, result.issues);
      }
    });
  }

  static _onApplyReportAction(event) {
    event.preventDefault();
    return this._runAction(tr("FWM.Status.Applying", "Применяю WEBP-пути..."), async (options, signal) => {
      const { manifest, conversionReport } = this._viewState;
      if (!manifest || !conversionReport) throw new Error(tr("FWM.Errors.ManifestAndReportRequired", "Нужны manifest и conversion report."));
      const confirmed = await confirmAction({
        title: tr("FWM.Confirm.ApplyTitle", "Применить WEBP-пути"),
        content: `<p>${tr("FWM.Confirm.ApplyBody", "Перед записью каждое поле будет повторно проверено. Stale-ссылки и неподтвержденные файлы не изменяются.")}</p>`,
        yes: tr("FWM.Actions.Apply", "Применить")
      });
      if (!confirmed) {
        this._setStatus(tr("FWM.Status.Cancelled", "Действие отменено."), { force: true });
        return;
      }
      if (options.allowPackageCompendiumWrites) {
        const packageConfirmed = await confirmAction({
          title: tr("FWM.Confirm.PackageTitle", "Запись в system/module compendiums"),
          content: `<p><strong>${tr("FWM.Confirm.PackageBody", "Будут изменены только уже разблокированные package packs. Обновление соответствующего модуля или системы может затереть изменения.")}</strong></p>`,
          yes: tr("FWM.Actions.AcceptRisk", "Принять риск")
        });
        if (!packageConfirmed) {
          this._setStatus(tr("FWM.Status.Cancelled", "Действие отменено."), { force: true });
          return;
        }
      }
      const current = await applyMigration(manifest, conversionReport, options, {
        onProgress: ({ current: index, total, label }) => {
          this._setStatus(tr("FWM.Status.ApplyingDocument", `Обновляю ${index}/${total}: ${label}`, { current: index, total, label }));
        },
        signal
      });
      const merged = mergeMigrationReports(this._viewState.rollbackReport, current);
      this._viewState.migrationReport = merged;
      this._viewState.rollbackReport = merged;
      this._viewState.rollbackSummary = null;
      this._setStatus(
        tr("FWM.Status.ApplyDone", `Изменено ссылок: ${current.summary.changedReferences}. Файлов готовы к карантину: ${current.summary.cleanupEligibleFiles}.`, {
          changed: current.summary.changedReferences,
          files: current.summary.cleanupEligibleFiles
        }),
        { force: true }
      );
    });
  }

  static _onExportMigrationReportAction(event) {
    event.preventDefault();
    if (this._viewState.busy) return;
    const report = this._viewState.migrationReport;
    if (!report) return ui.notifications.warn(tr("FWM.Errors.ApplyFirst", "Сначала примени conversion report."));
    const filename = `${safeFilenamePart(game.world?.id, "world")}-webp-migration-report.json`;
    saveJsonFile(report, filename);
    this._setStatus(tr("FWM.Status.MigrationExported", `Migration report сохранен как ${filename}.`, { filename }), { force: true });
  }

  static _onRollbackCorePublicAction(event) {
    event.preventDefault();
    return this._runAction(tr("FWM.Status.RestoringCoreData", "Восстанавливаю ссылки Foundry Core Data..."), async (options, signal) => {
      const report = this._viewState.rollbackReport;
      const count = countCorePublicPlaceholderReferences(report);
      if (!count) throw new Error(tr("FWM.Errors.NoCoreDataRollback", "В импортированном migration report нет замененных ссылок Foundry Core Data."));
      const confirmed = await confirmAction({
        title: tr("FWM.Confirm.CoreDataRollbackTitle", "Восстановить Core Data ссылки"),
        content: `<p>${tr("FWM.Confirm.CoreDataRollbackBody", `Будут восстановлены только ${count} ссылок, где placeholder-repair заменил исходный путь Foundry Core Data. Остальные изменения migration report не затрагиваются.`, { count })}</p>`,
        yes: tr("FWM.Actions.RestoreCoreData", "Восстановить Core Data")
      });
      if (!confirmed) {
        this._setStatus(tr("FWM.Status.Cancelled", "Действие отменено."), { force: true });
        return;
      }
      const summary = await rollbackCorePublicPlaceholders(report, options, {
        onProgress: ({ current, total, label }) => {
          this._setStatus(tr("FWM.Status.RestoringCoreDataDocument", `Восстанавливаю ${current}/${total}: ${label}`, { current, total, label }));
        },
        signal
      });
      this._viewState.rollbackSummary = summary;
      const complete = summary.stale === 0 && summary.errors === 0 && summary.lockRestoreErrors === 0;
      if (complete) {
        const remaining = withoutCorePublicPlaceholderReferences(report);
        this._viewState.rollbackReport = remaining.changedRefs.length ? remaining : null;
      }
      this._setStatus(tr("FWM.Status.CoreDataRestored", `Core Data: восстановлено ${summary.changed}, уже было исправлено ${summary.already}, stale ${summary.stale}, ошибок ${summary.errors}.`, {
        changed: summary.changed, already: summary.already, stale: summary.stale, errors: summary.errors
      }), { force: true });
    });
  }

  static _onRollbackAction(event) {
    event.preventDefault();
    return this._runAction(tr("FWM.Status.RollingBack", "Откатываю WEBP-пути..."), async (options, signal) => {
      const report = this._viewState.rollbackReport;
      if (!report?.changedRefs?.length) throw new Error(tr("FWM.Errors.NoRollback", "Нет сохраненных ссылок для отката."));
      const confirmed = await confirmAction({
        title: tr("FWM.Confirm.RollbackTitle", "Откатить пути"),
        content: `<p>${tr("FWM.Confirm.RollbackBody", "Модуль вернет только ссылки, измененные сохраненными migration reports. Файлы на диске не меняются.")}</p>`,
        yes: tr("FWM.Actions.Rollback", "Откатить")
      });
      if (!confirmed) {
        this._setStatus(tr("FWM.Status.Cancelled", "Действие отменено."), { force: true });
        return;
      }
      const summary = await rollbackMigration(report, options, {
        onProgress: ({ current, total, label }) => {
          this._setStatus(tr("FWM.Status.RollingBackDocument", `Откатываю ${current}/${total}: ${label}`, { current, total, label }));
        },
        signal
      });
      this._viewState.rollbackSummary = summary;
      const rollbackComplete = summary.stale === 0 && summary.errors === 0 && summary.lockRestoreErrors === 0;
      if (rollbackComplete) {
        this._viewState.rollbackReport = null;
        this._viewState.migrationReport = null;
      }
      this._setStatus(tr("FWM.Status.RollbackDone", `Возвращено ссылок: ${summary.changed}. Stale: ${summary.stale}. Ошибок: ${summary.errors}.`, {
        changed: summary.changed,
        stale: summary.stale,
        errors: summary.errors
      }), { force: true });
    });
  }

  static _onResetAction(event) {
    event.preventDefault();
    return this._runAction(tr("FWM.Status.Resetting", "Сбрасываю состояние..."), async () => {
      const state = this._viewState;
      const hasData = !!(state.manifest || state.conversionReport || state.migrationReport || state.rollbackReport);
      if (hasData) {
        const confirmed = await confirmAction({
          title: tr("FWM.Confirm.ResetTitle", "Сбросить состояние"),
          content: `<p>${tr("FWM.Confirm.ResetBody", "Manifest, отчеты и история отката будут удалены из памяти приложения. Файлы и документы Foundry не изменятся.")}</p>`,
          yes: tr("FWM.Actions.Reset", "Сбросить")
        });
        if (!confirmed) {
          this._setStatus(tr("FWM.Status.Cancelled", "Действие отменено."), { force: true });
          return;
        }
      }
      const options = deepClone(state.options);
      Object.assign(state, createInitialState(), { options });
      this._setStatus(tr("FWM.Status.ResetDone", "Состояние сброшено."), { force: true });
    });
  }
}
