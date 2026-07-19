const SERVICE_NAME = 'mahjong-paipu-proxy';
const SERVICE_VERSION = '5.3.3';
const DEFAULT_ALLOWED_ORIGIN = 'https://8h4f6g6dgf-hub.github.io';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_PAYLOAD_BYTES = 6 * 1024 * 1024;
const MAJSOUL_PAGE_URL = 'https://game.mahjongsoul.com/';
// v5.3.0: 2026-07-19の現行公式Web画面に表示された v0.16.206.W.4.0.11 を根拠にする。
const CURRENT_LIQI_CLIENT_VERSION = 'web-0.16.206';
const AUTH_SECRET_NAME = 'MAJSOUL_OAUTH2_CREDENTIALS';
const AUTH_STATES = Object.freeze({
  SECRET_NOT_CONFIGURED: 'SECRET_NOT_CONFIGURED', SECRET_FORMAT_INVALID: 'SECRET_FORMAT_INVALID',
  OAUTH_PREFLIGHT_FAILED: 'OAUTH_PREFLIGHT_FAILED', OAUTH_REQUEST_BUILD_FAILED: 'OAUTH_REQUEST_BUILD_FAILED', OAUTH_RPC_SENT: 'OAUTH_RPC_SENT',
  OAUTH_RESPONSE_RECEIVED: 'OAUTH_RESPONSE_RECEIVED', OAUTH_REJECTED: 'OAUTH_REJECTED',
  OAUTH_TOKEN_EXPIRED: 'OAUTH_TOKEN_EXPIRED', CLIENT_VERSION_MISMATCH: 'CLIENT_VERSION_MISMATCH',
  SESSION_NOT_ESTABLISHED: 'SESSION_NOT_ESTABLISHED', SESSION_ESTABLISHMENT_FAILED: 'SESSION_ESTABLISHMENT_FAILED', AUTHENTICATED: 'AUTHENTICATED',
  FETCH_GAME_RECORD_REACHED: 'FETCH_GAME_RECORD_REACHED',
  FETCH_GAME_RECORD_FAILED: 'FETCH_GAME_RECORD_FAILED', PAIPU_FETCH_SUCCEEDED: 'PAIPU_FETCH_SUCCEEDED'
});

