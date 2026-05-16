// M9: Texture embedding round-trip — DataTexture path via byte-level
// verification (avoiding the FBXLoader DOM-dependent image pipeline).
//
// Run: node test/m9-texture.test.mjs

import { strict as assert } from 'node:assert';
import { unzlibSync } from 'fflate';

globalThis.self = globalThis;

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { FBXExporter } = await import('../src/FBXExporter.js');
const { encodeRGBA8PNG } = await import('../src/data/textureEncoder.js');
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

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function makeRedDataTexture(name = 'red') {
  // 2×2 solid red, RGBA8.
  const data = new Uint8Array([
    255, 0, 0, 255,  255, 0, 0, 255,
    255, 0, 0, 255,  255, 0, 0, 255,
  ]);
  const t = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat);
  t.needsUpdate = true;
  t.name = name;
  return t;
}

function exportToTree(scene, options) {
  const bytes = new FBXExporter().parseSync(scene, options);
  return { bytes, tree: parseFBXTree(bytes) };
}

function getTextureNodes(tree) {
  return findRoot(tree, 'Objects').children.filter((c) => c.name === 'Texture');
}
function getVideoNodes(tree) {
  return findRoot(tree, 'Objects').children.filter((c) => c.name === 'Video');
}

// ============================================================================
// GA. PNG encoder unit tests
// ============================================================================

test('GA1: PNG signature bytes are emitted', () => {
  const png = encodeRGBA8PNG(new Uint8Array([0, 0, 0, 255]), 1, 1);
  assert.deepEqual(
    Array.from(png.slice(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG magic header',
  );
});

test('GA2: PNG has IHDR + IDAT + IEND chunks in order', () => {
  const png = encodeRGBA8PNG(new Uint8Array([255, 0, 0, 255]), 1, 1);
  // After signature, chunks are [u32 length][4 byte type][data][u32 crc].
  let off = 8;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const types = [];
  while (off < png.length) {
    const len = dv.getUint32(off, false);
    const type = new TextDecoder().decode(png.slice(off + 4, off + 8));
    types.push(type);
    off += 4 + 4 + len + 4;
  }
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
});

test('GA3: PNG IHDR encodes width, height, RGBA (color type 6)', () => {
  const png = encodeRGBA8PNG(new Uint8Array(64 * 32 * 4), 64, 32);
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // IHDR starts at offset 8+4+4=16 (after 8 signature + 4 len + 4 type).
  const w = dv.getUint32(16, false);
  const h = dv.getUint32(20, false);
  const bitDepth   = png[24];
  const colorType  = png[25];
  assert.equal(w, 64);
  assert.equal(h, 32);
  assert.equal(bitDepth, 8);
  assert.equal(colorType, 6, 'RGBA');
});

// ============================================================================
// GB. End-to-end: DataTexture → Video.Content bytes
// ============================================================================

test('GB1: material with map: DataTexture produces 1 Texture + 1 Video', () => {
  const scene = new THREE.Scene();
  const tex = makeRedDataTexture();
  const mat = new THREE.MeshStandardMaterial({ map: tex });
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
  const { tree } = exportToTree(scene);
  assert.equal(getTextureNodes(tree).length, 1);
  assert.equal(getVideoNodes(tree).length, 1);
});

test('GB2: Video.Content carries a valid PNG byte stream', () => {
  const scene = new THREE.Scene();
  const mat = new THREE.MeshStandardMaterial({ map: makeRedDataTexture() });
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
  const { tree } = exportToTree(scene);
  const video = getVideoNodes(tree)[0];
  const content = findChild(video, 'Content');
  assert.ok(content, 'Content child present');
  const bytes = content.props[0];
  assert.ok(bytes instanceof Uint8Array);
  // Magic header
  assert.equal(bytes[0], 0x89);
  assert.equal(bytes[1], 0x50);  // P
  assert.equal(bytes[2], 0x4e);  // N
  assert.equal(bytes[3], 0x47);  // G
});

test('GB3: shared texture across two materials → 1 Texture + 1 Video, 2 OP edges', () => {
  const scene = new THREE.Scene();
  const tex = makeRedDataTexture('shared');
  const matA = new THREE.MeshStandardMaterial({ map: tex });
  const matB = new THREE.MeshStandardMaterial({ map: tex });
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), matA));
  const m2 = new THREE.Mesh(new THREE.BoxGeometry(), matB);
  m2.position.x = 2;
  scene.add(m2);
  const { tree } = exportToTree(scene);
  assert.equal(getTextureNodes(tree).length, 1, 'one Texture node (deduped)');
  assert.equal(getVideoNodes(tree).length, 1, 'one Video node (deduped)');
  // Count OP edges Texture → Material
  const conns = findRoot(tree, 'Connections').children.filter((c) => c.name === 'C');
  const texUid = getTextureNodes(tree)[0].props[0];
  const opEdges = conns.filter((c) => c.props[0] === 'OP' && c.props[1] === texUid);
  assert.equal(opEdges.length, 2, '2 OP edges (one per material)');
});

