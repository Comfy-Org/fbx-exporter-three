/**
 * three.js Camera → FBX `NodeAttribute::Camera`.
 *
 * Mirrors `export_fbx_bin.py: fbx_data_camera_elements` (lines 634-723).
 *
 * Supported types:
 *   PerspectiveCamera   → CameraProjectionType=0
 *   OrthographicCamera  → CameraProjectionType=1  (FBXLoader logs a warning
 *                                                  and falls back to Object3D;
 *                                                  Maya / Unreal handle it.)
 *
 * FBXLoader.js:1140-1227 reads:
 *   CameraProjectionType   → 0 perspective / 1 orthographic
 *   NearPlane              → near / 1000   ← three.js FBXLoader quirk
 *   FarPlane               → far  / 1000   ← same quirk
 *   AspectWidth / Height   → aspect = w/h
 *   FieldOfView            → fov (degrees, used directly)
 *   FocalLength            → camera.setFocalLength()
 *
 * On the near/far division: FBXLoader hardcodes /1000, presumably assuming
 * the file is in millimeters. Blender writes `clip_start * gscale` (where
 * gscale is typically 100 for cm units), producing a 10x error on the
 * three.js side. We match Blender's formula exactly — written values are
 * `near × settings.unitScale`. Three.js → FBX → three.js round-trip of
 * near/far is off by 1/(1000/unitScale), a known three.js FBXLoader issue.
 */

import {
  elemDataSingleInt32, elemDataSingleString, elemDataSingleFloat64,
  elemProperties, fbxNameClass,
  templateInit, templateSet, templateFinalize,
} from '../../core/elemHelpers.js';
import { FBX_GEOMETRY_VERSION } from '../../constants.js';

const RAD_TO_DEG = 180 / Math.PI;

/**
 * @param {object}      ctx
 * @param {FBXElem}     ctx.parent
 * @param {Camera}      ctx.camera
 * @param {bigint}      ctx.attrUid
 * @param {TemplateBundle} ctx.templates
 * @param {object}      [ctx.settings]
 */
export function writeCameraAttribute({ parent, camera, attrUid, templates, settings = {} }: any) {
  const node = parent.addEmpty('NodeAttribute');
  node.addInt64(attrUid);
  node.addString(fbxNameClass(camera.name || 'Camera', 'NodeAttribute'));
  node.addString('Camera');

  const tmpl = templateInit(templates, 'NodeAttribute');
  const props = elemProperties(node);

  const isOrtho = camera.isOrthographicCamera === true;
  templateSet(tmpl, props, 'p_enum', 'CameraProjectionType', isOrtho ? 1 : 0);

  // Aspect — three.js PerspectiveCamera has `.aspect` (w/h ratio). FBX wants
  // AspectWidth / AspectHeight; the ratio is what FBXLoader uses (line 1195).
  // We pick a sensible HD reference resolution. Override by user via settings.
  const aspect = camera.aspect ?? (16 / 9);
  const aspectW = settings.cameraAspectWidth ?? 1920;
  const aspectH = aspectW / aspect;
  templateSet(tmpl, props, 'p_enum',   'AspectRatioMode', 2);  // FixedResolution
  templateSet(tmpl, props, 'p_double', 'AspectWidth',  aspectW);
  templateSet(tmpl, props, 'p_double', 'AspectHeight', aspectH);
  templateSet(tmpl, props, 'p_double', 'PixelAspectRatio', 1.0);

  // Field of view — three.js fov is in DEGREES already (different from
  // basically everything else in three.js). FBX wants degrees too.
  // FieldOfViewX / Y are horizontal / vertical; three.js fov is vertical.
  const fovY = camera.fov ?? 50;
  const fovX = fovY * aspect;  // approximate horizontal fov
  templateSet(tmpl, props, 'p_fov',   'FieldOfView',  fovY, { animatable: true });
  templateSet(tmpl, props, 'p_fov_x', 'FieldOfViewX', fovX, { animatable: true });
  templateSet(tmpl, props, 'p_fov_y', 'FieldOfViewY', fovY, { animatable: true });

  // FocalLength — FBXLoader calls camera.setFocalLength(focalLength) on
  // import (line 1210). Three.js PerspectiveCamera.getFocalLength() derives
  // this from .fov and .filmGauge; reverse via camera.getFocalLength().
  const focalLength = camera.getFocalLength ? camera.getFocalLength() : 35.0;
  templateSet(tmpl, props, 'p_double', 'FocalLength', focalLength, { animatable: true });

  // Near / Far. See module docstring on the /1000 quirk.
  const unitScale = settings.unitScale ?? 1.0;
  const near = (camera.near ?? 0.1) * unitScale;
  const far  = (camera.far  ?? 2000) * unitScale;
  templateSet(tmpl, props, 'p_double', 'NearPlane', near);
  templateSet(tmpl, props, 'p_double', 'FarPlane',  far);
  templateSet(tmpl, props, 'p_enum',   'BackPlaneDistanceMode', 1);  // RelativeToCamera
  templateSet(tmpl, props, 'p_double', 'BackPlaneDistance',     far, { animatable: true });

  // Orthographic scale — Blender's OrthoZoom corresponds to three.js's
  // (right - left) for an OrthographicCamera; we encode the width.
  if (isOrtho) {
    const orthoWidth = (camera.right ?? 1) - (camera.left ?? -1);
    templateSet(tmpl, props, 'p_double', 'OrthoZoom', orthoWidth);
  }

  templateFinalize(tmpl, props);

  // Trailing top-level fields (NOT inside Properties70) — matches Blender
  // exactly (lines 715-723). FBXLoader doesn't read these, but Maya does.
  elemDataSingleString(node, 'TypeFlags',       'Camera');
  elemDataSingleInt32(node,  'GeometryVersion', FBX_GEOMETRY_VERSION);  // 124
  // Position / Up / LookAt: legacy NodeAttribute fields. Emit canonical
  // zeros — FBXLoader reads the Model's Lcl Translation/Rotation instead.
  emitVecChild(node, 'Position', [0, 0, 0]);
  emitVecChild(node, 'Up',       [0, 1, 0]);
  emitVecChild(node, 'LookAt',   [0, 0, -1]);
  elemDataSingleInt32(node,  'ShowInfoOnMoving', 1);
  elemDataSingleInt32(node,  'ShowAudio',        0);
  emitVecChild(node, 'AudioColor', [0, 1, 0]);
  elemDataSingleFloat64(node, 'CameraOrthoZoom', 1.0);
}

function emitVecChild(parent, name, [x, y, z]) {
  const e = parent.addEmpty(name);
  e.addFloat64(x);
  e.addFloat64(y);
  e.addFloat64(z);
}
