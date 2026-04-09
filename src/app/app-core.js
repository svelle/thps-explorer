import {
  parsePkr,
  extractEntry,
  verifyCrc,
  crc32,
  formatLabel,
  COMPRESSED_ZLIB,
  UNCOMPRESSED,
  loadFflate,
} from "../../pkr.js";
import { parsePrk, hexBytes } from "../../prk.js";
import {
  parsePsxLevelGeometry,
  parsePsxPerPartPreviewData,
  dumpPsxCharacterPadDiagnostics,
  PSX_CHARACTER_ASSEMBLY_STORAGE_KEY,
} from "../../psx-model.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { parsePsxExternalTextureSource } from "../../psx-textures.js";
import {
  scanPsxAnimationHeuristic,
  ensurePartBindPoseUserData,
  restorePartBindPose,
  applyDemoRigidPartWave,
  applyPsxAnimClipFrame,
} from "../../psx-animation.js";

import { initDomRefs, getDom, getInspectorPanel } from "./dom.js";
import { state } from "./state.js";
import {
  STORAGE_WAV_AUTOPLAY,
  STORAGE_FILE_VIEW,
  STORAGE_INSPECTOR_WIDTH,
  STORAGE_BMP_FIT,
  STORAGE_AUTO_RESTORE,
  STORAGE_PSX_DEBUG_MODE,
  STORAGE_PSX_SURFACE_MODE,
  HISTORY_DB_NAME,
  HISTORY_DB_VER,
  HISTORY_META,
  HISTORY_MAX_ENTRIES,
  INSPECTOR_WIDTH_MIN,
  INSPECTOR_WIDTH_MAX,
  INSPECTOR_LAYOUT_MIN_VIEWPORT,
  DEFAULT_PREVIEW_HINT,
  MAX_FULL_HEX_COPY,
  TILE_BMP_THUMB_MAX_BYTES,
  TILE_PSX_THUMB_MAX_BYTES,
  PSX_TILE_THUMB_PX,
  THUMB_LOAD_CAP,
} from "./storage-keys.js";
import {
  getLevelBundleForEntry,
  resolveAutoPsxTextureSource,
  describeLevelBundleRole,
} from "./level-bundle.js";
import {
  clearAutoPsxTextureSource,
  getActivePsxTextureSource,
  setCurrentPsxExportTextures,
  updatePsxExternalSourceLabel,
  updatePsxTextureExportState,
} from "./psx-texture-source.js";
import { downloadIconSvg, folderZipIconSvg } from "./icons.js";
import {
  nf,
  formatBytes,
  formatHexByte,
  formatHexU32,
  formatHex,
  tryUtf8Preview,
  escapeHtml,
  formatRecentTime,
} from "./format.js";

/**
 * Three.js WebGLCapabilities assumes `gl.getShaderPrecisionFormat` never returns null; the WebGL
 * spec allows null (e.g. lost context / some drivers), which throws when reading `.precision`.
 */
let _shaderPrecisionPolyfillInstalled = false;
function ensureShaderPrecisionFormatPolyfill() {
  if (_shaderPrecisionPolyfillInstalled) return;
  _shaderPrecisionPolyfillInstalled = true;
  if (typeof WebGLRenderingContext === "undefined") return;
  const fallback = Object.freeze({ precision: 23, rangeMin: 127, rangeMax: 127 });
  /**
   * @param {{ getShaderPrecisionFormat?: (a: number, b: number) => WebGLShaderPrecisionFormat | null }} Proto
   */
  function wrap(Proto) {
    if (!Proto || typeof Proto.getShaderPrecisionFormat !== "function") return;
    const orig = Proto.getShaderPrecisionFormat;
    Proto.getShaderPrecisionFormat = function (shaderType, precisionType) {
      const r = orig.call(this, shaderType, precisionType);
      return r ?? fallback;
    };
  }
  wrap(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== "undefined") {
    wrap(WebGL2RenderingContext.prototype);
  }
}

initDomRefs();
const {
  fileInput,
  skipCrc,
  welcomeEl,
  workspaceEl,
  welcomeDrop,
  archiveSummary,
  summaryFilename,
  summaryFormat,
  summaryStats,
  navFolderCount,
  folderTitle,
  folderSubtitle,
  fileFilter,
  fileTypeFilterBtn,
  fileTypeFilterLabel,
  fileTypeFilterPanel,
  fileTypeFilterWrap,
  treeEl,
  filesBody,
  filesTiles,
  filesListPanel,
  filesTilePanel,
  tableShell,
  viewModeListBtn,
  viewModeTilesBtn,
  inspectorResizeHandle,
  detailEl,
  inspectorFileTitle,
  inspectorFileKind,
  inspectorPaneActions,
  previewPsxStatsHud,
  previewPsxToolbarEl,
  previewBlock,
  previewHomeAnchor,
  previewEl,
  previewHint,
  previewAudioWrap,
  previewAudio,
  previewAudioPlay,
  previewAudioSeek,
  previewAudioTimeCurrent,
  previewAudioTimeDuration,
  previewAudioPlayIcon,
  previewVolumeRange,
  previewAutoplay,
  previewPrkWrap,
  previewPrkColorMode,
  previewPrkSummary,
  previewPrkGrid,
  previewPrkSelection,
  previewPrkGaps,
  previewImageWrap,
  previewImage,
  previewImageToolbar,
  previewBmpFit,
  previewPopoutBtn,
  previewPopoutLabel,
  previewCopyBtn,
  previewPsxWrap,
  previewPsxCanvas,
  previewPsxUvCanvas,
  previewPsxCanvasStack,
  previewPsxViewMode3d,
  previewPsxViewModeUv,
  previewPsxDebugMode,
  previewPsxTextured,
  previewPsxAssemble,
  previewPsxPadReport,
  previewPsxSourceBtn,
  previewPsxExportTextureBtn,
  previewPsxSourceInput,
  previewPsxSourceName,
  previewPsxPartsAside,
  previewPsxPartsToggle,
  previewPsxPartList,
  previewPsxAnimRow,
  previewPsxAnimMode,
  previewPsxAnimPlay,
  previewPsxAnimFrame,
  previewPsxAnimStatus,
  statusEl,
  btnDownload,
  helpDialog,
  previewPopoutDialog,
  previewPopoutSlot,
  previewPopoutClose,
  helpClose,
  recentWrap,
  recentList,
  recentAutoRestore,
  recentClear,
} = getDom();

/**
 * @param {number} texW
 * @param {number} texH
 * @param {number} boxW
 * @param {number} boxH
 */
function letterboxContain(texW, texH, boxW, boxH) {
  const tw = Math.max(1, texW);
  const th = Math.max(1, texH);
  const s = Math.min(boxW / tw, boxH / th);
  const dw = tw * s;
  const dh = th * s;
  const dx = (boxW - dw) / 2;
  const dy = (boxH - dh) / 2;
  return { dx, dy, dw, dh };
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Uint8Array} rgba
 * @param {number} tw
 * @param {number} th
 * @param {number} dx
 * @param {number} dy
 * @param {number} dw
 * @param {number} dh
 */
function drawRgbaToCanvasRect(ctx, rgba, tw, th, dx, dy, dw, dh) {
  const tmp = document.createElement("canvas");
  tmp.width = tw;
  tmp.height = th;
  const tctx = tmp.getContext("2d");
  if (!tctx) return;
  const img = tctx.createImageData(tw, th);
  const n = tw * th * 4;
  const u8 = new Uint8ClampedArray(n);
  u8.set(rgba.subarray(0, n));
  img.data.set(u8);
  tctx.putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0, tw, th, dx, dy, dw, dh);
}

/**
 * Texture sheet + UV triangle overlay (top-origin V, matches psx-model + DataTexture flipY=false).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cw
 * @param {number} ch
 * @param {NonNullable<ReturnType<typeof parsePsxLevelGeometry>["textured"]>} textured
 */
function drawPsxUvTexturePreview(ctx, cw, ch, textured) {
  const { indices, uvs, groups, materialKeys, textureBank } = textured;
  ctx.fillStyle = "#12151c";
  ctx.fillRect(0, 0, cw, ch);

  const keysOrdered = [...new Set(materialKeys)];
  const sheets = keysOrdered
    .map((key) => {
      const e = textureBank.get(key);
      return e && e.width > 0 && e.height > 0
        ? { key, rgba: e.rgba, width: e.width, height: e.height }
        : null;
    })
    .filter(Boolean);

  if (sheets.length === 0) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = "#8fa8c8";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText("No decoded texture — UV sheet unavailable.", 12, 24);
    return;
  }

  const n = sheets.length;
  const layout = new Map();
  for (let i = 0; i < n; i++) {
    const s = sheets[i];
    const y0 = (i / n) * ch;
    const y1 = ((i + 1) / n) * ch;
    const bh = y1 - y0;
    const lb = letterboxContain(s.width, s.height, cw, bh);
    layout.set(s.key, { dx: lb.dx, dy: y0 + lb.dy, dw: lb.dw, dh: lb.dh });
    drawRgbaToCanvasRect(ctx, s.rgba, s.width, s.height, lb.dx, y0 + lb.dy, lb.dw, lb.dh);
  }

  ctx.strokeStyle = "rgba(0, 240, 255, 0.82)";
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";
  for (const g of groups) {
    const key = materialKeys[g.materialIndex];
    const rect = layout.get(key);
    if (!rect) continue;
    const { dx, dy, dw, dh } = rect;
    for (let j = g.start; j < g.start + g.count; j += 3) {
      const ia = indices[j];
      const ib = indices[j + 1];
      const ic = indices[j + 2];
      const ua = uvs[ia * 2];
      const va = uvs[ia * 2 + 1];
      const ub = uvs[ib * 2];
      const vb = uvs[ib * 2 + 1];
      const uc = uvs[ic * 2];
      const vc = uvs[ic * 2 + 1];
      ctx.beginPath();
      ctx.moveTo(dx + ua * dw, dy + va * dh);
      ctx.lineTo(dx + ub * dw, dy + vb * dh);
      ctx.lineTo(dx + uc * dw, dy + vc * dh);
      ctx.closePath();
      ctx.stroke();
    }
  }
}

/**
 * @param {string} fileName
 * @param {number} byteLength
 */
function createStandalonePrkArchive(fileName, byteLength) {
  return {
    format: "thps2",
    dirs: [
      {
        name: "(standalone file)",
        files: [
          {
            name: fileName,
            crc: null,
            compression: UNCOMPRESSED,
            offset: 0,
            uncompressed_size: byteLength,
            compressed_size: byteLength,
          },
        ],
      },
    ],
  };
}

/** Lowercase extension including leading dot, or `""` if none. */
function getFileExtension(filename) {
  const base = filename.replace(/^.*[/\\]/, "");
  const i = base.lastIndexOf(".");
  if (i <= 0 || i === base.length - 1) return "";
  return base.slice(i).toLowerCase();
}

/** Uppercase ext for display (e.g. `.PSX`), or `—` if absent. */
function formatFileExtDisplay(filename) {
  const ext = getFileExtension(filename);
  if (!ext) return "—";
  return ext.toUpperCase();
}

/**
 * @param {import("../../pkr.js").PkrFileEntry} entry
 */
function inspectorKindLabel(entry) {
  const base = entry.name.replace(/^.*[/\\]/, "");
  const lower = base.toLowerCase();
  if (lower.endsWith(".psx")) return "PSX mesh";
  if (lower.endsWith(".psh")) return "PSX skeleton";
  if (lower.endsWith(".prk")) return "PRK park";
  if (lower.endsWith(".wav")) return "WAV audio";
  if (lower.endsWith(".bmp")) return "BMP image";
  if (lower.endsWith(".png")) return "PNG image";
  if (lower.endsWith(".lua")) return "Lua";
  if (lower.endsWith(".json")) return "JSON";
  if (lower.endsWith(".trg")) return "TRG triggers";
  const ext = getFileExtension(entry.name);
  if (!ext) return "Binary";
  return `${ext.replace(".", "").toUpperCase()} data`;
}

/**
 * @returns {"file-tile__hero--cyan" | "file-tile__hero--orange" | "file-tile__hero--lime"}
 */
function fileTileHeroClass(filename) {
  const ext = getFileExtension(filename);
  if ([".lua", ".prk", ".json"].includes(ext)) return "file-tile__hero--orange";
  if ([".pkr", ".pak", ".cat"].includes(ext)) return "file-tile__hero--lime";
  if ([".psx", ".psh", ".bmp", ".wav", ".png", ".tex"].includes(ext)) return "file-tile__hero--cyan";
  return "file-tile__hero--cyan";
}

/** Effective on-disk size for this entry (compressed payload vs stored). */
function inArchiveBytes(entry) {
  return entry.compression === COMPRESSED_ZLIB ? entry.compressed_size : entry.uncompressed_size;
}

/** @param {{ compression: number }} entry */
function compressionUi(entry) {
  const hex = `0x${(entry.compression >>> 0).toString(16)}`;
  if (entry.compression === COMPRESSED_ZLIB) {
    return {
      label: "Zlib",
      pillClass: "compression-pill compression-pill--zlib",
      title: `Compressed (${hex})`,
    };
  }
  if (entry.compression === UNCOMPRESSED) {
    return {
      label: "Stored",
      pillClass: "compression-pill",
      title: `Uncompressed (${hex})`,
    };
  }
  return { label: hex, pillClass: "compression-pill", title: hex };
}

/**
 * @param {import("./pkr.js").PkrDir} dir
 * @returns {Array<{ entry: import("./pkr.js").PkrFileEntry, originalIndex: number }>}
 */
function getSortedFileDisplayOrder(dir) {
  const rows = dir.files.map((entry, originalIndex) => ({ entry, originalIndex }));
  const { key, dir: dirn } = state.fileListSort;
  const mul = dirn === "asc" ? 1 : -1;

  rows.sort((a, b) => {
    let c = 0;
    switch (key) {
      case "name":
        c = a.entry.name.localeCompare(b.entry.name, undefined, {
          sensitivity: "base",
          numeric: true,
        });
        break;
      case "compression":
        c = a.entry.compression - b.entry.compression;
        break;
      case "size":
        c = a.entry.uncompressed_size - b.entry.uncompressed_size;
        break;
      case "archive":
        c = inArchiveBytes(a.entry) - inArchiveBytes(b.entry);
        break;
      case "offset":
        c = a.entry.offset - b.entry.offset;
        break;
      case "ext":
        c = getFileExtension(a.entry.name).localeCompare(getFileExtension(b.entry.name), undefined, {
          sensitivity: "base",
        });
        break;
      default:
        c = 0;
    }
    if (c !== 0) return c * mul;
    return a.originalIndex - b.originalIndex;
  });

  return rows;
}

function syncFileSortHeaderUi() {
  const table = filesBody.closest("table");
  if (!table) return;
  table.querySelectorAll(".files-table__th").forEach((th) => {
    th.classList.remove("is-sorted-asc", "is-sorted-desc");
    th.removeAttribute("aria-sort");
  });
  table.querySelectorAll("[data-sort-key]").forEach((btn) => {
    const th = btn.closest("th");
    const sk = /** @type {string} */ (btn.dataset.sortKey);
    if (!th || !sk) return;
    const label =
      sk === "name"
        ? "Filename"
        : sk === "compression"
          ? "Type"
          : sk === "ext"
            ? "Ext"
            : sk === "size"
              ? "Size"
              : sk === "archive"
                ? "Packed"
                : sk === "offset"
                  ? "Offset"
                  : sk;
    if (state.fileListSort.key === sk) {
      const asc = state.fileListSort.dir === "asc";
      th.classList.add(asc ? "is-sorted-asc" : "is-sorted-desc");
      th.setAttribute("aria-sort", asc ? "ascending" : "descending");
      btn.title = `Sorted ${asc ? "A→Z / low→high" : "Z→A / high→low"} — click to reverse`;
      btn.setAttribute(
        "aria-label",
        `${label}, sorted ${asc ? "ascending" : "descending"}, press to reverse sort`
      );
    } else {
      th.setAttribute("aria-sort", "none");
      btn.title = "Sort by this column";
      btn.setAttribute("aria-label", `${label}, sort`);
    }
  });
}

/**
 * @param {string} dir
 * @param {string} file
 */
function downloadBasename(dir, file) {
  const safe = (s) =>
    s
      .replace(/[/\\?*:|"<>]/g, "_")
      .replace(/\.\./g, "_")
      .trim() || "unnamed";
  return `${safe(dir)}__${safe(file)}`;
}

/**
 * @param {number} di
 * @param {number} fi
 */
async function downloadFileEntry(di, fi) {
  if (!state.currentArchive || !state.currentBuffer || di < 0 || fi < 0) return;
  const dir = state.currentArchive.dirs[di];
  const entry = dir.files[fi];
  const skip = skipCrc.checked;
  setStatus(`Downloading ${entry.name}…`);
  try {
    const data = await extractEntry(state.currentBuffer, entry);
    const hasCrc = entry.crc != null;
    if (hasCrc && !skip && !verifyCrc(entry, data)) {
      setStatus(`CRC mismatch for ${entry.name} — enable Skip CRC or fix the archive.`);
      return;
    }
    const blob = new Blob([data], { type: "application/octet-stream" });
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = downloadBasename(dir.name, entry.name);
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Saved ${entry.name}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(msg);
  }
}

/**
 * @param {number} di
 * @param {number} fi
 * @param {string} entryName
 */
function makeInlineDownloadButton(di, fi, entryName) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "files-inline-dl";
  btn.appendChild(downloadIconSvg("icon-download files-inline-dl__icon"));
  btn.title = `Download ${entryName}`;
  btn.setAttribute("aria-label", `Download ${entryName}`);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    void downloadFileEntry(di, fi);
  });
  return btn;
}

/**
 * @param {HTMLElement} tile
 * @param {() => void} onSelect
 */
function wireFileTileInteractions(tile, onSelect) {
  tile.tabIndex = 0;
  tile.setAttribute("role", "listitem");
  tile.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest(".files-inline-dl")) return;
    onSelect();
  });
  tile.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target instanceof Element && e.target.closest(".files-inline-dl")) return;
    e.preventDefault();
    onSelect();
  });
}

/** Path segments only — drops empty, `.`, `..`, and normalizes slashes. */
function zipCleanPathSegments(s) {
  return s
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p && p !== "." && p !== "..");
}

/**
 * Relative path inside the zip: `{folder}/file` using PKR dir + file names.
 * @param {string} dirName
 * @param {string} fileName
 */
function zipEntryPath(dirName, fileName) {
  const dirPart = zipCleanPathSegments(dirName || "").join("/");
  const fileParts = zipCleanPathSegments(fileName || "");
  const base = fileParts.length ? fileParts[fileParts.length - 1] : "unnamed";
  if (dirPart) return `${dirPart}/${base}`;
  return base || "unnamed";
}

/**
 * @param {number} di
 */
