import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { buildPrepareLoginRequest, buildRequestConnectionRequest, buildRpcRequest, extractPaipuId, extractUnityConfig, parseAuthSecret, parseRpcResponse } from './index.js';

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

test('現行認証Secretを検証し、認証RPCをProtobuf化する', () => {
  const secret = JSON.stringify({ flowVersion: 'route-prepare-login-v1', connectionType: 2, clientVersionString: 'current-web-version', providerType: 21, prepareLoginToken: 'local-test-token' });
  const auth = parseAuthSecret({ MAJSOUL_OAUTH2_CREDENTIALS: secret });
  assert.equal(auth.flowVersion, 'route-prepare-login-v1');
  assert.match(new TextDecoder().decode(buildRequestConnectionRequest(auth, 1)), /\.lq\.Route\.requestConnection/);
  assert.match(new TextDecoder().decode(buildPrepareLoginRequest(auth, 2)), /\.lq\.Lobby\.prepareLogin/);
});

test('healthはSecret値を返さず設定有無だけ返す', async () => {
  const response = await worker.fetch(new Request('https://example.test/health'), { MAJSOUL_OAUTH2_CREDENTIALS: '{"flowVersion":"route-prepare-login-v1","connectionType":2,"clientVersionString":"safe","providerType":21,"prepareLoginToken":"never-return-this"}' });
  const text = await response.text();
  assert.doesNotMatch(text, /never-return-this/);
  assert.equal(JSON.parse(text).secretConfigured, true);
  assert.equal(JSON.parse(text).secretSchemaValid, true);
});

test('healthは旧Secretを安全に形式不正と判定する', async () => {
  const response = await worker.fetch(new Request('https://example.test/health'), { MAJSOUL_OAUTH2_CREDENTIALS: '{"type":21,"accessToken":"never-return-this"}' });
  const text = await response.text(), body = JSON.parse(text);
  assert.equal(body.secretConfigured, true);
  assert.equal(body.secretSchemaValid, false);
  assert.equal(body.authState, 'SECRET_FORMAT_INVALID');
  assert.doesNotMatch(text, /never-return-this/);
});

test('Secret形式不正を安全な段階コードで返す', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/paipu?id=240101-test_abc'), { MAJSOUL_OAUTH2_CREDENTIALS: '{"type":"invalid","accessToken":"do-not-return"}' });
  const text = await response.text(), body = JSON.parse(text);
  assert.equal(response.status, 503);
  assert.equal(body.error.code, 'SECRET_FORMAT_INVALID');
  assert.equal(body.diagnostics.authStage, 'SECRET_VALIDATION');
  assert.equal(body.diagnostics.nextAction, '認証Secretを再取得して登録し直してください');
  assert.doesNotMatch(text, /do-not-return/);
});
