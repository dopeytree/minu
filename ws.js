// A tiny GraphQL subscription client (graphql-transport-ws over a raw TLS
// socket), so the server can read Unraid's live container stats without any
// dependencies. Self-signed certificates are accepted for the configured host.
import tls from 'node:tls';
import net from 'node:net';
import crypto from 'node:crypto';

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = crypto.randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

export function subscribe({ url, apiKey, query, onData, onState = () => {} }) {
  const u = new URL(url);
  let sock = null;
  let stopped = false;
  let retry = 0;
  let timer = null;

  function connect() {
    if (stopped) return;
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let frag = null;
    let pinger = null;
    const s = tls.connect({
      host: u.hostname,
      port: Number(u.port) || 443,
      servername: net.isIP(u.hostname) ? undefined : u.hostname,
      rejectUnauthorized: false,
    });
    sock = s;
    s.setTimeout(60000);
    s.on('timeout', () => s.destroy());
    s.on('error', () => {});

    const send = (obj) => {
      if (!s.destroyed) s.write(frame(1, Buffer.from(JSON.stringify(obj))));
    };

    const handle = (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.type === 'connection_ack') {
        retry = 0;
        send({ id: '1', type: 'subscribe', payload: { query } });
        onState('live');
      } else if (msg.type === 'next') {
        const p = msg.payload || {};
        if (p.data) onData(p.data);
        else if (p.errors && p.errors[0]) onState('error', String(p.errors[0].message || 'error'));
      } else if (msg.type === 'error') {
        const first = Array.isArray(msg.payload) ? msg.payload[0] : msg.payload;
        onState('error', String((first && first.message) || 'error'));
      } else if (msg.type === 'ping') {
        send({ type: 'pong' });
      } else if (msg.type === 'complete') {
        s.destroy();
      }
    };

    s.once('secureConnect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      s.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n`
        + `Host: ${u.host}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${key}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n'
        + 'Sec-WebSocket-Protocol: graphql-transport-ws\r\n'
        + `Origin: ${u.origin}\r\n`
        + `x-api-key: ${apiKey}\r\n\r\n`,
      );
    });

    s.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString('latin1');
        buf = buf.subarray(end + 4);
        if (!/^HTTP\/1\.1 101/.test(head)) {
          onState('refused', head.split('\r\n')[0]);
          s.destroy();
          return;
        }
        upgraded = true;
        send({ type: 'connection_init', payload: { 'x-api-key': apiKey } });
        pinger = setInterval(() => send({ type: 'ping' }), 20000);
      }
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1];
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const masked = (b1 & 0x80) !== 0;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        let payload = buf.subarray(off, off + len);
        if (masked) {
          const m = buf.subarray(off - 4, off);
          payload = Buffer.from(payload.map((v, i) => v ^ m[i & 3]));
        }
        const fin = (b0 & 0x80) !== 0;
        const op = b0 & 0x0f;
        buf = buf.subarray(off + len);
        if (op === 8) { s.destroy(); return; }
        if (op === 9) { s.write(frame(10, payload)); continue; }
        if (op === 10) continue;
        if (op === 1 || op === 2) frag = { parts: [payload] };
        else if (op === 0 && frag) frag.parts.push(payload);
        if (fin && frag) {
          const text = Buffer.concat(frag.parts).toString('utf8');
          frag = null;
          handle(text);
        }
      }
    });

    s.on('close', () => {
      if (pinger) clearInterval(pinger);
      if (sock === s) sock = null;
      onState('down');
      if (stopped) return;
      retry = Math.min(retry + 1, 5);
      timer = setTimeout(connect, Math.min(30000, 1500 * 2 ** retry));
    });
  }

  connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      if (sock) sock.destroy();
    },
  };
}
