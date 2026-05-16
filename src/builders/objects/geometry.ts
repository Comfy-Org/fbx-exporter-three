/**
 * BufferGeometry → FBX `Geometry` node.
 *
 * Mirrors `export_fbx_bin.py: fbx_data_mesh_elements` (lines 848-1582) but
 * specialised for three.js geometry, which:
 *   - is always tessellated as triangles (no n-gons),
 *   - stores attributes in flat typed arrays,
 *   - optionally has an index buffer; without one, position is per-vertex
 *     in draw order.
 *
 * The output layout matches three.js FBXLoader (genGeometry / parseGeoNode):
 *   - Vertices            float64[]
 *   - PolygonVertexIndex  int32[]  (every 3rd index XOR -1 → face terminator)
 *   - Edges               int32[]  (loop indices, empty for our case is fine)
 *   - GeometryVersion     124
 *   - LayerElementNormal     ByPolygonVertex / IndexToDirect
 *   - LayerElementUV[]       ByPolygonVertex / IndexToDirect (uv, uv1, uv2, uv3)
 *   - LayerElementColor      ByPolygonVertex / IndexToDirect
 *   - LayerElementMaterial   AllSame / IndexToDirect (single material) or
 *                            ByPolygon / IndexToDirect (multi-material via groups)
 *   - Layer                  TOC referencing the elements above
 */

import {
  elemEmpty,
  elemDataSingleInt32, elemDataSingleString,
  elemDataSingleInt32Array, elemDataSingleFloat64Array,
  elemProperties, fbxNameClass,
} from '../../core/elemHelpers.js';
import { templateInit, templateFinalize } from '../../core/elemHelpers.js';
import {
  FBX_GEOMETRY_VERSION,
  FBX_GEOMETRY_NORMAL_VERSION,
  FBX_GEOMETRY_UV_VERSION,
  FBX_GEOMETRY_VCOLOR_VERSION,
  FBX_GEOMETRY_MATERIAL_VERSION,
  FBX_GEOMETRY_LAYER_VERSION,
} from '../../constants.js';
import { bakeVertices, bakeNormals } from '../../data/transforms.js';

/**
 * Read a vertex attribute as a flat Float32Array of length `count * itemSize`.
 *
 * Three paths:
 *   - Plain BufferAttribute with `normalized === false` → fastest, `.array`
 *     is usable directly (we still return it without copying for read-only
 *     downstream consumers; callers copy to Float64 before mutating).
 *   - Plain BufferAttribute with `normalized === true` (e.g. Uint8 vertex
 *     colors packed 0..255) → use `getX/Y/Z/W` which applies the proper
 *     denormalize (BufferAttribute.js:389-405, math/MathUtils.denormalize).
 *   - InterleavedBufferAttribute (`.array` doesn't exist; data lives on
 *     `.data` with an offset) → `getX/Y/Z/W` is the only correct accessor.
 */
function readAttributeFlat(attr, itemSize = attr.itemSize) {
  const needsAccessor = attr.isInterleavedBufferAttribute || attr.normalized === true;
  if (!needsAccessor) {
    // Plain BufferAttribute, non-normalized: `.array` is count*itemSize long.
    return attr.array;
  }
  const count = attr.count;
  const out = new Float32Array(count * itemSize);
  for (let i = 0; i < count; i++) {
    const base = i * itemSize;
    if (itemSize >= 1) out[base]     = attr.getX(i);
    if (itemSize >= 2) out[base + 1] = attr.getY(i);
    if (itemSize >= 3) out[base + 2] = attr.getZ(i);
    if (itemSize >= 4) out[base + 3] = attr.getW(i);
  }
  return out;
}

/**
 * Build a flat array of vertex indices in draw order from a BufferGeometry.
 *
 * Three.js stores either:
 *   - indexed geometry (geometry.index is non-null) → use index.array directly,
 *   - non-indexed geometry → indices are [0, 1, 2, 3, ...].
 *
 * The returned array has one entry per "loop" (corner). It is in groups of 3
 * because three.js draws triangles.
 */
