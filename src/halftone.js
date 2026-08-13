// The halftone piece. The video is drawn to a canvas rather than shown directly,
// so it can take the same feathered edge as the water — and so the lens can
// redraw one square of it in monotone.

import { stage, featherMask, asset, coverRect as fitCover } from './stage.js';

const LENS = 200; // px, as asked
const FOLLOW = 0.32; // cursor lerp per frame — enough to smooth, not enough to lag

// A magnifying glass: the cell shows a ZOOM-times smaller patch of the frame,
// blown up to fill it. Even magnification throughout, no barrel distortion.
const ZOOM = 2;

export function createHalftone(section) {
  const stageEl = section.querySelector('.stage');
  const video = section.querySelector('video');
  const canvas = section.querySelector('canvas.fg');
  const ctx = canvas.getContext('2d');

  let w = 0;
  let h = 0;
  let dpr = 1;
  let mask = null;

  let running = false;
  let rafId = 0;

  let hovering = false;
  let lensAlpha = 0;
  const cursor = { x: 0, y: 0 };
  const lens = { x: 0, y: 0, seeded: false };

  // The lens is composed off-screen so the monotone filter is applied once to
  // the finished square, rather than once per ring.
  const lensCanvas = document.createElement('canvas');
  const lensCtx = lensCanvas.getContext('2d');
  const probe = {}; // what the last lens draw actually did, for verification

  function resize() {
    w = stage.w;
    h = stage.h;
    dpr = stage.dpr;

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    lensCanvas.width = Math.round(LENS * dpr);
    lensCanvas.height = Math.round(LENS * dpr);

    mask = featherMask(w, h, stage.feather, stage.radius);
  }

  const coverRect = () => fitCover(video.videoWidth, video.videoHeight, w, h);

  /** Paints the magnified square off-screen, ready to be tinted in one pass. */
  function drawLens(cover, lx, ly) {
    const half = LENS / 2;
    const cx = lx + half;
    const cy = ly + half;
    const kx = cover.sw / w;
    const ky = cover.sh / h;

    // sample a patch ZOOM times smaller than the cell and blow it up to fill it
    const reach = half / ZOOM;

    lensCtx.setTransform(1, 0, 0, 1, 0, 0);
    lensCtx.clearRect(0, 0, lensCanvas.width, lensCanvas.height);
    lensCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lensCtx.drawImage(
      video,
      cover.sx + (cx - reach) * kx,
      cover.sy + (cy - reach) * ky,
      reach * 2 * kx,
      reach * 2 * ky,
      0,
      0,
      LENS,
      LENS
    );

    probe.reach = reach;
    probe.magnification = LENS / (reach * 2);
    probe.sampled = [Math.round(cx - reach), Math.round(cx + reach)];
  }

  function frame() {
    if (!running) return;

    const cover = coverRect();
    if (cover && video.readyState >= 2) {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(video, cover.sx, cover.sy, cover.sw, cover.sh, 0, 0, w, h);

      const target = hovering ? 1 : 0;
      lensAlpha += (target - lensAlpha) * 0.18;

      if (!lens.seeded && hovering) {
        lens.x = cursor.x;
        lens.y = cursor.y;
        lens.seeded = true;
      }
      lens.x += (cursor.x - lens.x) * FOLLOW;
      lens.y += (cursor.y - lens.y) * FOLLOW;

      if (lensAlpha > 0.004) {
        const lx = lens.x - LENS / 2;
        const ly = lens.y - LENS / 2;
        drawLens(cover, lx, ly);

        ctx.save();
        ctx.globalAlpha = lensAlpha;
        ctx.filter = 'grayscale(1) contrast(1.08)';
        ctx.drawImage(lensCanvas, lx, ly, LENS, LENS);
        ctx.filter = 'none';

        // a dark line just outside a light one, so the edge of the cell reads
        // whether it lands on the bright sky or the dark water
        ctx.lineWidth = 1;
        ctx.globalAlpha = lensAlpha * 0.4;
        ctx.strokeStyle = 'rgba(18, 20, 24, 0.9)';
        ctx.strokeRect(lx - 0.5, ly - 0.5, LENS + 1, LENS + 1);

        ctx.globalAlpha = lensAlpha * 0.75;
        ctx.strokeStyle = 'rgba(250, 250, 248, 0.95)';
        ctx.strokeRect(lx + 0.5, ly + 0.5, LENS - 1, LENS - 1);
        ctx.restore();
      }

      // same dissolve as the water, so the two pieces sit on the page alike
      if (mask) {
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(mask, 0, 0, w, h);
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    rafId = requestAnimationFrame(frame);
  }

  function trackPointer(e) {
    const r = stageEl.getBoundingClientRect();
    cursor.x = e.clientX - r.left;
    cursor.y = e.clientY - r.top;
  }

  async function start() {
    resize();

    video.muted = true; // required for autoplay, and the music is the soundtrack
    video.loop = true;
    video.playsInline = true;
    if (!video.src) video.src = asset('assets/halftone.mp4');

    try {
      await video.play();
    } catch {
      // some browsers still want a gesture; take the first one going
      const kick = () => {
        video.play().catch(() => {});
        window.removeEventListener('pointerdown', kick);
      };
      window.addEventListener('pointerdown', kick);
    }

    stageEl.addEventListener('pointerenter', (e) => {
      hovering = true;
      trackPointer(e);
    });
    stageEl.addEventListener('pointermove', trackPointer);
    stageEl.addEventListener('pointerleave', () => {
      hovering = false;
      lens.seeded = false;
    });

    canvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1200, easing: 'ease-out' });
  }

  return {
    start,
    resize,
    setRunning(next) {
      if (next === running) return;
      running = next;
      if (running) {
        video.play().catch(() => {});
        rafId = requestAnimationFrame(frame);
      } else {
        cancelAnimationFrame(rafId);
        video.pause();
      }
    },
    debug: {
      probe,
      lens,
      cursor,
      get hovering() {
        return hovering;
      },
      get lensAlpha() {
        return lensAlpha;
      },
      video,
    },
  };
}
