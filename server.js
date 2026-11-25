import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import dns from 'node:dns/promises';
import net from 'node:net';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { subscribe } from './ws.js';
import * as auth from './auth.js';
import * as term from './term.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const dataDir = process.env.MINU_DATA || root;
// settings live next to the passcode, in the folder that survives updates; a config.json
// beside the code (the old place) is still read if nothing is saved yet
const configPath = path.join(dataDir, 'config.json');
const legacyConfigPath = path.join(root, 'config.json');

// node server.js set-passcode | enable-totp | disable-totp
if (['set-passcode', 'enable-totp', 'disable-totp', 'list-passkeys', 'clear-passkeys'].includes(process.argv[2])) {
  try {
    await auth.runCli(process.argv.slice(2), dataDir);
    process.exit(0);
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
    process.exit(1);
  }
}

auth.init(dataDir);
if (!auth.hasPasscode() && process.env.MINU_PASSCODE) {
  // handy for a first start in Docker; prefer the command above, since an
  // environment variable sits in your compose file in plain text
  try {
    await auth.setPasscode(process.env.MINU_PASSCODE);
    console.log('passcode set from MINU_PASSCODE. remove it from the environment now.');
  } catch (err) {
    console.error(`MINU_PASSCODE ignored: ${err.message}`);
  }
}
if (!auth.hasPasscode() && !auth.isLoopback(HOST)) {
  // first start on a network: make a key and show it in the log, once. Only someone who
  // can read the container's log sees it, so a stranger cannot claim a fresh install.
  const key = auth.newKey();
  await auth.setPasscode(key);
  const line = '='.repeat(58);
  console.log(`\n${line}\n  minu  first start. your sign-in key (shown only now):\n\n    ${key}\n\n  keep it in a password manager. new key later: node server.js set-passcode\n${line}\n`);
}

const DOCKER_OPS = new Set(['start', 'stop', 'restart', 'pause', 'unpause']);
const VM_OPS = new Set(['start', 'stop', 'pause', 'resume', 'reboot', 'forceStop']);

const FULL_QUERY = `query Dashboard {
  info { os { hostname distro release uptime } cpu { brand cores packages { temp } } }
  metrics { cpu { percentTotal } memory { percentTotal } }
  array {
    state
    disks { name fsSize fsUsed }
    caches { name fsSize fsUsed }
  }
  docker {
    containers {
      id names image state status autoStart isUpdateAvailable webUiUrl
      created ports { privatePort publicPort type }
    }
  }
  vms { domains { id name state } }
  notifications { overview { unread { alert warning } } }
}`;

const SAFE_QUERY = `query DashboardSafe {
  info { os { hostname distro release uptime } }
  docker { containers { id names image state status } }
  vms { domains { id name state } }
}`;

let config = loadConfig();
let graphCache = null;
let graphAt = 0;
let graphFlight = null;
let pingCache = null;
let pingAt = 0;
let pingFlight = null;
let addressCache = null;

// Live per-container CPU and memory come from Unraid's stats subscription. It
// only runs while someone is looking, so the server is not left streaming.
const STATS_QUERY = 'subscription { dockerContainerStats { id cpuPercent memUsage memPercent netIO blockIO } }';
const stats = new Map();
let statsSub = null;
let lastView = 0;

