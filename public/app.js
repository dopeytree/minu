const canvas = document.getElementById('ink');
const whisper = document.getElementById('whisper');
const cardEl = document.getElementById('card');
const mark = document.getElementById('mark');
// settings were saved under the old name; carry them over once
try {
  for (const k of ['presets', 'cycle', 'pulse', 'vitals', 'icons']) {
    const old = localStorage.getItem(`room.${k}`);
    if (old !== null && localStorage.getItem(`minu.${k}`) === null) localStorage.setItem(`minu.${k}`, old);
  }
} catch { /* private mode */ }

const settings = document.getElementById('settings');
const form = document.getElementById('form');
const urlInput = document.getElementById('url');
const keyInput = document.getElementById('key');
const note = document.getElementById('note');
const trouble = document.getElementById('trouble');
const finder = document.getElementById('finder');
const findInput = document.getElementById('find');
const foundList = document.getElementById('found');
const keysEl = document.getElementById('keys');
const keyHint = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '') ? '⌘K' : 'Ctrl K';
keysEl.textContent = keyHint;
const ptr = { e: 0, sx: -9999, sy: -9999, pull: 0 };
const presetsEl = document.getElementById('presets');
const pfilter = document.getElementById('pfilter');
const listBtn = document.getElementById('showall');
const cycleBtn = document.getElementById('cycle');
const infoEl = document.getElementById('info');
let lastMoveT = -100;
let realActive = false;

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const INKS = [
  [0.90, 0.78, 0.56],
  [0.84, 0.58, 0.36],
  [0.78, 0.44, 0.34],
  [0.64, 0.70, 0.52],
  [0.52, 0.64, 0.76],
  [0.78, 0.50, 0.54],
  [0.70, 0.58, 0.78],
  [0.86, 0.74, 0.48],
  [0.58, 0.66, 0.60],
  [0.82, 0.66, 0.58],
];
const BONE = [0.91, 0.84, 0.70];
const AMBER = [0.86, 0.62, 0.28];
const DRY = [0.48, 0.36, 0.31];
const BRUISE = [0.64, 0.26, 0.28];
const PALE = [0.62, 0.58, 0.52];

const creatures = new Map();
const mouse = { x: -9999, y: -9999, on: false };
let snapshot = null;
let hovered = null;
let pinned = null;
let confirmOp = null;
let loopOn = false;
let last = performance.now();
let announced = false;
let troubleText = '';

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function unit(s) {
  return (hashString(s) % 100000) / 100000;
}

function mix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function damp(cur, target, dt, rate) {
  if (cur == null || Number.isNaN(cur)) return target;
  const k = 1 - Math.exp(-rate * dt);
  return cur + (target - cur) * k;
}

function dampColor(cur, target, dt, rate) {
  if (!cur) return target.slice();
  return [
    damp(cur[0], target[0], dt, rate),
    damp(cur[1], target[1], dt, rate),
    damp(cur[2], target[2], dt, rate),
  ];
}

function inkFor(id) {
  const base = INKS[hashString(id) % INKS.length];
  const j = unit(id + ':c') - 0.5;
  return base.map((v) => Math.min(1, Math.max(0.15, v + j * 0.06)));
}

function living(health) {
  return health === 'up' || health === 'unhealthy' || health === 'paused' || health === 'uneasy';
}

function stateWord(machine) {
  if (!machine) return '';
  if (machine.kind === 'server') {
    if (machine.health === 'down') return 'no answer';
    if (machine.health === 'refused') return 'the api refused';
    if (machine.arrayState && machine.arrayState !== 'STARTED') return 'array stopped';
    if (machine.dockerOff) return 'docker is off';
    return 'awake';
  }
  if (machine.health === 'unhealthy') return 'unhealthy';
  if (machine.health === 'uneasy') return 'unsettled';
  if (machine.health === 'paused') return 'paused';
  if (machine.health === 'crashed') return 'crashed';
  const s = String(machine.state || '').toUpperCase();
  if (s === 'RUNNING' || s === 'IDLE') return 'running';
  if (s === 'EXITED' && /created/i.test(machine.status || '')) return 'created';
  if (s === 'EXITED') return 'exited';
  if (s === 'SHUTOFF' || s === 'SHUTDOWN') return 'shut off';
  return (machine.state || 'quiet').toLowerCase();
}

function pingWord(ping) {
  if (!ping) return '';
  if (!ping.ok) return 'no ping';
  if (ping.ms == null) return '';
  return `${Math.round(ping.ms)} ms`;
}

function tremorFrom(ping, health) {
  if (health === 'down' || health === 'crashed') return 0.75;
  if (health === 'refused') return 0.4;
  if (!ping || ping.ms == null) return health === 'unhealthy' ? 0.28 : 0.04;
  if (ping.ms < 20) return health === 'unhealthy' ? 0.22 : 0.02;
  return Math.min(0.7, (ping.ms - 20) / 380);
}

function targetMood(machine, ping) {
  const health = machine.health || 'down';
  let color = machine.kind === 'server' ? BONE.slice() : inkFor(machine.id);
  let energy = 0.55;
  let alpha = 0.86;
  let broken = 0;
  if (machine.kind === 'server') {
    const cpu = machine.cpu == null ? 0.3 : Math.max(0, Math.min(1, machine.cpu > 1.5 ? machine.cpu / 100 : machine.cpu));
    energy = 0.32 + cpu * 0.62;
    if (health === 'uneasy') color = mix(BONE, AMBER, 0.55);
    if (health === 'refused') { color = PALE.slice(); energy = 0.12; broken = 0.7; alpha = 0.55; }
    if (health === 'down') { color = BRUISE.slice(); energy = 0.06; broken = 0.85; alpha = 0.5; }
  } else if (health === 'up') {
    energy = 0.42 + unit(machine.id + ':e') * 0.4;
    if (machine.update) color = mix(color, AMBER, 0.28);
  } else if (health === 'unhealthy' || health === 'uneasy') {
    color = mix(color, AMBER, 0.6);
    energy = 0.28;
  } else if (health === 'paused') {
    color = mix(color, AMBER, 0.45);
    energy = 0.14;
    alpha = 0.7;
  } else if (health === 'crashed') {
    color = BRUISE.slice();
    energy = 0.08;
    broken = 0.8;
    alpha = 0.55;
  } else {
    color = DRY.slice();
    energy = 0.04;
    alpha = 0.42;
    broken = 0.25;
  }
  if (reduce) energy *= 0.15;
  return { color, energy, alpha, broken, tremor: tremorFrom(ping, health) };
}

function harmonicsFor(id, kind, health) {
  const rnd = mulberry(hashString(id + ':h'));
  const count = kind === 'server' ? 5 : kind === 'vm' ? 3 : living(health) ? 4 : 2;
  const list = [];
  for (let i = 1; i <= count; i++) {
    list.push({
      k: i === 1 ? 1 : i + (rnd() > 0.72 ? 1 : 0),
      ax: (0.4 + rnd() * 0.7) / i,
      ay: (0.4 + rnd() * 0.7) / i,
      px: rnd() * Math.PI * 2,
      py: rnd() * Math.PI * 2,
      spin: (0.18 + rnd() * 0.55) * (rnd() > 0.5 ? 1 : -1),
    });
  }
  const norm = list.reduce((sum, h) => sum + Math.hypot(h.ax, h.ay), 0) || 1;
  return { list, norm, lobes: 1 + Math.floor(rnd() * 3), spinSign: rnd() > 0.5 ? 1 : -1 };
}

function mulberry(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ensure(machine) {
  let c = creatures.get(machine.id);
  if (!c) {
    c = {
      id: machine.id,
      kind: machine.kind,
      seed: unit(machine.id),
      shape: harmonicsFor(machine.id, machine.kind, machine.health),
      shards: makeShards(machine.id, machine.kind),
      flow: 0,
      posX: null,
      posY: null,
      radius: null,
      energy: null,
      alpha: 0,
      broken: 0,
      tremor: 0,
      color: null,
      born: performance.now(),
    };
    creatures.set(machine.id, c);
  } else if (c.kind !== machine.kind) {
    c.kind = machine.kind;
    c.shape = harmonicsFor(machine.id, machine.kind, machine.health);
    c.shards = makeShards(machine.id, machine.kind);
  }
  c.machine = machine;
  c.alive = true;
  return c;
}

function layout(list, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const minSide = Math.min(w, h);
  const wide = w / Math.max(1, h);
  const tall = h / Math.max(1, w);
  const server = list.find((c) => c.kind === 'server');
  if (server) {
    server.homeX = cx;
    server.homeY = cy;
    server.baseR = minSide * 0.112;
  }
  const dance = list.filter((c) => c.kind !== 'server' && living(c.machine.health));
  const quiet = list.filter((c) => c.kind !== 'server' && !living(c.machine.health));
  scatter(dance, cx, cy, minSide * 0.2, minSide * 0.34, minSide * 0.03, minSide * 0.048, wide, tall);
  scatter(quiet, cx, cy, minSide * 0.37, minSide * 0.47, minSide * 0.011, minSide * 0.018, wide, tall);
  for (let n = 0; n < 10; n++) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        let dx = b.homeX - a.homeX;
        let dy = b.homeY - a.homeY;
        const dist = Math.hypot(dx, dy) || 0.001;
        const bothQuiet = !living(a.machine.health) && !living(b.machine.health);
        const min = (a.baseR + b.baseR) * (bothQuiet ? 1.05 : 1.38);
        if (dist >= min) continue;
        const push = (min - dist) / 2;
        const ux = dx / dist;
        const uy = dy / dist;
        if (a.kind !== 'server') { a.homeX -= ux * push; a.homeY -= uy * push; }
        if (b.kind !== 'server') { b.homeX += ux * push; b.homeY += uy * push; }
      }
    }
  }
}

function scatter(group, cx, cy, r0, r1, s0, s1, wide, tall) {
  const ordered = group.slice().sort((a, b) => a.seed - b.seed);
  ordered.forEach((c, i) => {
    const t = (i + 0.5) / Math.max(1, ordered.length);
    const ang = c.seed * Math.PI * 2;
    const rad = r0 + (r1 - r0) * Math.sqrt(t);
    const vmBoost = c.kind === 'vm' ? 1.18 : 1;
    c.homeX = cx + Math.cos(ang) * rad * Math.min(1.25, wide);
    c.homeY = cy + Math.sin(ang) * rad * 0.88 * Math.min(1.15, tall);
    c.baseR = (s0 + (s1 - s0) * unit(c.id + ':s')) * vmBoost;
  });
}

function pointsFor(c, t, originX, originY) {
  const { list, norm, lobes, spinSign } = c.shape;
  const energy = c.energy ?? 0.2;
  const radius = (c.radius || c.baseR || 40) * (1 + (c.beat || 0) * 0.14);
  const rot = t * (0.012 + energy * 0.035) * spinSign;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const n = c.kind === 'server' ? 150 : living(c.machine.health) ? 110 : 64;
  const pts = new Array(n);
  for (let i = 0; i < n; i++) {
    const u = (i / n) * Math.PI * 2;
    let x = 0;
    let y = 0;
    for (const h of list) {
      const phase = t * h.spin * (0.25 + energy * 1.15);
      const swell = 1 + energy * 0.16 * Math.sin(t * 0.7 + h.px);
      x += h.ax * swell * Math.cos(h.k * u + h.px + phase);
      y += h.ay * swell * Math.sin(h.k * u + h.py + phase * 0.85);
    }
    x /= norm;
    y /= norm;
    if (c.kind === 'vm') {
      x = Math.sign(x) * Math.pow(Math.abs(x), 0.74);
      y = Math.sign(y) * Math.pow(Math.abs(y), 0.74);
    }
    const pulse = 1 + energy * 0.07 * Math.sin(t * 1.6 + u * lobes);
    x *= radius * pulse;
    y *= radius * pulse;
    const tremor = (c.tremor || 0) * radius * 0.075;
    x += Math.sin(u * 17 + t * 26) * tremor;
    y += Math.cos(u * 13 + t * 21) * tremor;
    const rx = x * cs - y * sn;
    const ry = x * sn + y * cs;
    pts[i] = { x: originX + rx, y: originY + ry, u: i / n };
  }
  return pts;
}

// Each machine is a drift of glass shards, like light thrown through an old door.
const SHARD_GAIN = 0.4;
const shardData = new Float32Array(16 * 8 * 5000);

function makeShards(id, kind) {
  const rnd = mulberry(hashString(id + ':shards'));
  const n = kind === 'server' ? 48 : kind === 'vm' ? 22 : 18;
  const sign = rnd() > 0.5 ? 1 : -1;
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push({
      // golden-ratio spacing keeps the slivers evenly strung along the path,
      // however many are showing
      u: (i * 0.6180339887 + (rnd() * 0.25) / n) % 1,
      // one flow direction per machine, so the light streams instead of churning
      dir: sign * (0.75 + rnd() * 0.5),
      len: 0.1 + rnd() * rnd() * 0.3,
      wid: 0.09 + rnd() * 0.08,
      ang: (rnd() - 0.5) * 0.8,
      spin: 0.15 + rnd() * 0.5,
      ph: rnd() * Math.PI * 2,
      off: (rnd() - 0.5) * 1.2,
      hue: rnd(),
      bright: 0.5 + rnd() * 0.5,
      lag: 0.6 + rnd() * 0.8,
      tw: rnd() * 6.2,
    });
  }
  return list;
}

