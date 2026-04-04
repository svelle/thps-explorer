/** Neversoft PK archives — matches pkr-tool/src/pkr.rs (PKR3 + THPS2-style). */

export const MAGIC_PKR3 = new TextEncoder().encode("PKR3");
export const COMPRESSED_ZLIB = 0x00000002;
export const UNCOMPRESSED = 0xffff_fffe;

/** @typedef {"pkr3" | "thps2"} PkrFormat */

export const PKR_FORMAT_PKR3 = /** @type {const} */ ("pkr3");
export const PKR_FORMAT_THPS2 = /** @type {const} */ ("thps2");

/** @type {string} */
export const FFLATE_MODULE_URL = "https://esm.sh/fflate@0.8.2";

let fflatePromise = null;

/**
 * @returns {Promise<{ unzlib: (data: Uint8Array) => Uint8Array }>}
 */
export function loadFflate() {
  if (!fflatePromise) {
    fflatePromise = import(/* @vite-ignore */ FFLATE_MODULE_URL);
  }
  return fflatePromise;
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

/**
 * IEEE CRC32 (same as crc32fast default / ZIP / PNG).
 * @param {Uint8Array} data
 * @returns {number} unsigned 32-bit
 */
export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {DataView} view
 * @param {number} offset
 * @returns {string}
 */
export function readCString32(view, offset) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, 0x20);
  let end = 0x20;
  for (let i = 0; i < 0x20; i++) {
    if (bytes[i] === 0) {
      end = i;
      break;
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, end));
}

/**
 * @typedef {object} PkrFileEntry
 * @property {string} name
 * @property {number | null} crc — PKR3: CRC in table; THPS2: null (verify always passes).
 * @property {number} compression
 * @property {number} offset
 * @property {number} uncompressed_size
 * @property {number} compressed_size
 */

/**
 * @typedef {object} PkrDir
 * @property {string} name
 * @property {PkrFileEntry[]} files
 */

/**
 * @typedef {object} PkrArchive
 * @property {PkrFormat} format
 * @property {PkrDir[]} dirs
 */

/**
 * @param {PkrArchive} archive
 * @returns {string}
 */
export function formatLabel(archive) {
  return archive.format === PKR_FORMAT_PKR3 ? "PKR3" : "THPS2 PKR";
}

/**
 * Auto-detect **PKR3** (`PKR3` magic) vs **THPS2-style** (16-byte header at file start).
 * @param {ArrayBuffer} buffer
 * @returns {PkrArchive}
 */
export function parsePkr(buffer) {
  if (buffer.byteLength < 4) {
    throw new Error("file too small for PKR header");
  }
  const view = new DataView(buffer);
  let isPkr3 = true;
  for (let i = 0; i < 4; i++) {
    if (view.getUint8(i) !== MAGIC_PKR3[i]) {
      isPkr3 = false;
      break;
    }
  }
  if (isPkr3) {
    if (buffer.byteLength < 8) {
      throw new Error("file too small for PKR3 header");
    }
    const dirOffset = view.getUint32(4, true);
    return parsePkr3At(buffer, dirOffset);
  }
  return parseThps2(buffer);
}

/**
 * @param {ArrayBuffer} buffer
 * @param {number} dirOffset
 * @returns {PkrArchive}
 */
function parsePkr3At(buffer, dirOffset) {
  if (dirOffset + 12 > buffer.byteLength) {
    throw new Error("PKR3 directory offset out of range");
  }
  const view = new DataView(buffer);
  let o = dirOffset;
  /* const dirUnk = */ view.getUint32(o, true);
  o += 4;
  const numDirs = view.getUint32(o, true);
  o += 4;
  const numFilesTotal = view.getUint32(o, true);
  o += 4;

  if (numDirs > 1_000_000 || numFilesTotal > 10_000_000) {
    throw new Error("PKR3: absurd directory/file counts — wrong format?");
  }

  /** @type {Array<{ name: string, nfiles: number }>} */
  const dirRecords = [];
  for (let d = 0; d < numDirs; d++) {
    if (o + 0x28 > buffer.byteLength) {
      throw new Error("truncated PKR3 directory record");
    }
    const name = readCString32(view, o);
    o += 0x20;
    /* const recUnk = */ view.getUint32(o, true);
    o += 4;
    const nfiles = view.getUint32(o, true);
    o += 4;
    dirRecords.push({ name, nfiles });
  }

  /** @type {PkrDir[]} */
  const dirs = [];
  let filesRead = 0;

  for (const { name: dirName, nfiles } of dirRecords) {
    /** @type {PkrFileEntry[]} */
    const files = [];
    for (let f = 0; f < nfiles; f++) {
      if (o + 0x34 > buffer.byteLength) {
        throw new Error("truncated PKR3 file entry");
      }
      const name = readCString32(view, o);
      o += 0x20;
      const crc = view.getUint32(o, true);
      o += 4;
      const compression = view.getUint32(o, true);
      o += 4;
      const entryOffset = view.getUint32(o, true);
      o += 4;
      const uncompressed_size = view.getUint32(o, true);
      o += 4;
      const compressed_size = view.getUint32(o, true);
      o += 4;

      if (compression !== COMPRESSED_ZLIB && compression !== UNCOMPRESSED) {
        throw new Error(
          `unsupported compression 0x${compression.toString(16).padStart(8, "0")} for \`${name}\` (supported: 0x${COMPRESSED_ZLIB.toString(16)} zlib, 0x${UNCOMPRESSED.toString(16)} stored)`
        );
      }

      files.push({
        name,
        crc,
        compression,
        offset: entryOffset,
        uncompressed_size,
        compressed_size,
      });
    }
    filesRead += nfiles;
    dirs.push({ name: dirName, files });
  }

  if (filesRead !== numFilesTotal) {
    throw new Error(
      `PKR3 file count mismatch: header says ${numFilesTotal} files, directory entries sum to ${filesRead}`
    );
  }

  return { format: PKR_FORMAT_PKR3, dirs };
}

