/**
 * Best-effort parser for Neversoft / THPS-style `.psx` mesh files.
 * Layout follows public notes: header, objects[], model table, model blobs (gist by iamgreaser).
 * After merge, Y is negated for Three.js “up”; a single-axis flip swaps winding, so indices are reversed per triangle.
 * @see https://gist.github.com/iamgreaser/b54531e41d77b69d7d13391deb0ac6a5
 */

import {
  parsePsxEmbeddedTextureSource,
  resolveTextureBankForModel,
} from "./psx-textures.js";

/** s3.12 fixed (16-bit) → float */
function s312(h) {
  return h / 4096;
}

/** s7.24 fixed (32-bit) → float — used for object placements in levels */
function s724(i32) {
  return i32 / (1 << 24);
}

const MAX_OBJECTS = 50_000;
const MAX_MODELS = 4096;
const MAX_VERTS_TOTAL = 120_000;
const MAX_INDICES_TOTAL = 600_000;
const MAX_TEX_TRIS = 200_000;

const OBJECT_STRIDE = 36;
const PSX_WARN_ONCE = new Set();

/**
 * Engine meshes read upright on X/Z but inverted on Y relative to Three.js. Flip Y only (avoid Y↔Z swap — that laid models on their side).
 * Reflection reverses winding; swap the last two indices per triangle so normals stay outward after computeVertexNormals().
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 */
function flipNeversoftYForThree(positions, indices) {
  for (let i = 0; i < positions.length; i += 3) {
    positions[i + 1] = -positions[i + 1];
  }
  for (let i = 0; i < indices.length; i += 3) {
    const t = indices[i + 1];
    indices[i + 1] = indices[i + 2];
    indices[i + 2] = t;
  }
}

/**
 * @param {Uint8Array | null} uv8 length 8 or null
 * @param {number} corner 0..3
 */
function uvBytePair(uv8, corner) {
  if (!uv8 || corner < 0 || corner > 3) return { u: 0, v: 0 };
  const o = corner * 2;
  return { u: uv8[o], v: uv8[o + 1] };
}

/**
 * @param {string} key
 * @param {string} message
 */
function warnOnce(key, message) {
  if (PSX_WARN_ONCE.has(key)) return;
  PSX_WARN_ONCE.add(key);
  console.warn(message);
}

/**
 * @param {DataView} dv
 * @param {number} o face start
 * @param {number} nv
 * @param {number} modelUnknown
 * @param {number} fileLen
 */
function readPsxFaceRecord(dv, o, nv, modelUnknown, fileLen) {
  const baseFlags = dv.getUint16(o, true);
  const flen = dv.getUint16(o + 2, true);
  if (flen < 16 || o + flen > fileLen) return null;
  const isTri = (baseFlags & 0x0010) !== 0;
  let p = o + 4;
  let i0;
  let i1;
  let i2;
  let i3;
  /** u16 index pairs are required when nv does not fit in 8 bits (gist: BBBB can be widened). */
  const flagSaysTri = (baseFlags & 0x0010) !== 0;
  const u8Tri = dv.getUint8(p);
  const u8I1 = dv.getUint8(p + 1);
  const u8I2 = dv.getUint8(p + 2);
  const u8I3 = dv.getUint8(p + 3);
  const needU16 =
    nv > 256 ||
    (flen >= 20 &&
      (u8Tri >= nv ||
        u8I1 >= nv ||
        u8I2 >= nv ||
        (!flagSaysTri && u8I3 >= nv)));
  if (needU16 && p + 8 <= o + flen) {
    i0 = dv.getUint16(p, true);
    i1 = dv.getUint16(p + 2, true);
    i2 = dv.getUint16(p + 4, true);
    i3 = dv.getUint16(p + 6, true);
    p += 8;
  } else {
    i0 = u8Tri;
    i1 = u8I1;
    i2 = u8I2;
    i3 = u8I3;
    p += 4;
  }
  if (p + 8 > o + flen) return null;
  /** Plane index @ p+4..5, surface flags @ p+6..7 (after gouraud/flat word). */
  const surfaceFlags = dv.getUint16(p + 6, true);
  p += 8;
  let texNameIdx = -1;
  if ((modelUnknown & 1) === 0 && (baseFlags & 2)) {
    if (p + 4 > o + flen) return null;
    texNameIdx = dv.getUint32(p, true) >>> 0;
    p += 4;
  }
  /** @type {Uint8Array | null} */
  let uv8 = null;
  if (baseFlags & 1) {
    if (p + 8 <= o + flen) {
      uv8 = new Uint8Array(8);
      for (let k = 0; k < 8; k++) uv8[k] = dv.getUint8(p + k);
      p += 8;
    }
  }
  if (baseFlags & 8) {
    if (p + 8 <= o + flen) p += 8;
  }
  // TODO: Revisit this gate with more samples. Some notes suggest the 0x20 face tail may be
  // independent from the modelUnknown texture-table bit, which would desync later faces here.
  if ((modelUnknown & 1) !== 0 && (baseFlags & 0x20)) {
    warnOnce(
      "psx-face-tail-0x20",
      "[psx-model] Saw face flag 0x20 while modelUnknown&1 != 0; extra face tail handling may need revisiting."
    );
  }
  if ((modelUnknown & 1) === 0 && (baseFlags & 0x20)) {
    if (p + 4 <= o + flen) p += 4;
  }
  return {
    baseFlags,
    surfaceFlags,
    flen,
    isTri,
    i0,
    i1,
    i2,
    i3,
    texNameIdx,
    uv8,
  };
}

