/**
 * Walk a three.js scene, classify each object into FBX entity categories,
 * dedupe shared BufferGeometry / Material instances, allocate UIDs, register
 * template users, and build the OO/OP connection graph.
 */

import { Matrix4 } from 'three';
import {
  UidRegistry,
  entityKey, geometryKey, materialKey, modelKey,
  boneAttrKey, skinDeformerKey, clusterKey, bindPoseKey,
} from '../core/uid.js';
import {
  TemplateBundle,
  modelTemplate, geometryTemplate, materialTemplate, nullTemplate,
  globalSettingsTemplate, boneTemplate, deformerTemplate, poseTemplate,
  lightTemplate, cameraTemplate,
} from '../core/templates.js';
import { collectAnimationClips, buildAnimationPlan } from './animationCollector.js';
import { collectMorph } from './morphCollector.js';
import { collectTextures } from './textureCollector.js';
import { resolvePreset, buildTransformContext } from './transforms.js';

const _tmpBoneWorld = new Matrix4();
const _tmpBoneInv = new Matrix4();
const _tmpClusterTransform = new Matrix4();

function modelSubtypeFor(object) {
  if (object.isBone)                              return 'LimbNode';
  if (object.isMesh)                              return 'Mesh';
  if (object.isLight && !object.isAmbientLight)   return 'Light';
  if (object.isCamera)                            return 'Camera';
  return 'Null';
}

function isExportableNode(object: any, settings?: any): boolean {
  if (object.isScene) return false;
  if (settings && settings.onlyVisible && object.visible === false) return false;
  if (settings && typeof settings.objectFilter === 'function' &&
      settings.objectFilter(object) === false) {
    return false;
  }
  return true;
}

/**
 * Build the export plan for `input`. Caller owns the result; pass it through
 * to the builders.
 */
