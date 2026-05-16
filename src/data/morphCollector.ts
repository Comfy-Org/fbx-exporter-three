/**
 * Detect morph targets on a three.js Mesh and build the FBX-side BlendShape
 * plan: one `BlendShape` Deformer per mesh, one `BlendShapeChannel`
 * SubDeformer per morph target, one `Geometry (Shape)` per channel.
 *
 * Mirrors `export_fbx_bin.py: fbx_data_mesh_shapes_elements`
 * (lines 765-845) and the connections at lines 3092-3100.
 *
 * Three.js stores morphs as `geometry.morphAttributes.position` (an array of
 * BufferAttributes, one per channel). `geometry.morphTargetsRelative` flags
 * whether they are deltas (true, common) or absolute positions (false).
 * FBX requires delta values; we convert if needed.
 *
 * `mesh.morphTargetDictionary` (set by GLTFLoader or manually) maps channel
 * name → index. We use these names as the BlendShapeChannel / Shape names so
 * that morph animations can later resolve `Mesh.morphTargetInfluences[N]`
 * tracks back to the right channel.
 */

import {
  blendShapeDeformerKey, blendShapeChannelKey, shapeGeometryKey,
} from '../core/uid.js';
import { geometryTemplate, deformerTemplate } from '../core/templates.js';

/**
 * @param {object} ctx
 * @param {Mesh}    ctx.mesh
 * @param {UidRegistry}    ctx.uids
 * @param {TemplateBundle} ctx.templates
 * @returns {?object} morphPlan or null if the mesh has no morphs
 */
export function collectMorph({ mesh, uids, templates }) {
  const geom = mesh.geometry;
  const morphPos = geom.morphAttributes && geom.morphAttributes.position;
  if (!morphPos || morphPos.length === 0) return null;

  const base = geom.attributes.position;
  if (!base) return null;
  const relative = geom.morphTargetsRelative === true;

  const blendShapeUid = uids.get(blendShapeDeformerKey(geom.uuid));
  templates.register(deformerTemplate({})).users += 1;  // BlendShape Deformer

  // Resolve "channel index → channel name". The dictionary may be sparse;
  // when an index is missing, use a numeric fallback so the file stays valid.
  const dict = mesh.morphTargetDictionary;
  const nameByIndex = new Array(morphPos.length);
  if (dict) {
    for (const [k, v] of Object.entries(dict) as [string, number][]) nameByIndex[v] = k;
  }
  for (let i = 0; i < morphPos.length; i++) {
    if (!nameByIndex[i]) nameByIndex[i] = `morph_${i}`;
  }

  const channels = [];
  const baseFlat = readBaseFlat(base);
  const numVerts = base.count;
  const influences = mesh.morphTargetInfluences;

  for (let i = 0; i < morphPos.length; i++) {
    const attr = morphPos[i];
    const name = nameByIndex[i];
    const channelUid = uids.get(blendShapeChannelKey(geom.uuid, i, name));
    const shapeGeomUid = uids.get(shapeGeometryKey(geom.uuid, i, name));
    templates.register(deformerTemplate({})).users += 1;  // BlendShapeChannel SubDeformer
    templates.register(geometryTemplate({})).users += 1;  // Geometry (Shape)

    // Build dense delta array (numVerts × 3 Float64).
    const deltas = computeDeltas(attr, baseFlat, numVerts, relative);
    // Indexes: which base verts the deltas apply to. We emit all verts
    // (dense) — Blender uses sparse storage for memory but FBXLoader handles
    // dense correctly (FBXLoader.js:2408-2415).
    const indices = new Int32Array(numVerts);
    for (let v = 0; v < numVerts; v++) indices[v] = v;

    // Current influence as DeformPercent (Blender: shape.value × 100,
    // export_fbx_bin.py:839). three.js stores influences 0..1 on the mesh.
    // Maya / Unreal use this as the static morph state at import time;
    // three.js FBXLoader does not (it leaves influences at 0).
    const influence = (Array.isArray(influences) && i < influences.length)
      ? influences[i]
      : 0;
    const deformPercent = influence * 100;

    channels.push({
      index: i,
      name,
      channelUid,
      shapeGeomUid,
      deltas,
      indices,
      deformPercent,
    });
  }

  return {
    mesh,
    geometry: geom,
    blendShapeUid,
    channels,
  };
}

/**
 * Read the base position attribute into a flat Float32Array. Uses getX/Y/Z
 * to handle Interleaved + normalized attributes (matches geometry.js).
 */
function readBaseFlat(attr) {
  const n = attr.count;
  const out = new Float32Array(n * 3);
  if (attr.isInterleavedBufferAttribute || attr.normalized) {
    for (let i = 0; i < n; i++) {
      out[i * 3]     = attr.getX(i);
      out[i * 3 + 1] = attr.getY(i);
      out[i * 3 + 2] = attr.getZ(i);
    }
  } else {
    out.set(attr.array.subarray(0, n * 3));
  }
  return out;
}

/**
 * Compute per-vertex delta values (morph - base, or just morph if already
 * stored as deltas).
 *
 * three.js morph rendering uses the formula:
 *   v_final = v_base + Σ(weight × morphAttr[i])      when morphTargetsRelative === true
 *   v_final = v_base + Σ(weight × (morphAttr[i] - v_base))  when relative === false
 *
 * FBX always expects deltas in the shape's Vertices array (FBXLoader.js:2408
 * does `morphPositions[idx] = morphPositionsSparse[i]` then renders with
 * morphTargetsRelative = true), so we normalise both inputs to deltas.
 */
function computeDeltas(morphAttr, baseFlat, n, relative) {
  const out = new Float64Array(n * 3);
  const isAccessor = morphAttr.isInterleavedBufferAttribute || morphAttr.normalized;
  if (relative) {
    if (isAccessor) {
      for (let i = 0; i < n; i++) {
        out[i * 3]     = morphAttr.getX(i);
        out[i * 3 + 1] = morphAttr.getY(i);
        out[i * 3 + 2] = morphAttr.getZ(i);
      }
    } else {
      const src = morphAttr.array;
      for (let k = 0; k < n * 3; k++) out[k] = src[k];
    }
  } else {
    // absolute positions — subtract base.
    if (isAccessor) {
      for (let i = 0; i < n; i++) {
        out[i * 3]     = morphAttr.getX(i) - baseFlat[i * 3];
        out[i * 3 + 1] = morphAttr.getY(i) - baseFlat[i * 3 + 1];
        out[i * 3 + 2] = morphAttr.getZ(i) - baseFlat[i * 3 + 2];
      }
    } else {
      const src = morphAttr.array;
      for (let i = 0; i < n; i++) {
        out[i * 3]     = src[i * 3]     - baseFlat[i * 3];
        out[i * 3 + 1] = src[i * 3 + 1] - baseFlat[i * 3 + 1];
        out[i * 3 + 2] = src[i * 3 + 2] - baseFlat[i * 3 + 2];
      }
    }
  }
  return out;
}
