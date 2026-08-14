// "camping in the woods" — an ASCII campfire.
//
// A heat field is seeded along a bed near the bottom and propagated upward with
// cooling and drift, the way the old Doom fire did it. Every cell then picks a
// glyph by how hot it is and a colour off the palette, so the character density
// and the colour carry the same signal — which is what makes ASCII fire read as
// fire rather than as coloured text.

import { stage, featherMask } from './stage.js';

// Sparse to dense. Heat picks a position in this ramp, so hotter cells are
// literally made of more ink.
const RAMP = " .'`^\",:;Il!i~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";

// Their palette, cold to hot. The gradient is the point here, so it's sampled
// at 24 levels rather than the 12 stops.
const STOPS = [
  [0.0, 0x12, 0x0b, 0x08],
  [0.08, 0x36, 0x13, 0x0e],
  [0.18, 0x5f, 0x16, 0x0e],
  [0.28, 0x84, 0x15, 0x0b],
  [0.38, 0xb0, 0x18, 0x0a],
  [0.48, 0xc8, 0x1e, 0x0a],
  [0.56, 0xe4, 0x23, 0x08],
  [0.64, 0xf5, 0x2d, 0x08],
  [0.72, 0xf2, 0x3f, 0x0d],
  [0.8, 0xf6, 0x53, 0x0f],
  [0.88, 0xf8, 0x6a, 0x12],
  [1.0, 0xf7, 0x99, 0x1c],
];

const LEVELS = 24;
const CELL_W = 5; // px — tiny and dense, as asked
const CELL_H = 8;
const BED_Y = 0.79; // where the fire sits; everything below is ground
const BED_HALF = 0.086; // half-width of the burning wood — small, it's a campfire
const FLAME_HALF = 0.112; // half-width at the flame's widest point
const FLAME_H = 0.42; // how far up the stage the dense mass reaches
const WISP_H = 0.55; // wisps carry on above it, as a fraction of FLAME_H
const EMBER_MAX = 130;
const SIM_HZ = 17; // how fast the glyphs churn

