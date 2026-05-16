
import { strict as assert } from 'node:assert';

globalThis.self = globalThis;

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { FBXExporter } = await import('../src/FBXExporter.js');

let passes = 0, fails = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${name}`); console.error('       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); }
}

function exportAndReimport(scene) {
  const bytes = new FBXExporter().parseSync(scene);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const group = new FBXLoader().parse(ab, '');
  group.updateMatrixWorld(true);
  return { bytes, group };
}

function findByName(group, name) {
  let found = null;
  group.traverse((o) => { if (o.name === name) found = found || o; });
  return found;
}


test('CA1: Mesh translation track round-trips with the same times and values', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'Mover';
  scene.add(mesh);

  const track = new THREE.VectorKeyframeTrack(
    'Mover.position',
    new Float32Array([0, 0.5, 1.0]),
    new Float32Array([
      0, 0, 0,
      2.5, 0, 0,
      5, 0, 0,
    ]),
  );
  const clip = new THREE.AnimationClip('Move', 1.0, [track]);
  scene.animations = [clip];

  const { group } = exportAndReimport(scene);
  const clips = group.animations || (group.children[0] && group.children[0].animations);
  assert.ok(clips && clips.length >= 1, 'imported has at least one clip');
  const imported = clips[0];
  assert.equal(imported.name, 'Move');
  assert.ok(imported.duration > 0.99 && imported.duration < 1.01,
    `duration: ${imported.duration}`);

  const posTrack = imported.tracks.find((t) => t.name.endsWith('.position'));
  assert.ok(posTrack, 'position track present');
  assert.equal(posTrack.times.length, 3, '3 keyframes');
  assert.ok(Math.abs(posTrack.values[0]) < 1e-3, `x0: ${posTrack.values[0]}`);
  assert.ok(Math.abs(posTrack.values[6] - 5) < 1e-3, `xN: ${posTrack.values[6]}`);
});


test('CB1: Quaternion rotation track survives quaternion → Euler → quaternion round-trip', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'Rotator';
  scene.add(mesh);

  const q0 = new THREE.Quaternion();
  const q1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0, 'ZYX'));
  const track = new THREE.QuaternionKeyframeTrack(
    'Rotator.quaternion',
    new Float32Array([0, 1.0]),
    new Float32Array([
      q0.x, q0.y, q0.z, q0.w,
      q1.x, q1.y, q1.z, q1.w,
    ]),
  );
  const clip = new THREE.AnimationClip('Spin', 1.0, [track]);
  scene.animations = [clip];

  const { group } = exportAndReimport(scene);
  const clips = group.animations || [];
  assert.ok(clips.length >= 1);
  const rotTrack = clips[0].tracks.find((t) => t.name.endsWith('.quaternion'));
  assert.ok(rotTrack, 'rotation comes back as a quaternion track');
  assert.equal(rotTrack.values.length / 4, rotTrack.times.length);
  const lastIdx = rotTrack.times.length - 1;
  const importedQ = new THREE.Quaternion(
    rotTrack.values[lastIdx * 4],
    rotTrack.values[lastIdx * 4 + 1],
    rotTrack.values[lastIdx * 4 + 2],
    rotTrack.values[lastIdx * 4 + 3],
  );
  const dot = Math.abs(importedQ.dot(q1));
  assert.ok(dot > 0.999, `quaternion drift through Euler bake: dot=${dot}`);
});


test('CC1: Scale track round-trips', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'Scaler';
  scene.add(mesh);

  const track = new THREE.VectorKeyframeTrack(
    'Scaler.scale',
    new Float32Array([0, 0.5, 1.0]),
    new Float32Array([
      1, 1, 1,
      1.5, 2, 2.5,
      2, 3, 4,
    ]),
  );
  scene.animations = [new THREE.AnimationClip('Grow', 1.0, [track])];

  const { group } = exportAndReimport(scene);
  const clips = group.animations || [];
  assert.ok(clips.length >= 1);
  const scaleTrack = clips[0].tracks.find((t) => t.name.endsWith('.scale'));
  assert.ok(scaleTrack);
  assert.equal(scaleTrack.times.length, 3);
  const n = scaleTrack.times.length;
  assert.ok(Math.abs(scaleTrack.values[(n - 1) * 3]     - 2) < 1e-3);
  assert.ok(Math.abs(scaleTrack.values[(n - 1) * 3 + 1] - 3) < 1e-3);
  assert.ok(Math.abs(scaleTrack.values[(n - 1) * 3 + 2] - 4) < 1e-3);
});


test('CD1: One clip with position + quaternion + scale tracks all survive', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'AllAxes';
  scene.add(mesh);

  const tPos = new THREE.VectorKeyframeTrack(
    'AllAxes.position',
    new Float32Array([0, 1]),
    new Float32Array([0, 0, 0,  1, 0, 0]),
  );
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 4, 0));
  const tRot = new THREE.QuaternionKeyframeTrack(
    'AllAxes.quaternion',
    new Float32Array([0, 1]),
    new Float32Array([0, 0, 0, 1,  q.x, q.y, q.z, q.w]),
  );
  const tScale = new THREE.VectorKeyframeTrack(
    'AllAxes.scale',
    new Float32Array([0, 1]),
    new Float32Array([1, 1, 1,  2, 2, 2]),
  );
  scene.animations = [new THREE.AnimationClip('Combo', 1.0, [tPos, tRot, tScale])];

  const { group } = exportAndReimport(scene);
  const clips = group.animations || [];
  assert.equal(clips.length, 1);
  const trackNames = clips[0].tracks.map((t) => t.name);
  assert.ok(trackNames.some((n) => n.endsWith('.position')),    'position track present');
  assert.ok(trackNames.some((n) => n.endsWith('.quaternion')), 'rotation track present');
  assert.ok(trackNames.some((n) => n.endsWith('.scale')),      'scale track present');
});


test('CE1: SkinnedMesh bone animation round-trips', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([
    0,0,0,  1,0,0,  0,1,0,
  ], 3));
  geom.setIndex([0, 1, 2]);
  geom.setAttribute('skinIndex',  new THREE.Uint16BufferAttribute(new Uint16Array(12), 4));
  geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(12), 4));
  const b0 = new THREE.Bone();
  b0.name = 'AnimatedBone';
  const skeleton = new THREE.Skeleton([b0]);
  const sm = new THREE.SkinnedMesh(geom, new THREE.MeshStandardMaterial());
  sm.name = 'BoneMesh';
  sm.add(b0);
  sm.bind(skeleton);
  scene.add(sm);

  const track = new THREE.VectorKeyframeTrack(
    'AnimatedBone.position',
    new Float32Array([0, 1]),
    new Float32Array([0, 0, 0,  0, 2, 0]),
  );
  scene.animations = [new THREE.AnimationClip('BoneLift', 1.0, [track])];

  const { group } = exportAndReimport(scene);
  const clips = group.animations || [];
  assert.equal(clips.length, 1, 'one clip imported');
  const posTrack = clips[0].tracks.find((t) => t.name.includes('AnimatedBone'));
  assert.ok(posTrack, `track targeting the bone present (tracks: ${clips[0].tracks.map(t=>t.name).join(', ')})`);
});


test('CF1: Multiple AnimationClips become multiple AnimationStacks', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'MultiClip';
  scene.add(mesh);

  const clipA = new THREE.AnimationClip('A', 1.0, [
    new THREE.VectorKeyframeTrack('MultiClip.position',
      new Float32Array([0, 1]),
      new Float32Array([0, 0, 0,  1, 0, 0])),
  ]);
  const clipB = new THREE.AnimationClip('B', 0.5, [
    new THREE.VectorKeyframeTrack('MultiClip.scale',
      new Float32Array([0, 0.5]),
      new Float32Array([1, 1, 1,  2, 2, 2])),
  ]);
  scene.animations = [clipA, clipB];

  const { group } = exportAndReimport(scene);
  const clips = group.animations || [];
  assert.equal(clips.length, 2, `expected 2 clips, got ${clips.length}`);
  const names = clips.map((c) => c.name).sort();
  assert.deepEqual(names, ['A', 'B']);
});


test('CG1: Scene with no animations exports cleanly (no AnimStack nodes)', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  const bytes = new FBXExporter().parseSync(scene);
  const text = new TextDecoder('latin1').decode(bytes);
  assert.ok(!text.includes('\x0eAnimationStack'),
    'no AnimationStack node when scene has no clips');
});

test('CG2: Clip with empty tracks array does not emit a stack', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  scene.animations = [new THREE.AnimationClip('Empty', 1.0, [])];
  const bytes = new FBXExporter().parseSync(scene);
  const text = new TextDecoder('latin1').decode(bytes);
  assert.ok(!text.includes('\x0eAnimationStack'),
    'no AnimationStack for an empty-track clip');
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
