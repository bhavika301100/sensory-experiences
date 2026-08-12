// The koi pond piece. Coordinates are stage-local: the canvases are exactly the
// stage box, so the water fills them and the pond rect is the canvas itself.

import { startBackground } from './background.js';
import { loadKoiSprite, Koi, KOI_STATE } from './koi.js';
import { Ripple, Pellet } from './water.js';
import { unlock, playDrip, playSwim } from './audio.js';
import { stage, clamp } from './stage.js';

const TAU = Math.PI * 2;
const MAX_KOI = 12;
const DISSOLVE_DELAY = 1150; // ms — the overflow fish lingers a beat before going
const SWIM_SOUND_GAP = 0.2; // s — floor between touching-the-water plays

// Belt and braces: if nothing has been eaten for this long the remaining food
// is unreachable for some reason, and without this the feed button would stay
// disabled for the rest of the session.
const STALL_TIMEOUT = 25; // s

export function createPond(section) {
  const stageEl = section.querySelector('.stage');
  const bgCanvas = section.querySelector('canvas.bg');
  const fgCanvas = section.querySelector('canvas.fg');
  const feedBtn = section.querySelector('.feed');
  const ctx = fgCanvas.getContext('2d');

  const world = {
    width: 0,
    height: 0,
    scale: 1,
    // cx/cy/hw/hh/radius/feather describe the drawn shape; left/right/top/bottom
    // are the swimmable box, pulled inside the feather so no fish is ever half
    // dissolved into the paper
    pond: { cx: 0, cy: 0, hw: 0, hh: 0, radius: 0, feather: 0, left: 0, right: 0, top: 0, bottom: 0 },
  };

  const kois = [];
  const ripples = [];
  const pellets = [];

  let sprite = null;
  let dpr = 1;
  let mask = null;
  let lastSwimSound = -Infinity;
  let dropsInFlight = 0;
  let wasFeeding = false;
  let lastAte = 0;
  let running = false;
  let rafId = 0;
  let last = performance.now();
  let background = null;

  /** A rounded rect blurred into an alpha mask, so the koi layer fades out on
   *  exactly the same edge the water does. */
  function buildMask() {
    const p = world.pond;
    const c = document.createElement('canvas');
    c.width = fgCanvas.width;
    c.height = fgCanvas.height;
    const m = c.getContext('2d');
    m.setTransform(dpr, 0, 0, dpr, 0, 0);
    // pulled inside the water's own fade so a koi can never end up floating on
    // the paper past the edge of the water
    const inset = p.feather * 0.5;
    m.filter = `blur(${p.feather * 0.34}px)`;
    m.fillStyle = '#fff';
    m.beginPath();
    m.roundRect(
      p.cx - p.hw + inset,
      p.cy - p.hh + inset,
      (p.hw - inset) * 2,
      (p.hh - inset) * 2,
      Math.max(2, p.radius - inset)
    );
    m.fill();
    return c;
  }

  function resize() {
    const prevW = world.width;
    const prevH = world.height;

    world.width = stage.w;
    world.height = stage.h;
    world.scale = stage.scale;
    dpr = stage.dpr;

    // the canvas *is* the pond, so the rect covers it corner to corner
    const p = world.pond;
    p.hw = world.width / 2;
    p.hh = world.height / 2;
    p.cx = world.width / 2;
    p.cy = world.height / 2;
    p.feather = stage.feather;
    p.radius = stage.radius;

    const inset = p.feather * 0.55;
    p.left = p.cx - p.hw + inset;
    p.right = p.cx + p.hw - inset;
    p.top = p.cy - p.hh + inset;
    p.bottom = p.cy + p.hh - inset;

    fgCanvas.width = Math.round(world.width * dpr);
    fgCanvas.height = Math.round(world.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    mask = buildMask();
    // the water canvas can't wait for its own loop to notice — that loop may
    // not be running when the stage changes size
    background?.resize();

    // Carry the school across proportionally rather than clamping it. Clamping
    // piles every fish into a corner when the stage grows a lot — which is
    // exactly what happens recovering from a zero-size first layout.
    for (const k of kois) {
      if (prevW > 0 && prevH > 0) {
        k.x *= world.width / prevW;
        k.y *= world.height / prevH;
      }
      k.x = clamp(k.x, p.left, p.right);
      k.y = clamp(k.y, p.top, p.bottom);
    }
  }

  function activeKoi() {
    return kois.filter((k) => k.state !== KOI_STATE.DISSOLVING);
  }

  function dissolveOldest() {
    const living = activeKoi();
    if (living.length <= MAX_KOI) return;
    // kois are stored in arrival order, so the front of the list is the eldest
    living[0].beginDissolve();
  }

  function addKoi(x, y) {
    const p = world.pond;
    const koi = new Koi(clamp(x, p.left, p.right), clamp(y, p.top, p.bottom), world.scale);
    kois.push(koi);
    if (activeKoi().length > MAX_KOI) setTimeout(dissolveOldest, DISSOLVE_DELAY);
    return koi;
  }

  function tapWater(x, y) {
    unlock();
    playDrip(x);
    ripples.push(new Ripple(x, y, { maxR: 170 * world.scale, life: 3.1, strength: 0.34 }));
    addKoi(x, y);
  }

  function scatterFood() {
    unlock();

    const p = world.pond;
    const count = Math.round(Math.min(22, 7 + activeKoi().length * 1.4));
    const rx = (p.right - p.left) * 0.42;
    const ry = (p.bottom - p.top) * 0.4;

    for (let i = 0; i < count; i++) {
      // uniform-ish scatter inside an ellipse, so food doesn't clump at the middle
      const a = Math.random() * TAU;
      const rad = Math.sqrt(Math.random());
      const x = p.cx + Math.cos(a) * rx * rad;
      const y = p.cy + Math.sin(a) * ry * rad;

      dropsInFlight++;
      setTimeout(() => {
        dropsInFlight--;
        pellets.push(new Pellet(x, y, world.scale));
        ripples.push(new Ripple(x, y, { maxR: 30 * world.scale, life: 1.5, strength: 0.22 }));
        if (Math.random() < 0.35) playDrip(x);
      }, Math.random() * 700);
    }

    feedBtn.disabled = true;
    lastAte = performance.now() / 1000;
  }

  /** Fan every fish out on its own bearing once the food is gone. */
  function disperseAll() {
    const living = activeKoi();
    const n = living.length;
    if (!n) return;

    const order = living.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    const base = Math.random() * TAU;
    order.forEach((k, i) => {
      // evenly spaced bearings with a little jitter — guarantees they actually
      // scatter rather than all drifting the same way
      k.disperse(base + (i / n) * TAU + (Math.random() - 0.5) * 0.55, 2.6 + Math.random() * 2.2);
    });
  }

  /** Soft mutual repulsion so the school stays spread out. */
  function computeSeparation() {
    for (const k of kois) {
      k.sepX = 0;
      k.sepY = 0;
      k.sepMag = 0;
    }

    for (let i = 0; i < kois.length; i++) {
      const a = kois[i];
      if (a.state === KOI_STATE.DISSOLVING) continue;

      for (let j = i + 1; j < kois.length; j++) {
        const b = kois[j];
        if (b.state === KOI_STATE.DISSOLVING) continue;

        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        const R = (a.length + b.length) * 0.66;
        if (d2 > R * R || d2 < 0.01) continue;

        const d = Math.sqrt(d2);
        const f = 1 - d / R;
        const ux = dx / d;
        const uy = dy / d;
        a.sepX += ux * f;
        a.sepY += uy * f;
        b.sepX -= ux * f;
        b.sepY -= uy * f;
      }
    }

    for (const k of kois) k.sepMag = Math.hypot(k.sepX, k.sepY);
  }

  function assignTargets() {
    for (const koi of kois) {
      if (koi.state === KOI_STATE.DISSOLVING || pellets.length === 0) {
        koi.target = null;
        continue;
      }

      let best = null;
      let bestD = Infinity;
      for (const p of pellets) {
        const d = (p.x - koi.x) ** 2 + (p.y - koi.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }

      // hysteresis: stay on the current pellet unless another is clearly closer,
      // otherwise fish jitter between two equidistant pieces
      if (koi.target && pellets.includes(koi.target)) {
        const cur = (koi.target.x - koi.x) ** 2 + (koi.target.y - koi.y) ** 2;
        if (cur < bestD * 1.6) continue;
      }
      koi.target = best;
      if (koi.state === KOI_STATE.IDLE || koi.state === KOI_STATE.DISPERSING) {
        koi.state = KOI_STATE.FEEDING;
      }
    }
  }

  function eatAndWake(now) {
    for (const koi of kois) {
      if (koi.state === KOI_STATE.DISSOLVING) continue;

      if (koi.target) {
        if (Math.hypot(koi.target.x - koi.x, koi.target.y - koi.y) < koi.length * 0.26) {
          const i = pellets.indexOf(koi.target);
          if (i !== -1) pellets.splice(i, 1);
          koi.target = null;

          lastAte = now;
          ripples.push(new Ripple(koi.x, koi.y, { maxR: 38 * world.scale, life: 1.3, strength: 0.2 }));
          if (now - lastSwimSound > SWIM_SOUND_GAP) {
            lastSwimSound = now;
            playSwim(koi.x, 1);
          }
        }
      }

      // a rushing fish leaves a wake and a sound on its tail beats
      if (koi.isRushing && koi.wakeCooldown <= 0) {
        koi.wakeCooldown = 0.3 + Math.random() * 0.3;
        ripples.push(
          new Ripple(
            koi.x - Math.cos(koi.heading) * koi.length * 0.34,
            koi.y - Math.sin(koi.heading) * koi.length * 0.34,
            { maxR: 44 * world.scale, life: 1.7, strength: 0.13 }
          )
        );
        if (now - lastSwimSound > SWIM_SOUND_GAP) {
          lastSwimSound = now;
          playSwim(koi.x, 0.75);
        }
      }

      if (!koi.target && koi.state === KOI_STATE.FEEDING) koi.state = KOI_STATE.IDLE;
    }
  }

  function frame(now) {
    if (!running) return;

    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;

    if (pellets.length > 0 && dropsInFlight === 0 && t - lastAte > STALL_TIMEOUT) {
      for (const p of pellets) {
        ripples.push(new Ripple(p.x, p.y, { maxR: 22 * world.scale, life: 1.4, strength: 0.14 }));
      }
      pellets.length = 0;
    }

    const feedingNow = pellets.length > 0 || dropsInFlight > 0;
    if (wasFeeding && !feedingNow) disperseAll();
    wasFeeding = feedingNow;

    assignTargets();
    computeSeparation();

    for (const koi of kois) koi.update(dt, world);
    eatAndWake(t);

    for (const p of pellets) p.update(dt, world.pond);
    for (const r of ripples) r.update(dt);

    for (let i = kois.length - 1; i >= 0; i--) {
      if (!kois[i].alive) {
        const k = kois[i];
        // one last soft bloom where the fish went back into the water
        ripples.push(new Ripple(k.x, k.y, { maxR: 80 * world.scale, life: 3.4, strength: 0.11 }));
        kois.splice(i, 1);
      }
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      if (!ripples[i].alive) ripples.splice(i, 1);
    }

    if (!feedingNow && feedBtn.disabled) feedBtn.disabled = false;

    ctx.clearRect(0, 0, world.width, world.height);
    for (const r of ripples) r.draw(ctx);
    for (const p of pellets) p.draw(ctx);
    if (sprite) for (const koi of kois) koi.draw(ctx, sprite, dpr);

    // feather this layer onto the same edge as the water
    if (mask) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(mask, 0, 0, world.width, world.height);
      ctx.globalCompositeOperation = 'source-over';
    }

    rafId = requestAnimationFrame(frame);
  }

  async function start() {
    resize();
    background = await startBackground(bgCanvas, world);
    background?.resize();

    try {
      sprite = await loadKoiSprite();
    } catch (err) {
      console.error('[pond] could not prepare the koi sprite', err);
    }

    // the pond opens with a single resident
    kois.push(
      new Koi(world.pond.cx, world.pond.cy - world.height * 0.08, world.scale, { instant: true })
    );
    fgCanvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1600, easing: 'ease-out' });

    stageEl.addEventListener('pointerdown', (e) => {
      // primary pointer, primary button only — right-clicks and second fingers
      // shouldn't stock the pond
      if (!e.isPrimary) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const r = stageEl.getBoundingClientRect();
      tapWater(e.clientX - r.left, e.clientY - r.top);
    });

    feedBtn.addEventListener('click', scatterFood);
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
    debug: { kois, ripples, pellets, world, addKoi, scatterFood, Ripple },
  };
}
