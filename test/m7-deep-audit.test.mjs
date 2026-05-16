
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

function buildMesh({ relative = true, influences = [0, 0] } = {}) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0,0,0, 1,0,0, 0,1,0,
  ], 3));
  geom.setIndex([0, 1, 2]);
  geom.morphAttributes.position = [
    new THREE.Float32BufferAttribute(new Float32Array([0,1,0, 0,1,0, 0,1,0]), 3),
    new THREE.Float32BufferAttribute(new Float32Array([2,0,0, 2,0,0, 2,0,0]), 3),
  ];
  geom.morphTargetsRelative = relative;
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  mesh.morphTargetDictionary = { Up: 0, Right: 1 };
  mesh.morphTargetInfluences = influences;
  mesh.name = 'M';
  return mesh;
}

function exportTree(scene) {
  const bytes = new FBXExporter().parseSync(scene);
  return { bytes, tree: parseFBXTree(bytes) };
}

function getChannels(tree) {
  const objects = findRoot(tree, 'Objects');
  return objects.children.filter((c) => c.name === 'Deformer' && c.props[2] === 'BlendShapeChannel');
}


test('EA1: BlendShapeChannel.DeformPercent equals influence × 100 for the channel index', () => {
  const scene = new THREE.Scene();
  scene.add(buildMesh({ influences: [0.5, 0.25] }));
  const { tree } = exportTree(scene);
  const channels = getChannels(tree);
  const up    = channels.find((c) => c.props[1].startsWith('Up\x00'));
  const right = channels.find((c) => c.props[1].startsWith('Right\x00'));
  assert.equal(findChild(up,    'DeformPercent').props[0], 50.0, 'Up channel = 0.5 × 100');
  assert.equal(findChild(right, 'DeformPercent').props[0], 25.0, 'Right channel = 0.25 × 100');
});

test('EA2: DeformPercent falls back to 0 when morphTargetInfluences is undefined', () => {
  const scene = new THREE.Scene();
  const mesh = buildMesh();
  delete mesh.morphTargetInfluences;
  scene.add(mesh);
  const { tree } = exportTree(scene);
  const channels = getChannels(tree);
  for (const c of channels) {
    assert.equal(findChild(c, 'DeformPercent').props[0], 0.0);
  }
});

test('EA3: DeformPercent falls back to 0 for indices beyond morphTargetInfluences length', () => {
  const scene = new THREE.Scene();
  scene.add(buildMesh({ influences: [0.7] }));
  const { tree } = exportTree(scene);
  const channels = getChannels(tree);
  const up    = channels.find((c) => c.props[1].startsWith('Up\x00'));
  const right = channels.find((c) => c.props[1].startsWith('Right\x00'));
  assert.equal(findChild(up,    'DeformPercent').props[0], 70.0);
  assert.equal(findChild(right, 'DeformPercent').props[0], 0.0);
});


test('EB1: Shape Geometry children: Properties70, Version, Indexes, Vertices', () => {
  const scene = new THREE.Scene();
  scene.add(buildMesh());
  const { tree } = exportTree(scene);
  const objects = findRoot(tree, 'Objects');
  const shape = objects.children.find((c) => c.name === 'Geometry' && c.props[2] === 'Shape');
  const names = shape.children.map((c) => c.name);
  assert.deepEqual(names,
    ['Properties70', 'Version', 'Indexes', 'Vertices'],
    `Shape Geometry children: ${JSON.stringify(names)}`);
});


test('EC1: Channel children: Version, DeformPercent, FullWeights', () => {
  const scene = new THREE.Scene();
  scene.add(buildMesh());
  const { tree } = exportTree(scene);
  const channel = getChannels(tree)[0];
  const names = channel.children.map((c) => c.name);
  assert.deepEqual(names, ['Version', 'DeformPercent', 'FullWeights']);
});


test('ED1: Deformer.Count = 1 BlendShape + N BlendShapeChannels per morph mesh', () => {
  const scene = new THREE.Scene();
  scene.add(buildMesh());
  const { tree } = exportTree(scene);
  const defs = findRoot(tree, 'Definitions');
  const deformerOT = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'Deformer');
  assert.equal(findChild(deformerOT, 'Count').props[0], 3);
});

test('ED2: Geometry.Count includes shape geometries (1 base + 2 shapes for our mesh)', () => {
  const scene = new THREE.Scene();
  scene.add(buildMesh());
  const { tree } = exportTree(scene);
  const defs = findRoot(tree, 'Definitions');
  const geomOT = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'Geometry');
  assert.equal(findChild(geomOT, 'Count').props[0], 3);
});


test('EE1: FullWeights length matches Indexes length', () => {
  const scene = new THREE.Scene();
  scene.add(buildMesh());
  const { tree } = exportTree(scene);
  const channel = getChannels(tree)[0];
  const fwLen = findChild(channel, 'FullWeights').props[0].length;
  assert.equal(fwLen, 3);
});

test('EE2: FullWeights values are all 100.0 for non-vgroup case', () => {
  const scene = new THREE.Scene();
  scene.add(buildMesh());
  const { tree } = exportTree(scene);
  const channel = getChannels(tree)[0];
  const fw = findChild(channel, 'FullWeights').props[0];
  const view = new Float64Array(fw.data.buffer, fw.data.byteOffset, fw.length);
  for (let i = 0; i < view.length; i++) assert.equal(view[i], 100.0, `fw[${i}]`);
});


test('EF1: Shape Vertices is FLOAT64 array (matches base Geometry Vertices type)', () => {
  const scene = new THREE.Scene();
  scene.add(buildMesh());
  const { tree } = exportTree(scene);
  const objects = findRoot(tree, 'Objects');
  const shape = objects.children.find((c) => c.name === 'Geometry' && c.props[2] === 'Shape');
  const verts = findChild(shape, 'Vertices');
  assert.equal(verts.props[0].tag, DT.FLOAT64_ARRAY, 'Vertices is float64 array');
});

test('EF2: Shape Indexes is INT32 array', () => {
  const scene = new THREE.Scene();
  scene.add(buildMesh());
  const { tree } = exportTree(scene);
  const objects = findRoot(tree, 'Objects');
  const shape = objects.children.find((c) => c.name === 'Geometry' && c.props[2] === 'Shape');
  const indexes = findChild(shape, 'Indexes');
  assert.equal(indexes.props[0].tag, DT.INT32_ARRAY);
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