function centreVert(o, x, y, ph, col, a) {
  const d = shardData;
  d[o] = x; d[o + 1] = y; d[o + 2] = 0; d[o + 3] = ph;
  d[o + 4] = Math.min(1, col[0] * 1.15);
  d[o + 5] = Math.min(1, col[1] * 1.15);
  d[o + 6] = Math.min(1, col[2] * 1.15);
  d[o + 7] = a;
  return o + 8;
}

function edgeVert(o, x, y, ph, col, h, fringe, a) {
  const k = 6.2831853;
  const d = shardData;
  const r = 0.5 + 0.5 * Math.cos(k * h);
  const g = 0.5 + 0.5 * Math.cos(k * (h + 0.3333));
  const b = 0.5 + 0.5 * Math.cos(k * (h + 0.6667));
  d[o] = x; d[o + 1] = y; d[o + 2] = 1; d[o + 3] = ph;
  d[o + 4] = col[0] + (r - col[0]) * fringe;
  d[o + 5] = col[1] + (g - col[1]) * fringe;
  d[o + 6] = col[2] + (b - col[2]) * fringe;
  d[o + 7] = a;
  return o + 8;
}

// Embers: now and then a sliver sheds a spark that drifts off, cools and dies.
const embers = [];
let frameDt = 0.016;

function addEmbers(o, dt, dpr) {
  const drag = Math.exp(-1.7 * dt);
  for (let i = embers.length - 1; i >= 0; i--) {
    const e = embers[i];
    e.age += dt;
    if (e.age >= e.life) { embers.splice(i, 1); continue; }
    e.vx *= drag;
    e.vy = e.vy * drag - 10 * dpr * dt;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
  }
  for (const e of embers) {
    if (o + 48 > shardData.length) break;
    const k = 1 - e.age / e.life;
    const a = e.a * k * k;
    const sp = Math.hypot(e.vx, e.vy) || 1;
    const dx = e.vx / sp;
    const dy = e.vy / sp;
    const len = Math.max(3 * dpr, sp * 0.1);
    const w = e.sz * (0.5 + 0.5 * k);
    const tip = [Math.min(1, e.col[0] + 0.15), e.col[1] * 0.55, e.col[2] * 0.3];
    o = centreVert(o, e.x - dy * w, e.y + dx * w, e.ph, e.col, a);
    o = centreVert(o, e.x + dy * w, e.y - dx * w, e.ph, e.col, a);
    o = centreVert(o, e.x - dx * len, e.y - dy * len, e.ph, tip, 0);
  }
  return o;
}

function addShards(c, pts, t, dpr, o, spot) {
  const n = pts.length;
  const energy = c.energy || 0.1;
  const total = c.shards.length;
  const count = Math.min(total, Math.ceil(total * Math.max(0.35, Math.min(1, 0.35 + energy * 1.6))));
  const radius = (c.radius || c.baseR || 40) * dpr * (1 + (c.beat || 0) * 0.14);
  const col = c.color || BONE;
  const beat = c.beat || 0;
  const health = c.machine.health;
  const fringe = c.kind === 'server' ? 0.3 : health === 'up' ? 0.35 : health === 'down' || health === 'crashed' ? 0.06 : 0.2;
  const gain = SHARD_GAIN * (0.8 + beat * 0.5) * (c.alpha || 0) * spot * (c.kind === 'server' ? 0.65 : 1);
  const broken = c.broken || 0;
  const pull = reduce ? 0 : ptr.pull;
  const pxm = ptr.sx * dpr;
  const pym = ptr.sy * dpr;
  const reach = Math.min(viewW, viewH) * 0.26;
  const flow = c.flow || 0;
  for (let i = 0; i < count; i++) {
    if (o + 128 > shardData.length) break;
    const s = c.shards[i];
    const u = (((s.u + flow * s.dir) % 1) + 1) % 1;
    const f = u * n;
    const i0 = Math.floor(f) % n;
    const p0 = pts[i0];
    const p1 = pts[(i0 + 1) % n];
    const k = f - Math.floor(f);
    let tx = p1.x - p0.x;
    let ty = p1.y - p0.y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    let mx = p0.x + (p1.x - p0.x) * k - ty * s.off * radius * 0.2;
    let my = p0.y + (p1.y - p0.y) * k + tx * s.off * radius * 0.2;
    let near = 0;
    if (pull > 0.01) {
      const dxp = pxm - mx;
      const dyp = pym - my;
      const dist = Math.hypot(dxp, dyp) || 1;
      near = Math.min(1, Math.exp(-(dist * dist) / (reach * reach)) * pull * s.lag);
      const gap = Math.max(0, dist - radius * 0.12) / dist;
      const sw = Math.sin(t * s.spin + s.ph) * 12 * dpr * near;
      mx += dxp * gap * near * 0.55 - (dyp / dist) * sw;
      my += dyp * gap * near * 0.55 + (dxp / dist) * sw;
    }
    // slivers lie along the path they travel, with only a slight tilt
    const ang = Math.atan2(ty, tx) + s.ang + Math.sin(t * s.spin + s.ph) * 0.18;
    // at rest the slivers are small; they open up near the pointer and on the heartbeat
    const live = Math.min(1, near * 1.2 + ptr.e * 0.5 + beat * 0.8 + (spot > 1 ? 1 : 0));
    const L = Math.max(4 * dpr, radius * s.len * (0.5 + 0.5 * live)) * (1 + beat * 0.35 + near * 0.5) * (spot > 1 ? 1.3 : 1);
    const W = L * s.wid;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const ax = mx + ca * L * 0.6;
    const ay = my + sa * L * 0.6;
    const bx = mx + ca * L * 0.1 - sa * W;
    const by = my + sa * L * 0.1 + ca * W;
    const cx = mx - ca * L * 0.4;
    const cy = my - sa * L * 0.4;
    const dx = mx + ca * L * 0.1 + sa * W;
    const dy = my + sa * L * 0.1 - ca * W;
    let alpha = gain * s.bright * (1 + near * 1.1) * (1.3 - 0.3 * live);
    if (broken > 0 && Math.abs(u - 0.7) < 0.2 * broken) alpha *= 0.15;
    const ph = s.tw;
    const h = s.hue + t * 0.015;
    // the sliver drags a fading streak behind its travel, cooling toward ember
    const sgn = s.dir > 0 ? 1 : -1;
    const vx = sgn * tx;
    const vy = sgn * ty;
    const trailLen = L * (1.2 + 1.8 * live);
    const trailW = W * 0.8;
    const trailCol = [Math.min(1, col[0] + 0.12), col[1] * 0.62, col[2] * 0.4];
    o = centreVert(o, mx - vy * trailW, my + vx * trailW, ph, col, alpha * 0.7);
    o = centreVert(o, mx + vy * trailW, my - vx * trailW, ph, col, alpha * 0.7);
    o = centreVert(o, mx - vx * trailLen, my - vy * trailLen, ph, trailCol, 0);
    if (!reduce && embers.length < 420 && Math.random() < frameDt * (0.1 + energy * 0.5 + live * 0.5)) {
      const sp = (25 + Math.random() * 55) * dpr;
      const side = (Math.random() - 0.5) * 2;
      embers.push({
        x: mx,
        y: my,
        vx: vx * sp * 0.5 - vy * side * sp * 0.6,
        vy: vy * sp * 0.5 + vx * side * sp * 0.6 - 12 * dpr,
        age: 0,
        life: 0.7 + Math.random() * 1.0,
        a: alpha,
        col: [col[0], col[1], col[2]],
        ph: s.tw,
        sz: (1.2 + Math.random() * 1.6) * dpr,
      });
    }
    o = centreVert(o, mx, my, ph, col, alpha);
    o = edgeVert(o, ax, ay, ph, col, h, fringe, alpha);
    o = edgeVert(o, bx, by, ph, col, h + 0.17, fringe, alpha);
    o = centreVert(o, mx, my, ph, col, alpha);
    o = edgeVert(o, bx, by, ph, col, h + 0.17, fringe, alpha);
    o = edgeVert(o, cx, cy, ph, col, h + 0.34, fringe, alpha);
    o = centreVert(o, mx, my, ph, col, alpha);
    o = edgeVert(o, cx, cy, ph, col, h + 0.34, fringe, alpha);
    o = edgeVert(o, dx, dy, ph, col, h + 0.51, fringe, alpha);
    o = centreVert(o, mx, my, ph, col, alpha);
    o = edgeVert(o, dx, dy, ph, col, h + 0.51, fringe, alpha);
    o = edgeVert(o, ax, ay, ph, col, h, fringe, alpha);
  }
  return o;
}

const gl = canvas.getContext('webgl', {
  alpha: false,
  antialias: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
});

if (!gl) {
  note.textContent = 'this browser cannot draw on the gpu';
  settings.hidden = false;
}

const inkVs = `
attribute vec2 a_pos;
attribute float a_across;
attribute float a_along;
attribute vec3 a_color;
attribute float a_alpha;
uniform vec2 u_res;
varying float v_across;
varying float v_along;
varying vec3 v_color;
varying float v_alpha;
void main() {
  vec2 clip = (a_pos / u_res) * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
  v_across = a_across;
  v_along = a_along;
  v_color = a_color;
  v_alpha = a_alpha;
}`;

const inkFs = `
precision mediump float;
varying float v_across;
varying float v_along;
varying vec3 v_color;
varying float v_alpha;
uniform float u_time;
void main() {
  float d = clamp(abs(v_across), 0.0, 1.0);
  float body = 1.0 - smoothstep(0.9, 1.0, d);
  float core = exp(-d * d * 1.4);
  float rate = 1.0 + floor(v_along * 0.5);
  float flash = pow(0.5 + 0.5 * sin(v_along - u_time * rate), 7.0);
  float a = v_alpha * body * (0.45 + 0.55 * core * (0.5 + 1.0 * flash));
  gl_FragColor = vec4(v_color * (0.75 + 0.7 * flash) * a, a);
}`;

const quadVs = `
attribute vec2 a_pos;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_uv = a_uv;
}`;

const fadeFs = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_fade;
uniform float u_zoom;
void main() {
  vec2 uv = 0.5 + (v_uv - 0.5) * u_zoom;
  vec4 prev = texture2D(u_tex, uv);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) prev = vec4(0.0);
  gl_FragColor = max(prev * u_fade - vec4(0.008), vec4(0.0));
}`;

const paperFs = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_time;
uniform vec2 u_res;
uniform vec4 u_rip[4];
uniform vec3 u_ptr;
uniform vec4 u_rip2[4];
uniform float u_dpr;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float organic(float a, float seed, float age) {
  return 0.50 * sin(3.0 * a + seed + age * 0.9)
       + 0.32 * sin(5.0 * a + seed * 1.7 - age * 0.7)
       + 0.20 * sin(8.0 * a + seed * 2.3 + age * 1.3)
       + 0.10 * sin(13.0 * a + seed * 0.6 - age * 1.9);
}
vec3 tap(vec2 uv) {
  return texture2D(u_tex, uv).rgb;
}
void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 off = vec2(0.0);
  float rim = 0.0;
  float trough = 0.0;
  vec3 beam = vec3(0.0);
  vec2 lens = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    vec4 r = u_rip[i];
    vec4 r2 = u_rip2[i];
    if (r.w > 0.001) {
      vec2 dv = px - r.xy;
      float d = length(dv);
      vec2 dir = dv / max(d, 1.0);
      float a = atan(dv.y, dv.x);
      vec2 ad = vec2(cos(a), sin(a));
      float nLo = vnoise(ad * 3.0 + vec2(r2.x, r2.y * 0.6));
      float nHi = vnoise(ad * 11.0 + vec2(r2.x * 2.0, -r2.y * 1.4));
      // reach varies with direction, and the front crinkles as it grows
      float rr = r.z * (1.0 + (0.2 * organic(a, r2.x, r2.y) + 0.14 * (nHi - 0.5)) * (1.0 + r2.z));
      // brightness falls away as the beam nears the outer screen
      float edge = pow(1.0 - clamp(rr / (length(u_res) * 0.6), 0.0, 1.0), 1.6);
      float rw = r.w * edge;
      // parts of the beam simply do not render, more of it as it fades
      float thr = mix(0.66, 0.34, rw) + 0.14 * r2.z;
      vec3 tint = mix(vec3(1.0, 0.97, 0.94), vec3(1.0, 0.3, 0.24), r2.w);
      float gate = smoothstep(thr, thr + 0.07, nLo) * (0.45 + 0.55 * smoothstep(0.28, 0.5, nHi));
      float hw = (0.55 + 0.7 * nHi) * u_dpr;
      float split = u_dpr * (1.1 + 1.6 * rw);
      float xr = (d - rr - split) / hw;
      float xg = (d - rr) / hw;
      float xb = (d - rr + split) / hw;
      float inten = (0.35 + 0.65 * smoothstep(-0.25, 0.6, sin(2.0 * a + r2.x * 2.0 - r2.y * 0.8))) * gate;
      beam += vec3(exp(-xr * xr), exp(-xg * xg), exp(-xb * xb)) * tint * rw * inten;
      // lens: the picture is drawn in toward the beam, and colour splits as it bends
      float bend = (d - rr) / (16.0 * u_dpr);
      float soft = exp(-bend * bend);
      lens += -dir * bend * soft * 22.0 * u_dpr * rw * (0.4 + 1.2 * nLo) * (0.5 + 0.5 * gate);
      float slope = -2.0 * bend * soft;
      rim += max(slope, 0.0) * rw * 0.5;
      trough += max(-slope, 0.0) * rw * 0.5;
    }
  }
  if (u_ptr.z > 0.01) {
    vec2 dp = px - u_ptr.xy;
    float reachPx = u_res.y * 0.2;
    float f = exp(-dot(dp, dp) / (reachPx * reachPx)) * u_ptr.z;
    vec2 q = px * vec2(0.035, 0.09) * 0.5;
    float nx = vnoise(q + vec2(u_time * 0.9, 0.0)) - 0.5;
    float ny = vnoise(q * 1.3 + vec2(11.0, -u_time * 0.8)) - 0.5;
    off += vec2(nx, ny) * 2.0 * f * u_res.y * 0.035;
  }
  // shards stay on top and only feel the pointer's water; the ripple's lens
  // bends the light behind them
  vec2 o = off / u_res;
  vec2 ol = (off + lens) / u_res;
  vec2 oR = (off + lens * 1.7) / u_res;
  vec2 oB = (off + lens * 0.45) / u_res;
  vec3 core = tap(v_uv + o);
  vec3 bleed = vec3(tap(v_uv + oR).r, tap(v_uv + ol).g, tap(v_uv + oB).b);
  vec3 ghost = max(bleed - core, 0.0) * 1.4;

  float wr = u_res.y * 0.03 / u_res.y;
  vec3 wash = vec3(0.0);
  for (int k = 0; k < 8; k++) {
    float a = float(k) * 0.7854;
    vec2 d = vec2(cos(a) * u_res.y / u_res.x, sin(a)) * wr;
    wash += tap(v_uv + ol + d) + tap(v_uv + ol + d * 2.4);
  }
  wash /= 16.0;
  wash *= 0.6;

  vec2 sh = vec2(0.009 * u_res.y / u_res.x, -0.014);
  float shadow = 0.0;
  for (int k = 0; k < 4; k++) {
    vec2 d = sh * (0.6 + float(k) * 0.5);
    vec3 s = tap(v_uv + o + d);
    shadow += (s.r + s.g + s.b) * 0.3333;
  }
  shadow = clamp(shadow * 0.25 * 1.6, 0.0, 1.0);
  float coreLum = clamp((core.r + core.g + core.b) * 0.3333 * 2.0, 0.0, 1.0);

  float vign = smoothstep(0.95, 0.22, length(v_uv - 0.5));
  vec3 paper = vec3(0.055, 0.047, 0.040) * mix(0.7, 1.0, vign);
  paper *= 1.0 - 0.55 * shadow * (1.0 - coreLum);
  vec3 lit = (paper * (1.0 + wash * 5.0) + wash * vec3(0.26, 0.2, 0.14) + ghost) * (1.0 + rim * 0.55 - trough * 0.4);
  vec3 col = lit + core;
  col = col * 1.25 / (1.0 + col * 0.65);
  col += vec3(1.0) * rim * 0.012;
  col += min(beam, vec3(1.0)) * (1.0 - coreLum);
  float g = hash(px + fract(u_time * 0.17)) - 0.5;
  gl_FragColor = vec4(col + g * 0.007, 1.0);
}`;

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'shader');
  }
  return shader;
}

