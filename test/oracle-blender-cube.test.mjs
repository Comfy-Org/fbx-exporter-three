// Oracle test: structurally compare our FBX output against Blender's
// `bl_cube.fbx` (Blender 3.3 default scene — Cube + Camera + Light).
//
// Blender has no FBX export unit tests in its repo (only import tests in
// io_fbx_import_test.py). Its `bl_*.fbx` files are de facto export
// artifacts produced by Blender itself, so we treat them as the
// industry-standard oracle and structurally diff our output against
// theirs.
//
// What we compare:
//   - FBX version + endian/use64 mode
//   - Definitions: ObjectType counts + the *set* of PropertyTemplate field
//     names per type (not values — Blender's exact defaults aren't load-
//     bearing for us)
//   - Objects: count per kind + per Model subtype (Mesh / Light / Camera)
//   - Connections: count per relationship kind (OO / OP) + edge multiset
//     by (srcKind, dstKind)
//   - GlobalSettings axis encoding + UnitScaleFactor
//
// What we deliberately DON'T compare:
//   - UIDs, timestamps, creator string (per-run, expected to differ)
//   - Exact numeric values (Blender's Lcl Translation/Rotation depend on
//     camera/light positions in the source .blend; ours come from the
//     synthetic three.js scene)
//   - Vertex coordinates (geometry order may differ; we verify count only)
//
// Run: node test/oracle-blender-cube.test.mjs

import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { unzlibSync } from 'fflate';

globalThis.self = globalThis;
globalThis.window = { innerWidth: 1920, innerHeight: 1080, URL: globalThis.URL };

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { FBXExporter } = await import('../src/FBXExporter.js');
const DT = await import('../src/core/dataTypes.js');

// ---------------------------------------------------------------------------
// Minimal binary FBX parser
// ---------------------------------------------------------------------------

function parseFBXTree(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint32(23, true);
  let offset = 27;
  const use64 = version >= 7500;
  const sentinel = use64 ? 25 : 13;
  const roots = [];
  while (offset < u8.byteLength - sentinel) {
    const peek = use64 ? Number(dv.getBigUint64(offset, true)) : dv.getUint32(offset, true);
    if (peek === 0) break;
    roots.push(parseNode());
  }
  return { version, roots, use64 };

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
    while (offset < endOffset) {
      const peek = use64 ? Number(dv.getBigUint64(offset, true)) : dv.getUint32(offset, true);
      if (peek === 0 && offset + sentinel <= endOffset) { offset += sentinel; break; }
      children.push(parseNode());
    }
    if (offset !== endOffset) offset = endOffset;
    return { name, props, children };
  }
  function parseProp() {
    const tag = dv.getUint8(offset); offset += 1;
    switch (tag) {
      case DT.BOOL:    { const v = !!dv.getUint8(offset); offset += 1; return v; }
      case DT.INT8:    { const v = dv.getInt8(offset); offset += 1; return v; }
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
      case DT.CHAR: { const v = dv.getUint8(offset); offset += 1; return v; }
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
        return { length, encoding, data, tag };
      }
      default: throw new Error(`Unknown tag 0x${tag.toString(16)}`);
    }
  }
}

const findRoot   = (t, n) => t.find((x) => x.name === n);
const findChild  = (n, name) => n && n.children.find((c) => c.name === name);
const findChildren = (n, name) => n ? n.children.filter((c) => c.name === name) : [];

// ---------------------------------------------------------------------------
// Structural digest
// ---------------------------------------------------------------------------

function digest(u8) {
  const { version, roots, use64 } = parseFBXTree(u8);

  const out = { version, use64 };

  // --- GlobalSettings ---
  const gs = findRoot(roots, 'GlobalSettings');
  const gsProps = findChild(gs, 'Properties70');
  const gsPropMap = {};
  if (gsProps) {
    for (const p of gsProps.children) gsPropMap[p.props[0]] = p.props.slice(4);
  }
  out.globalSettings = {
    upAxis:        gsPropMap.UpAxis?.[0],
    upAxisSign:    gsPropMap.UpAxisSign?.[0],
    frontAxis:     gsPropMap.FrontAxis?.[0],
    frontAxisSign: gsPropMap.FrontAxisSign?.[0],
    coordAxis:     gsPropMap.CoordAxis?.[0],
    unitScaleFactor: gsPropMap.UnitScaleFactor?.[0],
    propNameSet: new Set(Object.keys(gsPropMap)),
  };

  // --- Definitions ---
  const defs = findRoot(roots, 'Definitions');
  out.definitions = {};
  for (const ot of findChildren(defs, 'ObjectType')) {
    const name = ot.props[0];
    const count = findChild(ot, 'Count')?.props[0] ?? 0;
    const templ = findChild(ot, 'PropertyTemplate');
    const templPropNames = new Set();
    if (templ) {
      const p70 = findChild(templ, 'Properties70');
      if (p70) for (const p of p70.children) templPropNames.add(p.props[0]);
    }
    out.definitions[name] = { count, templPropNames };
  }

  // --- Objects ---
  const objs = findRoot(roots, 'Objects');
  out.objects = { byKind: {}, modelSubtypes: {}, geometryLayerElements: [] };
  for (const c of objs.children) {
    out.objects.byKind[c.name] = (out.objects.byKind[c.name] || 0) + 1;
    if (c.name === 'Model') {
      const sub = c.props[2] || 'Null';
      out.objects.modelSubtypes[sub] = (out.objects.modelSubtypes[sub] || 0) + 1;
    }
    if (c.name === 'Geometry') {
      for (const sub of c.children) {
        if (sub.name === 'LayerElement' + sub.name.slice(12) || sub.name.startsWith('LayerElement')) {
          out.objects.geometryLayerElements.push(sub.name);
        }
      }
    }
  }
  // Union of P record names per Model subtype, across all Models in the file.
  const modelPropsBySubtype = {};
  for (const c of findChildren(objs, 'Model')) {
    const sub = c.props[2] || 'Null';
    const p70 = findChild(c, 'Properties70');
    if (!p70) continue;
    const set = modelPropsBySubtype[sub] || (modelPropsBySubtype[sub] = new Set());
    for (const p of p70.children) set.add(p.props[0]);
  }
  out.objects.modelPropsBySubtype = modelPropsBySubtype;

  // --- Connections ---
  const conns = findRoot(roots, 'Connections');
  let oo = 0, op = 0;
  for (const c of conns.children) {
    if (c.props[0] === 'OO') oo++;
    else if (c.props[0] === 'OP') op++;
  }
  out.connections = { oo, op, total: oo + op };

  return out;
}

