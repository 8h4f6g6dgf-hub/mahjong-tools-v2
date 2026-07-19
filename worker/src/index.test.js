import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { buildOauth2CheckRequest, buildOauth2LoginRequest, buildRpcRequest, extractPaipuId, extractUnityConfig, parseAuthSecret, parseRpcResponse } from './index.js';

function field(id, value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [(id << 3) | 2, bytes.length, ...bytes];
}

test('共有URLから完全な牌譜IDを保持する', () => {
  assert.equal(extractPaipuId('https://game.mahjongsoul.com/?paipu=240101-test_abc'), '240101-test_abc');
});

test('現行HTMLからUnity設定を絶対URL化する', () => {
  const html = `<script src="Build/jp-WebGL-release-4.0.11(12).loader.js"></script><script>var config={dataUrl:"/x.data.gz",frameworkUrl:"Build/x.framework.js.gz",codeUrl:"Build/x.wasm.gz",streamingAssetsUrl:"StreamingAssets"}</script>`;
  const config = extractUnityConfig(html);
  assert.equal(config.buildVersion, '4.0.11');
  assert.equal(config.loaderUrl, 'https://game.mahjongsoul.com/Build/jp-WebGL-release-4.0.11(12).loader.js');
  assert.equal(config.dataUrl, 'https://game.mahjongsoul.com/x.data.gz');
});

test('fetchGameRecord RPCに完全IDと現行versionを含める', () => {
  const request = buildRpcRequest('240101-test_abc', '4.0.11');
  assert.equal(request[0], 2);
  const text = new TextDecoder().decode(request);
  assert.match(text, /\.lq\.Lobby\.fetchGameRecord/);
  assert.match(text, /240101-test_abc/);
  assert.match(text, /4\.0\.11/);
});

test('Liqiレスポンスから牌譜dataを抽出する', () => {
  const recordData = new Uint8Array([8, 1, 18, 2, 3, 4]);
  const record = new Uint8Array(field(4, recordData));
  const wrapper = new Uint8Array([...field(1, '.lq.Lobby.fetchGameRecord'), ...field(2, record)]);
  const response = new Uint8Array([3, 1, 0, ...wrapper]);
  const parsed = parseRpcResponse(response);
  assert.deepEqual([...parsed.data], [...recordData]);
});

test('認証Secretを検証し、認証RPCをProtobuf化する', () => {
  const secret = JSON.stringify({ type: 7, accessToken: 'local-test-token' });
  const auth = parseAuthSecret({ MAJSOUL_OAUTH2_CREDENTIALS: secret });
  assert.deepEqual(auth, { type: 7, accessToken: 'local-test-token' });
  assert.match(new TextDecoder().decode(buildOauth2CheckRequest(auth, 1)), /\.lq\.Lobby\.oauth2Check/);
  assert.match(new TextDecoder().decode(buildOauth2LoginRequest(auth, 'web-0.16.206', 2)), /\.lq\.Lobby\.oauth2Login/);
});

test('healthはSecret値を返さず設定有無だけ返す', async () => {
  const response = await worker.fetch(new Request('https://example.test/health'), { MAJSOUL_OAUTH2_CREDENTIALS: '{"type":7,"accessToken":"never-return-this"}' });
  const text = await response.text();
  assert.doesNotMatch(text, /never-return-this/);
  assert.equal(JSON.parse(text).secretConfigured, true);
});
