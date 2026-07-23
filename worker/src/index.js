import { CONNECTION_CONTEXT_PENDING, validateFetchProfile } from './shared/fetch-profile-schema.js';
import { buildSessionRuntimePlan, validateSessionTimeline } from './shared/session-timeline-schema.js';
import { compareProtobufBinary } from './shared/protobuf-binary-compare.js';
import { auditFetchProfile, classifyFetchRejection } from './shared/profile-audit.js';

const SERVICE_NAME = 'mahjong-paipu-proxy';
const SERVICE_VERSION = '5.4.0';
const DEFAULT_ALLOWED_ORIGIN = 'https://8h4f6g6dgf-hub.github.io';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_PAYLOAD_BYTES = 6 * 1024 * 1024;
const MAJSOUL_PAGE_URL = 'https://game.mahjongsoul.com/';
// v5.3.0: 2026-07-19の現行公式Web画面に表示された v0.16.206.W.4.0.11 を根拠にする。
const CURRENT_LIQI_CLIENT_VERSION = 'web-0.16.206';
const AUTH_SECRET_NAME = 'MAJSOUL_OAUTH2_CREDENTIALS';
const FETCH_PROFILE_SECRET_NAME = 'MAJSOUL_FETCH_GAME_RECORD_PROFILE';
const AUTH_STATES = Object.freeze({
  SECRET_NOT_CONFIGURED: 'SECRET_NOT_CONFIGURED', SECRET_FORMAT_INVALID: 'SECRET_FORMAT_INVALID',
  OAUTH_PREFLIGHT_FAILED: 'OAUTH_PREFLIGHT_FAILED', OAUTH_REQUEST_BUILD_FAILED: 'OAUTH_REQUEST_BUILD_FAILED', OAUTH_RPC_SENT: 'OAUTH_RPC_SENT',
  OAUTH_RESPONSE_RECEIVED: 'OAUTH_RESPONSE_RECEIVED', OAUTH_REJECTED: 'OAUTH_REJECTED',
  OAUTH_TOKEN_EXPIRED: 'OAUTH_TOKEN_EXPIRED', CLIENT_VERSION_MISMATCH: 'CLIENT_VERSION_MISMATCH',
  SESSION_NOT_ESTABLISHED: 'SESSION_NOT_ESTABLISHED', SESSION_ESTABLISHMENT_FAILED: 'SESSION_ESTABLISHMENT_FAILED', AUTHENTICATED: 'AUTHENTICATED',
  FETCH_GAME_RECORD_REACHED: 'FETCH_GAME_RECORD_REACHED',
  AUTH_FAILED: 'AUTH_FAILED', SESSION_FAILED: 'SESSION_FAILED', FETCH_GAME_RECORD_FAILED: 'FETCH_GAME_RECORD_FAILED',
  SESSION_TIMELINE_PROFILE_INVALID: 'SESSION_TIMELINE_PROFILE_INVALID', SESSION_READY_TIMEOUT: 'SESSION_READY_TIMEOUT',
  REQUIRED_SERVER_EVENT_NOT_RECEIVED: 'REQUIRED_SERVER_EVENT_NOT_RECEIVED', HEARTBEAT_FAILED: 'HEARTBEAT_FAILED',
  INTERMEDIATE_RPC_FAILED: 'INTERMEDIATE_RPC_FAILED', REQUEST_ID_TIMING_MISMATCH: 'REQUEST_ID_TIMING_MISMATCH',
  FETCH_GAME_RECORD_SESSION_REJECTED: 'FETCH_GAME_RECORD_SESSION_REJECTED',
  READ_GAME_RECORD_FAILED: 'READ_GAME_RECORD_FAILED', GAME_RECORD_DETAIL_FAILED: 'GAME_RECORD_DETAIL_FAILED',
  RECORD_NOT_FOUND: 'RECORD_NOT_FOUND', PAYLOAD_EMPTY: 'PAYLOAD_EMPTY', PROTOBUF_ENVELOPE_PARSE_FAILED: 'PROTOBUF_ENVELOPE_PARSE_FAILED',
  PROTOBUF_DECODE_FAILED: 'PROTOBUF_DECODE_FAILED', UNKNOWN_RPC_ERROR: 'UNKNOWN_RPC_ERROR', PAIPU_FETCH_SUCCEEDED: 'PAIPU_FETCH_SUCCEEDED'
});

const SAFE_VALIDATION_DEFAULTS = Object.freeze({ profileSchemaValid: false, profileVersionValid: false, fetchGameRecordRuntimeReady: false, validationStage: 'static-profile-validation', rpcExecutionStarted: false, connectionContextStatus: CONNECTION_CONTEXT_PENDING, connectionContextMatched: null, sessionTimelineProfileValid: false, sessionTimelineSource: 'missing', sessionTimelineLegacyReason: null, prepareLoginToFetchHarDelayMs: 0, prepareLoginToFetchActualDelayMs: 0, sessionTimingStrategy: 'legacy-response-trigger', sessionTimingAttemptCount: 1, sessionTimingAttempts: [], intermediateEventCount: 0, heartbeatObservedInHar: false, heartbeatSentAtRuntime: false, requiredIntermediateRpc: null, requiredServerEvent: null, requiredServerEventObserved: false, requestIdBeforeFetch: 2, requestIdAtFetch: 3, requestIdDeltaMatched: true, fetchGameRecordAttemptedAfterSessionReady: false, sessionReadyReason: null, sessionTimingMatched: null, payloadByteMatch: null, payloadLengthMatch: null, protobufBinaryMatch: null, protobufObjectMatch: null, encodeMatch: null, unknownFieldCount: 0, unknownFieldSummary: 'none', binaryDiffSummary: 'not-compared', binaryComparisonSource: 'missing', harBinaryCompared: false, nextRpcBlocked: false, nextRpcBlockedReason: null, missingInputRole: null, missingInputSource: null });

function safeAuthDiagnostic(overrides = {}) {
  // v5.3.7: 静的検証中の接続状態をfalseへ丸めず、実RPC後の判定と明確に分離する。
  overrides = { ...SAFE_VALIDATION_DEFAULTS, ...overrides };
  return { authStage: 'SECRET_LOADING', authState: AUTH_STATES.SECRET_NOT_CONFIGURED, oauthRpcName: '.lq.Lobby.prepareLogin', oauthRequestBuilt: false, oauthResponseReceived: false, sessionEstablished: false, fetchGameRecordReached: false, rpcTimeline: [], rpcSequence: [], currentRpc: null, recordResolveReached: false, recordResolveSucceeded: false, resolvedRecordIdType: 'completePaipuId', resolvedRecordIdSource: 'sharedUrlPageState', resolvedRecordIdAvailable: true, fetchGameRecordInputType: 'completePaipuId', fetchGameRecordInputSource: 'sharedUrlPageState', nextRpc: '.lq.Route.requestConnection', confirmedRpcCount: 0, requestMatchScore: 0, envelopeMatchScore: 0, fieldMatchScore: 0, messageMatchScore: 0, requestFullyMatched: false, responseFullyMatched: false, harCompared: false, fetchGameRecordRequestValidated: false, requestSemanticMatched: false, connectionContextMatched: false, requestIdSequenceMatched: false, clientVersionSourceRole: null, clientVersionSourceRpc: null, clientVersionValidated: false, clientVersionIsRouteId: false, clientVersionSemanticMatch: false, field1SourceValidated: false, field2SourceValidated: false, remainingMismatchCategory: 'SECRET_SEMANTICS_UNCONFIRMED', readGameRecordReached: false, readGameRecordRequestSent: false, readGameRecordResponseReceived: false, readGameRecordSucceeded: false, readGameRecordRpcCode: null, readGameRecordResponseType: null, readGameRecordEnvelopeType: null, readGameRecordMessageType: null, readGameRecordPayloadDetected: false, readGameRecordPayloadSize: 0, readGameRecordErrorDetected: false, readGameRecordErrorCode: null, readGameRecordErrorMessage: null, readGameRecordNextInputType: 'completePaipuId', readGameRecordNextInputSource: 'sharedUrlPageState', fetchGameRecordsDetailReached: false, fetchGameRecordsDetailRequestSent: false, fetchGameRecordsDetailResponseReceived: false, fetchGameRecordsDetailSucceeded: false, fetchGameRecordsDetailRpcCode: null, fetchGameRecordsDetailResponseType: null, fetchGameRecordsDetailEnvelopeType: null, fetchGameRecordsDetailMessageType: null, fetchGameRecordsDetailPayloadDetected: false, fetchGameRecordsDetailPayloadSize: 0, fetchGameRecordsDetailErrorDetected: false, fetchGameRecordsDetailErrorCode: null, fetchGameRecordsDetailErrorMessage: null, protobufDetected: false, protobufEnvelopeParsed: false, envelopeType: null, messageType: null, payloadLength: 0, fieldNumbers: [], wireTypes: [], nestedPayloadDetected: false, compressionDetected: null, payloadEncoding: null, actualFailureStage: null, actualFailureRpc: null, actualFailureCode: null, actualFailureReason: null, classificationCorrected: false, previousClassification: null, currentClassification: null, safeErrorCode: null, safeErrorMessage: null, nextAction: 'Worker Secretを登録してください', confirmedAuthFlowVersion: 'route-prepare-login-record-v5', confirmedSecretSchema: ['flowVersion', 'connectionType', 'routeContextString', 'providerType', 'prepareLoginToken', 'fetchGameRecordProfile'], implementationEvidence: ['current Chrome sanitized HAR', '.lq.Route.requestConnection', '.lq.Lobby.prepareLogin', '.lq.Lobby.fetchGameRecord', '.lq.Lobby.readGameRecord', '.lq.Lobby.fetchGameRecordsDetailV2', 'jp-WebGL-release-4.0.11(12)'], ...overrides };
}

