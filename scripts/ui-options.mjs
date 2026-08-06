import { deepClone } from "./path-utils.mjs";

/**
 * Read scan checkboxes from a rendered ApplicationV2 root without discarding
 * previously stored values when a control is temporarily absent.
 */
export function readScanOptionsFromRoot(root, currentOptions = {}, defaults = {}) {
  const output = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const input = root?.querySelector?.(`input[name="${key}"]`);
    if (input && typeof input.checked === "boolean") output[key] = input.checked;
    else if (typeof currentOptions[key] === "boolean") output[key] = currentOptions[key];
    else output[key] = fallback;
  }
  return deepClone(output);
}
