/**
 * Versions and magic numbers used throughout the exporter.
 */

export const FBX_VERSION             = 7400;
export const FBX_HEADER_VERSION      = 1003;
export const FBX_SCENEINFO_VERSION   = 100;
export const FBX_TEMPLATES_VERSION   = 100;
export const FBX_MODELS_VERSION      = 232;
export const FBX_GEOMETRY_VERSION    = 124;
export const FBX_POSE_BIND_VERSION   = 100;
export const FBX_ANIM_KEY_VERSION    = 4008;

export const FBX_GEOMETRY_NORMAL_VERSION    = 101;
export const FBX_GEOMETRY_BINORMAL_VERSION  = 101;
export const FBX_GEOMETRY_TANGENT_VERSION   = 101;
export const FBX_GEOMETRY_SMOOTHING_VERSION = 102;
export const FBX_GEOMETRY_VCOLOR_VERSION    = 101;
export const FBX_GEOMETRY_UV_VERSION        = 101;
export const FBX_GEOMETRY_MATERIAL_VERSION  = 101;
export const FBX_GEOMETRY_LAYER_VERSION     = 100;

export const FBX_MATERIAL_VERSION = 102;
export const FBX_TEXTURE_VERSION  = 202;

export const FBX_DEFORMER_SKIN_VERSION    = 101;
export const FBX_DEFORMER_CLUSTER_VERSION = 100;

export const FBX_GEOMETRY_SHAPE_VERSION       = 100;
export const FBX_DEFORMER_SHAPE_VERSION       = 100;
export const FBX_DEFORMER_SHAPECHANNEL_VERSION = 100;

export const FBX_KTIME_V7 = 46186158000n;
export const FBX_KTIME_V8 = 141120000n;
export const FBX_KTIME    = FBX_VERSION >= 8000 ? FBX_KTIME_V8 : FBX_KTIME_V7;

/**
 * Axis-pair → (UpAxis, FrontAxis, CoordAxis) encoding used in GlobalSettings.
 * Each entry is `[axis, sign]`; axis is 0=X, 1=Y, 2=Z. Right-handed only.
 * Mirrors fbx_utils.py: RIGHT_HAND_AXES.
 */
export const RIGHT_HAND_AXES = {
  "X|-Y":  { up: [0, 1],  front: [1, 1],  coord: [2, 1]  },
  "X|Y":   { up: [0, 1],  front: [1, -1], coord: [2, -1] },
  "X|-Z":  { up: [0, 1],  front: [2, 1],  coord: [1, -1] },
  "X|Z":   { up: [0, 1],  front: [2, -1], coord: [1, 1]  },
  "-X|-Y": { up: [0, -1], front: [1, 1],  coord: [2, -1] },
  "-X|Y":  { up: [0, -1], front: [1, -1], coord: [2, 1]  },
  "-X|-Z": { up: [0, -1], front: [2, 1],  coord: [1, 1]  },
  "-X|Z":  { up: [0, -1], front: [2, -1], coord: [1, -1] },
  "Y|-X":  { up: [1, 1],  front: [0, 1],  coord: [2, -1] },
  "Y|X":   { up: [1, 1],  front: [0, -1], coord: [2, 1]  },
  "Y|-Z":  { up: [1, 1],  front: [2, 1],  coord: [0, 1]  },
  "Y|Z":   { up: [1, 1],  front: [2, -1], coord: [0, -1] },
  "-Y|-X": { up: [1, -1], front: [0, 1],  coord: [2, 1]  },
  "-Y|X":  { up: [1, -1], front: [0, -1], coord: [2, -1] },
  "-Y|-Z": { up: [1, -1], front: [2, 1],  coord: [0, -1] },
  "-Y|Z":  { up: [1, -1], front: [2, -1], coord: [0, 1]  },
  "Z|-X":  { up: [2, 1],  front: [0, 1],  coord: [1, 1]  },
  "Z|X":   { up: [2, 1],  front: [0, -1], coord: [1, -1] },
  "Z|-Y":  { up: [2, 1],  front: [1, 1],  coord: [0, -1] },
  "Z|Y":   { up: [2, 1],  front: [1, -1], coord: [0, 1]  },
  "-Z|-X": { up: [2, -1], front: [0, 1],  coord: [1, -1] },
  "-Z|X":  { up: [2, -1], front: [0, -1], coord: [1, 1]  },
  "-Z|-Y": { up: [2, -1], front: [1, 1],  coord: [0, 1]  },
  "-Z|Y":  { up: [2, -1], front: [1, -1], coord: [0, -1] },
};

/** FBX TimeMode enum values keyed by an approximate framerate. */
export const FBX_FRAMERATES = [
  { fps: -1.0,             mode: 14 },
  { fps: 120.0,            mode: 1  },
  { fps: 100.0,            mode: 2  },
  { fps: 60.0,             mode: 3  },
  { fps: 50.0,             mode: 4  },
  { fps: 48.0,             mode: 5  },
  { fps: 30.0,             mode: 6  },
  { fps: 30.0 / 1.001,     mode: 9  },
  { fps: 25.0,             mode: 10 },
  { fps: 24.0,             mode: 11 },
  { fps: 24.0 / 1.001,     mode: 13 },
  { fps: 96.0,             mode: 15 },
  { fps: 72.0,             mode: 16 },
  { fps: 60.0 / 1.001,     mode: 17 },
];

export const APP_VENDOR  = 'Comfy Org';
export const APP_NAME    = '@comfyorg/fbx-exporter-three';
export const APP_VERSION = '1.0.0';
