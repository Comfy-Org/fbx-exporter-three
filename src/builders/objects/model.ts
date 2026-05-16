/**
 * Object3D → FBX `Model` node + optional `NodeAttribute` for "Null" empties.
 *
 * Property writes use the template-aware writer so values that match the
 * default in Definitions are omitted from the per-instance Properties70.
 */

import {
  elemDataSingleInt32, elemDataSingleString, elemDataSingleChar,
  elemProperties, elemPropsSet, fbxNameClass,
  templateInit, templateSet, templateFinalize,
} from '../../core/elemHelpers.js';
import { FBX_MODELS_VERSION } from '../../constants.js';
import { Euler, Vector3, Quaternion } from 'three';

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Emit `Object3D.userData` entries as user-defined Properties70 P records.
 * Type mapping is best-effort since JS values don't carry an FBX ptype:
 *   - boolean        → p_bool
 *   - integer Number → p_integer
 *   - finite Number  → p_double
 *   - string         → p_string
 *   - [num,num,num]  → p_vector_3d
 *   - anything else  → JSON-stringified p_string
 *
 * Keys are written verbatim (FBX P-record name field).
 */
function writeUserDataProps(propsElem, userData) {
  if (!userData || typeof userData !== 'object') return;
  for (const key of Object.keys(userData)) {
    const value = userData[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'boolean') {
      elemPropsSet(propsElem, 'p_bool', key, value ? 1 : 0, { custom: true });
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      const ptype = Number.isInteger(value) ? 'p_integer' : 'p_double';
      elemPropsSet(propsElem, ptype, key, value, { custom: true });
    } else if (typeof value === 'string') {
      elemPropsSet(propsElem, 'p_string', key, value, { custom: true });
    } else if (Array.isArray(value) && value.length === 3 &&
               value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      elemPropsSet(propsElem, 'p_vector_3d', key, value, { custom: true });
    } else {
      try {
        elemPropsSet(propsElem, 'p_string', key, JSON.stringify(value), { custom: true });
      } catch {
      }
    }
  }
}

const _euler = new Euler();
const _pos = new Vector3();
const _quat = new Quaternion();
const _scale = new Vector3();

/**
 * Decompose an object's authoritative local transform into TRS.
 *
 * `object.matrix` is the single source of truth after SceneCollector calls
 * `input.updateMatrixWorld(true)`:
 *  - For `matrixAutoUpdate === true` (the default), updateMatrixWorld also
 *    calls updateMatrix(), so `matrix` reflects current PQS.
 *  - For `matrixAutoUpdate === false`, updateMatrix() is skipped
 *    (Object3D.js:1167), so `matrix` is whatever the user set directly.
 *    `position/quaternion/scale` may be stale (e.g. defaults).
 *
 * GLTFExporter handles this divergence by emitting `nodeDef.matrix` when not
 * auto-update; FBX has no matrix mode, so we MUST decompose to TRS.
 */
function decomposeLocal(object) {
  object.matrix.decompose(_pos, _quat, _scale);
  return { pos: _pos, quat: _quat, scale: _scale };
}

/**
 * Convert a three.js Quaternion to an Euler triple in degrees that, when
 * re-interpreted with three.js Euler order 'ZYX', reconstructs the same
 * rotation.
 *
 * Why 'ZYX' rather than 'XYZ': FBX's `RotationOrder=0` is "EulerXYZ" (intrinsic
 * X-Y-Z, equivalent to extrinsic Z-Y-X). FBXLoader maps `RotationOrder=0` to
 * three.js Euler order `'ZYX'` (see FBXLoader.js:4514 — the table notes
 * `'ZYX', // -> XYZ extrinsic`). For round-trip correctness, our export must
 * emit angles in that same convention.
 *
 * Template default `RotationOrder=0` (templates.js: modelTemplate) keeps the
 * FBX-side reading aligned.
 */
function quaternionToLclRotationDeg(quaternion) {
  _euler.setFromQuaternion(quaternion, 'ZYX');
  return [_euler.x * RAD_TO_DEG, _euler.y * RAD_TO_DEG, _euler.z * RAD_TO_DEG];
}