function cleanId(id) {
  // ids arrive as "<server>:<container>", and sometimes with a terminal escape in them
  return String(id || '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split(':').pop();
}

function startStats() {
  if (statsSub || !configured()) return;
  let target;
  try { target = apiUrl(config.url); } catch { return; }
  statsSub = subscribe({
    url: target.toString(),
    apiKey: config.apiKey,
    query: STATS_QUERY,
    onData: (data) => {
      const s = data.dockerContainerStats;
      if (!s) return;
      stats.set(cleanId(s.id), {
        cpu: s.cpuPercent,
        mem: s.memUsage,
        memPercent: s.memPercent,
        net: s.netIO,
        blk: s.blockIO,
        at: Date.now(),
      });
    },
  });
}

function stopStats() {
  if (statsSub) statsSub.stop();
  statsSub = null;
  stats.clear();
}

setInterval(() => {
  if (statsSub && Date.now() - lastView > 25000) stopStats();
}, 10000).unref();

function statsFor(id) {
  const s = stats.get(cleanId(id));
  if (!s || Date.now() - s.at > 15000) return null;
  return { cpu: s.cpu, mem: s.mem, memPercent: s.memPercent, net: s.net, blk: s.blk };
}

function portsOf(ports) {
  const open = (ports || []).filter((p) => p && p.publicPort).map((p) => p.publicPort);
  return [...new Set(open)].sort((a, b) => a - b).slice(0, 6);
}

function loadConfig() {
  for (const file of [configPath, legacyConfigPath]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        url: typeof raw.url === 'string' ? raw.url.trim() : '',
        apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
      };
    } catch { /* try the next place */ }
  }
  // nothing saved: start from the environment, if given, else set it in the page
  return {
    url: String(process.env.MINU_UNRAID_URL || '').trim(),
    apiKey: String(process.env.MINU_UNRAID_KEY || '').trim(),
  };
}

function writeConfig(next) {
  const body = JSON.stringify({ url: next.url, apiKey: next.apiKey }, null, 2) + '\n';
  fs.writeFileSync(configPath, body, { mode: 0o600 });
  try { fs.chmodSync(configPath, 0o600); } catch { /* windows */ }
  config = { url: next.url, apiKey: next.apiKey };
  graphCache = null;
  graphAt = 0;
  pingCache = null;
  pingAt = 0;
  addressCache = null;
  stopStats();
}

function configured() {
  return Boolean(config.url && config.apiKey);
}

function apiUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('the address is empty');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/graphql';
  return u;
}

function redact(message) {
  let s = String(message || 'the server did not answer');
  if (config.apiKey && s.includes(config.apiKey)) s = 'the api refused the request';
  if (/forbidden/i.test(s)) s = 'the key can look, but not change that';
  return s.slice(0, 200);
}

function postGraph(target, query, variables, timeout = 18000) {
  const u = target instanceof URL ? target : apiUrl(target.url || target);
  const key = target.apiKey || config.apiKey;
  const lib = u.protocol === 'https:' ? https : http;
  const body = JSON.stringify({ query, variables: variables || {} });
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        accept: 'application/json',
        'x-api-key': key,
      },
      rejectUnauthorized: false,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); }
        catch {
          const err = new Error('unraid answered, but not with the api');
          err.status = res.statusCode;
          reject(err);
          return;
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', (err) => {
      const wrapped = new Error(redact(err.message));
      wrapped.network = true;
      wrapped.code = err.code;
      reject(wrapped);
    });
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('the server is slow to answer'), { network: true }));
    });
    req.write(body);
    req.end();
  });
}

async function gql(query, variables, timeout) {
  const { status, json } = await postGraph(config, query, variables, timeout);
  if (status === 401 || status === 403) {
    const err = new Error('the key was refused');
    err.auth = true;
    throw err;
  }
  if (!json || json.data == null) {
    const msg = json && json.errors && json.errors[0] && json.errors[0].message;
    const err = new Error(redact(msg || 'the api returned nothing'));
    err.graphql = true;
    throw err;
  }
  return json.data;
}

async function loadGraph() {
  if (!configured()) {
    const err = new Error('no server yet');
    err.unconfigured = true;
    throw err;
  }
  try {
    return await gql(FULL_QUERY);
  } catch (err) {
    if (err.auth || err.network || err.unconfigured) throw err;
    return gql(SAFE_QUERY);
  }
}

