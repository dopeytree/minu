// Terminals through Docker's control socket, the way Dockge does it: no PTY
// library, Docker allocates the terminal. Two kinds:
//   container  a shell inside a running container (docker exec)
//   host       a root shell on the server itself, through a short-lived
//              privileged helper container that nsenters pid 1. This is off
//              unless MINU_HOST_SHELL=1 is set when the dashboard is deployed.
//
// Output reaches the page over server-sent events, input over small POSTs.
import http from 'node:http';
import crypto from 'node:crypto';

const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const HOST_SHELL = process.env.MINU_HOST_SHELL === '1';
const MAX_SESSIONS = 4;
const BACKLOG_BYTES = 200000;
const IDLE_MS = 30 * 60 * 1000;
const SHELL = 'command -v bash >/dev/null 2>&1 && exec bash || exec sh';

const sessions = new Map();
let capsCache = { at: 0, value: null };

function dockerJson(method, pathname, body, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json' };
    if (payload) headers['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ socketPath: SOCKET, path: pathname, method, headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('docker did not answer')));
    if (payload) req.write(payload);
    req.end();
  });
}

// a hijacked connection: after the 101 the socket carries the raw terminal
function dockerStream(pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({
      socketPath: SOCKET,
      path: pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        connection: 'Upgrade',
        upgrade: 'tcp',
      },
    });
    req.on('upgrade', (res, socket, head) => resolve({ socket, head }));
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        reject(new Error(`docker said ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 160)}`));
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

export async function capabilities() {
  if (capsCache.value && Date.now() - capsCache.at < 30000) return capsCache.value;
  let docker = false;
  try {
    const r = await dockerJson('GET', '/_ping', null, 3000);
    docker = r.status === 200;
  } catch { docker = false; }
  capsCache = { at: Date.now(), value: { docker, host: docker && HOST_SHELL } };
  return capsCache.value;
}

function clampSize(cols, rows) {
  return {
    cols: Math.min(500, Math.max(20, Math.round(Number(cols)) || 80)),
    rows: Math.min(200, Math.max(5, Math.round(Number(rows)) || 24)),
  };
}

async function helperImage() {
  if (process.env.MINU_HELPER_IMAGE) return process.env.MINU_HELPER_IMAGE;
  const self = process.env.HOSTNAME;
  if (self && /^[0-9a-f]{12,64}$/.test(self)) {
    const r = await dockerJson('GET', `/containers/${self}/json`);
    if (r.status === 200 && r.json && r.json.Config && r.json.Config.Image) return r.json.Config.Image;
  }
  return 'alpine:3';
}

async function ensureImage(name) {
  if (!/^[\w./:@-]+$/.test(name)) throw new Error('that helper image name is not valid');
  const have = await dockerJson('GET', `/images/${name}/json`);
  if (have.status === 200) return;
  const pull = await dockerJson('POST', `/images/create?fromImage=${encodeURIComponent(name)}`, null, 180000);
  if (pull.status !== 200) throw new Error('could not fetch the helper image');
}

function register(base, socket, head) {
  const id = crypto.randomBytes(12).toString('hex');
  const s = {
    ...base,
    id,
    socket,
    backlog: [],
    size: 0,
    clients: new Set(),
    lastIn: Date.now(),
    orphanedAt: Date.now(), // until the page attaches
    closed: false,
  };
  const take = (chunk) => {
    s.backlog.push(chunk);
    s.size += chunk.length;
    while (s.size > BACKLOG_BYTES && s.backlog.length > 1) s.size -= s.backlog.shift().length;
    const line = `data: ${chunk.toString('base64')}\n\n`;
    for (const res of s.clients) res.write(line);
  };
  if (head && head.length) take(Buffer.from(head));
  socket.on('data', take);
  socket.on('close', () => finish(s));
  socket.on('error', () => finish(s));
  sessions.set(id, s);
  return s;
}

function finish(s) {
  if (s.closed) return;
  s.closed = true;
  for (const res of s.clients) {
    res.write('event: end\ndata: end\n\n');
    res.end();
  }
  s.clients.clear();
  if (s.cleanup) s.cleanup().catch(() => {});
  setTimeout(() => sessions.delete(s.id), 60000).unref();
}

