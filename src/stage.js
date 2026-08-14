// Geometry shared by every piece on the page. Each piece is presented in the
// same "stage" — a rounded rect at STAGE_FRACTION of the viewport, dissolving
// into the paper — so the whole page reads as one set.

export const STAGE_FRACTION = 0.65;
// the fire piece goes nearly full-bleed — it's a night scene, and holding it in
// a paper frame the size of the others made it read as a picture of a campfire
// rather than as sitting at one
export const FULL_FRACTION = 0.995;

/**
 * Resolve a file in `public/` against the deployed base path.
 *
 * Absolute `/assets/...` URLs work on a dev server at the root but 404 on a
 * GitHub project page, which serves the site from `/<repo>/`. BASE_URL is `/`
 * in dev and relative in the built site, so this is correct in both.
 */
export const asset = (path) => `${import.meta.env.BASE_URL}${path}`;

export const stage = {
  w: 0,
  h: 0,
  fullW: 0,
  fullH: 0,
  feather: 0,
  fullFeather: 0,
  radius: 16,
  scale: 1,
  dpr: 1,
};

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function computeStage() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  stage.w = Math.max(20, Math.round(vw * STAGE_FRACTION));
  stage.h = Math.max(20, Math.round(vh * STAGE_FRACTION));

  stage.fullW = Math.max(20, Math.round(vw * FULL_FRACTION));
  stage.fullH = Math.max(20, Math.round(vh * FULL_FRACTION));

  const min = Math.min(stage.w, stage.h);
  stage.feather = clamp(min * 0.085, 20, 80);
  // The full-bleed stage gets its own, much tighter edge. The 65% stage can
  // afford a wide dissolve because there's paper on every side to dissolve
  // *into*; out at full-bleed the same band is the entire margin, and reads as
  // the piece being surrounded by whitespace rather than as an edge.
  stage.fullFeather = clamp(Math.min(stage.fullW, stage.fullH) * 0.022, 10, 28);
  stage.radius = 16;
  // content is sized off the stage, not the viewport, so it keeps its
  // proportions when the stage changes size
  stage.scale = clamp(min / 700, 0.42, 1.4);
  stage.dpr = Math.min(window.devicePixelRatio || 1, 2);

  const root = document.documentElement.style;
  root.setProperty('--stage-w', `${stage.w}px`);
  root.setProperty('--stage-h', `${stage.h}px`);
  root.setProperty('--feather', `${stage.feather}px`);
  root.setProperty('--full-feather', `${stage.fullFeather}px`);
  root.setProperty('--stage-full-w', `${stage.fullW}px`);
  root.setProperty('--stage-full-h', `${stage.fullH}px`);

  return stage;
}

/** Source rect that fills the destination box without distorting — object-fit: cover. */
export function coverRect(srcW, srcH, dstW, dstH) {
  if (!srcW || !srcH || !dstW || !dstH) return null;

  const target = dstW / dstH;
  if (srcW / srcH > target) {
    const sw = srcH * target;
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
  }
  const sh = srcW / target;
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}

function smin(a, b, k) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return a * h + b * (1 - h) - k * h * (1 - h);
}

/**
 * An alpha mask matching the water shader's edge exactly — same softened
 * distance field, same smootherstep ramp — so every piece dissolves into the
 * paper identically.
 *
 * Built at CSS resolution rather than device pixels: it's a smooth gradient, so
 * upscaling costs nothing visually and saves ~4x the pixel loop on retina.
 */
export function featherMask(w, h, feather, radius) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));

  const ctx = c.getContext('2d');
  const img = ctx.createImageData(c.width, c.height);
  const d = img.data;

  const hw = w / 2;
  const hh = h / 2;
  const k = feather * 0.6;

  for (let y = 0; y < c.height; y++) {
    const py = y + 0.5 - hh;
    const ay = Math.abs(py);
    const ey = hh - ay;
    const qy = ay - hh + radius;

    for (let x = 0; x < c.width; x++) {
      const px = x + 0.5 - hw;
      const ax = Math.abs(px);

      let depth = smin(hw - ax, ey, k);
      const qx = ax - hw + radius;
      if (qx > 0 && qy > 0) depth = Math.min(depth, radius - Math.hypot(qx, qy));

      const e = clamp(depth / feather, 0, 1);
      const a = e * e * e * (e * (e * 6 - 15) + 10);

      const i = (y * c.width + x) * 4;
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = (a * 255) | 0;
    }
  }

  ctx.putImageData(img, 0, 0);
  return c;
}
