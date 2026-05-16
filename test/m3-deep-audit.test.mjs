
import { strict as assert } from 'node:assert';

globalThis.self = globalThis;
globalThis.window = { innerWidth: 1920, innerHeight: 1080, URL: globalThis.URL };

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { FBXExporter } = await import('../src/FBXExporter.js');

let passes = 0, fails = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${name}`); console.error('       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
}

function exportAndReimport(scene, options) {
  const bytes = new FBXExporter().parseSync(scene, options);
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

function findByName(group, name) {
  let found = null;
  group.traverse((o) => { if (o.name === name) found = found || o; });
  return found;
}


test('J1: matrixAutoUpdate=false transform round-trips', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'ManualMatrix';

  const m = new THREE.Matrix4()
    .makeTranslation(7, 0, 0)
    .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 4));
  mesh.matrix.copy(m);
  mesh.matrixAutoUpdate = false;

  scene.add(mesh);

  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  const importedPos = new THREE.Vector3().setFromMatrixPosition(imported.matrixWorld);
  assert.ok(Math.abs(importedPos.x - 7) < 1e-3, `x: ${importedPos.x} (expected ≈ 7)`);
});


test('J2: BufferAttribute(normalized=true) Uint8 vertex colors come out as 0..1 floats', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,  1, 0, 0,  0, 1, 0,
  ], 3));
  geom.setIndex([0, 1, 2]);
  const colBytes = new Uint8Array([
    255, 128, 0, 255,
    255, 128, 0, 255,
    255, 128, 0, 255,
  ]);
  const colAttr = new THREE.BufferAttribute(colBytes, 4, true);
  geom.setAttribute('color', colAttr);
  scene.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ vertexColors: true })));

  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  const c = imported.geometry.attributes.color;
  const r = c.getX(0), gv = c.getY(0);
  assert.ok(r > 0.95 && r <= 1.0, `r: ${r} (expected ≈ 1.0, current bug: 255)`);
  assert.ok(gv > 0.4 && gv < 0.6, `g: ${gv} (expected ≈ 0.5, current bug: 128)`);
});


test('J3: Y=90° rotation (gimbal lock) round-trips', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.quaternion.setFromEuler(new THREE.Euler(0, Math.PI / 2, 0, 'XYZ'));
  scene.add(mesh);

  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  const dot = Math.abs(mesh.quaternion.dot(imported.quaternion));
  assert.ok(dot > 0.999, `quaternion drift at gimbal lock: dot=${dot}`);
});


test('J4: 3-component (RGB) vertex colors round-trip with alpha=1', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.PlaneGeometry(1, 1);
  const n = geom.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3]     = 0.7;
    colors[i * 3 + 1] = 0.3;
    colors[i * 3 + 2] = 0.1;
  }
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ vertexColors: true })));

  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  assert.ok(imported.geometry.attributes.color, 'color attr present');
  const r = imported.geometry.attributes.color.getX(0);
  assert.ok(Math.abs(r - 0.7) < 0.05, `r: ${r}`);
});


test('J5: negative scale exports without crashing', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.scale.set(-1, 1, 1);
  scene.add(mesh);
  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  assert.ok(Math.abs(imported.scale.x - (-1)) < 1e-4, `sx: ${imported.scale.x}`);
});


test('J6: object name containing \\x00 does not corrupt downstream nodes', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'a\x00b';
  scene.add(mesh);
  const { group } = exportAndReimport(scene);
  assert.ok(findMesh(group), 'export tolerates null-byte names');
});


test('J7: anonymous Material (name="") still exports', () => {
  const scene = new THREE.Scene();
  const mat = new THREE.MeshStandardMaterial();
  mat.name = '';
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
  const { group } = exportAndReimport(scene);
  assert.ok(findMesh(group), 'mesh imported');
});


test('J8: Mesh with child Group preserves nested hierarchy', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'ParentMesh';
  const childGroup = new THREE.Group();
  childGroup.name = 'ChildOfMesh';
  childGroup.position.set(0, 3, 0);
  mesh.add(childGroup);
  scene.add(mesh);

  const { group } = exportAndReimport(scene);
  const parent = findByName(group, 'ParentMesh');
  const child = findByName(group, 'ChildOfMesh');
  assert.ok(parent && child);
  assert.equal(child.parent, parent, 'child is parented to the mesh');
});


test('J9: 4 UV sets simultaneously round-trip with the right channel data', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.PlaneGeometry(1, 1);
  const baseUv = geom.attributes.uv.array;
  for (const [name, mul] of [['uv1', 2], ['uv2', 3], ['uv3', 4]]) {
    const arr = new Float32Array(baseUv.length);
    for (let i = 0; i < baseUv.length; i++) arr[i] = baseUv[i] * mul;
    geom.setAttribute(name, new THREE.Float32BufferAttribute(arr, 2));
  }
  scene.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial()));

  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  for (const name of ['uv', 'uv1', 'uv2', 'uv3']) {
    assert.ok(imported.geometry.attributes[name], `${name} missing after round-trip`);
  }
  const uvX = imported.geometry.attributes.uv.getX(0);
  const uv2X = imported.geometry.attributes.uv2.getX(0);
  if (Math.abs(uvX) > 1e-6) {
    const ratio = uv2X / uvX;
    assert.ok(Math.abs(ratio - 3) < 0.1, `uv2/uv ratio: ${ratio} (expected ≈ 3)`);
  }
});


test('J10: geometry with morphAttributes (deferred to M7) exports cleanly', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BoxGeometry();
  const morph = new Float32Array(geom.attributes.position.array.length);
  for (let i = 0; i < morph.length; i++) morph[i] = 0.1;
  geom.morphAttributes.position = [new THREE.Float32BufferAttribute(morph, 3)];
  geom.morphTargetsRelative = true;
  scene.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial()));
  const { group } = exportAndReimport(scene);
  assert.ok(findMesh(group), 'mesh with morph targets imports as static (M3 limitation)');
});


test('J11: material with `map` texture exports without crash', () => {
  const scene = new THREE.Scene();
  const tex = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({ map: tex });
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
  const bytes = new FBXExporter().parseSync(scene);
  assert.ok(bytes.length > 0, 'export produced bytes');
});


test('J12: re-export of the same scene is byte-identical', () => {
  const scene = new THREE.Scene();
  const mat = new THREE.MeshStandardMaterial({ color: 0x336699 });
  const geom = new THREE.BoxGeometry();
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(geom, mat);
    m.name = `Inst${i}`;
    m.position.x = i;
    scene.add(m);
  }
  const a = new FBXExporter().parseSync(scene);
  const b = new FBXExporter().parseSync(scene);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) throw new Error(`mismatch at ${i}: ${a[i]} vs ${b[i]}`);
  }
});


test('J13: SphereGeometry round-trips cleanly', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.MeshStandardMaterial(),
  ));
  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  assert.ok(imported.geometry.attributes.position.count > 100, 'has many vertices');
  assert.ok(imported.geometry.attributes.normal, 'normals present');
});


test('J14: interleaved Float32 buffer with non-zero attribute offsets', () => {
  const stride = 8;
  const data = new Float32Array(stride * 4);
  const quads = [
    [-1,-1,0,  0,0,1,  0,0],
    [ 1,-1,0,  0,0,1,  1,0],
    [ 1, 1,0,  0,0,1,  1,1],
    [-1, 1,0,  0,0,1,  0,1],
  ];
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 8; k++) data[i * stride + k] = quads[i][k];
  }
  const ib = new THREE.InterleavedBuffer(data, stride);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
  geom.setAttribute('normal',   new THREE.InterleavedBufferAttribute(ib, 3, 3));
  geom.setAttribute('uv',       new THREE.InterleavedBufferAttribute(ib, 2, 6));
  geom.setIndex([0, 1, 2, 0, 2, 3]);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial()));

  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  const uvX = imported.geometry.attributes.uv.getX(1);
  const uvY = imported.geometry.attributes.uv.getY(1);
  assert.ok(Math.abs(uvX - 1) < 1e-4 && Math.abs(uvY) < 1e-4, `uv@1: (${uvX}, ${uvY})`);
});


test('J15: BoxGeometry groups discarded when only one material is attached', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BoxGeometry();
  assert.ok(geom.groups.length === 6, 'pre: BoxGeometry has 6 groups');
  scene.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xff00ff })));

  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  assert.ok(!Array.isArray(imported.material), 'single material is not wrapped in array');
  assert.equal(imported.geometry.groups.length, 0,
    `expected 0 groups after AllSame mapping, got ${imported.geometry.groups.length}`);
});


test('J16: single-material mesh with multi-group geometry emits AllSame', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BoxGeometry();
  scene.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial()));
  const bytes = new FBXExporter().parseSync(scene);

  const text = new TextDecoder('latin1').decode(bytes);
  const allSame      = '\x07\x00\x00\x00AllSame';
  const byPolygon9   = '\x09\x00\x00\x00ByPolygon';
  const byPolyVtx15  = '\x0f\x00\x00\x00ByPolygonVertex';
  assert.ok(text.includes(allSame), 'AllSame (length=7) appears in output');
  assert.ok(!text.includes(byPolygon9), 'ByPolygon (length=9) does NOT appear');
  assert.ok(text.includes(byPolyVtx15), 'ByPolygonVertex (length=15) appears');
});


test('J17: ByPolygon Materials array length equals polygon count', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BoxGeometry();
  scene.add(new THREE.Mesh(geom, [
    new THREE.MeshStandardMaterial(),
    new THREE.MeshStandardMaterial(),
    new THREE.MeshStandardMaterial(),
    new THREE.MeshStandardMaterial(),
    new THREE.MeshStandardMaterial(),
    new THREE.MeshStandardMaterial(),
  ]));
  const bytes = new FBXExporter().parseSync(scene);

  const { length, encoding } = decodeMaterialsArray(bytes);
  assert.equal(length, 12, `Materials array length: ${length} (expected 12)`);
});

import { unzlibSync } from 'fflate';
import * as DT from '../src/core/dataTypes.js';

function decodeMaterialsArray(u8) {
  const text = new TextDecoder('latin1').decode(u8);
  const needle = '\x09Materials';
  const at = text.indexOf(needle);
  if (at < 0) throw new Error('Materials node not found in output');
  const tagOffset = at + 1 + 9;
  assert.equal(u8[tagOffset], DT.INT32_ARRAY, `expected int32 array tag, got 0x${u8[tagOffset].toString(16)}`);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const length = dv.getUint32(tagOffset + 1, true);
  const encoding = dv.getUint32(tagOffset + 5, true);
  return { length, encoding };
}


test('J18: InstancedMesh exports as a single Mesh (instances dropped)', () => {
  const scene = new THREE.Scene();
  const inst = new THREE.InstancedMesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial(),
    10,
  );
  for (let i = 0; i < 10; i++) {
    inst.setMatrixAt(i, new THREE.Matrix4().setPosition(i, 0, 0));
  }
  scene.add(inst);
  const { group } = exportAndReimport(scene);
  assert.ok(findMesh(group), 'base mesh imported');
});


test('J19: LineSegments exports without crash (Null model)', () => {
  const scene = new THREE.Scene();
  const lineGeom = new THREE.BufferGeometry();
  lineGeom.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0,
  ], 3));
  const line = new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial());
  line.name = 'TheLine';
  scene.add(line);
  const { group } = exportAndReimport(scene);
  assert.ok(findByName(group, 'TheLine'), 'line node imported as a Null/Group');
});

test('J19b: Points exports without crash', () => {
  const scene = new THREE.Scene();
  const ptGeom = new THREE.BufferGeometry();
  ptGeom.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,  1, 1, 1,
  ], 3));
  const pts = new THREE.Points(ptGeom, new THREE.PointsMaterial());
  pts.name = 'ThePoints';
  scene.add(pts);
  const { group } = exportAndReimport(scene);
  assert.ok(findByName(group, 'ThePoints'));
});


test('J20: shared geometry, different materials — both meshes round-trip', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BoxGeometry();
  const matA = new THREE.MeshStandardMaterial({ color: 0xff0000 }); matA.name = 'A';
  const matB = new THREE.MeshStandardMaterial({ color: 0x00ff00 }); matB.name = 'B';
  const meshA = new THREE.Mesh(geom, matA); meshA.name = 'MeshA';
  const meshB = new THREE.Mesh(geom, matB); meshB.name = 'MeshB';
  meshB.position.x = 3;
  scene.add(meshA, meshB);

  const { group } = exportAndReimport(scene);
  const a = findByName(group, 'MeshA');
  const b = findByName(group, 'MeshB');
  assert.ok(a && b, 'both meshes imported');
  const ma = Array.isArray(a.material) ? a.material[0] : a.material;
  const mb = Array.isArray(b.material) ? b.material[0] : b.material;
  assert.equal(ma.name, 'A');
  assert.equal(mb.name, 'B');
});


test('J21: Float64BufferAttribute position round-trips', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BufferGeometry();
  const positions = new Float64Array([
    0.123456789012345, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ]);
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex([0, 1, 2]);
  scene.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial()));
  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  assert.equal(imported.geometry.attributes.position.count, 3);
});


test('J22: mesh without position attribute throws a descriptive error', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BufferGeometry();
  scene.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial()));
  let err = null;
  try { new FBXExporter().parseSync(scene); }
  catch (e) { err = e; }
  assert.ok(err, 'export should throw on missing position');
  assert.ok(/position/i.test(err.message), `error mentions position: ${err.message}`);
});


test('J23: omitting normals also omits the LayerElementNormal TOC entry', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0,0,0, 1,0,0, 0,1,0,
  ], 3));
  geom.setIndex([0, 1, 2]);
  scene.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial()));
  const bytes = new FBXExporter().parseSync(scene);

  const text = new TextDecoder('latin1').decode(bytes);
  const layerElementNormalId = '\x12LayerElementNormal';
  assert.ok(!text.includes(layerElementNormalId),
    'LayerElementNormal node should not appear when no normals are exported');
});


test('J24: unicode mesh names survive UTF-8 round-trip', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = '日本語Test🎲';
  scene.add(mesh);
  const { group } = exportAndReimport(scene);
  const imported = findByName(group, '日本語Test🎲');
  assert.ok(imported, `mesh by unicode name found`);
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
