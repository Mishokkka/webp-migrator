import {
  DEFAULT_SCAN_OPTIONS,
  FALLBACK_EMBEDDED_FIELDS,
  MANIFEST_SCHEMA_VERSION,
  MODULE_VERSION,
  SUPPORTED_COMPENDIUM_DOCUMENTS
} from "./constants.mjs";
import {
  collectPngReferences,
  collectWebpReferences,
  createId,
  deepClone,
  isSafePathSegments,
  normalizePhysicalPath,
  normalizeWebpPhysicalPath,
  sanitizeJsonValue,
  toWebpReference,
  toWebpPhysicalPath
} from "./path-utils.mjs";

function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === "function") return [...collection.values()];
  if (Symbol.iterator in Object(collection)) return [...collection];
  return [];
}

function packageType(pack) {
  const type = pack?.metadata?.packageType;
  return type === "world" || type === "module" || type === "system" ? type : "unknown";
}

function getEmbeddedFieldNames(document) {
  const fields = new Set(FALLBACK_EMBEDDED_FIELDS[document?.documentName] ?? []);
  const embedded = document?.constructor?.metadata?.embedded;
  if (embedded && typeof embedded === "object") {
    for (const value of Object.values(embedded)) {
      if (typeof value === "string" && value) fields.add(value);
    }
  }
  return fields;
}

function yieldedDocument(value) {
  if (Array.isArray(value)) return value[1];
  return value?.document ?? value;
}

function manualEmbeddedDocuments(document) {
  const docs = [];
  for (const field of getEmbeddedFieldNames(document)) {
    for (const child of collectionValues(document?.[field])) {
      if (child?.toObject && child?.documentName) docs.push(child);
    }
  }
  return docs;
}

export function iterateDocumentTree(root) {
  const output = [];
  const seen = new Set();
  const add = (document) => {
    const key = document?.uuid ?? `${document?.documentName}:${document?.id}`;
    if (!document?.toObject || !key || seen.has(key)) return;
    seen.add(key);
    output.push(document);
  };

  add(root);
  try {
    if (typeof root?.traverseEmbeddedDocuments === "function") {
      for (const yielded of root.traverseEmbeddedDocuments()) add(yieldedDocument(yielded));
    }
  } catch (error) {
    console.warn("FBL WebP Migrator | traverseEmbeddedDocuments failed, using metadata fallback", root, error);
  }

  for (let index = 0; index < output.length; index += 1) {
    for (const child of manualEmbeddedDocuments(output[index])) add(child);
  }
  return output;
}

function documentInfo(document, root, pack = null) {
  const actualPack = pack ?? document?.compendium ?? (document?.pack ? game.packs?.get(document.pack) : null);
  return {
    uuid: document.uuid,
    documentId: document.id,
    documentName: document.documentName,
    documentLabel: document.name ?? document.label ?? document.id,
    rootUuid: root.uuid,
    rootDocumentName: root.documentName,
    rootLabel: root.name ?? root.label ?? root.id,
    pack: actualPack?.collection ?? document.pack ?? null,
    packTitle: actualPack?.title ?? null,
    packageType: actualPack ? packageType(actualPack) : "world"
  };
}

function scanDocument(root, document, pack, options) {
  const source = document.toObject(true);
  const skipRootFields = getEmbeddedFieldNames(document);
  const info = documentInfo(document, root, pack);
  return {
    png: collectPngReferences(source, {
      richText: options.richText,
      skipRootFields,
      documentInfo: info
    }),
    webp: collectWebpReferences(source, {
      richText: options.richText,
      skipRootFields,
      documentInfo: info
    })
  };
}

function addRoot(target, document, sourceLabel, pack = null) {
  if (!document?.toObject || !document?.uuid) return;
  target.push({ document, sourceLabel, pack });
}

function worldRoots(options) {
  const roots = [];
  const addCollection = (enabled, collection, sourceLabel) => {
    if (!enabled) return;
    for (const document of collectionValues(collection)) addRoot(roots, document, sourceLabel);
  };

  addCollection(options.worldActors, game.actors, "Actors");
  addCollection(options.worldItems, game.items, "Items");
  addCollection(options.worldScenes, game.scenes, "Scenes");
  addCollection(options.worldJournals, game.journal, "JournalEntries");
  addCollection(options.worldTables, game.tables, "RollTables");
  addCollection(options.worldCards, game.cards, "Cards");
  addCollection(options.worldMacros, game.macros, "Macros");
  addCollection(options.worldUsers, game.users, "Users");
  addCollection(options.chatMessages, game.messages, "ChatMessages (loaded)");

  if (options.worldOther) {
    addCollection(true, game.playlists, "Playlists");
    addCollection(true, game.combats, "Combats");
    addCollection(true, game.folders, "Folders");
  }

  return roots;
}

