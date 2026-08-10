import { FALLBACK_EMBEDDED_FIELDS, MISSING_ASSET_PLACEHOLDER, REPORT_SCHEMA_VERSION } from "./constants.mjs";
import {
  deepClone,
  globToRegExp,
  normalizePhysicalPath,
  normalizeWebpPhysicalPath,
  sanitizeJsonValue,
  toWebpPhysicalPath
} from "./path-utils.mjs";
import { processDocumentTasks, validateReference } from "./migration.mjs";
import { getPackPackageType, iterateDocumentTree } from "./scanner.mjs";
import {
  IMAGE_HOVER_SPECIFIC_ART_SENTINEL,
  IMAGE_HOVER_SPECIFIC_ART_SENTINEL_WEBP,
  missingAssetReplacementForRef
} from "./compatibility.mjs";

const DATA_ROOT_ID_RE = /^sha256:[a-f0-9]{64}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/i;

function isCaseInsensitivePlatform(platform = globalThis.process?.platform ?? globalThis.navigator?.platform ?? "") {
  return /^(?:win32|darwin)$/i.test(platform) || /(?:win|mac)/i.test(platform);
}

function pathKey(value, caseInsensitive = isCaseInsensitivePlatform()) {
  const text = String(value ?? "");
  return caseInsensitive ? text.toLocaleLowerCase("en-US") : text;
}

function validNumber(value, { integer = false, minimum = 0 } = {}) {
  if (!Number.isFinite(value) || value < minimum) return null;
  if (integer && !Number.isInteger(value)) return null;
  return value;
}

function manifestPairMap(manifest) {
  const map = new Map();
  const caseInsensitive = isCaseInsensitivePlatform();
  const add = (entry, format) => {
    if (!entry?.oldPath || !entry?.newPath) return;
    const key = pathKey(entry.oldPath, caseInsensitive);
    if (!map.has(key)) {
      map.set(key, {
        oldPath: entry.oldPath,
        newPath: entry.newPath,
        wildcard: !!entry.wildcard,
        pngEntry: null,
        webpEntry: null
      });
    }
    const pair = map.get(key);
    if (pathKey(pair.newPath, caseInsensitive) !== pathKey(entry.newPath, caseInsensitive)) return;
    pair[format === "webp" ? "webpEntry" : "pngEntry"] = entry;
  };
  for (const entry of manifest?.entries ?? []) add(entry, "png");
  for (const entry of manifest?.webpEntries ?? []) add(entry, "webp");
  return map;
}

function sanitizeFileState(input, format) {
  const exists = input?.exists === true;
  const width = validNumber(input?.width, { integer: true, minimum: 1 });
  const height = validNumber(input?.height, { integer: true, minimum: 1 });
  const size = validNumber(input?.size);
  const mtimeMs = validNumber(input?.mtimeMs);
  const sha256 = SHA256_RE.test(String(input?.sha256 ?? "")) ? String(input.sha256).toLowerCase() : null;
  const reportedValid = exists && input?.valid === true;
  const evidenceComplete = !!(width && height && size != null && mtimeMs != null && sha256);
  const valid = reportedValid && evidenceComplete;
  const reportedError = typeof input?.error === "string" ? input.error : undefined;
  return {
    exists,
    valid,
    animated: format === "png" && valid && input?.animated === true,
    width,
    height,
    size,
    mtimeMs,
    sha256,
    error: reportedError ?? (reportedValid && !evidenceComplete ? "Verified file metadata is incomplete." : undefined)
  };
}

function dimensionsMatch(file) {
  if (!file.png.valid || !file.webp.valid) return null;
  if (!file.png.width || !file.png.height || !file.webp.width || !file.webp.height) return false;
  return file.png.width === file.webp.width && file.png.height === file.webp.height;
}

export function classifyConsistencyFile(file) {
  const png = file.png;
  const webp = file.webp;
  if (!png.exists && !webp.exists) return "both-missing";
  if (png.exists && !png.valid && webp.exists && !webp.valid) return "both-invalid";
  if (png.exists && !png.valid) return webp.valid ? "invalid-png-valid-webp" : "invalid-png";
  if (webp.exists && !webp.valid) return png.valid ? "valid-png-invalid-webp" : "invalid-webp";
  if (png.valid && webp.valid) {
    if (png.animated) return "apng-and-webp";
    return dimensionsMatch(file) ? "both-valid" : "dimension-mismatch";
  }
  if (png.valid) return "png-only";
  if (webp.valid) return "webp-only";
  return "unresolved";
}

