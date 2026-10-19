import {
  PENDING_RELOCKS_SETTING,
  MISSING_ASSET_PLACEHOLDER,
  REPORT_SCHEMA_VERSION,
  SUCCESS_STATUSES,
  VERIFIED_CONVERSION_STATUSES
} from "./constants.mjs";
import {
  createId,
  deepClone,
  getAtPath,
  globToRegExp,
  isFoundryCorePublicAssetReference,
  isSafePathSegments,
  findRichPngReferences,
  findRichWebpReferences,
  normalizePhysicalPath,
  normalizePngFilePath,
  normalizeWebpFilePath,
  toWebpFilePath,
  normalizeWebpPhysicalPath,
  replaceTextReference,
  sanitizeJsonValue,
  setAtPath,
  toWebpReference
} from "./path-utils.mjs";
import { getPackPackageType } from "./scanner.mjs";
import { isAllowedPlaceholderValue } from "./compatibility.mjs";

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

function parseRootUuid(uuid) {
  if (!uuid || typeof uuid !== "string") return null;
  const parts = uuid.split(".");
  if (parts[0] === "Compendium") {
    if (parts.length !== 5 || !parts[1] || !parts[2] || !parts[3] || !parts[4]) return null;
    return {
      uuid,
      pack: `${parts[1]}.${parts[2]}`,
      documentName: parts[3],
      id: parts[4],
      compendium: true
    };
  }
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { uuid, pack: null, documentName: parts[0], id: parts[1], compendium: false };
}

function deriveRootUuid(uuid) {
  if (!uuid || typeof uuid !== "string") return null;
  const parts = uuid.split(".");
  if (parts[0] === "Compendium") {
    if (parts.length < 5) return null;
    return parts.slice(0, 5).join(".");
  }
  if (parts.length < 2) return null;
  return parts.slice(0, 2).join(".");
}

function embeddedChain(rootUuid, targetUuid) {
  if (rootUuid === targetUuid) return [];
  if (!targetUuid?.startsWith(`${rootUuid}.`)) return null;
  const suffix = targetUuid.slice(rootUuid.length + 1).split(".");
  if (!suffix.length || suffix.length % 2 !== 0) return null;
  const chain = [];
  for (let index = 0; index < suffix.length; index += 2) {
    if (!suffix[index] || !suffix[index + 1]) return null;
    chain.push({ documentName: suffix[index], id: suffix[index + 1] });
  }
  return chain;
}

async function resolveRootDocument(ref, { fresh = false } = {}) {
  const declaredRoot = typeof ref?.rootUuid === "string" ? ref.rootUuid : null;
  const declaredInfo = parseRootUuid(declaredRoot);
  const declaredMatches = !!declaredInfo && (ref?.uuid === declaredRoot || ref?.uuid?.startsWith(`${declaredRoot}.`));
  const rootUuid = declaredMatches ? declaredRoot : deriveRootUuid(ref?.uuid);
  const rootInfo = parseRootUuid(rootUuid);
  if (!rootInfo) throw new Error(`Некорректный root UUID: ${rootUuid ?? ref?.uuid ?? "unknown"}`);

  if (rootInfo.compendium) {
    const collection = typeof ref?.pack === "string" ? ref.pack : rootInfo.pack;
    if (collection !== rootInfo.pack) throw new Error(`UUID и pack не совпадают: ${rootUuid}`);
    const pack = game.packs?.get?.(collection) ?? null;
    if (!pack) return { root: null, pack: null, rootUuid, rootInfo };

    let root = null;
    if (fresh && typeof pack.getDocuments === "function") {
      const documents = await pack.getDocuments({ _id__in: [rootInfo.id] });
      root = documents?.find?.((document) => document?.id === rootInfo.id) ?? null;
    } else if (typeof pack.getDocument === "function") {
      root = await pack.getDocument(rootInfo.id);
    } else {
      root = pack.get?.(rootInfo.id) ?? null;
    }
    return { root, pack, rootUuid, rootInfo };
  }

  const root = await (globalThis.fromUuid?.(rootUuid) ?? null);
  return { root, pack: null, rootUuid, rootInfo };
}

function getEmbeddedDocumentSafe(parent, documentName, id) {
  if (!parent) return null;
  if (typeof parent.getEmbeddedDocument === "function") {
    try {
      const document = parent.getEmbeddedDocument(documentName, id, { invalid: true });
      if (document) return document;
    } catch {
      // Fall through to a traversal lookup for systems with unusual embedded metadata.
    }
  }
  try {
    if (typeof parent.traverseEmbeddedDocuments === "function") {
      for (const yielded of parent.traverseEmbeddedDocuments()) {
        const document = Array.isArray(yielded) ? yielded[1] : (yielded?.document ?? yielded);
        if (document?.documentName === documentName && document?.id === id && document?.parent === parent) return document;
      }
    }
  } catch {
    // A missing embedded document is handled by the caller as an ordinary resolution failure.
  }
  return null;
}

