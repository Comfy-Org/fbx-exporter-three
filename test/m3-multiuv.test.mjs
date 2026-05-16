
import { strict as assert } from 'node:assert';
import { unzlibSync } from 'fflate';

globalThis.self = globalThis;
globalThis.window = { innerWidth: 1920, innerHeight: 1080, URL: globalThis.URL };

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { FBXExporter } = await import('../src/FBXExporter.js');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
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
    const nameLen = dv.getUint8(offset); offset += 1;
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
      case DT.INT32_ARRAY: case DT.INT64_ARRAY: case DT.FLOAT32_ARRAY:
      case DT.FLOAT64_ARRAY: case DT.BOOL_ARRAY: case DT.BYTE_ARRAY: {
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

const findRoot = (t, n) => t.find((x) => x.name === n);
const findChild = (n, name) => n && n.children.find((c) => c.name === name);
const findChildren = (n, name) => n ? n.children.filter((c) => c.name === name) : [];

function exportToTree(scene) {
  const bytes = new FBXExporter().parseSync(scene);
  return { bytes, tree: parseFBXTree(bytes) };
}

function buildMeshWithUvs(uvSets) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0,
  ], 3));
  geom.setIndex([0, 1, 2, 0, 2, 3]);
  geom.computeVertexNormals();
  for (const [name, values] of Object.entries(uvSets)) {
    geom.setAttribute(name, new THREE.Float32BufferAttribute(values, 2));
  }
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  mesh.name = 'Quad';
  return mesh;
}


test('A1: only `uv` attribute → exactly 1 LayerElementUV', () => {
  const scene = new THREE.Scene();
  scene.add(buildMeshWithUvs({
    uv: [0, 0, 1, 0, 1, 1, 0, 1],
  }));
  const { tree } = exportToTree(scene);
  const geo = findRoot(tree, 'Objects').children.find((c) => c.name === 'Geometry');
  const uvLayers = findChildren(geo, 'LayerElementUV');
  assert.equal(uvLayers.length, 1);
  assert.equal(uvLayers[0].props[0], 0);
});


test('B1: uv + uv1 → 2 LayerElementUV nodes with distinct TypedIndex', () => {
  const scene = new THREE.Scene();
  scene.add(buildMeshWithUvs({
    uv:  [0, 0, 1, 0, 1, 1, 0, 1],
    uv1: [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9],
  }));
  const { tree } = exportToTree(scene);
  const geo = findRoot(tree, 'Objects').children.find((c) => c.name === 'Geometry');
  const uvLayers = findChildren(geo, 'LayerElementUV');
  assert.equal(uvLayers.length, 2);
  assert.equal(uvLayers[0].props[0], 0);
  assert.equal(uvLayers[1].props[0], 1);
});

test('B2: extra UV layer has unique Name (UVMap / uv1)', () => {
  const scene = new THREE.Scene();
  scene.add(buildMeshWithUvs({
    uv:  [0, 0, 1, 0, 1, 1, 0, 1],
    uv1: [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9],
  }));
  const { tree } = exportToTree(scene);
  const geo = findRoot(tree, 'Objects').children.find((c) => c.name === 'Geometry');
  const uvLayers = findChildren(geo, 'LayerElementUV');
  const names = uvLayers.map((l) => findChild(l, 'Name').props[0]);
  assert.equal(names[0], 'UVMap');
  assert.equal(names[1], 'uv1');
});

test('B3: Layer entries — Layer 0 lists uv0, Layer 1 lists uv1', () => {
  const scene = new THREE.Scene();
  scene.add(buildMeshWithUvs({
    uv:  [0, 0, 1, 0, 1, 1, 0, 1],
    uv1: [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9],
  }));
  const { tree } = exportToTree(scene);
  const geo = findRoot(tree, 'Objects').children.find((c) => c.name === 'Geometry');
  const layers = findChildren(geo, 'Layer');
  assert.ok(layers.length >= 2, `expected ≥2 Layer entries, got ${layers.length}`);

  function uvEntriesIn(layer) {
    return layer.children
      .filter((c) => c.name === 'LayerElement')
      .filter((c) => findChild(c, 'Type').props[0] === 'LayerElementUV')
      .map((c) => findChild(c, 'TypedIndex').props[0]);
  }
  const layer0 = layers.find((l) => l.props[0] === 0);
  const layer1 = layers.find((l) => l.props[0] === 1);
  assert.deepEqual(uvEntriesIn(layer0), [0]);
  assert.deepEqual(uvEntriesIn(layer1), [1]);
});


test('C1: 4 UV layers → 4 LayerElementUV + 4 Layer entries', () => {
  const scene = new THREE.Scene();
  scene.add(buildMeshWithUvs({
    uv:  [0, 0, 1, 0, 1, 1, 0, 1],
    uv1: [0, 0, 1, 0, 1, 1, 0, 1],
    uv2: [0, 0, 1, 0, 1, 1, 0, 1],
    uv3: [0, 0, 1, 0, 1, 1, 0, 1],
  }));
  const { tree } = exportToTree(scene);
  const geo = findRoot(tree, 'Objects').children.find((c) => c.name === 'Geometry');
  const uvLayers = findChildren(geo, 'LayerElementUV');
  assert.equal(uvLayers.length, 4);
  for (let i = 0; i < 4; i++) assert.equal(uvLayers[i].props[0], i);
});


test('D1: FBXLoader re-imports uv1 as attributes.uv1 (modern naming)', async () => {
  const scene = new THREE.Scene();
  const mesh = buildMeshWithUvs({
    uv:  [0, 0, 1, 0, 1, 1, 0, 1],
    uv1: [0.2, 0.2, 0.8, 0.2, 0.8, 0.8, 0.2, 0.8],
  });
  scene.add(mesh);

  const { bytes } = exportToTree(scene);
  const group = new FBXLoader().parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  let imported = null;
  group.traverse((o) => { if (o.isMesh && !imported) imported = o; });
  assert.ok(imported, 'mesh re-imported');

  const attrs = imported.geometry.attributes;
  const uvAttrs = Object.keys(attrs).filter((k) => k.startsWith('uv'));
  assert.ok(uvAttrs.length >= 2, `expected ≥2 UV attributes on re-imported geometry, got: ${uvAttrs.join(', ')}`);

  const primary = attrs.uv ?? attrs.uv0;
  const secondary = attrs.uv1 ?? attrs.uv2;
  assert.ok(primary && secondary, 'both UV sets re-imported');
  let differs = false;
  for (let i = 0; i < primary.count; i++) {
    if (Math.abs(primary.getX(i) - secondary.getX(i)) > 1e-3 ||
        Math.abs(primary.getY(i) - secondary.getY(i)) > 1e-3) {
      differs = true; break;
    }
  }
  assert.ok(differs, 'primary and secondary UV sets carry distinct values');
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