function classifyOauthError(rpcError) {
  const officialCode = rpcError && Number.isInteger(rpcError.code) ? rpcError.code : null;
  const message = String(rpcError && rpcError.message || '').toLowerCase();
  if (officialCode === 151) return { code: 'MAJSOUL_151_LEGACY_FLOW_REJECTED', message: '現行Gatewayが旧oauth2Loginフローを拒否しました', nextAction: '現行prepareLogin形式のSecretを再登録してください' };
  if (/expir|期限/.test(message)) return { code: officialCode == null ? 'TOKEN_EXPIRED' : 'MAJSOUL_' + officialCode + '_TOKEN_EXPIRED', message: 'OAuthトークンの期限が切れています', nextAction: '認証Secretを再取得して登録し直してください' };
  if (/token|credential|認証/.test(message)) return { code: officialCode == null ? 'OAUTH_TOKEN_INVALID' : 'MAJSOUL_' + officialCode + '_TOKEN_INVALID', message: 'OAuthトークンが無効です', nextAction: '認証Secretを再取得して登録し直してください' };
  if (/account|user|アカウント/.test(message)) return { code: officialCode == null ? 'ACCOUNT_MISMATCH' : 'MAJSOUL_' + officialCode + '_ACCOUNT_MISMATCH', message: '認証情報とアカウントが一致しません', nextAction: '同じアカウントで認証Secretを再取得してください' };
  if (/version|client|バージョン/.test(message)) return { code: officialCode == null ? 'CLIENT_VERSION_MISMATCH' : 'MAJSOUL_' + officialCode + '_CLIENT_VERSION_MISMATCH', message: 'clientVersionが受け付けられませんでした', nextAction: '現行Web版を再解析してから再試行してください' };
  return { code: officialCode == null ? 'OAUTH_REJECTED_UNKNOWN' : 'MAJSOUL_' + officialCode, message: 'OAuth認証が拒否されました', nextAction: '認証Secretを再取得して登録し直してください' };
}