function loopVertexIndices(geometry) {
  if (geometry.index) {
    return Int32Array.from(geometry.index.array);
  }
  const n = geometry.attributes.position.count;
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

/**
 * For a triangle list, return the per-polygon loop_start array:
 *   [0, 3, 6, ...] of length (numLoops / 3).
 * Matches Blender's t_ls.
 */
function polygonLoopStarts(numLoops) {
  const polys = numLoops / 3;
  if (!Number.isInteger(polys)) {
    throw new Error(`Loop count ${numLoops} is not a multiple of 3 — non-triangular geometry not supported`);
  }
  const t_ls = new Int32Array(polys);
  for (let i = 0; i < polys; i++) t_ls[i] = i * 3;
  return t_ls;
}

/**
 * Apply Blender's face-terminator sign-flip: XOR -1 on the last loop index of
 * every face. (export_fbx_bin.py:1031-1033). For triangles that means every
 * 3rd element (index 2, 5, 8, ...) gets `^= -1`.
 */
function applyFaceTerminator(t_pvi, t_ls) {
  // Indices at the end of each loop. Last entry is always the very last index.
  // (Blender: t_pvi[t_ls[1:] - 1] ^= -1; t_pvi[-1] ^= -1.)
  for (let i = 1; i < t_ls.length; i++) {
    t_pvi[t_ls[i] - 1] ^= -1;
  }
  t_pvi[t_pvi.length - 1] ^= -1;
}

/**
 * "Expand" a per-vertex (indexed) attribute to a per-loop (corner) array.
 * If the geometry is non-indexed, the attribute is already per-loop and we
 * just return it as a flat Float32Array.
 *
 * Handles both BufferAttribute (plain `.array`) and InterleavedBufferAttribute
 * (must be read via getX/Y/Z/W).
 */
function attributeToPerLoop(geometry, attr, itemSize) {
  const numLoops = geometry.index ? geometry.index.count : geometry.attributes.position.count;
  const src = readAttributeFlat(attr, itemSize);

  if (!geometry.index) return src;

  const out = new Float32Array(numLoops * itemSize);
  const idx = geometry.index.array;
  for (let i = 0; i < numLoops; i++) {
    const v = idx[i];
    const base = v * itemSize;
    const dst = i * itemSize;
    for (let k = 0; k < itemSize; k++) out[dst + k] = src[base + k];
  }
  return out;
}

/**
 * @param {object} ctx
 * @param {object} ctx.parent       FBXElem to attach the Geometry node to (usually Objects)
 * @param {BufferGeometry} ctx.geometry
 * @param {bigint} ctx.uid
 * @param {string} ctx.name
 * @param {import('../../core/templates.js').TemplateBundle} ctx.templates
 * @param {number} ctx.materialSlotCount  number of unique FBX materials linked to this mesh
 * @param {Array<{ start: number, count: number, materialIndex: number }>} ctx.groups
 *        Forwarded from the Mesh; we use it to emit LayerElementMaterial when > 1 slot.
 * @param {number[]} [ctx.slotRemap]  Maps `mesh.material[i]` index → FBX-side
 *        material slot, accounting for duplicate Material instances being
 *        deduped on export. Mirrors Blender's `blmat_fbx_idx`
 *        (export_fbx_bin.py:1495). If absent, identity is assumed.
 */
export function writeGeometry(ctx) {
  const { parent, geometry, uid, name, templates, materialSlotCount = 0, groups = [], slotRemap, transformCtx } = ctx;
  const bake = transformCtx && transformCtx.bake && !transformCtx.isIdentity;

  const geom = parent.addEmpty('Geometry');
  geom.addInt64(uid);
  geom.addString(fbxNameClass(name || 'Geometry', 'Geometry'));
  geom.addString('Mesh');

  const tmpl = templateInit(templates, 'Geometry');
  const props = elemProperties(geom);
  templateFinalize(tmpl, props);

  elemDataSingleInt32(geom, 'GeometryVersion', FBX_GEOMETRY_VERSION);

  // ----- Vertices ------------------------------------------------------
  const pos = geometry.attributes.position;
  if (!pos) throw new Error(`Geometry "${name}" has no position attribute`);
  // Convert to float64 to match Blender; FBXLoader reads them via Float32BufferAttribute
  // anyway, so precision is fine either way.
  const posFlat = readAttributeFlat(pos, 3);
  const verts = new Float64Array(posFlat.length);
  for (let i = 0; i < posFlat.length; i++) verts[i] = posFlat[i];
  // Bake the global coordinate-space transform into vertex positions when
  // requested (e.g. Unreal preset). Mirrors Blender's fbx_data_mesh_elements
  // lines 869-871: vertices are object-space, but if `do_bake_space_transform`
  // we pre-multiply by global_matrix so the file's vertices already match
  // the target tool's axes.
  if (bake) bakeVertices(verts, transformCtx.globalMatrix);
  elemDataSingleFloat64Array(geom, 'Vertices', verts);

  // ----- PolygonVertexIndex --------------------------------------------
  const t_lvi = loopVertexIndices(geometry);
  const t_ls = polygonLoopStarts(t_lvi.length);
  const t_pvi = new Int32Array(t_lvi);
  applyFaceTerminator(t_pvi, t_ls);
  elemDataSingleInt32Array(geom, 'PolygonVertexIndex', t_pvi);

  // Edges: Blender computes unique edges for crease/sharp data — we don't
  // export those, so an empty array is fine; FBXLoader ignores it.
  elemDataSingleInt32Array(geom, 'Edges', new Int32Array(0));

  // ----- LayerElementNormal -------------------------------------------
  let wroteNormals = false;
  if (geometry.attributes.normal) {
    writeNormalLayer(geom, geometry, bake ? transformCtx : null);
    wroteNormals = true;
  }

  // ----- LayerElementColor --------------------------------------------
  let wroteColors = false;
  if (geometry.attributes.color) {
    writeColorLayer(geom, geometry);
    wroteColors = true;
  }

  // ----- LayerElementUV[] ---------------------------------------------
  const uvSets = [];
  for (const uvName of ['uv', 'uv1', 'uv2', 'uv3']) {
    if (geometry.attributes[uvName]) uvSets.push(uvName);
  }
  uvSets.forEach((uvName, i) => writeUVLayer(geom, geometry, uvName, i));

  // ----- LayerElementMaterial -----------------------------------------
  let wroteMaterial = false;
  if (materialSlotCount > 0) {
    writeMaterialLayer(geom, geometry, materialSlotCount, groups, slotRemap);
    wroteMaterial = true;
  }

  // ----- Layer (TOC) --------------------------------------------------
  // Layer 0 references one of each element type (export_fbx_bin.py:1521-1553).
  const layer0 = elemDataSingleInt32(geom, 'Layer', 0);
  elemDataSingleInt32(layer0, 'Version', FBX_GEOMETRY_LAYER_VERSION);
  if (wroteNormals)  addLayerEntry(layer0, 'LayerElementNormal', 0);
  if (wroteColors)   addLayerEntry(layer0, 'LayerElementColor', 0);
  if (uvSets.length) addLayerEntry(layer0, 'LayerElementUV', 0);
  if (wroteMaterial) addLayerEntry(layer0, 'LayerElementMaterial', 0);

  // Additional layers for extra UVs/colors (export_fbx_bin.py:1556-1574).
  for (let i = 1; i < uvSets.length; i++) {
    const layerN = elemDataSingleInt32(geom, 'Layer', i);
    elemDataSingleInt32(layerN, 'Version', FBX_GEOMETRY_LAYER_VERSION);
    addLayerEntry(layerN, 'LayerElementUV', i);
  }
}

function addLayerEntry(layer, typeName, typedIndex) {
  const e = elemEmpty(layer, 'LayerElement');
  elemDataSingleString(e, 'Type', typeName);
  elemDataSingleInt32(e, 'TypedIndex', typedIndex);
}

// ---------------------------------------------------------------------------
// Layer writers — each mirrors the corresponding block in fbx_data_mesh_elements.
// ---------------------------------------------------------------------------

/**
 * LayerElementNormal — Blender writes ByPolygonVertex + IndexToDirect with
 * deduped normals OR (when normals are per-vertex) ByVertice + IndexToDirect
 * (export_fbx_bin.py:1180-1239). To avoid the Unity-quirk normal-dedup issue
 * Blender explicitly works around, we follow its "skip_normal_deduplication"
 * branch: emit every normal verbatim with an identity index. FBXLoader's
 * parseNormals handles both ByPolygonVertex and ByVertice.
 */
function writeNormalLayer(geom, geometry, bakeCtx) {
  const layer = elemDataSingleInt32(geom, 'LayerElementNormal', 0);
  elemDataSingleInt32(layer, 'Version', FBX_GEOMETRY_NORMAL_VERSION);
  elemDataSingleString(layer, 'Name', '');
  elemDataSingleString(layer, 'MappingInformationType', 'ByPolygonVertex');
  elemDataSingleString(layer, 'ReferenceInformationType', 'IndexToDirect');

  const perLoop = attributeToPerLoop(geometry, geometry.attributes.normal, 3);
  const t_normal = new Float64Array(perLoop.length);
  for (let i = 0; i < perLoop.length; i++) t_normal[i] = perLoop[i];
  // Apply the inverse-transposed global matrix to normals when baking. This
  // is the standard "transform a covector" — using the inverse transpose
  // preserves perpendicularity to the underlying surface (Blender mirror
  // at fbx_data_mesh_elements:872-877).
  if (bakeCtx) bakeNormals(t_normal, bakeCtx.globalMatrixInvTransposed);
  elemDataSingleFloat64Array(layer, 'Normals', t_normal);

  // Identity NormalsIndex: [0, 1, 2, ..., n-1]
  const n = t_normal.length / 3;
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  elemDataSingleInt32Array(layer, 'NormalsIndex', idx);
}

/**
 * LayerElementUV — ByPolygonVertex + IndexToDirect. Blender deduplicates;
 * we use identity indices for simplicity (round-trips correctly through
 * FBXLoader which reads UV.a + UVIndex.a verbatim).
 */
function writeUVLayer(geom, geometry, attrName, layerIndex) {
  const layer = elemDataSingleInt32(geom, 'LayerElementUV', layerIndex);
  elemDataSingleInt32(layer, 'Version', FBX_GEOMETRY_UV_VERSION);
  elemDataSingleString(layer, 'Name', attrName === 'uv' ? 'UVMap' : attrName);
  elemDataSingleString(layer, 'MappingInformationType', 'ByPolygonVertex');
  elemDataSingleString(layer, 'ReferenceInformationType', 'IndexToDirect');

  const perLoop = attributeToPerLoop(geometry, geometry.attributes[attrName], 2);
  const t_uv = new Float64Array(perLoop.length);
  for (let i = 0; i < perLoop.length; i++) t_uv[i] = perLoop[i];
  elemDataSingleFloat64Array(layer, 'UV', t_uv);

  const n = t_uv.length / 2;
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  elemDataSingleInt32Array(layer, 'UVIndex', idx);
}

/**
 * LayerElementColor — ByPolygonVertex + IndexToDirect with 4 components.
 * three.js color attributes can be 3 or 4 components; we always emit RGBA.
 */
function writeColorLayer(geom, geometry) {
  const layer = elemDataSingleInt32(geom, 'LayerElementColor', 0);
  elemDataSingleInt32(layer, 'Version', FBX_GEOMETRY_VCOLOR_VERSION);
  elemDataSingleString(layer, 'Name', 'Col');
  elemDataSingleString(layer, 'MappingInformationType', 'ByPolygonVertex');
  elemDataSingleString(layer, 'ReferenceInformationType', 'IndexToDirect');

  const attr = geometry.attributes.color;
  const itemSize = attr.itemSize;
  const perLoop = attributeToPerLoop(geometry, attr, itemSize);
  const numLoops = perLoop.length / itemSize;
  const t_color = new Float64Array(numLoops * 4);
  for (let i = 0; i < numLoops; i++) {
    const src = i * itemSize;
    const dst = i * 4;
    t_color[dst]     = perLoop[src];
    t_color[dst + 1] = perLoop[src + 1];
    t_color[dst + 2] = perLoop[src + 2];
    t_color[dst + 3] = itemSize >= 4 ? perLoop[src + 3] : 1.0;
  }
  elemDataSingleFloat64Array(layer, 'Colors', t_color);

  const idx = new Int32Array(numLoops);
  for (let i = 0; i < numLoops; i++) idx[i] = i;
  elemDataSingleInt32Array(layer, 'ColorIndex', idx);
}

/**
 * LayerElementMaterial — mirrors export_fbx_bin.py:1467-1517.
 *  - Single material slot → AllSame + IndexToDirect + Materials=[0]
 *  - Multiple slots → ByPolygon + IndexToDirect + per-polygon material indices
 *
 * `groups` is the three.js BufferGeometry.groups array; each group is
 * { start, count, materialIndex } referring to loop indices.
 */
function writeMaterialLayer(geom, geometry, materialSlotCount, groups, slotRemap) {
  const layer = elemDataSingleInt32(geom, 'LayerElementMaterial', 0);
  elemDataSingleInt32(layer, 'Version', FBX_GEOMETRY_MATERIAL_VERSION);
  elemDataSingleString(layer, 'Name', '');

  if (materialSlotCount <= 1 || groups.length === 0) {
    // AllSame: one material applies to every polygon.
    elemDataSingleString(layer, 'MappingInformationType', 'AllSame');
    elemDataSingleString(layer, 'ReferenceInformationType', 'IndexToDirect');
    elemDataSingleInt32Array(layer, 'Materials', new Int32Array([0]));
    return;
  }

  // ByPolygon: one material index per face (triangle).
  const numLoops = geometry.index ? geometry.index.count : geometry.attributes.position.count;
  const numPolys = numLoops / 3;
  const t_pm = new Int32Array(numPolys);

  // Resolve the mesh-side → FBX-side material slot mapping. Mirrors Blender's
  // `blmat_fbx_idx[t_pm]` remap in export_fbx_bin.py:1495-1497.
  const remap = slotRemap || identityRemap(materialSlotCount);
  // Out-of-bounds material indices fall back to slot 0 (Blender's "use first
  // valid" default, lines 1484-1492).
  const remapAt = (meshIdx) => {
    if (meshIdx < 0 || meshIdx >= remap.length) return 0;
    const fbxIdx = remap[meshIdx];
    return fbxIdx >= 0 && fbxIdx < materialSlotCount ? fbxIdx : 0;
  };

  // Each `group.start/count` is a loop range. Map to polygon range.
  for (const g of groups) {
    const polyStart = Math.floor(g.start / 3);
    const polyCount = Math.floor(g.count / 3);
    const fbxIdx = remapAt(g.materialIndex);
    for (let i = 0; i < polyCount; i++) t_pm[polyStart + i] = fbxIdx;
  }
  elemDataSingleString(layer, 'MappingInformationType', 'ByPolygon');
  // Blender: "Logically Direct, but FBX expects IndexToDirect for materials."
  // (export_fbx_bin.py:1500-1504)
  elemDataSingleString(layer, 'ReferenceInformationType', 'IndexToDirect');
  elemDataSingleInt32Array(layer, 'Materials', t_pm);
}

function identityRemap(n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}
