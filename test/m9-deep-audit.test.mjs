// M9 deep audit — byte-level invariants for Texture + Video against Blender.
//
// Run: node test/m9-deep-audit.test.mjs

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

// ============================================================================
// HA. Texture node top-level children — order matches Blender exactly
// ============================================================================
//
// Blender (export_fbx_bin.py:1700-1705):
//   Type → Version → TextureName → Media → FileName → RelativeFilename
//   THEN Properties70 (via elem_properties)

test('HA1: Texture top-level child order matches Blender exactly', () => {
  const { scene } = buildTexturedScene();
  const tex = getTextureNode(exportToTree(scene).tree);
  // Collect children up to and including Properties70.
  const names = tex.children.map((c) => c.name);
  const expected = [
    'Type', 'Version', 'TextureName', 'Media', 'FileName', 'RelativeFilename',
    'Properties70',
  ];
  assert.deepEqual(names, expected, `Texture children: ${JSON.stringify(names)}`);
});

// ============================================================================
// HB. TextureName / attrName / Media use texture.name (not slot name)
// ============================================================================
//
// Choice of identifier:
//   - FBXLoader.js:406 sets `imported.name = textureNode.attrName` so
//     writing texture.name → perfect round-trip of the texture identifier.
//   - Blender writes its own Principled-BSDF socket name
//     ("base_color_texture") which is tool-internal. Three.js's slot
//     ("map", "normalMap") would be equally tool-specific. texture.name is
//     the user-set, tool-agnostic identifier and the right choice.
//   - Maya / Unreal display this in their texture browser, so a human-
//     readable name beats "map".

test('HB1: TextureName uses texture.name (round-trips through FBXLoader.attrName)', () => {
  const { scene } = buildTexturedScene({ slot: 'map' });
  const tex = getTextureNode(exportToTree(scene).tree);
  const textureName = findChild(tex, 'TextureName').props[0];
  // texture.name is "tex1" (set in buildTexturedScene).
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
  // Blender writes the same string for both (line 1697 + 1702).
  const { scene } = buildTexturedScene({ slot: 'emissiveMap' });
  const tex = getTextureNode(exportToTree(scene).tree);
  const attrName = tex.props[1];
  const textureName = findChild(tex, 'TextureName').props[0];
  assert.equal(attrName, textureName);
  assert.ok(attrName.startsWith('tex1\x00\x01'),
    `attrName: ${JSON.stringify(attrName)}`);
});

test('HB4: Media uses texture.name + "Video" class', () => {
  // Blender writes `fbx_name_class(img.name, "Video")` (line 1703). Image
  // name here = texture.name in three.js parlance.
  const { scene } = buildTexturedScene({ slot: 'map' });
  const tex = getTextureNode(exportToTree(scene).tree);
  const media = findChild(tex, 'Media').props[0];
  assert.ok(media.startsWith('tex1\x00\x01'),
    `Media: ${JSON.stringify(media)} — expected to start with "tex1"`);
  assert.ok(media.endsWith('\x00\x01Video'),
    `Media should end with "\\x00\\x01Video": ${JSON.stringify(media)}`);
});

// ============================================================================
// HC. Texture Properties70 — Blender field set + order
// ============================================================================
//
// Blender (lines 1737-1751):
//   AlphaSource, PremultiplyAlpha, CurrentMappingType, [UVSet],
//   WrapModeU, WrapModeV, Translation, Rotation, Scaling,
//   UseMaterial, UseMipMap

test('HC1: Texture Properties70 includes all Blender base fields in order', () => {
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
  // Verify ordering pairwise.
  for (let i = 1; i < required.length; i++) {
    const aIdx = names.indexOf(required[i - 1]);
    const bIdx = names.indexOf(required[i]);
    assert.ok(bIdx > aIdx, `${required[i]} should come AFTER ${required[i - 1]}`);
  }
});

