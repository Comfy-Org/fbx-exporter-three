/**
 * Emit FBXHeaderExtension, FileId, CreationTime, Creator, GlobalSettings,
 * Documents and References.
 */

import {
  elemEmpty,
  elemDataSingleInt32, elemDataSingleString, elemDataSingleBytes,
  elemDataSingleInt64,
  elemProperties, elemPropsSet, fbxNameClass,
} from '../core/elemHelpers.js';
import {
  FBX_VERSION, FBX_HEADER_VERSION, FBX_SCENEINFO_VERSION,
  FBX_KTIME, RIGHT_HAND_AXES, FBX_FRAMERATES,
  APP_VENDOR, APP_NAME, APP_VERSION,
} from '../constants.js';
import { documentKey } from '../core/uid.js';

function creatorString(settings) {
  if (settings && typeof settings.creator === 'string' && settings.creator) {
    return settings.creator;
  }
  return `${APP_NAME} - ${APP_VERSION}`;
}

function fpsToMode(fps) {
  for (const entry of FBX_FRAMERATES) {
    if (entry.fps > 0 && Math.abs(entry.fps - fps) < 1e-4) return entry.mode;
  }
  return 14;
}

/**
 * @param {object} ctx
 * @param {object} ctx.root        FBXElem root container
 * @param {object} ctx.settings    user options
 * @param {string} ctx.sceneName   scene name (becomes the FBX Document name)
 * @param {object} ctx.uidRegistry UidRegistry for document UID allocation
 */
export function writeHeaderSection({ root, settings, sceneName = 'Scene' }) {
  const headerExt = elemEmpty(root, 'FBXHeaderExtension');
  elemDataSingleInt32(headerExt, 'FBXHeaderVersion', FBX_HEADER_VERSION);
  elemDataSingleInt32(headerExt, 'FBXVersion', settings.version ?? FBX_VERSION);
  elemDataSingleInt32(headerExt, 'EncryptionType', 0);

  const ts = elemEmpty(headerExt, 'CreationTimeStamp');
  elemDataSingleInt32(ts, 'Version', 1000);
  elemDataSingleInt32(ts, 'Year', 1970);
  elemDataSingleInt32(ts, 'Month', 1);
  elemDataSingleInt32(ts, 'Day', 1);
  elemDataSingleInt32(ts, 'Hour', 0);
  elemDataSingleInt32(ts, 'Minute', 0);
  elemDataSingleInt32(ts, 'Second', 0);
  elemDataSingleInt32(ts, 'Millisecond', 0);

  elemDataSingleString(headerExt, 'Creator', creatorString(settings));

  const sceneInfo = elemDataSingleString(headerExt, 'SceneInfo',
    fbxNameClass('GlobalInfo', 'SceneInfo'));
  sceneInfo.addString('UserData');
  elemDataSingleString(sceneInfo, 'Type', 'UserData');
  elemDataSingleInt32(sceneInfo, 'Version', FBX_SCENEINFO_VERSION);
  const meta = elemEmpty(sceneInfo, 'MetaData');
  elemDataSingleInt32(meta, 'Version', FBX_SCENEINFO_VERSION);
  for (const k of ['Title', 'Subject', 'Author', 'Keywords', 'Revision', 'Comment']) {
    elemDataSingleString(meta, k, '');
  }
  const sceneProps = elemProperties(sceneInfo);
  elemPropsSet(sceneProps, 'p_string_url', 'DocumentUrl', '/foobar.fbx');
  elemPropsSet(sceneProps, 'p_string_url', 'SrcDocumentUrl', '/foobar.fbx');
  for (const group of ['Original', 'LastSaved']) {
    elemPropsSet(sceneProps, 'p_compound', group);
    elemPropsSet(sceneProps, 'p_string', `${group}|ApplicationVendor`, APP_VENDOR);
    elemPropsSet(sceneProps, 'p_string', `${group}|ApplicationName`, APP_NAME);
    elemPropsSet(sceneProps, 'p_string', `${group}|ApplicationVersion`, APP_VERSION);
    elemPropsSet(sceneProps, 'p_datetime', `${group}|DateTime_GMT`,
      '01/01/1970 00:00:00.000');
  }

  elemDataSingleBytes(root, 'FileId', new Uint8Array(16));
  elemDataSingleString(root, 'CreationTime', '1970-01-01 10:00:00:000');
  elemDataSingleString(root, 'Creator', creatorString(settings));

  writeGlobalSettings(root, settings);
  writeDocuments(root, sceneName);
  elemEmpty(root, 'References');
}

function writeGlobalSettings(root, settings) {
  const gs = elemEmpty(root, 'GlobalSettings');
  elemDataSingleInt32(gs, 'Version', 1000);

  const axisKey = `${settings.axisUp ?? 'Y'}|${settings.axisForward ?? 'Z'}`;
  const axes = RIGHT_HAND_AXES[axisKey] ?? RIGHT_HAND_AXES['Y|Z'];

  const unitScale = settings.unitScale ?? 1.0;
  const fps = settings.fps ?? 24.0;

  const props = elemProperties(gs);
  elemPropsSet(props, 'p_integer', 'UpAxis',             axes.up[0]);
  elemPropsSet(props, 'p_integer', 'UpAxisSign',         axes.up[1]);
  elemPropsSet(props, 'p_integer', 'FrontAxis',          axes.front[0]);
  elemPropsSet(props, 'p_integer', 'FrontAxisSign',      axes.front[1]);
  elemPropsSet(props, 'p_integer', 'CoordAxis',          axes.coord[0]);
  elemPropsSet(props, 'p_integer', 'CoordAxisSign',      axes.coord[1]);
  elemPropsSet(props, 'p_integer', 'OriginalUpAxis',     -1);
  elemPropsSet(props, 'p_integer', 'OriginalUpAxisSign', 1);
  elemPropsSet(props, 'p_double',  'UnitScaleFactor',         unitScale);
  elemPropsSet(props, 'p_double',  'OriginalUnitScaleFactor', unitScale);
  elemPropsSet(props, 'p_color_rgb', 'AmbientColor', [0, 0, 0]);
  elemPropsSet(props, 'p_string', 'DefaultCamera', 'Producer Perspective');
  elemPropsSet(props, 'p_enum', 'TimeMode', fpsToMode(fps));
  elemPropsSet(props, 'p_timestamp', 'TimeSpanStart', 0n);
  elemPropsSet(props, 'p_timestamp', 'TimeSpanStop',  FBX_KTIME);
  elemPropsSet(props, 'p_double', 'CustomFrameRate', fps);
}

function writeDocuments(root, sceneName) {
  const docs = elemEmpty(root, 'Documents');
  elemDataSingleInt32(docs, 'Count', 1);

  const docUid = simpleHashI64(documentKey(sceneName));
  const doc = elemDataSingleInt64(docs, 'Document', docUid);
  doc.addString(sceneName);
  doc.addString(sceneName);
  const props = elemProperties(doc);
  elemPropsSet(props, 'p_object', 'SourceObject');
  elemPropsSet(props, 'p_string', 'ActiveAnimStackName', '');
  elemDataSingleInt64(doc, 'RootNode', 0n);
}

function simpleHashI64(s) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x00000100000001b3n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h & ((1n << 63n) - 1n);
}