async function downloadFolderZip(di) {
  if (!state.currentArchive || !state.currentBuffer || di < 0 || di >= state.currentArchive.dirs.length) return;
  const dir = state.currentArchive.dirs[di];
  if (dir.files.length === 0) {
    setStatus("Folder is empty — nothing to zip.");
    return;
  }
  const skip = skipCrc.checked;
  const folderSlug =
    zipCleanPathSegments(dir.name || "folder").join("_") || "folder";
  const used = new Set();
  /** @param {string} p */
  function uniqueZipPath(p) {
    if (!used.has(p)) {
      used.add(p);
      return p;
    }
    const dot = p.lastIndexOf(".");
    let i = 1;
    let q = p;
    if (dot > 0) {
      const base = p.slice(0, dot);
      const ext = p.slice(dot);
      do {
        q = `${base}_${i}${ext}`;
        i++;
      } while (used.has(q));
    } else {
      do {
        q = `${p}_${i}`;
        i++;
      } while (used.has(q));
    }
    used.add(q);
    return q;
  }

  setStatus(`Zipping ${dir.name}…`);
  try {
    const fflate = await loadFflate();
    const zip = fflate.zip;
    if (typeof zip !== "function") {
      throw new Error("fflate zip() not available from module");
    }

    /** @type {Record<string, Uint8Array>} */
    const files = {};
    for (let i = 0; i < dir.files.length; i++) {
      const entry = dir.files[i];
      setStatus(`Zipping ${dir.name}… ${nf.format(i + 1)}/${nf.format(dir.files.length)}`);
      const data = await extractEntry(state.currentBuffer, entry);
      const hasCrc = entry.crc != null;
      if (hasCrc && !skip && !verifyCrc(entry, data)) {
        throw new Error(`CRC mismatch for ${entry.name} (try Skip CRC or fix the entry)`);
      }
      const rel = uniqueZipPath(zipEntryPath(dir.name, entry.name));
      files[rel] = data;
    }

    const zipped = await new Promise((resolve, reject) => {
      zip(files, { level: 0 }, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
    const blob = new Blob([zipped], { type: "application/zip" });
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `${folderSlug}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Saved ${folderSlug}.zip (${nf.format(dir.files.length)} files).`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`ZIP failed: ${msg}`);
  }
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function updatePreviewPopoutUi() {
  previewPopoutLabel.textContent = state.previewIsPoppedOut ? "Dock" : "Pop out";
  previewPopoutBtn.title = state.previewIsPoppedOut
    ? "Return the preview to the sidebar"
    : "Open the preview in a larger pop-out window";
}

function dockPreviewBlock() {
  if (!state.previewIsPoppedOut) return;
  previewHomeAnchor.before(previewBlock);
  state.previewIsPoppedOut = false;
  updatePreviewPopoutUi();
}

function openPreviewPopout() {
  if (state.previewIsPoppedOut) return;
  previewPopoutSlot.appendChild(previewBlock);
  state.previewIsPoppedOut = true;
  updatePreviewPopoutUi();
  if (!previewPopoutDialog.open) previewPopoutDialog.showModal();
}

function togglePreviewPopout() {
  if (state.previewIsPoppedOut) {
    if (previewPopoutDialog.open) previewPopoutDialog.close();
    else dockPreviewBlock();
    return;
  }
  openPreviewPopout();
}

function setViewMode(/** @type {'welcome' | 'workspace'} */ mode) {
  const isWelcome = mode === "welcome";
  welcomeEl.classList.toggle("is-hidden", !isWelcome);
  workspaceEl.classList.toggle("is-hidden", isWelcome);
  archiveSummary.classList.toggle("is-hidden", isWelcome || !state.currentArchive);
}

function syncFileViewPanels() {
  const isList = state.fileViewMode === "list";
  filesListPanel.classList.toggle("is-hidden", !isList);
  filesTilePanel.classList.toggle("is-hidden", isList);
  viewModeListBtn.classList.toggle("is-active", isList);
  viewModeTilesBtn.classList.toggle("is-active", !isList);
  viewModeListBtn.setAttribute("aria-pressed", isList ? "true" : "false");
  viewModeTilesBtn.setAttribute("aria-pressed", isList ? "false" : "true");
}

function setFileViewMode(/** @type {"list" | "tiles"} */ mode) {
  state.fileViewMode = mode;
  try {
    localStorage.setItem(STORAGE_FILE_VIEW, mode);
  } catch {
    /* ignore */
  }
  syncFileViewPanels();
  if (state.currentArchive && state.selectedDirIndex >= 0) {
    renderFilesTable(state.selectedDirIndex, { preserveFilter: true });
    highlightSelection(state.selectedDirIndex, state.selectedFileIndex);
  }
}

function revokePreviewAudioUrl() {
  if (state.previewAudioObjectUrl) {
    URL.revokeObjectURL(state.previewAudioObjectUrl);
    state.previewAudioObjectUrl = null;
  }
}

function hideAudioPreview() {
  previewAudio.pause();
  previewAudio.removeAttribute("src");
  previewAudio.load();
  revokePreviewAudioUrl();
  resetAudioPlayerUi();
  previewAudioWrap.classList.add("is-hidden");
}

function revokePreviewImageUrl() {
  if (state.previewImageObjectUrl) {
    URL.revokeObjectURL(state.previewImageObjectUrl);
    state.previewImageObjectUrl = null;
  }
}

function hideImagePreview() {
  revokePreviewImageUrl();
  previewImage.removeAttribute("src");
  previewImage.alt = "";
  previewImageWrap.classList.add("is-hidden");
  previewImageToolbar.classList.add("is-hidden");
}

function hidePrkPreview() {
  state.prkPreviewState = null;
  previewPrkWrap.classList.add("is-hidden");
  previewPrkSummary.textContent = "";
  previewPrkGrid.replaceChildren();
  previewPrkGrid.style.removeProperty("--prk-cols");
  previewPrkSelection.textContent = "Select a cell.";
  previewPrkGaps.replaceChildren();
}

function disposePsxPreview() {
  if (state.psxPreviewCtx) {
    if ("viewAbort" in state.psxPreviewCtx && state.psxPreviewCtx.viewAbort) {
      state.psxPreviewCtx.viewAbort.abort();
    }
    cancelAnimationFrame(state.psxPreviewCtx.state.rafId);
    state.psxPreviewCtx.controls.dispose();
    if (state.psxPreviewCtx.mesh?.isGroup) {
      restorePartBindPose(state.psxPreviewCtx.mesh);
    }
    const { overlayRef, scene } = state.psxPreviewCtx;
    for (const h of overlayRef.vertNormHelpers) {
      scene.remove(h);
      if (typeof h.dispose === "function") h.dispose();
    }
    overlayRef.vertNormHelpers.length = 0;
    if (overlayRef.edgesLines) {
      const o = overlayRef.edgesLines;
      if (o.parent) o.parent.remove(o);
      if (o.type === "LineSegments") {
        o.geometry.dispose();
        o.material.dispose();
      } else if (o.type === "Group") {
        for (const c of o.children) {
          if (c.type === "LineSegments") {
            c.geometry.dispose();
            c.material.dispose();
          }
        }
      }
      overlayRef.edgesLines = null;
    }
    if (overlayRef.uDirLines) {
      scene.remove(overlayRef.uDirLines);
      overlayRef.uDirLines.geometry.dispose();
      overlayRef.uDirLines.material.dispose();
      overlayRef.uDirLines = null;
    }
    for (const g of state.psxPreviewCtx.geoms) g.dispose();
    if (state.psxPreviewCtx.psxGround) {
      scene.remove(state.psxPreviewCtx.psxGround);
      state.psxPreviewCtx.psxGround.geometry.dispose();
      state.psxPreviewCtx.psxGround.material.dispose();
    }
    if (state.psxPreviewCtx.texMaterials) {
      for (const m of state.psxPreviewCtx.texMaterials) {
        if ("map" in m && m.map) m.map.dispose();
        m.dispose();
      }
    }
    if (state.psxPreviewCtx.partTexMaterials) {
      for (const m of state.psxPreviewCtx.partTexMaterials) {
        if ("map" in m && m.map) m.map.dispose();
        m.dispose();
      }
    }
    state.psxPreviewCtx.mats.shaded.dispose();
    state.psxPreviewCtx.mats.wire.dispose();
    state.psxPreviewCtx.mats.normal.dispose();
    state.psxPreviewCtx.mats.uvWinding.dispose();
    state.psxPreviewCtx.renderer.dispose();
    state.psxPreviewCtx.ro.disconnect();
    state.psxPreviewCtx = null;
  }
  state.currentPsxExportTextures = [];
  updatePsxTextureExportState();
  previewPsxWrap.classList.add("is-hidden");
  previewPsxToolbarEl.classList.add("is-hidden");
  previewPsxStatsHud.textContent = "";
  previewPsxPartsAside.classList.add("is-hidden");
  previewPsxPartList.replaceChildren();
  previewPsxPartsAside.classList.remove("is-collapsed");
  previewPsxPartList.hidden = false;
  previewPsxPartsToggle.setAttribute("aria-expanded", "true");
  previewPsxAnimRow.classList.add("is-hidden");
  previewPsxAnimMode.value = "off";
  previewPsxAnimPlay.textContent = "Play";
  previewPsxAnimFrame.disabled = true;
  previewPsxAnimStatus.textContent = "";
  previewBlock.classList.remove("preview-block--psx-toolbar");
}

function updateCopyButtonState() {
  previewCopyBtn.disabled = state.previewClipboardText.length === 0;
}

function getCurrentPsxTextureExportFilename() {
  if (!state.currentArchive || state.selectedDirIndex < 0 || state.selectedFileIndex < 0) return "psx-textures.png";
  const dir = state.currentArchive.dirs[state.selectedDirIndex];
  const entry = dir?.files[state.selectedFileIndex];
  const stem = (entry?.name || "psx-model").replace(/\.[^.]+$/, "");
  const suffix = state.currentPsxExportTextures.length === 1 ? "texture" : "textures";
  return `${downloadBasename(dir?.name || "root", stem)}__${suffix}.png`;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Blob>}
 */
function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG export failed"));
    }, "image/png");
  });
}

/**
 * @param {import("./psx-textures.js").PsxDecodedTexture[]} textures
 */
function buildPsxTextureExportCanvas(textures) {
  if (textures.length === 1) {
    const tex = textures[0];
    const canvas = document.createElement("canvas");
    canvas.width = tex.width;
    canvas.height = tex.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    ctx.putImageData(new ImageData(tex.rgba, tex.width, tex.height), 0, 0);
    return canvas;
  }

  const padding = 8;
  const maxW = Math.max(...textures.map((tex) => tex.width));
  const maxH = Math.max(...textures.map((tex) => tex.height));
  const cols = Math.ceil(Math.sqrt(textures.length));
  const rows = Math.ceil(textures.length / cols);
  const cellW = maxW + padding * 2;
  const cellH = maxH + padding * 2;
  const canvas = document.createElement("canvas");
  canvas.width = cols * cellW;
  canvas.height = rows * cellH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.imageSmoothingEnabled = false;
  for (let i = 0; i < textures.length; i++) {
    const tex = textures[i];
    const tile = document.createElement("canvas");
    tile.width = tex.width;
    tile.height = tex.height;
    const tileCtx = tile.getContext("2d");
    if (!tileCtx) throw new Error("2D canvas unavailable");
    tileCtx.putImageData(new ImageData(tex.rgba, tex.width, tex.height), 0, 0);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cellW + padding + Math.floor((maxW - tex.width) / 2);
    const y = row * cellH + padding + Math.floor((maxH - tex.height) / 2);
    ctx.drawImage(tile, x, y);
  }
  return canvas;
}

async function exportCurrentPsxTextures() {
  if (state.currentPsxExportTextures.length === 0) {
    setStatus("No resolved model textures available to export.");
    return;
  }
  const filename = getCurrentPsxTextureExportFilename();
  try {
    setStatus(`Exporting ${filename}…`);
    const canvas = buildPsxTextureExportCanvas(state.currentPsxExportTextures);
    const blob = await canvasToPngBlob(canvas);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Saved ${filename}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(`Texture export failed: ${msg}`);
  }
}

function refreshCurrentSelection() {
  if (state.currentArchive && state.currentBuffer && state.selectedDirIndex >= 0 && state.selectedFileIndex >= 0) {
    void showFileDetail(state.selectedDirIndex, state.selectedFileIndex);
  }
}

/**
 * Windows BMP: signature `BM` (OS/2 `BA` not handled).
 * @param {Uint8Array} bytes
 */
function isBmp(bytes) {
  if (bytes.length < 26) return false;
  return bytes[0] === 0x42 && bytes[1] === 0x4d;
}

function isBmpFileName(name) {
  return /\.bmp$/i.test(name);
}

/** THPS-style skate park / custom level (not a PKR container). */
function isPrkFileName(name) {
  return /\.prk$/i.test(name);
}

/** Neversoft / Big Guns engine mesh (THPS, etc.). */
function isPsxFileName(name) {
  return /\.psx$/i.test(name);
}

/** Skeleton part enum headers (e.g. `CAMPBPART_*`) paired with skater `.psx` rigs. */
function isPshFileName(name) {
  return /\.psh$/i.test(name);
}

/**
 * @param {ReturnType<typeof parsePrk>} parsed
 */
function formatPrkSummaryText(parsed) {
  const namedGaps =
    parsed.namedGaps.length > 0 ? parsed.namedGaps.map((gap) => gap.name).join(", ") : "(none)";
  const firstHighscore = parsed.highscores.length > 0 ? hexBytes(parsed.highscores[0]) : "(none)";
  return [
    `theme: ${parsed.header.theme} (${parsed.header.width}x${parsed.header.height})`,
    `sizeIdx: ${parsed.header.sizeIdx}`,
    `themeIdx: ${parsed.header.themeIdx}`,
    `unk1: ${formatHexU32(parsed.header.unk1)}`,
    `usedCells: ${parsed.usedCellCount}/${parsed.cells.length}`,
    `namedGaps: ${parsed.namedGaps.length}/${parsed.gaps.length}`,
    `gapNames: ${namedGaps}`,
    `highscore[0]: ${firstHighscore}`,
    `trailing: ${parsed.trailing.length} bytes`,
  ].join("\n");
}

/**
 * @param {ReturnType<typeof parsePrk>["cells"][number]} cell
 * @param {string} mode
 */
function getPrkCellFieldValue(cell, mode) {
  switch (mode) {
    case "slot0":
      return cell.slot0;
    case "slot1":
      return cell.slot1;
    case "slot2":
      return cell.slot2;
    case "slot3":
      return cell.slot3;
    case "variant":
      return cell.variant;
    case "flags":
      return cell.flags;
    case "indexByte":
      return cell.indexByte;
    default:
      return cell.slot3;
  }
}

/**
 * @param {ReturnType<typeof parsePrk>["cells"][number]} cell
 * @param {string} mode
 */
function getPrkCellColor(cell, mode) {
  const value = getPrkCellFieldValue(cell, mode);
  if (value === 0xff) return "#252932";
  const hue = Math.round((value / 255) * 320);
  const saturation = cell.isEmpty ? 20 : 58;
  const lightness = cell.isEmpty ? 18 : 48;
  return `hsl(${hue}deg ${saturation}% ${lightness}%)`;
}

function renderPrkSelection() {
  if (!state.prkPreviewState) return;
  const { parsed, selectedIndex } = state.prkPreviewState;
  const cell = parsed.cells[selectedIndex];
  if (!cell) {
    previewPrkSelection.textContent = "Select a cell.";
    return;
  }
  previewPrkSelection.textContent = [
    `x=${cell.x}  y=${cell.y}  index=${cell.index}`,
    `slot0   ${formatHexByte(cell.slot0)}`,
    `slot1   ${formatHexByte(cell.slot1)}`,
    `slot2   ${formatHexByte(cell.slot2)}`,
    `slot3   ${formatHexByte(cell.slot3)}`,
    `variant ${formatHexByte(cell.variant)}`,
    `pad     ${formatHexByte(cell.pad)}`,
    `flags   ${formatHexByte(cell.flags)}`,
    `index   ${formatHexByte(cell.indexByte)}`,
    `raw     ${hexBytes(cell.raw)}`,
  ].join("\n");
}

/**
 * @param {ReturnType<typeof parsePrk>} parsed
 */
function renderPrkGapList(parsed) {
  previewPrkGaps.replaceChildren();
  if (parsed.namedGaps.length === 0) {
    const empty = document.createElement("div");
    empty.className = "preview-prk-gap preview-prk-gap--empty";
    empty.textContent = "No named gaps in this save.";
    previewPrkGaps.appendChild(empty);
    return;
  }
  for (const gap of parsed.namedGaps) {
    const item = document.createElement("div");
    item.className = "preview-prk-gap";
    const name = document.createElement("span");
    name.className = "preview-prk-gap__name";
    name.textContent = gap.name;
    const meta = document.createElement("span");
    meta.className = "preview-prk-gap__meta";
    meta.textContent = `${hexBytes(gap.raw8)} | ${hexBytes(gap.info)}`;
    item.append(name, meta);
    previewPrkGaps.appendChild(item);
  }
}

function renderPrkGrid() {
  if (!state.prkPreviewState) return;
  const { parsed, colorMode, selectedIndex } = state.prkPreviewState;
  previewPrkGrid.replaceChildren();
  previewPrkGrid.style.setProperty("--prk-cols", String(parsed.width));
  const sizePx = parsed.width >= 60 ? 12 : parsed.width >= 30 ? 14 : 18;
  previewPrkGrid.style.setProperty("--prk-cell-size", `${sizePx}px`);
  previewPrkSummary.textContent =
    `${parsed.header.theme} · ${parsed.width} x ${parsed.height} · ${nf.format(parsed.usedCellCount)} used cells`;

  for (const cell of parsed.cells) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preview-prk-cell";
    if (cell.index === selectedIndex) button.classList.add("is-selected");
    button.style.background = getPrkCellColor(cell, colorMode);
    button.title =
      `(${cell.x}, ${cell.y}) ${colorMode}=${formatHexByte(getPrkCellFieldValue(cell, colorMode))}\n` +
      `${hexBytes(cell.raw)}`;
    button.setAttribute("aria-label", `PRK cell ${cell.x}, ${cell.y}`);
    button.addEventListener("click", () => {
      if (!state.prkPreviewState) return;
      state.prkPreviewState.selectedIndex = cell.index;
      renderPrkGrid();
      renderPrkSelection();
    });
    previewPrkGrid.appendChild(button);
  }
}

/**
 * @param {ReturnType<typeof parsePrk>} parsed
 */
function showPrkPreview(parsed) {
  disposePsxPreview();
  hideAudioPreview();
  hideImagePreview();
  hidePrkPreview();
  state.previewClipboardText = formatPrkSummaryText(parsed);
  previewEl.classList.add("is-hidden");
  previewEl.textContent = "";
  previewEl.classList.remove("is-idle");
  previewHint.hidden = false;
  previewHint.textContent =
    "PRK grid inspector — colors show the selected raw byte field; click a cell to inspect its 8-byte record.";
  previewPrkWrap.classList.remove("is-hidden");
  state.prkPreviewState = {
    parsed,
    colorMode: previewPrkColorMode.value || "slot3",
    selectedIndex: parsed.cells.find((cell) => !cell.isEmpty)?.index ?? 0,
  };
  renderPrkGapList(parsed);
  renderPrkGrid();
  renderPrkSelection();
  updateCopyButtonState();
}

const BUNDLE_STRIP_ICON_MESH = `<svg class="bundle-strip__icon" xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="currentColor" aria-hidden="true"><path d="M120-120v-720l360-180 360 180v720L480-300 120-120Zm80-131 280-126v-543L200-794v543Zm400 0v-543L440-920v543l280 126Z"/></svg>`;

const BUNDLE_STRIP_ICON_TEX = `<svg class="bundle-strip__icon" xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="currentColor" aria-hidden="true"><path d="M200-200q-33 0-56.5-23.5T120-280v-400q0-33 23.5-56.5T200-760h560q33 0 56.5 23.5T840-680v400q0 33-23.5 56.5T760-200H200Zm40-80h480v-400H240v400Zm40-80h120l80 120 160-220 200 260v80H280v-240Z"/></svg>`;

const BUNDLE_STRIP_ICON_ALT = `<svg class="bundle-strip__icon" xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="currentColor" aria-hidden="true"><path d="M360-240 120-480l240-240 240 240-240 240-240-240Zm240-154 86 86 86-86-86-86-86 86 86 86Z"/></svg>`;

const BUNDLE_STRIP_ICON_TRIG = `<svg class="bundle-strip__icon" xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="currentColor" aria-hidden="true"><path d="m468-280 160-320H520v-200L360-480h108v200Zm12 160q-125 0-212.5-87.5T180-420q0-125 87.5-213T480-720q125 0 213 87T880-418q-2 125-90 213t-210 90Z"/></svg>`;

/**
 * @param {HTMLElement} parent
 * @param {number} di
 * @param {{ prefix: string, role: "main" | "texture" | "occluded" | "triggers", main: { index: number, entry: import("./pkr.js").PkrFileEntry } | null, texture: { index: number, entry: import("./pkr.js").PkrFileEntry } | null, occluded: { index: number, entry: import("./pkr.js").PkrFileEntry } | null, triggers: { index: number, entry: import("./pkr.js").PkrFileEntry } | null }} bundle
 */