export function isForwardRepairSafe(file) {
  if (!file?.webp?.valid) return false;
  if (file?.png?.animated) return false;
  if (!file?.png?.valid) return true;
  return dimensionsMatch(file) === true;
}

export function isReverseRepairSafe(file) {
  return file?.png?.valid === true && file?.webp?.valid !== true;
}

export function isPlaceholderRepairSafe(file) {
  return file?.category === "both-missing"
    || (file?.png?.exists === false && file?.webp?.exists === false);
}

function sanitizeConcreteFile(input, pair) {
  const oldPath = normalizePhysicalPath(input?.oldPath);
  const newPath = normalizeWebpPhysicalPath(input?.newPath);
  const caseInsensitive = isCaseInsensitivePlatform();
  if (!oldPath || !newPath || /[*?]/.test(oldPath) || /[*?]/.test(newPath)) return null;
  if (pathKey(toWebpPhysicalPath(oldPath), caseInsensitive) !== pathKey(newPath, caseInsensitive)) return null;

  if (pair.wildcard) {
    try {
      if (!globToRegExp(pair.oldPath, { caseInsensitive }).test(oldPath)) return null;
    } catch {
      return null;
    }
  } else if (pathKey(oldPath, caseInsensitive) !== pathKey(pair.oldPath, caseInsensitive)
    || pathKey(newPath, caseInsensitive) !== pathKey(pair.newPath, caseInsensitive)) return null;

  const file = {
    oldPath,
    newPath,
    png: sanitizeFileState(input?.png, "png"),
    webp: sanitizeFileState(input?.webp, "webp")
  };
  file.dimensionsMatch = dimensionsMatch(file);
  file.category = classifyConsistencyFile(file);
  return file;
}

function summarize(entries, ignoredCount = 0) {
  const files = entries.flatMap((entry) => entry.files ?? []);
  const categories = {};
  for (const file of files) categories[file.category] = (categories[file.category] ?? 0) + 1;
  return {
    pairs: entries.length,
    concreteFiles: files.length,
    pngReferences: entries.reduce((sum, entry) => sum + entry.pngRefCount, 0),
    webpReferences: entries.reduce((sum, entry) => sum + entry.webpRefCount, 0),
    forwardRepairPaths: entries.filter((entry) => entry.forwardAuthorized).length,
    reverseRepairPaths: entries.filter((entry) => entry.reverseAuthorized).length,
    placeholderRepairPaths: entries.filter((entry) => entry.placeholderAuthorized).length,
    consistentPaths: entries.filter((entry) => entry.status === "consistent").length,
    unresolvedPaths: entries.filter((entry) => entry.status === "unresolved").length,
    blockedPngPaths: entries.filter((entry) => entry.pngRefCount > 0 && !entry.forwardAuthorized).length,
    blockedWebpPaths: entries.filter((entry) => entry.webpRefCount > 0 && !entry.reverseAuthorized && entry.files.some((file) => file.webp.valid !== true)).length,
    unresolvedFiles: entries.filter((entry) => entry.status === "unresolved").reduce((sum, entry) => sum + entry.files.length, 0),
    ignored: ignoredCount,
    categories
  };
}

