
import { strict as assert } from 'node:assert';
import { FBXElem } from '../src/core/FBXElem.js';
import { encodeBinaryFBX } from '../src/core/encodeBinary.js';

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

  const global = root.addEmpty('GlobalSettings');
  global.addEmpty('Version').addInt32(1000);

  root.addEmpty('Documents');
  root.addEmpty('References');
  root.addEmpty('Definitions');
  root.addEmpty('Objects');
  root.addEmpty('Connections');
  root.addEmpty('Takes');

  return root;
}


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
  const expected = 'Kaydara FBX Binary  \0';
  let header = '';
  for (let i = 0; i < expected.length; i++) header += String.fromCharCode(bytes[i]);
  assert.equal(header, expected);
});

test('FBXLoader.parse() makes it through BinaryParser (binary format accepted)', () => {
  const root = buildMinimalTree();
  const bytes = encodeBinaryFBX(root, { version: 7400 });
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  const loader = new FBXLoader();
  try {
    const group = loader.parse(ab, '');
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
    console.log('       (tree-walk failed past binary phase — expected at M1: ' + msg.split('\n')[0] + ')');
  }
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
