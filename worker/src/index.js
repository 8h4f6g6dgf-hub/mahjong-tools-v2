const SERVICE_NAME = 'mahjong-paipu-proxy';
const SERVICE_VERSION = '5.2.0';
const DEFAULT_ALLOWED_ORIGIN = 'https://8h4f6g6dgf-hub.github.io';
const REQUEST_TIMEOUT_MS = 20000;
const MAX_PAYLOAD_BYTES = 6 * 1024 * 1024;

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowedOrigin = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (origin === allowedOrigin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function jsonResponse(request, env, body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders(request, env),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function errorResponse(request, env, status, code, message) {
  return jsonResponse(request, env, { ok: false, error: { code, message } }, status);
}

function extractPaipuId(value) {
  value = String(value || '').trim();
  if (/^https?:\/\//i.test(value)) {
    const sharedUrl = new URL(value);
    const host = sharedUrl.hostname.toLowerCase();
    if (host !== 'game.mahjongsoul.com' && !host.endsWith('.mahjongsoul.com')) return null;
    value = sharedUrl.searchParams.get('paipu') || '';
    if (!value && sharedUrl.hash) {
      const hashQuery = sharedUrl.hash.includes('?') ? sharedUrl.hash.split('?')[1] : sharedUrl.hash.slice(1);
      value = new URLSearchParams(hashQuery).get('paipu') || '';
    }
  }
  try { value = decodeURIComponent(value); } catch (_) {}
  return validatePaipuId(value) ? value : null;
}

function validatePaipuId(value) {
  // v5.2.0: 任意URLは受け付けず、雀魂共有URLまたは牌譜IDだけを固定取得先へ渡す。
  return typeof value === 'string' && value.length >= 8 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

function buildMajsoulCandidates(paipuId) {
  const uuid = paipuId.split('_')[0];
  const recordBase = 'https://mjusgs.mahjongsoul.com:2882/majsoul/game_record/';
  return [
    { kind: 'game_record_uuid', url: recordBase + encodeURIComponent(uuid) },
    { kind: 'game_record_full', url: recordBase + encodeURIComponent(paipuId) },
    { kind: 'share_page', url: 'https://game.mahjongsoul.com/?paipu=' + encodeURIComponent(paipuId) }
  ];
}

function isHtmlBytes(bytes, text) {
  const sample = String(text || new TextDecoder().decode(bytes.slice(0, 2048))).toLowerCase();
  return sample.includes('<!doctype') || sample.includes('<html') || sample.includes('<head') || sample.includes('<body');
}

function looksLikeProtobuf(bytes) {
  let offset = 0, fields = 0;
  while (offset < bytes.length && offset < 128 && fields < 12) {
    let tag = 0, shift = 0, byte;
    do { if (offset >= bytes.length || shift > 28) return false; byte = bytes[offset++]; tag |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    const field = tag >>> 3, wire = tag & 7;if (!field || ![0,1,2,5].includes(wire)) return false;
    if (wire === 0) { do { if (offset >= bytes.length) return false; byte = bytes[offset++]; } while (byte & 0x80); }
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else { let length = 0;shift = 0;do { if (offset >= bytes.length || shift > 28) return false;byte = bytes[offset++];length |= (byte & 0x7f) << shift;shift += 7; } while (byte & 0x80);offset += length; }
    if (offset > bytes.length) return false;fields++;
  }
  return fields >= 2;
}

function bytesToBase64(bytes) {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(result);
}

function classifyPayload(bytes, contentType) {
  const type = String(contentType || '').toLowerCase();
  const textual = type.includes('text/') || type.includes('json') || type.includes('javascript') || type.includes('xml') || type.includes('html');
  const text = textual || bytes.length < 1024 * 1024 ? new TextDecoder().decode(bytes) : '';
  if (isHtmlBytes(bytes, text)) return { payloadType: 'html', payload: text, payloadEncoding: 'utf-8' };
  if (type.includes('json') || /^[\s\uFEFF]*[\[{]/.test(text)) {
    try { return { payloadType: 'json', payload: JSON.parse(text), payloadEncoding: 'json' }; } catch (_) {}
  }
  if (type.includes('protobuf') || type.includes('x-protobuf') || looksLikeProtobuf(bytes)) return { payloadType: 'protobuf', payload: bytesToBase64(bytes), payloadEncoding: 'base64' };
  if (textual) return { payloadType: 'text', payload: text, payloadEncoding: 'utf-8' };
  return { payloadType: 'binary', payload: bytesToBase64(bytes), payloadEncoding: 'base64' };
}

async function fetchMajsoulPaipu(paipuId, env, signal) {
  void env;
  const attempts = [];
  for (const candidate of buildMajsoulCandidates(paipuId)) {
    const started = Date.now();
    try {
      const response = await fetch(candidate.url, { method: 'GET', redirect: 'follow', signal, headers: { Accept: 'application/json, application/octet-stream, text/html;q=0.8, */*;q=0.5' } });
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      if (!response.ok) { attempts.push({ source: candidate.kind, sourceUrl: candidate.url, httpStatus: response.status, contentType, durationMs: Date.now() - started, reason: 'HTTP ' + response.status });continue; }
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > MAX_PAYLOAD_BYTES) { attempts.push({ source: candidate.kind, sourceUrl: candidate.url, httpStatus: response.status, contentType, durationMs: Date.now() - started, reason: 'PAYLOAD_TOO_LARGE' });continue; }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_PAYLOAD_BYTES) { attempts.push({ source: candidate.kind, sourceUrl: candidate.url, httpStatus: response.status, contentType, durationMs: Date.now() - started, reason: 'PAYLOAD_TOO_LARGE' });continue; }
      const classified = classifyPayload(bytes, contentType), durationMs = Date.now() - started;
      return { source: candidate.kind, sourceUrl: response.url || candidate.url, httpStatus: response.status, contentType, size: bytes.length, durationMs, payloadType: classified.payloadType, payloadEncoding: classified.payloadEncoding, payload: classified.payload, attempts };
    } catch (error) {
      if (signal.aborted) throw error;
      attempts.push({ source: candidate.kind, sourceUrl: candidate.url, httpStatus: null, contentType: null, durationMs: Date.now() - started, reason: error && error.message || 'FETCH_FAILED' });
    }
  }
  const error = new Error('雀魂の固定取得先からレスポンスを取得できませんでした');error.code = 'MAJSOUL_UPSTREAM_FAILED';error.status = 502;error.attempts = attempts;throw error;
}

async function withTimeout(operation, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise((resolve, reject) => {
        void resolve;
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error('牌譜取得がタイムアウトしました');
          error.code = 'UPSTREAM_TIMEOUT';
          error.status = 504;
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function handlePaipu(request, env, url) {
  const input = url.searchParams.get('id');
  if (!input) return errorResponse(request, env, 400, 'MISSING_PAIPU_ID', 'idを指定してください');
  const paipuId = extractPaipuId(input);
  if (!paipuId) return errorResponse(request, env, 400, 'INVALID_PAIPU_ID', '雀魂共有URLまたは牌譜IDの形式が正しくありません');

  try {
    const result = await withTimeout((signal) => fetchMajsoulPaipu(paipuId, env, signal), REQUEST_TIMEOUT_MS);
    return jsonResponse(request, env, {
      ok: true,
      version: 1,
      source: 'majsoul',
      paipuId,
      sourceType: result.source,
      sourceUrl: result.sourceUrl,
      httpStatus: result.httpStatus,
      payloadType: result.payloadType,
      contentType: result.contentType,
      size: result.size,
      durationMs: result.durationMs,
      payloadEncoding: result.payloadEncoding,
      attempts: result.attempts,
      payload: result.payload
    });
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.code === 'UPSTREAM_TIMEOUT')) return errorResponse(request, env, 504, 'UPSTREAM_TIMEOUT', '牌譜取得がタイムアウトしました');
    const response = { ok: false, error: { code: error.code || 'PAIPU_FETCH_FAILED', message: error.message || '牌譜取得に失敗しました' } };
    if (Array.isArray(error.attempts)) response.attempts = error.attempts;
    return jsonResponse(request, env, response, error.status || 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowedOrigin = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
    const origin = request.headers.get('Origin');

    try {
      if (request.method === 'OPTIONS') {
        if (origin && origin !== allowedOrigin) return errorResponse(request, env, 403, 'ORIGIN_NOT_ALLOWED', '許可されていないOriginです');
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }
      if (request.method !== 'GET') return errorResponse(request, env, 405, 'METHOD_NOT_ALLOWED', 'GETのみ利用できます');
      if (url.pathname === '/health') return jsonResponse(request, env, { ok: true, service: SERVICE_NAME, version: SERVICE_VERSION });
      if (url.pathname === '/api/paipu') return handlePaipu(request, env, url);
      return errorResponse(request, env, 404, 'NOT_FOUND', 'エンドポイントが見つかりません');
    } catch (error) {
      // 秘密情報やスタックトレースを返さず、クライアント向けの固定メッセージに限定する。
      console.error('worker request failed', error);
      return errorResponse(request, env, 500, 'INTERNAL_ERROR', 'Worker内部でエラーが発生しました');
    }
  }
};

export { buildMajsoulCandidates, classifyPayload, extractPaipuId, fetchMajsoulPaipu, validatePaipuId };
