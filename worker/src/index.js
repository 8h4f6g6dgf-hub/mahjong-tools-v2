const SERVICE_NAME = 'mahjong-paipu-proxy';
const SERVICE_VERSION = '5.0.0';
const DEFAULT_ALLOWED_ORIGIN = 'https://8h4f6g6dgf-hub.github.io';
const REQUEST_TIMEOUT_MS = 10000;

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

function validatePaipuId(value) {
  // v5.0.0: URLを受け取らず牌譜IDだけを許可し、任意外部URLへの中継を防止する。
  return typeof value === 'string' && value.length >= 8 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

async function fetchMajsoulPaipu(paipuId, env, signal) {
  void paipuId;
  void env;
  void signal;
  // 次バージョンで雀魂の固定取得先とProtobuf解析をこの関数内へ追加する。
  const error = new Error('牌譜本体の取得は次バージョンで実装します');
  error.code = 'PAIPU_FETCH_NOT_IMPLEMENTED';
  error.status = 501;
  throw error;
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
  const paipuId = url.searchParams.get('id');
  if (!paipuId) return errorResponse(request, env, 400, 'MISSING_PAIPU_ID', 'idを指定してください');
  if (!validatePaipuId(paipuId)) return errorResponse(request, env, 400, 'INVALID_PAIPU_ID', '牌譜IDの形式が正しくありません');

  try {
    const result = await withTimeout((signal) => fetchMajsoulPaipu(paipuId, env, signal), REQUEST_TIMEOUT_MS);
    return jsonResponse(request, env, {
      ok: true,
      version: 1,
      source: 'majsoul',
      paipuId,
      payloadType: result.payloadType,
      payload: result.payload
    });
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.code === 'UPSTREAM_TIMEOUT')) return errorResponse(request, env, 504, 'UPSTREAM_TIMEOUT', '牌譜取得がタイムアウトしました');
    return errorResponse(request, env, error.status || 502, error.code || 'PAIPU_FETCH_FAILED', error.message || '牌譜取得に失敗しました');
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

export { fetchMajsoulPaipu, validatePaipuId };