function selectedCompendiumPacks(options) {
  if (!options.worldCompendiums && !options.packageCompendiums) return [];
  return collectionValues(game.packs)
    .filter((pack) => SUPPORTED_COMPENDIUM_DOCUMENTS.has(pack.documentName))
    .filter((pack) => {
      const type = packageType(pack);
      if (type === "world") return options.worldCompendiums;
      if (type === "module" || type === "system") return options.packageCompendiums;
      return false;
    });
}

function isCaseInsensitivePlatform(platform = globalThis.process?.platform ?? globalThis.navigator?.platform ?? "") {
  return /^(?:win32|darwin)$/i.test(platform) || /(?:win|mac)/i.test(platform);
}

function pathKey(value, caseInsensitive = isCaseInsensitivePlatform()) {
  const text = String(value ?? "");
  return caseInsensitive ? text.toLocaleLowerCase("en-US") : text;
}

function representativePaths(references, caseInsensitive = isCaseInsensitivePlatform()) {
  const map = new Map();
  for (const ref of references) {
    const key = pathKey(ref?.oldPath, caseInsensitive);
    if (key && !map.has(key)) map.set(key, ref.oldPath);
  }
  return map;
}

export function groupReferences(references, {
  caseInsensitive = isCaseInsensitivePlatform(),
  representatives = representativePaths(references, caseInsensitive)
} = {}) {
  const groups = new Map();
  let caseFoldedAliases = 0;
  for (const inputRef of references) {
    const key = pathKey(inputRef.oldPath, caseInsensitive);
    const representative = representatives.get(key) ?? inputRef.oldPath;
    if (!groups.has(key)) {
      groups.set(key, {
        oldPath: representative,
        newPath: toWebpPhysicalPath(representative),
        wildcard: /[*?]/.test(representative),
        refs: []
      });
    }
    if (representative !== inputRef.oldPath) caseFoldedAliases += 1;
    // Keep the exact path spelling found in each document. Migration validation
    // must compare the document field against its own value, not a group alias.
    groups.get(key).refs.push({ ...inputRef });
  }
  return {
    entries: [...groups.values()].sort((a, b) => a.oldPath.localeCompare(b.oldPath)),
    caseFoldedAliases
  };
}

function makeBreakdown(references) {
  const map = new Map();
  for (const ref of references) {
    const key = ref.documentName ?? "Unknown";
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([documentName, references]) => ({ documentName, references }))
    .sort((a, b) => b.references - a.references || a.documentName.localeCompare(b.documentName));
}

async function yieldToBrowser() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function scanRootEntry(rootEntry, context) {
  const { rootSeen, references, webpReferences, skipped, options, progress } = context;
  if (rootSeen.has(rootEntry.document.uuid)) return 0;
  rootSeen.add(rootEntry.document.uuid);
  progress?.(rootEntry.document);

  let count = 0;
  for (const document of iterateDocumentTree(rootEntry.document)) {
    count += 1;
    try {
      const found = scanDocument(rootEntry.document, document, rootEntry.pack, options);
      references.push(...found.png);
      webpReferences.push(...found.webp);
    } catch (error) {
      skipped.push({
        source: document.uuid,
        label: document.name ?? document.id,
        reason: error?.message ?? String(error)
      });
    }
  }
  return count;
}

