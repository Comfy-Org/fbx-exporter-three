
import { strict as assert } from 'node:assert';
import { unzlibSync } from 'fflate';

globalThis.self = globalThis;

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { FBXExporter } = await import('../src/FBXExporter.js');
import * as DT from '../src/core/dataTypes.js';

let passes = 0, fails = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${name}`); console.error('       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); }
}


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

function findRoot(tree, name) { return tree.find((n) => n.name === name); }
function findChild(node, name) { return node && node.children.find((c) => c.name === name); }
function findChildren(node, name) { return node ? node.children.filter((c) => c.name === name) : []; }

function f64ArrayToNumbers(arrProp) {
  return Array.from(new Float64Array(arrProp.data.buffer, arrProp.data.byteOffset, arrProp.length));
}


function buildKnownScene() {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,  1, 0, 0,  0, 1, 0,
  ], 3));
  geom.setIndex([0, 1, 2]);
  geom.setAttribute('skinIndex',
    new THREE.Uint16BufferAttribute(new Uint16Array([
      0, 0, 0, 0,  1, 0, 0, 0,  1, 0, 0, 0,
    ]), 4));
  geom.setAttribute('skinWeight',
    new THREE.Float32BufferAttribute(new Float32Array([
      1, 0, 0, 0,  1, 0, 0, 0,  1, 0, 0, 0,
    ]), 4));

  const b0 = new THREE.Bone();
  b0.name = 'B0';
  b0.position.set(2, 3, 4);
  const b1 = new THREE.Bone();
  b1.name = 'B1';
  b1.position.set(0, 5, 0);
  b0.add(b1);

  const skeleton = new THREE.Skeleton([b0, b1]);

  const sm = new THREE.SkinnedMesh(geom, new THREE.MeshStandardMaterial());
  sm.name = 'KnownSM';
  sm.position.set(10, 0, 0);
  sm.add(b0);
  sm.bind(skeleton);

  return { sm, skeleton, b0, b1 };
}


function getSkinDeformer(tree) {
  const objects = findRoot(tree, 'Objects');
  return objects.children.find((c) => c.name === 'Deformer' && c.props[2] === 'Skin');
}

function getClusters(tree) {
  const objects = findRoot(tree, 'Objects');
  return objects.children.filter((c) => c.name === 'Deformer' && c.props[2] === 'Cluster');
}

function exportToTree(scene) {
  const bytes = new FBXExporter().parseSync(scene);
  return parseFBXTree(bytes);
}

test('BA1: Skin Deformer has Version=101 + Link_DeformAcuracy=50.0', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const skin = getSkinDeformer(exportToTree(scene));
  assert.ok(skin);
  assert.equal(findChild(skin, 'Version').props[0], 101);
  assert.equal(findChild(skin, 'Link_DeformAcuracy').props[0], 50.0);
});

test('BA2: Skin Deformer attrName uses fbxNameClass(name, "Deformer")', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const skin = getSkinDeformer(exportToTree(scene));
  assert.ok(skin.props[1].endsWith('\x00\x01Deformer'),
    `Skin attrName: ${JSON.stringify(skin.props[1])}`);
  assert.equal(skin.props[2], 'Skin');
});


test('BB1: Cluster has Version=100 + UserData(2 empty strings) + Transform matrices', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const clusters = getClusters(exportToTree(scene));
  assert.equal(clusters.length, 2);
  for (const c of clusters) {
    assert.equal(findChild(c, 'Version').props[0], 100);
    const ud = findChild(c, 'UserData');
    assert.ok(ud, 'UserData child present');
    assert.equal(ud.props[0], '');
    assert.equal(ud.props[1], '');
    assert.ok(findChild(c, 'Transform'));
    assert.ok(findChild(c, 'TransformLink'));
    assert.ok(findChild(c, 'TransformAssociateModel'));
  }
});

test('BB2: Cluster Indexes is INT32 array; Weights is FLOAT64 array', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const cluster = getClusters(exportToTree(scene))
    .find((c) => c.props[1].startsWith('B0'));
  const idx = findChild(cluster, 'Indexes').props[0];
  const wts = findChild(cluster, 'Weights').props[0];
  assert.equal(idx.length, 1, 'B0 owns vertex 0 only');
  assert.equal(wts.length, 1);
  const idxView = new Int32Array(idx.data.buffer, idx.data.byteOffset, idx.length);
  assert.equal(idxView[0], 0, 'vertex 0');
  const wtsView = new Float64Array(wts.data.buffer, wts.data.byteOffset, wts.length);
  assert.ok(Math.abs(wtsView[0] - 1.0) < 1e-12, `weight: ${wtsView[0]}`);
});

test('BB3: Cluster with NO weights to a bone omits Indexes + Weights', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0,0,0, 1,0,0, 0,1,0,
  ], 3));
  geom.setIndex([0, 1, 2]);
  geom.setAttribute('skinIndex',
    new THREE.Uint16BufferAttribute(new Uint16Array(12), 4));
  geom.setAttribute('skinWeight',
    new THREE.Float32BufferAttribute(new Float32Array([
      1, 0, 0, 0,  1, 0, 0, 0,  1, 0, 0, 0,
    ]), 4));
  const b0 = new THREE.Bone(); b0.name = 'B0';
  const b1 = new THREE.Bone(); b1.name = 'B1';
  b0.add(b1);
  const sm = new THREE.SkinnedMesh(geom, new THREE.MeshStandardMaterial());
  sm.add(b0);
  sm.bind(new THREE.Skeleton([b0, b1]));
  scene.add(sm);

  const clusters = getClusters(exportToTree(scene));
  const b1Cluster = clusters.find((c) => c.props[1].startsWith('B1'));
  assert.ok(b1Cluster);
  assert.ok(!findChild(b1Cluster, 'Indexes'), 'no Indexes when bone is unused');
  assert.ok(!findChild(b1Cluster, 'Weights'), 'no Weights when bone is unused');
  assert.ok(findChild(b1Cluster, 'Transform'));
  assert.ok(findChild(b1Cluster, 'TransformLink'));
});

test('BB4: Cluster attrName ends with \\x00\\x01SubDeformer (NOT Deformer)', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const c = getClusters(exportToTree(scene))[0];
  assert.ok(c.props[1].endsWith('\x00\x01SubDeformer'),
    `Cluster attrName: ${JSON.stringify(c.props[1])}`);
});


test('BC1: Cluster.TransformLink equals boneInverses[i].invert() element-by-element', () => {
  const scene = new THREE.Scene();
  const { sm, skeleton } = buildKnownScene();
  scene.add(sm);
  scene.updateMatrixWorld(true);

  const clusters = getClusters(exportToTree(scene));
  for (let i = 0; i < 2; i++) {
    const tl = findChild(clusters[i], 'TransformLink').props[0];
    const tlBytes = f64ArrayToNumbers(tl);

    const expected = new THREE.Matrix4().copy(skeleton.boneInverses[i]).invert();
    for (let k = 0; k < 16; k++) {
      assert.ok(
        Math.abs(tlBytes[k] - expected.elements[k]) < 1e-9,
        `bone ${i} TransformLink[${k}]: got ${tlBytes[k]} expected ${expected.elements[k]}`,
      );
    }
  }
});

test('BC2: Cluster.Transform equals boneInverses[i] × bindMatrix (column-major)', () => {
  const scene = new THREE.Scene();
  const { sm, skeleton } = buildKnownScene();
  scene.add(sm);
  scene.updateMatrixWorld(true);

  const bindMatrix = sm.bindMatrix;
  const clusters = getClusters(exportToTree(scene));
  for (let i = 0; i < 2; i++) {
    const tr = findChild(clusters[i], 'Transform').props[0];
    const trBytes = f64ArrayToNumbers(tr);

    const expected = new THREE.Matrix4().copy(skeleton.boneInverses[i]).multiply(bindMatrix);
    for (let k = 0; k < 16; k++) {
      assert.ok(
        Math.abs(trBytes[k] - expected.elements[k]) < 1e-9,
        `bone ${i} Transform[${k}]: got ${trBytes[k]} expected ${expected.elements[k]}`,
      );
    }
  }
});

test('BC3: Cluster.TransformAssociateModel should be identity (no armature in three.js)', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  scene.updateMatrixWorld(true);

  const cluster = getClusters(exportToTree(scene))[0];
  const tam = findChild(cluster, 'TransformAssociateModel').props[0];
  const tamBytes = f64ArrayToNumbers(tam);
  const identity = new THREE.Matrix4().identity().elements;
  for (let k = 0; k < 16; k++) {
    assert.ok(
      Math.abs(tamBytes[k] - identity[k]) < 1e-9,
      `TransformAssociateModel[${k}]: ${tamBytes[k]} should be identity[${k}]=${identity[k]}`,
    );
  }
});


test('BD1: BindPose has Type="BindPose" + Version=100 + NbPoseNodes matches mesh+bones', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const objects = findRoot(exportToTree(scene), 'Objects');
  const pose = objects.children.find((c) => c.name === 'Pose');
  assert.equal(findChild(pose, 'Type').props[0], 'BindPose');
  assert.equal(findChild(pose, 'Version').props[0], 100);
  assert.equal(findChild(pose, 'NbPoseNodes').props[0], 3);

  const poseNodes = findChildren(pose, 'PoseNode');
  assert.equal(poseNodes.length, 3);
  for (const pn of poseNodes) {
    assert.ok(findChild(pn, 'Node'));
    const mat = findChild(pn, 'Matrix');
    assert.ok(mat);
    assert.equal(mat.props[0].length, 16);
  }
});

test('BD2: Mesh PoseNode matrix matches the SkinnedMesh.bindMatrix', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  scene.updateMatrixWorld(true);

  const objects = findRoot(exportToTree(scene), 'Objects');
  const pose = objects.children.find((c) => c.name === 'Pose');
  const poseNodes = findChildren(pose, 'PoseNode');
  const meshPose = poseNodes[0];
  const matBytes = f64ArrayToNumbers(findChild(meshPose, 'Matrix').props[0]);
  for (let k = 0; k < 16; k++) {
    assert.ok(
      Math.abs(matBytes[k] - sm.bindMatrix.elements[k]) < 1e-9,
      `mesh PoseNode Matrix[${k}]: got ${matBytes[k]} expected ${sm.bindMatrix.elements[k]}`,
    );
  }
});


test('BE1: Bone NodeAttribute has TypeFlags="Skeleton" + Properties70.Size', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const objects = findRoot(exportToTree(scene), 'Objects');
  const limbAttrs = objects.children.filter(
    (c) => c.name === 'NodeAttribute' && c.props[2] === 'LimbNode',
  );
  assert.equal(limbAttrs.length, 2);
  for (const attr of limbAttrs) {
    assert.equal(findChild(attr, 'TypeFlags').props[0], 'Skeleton');
    const p70 = findChild(attr, 'Properties70');
    const size = p70.children.find((c) => c.props[0] === 'Size');
    assert.ok(size, 'Size prop in Properties70');
  }
});

test('BE2: Bone Model has subtype "LimbNode" (not "Null")', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const objects = findRoot(exportToTree(scene), 'Objects');
  const models = objects.children.filter((c) => c.name === 'Model');
  const limbModels = models.filter((m) => m.props[2] === 'LimbNode');
  assert.equal(limbModels.length, 2, `expected 2 LimbNode Models, got ${limbModels.length}`);
});

test('BE3: Bone Model Lcl Translation matches Bone.position', () => {
  const scene = new THREE.Scene();
  const { sm, b0, b1 } = buildKnownScene();
  scene.add(sm);
  scene.updateMatrixWorld(true);

  const objects = findRoot(exportToTree(scene), 'Objects');
  const models = objects.children.filter((c) => c.name === 'Model' && c.props[2] === 'LimbNode');

  const findLcl = (model, name) => {
    const p70 = findChild(model, 'Properties70');
    return p70.children.find((c) => c.props[0] === name);
  };

  const b0Model = models.find((m) => m.props[1].startsWith('B0'));
  const b0Trans = findLcl(b0Model, 'Lcl Translation');
  assert.ok(Math.abs(b0Trans.props[4] - b0.position.x) < 1e-6, `B0.x: ${b0Trans.props[4]} vs ${b0.position.x}`);
  assert.ok(Math.abs(b0Trans.props[5] - b0.position.y) < 1e-6, `B0.y`);
  assert.ok(Math.abs(b0Trans.props[6] - b0.position.z) < 1e-6, `B0.z`);

  const b1Model = models.find((m) => m.props[1].startsWith('B1'));
  const b1Trans = findLcl(b1Model, 'Lcl Translation');
  assert.ok(Math.abs(b1Trans.props[4] - b1.position.x) < 1e-6, `B1.x`);
  assert.ok(Math.abs(b1Trans.props[5] - b1.position.y) < 1e-6, `B1.y`);
  assert.ok(Math.abs(b1Trans.props[6] - b1.position.z) < 1e-6, `B1.z`);
});


function parseConnections(tree) {
  const conns = findRoot(tree, 'Connections');
  return conns.children
    .filter((c) => c.name === 'C')
    .map((c) => ({ type: c.props[0], src: c.props[1], dst: c.props[2] }));
}

test('BF1: Skin connects to Geometry (Skin→Geometry direction)', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const tree = exportToTree(scene);
  const objects = findRoot(tree, 'Objects');
  const skin = getSkinDeformer(tree);
  const skinUid = skin.props[0];
  const geom = objects.children.find((c) => c.name === 'Geometry');
  const geomUid = geom.props[0];
  const conns = parseConnections(tree);
  const edge = conns.find((c) => c.src === skinUid && c.dst === geomUid);
  assert.ok(edge, `expected OO Skin(${skinUid}) → Geometry(${geomUid})`);
});

test('BF2: each Cluster connects to the Skin (Cluster→Skin)', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const tree = exportToTree(scene);
  const skinUid = getSkinDeformer(tree).props[0];
  const clusters = getClusters(tree);
  const conns = parseConnections(tree);
  for (const c of clusters) {
    const cUid = c.props[0];
    const edge = conns.find((e) => e.src === cUid && e.dst === skinUid);
    assert.ok(edge, `Cluster(${cUid}) → Skin(${skinUid}) edge missing`);
  }
});

test('BF3: each Bone Model connects to its Cluster (Bone→Cluster, matches FBXLoader.buildSkeleton)', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const tree = exportToTree(scene);
  const objects = findRoot(tree, 'Objects');
  const clusters = getClusters(tree);
  const boneModels = objects.children
    .filter((c) => c.name === 'Model' && c.props[2] === 'LimbNode');
  const conns = parseConnections(tree);
  for (const bm of boneModels) {
    const bmUid = bm.props[0];
    const edges = conns.filter((e) => e.src === bmUid);
    const clusterEdges = edges.filter((e) => clusters.some((cl) => cl.props[0] === e.dst));
    assert.ok(clusterEdges.length >= 1,
      `Bone(${bmUid}) should connect to its Cluster, found edges: ${edges.map((e) => e.dst).join(',')}`);
  }
});

test('BF4: each Bone NodeAttribute connects to its Bone Model', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const tree = exportToTree(scene);
  const objects = findRoot(tree, 'Objects');
  const boneModels = objects.children
    .filter((c) => c.name === 'Model' && c.props[2] === 'LimbNode')
    .map((m) => m.props[0]);
  const limbAttrs = objects.children
    .filter((c) => c.name === 'NodeAttribute' && c.props[2] === 'LimbNode')
    .map((a) => a.props[0]);
  const conns = parseConnections(tree);
  for (const a of limbAttrs) {
    const edges = conns.filter((e) => e.src === a);
    assert.ok(edges.length >= 1, `NodeAttribute(${a}) has no outgoing edge`);
    const target = edges[0].dst;
    assert.ok(boneModels.includes(target), `NodeAttribute(${a}) target ${target} is not a Bone Model`);
  }
});


test('BG1: Definitions registers Deformer template with users = 1 Skin + N Clusters', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const tree = exportToTree(scene);
  const defs = findRoot(tree, 'Definitions');
  const deformerOT = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'Deformer');
  assert.ok(deformerOT, 'ObjectType("Deformer") present');
  assert.equal(findChild(deformerOT, 'Count').props[0], 3);
});

test('BG2: Definitions registers Pose template with users = number of BindPoses', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const tree = exportToTree(scene);
  const defs = findRoot(tree, 'Definitions');
  const poseOT = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'Pose');
  assert.ok(poseOT, 'ObjectType("Pose") present');
  assert.equal(findChild(poseOT, 'Count').props[0], 1);
});


test('BH1: Cluster children appear in order (with weights)', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const cluster = getClusters(exportToTree(scene))
    .find((c) => c.props[1].startsWith('B0'));
  const names = cluster.children.map((c) => c.name);
  assert.deepEqual(names, [
    'Version', 'UserData', 'Indexes', 'Weights',
    'Transform', 'TransformLink', 'TransformAssociateModel',
  ], `got ${JSON.stringify(names)}`);
});

test('BH2: Cluster children appear in order (without weights)', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0,0,0, 1,0,0, 0,1,0,
  ], 3));
  geom.setIndex([0, 1, 2]);
  geom.setAttribute('skinIndex',  new THREE.Uint16BufferAttribute(new Uint16Array(12), 4));
  geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array([
    1, 0, 0, 0,  1, 0, 0, 0,  1, 0, 0, 0,
  ]), 4));
  const b0 = new THREE.Bone(); b0.name = 'B0';
  const b1 = new THREE.Bone(); b1.name = 'B1';
  b0.add(b1);
  const sm = new THREE.SkinnedMesh(geom, new THREE.MeshStandardMaterial());
  sm.add(b0);
  sm.bind(new THREE.Skeleton([b0, b1]));
  scene.add(sm);

  const b1Cluster = getClusters(exportToTree(scene))
    .find((c) => c.props[1].startsWith('B1'));
  const names = b1Cluster.children.map((c) => c.name);
  assert.deepEqual(names, [
    'Version', 'UserData',
    'Transform', 'TransformLink', 'TransformAssociateModel',
  ], `expected no Indexes/Weights, got ${JSON.stringify(names)}`);
});


test('BI1: PoseNode has Node then Matrix in that order', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const objects = findRoot(exportToTree(scene), 'Objects');
  const pose = objects.children.find((c) => c.name === 'Pose');
  for (const pn of findChildren(pose, 'PoseNode')) {
    const names = pn.children.map((c) => c.name);
    assert.deepEqual(names, ['Node', 'Matrix'], `PoseNode children: ${JSON.stringify(names)}`);
  }
});


test('BJ1: NodeAttribute(LimbNode) child order: TypeFlags → Properties70', () => {
  const scene = new THREE.Scene();
  const { sm } = buildKnownScene();
  scene.add(sm);
  const objects = findRoot(exportToTree(scene), 'Objects');
  const attr = objects.children.find(
    (c) => c.name === 'NodeAttribute' && c.props[2] === 'LimbNode',
  );
  const names = attr.children.map((c) => c.name);
  assert.deepEqual(names, ['TypeFlags', 'Properties70'],
    `NodeAttribute children: ${JSON.stringify(names)}`);
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
