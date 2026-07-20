import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { buildGameRecordsDetailRequest, buildPrepareLoginRequest, buildReadGameRecordRequest, buildRequestConnectionRequest, buildRpcRequest, classifyRpcFailure, compareFetchRequestToProfile, extractPaipuId, extractUnityConfig, inspectRpcFrame, parseAuthSecret, parseRpcResponse, websocketRpcSequence } from './index.js';
import { CONNECTION_CONTEXT_PENDING, createFetchProfile, validateFetchProfile } from './shared/fetch-profile-schema.js';
import { buildSessionRuntimePlan, createSessionTimeline, legacySessionTimeline, safeDelayMs, validateSessionTimeline } from './shared/session-timeline-schema.js';

function field(id, value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [(id << 3) | 2, bytes.length, ...bytes];
}

function varintField(id, value) { return [(id << 3), value]; }
const fetchProfile = { version: 'current-har-v2', messageType: '.lq.Lobby.fetchGameRecord', envelopeFields: [{ field: 1, wire: 2 }, { field: 2, wire: 2 }], requestFields: [{ field: 1, wire: 2, source: 'completePaipuId' }, { field: 2, wire: 2, source: 'fetchClientContext' }], fetchClientContext: 'current-fetch-context', clientVersionValidated: true, clientVersionIsRouteId: false, clientVersionSemanticMatch: true, field1SourceValidated: true, field2SourceValidated: true, semanticValidated: true, validated: true };

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
  const secret = JSON.stringify({ flowVersion: 'route-prepare-login-v1', connectionType: 2, routeContextString: 'route-context', providerType: 21, prepareLoginToken: 'local-test-token', fetchGameRecordProfile: fetchProfile });
  const auth = parseAuthSecret({ MAJSOUL_OAUTH2_CREDENTIALS: secret });
  assert.equal(auth.flowVersion, 'route-prepare-login-v1');
  assert.match(new TextDecoder().decode(buildRequestConnectionRequest(auth, 1)), /\.lq\.Route\.requestConnection/);
  assert.match(new TextDecoder().decode(buildPrepareLoginRequest(auth, 2)), /\.lq\.Lobby\.prepareLogin/);
});

test('既存認証Secretと別Secretのfetch構造を安全に結合する', () => {
  const credential = JSON.stringify({ flowVersion: 'route-prepare-login-v1', connectionType: 2, routeContextString: 'route-context', providerType: 21, prepareLoginToken: 'local-test-token' });
  const auth = parseAuthSecret({ MAJSOUL_OAUTH2_CREDENTIALS: credential, MAJSOUL_FETCH_GAME_RECORD_PROFILE: JSON.stringify(fetchProfile) });
  assert.equal(auth.fetchGameRecordProfile.validated, true);
  assert.equal(auth.fetchClientContext, 'current-fetch-context');
});

test('route IDをfetch client contextとして受け付けない', () => {
  const invalidProfile = { ...fetchProfile, fetchClientContext: 'jp-2', clientVersionValidated: false, clientVersionIsRouteId: true, clientVersionSemanticMatch: false, semanticValidated: false };
  const credential = JSON.stringify({ flowVersion: 'route-prepare-login-v1', connectionType: 2, routeContextString: 'route-context', providerType: 21, prepareLoginToken: 'local-test-token' });
  assert.equal(parseAuthSecret({ MAJSOUL_OAUTH2_CREDENTIALS: credential, MAJSOUL_FETCH_GAME_RECORD_PROFILE: JSON.stringify(invalidProfile) }), null);
});

test('v2個別検証がすべてtrueなら意味一致となりconnectionは実行待ちになる', () => {
  const validation = validateFetchProfile(fetchProfile);
  assert.equal(validation.profileSchemaValid, true);
  assert.equal(validation.requestSemanticMatched, true);
  assert.equal(validation.connectionContextStatus, CONNECTION_CONTEXT_PENDING);
  assert.equal(validation.connectionContextMatched, null);
  assert.equal(validation.remainingMismatchCategory, null);
});

