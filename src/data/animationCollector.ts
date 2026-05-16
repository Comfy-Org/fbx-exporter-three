/**
 * Collect three.js AnimationClip[] from a scene and turn them into the FBX
 * `AnimStack → AnimLayer → AnimCurveNode → AnimCurve` structure.
 *
 * The output is a plan, not bytes. Bytes are emitted by builders/objects/
 * animation.js using these structures.
 */

import { Euler, Quaternion } from 'three';
import { PropertyBinding } from 'three';
import {
  animStackKey, animLayerKey, animCurveNodeKey, animCurveKey,
} from '../core/uid.js';
import {
  animStackTemplate, animLayerTemplate,
  animCurveNodeTemplate, animCurveTemplate,
} from '../core/templates.js';
import { FBX_KTIME } from '../constants.js';

const RAD_TO_DEG = 180 / Math.PI;
const _euler = new Euler();
const _quat = new Quaternion();

function secondsToKTime(seconds) {
  if (!Number.isFinite(seconds)) return 0n;
  const micros = BigInt(Math.round(seconds * 1_000_000));
  return (micros * FBX_KTIME) / 1_000_000n;
}

const KINDS = {
  position:   { attrName: 'T',             fbxProp: 'Lcl Translation', axes: ['X', 'Y', 'Z'] },
  scale:      { attrName: 'S',             fbxProp: 'Lcl Scaling',     axes: ['X', 'Y', 'Z'] },
  quaternion: { attrName: 'R',             fbxProp: 'Lcl Rotation',    axes: ['X', 'Y', 'Z'] },
  morphTargetInfluences: {
    attrName: 'DeformPercent',
    fbxProp:  'DeformPercent',
    axes:     ['DeformPercent'],
  },
};

/**
 * Gather every AnimationClip in the scene without duplicates.
 *
 * three.js stores clips in different places depending on the loader:
 * - GLTFLoader puts them on the imported scene (root.animations).
 * - FBXLoader stores them on the returned Group (root.animations).
 * - Manual code sometimes attaches them to specific objects.
 *
 * We walk the whole tree and dedupe by reference.
 */
export function collectAnimationClips(input) {
  const seen = new Set();
  const out = [];
  function visit(obj) {
    if (Array.isArray(obj.animations)) {
      for (const clip of obj.animations) {
        if (clip && !seen.has(clip)) { seen.add(clip); out.push(clip); }
      }
    }
  }
  visit(input);
  input.traverse((o) => { if (o !== input) visit(o); });
  return out;
}

/**
 * Build the per-clip animation plan.
 *
 * @param {object} ctx
 * @param {Object3D}        ctx.root        scene root
 * @param {AnimationClip[]} ctx.clips
 * @param {UidRegistry}     ctx.uids
 * @param {TemplateBundle}  ctx.templates
 * @param {object}          ctx.settings
 * @param {object[]}        [ctx.meshes]    SceneCollector mesh entries — used
 *                                          to resolve `Mesh.morphTargetInfluences[N]`
 *                                          tracks back to the right
 *                                          BlendShapeChannel UID.
 * @returns {object[]} stacks
 */
export function buildAnimationPlan({ root, clips, uids, templates, settings, meshes = [] }) {
  const stacks = [];
  if (!clips || clips.length === 0) return stacks;

  const nodeMap = new Map();
  root.traverse((o) => { if (o.name) nodeMap.set(o.name, o); });

  for (const clip of clips) {
    const stack = buildStackPlan({ clip, root, nodeMap, uids, templates, meshes });
    if (stack) stacks.push(stack);
  }
  return stacks;
}

