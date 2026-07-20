// v5.3.8: 共有スキーマでRPC構造とSession Timelineを検証し、認証値を表示せずSecretへ登録する。
import { spawnSync } from 'node:child_process';
import { createFetchProfile } from '../src/shared/fetch-profile-schema.js';
import { createSessionTimeline } from '../src/shared/session-timeline-schema.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const har = JSON.parse(Buffer.concat(chunks).toString('utf8'));

function readVarint(bytes, start) {
  let value = 0, shift = 0, offset = start, byte;
  do { if (offset >= bytes.length) throw new Error('invalid varint'); byte = bytes[offset++]; value += (byte & 0x7f) * (2 ** shift); shift += 7; } while (byte & 0x80);
  return { value, offset };
}
function fields(bytes) {
  const result = new Map(); let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset); offset = tag.offset;
    const id = tag.value >>> 3, wire = tag.value & 7; let value;
    if (wire === 0) { const item = readVarint(bytes, offset); value = item.value; offset = item.offset; }
    else if (wire === 2) { const size = readVarint(bytes, offset); offset = size.offset; value = bytes.subarray(offset, offset + size.value); offset += size.value; }
    else throw new Error('unsupported wire');
    if (!result.has(id)) result.set(id, []); result.get(id).push(value);
  }
  return result;
}
function fieldShape(bytes) {
  const result = []; let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset); offset = tag.offset;
    const field = tag.value >>> 3, wire = tag.value & 7; let value = null;
    if (wire === 0) { const item = readVarint(bytes, offset); offset = item.offset; }
    else if (wire === 2) { const size = readVarint(bytes, offset); offset = size.offset; value = bytes.subarray(offset, offset + size.value); offset += size.value; }
    else throw new Error('unsupported wire');
    result.push({ field, wire, value });
  }
  return result;
}
function candidates(data) {
  const list = [Buffer.from(data, 'base64'), Buffer.from(data, 'latin1')];
  if (/^(?:[0-9a-fA-F]{2}\s*)+$/.test(data)) list.push(Buffer.from(data.replace(/\s/g, ''), 'hex'));
  return list;
}

let sharedId = null;
for (const entry of har?.log?.entries || []) {
  try {
    const url = new URL(entry.request?.url || ''), hashQuery = url.hash.includes('?') ? url.hash.split('?')[1] : '';
    const value = url.searchParams.get('paipu') || new URLSearchParams(hashQuery).get('paipu');
    if (value) { sharedId = decodeURIComponent(value); break; }
  } catch (_) {}
}

