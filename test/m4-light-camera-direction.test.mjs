
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


test('DirectionalLight at (0,10,0) with default target at origin — direction preserved', () => {
  const scene = new THREE.Scene();
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(0, 10, 0);
  scene.add(light);

  const group = roundTrip(scene);
  let imported = null;
  group.traverse((o) => { if (o.isLight && o.isDirectionalLight) imported = o; });
  assert.ok(imported, 'imported a DirectionalLight');

  const lightDir = new THREE.Vector3()
    .subVectors(imported.target.position, imported.position).normalize();

  assert.ok(Math.abs(lightDir.y - (-1)) < 0.01,
    `light should shine -Y; got direction (${lightDir.x}, ${lightDir.y}, ${lightDir.z})`);
});

test('SpotLight pointing at (5,0,0) — target Lcl_Translation survives round-trip', () => {
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
  const scene = new THREE.Scene();
  const light = new THREE.SpotLight(0xffffff, 1, 100, Math.PI / 6);
  light.position.set(0, 10, 0);
  light.target.position.set(-3, 0, 0);
  scene.add(light);

  const group = roundTrip(scene);
  let imported = null;
  group.traverse((o) => { if (o.isLight && o.isSpotLight) imported = o; });
  assert.ok(imported, 'imported the SpotLight');

  const t = imported.target.position;
  assert.ok(Math.abs(t.x - (-3)) < 0.5 && Math.abs(t.y) < 0.5 && Math.abs(t.z) < 0.5,
    `off-scene target should still round-trip; got (${t.x}, ${t.y}, ${t.z})`);
});


test('PerspectiveCamera looking at (0,0,-10) from origin — direction preserved', () => {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(75, 16/9, 0.1, 1000);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, -10);
  scene.add(cam);

  const group = roundTrip(scene);
  let imported = null;
  group.traverse((o) => { if (o.isCamera) imported = o; });
  assert.ok(imported, 'imported a Camera');

  imported.updateMatrixWorld(true);
  const forward = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(imported.getWorldQuaternion(new THREE.Quaternion()));

  assert.ok(Math.abs(forward.z - (-1)) < 0.1,
    `camera should face -Z; got forward (${forward.x.toFixed(3)}, ${forward.y.toFixed(3)}, ${forward.z.toFixed(3)})`);
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
