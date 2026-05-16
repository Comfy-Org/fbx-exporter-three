/**
 * FBX PropertyTemplate default tables.
 *
 * Each builder returns a "template definition" describing what defaults a given
 * FBX object type carries. The Definitions section emits these as
 * `ObjectType` → `PropertyTemplate` records; per-instance prop writers consult
 * them via `templateSet` to skip values that already match the defaults.
 *
 * Mirrors `export_fbx_bin.py: fbx_template_def_*`. Values come directly from
 * Blender so importers that calibrate against Blender's output remain happy.
 *
 * Builder signature: `(settings?, overrides?) -> TemplateDef`
 * Each TemplateDef carries a `users` count we'll bump as we attach instances.
 */

const P = (value, ptype, animatable = false) => ({ value, ptype, animatable });

function applyOverrides(props, overrides) {
  if (!overrides) return props;
  return { ...props, ...overrides };
}

function make(typeName, propTypeName, properties) {
  return { typeName, propTypeName, properties, users: 0, _written: false };
}

// ---------------------------------------------------------------------------

export function globalSettingsTemplate(settings?: any, overrides?: any) {
  return make('GlobalSettings', '', applyOverrides({}, overrides));
}

export function modelTemplate(settings?: any, overrides?: any) {
  const props = {
    'QuaternionInterpolate':   P(0, 'p_enum'),
    'RotationOffset':          P([0, 0, 0], 'p_vector_3d'),
    'RotationPivot':           P([0, 0, 0], 'p_vector_3d'),
    'ScalingOffset':           P([0, 0, 0], 'p_vector_3d'),
    'ScalingPivot':            P([0, 0, 0], 'p_vector_3d'),
    'TranslationActive':       P(false, 'p_bool'),
    'TranslationMin':          P([0, 0, 0], 'p_vector_3d'),
    'TranslationMax':          P([0, 0, 0], 'p_vector_3d'),
    'TranslationMinX':         P(false, 'p_bool'),
    'TranslationMinY':         P(false, 'p_bool'),
    'TranslationMinZ':         P(false, 'p_bool'),
    'TranslationMaxX':         P(false, 'p_bool'),
    'TranslationMaxY':         P(false, 'p_bool'),
    'TranslationMaxZ':         P(false, 'p_bool'),
    'RotationOrder':           P(0, 'p_enum'),
    'RotationSpaceForLimitOnly': P(false, 'p_bool'),
    'RotationStiffnessX':      P(0.0, 'p_double'),
    'RotationStiffnessY':      P(0.0, 'p_double'),
    'RotationStiffnessZ':      P(0.0, 'p_double'),
    'AxisLen':                 P(10.0, 'p_double'),
    'PreRotation':             P([0, 0, 0], 'p_vector_3d'),
    'PostRotation':            P([0, 0, 0], 'p_vector_3d'),
    'RotationActive':          P(false, 'p_bool'),
    'RotationMin':             P([0, 0, 0], 'p_vector_3d'),
    'RotationMax':             P([0, 0, 0], 'p_vector_3d'),
    'RotationMinX':            P(false, 'p_bool'),
    'RotationMinY':            P(false, 'p_bool'),
    'RotationMinZ':            P(false, 'p_bool'),
    'RotationMaxX':            P(false, 'p_bool'),
    'RotationMaxY':            P(false, 'p_bool'),
    'RotationMaxZ':            P(false, 'p_bool'),
    'InheritType':             P(0, 'p_enum'),
    'ScalingActive':           P(false, 'p_bool'),
    'ScalingMin':              P([0, 0, 0], 'p_vector_3d'),
    'ScalingMax':              P([1, 1, 1], 'p_vector_3d'),
    'ScalingMinX':             P(false, 'p_bool'),
    'ScalingMinY':             P(false, 'p_bool'),
    'ScalingMinZ':             P(false, 'p_bool'),
    'ScalingMaxX':             P(false, 'p_bool'),
    'ScalingMaxY':             P(false, 'p_bool'),
    'ScalingMaxZ':             P(false, 'p_bool'),
    'GeometricTranslation':    P([0, 0, 0], 'p_vector_3d'),
    'GeometricRotation':       P([0, 0, 0], 'p_vector_3d'),
    'GeometricScaling':        P([1, 1, 1], 'p_vector_3d'),
    'MinDampRangeX':           P(0.0, 'p_double'),
    'MinDampRangeY':           P(0.0, 'p_double'),
    'MinDampRangeZ':           P(0.0, 'p_double'),
    'MaxDampRangeX':           P(0.0, 'p_double'),
    'MaxDampRangeY':           P(0.0, 'p_double'),
    'MaxDampRangeZ':           P(0.0, 'p_double'),
    'MinDampStrengthX':        P(0.0, 'p_double'),
    'MinDampStrengthY':        P(0.0, 'p_double'),
    'MinDampStrengthZ':        P(0.0, 'p_double'),
    'MaxDampStrengthX':        P(0.0, 'p_double'),
    'MaxDampStrengthY':        P(0.0, 'p_double'),
    'MaxDampStrengthZ':        P(0.0, 'p_double'),
    'PreferedAngleX':          P(0.0, 'p_double'),
    'PreferedAngleY':          P(0.0, 'p_double'),
    'PreferedAngleZ':          P(0.0, 'p_double'),
    'LookAtProperty':          P(null, 'p_object'),
    'UpVectorProperty':        P(null, 'p_object'),
    'Show':                    P(true, 'p_bool'),
    'NegativePercentShapeSupport': P(true, 'p_bool'),
    'DefaultAttributeIndex':   P(-1, 'p_integer'),
    'Freeze':                  P(false, 'p_bool'),
    'LODBox':                  P(false, 'p_bool'),
    'Lcl Translation':         P([0, 0, 0], 'p_lcl_translation', true),
    'Lcl Rotation':            P([0, 0, 0], 'p_lcl_rotation', true),
    'Lcl Scaling':             P([1, 1, 1], 'p_lcl_scaling', true),
    'Visibility':              P(1.0, 'p_visibility', true),
    'Visibility Inheritance':  P(1, 'p_visibility_inheritance'),
  };
  return make('Model', 'FbxNode', applyOverrides(props, overrides));
}

