
import { strict as assert } from 'node:assert';
import { unzlibSync } from 'fflate';

globalThis.self = globalThis;

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { FBXExporter } = await import('../src/FBXExporter.js');
import * as DT from '../src/core/dataTypes.js';
import { FBX_KTIME, FBX_ANIM_KEY_VERSION } from '../src/constants.js';

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
        return { length, encoding, data, tag };
      }
      default: throw new Error(`Unknown tag 0x${tag.toString(16)}`);
    }
  }
}

function findRoot(tree, name) { return tree.find((n) => n.name === name); }
function findChild(node, name) { return node && node.children.find((c) => c.name === name); }
function findChildren(node, name) { return node ? node.children.filter((c) => c.name === name) : []; }

function buildPositionScene() {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'M1';
  scene.add(mesh);
  const track = new THREE.VectorKeyframeTrack(
    'M1.position',
    new Float32Array([0, 0.5, 1.0]),
    new Float32Array([0, 0, 0,  2, 0, 0,  5, 0, 0]),
  );
  scene.animations = [new THREE.AnimationClip('Move', 1.0, [track])];
  return scene;
}

function exportTree(scene) {
  const bytes = new FBXExporter().parseSync(scene);
  return { bytes, tree: parseFBXTree(bytes) };
}


test('CAA1: secondsToKTime(1.0) = FBX_KTIME (= 46186158000)', () => {
  const { tree } = exportTree(buildPositionScene());
  const objects = findRoot(tree, 'Objects');
  const stack = findChild(objects, 'AnimationStack');
  const p70 = findChild(stack, 'Properties70');
  const localStop = p70.children.find((c) => c.props[0] === 'LocalStop');
  assert.equal(localStop.props[4], FBX_KTIME, `LocalStop = ${localStop.props[4]} (expected ${FBX_KTIME})`);
});

test('CAA2: secondsToKTime(0) = 0n', () => {
  const { tree } = exportTree(buildPositionScene());
  const stack = findChild(findRoot(tree, 'Objects'), 'AnimationStack');
  const p70 = findChild(stack, 'Properties70');
  const localStart = p70.children.find((c) => c.props[0] === 'LocalStart');
  assert.equal(localStart.props[4], 0n);
});

test('CAA3: KeyTime array entries are exact multiples of FBX_KTIME/1s for integer times', () => {
  const { tree } = exportTree(buildPositionScene());
  const objects = findRoot(tree, 'Objects');
  const curves = findChildren(objects, 'AnimationCurve');
  assert.ok(curves.length > 0);
  const keyTimeProp = findChild(curves[0], 'KeyTime').props[0];
  assert.equal(keyTimeProp.length, 3);
  const view = new BigInt64Array(keyTimeProp.data.buffer, keyTimeProp.data.byteOffset, 3);
  assert.equal(view[0], 0n);
  assert.equal(view[1], FBX_KTIME / 2n);
  assert.equal(view[2], FBX_KTIME);
});


test('CAB1: AnimationStack carries Properties70 with all 4 timestamps', () => {
  const { tree } = exportTree(buildPositionScene());
  const stack = findChild(findRoot(tree, 'Objects'), 'AnimationStack');
  assert.ok(stack);
  const p70 = findChild(stack, 'Properties70');
  assert.ok(p70);
  const names = p70.children.filter((c) => c.name === 'P').map((c) => c.props[0]);
  for (const required of ['LocalStart', 'LocalStop', 'ReferenceStart', 'ReferenceStop']) {
    assert.ok(names.includes(required), `${required} prop present`);
  }
});

test('CAB2: AnimationStack attrName ends with \\x00\\x01AnimStack', () => {
  const { tree } = exportTree(buildPositionScene());
  const stack = findChild(findRoot(tree, 'Objects'), 'AnimationStack');
  assert.ok(stack.props[1].endsWith('\x00\x01AnimStack'),
    `attrName: ${JSON.stringify(stack.props[1])}`);
});


test('CAC1: AnimationCurveNode has Properties70 with d|X, d|Y, d|Z as p_number', () => {
  const { tree } = exportTree(buildPositionScene());
  const curveNode = findChild(findRoot(tree, 'Objects'), 'AnimationCurveNode');
  const p70 = findChild(curveNode, 'Properties70');
  for (const axis of ['d|X', 'd|Y', 'd|Z']) {
    const p = p70.children.find((c) => c.props[0] === axis);
    assert.ok(p, `${axis} prop present`);
    assert.equal(p.props[1], 'Number', `${axis} type1 = "Number"`);
    assert.equal(p.props[3], 'A', `${axis} flag = "A" (animatable)`);
  }
});