export function sanitizeConsistencyReport(raw, manifest, currentWorldId = game.world?.id ?? null) {
  if (!manifest?.manifestId) throw new Error("Сначала создай или импортируй новый manifest.");
  if (!(Number(manifest.schemaVersion) >= 4)
    || manifest.capabilities?.webpReferenceScan !== true
    || manifest.capabilities?.consistencyAudit !== true) {
    throw new Error("Manifest не содержит полного сканирования WEBP-ссылок. Выполни новое сканирование модулем 0.4.0 или новее.");
  }
  if (!raw || raw.type !== "fbl-webp-migrator-consistency-report") throw new Error("Это не consistency report FBL WebP Migrator.");
  if (!(Number(raw.schemaVersion) >= 4)) throw new Error("Consistency report устарел. Выполни новый audit инструментом 0.4.0 или новее.");
  if (raw.sourceManifestId !== manifest.manifestId) throw new Error("Consistency report создан для другого manifest.");
  if (manifest.worldId !== currentWorldId || raw.sourceWorldId !== currentWorldId) throw new Error("Manifest или consistency report относятся к другому миру.");
  const dataRootId = DATA_ROOT_ID_RE.test(String(raw.dataRootId ?? "")) ? String(raw.dataRootId).toLowerCase() : null;
  if (!dataRootId) throw new Error("Consistency report не содержит корректной привязки к Foundry Data root.");

  const pairs = manifestPairMap(manifest);
  const entries = [];
  const ignored = [];
  const seen = new Set();

  const caseInsensitive = isCaseInsensitivePlatform();
  for (const input of raw.entries ?? []) {
    const oldPath = normalizePhysicalPath(input?.oldPath);
    const pair = pairs.get(pathKey(oldPath, caseInsensitive));
    if (!pair || pathKey(pair.newPath, caseInsensitive) !== pathKey(input?.newPath, caseInsensitive)) {
      ignored.push({ oldPath: input?.oldPath ?? null, reason: "Пара отсутствует в текущем manifest." });
      continue;
    }
    const seenKey = pathKey(oldPath, caseInsensitive);
    if (seen.has(seenKey)) {
      ignored.push({ oldPath, reason: "Дублирующая запись consistency report." });
      continue;
    }
    seen.add(seenKey);

    const files = (input.files ?? []).map((file) => sanitizeConcreteFile(file, pair)).filter(Boolean);
    const pngRefCount = pair.pngEntry?.refs?.length ?? 0;
    const webpRefCount = pair.webpEntry?.refs?.length ?? 0;
    const forwardAuthorized = pngRefCount > 0 && files.length > 0 && files.every(isForwardRepairSafe);
    const reverseAuthorized = webpRefCount > 0 && files.length > 0 && files.every(isReverseRepairSafe);
    const placeholderAuthorized = !pair.wildcard
      && (pngRefCount + webpRefCount) > 0
      && files.length > 0
      && files.every(isPlaceholderRepairSafe);
    const currentPngValid = pngRefCount === 0 || (files.length > 0 && files.every((file) => file.png.valid));
    const currentWebpValid = webpRefCount === 0 || (files.length > 0 && files.every((file) => file.webp.valid));
    entries.push({
      oldPath: pair.oldPath,
      newPath: pair.newPath,
      wildcard: pair.wildcard,
      pngRefCount,
      webpRefCount,
      forwardAuthorized,
      reverseAuthorized,
      placeholderAuthorized,
      files,
      status: forwardAuthorized
          ? "repair-to-webp"
          : reverseAuthorized
            ? "repair-to-png"
            : placeholderAuthorized
              ? "repair-to-placeholder"
              : currentPngValid && currentWebpValid
                ? "consistent"
                : "unresolved"
    });
  }

  return {
    type: raw.type,
    schemaVersion: REPORT_SCHEMA_VERSION,
    version: typeof raw.version === "string" ? raw.version : null,
    producer: typeof raw.producer === "string" ? raw.producer : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    sourceManifestId: manifest.manifestId,
    sourceWorldId: currentWorldId,
    dataRootId,
    ignored,
    summary: summarize(entries, ignored.length),
    entries
  };
}

function normalizedWriteOptions(options) {
  return {
    autoUnlockWorldPacks: options.autoUnlockWorldPacks !== false,
    allowPackageCompendiumWrites: options.allowPackageCompendiumWrites === true
  };
}

function entryResultSummary(entry, results, direction) {
  const relevant = results.filter((result) => result.entryOldPath === entry.oldPath && result.ref);
  const expected = entry.refs?.length ?? 0;
  const complete = expected > 0
    && relevant.length === expected
    && relevant.every((result) => result.status === "changed" || result.status === "already");
  return {
    oldPath: entry.oldPath,
    newPath: entry.newPath,
    wildcard: !!entry.wildcard,
    direction,
    refCount: expected,
    changed: relevant.filter((result) => result.status === "changed").length,
    already: relevant.filter((result) => result.status === "already").length,
    stale: relevant.filter((result) => result.status === "stale").length,
    errors: relevant.filter((result) => result.status === "error" || result.status === "skipped").length,
    cleanupEligibleFiles: 0,
    complete
  };
}