export function nullTemplate(settings?: any, overrides?: any) {
  const props = {
    'Color': P([0.8, 0.8, 0.8], 'p_color_rgb'),
    'Size':  P(100.0, 'p_double'),
    'Look':  P(1, 'p_enum'),
  };
  return make('NodeAttribute', 'FbxNull', applyOverrides(props, overrides));
}

export function lightTemplate(settings?: any, overrides?: any) {
  const gscale = settings?.globalScale ?? 1.0;
  const props = {
    'LightType':     P(0, 'p_enum'),
    'CastLight':     P(true, 'p_bool'),
    'Color':         P([1, 1, 1], 'p_color', true),
    'Intensity':     P(100.0, 'p_number', true),
    'Exposure':      P(0.0, 'p_number', true),
    'DecayType':     P(2, 'p_enum'),
    'DecayStart':    P(30.0 * gscale, 'p_double'),
    'CastShadows':   P(true, 'p_bool'),
    'ShadowColor':   P([0, 0, 0], 'p_color', true),
    'AreaLightShape': P(0, 'p_enum'),
  };
  return make('NodeAttribute', 'FbxLight', applyOverrides(props, overrides));
}

export function cameraTemplate(settings?: any, overrides?: any) {
  const props = {
    'Color':                       P([0.8, 0.8, 0.8], 'p_color_rgb'),
    'Position':                    P([0, 0, -50], 'p_vector', true),
    'UpVector':                    P([0, 1, 0], 'p_vector', true),
    'InterestPosition':            P([0, 0, 0], 'p_vector', true),
    'Roll':                        P(0.0, 'p_roll', true),
    'OpticalCenterX':              P(0.0, 'p_opticalcenterx', true),
    'OpticalCenterY':              P(0.0, 'p_opticalcentery', true),
    'BackgroundColor':             P([0.63, 0.63, 0.63], 'p_color', true),
    'TurnTable':                   P(0.0, 'p_number', true),
    'DisplayTurnTableIcon':        P(false, 'p_bool'),
    'UseMotionBlur':               P(false, 'p_bool'),
    'UseRealTimeMotionBlur':       P(true, 'p_bool'),
    'Motion Blur Intensity':       P(1.0, 'p_number', true),
    'AspectRatioMode':             P(0, 'p_enum'),
    'AspectWidth':                 P(320.0, 'p_double'),
    'AspectHeight':                P(200.0, 'p_double'),
    'PixelAspectRatio':            P(1.0, 'p_double'),
    'FilmOffsetX':                 P(0.0, 'p_number', true),
    'FilmOffsetY':                 P(0.0, 'p_number', true),
    'FilmWidth':                   P(0.816, 'p_double'),
    'FilmHeight':                  P(0.612, 'p_double'),
    'FilmAspectRatio':             P(1.3333333333333333, 'p_double'),
    'FilmSqueezeRatio':            P(1.0, 'p_double'),
    'FilmFormatIndex':             P(0, 'p_enum'),
    'PreScale':                    P(1.0, 'p_number', true),
    'FilmTranslateX':              P(0.0, 'p_number', true),
    'FilmTranslateY':              P(0.0, 'p_number', true),
    'FilmRollPivotX':              P(0.0, 'p_number', true),
    'FilmRollPivotY':              P(0.0, 'p_number', true),
    'FilmRollValue':               P(0.0, 'p_number', true),
    'FilmRollOrder':               P(0, 'p_enum'),
    'ApertureMode':                P(2, 'p_enum'),
    'GateFit':                     P(0, 'p_enum'),
    'FieldOfView':                 P(25.114999771118164, 'p_fov', true),
    'FieldOfViewX':                P(40.0, 'p_fov_x', true),
    'FieldOfViewY':                P(40.0, 'p_fov_y', true),
    'FocalLength':                 P(34.89327621672628, 'p_number', true),
    'CameraFormat':                P(0, 'p_enum'),
    'UseFrameColor':               P(false, 'p_bool'),
    'FrameColor':                  P([0.3, 0.3, 0.3], 'p_color_rgb'),
    'ShowName':                    P(true, 'p_bool'),
    'ShowInfoOnMoving':            P(true, 'p_bool'),
    'ShowGrid':                    P(true, 'p_bool'),
    'ShowOpticalCenter':           P(false, 'p_bool'),
    'ShowAzimut':                  P(true, 'p_bool'),
    'ShowTimeCode':                P(false, 'p_bool'),
    'ShowAudio':                   P(false, 'p_bool'),
    'AudioColor':                  P([0, 1, 0], 'p_vector_3d'),
    'NearPlane':                   P(10.0, 'p_double'),
    'FarPlane':                    P(4000.0, 'p_double'),
    'AutoComputeClipPanes':        P(false, 'p_bool'),
    'ViewCameraToLookAt':          P(true, 'p_bool'),
    'ViewFrustumNearFarPlane':     P(false, 'p_bool'),
    'ViewFrustumBackPlaneMode':    P(2, 'p_enum'),
    'BackPlaneDistance':           P(4000.0, 'p_number', true),
    'BackPlaneDistanceMode':       P(1, 'p_enum'),
    'ViewFrustumFrontPlaneMode':   P(2, 'p_enum'),
    'FrontPlaneDistance':          P(10.0, 'p_number', true),
    'FrontPlaneDistanceMode':      P(1, 'p_enum'),
    'LockMode':                    P(false, 'p_bool'),
    'LockInterestNavigation':      P(false, 'p_bool'),
    'FitImage':                    P(false, 'p_bool'),
    'Crop':                        P(false, 'p_bool'),
    'Center':                      P(true, 'p_bool'),
    'KeepRatio':                   P(true, 'p_bool'),
    'BackgroundAlphaTreshold':     P(0.5, 'p_double'),
    'ShowBackplate':               P(true, 'p_bool'),
    'BackPlaneOffsetX':            P(0.0, 'p_number', true),
    'BackPlaneOffsetY':            P(0.0, 'p_number', true),
    'BackPlaneRotation':           P(0.0, 'p_number', true),
    'BackPlaneScaleX':             P(1.0, 'p_number', true),
    'BackPlaneScaleY':             P(1.0, 'p_number', true),
    'Background Texture':          P(null, 'p_object'),
    'FrontPlateFitImage':          P(true, 'p_bool'),
    'FrontPlateCrop':              P(false, 'p_bool'),
    'FrontPlateCenter':            P(true, 'p_bool'),
    'FrontPlateKeepRatio':         P(true, 'p_bool'),
    'Foreground Opacity':          P(1.0, 'p_double'),
    'ShowFrontplate':              P(true, 'p_bool'),
    'FrontPlaneOffsetX':           P(0.0, 'p_number', true),
    'FrontPlaneOffsetY':           P(0.0, 'p_number', true),
    'FrontPlaneRotation':          P(0.0, 'p_number', true),
    'FrontPlaneScaleX':            P(1.0, 'p_number', true),
    'FrontPlaneScaleY':            P(1.0, 'p_number', true),
    'Foreground Texture':          P(null, 'p_object'),
    'DisplaySafeArea':             P(false, 'p_bool'),
    'DisplaySafeAreaOnRender':     P(false, 'p_bool'),
    'SafeAreaDisplayStyle':        P(1, 'p_enum'),
    'SafeAreaAspectRatio':         P(1.3333333333333333, 'p_double'),
    'Use2DMagnifierZoom':          P(false, 'p_bool'),
    '2D Magnifier Zoom':           P(100.0, 'p_number', true),
    '2D Magnifier X':              P(50.0, 'p_number', true),
    '2D Magnifier Y':              P(50.0, 'p_number', true),
    'CameraProjectionType':        P(0, 'p_enum'),
    'OrthoZoom':                   P(1.0, 'p_double'),
    'UseRealTimeDOFAndAA':         P(false, 'p_bool'),
    'UseDepthOfField':             P(false, 'p_bool'),
    'FocusSource':                 P(0, 'p_enum'),
    'FocusAngle':                  P(3.5, 'p_double'),
    'FocusDistance':               P(200.0, 'p_double'),
    'UseAntialiasing':             P(false, 'p_bool'),
    'AntialiasingIntensity':       P(0.77777, 'p_double'),
    'AntialiasingMethod':          P(0, 'p_enum'),
    'UseAccumulationBuffer':       P(false, 'p_bool'),
    'FrameSamplingCount':          P(7, 'p_integer'),
    'FrameSamplingType':           P(1, 'p_enum'),
  };
  return make('NodeAttribute', 'FbxCamera', applyOverrides(props, overrides));
}

