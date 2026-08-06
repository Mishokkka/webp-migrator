import { DANGEROUS_PATH_SEGMENTS } from "./constants.mjs";

const EXTERNAL_SCHEME_RE = /^(?:https?:|data:|blob:|file:|ftp:)/i;
const PNG_SUFFIX_RE = /\.png(?=([?#].*)?$)/i;
const WINDOWS_DRIVE_RE = /^[a-z]:[\\/]/i;
const PATHISH_RE = /[\\/]|\*|\?|%2f|%5c/i;
const RICH_PNG_RE = /(?:^|[\s"'=(,:;])((?!https?:|data:|blob:|file:|ftp:)[^\s"'()<>{}\[\],;]+?\.png(?:[?#][^\s"'()<>{}\[\],;]*)?)/gi;

export function deepClone(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function createId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function splitPathSuffix(value) {
  const source = String(value ?? "");
  const index = source.search(/[?#]/);
  if (index < 0) return { path: source, suffix: "" };
  return { path: source.slice(0, index), suffix: source.slice(index) };
}

export function isExternalReference(value) {
  const trimmed = String(value ?? "").trim();
  return EXTERNAL_SCHEME_RE.test(trimmed) || WINDOWS_DRIVE_RE.test(trimmed) || trimmed.startsWith("//");
}

export function isPngReference(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || isExternalReference(trimmed)) return false;
  return PNG_SUFFIX_RE.test(trimmed);
}

export function looksLikeAssetPath(value, keyHint = "") {
  if (!isPngReference(value)) return false;
  const trimmed = value.trim();
  if (PATHISH_RE.test(trimmed)) return true;
  return /(?:img|image|icon|texture|src|path|background|foreground|avatar|thumb|face|back|ring|effect)/i.test(keyHint);
}

export function toWebpReference(value) {
  return String(value).replace(PNG_SUFFIX_RE, ".webp");
}

export function normalizePhysicalPath(reference) {
  const { path } = splitPathSuffix(String(reference ?? "").trim());
  if (!path || isExternalReference(path)) return null;
  let normalized = path.replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === ".." || DANGEROUS_PATH_SEGMENTS.has(segment))) return null;
  if (!/\.png$/i.test(segments.at(-1))) return null;
  return segments.join("/");
}

export function toWebpPhysicalPath(reference) {
  const normalized = normalizePhysicalPath(reference);
  return normalized?.replace(/\.png$/i, ".webp") ?? null;
}

export function isSafePathSegments(segments) {
  return Array.isArray(segments)
    && segments.length > 0
    && segments.every((segment) => (typeof segment === "number" && Number.isInteger(segment) && segment >= 0)
      || (typeof segment === "string" && segment.length > 0 && !DANGEROUS_PATH_SEGMENTS.has(segment)));
}

export function getAtPath(source, segments) {
  if (!isSafePathSegments(segments)) return undefined;
  let current = source;
  for (const segment of segments) {
    if (current == null) return undefined;
    current = current[segment];
  }
  return current;
}

export function setAtPath(source, segments, value) {
  if (!isSafePathSegments(segments)) throw new Error("Unsafe or empty document field path.");
  let current = source;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    if (current[segment] == null) current[segment] = typeof nextSegment === "number" ? [] : {};
    if (typeof current[segment] !== "object") throw new Error(`Cannot traverse non-object path segment: ${String(segment)}`);
    current = current[segment];
  }
  current[segments.at(-1)] = value;
  return true;
}

export function formatFieldPath(segments) {
  return (segments ?? []).map((segment, index) => {
    if (typeof segment === "number") return `[${segment}]`;
    return index === 0 ? segment : `.${segment}`;
  }).join("");
}

export function findRichPngReferences(text) {
  if (typeof text !== "string" || !/\.png/i.test(text)) return [];
  const matches = [];
  const seen = new Set();
  RICH_PNG_RE.lastIndex = 0;
  for (const match of text.matchAll(RICH_PNG_RE)) {
    const value = match[1]?.trim();
    if (!value || seen.has(value) || !looksLikeAssetPath(value)) continue;
    const physicalPath = normalizePhysicalPath(value);
    if (!physicalPath) continue;
    seen.add(value);
    matches.push(value);
  }
  return matches;
}

export function collectPngReferences(source, {
  richText = true,
  skipRootFields = new Set(),
  documentInfo = {}
} = {}) {
  const refs = [];
  const seenObjects = new WeakSet();

  function walk(value, pathSegments, keyHint) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (looksLikeAssetPath(trimmed, keyHint)) {
        const physicalPath = normalizePhysicalPath(trimmed);
        const newPhysicalPath = toWebpPhysicalPath(trimmed);
        if (physicalPath && newPhysicalPath) {
          refs.push({
            ...documentInfo,
            mode: "exact",
            fieldPath: [...pathSegments],
            fieldLabel: formatFieldPath(pathSegments),
            rootField: pathSegments[0],
            oldValue: value,
            newValue: toWebpReference(value),
            oldPath: physicalPath,
            newPath: newPhysicalPath
          });
          return;
        }
      }

      if (!richText) return;
      for (const match of findRichPngReferences(value)) {
        const physicalPath = normalizePhysicalPath(match);
        const newPhysicalPath = toWebpPhysicalPath(match);
        if (!physicalPath || !newPhysicalPath) continue;
        refs.push({
          ...documentInfo,
          mode: "text",
          fieldPath: [...pathSegments],
          fieldLabel: formatFieldPath(pathSegments),
          rootField: pathSegments[0],
          oldValue: match,
          newValue: toWebpReference(match),
          oldPath: physicalPath,
          newPath: newPhysicalPath
        });
      }
      return;
    }

    if (!value || typeof value !== "object") return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) walk(value[index], [...pathSegments, index], String(index));
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (pathSegments.length === 0 && (key === "_id" || skipRootFields.has(key))) continue;
      if (DANGEROUS_PATH_SEGMENTS.has(key)) continue;
      walk(child, [...pathSegments, key], key);
    }
  }

  walk(source, [], "");
  return refs.filter((ref) => ref.fieldPath.length > 0 && typeof ref.rootField === "string");
}

export function replaceTextReference(current, oldValue, newValue) {
  if (typeof current !== "string") return { status: "stale", value: current };
  if (current.includes(oldValue)) return { status: "changed", value: current.split(oldValue).join(newValue) };
  if (current.includes(newValue)) return { status: "already", value: current };
  return { status: "stale", value: current };
}
