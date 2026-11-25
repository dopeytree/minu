// Login for minu: one passcode, optional authenticator-app code, sessions,
// lockout after repeated failures. Built on node:crypto only, no packages.
//
// The passcode is never stored. Only a scrypt hash is, in auth.json (mode 600).
// Set it with:  node server.js set-passcode
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const COOKIE = 'minu_sid';
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const GLOBAL_MAX = 25;
const GLOBAL_LOCK_MS = 5 * 60 * 1000;
const MIN_PASSCODE = 16;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

let file = '';
let store = { passcode: null, totp: null, passkeys: [] };
let lastTotpStep = 0;

const sessions = new Map();
const fails = new Map();
let globalFails = [];
let globalLockedUntil = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scrypt(secret, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

let seenMtime = 0;
let lastCheck = 0;

function readFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      passcode: typeof raw.passcode === 'string' ? raw.passcode : null,
      totp: typeof raw.totp === 'string' ? raw.totp : null,
      passkeys: Array.isArray(raw.passkeys) ? raw.passkeys.filter((k) => k && typeof k.id === 'string' && typeof k.pub === 'string') : [],
    };
  } catch {
    return { passcode: null, totp: null, passkeys: [] };
  }
}

export function init(dir) {
  file = path.join(dir, 'auth.json');
  store = readFile();
  try { seenMtime = fs.statSync(file).mtimeMs; } catch { seenMtime = 0; }
}

// The command line edits auth.json from another process, so notice that here. A
// changed passcode or authenticator setting signs everyone out.
export function refresh() {
  const now = Date.now();
  if (now - lastCheck < 1000) return;
  lastCheck = now;
  let m = 0;
  try { m = fs.statSync(file).mtimeMs; } catch { m = 0; }
  if (m === seenMtime) return;
  seenMtime = m;
  const next = readFile();
  if (next.passcode !== store.passcode || next.totp !== store.totp) sessions.clear();
  store = next;
}

function save() {
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
  try { seenMtime = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
}

export function hasPasscode() {
  return Boolean(store.passcode);
}

export function hasTotp() {
  return Boolean(store.totp);
}

export function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

// 'on'     a passcode is set: everything needs a session
// 'off'    no passcode, and the page is only reachable from this machine
// 'locked' no passcode, but the page is reachable from the network: refuse to serve
export function mode(host) {
  if (hasPasscode()) return 'on';
  return isLoopback(host) ? 'off' : 'locked';
}

// dashes, spaces and case do not matter, so a key can be pasted as it was shown
function normalizeKey(text) {
  return String(text || '').replace(/[\s-]+/g, '').toUpperCase();
}

export function newKey() {
  const raw = base32Encode(crypto.randomBytes(20)); // 32 characters, 160 bits
  return raw.match(/.{4}/g).join('-');
}

export async function setPasscode(pass) {
  pass = normalizeKey(pass);
  if (pass.length < MIN_PASSCODE) {
    throw new Error(`the key needs at least ${MIN_PASSCODE} characters`);
  }
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pass, salt);
  store.passcode = ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
  save();
  sessions.clear(); // a new passcode signs everyone out
}

