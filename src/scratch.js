// "make karl go away" — fog over the bridge that you scratch off.
//
// Three layers: the video underneath, generated fog on top, and a mask that
// records where you've scratched. The fog is redrawn every frame because it
// moves, so the scratching can't live in the fog itself — the mask is what
// persists, and it's punched out of the fog on the way to the screen.

import { stage, featherMask, asset, coverRect } from './stage.js';
import { unlock, windGust, windStop, playReveal } from './audio.js';
import { createFog, CLOUD_TOP } from './fog.js';
import { rollText, rollRestore } from './roll.js';

const TAU = Math.PI * 2;

const REVEAL_AT = 0.6; // fraction scratched before it finishes on its own
const WAVE_TIME = 1.1; // s for the wave to cross the frame
const SETTLE_TIME = 1.4; // s for the picture to ease back to rest
const SETTLE_ZOOM = 0.05; // how far in it starts before easing out
const REVEALED_TITLE = "ahh, isn't sf pretty?";

// coarse occupancy grid — counting cleared cells is far cheaper than reading
// the mask back every frame just to ask how much is gone
const GRID_X = 48;
const GRID_Y = 27;

// Rows above the crest are sky — they can never be cleared, so counting them
// would put the reveal permanently out of reach. Progress is the fraction of
// the *bank* that's gone, not of the frame.
const SKY_ROWS = Math.floor(GRID_Y * CLOUD_TOP);
const COVERABLE = (GRID_Y - SKY_ROWS) * GRID_X;

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createScratch(section) {
  const stageEl = section.querySelector('.stage');
  const titleEl = section.querySelector('.title');
  const hintEl = section.querySelector('.hint');
  const video = section.querySelector('video');
  const canvas = section.querySelector('canvas.fg');
  const ctx = canvas.getContext('2d');

  let w = 0;
  let h = 0;
  let dpr = 1;
  let mask = null;

  const fog = createFog();

  // white where scratched; used as destination-out against the fog
  const scratched = document.createElement('canvas');
  const scratchedCtx = scratched.getContext('2d');

  // fog with the holes already punched, ready to lay over the video
  const veil = document.createElement('canvas');
  const veilCtx = veil.getContext('2d');

  const grid = new Uint8Array(GRID_X * GRID_Y);
  let cleared = 0;

  let running = false;
  let rafId = 0;
  let last = performance.now();

  let pressing = false;
  let hovering = false;
  const cursor = { x: 0, y: 0 };
  let prev = null;

  let revealed = false;
  let revealT = 0;
  const waveFrom = { x: 0, y: 0 };

  let lastMoveAt = 0;

  const brush = () => Math.max(18, 34 * stage.scale);
  const progress = () => cleared / COVERABLE;

  function resize() {
    const prevW = w;
    const prevH = h;

    w = stage.w;
    h = stage.h;
    dpr = stage.dpr;

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    veil.width = Math.round(w * dpr);
    veil.height = Math.round(h * dpr);
    veilCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // carry whatever has already been scratched across the resize
    const carry = prevW > 0 && scratched.width > 0 ? document.createElement('canvas') : null;
    if (carry) {
      carry.width = scratched.width;
      carry.height = scratched.height;
      carry.getContext('2d').drawImage(scratched, 0, 0);
    }
    scratched.width = Math.round(w * dpr);
    scratched.height = Math.round(h * dpr);
    scratchedCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (carry) scratchedCtx.drawImage(carry, 0, 0, w, h);

    fog?.resize(w, h, dpr);
    mask = featherMask(w, h, stage.feather, stage.radius);
  }

  function markCells(x, y, r) {
    const cw = w / GRID_X;
    const chh = h / GRID_Y;
    const gx0 = Math.max(0, Math.floor((x - r) / cw));
    const gx1 = Math.min(GRID_X - 1, Math.floor((x + r) / cw));
    const gy0 = Math.max(0, Math.floor((y - r) / chh));
    const gy1 = Math.min(GRID_Y - 1, Math.floor((y + r) / chh));

    for (let gy = Math.max(SKY_ROWS, gy0); gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const i = gy * GRID_X + gx;
        if (grid[i]) continue;
        const dx = (gx + 0.5) * cw - x;
        const dy = (gy + 0.5) * chh - y;
        if (dx * dx + dy * dy <= r * r) {
          grid[i] = 1;
          cleared++;
        }
      }
    }
  }

  function stamp(x, y, r, hardness = 0.55) {
    const g = scratchedCtx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(hardness, 'rgba(255,255,255,0.95)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    scratchedCtx.fillStyle = g;
    scratchedCtx.beginPath();
    scratchedCtx.arc(x, y, r, 0, TAU);
    scratchedCtx.fill();
  }

  function scratchTo(x, y) {
    if (revealed) return;
    const r = brush();

    if (prev) {
      const dist = Math.hypot(x - prev.x, y - prev.y);
      // stamp along the segment so a fast drag doesn't leave gaps
      const steps = Math.max(1, Math.ceil(dist / (r * 0.3)));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const px = prev.x + (x - prev.x) * t;
        const py = prev.y + (y - prev.y) * t;
        stamp(px, py, r);
        markCells(px, py, r * 0.78);
      }
      // gust strength follows actual hand speed, not raw distance
      const now = performance.now();
      const elapsed = Math.max(8, now - lastMoveAt);
      lastMoveAt = now;
      windGust(clamp01(dist / (elapsed / 1000) / 1500));
    } else {
      lastMoveAt = performance.now();
      stamp(x, y, r);
      markCells(x, y, r * 0.78);
    }

    prev = { x, y };
    waveFrom.x = x;
    waveFrom.y = y;

    if (progress() >= REVEAL_AT) beginReveal();
  }

  function beginReveal() {
    if (revealed) return;
    revealed = true;
    revealT = 0;
    pressing = false;
    windStop();
    playReveal();

    // slow enough that it reads as the caption settling, not a transition
    rollText(titleEl, REVEALED_TITLE, { duration: 1400, stagger: 70 });
    rollText(hintEl, '', { duration: 1400, stagger: 70 });
  }

  function frame(now) {
    if (!running) return;

    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (revealed && revealT < WAVE_TIME + SETTLE_TIME) revealT += dt;

    // the wave keeps clearing the mask as it travels
    if (revealed && revealT <= WAVE_TIME) {
      const t = clamp01(revealT / WAVE_TIME);
      const r = easeOut(t) * Math.hypot(w, h) * 1.05;
      const g = scratchedCtx.createRadialGradient(waveFrom.x, waveFrom.y, r * 0.72, waveFrom.x, waveFrom.y, r);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      scratchedCtx.fillStyle = g;
      scratchedCtx.beginPath();
      scratchedCtx.arc(waveFrom.x, waveFrom.y, r, 0, TAU);
      scratchedCtx.fill();
    }

    ctx.clearRect(0, 0, w, h);

    // the settle: starts slightly in and eases back out to rest
    const settle = revealed ? clamp01((revealT - WAVE_TIME * 0.45) / SETTLE_TIME) : 0;
    const scale = revealed ? 1 + SETTLE_ZOOM * (1 - easeOut(settle)) : 1;

    ctx.save();
    if (scale !== 1) {
      ctx.translate(w / 2, h / 2);
      ctx.scale(scale, scale);
      ctx.translate(-w / 2, -h / 2);
    }

    if (video.readyState >= 2) {
      const c = coverRect(video.videoWidth, video.videoHeight, w, h);
      if (c) ctx.drawImage(video, c.sx, c.sy, c.sw, c.sh, 0, 0, w, h);
    }

    // fog, minus everything that's been scratched away
    const done = revealed && revealT > WAVE_TIME;
    if (fog && !done) {
      fog.render();
      veilCtx.clearRect(0, 0, w, h);
      veilCtx.drawImage(fog.canvas, 0, 0, w, h);
      veilCtx.globalCompositeOperation = 'destination-out';
      veilCtx.drawImage(scratched, 0, 0, w, h);
      veilCtx.globalCompositeOperation = 'source-over';
      ctx.drawImage(veil, 0, 0, w, h);
    }

    // a soft crest riding the front of the wave
    if (revealed && revealT <= WAVE_TIME) {
      const t = clamp01(revealT / WAVE_TIME);
      const r = easeOut(t) * Math.hypot(w, h) * 1.05;
      const a = (1 - t) * 0.45;
      const g = ctx.createRadialGradient(waveFrom.x, waveFrom.y, r * 0.88, waveFrom.x, waveFrom.y, r * 1.05);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, `rgba(255,255,255,${a})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(waveFrom.x, waveFrom.y, r * 1.05, 0, TAU);
      ctx.fill();
    }

    ctx.restore();

    // where the coin is
    if (hovering && !revealed) {
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(28, 34, 40, 0.4)';
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, brush(), 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, brush() - 1, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    if (mask) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(mask, 0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }

    rafId = requestAnimationFrame(frame);
  }

  function local(e) {
    const r = stageEl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  async function start() {
    resize();

    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    if (!video.src) video.src = asset('assets/bridge.mp4');

    try {
      await video.play();
    } catch {
      const kick = () => {
        video.play().catch(() => {});
        window.removeEventListener('pointerdown', kick);
      };
      window.addEventListener('pointerdown', kick);
    }

    stageEl.addEventListener('pointerenter', (e) => {
      hovering = true;
      Object.assign(cursor, local(e));
    });

    stageEl.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      unlock();
      pressing = true;
      prev = null;
      Object.assign(cursor, local(e));
      stageEl.setPointerCapture?.(e.pointerId);
      scratchTo(cursor.x, cursor.y);
    });

    stageEl.addEventListener('pointermove', (e) => {
      Object.assign(cursor, local(e));
      if (pressing) {
        scratchTo(cursor.x, cursor.y);
        e.preventDefault();
      }
    });

    const release = () => {
      pressing = false;
      prev = null;
      windStop();
    };
    stageEl.addEventListener('pointerup', release);
    stageEl.addEventListener('pointercancel', release);
    stageEl.addEventListener('pointerleave', () => {
      hovering = false;
      release();
    });

    canvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1200, easing: 'ease-out' });
  }

  /** Back to full cloud, nothing scratched. */
  function reset() {
    scratchedCtx.setTransform(1, 0, 0, 1, 0, 0);
    scratchedCtx.clearRect(0, 0, scratched.width, scratched.height);
    scratchedCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    grid.fill(0);
    cleared = 0;
    revealed = false;
    revealT = 0;
    pressing = false;
    prev = null;
    windStop();
    // rolls back rather than snapping, same pace as the reveal
    rollRestore(titleEl, { duration: 1400, stagger: 70 });
    rollRestore(hintEl, { duration: 1400, stagger: 70 });
  }

  return {
    start,
    resize,
    reset,
    setRunning(next) {
      if (next === running) return;
      running = next;
      if (running) {
        video.play().catch(() => {});
        last = performance.now();
        rafId = requestAnimationFrame(frame);
      } else {
        cancelAnimationFrame(rafId);
        video.pause();
        windStop();
      }
    },
    debug: {
      get progress() {
        return progress();
      },
      get revealed() {
        return revealed;
      },
      get revealT() {
        return revealT;
      },
      scratchTo,
      beginReveal,
      cursor,
      video,
      fog,
      canvas,
      /** render one frame even when the piece is paused, for inspection */
      forceFrame() {
        const was = running;
        running = true;
        frame(performance.now());
        running = was;
      },
    },
  };
}