export function collectScene(input: any, settings: any = {}): any {
  settings = resolvePreset(settings);
  const transformCtx = buildTransformContext(settings);

  if (transformCtx.bake && !transformCtx.isIdentity && !settings._suppressBakeWarning) {
    let unsafe = false;
    input.traverse((o) => {
      if (unsafe || o.isScene) return;
      if (o.isSkinnedMesh || o.isLight || o.isCamera) { unsafe = true; return; }
      if (o.isMesh && (o.position.lengthSq() > 1e-12 ||
                       o.quaternion.x ** 2 + o.quaternion.y ** 2 + o.quaternion.z ** 2 > 1e-12)) {
        unsafe = true;
      }
    });
    if (unsafe) {
      console.warn(
        'fbx-exporter-three: bakeSpaceTransform=true currently bakes only ' +
        'Vertices+Normals. The scene contains object transforms / skinning / ' +
        'animation / lights / cameras whose matrices will NOT be baked, ' +
        'leaving the output file internally inconsistent. Pass ' +
        '{ bakeSpaceTransform: false } unless your scene is a single mesh ' +
        'at the origin.',
      );
    }
  }

  const uids = new UidRegistry();
  const templates = new TemplateBundle();

  const meshes = [];
  const empties = [];
  const lights  = [];
  const cameras = [];
  const lightTargets = [];
  const bones = new Map();
  const skins = [];
  const geometries = new Map();
  const materials  = new Map();
  const connections = [];

  input.updateMatrixWorld(true);

  templates.register(globalSettingsTemplate(settings)).users = 1;

  input.traverse((object) => {
    if (!isExportableNode(object, settings)) return;

    const subtype = modelSubtypeFor(object);
    const objUid = uids.get(modelKey(object.uuid));
    templates.register(modelTemplate(settings)).users += 1;

    if (subtype === 'Mesh') {
      const geomEntry = ensureGeometry(object.geometry);
      const { entries: matEntries, slotRemap } = collectMaterials(object);
      const meshEntry = {
        object,
        uid: objUid,
        geometry: object.geometry,
        geomUid: geomEntry.uid,
        materials: matEntries,
        slotRemap,
        skin: null,
        morph: null,
      };
      meshes.push(meshEntry);

      if (object.isSkinnedMesh && object.skeleton && object.skeleton.bones.length > 0) {
        meshEntry.skin = collectSkin(object);
      }
      meshEntry.morph = collectMorph({ mesh: object, uids, templates });
    } else if (subtype === 'LimbNode') {
      ensureBone(object);
    } else if (subtype === 'Light') {
      const attrUid = uids.get(`${entityKey('object', object.uuid)}|NodeAttr|Light`);
      templates.register(lightTemplate(settings)).users += 1;
      let targetUid = null;
      if ((object.isDirectionalLight || object.isSpotLight) && object.target) {
        targetUid = ensureLightTarget(object.target);
      }
      lights.push({ object, uid: objUid, attrUid, targetUid });
    } else if (subtype === 'Camera') {
      const attrUid = uids.get(`${entityKey('object', object.uuid)}|NodeAttr|Camera`);
      templates.register(cameraTemplate(settings)).users += 1;
      cameras.push({ object, uid: objUid, attrUid });
    } else {
      const attrUid = uids.get(`${entityKey('object', object.uuid)}|NodeAttr|Null`);
      templates.register(nullTemplate(settings)).users += 1;
      empties.push({ object, uid: objUid, nodeAttrUid: attrUid });
    }
  });


  const traversedUids = new Set();
  input.traverse((object) => {
    if (!isExportableNode(object, settings)) return;
    const childUid = uids.get(modelKey(object.uuid));
    traversedUids.add(childUid);
    let parentUid = 0n;
    if (object.parent && isExportableNode(object.parent, settings)) {
      parentUid = uids.get(modelKey(object.parent.uuid));
    }
    connections.push(['OO', childUid, parentUid]);
  });

  for (const [bone, entry] of bones) {
    if (traversedUids.has(entry.uid)) continue;
    let parentUid = 0n;
    if (bone.parent && isExportableNode(bone.parent, settings)) {
      const pUid = uids.get(modelKey(bone.parent.uuid));
      if (traversedUids.has(pUid) || bones.has(bone.parent)) parentUid = pUid;
    }
    connections.push(['OO', entry.uid, parentUid]);
  }

  for (const e of empties) {
    connections.push(['OO', e.nodeAttrUid, e.uid]);
  }

  for (const [, entry] of bones) {
    connections.push(['OO', entry.attrUid, entry.uid]);
  }

  for (const e of lights) {
    connections.push(['OO', e.attrUid, e.uid]);
  }

  for (const e of cameras) {
    connections.push(['OO', e.attrUid, e.uid]);
  }

  for (const t of lightTargets) {
    if (traversedUids.has(t.uid)) continue;
    t.auxiliary = true;
    t.nodeAttrUid = uids.get(`${entityKey('object', t.target.uuid)}|NodeAttr|Null`);
    templates.register(nullTemplate(settings)).users += 1;
    templates.register(modelTemplate(settings)).users += 1;
    connections.push(['OO', t.nodeAttrUid, t.uid]);
    connections.push(['OO', t.uid, 0n]);
  }

  for (const l of lights) {
    if (l.targetUid != null) {
      connections.push(['OP', l.targetUid, l.uid, 'LookAtProperty']);
    }
  }

  for (const m of meshes) {
    connections.push(['OO', m.geomUid, m.uid]);
  }

  for (const m of meshes) {
    for (const matEntry of m.materials) {
      connections.push(['OO', matEntry.uid, m.uid]);
    }
  }

  for (const m of meshes) {
    if (!m.skin) continue;
    connections.push(['OO', m.skin.deformerUid, m.geomUid]);
    for (const c of m.skin.clusters) {
      connections.push(['OO', c.clusterUid, m.skin.deformerUid]);
      connections.push(['OO', c.boneEntry.uid, c.clusterUid]);
    }
  }

  for (const m of meshes) {
    if (!m.morph) continue;
    connections.push(['OO', m.morph.blendShapeUid, m.geomUid]);
    for (const channel of m.morph.channels) {
      connections.push(['OO', channel.channelUid, m.morph.blendShapeUid]);
      connections.push(['OO', channel.shapeGeomUid, channel.channelUid]);
    }
  }

  const textures = collectTextures({ materials, uids, templates, connections });

  let clips;
  if (settings.includeAnimations === false) clips = [];
  else if (settings.animations) clips = settings.animations;
  else clips = collectAnimationClips(input);
  const animStacks = buildAnimationPlan({
    root: input, clips, uids, templates, settings, meshes,
  });

  for (const stack of animStacks) {
    for (const cn of stack.curveNodes) {
      if (cn.targetUid == null) {
        cn.targetUid = uids.get(modelKey(cn.targetNode.uuid));
      }
    }
  }

  for (const stack of animStacks) {
    connections.push(['OO', stack.layerUid, stack.stackUid]);
    for (const cn of stack.curveNodes) {
      connections.push(['OO', cn.curveNodeUid, stack.layerUid]);
      connections.push(['OP', cn.curveNodeUid, cn.targetUid, cn.fbxProp]);
      for (const curve of cn.curves) {
        connections.push(['OP', curve.uid, cn.curveNodeUid, `d|${curve.axis}`]);
      }
    }
  }

  return {
    settings,
    uids,
    templates,
    meshes,
    empties,
    bones,
    skins,
    geometries,
    materials,
    lights,
    cameras,
    lightTargets,
    textures,
    animStacks,
    connections,
    rootInput: input,
    transformCtx,
  };

  function ensureGeometry(geometry) {
    let entry = geometries.get(geometry);
    if (entry) {
      entry.refCount++;
      return entry;
    }
    const key = geometryKey(geometry.uuid);
    const uid = uids.get(key);
    templates.register(geometryTemplate(settings)).users += 1;
    entry = { uid, key, refCount: 1 };
    geometries.set(geometry, entry);
    return entry;
  }

  function ensureLightTarget(target) {
    const existing = lightTargets.find((t) => t.target === target);
    if (existing) return existing.uid;
    const uid = uids.get(modelKey(target.uuid));
    lightTargets.push({ target, uid, nodeAttrUid: null, auxiliary: false });
    return uid;
  }

  function ensureBone(bone) {
    let entry = bones.get(bone);
    if (entry) return entry;
    const uid = uids.get(modelKey(bone.uuid));
    const attrUid = uids.get(boneAttrKey(bone.uuid, bone.uuid));
    templates.register(boneTemplate(settings)).users += 1;
    entry = { uid, attrUid };
    bones.set(bone, entry);
    return entry;
  }

  function collectSkin(skinnedMesh) {
    const skeleton = skinnedMesh.skeleton;
    const skeletonBones = skeleton.bones;
    const boneInverses = skeleton.boneInverses;

    const bindMatrix = skinnedMesh.bindMatrix;

    const deformerUid = uids.get(skinDeformerKey(skinnedMesh.uuid, skinnedMesh.geometry.uuid));
    const bindPoseUid = uids.get(bindPoseKey(skinnedMesh.uuid, skinnedMesh.geometry.uuid));
    templates.register(deformerTemplate(settings)).users += 1;
    templates.register(poseTemplate(settings)).users += 1;

    const bindWorldByBone = new Map();
    for (let i = 0; i < skeletonBones.length; i++) {
      const b = skeletonBones[i];
      if (b && !bindWorldByBone.has(b)) {
        bindWorldByBone.set(b, new Matrix4().copy(boneInverses[i]).invert());
      }
    }
    for (const bone of skeletonBones) {
      if (!bone) continue;
      const entry = ensureBone(bone);
      if (entry.bindLocalMatrix) continue;
      const bw = bindWorldByBone.get(bone);
      const parent = bone.parent;
      let parentBindWorld;
      if (parent && bindWorldByBone.has(parent)) {
        parentBindWorld = bindWorldByBone.get(parent);
      } else if (parent) {
        parentBindWorld = parent.matrixWorld;
      }
      const local = parentBindWorld
        ? new Matrix4().copy(parentBindWorld).invert().multiply(bw)
        : bw.clone();
      entry.bindLocalMatrix = local;
    }

    const clusters = [];
    for (let i = 0; i < skeletonBones.length; i++) {
      const bone = skeletonBones[i];
      if (!bone) continue;
      const boneEntry = ensureBone(bone);

      const cKey = clusterKey(skinnedMesh.uuid, skinnedMesh.geometry.uuid, bone.uuid);
      const cUid = uids.get(cKey);
      templates.register(deformerTemplate(settings)).users += 1;

      const { indices, weights } = sliceBoneInfluences(skinnedMesh.geometry, i);

      _tmpBoneWorld.copy(boneInverses[i]).invert();

      _tmpClusterTransform.copy(boneInverses[i]).multiply(bindMatrix);

      clusters.push({
        boneIdx: i,
        bone,
        boneEntry,
        clusterUid: cUid,
        clusterKey: cKey,
        indices,
        weights,
        transform: _tmpClusterTransform.clone(),
        transformLink: _tmpBoneWorld.clone(),
      });
    }

    const skinEntry = {
      skinnedMesh,
      deformerUid,
      bindPoseUid,
      bindMatrix: bindMatrix.clone(),
      clusters,
    };
    skins.push(skinEntry);
    return skinEntry;
  }

  function collectMaterials(mesh) {
    const raw = mesh.material;
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const entries = [];
    const firstFbxIndexForMaterial = new Map();
    const slotRemap = new Array(list.length);

    let fbxIdx = 0;
    for (let i = 0; i < list.length; i++) {
      const mat = list[i];
      if (!mat) { slotRemap[i] = 0; continue; }
      const cached = firstFbxIndexForMaterial.get(mat);
      if (cached !== undefined) { slotRemap[i] = cached; continue; }
      let entry = materials.get(mat);
      if (!entry) {
        const key = materialKey(mat.uuid);
        const uid = uids.get(key);
        templates.register(materialTemplate(settings)).users += 1;
        entry = { uid, key, refCount: 0 };
        materials.set(mat, entry);
      }
      entry.refCount++;
      firstFbxIndexForMaterial.set(mat, fbxIdx);
      slotRemap[i] = fbxIdx;
      entries.push({ material: mat, uid: entry.uid, slot: fbxIdx });
      fbxIdx++;
    }

    return { entries, slotRemap };
  }
}

/**
 * For a given bone index `bi`, sweep the geometry's skinIndex/skinWeight
 * attributes and collect every (vertex, weight) pair where the bone is one
 * of that vertex's 4 influences and weight > 0.
 */
function sliceBoneInfluences(geometry, boneIdx) {
  const idxAttr = geometry.attributes.skinIndex;
  const wAttr = geometry.attributes.skinWeight;
  if (!idxAttr || !wAttr) return { indices: [], weights: [] };
  const count = idxAttr.count;
  const indices = [];
  const weights = [];
  for (let v = 0; v < count; v++) {
    for (let k = 0; k < 4; k++) {
      const b = k === 0 ? idxAttr.getX(v)
              : k === 1 ? idxAttr.getY(v)
              : k === 2 ? idxAttr.getZ(v)
              :           idxAttr.getW(v);
      if (b !== boneIdx) continue;
      const w = k === 0 ? wAttr.getX(v)
              : k === 1 ? wAttr.getY(v)
              : k === 2 ? wAttr.getZ(v)
              :           wAttr.getW(v);
      if (w > 0) {
        indices.push(v);
        weights.push(w);
      }
    }
  }
  return { indices, weights };
}
