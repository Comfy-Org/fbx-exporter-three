// M5: bind-pose recovery — when an AnimationMixer has mutated
// bone.position/rotation/scale mid-frame, the exporter must still emit
// bone Lcl T/R/S at BIND pose so the file's cluster matrices and Bone
// Models agree on where the rest pose is.
//
// Reproduces the failure scenario reported from ComfyUI Load3D's "export
// while paused mid-animation" flow.
//
// Run: node test/m5-bindpose-recovery.test.mjs

import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzlibSync } from 'fflate';

globalThis.self = globalThis;
globalThis.window = { innerWidth: 1920, innerHeight: 1080, URL: globalThis.URL };

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { FBXExporter } = await import('../src/FBXExporter.js');
import * as DT from '../src/core/dataTypes.js';

let passes = 0, fails = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${name}`); console.error('       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); }
}

// ----- inline FBX parser (Lcl T/R/S extraction only) -----
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
    const nameLen = dv.getUint8(offset); offset += 1;
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
      case DT.INT8:  { const v = dv.getInt8(offset); offset += 1; return v; }
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

function findP70(model, propName) {
  const p70 = model.children.find((c) => c.name === 'Properties70');
  if (!p70) return null;
  return p70.children.find((c) => c.props[0] === propName);
}

function extractBoneTRS(bytes, boneNamePrefix) {
  const roots = parseFBXTree(bytes);
  const objects = roots.find((r) => r.name === 'Objects');
  const boneModels = objects.children
    .filter((c) => c.name === 'Model' && c.props[2] === 'LimbNode'
                   && c.props[1].startsWith(boneNamePrefix));
  return boneModels.map((m) => {
    const t = findP70(m, 'Lcl Translation');
    const r = findP70(m, 'Lcl Rotation');
    const s = findP70(m, 'Lcl Scaling');
    return {
      name: m.props[1],
      t: t ? [t.props[4], t.props[5], t.props[6]] : null,
      r: r ? [r.props[4], r.props[5], r.props[6]] : null,
      s: s ? [s.props[4], s.props[5], s.props[6]] : null,
    };
  });
}

// ----- main -----

const __dirname = dirname(fileURLToPath(import.meta.url));
const glbPath = resolve(__dirname, '_assets/Xbot.glb');

if (!existsSync(glbPath)) {
  // test/_assets/ is .gitignored. Skip gracefully on fresh clones so
  // `npm test` doesn't fail; this test still runs locally when the
  // user has placed Xbot.glb in test/_assets/.
  console.log(`SKIP — Xbot.glb not found at ${glbPath} (drop the file into test/_assets/ to enable)`);
  process.exit(0);
}

const buf = readFileSync(glbPath);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gltf = await new Promise((res, rej) =>
  new GLTFLoader().parse(ab, '', res, rej));
const root = gltf.scene;
root.animations = gltf.animations;

// Find first SkinnedMesh's first bone for spot comparison.
let firstSkinned = null;
root.traverse((o) => { if (!firstSkinned && o.isSkinnedMesh) firstSkinned = o; });
assert.ok(firstSkinned, 'have a SkinnedMesh');
const firstBone = firstSkinned.skeleton.bones[1];  // [1] avoids the root which may be at origin
const firstBoneName = firstBone.name;

// ----- baseline: export without running any animation -----
const baselineBytes = new FBXExporter().parseSync(root);
const baselineBones = extractBoneTRS(baselineBytes, firstBoneName);
assert.ok(baselineBones.length >= 1, `expected at least one bone matching prefix "${firstBoneName}"`);
const baseline = baselineBones[0];

// ----- run AnimationMixer halfway through a clip, then export -----
const mixer = new THREE.AnimationMixer(root);
const walkClip = gltf.animations.find((c) => c.name === 'walk');
assert.ok(walkClip, 'walk clip present');
const action = mixer.clipAction(walkClip);
action.play();
// Advance to roughly the middle of the clip — bone TRS is now mid-stride.
mixer.update(walkClip.duration / 2);

// Sanity: confirm the mixer DID actually move the bone (so the test is
// real — if bone TRS hasn't shifted at all, we're not exercising the bug).
// Mixamo "walk" mostly drives bone ROTATION, not translation — capture all
// three components.
const stillT = [firstBone.position.x, firstBone.position.y, firstBone.position.z];
const stillQ = [firstBone.quaternion.x, firstBone.quaternion.y, firstBone.quaternion.z, firstBone.quaternion.w];

const animatedBytes = new FBXExporter().parseSync(root);
const animatedBones = extractBoneTRS(animatedBytes, firstBoneName);
const animated = animatedBones[0];

console.log(`Baseline ${baseline.name} Lcl T = ${baseline.t.map((v) => v.toFixed(4))}`);
console.log(`Mid-stride bone.position    = ${stillT.map((v) => v.toFixed(4))}`);
console.log(`Mid-stride bone.quaternion  = ${stillQ.map((v) => v.toFixed(4))}`);
console.log(`After-mid-stride export ${animated.name} Lcl T = ${animated.t.map((v) => v.toFixed(4))}\n`);

// ----- assertions -----

test('mixer.update actually mutated the bone (sanity check via quaternion)', () => {
  // Mixamo's walk clip is rotation-driven, so we sanity-check the
  // quaternion's distance from identity. baseline q wasn't identity,
  // we just need bone.quaternion to differ from its bind quaternion —
  // any rotation-track keyframe will accomplish that.
  // Take the bind-pose quaternion by re-loading (or use a known-mutated
  // axis check): compare quaternion against bind by parsing Lcl R.
  // Simpler: just compare bone.quaternion against three.js identity.
  const distFromIdentity = Math.hypot(stillQ[0], stillQ[1], stillQ[2], 1 - stillQ[3]);
  // If the mixer hadn't run, bone.quaternion would still be whatever the
  // glTF declared. We instead verify that the *recovered Lcl R from the
  // baseline (no-mixer) export* differs from the bone.quaternion AFTER
  // the mixer ran — i.e. AnimationMixer pushed the bone to a different
  // pose than where it loaded.
  // (Caveat: if walk's first frame == bind pose, this would false-fail.
  //  Mixamo walk doesn't start in bind pose, so we're safe.)
  void distFromIdentity;  // for visibility in CI logs
  const bindQuatGuess = new THREE.Quaternion();
  // Reconstruct bind quaternion from Lcl R degrees → Euler ZYX → Quaternion.
  const RAD = Math.PI / 180;
  const bindEuler = new THREE.Euler(
    baseline.r[0] * RAD, baseline.r[1] * RAD, baseline.r[2] * RAD, 'ZYX',
  );
  bindQuatGuess.setFromEuler(bindEuler);
  const quatDelta = Math.hypot(
    stillQ[0] - bindQuatGuess.x,
    stillQ[1] - bindQuatGuess.y,
    stillQ[2] - bindQuatGuess.z,
    stillQ[3] - bindQuatGuess.w,
  );
  assert.ok(quatDelta > 1e-3,
    `mixer didn't move the bone — test isn't real. quatDelta=${quatDelta}`);
});

test('exported Lcl Translation matches BIND pose, not current animated pose', () => {
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(animated.t[i] - baseline.t[i]);
    assert.ok(d < 1e-4,
      `axis ${i}: animated-export Lcl T=${animated.t[i]} vs baseline=${baseline.t[i]} (delta=${d})`);
  }
});

test('exported Lcl Rotation matches BIND pose', () => {
  for (let i = 0; i < 3; i++) {
    // Rotation may have wrap-around freedom; tolerate ±0.5 deg.
    const d = Math.abs(animated.r[i] - baseline.r[i]);
    assert.ok(d < 0.5,
      `axis ${i}: animated-export Lcl R=${animated.r[i]} vs baseline=${baseline.r[i]} (delta=${d})`);
  }
});

test('exported Lcl Scaling matches BIND pose', () => {
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(animated.s[i] - baseline.s[i]);
    assert.ok(d < 1e-4,
      `axis ${i}: animated-export Lcl S=${animated.s[i]} vs baseline=${baseline.s[i]} (delta=${d})`);
  }
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