function appendLevelBundleDetail(parent, di, bundle) {
  const card = document.createElement("div");
  card.className = "detail-card detail-card--stacked";

  const strip = document.createElement("div");
  strip.className = "bundle-strip";

  const autoText = bundle.texture
    ? state.externalPsxTextureSource
      ? `Manual texture source overrides ${bundle.texture.entry.name}.`
      : state.autoPsxTextureSource
        ? `Preview auto-uses ${bundle.texture.entry.name} for textures.`
        : `${bundle.texture.entry.name} was found but did not parse as a texture source.`
    : "No sibling texture library was found.";

  /** @type {Array<{ short: string, icon: string, item: { index: number, entry: import("./pkr.js").PkrFileEntry } | null, aria: string }>} */
  const slots = [
    { short: "Mesh", icon: BUNDLE_STRIP_ICON_MESH, item: bundle.main, aria: "Main PSX mesh" },
    { short: "Tex", icon: BUNDLE_STRIP_ICON_TEX, item: bundle.texture, aria: "Texture library" },
    { short: "Alt", icon: BUNDLE_STRIP_ICON_ALT, item: bundle.occluded, aria: "Alternate mesh" },
    { short: "Trg", icon: BUNDLE_STRIP_ICON_TRIG, item: bundle.triggers, aria: "Triggers" },
  ];
  for (const s of slots) {
    if (s.item) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bundle-strip__slot bundle-strip__slot--on";
      const name = s.item.entry.name;
      const fiBundle = s.item.index;
      btn.setAttribute("aria-label", `${s.aria}: ${name}`);
      btn.title = name;
      btn.innerHTML = `${s.icon}<span>${s.short}</span>`;
      btn.addEventListener("click", () => selectFileEntry(di, fiBundle));
      strip.appendChild(btn);
    } else {
      const span = document.createElement("span");
      span.className = "bundle-strip__slot bundle-strip__slot--missing";
      span.setAttribute("aria-label", `${s.aria} — missing`);
      span.innerHTML = `${s.icon}<span>${s.short}</span>`;
      strip.appendChild(span);
    }
  }

  const body = document.createElement("p");
  body.className = "detail-support";
  body.style.marginTop = "0.5rem";
  body.innerHTML = `Prefix <code>${escapeHtml(bundle.prefix)}</code> · viewing <strong>${escapeHtml(
    describeLevelBundleRole(bundle.role)
  )}</strong>. ${escapeHtml(autoText)}`;

  card.append(strip, body);
  parent.appendChild(card);
}

function revokeAllTileThumbUrls() {
  for (const u of state.tileThumbObjectUrls) URL.revokeObjectURL(u);
  state.tileThumbObjectUrls.clear();
}

function ensureTileThumbObserver() {
  if (state.tileThumbObserver) return state.tileThumbObserver;
  state.tileThumbObserver = new IntersectionObserver(
    (entries) => {
      for (const ent of entries) {
        if (!ent.isIntersecting) continue;
        const tile = /** @type {HTMLElement} */ (ent.target);
        if (tile.classList.contains("is-filtered")) continue;
        const img = tile.querySelector("img.file-tile__thumb[data-pending]");
        if (!img) continue;
        state.tileThumbObserver.unobserve(tile);
        const di = Number(tile.dataset.dirIndex);
        const fi = Number(tile.dataset.fileIndex);
        void withThumbConcurrency(async () => {
          const kind = img.dataset.thumbKind;
          if (kind === "psx") await loadPsxTileThumb(tile, img, di, fi);
          else await loadBmpTileThumb(tile, img, di, fi);
        });
      }
    },
    { root: tableShell, rootMargin: "120px", threshold: 0.01 }
  );
  return state.tileThumbObserver;
}

/**
 * @param {() => Promise<void>} fn
 */
async function withThumbConcurrency(fn) {
  if (state.activeThumbLoads >= THUMB_LOAD_CAP) {
    await new Promise((resolve) => state.thumbSlotWaiters.push(resolve));
  }
  state.activeThumbLoads++;
  try {
    await fn();
  } finally {
    state.activeThumbLoads--;
    const next = state.thumbSlotWaiters.shift();
    if (next) next();
  }
}

/**
 * @param {HTMLElement} tile
 * @param {HTMLImageElement} imgEl
 * @param {number} di
 * @param {number} fi
 */
async function loadBmpTileThumb(tile, imgEl, di, fi) {
  if (!state.currentBuffer || !state.currentArchive) return;
  const entry = state.currentArchive.dirs[di]?.files[fi];
  if (!entry) return;
  try {
    const data = await extractEntry(state.currentBuffer, entry);
    if (
      !tile.isConnected ||
      Number(tile.dataset.dirIndex) !== di ||
      Number(tile.dataset.fileIndex) !== fi
    ) {
      return;
    }
    if (!isBmp(data)) {
      imgEl.closest(".file-tile__thumb-wrap")?.remove();
      tile.classList.remove("file-tile--with-thumb");
      return;
    }
    const url = URL.createObjectURL(new Blob([data], { type: "image/bmp" }));
    state.tileThumbObjectUrls.add(url);
    imgEl.src = url;
    imgEl.removeAttribute("data-pending");
  } catch {
    /* leave empty thumb area */
  }
}

/**
 * Rebuild tile grid for the open folder so `.psx` thumbnails pick up texture source / mode changes.
 */
function refreshPsxTileThumbsGrid() {
  if (state.fileViewMode !== "tiles" || !state.currentArchive || state.selectedDirIndex < 0) return;
  renderFilesTable(state.selectedDirIndex, { preserveFilter: true });
  highlightSelection(state.selectedDirIndex, state.selectedFileIndex);
}

/**
 * Cached `three` module for tile thumbnails (avoids repeated import + fixes missing helper).
 * @returns {Promise<typeof import("three")>}
 */
function getThreeForThumb() {
  if (!state.threeThumbImportPromise) {
    state.threeThumbImportPromise = import("three");
  }
  return state.threeThumbImportPromise;
}

/**
 * Headless render of merged PSX mesh → PNG object URL (transparent background).
 * Uses embedded or external texture bank like the main preview when “Textured” mode is on.
 * @param {Uint8Array} data
 * @returns {Promise<string | null>}
 */
async function renderPsxThumbObjectUrl(data) {
  const parsed = parsePsxLevelGeometry(data, getActivePsxTextureSource());
  if (!parsed || parsed.positions.length < 9 || parsed.indices.length < 3) return null;

  let THREE;
  try {
    THREE = await getThreeForThumb();
  } catch {
    return null;
  }
  ensureShaderPrecisionFormatPolyfill();

  const hasTextured =
    parsed.textured &&
    parsed.textured.positions.length >= 9 &&
    parsed.textured.indices.length >= 3;

  let wantTextured = hasTextured;
  try {
    wantTextured = hasTextured && localStorage.getItem(STORAGE_PSX_SURFACE_MODE) !== "untextured";
  } catch {
    /* ignore */
  }

  /** @param {Float32Array} positions @param {Uint32Array} indices @param {Float32Array | null} uvs @param {Array<{ start: number, count: number, materialIndex: number }> | null} groups */
  const buildMeshGeometry = (positions, indices, uvs, groups) => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    if (uvs) geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    let maxIdx = 0;
    for (let i = 0; i < indices.length; i++) {
      const v = indices[i];
      if (v > maxIdx) maxIdx = v;
    }
    if (maxIdx > 65535) {
      geom.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
    } else {
      const i16 = new Uint16Array(indices.length);
      i16.set(indices);
      geom.setIndex(new THREE.Uint16BufferAttribute(i16, 1));
    }
    if (groups) {
      for (const g of groups) {
        geom.addGroup(g.start, g.count, g.materialIndex);
      }
    }
    geom.computeBoundingBox();
    const bb = geom.boundingBox;
    if (bb) {
      const c = new THREE.Vector3();
      bb.getCenter(c);
      const size = new THREE.Vector3();
      bb.getSize(size);
      geom.translate(-c.x, -c.y, -c.z);
      const mx = Math.max(size.x, size.y, size.z, 1e-6);
      const sc = 1 / mx;
      geom.scale(sc, sc, sc);
    }
    geom.computeVertexNormals();
    return geom;
  };

  /** @type {import("three").BufferGeometry} */
  let geom;
  /** @type {import("three").MeshStandardMaterial[] | null} */
  let texMaterials = null;
  /** @type {import("three").MeshStandardMaterial | null} */
  let plainMaterial = null;

  if (wantTextured && hasTextured) {
    const t = parsed.textured;
    geom = buildMeshGeometry(t.positions, t.indices, t.uvs, t.groups);
    texMaterials = [];
    for (let mi = 0; mi < t.materialKeys.length; mi++) {
      const key = t.materialKeys[mi];
      const entry = t.textureBank.get(key);
      /** @type {import("three").Texture | null} */
      let map = null;
      if (entry) {
        const dt = new THREE.DataTexture(
          entry.rgba,
          entry.width,
          entry.height,
          THREE.RGBAFormat
        );
        dt.generateMipmaps = false;
        dt.minFilter = THREE.NearestFilter;
        dt.magFilter = THREE.NearestFilter;
        dt.wrapS = THREE.ClampToEdgeWrapping;
        dt.wrapT = THREE.ClampToEdgeWrapping;
        // false: first RGBA row → GL v≈0; psx-model.js uses vf=vb/h (boundary UVs, no +0.5).
        dt.flipY = false;
        dt.needsUpdate = true;
        if ("colorSpace" in dt) dt.colorSpace = THREE.SRGBColorSpace;
        map = dt;
      }
      texMaterials.push(
        new THREE.MeshStandardMaterial({
          map,
          color: map ? 0xffffff : 0x8fa8c8,
          metalness: 0.05,
          roughness: 0.85,
          side: THREE.DoubleSide,
          flatShading: true,
          emissive: map ? 0x000000 : 0x1a2230,
          emissiveIntensity: map ? 0 : 0.18,
          transparent: !!map,
          alphaTest: map ? 0.5 : 0,
          depthWrite: true,
        })
      );
    }
  } else {
    geom = buildMeshGeometry(parsed.positions, parsed.indices, null, null);
    plainMaterial = new THREE.MeshStandardMaterial({
      color: 0x8fa8c8,
      flatShading: true,
      metalness: 0.05,
      roughness: 0.85,
      side: THREE.DoubleSide,
      emissive: 0x1a2230,
      emissiveIntensity: 0.22,
    });
  }

  const canvas = document.createElement("canvas");
  canvas.width = PSX_TILE_THUMB_PX;
  canvas.height = PSX_TILE_THUMB_PX;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: false,
    powerPreference: "low-power",
  });
  renderer.setSize(PSX_TILE_THUMB_PX, PSX_TILE_THUMB_PX, false);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);

  const hasTexMaterials = !!texMaterials && texMaterials.length > 0;
  const meshMat = hasTexMaterials
    ? texMaterials
    : /** @type {import("three").Material} */ (plainMaterial);
  const mesh = new THREE.Mesh(geom, meshMat);
  const scene = new THREE.Scene();
  scene.add(mesh);
  const amb = new THREE.AmbientLight(0xffffff, 0.55);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(0.45, 1, 0.35);
  scene.add(amb, dir);

  geom.computeBoundingSphere();
  const r = geom.boundingSphere?.radius ?? 0.7;
  const dist = r * 2.35;
  const cam = new THREE.PerspectiveCamera(40, 1, 0.06, 48);
  cam.position.set(dist * 0.75, dist * 0.52, dist * 0.75);
  cam.lookAt(0, 0, 0);

  renderer.render(scene, cam);

  /** @type {string | null} */
  const url = await new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) resolve(null);
        else resolve(URL.createObjectURL(blob));
      },
      "image/png",
      0.93
    );
  });

  geom.dispose();
  if (hasTexMaterials && texMaterials) {
    for (const m of texMaterials) {
      if ("map" in m && m.map) m.map.dispose();
      m.dispose();
    }
  } else if (plainMaterial) {
    plainMaterial.dispose();
  }
  renderer.dispose();
  return url;
}

/**
 * @param {HTMLElement} tile
 * @param {HTMLImageElement} imgEl
 * @param {number} di
 * @param {number} fi
 */
async function loadPsxTileThumb(tile, imgEl, di, fi) {
  if (!state.currentBuffer || !state.currentArchive) return;
  const entry = state.currentArchive.dirs[di]?.files[fi];
  if (!entry) return;
  try {
    const data = await extractEntry(state.currentBuffer, entry);
    if (
      !tile.isConnected ||
      Number(tile.dataset.dirIndex) !== di ||
      Number(tile.dataset.fileIndex) !== fi
    ) {
      return;
    }
    const url = await renderPsxThumbObjectUrl(data);
    if (!url) {
      imgEl.closest(".file-tile__thumb-wrap")?.remove();
      tile.classList.remove("file-tile--with-thumb");
      return;
    }
    state.tileThumbObjectUrls.add(url);
    imgEl.src = url;
    imgEl.removeAttribute("data-pending");
  } catch {
    imgEl.closest(".file-tile__thumb-wrap")?.remove();
    tile.classList.remove("file-tile--with-thumb");
  }
}

function applyBmpPreviewLayout() {
  previewImageWrap.classList.toggle("preview-image-wrap--fit", state.bmpFitToFrame);
  previewImageWrap.classList.toggle("preview-image-wrap--native", !state.bmpFitToFrame);
  previewBmpFit.checked = state.bmpFitToFrame;
}

/**
 * @param {Uint8Array} data
 */
function showBmpPreview(data) {
  disposePsxPreview();
  hideAudioPreview();
  hidePrkPreview();
  hideImagePreview();
  state.previewClipboardText = "";

  state.previewImageObjectUrl = URL.createObjectURL(new Blob([data], { type: "image/bmp" }));
  previewImage.src = state.previewImageObjectUrl;
  previewImage.alt = `BMP preview (${nf.format(data.length)} bytes)`;
  previewImage.onload = () => {
    previewHint.textContent =
      "Windows BMP — Fit to frame fills the preview area; turn off for 1:1 pixels (scroll). Use Copy for text/hex only.";
  };
  previewImage.onerror = () => {
    previewHint.textContent =
      "This BMP could not be shown in the browser (unsupported variant or corrupt data). Try Download.";
  };

  previewImageWrap.classList.remove("is-hidden");
  previewImageToolbar.classList.remove("is-hidden");
  applyBmpPreviewLayout();
  previewEl.classList.add("is-hidden");
  previewEl.textContent = "";
  previewEl.classList.remove("is-idle");
  previewHint.hidden = false;
  previewHint.textContent = "Loading BMP…";
  updateCopyButtonState();
}

/**
 * RIFF little-endian `WAVE` at offset 8.
 * @param {Uint8Array} bytes
 */
function isRiffWave(bytes) {
  if (bytes.length < 12) return false;
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  );
}

/**
 * @param {Uint8Array} data
 */
function wavPreviewHintBase() {
  if (previewAutoplay.checked) {
    return "WAV — autoplay is on when you pick a file (browser may block until you’ve clicked the page). Volume is preview-only.";
  }
  return "WAV — press play on the player to listen. Volume is preview-only.";
}

/** @type {boolean} */
let wavSeekDragging = false;

/**
 * @param {number} seconds
 */
function formatWavTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function syncAudioPlayButton() {
  const paused = previewAudio.paused;
  previewAudioPlayIcon.textContent = paused ? "play_arrow" : "pause";
  previewAudioPlay.setAttribute("aria-label", paused ? "Play" : "Pause");
}

function syncAudioPlayerUi() {
  const d = previewAudio.duration;
  const dur = Number.isFinite(d) && d > 0 ? d : 0;
  const cur = Number.isFinite(previewAudio.currentTime) ? previewAudio.currentTime : 0;
  previewAudioTimeCurrent.textContent = formatWavTime(cur);
  previewAudioTimeDuration.textContent = formatWavTime(dur);
  if (dur > 0) {
    previewAudioSeek.max = String(dur);
    if (!wavSeekDragging) {
      previewAudioSeek.value = String(cur);
    }
    previewAudioSeek.setAttribute("aria-valuemax", String(dur));
    previewAudioSeek.setAttribute("aria-valuenow", String(cur));
    previewAudioSeek.setAttribute("aria-valuetext", `${formatWavTime(cur)} / ${formatWavTime(dur)}`);
  } else {
    previewAudioSeek.max = "1";
    previewAudioSeek.value = "0";
  }
  syncAudioPlayButton();
}

function resetAudioPlayerUi() {
  wavSeekDragging = false;
  previewAudioSeek.max = "1";
  previewAudioSeek.value = "0";
  previewAudioTimeCurrent.textContent = "0:00";
  previewAudioTimeDuration.textContent = "0:00";
  previewAudioPlayIcon.textContent = "play_arrow";
  previewAudioPlay.setAttribute("aria-label", "Play");
}

function showWavPreview(data) {
  disposePsxPreview();
  hideAudioPreview();
  hidePrkPreview();
  hideImagePreview();
  state.previewClipboardText = "";
  state.previewAudioObjectUrl = URL.createObjectURL(new Blob([data], { type: "audio/wav" }));
  previewAudio.src = state.previewAudioObjectUrl;
  previewAudio.volume = Number(previewVolumeRange.value);
  previewAudio.load();

  previewAudioWrap.classList.remove("is-hidden");
  previewEl.classList.add("is-hidden");
  previewEl.textContent = "";
  previewEl.classList.remove("is-idle");
  previewHint.hidden = false;
  previewHint.textContent = wavPreviewHintBase();

  if (previewAutoplay.checked) {
    previewAudio.play().catch(() => {
      previewHint.textContent =
        "WAV — autoplay was blocked; press play on the player. (Some browsers require a click on the page first.)";
    });
  }
  syncAudioPlayerUi();
  updateCopyButtonState();
}

/**
 * Circular ground disc: radial gradient + subtle grid (cyan on dark, matches PSX preview).
 * @param {typeof import("three")} THREE
 * @returns {import("three").Mesh}
 */
