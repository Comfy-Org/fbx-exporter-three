
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
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

const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { FBXLoader }  = await import('three/examples/jsm/loaders/FBXLoader.js');
const { FBXExporter } = await import('../src/FBXExporter.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../out');
mkdirSync(outDir, { recursive: true });

const MODELS_ROOT = 'H:/three.js/examples/models/gltf';

const TARGETS = [
  { file: 'Horse.glb',     label: 'Horse',    expects: { morph: true,   animations: 1 } },
  { file: 'Soldier.glb',   label: 'Soldier',  expects: { skinned: true, animations: 3 } },
  { file: 'Flamingo.glb',  label: 'Flamingo', expects: { morph: true,   animations: 1 } },
  { file: 'BoomBox.glb',   label: 'BoomBox',  expects: { textured: true } },
  { file: 'Michelle.glb',  label: 'Michelle', expects: { skinned: true, animations: 1 } },
  { file: 'Parrot.glb',    label: 'Parrot',   expects: { morph: true,   animations: 1 } },
  { file: 'Stork.glb',     label: 'Stork',    expects: { morph: true,   animations: 1 } },
];

async function runOne(target) {
  const glbPath = resolve(MODELS_ROOT, target.file);
  if (!existsSync(glbPath)) {
    return { label: target.label, status: 'SKIP', note: `missing ${glbPath}` };
  }
  const inSize = statSync(glbPath).size;

  const buf = readFileSync(glbPath);
  const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const t0 = performance.now();
  let gltf;
  try {
    gltf = await new Promise((res, rej) =>
      new GLTFLoader().parse(arrayBuf, '', res, rej));
  } catch (e) {
    return { label: target.label, status: 'LOAD-FAIL', note: e.message };
  }
  const tLoad = performance.now() - t0;

  const root = gltf.scene;
  root.animations = gltf.animations || [];

  let meshCount = 0, skinnedCount = 0, vertCount = 0, faceCount = 0;
  const bones = new Set();
  let hasMorph = false, texCount = 0;
  const texSet = new Set();
  root.traverse((o) => {
    if (o.isMesh) {
      meshCount++;
      if (o.isSkinnedMesh) skinnedCount++;
      const g = o.geometry;
      vertCount += g.attributes.position.count;
      faceCount += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      if (g.morphAttributes && g.morphAttributes.position && g.morphAttributes.position.length > 0) hasMorph = true;
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
          if (m[slot] && !texSet.has(m[slot])) { texSet.add(m[slot]); texCount++; }
        }
      }
    }
    if (o.isBone) bones.add(o);
  });

  const exporter = new FBXExporter();
  const t1 = performance.now();
  let fbxBytes;
  try {
    fbxBytes = exporter.parseSync(root);
  } catch (e) {
    return {
      label: target.label, status: 'EXPORT-FAIL', note: e.message,
      tLoad: tLoad.toFixed(0), inMeshes: meshCount, inBones: bones.size,
      inVerts: vertCount, inFaces: faceCount,
    };
  }
  const tExport = performance.now() - t1;
  const fbxPath = resolve(outDir, `${target.label}.fbx`);
  writeFileSync(fbxPath, fbxBytes);

  const t2 = performance.now();
  let reGroup;
  try {
    reGroup = new FBXLoader().parse(
      fbxBytes.buffer.slice(fbxBytes.byteOffset, fbxBytes.byteOffset + fbxBytes.byteLength), '');
  } catch (e) {
    return {
      label: target.label, status: 'IMPORT-FAIL', note: e.message,
      tLoad: tLoad.toFixed(0), tExport: tExport.toFixed(0),
      inMeshes: meshCount, inBones: bones.size, inVerts: vertCount,
      inFaces: faceCount, outSize: fbxBytes.byteLength,
    };
  }
  const tImport = performance.now() - t2;

  let reMeshCount = 0, reSkinnedCount = 0, reFaceCount = 0;
  let reHasMorph = false;
  const reBones = new Set();
  const reClips = reGroup.animations || [];
  reGroup.traverse((o) => {
    if (o.isMesh) {
      reMeshCount++;
      if (o.isSkinnedMesh) reSkinnedCount++;
      const g = o.geometry;
      reFaceCount += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      if (g.morphAttributes && g.morphAttributes.position && g.morphAttributes.position.length > 0) reHasMorph = true;
    }
    if (o.isBone) reBones.add(o);
  });

  const checks = [];
  function check(label, fn) {
    try { fn(); checks.push({ label, ok: true }); }
    catch (e) { checks.push({ label, ok: false, msg: e.message }); }
  }

  check('mesh count > 0', () => assert.ok(reMeshCount > 0));
  check('face count preserved', () =>
    assert.equal(reFaceCount, faceCount, `orig=${faceCount} re=${reFaceCount}`));
  if (target.expects.skinned) {
    check('skinned mesh preserved', () => assert.ok(reSkinnedCount >= 1));
    check('at least one bone after round-trip', () => assert.ok(reBones.size >= 1));
  }
  if (target.expects.animations) {
    check(`animations count >= ${target.expects.animations}`, () =>
      assert.ok(reClips.length >= target.expects.animations,
        `orig=${root.animations.length} re=${reClips.length} expected ≥${target.expects.animations}`));
  }
  if (target.expects.morph) {
    check('morph attributes preserved', () =>
      assert.ok(reHasMorph, `morphs lost on round-trip (orig had morph: ${hasMorph})`));
  }
  if (target.expects.multiMesh) {
    check('multi-mesh count >= 5', () => assert.ok(reMeshCount >= 5));
  }
  check('FBX magic bytes', () => {
    const sig = String.fromCharCode(...fbxBytes.slice(0, 21));
    assert.ok(sig.startsWith('Kaydara FBX Binary'), `got: "${sig}"`);
  });

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok);

  return {
    label: target.label,
    status: failed.length === 0 ? 'OK' : 'PARTIAL',
    inSize: (inSize / 1024).toFixed(0) + ' KB',
    outSize: (fbxBytes.byteLength / 1024).toFixed(0) + ' KB',
    inMeshes: meshCount,
    inBones: bones.size,
    inFaces: faceCount,
    inAnims: root.animations.length,
    inTex: texCount,
    inMorph: hasMorph ? 'Y' : '-',
    reMeshes: reMeshCount,
    reBones: reBones.size,
    reFaces: reFaceCount,
    reAnims: reClips.length,
    reMorph: reHasMorph ? 'Y' : '-',
    tLoad: tLoad.toFixed(0),
    tExport: tExport.toFixed(0),
    tImport: tImport.toFixed(0),
    checks: `${passed}/${checks.length}`,
    fails: failed.map((f) => `${f.label}: ${f.msg}`).join('; '),
  };
}

