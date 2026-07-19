// v5.3.5: 認証値とfetchGameRecordの安全なHAR構造を表示せずWorker Secretへ直接登録する。
import { spawnSync } from 'node:child_process';

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
for (const entry of har?.log?.entries || []) {
  for (const message of entry._webSocketMessages || entry.webSocketMessages || []) {
    if (message.type !== 'send' || typeof message.data !== 'string') continue;
    for (const bytes of candidates(message.data)) {
      try {
        if (bytes[0] !== 2) continue;
        const envelope = fields(bytes.subarray(3));
        const method = Buffer.from(envelope.get(1)?.[0] || []).toString('utf8');
        const body = fields(envelope.get(2)?.[0] || Buffer.alloc(0));
        if (method === '.lq.Route.requestConnection') {
          const connectionType = body.get(2)?.[0], clientVersionString = Buffer.from(body.get(3)?.[0] || []).toString('utf8');
          if (Number.isInteger(connectionType) && clientVersionString) connection = { connectionType, clientVersionString };
        }
        if (method === '.lq.Lobby.prepareLogin') {
          const prepareLoginToken = Buffer.from(body.get(1)?.[0] || []).toString('utf8'), providerType = body.get(2)?.[0];
          if (prepareLoginToken && Number.isInteger(providerType)) prepareLogin = { prepareLoginToken, providerType };
        }
        if (method === '.lq.Lobby.fetchGameRecord' && connection && sharedId) {
          const envelopeShape = fieldShape(bytes.subarray(3)), bodyBytes = envelope.get(2)?.[0] || Buffer.alloc(0), requestShape = fieldShape(bodyBytes);
          const requestFields = requestShape.map((item) => {
            if (item.wire !== 2) return { field: item.field, wire: item.wire, source: 'unsupported' };
            const value = Buffer.from(item.value || []);
            if (value.equals(Buffer.from(sharedId, 'utf8'))) return { field: item.field, wire: item.wire, source: 'completePaipuId' };
            if (value.equals(Buffer.from(connection.clientVersionString, 'utf8'))) return { field: item.field, wire: item.wire, source: 'clientVersionString' };
            return { field: item.field, wire: item.wire, source: 'unconfirmed' };
          });
          const envelopeFields = envelopeShape.map((item) => ({ field: item.field, wire: item.wire }));
          const validated = method === '.lq.Lobby.fetchGameRecord' && envelopeFields.map((item) => `${item.field}:${item.wire}`).join(',') === '1:2,2:2' && requestFields.length > 0 && requestFields.every((item) => item.source === 'completePaipuId' || item.source === 'clientVersionString');
          fetchGameRecordProfile = { version: 'current-har-v1', messageType: method, envelopeFields, requestFields, validated };
        }
      } catch (_) { /* 候補形式が違う場合は次を試す。認証値は出力しない。 */ }
    }
  }
}
if (!connection || !prepareLogin || !fetchGameRecordProfile?.validated) {
  console.error('現行requestConnection/prepareLogin/fetchGameRecordを完全検証できませんでした。共有URLのDocumentとgateway通信を含むHARをコピーしてください。');
  process.exit(2);
}
let credential = { flowVersion: 'route-prepare-login-v1', ...connection, ...prepareLogin, fetchGameRecordProfile };
const result = spawnSync('npx', ['wrangler', 'secret', 'put', 'MAJSOUL_OAUTH2_CREDENTIALS'], {
  cwd: new URL('..', import.meta.url), input: JSON.stringify(credential) + '\n', encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit']
});
credential = null;
if (result.status !== 0) process.exit(result.status || 1);
console.log('認証値を表示せず、HAR完全一致済みfetchGameRecord構造とMAJSOUL_OAUTH2_CREDENTIALSを登録しました。');
