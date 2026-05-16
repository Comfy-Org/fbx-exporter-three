
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


const __dirname = dirname(fileURLToPath(import.meta.url));
const loaderPath = resolve(__dirname, '../node_modules/three/examples/jsm/loaders/FBXLoader.js');
const loaderSrc = readFileSync(loaderPath, 'utf8');

const ppDecl = loaderSrc.indexOf('\tparseParameters(');
assert.ok(ppDecl > 0, 'could not locate parseParameters method declaration');
const ppBody = loaderSrc.slice(ppDecl);
const ppEnd = ppBody.indexOf('\n\tparse', 1);
const ppBlock = ppBody.slice(0, ppEnd > 0 ? ppEnd : ppBody.length);

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


test('every TEXTURE_SLOTS value is in FBXLoader\'s parseParameters truly-handled cases', () => {
  for (const [threeSlot, fbxSlot] of Object.entries(TEXTURE_SLOTS)) {
    assert.ok(TRULY_HANDLED.has(fbxSlot),
      `${threeSlot} → ${fbxSlot}: not a parseParameters target (lost on round-trip via FBXLoader)`);
  }
});

test('aoMap specifically uses Maya|TEX_ao_map (regression: was AmbientColor)', () => {
  assert.equal(TEXTURE_SLOTS.aoMap, 'Maya|TEX_ao_map');
});

test('alphaMap uses TransparentColor (FBXLoader handles this AND TransparencyFactor)', () => {
  assert.equal(TEXTURE_SLOTS.alphaMap, 'TransparentColor');
});

test('displacementMap + envMap are wired (regression: were missing entirely)', () => {
  assert.equal(TEXTURE_SLOTS.displacementMap, 'DisplacementColor');
  assert.equal(TEXTURE_SLOTS.envMap,          'ReflectionColor');
});

test('PBR maps (metalnessMap / roughnessMap) are NOT in TEXTURE_SLOTS', () => {
  assert.ok(!('metalnessMap' in TEXTURE_SLOTS));
  assert.ok(!('roughnessMap' in TEXTURE_SLOTS));
});

console.log(`\n${passes}/${passes + fails} passed`);
if (fails > 0) process.exit(1);
