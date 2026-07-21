// v5.3.8: 認証済みHARからfetchGameRecord構造とSession Timelineを安全に登録する。
import { spawnSync } from 'node:child_process';
import { createFetchProfile } from '../src/shared/fetch-profile-schema.js';
import { createSessionTimeline } from '../src/shared/session-timeline-schema.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let har;
try { har = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
catch (_) { console.error('HAR_JSON_INVALID: HAR (sanitized) をコピーし直してください。'); process.exit(2); }

function readVarint(bytes, start) {
  let value = 0, shift = 0, offset = start, byte;
  do { if (offset >= bytes.length) throw new Error('invalid varint'); byte = bytes[offset++]; value += (byte & 0x7f) * (2 ** shift); shift += 7; } while (byte & 0x80);
  return { value, offset };
}
function fields(bytes) {
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

let profile = null, fetchResponseReceived = false;
for (const [connectionIndex, entry] of (har?.log?.entries || []).entries()) {
  const pendingFetchIds = new Set(), pendingRpc = new Map(), timelineEvents = [];
  for (const message of entry._webSocketMessages || entry.webSocketMessages || []) {
    if (typeof message.data !== 'string') continue;
    for (const bytes of candidates(message.data)) {
      try {
        const requestId = bytes[1] | (bytes[2] << 8);
        const timestampMs = Number.isFinite(Number(message.time)) ? Number(message.time) * 1000 : Date.parse(message.timestamp || entry.startedDateTime || '') || 0;
        if (bytes[0] === 3 && message.type === 'receive') {
          const rpc = pendingRpc.get(requestId) || null;
          timelineEvents.push({ direction: 'server-to-client', eventType: 'response', rpc, requestId, timestampMs, payloadSize: Math.max(0, bytes.length - 3) });
          if (pendingFetchIds.has(requestId)) fetchResponseReceived = true;
          pendingRpc.delete(requestId);
          break;
        }
        if (message.type === 'receive') {
          let rpc = null; try { rpc = Buffer.from(fields(bytes.subarray(bytes[0] === 1 ? 1 : 0)).find((item) => item.field === 1)?.value || []).toString('utf8') || null; } catch (_) {}
          timelineEvents.push({ direction: 'server-to-client', eventType: bytes.length ? (rpc ? 'notify' : 'push') : 'empty', rpc, requestId: null, timestampMs, payloadSize: bytes.length });
          break;
        }
        if (bytes[0] !== 2 || message.type !== 'send') continue;
        const envelope = fields(bytes.subarray(3));
        const method = Buffer.from(envelope.find((item) => item.field === 1)?.value || []).toString('utf8');
        if (!method) continue;
        pendingRpc.set(requestId, method);
        timelineEvents.push({ direction: 'client-to-server', eventType: 'request', rpc: method, requestId, timestampMs, payloadSize: Math.max(0, bytes.length - 3) });
        if (method !== '.lq.Lobby.fetchGameRecord') break;
        pendingFetchIds.add(requestId);
        const body = fields(envelope.find((item) => item.field === 2)?.value || Buffer.alloc(0));
        const envelopeFields = envelope.map(({ field, wire }) => ({ field, wire }));
        const bodyFields = body.map(({ field, wire }) => ({ field, wire }));
        const envelopeMatched = envelopeFields.map((item) => `${item.field}:${item.wire}`).join(',') === '1:2,2:2';
        const fieldsMatched = bodyFields.map((item) => `${item.field}:${item.wire}`).join(',') === '1:2,2:2';
        const fetchClientContext = Buffer.from(body.find((item) => item.field === 2)?.value || []).toString('utf8');
        const clientVersionIsRouteId = /^jp-\d+$/i.test(fetchClientContext);
        const clientVersionValidated = Boolean(fetchClientContext) && !fetchClientContext.includes('\uFFFD') && !clientVersionIsRouteId;
        if (envelopeMatched && fieldsMatched && clientVersionValidated) profile = createFetchProfile({
          messageType: method, envelopeFields,
          requestFields: [{ field: 1, wire: 2, source: 'completePaipuId' }, { field: 2, wire: 2, source: 'fetchClientContext' }],
          fetchClientContext, sourceConnectionIndex: connectionIndex,
          sourceMetadata: [
            { sourceRpc: method, sourceDirection: 'request', sourceFieldNumber: 1, sourceMessageType: 'fetchGameRecordRequest', sourceConnectionIndex: connectionIndex, valueRole: 'completePaipuId' },
            { sourceRpc: method, sourceDirection: 'request', sourceFieldNumber: 2, sourceMessageType: 'fetchGameRecordRequest', sourceConnectionIndex: connectionIndex, valueRole: 'fetchClientContext' }
          ], sessionTimeline: null,
          // v5.3.9: 値を保存せず、HAR requestの長さとfield構造だけをBinary比較基準にする。
          binaryProfile: { requestLength: bytes.length, payloadLength: body.length, envelopeFieldOrder: envelopeFields.map((item) => `${item.field}:${item.wire}`), bodyFieldOrder: requestFields.map((item) => `${item.field}:${item.wire}`), unknownFieldCount: requestFields.filter((item) => ![1, 2].includes(item.field)).length, validated: true }
        });
        break;
      } catch (_) { /* 別表現の候補は無視し、認証値やPayloadは出力しない。 */ }
    }
  }
  const sessionTimeline = createSessionTimeline(timelineEvents);
  if (profile && profile.sourceConnectionIndex === connectionIndex && sessionTimeline) profile.sessionTimeline = sessionTimeline;
}

if (!profile || !fetchResponseReceived) {
  console.error('FETCH_PROFILE_NOT_FOUND: 牌譜表示中のgateway通信を含むHARをコピーしてください。');
  process.exit(2);
}
const result = spawnSync('npx', ['wrangler', 'secret', 'put', 'MAJSOUL_FETCH_GAME_RECORD_PROFILE'], {
  cwd: new URL('..', import.meta.url), input: JSON.stringify(profile) + '\n', encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit']
});
profile = null;
if (result.status !== 0) process.exit(result.status || 1);
console.log('fetchGameRecordの構造と意味検証済みclient contextを安全に登録しました。既存の認証Secretは変更していません。');
