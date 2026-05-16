/**
 * Emit the `Connections` section.
 */

import { elemEmpty } from '../core/elemHelpers.js';

/**
 * @param {object} ctx
 * @param {FBXElem} ctx.root
 * @param {Array<[string, bigint, bigint, string?]>} ctx.connections
 */
export function writeConnectionsSection({ root, connections }) {
  const conns = elemEmpty(root, 'Connections');

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
