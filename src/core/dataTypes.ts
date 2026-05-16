/**
 * FBX property type tags (single byte stored in front of each property in the binary stream).
 *
 * Scalars use uppercase ASCII; arrays use lowercase. Array properties are followed by a
 * `(length, encoding, comp_len)` header — see FBXElem._addArrayHelper.
 */

export const BOOL    = 'B'.charCodeAt(0);
export const CHAR    = 'C'.charCodeAt(0);
export const INT8    = 'Z'.charCodeAt(0);
export const INT16   = 'Y'.charCodeAt(0);
export const INT32   = 'I'.charCodeAt(0);
export const INT64   = 'L'.charCodeAt(0);
export const FLOAT32 = 'F'.charCodeAt(0);
export const FLOAT64 = 'D'.charCodeAt(0);
export const BYTES   = 'R'.charCodeAt(0);
export const STRING  = 'S'.charCodeAt(0);

export const INT32_ARRAY   = 'i'.charCodeAt(0);
export const INT64_ARRAY   = 'l'.charCodeAt(0);
export const FLOAT32_ARRAY = 'f'.charCodeAt(0);
export const FLOAT64_ARRAY = 'd'.charCodeAt(0);
export const BOOL_ARRAY    = 'b'.charCodeAt(0);
export const BYTE_ARRAY    = 'c'.charCodeAt(0);

/** Threshold above which array payloads are zlib-compressed (encoding=1). */
export const ARRAY_COMPRESS_THRESHOLD = 128;
