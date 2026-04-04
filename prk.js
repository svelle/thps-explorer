export const PRK_SIZES = [
  [16, 16],
  [24, 24],
  [30, 30],
  [30, 18],
  [60, 6],
];

export const PRK_THEMES = ["Power Plant", "Industrial", "Outdoor", "School"];

const GAP_COUNT = 10;
const GAP_NAME_LEN = 25;
const HIGHSCORE_COUNT = 8;
const HIGHSCORE_LEN = 8;
const EXPECTED_PAD_BYTE = 0x33;
const TRAILING_PAD_LEN = 76;
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} length
 * @returns {string}
 */
function readFixedString(bytes, offset, length) {
  const slice = bytes.subarray(offset, offset + length);
  let end = slice.length;
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0) {
      end = i;
      break;
    }
  }
  return textDecoder.decode(slice.subarray(0, end));
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function hexBytes(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

/**
 * @param {ArrayBuffer | Uint8Array} input
 */
export function parsePrk(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 12) {
    throw new Error("file too small for PRK header");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const unk1 = view.getUint32(0, true);
  const sizeIdx = view.getUint32(4, true);
  const themeIdx = view.getUint32(8, true);
  const size = PRK_SIZES[sizeIdx];
  if (!size) {
    throw new Error(`unknown PRK size index ${sizeIdx}`);
  }

  const [width, height] = size;
  const cellCount = width * height;
  const minSize = 12 + cellCount * 8 + GAP_COUNT * (8 + 3 + GAP_NAME_LEN) + HIGHSCORE_COUNT * HIGHSCORE_LEN;
  if (bytes.length < minSize) {
    throw new Error(`truncated PRK: ${bytes.length} bytes < minimum ${minSize}`);
  }

  /** @type {Array<{
   *  index: number,
   *  x: number,
   *  y: number,
   *  slot0: number,
   *  slot1: number,
   *  slot2: number,
   *  slot3: number,
   *  variant: number,
   *  pad: number,
   *  flags: number,
   *  indexByte: number,
   *  slots: [number, number, number, number],
   *  isEmpty: boolean,
   *  raw: Uint8Array,
   * }>} */
  const cells = [];
  let offset = 12;
  let usedCellCount = 0;

  for (let i = 0; i < cellCount; i++) {
    const raw = bytes.slice(offset, offset + 8);
    const slot0 = raw[0];
    const slot1 = raw[1];
    const slot2 = raw[2];
    const slot3 = raw[3];
    const variant = raw[4];
    const pad = raw[5];
    const flags = raw[6];
    const indexByte = raw[7];
    const isEmpty =
      slot0 === 0xff &&
      slot1 === 0xff &&
      slot2 === 0xff &&
      slot3 === 0xff &&
      variant === 0xff &&
      flags === 0x01 &&
      indexByte === 0x00;
    if (!isEmpty) usedCellCount++;
    cells.push({
      index: i,
      x: i % width,
      y: Math.floor(i / width),
      slot0,
      slot1,
      slot2,
      slot3,
      variant,
      pad,
      flags,
      indexByte,
      slots: [slot0, slot1, slot2, slot3],
      isEmpty,
      raw,
    });
    offset += 8;
  }

  /** @type {Array<{
   *  index: number,
   *  raw8: Uint8Array,
   *  info: Uint8Array,
   *  name: string,
   *  isEmpty: boolean,
   * }>} */
  const gaps = [];
  for (let i = 0; i < GAP_COUNT; i++) {
    const raw8 = bytes.slice(offset, offset + 8);
    offset += 8;
    const info = bytes.slice(offset, offset + 3);
    offset += 3;
    const name = readFixedString(bytes, offset, GAP_NAME_LEN);
    offset += GAP_NAME_LEN;
    const isEmpty = raw8.every((b) => b === 0) && info.every((b) => b === 0) && name.length === 0;
    gaps.push({ index: i, raw8, info, name, isEmpty });
  }

  /** @type {Uint8Array[]} */
  const highscores = [];
  for (let i = 0; i < HIGHSCORE_COUNT; i++) {
    highscores.push(bytes.slice(offset, offset + HIGHSCORE_LEN));
    offset += HIGHSCORE_LEN;
  }

  const trailing = bytes.slice(offset);
  const trailingPadLooksStandard =
    trailing.length === TRAILING_PAD_LEN && trailing.every((b) => b === EXPECTED_PAD_BYTE);

  return {
    header: {
      unk1,
      sizeIdx,
      themeIdx,
      width,
      height,
      size,
      theme: PRK_THEMES[themeIdx] ?? `unknown(${themeIdx})`,
    },
    width,
    height,
    cells,
    gaps,
    highscores,
    usedCellCount,
    namedGaps: gaps.filter((gap) => gap.name.length > 0),
    trailing,
    trailingPadLooksStandard,
    expectedPadByte: EXPECTED_PAD_BYTE,
  };
}