function paletteAt(t) {
  const v = t < 0 ? 0 : t > 1 ? 1 : t;
  let i = 0;
  while (i < STOPS.length - 2 && v > STOPS[i + 1][0]) i++;
  const [t0, r0, g0, b0] = STOPS[i];
  const [t1, r1, g1, b1] = STOPS[i + 1];
  const k = (v - t0) / (t1 - t0 || 1);

  const r = r0 + (r1 - r0) * k;
  const g = g0 + (g1 - g0) * k;
  const b = b0 + (b1 - b0) * k;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

export function createFire(section) {
  const canvas = section.querySelector('canvas.fg');
  const ctx = canvas.getContext('2d');

  let w = 0;
  let h = 0;
  let dpr = 1;
  let mask = null;

  let cols = 0;
  let rows = 0;
  let heat = new Float32Array(0);
  let bedRow = 0;
  let flameSpan = 1;

  const colours = Array.from({ length: LEVELS }, (_, i) => paletteAt(i / (LEVELS - 1)));

  // every glyph in every colour, rendered once
  const atlas = document.createElement('canvas');
  const atlasCtx = atlas.getContext('2d');
  let tileW = 0;
  let tileH = 0;

  function buildAtlas() {
    tileW = Math.ceil(CELL_W * dpr);
    tileH = Math.ceil(CELL_H * dpr);
    atlas.width = tileW * RAMP.length;
    atlas.height = tileH * colours.length;

    atlasCtx.setTransform(1, 0, 0, 1, 0, 0);
    atlasCtx.clearRect(0, 0, atlas.width, atlas.height);
    atlasCtx.textBaseline = 'top';
    atlasCtx.font = `${(CELL_H - 1) * dpr}px 'JetBrains Mono', monospace`;

    for (let l = 0; l < colours.length; l++) {
      atlasCtx.fillStyle = colours[l];
      for (let r = 0; r < RAMP.length; r++) {
        atlasCtx.fillText(RAMP[r], r * tileW, l * tileH);
      }
    }
  }

  const embers = [];
  let running = false;
  let rafId = 0;
  let last = performance.now();
  let acc = 0;

  function resize() {
    // this piece runs nearly full-bleed
    w = stage.fullW;
    h = stage.fullH;
    dpr = stage.dpr;

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    cols = Math.max(8, Math.floor(w / CELL_W));
    rows = Math.max(8, Math.floor(h / CELL_H));
    heat = new Float32Array(cols * rows);
    bedRow = Math.min(rows - 2, Math.floor(rows * BED_Y));
    flameSpan = Math.max(4, rows * FLAME_H);

    mask = featherMask(w, h, stage.fullFeather, stage.radius);
    buildAtlas();
    embers.length = 0;
  }

  /** How hard the wood burns at this column. Narrow — this is the fuel, not the flame. */
  function bedProfile(x) {
    const mid = cols / 2;
    const half = cols * BED_HALF;
    const d = Math.abs(x - mid) / half;
    if (d >= 1) return 0;
    return Math.pow(Math.cos((d * Math.PI) / 2), 1.3);
  }

  /**
   * The flame's silhouette at height t (0 at the wood, 1 at the top of the mass).
   *
   * A flat bed propagating straight up gives a wall of fire, which reads as the
   * forest floor alight. A campfire is a rounded mass instead: pinched where it
   * meets the wood, swelling out low, then domed over rather than drawn to a
   * point — with thin wisps breaking away above. Past t = 1 a narrow channel
   * stays open for whatever heat survives to climb.
   */
  function flameHalfAt(t) {
    if (t >= 1) {
      const over = (t - 1) / WISP_H;
      return over >= 1 ? 0 : cols * FLAME_HALF * 0.2 * (1 - over) ** 1.5;
    }
    // swells to its full width in the bottom third, then domes over
    const swell = 0.72 + 0.28 * Math.sin((Math.PI / 2) * Math.min(1, t / 0.3));
    const dome = Math.pow(1 - Math.pow(t, 2.4), 0.5);
    return cols * FLAME_HALF * swell * dome;
  }

  let bedPhase = 0;
  let glowPulse = 0.5;

  function seedBed() {
    bedPhase += 0.013;
    let total = 0;
    const y = bedRow * cols;
    for (let x = 0; x < cols; x++) {
      const p = bedProfile(x);
      if (p <= 0) {
        heat[y + x] = 0;
        continue;
      }
      // three sines at odd ratios, drifting at different rates — the beats
      // between them wander the hot spots around so tongues form and die
      const u = x / cols;
      const tongue =
        0.62 +
        0.2 * Math.sin(u * 27 + bedPhase * 1.7) +
        0.13 * Math.sin(u * 61 - bedPhase * 2.3) +
        0.09 * Math.sin(u * 13 + bedPhase * 0.9);

      const flicker = 0.82 + Math.random() * 0.36;
      const v = Math.min(1.45, p * tongue * flicker * 2.3);
      heat[y + x] = v;
      total += v;
    }
    // eased, so the glow swells with the fire rather than strobing with it
    glowPulse += (Math.min(1, total / (cols * BED_HALF * 2.4)) - glowPulse) * 0.08;
  }

  function step() {
    seedBed();

    // pull heat upward from the row below, losing a little on the way
    for (let y = 0; y < bedRow; y++) {
      const row = y * cols;
      const below = (y + 1) * cols;
      const t = (bedRow - y) / flameSpan;
      const allowed = flameHalfAt(t);
      // Clipping can only take width away, and heat only ever climbs one column
      // at a time — so on its own the mass is however wide the wood is, all the
      // way up. Biasing the drift outward low and inward high is what actually
      // makes it flare off the bed and gather back into a dome.
      const spread = t < 0.3 ? 0.5 : -0.3;
      const bias = Math.abs(spread);

      for (let x = 0; x < cols; x++) {
        // drift sideways at random, which is what gives flames their wander
        let dx = ((Math.random() * 3) | 0) - 1;
        if (Math.random() < bias) {
          // source from the inside to move heat out, from the outside to pull in
          const dir = x < cols / 2 ? -1 : 1;
          dx = spread > 0 ? -dir : dir;
        }
        const sx = Math.min(cols - 1, Math.max(0, x + dx));

        const src = heat[below + sx];
        // taller flames cool faster, so the tip tapers instead of squaring off
        const cool = 0.004 + Math.random() * 0.026 + (1 - y / bedRow) * 0.01;
        let next = src - cool;

        // pull it into the flame silhouette — soft, so the edge stays ragged
        const off = Math.abs(x - cols / 2);
        if (off > allowed) {
          const over = (off - allowed) / (cols * 0.06);
          next -= next * Math.min(1, over * over);
        }

        heat[row + x] = next > 0 ? next : 0;
      }
    }

    // embers lift off the hottest part of the flame
    if (embers.length < EMBER_MAX && Math.random() < 0.55) {
      const x = cols / 2 + (Math.random() - 0.5) * cols * BED_HALF * 1.4;
      embers.push({
        x,
        y: bedRow - 2 - Math.random() * rows * 0.12,
        vx: (Math.random() - 0.5) * 0.22,
        vy: -(0.14 + Math.random() * 0.24),
        life: 1,
        fade: 0.0035 + Math.random() * 0.006,
      });
    }

    for (let i = embers.length - 1; i >= 0; i--) {
      const e = embers[i];
      e.x += e.vx;
      e.y += e.vy;
      e.vx += (Math.random() - 0.5) * 0.05; // wander on the way up
      e.vy *= 0.995;
      e.life -= e.fade;
      if (e.life <= 0 || e.y < -2) embers.splice(i, 1);
    }
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);

    // night — the ground the fire sits on, and the sky above it. It stops at the
    // stage edge and feathers into the page's paper, the same way every other
    // piece does.
    ctx.fillStyle = '#150e09';
    ctx.fillRect(0, 0, w, h);

    // A fire lights what's around it. Without this the darkness reads as a flat
    // black rectangle that happens to have glyphs on it; with it, the night is
    // lit by the fire and the piece becomes a place. Breathes with the bed, so
    // the whole frame lifts slightly as the flames surge.
    const gx = w / 2;
    const gy = bedRow * CELL_H;
    const glowR = Math.max(w, h) * (0.3 + glowPulse * 0.04);
    const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, glowR);
    glow.addColorStop(0, `rgba(248, 118, 20, ${0.042 + glowPulse * 0.014})`);
    glow.addColorStop(0.35, `rgba(200, 30, 10, ${0.018 + glowPulse * 0.006})`);
    glow.addColorStop(1, 'rgba(18, 11, 8, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // Every glyph is blitted from a pre-rendered atlas rather than laid out by
    // fillText. There are a couple of thousand of them a frame, and measuring
    // text that many times a frame is what the CPU actually spends its time on
    // — the atlas turned this from 17fps into something with headroom.
    for (let y = 0; y <= bedRow; y++) {
      const row = y * cols;
      for (let x = 0; x < cols; x++) {
        const v = heat[row + x];
        if (v < 0.06) continue;

        const n = Math.min(1, v);
        const level = Math.min(LEVELS - 1, (Math.pow(n, 0.45) * LEVELS) | 0);
        // glyph density tracks heat, with a little jitter so it shimmers
        const g = Math.pow(n, 0.55);
        const r = Math.min(RAMP.length - 1, ((g * 0.9 + Math.random() * 0.1) * RAMP.length) | 0);

        ctx.drawImage(
          atlas,
          r * tileW,
          level * tileH,
          tileW,
          tileH,
          x * CELL_W,
          y * CELL_H,
          CELL_W,
          CELL_H
        );
      }
    }

    // embers, drawn over the top
    ctx.font = `${CELL_H - 2}px 'JetBrains Mono', monospace`;
    for (const e of embers) {
      const t = e.life;
      ctx.fillStyle = paletteAt(0.62 + t * 0.38);
      ctx.globalAlpha = Math.min(1, t * 1.6);
      ctx.fillText(t > 0.6 ? '*' : '.', e.x * CELL_W, e.y * CELL_H);
    }
    ctx.globalAlpha = 1;

    if (mask) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(mask, 0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    // fixed 30Hz simulation — fire looks better a touch choppy than silky, and
    // it halves the work
    acc += dt;
    let steps = 0;
    while (acc > 1 / SIM_HZ && steps < 3) {
      step();
      acc -= 1 / SIM_HZ;
      steps++;
    }

    // only repaint when the simulation actually moved — at this rate that cuts the
    // work for no visible difference, fire being better a touch choppy anyway
    if (steps) draw();
    rafId = requestAnimationFrame(frame);
  }

  async function start() {
    resize();
    // the glyphs are the whole piece; don't draw a frame of fallback font
    if (document.fonts?.ready) await document.fonts.ready;
    resize();
    canvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1600, easing: 'ease-out' });
  }

  return {
    start,
    resize,
    setRunning(next) {
      if (next === running) return;
      running = next;
      if (running) {
        last = performance.now();
        rafId = requestAnimationFrame(frame);
      } else {
        cancelAnimationFrame(rafId);
      }
    },
    debug: {
      get grid() {
        return [cols, rows];
      },
      get embers() {
        return embers.length;
      },
      get lit() {
        let n = 0;
        for (let i = 0; i < heat.length; i++) if (heat[i] >= 0.06) n++;
        return n;
      },
      canvas,
    },
  };
}