export async function scanFoundry(options = {}, { onProgress, signal } = {}) {
  if (!game.user?.isGM) throw new Error("Сканирование доступно только GM.");
  const normalizedOptions = sanitizeScanOptions(deepClone(options));
  const skipped = [];
  const rootSeen = new Set();
  const references = [];
  const webpReferences = [];
  let documentCount = 0;
  let progressCounter = 0;

  const roots = worldRoots(normalizedOptions);
  for (let index = 0; index < roots.length; index += 1) {
    if (signal?.aborted) throw new DOMException("Операция отменена.", "AbortError");
    const rootEntry = roots[index];
    documentCount += await scanRootEntry(rootEntry, {
      rootSeen,
      references,
      webpReferences,
      skipped,
      options: normalizedOptions,
      progress: (document) => onProgress?.({
        phase: "document",
        current: index + 1,
        total: roots.length,
        label: document.name ?? document.id
      })
    });
    progressCounter += 1;
    if (progressCounter % 20 === 0) await yieldToBrowser();
  }

  const packs = selectedCompendiumPacks(normalizedOptions);
  for (let packIndex = 0; packIndex < packs.length; packIndex += 1) {
    if (signal?.aborted) throw new DOMException("Операция отменена.", "AbortError");
    const pack = packs[packIndex];
    onProgress?.({ phase: "pack", current: packIndex + 1, total: packs.length, label: pack.title });
    try {
      const documents = await pack.getDocuments();
      for (let documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
        if (signal?.aborted) throw new DOMException("Операция отменена.", "AbortError");
        const document = documents[documentIndex];
        const rootEntry = { document, sourceLabel: `Compendium: ${pack.title}`, pack };
        documentCount += await scanRootEntry(rootEntry, {
          rootSeen,
          references,
          webpReferences,
          skipped,
          options: normalizedOptions,
          progress: (currentDocument) => onProgress?.({
            phase: "pack-document",
            current: documentIndex + 1,
            total: documents.length,
            label: `${pack.title}: ${currentDocument.name ?? currentDocument.id}`
          })
        });
        if (documentIndex % 20 === 19) await yieldToBrowser();
      }
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      skipped.push({
        source: pack.collection,
        label: pack.title,
        reason: error?.message ?? String(error)
      });
    }
    await yieldToBrowser();
  }

  const caseInsensitive = isCaseInsensitivePlatform();
  const representatives = representativePaths([...references, ...webpReferences], caseInsensitive);
  const grouped = groupReferences(references, { caseInsensitive, representatives });
  const groupedWebp = groupReferences(webpReferences, { caseInsensitive, representatives });
  const entries = grouped.entries;
  const webpEntries = groupedWebp.entries;
  const manifestId = createId();
  return {
    type: "fbl-webp-migrator-manifest",
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    version: MODULE_VERSION,
    manifestId,
    createdAt: new Date().toISOString(),
    foundryVersion: game.version,
    systemId: game.system?.id ?? null,
    systemVersion: game.system?.version ?? null,
    worldId: game.world?.id ?? null,
    worldTitle: game.world?.title ?? null,
    capabilities: {
      pngReferenceScan: true,
      webpReferenceScan: true,
      consistencyAudit: true
    },
    options: normalizedOptions,
    notes: [
      "oldPath/newPath are physical paths relative to Foundry UserData/Data.",
      "Reference data remains authoritative inside this manifest. Conversion reports never authorize document fields.",
      "Cleanup is safe only for the scopes selected during this scan.",
      normalizedOptions.chatMessages
        ? "Chat Messages coverage is limited to messages currently loaded by Foundry."
        : "Chat Messages were not scanned.",
      grouped.caseFoldedAliases
        ? `Merged ${grouped.caseFoldedAliases} path aliases that differ only by letter case on a case-insensitive platform.`
        : "No case-folded PNG path aliases were merged.",
      groupedWebp.caseFoldedAliases
        ? `Merged ${groupedWebp.caseFoldedAliases} WEBP path aliases that differ only by letter case on a case-insensitive platform.`
        : "No case-folded WEBP path aliases were merged."
    ],
    skipped,
    summary: {
      scannedRootDocuments: rootSeen.size,
      scannedDocumentsIncludingEmbedded: documentCount,
      uniquePngPaths: entries.length,
      documentReferences: references.length,
      uniqueWebpPaths: webpEntries.length,
      webpDocumentReferences: webpReferences.length,
      wildcardPaths: new Set([...entries, ...webpEntries].filter((entry) => entry.wildcard).map((entry) => entry.oldPath)).size,
      skippedSources: skipped.length,
      caseFoldedAliases: grouped.caseFoldedAliases,
      webpCaseFoldedAliases: groupedWebp.caseFoldedAliases,
      byDocumentType: makeBreakdown(references)
    },
    entries,
    webpEntries
  };
}

export function sanitizeScanOptions(options = {}) {
  const output = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SCAN_OPTIONS)) {
    output[key] = typeof options[key] === "boolean" ? options[key] : fallback;
  }
  return output;
}

