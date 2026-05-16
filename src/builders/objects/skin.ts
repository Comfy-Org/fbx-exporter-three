/**
 * SkinnedMesh → FBX skinning nodes.
 *
 *   1. `Deformer (Skin)`   — one per SkinnedMesh; holds skin metadata.
 *   2. `Deformer (Cluster)` (a.k.a. SubDeformer) — one per bone per skin;
 *       carries per-vertex Indexes/Weights and the bind-time bone transforms.
 *   3. `Pose (BindPose)`   — one per SkinnedMesh; PoseNode subtree pinning the
 *       mesh + each bone's world matrix at bind time.
 *
 * Matrix encoding: FBX stores 4×4 matrices as a flat 16-element float64 array
 * in COLUMN-MAJOR order. three.js's `Matrix4.elements` is already column-major
 * (Matrix4.js docstring), so we write `.elements` verbatim — no transpose.
 */

import { Matrix4 } from 'three';
import {
  elemDataSingleInt32, elemDataSingleString, elemDataSingleInt64,
  elemDataSingleFloat64, elemDataSingleInt32Array,
  elemDataSingleFloat64Array,
  elemEmpty, fbxNameClass,
} from '../../core/elemHelpers.js';
import {
  FBX_DEFORMER_SKIN_VERSION,
  FBX_DEFORMER_CLUSTER_VERSION,
  FBX_POSE_BIND_VERSION,
} from '../../constants.js';

function mat4ToFloat64Array(matrix4) {
  const out = new Float64Array(16);
  for (let i = 0; i < 16; i++) out[i] = matrix4.elements[i];
  return out;
}

const _IDENTITY_MATRIX_FLAT = new Float64Array(new Matrix4().identity().elements);

/**
 * Write the Skin Deformer + per-bone Cluster nodes for one SkinnedMesh.
 *
 * @param {object} ctx
 * @param {FBXElem} ctx.parent       Objects container
 * @param {Object}  ctx.skin         SceneCollector skin entry (deformerUid, clusters[])
 * @param {string}  ctx.armatureName  Name to embed in the Deformer attrName
 */
export function writeSkinDeformer({ parent, skin, armatureName = 'Armature' }) {
  const skinNode = parent.addEmpty('Deformer');
  skinNode.addInt64(skin.deformerUid);
  skinNode.addString(fbxNameClass(armatureName, 'Deformer'));
  skinNode.addString('Skin');

  elemDataSingleInt32(skinNode, 'Version', FBX_DEFORMER_SKIN_VERSION);
  elemDataSingleFloat64(skinNode, 'Link_DeformAcuracy', 50.0);

  for (const cluster of skin.clusters) {
    writeCluster(parent, cluster, skin);
  }
}

/**
 * Each Cluster is a Deformer node with attrType="Cluster". Its parent in the
 * Connections graph is the Skin Deformer.
 */
function writeCluster(parent, cluster, skin) {
  const clusterNode = parent.addEmpty('Deformer');
  clusterNode.addInt64(cluster.clusterUid);
  clusterNode.addString(fbxNameClass(cluster.bone.name || 'Bone', 'SubDeformer'));
  clusterNode.addString('Cluster');

  elemDataSingleInt32(clusterNode, 'Version', FBX_DEFORMER_CLUSTER_VERSION);

  const userData = elemEmpty(clusterNode, 'UserData');
  userData.addString('');
  userData.addString('');

  if (cluster.indices.length > 0) {
    elemDataSingleInt32Array(clusterNode, 'Indexes', Int32Array.from(cluster.indices));
    elemDataSingleFloat64Array(clusterNode, 'Weights', Float64Array.from(cluster.weights));
  }

  elemDataSingleFloat64Array(clusterNode, 'Transform',
    mat4ToFloat64Array(cluster.transform));
  elemDataSingleFloat64Array(clusterNode, 'TransformLink',
    mat4ToFloat64Array(cluster.transformLink));
  elemDataSingleFloat64Array(clusterNode, 'TransformAssociateModel',
    _IDENTITY_MATRIX_FLAT);
}

/**
 * Write the BindPose record for a SkinnedMesh.
 *
 * The BindPose lists every Model (mesh + bones) along with its world matrix
 * at the bind moment. FBXLoader's parsePoseNodes (FBXLoader.js:1611) reads
 * this as a fallback bind pose for bones not in a cluster — for our purposes
 * it's a courtesy to other DCC tools.
 */
export function writeBindPose({ parent, skin, meshUid, meshName }) {
  const pose = parent.addEmpty('Pose');
  pose.addInt64(skin.bindPoseUid);
  pose.addString(fbxNameClass(meshName || 'BindPose', 'Pose'));
  pose.addString('BindPose');

  elemDataSingleString(pose, 'Type', 'BindPose');
  elemDataSingleInt32(pose, 'Version', FBX_POSE_BIND_VERSION);
  elemDataSingleInt32(pose, 'NbPoseNodes', 1 + skin.clusters.length);

  const meshPose = elemEmpty(pose, 'PoseNode');
  elemDataSingleInt64(meshPose, 'Node', meshUid);
  elemDataSingleFloat64Array(meshPose, 'Matrix', mat4ToFloat64Array(skin.bindMatrix));

  for (const cluster of skin.clusters) {
    const bonePose = elemEmpty(pose, 'PoseNode');
    elemDataSingleInt64(bonePose, 'Node', cluster.boneEntry.uid);
    elemDataSingleFloat64Array(bonePose, 'Matrix', mat4ToFloat64Array(cluster.transformLink));
  }
}
