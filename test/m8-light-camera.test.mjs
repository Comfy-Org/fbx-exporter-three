
import { strict as assert } from 'node:assert';
import { unzlibSync } from 'fflate';

globalThis.self = globalThis;
globalThis.window = { innerWidth: 1920, innerHeight: 1080 };

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { FBXExporter } = await import('../src/FBXExporter.js');
import * as DT from '../src/core/dataTypes.js';

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

function findFirst(group, predicate) {
  let found = null;
  group.traverse((o) => { if (!found && predicate(o)) found = o; });
  return found;
}

function findByName(group, name) {
  let found = null;
  group.traverse((o) => { if (o.name === name) found = found || o; });
  return found;
}


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
function findChildren(node, n) { return node ? node.children.filter((c) => c.name === n) : []; }

function exportToTree(scene) {
  const bytes = new FBXExporter().parseSync(scene);
  return { bytes, tree: parseFBXTree(bytes) };
}

function getNodeAttrs(tree, subtype) {
  const objects = findRoot(tree, 'Objects');
  return objects.children.filter(
    (c) => c.name === 'NodeAttribute' && c.props[2] === subtype,
  );
}
function getP70(node, name) {
  const p70 = findChild(node, 'Properties70');
  return p70 && p70.children.find((c) => c.props[0] === name);
}


test('EA1: PointLight re-imports as a PointLight', () => {
  const scene = new THREE.Scene();
  const light = new THREE.PointLight(0xff8800, 2.5, 100);
  light.name = 'P1';
  light.position.set(1, 2, 3);
  scene.add(light);

  const { group } = exportAndReimport(scene);
  const imported = findFirst(group, (o) => o.isPointLight);
  assert.ok(imported, 'PointLight imported');
  assert.equal(imported.name, 'P1');
});

test('EA2: PointLight intensity round-trips (× 100 → / 100 symmetry)', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight(0xffffff, 2.5));
  const { group } = exportAndReimport(scene);
  const imported = findFirst(group, (o) => o.isPointLight);
  assert.ok(Math.abs(imported.intensity - 2.5) < 1e-3,
    `intensity: ${imported.intensity}`);
});

test('EA3: DirectionalLight re-imports as DirectionalLight', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.DirectionalLight(0xffffff, 1.0));
  const { group } = exportAndReimport(scene);
  assert.ok(findFirst(group, (o) => o.isDirectionalLight), 'DirectionalLight imported');
});

test('EA4: SpotLight re-imports with correct angle and penumbra', () => {
  const scene = new THREE.Scene();
  const spot = new THREE.SpotLight(0xffffff, 1.0, 50,
    Math.PI / 4,
    0.5);
  scene.add(spot);
  const { group } = exportAndReimport(scene);
  const imported = findFirst(group, (o) => o.isSpotLight);
  assert.ok(imported, 'SpotLight imported');
  assert.ok(Math.abs(imported.angle - Math.PI / 4) < 0.01,
    `angle: ${imported.angle} (expected ≈ PI/4)`);
  assert.ok(Math.abs(imported.penumbra - 0.5) < 0.01,
    `penumbra: ${imported.penumbra} (expected ≈ 0.5)`);
});

test('EA5: PointLight distance preserved via FarAttenuationEnd', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight(0xffffff, 1, 42));
  const { group } = exportAndReimport(scene);
  const imported = findFirst(group, (o) => o.isPointLight);
  assert.equal(imported.distance, 42, `distance: ${imported.distance}`);
});

test('EA6: light.castShadow round-trips', () => {
  const scene = new THREE.Scene();
  const l = new THREE.PointLight(0xffffff, 1);
  l.castShadow = true;
  scene.add(l);
  const { group } = exportAndReimport(scene);
  const imported = findFirst(group, (o) => o.isPointLight);
  assert.equal(imported.castShadow, true);
});


test('EB1: PerspectiveCamera re-imports as PerspectiveCamera', () => {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 1000);
  cam.name = 'MainCam';
  cam.position.set(0, 5, 10);
  scene.add(cam);
  const { group } = exportAndReimport(scene);
  const imported = findFirst(group, (o) => o.isPerspectiveCamera);
  assert.ok(imported, 'PerspectiveCamera imported');
  assert.equal(imported.name, 'MainCam');
});