function program(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) || 'link');
  }
  return p;
}

let inkProg;
let fadeProg;
let paperProg;
let strokeBuf;
let quadBuf;
let frames = [];
let writeI = 0;
let viewW = 0;
let viewH = 0;

function makeTarget(w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, w, h };
}

function bootGl() {
  if (!gl) return;
  inkProg = program(inkVs, inkFs);
  fadeProg = program(quadVs, fadeFs);
  paperProg = program(quadVs, paperFs);
  strokeBuf = gl.createBuffer();
  quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 0, 0,
    1, -1, 1, 0,
    -1, 1, 0, 1,
    1, 1, 1, 1,
  ]), gl.STATIC_DRAW);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
}

function resize() {
  if (!gl) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(2, Math.floor(window.innerWidth * dpr));
  const h = Math.max(2, Math.floor(window.innerHeight * dpr));
  if (w === viewW && h === viewH && frames.length === 2) return;
  viewW = w;
  viewH = h;
  canvas.width = w;
  canvas.height = h;
  frames = [makeTarget(w, h), makeTarget(w, h)];
  gl.bindFramebuffer(gl.FRAMEBUFFER, frames[0].fbo);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, frames[1].fbo);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  placeAll();
}

function resetAttribs() {
  const n = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) || 8;
  for (let i = 0; i < n; i++) gl.disableVertexAttribArray(i);
}

function drawQuad(prog) {
  gl.useProgram(prog);
  resetAttribs();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  const pos = gl.getAttribLocation(prog, 'a_pos');
  const uv = gl.getAttribLocation(prog, 'a_uv');
  gl.enableVertexAttribArray(pos);
  gl.enableVertexAttribArray(uv);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 16, 0);
  gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function drawStroke(data) {
  gl.useProgram(inkProg);
  resetAttribs();
  gl.bindBuffer(gl.ARRAY_BUFFER, strokeBuf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  const stride = 32;
  const loc = {
    pos: gl.getAttribLocation(inkProg, 'a_pos'),
    across: gl.getAttribLocation(inkProg, 'a_across'),
    along: gl.getAttribLocation(inkProg, 'a_along'),
    color: gl.getAttribLocation(inkProg, 'a_color'),
    alpha: gl.getAttribLocation(inkProg, 'a_alpha'),
  };
  gl.enableVertexAttribArray(loc.pos);
  gl.enableVertexAttribArray(loc.across);
  gl.enableVertexAttribArray(loc.along);
  gl.enableVertexAttribArray(loc.color);
  gl.enableVertexAttribArray(loc.alpha);
  gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, stride, 0);
  gl.vertexAttribPointer(loc.across, 1, gl.FLOAT, false, stride, 8);
  gl.vertexAttribPointer(loc.along, 1, gl.FLOAT, false, stride, 12);
  gl.vertexAttribPointer(loc.color, 3, gl.FLOAT, false, stride, 16);
  gl.vertexAttribPointer(loc.alpha, 1, gl.FLOAT, false, stride, 28);
  gl.uniform2f(gl.getUniformLocation(inkProg, 'u_res'), viewW, viewH);
  gl.uniform1f(gl.getUniformLocation(inkProg, 'u_time'), glintTime);
  gl.drawArrays(gl.TRIANGLES, 0, data.length / 8);
}

function schedule() {
  if (document.hidden) setTimeout(() => frame(performance.now()), 32);
  else requestAnimationFrame(frame);
}

function frame(now) {
  if (!loopOn) return;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  frameDt = dt;
  resize();
  const t = now / 1000;
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  const dpr = viewW / Math.max(1, cssW);
  step(dt, t, cssW, cssH);
  if (gl && frames.length === 2) {
    const prev = frames[1 - writeI];
    const next = frames[writeI];
    gl.bindFramebuffer(gl.FRAMEBUFFER, next.fbo);
    gl.viewport(0, 0, viewW, viewH);
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, prev.tex);
    gl.useProgram(fadeProg);
    gl.uniform1i(gl.getUniformLocation(fadeProg, 'u_tex'), 0);
    gl.uniform1f(gl.getUniformLocation(fadeProg, 'u_fade'), reduce ? 0.8 : 0.84);
    gl.uniform1f(gl.getUniformLocation(fadeProg, 'u_zoom'), reduce ? 1 : 1 + globalBeat * 0.002);
    drawQuad(fadeProg);
    glintTime = (t * 1.3) % 6.2831853;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    let filled = 0;
    for (const c of creatures.values()) {
      if ((c.alpha || 0) < 0.02 || !c.draw || !c.shards) continue;
      const pts = pointsFor(c, t, c.drawX * dpr, c.drawY * dpr);
      filled = addShards(c, pts, t, dpr, filled, c === focusC ? 1.6 : 1);
    }
    filled = addEmbers(filled, dt, dpr);
    if (filled > 0) drawStroke(shardData.subarray(0, filled));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, viewW, viewH);
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, next.tex);
    gl.useProgram(paperProg);
    gl.uniform1i(gl.getUniformLocation(paperProg, 'u_tex'), 0);
    gl.uniform1f(gl.getUniformLocation(paperProg, 'u_time'), t);
    gl.uniform2f(gl.getUniformLocation(paperProg, 'u_res'), viewW, viewH);
    gl.uniform3f(gl.getUniformLocation(paperProg, 'u_ptr'), ptr.sx * dpr, (cssH - ptr.sy) * dpr, ptr.pull > 0.01 && !reduce ? ptr.e : 0);
    gl.uniform4fv(gl.getUniformLocation(paperProg, 'u_rip[0]'), rippleUniforms(t, cssW, cssH, dpr));
    gl.uniform4fv(gl.getUniformLocation(paperProg, 'u_rip2[0]'), rippleBuf2);
    gl.uniform1f(gl.getUniformLocation(paperProg, 'u_dpr'), dpr);
    drawQuad(paperProg);
    writeI = 1 - writeI;
  }
  placeWhisper();
  waterStep(now);
  rippleDom(t, cssW, cssH);
  vitalsStep(dt);
  schedule();
}

let glintTime = 0;
let globalBeat = 0;
const beatState = { start: -100, next: 3, count: 3 };

function envelope(tau) {
  if (tau < 0 || tau > 2) return 0;
  const lub = Math.exp(-Math.pow((tau - 0.05) / 0.07, 2));
  const dub = 0.6 * Math.exp(-Math.pow((tau - 0.36) / 0.09, 2));
  return lub + dub;
}

function beatAt(t) {
  let sum = 0;
  for (let i = 0; i < beatState.count; i++) sum += envelope(t - beatState.start - i * 1.05);
  return sum;
}

const ripples = [];
const rippleQueue = [];
const RIPPLE_LIFE = 2.4;
const rippleBuf = new Float32Array(16);
const rippleBuf2 = new Float32Array(16);

function rippleUniforms(t, cssW, cssH, dpr) {
  rippleBuf.fill(0);
  rippleBuf2.fill(0);
  const srv = creatures.get('server');
  const cx = srv && srv.drawX != null ? srv.drawX : cssW / 2;
  const cy = srv && srv.drawY != null ? srv.drawY : cssH / 2;
  const speed = Math.max(cssW, cssH) * 0.5;
  const live = ripples.slice(-4);
  live.forEach((r, i) => {
    const age = t - r.t0;
    const fade = Math.max(0, 1 - age / (r.life || RIPPLE_LIFE));
    rippleBuf[i * 4] = cx * dpr;
    rippleBuf[i * 4 + 1] = (cssH - cy) * dpr;
    rippleBuf[i * 4 + 2] = age * speed * (r.spd || 1) * dpr;
    rippleBuf[i * 4 + 3] = r.k * Math.pow(fade, 0.7);
    rippleBuf2[i * 4] = r.seed;
    rippleBuf2[i * 4 + 1] = age;
    rippleBuf2[i * 4 + 2] = r.rough || 0;
    rippleBuf2[i * 4 + 3] = r.fail || 0;
  });
  return rippleBuf;
}

// The ripple passes through the glass too: as the ring crosses a button or a
// panel it is pushed outward and swells, then settles back.
const rippleTouched = new Set();

// the same uneven reach the shader gives the beam, so the glass is met in step
function organic(a, seed, age) {
  return 0.5 * Math.sin(3 * a + seed + age * 0.9)
    + 0.32 * Math.sin(5 * a + seed * 1.7 - age * 0.7)
    + 0.2 * Math.sin(8 * a + seed * 2.3 + age * 1.3)
    + 0.1 * Math.sin(13 * a + seed * 0.6 - age * 1.9);
}

function rippleDom(t, cssW, cssH) {
  if (reduce) return;
  const live = ripples.slice(-4);
  if (!live.length && !rippleTouched.size) return;
  const srv = creatures.get('server');
  const cx = srv && srv.drawX != null ? srv.drawX : cssW / 2;
  const cy = srv && srv.drawY != null ? srv.drawY : cssH / 2;
  const speed = Math.max(cssW, cssH) * 0.5;
  const seen = new Set();
  const reach = Math.hypot(cssW, cssH) * 0.6;
  if (live.length) {
    document.querySelectorAll('.glass:not([hidden]), .act').forEach((el) => {
      const r = el.getBoundingClientRect();
      const small = Math.min(r.width, r.height);
      if (!small) return;
      const dx = r.left + r.width / 2 - cx;
      const dy = r.top + r.height / 2 - cy;
      const d = Math.hypot(dx, dy) || 1;
      let ring = 0;
      const ang = Math.atan2(-dy, dx);
      for (const rp of live) {
        const age = t - rp.t0;
        const fade = Math.max(0, 1 - age / (rp.life || RIPPLE_LIFE));
        const front = age * speed * (rp.spd || 1) * (1 + 0.2 * (1 + (rp.rough || 0)) * organic(ang, rp.seed, age));
        const x = (d - front) / 18;
        const edge = Math.pow(1 - Math.min(1, front / reach), 1.6);
        ring += rp.k * Math.pow(fade, 0.7) * edge * Math.exp(-x * x);
      }
      if (ring < 0.01) return;
      const push = ring * (small < 90 ? 8 : 3.5);
      el.style.translate = `${((dx / d) * push).toFixed(2)}px ${((dy / d) * push).toFixed(2)}px`;
      el.style.scale = (1 + ring * Math.min(0.14, 6 / small)).toFixed(4);
      if (el.classList.contains('act')) el.style.filter = `brightness(${(1 + ring * 0.3).toFixed(3)})`;
      seen.add(el);
    });
  }
  rippleTouched.forEach((el) => {
    if (seen.has(el)) return;
    el.style.translate = '';
    el.style.scale = '';
    if (el.classList.contains('act')) el.style.filter = '';
  });
  rippleTouched.clear();
  seen.forEach((el) => rippleTouched.add(el));
}

