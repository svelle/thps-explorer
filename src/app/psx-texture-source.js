import { getDom } from "./dom.js";
import { state } from "./state.js";
import { parsePsxLevelGeometry } from "../../psx-model.js";

/**
 * @param {ReturnType<typeof parsePsxLevelGeometry> | null} parsed
 */
export function setCurrentPsxExportTextures(parsed) {
  state.currentPsxExportTextures = [];
  if (!parsed?.textured) {
    updatePsxTextureExportState();
    return;
  }
  const seen = new Set();
  for (const key of parsed.textured.materialKeys) {
    const tex = parsed.textured.textureBank.get(key);
    if (!tex || seen.has(tex.texIndex)) continue;
    seen.add(tex.texIndex);
    state.currentPsxExportTextures.push(tex);
  }
  updatePsxTextureExportState();
}

export function updatePsxTextureExportState() {
  const dom = getDom();
  dom.previewPsxExportTextureBtn.disabled = state.currentPsxExportTextures.length === 0;
}

export function clearAutoPsxTextureSource() {
  state.autoPsxTextureSource = null;
  state.autoPsxTextureSourceName = "";
}

export function updatePsxExternalSourceLabel() {
  const dom = getDom();
  if (state.externalPsxTextureSourceName) {
    dom.previewPsxSourceName.textContent = `Manual: ${state.externalPsxTextureSourceName}`;
    return;
  }
  if (state.autoPsxTextureSourceName) {
    dom.previewPsxSourceName.textContent = `Auto: ${state.autoPsxTextureSourceName}`;
    return;
  }
  dom.previewPsxSourceName.textContent = "No external texture source";
}

export function getActivePsxTextureSource() {
  return state.externalPsxTextureSource ?? state.autoPsxTextureSource;
}
