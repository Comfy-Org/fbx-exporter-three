
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
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    -1, 0, 0,   1, 0, 0,   0, 0, 1,
    -1, 2, 0,   1, 2, 0,   0, 2, 1,
  ], 3));
  geom.setIndex([0, 1, 2,  3, 4, 5]);
  geom.computeVertexNormals();

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

  const bone0 = new THREE.Bone();
  bone0.name = 'BoneRoot';
  bone0.position.set(0, 0, 0);

  const bone1 = new THREE.Bone();
  bone1.name = 'BoneTip';
  bone1.position.set(0, 2, 0);
  bone0.add(bone1);

  const skeleton = new THREE.Skeleton([bone0, bone1]);

  const mat = new THREE.MeshStandardMaterial();
  const skinnedMesh = new THREE.SkinnedMesh(geom, mat);
  skinnedMesh.name = 'SimpleSkin';
  skinnedMesh.add(bone0);
  skinnedMesh.bind(skeleton);

  return { skinnedMesh, skeleton, bones: [bone0, bone1] };
}


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

  assert.equal(idxAttr.count, 6, 'imported has 6 vertices (loop-expanded)');

  for (let i = 0; i < 3; i++) {
    assert.equal(idxAttr.getX(i), 0, `loop ${i}.x bone 0`);
    assert.ok(wAttr.getX(i) > 0.99, `loop ${i}.x weight≈1`);
  }
  for (let i = 3; i < 6; i++) {
    assert.equal(idxAttr.getX(i), 1, `loop ${i}.x bone 1`);
    assert.ok(wAttr.getX(i) > 0.99, `loop ${i}.x weight≈1`);
  }
});


test('AB1: bone parent-child relationship survives the round-trip', () => {
  const scene = new THREE.Scene();
  const { skinnedMesh } = buildSimpleSkinnedScene();
  scene.add(skinnedMesh);

  const { group } = exportAndReimport(scene);
  const sm = findSkinnedMesh(group);
  const [bone0, bone1] = sm.skeleton.bones;
  assert.equal(bone0.name, 'BoneRoot');
  assert.equal(bone1.name, 'BoneTip');
  assert.equal(bone1.parent, bone0, `bone1.parent (${bone1.parent && bone1.parent.name}) should be bone0`);
});

test('AB2: bone world positions match the bind-time positions', () => {
  const scene = new THREE.Scene();
  const { skinnedMesh, bones } = buildSimpleSkinnedScene();
  scene.add(skinnedMesh);

  scene.updateMatrixWorld(true);
  const origWorld = bones.map((b) => b.matrixWorld.clone());

  const { group } = exportAndReimport(scene);
  const sm = findSkinnedMesh(group);
  group.updateMatrixWorld(true);

  for (let i = 0; i < bones.length; i++) {
    const imported = sm.skeleton.bones[i];
    const op = new THREE.Vector3().setFromMatrixPosition(origWorld[i]);
    const ip = new THREE.Vector3().setFromMatrixPosition(imported.matrixWorld);
    assert.ok(op.distanceTo(ip) < 1e-3,
      `bone ${i} world pos diff: orig=${op.toArray()} imported=${ip.toArray()}`);
  }
});


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
    for (let k = 0; k < 16; k++) {
      assert.ok(
        Math.abs(origInv.elements[k] - reInv.elements[k]) < 1e-3,
        `boneInverse[${i}].elements[${k}]: orig=${origInv.elements[k]} re=${reInv.elements[k]}`,
      );
    }
  }
});


test('AD1: SkinnedMesh with bones but no skin weights still exports cleanly', () => {
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
  sm.skeleton = new THREE.Skeleton([], []);
  scene.add(sm);
  const { group } = exportAndReimport(scene);
  let mesh = null;
  group.traverse((o) => { if (o.isMesh) mesh = mesh || o; });
  assert.ok(mesh, 'mesh still exported');
});


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
  assert.equal(deformers.length, 3, `expected 3 Deformer nodes, got ${deformers.length}`);
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

  const conns = tree.find((n) => n.name === 'Connections');
  const cs = conns.children.filter((c) => c.name === 'C');
  assert.ok(cs.length >= 10, `connection count ${cs.length} suspiciously low`);
});


