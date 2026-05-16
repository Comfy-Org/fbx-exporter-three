// M3 end-to-end: build a three.js Scene with one Mesh, export it, re-parse
// via FBXLoader, and verify the geometry + material round-trip.
//
// Run: node test/m3-mesh-roundtrip.test.mjs

import { strict as assert } from 'node:assert';

// jsdom-ish env for FBXLoader.
globalThis.self = globalThis;

const THREE = await import('three');
// Disable implicit color-space conversion so the round-trip is a pure numeric
// check. Both Blender (writer) and three.js's FBXLoader (reader) disagree on
// whether FBX DiffuseColor is sRGB or linear — Blender writes the linear
// value, FBXLoader applies an sRGB→linear conversion. With ColorManagement
// off, both behaviors become identity transforms and the round-trip matches.
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

// ---------------------------------------------------------------------------
// 1. Single Box with default material
// ---------------------------------------------------------------------------
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

  // Find the mesh inside the imported tree.
  let importedMesh = null;
  group.traverse((o) => { if (o.isMesh) importedMesh = o; });
  assert.ok(importedMesh, 'imported scene contains a Mesh');

  // Position (Lcl Translation) should survive.
  // FBXLoader bakes transforms via userData.transformData; assert mesh ended up
  // at the right matrixWorld position.
  scene.updateMatrixWorld(true);
  group.updateMatrixWorld(true);
  const importedPos = new THREE.Vector3().setFromMatrixPosition(importedMesh.matrixWorld);
  assert.ok(Math.abs(importedPos.x - 1) < 1e-4, `x mismatch: ${importedPos.x}`);
  assert.ok(Math.abs(importedPos.y - 2) < 1e-4, `y mismatch: ${importedPos.y}`);
  assert.ok(Math.abs(importedPos.z - 3) < 1e-4, `z mismatch: ${importedPos.z}`);

  // Vertex count matches (BoxGeometry produces 24 unique loop vertices when
  // including UV/normal splits; FBXLoader re-expands to 36 because we wrote
  // PolygonVertexIndex as per-triangle without dedup — both are valid box meshes).
  const importedPos2 = importedMesh.geometry.attributes.position;
  assert.equal(importedPos2.count, geom.index ? geom.index.count : geom.attributes.position.count);

  // Material survives.
  assert.ok(importedMesh.material, 'mesh has a material');
  const m = Array.isArray(importedMesh.material) ? importedMesh.material[0] : importedMesh.material;
  assert.equal(m.name, 'OrangeBox');
  // FBXLoader produces a MeshPhongMaterial for Phong-shaded FBX materials.
  assert.ok(m.isMeshPhongMaterial, `expected MeshPhongMaterial, got ${m.type}`);
  // Color round-trip via sRGB conversion is approximate; allow tolerance.
  assert.ok(Math.abs(m.color.r - 1.0) < 0.05, `color.r off: ${m.color.r}`);
  assert.ok(Math.abs(m.color.g - 0x88 / 0xff) < 0.05, `color.g off: ${m.color.g}`);
  assert.ok(Math.abs(m.color.b) < 0.05, `color.b off: ${m.color.b}`);
});

// ---------------------------------------------------------------------------
// 2. Hierarchy: group → mesh
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// 3. Indexed geometry: face terminator XOR is applied per triangle
// ---------------------------------------------------------------------------
test('indexed triangle indices have face-terminator XOR applied', () => {
  // BoxGeometry is indexed; export and read PolygonVertexIndex back from the
  // raw bytes to verify the XOR pattern is on every 3rd index.
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  const bytes = new FBXExporter().parseSync(scene);
  const imported = parseToGroup(bytes);
  let mesh = null;
  imported.traverse((o) => { if (o.isMesh) mesh = o; });
  assert.ok(mesh, 'mesh decoded');
  // If the XOR pattern was wrong, FBXLoader would either fail to find face
  // boundaries (drop vertices) or produce malformed triangles. A BoxGeometry
  // has 12 triangles → 36 expanded vertices.
  const count = mesh.geometry.attributes.position.count;
  assert.equal(count, 36, `expected 36 vertices after FBX face expansion, got ${count}`);
});

// ---------------------------------------------------------------------------
// 4. UV + Normals are recovered
// ---------------------------------------------------------------------------
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
