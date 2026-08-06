import {
  PENDING_RELOCKS_SETTING,
  REPORT_SCHEMA_VERSION,
  SUCCESS_STATUSES,
  VERIFIED_CONVERSION_STATUSES
} from "./constants.mjs";
import {
  deepClone,
  getAtPath,
  globToRegExp,
  isSafePathSegments,
  findRichPngReferences,
  findRichWebpReferences,
  normalizePhysicalPath,
  normalizeWebpPhysicalPath,
  replaceTextReference,
  sanitizeJsonValue,
  setAtPath,
  toWebpReference,
  toWebpPhysicalPath
} from "./path-utils.mjs";
import { getPackPackageType } from "./scanner.mjs";

const SHA256_RE = /^[a-f0-9]{64}$/i;
const DATA_ROOT_ID_RE = /^sha256:[a-f0-9]{64}$/i;
const CONCRETE_SUCCESS_STATUSES = new Set(["converted", "exists", "exists-missing-old"]);
const INTERNAL_ASSUMPTION = Symbol("fbl-webp-migrator-internal-assumption");

function normalizeStatus(status) {
  return String(status ?? "").trim().toLowerCase();
}

function successfulStatus(status) {
  return SUCCESS_STATUSES.has(normalizeStatus(status));
}

function successfulEntry(entry, report) {
  const status = normalizeStatus(entry?.status);
  if (status === "assume-existing") return report?.[INTERNAL_ASSUMPTION] === true;
  return successfulStatus(status);
}

function getPack(document) {
  return document?.compendium ?? (document?.pack ? game.packs?.get(document.pack) : null);
}

function isWorldPack(pack) {
  return getPackPackageType(pack) === "world";
}

async function resolveDocument(uuid) {
  if (!uuid || typeof uuid !== "string") return null;
  return globalThis.fromUuid?.(uuid) ?? null;
}

export function referenceKey(ref) {
  return `${ref.uuid}|${JSON.stringify(ref.fieldPath)}|${ref.mode}|${ref.oldValue}|${ref.newValue}`;
}

export function validateReference(ref) {
  return !!ref
    && typeof ref.uuid === "string"
    && isSafePathSegments(ref.fieldPath)
    && typeof ref.rootField === "string"
    && ref.fieldPath[0] === ref.rootField
    && (ref.mode === "exact" || ref.mode === "text")
    && typeof ref.oldValue === "string"
    && typeof ref.newValue === "string"
    && ref.oldValue !== ref.newValue
    && normalizePhysicalPath(ref.oldValue) === ref.oldPath
    && normalizeWebpPhysicalPath(ref.newValue) === ref.newPath
    && toWebpReference(ref.oldValue) === ref.newValue
    && normalizePhysicalPath(ref.oldPath) === ref.oldPath
    && normalizeWebpPhysicalPath(ref.newPath) === ref.newPath
    && toWebpPhysicalPath(ref.oldPath) === ref.newPath;
}

function validNumber(value, { minimum = 0 } = {}) {
  return Number.isFinite(value) && value >= minimum ? value : null;
}