// The virtual cursor: it circles the middle light at a drifting speed and
// radius, now and then reverses, and sometimes wanders out to the outer edges.
const auto = { mode: 'orbit', until: 0, th: 0, w: 1.8, dir: 1, rk: 1, rkT: 1, ph: 0, tx: 0, ty: 0, rate: 6 };

function nextAuto(t, w, h) {
  if (auto.mode === 'roam' || Math.random() < 0.5) {
    auto.mode = 'orbit';
    auto.until = t + 4 + Math.random() * 7;
    auto.dir = Math.random() < 0.7 ? 1 : -1;
    auto.w = 0.7 + Math.random() * 2.3;
    auto.rkT = 0.55 + Math.random() * 1.1;
    auto.ph = Math.random() * 6.28;
    return;
  }
  auto.mode = 'roam';
  auto.until = t + 3.5 + Math.random() * 3;
  auto.dir = Math.random() < 0.5 ? 1 : -1;
  auto.w = 1.2 + Math.random() * 1.8;
  const far = [...creatures.values()].filter((c) => !c.gone && c.kind !== 'server' && c.drawX != null
    && Math.hypot(c.drawX - w / 2, c.drawY - h / 2) > Math.min(w, h) * 0.28);
  if (far.length && Math.random() < 0.65) {
    const c = far[Math.floor(Math.random() * far.length)];
    auto.tx = c.drawX;
    auto.ty = c.drawY;
  } else {
    const ang = Math.random() * Math.PI * 2;
    auto.tx = Math.min(w - 40, Math.max(40, w / 2 + Math.cos(ang) * w * (0.34 + Math.random() * 0.14)));
    auto.ty = Math.min(h - 40, Math.max(40, h / 2 + Math.sin(ang) * h * (0.34 + Math.random() * 0.14)));
  }
}

function wander(t, dt, w, h) {
  if (t >= auto.until) nextAuto(t, w, h);
  const hub = creatures.get('server');
  const hx = hub && hub.drawX != null ? hub.drawX : w / 2;
  const hy = hub && hub.drawY != null ? hub.drawY : h / 2;
  const speed = auto.w * (1 + 0.35 * Math.sin(t * 0.9 + auto.ph));
  auto.th += auto.dir * speed * dt;
  auto.rate = damp(auto.rate, auto.mode === 'roam' ? 1.7 : 6, dt, 2);
  if (auto.mode === 'roam') {
    const loop = Math.min(w, h) * 0.05;
    return [auto.tx + Math.cos(auto.th) * loop, auto.ty + Math.sin(auto.th) * loop];
  }
  auto.rk = damp(auto.rk, auto.rkT, dt, 0.8);
  const base = hub && hub.radius ? hub.radius : Math.min(w, h) * 0.11;
  const rad = base * auto.rk * (1 + 0.14 * Math.sin(t * 1.4));
  return [hx + Math.cos(auto.th) * rad * 1.1, hy + Math.sin(auto.th) * rad * 0.9];
}

function step(dt, t, w, h) {
  const list = [...creatures.values()];
  const ping = snapshot && snapshot.ping;
  ptr.e *= Math.exp(-dt * 3.1);
  // Your pointer drives the light while you use it. When it rests, a virtual
  // cursor takes over and circles the middle light, clockwise and slowly.
  const realOn = mouse.on && t - lastMoveT < 3.5;
  realActive = realOn;
  let aimX = null;
  let aimY = null;
  if (realOn) {
    aimX = mouse.x;
    aimY = mouse.y;
  } else if (!reduce) {
    const spot = wander(t, dt, w, h);
    aimX = spot[0];
    aimY = spot[1];
    ptr.e = Math.max(ptr.e, Math.min(0.7, 0.2 + 0.18 * auto.w));
  }
  ptr.pull = damp(ptr.pull, aimX != null ? 1 : 0, dt, 2.5);
  if (aimX != null) {
    const rate = realOn ? 10 : auto.rate;
    ptr.sx = ptr.sx < -5000 ? aimX : damp(ptr.sx, aimX, dt, rate);
    ptr.sy = ptr.sy < -5000 ? aimY : damp(ptr.sy, aimY, dt, rate);
  }
  const faint = snapshot && snapshot.server && snapshot.server.health === 'down';
  const amp = (reduce ? 0.25 : 1) * (faint ? 0.35 : 1);
  while (rippleQueue.length && rippleQueue[0].at <= t) {
    const q = rippleQueue.shift();
    ripples.push({
      t0: q.at,
      k: q.k,
      spd: q.spd,
      rough: q.rough,
      fail: q.fail,
      life: q.life,
      seed: Math.random() * 6.2831853,
    });
  }
  for (let i = ripples.length - 1; i >= 0; i--) {
    if (t - ripples[i].t0 > (ripples[i].life || RIPPLE_LIFE)) ripples.splice(i, 1);
  }
  globalBeat = beatAt(t) * amp;
  void faint;
  const midX = w / 2;
  const midY = h / 2;
  const reach = Math.min(w, h) * 4;
  let nearest = null;
  let nearestD = 72;
  for (const c of list) {
    const mood = targetMood(c.machine, ping);
    c.color = dampColor(c.color, mood.color, dt, 2.2);
    c.energy = damp(c.energy, mood.energy, dt, 1.4);
    c.alpha = damp(c.alpha, c.gone ? 0 : mood.alpha, dt, c.gone ? 1.2 : 1.6);
    c.broken = damp(c.broken, mood.broken, dt, 1.8);
    c.tremor = damp(c.tremor, mood.tremor, dt, 1.5);
    c.radius = damp(c.radius, c.baseR || 30, dt, 1.3);
    if (c.posX == null) { c.posX = c.homeX; c.posY = c.homeY; }
    c.posX = damp(c.posX, c.homeX, dt, 1.05);
    c.posY = damp(c.posY, c.homeY, dt, 1.05);
    let x = c.posX + Math.sin(t * 0.07 + c.seed * 8) * 16 * (c.energy || 0);
    let y = c.posY + Math.cos(t * 0.05 + c.seed * 5) * 12 * (c.energy || 0);
    const delay = Math.hypot((c.homeX || midX) - midX, (c.homeY || midY) - midY) / reach;
    c.beat = beatAt(t - delay) * amp;
    const swell = 1 + c.beat * 0.035;
    x = midX + (x - midX) * swell;
    y = midY + (y - midY) * swell;
    if (ptr.pull > 0.01) {
      const dxp = ptr.sx - x;
      const dyp = ptr.sy - y;
      const dd = Math.hypot(dxp, dyp) || 1;
      const reachC = Math.min(w, h) * 0.3;
      const lean = Math.exp(-(dd * dd) / (reachC * reachC)) * ptr.pull * 0.07;
      x += dxp * lean;
      y += dyp * lean;
    }
    c.flow = (c.flow || 0) + dt * (0.02 + (c.energy || 0) * 0.09);
    c.drawX = x;
    c.drawY = y;
    c.draw = true;
    if (c.gone && c.alpha < 0.02) {
      creatures.delete(c.id);
      continue;
    }
    if (!mouse.on || pinned) continue;
    const hit = Math.max(28, (c.radius || 20) * 1.15);
    const d = Math.hypot(mouse.x - x, mouse.y - y);
    if (d < hit && d < nearestD) {
      nearest = c;
      nearestD = d;
    }
  }
  if (!pinned) hovered = focusC || nearest;
}

function placeAll() {
  const list = [...creatures.values()].filter((c) => !c.gone);
  if (!list.length) return;
  layout(list, window.innerWidth, window.innerHeight);
}

function apply(data) {
  snapshot = data;
  document.documentElement.dataset.ready = data.configured && !data.error ? '1' : '0';
  const incoming = new Map();
  const machines = data.machines && data.machines.length
    ? data.machines
    : [data.server || { id: 'server', kind: 'server', name: 'server', health: 'down' }];
  for (const machine of machines) incoming.set(machine.id, machine);
  for (const [id, c] of creatures) {
    if (!incoming.has(id)) c.gone = true;
  }
  for (const machine of incoming.values()) ensure(machine);
  placeAll();
  renderFound();
  if (linksOpen()) renderLinks();
  if (data.server && data.server.name && data.server.name !== 'server') {
    document.title = data.server.name;
  }
  mark.classList.toggle('bad', Boolean(data.error) || (data.server && data.server.health === 'down'));
  if ((data.error || data.configured === false) && !announced) {
    announced = true;
    if (data.configured === false || data.auth) openSettings();
  }
  const down = machines
    .filter((m) => m.kind !== 'server' && (m.health === 'down' || m.health === 'crashed' || m.health === 'unhealthy'))
    .map((m) => `${m.name} is ${stateWord(m)}`);
  const line = down.length ? `${down.length} quiet. ${down.slice(0, 6).join('. ')}.` : '';
  if (line !== troubleText) {
    troubleText = line;
    trouble.textContent = line;
  }
  if (pinned) {
    const next = incoming.get(pinned.id);
    if (next) pinned.machine = next;
    else pinned = null;
    renderCard();
  }
}

function placeWhisper() {
  const c = pinned || hovered;
  if (!c || !c.machine) {
    whisper.hidden = true;
    return;
  }
  const m = c.machine;
  const second = m.kind === 'server'
    ? escapeHtml([pingWord(snapshot && snapshot.ping), m.cpu != null ? `${Math.round(m.cpu)}%` : ''].filter(Boolean).join(' · '))
    : `${escapeHtml(stateWord(m))}${m.stats ? ` · ${lab('cpu')} ${fmtPct(m.stats.cpu)}` : ''}`;
  const key = `${m.name}|${second}`;
  if (whisper.dataset.key !== key) {
    whisper.dataset.key = key;
    whisper.innerHTML = `<b>${escapeHtml(m.name)}</b>${second ? `<br>${second}` : ''}`;
  }
  whisper.hidden = false;
}

// The water wobble from birdsongs.ai: text near a moving pointer is warped by
// an SVG turbulence map, stronger when the pointer is faster, easing out after.
const waterTargets = [
  {
    turb: document.getElementById('wt-a'),
    map: document.getElementById('wd-a'),
    url: 'url(#water-a)',
    pick: () => whisper,
  },
];
const waterOn = [null, null];

function waterStep(now) {
  const fx = (0.035 + 0.008 * Math.sin(now / 380)).toFixed(4);
  const fy = (0.09 + 0.015 * Math.cos(now / 520)).toFixed(4);
  waterTargets.forEach((tg, i) => {
    const el = tg.pick();
    let e = 0;
    if (el && !el.hidden && realActive && ptr.e > 0.03 && !reduce) {
      const r = el.getBoundingClientRect();
      const dx = Math.max(r.left - mouse.x, 0, mouse.x - r.right);
      const dy = Math.max(r.top - mouse.y, 0, mouse.y - r.bottom);
      const n = Math.hypot(dx, dy);
      if (n < 150) e = (1 - n / 150) * ptr.e;
    }
    if (waterOn[i] && waterOn[i] !== el) waterOn[i].style.filter = '';
    if (e > 0.04 && el) {
      tg.turb.setAttribute('baseFrequency', `${fx} ${fy}`);
      tg.map.setAttribute('scale', (e * 18).toFixed(1));
      el.style.filter = tg.url;
      waterOn[i] = el;
    } else if (waterOn[i]) {
      waterOn[i].style.filter = '';
      waterOn[i] = null;
    }
  });
}

