/**
 * Heuristic animation scan for Neversoft `.psx` rigid body-part rigs.
 * THPS1/2 character animation **binary layout is not publicly documented**; we only try a few
 * strides (6×int16 per part: rotation-like + translation in s3.12) on tagged chunks and file tail.
 * @see psx-model.js (pad-field assembly), public RE notes on PS1 fixed-point / GTE angles.
 */

import { enumerateTaggedChunks, getEmbeddedTextureEndOffset } from "./psx-textures.js";
import {
  resolveModelTableForDiagnostics,
  getModelBlobEndOffset,
  isSaneModelBlob,
} from "./psx-model.js";

/** s3.12 int16 → float */
function s312(h) {
  return h / 4096;
}

/** PS1 GTE-style: 4096 counts per full turn → radians */
function angleToRad(h) {
  return (h / 4096) * Math.PI * 2;
}

/**
 * @param {DataView} dv
 * @param {number} byteOffset
 * @param {number} byteLength
 * @param {number} partCount
 * @returns {PsxAnimClip | null}
 */
function tryParsePackedRigid6Int16(dv, byteOffset, byteLength, partCount) {
  if (partCount < 1 || partCount > 256) return null;
  const bytesPerFrame = partCount * 12;
  if (byteLength < bytesPerFrame || byteLength % bytesPerFrame !== 0) return null;
  const frameCount = byteLength / bytesPerFrame;
  if (frameCount < 1 || frameCount > 500_000) return null;
  /** @type {PsxAnimFrame[]} */
  const frames = [];
  let o = byteOffset;
  for (let i = 0; i < frameCount; i++) {
    /** @type {PsxAnimPartSample[]} */
    const parts = [];
    for (let p = 0; p < partCount; p++) {
      const rx = dv.getInt16(o, true);
      const ry = dv.getInt16(o + 2, true);
      const rz = dv.getInt16(o + 4, true);
      const tx = dv.getInt16(o + 6, true);
      const ty = dv.getInt16(o + 8, true);
      const tz = dv.getInt16(o + 10, true);
      o += 12;
      parts.push({
        rx: angleToRad(rx),
        ry: angleToRad(ry),
        rz: angleToRad(rz),
        tx: s312(tx),
        ty: s312(ty),
        tz: s312(tz),
      });
    }
    frames.push({ parts });
  }
  return {
    kind: "packedRigid6",
    frameCount,
    frames,
    confidence: 0.35,
    source: "packed int16×6 per part (angle/4096→rad, trans s3.12; heuristic)",
    partCount,
  };
}

/**
 * @param {Uint8Array} bytes
 * @param {number} partCount — `modelCount` from geometry parse (skeleton slots)
 * @returns {{ clip: PsxAnimClip | null, scanNotes: string }}
 */