test('EB2: camera fov round-trips', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000));
  const { group } = exportAndReimport(scene);
  const imported = findFirst(group, (o) => o.isPerspectiveCamera);
  assert.ok(Math.abs(imported.fov - 60) < 0.1, `fov: ${imported.fov}`);
});

test('EB3: camera aspect ratio round-trips', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PerspectiveCamera(45, 1.5, 0.1, 1000));
  const { group } = exportAndReimport(scene);
  const imported = findFirst(group, (o) => o.isPerspectiveCamera);
  assert.ok(Math.abs(imported.aspect - 1.5) < 0.01, `aspect: ${imported.aspect}`);
});


test('EC1: PointLight NodeAttribute has LightType=0', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight());
  const { tree } = exportToTree(scene);
  const attrs = getNodeAttrs(tree, 'Light');
  assert.equal(attrs.length, 1);
  const lt = getP70(attrs[0], 'LightType');
  assert.equal(lt.props[4], 0, 'PointLight type = 0');
});

test('EC2: DirectionalLight NodeAttribute has LightType=1', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.DirectionalLight());
  const { tree } = exportToTree(scene);
  const lt = getP70(getNodeAttrs(tree, 'Light')[0], 'LightType');
  assert.equal(lt.props[4], 1);
});

test('EC3: SpotLight NodeAttribute has LightType=2', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.SpotLight());
  const { tree } = exportToTree(scene);
  const lt = getP70(getNodeAttrs(tree, 'Light')[0], 'LightType');
  assert.equal(lt.props[4], 2);
});

test('EC4: Light Color matches three.js .color (linear, sRGB conversion is FBXLoader-side)', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight(0xff0000, 1));
  const { tree } = exportToTree(scene);
  const c = getP70(getNodeAttrs(tree, 'Light')[0], 'Color');
  assert.ok(Math.abs(c.props[4] - 1.0) < 1e-4, `r: ${c.props[4]}`);
  assert.ok(Math.abs(c.props[5]) < 1e-4, `g: ${c.props[5]}`);
  assert.ok(Math.abs(c.props[6]) < 1e-4, `b: ${c.props[6]}`);
});

test('EC5: SpotLight OuterAngle = degrees(angle), InnerAngle = OuterAngle × (1 - penumbra)', () => {
  const scene = new THREE.Scene();
  const spot = new THREE.SpotLight(0xffffff, 1, 50, Math.PI / 3, 0.4);
  scene.add(spot);
  const { tree } = exportToTree(scene);
  const attr = getNodeAttrs(tree, 'Light')[0];
  const outer = getP70(attr, 'OuterAngle');
  const inner = getP70(attr, 'InnerAngle');
  const expectedOuter = (Math.PI / 3) * (180 / Math.PI);
  const expectedInner = expectedOuter * (1 - 0.4);
  assert.ok(Math.abs(outer.props[4] - expectedOuter) < 1e-3,
    `OuterAngle: ${outer.props[4]} (expected ${expectedOuter})`);
  assert.ok(Math.abs(inner.props[4] - expectedInner) < 1e-3,
    `InnerAngle: ${inner.props[4]} (expected ${expectedInner})`);
});

test('EC6: PerspectiveCamera NodeAttribute has CameraProjectionType=0', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PerspectiveCamera(45, 1, 0.1, 1000));
  const { tree } = exportToTree(scene);
  const attrs = getNodeAttrs(tree, 'Camera');
  assert.equal(attrs.length, 1);
  const proj = getP70(attrs[0], 'CameraProjectionType');
  assert.equal(proj.props[4], 0);
});

test('EC7: OrthographicCamera NodeAttribute has CameraProjectionType=1', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100));
  const { tree } = exportToTree(scene);
  const proj = getP70(getNodeAttrs(tree, 'Camera')[0], 'CameraProjectionType');
  assert.equal(proj.props[4], 1);
});

test('EC8: Camera FieldOfView = camera.fov (degrees, written as-is)', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 1000));
  const { tree } = exportToTree(scene);
  const fov = getP70(getNodeAttrs(tree, 'Camera')[0], 'FieldOfView');
  assert.equal(fov.props[4], 75);
});