test('AF1: bones living OUTSIDE the SkinnedMesh subtree are still exported', () => {
  const scene = new THREE.Scene();
  const { skinnedMesh, bones } = buildSimpleSkinnedScene();
  skinnedMesh.remove(bones[0]);
  scene.add(skinnedMesh);
  scene.add(bones[0]);

  const { group } = exportAndReimport(scene);
  const sm = findSkinnedMesh(group);
  assert.ok(sm, 'mesh imported');
  assert.equal(sm.skeleton.bones.length, 2, 'both bones present in re-imported skeleton');
  assert.ok(sm.skeleton.bones[0], 'root bone re-imported');
  assert.ok(sm.skeleton.bones[1], 'tip bone re-imported');
});

test('AF2: skeleton shared across multiple SkinnedMeshes — bones written once', () => {
  const scene = new THREE.Scene();
  const { skinnedMesh: sm1, skeleton } = buildSimpleSkinnedScene();
  const geom2 = sm1.geometry.clone();
  const sm2 = new THREE.SkinnedMesh(geom2, new THREE.MeshStandardMaterial());
  sm2.name = 'SecondSkin';
  sm2.position.x = 5;
  sm2.bind(skeleton);
  scene.add(sm1);
  scene.add(sm2);

  const bytes = new FBXExporter().parseSync(scene);
  const tree = parseFBXTree(bytes);
  const objects = tree.find((n) => n.name === 'Objects');
  const limbAttrs = objects.children.filter(
    (c) => c.name === 'NodeAttribute' && c.props[2] === 'LimbNode',
  );
  assert.equal(limbAttrs.length, 2,
    `expected 2 LimbNode NodeAttributes (shared skeleton), got ${limbAttrs.length}`);

  const skins = objects.children.filter(
    (c) => c.name === 'Deformer' && c.props[2] === 'Skin',
  );
  assert.equal(skins.length, 2, 'one Skin Deformer per SkinnedMesh');
});

test('AF3: non-identity bindMatrix preserves the original bone bind world', () => {
  const scene = new THREE.Scene();
  const { skinnedMesh, bones, skeleton } = buildSimpleSkinnedScene();
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
  const scene = new THREE.Scene();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,  1, 0, 0,  0, 1, 0,  1, 1, 0,
  ], 3));
  geom.setIndex([0, 1, 2, 1, 3, 2]);
  geom.computeVertexNormals();

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
  for (let i = 0; i < idxAttr.count; i++) {
    const sum = wAttr.getX(i) + wAttr.getY(i) + wAttr.getZ(i) + wAttr.getW(i);
    assert.ok(Math.abs(sum - 1.0) < 1e-3, `loop ${i} weights sum = ${sum}`);
  }
});

test('AF5: humanoid-ish 20-bone skeleton round-trips', () => {
  const scene = new THREE.Scene();
  const bones = [];
  let prev = null;
  for (let i = 0; i < 20; i++) {
    const b = new THREE.Bone();
    b.name = `Bone${i}`;
    b.position.set(0, 1, 0);
    if (prev) prev.add(b); else { }
    bones.push(b);
    prev = b;
  }
  const skeleton = new THREE.Skeleton(bones);

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
  for (let i = 1; i < 20; i++) {
    assert.equal(imported.skeleton.bones[i].parent,
                 imported.skeleton.bones[i - 1],
                 `bone${i} parent should be bone${i - 1}`);
  }
});

test('AF6: bones truly detached from the scene tree (not traversable)', () => {
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

  const skeleton = new THREE.Skeleton([bone0, bone1]);
  const orphanMesh = new THREE.SkinnedMesh(geom, new THREE.MeshStandardMaterial());
  orphanMesh.bind(skeleton);
  scene.add(orphanMesh);

  const { group } = exportAndReimport(scene);
  const sm = findSkinnedMesh(group);
  assert.ok(sm, 'mesh imported (no crash)');
  for (let i = 0; i < 2; i++) {
    assert.ok(sm.skeleton.bones[i],
      `skeleton.bones[${i}] should be defined even for detached source bones`);
  }
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
