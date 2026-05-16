
import { strict as assert } from 'node:assert';

globalThis.self = globalThis;

const THREE = await import('three');
THREE.ColorManagement.enabled = false;
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

const { FBXExporter } = await import('../src/FBXExporter.js');

let passes = 0, fails = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${name}`); console.error(e); }
}

function parseToGroup(bytes) {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new FBXLoader().parse(ab, '');
}

test('box mesh round-trips through FBXLoader', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BoxGeometry(2, 2, 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xff8800 });
  mat.name = 'OrangeBox';
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = 'BoxMesh';
  mesh.position.set(1, 2, 3);
  scene.add(mesh);

  const bytes = new FBXExporter().parseSync(scene);
  const group = parseToGroup(bytes);
  assert.equal(group.type, 'Group');

  let importedMesh = null;
  group.traverse((o) => { if (o.isMesh) importedMesh = o; });
  assert.ok(importedMesh, 'imported scene contains a Mesh');

  scene.updateMatrixWorld(true);
  group.updateMatrixWorld(true);
  const importedPos = new THREE.Vector3().setFromMatrixPosition(importedMesh.matrixWorld);
  assert.ok(Math.abs(importedPos.x - 1) < 1e-4, `x mismatch: ${importedPos.x}`);
  assert.ok(Math.abs(importedPos.y - 2) < 1e-4, `y mismatch: ${importedPos.y}`);
  assert.ok(Math.abs(importedPos.z - 3) < 1e-4, `z mismatch: ${importedPos.z}`);

  const importedPos2 = importedMesh.geometry.attributes.position;
  assert.equal(importedPos2.count, geom.index ? geom.index.count : geom.attributes.position.count);

  assert.ok(importedMesh.material, 'mesh has a material');
  const m = Array.isArray(importedMesh.material) ? importedMesh.material[0] : importedMesh.material;
  assert.equal(m.name, 'OrangeBox');
  assert.ok(m.isMeshPhongMaterial, `expected MeshPhongMaterial, got ${m.type}`);
  assert.ok(Math.abs(m.color.r - 1.0) < 0.05, `color.r off: ${m.color.r}`);
  assert.ok(Math.abs(m.color.g - 0x88 / 0xff) < 0.05, `color.g off: ${m.color.g}`);
  assert.ok(Math.abs(m.color.b) < 0.05, `color.b off: ${m.color.b}`);
});

test('nested Group hierarchy survives', () => {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  group.name = 'MyGroup';
  group.position.set(10, 0, 0);
  scene.add(group);

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial(),
  );
  mesh.name = 'ChildMesh';
  group.add(mesh);

  const bytes = new FBXExporter().parseSync(scene);
  const imported = parseToGroup(bytes);
  imported.updateMatrixWorld(true);

  let foundGroup = null, foundMesh = null;
  imported.traverse((o) => {
    if (o.name === 'MyGroup') foundGroup = o;
    if (o.name === 'ChildMesh') foundMesh = o;
  });
  assert.ok(foundGroup, 'group node imported');
  assert.ok(foundMesh, 'child mesh imported');
  assert.equal(foundMesh.parent, foundGroup, 'parent relation preserved');

  const worldPos = new THREE.Vector3().setFromMatrixPosition(foundMesh.matrixWorld);
  assert.ok(Math.abs(worldPos.x - 10) < 1e-4, `world x: ${worldPos.x}`);
});

test('indexed triangle indices have face-terminator XOR applied', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  const bytes = new FBXExporter().parseSync(scene);
  const imported = parseToGroup(bytes);
  let mesh = null;
  imported.traverse((o) => { if (o.isMesh) mesh = o; });
  assert.ok(mesh, 'mesh decoded');
  const count = mesh.geometry.attributes.position.count;
  assert.equal(count, 36, `expected 36 vertices after FBX face expansion, got ${count}`);
});

test('UV and Normal attributes survive', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial(),
  ));
  const bytes = new FBXExporter().parseSync(scene);
  const imported = parseToGroup(bytes);
  let mesh = null;
  imported.traverse((o) => { if (o.isMesh) mesh = o; });
  assert.ok(mesh.geometry.attributes.normal, 'normals attribute present');
  assert.ok(mesh.geometry.attributes.uv, 'uv attribute present');
  assert.equal(mesh.geometry.attributes.uv.itemSize, 2);
  assert.equal(mesh.geometry.attributes.normal.itemSize, 3);
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