export async function open(kind, ref, cols, rows) {
  const live = [...sessions.values()].filter((s) => !s.closed).length;
  if (live >= MAX_SESSIONS) throw new Error('too many terminals are open');
  const size = clampSize(cols, rows);

  if (kind === 'container') {
    if (!/^[0-9a-f]{12,64}$/.test(String(ref))) throw new Error('missing container');
    const info = await dockerJson('GET', `/containers/${ref}/json`);
    if (info.status !== 200) throw new Error('docker does not know that container');
    if (!info.json || !info.json.State || !info.json.State.Running) throw new Error('that container is not running');
    const exec = await dockerJson('POST', `/containers/${ref}/exec`, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: ['TERM=xterm-256color'],
      Cmd: ['/bin/sh', '-c', SHELL],
    });
    if (exec.status !== 201 || !exec.json || !exec.json.Id) {
      throw new Error(`could not start a shell there (${(exec.json && exec.json.message) || exec.status})`);
    }
    const execId = exec.json.Id;
    const { socket, head } = await dockerStream(`/exec/${execId}/start`, { Detach: false, Tty: true });
    const name = info.json.Name ? String(info.json.Name).replace(/^\//, '') : ref.slice(0, 12);
    const s = register({
      kind,
      label: name,
      resizeWith: (c, r) => dockerJson('POST', `/exec/${execId}/resize?h=${r}&w=${c}`),
    }, socket, head);
    await s.resizeWith(size.cols, size.rows).catch(() => {});
    return s.id;
  }

  if (kind === 'host') {
    if (!HOST_SHELL) throw new Error('the host shell is not enabled on this deployment');
    const image = await helperImage();
    await ensureImage(image);
    const created = await dockerJson('POST', `/containers/create?name=minu-hostshell-${crypto.randomBytes(4).toString('hex')}`, {
      Image: image,
      Cmd: ['nsenter', '-t', '1', '-m', '-u', '-n', '-i', '/bin/sh', '-c', SHELL],
      Tty: true,
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Env: ['TERM=xterm-256color'],
      Labels: { 'minu.host-shell': '1' },
      HostConfig: { Privileged: true, PidMode: 'host', AutoRemove: true },
    });
    if (created.status !== 201 || !created.json || !created.json.Id) {
      throw new Error(`could not create the helper (${(created.json && created.json.message) || created.status})`);
    }
    const cid = created.json.Id;
    try {
      // attach first, then start, so nothing the shell prints is missed
      const { socket, head } = await dockerStream(`/containers/${cid}/attach?stream=1&stdin=1&stdout=1&stderr=1`, {});
      const started = await dockerJson('POST', `/containers/${cid}/start`);
      if (started.status !== 204) {
        socket.destroy();
        throw new Error(`the helper would not start (${(started.json && started.json.message) || started.status})`);
      }
      const s = register({
        kind,
        label: 'server',
        resizeWith: (c, r) => dockerJson('POST', `/containers/${cid}/resize?h=${r}&w=${c}`),
        cleanup: () => dockerJson('DELETE', `/containers/${cid}?force=true`),
      }, socket, head);
      await s.resizeWith(size.cols, size.rows).catch(() => {});
      return s.id;
    } catch (err) {
      await dockerJson('DELETE', `/containers/${cid}?force=true`).catch(() => {});
      throw err;
    }
  }

  throw new Error('there is no terminal for that');
}

export function stream(id, res) {
  const s = sessions.get(id);
  if (!s) return false;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  });
  res.write(': ok\n\n');
  for (const chunk of s.backlog) res.write(`data: ${chunk.toString('base64')}\n\n`);
  if (s.closed) {
    res.write('event: end\ndata: end\n\n');
    res.end();
    return true;
  }
  s.clients.add(res);
  s.orphanedAt = 0;
  const beat = setInterval(() => res.write(': \n\n'), 20000);
  res.on('close', () => {
    clearInterval(beat);
    s.clients.delete(res);
    if (!s.clients.size) s.orphanedAt = Date.now(); // nobody is watching any more
  });
  return true;
}

export function input(id, data) {
  const s = sessions.get(id);
  if (!s || s.closed) return false;
  s.lastIn = Date.now();
  s.socket.write(Buffer.from(String(data), 'utf8'));
  return true;
}

export async function resize(id, cols, rows) {
  const s = sessions.get(id);
  if (!s || s.closed) return false;
  const size = clampSize(cols, rows);
  await s.resizeWith(size.cols, size.rows).catch(() => {});
  return true;
}

export function close(id) {
  const s = sessions.get(id);
  if (!s) return false;
  s.socket.destroy();
  finish(s);
  return true;
}

export function info(id) {
  const s = sessions.get(id);
  return s ? { kind: s.kind, label: s.label } : null;
}

export function closeAll() {
  for (const s of sessions.values()) {
    s.socket.destroy();
    finish(s);
  }
}

// a terminal is closed when it has been left alone for a long time, or when the
// page that opened it has been gone for two minutes (a closed tab, a refresh)
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.closed) continue;
    if (now - s.lastIn > IDLE_MS || (s.orphanedAt && now - s.orphanedAt > 120000)) close(s.id);
  }
}, 30000).unref();