async function resolveReferenceContext(ref, { fresh = false } = {}) {
  const rootResult = await resolveRootDocument(ref, { fresh });
  const { root, pack, rootUuid } = rootResult;
  if (!root) return { ...rootResult, target: null, parent: null, source: null, kind: "missing" };

  const chain = embeddedChain(rootUuid, ref.uuid);
  if (chain == null) throw new Error(`UUID ${ref.uuid} не принадлежит root document ${rootUuid}.`);
  if (!chain.length) {
    return { ...rootResult, target: root, parent: null, source: root.toObject(true), kind: "document" };
  }

  let current = root;
  let parent = null;
  for (let index = 0; index < chain.length; index += 1) {
    const part = chain[index];
    const isLast = index === chain.length - 1;

    // ActorDelta is a special direct child of TokenDocument. Foundry recommends
    // bulk/system migrations write the Token's `delta` property through the Scene
    // rather than issuing direct ActorDelta database updates. This is especially
    // important for Tokens stored inside Compendium Scenes.
    if (isLast && part.documentName === "ActorDelta" && current?.documentName === "Token") {
      const tokenSource = current.toObject(true);
      const delta = tokenSource?.delta;
      const deltaId = delta?._id ?? null;
      if (deltaId && deltaId !== part.id) return { ...rootResult, target: null, parent: current, source: null, kind: "missing" };
      return {
        ...rootResult,
        target: null,
        parent: current,
        token: current,
        tokenParent: current.parent ?? parent,
        source: delta && typeof delta === "object" ? deepClone(delta) : {},
        kind: "actor-delta",
        actorDeltaId: part.id
      };
    }

    parent = current;
    current = getEmbeddedDocumentSafe(current, part.documentName, part.id);
    if (!current) return { ...rootResult, target: null, parent, source: null, kind: "missing" };
  }

  return { ...rootResult, target: current, parent, source: current.toObject(true), kind: "embedded" };
}

async function updateReferenceContext(context, updateData) {
  const operation = { diff: true, recursive: true, render: false };
  if (context.kind === "actor-delta") {
    const token = context.token;
    const scene = context.tokenParent;
    if (!token?.id || !scene || typeof scene.updateEmbeddedDocuments !== "function") {
      throw new Error("ActorDelta не может быть безопасно обновлен через родительский Token/Scene.");
    }
    const tokenUpdate = { _id: token.id };
    for (const [key, value] of Object.entries(updateData)) tokenUpdate[`delta.${key}`] = value;
    await scene.updateEmbeddedDocuments("Token", [tokenUpdate], operation);
    return;
  }

  if (context.kind === "embedded") {
    const target = context.target;
    const parent = context.parent;
    if (!target?.id || !target?.documentName || !parent || typeof parent.updateEmbeddedDocuments !== "function") {
      throw new Error("Embedded document не может быть безопасно обновлен через родительский Document.");
    }
    await parent.updateEmbeddedDocuments(target.documentName, [{ _id: target.id, ...updateData }], operation);
    return;
  }

  if (context.kind === "document" && context.target?.update) {
    await context.target.update(updateData, operation);
    return;
  }
  throw new Error("Документ не поддерживает безопасное обновление.");
}

export function referenceKey(ref) {
  const placeholder = ref?.migrationKind === "placeholder"
    ? `|placeholder|${ref.placeholderSource}|${ref.placeholderValue}`
    : "";
  return `${ref.uuid}|${JSON.stringify(ref.fieldPath)}|${ref.mode}|${ref.oldValue}|${ref.newValue}${placeholder}`;
}

function validateStandardReferenceShape(ref) {
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
    && normalizePngFilePath(ref.oldPath) === ref.oldPath
    && normalizeWebpFilePath(ref.newPath) === ref.newPath
    && toWebpFilePath(ref.oldPath) === ref.newPath;
}

export function validateReference(ref) {
  if (!validateStandardReferenceShape(ref)) return false;
  if (ref.migrationKind == null) return true;
  return ref.migrationKind === "placeholder"
    && (ref.placeholderSource === "old" || ref.placeholderSource === "new")
    && isAllowedPlaceholderValue(ref, ref.placeholderValue, MISSING_ASSET_PLACEHOLDER);
}

export function isCorePublicPlaceholderReference(ref) {
  if (!validateReference(ref) || ref.appliedDirection !== "placeholder" || ref.migrationKind !== "placeholder") return false;
  const originalValue = ref.placeholderSource === "new" ? ref.newValue : ref.oldValue;
  return isFoundryCorePublicAssetReference(originalValue);
}

export function countCorePublicPlaceholderReferences(report) {
  return (report?.changedRefs ?? []).filter(isCorePublicPlaceholderReference).length;
}

export function withoutCorePublicPlaceholderReferences(report) {
  if (!report || typeof report !== "object") return report;
  const changedRefs = (report.changedRefs ?? []).filter((ref) => !isCorePublicPlaceholderReference(ref));
  return {
    ...deepClone(report),
    changedRefs,
    textChanges: sanitizeTextChanges(report.textChanges).filter((change) => !change.operations.every(({ ref }) =>
      isCorePublicPlaceholderReference({ ...ref, appliedDirection: "placeholder" }))),
    summary: {
      ...deepClone(report.summary ?? {}),
      changedReferences: changedRefs.length
    }
  };
}

function validNumber(value, { minimum = 0 } = {}) {
  return Number.isFinite(value) && value >= minimum ? value : null;
}