let connection = null, prepareLogin = null, fetchGameRecordProfile = null;
const responseMatched = new Set();
for (const [connectionIndex, entry] of (har?.log?.entries || []).entries()) {
  const pending = new Map(), timelineEvents = [];
  for (const message of entry._webSocketMessages || entry.webSocketMessages || []) {
    if (typeof message.data !== 'string') continue;
    for (const bytes of candidates(message.data)) {
      try {
        const requestId = bytes[1] | (bytes[2] << 8);
        const timestampMs = Number.isFinite(Number(message.time)) ? Number(message.time) * 1000 : Date.parse(message.timestamp || entry.startedDateTime || '') || 0;
        if (bytes[0] === 3 && message.type === 'receive' && pending.has(requestId)) {
          timelineEvents.push({ direction: 'server-to-client', eventType: 'response', rpc: pending.get(requestId), requestId, timestampMs, payloadSize: Math.max(0, bytes.length - 3) });
          responseMatched.add(`${connectionIndex}:${pending.get(requestId)}`);
          pending.delete(requestId);
          break;
        }
        if (message.type === 'receive') {
          let rpc = null;
          try { const offset = bytes[0] === 1 ? 1 : 0, notifyEnvelope = fields(bytes.subarray(offset)); rpc = Buffer.from(notifyEnvelope.get(1)?.[0] || []).toString('utf8') || null; } catch (_) {}
          timelineEvents.push({ direction: 'server-to-client', eventType: bytes.length ? (rpc ? 'notify' : 'push') : 'empty', rpc, requestId: null, timestampMs, payloadSize: bytes.length });
          break;
        }
        if (bytes[0] !== 2 || message.type !== 'send') continue;
        const envelope = fields(bytes.subarray(3));
        const method = Buffer.from(envelope.get(1)?.[0] || []).toString('utf8');
        if (!method) continue;
        pending.set(requestId, method);
        timelineEvents.push({ direction: 'client-to-server', eventType: 'request', rpc: method, requestId, timestampMs, payloadSize: Math.max(0, bytes.length - 3) });
        const body = fields(envelope.get(2)?.[0] || Buffer.alloc(0));
        if (method === '.lq.Route.requestConnection') {
          const connectionType = body.get(2)?.[0], routeContextString = Buffer.from(body.get(3)?.[0] || []).toString('utf8');
          if (Number.isInteger(connectionType) && routeContextString) connection = { connectionType, routeContextString, connectionIndex };
        }
        if (method === '.lq.Lobby.prepareLogin' && connection?.connectionIndex === connectionIndex) {
          const prepareLoginToken = Buffer.from(body.get(1)?.[0] || []).toString('utf8'), providerType = body.get(2)?.[0];
          if (prepareLoginToken && Number.isInteger(providerType)) prepareLogin = { prepareLoginToken, providerType, connectionIndex };
        }
        if (method === '.lq.Lobby.fetchGameRecord' && connection && prepareLogin?.connectionIndex === connectionIndex && connection.connectionIndex === connectionIndex) {
          const envelopeShape = fieldShape(bytes.subarray(3)), bodyBytes = envelope.get(2)?.[0] || Buffer.alloc(0), requestShape = fieldShape(bodyBytes);
          const fetchClientContext = Buffer.from(requestShape.find((item) => item.field === 2)?.value || []).toString('utf8');
          const clientVersionIsRouteId = /^jp-\d+$/i.test(fetchClientContext);
          const clientVersionValidated = Boolean(fetchClientContext) && !fetchClientContext.includes('\uFFFD') && !clientVersionIsRouteId;
          const requestFields = requestShape.map((item) => {
            if (item.wire !== 2) return { field: item.field, wire: item.wire, source: 'unsupported' };
            const value = Buffer.from(item.value || []);
            if (sharedId && value.equals(Buffer.from(sharedId, 'utf8'))) return { field: item.field, wire: item.wire, source: 'completePaipuId' };
            if (item.field === 1) return { field: item.field, wire: item.wire, source: 'completePaipuId' };
            if (item.field === 2 && clientVersionValidated) return { field: item.field, wire: item.wire, source: 'fetchClientContext' };
            return { field: item.field, wire: item.wire, source: 'unconfirmed' };
          });
          const envelopeFields = envelopeShape.map((item) => ({ field: item.field, wire: item.wire }));
          const validated = method === '.lq.Lobby.fetchGameRecord' && envelopeFields.map((item) => `${item.field}:${item.wire}`).join(',') === '1:2,2:2' && requestFields.map((item) => `${item.field}:${item.wire}`).join(',') === '1:2,2:2' && requestFields.every((item) => item.source === 'completePaipuId' || item.source === 'fetchClientContext');
          if (validated && clientVersionValidated && !clientVersionIsRouteId) fetchGameRecordProfile = createFetchProfile({ messageType: method, envelopeFields, requestFields, fetchClientContext, sourceConnectionIndex: connectionIndex, sourceMetadata: [{ sourceRpc: method, sourceDirection: 'request', sourceFieldNumber: 1, sourceMessageType: 'fetchGameRecordRequest', sourceConnectionIndex: connectionIndex, valueRole: 'completePaipuId' }, { sourceRpc: method, sourceDirection: 'request', sourceFieldNumber: 2, sourceMessageType: 'fetchGameRecordRequest', sourceConnectionIndex: connectionIndex, valueRole: 'fetchClientContext' }] });
        }
        break;
      } catch (_) { /* 候補形式が違う場合は次を試す。認証値は出力しない。 */ }
    }
  }
  const sessionTimeline = createSessionTimeline(timelineEvents);
  if (fetchGameRecordProfile && fetchGameRecordProfile.sourceConnectionIndex === connectionIndex && sessionTimeline) fetchGameRecordProfile.sessionTimeline = sessionTimeline;
}
const responseSequenceMatched = connection && prepareLogin && fetchGameRecordProfile && ['.lq.Route.requestConnection', '.lq.Lobby.prepareLogin', '.lq.Lobby.fetchGameRecord'].every((rpc) => responseMatched.has(`${connection.connectionIndex}:${rpc}`));
if (!connection || !prepareLogin || !fetchGameRecordProfile?.validated || !responseSequenceMatched) {
  console.error('現行requestConnection/prepareLogin/fetchGameRecordを完全検証できませんでした。牌譜表示操作を含むgateway通信のHARをコピーしてください。');
  process.exit(2);
}
let credential = { flowVersion: 'route-prepare-login-v1', connectionType: connection.connectionType, routeContextString: connection.routeContextString, providerType: prepareLogin.providerType, prepareLoginToken: prepareLogin.prepareLoginToken, fetchGameRecordProfile };
const result = spawnSync('npx', ['wrangler', 'secret', 'put', 'MAJSOUL_OAUTH2_CREDENTIALS'], {
  cwd: new URL('..', import.meta.url), input: JSON.stringify(credential) + '\n', encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit']
});
credential = null;
if (result.status !== 0) process.exit(result.status || 1);
console.log('認証値を表示せず、HAR完全一致済みfetchGameRecord構造とMAJSOUL_OAUTH2_CREDENTIALSを登録しました。');