export async function applyConsistencyRepairs(manifest, consistencyReport, options = {}, { onProgress, signal } = {}) {
  if (!game.user?.isGM) throw new Error("Исправление согласованности доступно только GM.");
  const currentWorldId = game.world?.id ?? null;
  if (manifest?.worldId !== currentWorldId || consistencyReport?.sourceWorldId !== currentWorldId) throw new Error("Manifest или consistency report относятся к другому миру.");
  if (consistencyReport?.sourceManifestId !== manifest?.manifestId) throw new Error("Consistency report создан для другого manifest.");

  const reportMap = new Map((consistencyReport.entries ?? []).map((entry) => [entry.oldPath, entry]));
  const forwardEntries = (manifest.entries ?? []).filter((entry) => reportMap.get(entry.oldPath)?.forwardAuthorized === true);
  const reverseEntries = (manifest.webpEntries ?? []).filter((entry) => reportMap.get(entry.oldPath)?.reverseAuthorized === true);
  if (!forwardEntries.length && !reverseEntries.length) throw new Error("В отчете нет безопасных автоматических исправлений.");

  const writeOptions = normalizedWriteOptions(options);
  const results = [];
  const phases = [
    { entries: forwardEntries, reverse: false, direction: "forward" },
    { entries: reverseEntries, reverse: true, direction: "reverse" }
  ].filter((phase) => phase.entries.length);
  let completed = 0;
  const total = phases.reduce((sum, phase) => sum + new Set(phase.entries.flatMap((entry) => entry.refs.map((ref) => ref.uuid))).size, 0);

  for (const phase of phases) {
    const phaseResult = await processDocumentTasks(phase.entries, writeOptions, phase.reverse, {
      signal,
      onProgress: ({ label }) => {
        completed += 1;
        onProgress?.({ current: completed, total: Math.max(total, completed), label, direction: phase.direction });
      }
    });
    for (const result of phaseResult.results) results.push({ ...result, direction: phase.direction });
  }

  const repaired = [];
  const skipped = [];
  for (const entry of forwardEntries) {
    const item = entryResultSummary(entry, results.filter((result) => result.direction === "forward"), "png-to-webp");
    (item.complete ? repaired : skipped).push(item);
  }
  for (const entry of reverseEntries) {
    const item = entryResultSummary(entry, results.filter((result) => result.direction === "reverse"), "webp-to-png");
    (item.complete ? repaired : skipped).push(item);
  }

  const changedRefs = results
    .filter((result) => result.status === "changed" && result.ref && validateReference(result.ref))
    .map((result) => ({
      ...deepClone(result.ref),
      appliedDirection: result.direction === "reverse" ? "reverse" : "forward"
    }));
  const issues = results
    .filter((result) => ["error", "skipped", "stale", "lock-restore-error"].includes(result.status))
    .map((result) => ({
      oldPath: result.entryOldPath,
      uuid: result.ref?.uuid,
      fieldLabel: result.ref?.fieldLabel,
      pack: result.pack,
      status: result.status,
      direction: result.direction,
      error: result.error
    }));

  return {
    type: "fbl-webp-migrator-migration-report",
    schemaVersion: REPORT_SCHEMA_VERSION,
    version: manifest.version,
    createdAt: new Date().toISOString(),
    sourceManifestId: manifest.manifestId,
    sourceDataRootId: consistencyReport.dataRootId ?? null,
    worldId: manifest.worldId,
    worldTitle: manifest.worldTitle,
    options: { ...writeOptions, consistencyRepair: true },
    summary: {
      inputEntries: forwardEntries.length + reverseEntries.length,
      fullyMigratedPngPaths: repaired.filter((entry) => entry.direction === "png-to-webp").length,
      consistencyForwardPaths: repaired.filter((entry) => entry.direction === "png-to-webp").length,
      consistencyReversePaths: repaired.filter((entry) => entry.direction === "webp-to-png").length,
      cleanupEligibleFiles: 0,
      skippedPngPaths: skipped.length,
      changedReferences: changedRefs.length,
      alreadyMigratedReferences: results.filter((result) => result.status === "already").length,
      staleReferences: results.filter((result) => result.status === "stale").length,
      errors: results.filter((result) => result.status === "error" || result.status === "skipped").length,
      lockRestoreErrors: results.filter((result) => result.status === "lock-restore-error").length
    },
    migrated: repaired,
    cleanupFiles: [],
    skipped,
    changedRefs,
    issues,
    consistencySummary: sanitizeJsonValue(consistencyReport.summary)
  };
}

