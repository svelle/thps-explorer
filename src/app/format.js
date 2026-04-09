import { PREVIEW_HEX_MAX, PREVIEW_TEXT_MAX } from "./storage-keys.js";

export const nf = new Intl.NumberFormat(undefined);

/**
 * @param {number} n
 */
export function formatBytes(n) {
  if (n < 1024) return `${nf.format(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * @param {number} value
 */
export function formatHexByte(value) {
  return `0x${value.toString(16).padStart(2, "0")}`;
}

/**
 * @param {number} value
 */
export function formatHexU32(value) {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} [maxBytes]
 */
export function formatHex(bytes, maxBytes = PREVIEW_HEX_MAX) {
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
export function tryUtf8Preview(bytes) {
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
 * @param {string} s
 */
export function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {number} ts
 */
export function formatRecentTime(ts) {
  const d = Date.now() - ts;
  if (d < 45_000) return "just now";
  if (d < 3600_000) return `${Math.max(1, Math.floor(d / 60_000))} min ago`;
  if (d < 86_400_000) return `${Math.max(1, Math.floor(d / 3600_000))} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