function validDimension(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function patternMatches(pattern, value) {
  try {
    return globToRegExp(pattern).test(value);
  } catch {
    return false;
  }
}

function sanitizeConcreteFile(input, sourceEntry) {
  if (!input || typeof input !== "object") return null;
  const oldPath = normalizePhysicalPath(input.oldPath);
  const newPath = normalizeWebpPhysicalPath(input.newPath);
  if (!oldPath || !newPath || /[*?]/.test(oldPath) || /[*?]/.test(newPath)) return null;
  if (toWebpPhysicalPath(oldPath) !== newPath) return null;
  if (sourceEntry.wildcard) {
    if (!patternMatches(sourceEntry.oldPath, oldPath) || !patternMatches(sourceEntry.newPath, newPath)) return null;
  } else if (oldPath !== sourceEntry.oldPath || newPath !== sourceEntry.newPath) return null;

  const status = normalizeStatus(input.status);
  if (!CONCRETE_SUCCESS_STATUSES.has(status) && status !== "skipped" && status !== "failed" && status !== "larger") return null;

  const oldSize = validNumber(input.oldSize);
  const newSize = validNumber(input.newSize);
  const oldSha256 = SHA256_RE.test(String(input.oldSha256 ?? "")) ? String(input.oldSha256).toLowerCase() : null;
  const newSha256 = SHA256_RE.test(String(input.newSha256 ?? "")) ? String(input.newSha256).toLowerCase() : null;
  const oldWidth = validDimension(input.oldWidth);
  const oldHeight = validDimension(input.oldHeight);
  const newWidth = validDimension(input.newWidth);
  const newHeight = validDimension(input.newHeight);
  const sourceAnimated = input.sourceAnimated === true;
  const fingerprintsComplete = status === "exists-missing-old"
    ? !!(newSha256 && newSize != null && newWidth && newHeight)
    : !!(oldSha256 && newSha256 && oldSize != null && newSize != null && oldWidth && oldHeight && newWidth && newHeight);
  const dimensionsMatch = status === "exists-missing-old" || (oldWidth === newWidth && oldHeight === newHeight);
  const cleanupEligible = (status === "converted" || status === "exists")
    && fingerprintsComplete
    && dimensionsMatch
    && !sourceAnimated;

  return {
    oldPath,
    newPath,
    status,
    oldSize,
    newSize,
    savedPercent: Number.isFinite(input.savedPercent) ? input.savedPercent : null,
    oldSha256,
    newSha256,
    oldMtimeMs: validNumber(input.oldMtimeMs),
    newMtimeMs: validNumber(input.newMtimeMs),
    oldWidth,
    oldHeight,
    newWidth,
    newHeight,
    sourceAnimated,
    provenance: input.provenance === "existing" ? "existing" : input.provenance === "converted" ? "converted" : null,
    cleanupEligible,
    error: typeof input.error === "string" ? input.error : undefined
  };
}

function aggregateSanitizedStatus(files) {
  if (!files.length) return "failed";
  if (files.every((file) => file.status === "exists-missing-old")) return "exists-missing-old";
  if (files.some((file) => file.status === "failed" || file.status === "skipped")) return "failed";
  if (files.some((file) => file.status === "larger")) return "larger";
  if (files.some((file) => file.status === "converted")) return "converted";
  return "exists";
}

function summarizeConversion(entries, ignoredCount = 0) {
  const summary = {
    input: entries.length,
    converted: entries.filter((entry) => entry.status === "converted").length,
    exists: entries.filter((entry) => entry.status === "exists").length,
    existsMissingOld: entries.filter((entry) => entry.status === "exists-missing-old").length,
    assumed: entries.filter((entry) => entry.status === "assume-existing").length,
    failed: entries.filter((entry) => entry.status === "failed").length,
    skipped: entries.filter((entry) => entry.status === "skipped").length,
    larger: entries.filter((entry) => entry.status === "larger").length,
    ignored: ignoredCount,
    cleanupEligibleFiles: entries.flatMap((entry) => entry.files ?? []).filter((file) => file.cleanupEligible).length,
    verifiedEntries: entries.filter((entry) => entry.verified === true).length,
    totalOldSize: 0,
    totalNewSize: 0,
    totalSavedBytes: 0,
    totalSavedPercent: 0
  };
  for (const entry of entries) {
    if (!Number.isFinite(entry.oldSize) || !Number.isFinite(entry.newSize)) continue;
    summary.totalOldSize += entry.oldSize;
    summary.totalNewSize += entry.newSize;
  }
  summary.totalSavedBytes = summary.totalOldSize - summary.totalNewSize;
  summary.totalSavedPercent = summary.totalOldSize > 0
    ? Number(((summary.totalSavedBytes / summary.totalOldSize) * 100).toFixed(2))
    : 0;
  return summary;
}

export function sanitizeConversionReport(report, manifest, currentWorldId = game.world?.id ?? null) {
  if (!manifest || manifest.type !== "fbl-webp-migrator-manifest") throw new Error("Сначала создай или импортируй текущий manifest.");
  if (!report || report.type !== "fbl-webp-migrator-conversion-report") throw new Error("Это не conversion report FBL WebP Migrator.");
  if (!manifest.manifestId) throw new Error("Manifest устарел и не содержит manifestId. Выполни новое сканирование.");
  if (report.sourceManifestId !== manifest.manifestId) throw new Error("Conversion report создан для другого manifest. Импорт отклонён.");
  if (manifest.worldId !== currentWorldId || report.sourceWorldId !== currentWorldId) throw new Error("Manifest или conversion report относятся к другому миру.");

  const manifestEntries = new Map((manifest.entries ?? []).map((entry) => [entry.oldPath, entry]));
  const entries = [];
  const ignored = [];
  const seen = new Set();

  for (const input of report.entries ?? []) {
    const source = manifestEntries.get(input?.oldPath);
    if (!source || source.newPath !== input?.newPath) {
      ignored.push({ oldPath: input?.oldPath ?? null, reason: "Путь отсутствует в текущем manifest или newPath не совпадает." });
      continue;
    }
    if (seen.has(source.oldPath)) {
      ignored.push({ oldPath: source.oldPath, reason: "Дублирующая запись conversion report." });
      continue;
    }
    seen.add(source.oldPath);

    const inputStatus = normalizeStatus(input.status);
    if (inputStatus === "assume-existing") {
      ignored.push({ oldPath: source.oldPath, reason: "Unverified assume-existing entries are accepted only when created inside the Foundry application." });
      continue;
    }

    const files = Array.isArray(input.files)
      ? input.files.map((file) => sanitizeConcreteFile(file, source)).filter(Boolean)
      : [];
    const status = aggregateSanitizedStatus(files);
    const oldPairs = files.filter((file) => Number.isFinite(file.oldSize));
    const newPairs = files.filter((file) => Number.isFinite(file.newSize));
    const oldSize = oldPairs.length ? oldPairs.reduce((sum, file) => sum + file.oldSize, 0) : null;
    const newSize = newPairs.length ? newPairs.reduce((sum, file) => sum + file.newSize, 0) : null;
    const savedPercent = Number.isFinite(oldSize) && Number.isFinite(newSize) && oldSize > 0
      ? Number((((oldSize - newSize) / oldSize) * 100).toFixed(2))
      : null;
    entries.push({
      oldPath: source.oldPath,
      newPath: source.newPath,
      wildcard: !!source.wildcard,
      status,
      verified: VERIFIED_CONVERSION_STATUSES.has(status),
      oldSize,
      newSize,
      savedPercent,
      files
    });
    if (status === "failed") ignored.push({ oldPath: source.oldPath, reason: "Concrete file metadata is incomplete, unsafe, or reports a failed conversion." });
  }

  return {
    type: report.type,
    schemaVersion: REPORT_SCHEMA_VERSION,
    version: typeof report.version === "string" ? report.version : null,
    producer: typeof report.producer === "string" ? report.producer : null,
    createdAt: typeof report.createdAt === "string" ? report.createdAt : null,
    sourceManifestId: report.sourceManifestId,
    sourceWorldId: report.sourceWorldId,
    dataRootId: DATA_ROOT_ID_RE.test(String(report.dataRootId ?? "")) ? String(report.dataRootId).toLowerCase() : null,
    options: sanitizeJsonValue(report.options ?? {}),
    ignored,
    entries,
    summary: summarizeConversion(entries, ignored.length)
  };
}

export function createAssumedConversionReport(manifest) {
  if (!manifest?.manifestId) throw new Error("Сначала выполни новое сканирование или импортируй manifest.");
  const entries = (manifest.entries ?? []).map((entry) => ({
    oldPath: entry.oldPath,
    newPath: entry.newPath,
    wildcard: !!entry.wildcard,
    status: "assume-existing",
    verified: false,
    files: []
  }));
  const report = {
    type: "fbl-webp-migrator-conversion-report",
    schemaVersion: REPORT_SCHEMA_VERSION,
    version: manifest.version,
    producer: "manual-unverified",
    createdAt: new Date().toISOString(),
    sourceManifestId: manifest.manifestId,
    sourceWorldId: manifest.worldId,
    dataRootId: null,
    options: { assumeExistingWebp: true },
    ignored: [],
    summary: summarizeConversion(entries, 0),
    entries
  };
  Object.defineProperty(report, INTERNAL_ASSUMPTION, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true
  });
  return report;
}