function buildStackPlan({ clip, root, nodeMap, uids, templates, meshes }) {
  const stackKey = animStackKey(clip.uuid || clip.name);
  const stackUid = uids.get(stackKey);
  const layerKey = animLayerKey(clip.uuid || clip.name);
  const layerUid = uids.get(layerKey);

  const groups = new Map();
  for (const track of clip.tracks) {
    const parsed = PropertyBinding.parseTrackName(track.name);
    if (!parsed.nodeName) continue;
    const node = nodeMap.get(parsed.nodeName) ||
                 PropertyBinding.findNode(root, parsed.nodeName);
    if (!node) continue;

    const kind = KINDS[parsed.propertyName];
    if (!kind) continue;

    if (parsed.propertyName === 'morphTargetInfluences' && parsed.propertyIndex == null) {
      const N = track.getValueSize();
      const TArr = track.values.constructor;
      for (let mi = 0; mi < N; mi++) {
        const sliceValues = new TArr(track.times.length);
        for (let k = 0; k < track.times.length; k++) {
          sliceValues[k] = track.values[k * N + mi];
        }
        const groupKey = `${node.uuid}|morphTargetInfluences[${mi}]`;
        groups.set(groupKey, {
          node,
          kind,
          propertyName: 'morphTargetInfluences',
          propertyIndex: String(mi),
          track: { times: track.times, values: sliceValues },
        });
      }
      continue;
    }

    const indexSuffix = parsed.propertyIndex != null ? `[${parsed.propertyIndex}]` : '';
    const groupKey = `${node.uuid}|${parsed.propertyName}${indexSuffix}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        node,
        kind,
        propertyName: parsed.propertyName,
        propertyIndex: parsed.propertyIndex,
        track: null,
      };
      groups.set(groupKey, group);
    }
    group.track = track;
  }

  if (groups.size === 0) return null;

  let durationSec = 0;
  for (const g of groups.values()) {
    if (g.track.times.length === 0) continue;
    const last = g.track.times[g.track.times.length - 1];
    if (last > durationSec) durationSec = last;
  }

  const curveNodes = [];
  for (const g of groups.values()) {
    const cn = buildCurveNode({ group: g, clip, uids, templates, meshes });
    if (cn) curveNodes.push(cn);
  }

  templates.register(animStackTemplate({})).users += 1;
  templates.register(animLayerTemplate({})).users += 1;

  return {
    stackKey, stackUid,
    layerKey, layerUid,
    name: clip.name || 'AnimStack',
    start: 0n,
    stop: secondsToKTime(durationSec),
    curveNodes,
  };
}

function buildCurveNode({ group, clip, uids, templates, meshes }) {
  const { node, kind, propertyName, propertyIndex, track } = group;
  const axes = kind.axes;
  const keySuffix = propertyIndex != null ? `[${propertyIndex}]` : '';
  const nodeUid = uids.get(
    animCurveNodeKey(clip.uuid || clip.name, node.uuid, `${propertyName}${keySuffix}`),
  );

  let perAxisValues;
  if (propertyName === 'quaternion') {
    perAxisValues = bakeQuaternionToEulerDegrees(track.values);
  } else if (propertyName === 'morphTargetInfluences') {
    perAxisValues = [[]];
    for (let i = 0; i < track.times.length; i++) {
      perAxisValues[0].push(track.values[i] * 100);
    }
  } else {
    perAxisValues = [[], [], []];
    for (let i = 0; i < track.times.length; i++) {
      perAxisValues[0].push(track.values[i * 3]);
      perAxisValues[1].push(track.values[i * 3 + 1]);
      perAxisValues[2].push(track.values[i * 3 + 2]);
    }
  }

  let resolvedTargetUid = null;
  if (propertyName === 'morphTargetInfluences') {
    const meshEntry = meshes.find((m) => m.object === node);
    if (!meshEntry || !meshEntry.morph) return null;
    const channel = meshEntry.morph.channels[parseInt(propertyIndex, 10)];
    if (!channel) return null;
    resolvedTargetUid = channel.channelUid;
  }

  const ktimes = new BigInt64Array(track.times.length);
  for (let i = 0; i < track.times.length; i++) ktimes[i] = secondsToKTime(track.times[i]);

  const curves = [];
  for (let ax = 0; ax < axes.length; ax++) {
    const curveUid = uids.get(animCurveKey(
      clip.uuid || clip.name, node.uuid, `${propertyName}${keySuffix}`, axes[ax],
    ));
    templates.register(animCurveTemplate({})).users += 1;
    curves.push({
      uid: curveUid,
      axis: axes[ax],
      defaultValue: perAxisValues[ax][0] ?? 0,
      times: ktimes,
      values: Float32Array.from(perAxisValues[ax]),
    });
  }

  templates.register(animCurveNodeTemplate({})).users += 1;

  return {
    targetUid: resolvedTargetUid,
    targetNode: node,
    fbxProp: kind.fbxProp,
    attrName: kind.attrName,
    curveNodeUid: nodeUid,
    curves,
  };
}

/**
 * Bake a flat quaternion array to per-axis Euler-degree arrays, ensuring
 * continuity across keyframes (no 360° jumps that would otherwise cause
 * FBXLoader's interpolation to spin the bone unnecessarily).
 *
 * Uses ZYX order to match the FBX RotationOrder=0 → three.js 'ZYX'
 * mapping used in model.js.
 */
function bakeQuaternionToEulerDegrees(quatValues) {
  const n = quatValues.length / 4;
  const xs = new Array(n);
  const ys = new Array(n);
  const zs = new Array(n);
  let prev = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    _quat.set(quatValues[i * 4], quatValues[i * 4 + 1], quatValues[i * 4 + 2], quatValues[i * 4 + 3]);
    _euler.setFromQuaternion(_quat, 'ZYX');
    const triple = [_euler.x * RAD_TO_DEG, _euler.y * RAD_TO_DEG, _euler.z * RAD_TO_DEG];
    if (i > 0) unrollEuler(prev, triple);
    xs[i] = triple[0];
    ys[i] = triple[1];
    zs[i] = triple[2];
    prev = triple;
  }
  return [xs, ys, zs];
}

/**
 * In-place adjust `curr` so its components are within 180° of `prev` —
 * this picks the equivalent Euler representation that keeps the curve
 * continuous. Important because Euler decomposition is non-unique; without
 * unrolling, a quaternion that crosses the antipode produces a 360° spike
 * in one axis that interpolates incorrectly.
 */
function unrollEuler(prev, curr) {
  for (let k = 0; k < 3; k++) {
    while (curr[k] - prev[k] > 180) curr[k] -= 360;
    while (curr[k] - prev[k] < -180) curr[k] += 360;
  }
}
