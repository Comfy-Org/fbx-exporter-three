import { BinaryWriter } from './BinaryWriter.js';
import { FBXElem } from './FBXElem.js';
import * as DT from './dataTypes.js';

const TEXT_ENCODER = new TextEncoder();

// "Kaydara FBX Binary  \x00\x1a\x00" — 23-byte signature.
const HEAD_MAGIC = new Uint8Array([
  0x4b, 0x61, 0x79, 0x64, 0x61, 0x72, 0x61, 0x20,
  0x46, 0x42, 0x58, 0x20, 0x42, 0x69, 0x6e, 0x61,
  0x72, 0x79, 0x20, 0x20, 0x00, 0x1a, 0x00,
]);

// Blender uses these constants to bypass FBX's time-stamped CRC.
// See encode_bin.py: _TIME_ID, _FILE_ID, _FOOT_ID.
const TIME_ID = TEXT_ENCODER.encode('1970-01-01 10:00:00:000');
const FILE_ID = new Uint8Array([
  0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2,
  0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1,
]);
const FOOT_ID = new Uint8Array([
  0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66,
  0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e,
]);
const TAIL_MAGIC = new Uint8Array([
  0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e,
  0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b,
]);

function versionContext(version) {
  // FBX ≥ 7500 switches element meta to uint64 and sentinel from 13 → 25 bytes.
  if (version < 7500) {
    return { use64: false, metaSize: 12, sentinelSize: 13 };
  }
  return { use64: true, metaSize: 24, sentinelSize: 25 };
}

/**
 * Overwrite FileId and CreationTime properties on direct children of `root` with
 * Blender's fixed-value placeholders, so the file passes CRC even though we are
 * not computing time-based CRCs.
 *
 * No-op if either element is missing.
 */
function applyTimeHack(root) {
  let patched = 0;
  for (const elem of root.elems) {
    if (elem.id === 'FileId') {
      elem.propsType = [];
      elem.propsData = [];
      elem.addBytes(FILE_ID);
      patched++;
    } else if (elem.id === 'CreationTime') {
      elem.propsType = [];
      elem.propsData = [];
      elem.addString(TIME_ID);
      patched++;
    }
    if (patched === 2) break;
  }
}

/**
 * Serialize an FBXElem root tree to a binary FBX file buffer.
 *
 * `root` MUST be an FBXElem with an empty id (acts as an anonymous container of
 * top-level sections like FBXHeaderExtension, GlobalSettings, Documents, ...).
 *
 * Returns a Uint8Array.
 */
export function encodeBinaryFBX(root, { version = 7400 } = {}) {
  if (!(root instanceof FBXElem)) throw new TypeError('root must be an FBXElem');
  if (root.id !== '') throw new Error('root FBXElem must have an empty id');

  applyTimeHack(root);

  const ctx = versionContext(version);
  const bw = new BinaryWriter(64 * 1024);

  // ---- header ----
  bw.writeBytes(HEAD_MAGIC);
  bw.writeU32(version);

  // ---- compute child offsets relative to current file position ----
  root._calcOffsetsChildren(bw.tell(), false, ctx);

  // ---- emit children + trailing block sentinel ----
  root._writeChildren(bw, false, ctx);

  // ---- footer ----
  bw.writeBytes(FOOT_ID);
  bw.writeZeros(4);

  // padding to next 16-byte boundary; if already aligned, add a full 16 bytes
  const ofs = bw.tell();
  let pad = ((ofs + 15) & ~15) - ofs;
  if (pad === 0) pad = 16;
  bw.writeZeros(pad);

  bw.writeU32(version);
  bw.writeZeros(120);
  bw.writeBytes(TAIL_MAGIC);

  return bw.toUint8Array();
}

export const __testing__ = { HEAD_MAGIC, FOOT_ID, TAIL_MAGIC, TIME_ID, FILE_ID, versionContext };
