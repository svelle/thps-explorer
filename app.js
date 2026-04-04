import {
  parsePkr,
  extractEntry,
  verifyCrc,
  crc32,
  formatLabel,
  COMPRESSED_ZLIB,
  UNCOMPRESSED,
  loadFflate,
  FFLATE_MODULE_URL,
} from "./pkr.js";
import { parsePsxLevelGeometry } from "./psx-model.js";

/** @type {ArrayBuffer | null} */
let currentBuffer = null;
/** @type {ReturnType<typeof parsePkr> | null} */
let currentArchive = null;
/** @type {string} */
let currentFileName = "";
let selectedDirIndex = -1;
let selectedFileIndex = -1;

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

/** Material “save / download” glyph (same path as Google Material Symbols). */
const DOWNLOAD_ICON_PATH_D =
  "M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z";

/**
 * @param {string} [className]
 */
function downloadIconSvg(className) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("viewBox", "0 -960 960 960");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", DOWNLOAD_ICON_PATH_D);
  svg.appendChild(path);
  return svg;
}

/** Folder → ZIP (Material-style “save to archive” glyph). */
const FOLDER_ZIP_ICON_PATH_D =
  "m720-120 160-160-56-56-64 64v-167h-80v167l-64-64-56 56 160 160ZM560 0v-80h320V0H560ZM240-160q-33 0-56.5-23.5T160-240v-560q0-33 23.5-56.5T240-880h280l240 240v121h-80v-81H480v-200H240v560h240v80H240Zm0-80v-560 560Z";

/**
 * @param {string} [className]
 */
function folderZipIconSvg(className) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("viewBox", "0 -960 960 960");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", FOLDER_ZIP_ICON_PATH_D);
  svg.appendChild(path);
  return svg;
}

const fileInput = $("file-input");
const openArchiveLabel = /** @type {HTMLLabelElement | null} */ (fileInput.closest("label"));
const skipCrc = $("skip-crc");
const welcomeEl = $("welcome");
const workspaceEl = $("workspace");
const welcomeDrop = $("welcome-drop");
const archiveSummary = $("archive-summary");
const summaryFilename = $("summary-filename");
const summaryFormat = $("summary-format");
const summaryStats = $("summary-stats");
const navFolderCount = $("nav-folder-count");
const folderTitle = $("folder-title");
const folderSubtitle = $("folder-subtitle");
const fileFilter = $("file-filter");
const fileTypeFilterBtn = $("file-type-filter-btn");
const fileTypeFilterLabel = $("file-type-filter-btn-label");
const fileTypeFilterPanel = $("file-type-filter-panel");
const fileTypeFilterWrap = $("file-type-filter-wrap");
const treeEl = $("tree");
const filesBody = $("files-body");
const filesTiles = $("files-tiles");
const filesListPanel = $("files-list-panel");
const filesTilePanel = $("files-tile-panel");
const tableShell = $("files-table-shell");
const viewModeListBtn = $("view-mode-list");
const viewModeTilesBtn = $("view-mode-tiles");
const inspectorResizeHandle = $("inspector-resize-handle");

function getInspectorPanel() {
  return workspaceEl.querySelector(".workspace__inspector");
}
const detailEl = $("detail");
const previewEl = $("preview");
const previewHint = $("preview-hint");
const previewAudioWrap = $("preview-audio-wrap");
const previewAudio = $("preview-audio");
const previewVolumeRange = $("preview-volume-range");
const previewAutoplay = $("preview-autoplay");
const previewImageWrap = $("preview-image-wrap");
const previewImage = $("preview-image");
const previewImageToolbar = $("preview-image-toolbar");
const previewBmpFit = $("preview-bmp-fit");
const previewCopyBtn = $("preview-copy");
const previewPsxWrap = $("preview-psx-wrap");
const previewPsxCanvas = /** @type {HTMLCanvasElement} */ ($("preview-psx-canvas"));
const previewPsxDebugMode = /** @type {HTMLSelectElement} */ ($("preview-psx-debug-mode"));
const previewPsxTextured = /** @type {HTMLInputElement} */ ($("preview-psx-textured"));

/** @type {string | null} */
let previewAudioObjectUrl = null;
/** @type {string | null} */
let previewImageObjectUrl = null;
/** Text sent to clipboard for text/hex previews (may be full hex for smaller binaries). */
let previewClipboardText = "";

const STORAGE_WAV_AUTOPLAY = "pkr-explorer-wav-autoplay";
const STORAGE_FILE_VIEW = "pkr-explorer-file-view";
const STORAGE_INSPECTOR_WIDTH = "pkr-explorer-inspector-width";
const STORAGE_BMP_FIT = "pkr-explorer-bmp-fit-frame";
const STORAGE_AUTO_RESTORE = "pkr-explorer-auto-restore";
const STORAGE_PSX_DEBUG_MODE = "pkr-explorer-psx-debug-mode";
const STORAGE_PSX_SURFACE_MODE = "pkr-explorer-psx-surface-mode";

const HISTORY_DB_NAME = "pkr-explorer-history";
/** v2: metadata + FileSystemFileHandle only (no full file copies in IndexedDB). */
const HISTORY_DB_VER = 2;
const HISTORY_META = "meta";
const HISTORY_MAX_ENTRIES = 10;

const INSPECTOR_WIDTH_MIN = 220;
const INSPECTOR_WIDTH_MAX = 720;

/** @type {"list" | "tiles"} */
let fileViewMode = "list";

/** @typedef {'name'|'compression'|'size'|'archive'|'offset'} FileSortKey */