function humanError(s) {
  if (/forbidden/i.test(s || '')) return 'the key can look, but not change that';
  return s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function ago(iso) {
  const then = Date.parse(iso);
  if (!then) return '';
  let s = Math.max(0, (Date.now() - then) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return `${n >= 10 ? Math.round(n) : n.toFixed(n >= 1 ? 1 : 2)}%`;
}

// "1.639GiB" -> "1.639 GiB"
function spaced(s) {
  return String(s || '').replace(/([\d.]+)\s*([A-Za-z]+)/g, '$1 $2');
}

// docker's status text, said once and plainly
function whenWord(status) {
  const s = String(status || '').trim();
  let m = /^Up (.+?)(?: \(.*\))?$/.exec(s);
  if (m) return `up ${m[1].toLowerCase()}`;
  m = /^Exited \((-?\d+)\) (.+)$/.exec(s);
  if (m) return `exited ${m[2]}${m[1] !== '0' ? ` with code ${m[1]}` : ''}`;
  if (/^Created/i.test(s)) return 'never started';
  return s.toLowerCase();
}

function renderCard() {
  if (!pinned || !pinned.machine) {
    cardEl.hidden = true;
    return;
  }
  const m = pinned.machine;
  const ping = snapshot && snapshot.ping;
  const lines = [];
  if (m.kind === 'server') {
    if (m.version) lines.push(`Unraid ${escapeHtml(m.version)}${m.arrayState ? ` · array ${escapeHtml(m.arrayState.toLowerCase().replace(/_/g, ' '))}` : ''}`);
    const bits = [];
    if (m.cpu != null) bits.push(`${lab('cpu')} ${Math.round(m.cpu)}%`);
    if (m.memory != null) bits.push(`${lab('memory')} ${Math.round(m.memory)}%`);
    if (bits.length) lines.push(bits.join(' · '));
    const meta = [];
    if (m.uptime) meta.push(`up ${ago(m.uptime)}`);
    const pw = pingWord(ping);
    if (pw) meta.push(pw);
    if (meta.length) lines.push(meta.join(' · '));
    if (m.cpuBrand) lines.push(escapeHtml(m.cpuBrand));
    if (m.disks && m.disks.length) {
      lines.push(m.disks.map((d) => `${escapeHtml(d.name)} ${Math.round(d.used * 100)}%`).join(' · '));
    }
    if (snapshot && snapshot.summary) {
      lines.push(`${snapshot.summary.dancing} dancing, ${snapshot.summary.quiet} still`);
    }
    if (m.alerts > 20) lines.push('old alerts are piled up in unraid');
    else if (m.alerts) lines.push(`${m.alerts} unread alerts`);
    if (snapshot && snapshot.error) lines.push(escapeHtml(snapshot.error));
  } else if (m.kind === 'docker') {
    const word = stateWord(m);
    const hm = /\((healthy|unhealthy|health: starting)\)/i.exec(m.status || '');
    const health = hm ? hm[1].toLowerCase().replace('health: ', '') : '';
    lines.push(`docker · ${escapeHtml(word)}${health && health !== word ? ` · ${escapeHtml(health)}` : ''}`);
    if (m.image) lines.push(escapeHtml(m.image));
    const s = m.stats;
    if (s) {
      const used = String(s.mem || '').split('/')[0];
      lines.push(`${lab('cpu')} ${fmtPct(s.cpu)} · ${lab('memory')} ${escapeHtml(spaced(used.trim()))} (${fmtPct(s.memPercent)})`);
    }
    const bits = [];
    const when = whenWord(m.status);
    if (when) bits.push(when);
    if (m.ports && m.ports.length) bits.push(`port ${m.ports.join(', ')}`);
    if (m.autoStart) bits.push('starts with the array');
    if (bits.length) lines.push(escapeHtml(bits.join(' · ')));
    if (s) {
      const [rx, tx] = String(s.net || '').split('/').map((v) => spaced(v.trim()));
      const [rd, wr] = String(s.blk || '').split('/').map((v) => spaced(v.trim()));
      lines.push(`${lab('network')} ${escapeHtml(rx || '0 B')} in · ${escapeHtml(tx || '0 B')} out`);
      lines.push(`${lab('disk')} ${escapeHtml(rd || '0 B')} read · ${escapeHtml(wr || '0 B')} written`);
    }
    if (m.update) lines.push('an update is waiting');
  } else {
    lines.push(`${m.kind} · ${escapeHtml(stateWord(m))}`);
  }
  const actions = actionsFor(m);
  const html = `${lines.map((line, i) => `<p class="${i === 0 ? 'kind' : 'quiet'}">${line}</p>`).join('')}${actions}${cardError ? `<p class="quiet">${escapeHtml(cardError)}</p>` : ''}`;
  const key = `${m.id}|${html}`;
  const fresh = cardEl.hidden || cardFor !== m.id;
  if (cardEl.dataset.key !== key) {
    cardEl.dataset.key = key;
    cardEl.innerHTML = html;
  }
  cardEl.hidden = false;
  if (fresh) {
    cardFor = m.id;
    cardEl.classList.remove('in');
    void cardEl.offsetWidth;
    cardEl.classList.add('in');
  }
}

let cardFor = null;

cardEl.addEventListener('click', (event) => {
  const el = event.target instanceof Element ? event.target : null;
  if (el && el.closest('[data-logs]') && pinned && pinned.machine) {
    openLogs(pinned.machine);
    return;
  }
  if (el && el.closest('[data-term]') && pinned && pinned.machine) {
    openTerm(pinned.machine.kind === 'server' ? 'host' : 'container', pinned.machine);
    return;
  }
  const btn = el ? el.closest('[data-op]') : null;
  if (btn && pinned && pinned.machine) act(pinned.machine, btn.dataset.op);
});

let cardError = '';

const ICONS = {
  play: '<path d="M8.4 5.3v13.4a.6.6 0 0 0 .92.5l10.4-6.7a.6.6 0 0 0 0-1L9.32 4.8a.6.6 0 0 0-.92.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6.2" y="6.2" width="11.6" height="11.6" rx="2.6" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.4" y="5.4" width="4" height="13.2" rx="1.3" fill="currentColor" stroke="none"/><rect x="13.6" y="5.4" width="4" height="13.2" rx="1.3" fill="currentColor" stroke="none"/>',
  restart: '<path d="M19.5 12a7.5 7.5 0 1 1-2.4-5.5"/><path d="M19.8 4.2v4.4h-4.4"/>',
  power: '<path d="M12 3.5v8"/><path d="M7 6.6a7.5 7.5 0 1 0 10 0"/>',
  open: '<path d="M8 16 17 7"/><path d="M9.5 7H17v7.5"/>',
  check: '<path d="m5.5 12.5 4.3 4.3 8.9-9.2"/>',
  logs: '<path d="M5 6.5h14M5 11h14M5 15.5h9"/>',
  terminal: '<path d="m5 7 5.5 5L5 17"/><path d="M12.5 17.5H19"/>',
  chevL: '<path d="m14.5 6-6 6 6 6"/>',
  chevR: '<path d="m9.5 6 6 6-6 6"/>',
};

function icon(name) {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}

// Small pictures that can stand in for the words cpu, memory, network and disk.
const GLYPHS = {
  cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5"/>',
  memory: '<rect x="3.5" y="7.5" width="17" height="8.5" rx="1.8"/><path d="M7 16v2.6M10.3 16v2.6M13.7 16v2.6M17 16v2.6M7.5 11.8h.01M12 11.8h.01M16.5 11.8h.01"/>',
  network: '<path d="M8.5 19V6M5 9.5 8.5 6 12 9.5"/><path d="M15.5 5v13M12 14.5l3.5 3.5 3.5-3.5"/>',
  disk: '<ellipse cx="12" cy="6.5" rx="6.5" ry="2.8"/><path d="M5.5 6.5v11c0 1.55 2.9 2.8 6.5 2.8s6.5-1.25 6.5-2.8v-11"/><path d="M5.5 12c0 1.55 2.9 2.8 6.5 2.8s6.5-1.25 6.5-2.8"/>',
};
let glyphsOn = false;
try { glyphsOn = localStorage.getItem('minu.glyphs') === 'on'; } catch { /* private mode */ }

// the word, or its picture when that setting is on (the word stays for screen readers)
function lab(name) {
  if (!glyphsOn) return name;
  return `<svg class="gl" viewBox="0 0 24 24" role="img" aria-label="${name}">${GLYPHS[name]}</svg>`;
}

const DANGEROUS = new Set(['stop', 'forceStop', 'reboot', 'restart']);

function termButton() {
  return `<button type="button" class="act" data-term="1" aria-label="terminal">${icon('terminal')}</button>`;
}

function logsButton() {
  return `<button type="button" class="act" data-logs="1" aria-label="logs">${icon('logs')}</button>`;
}

function openLink(url) {
  return `<a class="act" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" aria-label="open">${icon('open')}</a>`;
}

function actionsFor(m) {
  if (m.kind === 'server') {
    return `<p class="actions">${logsButton()}${termCaps.host ? termButton() : ''}${m.web ? openLink(m.web) : ''}</p>`;
  }
  const health = m.health;
  const ops = [];
  if (m.kind === 'docker') {
    if (health === 'down' || health === 'crashed') ops.push(['start', 'start', 'play']);
    if (health === 'up' || health === 'unhealthy' || health === 'uneasy') {
      ops.push(['restart', 'restart', 'restart'], ['stop', 'stop', 'stop']);
    }
    if (health === 'paused') ops.push(['unpause', 'resume', 'play'], ['stop', 'stop', 'stop']);
  } else {
    if (health === 'down') ops.push(['start', 'start', 'play']);
    if (health === 'up' || health === 'unhealthy') ops.push(['reboot', 'reboot', 'restart'], ['stop', 'stop', 'stop']);
    if (health === 'paused') ops.push(['resume', 'resume', 'play'], ['forceStop', 'force stop', 'power']);
    if (health === 'crashed') ops.push(['start', 'start', 'play'], ['forceStop', 'force stop', 'power']);
  }
  const buttons = ops.map(([op, label, glyph]) => {
    const sure = confirmOp === op;
    const tip = sure ? `sure? ${label}` : label;
    const cls = `act${DANGEROUS.has(op) ? ' warn' : ''}${sure ? ' sure' : ''}`;
    return `<button type="button" class="${cls}" data-op="${op}" aria-label="${tip}">${icon(sure ? 'check' : glyph)}</button>`;
  }).join('');
  const open = m.web ? openLink(m.web) : '';
  const logs = m.kind === 'docker' ? logsButton() : '';
  const shell = canTerm(m) ? termButton() : '';
  if (!buttons && !open && !logs) return '';
  return `<p class="actions">${buttons}${logs}${shell}${open}</p>`;
}

async function act(machine, op) {
  const dangerous = op === 'stop' || op === 'forceStop' || op === 'reboot' || op === 'restart';
  if (dangerous && confirmOp !== op) {
    confirmOp = op;
    renderCard();
    setTimeout(() => {
      if (confirmOp === op) { confirmOp = null; renderCard(); }
    }, 2400);
    return;
  }
  confirmOp = null;
  cardError = '';
  renderCard();
  try {
    const res = await apiFetch('/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: machine.kind, id: machine.id, op }),
    });
    const body = await res.json();
    if (!body.ok) cardError = humanError(body.error || 'it did not take');
  } catch {
    cardError = 'minu could not reach the server';
  }
  renderCard();
  poll();
}

let focusC = null;
let matches = [];
let pick = 0;

function rank(list, query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const order = { unhealthy: 0, crashed: 0, uneasy: 1, up: 2, paused: 2, down: 3 };
  const rows = [];
  for (const m of list) {
    if (m.kind === 'server' && !tokens.length) { rows.push({ m, s: -1 }); continue; }
    const name = String(m.name || '').toLowerCase();
    const hay = `${name} ${String(m.image || '').toLowerCase()} ${m.kind} ${stateWord(m)}`;
    if (!tokens.every((tk) => hay.includes(tk))) continue;
    let s;
    if (tokens.length) s = name.startsWith(tokens[0]) ? 0 : name.includes(tokens[0]) ? 1 : 2;
    else s = 1 + (order[m.health] ?? 3);
    rows.push({ m, s });
  }
  rows.sort((a, b) => a.s - b.s || String(a.m.name).localeCompare(String(b.m.name)));
  return rows.map((r) => r.m);
}

function setPick(i, scroll = true) {
  pick = i;
  foundList.querySelectorAll('li[data-i]').forEach((li) => {
    const on = Number(li.dataset.i) === i;
    li.classList.toggle('on', on);
    if (on && scroll) li.scrollIntoView({ block: 'nearest' });
  });
  focusC = matches[i] ? creatures.get(matches[i].id) || null : null;
}

// Presets: 1 is always the server; 2-9 and 0 are yours to set with command + number.
const SLOTS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
let presets = {};
try { presets = JSON.parse(localStorage.getItem('minu.presets') || '{}') || {}; } catch { presets = {}; }
let presetOnly = false;
let browseAll = false;
let lastQuery = '';

function savePresets() {
  try { localStorage.setItem('minu.presets', JSON.stringify(presets)); } catch { /* private mode */ }
}

function presetMachine(slot) {
  const list = snapshot && snapshot.machines ? snapshot.machines : [];
  if (slot === '1') return list.find((m) => m.kind === 'server') || null;
  const p = presets[slot];
  if (!p) return null;
  return list.find((m) => m.kind === p.kind && m.name === p.name) || null;
}

function slotOf(m) {
  if (m.kind === 'server') return '1';
  for (const s of SLOTS) {
    const p = presets[s];
    if (s !== '1' && p && p.kind === m.kind && p.name === m.name) return s;
  }
  return '';
}

function setPreset(slot, m) {
  if (slot === '1' || !m || m.kind === 'server') return;
  const p = presets[slot];
  if (p && p.kind === m.kind && p.name === m.name) {
    delete presets[slot];
  } else {
    for (const s of SLOTS) {
      const q = presets[s];
      if (q && q.kind === m.kind && q.name === m.name) delete presets[s];
    }
    presets[slot] = { kind: m.kind, name: m.name };
  }
  savePresets();
  renderFound();
  const chip = presetsEl.querySelector(`.chip[data-slot="${slot}"]`);
  if (chip) chip.classList.add('pop');
}

function renderPresets() {
  presetsEl.innerHTML = '<span class="plabel">presets:</span>' + SLOTS.map((s) => {
    const m = presetMachine(s);
    return `<button type="button" class="chip${m ? ' set' : ''}" data-slot="${s}"><b>${s}</b><span>${m ? escapeHtml(m.name) : ''}</span></button>`;
  }).join('');
}

// Automatic cycling: nothing is shown at first, two seconds in the server's
// info fades in, then each machine in turn. Touching anything pauses it a while.
let swapTimer = 0;
let autoOn = true;
try { autoOn = localStorage.getItem('minu.cycle') !== 'off'; } catch { /* private mode */ }
let autoAt = performance.now() + 2000;
const CYCLE_MS = 6500;

function noteManual() {
  autoAt = Math.max(autoAt, performance.now() + 30000);
}

function pinMachine(m, auto = false) {
  const c = m ? creatures.get(m.id) : null;
  if (!c) return;
  if (!auto) noteManual();
  const apply = () => {
    pinned = c;
    hovered = c;
    confirmOp = null;
    cardError = '';
    renderCard();
    infoEl.classList.remove('dim');
  };
  clearTimeout(swapTimer);
  if (!cardEl.hidden && pinned && pinned !== c) {
    // fade the old info out, swap, then fade the new one in
    infoEl.classList.add('dim');
    swapTimer = setTimeout(apply, 360);
  } else {
    apply();
  }
}

// Space steps through every machine, as if each were clicked in turn.
function cycleInfo(step, auto = false) {
  const list = snapshot && snapshot.machines ? snapshot.machines : [];
  const order = rank(list, '');
  if (!order.length) return;
  const cur = pinned && pinned.machine ? order.findIndex((m) => m.id === pinned.machine.id) : -1;
  const next = cur < 0 ? (step > 0 ? 0 : order.length - 1) : (cur + step + order.length) % order.length;
  pinMachine(order[next], auto);
}

function tickAuto() {
  if (!autoOn) return;
  const now = performance.now();
  if (now < autoAt) return;
  const have = snapshot && snapshot.machines && snapshot.machines.length;
  const busy = document.hidden || finderOpen() || !linksEl.hidden || !logsEl.hidden || !termEl.hidden || !loginEl.hidden || !settings.hidden || confirmOp || cardEl.matches(':hover');
  if (!have || busy) {
    autoAt = now + 1500;
    return;
  }
  cycleInfo(1, true);
  autoAt = now + CYCLE_MS;
}

function setCycle(on) {
  autoOn = on;
  cycleBtn.setAttribute('aria-checked', on ? 'true' : 'false');
  try { localStorage.setItem('minu.cycle', on ? 'on' : 'off'); } catch { /* private mode */ }
  if (on) autoAt = performance.now() + 1500;
}

cycleBtn.setAttribute('aria-checked', autoOn ? 'true' : 'false');
cycleBtn.addEventListener('click', () => setCycle(!autoOn));
setInterval(tickAuto, 250);

// The ripple pulse (the ping beam, the heartbeat swell and the glass nudge) is
// off unless you switch it on.
const pulseBtn = document.getElementById('pulse');
let pulseOn = false;
try { pulseOn = localStorage.getItem('minu.pulse') === 'on'; } catch { /* private mode */ }

function setPulse(on) {
  pulseOn = on;
  pulseBtn.setAttribute('aria-checked', on ? 'true' : 'false');
  try { localStorage.setItem('minu.pulse', on ? 'on' : 'off'); } catch { /* private mode */ }
  if (on) {
    setTimeout(pingOnce, 300);
  } else {
    ripples.length = 0;
    rippleQueue.length = 0;
    beatState.start = -100;
  }
}

pulseBtn.setAttribute('aria-checked', pulseOn ? 'true' : 'false');
pulseBtn.addEventListener('click', () => setPulse(!pulseOn));

// The server's cpu and memory, bottom right. The numbers glide between readings
// so they count smoothly instead of jumping every few seconds.
const vitalsEl = document.getElementById('vitals');
const vitalsBtn = document.getElementById('showvitals');
let vitalsOn = true;
try { vitalsOn = localStorage.getItem('minu.vitals') !== 'off'; } catch { /* private mode */ }
const vitalsShown = { cpu: null, mem: null, temp: null };

function setVitals(on) {
  vitalsOn = on;
  vitalsBtn.setAttribute('aria-checked', on ? 'true' : 'false');
  try { localStorage.setItem('minu.vitals', on ? 'on' : 'off'); } catch { /* private mode */ }
}

function vitalsStep(dt) {
  const s = snapshot && snapshot.server;
  const cpu = s && s.cpu != null ? s.cpu : null;
  const mem = s && s.memory != null ? s.memory : null;
  const temp = s && s.temp != null ? s.temp : null;
  const show = vitalsOn && (cpu != null || mem != null || temp != null);
  if (vitalsEl.hidden === show) vitalsEl.hidden = !show;
  if (!show) return;
  if (cpu != null) vitalsShown.cpu = damp(vitalsShown.cpu, cpu, dt, 3);
  if (mem != null) vitalsShown.mem = damp(vitalsShown.mem, mem, dt, 3);
  if (temp != null) vitalsShown.temp = damp(vitalsShown.temp, temp, dt, 3);
  // one line: cpu, then memory, then the main temperature
  const row = (label, v) => `<span>${lab(label)} <b>${Math.round(v)}%</b></span>`;
  const html = [
    cpu != null ? row('cpu', vitalsShown.cpu) : '',
    mem != null ? row('memory', vitalsShown.mem) : '',
    temp != null ? `<span>${Math.round(vitalsShown.temp)}°C</span>` : '',
  ].filter(Boolean).join(' · ');
  if (vitalsEl.dataset.key !== html) {
    vitalsEl.dataset.key = html;
    vitalsEl.innerHTML = html;
  }
}

vitalsBtn.setAttribute('aria-checked', vitalsOn ? 'true' : 'false');
vitalsBtn.addEventListener('click', () => setVitals(!vitalsOn));

// words or pictures for cpu, memory, network and disk
const glyphBtn = document.getElementById('glyphs');
glyphBtn.setAttribute('aria-checked', glyphsOn ? 'true' : 'false');
glyphBtn.addEventListener('click', () => {
  glyphsOn = !glyphsOn;
  glyphBtn.setAttribute('aria-checked', glyphsOn ? 'true' : 'false');
  try { localStorage.setItem('minu.glyphs', glyphsOn ? 'on' : 'off'); } catch { /* private mode */ }
  // everything that shows these words is drawn again
  delete whisper.dataset.key;
  delete cardEl.dataset.key;
  delete vitalsEl.dataset.key;
  if (pinned) renderCard();
});

// Quick links: every machine with a web page, in one plain list. Press L (or the
// corner icon), type a few letters, press Enter, and it opens in a new tab.
const linksEl = document.getElementById('links');
const linksBtn = document.getElementById('linksbtn');
const linkList = document.getElementById('linklist');
let linkItems = [];
let linkPick = 0;

function linksOpen() {
  return !linksEl.hidden;
}

let linkPage = 0;
let linkCap = 1;
let linkRowsN = 1;
let freshTimer = 0;
const pagerEl = document.getElementById('pager');

// The server first, then every other name in alphabetical order.
function linkRows() {
  const list = snapshot && snapshot.machines ? snapshot.machines : [];
  return list
    .filter((m) => m.web)
    .sort((a, b) => (a.kind === 'server' ? 0 : 1) - (b.kind === 'server' ? 0 : 1)
      || String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base', numeric: true }));
}

// Fit every name on one screen while the type can stay readable. When it cannot,
// split the names into pages and let the dots and arrows load the next one.
function linkLayout() {
  const n = linkItems.length;
  const w = linkList.clientWidth;
  const h = linkList.clientHeight;
  if (!n || !w || !h) return { cols: 1, rows: 1, cap: Math.max(1, n), pages: 1, rowH: 64, fs: 30 };
  const minRow = 56;
  const minCol = 190;
  const maxCols = Math.max(1, Math.floor(w / minCol));
  const maxRows = Math.max(1, Math.floor(h / minRow));
  let cols;
  let rows;
  let cap;
  let pages;
  if (n <= maxCols * maxRows) {
    cols = Math.max(Math.ceil(n / maxRows), Math.min(maxCols, n, Math.ceil(Math.sqrt((n * w) / (2.8 * h)))));
    rows = Math.ceil(n / cols);
    cols = Math.ceil(n / rows);
    cap = n;
    pages = 1;
  } else {
    cols = maxCols;
    rows = maxRows;
    cap = cols * rows;
    pages = Math.ceil(n / cap);
  }
  const rowH = Math.min(h / rows, 230);
  const colW = w / cols;
  const fs = Math.max(22, Math.min(64, rowH * 0.36, colW * 0.15));
  return { cols, rows, cap, pages, rowH, fs };
}

function stagger() {
  linkList.querySelectorAll('a').forEach((a, i) => {
    a.style.animationDelay = `${Math.min(i * 16, 520)}ms`;
  });
  linksEl.classList.add('fresh');
  clearTimeout(freshTimer);
  freshTimer = setTimeout(() => linksEl.classList.remove('fresh'), 1400);
}

function renderPager(pages) {
  if (pages <= 1) {
    pagerEl.hidden = true;
    pagerEl.innerHTML = '';
    return;
  }
  const dots = Array.from({ length: pages }, (_, p) => {
    return `<button type="button" class="dot${p === linkPage ? ' on' : ''}" data-p="${p}" aria-label="page ${p + 1}"></button>`;
  }).join('');
  pagerEl.innerHTML = `<button type="button" class="arr" data-d="-1" aria-label="previous page">${icon('chevL')}</button>${dots}<button type="button" class="arr" data-d="1" aria-label="next page">${icon('chevR')}</button>`;
  pagerEl.hidden = false;
}

function renderLinks(keepScroll = true, animate = false) {
  linkItems = linkRows();
  const lay = linkLayout();
  linkCap = lay.cap;
  linkRowsN = lay.rows;
  linkPick = Math.min(linkPick, Math.max(0, linkItems.length - 1));
  // the highlighted name decides which page is showing
  linkPage = Math.min(lay.pages - 1, Math.floor(linkPick / linkCap));
  const start = linkPage * linkCap;
  const shown = linkItems.slice(start, start + linkCap);
  if (!shown.length) {
    const have = snapshot && snapshot.machines && snapshot.machines.some((m) => m.web);
    linkList.innerHTML = `<p class="none">${have ? 'no links to show' : 'no links yet'}</p>`;
    linkList.style.gridTemplateColumns = '';
    linkList.style.gridTemplateRows = '';
  } else {
    linkList.innerHTML = shown.map((m, k) => {
      const i = start + k;
      const cls = `${living(m.health) ? '' : 'off'}${i === linkPick ? ' on' : ''}`.trim();
      return `<a class="${cls}" href="${escapeHtml(m.web)}" target="_blank" rel="noopener noreferrer" data-i="${i}"><b>${escapeHtml(m.name)}</b></a>`;
    }).join('');
    linkList.style.gridTemplateColumns = `repeat(${lay.cols}, minmax(0, 1fr))`;
    linkList.style.gridTemplateRows = `repeat(${lay.rows}, ${Math.floor(lay.rowH)}px)`;
    linkList.style.setProperty('--fs', `${lay.fs.toFixed(1)}px`);
  }
  renderPager(lay.pages);
  if (animate) stagger();
}

function setLinkPick(i) {
  const before = linkPage;
  linkPick = i;
  if (Math.floor(i / linkCap) !== before) {
    renderLinks(false, true);
    return;
  }
  linkList.querySelectorAll('a[data-i]').forEach((a) => {
    a.classList.toggle('on', Number(a.dataset.i) === i);
  });
}

function openLinks() {
  if (finderOpen()) closeFinder();
  closeLogs();
  settings.hidden = true;
  linksEl.hidden = false;
  linksBtn.classList.add('open');
  linksBtn.querySelector('kbd').textContent = 'esc';
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  linkPick = 0;
  renderLinks(false, true);
}

function closeLinks() {
  if (linksEl.hidden) return;
  linksEl.hidden = true;
  linksBtn.classList.remove('open');
  linksBtn.querySelector('kbd').textContent = 'L';
}

function launchLink(i) {
  const m = linkItems[i];
  if (!m) return;
  window.open(m.web, '_blank', 'noopener,noreferrer');
  closeLinks();
}

linksBtn.addEventListener('click', () => (linksOpen() ? closeLinks() : openLinks()));

// No search box: just type a few letters and the highlight jumps to that name.
let typed = '';
let typedAt = 0;

function typeAhead(ch) {
  const now = performance.now();
  typed = now - typedAt > 900 ? ch.toLowerCase() : typed + ch.toLowerCase();
  typedAt = now;
  let i = linkItems.findIndex((m) => String(m.name).toLowerCase().startsWith(typed));
  if (i < 0) i = linkItems.findIndex((m) => String(m.name).toLowerCase().includes(typed));
  if (i >= 0) setLinkPick(i);
}

function goPage(p) {
  const pages = Math.max(1, Math.ceil(linkItems.length / linkCap));
  const next = Math.min(pages - 1, Math.max(0, p));
  if (next === linkPage) return;
  linkPick = next * linkCap;
  renderLinks(false, true);
}

linkList.addEventListener('pointermove', (event) => {
  const a = event.target instanceof Element ? event.target.closest('a[data-i]') : null;
  if (a && Number(a.dataset.i) !== linkPick) setLinkPick(Number(a.dataset.i));
});
linkList.addEventListener('click', () => setTimeout(closeLinks, 0));
pagerEl.addEventListener('click', (event) => {
  const b = event.target instanceof Element ? event.target.closest('button') : null;
  if (!b) return;
  goPage(b.dataset.p != null ? Number(b.dataset.p) : linkPage + Number(b.dataset.d));
});

// scrolling or swiping turns the page too
let wheelAt = 0;
linksEl.addEventListener('wheel', (event) => {
  if (linkItems.length <= linkCap) return;
  const d = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (Math.abs(d) < 12 || performance.now() - wheelAt < 550) return;
  wheelAt = performance.now();
  goPage(linkPage + (d > 0 ? 1 : -1));
}, { passive: true });

linksEl.addEventListener('click', (event) => {
  if (event.target === linksEl) closeLinks();
});

// Logs: a container's recent output, or one of Unraid's own log files. Opened from
// the logs icon in the info card (or with G) and refreshed every few seconds.
const logsEl = document.getElementById('logs');
const logTitle = document.getElementById('logtitle');
const logFilesEl = document.getElementById('logfiles');
const logBody = document.getElementById('logbody');
const logClose = document.getElementById('logclose');
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
let logMachine = null;
let logFile = '';
let logTimer = 0;
let logFirst = true;
let logSeq = 0;

function logsOpen() {
  return !logsEl.hidden;
}

function renderLogs(data) {
  const atBottom = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 60;
  if (!data.ok) {
    logBody.innerHTML = `<div class="none">${escapeHtml(data.error || 'could not read the log')}</div>`;
    return;
  }
  if (!data.lines.length) {
    logBody.innerHTML = '<div class="none">nothing has been logged yet</div>';
  } else {
    logBody.innerHTML = data.lines.map((l) => {
      let stamp = '';
      if (l.t) {
        const d = new Date(l.t);
        if (!Number.isNaN(d.getTime())) stamp = `<time>${d.toLocaleTimeString([], { hour12: false })}</time>`;
      }
      return `<div>${stamp}${escapeHtml(String(l.m).replace(ANSI, ''))}</div>`;
    }).join('');
  }
  if (data.files) {
    logFile = data.file || logFile;
    logFilesEl.innerHTML = data.files.map((f) => `<button type="button" class="${f.path === logFile ? 'on' : ''}" data-file="${escapeHtml(f.path)}">${escapeHtml(f.name)}</button>`).join('');
  }
  if (logFirst || atBottom) logBody.scrollTop = logBody.scrollHeight;
  logFirst = false;
}

async function fetchLogs() {
  if (!logMachine || document.hidden) return;
  const seq = ++logSeq;
  const ref = logMachine.kind === 'server' ? logFile : logMachine.id;
  try {
    const res = await apiFetch(`/api/logs?kind=${encodeURIComponent(logMachine.kind)}&ref=${encodeURIComponent(ref)}`, { cache: 'no-store' });
    const data = await res.json();
    if (seq === logSeq && logsOpen()) renderLogs(data);
  } catch {
    if (seq === logSeq && logsOpen()) renderLogs({ ok: false, error: 'minu could not reach the server' });
  }
}

function openLogs(m) {
  if (!m || (m.kind !== 'docker' && m.kind !== 'server')) return;
  if (finderOpen()) closeFinder();
  closeLinks();
  settings.hidden = true;
  logMachine = m;
  logFile = '';
  logFirst = true;
  logTitle.textContent = m.name;
  logFilesEl.innerHTML = '';
  logBody.innerHTML = '<div class="none">reading the log…</div>';
  logsEl.hidden = false;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  fetchLogs();
  clearInterval(logTimer);
  logTimer = setInterval(fetchLogs, 3000);
}

function closeLogs() {
  if (logsEl.hidden) return;
  logsEl.hidden = true;
  logMachine = null;
  clearInterval(logTimer);
}

logClose.addEventListener('click', closeLogs);
logFilesEl.addEventListener('click', (event) => {
  const b = event.target instanceof Element ? event.target.closest('button[data-file]') : null;
  if (!b) return;
  logFile = b.dataset.file;
  logFirst = true;
  fetchLogs();
});
logsEl.addEventListener('click', (event) => {
  if (event.target === logsEl) closeLogs();
});

// Far bottom right: the server's own logs, and a way into its terminal. The
// terminal is Unraid's built-in web terminal opened in a new tab, so you sign in
// to Unraid yourself; this page never runs a command or holds a password.
document.getElementById('srvlogs').addEventListener('click', () => {
  const m = snapshot && snapshot.machines ? snapshot.machines.find((x) => x.kind === 'server') : null;
  if (m) openLogs(m);
});

document.getElementById('srvterm').addEventListener('click', () => {
  const sm = snapshot && snapshot.machines ? snapshot.machines.find((x) => x.kind === 'server') : null;
  if (termCaps.host && sm) {
    openTerm('host', sm);
    return;
  }
  const origin = snapshot && snapshot.server ? snapshot.server.web : '';
  if (!origin) return;
  // a real popup window, centred on the screen, reused if it is already open
  const w = 1040;
  const h = 680;
  const left = Math.max(0, Math.round(((window.screen.availWidth || w) - w) / 2));
  const top = Math.max(0, Math.round(((window.screen.availHeight || h) - h) / 2));
  window.open(`${origin}/webterminal/ttyd/`, 'unraid-terminal', `popup=yes,width=${w},height=${h},left=${left},top=${top},noopener,noreferrer`);
});

function renderFound(keepScroll = true) {
  const list = snapshot && snapshot.machines ? snapshot.machines : [];
  const query = findInput.value;
  const pool = presetOnly ? SLOTS.map(presetMachine).filter(Boolean) : list;
  // nothing is listed until you type, or press down to browse everything
  const idle = !query.trim() && !presetOnly && !browseAll;
  matches = idle ? [] : presetOnly && !query.trim() ? pool : rank(pool, query);
  pick = Math.min(pick, Math.max(0, matches.length - 1));
  const keep = keepScroll ? foundList.scrollTop : 0;
  if (!matches.length) {
    const msg = !list.length ? 'nothing to find yet' : presetOnly ? 'no presets set yet' : 'nothing by that name';
    foundList.innerHTML = idle ? '' : `<li class="none">${msg}</li>`;
  } else {
    foundList.innerHTML = matches.map((m, i) => {
      const rgb = (m.kind === 'server' ? BONE : inkFor(m.id)).map((v) => Math.round(v * 255)).join(',');
      const sub = m.kind === 'server' ? 'server' : `${m.kind} · ${stateWord(m)}`;
      return `<li role="option" data-i="${i}" class="${i === pick ? 'on' : ''}"><i data-c="rgb(${rgb})"></i><b class="slot">${slotOf(m)}</b><span>${escapeHtml(m.name)}</span><em>${escapeHtml(sub)}</em></li>`;
    }).join('');
    foundList.querySelectorAll('i[data-c]').forEach((dot) => {
      dot.style.background = dot.dataset.c;
      dot.style.color = dot.dataset.c;
    });
  }
  foundList.scrollTop = keep;
  listBtn.setAttribute('aria-pressed', browseAll && !presetOnly && !query.trim() ? 'true' : 'false');
  pfilter.setAttribute('aria-pressed', presetOnly ? 'true' : 'false');
  renderPresets();
  focusC = finderOpen() && matches[pick] ? creatures.get(matches[pick].id) || null : null;
}

function finderOpen() {
  return finder.classList.contains('open');
}

function openFinder() {
  if (finderOpen()) { findInput.focus(); return; }
  settings.hidden = true;
  closeLinks();
  closeLogs();
  finder.classList.add('open');
  keysEl.textContent = 'esc';
  findInput.value = '';
  lastQuery = '';
  browseAll = false;
  pick = 0;
  renderFound(false);
  findInput.focus();
}

function closeFinder() {
  finder.classList.remove('open');
  keysEl.textContent = keyHint;
  focusC = null;
  findInput.value = '';
  lastQuery = '';
  findInput.blur();
}

findInput.addEventListener('focus', openFinder);
finder.addEventListener('click', () => { if (!finderOpen()) openFinder(); });

function choose(i) {
  const m = matches[i];
  if (!m) return;
  closeFinder();
  pinMachine(m);
}

// Live search: every keystroke, paste, IME step or clear re-runs the filter at once.
function onQuery() {
  const q = findInput.value;
  if (q === lastQuery) return;
  lastQuery = q;
  if (!q.trim()) browseAll = false;
  pick = 0;
  renderFound(false);
}

['input', 'keyup', 'compositionupdate', 'compositionend', 'change', 'search'].forEach((name) => {
  findInput.addEventListener(name, onQuery);
});
findInput.addEventListener('paste', () => setTimeout(onQuery, 0));

listBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  const showing = browseAll && !presetOnly && !findInput.value.trim();
  presetOnly = false;
  findInput.value = '';
  lastQuery = '';
  browseAll = !showing;
  pick = 0;
  renderFound(false);
  findInput.focus();
});
pfilter.addEventListener('click', (event) => {
  event.stopPropagation();
  presetOnly = !presetOnly;
  pfilter.setAttribute('aria-pressed', presetOnly ? 'true' : 'false');
  pick = 0;
  renderFound(false);
  findInput.focus();
});
presetsEl.addEventListener('click', (event) => {
  const chip = event.target instanceof Element ? event.target.closest('.chip') : null;
  if (!chip) return;
  const slot = chip.dataset.slot;
  const m = presetMachine(slot);
  if (m) {
    closeFinder();
    pinMachine(m);
  } else if (matches[pick]) {
    setPreset(slot, matches[pick]);
  }
});
foundList.addEventListener('click', (event) => {
  const li = event.target instanceof Element ? event.target.closest('li[data-i]') : null;
  if (li) choose(Number(li.dataset.i));
});
foundList.addEventListener('pointermove', (event) => {
  const li = event.target instanceof Element ? event.target.closest('li[data-i]') : null;
  if (li && Number(li.dataset.i) !== pick) setPick(Number(li.dataset.i), false);
});

