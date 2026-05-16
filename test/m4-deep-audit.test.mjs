
import { strict as assert } from 'node:assert';
import { Matrix4 } from 'three';

import {
  PRESETS, resolvePreset, buildAxisMatrix, buildTransformContext,
  bakeVertices, bakeNormals,
} from '../src/data/transforms.js';

let passes = 0, fails = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${name}`); console.error('       ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n       ')); }
}


test('A1: resolvePreset({}) → threejs defaults (fallback when preset omitted)', () => {
  const r = resolvePreset({});
  assert.equal(r.axisUp,      'Y');
  assert.equal(r.axisForward, 'Z');
  assert.equal(r.unitScale,   1);
  assert.equal(r.bakeSpaceTransform, false);
});

test('A2: resolvePreset({ preset: "unreal" }) → unreal full defaults', () => {
  const r = resolvePreset({ preset: 'unreal' });
  assert.equal(r.axisUp, 'Z');
  assert.equal(r.axisForward, 'X');
  assert.equal(r.bakeSpaceTransform, false);
});

test('A3: resolvePreset({ preset: "unreal", axisUp: "Y" }) → user wins on axisUp only', () => {
  const r = resolvePreset({ preset: 'unreal', axisUp: 'Y' });
  assert.equal(r.axisUp,            'Y',  'user override wins');
  assert.equal(r.axisForward,       'X',  'other unreal defaults still apply');
  assert.equal(r.bakeSpaceTransform, false, 'bake default still applies');
});

test('A4: explicit undefined in settings does NOT clobber preset value', () => {
  const r = resolvePreset({ preset: 'unreal', axisUp: undefined });
  assert.equal(r.axisUp, 'Z', 'undefined value falls through to preset');
});

test('A5: unknown preset name → warns but does not throw', () => {
  const origWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const r = resolvePreset({ preset: 'nonsense', axisUp: 'Z' });
    assert.equal(r.axisUp, 'Z');
    assert.ok(warned, 'console.warn was called');
  } finally {
    console.warn = origWarn;
  }
});


function assertMatEqual(actual, expected, label) {
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-9,
      `${label}: e[${i}] = ${actual[i]} (expected ${expected[i]})`);
  }
}

test('B1: buildAxisMatrix(Y, Z) — identity (three.js native)', () => {
  const m = buildAxisMatrix('Y', 'Z');
  assertMatEqual(m.elements,
    [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], 'Y|Z identity');
});

test('B2: buildAxisMatrix(Y, Z) preserves point on Y axis', () => {
  const m = buildAxisMatrix('Y', 'Z');
  const v = new Float64Array([0, 5, 0]);
  bakeVertices(v, m);
  assert.ok(Math.abs(v[0]) < 1e-9 && Math.abs(v[1] - 5) < 1e-9 && Math.abs(v[2]) < 1e-9);
});

test('B3: buildAxisMatrix(Z, X) — rotates Y-up vector (0,1,0) to Z-up (0,0,1)', () => {
  const m = buildAxisMatrix('Z', 'X');
  const v = new Float64Array([0, 1, 0]);
  bakeVertices(v, m);
  const len = Math.hypot(v[0], v[1], v[2]);
  assert.ok(Math.abs(len - 1) < 1e-9, `vector length preserved: ${len}`);
  assert.ok(Math.abs(v[2]) > 0.99,    `vector points along Z: ${v[0]}, ${v[1]}, ${v[2]}`);
});

test('B4: buildAxisMatrix is rotation-only (determinant ≈ ±1)', () => {
  for (const up of ['X', '-X', 'Y', '-Y', 'Z', '-Z']) {
    for (const fwd of ['X', '-X', 'Y', '-Y', 'Z', '-Z']) {
      if (up.replace('-', '') === fwd.replace('-', '')) continue;
      const m = buildAxisMatrix(up, fwd);
      const e = m.elements;
      const det =
        e[0] * (e[5] * e[10] - e[6] * e[9]) -
        e[4] * (e[1] * e[10] - e[2] * e[9]) +
        e[8] * (e[1] * e[6]  - e[2] * e[5]);
      assert.ok(Math.abs(Math.abs(det) - 1) < 1e-9,
        `det for ${up}/${fwd} = ${det}`);
    }
  }
});


test('C1: bake=false → isIdentity=true (axes ride in GlobalSettings only)', () => {
  const ctx = buildTransformContext({ axisUp: 'Z', axisForward: 'X', bakeSpaceTransform: false });
  assert.equal(ctx.isIdentity, true,
    'when bake disabled, geometry writers must skip the matrix multiply');
});

test('C2: bake=true with non-identity axes → isIdentity=false', () => {
  const ctx = buildTransformContext({ axisUp: 'Z', axisForward: 'X', bakeSpaceTransform: true });
  assert.equal(ctx.isIdentity, false);
});

test('C3: bake=true with identity axes → isIdentity=true (no-op even when baking)', () => {
  const ctx = buildTransformContext({ axisUp: 'Y', axisForward: 'Z', bakeSpaceTransform: true });
  assert.equal(ctx.isIdentity, true);
});

test('C4: bake=true + unitScale=100 → globalMatrix scales by 100', () => {
  const ctx = buildTransformContext({ axisUp: 'Y', axisForward: 'Z', unitScale: 100, bakeSpaceTransform: true });
  const e = ctx.globalMatrix.elements;
  assert.ok(Math.abs(e[0]  - 100) < 1e-9, 'e[0] = 100');
  assert.ok(Math.abs(e[5]  - 100) < 1e-9, 'e[5] = 100');
  assert.ok(Math.abs(e[10] - 100) < 1e-9, 'e[10] = 100');
});


test('D1: bakeNormals re-normalises after a non-uniform-scale matrix', () => {
  const m = new Matrix4().makeScale(2, 4, 8);
  const ctx = {
    globalMatrix: m,
    globalMatrixInvTransposed: new Matrix4().copy(m).invert().transpose(),
  };
  const n = new Float64Array([0.577, 0.577, 0.577]);
  bakeNormals(n, ctx.globalMatrixInvTransposed);
  const len = Math.hypot(n[0], n[1], n[2]);
  assert.ok(Math.abs(len - 1) < 1e-6, `re-normalised: ${len}`);
});

test('D2: bakeNormals leaves zero vector at zero (no NaN)', () => {
  const m = new Matrix4().makeScale(2, 4, 8);
  const invT = new Matrix4().copy(m).invert().transpose();
  const n = new Float64Array([0, 0, 0]);
  bakeNormals(n, invT);
  assert.ok(Number.isFinite(n[0]) && Number.isFinite(n[1]) && Number.isFinite(n[2]),
    'no NaN from zero-length normal');
});


test('E1: threejs preset → identity transform context (no bake, scale=1)', () => {
  const ctx = buildTransformContext(PRESETS.threejs);
  assert.equal(ctx.isIdentity, true);
  assert.equal(ctx.unitScale, 1);
});

test('E2: unreal preset → bake=false (only axes declared in GlobalSettings)', () => {
  assert.equal(PRESETS.unreal.bakeSpaceTransform, false);
});

test('E3: blender / maya: unitScale=100, bake=false (axes already match)', () => {
  for (const tool of ['blender', 'maya']) {
    assert.equal(PRESETS[tool].unitScale, 100, `${tool} unitScale`);
    assert.equal(PRESETS[tool].bakeSpaceTransform, false, `${tool} bake disabled`);
  }
});


test('F1: bake then unbake recovers original vertex (round-trip identity)', () => {
  for (const presetName of ['unreal', 'unity']) {
    const ctx = buildTransformContext({
      ...PRESETS[presetName],
      bakeSpaceTransform: true,
    });
    if (ctx.isIdentity) continue;
    const original = new Float64Array([1, 2, 3, -4, 5, -6]);
    const copy = new Float64Array(original);
    bakeVertices(copy, ctx.globalMatrix);
    const inv = new Matrix4().copy(ctx.globalMatrix).invert();
    bakeVertices(copy, inv);
    for (let i = 0; i < copy.length; i++) {
      assert.ok(Math.abs(copy[i] - original[i]) < 1e-9,
        `${presetName}[${i}]: ${copy[i]} vs ${original[i]}`);
    }
  }
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
