/**
 * Pipeline orchestrator — produces a complete FBX `FBXElem` tree from a
 * collected SceneData, then hands it to `encodeBinaryFBX`.
 *
 * Mirrors `export_fbx_bin.py: save_single` (lines 3494-3645), specifically
 * the second half (lines 3608-3635) that drives the per-section builders in
 * order:
 *   1. fbx_header_elements      → header.js
 *   2. fbx_documents_elements   → header.js (writeDocuments)
 *   3. fbx_references_elements  → header.js
 *   4. fbx_definitions_elements → definitions.js
 *   5. fbx_objects_elements     → builders/objects/*
 *   6. fbx_connections_elements → connections.js
 *   7. fbx_takes_elements       → empty Takes stub
 */

import { Vector3 } from 'three';
import { FBXElem } from './core/FBXElem.js';
import { encodeBinaryFBX } from './core/encodeBinary.js';
import { FBX_VERSION } from './constants.js';

const _tmpWorldPos = new Vector3();

import { writeHeaderSection } from './builders/header.js';
import { writeDefinitionsSection } from './builders/definitions.js';
import { writeConnectionsSection } from './builders/connections.js';

import { writeGeometry } from './builders/objects/geometry.js';
import { writeModel, writeNullAttribute } from './builders/objects/model.js';
import { writeMaterial } from './builders/objects/material.js';
import { writeBoneAttribute } from './builders/objects/bone.js';
import { writeSkinDeformer, writeBindPose } from './builders/objects/skin.js';
import { writeAnimationNodes } from './builders/objects/animation.js';
import { writeMorph } from './builders/objects/morph.js';
import { writeLightAttribute } from './builders/objects/light.js';
import { writeCameraAttribute } from './builders/objects/camera.js';
import { writeTexture, writeVideo } from './builders/objects/texture.js';

/**
 * @param {ReturnType<import('./data/SceneCollector.js').collectScene>} sceneData
 * @returns {Uint8Array}
 */