function hitTest(x, y) {
  let best = null;
  let bestD = Infinity;
  for (const c of creatures.values()) {
    if (c.gone || !c.draw) continue;
    const hit = Math.max(26, (c.radius || 20) * 1.2);
    const d = Math.hypot(x - c.drawX, y - c.drawY);
    if (d < hit && d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

function openSettings() {
  settings.hidden = false;
  loadConfigForm();
}

async function loadConfigForm() {
  try {
    const res = await apiFetch('/api/config');
    const body = await res.json();
    if (body.url) urlInput.value = body.url;
    keyInput.placeholder = body.hasKey ? `saved ····${body.hint}` : 'paste the key';
  } catch { /* leave the form */ }
}

// The ripple is the server's ping. Each probe sends one beam out from the
// middle light: low latency is quick and clean, high latency is slow and rough,
// and a missed ping is a short, broken red beam. The swell rides on each ping.
function firePing(ok, ms) {
  if (!pulseOn) return;
  const t = performance.now() / 1000;
  const amp = reduce ? 0.25 : 1;
  const m = ok && ms != null ? ms : 0;
  const rough = ok ? Math.min(1, m / 120) : 1;
  const spd = ok ? Math.max(0.45, Math.min(1.25, 1.25 - m / 80)) : 0.4;
  const k = (ok ? Math.max(0.5, Math.min(1, 1.1 - m / 400)) : 0.4) * amp;
  const life = ok ? RIPPLE_LIFE : 1.3;
  const fail = ok ? 0 : 1;
  rippleQueue.push({ at: t, k, spd, rough, fail, life });
  if (ok) rippleQueue.push({ at: t + 0.21, k: k * 0.55, spd, rough, fail, life });
  beatState.start = t;
  beatState.count = 1;
}

async function pingOnce() {
  if (!pulseOn || !authed) return;
  try {
    const res = await apiFetch('/api/ping', { cache: 'no-store' });
    const p = await res.json();
    firePing(Boolean(p.ok), p.ms);
  } catch {
    firePing(false, null);
  }
}

async function poll() {
  try {
    const res = await apiFetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error('status');
    apply(await res.json());
  } catch {
    mark.classList.add('bad');
  }
}

function startLoop() {
  if (loopOn) return;
  loopOn = true;
  last = performance.now();
  schedule();
}

const bareBtn = document.getElementById('bare');

function setIcons(mode) {
  document.documentElement.dataset.icons = mode;
  bareBtn.setAttribute('aria-checked', mode === 'bare' ? 'true' : 'false');
  try { localStorage.setItem('minu.icons', mode); } catch { /* private mode */ }
}

let savedIcons = 'glass';
try { savedIcons = localStorage.getItem('minu.icons') === 'bare' ? 'bare' : 'glass'; } catch { /* private mode */ }
setIcons(savedIcons);
bareBtn.addEventListener('click', () => setIcons(document.documentElement.dataset.icons === 'bare' ? 'glass' : 'bare'));

mark.addEventListener('click', () => {
  settings.hidden = !settings.hidden;
  if (!settings.hidden) loadConfigForm();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  note.textContent = 'listening…';
  try {
    const res = await apiFetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: urlInput.value, apiKey: keyInput.value }),
    });
    const body = await res.json();
    if (body.ok) {
      note.textContent = body.hostname || 'connected';
      keyInput.value = '';
      settings.hidden = true;
      poll();
    } else {
      note.textContent = body.error || 'no answer';
    }
  } catch {
    note.textContent = 'could not save';
  }
});