export function boneTemplate(settings?: any, overrides?: any) {
  return make('NodeAttribute', 'LimbNode', applyOverrides({}, overrides));
}

export function geometryTemplate(settings?: any, overrides?: any) {
  const props = {
    'Color':              P([0.8, 0.8, 0.8], 'p_color_rgb'),
    'BBoxMin':            P([0, 0, 0], 'p_vector_3d'),
    'BBoxMax':            P([0, 0, 0], 'p_vector_3d'),
    'Primary Visibility': P(true, 'p_bool'),
    'Casts Shadows':      P(true, 'p_bool'),
    'Receive Shadows':    P(true, 'p_bool'),
  };
  return make('Geometry', 'FbxMesh', applyOverrides(props, overrides));
}

export function materialTemplate(settings?: any, overrides?: any) {
  const props = {
    'ShadingModel':              P('Phong', 'p_string'),
    'MultiLayer':                P(false, 'p_bool'),
    'EmissiveColor':             P([0, 0, 0], 'p_color', true),
    'EmissiveFactor':            P(1.0, 'p_number', true),
    'AmbientColor':              P([0.2, 0.2, 0.2], 'p_color', true),
    'AmbientFactor':             P(1.0, 'p_number', true),
    'DiffuseColor':              P([0.8, 0.8, 0.8], 'p_color', true),
    'DiffuseFactor':             P(1.0, 'p_number', true),
    'TransparentColor':          P([0, 0, 0], 'p_color', true),
    'TransparencyFactor':        P(0.0, 'p_number', true),
    'Opacity':                   P(1.0, 'p_number', true),
    'NormalMap':                 P([0, 0, 0], 'p_vector_3d'),
    'Bump':                      P([0, 0, 0], 'p_vector_3d'),
    'BumpFactor':                P(1.0, 'p_double'),
    'DisplacementColor':         P([0, 0, 0], 'p_color_rgb'),
    'DisplacementFactor':        P(1.0, 'p_double'),
    'VectorDisplacementColor':   P([0, 0, 0], 'p_color_rgb'),
    'VectorDisplacementFactor':  P(1.0, 'p_double'),
    'SpecularColor':             P([0.2, 0.2, 0.2], 'p_color', true),
    'SpecularFactor':             P(1.0, 'p_number', true),
    'Shininess':                 P(20.0, 'p_number', true),
    'ShininessExponent':         P(20.0, 'p_number', true),
    'ReflectionColor':           P([0, 0, 0], 'p_color', true),
    'ReflectionFactor':          P(1.0, 'p_number', true),
  };
  return make('Material', 'FbxSurfacePhong', applyOverrides(props, overrides));
}