function createPsxPreviewGround(THREE) {
  const radius = 3.45;
  const geo = new THREE.CircleGeometry(radius, 96);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColorCenter: { value: new THREE.Color(0x1a2330) },
      uColorEdge: { value: new THREE.Color(0x06080c) },
      uGridColor: { value: new THREE.Color(0x00f0ff) },
      uGridDiv: { value: 5.5 },
      uGridOpacity: { value: 0.15 },
      uRadius: { value: radius },
    },
    vertexShader: `
      varying vec2 vPos;
      void main() {
        vPos = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColorCenter;
      uniform vec3 uColorEdge;
      uniform vec3 uGridColor;
      uniform float uGridDiv;
      uniform float uGridOpacity;
      uniform float uRadius;
      varying vec2 vPos;
      void main() {
        float d = length(vPos) / uRadius;
        float t = clamp(d, 0.0, 1.0);
        vec3 base = mix(uColorCenter, uColorEdge, t * t);
        float a = 1.0 - smoothstep(0.36, 0.995, d);
        vec2 g = vPos * uGridDiv;
        vec2 f = abs(fract(g - 0.5) - 0.5) / fwidth(g);
        float line = min(f.x, f.y);
        float grid = 1.0 - min(line, 1.0);
        float gridW = grid * uGridOpacity;
        vec3 rgb = mix(base, uGridColor, gridW);
        gl_FragColor = vec4(rgb, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    extensions: { derivatives: true },
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -1;
  return mesh;
}

/**
 * @param {Uint8Array} data
 * @returns {Promise<boolean>} true if WebGL preview started
 */
async function showPsxPreview(data) {
  state.lastPsxPreviewBytes = data;
  disposePsxPreview();
  hideAudioPreview();
  hidePrkPreview();
  hideImagePreview();
  state.previewClipboardText = "";

  const parsed = parsePsxLevelGeometry(data, getActivePsxTextureSource());
  if (!parsed) return false;
  setCurrentPsxExportTextures(parsed);

  /** @type {"3d" | "uv"} */
  let viewMode = "3d";

  /** UV / texture canvas: pan (CSS px) + zoom (1 = fit sheet to viewport box used by draw). */
  let uvPanX = 0;
  let uvPanY = 0;
  let uvZoom = 1;
  const UV_ZOOM_MIN = 0.125;
  const UV_ZOOM_MAX = 32;
  const clampUvZoom = (/** @type {number} */ z) => Math.min(UV_ZOOM_MAX, Math.max(UV_ZOOM_MIN, z));
  let uvDragPointerId = /** @type {number | null} */ (null);
  let uvLastClientX = 0;
  let uvLastClientY = 0;

  let THREE;
  /** @type {new (cam: import("three").PerspectiveCamera, el: HTMLElement) => { update: () => void; dispose: () => void }} */
  let OrbitControlsCtor;
  /** @type {new (m: import("three").Mesh, n?: number, c?: number) => ThreeObject3D} */
  let VertexNormalsHelperCtor;
  try {
    THREE = await import("three");
    const ctrlMod = await import("three/examples/jsm/controls/OrbitControls.js");
    OrbitControlsCtor = ctrlMod.OrbitControls;
    const helpMod = await import("three/examples/jsm/helpers/VertexNormalsHelper.js");
    VertexNormalsHelperCtor = helpMod.VertexNormalsHelper;
  } catch {
    return false;
  }
  ensureShaderPrecisionFormatPolyfill();

  /** @type {import("three").MeshStandardMaterial[] | null} */
  let texMaterials = null;

  const hasTextured =
    parsed.textured &&
    parsed.textured.positions.length >= 9 &&
    parsed.textured.indices.length >= 3;

  previewPsxViewModeUv.disabled = !hasTextured;

  /** @param {Float32Array} positions @param {Uint32Array} indices @param {Float32Array | null} uvs @param {Array<{ start: number, count: number, materialIndex: number }> | null} groups @param {{ normalize?: boolean }} [opts] */
  const buildMeshGeometry = (positions, indices, uvs, groups, opts = {}) => {
    const normalize = opts.normalize !== false;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    if (uvs) geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    let maxIdx = 0;
    for (let i = 0; i < indices.length; i++) {
      const v = indices[i];
      if (v > maxIdx) maxIdx = v;
    }
    if (maxIdx > 65535) {
      geom.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
    } else {
      const i16 = new Uint16Array(indices.length);
      i16.set(indices);
      geom.setIndex(new THREE.Uint16BufferAttribute(i16, 1));
    }
    if (groups) {
      for (const g of groups) {
        geom.addGroup(g.start, g.count, g.materialIndex);
      }
    }
    if (normalize) {
      geom.computeBoundingBox();
      const bb = geom.boundingBox;
      if (bb) {
        const c = new THREE.Vector3();
        bb.getCenter(c);
        const size = new THREE.Vector3();
        bb.getSize(size);
        geom.translate(-c.x, -c.y, -c.z);
        const mx = Math.max(size.x, size.y, size.z, 1e-6);
        const sc = 1 / mx;
        geom.scale(sc, sc, sc);
      }
      geom.computeVertexNormals();
    }
    return geom;
  };

  /**
   * @param {import("three").BufferGeometry[]} geoms
   */
  function normalizeGeometriesTogether(geoms) {
    const box = new THREE.Box3();
    for (const g of geoms) {
      g.computeBoundingBox();
      if (g.boundingBox) box.union(g.boundingBox);
    }
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const mx = Math.max(size.x, size.y, size.z, 1e-6);
    const sc = 1 / mx;
    for (const g of geoms) {
      g.translate(-center.x, -center.y, -center.z);
      g.scale(sc, sc, sc);
    }
    for (const g of geoms) g.computeVertexNormals();
  }

  /** @param {typeof import("three")} THREE @param {import("../../psx-textures.js").PsxDecodedTexture | undefined} entry */
  function makePsxTextureMaterial(THREE, entry) {
    /** @type {import("three").Texture | null} */
    let map = null;
    if (entry) {
      const dt = new THREE.DataTexture(entry.rgba, entry.width, entry.height, THREE.RGBAFormat);
      dt.generateMipmaps = false;
      dt.minFilter = THREE.NearestFilter;
      dt.magFilter = THREE.NearestFilter;
      dt.wrapS = THREE.ClampToEdgeWrapping;
      dt.wrapT = THREE.ClampToEdgeWrapping;
      dt.flipY = false;
      dt.needsUpdate = true;
      if ("colorSpace" in dt) dt.colorSpace = THREE.SRGBColorSpace;
      map = dt;
    }
    return new THREE.MeshStandardMaterial({
      map,
      color: map ? 0xffffff : 0x8fa8c8,
      metalness: 0.05,
      roughness: 0.85,
      side: THREE.DoubleSide,
      flatShading: true,
      emissive: map ? 0x000000 : 0x1a2330,
      emissiveIntensity: map ? 0 : 0.18,
      transparent: !!map,
      alphaTest: map ? 0.5 : 0,
      depthWrite: true,
    });
  }

  /**
   * Colors each triangle by the sign of its UV area in the current index order.
   * Green = positive winding, red = negative winding, yellow = degenerate UVs.
   * @param {Float32Array} positions
   * @param {Uint32Array} indices
   * @param {Float32Array | null} uvs
   */
  const buildUvWindingDebugGeometry = (positions, indices, uvs) => {
    if (!uvs) return null;
    /** @type {number[]} */
    const pos = [];
    /** @type {number[]} */
    const colors = [];
    const stats = { positive: 0, negative: 0, degenerate: 0 };
    const pushVertex = (vi, r, g, b) => {
      const po = vi * 3;
      pos.push(positions[po], positions[po + 1], positions[po + 2]);
      colors.push(r, g, b);
    };
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const ia = indices[i];
      const ib = indices[i + 1];
      const ic = indices[i + 2];
      const ua = ia * 2;
      const ub = ib * 2;
      const uc = ic * 2;
      const du1 = uvs[ub] - uvs[ua];
      const dv1 = uvs[ub + 1] - uvs[ua + 1];
      const du2 = uvs[uc] - uvs[ua];
      const dv2 = uvs[uc + 1] - uvs[ua + 1];
      const uvArea2 = du1 * dv2 - dv1 * du2;
      let r = 1;
      let g = 0.2;
      let b = 0.2;
      if (Math.abs(uvArea2) < 1e-8) {
        stats.degenerate++;
        r = 1;
        g = 0.85;
        b = 0.2;
      } else if (uvArea2 > 0) {
        stats.positive++;
        r = 0.2;
        g = 0.95;
        b = 0.35;
      } else {
        stats.negative++;
        r = 1;
        g = 0.2;
        b = 0.2;
      }
      pushVertex(ia, r, g, b);
      pushVertex(ib, r, g, b);
      pushVertex(ic, r, g, b);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geom.computeBoundingBox();
    const bb = geom.boundingBox;
    if (bb) {
      const c = new THREE.Vector3();
      bb.getCenter(c);
      const size = new THREE.Vector3();
      bb.getSize(size);
      geom.translate(-c.x, -c.y, -c.z);
      const mx = Math.max(size.x, size.y, size.z, 1e-6);
      const sc = 1 / mx;
      geom.scale(sc, sc, sc);
    }
    geom.computeVertexNormals();
    return { geom, stats };
  };

  /**
   * Builds short line segments showing the direction of increasing U on each triangle.
   * Cyan = valid +U direction. Yellow = degenerate UVs / no stable tangent.
   * @param {import("three").BufferGeometry | null} geom
   */
  const buildUvDirectionLines = (geom) => {
    if (!geom) return null;
    const posAttr = geom.getAttribute("position");
    const uvAttr = geom.getAttribute("uv");
    const indexAttr = geom.getIndex();
    if (!posAttr || !uvAttr || !indexAttr) return null;
    /** @type {number[]} */
    const pos = [];
    /** @type {number[]} */
    const colors = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const centroid = new THREE.Vector3();
    const tip = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    for (let i = 0; i + 2 < indexAttr.count; i += 3) {
      const ia = indexAttr.getX(i);
      const ib = indexAttr.getX(i + 1);
      const ic = indexAttr.getX(i + 2);
      a.fromBufferAttribute(posAttr, ia);
      b.fromBufferAttribute(posAttr, ib);
      c.fromBufferAttribute(posAttr, ic);
      const ua = uvAttr.getX(ia);
      const va = uvAttr.getY(ia);
      const ub = uvAttr.getX(ib);
      const vb = uvAttr.getY(ib);
      const uc = uvAttr.getX(ic);
      const vc = uvAttr.getY(ic);
      const du1 = ub - ua;
      const dv1 = vb - va;
      const du2 = uc - ua;
      const dv2 = vc - va;
      const denom = du1 * dv2 - du2 * dv1;
      let cr = 0.2;
      let cg = 0.95;
      let cb = 1.0;
      centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      if (Math.abs(denom) < 1e-8) {
        tangent.set(0.04, 0, 0);
        cr = 1.0;
        cg = 0.85;
        cb = 0.2;
      } else {
        ab.copy(b).sub(a);
        ac.copy(c).sub(a);
        tangent.copy(ab).multiplyScalar(dv2).sub(tmp.copy(ac).multiplyScalar(dv1)).divideScalar(denom);
        if (tangent.lengthSq() < 1e-10) {
          tangent.set(0.04, 0, 0);
          cr = 1.0;
          cg = 0.85;
          cb = 0.2;
        } else {
          tangent.normalize().multiplyScalar(0.06);
        }
      }
      tip.copy(centroid).add(tangent);
      pos.push(centroid.x, centroid.y, centroid.z, tip.x, tip.y, tip.z);
      colors.push(cr, cg, cb, cr, cg, cb);
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return out;
  };

  const plainGeom = buildMeshGeometry(parsed.positions, parsed.indices, null, null);
  /** @type {import("three").BufferGeometry | null} */
  let texturedGeom = null;
  /** @type {import("three").BufferGeometry | null} */
  let uvWindingGeom = null;
  /** @type {import("three").BufferGeometry | null} */
  let uDirLinesGeom = null;
  /** @type {{ positive: number, negative: number, degenerate: number } | null} */
  let uvWindingStats = null;

  if (hasTextured) {
    const t = parsed.textured;
    texturedGeom = buildMeshGeometry(t.positions, t.indices, t.uvs, t.groups);
    const uvDebug = buildUvWindingDebugGeometry(t.positions, t.indices, t.uvs);
    if (uvDebug) {
      uvWindingGeom = uvDebug.geom;
      uvWindingStats = uvDebug.stats;
    }
    uDirLinesGeom = buildUvDirectionLines(texturedGeom);
    texMaterials = [];
    for (let mi = 0; mi < t.materialKeys.length; mi++) {
      const key = t.materialKeys[mi];
      texMaterials.push(makePsxTextureMaterial(THREE, t.textureBank.get(key)));
    }
  }

  const perPartRaw = parsePsxPerPartPreviewData(data, getActivePsxTextureSource(), parsed);
  /** @type {Array<null | { plainGeom: import("three").BufferGeometry, texturedGeom: import("three").BufferGeometry | null, texMats: import("three").MeshStandardMaterial[] | null, uvWindingGeom: import("three").BufferGeometry | null, uDirLinesGeom: import("three").BufferGeometry | null }>} */
  const partAssets = [];
  let usePartGroup = false;
  if (perPartRaw) {
    let nOk = 0;
    for (const pr of perPartRaw) {
      if (pr && pr.positions.length >= 9) nOk++;
    }
    if (nOk >= 2) {
      /** @type {import("three").BufferGeometry[]} */
      const normList = [];
      for (let m = 0; m < perPartRaw.length; m++) {
        const pr = perPartRaw[m];
        if (!pr || pr.positions.length < 9) {
          partAssets.push(null);
          continue;
        }
        const pg = buildMeshGeometry(pr.positions, pr.indices, null, null, { normalize: false });
        let texMats = null;
        let tg = null;
        let uvw = null;
        let udir = null;
        if (pr.textured && pr.textured.positions.length >= 9) {
          const pt = pr.textured;
          tg = buildMeshGeometry(pt.positions, pt.indices, pt.uvs, pt.groups, { normalize: false });
          texMats = [];
          for (let mi = 0; mi < pt.materialKeys.length; mi++) {
            const key = pt.materialKeys[mi];
            texMats.push(makePsxTextureMaterial(THREE, pt.textureBank.get(key)));
          }
          const uvDebug = buildUvWindingDebugGeometry(pt.positions, pt.indices, pt.uvs);
          if (uvDebug) uvw = uvDebug.geom;
          udir = buildUvDirectionLines(tg);
        }
        partAssets.push({ plainGeom: pg, texturedGeom: tg, texMats, uvWindingGeom: uvw, uDirLinesGeom: udir });
        normList.push(tg ?? pg);
      }
      normalizeGeometriesTogether(normList);
      usePartGroup = true;
    }
  }

  /** @type {import("three").MeshStandardMaterial[]} */
  const partTexMaterials = [];
  if (usePartGroup) {
    for (const pa of partAssets) {
      if (!pa?.texMats) continue;
      for (const m of pa.texMats) partTexMaterials.push(m);
    }
  }

  const matShaded = new THREE.MeshStandardMaterial({
    color: 0x8fa8c8,
    flatShading: true,
    metalness: 0.05,
    roughness: 0.85,
    side: THREE.DoubleSide,
    emissive: 0x1a2230,
    emissiveIntensity: 0.22,
  });
  const matWire = new THREE.MeshBasicMaterial({
    color: 0x6ed4ff,
    wireframe: true,
  });
  const matNormal = new THREE.MeshNormalMaterial({
    side: THREE.DoubleSide,
    flatShading: true,
  });
  const matUvWinding = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  const mats = {
    shaded: matShaded,
    wire: matWire,
    normal: matNormal,
    uvWinding: matUvWinding,
  };
  let texturedSurface = hasTextured;
  let currentDebugMode = "shaded";
  try {
    texturedSurface = hasTextured && localStorage.getItem(STORAGE_PSX_SURFACE_MODE) !== "untextured";
  } catch {
    /* ignore */
  }
  previewPsxTextured.checked = texturedSurface;
  previewPsxTextured.disabled = !hasTextured;
  previewPsxTextured.parentElement?.classList.toggle("is-disabled", !hasTextured);

  try {
    previewPsxAssemble.checked =
      localStorage.getItem(PSX_CHARACTER_ASSEMBLY_STORAGE_KEY) === "1";
  } catch {
    previewPsxAssemble.checked = false;
  }

  const activeGeom = () => (texturedSurface && texturedGeom ? texturedGeom : plainGeom);
  /** @param {NonNullable<(typeof partAssets)[number]>} pa */
  const activeGeomPart = (pa) => (texturedSurface && pa.texturedGeom ? pa.texturedGeom : pa.plainGeom);
  const hasTexMaterials = !!texMaterials && texMaterials.length > 0;
  /** @type {import("three").Mesh | import("three").Group} */
  let mesh;
  if (usePartGroup && partAssets.some((p) => p)) {
    mesh = new THREE.Group();
    for (let m = 0; m < partAssets.length; m++) {
      const pa = partAssets[m];
      if (!pa) continue;
      const g = activeGeomPart(pa);
      const mats = texturedSurface && pa.texMats && pa.texMats.length ? pa.texMats : matShaded;
      const cm = new THREE.Mesh(g, mats);
      cm.userData.partIndex = m;
      cm.userData.partEnabled = true;
      cm.visible = true;
      mesh.add(cm);
    }
  } else {
    mesh = new THREE.Mesh(activeGeom(), texturedSurface && hasTexMaterials ? texMaterials : matShaded);
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12151c);
  const psxGround = createPsxPreviewGround(THREE);
  const gbb = new THREE.Box3().setFromObject(mesh);
  if (!gbb.isEmpty()) psxGround.position.y = gbb.min.y - 0.02;
  scene.add(psxGround);
  scene.add(mesh);
  scene.add(new THREE.AmbientLight(0x7590b8, 0.78));
  scene.add(new THREE.HemisphereLight(0x8a9cad, 0x242830, 0.52));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.42);
  d1.position.set(1.2, 2.5, 1.5);
  scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xc8d4e8, 0.28);
  d2.position.set(-1.5, -0.5, -1.2);
  scene.add(d2);

  /** Mutable refs for helpers so dispose and applyDebugMode stay in sync. */
  const overlayRef = {
    /** @type {ThreeObject3D[]} */
    vertNormHelpers: [],
    /** @type {import("three").LineSegments | import("three").Group | null} */
    edgesLines: null,
    /** @type {import("three").LineSegments | null} */
    uDirLines: null,
  };

  function clearPsxDebugOverlays() {
    for (const h of overlayRef.vertNormHelpers) {
      scene.remove(h);
      if (typeof h.dispose === "function") h.dispose();
    }
    overlayRef.vertNormHelpers.length = 0;
    if (overlayRef.edgesLines) {
      const o = overlayRef.edgesLines;
      if (o.parent) o.parent.remove(o);
      if (o.type === "LineSegments") {
        o.geometry.dispose();
        o.material.dispose();
      } else if (o.type === "Group") {
        for (const c of o.children) {
          if (c.type === "LineSegments") {
            c.geometry.dispose();
            c.material.dispose();
          }
        }
      }
      overlayRef.edgesLines = null;
    }
    if (overlayRef.uDirLines) {
      scene.remove(overlayRef.uDirLines);
      overlayRef.uDirLines.geometry.dispose();
      overlayRef.uDirLines.material.dispose();
      overlayRef.uDirLines = null;
    }
  }

  const plainVertCount = parsed.positions.length / 3;
  const plainTriCount = Math.floor(parsed.indices.length / 3);
  const texturedVertCount = hasTextured ? parsed.textured.positions.length / 3 : 0;
  const texturedTriCount = hasTextured ? Math.floor(parsed.textured.indices.length / 3) : 0;
  let hintBase = "";
  function syncPsxHint() {
    const vertCount = texturedSurface && hasTextured ? texturedVertCount : plainVertCount;
    const triCount = texturedSurface && hasTextured ? texturedTriCount : plainTriCount;
    const hudParts = [
      `${nf.format(vertCount)} vertices`,
      `~${nf.format(triCount)} tris`,
    ];
    if (parsed.modelCount > 1) hudParts.push(`${nf.format(parsed.modelCount)} parts`);
    previewPsxStatsHud.textContent = hudParts.join(" · ");

    let hint = hintBase;
    if (currentDebugMode === "uv-winding" && uvWindingStats) {
      hint += ` UV winding: green=${nf.format(uvWindingStats.positive)}, red=${nf.format(
        uvWindingStats.negative
      )}, yellow=${nf.format(uvWindingStats.degenerate)} tris.`;
    }
    if (currentDebugMode === "u-dir") {
      hint +=
        " U-dir debug: cyan = +U per tri; yellow = degenerate UVs.";
    }
    hint += hasTextured
      ? texturedSurface
        ? " Textured surface."
        : " Untextured surface."
      : "";
    if (viewMode === "uv") {
      hint += " UV / texture view: sheet + triangle edges.";
    }
    previewHint.textContent = hint.trim() || "—";
    const orbitEl = previewPsxWrap.querySelector(".preview-psx-hint");
    if (orbitEl) {
      orbitEl.textContent =
        viewMode === "uv"
          ? "Drag to pan · scroll to zoom · double-click to reset. Switch to 3D mesh to orbit."
          : "Drag to orbit · scroll to zoom";
    }
  }

  function applyDebugMode(mode) {
    clearPsxDebugOverlays();
    currentDebugMode = mode;
    texturedSurface = hasTextured && previewPsxTextured.checked;
    mesh.visible = true;
    syncPsxHint();

    if (mesh.isGroup) {
      if (mode === "shaded") {
        for (const child of mesh.children) {
          if (child.type !== "Mesh") continue;
          const pi = child.userData.partIndex;
          const pa = partAssets[pi];
          if (!pa) continue;
          child.geometry = activeGeomPart(pa);
          const hasPartTex = !!(texturedSurface && pa.texMats && pa.texMats.length);
          child.material = hasPartTex ? pa.texMats : matShaded;
          child.visible = !!child.userData.partEnabled;
        }
        return;
      }
      switch (mode) {
        case "uv-winding":
          for (const child of mesh.children) {
            if (child.type !== "Mesh") continue;
            const pi = child.userData.partIndex;
            const pa = partAssets[pi];
            if (!pa) continue;
            const g = pa.uvWindingGeom ? pa.uvWindingGeom : activeGeomPart(pa);
            child.geometry = g;
            child.material = pa.uvWindingGeom
              ? mats.uvWinding
              : texturedSurface && pa.texMats && pa.texMats.length
                ? pa.texMats
                : matShaded;
            child.visible = !!child.userData.partEnabled;
          }
          break;
        case "u-dir": {
          for (const child of mesh.children) {
            if (child.type !== "Mesh") continue;
            const pi = child.userData.partIndex;
            const pa = partAssets[pi];
            if (!pa) continue;
            child.geometry = activeGeomPart(pa);
            const hasPartTex = !!(texturedSurface && pa.texMats && pa.texMats.length);
            child.material = hasPartTex ? pa.texMats : matShaded;
            child.visible = !!child.userData.partEnabled;
          }
          /** @type {import("three").BufferGeometry[]} */
          const udirParts = [];
          for (const child of mesh.children) {
            if (child.type !== "Mesh") continue;
            if (!child.userData.partEnabled) continue;
            const pa = partAssets[child.userData.partIndex];
            if (!pa?.uDirLinesGeom) continue;
            udirParts.push(pa.uDirLinesGeom.clone());
          }
          if (udirParts.length) {
            const merged =
              udirParts.length === 1 ? udirParts[0] : mergeGeometries(udirParts);
            if (udirParts.length > 1) {
              for (const g of udirParts) g.dispose();
            }
            if (!merged) break;
            overlayRef.uDirLines = new THREE.LineSegments(
              merged,
              new THREE.LineBasicMaterial({
                vertexColors: true,
                toneMapped: false,
              })
            );
            scene.add(overlayRef.uDirLines);
          }
          break;
        }
        case "wireframe":
          for (const child of mesh.children) {
            if (child.type !== "Mesh") continue;
            const pi = child.userData.partIndex;
            const pa = partAssets[pi];
            if (!pa) continue;
            child.geometry = activeGeomPart(pa);
            child.material = mats.wire;
            child.visible = !!child.userData.partEnabled;
          }
          break;
        case "normals":
          for (const child of mesh.children) {
            if (child.type !== "Mesh") continue;
            const pi = child.userData.partIndex;
            const pa = partAssets[pi];
            if (!pa) continue;
            child.geometry = activeGeomPart(pa);
            child.material = mats.normal;
            child.visible = !!child.userData.partEnabled;
          }
          break;
        case "vert-norms":
          for (const child of mesh.children) {
            if (child.type !== "Mesh") continue;
            const pi = child.userData.partIndex;
            const pa = partAssets[pi];
            if (!pa) continue;
            child.geometry = activeGeomPart(pa);
            const hasPartTex = !!(texturedSurface && pa.texMats && pa.texMats.length);
            child.material = hasPartTex ? pa.texMats : matShaded;
            child.visible = !!child.userData.partEnabled;
            if (child.userData.partEnabled) {
              const h = new VertexNormalsHelperCtor(child, 0.12, 0x55e0ff);
              scene.add(h);
              overlayRef.vertNormHelpers.push(h);
            }
          }
          break;
        case "edges": {
          const edgesGroup = new THREE.Group();
          for (const child of mesh.children) {
            if (child.type !== "Mesh") continue;
            const pi = child.userData.partIndex;
            const pa = partAssets[pi];
            if (!pa) continue;
            const g = activeGeomPart(pa);
            child.geometry = g;
            if (!child.userData.partEnabled) {
              child.visible = false;
              continue;
            }
            child.visible = false;
            const edgeGeom = new THREE.EdgesGeometry(g, 32);
            const ls = new THREE.LineSegments(
              edgeGeom,
              new THREE.LineBasicMaterial({ color: 0x7ae8ff })
            );
            edgesGroup.add(ls);
          }
          mesh.add(edgesGroup);
          overlayRef.edgesLines = edgesGroup;
          break;
        }
        default:
          for (const child of mesh.children) {
            if (child.type !== "Mesh") continue;
            const pi = child.userData.partIndex;
            const pa = partAssets[pi];
            if (!pa) continue;
            child.geometry = activeGeomPart(pa);
            const hasPartTex = !!(texturedSurface && pa.texMats && pa.texMats.length);
            child.material = hasPartTex ? pa.texMats : matShaded;
            child.visible = !!child.userData.partEnabled;
          }
      }
      return;
    }

    /** @type {import("three").Mesh} */
    const meshOne = mesh;
    meshOne.geometry = activeGeom();
    meshOne.visible = true;
    if (texturedSurface && hasTexMaterials && texMaterials && mode === "shaded") {
      meshOne.material = texMaterials;
      return;
    }
    switch (mode) {
      case "uv-winding":
        meshOne.geometry = uvWindingGeom ?? activeGeom();
        meshOne.material = uvWindingGeom
          ? mats.uvWinding
          : texturedSurface && hasTexMaterials && texMaterials
            ? texMaterials
            : mats.shaded;
        break;
      case "u-dir":
        meshOne.material = texturedSurface && hasTexMaterials && texMaterials ? texMaterials : mats.shaded;
        if (uDirLinesGeom) {
          overlayRef.uDirLines = new THREE.LineSegments(
            uDirLinesGeom.clone(),
            new THREE.LineBasicMaterial({
              vertexColors: true,
              toneMapped: false,
            })
          );
          scene.add(overlayRef.uDirLines);
        }
        break;
      case "wireframe":
        meshOne.material = mats.wire;
        break;
      case "normals":
        meshOne.material = mats.normal;
        break;
      case "vert-norms": {
        meshOne.material = mats.shaded;
        const hvn = new VertexNormalsHelperCtor(meshOne, 0.12, 0x55e0ff);
        scene.add(hvn);
        overlayRef.vertNormHelpers.push(hvn);
        break;
      }
      case "edges": {
        meshOne.visible = false;
        const eg = new THREE.EdgesGeometry(meshOne.geometry, 32);
        overlayRef.edgesLines = new THREE.LineSegments(
          eg,
          new THREE.LineBasicMaterial({ color: 0x7ae8ff })
        );
        scene.add(overlayRef.edgesLines);
        break;
      }
      default:
        meshOne.material = texturedSurface && hasTexMaterials && texMaterials ? texMaterials : mats.shaded;
    }
  }

  const renderer = new THREE.WebGLRenderer({
    canvas: previewPsxCanvas,
    antialias: true,
    alpha: true,
    premultipliedAlpha: false,
    powerPreference: "low-power",
  });
  renderer.setClearColor(scene.background, 1);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.03, 50);
  camera.position.set(0.85, 0.65, 1.35);

  const controls = new OrbitControlsCtor(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.45;
  controls.update();

  /** @type {import("../../psx-animation.js").PsxAnimClip | null} */
  let animClip = null;
  let animScanNotes = "";
  if (usePartGroup) {
    const sr = scanPsxAnimationHeuristic(data, parsed.modelCount);
    animClip = sr.clip;
    animScanNotes = sr.scanNotes;
  }

  let animMode = "off";
  let animPlaying = false;
  let animFrameIndex = 0;
  let animTime = 0;
  let lastAnimTs = 0;
  const animFps = 30;

  function syncAnimStatusUi() {
    if (!usePartGroup) return;
    if (animMode === "off") {
      previewPsxAnimStatus.textContent = "";
    } else if (animMode === "demo") {
      previewPsxAnimStatus.textContent = "Demo rigid motion (not from disk)";
    } else if (animClip) {
      const fi = Math.floor(animFrameIndex);
      const tail = animScanNotes.length > 90 ? `${animScanNotes.slice(0, 90)}…` : animScanNotes;
      previewPsxAnimStatus.textContent = `Frame ${fi + 1}/${animClip.frames.length} · ${tail}`;
    }
  }

  function applyAnimModeFromUi() {
    if (!mesh.isGroup) return;
    const v = previewPsxAnimMode.value;
    animMode = v === "demo" ? "demo" : v === "clip" ? "clip" : "off";
    animPlaying = false;
    previewPsxAnimPlay.textContent = "Play";
    previewPsxAnimPlay.disabled = animMode === "off";
    if (animMode === "off") {
      restorePartBindPose(mesh);
      lastAnimTs = 0;
    } else {
      ensurePartBindPoseUserData(mesh);
      lastAnimTs = 0;
      animFrameIndex = 0;
      animTime = 0;
      if (animMode === "clip" && animClip) {
        applyPsxAnimClipFrame(THREE, mesh, animClip, 0);
        previewPsxAnimFrame.value = "0";
      }
    }
    syncAnimStatusUi();
  }

  function animTickStep(nowMs) {
    if (!mesh.isGroup) return;
    if (animMode === "off") return;
    if (lastAnimTs === 0) lastAnimTs = nowMs;
    const dt = (nowMs - lastAnimTs) / 1000;
    lastAnimTs = nowMs;
    ensurePartBindPoseUserData(mesh);
    if (animMode === "demo") {
      if (animPlaying) animTime += dt;
      applyDemoRigidPartWave(THREE, mesh, animTime);
    } else if (animMode === "clip" && animClip) {
      if (animPlaying) {
        animFrameIndex += dt * animFps;
        const n = animClip.frames.length;
        while (animFrameIndex >= n) animFrameIndex -= n;
        previewPsxAnimFrame.value = String(Math.floor(animFrameIndex));
      }
      applyPsxAnimClipFrame(THREE, mesh, animClip, Math.floor(animFrameIndex));
    }
    syncAnimStatusUi();
  }

  const psxFrameState = { rafId: 0 };
  function tick() {
    if (viewMode !== "3d") return;
    psxFrameState.rafId = requestAnimationFrame(tick);
    controls.update();
    animTickStep(performance.now());
    for (const h of overlayRef.vertNormHelpers) {
      if (h && typeof h.update === "function") h.update();
    }
    renderer.render(scene, camera);
  }

  const resize = () => {
    const r = previewPsxCanvasStack.getBoundingClientRect();
    const W = Math.max(180, Math.floor(r.width));
    const H = Math.max(200, Math.floor(r.height));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    if (viewMode === "uv") drawUvSheet();
  };

  function drawUvSheet() {
    if (!hasTextured || !parsed.textured) return;
    const ctx = previewPsxUvCanvas.getContext("2d");
    if (!ctx) return;
    const r = previewPsxCanvasStack.getBoundingClientRect();
    const W = Math.max(2, Math.floor(r.width));
    const H = Math.max(2, Math.floor(r.height));
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    previewPsxUvCanvas.width = Math.floor(W * dpr);
    previewPsxUvCanvas.height = Math.floor(H * dpr);
    previewPsxUvCanvas.style.width = `${W}px`;
    previewPsxUvCanvas.style.height = `${H}px`;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#12151c";
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(uvPanX, uvPanY);
    ctx.scale(uvZoom, uvZoom);
    drawPsxUvTexturePreview(ctx, W, H, parsed.textured);
    ctx.restore();
  }

  const viewModeAbort = new AbortController();

  function uvClientToCanvas(/** @type {number} */ cx, /** @type {number} */ cy) {
    const b = previewPsxUvCanvas.getBoundingClientRect();
    return { x: cx - b.left, y: cy - b.top };
  }

  previewPsxUvCanvas.addEventListener(
    "wheel",
    (e) => {
      if (viewMode !== "uv") return;
      e.preventDefault();
      const { x: mx, y: my } = uvClientToCanvas(e.clientX, e.clientY);
      const wx = (mx - uvPanX) / uvZoom;
      const wy = (my - uvPanY) / uvZoom;
      const nextZoom = clampUvZoom(uvZoom * Math.exp(-e.deltaY * 0.002));
      uvPanX = mx - wx * nextZoom;
      uvPanY = my - wy * nextZoom;
      uvZoom = nextZoom;
      drawUvSheet();
    },
    { passive: false, signal: viewModeAbort.signal }
  );

  previewPsxUvCanvas.addEventListener(
    "pointerdown",
    (e) => {
      if (viewMode !== "uv" || e.button !== 0) return;
      e.preventDefault();
      uvDragPointerId = e.pointerId;
      uvLastClientX = e.clientX;
      uvLastClientY = e.clientY;
      previewPsxUvCanvas.setPointerCapture(e.pointerId);
      previewPsxUvCanvas.style.cursor = "grabbing";
    },
    { signal: viewModeAbort.signal }
  );

  previewPsxUvCanvas.addEventListener(
    "pointermove",
    (e) => {
      if (viewMode !== "uv" || e.pointerId !== uvDragPointerId || uvDragPointerId === null) return;
      const dx = e.clientX - uvLastClientX;
      const dy = e.clientY - uvLastClientY;
      uvLastClientX = e.clientX;
      uvLastClientY = e.clientY;
      uvPanX += dx;
      uvPanY += dy;
      drawUvSheet();
    },
    { passive: true, signal: viewModeAbort.signal }
  );

  function uvEndDrag(/** @type {PointerEvent} */ e) {
    if (e.pointerId !== uvDragPointerId) return;
    uvDragPointerId = null;
    previewPsxUvCanvas.style.cursor = "grab";
    try {
      previewPsxUvCanvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  previewPsxUvCanvas.addEventListener("pointerup", uvEndDrag, { signal: viewModeAbort.signal });
  previewPsxUvCanvas.addEventListener("pointercancel", uvEndDrag, { signal: viewModeAbort.signal });

  previewPsxUvCanvas.addEventListener(
    "dblclick",
    (e) => {
      if (viewMode !== "uv") return;
      e.preventDefault();
      uvPanX = 0;
      uvPanY = 0;
      uvZoom = 1;
      drawUvSheet();
    },
    { signal: viewModeAbort.signal }
  );

  function syncPsxViewModeUi() {
    const is3d = viewMode === "3d";
    previewPsxViewMode3d.classList.toggle("is-active", is3d);
    previewPsxViewModeUv.classList.toggle("is-active", !is3d);
    previewPsxViewMode3d.setAttribute("aria-checked", is3d ? "true" : "false");
    previewPsxViewModeUv.setAttribute("aria-checked", is3d ? "false" : "true");
  }

  function setViewMode(next) {
    const isUv = next === "uv" && hasTextured && parsed.textured;
    viewMode = isUv ? "uv" : "3d";
    syncPsxViewModeUi();
    if (viewMode === "uv") {
      cancelAnimationFrame(psxFrameState.rafId);
      psxFrameState.rafId = 0;
      previewPsxCanvas.classList.add("is-hidden");
      previewPsxUvCanvas.classList.remove("is-hidden");
      previewPsxUvCanvas.setAttribute("aria-hidden", "false");
      previewPsxUvCanvas.style.cursor = "grab";
      controls.enabled = false;
      previewPsxDebugMode.disabled = true;
      resize();
      drawUvSheet();
    } else {
      uvDragPointerId = null;
      previewPsxUvCanvas.style.removeProperty("cursor");
      previewPsxUvCanvas.classList.add("is-hidden");
      previewPsxUvCanvas.setAttribute("aria-hidden", "true");
      previewPsxCanvas.classList.remove("is-hidden");
      controls.enabled = true;
      previewPsxDebugMode.disabled = false;
      resize();
      cancelAnimationFrame(psxFrameState.rafId);
      psxFrameState.rafId = requestAnimationFrame(tick);
    }
    syncPsxHint();
  }

  previewPsxViewMode3d.addEventListener("click", () => setViewMode("3d"), { signal: viewModeAbort.signal });
  previewPsxViewModeUv.addEventListener("click", () => setViewMode("uv"), { signal: viewModeAbort.signal });

  previewPsxWrap.classList.remove("is-hidden");
  previewPsxToolbarEl.classList.remove("is-hidden");
  previewBlock.classList.add("preview-block--psx-toolbar");
  previewEl.classList.add("is-hidden");
  previewEl.textContent = "";
  previewEl.classList.remove("is-idle");
  previewHint.hidden = false;

  let assemblyWanted = false;
  try {
    assemblyWanted = localStorage.getItem(PSX_CHARACTER_ASSEMBLY_STORAGE_KEY) === "1";
  } catch {
    assemblyWanted = false;
  }

  let hint = "";
    hint += hasTextured
      ? parsed.textured?.textureSource === "external"
        ? ` (external texture .psx resolved via texhash lookup).`
        : ` (embedded 4/8bpp textures + UVs; THPS2X / odd palettes may be incomplete).`
      : state.externalPsxTextureSource
        ? ` (no textures resolved from the current mesh + external texture source).`
        : ` (no texture source resolved for this path).`;
  if (parsed.characterAssembly) {
    hint += ` Character bind pose: parts merged using pad=1 sockets / pad=2 plug keys (global ordinal table).`;
  } else if (assemblyWanted && parsed.modelCount > 1) {
    hint += ` Assembly is enabled but did not finish (keys may not line up). Check the browser console for the one-shot warning, or use “Pad report”.`;
  } else if (!assemblyWanted && parsed.modelCount > 1) {
    hint += ` Multi-part file: preview uses the largest mesh part. Turn on “Assemble” to try socket/plug merge, or “Pad report” for diagnostics.`;
  }
  if (parsed.multiPartCharacterPreview && parsed.previewPartIndex !== undefined) {
    hint += ` Showing part index ${nf.format(parsed.previewPartIndex)} only (largest mesh); other parts stay in bone-local space — use .psh indices + skeleton to compose.`;
  }
  hintBase = hint;
  syncPsxHint();

  const ro = new ResizeObserver(() => resize());
  ro.observe(previewPsxCanvasStack);

  /** @type {string} */
  let initialMode = "shaded";
  try {
    const s = localStorage.getItem(STORAGE_PSX_DEBUG_MODE);
    if (
      s &&
      ["shaded", "uv-winding", "u-dir", "wireframe", "normals", "vert-norms", "edges"].includes(s)
    ) {
      initialMode = s;
    }
  } catch {
    /* ignore */
  }
  previewPsxDebugMode.value = initialMode;
  applyDebugMode(initialMode);

  /* Always start in 3D mesh view; UV mode is session-only (not persisted — avoids "stuck" on UV). */
  setViewMode("3d");

  if (usePartGroup) {
    previewPsxPartsAside.classList.remove("is-hidden");
    previewPsxPartsAside.classList.remove("is-collapsed");
    previewPsxPartList.hidden = false;
    previewPsxPartsToggle.setAttribute("aria-expanded", "true");
    previewPsxPartList.replaceChildren();
    for (let m = 0; m < partAssets.length; m++) {
      const pa = partAssets[m];
      if (!pa) continue;
      const id = `preview-psx-part-${m}`;
      const label = document.createElement("label");
      label.className = "preview-psx-part-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.id = id;
      const span = document.createElement("span");
      span.textContent = `Part ${m}`;
      label.appendChild(cb);
      label.appendChild(span);
      previewPsxPartList.appendChild(label);
      cb.addEventListener(
        "change",
        () => {
          const ch = mesh.children.find((c) => c.userData.partIndex === m);
          if (ch) ch.userData.partEnabled = cb.checked;
          applyDebugMode(previewPsxDebugMode.value);
        },
        { signal: viewModeAbort.signal }
      );
    }
    previewPsxPartsToggle.addEventListener(
      "click",
      () => {
        const collapsed = previewPsxPartsAside.classList.toggle("is-collapsed");
        previewPsxPartList.hidden = collapsed;
        previewPsxPartsToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      },
      { signal: viewModeAbort.signal }
    );

    const optClip = previewPsxAnimMode.querySelector('option[value="clip"]');
    if (optClip) {
      optClip.disabled = !animClip;
      optClip.title = animClip
        ? animScanNotes
        : "THPS1/2 animation bytes are undocumented — heuristic scan found no matching block";
    }
    previewPsxAnimRow.classList.remove("is-hidden");
    previewPsxAnimMode.value = "off";
    animMode = "off";
    animPlaying = false;
    previewPsxAnimPlay.textContent = "Play";
    previewPsxAnimPlay.disabled = true;
    if (animClip) {
      previewPsxAnimFrame.min = "0";
      previewPsxAnimFrame.max = String(animClip.frames.length - 1);
      previewPsxAnimFrame.value = "0";
      previewPsxAnimFrame.disabled = false;
    } else {
      previewPsxAnimFrame.min = "0";
      previewPsxAnimFrame.max = "0";
      previewPsxAnimFrame.value = "0";
      previewPsxAnimFrame.disabled = true;
    }
    previewPsxAnimStatus.textContent = animScanNotes
      ? animScanNotes.slice(0, 220) + (animScanNotes.length > 220 ? "…" : "")
      : "";

    previewPsxAnimMode.addEventListener("change", applyAnimModeFromUi, { signal: viewModeAbort.signal });
    previewPsxAnimPlay.addEventListener(
      "click",
      () => {
        if (!mesh.isGroup) return;
        if (animMode === "off") return;
        animPlaying = !animPlaying;
        previewPsxAnimPlay.textContent = animPlaying ? "Pause" : "Play";
        lastAnimTs = 0;
      },
      { signal: viewModeAbort.signal }
    );
    previewPsxAnimFrame.addEventListener(
      "input",
      () => {
        if (!animClip || animMode !== "clip") return;
        animFrameIndex = Number(previewPsxAnimFrame.value);
        animPlaying = false;
        previewPsxAnimPlay.textContent = "Play";
        applyPsxAnimClipFrame(THREE, mesh, animClip, Math.floor(animFrameIndex));
        syncAnimStatusUi();
      },
      { signal: viewModeAbort.signal }
    );
  } else {
    previewPsxPartsAside.classList.add("is-hidden");
    previewPsxPartList.replaceChildren();
    previewPsxPartsAside.classList.remove("is-collapsed");
    previewPsxPartList.hidden = false;
    previewPsxPartsToggle.setAttribute("aria-expanded", "true");
    previewPsxAnimRow.classList.add("is-hidden");
  }

  /** @type {import("three").BufferGeometry[]} */
  const psxDisposeGeoms = [plainGeom, texturedGeom, uvWindingGeom, uDirLinesGeom].filter(Boolean);
  if (usePartGroup) {
    for (const pa of partAssets) {
      if (!pa) continue;
      if (pa.plainGeom) psxDisposeGeoms.push(pa.plainGeom);
      if (pa.texturedGeom) psxDisposeGeoms.push(pa.texturedGeom);
      if (pa.uvWindingGeom) psxDisposeGeoms.push(pa.uvWindingGeom);
      if (pa.uDirLinesGeom) psxDisposeGeoms.push(pa.uDirLinesGeom);
    }
  }

  state.psxPreviewCtx = {
    state: psxFrameState,
    renderer,
    controls,
    geoms: psxDisposeGeoms,
    scene,
    mesh,
    psxGround,
    mats,
    texMaterials: hasTexMaterials ? texMaterials : null,
    partTexMaterials: partTexMaterials.length ? partTexMaterials : null,
    overlayRef,
    applyDebugMode,
    ro,
    viewAbort: viewModeAbort,
  };

  updateCopyButtonState();
  return true;
}

function setPreviewIdle(message) {
  disposePsxPreview();
  hideAudioPreview();
  hidePrkPreview();
  hideImagePreview();
  state.previewClipboardText = "";
  previewEl.classList.remove("is-hidden");
  previewEl.textContent = message;
  previewEl.classList.add("is-idle");
  previewHint.hidden = false;
  previewHint.textContent = DEFAULT_PREVIEW_HINT;
  updateCopyButtonState();
}

/**
 * @param {string} text — shown in the panel
 * @param {string} [clipboardText] — copied when user clicks Copy (defaults to `text`)
 * @param {string} [hint]
 */
function setPreviewContent(text, clipboardText = text, hint = DEFAULT_PREVIEW_HINT) {
  disposePsxPreview();
  hideAudioPreview();
  hidePrkPreview();
  hideImagePreview();
  state.previewClipboardText = clipboardText;
  previewEl.classList.remove("is-hidden");
  previewEl.textContent = text;
  previewEl.classList.remove("is-idle");
  previewHint.hidden = false;
  previewHint.textContent = hint;
  updateCopyButtonState();
}

function clearSelectionVisual() {
  treeEl.querySelectorAll(".tree-item.is-selected").forEach((n) => {
    n.classList.remove("is-selected");
  });
  filesBody.querySelectorAll("tr.is-selected").forEach((n) => n.classList.remove("is-selected"));
  filesTiles.querySelectorAll(".file-tile.is-selected").forEach((n) => n.classList.remove("is-selected"));
}

/**
 * @param {number} di
 * @param {number} fi
 */
function highlightSelection(di, fi) {
  clearSelectionVisual();
  const dirItem = treeEl.querySelector(`.tree-item[data-dir-index="${di}"]`);
  if (dirItem) dirItem.classList.add("is-selected");
  if (fi >= 0) {
    const row = filesBody.querySelector(`tr[data-dir-index="${di}"][data-file-index="${fi}"]`);
    if (row) row.classList.add("is-selected");
    const tile = filesTiles.querySelector(
      `.file-tile[data-dir-index="${di}"][data-file-index="${fi}"]`
    );
    if (tile) tile.classList.add("is-selected");
  }
}

/** @param {string} fileName */
function fileNameMatchesTypeFilter(fileName) {
  if (state.activeFileTypeSet.size === 0) return true;
  const ext = getFileExtension(fileName);
  if (ext === "") return state.activeFileTypeSet.has("noext");
  return state.activeFileTypeSet.has(ext);
}

function applyFileFilter() {
  const q = fileFilter.value.trim().toLowerCase();
  const shouldHide = (/** @type {string} */ name) => {
    if (q && !name.toLowerCase().includes(q)) return true;
    return !fileNameMatchesTypeFilter(name);
  };
  filesBody.querySelectorAll("tr").forEach((tr) => {
    tr.classList.toggle("is-filtered", shouldHide(tr.dataset.fileName || ""));
  });
  filesTiles.querySelectorAll(".file-tile").forEach((el) => {
    el.classList.toggle("is-filtered", shouldHide(el.dataset.fileName || ""));
  });
}

/**
 * @param {import("./pkr.js").PkrDir | null} dir
 */
function rebuildFileTypeFilterUi(dir) {
  fileTypeFilterPanel.replaceChildren();
  if (!dir || dir.files.length === 0) {
    syncFileTypeFilterButtonLabel();
    return;
  }

  /** @type {Map<string, number>} */
  const byExt = new Map();
  let noExtCount = 0;
  for (const f of dir.files) {
    const e = getFileExtension(f.name);
    if (e === "") noExtCount++;
    else byExt.set(e, (byExt.get(e) ?? 0) + 1);
  }

  for (const t of [...state.activeFileTypeSet]) {
    if (t === "noext" && noExtCount === 0) state.activeFileTypeSet.delete(t);
    else if (t !== "noext" && !byExt.has(t)) state.activeFileTypeSet.delete(t);
  }

  /** @param {string} token @param {string} labelText */
  function addOption(token, labelText) {
    const isAll = token === "all";
    const checked = isAll ? state.activeFileTypeSet.size === 0 : state.activeFileTypeSet.has(token);
    const row = document.createElement("label");
    row.className = "file-type-filter-option";
    if (checked) row.classList.add("is-active");
    row.dataset.fileTypeToken = token;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "file-type-filter-option__check";
    cb.checked = checked;
    if (isAll) {
      cb.title = "Show every file type in this folder";
    } else {
      cb.title = token === "noext" ? "Toggle files with no extension" : `Toggle ${token} files`;
    }
    const text = document.createElement("span");
    text.className = "file-type-filter-option__text";
    text.textContent = labelText;
    row.append(cb, text);
    fileTypeFilterPanel.append(row);
  }

  addOption("all", "All types");
  const extKeys = [...byExt.keys()].sort((a, b) => a.localeCompare(b));
  for (const ek of extKeys) {
    addOption(ek, `${ek} (${nf.format(byExt.get(ek) ?? 0)})`);
  }
  if (noExtCount > 0) {
    addOption("noext", `(no extension) (${nf.format(noExtCount)})`);
  }

  syncFileTypeFilterButtonLabel();
}

function syncFileTypeFilterButtonLabel() {
  const n = state.activeFileTypeSet.size;
  if (n === 0) {
    fileTypeFilterLabel.textContent = "FILE_TYPE";
    fileTypeFilterBtn.classList.remove("has-active-filter");
    fileTypeFilterBtn.title = "Filter files by extension in this folder (check one or more types)";
    return;
  }
  fileTypeFilterBtn.classList.add("has-active-filter");
  const first = [...state.activeFileTypeSet].sort((a, b) => a.localeCompare(b))[0];
  const firstLabel = first === "noext" ? "no extension" : first;
  if (n === 1) {
    fileTypeFilterLabel.textContent = `TYPE: ${firstLabel}`;
    fileTypeFilterBtn.title = `Showing only ${firstLabel} — open to add or remove types`;
    return;
  }
    fileTypeFilterLabel.textContent = `TYPES: ${n}`;
  fileTypeFilterBtn.title = `Filtering to ${n} types — open to change`;
}

function syncFileTypeFilterPanelCheckboxes() {
  fileTypeFilterPanel.querySelectorAll("[data-file-type-token]").forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    const token = node.dataset.fileTypeToken;
    if (!token) return;
    const cb = node.querySelector(".file-type-filter-option__check");
    if (!(cb instanceof HTMLInputElement)) return;
    const isAll = token === "all";
    const checked = isAll ? state.activeFileTypeSet.size === 0 : state.activeFileTypeSet.has(token);
    cb.checked = checked;
    node.classList.toggle("is-active", checked);
  });
}

/** Visible rows or tiles in DOM order (respects name + type filters). */
function getVisibleFileElements() {
  if (state.fileViewMode === "list") {
    return Array.from(filesBody.querySelectorAll("tr:not(.is-filtered)"));
  }
  return Array.from(filesTiles.querySelectorAll(".file-tile:not(.is-filtered)"));
}

function scrollFileSelectionIntoView() {
  if (state.fileViewMode === "list") {
    filesBody.querySelector("tr.is-selected")?.scrollIntoView({ block: "nearest" });
  } else {
    filesTiles.querySelector(".file-tile.is-selected")?.scrollIntoView({ block: "nearest" });
  }
}

/**
 * @param {number} di
 * @param {number} fi
 */
function selectFileEntry(di, fi) {
  if (!state.currentArchive || di < 0 || fi < 0) return;
  state.selectedDirIndex = di;
  state.selectedFileIndex = fi;
  highlightSelection(di, fi);
  void showFileDetail(di, fi);
  scrollFileSelectionIntoView();
  tableShell.focus({ preventScroll: true });
}

/**
 * @param {number} delta — 1 = next, -1 = previous
 */
function moveFileSelection(delta) {
  if (!state.currentArchive || state.selectedDirIndex < 0) return;
  const els = getVisibleFileElements();
  if (els.length === 0) return;
  let idx = els.findIndex(
    (el) =>
      Number(el.dataset.dirIndex) === state.selectedDirIndex &&
      Number(el.dataset.fileIndex) === state.selectedFileIndex
  );
  if (idx < 0) {
    idx = delta > 0 ? 0 : els.length - 1;
  } else {
    idx = Math.max(0, Math.min(els.length - 1, idx + delta));
  }
  const el = els[idx];
  selectFileEntry(Number(el.dataset.dirIndex), Number(el.dataset.fileIndex));
}

/** Tiles in the same grid row share the same top (within a few px); works with auto-fill columns. */
const TILE_GRID_ROW_TOP_EPS_PX = 3;

/**
 * @param {HTMLElement[]} tiles
 */
function getTilesGridColumnCount(tiles) {
  if (tiles.length === 0) return 1;
  const y0 = tiles[0].getBoundingClientRect().top;
  let n = 0;
  for (const t of tiles) {
    if (Math.abs(t.getBoundingClientRect().top - y0) <= TILE_GRID_ROW_TOP_EPS_PX) n++;
    else break;
  }
  return Math.max(1, n);
}

/**
 * Grid / tiles view: left-right move within a row; up-down move by one row.
 * @param {"left" | "right" | "up" | "down"} dir
 */
function moveFileSelectionGrid(dir) {
  if (!state.currentArchive || state.selectedDirIndex < 0) return;
  const els = getVisibleFileElements();
  if (els.length === 0) return;
  const cols = getTilesGridColumnCount(els);
  let idx = els.findIndex(
    (el) =>
      Number(el.dataset.dirIndex) === state.selectedDirIndex &&
      Number(el.dataset.fileIndex) === state.selectedFileIndex
  );
  if (idx < 0) {
    idx = dir === "right" || dir === "down" ? 0 : els.length - 1;
  }
  let newIdx = idx;
  if (dir === "left") {
    newIdx = Math.max(0, idx - 1);
  } else if (dir === "right") {
    newIdx = Math.min(els.length - 1, idx + 1);
  } else if (dir === "up") {
    newIdx = idx - cols;
    if (newIdx < 0) return;
  } else if (dir === "down") {
    newIdx = idx + cols;
    if (newIdx >= els.length) return;
  }
  const el = els[newIdx];
  selectFileEntry(Number(el.dataset.dirIndex), Number(el.dataset.fileIndex));
}

/** @param {boolean} toEnd */
function goFileEdge(toEnd) {
  if (!state.currentArchive || state.selectedDirIndex < 0) return;
  const els = getVisibleFileElements();
  if (els.length === 0) return;
  const el = toEnd ? els[els.length - 1] : els[0];
  selectFileEntry(Number(el.dataset.dirIndex), Number(el.dataset.fileIndex));
}

function initFileListKeyboardNav() {
  tableShell.addEventListener("keydown", (e) => {
    if (workspaceEl.classList.contains("is-hidden") || !state.currentArchive) return;
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const k = e.key;
    const tilesArrow =
      state.fileViewMode === "tiles" &&
      (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown");
    const listArrow = state.fileViewMode === "list" && (k === "ArrowUp" || k === "ArrowDown");
    if (!tilesArrow && !listArrow && k !== "Home" && k !== "End" && k !== "Enter") return;
    const visible = getVisibleFileElements();
    if (visible.length === 0) return;
    if (k === "Enter") {
      if (state.selectedFileIndex >= 0) return;
      e.preventDefault();
      goFileEdge(false);
      return;
    }
    if (k === "Home" || k === "End") {
      e.preventDefault();
      if (k === "Home") goFileEdge(false);
      else goFileEdge(true);
      return;
    }
    e.preventDefault();
    if (state.fileViewMode === "tiles") {
      if (k === "ArrowLeft") moveFileSelectionGrid("left");
      else if (k === "ArrowRight") moveFileSelectionGrid("right");
      else if (k === "ArrowUp") moveFileSelectionGrid("up");
      else moveFileSelectionGrid("down");
    } else {
      if (k === "ArrowDown") moveFileSelection(1);
      else moveFileSelection(-1);
    }
  });
}

function renderTree() {
  treeEl.replaceChildren();
  if (!state.currentArchive) return;

  const rootUl = document.createElement("ul");
  state.currentArchive.dirs.forEach((dir, di) => {
    const li = document.createElement("li");
    li.className = "tree-row";

    const row = document.createElement("button");
    row.type = "button";
    row.className = "tree-item";
    row.dataset.dirIndex = String(di);
    const nFiles = dir.files.length;
    row.title = `${nf.format(nFiles)} files — show in file list`;

    const label = document.createElement("span");
    label.className = "tree-item__label";
    label.textContent = dir.name || "(unnamed folder)";

    const count = document.createElement("span");
    count.className = "tree-item__count";
    count.textContent = nf.format(nFiles);

    row.append(label, count);

    row.addEventListener("click", () => {
      state.selectedDirIndex = di;
      state.selectedFileIndex = -1;
      highlightSelection(di, -1);
      fileFilter.value = "";
      renderFilesTable(di);
      showDirDetail(di);
      setPreviewIdle("Select a file to preview its contents.");
      inspectorPaneActions.hidden = true;
      tableShell.focus({ preventScroll: true });
    });

    const zipBtn = document.createElement("button");
    zipBtn.type = "button";
    zipBtn.className = "tree-item__zip";
    zipBtn.appendChild(folderZipIconSvg("tree-item__zip-icon"));
    zipBtn.title = "Download this folder as a ZIP (all files decompressed)";
    zipBtn.setAttribute(
      "aria-label",
      `Download folder ${dir.name || "(unnamed)"} as ZIP`
    );
    zipBtn.disabled = nFiles === 0;
    zipBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void downloadFolderZip(di);
    });

    li.append(row, zipBtn);
    rootUl.append(li);
  });

  treeEl.append(rootUl);
}

/**
 * @param {number} di
 * @param {{ preserveFilter?: boolean }} [options]
 */
function renderFilesTable(di, options = {}) {
  const preserveFilter = options.preserveFilter === true;
  filesBody.replaceChildren();
  revokeAllTileThumbUrls();
  filesTiles.replaceChildren();
  if (!preserveFilter) {
    fileFilter.value = "";
    state.activeFileTypeSet.clear();
  }
  if (!state.currentArchive || di < 0 || di >= state.currentArchive.dirs.length) {
    state.activeFileTypeSet.clear();
    rebuildFileTypeFilterUi(null);
    return;
  }

  const dir = state.currentArchive.dirs[di];
  const ordered = getSortedFileDisplayOrder(dir);

  ordered.forEach(({ entry, originalIndex: fi }) => {
    const { label, pillClass, title } = compressionUi(entry);
    const inArchive = inArchiveBytes(entry);

    const onSelect = () => {
      selectFileEntry(di, fi);
    };

    if (state.fileViewMode === "list") {
      const tr = document.createElement("tr");
      tr.dataset.dirIndex = String(di);
      tr.dataset.fileIndex = String(fi);
      tr.dataset.fileName = entry.name;

      const typeTd = document.createElement("td");
      typeTd.className = "files-table__type";
      const glyph = document.createElement("span");
      glyph.className =
        entry.compression === COMPRESSED_ZLIB
          ? "files-type-glyph files-type-glyph--zlib"
          : "files-type-glyph files-type-glyph--raw";
      glyph.setAttribute("aria-hidden", "true");
      typeTd.append(glyph, document.createTextNode(` ${label.toUpperCase()}`));

      const nameTd = document.createElement("td");
      nameTd.className = "files-table__filename";
      nameTd.textContent = entry.name;
      nameTd.title = entry.name;

      const extTd = document.createElement("td");
      extTd.className = "files-table__ext";
      extTd.textContent = formatFileExtDisplay(entry.name);

      const szTd = document.createElement("td");
      szTd.className = "col-num";
      szTd.textContent = formatBytes(entry.uncompressed_size);
      szTd.title = `${nf.format(entry.uncompressed_size)} bytes`;

      const arcTd = document.createElement("td");
      arcTd.className = "col-num";
      arcTd.textContent = formatBytes(inArchive);
      arcTd.title = `${nf.format(inArchive)} bytes on disk`;

      const offTd = document.createElement("td");
      offTd.className = "col-num mono-soft";
      offTd.textContent = `0x${entry.offset.toString(16).toUpperCase()}`;

      const dlTd = document.createElement("td");
      dlTd.className = "files-table__dl col-num";
      dlTd.append(makeInlineDownloadButton(di, fi, entry.name));

      tr.append(typeTd, nameTd, extTd, szTd, arcTd, offTd, dlTd);
      tr.addEventListener("click", onSelect);
      filesBody.append(tr);
    } else {
      const tile = document.createElement("div");
      tile.className = "file-tile";
      tile.dataset.dirIndex = String(di);
      tile.dataset.fileIndex = String(fi);
      tile.dataset.fileName = entry.name;

      const head = document.createElement("div");
      head.className = "file-tile__head";
      const idEl = document.createElement("span");
      idEl.className = "file-tile__id";
      idEl.textContent = `F_${String(fi).padStart(3, "0")}`;
      const stamp = document.createElement("span");
      stamp.className = "file-tile__stamp";
      stamp.textContent = formatHexU32(entry.offset >>> 0);
      head.append(idEl, stamp);

      const nameEl = document.createElement("div");
      nameEl.className = "file-tile__name";
      nameEl.textContent = entry.name;
      nameEl.title = entry.name;

      const meta = document.createElement("div");
      meta.className = "file-tile__meta";
      const pill = document.createElement("span");
      pill.className = pillClass;
      pill.textContent = label;
      pill.title = title;
      meta.append(
        document.createTextNode(`SIZE: ${formatBytes(entry.uncompressed_size)} // `),
        pill
      );

      const stack = document.createElement("div");
      stack.className = "file-tile__stack";
      stack.append(nameEl, meta);

      const dlBtn = makeInlineDownloadButton(di, fi, entry.name);

      const body = document.createElement("div");
      body.className = "file-tile__body";
      body.append(stack, dlBtn);

      const usePsxThumb =
        isPsxFileName(entry.name) && entry.uncompressed_size <= TILE_PSX_THUMB_MAX_BYTES;
      const useBmpThumb =
        isBmpFileName(entry.name) && entry.uncompressed_size <= TILE_BMP_THUMB_MAX_BYTES;

      if (usePsxThumb || useBmpThumb) {
        tile.classList.add("file-tile--with-thumb");
        const thumbWrap = document.createElement("span");
        thumbWrap.className = "file-tile__thumb-wrap";
        const thumbImg = document.createElement("img");
        thumbImg.className = "file-tile__thumb";
        thumbImg.alt = "";
        thumbImg.dataset.pending = "1";
        if (usePsxThumb) thumbImg.dataset.thumbKind = "psx";
        thumbWrap.append(thumbImg);
        tile.append(head, thumbWrap, body);
        wireFileTileInteractions(tile, onSelect);
        filesTiles.append(tile);
        ensureTileThumbObserver().observe(tile);
      } else {
        const heroMod = fileTileHeroClass(entry.name);
        const extDisp = formatFileExtDisplay(entry.name);
        const extHero = extDisp === "—" ? ".BIN" : extDisp;
        const hero = document.createElement("div");
        hero.className = `file-tile__hero ${heroMod}`;
        const extBig = document.createElement("span");
        extBig.className = "file-tile__ext-label";
        extBig.textContent = extHero;
        const extBar = document.createElement("span");
        extBar.className = "file-tile__ext-bar";
        hero.append(extBig, extBar);
        tile.append(head, hero, body);
        wireFileTileInteractions(tile, onSelect);
        filesTiles.append(tile);
      }
    }
  });
  rebuildFileTypeFilterUi(dir);
  applyFileFilter();
  syncFileSortHeaderUi();
}

