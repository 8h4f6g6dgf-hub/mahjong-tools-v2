import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { buildGameRecordsDetailRequest, buildPrepareLoginRequest, buildReadGameRecordRequest, buildRequestConnectionRequest, buildRpcRequest, classifyRpcFailure, compareFetchRequestToProfile, extractPaipuId, extractUnityConfig, inspectRpcFrame, parseAuthSecret, parseRpcResponse } from './index.js';

function field(id, value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [(id << 3) | 2, bytes.length, ...bytes];
}

function varintField(id, value) { return [(id << 3), value]; }
const fetchProfile = { version: 'current-har-v1', messageType: '.lq.Lobby.fetchGameRecord', envelopeFields: [{ field: 1, wire: 2 }, { field: 2, wire: 2 }], requestFields: [{ field: 1, wire: 2, source: 'completePaipuId' }, { field: 2, wire: 2, source: 'clientVersionString' }], validated: true };

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
  const request = buildRpcRequest('240101-test_abc', '4.0.11', 1, fetchProfile);
  assert.equal(request[0], 2);
  const text = new TextDecoder().decode(request);
  assert.match(text, /\.lq\.Lobby\.fetchGameRecord/);
  assert.match(text, /240101-test_abc/);
  assert.match(text, /4\.0\.11/);
});

test('fetchGameRecordリクエストが現行HAR構造と完全一致する', () => {
  const request = buildRpcRequest('240101-test_abc', 'current-web-version', 3, fetchProfile);
  const score = compareFetchRequestToProfile(request, fetchProfile);
  assert.equal(score.requestMatchScore, 100);
  assert.equal(score.envelopeMatchScore, 100);
  assert.equal(score.fieldMatchScore, 100);
  assert.equal(score.messageMatchScore, 100);
  assert.equal(score.fetchGameRecordRequestValidated, true);
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
  const secret = JSON.stringify({ flowVersion: 'route-prepare-login-v1', connectionType: 2, clientVersionString: 'current-web-version', providerType: 21, prepareLoginToken: 'local-test-token', fetchGameRecordProfile: fetchProfile });
  const auth = parseAuthSecret({ MAJSOUL_OAUTH2_CREDENTIALS: secret });
  assert.equal(auth.flowVersion, 'route-prepare-login-v1');
  assert.match(new TextDecoder().decode(buildRequestConnectionRequest(auth, 1)), /\.lq\.Route\.requestConnection/);
  assert.match(new TextDecoder().decode(buildPrepareLoginRequest(auth, 2)), /\.lq\.Lobby\.prepareLogin/);
});

test('既存認証Secretと別Secretのfetch構造を安全に結合する', () => {
  const credential = JSON.stringify({ flowVersion: 'route-prepare-login-v1', connectionType: 2, clientVersionString: 'current-web-version', providerType: 21, prepareLoginToken: 'local-test-token' });
  const auth = parseAuthSecret({ MAJSOUL_OAUTH2_CREDENTIALS: credential, MAJSOUL_FETCH_GAME_RECORD_PROFILE: JSON.stringify(fetchProfile) });
  assert.equal(auth.fetchGameRecordProfile.validated, true);
  assert.equal(auth.clientVersionString, 'current-web-version');
});

test('現行牌譜画面の後続RPCへ実通信と同じ入力型を渡す', () => {
  const read = new TextDecoder().decode(buildReadGameRecordRequest('current-web-version', 4));
  const detail = new TextDecoder().decode(buildGameRecordsDetailRequest('240101-test_abc', 5));
  assert.match(read, /\.lq\.Lobby\.readGameRecord/);
  assert.match(read, /current-web-version/);
  assert.match(detail, /\.lq\.Lobby\.fetchGameRecordsDetailV2/);
  assert.match(detail, /240101-test_abc/);
});

test('readGameRecordの1004をOAuth拒否ではなく実際のRPC失敗へ分類する', () => {
  const rpcError = new Uint8Array([...varintField(1, 1004 & 0x7f), ...field(2, 'safe rpc error')]);
  // 1004は複数byte varintなので、実際の符号なしvarint表現へ置換する。
  const encodedError = new Uint8Array([8, 0xec, 0x07, ...field(2, 'safe rpc error')]);
  const body = new Uint8Array(field(1, encodedError));
  const wrapper = new Uint8Array([...field(1, '.lq.Lobby.readGameRecord'), ...field(2, body)]);
  const inspected = inspectRpcFrame(new Uint8Array([3, 4, 0, ...wrapper]), 4, '.lq.Lobby.readGameRecord');
  const classified = classifyRpcFailure(inspected.meta.rpc, inspected.meta.rpcCode);
  assert.equal(inspected.meta.rpcCode, 1004);
  assert.equal(classified.state, 'READ_GAME_RECORD_FAILED');
  assert.equal(classified.previous, 'OAUTH_REJECTED');
  assert.equal(rpcError.length > 0, true);
});

test('詳細RPCのProtobuf EnvelopeからPayloadメタデータだけを安全に抽出する', () => {
  const payload = new Uint8Array([8, 1, 18, 2, 3, 4]);
  const body = new Uint8Array(field(2, payload));
  const wrapper = new Uint8Array([...field(1, '.lq.Lobby.fetchGameRecordsDetailV2'), ...field(2, body)]);
  const inspected = inspectRpcFrame(new Uint8Array([3, 5, 0, ...wrapper]), 5, '.lq.Lobby.fetchGameRecordsDetailV2');
  assert.equal(inspected.meta.protobufEnvelopeParsed, true);
  assert.equal(inspected.meta.payloadDetected, true);
  assert.equal(inspected.meta.payloadSize, payload.length);
  assert.deepEqual(inspected.meta.fieldNumbers, [2]);
});

test('healthはSecret値を返さず設定有無だけ返す', async () => {
  const response = await worker.fetch(new Request('https://example.test/health'), { MAJSOUL_OAUTH2_CREDENTIALS: JSON.stringify({ flowVersion: 'route-prepare-login-v1', connectionType: 2, clientVersionString: 'safe', providerType: 21, prepareLoginToken: 'never-return-this', fetchGameRecordProfile: fetchProfile }) });
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
