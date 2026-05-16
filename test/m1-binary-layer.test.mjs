// Self-contained sanity tests for the M1 binary layer.
// Run with: node test/m1-binary-layer.test.mjs
//
// We re-parse our own bytes using a hand-rolled reader to verify the on-wire format,
// matching three.js FBXLoader's BinaryParser (FBXLoader.js: class BinaryParser).

import { strict as assert } from 'node:assert';
import { unzlibSync } from 'fflate';

import { FBXElem } from '../src/core/FBXElem.js';
import { BinaryWriter } from '../src/core/BinaryWriter.js';
import { encodeBinaryFBX, __testing__ } from '../src/core/encodeBinary.js';
import * as DT from '../src/core/dataTypes.js';

let testsRun = 0;
let failures = 0;
function test(name, fn) {
  testsRun++;
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL  ${name}`);
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// 1. BinaryWriter: little-endian scalars
// ---------------------------------------------------------------------------
test('BinaryWriter writes LE scalars at correct offsets', () => {
  const bw = new BinaryWriter(4);
  bw.writeU32(0x11223344);
  bw.writeI16(-1);
  bw.writeF32(1.0);
  bw.writeU64(0x0123456789abcdefn);
  const out = bw.toUint8Array();
  // 0x11223344 LE = 44 33 22 11
  assert.deepEqual(Array.from(out.slice(0, 4)), [0x44, 0x33, 0x22, 0x11]);
  // -1 as int16 LE = ff ff
  assert.deepEqual(Array.from(out.slice(4, 6)), [0xff, 0xff]);
  // 1.0 as float32 LE = 00 00 80 3f
  assert.deepEqual(Array.from(out.slice(6, 10)), [0x00, 0x00, 0x80, 0x3f]);
  // BigInt 0x0123456789abcdef LE
  assert.deepEqual(
    Array.from(out.slice(10, 18)),
    [0xef, 0xcd, 0xab, 0x89, 0x67, 0x45, 0x23, 0x01],
  );
});

test('BinaryWriter grows past initial capacity', () => {
  const bw = new BinaryWriter(2);
  for (let i = 0; i < 1000; i++) bw.writeU32(i);
  const out = bw.toUint8Array();
  assert.equal(out.length, 4000);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i < 1000; i++) assert.equal(dv.getUint32(i * 4, true), i);
});

// ---------------------------------------------------------------------------
// 2. FBXElem: prop encoding shapes
// ---------------------------------------------------------------------------
test('FBXElem encodes scalar prop bytes correctly', () => {
  const e = new FBXElem('Foo');
  e.addInt32(42);
  e.addFloat64(3.14);
  e.addString('hi');
  assert.equal(e.propsType.length, 3);
  assert.equal(e.propsType[0], DT.INT32);
  assert.equal(e.propsType[1], DT.FLOAT64);
  assert.equal(e.propsType[2], DT.STRING);
  // INT32 payload = 4 bytes; FLOAT64 = 8; STRING = 4-byte len + 2 bytes "hi"
  assert.equal(e.propsData[0].byteLength, 4);
  assert.equal(e.propsData[1].byteLength, 8);
  assert.equal(e.propsData[2].byteLength, 6);
  // string length-prefix is LE uint32 = 2
  const dv = new DataView(e.propsData[2].buffer, e.propsData[2].byteOffset);
  assert.equal(dv.getUint32(0, true), 2);
  assert.equal(String.fromCharCode(e.propsData[2][4], e.propsData[2][5]), 'hi');
});

test('FBXElem small int32 array uses encoding=0', () => {
  const e = new FBXElem('Vertices');
  e.addInt32Array([1, 2, 3]); // 12 bytes payload, below threshold
  const payload = e.propsData[0];
  const dv = new DataView(payload.buffer, payload.byteOffset);
  assert.equal(dv.getUint32(0, true), 3);  // element count
  assert.equal(dv.getUint32(4, true), 0);  // encoding=0 (uncompressed)
  assert.equal(dv.getUint32(8, true), 12); // comp_len = raw byte length
  assert.equal(payload.byteLength, 12 + 12);
});

test('FBXElem large float64 array uses encoding=1 + zlib', () => {
  const e = new FBXElem('Verts');
  const arr = new Float64Array(64); // 512 bytes > 128 threshold
  for (let i = 0; i < arr.length; i++) arr[i] = i * 0.5;
  e.addFloat64Array(arr);
  const payload = e.propsData[0];
  const dv = new DataView(payload.buffer, payload.byteOffset);
  assert.equal(dv.getUint32(0, true), 64); // length = element count
  assert.equal(dv.getUint32(4, true), 1);  // encoding=1
  const compLen = dv.getUint32(8, true);
  assert.equal(payload.byteLength, 12 + compLen);
  // round-trip the compression
  const compressed = payload.slice(12);
  const decompressed = unzlibSync(compressed);
  assert.equal(decompressed.byteLength, 512);
  const roundTripped = new Float64Array(
    decompressed.buffer,
    decompressed.byteOffset,
    64,
  );
  for (let i = 0; i < 64; i++) assert.equal(roundTripped[i], i * 0.5);
});

// ---------------------------------------------------------------------------
// 3. Two-phase offset calc: leaf with one prop
// ---------------------------------------------------------------------------
test('FBXElem _calcOffsets produces consistent leaf size (v<7500)', () => {
  const e = new FBXElem('Magic');
  e.addInt32(7);
  const ctx = { use64: false, metaSize: 12, sentinelSize: 13 };
  const end = e._calcOffsets(0, true, ctx);
  // 12 meta + 1 (idLen byte) + 5 (id "Magic") + (1 type + 4 payload) = 23
  assert.equal(end, 23);
  assert.equal(e._endOffset, 23);
  assert.equal(e._propsLength, 5);
});

test('FBXElem _calcOffsets accounts for child sentinel', () => {
  const parent = new FBXElem('A');
  const child = new FBXElem('B');
  child.addInt32(1);
  parent.addChild(child);
  const ctx = { use64: false, metaSize: 12, sentinelSize: 13 };
  const end = parent._calcOffsets(0, true, ctx);
  // parent meta(12)+idLen(1)+"A"(1)+no props
  //   + child:  meta(12)+idLen(1)+"B"(1)+(1+4)
  //   + sentinel(13)
  // = 14 + 19 + 13 = 46
  assert.equal(end, 46);
});

// ---------------------------------------------------------------------------
// 4. End-to-end: encodeBinaryFBX writes a re-parseable file
// ---------------------------------------------------------------------------
test('encodeBinaryFBX produces magic header + version', () => {
  const root = new FBXElem('');
  const out = encodeBinaryFBX(root, { version: 7400 });
  // first 23 bytes are HEAD_MAGIC
  assert.deepEqual(out.slice(0, 23), __testing__.HEAD_MAGIC);
  // bytes 23–26 = version 7400 LE
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  assert.equal(dv.getUint32(23, true), 7400);
  // ends with TAIL_MAGIC
  assert.deepEqual(out.slice(out.length - 16), __testing__.TAIL_MAGIC);
});

test('round-trip: re-parse our own file with a minimal binary reader', () => {
  // Build a non-trivial tree
  const root = new FBXElem('');
  const header = root.addEmpty('FBXHeaderExtension');
  const ver = header.addEmpty('FBXVersion');
  ver.addInt32(7400);
  const creation = root.addEmpty('CreationTime');
  creation.addString('placeholder');
  const objects = root.addEmpty('Objects');
  const geom = objects.addEmpty('Geometry');
  geom.addInt64(0x123456789abcdefn);
  geom.addString('Geometry::Cube');
  geom.addString('Mesh');
  const vertices = geom.addEmpty('Vertices');
  vertices.addFloat64Array(new Float64Array([0, 1, 2, 3, 4, 5, 6, 7, 8]));
  const indices = geom.addEmpty('PolygonVertexIndex');
  indices.addInt32Array(new Int32Array([0, 1, -3])); // last face vertex inverted
  root.addEmpty('Connections');

  const out = encodeBinaryFBX(root, { version: 7400 });

  // Walk it back with a tiny inline reader
  const parsed = parseFBXBinary(out);
  assert.ok(parsed.FBXHeaderExtension, 'FBXHeaderExtension exists');
  assert.equal(parsed.FBXHeaderExtension.children.FBXVersion.props[0], 7400);
  assert.ok(parsed.Objects.children.Geometry, 'Geometry node parsed');
  const g = parsed.Objects.children.Geometry;
  // After time hack, CreationTime gets overwritten — but Geometry should be untouched
  assert.equal(typeof g.props[0], 'bigint');
  assert.equal(g.props[1], 'Geometry::Cube');
  assert.equal(g.props[2], 'Mesh');
  const v = g.children.Vertices.props[0];
  assert.ok(v instanceof Float64Array);
  assert.equal(v.length, 9);
  assert.equal(v[8], 8);
  const idx = g.children.PolygonVertexIndex.props[0];
  assert.ok(idx instanceof Int32Array);
  assert.deepEqual(Array.from(idx), [0, 1, -3]);

  // Time hack: CreationTime payload should have been replaced with TIME_ID bytes
  const ct = parsed.CreationTime;
  assert.equal(ct.props[0], '1970-01-01 10:00:00:000');
});

test('round-trip with FBX 7500 (uint64 meta + 25-byte sentinel)', () => {
  const root = new FBXElem('');
  const e = root.addEmpty('Foo');
  e.addInt32(42);
  e.addFloat64(2.71828);
  const out = encodeBinaryFBX(root, { version: 7500 });
  const parsed = parseFBXBinary(out);
  assert.equal(parsed.Foo.props[0], 42);
  assert.ok(Math.abs(parsed.Foo.props[1] - 2.71828) < 1e-9);
});

// ---------------------------------------------------------------------------
// Inline binary reader (matches three.js FBXLoader BinaryParser semantics)
// ---------------------------------------------------------------------------
function parseFBXBinary(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let offset = 23;
  const version = dv.getUint32(offset, true);
  offset += 4;
  const use64 = version >= 7500;
  const metaSize = use64 ? 24 : 12;
  const sentinelSize = use64 ? 25 : 13;

  const out = {};

  // Read top-level nodes until we hit the null record (sentinel) preceding footer
  while (true) {
    const peekEndOffset = use64
      ? Number(dv.getBigUint64(offset, true))
      : dv.getUint32(offset, true);
    if (peekEndOffset === 0) {
      offset += metaSize + 1; // sentinel = metaSize + 1 byte nameLen
      break;
    }
    const node = parseNode();
    out[node.name] = node;
  }
  return out;

  function parseNode() {
    const endOffset = use64
      ? Number(dv.getBigUint64(offset, true))
      : dv.getUint32(offset, true);
    offset += use64 ? 8 : 4;
    const numProps = use64
      ? Number(dv.getBigUint64(offset, true))
      : dv.getUint32(offset, true);
    offset += use64 ? 8 : 4;
    offset += use64 ? 8 : 4; // propsLength, unused
    const nameLen = dv.getUint8(offset);
    offset += 1;
    const name = readUtf8(nameLen);
    const props = [];
    for (let i = 0; i < numProps; i++) props.push(parseProp());
    const children = {};
    while (offset < endOffset) {
      // child may be a sentinel
      const peek = use64
        ? Number(dv.getBigUint64(offset, true))
        : dv.getUint32(offset, true);
      if (peek === 0 && offset + sentinelSize <= endOffset) {
        offset += sentinelSize;
        break;
      }
      const child = parseNode();
      children[child.name] = child;
    }
    if (offset !== endOffset) {
      // tolerate trailing sentinel
      offset = endOffset;
    }
    return { name, props, children };
  }

  function readUtf8(n) {
    const slice = u8.slice(offset, offset + n);
    offset += n;
    return new TextDecoder().decode(slice);
  }

  function parseProp() {
    const tag = dv.getUint8(offset);
    offset += 1;
    switch (tag) {
      case DT.BOOL:    return read(1, (o) => !!dv.getUint8(o));
      case DT.CHAR:    return read(1, (o) => dv.getUint8(o));
      case DT.INT8:    return read(1, (o) => dv.getInt8(o));
      case DT.INT16:   return read(2, (o) => dv.getInt16(o, true));
      case DT.INT32:   return read(4, (o) => dv.getInt32(o, true));
      case DT.INT64:   return read(8, (o) => dv.getBigInt64(o, true));
      case DT.FLOAT32: return read(4, (o) => dv.getFloat32(o, true));
      case DT.FLOAT64: return read(8, (o) => dv.getFloat64(o, true));
      case DT.STRING:
      case DT.BYTES: {
        const len = dv.getUint32(offset, true);
        offset += 4;
        const bytes = u8.slice(offset, offset + len);
        offset += len;
        return tag === DT.STRING ? new TextDecoder().decode(bytes) : bytes;
      }
      case DT.INT32_ARRAY:
      case DT.INT64_ARRAY:
      case DT.FLOAT32_ARRAY:
      case DT.FLOAT64_ARRAY:
      case DT.BOOL_ARRAY:
      case DT.BYTE_ARRAY:
        return parseArrayProp(tag);
      default:
        throw new Error(`Unknown FBX prop tag 0x${tag.toString(16)}`);
    }
  }

  function read(size, fn) {
    const v = fn(offset);
    offset += size;
    return v;
  }

  function parseArrayProp(tag) {
    const length = dv.getUint32(offset, true);
    const encoding = dv.getUint32(offset + 4, true);
    const compLen = dv.getUint32(offset + 8, true);
    offset += 12;
    const compressedOrRaw = u8.slice(offset, offset + compLen);
    offset += compLen;
    const raw = encoding === 1 ? unzlibSync(compressedOrRaw) : compressedOrRaw;
    switch (tag) {
      case DT.INT32_ARRAY:   return new Int32Array(raw.buffer, raw.byteOffset, length);
      case DT.INT64_ARRAY:   return new BigInt64Array(raw.buffer, raw.byteOffset, length);
      case DT.FLOAT32_ARRAY: return new Float32Array(raw.buffer, raw.byteOffset, length);
      case DT.FLOAT64_ARRAY: return new Float64Array(raw.buffer, raw.byteOffset, length);
      case DT.BOOL_ARRAY:    return new Uint8Array(raw.buffer, raw.byteOffset, length);
      case DT.BYTE_ARRAY:    return new Uint8Array(raw.buffer, raw.byteOffset, length);
    }
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${testsRun - failures}/${testsRun} passed`);
if (failures > 0) process.exit(1);