// ============================================================================
// GC. Connection graph
// ============================================================================

test('GC1: OO Video → Texture (FBXLoader walks children[0] of Texture to find Video)', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ map: makeRedDataTexture() }),
  ));
  const { tree } = exportToTree(scene);
  const textureUid = getTextureNodes(tree)[0].props[0];
  const videoUid = getVideoNodes(tree)[0].props[0];
  const conns = findRoot(tree, 'Connections').children.filter((c) => c.name === 'C');
  const edge = conns.find((c) =>
    c.props[0] === 'OO' && c.props[1] === videoUid && c.props[2] === textureUid);
  assert.ok(edge, 'OO Video → Texture edge present');
});

test('GC2: OP Texture → Material with the right slot name', () => {
  const scene = new THREE.Scene();
  const mat = new THREE.MeshStandardMaterial({
    map: makeRedDataTexture('diff'),
    normalMap: makeRedDataTexture('nrm'),
    emissiveMap: makeRedDataTexture('emi'),
  });
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
  const { tree } = exportToTree(scene);
  const objects = findRoot(tree, 'Objects');
  const materials = objects.children.filter((c) => c.name === 'Material');
  const matUid = materials[0].props[0];
  const conns = findRoot(tree, 'Connections').children.filter((c) => c.name === 'C');
  const opEdges = conns.filter((c) =>
    c.props[0] === 'OP' && c.props[2] === matUid);
  const rels = opEdges.map((c) => c.props[3]).sort();
  // Expect 3 OP edges with these relationship names.
  assert.ok(rels.includes('DiffuseColor'),   `map → DiffuseColor present (got: ${rels})`);
  assert.ok(rels.includes('NormalMap'),      'normalMap → NormalMap present');
  assert.ok(rels.includes('EmissiveColor'),  'emissiveMap → EmissiveColor present');
});

// ============================================================================
// GD. Texture metadata (UV wrap, transform)
// ============================================================================

test('GD1: WrapModeU/V reflect three.js wrapS/wrapT (Repeat=0, Clamp=1)', () => {
  const scene = new THREE.Scene();
  const tex = makeRedDataTexture();
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  scene.add(new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ map: tex }),
  ));
  const { tree } = exportToTree(scene);
  const textureNode = getTextureNodes(tree)[0];
  const p70 = findChild(textureNode, 'Properties70');
  const wU = p70.children.find((c) => c.props[0] === 'WrapModeU');
  const wV = p70.children.find((c) => c.props[0] === 'WrapModeV');
  // wrapS=Clamp → 1, wrapT=Repeat → 0 (FBXLoader.js:417).
  assert.equal(wU.props[4], 1, 'WrapModeU = Clamp');
  assert.equal(wV.props[4], 0, 'WrapModeV = Repeat');
});