function replaceReference(current, ref, reverse = false) {
  const oldValue = reverse ? ref.newValue : ref.oldValue;
  const newValue = reverse ? ref.oldValue : ref.newValue;
  if (oldValue === newValue) return { status: "stale", value: current };
  if (ref.mode === "exact") {
    if (current === oldValue) return { status: "changed", value: newValue };
    if (current === newValue) return { status: "already", value: current };
    return { status: "stale", value: current };
  }
  return replaceTextReference(current, oldValue, newValue);
}

function verifyReference(source, ref, reverse = false) {
  const expected = reverse ? ref.oldValue : ref.newValue;
  const opposite = reverse ? ref.newValue : ref.oldValue;
  const expectedPath = reverse ? ref.oldPath : ref.newPath;
  const oppositePath = reverse ? ref.newPath : ref.oldPath;
  const current = getAtPath(source, ref.fieldPath);
  if (ref.mode === "exact") {
    if (current === expected) return true;
    const normalized = reverse ? normalizePhysicalPath(current) : normalizeWebpPhysicalPath(current);
    return normalized === expectedPath;
  }
  if (replaceTextReference(current, expected, opposite).status === "changed") return true;
  if (typeof current !== "string") return false;
  const expectedCandidates = reverse ? findRichPngReferences(current) : findRichWebpReferences(current);
  const oppositeCandidates = reverse ? findRichWebpReferences(current) : findRichPngReferences(current);
  const paths = expectedCandidates.map((value) => reverse ? normalizePhysicalPath(value) : normalizeWebpPhysicalPath(value)).filter(Boolean);
  const oppositePaths = oppositeCandidates.map((value) => reverse ? normalizeWebpPhysicalPath(value) : normalizePhysicalPath(value)).filter(Boolean);
  return paths.includes(expectedPath) && !oppositePaths.includes(oppositePath);
}

