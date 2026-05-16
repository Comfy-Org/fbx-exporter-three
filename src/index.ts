export { FBXElem } from './core/FBXElem.js';
export { BinaryWriter } from './core/BinaryWriter.js';
export { encodeBinaryFBX } from './core/encodeBinary.js';
export * as DataTypes from './core/dataTypes.js';

export { UidRegistry } from './core/uid.js';
export * as KeyBuilders from './core/uid.js';
export * as ElemHelpers from './core/elemHelpers.js';
export * as Templates from './core/templates.js';
export { TemplateBundle } from './core/templates.js';

export { writeHeaderSection } from './builders/header.js';
export { writeDefinitionsSection } from './builders/definitions.js';
export { writeConnectionsSection } from './builders/connections.js';
export { writeGeometry } from './builders/objects/geometry.js';
export { writeModel, writeNullAttribute } from './builders/objects/model.js';
export { writeMaterial } from './builders/objects/material.js';
export { writeBoneAttribute } from './builders/objects/bone.js';
export { writeSkinDeformer, writeBindPose } from './builders/objects/skin.js';
export { writeAnimationNodes } from './builders/objects/animation.js';
export { collectAnimationClips, buildAnimationPlan } from './data/animationCollector.js';
export { writeMorph } from './builders/objects/morph.js';
export { collectMorph } from './data/morphCollector.js';
export { writeLightAttribute } from './builders/objects/light.js';
export { writeCameraAttribute } from './builders/objects/camera.js';
export { writeTexture, writeVideo } from './builders/objects/texture.js';
export { collectTextures, encodeTextures, TEXTURE_SLOTS } from './data/textureCollector.js';
export { encodeRGBA8PNG, encodeTexture } from './data/textureEncoder.js';
export { PRESETS, resolvePreset, buildTransformContext,
         buildAxisMatrix, bakeVertices, bakeNormals } from './data/transforms.js';

export { collectScene } from './data/SceneCollector.js';
export { writeFBX } from './FBXWriter.js';
export { FBXExporter } from './FBXExporter.js';

export * as Constants from './constants.js';
