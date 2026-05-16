
import { strict as assert } from 'node:assert';
import { unzlibSync } from 'fflate';

globalThis.self = globalThis;

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { FBXExporter } = await import('../src/FBXExporter.js');
import * as DT from '../src/core/dataTypes.js';

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

function findMesh(group, name) {
  let found = null;
  group.traverse((o) => { if (o.isMesh && (!name || o.name === name)) found = found || o; });
  return found;
}

/**
 * Construct a triangle mesh with two morph targets:
 *   morph[0] = "Up"   (deltas push y up by 1)
 *   morph[1] = "Right" (deltas push x right by 2)
 */
function buildSimpleMorphMesh({ relative = true } = {}) {
  const geom = new THREE.BufferGeometry();
  const basePos = new Float32Array([
    0, 0, 0,  1, 0, 0,  0, 1, 0,
  ]);
  geom.setAttribute('position', new THREE.Float32BufferAttribute(basePos, 3));
  geom.setIndex([0, 1, 2]);
  geom.computeVertexNormals();

  const morphUp = relative
    ? new Float32Array([0, 1, 0,  0, 1, 0,  0, 1, 0])
    : new Float32Array([0, 1, 0,  1, 1, 0,  0, 2, 0]);
  const morphRight = relative
    ? new Float32Array([2, 0, 0,  2, 0, 0,  2, 0, 0])
    : new Float32Array([2, 0, 0,  3, 0, 0,  2, 1, 0]);
  geom.morphAttributes.position = [
    new THREE.Float32BufferAttribute(morphUp, 3),
    new THREE.Float32BufferAttribute(morphRight, 3),
  ];
  geom.morphTargetsRelative = relative;

  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  mesh.morphTargetDictionary = { Up: 0, Right: 1 };
  mesh.morphTargetInfluences = [0, 0];
  mesh.name = 'Morphy';
  return mesh;
}


function parseFBXTree(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint32(23, true);
  let offset = 27;
  const use64 = version >= 7500;
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
        return { length, encoding, data, tag };
      }
      default: throw new Error(`Unknown tag 0x${tag.toString(16)}`);
    }
  }
}

function findRoot(t, n) { return t.find((x) => x.name === n); }
function findChild(node, n) { return node && node.children.find((c) => c.name === n); }
function findChildren(node, n) { return node ? node.children.filter((c) => c.name === n) : []; }


test('DA1: mesh with 2 morph targets re-imports with both', () => {
  const scene = new THREE.Scene();
  scene.add(buildSimpleMorphMesh());
  const { group } = exportAndReimport(scene);
  const mesh = findMesh(group);
  assert.ok(mesh.geometry.morphAttributes.position,
    'morphAttributes.position present');
  assert.equal(mesh.geometry.morphAttributes.position.length, 2,
    `expected 2 morphs, got ${mesh.geometry.morphAttributes.position.length}`);
});

test('DA2: imported geometry has morphTargetsRelative = true', () => {
  const scene = new THREE.Scene();
  scene.add(buildSimpleMorphMesh());
  const { group } = exportAndReimport(scene);
  const mesh = findMesh(group);
  assert.equal(mesh.geometry.morphTargetsRelative, true);
});

test('DA3: morph delta values survive the round-trip', () => {
  const scene = new THREE.Scene();
  scene.add(buildSimpleMorphMesh({ relative: true }));
  const { group } = exportAndReimport(scene);
  const mesh = findMesh(group);
  const morphUp = mesh.geometry.morphAttributes.position[0];
  for (let i = 0; i < morphUp.count; i++) {
    const y = morphUp.getY(i);
    assert.ok(Math.abs(y - 1) < 1e-3, `morph[0] vertex ${i} delta y: ${y} (expected 1)`);
  }
});

test('DA4: absolute morph (morphTargetsRelative=false) is converted to deltas on export', () => {
  const scene = new THREE.Scene();
  scene.add(buildSimpleMorphMesh({ relative: false }));
  const { group } = exportAndReimport(scene);
  const mesh = findMesh(group);
  const morphUp = mesh.geometry.morphAttributes.position[0];
  for (let i = 0; i < morphUp.count; i++) {
    const y = morphUp.getY(i);
    assert.ok(Math.abs(y - 1) < 1e-3, `morph[0] vertex ${i} delta y: ${y}`);
  }
});


