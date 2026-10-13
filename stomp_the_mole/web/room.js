/* Stomp the Mole: the walls and ceiling page (DESIGN.md "Walls and ceiling").

   Draws one picture, the signage division (2600 x 1820 by default), at the page's top-left
   in device pixels. The LED controllers cut it into the ceiling and the three walls:
   * ceiling: the animated sky from sky.js (global Sky); a plain sky gradient without it;
   * walls: one continuous cartoon meadow across left + front + right, with a wooden
     signboard on each wall (left: today's top N, front: the scoreboard, right: the mascot
     mole or the round's stats and celebrations).
   Everything comes from the data feed (feed.js, role "room"; "room-test" with ?test=1 and
   "room-preview" with ?preview=1, which the floor does not count as walls): geometry from
   hello.config.room, game data from state and event. No sound, and no game decisions.
   All art is canvas code: no images, no fonts, nothing loaded from the network.

   URL options: ?test=1 test pattern for the region edges, ?preview=1 fit the picture to
   the window, ?fps=N frame cap (overrides room.fps), ?ws=URL feed address (feed.js).

   Performance: the meadow, the fence, the signboards' wood, the clouds and the flowers are
   drawn once into offscreen canvases (again only when the room config changes). Sign
   contents are cached and redrawn only when they change; numbers that change are cached
   sprites, re-rendered only when their value changes. A frame blits those and draws the
   few moving parts. Particles are pooled and capped, and frames are capped at room.fps. The
   walls' sky is a gradient of its own under the land, re-rendered only when the ceiling's
   colour changes (Sky.horizon()). A PC too slow for room.fps drops to 30 fps by itself.
*/
(function () {
  'use strict';

  // ================================================================== constants

  const FONT_STACK = '"Arial Black", "Segoe UI Black", Impact, sans-serif';
  const INK = '#2a1407';                     // outline colour, as on the floor
  const TAU = Math.PI * 2;
  const TIMES_UP_MS = 1700;                  // results: "TIME'S UP!" before the final score (as on the floor)
  const CONTENT_BOTTOM = 1800;               // the sample content is 2600 x 1800: important parts stay above this - safe_inset
  const NO_HELLO_MS = 3000;                  // test pattern: use the defaults after this long without a hello
  const POP_MS = 280;                        // a sign's content pops in when its mode changes
  const BANNER_MS = 2000;                    // right wall: "COMBO x10!" ribbon
  const RAIN_MS = 4500;                      // new high score: confetti rain
  const MAX_CONFETTI = 320;
  const MAX_PEEKS = 2;

  const DEFAULT_ROOM = {
    width: 2600, height: 1820, safe_inset: 40, fps: 60,
    ceiling: { x: 800, y: 0, w: 1000, h: 787 },
    left: { x: 0, y: 787, w: 800, h: 1014 },
    front: { x: 800, y: 787, w: 1000, h: 1013 },
    right: { x: 1800, y: 787, w: 800, h: 1014 },
  };

  // The walls' sky starts at the colour the ceiling's sky ends with (Sky.horizon(), which follows
  // the ceiling's day / warming / sunset), so the front wall's top edge meets the ceiling without a
  // seam, and turns lighter towards the hills. Without sky.js the ceiling is a plain day gradient
  // ending in DAY_HORIZON.
  const CEILING_STOPS = [[0, '#1b66d2'], [0.4, '#3f9eef'], [0.78, '#8fd3fc'], [1, '#c8efff']];
  const DAY_HORIZON = [200, 239, 255];       // #c8efff
  const SKY_FRAC = 0.55;                     // the sky strip's height (the land hides everything below 0.45)
  const SKY_LIGHTEN = 0.7;                   // how far the strip's bottom goes towards white

  const MEDALS = ['#ffcf33', '#dfe7ee', '#e8995c'];
  const CONFETTI_COLOURS = ['#ff4f73', '#ffd21a', '#6dff4a', '#5aa9ff', '#ff9a1f', '#ffffff', '#c77dff'];
  const PLANKS = ['#c98b4c', '#bd7f41', '#d39858', '#c38545', '#cc8e50'];
  const PETALS = ['#ffffff', '#ffe066', '#ff9fd0', '#b9e2ff', '#ffb36b'];
  const DASH = [22, 16];
  const NO_DASH = [];

  // Fills for the chunky lettering: [top, bottom] of a vertical gradient, or one colour.
  const STYLE = {
    title: ['#fff07a', '#ff9d00'],
    yellow: ['#fff27a', '#ffb300'],
    white: ['#ffffff', '#ffe2b8'],
    cream: '#fff3dc',
    red: ['#ffd36b', '#ff3d1f'],
    green: ['#e2ff8f', '#3fd43a'],
    orange: ['#fff27a', '#ff7a00'],
    grey: ['#f2f2f2', '#a9a9a9'],
    blue: ['#e8f7ff', '#55a6ff'],
    pink: ['#ffe3f0', '#ff5f9e'],
  };

  const params = new URLSearchParams(window.location.search);
  const TEST = params.get('test') === '1';
  const PREVIEW = params.get('preview') === '1';
  const FPS_PARAM = Number(params.get('fps'));

  const canvas = document.getElementById('room');
  const ctx = canvas.getContext('2d', { alpha: false });
  const scratch = document.createElement('canvas').getContext('2d');   // text measuring only

  // ================================================================== small helpers

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutCubic = (t) => 1 - (1 - t) * (1 - t) * (1 - t);
  const easeInQuad = (t) => t * t;
  function easeOutBack(t) {
    const c1 = 1.70158, c3 = c1 + 1, u = t - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
  }

  function num(v, fallback) {
    return typeof v === 'number' && isFinite(v) ? v : fallback;
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

  // Resizing a canvas clears it (and resets its context); a canvas of the same size is cleared.
  function resetCanvas(c, w, h) {
    w = Math.max(1, Math.ceil(w));
    h = Math.max(1, Math.ceil(h));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    } else {
      const g = c.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, w, h);
    }
    return c.getContext('2d');
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

  function rrect(g, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function softSprite(r, g, b, radius) {
    const c = makeCanvas(radius * 2, radius * 2);
    const x = c.getContext('2d');
    const grad = x.createRadialGradient(radius, radius, 0, radius, radius, radius);
    grad.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',1)');
    grad.addColorStop(0.45, 'rgba(' + r + ',' + g + ',' + b + ',0.55)');
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

  // ================================================================== lettering

  function measure(str, px) {
    scratch.font = font(px);
    return scratch.measureText(str);
  }

  // Chunky cartoon lettering, the floor's style: drop shadow, thick ink outline, a vertical
  // gradient fill and a glossy top half. (x, y) is the alphabetic baseline start; m the metrics.
  function paintText(g, str, x, y, px, style, outline, m) {
    const ow = Math.max(3, px * outline);
    g.font = font(px);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';
    g.miterLimit = 2;
    g.lineWidth = ow;
    const sx = px * 0.025, sy = Math.max(2, px * 0.06);
    g.fillStyle = 'rgba(0, 0, 0, 0.5)';
    g.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    g.strokeText(str, x + sx, y + sy);
    g.fillText(str, x + sx, y + sy);
    g.strokeStyle = INK;
    g.strokeText(str, x, y);
    if (typeof style === 'string') {
      g.fillStyle = style;
      g.fillText(str, x, y);
      return;
    }
    const top = y - m.actualBoundingBoxAscent, bottom = y + m.actualBoundingBoxDescent;
    const grad = g.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, style[0]);
    grad.addColorStop(1, style[1]);
    g.fillStyle = grad;
    g.fillText(str, x, y);
    g.save();
    g.beginPath();
    g.rect(x - m.actualBoundingBoxLeft - 4, top - 4, m.actualBoundingBoxLeft + m.actualBoundingBoxRight + 8,
      (bottom - top) * 0.46 + 4);
    g.clip();
    g.globalAlpha = 0.32;
    g.fillStyle = '#ffffff';
    g.fillText(str, x, y);
    g.restore();
  }

  // Draws text with its visible glyph box centred vertically on cy. align: the glyph box's
  // 'left' or 'right' edge at x, or its centre ('center'). Shrinks to maxW. Returns the size used.
  function drawText(g, str, x, cy, px, style, align, maxW, outline) {
    let m = measure(str, px);
    let gw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    if (maxW && gw > maxW) {
      px *= maxW / gw;
      m = measure(str, px);
      gw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    }
    const gh = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    const left = align === 'left' ? x : align === 'right' ? x - gw : x - gw / 2;
    paintText(g, str, left + m.actualBoundingBoxLeft, cy - gh / 2 + m.actualBoundingBoxAscent, px, style,
      outline || 0.16, m);
    return px;
  }

  // Pre-rendered lettering. (cx, cy) is the centre of the visible glyphs inside the canvas.
  function newSprite() {
    return { c: makeCanvas(1, 1), w: 1, h: 1, cx: 0, cy: 0, gw: 0, gh: 0, px: 0, key: null };
  }

  function renderSprite(sp, str, px, style, maxW, outline) {
    outline = outline || 0.16;
    let m = measure(str, px);
    let gw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    if (maxW && gw > maxW) {
      px *= maxW / gw;
      m = measure(str, px);
      gw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    }
    const gh = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    const ow = Math.max(3, px * outline);
    const pad = Math.ceil(ow / 2 + 4);
    const w = Math.ceil(gw + pad * 2 + px * 0.03), h = Math.ceil(gh + pad * 2 + Math.max(2, px * 0.06));
    const g = resetCanvas(sp.c, w, h);
    paintText(g, str, pad + m.actualBoundingBoxLeft, pad + m.actualBoundingBoxAscent, px, style, outline, m);
    sp.w = sp.c.width;
    sp.h = sp.c.height;
    sp.cx = pad + gw / 2;
    sp.cy = pad + gh / 2;
    sp.gw = gw;
    sp.gh = gh;
    sp.px = px;
    return sp;
  }

  // True (once) when a sprite must be re-rendered for a new key; callers build the text only then,
  // so a frame allocates nothing while the value stays the same.
  function stale(sp, key) {
    if (sp.key === key) return false;
    sp.key = key;
    return true;
  }

  // Draws a sprite with its glyph centre at (x, y), scaled by s.
  function drawSprite(sp, x, y, s) {
    if (s === 1) {
      ctx.drawImage(sp.c, Math.round(x - sp.cx), Math.round(y - sp.cy));
    } else {
      ctx.drawImage(sp.c, x - sp.cx * s, y - sp.cy * s, sp.w * s, sp.h * s);
    }
  }

  // ================================================================== config and layout

  let room = null;            // normalised room config (normRoom)
  let roomKey = '';
  let roomSource = 'defaults';   // 'game' | 'defaults' | 'defaults-no-room' (hello without room)
  let topN = 10;
  let topTitle = "TODAY'S TOP 10";
  const T = { step: 1000, go: 800, play: 60000, warn: 10, results: 8000 };
  let L = null;               // layout (buildLayout)
  let frameInterval = 1000 / 60;

  function normRect(r, d) {
    r = r && typeof r === 'object' ? r : {};
    const w = num(r.w, d.w), h = num(r.h, d.h);
    if (!(w > 0 && h > 0)) return { x: d.x, y: d.y, w: d.w, h: d.h };
    return { x: Math.round(num(r.x, d.x)), y: Math.round(num(r.y, d.y)), w: Math.round(w), h: Math.round(h) };
  }

  // config.py refuses values outside these limits (DESIGN "Config"); the clamps here are only a
  // defence for a game that sends something else, and they say so in the console.
  function normRoom(c) {
    const d = DEFAULT_ROOM;
    c = c && typeof c === 'object' ? c : {};
    const width = Math.round(num(c.width, d.width)), height = Math.round(num(c.height, d.height));
    const fps = FPS_PARAM > 0 ? FPS_PARAM : num(c.fps, d.fps);
    const insetIn = num(c.safe_inset, d.safe_inset);
    const inset = Math.max(0, Math.min(200, insetIn));
    const sizeOk = (v) => v >= 100 && v <= 8192;
    if (inset !== insetIn) console.warn('room: safe_inset ' + insetIn + ' is outside 0..200; using ' + inset);
    if (!sizeOk(width) || !sizeOk(height)) {
      console.warn('room: width x height ' + width + ' x ' + height + ' is outside 100..8192; using ' +
        (sizeOk(width) ? width : d.width) + ' x ' + (sizeOk(height) ? height : d.height));
    }
    return {
      width: sizeOk(width) ? width : d.width,
      height: sizeOk(height) ? height : d.height,
      inset: inset,
      fps: Math.max(1, Math.min(240, fps > 0 ? fps : d.fps)),
      ceiling: normRect(c.ceiling, d.ceiling),
      left: normRect(c.left, d.left),
      front: normRect(c.front, d.front),
      right: normRect(c.right, d.right),
    };
  }

  // The part of a wall where content may go: safe_inset from every edge, and above
  // y = 1800 - safe_inset (the true wall bottom may be 1799, see DESIGN "Hardware facts").
  function safeBox(R) {
    const ins = room.inset;
    const bottom = R.y < CONTENT_BOTTOM ? Math.min(R.y + R.h, CONTENT_BOTTOM) : R.y + R.h;
    return { x: R.x + ins, y: R.y + ins, x2: R.x + R.w - ins, y2: bottom - ins };
  }

  // A signboard inside its wall, and the content area inside its wooden frame.
  function makeSign(R, S, widthFrac, top, bottom) {
    const maxW = S.x2 - S.x;
    const w = Math.round(Math.min(maxW, R.w * widthFrac));
    const x = Math.round(R.x + (R.w - w) / 2);
    const y = Math.round(Math.max(S.y, top)), y2 = Math.round(Math.min(S.y2, bottom));
    const h = y2 - y;
    const fw = Math.round(Math.max(16, Math.min(30, Math.min(w, h) * 0.034)));
    const pad = Math.round(Math.max(8, Math.min(w, h) * 0.014));
    const ci = fw + pad;
    return {
      x: x, y: y, w: w, h: h, fw: fw, region: R,
      inner: { x: x + ci, y: y + ci, w: w - ci * 2, h: h - ci * 2 },
      board: null,
    };
  }

  function buildLayout() {
    const walls = [room.left, room.front, room.right];
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, area = 0;
    for (let i = 0; i < walls.length; i++) {
      const R = walls[i];
      x1 = Math.min(x1, R.x);
      y1 = Math.min(y1, R.y);
      x2 = Math.max(x2, R.x + R.w);
      y2 = Math.max(y2, R.y + R.h);
      area += R.w * R.h;
    }
    const box = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    let overlap = false;
    for (let i = 0; i < walls.length; i++) {
      for (let j = i + 1; j < walls.length; j++) {
        const a = walls[i], b = walls[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlap = true;
      }
    }
    const tiled = !overlap && area === box.w * box.h;
    const clip = new Path2D();
    for (let i = 0; i < walls.length; i++) clip.rect(walls[i].x, walls[i].y, walls[i].w, walls[i].h);

    const out = { box: box, tiled: tiled, wallClip: clip, ceiling: room.ceiling, walls: walls };
    const names = ['left', 'front', 'right'];
    let signBottom = -Infinity;
    for (let i = 0; i < 3; i++) {
      const R = walls[i];
      const S = safeBox(R);
      const top = S.y + Math.round(R.h * 0.006);
      const bottom = S.y2 - Math.round(R.h * 0.058);
      const wl = { R: R, S: S };
      wl.sign = makeSign(R, S, names[i] === 'front' ? 0.9 : 0.82, top, bottom);
      if (names[i] === 'right') {
        // attract: a shorter sign at the top and the mascot mole below it
        const sh = Math.round((wl.sign.h) * 0.56);
        wl.small = makeSign(R, S, 0.82, top, top + sh);
      }
      signBottom = Math.max(signBottom, wl.sign.y + wl.sign.h);
      out[names[i]] = wl;
    }
    // the fence runs along the bottom of the walls, just under the signboards
    out.fenceTop = Math.round(Math.min(signBottom + 4, box.y + box.h * 0.9));
    L = out;
  }

  // ================================================================== static art: the meadow

  let pano = null;            // hills, trees, meadow on a transparent sky (G.wallSky goes behind it)
  let cloudBand = 1;          // the walls' top rows the clouds can cover
  let fore = null, foreY = 0; // fence, front grass and mounds (in front of the signboards)
  const clouds = [];
  const flowers = [];
  let flowerSprites = [];
  let cloudSprites = [];

  function hillY(x, base, amp, waves, phase) {
    let y = base;
    for (let i = 0; i < waves.length; i++) {
      const w = waves[i];
      y -= amp * w[1] * Math.sin(x * w[0] + phase * (i + 1.7));
    }
    return y;
  }

  function hillPaths(x0, x1, base, amp, waves, phase, bottom) {
    const top = new Path2D(), fill = new Path2D();
    let first = true;
    for (let x = x0 - 24; x <= x1 + 24; x += 8) {
      const y = hillY(x, base, amp, waves, phase);
      if (first) {
        top.moveTo(x, y);
        fill.moveTo(x, y);
        first = false;
      } else {
        top.lineTo(x, y);
        fill.lineTo(x, y);
      }
    }
    fill.lineTo(x1 + 24, bottom);
    fill.lineTo(x0 - 24, bottom);
    fill.closePath();
    return { top: top, fill: fill };
  }

  function paintHill(g, p, yTop, yBottom, light, dark, line, lineW, rim) {
    const grad = g.createLinearGradient(0, yTop, 0, yBottom);
    grad.addColorStop(0, light);
    grad.addColorStop(1, dark);
    g.fillStyle = grad;
    g.fill(p.fill);
    g.lineJoin = 'round';
    if (rim) {   // cartoon rim light just under the ridge
      g.save();
      g.clip(p.fill);
      g.translate(0, lineW * 1.6);
      g.lineWidth = lineW * 2.2;
      g.strokeStyle = rim;
      g.stroke(p.top);
      g.restore();
    }
    g.lineWidth = lineW;
    g.strokeStyle = line;
    g.stroke(p.top);
  }

  // Round cartoon tree: trunk and a cluster of leafy balls with one outline around them.
  function drawTree(g, x, baseY, s, rnd, tone) {
    const k = s / 100;
    const lw = Math.max(3, 4.2 * k);
    // trunk
    g.beginPath();
    g.moveTo(x - 9 * k, baseY + 4 * k);
    g.quadraticCurveTo(x - 6 * k, baseY - 30 * k, x - 5 * k, baseY - 62 * k);
    g.lineTo(x + 5 * k, baseY - 62 * k);
    g.quadraticCurveTo(x + 6 * k, baseY - 30 * k, x + 9 * k, baseY + 4 * k);
    g.closePath();
    g.fillStyle = '#8a5428';
    g.fill();
    g.lineWidth = lw;
    g.strokeStyle = INK;
    g.stroke();
    g.fillStyle = 'rgba(255, 220, 170, 0.3)';
    g.fillRect(x - 4 * k, baseY - 58 * k, 2.5 * k, 50 * k);
    const blobs = [
      [0, -86, 34], [-27, -70, 25], [27, -72, 26], [-15, -108, 24], [16, -110, 23], [0, -60, 22],
    ];
    const cols = tone === 1 ? ['#3f8f33', '#5cb547', '#86d65e'] : ['#2f7d2c', '#48a33c', '#74c955'];
    g.lineWidth = lw * 2;
    g.strokeStyle = '#1b4314';
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      g.beginPath();
      g.arc(x + b[0] * k, baseY + b[1] * k, b[2] * k, 0, TAU);
      g.stroke();
    }
    g.fillStyle = cols[0];
    g.beginPath();
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      g.moveTo(x + b[0] * k + b[2] * k, baseY + b[1] * k);
      g.arc(x + b[0] * k, baseY + b[1] * k, b[2] * k, 0, TAU);
    }
    g.fill();
    g.fillStyle = cols[1];
    g.beginPath();
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      const r = b[2] * k * 0.78;
      g.moveTo(x + b[0] * k - 3 * k + r, baseY + b[1] * k - 4 * k);
      g.arc(x + b[0] * k - 3 * k, baseY + b[1] * k - 4 * k, r, 0, TAU);
    }
    g.fill();
    g.fillStyle = cols[2];
    g.beginPath();
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      if (b[1] > -80) continue;
      const r = b[2] * k * 0.36;
      g.moveTo(x + b[0] * k - 9 * k + r, baseY + b[1] * k - 10 * k);
      g.arc(x + b[0] * k - 9 * k, baseY + b[1] * k - 10 * k, r, 0, TAU);
    }
    g.fill();
    // a few fruit or blossom dots
    if (rnd() < 0.5) {
      g.fillStyle = rnd() < 0.5 ? '#ff5b4a' : '#ffffff';
      for (let i = 0; i < 5; i++) {
        const b = blobs[Math.floor(rnd() * blobs.length)];
        g.beginPath();
        g.arc(x + (b[0] + (rnd() - 0.5) * b[2]) * k, baseY + (b[1] + (rnd() - 0.5) * b[2]) * k, 3.4 * k, 0, TAU);
        g.fill();
      }
    }
  }

  function drawPine(g, x, baseY, s) {
    const k = s / 100;
    g.fillStyle = '#7a4a22';
    g.fillRect(x - 6 * k, baseY - 22 * k, 12 * k, 26 * k);
    g.lineWidth = Math.max(3, 4 * k);
    g.strokeStyle = INK;
    g.strokeRect(x - 6 * k, baseY - 22 * k, 12 * k, 26 * k);
    for (let i = 0; i < 3; i++) {
      const y = baseY - 18 * k - i * 30 * k;
      const w = (46 - i * 10) * k;
      g.beginPath();
      g.moveTo(x - w, y);
      g.quadraticCurveTo(x - w * 0.3, y - 30 * k, x, y - 62 * k);
      g.quadraticCurveTo(x + w * 0.3, y - 30 * k, x + w, y);
      g.closePath();
      g.fillStyle = i === 2 ? '#3b8f3a' : '#2f7a31';
      g.fill();
      g.lineWidth = Math.max(3, 4 * k);
      g.strokeStyle = '#173f12';
      g.stroke();
    }
  }

  function drawBush(g, x, y, s, rnd) {
    const n = 4 + Math.floor(rnd() * 3);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0 : i / (n - 1) - 0.5;
      pts.push([x + f * s * 1.5, y - s * (0.32 + 0.3 * (1 - Math.abs(f) * 2)) , s * (0.34 + rnd() * 0.16)]);
    }
    g.lineWidth = Math.max(3, s * 0.07);
    g.strokeStyle = '#1b4314';
    for (const p of pts) {
      g.beginPath();
      g.arc(p[0], p[1], p[2], 0, TAU);
      g.stroke();
    }
    g.fillStyle = '#3f9636';
    g.beginPath();
    for (const p of pts) {
      g.moveTo(p[0] + p[2], p[1]);
      g.arc(p[0], p[1], p[2], 0, TAU);
    }
    g.fill();
    g.fillStyle = '#62bb4b';
    g.beginPath();
    for (const p of pts) {
      const r = p[2] * 0.6;
      g.moveTo(p[0] - p[2] * 0.2 + r, p[1] - p[2] * 0.25);
      g.arc(p[0] - p[2] * 0.2, p[1] - p[2] * 0.25, r, 0, TAU);
    }
    g.fill();
    if (rnd() < 0.6) {   // berries / blossoms
      g.fillStyle = rnd() < 0.5 ? '#ff6f9c' : '#fff2a8';
      for (let i = 0; i < 6; i++) {
        const p = pts[Math.floor(rnd() * pts.length)];
        g.beginPath();
        g.arc(p[0] + (rnd() - 0.5) * p[2], p[1] + (rnd() - 0.5) * p[2], Math.max(2, s * 0.045), 0, TAU);
        g.fill();
      }
    }
  }

  function drawTuft(g, x, y, s, light, dark) {
    g.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      g.strokeStyle = pass ? light : dark;
      g.lineWidth = Math.max(1.5, s * (pass ? 0.09 : 0.2));
      for (let b = 0; b < 5; b++) {
        const dx = (b - 2) * s * 0.3;
        const hgt = s * (0.75 + ((b * 7919) % 5) * 0.12);
        g.beginPath();
        g.moveTo(x + dx, y);
        g.quadraticCurveTo(x + dx * 1.1, y - hgt * 0.6, x + dx * 1.7, y - hgt);
        g.stroke();
      }
    }
  }

  function drawFlowerHead(g, x, y, s, petal) {
    g.fillStyle = petal;
    g.strokeStyle = 'rgba(42, 20, 7, 0.55)';
    g.lineWidth = Math.max(1, s * 0.12);
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
    g.stroke();
  }

  function cloudSprite(w, h, rnd) {
    const pad = 8;
    const c = makeCanvas(w + pad * 2, h + pad * 2);
    const g = c.getContext('2d');
    const puffs = [
      [0.2, 0.66, 0.3], [0.38, 0.44, 0.4], [0.6, 0.38, 0.38], [0.8, 0.62, 0.3], [0.5, 0.7, 0.3],
    ];
    const path = new Path2D();
    for (const p of puffs) {
      const r = p[2] * h * (0.92 + rnd() * 0.16);
      const x = pad + p[0] * w, y = pad + p[1] * h;
      path.moveTo(x + r, y);
      path.arc(x, y, r, 0, TAU);
    }
    path.rect(pad + 0.2 * w, pad + 0.66 * h, 0.6 * w, 0.3 * h);
    g.lineWidth = Math.max(5, h * 0.05);
    g.lineJoin = 'round';
    g.strokeStyle = '#2c5a93';
    g.stroke(path);
    g.fillStyle = '#ffffff';
    g.fill(path);
    g.save();
    g.clip(path);
    const sg = g.createLinearGradient(0, pad + h * 0.45, 0, pad + h);
    sg.addColorStop(0, 'rgba(200, 225, 248, 0)');
    sg.addColorStop(1, 'rgba(176, 208, 240, 0.95)');
    g.fillStyle = sg;
    g.fillRect(0, 0, c.width, c.height);
    g.restore();
    return c;
  }

  function flowerSprite(petal, s, stem) {
    const w = Math.ceil(s * 4), h = Math.ceil(stem + s * 3);
    const c = makeCanvas(w, h);
    const g = c.getContext('2d');
    const x = w / 2, by = h - 2, hy = h - 2 - stem;
    g.lineCap = 'round';
    g.lineWidth = Math.max(3, s * 0.32);
    g.strokeStyle = '#1f5a17';
    g.beginPath();
    g.moveTo(x, by);
    g.quadraticCurveTo(x - s * 0.4, by - stem * 0.5, x, hy);
    g.stroke();
    g.lineWidth = Math.max(1.5, s * 0.16);
    g.strokeStyle = '#5cc144';
    g.stroke();
    g.fillStyle = '#4fae3c';
    g.beginPath();
    g.ellipse(x + s * 0.55, by - stem * 0.4, s * 0.6, s * 0.24, -0.6, 0, TAU);
    g.fill();
    drawFlowerHead(g, x, hy, s, petal);
    return { c: c, ax: x, ay: by };
  }

  function buildPanorama() {
    const b = L.box;
    pano = makeCanvas(b.w, b.h);
    const g = pano.getContext('2d');
    g.translate(-b.x, -b.y);
    const X0 = b.x, X1 = b.x + b.w, Y0 = b.y, H = b.h;
    const at = (f) => Y0 + H * f;
    const rnd = mulberry32(20261010);

    // The sky is not in this canvas: it is a separate gradient (G.wallSky, drawn under the land
    // each frame, 1:1 so the blit is a plain copy) so it can follow the ceiling's colour. This
    // canvas is the land on a transparent sky; the land covers everything below SKY_FRAC.
    wallSkyRGB[0] = -1;   // re-render the sky at the new size
    G.wallSky = makeCanvas(b.w, Math.ceil(H * SKY_FRAC));

    // far hills, hazy, with small trees
    const farBase = at(0.4);
    const far = hillPaths(X0, X1, farBase, H * 0.05, [[0.0023, 1], [0.0051, 0.45], [0.012, 0.15]], 1.3, Y0 + H);
    paintHill(g, far, farBase - H * 0.06, at(0.7), '#b9e2a2', '#9fd08a', '#7eb26c', 4, 'rgba(235, 255, 215, 0.6)');
    for (let x = X0 + 60; x < X1; x += 90 + rnd() * 160) {
      const y = hillY(x, farBase, H * 0.05, [[0.0023, 1], [0.0051, 0.45], [0.012, 0.15]], 1.3) + 10;
      g.globalAlpha = 0.75;
      if (rnd() < 0.4) drawPine(g, x, y, 60 + rnd() * 30);
      else drawTree(g, x, y, 55 + rnd() * 30, rnd, 1);
      g.globalAlpha = 1;
    }
    g.globalCompositeOperation = 'source-atop';    // haze over the far hills (not over the sky)
    g.fillStyle = 'rgba(214, 240, 255, 0.28)';
    g.fillRect(X0, Y0, b.w, H);
    g.globalCompositeOperation = 'source-over';

    // middle hills with big trees; the tallest stand at the wall seams, where they show
    // between the signboards and frame them
    const midBase = at(0.52);
    const midWaves = [[0.0017, 1], [0.0043, 0.5], [0.0101, 0.16]];
    const mid = hillPaths(X0, X1, midBase, H * 0.06, midWaves, 4.1, Y0 + H);
    paintHill(g, mid, midBase - H * 0.07, at(0.85), '#88cf5c', '#5fae40', '#356f22', 5, 'rgba(210, 255, 160, 0.55)');
    const treeXs = [];
    const seams = [L.left.R.x + L.left.R.w, L.right.R.x];
    // sizes in units of the wall height; the seam trees are the tallest (their crowns are clamped
    // below the walls' top edge where the hill under them is high, see below)
    const big = H * 0.4;
    for (let i = 0; i < seams.length; i++) treeXs.push([seams[i] + (i ? 14 : -14), big * (0.98 + rnd() * 0.04), i]);
    treeXs.push([X0 + 18, big * 0.9, 0], [X1 - 22, big * 0.92, 1]);
    for (let x = X0 + 150; x < X1 - 100; x += 170 + rnd() * 160) {
      let near = false;
      for (const t of treeXs) if (Math.abs(t[0] - x) < 150) near = true;
      if (!near) treeXs.push([x, big * (0.55 + rnd() * 0.35), Math.floor(rnd() * 2)]);
    }
    treeXs.sort((p, q) => p[1] - q[1]);
    for (const t of treeXs) {
      const y = hillY(t[0], midBase, H * 0.06, midWaves, 4.1) + H * 0.05;
      // a crown reaches 1.38 x its size above its base (outline included): keep it at least 20 px
      // under the walls' top edge, or the edge would slice it flat right under the ceiling
      drawTree(g, t[0], y, Math.min(t[1], (y - Y0 - 20) / 1.38), rnd, t[2]);
    }

    // near meadow, the floor's grass colour at the bottom
    const nearBase = at(0.66);
    const nearWaves = [[0.0013, 1], [0.0037, 0.4]];
    const near = hillPaths(X0, X1, nearBase, H * 0.035, nearWaves, 2.2, Y0 + H);
    paintHill(g, near, nearBase - H * 0.04, Y0 + H, '#77c95a', '#4ba63b', '#2f6f20', 5, 'rgba(200, 255, 150, 0.5)');
    // grass texture and bushes along the meadow
    g.save();
    g.clip(near.fill);
    g.lineCap = 'round';
    for (let i = 0; i < (b.w * H) / 900; i++) {
      const x = X0 + rnd() * b.w, y = nearBase - H * 0.04 + rnd() * H * 0.4;
      g.strokeStyle = rnd() < 0.55 ? 'rgba(28, 92, 20, 0.3)' : 'rgba(190, 245, 140, 0.3)';
      g.lineWidth = 2.2;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (rnd() - 0.5) * 5, y - 7 - rnd() * 9);
      g.stroke();
    }
    g.restore();
    for (let x = X0 + 40; x < X1; x += 120 + rnd() * 200) {
      const y = hillY(x, nearBase, H * 0.035, nearWaves, 2.2) + 26 + rnd() * 30;
      drawBush(g, x, y, 60 + rnd() * 40, rnd);
    }
    for (let i = 0; i < b.w / 26; i++) {
      const x = X0 + rnd() * b.w;
      const y = hillY(x, nearBase, H * 0.035, nearWaves, 2.2) + 50 + rnd() * (H * 0.3);
      if (rnd() < 0.5) drawTuft(g, x, y, 14 + rnd() * 8, '#9be56d', '#2b7a20');
      else drawFlowerHead(g, x, y, 5 + rnd() * 3, PETALS[Math.floor(rnd() * PETALS.length)]);
    }

    // drifting clouds (drawn on top each frame; built here with the rest)
    cloudSprites = [cloudSprite(420, 150, rnd), cloudSprite(320, 120, rnd), cloudSprite(520, 170, rnd)];
    clouds.length = 0;
    const nClouds = Math.max(3, Math.round(b.w / 380));
    for (let i = 0; i < nClouds; i++) {
      clouds.push({
        sp: cloudSprites[i % cloudSprites.length],
        x0: X0 + (i / nClouds) * b.w + rnd() * 120,
        y: Y0 + 6 + rnd() * Math.min(110, H * 0.1),
        speed: 9 + rnd() * 10,
        s: 0.75 + rnd() * 0.35,
        pos: 0,
      });
    }
    // where each cloud is along its loop (0 .. span); drawWallsBack moves it on by dt every frame
    for (const c of clouds) {
      const span = b.w + c.sp.width * c.s;
      c.pos = ((c.x0 - b.x) % span + span) % span;
    }
    // the rows the clouds can cover, for tinting them in a warm sky
    cloudBand = 1;
    for (const c of clouds) cloudBand = Math.max(cloudBand, Math.ceil(c.y - Y0 + c.sp.height * c.s) + 2);
    cloudBand = Math.min(cloudBand, G.wallSky.height);
  }

  // ================================================================== static art: fence, mounds, front grass

  // Dirt mounds (holes) seen from the side; moles rise out of them, clipped like on the floor.
  function makeHole(x, y, k) {
    const R = 48 * k;
    const h = { x: x, y: y, k: k, R: R, orx: R * 0.84, ory: R * 0.34, mrx: R * 1.34, mry: R * 0.62,
                clip: null, lip: null, lipX: 0, lipY: 0 };
    const wide = R * 1.9;
    const p = new Path2D();
    p.moveTo(x - wide, y - R * 3.6);
    p.lineTo(x + wide, y - R * 3.6);
    p.lineTo(x + wide, y);
    p.lineTo(x + h.orx, y);
    p.ellipse(x, y, h.orx, h.ory, 0, 0, Math.PI, false);
    p.lineTo(x - wide, y);
    p.closePath();
    h.clip = p;
    const lw = (h.orx + 10 * k) * 2, lh = (h.ory + 10 * k) * 2;
    h.lip = makeCanvas(lw, lh);
    drawLip(h.lip.getContext('2d'), lw / 2, lh / 2, h.orx, h.ory, k);
    h.lipX = Math.round(x - lw / 2);
    h.lipY = Math.round(y - lh / 2);
    return h;
  }

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
    const my = y + h.ory * 0.9;
    g.fillStyle = 'rgba(14, 44, 8, 0.35)';
    g.beginPath();
    g.ellipse(x + 4 * k, my + h.mry * 0.55, h.mrx * 1.05, h.mry * 0.5, 0, 0, TAU);
    g.fill();
    // the dome
    const mg = g.createRadialGradient(x - h.mrx * 0.3, my - h.mry * 0.7, h.mry * 0.1, x, my, h.mrx * 1.05);
    mg.addColorStop(0, '#d39b63');
    mg.addColorStop(0.55, '#9b663b');
    mg.addColorStop(1, '#6a4020');
    g.fillStyle = mg;
    g.beginPath();
    g.ellipse(x, my, h.mrx, h.mry, 0, Math.PI, TAU);
    g.ellipse(x, my, h.mrx, h.mry * 0.35, 0, 0, Math.PI);
    g.fill();
    g.lineWidth = 3 * k;
    g.strokeStyle = '#47280f';
    g.stroke();
    for (let i = 0; i < 18; i++) {
      const a = Math.PI + rnd() * Math.PI;
      const f = 0.55 + rnd() * 0.4;
      const px = x + Math.cos(a) * h.mrx * f;
      const py = my + Math.sin(a) * h.mry * f * 0.9;
      if (Math.abs(px - x) < h.orx && py < y + h.ory) continue;
      const r = (1.4 + rnd() * 2.2) * k;
      g.fillStyle = rnd() < 0.5 ? '#6f4422' : '#c48d58';
      g.beginPath();
      g.ellipse(px, py, r * 1.3, r, 0, 0, TAU);
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

  let peekHoles = [];
  let mascotHole = null;
  let mascotS = 4;

  function buildForeground() {
    const b = L.box;
    const top = L.fenceTop - 8;
    const bottom = b.y + b.h;
    foreY = top;
    fore = makeCanvas(b.w, bottom - top);
    const g = fore.getContext('2d');
    g.translate(-b.x, -top);
    const rnd = mulberry32(99);
    const ft = L.fenceTop;
    const fh = bottom - ft;

    // rails behind the posts
    const railH = Math.max(14, Math.round(fh * 0.17));
    const rails = [ft + Math.round(fh * 0.22), ft + Math.round(fh * 0.56)];
    for (const ry of rails) {
      const rg = g.createLinearGradient(0, ry, 0, ry + railH);
      rg.addColorStop(0, '#e2ab6b');
      rg.addColorStop(1, '#b57940');
      g.fillStyle = rg;
      g.fillRect(b.x - 10, ry, b.w + 20, railH);
      g.fillStyle = 'rgba(255, 236, 200, 0.45)';
      g.fillRect(b.x - 10, ry + 3, b.w + 20, 3);
      g.lineWidth = 4;
      g.strokeStyle = INK;
      g.strokeRect(b.x - 10, ry, b.w + 20, railH);
      g.strokeStyle = 'rgba(110, 62, 22, 0.35)';
      g.lineWidth = 2;
      for (let x = b.x; x < b.x + b.w; x += 60 + rnd() * 90) {
        g.beginPath();
        g.moveTo(x, ry + railH * 0.45);
        g.lineTo(x + 30 + rnd() * 50, ry + railH * 0.5 + (rnd() - 0.5) * 4);
        g.stroke();
      }
    }
    // posts at fixed absolute positions, so the fence runs on unbroken from wall to wall
    const step = 160, pw = 30;
    for (let x = Math.floor(b.x / step) * step + 60; x < b.x + b.w + pw; x += step) {
      const pg = g.createLinearGradient(x - pw / 2, 0, x + pw / 2, 0);
      pg.addColorStop(0, '#e8b57a');
      pg.addColorStop(1, '#ad7038');
      g.fillStyle = pg;
      g.beginPath();
      g.moveTo(x - pw / 2, bottom + 4);
      g.lineTo(x - pw / 2, ft + pw / 2);
      g.arc(x, ft + pw / 2, pw / 2, Math.PI, 0);
      g.lineTo(x + pw / 2, bottom + 4);
      g.closePath();
      g.fill();
      g.lineWidth = 4;
      g.strokeStyle = INK;
      g.stroke();
      g.fillStyle = '#5b5f63';
      for (const ry of rails) {
        g.beginPath();
        g.arc(x, ry + railH / 2, 3.2, 0, TAU);
        g.fill();
      }
    }
    // front grass, the floor's colour, with tufts over the fence feet
    const gy = bottom - Math.max(18, Math.round(fh * 0.24));
    g.fillStyle = '#4ba63b';
    g.beginPath();
    g.moveTo(b.x - 10, bottom + 4);
    for (let x = b.x - 10; x <= b.x + b.w + 10; x += 14) g.lineTo(x, gy + Math.sin(x * 0.05) * 4 + Math.sin(x * 0.013) * 5);
    g.lineTo(b.x + b.w + 10, bottom + 4);
    g.closePath();
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = '#2b6e1f';
    g.stroke();
    for (let x = b.x + 6; x < b.x + b.w; x += 16 + rnd() * 26) {
      drawTuft(g, x, gy + 12 + rnd() * 10, 16 + rnd() * 12, '#9be56d', '#246c19');
    }

    // mounds: two or three on each wall where a mole can peek out in attract, and the mascot's
    const holeY = Math.round(ft + fh * 0.58);
    const pk = Math.max(0.8, Math.min(1.3, L.left.R.h / 950));
    const spots = [
      [L.left.R, 0.26], [L.left.R, 0.74], [L.front.R, 0.2], [L.front.R, 0.8], [L.right.R, 0.13],
    ];
    peekHoles = [];
    for (const s of spots) {
      const hx = Math.round(s[0].x + s[0].w * s[1]);
      const h = makeHole(hx, holeY, pk);
      drawMound(g, h, rnd);
      peekHoles.push(h);
    }
    // the mascot: a big mole in a big mound, under the right wall's attract sign
    const R = L.right.R;
    const room0 = L.right.small.y + L.right.small.h;
    // about 75 units of the mole show above the rim and the mound reaches 25 units below it;
    // the whole mound stays above the bottom of the sample content (y 1800)
    const groundY = Math.min(bottom, CONTENT_BOTTOM) - 4;
    mascotS = Math.max(1.4, Math.min(R.w / 205, (groundY - room0 - 60) / 100));
    const mY = Math.round(groundY - 25 * mascotS);
    mascotHole = makeHole(Math.round(R.x + R.w * 0.58), mY, mascotS);
    drawMound(g, mascotHole, rnd);

    // flowers that sway in front of everything
    flowerSprites = [];
    for (let i = 0; i < PETALS.length; i++) flowerSprites.push(flowerSprite(PETALS[i], 9, 46 + i * 5));
    flowers.length = 0;
    for (let x = b.x + 30; x < b.x + b.w - 20; x += 110 + rnd() * 140) {
      let clash = false;
      for (const h of peekHoles) if (Math.abs(h.x - x) < h.mrx + 20) clash = true;
      if (Math.abs(mascotHole.x - x) < mascotHole.mrx + 30) clash = true;
      if (clash) continue;
      flowers.push({ sp: flowerSprites[Math.floor(rnd() * flowerSprites.length)], x: x, y: bottom - 6 - rnd() * 12,
                     ph: rnd() * TAU, sp2: 1 + rnd() * 0.8 });
    }
  }

  // ================================================================== static art: signboards

  function bolt(g, x, y, r) {
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fillStyle = '#b9bec4';
    g.fill();
    g.lineWidth = Math.max(2, r * 0.3);
    g.strokeStyle = INK;
    g.stroke();
    g.beginPath();
    g.arc(x - r * 0.3, y - r * 0.3, r * 0.4, 0, TAU);
    g.fillStyle = 'rgba(255, 255, 255, 0.8)';
    g.fill();
  }

  // Wooden signboard: two posts (their feet go behind the fence), a soft shadow on the meadow,
  // a dark wooden frame with bolts, and planks with grain and knots.
  function buildBoard(sign, seed) {
    const M = 48;
    const w = sign.w, h = sign.h;
    const regionBottom = sign.region.y + sign.region.h;
    const postBottom = regionBottom - sign.y + 4;
    const c = makeCanvas(w + M * 2, Math.max(h, postBottom) + M);
    const g = c.getContext('2d');
    g.translate(M, M);
    const rnd = mulberry32(seed);
    const fw = sign.fw;
    const r = Math.round(Math.min(w, h) * 0.05);

    // posts
    const pw = Math.round(Math.max(30, w * 0.066));
    for (const fx of [0.2, 0.8]) {
      const px = Math.round(w * fx - pw / 2);
      const pg = g.createLinearGradient(px, 0, px + pw, 0);
      pg.addColorStop(0, '#6a3d1a');
      pg.addColorStop(0.35, '#a46d38');
      pg.addColorStop(1, '#5a3214');
      g.fillStyle = pg;
      g.fillRect(px, h - 20, pw, postBottom - h + 20);
      g.lineWidth = 5;
      g.strokeStyle = INK;
      g.strokeRect(px, h - 20, pw, postBottom - h + 20);
      g.strokeStyle = 'rgba(60, 30, 10, 0.45)';
      g.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        const gx = px + pw * (0.25 + 0.25 * i);
        g.beginPath();
        g.moveTo(gx, h);
        g.lineTo(gx + (rnd() - 0.5) * 4, postBottom);
        g.stroke();
      }
    }
    // shadow on the meadow, then the frame
    g.save();
    g.shadowColor = 'rgba(8, 30, 4, 0.5)';
    g.shadowBlur = 34;
    g.shadowOffsetX = 12;
    g.shadowOffsetY = 18;
    rrect(g, 0, 0, w, h, r);
    g.fillStyle = '#7b4a22';
    g.fill();
    g.restore();
    const fg = g.createLinearGradient(0, 0, 0, h);
    fg.addColorStop(0, '#9c6230');
    fg.addColorStop(1, '#6c3d18');
    rrect(g, 0, 0, w, h, r);
    g.fillStyle = fg;
    g.fill();
    // frame grain
    g.save();
    rrect(g, 0, 0, w, h, r);
    g.clip();
    g.strokeStyle = 'rgba(60, 28, 8, 0.35)';
    g.lineWidth = 2;
    for (let i = 0; i < 8; i++) {
      const yy = rnd() * h;
      g.beginPath();
      g.moveTo(0, yy);
      g.bezierCurveTo(w * 0.3, yy + (rnd() - 0.5) * 8, w * 0.6, yy + (rnd() - 0.5) * 8, w, yy + (rnd() - 0.5) * 6);
      g.stroke();
    }
    g.restore();

    // planks
    const ix = fw, iy = fw, iw = w - fw * 2, ih = h - fw * 2, ir = Math.max(6, r - fw * 0.5);
    g.save();
    rrect(g, ix, iy, iw, ih, ir);
    g.clip();
    const n = Math.max(3, Math.round(ih / 84));
    const ph = ih / n;
    for (let i = 0; i < n; i++) {
      const y0 = iy + i * ph;
      g.fillStyle = PLANKS[Math.floor(rnd() * PLANKS.length)];
      g.fillRect(ix, y0, iw, ph + 1);
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(110, 58, 20, 0.26)';
      for (let k = 0; k < 4; k++) {
        const gy = y0 + ph * (0.18 + 0.64 * rnd());
        g.beginPath();
        g.moveTo(ix, gy);
        g.bezierCurveTo(ix + iw * 0.33, gy + (rnd() - 0.5) * 10, ix + iw * 0.66, gy + (rnd() - 0.5) * 10,
          ix + iw, gy + (rnd() - 0.5) * 8);
        g.stroke();
      }
      if (rnd() < 0.7) {
        const kx = ix + iw * (0.1 + 0.8 * rnd()), ky = y0 + ph * (0.35 + 0.3 * rnd());
        for (let ring = 0; ring < 3; ring++) {
          g.beginPath();
          g.ellipse(kx, ky, 7 + ring * 6, 3.5 + ring * 3, 0, 0, TAU);
          g.strokeStyle = ring ? 'rgba(110, 58, 20, 0.22)' : 'rgba(90, 45, 15, 0.5)';
          g.stroke();
        }
      }
      g.fillStyle = 'rgba(255, 236, 200, 0.26)';
      g.fillRect(ix, y0 + 2, iw, 3);
      g.fillStyle = 'rgba(70, 32, 8, 0.55)';
      g.fillRect(ix, y0 + ph - 3, iw, 3);
      if (rnd() < 0.6) {
        const jx = ix + iw * (0.15 + 0.7 * rnd());
        g.fillRect(jx, y0, 3, ph);
      }
    }
    // the planks sit a little below the frame: soft inner shadow
    g.lineWidth = 16;
    g.strokeStyle = 'rgba(40, 18, 4, 0.32)';
    rrect(g, ix, iy, iw, ih, ir);
    g.stroke();
    g.restore();
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(40, 18, 4, 0.85)';
    rrect(g, ix, iy, iw, ih, ir);
    g.stroke();
    // bevel highlight and the outline
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255, 214, 160, 0.42)';
    rrect(g, 5, 5, w - 10, h - 10, Math.max(4, r - 4));
    g.stroke();
    g.lineWidth = 7;
    g.strokeStyle = INK;
    rrect(g, 0, 0, w, h, r);
    g.stroke();
    const br = Math.max(5, fw * 0.3);
    bolt(g, fw / 2 + 2, fw / 2 + 2, br);
    bolt(g, w - fw / 2 - 2, fw / 2 + 2, br);
    bolt(g, fw / 2 + 2, h - fw / 2 - 2, br);
    bolt(g, w - fw / 2 - 2, h - fw / 2 - 2, br);
    sign.board = { c: c, x: sign.x - M, y: sign.y - M };
  }

  // A dark panel let into the planks, for numbers and headings.
  function darkPanel(g, x, y, w, h, r) {
    g.save();
    rrect(g, x, y, w, h, r);
    const pg = g.createLinearGradient(0, y, 0, y + h);
    pg.addColorStop(0, '#1c0e05');
    pg.addColorStop(1, '#341c0c');
    g.fillStyle = pg;
    g.fill();
    g.clip();
    const sh = g.createLinearGradient(0, y, 0, y + Math.min(36, h * 0.3));
    sh.addColorStop(0, 'rgba(0, 0, 0, 0.65)');
    sh.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.fillStyle = sh;
    g.fillRect(x, y, w, Math.min(36, h * 0.3));
    g.restore();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255, 222, 170, 0.45)';
    g.beginPath();
    g.moveTo(x + r, y + h + 3);
    g.lineTo(x + w - r, y + h + 3);
    g.stroke();
    rrect(g, x, y, w, h, r);
    g.lineWidth = 5;
    g.strokeStyle = INK;
    g.stroke();
  }

  // A header plaque: dark panel with chunky yellow lettering.
  function plaque(g, x, y, w, h, text, style) {
    darkPanel(g, x, y, w, h, Math.min(22, h * 0.3));
    drawText(g, text, x + w / 2, y + h / 2, h * 0.62, style || STYLE.yellow, 'center', w - h * 0.5, 0.15);
  }

  // ================================================================== the mole (the floor's design units)

  const FACE_UP = 0, FACE_HAPPY = 1;

  function moleGrads(g) {
    const body = g.createRadialGradient(-12, -54, 3, 0, -30, 64);
    body.addColorStop(0, '#bd8752');
    body.addColorStop(0.5, '#8e5a2f');
    body.addColorStop(1, '#68401d');
    const belly = g.createLinearGradient(0, -24, 0, 26);
    belly.addColorStop(0, '#ecbd85');
    belly.addColorStop(1, '#c98f55');
    const hat = g.createLinearGradient(-20, -82, 18, -55);
    hat.addColorStop(0, '#fff27d');
    hat.addColorStop(0.5, '#ffd000');
    hat.addColorStop(1, '#e49e00');
    return { body: body, belly: belly, hat: hat };
  }

  // The floor's mole: brown, pink nose, big eyes, two teeth, whiskers and a yellow hard hat.
  // Origin at the bottom centre of the body; about 104 units tall with the hat.
  function drawMoleFigure(g, gr, face, lx, ly, blink) {
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(-30, 18);
    g.lineTo(-30, -36);
    g.arc(0, -36, 30, Math.PI, 0, false);
    g.lineTo(30, 18);
    g.closePath();
    g.fillStyle = gr.body;
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = INK;
    g.stroke();
    g.beginPath();
    g.ellipse(0, 2, 20, 24, 0, 0, TAU);
    g.fillStyle = gr.belly;
    g.fill();
    g.beginPath();
    g.ellipse(0, -31, 16.5, 11.5, 0, 0, TAU);
    g.fillStyle = '#efc797';
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(42, 20, 7, 0.5)';
    g.stroke();
    g.fillStyle = 'rgba(255, 120, 150, 0.55)';
    g.beginPath();
    g.ellipse(-20, -36, 5, 3.2, 0, 0, TAU);
    g.ellipse(20, -36, 5, 3.2, 0, 0, TAU);
    g.fill();

    if (blink) {
      g.lineWidth = 2.8;
      g.strokeStyle = INK;
      g.beginPath();
      for (let s = -1; s <= 1; s += 2) {
        const x = s * 11;
        g.moveTo(x - 7, -48);
        g.quadraticCurveTo(x, -43.5, x + 7, -48);
      }
      g.stroke();
    } else {
      for (let s = -1; s <= 1; s += 2) {
        const x = s * 11;
        g.beginPath();
        g.ellipse(x, -48, 8.5, 10, 0, 0, TAU);
        g.fillStyle = '#ffffff';
        g.fill();
        g.lineWidth = 2.2;
        g.strokeStyle = INK;
        g.stroke();
        g.beginPath();
        g.arc(x + lx, -47 + ly, 4.9, 0, TAU);
        g.fillStyle = '#1a0d05';
        g.fill();
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.arc(x + lx + 1.8, -49.2 + ly, 1.9, 0, TAU);
        g.fill();
        g.beginPath();
        g.arc(x + lx - 1.5, -44.8 + ly, 0.9, 0, TAU);
        g.fill();
      }
    }

    if (face === FACE_HAPPY) {
      // a big open smile
      g.beginPath();
      g.moveTo(-10.5, -30);
      g.quadraticCurveTo(0, -11, 10.5, -30);
      g.closePath();
      g.fillStyle = '#5a0f14';
      g.fill();
      g.save();
      g.clip();
      g.beginPath();
      g.ellipse(1, -18.5, 6.5, 5, 0, 0, TAU);
      g.fillStyle = '#ff6f8a';
      g.fill();
      g.restore();
      g.lineWidth = 1.8;
      g.strokeStyle = INK;
      g.beginPath();
      g.moveTo(-10.5, -30);
      g.quadraticCurveTo(0, -11, 10.5, -30);
      g.closePath();
      g.stroke();
    } else {
      g.beginPath();
      g.moveTo(-7.5, -30.5);
      g.quadraticCurveTo(-3.8, -26.5, 0, -30.5);
      g.quadraticCurveTo(3.8, -26.5, 7.5, -30.5);
      g.lineWidth = 1.8;
      g.strokeStyle = INK;
      g.stroke();
    }
    g.fillStyle = '#fffdf3';
    g.lineWidth = 1.3;
    g.strokeStyle = INK;
    rrect(g, -4.8, -30, 4.4, 7.5, 1.2);
    g.fill();
    g.stroke();
    rrect(g, 0.4, -30, 4.4, 7.5, 1.2);
    g.fill();
    g.stroke();

    g.beginPath();
    g.ellipse(0, -38, 7.5, 5.6, 0, 0, TAU);
    g.fillStyle = '#ff6f9c';
    g.fill();
    g.lineWidth = 1.6;
    g.strokeStyle = '#7a2340';
    g.stroke();
    g.beginPath();
    g.ellipse(-2.4, -40, 2.6, 1.5, -0.3, 0, TAU);
    g.fillStyle = 'rgba(255, 255, 255, 0.85)';
    g.fill();

    g.lineWidth = 1.4;
    g.strokeStyle = 'rgba(42, 20, 7, 0.8)';
    g.beginPath();
    for (let s = -1; s <= 1; s += 2) {
      g.moveTo(s * 14, -34);
      g.lineTo(s * 33, -39);
      g.moveTo(s * 15, -31);
      g.lineTo(s * 34, -31);
      g.moveTo(s * 14, -28);
      g.lineTo(s * 32, -23);
    }
    g.stroke();

    g.beginPath();
    g.moveTo(-23, -57);
    g.bezierCurveTo(-24, -85, 24, -85, 23, -57);
    g.closePath();
    g.fillStyle = gr.hat;
    g.fill();
    g.beginPath();
    g.moveTo(-4.5, -58);
    g.lineTo(-4.5, -76);
    g.quadraticCurveTo(0, -78.5, 4.5, -76);
    g.lineTo(4.5, -58);
    g.closePath();
    g.fillStyle = '#ffe866';
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(42, 20, 7, 0.7)';
    g.stroke();
    g.beginPath();
    g.moveTo(-23, -57);
    g.bezierCurveTo(-24, -85, 24, -85, 23, -57);
    g.lineWidth = 2.6;
    g.strokeStyle = INK;
    g.stroke();
    rrect(g, -32, -61, 64, 7.5, 3.7);
    g.fillStyle = '#f2b400';
    g.fill();
    g.stroke();
    g.beginPath();
    g.ellipse(-12, -72, 5.5, 3, -0.6, 0, TAU);
    g.fillStyle = 'rgba(255, 255, 255, 0.75)';
    g.fill();
  }

  // Mole sprites (open eyes / blink) at scale s, origin (ox, oy) inside the canvas.
  function moleSprite(s, face, lx, ly, blink) {
    const c = makeCanvas(84 * s, 112 * s);
    const g = c.getContext('2d');
    g.translate(42 * s, 90 * s);
    g.scale(s, s);
    drawMoleFigure(g, moleGrads(g), face, lx, ly, blink);
    return { c: c, ox: 42 * s, oy: 90 * s };
  }

  let mascotOpen = null, mascotBlink = null, peekSprites = null;
  const MOLE = { body: '#8e5a2f', paw: '#d9a370' };

  // ================================================================== other sprites

  const G = {};

  function buildSprites() {
    G.rays = (function () {
      const rr = 620;
      const c = makeCanvas(rr * 2, rr * 2);
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(rr, rr, 0, rr, rr, rr);
      grad.addColorStop(0, 'rgba(255, 236, 120, 0.8)');
      grad.addColorStop(1, 'rgba(255, 236, 120, 0)');
      g.fillStyle = grad;
      for (let i = 0; i < 16; i++) {
        const a = (i * TAU) / 16;
        g.beginPath();
        g.moveTo(rr, rr);
        g.arc(rr, rr, rr, a, a + TAU / 32);
        g.closePath();
        g.fill();
      }
      return c;
    })();
    G.glow = softSprite(255, 230, 90, 128);
    G.redGlow = softSprite(255, 60, 30, 128);
    G.greenGlow = softSprite(120, 255, 90, 128);
    G.star = starPath(5, 0.46);
    const sole = new Path2D();
    sole.ellipse(0, -0.32, 0.38, 0.58, 0, 0, TAU);
    sole.ellipse(0, 0.66, 0.3, 0.32, 0, 0, TAU);
    G.sole = sole;

    // the mascot (big) and the peeking moles (small)
    mascotOpen = moleSprite(mascotS, FACE_HAPPY, -2.2, 3.2, false);
    mascotBlink = moleSprite(mascotS, FACE_HAPPY, 0, 0, true);
    const pk = peekHoles.length ? peekHoles[0].k : 1;
    peekSprites = [
      moleSprite(pk, FACE_UP, 0, 0, false), moleSprite(pk, FACE_UP, -3, 0, false),
      moleSprite(pk, FACE_UP, 3, 0, false), moleSprite(pk, FACE_UP, 0, 0, true),
    ];
    G.trophy = trophySprite(Math.round(L.right.sign.inner.w * 0.5));
  }

  function trophySprite(size) {
    const s = size / 100;
    const c = makeCanvas(size * 1.5, size * 1.5);
    const g = c.getContext('2d');
    g.translate(c.width / 2, c.height * 0.12);
    g.scale(s, s);
    g.lineJoin = 'round';
    const gold = g.createLinearGradient(-40, 0, 40, 0);
    gold.addColorStop(0, '#c98a00');
    gold.addColorStop(0.35, '#ffe46b');
    gold.addColorStop(0.6, '#ffc61a');
    gold.addColorStop(1, '#b97400');
    // handles
    g.lineWidth = 12;
    g.strokeStyle = INK;
    g.beginPath();
    g.ellipse(-42, 26, 16, 20, 0, 0, TAU);
    g.ellipse(42, 26, 16, 20, 0, 0, TAU);
    g.stroke();
    g.lineWidth = 6.5;
    g.strokeStyle = '#ffcf33';
    g.stroke();
    // cup
    g.beginPath();
    g.moveTo(-44, 2);
    g.lineTo(44, 2);
    g.bezierCurveTo(44, 50, 22, 70, 0, 72);
    g.bezierCurveTo(-22, 70, -44, 50, -44, 2);
    g.closePath();
    g.fillStyle = gold;
    g.fill();
    g.lineWidth = 4.5;
    g.strokeStyle = INK;
    g.stroke();
    g.beginPath();
    g.ellipse(0, 2, 44, 9, 0, 0, TAU);
    g.fillStyle = '#ffe98a';
    g.fill();
    g.stroke();
    g.beginPath();
    g.ellipse(0, 3, 36, 5.5, 0, 0, TAU);
    g.fillStyle = '#b97800';
    g.fill();
    // shine and star
    g.beginPath();
    g.ellipse(-24, 30, 6, 18, 0.25, 0, TAU);
    g.fillStyle = 'rgba(255, 255, 255, 0.6)';
    g.fill();
    g.save();
    g.translate(4, 34);
    g.scale(15, 15);
    g.fillStyle = '#fff7c2';
    g.fill(G.star);
    g.lineWidth = 0.18;
    g.strokeStyle = '#a86a00';
    g.stroke(G.star);
    g.restore();
    // stem and base
    g.beginPath();
    g.moveTo(-8, 70);
    g.lineTo(8, 70);
    g.lineTo(12, 96);
    g.lineTo(-12, 96);
    g.closePath();
    g.fillStyle = gold;
    g.fill();
    g.lineWidth = 4.5;
    g.strokeStyle = INK;
    g.stroke();
    rrect(g, -30, 94, 60, 12, 4);
    g.fillStyle = '#ffcf33';
    g.fill();
    g.stroke();
    rrect(g, -38, 106, 76, 26, 5);
    g.fillStyle = '#6a3d1a';
    g.fill();
    g.stroke();
    rrect(g, -22, 112, 44, 13, 3);
    g.fillStyle = '#ffd84a';
    g.fill();
    g.lineWidth = 2;
    g.stroke();
    return { c: c, cx: c.width / 2, cy: c.height * 0.12 + 66 * s };
  }

  // Medals for the top-N rows: the floor's medal, with a highlight.
  function medalSprite(r, colour, label) {
    const c = makeCanvas(r * 2 + 10, r * 2 + 12);
    const g = c.getContext('2d');
    const x = r + 5, y = r + 5;
    g.beginPath();
    g.arc(x + 1, y + 4, r, 0, TAU);
    g.fillStyle = 'rgba(0, 0, 0, 0.45)';
    g.fill();
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fillStyle = colour;
    g.fill();
    g.lineWidth = Math.max(2.5, r * 0.14);
    g.strokeStyle = INK;
    g.stroke();
    g.beginPath();
    g.ellipse(x - r * 0.28, y - r * 0.4, r * 0.42, r * 0.2, -0.45, 0, TAU);
    g.fillStyle = 'rgba(255, 255, 255, 0.5)';
    g.fill();
    const px = r * (label.length > 1 ? 0.98 : 1.16);
    const m = measure(label, px);
    const gh = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    g.font = font(px);
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillStyle = INK;
    g.fillText(label, x, y - gh / 2 + m.actualBoundingBoxAscent);
    return { c: c, cx: x, cy: y };
  }

  // ================================================================== signs: build and per-wall state

  // A sign: what it shows (mode, key), what its content canvas holds (rmode, rkey), and a spare canvas
  // with the content it will need next, rendered ahead (smode, skey; see "render ahead").
  function newWall() {
    return { mode: '', rmode: '', key: 0, rkey: NaN, pop0: -1e9, content: makeCanvas(1, 1), small: null,
             board0: -1e9, spare: makeCanvas(1, 1), smode: '', skey: NaN };
  }
  const W = { left: newWall(), front: newWall(), right: newWall() };

  // per-sign dynamic sprites
  const SP = {
    time: newSprite(), score: newSprite(), combo: newSprite(), count: newSprite(),
    timesUp1: newSprite(), timesUp2: newSprite(), final: newSprite(), rank: newSprite(), rank2: newSprite(),
    hits: newSprite(), misses: newSprite(), best: newSprite(), beFirst: newSprite(), banner: newSprite(),
    comboLabel: null,
  };
  let logo1 = null, logo2 = null;    // bouncing title letters
  let medals = [], youMedals = [], youBlank = null;

  function letterSprites(word, px, style, maxW) {
    let m = measure(word, px);
    const width = m.width;
    if (width > maxW) px *= maxW / width;
    const letters = [];
    let x = 0;
    for (const ch of word) {
      const adv = measure(ch, px).width;
      if (ch !== ' ') {
        const sp = renderSprite(newSprite(), ch, px, style, 0, 0.2);
        sp.x = x + adv / 2;
        letters.push(sp);
      }
      x += adv;
    }
    return { letters: letters, width: x, px: px };
  }

  function buildSigns() {
    buildBoard(L.left.sign, 11);
    buildBoard(L.front.sign, 23);
    buildBoard(L.right.sign, 37);
    buildBoard(L.right.small, 41);
    const fi = L.front.sign.inner;
    logo1 = letterSprites('STOMP', fi.h * 0.24, STYLE.title, fi.w * 0.92);
    logo2 = letterSprites('THE MOLE', fi.h * 0.14, STYLE.white, fi.w * 0.8);
    // the left wall's rows
    const li = L.left.sign.inner;
    const headH = Math.round(li.h * 0.12);
    const colH = Math.round(li.h * 0.045);
    const rowsTop = li.y + headH + colH + Math.round(li.h * 0.02);
    const slots = topN + 1;
    const rowH = Math.min(li.h * 0.1, (li.y + li.h - rowsTop) / slots);
    table.headH = headH;
    table.colH = colH;
    table.rowsTop = rowsTop;
    table.rowH = rowH;
    table.slots = slots;
    const mr = Math.round(rowH * 0.4);
    medals = [];
    youMedals = [];
    for (let i = 1; i <= slots; i++) {
      medals.push(medalSprite(mr, i <= 3 ? MEDALS[i - 1] : '#5aa9ff', String(i)));
      youMedals.push(medalSprite(mr, '#6dff4a', String(i)));
    }
    youBlank = medalSprite(mr, '#c9c9c9', '?');   // not on the table
    G.hiBar = (function () {
      const w = li.w, h = Math.round(rowH * 0.94);
      const c = makeCanvas(w + 40, h + 40);
      const g = c.getContext('2d');
      g.shadowColor = 'rgba(255, 220, 60, 0.95)';
      g.shadowBlur = 24;
      rrect(g, 20, 20, w, h, h * 0.3);
      g.fillStyle = '#ffd21a';
      g.fill();
      g.shadowBlur = 0;
      g.lineWidth = 4;
      g.strokeStyle = INK;
      g.stroke();
      return { c: c, ox: 20, oy: 20 + h / 2 };
    })();
    table.listKey = null;   // re-render the rows at the new size
    table.you.key = null;
  }

  // ================================================================== feed state

  let feed = null;
  let latest = null;           // last state message
  let live = false;            // connected and a state has arrived since
  let phase = '';
  let phaseStart = 0;
  let lastTop = [];            // today's table as last seen (kept while disconnected)
  let haveTop = false;
  const cd = { value: null, t0: -1e9 };
  const fx = {
    scoreT: -1e9, comboT: -1e9, missT: -1e9, warnT: -1e9, hitsT: -1e9, missesT: -1e9, bestT: -1e9,
    bannerT: -1e9, bannerOn: false, rainUntil: -1e9, celebratedHigh: NaN, mascotH: 0,
  };
  const prev = { score: -1, combo: -1, hits: -1, misses: -1, best: -1, first: true };
  let warnOn = false;
  let resultKey = '', resultVersion = 0;   // bumps when the state's result changes
  let skyMood = '';
  let level = 0;
  let levelShown = 0;          // the SPEED needle
  let cloudLevel = 0;          // the walls' cloud drift (eases, so TIME'S UP does not jolt it)
  let progressShown = 0;

  // ------------------------------------------------------------------ the sky (sky.js, or a gradient)

  let sky = null;
  let skyFailures = 0;
  let lastSkyError = 0;
  let ceilingFallback = null;
  let skyDrawn = false;              // sky.js drew the ceiling this frame (else: the plain gradient)
  const wallSkyRGB = [-1, -1, -1];   // the colour G.wallSky was last rendered for
  let wallTint = 0;                  // 0 (day) .. 1: how far the walls' sky is from the day sky

  function skyError(err) {
    const t = performance.now();
    if (t - lastSkyError > 5000) {
      lastSkyError = t;
      console.error('sky.js failed:', err);
    }
    if (++skyFailures > 120) {   // keeps failing: stop calling it, show the plain sky
      console.error('sky.js disabled after repeated errors; the ceiling shows a plain sky');
      sky = null;
    }
  }

  function setMood(m) {
    if (m === skyMood) return;
    skyMood = m;
    if (!sky) return;
    try {
      sky.setMood(m);
    } catch (err) {
      skyError(err);
    }
  }

  function celebrate(kind) {
    if (!sky) return;
    try {
      sky.celebrate(kind);
    } catch (err) {
      skyError(err);
    }
  }

  function buildCeiling() {
    const C = room.ceiling;
    ceilingFallback = makeCanvas(C.w, C.h);
    const g = ceilingFallback.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, C.h);
    for (const s of CEILING_STOPS) grad.addColorStop(s[0], s[1]);
    g.fillStyle = grad;
    g.fillRect(0, 0, C.w, C.h);
    sky = window.Sky && typeof window.Sky.frame === 'function' ? window.Sky : null;
    skyFailures = 0;
    if (sky) {
      try {
        sky.init(ctx, { x: C.x, y: C.y, w: C.w, h: C.h });
        const mood = skyMood || 'day';
        skyMood = '';
        setMood(mood);
      } catch (err) {
        console.error('Sky.init failed; the ceiling shows a plain sky:', err);
        sky = null;
      }
    }
  }

  // ------------------------------------------------------------------ apply the room config

  function applyRoom(rc, source) {
    const r = normRoom(rc);
    const key = JSON.stringify(r) + '|' + topN;
    roomSource = source;
    if (key === roomKey) {
      publishInfo();
      if (TEST) testDirty = true;
      return;
    }
    roomKey = key;
    room = r;
    frameInterval = 1000 / (slow.dropped ? Math.min(30, room.fps) : room.fps);
    slow.windows = 0;
    fitCanvas(true);
    if (TEST) {
      testDirty = true;
      publishInfo();
      return;
    }
    buildLayout();
    buildPanorama();
    buildForeground();
    buildSprites();
    buildSigns();
    computeFrontLayout();
    buildCeiling();
    for (const k in W) {   // re-render every sign's content
      W[k].rkey = NaN;
      W[k].smode = '';
    }
    for (const k in SP) if (SP[k]) SP[k].key = null;
    publishInfo();
  }

  // The canvas is exactly room.width x room.height device pixels at the page's top-left
  // (or fitted to the window with ?preview=1).
  function fitCanvas(resized) {
    if (!room) return;
    if (canvas.width !== room.width || canvas.height !== room.height || resized) {
      if (canvas.width !== room.width) canvas.width = room.width;
      if (canvas.height !== room.height) canvas.height = room.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const dpr = window.devicePixelRatio || 1;
    if (PREVIEW) {
      const s = Math.min(window.innerWidth / room.width, window.innerHeight / room.height);
      canvas.style.width = (room.width * s) + 'px';
      canvas.style.height = (room.height * s) + 'px';
      canvas.style.left = ((window.innerWidth - room.width * s) / 2) + 'px';
      canvas.style.top = ((window.innerHeight - room.height * s) / 2) + 'px';
    } else {
      canvas.style.width = (room.width / dpr) + 'px';
      canvas.style.height = (room.height / dpr) + 'px';
    }
    if (TEST) testDirty = true;
  }

  // Read-only diagnostics for people (and test harnesses) poking at the page.
  function publishInfo() {
    const info = { room: room, source: roomSource, test: TEST, preview: PREVIEW, fps: room ? room.fps : 0,
                   fpsNow: Math.round(1000 / frameInterval), slowPc: slow.dropped };
    if (L) {
      const r = (s) => ({ x: s.x, y: s.y, w: s.w, h: s.h, inner: s.inner });
      info.signs = { left: r(L.left.sign), front: r(L.front.sign), right: r(L.right.sign), rightSmall: r(L.right.small) };
      info.safe = { left: L.left.S, front: L.front.S, right: L.right.S };
      info.fenceTop = L.fenceTop;
      info.mascot = mascotHole ? { x: mascotHole.x, y: mascotHole.y, scale: mascotS } : null;
      info.digits = frontMetrics;
    }
    window.StompRoom = info;
  }

  // ================================================================== the left wall: today's top N

  const table = {
    headH: 0, colH: 0, rowsTop: 0, rowH: 0, slots: 11,
    listKey: null,
    rows: [],          // one per table entry: {score, combo, sp, y, ty, a, ta, pop0}
    you: { on: false, score: -1, slot: 0, rank: 0, sp: newSprite(), y: 0, ty: 0, a: 0, ta: 0, key: null, ranked: false },
    hi: -1,            // highlighted row in results
  };

  function slotY(slot) {
    return table.rowsTop + table.rowH * (slot + 0.5);
  }

  function renderEntryRow(row, i) {
    const li = L.left.sign.inner;
    const rh = table.rowH;
    const x0 = Math.round(rh * 1.05);
    const w = li.w - x0;
    const g = resetCanvas(row.sp.c, w, rh + 8);
    drawText(g, String(row.score), 8, rh / 2, rh * 0.84, i === 0 ? STYLE.yellow : STYLE.white, 'left', w * 0.55, 0.13);
    drawText(g, 'x' + row.combo, w - 14, rh / 2, rh * 0.62, STYLE.orange, 'right', w * 0.35, 0.15);
    row.sp.w = w;
    row.sp.h = rh + 8;
  }

  function renderYouRow(you, ranked) {
    const li = L.left.sign.inner;
    const rh = table.rowH;
    const w = li.w, h = Math.round(rh * 0.92);
    const g = resetCanvas(you.sp.c, w, h + 8);
    rrect(g, 3, 4, w - 6, h - 4, h * 0.32);
    const bg = g.createLinearGradient(0, 4, 0, h);
    if (ranked) {
      bg.addColorStop(0, '#5fd84a');
      bg.addColorStop(1, '#2a9a2c');
    } else {
      bg.addColorStop(0, '#8a8a8a');
      bg.addColorStop(1, '#5a5a5a');
    }
    g.fillStyle = bg;
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = INK;
    g.stroke();
    // the score in the SCORE column, where every other row has its score; "YOU" on the right
    const x0 = Math.round(rh * 1.05);
    const tw = w - x0;
    drawText(g, String(you.score), x0 + 8, h / 2 + 2, rh * 0.8, STYLE.white, 'left', tw * 0.5, 0.14);
    drawText(g, 'YOU', w - 18, h / 2 + 2, rh * 0.58, STYLE.yellow, 'right', tw * 0.4, 0.16);
    you.sp.w = w;
    you.sp.h = h + 8;
  }

  // Rows for the table as the feed says it is now; positions animate towards their slots.
  function updateTable(st, real) {
    const list = lastTop;
    const n = Math.min(topN, list.length);
    const key = JSON.stringify(list.slice(0, n));
    if (key !== table.listKey) {
      const fresh = table.listKey === null;
      table.listKey = key;
      while (table.rows.length > n) table.rows.pop();
      for (let i = 0; i < n; i++) {
        let row = table.rows[i];
        if (!row) {
          row = { score: 0, combo: 0, sp: newSprite(), y: slotY(i), ty: slotY(i), a: 1, ta: 1, pop0: real + i * 60 };
          table.rows[i] = row;
        }
        row.score = list[i].score | 0;
        row.combo = list[i].best_combo | 0;
        renderEntryRow(row, i);
        if (fresh) row.pop0 = real + i * 60;
      }
    }
    // the live "YOU" row: where the current score would rank (ties go below the earlier entry)
    const you = table.you;
    const inPlay = live && phase === 'play' && st;
    const res = live && phase === 'results' && st ? st.result : null;
    let score = -1, ranked = false;
    you.on = false;
    table.hi = -1;
    if (inPlay) {
      score = st.score | 0;
      let k = 1;
      for (let i = 0; i < n; i++) if ((list[i].score | 0) >= score) k++;
      ranked = score > 0 && k <= topN;
      you.on = true;
      you.rank = ranked ? k : 0;
      you.slot = Math.min(k, topN + 1) - 1;
      if (!ranked && score > 0 && k > topN) you.slot = topN;
      if (score === 0) you.slot = Math.min(n, topN);
    } else if (res) {
      if (typeof res.rank === 'number' && res.rank >= 1 && res.rank <= n) {
        table.hi = res.rank - 1;
      } else {
        // not on the table: show the round's score under it
        score = res.score | 0;
        you.on = true;
        you.rank = 0;
        you.slot = Math.min(n, topN);
      }
    }
    if (you.on) {
      const yk = score * 2 + (ranked ? 1 : 0);
      if (you.key !== yk) {
        you.score = score;
        renderYouRow(you, ranked);
        you.key = yk;
      }
      you.ranked = ranked;
      you.ty = slotY(you.slot);
      if (you.a === 0) you.y = you.ty;
      you.ta = 1;
    } else {
      you.ta = 0;
    }
    for (let i = 0; i < table.rows.length; i++) {
      const row = table.rows[i];
      const slot = you.on && you.slot <= i ? i + 1 : i;
      row.ty = slotY(slot);
      row.ta = slot >= topN ? 0.42 : 1;
    }
  }

  // What the left sign's content canvas holds: 'blank' (WAITING...), 'empty' (NO SCORES YET TODAY) or
  // 'rows' (the column heads and row bands; the rows themselves are drawn on top every frame).
  function leftKind(mode, empty) {
    return mode === 'blank' ? 'blank' : empty && mode !== 'live' ? 'empty' : 'rows';
  }

  function renderLeft(c, kind) {
    const li = L.left.sign.inner;
    const g = resetCanvas(c, li.w, li.h);
    plaque(g, 0, 0, li.w, table.headH, topTitle);
    if (kind === 'blank') {
      drawText(g, 'WAITING...', li.w / 2, li.h * 0.5, li.h * 0.08, '#d9c4a0', 'center', li.w * 0.8, 0.14);
    } else if (kind === 'empty') {
      drawText(g, 'NO SCORES', li.w / 2, li.h * 0.36, li.h * 0.07, STYLE.cream, 'center', li.w * 0.9, 0.16);
      drawText(g, 'YET TODAY', li.w / 2, li.h * 0.45, li.h * 0.07, STYLE.cream, 'center', li.w * 0.9, 0.16);
      renderSprite(SP.beFirst, 'BE THE FIRST!', li.h * 0.12, STYLE.yellow, li.w * 0.86, 0.15);
    } else {
      const cy = table.headH + table.colH * 0.62;
      drawText(g, 'SCORE', table.rowH * 1.05 + 8, cy, table.colH * 0.8, '#ffe9c4', 'left', 0, 0.2);
      drawText(g, 'BEST COMBO', li.w - 14, cy, table.colH * 0.8, '#ffe9c4', 'right', 0, 0.2);
      // faint bands behind every other row, so a row reads straight across from far away
      g.fillStyle = 'rgba(70, 34, 10, 0.2)';
      for (let i = 0; i < table.slots; i += 2) {
        rrect(g, 0, table.rowsTop - li.y + table.rowH * i + 2, li.w, table.rowH - 4, table.rowH * 0.3);
        g.fill();
      }
    }
  }

  function drawLeft(real, dt) {
    const wl = L.left, sign = wl.sign, li = sign.inner;
    const w = W.left;
    const mode = !haveTop && !live ? 'blank' : (live && phase === 'play') ? 'live' : (live && phase === 'results') ? 'results' : 'table';
    if (mode !== w.mode) {
      w.mode = mode;
      w.pop0 = real;
      if (mode === 'table') for (let i = 0; i < table.rows.length; i++) table.rows[i].pop0 = real + 120 + i * 60;
    }
    const empty = table.rows.length === 0;
    // the title and size are covered by a rebuild; play, results and the table share one content
    useContent(w, leftKind(mode, empty), 0, renderLeft, null);
    drawBoard(sign.board);
    drawContent(w, li, real);
    if (mode === 'blank') return;
    if (empty && mode !== 'live') {
      const bob = Math.sin(real / 260) * li.h * 0.012;
      const s = 1 + 0.04 * Math.sin(real / 200);
      drawSprite(SP.beFirst, li.x + li.w / 2, li.y + li.h * 0.66 + bob, s);
    }
    // rows
    const follow = Math.min(1, dt * 9);
    const rx = li.x + Math.round(table.rowH * 1.05);
    const mx = li.x + table.rowH * 0.5;
    if (!empty || mode === 'live') {
      const you = table.you;
      const firstFree = table.rows.length + (you.on && you.slot < table.rows.length ? 1 : 0);
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#4a2810';
      for (let slot = firstFree; slot < topN; slot++) {
        if (you.on && you.slot === slot) continue;
        const y = slotY(slot);
        const med = medals[slot];
        ctx.drawImage(med.c, Math.round(mx - med.cx), Math.round(y - med.cy));
        rrect(ctx, rx + 10, y - table.rowH * 0.07, table.rowH * 1.2, table.rowH * 0.14, table.rowH * 0.07);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    const blink = Math.floor(real / 260) % 2 === 0;
    if (table.hi >= 0 && table.hi < table.rows.length) {
      const row = table.rows[table.hi];
      ctx.globalAlpha = blink ? 0.95 : 0.4;
      ctx.drawImage(G.hiBar.c, li.x - G.hiBar.ox, row.y - G.hiBar.oy);
      ctx.globalAlpha = 1;
    }
    for (let i = 0; i < table.rows.length; i++) {
      const row = table.rows[i];
      row.y += (row.ty - row.y) * follow;
      row.a += (row.ta - row.a) * follow;
      const p = clamp01((real - row.pop0) / 300);
      if (p <= 0) continue;
      const s = mode === 'table' ? easeOutBack(p) : 1;
      ctx.globalAlpha = row.a;
      const slot = Math.round((row.ty - table.rowsTop) / table.rowH - 0.5);
      const med = medals[Math.min(medals.length - 1, slot)];
      const hiRow = i === table.hi;
      const ms = s * (hiRow && blink ? 1.12 : 1);
      ctx.drawImage(med.c, mx - med.cx * ms, row.y - med.cy * ms, med.c.width * ms, med.c.height * ms);
      if (s === 1) ctx.drawImage(row.sp.c, rx, Math.round(row.y - (row.sp.h - 8) / 2));
      else ctx.drawImage(row.sp.c, rx, row.y - (row.sp.h - 8) / 2 * s, row.sp.w * s, row.sp.h * s);
    }
    ctx.globalAlpha = 1;
    const you = table.you;
    you.a += (you.ta - you.a) * Math.min(1, dt * 12);
    if (you.a < 0.01) {
      you.a = 0;
      return;
    }
    you.y += (you.ty - you.y) * follow;
    ctx.globalAlpha = you.a;
    const pulse = you.ranked ? 1 + 0.03 * Math.sin(real / 140) : 1;
    const yw = you.sp.w * pulse, yh = you.sp.h * pulse;
    ctx.drawImage(you.sp.c, li.x + li.w / 2 - yw / 2, you.y - (you.sp.h - 8) / 2 * pulse - 4, yw, yh);
    const med = you.rank > 0 ? youMedals[Math.min(youMedals.length - 1, you.rank - 1)] : youBlank;
    ctx.drawImage(med.c, Math.round(mx - med.cx), Math.round(you.y - med.cy));
    ctx.globalAlpha = 1;
  }

  // ================================================================== the front wall: the scoreboard

  const frontMetrics = { timeGlyph: 0, scoreGlyph: 0, timePx: 0, scorePx: 0 };
  const front = { panelH: 0, stripH: 0, digitPx: 0, comboLabelW: 0, labelPx: 0, labelX: 0, labelY: 0, labelRight: 0,
                  lastSecs: -1, dotsX: 0, dotsY: 0, dotR: 0 };

  function frontMode(now, real) {
    if (!live) return 'waiting';
    if (phase === 'attract') return 'attract';
    if (phase === 'countdown') return 'count';
    if (phase === 'play') return cd.value === 'GO' ? 'count' : 'play';
    if (phase === 'results') return now - phaseStart < TIMES_UP_MS ? 'timesup' : 'final';
    return 'waiting';
  }

  // The digit size: about the panel's height, at least 300 px of glyph (DESIGN), but never more than
  // the panel holds with the digits' outline. A big safe_inset leaves the panels too short for 300 px:
  // then the digits shrink to fit (and the console says so) rather than spill over the sign.
  const DIGIT_OUTLINE = 0.07;   // the TIME, SCORE and FINAL SCORE sprites' outline (of the font size)
  function digitGlyph(px) {
    const m = measure('0123456789', px);
    return m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  }

  function frontDigitPx(panelH) {
    const ratio = digitGlyph(100) / 100;
    const room0 = panelH - 8;   // what the glyph and its outline may fill
    let px = Math.floor(Math.min(Math.max(300, panelH - 50), room0 / (1 + DIGIT_OUTLINE / ratio)) / ratio) + 2;
    px = Math.min(px, Math.floor(Math.max(300, panelH - 50) / ratio));
    while (px > 20 && digitGlyph(px) + px * DIGIT_OUTLINE > room0) px--;
    const glyph = Math.round(digitGlyph(px));
    if (glyph < 300) {
      console.warn('room: the front wall\'s digits are ' + glyph + ' px tall (under 300) because the ' +
        'panels are only ' + panelH + ' px at safe_inset ' + room.inset + '; a smaller safe_inset gives them more room');
    }
    return px;
  }

  function frontKey(mode, st) {
    const res = st && st.result;
    return mode === 'attract' ? (lastTop.length ? lastTop[0].score | 0 : 0)
      : mode === 'final' ? (res ? res.best_combo | 0 : st ? st.best_combo | 0 : 0) : 0;
  }

  function renderFront(c, mode, st) {
    const fi = L.front.sign.inner;
    const g = resetCanvas(c, fi.w, fi.h);
    if (mode === 'waiting') {
      stepIcon(g, 1, fi.w / 2, fi.h * 0.16, fi.h * 0.24);
      drawText(g, 'WAITING FOR', fi.w / 2, fi.h * 0.41, fi.h * 0.13, STYLE.white, 'center', fi.w * 0.94, 0.15);
      const px = drawText(g, 'THE GAME', fi.w / 2 - fi.w * 0.08, fi.h * 0.58, fi.h * 0.13, STYLE.white, 'center', fi.w * 0.76, 0.15);
      const m = measure('THE GAME', px);
      front.dotR = px * 0.1;
      front.dotsX = fi.x + fi.w / 2 - fi.w * 0.08 + (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) / 2 + front.dotR * 2.4;
      front.dotsY = fi.y + fi.h * 0.58 + (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / 2 - front.dotR;
      drawText(g, 'Start the game on the floor PC.', fi.w / 2, fi.h * 0.79, fi.h * 0.05, STYLE.cream, 'center', fi.w * 0.92, 0.18);
      drawText(g, 'Connecting to ' + (feed ? feed.url : '?'), fi.w / 2, fi.h * 0.89, fi.h * 0.036, '#e9d3ad', 'center', fi.w * 0.92, 0.2);
      return;
    }
    if (mode === 'attract') {
      // the logo letters bounce on top (drawn every frame); the how-to-play steps stay still
      const top = fi.h * 0.415;
      plaque(g, fi.w * 0.16, top, fi.w * 0.68, fi.h * 0.095, 'HOW TO PLAY');
      const best = lastTop.length ? lastTop[0].score | 0 : 0;
      const steps = [
        ['STAND ON THE', 'START PAD'],
        ['STOMP THE MOLES', 'WHEN THEY POP UP'],
        ["BEAT TODAY'S", best > 0 ? 'TOP SCORE: ' + best : 'TOP SCORE'],
      ];
      const sy = top + fi.h * 0.115;
      const sh = (fi.h - sy) / 3;
      for (let i = 0; i < 3; i++) {
        const cy = sy + sh * (i + 0.5);
        const br = sh * 0.34;
        g.beginPath();
        g.arc(br + 6, cy + 3, br, 0, TAU);
        g.fillStyle = 'rgba(0, 0, 0, 0.4)';
        g.fill();
        g.beginPath();
        g.arc(br + 4, cy, br, 0, TAU);
        g.fillStyle = '#ffd21a';
        g.fill();
        g.lineWidth = 5;
        g.strokeStyle = INK;
        g.stroke();
        const m = measure(String(i + 1), br * 1.3);
        g.font = font(br * 1.3);
        g.textAlign = 'center';
        g.textBaseline = 'alphabetic';
        g.fillStyle = INK;
        g.fillText(String(i + 1), br + 4, cy - (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / 2 + m.actualBoundingBoxAscent);
        const tx = br * 2 + 30;
        const iconW = sh * 0.95;
        const tw = fi.w - tx - iconW - 16;
        drawText(g, steps[i][0], tx, cy - sh * 0.215, sh * 0.34, STYLE.white, 'left', tw, 0.16);
        drawText(g, steps[i][1], tx, cy + sh * 0.215, sh * 0.34, i === 2 ? STYLE.yellow : STYLE.white, 'left', tw, 0.16);
        stepIcon(g, i, fi.w - iconW / 2 - 4, cy, sh * 0.86);
      }
      return;
    }
    if (mode === 'count' || mode === 'timesup') {
      darkPanel(g, 0, 0, fi.w, fi.h, 30);
      return;
    }
    if (mode === 'play') {
      const ph = front.panelH;
      darkPanel(g, 0, 0, fi.w, ph, 26);
      darkPanel(g, 0, fi.h - ph, fi.w, ph, 26);
      drawText(g, 'TIME', front.labelX, front.labelY, front.labelPx, STYLE.cream, 'left', 0, 0.18);
      drawText(g, 'SCORE', front.labelX, fi.h - ph + front.labelY, front.labelPx, STYLE.cream, 'left', 0, 0.18);
      return;
    }
    if (mode === 'final') {
      const res = st && st.result ? st.result : null;
      plaque(g, fi.w * 0.12, 0, fi.w * 0.76, fi.h * 0.11, 'FINAL SCORE');
      darkPanel(g, 0, fi.h * 0.14, fi.w, front.panelH, 26);
      const best = res ? res.best_combo | 0 : st ? st.best_combo | 0 : 0;
      drawText(g, 'BEST COMBO x' + best, fi.w / 2, fi.h * 0.14 + front.panelH + fi.h * 0.065, fi.h * 0.062, STYLE.cream,
        'center', fi.w * 0.9, 0.18);
    }
  }

  // The little pictures beside the how-to-play steps; size = their height.
  function stepIcon(g, i, x, y, size) {
    const r = size * 0.46;
    g.save();
    g.translate(x, y);
    if (i === 0) {   // the START pad with footprints
      g.beginPath();
      g.arc(0, 0, r, 0, TAU);
      g.fillStyle = 'rgba(0, 0, 0, 0.5)';
      g.fill();
      g.lineWidth = 5;
      g.strokeStyle = INK;
      g.stroke();
      g.setLineDash([10, 7]);
      g.beginPath();
      g.arc(0, 0, r - 7, 0, TAU);
      g.lineWidth = 4;
      g.strokeStyle = '#ffe14a';
      g.stroke();
      g.setLineDash(NO_DASH);
      for (let s = -1; s <= 1; s += 2) {
        g.save();
        g.translate(s * r * 0.26, 0);
        g.rotate(s * 0.12);
        g.scale(s * r * 0.4, r * 0.4);
        g.fillStyle = '#ffffff';
        g.fill(G.sole);
        g.lineWidth = 3 / (r * 0.4);
        g.strokeStyle = INK;
        g.stroke(G.sole);
        g.restore();
      }
    } else if (i === 1) {   // a mole popping out of its mound
      const s = size / 112;
      g.translate(0, 29 * s);
      g.scale(s, s);
      drawMoleFigure(g, moleGrads(g), FACE_UP, 0, 0, false);
      g.beginPath();
      g.ellipse(0, 14, 50, 13, 0, 0, TAU);
      const mg = g.createLinearGradient(0, 2, 0, 27);
      mg.addColorStop(0, '#c48d58');
      mg.addColorStop(1, '#6a4020');
      g.fillStyle = mg;
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = INK;
      g.stroke();
    } else {   // a trophy (its art spans 87% of the sprite's height)
      const t = G.trophy;
      const s = size / (t.c.height * 0.87);
      g.drawImage(t.c, -t.c.width / 2 * s, -t.c.height * 0.555 * s, t.c.width * s, t.c.height * s);
    }
    g.restore();
  }

  function drawFront(now, real, st) {
    const sign = L.front.sign, fi = sign.inner;
    const w = W.front;
    const mode = frontMode(now, real);
    if (mode !== w.mode) {
      w.mode = mode;
      w.pop0 = real;
    }
    w.key = frontKey(mode, st);
    useContent(w, mode, w.key, renderFront, st);
    drawBoard(sign.board);
    drawContent(w, fi, real);
    const cx = fi.x + fi.w / 2;
    if (mode === 'waiting') {
      for (let i = 0; i < 3; i++) {
        const b = Math.max(0, Math.sin(real / 220 - i * 0.9));
        ctx.beginPath();
        ctx.arc(front.dotsX + i * front.dotR * 3, front.dotsY - b * front.dotR * 2.4, front.dotR, 0, TAU);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = front.dotR * 0.5;
        ctx.strokeStyle = INK;
        ctx.stroke();
      }
    } else if (mode === 'attract') {
      drawWord(logo1, cx, fi.y + fi.h * 0.14, real, 0);
      drawWord(logo2, cx, fi.y + fi.h * 0.32, real, 1.3);
    } else if (mode === 'count') {
      drawCountdown(fi, real);
    } else if (mode === 'play') {
      drawPlayNumbers(fi, now, real, st);
    } else if (mode === 'timesup') {
      drawTimesUp(fi, now, real);
    } else if (mode === 'final') {
      drawFinal(fi, now, real, st);
    }
  }

  function drawWord(word, cx, cy, real, phase0) {
    const x0 = cx - word.width / 2;
    const t = real / 1000;
    for (let i = 0; i < word.letters.length; i++) {
      const s = word.letters[i];
      const bounce = Math.sin(t * 3.2 - i * 0.55 + phase0);
      const y = cy + bounce * word.px * 0.04;
      const a = Math.sin(t * 2.3 - i * 0.7 + phase0) * 0.05;
      const sc = 1 + Math.max(0, bounce) * 0.04;
      const c = Math.cos(a) * sc, si = Math.sin(a) * sc;
      ctx.setTransform(c, si, -si, c, x0 + s.x, y);
      ctx.drawImage(s.c, -s.cx, -s.cy);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function drawRays(cx, cy, scale, real, alpha) {
    const s = scale;
    const a = real / 2600;
    const c = Math.cos(a) * s, si = Math.sin(a) * s;
    ctx.globalAlpha = alpha;
    ctx.setTransform(c, si, -si, c, cx, cy);
    ctx.drawImage(G.rays, -G.rays.width / 2, -G.rays.height / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  function clipRect(r) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
  }

  // 3, 2, 1, GO! zooming in like on the floor, clipped to the sign.
  function drawCountdown(fi, real) {
    const v = cd.value;
    if (v === null || v === undefined) return;
    const go = v === 'GO';
    const dur = go ? T.go : T.step;
    const e = real - cd.t0;
    let s = lerp(1.8, 1, easeOutBack(clamp01(e / 300)));
    let a = 1;
    const tail = e - dur * 0.72;
    if (tail > 0) {
      const q = clamp01(tail / (dur * 0.28));
      s *= 1 + 0.3 * q;
      a = 1 - q;
    }
    if (stale(SP.count, go ? -1 : num(v, 0))) {
      if (go) renderSprite(SP.count, 'GO!', fi.h * 0.62, STYLE.green, fi.w * 0.9, 0.12);
      else renderSprite(SP.count, String(v), fi.h * 0.86, STYLE.yellow, fi.w * 0.9, 0.1);
    }
    const cx = fi.x + fi.w / 2, cy = fi.y + fi.h / 2;
    clipRect(fi);
    drawRays(cx, cy, go ? 1.3 * s : 0.9 * s, real, (go ? 0.55 : 0.3) * a);
    ctx.globalAlpha = a;
    drawSprite(SP.count, cx, cy, s);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function popScale(real, t0, amount, ms) {
    const e = (real - t0) / (ms || 260);
    return e >= 1 || e < 0 ? 1 : 1 + amount * Math.sin(e * Math.PI) * (1 - e * 0.3);
  }

  // Centre x for a number in a panel: in the middle, or right of the panel's label.
  function numberX(fi, sp) {
    const lo = fi.x + front.labelRight + 18 + sp.gw / 2, hi = fi.x + fi.w - 18 - sp.gw / 2;
    return Math.min(hi, Math.max(fi.x + fi.w / 2, lo));
  }

  function drawPlayNumbers(fi, now, real, st) {
    const ph = front.panelH;
    let secs;
    if (st && phase === 'play') {
      const left = typeof st.phase_end === 'number' ? st.phase_end - now : num(st.time_left_ms, 0);
      secs = Math.max(0, Math.ceil(Math.min(left, T.play) / 1000));
    } else {
      secs = Math.ceil(T.play / 1000);
    }
    const urgent = phase === 'play' && (warnOn || secs <= T.warn);
    if (urgent && front.lastSecs !== secs) fx.warnT = real;   // a pulse every second, events or not
    front.lastSecs = secs;
    const dpx = front.digitPx;
    const numW = fi.w - front.labelRight - 36;
    if (stale(SP.time, secs * 2 + (urgent ? 1 : 0))) {
      renderSprite(SP.time, String(secs), dpx, urgent ? STYLE.red : STYLE.white, numW, 0.07);
    }
    const tcy = fi.y + ph / 2 + 2;
    if (urgent) {   // the TIME panel glows red and its frame pulses
      const p = clamp01(1 - (real - fx.warnT) / 800);
      ctx.globalAlpha = 0.22 + 0.4 * p;
      ctx.drawImage(G.redGlow, fi.x + fi.w * 0.1, fi.y - ph * 0.2, fi.w * 0.8, ph * 1.4);
      ctx.globalAlpha = 0.45 + 0.55 * p;
      rrect(ctx, fi.x - 4, fi.y - 4, fi.w + 8, ph + 8, 30);
      ctx.lineWidth = 10;
      ctx.strokeStyle = '#ff3b30';
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    drawSprite(SP.time, numberX(fi, SP.time), tcy, urgent ? popScale(real, fx.warnT, 0.07, 380) : 1);

    const score = st ? st.score | 0 : 0;
    if (stale(SP.score, score)) renderSprite(SP.score, String(score), dpx, STYLE.yellow, numW, 0.07);
    drawSprite(SP.score, numberX(fi, SP.score), fi.y + fi.h - ph / 2 + 2, popScale(real, fx.scoreT, 0.1, 300));

    // COMBO between the two panels: pops on a hit, shakes back to x0 on a miss
    const combo = st ? st.combo | 0 : 0;
    const style = combo >= 5 ? STYLE.orange : combo > 0 ? STYLE.yellow : STYLE.grey;
    const sh = front.stripH;
    if (stale(SP.combo, combo)) renderSprite(SP.combo, 'x' + combo, sh * 0.9, style, fi.w * 0.4, 0.14);
    let shake = 0;
    const me = real - fx.missT;
    if (me >= 0 && me < 500) shake = Math.sin(me / 22) * (1 - me / 500) * sh * 0.3;
    const cy = fi.y + ph + sh / 2;
    const lx = fi.x + fi.w / 2 - front.comboLabelW / 2 - SP.combo.gw / 2 - 14;
    ctx.drawImage(SP.comboLabel.c, Math.round(lx - SP.comboLabel.cx), Math.round(cy - SP.comboLabel.cy));
    drawSprite(SP.combo, fi.x + fi.w / 2 + front.comboLabelW / 2 + 14 + shake, cy, popScale(real, fx.comboT, 0.4, 320));
  }

  // The sprites below render one stale sprite per call and return it (null when all are current), so
  // prepareNext can render them ahead, one per frame, and rasterise them.
  function timesUpSprite() {
    const fi = L.front.sign.inner;
    if (stale(SP.timesUp1, 1)) return renderSprite(SP.timesUp1, "TIME'S", fi.h * 0.3, STYLE.red, fi.w * 0.86, 0.12);
    if (stale(SP.timesUp2, 1)) return renderSprite(SP.timesUp2, 'UP!', fi.h * 0.36, STYLE.red, fi.w * 0.86, 0.12);
    return null;
  }

  function finalSprite(res) {
    const fi = L.front.sign.inner;
    const score = res.score | 0;
    if (stale(SP.final, score)) return renderSprite(SP.final, String(score), front.digitPx, STYLE.yellow, fi.w * 0.92, 0.07);
    if (res.new_high) {
      if (stale(SP.rank, -1)) return renderSprite(SP.rank, 'NEW HIGH SCORE!', fi.h * 0.11, STYLE.yellow, fi.w * 0.94, 0.15);
      if (stale(SP.rank2, -1)) return renderSprite(SP.rank2, 'NEW HIGH SCORE!', fi.h * 0.11, STYLE.white, fi.w * 0.94, 0.15);
      return null;
    }
    const rank = typeof res.rank === 'number' ? res.rank : 0;
    if (stale(SP.rank, rank > 0 ? rank : score > 0 ? -2 : -3)) {
      const text = rank > 0 ? '#' + rank + ' TODAY' : score > 0 ? 'NICE ONE!' : 'TRY AGAIN!';
      return renderSprite(SP.rank, text, fi.h * 0.12, STYLE.green, fi.w * 0.9, 0.15);
    }
    return null;
  }

  function finalResult(st) {
    return st && st.result ? st.result : { score: st ? st.score : 0, rank: null, new_high: false };
  }

  function drawTimesUp(fi, now, real) {
    const e = now - phaseStart;
    while (timesUpSprite()) { /* both words */ }
    const s = e < 300 ? lerp(2, 1, easeOutBack(clamp01(e / 300))) : 1 + 0.025 * Math.sin(e / 70);
    const cx = fi.x + fi.w / 2, cy = fi.y + fi.h / 2;
    clipRect(fi);
    drawRays(cx, cy, 1.1, real, 0.4);
    const a = -0.05;
    const c = Math.cos(a) * s, si = Math.sin(a) * s;
    ctx.setTransform(c, si, -si, c, cx, cy);
    drawSprite(SP.timesUp1, 0, -fi.h * 0.17, 1);
    drawSprite(SP.timesUp2, 0, fi.h * 0.2, 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.restore();
  }

  function popIn(e, delay, ms) {
    return easeOutBack(clamp01((e - delay) / (ms || 300)));
  }

  function drawFinal(fi, now, real, st) {
    const res = finalResult(st);
    const e = now - phaseStart - TIMES_UP_MS;
    while (finalSprite(res)) { /* the score and the rank line */ }
    const ps = popIn(e, 80, 340);
    if (ps > 0) {
      const s = lerp(1.7, 1, ps);
      clipRect(fi);
      drawSprite(SP.final, fi.x + fi.w / 2, fi.y + fi.h * 0.14 + front.panelH / 2 + 2, s);
      ctx.restore();
    }
    const rs = popIn(e, 520, 320);
    if (rs <= 0) return;
    const ry = fi.y + fi.h * 0.885;
    if (res.new_high) {
      clipRect(fi);
      drawRays(fi.x + fi.w / 2, ry, 0.7, real, 0.45);
      ctx.restore();
      drawSprite(Math.floor(real / 180) % 2 ? SP.rank2 : SP.rank, fi.x + fi.w / 2, ry, rs * (1 + 0.04 * Math.sin(real / 90)));
    } else {
      drawSprite(SP.rank, fi.x + fi.w / 2, ry, rs);
    }
  }

  // ================================================================== the right wall: mascot, stats, celebrations

  function rightMode(now) {
    if (!live) return 'away';
    if (phase === 'attract') return 'pad';
    if (phase === 'countdown') return 'ready';
    if (phase === 'play') return 'stats';
    if (phase === 'results') {
      if (now - phaseStart < TIMES_UP_MS) return 'stats';
      const res = latest && latest.result;
      return res && res.new_high ? 'trophy' : 'great';
    }
    return 'away';
  }

  function padText(st) {
    const progress = st ? clamp01(num(st.start_progress, 0)) : 0;
    if (progress > 0) return 1;
    if (st && st.start_blocked === true) return 2;
    return 0;
  }

  function rightKey(mode, st) {
    return mode === 'pad' ? padText(st) : mode === 'great' ? resultVersion : 0;
  }

  function renderRight(c, mode, st) {
    const small = mode === 'pad' || mode === 'ready' || mode === 'away';
    const ri = small ? L.right.small.inner : L.right.sign.inner;
    const g = resetCanvas(c, ri.w, ri.h);
    const th = ri.h * 0.2;
    if (small) {
      let l1, l2, style = STYLE.white;
      if (mode === 'ready') {
        l1 = 'GET';
        l2 = 'READY!';
        style = STYLE.green;
      } else if (mode === 'away') {
        l1 = 'BE RIGHT';
        l2 = 'BACK!';
      } else {
        const p = padText(st);
        if (p === 1) {
          l1 = 'GET';
          l2 = 'READY...';
          style = STYLE.green;
        } else if (p === 2) {
          l1 = 'STEP OFF AND';
          l2 = 'BACK ON';
          style = STYLE.orange;
        } else {
          l1 = 'STAND ON THE';
          l2 = 'START PAD!';
        }
      }
      drawText(g, l1, ri.w / 2, ri.h * 0.13, th * 0.78, style, 'center', ri.w * 0.94, 0.15);
      drawText(g, l2, ri.w / 2, ri.h * 0.34, th * 0.95, mode === 'pad' && l2 === 'START PAD!' ? STYLE.yellow : style,
        'center', ri.w * 0.94, 0.15);
      return;
    }
    const hh = Math.round(ri.h * 0.12);
    if (mode === 'stats') {
      plaque(g, 0, 0, ri.w, hh, 'THIS ROUND');
      const labels = ['HITS', 'MISSES', 'BEST COMBO'];
      for (let i = 0; i < 3; i++) {
        const y = statY(i) - ri.y;
        drawText(g, labels[i], 10, y, ri.h * 0.058, STYLE.cream, 'left', ri.w * 0.55, 0.18);
      }
      drawText(g, 'SPEED', 10, statY(3) - ri.y, ri.h * 0.058, STYLE.cream, 'left', 0, 0.18);
      drawGauge(g, gauge.cx - ri.x, gauge.cy - ri.y, gauge.r);
      return;
    }
    if (mode === 'great') {
      const res = st && st.result ? st.result : null;
      const great = res && typeof res.rank === 'number';
      const st0 = st || {};
      // the same words as the floor and the front wall: on the table GREAT JOB!, else NICE ONE! or TRY AGAIN!
      const score = res ? res.score | 0 : st0.score | 0;
      const words = great ? ['GREAT', 'JOB!'] : score > 0 ? ['NICE', 'ONE!'] : ['TRY', 'AGAIN!'];
      drawText(g, words[0], ri.w / 2, ri.h * 0.1, ri.h * 0.13, great ? STYLE.green : STYLE.blue, 'center', ri.w * 0.9, 0.14);
      drawText(g, words[1], ri.w / 2, ri.h * 0.25, ri.h * 0.13, great ? STYLE.green : STYLE.blue, 'center', ri.w * 0.9, 0.14);
      const vals = [
        ['HITS', String(res ? res.hits | 0 : st0.hits | 0), STYLE.green],
        ['MISSES', String(res ? res.misses | 0 : st0.misses | 0), STYLE.red],
        ['BEST COMBO', 'x' + (res ? res.best_combo | 0 : st0.best_combo | 0), STYLE.orange],
      ];
      darkPanel(g, 0, ri.h * 0.38, ri.w, ri.h * 0.6, 24);
      for (let i = 0; i < 3; i++) {
        const y = ri.h * (0.48 + i * 0.19);
        drawText(g, vals[i][0], 26, y, ri.h * 0.058, STYLE.cream, 'left', ri.w * 0.55, 0.18);
        drawText(g, vals[i][1], ri.w - 26, y, ri.h * 0.11, vals[i][2], 'right', ri.w * 0.38, 0.12);
      }
      return;
    }
    if (mode === 'trophy') {
      drawText(g, 'NEW HIGH', ri.w / 2, ri.h * 0.09, ri.h * 0.115, STYLE.yellow, 'center', ri.w * 0.94, 0.14);
      drawText(g, 'SCORE!', ri.w / 2, ri.h * 0.22, ri.h * 0.115, STYLE.yellow, 'center', ri.w * 0.94, 0.14);
      drawText(g, '#1 TODAY', ri.w / 2, ri.h * 0.9, ri.h * 0.09, STYLE.green, 'center', ri.w * 0.9, 0.14);
    }
  }

  const gauge = { cx: 0, cy: 0, r: 0 };

  function statY(i) {
    const ri = L.right.sign.inner;
    const hh = ri.h * 0.12;
    if (i < 3) return ri.y + hh + ri.h * (0.085 + i * 0.125);
    return ri.y + hh + ri.h * 0.445;
  }

  function drawGauge(g, cx, cy, r) {
    // a speedometer: green to red arc with ticks
    g.save();
    g.lineCap = 'butt';
    const foot = r * 0.34;   // room under the arc for SLOW / FAST
    g.beginPath();
    g.arc(cx, cy, r + 14, Math.PI, TAU);
    g.lineTo(cx + r + 14, cy + foot);
    g.quadraticCurveTo(cx + r + 14, cy + foot + 14, cx + r, cy + foot + 14);
    g.lineTo(cx - r, cy + foot + 14);
    g.quadraticCurveTo(cx - r - 14, cy + foot + 14, cx - r - 14, cy + foot);
    g.closePath();
    g.fillStyle = '#24120a';
    g.fill();
    g.lineWidth = 5;
    g.strokeStyle = INK;
    g.stroke();
    const segs = 24;
    for (let i = 0; i < segs; i++) {
      const a0 = Math.PI + (i / segs) * Math.PI, a1 = Math.PI + ((i + 1) / segs) * Math.PI;
      const f = i / (segs - 1);
      const col = f < 0.5 ? 'hsl(' + (120 - f * 2 * 60) + ', 85%, 52%)' : 'hsl(' + (60 - (f - 0.5) * 2 * 60) + ', 92%, 52%)';
      g.beginPath();
      g.arc(cx, cy, r * 0.8, a0, a1 + 0.004);
      g.lineWidth = r * 0.3;
      g.strokeStyle = col;
      g.stroke();
    }
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(42, 20, 7, 0.9)';
    for (let i = 0; i <= 10; i++) {
      const a = Math.PI + (i / 10) * Math.PI;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r * 0.64, cy + Math.sin(a) * r * 0.64);
      g.lineTo(cx + Math.cos(a) * r * (i % 5 ? 0.76 : 0.96), cy + Math.sin(a) * r * (i % 5 ? 0.76 : 0.96));
      g.stroke();
    }
    g.restore();
    drawText(g, 'SLOW', cx - r * 0.95, cy + r * 0.19, r * 0.17, '#bff7a0', 'left', 0, 0.2);
    drawText(g, 'FAST', cx + r * 0.95, cy + r * 0.19, r * 0.17, '#ffb09a', 'right', 0, 0.2);
  }

  function drawNeedle(cx, cy, r, f) {
    const a = Math.PI + clamp01(f) * Math.PI;
    const ex = cx + Math.cos(a) * r * 0.9, ey = cy + Math.sin(a) * r * 0.9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ex, ey);
    ctx.lineWidth = r * 0.1;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.lineWidth = r * 0.055;
    ctx.strokeStyle = '#fff3dc';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.1, 0, TAU);
    ctx.fillStyle = '#ffd21a';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }

  function drawRight(now, real, dt, st) {
    const w = W.right;
    const mode = rightMode(now);
    const small = mode === 'pad' || mode === 'ready' || mode === 'away';
    if (mode !== w.mode) {
      w.mode = mode;
      w.pop0 = real;
      if (small !== w.small) {
        w.small = small;
        w.board0 = real;
      }
    }
    const sign = small ? L.right.small : L.right.sign;
    w.key = rightKey(mode, st);
    useContent(w, mode, w.key, renderRight, st);
    // a new board pops up out of the meadow
    const be = real - w.board0;
    const bs = be < 320 ? lerp(0.88, 1, easeOutBack(clamp01(be / 320))) : 1;
    drawBoard(sign.board, bs);
    drawContent(w, sign.inner, real);
    const ri = sign.inner;
    if (small) {
      const p = st ? clamp01(num(st.start_progress, 0)) : 0;
      progressShown += (p - progressShown) * Math.min(1, dt * 14);
      // land on the value: an exponential ease alone never reaches 0 (it sticks at about 1e-323),
      // and the icon's colours switch on progress > 0
      if (Math.abs(p - progressShown) < 0.004) progressShown = p;
      const blocked = mode === 'pad' && padText(st) === 2;
      const full = mode === 'ready';
      drawPadIcon(ri.x + ri.w / 2, ri.y + ri.h * 0.72, ri.h * 0.25, full ? 1 : mode === 'pad' ? progressShown : 0,
        blocked, mode === 'away', real);
    } else if (mode === 'stats') {
      const hits = st ? st.hits | 0 : 0, misses = st ? st.misses | 0 : 0, best = st ? st.best_combo | 0 : 0;
      const vx = ri.x + ri.w - 22;
      const vp = ri.h * 0.1;
      if (stale(SP.hits, hits)) renderSprite(SP.hits, String(hits), vp, STYLE.green, ri.w * 0.4, 0.12);
      if (stale(SP.misses, misses)) renderSprite(SP.misses, String(misses), vp, STYLE.red, ri.w * 0.4, 0.12);
      if (stale(SP.best, best)) renderSprite(SP.best, 'x' + best, vp, STYLE.orange, ri.w * 0.4, 0.12);
      drawSprite(SP.hits, vx - SP.hits.gw / 2, statY(0), popScale(real, fx.hitsT, 0.3, 280));
      drawSprite(SP.misses, vx - SP.misses.gw / 2, statY(1), popScale(real, fx.missesT, 0.3, 280));
      drawSprite(SP.best, vx - SP.best.gw / 2, statY(2), popScale(real, fx.bestT, 0.3, 280));
      levelShown += (level - levelShown) * Math.min(1, dt * 3);
      drawNeedle(gauge.cx, gauge.cy, gauge.r, levelShown);
    } else if (mode === 'trophy') {
      const t = G.trophy;
      const tx = ri.x + ri.w / 2, ty = ri.y + ri.h * 0.56 + Math.sin(real / 300) * 8;
      clipRect(ri);
      drawRays(tx, ty, 0.75, real, 0.5);
      ctx.restore();
      const s = popIn(real - w.pop0, 150, 420) * (1 + 0.03 * Math.sin(real / 160));
      ctx.drawImage(t.c, tx - t.cx * s, ty - t.cy * s, t.c.width * s, t.c.height * s);
      // twinkles
      for (let i = 0; i < 5; i++) {
        const a = real / 900 + i * 1.3;
        const tw = Math.max(0, Math.sin(real / 210 + i * 2.1));
        if (tw <= 0.05) continue;
        const sx = tx + Math.cos(a) * t.c.width * 0.36 * s, sy = ty - t.c.height * 0.1 + Math.sin(a * 1.3) * t.c.height * 0.26 * s;
        drawStar(sx, sy, 16 * tw + 4, a, '#fff7b0');
      }
    }
  }

  function drawStar(x, y, s, rot, fill) {
    const c = Math.cos(rot) * s, si = Math.sin(rot) * s;
    ctx.setTransform(c, si, -si, c, x, y);
    ctx.fillStyle = fill;
    ctx.fill(G.star);
    ctx.lineWidth = 2.5 / s;
    ctx.strokeStyle = INK;
    ctx.stroke(G.star);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // The floor's START pad: dark disc, a turning dashed yellow ring, two footprints and a
  // green fill ring for start_progress.
  function drawPadIcon(x, y, r, progress, blocked, idle, real) {
    const t = real / 1000;
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    if (!idle) {
      const glow = r * (2.5 + 0.3 * pulse + progress * 0.6);
      ctx.globalAlpha = 0.3 + 0.2 * pulse + progress * 0.4;
      ctx.drawImage(progress > 0 ? G.greenGlow : G.glow, x - glow / 2, y - glow / 2, glow, glow);
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = progress > 0 ? 'rgba(20, 70, 10, 0.85)' : 'rgba(30, 16, 6, 0.8)';
    ctx.fill();
    ctx.lineWidth = r * 0.07;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.setLineDash(DASH);
    ctx.lineDashOffset = idle ? 0 : -t * 40;
    ctx.lineWidth = r * 0.055;
    ctx.strokeStyle = idle ? '#9a8a70' : blocked ? '#ffb74a' : '#ffe14a';
    ctx.beginPath();
    ctx.arc(x, y, r * 0.86, 0, TAU);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    if (progress > 0) {
      ctx.lineCap = 'round';
      ctx.lineWidth = r * 0.16;
      ctx.strokeStyle = INK;
      ctx.beginPath();
      ctx.arc(x, y, r + r * 0.02, -Math.PI / 2, -Math.PI / 2 + TAU * clamp01(progress));
      ctx.stroke();
      ctx.lineWidth = r * 0.1;
      ctx.strokeStyle = '#6dff4a';
      ctx.stroke();
    }
    const fs = r * 0.36 * (1 + progress * 0.15 + 0.04 * pulse);
    for (let s = -1; s <= 1; s += 2) {
      const c = Math.cos(s * 0.12), si = Math.sin(s * 0.12);
      ctx.setTransform(c * s * fs, si * s * fs, -si * fs, c * fs, x + s * r * 0.24, y - r * 0.02);
      ctx.fillStyle = idle ? '#9a8a70' : blocked ? '#ffcf8a' : progress > 0 ? '#9dff7a' : '#ffffff';
      ctx.fill(G.sole);
      ctx.lineWidth = 3 / fs;
      ctx.strokeStyle = INK;
      ctx.stroke(G.sole);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ------------------------------------------------------------------ the mascot

  function mascotPose(mode) {
    return mode === 'pad' ? 0 : mode === 'ready' ? 1 : mode === 'away' ? 2 : -1;
  }

  function drawArm(sx, sy, ex, ey, bend, pointing, pdx, pdy) {
    const mx = (sx + ex) / 2 + bend, my = (sy + ey) / 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.lineWidth = 15;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.lineWidth = 9.5;
    ctx.strokeStyle = MOLE.body;
    ctx.stroke();
    if (pointing) {
      // one long claw pointing the way
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex + pdx * 15, ey + pdy * 15);
      ctx.lineWidth = 8.5;
      ctx.strokeStyle = INK;
      ctx.stroke();
      ctx.lineWidth = 4.5;
      ctx.strokeStyle = MOLE.paw;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(ex, ey, 7.5, 0, TAU);
    ctx.fillStyle = MOLE.paw;
    ctx.fill();
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = INK;
    ctx.stroke();
    if (!pointing) {
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      const a = Math.atan2(ey - sy, ex - sx);
      for (let i = -1; i <= 1; i++) {
        const b = a + i * 0.5;
        ctx.moveTo(ex + Math.cos(b) * 4, ey + Math.sin(b) * 4);
        ctx.lineTo(ex + Math.cos(b) * 9.5, ey + Math.sin(b) * 9.5);
      }
      ctx.stroke();
    }
  }

  function drawMascot(real, dt, mode) {
    if (!mascotHole) return;
    const pose = mascotPose(mode);
    const target = pose >= 0 ? 1 : 0;
    const h0 = fx.mascotH;
    fx.mascotH += (target - fx.mascotH) * Math.min(1, dt * (target ? 5 : 7));
    if (fx.mascotH < 0.004 && target === 0) {
      fx.mascotH = 0;
      return;
    }
    if (h0 === 0 && target === 1) fx.mascotRise = real;
    const hole = mascotHole, S = mascotS;
    const t = real / 1000;
    const rise = easeOutBack(clamp01((real - (fx.mascotRise || 0)) / 520));
    const hgt = target ? rise : fx.mascotH;
    const bob = Math.sin(t * 2.4) * 2.2;
    const baseY = hole.y + hole.ory * 0.6 + (1 - hgt) * (hole.ory * 0.4 + 92 * S) + bob * S;
    const blink = (real % 3100) < 140;
    const sp = blink ? mascotBlink : mascotOpen;
    ctx.save();
    ctx.clip(hole.clip);
    ctx.drawImage(sp.c, hole.x - sp.ox, baseY - sp.oy);
    // arms in design units
    ctx.setTransform(S, 0, 0, S, hole.x, baseY);
    const wave = Math.sin(t * (pose === 1 ? 9 : 6));
    if (pose === 1) {   // cheering: both arms up
      drawArm(-24, -22, -46 - wave * 4, -66, -6, false, 0, 0);
      drawArm(24, -22, 46 - wave * 4, -66, 6, false, 0, 0);
    } else {
      const a = -1.15 + wave * 0.38;
      drawArm(24, -20, 24 + Math.cos(a) * 34, -20 + Math.sin(a) * 34, 6, false, 0, 0);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.restore();
    ctx.drawImage(hole.lip, hole.lipX, hole.lipY);
    if (pose === 2) {   // waiting: the other paw rests on the rim
      ctx.setTransform(S, 0, 0, S, hole.x, baseY);
      drawArm(-24, -18, -30, 0, -6, false, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    if (pose === 0) {
      // pointing down at the START pad (in front of the mound's rim)
      ctx.setTransform(S, 0, 0, S, hole.x, baseY);
      const p = Math.sin(t * 5) * 2;
      drawArm(-24, -18, -47, -6 + p, -8, true, -0.12, 1);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (pose === 0 && hgt > 0.6) {   // a bouncing arrow beside him
        const ax = hole.x - 84 * S, ay = hole.y - 40 * S + Math.abs(Math.sin(t * 3.4)) * 5 * S;
        drawArrowDown(ax, ay, 30 * S);
      }
    }
  }

  function drawArrowDown(x, y, s) {
    ctx.beginPath();
    ctx.moveTo(x - s * 0.22, y - s);
    ctx.lineTo(x + s * 0.22, y - s);
    ctx.lineTo(x + s * 0.22, y - s * 0.1);
    ctx.lineTo(x + s * 0.5, y - s * 0.1);
    ctx.lineTo(x, y + s * 0.5);
    ctx.lineTo(x - s * 0.5, y - s * 0.1);
    ctx.lineTo(x - s * 0.22, y - s * 0.1);
    ctx.closePath();
    ctx.fillStyle = '#ffd21a';
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(4, s * 0.09);
    ctx.strokeStyle = INK;
    ctx.stroke();
  }

  // ------------------------------------------------------------------ peeking moles (attract, cosmetic)

  const peeks = [];
  for (let i = 0; i < MAX_PEEKS; i++) peeks.push({ on: false, hole: null, t0: 0, dur: 0, seed: 0 });
  let nextPeekAt = 0;

  function updatePeeks(real, allowed) {
    for (let i = 0; i < peeks.length; i++) {
      const p = peeks[i];
      if (p.on && real - p.t0 > p.dur) p.on = false;
    }
    if (!allowed || real < nextPeekAt || !peekHoles.length) return;
    nextPeekAt = real + 1800 + Math.random() * 2600;
    let slot = null;
    for (let i = 0; i < peeks.length; i++) if (!peeks[i].on) slot = peeks[i];
    if (!slot) return;
    for (let tries = 0; tries < 6; tries++) {
      const h = peekHoles[Math.floor(Math.random() * peekHoles.length)];
      let busy = false;
      for (let i = 0; i < peeks.length; i++) if (peeks[i].on && peeks[i].hole === h) busy = true;
      if (busy) continue;
      slot.on = true;
      slot.hole = h;
      slot.t0 = real;
      slot.dur = 1800 + Math.random() * 1400;
      slot.seed = Math.random() * 100;
      return;
    }
  }

  function drawPeeks(real) {
    for (let i = 0; i < peeks.length; i++) {
      const p = peeks[i];
      if (!p.on) continue;
      const h = p.hole;
      const e = real - p.t0;
      const top = 0.78;
      let hgt;
      if (e < 280) hgt = top * easeOutBack(e / 280);
      else if (e > p.dur - 260) hgt = top * (1 - easeInQuad(clamp01((e - (p.dur - 260)) / 260)));
      else hgt = top;
      if (hgt <= 0.003) continue;
      const look = Math.sin(e / 330 + p.seed);
      const blink = (e + p.seed * 13) % 1900 < 120;
      const sp = blink ? peekSprites[3] : look > 0.3 ? peekSprites[2] : look < -0.3 ? peekSprites[1] : peekSprites[0];
      const base = h.y + h.ory * 0.6 + (1 - hgt) * (h.ory * 0.4 + 84 * h.k);
      ctx.save();
      ctx.clip(h.clip);
      ctx.drawImage(sp.c, h.x - sp.ox, base - sp.oy);
      ctx.restore();
      ctx.drawImage(h.lip, h.lipX, h.lipY);
    }
  }

  // ------------------------------------------------------------------ banners and confetti

  function renderRibbon(sp, text, maxW) {
    // the whole ribbon (text, ends and tails) fits maxW
    let p = Math.round(maxW * 0.15);
    let m = measure(text, p);
    let gw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    while (gw + p * 3.2 + 24 > maxW && p > 10) {
      p *= 0.95;
      m = measure(text, p);
      gw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    }
    const bh = Math.round(p * 1.55), bw = Math.round(gw + p * 1.3), tail = Math.round(bh * 0.55);
    const w = bw + tail * 2 + 20, h = bh + 40;
    const g = resetCanvas(sp.c, w, h);
    const x0 = tail + 10, y0 = 14;
    g.lineJoin = 'round';
    // folded tails
    for (let s = -1; s <= 1; s += 2) {
      const ex = s < 0 ? x0 + 18 : x0 + bw - 18;
      const ox = s < 0 ? 10 : w - 10;
      g.beginPath();
      g.moveTo(ex, y0 + bh * 0.28);
      g.lineTo(ox, y0 + bh * 0.28);
      g.lineTo(ox + s * -tail * 0.45, y0 + bh * 0.28 + (bh * 0.72) / 2 + 6);
      g.lineTo(ox, y0 + bh + 10);
      g.lineTo(ex, y0 + bh + 10);
      g.closePath();
      g.fillStyle = '#a51d14';
      g.fill();
      g.lineWidth = 6;
      g.strokeStyle = INK;
      g.stroke();
    }
    rrect(g, x0, y0, bw, bh, 12);
    const rg = g.createLinearGradient(0, y0, 0, y0 + bh);
    rg.addColorStop(0, '#ff6a52');
    rg.addColorStop(1, '#d42a1d');
    g.fillStyle = rg;
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = INK;
    g.stroke();
    g.fillStyle = 'rgba(255, 255, 255, 0.28)';
    g.fillRect(x0 + 10, y0 + 8, bw - 20, 6);
    drawText(g, text, x0 + bw / 2, y0 + bh / 2, p, STYLE.yellow, 'center', 0, 0.15);
    sp.w = w;
    sp.h = h;
    sp.cx = w / 2;
    sp.cy = y0 + bh / 2;
  }

  // The ribbon's centre: over the SPEED meter, not over the HITS / MISSES / BEST COMBO rows.
  function bannerY() {
    return gauge.cy - gauge.r * 0.45;
  }

  function fireBanner(text, real) {
    renderRibbon(SP.banner, text, L.right.S.x2 - L.right.S.x);
    fx.bannerOn = true;
    fx.bannerT = real;
    const R = L.right.sign;
    confettiBurst(R.x + R.w / 2, bannerY(), 70, 900);
  }

  function drawBanner(real) {
    if (!fx.bannerOn) return;
    const e = real - fx.bannerT;
    if (e > BANNER_MS) {
      fx.bannerOn = false;
      return;
    }
    const R = L.right.sign;
    const cx = R.x + R.w / 2, cy = bannerY();
    let s = e < 280 ? lerp(0.3, 1, easeOutBack(e / 280)) : 1 + 0.03 * Math.sin(e / 70);
    let a = 1;
    if (e > BANNER_MS - 300) {
      const q = (e - (BANNER_MS - 300)) / 300;
      s *= 1 - 0.6 * easeInQuad(q);
      a = 1 - q;
    }
    clipRect(R);   // the rays stay on the signboard
    drawRays(cx, cy, 0.85 * s, real, 0.55 * a);
    ctx.restore();
    const S = L.right.S;
    ctx.save();
    ctx.beginPath();
    ctx.rect(S.x, S.y, S.x2 - S.x, S.y2 - S.y);
    ctx.clip();
    const rot = -0.05 + 0.025 * Math.sin(e / 120);
    const c = Math.cos(rot) * s, si = Math.sin(rot) * s;
    ctx.globalAlpha = a;
    ctx.setTransform(c, si, -si, c, cx, cy);
    ctx.drawImage(SP.banner.c, -SP.banner.cx, -SP.banner.cy);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  const confetti = [];
  for (let i = 0; i < MAX_CONFETTI; i++) {
    confetti.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, rot: 0, vr: 0, flip: 0, vf: 0, w: 10, h: 18, c: 0, age: 0, life: 1, sway: 0 });
  }
  let confettiCursor = 0, rainCarry = 0;

  function spawnConfetti(x, y, vx, vy, life) {
    let p = null;
    for (let i = 0; i < MAX_CONFETTI; i++) {
      const q = confetti[(confettiCursor + i) % MAX_CONFETTI];
      if (!q.on) {
        p = q;
        confettiCursor = (confettiCursor + i + 1) % MAX_CONFETTI;
        break;
      }
    }
    if (!p) {   // pool full: recycle the next one
      p = confetti[confettiCursor];
      confettiCursor = (confettiCursor + 1) % MAX_CONFETTI;
    }
    p.on = true;
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.rot = Math.random() * TAU;
    p.vr = (Math.random() - 0.5) * 9;
    p.flip = Math.random() * TAU;
    p.vf = 5 + Math.random() * 7;
    p.w = 12 + Math.random() * 8;
    p.h = 20 + Math.random() * 10;
    p.c = Math.floor(Math.random() * CONFETTI_COLOURS.length);
    p.age = 0;
    p.life = life;
    p.sway = Math.random() * TAU;
  }

  function confettiBurst(x, y, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
      const v = speed * (0.35 + Math.random() * 0.65);
      spawnConfetti(x, y, Math.cos(a) * v, Math.sin(a) * v, 2.4 + Math.random() * 1.4);
    }
  }

  function updateConfetti(dt, real) {
    if (real < fx.rainUntil) {
      const b = L.box;
      rainCarry += dt * 70;
      while (rainCarry >= 1) {
        rainCarry -= 1;
        spawnConfetti(b.x + Math.random() * b.w, b.y - 30, (Math.random() - 0.5) * 80, 60 + Math.random() * 120,
          6 + Math.random() * 2);
      }
    }
    for (let i = 0; i < MAX_CONFETTI; i++) {
      const p = confetti[i];
      if (!p.on) continue;
      p.age += dt;
      if (p.age >= p.life || p.y > L.box.y + L.box.h + 40) {
        p.on = false;
        continue;
      }
      p.vy = Math.min(p.vy + 520 * dt, 230);
      p.vx *= 1 - 1.6 * dt;
      p.x += (p.vx + Math.sin(p.age * 3 + p.sway) * 50) * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      p.flip += p.vf * dt;
    }
  }

  function drawConfetti() {
    for (let col = 0; col < CONFETTI_COLOURS.length; col++) {
      let any = false;
      for (let i = 0; i < MAX_CONFETTI; i++) {
        const p = confetti[i];
        if (!p.on || p.c !== col) continue;
        if (!any) {
          ctx.fillStyle = CONFETTI_COLOURS[col];
          any = true;
        }
        const f = Math.cos(p.flip);
        const c = Math.cos(p.rot), s = Math.sin(p.rot);
        ctx.setTransform(c, s, -s * f, c * f, p.x, p.y);
        ctx.globalAlpha = p.life - p.age < 0.5 ? (p.life - p.age) / 0.5 : 1;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ render ahead
  //
  // A sign's content is rendered again when what it shows changes. The first time a freshly rendered
  // canvas is drawn on the page, the browser rasterises it right there (and new font sizes are measured
  // for the first time): on a slow PC that stalled the walls for 70-240 ms at TIME'S UP, at FINAL SCORE
  // and on the way back to attract, with several signs at once. So in the quiet frames before a switch,
  // prepareNext renders what each sign will show next into its spare canvas (one sign or sprite per
  // frame) and rasterises it there; at the switch, useContent swaps the canvases instead of rendering.

  const flushCtx = makeCanvas(1, 1).getContext('2d');
  let contentChanges = 0;   // signs whose content changed this frame (rendered or swapped in)
  let preparedAt = -1e9;    // when prepareNext last did something (performance.now() ms)
  const PREPARE_GAP_MS = 120;   // so a slow PC drops single frames, not several in a row

  // Rasterise a canvas now (drawing it anywhere takes a snapshot of it), then drop the 1 px copy.
  function flushCanvas(c) {
    flushCtx.drawImage(c, 0, 0, 1, 1, 0, 0, 1, 1);
    flushCtx.clearRect(0, 0, 1, 1);
  }

  // Make w.content hold (mode, key): the spare canvas if it was rendered ahead, else render now.
  function useContent(w, mode, key, render, st) {
    if (w.rmode === mode && w.rkey === key) return;
    if (w.smode === mode && w.skey === key) {
      const c = w.content;
      w.content = w.spare;
      w.spare = c;
      w.smode = '';
    } else {
      render(w.content, mode, st);
    }
    contentChanges++;
    w.rmode = mode;
    w.rkey = key;
  }

  // Render (mode, key) ahead into w's spare canvas, unless it is there or showing already.
  function prepare(w, mode, key, render, st) {
    if ((w.rmode === mode && w.rkey === key) || (w.smode === mode && w.skey === key)) return false;
    preparedAt = performance.now();
    render(w.spare, mode, st);
    flushCanvas(w.spare);
    w.smode = mode;
    w.skey = key;
    return true;
  }

  function warm(sp) {
    if (!sp) return false;
    preparedAt = performance.now();
    flushCanvas(sp.c);
    return true;
  }

  // One thing at a time (PREPARE_GAP_MS apart), only in a frame where no sign changed (that frame has work
  // enough), and away from the moments that animate most (the first moments of a countdown, of play, of
  // TIME'S UP and of FINAL SCORE).
  function prepareNext(now, real) {
    if (contentChanges > 0 || !live || !latest || real - preparedAt < PREPARE_GAP_MS) return;
    const st = latest;
    const e = now - phaseStart;
    if (phase === 'countdown') {
      if (e < 300) return;
      // GO: the right wall's stats; after GO: the front's TIME and SCORE panels
      if (prepare(W.right, 'stats', 0, renderRight, st)) return;
      prepare(W.front, 'play', 0, renderFront, st);
    } else if (phase === 'play') {
      if (e < T.go + 1500) return;
      // TIME'S UP: the front's dark panel and its two words, the left wall if its content will change
      if (prepare(W.front, 'timesup', 0, renderFront, st)) return;
      if (warm(timesUpSprite())) return;
      if (num(st.time_left_ms, T.play) < 5000) prepare(W.left, leftKind('results', table.rows.length === 0), 0, renderLeft, st);
    } else if (phase === 'results' && e < TIMES_UP_MS) {
      if (e < 400) return;
      // FINAL SCORE on the front, the trophy or the round's stats on the right
      if (prepare(W.front, 'final', frontKey('final', st), renderFront, st)) return;
      if (warm(finalSprite(finalResult(st)))) return;
      const rm = st.result && st.result.new_high ? 'trophy' : 'great';
      prepare(W.right, rm, rightKey(rm, st), renderRight, st);
    } else if (phase === 'results') {
      if (e < TIMES_UP_MS + 2000) return;
      // back to attract: HOW TO PLAY (with today's new top score), the START pad sign, the table
      if (prepare(W.front, 'attract', frontKey('attract', st), renderFront, st)) return;
      if (prepare(W.right, 'pad', 0, renderRight, null)) return;
      prepare(W.left, leftKind('table', table.rows.length === 0), 0, renderLeft, st);
    }
  }

  // ------------------------------------------------------------------ shared sign drawing

  function drawBoard(board, s) {
    if (s === undefined || s === 1) {
      ctx.drawImage(board.c, board.x, board.y);
      return;
    }
    // scaled about the bottom centre of the board (it grows out of the ground)
    const w = board.c.width, h = board.c.height;
    const ax = board.x + w / 2, ay = board.y + h;
    ctx.drawImage(board.c, ax - (w / 2) * s, ay - h * s, w * s, h * s);
  }

  // A sign's cached content, popping in for a moment after its mode changed.
  function drawContent(w, r, real) {
    const e = real - w.pop0;
    if (e >= POP_MS || e < 0) {
      ctx.drawImage(w.content, r.x, r.y);
      return;
    }
    const p = e / POP_MS;
    const s = lerp(0.9, 1, easeOutBack(p));
    ctx.globalAlpha = clamp01(p * 2.2);
    const cw = r.w * s, ch = r.h * s;
    ctx.drawImage(w.content, r.x + (r.w - cw) / 2, r.y + (r.h - ch) / 2, cw, ch);
    ctx.globalAlpha = 1;
  }

  // ================================================================== feed handlers

  function onHello(msg) {
    const c = msg.config || {};
    const r = c.round || {};
    T.step = num(r.countdown_step_ms, 1000);
    T.go = num(r.go_ms, 800);
    T.play = num(r.play_ms, 60000);
    T.warn = num(r.time_warning_s, 10);
    T.results = num(r.results_ms, 8000);
    topN = Math.max(1, Math.min(20, Math.round(num((c.highscores || {}).size, 10))));
    topTitle = "TODAY'S TOP " + topN;
    const hasRoom = c.room && typeof c.room === 'object';
    applyRoom(hasRoom ? c.room : null, hasRoom ? 'game' : 'defaults-no-room');
    if (TEST) testDirty = true;
  }

  function enterPhase(p, st, real) {
    phase = p;
    if (p === 'play' || p === 'countdown') fx.bannerOn = false;
    if (p === 'play') warnOn = false;
    if (p !== 'results') fx.celebratedHigh = NaN;
    if (p === 'attract') nextPeekAt = real + 1200;
  }

  function onState(msg) {
    const real = performance.now();
    latest = msg;
    live = true;
    if (msg.phase !== phase) enterPhase(msg.phase, msg, real);
    phaseStart = num(msg.phase_start, phaseStart);
    level = phase === 'play' ? clamp01(num(msg.level, 0)) : 0;
    if (Array.isArray(msg.highscores)) {
      lastTop = msg.highscores;
      haveTop = true;
    }
    const rk = msg.result ? JSON.stringify(msg.result) : '';
    if (rk !== resultKey) {
      resultKey = rk;
      resultVersion++;
    }
    const cdv = msg.countdown === undefined ? null : msg.countdown;
    if (cdv !== cd.value) {
      cd.value = cdv;
      cd.t0 = real;
    }
    // pops and shakes from what changed (works for a page that missed the events too)
    const score = msg.score | 0, combo = msg.combo | 0, hits = msg.hits | 0, misses = msg.misses | 0, best = msg.best_combo | 0;
    if (!prev.first) {
      if (score > prev.score) fx.scoreT = real;
      if (combo > prev.combo) fx.comboT = real;
      if (hits > prev.hits) fx.hitsT = real;
      if (misses > prev.misses) {
        fx.missesT = real;
        fx.missT = real;
      }
      if (best > prev.best) fx.bestT = real;
    }
    prev.first = false;
    prev.score = score;
    prev.combo = combo;
    prev.hits = hits;
    prev.misses = misses;
    prev.best = best;
    // the ceiling's mood
    let mood = 'day';
    if (phase === 'play') {
      const left = num(msg.time_left_ms, T.play);
      if (warnOn || left <= T.warn * 1000) mood = 'warming';
    } else if (phase === 'results') {
      mood = 'sunset';
    }
    setMood(mood);
    if (L) updateTable(msg, real);
  }

  function onEvent(msg) {
    const real = performance.now();
    switch (msg.name) {
      case 'countdown':
        if (msg.value !== cd.value) {
          cd.value = msg.value;
          cd.t0 = real;
        }
        if (msg.value === 'GO') celebrate('go');
        break;
      case 'hit':
        fx.scoreT = real;
        fx.comboT = real;
        fx.hitsT = real;
        break;
      case 'escaped':
      case 'empty_stomp':
        fx.missT = real;
        fx.missesT = real;
        break;
      case 'combo':
        if (L) fireBanner('COMBO x' + (msg.combo | 0) + '!', real);
        celebrate('combo');
        break;
      case 'time_warning':
        warnOn = true;
        fx.warnT = real;
        setMood('warming');
        break;
      case 'round_end':
        setMood('sunset');
        celebrate('timesup');
        break;
      case 'attract':
        setMood('day');
        break;
      default:
        break;
    }
  }

  function onStatus(connected) {
    if (connected) return;   // the walls go live with the first state message
    live = false;
    latest = null;
    phase = '';
    prev.first = true;
    fx.bannerOn = false;
    cd.value = null;
    setMood('day');
    if (L) updateTable(null, performance.now());
  }

  // ================================================================== frame

  function drawCeiling(real, dtMs) {
    const C = room.ceiling;
    ctx.save();
    ctx.beginPath();
    ctx.rect(C.x, C.y, C.w, C.h);
    ctx.clip();
    let drawn = false;
    if (sky) {
      try {
        sky.frame(real, dtMs, level);
        drawn = true;
        skyFailures = 0;
      } catch (err) {
        skyError(err);
      }
    }
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    skyDrawn = drawn;
    if (!drawn) ctx.drawImage(ceilingFallback, C.x, C.y);
  }

  // The walls' sky: the ceiling's bottom-edge colour at the top, lighter towards the hills.
  // Re-rendered only when that colour changes: while the sky warms or cools.
  function updateWallSky() {
    let hz = DAY_HORIZON;
    if (sky && skyDrawn && typeof sky.horizon === 'function') {
      try {
        const h = sky.horizon();
        if (h && h.length >= 3 && h[0] >= 0 && h[1] >= 0 && h[2] >= 0) hz = h;
      } catch (err) {
        skyError(err);
      }
    }
    if (hz[0] === wallSkyRGB[0] && hz[1] === wallSkyRGB[1] && hz[2] === wallSkyRGB[2]) return;
    wallSkyRGB[0] = hz[0];
    wallSkyRGB[1] = hz[1];
    wallSkyRGB[2] = hz[2];
    const c = G.wallSky;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, c.height);
    const lo = (v) => Math.round(v + (255 - v) * SKY_LIGHTEN);
    grad.addColorStop(0, 'rgb(' + hz[0] + ',' + hz[1] + ',' + hz[2] + ')');
    grad.addColorStop(1, 'rgb(' + lo(hz[0]) + ',' + lo(hz[1]) + ',' + lo(hz[2]) + ')');
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    const d = Math.abs(hz[0] - DAY_HORIZON[0]) + Math.abs(hz[1] - DAY_HORIZON[1]) + Math.abs(hz[2] - DAY_HORIZON[2]);
    wallTint = clamp01(d / 160);
  }

  function drawWallsBack(real, dt) {
    const b = L.box;
    updateWallSky();
    ctx.drawImage(G.wallSky, b.x, b.y);
    // Clouds drift slowly across the wall skies, behind the trees, a little faster as the round
    // speeds up. The drift is added up frame by frame (dt), and its speed follows the level with
    // easing: a position of uptime x speed would make every cloud jump whenever the speed changes
    // (each state message in play, and at TIME'S UP), more so the longer the page has been open.
    cloudLevel += (level - cloudLevel) * Math.min(1, dt * 1.2);
    const drift = dt * (1 + cloudLevel * 1.5);
    for (let i = 0; i < clouds.length; i++) {
      const c = clouds[i];
      const span = b.w + c.sp.width * c.s;
      c.pos = (c.pos + drift * c.speed) % span;
      ctx.drawImage(c.sp, c.pos + b.x - c.sp.width * c.s, c.y, c.sp.width * c.s, c.sp.height * c.s);
    }
    // a warm sky tints the clouds too (the sky itself stays the same: same colour over it)
    if (wallTint > 0.02) {
      ctx.globalAlpha = 0.45 * wallTint;
      ctx.drawImage(G.wallSky, 0, 0, b.w, cloudBand, b.x, b.y, b.w, cloudBand);
      ctx.globalAlpha = 1;
    }
    if (L.tiled) {
      ctx.drawImage(pano, b.x, b.y);
    } else {
      for (let i = 0; i < 3; i++) {
        const R = L.walls[i];
        ctx.drawImage(pano, R.x - b.x, R.y - b.y, R.w, R.h, R.x, R.y, R.w, R.h);
      }
    }
  }

  function drawFlowers(real) {
    const t = real / 1000;
    for (let i = 0; i < flowers.length; i++) {
      const f = flowers[i];
      const a = Math.sin(t * f.sp2 + f.ph) * 0.14;
      const c = Math.cos(a), s = Math.sin(a);
      ctx.setTransform(c, s, -s, c, f.x, f.y);
      ctx.drawImage(f.sp.c, -f.sp.ax, -f.sp.ay);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function drawFrame(real, dt) {
    const now = feed ? feed.serverNow() : real;
    const st = live ? latest : null;
    contentChanges = 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    drawCeiling(real, dt * 1000);

    ctx.save();
    if (L.tiled) {
      ctx.beginPath();
      ctx.rect(L.box.x, L.box.y, L.box.w, L.box.h);
      ctx.clip();
    } else {
      ctx.clip(L.wallClip);
    }
    drawWallsBack(real, dt);
    drawLeft(real, dt);
    drawFront(now, real, st);
    drawRight(now, real, dt, st);
    ctx.drawImage(fore, L.box.x, foreY);
    updatePeeks(real, live && phase === 'attract');
    drawPeeks(real);
    drawMascot(real, dt, W.right.mode);
    drawFlowers(real);
    // new high score: confetti rain on every wall once "NEW HIGH SCORE!" shows
    if (live && phase === 'results' && st && st.result && st.result.new_high &&
        fx.celebratedHigh !== phaseStart && now - phaseStart >= TIMES_UP_MS && now - phaseStart < T.results) {
      fx.celebratedHigh = phaseStart;
      fx.rainUntil = real + RAIN_MS;
      const R = L.right.sign;
      confettiBurst(R.x + R.w / 2, R.y + R.h * 0.5, 90, 1100);
      celebrate('highscore');
    }
    updateConfetti(dt, real);
    drawConfetti();
    drawBanner(real);   // over its own confetti burst, so the lettering stays clean
    ctx.restore();
    prepareNext(now, real);
  }

  // ================================================================== test pattern (?test=1)

  let testDirty = true;
  let helloSeen = false;
  const startedAt = performance.now();
  const TEST_COLOURS = { ceiling: '#1d64c4', left: '#b8352a', front: '#1c8a38', right: '#7a3cc2' };
  const TEST_NAMES = { ceiling: 'CEILING', left: 'LEFT WALL', front: 'FRONT WALL', right: 'RIGHT WALL' };

  function labelBox(text, x, y, px, align, fg) {
    ctx.font = font(px);
    const w = ctx.measureText(text).width;
    const bx = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
    ctx.fillRect(bx - px * 0.3, y - px * 0.65, w + px * 0.6, px * 1.3);
    ctx.fillStyle = fg || '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx, y + px * 0.04);
  }

  function arrow(x, y, dx, dy, len, col) {
    // a thick arrow from (x, y) pointing along (dx, dy)
    const px = -dy, py = dx;
    const hw = len * 0.22, sw = len * 0.09, hl = len * 0.4;
    ctx.beginPath();
    ctx.moveTo(x + px * sw, y + py * sw);
    ctx.lineTo(x + dx * (len - hl) + px * sw, y + dy * (len - hl) + py * sw);
    ctx.lineTo(x + dx * (len - hl) + px * hw, y + dy * (len - hl) + py * hw);
    ctx.lineTo(x + dx * len, y + dy * len);
    ctx.lineTo(x + dx * (len - hl) - px * hw, y + dy * (len - hl) - py * hw);
    ctx.lineTo(x + dx * (len - hl) - px * sw, y + dy * (len - hl) - py * sw);
    ctx.lineTo(x - px * sw, y - py * sw);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000000';
    ctx.stroke();
  }

  // The name of the region touching edge `side` of R ('left', 'right', 'top', 'bottom').
  function neighbour(name, R, side) {
    const names = ['ceiling', 'left', 'front', 'right'];
    for (const n of names) {
      if (n === name) continue;
      const Q = room[n];
      const vOverlap = Q.y < R.y + R.h && R.y < Q.y + Q.h;
      const hOverlap = Q.x < R.x + R.w && R.x < Q.x + Q.w;
      if (side === 'left' && vOverlap && Math.abs(Q.x + Q.w - R.x) <= 2) return n;
      if (side === 'right' && vOverlap && Math.abs(R.x + R.w - Q.x) <= 2) return n;
      if (side === 'top' && hOverlap && Math.abs(Q.y + Q.h - R.y) <= 2) return n;
      if (side === 'bottom' && hOverlap && Math.abs(R.y + R.h - Q.y) <= 2) return n;
    }
    return null;
  }

  function drawTestPattern(real) {
    const Wd = room.width, Hd = room.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.setLineDash(NO_DASH);
    // hatched grey everywhere; the regions cover it
    if (!G.hatch) {
      const c = makeCanvas(32, 32);
      const g = c.getContext('2d');
      g.fillStyle = '#3c3c3c';
      g.fillRect(0, 0, 32, 32);
      g.strokeStyle = '#8a8a8a';
      g.lineWidth = 6;
      g.beginPath();
      g.moveTo(-8, 40);
      g.lineTo(40, -8);
      g.moveTo(-8, 8);
      g.lineTo(8, -8);
      g.moveTo(24, 40);
      g.lineTo(40, 24);
      g.stroke();
      G.hatch = ctx.createPattern(c, 'repeat');
    }
    ctx.fillStyle = G.hatch;
    ctx.fillRect(0, 0, Wd, Hd);

    const names = ['ceiling', 'left', 'front', 'right'];
    for (const n of names) {
      const R = room[n];
      ctx.save();
      ctx.beginPath();
      ctx.rect(R.x, R.y, R.w, R.h);
      ctx.clip();
      ctx.fillStyle = TEST_COLOURS[n];
      ctx.fillRect(R.x, R.y, R.w, R.h);
      const cx = R.x + R.w / 2, cy = R.y + R.h / 2;
      const big = Math.max(28, Math.min(110, R.w / 8));
      const ny = cy + big * 2.2;
      // a wall's neighbour labels: side by side at ny, or one above and one below the arrows when
      // the wall is too narrow for both (two "NO NEIGHBOUR"s need about 830 px)
      let lN = null, rN = null, lText = '', rText = '', stack = false;
      if (n !== 'ceiling') {
        lN = neighbour(n, R, 'left');
        rN = neighbour(n, R, 'right');
        lText = lN ? TEST_NAMES[lN] : 'NO NEIGHBOUR';
        rText = rN ? TEST_NAMES[rN] : 'NO NEIGHBOUR';
        ctx.font = font(26);
        const wl = ctx.measureText(lText).width, wr = ctx.measureText(rText).width;
        stack = R.x + 170 + wl + 30 > R.x + R.w - 170 - wr;
      }
      // 100 px grid in division coordinates; brighter every 200
      for (let gx = Math.ceil(R.x / 100) * 100; gx < R.x + R.w; gx += 100) {
        ctx.fillStyle = gx % 200 === 0 ? 'rgba(255, 255, 255, 0.55)' : 'rgba(255, 255, 255, 0.25)';
        ctx.fillRect(gx - 1, R.y, 2, R.h);
      }
      for (let gy = Math.ceil(R.y / 100) * 100; gy < R.y + R.h; gy += 100) {
        ctx.fillStyle = gy % 200 === 0 ? 'rgba(255, 255, 255, 0.55)' : 'rgba(255, 255, 255, 0.25)';
        ctx.fillRect(R.x, gy - 1, R.w, 2);
      }
      ctx.font = font(20);
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      for (let gx = Math.ceil(R.x / 200) * 200; gx < R.x + R.w; gx += 200) {
        for (let gy = Math.ceil(R.y / 200) * 200; gy < R.y + R.h; gy += 200) {
          if (gx - R.x < 30 || gy - R.y < 30 || gy + 34 > R.y + R.h) continue;
          if (Math.abs(gy - (cy - big * 0.2)) < big * 1.6) continue;              // name and geometry
          if (n !== 'ceiling' && Math.abs(gy + 16 - ny) < (stack ? 78 : 44)) continue;   // neighbour arrows
          if (n === 'ceiling' && gy > R.y + R.h - 260 && Math.abs(gx - cx) < 300) continue;   // arrow down
          if (n === 'front' && gy < R.y + 240 && Math.abs(gx - cx) < 260) continue;           // arrow up
          const s = gx + ',' + gy;
          const tw = ctx.measureText(s).width;
          ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
          ctx.fillRect(gx + 4, gy + 4, tw + 8, 26);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(s, gx + 8, gy + 7);
        }
      }
      // safe_inset frame
      if (room.inset > 0) {
        ctx.setLineDash(DASH);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.strokeRect(R.x + room.inset + 1.5, R.y + room.inset + 1.5, R.w - room.inset * 2 - 3, R.h - room.inset * 2 - 3);
        ctx.setLineDash(NO_DASH);
        labelBox('safe_inset ' + room.inset, R.x + room.inset + 14, R.y + room.inset + 26, 20, 'left', '#ffffff');
      }
      // bright 4 px border on the region's outermost pixels
      ctx.fillStyle = '#ffff00';
      ctx.fillRect(R.x, R.y, R.w, 4);
      ctx.fillRect(R.x, R.y + R.h - 4, R.w, 4);
      ctx.fillRect(R.x, R.y, 4, R.h);
      ctx.fillRect(R.x + R.w - 4, R.y, 4, R.h);
      // corner markers with the corner pixel's coordinates
      const L1 = Math.min(90, R.w / 4, R.h / 4), T1 = 12;
      const corners = [[R.x, R.y, 1, 1], [R.x + R.w, R.y, -1, 1], [R.x, R.y + R.h, 1, -1], [R.x + R.w, R.y + R.h, -1, -1]];
      for (const c of corners) {
        const cx = c[2] > 0 ? c[0] : c[0] - T1, cy = c[3] > 0 ? c[1] : c[1] - T1;
        const hx = c[2] > 0 ? c[0] : c[0] - L1, vy = c[3] > 0 ? c[1] : c[1] - L1;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(hx, cy, L1, T1);
        ctx.fillRect(cx, vy, T1, L1);
        ctx.fillStyle = '#ff00ff';
        ctx.fillRect(c[2] > 0 ? c[0] : c[0] - 6, c[3] > 0 ? c[1] : c[1] - 6, 6, 6);
        const px = c[2] > 0 ? c[0] : c[0] - 1, py = c[3] > 0 ? c[1] : c[1] - 1;
        labelBox('(' + px + ',' + py + ')', c[0] + c[2] * (T1 + 16), c[1] + c[3] * (L1 + 22), 22,
          c[2] > 0 ? 'left' : 'right', '#ffffff');
      }
      // name and geometry
      labelBox(TEST_NAMES[n], cx, cy - big * 0.9, big, 'center', '#ffffff');
      labelBox('x ' + R.x + '   y ' + R.y + '   w ' + R.w + '   h ' + R.h, cx, cy + big * 0.35, big * 0.42, 'center', '#ffff66');
      labelBox('pixels x ' + R.x + '..' + (R.x + R.w - 1) + ',  y ' + R.y + '..' + (R.y + R.h - 1), cx, cy + big * 0.95,
        big * 0.32, 'center', '#ffffff');
      // neighbours
      if (n === 'ceiling') {
        const below = neighbour(n, R, 'bottom');
        const ay = R.y + R.h - 20;
        arrow(cx, ay - 150, 0, 1, 130, '#ffff00');
        labelBox((below ? TEST_NAMES[below] : 'NOTHING') + ' BELOW', cx, ay - 190, 34, 'center', '#ffff66');
      } else {
        const tN = neighbour(n, R, 'top');
        arrow(R.x + 150, ny, -1, 0, 110, lN ? '#ffff00' : '#9a9a9a');
        labelBox(lText, R.x + 170, stack ? ny - 34 : ny, 26, 'left', lN ? '#ffff66' : '#cccccc');
        arrow(R.x + R.w - 150, ny, 1, 0, 110, rN ? '#ffff00' : '#9a9a9a');
        labelBox(rText, R.x + R.w - 170, stack ? ny + 34 : ny, 26, 'right', rN ? '#ffff66' : '#cccccc');
        if (tN) {
          arrow(cx, R.y + 170, 0, -1, 110, '#ffff00');
          labelBox(TEST_NAMES[tN] + ' ABOVE', cx, R.y + 200, 26, 'center', '#ffff66');
        }
      }
      ctx.restore();
    }
    // the bottom of the 2600 x 1800 sample content: rows below it may not show
    if (Hd > CONTENT_BOTTOM) {
      ctx.setLineDash(DASH);
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#ff3030';
      ctx.beginPath();
      ctx.moveTo(0, CONTENT_BOTTOM - 2);
      ctx.lineTo(Wd, CONTENT_BOTTOM - 2);
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
      labelBox('y ' + CONTENT_BOTTOM + ': bottom of the 2600 x 1800 sample content (below: last ' + (Hd - CONTENT_BOTTOM) +
        ' rows of the division)', Wd / 2, CONTENT_BOTTOM - 34, 22, 'center', '#ff8080');
    }
    // info box
    const waited = real - startedAt;
    let src;
    if (roomSource === 'game') src = 'Regions: from the game (hello.config.room)';
    else if (roomSource === 'defaults-no-room') src = 'Regions: DEFAULTS (the game sent no room config)';
    else if (waited >= NO_HELLO_MS) src = 'Regions: DEFAULTS (no hello from the game within 3 s)';
    else src = 'Regions: waiting for the game\'s hello... ' + Math.ceil((NO_HELLO_MS - waited) / 1000) + ' s';
    const lines = [
      'STOMP THE MOLE - WALL TEST PATTERN',
      src,
      'Division ' + Wd + ' x ' + Hd + ' at the top-left; safe_inset ' + room.inset + ', fps ' + room.fps,
      'Screen ' + window.screen.width + ' x ' + window.screen.height + ', window ' + window.innerWidth + ' x ' +
        window.innerHeight + ', devicePixelRatio ' + (window.devicePixelRatio || 1),
      'Feed ' + (feed ? feed.url : '?') + (feed && feed.connected ? ' (connected)' : ' (not connected)'),
      'Hatched grey = outside every region: it should not light up.',
    ];
    let px = 24;
    ctx.font = font(px);
    let bw = 0;
    for (const l of lines) bw = Math.max(bw, ctx.measureText(l).width);
    // keep the box in the hatched corner above the left wall when there is one
    const room0 = room.left.y > 200 ? Math.min(room.ceiling.x, 2000) - 88 : 1200;
    if (bw > room0) {
      px = Math.max(12, Math.floor(px * room0 / bw));
      ctx.font = font(px);
      bw = 0;
      for (const l of lines) bw = Math.max(bw, ctx.measureText(l).width);
    }
    const bx = 24, by = 24;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(bx, by, bw + 40, lines.length * px * 1.5 + 30);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx + 1, by + 1, bw + 38, lines.length * px * 1.5 + 28);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillStyle = i === 0 ? '#ffff66' : i === 1 && roomSource !== 'game' ? '#ff9a6a' : '#ffffff';
      ctx.fillText(lines[i], bx + 20, by + 18 + i * px * 1.5);
    }
  }

  // ================================================================== loop

  let lastDrawn = -1e9;
  let lastError = 0;

  // A wall PC too slow for room.fps (CPU or GPU) shows frames late, juddering between 60 and 30.
  // When more than SLOW_LATE of the frames in a SLOW_WINDOW_MS window come late, the page draws at
  // 30 fps from then on (until it is reloaded), which is steady. Not with ?fps=N (the operator chose).
  const SLOW_WINDOW_MS = 3000;
  const SLOW_LATE = 0.15;
  const slow = { t0: 0, n: 0, late: 0, windows: 0, dropped: false };

  function watchFrameRate(real, iv) {
    if (slow.dropped || FPS_PARAM > 0 || !room || room.fps <= 30 || TEST) return;
    if (iv > 250) {   // a stall (tab hidden, page busy loading): start the window again
      slow.t0 = real;
      slow.n = slow.late = 0;
      return;
    }
    slow.n++;
    if (iv > frameInterval * 1.5) slow.late++;
    if (real - slow.t0 < SLOW_WINDOW_MS) return;
    // the first window after a (re)build includes the caches being drawn: skip it
    if (++slow.windows > 1 && slow.n >= 20 && slow.late > slow.n * SLOW_LATE) {
      slow.dropped = true;
      frameInterval = 1000 / 30;
      console.warn('room: ' + slow.late + ' of ' + slow.n + ' frames came late at ' + room.fps +
        ' fps; drawing at 30 fps from now on (set room.fps to 30 to start there)');
      publishInfo();
    }
    slow.t0 = real;
    slow.n = slow.late = 0;
  }

  function frame() {
    requestAnimationFrame(frame);
    const real = performance.now();
    if (real - lastDrawn < frameInterval - 3) return;
    const dt = Math.min(0.1, Math.max(0, (real - lastDrawn) / 1000));
    watchFrameRate(real, real - lastDrawn);
    lastDrawn = real;
    try {
      if (TEST) {
        if (!helloSeen && roomSource === 'defaults' && real - startedAt < NO_HELLO_MS + 1000) testDirty = true;
        if (testDirty) {
          testDirty = false;
          drawTestPattern(real);
        }
      } else {
        drawFrame(real, dt);
      }
    } catch (err) {
      if (real - lastError > 5000) {
        lastError = real;
        console.error('room frame failed:', err);
      }
      for (let i = 0; i < 16; i++) ctx.restore();   // unwind any save() the error skipped
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }
  }

  // ================================================================== start

  function computeFrontLayout() {
    const fi = L.front.sign.inner;
    front.stripH = Math.round(Math.max(72, fi.h * 0.105));
    front.panelH = Math.floor((fi.h - front.stripH) / 2);
    front.digitPx = frontDigitPx(front.panelH);
    const m = measure('0123456789', front.digitPx);
    frontMetrics.timePx = front.digitPx;
    frontMetrics.scorePx = front.digitPx;
    frontMetrics.timeGlyph = Math.round(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent);
    frontMetrics.scoreGlyph = frontMetrics.timeGlyph;
    SP.comboLabel = renderSprite(newSprite(), 'COMBO', front.stripH * 0.5, STYLE.cream, 0, 0.2);
    front.labelPx = Math.round(Math.max(30, front.panelH * 0.13));
    front.labelX = Math.round(front.panelH * 0.06);
    front.labelY = Math.round(front.panelH * 0.1);
    front.labelRight = front.labelX + Math.ceil(measure('SCORE', front.labelPx).width);
    front.comboLabelW = SP.comboLabel.gw;
    // the right wall's gauge
    const ri = L.right.sign.inner;
    gauge.r = Math.round(Math.min(ri.w * 0.4, ri.h * 0.25));
    gauge.cx = ri.x + ri.w / 2;
    gauge.cy = Math.round(ri.y + ri.h - gauge.r * 0.34 - 22);
  }

  window.addEventListener('resize', () => fitCanvas(false));
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  if (PREVIEW) document.body.style.cursor = 'default';

  feed = window.StompFeed.connect({
    onHello: function (msg) {
      helloSeen = true;
      onHello(msg);
    },
    onState: function (msg) {
      if (!TEST) onState(msg);
    },
    onEvent: function (msg) {
      if (!TEST) onEvent(msg);
    },
    onStatus: function (c) {
      if (TEST) {
        testDirty = true;
        return;
      }
      onStatus(c);
    },
  });
  // Only the real wall page counts as the walls ("room"): the floor hides its HUD while one is
  // connected. The test pattern does not show the game, and a preview (scaled to a normal monitor)
  // is not on the LEDs, so they report other roles and the floor keeps its HUD.
  feed.sendClient(TEST ? 'room-test' : PREVIEW ? 'room-preview' : 'room', 'none');

  applyRoom(null, 'defaults');
  requestAnimationFrame(frame);
})();
