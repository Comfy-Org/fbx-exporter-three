/**
 * Public exporter facade — public API + plugin hook surface in the style of
 * three.js's GLTFExporter (examples/jsm/exporters/GLTFExporter.js: class
 * GLTFExporter at line 104).
 *
 * Usage:
 *   const exporter = new FBXExporter();
 *   const bytes = await exporter.parseAsync(scene, options);
 *   fs.writeFileSync('out.fbx', bytes);
 *
 * Sync vs async — parseSync works for scenes with no textures OR with
 * DataTextures only (our PNG encoder is synchronous). HTMLImageElement /
 * ImageBitmap / canvas-backed Textures require the async `canvas.toBlob`
 * pipeline; use parseAsync (or pass `options.embedTextures: false` to
 * skip).
 */

import { collectScene } from './data/SceneCollector.js';

interface Object3DLike { uuid: string; name?: string; traverse: (cb: (o: any) => void) => void; updateMatrixWorld: (force?: boolean) => void; [key: string]: any; }
interface AnimationClipLike { name: string; duration: number; tracks: unknown[]; }
import { writeFBX } from './FBXWriter.js';
import { encodeTextures } from './data/textureCollector.js';
import { encodeRGBA8PNG } from './data/textureEncoder.js';

export type FBXAxis = 'X' | 'Y' | 'Z' | '-X' | '-Y' | '-Z';
export type FBXPreset = 'threejs' | 'unity' | 'unreal' | 'blender' | 'maya';

export interface FBXExportOptions {
  /** Tool preset: picks axisUp / axisForward / unitScale / bakeSpaceTransform defaults. */
  preset?: FBXPreset;
  /** Overrides preset.axisUp. */
  axisUp?: FBXAxis;
  /** Overrides preset.axisForward. */
  axisForward?: FBXAxis;
  /** Written to GlobalSettings.UnitScaleFactor. */
  unitScale?: number;
  /** Pre-multiply axis matrix into Vertices+Normals (geometry-only). */
  bakeSpaceTransform?: boolean;
  /** FBX format version (7400 or 7500 supported). */
  version?: number;
  /** Animation framerate (default 24). */
  fps?: number;
  /** Embed texture image bytes vs reference by path. */
  embedTextures?: boolean;
  /** Explicit AnimationClip array (otherwise collected from input.animations). */
  animations?: AnimationClipLike[];
  /** Set false to skip the entire AnimStack/Curve emit. */
  includeAnimations?: boolean;
  /** Skip Object3Ds with .visible === false. */
  onlyVisible?: boolean;
  /** Predicate filter — return false to skip an object. */
  objectFilter?: (object: Object3DLike) => boolean;
  /** Emit Object3D.userData as user-defined Properties70 (U flag). */
  customProperties?: boolean;
  /** Override the FBX Creator metadata string. */
  creator?: string;
}

/** Plugin callback signature — receives the collected SceneData before serialization. */
export type FBXExporterPlugin = (sceneData: any) => void;

const DEFAULT_OPTIONS: Partial<FBXExportOptions> = {
  version: 7400,
  fps: 24.0,
  embedTextures: true,
};

export class FBXExporter {
  pluginCallbacks: FBXExporterPlugin[] = [];

  /** GLTFExporter-style plugin registration. */
  register(callback: FBXExporterPlugin): this {
    if (!this.pluginCallbacks.includes(callback)) this.pluginCallbacks.push(callback);
    return this;
  }
  unregister(callback: FBXExporterPlugin): this {
    const i = this.pluginCallbacks.indexOf(callback);
    if (i !== -1) this.pluginCallbacks.splice(i, 1);
    return this;
  }

  /**
   * Synchronous parse. Texture embedding only works for DataTextures
   * (encoded via the inline PNG encoder). HTMLImage / canvas textures must
   * go through parseAsync.
   */
  parseSync(input: Object3DLike, options: FBXExportOptions = {}): Uint8Array {
    const settings = { ...DEFAULT_OPTIONS, ...options };
    const sceneData = collectScene(input, settings);
    if (settings.embedTextures !== false) encodeTexturesSyncOnly(sceneData);
    for (const cb of this.pluginCallbacks) cb(sceneData);
    return writeFBX(sceneData);
  }

  parse(
    input: Object3DLike,
    onDone: (bytes: Uint8Array) => void,
    onError?: (err: Error) => void,
    options?: FBXExportOptions,
  ): void {
    this.parseAsync(input, options).then(onDone, onError ?? ((e) => { throw e; }));
  }

  /** Asynchronous parse — waits for canvas-based texture encodings. */
  async parseAsync(input: Object3DLike, options: FBXExportOptions = {}): Promise<Uint8Array> {
    const settings = { ...DEFAULT_OPTIONS, ...options };
    const sceneData = collectScene(input, settings);
    if (settings.embedTextures !== false && sceneData.textures) {
      await encodeTextures(sceneData.textures);
    }
    for (const cb of this.pluginCallbacks) cb(sceneData);
    return writeFBX(sceneData);
  }
}

/**
 * Synchronous variant of encodeTextures — only handles DataTextures. Any
 * texture that would need canvas (HTMLImage / ImageBitmap / etc.) is left
 * unencoded with a console warning.
 */
function encodeTexturesSyncOnly(sceneData: any): void {
  if (!sceneData.textures || !sceneData.textures.textures) return;
  for (const [, entry] of sceneData.textures.textures as Map<unknown, any>) {
    const tex = entry.texture;
    if (tex.isDataTexture || (tex.image && tex.image.data instanceof Uint8Array)) {
      try {
        const { data, width, height } = tex.image;
        entry.imageBytes = encodeRGBA8PNG(data, width, height);
        entry.extension  = 'png';
      } catch (err: any) {
        console.warn(`fbx-exporter-three: failed to encode DataTexture "${tex.name || '<unnamed>'}": ${err.message}`);
      }
    } else {
      console.warn(
        `fbx-exporter-three: skipping embed of texture "${tex.name || '<unnamed>'}" — ` +
        `parseSync only handles DataTextures. Use parseAsync to embed HTMLImage / ` +
        `canvas-backed textures.`,
      );
    }
  }
}