function getObjects(bytes) {
  return findRoot(parseFBXTree(bytes), 'Objects');
}

test('DB1: file contains 1 BlendShape Deformer + N BlendShapeChannel SubDeformers + N Shape Geometry', () => {
  const scene = new THREE.Scene();
  scene.add(buildSimpleMorphMesh());
  const bytes = new FBXExporter().parseSync(scene);
  const objects = getObjects(bytes);

  const blendShapes = objects.children.filter(
    (c) => c.name === 'Deformer' && c.props[2] === 'BlendShape');
  const channels = objects.children.filter(
    (c) => c.name === 'Deformer' && c.props[2] === 'BlendShapeChannel');
  const shapes = objects.children.filter(
    (c) => c.name === 'Geometry' && c.props[2] === 'Shape');

  assert.equal(blendShapes.length, 1, '1 BlendShape Deformer');
  assert.equal(channels.length, 2,    '2 BlendShapeChannel SubDeformers');
  assert.equal(shapes.length, 2,      '2 Geometry(Shape) blocks');
});

test('DB2: BlendShape Deformer has Version=100', () => {
  const scene = new THREE.Scene();
  scene.add(buildSimpleMorphMesh());
  const objects = getObjects(new FBXExporter().parseSync(scene));
  const blendShape = objects.children.find(
    (c) => c.name === 'Deformer' && c.props[2] === 'BlendShape');
  assert.equal(findChild(blendShape, 'Version').props[0], 100);
});

test('DB3: BlendShapeChannel has Version=100 + DeformPercent + FullWeights', () => {
  const scene = new THREE.Scene();
  scene.add(buildSimpleMorphMesh());
  const objects = getObjects(new FBXExporter().parseSync(scene));
  const channel = objects.children.find(
    (c) => c.name === 'Deformer' && c.props[2] === 'BlendShapeChannel');
  assert.equal(findChild(channel, 'Version').props[0], 100);
  const dp = findChild(channel, 'DeformPercent');
  assert.ok(dp, 'DeformPercent present');
  assert.equal(dp.props[0], 0.0, 'static default = 0');
  const fw = findChild(channel, 'FullWeights');
  assert.equal(fw.props[0].length, 3);
});

test('DB4: Shape Geometry has Indexes + Vertices, Version=100', () => {
  const scene = new THREE.Scene();
  scene.add(buildSimpleMorphMesh());
  const objects = getObjects(new FBXExporter().parseSync(scene));
  const shape = objects.children.find(
    (c) => c.name === 'Geometry' && c.props[2] === 'Shape');
  assert.equal(findChild(shape, 'Version').props[0], 100);
  const indexes = findChild(shape, 'Indexes');
  const vertices = findChild(shape, 'Vertices');
  assert.equal(indexes.props[0].length, 3, '3 indices');
  assert.equal(vertices.props[0].length, 9);
});

test('DB5: ShapeGeometry attrName ends with \\x00\\x01Geometry', () => {
  const scene = new THREE.Scene();
  scene.add(buildSimpleMorphMesh());
  const objects = getObjects(new FBXExporter().parseSync(scene));
  const shape = objects.children.find(
    (c) => c.name === 'Geometry' && c.props[2] === 'Shape');
  assert.ok(shape.props[1].endsWith('\x00\x01Geometry'),
    `attrName: ${JSON.stringify(shape.props[1])}`);
});

test('DB6: BlendShapeChannel attrName ends with \\x00\\x01SubDeformer (NOT Deformer)', () => {
  const scene = new THREE.Scene();
  scene.add(buildSimpleMorphMesh());
  const objects = getObjects(new FBXExporter().parseSync(scene));
  const channel = objects.children.find(
    (c) => c.name === 'Deformer' && c.props[2] === 'BlendShapeChannel');
  assert.ok(channel.props[1].endsWith('\x00\x01SubDeformer'),
    `attrName: ${JSON.stringify(channel.props[1])}`);
});


