// E2E #1: load test/_assets/1.obj into three.js, export via our plugin,
// load the produced FBX back via FBXLoader, compare structural invariants.
//
// 1.obj characteristics (per `grep -c`):
//   - 44,901 vertices, 49,676 UVs, 0 normals, 89,999 faces
//   - 1 usemtl reference, no `g` (groups), single mesh
//
// Run: node test/e2e-1-obj.test.mjs

import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

globalThis.self = globalThis;
globalThis.window = { innerWidth: 1920, innerHeight: 1080, URL: globalThis.URL };

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { FBXExporter } = await import('../src/FBXExporter.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const objPath = resolve(__dirname, '_assets/1.obj');
const outDir  = resolve(__dirname, '../out');
mkdirSync(outDir, { recursive: true });
const fbxPath = resolve(outDir, '1.fbx');

console.log('=== E2E #1: 1.obj ===\n');

// -------- Step 1: load .obj into three.js --------
const t0 = performance.now();
const objText = readFileSync(objPath, 'utf8');
const objLoader = new OBJLoader();
const objGroup = objLoader.parse(objText);
const tLoad = performance.now() - t0;

// Walk the loaded group, gather meshes.
const meshes = [];
objGroup.traverse((o) => { if (o.isMesh) meshes.push(o); });

console.log(`Step 1 — OBJLoader.parse: ${tLoad.toFixed(1)} ms`);
console.log(`  Top-level meshes: ${meshes.length}`);
for (let i = 0; i < meshes.length; i++) {
  const g = meshes[i].geometry;
  const pos = g.attributes.position;
  const uv  = g.attributes.uv;
  const nrm = g.attributes.normal;
  const idx = g.index;
  console.log(
    `  [${i}] name="${meshes[i].name}" verts=${pos?.count ?? 0}` +
    ` uvs=${uv?.count ?? 0}` +
    ` normals=${nrm?.count ?? 0}` +
    ` index=${idx ? idx.count : '(non-indexed)'}` +
    ` material=${meshes[i].material?.type ?? 'none'}`,
  );
}

const totalPosBefore = meshes.reduce((s, m) => s + (m.geometry.attributes.position?.count ?? 0), 0);
const hasUV          = meshes.some((m) => m.geometry.attributes.uv);
const hasNormals     = meshes.some((m) => m.geometry.attributes.normal);
console.log(`  Aggregate: ${totalPosBefore} verts, hasUV=${hasUV}, hasNormals=${hasNormals}\n`);

// -------- Step 2: export to FBX --------
const t1 = performance.now();
const exporter = new FBXExporter();
const fbxBytes = exporter.parseSync(objGroup);
const tExport = performance.now() - t1;

console.log(`Step 2 — FBXExporter.parseSync: ${tExport.toFixed(1)} ms`);
console.log(`  Output size: ${(fbxBytes.byteLength / (1024 * 1024)).toFixed(2)} MB`);

writeFileSync(fbxPath, fbxBytes);
console.log(`  Written to ${fbxPath}\n`);

// -------- Step 3: round-trip via FBXLoader --------
const t2 = performance.now();
const fbxLoader = new FBXLoader();
const reGroup = fbxLoader.parse(
  fbxBytes.buffer.slice(fbxBytes.byteOffset, fbxBytes.byteOffset + fbxBytes.byteLength),
  '',
);
const tImport = performance.now() - t2;

const reMeshes = [];
reGroup.traverse((o) => { if (o.isMesh) reMeshes.push(o); });

console.log(`Step 3 — FBXLoader.parse: ${tImport.toFixed(1)} ms`);
console.log(`  Re-imported meshes: ${reMeshes.length}`);
let totalPosAfter = 0;
for (let i = 0; i < reMeshes.length; i++) {
  const g = reMeshes[i].geometry;
  const pos = g.attributes.position;
  const uv  = g.attributes.uv;
  const nrm = g.attributes.normal;
  totalPosAfter += pos?.count ?? 0;
  console.log(
    `  [${i}] name="${reMeshes[i].name}" verts=${pos?.count ?? 0}` +
    ` uvs=${uv?.count ?? 0}` +
    ` normals=${nrm?.count ?? 0}`,
  );
}
console.log(`  Aggregate: ${totalPosAfter} verts\n`);

// -------- Step 4: structural assertions --------
console.log('Step 4 — assertions:');

let passes = 0, fails = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok  ${label}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${label} :: ${e.message}`); }
}

// 4.1 — Same number of meshes round-trip.
check('mesh count preserved', () => {
  assert.equal(reMeshes.length, meshes.length,
    `mesh count: re=${reMeshes.length} orig=${meshes.length}`);
});

// 4.2 — Aggregate vertex count preserved.
//
// Note: OBJLoader's output is non-indexed (every face gets its 3 vertices
// duplicated), so a typical OBJ mesh has 3 × faceCount unique vertices.
// FBX round-trip via FBXLoader is also non-indexed in the re-import path.
// We require EXACT match.
check('aggregate vertex count preserved', () => {
  assert.equal(totalPosAfter, totalPosBefore,
    `verts: re=${totalPosAfter} orig=${totalPosBefore}`);
});

// 4.3 — UVs preserved (1.obj has 49k UVs, so we must keep them).
check('UVs preserved when source has UVs', () => {
  if (!hasUV) return;
  for (let i = 0; i < reMeshes.length; i++) {
    assert.ok(reMeshes[i].geometry.attributes.uv,
      `mesh[${i}] lost UVs on round-trip`);
  }
});

// 4.4 — Normals were absent in source. We emit them via geometry.computeVertexNormals()
// during export only if user did so before passing to exporter — since we did not,
// the FBX file may or may not have a Normals layer. FBXLoader's behavior: if no
// normals in file, attribute is missing. Just check there's no crash; no assertion
// on normal count.

// 4.5 — Bounding-box stability: compute extents on both sides, compare to <1%.
function bbox(meshArr) {
  const box = new THREE.Box3();
  for (const m of meshArr) {
    m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox);
  }
  return box;
}
const bbBefore = bbox(meshes);
const bbAfter  = bbox(reMeshes);
check('bounding-box min/max preserved within 1e-4', () => {
  for (const ax of ['x', 'y', 'z']) {
    const dMin = Math.abs(bbBefore.min[ax] - bbAfter.min[ax]);
    const dMax = Math.abs(bbBefore.max[ax] - bbAfter.max[ax]);
    assert.ok(dMin < 1e-4, `min.${ax}: orig=${bbBefore.min[ax]} re=${bbAfter.min[ax]}`);
    assert.ok(dMax < 1e-4, `max.${ax}: orig=${bbBefore.max[ax]} re=${bbAfter.max[ax]}`);
  }
});

// 4.6 — Vertices are non-degenerate (no NaN, no Infinity).
check('all re-imported vertices are finite', () => {
  for (const m of reMeshes) {
    const arr = m.geometry.attributes.position.array;
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i])) throw new Error(`non-finite vertex at index ${i}`);
    }
  }
});

console.log(`\n${passes}/${passes + fails} checks passed`);
console.log(`\nTotals: load=${tLoad.toFixed(0)}ms export=${tExport.toFixed(0)}ms reimport=${tImport.toFixed(0)}ms outSize=${(fbxBytes.byteLength/1024/1024).toFixed(2)}MB`);
if (fails > 0) process.exit(1);
