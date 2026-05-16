
import { strict as assert } from 'node:assert';
import { unzlibSync } from 'fflate';

globalThis.self = globalThis;

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { FBXExporter } = await import('../src/FBXExporter.js');
import * as DT from '../src/core/dataTypes.js';

let passes = 0, fails = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${name}`); console.error('       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); }
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

function buildTexturedScene({ slot = 'map', wrapS, wrapT } = {}) {
  const data = new Uint8Array([255, 0, 0, 255]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  tex.name = 'tex1';
  tex.needsUpdate = true;
  if (wrapS !== undefined) tex.wrapS = wrapS;
  if (wrapT !== undefined) tex.wrapT = wrapT;
  const mat = new THREE.MeshStandardMaterial();
  mat[slot] = tex;
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
  return { scene, tex };
}

function exportToTree(scene, options) {
  const bytes = new FBXExporter().parseSync(scene, options);
  return { bytes, tree: parseFBXTree(bytes) };
}

function getTextureNode(tree) {
  return findRoot(tree, 'Objects').children.find((c) => c.name === 'Texture');
}
function getVideoNode(tree) {
  return findRoot(tree, 'Objects').children.find((c) => c.name === 'Video');
}


test('HA1: Texture top-level child order exactly', () => {
  const { scene } = buildTexturedScene();
  const tex = getTextureNode(exportToTree(scene).tree);
  const names = tex.children.map((c) => c.name);
  const expected = [
    'Type', 'Version', 'TextureName', 'Media', 'FileName', 'RelativeFilename',
    'Properties70',
  ];
  assert.deepEqual(names, expected, `Texture children: ${JSON.stringify(names)}`);
});


test('HB1: TextureName uses texture.name (round-trips through FBXLoader.attrName)', () => {
  const { scene } = buildTexturedScene({ slot: 'map' });
  const tex = getTextureNode(exportToTree(scene).tree);
  const textureName = findChild(tex, 'TextureName').props[0];
  assert.ok(textureName.startsWith('tex1\x00\x01'),
    `TextureName: ${JSON.stringify(textureName)} — expected to start with "tex1"`);
});

test('HB2: TextureName independent of slot when same texture used elsewhere', () => {
  const { scene } = buildTexturedScene({ slot: 'normalMap' });
  const tex = getTextureNode(exportToTree(scene).tree);
  const textureName = findChild(tex, 'TextureName').props[0];
  assert.ok(textureName.startsWith('tex1\x00\x01'),
    `TextureName: ${JSON.stringify(textureName)}`);
});

test('HB3: Texture attrName equals TextureName (both encode texture.name)', () => {
  const { scene } = buildTexturedScene({ slot: 'emissiveMap' });
  const tex = getTextureNode(exportToTree(scene).tree);
  const attrName = tex.props[1];
  const textureName = findChild(tex, 'TextureName').props[0];
  assert.equal(attrName, textureName);
  assert.ok(attrName.startsWith('tex1\x00\x01'),
    `attrName: ${JSON.stringify(attrName)}`);
});

test('HB4: Media uses texture.name + "Video" class', () => {
  const { scene } = buildTexturedScene({ slot: 'map' });
  const tex = getTextureNode(exportToTree(scene).tree);
  const media = findChild(tex, 'Media').props[0];
  assert.ok(media.startsWith('tex1\x00\x01'),
    `Media: ${JSON.stringify(media)} — expected to start with "tex1"`);
  assert.ok(media.endsWith('\x00\x01Video'),
    `Media should end with "\\x00\\x01Video": ${JSON.stringify(media)}`);
});


test('HC1: Texture Properties70 includes all base fields in order', () => {
  const { scene } = buildTexturedScene({
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  const tex = getTextureNode(exportToTree(scene).tree);
  const p70 = findChild(tex, 'Properties70');
  const names = p70.children.filter((c) => c.name === 'P').map((c) => c.props[0]);

  const required = ['AlphaSource', 'PremultiplyAlpha', 'CurrentMappingType',
                    'WrapModeU', 'WrapModeV', 'Translation', 'Rotation',
                    'Scaling', 'UseMaterial', 'UseMipMap'];
  for (const r of required) {
    assert.ok(names.includes(r), `${r} present in P70 (${JSON.stringify(names)})`);
  }
  for (let i = 1; i < required.length; i++) {
    const aIdx = names.indexOf(required[i - 1]);
    const bIdx = names.indexOf(required[i]);
    assert.ok(bIdx > aIdx, `${required[i]} should come AFTER ${required[i - 1]}`);
  }
});

test('HC2: AlphaSource = 2 (Black/alpha) when texture has image bytes', () => {
  const { scene } = buildTexturedScene();
  const tex = getTextureNode(exportToTree(scene).tree);
  const p70 = findChild(tex, 'Properties70');
  const alpha = p70.children.find((c) => c.props[0] === 'AlphaSource');
  assert.equal(alpha.props[4], 2, 'AlphaSource = 2 for RGBA PNG');
});

test('HC3: CurrentMappingType = 0 (UV) for normal three.js textures', () => {
  const { scene } = buildTexturedScene();
  const tex = getTextureNode(exportToTree(scene).tree);
  const p70 = findChild(tex, 'Properties70');
  const m = p70.children.find((c) => c.props[0] === 'CurrentMappingType');
  assert.equal(m.props[4], 0);
});

test('HC4: WrapModeU/V encoding: Repeat=0, Clamp=1 (matches FBXLoader.js:417)', () => {
  for (const [wrap, expected] of [
    [THREE.RepeatWrapping, 0],
    [THREE.ClampToEdgeWrapping, 1],
    [THREE.MirroredRepeatWrapping, 0],
  ]) {
    const { scene } = buildTexturedScene({ wrapS: wrap, wrapT: wrap });
    const tex = getTextureNode(exportToTree(scene).tree);
    const p70 = findChild(tex, 'Properties70');
    const u = p70.children.find((c) => c.props[0] === 'WrapModeU').props[4];
    const v = p70.children.find((c) => c.props[0] === 'WrapModeV').props[4];
    assert.equal(u, expected, `wrap=${wrap}, U=${u}, expected ${expected}`);
    assert.equal(v, expected);
  }
});

test('HC5: UseMaterial = true; UseMipMap = false', () => {
  const { scene } = buildTexturedScene();
  const tex = getTextureNode(exportToTree(scene).tree);
  const p70 = findChild(tex, 'Properties70');
  const um = p70.children.find((c) => c.props[0] === 'UseMaterial');
  const mm = p70.children.find((c) => c.props[0] === 'UseMipMap');
  assert.equal(um.props[4], 1);
  assert.equal(mm.props[4], 0);
});


test('HD1: Video child order (Type, Properties70, UseMipMap, Filename, RelativeFilename, Content)', () => {
  const { scene } = buildTexturedScene();
  const video = getVideoNode(exportToTree(scene).tree);
  const names = video.children.map((c) => c.name);
  assert.deepEqual(names, [
    'Type', 'Properties70', 'UseMipMap', 'Filename', 'RelativeFilename', 'Content',
  ], `Video children: ${JSON.stringify(names)}`);
});

test('HD2: Video.UseMipMap is an int32 child (NOT in Properties70)', () => {
  const { scene } = buildTexturedScene();
  const video = getVideoNode(exportToTree(scene).tree);
  const um = findChild(video, 'UseMipMap');
  assert.ok(um);
  assert.equal(um.props.length, 1);
  assert.equal(typeof um.props[0], 'number', 'int32 value, not a P record');
});

test('HD3: Video Content is a BYTES property (not a STRING)', () => {
  const { scene } = buildTexturedScene();
  const video = getVideoNode(exportToTree(scene).tree);
  const content = findChild(video, 'Content');
  assert.ok(content.props[0] instanceof Uint8Array);
  assert.equal(content.props[0][0], 0x89);
});


test('HE1: AlphaSource is 0 (None) when no Content is embedded', () => {
  const { scene } = buildTexturedScene();
  const tex = getTextureNode(exportToTree(scene, { embedTextures: false }).tree);
  const p70 = findChild(tex, 'Properties70');
  const alpha = p70.children.find((c) => c.props[0] === 'AlphaSource');
  assert.equal(alpha.props[4], 0,
    'AlphaSource = 0 (None) when no Content embedded');
});


test('HF1: Scaling = three.js .repeat', () => {
  const { scene, tex } = buildTexturedScene();
  tex.repeat.set(3, 5);
  const texNode = getTextureNode(exportToTree(scene).tree);
  const p70 = findChild(texNode, 'Properties70');
  const sc = p70.children.find((c) => c.props[0] === 'Scaling');
  assert.equal(sc.props[4], 3, 'Scaling.x = repeat.x (NOT 1/repeat.x)');
  assert.equal(sc.props[5], 5, 'Scaling.y = repeat.y');
});

test('HF2: Translation = three.js .offset (no scaling)', () => {
  const { scene, tex } = buildTexturedScene();
  tex.offset.set(0.33, 0.66);
  const texNode = getTextureNode(exportToTree(scene).tree);
  const p70 = findChild(texNode, 'Properties70');
  const tr = p70.children.find((c) => c.props[0] === 'Translation');
  assert.ok(Math.abs(tr.props[4] - 0.33) < 1e-6);
  assert.ok(Math.abs(tr.props[5] - 0.66) < 1e-6);
});

test('HF3: Rotation Z component = -texture.rotation', () => {
  const { scene, tex } = buildTexturedScene();
  tex.rotation = Math.PI / 4;
  const texNode = getTextureNode(exportToTree(scene).tree);
  const p70 = findChild(texNode, 'Properties70');
  const rot = p70.children.find((c) => c.props[0] === 'Rotation');
  assert.ok(Math.abs(rot.props[6] - (-Math.PI / 4)) < 1e-6,
    `Rotation.z: ${rot.props[6]} (expected ${-Math.PI / 4})`);
});


test('HG1: Video → Texture edge has src=Video, dst=Texture (FBXLoader walks Texture.children)', () => {
  const { scene } = buildTexturedScene();
  const tree = exportToTree(scene).tree;
  const texUid = getTextureNode(tree).props[0];
  const vidUid = getVideoNode(tree).props[0];
  const conns = findRoot(tree, 'Connections').children
    .filter((c) => c.name === 'C')
    .map((c) => ({ type: c.props[0], src: c.props[1], dst: c.props[2] }));
  const edge = conns.find((c) => c.src === vidUid && c.dst === texUid);
  assert.ok(edge);
  assert.equal(edge.type, 'OO');
});

test('HG2: Texture → Material edge is OP (not OO), with the right relationship', () => {
  const { scene } = buildTexturedScene({ slot: 'normalMap' });
  const tree = exportToTree(scene).tree;
  const texUid = getTextureNode(tree).props[0];
  const matUid = findRoot(tree, 'Objects').children.find((c) => c.name === 'Material').props[0];
  const conns = findRoot(tree, 'Connections').children
    .filter((c) => c.name === 'C')
    .map((c) => ({ type: c.props[0], src: c.props[1], dst: c.props[2], rel: c.props[3] }));
  const edge = conns.find((c) => c.src === texUid && c.dst === matUid);
  assert.ok(edge);
  assert.equal(edge.type, 'OP');
  assert.equal(edge.rel, 'NormalMap');
});


test('HH1: PNG CRC verifies for every chunk', () => {
  const { scene } = buildTexturedScene();
  const video = getVideoNode(exportToTree(scene).tree);
  const png = findChild(video, 'Content').props[0];

  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = (crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
    return (crc ^ 0xffffffff) >>> 0;
  }

  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8;
  while (off < png.length) {
    const len = dv.getUint32(off, false);
    const typeAndData = png.slice(off + 4, off + 8 + len);
    const claimedCrc = dv.getUint32(off + 8 + len, false);
    const computedCrc = crc32(typeAndData);
    assert.equal(claimedCrc, computedCrc, `CRC mismatch at chunk @${off}`);
    off += 4 + 4 + len + 4;
  }
});

test('HH2: PNG decodes back to the exact RGBA pixel values we wrote', () => {
  const scene = new THREE.Scene();
  const orig = new Uint8Array([
    0x11, 0x22, 0x33, 0xff,    0x44, 0x55, 0x66, 0xff,
    0x77, 0x88, 0x99, 0xff,    0xaa, 0xbb, 0xcc, 0xff,
  ]);
  const tex = new THREE.DataTexture(orig, 2, 2, THREE.RGBAFormat);
  tex.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({ map: tex });
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
  const png = findChild(getVideoNode(exportToTree(scene).tree), 'Content').props[0];

  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8, idatBytes = null;
  while (off < png.length) {
    const len = dv.getUint32(off, false);
    const type = new TextDecoder().decode(png.slice(off + 4, off + 8));
    if (type === 'IDAT') idatBytes = png.slice(off + 8, off + 8 + len);
    off += 4 + 4 + len + 4;
  }
  assert.ok(idatBytes, 'IDAT found');
  const decompressed = unzlibSync(idatBytes);

  const w = 2, h = 2;
  const stride = w * 4;
  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const filterByte = decompressed[y * (1 + stride)];
    assert.equal(filterByte, 0, `row ${y} filter type = None`);
    pixels.set(decompressed.subarray(y * (1 + stride) + 1, y * (1 + stride) + 1 + stride),
              y * stride);
  }
  assert.deepEqual(Array.from(pixels), Array.from(orig));
});


test('HI1: Texture ObjectType PropertyTemplate is "FbxFileTexture"', () => {
  const { scene } = buildTexturedScene();
  const tree = exportToTree(scene).tree;
  const defs = findRoot(tree, 'Definitions');
  const ot = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'Texture');
  const tmpl = findChild(ot, 'PropertyTemplate');
  assert.equal(tmpl.props[0], 'FbxFileTexture');
});

test('HI2: Video ObjectType PropertyTemplate is "FbxVideo"', () => {
  const { scene } = buildTexturedScene();
  const tree = exportToTree(scene).tree;
  const defs = findRoot(tree, 'Definitions');
  const ot = findChildren(defs, 'ObjectType').find((o) => o.props[0] === 'Video');
  const tmpl = findChild(ot, 'PropertyTemplate');
  assert.equal(tmpl.props[0], 'FbxVideo');
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