function safeAuthError(state, diagnostic, status = 401) {
  const error = new Error(diagnostic.safeErrorMessage || 'OAuth認証に失敗しました'); error.code = state; error.status = status; error.authDiagnostic = diagnostic; return error;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowedOrigin = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
  const headers = { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Accept', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
  if (origin === allowedOrigin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function jsonResponse(request, env, body, status = 200) {
  return Response.json(body, { status, headers: { ...corsHeaders(request, env), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function errorResponse(request, env, status, code, message, details) {
  const body = { ok: false, error: { code, message } };
  if (details) body.diagnostics = details;
  return jsonResponse(request, env, body, status);
}

function extractPaipuId(value) {
  value = String(value || '').trim();
  if (/^https?:\/\//i.test(value)) {
    const sharedUrl = new URL(value);
    const host = sharedUrl.hostname.toLowerCase();
    if (host !== 'game.mahjongsoul.com' && !host.endsWith('.mahjongsoul.com')) return null;
    value = sharedUrl.searchParams.get('paipu') || '';
    if (!value && sharedUrl.hash) value = new URLSearchParams(sharedUrl.hash.includes('?') ? sharedUrl.hash.split('?')[1] : sharedUrl.hash.slice(1)).get('paipu') || '';
  }
  try { value = decodeURIComponent(value); } catch (_) {}
  return validatePaipuId(value) ? value : null;
}

function validatePaipuId(value) {
  // v5.3.0: 任意URLを中継させず、共有URLまたは安全な牌譜IDだけを現行RPCへ渡す。
  return typeof value === 'string' && value.length >= 8 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

function bytesToBase64(bytes) {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(result);
}

function encodeVarint(value) {
  const result = [];
  value = Number(value) >>> 0;
  do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; result.push(byte); } while (value);
  return result;
}

function encodeBytesField(id, bytes) { return [(id << 3) | 2, ...encodeVarint(bytes.length), ...bytes]; }
function encodeStringField(id, value) { return encodeBytesField(id, new TextEncoder().encode(value)); }
function encodeVarintField(id, value) { return [(id << 3), ...encodeVarint(value)]; }

function readVarint(bytes, offset) {
  let value = 0, shift = 0, byte;
  do { if (offset >= bytes.length || shift > 35) throw new Error('Invalid protobuf varint'); byte = bytes[offset++]; value += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
  return { value, offset };
}

function readProtobufFields(bytes) {
  const fields = new Map();
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset); offset = tag.offset;
    const id = tag.value >>> 3, wire = tag.value & 7;
    let value;
    if (wire === 0) { const parsed = readVarint(bytes, offset); value = parsed.value; offset = parsed.offset; }
    else if (wire === 1) { value = bytes.slice(offset, offset + 8); offset += 8; }
    else if (wire === 2) { const length = readVarint(bytes, offset); offset = length.offset; value = bytes.slice(offset, offset + length.value); offset += length.value; }
    else if (wire === 5) { value = bytes.slice(offset, offset + 4); offset += 4; }
    else throw new Error('Unsupported protobuf wire type: ' + wire);
    if (offset > bytes.length || !id) throw new Error('Invalid protobuf field');
    if (!fields.has(id)) fields.set(id, []);
    fields.get(id).push(value);
  }
  return fields;
}

function firstBytes(fields, id) { const values = fields.get(id); return values && values[0] instanceof Uint8Array ? values[0] : null; }
function decodeText(bytes) { return bytes ? new TextDecoder().decode(bytes) : ''; }

function parseRpcError(bytes) {
  if (!bytes || !bytes.length) return null;
  try {
    const fields = readProtobufFields(bytes);
    const codeValues = fields.get(1), message = decodeText(firstBytes(fields, 2));
    return { code: codeValues && typeof codeValues[0] === 'number' ? codeValues[0] : null, message: message || null };
  } catch (_) { return { code: null, message: null }; }
}

function buildNamedRpcRequest(method, requestBody, requestId = 1) {
  const wrapper = new Uint8Array([
    ...encodeStringField(1, method),
    ...encodeBytesField(2, requestBody)
  ]);
  return new Uint8Array([2, requestId & 0xff, (requestId >>> 8) & 0xff, ...wrapper]);
}

function buildRpcRequest(paipuId, clientContext, requestId = 1, profile = null) {
  // v5.3.5: HARで検証済みのfield順・wire type・値の出所だけからリクエストを構築する。
  const fields = profile && Array.isArray(profile.requestFields) ? profile.requestFields : [{ field: 1, wire: 2, source: 'completePaipuId' }, { field: 2, wire: 2, source: 'fetchClientContext' }];
  const requestBody = new Uint8Array(fields.flatMap((item) => {
    if (item.wire !== 2) throw new Error('Unsupported validated fetchGameRecord wire type');
    if (item.source === 'completePaipuId') return encodeStringField(item.field, paipuId);
    if (item.source === 'fetchClientContext') return encodeStringField(item.field, clientContext);
    throw new Error('Unsupported validated fetchGameRecord field source');
  }));
  return buildNamedRpcRequest('.lq.Lobby.fetchGameRecord', requestBody, requestId);
}

function compareFetchRequestToProfile(request, profile) {
  // v5.3.7: 登録済みv2を維持しつつ、共有スキーマで生成するv3も同じ比較処理へ通す。
  if (!profile || !/^current-har-v[23]$/.test(profile.version || profile.profileVersion || '')) return { requestMatchScore: 0, envelopeMatchScore: 0, fieldMatchScore: 0, messageMatchScore: 0, requestFullyMatched: false, harCompared: false, fetchGameRecordRequestValidated: false };
  try {
    const envelope = inspectWireFields(request.slice(3)), method = decodeText(envelope.find((item) => item.field === 1 && item.wire === 2)?.value), body = envelope.find((item) => item.field === 2 && item.wire === 2)?.value || new Uint8Array(), bodyFields = inspectWireFields(body);
    const messageMatchScore = method === profile.messageType ? 100 : 0;
    const envelopeShape = envelope.map((item) => `${item.field}:${item.wire}`).join(','), expectedEnvelope = profile.envelopeFields.map((item) => `${item.field}:${item.wire}`).join(',');
    const envelopeMatchScore = envelopeShape === expectedEnvelope ? 100 : 0;
    const fieldShape = bodyFields.map((item) => `${item.field}:${item.wire}`).join(','), expectedFields = profile.requestFields.map((item) => `${item.field}:${item.wire}`).join(',');
    const fieldMatchScore = fieldShape === expectedFields ? 100 : 0;
    const requestMatchScore = Math.round((messageMatchScore + envelopeMatchScore + fieldMatchScore) / 3), requestFullyMatched = requestMatchScore === 100;
    return { requestMatchScore, envelopeMatchScore, fieldMatchScore, messageMatchScore, requestFullyMatched, harCompared: true, fetchGameRecordRequestValidated: requestFullyMatched && profile.validated === true };
  } catch (_) { return { requestMatchScore: 0, envelopeMatchScore: 0, fieldMatchScore: 0, messageMatchScore: 0, requestFullyMatched: false, harCompared: true, fetchGameRecordRequestValidated: false }; }
}

function compareFetchRequestBinary(request, profile, paipuId, clientContext, requestId) {
  // v5.3.9: HAR由来Profileから独立した参照objectを再構築する。生HAR byteがない場合は比較元を明記する。
  try {
    const referenceBody = new Uint8Array((profile.requestFields || []).flatMap((item) => {
      if (item.wire !== 2) throw new Error('Unsupported reference wire type');
      if (item.source === 'completePaipuId') return encodeStringField(item.field, paipuId);
      if (item.source === 'fetchClientContext') return encodeStringField(item.field, clientContext);
      throw new Error('Unknown reference field source');
    }));
    const reference = buildNamedRpcRequest(profile.messageType, referenceBody, requestId);
    const actualEnvelope = inspectWireFields(request.slice(3)), actualBody = actualEnvelope.find((item) => item.field === 2 && item.wire === 2)?.value || new Uint8Array();
    const bodyComparison = compareProtobufBinary(actualBody, referenceBody, { knownFields: [1, 2] });
    const requestComparison = compareProtobufBinary(request.slice(3), reference.slice(3), { knownFields: [1, 2] });
    const hasCapturedBinaryMetadata = Boolean(profile.binaryProfile && profile.binaryProfile.validated === true);
    const capturedLengthMatch = hasCapturedBinaryMetadata ? profile.binaryProfile.requestLength === request.length && profile.binaryProfile.payloadLength === actualBody.length : null;
    return {
      ...bodyComparison,
      payloadLengthMatch: bodyComparison.payloadLengthMatch && (capturedLengthMatch == null || profile.binaryProfile.payloadLength === actualBody.length),
      protobufBinaryMatch: requestComparison.protobufBinaryMatch,
      encodeMatch: requestComparison.encodeMatch,
      protobufObjectMatch: requestComparison.protobufObjectMatch && bodyComparison.protobufObjectMatch,
      binaryDiffSummary: requestComparison.protobufBinaryMatch ? 'request-and-payload-binary-identical' : requestComparison.binaryDiffSummary,
      binaryComparisonSource: hasCapturedBinaryMetadata ? 'current-har-safe-binary-metadata' : `profile-reconstructed-${profile.profileVersion || profile.version || 'unknown'}`,
      // HARの生byteはSecretへ保存しないため、長さ・field順を使えてもraw binary比較済みとは表示しない。
      harBinaryCompared: false,
      capturedLengthMatch
    };
  } catch (_) {
    return { payloadByteMatch: null, payloadLengthMatch: null, protobufBinaryMatch: null, protobufObjectMatch: false, encodeMatch: false, unknownFieldCount: 0, unknownFieldSummary: 'reference-unavailable', binaryDiffSummary: 'reference-request-could-not-be-built', binaryComparisonSource: 'missing', harBinaryCompared: false, capturedLengthMatch: null };
  }
}

function parseAuthSecret(env) {
  if (!env || !env[AUTH_SECRET_NAME]) return null;
  try {
    const value = JSON.parse(env[AUTH_SECRET_NAME]);
    // v5.3.6: 接続済みHARでは認証RPCが再送されないため、検証済みfetch contextを別Secretで更新可能にする。
    // v5.3.6: 旧い別Secretが残っていても、同時登録された現行v2プロファイルを優先できるようにする。
    let separateProfile = null;
    try { separateProfile = env[FETCH_PROFILE_SECRET_NAME] ? JSON.parse(env[FETCH_PROFILE_SECRET_NAME]) : null; } catch (_) { separateProfile = null; }
    const selectedProfile = separateProfile && /^current-har-v[23]$/.test(separateProfile.version || separateProfile.profileVersion || '') ? separateProfile : value.fetchGameRecordProfile;
    const profileValidation = validateFetchProfile(selectedProfile);
    const profile = profileValidation.profile;
    const profileValid = profileValidation.profileSchemaValid;
    const routeContextString = typeof value.routeContextString === 'string' && value.routeContextString ? value.routeContextString : value.clientVersionString;
    if (value.flowVersion !== 'route-prepare-login-v1' || !Number.isInteger(value.connectionType) || typeof routeContextString !== 'string' || !routeContextString || !Number.isInteger(value.providerType) || typeof value.prepareLoginToken !== 'string' || !value.prepareLoginToken || !profileValid) return null;
    const sessionTimelineValidation = validateSessionTimeline(profile.sessionTimeline);
    return { flowVersion: value.flowVersion, connectionType: value.connectionType, routeContextString, fetchClientContext: profile.fetchClientContext, providerType: value.providerType, prepareLoginToken: value.prepareLoginToken, fetchGameRecordProfile: profile, fetchProfileValidation: profileValidation, sessionTimelineValidation };
  } catch (_) { return null; }
}

function safeAnalysisForClient(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;
  // v5.3.6: 完全牌譜IDを含む共有URLは診断JSONへ返さず、取得元の役割だけを表示する。
  const html = analysis.html && typeof analysis.html === 'object'
    ? { ...analysis.html, requestedUrl: 'majsoul-shared-page', finalUrl: 'majsoul-shared-page' }
    : analysis.html;
  return { ...analysis, html };
}

function buildRequestConnectionRequest(auth, requestId) {
  return buildNamedRpcRequest('.lq.Route.requestConnection', new Uint8Array([
    ...encodeVarintField(2, auth.connectionType), ...encodeStringField(3, auth.routeContextString), ...encodeVarintField(4, Math.floor(Date.now() / 1000))
  ]), requestId);
}

function buildPrepareLoginRequest(auth, requestId) {
  return buildNamedRpcRequest('.lq.Lobby.prepareLogin', new Uint8Array([
    ...encodeStringField(1, auth.prepareLoginToken), ...encodeVarintField(2, auth.providerType)
  ]), requestId);
}

function buildReadGameRecordRequest(fetchClientContext, requestId) {
  // v5.3.3: 現行HARでfetchGameRecord field 2と同一値だったfield 2だけを送る。
  return buildNamedRpcRequest('.lq.Lobby.readGameRecord', new Uint8Array([
    ...encodeStringField(2, fetchClientContext)
  ]), requestId);
}

function buildGameRecordsDetailRequest(paipuId, requestId) {
  // v5.3.3: 現行HARでfetchGameRecord field 1と同一値だった完全牌譜IDを再利用する。
  return buildNamedRpcRequest('.lq.Lobby.fetchGameRecordsDetailV2', new Uint8Array([
    ...encodeStringField(1, paipuId)
  ]), requestId);
}

function buildOauth2CheckRequest(auth, requestId) {
  return buildNamedRpcRequest('.lq.Lobby.oauth2Check', new Uint8Array([
    ...encodeVarintField(1, auth.type), ...encodeStringField(2, auth.accessToken)
  ]), requestId);
}

function buildOauth2LoginRequest(auth, clientVersion, requestId) {
  const device = new Uint8Array([
    ...encodeStringField(1, 'pc'), ...encodeStringField(2, 'pc'), ...encodeStringField(3, 'macOS'),
    ...encodeStringField(4, 'unknown'), ...encodeVarintField(5, 1), ...encodeStringField(6, 'Chrome'), ...encodeStringField(7, 'web')
  ]);
  const version = new Uint8Array([...encodeStringField(1, clientVersion), ...encodeStringField(2, 'web')]);
  const randomKey = crypto.randomUUID().replace(/-/g, '');
  return buildNamedRpcRequest('.lq.Lobby.oauth2Login', new Uint8Array([
    ...encodeVarintField(1, auth.type), ...encodeStringField(2, auth.accessToken), ...encodeVarintField(3, 0),
    ...encodeBytesField(4, device), ...encodeStringField(5, randomKey), ...encodeBytesField(6, version)
  ]), requestId);
}

function parseRpcResponse(bytes, requestId = 1) {
  if (bytes.length < 4 || bytes[0] !== 3) throw new Error('Unexpected Liqi response type');
  const responseId = bytes[1] | (bytes[2] << 8);
  if (responseId !== requestId) throw new Error('Unexpected Liqi response id');
  const wrapper = readProtobufFields(bytes.slice(3));
  const method = decodeText(firstBytes(wrapper, 1));
  const responseBody = firstBytes(wrapper, 2);
  if (!responseBody) throw new Error('Liqi response body is empty');
  const record = readProtobufFields(responseBody);
  return {
    method,
    raw: responseBody,
    error: firstBytes(record, 1),
    head: firstBytes(record, 3),
    data: firstBytes(record, 4),
    dataUrl: decodeText(firstBytes(record, 5))
  };
}

function extractUnityConfig(html) {
  const variables = {};
  for (const match of html.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"']*)["']/g)) variables[match[1]] = match[2];
  const resolveExpression = (expression) => {
    if (!expression) return null;
    const parts = expression.split('+').map((part) => part.trim());
    let value = '';
    for (const part of parts) {
      const literal = part.match(/^["']([^"']*)["']$/);
      if (literal) value += literal[1];
      else if (Object.prototype.hasOwnProperty.call(variables, part)) value += variables[part];
      else return null;
    }
    return value;
  };
  const pick = (key, absolute = true) => {
    const match = html.match(new RegExp(key + '\\s*:\\s*([^,\\n}]+)', 'i'));
    const value = match ? resolveExpression(match[1].trim()) : null;
    return value && absolute ? new URL(value, MAJSOUL_PAGE_URL).href : value;
  };
  const loaderMatch = html.match(/<script[^>]+src=["']([^"']*loader\.js[^"']*)["']/i);
  const loaderUrl = loaderMatch ? new URL(loaderMatch[1], MAJSOUL_PAGE_URL).href : null;
  const fileText = [loaderUrl, pick('dataUrl'), pick('frameworkUrl'), pick('codeUrl')].filter(Boolean).join(' ');
  const versionMatch = fileText.match(/(?:jp-WebGL-release-)?(\d+\.\d+\.\d+)/i);
  return { loaderUrl, dataUrl: pick('dataUrl'), frameworkUrl: pick('frameworkUrl'), codeUrl: pick('codeUrl'), streamingAssetsUrl: pick('streamingAssetsUrl'), companyName: pick('companyName', false), productName: pick('productName', false), productVersion: pick('productVersion', false), buildVersion: versionMatch ? versionMatch[1] : pick('productVersion', false) };
}

function extractLoaderAnalysis(text, loaderUrl) {
  const urls = [...new Set((text.match(/(?:https?:\/\/|wss?:\/\/)[^\s"'`)]+/g) || []))];
  const unityMatch = text.match(/(?:unityVersion|unity-version)["':=\s]+([\w.-]+)/i);
  return { url: loaderUrl, characters: text.length, unityVersion: unityMatch ? unityMatch[1] : null, detectedUrls: urls.slice(0, 50), keywords: ['fetch', 'WebSocket', 'framework', 'wasm', 'data'].filter((word) => text.toLowerCase().includes(word.toLowerCase())) };
}

async function fetchText(url, signal) {
  const response = await fetch(url, { signal, redirect: 'follow', headers: { Accept: 'text/html,application/javascript,application/json,*/*;q=0.5' } });
  if (!response.ok) throw new Error(url + ' HTTP ' + response.status);
  return { response, text: await response.text() };
}

async function analyzeCurrentClient(paipuId, signal) {
  const sharedUrl = MAJSOUL_PAGE_URL + '?paipu=' + encodeURIComponent(paipuId);
  const page = await fetchText(sharedUrl, signal);
  const config = extractUnityConfig(page.text);
  if (!config.loaderUrl) throw new Error('Current loader.js was not found');
  const loader = await fetchText(config.loaderUrl, signal);
  const loaderAnalysis = extractLoaderAnalysis(loader.text, config.loaderUrl);
  const version = config.buildVersion || '4.0.11';
  const routesUrl = 'https://jpgs.mahjongsoul.com/api/clientgate/routes?platform=Web&version=' + encodeURIComponent(version) + '&lang=jp';
  const routesResponse = await fetch(routesUrl, { signal, redirect: 'follow', headers: { Accept: 'application/json' } });
  if (!routesResponse.ok) throw new Error('clientgate/routes HTTP ' + routesResponse.status);
  const routesJson = await routesResponse.json();
  const routes = routesJson && routesJson.data && Array.isArray(routesJson.data.routes) ? routesJson.data.routes : [];
  const route = routes.find((item) => item && item.state !== 'maintenance') || routes[0];
  if (!route || !route.domain) throw new Error('Available gateway route was not found');
  const gatewayUrl = (route.ssl === false ? 'ws://' : 'wss://') + route.domain + '/gateway';
  return {
    sharedUrl,
    html: { requestedUrl: sharedUrl, finalUrl: page.response.url, httpStatus: page.response.status, contentType: page.response.headers.get('content-type'), redirect: page.response.redirected },
    unityConfig: config,
    loader: loaderAnalysis,
    buildVersion: version,
    unityVersion: loaderAnalysis.unityVersion || '2022.3.62f2c1',
    appJson: { status: '現行Unity版ではclient bundle settings / warehouse settingsを使用', analyzed: true },
    detectedApis: [routesUrl, gatewayUrl],
    routesUrl,
    routes,
    gatewayUrl
  };
}

async function websocketRpc(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(1000, 'done'); } catch (_) {}
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Gateway WebSocket timeout')), timeoutMs);
    socket.addEventListener('open', () => socket.send(payload));
    socket.addEventListener('message', async (event) => {
      try {
        const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data instanceof Blob ? new Uint8Array(await event.data.arrayBuffer()) : new Uint8Array(event.data);
        if (bytes[0] === 3) finish(null, bytes);
      } catch (error) { finish(error); }
    });
    socket.addEventListener('error', () => finish(new Error('Gateway WebSocket connection failed')));
    socket.addEventListener('close', (event) => { if (!settled) finish(new Error('Gateway closed before response: ' + event.code)); });
  });
}

async function websocketRpcSequence(url, payloads, timeoutMs, onResponse, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url); socket.binaryType = 'arraybuffer';
    const responses = [], expectedIds = payloads.map((payload) => payload[1] | (payload[2] << 8));
    let settled = false, next = 0;
    const finish = (error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { socket.close(1000, 'done'); } catch (_) {}
      error ? reject(error) : resolve(responses);
    };
    const timer = setTimeout(() => finish(new Error('Gateway WebSocket timeout')), timeoutMs);
    socket.addEventListener('open', () => socket.send(payloads[next]));
    socket.addEventListener('message', async (event) => {
      try {
        const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data instanceof Blob ? new Uint8Array(await event.data.arrayBuffer()) : new Uint8Array(event.data);
        if (bytes[0] !== 3 || (bytes[1] | (bytes[2] << 8)) !== expectedIds[next]) { if (options.onUnmatchedMessage) options.onUnmatchedMessage(bytes); return; }
        if (onResponse) onResponse(bytes, next);
        responses.push(bytes); next += 1;
        if (next >= payloads.length) finish();
        else {
          if (options.beforeSend) await options.beforeSend(next, { socket, responses });
          socket.send(payloads[next]);
        }
      } catch (error) { finish(error); }
    });
    socket.addEventListener('error', () => finish(new Error('Gateway WebSocket connection failed')));
    socket.addEventListener('close', (event) => { if (!settled) finish(new Error('Gateway closed before response: ' + event.code)); });
  });
}

function parseGenericRpcResponse(bytes, requestId) {
  if (bytes.length < 4 || bytes[0] !== 3 || (bytes[1] | (bytes[2] << 8)) !== requestId) throw new Error('Unexpected Liqi response');
  const wrapper = readProtobufFields(bytes.slice(3)), body = firstBytes(wrapper, 2);
  if (!body) throw new Error('Liqi response body is empty');
  const fields = readProtobufFields(body), errorBytes = firstBytes(fields, 1);
  return { method: decodeText(firstBytes(wrapper, 1)), body, fields, errorPresent: Boolean(errorBytes && errorBytes.length), error: errorBytes && errorBytes.length ? parseRpcError(errorBytes) : null };
}

function inspectWireFields(bytes) {
  const result = []; let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset); offset = tag.offset;
    const field = tag.value >>> 3, wire = tag.value & 7; let value = null;
    if (wire === 0) { const parsed = readVarint(bytes, offset); offset = parsed.offset; }
    else if (wire === 1) offset += 8;
    else if (wire === 2) { const length = readVarint(bytes, offset); offset = length.offset; value = bytes.slice(offset, offset + length.value); offset += length.value; }
    else if (wire === 5) offset += 4;
    else throw new Error('Unsupported protobuf wire type: ' + wire);
    if (!field || offset > bytes.length) throw new Error('Invalid protobuf field');
    result.push({ field, wire, value });
  }
  return result;
}

function inspectRpcFrame(bytes, requestId, expectedRpc) {
  if (bytes.length < 4 || bytes[0] !== 3 || (bytes[1] | (bytes[2] << 8)) !== requestId) throw new Error('Unexpected Liqi response');
  const wrapper = readProtobufFields(bytes.slice(3)), method = decodeText(firstBytes(wrapper, 1)) || expectedRpc, body = firstBytes(wrapper, 2) || new Uint8Array();
  const wireFields = inspectWireFields(body), errorBytes = wireFields.find((item) => item.field === 1 && item.wire === 2)?.value || null;
  const rpcError = errorBytes ? parseRpcError(errorBytes) : null;
  const errorDetected = Boolean(rpcError && (Number.isInteger(rpcError.code) || rpcError.message));
  let errorFieldNumbers = [], errorWireTypes = [], errorVarintFields = [];
  if (errorBytes) { try { const errorFields = inspectWireFields(errorBytes); errorFieldNumbers = errorFields.map((item) => item.field); errorWireTypes = errorFields.map((item) => item.wire); errorVarintFields = errorFields.filter((item) => item.wire === 0).map((item) => item.field); } catch (_) {} }
  let payload = null;
  if (!errorDetected && method === '.lq.Lobby.fetchGameRecord') {
    try { payload = parseRpcResponse(bytes, requestId).data || null; } catch (_) {}
  }
  if (!payload) {
    const candidates = wireFields.filter((item) => item.wire === 2 && !(item.field === 1 && errorDetected) && item.value && item.value.length);
    if (candidates.length) payload = candidates.reduce((largest, item) => !largest || item.value.length > largest.length ? item.value : largest, null);
  }
  let nestedPayloadDetected = false;
  if (payload && payload.length) { try { nestedPayloadDetected = readProtobufFields(payload).size > 0; } catch (_) {} }
  const compressionDetected = payload && payload.length >= 2 && payload[0] === 0x1f && payload[1] === 0x8b ? 'gzip' : null;
  const responseUnknownFields = wireFields.filter((item) => ![1, 2, 3, 4].includes(item.field));
  const meta = { rpc: method, responseReceived: true, rpcCode: Number.isInteger(rpcError && rpcError.code) ? rpcError.code : 0, responseType: errorDetected ? 'rpc-error' : body.length ? 'protobuf' : 'empty', responseBinaryState: errorDetected ? 'error-response' : body.length ? 'success-response' : 'empty-success', envelopeType: 'liqi-response', messageType: method + 'Response', envelopePresent: true, responseBodyPresent: Boolean(body.length), payloadDetected: Boolean(payload && payload.length), payloadSize: payload ? payload.length : 0, errorDetected, errorEnvelopePresent: Boolean(errorBytes), errorDetailPresent: Boolean(rpcError && rpcError.message), errorFieldNumbers, errorWireTypes, errorVarintFields, responseUnknownFieldCount: responseUnknownFields.length, responseUnknownFieldSummary: responseUnknownFields.length ? responseUnknownFields.map((item) => `field ${item.field}/wire ${item.wire}`).join(', ') : 'none', emptyErrorResponse: Boolean(errorDetected && !rpcError.message && !payload), emptySuccessResponse: Boolean(!errorDetected && !body.length), errorCode: Number.isInteger(rpcError && rpcError.code) ? rpcError.code : null, errorMessage: rpcError && rpcError.message || null, protobufDetected: Boolean(body.length), protobufEnvelopeParsed: true, fieldNumbers: wireFields.map((item) => item.field), wireTypes: wireFields.map((item) => item.wire), nestedPayloadDetected, compressionDetected, payloadEncoding: payload && payload.length ? 'base64' : null };
  return { meta, payload };
}

function classifyRpcFailure(rpc, rpcCode) {
  const safeCode = Number.isInteger(rpcCode) ? 'MAJSOUL_' + rpcCode : 'UNKNOWN_RPC_ERROR';
  if (rpc === '.lq.Route.requestConnection' || rpc === '.lq.Lobby.prepareLogin') return { state: AUTH_STATES.AUTH_FAILED, stage: rpc === '.lq.Route.requestConnection' ? 'REQUEST_CONNECTION' : 'PREPARE_LOGIN', code: safeCode, reason: '認証またはセッション確立RPCがエラーを返しました', previous: 'OAUTH_REJECTED' };
  if (rpc === '.lq.Lobby.fetchGameRecord') return { state: AUTH_STATES.FETCH_GAME_RECORD_FAILED, stage: 'FETCH_GAME_RECORD', code: safeCode, reason: 'fetchGameRecordがRPCエラーを返しました', previous: 'OAUTH_REJECTED' };
  if (rpc === '.lq.Lobby.readGameRecord') return { state: AUTH_STATES.READ_GAME_RECORD_FAILED, stage: 'READ_GAME_RECORD', code: safeCode, reason: 'readGameRecordがRPCエラーを返しました', previous: 'OAUTH_REJECTED' };
  if (rpc === '.lq.Lobby.fetchGameRecordsDetailV2') return { state: AUTH_STATES.GAME_RECORD_DETAIL_FAILED, stage: 'GAME_RECORD_DETAIL', code: safeCode, reason: 'fetchGameRecordsDetailV2がRPCエラーを返しました', previous: 'OAUTH_REJECTED' };
  return { state: AUTH_STATES.UNKNOWN_RPC_ERROR, stage: 'UNKNOWN_RPC', code: safeCode, reason: '不明なRPCがエラーを返しました', previous: 'OAUTH_REJECTED' };
}

async function authenticatedFetchRecord(gatewayUrl, auth, paipuId) {
  // v5.3.4: 各RPC応答を個別解析し、セッション確立後の失敗をOAuth拒否へ誤分類しない。
  let diagnostic = safeAuthDiagnostic({ authStage: 'OAUTH_REQUEST_BUILD', authState: AUTH_STATES.OAUTH_REQUEST_BUILD_FAILED, nextAction: 'Workerを再デプロイしてください' });
  let payloads;
  try { payloads = [buildRequestConnectionRequest(auth, 1), buildPrepareLoginRequest(auth, 2), buildRpcRequest(paipuId, auth.fetchClientContext, 3, auth.fetchGameRecordProfile), buildReadGameRecordRequest(auth.fetchClientContext, 4), buildGameRecordsDetailRequest(paipuId, 5)]; }
  catch (_) { throw safeAuthError(AUTH_STATES.OAUTH_REQUEST_BUILD_FAILED, diagnostic, 500); }
  const sequence = ['.lq.Route.requestConnection', '.lq.Lobby.prepareLogin', '.lq.Lobby.fetchGameRecord', '.lq.Lobby.readGameRecord', '.lq.Lobby.fetchGameRecordsDetailV2'];
  const timeline = sequence.map((rpc, index) => ({ order: index + 1, rpc, status: 'pending', requestSent: false, responseReceived: false, rpcCode: null, responseType: null, envelopePresent: false, payloadDetected: false, payloadSize: 0 }));
  const inspections = []; let firstFailure = null;
  const requestMatch = compareFetchRequestToProfile(payloads[2], auth.fetchGameRecordProfile);
  const binaryMatch = compareFetchRequestBinary(payloads[2], auth.fetchGameRecordProfile, paipuId, auth.fetchClientContext, 3);
  // v5.3.6: 生バイト列を出力せず、生成requestの動的field位置とfield 2値がHAR由来Secretに一致するかだけを内部比較する。
  const generatedEnvelope = inspectWireFields(payloads[2].slice(3));
  const generatedBody = inspectWireFields(generatedEnvelope.find((item) => item.field === 2 && item.wire === 2)?.value || new Uint8Array());
  const generatedField1 = generatedBody.find((item) => item.field === 1 && item.wire === 2);
  const generatedField2 = generatedBody.find((item) => item.field === 2 && item.wire === 2);
  const generatedField2Text = decodeText(generatedField2?.value || new Uint8Array());
  const profileValidation = auth.fetchProfileValidation || validateFetchProfile(auth.fetchGameRecordProfile);
  // v5.4.0: requestを推測変更せず、HAR→Profile変換で証明できなくなった情報を独立監査する。
  const profileAudit = auditFetchProfile(auth.fetchGameRecordProfile);
  const requestIdSequenceMatched = payloads.every((payload, index) => (payload[1] | (payload[2] << 8)) === index + 1);
  const runtimeFieldsValid = Boolean(generatedField1) && generatedField2Text === auth.fetchClientContext;
  const sessionValidation = auth.sessionTimelineValidation || validateSessionTimeline(auth.fetchGameRecordProfile.sessionTimeline);
  const sessionPlan = buildSessionRuntimePlan(sessionValidation), sessionProfile = sessionPlan.profile;
  const sessionDelayMs = sessionPlan.delayMs, sessionTimingStrategy = sessionPlan.strategy;
  const unsupportedIntermediate = Boolean(sessionPlan.blockedCode);
  // v5.3.7: 総合判定を自分自身へ依存させず、共通Schemaと生成requestの個別条件だけから算出する。
  const semanticReady = profileValidation.requestSemanticMatched && requestMatch.fetchGameRecordRequestValidated && requestIdSequenceMatched && runtimeFieldsValid && !unsupportedIntermediate;
  let mismatch = profileValidation.remainingMismatchCategory;
  if (!requestMatch.fetchGameRecordRequestValidated) mismatch = requestMatch.messageMatchScore !== 100 ? 'MESSAGE_TYPE_MISMATCH' : requestMatch.envelopeMatchScore !== 100 ? 'ENVELOPE_STRUCTURE_MISMATCH' : 'FIELD_STRUCTURE_MISMATCH';
  else if (!requestIdSequenceMatched) mismatch = 'REQUEST_ID_POLICY_MISMATCH';
  else if (!runtimeFieldsValid) mismatch = !generatedField1 ? 'FIELD1_SOURCE_MISMATCH' : 'FIELD2_SOURCE_MISMATCH';
  else if (unsupportedIntermediate) mismatch = sessionPlan.blockedCode;
  else if (!semanticReady && !mismatch) mismatch = 'RUNTIME_VALIDATION_BUG';
  diagnostic = safeAuthDiagnostic({ ...requestMatch, ...profileValidation, requestSemanticMatched: profileValidation.requestSemanticMatched && requestMatch.fetchGameRecordRequestValidated && requestIdSequenceMatched && runtimeFieldsValid, requestIdSequenceMatched, clientVersionSourceRole: auth.fetchGameRecordProfile.clientVersionSourceRole || null, clientVersionSourceRpc: auth.fetchGameRecordProfile.clientVersionSourceRpc || null, fetchGameRecordRuntimeReady: semanticReady, connectionContextStatus: CONNECTION_CONTEXT_PENDING, connectionContextMatched: null, validationStage: 'static-profile-validation', rpcExecutionStarted: semanticReady, sessionTimelineProfileValid: sessionValidation.sessionTimelineProfileValid, prepareLoginToFetchHarDelayMs: sessionProfile.prepareLoginToFetchDelayMs || 0, sessionTimingStrategy, sessionTimingAttemptCount: 1, intermediateEventCount: sessionProfile.events?.slice(1, -1).length || 0, heartbeatObservedInHar: Boolean(sessionProfile.heartbeatRequired), heartbeatSentAtRuntime: false, requiredIntermediateRpc: sessionProfile.requiredIntermediateRpc || null, requiredServerEvent: sessionProfile.requiredServerEvent || null, requestIdBeforeFetch: 2, requestIdAtFetch: 3, requestIdDeltaMatched: sessionProfile.requestIdDeltaBeforeFetch === 1, authStage: 'FETCH_GAME_RECORD_REQUEST_VALIDATION', authState: semanticReady ? AUTH_STATES.OAUTH_RPC_SENT : AUTH_STATES.FETCH_GAME_RECORD_FAILED, oauthRpcName: '.lq.Route.requestConnection', oauthRequestBuilt: true, rpcTimeline: timeline, rpcSequence: sequence, nextRpc: semanticReady ? sequence[0] : null, confirmedRpcCount: sequence.length, remainingMismatchCategory: semanticReady ? null : (mismatch || 'UNKNOWN_VALIDATION_MISMATCH'), safeErrorCode: semanticReady ? null : unsupportedIntermediate ? mismatch : 'FETCH_GAME_RECORD_REQUEST_UNVALIDATED', safeErrorMessage: semanticReady ? null : unsupportedIntermediate ? 'HARで確認された中間RPCは安全な送信値を復元できないため停止しました' : 'fetchGameRecordリクエストの構造または意味を確認できません', nextRpcBlocked: Boolean(unsupportedIntermediate), nextRpcBlockedReason: unsupportedIntermediate ? 'HAR_INPUT_TEMPLATE_UNAVAILABLE' : null, missingInputRole: unsupportedIntermediate ? (sessionProfile.heartbeatRequired ? 'heartbeatRequest' : 'intermediateRpcRequest') : null, missingInputSource: unsupportedIntermediate ? 'currentSanitizedHar' : null, nextAction: semanticReady ? '現行セッション条件でRPCを実行します' : mismatch === 'PROFILE_SCHEMA_MISMATCH' || mismatch === 'PROFILE_VERSION_MISMATCH' ? '現行Profileを登録してください' : '診断の残差分類を確認してください' });
  // v5.3.9: 既存の構造スコアを維持し、byte比較とSession情報を別軸で集約する。
  diagnostic = safeAuthDiagnostic({ ...diagnostic, ...binaryMatch, ...profileAudit, sessionTimelineSource: sessionPlan.source, sessionTimelineLegacyReason: sessionPlan.legacyReason, sessionTimingMatched: null });
  if (!semanticReady) throw safeAuthError(AUTH_STATES.FETCH_GAME_RECORD_FAILED, diagnostic, 503);
  let prepareResponseAt = 0, fetchSentAt = 0;
  const observedServerEvents = new Set();
  const frames = await websocketRpcSequence(gatewayUrl, payloads, 25000, (bytes, index) => {
    const inspected = inspectRpcFrame(bytes, index + 1, sequence[index]); inspections[index] = inspected;
    timeline[index] = { ...timeline[index], status: inspected.meta.errorDetected ? 'failed' : 'succeeded', requestSent: true, responseReceived: true, rpcCode: inspected.meta.rpcCode, responseType: inspected.meta.responseType, envelopePresent: inspected.meta.envelopePresent, payloadDetected: inspected.meta.payloadDetected, payloadSize: inspected.meta.payloadSize };
    const failure = inspected.meta.errorDetected ? classifyRpcFailure(sequence[index], inspected.meta.rpcCode) : null;
    if (failure && !firstFailure) firstFailure = { ...failure, rpc: sequence[index], rpcCode: inspected.meta.rpcCode };
    const stage = index === 0 ? 'REQUEST_CONNECTION_RESPONSE' : index === 1 ? 'PREPARE_LOGIN_RESPONSE' : index === 2 ? 'FETCH_GAME_RECORD_RESPONSE' : index === 3 ? 'READ_GAME_RECORD_RESPONSE' : 'GAME_RECORD_DETAIL_RESPONSE';
    const connectionContextMatched = index >= 1 && !inspections[0]?.meta.errorDetected && !inspections[1]?.meta.errorDetected;
    // v5.3.7: HARの過去connection indexではなく、現在の同一WebSocket上で応答した関係を実行時に確定する。
    diagnostic.connectionContextStatus = index < 1 ? CONNECTION_CONTEXT_PENDING : connectionContextMatched ? 'matched' : 'mismatched';
    diagnostic.validationStage = 'runtime-connection-validation';
    const remainingMismatchCategory = failure ? index === 2 ? diagnostic.sessionTimingMatched === true ? 'FETCH_GAME_RECORD_SESSION_REJECTED' : diagnostic.sessionTimingMatched === false ? diagnostic.requestIdDeltaMatched ? 'SESSION_READY_TIMEOUT' : 'REQUEST_ID_TIMING_MISMATCH' : 'FETCH_GAME_RECORD_FAILED' : 'UPSTREAM_RPC_RESPONSE' : diagnostic.remainingMismatchCategory;
    const timingAttempts = index === 2 && diagnostic.sessionTimingAttempts?.length ? diagnostic.sessionTimingAttempts.map((item) => ({ ...item, rpcCode: inspected.meta.rpcCode, result: failure ? 'rpc-error' : 'succeeded', durationMs: Math.max(item.durationMs || 0, Date.now() - fetchSentAt) })) : diagnostic.sessionTimingAttempts;
    diagnostic = safeAuthDiagnostic({ ...diagnostic, sessionTimingAttempts: timingAttempts, responseBodyPresent: inspected.meta.responseBodyPresent, errorEnvelopePresent: inspected.meta.errorEnvelopePresent, errorDetailPresent: inspected.meta.errorDetailPresent, errorFieldNumbers: inspected.meta.errorFieldNumbers, errorWireTypes: inspected.meta.errorWireTypes, emptyErrorResponse: inspected.meta.emptyErrorResponse, emptySuccessResponse: inspected.meta.emptySuccessResponse, authStage: stage, authState: failure ? failure.state : index < 2 ? AUTH_STATES.OAUTH_RESPONSE_RECEIVED : AUTH_STATES.FETCH_GAME_RECORD_REACHED, currentRpc: sequence[index], oauthRpcName: sequence[index], oauthRequestBuilt: true, oauthResponseReceived: true, sessionEstablished: index >= 1 && !inspections[1]?.meta.errorDetected, fetchGameRecordReached: index >= 2, connectionContextMatched, responseFullyMatched: index >= 2 ? !failure && inspected.meta.protobufEnvelopeParsed : diagnostic.responseFullyMatched, rpcTimeline: timeline, rpcSequence: sequence, nextRpc: sequence[index + 1] || null, confirmedRpcCount: sequence.length, protobufDetected: inspected.meta.protobufDetected, protobufEnvelopeParsed: inspected.meta.protobufEnvelopeParsed, envelopeType: inspected.meta.envelopeType, messageType: inspected.meta.messageType, payloadLength: inspected.meta.payloadSize, fieldNumbers: inspected.meta.fieldNumbers, wireTypes: inspected.meta.wireTypes, nestedPayloadDetected: inspected.meta.nestedPayloadDetected, compressionDetected: inspected.meta.compressionDetected, payloadEncoding: inspected.meta.payloadEncoding, actualFailureStage: failure ? failure.stage : diagnostic.actualFailureStage, actualFailureRpc: failure ? sequence[index] : diagnostic.actualFailureRpc, actualFailureCode: failure ? failure.code : diagnostic.actualFailureCode, actualFailureReason: failure ? failure.reason : diagnostic.actualFailureReason, classificationCorrected: Boolean(failure), previousClassification: failure ? failure.previous : diagnostic.previousClassification, currentClassification: failure ? failure.state : diagnostic.currentClassification, remainingMismatchCategory, safeErrorCode: failure ? failure.code : diagnostic.safeErrorCode, safeErrorMessage: failure ? failure.reason : diagnostic.safeErrorMessage, nextAction: failure ? '実行したSession Strategyと上流RPC応答を確認してください' : index < 4 ? '次の現行RPCを実行します' : '牌譜本体を検証します' });
    if (index === 3) diagnostic = safeAuthDiagnostic({ ...diagnostic, readGameRecordReached: true, readGameRecordRequestSent: true, readGameRecordResponseReceived: true, readGameRecordSucceeded: !inspected.meta.errorDetected, readGameRecordRpcCode: inspected.meta.rpcCode, readGameRecordResponseType: inspected.meta.responseType, readGameRecordEnvelopeType: inspected.meta.envelopeType, readGameRecordMessageType: inspected.meta.messageType, readGameRecordPayloadDetected: inspected.meta.payloadDetected, readGameRecordPayloadSize: inspected.meta.payloadSize, readGameRecordErrorDetected: inspected.meta.errorDetected, readGameRecordErrorCode: inspected.meta.errorCode, readGameRecordErrorMessage: inspected.meta.errorDetected ? 'readGameRecordが安全なRPCエラーを返しました' : null });
    if (index === 4) diagnostic = safeAuthDiagnostic({ ...diagnostic, fetchGameRecordsDetailReached: true, fetchGameRecordsDetailRequestSent: true, fetchGameRecordsDetailResponseReceived: true, fetchGameRecordsDetailSucceeded: !inspected.meta.errorDetected, fetchGameRecordsDetailRpcCode: inspected.meta.rpcCode, fetchGameRecordsDetailResponseType: inspected.meta.responseType, fetchGameRecordsDetailEnvelopeType: inspected.meta.envelopeType, fetchGameRecordsDetailMessageType: inspected.meta.messageType, fetchGameRecordsDetailPayloadDetected: inspected.meta.payloadDetected, fetchGameRecordsDetailPayloadSize: inspected.meta.payloadSize, fetchGameRecordsDetailErrorDetected: inspected.meta.errorDetected, fetchGameRecordsDetailErrorCode: inspected.meta.errorCode, fetchGameRecordsDetailErrorMessage: inspected.meta.errorDetected ? 'fetchGameRecordsDetailV2が安全なRPCエラーを返しました' : null });
    // v5.3.9: 応答byteそのものを返さず、error/nested/unknown fieldの安全な解析結果だけを保持する。
    const fetchRejectionCategory = failure && index === 2 ? classifyFetchRejection({ audit: profileAudit, actualFailureCode: failure.code, requestSemanticMatched: diagnostic.requestSemanticMatched, sessionTimelineProfileValid: diagnostic.sessionTimelineProfileValid }) : diagnostic.fetchRejectionCategory;
    diagnostic = safeAuthDiagnostic({ ...diagnostic, fetchRejectionCategory, responseBinaryState: inspected.meta.responseBinaryState, responseUnknownFieldCount: inspected.meta.responseUnknownFieldCount, responseUnknownFieldSummary: inspected.meta.responseUnknownFieldSummary, errorVarintFields: inspected.meta.errorVarintFields, responseMetadata: { envelopePresent: inspected.meta.envelopePresent, responseBodyPresent: inspected.meta.responseBodyPresent, errorEnvelopePresent: inspected.meta.errorEnvelopePresent, errorDetailPresent: inspected.meta.errorDetailPresent, emptyErrorResponse: inspected.meta.emptyErrorResponse, emptySuccessResponse: inspected.meta.emptySuccessResponse, fieldCount: inspected.meta.fieldNumbers.length, unknownFieldCount: inspected.meta.responseUnknownFieldCount } });
    // 認証段階の失敗だけは後続RPCを実行できないため中断する。
    // v5.3.5: fetchGameRecordが失敗した時点で停止し、read/detailを送信しない。
    if (failure && index <= 2) { const error = safeAuthError(failure.state, diagnostic, index === 2 ? 502 : 401); error.rpcCode = inspected.meta.rpcCode; throw error; }
    if (index === 1) { prepareResponseAt = Date.now(); diagnostic = safeAuthDiagnostic({ ...diagnostic, authStage: 'SESSION_ESTABLISHED', authState: AUTH_STATES.AUTHENTICATED, sessionEstablished: true, sessionReadyReason: 'prepareLogin-response-received', nextRpc: '.lq.Lobby.fetchGameRecord', nextAction: 'fetchGameRecordを実行します' }); }
  }, {
    beforeSend: async (nextIndex) => {
      if (nextIndex !== 2) return;
      if (sessionDelayMs) await new Promise((resolve) => setTimeout(resolve, sessionDelayMs));
      if (sessionProfile.requiredServerEvent && !observedServerEvents.has(sessionProfile.requiredServerEvent)) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(250, Math.min(3000, sessionDelayMs + 250))));
      }
      fetchSentAt = Date.now();
      const requiredObserved = !sessionProfile.requiredServerEvent || observedServerEvents.has(sessionProfile.requiredServerEvent);
      diagnostic = safeAuthDiagnostic({ ...diagnostic, prepareLoginToFetchActualDelayMs: prepareResponseAt ? fetchSentAt - prepareResponseAt : 0, requiredServerEventObserved: requiredObserved, fetchGameRecordAttemptedAfterSessionReady: Boolean(prepareResponseAt), sessionTimingMatched: sessionPlan.valid ? Boolean(prepareResponseAt && requiredObserved) : null, sessionTimingAttempts: [{ strategy: sessionTimingStrategy, delayMs: prepareResponseAt ? fetchSentAt - prepareResponseAt : 0, heartbeatSent: false, intermediateRpcSent: false, serverEventWaited: Boolean(sessionProfile.requiredServerEvent), serverEventObserved: requiredObserved, requestId: 3, rpcCode: null, durationMs: prepareResponseAt ? fetchSentAt - prepareResponseAt : 0, result: 'request-sent' }] });
      if (!requiredObserved) throw safeAuthError('REQUIRED_SERVER_EVENT_NOT_RECEIVED', safeAuthDiagnostic({ ...diagnostic, authStage: 'SESSION_READY_WAIT', authState: 'SESSION_READY_TIMEOUT', safeErrorCode: 'REQUIRED_SERVER_EVENT_NOT_RECEIVED', safeErrorMessage: 'HARで必須のServer Eventを待機しましたが受信できませんでした', remainingMismatchCategory: 'REQUIRED_SERVER_EVENT_NOT_RECEIVED', nextAction: '同じ共有URLで再試行してください' }), 504);
    },
    onUnmatchedMessage: (bytes) => {
      try { const offset = bytes[0] === 1 ? 1 : 0, eventFields = readProtobufFields(bytes.slice(offset)), name = decodeText(firstBytes(eventFields, 1)); if (name) observedServerEvents.add(name); } catch (_) {}
    }
  });
  if (!diagnostic.sessionEstablished) throw safeAuthError(AUTH_STATES.SESSION_NOT_ESTABLISHED, { ...diagnostic, authStage: 'SESSION_ESTABLISHMENT', authState: AUTH_STATES.SESSION_NOT_ESTABLISHED, safeErrorCode: 'SESSION_NOT_ESTABLISHED', safeErrorMessage: 'OAuth応答後にセッションを確立できませんでした', nextAction: '認証Secretを再取得して登録し直してください' });
  let parsed; try { parsed = parseRpcResponse(frames[2], 3); } catch (_) { parsed = { method: sequence[2], data: null, dataUrl: '', error: null }; }
  const payloadCandidates = [2, 3, 4].map((index) => inspections[index] && inspections[index].payload && inspections[index].payload.length ? { rpc: sequence[index], payload: inspections[index].payload, meta: inspections[index].meta } : null).filter(Boolean);
  const selected = payloadCandidates[0] || null;
  if (selected) return { parsed, recordBytes: selected.payload, payloadSourceRpc: selected.rpc, payloadMeta: selected.meta, rpcCode: selected.meta.rpcCode, authDiagnostic: safeAuthDiagnostic({ ...diagnostic, authStage: 'PAIPU_PAYLOAD_DETECTED', authState: AUTH_STATES.PAIPU_FETCH_SUCCEEDED, currentRpc: selected.rpc, messageType: selected.meta.messageType, payloadLength: selected.payload.length, safeErrorCode: null, safeErrorMessage: null, currentClassification: AUTH_STATES.PAIPU_FETCH_SUCCEEDED, nextRpc: null, nextAction: '取得したProtobufを内部処理へ渡します' }) };
  if (firstFailure) { const failedDiagnostic = safeAuthDiagnostic({ ...diagnostic, authStage: firstFailure.stage, authState: firstFailure.state, actualFailureStage: firstFailure.stage, actualFailureRpc: firstFailure.rpc, actualFailureCode: firstFailure.code, actualFailureReason: firstFailure.reason, classificationCorrected: true, previousClassification: firstFailure.previous, currentClassification: firstFailure.state, safeErrorCode: firstFailure.code, safeErrorMessage: firstFailure.reason, nextRpc: null, nextAction: '同じ共有URLで再試行し、実際に失敗したRPCを確認してください' }); const error = safeAuthError(firstFailure.state, failedDiagnostic, 502); error.rpcCode = firstFailure.rpcCode; throw error; }
  throw safeAuthError(AUTH_STATES.PAYLOAD_EMPTY, safeAuthDiagnostic({ ...diagnostic, authStage: 'PAYLOAD_INSPECTION', authState: AUTH_STATES.PAYLOAD_EMPTY, safeErrorCode: 'PAYLOAD_EMPTY', safeErrorMessage: '全RPC応答を受信しましたが牌譜Payloadを検出できませんでした', currentClassification: AUTH_STATES.PAYLOAD_EMPTY, nextRpc: null, nextAction: '共有URLがブラウザで表示できることを確認して再試行してください' }), 502);
}

async function fetchRecordPayload(paipuId, analysis, signal, auth) {
  // v5.3.4: 認証フローでは現行実通信と同じ完全IDだけを送り、UUID推測を行わない。
  const candidates = auth ? [paipuId] : [paipuId, paipuId.split('_')[0]].filter((value, index, values) => values.indexOf(value) === index);
  // v5.3.6: 認証時はroute ID候補を廃止し、実fetch field 2由来のcontextだけを使う。
  const versionCandidates = auth ? [null] : [CURRENT_LIQI_CLIENT_VERSION, '0.16.206.w', 'v0.16.206.W.' + analysis.buildVersion, analysis.buildVersion];
  const attempts = []; let lastAuthDiagnostic = null;
  let requestId = 0;
  for (const id of candidates) for (const clientVersion of versionCandidates) {
    const started = Date.now();
    try {
      requestId += 1;
      let parsed, rpcCode = null, authenticated = null;
      if (auth) { authenticated = await authenticatedFetchRecord(analysis.gatewayUrl, auth, id); parsed = authenticated.parsed; rpcCode = authenticated.rpcCode; lastAuthDiagnostic = authenticated.authDiagnostic; }
      else { const raw = await websocketRpc(analysis.gatewayUrl, buildRpcRequest(id, clientVersion, requestId), 15000); parsed = parseRpcResponse(raw, requestId); }
      if (authenticated && authenticated.recordBytes && authenticated.recordBytes.length) return { bytes: authenticated.recordBytes, sourceUrl: analysis.gatewayUrl, finalUrl: analysis.gatewayUrl, httpStatus: 101, contentType: 'application/x-protobuf', redirect: false, durationMs: Date.now() - started, accessedApi: authenticated.payloadSourceRpc, payloadSourceRpc: authenticated.payloadSourceRpc, payloadMeta: authenticated.payloadMeta, clientVersion, attempts, authDiagnostic: lastAuthDiagnostic, authState: AUTH_STATES.PAIPU_FETCH_SUCCEEDED, rpcCode };
      if (parsed.data && parsed.data.length) return { bytes: parsed.data, sourceUrl: analysis.gatewayUrl, finalUrl: analysis.gatewayUrl, httpStatus: 101, contentType: 'application/x-protobuf', redirect: false, durationMs: Date.now() - started, accessedApi: '.lq.Lobby.fetchGameRecord', clientVersion, attempts, authDiagnostic: lastAuthDiagnostic, authState: auth ? AUTH_STATES.PAIPU_FETCH_SUCCEEDED : AUTH_STATES.AUTHENTICATED, rpcCode };
      if (parsed.dataUrl && /^https:\/\//i.test(parsed.dataUrl)) {
        const response = await fetch(parsed.dataUrl, { signal, redirect: 'follow', headers: { Accept: 'application/octet-stream,application/x-protobuf,*/*;q=0.5' } });
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!response.ok || !bytes.length) throw new Error('record data URL HTTP ' + response.status);
        return { bytes, sourceUrl: parsed.dataUrl, finalUrl: response.url, httpStatus: response.status, contentType: response.headers.get('content-type') || 'application/octet-stream', redirect: response.redirected, durationMs: Date.now() - started, accessedApi: '.lq.Lobby.fetchGameRecord → data_url', clientVersion, attempts, authDiagnostic: lastAuthDiagnostic, authState: auth ? AUTH_STATES.PAIPU_FETCH_SUCCEEDED : AUTH_STATES.AUTHENTICATED, rpcCode };
      }
      attempts.push({ inputType: 'completePaipuId', clientContextRole: auth ? 'fetchGameRecordField2' : 'legacyClientVersionCandidate', gatewayConnected: true, method: parsed.method, durationMs: Date.now() - started, reason: parsed.error ? 'RPC_ERROR' : 'EMPTY_RECORD', rpcError: parseRpcError(parsed.error) });
    } catch (error) {
      if (error.authDiagnostic) lastAuthDiagnostic = error.authDiagnostic;
      attempts.push({ inputType: 'completePaipuId', clientContextRole: auth ? 'fetchGameRecordField2' : 'legacyClientVersionCandidate', gatewayConnected: true, durationMs: Date.now() - started, reason: error.code || 'RPC_FAILED', safeErrorCode: error.authDiagnostic && error.authDiagnostic.safeErrorCode || null });
      if (auth && error.authDiagnostic) { error.attempts = attempts; throw error; }
    }
  }
  const error = new Error('現行ゲートウェイは応答しましたが、牌譜本体を取得できませんでした');
  error.code = AUTH_STATES.PAYLOAD_EMPTY; error.status = 502; error.attempts = attempts; error.authDiagnostic = lastAuthDiagnostic ? { ...lastAuthDiagnostic, authStage: 'PAYLOAD_INSPECTION', authState: AUTH_STATES.PAYLOAD_EMPTY, safeErrorCode: 'PAYLOAD_EMPTY', safeErrorMessage: '牌譜RPCは応答しましたがPayloadが空です', nextAction: '共有URLがブラウザで表示できることを確認してください' } : safeAuthDiagnostic({ authStage: 'PAYLOAD_INSPECTION', authState: AUTH_STATES.PAYLOAD_EMPTY, safeErrorCode: 'PAYLOAD_EMPTY', safeErrorMessage: '牌譜RPCは応答しましたがPayloadが空です', nextAction: '共有URLがブラウザで表示できることを確認してください' }); throw error;
}

async function fetchMajsoulPaipu(paipuId, env, signal) {
  const auth = parseAuthSecret(env);
  if (!env || !env[AUTH_SECRET_NAME]) throw safeAuthError(AUTH_STATES.SECRET_NOT_CONFIGURED, safeAuthDiagnostic(), 503);
  if (!auth) throw safeAuthError(AUTH_STATES.SECRET_FORMAT_INVALID, safeAuthDiagnostic({ authStage: 'SECRET_VALIDATION', authState: AUTH_STATES.SECRET_FORMAT_INVALID, safeErrorCode: 'SECRET_FORMAT_INVALID', safeErrorMessage: 'Worker SecretのJSON形式または必須フィールドが正しくありません', nextAction: '認証Secretを再取得して登録し直してください' }), 503);
  const analysis = await analyzeCurrentClient(paipuId, signal);
  try {
    const record = await fetchRecordPayload(paipuId, analysis, signal, auth);
    if (record.bytes.length > MAX_PAYLOAD_BYTES) { const error = new Error('牌譜データが上限を超えました'); error.code = 'PAYLOAD_TOO_LARGE'; error.status = 413; throw error; }
    return { ...record, analysis, authDiagnostic: { ...(record.authDiagnostic || safeAuthDiagnostic()), authStage: 'PAIPU_FETCH', authState: AUTH_STATES.PAIPU_FETCH_SUCCEEDED, oauthResponseReceived: true, sessionEstablished: true, fetchGameRecordReached: true, safeErrorCode: null, safeErrorMessage: null, nextAction: '牌譜デコードは次バージョンで実行します' }, secretConfigured: true, gatewayConnected: true, rpc: record.payloadSourceRpc || '.lq.Lobby.fetchGameRecord', payloadType: 'protobuf', payloadEncoding: 'base64', size: record.bytes.length, payload: bytesToBase64(record.bytes) };
  } catch (error) { error.analysis = analysis; throw error; }
}

async function withTimeout(operation, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([operation(controller.signal), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); const error = new Error('牌譜取得がタイムアウトしました'); error.code = 'UPSTREAM_TIMEOUT'; error.status = 504; reject(error); }, timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

async function handlePaipu(request, env, url) {
  const input = url.searchParams.get('id');
  if (!input) return errorResponse(request, env, 400, 'MISSING_PAIPU_ID', 'idを指定してください');
  const paipuId = extractPaipuId(input);
  if (!paipuId) return errorResponse(request, env, 400, 'INVALID_PAIPU_ID', '雀魂共有URLまたは牌譜IDの形式が正しくありません');
  try {
    const result = await withTimeout((signal) => fetchMajsoulPaipu(paipuId, env, signal), REQUEST_TIMEOUT_MS);
    return jsonResponse(request, env, { ok: true, version: 1, source: 'majsoul', ...result.authDiagnostic, secretConfigured: true, gatewayConnected: true, rpc: result.rpc, rpcCode: result.rpcCode, paipuFetchSucceeded: true, sourceType: 'current_gateway_rpc', gateway: new URL(result.sourceUrl).host, sourceUrl: result.sourceUrl, finalUrl: result.finalUrl, accessedApi: result.accessedApi, payloadSourceRpc: result.payloadSourceRpc || result.rpc, responseMessageType: result.payloadMeta && result.payloadMeta.messageType || result.messageType, httpStatus: result.httpStatus, contentType: result.contentType, payloadType: result.payloadType, size: result.size, durationMs: result.durationMs, redirect: result.redirect, payloadEncoding: result.payloadEncoding, attempts: result.attempts, analysis: safeAnalysisForClient(result.analysis), payload: result.payload });
  } catch (error) {
    const secretConfigured = Boolean(env && env[AUTH_SECRET_NAME]);
    const authDiagnostic = error.authDiagnostic || safeAuthDiagnostic({ authStage: 'FETCH_GAME_RECORD', authState: error.code || AUTH_STATES.FETCH_GAME_RECORD_FAILED, safeErrorCode: error.code || 'UNKNOWN_ERROR', safeErrorMessage: '安全な詳細を取得できませんでした', nextAction: '同じ操作を再試行してください' });
    const diagnostics = { ...authDiagnostic, secretConfigured, gatewayConnected: Boolean(error.analysis && error.analysis.gatewayUrl), rpc: '.lq.Lobby.fetchGameRecord', rpcCode: Number.isInteger(error.rpcCode) ? error.rpcCode : null, paipuFetchSucceeded: false, payloadType: null, payloadSize: 0, analysis: safeAnalysisForClient(error.analysis), attempts: error.attempts || [] };
    if (error && (error.name === 'AbortError' || error.code === 'UPSTREAM_TIMEOUT')) return errorResponse(request, env, 504, 'UPSTREAM_TIMEOUT', '牌譜取得がタイムアウトしました', diagnostics);
    return errorResponse(request, env, error.status || 502, error.code || AUTH_STATES.FETCH_GAME_RECORD_FAILED, error.message || '牌譜取得に失敗しました', diagnostics);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), allowedOrigin = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN, origin = request.headers.get('Origin');
    try {
      if (request.method === 'OPTIONS') { if (origin && origin !== allowedOrigin) return errorResponse(request, env, 403, 'ORIGIN_NOT_ALLOWED', '許可されていないOriginです'); return new Response(null, { status: 204, headers: corsHeaders(request, env) }); }
      if (request.method !== 'GET') return errorResponse(request, env, 405, 'METHOD_NOT_ALLOWED', 'GETのみ利用できます');
      if (url.pathname === '/health') {
        const secretConfigured = Boolean(env && env[AUTH_SECRET_NAME]);
        const secretSchemaValid = secretConfigured && Boolean(parseAuthSecret(env));
        // v5.3.2: Secretの中身を返さず、現行prepareLoginスキーマへ更新済みかだけを確認できるようにする。
        return jsonResponse(request, env, { ok: true, service: SERVICE_NAME, version: SERVICE_VERSION, authStage: secretConfigured ? 'SECRET_VALIDATION' : 'SECRET_LOADING', authState: !secretConfigured ? AUTH_STATES.SECRET_NOT_CONFIGURED : secretSchemaValid ? 'SECRET_FORMAT_VALID' : AUTH_STATES.SECRET_FORMAT_INVALID, secretConfigured, secretSchemaValid, safeErrorCode: secretConfigured && !secretSchemaValid ? AUTH_STATES.SECRET_FORMAT_INVALID : null, nextAction: !secretConfigured || !secretSchemaValid ? '現行HARから認証Secretを登録してください' : '共有URLで現行認証フローを検証してください' });
      }
      if (url.pathname === '/api/paipu') return handlePaipu(request, env, url);
      return errorResponse(request, env, 404, 'NOT_FOUND', 'エンドポイントが見つかりません');
    } catch (_) { return errorResponse(request, env, 500, 'INTERNAL_ERROR', 'Worker内部でエラーが発生しました'); }
  }
};

export { AUTH_STATES, analyzeCurrentClient, authenticatedFetchRecord, buildGameRecordsDetailRequest, buildPrepareLoginRequest, buildReadGameRecordRequest, buildRequestConnectionRequest, buildRpcRequest, classifyRpcFailure, compareFetchRequestBinary, compareFetchRequestToProfile, extractPaipuId, extractUnityConfig, fetchMajsoulPaipu, inspectRpcFrame, parseAuthSecret, parseRpcResponse, validatePaipuId, websocketRpcSequence };
