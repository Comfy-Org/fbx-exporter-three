/**
 * Emit the `Connections` section.
 *
 * Each entry from SceneCollector.connections is a tuple matching Blender's
 * format `(c_type, uid_src, uid_dst, prop_name?)` — see
 * `fbx_utils.py: elem_connection` (line 512).
 *
 * Mirrors `export_fbx_bin.py: fbx_connections_elements` (line 3458).
 */

import { elemEmpty } from '../core/elemHelpers.js';

/**
 * @param {object} ctx
 * @param {FBXElem} ctx.root
 * @param {Array<[string, bigint, bigint, string?]>} ctx.connections
 */
export function writeConnectionsSection({ root, connections }) {
  const conns = elemEmpty(root, 'Connections');

  // FBXLoader.parseConnections (FBXLoader.js:213-247) reads
  // `fbxTree.Connections.connections` and calls `.forEach` on it without a
  // null check; the field only exists if at least one `C` child was present
  // during binary parsing (FBXLoader.js:3844-3850). For empty scenes we emit
  // a harmless "self-connection" stub: OO 0 → 0 references the document
  // RootNode and is dropped during scene reconstruction.
  if (connections.length === 0) {
    const stub = conns.addEmpty('C');
    stub.addString('OO');
    stub.addInt64(0n);
    stub.addInt64(0n);
    return;
  }

  for (const [cType, src, dst, propName] of connections) {
    const c = conns.addEmpty('C');
    c.addString(cType);
    c.addInt64(src);
    c.addInt64(dst);
    if (propName != null) c.addString(propName);
  }
}
