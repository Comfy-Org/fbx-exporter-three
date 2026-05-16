/**
 * Emit FBX `Texture` + `Video` nodes for a three.js Texture.
 *
 * Mirrors `export_fbx_bin.py: fbx_data_texture_file_elements` (lines 1681-
 * 1755) for Texture, `fbx_data_video_elements` (lines 1757-1809) for Video.
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

// Three.js texture wrap constants — mirror src/constants.js values:
// RepeatWrapping=1000, ClampToEdgeWrapping=1001, MirroredRepeatWrapping=1002
const THREE_REPEAT_WRAPPING = 1000;
const THREE_MIRRORED_REPEAT = 1002;

// FBX WrapMode enum: 0=Repeat, 1=Clamp.
// FBXLoader: `valueU === 0 ? RepeatWrapping : ClampToEdgeWrapping` (line 417).
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

  // Use texture.name as the identifier for attrName / TextureName / Media.
  // Rationale:
  //  - FBXLoader (FBXLoader.js:406) sets `imported.name = textureNode.attrName`,
  //    so writing texture.name → perfect texture-name round-trip.
  //  - Blender writes the Blender-specific Principled-BSDF socket name
  //    ("base_color_texture") which is tool-internal; ours is tool-internal
  //    too (three.js slot). texture.name is the user-controlled, tool-
  //    agnostic identifier — preferable to either.
  //  - Maya / Unreal use this string in their texture browsers, so a
  //    human-readable name is much friendlier than "map".
  const identityName = tex.name || `texture_${textureEntry.texUid}`;

  const node = parent.addEmpty('Texture');
  node.addInt64(textureEntry.texUid);
  node.addString(fbxNameClass(identityName, 'Texture'));
  node.addString('');

  // Top-level (non-Properties70) children. Order matches Blender exactly
  // (lines 1700-1705).
  elemDataSingleString(node, 'Type',             'TextureVideoClip');
  elemDataSingleInt32(node,  'Version',          FBX_TEXTURE_VERSION);
  elemDataSingleString(node, 'TextureName',      fbxNameClass(identityName, 'Texture'));
  // `Media`: Blender writes `fbx_name_class(img.name, "Video")` — the
  // underlying image name + "Video" class. Same idea here using texture.name.
  elemDataSingleString(node, 'Media',            fbxNameClass(identityName, 'Video'));
  // FileName + RelativeFilename: FBXLoader.loadTexture reads FileName for the
  // extension (FBXLoader.js:445), and the file itself comes from the connected
  // Video's Content. Both fields should point at the same name.
  elemDataSingleString(node, 'FileName',         fileName);
  elemDataSingleString(node, 'RelativeFilename', fileName);

  // Properties70 — UV transform, wrap modes, etc.
  const tmpl = templateInit(templates, 'Texture');
  const props = elemProperties(node);

  // AlphaSource: 0=None, 2=Black (= alpha channel). Blender writes 2 when
  // image has alpha (line 1713). We approximate via texture.format.
  const hasAlpha = textureEntry.imageBytes != null;  // PNG always has alpha
  templateSet(tmpl, props, 'p_enum', 'AlphaSource', hasAlpha ? 2 : 0);
  templateSet(tmpl, props, 'p_bool', 'PremultiplyAlpha', false);
  templateSet(tmpl, props, 'p_enum', 'CurrentMappingType', 0);  // UV
  templateSet(tmpl, props, 'p_enum', 'WrapModeU', fbxWrapModeFor(tex.wrapS));
  templateSet(tmpl, props, 'p_enum', 'WrapModeV', fbxWrapModeFor(tex.wrapT));

  // UV transform: three.js Texture has .offset (Vector2), .repeat (Vector2),
  // .rotation (number, radians). FBXLoader reads:
  //   Translation.value → texture.offset
  //   Scaling.value     → texture.repeat
  // (lines 421-435). Note: Rotation is read by some other importers but not
  // FBXLoader.
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
 * Mirrors fbx_data_video_elements (lines 1757-1809).
 *
 * Note that Blender writes a few top-level children OUTSIDE Properties70
 * (Type, UseMipMap, Filename, RelativeFilename, Content). FBXLoader reads
 * the same fields by name from the parsed FBXTree.
 */
export function writeVideo({ parent, textureEntry, templates }) {
  const fileName = textureEntry.fileName;
  const imageBytes = textureEntry.imageBytes;
  const identityName = textureEntry.texture.name || `texture_${textureEntry.vidUid}`;

  const node = parent.addEmpty('Video');
  node.addInt64(textureEntry.vidUid);
  node.addString(fbxNameClass(identityName, 'Video'));
  // Blender writes "Clip" as the subtype (line 1768).
  node.addString('Clip');

  elemDataSingleString(node, 'Type', 'Clip');

  // Properties70: just Path (= absolute filename).
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
