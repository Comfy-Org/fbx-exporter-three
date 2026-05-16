/**
 * Every helper returns the created FBXElem so callers can chain or attach children.
 */

import { FBXElem } from './FBXElem.js';


function single(parent, name, addFn) {
  const e = new FBXElem(name);
  addFn(e);
  parent.addChild(e);
  return e;
}

export const elemEmpty            = (parent, name) => parent.addEmpty(name);
export const elemDataSingleBool   = (p, n, v) => single(p, n, (e) => e.addBool(v));
export const elemDataSingleChar   = (p, n, v) => single(p, n, (e) => e.addChar(v));
export const elemDataSingleInt8   = (p, n, v) => single(p, n, (e) => e.addInt8(v));
export const elemDataSingleInt16  = (p, n, v) => single(p, n, (e) => e.addInt16(v));
export const elemDataSingleInt32  = (p, n, v) => single(p, n, (e) => e.addInt32(v));
export const elemDataSingleInt64  = (p, n, v) => single(p, n, (e) => e.addInt64(v));
export const elemDataSingleFloat32 = (p, n, v) => single(p, n, (e) => e.addFloat32(v));
export const elemDataSingleFloat64 = (p, n, v) => single(p, n, (e) => e.addFloat64(v));
export const elemDataSingleBytes  = (p, n, v) => single(p, n, (e) => e.addBytes(v));
export const elemDataSingleString = (p, n, v) => single(p, n, (e) => e.addString(v));

export const elemDataSingleInt32Array   = (p, n, v) => single(p, n, (e) => e.addInt32Array(v));
export const elemDataSingleInt64Array   = (p, n, v) => single(p, n, (e) => e.addInt64Array(v));
export const elemDataSingleFloat32Array = (p, n, v) => single(p, n, (e) => e.addFloat32Array(v));
export const elemDataSingleFloat64Array = (p, n, v) => single(p, n, (e) => e.addFloat64Array(v));
export const elemDataSingleBoolArray    = (p, n, v) => single(p, n, (e) => e.addBoolArray(v));
export const elemDataSingleByteArray    = (p, n, v) => single(p, n, (e) => e.addByteArray(v));

/**
 * Encode a (name, class) pair as a single FBX object-id string.
 *
 * Mirrors `fbx_utils.py: fbx_name_class` (line 1891) which joins with the
 * `\x00\x01` separator. The leading null is significant: FBXLoader's binary
 * reader (`BinaryReader.getString`, FBXLoader.js:4265-4266) truncates at the
 * first null, so on import `attrName` becomes the bare name and the class
 * suffix is silently dropped. Maya / Unreal honor the full separator.
 */
export function fbxNameClass(name, cls) {
  return `${name}\x00\x01${cls}`;
}

const F64  = 'addFloat64';
const I32  = 'addInt32';
const I64  = 'addInt64';
const STR  = 'addString';

/** @type {Record<string, [string, string, ...string[]]>} */
export const PTYPES = {
  p_bool:                   ['bool',                 '',         I32],
  p_integer:                ['int',                  'Integer',  I32],
  p_ulonglong:              ['ULongLong',            '',         I64],
  p_double:                 ['double',               'Number',   F64],
  p_number:                 ['Number',               '',         F64],
  p_enum:                   ['enum',                 '',         I32],
  p_vector_3d:              ['Vector3D',             'Vector',   F64, F64, F64],
  p_vector:                 ['Vector',               '',         F64, F64, F64],
  p_color_rgb:              ['ColorRGB',             'Color',    F64, F64, F64],
  p_color:                  ['Color',                '',         F64, F64, F64],
  p_string:                 ['KString',              '',         STR],
  p_string_url:             ['KString',              'Url',      STR],
  p_timestamp:              ['KTime',                'Time',     I64],
  p_datetime:               ['DateTime',             '',         STR],
  p_object:                 ['object',               ''],
  p_compound:               ['Compound',             ''],
  p_lcl_translation:        ['Lcl Translation',      '',         F64, F64, F64],
  p_lcl_rotation:           ['Lcl Rotation',         '',         F64, F64, F64],
  p_lcl_scaling:            ['Lcl Scaling',          '',         F64, F64, F64],
  p_visibility:             ['Visibility',           '',         F64],
  p_visibility_inheritance: ['Visibility Inheritance', '',       I32],
  p_roll:                   ['Roll',                 '',         F64],
  p_opticalcenterx:         ['OpticalCenterX',       '',         F64],
  p_opticalcentery:         ['OpticalCenterY',       '',         F64],
  p_fov:                    ['FieldOfView',          '',         F64],
  p_fov_x:                  ['FieldOfViewX',         '',         F64],
  p_fov_y:                  ['FieldOfViewY',         '',         F64],
};

