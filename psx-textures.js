/**
 * Embedded / external Neversoft `.psx` texture metadata and bitmaps.
 * The face's `texture_idx` does not point straight at a texture header; it first indexes a
 * `texhash_list`, which is then resolved to a texture header `texidx` by matching hashes.
 * @see https://gist.github.com/iamgreaser/b54531e41d77b69d7d13391deb0ac6a5
 */

const MAX_TEXTURE_DIM = 1024;
const MAX_TEXTURES = 256;

/** Neversoft-style cutout: keyed RGB (255, 0, 255) → transparent in preview. */
const CHROMA_R = 255;
const CHROMA_G = 0;
const CHROMA_B = 255;

/**
 * @param {Uint8ClampedArray} rgba length width*height*4
 */
function applyPsxChromaTransparency(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] === CHROMA_R && rgba[i + 1] === CHROMA_G && rgba[i + 2] === CHROMA_B) {
      rgba[i + 3] = 0;
    }
  }
}

/** @param {number} h */
export function psx15ToRgba(h) {
  const r = Math.round(((h & 0x1f) / 31) * 255);
  const g = Math.round((((h >> 5) & 0x1f) / 31) * 255);
  const b = Math.round((((h >> 10) & 0x1f) / 31) * 255);
  return [r & 255, g & 255, b & 255, 255];
}

/**
 * @typedef {{ width: number, height: number, strideWidth: number, rgba: Uint8ClampedArray, nameHash: number, texIndex: number }} PsxDecodedTexture
 * @typedef {{ texhashList: number[], texturesByTexIndex: Map<number, PsxDecodedTexture> }} PsxTextureSource
 */

/**
 * @param {DataView} dv
 * @param {number} start
 * @param {number} fileLen
 */
function skipTaggedChunks(dv, start, fileLen) {
  let o = start;
  while (o + 4 <= fileLen) {
    const type = dv.getUint32(o, true);
    if (type === 0xffffffff) return o;
    if (o + 8 > fileLen) return -1;
    const chLen = dv.getUint32(o + 4, true);
    if (chLen < 0 || chLen > fileLen || o + 8 + chLen > fileLen) return -1;
    o += 8 + chLen;
  }
  return -1;
}

/**
 * @param {DataView} dv
 * @param {number} o
 * @param {number} fileLen
 * @returns {PsxTextureSource | null}
 */
function decodeTextureInfo(dv, o, fileLen) {
  if (o + 4 > fileLen) return null;
  const texhashCount = dv.getUint32(o, true);
  o += 4;
  if (texhashCount > MAX_TEXTURES || o + texhashCount * 4 > fileLen) return null;
  /** @type {number[]} */
  const texhashList = [];
  for (let i = 0; i < texhashCount; i++) {
    texhashList.push(dv.getUint32(o + i * 4, true) >>> 0);
  }
  o += texhashCount * 4;

  /** @type {Map<number, { bpp: number, pal: Uint8ClampedArray }>} */
  const paletteByHash = new Map();

  if (o + 4 > fileLen) return null;
  const nPal4 = dv.getUint32(o, true);
  o += 4;
  for (let i = 0; i < nPal4; i++) {
    if (o + 4 + 32 > fileLen) return null;
    const hash = dv.getUint32(o, true) >>> 0;
    o += 4;
    const pal = new Uint8ClampedArray(16 * 4);
    for (let j = 0; j < 16; j++) {
      const h = dv.getUint16(o, true);
      o += 2;
      const [r, g, b, a] = psx15ToRgba(h);
      pal[j * 4] = r;
      pal[j * 4 + 1] = g;
      pal[j * 4 + 2] = b;
      pal[j * 4 + 3] = a;
    }
    paletteByHash.set(hash, { bpp: 4, pal });
  }

  if (o + 4 > fileLen) return null;
  const nPal8 = dv.getUint32(o, true);
  o += 4;
  for (let i = 0; i < nPal8; i++) {
    if (o + 4 + 512 > fileLen) return null;
    const hash = dv.getUint32(o, true) >>> 0;
    o += 4;
    const pal = new Uint8ClampedArray(256 * 4);
    for (let j = 0; j < 256; j++) {
      const h = dv.getUint16(o, true);
      o += 2;
      const [r, g, b, a] = psx15ToRgba(h);
      pal[j * 4] = r;
      pal[j * 4 + 1] = g;
      pal[j * 4 + 2] = b;
      pal[j * 4 + 3] = a;
    }
    paletteByHash.set(hash, { bpp: 8, pal });
  }

  if (o + 4 > fileLen) return null;
  const nTex = dv.getUint32(o, true);
  o += 4;
  if (nTex > MAX_TEXTURES || o + nTex * 4 > fileLen) return null;

  /** @type {number[]} */
  const ptrs = [];
  for (let i = 0; i < nTex; i++) {
    ptrs.push(dv.getUint32(o + i * 4, true) >>> 0);
  }

  /** @type {Map<number, PsxDecodedTexture>} */
  const texturesByTexIndex = new Map();
  for (const ptr of ptrs) {
    if (ptr < 8 || ptr + 20 > fileLen) continue;
    const colorCount = dv.getUint32(ptr + 4, true);
    const nameHash = dv.getUint32(ptr + 8, true) >>> 0;
    const texIndex = dv.getUint32(ptr + 12, true) >>> 0;
    const width = dv.getUint16(ptr + 16, true);
    const height = dv.getUint16(ptr + 18, true);
    if (width === 0 || height === 0 || width > MAX_TEXTURE_DIM || height > MAX_TEXTURE_DIM) continue;

    const palWrap = paletteByHash.get(nameHash);
    if (!palWrap) continue;
    const { bpp, pal } = palWrap;
    let p = ptr + 20;
    /** @type {Uint8ClampedArray | null} */
    let rgba = null;

    if (bpp === 4 && colorCount === 16) {
      const alignedW = (width + 3) & ~3;
      const bytesPerRow = alignedW >> 1;
      rgba = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        if (p + bytesPerRow > fileLen) {
          rgba = null;
          break;
        }
        let xp = p;
        p += bytesPerRow;
        for (let x = 0; x < alignedW; x += 2) {
          const b = dv.getUint8(xp++);
          const i0 = b & 0xf;
          const i1 = (b >> 4) & 0xf;
          if (x < width) {
            const oa = (y * width + x) * 4;
            rgba[oa] = pal[i0 * 4];
            rgba[oa + 1] = pal[i0 * 4 + 1];
            rgba[oa + 2] = pal[i0 * 4 + 2];
            rgba[oa + 3] = pal[i0 * 4 + 3];
          }
          if (x + 1 < width) {
            const oa = (y * width + x + 1) * 4;
            rgba[oa] = pal[i1 * 4];
            rgba[oa + 1] = pal[i1 * 4 + 1];
            rgba[oa + 2] = pal[i1 * 4 + 2];
            rgba[oa + 3] = pal[i1 * 4 + 3];
          }
        }
      }
    } else if (bpp === 8 && colorCount === 256) {
      const alignedW = (width + 1) & ~1;
      rgba = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        if (p + alignedW > fileLen) {
          rgba = null;
          break;
        }
        for (let x = 0; x < alignedW; x++) {
          const pix = dv.getUint8(p++);
          if (x < width) {
            const oa = (y * width + x) * 4;
            rgba[oa] = pal[pix * 4];
            rgba[oa + 1] = pal[pix * 4 + 1];
            rgba[oa + 2] = pal[pix * 4 + 2];
            rgba[oa + 3] = pal[pix * 4 + 3];
          }
        }
      }
    } else {
      continue;
    }

    if (rgba && rgba.length === width * height * 4) {
      applyPsxChromaTransparency(rgba);
      const strideWidth = bpp === 4 ? (width + 3) & ~3 : (width + 1) & ~1;
      texturesByTexIndex.set(texIndex, {
        width,
        height,
        strideWidth,
        rgba,
        nameHash,
        texIndex,
      });
    }
  }

  return { texhashList, texturesByTexIndex };
}