async function checkPasscode(pass) {
  // always do the work, even with nothing stored, so timing says nothing
  const parts = String(store.passcode || '').split('$');
  const salt = parts[4] ? Buffer.from(parts[4], 'base64') : crypto.randomBytes(16);
  const want = parts[5] ? Buffer.from(parts[5], 'base64') : crypto.randomBytes(SCRYPT.keylen);
  const got = await scrypt(normalizeKey(pass), salt);
  return Boolean(store.passcode) && got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---- authenticator-app codes (RFC 6238: 6 digits, 30 seconds)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of String(text).toUpperCase().replace(/=+$/, '')) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1] & 15;
  const n = (((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 1000000;
  return String(n).padStart(6, '0');
}

// the matching 30-second step, or -1; one step either side allows for clock drift
function totpMatch(secret, code) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return -1;
  const now = Math.floor(Date.now() / 30000);
  for (const step of [now, now - 1, now + 1]) {
    const want = Buffer.from(totpAt(secret, step));
    const have = Buffer.from(clean);
    if (crypto.timingSafeEqual(want, have)) return step;
  }
  return -1;
}

export function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function confirmTotp(secret, code) {
  if (totpMatch(secret, code) < 0) return false;
  store.totp = secret;
  save();
  return true;
}

export function clearTotp() {
  store.totp = null;
  save();
}

// ---- lockout: a few wrong tries lock that address for a while, and a flood
// from many addresses locks everyone out briefly
export function retryAfter(ip) {
  const now = Date.now();
  if (now < globalLockedUntil) return Math.ceil((globalLockedUntil - now) / 1000);
  const f = fails.get(ip);
  if (f && now < f.lockedUntil) return Math.ceil((f.lockedUntil - now) / 1000);
  return 0;
}

function recordFail(ip) {
  const now = Date.now();
  let f = fails.get(ip);
  if (!f || now - f.first > WINDOW_MS) f = { n: 0, first: now, lockedUntil: 0 };
  f.n += 1;
  if (f.n >= MAX_FAILS) f.lockedUntil = now + LOCK_MS;
  fails.set(ip, f);
  globalFails = globalFails.filter((t) => now - t < WINDOW_MS);
  globalFails.push(now);
  if (globalFails.length >= GLOBAL_MAX) globalLockedUntil = now + GLOBAL_LOCK_MS;
}

export async function login(ip, passcode, code) {
  const wait = retryAfter(ip);
  if (wait) return { ok: false, status: 429, retry: wait };
  const passOk = await checkPasscode(passcode);
  let step = 0;
  let codeOk = true;
  if (store.totp) {
    step = totpMatch(store.totp, code);
    codeOk = step > lastTotpStep; // a code works once
  }
  if (!passOk || !codeOk) {
    recordFail(ip);
    await sleep(600);
    return { ok: false, status: 401 };
  }
  if (store.totp) lastTotpStep = step;
  fails.delete(ip);
  return { ok: true, session: startSession(ip) };
}

function startSession(ip) {
  const sid = crypto.randomBytes(32).toString('hex');
  const session = { sid, csrf: crypto.randomBytes(24).toString('hex'), seen: Date.now(), ip };
  sessions.set(sid, session);
  return session;
}

// ---- passkeys (WebAuthn): a key pair made by the device, unlocked by Touch ID,
// Face ID, a PIN or a security key. Only the public half is kept here. Needs https
// (or localhost) and a hostname, not an IP address: that is a browser rule.
const challenges = new Map();
const MAX_PASSKEYS = 10;
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function passkeyCount() {
  return store.passkeys.length;
}

export function clearPasskeys() {
  store.passkeys = [];
  save();
}

export function listPasskeys() {
  return store.passkeys.map((k) => ({ name: k.name || 'passkey', added: k.added || 0 }));
}

// where this page is served from, as the browser sees it; null when passkeys cannot work here
export function rpFor(req) {
  const host = String(req.headers.host || '');
  const secure = Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';
  const origin = process.env.MINU_ORIGIN || `${secure ? 'https' : 'http'}://${host}`;
  let url;
  try { url = new URL(origin); } catch { return null; }
  const rpId = url.hostname;
  const ipLike = /^\d+\.\d+\.\d+\.\d+$/.test(rpId) || rpId.includes(':');
  if (ipLike) return null;
  if (url.protocol !== 'https:' && rpId !== 'localhost') return null;
  return { rpId, origin: url.origin };
}

function newChallenge(kind, sid) {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
  if (challenges.size > 200) throw new Error('busy, try again in a minute');
  const id = b64u(crypto.randomBytes(16));
  const challenge = b64u(crypto.randomBytes(32));
  challenges.set(id, { challenge, kind, sid: sid || '', exp: now + 120000 });
  return { id, challenge };
}

// a challenge works once, and only for the thing it was made for
function takeChallenge(id, kind, sid) {
  const c = challenges.get(String(id));
  challenges.delete(String(id));
  if (!c || c.kind !== kind || c.exp < Date.now() || c.sid !== (sid || '')) return null;
  return c.challenge;
}

function checkClient(clientData, type, challenge, origin) {
  let raw;
  let cd;
  try {
    raw = Buffer.from(String(clientData), 'base64url');
    cd = JSON.parse(raw.toString('utf8'));
  } catch { return null; }
  if (cd.type !== type || cd.challenge !== challenge || cd.origin !== origin || cd.crossOrigin === true) return null;
  return raw;
}

// user present, user verified (the fingerprint, face or PIN), and made for this site
function checkAuthData(authData, rpId) {
  if (authData.length < 37) return null;
  if (!crypto.timingSafeEqual(authData.subarray(0, 32), sha256(rpId))) return null;
  const flags = authData[32];
  if (!(flags & 0x01) || !(flags & 0x04)) return null;
  return { flags, counter: authData.readUInt32BE(33) };
}

export function passkeyBegin(sid, rp) {
  const kind = sid ? 'create' : 'get';
  const c = newChallenge(kind, sid);
  return {
    id: c.id,
    challenge: c.challenge,
    rpId: rp.rpId,
    allow: store.passkeys.map((k) => k.id),
    userId: b64u(crypto.randomBytes(16)),
  };
}

export function passkeyAdd(sid, rp, body) {
  const challenge = takeChallenge(body.id, 'create', sid);
  if (!challenge) return { ok: false, error: 'that took too long, try again' };
  if (store.passkeys.length >= MAX_PASSKEYS) return { ok: false, error: `${MAX_PASSKEYS} passkeys is the limit` };
  if (!checkClient(body.clientData, 'webauthn.create', challenge, rp.origin)) return { ok: false, error: 'the passkey was made for a different address' };
  let authData;
  let spki;
  try {
    authData = Buffer.from(String(body.authData), 'base64url');
    spki = Buffer.from(String(body.publicKey), 'base64url');
  } catch { return { ok: false, error: 'unreadable passkey' }; }
  const head = checkAuthData(authData, rp.rpId);
  if (!head || !(head.flags & 0x40) || authData.length < 55) return { ok: false, error: 'the device did not confirm it was you' };
  const idLen = authData.readUInt16BE(53);
  const credId = authData.subarray(55, 55 + idLen);
  if (!idLen || credId.length !== idLen || b64u(credId) !== String(body.credId)) return { ok: false, error: 'unreadable passkey' };
  try {
    const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') {
      return { ok: false, error: 'this device made a passkey type that is not supported' };
    }
  } catch { return { ok: false, error: 'unreadable passkey' }; }
  const id = b64u(credId);
  if (store.passkeys.some((k) => k.id === id)) return { ok: false, error: 'this device already has a passkey' };
  store.passkeys.push({
    id,
    pub: spki.toString('base64'),
    counter: head.counter,
    name: String(body.name || 'passkey').replace(/[^\w .()-]/g, '').slice(0, 40) || 'passkey',
    added: Date.now(),
  });
  save();
  return { ok: true, count: store.passkeys.length };
}