function refreshGraph() {
  if (graphFlight) return graphFlight;
  graphFlight = loadGraph()
    .then((data) => {
      graphCache = { ok: true, data, error: null };
      graphAt = Date.now();
      return graphCache;
    })
    .catch((err) => {
      const failure = { ok: false, data: null, error: redact(err.message), auth: Boolean(err.auth) };
      if (!graphCache) graphCache = failure;
      else graphCache = { ...graphCache, error: failure.error, auth: failure.auth, stale: true };
      graphAt = Date.now();
      return graphCache;
    })
    .finally(() => { graphFlight = null; });
  return graphFlight;
}

function peekGraph() {
  const fresh = graphCache && Date.now() - graphAt < 8000 && graphCache.ok && !graphCache.stale;
  if (fresh) return Promise.resolve(graphCache);
  if (graphCache && graphCache.ok) {
    refreshGraph();
    return Promise.resolve(graphCache);
  }
  return refreshGraph();
}

async function resolveHost() {
  const u = apiUrl(config.url);
  if (addressCache && addressCache.host === u.hostname && Date.now() - addressCache.at < 300000) {
    return addressCache;
  }
  let address = u.hostname;
  if (!net.isIP(u.hostname)) {
    try {
      const looked = await dns.lookup(u.hostname);
      address = looked.address;
    } catch { /* ping the name anyway */ }
  }
  addressCache = {
    host: u.hostname,
    address,
    port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
    at: Date.now(),
  };
  return addressCache;
}

function icmp(address) {
  const args = platform() === 'darwin'
    ? ['-c', '1', '-W', '1000', address]
    : ['-c', '1', '-W', '1', address];
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: 2500 }, (err, stdout) => {
      const match = String(stdout || '').match(/time[=<]\s*([0-9.]+)\s*ms/i);
      if (match) resolve({ ok: true, ms: Number(match[1]), method: 'icmp' });
      else resolve(null);
    });
  });
}

function tcpPing(address, port) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = net.connect({ host: address, port, timeout: 2000 });
    const done = (ok) => {
      sock.destroy();
      resolve(ok ? { ok: true, ms: Date.now() - start, method: 'tcp' } : { ok: false, ms: null, method: 'tcp' });
    };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function measurePing() {
  if (!configured()) return { ok: false, ms: null, method: 'none' };
  try {
    const dest = await resolveHost();
    const viaIcmp = await icmp(dest.address);
    if (viaIcmp) return viaIcmp;
    return tcpPing(dest.address, dest.port);
  } catch {
    return { ok: false, ms: null, method: 'none' };
  }
}

function refreshPing() {
  if (pingFlight) return pingFlight;
  pingFlight = measurePing()
    .then((ping) => {
      pingCache = ping;
      pingAt = Date.now();
      return ping;
    })
    .finally(() => { pingFlight = null; });
  return pingFlight;
}

// A real probe on demand: the page fires one ripple per ping.
async function freshPing() {
  if (!configured()) return { ok: false, ms: null, method: 'none' };
  if (pingFlight) return pingFlight;
  if (pingCache && Date.now() - pingAt < 900) return pingCache;
  return refreshPing();
}

function peekPing() {
  if (pingCache && Date.now() - pingAt < 3000) return Promise.resolve(pingCache);
  if (pingCache) {
    refreshPing();
    return Promise.resolve(pingCache);
  }
  return refreshPing();
}

