import {
  DEFAULT_SCAN_OPTIONS,
  FALLBACK_EMBEDDED_FIELDS,
  MANIFEST_SCHEMA_VERSION,
  MODULE_VERSION,
  SUPPORTED_COMPENDIUM_DOCUMENTS
} from "./constants.mjs";
import { collectPngReferences, createId, deepClone } from "./path-utils.mjs";

function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === "function") return [...collection.values()];
  if (Symbol.iterator in Object(collection)) return [...collection];
  return [];
}

function packageType(pack) {
  return pack?.metadata?.packageType
    ?? pack?.metadata?.package
    ?? pack?.metadata?.type
    ?? "unknown";
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
  return collectPngReferences(source, {
    richText: options.richText,
    skipRootFields,
    documentInfo: documentInfo(document, root, pack)
  });
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
  addCollection(options.chatMessages, game.messages, "ChatMessages");

  if (options.worldOther) {
    addCollection(true, game.playlists, "Playlists");
    addCollection(true, game.combats, "Combats");
    addCollection(true, game.folders, "Folders");
  }

  return roots;
}

async function compendiumRoots(options, skipped, onProgress) {
  const roots = [];
  if (!options.worldCompendiums && !options.packageCompendiums) return roots;

  const packs = collectionValues(game.packs)
    .filter((pack) => SUPPORTED_COMPENDIUM_DOCUMENTS.has(pack.documentName))
    .filter((pack) => packageType(pack) === "world" ? options.worldCompendiums : options.packageCompendiums);

  for (let index = 0; index < packs.length; index += 1) {
    const pack = packs[index];
    onProgress?.({ phase: "pack", current: index + 1, total: packs.length, label: pack.title });
    try {
      const documents = await pack.getDocuments();
      for (const document of documents) addRoot(roots, document, `Compendium: ${pack.title}`, pack);
    } catch (error) {
      skipped.push({
        source: pack.collection,
        label: pack.title,
        reason: error?.message ?? String(error)
      });
    }
  }
  return roots;
}

function groupReferences(references) {
  const groups = new Map();
  for (const ref of references) {
    const key = ref.oldPath;
    if (!groups.has(key)) {
      groups.set(key, {
        oldPath: ref.oldPath,
        newPath: ref.newPath,
        wildcard: /[*?]/.test(ref.oldPath),
        refs: []
      });
    }
    groups.get(key).refs.push(ref);
  }
  return [...groups.values()].sort((a, b) => a.oldPath.localeCompare(b.oldPath));
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

export async function scanFoundry(options = {}, { onProgress } = {}) {
  if (!game.user?.isGM) throw new Error("Сканирование доступно только GM.");
  const normalizedOptions = { ...DEFAULT_SCAN_OPTIONS, ...deepClone(options) };
  const skipped = [];
  const roots = worldRoots(normalizedOptions);
  roots.push(...await compendiumRoots(normalizedOptions, skipped, onProgress));

  const rootSeen = new Set();
  const references = [];
  let documentCount = 0;

  for (let index = 0; index < roots.length; index += 1) {
    const rootEntry = roots[index];
    if (rootSeen.has(rootEntry.document.uuid)) continue;
    rootSeen.add(rootEntry.document.uuid);
    onProgress?.({
      phase: "document",
      current: index + 1,
      total: roots.length,
      label: rootEntry.document.name ?? rootEntry.document.id
    });

    for (const document of iterateDocumentTree(rootEntry.document)) {
      documentCount += 1;
      try {
        references.push(...scanDocument(rootEntry.document, document, rootEntry.pack, normalizedOptions));
      } catch (error) {
        skipped.push({
          source: document.uuid,
          label: document.name ?? document.id,
          reason: error?.message ?? String(error)
        });
      }
    }
  }

  const entries = groupReferences(references);
  const manifestId = createId();
  const manifest = {
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
    options: normalizedOptions,
    notes: [
      "oldPath/newPath are physical paths relative to Foundry UserData/Data.",
      "Reference data remains authoritative inside this manifest. Conversion reports never authorize document fields.",
      "Cleanup is safe only for the scopes selected during this scan."
    ],
    skipped,
    summary: {
      scannedRootDocuments: rootSeen.size,
      scannedDocumentsIncludingEmbedded: documentCount,
      uniquePngPaths: entries.length,
      documentReferences: references.length,
      wildcardPaths: entries.filter((entry) => entry.wildcard).length,
      skippedSources: skipped.length,
      byDocumentType: makeBreakdown(references)
    },
    entries
  };

  return manifest;
}

export function sanitizeScanOptions(options = {}) {
  const output = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SCAN_OPTIONS)) output[key] = typeof options[key] === "boolean" ? options[key] : fallback;
  return output;
}

export function getPackPackageType(pack) {
  return packageType(pack);
}
