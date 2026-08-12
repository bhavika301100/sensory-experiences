// The koi themselves: sprite prep, wandering, separation, and the strip-based
// body undulation that makes them look like they're swimming rather than sliding.

import { asset } from './stage.js';

const TAU = Math.PI * 2;

/** Shortest signed angle from a to b. */
function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Rasterises the koi SVG once, cropped tight to its ink, plus a pre-blurred
 * black copy used as the underwater shadow. Doing the blur here means the
 * render loop never touches ctx.filter.
 */
export async function loadKoiSprite(rasterHeight = 560) {
  const text = await fetch(asset('assets/koi.svg')).then((r) => r.text());

  const holder = document.createElement('div');
  holder.style.cssText =
    'position:fixed;left:-10000px;top:0;width:400px;height:400px;opacity:0;pointer-events:none';
  holder.innerHTML = text;
  document.body.appendChild(holder);

  const svg = holder.querySelector('svg');
  let box;
  try {
    box = svg.getBBox();
  } catch {
    box = null;
  }
  if (!box || !box.width || !box.height) {
    box = { x: 1120, y: 730, width: 860, height: 1680 };
  }

  const pad = box.height * 0.02;
  const vb = [box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2];
  const aspect = vb[2] / vb[3];

  svg.setAttribute('viewBox', vb.join(' '));
  svg.setAttribute('width', String(Math.round(rasterHeight * aspect)));
  svg.setAttribute('height', String(rasterHeight));
  svg.removeAttribute('style');

  const markup = new XMLSerializer().serializeToString(svg);
  document.body.removeChild(holder);

  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = url;
  });

  const w = Math.round(rasterHeight * aspect);
  const h = rasterHeight;

  const body = document.createElement('canvas');
  body.width = w;
  body.height = h;
  const bctx = body.getContext('2d');
  // knocked back once here so the koi sit in the water rather than glaring
  // off it — free at render time
  bctx.filter = 'brightness(0.84) saturate(0.9)';
  bctx.drawImage(img, 0, 0, w, h);

  const shadow = document.createElement('canvas');
  const spread = Math.round(h * 0.05);
  shadow.width = w + spread * 2;
  shadow.height = h + spread * 2;
  const sctx = shadow.getContext('2d');
  // blurred generously — at pond scale the sprite is shrunk ~8x, so a tight
  // blur here lands as a hard edge on screen
  sctx.filter = `blur(${Math.round(h * 0.04)}px)`;
  sctx.drawImage(img, spread, spread, w, h);
  sctx.globalCompositeOperation = 'source-in';
  sctx.filter = 'none';
  sctx.fillStyle = '#000';
  sctx.fillRect(0, 0, shadow.width, shadow.height);

  URL.revokeObjectURL(url);

  return { body, shadow, aspect };
}

export const KOI_STATE = {
  ARRIVING: 'arriving',
  IDLE: 'idle',
  FEEDING: 'feeding',
  DISPERSING: 'dispersing',
  DISSOLVING: 'dissolving',
};

const FADE_IN = 2.8;
const DISSOLVE = 2.6;

// where the light puts the shadow, as a fraction of fish length, and how dark
const SHADOW_OFFSET = { x: 0.075, y: 0.09 };
const SHADOW_ALPHA = 0.2;

// one shared buffer for whichever koi happen to be fading at the moment
let scratch = null;
function ensureScratch(size) {
  const need = Math.ceil(size);
  if (!scratch || scratch.canvas.width < need) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = need;
    scratch = { canvas, ctx: canvas.getContext('2d') };
  }
  return scratch;
}

export class Koi {
  constructor(x, y, worldScale, { instant = false } = {}) {
    this.x = x;
    this.y = y;
    this.heading = Math.random() * TAU;

    // a real pond holds fish of noticeably different ages; colour never varies
    this.sizeVar = 0.66 + Math.random() * 0.74;
    this.length = 110 * worldScale * this.sizeVar;
    // bigger koi cruise a touch slower, the way they actually do
    const pace = 1.12 - this.sizeVar * 0.22;
    this.idleSpeed = (14 + Math.random() * 8) * worldScale * pace;
    this.rushSpeed = (60 + Math.random() * 20) * worldScale * pace;
    this.speed = this.idleSpeed;

    this.tailPhase = Math.random() * TAU;
    this.tailRate = 0.85 + Math.random() * 0.35;
    this.turnBias = (Math.random() - 0.5) * 0.4;

    this.state = instant ? KOI_STATE.IDLE : KOI_STATE.ARRIVING;
    this.opacity = instant ? 1 : 0;
    this.age = 0;
    this.dissolveT = 0;
    this.target = null;
    this.wakeCooldown = Math.random() * 0.8;

    // written each frame by the sim
    this.sepX = 0;
    this.sepY = 0;
    this.sepMag = 0;

    this.dispersalAngle = 0;
    this.dispersalT = 0;
  }

  get alive() {
    return !(this.state === KOI_STATE.DISSOLVING && this.dissolveT >= DISSOLVE);
  }

