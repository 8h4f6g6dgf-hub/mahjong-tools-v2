// v5.3.3: 共有URLから牌譜表示までのHARを、認証値やPayloadを出さずRPC時系列へ変換する。
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let har;
try { har = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
catch (_) { console.error('HAR_JSON_INVALID: Copy all listed as HAR (sanitized) をコピーしてください。'); process.exit(2); }

function readVarint(bytes, start) {
  let value = 0, shift = 0, offset = start, byte;
  do { if (offset >= bytes.length || shift > 49) throw new Error('invalid varint'); byte = bytes[offset++]; value += (byte & 0x7f) * (2 ** shift); shift += 7; } while (byte & 0x80);
  return { value, offset };
}

function fields(bytes) {
  const result = []; let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset); offset = tag.offset;
    const field = tag.value >>> 3, wire = tag.value & 7; let value;
    if (wire === 0) { const item = readVarint(bytes, offset); value = item.value; offset = item.offset; }
    else if (wire === 1) { value = bytes.subarray(offset, offset + 8); offset += 8; }
    else if (wire === 2) { const size = readVarint(bytes, offset); offset = size.offset; value = bytes.subarray(offset, offset + size.value); offset += size.value; }
    else if (wire === 5) { value = bytes.subarray(offset, offset + 4); offset += 4; }
    else throw new Error('unsupported wire');
    if (!field || offset > bytes.length) throw new Error('invalid field');
    result.push({ field, wire, value });
  }
  return result;
}

function first(items, field) { return items.find((item) => item.field === field)?.value; }
function text(bytes) { try { return Buffer.from(bytes || []).toString('utf8'); } catch (_) { return ''; } }
function wireName(wire) { return ({ 0: 'varint', 1: 'fixed64', 2: 'length-delimited', 5: 'fixed32' })[wire] || 'unknown'; }
function candidates(data) {
  const result = [Buffer.from(data, 'base64'), Buffer.from(data, 'latin1')];
  if (/^(?:[0-9a-fA-F]{2}\s*)+$/.test(data)) result.push(Buffer.from(data.replace(/\s/g, ''), 'hex'));
  return result;
}

let sharedId = null;
for (const entry of har?.log?.entries || []) {
  try {
    const url = new URL(entry.request?.url || '');
    const value = url.searchParams.get('paipu') || new URLSearchParams(url.hash.includes('?') ? url.hash.split('?')[1] : '').get('paipu');
    if (value) { sharedId = decodeURIComponent(value); break; }
  } catch (_) {}
}
const sharedUuid = sharedId ? sharedId.split('_')[0] : null;

function classifyLengthValue(bytes) {
  const value = text(bytes);
  if (sharedId && value === sharedId) return { inputType: 'completePaipuId', inputSource: 'sharedUrl' };
  if (sharedUuid && value === sharedUuid) return { inputType: 'paipuUuid', inputSource: 'sharedUrl' };
  return { inputType: 'opaque', inputSource: 'redacted' };
}
const opaqueRefs = new Map();
function opaqueRef(bytes) {
  const key = Buffer.from(bytes).toString('base64');
  if (!opaqueRefs.has(key)) opaqueRefs.set(key, 'opaque-' + (opaqueRefs.size + 1));
  return opaqueRefs.get(key);
}
function safeShape(items, classify = false) {
  return items.map((item) => {
    const classified = classify && item.wire === 2 ? classifyLengthValue(item.value) : null;
    return { field: item.field, wireType: wireName(item.wire), ...(classified || {}), ...(item.wire === 2 ? { valueRef: opaqueRef(item.value) } : {}) };
  });
}

const timeline = [], pending = new Map(); let order = 0;
for (const entry of har?.log?.entries || []) {
  for (const message of entry._webSocketMessages || entry.webSocketMessages || []) {
    if (typeof message.data !== 'string') continue;
    for (const bytes of candidates(message.data)) {
      try {
        if (bytes.length < 4 || (bytes[0] !== 2 && bytes[0] !== 3)) continue;
        const requestId = bytes[1] | (bytes[2] << 8), envelope = fields(bytes.subarray(3));
        if (bytes[0] === 2 && message.type === 'send') {
          const rpc = text(first(envelope, 1)); if (!/^\.lq\./.test(rpc)) continue;
          const body = fields(first(envelope, 2) || Buffer.alloc(0));
          const item = { order: ++order, rpc, envelopeFields: safeShape(envelope, false).map(({ field, wireType }) => ({ field, wireType })), inputFields: safeShape(body, true), outputFields: [], responseReceived: false };
          timeline.push(item); pending.set(requestId, item); break;
        }
        if (bytes[0] === 3 && message.type === 'receive' && pending.has(requestId)) {
          const item = pending.get(requestId), body = fields(first(envelope, 2) || Buffer.alloc(0));
          item.outputFields = safeShape(body, false); item.responseReceived = true; pending.delete(requestId); break;
        }
      } catch (_) { /* DevToolsの表現候補が違う場合は次を試す。値は出力しない。 */ }
    }
  }
}

