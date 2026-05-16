import { zlibSync } from 'fflate';
import * as DT from './dataTypes.js';

const TEXT_ENCODER = new TextEncoder();

const ELEMS_ALWAYS_BLOCK_SENTINEL = new Set(['AnimationStack', 'AnimationLayer']);

/**
 * A single node in the FBX binary tree.
 *
 * Construct with `new FBXElem(id)` where `id` is an ASCII string ≤ 255 bytes.
 * Add typed properties via the `add*` methods and child nodes via `addChild`.
 *
 * Two-phase write: `_calcOffsets()` resolves end-offsets; `_write()` emits bytes.
 * Use the top-level `encodeBinaryFBX()` helper instead of calling these directly.
 */
export class FBXElem {
  id: string;
  _idBytes: Uint8Array;
  propsType: number[];
  propsData: Uint8Array[];
  elems: FBXElem[];
  _endOffset: number;
  _propsLength: number;

  constructor(id: string) {
    this.id = id;
    this._idBytes = TEXT_ENCODER.encode(id);
    if (this._idBytes.length > 255) {
      throw new RangeError(
        `FBX node id too long: ${this._idBytes.length} UTF-8 bytes (max 255). id=${JSON.stringify(id)}`,
      );
    }

    this.propsType = [];
    this.propsData = [];

    this.elems = [];

    this._endOffset = -1;
    this._propsLength = -1;
  }


  addChild(elem) {
    this.elems.push(elem);
    return elem;
  }

  /** Create + add a child by id, optionally seeding props. */
  addEmpty(id) {
    return this.addChild(new FBXElem(id));
  }


  addBool(v) {
    this.propsType.push(DT.BOOL);
    this.propsData.push(new Uint8Array([v ? 1 : 0]));
  }
  addChar(byte) {
    this.propsType.push(DT.CHAR);
    this.propsData.push(new Uint8Array([byte & 0xff]));
  }
  addInt8(v) {
    const b = new ArrayBuffer(1);
    new DataView(b).setInt8(0, v);
    this.propsType.push(DT.INT8);
    this.propsData.push(new Uint8Array(b));
  }
  addInt16(v) {
    const b = new ArrayBuffer(2);
    new DataView(b).setInt16(0, v, true);
    this.propsType.push(DT.INT16);
    this.propsData.push(new Uint8Array(b));
  }
  addInt32(v) {
    const b = new ArrayBuffer(4);
    new DataView(b).setInt32(0, v, true);
    this.propsType.push(DT.INT32);
    this.propsData.push(new Uint8Array(b));
  }
  addInt64(v) {
    const b = new ArrayBuffer(8);
    new DataView(b).setBigInt64(0, typeof v === 'bigint' ? v : BigInt(v), true);
    this.propsType.push(DT.INT64);
    this.propsData.push(new Uint8Array(b));
  }
  addFloat32(v) {
    const b = new ArrayBuffer(4);
    new DataView(b).setFloat32(0, v, true);
    this.propsType.push(DT.FLOAT32);
    this.propsData.push(new Uint8Array(b));
  }
  addFloat64(v) {
    const b = new ArrayBuffer(8);
    new DataView(b).setFloat64(0, v, true);
    this.propsType.push(DT.FLOAT64);
    this.propsData.push(new Uint8Array(b));
  }

  /** Raw bytes property (FBX type tag 'R'). */
  addBytes(u8) {
    const out = new Uint8Array(4 + u8.byteLength);
    new DataView(out.buffer).setUint32(0, u8.byteLength, true);
    out.set(u8, 4);
    this.propsType.push(DT.BYTES);
    this.propsData.push(out);
  }

  /** String property (FBX type tag 'S'). FBX strings are length-prefixed bytes. */
  addString(str) {
    const bytes = typeof str === 'string' ? TEXT_ENCODER.encode(str) : str;
    const out = new Uint8Array(4 + bytes.byteLength);
    new DataView(out.buffer).setUint32(0, bytes.byteLength, true);
    out.set(bytes, 4);
    this.propsType.push(DT.STRING);
    this.propsData.push(out);
  }


