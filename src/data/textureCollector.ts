/**
 * Detect textures on three.js materials and build a plan of FBX
 * Texture + Video records to emit.
 *
 * Mirrors Blender's `fbx_data_texture_file_elements` (export_fbx_bin.py:
 * 1681-1755) + `fbx_data_video_elements` (lines 1757-1809), plus the
 * connections at lines 3149-3159:
 *
 *   OP  Texture → Material   relationship: "DiffuseColor" / "NormalMap" / ...
 *   OO  Video   → Texture
 *
 * Three.js material slot → FBX property name mapping is derived from
 * FBXLoader.parseParameters (FBXLoader.js:668-723) — we round-trip with
 * the same names the loader recognises.
 *
 * Texture encoding is asynchronous (canvas.toBlob is async) so this module
 * exposes two phases:
 *   - collectTextures(...)        synchronous: detect, allocate UIDs, build
 *                                  connections.
 *   - encodeTextures(plan)        async: fills in the per-texture image
 *                                  bytes by calling textureEncoder.encodeTexture.
 */

import {
  UidRegistry,
  textureKey, videoKey,
} from '../core/uid.js';
import { textureTemplate, videoTemplate } from '../core/templates.js';
import { encodeTexture } from './textureEncoder.js';

// Three.js material slot → FBX OP relationship name. Each entry must use
// the exact connection name FBXLoader's parseParameters switches on
// (FBXLoader.js:660-728), otherwise the texture serialises but doesn't
// round-trip.
export const TEXTURE_SLOTS = {
  map:             'DiffuseColor',          // FBXLoader.js:670
  emissiveMap:     'EmissiveColor',         // FBXLoader.js:683
  normalMap:       'NormalMap',             // FBXLoader.js:693
  bumpMap:         'Bump',                  // (parsed by FBXLoader as bumpMap)
  alphaMap:        'TransparentColor',      // FBXLoader.js:719 (also accepts 'TransparencyFactor')
  specularMap:     'SpecularColor',         // FBXLoader.js:709
  aoMap:           'Maya|TEX_ao_map',       // FBXLoader.js:664 — 'AmbientColor' falls into the default case
  displacementMap: 'DisplacementColor',     // FBXLoader.js:679
  envMap:          'ReflectionColor',       // FBXLoader.js:698
  // metalnessMap / roughnessMap have no FBXLoader slot — `ShininessExponent`
  // and `SpecularFactor` are read as scalars only; their texture
  // connections fall into the default case (FBXLoader.js:726-728). Skipping.
};

/**
 * Synchronously detect every texture used by `materials` and allocate the
 * FBX-side UIDs + connections. The texture-image bytes are filled in later
 * by `encodeTextures` (async).
 *
 * @param {object} ctx
 * @param {Map<Material, {uid: bigint}>} ctx.materials  output of SceneCollector
 * @param {UidRegistry}    ctx.uids
 * @param {TemplateBundle} ctx.templates
 * @param {Array<[string, bigint, bigint, string?]>} ctx.connections
 * @returns {object} plan — `{ textures: Map<Texture, entry> }`
 */
export function collectTextures({ materials, uids, templates, connections }) {
  /** @type {Map<Texture, {texUid, vidUid, slotName, materials, image?, extension?, name}>} */
  const textures = new Map();

  for (const [material, matEntry] of materials) {
    for (const slot of Object.keys(TEXTURE_SLOTS)) {
      const tex = material[slot];
      if (!tex || !tex.isTexture) continue;

      let entry = textures.get(tex);
      if (!entry) {
        const tName = tex.name || `texture_${textures.size}`;
        entry = {
          texUid:    uids.get(textureKey(tex.uuid)),
          vidUid:    uids.get(videoKey(tex.uuid)),
          texture:   tex,
          slotName:  slot,
          fileName:  `${sanitizeFilename(tName)}.png`,
          // Filled later by encodeTextures.
          imageBytes: null,
          extension:  'png',
        };
        textures.set(tex, entry);
        templates.register(textureTemplate({})).users += 1;
        templates.register(videoTemplate({})).users   += 1;

        // OO Video → Texture (export_fbx_bin.py:3158-3159). FBXLoader's
        // loadTexture walks `connections.get(textureID).children[0]` to find
        // the Video ID, so direction matters: Video is the "child".
        connections.push(['OO', entry.vidUid, entry.texUid]);
      }

      // OP Texture → Material with the FBX property name FBXLoader expects.
      const fbxProp = TEXTURE_SLOTS[slot];
      connections.push(['OP', entry.texUid, matEntry.uid, fbxProp]);
    }
  }

  return { textures };
}

/**
 * Asynchronously encode every texture in the plan. Run before passing the
 * plan to writeFBX so the Video Content bytes are populated.
 */
export async function encodeTextures(plan) {
  if (!plan || !plan.textures) return;
  await Promise.all([...plan.textures.values()].map(async (entry: any) => {
    try {
      const result: any = await encodeTexture(entry.texture);
      entry.imageBytes = result.bytes;
      entry.extension  = result.extension;
      if (entry.fileName && !entry.fileName.endsWith(`.${entry.extension}`)) {
        entry.fileName = entry.fileName.replace(/\.[^.]+$/, '') + '.' + entry.extension;
      }
    } catch (err) {
      // Embedding failed — keep the texture metadata but write no Content.
      // The FBX file will still have a Texture + Video pair referencing the
      // expected filename; the user can place an external file there.
      console.warn(`fbx-exporter-three: failed to embed texture "${entry.texture.name || '<unnamed>'}": ${err.message}`);
      entry.imageBytes = null;
    }
  }));
}

function sanitizeFilename(name) {
  return String(name).replace(/[^a-zA-Z0-9_\-]/g, '_');
}