function validDimension(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function patternMatches(pattern, value, caseInsensitive = false) {
  try {
    return globToRegExp(pattern, { caseInsensitive }).test(value);
  } catch {
    return false;
  }
}

function sanitizeConcreteFile(input, sourceEntry, caseInsensitive = false) {
  if (!input || typeof input !== "object") return null;
  const oldPath = normalizePngFilePath(input.oldPath);
  const newPath = normalizeWebpFilePath(input.newPath);
  if (!oldPath || !newPath || /[*?]/.test(oldPath) || /[*?]/.test(newPath)) return null;
  if (toWebpFilePath(oldPath) !== newPath) return null;
  if (sourceEntry.wildcard) {
    if (!patternMatches(sourceEntry.oldPath, oldPath, caseInsensitive) || !patternMatches(sourceEntry.newPath, newPath, caseInsensitive)) return null;
  } else if (oldPath !== sourceEntry.oldPath || newPath !== sourceEntry.newPath) return null;

  let status = normalizeStatus(input.status);
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
  const evidenceComplete = fingerprintsComplete && dimensionsMatch && !sourceAnimated
    && newSize > 0 && validNumber(input.newMtimeMs) != null
    && (status === "exists-missing-old" || (oldSize > 0 && validNumber(input.oldMtimeMs) != null))
    && input.decoderVerified === true;
  if (CONCRETE_SUCCESS_STATUSES.has(status) && !evidenceComplete) status = "failed";
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
    decoderVerified: input.decoderVerified === true,
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
  if (report.dryRun === true) throw new Error("Это dry-run conversion report. Он предназначен только для предварительного просмотра; запусти конвертацию без --dry-run и импортируй новый report.");
  if (!manifest.manifestId) throw new Error("Manifest устарел и не содержит manifestId. Выполни новое сканирование.");
  if (report.sourceManifestId !== manifest.manifestId) throw new Error("Conversion report создан для другого manifest. Импорт отклонён.");
  if (manifest.worldId !== currentWorldId || report.sourceWorldId !== currentWorldId) throw new Error("Manifest или conversion report относятся к другому миру.");

  if (!(Number(report.schemaVersion) >= 5)) throw new Error("Conversion report устарел. Повтори конвертацию или проверку инструментом 0.4.8+ с декодированием файлов.");
  if (!DATA_ROOT_ID_RE.test(String(report.dataRootId ?? ""))) throw new Error("Conversion report не содержит корректной привязки к Foundry Data root.");
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
      ? input.files.map((file) => sanitizeConcreteFile(file, source, report.caseInsensitivePaths === true)).filter(Boolean)
      : [];
    const status = files.length === input.files?.length ? aggregateSanitizedStatus(files) : "failed";
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
    caseInsensitivePaths: report.caseInsensitivePaths === true,
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

function referenceOperationValues(ref, reverse = false) {
  let source;
  let target;
  if (ref?.migrationKind === "placeholder") {
    source = ref.placeholderSource === "new" ? ref.newValue : ref.oldValue;
    target = ref.placeholderValue;
  } else {
    source = ref.oldValue;
    target = ref.newValue;
  }
  return reverse ? { source: target, target: source } : { source, target };
}

function replaceReference(current, ref, reverse = false) {
  const { source: oldValue, target: newValue } = referenceOperationValues(ref, reverse);
  if (oldValue === newValue) return { status: "stale", value: current };
  if (ref.mode === "exact") {
    if (current === oldValue) return { status: "changed", value: newValue };
    if (current === newValue) return { status: "already", value: current };
    return { status: "stale", value: current };
  }
  return replaceTextReference(current, oldValue, newValue);
}

function verifyReference(source, ref, reverse = false) {
  const { source: opposite, target: expected } = referenceOperationValues(ref, reverse);
  const current = getAtPath(source, ref.fieldPath);
  if (ref?.migrationKind === "placeholder") {
    if (ref.mode === "exact") return current === expected;
    if (typeof current !== "string") return false;
    const expectedPresent = replaceTextReference(current, expected, opposite).status === "changed";
    const oppositePresent = replaceTextReference(current, opposite, expected).status === "changed";
    return expectedPresent && !oppositePresent;
  }

  const expectedPath = reverse ? ref.oldPath : ref.newPath;
  const oppositePath = reverse ? ref.newPath : ref.oldPath;
  if (ref.mode === "exact") {
    if (current === expected) return true;
    const normalized = reverse ? normalizePhysicalPath(current) : normalizeWebpPhysicalPath(current);
    return normalized === expectedPath;
  }
  if (replaceTextReference(current, opposite, expected).status === "changed") return false;
  if (replaceTextReference(current, expected, opposite).status === "changed") return true;
  if (typeof current !== "string") return false;
  const expectedCandidates = reverse ? findRichPngReferences(current) : findRichWebpReferences(current);
  const oppositeCandidates = reverse ? findRichWebpReferences(current) : findRichPngReferences(current);
  const paths = expectedCandidates.map((value) => reverse ? normalizePhysicalPath(value) : normalizeWebpPhysicalPath(value)).filter(Boolean);
  const oppositePaths = oppositeCandidates.map((value) => reverse ? normalizeWebpPhysicalPath(value) : normalizePhysicalPath(value)).filter(Boolean);
  return paths.includes(expectedPath) && !oppositePaths.includes(oppositePath);
}

// Rollback must match the actual saved value when Foundry cleaned an exact
// reference. Re-check its path so imported metadata cannot redirect the write.
function replaceRollbackReference(source, ref, reverse) {
  const current = getAtPath(source, ref.fieldPath);
  if (ref.mode === "text") return { status: "stale", value: current };
  if (verifyReference(source, ref, reverse)) return { status: "already", value: current };
  if (current === ref.savedValue && verifyReference(source, ref, !reverse)) {
    return { status: "changed", value: referenceOperationValues(ref, reverse).target };
  }
  return replaceReference(current, ref, reverse);
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

function updatePathFor(source, segments) {
  for (let index = 1; index < segments.length; index += 1) {
    if (Array.isArray(getAtPath(source, segments.slice(0, index)))) return segments.slice(0, index);
  }
  return segments;
}

function textFieldKey(ref) {
  return `${ref.uuid}|${JSON.stringify(ref.fieldPath)}`;
}

function sanitizeTextChanges(changes) {
  const output = [];
  const seen = new Set();
  for (const input of Array.isArray(changes) ? changes : []) {
    if (typeof input?.id !== "string" || seen.has(input.id) || typeof input.before !== "string"
      || typeof input.after !== "string" || input.before === input.after
      || !Array.isArray(input.operations) || !input.operations.length) continue;
    const ref = input.operations[0]?.ref;
    let value = input.before;
    let valid = true;
    for (const operation of input.operations) {
      if (!validateReference(operation.ref) || operation.ref.mode !== "text"
        || textFieldKey(operation.ref) !== textFieldKey(ref)) { valid = false; break; }
      const result = replaceReference(value, operation.ref, operation.reverse === true);
      if (result.status !== "changed") { valid = false; break; }
      value = result.value;
    }
    if (!valid || value !== input.after) continue;
    seen.add(input.id);
    output.push(deepClone(input));
  }
  return output;
}

// Invalidate cleanup before rollback starts, including partial/cancelled runs.
export function revokeCleanupAuthorization(report) {
  if (!report) return report;
  report.cleanupFiles = [];
  report.cleanupRevoked = true;
  if (report.summary) report.summary.cleanupEligibleFiles = 0;
  for (const item of report.migrated ?? []) item.cleanupEligibleFiles = 0;
  return report;
}

async function yieldToBrowser() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function processDocumentTasks(entries, options, reverse, { onProgress, signal, textRestore = null, rollbackWithoutSnapshots = false } = {}) {
  const { byUuid, results, expectedByEntry } = collectTasks(entries);
  const unlockedPacks = new Map();
  const groups = [...byUuid.entries()];
  const textChanges = [];
  const unverifiedWrites = [];
  let cancelled = false;

  try {
    for (let index = 0; index < groups.length; index += 1) {
      if (signal?.aborted) {
        cancelled = true;
        for (const [, remaining] of groups.slice(index)) {
          for (const task of remaining) results.push({ ...task.resultBase, status: "skipped", error: "Операция отменена до записи документа." });
        }
        break;
      }
      const [uuid, tasks] = groups[index];
      const firstRef = tasks[0]?.ref;
      let context;
      try {
        context = await resolveReferenceContext(firstRef);
      } catch (error) {
        for (const task of tasks) results.push({ ...task.resultBase, status: "error", error: error?.message ?? String(error) });
        continue;
      }
      if (!context?.source) {
        for (const task of tasks) results.push({ ...task.resultBase, status: "error", error: `Документ не найден: ${uuid}` });
        continue;
      }

      const labelDocument = context.kind === "actor-delta" ? context.token : context.target;
      try { onProgress?.({ current: index + 1, total: groups.length, label: labelDocument?.name ?? labelDocument?.id ?? uuid }); }
      catch (error) { console.warn("FBL WebP Migrator | Progress callback failed", error); }
      const pack = context.pack ?? getPack(context.root ?? context.target);
      if (pack && !isWorldPack(pack) && !options.allowPackageCompendiumWrites) {
        for (const task of tasks) results.push({
          ...task.resultBase,
          status: "skipped",
          error: `Package compendium ${pack.collection} доступен только для чтения по текущим настройкам.`
        });
        continue;
      }
      let writable = true;
      try { if (pack) writable = await unlockPackIfNeeded(pack, options, unlockedPacks); }
      catch (error) {
        for (const task of tasks) results.push({ ...task.resultBase, status: "error", error: error?.message ?? String(error) });
        continue;
      }
      if (!writable) {
        for (const task of tasks) results.push({
          ...task.resultBase,
          status: "skipped",
          error: `Compendium ${pack.collection} заблокирован. Module/system packs автоматически не разблокируются.`
        });
        continue;
      }

      // Unlocking a pack can await a server round trip; refresh the source before
      // copying arrays so changes made during that wait are preserved.
      try { context = await resolveReferenceContext(firstRef, { fresh: true }); }
      catch (error) {
        for (const task of tasks) results.push({ ...task.resultBase, status: "error", error: error?.message ?? String(error) });
        continue;
      }
      if (!context?.source) {
        for (const task of tasks) results.push({ ...task.resultBase, status: "error", error: "Document disappeared before update." });
        continue;
      }
      if (signal?.aborted) { index -= 1; continue; }
      const working = deepClone(context.source);
      const stagedText = new Map();
      const updatePaths = new Map();
      const updateData = {};
      const pending = [];

      for (const task of tasks) {
        const current = getAtPath(working, task.ref.fieldPath);
        const replacement = textRestore
          ? { status: current === textRestore.before || textRestore.earlierValues?.includes(current)
            ? "already" : current === textRestore.after ? "changed" : "stale", value: textRestore.before }
          : (rollbackWithoutSnapshots
            ? replaceRollbackReference(working, task.ref, reverse)
            : replaceReference(current, task.ref, reverse));
        if (replacement.status === "already") {
          results.push({ ...task.resultBase, status: "already" });
          continue;
        }
        if (replacement.status !== "changed") {
          results.push({
            ...task.resultBase,
            status: "stale",
            error: rollbackWithoutSnapshots && task.ref.mode === "text"
              ? "Без исходного снимка текста безопасный откат неоднозначен. Используй резервную копию или восстанови поле вручную."
              : "Поле изменилось после сканирования или больше не содержит ожидаемый путь."
          });
          continue;
        }
        try {
          const updatePath = updatePathFor(working, task.ref.fieldPath);
          const updateKey = fieldPathToUpdateKey(updatePath);
          if (!updateKey) {
            results.push({
              ...task.resultBase,
              status: "skipped",
              error: "Поле содержит точку в имени сегмента и не может быть безопасно обновлено leaf-path операцией."
            });
            continue;
          }
          setAtPath(working, task.ref.fieldPath, replacement.value);
          updatePaths.set(updateKey, updatePath);
          if (task.ref.mode === "text" && !textRestore) {
            const key = textFieldKey(task.ref);
            if (!stagedText.has(key)) stagedText.set(key, { id: createId(), before: current, after: replacement.value, operations: [] });
            const change = stagedText.get(key);
            change.after = replacement.value;
            change.operations.push({ ref: deepClone(task.ref), reverse: reverse === true });
          }
          const result = { ...task.resultBase, status: "pending" };
          pending.push(result);
          results.push(result);
        } catch (error) {
          results.push({ ...task.resultBase, status: "error", error: error?.message ?? String(error) });
        }
      }

      if (!pending.length) continue;
      for (const [key, segments] of updatePaths) updateData[key] = deepClone(getAtPath(working, segments));

      let writeError = null;
      try {
        await updateReferenceContext(context, updateData);
      } catch (error) {
        writeError = error;
      }

      // Never verify against the pre-update embedded instance. Compendium
      // descendants in particular can remain stale in memory even after the
      // database write succeeded. Re-read the root document, then traverse the
      // newly loaded hierarchy before deciding whether a mutation is rollbackable.
      await yieldToBrowser();
      let verifiedContext = null;
      let verificationError = null;
      try {
        verifiedContext = await resolveReferenceContext(firstRef, { fresh: true });
      } catch (error) {
        verificationError = error;
      }

      // A thrown update can still have reached the database before a later hook
      // failed. Fresh verification is authoritative: if the expected value is
      // present, record the change so rollback history is never lost.
      const updatedSource = verifiedContext?.source ?? null;
      for (const change of stagedText.values()) {
        const ref = change.operations[0].ref;
        if (updatedSource && getAtPath(updatedSource, ref.fieldPath) === change.after) textChanges.push(change);
      }
      const arraysIntact = updatedSource && [...updatePaths.values()].every((segments) => {
        const staged = getAtPath(working, segments);
        if (!Array.isArray(staged)) return true;
        const observed = deepClone(getAtPath(updatedSource, segments));
        if (!Array.isArray(observed)) return false;
        for (const { ref } of pending) {
          const leaf = ref.fieldPath;
          if (ref.mode !== "exact" || leaf.length <= segments.length
            || !segments.every((segment, index) => leaf[index] === segment)) continue;
          // Only verified exact asset leaves may differ after Foundry cleaning.
          // Text snapshots and every sibling element/field must match exactly.
          if (verifyReference(updatedSource, ref, reverse)) {
            setAtPath(observed, leaf.slice(segments.length), getAtPath(working, leaf));
          }
        }
        return JSON.stringify(observed) === JSON.stringify(staged);
      });
      for (const pendingResult of pending) {
        if (arraysIntact && (textRestore
          ? getAtPath(updatedSource, pendingResult.ref.fieldPath) === textRestore.before
          : verifyReference(updatedSource, pendingResult.ref, reverse))) {
          pendingResult.status = "changed";
          if (!rollbackWithoutSnapshots && pendingResult.ref.mode === "exact") {
            const saved = getAtPath(updatedSource, pendingResult.ref.fieldPath);
            if (saved !== referenceOperationValues(pendingResult.ref, reverse).target) pendingResult.ref.savedValue = saved;
          }
          if (writeError) pendingResult.warning = `Foundry сообщил ошибку после записи: ${writeError?.message ?? String(writeError)}`;
          continue;
        }

        unverifiedWrites.push({ ref: deepClone(pendingResult.ref),
          before: getAtPath(context.source, pendingResult.ref.fieldPath),
          intended: getAtPath(working, pendingResult.ref.fieldPath),
          observed: updatedSource ? getAtPath(updatedSource, pendingResult.ref.fieldPath) : null });
        pendingResult.status = "error";
        if (verificationError) {
          pendingResult.error = `Не удалось перечитать документ после записи: ${verificationError?.message ?? String(verificationError)}`;
        } else if (!updatedSource) {
          pendingResult.error = "Документ не удалось перечитать после записи; изменение не считается подтвержденным.";
        } else if (writeError) {
          pendingResult.error = writeError?.message ?? String(writeError);
        } else {
          const current = getAtPath(updatedSource, pendingResult.ref.fieldPath);
          const original = referenceOperationValues(pendingResult.ref, reverse).source;
          const stillOriginal = current === original;
          pendingResult.error = stillOriginal
            ? "Foundry принял операцию без ошибки, но сохраненное значение осталось прежним."
            : (reverse
              ? "Откат применился, но свежеперечитанное значение не прошло проверку."
              : "Документ обновился, но свежеперечитанное значение не прошло проверку.");
        }
      }

      if (index % 10 === 9) await yieldToBrowser();
    }
  } finally {
    const lockIssues = await restorePackLocks(unlockedPacks);
    for (const issue of lockIssues) results.push({ entryOldPath: null, entryNewPath: null, ref: null, ...issue });
  }

  return { results, expectedByEntry, textChanges, unverifiedWrites, cancelled: cancelled || signal?.aborted === true };
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
  const { results, expectedByEntry, textChanges, unverifiedWrites, cancelled } = await processDocumentTasks(entries, normalizedOptions, false, { onProgress, signal });

  const migrated = [];
  const skipped = [];
  const cleanupFiles = [];
  const cleanupDedupe = new Set();

  const fullyHandledPaths = new Set(entries.filter((entry) => {
    const relevant = resultForEntry(results, entry.oldPath).filter((result) => result.ref);
    const expected = expectedByEntry.get(entry.oldPath)?.size ?? 0;
    return expected > 0 && relevant.length === expected && relevant.every((result) => ["changed", "already"].includes(result.status));
  }).map((entry) => entry.oldPath));
  const cleanupSafe = (file) => !manifest.summary?.skippedSources && !(manifest.skipped?.length)
    && (manifest.entries ?? []).every((entry) => !patternMatches(entry.oldPath, file.oldPath, conversionReport.caseInsensitivePaths === true)
      || fullyHandledPaths.has(entry.oldPath));
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
        if (!file.cleanupEligible || !cleanupSafe(file)) continue;
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
  const selectedPaths = new Set(entries.map((entry) => entry.oldPath));
  for (const entry of manifest.entries ?? []) {
    if (selectedPaths.has(entry.oldPath)) continue;
    skipped.push({ oldPath: entry.oldPath, newPath: entry.newPath, wildcard: !!entry.wildcard,
      refCount: entry.refs?.length ?? 0, changed: 0, already: 0, stale: 0, errors: 0, cleanupEligibleFiles: 0,
      reason: "Conversion evidence did not authorize this path. Existing cleanup permissions are revoked." });
  }

  const changedRefs = results
    .filter((result) => result.status === "changed")
    .map((result) => ({ ...result.ref, appliedDirection: "forward" }));
  const errorResults = results.filter((result) =>
    ["error", "skipped", "stale", "lock-restore-error"].includes(result.status) || result.warning
  );
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
    caseInsensitivePaths: conversionReport.caseInsensitivePaths === true,
    textChanges,
    unverifiedWrites,
    cancelled,
    cleanupRevoked: !!manifest.summary?.skippedSources || !!manifest.skipped?.length,
    summary: {
      inputEntries: manifest.entries?.length ?? 0,
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
      status: result.warning ? "changed-with-warning" : result.status,
      error: result.error ?? result.warning
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
      appliedDirection: input.appliedDirection === "placeholder"
        ? "placeholder"
        : input.appliedDirection === "reverse" ? "reverse" : "forward"
    });
  }
  const textChanges = sanitizeTextChanges(raw.textChanges);
  if (!changedRefs.length && !textChanges.length) throw new Error("В migration report нет допустимых ссылок для отката.");
  const cleanupRevoked = raw.cleanupRevoked === true || !(Number(raw.schemaVersion) >= 5);
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
    summary: { ...sanitizeJsonValue(raw.summary ?? {}), ...(cleanupRevoked ? { cleanupEligibleFiles: 0 } : {}) },
    migrated: Array.isArray(raw.migrated) ? sanitizeJsonValue(raw.migrated) : [],
    cleanupFiles: !cleanupRevoked && Array.isArray(raw.cleanupFiles) ? sanitizeJsonValue(raw.cleanupFiles) : [],
    skipped: Array.isArray(raw.skipped) ? sanitizeJsonValue(raw.skipped) : [],
    changedRefs,
    textChanges,
    unverifiedWrites: sanitizeJsonValue(raw.unverifiedWrites ?? []),
    cleanupRevoked,
    caseInsensitivePaths: raw.caseInsensitivePaths === true,
    issues: Array.isArray(raw.issues) ? sanitizeJsonValue(raw.issues) : []
  };
}

