export const STORAGE_WAV_AUTOPLAY = "pkr-explorer-wav-autoplay";
export const STORAGE_FILE_VIEW = "pkr-explorer-file-view";
export const STORAGE_INSPECTOR_WIDTH = "pkr-explorer-inspector-width";
export const STORAGE_BMP_FIT = "pkr-explorer-bmp-fit-frame";
export const STORAGE_AUTO_RESTORE = "pkr-explorer-auto-restore";
export const STORAGE_PSX_DEBUG_MODE = "pkr-explorer-psx-debug-mode";
export const STORAGE_PSX_SURFACE_MODE = "pkr-explorer-psx-surface-mode";

/** `"dark"` | `"light"` — Warehouse 99 dark vs light edition. */
export const STORAGE_THEME = "pkr-explorer-theme";

export const HISTORY_DB_NAME = "pkr-explorer-history";
/** v2: metadata + FileSystemFileHandle only (no full file copies in IndexedDB). */
export const HISTORY_DB_VER = 2;
export const HISTORY_META = "meta";
export const HISTORY_MAX_ENTRIES = 10;

export const INSPECTOR_WIDTH_MIN = 820;
export const INSPECTOR_WIDTH_MAX = 1920;
/** Viewport width (px) at which the 3-column + resizable inspector layout is used. */
export const INSPECTOR_LAYOUT_MIN_VIEWPORT = 1120;

export const DEFAULT_PREVIEW_HINT = "Hex or plain text (first portion of the file).";

/** Cap for generating full hex into clipboard (avoid huge strings). */
export const MAX_FULL_HEX_COPY = 512 * 1024;

/** Skip tile thumbnails above this uncompressed size (decompress + decode cost). */
export const TILE_BMP_THUMB_MAX_BYTES = 8 * 1024 * 1024;
/** PSX mesh thumbs: parse + headless WebGL (no external texture lib in grid). */
export const TILE_PSX_THUMB_MAX_BYTES = 8 * 1024 * 1024;
/** Render target pixel size for `.psx` grid thumbnails (displayed via CSS in tile). */
export const PSX_TILE_THUMB_PX = 128;

export const THUMB_LOAD_CAP = 5;

export const PREVIEW_HEX_MAX = 256;
export const PREVIEW_TEXT_MAX = 8192;
