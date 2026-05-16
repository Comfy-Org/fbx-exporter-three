# @comfyorg/fbx-exporter-three

FBX binary exporter for three.js scenes — Unity / Unreal / Maya / Blender / three.js's own `FBXLoader` all consume the output cleanly.

- **Self-contained**: TypeScript source, ships ESM `.js` + `.d.ts`. Only runtime dep is `fflate` (zlib).
- **One-shot or async**: `parseSync` when textures are `DataTexture`s or absent; `parseAsync` when textures need canvas-based encoding (`HTMLImageElement` / `ImageBitmap` / render targets).
- **Tool presets**: `threejs`, `unity`, `unreal`, `blender`, `maya` — picks the right axis convention + unit scale for the target.
- **Covers**: meshes, multi-UV layers, materials, textures (PNG-embedded), skinning, animation (TRS + morph), morph targets, lights, cameras.

## Install

```bash
npm install @comfyorg/fbx-exporter-three
```

Peer deps: `three >= 0.160` (required), `@types/three >= 0.160` (optional, only if you're using TypeScript).

## TypeScript

Source is written in TypeScript; published `dist/` ships ESM `.js` + `.d.ts`. Public types include `FBXExporter`, `FBXExportOptions`, `FBXPreset`, `FBXAxis`, `FBXExporterPlugin`.

## Quickstart

```js
import * as THREE from 'three';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { writeFileSync } from 'node:fs';

const scene = new THREE.Scene();
scene.add(new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x6688ff }),
));

const exporter = new FBXExporter();
const bytes = exporter.parseSync(scene);

writeFileSync('cube.fbx', bytes);
```

The result is a binary FBX (`Kaydara FBX Binary` magic) you can drop straight into Unity, Unreal, Blender, Maya, or load back with `FBXLoader`.

## API

### `class FBXExporter`

```js
const exporter = new FBXExporter();
```

#### `parseSync(input, options?) → Uint8Array`

Build an FBX in one call. Use this for static scenes, scenes that only have `DataTexture`s, or when you've already encoded all your textures.

| Option | Type | Default | Notes |
|---|---|---|---|
| `preset` | `'threejs' \| 'unity' \| 'unreal' \| 'blender' \| 'maya'` | `'threejs'` | Picks axis + unit defaults. |
| `axisUp` | `'X' \| 'Y' \| 'Z' \| '-X' \| '-Y' \| '-Z'` | preset | Overrides preset. |
| `axisForward` | same | preset | Overrides preset. |
| `unitScale` | `number` | preset | Written to `GlobalSettings.UnitScaleFactor`. |
| `bakeSpaceTransform` | `boolean` | `false` | Pre-multiplies axis matrix into geometry. See limitation note below. |
| `version` | `number` | `7400` | FBX version (7400 / 7500 supported). |
| `fps` | `number` | `24` | Animation frame rate. |
| `embedTextures` | `boolean` | `true` | When `false`, textures are referenced by file path instead of embedded. |
| `animations` | `AnimationClip[]` | auto | If omitted, we collect from `input.animations` (the convention used by `GLTFLoader` / `FBXLoader`). |
| `includeAnimations` | `boolean` | `true` | Set `false` to export a static T-pose only (skips AnimStack/Curve nodes entirely). |
| `onlyVisible` | `boolean` | `false` | Skip Object3Ds whose `.visible` is `false`. |
| `objectFilter` | `(o: Object3D) => boolean` | — | Generic predicate — return `false` to skip an object. Composes with `onlyVisible`. |
| `customProperties` | `boolean` | `false` | Emit each Object3D's `userData` as user-defined Properties70 entries. Maps booleans → `p_bool`, integers → `p_integer`, floats → `p_double`, strings → `p_string`, length-3 number arrays → `p_vector_3d`; other JS values get JSON-stringified into a `p_string`. |
| `creator` | `string` | `@comfyorg/fbx-exporter-three - <ver>` | Custom string written to FBX `Creator` metadata. |

#### `parseAsync(input, options?) → Promise<Uint8Array>`

Same as `parseSync` but awaits async texture encoding paths — `HTMLImageElement`, `ImageBitmap`, canvas/render-target textures all need `canvas.toBlob()` which is async. Use this whenever your materials reference textures loaded via `TextureLoader` (any environment with a canvas API).

```js
const bytes = await new FBXExporter().parseAsync(scene);
```

#### `register(callback)` / `unregister(callback)`

Plugin hook in the style of three.js's `GLTFExporter`. The callback receives `sceneData` (the collected scene plan) after collection and texture encoding, before serialization:

```js
exporter.register((sceneData) => {
  // e.g. swap pre-encoded PNG bytes into texture entries
  for (const [tex, entry] of sceneData.textures.textures) {
    if (tex.userData.preEncodedPng) entry.imageBytes = tex.userData.preEncodedPng;
  }
});
```

### Convenience exports

```js
import {
  FBXExporter,
  PRESETS,            // tool preset table
  resolvePreset,      // merge user options onto a preset
  encodeRGBA8PNG,     // pure-JS PNG encoder used internally
} from '@comfyorg/fbx-exporter-three';
```

## Feature coverage

| three.js input | FBX output |
|---|---|
| `Mesh` + `BufferGeometry` (positions / normals / vertex colors) | `Geometry` + `LayerElementNormal` / `LayerElementColor` / `LayerElementMaterial` |
| Multiple UV sets — `attributes.uv` / `uv1` / `uv2` / `uv3` (used for lightmap / AO) | Multiple `LayerElementUV` nodes with distinct `TypedIndex` + per-set `Layer` entries |
| `MeshStandardMaterial` / `MeshPhongMaterial` / `MeshBasicMaterial` | `Material` with `FbxSurfacePhong` shading model |
| `Texture` (DataTexture, HTMLImage, canvas) | `Texture` + `Video` with embedded PNG bytes |
| `Group`, `Object3D` | `Model` (Null) |
| `SkinnedMesh` + `Skeleton` + `Bone` | `Deformer` (Skin) + `Deformer` (Cluster) per bone + `Pose` (BindPose) + `Model` (LimbNode) per bone |
| `AnimationClip` (position / rotation / scale tracks) | `AnimationStack` + `AnimationLayer` + `AnimationCurveNode` + `AnimationCurve` |
| Morph targets (`morphAttributes.position`) | `Geometry` (Shape) per morph + `Deformer` (BlendShape) + `Deformer` (BlendShapeChannel) |
| Morph animation (compound `morphTargetInfluences` track) | Per-channel `AnimationCurveNode` driving `DeformPercent` |
| `PointLight` / `DirectionalLight` / `SpotLight` | `NodeAttribute` (Light) — `light.target.position` round-trips via `LookAtProperty` |
| `PerspectiveCamera` / `OrthographicCamera` | `NodeAttribute` (Camera) |
| Axis / unit conversion | `GlobalSettings.UpAxis` / `FrontAxis` / `UnitScaleFactor` |

## Tool presets

| Preset | UpAxis | FrontAxis | UnitScale | Bake | Use when… |
|---|---|---|---|---|---|
| `threejs` (default) | Y | Z | 1 | off | Round-tripping through `FBXLoader`. |
| `unity` | Y | Z | 1 | off | Importing into Unity (it respects file axes). |
| `unreal` | Z | X | 1 | off | Importing into Unreal Editor. Unreal's importer handles axis conversion when GlobalSettings declares it. |
| `blender` | Y | Z | 100 | off | Files for Blender. UnitScale=100 because Blender stores meters but FBX canonical unit is centimeters. |
| `maya` | Y | Z | 100 | off | Same as Blender. |

```js
// Use a preset:
exporter.parseSync(scene, { preset: 'unreal' });

// Or set axes directly:
exporter.parseSync(scene, { axisUp: 'Z', axisForward: 'X' });

// Mix: preset defaults + selective override:
exporter.parseSync(scene, { preset: 'unity', unitScale: 100 });
```

## Examples

### Skinned + animated character

```js
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';

const gltf = await new GLTFLoader().loadAsync('character.glb');
const scene = gltf.scene;
scene.animations = gltf.animations;  // wire so the exporter finds them

const bytes = await new FBXExporter().parseAsync(scene);
```

### Textures from disk (Node)

```js
const tex = new THREE.DataTexture(rgbaPixels, w, h, THREE.RGBAFormat);
tex.needsUpdate = true;
material.map = tex;

const bytes = new FBXExporter().parseSync(scene);  // embeds PNG-encoded RGBA
```

### Saving to file

```js
import { writeFileSync } from 'node:fs';
writeFileSync('out.fbx', bytes);
```

### Saving in the browser

```js
const blob = new Blob([bytes], { type: 'application/octet-stream' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = 'out.fbx';
a.click();
URL.revokeObjectURL(url);
```

## Known limitations

- **`bakeSpaceTransform: true`** only pre-multiplies the axis matrix into **vertex positions + normals**. Object `Lcl` transforms, cluster matrices, animation curves, and light/camera transforms are NOT baked. The flag is only safe for single-mesh-at-origin scenes; leave it `false` otherwise — modern importers (Unity, Unreal, Blender, Maya) honour `GlobalSettings.UpAxis` so axis conversion happens on import.
- **`light.target.position`** for `DirectionalLight` / `SpotLight` round-trips via a synthetic `LookAtProperty` Model + OP connection.
- **Output is always binary FBX** (`Kaydara FBX Binary` magic). ASCII FBX is not implemented.

## How it works (brief)

```
┌───────────────────┐   ┌──────────────┐   ┌──────────────┐
│ three.js Scene    │ → │ SceneCollect │ → │ FBXElem tree │ → encodeBinaryFBX → Uint8Array
└───────────────────┘   └──────────────┘   └──────────────┘
                              │                    │
                  builds UIDs, dedupes      one writer per FBX
                  geometries / mats /       record kind (Geometry,
                  textures, plans OO/OP     Material, Skin Deformer,
                  connection graph         AnimStack, …)
```

## Testing

```bash
npm test
```

446 unit tests covering the binary layer, scene collection, every Object kind (Mesh / Material / Texture / Skin / Animation / Morph / Light / Camera), axis/unit conversion, the public-options surface.

Real-asset E2E tests (`test/e2e-*.test.mjs`) aren't part of `npm test` — they read large binary inputs from `test/_assets/` which is gitignored. Drop your own assets in that folder and run them individually:

```bash
node --import tsx test/e2e-1-obj.test.mjs           # raw .obj round-trip
node --import tsx test/e2e-2-xbot.test.mjs          # Mixamo skinned + animated character
node --import tsx test/e2e-3-testTexture.test.mjs   # OBJ + MTL + PNG textures
node --import tsx test/e2e-4-threejs-models.test.mjs  # 7 three.js example glTFs
```

`test/m5-bindpose-recovery.test.mjs` IS in `npm test` but skips gracefully when `test/_assets/Xbot.glb` isn't there — drop in any skinned glTF to enable it.

## License

MIT. See [LICENSE](./LICENSE).

Published under [@comfyorg](https://www.npmjs.com/org/comfyorg).
