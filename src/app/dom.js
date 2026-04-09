/**
 * @param {string} id
 */
export function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

/**
 * @typedef {object} DomRefs
 * @property {HTMLInputElement} fileInput
 * @property {HTMLInputElement} skipCrc
 * @property {HTMLElement} welcomeEl
 * @property {HTMLElement} workspaceEl
 * @property {HTMLElement} welcomeDrop
 * @property {HTMLElement} archiveSummary
 * @property {HTMLElement} summaryFilename
 * @property {HTMLElement} summaryFormat
 * @property {HTMLElement} summaryStats
 * @property {HTMLElement} navFolderCount
 * @property {HTMLElement} folderTitle
 * @property {HTMLElement} folderSubtitle
 * @property {HTMLInputElement} fileFilter
 * @property {HTMLButtonElement} fileTypeFilterBtn
 * @property {HTMLElement} fileTypeFilterLabel
 * @property {HTMLElement} fileTypeFilterPanel
 * @property {HTMLElement} fileTypeFilterWrap
 * @property {HTMLElement} treeEl
 * @property {HTMLTableSectionElement} filesBody
 * @property {HTMLElement} filesTiles
 * @property {HTMLElement} filesListPanel
 * @property {HTMLElement} filesTilePanel
 * @property {HTMLElement} tableShell
 * @property {HTMLButtonElement} viewModeListBtn
 * @property {HTMLButtonElement} viewModeTilesBtn
 * @property {HTMLElement} inspectorResizeHandle
 * @property {HTMLElement} detailEl
 * @property {HTMLHeadingElement} inspectorFileTitle
 * @property {HTMLSpanElement} inspectorFileKind
 * @property {HTMLDivElement} inspectorPaneActions
 * @property {HTMLDivElement} previewPsxStatsHud
 * @property {HTMLDivElement} previewPsxToolbarEl
 * @property {HTMLElement} previewBlock
 * @property {HTMLElement} previewHomeAnchor
 * @property {HTMLElement} previewEl
 * @property {HTMLElement} previewHint
 * @property {HTMLElement} previewAudioWrap
 * @property {HTMLAudioElement} previewAudio
 * @property {HTMLButtonElement} previewAudioPlay
 * @property {HTMLInputElement} previewAudioSeek
 * @property {HTMLElement} previewAudioTimeCurrent
 * @property {HTMLElement} previewAudioTimeDuration
 * @property {HTMLElement} previewAudioPlayIcon
 * @property {HTMLInputElement} previewVolumeRange
 * @property {HTMLInputElement} previewAutoplay
 * @property {HTMLElement} previewPrkWrap
 * @property {HTMLSelectElement} previewPrkColorMode
 * @property {HTMLElement} previewPrkSummary
 * @property {HTMLElement} previewPrkGrid
 * @property {HTMLElement} previewPrkSelection
 * @property {HTMLElement} previewPrkGaps
 * @property {HTMLElement} previewImageWrap
 * @property {HTMLImageElement} previewImage
 * @property {HTMLElement} previewImageToolbar
 * @property {HTMLInputElement} previewBmpFit
 * @property {HTMLButtonElement} previewPopoutBtn
 * @property {HTMLElement} previewPopoutLabel
 * @property {HTMLButtonElement} previewCopyBtn
 * @property {HTMLElement} previewPsxWrap
 * @property {HTMLCanvasElement} previewPsxCanvas
 * @property {HTMLCanvasElement} previewPsxUvCanvas
 * @property {HTMLDivElement} previewPsxCanvasStack
 * @property {HTMLButtonElement} previewPsxViewMode3d
 * @property {HTMLButtonElement} previewPsxViewModeUv
 * @property {HTMLSelectElement} previewPsxDebugMode
 * @property {HTMLInputElement} previewPsxTextured
 * @property {HTMLInputElement} previewPsxAssemble
 * @property {HTMLButtonElement} previewPsxPadReport
 * @property {HTMLButtonElement} previewPsxSourceBtn
 * @property {HTMLButtonElement} previewPsxExportTextureBtn
 * @property {HTMLInputElement} previewPsxSourceInput
 * @property {HTMLElement} previewPsxSourceName
 * @property {HTMLElement} previewPsxPartsAside
 * @property {HTMLButtonElement} previewPsxPartsToggle
 * @property {HTMLDivElement} previewPsxPartList
 * @property {HTMLElement} previewPsxAnimRow
 * @property {HTMLSelectElement} previewPsxAnimMode
 * @property {HTMLButtonElement} previewPsxAnimPlay
 * @property {HTMLInputElement} previewPsxAnimFrame
 * @property {HTMLElement} previewPsxAnimStatus
 * @property {HTMLElement} statusEl
 * @property {HTMLButtonElement} btnDownload
 * @property {HTMLDialogElement} helpDialog
 * @property {HTMLDialogElement} previewPopoutDialog
 * @property {HTMLElement} previewPopoutSlot
 * @property {HTMLButtonElement} previewPopoutClose
 * @property {HTMLButtonElement} helpClose
 * @property {HTMLElement} recentWrap
 * @property {HTMLUListElement} recentList
 * @property {HTMLInputElement} recentAutoRestore
 * @property {HTMLButtonElement} recentClear
 */