console.log('=== E2E #4: round-trip on three.js example models ===\n');

const rows = [];
for (const target of TARGETS) {
  process.stdout.write(`-> ${target.label} ... `);
  const row = await runOne(target);
  rows.push(row);
  console.log(`${row.status}${row.note ? ` (${row.note})` : ''}`);
}

console.log('\n--- Summary ---');
const cols = [
  ['Model',    'label',    14],
  ['Status',   'status',   9],
  ['Faces in', 'inFaces',  9],
  ['out',      'reFaces',  9],
  ['Bones in', 'inBones',  9],
  ['out',      'reBones',  9],
  ['Anims',    'inAnims',  6],
  ['out',      'reAnims',  6],
  ['Morph',    'inMorph',  6],
  ['Tex',      'inTex',    5],
  ['In',       'inSize',   10],
  ['FBX',      'outSize',  10],
  ['ld/ex/im', null,        14],
  ['Checks',   'checks',   8],
];
console.log(cols.map(([h, , w]) => h.padEnd(w)).join(''));
console.log(cols.map(([, , w]) => '-'.repeat(w - 1) + ' ').join(''));
for (const row of rows) {
  const cells = cols.map(([, k, w]) => {
    if (k) return String(row[k] ?? '').padEnd(w);
    return `${row.tLoad ?? '-'}/${row.tExport ?? '-'}/${row.tImport ?? '-'}ms`.padEnd(w);
  });
  console.log(cells.join(''));
  if (row.fails) console.log(`    !! ${row.fails}`);
}

const totalOk     = rows.filter((r) => r.status === 'OK').length;
const totalSkip   = rows.filter((r) => r.status === 'SKIP').length;
const totalFail   = rows.filter((r) => !['OK', 'SKIP'].includes(r.status)).length;
console.log(`\n${totalOk}/${rows.length} fully passed, ${totalSkip} skipped, ${totalFail} failed`);
if (totalFail > 0) process.exit(1);
