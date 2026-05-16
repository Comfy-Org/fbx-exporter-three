/**
 * Pipeline orchestrator — produces a complete FBX `FBXElem` tree from a
 * collected SceneData, then hands it to `encodeBinaryFBX`.
 *
 * Drives the per-section builders in order:
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

  writeHeaderSection({
    root,
    settings: { ...settings, version },
    sceneName: rootInput.name || 'Scene',
  });

  writeDefinitionsSection({ root, templates });

  const objectsElem = root.addEmpty('Objects');

  for (const e of empties) {
    writeNullAttribute({
      parent: objectsElem,
      name: e.object.name,
      uid: e.nodeAttrUid,
      templates,
    });
  }

  for (const [bone, entry] of bones) {
    writeBoneAttribute({
      parent: objectsElem,
      bone,
      attrUid: entry.attrUid,
      templates,
    });
  }

  for (const l of lights) {
    writeLightAttribute({
      parent: objectsElem,
      light: l.object,
      attrUid: l.attrUid,
      templates,
    });
  }

  for (const c of cameras) {
    writeCameraAttribute({
      parent: objectsElem,
      camera: c.object,
      attrUid: c.attrUid,
      templates,
      settings,
    });
  }

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

  const writtenModelUids = new Set();
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
    if (uid == null) return;
    const overrideMatrix = boneEntry?.bindLocalMatrix || undefined;
    writeModel({
      parent: objectsElem, object, uid, templates,
      hasLookAtTarget: lightsWithTarget.has(object),
      overrideMatrix,
      customProperties: exportUserData,
    });
    writtenModelUids.add(uid);
  });

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

  for (const [bone, entry] of bones) {
    if (writtenModelUids.has(entry.uid)) continue;
    writeModel({ parent: objectsElem, object: bone, uid: entry.uid, templates });
  }

  for (const [material, entry] of materials) {
    writeMaterial({
      parent: objectsElem,
      material,
      uid: entry.uid,
      templates,
    });
  }

  if (textures && textures.textures) {
    for (const [, entry] of textures.textures) {
      writeTexture({ parent: objectsElem, textureEntry: entry, templates });
    }
    for (const [, entry] of textures.textures) {
      writeVideo({ parent: objectsElem, textureEntry: entry, templates });
    }
  }

  writeAnimationNodes({ parent: objectsElem, stacks: animStacks, templates });

  for (const m of meshes) {
    if (!m.morph) continue;
    writeMorph({ parent: objectsElem, morphPlan: m.morph, templates });
  }

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

  writeConnectionsSection({ root, connections });

  const takes = root.addEmpty('Takes');
  takes.addEmpty('Current').addString('');

  return encodeBinaryFBX(root, { version });
}