function safeAuthDiagnostic(overrides = {}) {
  return { authStage: 'SECRET_LOADING', authState: AUTH_STATES.SECRET_NOT_CONFIGURED, oauthRpcName: '.lq.Lobby.prepareLogin', oauthRequestBuilt: false, oauthResponseReceived: false, sessionEstablished: false, fetchGameRecordReached: false, rpcTimeline: [], rpcSequence: [], recordResolveReached: false, recordResolveSucceeded: false, resolvedRecordIdType: 'completePaipuId', resolvedRecordIdSource: 'sharedUrlPageState', resolvedRecordIdAvailable: true, fetchGameRecordInputType: 'completePaipuId', fetchGameRecordInputSource: 'sharedUrlPageState', nextRpc: '.lq.Route.requestConnection', confirmedRpcCount: 0, safeErrorCode: null, safeErrorMessage: null, nextAction: 'Worker Secretを登録してください', confirmedAuthFlowVersion: 'route-prepare-login-record-v2', confirmedSecretSchema: ['flowVersion', 'connectionType', 'clientVersionString', 'providerType', 'prepareLoginToken'], implementationEvidence: ['current Chrome sanitized HAR', '.lq.Route.requestConnection', '.lq.Lobby.prepareLogin', '.lq.Lobby.fetchGameRecord', '.lq.Lobby.readGameRecord', '.lq.Lobby.fetchGameRecordsDetailV2', 'jp-WebGL-release-4.0.11(12)'], ...overrides };
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

function buildRpcRequest(paipuId, clientVersion, requestId = 1) {
  const requestBody = new Uint8Array([
    ...encodeStringField(1, paipuId),
    // v5.3.0: 現行routesが要求する配信versionを同じ通信根拠からRPCへ引き渡す。
    ...encodeStringField(2, clientVersion)
  ]);
  return buildNamedRpcRequest('.lq.Lobby.fetchGameRecord', requestBody, requestId);
}

function parseAuthSecret(env) {
  if (!env || !env[AUTH_SECRET_NAME]) return null;
  try {
    const value = JSON.parse(env[AUTH_SECRET_NAME]);
    if (value.flowVersion !== 'route-prepare-login-v1' || !Number.isInteger(value.connectionType) || typeof value.clientVersionString !== 'string' || !value.clientVersionString || !Number.isInteger(value.providerType) || typeof value.prepareLoginToken !== 'string' || !value.prepareLoginToken) return null;
    return { flowVersion: value.flowVersion, connectionType: value.connectionType, clientVersionString: value.clientVersionString, providerType: value.providerType, prepareLoginToken: value.prepareLoginToken };
  } catch (_) { return null; }
}

function buildRequestConnectionRequest(auth, requestId) {
  return buildNamedRpcRequest('.lq.Route.requestConnection', new Uint8Array([
    ...encodeVarintField(2, auth.connectionType), ...encodeStringField(3, auth.clientVersionString), ...encodeVarintField(4, Math.floor(Date.now() / 1000))
  ]), requestId);
}

function buildPrepareLoginRequest(auth, requestId) {
  return buildNamedRpcRequest('.lq.Lobby.prepareLogin', new Uint8Array([
    ...encodeStringField(1, auth.prepareLoginToken), ...encodeVarintField(2, auth.providerType)
  ]), requestId);
}

function buildReadGameRecordRequest(clientVersionString, requestId) {
  // v5.3.3: 現行HARでfetchGameRecord field 2と同一値だったfield 2だけを送る。
  return buildNamedRpcRequest('.lq.Lobby.readGameRecord', new Uint8Array([
    ...encodeStringField(2, clientVersionString)
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

async function websocketRpcSequence(url, payloads, timeoutMs, onResponse) {
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
        if (bytes[0] !== 3 || (bytes[1] | (bytes[2] << 8)) !== expectedIds[next]) return;
        if (onResponse) onResponse(bytes, next);
        responses.push(bytes); next += 1;
        if (next >= payloads.length) finish(); else socket.send(payloads[next]);
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

async function authenticatedFetchRecord(gatewayUrl, auth, paipuId, clientVersion) {
  // v5.3.3: 共有URLから牌譜画面までの実通信5 RPCを同一Socketで再現する。
  let diagnostic = safeAuthDiagnostic({ authStage: 'OAUTH_REQUEST_BUILD', authState: AUTH_STATES.OAUTH_REQUEST_BUILD_FAILED, nextAction: 'Workerを再デプロイしてください' });
  let payloads;
  try { payloads = [buildRequestConnectionRequest(auth, 1), buildPrepareLoginRequest(auth, 2), buildRpcRequest(paipuId, clientVersion, 3), buildReadGameRecordRequest(clientVersion, 4), buildGameRecordsDetailRequest(paipuId, 5)]; }
  catch (_) { throw safeAuthError(AUTH_STATES.OAUTH_REQUEST_BUILD_FAILED, diagnostic, 500); }
  const sequence = ['.lq.Route.requestConnection', '.lq.Lobby.prepareLogin', '.lq.Lobby.fetchGameRecord', '.lq.Lobby.readGameRecord', '.lq.Lobby.fetchGameRecordsDetailV2'];
  const timeline = sequence.map((rpc, index) => ({ order: index + 1, rpc, status: 'pending' }));
  diagnostic = safeAuthDiagnostic({ authStage: 'CONNECTION_PREFLIGHT', authState: AUTH_STATES.OAUTH_RPC_SENT, oauthRpcName: '.lq.Route.requestConnection', oauthRequestBuilt: true, rpcTimeline: timeline, rpcSequence: sequence, nextRpc: sequence[0], confirmedRpcCount: sequence.length, nextAction: '現行認証応答を待っています' });
  const frames = await websocketRpcSequence(gatewayUrl, payloads, 25000, (bytes, index) => {
    timeline[index] = { ...timeline[index], status: 'succeeded' };
    const response = index === 2 ? null : parseGenericRpcResponse(bytes, index + 1);
    diagnostic = safeAuthDiagnostic({ ...diagnostic, authStage: index === 0 ? 'REQUEST_CONNECTION_RESPONSE' : index === 1 ? 'PREPARE_LOGIN_RESPONSE' : index === 2 ? 'FETCH_GAME_RECORD_RESPONSE' : index === 3 ? 'READ_GAME_RECORD_RESPONSE' : 'GAME_RECORD_DETAIL_RESPONSE', authState: index < 2 ? AUTH_STATES.OAUTH_RESPONSE_RECEIVED : AUTH_STATES.FETCH_GAME_RECORD_REACHED, oauthRpcName: sequence[index], oauthRequestBuilt: true, oauthResponseReceived: true, sessionEstablished: index >= 1, fetchGameRecordReached: index >= 2, rpcTimeline: timeline, rpcSequence: sequence, nextRpc: sequence[index + 1] || null, confirmedRpcCount: sequence.length, nextAction: index < 4 ? '次の現行RPCを実行します' : '牌譜本体を検証します' });
    if (index === 2) return;
    if (response.errorPresent) {
      const safe = classifyOauthError(response.error);
      diagnostic = { ...diagnostic, authState: AUTH_STATES.OAUTH_REJECTED, safeErrorCode: safe.code, safeErrorMessage: safe.message, nextAction: safe.nextAction };
      const error = safeAuthError(AUTH_STATES.OAUTH_REJECTED, diagnostic); error.rpcCode = response.error.code; throw error;
    }
    if (index === 1) diagnostic = safeAuthDiagnostic({ ...diagnostic, authStage: 'SESSION_ESTABLISHED', authState: AUTH_STATES.AUTHENTICATED, oauthRpcName: '.lq.Lobby.prepareLogin', sessionEstablished: true, nextRpc: '.lq.Lobby.fetchGameRecord', nextAction: 'fetchGameRecordを実行します' });
  });
  if (!diagnostic.sessionEstablished) throw safeAuthError(AUTH_STATES.SESSION_NOT_ESTABLISHED, { ...diagnostic, authStage: 'SESSION_ESTABLISHMENT', authState: AUTH_STATES.SESSION_NOT_ESTABLISHED, safeErrorCode: 'SESSION_NOT_ESTABLISHED', safeErrorMessage: 'OAuth応答後にセッションを確立できませんでした', nextAction: '認証Secretを再取得して登録し直してください' });
  try { return { parsed: parseRpcResponse(frames[2], 3), rpcCode: 0, authDiagnostic: { ...diagnostic, authStage: 'GAME_RECORD_SEQUENCE_COMPLETED', fetchGameRecordReached: true, nextRpc: null } }; }
  catch (_) { throw safeAuthError(AUTH_STATES.FETCH_GAME_RECORD_FAILED, { ...diagnostic, authStage: 'FETCH_GAME_RECORD', authState: AUTH_STATES.FETCH_GAME_RECORD_FAILED, fetchGameRecordReached: true, safeErrorCode: 'FETCH_GAME_RECORD_RESPONSE_INVALID', safeErrorMessage: '牌譜RPC応答を解析できませんでした', nextAction: '同じ共有URLでもう一度試してください' }, 502); }
}

async function fetchRecordPayload(paipuId, analysis, signal, auth) {
  const candidates = [paipuId];
  const uuid = paipuId.split('_')[0];
  if (uuid !== paipuId) candidates.push(uuid);
  // v5.3.3: 認証時は推測候補を廃止し、実通信と同じSecret内clientVersionStringだけを使う。
  const versionCandidates = auth ? [auth.clientVersionString] : [CURRENT_LIQI_CLIENT_VERSION, '0.16.206.w', 'v0.16.206.W.' + analysis.buildVersion, analysis.buildVersion];
  const attempts = []; let lastAuthDiagnostic = null;
  let requestId = 0;
  for (const id of candidates) for (const clientVersion of versionCandidates) {
    const started = Date.now();
    try {
      requestId += 1;
      let parsed, rpcCode = null;
      if (auth) { const authenticated = await authenticatedFetchRecord(analysis.gatewayUrl, auth, id, clientVersion); parsed = authenticated.parsed; rpcCode = authenticated.rpcCode; lastAuthDiagnostic = authenticated.authDiagnostic; }
      else { const raw = await websocketRpc(analysis.gatewayUrl, buildRpcRequest(id, clientVersion, requestId), 15000); parsed = parseRpcResponse(raw, requestId); }
      if (parsed.data && parsed.data.length) return { bytes: parsed.data, sourceUrl: analysis.gatewayUrl, finalUrl: analysis.gatewayUrl, httpStatus: 101, contentType: 'application/x-protobuf', redirect: false, durationMs: Date.now() - started, accessedApi: '.lq.Lobby.fetchGameRecord', clientVersion, attempts, authDiagnostic: lastAuthDiagnostic, authState: auth ? AUTH_STATES.PAIPU_FETCH_SUCCEEDED : AUTH_STATES.AUTHENTICATED, rpcCode };
      if (parsed.dataUrl && /^https:\/\//i.test(parsed.dataUrl)) {
        const response = await fetch(parsed.dataUrl, { signal, redirect: 'follow', headers: { Accept: 'application/octet-stream,application/x-protobuf,*/*;q=0.5' } });
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!response.ok || !bytes.length) throw new Error('record data URL HTTP ' + response.status);
        return { bytes, sourceUrl: parsed.dataUrl, finalUrl: response.url, httpStatus: response.status, contentType: response.headers.get('content-type') || 'application/octet-stream', redirect: response.redirected, durationMs: Date.now() - started, accessedApi: '.lq.Lobby.fetchGameRecord → data_url', clientVersion, attempts, authDiagnostic: lastAuthDiagnostic, authState: auth ? AUTH_STATES.PAIPU_FETCH_SUCCEEDED : AUTH_STATES.AUTHENTICATED, rpcCode };
      }
      attempts.push({ paipuId: id, clientVersion, gatewayUrl: analysis.gatewayUrl, method: parsed.method, durationMs: Date.now() - started, reason: parsed.error ? 'RPC_ERROR' : 'EMPTY_RECORD', rpcError: parseRpcError(parsed.error) });
    } catch (error) {
      if (error.authDiagnostic) lastAuthDiagnostic = error.authDiagnostic;
      attempts.push({ clientVersion, gatewayConnected: true, durationMs: Date.now() - started, reason: error.code || 'RPC_FAILED', safeErrorCode: error.authDiagnostic && error.authDiagnostic.safeErrorCode || null });
      if (error.code === AUTH_STATES.OAUTH_REJECTED || error.code === AUTH_STATES.OAUTH_REQUEST_BUILD_FAILED || error.code === AUTH_STATES.SESSION_NOT_ESTABLISHED) { error.attempts = attempts; throw error; }
    }
  }
  const error = new Error('現行ゲートウェイは応答しましたが、牌譜本体を取得できませんでした');
  error.code = AUTH_STATES.FETCH_GAME_RECORD_FAILED; error.status = 404; error.attempts = attempts; error.authDiagnostic = lastAuthDiagnostic ? { ...lastAuthDiagnostic, authStage: 'FETCH_GAME_RECORD', authState: AUTH_STATES.FETCH_GAME_RECORD_FAILED, fetchGameRecordReached: true, safeErrorCode: 'RECORD_NOT_FOUND', safeErrorMessage: '牌譜RPCは応答しましたが牌譜本体がありません', nextAction: '共有URLが自分のアカウントで閲覧できるか確認してください' } : safeAuthDiagnostic({ authStage: 'FETCH_GAME_RECORD', authState: AUTH_STATES.FETCH_GAME_RECORD_FAILED, fetchGameRecordReached: true, safeErrorCode: 'RECORD_NOT_FOUND', safeErrorMessage: '牌譜RPCは応答しましたが牌譜本体がありません', nextAction: '共有URLが自分のアカウントで閲覧できるか確認してください' }); throw error;
}

async function fetchMajsoulPaipu(paipuId, env, signal) {
  const auth = parseAuthSecret(env);
  if (!env || !env[AUTH_SECRET_NAME]) throw safeAuthError(AUTH_STATES.SECRET_NOT_CONFIGURED, safeAuthDiagnostic(), 503);
  if (!auth) throw safeAuthError(AUTH_STATES.SECRET_FORMAT_INVALID, safeAuthDiagnostic({ authStage: 'SECRET_VALIDATION', authState: AUTH_STATES.SECRET_FORMAT_INVALID, safeErrorCode: 'SECRET_FORMAT_INVALID', safeErrorMessage: 'Worker SecretのJSON形式または必須フィールドが正しくありません', nextAction: '認証Secretを再取得して登録し直してください' }), 503);
  const analysis = await analyzeCurrentClient(paipuId, signal);
  try {
    const record = await fetchRecordPayload(paipuId, analysis, signal, auth);
    if (record.bytes.length > MAX_PAYLOAD_BYTES) { const error = new Error('牌譜データが上限を超えました'); error.code = 'PAYLOAD_TOO_LARGE'; error.status = 413; throw error; }
    return { ...record, analysis, authDiagnostic: { ...(record.authDiagnostic || safeAuthDiagnostic()), authStage: 'PAIPU_FETCH', authState: AUTH_STATES.PAIPU_FETCH_SUCCEEDED, oauthResponseReceived: true, sessionEstablished: true, fetchGameRecordReached: true, safeErrorCode: null, safeErrorMessage: null, nextAction: '牌譜デコードは次バージョンで実行します' }, secretConfigured: true, gatewayConnected: true, rpc: '.lq.Lobby.fetchGameRecord', payloadType: 'protobuf', payloadEncoding: 'base64', size: record.bytes.length, payload: bytesToBase64(record.bytes) };
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
    return jsonResponse(request, env, { ok: true, version: 1, source: 'majsoul', paipuId, ...result.authDiagnostic, secretConfigured: true, gatewayConnected: true, rpc: result.rpc, rpcCode: result.rpcCode, paipuFetchSucceeded: true, sourceType: 'current_gateway_rpc', gateway: new URL(result.sourceUrl).host, sourceUrl: result.sourceUrl, finalUrl: result.finalUrl, accessedApi: result.accessedApi, httpStatus: result.httpStatus, contentType: result.contentType, payloadType: result.payloadType, size: result.size, durationMs: result.durationMs, redirect: result.redirect, payloadEncoding: result.payloadEncoding, attempts: result.attempts, analysis: result.analysis, payload: result.payload });
  } catch (error) {
    const secretConfigured = Boolean(env && env[AUTH_SECRET_NAME]);
    const authDiagnostic = error.authDiagnostic || safeAuthDiagnostic({ authStage: 'FETCH_GAME_RECORD', authState: error.code || AUTH_STATES.FETCH_GAME_RECORD_FAILED, safeErrorCode: error.code || 'UNKNOWN_ERROR', safeErrorMessage: '安全な詳細を取得できませんでした', nextAction: '同じ操作を再試行してください' });
    const diagnostics = { ...authDiagnostic, secretConfigured, gatewayConnected: Boolean(error.analysis && error.analysis.gatewayUrl), rpc: '.lq.Lobby.fetchGameRecord', rpcCode: Number.isInteger(error.rpcCode) ? error.rpcCode : null, paipuFetchSucceeded: false, payloadType: null, payloadSize: 0, analysis: error.analysis || null, attempts: error.attempts || [] };
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

export { AUTH_STATES, analyzeCurrentClient, buildGameRecordsDetailRequest, buildPrepareLoginRequest, buildReadGameRecordRequest, buildRequestConnectionRequest, buildRpcRequest, extractPaipuId, extractUnityConfig, fetchMajsoulPaipu, parseAuthSecret, parseRpcResponse, validatePaipuId };