function parseConnections(tree) {
  return findRoot(tree, 'Connections').children
    .filter((c) => c.name === 'C')
    .map((c) => ({ type: c.props[0], src: c.props[1], dst: c.props[2], rel: c.props[3] }));
}

test('DC1: OO BlendShape → base Geometry', () => {
  const scene = new THREE.Scene();
  scene.add(buildSimpleMorphMesh());
  const tree = parseFBXTree(new FBXExporter().parseSync(scene));
  const objects = findRoot(tree, 'Objects');
  const baseGeom = objects.children.find(
    (c) => c.name === 'Geometry' && c.props[2] !== 'Shape');
  const blendShape = objects.children.find(
    (c) => c.name === 'Deformer' && c.props[2] === 'BlendShape');
  const conns = parseConnections(tree);
  const edge = conns.find((c) =>
    c.type === 'OO' && c.src === blendShape.props[0] && c.dst === baseGeom.props[0]);
  assert.ok(edge, 'BlendShape → base Geometry OO edge present');
});

test('DC2: OO BlendShapeChannel → BlendShape (one per channel)', () => {
  const scene = new THREE.Scene();
  scene.add(buildSimpleMorphMesh());
  const tree = parseFBXTree(new FBXExporter().parseSync(scene));
  const objects = findRoot(tree, 'Objects');
  const channels = objects.children.filter(
    (c) => c.name === 'Deformer' && c.props[2] === 'BlendShapeChannel');
  const blendShape = objects.children.find(
    (c) => c.name === 'Deformer' && c.props[2] === 'BlendShape');
  const conns = parseConnections(tree);
  for (const ch of channels) {
    const edge = conns.find((c) =>
      c.type === 'OO' && c.src === ch.props[0] && c.dst === blendShape.props[0]);
    assert.ok(edge, `channel ${ch.props[0]} → BlendShape edge`);
  }
});

test('DC3: OO ShapeGeometry → BlendShapeChannel (one per channel)', () => {
  const scene = new THREE.Scene();
  scene.add(buildSimpleMorphMesh());
  const tree = parseFBXTree(new FBXExporter().parseSync(scene));
  const objects = findRoot(tree, 'Objects');
  const shapes = objects.children.filter(
    (c) => c.name === 'Geometry' && c.props[2] === 'Shape');
  const channels = objects.children.filter(
    (c) => c.name === 'Deformer' && c.props[2] === 'BlendShapeChannel');
  const conns = parseConnections(tree);
  for (const s of shapes) {
    const edges = conns.filter((c) =>
      c.type === 'OO' && c.src === s.props[0]);
    assert.equal(edges.length, 1);
    assert.ok(channels.some((ch) => ch.props[0] === edges[0].dst),
      `Shape ${s.props[0]} should point at a channel`);
  }
});


test('DD1: morphTargetInfluences[N] track produces DeformPercent AnimCurveNode targeting the channel', () => {
  const scene = new THREE.Scene();
  const mesh = buildSimpleMorphMesh();
  scene.add(mesh);
  const track = new THREE.NumberKeyframeTrack(
    'Morphy.morphTargetInfluences[0]',
    new Float32Array([0, 1]),
    new Float32Array([0, 1]),
  );
  scene.animations = [new THREE.AnimationClip('Lift', 1.0, [track])];

  const tree = parseFBXTree(new FBXExporter().parseSync(scene));
  const objects = findRoot(tree, 'Objects');
  const curveNode = objects.children.find((c) =>
    c.name === 'AnimationCurveNode' && c.props[1].startsWith('DeformPercent\x00\x01'));
  assert.ok(curveNode, 'AnimationCurveNode with attrName DeformPercent present');

  const channels = objects.children.filter(
    (c) => c.name === 'Deformer' && c.props[2] === 'BlendShapeChannel');
  const channelByName = (n) => channels.find((c) => c.props[1].startsWith(`${n}\x00\x01`));
  const targetChannel = channelByName('Up');
  assert.ok(targetChannel, 'channel "Up" found');
  const conns = parseConnections(tree);
  const opEdge = conns.find((c) =>
    c.type === 'OP' && c.src === curveNode.props[0] && c.dst === targetChannel.props[0]);
  assert.ok(opEdge, `OP edge from CurveNode to channel "Up"`);
  assert.equal(opEdge.rel, 'DeformPercent');
});

