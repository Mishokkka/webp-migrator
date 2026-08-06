import { SUCCESS_STATUSES } from "./constants.mjs";
import { deepClone, getAtPath, isSafePathSegments, replaceTextReference, setAtPath } from "./path-utils.mjs";
import { getPackPackageType } from "./scanner.mjs";

function normalizeStatus(status) {
  return String(status ?? "").trim().toLowerCase();
}

function successfulStatus(status) {
  return SUCCESS_STATUSES.has(normalizeStatus(status));
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

function referenceKey(ref) {
  return `${ref.uuid}|${JSON.stringify(ref.fieldPath)}|${ref.mode}|${ref.oldValue}|${ref.newValue}`;
}

function validateReference(ref) {
  return !!ref
    && typeof ref.uuid === "string"
    && isSafePathSegments(ref.fieldPath)
    && typeof ref.rootField === "string"
    && ref.fieldPath[0] === ref.rootField
    && (ref.mode === "exact" || ref.mode === "text")
    && typeof ref.oldValue === "string"
    && typeof ref.newValue === "string";
}

export function sanitizeConversionReport(report, manifest, currentWorldId = game.world?.id ?? null) {
  if (!manifest || manifest.type !== "fbl-webp-migrator-manifest") throw new Error("Сначала создай текущий manifest сканированием.");
  if (!report || report.type !== "fbl-webp-migrator-conversion-report") throw new Error("Это не conversion-report от FBL WebP Migrator.");
  if (!manifest.manifestId) throw new Error("Manifest устарел и не содержит manifestId. Выполни новое сканирование.");
  if (report.sourceManifestId !== manifest.manifestId) throw new Error("Conversion report создан для другого manifest. Импорт отклонён.");
  if (manifest.worldId !== currentWorldId || report.sourceWorldId !== currentWorldId) throw new Error("Manifest или conversion report относятся к другому миру.");

  const manifestEntries = new Map((manifest.entries ?? []).map((entry) => [entry.oldPath, entry]));
  const entries = [];
  const ignored = [];

  for (const input of report.entries ?? []) {
    const source = manifestEntries.get(input?.oldPath);
    if (!source || source.newPath !== input?.newPath) {
      ignored.push({ oldPath: input?.oldPath ?? null, reason: "Путь отсутствует в текущем manifest или newPath не совпадает." });
      continue;
    }
    entries.push({
      oldPath: source.oldPath,
      newPath: source.newPath,
      status: normalizeStatus(input.status),
      oldSize: Number.isFinite(input.oldSize) ? input.oldSize : null,
      newSize: Number.isFinite(input.newSize) ? input.newSize : null,
      savedPercent: Number.isFinite(input.savedPercent) ? input.savedPercent : null,
      files: Array.isArray(input.files) ? input.files.map((file) => ({
        oldPath: file?.oldPath,
        newPath: file?.newPath,
        status: normalizeStatus(file?.status)
      })) : undefined
    });
  }

  const byPath = new Map(entries.map((entry) => [entry.oldPath, entry]));
  return {
    type: report.type,
    schemaVersion: report.schemaVersion ?? 2,
    version: report.version,
    createdAt: report.createdAt,
    sourceManifestId: report.sourceManifestId,
    sourceWorldId: report.sourceWorldId,
    options: deepClone(report.options ?? {}),
    summary: deepClone(report.summary ?? {}),
    ignored,
    entries: [...byPath.values()]
  };
}

export function createAssumedConversionReport(manifest) {
  if (!manifest?.manifestId) throw new Error("Сначала выполни новое сканирование.");
  const entries = (manifest.entries ?? []).map((entry) => ({
    oldPath: entry.oldPath,
    newPath: entry.newPath,
    status: "assume-existing"
  }));
  return {
    type: "fbl-webp-migrator-conversion-report",
    schemaVersion: 2,
    version: manifest.version,
    createdAt: new Date().toISOString(),
    sourceManifestId: manifest.manifestId,
    sourceWorldId: manifest.worldId,
    options: { assumeExistingWebp: true },
    summary: {
      input: entries.length,
      converted: 0,
      exists: entries.length,
      existsMissingOld: 0,
      failed: 0,
      skipped: 0,
      totalOldSize: 0,
      totalNewSize: 0,
      totalSavedBytes: 0,
      totalSavedPercent: 0
    },
    entries
  };
}

function replaceReference(current, ref, reverse = false) {
  const oldValue = reverse ? ref.newValue : ref.oldValue;
  const newValue = reverse ? ref.oldValue : ref.newValue;
  if (ref.mode === "exact") {
    if (current === oldValue) return { status: "changed", value: newValue };
    if (current === newValue) return { status: "already", value: current };
    return { status: "stale", value: current };
  }
  return replaceTextReference(current, oldValue, newValue);
}

function verifyReference(source, ref, reverse = false) {
  const expected = reverse ? ref.oldValue : ref.newValue;
  const current = getAtPath(source, ref.fieldPath);
  if (ref.mode === "exact") return current === expected;
  return typeof current === "string" && current.includes(expected);
}

async function unlockPackIfNeeded(pack, options, unlockedPacks) {
  if (!pack?.locked) return true;
  if (!isWorldPack(pack)) return false;
  if (!options.autoUnlockWorldPacks) return false;
  await pack.configure({ locked: false });
  unlockedPacks.set(pack.collection, pack);
  return true;
}

async function restorePackLocks(unlockedPacks) {
  for (const pack of unlockedPacks.values()) {
    try {
      await pack.configure({ locked: true });
    } catch (error) {
      console.error("FBL WebP Migrator | Failed to restore compendium lock", pack.collection, error);
    }
  }
}

async function buildDocumentPlans(entries, options, reverse) {
  const plans = new Map();
  const results = [];
  const dedupe = new Set();

  for (const entry of entries) {
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
      if (dedupe.has(key)) continue;
      dedupe.add(key);

      let document;
      try {
        document = await resolveDocument(ref.uuid);
      } catch (error) {
        results.push({ ...resultBase, status: "error", error: error?.message ?? String(error) });
        continue;
      }
      if (!document) {
        results.push({ ...resultBase, status: "error", error: `Документ не найден: ${ref.uuid}` });
        continue;
      }

      const pack = getPack(document);
      if (pack && !isWorldPack(pack) && !options.allowPackageCompendiumWrites) {
        results.push({ ...resultBase, status: "skipped", error: `Package compendium ${pack.collection} доступен только для чтения по текущим настройкам.` });
        continue;
      }

      let plan = plans.get(document.uuid);
      if (!plan) {
        const source = document.toObject(true);
        plan = {
          document,
          pack,
          source,
          working: deepClone(source),
          changedRoots: new Set(),
          pending: []
        };
        plans.set(document.uuid, plan);
      }

      const current = getAtPath(plan.working, ref.fieldPath);
      const replacement = replaceReference(current, ref, reverse);
      if (replacement.status === "changed") {
        try {
          setAtPath(plan.working, ref.fieldPath, replacement.value);
          plan.changedRoots.add(ref.rootField);
          const result = { ...resultBase, status: "pending" };
          plan.pending.push(result);
          results.push(result);
        } catch (error) {
          results.push({ ...resultBase, status: "error", error: error?.message ?? String(error) });
        }
      } else if (replacement.status === "already") {
        results.push({ ...resultBase, status: "already" });
      } else {
        results.push({ ...resultBase, status: "stale", error: "Поле изменилось после сканирования или больше не содержит исходный PNG-путь." });
      }
    }
  }
  return { plans, results };
}