window.addEventListener('pointermove', (event) => {
  lastMoveT = performance.now() / 1000;
  if (mouse.on) {
    const speed = Math.hypot(event.clientX - mouse.x, event.clientY - mouse.y);
    ptr.e = Math.max(ptr.e, Math.min(speed / 18, 1));
  }
  mouse.x = event.clientX;
  mouse.y = event.clientY;
  mouse.on = true;
});
window.addEventListener('pointerleave', () => { mouse.on = false; });
window.addEventListener('pointerdown', (event) => {
  if (event.target instanceof Element && event.target.closest('#settings, #card, #mark, #finder, #links, #linksbtn, #logs, #term, #login, .corner')) return;
  if (finderOpen()) { closeFinder(); return; }
  if (linksOpen()) { closeLinks(); return; }
  mouse.x = event.clientX;
  mouse.y = event.clientY;
  const hit = hitTest(event.clientX, event.clientY);
  noteManual();
  if (hit) {
    pinMachine(hit.machine);
  } else {
    clearTimeout(swapTimer);
    infoEl.classList.remove('dim');
    pinned = null;
    hovered = null;
    confirmOp = null;
    cardError = '';
    cardEl.hidden = true;
  }
});
window.addEventListener('keydown', (event) => {
  if (!termEl.hidden && event.key === 'Escape' && event.shiftKey) { closeTerm(); return; }
  if (!termEl.hidden || !loginEl.hidden) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (finderOpen()) closeFinder(); else openFinder();
    return;
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
  if (event.key === '/' && !finderOpen() && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    openFinder();
    return;
  }
  if (logsOpen()) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeLogs();
    }
    return;
  }
  if (event.key.toLowerCase() === 'g' && !typing && !finderOpen() && !linksOpen() && pinned && pinned.machine
    && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    openLogs(pinned.machine);
    return;
  }
  if (linksOpen()) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeLinks();
    } else if (linkItems.length && /^(Arrow(Up|Down|Left|Right)|PageUp|PageDown)$/.test(event.key)) {
      // names run down each column: up and down walk a column, left and right
      // jump a column, and page up and down turn the page
      event.preventDefault();
      const step = {
        ArrowDown: 1,
        ArrowUp: -1,
        ArrowRight: linkRowsN,
        ArrowLeft: -linkRowsN,
        PageDown: linkCap,
        PageUp: -linkCap,
      }[event.key];
      setLinkPick(Math.min(linkItems.length - 1, Math.max(0, linkPick + step)));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      launchLink(linkPick);
    } else if (event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      typeAhead(event.key);
    }
    return;
  }
  if (event.key.toLowerCase() === 'l' && !typing && !finderOpen() && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    openLinks();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && /^[0-9]$/.test(event.key)) {
    // command + number: put the highlighted result (or the open machine) in that preset
    event.preventDefault();
    const target = finderOpen() ? matches[pick] : pinned && pinned.machine;
    if (target) setPreset(event.key, target);
    return;
  }
  const inSettings = !settings.hidden && settings.contains(document.activeElement);
  if (!finderOpen() && !typing && !inSettings && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (/^[0-9]$/.test(event.key)) {
      const m = presetMachine(event.key);
      if (m) { event.preventDefault(); pinMachine(m); }
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      cycleInfo(event.shiftKey ? -1 : 1);
      return;
    }
  }
  if (finderOpen()) {
    if (event.key === 'Escape') { event.preventDefault(); closeFinder(); }
    else if (event.key === 'ArrowDown' && !matches.length && !browseAll && !presetOnly) {
      event.preventDefault();
      browseAll = true;
      pick = 0;
      renderFound(false);
    }
    else if (event.key === 'ArrowDown' && matches.length) { event.preventDefault(); setPick((pick + 1) % matches.length); }
    else if (event.key === 'ArrowUp' && matches.length) { event.preventDefault(); setPick((pick - 1 + matches.length) % matches.length); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(pick); }
    return;
  }
  if (event.key === 'Escape') {
    if (!cardEl.hidden) {
      noteManual();
      clearTimeout(swapTimer);
      infoEl.classList.remove('dim');
      pinned = null;
      cardEl.hidden = true;
      return;
    }
    settings.hidden = true;
  }
});
window.addEventListener('resize', () => {
  placeAll();
  if (pinned) renderCard();
  if (linksOpen()) renderLinks();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !loopOn) startLoop();
});