test('EC9: Camera TypeFlags="Camera" + GeometryVersion=124 trailing fields', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PerspectiveCamera());
  const { tree } = exportToTree(scene);
  const attr = getNodeAttrs(tree, 'Camera')[0];
  assert.equal(findChild(attr, 'TypeFlags').props[0], 'Camera');
  assert.equal(findChild(attr, 'GeometryVersion').props[0], 124);
});


function parseConnections(tree) {
  return findRoot(tree, 'Connections').children
    .filter((c) => c.name === 'C')
    .map((c) => ({ type: c.props[0], src: c.props[1], dst: c.props[2] }));
}

test('ED1: NodeAttribute(Light) → Light Model via OO', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight());
  const { tree } = exportToTree(scene);
  const attr = getNodeAttrs(tree, 'Light')[0];
  const objects = findRoot(tree, 'Objects');
  const lightModel = objects.children.find(
    (c) => c.name === 'Model' && c.props[2] === 'Light');
  const conns = parseConnections(tree);
  const edge = conns.find((c) =>
    c.type === 'OO' && c.src === attr.props[0] && c.dst === lightModel.props[0]);
  assert.ok(edge, 'NodeAttribute → Light Model edge');
});

test('ED2: NodeAttribute(Camera) → Camera Model via OO', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PerspectiveCamera());
  const { tree } = exportToTree(scene);
  const attr = getNodeAttrs(tree, 'Camera')[0];
  const objects = findRoot(tree, 'Objects');
  const camModel = objects.children.find(
    (c) => c.name === 'Model' && c.props[2] === 'Camera');
  const conns = parseConnections(tree);
  const edge = conns.find((c) =>
    c.type === 'OO' && c.src === attr.props[0] && c.dst === camModel.props[0]);
  assert.ok(edge);
});


test('EE1: PointLight world position round-trips', () => {
  const scene = new THREE.Scene();
  const l = new THREE.PointLight();
  l.position.set(5, 10, -3);
  scene.add(l);
  const { group } = exportAndReimport(scene);
  const imported = findFirst(group, (o) => o.isPointLight);
  const p = new THREE.Vector3().setFromMatrixPosition(imported.matrixWorld);
  assert.ok(p.distanceTo(new THREE.Vector3(5, 10, -3)) < 1e-3,
    `position: ${p.toArray()}`);
});

test('EE2: PerspectiveCamera world position round-trips', () => {
  const scene = new THREE.Scene();
  const c = new THREE.PerspectiveCamera();
  c.position.set(0, 5, 10);
  scene.add(c);
  const { group } = exportAndReimport(scene);
  const imported = findFirst(group, (o) => o.isPerspectiveCamera);
  const p = new THREE.Vector3().setFromMatrixPosition(imported.matrixWorld);
  assert.ok(p.distanceTo(new THREE.Vector3(0, 5, 10)) < 1e-3);
});


test('EF1: AmbientLight has no FBX equivalent, exports as Null (no crash)', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const { tree } = exportToTree(scene);
  const lights = getNodeAttrs(tree, 'Light');
  assert.equal(lights.length, 0, 'no Light NodeAttribute for AmbientLight');
  const nulls = getNodeAttrs(tree, 'Null');
  assert.ok(nulls.length >= 1, 'AmbientLight collapsed to a Null NodeAttribute');
});

test('EF2: Scene with Light + Mesh + Camera all coexist and round-trip', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight()).name = 'Light';
  scene.add(new THREE.PerspectiveCamera()).name = 'Cam';
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = 'Box';
  scene.add(mesh);
  const { group } = exportAndReimport(scene);
  assert.ok(findFirst(group, (o) => o.isPointLight),       'light present');
  assert.ok(findFirst(group, (o) => o.isPerspectiveCamera), 'camera present');
  assert.ok(findFirst(group, (o) => o.isMesh),             'mesh present');
});


test('EG1: Definitions NodeAttribute Count includes lights + cameras + nulls + bones', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight());
  scene.add(new THREE.DirectionalLight());
  scene.add(new THREE.PerspectiveCamera());
  scene.add(new THREE.Group());
  const { tree } = exportToTree(scene);
  const defs = findRoot(tree, 'Definitions');
  const naOT = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'NodeAttribute');
  assert.ok(naOT, 'NodeAttribute ObjectType present');
  assert.equal(findChild(naOT, 'Count').props[0], 5);
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