export function writeFBX(sceneData) {
  const { settings, templates, meshes, empties, bones, lights, cameras, lightTargets, materials, textures, animStacks, connections, rootInput } = sceneData;
  const version = settings.version ?? FBX_VERSION;

  const root = new FBXElem('');

  // ---- 1-3. Header / Documents / References ---------------------------
  writeHeaderSection({
    root,
    settings: { ...settings, version },
    sceneName: rootInput.name || 'Scene',
  });

  // ---- 4. Definitions -------------------------------------------------
  writeDefinitionsSection({ root, templates });

  // ---- 5. Objects -----------------------------------------------------
  // Order mirrors export_fbx_bin.py:3389-3456:
  //   empties (NodeAttribute Null), lights, cameras, meshes (Geometry),
  //   then per-object Model, then armatures, then materials, textures, videos.
  const objectsElem = root.addEmpty('Objects');

  // 5a. Empty NodeAttributes
  for (const e of empties) {
    writeNullAttribute({
      parent: objectsElem,
      name: e.object.name,
      uid: e.nodeAttrUid,
      templates,
    });
  }

  // 5a'. Bone NodeAttributes (LimbNode). Blender writes these alongside
  // empties (export_fbx_bin.py:1826-1842). One per unique Bone in any
  // skeleton; bones are shared across SkinnedMeshes by reference.
  for (const [bone, entry] of bones) {
    writeBoneAttribute({
      parent: objectsElem,
      bone,
      attrUid: entry.attrUid,
      templates,
    });
  }

  // 5a''. Light NodeAttributes (export_fbx_bin.py:583-631).
  for (const l of lights) {
    writeLightAttribute({
      parent: objectsElem,
      light: l.object,
      attrUid: l.attrUid,
      templates,
    });
  }

  // 5a'''. Camera NodeAttributes (export_fbx_bin.py:634-723).
  for (const c of cameras) {
    writeCameraAttribute({
      parent: objectsElem,
      camera: c.object,
      attrUid: c.attrUid,
      templates,
      settings,
    });
  }

  // 5a''''. Auxiliary light-target Null NodeAttributes — one per off-scene
  // DirectionalLight/SpotLight target. The matching Model is emitted in the
  // model-write pass below (5c''), keyed on `lightTargets`.
  if (lightTargets) {
    for (const t of lightTargets) {
      if (!t.auxiliary) continue;
      writeNullAttribute({
        parent: objectsElem,
        name: t.target.name || 'Light Target',
        uid: t.nodeAttrUid,
        templates,
      });
    }
  }

  // 5b. Geometries (one per unique BufferGeometry).
  const writtenGeometries = new Set();
  for (const m of meshes) {
    if (writtenGeometries.has(m.geomUid)) continue;
    writtenGeometries.add(m.geomUid);
    writeGeometry({
      parent: objectsElem,
      geometry: m.geometry,
      uid: m.geomUid,
      name: m.geometry.name || m.object.name,
      templates,
      materialSlotCount: m.materials.length,
      groups: m.geometry.groups || [],
      slotRemap: m.slotRemap,
      transformCtx: sceneData.transformCtx,
    });
  }

  // 5c. Models — every exportable Object3D, in scene-traverse order.
  const writtenModelUids = new Set();
  // Per-light opt-in for the LookAtProperty marker (FBXLoader.js:1504 gates
  // light-target reconstruction on this property being present).
  const lightsWithTarget = new Set();
  for (const l of lights) if (l.targetUid != null) lightsWithTarget.add(l.object);
  const exportUserData = !!settings.customProperties;
  rootInput.traverse((object) => {
    if (object.isScene) return;
    const meshEntry  = meshes.find((mm) => mm.object === object);
    const emptyEntry = empties.find((ee) => ee.object === object);
    const lightEntry = lights.find((le) => le.object === object);
    const cameraEntry = cameras.find((ce) => ce.object === object);
    const boneEntry  = bones.get(object);
    const uid = meshEntry?.uid ?? emptyEntry?.uid ?? lightEntry?.uid ?? cameraEntry?.uid ?? boneEntry?.uid;
    if (uid == null) return; // unsupported type — should not happen
    // For bones, hand writeModel the BIND-pose local matrix recovered from
    // boneInverses. Otherwise AnimationMixer's mid-frame mutations of
    // bone.position/rotation/scale would bleed into Lcl T/R/S and the
    // exported skeleton wouldn't match the cluster matrices.
    const overrideMatrix = boneEntry?.bindLocalMatrix || undefined;
    writeModel({
      parent: objectsElem, object, uid, templates,
      hasLookAtTarget: lightsWithTarget.has(object),
      overrideMatrix,
      customProperties: exportUserData,
    });
    writtenModelUids.add(uid);
  });

  // 5c''. Auxiliary light-target Models — one Null Model per off-scene
  // target. Their Lcl_Translation is the target's WORLD position so
  // FBXLoader can drop them straight into light.target.position.
  if (lightTargets) {
    for (const t of lightTargets) {
      if (!t.auxiliary) continue;
      t.target.updateMatrixWorld(true);
      t.target.getWorldPosition(_tmpWorldPos);
      writeModel({
        parent: objectsElem,
        object: t.target,
        uid: t.uid,
        templates,
        overrideTranslation: [_tmpWorldPos.x, _tmpWorldPos.y, _tmpWorldPos.z],
      });
      writtenModelUids.add(t.uid);
    }
  }

  // 5c'. Orphan bones — referenced by skeleton.bones but not in input's
  // scene tree. SceneCollector still allocates UIDs and connections for
  // these, so we must emit a Model node too. Otherwise FBXLoader silently
  // drops them from skeleton.bones (becomes undefined slot).
  for (const [bone, entry] of bones) {
    if (writtenModelUids.has(entry.uid)) continue;
    writeModel({ parent: objectsElem, object: bone, uid: entry.uid, templates });
  }

  // 5d. Materials.
  for (const [material, entry] of materials) {
    writeMaterial({
      parent: objectsElem,
      material,
      uid: entry.uid,
      templates,
    });
  }

  // 5d'. Textures + Videos. Blender emits Texture nodes (line 3444)
  // and Video nodes (line 3447) AFTER materials. We follow that order.
  if (textures && textures.textures) {
    for (const [, entry] of textures.textures) {
      writeTexture({ parent: objectsElem, textureEntry: entry, templates });
    }
    for (const [, entry] of textures.textures) {
      writeVideo({ parent: objectsElem, textureEntry: entry, templates });
    }
  }

  // 5e'. Animation. Per Blender, animation nodes go inside Objects too
  // (export_fbx_bin.py:3453 calls fbx_data_animation_elements with the
  // Objects element). We emit them after the static mesh data and before
  // skinning for stable byte ordering.
  writeAnimationNodes({ parent: objectsElem, stacks: animStacks, templates });

  // 5e''. Morph targets — BlendShape Deformer + BlendShapeChannel SubDeformer
  // + Geometry(Shape) per channel. Mirrors export_fbx_bin.py:765-845.
  for (const m of meshes) {
    if (!m.morph) continue;
    writeMorph({ parent: objectsElem, morphPlan: m.morph, templates });
  }

  // 5e. Skinning — Deformers (Skin), Clusters (SubDeformer), and BindPoses.
  // One Skin + clusters + BindPose per SkinnedMesh that has a populated
  // skeleton. Mirrors export_fbx_bin.py: fbx_data_armature_elements ordering
  // (BindPose first, then Skin Deformer + Clusters per the iteration), except
  // we group them here per-mesh for locality.
  for (const m of meshes) {
    if (!m.skin) continue;
    writeBindPose({
      parent: objectsElem,
      skin: m.skin,
      meshUid: m.uid,
      meshName: m.object.name,
    });
    writeSkinDeformer({
      parent: objectsElem,
      skin: m.skin,
      armatureName: m.object.name || 'Armature',
    });
  }

  // ---- 6. Connections -------------------------------------------------
  writeConnectionsSection({ root, connections });

  // ---- 7. Takes (legacy animations) ----------------------------------
  // Blender still emits this empty stub even when no animation is exported.
  // (export_fbx_bin.py:3468)
  const takes = root.addEmpty('Takes');
  takes.addEmpty('Current').addString('');

  return encodeBinaryFBX(root, { version });
}