/**
 * @param {number} di
 */
function showDirDetail(di) {
  if (!state.currentArchive || di < 0) return;
  const dir = state.currentArchive.dirs[di];
  folderTitle.textContent = dir.name || "(unnamed folder)";
  folderSubtitle.textContent = `RECORDS_FOUND: ${nf.format(dir.files.length)} // USE ↑↓ OR CLICK`;

  inspectorFileTitle.textContent = dir.name || "(folder)";
  inspectorFileKind.textContent = "Folder";
  inspectorPaneActions.hidden = true;

  detailEl.innerHTML = `
    <div class="detail-empty">
      <p class="detail-empty__kicker">Folder</p>
      <p class="detail-empty__name">${escapeHtml(dir.name || "—")}</p>
      <p class="detail-empty__meta">${nf.format(dir.files.length)} files — choose one from the list or grid.</p>
    </div>`;
}

/**
 * @param {number} di
 * @param {number} fi
 */
async function showFileDetail(di, fi) {
  if (!state.currentArchive || !state.currentBuffer || di < 0 || fi < 0) return;
  const dir = state.currentArchive.dirs[di];
  const entry = dir.files[fi];
  folderTitle.textContent = dir.name || "(unnamed folder)";
  folderSubtitle.textContent = entry.name;

  inspectorFileTitle.textContent = entry.name;
  inspectorFileKind.textContent = inspectorKindLabel(entry);

  detailEl.innerHTML = `<p class="detail-loading">Reading file…</p>`;
  setPreviewIdle("Loading preview…");
  inspectorPaneActions.hidden = true;

  try {
    const skip = skipCrc.checked;
    const data = await extractEntry(state.currentBuffer, entry);
    let levelBundle = null;
    if (isPsxFileName(entry.name)) {
      levelBundle = await resolveAutoPsxTextureSource(di, fi);
    } else {
      clearAutoPsxTextureSource();
      updatePsxExternalSourceLabel();
      levelBundle = getLevelBundleForEntry(dir, fi);
    }
    const hasCrc = entry.crc != null;
    const crcOk = !hasCrc || skip || verifyCrc(entry, data);

    let crcHtml;
    if (!hasCrc) {
      crcHtml = "Not stored (THPS2-style archive)";
    } else if (skip) {
      crcHtml = "Skipped";
    } else if (crcOk) {
      crcHtml = `<span class="crc-ok">Verified (0x${(entry.crc ?? 0).toString(16).padStart(8, "0")})</span>`;
    } else {
      crcHtml = `<span class="crc-bad">Mismatch — expected 0x${(entry.crc ?? 0).toString(16).padStart(8, "0")}, computed 0x${crc32(data).toString(16).padStart(8, "0")}</span>`;
    }

    const { label, title } = compressionUi(entry);
    let prkParsed = null;
    let prkParseError = "";
    if (isPrkFileName(entry.name)) {
      try {
        prkParsed = parsePrk(data);
      } catch (err) {
        prkParseError = err instanceof Error ? err.message : String(err);
      }
    }

    const prkMeta = prkParsed
      ? `
          <dt>Theme</dt><dd>${escapeHtml(prkParsed.header.theme)}</dd>
          <dt>Park size</dt><dd>${nf.format(prkParsed.width)} × ${nf.format(prkParsed.height)} cells</dd>
          <dt>Header unk1</dt><dd class="mono-soft">${formatHexU32(prkParsed.header.unk1)}</dd>
          <dt>Cells used</dt><dd>${nf.format(prkParsed.usedCellCount)} / ${nf.format(prkParsed.cells.length)}</dd>
          <dt>Named gaps</dt><dd>${nf.format(prkParsed.namedGaps.length)} / ${nf.format(prkParsed.gaps.length)}</dd>
        `
      : "";

    const prkNote = isPrkFileName(entry.name)
      ? `<dt>Park / level</dt><dd class="detail-prk-note">${
          prkParsed
            ? "Skate park save dump (<code>.prk</code>) with fixed header, cell grid, gap slots, and highscore bytes. The preview now shows a clickable raw grid inspector."
            : `Skate park save dump (<code>.prk</code>). This file did not parse as a known THPS2-style PRK: ${escapeHtml(prkParseError || "unknown parse error")}`
        }</dd>`
      : "";

    const psxNote = isPsxFileName(entry.name)
      ? `<dt>Mesh</dt><dd class="detail-prk-note"><code>.psx</code> — Neversoft “Big Guns” engine 3D mesh / level geometry (THPS and related titles). Character rigs list many models in one file (one mesh per skeleton part, indexed like the companion <code>.psh</code>); by default the preview picks the largest single part (optional “Assemble” in the 3D toolbar tries socket/plug merge). ${
          levelBundle?.texture && levelBundle.role !== "texture"
            ? `For this level bundle, the preview auto-resolves <code>${escapeHtml(levelBundle.texture.entry.name)}</code> as the sibling texture library unless you manually override it. `
            : ""
        }“Pad report” prints pad diagnostics to the console. Format notes: <a href="https://gist.github.com/iamgreaser/b54531e41d77b69d7d13391deb0ac6a5" target="_blank" rel="noopener noreferrer">iamgreaser gist</a>.</dd>`
      : "";

    const pshNote = isPshFileName(entry.name)
      ? `<dt>Parts</dt><dd class="detail-prk-note"><code>.psh</code> — C header listing skeleton part IDs (and parent names in comments) for a paired <code>.psx</code>. It does not contain geometry or transforms.</dd>`
      : "";

    const trgNote = /\.trg$/i.test(entry.name)
      ? `<dt>Triggers</dt><dd class="detail-prk-note"><code>.trg</code> — level trigger / script / metadata companion. This explorer does not parse TRG yet; the level bundle strip groups it with sibling mesh and texture entries.</dd>`
      : "";

    const essentialsHtml = `
      <div class="meta-essentials">
        <div class="meta-essential-item">
          <span class="meta-essential-k">Path</span>
          <p class="meta-essential-v">${escapeHtml(dir.name)}/${escapeHtml(entry.name)}</p>
        </div>
        <div class="meta-essential-item">
          <span class="meta-essential-k">Size</span>
          <p class="meta-essential-v">${formatBytes(entry.uncompressed_size)} <span class="mono-soft">(${nf.format(entry.uncompressed_size)} B)</span></p>
        </div>
        <div class="meta-essential-item">
          <span class="meta-essential-k">Offset</span>
          <p class="meta-essential-v mono-soft">0x${entry.offset.toString(16)}</p>
        </div>
        <div class="meta-essential-item">
          <span class="meta-essential-k">Checksum</span>
          <p class="meta-essential-v">${crcHtml}</p>
        </div>
      </div>`;

    const formatInner = `
          <dt>Compression</dt><dd title="${escapeHtml(title)}">${escapeHtml(label)}</dd>
          ${prkMeta}
          ${prkNote}
          ${psxNote}
          ${pshNote}
          ${trgNote}`;

    detailEl.innerHTML = `
      <div class="detail-card">
        ${essentialsHtml}
        <details class="detail-format-expando">
          <summary class="detail-format-expando__summary">Format info</summary>
          <div class="detail-format-expando__body">
            <dl class="meta-grid">${formatInner}</dl>
          </div>
        </details>
      </div>`;
    if (levelBundle) {
      appendLevelBundleDetail(detailEl, di, levelBundle);
    }

    if (prkParsed) {
      showPrkPreview(prkParsed);
    } else if (isRiffWave(data)) {
      showWavPreview(data);
    } else if (isBmp(data)) {
      showBmpPreview(data);
    } else if (isPsxFileName(entry.name)) {
      state.lastPsxPreviewBytes = data;
      try {
        globalThis.__pkrLastPsxBytes = data;
      } catch {
        /* ignore */
      }
      const ok = await showPsxPreview(data);
      if (!ok) {
        const text = tryUtf8Preview(data);
        if (text !== null) {
          setPreviewContent(text);
        } else {
          const visible = formatHex(data);
          const fullHex =
            data.length <= MAX_FULL_HEX_COPY ? formatHex(data, data.length) : visible;
          const hint =
            fullHex !== visible
              ? `${DEFAULT_PREVIEW_HINT} Copy includes the visible sample only for files larger than ${formatBytes(MAX_FULL_HEX_COPY)}.`
              : `${DEFAULT_PREVIEW_HINT} Copy includes the full hex dump for this size. 3D preview unavailable (parse failed or Three.js could not load). Pad diagnostics: open the console (F12) and run dumpPsxCharacterPadDiagnostics(window.__pkrLastPsxBytes).`;
          setPreviewContent(visible, fullHex, hint);
        }
      }
    } else {
      const text = tryUtf8Preview(data);
      if (text !== null) {
        setPreviewContent(text);
      } else {
        const visible = formatHex(data);
        const fullHex =
          data.length <= MAX_FULL_HEX_COPY ? formatHex(data, data.length) : visible;
        const hint =
          fullHex !== visible
            ? `${DEFAULT_PREVIEW_HINT} Copy includes the visible sample only for files larger than ${formatBytes(MAX_FULL_HEX_COPY)}.`
            : `${DEFAULT_PREVIEW_HINT} Copy includes the full hex dump for this size.`;
        setPreviewContent(visible, fullHex, hint);
      }
    }

    inspectorPaneActions.hidden = false;
    btnDownload.onclick = () => {
      void downloadFileEntry(di, fi);
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    detailEl.innerHTML = `<div class="detail-card"><p class="crc-bad">${escapeHtml(msg)}</p></div>`;
    setPreviewIdle("Preview unavailable.");
    inspectorPaneActions.hidden = true;
    setStatus(msg);
  }
}

/**
 * @param {IDBRequest<T>} req
 * @template T
 */
function idbReq(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error ?? new Error("IndexedDB request failed"));
  });
}

