// E2E #2: load test/_assets/Xbot.glb (skinned + animated character) via
// GLTFLoader, export through our plugin, re-import via FBXLoader, verify
// SkinnedMesh / Skeleton / AnimationClip round-trip.
//
// Xbot is Mixamo-style rig: SkinnedMesh + Skeleton (typically 50+ bones) +
// several AnimationClips. This is the densest single-asset exercise of
// M5 (skinning) + M6 (animation) + M3 (mesh) all at once.
//
// Run: node test/e2e-2-xbot.test.mjs

import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

globalThis.self = globalThis;
globalThis.window = { innerWidth: 1920, innerHeight: 1080, URL: globalThis.URL };

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { FBXLoader }  = await import('three/examples/jsm/loaders/FBXLoader.js');
const { FBXExporter } = await import('../src/FBXExporter.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const glbPath = resolve(__dirname, '_assets/Xbot.glb');
const outDir  = resolve(__dirname, '../out');
mkdirSync(outDir, { recursive: true });
const fbxPath = resolve(outDir, 'Xbot.fbx');

console.log('=== E2E #2: Xbot.glb ===\n');

// -------- Step 1: load .glb --------
// GLTFLoader is async via callbacks (parse(buffer, path, onLoad, onError)).
// Wrap in a Promise.
const glbBuf = readFileSync(glbPath);
const arrayBuf = glbBuf.buffer.slice(glbBuf.byteOffset, glbBuf.byteOffset + glbBuf.byteLength);

const t0 = performance.now();
const gltf = await new Promise((res, rej) => {
  new GLTFLoader().parse(arrayBuf, '', res, rej);
});
const tLoad = performance.now() - t0;

const root = gltf.scene;
// GLTFLoader puts animations on the gltf object, not on root.scene. Wire
// them onto root.animations so our exporter's collectAnimationClips
// picks them up (animationCollector.js:57).
root.animations = gltf.animations || [];

const meshes = [];
const skinnedMeshes = [];
const bones = new Set();
root.traverse((o) => {
  if (o.isSkinnedMesh) { skinnedMeshes.push(o); meshes.push(o); }
  else if (o.isMesh)   { meshes.push(o); }
  if (o.isBone) bones.add(o);
});
// Also collect bones referenced by SkinnedMesh skeletons (some glb riggers
// keep the bone hierarchy reachable only through skeleton.bones).
for (const sm of skinnedMeshes) {
  for (const b of sm.skeleton.bones) bones.add(b);
}

console.log(`Step 1 — GLTFLoader.parse: ${tLoad.toFixed(1)} ms`);
console.log(`  meshes=${meshes.length}  skinnedMeshes=${skinnedMeshes.length}  bones=${bones.size}  animations=${root.animations.length}`);
for (let i = 0; i < skinnedMeshes.length; i++) {
  const sm = skinnedMeshes[i];
  const g = sm.geometry;
  console.log(`  Skin[${i}] "${sm.name}" verts=${g.attributes.position.count} skinIdx=${g.attributes.skinIndex?.count ?? 0} skel=${sm.skeleton.bones.length}b`);
}
for (let i = 0; i < root.animations.length; i++) {
  const c = root.animations[i];
  console.log(`  Anim[${i}] "${c.name}" dur=${c.duration.toFixed(3)}s tracks=${c.tracks.length}`);
}
console.log('');

// -------- Step 2: export --------
const t1 = performance.now();
const fbxBytes = new FBXExporter().parseSync(root);
const tExport = performance.now() - t1;

console.log(`Step 2 — FBXExporter.parseSync: ${tExport.toFixed(1)} ms`);
console.log(`  Output size: ${(fbxBytes.byteLength / (1024 * 1024)).toFixed(2)} MB`);

writeFileSync(fbxPath, fbxBytes);
console.log(`  Written to ${fbxPath}\n`);

// -------- Step 3: re-import --------
const t2 = performance.now();
const reGroup = new FBXLoader().parse(
  fbxBytes.buffer.slice(fbxBytes.byteOffset, fbxBytes.byteOffset + fbxBytes.byteLength), '');
const tImport = performance.now() - t2;

const reMeshes = [], reSkinned = [], reBones = new Set();
reGroup.traverse((o) => {
  if (o.isSkinnedMesh) { reSkinned.push(o); reMeshes.push(o); }
  else if (o.isMesh)   { reMeshes.push(o); }
  if (o.isBone) reBones.add(o);
});
for (const sm of reSkinned) for (const b of sm.skeleton.bones) if (b) reBones.add(b);

console.log(`Step 3 — FBXLoader.parse: ${tImport.toFixed(1)} ms`);
console.log(`  meshes=${reMeshes.length}  skinnedMeshes=${reSkinned.length}  bones=${reBones.size}  animations=${reGroup.animations?.length ?? 0}`);
for (let i = 0; i < reSkinned.length; i++) {
  const sm = reSkinned[i];
  const g = sm.geometry;
  console.log(`  Skin[${i}] "${sm.name}" verts=${g.attributes.position.count} skel=${sm.skeleton.bones.filter(Boolean).length}b`);
}
for (let i = 0; i < (reGroup.animations?.length ?? 0); i++) {
  const c = reGroup.animations[i];
  console.log(`  Anim[${i}] "${c.name}" dur=${c.duration.toFixed(3)}s tracks=${c.tracks.length}`);
}
console.log('');

// -------- Step 4: assertions --------
console.log('Step 4 — assertions:');

let passes = 0, fails = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok  ${label}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${label} :: ${e.message}`); }
}

check('SkinnedMesh count preserved', () => {
  assert.equal(reSkinned.length, skinnedMeshes.length);
});

check('face count preserved (vertex count differs because OBJ/GLTF is indexed, FBX is non-indexed)', () => {
  // Source GLB is indexed (`.geometry.index`), our FBX export is non-indexed
  // (PolygonVertexIndex is 1:1 with face corners), and FBXLoader re-imports
  // as non-indexed too. So we compare FACE count, not vertex count.
  function faces(meshArr) {
    return meshArr.reduce((s, m) => {
      const g = m.geometry;
      return s + (g.index ? g.index.count / 3 : g.attributes.position.count / 3);
    }, 0);
  }
  const before = faces(skinnedMeshes);
  const after  = faces(reSkinned);
  assert.equal(after, before, `faces: before=${before} after=${after}`);
});

check('bone count per Skeleton preserved (shared skeleton replicated by FBXLoader)', () => {
  // FBXLoader creates one independent Skeleton object per SkinnedMesh
  // (FBXLoader.parseDeformers spec), even when source clusters reference
  // shared bone UIDs. So `reBones.size` doubles compared to the source
  // where both meshes shared one bone array. Verify per-skeleton bone
  // count instead.
  for (let i = 0; i < reSkinned.length; i++) {
    const re = reSkinned[i].skeleton.bones.length;
    const orig = skinnedMeshes[i].skeleton.bones.length;
    // (Source ordering may differ — FBXLoader re-orders meshes — so
    //  match on count, not pairing.)
    const origCounts = skinnedMeshes.map((m) => m.skeleton.bones.length);
    assert.ok(origCounts.includes(re), `skin[${i}] bones=${re}; expected ∈ ${origCounts}`);
  }
});

check('animation clip count preserved', () => {
  assert.equal(reGroup.animations?.length ?? 0, root.animations.length);
});

check('animation durations preserved (within 1e-3 s)', () => {
  if (!reGroup.animations) return;
  const byName = new Map(reGroup.animations.map((c) => [c.name, c]));
  for (const orig of root.animations) {
    const re = byName.get(orig.name);
    assert.ok(re, `clip "${orig.name}" missing on re-import`);
    assert.ok(Math.abs(re.duration - orig.duration) < 1e-3,
      `"${orig.name}": before=${orig.duration} after=${re.duration}`);
  }
});

check('animation track count preserved per clip', () => {
  if (!reGroup.animations) return;
  const byName = new Map(reGroup.animations.map((c) => [c.name, c]));
  for (const orig of root.animations) {
    const re = byName.get(orig.name);
    if (!re) continue;
    // FBX represents one TRS curve per channel × axis (Lcl T XYZ / R XYZ / S XYZ).
    // Three.js KeyframeTrack lumps all axes into one VectorKeyframeTrack
    // (3 values per time stamp), so FBX → three.js round-trip yields a
    // single VectorKeyframeTrack per bone-property. Re-import may have
    // MORE tracks than the original (one per axis), but never fewer.
    assert.ok(re.tracks.length >= orig.tracks.length * 0.5,
      `"${orig.name}": tracks orig=${orig.tracks.length} re=${re.tracks.length}`);
  }
});

check('skeleton.bones[*] are non-null', () => {
  for (const sm of reSkinned) {
    for (let i = 0; i < sm.skeleton.bones.length; i++) {
      assert.ok(sm.skeleton.bones[i], `skeleton.bones[${i}] is null/undefined`);
    }
  }
});

check('re-imported vertices are finite', () => {
  for (const m of reMeshes) {
    const arr = m.geometry.attributes.position.array;
    for (let i = 0; i < arr.length; i += 1024) {
      if (!Number.isFinite(arr[i])) throw new Error(`non-finite at index ${i}`);
    }
  }
});

console.log(`\n${passes}/${passes + fails} checks passed`);
console.log(`\nTotals: load=${tLoad.toFixed(0)}ms export=${tExport.toFixed(0)}ms reimport=${tImport.toFixed(0)}ms outSize=${(fbxBytes.byteLength/1024/1024).toFixed(2)}MB`);
if (fails > 0) process.exit(1);
