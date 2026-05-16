/**
 * Walk a three.js scene, classify each object into FBX entity categories,
 * dedupe shared BufferGeometry / Material instances, allocate UIDs, register
 * template users, and build the OO/OP connection graph.
 *
 * Mirrors Blender's `export_fbx_bin.py: fbx_data_from_scene` — same outputs
 * (uid-tagged entity lists + connections array) but driven by three.js's
 * Object3D / Mesh / SkinnedMesh / Skeleton / Bone / BufferGeometry / Material.
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

// FBX subtype string written as the Model's third property — matches
// fbx_data_object_elements (export_fbx_bin.py:1969). MUST stay in sync with
// modelSubtypeFor in builders/objects/model.js, otherwise SceneCollector and
// the Model writer disagree on how to bucket an object (e.g. AmbientLight
// goes to the Null branch in model.js but the Light branch here → orphan
// NodeAttribute).
function modelSubtypeFor(object) {
  if (object.isBone)                              return 'LimbNode';
  if (object.isMesh)                              return 'Mesh';
  if (object.isLight && !object.isAmbientLight)   return 'Light';
  if (object.isCamera)                            return 'Camera';
  return 'Null';
}

function isExportableNode(object: any, settings?: any): boolean {
  // Three.js Scene exists only as the FBX file root (Document.RootNode, uid=0);
  // we skip it during collection.
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
  // Apply tool preset defaults (unity / unreal / blender / maya / threejs)
  // BEFORE anything else looks at axisUp / axisForward / unitScale /
  // bakeSpaceTransform — user-provided options still win over the preset.
  settings = resolvePreset(settings);
  // Build the global coordinate-space transform context (axis conversion +
  // optional vertex/normal bake). Carried alongside the scene data so
  // geometry.js can apply it during export.
  const transformCtx = buildTransformContext(settings);

  // bake=true only bakes Vertices+Normals (see transforms.js limitation doc).
  // Warn when the scene contains anything else whose matrices would also need
  // baking to stay coherent with GlobalSettings.
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

  // Per-category registries
  const meshes = [];   // { object, uid, geometry, geomUid, materials, slotRemap, skin? }
  const empties = [];  // { object, uid, nodeAttrUid }     — Null / Group / Object3D
  const lights  = [];  // { object, uid, attrUid }
  const cameras = [];  // { object, uid, attrUid }
  // Auxiliary Null Models we emit for DirectionalLight / SpotLight .target
  // Object3Ds so FBXLoader can recover light direction via LookAtProperty.
  // Each entry: { target, uid, nodeAttrUid }. May reference a target that
  // is also in `empties` (when the user explicitly added it to the scene);
  // in that case we reuse the existing UID and do NOT emit a duplicate Model.
  const lightTargets = [];
  const bones = new Map();   // Bone → { uid, attrUid }
  const skins = [];          // { skinnedMesh, deformerUid, bindPoseUid, clusters: [...] }
  const geometries = new Map();  // BufferGeometry → { uid, key, refCount }
  const materials  = new Map();  // Material       → { uid, key, refCount }
  const connections = [];

  input.updateMatrixWorld(true);

  // GlobalSettings is always registered with users=1 (export_fbx_bin.py:2970).
  templates.register(globalSettingsTemplate(settings)).users = 1;

  // ---- pass 1: allocate UIDs, dedupe geometries & materials -------------
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
        skin: null,  // filled below if SkinnedMesh
        morph: null, // filled below if mesh has morphAttributes.position
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
      // DirectionalLight / SpotLight encode direction via a separate
      // `.target` Object3D in three.js. FBXLoader.setLookAtProperties
      // (FBXLoader.js:1502-1538) reconstructs `light.target.position`
      // from a sibling Model linked by an OP edge labelled
      // "LookAtProperty". We collect the target here; the writer side
      // emits an auxiliary Null Model + Properties70 entry below.
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
      // Null / Group / generic Object3D.
      const attrUid = uids.get(`${entityKey('object', object.uuid)}|NodeAttr|Null`);
      templates.register(nullTemplate(settings)).users += 1;
      empties.push({ object, uid: objUid, nodeAttrUid: attrUid });
    }
  });

  // ---- pass 2: build connection graph -----------------------------------

  // 2a. Object hierarchy: every Model gets one OO edge to its parent.
  // Mirrors export_fbx_bin.py:3051-3066. Bones are handled here too — their
  // parent is whatever Object3D they sit under in three.js (typically another
  // Bone, or an "armature" Group).
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

  // 2a'. Orphan bones — bones referenced by skeleton.bones but NOT in the
  // scene tree need their own Model+parent connection so FBXLoader's
  // parseModels visits them via fbxTree.Objects.Model. Without this, the
  // imported skeleton has `undefined` slots for detached source bones.
  for (const [bone, entry] of bones) {
    if (traversedUids.has(entry.uid)) continue;
    let parentUid = 0n;
    if (bone.parent && isExportableNode(bone.parent, settings)) {
      const pUid = uids.get(modelKey(bone.parent.uuid));
      // Only use the parent uid if that parent will itself be exported.
      if (traversedUids.has(pUid) || bones.has(bone.parent)) parentUid = pUid;
    }
    connections.push(['OO', entry.uid, parentUid]);
  }

  // 2b. NodeAttribute (Null) → its Model.
  for (const e of empties) {
    connections.push(['OO', e.nodeAttrUid, e.uid]);
  }

  // 2c. NodeAttribute (LimbNode) → Bone Model (export_fbx_bin.py:3072).
  for (const [, entry] of bones) {
    connections.push(['OO', entry.attrUid, entry.uid]);
  }

  // 2c'. NodeAttribute (Light) → Light Model (export_fbx_bin.py:3076).
  for (const e of lights) {
    connections.push(['OO', e.attrUid, e.uid]);
  }

  // 2c''. NodeAttribute (Camera) → Camera Model (export_fbx_bin.py:3079).
  for (const e of cameras) {
    connections.push(['OO', e.attrUid, e.uid]);
  }

  // 2c'''. Auxiliary light-target Null Models — emit only for targets not
  // already in the scene tree (e.g. the default Object3D three.js auto-
  // creates for DirectionalLight). When the user did `scene.add(light.target)`
  // explicitly, the main traverse already wired the OO/NodeAttr/Model
  // edges and we reuse them.
  for (const t of lightTargets) {
    if (traversedUids.has(t.uid)) continue;
    t.auxiliary = true;
    t.nodeAttrUid = uids.get(`${entityKey('object', t.target.uuid)}|NodeAttr|Null`);
    templates.register(nullTemplate(settings)).users += 1;
    templates.register(modelTemplate(settings)).users += 1;
    connections.push(['OO', t.nodeAttrUid, t.uid]);
    connections.push(['OO', t.uid, 0n]);  // parent = RootNode
  }

  // 2c''''. OP edge target → light, property "LookAtProperty".
  // FBXLoader (line 1510) reads connections.get(lightID).children where
  // child.relationship === 'LookAtProperty' and uses that node's
  // Lcl_Translation to set the light's target position.
  for (const l of lights) {
    if (l.targetUid != null) {
      connections.push(['OP', l.targetUid, l.uid, 'LookAtProperty']);
    }
  }

  // 2d. Geometry → Model.
  for (const m of meshes) {
    connections.push(['OO', m.geomUid, m.uid]);
  }

  // 2e. Material → Model. Order determines the FBX-side material index.
  for (const m of meshes) {
    for (const matEntry of m.materials) {
      connections.push(['OO', matEntry.uid, m.uid]);
    }
  }

  // 2f. Skin / Cluster / Bone chain (export_fbx_bin.py:3108-3113):
  //       OO Skin → Geometry
  //       OO Cluster → Skin
  //       OO Bone → Cluster
  for (const m of meshes) {
    if (!m.skin) continue;
    connections.push(['OO', m.skin.deformerUid, m.geomUid]);
    for (const c of m.skin.clusters) {
      connections.push(['OO', c.clusterUid, m.skin.deformerUid]);
      connections.push(['OO', c.boneEntry.uid, c.clusterUid]);
    }
  }

  // 2g. Morph (BlendShape) chain (export_fbx_bin.py:3092-3100):
  //       OO BlendShape         → base Geometry
  //       OO BlendShapeChannel  → BlendShape
  //       OO ShapeGeometry      → BlendShapeChannel
  for (const m of meshes) {
    if (!m.morph) continue;
    connections.push(['OO', m.morph.blendShapeUid, m.geomUid]);
    for (const channel of m.morph.channels) {
      connections.push(['OO', channel.channelUid, m.morph.blendShapeUid]);
      connections.push(['OO', channel.shapeGeomUid, channel.channelUid]);
    }
  }

  // ---- pass 2h: textures ------------------------------------------------
  // Detect textures on every material, allocate Texture+Video UIDs, and
  // add the OO/OP connections. Image bytes are filled in asynchronously
  // later by FBXExporter.parseAsync (textureCollector.encodeTextures).
  const textures = collectTextures({ materials, uids, templates, connections });

  // ---- pass 3: animation ------------------------------------------------
  // Must run AFTER pass 1 (so Model UIDs exist) and AFTER pass 2's hierarchy
  // connections (so animation OP edges go to existing Models).
  // `includeAnimations: false` short-circuits the whole pass — exports a
  // static T-pose mesh, no AnimStack / Curve nodes emitted.
  let clips;
  if (settings.includeAnimations === false) clips = [];
  else if (settings.animations) clips = settings.animations;
  else clips = collectAnimationClips(input);
  const animStacks = buildAnimationPlan({
    root: input, clips, uids, templates, settings, meshes,
  });

  // Resolve each AnimCurveNode's targetUid from the cached Model UIDs.
  // Bones, meshes, and Null empties all live in the same `uids` registry
  // under modelKey(object.uuid), so a single lookup covers all targets.
  // (Morph DeformPercent curve nodes set targetUid themselves to the
  //  BlendShapeChannel UID — leave those alone.)
  for (const stack of animStacks) {
    for (const cn of stack.curveNodes) {
      if (cn.targetUid == null) {
        cn.targetUid = uids.get(modelKey(cn.targetNode.uuid));
      }
    }
  }

  // Connection edges for animation. Mirrors export_fbx_bin.py:3166-3183.
  for (const stack of animStacks) {
    // OO  AnimLayer → AnimStack
    connections.push(['OO', stack.layerUid, stack.stackUid]);
    for (const cn of stack.curveNodes) {
      // OO  AnimCurveNode → AnimLayer
      connections.push(['OO', cn.curveNodeUid, stack.layerUid]);
      // OP  AnimCurveNode → Model (with FBX property name)
      connections.push(['OP', cn.curveNodeUid, cn.targetUid, cn.fbxProp]);
      // OP  AnimCurve → AnimCurveNode (with axis name "d|X")
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

  // ---- inner helpers ----------------------------------------------------

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
    // Both branches (scene-tree target / auxiliary target) share the same
    // modelKey, so `uids.get` is idempotent — we always end up with the
    // same UID whether ensureBone/main traverse hits it first or we do.
    // `auxiliary` + `nodeAttrUid` get resolved in pass 2 after we know
    // which Object3Ds the main traverse visited.
    const uid = uids.get(modelKey(target.uuid));
    lightTargets.push({ target, uid, nodeAttrUid: null, auxiliary: false });
    return uid;
  }

  function ensureBone(bone) {
    let entry = bones.get(bone);
    if (entry) return entry;
    const uid = uids.get(modelKey(bone.uuid));
    const attrUid = uids.get(boneAttrKey(bone.uuid, bone.uuid));
    // Model template was already bumped for this object in pass 1 — only
    // bump the bone NodeAttribute template here. Blender's
    // fbx_template_def_bone uses typeName="NodeAttribute" / propTypeName="LimbNode".
    templates.register(boneTemplate(settings)).users += 1;
    entry = { uid, attrUid };
    bones.set(bone, entry);
    return entry;
  }

  function collectSkin(skinnedMesh) {
    // Mirrors Blender's fbx_data_armature_elements + fbx_data_bindpose_element
    // for a single mesh-armature pair (lines 1812-1909, 726-762).
    const skeleton = skinnedMesh.skeleton;
    const skeletonBones = skeleton.bones;
    const boneInverses = skeleton.boneInverses;

    // bindMatrix is the mesh's world matrix at bind time.
    // (SkinnedMesh.bindMatrix is set by `bind(skeleton, bindMatrix)`; if user
    // never explicitly passes one, three.js defaults to the mesh's current
    // matrixWorld at bind time.)
    const bindMatrix = skinnedMesh.bindMatrix;

    const deformerUid = uids.get(skinDeformerKey(skinnedMesh.uuid, skinnedMesh.geometry.uuid));
    const bindPoseUid = uids.get(bindPoseKey(skinnedMesh.uuid, skinnedMesh.geometry.uuid));
    templates.register(deformerTemplate(settings)).users += 1; // for the Skin Deformer
    templates.register(poseTemplate(settings)).users += 1;     // for the BindPose

    // ---- bind-pose recovery ------------------------------------------
    // three.js's AnimationMixer mutates bone.position/rotation/scale in
    // place each frame, so by the time we read bone.matrix here the bone
    // may be sitting at an arbitrary animated pose. The FBX file must
    // declare bone Lcl T/R/S at BIND time (the rest pose used by the
    // cluster TransformLink/Transform matrices) — otherwise importers
    // see the bones and the skin weights disagree about where the
    // rest pose is, and the mesh deforms incorrectly.
    //
    // We can recover bind-time world matrices from `boneInverses[i]`
    // (which three.js freezes at bind via `skinnedMesh.bind()`):
    //   bone_world_bind = boneInverses[i].invert()
    // Local-from-world: if parent is in the same skeleton, divide it out;
    // otherwise treat world as local.
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
      if (entry.bindLocalMatrix) continue;  // first skin wins for shared bones
      const bw = bindWorldByBone.get(bone);
      // Parent's bind-time world matrix. For a bone parent → use the
      // boneInverses-recovered bind world. For a non-bone ancestor
      // (SkinnedMesh, Group, Scene) → AnimationMixer doesn't mutate it,
      // so its current matrixWorld IS its bind-time matrixWorld AS LONG
      // AS the caller hasn't externally rescaled it for viewport fitting.
      // (If the caller did rescale, they're expected to reset to identity
      // before invoking the exporter — see ComfyUI Load3d.ts's exportModel
      // wrapper-reset block.)
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

      // Each Cluster is its own Deformer node (with attrType="Cluster").
      const cKey = clusterKey(skinnedMesh.uuid, skinnedMesh.geometry.uuid, bone.uuid);
      const cUid = uids.get(cKey);
      templates.register(deformerTemplate(settings)).users += 1; // Cluster shares the Deformer template

      // Indices/weights for this bone — collected by walking the geometry's
      // skinIndex/skinWeight attributes (4 influences per vertex). Vertices
      // with zero weight on this bone are omitted (matches Blender).
      const { indices, weights } = sliceBoneInfluences(skinnedMesh.geometry, i);

      // TransformLink: bone's world matrix at bind time.
      //   boneInverses[i] = (bone.matrixWorld at bind).invert()
      //   => transformLink = boneInverses[i].invert()
      _tmpBoneWorld.copy(boneInverses[i]).invert();

      // Transform: per Blender (export_fbx_bin.py:1906-1907),
      //   transform = bone_world_at_bind.invert() × mesh_world_at_bind
      //             = boneInverses[i] × bindMatrix
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
 *
 * Mirrors Blender's vertex-group-to-cluster pre-process (export_fbx_bin.py:1868-1885).
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
      // attr.getX/Y/Z/W applies denormalize for Uint8/Uint16 attributes.
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