test('HAR connection indexは実行時connection IDとの値一致を要求しない', () => {
  const profile = createFetchProfile({ messageType: '.lq.Lobby.fetchGameRecord', envelopeFields: fetchProfile.envelopeFields, requestFields: fetchProfile.requestFields, fetchClientContext: 'current-fetch-context', sourceConnectionIndex: 987, sourceMetadata: [] });
  const validation = validateFetchProfile(profile);
  assert.equal(validation.requestSemanticMatched, true);
  assert.equal(validation.connectionContextStatus, CONNECTION_CONTEXT_PENDING);
});

test('共有スキーマv3で生成したprofileもWorker比較へ通る', () => {
  const profile = createFetchProfile({ messageType: '.lq.Lobby.fetchGameRecord', envelopeFields: fetchProfile.envelopeFields, requestFields: fetchProfile.requestFields, fetchClientContext: 'current-fetch-context', sourceConnectionIndex: 5, sourceMetadata: [] });
  const score = compareFetchRequestToProfile(buildRpcRequest('240101-test_abc', 'current-fetch-context', 3, profile), profile);
  assert.equal(score.fetchGameRecordRequestValidated, true);
  assert.equal(score.requestMatchScore, 100);
});

test('request ID方針不一致は具体的カテゴリで停止する', () => {
  const validation = validateFetchProfile({ ...fetchProfile, requestIdPolicy: 'fixed' });
  assert.equal(validation.requestSemanticMatched, false);
  assert.equal(validation.remainingMismatchCategory, 'REQUEST_ID_POLICY_MISMATCH');
});

test('同一WebSocket関係が未検証なら具体的カテゴリで停止する', () => {
  const validation = validateFetchProfile({ ...fetchProfile, connectionContextValidated: false });
  assert.equal(validation.requestSemanticMatched, false);
  assert.equal(validation.remainingMismatchCategory, 'CONNECTION_RELATION_MISMATCH');
});

test('prepareLogin前提が欠ければ具体的カテゴリで停止する', () => {
  const validation = validateFetchProfile({ ...fetchProfile, prepareLoginRequired: false });
  assert.equal(validation.requestSemanticMatched, false);
  assert.equal(validation.remainingMismatchCategory, 'PREPARE_LOGIN_PREREQUISITE_MISSING');
});

const sessionEvents = [
  { direction: 'client-to-server', eventType: 'request', rpc: '.lq.Lobby.prepareLogin', requestId: 2, timestampMs: 1000, payloadSize: 10 },
  { direction: 'server-to-client', eventType: 'response', rpc: '.lq.Lobby.prepareLogin', requestId: 2, timestampMs: 1100, payloadSize: 8 },
  { direction: 'server-to-client', eventType: 'notify', rpc: '.lq.NotifyAccountUpdate', requestId: null, timestampMs: 1180, payloadSize: 12 },
  { direction: 'client-to-server', eventType: 'request', rpc: '.lq.Lobby.fetchGameRecord', requestId: 3, timestampMs: 1300, payloadSize: 20 }
];

test('HARタイムラインからprepareLoginとfetchGameRecord間を抽出する', () => {
  const profile = createSessionTimeline(sessionEvents);
  assert.equal(profile.prepareLoginToFetchDelayMs, 200);
  assert.equal(profile.events.length, 3);
  assert.equal(profile.requiredServerEvent, '.lq.NotifyAccountUpdate');
  assert.equal(profile.requestIdDeltaBeforeFetch, 1);
});

test('heartbeat・push・notify有無をHARイベントだけから判定する', () => {
  const heartbeatEvents = sessionEvents.toSpliced(2, 0, { direction: 'client-to-server', eventType: 'request', rpc: '.lq.Route.heartbeat', requestId: 3, timestampMs: 1150, payloadSize: 6 }).map((item) => item.rpc === '.lq.Lobby.fetchGameRecord' ? { ...item, requestId: 4 } : item);
  const profile = createSessionTimeline(heartbeatEvents);
  assert.equal(profile.heartbeatRequired, true);
  assert.equal(profile.requiredServerEvent, '.lq.NotifyAccountUpdate');
  assert.equal(profile.requestIdDeltaBeforeFetch, 2);
});

