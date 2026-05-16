/**
 * Emit FBX `Texture` + `Video` nodes for a three.js Texture.
 *
 * Texture node carries UV transform, wrap modes and the filename hint
 * FBXLoader uses to pick a TextureLoader. Video node carries the actual
 * `Content` bytes when embedded.
 *
 * Connection direction (handled in textureCollector / SceneCollector):
 *   OO  Video   → Texture   (FBXLoader.loadTexture reads `connections.get(tex.id).children[0]`)
 *   OP  Texture → Material  (relationship name picks the material slot)
 */

import {
  elemDataSingleInt32, elemDataSingleString, elemDataSingleBytes,
  elemProperties, fbxNameClass,
  templateInit, templateSet, templateFinalize,
} from '../../core/elemHelpers.js';
import { FBX_TEXTURE_VERSION } from '../../constants.js';

const THREE_REPEAT_WRAPPING = 1000;
const THREE_MIRRORED_REPEAT = 1002;

function fbxWrapModeFor(threeWrap) {
  if (threeWrap === THREE_REPEAT_WRAPPING || threeWrap === THREE_MIRRORED_REPEAT) return 0;
  return 1;
}

/**
 * @param {object} ctx
 * @param {FBXElem} ctx.parent
 * @param {object}  ctx.textureEntry  output of textureCollector.collectTextures
 * @param {TemplateBundle} ctx.templates
 */
export function writeTexture({ parent, textureEntry, templates }) {
  const tex = textureEntry.texture;
  const fileName = textureEntry.fileName;

  const identityName = tex.name || `texture_${textureEntry.texUid}`;

  const node = parent.addEmpty('Texture');
  node.addInt64(textureEntry.texUid);
  node.addString(fbxNameClass(identityName, 'Texture'));
  node.addString('');

  elemDataSingleString(node, 'Type',             'TextureVideoClip');
  elemDataSingleInt32(node,  'Version',          FBX_TEXTURE_VERSION);
  elemDataSingleString(node, 'TextureName',      fbxNameClass(identityName, 'Texture'));
  elemDataSingleString(node, 'Media',            fbxNameClass(identityName, 'Video'));
  elemDataSingleString(node, 'FileName',         fileName);
  elemDataSingleString(node, 'RelativeFilename', fileName);

  const tmpl = templateInit(templates, 'Texture');
  const props = elemProperties(node);

  const hasAlpha = textureEntry.imageBytes != null;
  templateSet(tmpl, props, 'p_enum', 'AlphaSource', hasAlpha ? 2 : 0);
  templateSet(tmpl, props, 'p_bool', 'PremultiplyAlpha', false);
  templateSet(tmpl, props, 'p_enum', 'CurrentMappingType', 0);
  templateSet(tmpl, props, 'p_enum', 'WrapModeU', fbxWrapModeFor(tex.wrapS));
  templateSet(tmpl, props, 'p_enum', 'WrapModeV', fbxWrapModeFor(tex.wrapT));

  const off = tex.offset || { x: 0, y: 0 };
  const rep = tex.repeat || { x: 1, y: 1 };
  const rot = tex.rotation ?? 0;
  templateSet(tmpl, props, 'p_vector_3d', 'Translation', [off.x, off.y, 0]);
  templateSet(tmpl, props, 'p_vector_3d', 'Rotation',    [0, 0, -rot]);
  templateSet(tmpl, props, 'p_vector_3d', 'Scaling',     [rep.x, rep.y, 1]);

  templateSet(tmpl, props, 'p_bool', 'UseMaterial', true);
  templateSet(tmpl, props, 'p_bool', 'UseMipMap',   false);
  templateFinalize(tmpl, props);
}

/**
 * Emit the Video node carrying (optionally) the embedded image bytes.
 */
export function writeVideo({ parent, textureEntry, templates }) {
  const fileName = textureEntry.fileName;
  const imageBytes = textureEntry.imageBytes;
  const identityName = textureEntry.texture.name || `texture_${textureEntry.vidUid}`;

  const node = parent.addEmpty('Video');
  node.addInt64(textureEntry.vidUid);
  node.addString(fbxNameClass(identityName, 'Video'));
  node.addString('Clip');

  elemDataSingleString(node, 'Type', 'Clip');

  const tmpl = templateInit(templates, 'Video');
  const props = elemProperties(node);
  templateSet(tmpl, props, 'p_string_url', 'Path', fileName);
  templateFinalize(tmpl, props);

  elemDataSingleInt32(node,  'UseMipMap',         0);
  elemDataSingleString(node, 'Filename',          fileName);
  elemDataSingleString(node, 'RelativeFilename',  fileName);
  if (imageBytes != null) {
    elemDataSingleBytes(node, 'Content', imageBytes);
  }
}