/**
 * Skip invisible / non-physical polys for preview (iamgreaser: base 0x0080).
 * Keep quarter-pipe "large polygon" caps (surface 0x0040) so closed surfaces stay sane.
 * @param {number} baseFlags
 * @param {number} surfaceFlags
 */
function skipFaceForPreview(baseFlags, surfaceFlags) {
  if ((baseFlags & 0x0080) === 0) return false;
  if ((surfaceFlags & 0x0040) !== 0) return false;
  return true;
}

/** @param {{ x: number, y: number, z: number, u: number, v: number }} a @param {{ x: number, y: number, z: number, u: number, v: number }} b */
function midpointCorner(a, b) {
  return {
    x: (a.x + b.x) * 0.5,
    y: (a.y + b.y) * 0.5,
    z: (a.z + b.z) * 0.5,
    u: (a.u + b.u) * 0.5,
    v: (a.v + b.v) * 0.5,
  };
}

/**
 * @param {{ x: number, y: number, z: number, u: number, v: number }} a
 * @param {{ x: number, y: number, z: number, u: number, v: number }} b
 * @param {{ x: number, y: number, z: number, u: number, v: number }} c
 * @param {{ x: number, y: number, z: number, u: number, v: number }} d
 */
function centerCorner4(a, b, c, d) {
  return {
    x: (a.x + b.x + c.x + d.x) * 0.25,
    y: (a.y + b.y + c.y + d.y) * 0.25,
    z: (a.z + b.z + c.z + d.z) * 0.25,
    u: (a.u + b.u + c.u + d.u) * 0.25,
    v: (a.v + b.v + c.v + d.v) * 0.25,
  };
}

/** @param {{ key: number, ax: number, ay: number, az: number, au: number, av: number, bx: number, by: number, bz: number, bu: number, bv: number, cx: number, cy: number, cz: number, cu: number, cv: number }[]} acc */
function pushTexturedTri(acc, key, a, b, c) {
  acc.push({
    key,
    ax: a.x,
    ay: a.y,
    az: a.z,
    au: a.u,
    av: a.v,
    bx: c.x,
    by: c.y,
    bz: c.z,
    bu: c.u,
    bv: c.v,
    cx: b.x,
    cy: b.y,
    cz: b.z,
    cu: b.u,
    cv: b.v,
  });
}

/** @param {{ key: number, ax: number, ay: number, az: number, au: number, av: number, bx: number, by: number, bz: number, bu: number, bv: number, cx: number, cy: number, cz: number, cu: number, cv: number }[]} acc */
function pushTexturedQuad(acc, key, a, b, c, d) {
  // Match the original psxviewer.c RIMAP split: [2,1,0] + [1,2,3]. The other diagonal overlaps badly.
  pushTexturedTri(acc, key, c, b, a);
  pushTexturedTri(acc, key, b, c, d);
}

/** @param {{ key: number, ax: number, ay: number, az: number, au: number, av: number, bx: number, by: number, bz: number, bu: number, bv: number, cx: number, cy: number, cz: number, cu: number, cv: number }[]} acc */
function pushSubdividedTexturedTri(acc, key, a, b, c) {
  const ab = midpointCorner(a, b);
  const bc = midpointCorner(b, c);
  const ca = midpointCorner(c, a);
  pushTexturedTri(acc, key, a, ab, ca);
  pushTexturedTri(acc, key, ab, b, bc);
  pushTexturedTri(acc, key, ca, bc, c);
  pushTexturedTri(acc, key, ab, bc, ca);
}

