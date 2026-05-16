// M8 deep audit — byte-level invariants for light + camera NodeAttribute
// nodes against Blender's exact field set and ordering.
//
// Run: node test/m8-deep-audit.test.mjs

import { strict as assert } from 'node:assert';
import { unzlibSync } from 'fflate';

globalThis.self = globalThis;
globalThis.window = { innerWidth: 1920, innerHeight: 1080 };

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { FBXExporter } = await import('../src/FBXExporter.js');
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
function findChildren(node, n) { return node ? node.children.filter((c) => c.name === n) : []; }

function exportToTree(scene) {
  const bytes = new FBXExporter().parseSync(scene);
  return { bytes, tree: parseFBXTree(bytes) };
}
function getAttr(tree, subtype) {
  const objects = findRoot(tree, 'Objects');
  return objects.children.find(
    (c) => c.name === 'NodeAttribute' && c.props[2] === subtype);
}
function p70Names(node) {
  const p70 = findChild(node, 'Properties70');
  return p70.children.filter((c) => c.name === 'P').map((c) => c.props[0]);
}

// ============================================================================
// FA. Light Properties70 — every Blender field present in the right order
// ============================================================================
//
// Blender's fbx_data_light_elements writes (lines 615-622):
//   LightType, CastLight, Color, Intensity, DecayType, DecayStart,
//   CastShadows, ShadowColor
// Then for SpotLight: OuterAngle, InnerAngle (lines 624-626).

test('FA1: PointLight P70 order matches Blender exactly', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight(0xffffff, 1, 50));
  const attr = getAttr(exportToTree(scene).tree, 'Light');
  const names = p70Names(attr);

  // The leading 8 entries must appear in Blender's order. After that we may
  // emit FarAttenuationEnd / EnableFarAttenuation (FBXLoader needs them);
  // we accept those at the tail.
  const required = ['LightType', 'CastLight', 'Color', 'Intensity',
                    'DecayType', 'DecayStart', 'CastShadows', 'ShadowColor'];
  const positions = required.map((r) => names.indexOf(r));
  for (let i = 0; i < required.length; i++) {
    assert.ok(positions[i] !== -1, `missing ${required[i]} in P70 (${JSON.stringify(names)})`);
  }
  for (let i = 1; i < required.length; i++) {
    assert.ok(positions[i] > positions[i - 1],
      `${required[i]} should come AFTER ${required[i - 1]} (got positions ${positions[i - 1]} → ${positions[i]})`);
  }
});

test('FA2: SpotLight P70 includes OuterAngle + InnerAngle AFTER the base 8', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.SpotLight(0xffffff, 1, 50, Math.PI / 4, 0.3));
  const attr = getAttr(exportToTree(scene).tree, 'Light');
  const names = p70Names(attr);
  const outerIdx = names.indexOf('OuterAngle');
  const innerIdx = names.indexOf('InnerAngle');
  const castShadowsIdx = names.indexOf('CastShadows');
  assert.ok(outerIdx !== -1, 'OuterAngle present');
  assert.ok(innerIdx !== -1, 'InnerAngle present');
  assert.ok(outerIdx > castShadowsIdx, 'OuterAngle after CastShadows');
  assert.ok(innerIdx > outerIdx,        'InnerAngle after OuterAngle');
});

test('FA3: PointLight P70 does NOT include OuterAngle/InnerAngle (spot-only)', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight());
  const names = p70Names(getAttr(exportToTree(scene).tree, 'Light'));
  assert.ok(!names.includes('OuterAngle'));
  assert.ok(!names.includes('InnerAngle'));
});

// ============================================================================
// FB. Light field types and value semantics
// ============================================================================

test('FB1: DecayStart is a p_double (matches Blender p_double, lines 620)', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight());
  const attr = getAttr(exportToTree(scene).tree, 'Light');
  const p70 = findChild(attr, 'Properties70');
  const decayStart = p70.children.find((c) => c.props[0] === 'DecayStart');
  assert.ok(decayStart, 'DecayStart present');
  // P record format: name, type1, type2, flags, value.
  assert.equal(decayStart.props[1], 'double', `type1: ${decayStart.props[1]}`);
});

