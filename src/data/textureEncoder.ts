/**
 * Minimal PNG encoder + canvas-based fallback for converting three.js
 * textures into bytes that FBX can embed.
 *
 * Why custom: GLTFExporter uses HTMLCanvasElement.toBlob, which is browser-
 * only. Our exporter has to also work in Node for tests. DataTexture
 * (raw pixels in a Uint8Array) is the only thing we can reliably encode in
 * Node without a JSDOM/canvas-node setup, so we write a tiny PNG encoder
 * for that path. Browser textures (HTMLImageElement / ImageBitmap / canvas
 * sources) still go through the canvas path.
 */

import { zlibSync } from 'fflate';

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// CRC-32 (PNG uses the standard ITU-T V.42 polynomial 0xEDB88320 reversed).
// ---------------------------------------------------------------------------

let _crcTable = null;
function ensureCrcTable() {
  if (_crcTable) return _crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  _crcTable = t;
  return t;
}

function crc32(buf) {
  const t = ensureCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (t[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG chunk writer.
// ---------------------------------------------------------------------------

function writeChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  if (typeBytes.length !== 4) throw new Error(`PNG chunk type must be 4 bytes, got ${type}`);
  const out = new Uint8Array(4 + 4 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);   // big-endian length
  out.set(typeBytes, 4);
  out.set(data, 8);
  // CRC over type + data.
  const crcBuf = new Uint8Array(4 + data.length);
  crcBuf.set(typeBytes, 0);
  crcBuf.set(data, 4);
  dv.setUint32(8 + data.length, crc32(crcBuf), false);
  return out;
}

function concat(buffers) {
  let n = 0;
  for (const b of buffers) n += b.length;
  const out = new Uint8Array(n);
  let offset = 0;
  for (const b of buffers) { out.set(b, offset); offset += b.length; }
  return out;
}

/**
 * Encode an RGBA8 pixel buffer to a PNG bytes blob.
 *
 * Input: `rgba` is a Uint8Array of length `width × height × 4` with
 * row-major layout (row 0 at the top — same convention as the canvas
 * 2D context and three.js `DataTexture.image.data` when `flipY === false`).
 */
export function encodeRGBA8PNG(rgba, width, height) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`PNG: expected ${width * height * 4} RGBA bytes, got ${rgba.length}`);
  }

  // Filtered scanlines: PNG filter type 0 (None) per row.
  const stride = width * 4;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0;  // filter: None
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1);
  }
  const idat = zlibSync(raw, { level: 6 });

  // IHDR (13 bytes): width(u32 BE), height(u32 BE), bit depth, color type,
  // compression, filter, interlace.
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: 6 = RGBA
  ihdr[10] = 0;  // compression: deflate
  ihdr[11] = 0;  // filter: standard
  ihdr[12] = 0;  // interlace: none

  return concat([
    PNG_SIGNATURE,
    writeChunk('IHDR', ihdr),
    writeChunk('IDAT', idat),
    writeChunk('IEND', new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Source dispatch — read pixels from various three.js Texture sources.
// ---------------------------------------------------------------------------

/**
 * Encode any three.js Texture to PNG bytes.
 *
 * @returns {Promise<{ bytes: Uint8Array, extension: string }>}
 */
export async function encodeTexture(texture) {
  // 1. DataTexture (preferred — works everywhere, no canvas needed).
  //    Three.js DataTexture stores image as { data: Uint8Array, width, height }.
  if (texture.isDataTexture || (texture.image && texture.image.data instanceof Uint8Array)) {
    const { data, width, height } = texture.image;
    if (data.length !== width * height * 4) {
      throw new Error(
        `DataTexture must be RGBAFormat / UnsignedByteType for PNG embedding ` +
        `(got data ${data.length} bytes for ${width}×${height}; expected ${width * height * 4})`,
      );
    }
    return { bytes: encodeRGBA8PNG(data, width, height), extension: 'png' };
  }

  // 2. Canvas / Image / ImageBitmap → encode via canvas.toBlob (browser).
  const src = texture.image;
  if (!src) throw new Error('Texture has no image source');

  // OffscreenCanvas first (modern browsers + workers).
  if (typeof OffscreenCanvas !== 'undefined') {
    const w = src.width  || src.naturalWidth  || 0;
    const h = src.height || src.naturalHeight || 0;
    if (!w || !h) throw new Error(`Texture image has zero size (${w}×${h})`);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, extension: 'png' };
  }

  // Legacy HTMLCanvasElement.
  if (typeof document !== 'undefined') {
    const w = src.width  || src.naturalWidth  || 0;
    const h = src.height || src.naturalHeight || 0;
    if (!w || !h) throw new Error(`Texture image has zero size (${w}×${h})`);
    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(src, 0, 0);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) return reject(new Error('canvas.toBlob returned null'));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        resolve({ bytes, extension: 'png' });
      }, 'image/png');
    });
  }

  throw new Error(
    'Cannot encode texture: not a DataTexture and no canvas API available. ' +
    'In Node, use THREE.DataTexture; in browser, ensure canvas is supported.',
  );
}