test('HC2: AlphaSource = 2 (Black/alpha) when texture has image bytes', () => {
  // Blender (lines 1707-1713): AlphaSource is 0 (None) unless image has
  // alpha_mode != "NONE", then 2 (Black, i.e. alpha channel).
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
    [THREE.MirroredRepeatWrapping, 0],  // No FBX mirror equivalent; map to Repeat
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

test('HC5: UseMaterial = true; UseMipMap = false (Blender defaults)', () => {
  const { scene } = buildTexturedScene();
  const tex = getTextureNode(exportToTree(scene).tree);
  const p70 = findChild(tex, 'Properties70');
  const um = p70.children.find((c) => c.props[0] === 'UseMaterial');
  const mm = p70.children.find((c) => c.props[0] === 'UseMipMap');
  assert.equal(um.props[4], 1);  // bool true is written as int 1
  assert.equal(mm.props[4], 0);
});

// ============================================================================
// HD. Video node — Blender writes Type + Properties70 + UseMipMap +
// Filename + RelativeFilename + Content (in that order)
// ============================================================================

test('HD1: Video child order matches Blender (Type, Properties70, UseMipMap, Filename, RelativeFilename, Content)', () => {
  const { scene } = buildTexturedScene();
  const video = getVideoNode(exportToTree(scene).tree);
  const names = video.children.map((c) => c.name);
  assert.deepEqual(names, [
    'Type', 'Properties70', 'UseMipMap', 'Filename', 'RelativeFilename', 'Content',
  ], `Video children: ${JSON.stringify(names)}`);
});

test('HD2: Video.UseMipMap is an int32 child (NOT in Properties70) — matches Blender', () => {
  // Blender: elem_data_single_int32(fbx_vid, b"UseMipMap", 0) — top-level
  // int32, not a P record. Texture has UseMipMap inside Properties70 as
  // p_bool, but Video has it OUTSIDE as int32. Asymmetry inherited from
  // Blender (export_fbx_bin.py:1751 + 1778).
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
  // First 4 bytes are PNG signature start (we already verified the full
  // signature in m9-texture; here we want to confirm BYTES not STRING).
  assert.equal(content.props[0][0], 0x89);
});

// ============================================================================
// HE. AlphaSource semantics when embedTextures: false
// ============================================================================

test('HE1: AlphaSource is 0 (None) when no Content is embedded', () => {
  // When embedTextures: false, we don't write Content. The texture might
  // still be an alpha-bearing PNG (the external file would carry alpha),
  // but Blender's logic (line 1707-1713) uses img.alpha_mode which we
  // can't read at our level — best we can do is hint "no alpha" when
  // no content is written, leaving the external image's natural alpha
  // handling to the importer.
  const { scene } = buildTexturedScene();
  const tex = getTextureNode(exportToTree(scene, { embedTextures: false }).tree);
  const p70 = findChild(tex, 'Properties70');
  const alpha = p70.children.find((c) => c.props[0] === 'AlphaSource');
  assert.equal(alpha.props[4], 0,
    'AlphaSource = 0 (None) when no Content embedded');
});

// ============================================================================
// HF. Three.js texture transform → FBX P70 layout
// ============================================================================
//
// Blender (lines 1745-1748):
//   Translation = (tx, ty, 0)
//   Rotation    = (-rx, -ry, -rz)     ← negated
//   Scaling     = (1/sx, 1/sy, 1/sz)  ← inverted
//
// For three.js: texture.offset is a Vector2, texture.repeat is a Vector2,
// texture.rotation is a scalar (radians around the texture center).
//
// FBXLoader 0.184 reads:
//   Translation.value → texture.offset.{x,y}    (lines 429-435)
//   Scaling.value     → texture.repeat.{x,y}    (lines 420-427)
//   (Rotation: NOT read by FBXLoader — silently dropped on import)
//
// We write Scaling = repeat directly (no inversion) so the three.js→FBX→
// three.js round-trip lands the same `repeat` value. This differs from
// Blender semantically but matches FBXLoader's read convention exactly.

test('HF1: Scaling = three.js .repeat (NO inversion vs Blender)', () => {
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

test('HF3: Rotation Z component = -texture.rotation (matches Blender negation)', () => {
  const { scene, tex } = buildTexturedScene();
  tex.rotation = Math.PI / 4;
  const texNode = getTextureNode(exportToTree(scene).tree);
  const p70 = findChild(texNode, 'Properties70');
  const rot = p70.children.find((c) => c.props[0] === 'Rotation');
  // Blender writes (-rx, -ry, -rz). three.js rotation is scalar — Z only.
  assert.ok(Math.abs(rot.props[6] - (-Math.PI / 4)) < 1e-6,
    `Rotation.z: ${rot.props[6]} (expected ${-Math.PI / 4})`);
});

// ============================================================================
// HG. Connection direction integrity
// ============================================================================
//
// Blender (lines 3149-3159):
//   OP  Texture → Material   (texture is FROM)
//   OO  Video   → Texture    (video is FROM)
//
// FBXLoader's loadTexture (FBXLoader.js:458):
//   const children = connections.get(textureNode.id).children;
//   fileName = images[ children[ 0 ].ID ];
// So Video must be a CHILD of Texture in connection terms — which means
// the OO edge is from Video (src) to Texture (dst).

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

// ============================================================================
// HH. PNG byte-level invariants beyond the basic round-trip
// ============================================================================

test('HH1: PNG CRC verifies for every chunk', () => {
  const { scene } = buildTexturedScene();
  const video = getVideoNode(exportToTree(scene).tree);
  const png = findChild(video, 'Content').props[0];

  // Walk PNG chunks and recompute CRC for each, comparing to the embedded
  // value. A miscomputed CRC would silently break decoders.
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
  let off = 8;  // skip signature
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
  // Round-trip our own PNG through the standard PNG decoding pipeline
  // (zlib inflate + unfiltering) to confirm the bytes are decodable.
  const scene = new THREE.Scene();
  // 2x2 with distinguishable values
  const orig = new Uint8Array([
    0x11, 0x22, 0x33, 0xff,    0x44, 0x55, 0x66, 0xff,
    0x77, 0x88, 0x99, 0xff,    0xaa, 0xbb, 0xcc, 0xff,
  ]);
  const tex = new THREE.DataTexture(orig, 2, 2, THREE.RGBAFormat);
  tex.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({ map: tex });
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
  const png = findChild(getVideoNode(exportToTree(scene).tree), 'Content').props[0];

  // Decode: locate IDAT, inflate, unfilter (PNG filter type 0 per scanline).
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

  // Strip filter bytes: 2 rows × (1 + 8 bytes per row) = 18 bytes.
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

// ============================================================================
// HI. Definitions registers Texture + Video with correct propTypeName
// ============================================================================

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
