/**
 * Best-effort parser for Neversoft / THPS-style `.psx` mesh files.
 * Layout follows public notes: header, objects[], model table, model blobs (gist by iamgreaser).
 * Plain mesh: after merge, the preview basis reflects X and Y (a 180-degree model-space rotation),
 * with the same index order preserved.
 * Textured mesh: vertices and UVs are built in Neversoft space, then the **same** XY reflection runs
 * once on the buffer so 3D and decals stay in sync (see `attachTexturesIfAny`).
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

/** `localStorage` value `"1"` enables socket/plug character merge for multi-model `.psx` files. */
export const PSX_CHARACTER_ASSEMBLY_STORAGE_KEY = "pkr-explorer-psx-character-assembly";

const OBJECT_STRIDE = 36;
const PSX_WARN_ONCE = new Set();

/**
 * Final Neversoft-space preview basis: reflect X and Y (equivalent to a 180-degree model-space
 * rotation for preview purposes). This matches the orientation expected by current THPS props and
 * vehicles without needing any UV-space compensation.
 * @param {Float32Array} positions
 */
function reflectNeversoftForThree(positions) {
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = -positions[i];
    positions[i + 1] = -positions[i + 1];
  }
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
 * @param {Uint8Array | null} uv8 length 8 or null
 * @param {number} corner 0..3
 */