export async function passkeyLogin(ip, rp, body) {
  const wait = retryAfter(ip);
  if (wait) return { ok: false, status: 429, retry: wait };
  const fail = async () => {
    recordFail(ip);
    await sleep(600);
    return { ok: false, status: 401 };
  };
  const challenge = takeChallenge(body.id, 'get', '');
  const stored = store.passkeys.find((k) => k.id === String(body.credId));
  if (!challenge || !stored) return fail();
  const clientRaw = checkClient(body.clientData, 'webauthn.get', challenge, rp.origin);
  if (!clientRaw) return fail();
  let authData;
  let sig;
  try {
    authData = Buffer.from(String(body.authData), 'base64url');
    sig = Buffer.from(String(body.signature), 'base64url');
  } catch { return fail(); }
  const head = checkAuthData(authData, rp.rpId);
  if (!head) return fail();
  // a counter that goes backwards means the key was copied (devices that sync keep it at 0)
  if ((head.counter > 0 || stored.counter > 0) && head.counter <= stored.counter) return fail();
  let good = false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(stored.pub, 'base64'), format: 'der', type: 'spki' });
    good = crypto.verify('sha256', Buffer.concat([authData, sha256(clientRaw)]), key, sig);
  } catch { good = false; }
  if (!good) return fail();
  if (head.counter > stored.counter) {
    stored.counter = head.counter;
    save();
  }
  fails.delete(ip);
  return { ok: true, session: startSession(ip) };
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionFrom(req) {
  const sid = cookies(req)[COOKIE];
  if (!sid || !/^[0-9a-f]{64}$/.test(sid)) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  const now = Date.now();
  if (now - s.seen > SESSION_IDLE_MS) {
    sessions.delete(sid);
    return null;
  }
  s.seen = now;
  return s;
}