test('DD2: morph animation values are scaled from 0..1 to 0..100 (DeformPercent percent)', () => {
  const scene = new THREE.Scene();
  scene.add(buildSimpleMorphMesh());
  const track = new THREE.NumberKeyframeTrack(
    'Morphy.morphTargetInfluences[0]',
    new Float32Array([0, 0.5, 1.0]),
    new Float32Array([0, 0.5, 1.0]),
  );
  scene.animations = [new THREE.AnimationClip('Lift', 1.0, [track])];

  const tree = parseFBXTree(new FBXExporter().parseSync(scene));
  const objects = findRoot(tree, 'Objects');
  const curveNode = objects.children.find((c) =>
    c.name === 'AnimationCurveNode' && c.props[1].startsWith('DeformPercent\x00\x01'));
  const conns = parseConnections(tree);
  const curveOp = conns.find((c) =>
    c.type === 'OP' && c.dst === curveNode.props[0] && c.rel === 'd|DeformPercent');
  assert.ok(curveOp, 'AnimCurve linked via "d|DeformPercent"');
  const curves = objects.children.filter((c) => c.name === 'AnimationCurve');
  const curve = curves.find((c) => c.props[0] === curveOp.src);
  const valuesProp = findChild(curve, 'KeyValueFloat').props[0];
  const view = new Float32Array(valuesProp.data.buffer, valuesProp.data.byteOffset, valuesProp.length);
  assert.ok(Math.abs(view[0] - 0)   < 0.01, `v[0]: ${view[0]}`);
  assert.ok(Math.abs(view[1] - 50)  < 0.01, `v[1]: ${view[1]}`);
  assert.ok(Math.abs(view[2] - 100) < 0.01, `v[2]: ${view[2]}`);
});

test('DD3: morph animation round-trips back to morphTargetInfluences[N] track', () => {
  const scene = new THREE.Scene();
  scene.add(buildSimpleMorphMesh());
  scene.animations = [new THREE.AnimationClip('Lift', 1.0, [
    new THREE.NumberKeyframeTrack(
      'Morphy.morphTargetInfluences[0]',
      new Float32Array([0, 1]),
      new Float32Array([0, 1]),
    ),
  ])];
  const { group } = exportAndReimport(scene);
  const clips = group.animations || [];
  assert.equal(clips.length, 1);
  const track = clips[0].tracks.find((t) => t.name.includes('morphTargetInfluences'));
  assert.ok(track, `morphTargetInfluences track in re-import (tracks: ${clips[0].tracks.map(t=>t.name).join(', ')})`);
  const last = track.values[track.values.length - 1];
  assert.ok(Math.abs(last - 1) < 0.02, `last value ${last}`);
});


test('DE1: mesh with no morphs produces no BlendShape nodes', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  const bytes = new FBXExporter().parseSync(scene);
  const objects = getObjects(bytes);
  const blendShapes = objects.children.filter(
    (c) => c.name === 'Deformer' && c.props[2] === 'BlendShape');
  assert.equal(blendShapes.length, 0);
});

test('DE2: mesh with morphs but no morphTargetDictionary uses numeric fallback names', () => {
  const scene = new THREE.Scene();
  const mesh = buildSimpleMorphMesh();
  delete mesh.morphTargetDictionary;
  scene.add(mesh);
  const bytes = new FBXExporter().parseSync(scene);
  const objects = getObjects(bytes);
  const channels = objects.children.filter(
    (c) => c.name === 'Deformer' && c.props[2] === 'BlendShapeChannel');
  const names = channels.map((c) => c.props[1].split('\x00')[0]).sort();
  assert.deepEqual(names, ['morph_0', 'morph_1']);
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
