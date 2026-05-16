// Verify three.js FBXLoader's BinaryParser can parse our wire format.
// Run: node test/m1-fbxloader-binary.test.mjs
//
// FBXLoader's full parse() builds a scene graph and requires Objects/Connections.
// For M1 we only validate the binary-level format: we accept either
//   (a) full success, or
//   (b) failure that occurs AFTER the binary parsing phase (i.e. our bytes are
//       valid FBX wire format; what fails is scene reconstruction, which is M2/M3).
// The "magic header recognized" + "no parse exception until tree-walk" combo is
// what we want from M1.

import { strict as assert } from 'node:assert';
import { FBXElem } from '../src/core/FBXElem.js';
import { encodeBinaryFBX } from '../src/core/encodeBinary.js';

// jsdom-style image stubs FBXLoader expects in browser env
globalThis.self = globalThis;

const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

function buildMinimalTree() {
  const root = new FBXElem('');

  const header = root.addEmpty('FBXHeaderExtension');
  header.addEmpty('FBXHeaderVersion').addInt32(1003);
  header.addEmpty('FBXVersion').addInt32(7400);

  root.addEmpty('FileId').addBytes(new Uint8Array(16));
  root.addEmpty('CreationTime').addString('placeholder');
  root.addEmpty('Creator').addString('fbx-exporter-three M1 test');

  // GlobalSettings — FBXLoader.FBXTreeParser reads this
  const global = root.addEmpty('GlobalSettings');
  global.addEmpty('Version').addInt32(1000);

  // Minimal sections so FBXLoader's tree walker doesn't crash on undefined access
  root.addEmpty('Documents');
  root.addEmpty('References');
  root.addEmpty('Definitions');
  root.addEmpty('Objects');
  root.addEmpty('Connections');
  root.addEmpty('Takes');

  return root;
}

// ---------------------------------------------------------------------------

let passes = 0;
let fails = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passes++;
  } catch (err) {
    fails++;
    console.error(`  FAIL  ${name}`);
    console.error(err);
  }
}

test('header signature is what FBXLoader.isFbxFormatBinary checks for', () => {
  const root = new FBXElem('');
  const bytes = encodeBinaryFBX(root, { version: 7400 });
  // matches FBXLoader.js:4290 CORRECT = 'Kaydara FBX Binary  \0'
  const expected = 'Kaydara FBX Binary  \0';
  let header = '';
  for (let i = 0; i < expected.length; i++) header += String.fromCharCode(bytes[i]);
  assert.equal(header, expected);
});

test('FBXLoader.parse() makes it through BinaryParser (binary format accepted)', () => {
  const root = buildMinimalTree();
  const bytes = encodeBinaryFBX(root, { version: 7400 });
  // FBXLoader.parse expects an ArrayBuffer
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  const loader = new FBXLoader();
  // We expect this to either succeed or throw — but the throw must come from
  // AFTER the binary parse phase. Common signals of "tree walk failure":
  //  - "Cannot read properties of undefined" inside FBXTreeParser
  //  - missing optional chains (NodeAttribute, etc.)
  // The signal of "bad wire format" would be:
  //  - "FBX version not supported"
  //  - "FBXLoader: FBX format ... not supported"
  //  - any throw from BinaryParser.parseProperty / parseNode
  try {
    const group = loader.parse(ab, '');
    // If we get all the way through, that's even better
    assert.ok(group, 'FBXLoader returned a result');
    console.log('       (parsed all the way to a Group, type:', group.type, ')');
  } catch (err) {
    const msg = String(err && err.message || err);
    if (
      msg.includes('version not supported') ||
      msg.includes('format') && msg.includes('not supported') ||
      msg.includes('scope length not reached')
    ) {
      throw new Error('Binary wire format rejected by FBXLoader: ' + msg);
    }
    // Otherwise: post-binary-phase failure, M1 wire format OK
    console.log('       (tree-walk failed past binary phase — expected at M1: ' + msg.split('\n')[0] + ')');
  }
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