/** @type {{ key: FileSortKey, dir: 'asc' | 'desc' }} */
let fileListSort = { key: "name", dir: "asc" };

/**
 * Active file-type filter: empty = all types. Otherwise OR of `noext` and/or extension keys (e.g. `.bmp`).
 * @type {Set<string>}
 */
const activeFileTypeSet = new Set();

/** When true, BMP preview scales to the largest size that fits the preview pane. */
let bmpFitToFrame = true;

function applyBmpPreviewLayout() {
  previewImageWrap.classList.toggle("preview-image-wrap--fit", bmpFitToFrame);
  previewImageWrap.classList.toggle("preview-image-wrap--native", !bmpFitToFrame);
  previewBmpFit.checked = bmpFitToFrame;
}

const DEFAULT_PREVIEW_HINT = "Hex or plain text (first portion of the file).";

/** Cap for generating full hex into clipboard (avoid huge strings). */
const MAX_FULL_HEX_COPY = 512 * 1024;

/** Skip tile thumbnails above this uncompressed size (decompress + decode cost). */
const TILE_BMP_THUMB_MAX_BYTES = 8 * 1024 * 1024;

const THUMB_LOAD_CAP = 5;

/** Blob URLs for BMP tile previews (revoked when the grid is rebuilt). */
const tileThumbObjectUrls = new Set();

/** @type {IntersectionObserver | null} */
let tileThumbObserver = null;

let activeThumbLoads = 0;
/** @type {Array<() => void>} */
const thumbSlotWaiters = [];

const statusEl = $("status");
const fileActions = $("file-actions");
const btnDownload = $("btn-download");
const helpDialog = $("help-dialog");
const btnHelp = $("btn-help");
const welcomeHelp = $("welcome-help");
const helpClose = $("help-close");
const recentWrap = $("recent-wrap");
const recentList = $("recent-list");
const recentAutoRestore = $("recent-auto-restore");
const recentClear = $("recent-clear");

const PREVIEW_HEX_MAX = 256;
const PREVIEW_TEXT_MAX = 8192;

const nf = new Intl.NumberFormat(undefined);

/**
 * @param {number} n
 */
function formatBytes(n) {
  if (n < 1024) return `${nf.format(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Lowercase extension including leading dot, or `""` if none. */
function getFileExtension(filename) {
  const base = filename.replace(/^.*[/\\]/, "");
  const i = base.lastIndexOf(".");
  if (i <= 0 || i === base.length - 1) return "";
  return base.slice(i).toLowerCase();
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
  const { key, dir: dirn } = fileListSort;
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
        ? "File name"
        : sk === "compression"
          ? "Compression"
          : sk === "size"
            ? "Size"
            : sk === "archive"
              ? "In archive"
              : sk === "offset"
                ? "Offset"
                : sk;
    if (fileListSort.key === sk) {
      const asc = fileListSort.dir === "asc";
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
 * @param {Uint8Array} bytes
 * @param {number} maxBytes
 */
function formatHex(bytes, maxBytes = PREVIEW_HEX_MAX) {
  const n = Math.min(bytes.length, maxBytes);
  const lines = [];
  for (let i = 0; i < n; i += 16) {
    const chunk = bytes.subarray(i, i + 16);
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...chunk]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(48, " ")}  ${ascii}`);
  }
  if (bytes.length > n) {
    lines.push(`… ${nf.format(bytes.length - n)} more bytes`);
  }
  return lines.join("\n");
}

/**
 * @param {Uint8Array} bytes
 */