function placeholderRefsForEntry(manifest, reportEntry) {
  const refs = [];
  const caseInsensitive = isCaseInsensitivePlatform();
  const reportKey = pathKey(reportEntry.oldPath, caseInsensitive);
  const findEntry = (entries) => (entries ?? []).find((entry) =>
    pathKey(entry?.oldPath, caseInsensitive) === reportKey
  );
  const pngEntry = findEntry(manifest.entries);
  const webpEntry = findEntry(manifest.webpEntries);
  for (const ref of pngEntry?.refs ?? []) {
    refs.push({
      ...deepClone(ref),
      migrationKind: "placeholder",
      placeholderSource: "old",
      placeholderValue: missingAssetReplacementForRef(ref, MISSING_ASSET_PLACEHOLDER)
    });
  }
  for (const ref of webpEntry?.refs ?? []) {
    refs.push({
      ...deepClone(ref),
      migrationKind: "placeholder",
      placeholderSource: "new",
      placeholderValue: missingAssetReplacementForRef(ref, MISSING_ASSET_PLACEHOLDER)
    });
  }
  return refs;
}

export async function applyMissingPlaceholderRepairs(manifest, consistencyReport, options = {}, { onProgress, signal } = {}) {
  if (!game.user?.isGM) throw new Error("Замена отсутствующих файлов доступна только GM.");
  const currentWorldId = game.world?.id ?? null;
  if (manifest?.worldId !== currentWorldId || consistencyReport?.sourceWorldId !== currentWorldId) throw new Error("Manifest или consistency report относятся к другому миру.");
  if (consistencyReport?.sourceManifestId !== manifest?.manifestId) throw new Error("Consistency report создан для другого manifest.");

  const reportEntries = (consistencyReport.entries ?? []).filter((entry) => entry.placeholderAuthorized === true && !entry.wildcard);
  const entries = reportEntries
    .map((entry) => ({ oldPath: entry.oldPath, newPath: entry.newPath, wildcard: false, refs: placeholderRefsForEntry(manifest, entry) }))
    .filter((entry) => entry.refs.length > 0);
  if (!entries.length) throw new Error("В отчете нет подтвержденных отсутствующих файлов для замены на заглушку.");

  const writeOptions = normalizedWriteOptions(options);
  const { results } = await processDocumentTasks(entries, writeOptions, false, { onProgress, signal });
  const repaired = [];
  const skipped = [];
  for (const entry of entries) {
    const item = entryResultSummary(entry, results, "missing-to-placeholder");
    (item.complete ? repaired : skipped).push(item);
  }

  const changedRefs = results
    .filter((result) => result.status === "changed" && result.ref && validateReference(result.ref))
    .map((result) => ({ ...deepClone(result.ref), appliedDirection: "placeholder" }));
  const issues = results
    .filter((result) => ["error", "skipped", "stale", "lock-restore-error"].includes(result.status))
    .map((result) => ({
      oldPath: result.entryOldPath,
      uuid: result.ref?.uuid,
      fieldLabel: result.ref?.fieldLabel,
      pack: result.pack,
      status: result.status,
      direction: "missing-to-placeholder",
      error: result.error
    }));

  return {
    type: "fbl-webp-migrator-migration-report",
    schemaVersion: REPORT_SCHEMA_VERSION,
    version: manifest.version,
    createdAt: new Date().toISOString(),
    sourceManifestId: manifest.manifestId,
    sourceDataRootId: consistencyReport.dataRootId ?? null,
    worldId: manifest.worldId,
    worldTitle: manifest.worldTitle,
    options: { ...writeOptions, consistencyRepair: true, missingAssetPlaceholder: MISSING_ASSET_PLACEHOLDER, imageHoverSpecificArtFallback: IMAGE_HOVER_SPECIFIC_ART_SENTINEL },
    summary: {
      inputEntries: entries.length,
      fullyMigratedPngPaths: 0,
      consistencyForwardPaths: 0,
      consistencyReversePaths: 0,
      consistencyPlaceholderPaths: repaired.length,
      cleanupEligibleFiles: 0,
      skippedPngPaths: skipped.length,
      changedReferences: changedRefs.length,
      alreadyMigratedReferences: results.filter((result) => result.status === "already").length,
      staleReferences: results.filter((result) => result.status === "stale").length,
      errors: results.filter((result) => result.status === "error" || result.status === "skipped").length,
      lockRestoreErrors: results.filter((result) => result.status === "lock-restore-error").length
    },
    migrated: repaired,
    cleanupFiles: [],
    skipped,
    changedRefs,
    issues,
    consistencySummary: sanitizeJsonValue(consistencyReport.summary)
  };
}