test('Session Timeline Schemaと待機上限を検証する', () => {
  const validation = validateSessionTimeline(createSessionTimeline(sessionEvents));
  assert.equal(validation.sessionTimelineProfileValid, true);
  assert.equal(safeDelayMs(999999), 3000);
});

test('旧SecretはSession Profileなしでも無効化しない', () => {
  const validation = validateSessionTimeline(undefined), plan = buildSessionRuntimePlan(validation);
  assert.equal(validation.sessionTimelineProfileValid, false);
  assert.deepEqual(plan.profile, legacySessionTimeline());
  assert.equal(plan.strategy, 'legacy-response-trigger');
  assert.equal(plan.blockedCode, null);
});

test('HARで確認されたheartbeatは送信値未確認なら安全に停止する', () => {
  const profile = { ...createSessionTimeline(sessionEvents), heartbeatRequired: true, requiredServerEvent: null };
  assert.equal(buildSessionRuntimePlan(validateSessionTimeline(profile)).blockedCode, 'HEARTBEAT_FAILED');
});

test('HARで確認された中間RPCは入力未確認なら安全に停止する', () => {
  const profile = { ...createSessionTimeline(sessionEvents), requiredIntermediateRpc: '.lq.Lobby.sessionInit', requiredServerEvent: null };
  assert.equal(buildSessionRuntimePlan(validateSessionTimeline(profile)).blockedCode, 'INTERMEDIATE_RPC_FAILED');
});

test('client contextの役割とRPC出所をProfileから維持する', () => {
  const credential = JSON.stringify({ flowVersion: 'route-prepare-login-v1', connectionType: 2, routeContextString: 'route-context', providerType: 21, prepareLoginToken: 'local-test-token', fetchGameRecordProfile: fetchProfile });
  const auth = parseAuthSecret({ MAJSOUL_OAUTH2_CREDENTIALS: credential });
  assert.equal(auth.fetchGameRecordProfile.clientVersionSourceRole, 'fetchGameRecordClientContext');
  assert.equal(auth.fetchGameRecordProfile.clientVersionSourceRpc, '.lq.Lobby.fetchGameRecord');
});

class MockWebSocket {
  static behavior = null;
  constructor() { this.listeners = new Map(); this.sent = []; queueMicrotask(() => this.emit('open', {})); }
  addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(listener); }
  emit(name, event) { for (const listener of this.listeners.get(name) || []) listener(event); }
  send(payload) { this.sent.push(payload); MockWebSocket.behavior?.(this, payload, this.sent.length - 1); }
  close() {}
}

async function withMockWebSocket(behavior, run) {
  const original = globalThis.WebSocket; globalThis.WebSocket = MockWebSocket; MockWebSocket.behavior = behavior;
  try { return await run(); } finally { globalThis.WebSocket = original; MockWebSocket.behavior = null; }
}
const mockPayload = (id) => new Uint8Array([2, id, 0]);
const mockResponse = (id) => new Uint8Array([3, id, 0, 0]);

test('Mock WebSocketはprepareLogin応答後の待機だけで次RPCへ進む', async () => {
  const before = [];
  const responses = await withMockWebSocket((socket, payload) => queueMicrotask(() => socket.emit('message', { data: mockResponse(payload[1]).buffer })), () => websocketRpcSequence('wss://example.test', [mockPayload(1), mockPayload(2), mockPayload(3)], 100, null, { beforeSend: async (index) => before.push(index) }));
  assert.equal(responses.length, 3); assert.deepEqual(before, [1, 2]);
});

test('Mock WebSocketのheartbeat戦略は確認済みhookだけを実行する', async () => {
  let heartbeatSent = false;
  await withMockWebSocket((socket, payload) => queueMicrotask(() => socket.emit('message', { data: mockResponse(payload[1]).buffer })), () => websocketRpcSequence('wss://example.test', [mockPayload(1), mockPayload(2), mockPayload(3)], 100, null, { beforeSend: async (index) => { if (index === 2) heartbeatSent = true; } }));
  assert.equal(heartbeatSent, true);
});