function sanitizeImportedRef(ref, entry, sourceFormat = "png", caseInsensitive = isCaseInsensitivePlatform()) {
  if (!ref || typeof ref !== "object") return null;
  if (typeof ref.uuid !== "string" || !isSafePathSegments(ref.fieldPath)) return null;
  if (ref.fieldPath[0] !== ref.rootField || typeof ref.rootField !== "string") return null;
  if (ref.mode !== "exact" && ref.mode !== "text") return null;
  if (typeof ref.oldValue !== "string" || typeof ref.newValue !== "string" || ref.oldValue === ref.newValue) return null;

  const oldPath = normalizePhysicalPath(ref.oldValue);
  const newPath = normalizeWebpPhysicalPath(ref.newValue);
  if (!oldPath || !newPath || toWebpPhysicalPath(oldPath) !== newPath) return null;
  if (pathKey(oldPath, caseInsensitive) !== pathKey(entry.oldPath, caseInsensitive)) return null;
  if (pathKey(newPath, caseInsensitive) !== pathKey(entry.newPath, caseInsensitive)) return null;
  if (pathKey(ref.oldPath, caseInsensitive) !== pathKey(oldPath, caseInsensitive)) return null;
  if (pathKey(ref.newPath, caseInsensitive) !== pathKey(newPath, caseInsensitive)) return null;
  if (toWebpReference(ref.oldValue) !== ref.newValue) return null;
  const normalizedSourceFormat = ref.sourceFormat === "webp" ? "webp" : "png";
  if (normalizedSourceFormat !== sourceFormat) return null;
  return {
    uuid: ref.uuid,
    documentId: typeof ref.documentId === "string" ? ref.documentId : null,
    documentName: typeof ref.documentName === "string" ? ref.documentName : null,
    documentLabel: typeof ref.documentLabel === "string" ? ref.documentLabel : null,
    rootUuid: typeof ref.rootUuid === "string" ? ref.rootUuid : ref.uuid,
    rootDocumentName: typeof ref.rootDocumentName === "string" ? ref.rootDocumentName : null,
    rootLabel: typeof ref.rootLabel === "string" ? ref.rootLabel : null,
    pack: typeof ref.pack === "string" ? ref.pack : null,
    packTitle: typeof ref.packTitle === "string" ? ref.packTitle : null,
    packageType: ["world", "module", "system", "unknown"].includes(ref.packageType) ? ref.packageType : "unknown",
    sourceFormat,
    mode: ref.mode,
    fieldPath: deepClone(ref.fieldPath),
    fieldLabel: typeof ref.fieldLabel === "string" ? ref.fieldLabel : null,
    rootField: ref.rootField,
    oldValue: ref.oldValue,
    newValue: ref.newValue,
    oldPath,
    newPath
  };
}

