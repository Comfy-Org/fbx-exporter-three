
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

function exportToTree(scene, options) {
  const bytes = new FBXExporter().parseSync(scene, options);
  return { bytes, tree: parseFBXTree(bytes) };
}

function buildCube(name = 'Cube') {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial(),
  );
  m.name = name;
  return m;
}

function buildAnimatedScene() {
  const scene = new THREE.Scene();
  const mesh = buildCube('Cube');
  scene.add(mesh);

  const clip = new THREE.AnimationClip('test-clip', 1.0, [
    new THREE.VectorKeyframeTrack('Cube.position', [0, 1], [0, 0, 0, 1, 0, 0]),
  ]);
  scene.animations = [clip];
  return scene;
}


test('creator: default Creator string matches the package brand', () => {
  const scene = new THREE.Scene();
  scene.add(buildCube());
  const { tree } = exportToTree(scene);
  const creator = findRoot(tree, 'Creator');
  assert.ok(creator.props[0].includes('fbx-exporter-three'),
    `default Creator = "${creator.props[0]}"`);
});

test('creator: custom string overrides the default', () => {
  const scene = new THREE.Scene();
  scene.add(buildCube());
  const { tree } = exportToTree(scene, { creator: 'My App v0.1' });
  const creator = findRoot(tree, 'Creator');
  assert.equal(creator.props[0], 'My App v0.1');
});


test('includeAnimations: default → AnimationStack/Curve present when clips exist', () => {
  const scene = buildAnimatedScene();
  const { tree } = exportToTree(scene);
  const objects = findRoot(tree, 'Objects');
  const stacks = findChildren(objects, 'AnimationStack');
  assert.ok(stacks.length >= 1, 'expected AnimationStack');
});

test('includeAnimations: false → no AnimationStack / Curve / CurveNode emitted', () => {
  const scene = buildAnimatedScene();
  const { tree } = exportToTree(scene, { includeAnimations: false });
  const objects = findRoot(tree, 'Objects');
  assert.equal(findChildren(objects, 'AnimationStack').length, 0);
  assert.equal(findChildren(objects, 'AnimationLayer').length, 0);
  assert.equal(findChildren(objects, 'AnimationCurveNode').length, 0);
  assert.equal(findChildren(objects, 'AnimationCurve').length, 0);
});


test('onlyVisible: false (default) → invisible meshes still in Objects', () => {
  const scene = new THREE.Scene();
  const a = buildCube('Visible');
  const b = buildCube('Hidden'); b.visible = false;
  scene.add(a); scene.add(b);
  const { tree } = exportToTree(scene);
  const objects = findRoot(tree, 'Objects');
  const meshes = findChildren(objects, 'Model').filter((m) => m.props[2] === 'Mesh');
  assert.equal(meshes.length, 2);
});

test('onlyVisible: true → invisible meshes skipped', () => {
  const scene = new THREE.Scene();
  const a = buildCube('Visible');
  const b = buildCube('Hidden'); b.visible = false;
  scene.add(a); scene.add(b);
  const { tree } = exportToTree(scene, { onlyVisible: true });
  const objects = findRoot(tree, 'Objects');
  const meshes = findChildren(objects, 'Model').filter((m) => m.props[2] === 'Mesh');
  assert.equal(meshes.length, 1);
  assert.ok(meshes[0].props[1].startsWith('Visible'));
});


test('objectFilter: predicate excludes objects whose name matches', () => {
  const scene = new THREE.Scene();
  scene.add(buildCube('Keep'));
  scene.add(buildCube('Skip'));
  scene.add(buildCube('Keep2'));
  const { tree } = exportToTree(scene, {
    objectFilter: (o) => !o.name.startsWith('Skip'),
  });
  const objects = findRoot(tree, 'Objects');
  const meshes = findChildren(objects, 'Model').filter((m) => m.props[2] === 'Mesh');
  assert.equal(meshes.length, 2);
  assert.ok(!meshes.some((m) => m.props[1].startsWith('Skip')));
});

test('objectFilter: composed with onlyVisible (both must pass)', () => {
  const scene = new THREE.Scene();
  const a = buildCube('A'); scene.add(a);
  const b = buildCube('B'); b.visible = false; scene.add(b);
  const c = buildCube('C-hide-by-name'); scene.add(c);
  const { tree } = exportToTree(scene, {
    onlyVisible: true,
    objectFilter: (o) => !o.name.startsWith('C-'),
  });
  const objects = findRoot(tree, 'Objects');
  const meshes = findChildren(objects, 'Model').filter((m) => m.props[2] === 'Mesh');
  assert.equal(meshes.length, 1);
  assert.ok(meshes[0].props[1].startsWith('A'));
});


function getModelP70(tree, namePrefix) {
  const objects = findRoot(tree, 'Objects');
  const models = findChildren(objects, 'Model');
  const model = models.find((m) => m.props[1].startsWith(namePrefix));
  return findChild(model, 'Properties70');
}

function findP(p70, name) {
  return p70.children.find((c) => c.props[0] === name);
}

test('customProperties: default false → userData entries NOT in Properties70', () => {
  const scene = new THREE.Scene();
  const m = buildCube('M');
  m.userData.tag = 'foo';
  m.userData.score = 42;
  scene.add(m);
  const { tree } = exportToTree(scene);
  const p70 = getModelP70(tree, 'M');
  assert.ok(!findP(p70, 'tag'));
  assert.ok(!findP(p70, 'score'));
});

test('customProperties: true → userData written as U-flagged P records', () => {
  const scene = new THREE.Scene();
  const m = buildCube('M');
  m.userData.tag         = 'foo';
  m.userData.score       = 42;
  m.userData.coefficient = 3.14;
  m.userData.enabled     = true;
  m.userData.pivot       = [1, 2, 3];
  m.userData.nested      = { a: 1, b: 2 };
  scene.add(m);
  const { tree } = exportToTree(scene, { customProperties: true });
  const p70 = getModelP70(tree, 'M');

  const tag = findP(p70, 'tag');
  assert.ok(tag, 'tag prop present');
  assert.equal(tag.props[1], 'KString');
  assert.equal(tag.props[4], 'foo');
  assert.equal(tag.props[3], 'U', 'has U flag');

  const score = findP(p70, 'score');
  assert.equal(score.props[1], 'int');
  assert.equal(score.props[4], 42);

  const coef = findP(p70, 'coefficient');
  assert.equal(coef.props[1], 'double');
  assert.ok(Math.abs(coef.props[4] - 3.14) < 1e-9);

  const enabled = findP(p70, 'enabled');
  assert.equal(enabled.props[1], 'bool');
  assert.equal(enabled.props[4], 1);

  const pivot = findP(p70, 'pivot');
  assert.equal(pivot.props[1], 'Vector3D');
  assert.equal(pivot.props[4], 1);
  assert.equal(pivot.props[5], 2);
  assert.equal(pivot.props[6], 3);

  const nested = findP(p70, 'nested');
  assert.equal(nested.props[1], 'KString');
  assert.equal(nested.props[4], '{"a":1,"b":2}');
});

test('customProperties: null/undefined userData values are skipped', () => {
  const scene = new THREE.Scene();
  const m = buildCube('M');
  m.userData.real = 'yes';
  m.userData.nothing = null;
  m.userData.missing = undefined;
  scene.add(m);
  const { tree } = exportToTree(scene, { customProperties: true });
  const p70 = getModelP70(tree, 'M');
  assert.ok(findP(p70, 'real'));
  assert.ok(!findP(p70, 'nothing'));
  assert.ok(!findP(p70, 'missing'));
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
