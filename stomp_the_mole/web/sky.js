/* Stomp the Mole: the ceiling's animated cartoon sky (DESIGN.md "Walls and ceiling").

   One global, Sky, used by room.js:
     Sky.init(ctx, rect)              rect = {x, y, w, h} of the ceiling in canvas pixels; (re)builds caches
     Sky.frame(nowMs, dtMs, level)    draws the sky into rect (clipped to it) for this frame
     Sky.setMood(mood)                "day" | "warming" | "sunset"
     Sky.celebrate(kind)              "combo" | "highscore" | "go" | "timesup"
     Sky.drawTest(ctx, rect)          no-op (the test pattern is room.js's job)
     Sky.horizon()                    [r, g, b] of the sky's bottom edge now (room.js gives the
                                      walls' sky the same colour where they meet the ceiling)

   The ceiling is seen from below. Its bottom edge meets the top of the front wall, so for
   someone facing the front wall the rect's top is overhead: the gradient runs deep blue at
   the top to light blue at the bottom (the horizon over the front wall), and all art is
   upright in canvas coordinates. No text except the plane's banner.

   Performance: the sky gradients, sun, clouds, birds, balloon, plane, banner, rainbow and
   particle sprites are drawn once into offscreen canvases in init(); frame() only blits
   and transforms them. Time comes from dtMs (clamped), so it runs the same at 30 or 60 fps.
   Particles are pooled and capped at MAX_PARTS; nothing is allocated per particle or per
   sprite in frame(). It never throws: before init, with a zero-size rect or without a
   context, frame() only advances its clocks.
*/
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ constants

  const TAU = Math.PI * 2;
  const INK = '#2a1407';                        // outline colour, as on the floor
  const FONT_STACK = '"Arial Black", "Segoe UI Black", Impact, sans-serif';
  const DEFAULT_RECT = { x: 800, y: 0, w: 1000, h: 787 };
  const BASE_W = 1000, BASE_H = 786;            // the ceiling the art is designed for

  const MAX_PARTS = 400;
  const MAX_FLASHES = 16;
  const MAX_LAUNCHES = 24;
  const MAX_BIRDS = 10;
  const N_GLINTS = 24;                          // ambient sparkles in the sunset sky

  const K_SPARK = 1, K_STAR = 2, K_TRAIL = 3, K_ROCKET = 4, K_CONFETTI = 5, K_GLINT = 6;

  const MOOD_DAY = 0, MOOD_WARMING = 1, MOOD_SUNSET = 2;

  // sky gradients for day, end of warming (late afternoon) and sunset (golden); the same stop
  // positions, so in-between skies are interpolated stop by stop (in HSL: no grey midway)
  const SKY_POS = [0, 0.3, 0.56, 0.8, 1];
  const SKY_KEYS = [
    ['#1b66d2', '#3590ea', '#5fb3f6', '#93d5fc', '#c8efff'],
    ['#2b56b2', '#5a83d2', '#b39fdc', '#f6b69c', '#ffd88e'],
    ['#2a216b', '#6e3890', '#d9558b', '#ff9244', '#ffd35f'],
  ];
  const SKY_STEPS = 8;                          // pre-rendered skies per mood step (17 in all)
  const CLOUD_TINTS = [
    { fill: '#ffffff', shade: '#cde1f7', line: '#21417a', crease: '#a9c8ec' },
    { fill: '#fff3e2', shade: '#f4c4a6', line: '#4a3a70', crease: '#eab08f' },
    { fill: '#ffdcc8', shade: '#ee8fa6', line: '#3a1d58', crease: '#e57b97' },
  ];
  // parallax layers, far to near: size, opacity, drift (px/s on a 1000 px ceiling), count, outline
  const LAYERS = [
    { scale: 0.5, alpha: 0.78, speed: 7, count: 6, line: 3.4 },
    { scale: 0.74, alpha: 1, speed: 14, count: 4, line: 4.4 },
    { scale: 1.0, alpha: 1, speed: 26, count: 3, line: 5.5 },
  ];
  const SHAPES = 3;                             // cloud shapes per layer

  const SUN_DAY = { face: ['#fffbd0', '#ffdd2e', '#ffab12'], cheek: 'rgba(255, 110, 90, 0.55)',
                    rays: ['#fff27a', '#ffb000'] };
  const SUN_SET = { face: ['#ffe2a4', '#ffa53c', '#ff6a2a'], cheek: 'rgba(225, 50, 90, 0.6)',
                    rays: ['#ffc870', '#ff5f3a'] };
  // sun position (fractions of the rect) and size for day, end of warming, sunset
  const SUN_POS = [[0.76, 0.3, 1], [0.66, 0.5, 1.06], [0.5, 0.72, 1.16]];

  const FW = ['#ff4d6d', '#ffd23f', '#45d6ff', '#7cf25a', '#c77dff', '#ff9a1f', '#ffffff'];
  const FW_WHITE = 6;
  const CONFETTI = ['#ff4d6d', '#ffd23f', '#3fa9ff', '#5fe35a', '#c77dff', '#ff9a1f'];
  const RAINBOW = ['#ff4040', '#ff9a2e', '#ffe14a', '#4cd964', '#3fa9ff', '#8a5cff'];
  const BIRD_PALETTES = [
    { body: '#3fa9ff', belly: '#c4e8ff', wing: '#2b86de', dark: '#1f64b0' },
    { body: '#ff5b5b', belly: '#ffd6cc', wing: '#e03c3c', dark: '#b42828' },
    { body: '#ffd23f', belly: '#fff4bf', wing: '#f0b000', dark: '#c98a00' },
  ];
  const BALLOON_GORES = ['#ff4d4d', '#ffd23f', '#3fa9ff', '#ffd23f'];

  // ------------------------------------------------------------------ small helpers

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  const easeOutCubic = (t) => 1 - (1 - t) * (1 - t) * (1 - t);

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // one seeded generator: the sky is the same on every run, which keeps the harness repeatable
  const rnd = mulberry32(20261010);

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  function num(v, fallback) {
    return typeof v === 'number' && isFinite(v) ? v : fallback;
  }

  let reported = false;
  function report(err) {
    if (reported) return;
    reported = true;
    try { console.error('Sky:', err); } catch (e) { /* no console */ }
  }

  // ------------------------------------------------------------------ state

  let ctx = null;
  let ready = false;                 // caches built for a non-empty rect
  let RX = DEFAULT_RECT.x, RY = DEFAULT_RECT.y, W = DEFAULT_RECT.w, H = DEFAULT_RECT.h;
  let S = 1;                         // art scale relative to a 1000 x 786 ceiling
  let builtKey = '';
  let clock = 0;                     // sky time in seconds (sum of clamped frame times)
  let lastNow = NaN;
  let level = 0, levelS = 0;         // level from the state, and a smoothed copy
  let driftMul = 1;                  // cloud drift multiplier (smoothed)

  // base transform = the caller's transform at frame() x translate(rect.x, rect.y)
  let BA = 1, BB = 0, BC = 0, BD = 1, BE = 0, BF = 0;

  const G = {};                      // sprites

  // mood: warm runs 0 (day) .. 1 (end of warming) .. 2 (sunset)
  let mood = MOOD_DAY;
  let warm = 0, warmFrom = 0, warmTo = 0, warmT0 = 0, warmDur = 1, warmLinear = false;

  // sun, recomputed each frame (timesup bursts from it)
  let sunX = 0, sunY = 0, sunK = 1, rayAngle = 0;

  // celebrations
  let goT0 = -1e9, rainbowT0 = -1e9, timesupT0 = -1e9;
  let confettiRainUntil = -1e9, confettiAcc = 0;
  let lastBurstX = -1e9;

  // ------------------------------------------------------------------ transforms

  function readBase() {
    let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
    if (typeof ctx.getTransform === 'function') {
      const m = ctx.getTransform();
      a = m.a; b = m.b; c = m.c; d = m.d; e = m.e; f = m.f;
    }
    BA = a; BB = b; BC = c; BD = d;
    BE = a * RX + c * RY + e;
    BF = b * RX + d * RY + f;
  }

  function resetT() {
    ctx.setTransform(BA, BB, BC, BD, BE, BF);
  }

  // local transform: translate(x, y) . rotate(angle given as cos/sin) . scale(sx, sy)
  function place(x, y, cos, sin, sx, sy) {
    const la = cos * sx, lb = sin * sx, lc = -sin * sy, ld = cos * sy;
    ctx.setTransform(BA * la + BC * lb, BB * la + BD * lb, BA * lc + BC * ld, BB * lc + BD * ld,
      BA * x + BC * y + BE, BB * x + BD * y + BF);
  }

  // ------------------------------------------------------------------ sprites: sky and sun

  function hexToHsl(hex) {
    const v = parseInt(hex.slice(1), 16);
    const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s * 100, l * 100];
  }

  // Hue always turns forwards (blue -> violet -> pink -> orange), the way a sky warms, never
  // back through green; saturation dips a little midway so the in-between skies stay soft.
  function mixHslParts(a, b, t) {
    const A = hexToHsl(a), B = hexToHsl(b);
    const dh = (B[0] - A[0] + 360) % 360;
    const h = (A[0] + dh * t) % 360;
    const sat = lerp(A[1], B[1], t) * (1 - 0.3 * Math.sin(Math.PI * t) * Math.min(1, dh / 120));
    return [+h.toFixed(1), +sat.toFixed(1), +lerp(A[2], B[2], t).toFixed(1)];
  }

  function mixHsl(a, b, t) {
    const p = mixHslParts(a, b, t);
    return 'hsl(' + p[0] + ',' + p[1] + '%,' + p[2] + '%)';
  }

  function hslToRgb(p) {
    const h = p[0], s = p[1] / 100, l = p[2] / 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  }

  // [r, g, b] of each pre-rendered sky's bottom edge (the gradient's last stop): Sky.horizon()
  // blends two of them the way drawSky() blends the skies, so the walls can meet the ceiling.
  const HORIZON = [];
  for (let i = 0; i <= SKY_STEPS * 2; i++) {
    const w = i / SKY_STEPS;
    const k = Math.min(1, Math.floor(w));
    const t = w - k;
    const last = SKY_POS.length - 1;
    HORIZON.push(hslToRgb(t > 0 ? mixHslParts(SKY_KEYS[k][last], SKY_KEYS[k + 1][last], t) : hexToHsl(SKY_KEYS[k][last])));
  }
  const horizonOut = [0, 0, 0];

  // The sky is a vertical gradient only, so each one is a 2 px wide strip, stretched over the
  // rect when drawn: 17 of them cost almost no memory.
  function buildSkies() {
    G.sky = [];
    for (let i = 0; i <= SKY_STEPS * 2; i++) {
      const w = i / SKY_STEPS;
      const k = Math.min(1, Math.floor(w));
      const t = w - k;
      const c = makeCanvas(2, H);
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 0, H);
      for (let j = 0; j < SKY_POS.length; j++) {
        grad.addColorStop(SKY_POS[j], t > 0 ? mixHsl(SKY_KEYS[k][j], SKY_KEYS[k + 1][j], t) : SKY_KEYS[k][j]);
      }
      g.fillStyle = grad;
      g.fillRect(0, 0, 2, H);
      G.sky.push(c);
    }
  }

  function softDot(radius, r, g, b, a0, mid) {
    const c = makeCanvas(radius * 2, radius * 2);
    const x = c.getContext('2d');
    const grad = x.createRadialGradient(radius, radius, 0, radius, radius, radius);
    grad.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',' + a0 + ')');
    grad.addColorStop(mid, 'rgba(' + r + ',' + g + ',' + b + ',' + (a0 * 0.45) + ')');
    grad.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
    x.fillStyle = grad;
    x.fillRect(0, 0, radius * 2, radius * 2);
    return c;
  }

  function raysSprite(R, cols) {
    const RR = R * 1.95, lw = 5 * S;
    const size = Math.ceil((RR + lw * 2) * 2);
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    const cx = size / 2, cy = size / 2;
    const n = 14;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const long = i % 2 === 0;
      const len = (long ? 1.92 : 1.56) * R;
      const hw = long ? 0.2 : 0.15;
      const r0 = R * 0.86;
      g.moveTo(cx + Math.cos(a - hw) * r0, cy + Math.sin(a - hw) * r0);
      g.quadraticCurveTo(cx + Math.cos(a - hw * 0.45) * len * 0.78, cy + Math.sin(a - hw * 0.45) * len * 0.78,
        cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      g.quadraticCurveTo(cx + Math.cos(a + hw * 0.45) * len * 0.78, cy + Math.sin(a + hw * 0.45) * len * 0.78,
        cx + Math.cos(a + hw) * r0, cy + Math.sin(a + hw) * r0);
      g.closePath();
    }
    g.lineJoin = 'round';
    g.lineWidth = lw * 2;
    g.strokeStyle = INK;
    g.stroke();
    const grad = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, RR);
    grad.addColorStop(0, cols[0]);
    grad.addColorStop(1, cols[1]);
    g.fillStyle = grad;
    g.fill();
    // a light streak down each long ray
    g.lineCap = 'round';
    g.lineWidth = 3.5 * S;
    g.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    g.beginPath();
    for (let i = 0; i < n; i += 2) {
      const a = (i / n) * TAU - 0.05;
      g.moveTo(cx + Math.cos(a) * R * 1.12, cy + Math.sin(a) * R * 1.12);
      g.lineTo(cx + Math.cos(a) * R * 1.5, cy + Math.sin(a) * R * 1.5);
    }
    g.stroke();
    return c;
  }

  // eyes: 0 open, 1 closed (blink), 2 happy closed (sunset)
  function faceSprite(R, pal, eyes) {
    const lw = 6 * S;
    const size = Math.ceil(R * 2 + lw * 2 + 4);
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    const cx = size / 2, cy = size / 2;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const grad = g.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.08, cx, cy, R);
    grad.addColorStop(0, pal.face[0]);
    grad.addColorStop(0.55, pal.face[1]);
    grad.addColorStop(1, pal.face[2]);
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.fillStyle = grad;
    g.fill();
    g.lineWidth = lw;
    g.strokeStyle = INK;
    g.stroke();
    // gloss
    g.beginPath();
    g.arc(cx, cy, R * 0.8, Math.PI * 1.1, Math.PI * 1.42);
    g.lineWidth = R * 0.09;
    g.strokeStyle = 'rgba(255, 255, 255, 0.65)';
    g.stroke();
    g.beginPath();
    g.arc(cx - R * 0.47, cy - R * 0.5, R * 0.05, 0, TAU);
    g.fillStyle = 'rgba(255, 255, 255, 0.65)';
    g.fill();
    // cheeks
    g.fillStyle = pal.cheek;
    g.beginPath();
    g.ellipse(cx - R * 0.52, cy + R * 0.2, R * 0.17, R * 0.11, 0, 0, TAU);
    g.ellipse(cx + R * 0.52, cy + R * 0.2, R * 0.17, R * 0.11, 0, 0, TAU);
    g.fill();
    // eyes
    for (let s = -1; s <= 1; s += 2) {
      const ex = cx + s * R * 0.31, ey = cy - R * 0.13;
      if (eyes === 0) {
        g.beginPath();
        g.ellipse(ex, ey, R * 0.15, R * 0.2, 0, 0, TAU);
        g.fillStyle = '#ffffff';
        g.fill();
        g.lineWidth = lw * 0.6;
        g.strokeStyle = INK;
        g.stroke();
        g.beginPath();
        g.arc(ex + s * R * 0.015, ey + R * 0.04, R * 0.095, 0, TAU);
        g.fillStyle = '#1a0d05';
        g.fill();
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.arc(ex + s * R * 0.015 + R * 0.035, ey, R * 0.035, 0, TAU);
        g.fill();
      } else if (eyes === 1) {
        g.beginPath();
        g.moveTo(ex - R * 0.14, ey + R * 0.02);
        g.quadraticCurveTo(ex, ey + R * 0.12, ex + R * 0.14, ey + R * 0.02);
        g.lineWidth = lw * 0.8;
        g.strokeStyle = INK;
        g.stroke();
      } else {
        g.beginPath();
        g.arc(ex, ey + R * 0.08, R * 0.13, Math.PI * 1.12, Math.PI * 1.88);
        g.lineWidth = lw * 0.8;
        g.strokeStyle = INK;
        g.stroke();
      }
      // brow
      g.beginPath();
      g.arc(ex, ey - R * 0.05, R * 0.24, Math.PI * (s < 0 ? 1.3 : 1.45), Math.PI * (s < 0 ? 1.55 : 1.7));
      g.lineWidth = lw * 0.55;
      g.strokeStyle = INK;
      g.stroke();
    }
    // open smile with a tongue
    const mouth = new Path2D();
    mouth.moveTo(cx - R * 0.36, cy + R * 0.18);
    mouth.quadraticCurveTo(cx, cy + R * 0.82, cx + R * 0.36, cy + R * 0.18);
    mouth.quadraticCurveTo(cx, cy + R * 0.33, cx - R * 0.36, cy + R * 0.18);
    mouth.closePath();
    g.fillStyle = '#86181f';
    g.fill(mouth);
    g.save();
    g.clip(mouth);
    g.beginPath();
    g.ellipse(cx, cy + R * 0.56, R * 0.2, R * 0.14, 0, 0, TAU);
    g.fillStyle = '#ff6f86';
    g.fill();
    g.restore();
    g.lineWidth = lw * 0.7;
    g.strokeStyle = INK;
    g.stroke(mouth);
    return c;
  }

  function buildSun() {
    const R = 90 * S;
    G.sunR = R;
    G.rays = [raysSprite(R, SUN_DAY.rays), raysSprite(R, SUN_SET.rays)];
    G.faceDay = [faceSprite(R, SUN_DAY, 0), faceSprite(R, SUN_DAY, 1), faceSprite(R, SUN_DAY, 2)];
    G.faceSet = [faceSprite(R, SUN_SET, 0), faceSprite(R, SUN_SET, 1), faceSprite(R, SUN_SET, 2)];
    G.sunGlow = softDot(Math.round(R * 3.4), 255, 246, 196, 0.75, 0.35);
    G.setGlow = softDot(Math.round(R * 4.2), 255, 200, 110, 0.8, 0.4);
  }

  // ------------------------------------------------------------------ sprites: clouds

  // A cartoon cloud: puffs sitting on a flat base, one outline round the whole shape,
  // a shaded crescent under every puff and little crease lines between puffs.
  function cloudShape(scale) {
    const unit = 44 * scale * S;
    const n = 3 + Math.floor(rnd() * 3);
    const puffs = [];
    let x = 0;
    for (let i = 0; i < n; i++) {
      const mid = 1 - Math.abs(i - (n - 1) / 2) / ((n - 1) / 2 + 0.6);
      const r = unit * (0.62 + 0.62 * mid + rnd() * 0.22);
      if (i > 0) x += (puffs[i - 1].r + r) * (0.62 + rnd() * 0.12);
      puffs.push({ x: x, r: r });
    }
    return { unit: unit, puffs: puffs, hb: unit * 0.42 };
  }

  function cloudPath(shape, ox, oy, grow, lift) {
    const p = new Path2D();
    const base = oy - lift;
    for (const q of shape.puffs) {
      p.moveTo(ox + q.x + q.r + grow, base - q.r);
      p.arc(ox + q.x, base - q.r, q.r + grow, 0, TAU);
    }
    // flat base joining the puffs
    const first = shape.puffs[0], last = shape.puffs[shape.puffs.length - 1];
    const hb = shape.hb + grow;
    const x0 = ox + first.x, x1 = ox + last.x, y0 = base - shape.hb;
    p.moveTo(x0, y0 - hb);
    p.lineTo(x1, y0 - hb);
    p.arc(x1, y0, hb, -Math.PI / 2, Math.PI / 2);
    p.lineTo(x0, y0 + hb);
    p.arc(x0, y0, hb, Math.PI / 2, Math.PI * 1.5);
    p.closePath();
    return p;
  }

  function cloudSprite(shape, tint, lineW) {
    const lw = lineW * S;
    const first = shape.puffs[0], last = shape.puffs[shape.puffs.length - 1];
    let top = 0;
    for (const q of shape.puffs) top = Math.max(top, q.r * 2);
    const pad = lw + 3;
    const w = last.x + last.r - (first.x - first.r) + pad * 2;
    const h = top + pad * 2;
    const c = makeCanvas(w, h);
    const g = c.getContext('2d');
    const ox = pad + first.r - first.x, oy = h - pad;
    g.fillStyle = tint.line;
    g.fill(cloudPath(shape, ox, oy, lw, 0));
    const body = cloudPath(shape, ox, oy, 0, 0);
    g.save();
    g.clip(body);
    g.fillStyle = tint.shade;
    g.fillRect(0, 0, w, h);
    g.fillStyle = tint.fill;
    g.fill(cloudPath(shape, ox - shape.unit * 0.06, oy, 0, shape.unit * 0.26));
    // crease lines where puffs meet
    g.lineCap = 'round';
    g.lineWidth = lw * 0.55;
    g.strokeStyle = tint.crease;
    for (let i = 1; i < shape.puffs.length; i++) {
      const q = shape.puffs[i], p = shape.puffs[i - 1];
      const big = q.r > p.r ? q : p;
      const cxp = ox + big.x, cyp = oy - big.r;
      const a = big === q ? Math.PI * 1.02 : -Math.PI * 0.02;
      g.beginPath();
      g.arc(cxp, cyp, big.r * 0.72, a + (big === q ? 0 : -0.5), a + (big === q ? 0.5 : 0));
      g.stroke();
    }
    // a soft highlight on the biggest puff
    let bigP = shape.puffs[0];
    for (const q of shape.puffs) if (q.r > bigP.r) bigP = q;
    g.beginPath();
    g.ellipse(ox + bigP.x - bigP.r * 0.35, oy - bigP.r * 1.45, bigP.r * 0.28, bigP.r * 0.14, -0.5, 0, TAU);
    g.fillStyle = 'rgba(255, 255, 255, 0.85)';
    g.fill();
    g.restore();
    return c;
  }

  function buildClouds() {
    G.clouds = [];
    for (let L = 0; L < LAYERS.length; L++) {
      const layer = [];
      for (let s = 0; s < SHAPES; s++) {
        const shape = cloudShape(LAYERS[L].scale);
        const tints = [];
        for (let t = 0; t < CLOUD_TINTS.length; t++) tints.push(cloudSprite(shape, CLOUD_TINTS[t], LAYERS[L].line));
        layer.push(tints);
      }
      G.clouds.push(layer);
    }
  }

  const clouds = [];   // {layer, shape, x, y}

  function placeCloud(c, x, band, bands) {
    const spr = G.clouds[c.layer][c.shape][0];
    c.x = x;
    const span = H * 0.95 + spr.height * 0.3;
    c.y = ((band + 0.15 + rnd() * 0.7) / bands) * span - spr.height * 0.75;
  }

  function layoutClouds() {
    clouds.length = 0;
    for (let L = 0; L < LAYERS.length; L++) {
      const n = LAYERS[L].count;
      for (let i = 0; i < n; i++) {
        const c = { layer: L, shape: (i + L) % SHAPES, x: 0, y: 0, band: i };
        const spr = G.clouds[L][c.shape][0];
        placeCloud(c, ((i + 0.2 + rnd() * 0.6) / n) * (W + spr.width) - spr.width, (i * 2 + L) % n, n);
        clouds.push(c);
      }
    }
  }

  function updateClouds(dt) {
    for (let i = 0; i < clouds.length; i++) {
      const c = clouds[i];
      const L = LAYERS[c.layer];
      c.x += L.speed * S * driftMul * dt;
      if (c.x > W + 10 * S) {
        c.shape = Math.floor(rnd() * SHAPES);
        const spr = G.clouds[c.layer][c.shape][0];
        placeCloud(c, -spr.width - rnd() * W * 0.25, Math.floor(rnd() * L.count), L.count);
      }
    }
  }

  // ------------------------------------------------------------------ sprites: birds, balloon, plane, banner

  function drawWing(g, a, colour) {
    g.save();
    g.translate(-3, -4);
    g.rotate(a);
    g.beginPath();
    g.moveTo(2, 0);
    g.bezierCurveTo(-4, -8, -16, -9, -24, -2);
    g.quadraticCurveTo(-18, 2, -19, 5);
    g.quadraticCurveTo(-12, 5, -12, 8);
    g.quadraticCurveTo(-5, 7, 2, 0);
    g.closePath();
    g.fillStyle = colour;
    g.fill();
    g.stroke();
    g.restore();
  }

  // a round cartoon bird facing right; wing angle a (positive = up)
  function birdSprite(pal, a) {
    const u = 1.5 * S;
    const fw = Math.ceil(76 * u), fh = Math.ceil(72 * u);
    const c = makeCanvas(fw, fh);
    const g = c.getContext('2d');
    g.translate(fw / 2, fh / 2 + 6 * u);
    g.scale(u, u);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.strokeStyle = INK;
    g.lineWidth = 2.6;
    drawWing(g, a * 0.85 + 0.2, pal.dark);     // far wing
    // tail
    g.beginPath();
    g.moveTo(-13, -4);
    g.lineTo(-29, -12);
    g.lineTo(-25, -2);
    g.lineTo(-30, 6);
    g.lineTo(-12, 5);
    g.closePath();
    g.fillStyle = pal.wing;
    g.fill();
    g.stroke();
    // body
    g.beginPath();
    g.ellipse(0, 0, 17.5, 14, 0, 0, TAU);
    g.fillStyle = pal.body;
    g.fill();
    g.save();
    g.clip();
    g.beginPath();
    g.ellipse(4, 8, 14, 9, -0.2, 0, TAU);
    g.fillStyle = pal.belly;
    g.fill();
    g.beginPath();
    g.ellipse(-5, -8, 7, 3.5, -0.4, 0, TAU);
    g.fillStyle = 'rgba(255, 255, 255, 0.45)';
    g.fill();
    g.restore();
    g.beginPath();
    g.ellipse(0, 0, 17.5, 14, 0, 0, TAU);
    g.stroke();
    // beak
    g.beginPath();
    g.moveTo(14, -6);
    g.quadraticCurveTo(25, -4, 27, 0);
    g.quadraticCurveTo(22, 3.5, 14, 3);
    g.closePath();
    g.fillStyle = '#ffa21f';
    g.fill();
    g.lineWidth = 2;
    g.stroke();
    // eye and cheek
    g.beginPath();
    g.arc(8, -5, 5.2, 0, TAU);
    g.fillStyle = '#ffffff';
    g.fill();
    g.lineWidth = 1.8;
    g.stroke();
    g.beginPath();
    g.arc(9.6, -4.6, 2.8, 0, TAU);
    g.fillStyle = '#1a0d05';
    g.fill();
    g.beginPath();
    g.arc(10.5, -5.8, 1, 0, TAU);
    g.fillStyle = '#ffffff';
    g.fill();
    g.beginPath();
    g.ellipse(7, 4, 3.5, 2.2, 0, 0, TAU);
    g.fillStyle = 'rgba(255, 110, 140, 0.6)';
    g.fill();
    // near wing
    g.lineWidth = 2.6;
    drawWing(g, a, pal.wing);
    return c;
  }

  function buildBirds() {
    // flap cycle: up, middle, down, middle
    const angles = [1.25, 0.45, -0.5, 0.45];
    G.birds = [];
    for (const pal of BIRD_PALETTES) {
      const frames = [];
      for (const a of angles) frames.push(birdSprite(pal, a));
      G.birds.push(frames);
    }
  }

  // hot-air balloon envelope half-width at height y (units; top y = -150, mouth y = 45)
  function envHalf(y) {
    if (y <= -5) return Math.sqrt(Math.max(0, 8100 - (y + 60) * (y + 60)));
    return lerp(71.2, 24, clamp01((y + 5) / 50));
  }

  function moleHead(g, x, y, r) {
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fillStyle = '#8e5a2f';
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = INK;
    g.stroke();
    g.beginPath();
    g.ellipse(x, y + r * 0.35, r * 0.62, r * 0.42, 0, 0, TAU);
    g.fillStyle = '#efc797';
    g.fill();
    g.beginPath();
    g.ellipse(x, y + r * 0.08, r * 0.3, r * 0.22, 0, 0, TAU);
    g.fillStyle = '#ff6f9c';
    g.fill();
    g.lineWidth = 1.2;
    g.stroke();
    for (let s = -1; s <= 1; s += 2) {
      g.beginPath();
      g.ellipse(x + s * r * 0.36, y - r * 0.28, r * 0.22, r * 0.26, 0, 0, TAU);
      g.fillStyle = '#ffffff';
      g.fill();
      g.lineWidth = 1.2;
      g.stroke();
      g.beginPath();
      g.arc(x + s * r * 0.36, y - r * 0.24, r * 0.13, 0, TAU);
      g.fillStyle = '#1a0d05';
      g.fill();
    }
    // yellow hard hat
    g.beginPath();
    g.moveTo(x - r * 0.85, y - r * 0.55);
    g.bezierCurveTo(x - r * 0.9, y - r * 1.65, x + r * 0.9, y - r * 1.65, x + r * 0.85, y - r * 0.55);
    g.closePath();
    g.fillStyle = '#ffd000';
    g.fill();
    g.lineWidth = 1.8;
    g.stroke();
    g.beginPath();
    g.rect(x - r * 1.15, y - r * 0.62, r * 2.3, r * 0.26);
    g.fillStyle = '#f2b400';
    g.fill();
    g.stroke();
    g.beginPath();
    g.ellipse(x - r * 0.35, y - r * 1.05, r * 0.2, r * 0.11, -0.6, 0, TAU);
    g.fillStyle = 'rgba(255, 255, 255, 0.8)';
    g.fill();
  }

  function buildBalloon() {
    const u = 1.15 * S;
    const w = Math.ceil(200 * u), h = Math.ceil(280 * u);
    const c = makeCanvas(w, h);
    const g = c.getContext('2d');
    G.balloonU = u;
    G.balloonOX = w / 2;        // sprite pixel of the design origin
    G.balloonOY = 160 * u;
    g.translate(G.balloonOX, G.balloonOY);
    g.scale(u, u);
    g.lineJoin = 'round';
    g.lineCap = 'round';

    const N = 48;
    const env = new Path2D();
    env.moveTo(0, -150);
    for (let i = 1; i <= N; i++) {
      const y = -150 + (195 * i) / N;
      env.lineTo(envHalf(y), y);
    }
    for (let i = N; i >= 0; i--) {
      const y = -150 + (195 * i) / N;
      env.lineTo(-envHalf(y), y);
    }
    env.closePath();

    // ropes and the basket hang below, with a mole in a hard hat riding along
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-22, 48); g.lineTo(-26, 84);
    g.moveTo(22, 48); g.lineTo(26, 84);
    g.moveTo(-8, 48); g.lineTo(-10, 84);
    g.moveTo(8, 48); g.lineTo(10, 84);
    g.stroke();
    moleHead(g, -5, 73, 15);
    const basket = new Path2D();
    basket.moveTo(-28, 86);
    basket.lineTo(28, 86);
    basket.lineTo(23, 114);
    basket.quadraticCurveTo(0, 118, -23, 114);
    basket.closePath();
    g.fillStyle = '#c1823f';
    g.fill(basket);
    g.save();
    g.clip(basket);
    g.strokeStyle = '#7a4a1e';
    g.lineWidth = 1.8;
    g.beginPath();
    for (let y = 95; y < 118; y += 8) { g.moveTo(-30, y); g.lineTo(30, y); }
    for (let x = -18; x <= 18; x += 9) { g.moveTo(x, 86); g.lineTo(x * 0.85, 118); }
    g.stroke();
    g.restore();
    g.lineWidth = 2.6;
    g.strokeStyle = INK;
    g.stroke(basket);
    g.beginPath();
    g.rect(-30, 82, 60, 7);
    g.fillStyle = '#a8692e';
    g.fill();
    g.stroke();

    // envelope gores
    g.save();
    g.clip(env);
    for (let j = 0; j < 8; j++) {
      const s0 = Math.sin(-Math.PI / 2 + (Math.PI * j) / 8);
      const s1 = Math.sin(-Math.PI / 2 + (Math.PI * (j + 1)) / 8);
      g.beginPath();
      for (let i = 0; i <= N; i++) {
        const y = -152 + (199 * i) / N;
        if (i === 0) g.moveTo(s0 * envHalf(y), y); else g.lineTo(s0 * envHalf(y) - (j === 0 ? 2 : 0), y);
      }
      for (let i = N; i >= 0; i--) {
        const y = -152 + (199 * i) / N;
        g.lineTo(s1 * envHalf(y) + (j === 7 ? 2 : 0), y);
      }
      g.closePath();
      g.fillStyle = BALLOON_GORES[j % BALLOON_GORES.length];
      g.fill();
    }
    // seams
    g.strokeStyle = 'rgba(42, 20, 7, 0.45)';
    g.lineWidth = 1.6;
    g.beginPath();
    for (let j = 1; j < 8; j++) {
      const s = Math.sin(-Math.PI / 2 + (Math.PI * j) / 8);
      for (let i = 0; i <= N; i++) {
        const y = -150 + (195 * i) / N;
        if (i === 0) g.moveTo(s * envHalf(y), y); else g.lineTo(s * envHalf(y), y);
      }
    }
    g.stroke();
    // round shading: lit from the top left
    const shade = g.createRadialGradient(-30, -95, 8, -10, -60, 120);
    shade.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
    shade.addColorStop(0.35, 'rgba(255, 255, 255, 0)');
    shade.addColorStop(0.75, 'rgba(40, 10, 50, 0.05)');
    shade.addColorStop(1, 'rgba(40, 10, 50, 0.35)');
    g.fillStyle = shade;
    g.fillRect(-100, -160, 200, 210);
    g.restore();
    g.lineWidth = 3.6;
    g.strokeStyle = INK;
    g.stroke(env);
    // mouth band
    g.beginPath();
    g.rect(-25, 40, 50, 9);
    g.fillStyle = '#9a5f2a';
    g.fill();
    g.lineWidth = 2.4;
    g.stroke();
    G.balloon = c;
  }

  // a cartoon biplane flying left, mole pilot in a hard hat; the propeller is drawn live
  function buildPlane() {
    const u = 1.2 * S;
    const w = Math.ceil(180 * u), h = Math.ceil(100 * u);
    const c = makeCanvas(w, h);
    const g = c.getContext('2d');
    G.planeU = u;
    G.planeOX = 92 * u;
    G.planeOY = 52 * u;
    g.translate(G.planeOX, G.planeOY);
    g.scale(u, u);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.strokeStyle = INK;

    // wheels
    g.lineWidth = 2.4;
    g.beginPath();
    g.moveTo(-26, 12); g.lineTo(-30, 30);
    g.moveTo(-14, 12); g.lineTo(-30, 30);
    g.stroke();
    g.beginPath();
    g.arc(-30, 31, 7, 0, TAU);
    g.fillStyle = '#3a3a44';
    g.fill();
    g.stroke();
    g.beginPath();
    g.arc(-30, 31, 2.6, 0, TAU);
    g.fillStyle = '#d8d8e0';
    g.fill();
    // struts and upper wing
    g.lineWidth = 2.6;
    g.beginPath();
    g.moveTo(-38, -40); g.lineTo(-34, 8);
    g.moveTo(-4, -40); g.lineTo(-6, 8);
    g.stroke();
    g.beginPath();
    g.ellipse(-20, -43, 38, 6.5, 0, 0, TAU);
    g.fillStyle = '#ffd23f';
    g.fill();
    g.stroke();
    // pilot: a mole with goggles and a hard hat, red scarf flying back
    g.beginPath();
    g.moveTo(18, -18);
    g.quadraticCurveTo(30, -27, 44, -21);
    g.quadraticCurveTo(36, -17, 46, -13);
    g.quadraticCurveTo(30, -11, 20, -12);
    g.closePath();
    g.fillStyle = '#ff3b3b';
    g.fill();
    g.lineWidth = 2;
    g.stroke();
    moleHead(g, 10, -19, 10.5);
    g.beginPath();
    g.arc(4.2, -22.5, 3.6, 0, TAU);
    g.fillStyle = '#9fe0ff';
    g.fill();
    g.lineWidth = 1.6;
    g.stroke();
    // fuselage
    const body = new Path2D();
    body.moveTo(-58, -9);
    body.bezierCurveTo(-30, -17, 30, -13, 82, -6);
    body.lineTo(84, 4);
    body.bezierCurveTo(40, 13, -20, 18, -58, 12);
    body.quadraticCurveTo(-66, 1.5, -58, -9);
    body.closePath();
    const bg = g.createLinearGradient(0, -16, 0, 16);
    bg.addColorStop(0, '#ff8a7a');
    bg.addColorStop(0.45, '#ff4d3d');
    bg.addColorStop(1, '#c92a20');
    g.fillStyle = bg;
    g.fill(body);
    g.save();
    g.clip(body);
    g.fillStyle = '#ffd23f';
    g.beginPath();
    g.moveTo(-40, 2); g.lineTo(70, -1); g.lineTo(70, 4); g.lineTo(-40, 8);
    g.closePath();
    g.fill();
    g.restore();
    g.lineWidth = 3;
    g.stroke(body);
    // tail fin and stabiliser
    g.beginPath();
    g.moveTo(58, -9);
    g.lineTo(70, -38);
    g.quadraticCurveTo(80, -40, 84, -34);
    g.lineTo(84, -5);
    g.closePath();
    g.fillStyle = '#ff4d3d';
    g.fill();
    g.stroke();
    g.beginPath();
    g.ellipse(74, 3, 15, 4.5, 0, 0, TAU);
    g.fillStyle = '#ffd23f';
    g.fill();
    g.stroke();
    // windscreen
    g.beginPath();
    g.moveTo(-4, -12); g.lineTo(-1, -24); g.lineTo(4, -24); g.lineTo(4, -12);
    g.closePath();
    g.fillStyle = 'rgba(190, 236, 255, 0.85)';
    g.fill();
    g.lineWidth = 2;
    g.stroke();
    // lower wing
    g.beginPath();
    g.ellipse(-16, 9, 34, 6, 0, 0, TAU);
    g.fillStyle = '#ffd23f';
    g.fill();
    g.lineWidth = 3;
    g.stroke();
    // nose cowling and spinner
    g.beginPath();
    g.ellipse(-58, 1.5, 6, 12.5, 0, 0, TAU);
    g.fillStyle = '#d9dbe3';
    g.fill();
    g.stroke();
    g.beginPath();
    g.moveTo(-63, -4);
    g.quadraticCurveTo(-74, 1.5, -63, 7);
    g.closePath();
    g.fillStyle = '#ffd23f';
    g.fill();
    g.lineWidth = 2;
    g.stroke();
    // gloss
    g.beginPath();
    g.moveTo(-40, -8);
    g.quadraticCurveTo(0, -14, 40, -9);
    g.lineWidth = 2.5;
    g.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    g.stroke();
    G.plane = c;
    G.propX = -69;     // design units, relative to the plane origin
    G.propY = 1.5;
    G.tailX = 84;
    G.tailY = 0;
  }

  // the towed banner: red cloth, yellow cartoon lettering like the floor's title
  function buildBanner() {
    const bw = Math.round(640 * S), bh = Math.round(118 * S);
    const pad = Math.round(8 * S);
    const c = makeCanvas(bw + pad * 2, bh + pad * 2);
    const g = c.getContext('2d');
    g.translate(pad, pad);
    g.lineJoin = 'round';
    const cloth = g.createLinearGradient(0, 0, 0, bh);
    cloth.addColorStop(0, '#ff5a48');
    cloth.addColorStop(0.5, '#e8392e');
    cloth.addColorStop(1, '#b8241c');
    g.beginPath();
    g.rect(0, 0, bw, bh);
    g.fillStyle = cloth;
    g.fill();
    // hems with white stitching
    g.fillStyle = '#ffd23f';
    g.fillRect(0, 0, bw, 11 * S);
    g.fillRect(0, bh - 11 * S, bw, 11 * S);
    g.setLineDash([10 * S, 8 * S]);
    g.lineWidth = 2 * S;
    g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    g.beginPath();
    g.moveTo(8 * S, 17 * S); g.lineTo(bw - 8 * S, 17 * S);
    g.moveTo(8 * S, bh - 17 * S); g.lineTo(bw - 8 * S, bh - 17 * S);
    g.stroke();
    g.setLineDash([]);
    g.lineWidth = 4 * S;
    g.strokeStyle = INK;
    g.strokeRect(0, 0, bw, bh);
    // leading pole
    g.beginPath();
    g.rect(-5 * S, -6 * S, 10 * S, bh + 12 * S);
    g.fillStyle = '#8a5a2b';
    g.fill();
    g.lineWidth = 2.5 * S;
    g.stroke();
    // lettering
    const text = 'STOMP THE MOLE';
    let px = 70 * S;
    g.font = '900 ' + Math.round(px) + 'px ' + FONT_STACK;
    const tw = g.measureText(text).width;
    const maxW = bw - 64 * S;
    if (tw > maxW) {
      px *= maxW / tw;
      g.font = '900 ' + Math.round(px) + 'px ' + FONT_STACK;
    }
    const cx = bw / 2 + 3 * S, cy = bh / 2 + 2 * S;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = px * 0.22;
    g.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    g.strokeText(text, cx + px * 0.03, cy + px * 0.08);
    g.strokeStyle = INK;
    g.strokeText(text, cx, cy);
    const fill = g.createLinearGradient(0, cy - px * 0.38, 0, cy + px * 0.38);
    fill.addColorStop(0, '#fff07a');
    fill.addColorStop(1, '#ffa800');
    g.fillStyle = fill;
    g.fillText(text, cx, cy);
    g.save();
    g.beginPath();
    g.rect(0, 0, bw, cy - px * 0.1);
    g.clip();
    g.globalAlpha = 0.4;
    g.fillStyle = '#ffffff';
    g.fillText(text, cx, cy);
    g.restore();
    G.banner = c;
    G.bannerPad = pad;
    G.bannerW = bw;
    G.bannerH = bh;
    G.bannerSlice = Math.max(4, Math.round(16 * S));
  }

  // ------------------------------------------------------------------ sprites: celebrations

  function buildRainbow() {
    const bw = 25 * S, n = RAINBOW.length;
    const RO = Math.min(W * 0.47, H * 0.62);
    const pad = 8 * S;
    const w = RO * 2 + pad * 2, h = RO + pad * 2;
    const c = makeCanvas(w, h);
    const g = c.getContext('2d');
    const cx = c.width / 2, cy = RO + pad;
    for (let i = 0; i < n; i++) {
      g.beginPath();
      g.arc(cx, cy, RO - bw * (i + 0.5), Math.PI, TAU);
      g.lineWidth = bw + 1;
      g.strokeStyle = RAINBOW[i];
      g.stroke();
    }
    g.lineWidth = 1.5 * S;
    g.strokeStyle = 'rgba(42, 20, 7, 0.28)';
    for (let i = 1; i < n; i++) {
      g.beginPath();
      g.arc(cx, cy, RO - bw * i, Math.PI, TAU);
      g.stroke();
    }
    g.lineWidth = 5 * S;
    g.strokeStyle = INK;
    g.beginPath();
    g.arc(cx, cy, RO, Math.PI, TAU);
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, RO - bw * n, Math.PI, TAU);
    g.stroke();
    g.lineCap = 'round';
    g.lineWidth = 4 * S;
    g.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    g.beginPath();
    g.arc(cx, cy, RO - bw * 0.4, Math.PI * 1.1, Math.PI * 1.38);
    g.stroke();
    G.rainbow = c;
    G.rbCX = cx;
    G.rbCY = cy;
    G.rbRO = RO;
    G.rbFoot = RO - bw * n * 0.5;
  }

  // A firework spark's tail: a tapering streak pointing +x that ends at the head's centre
  // (sprite x = c.ox). Drawn rotated along the spark's velocity and stretched by its speed.
  function sparkTail(col) {
    const L = 64 * S, hr = 4.2 * S, pad = 8 * S;
    const c = makeCanvas(L + hr + pad * 2, hr * 2 + pad * 2);
    const g = c.getContext('2d');
    const hx = pad + L, hy = c.height / 2;
    const tail = new Path2D();
    tail.moveTo(pad, hy);
    tail.quadraticCurveTo(hx - hr * 4, hy - hr * 0.8, hx, hy - hr);
    tail.arc(hx, hy, hr, -Math.PI / 2, Math.PI / 2);
    tail.quadraticCurveTo(hx - hr * 4, hy + hr * 0.8, pad, hy);
    tail.closePath();
    g.lineJoin = 'round';
    g.lineWidth = 2 * S;
    g.strokeStyle = 'rgba(42, 20, 7, 0.45)';
    g.stroke(tail);
    const grad = g.createLinearGradient(pad, 0, hx, 0);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
    grad.addColorStop(0.55, col);
    grad.addColorStop(1, col);
    g.fillStyle = grad;
    g.fill(tail);
    c.ox = hx;
    c.oy = hy;
    return c;
  }

  // ...and its head: an outlined glowing dot with a white core
  function sparkHead(col) {
    const r = 7 * S, glow = 15 * S;
    const c = makeCanvas(glow * 2, glow * 2);
    const g = c.getContext('2d');
    const m = c.width / 2;
    const halo = g.createRadialGradient(m, m, r * 0.5, m, m, glow);
    halo.addColorStop(0, col);
    halo.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.globalAlpha = 0.55;
    g.fillStyle = halo;
    g.fillRect(0, 0, c.width, c.height);
    g.globalAlpha = 1;
    g.beginPath();
    g.arc(m, m, r, 0, TAU);
    g.fillStyle = col;
    g.fill();
    g.lineWidth = 2.4 * S;
    g.strokeStyle = INK;
    g.stroke();
    g.beginPath();
    g.arc(m - r * 0.15, m - r * 0.15, r * 0.45, 0, TAU);
    g.fillStyle = '#ffffff';
    g.fill();
    return c;
  }

  function starSprite(col) {
    const R = 13 * S, lw = 2.6 * S;
    const size = Math.ceil((R + lw) * 2 + 2);
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    const cx = size / 2, cy = size / 2;
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i * Math.PI) / 5 - Math.PI / 2;
      const r = i % 2 ? R * 0.47 : R;
      if (i === 0) g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      else g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    g.closePath();
    g.fillStyle = col;
    g.fill();
    g.lineJoin = 'round';
    g.lineWidth = lw;
    g.strokeStyle = INK;
    g.stroke();
    g.beginPath();
    g.ellipse(cx - R * 0.2, cy - R * 0.25, R * 0.18, R * 0.1, -0.6, 0, TAU);
    g.fillStyle = 'rgba(255, 255, 255, 0.8)';
    g.fill();
    return c;
  }

  // a four-pointed twinkle with a soft halo (sunset sparkles, rockets, the GO ring)
  function glintSprite(core, glowR, glowG, glowB) {
    const R = Math.round(22 * S);
    const c = makeCanvas(R * 2, R * 2);
    const g = c.getContext('2d');
    const halo = g.createRadialGradient(R, R, 0, R, R, R);
    halo.addColorStop(0, 'rgba(' + glowR + ',' + glowG + ',' + glowB + ',0.7)');
    halo.addColorStop(1, 'rgba(' + glowR + ',' + glowG + ',' + glowB + ',0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, R * 2, R * 2);
    g.beginPath();
    const k = R * 0.16;
    g.moveTo(R, 0);
    g.quadraticCurveTo(R + k * 0.3, R - k * 0.3, R * 2, R);
    g.quadraticCurveTo(R + k * 0.3, R + k * 0.3, R, R * 2);
    g.quadraticCurveTo(R - k * 0.3, R + k * 0.3, 0, R);
    g.quadraticCurveTo(R - k * 0.3, R - k * 0.3, R, 0);
    g.closePath();
    g.fillStyle = core;
    g.fill();
    g.beginPath();
    g.arc(R, R, R * 0.16, 0, TAU);
    g.fillStyle = '#ffffff';
    g.fill();
    return c;
  }

  function confettiSprite(col) {
    const w = 15 * S, h = 24 * S, lw = 2 * S;
    const c = makeCanvas(w + lw * 2 + 2, h + lw * 2 + 2);
    const g = c.getContext('2d');
    const x = lw + 1, y = lw + 1;
    g.fillStyle = col;
    g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(255, 255, 255, 0.4)';
    g.fillRect(x, y, w * 0.45, h);
    g.lineWidth = lw;
    g.strokeStyle = INK;
    g.strokeRect(x, y, w, h);
    return c;
  }

  function buildFx() {
    G.tail = FW.map(sparkTail);
    G.head = FW.map(sparkHead);
    G.star = FW.map(starSprite);
    G.confetti = CONFETTI.map(confettiSprite);
    G.glint = [glintSprite('#fff3b0', 255, 205, 80), glintSprite('#ffffff', 255, 255, 230)];
    G.trail = softDot(Math.round(9 * S), 255, 236, 160, 0.95, 0.5);
    G.flash = softDot(Math.round(110 * S), 255, 255, 240, 0.9, 0.35);
  }

  function buildAll() {
    buildSkies();
    buildSun();
    buildClouds();
    layoutClouds();
    buildBirds();
    buildBalloon();
    buildPlane();
    buildBanner();
    buildRainbow();
    buildFx();
  }

  // ------------------------------------------------------------------ particles (pooled)

  const parts = [];
  for (let i = 0; i < MAX_PARTS; i++) {
    parts.push({ on: false, kind: 0, x: 0, y: 0, vx: 0, vy: 0, sx: 0, sy: 0, tx: 0, ty: 0, age: 0, life: 1,
                 size: 1, rot: 0, vr: 0, col: 0, drag: 0, g: 0, flip: 0, vf: 0, seed: 0, acc: 0, big: false });
  }
  let partCursor = 0;
  let partsLive = 0;

  // A free particle, or null when the pool is full; `force` recycles the next slot instead
  // (fireworks), so low-priority effects (trails, confetti) give way at the cap.
  function spawn(kind, force) {
    let p = null;
    if (partsLive < MAX_PARTS) {
      for (let i = 0; i < MAX_PARTS; i++) {
        const idx = (partCursor + i) % MAX_PARTS;
        if (!parts[idx].on) {
          p = parts[idx];
          partCursor = (idx + 1) % MAX_PARTS;
          break;
        }
      }
    }
    if (!p) {
      if (!force) return null;
      p = parts[partCursor];
      partCursor = (partCursor + 1) % MAX_PARTS;
      if (p.on) partsLive--;
    }
    partsLive++;
    p.on = true; p.kind = kind; p.age = 0; p.life = 1; p.size = 1;
    p.x = 0; p.y = 0; p.vx = 0; p.vy = 0; p.drag = 0; p.g = 0;
    p.rot = rnd() * TAU; p.vr = 0; p.col = 0; p.flip = 0; p.vf = 0; p.seed = rnd() * TAU; p.acc = 0; p.big = false;
    return p;
  }

  function kill(p) {
    if (p.on) {
      p.on = false;
      partsLive--;
    }
  }

  const flashes = [];
  for (let i = 0; i < MAX_FLASHES; i++) flashes.push({ on: false, x: 0, y: 0, t0: 0, dur: 1, r: 1, col: '#fff' });
  function flash(x, y, r, col, dur) {
    let s = flashes[0];
    for (let i = 0; i < MAX_FLASHES; i++) {
      const f = flashes[i];
      if (!f.on) { s = f; break; }
      if (f.t0 < s.t0) s = f;
    }
    s.on = true; s.x = x; s.y = y; s.r = r; s.col = col; s.dur = dur; s.t0 = clock;
  }

  const launches = [];
  for (let i = 0; i < MAX_LAUNCHES; i++) launches.push({ on: false, t: 0, x: 0, y: 0, col: 0, big: false });
  let lastCol = 0;
  function scheduleBurst(t, big) {
    let s = null;
    for (let i = 0; i < MAX_LAUNCHES; i++) if (!launches[i].on) { s = launches[i]; break; }
    if (!s) return;
    s.on = true; s.t = t;
    lastCol = (lastCol + 1 + Math.floor(rnd() * 3)) % (FW.length - 1);   // never the same colour twice running
    s.col = lastCol;
    s.big = big;
  }

  function launch(l) {
    // the spot is chosen now, not when scheduled (the sun may have moved since): somewhere in
    // the upper part of the sky, clear of the sun's face and of the last burst
    const clear = G.sunR ? G.sunR * sunK + 200 * S : 0;
    let bx = 0, by = 0, best = -1;
    for (let tries = 0; tries < 24; tries++) {
      const x = W * (0.14 + rnd() * 0.72);
      const y = H * (0.16 + rnd() * 0.4);
      const dx = x - sunX, dy = y - sunY;
      const d2 = dx * dx + dy * dy;
      if (d2 > clear * clear && Math.abs(x - lastBurstX) > W * 0.22) { bx = x; by = y; break; }
      if (d2 > best) { best = d2; bx = x; by = y; }      // fallback: the spot farthest from the sun
    }
    l.x = bx;
    l.y = by;
    lastBurstX = bx;
    const p = spawn(K_ROCKET, true);
    p.sx = l.x + (rnd() - 0.5) * 90 * S;
    p.sy = H + 12 * S;
    p.x = p.sx; p.y = p.sy;
    p.tx = l.x; p.ty = l.y;
    p.life = 0.42 + (p.sy - l.y) / (H * 2.2);
    p.col = l.col;
    p.big = l.big;
  }

  // A burst: an outer shell of fast sparks, a looser inner fill, a few tumbling stars and a
  // flash. Drag stops the sparks at about v0 / drag (240-290 px on a 1000 px ceiling).
  function explode(x, y, col, big) {
    flash(x, y, (big ? 1.2 : 1) * 210 * S, FW[col], 0.55);
    const n = big ? 58 : 44;
    const v0 = (big ? 600 : 500) * S;
    let col2 = FW_WHITE;
    if (rnd() < 0.5) col2 = (col + 2 + Math.floor(rnd() * (FW.length - 3))) % (FW.length - 1);
    for (let i = 0; i < n; i++) {
      const shell = i % 10 < 7;
      const a = shell ? (i / n) * TAU + (rnd() - 0.5) * 0.1 : rnd() * TAU;
      const v = v0 * (shell ? 0.9 + rnd() * 0.1 : 0.3 + rnd() * 0.45);
      const p = spawn(K_SPARK, true);
      p.x = x; p.y = y; p.sx = x; p.sy = y;
      p.vx = Math.cos(a) * v; p.vy = Math.sin(a) * v;
      p.drag = 2.1; p.g = 95 * S;
      p.life = 1.15 + rnd() * 0.55;
      p.size = big ? 1.1 : 1;
      p.col = shell && i % 3 === 0 ? col2 : col;
    }
    const ns = big ? 8 : 6;
    for (let i = 0; i < ns; i++) {
      const a = (i / ns) * TAU + rnd() * 0.5;
      const v = v0 * (0.32 + rnd() * 0.12);
      const p = spawn(K_STAR, true);
      p.x = x; p.y = y;
      p.vx = Math.cos(a) * v; p.vy = Math.sin(a) * v;
      p.drag = 1.6; p.g = 40 * S;
      p.life = 1.0 + rnd() * 0.3;
      p.vr = (rnd() < 0.5 ? -1 : 1) * (3 + rnd() * 3);
      p.size = big ? 1.1 : 0.9;
      p.col = rnd() < 0.5 ? col : 1;
    }
  }

  function confettiCannons() {
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 40; i++) {
        const p = spawn(K_CONFETTI, false);
        if (!p) return;
        p.x = side < 0 ? W * 0.05 : W * 0.95;
        p.y = H + 10 * S;
        p.vx = -side * (110 + rnd() * 340) * S;
        p.vy = -(520 + rnd() * 380) * S;
        p.g = 560 * S;
        p.life = 3.6 + rnd() * 1.4;
        p.vf = 5 + rnd() * 9;
        p.vr = (rnd() - 0.5) * 7;
        p.col = Math.floor(rnd() * CONFETTI.length);
      }
    }
  }

  function confettiRain(dt) {
    if (clock > confettiRainUntil) return;
    confettiAcc += dt * 34;
    while (confettiAcc >= 1) {
      confettiAcc -= 1;
      const p = spawn(K_CONFETTI, false);
      if (!p) { confettiAcc = 0; return; }
      p.x = rnd() * W;
      p.y = -12 * S;
      p.vx = (rnd() - 0.5) * 60 * S;
      p.vy = (70 + rnd() * 70) * S;
      p.g = 200 * S;
      p.life = 4.2 + rnd() * 1.2;
      p.vf = 5 + rnd() * 9;
      p.vr = (rnd() - 0.5) * 7;
      p.col = Math.floor(rnd() * CONFETTI.length);
    }
  }

  function updateParts(dt) {
    const termV = 120 * S;
    const swayA = 40 * S;
    for (let i = 0; i < MAX_PARTS; i++) {
      const p = parts[i];
      if (!p.on) continue;
      p.age += dt;
      if (p.kind === K_ROCKET) {
        const f = p.age / p.life;
        if (f >= 1) {
          kill(p);
          explode(p.tx, p.ty, p.col, p.big);
          continue;
        }
        const e = 1 - (1 - f) * (1 - f);
        p.x = lerp(p.sx, p.tx, e) + Math.sin(f * 9 + p.seed) * 4 * S * (1 - f);
        p.y = lerp(p.sy, p.ty, e);
        p.acc += dt;
        while (p.acc >= 0.022) {   // a sparkle trail at a fixed rate, whatever the frame rate
          p.acc -= 0.022;
          const t = spawn(K_TRAIL, false);
          if (!t) break;
          t.x = p.x + (rnd() - 0.5) * 4 * S;
          t.y = p.y + 6 * S;
          t.vx = (rnd() - 0.5) * 30 * S;
          t.vy = (20 + rnd() * 30) * S;
          t.life = 0.3 + rnd() * 0.2;
          t.size = 0.8 + rnd() * 0.5;
        }
        continue;
      }
      if (p.age >= p.life) { kill(p); continue; }
      if (p.kind === K_CONFETTI) {
        const k = Math.exp(-1.5 * dt);
        p.vx *= k;
        p.vy += p.g * dt;
        if (p.vy < 0) p.vy *= Math.exp(-0.8 * dt);
        else if (p.vy > termV) p.vy = termV + (p.vy - termV) * Math.exp(-6 * dt);
        p.x += (p.vx + Math.sin(p.age * 2.6 + p.seed) * swayA * clamp01(p.vy / termV)) * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        p.flip += p.vf * dt;
        if (p.y > H + 30 * S && p.vy > 0) kill(p);
        continue;
      }
      if (p.drag) {
        const k = Math.exp(-p.drag * dt);
        p.vx *= k;
        p.vy *= k;
      }
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
  }

  // ------------------------------------------------------------------ birds and visitors

  const birds = [];
  for (let i = 0; i < MAX_BIRDS; i++) birds.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, pal: 0, phase: 0, k: 1 });
  let nextFlockT = 1.2;

  function spawnFlock() {
    let free = 0;
    for (let i = 0; i < MAX_BIRDS; i++) if (!birds[i].on) free++;
    const n = Math.min(free, 3 + Math.floor(rnd() * 3));
    if (n < 2) return;
    const dir = rnd() < 0.5 ? 1 : -1;
    const y0 = H * (0.12 + rnd() * 0.62);
    const speed = (95 + rnd() * 40) * S;
    const vy = (rnd() - 0.5) * 24 * S;
    const pal = Math.floor(rnd() * BIRD_PALETTES.length);
    let made = 0;
    for (let i = 0; i < MAX_BIRDS; i++) {
      const b = birds[i];
      if (made >= n) break;
      if (b.on) continue;
      const rank = Math.ceil(made / 2);
      const side = made % 2 ? -1 : 1;
      b.on = true;
      b.x = (dir > 0 ? -50 * S : W + 50 * S) - dir * rank * (52 + rnd() * 14) * S;
      b.y = y0 + side * rank * (30 + rnd() * 10) * S;
      b.vx = dir * speed * (0.97 + rnd() * 0.06);
      b.vy = vy;
      b.pal = made === 0 ? pal : (rnd() < 0.7 ? pal : Math.floor(rnd() * BIRD_PALETTES.length));
      b.phase = rnd();
      b.k = made === 0 ? 1.05 : 0.86 + rnd() * 0.12;
      made++;
    }
  }

  function updateBirds(dt) {
    for (let i = 0; i < MAX_BIRDS; i++) {
      const b = birds[i];
      if (!b.on) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const m = 140 * S + W * 0.3;
      if (b.x < -m || b.x > W + m) b.on = false;
    }
    if (clock >= nextFlockT) {
      spawnFlock();
      nextFlockT = clock + (playing() ? 10 : 6.5) + rnd() * 7;
    }
  }

  // one visitor at a time: a hot-air balloon or the banner plane (attract only, day mood)
  const V_NONE = 0, V_BALLOON = 1, V_PLANE = 2;
  const vis = { kind: V_NONE, x: 0, y: 0, dir: 1, speed: 0, t0: 0, leave: -1, alpha: 1 };
  let nextVisitT = 3.5;
  let nextKind = V_PLANE;

  function playing() {
    return level > 0.0005 || clock - goT0 < 3;
  }

  function visitorsAllowed() {
    return mood === MOOD_DAY && warm < 0.05 && !playing();
  }

  function startVisitor(kind) {
    vis.kind = kind;
    vis.t0 = clock;
    vis.leave = -1;
    vis.alpha = 1;
    if (kind === V_PLANE) {
      vis.dir = -1;                                   // flies right to left: the banner reads after the plane
      vis.x = W + 110 * S;
      vis.y = H * (0.5 + rnd() * 0.08);
      vis.speed = 125 * S;
    } else {
      vis.dir = rnd() < 0.5 ? 1 : -1;
      vis.x = vis.dir > 0 ? -150 * S : W + 150 * S;
      vis.y = H * (0.745 + rnd() * 0.02);
      vis.speed = 40 * S;
    }
  }

  function visitorGone() {
    if (vis.kind === V_PLANE) {
      const tailEnd = vis.x + (110 * S + G.bannerW) ;
      return vis.dir < 0 ? tailEnd < -40 * S : vis.x - 110 * S - G.bannerW > W + 40 * S;
    }
    return vis.dir > 0 ? vis.x > W + 160 * S : vis.x < -160 * S;
  }

  function updateVisitor(dt) {
    const allowed = visitorsAllowed();
    if (vis.kind !== V_NONE) {
      if (!allowed && vis.leave < 0) vis.leave = clock;
      let sp = vis.speed;
      if (vis.leave >= 0) {
        const e = clock - vis.leave;
        sp *= 1 + 2.5 * e;
        vis.alpha = clamp01(1 - e / 1.2);
      }
      vis.x += vis.dir * sp * dt;
      if (vis.alpha <= 0 || (ready && visitorGone())) {
        vis.kind = V_NONE;
        nextVisitT = clock + 14 + rnd() * 14;
      }
    } else if (allowed) {
      if (clock >= nextVisitT && ready) {
        startVisitor(nextKind);
        nextKind = nextKind === V_PLANE ? V_BALLOON : V_PLANE;
      }
    } else if (nextVisitT < clock + 6) {
      nextVisitT = clock + 6;                       // back in attract: a little pause first
    }
  }

  // ambient sunset sparkles
  const glints = [];
  for (let i = 0; i < N_GLINTS; i++) glints.push({ x: 0, y: 0, t0: -1, dur: 1, k: 1, col: 0 });
  function updateGlints() {
    for (let i = 0; i < N_GLINTS; i++) {
      const s = glints[i];
      if (s.t0 < 0 || clock - s.t0 > s.dur) {
        s.t0 = clock + rnd() * 1.4;
        s.dur = 1.2 + rnd() * 1.4;
        s.x = W * (0.04 + rnd() * 0.92);
        s.y = H * (0.03 + rnd() * 0.62);
        s.k = 0.45 + rnd() * 0.7;
        s.col = rnd() < 0.6 ? 0 : 1;
      }
    }
  }

  // ------------------------------------------------------------------ mood

  function moodValue(m) {
    return m === MOOD_SUNSET ? 2 : m === MOOD_WARMING ? 1 : 0;
  }

  function updateMood() {
    const f = clamp01((clock - warmT0) / warmDur);
    warm = lerp(warmFrom, warmTo, warmLinear ? f : smooth(f));
  }

  // ------------------------------------------------------------------ update

  function update(dt) {
    updateMood();
    levelS += (level - levelS) * Math.min(1, dt * 1.2);
    const sunset = clamp01(warm - 1);
    const drift = lerp(1 + 2.4 * levelS, 0.7, sunset);
    driftMul += (drift - driftMul) * Math.min(1, dt * 1.5);
    rayAngle = (rayAngle + dt * (0.11 + 0.22 * levelS)) % TAU;

    // sun: day -> end of warming -> sunset
    const p0 = warm <= 1 ? SUN_POS[0] : SUN_POS[1];
    const p1 = warm <= 1 ? SUN_POS[1] : SUN_POS[2];
    const f = warm <= 1 ? warm : warm - 1;
    sunX = W * lerp(p0[0], p1[0], f);
    sunY = H * lerp(p0[1], p1[1], f);
    sunK = lerp(p0[2], p1[2], f);

    for (let i = 0; i < MAX_LAUNCHES; i++) {
      const l = launches[i];
      if (l.on && clock >= l.t) {
        l.on = false;
        launch(l);
      }
    }
    if (ready) updateClouds(dt);
    updateParts(dt);
    confettiRain(dt);
    updateBirds(dt);
    updateVisitor(dt);
    if (sunset > 0) updateGlints();
  }

  // ------------------------------------------------------------------ drawing

  function blend2(a, b, t, alpha, x, y) {
    if (t < 0.995) {
      ctx.globalAlpha = alpha;
      ctx.drawImage(a, x, y);
    }
    if (t > 0.005) {
      ctx.globalAlpha = alpha * (t > 0.995 ? 1 : t);
      ctx.drawImage(b, x, y);
    }
  }

  function drawSky() {
    const x = Math.max(0, Math.min(SKY_STEPS * 2, warm * SKY_STEPS));
    const i = Math.min(SKY_STEPS * 2 - 1, Math.floor(x));
    const t = x - i;
    if (t < 0.995) {
      ctx.globalAlpha = 1;
      ctx.drawImage(G.sky[i], 0, 0, W, H);
    }
    if (t > 0.005) {
      ctx.globalAlpha = t > 0.995 ? 1 : t;
      ctx.drawImage(G.sky[i + 1], 0, 0, W, H);
    }
    ctx.globalAlpha = 1;
  }

  function drawCloudLayer(L) {
    const base = warm <= 1 ? 0 : 1;
    const t = warm <= 1 ? warm : warm - 1;
    const a = LAYERS[L].alpha;
    for (let i = 0; i < clouds.length; i++) {
      const c = clouds[i];
      if (c.layer !== L) continue;
      const tints = G.clouds[L][c.shape];
      if (c.x > W || c.x + tints[0].width < 0) continue;
      blend2(tints[base], tints[base + 1], t, a, c.x, c.y);
    }
    ctx.globalAlpha = 1;
  }

  function drawSunGlow() {
    const sunset = clamp01(warm - 1);
    const g = G.sunGlow;
    const k = sunK * (1 + 0.04 * Math.sin(clock * 1.3));
    ctx.globalAlpha = 0.7 * (1 - sunset);
    if (sunset < 1) ctx.drawImage(g, sunX - (g.width * k) / 2, sunY - (g.height * k) / 2, g.width * k, g.height * k);
    if (sunset > 0) {
      const s = G.setGlow;
      const ks = k * (1 + 0.06 * Math.sin(clock * 0.9));
      ctx.globalAlpha = 0.85 * sunset;
      ctx.drawImage(s, sunX - (s.width * ks) / 2, sunY - (s.height * ks) / 2, s.width * ks, s.height * ks);
    }
    ctx.globalAlpha = 1;
  }

  function drawSun() {
    const k = sunK * (1 + 0.018 * Math.sin(clock * 2.1));
    const tint = clamp01(warm / 2);
    const cos = Math.cos(rayAngle), sin = Math.sin(rayAngle);
    for (let i = 0; i < 2; i++) {
      const a = i === 0 ? 1 : tint;
      if (a <= 0.005 || (i === 0 && tint >= 0.995)) continue;
      const r = G.rays[i];
      ctx.globalAlpha = a;
      place(sunX, sunY, cos, sin, k, k);
      ctx.drawImage(r, -r.width / 2, -r.height / 2);
    }
    resetT();
    // the face's colour follows the mood; the eyes switch (never cross-fade): open and
    // blinking by day, closed happily once the sunset is more than half way in
    const faceMix = clamp01(warm - 1);
    const eyes = faceMix > 0.5 ? 2 : (clock % 4.6) < 0.15 ? 1 : 0;
    const day = G.faceDay[eyes];
    const fw = day.width * k;
    const x = sunX - fw / 2, y = sunY - fw / 2;
    if (faceMix < 0.995) {
      ctx.globalAlpha = 1;
      ctx.drawImage(day, x, y, fw, fw);
    }
    if (faceMix > 0.005) {
      ctx.globalAlpha = faceMix;
      ctx.drawImage(G.faceSet[eyes], x, y, fw, fw);
    }
    ctx.globalAlpha = 1;
  }

  function drawRainbow() {
    const e = clock - rainbowT0;
    const DUR = 6;
    if (e < 0 || e > DUR) return;
    const reveal = easeOutCubic(clamp01(e / 0.9));
    const alpha = e > DUR - 1.2 ? clamp01((DUR - e) / 1.2) : 1;
    const cx = W / 2, cy = H + 14 * S;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, G.rbRO + 10 * S, Math.PI, Math.PI + Math.PI * reveal);
    ctx.closePath();
    ctx.clip();
    ctx.globalAlpha = alpha;
    ctx.drawImage(G.rainbow, cx - G.rbCX, cy - G.rbCY);
    ctx.restore();
    // puffy clouds at its feet
    const base = warm <= 1 ? 0 : 1;
    const t = warm <= 1 ? warm : warm - 1;
    const tints = G.clouds[2][0];
    const cw = tints[0].width * 0.8, ch = tints[0].height * 0.8;
    for (let s = -1; s <= 1; s += 2) {
      const footA = s < 0 ? alpha * clamp01(e / 0.25) : alpha * clamp01((e - 0.6) / 0.3);
      if (footA <= 0) continue;
      const fx = cx + s * G.rbFoot - cw / 2, fy = cy - 14 * S - ch * 0.85;
      if (t < 0.995) {
        ctx.globalAlpha = footA;
        ctx.drawImage(tints[base], fx, fy, cw, ch);
      }
      if (t > 0.005) {
        ctx.globalAlpha = footA * t;
        ctx.drawImage(tints[base + 1], fx, fy, cw, ch);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawBirds() {
    for (let i = 0; i < MAX_BIRDS; i++) {
      const b = birds[i];
      if (!b.on) continue;
      const cyc = clock * 4.2 + b.phase;
      const fr = Math.floor((cyc - Math.floor(cyc)) * 4);
      const spr = G.birds[b.pal][fr];
      const bob = Math.sin(cyc * TAU) * 3 * S;
      const dir = b.vx < 0 ? -1 : 1;
      place(b.x, b.y - bob, 1, 0, dir * b.k, b.k);
      ctx.drawImage(spr, -spr.width / 2, -spr.height / 2);
    }
    resetT();
  }

  function drawBalloon() {
    const u = G.balloonU;
    const e = clock - vis.t0;
    const y = vis.y + Math.sin(e * 0.7) * 12 * S;
    const ang = Math.sin(e * 0.9) * 0.035;
    ctx.globalAlpha = vis.alpha;
    place(vis.x, y, Math.cos(ang), Math.sin(ang), u, u);
    ctx.drawImage(G.balloon, -G.balloonOX / u, -G.balloonOY / u, G.balloon.width / u, G.balloon.height / u);
    // the mole waves from the basket
    const wave = 0.35 + 0.5 * Math.sin(e * 6.5);
    const sx = 12, sy = 86;
    const ex = sx + Math.sin(wave) * 22, ey = sy - Math.cos(wave) * 22;
    ctx.lineCap = 'round';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.strokeStyle = '#8e5a2f';
    ctx.lineWidth = 5.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ex, ey, 5.6, 0, TAU);
    ctx.fillStyle = '#d9a370';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.stroke();
    resetT();
    ctx.globalAlpha = 1;
  }

  function drawPlane() {
    const u = G.planeU;
    const e = clock - vis.t0;
    const px = vis.x, py = vis.y + Math.sin(e * 1.6) * 7 * S;
    const tilt = Math.cos(e * 1.6) * 0.025;
    ctx.globalAlpha = vis.alpha;

    // banner, waving: drawn in vertical slices that ride a travelling wave
    const bw = G.bannerW, bh = G.bannerH, pad = G.bannerPad, sl = G.bannerSlice;
    const bx = px + 120 * S;          // banner's leading edge (the plane flies left)
    const by = py - bh / 2 + 10 * S;
    const amp = 9 * S;
    const n = Math.ceil(bw / sl);
    const ban = G.banner;
    const w0 = e * 5.2;
    for (let i = 0; i < n; i++) {
      const sx = i * sl;
      const f = sx / bw;
      const off = Math.sin(w0 - f * 7.5) * amp * (0.25 + 0.75 * f);
      const w = Math.min(sl + 1, bw - sx + pad);
      ctx.drawImage(ban, pad + sx, 0, w, ban.height, bx + sx, by + off - pad, w, ban.height);
    }
    // light and shade along the folds
    for (let i = 0; i < n; i++) {
      const sx = i * sl;
      const f = sx / bw;
      const slope = Math.cos(w0 - f * 7.5) * (0.25 + 0.75 * f);
      const off = Math.sin(w0 - f * 7.5) * amp * (0.25 + 0.75 * f);
      const w = Math.min(sl + 1, bw - sx);
      if (slope > 0.15) {
        ctx.globalAlpha = vis.alpha * 0.2 * slope;
        ctx.fillStyle = '#000000';
      } else if (slope < -0.15) {
        ctx.globalAlpha = vis.alpha * -0.16 * slope;
        ctx.fillStyle = '#ffffff';
      } else {
        continue;
      }
      ctx.fillRect(bx + sx, by + off, w, bh);
    }
    ctx.globalAlpha = vis.alpha;

    // tow rope from the tail to the banner's pole
    const tx = px + G.tailX * u, ty = py + G.tailY * u;
    const ry = by + Math.sin(w0) * amp * 0.25 + bh / 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.6 * S;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.quadraticCurveTo((tx + bx) / 2, Math.max(ty, ry) + 14 * S, bx, ry);
    ctx.stroke();

    // plane and propeller
    place(px, py, Math.cos(tilt), Math.sin(tilt), u, u);
    ctx.drawImage(G.plane, -G.planeOX / u, -G.planeOY / u, G.plane.width / u, G.plane.height / u);
    ctx.beginPath();
    ctx.ellipse(G.propX, G.propY, 3.5, 26, 0, 0, TAU);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(42, 20, 7, 0.35)';
    ctx.stroke();
    const blade = 24 * Math.abs(Math.cos(clock * 47));
    ctx.fillStyle = INK;
    ctx.fillRect(G.propX - 2, G.propY - blade, 4, blade * 2);
    resetT();
    ctx.globalAlpha = 1;
  }

  function drawGlints() {
    const sunset = clamp01(warm - 1);
    if (sunset <= 0) return;
    for (let i = 0; i < N_GLINTS; i++) {
      const s = glints[i];
      const f = (clock - s.t0) / s.dur;
      if (f < 0 || f > 1) continue;
      const tw = Math.sin(Math.PI * f);
      const k = s.k * tw;
      if (k < 0.03) continue;
      const spr = G.glint[s.col];
      ctx.globalAlpha = sunset * tw;
      place(s.x, s.y, Math.cos(f * 2), Math.sin(f * 2), k, k);
      ctx.drawImage(spr, -spr.width / 2, -spr.height / 2);
    }
    resetT();
    ctx.globalAlpha = 1;
  }

  function drawFlashes() {
    for (let i = 0; i < MAX_FLASHES; i++) {
      const f = flashes[i];
      if (!f.on) continue;
      const e = (clock - f.t0) / f.dur;
      if (e >= 1) { f.on = false; continue; }
      const k = lerp(0.35, 1, easeOutCubic(e));
      const d = G.flash.width * (f.r / (110 * S)) * k;
      ctx.globalAlpha = (1 - e) * (1 - e) * 0.85;
      ctx.drawImage(G.flash, f.x - d / 2, f.y - d / 2, d, d);
      ctx.globalAlpha = 1 - e;
      ctx.lineWidth = 7 * S * (1 - e) + 1;
      ctx.strokeStyle = f.col;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r * 0.9 * easeOutCubic(e) + 2, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawParts() {
    // sprites without rotation first (no transform changes)
    for (let i = 0; i < MAX_PARTS; i++) {
      const p = parts[i];
      if (!p.on) continue;
      if (p.kind === K_TRAIL) {
        const f = p.age / p.life;
        const d = G.trail.width * p.size * (1 - 0.6 * f);
        ctx.globalAlpha = 1 - f;
        ctx.drawImage(G.trail, p.x - d / 2, p.y - d / 2, d, d);
      } else if (p.kind === K_ROCKET) {
        const spr = G.glint[1];
        const d = spr.width * (0.75 + 0.15 * Math.sin(p.age * 50));
        ctx.globalAlpha = 1;
        ctx.drawImage(spr, p.x - d / 2, p.y - d / 2, d, d);
      }
    }
    // rotating sprites
    const tailRef = 1 / (64 * S);                       // tail sprite length
    const tailMax = 125 * S;
    for (let i = 0; i < MAX_PARTS; i++) {
      const p = parts[i];
      if (!p.on) continue;
      if (p.kind === K_SPARK) {
        const f = p.age / p.life;
        let a = f < 0.6 ? 1 : (1 - f) / 0.4;
        if (f > 0.5) a *= 0.55 + 0.45 * Math.sin(p.age * 38 + p.seed);
        const k = p.size * (1 - 0.35 * f);
        const tail = G.tail[p.col], head = G.head[p.col];
        // classic chrysanthemum: each tail points back at the burst centre, grows with the
        // distance flown, and fades sooner than the head
        const dx = p.x - p.sx, dy = p.y - p.sy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        let len = dist * 0.5;
        if (len > tailMax) len = tailMax;
        const ta = a * (f < 0.35 ? 1 : Math.max(0, 1 - (f - 0.35) / 0.4));
        if (dist > 1 && ta > 0.02) {
          ctx.globalAlpha = ta;
          place(p.x, p.y, dx / dist, dy / dist, len * tailRef, k);
          ctx.drawImage(tail, -tail.ox, -tail.oy);
        }
        ctx.globalAlpha = a;
        place(p.x, p.y, 1, 0, k, k);                     // the head stays round
        ctx.drawImage(head, -head.width / 2, -head.height / 2);
      } else if (p.kind === K_STAR) {
        const f = p.age / p.life;
        const k = p.size * (1 - 0.5 * f);
        const spr = G.star[p.col];
        ctx.globalAlpha = f < 0.7 ? 1 : (1 - f) / 0.3;
        place(p.x, p.y, Math.cos(p.rot), Math.sin(p.rot), k, k);
        ctx.drawImage(spr, -spr.width / 2, -spr.height / 2);
      } else if (p.kind === K_GLINT) {
        const f = p.age / p.life;
        const k = p.size * (0.55 + 0.45 * Math.sin(p.age * 13 + p.seed)) * (1 - 0.3 * f);
        if (k <= 0.02) continue;
        const spr = G.glint[p.col];
        ctx.globalAlpha = f < 0.7 ? 1 : (1 - f) / 0.3;
        place(p.x, p.y, Math.cos(p.rot), Math.sin(p.rot), k, k);
        ctx.drawImage(spr, -spr.width / 2, -spr.height / 2);
      }
    }
    resetT();
    ctx.globalAlpha = 1;
  }

  function drawConfetti() {
    for (let i = 0; i < MAX_PARTS; i++) {
      const p = parts[i];
      if (!p.on || p.kind !== K_CONFETTI) continue;
      const f = p.age / p.life;
      const spr = G.confetti[p.col];
      let fl = Math.cos(p.flip);
      if (fl > -0.15 && fl < 0.15) fl = fl < 0 ? -0.15 : 0.15;
      ctx.globalAlpha = f < 0.85 ? 1 : (1 - f) / 0.15;
      place(p.x, p.y, Math.cos(p.rot), Math.sin(p.rot), 1, fl);
      ctx.drawImage(spr, -spr.width / 2, -spr.height / 2);
    }
    resetT();
    ctx.globalAlpha = 1;
  }

  // GO: a quick bright flash and a ring of stars bursting out from the middle
  function drawGo() {
    const e = clock - goT0;
    if (e < 0 || e > 1.0) return;
    const cx = W / 2, cy = H * 0.45;
    const f = e / 1.0;
    const r = lerp(40 * S, Math.max(W, H) * 0.62, easeOutCubic(f));
    ctx.globalAlpha = 1 - f * f;
    ctx.lineWidth = 30 * S * (1 - f) + 5 * S;
    ctx.strokeStyle = INK;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();
    ctx.lineWidth = 22 * S * (1 - f) + 2 * S;
    ctx.strokeStyle = '#ffe14a';
    ctx.stroke();
    ctx.lineWidth = 6 * S * (1 - f) + 1 * S;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, r - 4 * S * (1 - f), Math.PI * 1.05, Math.PI * 1.45);
    ctx.stroke();
    const n = 18;
    const k = 2.3 * (1 - 0.45 * f);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + f * 0.8;
      const spr = i % 2 ? G.star[1] : G.glint[1];
      ctx.globalAlpha = 1 - f * f;
      const rot = a * 2 + e * 6;
      place(cx + Math.cos(a) * r * 0.88, cy + Math.sin(a) * r * 0.88, Math.cos(rot), Math.sin(rot), k, k);
      ctx.drawImage(spr, -spr.width / 2, -spr.height / 2);
    }
    resetT();
    if (e < 0.4) {
      ctx.globalAlpha = 0.6 * (1 - e / 0.4) * (1 - e / 0.4);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalAlpha = 1;
  }

  // TIME'S UP: golden rings and sparkles out of the sun
  function drawTimesupRings() {
    const e = clock - timesupT0;
    if (e < 0 || e > 1.6) return;
    for (let i = 0; i < 2; i++) {
      const f = (e - i * 0.3) / 1.2;
      if (f <= 0 || f >= 1) continue;
      ctx.globalAlpha = 1 - f;
      ctx.lineWidth = 12 * S * (1 - f) + 2 * S;
      ctx.strokeStyle = '#ffe58a';
      ctx.beginPath();
      ctx.arc(sunX, sunY, G.sunR * sunK * (1.1 + 3.2 * easeOutCubic(f)), 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function draw() {
    readBase();
    ctx.beginPath();
    ctx.rect(RX, RY, W, H);
    ctx.clip();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    resetT();

    drawSky();
    drawSunGlow();
    drawCloudLayer(0);
    drawRainbow();
    drawCloudLayer(1);
    if (vis.kind === V_BALLOON) drawBalloon();
    drawCloudLayer(2);
    drawBirds();
    drawSun();                                      // nothing but the plane and effects covers its face
    if (vis.kind === V_PLANE) drawPlane();
    drawGlints();
    drawTimesupRings();
    drawFlashes();
    drawParts();
    drawGo();
    drawConfetti();
  }

  // ------------------------------------------------------------------ public API

  function init(context, rect) {
    try {
      ctx = context && typeof context.drawImage === 'function' ? context : null;
      const r = rect || DEFAULT_RECT;
      const x = num(r.x, DEFAULT_RECT.x), y = num(r.y, DEFAULT_RECT.y);
      const w = Math.floor(num(r.w, rect ? 0 : DEFAULT_RECT.w));
      const h = Math.floor(num(r.h, rect ? 0 : DEFAULT_RECT.h));
      if (!ctx || w <= 0 || h <= 0) {
        ready = false;
        return;
      }
      RX = x; RY = y;
      const key = w + 'x' + h;
      if (key !== builtKey || !ready) {
        W = w; H = h;
        S = Math.min(W / BASE_W, H / BASE_H);
        buildAll();
        builtKey = key;
        // effects in flight were laid out for the old size
        for (const p of parts) p.on = false;
        partsLive = 0;
        for (const f of flashes) f.on = false;
        for (const b of birds) b.on = false;
        vis.kind = V_NONE;
      }
      ready = true;
    } catch (err) {
      ready = false;
      report(err);
    }
  }

  function frame(nowMs, dtMs, lvl) {
    try {
      let dt = typeof dtMs === 'number' && isFinite(dtMs) && dtMs >= 0 ? dtMs : NaN;
      if (isNaN(dt) && typeof nowMs === 'number' && isFinite(nowMs) && isFinite(lastNow)) dt = nowMs - lastNow;
      if (typeof nowMs === 'number' && isFinite(nowMs)) lastNow = nowMs;
      if (!(dt >= 0)) dt = 0;
      if (dt > 100) dt = 100;                       // a stalled tab must not jump the sky
      dt /= 1000;
      level = typeof lvl === 'number' && isFinite(lvl) ? clamp01(lvl) : 0;
      clock += dt;
      update(dt);
      if (!ready || !ctx) return;
      ctx.save();
      try {
        draw();
      } finally {
        ctx.restore();
      }
    } catch (err) {
      report(err);
    }
  }

  function setMood(m) {
    try {
      const v = m === 'sunset' ? MOOD_SUNSET : m === 'warming' ? MOOD_WARMING : m === 'day' ? MOOD_DAY : -1;
      if (v < 0 || v === mood) return;
      updateMood();
      mood = v;
      warmFrom = warm;
      warmTo = moodValue(v);
      warmT0 = clock;
      if (v === MOOD_WARMING && warm < 1) {
        warmDur = Math.max(0.5, 10 * (1 - warm));   // the last 10 s of a round
        warmLinear = true;
      } else {
        warmDur = v === MOOD_SUNSET ? 1.6 : 2.0;
        warmLinear = false;
      }
    } catch (err) {
      report(err);
    }
  }

  function celebrate(kind) {
    try {
      if (kind === 'combo') {
        const n = 2 + Math.floor(rnd() * 3);
        for (let i = 0; i < n; i++) scheduleBurst(clock + i * 0.3 + rnd() * 0.12, false);
      } else if (kind === 'highscore') {
        rainbowT0 = clock;
        for (let i = 0; i < 12; i++) scheduleBurst(clock + 0.1 + i * 0.36 + rnd() * 0.15, i % 3 === 0);
        confettiCannons();
        confettiRainUntil = clock + 2.4;
        confettiAcc = 0;
      } else if (kind === 'go') {
        goT0 = clock;
      } else if (kind === 'timesup') {
        timesupT0 = clock;
        flash(sunX, sunY, 300 * S, '#ffe58a', 0.8);
        const r0 = (G.sunR || 90 * S) * 0.6;
        for (let i = 0; i < 44; i++) {
          const p = spawn(K_GLINT, true);
          const a = rnd() * TAU;
          const v = (110 + rnd() * 320) * S;
          p.x = sunX + Math.cos(a) * r0;
          p.y = sunY + Math.sin(a) * r0;
          p.vx = Math.cos(a) * v;
          p.vy = Math.sin(a) * v;
          p.drag = 1.5;
          p.g = 15 * S;
          p.life = 1.5 + rnd() * 1.2;
          p.size = 0.55 + rnd() * 0.8;
          p.vr = (rnd() - 0.5) * 3;
          p.col = rnd() < 0.65 ? 0 : 1;
        }
      }
    } catch (err) {
      report(err);
    }
  }

  function drawTest() { /* the test pattern is room.js's job */ }

  // The colour of the sky's bottom edge (where the ceiling meets the front wall) as of the last
  // frame(): [r, g, b], 0..255. The same array is reused (nothing allocated); copy it to keep it.
  function horizon() {
    const x = Math.max(0, Math.min(SKY_STEPS * 2, warm * SKY_STEPS));
    const i = Math.min(SKY_STEPS * 2 - 1, Math.floor(x));
    const f = x - i;
    const t = f <= 0.005 ? 0 : f >= 0.995 ? 1 : f;   // as drawSky() blends sky i and sky i + 1
    const a = HORIZON[i], b = HORIZON[i + 1];
    horizonOut[0] = Math.round(lerp(a[0], b[0], t));
    horizonOut[1] = Math.round(lerp(a[1], b[1], t));
    horizonOut[2] = Math.round(lerp(a[2], b[2], t));
    return horizonOut;
  }

  root.Sky = { init: init, frame: frame, setMood: setMood, celebrate: celebrate, drawTest: drawTest,
               horizon: horizon };
})(typeof window !== 'undefined' ? window : this);