test('CAC2: AnimationCurveNode attrName encodes the kind ("T" for translation)', () => {
  const { tree } = exportTree(buildPositionScene());
  const curveNode = findChild(findRoot(tree, 'Objects'), 'AnimationCurveNode');
  assert.ok(curveNode.props[1].startsWith('T\x00\x01'),
    `attrName: ${JSON.stringify(curveNode.props[1])}`);
});


test('CAD1: AnimationCurve child order', () => {
  const { tree } = exportTree(buildPositionScene());
  const curves = findChildren(findRoot(tree, 'Objects'), 'AnimationCurve');
  assert.ok(curves.length > 0);
  const names = curves[0].children.map((c) => c.name);
  assert.deepEqual(names, [
    'Default', 'KeyVer', 'KeyTime', 'KeyValueFloat',
    'KeyAttrFlags', 'KeyAttrDataFloat', 'KeyAttrRefCount',
  ], `child order: ${JSON.stringify(names)}`);
});

test('CAD2: KeyVer = FBX_ANIM_KEY_VERSION (4008)', () => {
  const { tree } = exportTree(buildPositionScene());
  const curve = findChildren(findRoot(tree, 'Objects'), 'AnimationCurve')[0];
  assert.equal(findChild(curve, 'KeyVer').props[0], FBX_ANIM_KEY_VERSION);
  assert.equal(FBX_ANIM_KEY_VERSION, 4008);
});

test('CAD3: KeyTime is INT64 array; KeyValueFloat is FLOAT32 array (not 64!)', () => {
  const { tree } = exportTree(buildPositionScene());
  const curve = findChildren(findRoot(tree, 'Objects'), 'AnimationCurve')[0];
  assert.equal(findChild(curve, 'KeyTime').props[0].tag, DT.INT64_ARRAY,
    'KeyTime is int64 array');
  assert.equal(findChild(curve, 'KeyValueFloat').props[0].tag, DT.FLOAT32_ARRAY,
    'KeyValueFloat is float32 array (NOT float64)');
});

test('CAD4: KeyAttrRefCount equals number of keys', () => {
  const { tree } = exportTree(buildPositionScene());
  const curve = findChildren(findRoot(tree, 'Objects'), 'AnimationCurve')[0];
  const refCount = findChild(curve, 'KeyAttrRefCount').props[0];
  assert.equal(refCount.length, 1, 'single-entry array');
  const view = new Int32Array(refCount.data.buffer, refCount.data.byteOffset, 1);
  assert.equal(view[0], 3);
});

test('CAD5: AnimationCurve attrName is "\\x00\\x01AnimCurve" (empty name)', () => {
  const { tree } = exportTree(buildPositionScene());
  const curve = findChildren(findRoot(tree, 'Objects'), 'AnimationCurve')[0];
  assert.equal(curve.props[1], '\x00\x01AnimCurve');
});


function parseConnections(tree) {
  return findRoot(tree, 'Connections').children
    .filter((c) => c.name === 'C')
    .map((c) => ({ type: c.props[0], src: c.props[1], dst: c.props[2], rel: c.props[3] }));
}

test('CAE1: OO AnimLayer → AnimStack', () => {
  const { tree } = exportTree(buildPositionScene());
  const stack = findChild(findRoot(tree, 'Objects'), 'AnimationStack');
  const layer = findChild(findRoot(tree, 'Objects'), 'AnimationLayer');
  const conns = parseConnections(tree);
  const edge = conns.find((c) => c.src === layer.props[0] && c.dst === stack.props[0]);
  assert.ok(edge && edge.type === 'OO', 'AnimLayer→AnimStack OO edge');
});

test('CAE2: OO AnimCurveNode → AnimLayer', () => {
  const { tree } = exportTree(buildPositionScene());
  const layer = findChild(findRoot(tree, 'Objects'), 'AnimationLayer');
  const curveNode = findChild(findRoot(tree, 'Objects'), 'AnimationCurveNode');
  const conns = parseConnections(tree);
  const edge = conns.find((c) => c.src === curveNode.props[0] && c.dst === layer.props[0]);
  assert.ok(edge && edge.type === 'OO');
});

test('CAE3: OP AnimCurveNode → Model with "Lcl Translation" relationship', () => {
  const { tree } = exportTree(buildPositionScene());
  const objects = findRoot(tree, 'Objects');
  const curveNode = findChild(objects, 'AnimationCurveNode');
  const conns = parseConnections(tree);
  const opEdges = conns.filter((c) => c.type === 'OP' && c.src === curveNode.props[0]);
  assert.equal(opEdges.length, 1, 'one OP edge from this CurveNode');
  assert.equal(opEdges[0].rel, 'Lcl Translation');
});