function shortName(names) {
  const raw = Array.isArray(names) && names[0] ? names[0] : 'container';
  return String(raw).replace(/^\//, '') || 'container';
}

function shortImage(image) {
  if (!image) return '';
  const tagAt = image.lastIndexOf(':');
  const slash = image.lastIndexOf('/');
  const hasTag = tagAt > slash;
  const name = hasTag ? image.slice(0, tagAt) : image;
  const tag = hasTag ? image.slice(tagAt + 1) : '';
  const base = name.split('/').pop();
  return tag ? `${base}:${tag}` : base;
}

function healthOf(kind, state, status) {
  const s = String(state || '').toUpperCase();
  const text = String(status || '');
  if (/unhealthy/i.test(text)) return 'unhealthy';
  if (/restarting/i.test(text)) return 'uneasy';
  if (s === 'RUNNING' || s === 'IDLE') return 'up';
  if (s === 'PAUSED' || s === 'PMSUSPENDED') return 'paused';
  if (s === 'CRASHED') return 'crashed';
  if (kind === 'vm' && (s === 'SHUTOFF' || s === 'SHUTDOWN' || s === 'NOSTATE')) return 'down';
  return 'down';
}

function usedRatio(disk) {
  const size = Number(disk && disk.fsSize);
  const used = Number(disk && disk.fsUsed);
  if (!size || !Number.isFinite(used) || size < 0) return null;
  return used / size;
}

function tightDisks(array) {
  if (!array) return [];
  const all = [...(array.disks || []), ...(array.caches || [])];
  return all
    .map((disk) => ({ name: disk.name || 'disk', used: usedRatio(disk) }))
    .filter((disk) => disk.used != null && disk.used >= 0.8)
    .sort((a, b) => b.used - a.used)
    .slice(0, 4);
}

function resolveWeb(url, host) {
  if (!url || typeof url !== 'string') return null;
  let s = url.replaceAll('[IP]', host).replace(/\[PORT:(\d+)\]/g, '$1');
  if (/\[[^\]]+\]/.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
}

function serverHealth(ping, graph, disks) {
  if (!graph || !graph.ok) return ping && ping.ok ? 'refused' : 'down';
  const arrayState = graph.data && graph.data.array && graph.data.array.state;
  if (arrayState && arrayState !== 'STARTED') return 'uneasy';
  if (disks.some((disk) => disk.used >= 0.9)) return 'uneasy';
  if (ping && ping.ok === false) return 'uneasy';
  return 'up';
}

// the hottest CPU package, as the one number to show for temperature
function tempOf(packages) {
  const list = packages && Array.isArray(packages.temp) ? packages.temp.filter((v) => Number.isFinite(v)) : [];
  return list.length ? Math.max(...list) : null;
}

function shape(graph, ping) {
  const data = graph && graph.ok ? graph.data : null;
  const os = data && data.info && data.info.os ? data.info.os : {};
  const cpuInfo = data && data.info && data.info.cpu ? data.info.cpu : {};
  const metrics = data && data.metrics ? data.metrics : {};
  const cpu = metrics.cpu && Number(metrics.cpu.percentTotal);
  const memory = metrics.memory && Number(metrics.memory.percentTotal);
  const disks = tightDisks(data && data.array);
  const unread = data && data.notifications && data.notifications.overview
    ? data.notifications.overview.unread
    : null;
  let ui = null;
  try { ui = apiUrl(config.url).origin; } catch { /* unconfigured */ }

  const server = {
    id: 'server',
    kind: 'server',
    name: os.hostname || 'server',
    version: os.release || os.distro || '',
    cpuBrand: cpuInfo.brand || '',
    temp: tempOf(cpuInfo.packages),
    cores: cpuInfo.cores || null,
    cpu: Number.isFinite(cpu) ? cpu : null,
    memory: Number.isFinite(memory) ? memory : null,
    uptime: os.uptime || null,
    arrayState: data && data.array ? data.array.state : null,
    alerts: unread ? unread.alert : null,
    warnings: unread ? unread.warning : null,
    disks,
    dockerOff: Boolean(data) && data.docker == null,
    health: serverHealth(ping, graph, disks),
    web: ui,
  };

  const machines = [server];
  const containers = data && data.docker && data.docker.containers ? data.docker.containers : [];
  for (const container of containers) {
    const health = healthOf('docker', container.state, container.status);
    machines.push({
      id: String(container.id),
      kind: 'docker',
      name: shortName(container.names),
      image: shortImage(container.image),
      state: container.state || 'EXITED',
      status: container.status || '',
      health,
      autoStart: Boolean(container.autoStart),
      update: Boolean(container.isUpdateAvailable),
      web: resolveWeb(container.webUiUrl, addressCache ? addressCache.address : ''),
      created: container.created || null,
      ports: portsOf(container.ports),
      stats: statsFor(container.id),
    });
  }
  const domains = data && data.vms && data.vms.domains ? data.vms.domains : [];
  for (const domain of domains) {
    machines.push({
      id: String(domain.id),
      kind: 'vm',
      name: domain.name || 'vm',
      state: domain.state || 'SHUTOFF',
      status: '',
      health: healthOf('vm', domain.state, ''),
    });
  }

  const dancing = machines.filter((m) => m.kind !== 'server' && (m.health === 'up' || m.health === 'unhealthy' || m.health === 'paused' || m.health === 'uneasy')).length;
  const quiet = machines.length - 1 - dancing;

  return {
    configured: configured(),
    demo: false,
    error: graph && graph.error ? graph.error : null,
    auth: Boolean(graph && graph.auth),
    stale: Boolean(graph && graph.stale),
    checkedAt: Date.now(),
    ping: ping || { ok: false, ms: null, method: 'none' },
    server,
    machines,
    summary: { dancing, quiet, total: machines.length - 1 },
  };
}

async function currentState() {
  if (!configured()) {
    return {
      configured: false,
      demo: true,
      error: null,
      ping: { ok: false, ms: null, method: 'none' },
      server: { id: 'server', kind: 'server', name: 'server', health: 'down' },
      machines: [],
      summary: { dancing: 0, quiet: 0, total: 0 },
    };
  }
  lastView = Date.now();
  startStats();
  const [graph, ping] = await Promise.all([peekGraph(), peekPing()]);
  return shape(graph, ping);
}

// Logs, read-only: a container's recent output, or one of Unraid's own log files.
// Only files Unraid itself lists are ever read, never a path the page invents.
const LOG_LINES = 300;
let logFilesCache = { at: 0, files: [] };

async function listLogFiles() {
  if (logFilesCache.files.length && Date.now() - logFilesCache.at < 60000) return logFilesCache.files;
  const data = await gql('{ logFiles { name path size } }', {}, 20000);
  const files = ((data && data.logFiles) || [])
    .filter((f) => f.size > 0 && !/\.gz$/.test(f.path))
    .sort((a, b) => (b.path.endsWith('/syslog') ? 1 : 0) - (a.path.endsWith('/syslog') ? 1 : 0)
      || a.name.localeCompare(b.name));
  logFilesCache = { at: Date.now(), files };
  return files;
}

function trimLine(s) {
  const text = String(s == null ? '' : s);
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

async function readLogs(kind, ref) {
  if (!configured()) throw new Error('no server yet');
  if (kind === 'docker') {
    if (!/^[\w:.-]{1,200}$/.test(ref)) throw new Error('missing machine');
    const data = await gql(
      'query($id: PrefixedID!, $n: Int) { docker { logs(id: $id, tail: $n) { lines { timestamp message } } } }',
      { id: ref, n: LOG_LINES },
      25000,
    );
    const lines = (data.docker && data.docker.logs && data.docker.logs.lines) || [];
    return { lines: lines.map((l) => ({ t: l.timestamp, m: trimLine(l.message) })) };
  }
  if (kind === 'server') {
    const files = await listLogFiles();
    const file = files.find((f) => f.path === ref) || files[0];
    if (!file) return { lines: [], files: [] };
    const data = await gql(
      'query($p: String!, $n: Int) { logFile(path: $p, lines: $n) { content totalLines } }',
      { p: file.path, n: LOG_LINES },
      25000,
    );
    const text = (data.logFile && data.logFile.content) || '';
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return {
      lines: lines.map((m) => ({ t: null, m: trimLine(m) })),
      file: file.path,
      total: data.logFile ? data.logFile.totalLines : lines.length,
      files: files.map((f) => ({ path: f.path, name: f.name })),
    };
  }
  throw new Error('there are no logs for that');
}

async function runAction(kind, id, op) {
  if (!configured()) throw new Error('no server yet');
  if (typeof id !== 'string' || !id || id.length > 200) throw new Error('missing machine');
  let query;
  if (kind === 'docker' && DOCKER_OPS.has(op)) {
    query = `mutation($id: PrefixedID!) { docker { ${op}(id: $id) { id state status } } }`;
  } else if (kind === 'vm' && VM_OPS.has(op)) {
    query = `mutation($id: PrefixedID!) { vm { ${op}(id: $id) } }`;
  } else {
    throw new Error('that action is not allowed');
  }
  const data = await gql(query, { id }, 30000);
  graphAt = 0;
  refreshGraph();
  return data;
}

async function testConfig(next) {
  const u = apiUrl(next.url);
  const { status, json } = await postGraph(
    { url: u, apiKey: next.apiKey },
    '{ info { os { hostname } } }',
    {},
    12000,
  );
  if (status === 401 || status === 403) throw new Error('the key was refused');
  const hostname = json && json.data && json.data.info && json.data.info.os && json.data.info.os.hostname;
  if (!hostname) {
    const msg = json && json.errors && json.errors[0] && json.errors[0].message;
    throw new Error(redact(msg || 'the api returned nothing'));
  }
  return hostname;
}

function readBody(req, limit = 32768) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir + path.sep)) {
    send(res, 403, { error: 'no' });
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      send(res, 404, { error: 'not found' });
      return;
    }
    res.writeHead(200, {
      'content-type': types[path.extname(file)] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': 'no-cache',
      // scripts stay locked to this origin; styles allow inline because the terminal
      // library injects its own <style> elements
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(buf);
  });
}

