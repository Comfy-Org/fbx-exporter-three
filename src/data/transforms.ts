/**
 * Coordinate space / unit scaling helpers.
 *
 * Two responsibilities:
 *
 *  1. Resolve a `preset` (`'unity' | 'unreal' | 'blender' | 'maya' | 'threejs'`)
 *     into concrete `axisUp` / `axisForward` / `unitScale` /
 *     `bakeSpaceTransform` settings. Three.js itself uses Y-up + Z-forward
 *     (same as Blender / Maya / Unity defaults). Only Unreal needs a different
 *     axis convention (Z-up, X-forward).
 *
 *  2. Compute the `globalMatrix` that maps three.js coordinates to the
 *     target axis convention, plus its inverse-transposed companion for
 *     normal vectors.
 *
 * When `bakeSpaceTransform: true`, the matrix is applied to vertex positions
 * + normals during geometry export. Object transforms keep
 * their original local TRS — only the geometry data shifts.
 *
 * When `bakeSpaceTransform: false`, the FBX file's GlobalSettings UpAxis /
 * FrontAxis / CoordAxis fields tell importers how to re-orient; vertices
 * stay in three.js's coordinate space. This is the lighter-touch option but
 * less portable (some importers ignore the axis fields).
 */

import { Matrix4 } from 'three';

/**
 * Tool-specific export presets. Picks the right axis conventions for
 * common targets so users don't memorise the FBX encoding.
 *
 * - threejs: identity output (Y-up Z-forward, meters). Matches three.js
 *   FBXLoader's expectations for clean round-trip.
 * - unity:   same as threejs (Unity defaults to Y-up Z-forward and the
 *   FBX importer respects file axes).
 * - unreal:  Z-up + X-forward (Unreal's native convention). bake disabled
 *   so the file declares axes in GlobalSettings and Unreal's own importer
 *   handles the rotation. See "About bakeSpaceTransform" below.
 * - blender: Y-up Z-forward. unitScale=100 because Blender stores meters
 *   but the FBX spec expects centimeters as the canonical unit.
 * - maya:    same as blender.
 *
 * Each preset is the DEFAULT; user-provided `axisUp` / `axisForward` /
 * `unitScale` / `bakeSpaceTransform` in options override the preset.
 *
 * About bakeSpaceTransform — known limitations:
 *   When bake=true, ONLY Vertices and Normals are pre-multiplied by
 *   globalMatrix. Object Lcl transforms, Cluster matrices, animation
 *   curves, and light/camera transforms are NOT baked. This means bake=true
 *   produces an internally INCONSISTENT file for any scene with non-
 *   origin object placement, skinning, animation, or lights/cameras.
 *
 *   For most workflows, leave bake=false: the FBX file declares its axes
 *   in GlobalSettings.UpAxis/FrontAxis/CoordAxis and modern importers
 *   (Unity, Unreal, Blender, Maya) respect them. The flag is kept as an
 *   opt-in for the narrow "single mesh, no transforms" Unreal asset case.
 */
export const PRESETS = {
  threejs: { axisUp: 'Y', axisForward: 'Z', unitScale: 1,   bakeSpaceTransform: false },
  unity:   { axisUp: 'Y', axisForward: 'Z', unitScale: 1,   bakeSpaceTransform: false },
  unreal:  { axisUp: 'Z', axisForward: 'X', unitScale: 1,   bakeSpaceTransform: false },
  blender: { axisUp: 'Y', axisForward: 'Z', unitScale: 100, bakeSpaceTransform: false },
  maya:    { axisUp: 'Y', axisForward: 'Z', unitScale: 100, bakeSpaceTransform: false },
};

/**
 * Apply a preset's defaults to a settings object. Explicit option values
 * always win over the preset; absent (undefined) keys fall through to the
 * preset value.
 *
 * If no `preset` is named, the 'threejs' preset is used as the fallback so
 * unset axis/unit keys land on sane Y-up Z-forward / scale=1 defaults.
 */
export function resolvePreset(settings) {
  settings = settings || {};
  const presetName = settings.preset || 'threejs';
  const preset = PRESETS[presetName];
  if (!preset) {
    console.warn(`fbx-exporter-three: unknown preset "${presetName}" — using as-is`);
    return { ...settings };
  }
  const merged = { ...preset };
  for (const k of Object.keys(settings)) {
    if (settings[k] !== undefined) merged[k] = settings[k];
  }
  return merged;
}


