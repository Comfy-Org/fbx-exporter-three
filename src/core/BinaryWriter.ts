/**
 * Little-endian binary stream writer backed by a growing ArrayBuffer.
 *
 * Designed to mirror Python's `struct.pack('<...')` patterns used in Blender's
 * `io_scene_fbx/encode_bin.py`.
 */

const TEXT_ENCODER = new TextEncoder();

export class BinaryWriter {
  _buf: ArrayBuffer;
  _view: DataView;
  _u8: Uint8Array;
  _offset: number;

  constructor(initialCapacity = 4096) {
    this._buf = new ArrayBuffer(initialCapacity);
    this._view = new DataView(this._buf);
    this._u8 = new Uint8Array(this._buf);
    this._offset = 0;
  }

  get length(): number {
    return this._offset;
  }

  tell(): number {
    return this._offset;
  }

  _ensure(n: number): void {
    const need = this._offset + n;
    if (need <= this._buf.byteLength) return;
    let cap = this._buf.byteLength;
    while (cap < need) cap *= 2;
    const nb = new ArrayBuffer(cap);
    new Uint8Array(nb).set(this._u8);
    this._buf = nb;
    this._view = new DataView(nb);
    this._u8 = new Uint8Array(nb);
  }

  // ---- scalar writers (little-endian) ----

  writeU8(v: number): void  { this._ensure(1); this._view.setUint8(this._offset, v);            this._offset += 1; }
  writeI8(v: number): void  { this._ensure(1); this._view.setInt8(this._offset, v);             this._offset += 1; }
  writeU16(v: number): void { this._ensure(2); this._view.setUint16(this._offset, v, true);     this._offset += 2; }
  writeI16(v: number): void { this._ensure(2); this._view.setInt16(this._offset, v, true);      this._offset += 2; }
  writeU32(v: number): void { this._ensure(4); this._view.setUint32(this._offset, v, true);     this._offset += 4; }
  writeI32(v: number): void { this._ensure(4); this._view.setInt32(this._offset, v, true);      this._offset += 4; }
  writeF32(v: number): void { this._ensure(4); this._view.setFloat32(this._offset, v, true);    this._offset += 4; }
  writeF64(v: number): void { this._ensure(8); this._view.setFloat64(this._offset, v, true);    this._offset += 8; }

  writeU64(v: number | bigint): void {
    this._ensure(8);
    this._view.setBigUint64(this._offset, typeof v === 'bigint' ? v : BigInt(v), true);
    this._offset += 8;
  }
  writeI64(v: number | bigint): void {
    this._ensure(8);
    this._view.setBigInt64(this._offset, typeof v === 'bigint' ? v : BigInt(v), true);
    this._offset += 8;
  }

  /** Append raw bytes (Uint8Array). */
  writeBytes(u8: Uint8Array): void {
    this._ensure(u8.byteLength);
    this._u8.set(u8, this._offset);
    this._offset += u8.byteLength;
  }

  /** Append a UTF-8 encoded string with no length prefix. */
  writeUtf8(str: string): void {
    this.writeBytes(TEXT_ENCODER.encode(str));
  }

  /** Fill N zero bytes. */
  writeZeros(n: number): void {
    this._ensure(n);
    this._u8.fill(0, this._offset, this._offset + n);
    this._offset += n;
  }

  /** Return a tightly-sized Uint8Array view of the written bytes. */
  toUint8Array(): Uint8Array {
    return this._u8.slice(0, this._offset);
  }

  /** Return a tightly-sized ArrayBuffer. */
  toArrayBuffer(): ArrayBufferLike {
    return this.toUint8Array().buffer;
  }
}