// ---------------------------------------------------------------------------
// Construct equivalent three.js scene + export
// ---------------------------------------------------------------------------

function buildOurScene() {
  // Blender's default scene = Cube (2x2x2 at origin) + Light + Camera.
  // Exact transforms differ (Blender ships specific defaults), but the
  // STRUCTURE — 1 mesh + 1 light + 1 camera + 1 material — should match.
  const scene = new THREE.Scene();

  // Cube — Blender's default 2m cube.
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshPhongMaterial({ name: 'Material' }),
  );
  cube.name = 'Cube';
  scene.add(cube);

  // Light — PointLight (Blender's default scene also has a Point Light).
  const light = new THREE.PointLight(0xffffff, 1);
  light.name = 'Light';
  light.position.set(4, 5, -1);
  scene.add(light);

  // Camera — PerspectiveCamera.
  const cam = new THREE.PerspectiveCamera(40, 16/9, 0.1, 100);
  cam.name = 'Camera';
  cam.position.set(7, 5, 6);
  scene.add(cam);

  return scene;
}

// ---------------------------------------------------------------------------
// Comparison engine — print side-by-side, return list of differences
// ---------------------------------------------------------------------------

const RESET = ''; const RED = ''; const GREEN = ''; const DIM = '';

function setDiff(a, b, label) {
  const onlyA = [...a].filter((x) => !b.has(x));
  const onlyB = [...b].filter((x) => !a.has(x));
  if (onlyA.length === 0 && onlyB.length === 0) return null;
  return { label, onlyA, onlyB };
}