function flagsStr(animatable, animated, custom) {
  if (animatable) {
    if (animated) return custom ? 'A+U' : 'A+';
    if (custom)   return 'A+U';
    return 'A';
  }
  if (custom) return 'U';
  return '';
}

function writeOneProp(propsElem, ptypeDef, name, value, flags) {
  const p = new FBXElem('P');
  p.addString(name);
  p.addString(ptypeDef[0]);
  p.addString(ptypeDef[1]);
  p.addString(flags);
  const adders = ptypeDef.slice(2);
  if (adders.length === 1) {
    if (ptypeDef[0] === 'object') {
    } else {
      p[adders[0]](value);
    }
  } else if (adders.length > 1) {
    for (let i = 0; i < adders.length; i++) p[adders[i]](value[i]);
  }
  propsElem.addChild(p);
  return p;
}

/** Add a `Properties70` child to `elem` and return it. */
export function elemProperties(elem) {
  return elem.addEmpty('Properties70');
}

/**
 * Write a single property record into a Properties70 element.
 * @param {FBXElem} propsElem - the Properties70 element
 * @param {string} ptype      - one of PTYPES keys (e.g. 'p_double')
 * @param {string} name       - FBX property name (e.g. 'Lcl Translation')
 * @param {*} value           - scalar or [x,y,z]
 */
export function elemPropsSet(propsElem: any, ptype: string, name: string, value?: any, {
  animatable = false, animated = false, custom = false,
}: { animatable?: boolean; animated?: boolean; custom?: boolean } = {}) {
  const def = PTYPES[ptype];
  if (!def) throw new Error(`Unknown ptype: ${ptype}`);
  writeOneProp(propsElem, def, name, value, flagsStr(animatable, animated, custom));
}


/**
 * @typedef {Object} TemplateEntry
 * @property {*} value
 * @property {string} ptype
 * @property {boolean} animatable
 */

/**
 * @typedef {Object} TemplateDef
 * @property {string} typeName       e.g. 'Model'
 * @property {string} propTypeName   e.g. 'FbxNode'
 * @property {Record<string, TemplateEntry>} properties
 */

/** Build a per-instance "working copy" of a template's properties. */
export function templateInit(templates: any, typeName: string): Record<string, any> {
  const tmpl = templates && templates.get ? templates.get(typeName) : null;
  if (!tmpl) return {};
  const out: Record<string, any> = {};
  for (const [name, entry] of Object.entries(tmpl.properties) as [string, any][]) {
    out[name] = { ...entry, written: false };
  }
  return out;
}

function valuesEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return a === b;
}

/**
 * Write a per-instance P record. three.js FBXLoader reads per-instance
 * Properties70 directly without consulting Definitions templates for
 * fallback (FBXLoader.js:1346 et al.), so a skipped property that matches
 * our template default would silently regress on round-trip (e.g.
 * CastShadows=true matching default true → skipped → FBXLoader defaults
 * false).
 */
export function templateSet(working, propsElem, ptype, name, value, {
  animatable = false, animated = false,
} = {}) {
  const def = PTYPES[ptype];
  if (!def) throw new Error(`Unknown ptype: ${ptype}`);
  const tmpl = working[name];
  if (tmpl) {
    writeOneProp(propsElem, def, name, value, flagsStr(tmpl.animatable, animated, false));
    tmpl.written = true;
  } else {
    writeOneProp(propsElem, def, name, value, flagsStr(animatable, animated, false));
  }
}

export function templateFinalize(_working, _propsElem) {}
