/**
 * Emit the `Definitions` section: one `ObjectType` per scene-used type, each
 * carrying a `PropertyTemplate` with that type's default property values.
 *
 * Mirrors `export_fbx_bin.py: fbx_definitions_elements` +
 * `fbx_utils.py: fbx_templates_generate`.
 */

import {
  elemEmpty,
  elemDataSingleInt32, elemDataSingleString,
  elemProperties, elemPropsSet,
} from '../core/elemHelpers.js';
import { FBX_TEMPLATES_VERSION } from '../constants.js';

/**
 * @param {object} ctx
 * @param {object} ctx.root
 * @param {import('../core/templates.js').TemplateBundle} ctx.templates
 */
export function writeDefinitionsSection({ root, templates }) {
  const defs = elemEmpty(root, 'Definitions');
  elemDataSingleInt32(defs, 'Version', FBX_TEMPLATES_VERSION);
  elemDataSingleInt32(defs, 'Count', templates.totalUsers());

  for (const [typeName, { totalUsers, dominant }] of templates.resolved()) {
    const objType = elemDataSingleString(defs, 'ObjectType', typeName);
    elemDataSingleInt32(objType, 'Count', totalUsers);
    dominant._written = true;

    if (!dominant.propTypeName || Object.keys(dominant.properties).length === 0) {
      continue;
    }

    const tmpl = elemDataSingleString(objType, 'PropertyTemplate', dominant.propTypeName);
    const props = elemProperties(tmpl);
    for (const [name, entry] of Object.entries(dominant.properties) as [string, any][]) {
      try {
        elemPropsSet(props, entry.ptype, name, entry.value, { animatable: entry.animatable });
      } catch (err: any) {
        console.warn(`Failed to write template prop ${typeName}.${name}: ${err.message}`);
      }
    }
  }
}