export function textureTemplate(settings?: any, overrides?: any) {
  const props = {
    'TextureTypeUse':         P(0, 'p_enum'),
    'AlphaSource':            P(2, 'p_enum'),
    'Texture alpha':          P(1.0, 'p_double'),
    'PremultiplyAlpha':       P(true, 'p_bool'),
    'CurrentTextureBlendMode': P(1, 'p_enum'),
    'CurrentMappingType':     P(0, 'p_enum'),
    'UVSet':                  P('default', 'p_string'),
    'WrapModeU':              P(0, 'p_enum'),
    'WrapModeV':              P(0, 'p_enum'),
    'UVSwap':                 P(false, 'p_bool'),
    'Translation':            P([0, 0, 0], 'p_vector_3d'),
    'Rotation':               P([0, 0, 0], 'p_vector_3d'),
    'Scaling':                P([1, 1, 1], 'p_vector_3d'),
    'TextureRotationPivot':   P([0, 0, 0], 'p_vector_3d'),
    'TextureScalingPivot':    P([0, 0, 0], 'p_vector_3d'),
    'UseMaterial':            P(false, 'p_bool'),
    'UseMipMap':              P(false, 'p_bool'),
  };
  return make('Texture', 'FbxFileTexture', applyOverrides(props, overrides));
}