/**
 * THPS2 layout per extract-pkr.py (JayFoxRox/thps2-tools).
 * @param {ArrayBuffer} buffer
 * @returns {PkrArchive}
 */
function parseThps2(buffer) {
  if (buffer.byteLength < 16) {
    throw new Error("file too small for THPS2 PKR header");
  }
  const view = new DataView(buffer);
  const numDir = view.getUint32(8, true);
  const numFile = view.getUint32(12, true);

  if (numDir > 1_000_000 || numFile > 10_000_000) {
    throw new Error("THPS2 PKR: absurd directory/file counts — not a PKR or corrupt");
  }

  let cursor = 16;
  /** @type {PkrDir[]} */
  const dirs = [];
  let filesRead = 0;

  for (let d = 0; d < numDir; d++) {
    if (cursor + 0x20 + 8 > buffer.byteLength) {
      throw new Error("truncated THPS2 directory header");
    }
    const dirName = readCString32(view, cursor);
    cursor += 0x20;
    const tableOffset = view.getUint32(cursor, true);
    cursor += 4;
    const count = view.getUint32(cursor, true);
    cursor += 4;
    const resumeCursor = cursor;

    let t = tableOffset;
    /** @type {PkrFileEntry[]} */
    const files = [];
    for (let f = 0; f < count; f++) {
      if (t + 0x30 > buffer.byteLength) {
        throw new Error("truncated THPS2 file entry");
      }
      const name = readCString32(view, t);
      t += 0x20;
      const compression = view.getUint32(t, true);
      t += 4;
      const entryOffset = view.getUint32(t, true);
      t += 4;
      const size1 = view.getUint32(t, true);
      t += 4;
      const size2 = view.getUint32(t, true);
      t += 4;

      if (compression !== UNCOMPRESSED && compression !== COMPRESSED_ZLIB) {
        throw new Error(
          `THPS2 entry \`${name}\`: unsupported compression 0x${compression.toString(16).padStart(8, "0")}`
        );
      }
      if (compression === UNCOMPRESSED && size1 !== size2) {
        throw new Error(
          `THPS2 entry \`${name}\`: stored file has mismatched sizes ${size1} vs ${size2}`
        );
      }

      files.push({
        name,
        crc: null,
        compression,
        offset: entryOffset,
        uncompressed_size: size1,
        compressed_size: size2,
      });
    }
    filesRead += count;
    cursor = resumeCursor;
    dirs.push({ name: dirName, files });
  }

  if (filesRead !== numFile) {
    throw new Error(
      `THPS2 PKR: header says ${numFile} files, directory tables list ${filesRead}`
    );
  }

  return { format: PKR_FORMAT_THPS2, dirs };
}

/**
 * No CRC in table (`null`) ⇒ always passes (matches Rust `verify_crc`).
 * @param {PkrFileEntry} entry
 * @param {Uint8Array} data
 */
export function verifyCrc(entry, data) {
  if (entry.crc == null) return true;
  return crc32(data) === entry.crc;
}

/**
 * @param {ArrayBuffer} buffer
 * @param {PkrFileEntry} entry
 * @returns {Promise<Uint8Array>}
 */
export async function extractEntry(buffer, entry) {
  const lenInArchive =
    entry.compression === UNCOMPRESSED
      ? entry.uncompressed_size
      : entry.compression === COMPRESSED_ZLIB
        ? entry.compressed_size
        : (() => {
            throw new Error(`unsupported compression for ${entry.name}`);
          })();

  const end = entry.offset + lenInArchive;
  if (end > buffer.byteLength || end < entry.offset) {
    throw new Error(
      `read \`${entry.name}\`: payload @ ${entry.offset} length ${lenInArchive} exceeds archive`
    );
  }

  const raw = new Uint8Array(buffer, entry.offset, lenInArchive);

  if (entry.compression === UNCOMPRESSED) {
    return raw.slice();
  }

  const { unzlib } = await loadFflate();
  let out;
  try {
    out = unzlib(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`zlib decompress \`${entry.name}\`: ${msg}`);
  }

  if (out.length !== entry.uncompressed_size) {
    throw new Error(
      `decompressed size ${out.length} != expected ${entry.uncompressed_size} for \`${entry.name}\``
    );
  }
  return out;
}
