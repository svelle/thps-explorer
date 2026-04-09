import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corePath = path.join(__dirname, "..", "src", "app", "app-core.js");
let s = fs.readFileSync(corePath, "utf8");
s = s.replace(/\r\n/g, "\n");

s = s.replaceAll('from "./pkr.js"', 'from "../../pkr.js"');
s = s.replaceAll('from "./prk.js"', 'from "../../prk.js"');
s = s.replaceAll('from "./psx-model.js"', 'from "../../psx-model.js"');
s = s.replaceAll('from "./psx-textures.js"', 'from "../../psx-textures.js"');

const startMark = "/** @type {ArrayBuffer | null} */\nlet currentBuffer = null;";
const endMark = "const nf = new Intl.NumberFormat(undefined);\n\n";
const k0 = s.indexOf(startMark);
const k1 = s.indexOf(endMark);
if (k0 === -1 || k1 === -1 || k1 <= k0) {
  throw new Error(`markers not found or wrong order: start=${k0} end=${k1}`);
}

const inject = `import { initDomRefs, getDom } from "./dom.js";
import { state } from "./state.js";
import {
  STORAGE_WAV_AUTOPLAY,
  STORAGE_FILE_VIEW,
  STORAGE_INSPECTOR_WIDTH,
  STORAGE_BMP_FIT,
  STORAGE_AUTO_RESTORE,
  STORAGE_PSX_DEBUG_MODE,
  STORAGE_PSX_SURFACE_MODE,
  STORAGE_INSPECTOR_TAB,
  HISTORY_DB_NAME,
  HISTORY_DB_VER,
  HISTORY_META,
  HISTORY_MAX_ENTRIES,
  INSPECTOR_WIDTH_MIN,
  INSPECTOR_WIDTH_MAX,
  DEFAULT_PREVIEW_HINT,
  MAX_FULL_HEX_COPY,
  TILE_BMP_THUMB_MAX_BYTES,
  TILE_PSX_THUMB_MAX_BYTES,
  PSX_TILE_THUMB_PX,
  THUMB_LOAD_CAP,
  PREVIEW_HEX_MAX,
  PREVIEW_TEXT_MAX,
} from "./storage-keys.js";

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
  tabInspectorPreview,
  tabInspectorDetails,
  panelInspectorPreview,
  panelInspectorDetails,
  previewPsxStatsHud,
  previewPsxToolbarEl,
  previewBlock,
  previewHomeAnchor,
  previewEl,
  previewHint,
  previewAudioWrap,
  previewAudio,
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
  previewPsxDebugMode,
  previewPsxTextured,
  previewPsxAssemble,
  previewPsxPadReport,
  previewPsxSourceBtn,
  previewPsxExportTextureBtn,
  previewPsxSourceInput,
  previewPsxSourceName,
  statusEl,
  btnDownload,
  helpDialog,
  previewPopoutDialog,
  previewPopoutSlot,
  previewPopoutClose,
  navDocs,
  welcomeHelp,
  helpClose,
  recentWrap,
  recentList,
  recentAutoRestore,
  recentClear,
} = getDom();

`;

s = s.slice(0, k0) + inject + s.slice(k1 + endMark.length);

const repl = [
  [/\bexternalPsxTextureSourceName\b/g, "state.externalPsxTextureSourceName"],
  [/\bexternalPsxTextureSource\b/g, "state.externalPsxTextureSource"],
  [/\bautoPsxTextureSourceName\b/g, "state.autoPsxTextureSourceName"],
  [/\bautoPsxTextureSource\b/g, "state.autoPsxTextureSource"],
  [/\bcurrentPsxExportTextures\b/g, "state.currentPsxExportTextures"],
  [/\bautoPsxTextureCache\b/g, "state.autoPsxTextureCache"],
  [/\bpreviewClipboardText\b/g, "state.previewClipboardText"],
  [/\bprkPreviewState\b/g, "state.prkPreviewState"],
  [/\bpreviewAudioObjectUrl\b/g, "state.previewAudioObjectUrl"],
  [/\bpreviewImageObjectUrl\b/g, "state.previewImageObjectUrl"],
  [/\blastPsxPreviewBytes\b/g, "state.lastPsxPreviewBytes"],
  [/\bpreviewIsPoppedOut\b/g, "state.previewIsPoppedOut"],
  [/\bpsxPreviewCtx\b/g, "state.psxPreviewCtx"],
  [/\bthumbSlotWaiters\b/g, "state.thumbSlotWaiters"],
  [/\bactiveThumbLoads\b/g, "state.activeThumbLoads"],
  [/\btileThumbObserver\b/g, "state.tileThumbObserver"],
  [/\btileThumbObjectUrls\b/g, "state.tileThumbObjectUrls"],
  [/\bthreeThumbImportPromise\b/g, "state.threeThumbImportPromise"],
  [/\bbmpFitToFrame\b/g, "state.bmpFitToFrame"],
  [/\bactiveFileTypeSet\b/g, "state.activeFileTypeSet"],
  [/\bfileListSort\b/g, "state.fileListSort"],
  [/\bfileViewMode\b/g, "state.fileViewMode"],
  [/\bselectedFileIndex\b/g, "state.selectedFileIndex"],
  [/\bselectedDirIndex\b/g, "state.selectedDirIndex"],
  [/\bcurrentLoadKind\b/g, "state.currentLoadKind"],
  [/\bcurrentFileName\b/g, "state.currentFileName"],
  [/\bcurrentArchive\b/g, "state.currentArchive"],
  [/\bcurrentBuffer\b/g, "state.currentBuffer"],
];

for (const [re, to] of repl) {
  s = s.replace(re, to);
}

fs.writeFileSync(corePath, s);
console.log("OK", corePath);
