// M9 follow-up: verify every TEXTURE_SLOTS entry uses an FBX OP relationship
// name that three.js FBXLoader's parseParameters actually switches on
// (FBXLoader.js:660-728). A serialised texture connected via the "right"
// name still produces a valid FBX file, but the imported material loses
// the slot mapping silently — see Bug #21 (aoMap was wired to
// `AmbientColor` which falls into FBXLoader's default case).
//
// Run: node test/m9-slot-roundtrip.test.mjs

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.self = globalThis;
globalThis.window = { innerWidth: 1920, innerHeight: 1080, URL: globalThis.URL };

const THREE = await import('three');
THREE.ColorManagement.enabled = false;

const { TEXTURE_SLOTS } = await import('../src/data/textureCollector.js');

let passes = 0, fails = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passes++; }
  catch (e) { fails++; console.error(`  FAIL  ${name}`); console.error('       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); }
}

// ----------------------------------------------------------------------------
// Build the set of relationship names FBXLoader's parseParameters explicitly
// case-matches. Read the source to keep the set in sync with the version of
// three.js we're testing against, rather than hard-coding.
// ----------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const loaderPath = resolve(__dirname, '../node_modules/three/examples/jsm/loaders/FBXLoader.js');
const loaderSrc = readFileSync(loaderPath, 'utf8');

// Locate parseParameters(...) — find the *function definition*, not the
// call site. The declaration is preceded by a tab (method on a class).
const ppDecl = loaderSrc.indexOf('\tparseParameters(');
assert.ok(ppDecl > 0, 'could not locate parseParameters method declaration');
const ppBody = loaderSrc.slice(ppDecl);
// End of method: first occurrence of `\n\t}` followed by another method
// declaration is too noisy; instead bound by the next top-level method
// (parseAnimations) starting at column 1 tab.
const ppEnd = ppBody.indexOf('\n\tparse', 1);
const ppBlock = ppBody.slice(0, ppEnd > 0 ? ppEnd : ppBody.length);

// A case is "truly handled" if its effective body — including any
// fall-through bodies from subsequent stacked `case 'X':` labels — sets
// `parameters.<slot> = ...` before hitting `break;` or `default:`.
//
// Pattern in FBXLoader.js for DiffuseColor + Maya|TEX_color_map:
//   case 'DiffuseColor':
//   case 'Maya|TEX_color_map':
//     parameters.map = ...
//     break;
// Both cases share the body; both are "handled".
const TRULY_HANDLED = new Set();
const caseRegex = /case '([^']+)':/g;
const matches = [...ppBlock.matchAll(caseRegex)].map((m) => ({ name: m[1], at: m.index }));
for (let i = 0; i < matches.length; i++) {
  const start = matches[i].at;
  const tail = ppBlock.slice(start);
  const nextBreak = tail.indexOf('break;');
  const nextDefault = tail.indexOf('default:');
  const stops = [nextBreak, nextDefault].filter((x) => x >= 0);
  const end = stops.length ? Math.min(...stops) : tail.length;
  const body = tail.slice(0, end);
  if (/parameters\.\w+\s*=/.test(body)) TRULY_HANDLED.add(matches[i].name);
}

console.log(`FBXLoader handled relationship names (${TRULY_HANDLED.size}):`);
console.log(`  ${[...TRULY_HANDLED].sort().join(', ')}\n`);

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

test('every TEXTURE_SLOTS value is in FBXLoader\'s parseParameters truly-handled cases', () => {
  for (const [threeSlot, fbxSlot] of Object.entries(TEXTURE_SLOTS)) {
    assert.ok(TRULY_HANDLED.has(fbxSlot),
      `${threeSlot} → ${fbxSlot}: not a parseParameters target (lost on round-trip via FBXLoader)`);
  }
});

test('aoMap specifically uses Maya|TEX_ao_map (regression: was AmbientColor)', () => {
  // FBXLoader.js:725 puts AmbientColor in the default fall-through; only
  // Maya|TEX_ao_map (line 664) wires to aoMap.
  assert.equal(TEXTURE_SLOTS.aoMap, 'Maya|TEX_ao_map');
});

test('alphaMap uses TransparentColor (FBXLoader handles this AND TransparencyFactor)', () => {
  // Both names lead to aoMap in FBXLoader.js:719-722. Either works; we
  // pick TransparentColor for Blender/Maya compatibility.
  assert.equal(TEXTURE_SLOTS.alphaMap, 'TransparentColor');
});

test('displacementMap + envMap are wired (regression: were missing entirely)', () => {
  assert.equal(TEXTURE_SLOTS.displacementMap, 'DisplacementColor');
  assert.equal(TEXTURE_SLOTS.envMap,          'ReflectionColor');
});

test('PBR maps (metalnessMap / roughnessMap) are NOT in TEXTURE_SLOTS', () => {
  // FBXLoader has no parseParameters case for the FBX scalar-texture slots
  // Blender uses (Shininess, ReflectionFactor); they would round-trip as
  // lost data. Document this gap by asserting we don't pretend otherwise.
  assert.ok(!('metalnessMap' in TEXTURE_SLOTS));
  assert.ok(!('roughnessMap' in TEXTURE_SLOTS));
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