  /** Internal: encode a typed-array payload into FBX array prop format. */
  _addArray(typeTag, elementCount, rawBytes) {
    const uncompressed = new Uint8Array(rawBytes);
    let encoding;
    let body;
    if (uncompressed.byteLength > DT.ARRAY_COMPRESS_THRESHOLD) {
      const compressed = zlibSync(uncompressed, { level: 1 });
      encoding = 1;
      body = compressed;
    } else {
      encoding = 0;
      body = uncompressed;
    }
    const out = new Uint8Array(12 + body.byteLength);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, elementCount, true);
    dv.setUint32(4, encoding, true);
    dv.setUint32(8, body.byteLength, true);
    out.set(body, 12);
    this.propsType.push(typeTag);
    this.propsData.push(out);
  }

  addBoolArray(arr) {
    const u8 = arr instanceof Uint8Array
      ? arr
      : Uint8Array.from(arr, (x) => (x ? 1 : 0));
    this._addArray(DT.BOOL_ARRAY, u8.length, u8);
  }

  addByteArray(arr) {
    const u8 = arr instanceof Uint8Array ? arr : Uint8Array.from(arr);
    this._addArray(DT.BYTE_ARRAY, u8.length, u8);
  }

  addInt32Array(arr) {
    const ta = arr instanceof Int32Array ? arr : Int32Array.from(arr);
    this._addArray(DT.INT32_ARRAY, ta.length, ta.buffer.slice(ta.byteOffset, ta.byteOffset + ta.byteLength));
  }

  addInt64Array(arr) {
    const ta = arr instanceof BigInt64Array
      ? arr
      : BigInt64Array.from(arr as any, (x: any) => (typeof x === 'bigint' ? x : BigInt(x)));
    this._addArray(DT.INT64_ARRAY, ta.length, ta.buffer.slice(ta.byteOffset, ta.byteOffset + ta.byteLength));
  }

  addFloat32Array(arr) {
    const ta = arr instanceof Float32Array ? arr : Float32Array.from(arr);
    this._addArray(DT.FLOAT32_ARRAY, ta.length, ta.buffer.slice(ta.byteOffset, ta.byteOffset + ta.byteLength));
  }

  addFloat64Array(arr) {
    const ta = arr instanceof Float64Array ? arr : Float64Array.from(arr);
    this._addArray(DT.FLOAT64_ARRAY, ta.length, ta.buffer.slice(ta.byteOffset, ta.byteOffset + ta.byteLength));
  }


  /**
   * Recursively compute end offsets.
   * `ctx` carries the version-dependent meta + sentinel sizes.
   * `isLast` indicates whether this elem is the last sibling at its level.
   */
  _calcOffsets(offset, isLast, ctx) {
    offset += ctx.metaSize;
    offset += 1 + this._idBytes.length;

    let propsLength = 0;
    for (let i = 0; i < this.propsData.length; i++) {
      propsLength += 1 + this.propsData[i].byteLength;
    }
    this._propsLength = propsLength;
    offset += propsLength;

    offset = this._calcOffsetsChildren(offset, isLast, ctx);

    this._endOffset = offset;
    return offset;
  }

  _calcOffsetsChildren(offset, isLast, ctx) {
    if (this.elems.length > 0) {
      const last = this.elems.length - 1;
      for (let i = 0; i < this.elems.length; i++) {
        offset = this.elems[i]._calcOffsets(offset, i === last, ctx);
      }
      offset += ctx.sentinelSize;
    } else if ((this.propsData.length === 0 && !isLast) || ELEMS_ALWAYS_BLOCK_SENTINEL.has(this.id)) {
      offset += ctx.sentinelSize;
    }
    return offset;
  }

  /** Emit bytes into the BinaryWriter. */
  _write(bw, isLast, ctx) {
    if (this._endOffset < 0 || this._propsLength < 0) {
      throw new Error('_calcOffsets must run before _write');
    }

    if (ctx.use64) {
      bw.writeU64(BigInt(this._endOffset));
      bw.writeU64(BigInt(this.propsData.length));
      bw.writeU64(BigInt(this._propsLength));
    } else {
      bw.writeU32(this._endOffset);
      bw.writeU32(this.propsData.length);
      bw.writeU32(this._propsLength);
    }

    bw.writeU8(this._idBytes.length);
    bw.writeBytes(this._idBytes);

    for (let i = 0; i < this.propsData.length; i++) {
      bw.writeU8(this.propsType[i]);
      bw.writeBytes(this.propsData[i]);
    }

    this._writeChildren(bw, isLast, ctx);

    if (bw.tell() !== this._endOffset) {
      throw new Error(`FBXElem ${this.id}: end offset mismatch (expected ${this._endOffset}, got ${bw.tell()})`);
    }
  }

  _writeChildren(bw, isLast, ctx) {
    if (this.elems.length > 0) {
      const last = this.elems.length - 1;
      for (let i = 0; i < this.elems.length; i++) {
        this.elems[i]._write(bw, i === last, ctx);
      }
      bw.writeZeros(ctx.sentinelSize);
    } else if ((this.propsData.length === 0 && !isLast) || ELEMS_ALWAYS_BLOCK_SENTINEL.has(this.id)) {
      bw.writeZeros(ctx.sentinelSize);
    }
  }
}