async function readPendingRelocks() {
  try {
    const value = game.settings?.get?.("fbl-webp-migrator", PENDING_RELOCKS_SETTING);
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function writePendingRelocks(values) {
  try {
    if (typeof game.settings?.set !== "function") return false;
    await game.settings.set("fbl-webp-migrator", PENDING_RELOCKS_SETTING, [...new Set(values)]);
    return true;
  } catch (error) {
    console.warn("FBL WebP Migrator | Could not persist pending compendium relocks", error);
    return false;
  }
}

async function markPendingRelock(collection, pending) {
  if (!collection) return false;
  const values = new Set(await readPendingRelocks());
  if (pending) values.add(collection);
  else values.delete(collection);
  return writePendingRelocks([...values]);
}

export async function recoverPendingPackLocks() {
  if (!game.user?.isGM) return { restored: 0, issues: [] };
  const pending = await readPendingRelocks();
  const remaining = [];
  const issues = [];
  let restored = 0;
  for (const collection of pending) {
    const pack = game.packs?.get?.(collection);
    if (!pack || !isWorldPack(pack)) continue;
    try {
      if (!pack.locked) await pack.configure({ locked: true });
      if (!pack.locked) throw new Error("Compendium remained unlocked after recovery.");
      restored += 1;
    } catch (error) {
      remaining.push(collection);
      issues.push({ pack: collection, status: "lock-recovery-error", error: error?.message ?? String(error) });
    }
  }
  await writePendingRelocks(remaining);
  return { restored, issues };
}

async function unlockPackIfNeeded(pack, options, unlockedPacks) {
  if (!pack?.locked) return true;
  if (!isWorldPack(pack)) return false;
  if (!options.autoUnlockWorldPacks) return false;
  if (!await markPendingRelock(pack.collection, true)) {
    throw new Error(`Cannot safely unlock ${pack.collection}: pending relock state could not be persisted.`);
  }
  try {
    await pack.configure({ locked: false });
  } catch (error) {
    await markPendingRelock(pack.collection, false);
    throw error;
  }
  if (pack.locked) {
    await markPendingRelock(pack.collection, false);
    return false;
  }
  unlockedPacks.set(pack.collection, pack);
  return true;
}

async function restorePackLocks(unlockedPacks) {
  const issues = [];
  for (const pack of unlockedPacks.values()) {
    try {
      await pack.configure({ locked: true });
      if (!pack.locked) throw new Error("Compendium remained unlocked after configure().");
      if (!await markPendingRelock(pack.collection, false)) {
        throw new Error("Compendium was locked, but the pending relock marker could not be cleared.");
      }
    } catch (error) {
      const issue = {
        pack: pack.collection,
        status: "lock-restore-error",
        error: error?.message ?? String(error)
      };
      issues.push(issue);
      console.error("FBL WebP Migrator | Failed to restore compendium lock", pack.collection, error);
    }
  }
  return issues;
}

function collectTasks(entries) {
  const byUuid = new Map();
  const results = [];
  const dedupe = new Set();
  const expectedByEntry = new Map();

  for (const entry of entries) {
    const entryExpected = new Set();
    expectedByEntry.set(entry.oldPath, entryExpected);
    for (const ref of entry.refs ?? []) {
      const resultBase = {
        entryOldPath: entry.oldPath,
        entryNewPath: entry.newPath,
        ref: deepClone(ref)
      };
      if (!validateReference(ref)) {
        results.push({ ...resultBase, status: "error", error: "Некорректная ссылка в manifest." });
        continue;
      }
      const key = referenceKey(ref);
      entryExpected.add(key);
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      if (!byUuid.has(ref.uuid)) byUuid.set(ref.uuid, []);
      byUuid.get(ref.uuid).push({ entry, ref, resultBase });
    }
  }
  return { byUuid, results, expectedByEntry };
}

function fieldPathToUpdateKey(segments) {
  if (!isSafePathSegments(segments)) return null;
  if (segments.some((segment) => typeof segment === "string" && segment.includes("."))) return null;
  return segments.map(String).join(".");
}

async function yieldToBrowser() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function processDocumentTasks(entries, options, reverse, { onProgress, signal } = {}) {
  const { byUuid, results, expectedByEntry } = collectTasks(entries);
  const unlockedPacks = new Map();
  const groups = [...byUuid.entries()];

  try {
    for (let index = 0; index < groups.length; index += 1) {
      if (signal?.aborted) throw new DOMException("Операция отменена.", "AbortError");
      const [uuid, tasks] = groups[index];
      let document;
      try {
        document = await resolveDocument(uuid);
      } catch (error) {
        for (const task of tasks) results.push({ ...task.resultBase, status: "error", error: error?.message ?? String(error) });
        continue;
      }
      if (!document) {
        for (const task of tasks) results.push({ ...task.resultBase, status: "error", error: `Документ не найден: ${uuid}` });
        continue;
      }

      onProgress?.({ current: index + 1, total: groups.length, label: document.name ?? document.id });
      const pack = getPack(document);
      if (pack && !isWorldPack(pack) && !options.allowPackageCompendiumWrites) {
        for (const task of tasks) results.push({
          ...task.resultBase,
          status: "skipped",
          error: `Package compendium ${pack.collection} доступен только для чтения по текущим настройкам.`
        });
        continue;
      }
      if (pack && !await unlockPackIfNeeded(pack, options, unlockedPacks)) {
        for (const task of tasks) results.push({
          ...task.resultBase,
          status: "skipped",
          error: `Compendium ${pack.collection} заблокирован. Module/system packs автоматически не разблокируются.`
        });
        continue;
      }

      const source = document.toObject(true);
      const working = deepClone(source);
      const updateData = {};
      const pending = [];

      for (const task of tasks) {
        const current = getAtPath(working, task.ref.fieldPath);
        const replacement = replaceReference(current, task.ref, reverse);
        if (replacement.status === "already") {
          results.push({ ...task.resultBase, status: "already" });
          continue;
        }
        if (replacement.status !== "changed") {
          results.push({
            ...task.resultBase,
            status: "stale",
            error: "Поле изменилось после сканирования или больше не содержит ожидаемый путь."
          });
          continue;
        }
        try {
          const updateKey = fieldPathToUpdateKey(task.ref.fieldPath);
          if (!updateKey) {
            results.push({
              ...task.resultBase,
              status: "skipped",
              error: "Поле содержит точку в имени сегмента и не может быть безопасно обновлено leaf-path операцией."
            });
            continue;
          }
          setAtPath(working, task.ref.fieldPath, replacement.value);
          updateData[updateKey] = replacement.value;
          const result = { ...task.resultBase, status: "pending" };
          pending.push(result);
          results.push(result);
        } catch (error) {
          results.push({ ...task.resultBase, status: "error", error: error?.message ?? String(error) });
        }
      }

      if (!pending.length) continue;

      try {
        await document.update(updateData, { diff: true, recursive: true, render: false });
        const updatedSource = document.toObject(true);
        for (const pendingResult of pending) {
          if (verifyReference(updatedSource, pendingResult.ref, reverse)) pendingResult.status = "changed";
          else {
            pendingResult.status = "error";
            pendingResult.error = reverse
              ? "Откат применился, но итоговое значение не прошло проверку."
              : "Документ обновился, но итоговое значение не прошло проверку.";
          }
        }
      } catch (error) {
        for (const pendingResult of pending) {
          pendingResult.status = "error";
          pendingResult.error = error?.message ?? String(error);
        }
      }

      if (index % 10 === 9) await yieldToBrowser();
    }
  } finally {
    const lockIssues = await restorePackLocks(unlockedPacks);
    for (const issue of lockIssues) results.push({ entryOldPath: null, entryNewPath: null, ref: null, ...issue });
  }

  return { results, expectedByEntry };
}

function resultForEntry(results, oldPath) {
  return results.filter((result) => result.entryOldPath === oldPath);
}

function cleanupFileKey(file) {
  return `${file.oldPath}|${file.newPath}|${file.oldSha256}|${file.newSha256}`;
}

export async function applyMigration(manifest, conversionReport, options = {}, { onProgress, signal } = {}) {
  if (!game.user?.isGM) throw new Error("Миграция доступна только GM.");
  const currentWorldId = game.world?.id ?? null;
  if (!manifest?.manifestId || conversionReport?.sourceManifestId !== manifest.manifestId) {
    throw new Error("Conversion report создан для другого manifest. Миграция отклонена.");
  }
  if (manifest.worldId !== currentWorldId || conversionReport?.sourceWorldId !== currentWorldId) {
    throw new Error("Manifest или conversion report относятся к другому миру.");
  }

  const reportMap = new Map((conversionReport.entries ?? []).map((entry) => [entry.oldPath, entry]));
  const entries = (manifest.entries ?? [])
    .filter((entry) => successfulEntry(reportMap.get(entry.oldPath), conversionReport))
    .map((entry) => ({ ...entry, conversion: reportMap.get(entry.oldPath) }));
  if (!entries.length) throw new Error("В отчете нет подтвержденных WEBP для текущего manifest.");

  const normalizedOptions = {
    autoUnlockWorldPacks: options.autoUnlockWorldPacks !== false,
    allowPackageCompendiumWrites: options.allowPackageCompendiumWrites === true
  };
  const { results, expectedByEntry } = await processDocumentTasks(entries, normalizedOptions, false, { onProgress, signal });

  const migrated = [];
  const skipped = [];
  const cleanupFiles = [];
  const cleanupDedupe = new Set();

  for (const entry of entries) {
    const entryResults = resultForEntry(results, entry.oldPath);
    const expectedCount = expectedByEntry.get(entry.oldPath)?.size ?? 0;
    const refResults = entryResults.filter((result) => result.ref);
    const fullyMigrated = expectedCount > 0
      && refResults.length === expectedCount
      && refResults.every((result) => result.status === "changed" || result.status === "already");
    const item = {
      oldPath: entry.oldPath,
      newPath: entry.newPath,
      wildcard: !!entry.wildcard,
      refCount: expectedCount,
      changed: refResults.filter((result) => result.status === "changed").length,
      already: refResults.filter((result) => result.status === "already").length,
      stale: refResults.filter((result) => result.status === "stale").length,
      errors: refResults.filter((result) => result.status === "error" || result.status === "skipped").length,
      conversionStatus: entry.conversion.status,
      conversionVerified: entry.conversion.verified === true,
      cleanupEligibleFiles: 0
    };

    if (fullyMigrated) {
      for (const file of entry.conversion.files ?? []) {
        if (!file.cleanupEligible) continue;
        const key = cleanupFileKey(file);
        if (cleanupDedupe.has(key)) continue;
        cleanupDedupe.add(key);
        cleanupFiles.push({ ...deepClone(file), manifestOldPath: entry.oldPath });
        item.cleanupEligibleFiles += 1;
      }
      migrated.push(item);
    } else {
      skipped.push({ ...item, reason: "Не все ссылки текущего manifest обновлены или уже указывали на WEBP." });
    }
  }

  const changedRefs = results
    .filter((result) => result.status === "changed")
    .map((result) => ({ ...result.ref, appliedDirection: "forward" }));
  const errorResults = results.filter((result) => ["error", "skipped", "stale", "lock-restore-error"].includes(result.status));
  const lockRestoreErrors = results.filter((result) => result.status === "lock-restore-error").length;
  return {
    type: "fbl-webp-migrator-migration-report",
    schemaVersion: REPORT_SCHEMA_VERSION,
    version: manifest.version,
    createdAt: new Date().toISOString(),
    sourceManifestId: manifest.manifestId,
    sourceDataRootId: conversionReport.dataRootId ?? null,
    worldId: manifest.worldId,
    worldTitle: manifest.worldTitle,
    options: normalizedOptions,
    summary: {
      inputEntries: entries.length,
      fullyMigratedPngPaths: migrated.length,
      cleanupEligibleFiles: cleanupFiles.length,
      skippedPngPaths: skipped.length,
      changedReferences: changedRefs.length,
      alreadyMigratedReferences: results.filter((result) => result.status === "already").length,
      staleReferences: results.filter((result) => result.status === "stale").length,
      errors: results.filter((result) => result.status === "error" || result.status === "skipped").length,
      lockRestoreErrors
    },
    migrated,
    cleanupFiles,
    skipped,
    changedRefs,
    issues: errorResults.map((result) => ({
      oldPath: result.entryOldPath,
      uuid: result.ref?.uuid,
      fieldLabel: result.ref?.fieldLabel,
      pack: result.pack,
      status: result.status,
      error: result.error
    }))
  };
}

export function sanitizeMigrationReportForRollback(raw, currentWorldId = game.world?.id ?? null) {
  if (!raw || raw.type !== "fbl-webp-migrator-migration-report") throw new Error("Это не migration report FBL WebP Migrator.");
  if (raw.worldId !== currentWorldId) throw new Error("Migration report относится к другому миру.");
  const changedRefs = [];
  const dedupe = new Set();
  for (const input of raw.changedRefs ?? []) {
    if (!validateReference(input)) continue;
    const key = referenceKey(input);
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    changedRefs.push({
      ...deepClone(input),
      appliedDirection: input.appliedDirection === "reverse" ? "reverse" : "forward"
    });
  }
  if (!changedRefs.length) throw new Error("В migration report нет допустимых ссылок для отката.");
  return {
    type: raw.type,
    schemaVersion: REPORT_SCHEMA_VERSION,
    version: typeof raw.version === "string" ? raw.version : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    sourceManifestId: typeof raw.sourceManifestId === "string" ? raw.sourceManifestId : null,
    sourceDataRootId: DATA_ROOT_ID_RE.test(String(raw.sourceDataRootId ?? "")) ? String(raw.sourceDataRootId).toLowerCase() : null,
    worldId: currentWorldId,
    worldTitle: typeof raw.worldTitle === "string" ? raw.worldTitle : game.world?.title ?? null,
    options: sanitizeJsonValue(raw.options ?? {}),
    summary: sanitizeJsonValue(raw.summary ?? {}),
    migrated: Array.isArray(raw.migrated) ? sanitizeJsonValue(raw.migrated) : [],
    cleanupFiles: Array.isArray(raw.cleanupFiles) ? sanitizeJsonValue(raw.cleanupFiles) : [],
    skipped: Array.isArray(raw.skipped) ? sanitizeJsonValue(raw.skipped) : [],
    changedRefs,
    issues: Array.isArray(raw.issues) ? sanitizeJsonValue(raw.issues) : []
  };
}

function mergeChangedReferences(previousRefs = [], currentRefs = []) {
  const map = new Map();
  for (const input of [...previousRefs, ...currentRefs]) {
    if (!validateReference(input)) continue;
    const ref = {
      ...deepClone(input),
      appliedDirection: input.appliedDirection === "reverse" ? "reverse" : "forward"
    };
    const key = referenceKey(ref);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, ref);
      continue;
    }
    if (existing.appliedDirection === ref.appliedDirection) {
      map.set(key, ref);
      continue;
    }
    // Opposite mutations on the same field cancel each other. The field is back
    // at the value it had before the first recorded mutation, so rollback must
    // not apply either transition again.
    map.delete(key);
  }
  return [...map.values()];
}