  get isRushing() {
    return this.state === KOI_STATE.FEEDING && this.target !== null;
  }

  beginDissolve() {
    if (this.state === KOI_STATE.DISSOLVING) return;
    this.state = KOI_STATE.DISSOLVING;
    this.dissolveT = 0;
    this.target = null;
  }

  /** Sent outward on its own heading once the food is gone. */
  disperse(angle, duration) {
    if (this.state === KOI_STATE.DISSOLVING) return;
    this.state = KOI_STATE.DISPERSING;
    this.dispersalAngle = angle;
    this.dispersalT = duration;
    this.target = null;
  }

  #steer(toAngle, rate, dt) {
    const d = angleDelta(this.heading, toAngle);
    this.heading += clamp(d, -rate * dt, rate * dt);
  }

  /**
   * Inward push that grows as the fish nears the rim. Returned as a vector
   * rather than applied directly: when this used to steer on its own it
   * *replaced* the steering toward food, so a pellet that drifted inside the
   * band could never be reached — the fish just orbited it and the pond
   * deadlocked with the feed button stuck. Callers blend it instead.
   *
   * `marginScale` narrows the band while feeding, so food near the rim stays
   * reachable without letting anything beach itself.
   */
  #edgeForce(pond, marginScale = 1) {
    const m = Math.min(pond.right - pond.left, pond.bottom - pond.top) * 0.17 * marginScale;
    let fx = 0;
    let fy = 0;
    if (this.x < pond.left + m) fx += (pond.left + m - this.x) / m;
    if (this.x > pond.right - m) fx -= (this.x - (pond.right - m)) / m;
    if (this.y < pond.top + m) fy += (pond.top + m - this.y) / m;
    if (this.y > pond.bottom - m) fy -= (this.y - (pond.bottom - m)) / m;

    return { x: fx, y: fy, mag: Math.hypot(fx, fy) };
  }

  update(dt, world) {
    const pond = world.pond;
    this.age += dt;

    if (this.state === KOI_STATE.ARRIVING) {
      const k = Math.min(1, this.age / FADE_IN);
      this.opacity = 1 - Math.pow(1 - k, 2);
      if (this.age >= FADE_IN) {
        this.state = KOI_STATE.IDLE;
        this.opacity = 1;
      }
    } else if (this.state === KOI_STATE.DISSOLVING) {
      this.dissolveT += dt;
      this.opacity = Math.pow(1 - Math.min(1, this.dissolveT / DISSOLVE), 1.6);
    } else if (this.state === KOI_STATE.DISPERSING) {
      this.dispersalT -= dt;
      if (this.dispersalT <= 0) this.state = KOI_STATE.IDLE;
    }

    const wantsFood = this.target && this.state !== KOI_STATE.DISSOLVING;
    const dispersing = this.state === KOI_STATE.DISPERSING;

    let targetSpeed = this.idleSpeed;
    if (wantsFood) targetSpeed = this.rushSpeed;
    else if (dispersing) targetSpeed = this.idleSpeed * 1.85;

    // ease into and out of pace so nothing darts
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * (wantsFood ? 1.6 : 0.9));

    const edge = this.#edgeForce(pond, wantsFood ? 0.45 : 1);
    const push = Math.min(1, edge.mag);

    if (wantsFood) {
      let gx = this.target.x - this.x;
      let gy = this.target.y - this.y;
      const len = Math.hypot(gx, gy) || 1;
      gx /= len;
      gy /= len;
      // the rim bends the approach, it never cancels it
      this.#steer(Math.atan2(gy + edge.y * push * 1.5, gx + edge.x * push * 1.5), 2.3, dt);
    } else if (dispersing) {
      const w = push * 2.5;
      this.#steer(
        Math.atan2(
          Math.sin(this.dispersalAngle) + edge.y * w,
          Math.cos(this.dispersalAngle) + edge.x * w
        ),
        1.15,
        dt
      );
    } else if (edge.mag > 0.001) {
      this.#steer(Math.atan2(edge.y, edge.x), 0.9 + edge.mag * 2.4, dt);
    } else {
      // lazy Ornstein–Uhlenbeck drift on turn rate -> unhurried arcs
      this.turnBias += (Math.random() - 0.5) * dt * 1.6;
      this.turnBias *= Math.pow(0.55, dt);
      this.turnBias = clamp(this.turnBias, -0.6, 0.6);
      this.heading += this.turnBias * dt;
    }

    // keep personal space on top of whatever else it's doing
    if (this.sepMag > 0.01 && this.state !== KOI_STATE.DISSOLVING) {
      const w = Math.min(1, this.sepMag);
      this.#steer(Math.atan2(this.sepY, this.sepX), (wantsFood ? 0.8 : 1.7) * w, dt);
    }

    this.x += Math.cos(this.heading) * this.speed * dt;
    this.y += Math.sin(this.heading) * this.speed * dt;

    // Steering alone can't break up a clump — two fish pointed at each other
    // just orbit. A gentle sideways drift on top of it actually resolves the
    // overlap, and at this magnitude it's invisible against the swimming.
    if (this.sepMag > 0.001 && this.state !== KOI_STATE.DISSOLVING) {
      const w = Math.min(1, this.sepMag);
      const push = 34 * world.scale * w * dt;
      this.x += (this.sepX / this.sepMag) * push;
      this.y += (this.sepY / this.sepMag) * push;
    }

    // hard stop at the rim, in case a rush overshoots the soft avoidance
    this.x = clamp(this.x, pond.left, pond.right);
    this.y = clamp(this.y, pond.top, pond.bottom);

    this.tailPhase += dt * (2.0 + this.speed * 0.055) * this.tailRate;
    this.wakeCooldown -= dt;
  }

  /**
   * The tail strips overlap slightly so no seam shows between them. That's
   * invisible at full opacity, but a translucent fish composites every overlap
   * twice and the seams darken into bands — which would land on exactly the two
   * moments that matter, arriving and dissolving. So a fading koi is painted
   * opaque into a scratch buffer first and that buffer is faded as one piece.
   */
  draw(ctx, sprite, dpr) {
    if (this.opacity <= 0.003) return;

    if (this.opacity > 0.997) {
      this.#paint(ctx, sprite, this.x, this.y);
      return;
    }

    const side = this.length * 1.7;
    const buf = ensureScratch(side * dpr);

    buf.ctx.setTransform(1, 0, 0, 1, 0, 0);
    buf.ctx.clearRect(0, 0, side * dpr, side * dpr);
    buf.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.#paint(buf.ctx, sprite, side / 2, side / 2);

    ctx.save();
    ctx.globalAlpha = this.opacity;
    ctx.drawImage(
      buf.canvas,
      0,
      0,
      side * dpr,
      side * dpr,
      this.x - side / 2,
      this.y - side / 2,
      side,
      side
    );
    ctx.restore();
  }

  #paint(ctx, sprite, atX, atY) {
    const shrink =
      this.state === KOI_STATE.DISSOLVING ? 1 - 0.04 * (this.dissolveT / DISSOLVE) : 1;
    const dh = this.length * shrink;
    const dw = dh * sprite.aspect;

    const src = sprite.body;
    const sw = src.width;
    const sh = src.height;

    const HEAD = 0.42;
    const ROWS = 30;
    const rushT = clamp(
      (this.speed - this.idleSpeed) / Math.max(1, this.rushSpeed - this.idleSpeed),
      0,
      1
    );
    const maxAmp = dw * (0.17 + 0.11 * rushT);
    const waveLen = 3.1;

    // Shadow gets its own transform so its offset is in *world* space. Nudging
    // it inside the fish's rotated frame swung the light around with the fish;
    // now it falls the same way whichever direction the koi is pointing. It also
    // needs to clear the body to read at all — tucked underneath it was
    // invisible once the water lightened.
    const shSpread = (sprite.shadow.width / sw - 1) / 2;
    const shW = dw * (1 + shSpread * 2);
    const shH = dh * (1 + shSpread * 2 * sprite.aspect);

    ctx.save();
    ctx.translate(atX + dh * SHADOW_OFFSET.x, atY + dh * SHADOW_OFFSET.y);
    ctx.rotate(this.heading + Math.PI / 2);
    ctx.globalAlpha = SHADOW_ALPHA;
    ctx.drawImage(sprite.shadow, -shW / 2, -shH / 2, shW, shH);
    ctx.restore();

    ctx.save();
    ctx.translate(atX, atY);
    ctx.rotate(this.heading + Math.PI / 2);

    // head and front body stay rigid — koi yaw slightly, they don't wobble
    const headSrcH = Math.floor(sh * HEAD);
    const headOff = -dw * 0.05 * Math.sin(this.tailPhase);
    ctx.drawImage(src, 0, 0, sw, headSrcH, -dw / 2 + headOff, -dh / 2, dw, dh * HEAD + 1);

    // Rear body sliced into strips, each lagging the one ahead of it. Offsetting
    // strips alone leaves a visible staircase on a tail this long and thin, so
    // each strip is also sheared by the slope of the wave — consecutive strips
    // then meet edge to edge and the tail reads as one continuous ribbon.
    const tailSrcH = sh - headSrcH;
    const stripSrc = tailSrcH / ROWS;
    const stripDst = (dh * (1 - HEAD)) / ROWS;
    const tailTop = -dh / 2 + dh * HEAD;

    const waveAt = (t) => maxAmp * t * t * Math.sin(this.tailPhase - t * waveLen);

    for (let i = 0; i < ROWS; i++) {
      const t0 = i / ROWS;
      const o0 = waveAt(t0);
      const shear = (waveAt((i + 1) / ROWS) - o0) / stripDst;

      ctx.save();
      ctx.transform(1, 0, shear, 1, -dw / 2 + o0, tailTop + i * stripDst);
      ctx.drawImage(src, 0, headSrcH + i * stripSrc, sw, stripSrc + 1, 0, 0, dw, stripDst + 1.2);
      ctx.restore();
    }

    ctx.restore();
  }
}