const AXIS_VECS = {
  'X':  [1,  0,  0],
  '-X': [-1, 0,  0],
  'Y':  [0,  1,  0],
  '-Y': [0, -1,  0],
  'Z':  [0,  0,  1],
  '-Z': [0,  0, -1],
};

/**
 * Build a rotation matrix that maps three.js's (Y-up, -Z-forward) axes to
 * the FBX file's chosen (axisUp, axisForward) axes.
 */
export function buildAxisMatrix(axisUp, axisForward) {

  const up = AXIS_VECS[axisUp];
  const fwd = AXIS_VECS[axisForward];
  if (!up || !fwd) {
    throw new Error(`buildAxisMatrix: invalid axes axisUp=${axisUp} axisForward=${axisForward}`);
  }

  const right = [
    up[1] * fwd[2] - up[2] * fwd[1],
    up[2] * fwd[0] - up[0] * fwd[2],
    up[0] * fwd[1] - up[1] * fwd[0],
  ];

  const m = new Matrix4();
  m.set(
    right[0], up[0], fwd[0], 0,
    right[1], up[1], fwd[1], 0,
    right[2], up[2], fwd[2], 0,
    0,        0,     0,      1,
  );
  return m;
}

/**
 * Resolve a settings bag into a full `transformContext`:
 *   - `globalMatrix`: axis + scale matrix to apply if bakeSpaceTransform
 *   - `globalMatrixInvTransposed`: for normals (translation stripped + normalized)
 *   - `bake`: whether vertex/normal data should be pre-multiplied
 *   - `unitScale`: the resolved UnitScaleFactor to write into GlobalSettings
 */
export function buildTransformContext(settings) {
  const axisUp = settings.axisUp ?? 'Y';
  const axisForward = settings.axisForward ?? 'Z';
  const unitScale = settings.unitScale ?? 1.0;
  const bake = settings.bakeSpaceTransform === true;

  const globalMatrix = buildAxisMatrix(axisUp, axisForward);
  if (bake && unitScale !== 1.0) {
    const scaled = new Matrix4().makeScale(unitScale, unitScale, unitScale);
    globalMatrix.premultiply(scaled);
  }

  const inv = new Matrix4().copy(globalMatrix).invert();
  const invT = transposeMatrix4(inv);
  invT.elements[12] = invT.elements[13] = invT.elements[14] = 0;

  return {
    axisUp, axisForward, unitScale,
    bake,
    globalMatrix,
    globalMatrixInvTransposed: invT,
    isIdentity: bake ? matrixIsIdentity(globalMatrix) : true,
  };
}

function transposeMatrix4(m) {
  const e = m.elements;
  const t = new Matrix4();
  t.set(
    e[0], e[1], e[2], e[3],
    e[4], e[5], e[6], e[7],
    e[8], e[9], e[10], e[11],
    e[12], e[13], e[14], e[15],
  );
  return t;
}

function matrixIsIdentity(m) {
  const e = m.elements;
  for (let i = 0; i < 16; i++) {
    const expected = (i === 0 || i === 5 || i === 10 || i === 15) ? 1 : 0;
    if (Math.abs(e[i] - expected) > 1e-9) return false;
  }
  return true;
}


/**
 * In-place apply a Matrix4 (rotation + uniform/non-uniform scale) to a
 * flat XYZ Float64 vertex buffer. Matrix is column-major Matrix4.elements.
 */
export function bakeVertices(verts, matrix) {
  const e = matrix.elements;
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    verts[i]     = e[0] * x + e[4] * y + e[8]  * z + e[12];
    verts[i + 1] = e[1] * x + e[5] * y + e[9]  * z + e[13];
    verts[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
}

/**
 * In-place apply a Matrix4's rotation (3x3 upper-left) to a flat XYZ Float64
 * normal buffer. Caller passes the INVERSE-TRANSPOSED matrix (build via
 * buildTransformContext). Optionally normalises if the source matrix had
 * scale.
 */
export function bakeNormals(normals, invTransposed) {
  const e = invTransposed.elements;
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];
    let nx = e[0] * x + e[4] * y + e[8]  * z;
    let ny = e[1] * x + e[5] * y + e[9]  * z;
    let nz = e[2] * x + e[6] * y + e[10] * z;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
    normals[i]     = nx;
    normals[i + 1] = ny;
    normals[i + 2] = nz;
  }
}