// ---- terminals (container shells, and the host shell when it is enabled)
async function handleTerm(req, res, url, session) {
  const op = url.pathname.slice('/api/term/'.length);
  if (req.method === 'GET' && op === 'caps') {
    send(res, 200, { ok: true, ...(await term.capabilities()) });
    return;
  }
  if (req.method === 'GET' && op === 'out') {
    if (!term.stream(url.searchParams.get('id') || '', res)) send(res, 404, { ok: false, error: 'that terminal is gone' });
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'no' });
    return;
  }
  const body = await readBody(req, 70000);
  const id = typeof body.id === 'string' ? body.id : '';
  if (op === 'open') {
    const caps = await term.capabilities();
    if (!caps.docker) {
      send(res, 200, { ok: false, error: 'docker is not reachable from the dashboard' });
      return;
    }
    const kind = body.kind === 'host' ? 'host' : 'container';
    const ref = kind === 'container' ? cleanId(body.ref) : '';
    try {
      const made = await term.open(kind, ref, body.cols, body.rows);
      console.log(`terminal opened  ${kind} ${kind === 'container' ? ref.slice(0, 12) : 'server'}  from ${auth.clientIp(req)}`);
      send(res, 200, { ok: true, id: made });
    } catch (err) {
      console.log(`terminal refused ${kind}: ${err.message}`);
      send(res, 200, { ok: false, error: redact(err.message) });
    }
    return;
  }
  if (op === 'in') {
    send(res, 200, { ok: term.input(id, typeof body.data === 'string' ? body.data : '') });
    return;
  }
  if (op === 'resize') {
    send(res, 200, { ok: await term.resize(id, body.cols, body.rows) });
    return;
  }
  if (op === 'close') {
    const meta = term.info(id);
    const done = term.close(id);
    if (done && meta) console.log(`terminal closed  ${meta.kind} ${meta.label}  by ${auth.clientIp(req)}`);
    send(res, 200, { ok: done });
    return;
  }
  void session;
  send(res, 404, { ok: false, error: 'no such terminal action' });
}

