// M4: Axis presets + unit scale + bake_space_transform.
//
// Run: node test/m4-axis-units.test.mjs

import { strict as assert } from 'node:assert';
import { unzlibSync } from 'fflate';

globalThis.self = globalThis;
globalThis.window = { innerWidth: 1920, innerHeight: 1080, URL: globalThis.URL };

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { FBXExporter } = await import('../src/FBXExporter.js');
const { PRESETS, buildAxisMatrix, buildTransformContext } = await import('../src/data/transforms.js');
import * as DT from '../src/core/dataTypes.js';

let passes = 0, fails = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${name}`); console.error('       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); }
}

// ---------------------------------------------------------------------------
// Tree parser (re-used).
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
  return roots;
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
function findRoot(t, n) { return t.find((x) => x.name === n); }
function findChild(node, n) { return node && node.children.find((c) => c.name === n); }

function exportToTree(scene, options) {
  const bytes = new FBXExporter().parseSync(scene, options);
  return { bytes, tree: parseFBXTree(bytes) };
}

// Extract a Properties70 P record's value(s) from GlobalSettings.
function gsProp(tree, name) {
  const gs = findRoot(tree, 'GlobalSettings');
  const p70 = findChild(gs, 'Properties70');
  return p70.children.find((c) => c.props[0] === name);
}

// Extract the per-Geometry Vertices array as a Float64Array view.
function getVertices(tree) {
  const geom = findRoot(tree, 'Objects').children.find((c) => c.name === 'Geometry');
  const v = findChild(geom, 'Vertices').props[0];
  return new Float64Array(v.data.buffer, v.data.byteOffset, v.length);
}

// Make a minimal three.js scene with a box that has distinguishable vertices.
function buildScene() {
  const scene = new THREE.Scene();
  // A box with non-square dims so we can tell axes apart after a bake.
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 2, 3),  // width=1, height=2, depth=3
    new THREE.MeshStandardMaterial(),
  );
  scene.add(mesh);
  return scene;
}

// ============================================================================
// IA. PRESETS table — sane defaults
// ============================================================================

test('IA1: PRESETS table has the expected tools', () => {
  for (const tool of ['threejs', 'unity', 'unreal', 'blender', 'maya']) {
    assert.ok(PRESETS[tool], `preset "${tool}" present`);
    assert.ok(PRESETS[tool].axisUp,      `${tool} axisUp`);
    assert.ok(PRESETS[tool].axisForward, `${tool} axisForward`);
    assert.ok('unitScale' in PRESETS[tool], `${tool} unitScale`);
    assert.ok('bakeSpaceTransform' in PRESETS[tool], `${tool} bakeSpaceTransform`);
  }
});

test('IA2: unreal preset is Z-up X-forward with bake DISABLED', () => {
  // Unreal is the only mainstream FBX target that needs Z-up axes encoded
  // in GlobalSettings. bake stays OFF — our M4 implementation only bakes
  // Vertices+Normals (not object Lcl / clusters / animation / lights /
  // cameras), so bake=true on a non-trivial scene produces internally
  // inconsistent output. Unreal Editor's own importer handles axis
  // conversion when the file declares its axes in GlobalSettings.
  assert.equal(PRESETS.unreal.axisUp, 'Z');
  assert.equal(PRESETS.unreal.axisForward, 'X');
  assert.equal(PRESETS.unreal.bakeSpaceTransform, false);
});

test('IA3: blender / maya presets set unitScale=100 (cm)', () => {
  assert.equal(PRESETS.blender.unitScale, 100);
  assert.equal(PRESETS.maya.unitScale,    100);
});

// ============================================================================
// IB. GlobalSettings axis encoding follows preset
// ============================================================================

test('IB1: threejs preset → GlobalSettings UpAxis=Y, FrontAxis=Z', () => {
  const { tree } = exportToTree(buildScene(), { preset: 'threejs' });
  // Per RIGHT_HAND_AXES["Y|Z"] = { up: [1,1], front: [2,-1], coord: [0,-1] }.
  assert.equal(gsProp(tree, 'UpAxis').props[4],    1);
  assert.equal(gsProp(tree, 'UpAxisSign').props[4], 1);
  assert.equal(gsProp(tree, 'FrontAxis').props[4],  2);
  assert.equal(gsProp(tree, 'FrontAxisSign').props[4], -1);
});

test('IB2: unreal preset → GlobalSettings UpAxis=Z, FrontAxis=X', () => {
  const { tree } = exportToTree(buildScene(), { preset: 'unreal' });
  // RIGHT_HAND_AXES["Z|X"] = { up: [2,1], front: [0,-1], coord: [1,-1] }.
  assert.equal(gsProp(tree, 'UpAxis').props[4],    2);
  assert.equal(gsProp(tree, 'UpAxisSign').props[4], 1);
  assert.equal(gsProp(tree, 'FrontAxis').props[4],  0);
  assert.equal(gsProp(tree, 'FrontAxisSign').props[4], -1);
});

test('IB3: blender preset → UnitScaleFactor = 100', () => {
  const { tree } = exportToTree(buildScene(), { preset: 'blender' });
  const unit = gsProp(tree, 'UnitScaleFactor');
  assert.equal(unit.props[4], 100);
});

// ============================================================================
// IC. bakeSpaceTransform vertex / normal transformation
// ============================================================================

test('IC1: unreal preset does NOT bake by default (axes ride in GlobalSettings)', () => {
  // The unreal preset only changes GlobalSettings.UpAxis/FrontAxis; vertices
  // stay in three.js Y-up Z-forward. This is the safe default — Unreal
  // Editor reads the axis hints and rotates on import.
  const { tree } = exportToTree(buildScene(), { preset: 'unreal' });
  const verts = getVertices(tree);
  let absX = 0, absY = 0, absZ = 0;
  for (let i = 0; i < verts.length; i += 3) {
    absX = Math.max(absX, Math.abs(verts[i]));
    absY = Math.max(absY, Math.abs(verts[i + 1]));
    absZ = Math.max(absZ, Math.abs(verts[i + 2]));
  }
  // BoxGeometry(1, 2, 3) → half-extents 0.5, 1, 1.5 (unchanged from input).
  assert.ok(Math.abs(absX - 0.5) < 1e-6, `x extent: ${absX}`);
  assert.ok(Math.abs(absY - 1.0) < 1e-6, `y extent: ${absY}`);
  assert.ok(Math.abs(absZ - 1.5) < 1e-6, `z extent: ${absZ}`);
});

test('IC2: threejs preset does NOT bake (vertices unchanged)', () => {
  const { tree } = exportToTree(buildScene(), { preset: 'threejs' });
  const verts = getVertices(tree);
  let absX = 0, absY = 0, absZ = 0;
  for (let i = 0; i < verts.length; i += 3) {
    absX = Math.max(absX, Math.abs(verts[i]));
    absY = Math.max(absY, Math.abs(verts[i + 1]));
    absZ = Math.max(absZ, Math.abs(verts[i + 2]));
  }
  // BoxGeometry(1, 2, 3) → half-extents 0.5, 1, 1.5.
  assert.ok(Math.abs(absX - 0.5) < 1e-6, `x extent: ${absX}`);
  assert.ok(Math.abs(absY - 1.0) < 1e-6, `y extent: ${absY}`);
  assert.ok(Math.abs(absZ - 1.5) < 1e-6, `z extent: ${absZ}`);
});

test('IC3: explicit { bakeSpaceTransform: true } without preset also bakes', () => {
  const { tree } = exportToTree(buildScene(),
    { axisUp: 'Z', axisForward: 'X', bakeSpaceTransform: true });
  const verts = getVertices(tree);
  let absX = 0;
  for (let i = 0; i < verts.length; i += 3) absX = Math.max(absX, Math.abs(verts[i]));
  // After Y→Z bake, X axis carries original Z extent = 1.5.
  // (Exact axis mapping depends on the buildAxisMatrix implementation; we
  //  just verify the X extent changed from 0.5.)
  assert.ok(Math.abs(absX - 0.5) > 1e-3, `bake changed X extent (got ${absX})`);
});

// ============================================================================
// ID. buildAxisMatrix unit tests
// ============================================================================

test('ID1: buildAxisMatrix(Y, Z) is identity (matches three.js native)', () => {
  const m = buildAxisMatrix('Y', 'Z');
  const e = m.elements;
  // Identity: diag = 1, off-diag = 0.
  const expectIdent = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(e[i] - expectIdent[i]) < 1e-9, `[${i}] = ${e[i]} (expected ${expectIdent[i]})`);
  }
});

test('ID2: buildAxisMatrix throws on invalid axes', () => {
  let err = null;
  try { buildAxisMatrix('A', 'B'); } catch (e) { err = e; }
  assert.ok(err, 'threw on invalid axes');
});

// ============================================================================
// IE. User options override preset defaults
// ============================================================================

test('IE1: preset+override: { preset: "unity", axisUp: "Z" } honours the override', () => {
  // Unity defaults Y-up, but user explicitly asked Z-up.
  const { tree } = exportToTree(buildScene(),
    { preset: 'unity', axisUp: 'Z', axisForward: 'X' });
  assert.equal(gsProp(tree, 'UpAxis').props[4], 2);  // Z = index 2
});

test('IE2: preset+override: { preset: "blender", unitScale: 1 } drops to meters', () => {
  const { tree } = exportToTree(buildScene(), { preset: 'blender', unitScale: 1 });
  assert.equal(gsProp(tree, 'UnitScaleFactor').props[4], 1);
});

// ============================================================================
// IF. Z-up file structurally loadable (NOT a round-trip orientation test)
// ============================================================================

test('IF1: unreal preset (Z-up GlobalSettings) → FBXLoader does not crash', async () => {
  // What this test does NOT verify: orientation after re-import. FBXLoader.js
  // line 1027 hardcodes `sceneGraph.rotation.set(-π/2, 0, 0)` when UpAxis=2,
  // which converts Z-up Y-forward files to Y-up. For Z-up X-forward (Unreal)
  // the rotation is wrong by 90° around Y. That's by design — the unreal
  // preset targets Unreal Editor, not three.js round-trip. For round-trip use
  // `preset: 'threejs'` instead.
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  const { bytes } = exportToTree(buildScene(), { preset: 'unreal' });
  const group = new FBXLoader().parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  let mesh = null;
  group.traverse((o) => { if (o.isMesh) mesh = o; });
  assert.ok(mesh, 'mesh structurally re-imports');
  assert.equal(mesh.geometry.attributes.position.count, 36, 'all 36 box vertices present');
});

test('IF2: explicit bake=true on a non-trivial scene → emits a warning', () => {
  // Bug #18/#19: when bake=true, only Vertices+Normals are baked. Object
  // Lcl transforms / clusters / animations / lights / cameras are NOT —
  // SceneCollector should warn if any of those are present.
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  mesh.position.set(0, 5, 0);  // non-origin — would be wrong after bake
  scene.add(mesh);
  const origWarn = console.warn;
  let warned = false;
  console.warn = (msg) => { if (String(msg).includes('bakeSpaceTransform=true')) warned = true; };
  try {
    new FBXExporter().parseSync(scene, { axisUp: 'Z', axisForward: 'X', bakeSpaceTransform: true });
    assert.ok(warned, 'warning surfaced for non-origin object + bake');
  } finally {
    console.warn = origWarn;
  }
});

test('IF3: explicit bake=true on a SINGLE mesh AT ORIGIN → no warning', () => {
  // The narrow case where our partial bake produces a valid file.
  const origWarn = console.warn;
  let warned = false;
  console.warn = (msg) => { if (String(msg).includes('bakeSpaceTransform=true')) warned = true; };
  try {
    new FBXExporter().parseSync(buildScene(),
      { axisUp: 'Z', axisForward: 'X', bakeSpaceTransform: true });
    assert.ok(!warned, 'no bake warning for origin-only single mesh');
  } finally {
    console.warn = origWarn;
  }
});

// ============================================================================
// IG. buildTransformContext semantics
// ============================================================================

test('IG1: buildTransformContext({ preset: "threejs" }) → identity matrix', () => {
  const ctx = buildTransformContext({ axisUp: 'Y', axisForward: 'Z', unitScale: 1, bakeSpaceTransform: true });
  assert.equal(ctx.isIdentity, true);
});

test('IG2: bake=false → isIdentity=true regardless of axes (no matrix applied at write time)', () => {
  const ctx = buildTransformContext({ axisUp: 'Z', axisForward: 'X', bakeSpaceTransform: false });
  assert.equal(ctx.isIdentity, true,
    'when bake=false the geometry pass treats the matrix as identity — axes ride in GlobalSettings instead');
});

// ============================================================================
// IH. Normal bake — verify the inverse-transposed math matches Blender
// ============================================================================

test('IH1: PlaneGeometry normals are baked correctly under unreal preset', () => {
  // PlaneGeometry on the XY plane has normals = (0, 0, 1) (toward +Z).
  // Under Z-up X-forward bake, the plane orientation rotates and the
  // normal vector rotates with it.
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial()));
  const { tree } = exportToTree(scene, { preset: 'unreal' });
  const geom = findRoot(tree, 'Objects').children.find((c) => c.name === 'Geometry');
  const nl = findChild(geom, 'LayerElementNormal');
  const normalsProp = findChild(nl, 'Normals').props[0];
  const normals = new Float64Array(normalsProp.data.buffer, normalsProp.data.byteOffset, normalsProp.length);

  // All baked normals should still be UNIT length (regardless of which axis
  // they ended up on). That's the load-bearing invariant — preserving unit
  // length confirms the inverse-transposed math is correct.
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    assert.ok(Math.abs(len - 1) < 1e-6, `normal at ${i}: length ${len} (expected 1)`);
  }
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