test('FB2: SpotLight InnerAngle = OuterAngle × (1 - penumbra) exact formula', () => {
  // Blender formula at export_fbx_bin.py:625-626.
  const scene = new THREE.Scene();
  const spot = new THREE.SpotLight(0xffffff, 1, 50, Math.PI / 3, 0.4);
  scene.add(spot);
  const attr = getAttr(exportToTree(scene).tree, 'Light');
  const p70 = findChild(attr, 'Properties70');
  const outer = p70.children.find((c) => c.props[0] === 'OuterAngle').props[4];
  const inner = p70.children.find((c) => c.props[0] === 'InnerAngle').props[4];
  // outer should ≈ 60°, inner should ≈ 60 × (1 - 0.4) = 36°
  assert.ok(Math.abs(outer - 60) < 0.01, `outer: ${outer}`);
  assert.ok(Math.abs(inner - outer * 0.6) < 0.01, `inner: ${inner} (expected ${outer * 0.6})`);
});

test('FB3: Intensity = three.js.intensity × 100 (matches FBXLoader / 100 inverse)', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight(0xffffff, 2.7));
  const attr = getAttr(exportToTree(scene).tree, 'Light');
  const p70 = findChild(attr, 'Properties70');
  const intensity = p70.children.find((c) => c.props[0] === 'Intensity');
  assert.ok(Math.abs(intensity.props[4] - 270) < 1e-6, `Intensity: ${intensity.props[4]}`);
});

test('FB4: DecayType=2 (INVERSE_SQUARE), matching Blender default', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight());
  const attr = getAttr(exportToTree(scene).tree, 'Light');
  const p70 = findChild(attr, 'Properties70');
  const dt = p70.children.find((c) => c.props[0] === 'DecayType');
  assert.equal(dt.props[4], 2);
});

test('FB5: LightType enum is p_enum (not p_integer)', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight());
  const attr = getAttr(exportToTree(scene).tree, 'Light');
  const p70 = findChild(attr, 'Properties70');
  const lt = p70.children.find((c) => c.props[0] === 'LightType');
  assert.equal(lt.props[1], 'enum');
});

test('FB6: CastShadows is p_bool', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight());
  const attr = getAttr(exportToTree(scene).tree, 'Light');
  const p70 = findChild(attr, 'Properties70');
  const cs = p70.children.find((c) => c.props[0] === 'CastShadows');
  assert.equal(cs.props[1], 'bool');
});

// ============================================================================
// FC. Camera attribute structure
// ============================================================================

test('FC1: Camera attribute has GeometryVersion=124 as a trailing top-level child', () => {
  // NOT inside Properties70 — Blender writes elem_data_single_int32
  // (export_fbx_bin.py:716).
  const scene = new THREE.Scene();
  scene.add(new THREE.PerspectiveCamera());
  const attr = getAttr(exportToTree(scene).tree, 'Camera');
  const gv = findChild(attr, 'GeometryVersion');
  assert.ok(gv, 'GeometryVersion present');
  assert.equal(gv.props[0], 124);
});

test('FC2: Camera trailing fields in Blender order (TypeFlags → ... → CameraOrthoZoom)', () => {
  // Blender (lines 715-723):
  //   TypeFlags, GeometryVersion, Position, Up, LookAt,
  //   ShowInfoOnMoving, ShowAudio, AudioColor, CameraOrthoZoom
  const scene = new THREE.Scene();
  scene.add(new THREE.PerspectiveCamera());
  const attr = getAttr(exportToTree(scene).tree, 'Camera');
  // Collect child names AFTER Properties70.
  let p70Seen = false;
  const trailing = [];
  for (const c of attr.children) {
    if (c.name === 'Properties70') { p70Seen = true; continue; }
    if (p70Seen) trailing.push(c.name);
  }
  assert.deepEqual(trailing, [
    'TypeFlags', 'GeometryVersion', 'Position', 'Up', 'LookAt',
    'ShowInfoOnMoving', 'ShowAudio', 'AudioColor', 'CameraOrthoZoom',
  ], `trailing fields: ${JSON.stringify(trailing)}`);
});

test('FC3: Camera Position / Up / LookAt are vec3 float64 children (NOT Properties70)', () => {
  // Blender uses elem_data_vec_float64 (export_fbx_bin.py:717-719) — these
  // are bare nodes with 3 float64 props, not Properties70 P records.
  const scene = new THREE.Scene();
  scene.add(new THREE.PerspectiveCamera());
  const attr = getAttr(exportToTree(scene).tree, 'Camera');
  for (const name of ['Position', 'Up', 'LookAt']) {
    const c = findChild(attr, name);
    assert.ok(c, `${name} child present`);
    assert.equal(c.props.length, 3, `${name} has 3 props`);
    for (const v of c.props) assert.equal(typeof v, 'number', `${name} props are numbers`);
  }
});

