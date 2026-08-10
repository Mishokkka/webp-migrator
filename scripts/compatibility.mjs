export const IMAGE_HOVER_MODULE_ID = "image-hover";
export const IMAGE_HOVER_SPECIFIC_ART_SENTINEL = "path/image.png";
export const IMAGE_HOVER_SPECIFIC_ART_SENTINEL_WEBP = "path/image.webp";

export function isImageHoverSpecificArtField(fieldPath) {
  if (!Array.isArray(fieldPath) || fieldPath.length < 3) return false;
  const offset = fieldPath.length - 3;
  return fieldPath[offset] === "flags"
    && fieldPath[offset + 1] === IMAGE_HOVER_MODULE_ID
    && fieldPath[offset + 2] === "specificArt";
}

export function isImageHoverSpecificArtSentinel(value, fieldPath) {
  return isImageHoverSpecificArtField(fieldPath)
    && String(value ?? "").trim() === IMAGE_HOVER_SPECIFIC_ART_SENTINEL;
}

export function missingAssetReplacementForRef(ref, fallback) {
  return isImageHoverSpecificArtField(ref?.fieldPath)
    ? IMAGE_HOVER_SPECIFIC_ART_SENTINEL
    : fallback;
}

export function isAllowedPlaceholderValue(ref, value, fallback) {
  if (!isImageHoverSpecificArtField(ref?.fieldPath)) return value === fallback;
  // 0.4.2/0.4.3 accidentally used the generic Foundry placeholder here.
  // Keep accepting that legacy value so old migration reports remain rollbackable.
  return value === IMAGE_HOVER_SPECIFIC_ART_SENTINEL || value === fallback;
}