test('CAE4: OP AnimCurve → AnimCurveNode with "d|X" / "d|Y" / "d|Z"', () => {
  const { tree } = exportTree(buildPositionScene());
  const curves = findChildren(findRoot(tree, 'Objects'), 'AnimationCurve');
  const curveNode = findChild(findRoot(tree, 'Objects'), 'AnimationCurveNode');
  const conns = parseConnections(tree);
  const rels = new Set();
  for (const curve of curves) {
    const edges = conns.filter((c) => c.src === curve.props[0] && c.dst === curveNode.props[0]);
    assert.equal(edges.length, 1, `curve ${curve.props[0]} has one OP edge`);
    rels.add(edges[0].rel);
  }
  assert.deepEqual([...rels].sort(), ['d|X', 'd|Y', 'd|Z']);
});


test('CAF1: Quaternion track is baked to 3 axes as Float32 degrees', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'R1';
  scene.add(mesh);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0, 'ZYX'));
  scene.animations = [new THREE.AnimationClip('Spin', 1.0, [
    new THREE.QuaternionKeyframeTrack(
      'R1.quaternion',
      new Float32Array([0, 1]),
      new Float32Array([0, 0, 0, 1,  q.x, q.y, q.z, q.w]),
    ),
  ])];
  const { tree } = exportTree(scene);
  const curves = findChildren(findRoot(tree, 'Objects'), 'AnimationCurve');
  const curveNode = findChild(findRoot(tree, 'Objects'), 'AnimationCurveNode');
  const conns = parseConnections(tree);
  let yCurveUid = null;
  for (const c of curves) {
    const edge = conns.find((e) => e.src === c.props[0] && e.dst === curveNode.props[0] && e.rel === 'd|Y');
    if (edge) yCurveUid = c.props[0];
  }
  assert.ok(yCurveUid !== null, 'Y curve identified by OP edge');
  const yCurve = curves.find((c) => c.props[0] === yCurveUid);
  const values = findChild(yCurve, 'KeyValueFloat').props[0];
  const view = new Float32Array(values.data.buffer, values.data.byteOffset, values.length);
  assert.ok(Math.abs(view[1] - 90) < 0.1, `Y degrees at t=1: ${view[1]} (expected ≈ 90)`);
});

test('CAF2: Quaternion unrolling — adjacent keys never differ by >180° on any axis', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'R2';
  scene.add(mesh);
  const times = new Float32Array(9);
  const values = new Float32Array(9 * 4);
  for (let i = 0; i < 9; i++) {
    times[i] = i / 8;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (i * Math.PI) / 4, 0, 'ZYX'));
    values[i * 4]     = q.x;
    values[i * 4 + 1] = q.y;
    values[i * 4 + 2] = q.z;
    values[i * 4 + 3] = q.w;
  }
  scene.animations = [new THREE.AnimationClip('Spin', 1.0, [
    new THREE.QuaternionKeyframeTrack('R2.quaternion', times, values),
  ])];
  const { tree } = exportTree(scene);
  const curves = findChildren(findRoot(tree, 'Objects'), 'AnimationCurve');
  const curveNode = findChild(findRoot(tree, 'Objects'), 'AnimationCurveNode');
  const conns = parseConnections(tree);
  const yCurveUid = curves
    .find((c) => conns.find((e) => e.src === c.props[0] && e.rel === 'd|Y'))
    .props[0];
  const yCurve = curves.find((c) => c.props[0] === yCurveUid);
  const valuesProp = findChild(yCurve, 'KeyValueFloat').props[0];
  const yvals = new Float32Array(valuesProp.data.buffer, valuesProp.data.byteOffset, valuesProp.length);

  for (let i = 1; i < yvals.length; i++) {
    const delta = Math.abs(yvals[i] - yvals[i - 1]);
    assert.ok(delta < 180, `delta at key ${i}: ${delta} (curve must be continuous)`);
  }
});


test('CAG1: Definitions has ObjectType entries for AnimationStack/Layer/CurveNode/Curve', () => {
  const { tree } = exportTree(buildPositionScene());
  const defs = findRoot(tree, 'Definitions');
  const objTypes = findChildren(defs, 'ObjectType').map((o) => o.props[0]);
  for (const required of [
    'AnimationStack', 'AnimationLayer', 'AnimationCurveNode', 'AnimationCurve',
  ]) {
    assert.ok(objTypes.includes(required),
      `expected ObjectType ${required}, got ${JSON.stringify(objTypes)}`);
  }
});

test('CAG2: AnimationCurve count = stacks × tracks × 3 axes', () => {
  const { tree } = exportTree(buildPositionScene());
  const defs = findRoot(tree, 'Definitions');
  const curveOT = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'AnimationCurve');
  assert.equal(findChild(curveOT, 'Count').props[0], 3);
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
