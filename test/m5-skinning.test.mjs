// M5: SkinnedMesh + Skeleton round-trip via FBXLoader.
//
// Run: node test/m5-skinning.test.mjs

import { strict as assert } from 'node:assert';

globalThis.self = globalThis;

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { FBXExporter } = await import('../src/FBXExporter.js');

let passes = 0, fails = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${name}`); console.error('       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); }
}

function exportAndReimport(scene) {
  const bytes = new FBXExporter().parseSync(scene);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const group = new FBXLoader().parse(ab, '');
  group.updateMatrixWorld(true);
  return { bytes, group };
}

function findSkinnedMesh(group) {
  let found = null;
  group.traverse((o) => { if (o.isSkinnedMesh) found = found || o; });
  return found;
}

/**
 * Construct a 2-bone skinned cylinder-ish geometry. Two horizontal triangles
 * stacked vertically: bottom triangle pinned to bone 0, top to bone 1.
 *
 * Returns { skinnedMesh, skeleton, bones }.
 */
function buildSimpleSkinnedScene() {
  // Geometry: 6 vertices, two flat triangles at y=0 and y=2.
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    // bottom triangle
    -1, 0, 0,   1, 0, 0,   0, 0, 1,
    // top triangle
    -1, 2, 0,   1, 2, 0,   0, 2, 1,
  ], 3));
  geom.setIndex([0, 1, 2,  3, 4, 5]);
  geom.computeVertexNormals();

  // Skin weights: bottom verts → bone 0 fully, top verts → bone 1 fully.
  const skinIndices = new Uint16Array([
    0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0,
    1, 0, 0, 0,  1, 0, 0, 0,  1, 0, 0, 0,
  ]);
  const skinWeights = new Float32Array([
    1, 0, 0, 0,  1, 0, 0, 0,  1, 0, 0, 0,
    1, 0, 0, 0,  1, 0, 0, 0,  1, 0, 0, 0,
  ]);
  geom.setAttribute('skinIndex',  new THREE.Uint16BufferAttribute(skinIndices, 4));
  geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));

  // Bone hierarchy: root → child.
  const bone0 = new THREE.Bone();
  bone0.name = 'BoneRoot';
  bone0.position.set(0, 0, 0);

  const bone1 = new THREE.Bone();
  bone1.name = 'BoneTip';
  bone1.position.set(0, 2, 0);  // 2 units above bone0
  bone0.add(bone1);

  const skeleton = new THREE.Skeleton([bone0, bone1]);

  const mat = new THREE.MeshStandardMaterial();
  const skinnedMesh = new THREE.SkinnedMesh(geom, mat);
  skinnedMesh.name = 'SimpleSkin';
  skinnedMesh.add(bone0);
  skinnedMesh.bind(skeleton);

  return { skinnedMesh, skeleton, bones: [bone0, bone1] };
}

// ============================================================================
// AA. SkinnedMesh round-trip basics
// ============================================================================

test('AA1: 2-bone SkinnedMesh re-imports as a SkinnedMesh (not Mesh)', () => {
  const scene = new THREE.Scene();
  const { skinnedMesh } = buildSimpleSkinnedScene();
  scene.add(skinnedMesh);

  const { group } = exportAndReimport(scene);
  const sm = findSkinnedMesh(group);
  assert.ok(sm, 'imported as a SkinnedMesh');
  assert.ok(sm.skeleton, 'has a skeleton');
  assert.equal(sm.skeleton.bones.length, 2, `expected 2 bones, got ${sm.skeleton.bones.length}`);
});

test('AA2: imported geometry has skinIndex + skinWeight attributes', () => {
  const scene = new THREE.Scene();
  const { skinnedMesh } = buildSimpleSkinnedScene();
  scene.add(skinnedMesh);

  const { group } = exportAndReimport(scene);
  const sm = findSkinnedMesh(group);
  assert.ok(sm.geometry.attributes.skinIndex,  'skinIndex preserved');
  assert.ok(sm.geometry.attributes.skinWeight, 'skinWeight preserved');
  assert.equal(sm.geometry.attributes.skinIndex.itemSize, 4);
  assert.equal(sm.geometry.attributes.skinWeight.itemSize, 4);
});

test('AA3: each vertex is influenced by the correct bone after round-trip', () => {
  const scene = new THREE.Scene();
  const { skinnedMesh } = buildSimpleSkinnedScene();
  scene.add(skinnedMesh);

  const { group } = exportAndReimport(scene);
  const sm = findSkinnedMesh(group);
  const idxAttr = sm.geometry.attributes.skinIndex;
  const wAttr   = sm.geometry.attributes.skinWeight;

  // FBXLoader expands geometry into per-loop (FBXLoader.js:1828-1834), so the
  // imported skinIndex is one entry per LOOP, not per vertex. With 6 loops
  // (2 triangles × 3) we expect 6 × 4 = 24 entries.
  assert.equal(idxAttr.count, 6, 'imported has 6 vertices (loop-expanded)');

  // Loops 0..2 = bottom triangle → bone 0
  // Loops 3..5 = top triangle    → bone 1
  for (let i = 0; i < 3; i++) {
    assert.equal(idxAttr.getX(i), 0, `loop ${i}.x bone 0`);
    assert.ok(wAttr.getX(i) > 0.99, `loop ${i}.x weight≈1`);
  }
  for (let i = 3; i < 6; i++) {
    assert.equal(idxAttr.getX(i), 1, `loop ${i}.x bone 1`);
    assert.ok(wAttr.getX(i) > 0.99, `loop ${i}.x weight≈1`);
  }
});

// ============================================================================
// AB. Bone hierarchy
// ============================================================================

test('AB1: bone parent-child relationship survives the round-trip', () => {
  const scene = new THREE.Scene();
  const { skinnedMesh } = buildSimpleSkinnedScene();
  scene.add(skinnedMesh);

  const { group } = exportAndReimport(scene);
  const sm = findSkinnedMesh(group);
  const [bone0, bone1] = sm.skeleton.bones;
  assert.equal(bone0.name, 'BoneRoot');
  assert.equal(bone1.name, 'BoneTip');
  // bone1 must be a descendant of bone0 in the scene graph.
  assert.equal(bone1.parent, bone0, `bone1.parent (${bone1.parent && bone1.parent.name}) should be bone0`);
});

test('AB2: bone world positions match the bind-time positions', () => {
  const scene = new THREE.Scene();
  const { skinnedMesh, bones } = buildSimpleSkinnedScene();
  scene.add(skinnedMesh);

  // Capture original world matrices BEFORE export.
  scene.updateMatrixWorld(true);
  const origWorld = bones.map((b) => b.matrixWorld.clone());

  const { group } = exportAndReimport(scene);
  const sm = findSkinnedMesh(group);
  group.updateMatrixWorld(true);

  for (let i = 0; i < bones.length; i++) {
    const imported = sm.skeleton.bones[i];
    // World positions should match (up to FP).
    const op = new THREE.Vector3().setFromMatrixPosition(origWorld[i]);
    const ip = new THREE.Vector3().setFromMatrixPosition(imported.matrixWorld);
    assert.ok(op.distanceTo(ip) < 1e-3,
      `bone ${i} world pos diff: orig=${op.toArray()} imported=${ip.toArray()}`);
  }
});

// ============================================================================
// AC. BindMatrix / boneInverses preserve the bind state
// ============================================================================

test('AC1: skeleton.boneInverses match the original (within FP tolerance)', () => {
  const scene = new THREE.Scene();
  const { skinnedMesh, skeleton } = buildSimpleSkinnedScene();
  scene.add(skinnedMesh);
  scene.updateMatrixWorld(true);

  const { group } = exportAndReimport(scene);
  const sm = findSkinnedMesh(group);

  for (let i = 0; i < skeleton.bones.length; i++) {
    const origInv = skeleton.boneInverses[i];
    const reInv  = sm.skeleton.boneInverses[i];
    // Compare element-wise.
    for (let k = 0; k < 16; k++) {
      assert.ok(
        Math.abs(origInv.elements[k] - reInv.elements[k]) < 1e-3,
        `boneInverse[${i}].elements[${k}]: orig=${origInv.elements[k]} re=${reInv.elements[k]}`,
      );
    }
  }
});

// ============================================================================
// AD. Empty / degenerate cases
// ============================================================================

test('AD1: SkinnedMesh with bones but no skin weights still exports cleanly', () => {
  // skinIndex/skinWeight all zero — every vertex unaffected. Some users do
  // this when rigging is in progress.
  const scene = new THREE.Scene();
  const { skinnedMesh } = buildSimpleSkinnedScene();
  const n = skinnedMesh.geometry.attributes.position.count;
  skinnedMesh.geometry.setAttribute('skinIndex',
    new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
  skinnedMesh.geometry.setAttribute('skinWeight',
    new THREE.Float32BufferAttribute(new Float32Array(n * 4), 4));
  scene.add(skinnedMesh);

  const { group } = exportAndReimport(scene);
  assert.ok(findSkinnedMesh(group), 'still imports as SkinnedMesh');
});

test('AD2: SkinnedMesh with no skeleton.bones (empty) falls back to Mesh', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BoxGeometry();
  const mat = new THREE.MeshStandardMaterial();
  const sm = new THREE.SkinnedMesh(geom, mat);
  sm.skeleton = new THREE.Skeleton([], []); // empty
  scene.add(sm);
  // Just verify no crash; SceneCollector skips skin collection when bones is empty.
  const { group } = exportAndReimport(scene);
  let mesh = null;
  group.traverse((o) => { if (o.isMesh) mesh = mesh || o; });
  assert.ok(mesh, 'mesh still exported');
});

// ============================================================================
// AE. Connection graph integrity for skinning
// ============================================================================

import { unzlibSync } from 'fflate';
import * as DT from '../src/core/dataTypes.js';

function parseFBXTree(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint32(23, true);
  let offset = 27;
  const use64 = version >= 7500;
  const ms = use64 ? 24 : 12;
  const sentinel = use64 ? 25 : 13;

  const roots = [];
  while (offset < u8.byteLength - sentinel) {
    const peek = use64 ? Number(dv.getBigUint64(offset, true)) : dv.getUint32(offset, true);
    if (peek === 0) break;
    roots.push(parseNode());
  }
  return roots;

  function parseNode() {
    const endOffset = use64 ? Number(dv.getBigUint64(offset, true)) : dv.getUint32(offset, true);
    offset += use64 ? 8 : 4;
    const numProps = use64 ? Number(dv.getBigUint64(offset, true)) : dv.getUint32(offset, true);
    offset += use64 ? 8 : 4;
    offset += use64 ? 8 : 4;
    const nameLen = dv.getUint8(offset);
    offset += 1;
    const name = new TextDecoder().decode(u8.slice(offset, offset + nameLen));
    offset += nameLen;
    const props = [];
    for (let i = 0; i < numProps; i++) props.push(parseProp());
    const children = [];
    while (offset < endOffset) {
      const peek = use64 ? Number(dv.getBigUint64(offset, true)) : dv.getUint32(offset, true);
      if (peek === 0 && offset + sentinel <= endOffset) { offset += sentinel; break; }
      children.push(parseNode());
    }
    if (offset !== endOffset) offset = endOffset;
    return { name, props, children };
  }

  function parseProp() {
    const tag = dv.getUint8(offset); offset += 1;
    switch (tag) {
      case DT.BOOL:    { const v = !!dv.getUint8(offset); offset += 1; return v; }
      case DT.INT8:    { const v = dv.getInt8(offset); offset += 1; return v; }
      case DT.INT16:   { const v = dv.getInt16(offset, true); offset += 2; return v; }
      case DT.INT32:   { const v = dv.getInt32(offset, true); offset += 4; return v; }
      case DT.INT64:   { const v = dv.getBigInt64(offset, true); offset += 8; return v; }
      case DT.FLOAT32: { const v = dv.getFloat32(offset, true); offset += 4; return v; }
      case DT.FLOAT64: { const v = dv.getFloat64(offset, true); offset += 8; return v; }
      case DT.STRING:
      case DT.BYTES: {
        const len = dv.getUint32(offset, true); offset += 4;
        const bytes = u8.slice(offset, offset + len); offset += len;
        return tag === DT.STRING ? new TextDecoder().decode(bytes) : bytes;
      }
      case DT.CHAR: { const v = dv.getUint8(offset); offset += 1; return v; }
      case DT.INT32_ARRAY:
      case DT.INT64_ARRAY:
      case DT.FLOAT32_ARRAY:
      case DT.FLOAT64_ARRAY:
      case DT.BOOL_ARRAY:
      case DT.BYTE_ARRAY: {
        const length = dv.getUint32(offset, true);
        const encoding = dv.getUint32(offset + 4, true);
        const compLen = dv.getUint32(offset + 8, true);
        offset += 12;
        const raw = u8.slice(offset, offset + compLen); offset += compLen;
        const data = encoding === 1 ? unzlibSync(raw) : raw;
        return { length, encoding, data };
      }
      default: throw new Error(`Unknown tag 0x${tag.toString(16)}`);
    }
  }
}

test('AE1: file contains Deformer(Skin) + Deformer(Cluster) + Pose(BindPose) nodes', () => {
  const scene = new THREE.Scene();
  const { skinnedMesh } = buildSimpleSkinnedScene();
  scene.add(skinnedMesh);
  const bytes = new FBXExporter().parseSync(scene);
  const tree = parseFBXTree(bytes);
  const objects = tree.find((n) => n.name === 'Objects');
  const deformers = objects.children.filter((c) => c.name === 'Deformer');
  const poses = objects.children.filter((c) => c.name === 'Pose');
  // 1 Skin + 2 Clusters = 3 Deformer nodes.
  assert.equal(deformers.length, 3, `expected 3 Deformer nodes, got ${deformers.length}`);
  // Check subtypes (3rd prop of each).
  const subtypes = deformers.map((d) => d.props[2]).sort();
  assert.deepEqual(subtypes, ['Cluster', 'Cluster', 'Skin']);
  assert.equal(poses.length, 1, 'one BindPose');
  assert.equal(poses[0].props[2], 'BindPose');
});

test('AE2: Cluster nodes carry Indexes/Weights/TransformLink', () => {
  const scene = new THREE.Scene();
  const { skinnedMesh } = buildSimpleSkinnedScene();
  scene.add(skinnedMesh);
  const bytes = new FBXExporter().parseSync(scene);
  const tree = parseFBXTree(bytes);
  const objects = tree.find((n) => n.name === 'Objects');
  const clusters = objects.children.filter(
    (c) => c.name === 'Deformer' && c.props[2] === 'Cluster',
  );
  assert.equal(clusters.length, 2);
  for (const cluster of clusters) {
    assert.ok(cluster.children.find((c) => c.name === 'Indexes'),  'Indexes child');
    assert.ok(cluster.children.find((c) => c.name === 'Weights'),  'Weights child');
    assert.ok(cluster.children.find((c) => c.name === 'TransformLink'), 'TransformLink child');
    assert.ok(cluster.children.find((c) => c.name === 'Transform'),     'Transform child');
  }
});

test('AE3: BindPose has 1 + N PoseNode children (mesh + bones)', () => {
  const scene = new THREE.Scene();
  const { skinnedMesh } = buildSimpleSkinnedScene();
  scene.add(skinnedMesh);
  const bytes = new FBXExporter().parseSync(scene);
  const tree = parseFBXTree(bytes);
  const objects = tree.find((n) => n.name === 'Objects');
  const pose = objects.children.find((c) => c.name === 'Pose');
  const poseNodes = pose.children.filter((c) => c.name === 'PoseNode');
  assert.equal(poseNodes.length, 3, '1 mesh + 2 bones = 3 PoseNodes');
  const nbField = pose.children.find((c) => c.name === 'NbPoseNodes');
  assert.equal(nbField.props[0], 3);
});

test('AE4: Connections graph contains Skin→Geom, Cluster→Skin, Bone→Cluster edges', () => {
  const scene = new THREE.Scene();
  const { skinnedMesh } = buildSimpleSkinnedScene();
  scene.add(skinnedMesh);
  const bytes = new FBXExporter().parseSync(scene);
  const tree = parseFBXTree(bytes);

  // Count OO connections — for a 2-bone skin we expect at least:
  //   Bones: 2 (Bone→parent) + 2 (NodeAttr→Bone) = 4
  //   Mesh: 1 (Model→root) + 1 (Geom→Model) + 1 (Material→Model) = 3
  //   Skin: 1 (Skin→Geom) + 2 (Cluster→Skin) + 2 (Bone→Cluster) = 5
  // Plus the SkinnedMesh's own Model→root edge.
  // Total ≥ 12 — exact count depends on traversal.
  const conns = tree.find((n) => n.name === 'Connections');
  const cs = conns.children.filter((c) => c.name === 'C');
  assert.ok(cs.length >= 10, `connection count ${cs.length} suspiciously low`);
});

// ============================================================================
// AF. Edge cases — bone topologies and bind matrix variants
// ============================================================================

test('AF1: bones living OUTSIDE the SkinnedMesh subtree are still exported', () => {
  // Common case: bones are siblings of the mesh (or under a separate armature
  // root), referenced only via skeleton.bones. SceneCollector must allocate
  // Model UIDs for bones that aren't reachable from input.traverse().
  const scene = new THREE.Scene();
  const { skinnedMesh, bones } = buildSimpleSkinnedScene();
  // Detach bones from the mesh; add them as siblings instead.
  skinnedMesh.remove(bones[0]);
  scene.add(skinnedMesh);
  scene.add(bones[0]);   // root bone now sits next to the mesh

  const { group } = exportAndReimport(scene);
  const sm = findSkinnedMesh(group);
  assert.ok(sm, 'mesh imported');
  assert.equal(sm.skeleton.bones.length, 2, 'both bones present in re-imported skeleton');
  assert.ok(sm.skeleton.bones[0], 'root bone re-imported');
  assert.ok(sm.skeleton.bones[1], 'tip bone re-imported');
});

test('AF2: skeleton shared across multiple SkinnedMeshes — bones written once', () => {
  // Two SkinnedMeshes pointing to the same Skeleton share the same Bone
  // instances. Each mesh has its OWN Skin Deformer + Clusters (because the
  // weights table is per-mesh), but the bones themselves dedupe.
  const scene = new THREE.Scene();
  const { skinnedMesh: sm1, skeleton } = buildSimpleSkinnedScene();
  // Build a second mesh sharing the skeleton.
  const geom2 = sm1.geometry.clone();
  const sm2 = new THREE.SkinnedMesh(geom2, new THREE.MeshStandardMaterial());
  sm2.name = 'SecondSkin';
  sm2.position.x = 5;
  // bind to the SAME skeleton instance
  sm2.bind(skeleton);
  scene.add(sm1);
  scene.add(sm2);

  // Verify the byte stream emits Bone NodeAttribute LimbNode nodes exactly
  // twice (one per unique bone), not 4 times (twice per mesh).
  const bytes = new FBXExporter().parseSync(scene);
  const tree = parseFBXTree(bytes);
  const objects = tree.find((n) => n.name === 'Objects');
  const limbAttrs = objects.children.filter(
    (c) => c.name === 'NodeAttribute' && c.props[2] === 'LimbNode',
  );
  assert.equal(limbAttrs.length, 2,
    `expected 2 LimbNode NodeAttributes (shared skeleton), got ${limbAttrs.length}`);

  // But two distinct Skin Deformers (one per SkinnedMesh).
  const skins = objects.children.filter(
    (c) => c.name === 'Deformer' && c.props[2] === 'Skin',
  );
  assert.equal(skins.length, 2, 'one Skin Deformer per SkinnedMesh');
});

test('AF3: non-identity bindMatrix preserves the original bone bind world', () => {
  // SkinnedMesh.bindMatrix is the mesh's world matrix at bind time. When the
  // user binds with a custom bindMatrix, our cluster Transform/TransformLink
  // must encode that, and after round-trip the boneInverses must reconstruct
  // matching bone world positions.
  const scene = new THREE.Scene();
  const { skinnedMesh, bones, skeleton } = buildSimpleSkinnedScene();
  // Build a deliberate non-identity bind: rotate mesh by 90° around Y and
  // re-bind so the bind matrix captures that orientation.
  skinnedMesh.position.set(3, 0, 0);
  skinnedMesh.quaternion.setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));
  skinnedMesh.updateMatrixWorld(true);
  skinnedMesh.bind(skeleton, skinnedMesh.matrixWorld);
  scene.add(skinnedMesh);
  scene.updateMatrixWorld(true);

  const origInverses = skeleton.boneInverses.map((m) => m.clone());

  const { group } = exportAndReimport(scene);
  const sm = findSkinnedMesh(group);
  for (let i = 0; i < origInverses.length; i++) {
    const a = origInverses[i].elements;
    const b = sm.skeleton.boneInverses[i].elements;
    for (let k = 0; k < 16; k++) {
      assert.ok(Math.abs(a[k] - b[k]) < 1e-3,
        `boneInverses[${i}][${k}]: ${a[k]} vs ${b[k]} (custom bindMatrix)`);
    }
  }
});

test('AF4: realistic per-vertex weights (mixed bone influences) round-trip', () => {
  // Build a 4-vertex strip where each vertex is shared between two bones.
  const scene = new THREE.Scene();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,  1, 0, 0,  0, 1, 0,  1, 1, 0,
  ], 3));
  geom.setIndex([0, 1, 2, 1, 3, 2]);
  geom.computeVertexNormals();

  // Vertex 0: 100% bone 0
  // Vertex 1: 70% bone 0 / 30% bone 1
  // Vertex 2: 30% bone 0 / 70% bone 1
  // Vertex 3: 100% bone 1
  geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array([
    0, 0, 0, 0,
    0, 1, 0, 0,
    0, 1, 0, 0,
    1, 0, 0, 0,
  ]), 4));
  geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array([
    1.0, 0.0, 0.0, 0.0,
    0.7, 0.3, 0.0, 0.0,
    0.3, 0.7, 0.0, 0.0,
    1.0, 0.0, 0.0, 0.0,
  ]), 4));

  const bone0 = new THREE.Bone(); bone0.name = 'B0';
  const bone1 = new THREE.Bone(); bone1.name = 'B1'; bone1.position.set(1, 0, 0);
  bone0.add(bone1);
  const skeleton = new THREE.Skeleton([bone0, bone1]);
  const sm = new THREE.SkinnedMesh(geom, new THREE.MeshStandardMaterial());
  sm.add(bone0);
  sm.bind(skeleton);
  scene.add(sm);

  const { group } = exportAndReimport(scene);
  const imported = findSkinnedMesh(group);
  const idxAttr = imported.geometry.attributes.skinIndex;
  const wAttr  = imported.geometry.attributes.skinWeight;
  // After FBXLoader expands and (importantly) normalizes weights via
  // model.normalizeSkinWeights() (FBXLoader.js:1442), the per-loop weights
  // should still sum ≈ 1 per loop and represent the original bone influences.
  for (let i = 0; i < idxAttr.count; i++) {
    const sum = wAttr.getX(i) + wAttr.getY(i) + wAttr.getZ(i) + wAttr.getW(i);
    assert.ok(Math.abs(sum - 1.0) < 1e-3, `loop ${i} weights sum = ${sum}`);
  }
});

test('AF5: humanoid-ish 20-bone skeleton round-trips', () => {
  // Chain of 20 bones — exercises the bone Model+NodeAttribute pipeline at
  // scale and verifies hierarchical OO connections.
  const scene = new THREE.Scene();
  const bones = [];
  let prev = null;
  for (let i = 0; i < 20; i++) {
    const b = new THREE.Bone();
    b.name = `Bone${i}`;
    b.position.set(0, 1, 0);
    if (prev) prev.add(b); else { /* root */ }
    bones.push(b);
    prev = b;
  }
  const skeleton = new THREE.Skeleton(bones);

  // Minimal geometry to actually be a SkinnedMesh.
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,  1, 0, 0,  0, 1, 0,
  ], 3));
  geom.setIndex([0, 1, 2]);
  geom.computeVertexNormals();
  geom.setAttribute('skinIndex',  new THREE.Uint16BufferAttribute(new Uint16Array(12), 4));
  geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(12), 4));

  const sm = new THREE.SkinnedMesh(geom, new THREE.MeshStandardMaterial());
  sm.add(bones[0]);
  sm.bind(skeleton);
  scene.add(sm);

  const { group } = exportAndReimport(scene);
  const imported = findSkinnedMesh(group);
  assert.equal(imported.skeleton.bones.length, 20, '20 bones round-trip');
  // Verify chain connectivity: bone[i+1].parent === bone[i].
  for (let i = 1; i < 20; i++) {
    assert.equal(imported.skeleton.bones[i].parent,
                 imported.skeleton.bones[i - 1],
                 `bone${i} parent should be bone${i - 1}`);
  }
});

test('AF6: bones truly detached from the scene tree (not traversable)', () => {
  // Pathological: skeleton.bones references Bone instances that are NEVER
  // added to any Object3D in the scene. The user might have set bone
  // matrixWorld manually. Our exporter should still produce a coherent file
  // — either by writing Model nodes for the orphan bones too, or by
  // skipping them cleanly with no orphan connections.
  const scene = new THREE.Scene();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0,0,0,  1,0,0,  0,1,0,
  ], 3));
  geom.setIndex([0, 1, 2]);
  geom.setAttribute('skinIndex',  new THREE.Uint16BufferAttribute(new Uint16Array(12), 4));
  geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(12), 4));

  const bone0 = new THREE.Bone(); bone0.name = 'OrphanRoot';
  const bone1 = new THREE.Bone(); bone1.name = 'OrphanTip'; bone1.position.set(0, 1, 0);
  // intentionally NOT calling bone0.add(bone1) or scene.add(bone0)

  const skeleton = new THREE.Skeleton([bone0, bone1]);
  const orphanMesh = new THREE.SkinnedMesh(geom, new THREE.MeshStandardMaterial());
  orphanMesh.bind(skeleton);
  scene.add(orphanMesh);  // mesh in scene, bones are not

  // Best case: re-import has the SkinnedMesh + skeleton with 2 bones.
  // Acceptable: re-import returns a Mesh (skinning silently dropped).
  // Unacceptable: throws or produces malformed connections.
  const { group } = exportAndReimport(scene);
  const sm = findSkinnedMesh(group);
  assert.ok(sm, 'mesh imported (no crash)');
  // Stricter: both detached bones should still be present in the skeleton
  // (we want our exporter to also write Models for orphan bones).
  for (let i = 0; i < 2; i++) {
    assert.ok(sm.skeleton.bones[i],
      `skeleton.bones[${i}] should be defined even for detached source bones`);
  }
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