export function scanPsxAnimationHeuristic(bytes, partCount) {
  if (bytes.length < 16 || partCount < 1) {
    return { clip: null, scanNotes: "Need a valid modelCount to scan." };
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileLen = bytes.length;
  const chunkPtr = dv.getUint32(4, true);
  /** @type {PsxAnimClip | null} */
  let best = null;

  const consider = (label, off, len) => {
    if (len < partCount * 12) return;
    const c = tryParsePackedRigid6Int16(dv, off, len, partCount);
    if (!c) return;
    const score = c.frameCount * c.confidence;
    if (!best || score > best.frameCount * best.confidence) {
      best = { ...c, source: `${label}: ${c.source}` };
    }
  };

  if (chunkPtr >= 8 && chunkPtr < fileLen) {
    const enumd = enumerateTaggedChunks(dv, chunkPtr, fileLen);
    if (enumd) {
      for (const ch of enumd.chunks) {
        consider(`tagged chunk ${ch.typeHex}`, ch.offset + 8, ch.payloadLen);
      }
    }
  }

  let maxModelEnd = 0;
  const resolved = resolveModelTableForDiagnostics(dv, fileLen);
  if (resolved) {
    for (const p of resolved.table.ptrs) {
      if (!isSaneModelBlob(dv, p, fileLen)) continue;
      const end = getModelBlobEndOffset(dv, p, fileLen);
      if (end > maxModelEnd) maxModelEnd = end;
    }
  }

  const texEnd = getEmbeddedTextureEndOffset(dv, chunkPtr, fileLen, partCount);
  const scanLo = Math.max(maxModelEnd, texEnd ?? 0, 0);
  if (scanLo < fileLen) {
    consider("tail after models/textures", scanLo, fileLen - scanLo);
  }

  const scanNotes = best
    ? `Heuristic: ${best.frameCount} frames × ${partCount} parts (${best.kind}). Undocumented format — may be noise.`
    : "No block matched int16×6/part×frame stride. THPS1/2 animation bytes are not publicly specified.";

  return { clip: best, scanNotes };
}

/**
 * @param {import("three").Object3D} group
 */
export function ensurePartBindPoseUserData(group) {
  group.traverse((ch) => {
    if (ch.type !== "Mesh") return;
    if (ch.userData.bindPos != null) return;
    ch.userData.bindPos = ch.position.clone();
    ch.userData.bindQuat = ch.quaternion.clone();
  });
}

/**
 * @param {import("three").Object3D} group
 */
export function restorePartBindPose(group) {
  group.traverse((ch) => {
    if (ch.type !== "Mesh") return;
    if (ch.userData.bindPos == null || ch.userData.bindQuat == null) return;
    ch.position.copy(ch.userData.bindPos);
    ch.quaternion.copy(ch.userData.bindQuat);
  });
}

/**
 * @param {typeof import("three")} THREE
 * @param {import("three").Object3D} group
 * @param {number} timeSec
 */
export function applyDemoRigidPartWave(THREE, group, timeSec) {
  const axis = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  group.traverse((ch) => {
    if (ch.type !== "Mesh") return;
    const pi = ch.userData.partIndex;
    if (pi == null || ch.userData.bindPos == null || ch.userData.bindQuat == null) return;
    ch.position.copy(ch.userData.bindPos);
    ch.quaternion.copy(ch.userData.bindQuat);
    if (pi === 0) return;
    const w = Math.sin(timeSec * 2.0 + pi * 0.4) * 0.28;
    q.setFromAxisAngle(axis, w);
    ch.quaternion.multiply(q);
  });
}

/**
 * @param {typeof import("three")} THREE
 * @param {import("three").Object3D} group
 * @param {PsxAnimClip} clip
 * @param {number} frameIndex
 */
export function applyPsxAnimClipFrame(THREE, group, clip, frameIndex) {
  if (!clip.frames.length) return;
  const fi = Math.max(0, Math.min(clip.frames.length - 1, frameIndex | 0));
  const f0 = clip.frames[0];
  const f = clip.frames[fi];
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  const q0 = new THREE.Quaternion();
  const qf = new THREE.Quaternion();
  const qd = new THREE.Quaternion();
  const v = new THREE.Vector3();

  group.traverse((ch) => {
    if (ch.type !== "Mesh") return;
    const pi = ch.userData.partIndex;
    if (pi == null || ch.userData.bindPos == null || ch.userData.bindQuat == null) return;
    if (pi >= f.parts.length || pi >= f0.parts.length) return;
    const p0 = f0.parts[pi];
    const pf = f.parts[pi];
    euler.set(pf.rx, pf.ry, pf.rz, "YXZ");
    qf.setFromEuler(euler);
    euler.set(p0.rx, p0.ry, p0.rz, "YXZ");
    q0.setFromEuler(euler);
    qd.copy(q0).invert().multiply(qf);
    ch.quaternion.copy(ch.userData.bindQuat).multiply(qd);
    v.set(pf.tx - p0.tx, pf.ty - p0.ty, pf.tz - p0.tz);
    ch.position.copy(ch.userData.bindPos).add(v);
  });
}
