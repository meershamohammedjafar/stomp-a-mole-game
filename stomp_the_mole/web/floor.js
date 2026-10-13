/* Stomp the Mole: floor renderer (DESIGN.md "Floor renderer").

   Draws the cartoon field, the moles, hit/miss effects and the floor HUD at 60 fps from
   the data feed, and plays the sounds for feed events. The Python engine owns every
   outcome; this page only shows what the feed says. All geometry (floor size, holes,
   START pad) comes from the hello config. All art is canvas code: no images, no fonts.

   hud.show_on_floor "auto": while a wall page (role "room") is connected, the walls show
   the score, timer and today's top N, so the floor drops its HUD band, its attract top-N
   page and its results table (the countdown stays). It switches live, with a short fade.
*/
(function () {
  'use strict';

  // ------------------------------------------------------------------ constants

  const FONT_STACK = '"Arial Black", "Segoe UI Black", Impact, sans-serif';
  const INK = '#2a1407';                       // outline colour for text and cartoon art
  const SHADOW = 'rgba(0, 0, 0, 0.5)';
  const TAU = Math.PI * 2;
  const TIMES_UP_MS = 1700;                    // results: "TIME'S UP!" before the score panel
  const ATTRACT_PAGE_MS = 6000;                // attract: title <-> today's top N
  const COMBO_BANNER_MS = 1000;
  const HUD_FADE_MS = 450;                     // floor HUD in / out when the walls connect or go
  const UP_GUESS_MS = 1500;                    // a mole made from a mole_up event, until state says
  const MAX_PARTICLES = 260;
  const MAX_RINGS = 20;
  const MAX_FLOATERS = 12;
  const MAX_FEET = 24;
  const MAX_PEEKS = 3;
  const EMPTY = [];

  const FACE_UP = 0, FACE_RISE = 1, FACE_TAUNT = 2, FACE_HIT = 3;
  const P_STAR = 0, P_DIRT = 1, P_DUST = 2, P_PUFF = 3, P_SPARK = 4;
  const DIRT_COLOURS = ['#7a4a24', '#9c6a3c', '#5a3417', '#b58050'];
  const MEDALS = ['#ffcf33', '#dfe7ee', '#e8995c'];
  const PAD_DASH = [14, 10];

  const canvas = document.getElementById('floor');
  const ctx = canvas.getContext('2d');
  const audio = window.StompAudio;

  // ------------------------------------------------------------------ small helpers

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutCubic = (t) => 1 - (1 - t) * (1 - t) * (1 - t);
  const easeInQuad = (t) => t * t;
  function easeOutBack(t) {
    const c1 = 1.70158, c3 = c1 + 1, u = t - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
  }

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

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  const fontCache = new Map();
  function font(px) {
    px = Math.max(6, Math.round(px));
    let f = fontCache.get(px);
    if (!f) {
      f = '900 ' + px + 'px ' + FONT_STACK;
      fontCache.set(px, f);
    }
    return f;
  }

  // Bold text with a drop shadow and a thick dark outline: readable on a coarse LED floor.
  function outlined(g, str, x, y, px, fill, align) {
    g.font = font(px);
    g.textAlign = align || 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = Math.max(3, px * 0.2);
    g.strokeStyle = SHADOW;
    g.strokeText(str, x, y + Math.max(2, px * 0.07));
    g.strokeStyle = INK;
    g.strokeText(str, x, y);
    g.fillStyle = fill;
    g.fillText(str, x, y);
  }

  function outlinedScaled(str, x, y, px, fill, align, s) {
    if (s === 1) {
      outlined(ctx, str, x, y, px, fill, align);
      return;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    outlined(ctx, str, 0, 0, px, fill, align);
    ctx.restore();
  }

  function rrect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // ------------------------------------------------------------------ geometry from the hello config

  let W = 560, H = 448;       // canvas size until the hello config gives the floor size
  let U = 1;                  // UI scale relative to a 560 x 448 floor
  let cfg = null;
  let cfgKey = '';
  let holes = [];             // see makeHole()
  let holesByIndex = [];
  let pad = null;             // {x, y, r}
  let hudH = 40;              // HUD band height = grid.top_margin from the hello config
  let rot180 = false;
  let hudMode = 'auto';       // hud.show_on_floor: 'auto' (only while no wall page is connected), true or false
  let hudOn = true;           // the floor shows its HUD band, attract top N and results table
  let hudFade = 1;            // 0..1, follows hudOn over HUD_FADE_MS (the live switch)
  let hudKnown = false;       // hudOn has been set from a state: until then there is nothing to fade from
  let topN = 10;              // highscores.size: length of today's table
  let topTitle = "TODAY'S TOP 10";
  const T = { rise: 160, sink: 200, hit: 450, escape: 350, step: 1000, go: 800, play: 60000, warn: 10 };

  let field = null;           // pre-rendered grass, flowers and dirt holes
  const G = {};               // gradients and sprites built once per config

  function num(v, fallback) {
    return typeof v === 'number' && isFinite(v) ? v : fallback;
  }

  // Fallback for a hello without grid.top_margin (an older server). Rows are at
  // y = tm + (H - tm) * (2r + 1) / (2 * rows), so the first row gives it back.
  function deriveTopMargin(list) {
    const ys = [];
    for (const h of list) {
      if (!ys.some((y) => Math.abs(y - h.y) < 1)) ys.push(h.y);
    }
    if (!ys.length) return 40 * U;
    ys.sort((a, b) => a - b);
    const rows = ys.length;
    const tm = (2 * rows * ys[0] - H) / (2 * rows - 1);
    return Math.max(0, tm);
  }

  function makeHole(h) {
    const R = num(h.draw_radius, 48);
    const k = R / 48;
    const hole = {
      index: h.index, x: h.x, y: h.y, R: R, k: k,
      orx: R * 0.82, ory: R * 0.5,      // opening
      mrx: R * 1.22, mry: R * 0.74,     // dirt mound
      clip: null, occ: null, lip: null, lipX: 0, lipY: 0,
    };
    // The mole is visible above the hole's centre line and inside the opening's lower
    // half; the front rim hides the rest.
    const wide = R * 1.35;
    const p = new Path2D();
    p.moveTo(h.x - wide, h.y - R * 3.2);
    p.lineTo(h.x + wide, h.y - R * 3.2);
    p.lineTo(h.x + wide, h.y);
    p.lineTo(h.x + hole.orx, h.y);
    p.ellipse(h.x, h.y, hole.orx, hole.ory, 0, 0, Math.PI, false);
    p.lineTo(h.x - wide, h.y);
    p.closePath();
    hole.clip = p;
    // darkness inside the hole, laid over the lower part of a mole
    const occ = ctx.createLinearGradient(0, h.y - hole.ory * 0.35, 0, h.y + hole.ory);
    occ.addColorStop(0, 'rgba(12, 6, 2, 0)');
    occ.addColorStop(1, 'rgba(12, 6, 2, 0.8)');
    hole.occ = occ;
    // front lip sprite, drawn over the mole so it looks embedded in the hole
    const lw = (hole.orx + 10 * k) * 2;
    const lh = (hole.ory + 10 * k) * 2;
    const lip = makeCanvas(lw, lh);
    drawLip(lip.getContext('2d'), lw / 2, lh / 2, hole.orx, hole.ory, k);
    hole.lip = lip;
    hole.lipX = h.x - lw / 2;
    hole.lipY = h.y - lh / 2;
    return hole;
  }

  function applyConfig(c) {
    const key = JSON.stringify(c);
    if (key === cfgKey) return;
    cfgKey = key;
    cfg = c;
    const floor = c.floor || {};
    W = num(floor.width, 560);
    H = num(floor.height, 448);
    U = Math.min(W / 560, H / 448);
    fitCanvas();

    const list = Array.isArray(c.holes) ? c.holes : [];
    holes = list.map(makeHole);
    holesByIndex = [];
    for (const h of holes) holesByIndex[h.index] = h;
    const grid = c.grid || {};
    hudH = Math.max(28 * U, typeof grid.top_margin === 'number' && isFinite(grid.top_margin)
      ? grid.top_margin : deriveTopMargin(list));
    topN = Math.max(1, Math.round(num((c.highscores || {}).size, 10)));
    topTitle = "TODAY'S TOP " + topN;

    const sp = c.start_pad || {};
    pad = { x: num(sp.x, W / 2), y: num(sp.y, H / 2), r: num(sp.radius, 72) };

    const hud = c.hud || {};
    rot180 = Math.abs(num(hud.rotation, 0)) % 360 === 180;
    hudMode = hud.show_on_floor === true || hud.show_on_floor === false ? hud.show_on_floor : 'auto';
    if (latest) updateHudTarget(latest);

    const r = c.round || {};
    const m = c.moles || {};
    T.rise = num(m.rise_ms, 160);
    T.sink = num(m.sink_ms, 200);
    T.hit = num(m.hit_anim_ms, 450);
    T.escape = num(m.escape_anim_ms, 350);
    T.step = num(r.countdown_step_ms, 1000);
    T.go = num(r.go_ms, 800);
    T.play = num(r.play_ms, 60000);
    T.warn = num(r.time_warning_s, 10);

    if (audio) audio.setVolume(num((c.audio || {}).volume, 0.8));

    buildSprites();
    buildField();
    buildTitle();
    resetPeeks();
  }

  // ------------------------------------------------------------------ canvas sizing

  // The canvas is exactly W x H device pixels at the top-left, whatever the zoom or DPI.
  function fitCanvas() {
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = (W / dpr) + 'px';
    canvas.style.height = (H / dpr) + 'px';
  }

  let dprQuery = null;
  function watchDpr() {
    if (dprQuery) dprQuery.removeEventListener('change', onDprChange);
    dprQuery = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
    dprQuery.addEventListener('change', onDprChange);
  }
  function onDprChange() {
    fitCanvas();
    watchDpr();
  }

  // ------------------------------------------------------------------ static art

  function drawLip(g, x, y, orx, ory, k) {
    g.lineCap = 'round';
    g.beginPath();
    g.ellipse(x, y, orx, ory, 0, 0.1, Math.PI - 0.1);
    g.lineWidth = 6.5 * k;
    g.strokeStyle = '#9a663a';
    g.stroke();
    g.beginPath();
    g.ellipse(x, y + 1.6 * k, orx + 0.6 * k, ory + 0.6 * k, 0, 0.4, Math.PI - 0.4);
    g.lineWidth = 2 * k;
    g.strokeStyle = '#d6a26c';
    g.stroke();
  }

  function drawMound(g, h, rnd) {
    const x = h.x, y = h.y, k = h.k;
    const my = y + 4 * k;   // mound sits a little lower: more of its front slope shows
    g.fillStyle = 'rgba(14, 44, 8, 0.38)';
    g.beginPath();
    g.ellipse(x + 2 * k, my + 6 * k, h.mrx + 4 * k, h.mry + 3 * k, 0, 0, TAU);
    g.fill();

    const mg = g.createRadialGradient(x - h.mrx * 0.25, my - h.mry * 0.6, h.mry * 0.1, x, my, h.mrx * 1.05);
    mg.addColorStop(0, '#cf9760');
    mg.addColorStop(0.55, '#9b663b');
    mg.addColorStop(1, '#6a4020');
    g.fillStyle = mg;
    g.beginPath();
    g.ellipse(x, my, h.mrx, h.mry, 0, 0, TAU);
    g.fill();
    g.lineWidth = 2.5 * k;
    g.strokeStyle = '#47280f';
    g.stroke();

    // clods and pebbles on the mound
    for (let i = 0; i < 22; i++) {
      const a = rnd() * TAU;
      const f = lerp(1.12, 0.9, rnd());
      const px = x + Math.cos(a) * lerp(h.orx, h.mrx, 0.5) * f;
      const py = my + Math.sin(a) * lerp(h.ory, h.mry, 0.5) * f;
      const r = (1.3 + rnd() * 2.2) * k;
      g.fillStyle = rnd() < 0.5 ? '#6f4422' : '#c48d58';
      g.beginPath();
      g.ellipse(px, py, r * 1.3, r, 0, 0, TAU);
      g.fill();
    }
    for (let i = 0; i < 3; i++) {
      const a = Math.PI * (0.15 + 0.7 * rnd()) + (i === 1 ? Math.PI : 0);
      const px = x + Math.cos(a) * h.mrx * 0.86;
      const py = my + Math.sin(a) * h.mry * 0.82;
      const r = (2.4 + rnd() * 1.6) * k;
      g.fillStyle = '#9a9488';
      g.beginPath();
      g.ellipse(px, py, r * 1.35, r, 0, 0, TAU);
      g.fill();
      g.lineWidth = 1 * k;
      g.strokeStyle = '#4b463d';
      g.stroke();
      g.fillStyle = '#d2cdc2';
      g.beginPath();
      g.ellipse(px - r * 0.4, py - r * 0.35, r * 0.45, r * 0.3, 0, 0, TAU);
      g.fill();
    }

    // the opening: lit far wall at the top, dark depth below
    const og = g.createLinearGradient(0, y - h.ory, 0, y + h.ory);
    og.addColorStop(0, '#553217');
    og.addColorStop(0.42, '#2a170a');
    og.addColorStop(1, '#0a0502');
    g.fillStyle = og;
    g.beginPath();
    g.ellipse(x, y, h.orx, h.ory, 0, 0, TAU);
    g.fill();
    g.beginPath();
    g.ellipse(x, y, h.orx, h.ory, 0, Math.PI, TAU);
    g.lineWidth = 2.5 * k;
    g.strokeStyle = '#3a200c';
    g.stroke();
    drawLip(g, x, y, h.orx, h.ory, k);
  }

  function drawTuft(g, x, y, s, rnd) {
    const blades = 4 + Math.floor(rnd() * 3);
    g.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      g.strokeStyle = pass ? '#8fdc63' : '#2b7a20';
      g.lineWidth = (pass ? 1 : 2.4) * U;
      for (let b = 0; b < blades; b++) {
        const dx = (b - (blades - 1) / 2) * s * 0.32;
        const hgt = s * (0.75 + ((b * 7919) % 5) * 0.12);
        const bend = dx * 0.7;
        g.beginPath();
        g.moveTo(x + dx, y);
        g.quadraticCurveTo(x + dx + bend * 0.2, y - hgt * 0.6, x + dx + bend, y - hgt);
        g.stroke();
      }
    }
  }

  function drawFlower(g, x, y, s, petal) {
    g.fillStyle = 'rgba(20, 60, 10, 0.35)';
    g.beginPath();
    g.ellipse(x + s * 0.4, y + s * 0.7, s * 1.6, s * 0.9, 0, 0, TAU);
    g.fill();
    g.fillStyle = petal;
    g.strokeStyle = 'rgba(42, 20, 7, 0.45)';
    g.lineWidth = 0.8 * U;
    for (let i = 0; i < 5; i++) {
      const a = (i * TAU) / 5 - Math.PI / 2;
      g.beginPath();
      g.ellipse(x + Math.cos(a) * s * 0.85, y + Math.sin(a) * s * 0.85, s * 0.72, s * 0.52, a, 0, TAU);
      g.fill();
      g.stroke();
    }
    g.fillStyle = '#ffae00';
    g.beginPath();
    g.arc(x, y, s * 0.5, 0, TAU);
    g.fill();
  }

  function onMound(x, y, margin) {
    for (const h of holes) {
      const dx = (x - h.x) / (h.mrx + margin);
      const dy = (y - h.y - 4 * h.k) / (h.mry + margin);
      if (dx * dx + dy * dy < 1) return true;
    }
    return false;
  }

  function buildField() {
    field = makeCanvas(W, H);
    const g = field.getContext('2d');
    const rnd = mulberry32(20261010);

    // mowing stripes
    const n = Math.max(4, Math.round(W / (70 * U)));
    const sw = W / n;
    for (let i = 0; i < n; i++) {
      g.fillStyle = i % 2 ? '#58b545' : '#4ba63b';
      g.fillRect(Math.floor(i * sw), 0, Math.ceil(sw) + 1, H);
    }
    // grass texture: lots of short blades
    g.lineCap = 'round';
    g.lineWidth = 1.2 * U;
    const blades = Math.round((W * H) / 220);
    for (let i = 0; i < blades; i++) {
      const x = rnd() * W, y = rnd() * H, len = (3 + rnd() * 5) * U;
      g.strokeStyle = rnd() < 0.55 ? 'rgba(28, 92, 20, 0.35)' : 'rgba(170, 235, 120, 0.25)';
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (rnd() - 0.5) * 3 * U, y - len);
      g.stroke();
    }
    const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.6);
    vg.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vg.addColorStop(1, 'rgba(0, 30, 0, 0.4)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);

    const area = (W * H) / (560 * 448);
    for (let i = 0, placed = 0; i < 400 && placed < 34 * area; i++) {
      const x = rnd() * W, y = rnd() * H;
      if (onMound(x, y, 10 * U)) continue;
      drawTuft(g, x, y, (8 + rnd() * 5) * U, rnd);
      placed++;
    }
    const petals = ['#ffffff', '#ffe066', '#ff9fd0', '#b9e2ff'];
    for (let i = 0, placed = 0; i < 400 && placed < 26 * area; i++) {
      const x = rnd() * W, y = rnd() * H;
      if (onMound(x, y, 8 * U)) continue;
      drawFlower(g, x, y, (3 + rnd() * 1.6) * U, petals[Math.floor(rnd() * petals.length)]);
      placed++;
    }
    for (const h of holes) drawMound(g, h, rnd);
  }

  function softSprite(r, g, b, radius) {
    const c = makeCanvas(radius * 2, radius * 2);
    const x = c.getContext('2d');
    const grad = x.createRadialGradient(radius, radius, 0, radius, radius, radius);
    grad.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',1)');
    grad.addColorStop(0.45, 'rgba(' + r + ',' + g + ',' + b + ',0.6)');
    grad.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
    x.fillStyle = grad;
    x.fillRect(0, 0, radius * 2, radius * 2);
    return c;
  }

  function starPath(points, inner) {
    const p = new Path2D();
    for (let i = 0; i < points * 2; i++) {
      const a = (i * Math.PI) / points - Math.PI / 2;
      const r = i % 2 ? inner : 1;
      if (i === 0) p.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else p.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    p.closePath();
    return p;
  }

  function buildSprites() {
    G.star = starPath(5, 0.46);
    G.glow = softSprite(255, 230, 90, 64);

    // foot: soft shadow with a faint light ring, so players see the floor sensing them
    const fr = Math.round(36 * U);
    const foot = makeCanvas(fr * 2, fr * 2);
    const fg = foot.getContext('2d');
    const fgrad = fg.createRadialGradient(fr, fr, 0, fr, fr, fr);
    fgrad.addColorStop(0, 'rgba(0, 0, 0, 0.5)');
    fgrad.addColorStop(0.6, 'rgba(0, 0, 0, 0.32)');
    fgrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    fg.fillStyle = fgrad;
    fg.fillRect(0, 0, fr * 2, fr * 2);
    fg.beginPath();
    fg.arc(fr, fr, fr * 0.62, 0, TAU);
    fg.lineWidth = 2.5 * U;
    fg.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    fg.stroke();
    G.foot = foot;

    // rotating sunburst behind banners
    const rr = Math.round(260 * U);
    const rays = makeCanvas(rr * 2, rr * 2);
    const rg = rays.getContext('2d');
    const rgrad = rg.createRadialGradient(rr, rr, 0, rr, rr, rr);
    rgrad.addColorStop(0, 'rgba(255, 236, 120, 0.75)');
    rgrad.addColorStop(1, 'rgba(255, 236, 120, 0)');
    rg.fillStyle = rgrad;
    for (let i = 0; i < 14; i++) {
      const a = (i * TAU) / 14;
      rg.beginPath();
      rg.moveTo(rr, rr);
      rg.arc(rr, rr, rr, a, a + TAU / 28);
      rg.closePath();
      rg.fill();
    }
    G.rays = rays;

    // shoe soles for the START pad
    const sole = new Path2D();
    sole.ellipse(0, -0.32, 0.38, 0.58, 0, 0, TAU);
    sole.ellipse(0, 0.66, 0.3, 0.32, 0, 0, TAU);
    G.sole = sole;

    // mole colours (in mole design units, so they follow the mole's transform)
    G.body = ctx.createRadialGradient(-12, -54, 3, 0, -30, 64);
    G.body.addColorStop(0, '#bd8752');
    G.body.addColorStop(0.5, '#8e5a2f');
    G.body.addColorStop(1, '#68401d');
    G.belly = ctx.createLinearGradient(0, -24, 0, 26);
    G.belly.addColorStop(0, '#ecbd85');
    G.belly.addColorStop(1, '#c98f55');
    G.hat = ctx.createLinearGradient(-20, -82, 18, -55);
    G.hat.addColorStop(0, '#fff27d');
    G.hat.addColorStop(0.5, '#ffd000');
    G.hat.addColorStop(1, '#e49e00');

    // big text fills (centred at 0, 0; drawn under translate/scale)
    G.yellow = vGrad(90 * U, '#fff27a', '#ffb300');
    G.green = vGrad(80 * U, '#c8ff7a', '#2fcf3a');
    G.red = vGrad(60 * U, '#ffd36b', '#ff3d1f');
    G.orange = vGrad(40 * U, '#fff27a', '#ff7a00');

    G.labelW = {};
    ctx.font = font(hudLabelPx());
    for (const s of ['SCORE', 'TIME', 'COMBO']) G.labelW[s] = ctx.measureText(s).width;
  }

  function vGrad(half, top, bottom) {
    const g = ctx.createLinearGradient(0, -half, 0, half);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    return g;
  }

  // ------------------------------------------------------------------ title lettering

  // Chunky cartoon letters: drop shadow, thick outline, gradient fill, glossy top.
  function letterSprite(ch, px, top, bottom) {
    ctx.font = font(px);
    const adv = ctx.measureText(ch).width;
    const pad = Math.ceil(px * 0.3);
    const w = Math.ceil(adv) + pad * 2;
    const h = Math.ceil(px * 1.3) + pad * 2;
    const c = makeCanvas(w, h);
    const g = c.getContext('2d');
    const cx = w / 2, cy = h / 2;
    g.font = font(px);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = px * 0.24;
    g.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    g.fillStyle = 'rgba(0, 0, 0, 0.55)';
    g.strokeText(ch, cx + px * 0.03, cy + px * 0.1);
    g.fillText(ch, cx + px * 0.03, cy + px * 0.1);
    g.strokeStyle = INK;
    g.strokeText(ch, cx, cy);
    const grad = g.createLinearGradient(0, cy - px * 0.38, 0, cy + px * 0.38);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    g.fillStyle = grad;
    g.fillText(ch, cx, cy);
    g.save();
    g.beginPath();
    g.rect(0, 0, w, cy - px * 0.1);
    g.clip();
    g.globalAlpha = 0.4;
    g.fillStyle = '#ffffff';
    g.fillText(ch, cx, cy);
    g.restore();
    return { c: c, adv: adv, w: w, h: h };
  }

  function wordSprites(word, px, top, bottom, maxW) {
    ctx.font = font(px);
    const width = ctx.measureText(word).width;
    if (width > maxW) px *= maxW / width;
    const letters = [];
    let x = 0;
    for (const ch of word) {
      if (ch === ' ') {
        ctx.font = font(px);
        x += ctx.measureText(' ').width;
        continue;
      }
      const s = letterSprite(ch, px, top, bottom);
      s.x = x + s.adv / 2;
      x += s.adv;
      letters.push(s);
    }
    return { letters: letters, width: x, px: px };
  }

  function buildTitle() {
    G.title1 = wordSprites('STOMP', 96 * U, '#fff07a', '#ff9d00', W * 0.9);
    G.title2 = wordSprites('THE MOLE', 62 * U, '#ffffff', '#ffd7a0', W * 0.9);
  }

  function drawWord(word, cx, cy, real, phase) {
    const x0 = cx - word.width / 2;
    const t = real / 1000;
    for (let i = 0; i < word.letters.length; i++) {
      const s = word.letters[i];
      const bounce = Math.sin(t * 3.2 - i * 0.55 + phase);
      const y = cy + bounce * 4 * U;
      const a = Math.sin(t * 2.3 - i * 0.7 + phase) * 0.05;
      const sc = 1 + Math.max(0, bounce) * 0.04;
      ctx.save();
      ctx.translate(x0 + s.x, y);
      ctx.rotate(a);
      ctx.scale(sc, sc);
      ctx.drawImage(s.c, -s.w / 2, -s.h / 2);
      ctx.restore();
    }
  }

  // ------------------------------------------------------------------ moles

  const molePool = [];
  const moles = new Map();     // mole id -> record
  let holeMole = [];           // hole index -> record (one mole per hole)
  const V = { h: 0, sx: 1, sy: 1, face: FACE_UP, flash: 0, stars: false, paws: 0, lx: 0, ly: 0, blink: false,
              hatLift: 0, hatRot: 0 };

  function newMole() {
    return { id: 0, hole: 0, state: '', t0: 0, t1: 0, rise: 160, up: UP_GUESS_MS,
             sinkT0: NaN, hitT0: NaN, hitH: 1, seed: 0, seen: false };
  }

  function resetMoles() {
    for (const r of moles.values()) molePool.push(r);
    moles.clear();
    holeMole = [];
  }

  function moleRecord(id, hole) {
    let r = moles.get(id);
    if (!r) {
      r = molePool.pop() || newMole();
      r.id = id;
      r.hole = hole;
      r.state = '';
      r.sinkT0 = NaN;
      r.hitT0 = NaN;
      r.hitH = 1;
      r.up = UP_GUESS_MS;
      r.seed = ((id * 0.6180339887) % 1) * 100;
      moles.set(id, r);
    }
    return r;
  }

  // Height (0 = hidden, 1 = fully up) of a mole at server time `now`, ignoring bob.
  function heightAt(r, now) {
    moleVisual(r, now, 0);
    return V.h;
  }

  function setMoleState(r, state, t0, t1) {
    if (r.state !== state) {
      if (state === 'sinking') r.sinkT0 = t0;
      if (state === 'hit') {
        r.hitH = Math.max(0.6, r.state ? heightAt(r, t0) : 1);   // a caught mole always shows its face
        r.hitT0 = t0;
      }
      if (state === 'escaped' && isNaN(r.sinkT0)) r.sinkT0 = t0 - T.sink;
    }
    r.state = state;
    r.t0 = t0;
    r.t1 = t1;
  }

  function rebuildHoleMoles() {
    holeMole.length = 0;
    for (const r of moles.values()) {
      const cur = holeMole[r.hole];
      if (!cur || cur.t0 < r.t0) holeMole[r.hole] = r;
    }
  }

  function syncMoles(list) {
    for (const r of moles.values()) r.seen = false;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const r = moleRecord(m.id, m.hole);
      r.hole = m.hole;
      r.rise = num(m.rise_ms, T.rise);
      r.up = num(m.up_ms, r.up);
      setMoleState(r, m.state, m.t0, m.t1);
      r.seen = true;
    }
    for (const [id, r] of moles) {
      if (!r.seen) {
        moles.delete(id);
        molePool.push(r);
      }
    }
    rebuildHoleMoles();
  }

  // Fills V with how a mole looks at server time `now`. Predicts the next state when a
  // state message is late, so the animation stays smooth between 30 Hz updates.
  function moleVisual(r, now, tSec) {
    let st = r.state, t0 = r.t0, t1 = r.t1, sink0 = r.sinkT0;
    if (st === 'rising' && now >= t1) { st = 'up'; t0 = t1; t1 = t0 + r.up; }
    if (st === 'up' && now >= t1) { st = 'sinking'; sink0 = t1; }
    V.sx = 1; V.sy = 1; V.flash = 0; V.stars = false; V.paws = 0; V.blink = false;
    V.hatLift = 0; V.hatRot = 0;
    V.lx = Math.sin(tSec * 1.7 + r.seed) * 2.5;
    V.ly = 0;
    if (st === 'rising') {
      const p = clamp01((now - t0) / Math.max(1, r.rise));
      V.h = easeOutBack(p);
      V.sy = 1 + 0.16 * (1 - p);
      V.sx = 1 - 0.08 * (1 - p);
      V.face = FACE_RISE;
      V.ly = -2;
    } else if (st === 'up') {
      const e = now - t0;
      const land = Math.max(0, 1 - e / 160);
      V.h = 1 + Math.sin(tSec * 8 + r.seed) * 0.02;
      V.sy = 1 - 0.09 * land * Math.cos(e / 25) + 0.02 * Math.sin(tSec * 6 + r.seed);
      V.sx = 1 + 0.06 * land * Math.cos(e / 25) - 0.01 * Math.sin(tSec * 6 + r.seed);
      V.face = FACE_UP;
      V.paws = clamp01(e / 90);
      V.blink = (tSec * 1000 + r.seed * 37) % 2700 < 130;
    } else if (st === 'sinking' || st === 'escaped') {
      const p = isNaN(sink0) ? 1 : clamp01((now - sink0) / Math.max(1, T.sink));
      V.h = 1 - easeInQuad(p);
      V.sy = 1 + 0.08 * p;
      V.sx = 1 - 0.04 * p;
      V.face = FACE_TAUNT;
    } else if (st === 'hit') {
      const e = clamp01((now - r.hitT0) / Math.max(1, T.hit));
      let q;
      if (e < 0.12) {
        q = easeOutCubic(e / 0.12);
      } else if (e < 0.6) {
        const w = (e - 0.12) / 0.48;
        q = 0.78 + 0.22 * Math.cos(w * Math.PI * 3) * (1 - w);
      } else {
        q = 0.78;
      }
      V.sx = 1 + 0.42 * q;
      V.sy = 1 - 0.36 * q;
      V.h = e < 0.55 ? r.hitH : r.hitH * (1 - easeInQuad((e - 0.55) / 0.45));
      V.flash = e < 0.15 ? 1 - e / 0.15 : 0;
      V.stars = e < 0.95;
      V.face = FACE_HIT;
      // the hard hat gets knocked up off the head and drops back on
      const hop = Math.sin(Math.PI * clamp01(e / 0.5));
      V.hatLift = (24 * hop) / V.sy;
      V.hatRot = (r.seed % 2 < 1 ? -0.45 : 0.45) * hop;
    } else {
      V.h = 0;
      V.face = FACE_UP;
    }
  }

  function moleBaseY(hole, h) {
    return hole.y + hole.ory * 0.6 + (1 - h) * (hole.ory * 0.4 + 84 * hole.k);
  }
  // a squashed mole sits a little higher, so its X eyes stay above the rim
  function moleBase(hole) {
    return moleBaseY(hole, V.h) - (1 - V.sy) * 30 * hole.k;
  }

  // The mole in design units (a draw radius of 48), origin at the bottom centre of the body.
  function drawMoleFigure(face, lx, ly, blink, hatLift, hatRot) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // body
    ctx.beginPath();
    ctx.moveTo(-30, 18);
    ctx.lineTo(-30, -36);
    ctx.arc(0, -36, 30, Math.PI, 0, false);
    ctx.lineTo(30, 18);
    ctx.closePath();
    ctx.fillStyle = G.body;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK;
    ctx.stroke();
    // belly and muzzle
    ctx.beginPath();
    ctx.ellipse(0, 2, 20, 24, 0, 0, TAU);
    ctx.fillStyle = G.belly;
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, -31, 16.5, 11.5, 0, 0, TAU);
    ctx.fillStyle = '#efc797';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(42, 20, 7, 0.5)';
    ctx.stroke();
    // cheeks
    ctx.fillStyle = 'rgba(255, 120, 150, 0.55)';
    ctx.beginPath();
    ctx.ellipse(-20, -36, 5, 3.2, 0, 0, TAU);
    ctx.ellipse(20, -36, 5, 3.2, 0, 0, TAU);
    ctx.fill();

    // eyes
    if (face === FACE_HIT) {
      ctx.lineWidth = 3.4;
      ctx.strokeStyle = INK;
      ctx.beginPath();
      for (let s = -1; s <= 1; s += 2) {
        const x = s * 11;
        ctx.moveTo(x - 5.5, -53.5);
        ctx.lineTo(x + 5.5, -42.5);
        ctx.moveTo(x + 5.5, -53.5);
        ctx.lineTo(x - 5.5, -42.5);
      }
      ctx.stroke();
    } else if (face === FACE_TAUNT) {
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = INK;
      ctx.beginPath();
      for (let s = -1; s <= 1; s += 2) {
        const x = s * 11;
        ctx.moveTo(x + s * 6, -53);
        ctx.lineTo(x - s * 5, -48);
        ctx.lineTo(x + s * 6, -43);
      }
      ctx.stroke();
    } else if (blink) {
      ctx.lineWidth = 2.8;
      ctx.strokeStyle = INK;
      ctx.beginPath();
      for (let s = -1; s <= 1; s += 2) {
        const x = s * 11;
        ctx.moveTo(x - 7, -48);
        ctx.quadraticCurveTo(x, -43.5, x + 7, -48);
      }
      ctx.stroke();
    } else {
      for (let s = -1; s <= 1; s += 2) {
        const x = s * 11;
        ctx.beginPath();
        ctx.ellipse(x, -48, 8.5, 10, 0, 0, TAU);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = INK;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x + lx, -47 + ly, 4.9, 0, TAU);
        ctx.fillStyle = '#1a0d05';
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x + lx + 1.8, -49.2 + ly, 1.9, 0, TAU);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x + lx - 1.5, -44.8 + ly, 0.9, 0, TAU);
        ctx.fill();
      }
    }

    // mouth, tongue and teeth
    if (face === FACE_HIT) {
      ctx.beginPath();
      ctx.ellipse(0, -23.5, 6, 6.5, 0, 0, TAU);
      ctx.fillStyle = '#4a0f12';
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = INK;
      ctx.stroke();
    } else {
      if (face === FACE_TAUNT) {
        ctx.beginPath();
        ctx.moveTo(-4.5, -27);
        ctx.quadraticCurveTo(-7, -12, 1.5, -12.5);
        ctx.quadraticCurveTo(9, -13, 5, -27);
        ctx.closePath();
        ctx.fillStyle = '#ff4f73';
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = '#6e1428';
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0.6, -24);
        ctx.lineTo(1.2, -16);
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(-7.5, -30.5);
      ctx.quadraticCurveTo(-3.8, -26.5, 0, -30.5);
      ctx.quadraticCurveTo(3.8, -26.5, 7.5, -30.5);
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = INK;
      ctx.stroke();
    }
    ctx.fillStyle = '#fffdf3';
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = INK;
    rrect(ctx, -4.8, -30, 4.4, 7.5, 1.2);
    ctx.fill();
    ctx.stroke();
    rrect(ctx, 0.4, -30, 4.4, 7.5, 1.2);
    ctx.fill();
    ctx.stroke();

    // nose
    ctx.beginPath();
    ctx.ellipse(0, -38, 7.5, 5.6, 0, 0, TAU);
    ctx.fillStyle = '#ff6f9c';
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#7a2340';
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(-2.4, -40, 2.6, 1.5, -0.3, 0, TAU);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fill();

    // whiskers
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(42, 20, 7, 0.8)';
    ctx.beginPath();
    for (let s = -1; s <= 1; s += 2) {
      ctx.moveTo(s * 14, -34);
      ctx.lineTo(s * 33, -39);
      ctx.moveTo(s * 15, -31);
      ctx.lineTo(s * 34, -31);
      ctx.moveTo(s * 14, -28);
      ctx.lineTo(s * 32, -23);
    }
    ctx.stroke();

    // yellow hard hat
    const hatMoved = hatLift !== 0 || hatRot !== 0;
    if (hatMoved) {
      ctx.save();
      ctx.translate(0, -66 - hatLift);
      ctx.rotate(hatRot);
      ctx.translate(0, 66);
    }
    ctx.beginPath();
    ctx.moveTo(-23, -57);
    ctx.bezierCurveTo(-24, -85, 24, -85, 23, -57);
    ctx.closePath();
    ctx.fillStyle = G.hat;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-4.5, -58);
    ctx.lineTo(-4.5, -76);
    ctx.quadraticCurveTo(0, -78.5, 4.5, -76);
    ctx.lineTo(4.5, -58);
    ctx.closePath();
    ctx.fillStyle = '#ffe866';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(42, 20, 7, 0.7)';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-23, -57);
    ctx.bezierCurveTo(-24, -85, 24, -85, 23, -57);
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = INK;
    ctx.stroke();
    rrect(ctx, -32, -61, 64, 7.5, 3.7);
    ctx.fillStyle = '#f2b400';
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(-12, -72, 5.5, 3, -0.6, 0, TAU);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.fill();
    if (hatMoved) ctx.restore();
  }

  function drawStar(x, y, s, rot, fill) {
    const c = Math.cos(rot) * s, si = Math.sin(rot) * s;
    ctx.setTransform(c, si, -si, c, x + shakeX, y + shakeY);
    ctx.fillStyle = fill;
    ctx.fill(G.star);
    ctx.lineWidth = 1.6 / s;
    ctx.strokeStyle = INK;
    ctx.stroke(G.star);
    ctx.setTransform(1, 0, 0, 1, shakeX, shakeY);
  }

  function drawPaws(hole, alpha) {
    const k = hole.k;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2 * k;
    ctx.strokeStyle = INK;
    for (let s = -1; s <= 1; s += 2) {
      const x = hole.x + s * 18 * k;
      const y = hole.y + hole.ory * 0.86;
      ctx.beginPath();
      ctx.ellipse(x, y, 8.5 * k, 6 * k, 0, 0, TAU);
      ctx.fillStyle = '#d9a370';
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 3.5 * k, y + 2 * k);
      ctx.lineTo(x - 3.5 * k, y + 5 * k);
      ctx.moveTo(x, y + 2.5 * k);
      ctx.lineTo(x, y + 5.5 * k);
      ctx.moveTo(x + 3.5 * k, y + 2 * k);
      ctx.lineTo(x + 3.5 * k, y + 5 * k);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawMole(hole, tSec) {
    const k = hole.k;
    const base = V.sy < 1 && V.face === FACE_HIT ? moleBase(hole) : moleBaseY(hole, V.h);
    ctx.save();
    ctx.clip(hole.clip);
    ctx.translate(hole.x, base);
    ctx.scale(k * V.sx, k * V.sy);
    drawMoleFigure(V.face, V.lx, V.ly, V.blink, V.hatLift, V.hatRot);
    if (V.flash > 0) {   // impact frame: the mole's silhouette flashes white
      ctx.globalAlpha = 0.85 * V.flash;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(-30, 18);
      ctx.lineTo(-30, -36);
      ctx.arc(0, -36, 30, Math.PI, 0, false);
      ctx.lineTo(30, 18);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.setTransform(1, 0, 0, 1, shakeX, shakeY);
    ctx.fillStyle = hole.occ;
    ctx.fillRect(hole.x - hole.orx, hole.y - hole.ory * 0.35, hole.orx * 2, hole.ory * 1.35 + 2);
    ctx.restore();
    ctx.drawImage(hole.lip, hole.lipX, hole.lipY);
    if (V.paws > 0 && V.h > 0.9) drawPaws(hole, V.paws);
    if (V.stars) {
      const cy = base - (82 * V.sy + 9) * k;
      for (let i = 0; i < 3; i++) {
        const a = tSec * 7 + (i * TAU) / 3;
        drawStar(hole.x + Math.cos(a) * 27 * k, cy + Math.sin(a) * 7 * k, (5.5 + Math.sin(a) * 1.3) * k, a * 0.6, '#ffe14a');
      }
    }
  }

  // ------------------------------------------------------------------ attract-mode peeking moles (cosmetic)

  const peeks = [];
  for (let i = 0; i < MAX_PEEKS; i++) peeks.push({ on: false, hole: null, t0: 0, dur: 0, seed: 0 });
  let nextPeekAt = 0;

  function resetPeeks() {
    for (const p of peeks) p.on = false;
    nextPeekAt = performance.now() + 600;
  }

  function peekBusy(hole) {
    for (const p of peeks) if (p.on && p.hole === hole) return true;
    return false;
  }

  function updatePeeks(real) {
    for (const p of peeks) if (p.on && real - p.t0 > p.dur) p.on = false;
    if (real < nextPeekAt || !holes.length) return;
    nextPeekAt = real + 700 + Math.random() * 1100;
    let slot = null;
    for (const p of peeks) if (!p.on) { slot = p; break; }
    if (!slot) return;
    for (let tries = 0; tries < 8; tries++) {
      const h = holes[Math.floor(Math.random() * holes.length)];
      const dx = h.x - pad.x, dy = h.y - pad.y;
      if (Math.hypot(dx, dy) < pad.r + h.mrx || peekBusy(h)) continue;
      slot.on = true;
      slot.hole = h;
      slot.t0 = real;
      slot.dur = 1500 + Math.random() * 1200;
      slot.seed = Math.random() * 100;
      return;
    }
  }

  function peekVisual(p, real) {
    const e = real - p.t0;
    const top = 0.7;
    V.sx = 1; V.sy = 1; V.flash = 0; V.stars = false; V.paws = 0; V.face = FACE_UP;
    V.hatLift = 0; V.hatRot = 0;
    if (e < 260) {
      V.h = top * easeOutBack(e / 260);
    } else if (e > p.dur - 240) {
      V.h = top * (1 - easeInQuad(clamp01((e - (p.dur - 240)) / 240)));
    } else {
      V.h = top;
    }
    const look = Math.sin(e / 330 + p.seed);
    V.lx = look > 0.3 ? 3 : look < -0.3 ? -3 : 0;
    V.ly = 0;
    V.blink = (e + p.seed * 13) % 1900 < 120;
  }

  // ------------------------------------------------------------------ effects (pooled, no per-frame allocation)

  const parts = [];
  for (let i = 0; i < MAX_PARTICLES; i++) {
    parts.push({ on: false, kind: 0, x: 0, y: 0, vx: 0, vy: 0, g: 0, age: 0, life: 1, size: 1, grow: 0, rot: 0, vr: 0, c: 0 });
  }
  let partCursor = 0;

  function spawn(kind, x, y, vx, vy, life, size) {
    let p = null;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const q = parts[(partCursor + i) % MAX_PARTICLES];
      if (!q.on) { p = q; partCursor = (partCursor + i + 1) % MAX_PARTICLES; break; }
    }
    if (!p) {   // pool full: recycle the next one
      p = parts[partCursor];
      partCursor = (partCursor + 1) % MAX_PARTICLES;
    }
    p.on = true; p.kind = kind; p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.age = 0; p.life = life; p.size = size; p.grow = 0; p.g = 0;
    p.rot = Math.random() * TAU; p.vr = (Math.random() - 0.5) * 10; p.c = 0;
    return p;
  }

  const rings = [];
  for (let i = 0; i < MAX_RINGS; i++) rings.push({ on: false, x: 0, y: 0, t0: 0, dur: 1, r0: 0, r1: 1, w: 1, color: '#fff', flat: 1 });
  function ring(x, y, r0, r1, dur, w, color, flat, real) {
    let s = rings[0];
    for (const r of rings) {
      if (!r.on) { s = r; break; }
      if (r.t0 < s.t0) s = r;
    }
    s.on = true; s.x = x; s.y = y; s.r0 = r0; s.r1 = r1; s.dur = dur; s.w = w; s.color = color;
    s.flat = flat; s.t0 = real;
  }

  const floaters = [];
  for (let i = 0; i < MAX_FLOATERS; i++) floaters.push({ on: false, text: '', x: 0, y: 0, t0: 0, dur: 1, px: 30, fill: '#fff' });
  function floater(text, x, y, px, fill, dur, real) {
    let s = floaters[0];
    for (const f of floaters) {
      if (!f.on) { s = f; break; }
      if (f.t0 < s.t0) s = f;
    }
    s.on = true; s.text = text; s.x = x; s.y = y; s.px = px; s.fill = fill; s.dur = dur; s.t0 = real;
  }

  const banner = { on: false, text: '', t0: 0, dur: COMBO_BANNER_MS };
  const shake = { t0: -1e9, dur: 120, amp: 0 };
  let shakeX = 0, shakeY = 0;

  function burstStars(x, y, n, speed, life, size) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + Math.random() * 0.4;
      const v = speed * (0.6 + Math.random() * 0.6);
      const p = spawn(P_STAR, x, y, Math.cos(a) * v, Math.sin(a) * v - 80 * U, life * (0.7 + Math.random() * 0.5), size * (0.7 + Math.random() * 0.6));
      p.g = 380 * U;
    }
  }

  function fxHit(hole, sx, sy, real) {
    const k = hole.k;
    const headY = hole.y - 44 * k;
    burstStars(hole.x, headY, 9, 300 * U, 0.55, 8 * k);
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * TAU, v = (250 + Math.random() * 250) * U;
      const p = spawn(P_SPARK, hole.x, headY, Math.cos(a) * v, Math.sin(a) * v, 0.25 + Math.random() * 0.15, (2 + Math.random() * 2) * U);
      p.g = 0;
    }
    for (let i = 0; i < 16; i++) {   // dirt flies off the rim, clear of the mole's face
      const side = Math.random() < 0.5 ? -1 : 1;
      const p = spawn(P_DIRT, hole.x + side * hole.orx * (0.6 + Math.random() * 0.5), hole.y + Math.random() * hole.ory * 0.5,
        side * (80 + Math.random() * 200) * U, -(150 + Math.random() * 280) * U, 0.6 + Math.random() * 0.3, (2.2 + Math.random() * 3) * k);
      p.g = 1100 * U;
      p.c = Math.floor(Math.random() * DIRT_COLOURS.length);
    }
    ring(sx, sy, 16 * U, 92 * U, 380, 7 * U, '#ffffff', 0.62, real);
    ring(hole.x, hole.y, 30 * k, 78 * k, 300, 5 * U, '#ffe14a', 0.62, real);
    // "+1" rises above the mole; for the top row that would end under the HUD band, so it pops
    // beside the mole (always to the right, so pops of neighbouring holes never overlap) instead
    let fx = hole.x, fy = hole.y - 92 * k;
    const minY = (hudOn ? hudH : 0) + 64 * U;
    if (fy < minY) {
      fy = minY;
      fx = Math.min(hole.x + hole.orx + 36 * U, W - 30 * U);
    }
    floater('+1', fx, fy, 40 * U, '#ffe14a', 750, real);
    shake.t0 = real;
    shake.dur = 120;
    shake.amp = 4.5 * U;
  }

  function fxEscaped(hole, real) {
    const k = hole.k;
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
      const v = (60 + Math.random() * 90) * U;
      const p = spawn(P_PUFF, hole.x + (Math.random() - 0.5) * hole.orx * 1.1, hole.y - 4 * k,
        Math.cos(a) * v, Math.sin(a) * v, 0.36 + Math.random() * 0.16, (4 + Math.random() * 3) * k);
      p.grow = (7 + Math.random() * 5) * k;
      p.g = -60 * U;
    }
    ring(hole.x, hole.y, 26 * k, 62 * k, 320, 4 * U, '#ff4a3d', 0.62, real);
  }

  function fxEmpty(x, y, real) {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU + Math.random() * 0.4;
      const v = (110 + Math.random() * 70) * U;
      const p = spawn(P_DUST, x + Math.cos(a) * 8 * U, y + Math.sin(a) * 5 * U, Math.cos(a) * v, Math.sin(a) * v * 0.6 - 20 * U,
        0.38 + Math.random() * 0.18, (4 + Math.random() * 3) * U);
      p.grow = (8 + Math.random() * 5) * U;
      p.g = 0;
    }
    ring(x, y, 18 * U, 70 * U, 340, 5 * U, '#d8d8d8', 0.62, real);
  }

  function updateEffects(dt, real) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = parts[i];
      if (!p.on) continue;
      p.age += dt;
      if (p.age >= p.life) { p.on = false; continue; }
      p.vy += p.g * dt;
      if (p.kind === P_DUST || p.kind === P_PUFF) { p.vx *= 1 - 3 * dt; p.vy *= 1 - 3 * dt; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
    if (real - shake.t0 < shake.dur) {
      const d = 1 - (real - shake.t0) / shake.dur;
      shakeX = (Math.random() * 2 - 1) * shake.amp * d;
      shakeY = (Math.random() * 2 - 1) * shake.amp * d;
    } else {
      shakeX = 0;
      shakeY = 0;
    }
  }

  // puffs swell, then shrink away quickly at the end of their life
  function puffRadius(p, f) {
    const r = p.size + p.grow * easeOutCubic(f);
    return f > 0.6 ? Math.max(0.5, r * (1 - easeInQuad((f - 0.6) / 0.4))) : r;
  }

  function drawPuffs(kind, outline, fill, highlight) {
    for (let pass = 0; pass < 3; pass++) {
      ctx.beginPath();
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const p = parts[i];
        if (!p.on || p.kind !== kind) continue;
        const f = p.age / p.life;
        const r = puffRadius(p, f);
        const rr = pass === 0 ? r + 2.5 * U : pass === 1 ? r : r * 0.45;
        const ox = pass === 2 ? -r * 0.28 : 0, oy = pass === 2 ? -r * 0.3 : 0;
        ctx.moveTo(p.x + ox + rr, p.y + oy);
        ctx.arc(p.x + ox, p.y + oy, rr, 0, TAU);
      }
      ctx.fillStyle = pass === 0 ? outline : pass === 1 ? fill : highlight;
      ctx.fill();
    }
  }

  function drawParticles() {
    drawPuffs(P_DUST, INK, '#e3d8c4', 'rgba(255, 255, 255, 0.55)');
    drawPuffs(P_PUFF, '#5a0d0d', '#ff6a5a', 'rgba(255, 215, 205, 0.65)');
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = parts[i];
      if (!p.on) continue;
      const f = p.age / p.life;
      if (p.kind === P_STAR) {
        drawStar(p.x, p.y, Math.max(0.5, p.size * (1 - f * 0.6)), p.rot, '#ffe14a');
      } else if (p.kind === P_DIRT) {
        ctx.globalAlpha = f > 0.7 ? (1 - f) / 0.3 : 1;
        ctx.fillStyle = DIRT_COLOURS[p.c];
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, TAU);
        ctx.fill();
      } else if (p.kind === P_SPARK) {
        ctx.globalAlpha = 1 - f;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 - f * 0.5), 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawRings(real) {
    for (const r of rings) {
      if (!r.on) continue;
      const f = (real - r.t0) / r.dur;
      if (f >= 1) { r.on = false; continue; }
      const e = easeOutCubic(f);
      const rad = Math.max(0.5, lerp(r.r0, r.r1, e));
      ctx.globalAlpha = 1 - f;
      ctx.lineWidth = Math.max(0.5, r.w * (1 - f * 0.7));
      ctx.strokeStyle = r.color;
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, rad, rad * r.flat, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // World-anchored text ("+1") turns about its own anchor when the HUD is rotated.
  function drawFloaters(real) {
    for (const f of floaters) {
      if (!f.on) continue;
      const e = (real - f.t0) / f.dur;
      if (e >= 1) { f.on = false; continue; }
      const s = e < 0.2 ? lerp(0.4, 1.15, easeOutBack(e / 0.2)) : 1.15 - 0.15 * clamp01((e - 0.2) / 0.2);
      ctx.save();
      ctx.translate(f.x, f.y);
      if (rot180) ctx.rotate(Math.PI);
      ctx.globalAlpha = e > 0.7 ? (1 - e) / 0.3 : 1;
      ctx.translate(0, -36 * U * easeOutCubic(e));
      ctx.scale(s, s);
      outlined(ctx, f.text, 0, 0, f.px, f.fill, 'center');
      ctx.restore();
    }
  }

  // ------------------------------------------------------------------ feet

  const feet = [];
  for (let i = 0; i < MAX_FEET; i++) feet.push({ on: false, id: -1, x: 0, y: 0, tx: 0, ty: 0, a: 0, seen: false });

  function syncFeet(list) {
    for (const f of feet) f.seen = false;
    const fresh = [];
    for (let i = 0; i < list.length; i++) {   // touches that already have a shadow
      const t = list[i];
      let slot = null;
      for (const f of feet) {
        if (f.on && f.id === t.id) { slot = f; break; }
      }
      if (!slot) { fresh.push(t); continue; }
      slot.tx = t.x;
      slot.ty = t.y;
      slot.seen = true;
    }
    for (const t of fresh) {   // new touches: a free slot, else the most faded shadow of a lifted foot
      let slot = null;
      for (const f of feet) {
        if (!f.on) { slot = f; break; }
        if (!f.seen && (!slot || f.a < slot.a)) slot = f;
      }
      if (!slot) continue;
      slot.on = true;
      slot.id = t.id;
      slot.x = slot.tx = t.x;
      slot.y = slot.ty = t.y;
      slot.a = 0;
      slot.seen = true;
    }
  }

  function drawFeet(dt) {
    const follow = Math.min(1, dt * 25);
    for (const f of feet) {
      if (!f.on) continue;
      f.x += (f.tx - f.x) * follow;
      f.y += (f.ty - f.y) * follow;
      f.a += ((f.seen ? 1 : 0) - f.a) * Math.min(1, dt * (f.seen ? 18 : 9));
      if (!f.seen && f.a < 0.02) { f.on = false; continue; }
      const w = G.foot.width;
      ctx.globalAlpha = f.a;
      ctx.drawImage(G.foot, f.x - w / 2, f.y - w * 0.42, w, w * 0.84);
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ feed handling

  let latest = null;               // last state message
  let phase = '';
  let attractT0 = 0;
  const cd = { value: null, t0: 0 };
  let lastScore = 0, scorePulseT = -1e9;
  let lastCombo = 0, comboPulseT = -1e9;
  let warnOn = false, warnPulseT = -1e9;
  let celebrated = NaN;            // phase_start of the results already celebrated

  function enterPhase(p, real) {
    phase = p;
    if (p === 'attract') {
      attractT0 = real;
      resetPeeks();
    } else {
      for (const pk of peeks) pk.on = false;
    }
    if (p === 'countdown' || p === 'play') banner.on = false;
    if (p === 'play') warnOn = false;
    if (p !== 'attract' && audio) audio.chargeStop();
  }

  function onHello(msg) {
    if (msg.config) applyConfig(msg.config);
    resetMoles();   // a restarted server numbers its moles from scratch
  }

  // Walls present = at least one "room" page in the server's screens count. A server without
  // screens (older) counts as no walls, so the game stays complete on the floor alone.
  function updateHudTarget(msg) {
    const screens = msg && msg.screens;
    const walls = !!screens && typeof screens === 'object' && num(screens.room, 0) >= 1;
    hudOn = hudMode === 'auto' ? !walls : hudMode;
    if (!hudKnown) {
      hudKnown = true;
      hudFade = hudOn ? 1 : 0;
    }
  }

  // 0..1 with eased ends: how much of the floor HUD (band, attract top N, results table) shows
  function hudShown() {
    return hudFade * hudFade * (3 - 2 * hudFade);
  }

  function stepHudFade(dt) {
    const step = (dt * 1000) / HUD_FADE_MS;
    hudFade = hudOn ? Math.min(1, hudFade + step) : Math.max(0, hudFade - step);
  }

  function onState(msg) {
    if (!cfg) return;
    const real = performance.now();
    latest = msg;
    updateHudTarget(msg);
    if (msg.phase !== phase) enterPhase(msg.phase, real);
    syncMoles(Array.isArray(msg.moles) ? msg.moles : EMPTY);
    syncFeet(Array.isArray(msg.touches) ? msg.touches : EMPTY);
    const cdv = msg.countdown === undefined ? null : msg.countdown;
    if (cdv !== cd.value) {
      cd.value = cdv;
      cd.t0 = real;
    }
    if (msg.score !== lastScore) {
      if (msg.score > lastScore) scorePulseT = real;
      lastScore = msg.score;
    }
    if (msg.combo !== lastCombo) {
      if (msg.combo > lastCombo) comboPulseT = real;
      lastCombo = msg.combo;
    }
    if (audio) {
      if (msg.phase === 'attract' && msg.start_progress > 0) audio.charge(msg.start_progress);
      else audio.chargeStop();
    }
  }

  function onEvent(msg) {
    if (!cfg) return;
    const real = performance.now();
    const play = audio ? audio.play : function () {};
    switch (msg.name) {
      case 'mole_up': {
        if (!holesByIndex[msg.hole]) break;
        const r = moleRecord(msg.mole_id, msg.hole);
        if (!r.state) {
          r.rise = T.rise;
          setMoleState(r, 'rising', msg.now, msg.now + T.rise);
          rebuildHoleMoles();
        }
        play('pop');
        break;
      }
      case 'hit': {
        const hole = holesByIndex[msg.hole];
        const r = moles.get(msg.mole_id);
        if (r && r.state !== 'hit') setMoleState(r, 'hit', msg.now, msg.now + T.hit);
        if (hole) fxHit(hole, num(msg.x, hole.x), num(msg.y, hole.y), real);
        play('bonk');
        play('splat');
        break;
      }
      case 'escaped': {
        const hole = holesByIndex[msg.hole];
        const r = moles.get(msg.mole_id);
        if (r && r.state !== 'escaped') setMoleState(r, 'escaped', msg.now, msg.now + T.escape);
        if (hole) fxEscaped(hole, real);
        play('boing');
        break;
      }
      case 'empty_stomp': {
        const hole = holesByIndex[msg.hole];
        fxEmpty(num(msg.x, hole ? hole.x : W / 2), num(msg.y, hole ? hole.y : H / 2), real);
        play('thud');
        break;
      }
      case 'combo':
        banner.on = true;
        banner.text = 'COMBO x' + msg.combo + '!';
        banner.t0 = real;
        burstStars(W / 2, H / 2, 14, 420 * U, 0.8, 9 * U);
        play('fanfare');
        break;
      case 'countdown':
        if (msg.value !== cd.value) {
          cd.value = msg.value;
          cd.t0 = real;
        }
        if (msg.value === 'GO') {
          ring(W / 2, H / 2, 60 * U, 300 * U, 500, 10 * U, '#7dff5a', 1, real);
          burstStars(W / 2, H / 2, 16, 460 * U, 0.8, 10 * U);
          play('go');
        } else {
          ring(W / 2, H / 2, 60 * U, 240 * U, 450, 8 * U, '#ffffff', 1, real);
          play('tick', msg.value);
        }
        break;
      case 'time_warning':
        warnOn = true;
        warnPulseT = real;
        play('tick', msg.seconds_left);
        break;
      case 'round_end':
        if (audio) audio.chargeStop();
        play('buzzer');
        break;
      case 'start_pad':
        if (audio) audio.charge(num(msg.progress, 0));
        break;
      case 'attract':
        if (audio) audio.chargeStop();
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ overlays: HUD, countdown, banners

  function hudLabelPx() { return Math.round(Math.max(28 * U, hudH) * 0.38); }

  function rotateAbout(cx, cy) {
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI);
    ctx.translate(-cx, -cy);
  }

  function beginText(cx, cy) {
    ctx.save();
    if (rot180) rotateAbout(cx, cy);
  }

  function pulseScale(real, t0, amount) {
    const e = (real - t0) / 220;
    return e >= 1 || e < 0 ? 1 : 1 + amount * Math.sin(e * Math.PI);
  }

  let timeStr = '', timeSecs = -1;
  function drawHud(now, real, st) {
    const shown = hudShown();
    if (shown <= 0) return;
    const bh = hudH;
    const cy = bh * 0.52;
    const lab = hudLabelPx();
    const val = Math.round(bh * 0.74);
    const m = 10 * U;
    let secs;
    if (phase === 'play') {
      const left = typeof st.phase_end === 'number' ? st.phase_end - now : num(st.time_left_ms, 0);
      secs = Math.max(0, Math.ceil(Math.min(left, T.play) / 1000));
    } else {
      secs = Math.ceil(T.play / 1000);
    }
    // the warning period, also right after a reconnect (before the next time_warning event)
    const urgent = phase === 'play' && (warnOn || secs <= T.warn);

    beginText(W / 2, bh / 2);
    ctx.globalAlpha = 0.62 * shown;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, bh);
    ctx.globalAlpha = shown;
    ctx.fillStyle = urgent && real % 500 < 250 ? '#ff3b30' : '#ffd21a';
    ctx.fillRect(0, bh - 3 * U, W, 3 * U);

    // SCORE (left)
    outlined(ctx, 'SCORE', m, cy, lab, '#ffffff', 'left');
    outlinedScaled(String(st.score | 0), m + G.labelW.SCORE + 8 * U, cy, val, '#ffe14a', 'left', pulseScale(real, scorePulseT, 0.3));

    // TIME (centre, biggest)
    if (secs !== timeSecs) {
      timeSecs = secs;
      timeStr = String(secs);
    }
    const tpx = Math.round(bh * 0.92);
    ctx.font = font(tpx);
    const tw = ctx.measureText(timeStr).width;
    const total = G.labelW.TIME + 8 * U + tw;
    const tx = W / 2 - total / 2;
    outlined(ctx, 'TIME', tx, cy, lab, '#ffffff', 'left');
    const tScale = urgent ? pulseScale(real, warnPulseT, 0.35) : 1;
    const tfill = urgent ? '#ff4b3a' : '#ffffff';
    outlinedScaled(timeStr, tx + G.labelW.TIME + 8 * U + tw / 2, cy, tpx, tfill, 'center', tScale);

    // COMBO (right)
    const combo = st.combo | 0;
    const cstr = 'x' + combo;
    ctx.font = font(val);
    const cw = ctx.measureText(cstr).width;
    outlined(ctx, 'COMBO', W - m - cw - 8 * U, cy, lab, '#ffffff', 'right');
    const cfill = combo >= 5 ? '#ff9a1f' : combo > 0 ? '#ffe14a' : '#bdbdbd';
    outlinedScaled(cstr, W - m - cw / 2, cy, val, cfill, 'center', pulseScale(real, comboPulseT, 0.4));
    ctx.restore();
  }

  function bigText(str, px, fill, outlineScale) {
    ctx.font = font(px);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = px * 0.16 * (outlineScale || 1) + 4 * U;
    ctx.strokeStyle = SHADOW;
    ctx.strokeText(str, px * 0.02, px * 0.08);
    ctx.strokeStyle = INK;
    ctx.strokeText(str, 0, 0);
    ctx.fillStyle = fill;
    ctx.fillText(str, 0, 0);
  }

  function drawRays(cx, cy, scale, real, alpha) {
    const s = G.rays.width * scale;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.rotate(real / 2400);
    ctx.drawImage(G.rays, -s / 2, -s / 2, s, s);
    ctx.restore();
  }

  function drawCountdown(real) {
    const v = cd.value;
    if (v === null || v === undefined) return;
    const go = v === 'GO';
    const dur = go ? T.go : T.step;
    const e = real - cd.t0;
    if (e > dur + 150) return;
    let s = lerp(2.4, 1, easeOutBack(clamp01(e / 300)));
    let a = 1;
    const tail = e - dur * 0.7;
    if (tail > 0) {
      const q = clamp01(tail / (dur * 0.3));
      s *= 1 + 0.4 * q;
      a = 1 - q;
    }
    beginText(W / 2, H / 2);
    if (go) drawRays(W / 2, H / 2, 1.1 * s, real, 0.5 * a);
    ctx.globalAlpha = a;
    ctx.translate(W / 2, H / 2 + 6 * U);
    ctx.scale(s, s);
    if (go) bigText('GO!', 150 * U, G.green, 1);
    else bigText(String(v), 230 * U, G.yellow, 0.8);
    ctx.restore();
  }

  // Pops up in the middle, holds briefly, then flies into the HUD's combo counter. It is
  // drawn under the moles (see drawFrame): it sits right on the middle row, and a mole
  // rising there must never be hidden by it.
  function drawBanner(real) {
    if (!banner.on) return;
    const e = real - banner.t0;
    if (e > banner.dur) { banner.on = false; return; }
    const flyAt = banner.dur * 0.6;
    let s = e < 240 ? lerp(0.3, 1, easeOutBack(e / 240)) : 1 + 0.03 * Math.sin(e / 60);
    let x = W / 2, y = H / 2, a = 1;
    if (e > flyAt) {
      const f = easeInQuad(clamp01((e - flyAt) / (banner.dur - flyAt)));
      // the HUD turns about its own band, the banner about the floor centre
      // (with the walls showing the combo, it just shrinks away in the middle)
      const shown = hudShown();
      const hx = lerp(W / 2, W - 60 * U, shown), hy = lerp(H / 2, rot180 ? H - hudH / 2 : hudH / 2, shown);
      x = lerp(W / 2, hx, f);
      y = lerp(H / 2, hy, f);
      s *= lerp(1, 0.25, f);
      a = 1 - f * 0.6;
    }
    beginText(W / 2, H / 2);
    if (e < flyAt) drawRays(W / 2, H / 2, 0.8 * s, real, 0.45 * clamp01((flyAt - e) / 150));
    ctx.globalAlpha = a * 0.95;
    ctx.translate(x, y);
    ctx.rotate(-0.06);
    ctx.scale(s, s);
    ctx.font = font(64 * U);
    const w = ctx.measureText(banner.text).width;
    const fit = Math.min(1, (W * 0.92) / w);
    ctx.scale(fit, fit);
    bigText(banner.text, 64 * U, G.orange, 1);
    ctx.restore();
  }

  // ------------------------------------------------------------------ attract screen

  function drawPad(real, progress) {
    const x = pad.x, y = pad.y, r = pad.r;
    const t = real / 1000;
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    const glow = r * (2.3 + 0.25 * pulse + progress * 0.6);
    ctx.globalAlpha = 0.35 + 0.25 * pulse + progress * 0.3;
    ctx.drawImage(G.glow, x - glow / 2, y - glow / 2, glow, glow);
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = progress > 0 ? 'rgba(20, 70, 10, 0.72)' : 'rgba(0, 0, 0, 0.55)';
    ctx.fill();
    ctx.lineWidth = 6 * U;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.setLineDash(PAD_DASH);
    ctx.lineDashOffset = -t * 30 * U;
    ctx.lineWidth = 4 * U;
    ctx.strokeStyle = '#ffe14a';
    ctx.beginPath();
    ctx.arc(x, y, r - 7 * U, 0, TAU);
    ctx.stroke();
    ctx.setLineDash(EMPTY);

    if (progress > 0) {
      ctx.lineCap = 'round';
      ctx.lineWidth = 12 * U;
      ctx.strokeStyle = INK;
      ctx.beginPath();
      ctx.arc(x, y, r + 2 * U, -Math.PI / 2, -Math.PI / 2 + TAU * clamp01(progress));
      ctx.stroke();
      ctx.lineWidth = 8 * U;
      ctx.strokeStyle = '#6dff4a';
      ctx.stroke();
    }

    // two footprints, facing the reader
    beginText(x, y);
    const fs = r * 0.36 * (1 + progress * 0.15 + 0.04 * pulse);
    for (let s = -1; s <= 1; s += 2) {
      ctx.save();
      ctx.translate(x + s * r * 0.24, y - r * 0.02);
      ctx.rotate(s * 0.12);
      ctx.scale(s * fs, fs);
      ctx.fillStyle = progress > 0 ? '#9dff7a' : '#ffffff';
      ctx.fill(G.sole);
      ctx.lineWidth = 3 / fs;
      ctx.strokeStyle = INK;
      ctx.stroke(G.sole);
      ctx.restore();
    }
    ctx.restore();
  }

  function drawMedal(x, y, r, rank) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = rank <= 3 ? MEDALS[rank - 1] : '#5aa9ff';
    ctx.fill();
    ctx.lineWidth = Math.max(2, r * 0.18);
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.font = font(r * 1.15);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = INK;
    ctx.fillText(String(rank), x, y + r * 0.06);
  }

  function drawAttractTable(list, real, alpha) {
    const top = pad.y - pad.r;
    ctx.globalAlpha = alpha;
    if (!list.length) {
      outlined(ctx, 'NO SCORES YET TODAY', W / 2, top * 0.3, 30 * U, '#ffffff');
      outlinedScaled('BE THE FIRST!', W / 2, top * 0.72, 46 * U, '#ffe14a', 'center', 1 + 0.05 * Math.sin(real / 200));
      ctx.globalAlpha = 1;
      return;
    }
    outlined(ctx, topTitle, W / 2, top * 0.25, 34 * U, '#ffe14a');
    // two columns either side of the pad; 5 rows each for a top 10, smaller rows for a longer table
    const perCol = Math.max(1, Math.ceil(topN / 2));
    const fit = Math.min(1, 5 / perCol);
    const colW = Math.max(120 * U, pad.x - pad.r - 24 * U);
    const rowsTop = top * 0.62;
    const rowH = Math.min(50 * U, (pad.y + pad.r - rowsTop) / Math.max(4.4, perCol - 0.6));
    const n = Math.min(topN, list.length);
    for (let i = 0; i < n; i++) {
      const col = i < perCol ? 0 : 1;
      const row = i % perCol;
      const cx = col ? W - colW / 2 - 12 * U : colW / 2 + 12 * U;
      const y = rowsTop + row * rowH;
      const pop = clamp01((real - attractT0) % ATTRACT_PAGE_MS / 300 - i * (1.2 / Math.max(10, topN)));
      ctx.save();
      ctx.translate(cx - colW * 0.28, y);
      const s = easeOutBack(pop) * fit;
      ctx.scale(s, s);
      drawMedal(0, 0, 15 * U, i + 1);
      outlined(ctx, String(list[i].score), 26 * U, 0, 32 * U, i === 0 ? '#ffe14a' : '#ffffff', 'left');
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawAttract(real, st) {
    const progress = st ? clamp01(num(st.start_progress, 0)) : 0;
    drawPad(real, progress);
    // alternate between the title and today's top N, with a short fade
    const e = real - attractT0;
    const f = e % ATTRACT_PAGE_MS;
    const alpha = Math.min(1, f / 300, (ATTRACT_PAGE_MS - f) / 300);
    const list = st && Array.isArray(st.highscores) ? st.highscores : EMPTY;
    // With the walls showing today's top N, the title stays up the whole time (no page fades).
    const shown = hudShown();
    const tablePage = Math.floor(e / ATTRACT_PAGE_MS) % 2 === 1;
    const titleAlpha = tablePage ? 1 - shown : lerp(1, alpha, shown);
    beginText(W / 2, H / 2);
    if (titleAlpha > 0.003) {
      const top = pad.y - pad.r;
      ctx.globalAlpha = titleAlpha;
      drawWord(G.title1, W / 2, top * 0.36, real, 0);
      drawWord(G.title2, W / 2, top * 0.8, real, 1.3);
      ctx.globalAlpha = 1;
    }
    if (tablePage && shown > 0) drawAttractTable(list, real, alpha * shown);
    const ty = pad.y + pad.r + 26 * U;
    const bounce = Math.abs(Math.sin(real / 1000 * 3.2)) * -4 * U;
    // start_blocked: someone was already standing here when attract began, so they must step off first
    const blocked = progress === 0 && st && st.start_blocked === true;
    outlined(ctx, progress > 0 ? 'KEEP STANDING!' : blocked ? 'STEP OFF AND BACK ON' : 'STAND HERE',
      W / 2, ty + bounce, 28 * U, progress > 0 ? '#9dff7a' : blocked ? '#ffb74a' : '#ffffff');
    ctx.restore();
  }

  // ------------------------------------------------------------------ results screen

  function drawTimesUp(e, real) {
    const s = e < 300 ? lerp(2.2, 1, easeOutBack(e / 300)) : 1 + 0.02 * Math.sin(e / 70);
    const a = e > TIMES_UP_MS - 220 ? clamp01((TIMES_UP_MS - e) / 220) : 1;
    drawRays(W / 2, H / 2, 1.0, real, 0.5 * a);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-0.05);
    ctx.scale(s, s);
    ctx.font = font(84 * U);
    const fit = Math.min(1, (W * 0.94) / ctx.measureText("TIME'S UP!").width);
    ctx.scale(fit, fit);
    bigText("TIME'S UP!", 84 * U, G.red, 1);
    ctx.restore();
  }

  function popIn(e, delay) {
    return easeOutBack(clamp01((e - delay) / 260));
  }

  // The player's result on the left and today's top N on the right; with the walls showing the
  // table, the result alone, centred and a little bigger.
  function resultX() {
    return lerp(W / 2, W * 0.27, hudShown());
  }

  function drawResultPanel(e, st, real) {
    const res = st.result || { score: st.score, best_combo: st.best_combo, rank: null, new_high: false };
    const list = Array.isArray(st.highscores) ? st.highscores : EMPTY;
    const shown = hudShown();
    const lx = resultX();
    const big = lerp(1.25, 1, shown);

    // left: the player's result
    let s = popIn(e, 0) * big;
    if (s > 0) {
      ctx.save(); ctx.translate(lx, H * lerp(0.125, 0.15, shown)); ctx.scale(s, s);
      outlined(ctx, 'YOUR SCORE', 0, 0, 26 * U, '#ffffff');
      ctx.restore();
    }
    s = popIn(e, 120) * big;
    if (s > 0) {
      ctx.save(); ctx.translate(lx, H * 0.37); ctx.scale(s, s);
      bigText(String(res.score | 0), 112 * U, G.yellow, 0.7);
      ctx.restore();
    }
    s = popIn(e, 260) * big;
    if (s > 0) {
      ctx.save(); ctx.translate(lx, H * lerp(0.6, 0.58, shown)); ctx.scale(s, s);
      outlined(ctx, 'BEST COMBO x' + (res.best_combo | 0), 0, 0, 24 * U, '#ffffff');
      ctx.restore();
    }
    s = popIn(e, 420) * big;
    if (s > 0) {
      ctx.save();
      if (res.new_high) {
        drawRays(lx, H * 0.79, 0.55 * big, real, 0.45);
        const flash = Math.floor(real / 180) % 2 ? '#ffffff' : '#ffe14a';
        ctx.translate(lx, H * 0.79); ctx.scale(s, s);
        outlined(ctx, 'NEW HIGH', 0, -18 * U, 36 * U, flash);
        outlined(ctx, 'SCORE!', 0, 20 * U, 36 * U, flash);
      } else {
        ctx.translate(lx, H * 0.79); ctx.scale(s, s);
        let line = 'TRY AGAIN!';
        if (typeof res.rank === 'number') line = '#' + res.rank + ' TODAY';
        else if ((res.score | 0) > 0) line = 'NICE ONE!';
        outlined(ctx, line, 0, 0, 36 * U, '#9dff7a');
      }
      ctx.restore();
    }

    // right: today's top N (not with the walls: the left wall shows it)
    if (shown <= 0) return;
    const slide = 1 - easeOutCubic(clamp01((e - 150) / 450));
    const px0 = W * 0.53 + slide * W * 0.5;
    const pw = W - 10 * U - W * 0.53;
    const py0 = H * 0.05, ph = H * 0.9;
    ctx.save();
    ctx.globalAlpha = 0.6 * shown;
    ctx.fillStyle = '#000000';
    rrect(ctx, px0, py0, pw, ph, 14 * U);
    ctx.fill();
    ctx.globalAlpha = shown;
    ctx.lineWidth = 3 * U;
    ctx.strokeStyle = '#ffd21a';
    ctx.stroke();
    const cx = px0 + pw / 2;
    ctx.font = font(22 * U);
    const hfit = Math.min(1, (pw - 16 * U) / ctx.measureText(topTitle).width);
    outlined(ctx, topTitle, cx, py0 + 22 * U, 22 * U * hfit, '#ffe14a');
    if (!list.length) {
      outlined(ctx, 'NO SCORES', cx, py0 + ph * 0.45, 24 * U, '#ffffff');
      outlined(ctx, 'YET TODAY', cx, py0 + ph * 0.55, 24 * U, '#ffffff');
    }
    const rowTop = py0 + 56 * U;
    const rowH = (ph - 66 * U) / Math.max(5, topN);
    for (let i = 0; i < Math.min(topN, list.length); i++) {
      const y = rowTop + i * rowH;
      if (res.rank === i + 1) {
        ctx.globalAlpha = (0.55 + 0.25 * Math.sin(real / 150)) * shown;
        ctx.fillStyle = '#ffd21a';
        rrect(ctx, px0 + 6 * U, y - rowH * 0.46, pw - 12 * U, rowH * 0.92, 8 * U);
        ctx.fill();
        ctx.globalAlpha = shown;
      }
      drawMedal(px0 + 24 * U, y, Math.min(12 * U, rowH * 0.4), i + 1);
      outlined(ctx, String(list[i].score), px0 + 46 * U, y, Math.min(26 * U, rowH * 0.8), '#ffffff', 'left');
      outlined(ctx, 'x' + (list[i].best_combo | 0), px0 + pw - 12 * U, y, Math.min(17 * U, rowH * 0.55), '#ffb74a', 'right');
    }
    ctx.restore();
  }

  function drawResults(now, real, st) {
    const e = now - num(st.phase_start, now);
    ctx.globalAlpha = Math.min(0.62, (e / 400) * 0.62);
    ctx.fillStyle = '#000000';
    ctx.fillRect(-10, -10, W + 20, H + 20);
    ctx.globalAlpha = 1;
    beginText(W / 2, H / 2);
    if (e < TIMES_UP_MS) {
      drawTimesUp(e, real);
    } else {
      drawResultPanel(e - TIMES_UP_MS, st, real);
      if (celebrated !== st.phase_start) {
        celebrated = st.phase_start;
        if (st.result && st.result.new_high) {
          burstStars(resultX(), H * 0.37, 18, 480 * U, 0.9, 10 * U);
          if (audio) audio.play('fanfare');
        }
      }
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ frame

  let lastReal = performance.now();
  let lastError = 0;

  function drawConnecting(msg) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = font(18 * U);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9a9a9a';
    ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
  }

  function drawFrame(real, dt) {
    if (!cfg) {
      drawConnecting('connecting...');
      return;
    }
    const now = feed.serverNow();
    const st = latest;
    const tSec = real / 1000;
    updateEffects(dt, real);
    stepHudFade(dt);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#3e8f30';
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(1, 0, 0, 1, shakeX, shakeY);
    ctx.drawImage(field, 0, 0);

    drawRings(real);
    if (st && phase === 'play') drawBanner(real);   // under the moles, so it never hides one

    // moles (real ones from the feed; cosmetic peeks in attract)
    if (phase === 'attract') updatePeeks(real);
    for (let i = 0; i < holes.length; i++) {
      const hole = holes[i];
      const r = holeMole[hole.index];
      if (r) {
        moleVisual(r, now, tSec);
        if (V.h > 0.002) drawMole(hole, tSec);
      } else if (phase === 'attract') {
        for (const p of peeks) {
          if (p.on && p.hole === hole) {
            peekVisual(p, real);
            if (V.h > 0.002) drawMole(hole, tSec);
          }
        }
      }
    }

    drawFeet(dt);
    drawParticles();
    drawFloaters(real);

    if (st) {
      if (phase === 'attract') {
        drawAttract(real, st);
      } else if (phase === 'countdown') {
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#000000';
        ctx.fillRect(-10, -10, W + 20, H + 20);
        ctx.globalAlpha = 1;
        drawHud(now, real, st);
        drawCountdown(real);
      } else if (phase === 'play') {
        drawHud(now, real, st);
        drawCountdown(real);
      } else if (phase === 'results') {
        drawResults(now, real, st);
      }
    }

    if (!feed.connected) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = font(14 * U);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#000000';
      ctx.fillText('reconnecting...', 7 * U, H - 5 * U);
      ctx.fillStyle = '#cfcfcf';
      ctx.fillText('reconnecting...', 6 * U, H - 6 * U);
    }
  }

  function frame() {
    requestAnimationFrame(frame);
    const real = performance.now();
    const dt = Math.min(0.05, Math.max(0, (real - lastReal) / 1000));
    lastReal = real;
    try {
      drawFrame(real, dt);
    } catch (err) {
      if (real - lastError > 5000) {
        lastError = real;
        console.error('floor frame failed:', err);
      }
      for (let i = 0; i < 16; i++) ctx.restore();   // unwind any save() the error skipped
    }
  }

  // ------------------------------------------------------------------ start

  fitCanvas();
  watchDpr();
  window.addEventListener('resize', fitCanvas);
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  const feed = window.StompFeed.connect({
    onHello: onHello,
    onState: onState,
    onEvent: onEvent,
    onStatus: function (connected) {
      if (connected) return;
      for (const f of feet) f.seen = false;   // no feed, no feet: let the shadows fade out
      if (audio) audio.chargeStop();
    },
  });
  if (audio) {
    feed.sendClient('floor', audio.state());
    audio.onStateChange((s) => feed.sendClient('floor', s));
  } else {
    feed.sendClient('floor', 'none');
  }

  requestAnimationFrame(frame);
})();
