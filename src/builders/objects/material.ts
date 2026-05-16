/**
 * three.js Material → FBX `Material` node (FbxSurfacePhong).
 *
 * Output properties (names match what FBXLoader.parseParameters reads):
 *   ShadingModel       'Phong'
 *   DiffuseColor       color (sRGB)
 *   DiffuseFactor      1.0
 *   EmissiveColor      emissive
 *   EmissiveFactor     emissiveIntensity (default 1)
 *   AmbientColor       (0,0,0)
 *   AmbientFactor      0.0
 *   TransparentColor   color
 *   TransparencyFactor 1 - alpha
 *   Opacity            alpha
 *   NormalMap          (0,0,0) placeholder
 *   BumpFactor         bump scale
 *   SpecularColor      color
 *   SpecularFactor     specular / 2
 *   Shininess          ((1 - roughness) * 10) ^ 2
 *   ShininessExponent  same
 *   ReflectionColor    color
 *   ReflectionFactor   metallic
 */

import {
  elemDataSingleInt32, elemDataSingleString,
  elemProperties, fbxNameClass,
  templateInit, templateSet, templateFinalize,
} from '../../core/elemHelpers.js';
import { FBX_MATERIAL_VERSION } from '../../constants.js';

/**
 * Pull a normalized PBR-ish description from any three.js material.
 */
function readMaterialParams(material) {
  const out = {
    baseColor:        [0.8, 0.8, 0.8],
    emissiveColor:    [0.0, 0.0, 0.0],
    emissiveStrength: 1.0,
    metallic:         0.0,
    roughness:        0.5,
    specular:         0.5,
    alpha:            1.0,
    normalmapStrength: 1.0,
  };

  if (material.color)        out.baseColor        = [material.color.r, material.color.g, material.color.b];
  if (material.emissive)     out.emissiveColor    = [material.emissive.r, material.emissive.g, material.emissive.b];
  if ('emissiveIntensity' in material) out.emissiveStrength = material.emissiveIntensity;
  if ('metalness' in material)         out.metallic         = material.metalness;
  if ('roughness' in material)         out.roughness        = material.roughness;
  if ('opacity' in material)           out.alpha            = material.opacity;
  if ('normalScale' in material && material.normalScale)    out.normalmapStrength = material.normalScale.x;

  if (material.isMeshPhongMaterial) {
    const sh = typeof material.shininess === 'number' ? material.shininess : 30;
    out.roughness = Math.max(0, 1 - Math.sqrt(Math.max(0, sh)) / 10);
    if (material.specular && typeof material.specular.r === 'number') {
      out.specular = material.specular.r;
    }
  }
  return out;
}

/**
 * @param {object} ctx
 * @param {FBXElem} ctx.parent
 * @param {Material} ctx.material
 * @param {bigint}  ctx.uid
 * @param {TemplateBundle} ctx.templates
 */
export function writeMaterial({ parent, material, uid, templates }) {
  const ma = readMaterialParams(material);

  const node = parent.addEmpty('Material');
  node.addInt64(uid);
  node.addString(fbxNameClass(material.name || 'Material', 'Material'));
  node.addString('');

  elemDataSingleInt32(node, 'Version', FBX_MATERIAL_VERSION);
  elemDataSingleString(node, 'ShadingModel', 'Phong');
  elemDataSingleInt32(node, 'MultiLayer', 0);

  const tmpl = templateInit(templates, 'Material');
  const props = elemProperties(node);

  templateSet(tmpl, props, 'p_string', 'ShadingModel',  'Phong');
  templateSet(tmpl, props, 'p_color',  'DiffuseColor',  ma.baseColor);
  templateSet(tmpl, props, 'p_number', 'DiffuseFactor', 1.0);
  templateSet(tmpl, props, 'p_color',  'EmissiveColor', ma.emissiveColor);
  templateSet(tmpl, props, 'p_number', 'EmissiveFactor', ma.emissiveStrength);
  templateSet(tmpl, props, 'p_color',  'AmbientColor',  [0.0, 0.0, 0.0]);
  templateSet(tmpl, props, 'p_number', 'AmbientFactor', 0.0);

  const EPS = 1e-5;
  if (ma.alpha < EPS || ma.alpha > 1 - EPS) {
    const c = 1 - ma.alpha;
    templateSet(tmpl, props, 'p_color', 'TransparentColor', [c, c, c]);
  } else {
    templateSet(tmpl, props, 'p_color', 'TransparentColor', ma.baseColor);
  }
  templateSet(tmpl, props, 'p_number', 'TransparencyFactor', 1.0 - ma.alpha);
  templateSet(tmpl, props, 'p_number', 'Opacity',            ma.alpha);

  templateSet(tmpl, props, 'p_vector_3d', 'NormalMap', [0, 0, 0]);
  templateSet(tmpl, props, 'p_double',    'BumpFactor', ma.normalmapStrength);

  templateSet(tmpl, props, 'p_color',  'SpecularColor', ma.baseColor);
  templateSet(tmpl, props, 'p_number', 'SpecularFactor', ma.specular / 2.0);

  const shin = ((1 - ma.roughness) * 10);
  const shinSq = shin * shin;
  templateSet(tmpl, props, 'p_number', 'Shininess',         shinSq);
  templateSet(tmpl, props, 'p_number', 'ShininessExponent', shinSq);
  templateSet(tmpl, props, 'p_color',  'ReflectionColor',   ma.baseColor);
  templateSet(tmpl, props, 'p_number', 'ReflectionFactor',  ma.metallic);

  templateFinalize(tmpl, props);
}