function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === "function") return [...collection.values()];
  if (Symbol.iterator in Object(collection)) return [...collection];
  return [];
}

function imageHoverLegacyRecoveryRef(document, root, pack, fieldPath) {
  const oldPath = normalizePhysicalPath(IMAGE_HOVER_SPECIFIC_ART_SENTINEL);
  const newPath = normalizeWebpPhysicalPath(IMAGE_HOVER_SPECIFIC_ART_SENTINEL_WEBP);
  return {
    uuid: document.uuid,
    documentId: document.id,
    documentName: document.documentName,
    documentLabel: document.name ?? document.label ?? document.id,
    rootUuid: root.uuid,
    rootDocumentName: root.documentName,
    rootLabel: root.name ?? root.label ?? root.id,
    pack: pack?.collection ?? document.pack ?? null,
    packTitle: pack?.title ?? null,
    packageType: pack ? getPackPackageType(pack) : "world",
    sourceFormat: "png",
    mode: "exact",
    fieldPath: [...fieldPath],
    fieldLabel: fieldPath.map(String).join("."),
    rootField: fieldPath[0],
    oldValue: IMAGE_HOVER_SPECIFIC_ART_SENTINEL,
    newValue: IMAGE_HOVER_SPECIFIC_ART_SENTINEL_WEBP,
    oldPath,
    newPath,
    migrationKind: "placeholder",
    placeholderSource: "old",
    // 0.4.2/0.4.3 used this generic value by mistake. Running the
    // reconstructed operation in reverse safely restores Image Hover's sentinel.
    placeholderValue: MISSING_ASSET_PLACEHOLDER
  };
}

function imageHoverEmbeddedRootFields(document) {
  const fields = new Set(FALLBACK_EMBEDDED_FIELDS[document?.documentName] ?? []);
  const embedded = document?.constructor?.metadata?.embedded;
  if (embedded && typeof embedded === "object") {
    for (const value of Object.values(embedded)) {
      if (typeof value === "string" && value) fields.add(value);
    }
  }
  return fields;
}

function isImageHoverSpecificArtPath(fieldPath) {
  if (!Array.isArray(fieldPath) || fieldPath.length < 3) return false;
  const offset = fieldPath.length - 3;
  return fieldPath[offset] === "flags"
    && fieldPath[offset + 1] === "image-hover"
    && fieldPath[offset + 2] === "specificArt";
}

function collectImageHoverRefsFromDocument(document, root, pack = null) {
  const source = document?.toObject?.(true);
  if (!source || typeof source !== "object") return [];
  const refs = [];
  const seenObjects = new WeakSet();
  const skipRootFields = imageHoverEmbeddedRootFields(document);

  const walk = (value, fieldPath) => {
    if (typeof value === "string") {
      if (value === MISSING_ASSET_PLACEHOLDER && isImageHoverSpecificArtPath(fieldPath)) {
        refs.push(imageHoverLegacyRecoveryRef(document, root, pack, fieldPath));
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) walk(value[index], [...fieldPath, index]);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      // Embedded documents are traversed as their own Documents. Skipping the
      // root collection here avoids duplicate refs and, more importantly, avoids
      // trying to write array-index paths such as Scene.tokens.0.flags....
      if (fieldPath.length === 0 && skipRootFields.has(key)) continue;
      walk(child, [...fieldPath, key]);
    }
  };

  walk(source, []);
  return refs;
}

