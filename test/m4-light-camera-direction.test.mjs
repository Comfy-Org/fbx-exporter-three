// M4 audit follow-up: verify whether Light / Camera direction survives a
// three.js → FBX → FBXLoader round-trip. Blender applies MAT_CONVERT_LIGHT
// (+π/2 X) and MAT_CONVERT_CAMERA (+π/2 Y) to compensate for Blender's
// "lights/cameras point -Z" convention vs FBX's "-Y for lights, +X for
// cameras" (fbx_utils.py:73-74). Three.js uses a TARGET object for
// directional/spot lights, not a quaternion — so the question is whether
// our current export round-trips correctly without those corrections.
//
// Run: node test/m4-light-camera-direction.test.mjs

import { strict as assert } from 'node:assert';

globalThis.self = globalThis;
globalThis.window = { innerWidth: 1920, innerHeight: 1080, URL: globalThis.URL };

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { FBXExporter } = await import('../src/FBXExporter.js');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

let passes = 0, fails = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passes++; }
  catch (e) {
    fails++;
    console.error(`  FAIL  ${name}`);
    console.error('       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       '));
  }
}

function roundTrip(scene, options) {
  const bytes = new FBXExporter().parseSync(scene, options);
  return new FBXLoader().parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
}

// ----------------------------------------------------------------------------
// Light direction round-trip
// ----------------------------------------------------------------------------

test('DirectionalLight at (0,10,0) with default target at origin — direction preserved', () => {
  // Three.js convention: light shines from `position` toward `target.position`.
  // With light at (0,10,0) and target at (0,0,0), the light shines DOWN (-Y).
  const scene = new THREE.Scene();
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(0, 10, 0);
  scene.add(light);

  const group = roundTrip(scene);
  let imported = null;
  group.traverse((o) => { if (o.isLight && o.isDirectionalLight) imported = o; });
  assert.ok(imported, 'imported a DirectionalLight');

  // The light's effective direction is (target.position - position).normalize().
  const lightDir = new THREE.Vector3()
    .subVectors(imported.target.position, imported.position).normalize();

  // Original: light at (0,10,0), target at (0,0,0) → direction (0,-1,0).
  assert.ok(Math.abs(lightDir.y - (-1)) < 0.01,
    `light should shine -Y; got direction (${lightDir.x}, ${lightDir.y}, ${lightDir.z})`);
});

test('SpotLight pointing at (5,0,0) — target Lcl_Translation survives round-trip', () => {
  // M8 follow-up fix: three.js's DirectionalLight / SpotLight encode
  // direction via `light.target.position`, a separate Object3D. To make
  // this round-trip through FBXLoader.setLookAtProperties (FBXLoader.js:
  // 1502-1538), the exporter now:
  //   (1) Emits an auxiliary Null Model for off-scene targets with the
  //       target's WORLD position as Lcl_Translation
  //   (2) Writes `LookAtProperty: p_object` in the light Model's
  //       Properties70 (FBXLoader gates on this name being present)
  //   (3) Adds an OP connection [target_uid, light_uid, "LookAtProperty"]
  //       so FBXLoader's connections.get(lightID).children pass picks it up
  const scene = new THREE.Scene();
  const light = new THREE.SpotLight(0xffffff, 1, 100, Math.PI / 6);
  light.position.set(0, 5, 0);
  light.target.position.set(5, 0, 0);
  scene.add(light);
  scene.add(light.target);

  const group = roundTrip(scene);
  let imported = null;
  group.traverse((o) => { if (o.isLight && o.isSpotLight) imported = o; });
  assert.ok(imported, 'imported a SpotLight');

  const t = imported.target.position;
  assert.ok(Math.abs(t.x - 5) < 0.5 && Math.abs(t.y) < 0.5 && Math.abs(t.z) < 0.5,
    `target should be near (5,0,0); got (${t.x}, ${t.y}, ${t.z})`);
});

test('SpotLight with off-scene target (only attached via light.target ref) — direction preserved', () => {
  // The harder case: user never did `scene.add(light.target)`, so the
  // target Object3D is reachable ONLY through the light. We must still
  // emit it as an auxiliary Null Model.
  const scene = new THREE.Scene();
  const light = new THREE.SpotLight(0xffffff, 1, 100, Math.PI / 6);
  light.position.set(0, 10, 0);
  light.target.position.set(-3, 0, 0);  // off-scene target
  scene.add(light);  // note: target NOT added to scene

  const group = roundTrip(scene);
  let imported = null;
  group.traverse((o) => { if (o.isLight && o.isSpotLight) imported = o; });
  assert.ok(imported, 'imported the SpotLight');

  const t = imported.target.position;
  assert.ok(Math.abs(t.x - (-3)) < 0.5 && Math.abs(t.y) < 0.5 && Math.abs(t.z) < 0.5,
    `off-scene target should still round-trip; got (${t.x}, ${t.y}, ${t.z})`);
});

// ----------------------------------------------------------------------------
// Camera direction round-trip
// ----------------------------------------------------------------------------

test('PerspectiveCamera looking at (0,0,-10) from origin — direction preserved', () => {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(75, 16/9, 0.1, 1000);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, -10);  // look toward -Z (default three.js direction)
  scene.add(cam);

  const group = roundTrip(scene);
  let imported = null;
  group.traverse((o) => { if (o.isCamera) imported = o; });
  assert.ok(imported, 'imported a Camera');

  // What direction does the imported camera face? Three.js Camera's forward
  // is its local -Z. Apply the camera's world quaternion to (0,0,-1) to
  // recover the world-space forward vector.
  imported.updateMatrixWorld(true);
  const forward = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(imported.getWorldQuaternion(new THREE.Quaternion()));

  // Original camera looked along world -Z, so forward.z should be ≈ -1.
  assert.ok(Math.abs(forward.z - (-1)) < 0.1,
    `camera should face -Z; got forward (${forward.x.toFixed(3)}, ${forward.y.toFixed(3)}, ${forward.z.toFixed(3)})`);
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
