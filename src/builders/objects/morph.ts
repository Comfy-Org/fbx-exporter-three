/**
 * Emit BlendShape Deformer + BlendShapeChannel SubDeformers + Geometry(Shape)
 * nodes for morph targets on a mesh.
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

  for (const channel of morphPlan.channels) {
    writeShapeGeometry(parent, channel, templates);
  }

  const shapeDef = parent.addEmpty('Deformer');
  shapeDef.addInt64(morphPlan.blendShapeUid);
  shapeDef.addString(fbxNameClass(meshName, 'Deformer'));
  shapeDef.addString('BlendShape');
  elemDataSingleInt32(shapeDef, 'Version', FBX_DEFORMER_SHAPE_VERSION);

  for (const channel of morphPlan.channels) {
    writeChannel(parent, channel, templates);
  }
}

function writeShapeGeometry(parent, channel, templates) {
  const geom = parent.addEmpty('Geometry');
  geom.addInt64(channel.shapeGeomUid);
  geom.addString(fbxNameClass(channel.name, 'Geometry'));
  geom.addString('Shape');

  const tmpl = templateInit(templates, 'Geometry');
  const props = elemProperties(geom);
  templateFinalize(tmpl, props);

  elemDataSingleInt32(geom, 'Version', FBX_GEOMETRY_SHAPE_VERSION);

  elemDataSingleInt32Array(geom, 'Indexes',  channel.indices);
  elemDataSingleFloat64Array(geom, 'Vertices', channel.deltas);
}

function writeChannel(parent, channel, templates) {
  const ch = parent.addEmpty('Deformer');
  ch.addInt64(channel.channelUid);
  ch.addString(fbxNameClass(channel.name, 'SubDeformer'));
  ch.addString('BlendShapeChannel');

  elemDataSingleInt32(ch, 'Version', FBX_DEFORMER_SHAPECHANNEL_VERSION);
  elemDataSingleFloat64(ch, 'DeformPercent', channel.deformPercent);
  const fullWeights = new Float64Array(channel.indices.length);
  fullWeights.fill(100.0);
  elemDataSingleFloat64Array(ch, 'FullWeights', fullWeights);
}