/** @param {{ key: number, ax: number, ay: number, az: number, au: number, av: number, bx: number, by: number, bz: number, bu: number, bv: number, cx: number, cy: number, cz: number, cu: number, cv: number }[]} acc */
function pushSubdividedTexturedQuad(acc, key, a, b, c, d) {
  // TODO: This helper still assumes perimeter-ordered quads. PSX quads are Z-ordered for the
  // runtime split above, so rewrite these midpoints before re-enabling 0x1000 subdivision.
  const ab = midpointCorner(a, b);
  const bc = midpointCorner(b, c);
  const cd = midpointCorner(c, d);
  const da = midpointCorner(d, a);
  const ctr = centerCorner4(a, b, c, d);
  pushTexturedQuad(acc, key, a, ab, ctr, da);
  pushTexturedQuad(acc, key, ab, b, bc, ctr);
  pushTexturedQuad(acc, key, ctr, bc, c, cd);
  pushTexturedQuad(acc, key, da, ctr, cd, d);
}

/** @param {number[]} positions */
function pushGeomVertex(positions, x, y, z) {
  const idx = positions.length / 3;
  positions.push(x, y, z);
  return idx;
}

/** @param {number[]} positions */
function midpointGeomVertex(positions, a, b) {
  const ax = positions[a * 3];
  const ay = positions[a * 3 + 1];
  const az = positions[a * 3 + 2];
  const bx = positions[b * 3];
  const by = positions[b * 3 + 1];
  const bz = positions[b * 3 + 2];
  return pushGeomVertex(positions, (ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
}

/** @param {number[]} positions */
function centerGeomVertex4(positions, a, b, c, d) {
  const ax = positions[a * 3];
  const ay = positions[a * 3 + 1];
  const az = positions[a * 3 + 2];
  const bx = positions[b * 3];
  const by = positions[b * 3 + 1];
  const bz = positions[b * 3 + 2];
  const cx = positions[c * 3];
  const cy = positions[c * 3 + 1];
  const cz = positions[c * 3 + 2];
  const dx = positions[d * 3];
  const dy = positions[d * 3 + 1];
  const dz = positions[d * 3 + 2];
  return pushGeomVertex(
    positions,
    (ax + bx + cx + dx) * 0.25,
    (ay + by + cy + dy) * 0.25,
    (az + bz + cz + dz) * 0.25
  );
}

/** @param {number[]} indices */
function pushGeomTri(indices, a, b, c) {
  indices.push(a, c, b);
}

/** @param {number[]} indices */
function pushGeomQuad(indices, a, b, c, d) {
  // Match the original psxviewer.c RIMAP split: [2,1,0] + [1,2,3]. The other diagonal overlaps badly.
  pushGeomTri(indices, c, b, a);
  pushGeomTri(indices, b, c, d);
}

/** @param {number[]} positions @param {number[]} indices */
function pushSubdividedGeomTri(positions, indices, a, b, c) {
  const ab = midpointGeomVertex(positions, a, b);
  const bc = midpointGeomVertex(positions, b, c);
  const ca = midpointGeomVertex(positions, c, a);
  pushGeomTri(indices, a, ab, ca);
  pushGeomTri(indices, ab, b, bc);
  pushGeomTri(indices, ca, bc, c);
  pushGeomTri(indices, ab, bc, ca);
}

/** @param {number[]} positions @param {number[]} indices */
function pushSubdividedGeomQuad(positions, indices, a, b, c, d) {
  // TODO: This helper still assumes perimeter-ordered quads. PSX quads are Z-ordered for the
  // runtime split above, so rewrite these midpoints before re-enabling 0x1000 subdivision.
  const ab = midpointGeomVertex(positions, a, b);
  const bc = midpointGeomVertex(positions, b, c);
  const cd = midpointGeomVertex(positions, c, d);
  const da = midpointGeomVertex(positions, d, a);
  const ctr = centerGeomVertex4(positions, a, b, c, d);
  pushGeomQuad(indices, a, ab, ctr, da);
  pushGeomQuad(indices, ab, b, bc, ctr);
  pushGeomQuad(indices, ctr, bc, c, cd);
  pushGeomQuad(indices, da, ctr, cd, d);
}

/**
 * @param {{ key: number, ax: number, ay: number, az: number, au: number, av: number, bx: number, by: number, bz: number, bu: number, bv: number, cx: number, cy: number, cz: number, cu: number, cv: number }[]} tris
 * @param {Map<number, { width: number, height: number, rgba: Uint8ClampedArray }>} texByIndex
 */
export function buildTexturedMeshBuffers(tris, texByIndex) {
  if (tris.length === 0) return null;

  tris.sort((a, b) => a.key - b.key);

  /** @type {number[]} */
  const keysOrdered = [];
  let lastK = /** @type {number | null} */ (null);
  for (const t of tris) {
    if (lastK !== t.key) {
      keysOrdered.push(t.key);
      lastK = t.key;
    }
  }

  /** @type {Map<number, number>} */
  const keyToMat = new Map();
  let mi = 0;
  for (const k of keysOrdered) {
    keyToMat.set(k, mi++);
  }

  /** @type {number[]} */
  const pos = [];
  /** @type {number[]} */
  const uv = [];
  /** @type {number[]} */
  const idx = [];
  /** @type {{ start: number, count: number, materialIndex: number }[]} */
  const groups = [];

  let curKey = tris[0].key;
  let groupIndexStart = 0;

  const pushTri = (/** @type {typeof tris[0]} */ t) => {
    const td = texByIndex.get(t.key);
    /** @param {number} x @param {number} y @param {number} z @param {number} ub @param {number} vb */
    const corner = (x, y, z, ub, vb) => {
      let uf;
      let vf;
      if (td) {
        uf = ub / td.width;
        vf = 1 - vb / td.height;
      } else {
        uf = 0;
        vf = 0;
      }
      pos.push(x, y, z);
      uv.push(uf, vf);
    };
    const b = pos.length / 3;
    corner(t.ax, t.ay, t.az, t.au, t.av);
    corner(t.bx, t.by, t.bz, t.bu, t.bv);
    corner(t.cx, t.cy, t.cz, t.cu, t.cv);
    idx.push(b, b + 1, b + 2);
  };

  for (let ti = 0; ti < tris.length; ti++) {
    const t = tris[ti];
    if (t.key !== curKey) {
      groups.push({
        start: groupIndexStart,
        count: idx.length - groupIndexStart,
        materialIndex: keyToMat.get(curKey) ?? 0,
      });
      groupIndexStart = idx.length;
      curKey = t.key;
    }
    pushTri(t);
  }
  groups.push({
    start: groupIndexStart,
    count: idx.length - groupIndexStart,
    materialIndex: keyToMat.get(curKey) ?? 0,
  });

  const materialKeys = keysOrdered.slice();

  return {
    positions: new Float32Array(pos),
    uvs: new Float32Array(uv),
    indices: new Uint32Array(idx),
    groups,
    materialKeys,
  };
}

/**
 * @param {{ key: number, ax: number, ay: number, az: number, au: number, av: number, bx: number, by: number, bz: number, bu: number, bv: number, cx: number, cy: number, cz: number, cu: number, cv: number }[]} tris
 */
function flipTexturedTrisForThree(tris) {
  for (const t of tris) {
    t.ay = -t.ay;
    t.by = -t.by;
    t.cy = -t.cy;
    const bx = t.bx;
    const by = t.by;
    const bz = t.bz;
    const bu = t.bu;
    const bv = t.bv;
    t.bx = t.cx;
    t.by = t.cy;
    t.bz = t.cz;
    t.bu = t.cu;
    t.bv = t.cv;
    t.cx = bx;
    t.cy = by;
    t.cz = bz;
    t.cu = bu;
    t.cv = bv;
  }
}

/**
 * @param {DataView} dv
 * @param {number} objOff
 * @param {number} fileLen
 */
function readObject(dv, objOff, fileLen) {
  if (objOff + OBJECT_STRIDE > fileLen) return null;
  const px = s724(dv.getInt32(objOff + 4, true));
  const py = s724(dv.getInt32(objOff + 8, true));
  const pz = s724(dv.getInt32(objOff + 12, true));
  const modelIndex = dv.getUint16(objOff + 22, true);
  return { px, py, pz, modelIndex };
}

/**
 * Parse one model's vertices and resolve local weld indirections.
 * `pad == 2` usually means `iy` is another vertex index in this model; out-of-range references
 * are kept as raw coordinates for now but warned once, because some skater assets may weld across
 * sibling parts rather than within a single model.
 * @param {DataView} dv
 * @param {number} ptr
 * @param {number} fileLen
 * @param {number} tx
 * @param {number} ty
 * @param {number} tz
 */
function buildResolvedModelPositions(dv, ptr, fileLen, tx, ty, tz) {
  if (ptr < 0 || ptr + 28 > fileLen) return null;

  const modelUnknown = dv.getUint16(ptr, true);
  const nv = dv.getUint16(ptr + 2, true);
  const np = dv.getUint16(ptr + 4, true);
  const nf = dv.getUint16(ptr + 6, true);
  if (nv > 20000 || np > 20000 || nf > 50000 || nv === 0) return null;

  let o = ptr + 28;
  const vEnd = o + nv * 8;
  const pEnd = vEnd + np * 8;
  if (pEnd > fileLen || nf === 0) return null;

  /** @type {Array<{ ix: number, iy: number, iz: number, pad: number }>} */
  const rawV = [];
  for (let i = 0; i < nv; i++) {
    if (o + 8 > fileLen) return null;
    rawV.push({
      ix: dv.getInt16(o, true),
      iy: dv.getInt16(o + 2, true),
      iz: dv.getInt16(o + 4, true),
      pad: dv.getInt16(o + 6, true),
    });
    o += 8;
  }

  /** @param {number} ri @param {number} depth */
  function resolvedXYZ(ri, depth) {
    if (depth > 64) return { x: 0, y: 0, z: 0 };
    const v = rawV[ri];
    if (v.pad !== 2) {
      return { x: s312(v.ix), y: s312(v.iy), z: s312(v.iz) };
    }
    const j = v.iy;
    if (j >= 0 && j < rawV.length && j !== ri) return resolvedXYZ(j, depth + 1);
    warnOnce(
      "psx-cross-model-weld",
      "[psx-model] Saw pad==2 vertex indirection outside the current model; multi-part welds may need cross-model resolution."
    );
    return { x: s312(v.ix), y: s312(v.iy), z: s312(v.iz) };
  }

  /** @type {number[]} */
  const nextPos = [];
  for (let i = 0; i < nv; i++) {
    const { x, y, z } = resolvedXYZ(i, 0);
    nextPos.push(x + tx, y + ty, z + tz);
  }

  return { modelUnknown, nv, np, nf, faceOff: pEnd, nextPos };
}

/**
 * @param {{ key: number, ax: number, ay: number, az: number, au: number, av: number, bx: number, by: number, bz: number, bu: number, bv: number, cx: number, cy: number, cz: number, cu: number, cv: number }[]} acc
 */
function appendModelTexTris(dv, ptr, fileLen, tx, ty, tz, acc) {
  if (ptr < 0 || ptr + 28 > fileLen || acc.length >= MAX_TEX_TRIS) return -1;
  const model = buildResolvedModelPositions(dv, ptr, fileLen, tx, ty, tz);
  if (!model) return -1;
  const { modelUnknown, nv, nf, faceOff, nextPos } = model;

  const gp = (ii) => ({
    x: nextPos[ii * 3],
    y: nextPos[ii * 3 + 1],
    z: nextPos[ii * 3 + 2],
  });
  const gc = (ii, uvCorner, uv8) => {
    const p = gp(ii);
    const uv = uvBytePair(uv8, uvCorner);
    return { x: p.x, y: p.y, z: p.z, u: uv.u, v: uv.v };
  };

  let o = faceOff;
  let facesParsed = 0;
  while (facesParsed < nf && o + 8 <= fileLen && acc.length < MAX_TEX_TRIS) {
    const f = readPsxFaceRecord(dv, o, nv, modelUnknown, fileLen);
    if (!f) break;
    o += f.flen;
    facesParsed++;
    const { baseFlags, surfaceFlags, isTri, i0, i1, i2, i3, texNameIdx, uv8 } = f;
    if (skipFaceForPreview(baseFlags, surfaceFlags)) continue;
    if (i0 >= nv || i1 >= nv || i2 >= nv) continue;
    const key = (baseFlags & 2) !== 0 && texNameIdx !== -1 ? texNameIdx >>> 0 : -1;
    /** Keep preview as stored tris/quads; 0x1000 helpers below still need Z-ordered quad math. */
    const needsSubdivide = false;
    if (isTri) {
      const a = gc(i0, 0, uv8);
      const b = gc(i1, 1, uv8);
      const c = gc(i2, 2, uv8);
      if (needsSubdivide) {
        pushSubdividedTexturedTri(acc, key, a, b, c);
      } else {
        pushTexturedTri(acc, key, a, b, c);
      }
    } else {
      if (i3 >= nv) continue;
      const a = gc(i0, 0, uv8);
      const b = gc(i1, 1, uv8);
      const c = gc(i2, 2, uv8);
      const d = gc(i3, 3, uv8);
      if (needsSubdivide) {
        pushSubdividedTexturedQuad(acc, key, a, b, c, d);
      } else {
        pushTexturedQuad(acc, key, a, b, c, d);
      }
    }
  }

  return nv;
}

/**
 * @param {DataView} dv
 * @param {number} ptr
 * @param {number} fileLen
 * @param {number[]} positions
 * @param {number[]} indices
 * @param {number} vertBase
 * @param {number} tx
 * @param {number} ty
 * @param {number} tz
 */
function extractOneModel(dv, ptr, fileLen, positions, indices, vertBase, tx, ty, tz) {
  const model = buildResolvedModelPositions(dv, ptr, fileLen, tx, ty, tz);
  if (!model) return -1;
  const { modelUnknown, nv, nf, faceOff, nextPos } = model;
  for (const c of nextPos) positions.push(c);

  let o = faceOff;

  const b = vertBase;
  let facesParsed = 0;
  while (facesParsed < nf && o + 8 <= fileLen) {
    const f = readPsxFaceRecord(dv, o, nv, modelUnknown, fileLen);
    if (!f) break;
    o += f.flen;
    facesParsed++;

    const { baseFlags, surfaceFlags, isTri, i0, i1, i2, i3 } = f;
    if (skipFaceForPreview(baseFlags, surfaceFlags)) continue;
    if (i0 >= nv || i1 >= nv || i2 >= nv) continue;
    /** Keep preview as stored tris/quads; 0x1000 helpers below still need Z-ordered quad math. */
    const needsSubdivide = false;
    if (isTri) {
      if (needsSubdivide) {
        pushSubdividedGeomTri(positions, indices, b + i0, b + i1, b + i2);
      } else {
        pushGeomTri(indices, b + i0, b + i1, b + i2);
      }
    } else {
      if (i3 >= nv) continue;
      if (needsSubdivide) {
        pushSubdividedGeomQuad(positions, indices, b + i0, b + i1, b + i2, b + i3);
      } else {
        pushGeomQuad(indices, b + i0, b + i1, b + i2, b + i3);
      }
    }
  }

  return positions.length / 3 - b;
}

/**
 * @param {DataView} dv
 * @param {number} tableOff
 * @param {number} fileLen
 * @returns {{ ptrs: number[], modelCount: number } | null}
 */
function readModelTablePtrs(dv, tableOff, fileLen) {
  if (tableOff + 4 > fileLen) return null;
  const modelCount = dv.getUint32(tableOff, true);
  if (modelCount === 0 || modelCount > MAX_MODELS) return null;
  const ptrBase = tableOff + 4;
  if (ptrBase + modelCount * 4 > fileLen) return null;
  /** @type {number[]} */
  const ptrs = [];
  for (let i = 0; i < modelCount; i++) {
    ptrs.push(dv.getUint32(ptrBase + i * 4, true));
  }
  return { ptrs, modelCount };
}

/**
 * Skater / prop assets ship many models in one `.psx` (one mesh per skeleton part — see companion `.psh`).
 * They live in separate bone-local spaces; merging them at the origin looks like a shattered mesh.
 * For preview, pick the single part with the most faces (then vertices) so one solid shows.
 * @param {DataView} dv
 * @param {number} tableOff
 * @param {number} fileLen
 * @param {{ ptrs: number[], modelCount: number }} table
 */
function mergeLargestSinglePart(dv, tableOff, fileLen, table, texAcc) {
  let bestIdx = -1;
  let bestScore = -1;
  for (let m = 0; m < table.modelCount; m++) {
    const p = table.ptrs[m];
    if (p < 8 || p + 28 > fileLen) continue;
    const nv = dv.getUint16(p + 2, true);
    const nf = dv.getUint16(p + 6, true);
    if (nv === 0 || nv > 20000 || nf > 50000) continue;
    const score = nf * 65536 + nv;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = m;
    }
  }
  if (bestIdx < 0) return null;

  const p = table.ptrs[bestIdx];
  /** @type {number[]} */
  const posAcc = [];
  /** @type {number[]} */
  const idxAcc = [];
  const added = extractOneModel(dv, p, fileLen, posAcc, idxAcc, 0, 0, 0, 0);
  if (added <= 0 || posAcc.length < 9 || idxAcc.length < 3) return null;
  if (texAcc) appendModelTexTris(dv, p, fileLen, 0, 0, 0, texAcc);

  const positions = new Float32Array(posAcc);
  const nIdx = Math.min(idxAcc.length, MAX_INDICES_TOTAL);
  const indices = new Uint32Array(nIdx);
  for (let i = 0; i < nIdx; i++) indices[i] = idxAcc[i];
  flipNeversoftYForThree(positions, indices);

  return {
    positions,
    indices,
    modelCount: table.modelCount,
    previewPartIndex: bestIdx,
    multiPartCharacterPreview: true,
  };
}

/**
 * When this is not a level instancing pass (`mergeModelsViaObjects`), multiple models almost always means
 * separate parts — prefer one part; fall back to merging everything (rare single-file composites).
 * @param {DataView} dv
 * @param {number} tableOff
 * @param {number} fileLen
 */
function mergeAllModelsAtOriginWithPartHeuristic(dv, tableOff, fileLen, texAcc) {
  const table = readModelTablePtrs(dv, tableOff, fileLen);
  if (!table) return null;
  if (table.modelCount > 1) {
    const one = mergeLargestSinglePart(dv, tableOff, fileLen, table, texAcc);
    if (one) return one;
  }
  return mergeAllModelsAtOrigin(dv, tableOff, fileLen, texAcc);
}

/**
 * @param {DataView} dv
 * @param {number} tableOff
 * @param {number} fileLen
 */
function mergeAllModelsAtOrigin(dv, tableOff, fileLen, texAcc) {
  const table = readModelTablePtrs(dv, tableOff, fileLen);
  if (!table) return null;
  const { ptrs, modelCount } = table;

  /** @type {number[]} */
  const posAcc = [];
  /** @type {number[]} */
  const idxAcc = [];
  let vertBase = 0;

  for (let m = 0; m < modelCount; m++) {
    if (posAcc.length / 3 >= MAX_VERTS_TOTAL) break;
    const p = ptrs[m];
    if (p < 8 || p >= fileLen) continue;
    const added = extractOneModel(dv, p, fileLen, posAcc, idxAcc, vertBase, 0, 0, 0);
    if (added > 0) {
      vertBase += added;
      if (texAcc) appendModelTexTris(dv, p, fileLen, 0, 0, 0, texAcc);
    }
  }

  if (posAcc.length < 9 || idxAcc.length < 3) return null;

  const positions = new Float32Array(posAcc);
  const nIdx = Math.min(idxAcc.length, MAX_INDICES_TOTAL);
  const indices = new Uint32Array(nIdx);
  for (let i = 0; i < nIdx; i++) indices[i] = idxAcc[i];
  flipNeversoftYForThree(positions, indices);

  return { positions, indices, modelCount, multiPartCharacterPreview: false };
}

/**
 * Instances models using level object transforms (s7.24 origin per object).
 * @param {DataView} dv
 * @param {number} tableOff — offset of u32 model count
 * @param {number} fileLen
 * @param {number} firstObjOff — first object struct
 * @param {number} objCount
 */
function mergeModelsViaObjects(dv, tableOff, fileLen, firstObjOff, objCount, texAcc) {
  const table = readModelTablePtrs(dv, tableOff, fileLen);
  if (!table) return null;
  const { ptrs, modelCount } = table;

  /** @type {number[]} */
  const posAcc = [];
  /** @type {number[]} */
  const idxAcc = [];
  let vertBase = 0;

  for (let oi = 0; oi < objCount; oi++) {
    if (posAcc.length / 3 >= MAX_VERTS_TOTAL) break;
    const ob = firstObjOff + oi * OBJECT_STRIDE;
    const obj = readObject(dv, ob, fileLen);
    if (!obj) break;
    const { px, py, pz, modelIndex } = obj;
    if (modelIndex >= modelCount) continue;
    const p = ptrs[modelIndex];
    if (p < 8 || p >= fileLen) continue;
    const added = extractOneModel(dv, p, fileLen, posAcc, idxAcc, vertBase, px, py, pz);
    if (added > 0) {
      vertBase += added;
      if (texAcc) appendModelTexTris(dv, p, fileLen, px, py, pz, texAcc);
    }
  }

  if (posAcc.length < 9 || idxAcc.length < 3) return null;

  const positions = new Float32Array(posAcc);
  const nIdx = Math.min(idxAcc.length, MAX_INDICES_TOTAL);
  const indices = new Uint32Array(nIdx);
  for (let i = 0; i < nIdx; i++) indices[i] = idxAcc[i];
  flipNeversoftYForThree(positions, indices);

  return { positions, indices, modelCount, multiPartCharacterPreview: false };
}

/**
 * @param {DataView} dv
 * @param {number} fileLen
 * @param {number} chunkPtr
 * @param {Array<{ key: number, ax: number, ay: number, az: number, au: number, av: number, bx: number, by: number, bz: number, bu: number, bv: number, cx: number, cy: number, cz: number, cu: number, cv: number }>} texAcc
 * @param {object} base
 * @param {import("./psx-textures.js").PsxTextureSource | null} externalTextureSource
 */
function attachTexturesIfAny(dv, fileLen, chunkPtr, texAcc, base, externalTextureSource) {
  if (texAcc.length === 0 || chunkPtr < 8 || chunkPtr >= fileLen) return base;
  const embedded = parsePsxEmbeddedTextureSource(dv, chunkPtr, fileLen, base.modelCount);
  if (!embedded) return base;
  const embeddedBank = resolveTextureBankForModel(embedded.texhashList, embedded);
  const externalBank = embeddedBank
    ? null
    : resolveTextureBankForModel(embedded.texhashList, externalTextureSource);
  const texBank = embeddedBank || externalBank;
  if (!texBank) return base;
  flipTexturedTrisForThree(texAcc);
  const buf = buildTexturedMeshBuffers(texAcc, texBank);
  if (!buf) return base;
  return {
    ...base,
    textured: {
      positions: buf.positions,
      uvs: buf.uvs,
      indices: buf.indices,
      groups: buf.groups,
      materialKeys: buf.materialKeys,
      textureBank: texBank,
      textureSource: embeddedBank ? "embedded" : "external",
    },
  };
}

/**
 * @param {Uint8Array} bytes
 * @param {import("./psx-textures.js").PsxTextureSource | null} [externalTextureSource]
 * @returns {{ positions: Float32Array, indices: Uint32Array, modelCount: number, previewPartIndex?: number, multiPartCharacterPreview?: boolean, textured?: object } | null}
 */
export function parsePsxLevelGeometry(bytes, externalTextureSource = null) {
  if (bytes.length < 16) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileLen = bytes.length;

  if (dv.getUint16(0, true) !== 0x0004 || dv.getUint16(2, true) !== 0x0002) {
    return null;
  }

  const chunkPtr = dv.getUint32(4, true);
  if (chunkPtr !== 0 && (chunkPtr < 8 || chunkPtr >= fileLen)) {
    return null;
  }

  /** @type {Array<{ key: number, ax: number, ay: number, az: number, au: number, av: number, bx: number, by: number, bz: number, bu: number, bv: number, cx: number, cy: number, cz: number, cu: number, cv: number }>} */
  const texAcc = [];

  let o = 8;
  const objCount = dv.getUint32(o, true);
  o += 4;

  if (objCount > 0 && objCount <= MAX_OBJECTS && o + objCount * OBJECT_STRIDE + 4 <= fileLen) {
    const tableOff = o + objCount * OBJECT_STRIDE;
    texAcc.length = 0;
    const placed = mergeModelsViaObjects(dv, tableOff, fileLen, 8 + 4, objCount, texAcc);
    if (placed) return attachTexturesIfAny(dv, fileLen, chunkPtr, texAcc, placed, externalTextureSource);
  }

  if (objCount > 0 && objCount <= MAX_OBJECTS && o + objCount * OBJECT_STRIDE <= fileLen) {
    const tableOff = o + objCount * OBJECT_STRIDE;
    texAcc.length = 0;
    const merged = mergeAllModelsAtOriginWithPartHeuristic(dv, tableOff, fileLen, texAcc);
    if (merged) return attachTexturesIfAny(dv, fileLen, chunkPtr, texAcc, merged, externalTextureSource);
  }

  texAcc.length = 0;
  const fallback = mergeAllModelsAtOriginWithPartHeuristic(dv, 8, fileLen, texAcc);
  if (!fallback) return null;
  return attachTexturesIfAny(dv, fileLen, chunkPtr, texAcc, fallback, externalTextureSource);
}
