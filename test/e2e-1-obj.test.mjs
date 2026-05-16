
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

const t0 = performance.now();
const objText = readFileSync(objPath, 'utf8');
const objLoader = new OBJLoader();
const objGroup = objLoader.parse(objText);
const tLoad = performance.now() - t0;

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

const t1 = performance.now();
const exporter = new FBXExporter();
const fbxBytes = exporter.parseSync(objGroup);
const tExport = performance.now() - t1;

console.log(`Step 2 — FBXExporter.parseSync: ${tExport.toFixed(1)} ms`);
console.log(`  Output size: ${(fbxBytes.byteLength / (1024 * 1024)).toFixed(2)} MB`);

writeFileSync(fbxPath, fbxBytes);
console.log(`  Written to ${fbxPath}\n`);

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

console.log('Step 4 — assertions:');

let passes = 0, fails = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok  ${label}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${label} :: ${e.message}`); }
}

check('mesh count preserved', () => {
  assert.equal(reMeshes.length, meshes.length,
    `mesh count: re=${reMeshes.length} orig=${meshes.length}`);
});

check('aggregate vertex count preserved', () => {
  assert.equal(totalPosAfter, totalPosBefore,
    `verts: re=${totalPosAfter} orig=${totalPosBefore}`);
});

check('UVs preserved when source has UVs', () => {
  if (!hasUV) return;
  for (let i = 0; i < reMeshes.length; i++) {
    assert.ok(reMeshes[i].geometry.attributes.uv,
      `mesh[${i}] lost UVs on round-trip`);
  }
});

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