export function videoTemplate(settings?: any, overrides?: any) {
  const props = {
    'Width':                P(0, 'p_integer'),
    'Height':               P(0, 'p_integer'),
    'Path':                 P('', 'p_string_url'),
    'AccessMode':           P(0, 'p_enum'),
    'StartFrame':           P(0, 'p_integer'),
    'StopFrame':            P(0, 'p_integer'),
    'Offset':               P(0, 'p_timestamp'),
    'PlaySpeed':            P(0.0, 'p_double'),
    'FreeRunning':          P(false, 'p_bool'),
    'Loop':                 P(false, 'p_bool'),
    'InterlaceMode':        P(0, 'p_enum'),
    'ImageSequence':        P(false, 'p_bool'),
    'ImageSequenceOffset':  P(0, 'p_integer'),
    'FrameRate':            P(0.0, 'p_double'),
    'LastFrame':            P(0, 'p_integer'),
  };
  return make('Video', 'FbxVideo', applyOverrides(props, overrides));
}

export function poseTemplate(settings?: any, overrides?: any) {
  return make('Pose', '', applyOverrides({}, overrides));
}

export function deformerTemplate(settings?: any, overrides?: any) {
  return make('Deformer', '', applyOverrides({}, overrides));
}

export function animStackTemplate(settings?: any, overrides?: any) {
  const props = {
    'Description':    P('', 'p_string'),
    'LocalStart':     P(0, 'p_timestamp'),
    'LocalStop':      P(0, 'p_timestamp'),
    'ReferenceStart': P(0, 'p_timestamp'),
    'ReferenceStop':  P(0, 'p_timestamp'),
  };
  return make('AnimationStack', 'FbxAnimStack', applyOverrides(props, overrides));
}