test('GD2: Texture Translation + Scaling reflect three.js offset + repeat', () => {
  const scene = new THREE.Scene();
  const tex = makeRedDataTexture();
  tex.offset.set(0.25, 0.5);
  tex.repeat.set(2, 3);
  scene.add(new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ map: tex }),
  ));
  const { tree } = exportToTree(scene);
  const textureNode = getTextureNodes(tree)[0];
  const p70 = findChild(textureNode, 'Properties70');
  const tr = p70.children.find((c) => c.props[0] === 'Translation');
  const sc = p70.children.find((c) => c.props[0] === 'Scaling');
  // P record for p_vector_3d: [name, type, subtype, flags, x, y, z]
  assert.equal(tr.props[4], 0.25);
  assert.equal(tr.props[5], 0.5);
  assert.equal(sc.props[4], 2);
  assert.equal(sc.props[5], 3);
});

// ============================================================================
// GE. Texture metadata required by FBXLoader (FileName + Type)
// ============================================================================

test('GE1: Texture has Type="TextureVideoClip" + Version=202 (Blender invariants)', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ map: makeRedDataTexture() }),
  ));
  const { tree } = exportToTree(scene);
  const textureNode = getTextureNodes(tree)[0];
  assert.equal(findChild(textureNode, 'Type').props[0],    'TextureVideoClip');
  assert.equal(findChild(textureNode, 'Version').props[0], 202);
});

test('GE2: FileName has a recognised extension (.png) — FBXLoader uses it to pick the loader', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ map: makeRedDataTexture() }),
  ));
  const { tree } = exportToTree(scene);
  const textureNode = getTextureNodes(tree)[0];
  const fn = findChild(textureNode, 'FileName').props[0];
  assert.ok(fn.endsWith('.png'), `FileName: ${fn}`);
});

test('GE3: Video has Type="Clip" + Filename + RelativeFilename + UseMipMap (no Properties70.Version field)', () => {
  // Blender intentionally omits Version on Video (line 1771 has a "XXX No Version???" comment).
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ map: makeRedDataTexture() }),
  ));
  const { tree } = exportToTree(scene);
  const videoNode = getVideoNodes(tree)[0];
  assert.equal(findChild(videoNode, 'Type').props[0], 'Clip');
  assert.ok(findChild(videoNode, 'Filename'),         'Filename present');
  assert.ok(findChild(videoNode, 'RelativeFilename'), 'RelativeFilename present');
  assert.ok(findChild(videoNode, 'UseMipMap'),        'UseMipMap present');
});

// ============================================================================
// GF. embedTextures: false skips Content but keeps Texture/Video nodes
// ============================================================================

test('GF1: embedTextures: false produces Texture+Video without Content', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ map: makeRedDataTexture() }),
  ));
  const { tree } = exportToTree(scene, { embedTextures: false });
  assert.equal(getTextureNodes(tree).length, 1, 'Texture node still present');
  const video = getVideoNodes(tree)[0];
  assert.ok(video, 'Video node still present');
  // Content child should NOT be there.
  assert.ok(!findChild(video, 'Content'), 'no Content when embedTextures=false');
});

// ============================================================================
// GG. parseAsync path
// ============================================================================

test('GG1: parseAsync resolves with bytes for DataTexture', async () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ map: makeRedDataTexture() }),
  ));
  const bytes = await new FBXExporter().parseAsync(scene);
  assert.ok(bytes instanceof Uint8Array);
  // Verify the file contains a non-empty Video.Content.
  const tree = parseFBXTree(bytes);
  const content = findChild(getVideoNodes(tree)[0], 'Content');
  assert.ok(content.props[0].length > 8, 'Content has bytes');
});

// ============================================================================
// GH. Definitions counts
// ============================================================================

test('GH1: Definitions registers Texture template with users matching count', () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ map: makeRedDataTexture('a') })));
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ map: makeRedDataTexture('b') })));
  const { tree } = exportToTree(scene);
  const defs = findRoot(tree, 'Definitions');
  const texOT = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'Texture');
  const vidOT = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'Video');
  assert.equal(findChild(texOT, 'Count').props[0], 2);
  assert.equal(findChild(vidOT, 'Count').props[0], 2);
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