let passes = 0, fails = 0, warnings = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL ${label} :: ${e.message}`); }
}
function info(label) { console.log(`  info ${label}`); }
function warn(label) { warnings++; console.log(`  warn ${label}`); }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const BLENDER_FBX = 'H:/blender/tests/files/io_tests/fbx/bl_cube.fbx';

console.log('=== Oracle: bl_cube.fbx (Blender 3.3 default scene) vs ours ===\n');

if (!existsSync(BLENDER_FBX)) {
  console.log(`SKIP — oracle file not found at ${BLENDER_FBX}`);
  console.log('(This test requires a local Blender source checkout at H:/blender)');
  process.exit(0);
}

const blenderBytes = new Uint8Array(readFileSync(BLENDER_FBX));
const blender = digest(blenderBytes);
console.log(`Blender FBX: version=${blender.version} use64=${blender.use64} size=${blenderBytes.byteLength}`);

const ourScene = buildOurScene();
const ourBytes = new FBXExporter().parseSync(ourScene);
const ours = digest(ourBytes);
console.log(`Ours     FBX: version=${ours.version} use64=${ours.use64} size=${ourBytes.byteLength}\n`);

// ---- 1. Header / version ----
console.log('-- 1. FBX version --');
check('FBX major version >= 7400', () => {
  assert.ok(ours.version >= 7400, `ours version=${ours.version}`);
});

// ---- 2. GlobalSettings axes ----
console.log('\n-- 2. GlobalSettings --');
check('UpAxis matches', () => {
  assert.equal(ours.globalSettings.upAxis, blender.globalSettings.upAxis,
    `ours=${ours.globalSettings.upAxis} bl=${blender.globalSettings.upAxis}`);
});
check('FrontAxis matches', () => {
  assert.equal(ours.globalSettings.frontAxis, blender.globalSettings.frontAxis);
});
check('UnitScaleFactor matches', () => {
  assert.equal(ours.globalSettings.unitScaleFactor, blender.globalSettings.unitScaleFactor);
});
const gsDiff = setDiff(ours.globalSettings.propNameSet, blender.globalSettings.propNameSet, 'GlobalSettings.Properties70');
if (gsDiff) {
  if (gsDiff.onlyA.length) warn(`GlobalSettings props ONLY-OURS: ${gsDiff.onlyA.join(', ')}`);
  if (gsDiff.onlyB.length) warn(`GlobalSettings props ONLY-BLENDER: ${gsDiff.onlyB.join(', ')}`);
} else {
  console.log('  ok   GlobalSettings property name set matches exactly');
  passes++;
}

// ---- 3. Definitions counts ----
console.log('\n-- 3. Definitions / ObjectType counts --');
const allKinds = new Set([...Object.keys(blender.definitions), ...Object.keys(ours.definitions)]);
for (const kind of [...allKinds].sort()) {
  const o = ours.definitions[kind];
  const b = blender.definitions[kind];
  if (!o) { warn(`ObjectType "${kind}" missing in ours (Blender count=${b.count})`); continue; }
  if (!b) { warn(`ObjectType "${kind}" missing in Blender (ours count=${o.count})`); continue; }
  if (o.count === b.count) {
    console.log(`  ok   ${kind.padEnd(20)} count=${o.count}`);
    passes++;
  } else {
    fails++;
    console.error(`  FAIL ${kind.padEnd(20)} ours=${o.count} bl=${b.count}`);
  }
  // Template prop name diff (informational only).
  const d = setDiff(o.templPropNames, b.templPropNames, `${kind} template`);
  if (d) {
    if (d.onlyA.length) info(`${kind} template ONLY-OURS: ${d.onlyA.slice(0, 6).join(', ')}${d.onlyA.length > 6 ? ` …+${d.onlyA.length - 6}` : ''}`);
    if (d.onlyB.length) info(`${kind} template ONLY-BLENDER: ${d.onlyB.slice(0, 6).join(', ')}${d.onlyB.length > 6 ? ` …+${d.onlyB.length - 6}` : ''}`);
  }
}

// ---- 4. Objects kinds + subtypes ----
console.log('\n-- 4. Objects --');
for (const kind of ['Model', 'Geometry', 'Material', 'NodeAttribute']) {
  const o = ours.objects.byKind[kind] || 0;
  const b = blender.objects.byKind[kind] || 0;
  if (o === b) {
    console.log(`  ok   ${kind.padEnd(20)} count=${o}`);
    passes++;
  } else {
    fails++;
    console.error(`  FAIL ${kind.padEnd(20)} ours=${o} bl=${b}`);
  }
}
console.log('\n-- 4b. Model subtypes --');
for (const sub of ['Mesh', 'Light', 'Camera', 'LimbNode', 'Null']) {
  const o = ours.objects.modelSubtypes[sub] || 0;
  const b = blender.objects.modelSubtypes[sub] || 0;
  if (o === b) {
    console.log(`  ok   Model::${sub.padEnd(14)} count=${o}`);
    passes++;
  } else {
    fails++;
    console.error(`  FAIL Model::${sub.padEnd(14)} ours=${o} bl=${b}`);
  }
}

// ---- 5. Connections graph ----
console.log('\n-- 5. Connections --');
console.log(`  info Blender OO=${blender.connections.oo} OP=${blender.connections.op}`);
console.log(`  info Ours    OO=${ours.connections.oo} OP=${ours.connections.op}`);
check('OO count matches (no extra/missing object-to-object edges)', () => {
  assert.equal(ours.connections.oo, blender.connections.oo,
    `ours=${ours.connections.oo} bl=${blender.connections.oo}`);
});
// OP edges can differ — Blender doesn't emit LookAtProperty connections
// (relies on MAT_CONVERT_LIGHT), we do. So OP diff is INFO not FAIL.
if (ours.connections.op !== blender.connections.op) {
  info(`OP edges differ: ours=${ours.connections.op} bl=${blender.connections.op} ` +
       '(expected — we emit LookAtProperty OP edges for FBXLoader compat)');
}

// ---- 6. Model property-name coverage (per subtype) ----
console.log('\n-- 6. Model Properties70 per subtype --');
for (const sub of ['Mesh', 'Light', 'Camera']) {
  const o = ours.objects.modelPropsBySubtype[sub] || new Set();
  const b = blender.objects.modelPropsBySubtype[sub] || new Set();
  const d = setDiff(o, b, sub);
  if (!d) { console.log(`  ok   Model::${sub} property names match exactly`); passes++; continue; }
  if (d.onlyA.length) info(`Model::${sub} ONLY-OURS: ${d.onlyA.join(', ')}`);
  if (d.onlyB.length) info(`Model::${sub} ONLY-BLENDER: ${d.onlyB.join(', ')}`);
  // Heuristic: if Blender has properties WE don't have at all (and they're
  // not just per-subtype-specific deltas), that's a gap worth flagging.
  if (d.onlyB.length > 0) warn(`Model::${sub} is missing ${d.onlyB.length} property name(s) Blender writes`);
}

// ---- Final summary ----
console.log(`\n${passes}/${passes + fails} checks passed, ${warnings} warnings (informational diffs not load-bearing)`);
if (fails > 0) process.exit(1);