test('FC4: CameraProjectionType is p_enum (not p_integer)', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.PerspectiveCamera());
  const attr = getAttr(exportToTree(scene).tree, 'Camera');
  const p70 = findChild(attr, 'Properties70');
  const proj = p70.children.find((c) => c.props[0] === 'CameraProjectionType');
  assert.equal(proj.props[1], 'enum');
});

test('FC5: FieldOfView uses p_fov type (matches Blender p_fov, line 691)', () => {
  // p_fov has type1="FieldOfView", subtype="", animatable.
  const scene = new THREE.Scene();
  scene.add(new THREE.PerspectiveCamera());
  const attr = getAttr(exportToTree(scene).tree, 'Camera');
  const p70 = findChild(attr, 'Properties70');
  const fov = p70.children.find((c) => c.props[0] === 'FieldOfView');
  assert.equal(fov.props[1], 'FieldOfView', 'type1 is "FieldOfView"');
});

// ============================================================================
// FD. Spot edge cases
// ============================================================================

test('FD1: SpotLight with penumbra=0 → InnerAngle = OuterAngle (sharp cone)', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.SpotLight(0xffffff, 1, 50, Math.PI / 4, 0));
  const attr = getAttr(exportToTree(scene).tree, 'Light');
  const p70 = findChild(attr, 'Properties70');
  const outer = p70.children.find((c) => c.props[0] === 'OuterAngle').props[4];
  const inner = p70.children.find((c) => c.props[0] === 'InnerAngle').props[4];
  assert.ok(Math.abs(outer - inner) < 1e-6, `outer=${outer}, inner=${inner}`);
});

test('FD2: SpotLight with penumbra=1 → InnerAngle = 0 (fully soft cone)', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.SpotLight(0xffffff, 1, 50, Math.PI / 4, 1));
  const attr = getAttr(exportToTree(scene).tree, 'Light');
  const p70 = findChild(attr, 'Properties70');
  const inner = p70.children.find((c) => c.props[0] === 'InnerAngle').props[4];
  assert.ok(Math.abs(inner) < 1e-6, `inner: ${inner}`);
});

// ============================================================================
// FE. Connection direction verified at byte level
// ============================================================================

function parseConnections(tree) {
  return findRoot(tree, 'Connections').children
    .filter((c) => c.name === 'C')
    .map((c) => ({ type: c.props[0], src: c.props[1], dst: c.props[2] }));
}

test('FE1: Light NodeAttribute → Light Model direction matches Blender (src=attr, dst=model)', () => {
  // Blender: connections.append((b"OO", get_fbx_uuid_from_key(light_key), ob_obj.fbx_uuid, None))
  // (export_fbx_bin.py:3076). src = NodeAttribute, dst = Model.
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight());
  const tree = exportToTree(scene).tree;
  const attr = getAttr(tree, 'Light');
  const objects = findRoot(tree, 'Objects');
  const lightModel = objects.children.find((c) => c.name === 'Model' && c.props[2] === 'Light');
  const conns = parseConnections(tree);
  const edge = conns.find((c) => c.src === attr.props[0]);
  assert.ok(edge, 'edge from NodeAttribute exists');
  assert.equal(edge.dst, lightModel.props[0], 'edge targets the Light Model');
});

// ============================================================================
// FF. Definitions: NodeAttribute users include lights/cameras (not Null only)
// ============================================================================

test('FF1: Definitions PropertyTemplate is picked from the dominant subtype', () => {
  // When the scene has only lights, the NodeAttribute PropertyTemplate
  // should use propTypeName "FbxLight" — not "FbxNull".
  const scene = new THREE.Scene();
  scene.add(new THREE.PointLight());
  scene.add(new THREE.PointLight());
  const tree = exportToTree(scene).tree;
  const defs = findRoot(tree, 'Definitions');
  const naOT = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'NodeAttribute');
  const tmpl = findChild(naOT, 'PropertyTemplate');
  assert.equal(tmpl.props[0], 'FbxLight', `dominant subtype: ${tmpl.props[0]}`);
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
