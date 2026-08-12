// Surface disturbances: soft ripple halos and the food pellets.

/**
 * A ripple is a diffuse expanding halo, not a drawn ring. Stroked circles read
 * as hard concentric lines on water; a radial gradient with no opaque stop and
 * a soft band around 0.8 of the radius disturbs the surface instead of drawing
 * on it.
 */
export class Ripple {
  constructor(x, y, { maxR = 120, life = 2.4, strength = 0.5 } = {}) {
    this.x = x;
    this.y = y;
    this.t = 0;
    this.life = life;
    this.maxR = maxR;
    this.strength = strength;
  }

  get alive() {
    return this.t < this.life;
  }

  update(dt) {
    this.t += dt;
  }

  draw(ctx) {
    const p = Math.min(1, this.t / this.life);
    const r = (1 - Math.pow(1 - p, 2.2)) * this.maxR;
    if (r < 1) return;

    // fades in over the first sliver of life so it never pops into existence
    const a = Math.pow(1 - p, 1.9) * Math.min(1, p / 0.06) * this.strength;
    if (a <= 0.002) return;

    const g = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, r);
    g.addColorStop(0, 'rgba(226, 242, 255, 0)');
    g.addColorStop(0.34, `rgba(226, 242, 255, ${a * 0.04})`);
    g.addColorStop(0.62, `rgba(232, 245, 255, ${a * 0.3})`);
    g.addColorStop(0.8, `rgba(240, 249, 255, ${a * 0.88})`);
    g.addColorStop(0.92, `rgba(240, 249, 255, ${a * 0.5})`);
    g.addColorStop(1, 'rgba(240, 249, 255, 0)');

    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

export class Pellet {
  constructor(x, y, worldScale) {
    this.x = x;
    this.y = y;
    this.r = (2.4 + Math.random() * 1.4) * worldScale;
    this.driftAngle = Math.random() * Math.PI * 2;
    this.driftSpeed = (2 + Math.random() * 3) * worldScale;
    this.hue = 36 + Math.random() * 10;
    this.t = 0;
  }

  update(dt, pond) {
    this.t += dt;
    this.driftAngle += (Math.random() - 0.5) * dt * 1.4;
    this.x += Math.cos(this.driftAngle) * this.driftSpeed * dt;
    this.y += Math.sin(this.driftAngle) * this.driftSpeed * dt;
    this.x = Math.max(pond.left, Math.min(pond.right, this.x));
    this.y = Math.max(pond.top, Math.min(pond.bottom, this.y));
  }

  draw(ctx) {
    // just a dot — no glow, no highlight, no shadow
    const appear = Math.min(1, this.t / 0.45);
    ctx.fillStyle = `hsla(${this.hue}, 62%, 52%, ${0.88 * appear})`;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r * (0.5 + 0.5 * appear), 0, Math.PI * 2);
    ctx.fill();
  }
}