/**
 * Parse texture references and any embedded bitmaps from a regular mesh `.psx`.
 * @param {DataView} dv
 * @param {number} chunkPtr
 * @param {number} fileLen
 * @param {number} modelCount
 * @returns {PsxTextureSource | null}
 */
export function parsePsxEmbeddedTextureSource(dv, chunkPtr, fileLen, modelCount) {
  if (chunkPtr < 8 || chunkPtr >= fileLen) return null;
  const term = skipTaggedChunks(dv, chunkPtr, fileLen);
  if (term < 0 || term + 4 > fileLen || dv.getUint32(term, true) !== 0xffffffff) return null;
  let o = term + 4;
  if (modelCount < 0 || modelCount > 65536 || o + modelCount * 4 > fileLen) return null;
  o += modelCount * 4;
  return decodeTextureInfo(dv, o, fileLen);
}

/**
 * Parse a standalone texture-library `.psx` (the second argument to psxviewer.c).
 * @param {Uint8Array} bytes
 * @returns {PsxTextureSource | null}
 */
export function parsePsxExternalTextureSource(bytes) {
  if (bytes.length < 12) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(0, true) !== 0x0004 || dv.getUint16(2, true) !== 0x0002) return null;
  const chunkPtr = dv.getUint32(4, true);
  if (chunkPtr < 8 || chunkPtr >= bytes.length) return null;
  let o = chunkPtr;
  if (dv.getUint32(o, true) !== 0xffffffff) {
    o = skipTaggedChunks(dv, chunkPtr, bytes.length);
    if (o < 0 || o + 4 > bytes.length || dv.getUint32(o, true) !== 0xffffffff) return null;
  }
  return decodeTextureInfo(dv, o + 4, bytes.length);
}

/**
 * Faces store an index into the model's texhash list; the resolved texture source maps that hash
 * back to its own texhash list, then uses the matched index as the texture header `texidx`.
 * @param {number[]} modelTexhashList
 * @param {PsxTextureSource | null | undefined} source
 * @returns {Map<number, PsxDecodedTexture> | null}
 */
export function resolveTextureBankForModel(modelTexhashList, source) {
  if (!source || modelTexhashList.length === 0) return null;
  /** @type {Map<number, number>} */
  const sourceHashToIndex = new Map();
  for (let i = 0; i < source.texhashList.length; i++) {
    const hash = source.texhashList[i] >>> 0;
    if (!sourceHashToIndex.has(hash)) sourceHashToIndex.set(hash, i);
  }

  /** @type {Map<number, PsxDecodedTexture>} */
  const resolved = new Map();
  for (let faceTexIndex = 0; faceTexIndex < modelTexhashList.length; faceTexIndex++) {
    const hash = modelTexhashList[faceTexIndex] >>> 0;
    const sourceTexIndex = sourceHashToIndex.get(hash);
    if (sourceTexIndex == null) continue;
    const entry = source.texturesByTexIndex.get(sourceTexIndex);
    if (entry) resolved.set(faceTexIndex, entry);
  }
  return resolved.size > 0 ? resolved : null;
}