function mergeChangedReferences(previousRefs = [], currentRefs = []) {
  const map = new Map();
  for (const input of [...previousRefs, ...currentRefs]) {
    if (!validateReference(input)) continue;
    const ref = {
      ...deepClone(input),
      appliedDirection: input.appliedDirection === "placeholder"
        ? "placeholder"
        : input.appliedDirection === "reverse" ? "reverse" : "forward"
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
    if ((ref?.appliedDirection === "reverse" || ref?.appliedDirection === "placeholder") && typeof ref.oldPath === "string") paths.add(ref.oldPath);
  }
  return paths;
}

export function mergeMigrationReports(previous, current) {
  if (!current) return previous ?? null;
  if (!previous) return current;
  if (previous.worldId !== current.worldId) return current;

  const changedRefs = mergeChangedReferences(previous.changedRefs, current.changedRefs);
  const textChanges = sanitizeTextChanges([...(previous.textChanges ?? []), ...(current.textChanges ?? [])]);
  const blockedCleanupPaths = [...currentReversePaths(current), ...(current.skipped ?? []).map((item) => item.oldPath)].filter(Boolean);
  const blocksFile = (file) => blockedCleanupPaths.some((pattern) =>
    patternMatches(pattern, file.oldPath, previous.caseInsensitivePaths === true || current.caseInsensitivePaths === true));
  const sourceManifestIds = [...new Set([
    ...(previous.sourceManifestIds ?? [previous.sourceManifestId]),
    ...(current.sourceManifestIds ?? [current.sourceManifestId])
  ].filter(Boolean))];

  const currentMigratedPaths = new Set((current.migrated ?? []).map((item) => item?.oldPath).filter(Boolean));
  const currentSkippedPaths = new Set((current.skipped ?? []).map((item) => item?.oldPath).filter(Boolean));
  const currentTouchedPaths = new Set([...currentMigratedPaths, ...currentSkippedPaths]);
  const reversePaths = currentReversePaths(current);

  const previousCleanup = (previous.cleanupRevoked ? [] : previous.cleanupFiles ?? []).filter((file) => {
    const manifestPath = file?.manifestOldPath ?? file?.oldPath;
    return !blocksFile(file) && !reversePaths.has(manifestPath) && !currentSkippedPaths.has(manifestPath);
  });
  const roots = [...new Set([previous.sourceDataRootId, current.sourceDataRootId].filter(Boolean))];
  const dataRootConflict = roots.length > 1;
  const currentCleanup = (current.cleanupFiles ?? []).filter((file) => {
    const manifestPath = file?.manifestOldPath ?? file?.oldPath;
    return !blocksFile(file) && !currentSkippedPaths.has(manifestPath) && !reversePaths.has(manifestPath);
  });
  const cleanupFiles = dataRootConflict || current.cleanupRevoked
    ? []
    : mergeByKey(previousCleanup, currentCleanup, cleanupFileKey);
  const sourceDataRootId = dataRootConflict ? null : (roots[0] ?? null);

  // The newest result for a path is authoritative. A later failed or partial
  // run revokes an older success and its cleanup permission; a later success
  // removes an older skipped result.
  const previousMigrated = (previous.migrated ?? []).filter((item) => !currentSkippedPaths.has(item?.oldPath));
  const migrated = mergeByKey(previousMigrated, current.migrated, (item) => item.oldPath ?? null);
  const previousSkipped = (previous.skipped ?? []).filter((item) => !currentTouchedPaths.has(item?.oldPath));
  const skipped = mergeByKey(previousSkipped, current.skipped, (item) => item.oldPath ?? null);

  const previousIssues = (previous.issues ?? []).filter((item) => !item?.oldPath || !currentTouchedPaths.has(item.oldPath));
  const issues = mergeByKey(previousIssues, current.issues, (item) => [
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

  const resultItems = [...migrated, ...skipped];
  const explicitForward = migrated.filter((item) => item?.direction === "png-to-webp").length;
  const reverse = migrated.filter((item) => item?.direction === "webp-to-png").length;
  const placeholder = migrated.filter((item) => item?.direction === "missing-to-placeholder").length;
  const forward = migrated.length - reverse - placeholder - explicitForward;
  const summary = {
    inputEntries: new Set(resultItems.map((item) => item?.oldPath).filter(Boolean)).size,
    fullyMigratedPngPaths: forward,
    consistencyForwardPaths: explicitForward,
    consistencyReversePaths: reverse,
    consistencyPlaceholderPaths: placeholder,
    cleanupEligibleFiles: cleanupFiles.length,
    skippedPngPaths: skipped.length,
    changedReferences: changedRefs.length,
    alreadyMigratedReferences: resultItems.reduce((sum, item) => sum + (Number(item?.already) || 0), 0),
    staleReferences: issues.filter((item) => item?.status === "stale").length,
    errors: issues.filter((item) => item?.status === "error" || item?.status === "skipped").length,
    lockRestoreErrors: issues.filter((item) => item?.status === "lock-restore-error").length
  };

  return {
    ...current,
    textChanges,
    unverifiedWrites: [...(previous.unverifiedWrites ?? []), ...(current.unverifiedWrites ?? [])],
    cleanupRevoked: current.cleanupRevoked === true || (previous.cleanupRevoked === true && cleanupFiles.length === 0),
    sourceManifestIds,
    sourceDataRootId,
    migrated,
    cleanupFiles,
    skipped,
    changedRefs,
    issues,
    summary
  };
}

export async function rollbackCorePublicPlaceholders(migrationReport, options = {}, hooks = {}) {
  const changedRefs = (migrationReport?.changedRefs ?? []).filter(isCorePublicPlaceholderReference);
  if (!changedRefs.length) throw new Error("В migration report нет замененных ссылок Foundry Core Data для восстановления.");
  revokeCleanupAuthorization(migrationReport);
  const textChanges = sanitizeTextChanges(migrationReport.textChanges).filter((change) =>
    change.operations.every(({ ref }) => isCorePublicPlaceholderReference({ ...ref, appliedDirection: "placeholder" })));
  const filtered = { ...deepClone(migrationReport), changedRefs, textChanges };
  const summary = await rollbackMigration(filtered, options, hooks);
  return { ...summary, matched: changedRefs.length };
}

export async function rollbackMigration(migrationReport, options = {}, { onProgress, signal } = {}) {
  if (!game.user?.isGM) throw new Error("Откат доступен только GM.");
  if (migrationReport?.worldId !== (game.world?.id ?? null)) throw new Error("Migration report относится к другому миру.");
  revokeCleanupAuthorization(migrationReport);
  const textChanges = sanitizeTextChanges(migrationReport.textChanges);
  const snapshotFields = new Set(textChanges.map((change) => textFieldKey(change.operations[0].ref)));
  const changedRefs = (migrationReport?.changedRefs ?? []).filter((ref) => ref.mode !== "text" || !snapshotFields.has(textFieldKey(ref)));
  if (!changedRefs.length && !textChanges.length) throw new Error("В migration report нет ссылок, измененных этим запуском.");

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

  const placeholderApplied = changedRefs.filter((ref) => ref.appliedDirection === "placeholder");
  const forwardApplied = changedRefs.filter((ref) => ref.appliedDirection !== "reverse" && ref.appliedDirection !== "placeholder");
  const reverseApplied = changedRefs.filter((ref) => ref.appliedDirection === "reverse");
  const results = [];
  for (let index = textChanges.length - 1; index >= 0; index -= 1) {
    const change = textChanges[index];
    const ref = change.operations[0].ref;
    const snapshotRefs = [...new Map(change.operations.map(({ ref: input }) => [referenceKey(input), input])).values()];
    if (change.rolledBack === true) {
      for (const input of snapshotRefs) results.push({ ref: input, status: "already" });
      continue;
    }
    // A previous partial rollback may already have unwound multiple snapshots
    // of this field. Recognize earlier states only along a continuous chain.
    const earlierValues = [];
    let before = change.before;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const candidate = textChanges[previous];
      if (textFieldKey(candidate.operations[0].ref) !== textFieldKey(ref)) continue;
      if (candidate.after !== before) break;
      before = candidate.before;
      earlierValues.push(before);
    }
    const result = await processDocumentTasks([{ oldPath: ref.oldPath, newPath: ref.newPath, refs: [ref] }], normalizedOptions, true,
      { signal, onProgress, textRestore: { ...change, earlierValues } });
    for (const item of result.results) {
      if (item.ref) for (const input of snapshotRefs) results.push({ ...item, ref: input, entryOldPath: input.oldPath, entryNewPath: input.newPath });
      else results.push(item);
    }
    if (result.results.some((item) => item.ref && ["changed", "already"].includes(item.status))) {
      const saved = migrationReport.textChanges?.find((item) => item.id === change.id);
      if (saved) saved.rolledBack = true;
    }
  }
  // Placeholder replacement is terminal: once a PNG/WEBP reference becomes an
  // SVG it disappears from later scans. Roll it back first, then unwind any
  // earlier PNG<->WEBP transition recorded for the same field.
  const phases = [
    { refs: placeholderApplied, reverse: true },
    { refs: forwardApplied, reverse: true },
    { refs: reverseApplied, reverse: false }
  ].filter((phase) => phase.refs.length);
  let completed = 0;
  const total = phases.reduce((sum, phase) => sum + buildEntries(phase.refs).reduce((count, entry) => count + new Set(entry.refs.map((ref) => ref.uuid)).size, 0), 0);

  for (const phase of phases) {
    const entries = buildEntries(phase.refs);
    const phaseResult = await processDocumentTasks(entries, normalizedOptions, phase.reverse, {
      signal,
      rollbackWithoutSnapshots: true,
      onProgress: ({ label }) => {
        completed += 1;
        onProgress?.({ current: completed, total: Math.max(total, completed), label });
      }
    });
    results.push(...phaseResult.results);
  }

  return {
    cancelled: signal?.aborted === true,
    cleanupRevoked: true,
    changed: results.filter((result) => result.status === "changed").length,
    already: results.filter((result) => result.status === "already").length,
    stale: results.filter((result) => result.status === "stale").length,
    errors: results.filter((result) => result.status === "error" || result.status === "skipped").length,
    lockRestoreErrors: results.filter((result) => result.status === "lock-restore-error").length,
    issues: results.filter((result) => !["changed", "already"].includes(result.status))
  };
}