function mergeByKey(previousItems = [], currentItems = [], keyOf) {
  const map = new Map();
  for (const item of [...previousItems, ...currentItems]) {
    if (!item || typeof item !== "object") continue;
    const key = keyOf(item);
    if (!key) continue;
    map.set(key, deepClone(item));
  }
  return [...map.values()];
}

function currentReversePaths(report) {
  const paths = new Set();
  for (const item of report?.migrated ?? []) {
    if (item?.direction === "webp-to-png" && typeof item.oldPath === "string") paths.add(item.oldPath);
  }
  for (const ref of report?.changedRefs ?? []) {
    if (ref?.appliedDirection === "reverse" && typeof ref.oldPath === "string") paths.add(ref.oldPath);
  }
  return paths;
}

export function mergeMigrationReports(previous, current) {
  if (!current) return previous ?? null;
  if (!previous) return current;
  if (previous.worldId !== current.worldId) return current;

  const changedRefs = mergeChangedReferences(previous.changedRefs, current.changedRefs);
  const sourceManifestIds = [...new Set([
    ...(previous.sourceManifestIds ?? [previous.sourceManifestId]),
    ...(current.sourceManifestIds ?? [current.sourceManifestId])
  ].filter(Boolean))];

  const reversePaths = currentReversePaths(current);
  const previousCleanup = (previous.cleanupFiles ?? []).filter((file) => {
    const manifestPath = file?.manifestOldPath ?? file?.oldPath;
    return !reversePaths.has(manifestPath);
  });
  const roots = [...new Set([previous.sourceDataRootId, current.sourceDataRootId].filter(Boolean))];
  const dataRootConflict = roots.length > 1;
  const cleanupFiles = dataRootConflict
    ? []
    : mergeByKey(previousCleanup, current.cleanupFiles, cleanupFileKey);
  const sourceDataRootId = dataRootConflict ? null : (roots[0] ?? null);

  const migrated = mergeByKey(previous.migrated, current.migrated, (item) => item.oldPath ?? null);
  const skipped = mergeByKey(previous.skipped, current.skipped, (item) => `${item.oldPath ?? ""}|${item.direction ?? ""}|${item.reason ?? ""}`);
  const issues = mergeByKey(previous.issues, current.issues, (item) => [
    item.oldPath ?? "",
    item.uuid ?? "",
    item.fieldLabel ?? "",
    item.status ?? "",
    item.direction ?? "",
    item.error ?? ""
  ].join("|"));
  if (dataRootConflict) {
    issues.push({
      oldPath: null,
      status: "merge-data-root-conflict",
      error: "Migration reports refer to different Foundry Data roots. Cleanup authorization was discarded."
    });
  }

  return {
    ...current,
    sourceManifestIds,
    sourceDataRootId,
    migrated,
    cleanupFiles,
    skipped,
    changedRefs,
    issues,
    summary: {
      ...current.summary,
      changedReferences: changedRefs.length,
      cleanupEligibleFiles: cleanupFiles.length
    }
  };
}

