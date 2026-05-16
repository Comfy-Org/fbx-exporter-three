/**
 * Emit AnimationStack / AnimationLayer / AnimationCurveNode / AnimationCurve
 * nodes, plus their OO / OP connections.
 *
 * Mirrors `export_fbx_bin.py: fbx_data_animation_elements` (lines 2046-2124)
 * and the per-stack connection block at lines 3166-3183.
 *
 * Per stack, we emit:
 *   AnimationStack (uid)            — Properties70.LocalStart/Stop/ReferenceStart/Stop (KTime)
 *   AnimationLayer (uid)            — one per stack (Blender comment line 2072)
 *   AnimationCurveNode (uid×K)      — one per (target, property), Properties70 has d|X/d|Y/d|Z initial values
 *   AnimationCurve (uid×3K)         — one per axis, KeyTime / KeyValueFloat / KeyAttrFlags
 *
 * Connections (OO + OP):
 *   OO  AnimLayer → AnimStack
 *   OO  AnimCurveNode → AnimLayer
 *   OP  AnimCurveNode → Model   relationship: "Lcl Translation" / "Lcl Rotation" / "Lcl Scaling"
 *   OP  AnimCurve → AnimCurveNode  relationship: "d|X" / "d|Y" / "d|Z"
 */

import {
  elemDataSingleInt32, elemDataSingleInt64, elemDataSingleFloat64,
  elemDataSingleInt64Array, elemDataSingleFloat32Array, elemDataSingleInt32Array,
  elemProperties, fbxNameClass,
  templateInit, templateSet, templateFinalize,
} from '../../core/elemHelpers.js';
import { FBX_ANIM_KEY_VERSION } from '../../constants.js';

// Blender uses a fixed flag word for every key (line 2104-2111) — it
// encodes "cubic interpolation + auto tangent" with the time-independent
// progressive-clamp flag. We emit one flag entry per Curve and refcount
// it to the number of keys.
const KEY_ATTR_FLAGS    = 0x04 | 0x100 | 0x2000 | 0x4000; // 24836
const KEY_ATTR_DATAFLOAT = [0.0, 0.0, 9.419963346924634e-30, 0.0];

/**
 * @param {object} ctx
 * @param {FBXElem} ctx.parent       Objects container
 * @param {object[]} ctx.stacks      output of animationCollector.buildAnimationPlan
 * @param {TemplateBundle} ctx.templates
 */
export function writeAnimationNodes({ parent, stacks, templates }) {
  for (const stack of stacks) writeStack(parent, stack, templates);
}

function writeStack(parent, stack, templates) {
  const stackNode = parent.addEmpty('AnimationStack');
  stackNode.addInt64(stack.stackUid);
  stackNode.addString(fbxNameClass(stack.name, 'AnimStack'));
  stackNode.addString('');

  const stackTmpl = templateInit(templates, 'AnimationStack');
  const stackProps = elemProperties(stackNode);
  templateSet(stackTmpl, stackProps, 'p_timestamp', 'LocalStart',     stack.start);
  templateSet(stackTmpl, stackProps, 'p_timestamp', 'LocalStop',      stack.stop);
  templateSet(stackTmpl, stackProps, 'p_timestamp', 'ReferenceStart', stack.start);
  templateSet(stackTmpl, stackProps, 'p_timestamp', 'ReferenceStop',  stack.stop);
  templateFinalize(stackTmpl, stackProps);

  // Layer: one per stack (matches Blender's "For now, only one layer" comment).
  const layerNode = parent.addEmpty('AnimationLayer');
  layerNode.addInt64(stack.layerUid);
  layerNode.addString(fbxNameClass(stack.name, 'AnimLayer'));
  layerNode.addString('');

  for (const cn of stack.curveNodes) writeCurveNode(parent, cn, templates);
}

function writeCurveNode(parent, cn, templates) {
  const nodeElem = parent.addEmpty('AnimationCurveNode');
  nodeElem.addInt64(cn.curveNodeUid);
  nodeElem.addString(fbxNameClass(cn.attrName, 'AnimCurveNode'));
  nodeElem.addString('');

  // Properties70: one p_number per axis (d|X, d|Y, d|Z) carrying the initial
  // values that FBXLoader uses when keyframes are sparse (line 3014-3016).
  const cnTmpl = templateInit(templates, 'AnimationCurveNode');
  const cnProps = elemProperties(nodeElem);
  for (const curve of cn.curves) {
    templateSet(cnTmpl, cnProps, 'p_number', `d|${curve.axis}`, curve.defaultValue, { animatable: true });
  }
  templateFinalize(cnTmpl, cnProps);

  // One AnimationCurve per axis.
  for (const curve of cn.curves) writeCurve(parent, curve);
}

function writeCurve(parent, curve) {
  const c = parent.addEmpty('AnimationCurve');
  c.addInt64(curve.uid);
  c.addString(fbxNameClass('', 'AnimCurve'));
  c.addString('');

  // Default value goes BEFORE the time/value arrays — matches Blender
  // (export_fbx_bin.py:2116).
  elemDataSingleFloat64(c, 'Default', curve.defaultValue);
  elemDataSingleInt32(c, 'KeyVer', FBX_ANIM_KEY_VERSION);
  elemDataSingleInt64Array(c,   'KeyTime',          curve.times);
  elemDataSingleFloat32Array(c, 'KeyValueFloat',    curve.values);
  elemDataSingleInt32Array(c,   'KeyAttrFlags',     new Int32Array([KEY_ATTR_FLAGS]));
  elemDataSingleFloat32Array(c, 'KeyAttrDataFloat', new Float32Array(KEY_ATTR_DATAFLOAT));
  elemDataSingleInt32Array(c,   'KeyAttrRefCount',  new Int32Array([curve.times.length]));
}