/** @type {DomRefs | null} */
let domRef = null;

/** @returns {DomRefs} */
export function initDomRefs() {
  domRef = {
    fileInput: /** @type {HTMLInputElement} */ ($("file-input")),
    skipCrc: /** @type {HTMLInputElement} */ ($("skip-crc")),
    welcomeEl: $("welcome"),
    workspaceEl: $("workspace"),
    welcomeDrop: $("welcome-drop"),
    archiveSummary: $("archive-summary"),
    summaryFilename: $("summary-filename"),
    summaryFormat: $("summary-format"),
    summaryStats: $("summary-stats"),
    navFolderCount: $("nav-folder-count"),
    folderTitle: $("folder-title"),
    folderSubtitle: $("folder-subtitle"),
    fileFilter: /** @type {HTMLInputElement} */ ($("file-filter")),
    fileTypeFilterBtn: /** @type {HTMLButtonElement} */ ($("file-type-filter-btn")),
    fileTypeFilterLabel: $("file-type-filter-btn-label"),
    fileTypeFilterPanel: $("file-type-filter-panel"),
    fileTypeFilterWrap: $("file-type-filter-wrap"),
    treeEl: $("tree"),
    filesBody: /** @type {HTMLTableSectionElement} */ ($("files-body")),
    filesTiles: $("files-tiles"),
    filesListPanel: $("files-list-panel"),
    filesTilePanel: $("files-tile-panel"),
    tableShell: $("files-table-shell"),
    viewModeListBtn: /** @type {HTMLButtonElement} */ ($("view-mode-list")),
    viewModeTilesBtn: /** @type {HTMLButtonElement} */ ($("view-mode-tiles")),
    inspectorResizeHandle: $("inspector-resize-handle"),
    detailEl: $("detail"),
    inspectorFileTitle: /** @type {HTMLHeadingElement} */ ($("inspector-file-title")),
    inspectorFileKind: /** @type {HTMLSpanElement} */ ($("inspector-file-kind")),
    inspectorPaneActions: /** @type {HTMLDivElement} */ ($("inspector-pane-actions")),
    previewPsxStatsHud: /** @type {HTMLDivElement} */ ($("preview-psx-stats-hud")),
    previewPsxToolbarEl: /** @type {HTMLDivElement} */ ($("preview-psx-toolbar")),
    previewBlock: $("preview-block"),
    previewHomeAnchor: $("preview-home-anchor"),
    previewEl: $("preview"),
    previewHint: $("preview-hint"),
    previewAudioWrap: $("preview-audio-wrap"),
    previewAudio: /** @type {HTMLAudioElement} */ ($("preview-audio")),
    previewAudioPlay: /** @type {HTMLButtonElement} */ ($("preview-audio-play")),
    previewAudioSeek: /** @type {HTMLInputElement} */ ($("preview-audio-seek")),
    previewAudioTimeCurrent: $("preview-audio-time-current"),
    previewAudioTimeDuration: $("preview-audio-time-duration"),
    previewAudioPlayIcon: $("preview-audio-play-icon"),
    previewVolumeRange: /** @type {HTMLInputElement} */ ($("preview-volume-range")),
    previewAutoplay: /** @type {HTMLInputElement} */ ($("preview-autoplay")),
    previewPrkWrap: $("preview-prk-wrap"),
    previewPrkColorMode: /** @type {HTMLSelectElement} */ ($("preview-prk-color-mode")),
    previewPrkSummary: $("preview-prk-summary"),
    previewPrkGrid: $("preview-prk-grid"),
    previewPrkSelection: $("preview-prk-selection"),
    previewPrkGaps: $("preview-prk-gaps"),
    previewImageWrap: $("preview-image-wrap"),
    previewImage: /** @type {HTMLImageElement} */ ($("preview-image")),
    previewImageToolbar: $("preview-image-toolbar"),
    previewBmpFit: /** @type {HTMLInputElement} */ ($("preview-bmp-fit")),
    previewPopoutBtn: /** @type {HTMLButtonElement} */ ($("preview-popout")),
    previewPopoutLabel: $("preview-popout-label"),
    previewCopyBtn: /** @type {HTMLButtonElement} */ ($("preview-copy")),
    previewPsxWrap: $("preview-psx-wrap"),
    previewPsxCanvas: /** @type {HTMLCanvasElement} */ ($("preview-psx-canvas")),
    previewPsxUvCanvas: /** @type {HTMLCanvasElement} */ ($("preview-psx-uv-canvas")),
    previewPsxCanvasStack: /** @type {HTMLDivElement} */ ($("preview-psx-canvas-stack")),
    previewPsxViewMode3d: /** @type {HTMLButtonElement} */ ($("preview-psx-view-mode-3d")),
    previewPsxViewModeUv: /** @type {HTMLButtonElement} */ ($("preview-psx-view-mode-uv")),
    previewPsxDebugMode: /** @type {HTMLSelectElement} */ ($("preview-psx-debug-mode")),
    previewPsxTextured: /** @type {HTMLInputElement} */ ($("preview-psx-textured")),
    previewPsxAssemble: /** @type {HTMLInputElement} */ ($("preview-psx-assemble")),
    previewPsxPadReport: /** @type {HTMLButtonElement} */ ($("preview-psx-pad-report")),
    previewPsxSourceBtn: /** @type {HTMLButtonElement} */ ($("preview-psx-source-btn")),
    previewPsxExportTextureBtn: /** @type {HTMLButtonElement} */ ($("preview-psx-export-texture")),
    previewPsxSourceInput: /** @type {HTMLInputElement} */ ($("preview-psx-source-input")),
    previewPsxSourceName: $("preview-psx-source-name"),
    previewPsxPartsAside: $("preview-psx-parts-aside"),
    previewPsxPartsToggle: /** @type {HTMLButtonElement} */ ($("preview-psx-parts-toggle")),
    previewPsxPartList: /** @type {HTMLDivElement} */ ($("preview-psx-part-list")),
    previewPsxAnimRow: $("preview-psx-anim-row"),
    previewPsxAnimMode: /** @type {HTMLSelectElement} */ ($("preview-psx-anim-mode")),
    previewPsxAnimPlay: /** @type {HTMLButtonElement} */ ($("preview-psx-anim-play")),
    previewPsxAnimFrame: /** @type {HTMLInputElement} */ ($("preview-psx-anim-frame")),
    previewPsxAnimStatus: $("preview-psx-anim-status"),
    statusEl: $("status"),
    btnDownload: /** @type {HTMLButtonElement} */ ($("btn-download")),
    helpDialog: /** @type {HTMLDialogElement} */ ($("help-dialog")),
    previewPopoutDialog: /** @type {HTMLDialogElement} */ ($("preview-popout-dialog")),
    previewPopoutSlot: $("preview-popout-slot"),
    previewPopoutClose: /** @type {HTMLButtonElement} */ ($("preview-popout-close")),
    helpClose: /** @type {HTMLButtonElement} */ ($("help-close")),
    recentWrap: $("recent-wrap"),
    recentList: /** @type {HTMLUListElement} */ ($("recent-list")),
    recentAutoRestore: /** @type {HTMLInputElement} */ ($("recent-auto-restore")),
    recentClear: /** @type {HTMLButtonElement} */ ($("recent-clear")),
  };
  return domRef;
}

/** @returns {DomRefs} */
export function getDom() {
  if (!domRef) throw new Error("initDomRefs() must run first");
  return domRef;
}

/** @param {DomRefs} dom */
export function getInspectorPanel(dom) {
  return dom.workspaceEl.querySelector(".workspace__inspector");
}