export function destroy(session) {
  if (session) sessions.delete(session.sid);
}

export function cookieFor(session, secure) {
  return `${COOKIE}=${session.sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_IDLE_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function clearCookie(secure) {
  return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

// a browser that sends an Origin must be talking from this very page
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (now - s.seen > SESSION_IDLE_MS) sessions.delete(sid);
  for (const [ip, f] of fails) if (now - f.first > WINDOW_MS && now > f.lockedUntil) fails.delete(ip);
}, 10 * 60 * 1000).unref();

// ---- command line: node server.js set-passcode | enable-totp | disable-totp
let inbuf = '';
let waiter = null;
let ended = false;
let listening = false;

function pump() {
  if (!waiter) return;
  const i = inbuf.indexOf('\n');
  if (i >= 0) {
    const line = inbuf.slice(0, i).replace(/\r$/, '');
    inbuf = inbuf.slice(i + 1);
    const w = waiter;
    waiter = null;
    w(line);
  } else if (ended) {
    const w = waiter;
    waiter = null;
    const line = inbuf;
    inbuf = '';
    w(line);
  }
}

function ask(prompt, hidden) {
  process.stdout.write(prompt);
  if (hidden && process.stdin.isTTY) {
    return new Promise((resolve) => {
      let typed = '';
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      const onKey = (chunk) => {
        for (const c of chunk) {
          if (c === '\r' || c === '\n') {
            process.stdin.setRawMode(false);
            process.stdin.off('data', onKey);
            process.stdin.pause();
            process.stdout.write('\n');
            resolve(typed);
            return;
          }
          if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
          if (c === '\u007f' || c === '\b') typed = typed.slice(0, -1);
          else typed += c;
        }
      };
      process.stdin.on('data', onKey);
    });
  }
  if (!listening) {
    listening = true;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { inbuf += d; pump(); });
    process.stdin.on('end', () => { ended = true; pump(); });
  }
  return new Promise((resolve) => {
    waiter = resolve;
    process.stdin.resume();
    pump();
  });
}

export async function runCli(args, dir) {
  init(dir);
  const cmd = args[0];
  if (cmd === 'set-passcode') {
    let key;
    if (args[1] === 'own') {
      const a = await ask(`your own key (${MIN_PASSCODE}+ characters): `, true);
      const b = await ask('again: ', true);
      if (a !== b) throw new Error('the two did not match, nothing was changed');
      key = a;
    } else {
      key = newKey();
    }
    await setPasscode(key);
    if (args[1] !== 'own') {
      console.log('your key (shown once, keep it in a password manager):');
      console.log(`\n  ${key}\n`);
    }
    console.log('saved. everyone is signed out. restart is not needed.');
    return;
  }
  if (cmd === 'enable-totp') {
    if (!hasPasscode()) throw new Error('set a passcode first: node server.js set-passcode');
    const secret = newTotpSecret();
    console.log('add this to an authenticator app (1Password, Google Authenticator, Authy…):');
    console.log(`  secret   ${secret}`);
    console.log(`  or link  otpauth://totp/minu?secret=${secret}&issuer=minu`);
    const code = await ask('then type the 6-digit code it shows, to confirm: ', false);
    if (!confirmTotp(secret, code)) throw new Error('that code did not match, so it was not turned on');
    console.log('on. signing in now needs the passcode and a code.');
    return;
  }
  if (cmd === 'disable-totp') {
    clearTotp();
    console.log('off. signing in needs only the passcode.');
    return;
  }
  if (cmd === 'list-passkeys') {
    const all = listPasskeys();
    if (!all.length) console.log('no passkeys.');
    for (const k of all) console.log(`  ${k.name}  added ${k.added ? new Date(k.added).toISOString().slice(0, 10) : '?'}`);
    return;
  }
  if (cmd === 'clear-passkeys') {
    clearPasskeys();
    console.log('all passkeys removed. sign in with the key, then add them again.');
    return;
  }
  console.log('usage:  node server.js set-passcode [own] | enable-totp | disable-totp | list-passkeys | clear-passkeys');
}
