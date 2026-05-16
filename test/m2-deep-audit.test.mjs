
import { strict as assert } from 'node:assert';
import { unzlibSync } from 'fflate';

globalThis.self = globalThis;

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { FBXExporter } = await import('../src/FBXExporter.js');
const { UidRegistry } = await import('../src/core/uid.js');
import * as DT from '../src/core/dataTypes.js';

let passes = 0, fails = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${name}`); console.error('       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
}


function parseFBXTree(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint32(23, true);
  let offset = 27;
  const use64 = version >= 7500;
  const ms = use64 ? 24 : 12;
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
      case DT.CHAR:    { const v = dv.getUint8(offset); offset += 1; return v; }
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
        return { length, encoding, data };
      }
      default: throw new Error(`Unknown tag 0x${tag.toString(16)} at offset ${offset - 1}`);
    }
  }
}

function findRoot(tree, name) {
  return tree.find((n) => n.name === name);
}
function findChild(node, name) {
  return node && node.children.find((c) => c.name === name);
}
function findChildren(node, name) {
  return node ? node.children.filter((c) => c.name === name) : [];
}

function exportSimpleScene() {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  scene.add(mesh);
  return new FBXExporter().parseSync(scene);
}


test('K1: UidRegistry never allocates 0 (reserved for FBX RootNode)', () => {
  const reg = new UidRegistry();
  reg._uidToKey.set(0n, '__root__');
  for (let i = 0; i < 5000; i++) {
    const u = reg.get(`stress-${i}`);
    assert.notEqual(u, 0n, `key 'stress-${i}' was assigned 0`);
  }
});


test('L1: top-level node order matches order (Header, FileId, CreationTime, Creator, GlobalSettings, Documents, References, Definitions, Objects, Connections, Takes)', () => {
  const bytes = exportSimpleScene();
  const tree = parseFBXTree(bytes);
  const names = tree.map((n) => n.name);
  const expected = [
    'FBXHeaderExtension',
    'FileId',
    'CreationTime',
    'Creator',
    'GlobalSettings',
    'Documents',
    'References',
    'Definitions',
    'Objects',
    'Connections',
    'Takes',
  ];
  assert.deepEqual(names, expected, `node order: ${JSON.stringify(names)}`);
});

test('L2: FBXHeaderExtension carries FBXHeaderVersion=1003 + FBXVersion=7400', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const hdr = findRoot(tree, 'FBXHeaderExtension');
  assert.ok(hdr);
  const hv = findChild(hdr, 'FBXHeaderVersion');
  const fv = findChild(hdr, 'FBXVersion');
  assert.equal(hv.props[0], 1003);
  assert.equal(fv.props[0], 7400);
});

test('L3: SceneInfo present with Type=UserData + Version=100 + MetaData child', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const hdr = findRoot(tree, 'FBXHeaderExtension');
  const sceneInfo = findChild(hdr, 'SceneInfo');
  assert.ok(sceneInfo, 'SceneInfo child of FBXHeaderExtension');
  assert.ok(sceneInfo.props[0].startsWith('GlobalInfo'),
    `prop 0 starts with 'GlobalInfo', got ${JSON.stringify(sceneInfo.props[0])}`);
  assert.equal(sceneInfo.props[1], 'UserData');
  const typeNode = findChild(sceneInfo, 'Type');
  const versionNode = findChild(sceneInfo, 'Version');
  const metaData = findChild(sceneInfo, 'MetaData');
  assert.equal(typeNode.props[0], 'UserData');
  assert.equal(versionNode.props[0], 100);
  assert.ok(metaData, 'MetaData child');
  for (const key of ['Title', 'Subject', 'Author', 'Keywords', 'Revision', 'Comment']) {
    assert.ok(findChild(metaData, key), `MetaData.${key} present`);
  }
});

test('L4: FileId is the 16-byte placeholder constant after time hack', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const fid = findRoot(tree, 'FileId');
  assert.ok(fid);
  assert.ok(fid.props[0] instanceof Uint8Array, 'FileId prop is bytes');
  assert.equal(fid.props[0].byteLength, 16, 'FileId is 16 bytes');
  let allZero = true;
  for (const b of fid.props[0]) if (b !== 0) { allZero = false; break; }
  assert.ok(!allZero, 'FileId is the non-zero constant');
});

test('L5: CreationTime is the placeholder string (deterministic)', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const ct = findRoot(tree, 'CreationTime');
  assert.equal(ct.props[0], '1970-01-01 10:00:00:000');
});

test('L6: Documents node has Count=1 + one Document child', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const docs = findRoot(tree, 'Documents');
  assert.ok(docs);
  const count = findChild(docs, 'Count');
  assert.equal(count.props[0], 1);
  const doc = findChild(docs, 'Document');
  assert.ok(doc);
  assert.equal(doc.props.length, 3);
  assert.equal(typeof doc.props[0], 'bigint', 'Document uid is int64');
  assert.equal(doc.props[1], doc.props[2], 'name appears twice');
  assert.ok(findChild(doc, 'Properties70'));
  const rootNode = findChild(doc, 'RootNode');
  assert.ok(rootNode);
  assert.equal(rootNode.props[0], 0n, 'RootNode value is 0 (document root)');
});

test('L7: References is present and empty', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const refs = findRoot(tree, 'References');
  assert.ok(refs, 'References node exists');
  assert.equal(refs.children.length, 0, 'References has no children');
});


function axisIntegers(globalSettings) {
  const p70 = findChild(globalSettings, 'Properties70');
  const out = {};
  for (const child of p70.children) {
    if (child.name !== 'P') continue;
    const name = child.props[0];
    out[name] = child.props[4];
  }
  return out;
}

test('M1: default axes (axisUp=Y, axisForward=Z) → canonical encoding', () => {
  const bytes = exportSimpleScene();
  const tree = parseFBXTree(bytes);
  const gs = findRoot(tree, 'GlobalSettings');
  const axes = axisIntegers(gs);
  assert.equal(axes.UpAxis, 1);
  assert.equal(axes.UpAxisSign, 1);
  assert.equal(axes.FrontAxis, 2);
  assert.equal(axes.FrontAxisSign, -1);
  assert.equal(axes.CoordAxis, 0);
  assert.equal(axes.CoordAxisSign, -1);
});

test('M2: GlobalSettings.Version = 1000', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const gs = findRoot(tree, 'GlobalSettings');
  assert.equal(findChild(gs, 'Version').props[0], 1000);
});

test('M3: TimeMode encoding for fps=24, 30, 60', () => {
  for (const [fps, expectedMode] of [[24, 11], [30, 6], [60, 3]]) {
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
    const bytes = new FBXExporter().parseSync(scene, { fps });
    const gs = findRoot(parseFBXTree(bytes), 'GlobalSettings');
    const axes = axisIntegers(gs);
    assert.equal(axes.TimeMode, expectedMode, `fps=${fps} → TimeMode ${axes.TimeMode} (expected ${expectedMode})`);
  }
});

test('M4: UnitScaleFactor defaults to 1.0', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const gs = findRoot(tree, 'GlobalSettings');
  const p70 = findChild(gs, 'Properties70');
  const unit = p70.children.find((c) => c.props[0] === 'UnitScaleFactor');
  assert.ok(unit, 'UnitScaleFactor P record present');
  assert.equal(unit.props[4], 1.0);
});


test('N1: Definitions has GlobalSettings ObjectType entry (registers it always)', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const defs = findRoot(tree, 'Definitions');
  const objTypes = findChildren(defs, 'ObjectType');
  const names = objTypes.map((o) => o.props[0]);
  assert.ok(names.includes('GlobalSettings'),
    `Definitions ObjectType list: ${JSON.stringify(names)} — must include GlobalSettings`);
});

test('N2: Definitions.Count == sum of all ObjectType.Count values', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const defs = findRoot(tree, 'Definitions');
  const totalCount = findChild(defs, 'Count').props[0];
  const objTypes = findChildren(defs, 'ObjectType');
  let sum = 0;
  for (const ot of objTypes) {
    sum += findChild(ot, 'Count').props[0];
  }
  assert.equal(totalCount, sum,
    `Definitions.Count=${totalCount}, sum of ObjectType.Count=${sum}`);
});

test('N3: Each ObjectType has its Count + (optional) PropertyTemplate child', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const defs = findRoot(tree, 'Definitions');
  for (const ot of findChildren(defs, 'ObjectType')) {
    assert.ok(findChild(ot, 'Count'), `ObjectType '${ot.props[0]}' missing Count`);
  }
});

test('N4: Geometry ObjectType uses PropertyTemplate "FbxMesh"', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const defs = findRoot(tree, 'Definitions');
  const geom = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'Geometry');
  assert.ok(geom, 'Geometry ObjectType present');
  const tmpl = findChild(geom, 'PropertyTemplate');
  assert.ok(tmpl);
  assert.equal(tmpl.props[0], 'FbxMesh');
});

test('N5: Model ObjectType uses PropertyTemplate "FbxNode"', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const defs = findRoot(tree, 'Definitions');
  const model = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'Model');
  assert.ok(model, 'Model ObjectType present');
  const tmpl = findChild(model, 'PropertyTemplate');
  assert.ok(tmpl);
  assert.equal(tmpl.props[0], 'FbxNode');
});

test('N6: PropertyTemplate Properties70 contains expected default values', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const defs = findRoot(tree, 'Definitions');
  const model = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'Model');
  const tmpl = findChild(model, 'PropertyTemplate');
  const p70 = findChild(tmpl, 'Properties70');
  const lclScaling = p70.children.find((c) => c.props[0] === 'Lcl Scaling');
  assert.ok(lclScaling);
  assert.equal(lclScaling.props[1], 'Lcl Scaling');
  assert.equal(lclScaling.props[4], 1);
  assert.equal(lclScaling.props[5], 1);
  assert.equal(lclScaling.props[6], 1);
});


test('O1: every P record has at least 4 strings (name, type1, type2/label, flags)', () => {
  const tree = parseFBXTree(exportSimpleScene());

  function checkP70Recursively(node) {
    if (node.name === 'P') {
      assert.ok(node.props.length >= 4, `P record has ${node.props.length} props, need ≥ 4`);
      for (let i = 0; i < 4; i++) {
        assert.equal(typeof node.props[i], 'string',
          `P prop ${i} should be string, got ${typeof node.props[i]} for ${JSON.stringify(node.props[0])}`);
      }
    }
    for (const child of node.children) checkP70Recursively(child);
  }
  for (const root of tree) checkP70Recursively(root);
});

test('O2: compound property names use "Group|Key" syntax', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const hdr = findRoot(tree, 'FBXHeaderExtension');
  const sceneInfo = findChild(hdr, 'SceneInfo');
  const p70 = findChild(sceneInfo, 'Properties70');
  const names = p70.children
    .filter((c) => c.name === 'P')
    .map((c) => c.props[0]);
  assert.ok(names.includes('Original'),       'parent compound "Original" emitted');
  assert.ok(names.includes('Original|ApplicationVendor'), 'child uses pipe syntax');
});


test('P1: Model ObjectType.Count equals number of Object3Ds we wrote', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  scene.add(g);
  const tree = parseFBXTree(new FBXExporter().parseSync(scene));
  const defs = findRoot(tree, 'Definitions');
  const model = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'Model');
  assert.equal(findChild(model, 'Count').props[0], 3, 'expected 3 Model users');
});

test('P2: Geometry user count counts UNIQUE BufferGeometries, not Meshes', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BoxGeometry();
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
    m.position.x = i;
    scene.add(m);
  }
  const tree = parseFBXTree(new FBXExporter().parseSync(scene));
  const defs = findRoot(tree, 'Definitions');
  const geomOT = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'Geometry');
  assert.equal(findChild(geomOT, 'Count').props[0], 1, 'shared geometry → 1 Geometry user');
});

test('P3: Material user count counts UNIQUE materials, not slots', () => {
  const scene = new THREE.Scene();
  const matA = new THREE.MeshStandardMaterial();
  const matB = new THREE.MeshStandardMaterial();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), [matA, matA, matB]));
  const tree = parseFBXTree(new FBXExporter().parseSync(scene));
  const defs = findRoot(tree, 'Definitions');
  const matOT = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'Material');
  assert.equal(findChild(matOT, 'Count').props[0], 2);
});


test('Q1: empty geometry (no triangles) does not crash and produces valid Definitions', () => {
  const scene = new THREE.Scene();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  geom.setIndex([]);
  scene.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial()));
  const bytes = new FBXExporter().parseSync(scene);
  const tree = parseFBXTree(bytes);
  assert.ok(findRoot(tree, 'Definitions'), 'Definitions section present');
});


test('R1: mixed Group + Mesh scene emits NodeAttribute ObjectType for Null', () => {
  const scene = new THREE.Scene();
  const g = new THREE.Group();
  scene.add(g);
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  const tree = parseFBXTree(new FBXExporter().parseSync(scene));
  const defs = findRoot(tree, 'Definitions');
  const names = findChildren(defs, 'ObjectType').map((o) => o.props[0]);
  assert.ok(names.includes('NodeAttribute'),
    `expected ObjectType "NodeAttribute" for the empty Group, got ${JSON.stringify(names)}`);
  const naOT = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'NodeAttribute');
  const tmpl = findChild(naOT, 'PropertyTemplate');
  assert.equal(tmpl.props[0], 'FbxNull');
});


test('S1: p_object property emits no value props (only the 4 strings)', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const defs = findRoot(tree, 'Definitions');
  const model = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'Model');
  const tmpl = findChild(model, 'PropertyTemplate');
  const p70 = findChild(tmpl, 'Properties70');
  const lookAt = p70.children.find((c) => c.props[0] === 'LookAtProperty');
  assert.ok(lookAt, 'LookAtProperty present in Model template');
  assert.equal(lookAt.props.length, 4, `expected 4 props (name+type+subtype+flags), got ${lookAt.props.length}`);
  assert.equal(lookAt.props[1], 'object', 'type1 = "object"');
});

test('S2: Documents.Document.Properties70 SourceObject is a p_object record', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const doc = findChild(findRoot(tree, 'Documents'), 'Document');
  const p70 = findChild(doc, 'Properties70');
  const srcObj = p70.children.find((c) => c.props[0] === 'SourceObject');
  assert.ok(srcObj, 'SourceObject prop present');
  assert.equal(srcObj.props.length, 4, 'no value after the 4 strings');
});


test('T1: FBX 7500 produces a parseable tree end-to-end with all M2 invariants', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  const bytes = new FBXExporter().parseSync(scene, { version: 7500 });
  const tree = parseFBXTree(bytes);
  for (const expected of ['FBXHeaderExtension', 'GlobalSettings', 'Documents', 'Definitions', 'Objects', 'Connections']) {
    assert.ok(findRoot(tree, expected), `${expected} present in FBX 7500 output`);
  }
  assert.equal(findChild(findRoot(tree, 'FBXHeaderExtension'), 'FBXVersion').props[0], 7500);
});


test('U1: animatable-but-not-animated property emits flag "A"', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const defs = findRoot(tree, 'Definitions');
  const model = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'Model');
  const tmpl = findChild(model, 'PropertyTemplate');
  const p70 = findChild(tmpl, 'Properties70');
  const lclT = p70.children.find((c) => c.props[0] === 'Lcl Translation');
  assert.equal(lclT.props[3], 'A', `flag = ${JSON.stringify(lclT.props[3])}`);
});

test('U2: non-animatable property emits empty flag', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const gs = findRoot(tree, 'GlobalSettings');
  const p70 = findChild(gs, 'Properties70');
  const upAxis = p70.children.find((c) => c.props[0] === 'UpAxis');
  assert.equal(upAxis.props[3], '', `flag = ${JSON.stringify(upAxis.props[3])}`);
});


test('V1: GlobalSettings Properties70 keys appear in order', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const gs = findRoot(tree, 'GlobalSettings');
  const p70 = findChild(gs, 'Properties70');
  const names = p70.children.filter((c) => c.name === 'P').map((c) => c.props[0]);
  const expected = [
    'UpAxis', 'UpAxisSign', 'FrontAxis', 'FrontAxisSign', 'CoordAxis', 'CoordAxisSign',
    'OriginalUpAxis', 'OriginalUpAxisSign',
    'UnitScaleFactor', 'OriginalUnitScaleFactor',
    'AmbientColor', 'DefaultCamera',
    'TimeMode', 'TimeSpanStart', 'TimeSpanStop', 'CustomFrameRate',
  ];
  assert.deepEqual(names, expected, `GlobalSettings prop order: ${JSON.stringify(names)}`);
});


test('W1: Connections section contains only C children, each with type/src/dst', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const conns = findRoot(tree, 'Connections');
  assert.ok(conns);
  for (const c of conns.children) {
    assert.equal(c.name, 'C', `unexpected child '${c.name}' in Connections`);
    assert.ok(c.props.length >= 3, `C has ${c.props.length} props, need ≥ 3`);
    assert.equal(typeof c.props[0], 'string');
    assert.equal(typeof c.props[1], 'bigint');
    assert.equal(typeof c.props[2], 'bigint');
  }
});


test('X1: Takes section has a Current empty-string child', () => {
  const tree = parseFBXTree(exportSimpleScene());
  const takes = findRoot(tree, 'Takes');
  assert.ok(takes);
  const current = findChild(takes, 'Current');
  assert.ok(current, 'Takes.Current present');
  assert.equal(current.props[0], '');
});


test('Y1: UidRegistry never returns 0 even if hash naturally collides with 0', () => {
  const reg = new UidRegistry();
  for (let i = 0; i < 200; i++) {
    const u = reg.get(`uid-zero-stress-${i}`);
    assert.ok(u > 0n, `uid for 'uid-zero-stress-${i}' was ${u}`);
  }
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
