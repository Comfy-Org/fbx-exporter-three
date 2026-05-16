// M2 integration test: build a minimal-but-complete FBX file using the new
// header/definitions builders and confirm three.js FBXLoader.parse() returns
// a Group rather than throwing.
//
// Run with: node test/m2-integration.test.mjs

import { strict as assert } from 'node:assert';

import { FBXElem } from '../src/core/FBXElem.js';
import { encodeBinaryFBX } from '../src/core/encodeBinary.js';
import { UidRegistry, entityKey, geometryKey, __testing__ } from '../src/core/uid.js';
import {
  TemplateBundle,
  modelTemplate,
  geometryTemplate,
  materialTemplate,
} from '../src/core/templates.js';
import { writeHeaderSection } from '../src/builders/header.js';
import { writeDefinitionsSection } from '../src/builders/definitions.js';

// FBXLoader expects globals from browser env
globalThis.self = globalThis;

const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

let passes = 0, fails = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${name}`); console.error(e); }
}

// ---------------------------------------------------------------------------
// 1. UidRegistry: stable, collision-resistant
// ---------------------------------------------------------------------------
test('UidRegistry returns same UID for same key', () => {
  const r = new UidRegistry();
  const a = r.get('BMesh#abc');
  const b = r.get('BMesh#abc');
  assert.equal(a, b);
});

test('UidRegistry produces distinct UIDs for distinct keys', () => {
  const r = new UidRegistry();
  const a = r.get(entityKey('mesh', 'A'));
  const b = r.get(entityKey('mesh', 'B'));
  const c = r.get(geometryKey('A'));
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('UidRegistry deterministic across instances (FNV-1a baseline)', () => {
  const r1 = new UidRegistry();
  const r2 = new UidRegistry();
  for (const k of ['foo', 'bar', 'baz#123', 'BMesh#abc|Geometry']) {
    assert.equal(r1.get(k), r2.get(k), `mismatch for key ${k}`);
  }
});

test('UidRegistry handles collision via linear probing', () => {
  const r = new UidRegistry();
  // Force a collision by pre-occupying a known UID
  const k1 = 'collision-source-A';
  const u1 = r.get(k1);
  // monkey-patch the cache to simulate another key already owning u1+1
  r._uidToKey.set(u1 + 1n, 'fake-occupant');
  // shouldn't throw; should produce a different UID
  const u2 = r.get('collision-source-B');
  assert.notEqual(u2, u1);
  assert.notEqual(u2, u1 + 1n);
});

// ---------------------------------------------------------------------------
// 2. TemplateBundle: user counts + dominant subtype selection
// ---------------------------------------------------------------------------
test('TemplateBundle accumulates users and picks dominant subtype', () => {
  const bundle = new TemplateBundle();
  const mt = bundle.register(materialTemplate({}));
  mt.users += 3;
  const gt = bundle.register(geometryTemplate({}));
  gt.users += 1;

  const r = bundle.resolved();
  assert.equal(r.get('Material').totalUsers, 3);
  assert.equal(r.get('Geometry').totalUsers, 1);
  assert.equal(bundle.totalUsers(), 4);
});

// ---------------------------------------------------------------------------
// 3. Header + Definitions + FBXLoader.parse → Group
// ---------------------------------------------------------------------------

function buildEmptySceneFBX() {
  const root = new FBXElem('');
  const settings = { version: 7400, axisUp: 'Y', axisForward: 'Z', unitScale: 1.0, fps: 24 };

  writeHeaderSection({ root, settings, sceneName: 'TestScene' });

  // We need Definitions even when scene is empty (some importers care).
  // Register a Model template with 1 user to mirror the implicit root node.
  const templates = new TemplateBundle();
  templates.register(modelTemplate(settings)).users = 1;
  writeDefinitionsSection({ root, templates });

  root.addEmpty('Objects');
  // Connections needs at least one "C" record so FBXLoader's
  //   rawConnections = fbxTree.Connections.connections (array)
  // is defined. We supply a dummy self-connection — discarded by parseScene.
  const conns = root.addEmpty('Connections');
  const c = conns.addEmpty('C');
  c.addString('OO');
  c.addInt64(0n);
  c.addInt64(0n);

  return encodeBinaryFBX(root, { version: settings.version });
}

test('FBXLoader produces a Group from a minimal scene', () => {
  const bytes = buildEmptySceneFBX();
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  const loader = new FBXLoader();
  const group = loader.parse(ab, '');

  assert.ok(group, 'expected a Group from FBXLoader');
  assert.equal(group.type, 'Group');
  // Useful side data the loader extracts from GlobalSettings:
  assert.equal(group.userData.unitScaleFactor, 1.0);
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
