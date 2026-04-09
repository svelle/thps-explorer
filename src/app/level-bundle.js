import { extractEntry } from "../../pkr.js";
import { parsePsxExternalTextureSource } from "../../psx-textures.js";
import { clearAutoPsxTextureSource, updatePsxExternalSourceLabel } from "./psx-texture-source.js";
import { state } from "./state.js";

/**
 * Supports both `SKHAN.PSX` + `SKHAN_L.PSX` and numbered variants like
 * `SKHAN_2.PSX` + `SKHAN_L2.PSX` + `SKHAN_O2.PSX`.
 *
 * @param {string} name
 * @returns {{ prefix: string, base: string, variant: string, role: "main" | "texture" | "occluded" | "triggers" } | null}
 */
export function parseLevelBundleName(name) {
  const texture = name.match(/^(.*)_L(\d*)\.psx$/i);
  if (texture) {
    const base = texture[1];
    const variant = texture[2] || "";
    return { prefix: variant ? `${base}_${variant}` : base, base, variant, role: "texture" };
  }

  const occluded = name.match(/^(.*)_O(\d*)\.psx$/i);
  if (occluded) {
    const base = occluded[1];
    const variant = occluded[2] || "";
    return { prefix: variant ? `${base}_${variant}` : base, base, variant, role: "occluded" };
  }

  const trigger = name.match(/^(.*)_T(\d*)\.trg$/i);
  if (trigger) {
    const base = trigger[1];
    const variant = trigger[2] || "";
    return { prefix: variant ? `${base}_${variant}` : base, base, variant, role: "triggers" };
  }

  const main = name.match(/^(.*?)(?:_(\d+))?\.psx$/i);
  if (main) {
    const base = main[1];
    const variant = main[2] || "";
    return { prefix: variant ? `${base}_${variant}` : base, base, variant, role: "main" };
  }
  return null;
}

/**
 * @param {import("../../pkr.js").PkrDir} dir
 * @param {number | null | undefined} index
 */
export function getDirEntryAt(dir, index) {
  if (index == null || index < 0 || index >= dir.files.length) return null;
  return { index, entry: dir.files[index] };
}

/**
 * @param {import("../../pkr.js").PkrDir} dir
 * @param {number} fi
 */
export function getLevelBundleForEntry(dir, fi) {
  const current = dir.files[fi];
  if (!current) return null;
  const parsed = parseLevelBundleName(current.name);
  if (!parsed) return null;

  const byLower = new Map(dir.files.map((entry, index) => [entry.name.toLowerCase(), index]));
  const variantSuffix = parsed.variant ? `_${parsed.variant}` : "";
  const textureVariantSuffix = parsed.variant || "";
  const mainIndex = byLower.get(`${parsed.base}${variantSuffix}.psx`.toLowerCase()) ?? null;
  const textureIndex =
    byLower.get(`${parsed.base}_l${textureVariantSuffix}.psx`.toLowerCase()) ?? null;
  const occludedIndex =
    byLower.get(`${parsed.base}_o${textureVariantSuffix}.psx`.toLowerCase()) ?? null;
  const triggerIndex =
    byLower.get(`${parsed.base}_t${textureVariantSuffix}.trg`.toLowerCase()) ??
    byLower.get(`${parsed.base}_t.trg`.toLowerCase()) ??
    null;
  const hasCompanion =
    mainIndex != null || textureIndex != null || occludedIndex != null || triggerIndex != null;
  if (!hasCompanion) return null;

  return {
    prefix: parsed.prefix,
    role: parsed.role,
    main: getDirEntryAt(dir, mainIndex),
    texture: getDirEntryAt(dir, textureIndex),
    occluded: getDirEntryAt(dir, occludedIndex),
    triggers: getDirEntryAt(dir, triggerIndex),
  };
}

/**
 * @param {number} di
 * @param {number} fi
 */
export async function resolveAutoPsxTextureSource(di, fi) {
  clearAutoPsxTextureSource();
  if (!state.currentArchive || !state.currentBuffer) {
    updatePsxExternalSourceLabel();
    return null;
  }
  const dir = state.currentArchive.dirs[di];
  const bundle = dir ? getLevelBundleForEntry(dir, fi) : null;
  if (!bundle || !bundle.texture || bundle.role === "texture") {
    updatePsxExternalSourceLabel();
    return bundle;
  }

  const cacheKey = `${di}:${bundle.texture.index}:${bundle.texture.entry.offset}:${bundle.texture.entry.uncompressed_size}`;
  let parsed = state.autoPsxTextureCache.get(cacheKey);
  if (parsed === undefined) {
    try {
      const bytes = await extractEntry(state.currentBuffer, bundle.texture.entry);
      parsed = parsePsxExternalTextureSource(bytes);
    } catch {
      parsed = null;
    }
    state.autoPsxTextureCache.set(cacheKey, parsed ?? null);
  }
  if (parsed) {
    state.autoPsxTextureSource = parsed;
    state.autoPsxTextureSourceName = `${dir.name}/${bundle.texture.entry.name}`;
  }
  updatePsxExternalSourceLabel();
  return bundle;
}

/**
 * @param {"main" | "texture" | "occluded" | "triggers"} role
 */
export function describeLevelBundleRole(role) {
  switch (role) {
    case "main":
      return "Main geometry / collision";
    case "texture":
      return "Texture library";
    case "occluded":
      return "Alternate / occluded mesh";
    case "triggers":
      return "Triggers / scripts metadata";
    default:
      return role;
  }
}
