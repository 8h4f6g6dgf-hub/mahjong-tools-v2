// v5.3.5: 認証済みセッションのHARからfetchGameRecord構造だけを安全に別Secretへ登録する。
import { spawnSync } from 'node:child_process';

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

let profile = null;
for (const entry of har?.log?.entries || []) {
  for (const message of entry._webSocketMessages || entry.webSocketMessages || []) {
    if (message.type !== 'send' || typeof message.data !== 'string') continue;
    for (const bytes of candidates(message.data)) {
      try {
        if (bytes[0] !== 2) continue;
        const envelope = fields(bytes.subarray(3));
        const method = Buffer.from(envelope.find((item) => item.field === 1)?.value || []).toString('utf8');
        if (method !== '.lq.Lobby.fetchGameRecord') continue;
        const body = fields(envelope.find((item) => item.field === 2)?.value || Buffer.alloc(0));
        const envelopeFields = envelope.map(({ field, wire }) => ({ field, wire }));
        const bodyFields = body.map(({ field, wire }) => ({ field, wire }));
        const envelopeMatched = envelopeFields.map((item) => `${item.field}:${item.wire}`).join(',') === '1:2,2:2';
        const fieldsMatched = bodyFields.map((item) => `${item.field}:${item.wire}`).join(',') === '1:2,2:2';
        if (envelopeMatched && fieldsMatched) profile = {
          version: 'current-har-v1', messageType: method, envelopeFields,
          // 現行実HARで確認済みのfield対応。値そのものはSecretへ保存しない。
          requestFields: [{ field: 1, wire: 2, source: 'completePaipuId' }, { field: 2, wire: 2, source: 'clientVersionString' }],
          validated: true
        };
      } catch (_) { /* 別表現の候補は無視し、認証値やPayloadは出力しない。 */ }
    }
  }
}

if (!profile) {
  console.error('FETCH_PROFILE_NOT_FOUND: 牌譜表示中のgateway通信を含むHARをコピーしてください。');
  process.exit(2);
}
const result = spawnSync('npx', ['wrangler', 'secret', 'put', 'MAJSOUL_FETCH_GAME_RECORD_PROFILE'], {
  cwd: new URL('..', import.meta.url), input: JSON.stringify(profile) + '\n', encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit']
});
profile = null;
if (result.status !== 0) process.exit(result.status || 1);
console.log('fetchGameRecord構造だけを安全に登録しました。既存の認証Secretは変更していません。');
