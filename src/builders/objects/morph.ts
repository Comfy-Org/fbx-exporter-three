/**
 * Emit BlendShape Deformer + BlendShapeChannel SubDeformers + Geometry(Shape)
 * nodes for morph targets on a mesh.
 *
 * Mirrors `export_fbx_bin.py: fbx_data_mesh_shapes_elements`
 * (lines 765-845).
 *
 * For each mesh with morphs we produce:
 *   - 1 Deformer (BlendShape)                       — top-level
 *   - N Deformer (BlendShapeChannel) (SubDeformer)  — one per morph target
 *   - N Geometry (Shape)                            — delta geometry per target
 *
 * Connections (handled in SceneCollector pass 2):
 *   OO  BlendShape         → base Geometry
 *   OO  BlendShapeChannel  → BlendShape
 *   OO  ShapeGeometry      → BlendShapeChannel
 */

import {
  elemDataSingleInt32, elemDataSingleFloat64,
  elemDataSingleInt32Array, elemDataSingleFloat64Array,
  elemProperties, fbxNameClass,
  templateInit, templateFinalize,
} from '../../core/elemHelpers.js';
import {
  FBX_GEOMETRY_SHAPE_VERSION,
  FBX_DEFORMER_SHAPE_VERSION,
  FBX_DEFORMER_SHAPECHANNEL_VERSION,
} from '../../constants.js';

/**
 * @param {object} ctx
 * @param {FBXElem} ctx.parent       Objects container
 * @param {object}  ctx.morphPlan    output of morphCollector.collectMorph
 * @param {TemplateBundle} ctx.templates
 */
export function writeMorph({ parent, morphPlan, templates }) {
  const meshName = morphPlan.mesh.name || 'BlendShape';

  // 1. Per-channel Geometry (Shape) — emit BEFORE the BlendShape Deformer
  //    so they appear earlier in the file (matches Blender's order, lines
  //    798-820 of fbx_data_mesh_shapes_elements).
  for (const channel of morphPlan.channels) {
    writeShapeGeometry(parent, channel, templates);
  }

  // 2. BlendShape Deformer (top-level).
  const shapeDef = parent.addEmpty('Deformer');
  shapeDef.addInt64(morphPlan.blendShapeUid);
  shapeDef.addString(fbxNameClass(meshName, 'Deformer'));
  shapeDef.addString('BlendShape');
  elemDataSingleInt32(shapeDef, 'Version', FBX_DEFORMER_SHAPE_VERSION);

  // 3. Per-channel BlendShapeChannel SubDeformer.
  for (const channel of morphPlan.channels) {
    writeChannel(parent, channel, templates);
  }
}

function writeShapeGeometry(parent, channel, templates) {
  const geom = parent.addEmpty('Geometry');
  geom.addInt64(channel.shapeGeomUid);
  geom.addString(fbxNameClass(channel.name, 'Geometry'));
  geom.addString('Shape');

  // Properties70 — finalize the Geometry template defaults (BBox etc.).
  const tmpl = templateInit(templates, 'Geometry');
  const props = elemProperties(geom);
  templateFinalize(tmpl, props);

  elemDataSingleInt32(geom, 'Version', FBX_GEOMETRY_SHAPE_VERSION);

  // Order matches Blender (lines 808-820): Indexes BEFORE Vertices.
  elemDataSingleInt32Array(geom, 'Indexes',  channel.indices);
  elemDataSingleFloat64Array(geom, 'Vertices', channel.deltas);
  // We deliberately do NOT write Normals — FBXLoader doesn't read them on
  // import (FBXLoader.js:2418 "TODO: add morph normal support") and
  // computing per-shape delta normals is rarely useful. The "Unity 2020
  // workaround" Blender mentions only applies when normals ARE present.
}

function writeChannel(parent, channel, templates) {
  const ch = parent.addEmpty('Deformer');
  ch.addInt64(channel.channelUid);
  ch.addString(fbxNameClass(channel.name, 'SubDeformer'));
  ch.addString('BlendShapeChannel');

  elemDataSingleInt32(ch, 'Version', FBX_DEFORMER_SHAPECHANNEL_VERSION);
  // DeformPercent encodes the static morph state at export time: the
  // mesh's current `morphTargetInfluences[i] × 100` (Blender:
  // export_fbx_bin.py:839 uses `shape.value × 100`). Three.js FBXLoader
  // does not read this back into morphTargetInfluences on import — that
  // remains a known three.js limitation — but Maya/Unreal/Motionbuilder
  // do, so the file represents the right pose for cross-tool workflows.
  elemDataSingleFloat64(ch, 'DeformPercent', channel.deformPercent);
  // FullWeights: per-vertex influence (always 100% per Blender's default,
  // lines 794-795). FBX wants one float64 per shape vertex.
  const fullWeights = new Float64Array(channel.indices.length);
  fullWeights.fill(100.0);
  elemDataSingleFloat64Array(ch, 'FullWeights', fullWeights);
}
