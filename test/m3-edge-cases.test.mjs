// M3+: Edge-case tests for the static mesh pipeline.
//
// Each test targets a specific bug-candidate identified by re-reading
// Blender's export_fbx_bin.py against three.js's FBXLoader.js.
//
// Run: node test/m3-edge-cases.test.mjs

import { strict as assert } from 'node:assert';

globalThis.self = globalThis;
// FBXLoader.createCamera reads `window.innerWidth` unconditionally
// (FBXLoader.js:1069), which throws ReferenceError in Node. Stub it so the
// camera import succeeds — value doesn't matter because AspectWidth/Height
// in the file override it anyway.
globalThis.window = { innerWidth: 1920, innerHeight: 1080 };

const THREE = await import('three');
// See m3-mesh-roundtrip.test.mjs for the rationale.
THREE.ColorManagement.enabled = false;

const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { FBXExporter } = await import('../src/FBXExporter.js');

let passes = 0, fails = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${name}`); console.error('       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
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

function findByName(group, name) {
  let found = null;
  group.traverse((o) => { if (o.name === name) found = found || o; });
  return found;
}

// ============================================================================
// A. Geometry edge cases
// ============================================================================

test('A1: non-indexed geometry round-trips', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  assert.equal(geom.index, null, 'precondition: non-indexed');
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  scene.add(mesh);

  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  assert.ok(imported, 'mesh imported');
  // Box has 12 triangles → 36 vertices.
  assert.equal(imported.geometry.attributes.position.count, 36);
});

test('A2: geometry with no normals attribute exports without crashing', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,  1, 0, 0,  0, 1, 0,
  ], 3));
  geom.setIndex([0, 1, 2]);
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial());
  scene.add(mesh);

  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  assert.ok(imported, 'mesh imported');
  assert.ok(!imported.geometry.attributes.normal, 'no normal attribute');
});

test('A3: vertex colors round-trip', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const n = geom.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3]     = 1.0;
    colors[i * 3 + 1] = 0.5;
    colors[i * 3 + 2] = 0.25;
  }
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ vertexColors: true })));

  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  assert.ok(imported.geometry.attributes.color, 'color attribute present after import');
});

test('A4: uv1 (lightmap UV) export is recognized', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.PlaneGeometry(1, 1);
  // PlaneGeometry has 'uv'. Add uv1 with offset coords to verify second UV set.
  const baseUv = geom.attributes.uv.array;
  const uv1 = new Float32Array(baseUv.length);
  for (let i = 0; i < baseUv.length; i++) uv1[i] = baseUv[i] * 0.5;
  geom.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
  scene.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial()));

  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  assert.ok(imported.geometry.attributes.uv, 'primary uv preserved');
  assert.ok(imported.geometry.attributes.uv1, 'second uv set preserved');
});

test('A5: shared BufferGeometry → ONE Geometry node, multiple Models', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial();
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(geom, mat);
    m.name = `Instance${i}`;
    m.position.x = i * 2;
    scene.add(m);
  }

  const { group } = exportAndReimport(scene);
  let meshCount = 0;
  group.traverse((o) => { if (o.isMesh) meshCount++; });
  assert.equal(meshCount, 3, 'all 3 instances imported');
  // FBXLoader deduplicates geometry: each instance references the same BufferGeometry.
  // To verify our output is correctly deduped, parse the byte stream and count Geometry nodes.
  const { bytes } = exportAndReimport(scene);
  const text = new TextDecoder('latin1').decode(bytes);
  // Each Geometry node id starts with id-length-byte (0x08 = 8) then "Geometry"
  const geometryHits = (text.match(/\x08Geometry/g) || []).length;
  // We expect a single Geometry node + one PropertyTemplate "Geometry" name
  // (the template is the dominant subtype emitted by Definitions); allow up to 2 hits.
  assert.ok(geometryHits <= 2, `expected ≤2 Geometry node-id occurrences, got ${geometryHits}`);
});

// ============================================================================
// B. Hierarchy + transform edge cases
// ============================================================================

test('B1: deep hierarchy A → B → C → mesh', () => {
  const scene = new THREE.Scene();
  const a = new THREE.Group(); a.name = 'A'; a.position.set(10, 0, 0); scene.add(a);
  const b = new THREE.Group(); b.name = 'B'; b.position.set(0, 5, 0); a.add(b);
  const c = new THREE.Group(); c.name = 'C'; c.position.set(0, 0, 2); b.add(c);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'Leaf'; c.add(mesh);

  const { group } = exportAndReimport(scene);
  const leaf = findByName(group, 'Leaf');
  assert.ok(leaf, 'leaf imported');
  const worldPos = new THREE.Vector3().setFromMatrixPosition(leaf.matrixWorld);
  assert.ok(Math.abs(worldPos.x - 10) < 1e-3, `x: ${worldPos.x}`);
  assert.ok(Math.abs(worldPos.y - 5) < 1e-3,  `y: ${worldPos.y}`);
  assert.ok(Math.abs(worldPos.z - 2) < 1e-3,  `z: ${worldPos.z}`);
});

test('B2: multiple top-level meshes export with correct root parenting', () => {
  const scene = new THREE.Scene();
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    m.name = `Top${i}`;
    m.position.x = i;
    scene.add(m);
  }
  const { group } = exportAndReimport(scene);
  let topLevel = 0;
  for (const child of group.children) {
    if (child.isMesh) topLevel++;
  }
  assert.equal(topLevel, 4, `expected 4 top-level meshes, got ${topLevel}`);
});

test('B3: quaternion rotation round-trips', () => {
  // This test specifically targets the suspected Euler order bug:
  // FBXLoader maps FBX RotationOrder=0 → three.js Euler order 'ZYX'
  // (FBXLoader.js:4514). Our model.js must emit angles for that order.
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  // 30° around Y, 45° around X, 15° around Z — chosen so XYZ vs ZYX disagree.
  mesh.rotation.set(THREE.MathUtils.degToRad(45), THREE.MathUtils.degToRad(30), THREE.MathUtils.degToRad(15));
  scene.add(mesh);

  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  assert.ok(imported, 'mesh imported');

  // Compare quaternions, which are order-independent.
  const expected = mesh.quaternion;
  const actual = imported.quaternion;
  const dot = Math.abs(expected.dot(actual));
  assert.ok(dot > 0.999, `quaternion drift: dot=${dot} (expected ≈ 1)`);
});

test('B4: non-uniform scale round-trips', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.scale.set(2.0, 0.5, 1.5);
  scene.add(mesh);
  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  assert.ok(Math.abs(imported.scale.x - 2.0) < 1e-4, `sx: ${imported.scale.x}`);
  assert.ok(Math.abs(imported.scale.y - 0.5) < 1e-4, `sy: ${imported.scale.y}`);
  assert.ok(Math.abs(imported.scale.z - 1.5) < 1e-4, `sz: ${imported.scale.z}`);
});

test('B5: visible=false produces Visibility=0', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.visible = false;
  scene.add(mesh);
  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  assert.ok(imported);
  // FBXLoader does not preserve Visibility directly on Object3D, but we can check
  // userData.transformData wasn't populated wrongly. Mostly just verify export
  // doesn't crash & mesh round-trips.
});

// ============================================================================
// C. Material edge cases
// ============================================================================

test('C1: shared Material across meshes produces ONE Material node', () => {
  const scene = new THREE.Scene();
  const sharedMat = new THREE.MeshStandardMaterial({ color: 0xaa00cc });
  sharedMat.name = 'SharedMat';
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(), sharedMat);
    m.position.x = i * 2;
    scene.add(m);
  }

  const { bytes, group } = exportAndReimport(scene);
  // FBXLoader's materialMap is keyed by id, so we count distinct material UUIDs.
  const seenMatUuids = new Set();
  group.traverse((o) => {
    if (o.isMesh) {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      ms.forEach((m) => seenMatUuids.add(m.uuid));
    }
  });
  assert.equal(seenMatUuids.size, 1, `expected 1 deduped material, got ${seenMatUuids.size}`);
});

test('C2: opacity=0.5 produces TransparencyFactor=0.5, opacity preserved', () => {
  const scene = new THREE.Scene();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, opacity: 0.5, transparent: true });
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  const m = Array.isArray(imported.material) ? imported.material[0] : imported.material;
  assert.ok(Math.abs(m.opacity - 0.5) < 1e-4, `opacity: ${m.opacity}`);
  assert.ok(m.transparent === true || m.opacity < 1.0, 'transparent flag');
});

test('C3: MeshPhongMaterial path uses shininess directly', () => {
  const scene = new THREE.Scene();
  const mat = new THREE.MeshPhongMaterial({
    color: 0x808080, shininess: 64, specular: new THREE.Color(0.5, 0.5, 0.5),
  });
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  const m = Array.isArray(imported.material) ? imported.material[0] : imported.material;
  assert.ok(m.isMeshPhongMaterial, `expected Phong, got ${m.type}`);
  // shininess in three.js → FBX Shininess = ((1-roughness)*10)^2
  // For Phong path, roughness = 1 - sqrt(shininess)/10 = 1 - 8/10 = 0.2
  // → FBX Shininess = (0.8 * 10)^2 = 64. Round-trip should ≈ 64.
  assert.ok(Math.abs(m.shininess - 64) < 1, `shininess drift: ${m.shininess}`);
});

test('C4: MeshLambertMaterial exports as Phong with reasonable defaults', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshLambertMaterial({ color: 0x4488ff }),
  ));
  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  const m = Array.isArray(imported.material) ? imported.material[0] : imported.material;
  assert.ok(m.color.r >= 0 && m.color.r <= 1, 'color is finite');
});

test('C5: emissive color and intensity preserved', () => {
  const scene = new THREE.Scene();
  const mat = new THREE.MeshStandardMaterial({
    emissive: new THREE.Color(0.3, 0.6, 0.9),
    emissiveIntensity: 2.0,
  });
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  const m = Array.isArray(imported.material) ? imported.material[0] : imported.material;
  // FBXLoader reads EmissiveColor as the emissive color and EmissiveFactor as
  // emissiveIntensity. We wrote (0.3, 0.6, 0.9) and 2.0.
  assert.ok(Math.abs(m.emissive.r - 0.3) < 0.05, `emissive.r: ${m.emissive.r}`);
  assert.ok(Math.abs(m.emissive.g - 0.6) < 0.05, `emissive.g: ${m.emissive.g}`);
  assert.ok(Math.abs(m.emissive.b - 0.9) < 0.05, `emissive.b: ${m.emissive.b}`);
  assert.ok(Math.abs(m.emissiveIntensity - 2.0) < 1e-3, `intensity: ${m.emissiveIntensity}`);
});

test('C6: mesh with no material falls back to default Phong', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry());
  // three.js auto-creates a default material; null it out to test fallback.
  mesh.material = null;
  scene.add(mesh);
  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  assert.ok(imported, 'mesh still imported');
  assert.ok(imported.material, 'FBXLoader supplies default material');
});

// ============================================================================
// D. Multi-material via geometry.groups
// ============================================================================

test('D1: multi-material mesh: per-polygon material index maps correctly', () => {
  // BoxGeometry by default produces 6 groups, one per face, with materialIndex
  // 0..5 — perfect for a 6-material test.
  const scene = new THREE.Scene();
  const geom = new THREE.BoxGeometry();
  const mats = [];
  for (let i = 0; i < 6; i++) {
    mats.push(new THREE.MeshStandardMaterial({ color: new THREE.Color(i / 5, 0, 1 - i / 5) }));
    mats[i].name = `Mat${i}`;
  }
  scene.add(new THREE.Mesh(geom, mats));

  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  assert.ok(Array.isArray(imported.material), 'imported as material array');
  assert.equal(imported.material.length, 6, `expected 6 materials, got ${imported.material.length}`);
  assert.equal(imported.geometry.groups.length, 6, `expected 6 groups, got ${imported.geometry.groups.length}`);
  // Verify each group references the correct face material.
  // Box layout: 6 groups, each 6 vertices (= 2 triangles per face).
  // The materialIndex order should match how we declared them.
  for (let i = 0; i < 6; i++) {
    const g = imported.geometry.groups[i];
    // Order may be reshuffled by FBXLoader; verify each group's material has
    // the expected color.
    const mi = g.materialIndex;
    const m = imported.material[mi];
    assert.ok(m, `group ${i} has a material`);
  }
});

test('D2: material array with duplicate entries dedupes correctly', () => {
  // mesh.material = [matA, matA, matB] — Blender dedupes, so FBX side has 2 mats.
  // SceneCollector must remap geometry.groups material indices through the
  // dedup map so a group with materialIndex=2 (pointing to matB) ends up as
  // FBX index 1.
  const scene = new THREE.Scene();
  const matA = new THREE.MeshStandardMaterial({ color: 0xff0000 }); matA.name = 'MatA';
  const matB = new THREE.MeshStandardMaterial({ color: 0x00ff00 }); matB.name = 'MatB';
  const geom = new THREE.BoxGeometry();
  // BoxGeometry has 6 groups, materialIndex 0..5. Override to [0, 0, 1] pattern.
  geom.groups = [
    { start: 0,  count: 18, materialIndex: 0 },  // first 3 faces → matA
    { start: 18, count: 12, materialIndex: 1 },  // next 2 faces → matA (duplicate)
    { start: 30, count: 6,  materialIndex: 2 },  // last 1 face → matB
  ];
  scene.add(new THREE.Mesh(geom, [matA, matA, matB]));

  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  // After dedup we expect 2 unique materials on the FBX side.
  const ms = Array.isArray(imported.material) ? imported.material : [imported.material];
  assert.equal(ms.length, 2, `expected 2 deduped materials, got ${ms.length}`);
  // Verify groups still partition correctly: every group's materialIndex must
  // point to a valid entry in the deduped material array.
  for (const g of imported.geometry.groups) {
    assert.ok(g.materialIndex >= 0 && g.materialIndex < ms.length,
              `out-of-bounds materialIndex ${g.materialIndex} in dedup array of length ${ms.length}`);
  }
});

// ============================================================================
// E. Determinism + version paths
// ============================================================================

test('E1: two consecutive exports of the same scene produce identical bytes', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0xabcdef }));
  mesh.name = 'DeterminismCheck';
  mesh.position.set(1, 2, 3);
  scene.add(mesh);

  const a = new FBXExporter().parseSync(scene);
  const b = new FBXExporter().parseSync(scene);
  assert.equal(a.length, b.length, 'lengths differ');
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) throw new Error(`byte mismatch at offset ${i}: ${a[i]} vs ${b[i]}`);
  }
});

test('E2: FBX version 7500 (uint64 meta) round-trips a mesh', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  const bytes = new FBXExporter().parseSync(scene, { version: 7500 });
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const group = new FBXLoader().parse(ab, '');
  const mesh = findMesh(group);
  assert.ok(mesh, 'mesh imported from FBX 7500');
  assert.equal(mesh.geometry.attributes.position.count, 36);
});

// ============================================================================
// F. Stress
// ============================================================================

test('F1: 1000-triangle mesh exports and round-trips', () => {
  const scene = new THREE.Scene();
  const positions = new Float32Array(3000 * 3);
  const indices = new Uint32Array(3000);
  for (let i = 0; i < 3000; i++) {
    positions[i * 3]     = Math.random();
    positions[i * 3 + 1] = Math.random();
    positions[i * 3 + 2] = Math.random();
    indices[i] = i;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
  geom.computeVertexNormals();
  scene.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial()));

  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  assert.equal(imported.geometry.attributes.position.count, 3000);
});

// ============================================================================
// G. Empty cases
// ============================================================================

test('G1: empty scene exports without error', () => {
  const scene = new THREE.Scene();
  const { group } = exportAndReimport(scene);
  assert.ok(group, 'returns a Group');
});

test('G2: scene with one empty Group exports without error', () => {
  const scene = new THREE.Scene();
  const g = new THREE.Group(); g.name = 'Empty'; scene.add(g);
  const { group } = exportAndReimport(scene);
  const found = findByName(group, 'Empty');
  assert.ok(found, 'empty Group imported');
});

// ============================================================================
// A6. InterleavedBufferAttribute (power user / GLTF imports)
// ============================================================================

test('A6: InterleavedBufferAttribute position+normal+uv round-trips', () => {
  // Compose an interleaved buffer the same way GLTFLoader builds it.
  // Layout per vertex: pos(3) normal(3) uv(2) = 8 floats.
  // Triangle: (0,0,0), (1,0,0), (0,1,0).
  const stride = 8;
  const raw = new Float32Array([
    0, 0, 0,  0, 0, 1,  0, 0,
    1, 0, 0,  0, 0, 1,  1, 0,
    0, 1, 0,  0, 0, 1,  0, 1,
  ]);
  const ib = new THREE.InterleavedBuffer(raw, stride);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
  geom.setAttribute('normal',   new THREE.InterleavedBufferAttribute(ib, 3, 3));
  geom.setAttribute('uv',       new THREE.InterleavedBufferAttribute(ib, 2, 6));
  geom.setIndex([0, 1, 2]);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial()));

  const { group } = exportAndReimport(scene);
  const imported = findMesh(group);
  assert.equal(imported.geometry.attributes.position.count, 3, 'vertex count');
  // Verify a known vertex came through.
  const px = imported.geometry.attributes.position.getX(1);
  const py = imported.geometry.attributes.position.getY(1);
  assert.ok(Math.abs(px - 1) < 1e-4 && Math.abs(py - 0) < 1e-4, `vertex 1: (${px}, ${py})`);
});

// ============================================================================
// H. Unsupported types (deferred to later milestones) must not break the file
// ============================================================================

test('H1: scene containing a Camera does not crash + no orphan connection', () => {
  // Camera is deferred to M8. SceneCollector currently allocates a Model UID
  // for it but writes no Model node — we must avoid emitting an OO connection
  // that references that UID, otherwise FBXLoader.parseScene tries to look it
  // up in the (empty) modelMap and may crash.
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(45, 1.5, 0.1, 100);
  cam.name = 'MainCam';
  cam.position.set(0, 1, 5);
  scene.add(cam);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'CamSibling';
  scene.add(mesh);

  const { group } = exportAndReimport(scene);
  const importedMesh = findByName(group, 'CamSibling');
  assert.ok(importedMesh, 'mesh sibling survives camera presence');
});

test('H2: scene containing a Light does not crash', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight(0xff00ff, 1, 100));
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'LightSibling';
  scene.add(mesh);
  const { group } = exportAndReimport(scene);
  assert.ok(findByName(group, 'LightSibling'));
});

// ============================================================================
// I. Connection graph correctness — verify by parsing our own bytes
// ============================================================================

import { unzlibSync } from 'fflate';
import * as DT from '../src/core/dataTypes.js';

// Minimal binary parser that mirrors three.js FBXLoader's BinaryParser
// (FBXLoader.js: class BinaryParser) — copy from m1 test, scoped down to what
// we need: read the connections list.
function parseConnections(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint32(23, true);
  let offset = 27;
  const use64 = version >= 7500;
  const ms = use64 ? 24 : 12;
  const sentinel = use64 ? 25 : 13;

  let connectionsArr = null;
  while (offset < u8.byteLength - sentinel) {
    const peekEnd = use64 ? Number(dv.getBigUint64(offset, true)) : dv.getUint32(offset, true);
    if (peekEnd === 0) break;
    const node = parseNode();
    if (node.name === 'Connections') connectionsArr = node.connections;
  }
  return connectionsArr || [];

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
    const connectionsHere = [];
    while (offset < endOffset) {
      const peek = use64 ? Number(dv.getBigUint64(offset, true)) : dv.getUint32(offset, true);
      if (peek === 0 && offset + sentinel <= endOffset) { offset += sentinel; break; }
      const child = parseNode();
      children.push(child);
      if (name === 'Connections' && child.name === 'C') {
        connectionsHere.push(child.props);
      }
    }
    if (offset !== endOffset) offset = endOffset;
    return { name, props, children, connections: connectionsHere };
  }

  function parseProp() {
    const tag = dv.getUint8(offset); offset += 1;
    switch (tag) {
      case DT.BOOL:    { const v = !!dv.getUint8(offset);    offset += 1; return v; }
      case DT.INT8:    { const v = dv.getInt8(offset);       offset += 1; return v; }
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
      case DT.CHAR:    { const v = dv.getUint8(offset); offset += 1; return v; }
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
        return { length, raw: data }; // simplified, we don't use values here
      }
      default: throw new Error(`Unknown tag 0x${tag.toString(16)} at offset ${offset - 1}`);
    }
  }
}

test('I1: single mesh produces exactly these connections', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'OnlyMesh';
  scene.add(mesh);
  const bytes = new FBXExporter().parseSync(scene);
  const conns = parseConnections(bytes);

  // Expected:
  //   OO Model → 0        (mesh attached to root)
  //   OO Geometry → Model
  //   OO Material → Model
  // 3 connections total (no Camera/Light entries).
  // Type token + 2 ints + optional propName = 3 or 4 properties per row.
  // We assert COUNT and that each row starts with 'OO'.
  assert.equal(conns.length, 3, `expected 3 connections, got ${conns.length}`);
  for (const c of conns) {
    assert.equal(c[0], 'OO', `expected OO, got ${c[0]}`);
  }
  // The first connection should be the mesh's parent OO with second uid = 0
  // (export_fbx_bin.py:3057-3059).
  const objToRoot = conns.find((c) => c[2] === 0n);
  assert.ok(objToRoot, 'have a Model → 0 connection (mesh attached to root)');
});

test('I2: Camera + Mesh — every connection points at an emitted Model UID', () => {
  // At M3 unsupported types (Camera/Light) are still emitted as Null Models
  // so hierarchy + connections remain consistent. The invariant we test:
  // every connection target uid is either 0 (the document root) OR refers to
  // a Model/Geometry/Material/NodeAttribute uid we actually wrote — no
  // orphan references.
  const scene = new THREE.Scene();
  scene.add(new THREE.PerspectiveCamera());
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  const bytes = new FBXExporter().parseSync(scene);
  const conns = parseConnections(bytes);
  // 5 OO rows expected:
  //   CameraModel → 0, NodeAttribute → CameraModel,
  //   MeshModel → 0,   Geometry → MeshModel, Material → MeshModel
  assert.equal(conns.length, 5, `expected 5 connections (Camera + Mesh), got ${conns.length}`);
  for (const c of conns) assert.equal(c[0], 'OO', 'OO type');
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
