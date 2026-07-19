// v5.3.1: 現行WebSocketのOAuth送信値を第三者へ送らず、端末内のクリップボードだけへ渡す。
// Chrome DevTools Consoleで実行後、Networkを一度Offline→Onlineにして再接続させる。
(() => {
  const originalSend = WebSocket.prototype.send;
  const decoder = new TextDecoder();
  const readVarint = (bytes, start) => {
    let value = 0, shift = 0, offset = start, byte;
    do { byte = bytes[offset++]; value += (byte & 0x7f) * (2 ** shift); shift += 7; } while (byte & 0x80);
    return { value, offset };
  };
  const fields = (bytes) => {
    const result = new Map(); let offset = 0;
    while (offset < bytes.length) {
      const tag = readVarint(bytes, offset); offset = tag.offset;
      const id = tag.value >>> 3, wire = tag.value & 7; let value;
      if (wire === 0) { const item = readVarint(bytes, offset); value = item.value; offset = item.offset; }
      else if (wire === 2) { const size = readVarint(bytes, offset); offset = size.offset; value = bytes.slice(offset, offset + size.value); offset += size.value; }
      else return new Map();
      if (!result.has(id)) result.set(id, []); result.get(id).push(value);
    }
    return result;
  };
  WebSocket.prototype.send = function (data) {
    try {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      if (bytes && bytes[0] === 2) {
        const envelope = fields(bytes.slice(3));
        const methodBytes = envelope.get(1)?.[0], bodyBytes = envelope.get(2)?.[0];
        const method = methodBytes ? decoder.decode(methodBytes) : '';
        if (bodyBytes && (method === '.lq.Lobby.oauth2Login' || method === '.lq.Lobby.oauth2Check')) {
          const body = fields(bodyBytes), type = body.get(1)?.[0], tokenBytes = body.get(2)?.[0];
          if (Number.isInteger(type) && tokenBytes instanceof Uint8Array) {
            const secret = JSON.stringify({ type, accessToken: decoder.decode(tokenBytes) });
            if (typeof copy === 'function') copy(secret); else navigator.clipboard.writeText(secret);
            WebSocket.prototype.send = originalSend;
            alert('認証Secretを端末内のクリップボードへコピーしました（認証RPC確認済み）。チャットへ貼らず、wrangler secret put の入力欄へ直接貼り付けてください。');
          }
        }
      }
    } catch (_) { /* 認証値をConsoleへ出さないため、解析失敗も無出力にする。 */ }
    return originalSend.call(this, data);
  };
  alert('安全な取得準備ができました。NetworkをOffline→Onlineにして雀魂を再接続してください。');
})();
