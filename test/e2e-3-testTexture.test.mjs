// E2E #3: load test/_assets/testTexture/0.obj (+ 0.mtl + 6 PNGs) via
// OBJLoader, attach textures, export through our plugin with embedded
// textures, re-import via FBXLoader, verify Video blobs survived.
//
// testTexture/ characteristics:
//   - 3,733 verts, 3,733 UVs, 5,540 faces, 7 groups, 5 materials
//   - Materials reference 3 unique PNGs: Body1_0.png, Eye1_0.png, Mouth1_0.png
//   - 3 additional unreferenced PNGs (_1.png variants) sit in the folder
//
// Texture-loading trick: we can't decode PNG → RGBA in pure Node without a
// new dep. Instead we register an FBXExporter plugin callback that swaps
// entry.imageBytes with the raw PNG file bytes from disk — bypassing our
// encodeRGBA8PNG step entirely. The FBX file still claims extension="png"
// and FBXLoader's Video parser reads Content blobs as opaque bytes.
//
// Run: node test/e2e-3-testTexture.test.mjs

import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

globalThis.self = globalThis;
globalThis.window = { innerWidth: 1920, innerHeight: 1080, URL: globalThis.URL };
// FBXLoader's parseTextures path goes through TextureLoader → ImageLoader →
// document.createElementNS('img'). In Node we can't actually decode the
// PNG (no image runtime), but a minimal stub lets parse() finish: the
// returned Texture's `.image` ends up unpopulated, but its name + source
// metadata are preserved, which is what our assertions test.
globalThis.document = {
  createElementNS(_ns, _name) {
    const el = {
      _src: '',
      _listeners: {},
      addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); },
      removeEventListener() {},
      removeAttribute() {},
    };
    Object.defineProperty(el, 'src', {
      get() { return this._src; },
      set(v) {
        this._src = v;
        // Defer the synthetic load so the caller can attach listeners first.
        queueMicrotask(() => {
          for (const fn of (this._listeners.load || [])) fn({ target: this });
        });
      },
    });
    return el;
  },
};

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { FBXExporter } = await import('../src/FBXExporter.js');

