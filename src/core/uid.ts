/**
 * Stable string-key → 64-bit FBX UID generator with collision-resistant caching.
 *
 * Mirrors `fbx_utils.py: get_fbx_uuid_from_key` (Blender). Blender uses Python's
 * non-deterministic `hash()`; we use FNV-1a-64 so two runs of the exporter on the
 * same scene produce byte-identical files (good for diffing & tests).
 *
 * FBX UIDs are signed int64. We keep generated values below 2^63 (mirrors
 * Blender's check) and resolve collisions by linear probing.
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME  = 0x00000100000001b3n;
const I64_MAX    = (1n << 63n) - 1n;
const SHRINK_MOD = 1_000_000_000n;

/** FNV-1a hash over UTF-8 bytes of `s`, returned as BigInt in [0, 2^64). */
function fnv1a64(s) {
  let h = FNV_OFFSET;
  // TextEncoder is roughly 2× faster than per-char charCodeAt for typical key sizes
  const bytes = new TextEncoder().encode(s);
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * FNV_PRIME) & 0xffffffffffffffffn;
  }
  return h;
}

export class UidRegistry {
  _keyToUid: Map<string, bigint>;
  _uidToKey: Map<bigint, string>;

  constructor() {
    this._keyToUid = new Map();
    this._uidToKey = new Map();
  }

  /**
   * Return a stable 64-bit UID for `key`. Two calls with the same string
   * return the same UID. Different strings get different UIDs (collisions
   * resolved by linear probing).
   *
   * @param {string} key
   * @returns {bigint}
   */
  get(key) {
    const cached = this._keyToUid.get(key);
    if (cached !== undefined) return cached;

    let uid = fnv1a64(key);
    // Keep within signed int64 positive range (Blender does the same).
    if (uid > I64_MAX) uid &= I64_MAX;

    // Mirror Blender's "shorten if possible" trick — keeps UIDs friendly for debugging.
    if (uid > SHRINK_MOD) {
      const shrunk = uid % SHRINK_MOD;
      if (!this._uidToKey.has(shrunk)) uid = shrunk;
    }

    // Linear-probe to ensure uniqueness.
    while (this._uidToKey.has(uid)) {
      uid = uid >= (1n << 62n) ? uid - 1n : uid + 1n;
      if (uid < 0n || uid > I64_MAX) {
        throw new Error(`Unable to allocate FBX UID for key "${key}"`);
      }
    }

    this._keyToUid.set(key, uid);
    this._uidToKey.set(uid, key);
    return uid;
  }

  /** Reverse lookup (debugging). */
  keyOf(uid) {
    return this._uidToKey.get(uid);
  }

  /** Number of allocated UIDs. */
  get size() {
    return this._keyToUid.size;
  }
}

// ---------------------------------------------------------------------------
// Key-builder helpers — mirror fbx_utils.py: get_blenderID_key, get_blender_bone_key, ...
// We produce strings instead of tuples; the consumer maps these strings via a UidRegistry.
// ---------------------------------------------------------------------------

const TYPE_TAG = {
  scene: 'Scene',
  object: 'Object',
  mesh: 'Mesh',
  geometry: 'Geometry',
  material: 'Material',
  texture: 'Texture',
  video: 'Video',
  light: 'Light',
  camera: 'Camera',
  bone: 'Bone',
  armature: 'Armature',
  skeleton: 'Skeleton',
  animstack: 'AnimStack',
  animlayer: 'AnimLayer',
  animcurvenode: 'AnimCurveNode',
  animcurve: 'AnimCurve',
};

/** Stable string key for an arbitrary scene entity. `id` is usually `object.uuid`. */
export function entityKey(typeName, id) {
  const tag = TYPE_TAG[typeName] ?? typeName;
  return `B${tag}#${id}`;
}

export function geometryKey(objectUuid)         { return `${entityKey('mesh', objectUuid)}|Geometry`; }
export function materialKey(materialUuid)       { return entityKey('material', materialUuid); }
export function textureKey(textureUuid)         { return entityKey('texture', textureUuid); }
export function videoKey(textureUuid)           { return `${entityKey('texture', textureUuid)}|Video`; }
export function modelKey(objectUuid)            { return entityKey('object', objectUuid); }
export function boneKey(armatureUuid, boneUuid) { return `${entityKey('armature', armatureUuid)}|${entityKey('bone', boneUuid)}`; }
export function boneAttrKey(armatureUuid, boneUuid) {
  return `${boneKey(armatureUuid, boneUuid)}|Data`;
}
export function skinDeformerKey(armatureUuid, meshUuid) {
  return `${entityKey('armature', armatureUuid)}|${entityKey('mesh', meshUuid)}|DeformerSkin`;
}
export function clusterKey(armatureUuid, meshUuid, boneUuid) {
  return `${entityKey('armature', armatureUuid)}|${entityKey('mesh', meshUuid)}|${entityKey('bone', boneUuid)}|SubDeformerCluster`;
}
export function bindPoseKey(objectUuid, meshUuid) {
  return `${entityKey('object', objectUuid)}|${entityKey('mesh', meshUuid)}|BindPose`;
}
export function animStackKey(clipUuid) { return `${entityKey('animstack', clipUuid)}`; }
export function animLayerKey(clipUuid) { return `${entityKey('animstack', clipUuid)}|Layer`; }
export function animCurveNodeKey(clipUuid, targetUuid, propName) {
  return `${animLayerKey(clipUuid)}|${entityKey('animcurvenode', targetUuid)}|${propName}`;
}
export function animCurveKey(clipUuid, targetUuid, propName, axis) {
  return `${animCurveNodeKey(clipUuid, targetUuid, propName)}|${axis}`;
}
export const documentKey = (name) => `__FBX_Document__${name}`;

// Morph (BlendShape) deformer keys — mirror Blender's
// get_blender_mesh_shape_key / get_blender_mesh_shape_channel_key.
export const blendShapeDeformerKey = (geometryUuid) =>
  `${entityKey('geometry', geometryUuid)}|BlendShape`;
export const blendShapeChannelKey = (geometryUuid, channelIndex, channelName) =>
  `${entityKey('geometry', geometryUuid)}|BlendShapeChannel|${channelIndex}|${channelName}`;
export const shapeGeometryKey = (geometryUuid, channelIndex, channelName) =>
  `${entityKey('geometry', geometryUuid)}|Shape|${channelIndex}|${channelName}`;

// Exported for tests.
export const __testing__ = { fnv1a64 };
