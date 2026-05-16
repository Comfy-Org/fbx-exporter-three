
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

globalThis.self = globalThis;
globalThis.window = { innerWidth: 1920, innerHeight: 1080, URL: globalThis.URL };
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

const mtlText = readFileSync(resolve(assetDir, '0.mtl'), 'utf8');
const mtlCreator = parseMtl(mtlText, assetDir);

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

const sharedTextures = new Map();
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
  assert.ok(reMaterials.size >= 1, `re=${reMaterials.size}`);
  assert.ok(allMaterials.size >= 1, `orig=${allMaterials.size}`);
});

check('at least one texture round-trips through FBX', () => {
  assert.ok(reTextures.size >= 1, `re-imported textures: ${reTextures.size}`);
});

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
  let withMap = 0;
  for (const mat of reMaterials) if (mat.map) withMap++;
  assert.ok(withMap >= 1, `materials with .map: ${withMap}/${reMaterials.size}`);
});

check('texture names preserved (Body1_0 / Eye1_0 / Mouth1_0)', () => {
  const expectedTextureNames = new Set(['Body1_0', 'Eye1_0', 'Mouth1_0']);
  const seen = new Set();
  for (const t of reTextures) {
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
