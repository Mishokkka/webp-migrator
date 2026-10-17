export const MODULE_ID = "fbl-webp-migrator";
export const MODULE_TITLE = "FBL WebP Migrator";
export const MODULE_VERSION = "0.4.7";
export const MANIFEST_SCHEMA_VERSION = 4;
export const REPORT_SCHEMA_VERSION = 4;
export const PENDING_RELOCKS_SETTING = "pendingPackRelocks";
export const MISSING_ASSET_PLACEHOLDER = "icons/svg/mystery-man.svg";

export const SUCCESS_STATUSES = new Set([
  "converted",
  "exists",
  "exists-missing-old",
  "assume-existing"
]);

export const VERIFIED_CONVERSION_STATUSES = new Set([
  "converted",
  "exists",
  "exists-missing-old"
]);

export const DEFAULT_SCAN_OPTIONS = Object.freeze({
  worldActors: true,
  worldItems: true,
  worldScenes: true,
  worldJournals: true,
  worldTables: true,
  worldCards: true,
  worldMacros: true,
  worldUsers: false,
  worldOther: false,
  chatMessages: false,
  worldCompendiums: false,
  packageCompendiums: false,
  richText: true,
  autoUnlockWorldPacks: true,
  allowPackageCompendiumWrites: false
});

export const SUPPORTED_COMPENDIUM_DOCUMENTS = new Set([
  "Actor",
  "Item",
  "Scene",
  "JournalEntry",
  "RollTable",
  "Cards",
  "Macro",
  "Playlist"
]);

export const DANGEROUS_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor"
]);

export const FALLBACK_EMBEDDED_FIELDS = Object.freeze({
  Actor: ["items", "effects"],
  Item: ["effects"],
  Scene: ["tokens", "tiles", "drawings", "walls", "lights", "sounds", "notes", "templates", "regions"],
  JournalEntry: ["pages"],
  RollTable: ["results"],
  Cards: ["cards"],
  Playlist: ["sounds"],
  Combat: ["combatants", "groups"],
  Region: ["behaviors"]
});