test('Mock WebSocketはserver pushを応答と混同せず観測する', async () => {
  let unmatched = 0;
  await withMockWebSocket((socket, payload, index) => queueMicrotask(() => { if (index === 1) socket.emit('message', { data: new Uint8Array([1, 10, 0]).buffer }); socket.emit('message', { data: mockResponse(payload[1]).buffer }); }), () => websocketRpcSequence('wss://example.test', [mockPayload(1), mockPayload(2), mockPayload(3)], 100, null, { onUnmatchedMessage: () => { unmatched += 1; } }));
  assert.equal(unmatched, 1);
});

test('Mock WebSocketは中間RPC hook後にfetchへ進む', async () => {
  const actions = [];
  await withMockWebSocket((socket, payload) => queueMicrotask(() => socket.emit('message', { data: mockResponse(payload[1]).buffer })), () => websocketRpcSequence('wss://example.test', [mockPayload(1), mockPayload(2), mockPayload(3)], 100, null, { beforeSend: async (index) => { if (index === 2) actions.push('intermediate'); } }));
  assert.deepEqual(actions, ['intermediate']);
});

test('Mock WebSocketは必須server event未受信エラーを伝播する', async () => {
  await assert.rejects(() => withMockWebSocket((socket, payload) => queueMicrotask(() => socket.emit('message', { data: mockResponse(payload[1]).buffer })), () => websocketRpcSequence('wss://example.test', [mockPayload(1), mockPayload(2), mockPayload(3)], 100, null, { beforeSend: async (index) => { if (index === 2) throw new Error('REQUIRED_SERVER_EVENT_NOT_RECEIVED'); } })), /REQUIRED_SERVER_EVENT_NOT_RECEIVED/);
});

test('Mock WebSocketはrequest ID不一致を無視して正しい応答を待つ', async () => {
  let unmatched = 0;
  const responses = await withMockWebSocket((socket, payload) => queueMicrotask(() => { socket.emit('message', { data: mockResponse(99).buffer }); socket.emit('message', { data: mockResponse(payload[1]).buffer }); }), () => websocketRpcSequence('wss://example.test', [mockPayload(1), mockPayload(2)], 100, null, { onUnmatchedMessage: () => { unmatched += 1; } }));
  assert.equal(responses.length, 2); assert.equal(unmatched, 2);
});

test('Mock WebSocketはfetch成功後もread/detailへ連続request IDで進む', async () => {
  const sentIds = [];
  const responses = await withMockWebSocket((socket, payload) => { sentIds.push(payload[1]); queueMicrotask(() => socket.emit('message', { data: mockResponse(payload[1]).buffer })); }, () => websocketRpcSequence('wss://example.test', [1, 2, 3, 4, 5].map(mockPayload), 100));
  assert.equal(responses.length, 5); assert.deepEqual(sentIds, [1, 2, 3, 4, 5]);
});

test('fetchGameRecordの1004はSession条件一致後の上流拒否として分類可能', () => {
  const failure = classifyRpcFailure('.lq.Lobby.fetchGameRecord', 1004);
  assert.equal(failure.stage, 'FETCH_GAME_RECORD'); assert.equal(failure.code, 'MAJSOUL_1004');
});

test('route context混入時は必ず具体的な残差カテゴリで停止する', () => {
  const validation = validateFetchProfile({ ...fetchProfile, fetchClientContext: 'jp-2', clientVersionIsRouteId: true, clientVersionValidated: false, clientVersionSemanticMatch: false });
  assert.equal(validation.requestSemanticMatched, false);
  assert.equal(validation.remainingMismatchCategory, 'ROUTE_CONTEXT_MIXED');
});

test('不正profileの残差カテゴリはnullにならない', () => {
  const validation = validateFetchProfile({ ...fetchProfile, field2SourceValidated: false });
  assert.equal(validation.requestSemanticMatched, false);
  assert.notEqual(validation.remainingMismatchCategory, null);
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
  const response = await worker.fetch(new Request('https://example.test/health'), { MAJSOUL_OAUTH2_CREDENTIALS: JSON.stringify({ flowVersion: 'route-prepare-login-v1', connectionType: 2, routeContextString: 'safe', providerType: 21, prepareLoginToken: 'never-return-this', fetchGameRecordProfile: fetchProfile }) });
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