/** @param {IDBTransaction} tx */
function idbTxDone(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => rej(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openHistoryDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VER);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const prev = event.oldVersion;
      if (prev > 0 && prev < 2) {
        if (db.objectStoreNames.contains("blobs")) {
          db.deleteObjectStore("blobs");
        }
        if (db.objectStoreNames.contains(HISTORY_META)) {
          db.deleteObjectStore(HISTORY_META);
        }
      }
      if (!db.objectStoreNames.contains(HISTORY_META)) {
        db.createObjectStore(HISTORY_META, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

/** @param {string} name @param {number} byteLength */
function makeHistoryId(name, byteLength) {
  return `${byteLength}::${encodeURIComponent(name)}`;
}

/**
 * @typedef {{ id: string, name: string, byteLength: number, lastOpened: number, handle: FileSystemFileHandle }} HistoryMeta
 */

/** @return {Promise<HistoryMeta[]>} */
async function historyListMetaSorted() {
  const db = await openHistoryDb();
  const tx = db.transaction(HISTORY_META, "readonly");
  const all = await idbReq(tx.objectStore(HISTORY_META).getAll());
  await idbTxDone(tx);
  db.close();
  /** @type {HistoryMeta[]} */
  const metas = [];
  /** @type {string[]} */
  const orphanIds = [];
  for (const row of all) {
    if (row?.handle instanceof FileSystemFileHandle) {
      metas.push(/** @type {HistoryMeta} */ (row));
    } else if (row?.id) {
      orphanIds.push(row.id);
    }
  }
  if (orphanIds.length) {
    void deleteHistoryIds(orphanIds);
  }
  metas.sort((a, b) => b.lastOpened - a.lastOpened);
  return metas;
}

/** @param {string[]} ids */
async function deleteHistoryIds(ids) {
  const db = await openHistoryDb();
  const tx = db.transaction(HISTORY_META, "readwrite");
  const st = tx.objectStore(HISTORY_META);
  for (const id of ids) {
    st.delete(id);
  }
  await idbTxDone(tx);
  db.close();
}

/** @param {string} id */
async function historyGetMeta(id) {
  const db = await openHistoryDb();
  const tx = db.transaction(HISTORY_META, "readonly");
  const row = await idbReq(tx.objectStore(HISTORY_META).get(id));
  db.close();
  return row ?? null;
}

/**
 * Remember a file opened via the File System Access API (handle only — no archive bytes stored).
 * @param {string} name
 * @param {number} byteLength
 * @param {FileSystemFileHandle} handle
 */
async function historyRecordOpen(name, byteLength, handle) {
  const id = makeHistoryId(name, byteLength);
  const now = Date.now();
  const db = await openHistoryDb();
  const tx = db.transaction(HISTORY_META, "readwrite");
  tx.objectStore(HISTORY_META).put({ id, name, byteLength, lastOpened: now, handle });
  await idbTxDone(tx);
  db.close();
  await historyPrune();
  await refreshRecentListUi();
}

async function historyPrune() {
  const db = await openHistoryDb();
  const tx = db.transaction(HISTORY_META, "readonly");
  const all = await idbReq(tx.objectStore(HISTORY_META).getAll());
  await idbTxDone(tx);
  db.close();
  const metas = /** @type {HistoryMeta[]} */ (
    all.filter((r) => r?.handle instanceof FileSystemFileHandle)
  );
  if (metas.length <= HISTORY_MAX_ENTRIES) return;
  metas.sort((a, b) => a.lastOpened - b.lastOpened);
  const toRemove = metas.slice(0, metas.length - HISTORY_MAX_ENTRIES);
  const db2 = await openHistoryDb();
  const txw = db2.transaction(HISTORY_META, "readwrite");
  for (const m of toRemove) {
    txw.objectStore(HISTORY_META).delete(m.id);
  }
  await idbTxDone(txw);
  db2.close();
}

/** @param {string} id */
async function historyDeleteOne(id) {
  const db = await openHistoryDb();
  const tx = db.transaction(HISTORY_META, "readwrite");
  tx.objectStore(HISTORY_META).delete(id);
  await idbTxDone(tx);
  db.close();
  await refreshRecentListUi();
}

async function historyClearAll() {
  const db = await openHistoryDb();
  const tx = db.transaction(HISTORY_META, "readwrite");
  tx.objectStore(HISTORY_META).clear();
  await idbTxDone(tx);
  db.close();
  await refreshRecentListUi();
}

/** @param {HistoryMeta[]} metas */
function renderRecentList(metas) {
  recentList.replaceChildren();
  for (const m of metas) {
    const li = document.createElement("li");
    li.className = "recent-item";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "recent-item__open";
    openBtn.dataset.historyId = m.id;
    openBtn.textContent = m.name;
    openBtn.title = `Open ${m.name} (${formatBytes(m.byteLength)})`;

    const metaSpan = document.createElement("span");
    metaSpan.className = "recent-item__meta";
    metaSpan.textContent = `${formatBytes(m.byteLength)} · ${formatRecentTime(m.lastOpened)}`;

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "recent-item__remove";
    rm.dataset.historyId = m.id;
    rm.setAttribute("aria-label", `Remove ${m.name} from recent`);
    rm.textContent = "\u00d7";

    li.append(openBtn, metaSpan, rm);
    recentList.append(li);
  }
}

async function refreshRecentListUi() {
  let metas = [];
  try {
    metas = await historyListMetaSorted();
  } catch {
    /* private mode, storage blocked */
  }
  renderRecentList(metas);
  recentWrap.classList.toggle("is-hidden", metas.length === 0);
}

/** @param {string} id */
async function openHistoryEntry(id) {
  let meta;
  try {
    meta = await historyGetMeta(id);
  } catch {
    setStatus("Could not read recent archives (browser storage unavailable).");
    return;
  }
  if (!meta?.handle) {
    await historyDeleteOne(id);
    setStatus("That shortcut is no longer valid — open the archive again.");
    return;
  }
  let perm;
  try {
    perm = await meta.handle.queryPermission({ mode: "read" });
  } catch {
    setStatus("Could not access the file — open the archive again.");
    return;
  }
  if (perm !== "granted") {
    try {
      perm = await meta.handle.requestPermission({ mode: "read" });
    } catch {
      /* user denied */
    }
  }
  if (perm !== "granted") {
    setStatus("File access was not granted.");
    return;
  }
  let file;
  try {
    file = await meta.handle.getFile();
  } catch {
    await historyDeleteOne(id);
    setStatus("File could not be read — removed from recent.");
    return;
  }
  await loadFile(file, meta.handle);
}

async function initSessionHistory() {
  try {
    recentAutoRestore.checked = localStorage.getItem(STORAGE_AUTO_RESTORE) !== "0";
  } catch {
    recentAutoRestore.checked = true;
  }

  recentAutoRestore.addEventListener("change", () => {
    try {
      localStorage.setItem(STORAGE_AUTO_RESTORE, recentAutoRestore.checked ? "1" : "0");
    } catch {
      /* ignore */
    }
  });

  recentClear.addEventListener("click", () => {
    if (!confirm("Forget all recent archives (file shortcuts only, no copies stored)?")) return;
    void historyClearAll();
  });

  recentList.addEventListener("click", (e) => {
    const rm = e.target.closest(".recent-item__remove");
    if (rm instanceof HTMLButtonElement) {
      e.preventDefault();
      const hid = rm.dataset.historyId;
      if (hid) void historyDeleteOne(hid);
      return;
    }
    const open = e.target.closest(".recent-item__open");
    if (open instanceof HTMLButtonElement) {
      e.preventDefault();
      const hid = open.dataset.historyId;
      if (hid) void openHistoryEntry(hid);
    }
  });

  await refreshRecentListUi();

  let allowAuto = true;
  try {
    allowAuto = localStorage.getItem(STORAGE_AUTO_RESTORE) !== "0";
  } catch {
    allowAuto = true;
  }
  if (!allowAuto) return;

  let metas = [];
  try {
    metas = await historyListMetaSorted();
  } catch {
    return;
  }
  if (metas.length === 0) return;
  const top = metas[0];
  if (!top.handle) {
    try {
      await historyDeleteOne(top.id);
    } catch {
      /* ignore */
    }
    await refreshRecentListUi();
    return;
  }
  let perm;
  try {
    perm = await top.handle.queryPermission({ mode: "read" });
  } catch {
    return;
  }
  if (perm !== "granted") {
    try {
      perm = await top.handle.requestPermission({ mode: "read" });
    } catch {
      return;
    }
  }
  if (perm !== "granted") return;
  let file;
  try {
    file = await top.handle.getFile();
  } catch {
    try {
      await historyDeleteOne(top.id);
    } catch {
      /* ignore */
    }
    await refreshRecentListUi();
    return;
  }
  setStatus(`Restoring ${top.name}…`);
  await loadFile(file, top.handle);
}

function bindDropZone(el) {
  ["dragenter", "dragover"].forEach((ev) => {
    el.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((ev) => {
    el.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove("dragover");
    });
  });

  el.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    if (!dt?.files.length) return;
    const f = dt.files[0];
    if (f) void loadFile(f);
  });
}

/**
 * @param {ArrayBuffer} buffer
 * @param {string} fileName
 * @param {{ skipHistorySave?: boolean, fileHandle?: FileSystemFileHandle | null }} [options]
 */
async function applyLoadedBuffer(buffer, fileName, options = {}) {
  state.currentFileName = fileName;
  state.currentBuffer = buffer;
  state.currentLoadKind = "archive";
  clearAutoPsxTextureSource();
  state.autoPsxTextureCache.clear();
  updatePsxExternalSourceLabel();
  /** @type {ReturnType<typeof parsePrk> | null} */
  let standalonePrk = null;
  try {
    state.currentArchive = parsePkr(state.currentBuffer);
  } catch (e) {
    if (isPrkFileName(fileName)) {
      state.currentLoadKind = "prk";
      state.currentArchive = createStandalonePrkArchive(fileName, state.currentBuffer.byteLength);
      try {
        standalonePrk = parsePrk(state.currentBuffer);
      } catch {
        standalonePrk = null;
      }
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      state.currentArchive = null;
      state.currentBuffer = null;
      treeEl.replaceChildren();
      revokeAllTileThumbUrls();
      filesBody.replaceChildren();
      filesTiles.replaceChildren();
      state.activeFileTypeSet.clear();
      rebuildFileTypeFilterUi(null);
      detailEl.innerHTML = "";
      setPreviewIdle("");
      inspectorPaneActions.hidden = true;
      summaryFilename.textContent = "";
      summaryFormat.textContent = "";
      summaryStats.textContent = "";
      setViewMode("welcome");
      setStatus(msg);
      return;
    }
  }

  const totalFiles = state.currentArchive.dirs.reduce((n, d) => n + d.files.length, 0);
  summaryFilename.textContent = fileName;
  summaryFilename.title = fileName;
  summaryFormat.textContent = state.currentLoadKind === "prk" ? "PRK" : formatLabel(state.currentArchive);
  summaryStats.textContent =
    state.currentLoadKind === "prk"
      ? standalonePrk
        ? `${nf.format(standalonePrk.width)} × ${nf.format(standalonePrk.height)} cells · ${standalonePrk.header.theme} · ${formatBytes(state.currentBuffer.byteLength)}`
        : formatBytes(state.currentBuffer.byteLength)
      : `${nf.format(state.currentArchive.dirs.length)} folders · ${nf.format(totalFiles)} files · ${formatBytes(state.currentBuffer.byteLength)}`;

  navFolderCount.textContent = `${nf.format(state.currentArchive.dirs.length)}`;

  setViewMode("workspace");
  syncFileViewPanels();
  state.selectedDirIndex = 0;
  state.selectedFileIndex = state.currentLoadKind === "prk" ? 0 : -1;
  renderTree();
  renderFilesTable(0);
  highlightSelection(0, state.selectedFileIndex);
  if (state.currentLoadKind === "prk") {
    void showFileDetail(0, 0);
  } else {
    showDirDetail(0);
    setPreviewIdle("Select a file to preview its contents.");
    inspectorPaneActions.hidden = true;
  }

  const fh = options.fileHandle;
  if (!options.skipHistorySave && fh) {
    void historyRecordOpen(fileName, buffer.byteLength, fh).catch(() => {});
  }

  if (state.currentLoadKind === "archive") {
    setStatus(`Loaded ${fileName}. Preparing decompression…`);
    try {
      await loadFflate();
      setStatus(`Ready — ${fileName}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`Loaded ${fileName}. Zlib helper failed to load: ${msg}`);
    }
  } else {
    setStatus(`Ready — ${fileName}`);
  }

  queueMicrotask(() => {
    tableShell.focus({ preventScroll: true });
  });
}

/**
 * @param {File} file
 * @param {FileSystemFileHandle | null} [fileHandle] Set when opened via File System Access API so reopen works without a second copy in storage.
 */
async function loadFile(file, fileHandle = null) {
  setStatus(`Reading ${file.name}…`);
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(msg);
    return;
  }
  await applyLoadedBuffer(buffer, file.name, { fileHandle: fileHandle ?? undefined });
}

function fileSystemAccessForOpen() {
  return typeof window.showOpenFilePicker === "function";
}

function openArchiveFromWelcome() {
  if (fileSystemAccessForOpen()) {
    void pickAndLoadArchive();
  } else {
    fileInput.click();
  }
}

async function pickAndLoadArchive() {
  try {
    const handles = await window.showOpenFilePicker({
      multiple: false,
      types: [
        {
          description: "PKR archives and PRK parks",
          accept: {
            "application/octet-stream": [".pkr", ".PKR", ".prk", ".PRK"],
          },
        },
      ],
      excludeAcceptAllOption: false,
    });
    const handle = handles[0];
    const file = await handle.getFile();
    await loadFile(file, handle);
  } catch (err) {
    const named = err && typeof err === "object" && "name" in err ? /** @type {{ name?: string }} */ (err) : null;
    if (named?.name === "AbortError") return;
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(msg);
  }
}

/* Help */
helpClose.addEventListener("click", () => helpDialog.close());
helpDialog.addEventListener("click", (e) => {
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.nodeName === "DIALOG") helpDialog.close();
});

previewPopoutBtn.addEventListener("click", togglePreviewPopout);
previewPopoutClose.addEventListener("click", () => previewPopoutDialog.close());
previewPopoutDialog.addEventListener("click", (e) => {
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.nodeName === "DIALOG") previewPopoutDialog.close();
});
previewPopoutDialog.addEventListener("close", () => {
  dockPreviewBlock();
});

welcomeDrop.addEventListener("click", () => {
  openArchiveFromWelcome();
});

welcomeDrop.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  openArchiveFromWelcome();
});

fileInput.addEventListener("change", () => {
  const f = fileInput.files && fileInput.files[0];
  if (f) void loadFile(f, null);
  fileInput.value = "";
});

bindDropZone(welcomeDrop);

workspaceEl.addEventListener("dragenter", (e) => e.preventDefault());
workspaceEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  workspaceEl.classList.add("workspace--drag");
});
["dragleave", "drop"].forEach((ev) => {
  workspaceEl.addEventListener(ev, (e) => {
    e.preventDefault();
    workspaceEl.classList.remove("workspace--drag");
  });
});
workspaceEl.addEventListener("drop", (e) => {
  const dt = e.dataTransfer;
  if (!dt?.files.length) return;
  const f = dt.files[0];
  if (f) void loadFile(f);
});

fileFilter.addEventListener("input", applyFileFilter);

function initFileTypeFilter() {
  fileTypeFilterBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = fileTypeFilterPanel.hidden;
    fileTypeFilterPanel.hidden = !open;
    fileTypeFilterBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  fileTypeFilterPanel.addEventListener("change", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || el.type !== "checkbox") return;
    const row = el.closest("[data-file-type-token]");
    if (!(row instanceof HTMLElement)) return;
    const token = row.dataset.fileTypeToken;
    if (
      token == null ||
      (token !== "all" && token !== "noext" && !token.startsWith("."))
    ) {
      return;
    }

    if (token === "all") {
      if (el.checked) {
        state.activeFileTypeSet.clear();
      } else {
        el.checked = true;
      }
    } else {
      if (el.checked) {
        state.activeFileTypeSet.add(token);
      } else {
        state.activeFileTypeSet.delete(token);
      }
      if (state.activeFileTypeSet.size === 0) {
        state.activeFileTypeSet.clear();
      }
    }
    syncFileTypeFilterPanelCheckboxes();
    syncFileTypeFilterButtonLabel();
    applyFileFilter();
  });

  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t instanceof Node && fileTypeFilterWrap.contains(t)) return;
    if (!fileTypeFilterPanel.hidden) {
      fileTypeFilterPanel.hidden = true;
      fileTypeFilterBtn.setAttribute("aria-expanded", "false");
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !fileTypeFilterPanel.hidden) {
      fileTypeFilterPanel.hidden = true;
      fileTypeFilterBtn.setAttribute("aria-expanded", "false");
    }
  });
}

initFileTypeFilter();

function initWavAudioPlayer() {
  previewAudio.addEventListener("loadedmetadata", () => syncAudioPlayerUi());
  previewAudio.addEventListener("timeupdate", () => {
    if (wavSeekDragging) return;
    syncAudioPlayerUi();
  });
  previewAudio.addEventListener("play", () => syncAudioPlayButton());
  previewAudio.addEventListener("pause", () => syncAudioPlayButton());
  previewAudio.addEventListener("ended", () => syncAudioPlayerUi());

  previewAudioPlay.addEventListener("click", () => {
    if (previewAudio.paused) {
      void previewAudio.play().catch(() => {});
    } else {
      previewAudio.pause();
    }
  });

  previewAudioSeek.addEventListener("pointerdown", () => {
    wavSeekDragging = true;
  });
  previewAudioSeek.addEventListener("pointerup", () => {
    wavSeekDragging = false;
    syncAudioPlayerUi();
  });
  previewAudioSeek.addEventListener("pointercancel", () => {
    wavSeekDragging = false;
    syncAudioPlayerUi();
  });
  previewAudioSeek.addEventListener("input", () => {
    const dur = previewAudio.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const raw = Number(previewAudioSeek.value);
    const t = Math.min(Math.max(raw, 0), dur);
    previewAudio.currentTime = t;
    previewAudioTimeCurrent.textContent = formatWavTime(t);
  });
}

initWavAudioPlayer();

skipCrc.addEventListener("change", () => {
  if (state.currentArchive && state.currentBuffer && state.selectedDirIndex >= 0 && state.selectedFileIndex >= 0) {
    void showFileDetail(state.selectedDirIndex, state.selectedFileIndex);
  }
});

previewVolumeRange.addEventListener("input", () => {
  previewAudio.volume = Number(previewVolumeRange.value);
});

previewCopyBtn.addEventListener("click", async () => {
  const t = state.previewClipboardText;
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
    setStatus("Copied preview text to clipboard.");
  } catch {
    setStatus("Could not copy — allow clipboard access or try again.");
  }
});

viewModeListBtn.addEventListener("click", () => setFileViewMode("list"));
viewModeTilesBtn.addEventListener("click", () => setFileViewMode("tiles"));

function inspectorWidthCap() {
  const pct = Math.floor(window.innerWidth * 0.52);
  return Math.max(INSPECTOR_WIDTH_MIN, Math.min(INSPECTOR_WIDTH_MAX, pct));
}

function applyInspectorColumnWidth(px) {
  const w = Math.max(INSPECTOR_WIDTH_MIN, Math.min(Math.round(px), inspectorWidthCap()));
  workspaceEl.style.gridTemplateColumns = `minmax(200px, 15rem) minmax(0, 1fr) ${w}px`;
  return w;
}

function clearInspectorColumnWidth() {
  workspaceEl.style.removeProperty("grid-template-columns");
}

function isWorkspaceWideLayout() {
  return globalThis.matchMedia(`(min-width: ${INSPECTOR_LAYOUT_MIN_VIEWPORT}px)`).matches;
}

function initInspectorResize() {
  let dragging = false;
  let startX = 0;
  let startW = INSPECTOR_WIDTH_MIN;

  function persistWidth(w) {
    try {
      localStorage.setItem(STORAGE_INSPECTOR_WIDTH, String(w));
    } catch {
      /* ignore */
    }
  }

  function loadStoredWidth() {
    try {
      const s = localStorage.getItem(STORAGE_INSPECTOR_WIDTH);
      if (s == null) return null;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  function applyStoredIfWide() {
    if (!isWorkspaceWideLayout()) {
      clearInspectorColumnWidth();
      return;
    }
    const stored = loadStoredWidth();
    if (stored != null) {
      applyInspectorColumnWidth(stored);
    }
  }

  applyStoredIfWide();

  globalThis.matchMedia(`(min-width: ${INSPECTOR_LAYOUT_MIN_VIEWPORT}px)`).addEventListener("change", (ev) => {
    if (ev.matches) applyStoredIfWide();
    else clearInspectorColumnWidth();
  });

  globalThis.addEventListener("resize", () => {
    if (!isWorkspaceWideLayout()) return;
    if (!workspaceEl.style.gridTemplateColumns) return;
    const el = getInspectorPanel(getDom());
    if (el) applyInspectorColumnWidth(el.getBoundingClientRect().width);
  });

  inspectorResizeHandle.addEventListener("mousedown", (e) => {
    if (!isWorkspaceWideLayout() || e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    const el = getInspectorPanel(getDom());
    startW = el ? el.getBoundingClientRect().width : INSPECTOR_WIDTH_MIN;
    document.body.classList.add("is-col-resize");
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const delta = startX - e.clientX;
    applyInspectorColumnWidth(startW + delta);
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("is-col-resize");
    if (!isWorkspaceWideLayout()) return;
    const el = getInspectorPanel(getDom());
    if (el) persistWidth(applyInspectorColumnWidth(el.getBoundingClientRect().width));
  });

  inspectorResizeHandle.addEventListener("keydown", (e) => {
    if (!isWorkspaceWideLayout()) return;
    const el = getInspectorPanel(getDom());
    if (!el) return;
    const step = e.shiftKey ? 48 : 16;
    const cw = el.getBoundingClientRect().width;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      persistWidth(applyInspectorColumnWidth(cw + step));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      persistWidth(applyInspectorColumnWidth(cw - step));
    }
  });
}

initInspectorResize();

try {
  previewAutoplay.checked = localStorage.getItem(STORAGE_WAV_AUTOPLAY) !== "0";
} catch {
  previewAutoplay.checked = true;
}

try {
  const f = localStorage.getItem(STORAGE_BMP_FIT);
  if (f === "0") {
    state.bmpFitToFrame = false;
    previewBmpFit.checked = false;
  }
} catch {
  /* ignore */
}

previewBmpFit.addEventListener("change", () => {
  state.bmpFitToFrame = previewBmpFit.checked;
  try {
    localStorage.setItem(STORAGE_BMP_FIT, state.bmpFitToFrame ? "1" : "0");
  } catch {
    /* ignore */
  }
  applyBmpPreviewLayout();
});

previewPrkColorMode.addEventListener("change", () => {
  if (!state.prkPreviewState) return;
  state.prkPreviewState.colorMode = previewPrkColorMode.value || "slot3";
  renderPrkGrid();
  renderPrkSelection();
});

previewAutoplay.addEventListener("change", () => {
  try {
    localStorage.setItem(STORAGE_WAV_AUTOPLAY, previewAutoplay.checked ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (!previewAudioWrap.classList.contains("is-hidden")) {
    previewHint.textContent = wavPreviewHintBase();
    if (previewAutoplay.checked && previewAudio.paused) {
      previewAudio.play().catch(() => {
        previewHint.textContent =
          "WAV — autoplay was blocked; press play on the player. (Some browsers require a click on the page first.)";
      });
    }
  }
});

previewPsxDebugMode.addEventListener("change", () => {
  const v = previewPsxDebugMode.value;
  if (state.psxPreviewCtx) state.psxPreviewCtx.applyDebugMode(v);
  try {
    localStorage.setItem(STORAGE_PSX_DEBUG_MODE, v);
  } catch {
    /* ignore */
  }
});

previewPsxTextured.addEventListener("change", () => {
  if (state.psxPreviewCtx) state.psxPreviewCtx.applyDebugMode(previewPsxDebugMode.value);
  try {
    localStorage.setItem(
      STORAGE_PSX_SURFACE_MODE,
      previewPsxTextured.checked ? "textured" : "untextured"
    );
  } catch {
    /* ignore */
  }
  refreshPsxTileThumbsGrid();
});

previewPsxAssemble.addEventListener("change", () => {
  try {
    localStorage.setItem(
      PSX_CHARACTER_ASSEMBLY_STORAGE_KEY,
      previewPsxAssemble.checked ? "1" : "0"
    );
  } catch {
    /* ignore */
  }
  refreshCurrentSelection();
});

previewPsxPadReport.addEventListener("click", () => {
  if (!state.lastPsxPreviewBytes || state.lastPsxPreviewBytes.length === 0) {
    setStatus("No PSX bytes in memory — select a .psx archive entry first.");
    return;
  }
  const report = dumpPsxCharacterPadDiagnostics(state.lastPsxPreviewBytes);
  console.log(report);
  setStatus("Pad report printed to the browser console (F12 → Console).");
});

previewPsxSourceBtn.addEventListener("click", () => {
  previewPsxSourceInput.click();
});

previewPsxExportTextureBtn.addEventListener("click", () => {
  void exportCurrentPsxTextures();
});

previewPsxSourceInput.addEventListener("change", async () => {
  const file = previewPsxSourceInput.files?.[0];
  if (!file) return;
  try {
    setStatus(`Reading external texture source ${file.name}…`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = parsePsxExternalTextureSource(bytes);
    if (!parsed) throw new Error("not a supported PSX texture library");
    state.externalPsxTextureSource = parsed;
    state.externalPsxTextureSourceName = file.name;
    updatePsxExternalSourceLabel();
    setStatus(`Loaded external texture source ${file.name}.`);
    refreshCurrentSelection();
    refreshPsxTileThumbsGrid();
  } catch (err) {
    state.externalPsxTextureSource = null;
    state.externalPsxTextureSourceName = "";
    updatePsxExternalSourceLabel();
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(`External texture source failed: ${msg}`);
    refreshPsxTileThumbsGrid();
  } finally {
    previewPsxSourceInput.value = "";
  }
});

updatePsxExternalSourceLabel();
updatePsxTextureExportState();
updatePreviewPopoutUi();

/** DevTools: `dumpPsxCharacterPadDiagnostics(bytes)` — also `window.__pkrLastPsxBytes` after opening a `.psx` entry. */
globalThis.dumpPsxCharacterPadDiagnostics = dumpPsxCharacterPadDiagnostics;

try {
  const v = localStorage.getItem(STORAGE_FILE_VIEW);
  if (v === "tiles") state.fileViewMode = "tiles";
} catch {
  /* ignore */
}
syncFileViewPanels();

initFileListKeyboardNav();

function initFilesTableSort() {
  const thead = filesBody.closest("table")?.querySelector("thead");
  if (!thead) return;
  thead.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sort-key]");
    if (!btn || !(btn instanceof HTMLButtonElement)) return;
    const raw = btn.dataset.sortKey;
    if (
      raw !== "name" &&
      raw !== "compression" &&
      raw !== "size" &&
      raw !== "archive" &&
      raw !== "offset"
    ) {
      return;
    }
    const key = /** @type {FileSortKey} */ (raw);
    if (state.fileListSort.key === key) {
      state.fileListSort = { key, dir: state.fileListSort.dir === "asc" ? "desc" : "asc" };
    } else {
      state.fileListSort = { key, dir: "asc" };
    }
    if (state.selectedDirIndex >= 0) {
      renderFilesTable(state.selectedDirIndex, { preserveFilter: true });
      highlightSelection(state.selectedDirIndex, state.selectedFileIndex);
    }
  });
  syncFileSortHeaderUi();
}

initFilesTableSort();

void (async () => {
  try {
    await initSessionHistory();
  } catch {
    /* IDB or restore failed — stay on welcome */
  }
  if (!state.currentArchive) {
    setViewMode("welcome");
    setPreviewIdle("");
  }
})();