function tryUtf8Preview(bytes) {
  if (bytes.length > PREVIEW_TEXT_MAX) return null;
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if ([...s].some((ch) => {
      const c = ch.codePointAt(0);
      return c !== undefined && (c < 0x20 || c === 0x7f) && c !== 0x09 && c !== 0x0a && c !== 0x0d;
    })) {
      return null;
    }
    return s;
  } catch {
    return null;
  }
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
  if (!currentArchive || !currentBuffer || di < 0 || fi < 0) return;
  const dir = currentArchive.dirs[di];
  const entry = dir.files[fi];
  const skip = skipCrc.checked;
  setStatus(`Downloading ${entry.name}…`);
  try {
    const data = await extractEntry(currentBuffer, entry);
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
  if (!currentArchive || !currentBuffer || di < 0 || di >= currentArchive.dirs.length) return;
  const dir = currentArchive.dirs[di];
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
    await loadFflate();
    const fflate = await import(/* @vite-ignore */ FFLATE_MODULE_URL);
    const zip = fflate.zip;
    if (typeof zip !== "function") {
      throw new Error("fflate zip() not available from module");
    }

    /** @type {Record<string, Uint8Array>} */
    const files = {};
    for (let i = 0; i < dir.files.length; i++) {
      const entry = dir.files[i];
      setStatus(`Zipping ${dir.name}… ${nf.format(i + 1)}/${nf.format(dir.files.length)}`);
      const data = await extractEntry(currentBuffer, entry);
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

function openHelp() {
  if (!helpDialog.open) helpDialog.showModal();
}

function setViewMode(/** @type {'welcome' | 'workspace'} */ mode) {
  const isWelcome = mode === "welcome";
  welcomeEl.classList.toggle("is-hidden", !isWelcome);
  workspaceEl.classList.toggle("is-hidden", isWelcome);
  archiveSummary.classList.toggle("is-hidden", isWelcome || !currentArchive);
}

function syncFileViewPanels() {
  const isList = fileViewMode === "list";
  filesListPanel.classList.toggle("is-hidden", !isList);
  filesTilePanel.classList.toggle("is-hidden", isList);
  viewModeListBtn.classList.toggle("is-active", isList);
  viewModeTilesBtn.classList.toggle("is-active", !isList);
  viewModeListBtn.setAttribute("aria-pressed", isList ? "true" : "false");
  viewModeTilesBtn.setAttribute("aria-pressed", isList ? "false" : "true");
}

function setFileViewMode(/** @type {"list" | "tiles"} */ mode) {
  fileViewMode = mode;
  try {
    localStorage.setItem(STORAGE_FILE_VIEW, mode);
  } catch {
    /* ignore */
  }
  syncFileViewPanels();
  if (currentArchive && selectedDirIndex >= 0) {
    renderFilesTable(selectedDirIndex, { preserveFilter: true });
    highlightSelection(selectedDirIndex, selectedFileIndex);
  }
}

function revokePreviewAudioUrl() {
  if (previewAudioObjectUrl) {
    URL.revokeObjectURL(previewAudioObjectUrl);
    previewAudioObjectUrl = null;
  }
}

function hideAudioPreview() {
  previewAudio.pause();
  previewAudio.removeAttribute("src");
  previewAudio.load();
  revokePreviewAudioUrl();
  previewAudioWrap.classList.add("is-hidden");
}

function revokePreviewImageUrl() {
  if (previewImageObjectUrl) {
    URL.revokeObjectURL(previewImageObjectUrl);
    previewImageObjectUrl = null;
  }
}

function hideImagePreview() {
  revokePreviewImageUrl();
  previewImage.removeAttribute("src");
  previewImage.alt = "";
  previewImageWrap.classList.add("is-hidden");
  previewImageToolbar.classList.add("is-hidden");
}

/**
 * @typedef {import("three").Object3D} ThreeObject3D
 */
/** @type {{
 *   state: { rafId: number },
 *   renderer: import("three").WebGLRenderer,
 *   controls: { dispose: () => void; update: () => void },
 *   geoms: import("three").BufferGeometry[],
 *   scene: import("three").Scene,
 *   mesh: import("three").Mesh,
 *   mats: { shaded: import("three").Material; wire: import("three").Material; normal: import("three").Material },
 *   texMaterials: import("three").Material[] | null,
 *   overlayRef: { vertNormHelper: ThreeObject3D | null; edgesLines: import("three").LineSegments | null },
 *   applyDebugMode: (mode: string) => void,
 *   ro: ResizeObserver,
 * } | null} */
let psxPreviewCtx = null;

function disposePsxPreview() {
  if (psxPreviewCtx) {
    cancelAnimationFrame(psxPreviewCtx.state.rafId);
    psxPreviewCtx.controls.dispose();
    const { overlayRef, scene } = psxPreviewCtx;
    if (overlayRef.vertNormHelper) {
      scene.remove(overlayRef.vertNormHelper);
      const h = overlayRef.vertNormHelper;
      if (typeof h.dispose === "function") h.dispose();
      overlayRef.vertNormHelper = null;
    }
    if (overlayRef.edgesLines) {
      scene.remove(overlayRef.edgesLines);
      overlayRef.edgesLines.geometry.dispose();
      overlayRef.edgesLines.material.dispose();
      overlayRef.edgesLines = null;
    }
    for (const g of psxPreviewCtx.geoms) g.dispose();
    if (psxPreviewCtx.texMaterials) {
      for (const m of psxPreviewCtx.texMaterials) {
        if ("map" in m && m.map) m.map.dispose();
        m.dispose();
      }
    }
    psxPreviewCtx.mats.shaded.dispose();
    psxPreviewCtx.mats.wire.dispose();
    psxPreviewCtx.mats.normal.dispose();
    psxPreviewCtx.renderer.dispose();
    psxPreviewCtx.ro.disconnect();
    psxPreviewCtx = null;
  }
  previewPsxWrap.classList.add("is-hidden");
}

function updateCopyButtonState() {
  previewCopyBtn.disabled = previewClipboardText.length === 0;
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

function revokeAllTileThumbUrls() {
  for (const u of tileThumbObjectUrls) URL.revokeObjectURL(u);
  tileThumbObjectUrls.clear();
}

function ensureTileThumbObserver() {
  if (tileThumbObserver) return tileThumbObserver;
  tileThumbObserver = new IntersectionObserver(
    (entries) => {
      for (const ent of entries) {
        if (!ent.isIntersecting) continue;
        const tile = /** @type {HTMLElement} */ (ent.target);
        if (tile.classList.contains("is-filtered")) continue;
        const img = tile.querySelector("img.file-tile__thumb[data-pending]");
        if (!img) continue;
        tileThumbObserver.unobserve(tile);
        const di = Number(tile.dataset.dirIndex);
        const fi = Number(tile.dataset.fileIndex);
        void withThumbConcurrency(async () => {
          await loadBmpTileThumb(tile, img, di, fi);
        });
      }
    },
    { root: tableShell, rootMargin: "120px", threshold: 0.01 }
  );
  return tileThumbObserver;
}

/**
 * @param {() => Promise<void>} fn
 */
async function withThumbConcurrency(fn) {
  if (activeThumbLoads >= THUMB_LOAD_CAP) {
    await new Promise((resolve) => thumbSlotWaiters.push(resolve));
  }
  activeThumbLoads++;
  try {
    await fn();
  } finally {
    activeThumbLoads--;
    const next = thumbSlotWaiters.shift();
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
  if (!currentBuffer || !currentArchive) return;
  const entry = currentArchive.dirs[di]?.files[fi];
  if (!entry) return;
  try {
    const data = await extractEntry(currentBuffer, entry);
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
    tileThumbObjectUrls.add(url);
    imgEl.src = url;
    imgEl.removeAttribute("data-pending");
  } catch {
    /* leave empty thumb area */
  }
}

/**
 * @param {Uint8Array} data
 */
function showBmpPreview(data) {
  disposePsxPreview();
  hideAudioPreview();
  hideImagePreview();
  previewClipboardText = "";

  previewImageObjectUrl = URL.createObjectURL(new Blob([data], { type: "image/bmp" }));
  previewImage.src = previewImageObjectUrl;
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
  return "WAV — press play to listen. Volume is preview-only.";
}

function showWavPreview(data) {
  disposePsxPreview();
  hideAudioPreview();
  hideImagePreview();
  previewClipboardText = "";
  previewAudioObjectUrl = URL.createObjectURL(new Blob([data], { type: "audio/wav" }));
  previewAudio.src = previewAudioObjectUrl;
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
  updateCopyButtonState();
}

/**
 * @param {Uint8Array} data
 * @returns {Promise<boolean>} true if WebGL preview started
 */
async function showPsxPreview(data) {
  disposePsxPreview();
  hideAudioPreview();
  hideImagePreview();
  previewClipboardText = "";

  const parsed = parsePsxLevelGeometry(data);
  if (!parsed) return false;

  let THREE;
  /** @type {new (cam: import("three").PerspectiveCamera, el: HTMLElement) => { update: () => void; dispose: () => void }} */
  let OrbitControlsCtor;
  /** @type {new (m: import("three").Mesh, n?: number, c?: number) => ThreeObject3D} */
  let VertexNormalsHelperCtor;
  try {
    THREE = await import("https://esm.sh/three@0.161.0");
    const ctrlMod = await import(
      "https://esm.sh/three@0.161.0/examples/jsm/controls/OrbitControls.js"
    );
    OrbitControlsCtor = ctrlMod.OrbitControls;
    const helpMod = await import(
      "https://esm.sh/three@0.161.0/examples/jsm/helpers/VertexNormalsHelper.js"
    );
    VertexNormalsHelperCtor = helpMod.VertexNormalsHelper;
  } catch {
    return false;
  }

  /** @type {import("three").MeshStandardMaterial[] | null} */
  let texMaterials = null;

  const hasTextured =
    parsed.textured &&
    parsed.textured.positions.length >= 9 &&
    parsed.textured.indices.length >= 3;

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

  const plainGeom = buildMeshGeometry(parsed.positions, parsed.indices, null, null);
  /** @type {import("three").BufferGeometry | null} */
  let texturedGeom = null;

  if (hasTextured) {
    const t = parsed.textured;
    texturedGeom = buildMeshGeometry(t.positions, t.indices, t.uvs, t.groups);
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
        // PSX textures are frequently NPOT; default mipmapped filtering can make them incomplete/black.
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
        })
      );
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
  const mats = { shaded: matShaded, wire: matWire, normal: matNormal };
  let texturedSurface = hasTextured;
  try {
    texturedSurface = hasTextured && localStorage.getItem(STORAGE_PSX_SURFACE_MODE) !== "untextured";
  } catch {
    /* ignore */
  }
  previewPsxTextured.checked = texturedSurface;
  previewPsxTextured.disabled = !hasTextured;
  previewPsxTextured.parentElement?.classList.toggle("is-disabled", !hasTextured);

  const activeGeom = () => (texturedSurface && texturedGeom ? texturedGeom : plainGeom);
  const mesh = new THREE.Mesh(activeGeom(), texturedSurface && texMaterials ? texMaterials : matShaded);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12151c);
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
    /** @type {ThreeObject3D | null} */
    vertNormHelper: null,
    /** @type {import("three").LineSegments | null} */
    edgesLines: null,
  };

  function clearPsxDebugOverlays() {
    if (overlayRef.vertNormHelper) {
      scene.remove(overlayRef.vertNormHelper);
      const h = overlayRef.vertNormHelper;
      if (typeof h.dispose === "function") h.dispose();
      overlayRef.vertNormHelper = null;
    }
    if (overlayRef.edgesLines) {
      scene.remove(overlayRef.edgesLines);
      overlayRef.edgesLines.geometry.dispose();
      overlayRef.edgesLines.material.dispose();
      overlayRef.edgesLines = null;
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
    let hint = `PSX mesh — ${nf.format(parsed.modelCount)} model part(s), ${nf.format(vertCount)} vertices, ~${nf.format(triCount)} tris`;
    hint += hintBase;
    hint += hasTextured
      ? texturedSurface
        ? " Textured surface view."
        : " Untextured surface view."
      : "";
    previewHint.textContent = hint;
  }

  function applyDebugMode(mode) {
    clearPsxDebugOverlays();
    texturedSurface = hasTextured && previewPsxTextured.checked;
    mesh.geometry = activeGeom();
    mesh.visible = true;
    syncPsxHint();
    if (texturedSurface && texMaterials && mode === "shaded") {
      mesh.material = texMaterials;
      return;
    }
    switch (mode) {
      case "wireframe":
        mesh.material = mats.wire;
        break;
      case "normals":
        mesh.material = mats.normal;
        break;
      case "vert-norms":
        mesh.material = mats.shaded;
        overlayRef.vertNormHelper = new VertexNormalsHelperCtor(mesh, 0.12, 0x55e0ff);
        scene.add(overlayRef.vertNormHelper);
        break;
      case "edges": {
        mesh.visible = false;
        const eg = new THREE.EdgesGeometry(geom, 32);
        overlayRef.edgesLines = new THREE.LineSegments(
          eg,
          new THREE.LineBasicMaterial({ color: 0x7ae8ff })
        );
        scene.add(overlayRef.edgesLines);
        break;
      }
      default:
        mesh.material = texturedSurface && texMaterials ? texMaterials : mats.shaded;
    }
  }

  const renderer = new THREE.WebGLRenderer({
    canvas: previewPsxCanvas,
    antialias: true,
    alpha: false,
    powerPreference: "low-power",
  });
  const camera = new THREE.PerspectiveCamera(45, 1, 0.03, 50);
  camera.position.set(0.85, 0.65, 1.35);

  const controls = new OrbitControlsCtor(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.update();

  const resize = () => {
    const r = previewPsxWrap.getBoundingClientRect();
    const W = Math.max(180, Math.floor(r.width));
    const H = Math.max(160, Math.min(520, Math.floor(W * 0.62)));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
  };

  previewPsxWrap.classList.remove("is-hidden");
  previewEl.classList.add("is-hidden");
  previewEl.textContent = "";
  previewEl.classList.remove("is-idle");
  previewHint.hidden = false;

  let hint = "";
  hint += hasTextured
    ? ` (embedded 4/8bpp textures + UVs; THPS2X / odd palettes may be incomplete).`
    : ` (no embedded texture bank decoded for this path).`;
  if (parsed.multiPartCharacterPreview && parsed.previewPartIndex !== undefined) {
    hint += ` Showing part index ${nf.format(parsed.previewPartIndex)} only (largest mesh); other parts stay in bone-local space — use .psh indices + skeleton to compose.`;
  }
  hintBase = hint;
  syncPsxHint();

  resize();
  const ro = new ResizeObserver(() => resize());
  ro.observe(previewPsxWrap);

  const state = { rafId: 0 };
  function tick() {
    state.rafId = requestAnimationFrame(tick);
    controls.update();
    const h = overlayRef.vertNormHelper;
    if (h && typeof h.update === "function") h.update();
    renderer.render(scene, camera);
  }
  tick();

  /** @type {string} */
  let initialMode = "shaded";
  try {
    const s = localStorage.getItem(STORAGE_PSX_DEBUG_MODE);
    if (
      s &&
      ["shaded", "wireframe", "normals", "vert-norms", "edges"].includes(s)
    ) {
      initialMode = s;
    }
  } catch {
    /* ignore */
  }
  previewPsxDebugMode.value = initialMode;
  applyDebugMode(initialMode);

  psxPreviewCtx = {
    state,
    renderer,
    controls,
    geoms: texturedGeom ? [plainGeom, texturedGeom] : [plainGeom],
    scene,
    mesh,
    mats,
    texMaterials,
    overlayRef,
    applyDebugMode,
    ro,
  };

  updateCopyButtonState();
  return true;
}

function setPreviewIdle(message) {
  disposePsxPreview();
  hideAudioPreview();
  hideImagePreview();
  previewClipboardText = "";
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
  hideImagePreview();
  previewClipboardText = clipboardText;
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
  if (activeFileTypeSet.size === 0) return true;
  const ext = getFileExtension(fileName);
  if (ext === "") return activeFileTypeSet.has("noext");
  return activeFileTypeSet.has(ext);
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

  for (const t of [...activeFileTypeSet]) {
    if (t === "noext" && noExtCount === 0) activeFileTypeSet.delete(t);
    else if (t !== "noext" && !byExt.has(t)) activeFileTypeSet.delete(t);
  }

  /** @param {string} token @param {string} labelText */
  function addOption(token, labelText) {
    const isAll = token === "all";
    const checked = isAll ? activeFileTypeSet.size === 0 : activeFileTypeSet.has(token);
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
  const n = activeFileTypeSet.size;
  if (n === 0) {
    fileTypeFilterLabel.textContent = "File type";
    fileTypeFilterBtn.classList.remove("has-active-filter");
    fileTypeFilterBtn.title = "Filter files by extension in this folder (check one or more types)";
    return;
  }
  fileTypeFilterBtn.classList.add("has-active-filter");
  const first = [...activeFileTypeSet].sort((a, b) => a.localeCompare(b))[0];
  const firstLabel = first === "noext" ? "no extension" : first;
  if (n === 1) {
    fileTypeFilterLabel.textContent = `Type: ${firstLabel}`;
    fileTypeFilterBtn.title = `Showing only ${firstLabel} — open to add or remove types`;
    return;
  }
  fileTypeFilterLabel.textContent = `Types: ${n}`;
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
    const checked = isAll ? activeFileTypeSet.size === 0 : activeFileTypeSet.has(token);
    cb.checked = checked;
    node.classList.toggle("is-active", checked);
  });
}

/** Visible rows or tiles in DOM order (respects name + type filters). */
function getVisibleFileElements() {
  if (fileViewMode === "list") {
    return Array.from(filesBody.querySelectorAll("tr:not(.is-filtered)"));
  }
  return Array.from(filesTiles.querySelectorAll(".file-tile:not(.is-filtered)"));
}

function scrollFileSelectionIntoView() {
  if (fileViewMode === "list") {
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
  if (!currentArchive || di < 0 || fi < 0) return;
  selectedDirIndex = di;
  selectedFileIndex = fi;
  highlightSelection(di, fi);
  void showFileDetail(di, fi);
  scrollFileSelectionIntoView();
  tableShell.focus({ preventScroll: true });
}

/**
 * @param {number} delta — 1 = next, -1 = previous
 */
function moveFileSelection(delta) {
  if (!currentArchive || selectedDirIndex < 0) return;
  const els = getVisibleFileElements();
  if (els.length === 0) return;
  let idx = els.findIndex(
    (el) =>
      Number(el.dataset.dirIndex) === selectedDirIndex &&
      Number(el.dataset.fileIndex) === selectedFileIndex
  );
  if (idx < 0) {
    idx = delta > 0 ? 0 : els.length - 1;
  } else {
    idx = Math.max(0, Math.min(els.length - 1, idx + delta));
  }
  const el = els[idx];
  selectFileEntry(Number(el.dataset.dirIndex), Number(el.dataset.fileIndex));
}

/** @param {boolean} toEnd */
function goFileEdge(toEnd) {
  if (!currentArchive || selectedDirIndex < 0) return;
  const els = getVisibleFileElements();
  if (els.length === 0) return;
  const el = toEnd ? els[els.length - 1] : els[0];
  selectFileEntry(Number(el.dataset.dirIndex), Number(el.dataset.fileIndex));
}

function initFileListKeyboardNav() {
  tableShell.addEventListener("keydown", (e) => {
    if (workspaceEl.classList.contains("is-hidden") || !currentArchive) return;
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const k = e.key;
    if (k === "ArrowDown" || k === "ArrowUp" || k === "Home" || k === "End" || k === "Enter") {
      const visible = getVisibleFileElements();
      if (visible.length === 0) return;
      if (k === "Enter") {
        if (selectedFileIndex >= 0) return;
        e.preventDefault();
        goFileEdge(false);
        return;
      }
      e.preventDefault();
      if (k === "ArrowDown") moveFileSelection(1);
      else if (k === "ArrowUp") moveFileSelection(-1);
      else if (k === "Home") goFileEdge(false);
      else goFileEdge(true);
    }
  });
}

function renderTree() {
  treeEl.replaceChildren();
  if (!currentArchive) return;

  const rootUl = document.createElement("ul");
  currentArchive.dirs.forEach((dir, di) => {
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
      selectedDirIndex = di;
      selectedFileIndex = -1;
      highlightSelection(di, -1);
      fileFilter.value = "";
      renderFilesTable(di);
      showDirDetail(di);
      setPreviewIdle("Select a file to preview its contents.");
      fileActions.hidden = true;
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
    activeFileTypeSet.clear();
  }
  if (!currentArchive || di < 0 || di >= currentArchive.dirs.length) {
    activeFileTypeSet.clear();
    rebuildFileTypeFilterUi(null);
    return;
  }

  const dir = currentArchive.dirs[di];
  const ordered = getSortedFileDisplayOrder(dir);

  ordered.forEach(({ entry, originalIndex: fi }) => {
    const { label, pillClass, title } = compressionUi(entry);
    const inArchive = inArchiveBytes(entry);

    const onSelect = () => {
      selectFileEntry(di, fi);
    };

    if (fileViewMode === "list") {
      const tr = document.createElement("tr");
      tr.dataset.dirIndex = String(di);
      tr.dataset.fileIndex = String(fi);
      tr.dataset.fileName = entry.name;

      const nameTd = document.createElement("td");
      nameTd.textContent = entry.name;

      const compTd = document.createElement("td");
      const pill = document.createElement("span");
      pill.className = pillClass;
      pill.textContent = label;
      pill.title = title;
      compTd.append(pill);

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
      offTd.textContent = `0x${entry.offset.toString(16)}`;

      const dlTd = document.createElement("td");
      dlTd.className = "files-table__dl col-num";
      dlTd.append(makeInlineDownloadButton(di, fi, entry.name));

      tr.append(nameTd, compTd, szTd, arcTd, offTd, dlTd);
      tr.addEventListener("click", onSelect);
      filesBody.append(tr);
    } else {
      const tile = document.createElement("div");
      tile.className = "file-tile";
      tile.dataset.dirIndex = String(di);
      tile.dataset.fileIndex = String(fi);
      tile.dataset.fileName = entry.name;

      const nameEl = document.createElement("span");
      nameEl.className = "file-tile__name";
      nameEl.textContent = entry.name;

      const meta = document.createElement("span");
      meta.className = "file-tile__meta";
      const pill = document.createElement("span");
      pill.className = pillClass;
      pill.textContent = label;
      pill.title = title;
      meta.append(pill, document.createTextNode(` · ${formatBytes(entry.uncompressed_size)}`));

      const stack = document.createElement("div");
      stack.className = "file-tile__stack";
      stack.append(nameEl, meta);

      const dlBtn = makeInlineDownloadButton(di, fi, entry.name);

      const useBmpThumb =
        isBmpFileName(entry.name) && entry.uncompressed_size <= TILE_BMP_THUMB_MAX_BYTES;
      if (useBmpThumb) {
        tile.classList.add("file-tile--with-thumb");
        const thumbWrap = document.createElement("span");
        thumbWrap.className = "file-tile__thumb-wrap";
        const thumbImg = document.createElement("img");
        thumbImg.className = "file-tile__thumb";
        thumbImg.alt = "";
        thumbImg.dataset.pending = "1";
        thumbWrap.append(thumbImg);
        const body = document.createElement("div");
        body.className = "file-tile__body";
        body.append(stack, dlBtn);
        tile.append(thumbWrap, body);
        wireFileTileInteractions(tile, onSelect);
        filesTiles.append(tile);
        ensureTileThumbObserver().observe(tile);
      } else {
        tile.append(stack, dlBtn);
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
  if (!currentArchive || di < 0) return;
  const dir = currentArchive.dirs[di];
  folderTitle.textContent = dir.name || "(unnamed folder)";
  folderSubtitle.textContent = `${nf.format(dir.files.length)} files · click or ↑↓ to move`;

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
  if (!currentArchive || !currentBuffer || di < 0 || fi < 0) return;
  const dir = currentArchive.dirs[di];
  const entry = dir.files[fi];
  folderTitle.textContent = dir.name || "(unnamed folder)";
  folderSubtitle.textContent = entry.name;

  detailEl.innerHTML = `<p class="detail-loading">Reading file…</p>`;
  setPreviewIdle("Loading preview…");
  fileActions.hidden = true;

  try {
    const skip = skipCrc.checked;
    const data = await extractEntry(currentBuffer, entry);
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

    const prkNote = isPrkFileName(entry.name)
      ? `<dt>Park / level</dt><dd class="detail-prk-note">Skate park (<code>.prk</code>): custom-level binary from Neversoft TH-era games — <strong>not</strong> a nested PKR. This explorer only shows raw bytes; for a structural dump use community tools such as <code>disassemble-prk.py</code> in <a href="https://github.com/JayFoxRox/thps2-tools" target="_blank" rel="noopener noreferrer">thps2-tools</a>.</dd>`
      : "";

    const psxNote = isPsxFileName(entry.name)
      ? `<dt>Mesh</dt><dd class="detail-prk-note"><code>.psx</code> — Neversoft “Big Guns” engine 3D mesh / level geometry (THPS and related titles). Character rigs list many models in one file (one mesh per skeleton part, indexed like the companion <code>.psh</code>); the preview picks the largest single part. Full pose needs bone transforms. Format notes: <a href="https://gist.github.com/iamgreaser/b54531e41d77b69d7d13391deb0ac6a5" target="_blank" rel="noopener noreferrer">iamgreaser gist</a>.</dd>`
      : "";

    const pshNote = isPshFileName(entry.name)
      ? `<dt>Parts</dt><dd class="detail-prk-note"><code>.psh</code> — C header listing skeleton part IDs (and parent names in comments) for a paired <code>.psx</code>. It does not contain geometry or transforms.</dd>`
      : "";

    detailEl.innerHTML = `
      <div class="detail-card">
        <dl class="meta-grid">
          <dt>Path</dt><dd><strong>${escapeHtml(dir.name)}/${escapeHtml(entry.name)}</strong></dd>
          <dt>Compression</dt><dd title="${escapeHtml(title)}">${escapeHtml(label)}</dd>
          <dt>Uncompressed</dt><dd>${formatBytes(entry.uncompressed_size)} <span class="mono-soft">(${nf.format(entry.uncompressed_size)} B)</span></dd>
          <dt>Offset</dt><dd class="mono-soft">0x${entry.offset.toString(16)}</dd>
          <dt>Checksum</dt><dd>${crcHtml}</dd>
          ${prkNote}
          ${psxNote}
          ${pshNote}
        </dl>
      </div>`;

    if (isRiffWave(data)) {
      showWavPreview(data);
    } else if (isBmp(data)) {
      showBmpPreview(data);
    } else if (isPsxFileName(entry.name)) {
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
              : `${DEFAULT_PREVIEW_HINT} Copy includes the full hex dump for this size. 3D preview unavailable (parse failed or Three.js could not load).`;
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

    fileActions.hidden = false;
    btnDownload.onclick = () => {
      void downloadFileEntry(di, fi);
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    detailEl.innerHTML = `<div class="detail-card"><p class="crc-bad">${escapeHtml(msg)}</p></div>`;
    setPreviewIdle("Preview unavailable.");
    fileActions.hidden = true;
    setStatus(msg);
  }
}

/**
 * @param {string} s
 */
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

/** @param {number} ts */
function formatRecentTime(ts) {
  const d = Date.now() - ts;
  if (d < 45_000) return "just now";
  if (d < 3600_000) return `${Math.max(1, Math.floor(d / 60_000))} min ago`;
  if (d < 86_400_000) return `${Math.max(1, Math.floor(d / 3600_000))} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
  currentFileName = fileName;
  currentBuffer = buffer;
  try {
    currentArchive = parsePkr(currentBuffer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    currentArchive = null;
    currentBuffer = null;
    treeEl.replaceChildren();
    revokeAllTileThumbUrls();
    filesBody.replaceChildren();
    filesTiles.replaceChildren();
    activeFileTypeSet.clear();
    rebuildFileTypeFilterUi(null);
    detailEl.innerHTML = "";
    setPreviewIdle("");
    fileActions.hidden = true;
    summaryFilename.textContent = "";
    summaryFormat.textContent = "";
    summaryStats.textContent = "";
    setViewMode("welcome");
    setStatus(msg);
    return;
  }

  const totalFiles = currentArchive.dirs.reduce((n, d) => n + d.files.length, 0);
  summaryFilename.textContent = fileName;
  summaryFilename.title = fileName;
  summaryFormat.textContent = formatLabel(currentArchive);
  summaryStats.textContent = `${nf.format(currentArchive.dirs.length)} folders · ${nf.format(totalFiles)} files · ${formatBytes(currentBuffer.byteLength)}`;

  navFolderCount.textContent = `${nf.format(currentArchive.dirs.length)}`;

  setViewMode("workspace");
  syncFileViewPanels();
  selectedDirIndex = 0;
  selectedFileIndex = -1;
  renderTree();
  renderFilesTable(0);
  highlightSelection(0, -1);
  showDirDetail(0);
  setPreviewIdle("Select a file to preview its contents.");
  fileActions.hidden = true;

  const fh = options.fileHandle;
  if (!options.skipHistorySave && fh) {
    void historyRecordOpen(fileName, buffer.byteLength, fh).catch(() => {});
  }

  setStatus(`Loaded ${fileName}. Preparing decompression…`);
  try {
    await loadFflate();
    setStatus(`Ready — ${fileName}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`Loaded ${fileName}. Zlib may not work until the network can reach the helper: ${msg}`);
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

async function pickAndLoadArchive() {
  try {
    const handles = await window.showOpenFilePicker({
      multiple: false,
      types: [
        {
          description: "PKR archives",
          accept: {
            "application/octet-stream": [".pkr", ".PKR"],
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
btnHelp.addEventListener("click", openHelp);
welcomeHelp.addEventListener("click", openHelp);
helpClose.addEventListener("click", () => helpDialog.close());
helpDialog.addEventListener("click", (e) => {
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.nodeName === "DIALOG") helpDialog.close();
});

openArchiveLabel?.addEventListener("click", (e) => {
  if (!fileSystemAccessForOpen()) return;
  e.preventDefault();
  void pickAndLoadArchive();
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
        activeFileTypeSet.clear();
      } else {
        el.checked = true;
      }
    } else {
      if (el.checked) {
        activeFileTypeSet.add(token);
      } else {
        activeFileTypeSet.delete(token);
      }
      if (activeFileTypeSet.size === 0) {
        activeFileTypeSet.clear();
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

skipCrc.addEventListener("change", () => {
  if (currentArchive && currentBuffer && selectedDirIndex >= 0 && selectedFileIndex >= 0) {
    void showFileDetail(selectedDirIndex, selectedFileIndex);
  }
});

previewVolumeRange.addEventListener("input", () => {
  previewAudio.volume = Number(previewVolumeRange.value);
});

previewCopyBtn.addEventListener("click", async () => {
  const t = previewClipboardText;
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
  return Math.min(INSPECTOR_WIDTH_MAX, Math.floor(window.innerWidth * 0.52));
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
  return globalThis.matchMedia("(min-width: 1025px)").matches;
}

function initInspectorResize() {
  let dragging = false;
  let startX = 0;
  let startW = 304;

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

  globalThis.matchMedia("(min-width: 1025px)").addEventListener("change", (ev) => {
    if (ev.matches) applyStoredIfWide();
    else clearInspectorColumnWidth();
  });

  globalThis.addEventListener("resize", () => {
    if (!isWorkspaceWideLayout()) return;
    if (!workspaceEl.style.gridTemplateColumns) return;
    const el = getInspectorPanel();
    if (el) applyInspectorColumnWidth(el.getBoundingClientRect().width);
  });

  inspectorResizeHandle.addEventListener("mousedown", (e) => {
    if (!isWorkspaceWideLayout() || e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    const el = getInspectorPanel();
    startW = el ? el.getBoundingClientRect().width : 304;
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
    const el = getInspectorPanel();
    if (el) persistWidth(applyInspectorColumnWidth(el.getBoundingClientRect().width));
  });

  inspectorResizeHandle.addEventListener("keydown", (e) => {
    if (!isWorkspaceWideLayout()) return;
    const el = getInspectorPanel();
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
  if (localStorage.getItem(STORAGE_WAV_AUTOPLAY) === "1") {
    previewAutoplay.checked = true;
  }
} catch {
  /* ignore */
}

try {
  const f = localStorage.getItem(STORAGE_BMP_FIT);
  if (f === "0") {
    bmpFitToFrame = false;
    previewBmpFit.checked = false;
  }
} catch {
  /* ignore */
}

previewBmpFit.addEventListener("change", () => {
  bmpFitToFrame = previewBmpFit.checked;
  try {
    localStorage.setItem(STORAGE_BMP_FIT, bmpFitToFrame ? "1" : "0");
  } catch {
    /* ignore */
  }
  applyBmpPreviewLayout();
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
  if (psxPreviewCtx) psxPreviewCtx.applyDebugMode(v);
  try {
    localStorage.setItem(STORAGE_PSX_DEBUG_MODE, v);
  } catch {
    /* ignore */
  }
});

previewPsxTextured.addEventListener("change", () => {
  if (psxPreviewCtx) psxPreviewCtx.applyDebugMode(previewPsxDebugMode.value);
  try {
    localStorage.setItem(
      STORAGE_PSX_SURFACE_MODE,
      previewPsxTextured.checked ? "textured" : "untextured"
    );
  } catch {
    /* ignore */
  }
});

try {
  const v = localStorage.getItem(STORAGE_FILE_VIEW);
  if (v === "tiles") fileViewMode = "tiles";
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
    if (fileListSort.key === key) {
      fileListSort = { key, dir: fileListSort.dir === "asc" ? "desc" : "asc" };
    } else {
      fileListSort = { key, dir: "asc" };
    }
    if (selectedDirIndex >= 0) {
      renderFilesTable(selectedDirIndex, { preserveFilter: true });
      highlightSelection(selectedDirIndex, selectedFileIndex);
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
  if (!currentArchive) {
    setViewMode("welcome");
    setPreviewIdle("");
  }
})();