export function sanitizeManifest(raw, currentWorldId = game.world?.id ?? null, { caseInsensitive = isCaseInsensitivePlatform() } = {}) {
  if (!raw || raw.type !== "fbl-webp-migrator-manifest") throw new Error("Это не manifest FBL WebP Migrator.");
  if (!raw.manifestId || typeof raw.manifestId !== "string") throw new Error("Manifest не содержит manifestId.");
  if (raw.worldId !== currentWorldId) throw new Error("Manifest относится к другому миру.");

  const ignored = [];
  const rawEntries = [...(raw.entries ?? []), ...(raw.webpEntries ?? [])];
  const representatives = new Map();
  for (const input of rawEntries) {
    const oldPath = normalizePhysicalPath(input?.oldPath);
    if (!oldPath) continue;
    const key = pathKey(oldPath, caseInsensitive);
    if (!representatives.has(key)) representatives.set(key, oldPath);
  }

  const sanitizeEntries = (inputs, sourceFormat) => {
    const map = new Map();
    for (const input of inputs ?? []) {
      const inputOldPath = normalizePhysicalPath(input?.oldPath);
      const inputNewPath = normalizeWebpPhysicalPath(input?.newPath);
      if (!inputOldPath || !inputNewPath || toWebpPhysicalPath(inputOldPath) !== inputNewPath) {
        ignored.push({ oldPath: input?.oldPath ?? null, sourceFormat, reason: "Некорректная пара oldPath/newPath." });
        continue;
      }
      const key = pathKey(inputOldPath, caseInsensitive);
      const oldPath = representatives.get(key) ?? inputOldPath;
      const newPath = toWebpPhysicalPath(oldPath);
      if (!map.has(key)) {
        map.set(key, {
          oldPath,
          newPath,
          wildcard: /[*?]/.test(oldPath),
          refs: [],
          dedupe: new Set()
        });
      }
      const entry = map.get(key);
      let accepted = 0;
      for (const inputRef of input.refs ?? []) {
        const ref = sanitizeImportedRef(inputRef, entry, sourceFormat, caseInsensitive);
        if (!ref) continue;
        const refKey = `${ref.uuid}|${JSON.stringify(ref.fieldPath)}|${ref.mode}|${ref.oldValue}|${ref.newValue}`;
        if (entry.dedupe.has(refKey)) continue;
        entry.dedupe.add(refKey);
        entry.refs.push(ref);
        accepted += 1;
      }
      if (!accepted) ignored.push({ oldPath, sourceFormat, reason: "В записи нет новых допустимых ссылок." });
    }
    return [...map.values()]
      .filter((entry) => entry.refs.length)
      .map(({ dedupe, ...entry }) => entry)
      .sort((a, b) => a.oldPath.localeCompare(b.oldPath));
  };

  const entries = sanitizeEntries(raw.entries, "png");
  const webpEntries = sanitizeEntries(raw.webpEntries, "webp");

  const references = entries.flatMap((entry) => entry.refs);
  const webpReferences = webpEntries.flatMap((entry) => entry.refs);
  return {
    type: raw.type,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    version: typeof raw.version === "string" ? raw.version : MODULE_VERSION,
    manifestId: raw.manifestId,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    foundryVersion: typeof raw.foundryVersion === "string" ? raw.foundryVersion : null,
    systemId: typeof raw.systemId === "string" ? raw.systemId : null,
    systemVersion: typeof raw.systemVersion === "string" ? raw.systemVersion : null,
    worldId: currentWorldId,
    worldTitle: typeof raw.worldTitle === "string" ? raw.worldTitle : game.world?.title ?? null,
    capabilities: {
      pngReferenceScan: raw.capabilities?.pngReferenceScan === true || Array.isArray(raw.entries),
      webpReferenceScan: Number(raw.schemaVersion) >= 4
        && raw.capabilities?.webpReferenceScan === true
        && Array.isArray(raw.webpEntries),
      consistencyAudit: Number(raw.schemaVersion) >= 4
        && raw.capabilities?.consistencyAudit === true
        && raw.capabilities?.webpReferenceScan === true
        && Array.isArray(raw.webpEntries)
    },
    options: sanitizeScanOptions(raw.options ?? {}),
    notes: Array.isArray(raw.notes) ? raw.notes.filter((note) => typeof note === "string").slice(0, 20) : [],
    skipped: Array.isArray(raw.skipped)
      ? raw.skipped
        .filter((item) => item && typeof item === "object")
        .slice(0, 5000)
        .map((item) => sanitizeJsonValue(item))
      : [],
    ignored,
    summary: {
      scannedRootDocuments: Number.isFinite(raw.summary?.scannedRootDocuments) ? raw.summary.scannedRootDocuments : null,
      scannedDocumentsIncludingEmbedded: Number.isFinite(raw.summary?.scannedDocumentsIncludingEmbedded) ? raw.summary.scannedDocumentsIncludingEmbedded : null,
      uniquePngPaths: entries.length,
      documentReferences: references.length,
      uniqueWebpPaths: webpEntries.length,
      webpDocumentReferences: webpReferences.length,
      wildcardPaths: new Set([...entries, ...webpEntries].filter((entry) => entry.wildcard).map((entry) => entry.oldPath)).size,
      skippedSources: Array.isArray(raw.skipped) ? raw.skipped.length : 0,
      caseFoldedAliases: Number.isFinite(raw.summary?.caseFoldedAliases) ? raw.summary.caseFoldedAliases : 0,
      webpCaseFoldedAliases: Number.isFinite(raw.summary?.webpCaseFoldedAliases) ? raw.summary.webpCaseFoldedAliases : 0,
      byDocumentType: makeBreakdown(references)
    },
    entries,
    webpEntries
  };
}

export function getPackPackageType(pack) {
  return packageType(pack);
}