function resultForEntry(results, oldPath) {
  return results.filter((result) => result.entryOldPath === oldPath);
}

export async function applyMigration(manifest, conversionReport, options = {}, { onProgress } = {}) {
  if (!game.user?.isGM) throw new Error("Миграция доступна только GM.");
  const reportMap = new Map((conversionReport.entries ?? []).map((entry) => [entry.oldPath, entry]));
  const entries = (manifest.entries ?? [])
    .filter((entry) => successfulStatus(reportMap.get(entry.oldPath)?.status))
    .map((entry) => ({ ...entry, conversionStatus: reportMap.get(entry.oldPath).status }));
  if (!entries.length) throw new Error("В отчете нет подтвержденных WEBP для текущего manifest.");

  const normalizedOptions = {
    autoUnlockWorldPacks: options.autoUnlockWorldPacks !== false,
    allowPackageCompendiumWrites: options.allowPackageCompendiumWrites === true
  };
  const { plans, results } = await buildDocumentPlans(entries, normalizedOptions, false);
  const unlockedPacks = new Map();
  const documentPlans = [...plans.values()];

  try {
    for (let index = 0; index < documentPlans.length; index += 1) {
      const plan = documentPlans[index];
      onProgress?.({ current: index + 1, total: documentPlans.length, label: plan.document.name ?? plan.document.id });
      if (!plan.changedRoots.size) continue;

      try {
        if (plan.pack && !await unlockPackIfNeeded(plan.pack, normalizedOptions, unlockedPacks)) {
          for (const pending of plan.pending) {
            pending.status = "skipped";
            pending.error = `Compendium ${plan.pack.collection} заблокирован.`;
          }
          continue;
        }

        const updateData = {};
        for (const rootField of plan.changedRoots) updateData[rootField] = plan.working[rootField];
        await plan.document.update(updateData, { diff: true, recursive: true, render: false });
        const updatedSource = plan.document.toObject(true);
        for (const pending of plan.pending) {
          if (verifyReference(updatedSource, pending.ref, false)) pending.status = "changed";
          else {
            pending.status = "error";
            pending.error = "Документ обновился, но итоговое значение не прошло проверку.";
          }
        }
      } catch (error) {
        for (const pending of plan.pending) {
          pending.status = "error";
          pending.error = error?.message ?? String(error);
        }
      }
    }
  } finally {
    await restorePackLocks(unlockedPacks);
  }

  const migrated = [];
  const skipped = [];
  for (const entry of entries) {
    const entryResults = resultForEntry(results, entry.oldPath);
    const fullyMigrated = entryResults.length === (entry.refs?.length ?? 0)
      && entryResults.every((result) => result.status === "changed" || result.status === "already");
    const item = {
      oldPath: entry.oldPath,
      newPath: entry.newPath,
      wildcard: !!entry.wildcard,
      refCount: entry.refs?.length ?? 0,
      changed: entryResults.filter((result) => result.status === "changed").length,
      already: entryResults.filter((result) => result.status === "already").length,
      stale: entryResults.filter((result) => result.status === "stale").length,
      errors: entryResults.filter((result) => result.status === "error" || result.status === "skipped").length
    };
    if (fullyMigrated) migrated.push(item);
    else skipped.push({ ...item, reason: "Не все ссылки текущего manifest обновлены или уже указывали на WEBP." });
  }

  const changedRefs = results.filter((result) => result.status === "changed").map((result) => result.ref);
  const errorResults = results.filter((result) => result.status === "error" || result.status === "skipped" || result.status === "stale");
  return {
    type: "fbl-webp-migrator-migration-report",
    schemaVersion: 2,
    version: manifest.version,
    createdAt: new Date().toISOString(),
    sourceManifestId: manifest.manifestId,
    worldId: manifest.worldId,
    worldTitle: manifest.worldTitle,
    options: normalizedOptions,
    summary: {
      inputEntries: entries.length,
      fullyMigratedPngPaths: migrated.length,
      skippedPngPaths: skipped.length,
      changedReferences: changedRefs.length,
      alreadyMigratedReferences: results.filter((result) => result.status === "already").length,
      staleReferences: results.filter((result) => result.status === "stale").length,
      errors: results.filter((result) => result.status === "error" || result.status === "skipped").length
    },
    migrated,
    skipped,
    changedRefs,
    issues: errorResults.map((result) => ({
      oldPath: result.entryOldPath,
      uuid: result.ref?.uuid,
      fieldLabel: result.ref?.fieldLabel,
      status: result.status,
      error: result.error
    }))
  };
}