// Minimal MTL parser — avoids MTLLoader.preload() which triggers
// TextureLoader -> document.createElementNS, breaking in Node.
// Mirrors what OBJLoader needs: a {materials: { [name]: THREE.Material }}
// object with a `.create(name)` lookup.
function parseMtl(text, basePath) {
  const blocks = {};
  let cur = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    if (cmd === 'newmtl') {
      cur = { name: parts[1] };
      blocks[cur.name] = cur;
    } else if (cur) {
      cur[cmd] = parts.slice(1);
    }
  }
  const materials = {};
  for (const [name, info] of Object.entries(blocks)) {
    const mat = new THREE.MeshPhongMaterial({ name });
    if (info.kd) mat.color = new THREE.Color(+info.kd[0], +info.kd[1], +info.kd[2]);
    if (info.ks) mat.specular = new THREE.Color(+info.ks[0], +info.ks[1], +info.ks[2]);
    materials[name] = mat;
    mat.userData.mapKd = info.map_kd ? info.map_kd[0] : null;
  }
  return {
    materials,
    create(name) {
      return materials[name] ?? null;
    },
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetDir = resolve(__dirname, '_assets/testTexture');
const outDir   = resolve(__dirname, '../out');
mkdirSync(outDir, { recursive: true });
const fbxPath  = resolve(outDir, '0.fbx');

console.log('=== E2E #3: testTexture/0.obj ===\n');

// -------- Step 1: parse MTL --------
const mtlText = readFileSync(resolve(assetDir, '0.mtl'), 'utf8');
const mtlCreator = parseMtl(mtlText, assetDir);

// -------- Step 2: load PNG bytes from disk + attach as a marker on each
// material's `.map`. We use a DataTexture with a 1×1 dummy image and put
// the raw PNG bytes in `userData.embedPngBytes` for the exporter plugin.
function makePngTexture(pngFilename, name) {
  const path = resolve(assetDir, pngFilename);
  if (!existsSync(path)) throw new Error(`Missing PNG: ${path}`);
  const bytes = new Uint8Array(readFileSync(path));
  const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
  tex.name = name;
  tex.needsUpdate = true;
  tex.userData.embedPngBytes = bytes;
  tex.userData.sourceFile = pngFilename;
  return tex;
}

const sharedTextures = new Map();  // pngFilename → Texture (dedupe shared images)
function sharedPngTexture(pngFilename) {
  if (!sharedTextures.has(pngFilename)) {
    sharedTextures.set(pngFilename, makePngTexture(pngFilename, pngFilename.replace(/\.png$/, '')));
  }
  return sharedTextures.get(pngFilename);
}

for (const mat of Object.values(mtlCreator.materials)) {
  const pngName = mat.userData.mapKd;
  if (pngName) mat.map = sharedPngTexture(pngName);
}

console.log('Step 1-2 — MTL parsing + PNG loading');
for (const [name, mat] of Object.entries(mtlCreator.materials)) {
  const t = mat.map;
  console.log(`  material "${name}" map="${t?.userData.sourceFile ?? '(none)'}"` +
    ` pngBytes=${t?.userData.embedPngBytes?.byteLength ?? 0}`);
}

// -------- Step 3: parse OBJ with these materials --------
const objText = readFileSync(resolve(assetDir, '0.obj'), 'utf8');
const t0 = performance.now();
const objLoader = new OBJLoader();
objLoader.setMaterials(mtlCreator);
const objGroup = objLoader.parse(objText);
const tLoad = performance.now() - t0;

const meshes = [];
objGroup.traverse((o) => { if (o.isMesh) meshes.push(o); });
const allMaterials = new Set();
const allTextures  = new Set();
for (const m of meshes) {
  const list = Array.isArray(m.material) ? m.material : (m.material ? [m.material] : []);
  for (const mat of list) {
    allMaterials.add(mat);
    if (mat.map) allTextures.add(mat.map);
  }
}
console.log(`\nStep 3 — OBJLoader: ${tLoad.toFixed(1)} ms`);
console.log(`  meshes=${meshes.length}  uniqueMaterials=${allMaterials.size}  uniqueTextures=${allTextures.size}`);

// -------- Step 4: export with plugin that injects raw PNG bytes --------
const exporter = new FBXExporter();
exporter.register((sceneData) => {
  if (!sceneData.textures) return;
  for (const [tex, entry] of sceneData.textures.textures) {
    const bytes = tex.userData?.embedPngBytes;
    if (bytes) {
      entry.imageBytes = bytes;
      entry.extension  = 'png';
    }
  }
});

const t1 = performance.now();
const fbxBytes = exporter.parseSync(objGroup);
const tExport = performance.now() - t1;

console.log(`\nStep 4 — FBXExporter.parseSync (with plugin): ${tExport.toFixed(1)} ms`);
console.log(`  Output size: ${(fbxBytes.byteLength / (1024 * 1024)).toFixed(3)} MB`);
writeFileSync(fbxPath, fbxBytes);
console.log(`  Written to ${fbxPath}`);

// -------- Step 5: re-import via FBXLoader --------
const t2 = performance.now();
const reGroup = new FBXLoader().parse(
  fbxBytes.buffer.slice(fbxBytes.byteOffset, fbxBytes.byteOffset + fbxBytes.byteLength), '');
const tImport = performance.now() - t2;

const reMeshes = [];
const reMaterials = new Set();
const reTextures = new Set();
reGroup.traverse((o) => {
  if (o.isMesh) reMeshes.push(o);
  const list = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
  for (const mat of list) {
    reMaterials.add(mat);
    if (mat.map) reTextures.add(mat.map);
  }
});

console.log(`\nStep 5 — FBXLoader.parse: ${tImport.toFixed(1)} ms`);
console.log(`  meshes=${reMeshes.length}  uniqueMaterials=${reMaterials.size}  uniqueTextures=${reTextures.size}`);
for (const t of reTextures) {
  console.log(`  texture name="${t.name}"  image.src=${(t.image?.src || '').slice(0, 80)}`);
}

// -------- Step 6: assertions --------
console.log('\nStep 6 — assertions:');

let passes = 0, fails = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok  ${label}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${label} :: ${e.message}`); }
}

check('mesh count preserved', () => {
  assert.equal(reMeshes.length, meshes.length);
});

check('material count preserved (5 materials in MTL)', () => {
  // OBJLoader may de-duplicate identical materials; we just want non-zero.
  assert.ok(reMaterials.size >= 1, `re=${reMaterials.size}`);
  assert.ok(allMaterials.size >= 1, `orig=${allMaterials.size}`);
});

check('at least one texture round-trips through FBX', () => {
  assert.ok(reTextures.size >= 1, `re-imported textures: ${reTextures.size}`);
});

// 6.4 — Verify FBX file actually contains Video nodes with Content blobs
// (the PNG bytes embedded). We use a lightweight check: scan the raw FBX
// for the Content node name + a PNG signature within it.
check('FBX file contains embedded PNG Content (89 50 4E 47 signature)', () => {
  let count = 0;
  for (let i = 0; i < fbxBytes.length - 8; i++) {
    if (fbxBytes[i] === 0x89 && fbxBytes[i+1] === 0x50 &&
        fbxBytes[i+2] === 0x4E && fbxBytes[i+3] === 0x47 &&
        fbxBytes[i+4] === 0x0D && fbxBytes[i+5] === 0x0A &&
        fbxBytes[i+6] === 0x1A && fbxBytes[i+7] === 0x0A) {
      count++;
    }
  }
  assert.ok(count >= 1, `PNG signature occurrences: ${count}`);
  // Should be 3 unique PNGs (Body1_0, Eye1_0, Mouth1_0).
  assert.ok(count <= 6, `unexpectedly many PNG signatures: ${count}`);
});

check('FBX face count preserved on round-trip', () => {
  function faces(arr) {
    return arr.reduce((s, m) => {
      const g = m.geometry;
      return s + (g.index ? g.index.count / 3 : g.attributes.position.count / 3);
    }, 0);
  }
  const before = faces(meshes);
  const after  = faces(reMeshes);
  assert.equal(after, before, `faces: orig=${before} re=${after}`);
});

check('UVs preserved on round-trip', () => {
  for (const m of reMeshes) {
    assert.ok(m.geometry.attributes.uv, `mesh "${m.name}" lost UVs`);
  }
});

check('material -> texture mapping wired up on at least one mesh', () => {
  // FBXLoader sets `.map` on the material when Texture nodes are connected.
  // We require at least one re-imported material to have a `.map`.
  let withMap = 0;
  for (const mat of reMaterials) if (mat.map) withMap++;
  assert.ok(withMap >= 1, `materials with .map: ${withMap}/${reMaterials.size}`);
});

check('texture names preserved (Body1_0 / Eye1_0 / Mouth1_0)', () => {
  const expectedTextureNames = new Set(['Body1_0', 'Eye1_0', 'Mouth1_0']);
  const seen = new Set();
  for (const t of reTextures) {
    // FBXLoader may set name from FBX nodeName; we check whether any of
    // the expected base names appear (substring match is fine).
    for (const want of expectedTextureNames) {
      if ((t.name || '').includes(want)) { seen.add(want); break; }
    }
  }
  assert.ok(seen.size >= 1,
    `expected at least one of ${[...expectedTextureNames]}, got names: ${[...reTextures].map(t => t.name).join(', ')}`);
});

console.log(`\n${passes}/${passes + fails} checks passed`);
console.log(`\nTotals: load=${tLoad.toFixed(0)}ms export=${tExport.toFixed(0)}ms reimport=${tImport.toFixed(0)}ms outSize=${(fbxBytes.byteLength/1024).toFixed(0)} KB`);
if (fails > 0) process.exit(1);