export async function rollbackMigration(migrationReport, options = {}, { onProgress, signal } = {}) {
  if (!game.user?.isGM) throw new Error("Откат доступен только GM.");
  if (migrationReport?.worldId !== (game.world?.id ?? null)) throw new Error("Migration report относится к другому миру.");
  const changedRefs = migrationReport?.changedRefs ?? [];
  if (!changedRefs.length) throw new Error("В migration report нет ссылок, измененных этим запуском.");

  const normalizedOptions = {
    autoUnlockWorldPacks: options.autoUnlockWorldPacks !== false,
    allowPackageCompendiumWrites: options.allowPackageCompendiumWrites === true
  };
  const buildEntries = (refs) => {
    const byPath = new Map();
    for (const ref of refs) {
      if (!validateReference(ref)) continue;
      if (!byPath.has(ref.oldPath)) byPath.set(ref.oldPath, { oldPath: ref.oldPath, newPath: ref.newPath, refs: [] });
      byPath.get(ref.oldPath).refs.push(ref);
    }
    return [...byPath.values()];
  };

  const forwardApplied = changedRefs.filter((ref) => ref.appliedDirection !== "reverse");
  const reverseApplied = changedRefs.filter((ref) => ref.appliedDirection === "reverse");
  const results = [];
  const phases = [
    { refs: forwardApplied, reverse: true },
    { refs: reverseApplied, reverse: false }
  ].filter((phase) => phase.refs.length);
  let completed = 0;
  const total = phases.reduce((sum, phase) => sum + buildEntries(phase.refs).reduce((count, entry) => count + new Set(entry.refs.map((ref) => ref.uuid)).size, 0), 0);

  for (const phase of phases) {
    const entries = buildEntries(phase.refs);
    const phaseResult = await processDocumentTasks(entries, normalizedOptions, phase.reverse, {
      signal,
      onProgress: ({ label }) => {
        completed += 1;
        onProgress?.({ current: completed, total: Math.max(total, completed), label });
      }
    });
    results.push(...phaseResult.results);
  }

  return {
    changed: results.filter((result) => result.status === "changed").length,
    already: results.filter((result) => result.status === "already").length,
    stale: results.filter((result) => result.status === "stale").length,
    errors: results.filter((result) => result.status === "error" || result.status === "skipped").length,
    lockRestoreErrors: results.filter((result) => result.status === "lock-restore-error").length,
    issues: results.filter((result) => !["changed", "already"].includes(result.status))
  };
}
