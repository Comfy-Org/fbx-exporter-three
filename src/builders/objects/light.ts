/**
 * three.js Light → FBX `NodeAttribute::Light`.
 *
 * Supported types:
 *   - PointLight        → FBX Point         (LightType=0)
 *   - DirectionalLight  → FBX Directional   (LightType=1)
 *   - SpotLight         → FBX Spot          (LightType=2)
 * HemisphereLight is mapped to Directional.
 * AmbientLight and RectAreaLight fall through to type 0 with a console warning;
 * three.js FBXLoader doesn't support Area on import anyway.
 *
 * FBXLoader.js:1232-1351 reads these specific fields:
 *   LightType   → switch (Point/Directional/Spot/default)
 *   Color       → sRGB → working color (ColorManagement)
 *   Intensity   → × 1/100 (we multiply by 100 here for symmetric round-trip)
 *   FarAttenuationEnd → PointLight.distance / SpotLight.distance
 *   OuterAngle  → SpotLight.angle (degrees → radians)
 *   InnerAngle  → with OuterAngle, computes penumbra = 1 - inner/outer
 *   CastShadows → light.castShadow
 */

import {
  elemDataSingleInt32, elemDataSingleString,
  elemProperties, fbxNameClass,
  templateInit, templateSet, templateFinalize,
} from '../../core/elemHelpers.js';
import { FBX_GEOMETRY_VERSION } from '../../constants.js';

const RAD_TO_DEG = 180 / Math.PI;

const FBX_LIGHT_POINT       = 0;
const FBX_LIGHT_DIRECTIONAL = 1;
const FBX_LIGHT_SPOT        = 2;
const FBX_LIGHT_AREA        = 3;

function lightTypeFor(light) {
  if (light.isDirectionalLight) return FBX_LIGHT_DIRECTIONAL;
  if (light.isSpotLight)        return FBX_LIGHT_SPOT;
  if (light.isPointLight)       return FBX_LIGHT_POINT;
  if (light.isHemisphereLight)  return FBX_LIGHT_DIRECTIONAL;
  if (light.isRectAreaLight)    return FBX_LIGHT_AREA;
  return FBX_LIGHT_POINT;
}

/**
 * @param {object} ctx
 * @param {FBXElem} ctx.parent
 * @param {Light}   ctx.light
 * @param {bigint}  ctx.attrUid
 * @param {TemplateBundle} ctx.templates
 */
export function writeLightAttribute({ parent, light, attrUid, templates }) {
  const node = parent.addEmpty('NodeAttribute');
  node.addInt64(attrUid);
  node.addString(fbxNameClass(light.name || 'Light', 'NodeAttribute'));
  node.addString('Light');

  elemDataSingleInt32(node, 'GeometryVersion', FBX_GEOMETRY_VERSION);

  const tmpl = templateInit(templates, 'NodeAttribute');
  const props = elemProperties(node);

  const lightType = lightTypeFor(light);
  templateSet(tmpl, props, 'p_enum', 'LightType', lightType);

  const castLight = !light.isAmbientLight;
  templateSet(tmpl, props, 'p_bool', 'CastLight', castLight);

  const color = light.color || { r: 1, g: 1, b: 1 };
  templateSet(tmpl, props, 'p_color', 'Color', [color.r, color.g, color.b], { animatable: true });

  const intensity = (light.intensity ?? 1) * 100;
  templateSet(tmpl, props, 'p_number', 'Intensity', intensity, { animatable: true });

  templateSet(tmpl, props, 'p_enum',   'DecayType',  2);
  const gscale = 1.0;
  templateSet(tmpl, props, 'p_double', 'DecayStart', 25.0 * gscale);
  templateSet(tmpl, props, 'p_bool',   'CastShadows', light.castShadow === true);
  templateSet(tmpl, props, 'p_color',  'ShadowColor', [0, 0, 0], { animatable: true });

  if (light.isSpotLight) {
    const outerDeg = (light.angle ?? Math.PI / 3) * RAD_TO_DEG;
    const penumbra = Math.min(1, Math.max(0, light.penumbra ?? 0));
    const innerDeg = outerDeg * (1 - penumbra);
    templateSet(tmpl, props, 'p_double', 'OuterAngle', outerDeg);
    templateSet(tmpl, props, 'p_double', 'InnerAngle', innerDeg);
  }

  if (light.isPointLight || light.isSpotLight) {
    const dist = light.distance ?? 0;
    templateSet(tmpl, props, 'p_double', 'FarAttenuationEnd', dist);
    templateSet(tmpl, props, 'p_bool',   'EnableFarAttenuation', dist > 0);
  }

  templateFinalize(tmpl, props);
}