function collectImageHoverRefsFromRoot(root, pack = null) {
  const refs = [];
  for (const document of iterateDocumentTree(root)) {
    refs.push(...collectImageHoverRefsFromDocument(document, root, pack));
  }
  return refs;
}

async function collectImageHoverLegacyPlaceholderRefs(options = {}, { onProgress, signal } = {}) {
  const refs = [];

  // This is a recovery operation for damage created by 0.4.2/0.4.3, not a
  // normal scoped scan. Always inspect every world Actor and Scene so a stale
  // checkbox cannot leave some damaged tokens behind.
  const worldRoots = [
    ...collectionValues(game.actors),
    ...collectionValues(game.scenes)
  ];
  for (let index = 0; index < worldRoots.length; index += 1) {
    if (signal?.aborted) throw new DOMException("Операция отменена.", "AbortError");
    const root = worldRoots[index];
    refs.push(...collectImageHoverRefsFromRoot(root));
    onProgress?.({
      phase: "scan",
      current: index + 1,
      total: worldRoots.length,
      label: root.name ?? root.id
    });
    if (index % 20 === 19) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // World Actor/Scene packs are also user-owned data and may have been damaged
  // by the old placeholder repair. Always include them. Package packs remain
  // opt-in because they belong to modules/systems and may be overwritten by an
  // update of that package.
  const includePackagePacks = options.packageCompendiums === true;
  const packs = collectionValues(game.packs).filter((pack) => {
    if (pack?.documentName !== "Actor" && pack?.documentName !== "Scene") return false;
    const type = getPackPackageType(pack);
    return type === "world" || ((type === "module" || type === "system") && includePackagePacks);
  });

  for (let packIndex = 0; packIndex < packs.length; packIndex += 1) {
    if (signal?.aborted) throw new DOMException("Операция отменена.", "AbortError");
    const pack = packs[packIndex];
    const documents = await pack.getDocuments();
    for (let documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
      if (signal?.aborted) throw new DOMException("Операция отменена.", "AbortError");
      refs.push(...collectImageHoverRefsFromRoot(documents[documentIndex], pack));
      if (documentIndex % 20 === 19) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    onProgress?.({ phase: "pack", current: packIndex + 1, total: packs.length, label: pack.title ?? pack.collection });
  }

  // The same field can surface through unusual system traversal APIs more than
  // once. Deduplicate by actual document UUID + exact field path before writing.
  const unique = new Map();
  for (const ref of refs) {
    const key = `${ref.uuid}|${JSON.stringify(ref.fieldPath)}`;
    if (!unique.has(key)) unique.set(key, ref);
  }
  return [...unique.values()];
}

export async function repairImageHoverSpecificArtOverrides(options = {}, { onProgress, signal } = {}) {
  if (!game.user?.isGM) throw new Error("Исправление Image Hover доступно только GM.");
  const refs = await collectImageHoverLegacyPlaceholderRefs(options, { onProgress, signal });
  if (!refs.length) {
    return { scannedReferences: 0, changed: 0, already: 0, stale: 0, errors: 0, lockRestoreErrors: 0, issues: [] };
  }

  const entry = {
    oldPath: IMAGE_HOVER_SPECIFIC_ART_SENTINEL,
    newPath: IMAGE_HOVER_SPECIFIC_ART_SENTINEL_WEBP,
    wildcard: false,
    refs
  };
  const writeOptions = normalizedWriteOptions(options);
  const { results } = await processDocumentTasks([entry], writeOptions, true, { onProgress, signal });
  return {
    scannedReferences: refs.length,
    changed: results.filter((result) => result.status === "changed").length,
    already: results.filter((result) => result.status === "already").length,
    stale: results.filter((result) => result.status === "stale").length,
    errors: results.filter((result) => result.status === "error" || result.status === "skipped").length,
    lockRestoreErrors: results.filter((result) => result.status === "lock-restore-error").length,
    issues: results.filter((result) => !["changed", "already"].includes(result.status))
  };
}
