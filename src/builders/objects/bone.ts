/**
 * Bone → FBX `NodeAttribute` (LimbNode) node.
 *
 * Mirrors `export_fbx_bin.py: fbx_data_armature_elements` lines 1826-1842
 * (the "Bones data" sub-loop). Each Bone has:
 *   - NodeAttribute uid (separate from the Model uid),
 *   - subtype "LimbNode",
 *   - TypeFlags "Skeleton",
 *   - Properties70 from the Bone template (only `Size` is set per-instance;
 *     finalize emits anything else from the template).
 *
 * The Bone's own Model is written by writeModel (model.js) — the LimbNode
 * subtype is selected there.
 */

import {
  elemDataSingleString,
  elemProperties, fbxNameClass,
  templateInit, templateSet, templateFinalize,
} from '../../core/elemHelpers.js';

const BONE_RADIUS_SCALE = 33.0;

/**
 * @param {object} ctx
 * @param {FBXElem} ctx.parent       Objects container
 * @param {Bone}    ctx.bone         three.js Bone instance
 * @param {bigint}  ctx.attrUid      this NodeAttribute's allocated uid
 * @param {TemplateBundle} ctx.templates
 */
export function writeBoneAttribute({ parent, bone, attrUid, templates }) {
  const node = parent.addEmpty('NodeAttribute');
  node.addInt64(attrUid);
  node.addString(fbxNameClass(bone.name || 'Bone', 'NodeAttribute'));
  node.addString('LimbNode');

  // TypeFlags is a top-level child (NOT inside Properties70) — matches Blender.
  elemDataSingleString(node, 'TypeFlags', 'Skeleton');

  const tmpl = templateInit(templates, 'NodeAttribute');
  const props = elemProperties(node);
  // Blender writes `Size = bone.head_radius * 33.0`. three.js Bone has no
  // intrinsic radius, so we use a constant default (this matches what most
  // skin-only exporters do). Real bone-length encoding can come later.
  templateSet(tmpl, props, 'p_double', 'Size', BONE_RADIUS_SCALE);
  templateFinalize(tmpl, props);
}