try { bootGl(); }
catch (err) {
  note.textContent = 'the ink would not start';
  settings.hidden = false;
  console.error(err);
}

// ---- signing in: when a passcode is set on the server, nothing loads until it is given
const loginEl = document.getElementById('login');
const loginForm = document.getElementById('loginform');
const loginMsg = document.getElementById('loginmsg');
const passInput = document.getElementById('passcode');
const codeInput = document.getElementById('authcode');
const loginBtn = document.getElementById('loginbtn');
const signOutBtn = document.getElementById('signout');
const passkeyBtn = document.getElementById('passkeybtn');
const addPasskeyBtn = document.getElementById('addpasskey');
let csrf = '';
let authed = false;
let sessionInfo = { mode: 'off', totp: false };

function showLogin(note) {
  authed = false;
  loginEl.hidden = false;
  const locked = sessionInfo.mode === 'locked';
  passInput.hidden = locked;
  loginBtn.hidden = locked;
  codeInput.hidden = locked || !sessionInfo.totp;
  passkeyBtn.hidden = locked || !(sessionInfo.passkeys > 0 && sessionInfo.rp && window.PublicKeyCredential);
  loginMsg.textContent = locked
    ? 'set a passcode on the server first:  node server.js set-passcode'
    : (note || '');
  if (!locked) setTimeout(() => passInput.focus(), 50);
}

function apiFetch(url, opts = {}) {
  const o = { ...opts, headers: { ...(opts.headers || {}) } };
  if (o.method && o.method !== 'GET') o.headers['x-minu-csrf'] = csrf;
  return fetch(url, o).then((res) => {
    if (res.status === 401 && authed) loadSession(); // signed out meanwhile: ask again
    return res;
  });
}

async function loadSession() {
  try {
    const res = await fetch('/api/session', { cache: 'no-store' });
    sessionInfo = await res.json();
  } catch {
    return false;
  }
  signOutBtn.hidden = sessionInfo.mode !== 'on';
  addPasskeyBtn.hidden = !(sessionInfo.mode === 'on' && sessionInfo.authed && sessionInfo.rp && window.PublicKeyCredential);
  if (sessionInfo.mode === 'locked' || (sessionInfo.mode === 'on' && !sessionInfo.authed)) {
    showLogin('');
    return false;
  }
  csrf = sessionInfo.csrf || '';
  authed = true;
  loginEl.hidden = true;
  return true;
}

function afterSignIn() {
  poll();
  loadConfigForm();
  if (sessionInfo.mode === 'on') loadTermCaps();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginMsg.textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passcode: passInput.value, code: codeInput.value }),
    });
    const body = await res.json();
    if (body.ok) {
      passInput.value = '';
      codeInput.value = '';
      if (await loadSession()) afterSignIn();
    } else if (body.retry) {
      loginMsg.textContent = `too many tries, wait ${Math.max(1, Math.ceil(body.retry / 60))} minutes`;
    } else {
      loginMsg.textContent = 'that did not match';
      passInput.select();
    }
  } catch {
    loginMsg.textContent = 'minu could not be reached';
  }
});

// ---- passkeys: sign in with Touch ID, Face ID or a security key
const b64 = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (text) => {
    const s = text.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
  },
};
const jsonHead = { 'content-type': 'application/json' };

passkeyBtn.addEventListener('click', async () => {
  loginMsg.textContent = '';
  try {
    const begin = await (await fetch('/api/passkey/login/begin', { method: 'POST', headers: jsonHead, body: '{}' })).json();
    if (!begin.ok) {
      loginMsg.textContent = begin.error || 'passkeys are not available here';
      return;
    }
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: b64.dec(begin.challenge),
        rpId: begin.rpId,
        allowCredentials: begin.allow.map((id) => ({ type: 'public-key', id: b64.dec(id) })),
        userVerification: 'required',
        timeout: 60000,
      },
    });
    const r = cred.response;
    const res = await fetch('/api/passkey/login/finish', {
      method: 'POST',
      headers: jsonHead,
      body: JSON.stringify({
        id: begin.id,
        credId: b64.enc(cred.rawId),
        clientData: b64.enc(r.clientDataJSON),
        authData: b64.enc(r.authenticatorData),
        signature: b64.enc(r.signature),
      }),
    });
    const body = await res.json();
    if (body.ok) {
      if (await loadSession()) afterSignIn();
    } else {
      loginMsg.textContent = body.retry ? 'too many tries, wait a while' : 'that passkey was not accepted';
    }
  } catch (err) {
    loginMsg.textContent = err && err.name === 'NotAllowedError' ? 'cancelled' : 'the passkey did not work';
  }
});

addPasskeyBtn.addEventListener('click', async () => {
  const label = 'add a passkey to this device';
  try {
    const begin = await (await apiFetch('/api/passkey/add/begin', { method: 'POST', headers: jsonHead, body: '{}' })).json();
    if (!begin.ok) {
      addPasskeyBtn.textContent = begin.error || 'could not start';
      return;
    }
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'minu', id: begin.rpId },
        user: { id: b64.dec(begin.userId), name: 'minu', displayName: 'minu' },
        challenge: b64.dec(begin.challenge),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        excludeCredentials: begin.allow.map((id) => ({ type: 'public-key', id: b64.dec(id) })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        attestation: 'none',
        timeout: 60000,
      },
    });
    const r = cred.response;
    const res = await apiFetch('/api/passkey/add/finish', {
      method: 'POST',
      headers: jsonHead,
      body: JSON.stringify({
        id: begin.id,
        credId: b64.enc(cred.rawId),
        clientData: b64.enc(r.clientDataJSON),
        authData: b64.enc(r.getAuthenticatorData()),
        publicKey: b64.enc(r.getPublicKey()),
        name: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'this device',
      }),
    });
    const body = await res.json();
    addPasskeyBtn.textContent = body.ok ? 'passkey added' : (body.error || 'that did not work');
  } catch (err) {
    addPasskeyBtn.textContent = err && err.name === 'NotAllowedError' ? 'cancelled' : 'the passkey did not work';
  }
  setTimeout(() => { addPasskeyBtn.textContent = label; }, 4000);
});

signOutBtn.addEventListener('click', async () => {
  settings.hidden = true;
  closeTerm();
  try { await apiFetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); } catch { /* gone */ }
  await loadSession();
});

// ---- terminals: a shell in a container, or on the server itself when that is enabled
const termEl = document.getElementById('term');
const termTitle = document.getElementById('termtitle');
const termState = document.getElementById('termstate');
const termBox = document.getElementById('termbox');
let termCaps = { docker: false, host: false };
let term = null;
let termFit = null;
let termId = '';
let termSource = null;
let termWatch = null;
let termPending = '';
let termSending = false;

function canTerm(m) {
  if (!m) return false;
  if (m.kind === 'server') return termCaps.host;
  return m.kind === 'docker' && termCaps.docker && (m.health === 'up' || m.health === 'unhealthy' || m.health === 'uneasy');
}

async function loadTermCaps() {
  try {
    const res = await apiFetch('/api/term/caps');
    const d = await res.json();
    if (d.ok) {
      termCaps = { docker: Boolean(d.docker), host: Boolean(d.host) };
      if (pinned) renderCard();
    }
  } catch { /* stays off */ }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}

async function loadTermLibrary() {
  if (window.Terminal && window.FitAddon) return;
  if (!document.querySelector('link[data-term]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'vendor/xterm.css';
    l.dataset.term = '1';
    document.head.appendChild(l);
  }
  await loadScript('vendor/xterm.js');
  await loadScript('vendor/addon-fit.js');
}

// keystrokes go out in order, batched while a request is in flight
async function termSend(data) {
  termPending += data;
  if (termSending) return;
  termSending = true;
  while (termPending && termId) {
    const chunk = termPending;
    termPending = '';
    try {
      await apiFetch('/api/term/in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: termId, data: chunk }),
      });
    } catch { /* the stream will say if it is gone */ }
  }
  termSending = false;
}

async function openTerm(kind, machine) {
  if (!authed || !machine) return;
  closeLogs();
  closeLinks();
  if (finderOpen()) closeFinder();
  settings.hidden = true;
  closeTerm();
  termTitle.textContent = kind === 'host' ? `${machine.name} · root shell` : machine.name;
  termState.textContent = 'connecting…';
  termEl.hidden = false;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  try {
    await loadTermLibrary();
  } catch (err) {
    termState.textContent = err.message;
    return;
  }
  term = new window.Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    theme: {
      background: '#0a0807',
      foreground: '#f2eadc',
      cursor: '#ffffff',
      selectionBackground: 'rgba(255, 255, 255, 0.28)',
    },
  });
  termFit = new window.FitAddon.FitAddon();
  term.loadAddon(termFit);
  term.open(termBox);
  termFit.fit();
  let opened;
  try {
    const res = await apiFetch('/api/term/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, ref: machine.id, cols: term.cols, rows: term.rows }),
    });
    opened = await res.json();
  } catch {
    opened = { ok: false, error: 'minu could not be reached' };
  }
  if (!opened.ok) {
    termState.textContent = opened.error || 'could not open a shell';
    return;
  }
  termId = opened.id;
  termState.textContent = kind === 'host' ? 'connected to the server itself' : 'connected';
  termSource = new EventSource(`/api/term/out?id=${termId}`);
  termSource.onmessage = (event) => {
    const bin = atob(event.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    term.write(bytes);
  };
  termSource.addEventListener('end', () => {
    termState.textContent = 'the session ended';
    if (termSource) termSource.close();
    termSource = null;
    termId = '';
  });
  termSource.onerror = () => {
    // do not auto-reconnect: that would replay the whole backlog into the screen
    if (termSource) termSource.close();
    termSource = null;
    if (termId) termState.textContent = 'the connection was lost';
  };
  term.onData((d) => termSend(d));
  term.onResize(({ cols, rows }) => {
    if (!termId) return;
    apiFetch('/api/term/resize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: termId, cols, rows }),
    }).catch(() => {});
  });
  termWatch = new ResizeObserver(() => { if (termFit && !termEl.hidden) termFit.fit(); });
  termWatch.observe(termBox);
  term.focus();
}

function closeTerm() {
  if (termEl.hidden) return;
  if (termId) {
    apiFetch('/api/term/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: termId }),
    }).catch(() => {});
  }
  termId = '';
  termPending = '';
  if (termSource) termSource.close();
  termSource = null;
  if (termWatch) termWatch.disconnect();
  termWatch = null;
  if (term) term.dispose();
  term = null;
  termFit = null;
  termBox.innerHTML = '';
  termEl.hidden = true;
}

document.getElementById('termclose').addEventListener('click', closeTerm);

ensure({ id: 'server', kind: 'server', name: 'server', health: 'up' });
placeAll();
startLoop();
loadSession().then((ok) => { if (ok) afterSignIn(); });
setInterval(() => { if (authed) poll(); }, 5000);
setTimeout(pingOnce, 1200);
setInterval(pingOnce, 3200);
