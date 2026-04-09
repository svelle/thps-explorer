/**
 * Central mutable session state.
 * @type {{
 *   currentBuffer: ArrayBuffer | null,
 *   currentArchive: import("../../pkr.js").PkrArchive | null,
 *   currentFileName: string,
 *   currentLoadKind: "archive" | "prk",
 *   selectedDirIndex: number,
 *   selectedFileIndex: number,
 *   lastPsxPreviewBytes: Uint8Array | null,
 *   previewAudioObjectUrl: string | null,
 *   previewImageObjectUrl: string | null,
 *   previewClipboardText: string,
 *   prkPreviewState: { parsed: ReturnType<typeof import("../../prk.js").parsePrk>, colorMode: string, selectedIndex: number } | null,
 *   externalPsxTextureSource: import("../../psx-textures.js").PsxTextureSource | null,
 *   externalPsxTextureSourceName: string,
 *   autoPsxTextureSource: import("../../psx-textures.js").PsxTextureSource | null,
 *   autoPsxTextureSourceName: string,
 *   currentPsxExportTextures: import("../../psx-textures.js").PsxDecodedTexture[],
 *   autoPsxTextureCache: Map<string, import("../../psx-textures.js").PsxTextureSource | null>,
 *   fileViewMode: "list" | "tiles",
 *   fileListSort: { key: import("./state.js").FileSortKey, dir: "asc" | "desc" },
 *   activeFileTypeSet: Set<string>,
 *   bmpFitToFrame: boolean,
 *   threeThumbImportPromise: Promise<typeof import("three")> | null,
 *   tileThumbObjectUrls: Set<string>,
 *   tileThumbObserver: IntersectionObserver | null,
 *   activeThumbLoads: number,
 *   thumbSlotWaiters: Array<() => void>,
 *   previewIsPoppedOut: boolean,
 *   psxPreviewCtx: import("./state.js").PsxPreviewCtx | null,
 * }}
 */
export const state = {
  currentBuffer: /** @type {ArrayBuffer | null} */ (null),
  currentArchive: /** @type {import("../../pkr.js").PkrArchive | null} */ (null),
  currentFileName: "",
  currentLoadKind: /** @type {"archive" | "prk"} */ ("archive"),
  selectedDirIndex: -1,
  selectedFileIndex: -1,

  lastPsxPreviewBytes: /** @type {Uint8Array | null} */ (null),
  previewAudioObjectUrl: /** @type {string | null} */ (null),
  previewImageObjectUrl: /** @type {string | null} */ (null),
  previewClipboardText: "",

  prkPreviewState: /** @type {{ parsed: ReturnType<typeof import("../../prk.js").parsePrk>, colorMode: string, selectedIndex: number } | null} */ (
    null
  ),

  externalPsxTextureSource: /** @type {import("../../psx-textures.js").PsxTextureSource | null} */ (null),
  externalPsxTextureSourceName: "",
  autoPsxTextureSource: /** @type {import("../../psx-textures.js").PsxTextureSource | null} */ (null),
  autoPsxTextureSourceName: "",
  currentPsxExportTextures: /** @type {import("../../psx-textures.js").PsxDecodedTexture[]} */ ([]),
  autoPsxTextureCache: /** @type {Map<string, import("../../psx-textures.js").PsxTextureSource | null>} */ (new Map()),

  fileViewMode: /** @type {"list" | "tiles"} */ ("list"),

  /** @typedef {'name'|'compression'|'size'|'archive'|'offset'|'ext'} FileSortKey */
  fileListSort: /** @type {{ key: FileSortKey, dir: 'asc' | 'desc' }} */ ({ key: "name", dir: "asc" }),

  activeFileTypeSet: /** @type {Set<string>} */ (new Set()),

  bmpFitToFrame: true,

  threeThumbImportPromise: /** @type {Promise<typeof import("three")> | null} */ (null),
  tileThumbObjectUrls: /** @type {Set<string>} */ (new Set()),
  tileThumbObserver: /** @type {IntersectionObserver | null} */ (null),
  activeThumbLoads: 0,
  thumbSlotWaiters: /** @type {Array<() => void>} */ ([]),

  previewIsPoppedOut: false,

  /**
   * @typedef {object} PsxPreviewCtx
   * @property {{ rafId: number }} state
   * @property {{ dispose: () => void }} controls
   * @property {object} overlayRef
   * @property {import("three").Scene} scene
   * @property {import("three").BufferGeometry[]} geoms
   * @property {unknown} texMaterials
   * @property {object} mats
   * @property {import("three").WebGLRenderer} renderer
   * @property {ResizeObserver} ro
   * @property {(mode: string) => void} applyDebugMode
   */
  psxPreviewCtx: /** @type {PsxPreviewCtx | null} */ (null),
};