export function animLayerTemplate(settings?: any, overrides?: any) {
  const props = {
    'Weight':                  P(100.0, 'p_number', true),
    'Mute':                    P(false, 'p_bool'),
    'Solo':                    P(false, 'p_bool'),
    'Lock':                    P(false, 'p_bool'),
    'Color':                   P([0.8, 0.8, 0.8], 'p_color_rgb'),
    'BlendMode':               P(0, 'p_enum'),
    'RotationAccumulationMode': P(0, 'p_enum'),
    'ScaleAccumulationMode':   P(0, 'p_enum'),
    'BlendModeBypass':         P(0, 'p_ulonglong'),
  };
  return make('AnimationLayer', 'FbxAnimLayer', applyOverrides(props, overrides));
}

export function animCurveNodeTemplate(settings?: any, overrides?: any) {
  // Blender uses FBX_ANIM_PROPSGROUP_NAME = "d" as the compound prop name.
  const props = {
    'd': P(null, 'p_compound'),
  };
  return make('AnimationCurveNode', 'FbxAnimCurveNode', applyOverrides(props, overrides));
}

export function animCurveTemplate(settings?: any, overrides?: any) {
  return make('AnimationCurve', '', applyOverrides({}, overrides));
}

/**
 * Bundle all templates a scene might need into a Map keyed by typeName,
 * preserving Blender's grouping behaviour: when multiple subtypes share a
 * typeName (NodeAttribute = Null/Light/Camera/LimbNode), the one with the most
 * users wins template selection.
 */
export class TemplateBundle {
  _byType: Map<string, any[]>;
  _byKey: Map<string, any>;

  constructor() {
    this._byType = new Map();
    this._byKey = new Map();
  }

  /**
   * Register a template. If one with the same (typeName, propTypeName) already
   * exists, that one is returned (so its `.users` can be incremented).
   */
  register(template) {
    const k = `${template.typeName}|${template.propTypeName}`;
    const existing = this._byKey.get(k);
    if (existing) return existing;
    this._byKey.set(k, template);
    const arr = this._byType.get(template.typeName) ?? [];
    arr.push(template);
    this._byType.set(template.typeName, arr);
    return template;
  }

  /**
   * For each typeName, pick the dominant subtype's properties.
   * Returns a Map<typeName, { totalUsers, dominant: template }> so the
   * Definitions builder knows what to emit.
   */
  resolved() {
    const out = new Map();
    for (const [typeName, arr] of this._byType) {
      let total = 0;
      let dominant = arr[0];
      let bestUsers = -1;
      let bestPropCount = -1;
      for (const t of arr) {
        total += t.users;
        const propCount = Object.keys(t.properties).length;
        if (
          t.users > bestUsers ||
          (t.users === bestUsers && propCount > bestPropCount)
        ) {
          bestUsers = t.users;
          bestPropCount = propCount;
          dominant = t;
        }
      }
      out.set(typeName, { totalUsers: total, dominant });
    }
    return out;
  }

  /** Look up the per-type dominant template, used by per-instance property writers. */
  get(typeName) {
    const arr = this._byType.get(typeName);
    if (!arr || arr.length === 0) return null;
    let dominant = arr[0];
    let bestUsers = -1;
    let bestPropCount = -1;
    for (const t of arr) {
      const propCount = Object.keys(t.properties).length;
      if (
        t.users > bestUsers ||
        (t.users === bestUsers && propCount > bestPropCount)
      ) {
        bestUsers = t.users;
        bestPropCount = propCount;
        dominant = t;
      }
    }
    return dominant;
  }

  /** Sum of all per-template users — fills `Definitions/Count`. */
  totalUsers() {
    let n = 0;
    for (const t of this._byKey.values()) n += t.users;
    return n;
  }
}
