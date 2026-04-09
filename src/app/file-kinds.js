import { COMPRESSED_ZLIB, UNCOMPRESSED } from "../../pkr.js";

/** Lowercase extension including leading dot, or `""` if none. */
export function getFileExtension(filename) {
  const base = filename.replace(/^.*[/\\]/, "");
  const i = base.lastIndexOf(".");
  if (i <= 0 || i === base.length - 1) return "";
  return base.slice(i).toLowerCase();
}

/** Uppercase ext for display (e.g. `.PSX`), or `—` if absent. */
export function formatFileExtDisplay(filename) {
  const ext = getFileExtension(filename);
  if (!ext) return "—";
  return ext.toUpperCase();
}

/**
 * @returns {"file-tile__hero--cyan" | "file-tile__hero--orange" | "file-tile__hero--lime"}
 */
export function fileTileHeroClass(filename) {
  const ext = getFileExtension(filename);
  if ([".lua", ".prk", ".json"].includes(ext)) return "file-tile__hero--orange";
  if ([".pkr", ".pak", ".cat"].includes(ext)) return "file-tile__hero--lime";
  if ([".psx", ".psh", ".bmp", ".wav", ".png", ".tex"].includes(ext)) return "file-tile__hero--cyan";
  return "file-tile__hero--cyan";
}

/** Effective on-disk size for this entry (compressed payload vs stored). */
export function inArchiveBytes(entry) {
  return entry.compression === COMPRESSED_ZLIB ? entry.compressed_size : entry.uncompressed_size;
}

/** @param {{ compression: number }} entry */
export function compressionUi(entry) {
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

export function isBmp(bytes) {
  return bytes.length >= 6 && bytes[0] === 0x42 && bytes[1] === 0x4d;
}

export function isBmpFileName(name) {
  return name.toLowerCase().endsWith(".bmp");
}

export function isPrkFileName(name) {
  return name.toLowerCase().endsWith(".prk");
}

export function isPsxFileName(name) {
  return name.toLowerCase().endsWith(".psx");
}

export function isPshFileName(name) {
  return name.toLowerCase().endsWith(".psh");
}

/**
 * @param {Uint8Array} bytes
 */
export function isRiffWave(bytes) {
  if (bytes.length < 12) return false;
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) return false;
  if (bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45) return false;
  return true;
}