function uvBytePair(uv8, corner) {
  if (!uv8 || uv8.length < 8) {
    warnOnce(
      "psx-uv8-missing",
      "[psx-model] Face has no 8-byte UV payload (or buffer too short); sampling (0,0) — check face decode if textures show solid corner bleed."
    );
    return { u: 0, v: 0 };
  }
  if (corner < 0 || corner > 3) {
    warnOnce(
      "psx-uv-corner-bad",
      `[psx-model] UV corner ${corner} is not 0..3; using (0,0).`
    );
    return { u: 0, v: 0 };
  }
  const o = corner * 2;
  return { u: uv8[o], v: uv8[o + 1] };
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
 * @param {Map<number, { width: number, height: number, strideWidth?: number, rgba: Uint8ClampedArray }>} texByIndex
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
        // Face UV bytes are boundary coordinates, so normalize directly by the decoded texture size.
        // The preview transform is a model-space XY reflection, so UVs stay in source order.
        // Preserve the top-origin V convention paired with flipY=false.
        const w = Math.max(1, td.width);
        const h = Math.max(1, td.height);
        uf = ub / w;
        vf = vb / h;
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
 * Parse one model's vertices. pad=0 / pad=1: s3.12 (ix,iy,iz).
 * pad=2: either (a) **plug** for multi-part character assembly — iy is socket ordinal, ix/iz only as offsets;
 * or (b) **legacy weld** within one model (recursive index iy) for levels / props when `resolvePad2AsPlug` is false.
 * @param {DataView} dv
 * @param {number} ptr
 * @param {number} fileLen
 * @param {number} tx
 * @param {number} ty
 * @param {number} tz
 * @param {boolean} [resolvePad2AsPlug]
 */
function buildResolvedModelPositions(dv, ptr, fileLen, tx, ty, tz, resolvePad2AsPlug = false) {
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
  function resolvedXYZWeld(ri, depth) {
    if (depth > 64) return { x: 0, y: 0, z: 0 };
    const v = rawV[ri];
    if (v.pad !== 2) {
      return { x: s312(v.ix), y: s312(v.iy), z: s312(v.iz) };
    }
    const j = v.iy;
    if (j >= 0 && j < rawV.length && j !== ri) return resolvedXYZWeld(j, depth + 1);
    warnOnce(
      "psx-cross-model-weld",
      "[psx-model] pad==2 weld fallback: iy out of range or self-ref; using raw ix,iy,iz as s3.12."
    );
    return { x: s312(v.ix), y: s312(v.iy), z: s312(v.iz) };
  }

  /** @type {number[]} */
  const nextPos = [];
  for (let i = 0; i < nv; i++) {
    const v = rawV[i];
    let x;
    let y;
    let z;
    if (resolvePad2AsPlug && v.pad === 2) {
      x = s312(v.ix);
      y = 0;
      z = s312(v.iz);
    } else if (!resolvePad2AsPlug && v.pad === 2) {
      const p = resolvedXYZWeld(i, 0);
      x = p.x;
      y = p.y;
      z = p.z;
    } else {
      x = s312(v.ix);
      y = s312(v.iy);
      z = s312(v.iz);
    }
    nextPos.push(x + tx, y + ty, z + tz);
  }

  return { modelUnknown, nv, np, nf, faceOff: pEnd, nextPos };
}

/**
 * @param {{ key: number, ax: number, ay: number, az: number, au: number, av: number, bx: number, by: number, bz: number, bu: number, bv: number, cx: number, cy: number, cz: number, cu: number, cv: number }[]} acc
 */
function appendModelTexTris(dv, ptr, fileLen, tx, ty, tz, acc, resolvePad2AsPlug = false) {
  if (ptr < 0 || ptr + 28 > fileLen || acc.length >= MAX_TEX_TRIS) return -1;
  const model = buildResolvedModelPositions(dv, ptr, fileLen, tx, ty, tz, resolvePad2AsPlug);
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
function extractOneModel(dv, ptr, fileLen, positions, indices, vertBase, tx, ty, tz, resolvePad2AsPlug = false) {
  const model = buildResolvedModelPositions(dv, ptr, fileLen, tx, ty, tz, resolvePad2AsPlug);
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
 * True when `ptr` points at a model blob that passes the same checks as mesh extraction
 * (many skater table slots are placeholders — u32 0, garbage offset, or nv/nf nonsense).
 * @param {DataView} dv
 * @param {number} ptr
 * @param {number} fileLen
 */
export function isSaneModelBlob(dv, ptr, fileLen) {
  if (ptr < 8 || ptr + 28 > fileLen) return false;
  const nv = dv.getUint16(ptr + 2, true);
  const np = dv.getUint16(ptr + 4, true);
  const nf = dv.getUint16(ptr + 6, true);
  if (nv === 0 || nv > 20000 || np > 20000 || nf > 50000 || nf === 0) return false;
  let o = ptr + 28;
  const vEnd = o + nv * 8;
  const pEnd = vEnd + np * 8;
  if (pEnd > fileLen) return false;
  return true;
}

/**
 * Byte offset immediately after the last face record of a model blob, or -1 if not parseable.
 * @param {DataView} dv
 * @param {number} ptr
 * @param {number} fileLen
 */
export function getModelBlobEndOffset(dv, ptr, fileLen) {
  if (ptr < 8 || ptr + 28 > fileLen) return -1;
  const modelUnknown = dv.getUint16(ptr, true);
  const nv = dv.getUint16(ptr + 2, true);
  const np = dv.getUint16(ptr + 4, true);
  const nf = dv.getUint16(ptr + 6, true);
  if (nv > 20000 || np > 20000 || nf > 50000 || nv === 0 || nf === 0) return -1;
  let o = ptr + 28 + nv * 8 + np * 8;
  if (o > fileLen) return -1;
  let facesParsed = 0;
  while (facesParsed < nf && o + 8 <= fileLen) {
    const f = readPsxFaceRecord(dv, o, nv, modelUnknown, fileLen);
    if (!f) break;
    o += f.flen;
    facesParsed++;
  }
  return o;
}

/**
 * Count model pointers that at least cover a model header in-file (layout heuristic; not mesh sanity).
 * @param {{ ptrs: number[], modelCount: number } | null} table
 * @param {number} fileLen
 */
function countInBoundsModelPtrs(table, fileLen) {
  if (!table) return 0;
  let n = 0;
  for (const p of table.ptrs) {
    if (p >= 8 && p + 28 <= fileLen) n++;
  }
  return n;
}

/**
 * Pick model table offset the same way the main parser effectively does: compare character layout
 * (modelCount @8, ptrs @0xC) vs level layout (objCount @8, table after objects). Chooses the candidate
 * with more in-bounds pointers so skaters are not misread as “19 objects + table in the weeds”.
 * @param {DataView} dv
 * @param {number} fileLen
 * @returns {{ table: { ptrs: number[], modelCount: number }, tableOff: number, validPtrs: number, layoutDesc: string } | null}
 */
export function resolveModelTableForDiagnostics(dv, fileLen) {
  /** @type {{ table: { ptrs: number[], modelCount: number }; tableOff: number; validPtrs: number; layoutDesc: string } | null} */
  let best = null;

  const tChar = readModelTablePtrs(dv, 8, fileLen);
  if (tChar) {
    const v = countInBoundsModelPtrs(tChar, fileLen);
    best = {
      table: tChar,
      tableOff: 8,
      validPtrs: v,
      layoutDesc: `character-style (modelCount @0x8=${tChar.modelCount}, ptrs @0xC)`,
    };
  }

  const objCount = dv.getUint32(8, true);
  if (
    objCount > 0 &&
    objCount <= MAX_OBJECTS &&
    12 + objCount * OBJECT_STRIDE + 4 <= fileLen
  ) {
    const offLv = 12 + objCount * OBJECT_STRIDE;
    const tLv = readModelTablePtrs(dv, offLv, fileLen);
    if (tLv) {
      const v = countInBoundsModelPtrs(tLv, fileLen);
      if (!best || v > best.validPtrs) {
        best = {
          table: tLv,
          tableOff: offLv,
          validPtrs: v,
          layoutDesc: `level-style (objCount @0x8=${objCount}, model table @0x${offLv.toString(16)})`,
        };
      }
    }
  }

  return best;
}

/**
 * Stage 1 diagnostic: per-model pad=1 (socket) / pad=2 (plug) report for skater-style multi-model `.psx`.
 * Call from devtools after loading bytes, e.g. `console.log(dumpPsxCharacterPadDiagnostics(bytes))`.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function dumpPsxCharacterPadDiagnostics(bytes) {
  if (bytes.length < 12) return "(file too small)";
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileLen = bytes.length;
  const lines = [];

  const nHex = Math.min(32, fileLen);
  const hexChunks = [];
  for (let i = 0; i < nHex; i += 4) {
    const w = dv.getUint32(i, true);
    hexChunks.push(`${i.toString(16).padStart(2, "0")}:${w.toString(16).padStart(8, "0")}`);
  }
  lines.push(`header[0..${nHex - 1}] (little-endian u32): ${hexChunks.join(" | ")}`);

  const m0 = dv.getUint16(0, true);
  const m2 = dv.getUint16(2, true);
  const chunkPtr = dv.getUint32(4, true);
  const u32at8 = dv.getUint32(8, true);
  const u32atC = fileLen >= 16 ? dv.getUint32(12, true) : 0;
  lines.push(
    `decode: H@0=0x${m0.toString(16)} H@2=0x${m2.toString(16)} (expect 0x0004 0x0002) chunkPtr=0x${chunkPtr.toString(
      16
    )} u32@0x8=${u32at8} u32@0xC=0x${u32atC.toString(16)} — skater: @8=modelCount @C=ptr[0]; level: @8=objCount @C=obj0…`
  );

  const resolved = resolveModelTableForDiagnostics(dv, fileLen);
  if (!resolved) {
    lines.push("(no readable model table at 0x8 or after objects)");
    return lines.join("\n");
  }
  const { table, tableOff, validPtrs, layoutDesc } = resolved;
  lines.push(
    `model_table_off=0x${tableOff.toString(16)} — ${layoutDesc}; in-bounds ptrs=${validPtrs}/${table.modelCount}`
  );

  const globalRunning = { n: 0 };
  for (let m = 0; m < table.modelCount; m++) {
    const ptr = table.ptrs[m];
    if (!isSaneModelBlob(dv, ptr, fileLen)) {
      lines.push(`model[${m}] (no mesh — bad ptr, nv/nf, or truncated blob)`);
      continue;
    }
    const nv = dv.getUint16(ptr + 2, true);
    const nf = dv.getUint16(ptr + 6, true);
    let pad1 = 0;
    let pad2 = 0;
    let o = ptr + 28;
    const pad1Lines = [];
    const pad2Lines = [];
    for (let i = 0; i < nv; i++) {
      if (o + 8 > fileLen) break;
      const ix = dv.getInt16(o, true);
      const iy = dv.getInt16(o + 2, true);
      const iz = dv.getInt16(o + 4, true);
      const pad = dv.getInt16(o + 6, true);
      o += 8;
      if (pad === 1) {
        pad1++;
        const ord = globalRunning.n++;
        const idU = (iy & 0xffff) >>> 0;
        pad1Lines.push(
          `  pad1 vert ${i}: bind_key=${ord} (pad2 plug iy matches this ordinal) iy_u16=${idU} raw(ix,iy,iz)=(${ix},${iy},${iz}) pos s3.12=( ${s312(ix).toFixed(2)}, ${s312(iy).toFixed(2)}, ${s312(iz).toFixed(2)})`
        );
      } else if (pad === 2) {
        pad2++;
        {
          const keyU = (iy & 0xffff) >>> 0;
          pad2Lines.push(
            `  pad2 vert ${i}: plug_key=${keyU} → pad1 ordinal ${keyU} if present raw(ix,iy,iz)=(${ix},${iy},${iz}) offsets s3.12=( ${s312(ix).toFixed(2)}, —, ${s312(iz).toFixed(2)})`
          );
        }
      }
    }
    lines.push(`model[${m}] nv=${nv} nf=${nf}  pad1_count=${pad1}  pad2_count=${pad2}`);
    lines.push(...pad1Lines, ...pad2Lines);
  }
  lines.push(
    `global pad1 count (ordinals 0…${globalRunning.n > 0 ? globalRunning.n - 1 : "—"}): ${globalRunning.n} — assembly resolves plug iy as a global pad=1 ordinal in model-file order`
  );
  return lines.join("\n");
}

/**
 * @param {DataView} dv
 * @param {number} fileLen
 * @param {number[]} ptrs
 * @param {number} modelCount
 * @returns {{
 *   globalSockets: { modelIdx: number, vertIdx: number, lx: number, ly: number, lz: number, ordinal: number }[],
 *   modelPlugs: { key: number, lx: number, ly: number, lz: number }[][],
 * } | null}
 */
function buildCharacterSocketPlugTables(dv, fileLen, ptrs, modelCount) {
  /** @type { { modelIdx: number, vertIdx: number, lx: number, ly: number, lz: number, ordinal: number }[] } */
  const globalSockets = [];
  /** @type { { key: number, lx: number, ly: number, lz: number }[][] } */
  const modelPlugs = Array.from({ length: modelCount }, () => []);

  for (let m = 0; m < modelCount; m++) {
    const ptr = ptrs[m];
    if (!isSaneModelBlob(dv, ptr, fileLen)) continue;
    const nv = dv.getUint16(ptr + 2, true);
    let o = ptr + 28;
    for (let i = 0; i < nv; i++) {
      if (o + 8 > fileLen) break;
      const ix = dv.getInt16(o, true);
      const iy = dv.getInt16(o + 2, true);
      const iz = dv.getInt16(o + 4, true);
      const pad = dv.getInt16(o + 6, true);
      o += 8;
      if (pad === 1) {
        const ordinal = globalSockets.length;
        globalSockets.push({
          modelIdx: m,
          vertIdx: i,
          lx: s312(ix),
          ly: s312(iy),
          lz: s312(iz),
          ordinal,
        });
      } else if (pad === 2) {
        modelPlugs[m].push({
          key: (iy & 0xffff) >>> 0,
          lx: s312(ix),
          ly: 0,
          lz: s312(iz),
        });
      }
    }
  }

  if (globalSockets.length === 0) return null;
  return { globalSockets, modelPlugs };
}

/**
 * @param {{ modelIdx: number, lx: number, ly: number, lz: number, ordinal: number }[]} globalSockets
 * @param {{ x: number, y: number, z: number }[]} socketWorldByOrdinal
 * @param {number} m
 * @param {{ x: number, y: number, z: number }} T
 */
function registerSocketWorldsForModel(globalSockets, socketWorldByOrdinal, m, T) {
  for (const s of globalSockets) {
    if (s.modelIdx !== m) continue;
    const w = { x: T.x + s.lx, y: T.y + s.ly, z: T.z + s.lz };
    socketWorldByOrdinal[s.ordinal] = w;
  }
}

/**
 * pad=2 plug `iy` is the global index of a pad=1 socket in model-file order (ordinal).
 * @param {number} plugKey
 * @param {({ x: number, y: number, z: number } | undefined)[]} byOrd — pad1 positions by ordinal
 */
function resolveSocketWorldForPlug(plugKey, byOrd) {
  if (plugKey < byOrd.length) {
    const o = byOrd[plugKey];
    if (o !== undefined) return o;
  }
  return undefined;
}

/**
 * Multi-model character bind pose: pad=2 plug `iy` indexes pad=1 sockets by **global ordinal** (pad1 count in file order).
 * Empty table slots (no mesh) are ignored.
 * Math in Neversoft space; the final preview reflection runs after merge.
 * @param {DataView} dv
 * @param {number} tableOff
 * @param {number} fileLen
 * @param {{ ptrs: number[], modelCount: number }} table
 * @param {Array<{ key: number, ax: number, ay: number, az: number, au: number, av: number, bx: number, by: number, bz: number, bu: number, bv: number, cx: number, cy: number, cz: number, cu: number, cv: number }>} texAcc
 */
function tryMergeCharacterAssembled(dv, tableOff, fileLen, table, texAcc) {
  const { ptrs, modelCount } = table;
  if (modelCount <= 1) return null;

  try {
    if (localStorage.getItem(PSX_CHARACTER_ASSEMBLY_STORAGE_KEY) !== "1") return null;
  } catch {
    return null;
  }

  /** @type {number[]} */
  const saneIndices = [];
  for (let m = 0; m < modelCount; m++) {
    if (isSaneModelBlob(dv, ptrs[m], fileLen)) saneIndices.push(m);
  }
  if (saneIndices.length === 0) return null;

  const sp = buildCharacterSocketPlugTables(dv, fileLen, ptrs, modelCount);
  if (!sp) return null;

  const { globalSockets, modelPlugs } = sp;
  const nSock = globalSockets.length;

  /** @type {Set<number>} */
  const mustPlace = new Set(saneIndices);

  let root = -1;
  for (let m = 0; m < modelCount; m++) {
    if (!mustPlace.has(m)) continue;
    if (modelPlugs[m].length === 0) {
      root = m;
      break;
    }
  }
  if (root < 0) {
    root = saneIndices[0];
  }

  /** @type {{ x: number, y: number, z: number }[]} */
  const T = Array.from({ length: modelCount }, () => ({ x: 0, y: 0, z: 0 }));
  const placed = new Set([root]);
  T[root] = { x: 0, y: 0, z: 0 };

  /** @type {({ x: number, y: number, z: number } | undefined)[]} */
  const socketWorldByOrdinal = Array.from({ length: nSock }, () => undefined);

  registerSocketWorldsForModel(globalSockets, socketWorldByOrdinal, root, T[root]);

  for (let iter = 0; iter < modelCount; iter++) {
    let progress = false;
    for (let m = 0; m < modelCount; m++) {
      if (placed.has(m)) continue;
      if (!mustPlace.has(m)) continue;
      const plugs = modelPlugs[m];
      if (plugs.length === 0) {
        continue;
      }
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let matched = 0;
      for (const pl of plugs) {
        const sw = resolveSocketWorldForPlug(pl.key, socketWorldByOrdinal);
        if (!sw) continue;
        sx += sw.x - pl.lx;
        sy += sw.y - pl.ly;
        sz += sw.z - pl.lz;
        matched++;
      }
      if (matched === 0) continue;
      T[m] = { x: sx / matched, y: sy / matched, z: sz / matched };
      placed.add(m);
      registerSocketWorldsForModel(globalSockets, socketWorldByOrdinal, m, T[m]);
      progress = true;
    }
    if (!progress) break;
  }

  for (const m of mustPlace) {
    if (!placed.has(m)) {
      warnOnce(
        "psx-character-assembly-incomplete",
        `[psx-model] Character assembly placed ${placed.size}/${mustPlace.size} mesh part(s) — some plug ordinals did not resolve to earlier pad=1 sockets; falling back to largest-part preview.`
      );
      return null;
    }
  }

  /** @type {number[]} */
  const posAcc = [];
  /** @type {number[]} */
  const idxAcc = [];
  let vertBase = 0;

  for (let m = 0; m < modelCount; m++) {
    if (posAcc.length / 3 >= MAX_VERTS_TOTAL) break;
    if (!mustPlace.has(m)) continue;
    const p = ptrs[m];
    const tr = T[m];
    const added = extractOneModel(dv, p, fileLen, posAcc, idxAcc, vertBase, tr.x, tr.y, tr.z, true);
    if (added > 0) {
      vertBase += added;
      if (texAcc) appendModelTexTris(dv, p, fileLen, tr.x, tr.y, tr.z, texAcc, true);
    }
  }

  if (posAcc.length < 9 || idxAcc.length < 3) return null;

  const positions = new Float32Array(posAcc);
  const nIdx = Math.min(idxAcc.length, MAX_INDICES_TOTAL);
  const indices = new Uint32Array(nIdx);
  for (let i = 0; i < nIdx; i++) indices[i] = idxAcc[i];
  reflectNeversoftForThree(positions);

  return {
    positions,
    indices,
    modelCount,
    multiPartCharacterPreview: false,
    characterAssembly: true,
    assemblyRootModelIndex: root,
  };
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
  reflectNeversoftForThree(positions);

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
    const assembled = tryMergeCharacterAssembled(dv, tableOff, fileLen, table, texAcc);
    if (assembled) return assembled;
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
  reflectNeversoftForThree(positions);

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
  reflectNeversoftForThree(positions);

  return { positions, indices, modelCount, multiPartCharacterPreview: false };
}

/**
 * Character files sometimes carry an object table whose transforms are all identity placeholders.
 * In that case the object-instancing path collapses every part to the origin, so prefer socket/plug assembly.
 * @param {DataView} dv
 * @param {number} fileLen
 * @param {number} firstObjOff
 * @param {number} objCount
 */
function hasOnlyIdentityObjectPlacements(dv, fileLen, firstObjOff, objCount) {
  let sawAny = false;
  for (let oi = 0; oi < objCount; oi++) {
    const ob = firstObjOff + oi * OBJECT_STRIDE;
    const obj = readObject(dv, ob, fileLen);
    if (!obj) return false;
    sawAny = true;
    if (obj.px !== 0 || obj.py !== 0 || obj.pz !== 0) return false;
  }
  return sawAny;
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
  const buf = buildTexturedMeshBuffers(texAcc, texBank);
  if (!buf) return base;
  // Same final reflection as plain mesh, applied once after UV bake so textures stay aligned with geometry.
  reflectNeversoftForThree(buf.positions);
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
 * One model blob from the mesh table at origin (for per-part 3D preview toggles).
 * @param {DataView} dv
 * @param {number} fileLen
 * @param {number} chunkPtr
 * @param {number} ptr
 * @param {number} modelCountForTextureChunk — same as full file `modelCount` for embedded texture chunk layout
 * @param {import("./psx-textures.js").PsxTextureSource | null} externalTextureSource
 */
function extractPerModelPartForPreview(dv, fileLen, chunkPtr, ptr, modelCountForTextureChunk, externalTextureSource) {
  const texAcc = [];
  appendModelTexTris(dv, ptr, fileLen, 0, 0, 0, texAcc);
  const posAcc = [];
  const idxAcc = [];
  const added = extractOneModel(dv, ptr, fileLen, posAcc, idxAcc, 0, 0, 0, 0);
  if (added <= 0 || posAcc.length < 9) return null;
  const positions = new Float32Array(posAcc);
  const nIdx = Math.min(idxAcc.length, MAX_INDICES_TOTAL);
  const indices = new Uint32Array(nIdx);
  for (let i = 0; i < nIdx; i++) indices[i] = idxAcc[i];
  reflectNeversoftForThree(positions);
  const base = { positions, indices, modelCount: modelCountForTextureChunk };
  return attachTexturesIfAny(dv, fileLen, chunkPtr, texAcc, base, externalTextureSource);
}

/**
 * @param {DataView} dv
 * @param {number} fileLen
 * @param {number} expectedCount
 * @returns {{ ptrs: number[], modelCount: number } | null}
 */
function pickModelTableMatchingCount(dv, fileLen, expectedCount) {
  const resolved = resolveModelTableForDiagnostics(dv, fileLen);
  if (resolved && resolved.table.modelCount === expectedCount) return resolved.table;
  const tChar = readModelTablePtrs(dv, 8, fileLen);
  if (tChar && tChar.modelCount === expectedCount) return tChar;
  return null;
}

/**
 * Per-model mesh data (same shape as `parsePsxLevelGeometry` for one part), or `null` if that slot has no mesh.
 * @param {Uint8Array} bytes
 * @param {import("./psx-textures.js").PsxTextureSource | null} externalTextureSource
 * @param {{ modelCount: number }} parsed — result of `parsePsxLevelGeometry`
 * @returns {Array<ReturnType<typeof parsePsxLevelGeometry> | null> | null}
 */
export function parsePsxPerPartPreviewData(bytes, externalTextureSource, parsed) {
  if (!parsed || parsed.modelCount <= 1) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileLen = bytes.length;
  const chunkPtr = dv.getUint32(4, true);
  const table = pickModelTableMatchingCount(dv, fileLen, parsed.modelCount);
  if (!table) return null;
  const { ptrs, modelCount } = table;
  /** @type {Array<ReturnType<typeof parsePsxLevelGeometry> | null>} */
  const parts = [];
  for (let m = 0; m < modelCount; m++) {
    const p = ptrs[m];
    if (p < 8 || p + 28 > fileLen) {
      parts.push(null);
      continue;
    }
    parts.push(extractPerModelPartForPreview(dv, fileLen, chunkPtr, p, parsed.modelCount, externalTextureSource));
  }
  return parts;
}

/**
 * @param {Uint8Array} bytes
 * @param {import("./psx-textures.js").PsxTextureSource | null} [externalTextureSource]
 * @returns {{ positions: Float32Array, indices: Uint32Array, modelCount: number, previewPartIndex?: number, multiPartCharacterPreview?: boolean, characterAssembly?: boolean, assemblyRootModelIndex?: number, textured?: object } | null}
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

  const objTableLooksIdentity =
    objCount > 0 &&
    objCount <= MAX_OBJECTS &&
    o + objCount * OBJECT_STRIDE <= fileLen &&
    hasOnlyIdentityObjectPlacements(dv, fileLen, 8 + 4, objCount);

  if (
    objCount > 0 &&
    objCount <= MAX_OBJECTS &&
    o + objCount * OBJECT_STRIDE + 4 <= fileLen &&
    !objTableLooksIdentity
  ) {
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