export async function rollbackMigration(migrationReport, options = {}, { onProgress } = {}) {
  if (!game.user?.isGM) throw new Error("Откат доступен только GM.");
  const changedRefs = migrationReport?.changedRefs ?? [];
  if (!changedRefs.length) throw new Error("В migration report нет ссылок, измененных этим запуском.");

  const byPath = new Map();
  for (const ref of changedRefs) {
    if (!byPath.has(ref.oldPath)) byPath.set(ref.oldPath, { oldPath: ref.oldPath, newPath: ref.newPath, refs: [] });
    byPath.get(ref.oldPath).refs.push(ref);
  }
  const entries = [...byPath.values()];
  const normalizedOptions = {
    autoUnlockWorldPacks: options.autoUnlockWorldPacks !== false,
    allowPackageCompendiumWrites: options.allowPackageCompendiumWrites === true
  };
  const { plans, results } = await buildDocumentPlans(entries, normalizedOptions, true);
  const unlockedPacks = new Map();
  const documentPlans = [...plans.values()];

  try {
    for (let index = 0; index < documentPlans.length; index += 1) {
      const plan = documentPlans[index];
      onProgress?.({ current: index + 1, total: documentPlans.length, label: plan.document.name ?? plan.document.id });
      if (!plan.changedRoots.size) continue;
      try {
        if (plan.pack && !await unlockPackIfNeeded(plan.pack, normalizedOptions, unlockedPacks)) {
          for (const pending of plan.pending) {
            pending.status = "skipped";
            pending.error = `Compendium ${plan.pack.collection} заблокирован.`;
          }
          continue;
        }
        const updateData = {};
        for (const rootField of plan.changedRoots) updateData[rootField] = plan.working[rootField];
        await plan.document.update(updateData, { diff: true, recursive: true, render: false });
        const updatedSource = plan.document.toObject(true);
        for (const pending of plan.pending) {
          if (verifyReference(updatedSource, pending.ref, true)) pending.status = "changed";
          else {
            pending.status = "error";
            pending.error = "Откат применился, но итоговое значение не прошло проверку.";
          }
        }
      } catch (error) {
        for (const pending of plan.pending) {
          pending.status = "error";
          pending.error = error?.message ?? String(error);
        }
      }
    }
  } finally {
    await restorePackLocks(unlockedPacks);
  }

  return {
    changed: results.filter((result) => result.status === "changed").length,
    already: results.filter((result) => result.status === "already").length,
    stale: results.filter((result) => result.status === "stale").length,
    errors: results.filter((result) => result.status === "error" || result.status === "skipped").length,
    issues: results.filter((result) => !["changed", "already"].includes(result.status))
  };
}
