// Karl, built out of real cloud silhouettes rather than noise.
//
// Procedural fbm gives you smoke — swirls with no edges, because noise has no
// shape. So this is sprites: two photographed silhouettes, scaled, flipped,
// blurred and stacked nine deep across the whole frame, with a haze over the
// lot. Fog has no edge, so neither does this — there's no boundary anywhere
// between "cloud" and "sky", just density falling off as it rises.

import { asset } from './stage.js';

const SPRITES = [
  { key: 'bank', src: 'assets/cloud-bank.png' },
  { key: 'wisp', src: 'assets/cloud-wisp.png' },
];

// Layers back to front. `y` is where the sprite's top sits as a fraction of the
// frame, `w` its drawn width as a multiple of the frame width, `speed` its drift
// in frame-widths per second — far layers slower, which is what reads as depth.
//
// Every layer is blurred past the point where an individual cumulus silhouette
// is readable. `cloud-bank.png` is itself made of cauliflower shapes, so drawn
// sharp anywhere it puts discrete "clouds" in the frame — which is precisely
// what fog isn't. Far layers carry more blur than near ones only to keep the
// depth ordering; none of them are crisp. The lowest three use `wisp` alone,
// it being the formless one.
//
// Drift is deliberately tiny — a full pass takes 1.6 to 12.8 minutes.
const LAYERS = [
  // sitting above the frame, so the very top is already in it
  { key: 'wisp', y: -0.35, w: 2.6, speed: 0.0013, alpha: 0.42, blur: 34, flip: false },
  { key: 'bank', y: -0.22, w: 2.2, speed: 0.0018, alpha: 0.48, blur: 30, flip: true },
  { key: 'wisp', y: -0.05, w: 2.3, speed: 0.0026, alpha: 0.55, blur: 27, flip: true },
  // through the middle
  { key: 'bank', y: 0.08, w: 2.0, speed: 0.0035, alpha: 0.62, blur: 24, flip: false },
  { key: 'wisp', y: 0.2, w: 2.1, speed: 0.0045, alpha: 0.68, blur: 21, flip: false },
  { key: 'bank', y: 0.32, w: 1.9, speed: 0.0057, alpha: 0.76, blur: 19, flip: true },
  // massed low — wisp only down here, it's the formless one
  { key: 'wisp', y: 0.46, w: 1.7, speed: 0.007, alpha: 0.82, blur: 17, flip: true },
  { key: 'wisp', y: 0.58, w: 1.6, speed: 0.0085, alpha: 0.88, blur: 15, flip: false },
  { key: 'wisp', y: 0.72, w: 1.5, speed: 0.0105, alpha: 0.9, blur: 14, flip: true },
];

// fog is over the whole frame now, so every row can be scratched
export const CLOUD_TOP = 0;

// mostly white, pushed gently toward lavender the way cloud sits against a warm sky
const TINT = 'rgba(196, 194, 224, 0.24)';

// The veil that sits over everything. This is the difference between "there is
// a cloud in this picture" and "this picture was taken in fog" — without it the
// sky stays crisp and the eye reads a hard boundary wherever the cloud stops.
const HAZE_TOP = 'rgba(238, 237, 248, 0.52)';
const HAZE_MID = 'rgba(235, 234, 246, 0.6)';
const HAZE_LOW = 'rgba(230, 229, 243, 0.66)';

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

/**
 * Bake one layer's scale, blur, flip and tint into its own canvas, once. Doing
 * any of that per frame — especially the blur — would be ruinous.
 */
function bake(img, drawW, blur, flip) {
  const scale = drawW / img.naturalWidth;
  const drawH = img.naturalHeight * scale;
  const pad = Math.ceil(blur * 2.5);

  const c = document.createElement('canvas');
  c.width = Math.ceil(drawW) + pad * 2;
  c.height = Math.ceil(drawH) + pad * 2;

  const x = c.getContext('2d');
  x.save();
  if (flip) {
    x.translate(c.width, 0);
    x.scale(-1, 1);
  }
  if (blur) x.filter = `blur(${blur}px)`;
  x.drawImage(img, pad, pad, drawW, drawH);
  x.restore();

  x.globalCompositeOperation = 'source-atop';
  x.fillStyle = TINT;
  x.fillRect(0, 0, c.width, c.height);
  x.globalCompositeOperation = 'source-over';

  return c;
}

export function createFog() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  let images = null;
  let baked = [];
  let w = 0;
  let h = 0;
  let dpr = 1;
  const start = performance.now();

  const ready = Promise.all(SPRITES.map((s) => loadImage(asset(s.src))))
    .then((loaded) => {
      images = {};
      SPRITES.forEach((s, i) => {
        images[s.key] = loaded[i];
      });
      if (w) rebake();
    })
    .catch((err) => console.error('[fog] could not load cloud sprites', err));

  function rebake() {
    if (!images || !w) return;
    baked = LAYERS.map((l) => {
      const drawW = w * l.w;
      const c = bake(images[l.key], drawW, l.blur * (w / 900), l.flip);
      return { ...l, canvas: c, drawW: c.width, drawH: c.height };
    });
  }

  return {
    canvas,
    ready,

    resize(nw, nh, ndpr) {
      w = nw;
      h = nh;
      // sprites are soft; rendering below device resolution costs nothing to look at
      dpr = Math.min(ndpr, 1.25);
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      rebake();
    },

    render() {
      if (!w) return;
      const t = (performance.now() - start) / 1000;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      for (const l of baked) {
        ctx.globalAlpha = l.alpha;
        // wrap the drift so the bank never runs out of cloud
        const span = l.drawW;
        let x = -((t * l.speed * w) % span);
        const top = h * l.y;
        while (x < w) {
          ctx.drawImage(l.canvas, x, top, l.drawW, l.drawH);
          x += span;
        }
      }
      ctx.globalAlpha = 1;

      // Everything sits under the same air, cloud and sky alike. Drawn last so
      // it veils the sprites too — that's what ties the frame together and
      // stops the eye finding an edge where the cloud runs out.
      const haze = ctx.createLinearGradient(0, 0, 0, h);
      haze.addColorStop(0, HAZE_TOP);
      haze.addColorStop(0.5, HAZE_MID);
      haze.addColorStop(1, HAZE_LOW);
      ctx.fillStyle = haze;
      ctx.fillRect(0, 0, w, h);
    },
  };
}
