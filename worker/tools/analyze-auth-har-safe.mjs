// v5.3.2: 現行HARから認証値を出さず、RPC順序・protobuf wire型・公開バージョン情報だけを抽出する。
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let har;
try { har = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
catch (_) { console.error('HAR_JSON_INVALID'); process.exit(2); }

function readVarint(bytes, start) {
  let value = 0, shift = 0, offset = start, byte;
  do { if (offset >= bytes.length || shift > 49) throw new Error('invalid varint'); byte = bytes[offset++]; value += (byte & 0x7f) * (2 ** shift); shift += 7; } while (byte & 0x80);
  return { value, offset };
}
function parseFields(bytes) {
  const items = []; let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset); offset = tag.offset;
    const id = tag.value >>> 3, wire = tag.value & 7; let value;
    if (wire === 0) { const item = readVarint(bytes, offset); value = item.value; offset = item.offset; }
    else if (wire === 1) { value = bytes.subarray(offset, offset + 8); offset += 8; }
    else if (wire === 2) { const size = readVarint(bytes, offset); offset = size.offset; value = bytes.subarray(offset, offset + size.value); offset += size.value; }
    else if (wire === 5) { value = bytes.subarray(offset, offset + 4); offset += 4; }
    else throw new Error('unsupported wire');
    items.push({ id, wire, value });
  }
  return items;
}
function first(items, id) { return items.find((item) => item.id === id); }
function decodeCandidates(data) {
  const list = [Buffer.from(data, 'base64'), Buffer.from(data, 'latin1')];
  if (/^(?:[0-9a-fA-F]{2}\s*)+$/.test(data)) list.push(Buffer.from(data.replace(/\s/g, ''), 'hex'));
  return list;
}
function wireName(wire) { return ({ 0: 'varint', 1: 'fixed64', 2: 'length-delimited', 5: 'fixed32' })[wire] || 'unknown'; }
function safeNestedShape(bytes) {
  try { return parseFields(bytes).map((item) => ({ field: item.id, type: wireName(item.wire) })); }
  catch (_) { return []; }
}
function safeVersionShape(bytes) {
  try {
    return parseFields(bytes).map((item) => {
      const text = item.wire === 2 ? Buffer.from(item.value).toString('utf8') : '';
      return { field: item.id, type: wireName(item.wire), value: /^[A-Za-z0-9._-]{1,80}$/.test(text) ? text : '[REDACTED]' };
    });
  } catch (_) { return []; }
}

const rpcSequence = [], oauthRequests = [];
for (const entry of har?.log?.entries || []) {
  for (const message of entry._webSocketMessages || entry.webSocketMessages || []) {
    if (message.type !== 'send' || typeof message.data !== 'string') continue;
    for (const bytes of decodeCandidates(message.data)) {
      try {
        if (bytes[0] !== 2) continue;
        const envelope = parseFields(bytes.subarray(3));
        const methodItem = first(envelope, 1), bodyItem = first(envelope, 2);
        if (!methodItem || methodItem.wire !== 2 || !bodyItem || bodyItem.wire !== 2) continue;
        const method = Buffer.from(methodItem.value).toString('utf8');
        if (!/^\.lq\.[A-Za-z0-9_.]+$/.test(method)) continue;
        rpcSequence.push(method);
        if (!/oauth|login|auth|requestConnection/i.test(method)) break;
        const body = parseFields(bodyItem.value);
        const shape = body.map((item) => ({ field: item.id, type: wireName(item.wire), count: body.filter((candidate) => candidate.id === item.id).length })).filter((item, index, all) => all.findIndex((candidate) => candidate.field === item.field) === index);
        const request = { rpc: method, fields: shape };
        if (method === '.lq.Lobby.oauth2Check' || method === '.lq.Lobby.oauth2Login') {
          const typeItem = first(body, 1), reconnectItem = first(body, 3), deviceItem = first(body, 4), versionItem = first(body, 6);
          request.safeValues = { type: typeItem && typeItem.wire === 0 ? typeItem.value : null, reconnect: reconnectItem && reconnectItem.wire === 0 ? Boolean(reconnectItem.value) : null, deviceShape: deviceItem && deviceItem.wire === 2 ? safeNestedShape(deviceItem.value) : [], clientVersionShape: versionItem && versionItem.wire === 2 ? safeVersionShape(versionItem.value) : [], repeatedVarints: body.filter((item) => item.wire === 0 && item.id > 3).map((item) => ({ field: item.id, value: item.value })) };
        }
        if (method === '.lq.Route.requestConnection' || method === '.lq.Lobby.prepareLogin') request.safeValues = { varints: body.filter((item) => item.wire === 0).map((item) => ({ field: item.id, value: item.value })), lengthDelimited: body.filter((item) => item.wire === 2).map((item) => ({ field: item.id, nestedShape: safeNestedShape(item.value), value: '[REDACTED]' })) };
        oauthRequests.push(request);
        break;
      } catch (_) { /* 候補形式違い。認証値は表示しない。 */ }
    }
  }
}
console.log(JSON.stringify({ evidence: 'current Chrome sanitized HAR', rpcSequence: [...new Set(rpcSequence)], oauthRequests }, null, 2));
if (!oauthRequests.length) process.exitCode = 3;