const handler = async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  try {
    auth.refresh();
    const authMode = auth.mode(HOST);
    const secure = Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';
    const session = authMode === 'on' ? auth.sessionFrom(req) : null;

    // ---- public: health, whether to show the login, and signing in
    if (req.method === 'GET' && url.pathname === '/api/health') {
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/session') {
      send(res, 200, {
        mode: authMode,
        authed: authMode !== 'on' || Boolean(session),
        totp: auth.hasTotp(),
        passkeys: auth.passkeyCount(),
        rp: Boolean(auth.rpFor(req)),
        csrf: session ? session.csrf : '',
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (authMode !== 'on') {
        send(res, 400, { ok: false, error: 'no passcode is set yet' });
        return;
      }
      if (!auth.sameOrigin(req)) {
        send(res, 403, { ok: false, error: 'refused' });
        return;
      }
      const body = await readBody(req, 2048);
      const ip = auth.clientIp(req);
      const result = await auth.login(ip, body.passcode, body.code);
      if (!result.ok) {
        console.log(`login ${result.status === 429 ? 'locked out' : 'refused'}  ${ip}`);
        if (result.status === 429) res.setHeader('retry-after', String(result.retry));
        send(res, result.status, {
          ok: false,
          error: result.status === 429 ? 'too many tries, wait a while' : 'that did not match',
          retry: result.retry || 0,
        });
        return;
      }
      console.log(`login ok         ${ip}`);
      res.setHeader('set-cookie', auth.cookieFor(result.session, secure));
      send(res, 200, { ok: true, csrf: result.session.csrf });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/passkey/login/begin') {
      const rp = auth.rpFor(req);
      if (authMode !== 'on' || !auth.passkeyCount()) {
        send(res, 400, { ok: false, error: 'no passkeys are set up' });
        return;
      }
      if (!rp) {
        send(res, 400, { ok: false, error: 'passkeys need https and a hostname, not an IP address' });
        return;
      }
      if (!auth.sameOrigin(req)) {
        send(res, 403, { ok: false, error: 'refused' });
        return;
      }
      const wait = auth.retryAfter(auth.clientIp(req));
      if (wait) {
        send(res, 429, { ok: false, error: 'too many tries, wait a while', retry: wait });
        return;
      }
      const b = auth.passkeyBegin('', rp);
      send(res, 200, { ok: true, id: b.id, challenge: b.challenge, rpId: b.rpId, allow: b.allow });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/passkey/login/finish') {
      const rp = auth.rpFor(req);
      if (authMode !== 'on' || !rp || !auth.sameOrigin(req)) {
        send(res, 400, { ok: false, error: 'refused' });
        return;
      }
      const body = await readBody(req, 16384);
      const ip = auth.clientIp(req);
      const result = await auth.passkeyLogin(ip, rp, body);
      if (!result.ok) {
        console.log(`passkey ${result.status === 429 ? 'locked out' : 'refused'}  ${ip}`);
        if (result.status === 429) res.setHeader('retry-after', String(result.retry));
        send(res, result.status, { ok: false, error: result.status === 429 ? 'too many tries, wait a while' : 'that passkey was not accepted', retry: result.retry || 0 });
        return;
      }
      console.log(`passkey ok       ${ip}`);
      res.setHeader('set-cookie', auth.cookieFor(result.session, secure));
      send(res, 200, { ok: true, csrf: result.session.csrf });
      return;
    }

    // ---- everything else under /api needs a session once a passcode is set
    if (url.pathname.startsWith('/api/')) {
      if (authMode === 'locked') {
        send(res, 503, { ok: false, mode: 'locked', error: 'set a passcode first: node server.js set-passcode' });
        return;
      }
      if (authMode === 'on') {
        if (!session) {
          send(res, 401, { ok: false, mode: 'on', error: 'login' });
          return;
        }
        if (req.method === 'POST' && (!auth.sameOrigin(req) || req.headers['x-minu-csrf'] !== session.csrf)) {
          send(res, 403, { ok: false, error: 'refused' });
          return;
        }
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      auth.destroy(session);
      res.setHeader('set-cookie', auth.clearCookie(secure));
      send(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/passkey/add/begin' || url.pathname === '/api/passkey/add/finish') {
      const rp = auth.rpFor(req);
      if (authMode !== 'on' || !session || req.method !== 'POST') {
        send(res, 403, { ok: false, error: 'sign in first' });
        return;
      }
      if (!rp) {
        send(res, 400, { ok: false, error: 'passkeys need https and a hostname, not an IP address' });
        return;
      }
      try {
        if (url.pathname.endsWith('/begin')) {
          send(res, 200, { ok: true, ...auth.passkeyBegin(session.sid, rp) });
        } else {
          const body = await readBody(req, 16384);
          const out = auth.passkeyAdd(session.sid, rp, body);
          if (out.ok) console.log(`passkey added    ${auth.clientIp(req)}  (${out.count} in all)`);
          send(res, 200, out);
        }
      } catch (err) {
        send(res, 200, { ok: false, error: redact(err.message) });
      }
      return;
    }
    if (url.pathname.startsWith('/api/term/')) {
      if (authMode !== 'on') {
        send(res, 403, { ok: false, error: 'turn the login on first: node server.js set-passcode' });
        return;
      }
      await handleTerm(req, res, url, session);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      send(res, 200, await currentState());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      send(res, 200, {
        url: config.url || '',
        hasKey: Boolean(config.apiKey),
        hint: config.apiKey ? config.apiKey.slice(-4) : '',
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req, 8192);
      const next = {
        url: typeof body.url === 'string' && body.url.trim() ? body.url.trim() : config.url,
        apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : config.apiKey,
      };
      if (!next.url || !next.apiKey) {
        send(res, 400, { ok: false, error: 'address and key are both needed' });
        return;
      }
      try {
        const hostname = await testConfig(next);
        writeConfig(next);
        refreshGraph();
        refreshPing();
        send(res, 200, { ok: true, hostname });
      } catch (err) {
        send(res, 200, { ok: false, error: redact(err.message) });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      const body = await readBody(req);
      try {
        await runAction(body.kind, body.id, body.op);
        send(res, 200, { ok: true });
      } catch (err) {
        send(res, 200, { ok: false, error: redact(err.message) });
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      try {
        const out = await readLogs(url.searchParams.get('kind') || '', url.searchParams.get('ref') || '');
        send(res, 200, { ok: true, ...out });
      } catch (err) {
        send(res, 200, { ok: false, error: redact(err.message) });
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/ping') {
      send(res, 200, await freshPing());
      return;
    }
    if (req.method === 'GET') {
      serveStatic(req, res, url.pathname);
      return;
    }
    send(res, 405, { error: 'no' });
  } catch (err) {
    send(res, 500, { error: redact(err.message) });
  }
};

// https when a certificate is given (needed for passkeys); plain http otherwise
const certPath = process.env.MINU_CERT;
const keyPath = process.env.MINU_KEY;
const server = certPath && keyPath
  ? https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, handler)
  : http.createServer(handler);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    term.closeAll(); // takes any host-shell helper container down with us
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`minu  ${certPath && keyPath ? 'https' : 'http'}://${HOST}:${PORT}`);
  const am = auth.mode(HOST);
  console.log(am === 'on'
    ? `login  on${auth.hasTotp() ? ' (passcode + authenticator code)' : ' (passcode)'}`
    : am === 'off'
      ? 'login  off: only this machine can reach the page. set a passcode to share it or to use terminals.'
      : 'login  LOCKED: reachable from the network with no passcode, so the page refuses to work. run: node server.js set-passcode');
  if (configured()) refreshGraph().then((graph) => {
    const name = graph.ok && graph.data.info && graph.data.info.os && graph.data.info.os.hostname;
    const n = graph.ok && graph.data.docker && graph.data.docker.containers
      ? graph.data.docker.containers.length
      : 0;
    console.log(graph.ok ? `unraid  ${name || 'connected'} · ${n} containers` : `unraid  ${graph.error}`);
  });
});