/**
 * Choose the FBX subtype string written as the Model's third property.
 *
 * Light / Camera / Bone subtypes only work when there's a matching
 * NodeAttribute::<Subtype> attached — otherwise FBXLoader takes the wrong
 * code path (e.g. createCamera reads window.innerWidth in Node).
 * AmbientLight has no FBX equivalent so we collapse it to Null.
 */
function modelSubtypeFor(object) {
  if (object.isMesh)   return 'Mesh';
  if (object.isBone)   return 'LimbNode';
  if (object.isLight && !object.isAmbientLight) return 'Light';
  if (object.isCamera) return 'Camera';
  return 'Null';
}

/**
 * Write a single Model node.
 *
 * @param {object} ctx
 * @param {FBXElem} ctx.parent   `Objects` container
 * @param {Object3D} ctx.object
 * @param {bigint} ctx.uid
 * @param {TemplateBundle} ctx.templates
 */
export function writeModel({ parent, object, uid, templates, overrideTranslation, overrideMatrix, hasLookAtTarget, customProperties }: {
  parent: any; object: any; uid: any; templates: any;
  overrideTranslation?: any; overrideMatrix?: any;
  hasLookAtTarget?: any; customProperties?: any;
}) {
  const subtype = modelSubtypeFor(object);
  const model = parent.addEmpty('Model');
  model.addInt64(uid);
  model.addString(fbxNameClass(object.name || subtype, 'Model'));
  model.addString(subtype);

  elemDataSingleInt32(model, 'Version', FBX_MODELS_VERSION);

  const tmpl = templateInit(templates, 'Model');
  const props = elemProperties(model);

  let t, quat, s;
  if (overrideMatrix) {
    const _p = new Vector3(), _q = new Quaternion(), _s = new Vector3();
    overrideMatrix.decompose(_p, _q, _s);
    t = _p; quat = _q; s = _s;
  } else {
    ({ pos: t, quat, scale: s } = decomposeLocal(object));
  }
  const rot = quaternionToLclRotationDeg(quat);
  const tx = overrideTranslation ? overrideTranslation : [t.x, t.y, t.z];

  templateSet(tmpl, props, 'p_lcl_translation', 'Lcl Translation', tx,              { animatable: true });
  templateSet(tmpl, props, 'p_lcl_rotation',    'Lcl Rotation',    rot,             { animatable: true });
  templateSet(tmpl, props, 'p_lcl_scaling',     'Lcl Scaling',     [s.x, s.y, s.z], { animatable: true });

  templateSet(tmpl, props, 'p_visibility',        'Visibility',            object.visible ? 1.0 : 0.0);
  templateSet(tmpl, props, 'p_integer',           'DefaultAttributeIndex', 0);
  templateSet(tmpl, props, 'p_enum',              'InheritType',           1);

  if (hasLookAtTarget) {
    templateSet(tmpl, props, 'p_object', 'LookAtProperty', null);
  }

  if (customProperties) writeUserDataProps(props, object.userData);

  templateFinalize(tmpl, props);

  elemDataSingleInt32(model, 'MultiLayer', 0);
  elemDataSingleInt32(model, 'MultiTake',  0);
  elemDataSingleChar(model, 'Shading', 0x01);
  elemDataSingleString(model, 'Culling', 'CullingOff');
}

/**
 * Write a `NodeAttribute` node for an Object3D / Group ("Null" empty).
 */
export function writeNullAttribute({ parent, name, uid, templates }) {
  const node = parent.addEmpty('NodeAttribute');
  node.addInt64(uid);
  node.addString(fbxNameClass(name || 'Null', 'NodeAttribute'));
  node.addString('Null');

  elemDataSingleString(node, 'TypeFlags', 'Null');

  const tmpl = templateInit(templates, 'NodeAttribute');
  const props = elemProperties(node);
  templateFinalize(tmpl, props);
}
