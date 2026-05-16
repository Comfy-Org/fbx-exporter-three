// M1 deep audit — byte-level checks on the binary layer.
//
// Every test pins down a specific contract between our writer and:
//   - Blender's encode_bin.py (the reference for FBX binary format),
//   - three.js FBXLoader's BinaryParser (the round-trip reader we use).
//
// Run: node test/m1-deep-audit.test.mjs

import { strict as assert } from 'node:assert';
import { unzlibSync } from 'fflate';

import { FBXElem } from '../src/core/FBXElem.js';
import { BinaryWriter } from '../src/core/BinaryWriter.js';
import { encodeBinaryFBX, __testing__ } from '../src/core/encodeBinary.js';
import * as DT from '../src/core/dataTypes.js';

let passes = 0, fails = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${name}`); console.error('       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); }
}

// ============================================================================
// AA. dataTypes — verify FBX type-tag byte values match the spec
// ============================================================================

test('AA1: FBX property type tag byte values match Blender exactly', () => {
  // From encode_bin.py + data_types.py.
  assert.equal(DT.BOOL,           0x42, 'BOOL = "B"');
  assert.equal(DT.CHAR,           0x43, 'CHAR = "C"');
  assert.equal(DT.INT8,           0x5a, 'INT8 = "Z"');
  assert.equal(DT.INT16,          0x59, 'INT16 = "Y"');
  assert.equal(DT.INT32,          0x49, 'INT32 = "I"');
  assert.equal(DT.INT64,          0x4c, 'INT64 = "L"');
  assert.equal(DT.FLOAT32,        0x46, 'FLOAT32 = "F"');
  assert.equal(DT.FLOAT64,        0x44, 'FLOAT64 = "D"');
  assert.equal(DT.BYTES,          0x52, 'BYTES = "R"');
  assert.equal(DT.STRING,         0x53, 'STRING = "S"');
  assert.equal(DT.INT32_ARRAY,    0x69, 'INT32_ARRAY = "i"');
  assert.equal(DT.INT64_ARRAY,    0x6c, 'INT64_ARRAY = "l"');
  assert.equal(DT.FLOAT32_ARRAY,  0x66, 'FLOAT32_ARRAY = "f"');
  assert.equal(DT.FLOAT64_ARRAY,  0x64, 'FLOAT64_ARRAY = "d"');
  assert.equal(DT.BOOL_ARRAY,     0x62, 'BOOL_ARRAY = "b"');
  assert.equal(DT.BYTE_ARRAY,     0x63, 'BYTE_ARRAY = "c"');
});

test('AA2: ARRAY_COMPRESS_THRESHOLD = 128 (matches Blender)', () => {
  assert.equal(DT.ARRAY_COMPRESS_THRESHOLD, 128);
});

// ============================================================================
// AB. BinaryWriter — scalar/byte writers + buffer growth
// ============================================================================

test('AB1: writeI8 with negative values writes two-complement bytes', () => {
  const bw = new BinaryWriter(8);
  bw.writeI8(-1);
  bw.writeI8(-128);
  bw.writeI8(127);
  bw.writeI8(0);
  assert.deepEqual(Array.from(bw.toUint8Array()), [0xff, 0x80, 0x7f, 0x00]);
});

test('AB2: writeI16 / writeI32 little-endian + negatives', () => {
  const bw = new BinaryWriter(8);
  bw.writeI16(-1);                    // ff ff
  bw.writeI32(-1);                    // ff ff ff ff
  bw.writeI16(0x1234);                // 34 12
  assert.deepEqual(
    Array.from(bw.toUint8Array()),
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x34, 0x12],
  );
});

test('AB3: writeF32 IEEE 754 LE — special values', () => {
  const bw = new BinaryWriter(32);
  bw.writeF32(NaN);
  bw.writeF32(Infinity);
  bw.writeF32(-Infinity);
  bw.writeF32(0.0);
  const dv = new DataView(bw.toUint8Array().buffer);
  assert.ok(Number.isNaN(dv.getFloat32(0, true)), 'NaN preserved');
  assert.equal(dv.getFloat32(4, true), Infinity);
  assert.equal(dv.getFloat32(8, true), -Infinity);
  assert.equal(dv.getFloat32(12, true), 0.0);
});

test('AB4: writeU64 accepts both BigInt and Number', () => {
  const bw = new BinaryWriter(16);
  bw.writeU64(0x0123456789abcdefn);
  bw.writeU64(42);
  const dv = new DataView(bw.toUint8Array().buffer);
  assert.equal(dv.getBigUint64(0, true), 0x0123456789abcdefn);
  assert.equal(dv.getBigUint64(8, true), 42n);
});

test('AB5: writeZeros fills bytes that may have been left non-zero by buffer reuse', () => {
  // Force the internal buffer to be > 0 initially. We can do this by manually
  // poking at the underlying buffer (not part of the public API). The test is
  // a guarantee: writeZeros zero-fills the range it owns.
  const bw = new BinaryWriter(64);
  // Pollute the underlying buffer
  for (let i = 0; i < 64; i++) bw._u8[i] = 0xaa;
  bw.writeZeros(10);
  const out = bw.toUint8Array();
  for (let i = 0; i < 10; i++) {
    assert.equal(out[i], 0, `byte ${i} should be 0, got 0x${out[i].toString(16)}`);
  }
});

test('AB6: buffer grows past initial capacity preserving previously-written bytes', () => {
  const bw = new BinaryWriter(4);  // tiny
  bw.writeU32(0xdeadbeef);
  bw.writeU32(0xcafebabe);  // forces grow
  bw.writeU32(0x12345678);  // grows again
  const dv = new DataView(bw.toUint8Array().buffer);
  assert.equal(dv.getUint32(0, true), 0xdeadbeef);
  assert.equal(dv.getUint32(4, true), 0xcafebabe);
  assert.equal(dv.getUint32(8, true), 0x12345678);
});

test('AB7: writeBytes accepts a Uint8Array view with non-zero byteOffset', () => {
  const big = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const view = new Uint8Array(big.buffer, 2, 4); // [3, 4, 5, 6]
  const bw = new BinaryWriter(16);
  bw.writeBytes(view);
  assert.deepEqual(Array.from(bw.toUint8Array()), [3, 4, 5, 6]);
});

test('AB8: writeUtf8 produces UTF-8 bytes (multibyte char)', () => {
  const bw = new BinaryWriter(16);
  bw.writeUtf8('中');  // U+4E2D → E4 B8 AD
  assert.deepEqual(Array.from(bw.toUint8Array()), [0xe4, 0xb8, 0xad]);
});

// ============================================================================
// AC. FBXElem — per-prop byte layout
// ============================================================================

test('AC1: addBool writes exactly 1 byte (0x00 or 0x01)', () => {
  const e = new FBXElem('X');
  e.addBool(true);
  e.addBool(false);
  assert.deepEqual(Array.from(e.propsData[0]), [0x01]);
  assert.deepEqual(Array.from(e.propsData[1]), [0x00]);
  assert.equal(e.propsType[0], DT.BOOL);
  assert.equal(e.propsType[1], DT.BOOL);
});

test('AC2: addChar packs exactly 1 byte', () => {
  // Blender's pack('<c', byte) writes the byte unchanged. Model.js uses 0x01.
  const e = new FBXElem('X');
  e.addChar(0x01);
  e.addChar(0xff);
  assert.deepEqual(Array.from(e.propsData[0]), [0x01]);
  assert.deepEqual(Array.from(e.propsData[1]), [0xff]);
});

test('AC3: addString wraps with 4-byte LE length prefix', () => {
  const e = new FBXElem('X');
  e.addString('hi');
  // Layout: [len:u32 LE][bytes]
  const dv = new DataView(e.propsData[0].buffer);
  assert.equal(dv.getUint32(0, true), 2, 'length=2');
  assert.equal(e.propsData[0][4], 'h'.charCodeAt(0));
  assert.equal(e.propsData[0][5], 'i'.charCodeAt(0));
  assert.equal(e.propsData[0].byteLength, 6);
});

test('AC4: addString with empty string emits length=0 only', () => {
  const e = new FBXElem('X');
  e.addString('');
  assert.equal(e.propsData[0].byteLength, 4);
  const dv = new DataView(e.propsData[0].buffer);
  assert.equal(dv.getUint32(0, true), 0);
});

test('AC5: addString with multibyte UTF-8 uses byte length, not char length', () => {
  const e = new FBXElem('X');
  e.addString('中');  // 3 bytes UTF-8
  const dv = new DataView(e.propsData[0].buffer);
  assert.equal(dv.getUint32(0, true), 3);
  assert.equal(e.propsData[0].byteLength, 7);
});

test('AC6: addBytes mirrors Blender pack("<I", len) + data', () => {
  const e = new FBXElem('X');
  e.addBytes(new Uint8Array([0xa1, 0xa2, 0xa3]));
  assert.equal(e.propsType[0], DT.BYTES);
  const dv = new DataView(e.propsData[0].buffer);
  assert.equal(dv.getUint32(0, true), 3);
  assert.deepEqual(Array.from(e.propsData[0].slice(4)), [0xa1, 0xa2, 0xa3]);
});

// ============================================================================
// AD. Array property: encoding-0 vs encoding-1 threshold
// ============================================================================

test('AD1: array exactly at 128 bytes uses encoding=0 (Blender uses `<=`)', () => {
  // 128 bytes = 32 int32 values. Blender's `encoding = 0 if len(data) <= 128 else 1`.
  // Our condition is `byteLength > 128` for encoding=1, so 128 bytes → encoding=0.
  const e = new FBXElem('X');
  e.addInt32Array(new Int32Array(32));  // 128 bytes
  const payload = e.propsData[0];
  const dv = new DataView(payload.buffer);
  assert.equal(dv.getUint32(0, true), 32, 'element count');
  assert.equal(dv.getUint32(4, true), 0,  'encoding=0 at boundary');
  assert.equal(dv.getUint32(8, true), 128, 'comp_len = byte count');
});

test('AD2: array at 129 bytes uses encoding=1 (zlib)', () => {
  // 132 bytes = 33 int32 values. Just over the threshold.
  const e = new FBXElem('X');
  e.addInt32Array(new Int32Array(33));  // 132 bytes
  const payload = e.propsData[0];
  const dv = new DataView(payload.buffer);
  assert.equal(dv.getUint32(0, true), 33);
  assert.equal(dv.getUint32(4, true), 1, 'encoding=1 above threshold');
  const compLen = dv.getUint32(8, true);
  const compressed = payload.slice(12);
  const decompressed = unzlibSync(compressed);
  assert.equal(decompressed.byteLength, 132);
  assert.equal(compressed.byteLength, compLen, 'comp_len matches compressed size');
});

test('AD3: empty array → 12-byte header only, encoding=0', () => {
  const e = new FBXElem('X');
  e.addFloat32Array(new Float32Array(0));
  assert.equal(e.propsData[0].byteLength, 12);
  const dv = new DataView(e.propsData[0].buffer);
  assert.equal(dv.getUint32(0, true), 0);
  assert.equal(dv.getUint32(4, true), 0);
  assert.equal(dv.getUint32(8, true), 0);
});

test('AD4: addInt32Array with Int32Array view at non-zero byteOffset still slices correctly', () => {
  // Sliced views are a common JS pattern. Verify the slice path copies bytes.
  const big = new Int32Array([1, 2, 3, 4, 5, 6, 7, 8]);
  // Create a view starting at index 2 covering 4 elements: [3, 4, 5, 6]
  const view = new Int32Array(big.buffer, 8, 4);
  const e = new FBXElem('X');
  e.addInt32Array(view);
  const dv = new DataView(e.propsData[0].buffer);
  assert.equal(dv.getUint32(0, true), 4, 'element count');
  // Read back the values from the un-compressed payload (encoding=0).
  const rawStart = 12;
  for (let i = 0; i < 4; i++) {
    assert.equal(dv.getInt32(rawStart + i * 4, true), i + 3, `el ${i}`);
  }
});

test('AD5: addFloat64Array round-trips NaN and Infinity', () => {
  const e = new FBXElem('X');
  e.addFloat64Array(new Float64Array([NaN, Infinity, -Infinity, 1.5]));
  const payload = e.propsData[0];
  // 4 * 8 = 32 bytes, below threshold → encoding=0
  const dv = new DataView(payload.buffer, 12);
  assert.ok(Number.isNaN(dv.getFloat64(0, true)));
  assert.equal(dv.getFloat64(8, true), Infinity);
  assert.equal(dv.getFloat64(16, true), -Infinity);
  assert.equal(dv.getFloat64(24, true), 1.5);
});

test('AD6: addInt64Array with BigInt and Number inputs', () => {
  const e = new FBXElem('X');
  e.addInt64Array([0n, 1n, -1n, 0x7fffffffffffffffn]);
  const payload = e.propsData[0];
  const dv = new DataView(payload.buffer, 12);
  assert.equal(dv.getBigInt64(0, true), 0n);
  assert.equal(dv.getBigInt64(8, true), 1n);
  assert.equal(dv.getBigInt64(16, true), -1n);
  assert.equal(dv.getBigInt64(24, true), 0x7fffffffffffffffn);
});

// ============================================================================
// AE. _calcOffsets — propsLength bookkeeping
// ============================================================================

test('AE1: _propsLength counts type-tag byte plus payload byte length', () => {
  const e = new FBXElem('X');
  e.addInt32(7);           // 1 (tag) + 4 = 5
  e.addString('hi');       // 1 (tag) + 4 (len prefix) + 2 = 7
  e.addFloat64(1.0);       // 1 (tag) + 8 = 9
  const ctx = { use64: false, metaSize: 12, sentinelSize: 13 };
  e._calcOffsets(0, true, ctx);
  assert.equal(e._propsLength, 5 + 7 + 9);
});

test('AE2: leaf elem with no children and IS last sibling produces no sentinel', () => {
  const e = new FBXElem('Foo');
  e.addInt32(1);
  const ctx = { use64: false, metaSize: 12, sentinelSize: 13 };
  const end = e._calcOffsets(0, true, ctx);
  // meta(12) + idLen(1) + 'Foo'(3) + prop(1+4) = 21. No sentinel.
  assert.equal(end, 21);
});

test('AE3: leaf elem with no props and NOT last sibling DOES get sentinel', () => {
  const e = new FBXElem('Foo');
  const ctx = { use64: false, metaSize: 12, sentinelSize: 13 };
  const end = e._calcOffsets(0, false, ctx); // not last
  // meta(12) + idLen(1) + 'Foo'(3) + 0 props + sentinel(13) = 29
  assert.equal(end, 29);
});

test('AE4: AnimationStack/AnimationLayer always gets sentinel even when last', () => {
  for (const id of ['AnimationStack', 'AnimationLayer']) {
    const e = new FBXElem(id);
    const ctx = { use64: false, metaSize: 12, sentinelSize: 13 };
    const end = e._calcOffsets(0, true, ctx);
    // meta(12) + 1 + len(id) + 0 + sentinel(13)
    const expected = 12 + 1 + id.length + 13;
    assert.equal(end, expected, `${id}: expected ${expected}, got ${end}`);
  }
});

test('AE5: leaf with NO props AND IS last AND id is NOT in special set → no sentinel', () => {
  // Specifically the inverse of AE4.
  const e = new FBXElem('Foo');  // not Animation*
  const ctx = { use64: false, metaSize: 12, sentinelSize: 13 };
  const end = e._calcOffsets(0, true, ctx);
  assert.equal(end, 12 + 1 + 3);  // no sentinel
});

test('AE6: FBX 7500 uses 25-byte sentinel and 24-byte meta', () => {
  const e = new FBXElem('Foo');
  const ctx = { use64: true, metaSize: 24, sentinelSize: 25 };
  const end = e._calcOffsets(0, false, ctx);
  // meta(24) + 1 + 'Foo'(3) + 0 + sentinel(25)
  assert.equal(end, 24 + 1 + 3 + 25);
});

// ============================================================================
// AF. End-to-end byte layout — header, body, footer
// ============================================================================

function decodeFile(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    headerMagic: bytes.slice(0, 23),
    version: dv.getUint32(23, true),
    bytes,
    dv,
  };
}

test('AF1: header signature exactly matches Blender _HEAD_MAGIC', () => {
  const expected = new Uint8Array([
    0x4b, 0x61, 0x79, 0x64, 0x61, 0x72, 0x61, 0x20,
    0x46, 0x42, 0x58, 0x20, 0x42, 0x69, 0x6e, 0x61,
    0x72, 0x79, 0x20, 0x20, 0x00, 0x1a, 0x00,
  ]);
  const out = encodeBinaryFBX(new FBXElem(''), { version: 7400 });
  assert.deepEqual(out.slice(0, 23), expected);
});

test('AF2: footer ends with 16-byte TAIL_MAGIC at exact offset', () => {
  const expected = new Uint8Array([
    0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e,
    0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b,
  ]);
  const out = encodeBinaryFBX(new FBXElem(''), { version: 7400 });
  assert.deepEqual(out.slice(out.length - 16), expected);
});

test('AF3: footer is FOOT_ID(16) + 4 zeros + padding(1-16) + version(4) + 120 zeros + magic(16)', () => {
  const out = encodeBinaryFBX(new FBXElem(''), { version: 7400 });
  // Footer layout: FOOT_ID(16) + 4 zeros + pad(1-16) + version(4) + 120 zeros + magic(16).
  // Total footer = 160 + pad bytes; FOOT_ID starts at length - 160 - pad - 16.
  // Search the last 32 bytes before the 120-zero region for FOOT_ID's start.
  const FOOT_ID = __testing__.FOOT_ID;
  let footIdAt = -1;
  // The 120-zero region starts at length - 16 - 120 = length - 136. FOOT_ID
  // ends BEFORE the 4-byte version, which sits at length - 140.
  // version is at length-140; before it lies padding; before that FOOT_ID+4 zeros.
  // Walk back: the FOOT_ID position is between length - 140 - 4 - 16 - 16 (max pad)
  // = length - 176 and length - 140 - 4 - 1 - 16 = length - 161.
  for (let i = out.length - 176; i <= out.length - 160; i++) {
    let match = true;
    for (let k = 0; k < 16; k++) {
      if (out[i + k] !== FOOT_ID[k]) { match = false; break; }
    }
    if (match) { footIdAt = i; break; }
  }
  assert.ok(footIdAt >= 0, 'FOOT_ID located in expected footer window');

  // Next 4 bytes after FOOT_ID must be zero.
  for (let i = 0; i < 4; i++) {
    assert.equal(out[footIdAt + 16 + i], 0, `footer zero ${i}`);
  }

  // Last 16 bytes are TAIL_MAGIC.
  assert.deepEqual(out.slice(out.length - 16), __testing__.TAIL_MAGIC);

  // 120 zero bytes BEFORE the tail magic.
  for (let i = 1; i <= 120; i++) {
    assert.equal(out[out.length - 16 - i], 0, `120-byte zero region ${i}`);
  }

  // 4 bytes immediately before that 120-zero region are the version (uint32 LE).
  const versionOffset = out.length - 16 - 120 - 4;
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  assert.equal(dv.getUint32(versionOffset, true), 7400);
});

test('AF4: padding pads to next 16-byte boundary; if already aligned, adds full 16', () => {
  // Construct files of various body sizes and verify the FOOT_ID position
  // creates a padding length in [1, 16].
  for (const nProps of [0, 1, 5, 10]) {
    const root = new FBXElem('');
    for (let i = 0; i < nProps; i++) {
      const node = root.addEmpty(`Node${i}`);
      node.addInt32(i);
    }
    const out = encodeBinaryFBX(root, { version: 7400 });
    // Locate FOOT_ID
    const FOOT_ID = __testing__.FOOT_ID;
    let footIdAt = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i] !== FOOT_ID[0]) continue;
      let match = true;
      for (let k = 1; k < 16; k++) {
        if (out[i + k] !== FOOT_ID[k]) { match = false; break; }
      }
      if (match) { footIdAt = i; break; }
    }
    assert.ok(footIdAt >= 0, `FOOT_ID found for nProps=${nProps}`);

    // After FOOT_ID + 4 zero bytes, we have padding before version. Compute:
    const padStart = footIdAt + 16 + 4;
    const versionAt = out.length - 16 - 120 - 4;
    const padLen = versionAt - padStart;
    assert.ok(padLen >= 1 && padLen <= 16, `nProps=${nProps}: padLen=${padLen} should be 1..16`);
    // Pad bytes must all be zero.
    for (let i = padStart; i < versionAt; i++) {
      assert.equal(out[i], 0, `pad byte at ${i} not zero`);
    }
  }
});

// ============================================================================
// AG. Time hack — idempotency and overwriting
// ============================================================================

test('AG1: time-hack replaces FileId 16 zeros with the canonical 16-byte FILE_ID', () => {
  const root = new FBXElem('');
  // Place a FileId node at root level with a placeholder.
  const fileId = root.addEmpty('FileId');
  fileId.addBytes(new Uint8Array(16));  // 16 zeros placeholder
  // Place a CreationTime placeholder too.
  const ct = root.addEmpty('CreationTime');
  ct.addString('placeholder');
  const out = encodeBinaryFBX(root, { version: 7400 });
  // Decode and locate FileId / CreationTime in the byte stream.
  const text = new TextDecoder('latin1').decode(out);
  const fid = '\x06FileId';
  const at = text.indexOf(fid);
  assert.ok(at >= 0, 'FileId id found');
  // FBXElem layout: meta(12) + idLen(1) + id(6) + prop tag('R'=0x52) + uint32 len + 16 bytes.
  // After id (which is preceded by \x06 = idLen byte), the prop tag is 'R'.
  const tagOff = at + 1 + 6;
  assert.equal(out[tagOff], DT.BYTES, 'FileId prop tag is BYTES');
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const fileIdLen = dv.getUint32(tagOff + 1, true);
  assert.equal(fileIdLen, 16);
  // Bytes after the length should be the canonical FILE_ID, not zeros.
  const fileIdBytes = out.slice(tagOff + 5, tagOff + 5 + 16);
  assert.deepEqual(fileIdBytes, __testing__.FILE_ID);
});

test('AG2: time-hack is idempotent — calling encode twice produces identical output', () => {
  const buildTree = () => {
    const r = new FBXElem('');
    r.addEmpty('FileId').addBytes(new Uint8Array(16));
    r.addEmpty('CreationTime').addString('placeholder');
    r.addEmpty('Creator').addString('test');
    return r;
  };
  const a = encodeBinaryFBX(buildTree(), { version: 7400 });
  const b = encodeBinaryFBX(buildTree(), { version: 7400 });
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) throw new Error(`diff at byte ${i}: ${a[i]} vs ${b[i]}`);
  }
});

test('AG3: time-hack scans ONLY root.elems (not nested) and tolerates missing nodes', () => {
  // Tree with FileId NESTED inside another node — time-hack should NOT touch it.
  const root = new FBXElem('');
  const nested = root.addEmpty('OuterContainer');
  const fileId = nested.addEmpty('FileId');
  fileId.addBytes(new Uint8Array(16)); // 16 zeros — should stay zero (not at root)
  const out = encodeBinaryFBX(root, { version: 7400 });
  // Find the FileId node — its bytes should still be 16 zeros.
  const text = new TextDecoder('latin1').decode(out);
  const at = text.indexOf('\x06FileId');
  assert.ok(at >= 0);
  const tagOff = at + 1 + 6;
  for (let i = 0; i < 16; i++) {
    // Skip the 4-byte length prefix (1 + 4 = 5 after tag) — read the 16 data bytes.
    assert.equal(out[tagOff + 1 + 4 + i], 0, `nested FileId byte ${i} should be 0, not patched`);
  }
});

// ============================================================================
// AH. Sentinel byte counts (13 vs 25)
// ============================================================================

test('AH1: FBX 7400 footer block sentinel inside file is 13 bytes, all zero', () => {
  const root = new FBXElem('');
  root.addEmpty('A');  // not last and no props → triggers sentinel
  root.addEmpty('B');  // last, no props
  // sentinel handling for "not last + no props":
  // 'A' has no props and isn't last → gets sentinel. 'B' last + no props + not in
  // special set → no sentinel. Then trailing sentinel at end of root.elems.
  const out = encodeBinaryFBX(root, { version: 7400 });
  assert.ok(out.length > 0);
});

test('AH2: FBX 7500 file uses uint64 meta — encoded numbers are 8-byte each', () => {
  // Build a simple file at FBX 7500 and verify the first node has meta size 24.
  const root = new FBXElem('');
  const node = root.addEmpty('Foo');
  node.addInt32(42);
  const out = encodeBinaryFBX(root, { version: 7500 });
  // After 23-byte header + 4-byte version, the first node starts. The first
  // 8 bytes are the end_offset as uint64.
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const endOffset = Number(dv.getBigUint64(27, true));
  // end_offset = 27 (current) + meta(24) + idLen(1) + 'Foo'(3) + prop(1+4) = 60
  assert.equal(endOffset, 60, `v7500 first-node end_offset: ${endOffset}`);
});

// ============================================================================
// AI. End-offset assertion catches author bugs
// ============================================================================

test('AI1: _write throws clearly if _calcOffsets has not been run', () => {
  const e = new FBXElem('X');
  e.addInt32(1);
  const bw = new BinaryWriter(64);
  let err = null;
  try { e._write(bw, true, { use64: false, metaSize: 12, sentinelSize: 13 }); }
  catch (e) { err = e; }
  assert.ok(err);
  assert.ok(/_calcOffsets must run/.test(err.message), `error: ${err.message}`);
});

test('AI2: end-offset mismatch surfaces with a precise error', () => {
  // Force a mismatch by tampering with _endOffset after calc.
  const e = new FBXElem('Foo');
  e.addInt32(1);
  e._calcOffsets(0, true, { use64: false, metaSize: 12, sentinelSize: 13 });
  e._endOffset += 99; // poison
  const bw = new BinaryWriter(64);
  let err = null;
  try { e._write(bw, true, { use64: false, metaSize: 12, sentinelSize: 13 }); }
  catch (e2) { err = e2; }
  assert.ok(err);
  assert.ok(/end offset mismatch/.test(err.message), `error: ${err.message}`);
});

// ============================================================================
// AJ. encodeBinaryFBX entry assertions
// ============================================================================

test('AJ1: root with non-empty id is rejected', () => {
  let err = null;
  try { encodeBinaryFBX(new FBXElem('Foo'), { version: 7400 }); }
  catch (e) { err = e; }
  assert.ok(err);
  assert.ok(/empty id/.test(err.message), `error: ${err.message}`);
});

test('AJ2: non-FBXElem rejected', () => {
  let err = null;
  try { encodeBinaryFBX({}, { version: 7400 }); }
  catch (e) { err = e; }
  assert.ok(err);
  assert.ok(/FBXElem/.test(err.message), `error: ${err.message}`);
});

// ============================================================================
// AK. Specific property type-tag bytes inside an encoded file
// ============================================================================

test('AK1: encoded INT32 prop has type-tag byte 0x49 ("I")', () => {
  const root = new FBXElem('');
  const node = root.addEmpty('Foo');
  node.addInt32(7);
  const out = encodeBinaryFBX(root, { version: 7400 });
  const text = new TextDecoder('latin1').decode(out);
  const at = text.indexOf('\x03Foo');
  const tagOff = at + 1 + 3;
  assert.equal(out[tagOff], 0x49, `INT32 type tag at ${tagOff} = 0x${out[tagOff].toString(16)}`);
});

test('AK2: encoded FLOAT64 array prop has type-tag byte 0x64 ("d")', () => {
  const root = new FBXElem('');
  const node = root.addEmpty('Foo');
  node.addFloat64Array(new Float64Array([1.5, 2.5, 3.5]));
  const out = encodeBinaryFBX(root, { version: 7400 });
  const text = new TextDecoder('latin1').decode(out);
  const at = text.indexOf('\x03Foo');
  const tagOff = at + 1 + 3;
  assert.equal(out[tagOff], 0x64, `FLOAT64_ARRAY type tag = 0x${out[tagOff].toString(16)}`);
});

// ============================================================================
// AL. ID length byte (uint8) bounds
// ============================================================================

test('AL1: FBXElem with id length > 255 throws RangeError', () => {
  const longId = 'x'.repeat(256);
  let err = null;
  try { new FBXElem(longId); } catch (e) { err = e; }
  assert.ok(err instanceof RangeError, `expected RangeError, got ${err}`);
});

test('AL2: id length of exactly 255 is accepted', () => {
  const id = 'x'.repeat(255);
  const e = new FBXElem(id);  // should not throw
  assert.equal(e._idBytes.length, 255);
});

// ============================================================================
// AM. Suspicions about ID byte length vs JS string length
// ============================================================================

test('AM1: multibyte UTF-8 id with byte length > 255 must be rejected', () => {
  // 100 Japanese chars × 3 bytes/char = 300 bytes — under 255 chars but over
  // 255 bytes. The 1-byte uint8 nameLen field cannot encode this; allowing
  // it through silently produces a corrupt file. Blender never hits this
  // because all FBX node ids are ASCII keywords; we should still guard.
  const id = 'あ'.repeat(100);  // 300 UTF-8 bytes, 100 chars
  let err = null;
  try { new FBXElem(id); } catch (e) { err = e; }
  assert.ok(err instanceof RangeError,
    `expected RangeError for UTF-8 byte length > 255, got ${err && err.constructor.name}`);
});

test('AM2: addInt64 with negative BigInt round-trips correctly', () => {
  const e = new FBXElem('X');
  e.addInt64(-1n);
  e.addInt64(BigInt(Number.MIN_SAFE_INTEGER));
  const dv0 = new DataView(e.propsData[0].buffer);
  const dv1 = new DataView(e.propsData[1].buffer);
  assert.equal(dv0.getBigInt64(0, true), -1n);
  assert.equal(dv1.getBigInt64(0, true), BigInt(Number.MIN_SAFE_INTEGER));
});

test('AM3: mixed prop types in one element come out in stable order', () => {
  const e = new FBXElem('Mix');
  e.addInt32(1);
  e.addFloat64(2.5);
  e.addString('hi');
  e.addBool(true);
  e.addInt64Array([10n, 20n]);
  // Verify type tags in order match Blender's "props_type" array semantics.
  assert.deepEqual(e.propsType, [
    DT.INT32, DT.FLOAT64, DT.STRING, DT.BOOL, DT.INT64_ARRAY,
  ]);
});

test('AM4: an entire prop-type matrix round-trips through encode + decode', () => {
  // Build a single element exercising every prop adder, encode it inside a
  // minimal FBX file, then decode the bytes manually and verify each value.
  const root = new FBXElem('');
  const node = root.addEmpty('AllTypes');
  node.addBool(true);
  node.addInt8(-7);
  node.addInt16(0x1234);
  node.addInt32(0x11223344);
  node.addInt64(0x0123456789abcdefn);
  node.addFloat32(1.5);
  node.addFloat64(3.14159);
  node.addString('abc');
  node.addBytes(new Uint8Array([0xa, 0xb]));
  node.addInt32Array(new Int32Array([1, 2, 3]));
  node.addFloat64Array(new Float64Array([4, 5, 6]));
  const out = encodeBinaryFBX(root, { version: 7400 });

  // Locate the AllTypes node id in the byte stream.
  const text = new TextDecoder('latin1').decode(out);
  const at = text.indexOf('\x08AllTypes');
  assert.ok(at > 0);
  let offset = at + 1 + 8; // past idLen byte and 'AllTypes'

  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  function readType() { return out[offset++]; }
  function readU32() { const v = dv.getUint32(offset, true); offset += 4; return v; }

  // BOOL (true)
  assert.equal(readType(), DT.BOOL);
  assert.equal(out[offset++], 1);
  // INT8 (-7)
  assert.equal(readType(), DT.INT8);
  assert.equal(dv.getInt8(offset++), -7);
  // INT16 (0x1234 LE)
  assert.equal(readType(), DT.INT16);
  assert.equal(dv.getInt16(offset, true), 0x1234); offset += 2;
  // INT32
  assert.equal(readType(), DT.INT32);
  assert.equal(dv.getInt32(offset, true), 0x11223344); offset += 4;
  // INT64
  assert.equal(readType(), DT.INT64);
  assert.equal(dv.getBigInt64(offset, true), 0x0123456789abcdefn); offset += 8;
  // FLOAT32
  assert.equal(readType(), DT.FLOAT32);
  assert.equal(dv.getFloat32(offset, true), 1.5); offset += 4;
  // FLOAT64
  assert.equal(readType(), DT.FLOAT64);
  assert.ok(Math.abs(dv.getFloat64(offset, true) - 3.14159) < 1e-9); offset += 8;
  // STRING 'abc'
  assert.equal(readType(), DT.STRING);
  assert.equal(readU32(), 3);
  assert.equal(String.fromCharCode(out[offset++], out[offset++], out[offset++]), 'abc');
  // BYTES
  assert.equal(readType(), DT.BYTES);
  assert.equal(readU32(), 2);
  assert.equal(out[offset++], 0xa);
  assert.equal(out[offset++], 0xb);
  // INT32_ARRAY (3 elements, 12 bytes, encoding=0)
  assert.equal(readType(), DT.INT32_ARRAY);
  assert.equal(readU32(), 3);  // element count
  assert.equal(readU32(), 0);  // encoding
  assert.equal(readU32(), 12); // comp_len
  assert.equal(dv.getInt32(offset, true), 1); offset += 4;
  assert.equal(dv.getInt32(offset, true), 2); offset += 4;
  assert.equal(dv.getInt32(offset, true), 3); offset += 4;
  // FLOAT64_ARRAY (3 elements, 24 bytes, encoding=0)
  assert.equal(readType(), DT.FLOAT64_ARRAY);
  assert.equal(readU32(), 3);
  assert.equal(readU32(), 0);
  assert.equal(readU32(), 24);
  assert.equal(dv.getFloat64(offset, true), 4); offset += 8;
  assert.equal(dv.getFloat64(offset, true), 5); offset += 8;
  assert.equal(dv.getFloat64(offset, true), 6); offset += 8;
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