const sequence = timeline.map((item) => item.rpc);
const recordCandidates = timeline.filter((item) => /(record|paipu|game|resolve|lookup)/i.test(item.rpc));
const fetchItem = timeline.find((item) => item.rpc === '.lq.Lobby.fetchGameRecord');
const fetchIdField = fetchItem?.inputFields.find((item) => item.inputType === 'completePaipuId' || item.inputType === 'paipuUuid');
const connectionItem = timeline.find((item) => item.rpc === '.lq.Route.requestConnection');
const actualEnvelopeShape = (fetchItem?.envelopeFields || []).map((item) => `${item.field}:${item.wireType}`).join(','), expectedEnvelopeShape = '1:length-delimited,2:length-delimited';
const actualFieldShape = (fetchItem?.inputFields || []).map((item) => `${item.field}:${item.wireType}`).join(','), expectedFieldShape = '1:length-delimited,2:length-delimited';
const fetchVersionRef = fetchItem?.inputFields.find((item) => item.field === 2)?.valueRef, connectionVersionRef = connectionItem?.inputFields.find((item) => item.field === 3)?.valueRef;
const messageMatchScore = fetchItem?.rpc === '.lq.Lobby.fetchGameRecord' ? 100 : 0;
const envelopeMatchScore = actualEnvelopeShape === expectedEnvelopeShape ? 100 : 0;
const fieldMatchScore = actualFieldShape === expectedFieldShape && fetchIdField?.inputType === 'completePaipuId' && fetchVersionRef && fetchVersionRef === connectionVersionRef ? 100 : 0;
const requestMatchScore = Math.round((messageMatchScore + envelopeMatchScore + fieldMatchScore) / 3);
const safe = {
  evidence: 'current Chrome sanitized HAR',
  sharedUrlPaipuIdDetected: Boolean(sharedId),
  confirmedRpcCount: timeline.length,
  rpcSequence: sequence,
  rpcTimeline: timeline,
  recordResolveCandidates: recordCandidates.map((item) => ({ order: item.order, rpc: item.rpc })),
  recordResolveReached: recordCandidates.some((item) => item.rpc !== '.lq.Lobby.fetchGameRecord'),
  fetchGameRecordReached: Boolean(fetchItem),
  fetchGameRecordInputType: fetchIdField?.inputType || 'unconfirmed',
  fetchGameRecordInputSource: fetchIdField?.inputSource || 'unconfirmed',
  requestMatchScore,
  envelopeMatchScore,
  fieldMatchScore,
  messageMatchScore,
  requestFullyMatched: requestMatchScore === 100,
  responseFullyMatched: Boolean(fetchItem?.responseReceived),
  harCompared: Boolean(fetchItem),
  fetchGameRecordRequestValidated: requestMatchScore === 100,
  nextRpc: fetchItem ? sequence[sequence.indexOf(fetchItem.rpc) + 1] || null : null
};
if (process.argv.includes('--focus')) {
  const recordOrders = recordCandidates.map((item) => item.order);
  const from = recordOrders.length ? Math.max(1, Math.min(...recordOrders) - 3) : 1;
  const to = recordOrders.length ? Math.max(...recordOrders) + 3 : timeline.length;
  console.log(JSON.stringify({
    evidence: safe.evidence,
    confirmedRpcCount: safe.confirmedRpcCount,
    rpcSequenceWithoutHeartbeat: timeline.filter((item) => item.rpc !== '.lq.Route.heartbeat').map((item) => ({ order: item.order, rpc: item.rpc })),
    recordWindow: timeline.filter((item) => item.order >= from && item.order <= to),
    recordResolveCandidates: safe.recordResolveCandidates,
    recordResolveReached: safe.recordResolveReached,
    fetchGameRecordReached: safe.fetchGameRecordReached,
    fetchGameRecordInputType: safe.fetchGameRecordInputType,
    fetchGameRecordInputSource: safe.fetchGameRecordInputSource,
    requestMatchScore: safe.requestMatchScore,
    envelopeMatchScore: safe.envelopeMatchScore,
    fieldMatchScore: safe.fieldMatchScore,
    messageMatchScore: safe.messageMatchScore,
    requestFullyMatched: safe.requestFullyMatched,
    responseFullyMatched: safe.responseFullyMatched,
    harCompared: safe.harCompared,
    fetchGameRecordRequestValidated: safe.fetchGameRecordRequestValidated,
    nextRpc: safe.nextRpc
  }, null, 2));
} else console.log(JSON.stringify(safe, null, 2));
