import { DANGEROUS_PATH_SEGMENTS } from "./constants.mjs";
import { isImageHoverSpecificArtSentinel } from "./compatibility.mjs";

const EXTERNAL_SCHEME_RE = /^(?:https?:|data:|blob:|file:|ftp:|s3:)/i;
const PNG_SUFFIX_RE = /\.png(?=([?#].*)?$)/i;
const WEBP_SUFFIX_RE = /\.webp(?=([?#].*)?$)/i;
const WINDOWS_DRIVE_ABSOLUTE_RE = /^[a-z]:[\\/]/i;
const WINDOWS_DRIVE_RELATIVE_RE = /^[a-z]:(?![\\/])/i;
const PATHISH_RE = /[\\/]|\*|\?|%2f|%5c/i;
const ASSET_KEY_RE = /(?:img|image|icon|texture|src|path|background|foreground|avatar|thumb|face|back|ring|effect|gallery|portrait|token|art)/i;
const HTML_ATTRIBUTE_RE = /\b(?:src|href|poster|data-src|data-background|data-image)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
const CSS_URL_RE = /\burl\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/gi;
const MARKDOWN_DEST_RE = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|"([^"]+)"|'([^']+)'|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/gi;
const QUOTED_PNG_RE = /(["'])((?!https?:|data:|blob:|file:|ftp:|s3:)[^"'<>\r\n]*?\.png(?:[?#][^"'<>\r\n]*)?)\1/gi;
const TOKEN_PNG_RE = /(?:^|[\s=(,:;])((?!https?:|data:|blob:|file:|ftp:|s3:)[^\s"'()<>{}\[\],;]+?\.png(?:[?#][^\s"'()<>{}\[\],;]*)?)/gi;
const QUOTED_WEBP_RE = /(["'])((?!https?:|data:|blob:|file:|ftp:|s3:)[^"'<>\r\n]*?\.webp(?:[?#][^"'<>\r\n]*)?)\1/gi;
const TOKEN_WEBP_RE = /(?:^|[\s=(,:;])((?!https?:|data:|blob:|file:|ftp:|s3:)[^\s"'()<>{}\[\],;]+?\.webp(?:[?#][^\s"'()<>{}\[\],;]*)?)/gi;
const PATH_CONTINUATION_RE = /[A-Za-z0-9_%./\\-]/;

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function replaceSuffixPreservingWhitespace(value, from, to) {
  const text = String(value ?? "");
  const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const leading = match?.[1] ?? "";
  const core = match?.[2] ?? text;
  const trailing = match?.[3] ?? "";
  return `${leading}${core.replace(from, to)}${trailing}`;
}

export function deepClone(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function sanitizeJsonValue(value, depth = 0) {
  if (depth > 40) return null;
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item, depth + 1));
  if (typeof value !== "object") return null;

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_PATH_SEGMENTS.has(key)) continue;
    output[key] = sanitizeJsonValue(child, depth + 1);
  }
  return output;
}

export function createId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("Secure random number generator is unavailable.");
}

export function splitPathSuffix(value) {
  const source = String(value ?? "");
  const lower = source.toLowerCase();
  const candidates = [];
  for (const extension of [".png", ".webp"]) {
    let fromIndex = 0;
    while (fromIndex < lower.length) {
      const index = lower.indexOf(extension, fromIndex);
      if (index < 0) break;
      const suffixIndex = index + extension.length;
      const next = source[suffixIndex];
      if (suffixIndex === source.length || next === "?" || next === "#") {
        candidates.push({ index, suffixIndex });
      }
      fromIndex = index + 1;
    }
  }
  candidates.sort((a, b) => a.index - b.index);
  const boundary = candidates[0];
  if (boundary) {
    return { path: source.slice(0, boundary.suffixIndex), suffix: source.slice(boundary.suffixIndex) };
  }
  const index = source.search(/[?#]/);
  if (index < 0) return { path: source, suffix: "" };
  return { path: source.slice(0, index), suffix: source.slice(index) };
}

export function isExternalReference(value) {
  const trimmed = String(value ?? "").trim();
  return EXTERNAL_SCHEME_RE.test(trimmed)
    || WINDOWS_DRIVE_ABSOLUTE_RE.test(trimmed)
    || WINDOWS_DRIVE_RELATIVE_RE.test(trimmed)
    || trimmed.startsWith("//")
    || trimmed.startsWith("\\\\");
}

export function isPngReference(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || isExternalReference(trimmed)) return false;
  return PNG_SUFFIX_RE.test(trimmed);
}

export function isWebpReference(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || isExternalReference(trimmed)) return false;
  return WEBP_SUFFIX_RE.test(trimmed);
}

export function looksLikeAssetPath(value, keyHint = "", { allowBare = false } = {}) {
  if (!isPngReference(value)) return false;
  const trimmed = value.trim();
  if (allowBare || PATHISH_RE.test(trimmed)) return true;
  return ASSET_KEY_RE.test(keyHint);
}

export function looksLikeWebpAssetPath(value, keyHint = "", { allowBare = false } = {}) {
  if (!isWebpReference(value)) return false;
  const trimmed = value.trim();
  if (allowBare || PATHISH_RE.test(trimmed)) return true;
  return ASSET_KEY_RE.test(keyHint);
}

export function toWebpReference(value) {
  return replaceSuffixPreservingWhitespace(value, PNG_SUFFIX_RE, ".webp");
}

export function toPngReference(value) {
  return replaceSuffixPreservingWhitespace(value, WEBP_SUFFIX_RE, ".png");
}

export function normalizePhysicalPath(reference) {
  const { path } = splitPathSuffix(String(reference ?? "").trim());
  if (!path || isExternalReference(path) || path.includes("\0")) return null;
  let normalized = decodePath(path).replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  const segments = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." || DANGEROUS_PATH_SEGMENTS.has(segment) || /^[a-z]:$/i.test(segment)) return null;
    segments.push(segment);
  }
  if (!segments.length || !/\.png$/i.test(segments.at(-1))) return null;
  return segments.join("/");
}

export function normalizeWebpPhysicalPath(reference) {
  const text = String(reference ?? "").trim();
  const { path } = splitPathSuffix(text);
  if (!path || isExternalReference(path) || path.includes("\0")) return null;
  let normalized = decodePath(path).replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  const segments = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." || DANGEROUS_PATH_SEGMENTS.has(segment) || /^[a-z]:$/i.test(segment)) return null;
    segments.push(segment);
  }
  if (!segments.length || !/\.webp$/i.test(segments.at(-1))) return null;
  return segments.join("/");
}

export function toWebpPhysicalPath(reference) {
  const normalized = normalizePhysicalPath(reference);
  return normalized?.replace(/\.png$/i, ".webp") ?? null;
}

export function toPngPhysicalPath(reference) {
  const normalized = normalizeWebpPhysicalPath(reference);
  return normalized?.replace(/\.webp$/i, ".png") ?? null;
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

function addRichCandidate(matches, seen, candidate) {
  const value = String(candidate ?? "").trim();
  if (!value || seen.has(value) || !looksLikeAssetPath(value, "", { allowBare: true })) return;
  if (!normalizePhysicalPath(value)) return;
  seen.add(value);
  matches.push(value);
}

export function findRichPngReferences(text) {
  if (typeof text !== "string" || !/\.png/i.test(text)) return [];
  const matches = [];
  const seen = new Set();
  const patterns = [HTML_ATTRIBUTE_RE, CSS_URL_RE, MARKDOWN_DEST_RE, QUOTED_PNG_RE, TOKEN_PNG_RE];
  for (const regex of patterns) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) addRichCandidate(matches, seen, match.slice(1).find(Boolean));
  }
  return matches;
}

function addRichWebpCandidate(matches, seen, candidate) {
  const value = String(candidate ?? "").trim();
  if (!value || seen.has(value) || !normalizeWebpPhysicalPath(value)) return;
  seen.add(value);
  matches.push(value);
}

export function findRichWebpReferences(text) {
  if (typeof text !== "string" || !/\.webp/i.test(text)) return [];
  const matches = [];
  const seen = new Set();
  const patterns = [HTML_ATTRIBUTE_RE, CSS_URL_RE, MARKDOWN_DEST_RE, QUOTED_WEBP_RE, TOKEN_WEBP_RE];
  for (const regex of patterns) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) addRichWebpCandidate(matches, seen, match.slice(1).find(Boolean));
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
      // Image Hover 3.1 uses path/image.png as a semantic "no override" sentinel.
      // It is not a real asset and must never enter conversion/consistency workflows.
      if (isImageHoverSpecificArtSentinel(trimmed, pathSegments)) return;
      if (looksLikeAssetPath(trimmed, keyHint)) {
        const physicalPath = normalizePhysicalPath(trimmed);
        const newPhysicalPath = toWebpPhysicalPath(trimmed);
        const newValue = toWebpReference(value);
        if (physicalPath && newPhysicalPath && newValue !== value) {
          refs.push({
            ...documentInfo,
            sourceFormat: "png",
            mode: "exact",
            fieldPath: [...pathSegments],
            fieldLabel: formatFieldPath(pathSegments),
            rootField: pathSegments[0],
            oldValue: value,
            newValue,
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
        const newValue = toWebpReference(match);
        if (!physicalPath || !newPhysicalPath || newValue === match) continue;
        refs.push({
          ...documentInfo,
          sourceFormat: "png",
          mode: "text",
          fieldPath: [...pathSegments],
          fieldLabel: formatFieldPath(pathSegments),
          rootField: pathSegments[0],
          oldValue: match,
          newValue,
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
      for (let index = 0; index < value.length; index += 1) walk(value[index], [...pathSegments, index], keyHint);
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

export function collectWebpReferences(source, {
  richText = true,
  skipRootFields = new Set(),
  documentInfo = {}
} = {}) {
  const refs = [];
  const seenObjects = new WeakSet();

  function addReference({ mode, pathSegments, currentValue }) {
    const newPath = normalizeWebpPhysicalPath(currentValue);
    const oldPath = toPngPhysicalPath(currentValue);
    const oldValue = toPngReference(currentValue);
    if (!oldPath || !newPath || oldValue === currentValue) return;
    refs.push({
      ...documentInfo,
      sourceFormat: "webp",
      mode,
      fieldPath: [...pathSegments],
      fieldLabel: formatFieldPath(pathSegments),
      rootField: pathSegments[0],
      oldValue,
      newValue: currentValue,
      oldPath,
      newPath
    });
  }

  function walk(value, pathSegments, keyHint) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (looksLikeWebpAssetPath(trimmed, keyHint)) {
        addReference({ mode: "exact", pathSegments, currentValue: value });
        return;
      }

      if (!richText) return;
      for (const match of findRichWebpReferences(value)) {
        addReference({ mode: "text", pathSegments, currentValue: match });
      }
      return;
    }

    if (!value || typeof value !== "object") return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) walk(value[index], [...pathSegments, index], keyHint);
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

function hasBoundaryBefore(text, index) {
  return index === 0 || !PATH_CONTINUATION_RE.test(text[index - 1]);
}

function hasBoundaryAfter(text, index) {
  return index >= text.length || !PATH_CONTINUATION_RE.test(text[index]);
}

export function replaceTextReference(current, oldValue, newValue) {
  if (typeof current !== "string" || typeof oldValue !== "string" || typeof newValue !== "string" || oldValue === newValue) {
    return { status: "stale", value: current };
  }

  let cursor = 0;
  let changed = false;
  let output = "";
  while (cursor < current.length) {
    const index = current.indexOf(oldValue, cursor);
    if (index < 0) {
      output += current.slice(cursor);
      break;
    }
    if (!hasBoundaryBefore(current, index) || !hasBoundaryAfter(current, index + oldValue.length)) {
      output += current.slice(cursor, index + oldValue.length);
      cursor = index + oldValue.length;
      continue;
    }
    output += current.slice(cursor, index) + newValue;
    cursor = index + oldValue.length;
    changed = true;
  }
  if (changed) return { status: "changed", value: output };

  let newCursor = 0;
  while (newCursor < current.length) {
    const index = current.indexOf(newValue, newCursor);
    if (index < 0) break;
    if (hasBoundaryBefore(current, index) && hasBoundaryAfter(current, index + newValue.length)) return { status: "already", value: current };
    newCursor = index + newValue.length;
  }
  return { status: "stale", value: current };
}

export function globToRegExp(pattern, { caseInsensitive = false } = {}) {
  let output = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        output += ".*";
        index += 1;
      } else output += "[^/]*";
    } else if (char === "?") output += "[^/]";
    else output += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  output += "$";
  return new RegExp(output, caseInsensitive ? "i" : "");
}
