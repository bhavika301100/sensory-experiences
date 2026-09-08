// The final garden uses the edited flower footage as its texture and motion.
// Its dense, overlapping foliage is the artwork; CSS masks its photographic
// edge into the site's paper while this module owns the one-time emergence and
// pauses the loop whenever the footer is off screen.

import { asset } from './stage.js';

export function createFlowers(section) {
  const stage = section.querySelector('.flower-stage');
  const video = section.querySelector('.flower-video');
  const dissolve = section.querySelector('.flower-dissolve');
  const dissolveCtx = dissolve.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let running = false;
  let revealed = false;
  let revealStartedAt = 0;
  let revealFrame = 0;
  let width = 0;
  let height = 0;
  let noiseWidth = 0;
  let noiseHeight = 0;
  let noise = new Uint8Array(0);
  let noiseImage = null;

  const REVEAL_MS = 1600;

  function randomFor(index) {
    let value = (index + 1) * 0x9e3779b1;
    value ^= value >>> 16;
    value = Math.imul(value, 0x21f0aaad);
    value ^= value >>> 15;
    value = Math.imul(value, 0x735a2d97);
    value ^= value >>> 15;
    return (value >>> 0) / 4294967296;
  }

  function ease(value) {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  }

  function paperChannels() {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
    const channels = (value || '239, 238, 233').split(',').map((channel) => Number(channel.trim()));
    return channels.length === 3 && channels.every(Number.isFinite) ? channels : [239, 238, 233];
  }

  function paintClosed() {
    if (!noiseImage) return;
    const [red, green, blue] = paperChannels();
    const pixels = noiseImage.data;
    for (let i = 0; i < noise.length; i++) {
      const offset = i * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = 255;
    }
    dissolveCtx.putImageData(noiseImage, 0, 0);
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    // One mask pixel becomes two CSS pixels. The grain is small enough to read
    // as texture rather than as a collection of shapes, while the low backing
    // resolution keeps four seconds of threshold animation inexpensive.
    const grain = 2;
    noiseWidth = Math.ceil(width / grain);
    noiseHeight = Math.ceil(height / grain);
    dissolve.width = noiseWidth;
    dissolve.height = noiseHeight;
    dissolveCtx.imageSmoothingEnabled = false;
    noise = new Uint8Array(noiseWidth * noiseHeight);
    noiseImage = dissolveCtx.createImageData(noiseWidth, noiseHeight);

    const coarseWidth = Math.ceil(noiseWidth / 7);
    for (let y = 0; y < noiseHeight; y++) {
      for (let x = 0; x < noiseWidth; x++) {
        const index = y * noiseWidth + x;
        const coarseIndex = Math.floor(y / 7) * coarseWidth + Math.floor(x / 7);
        const fine = randomFor(index);
        const coarse = randomFor(coarseIndex + 500003);
        const fromBottom = 1 - y / Math.max(1, noiseHeight - 1);
        const threshold = Math.max(0, Math.min(1, fine * 0.76 + coarse * 0.14 + fromBottom * 0.1));
        noise[index] = Math.round(threshold * 255);
      }
    }

    if (revealed && performance.now() - revealStartedAt >= REVEAL_MS) {
      dissolveCtx.clearRect(0, 0, width, height);
      dissolve.hidden = true;
    } else {
      dissolve.hidden = false;
      drawDissolve(performance.now());
    }
  }

  function drawDissolve(now) {
    if (!revealed) {
      paintClosed();
      return false;
    }

    const progress = Math.max(0, Math.min(1, (now - revealStartedAt) / REVEAL_MS));
    if (progress >= 1 || reduceMotion.matches) {
      dissolveCtx.clearRect(0, 0, noiseWidth, noiseHeight);
      dissolve.hidden = true;
      return true;
    }

    const [red, green, blue] = paperChannels();
    const pixels = noiseImage.data;
    for (let i = 0; i < noise.length; i++) {
      const threshold = noise[i] / 255;
      const opacity = ease((threshold - progress + 0.075) / 0.15);
      const offset = i * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = Math.round(opacity * 255);
    }
    dissolveCtx.putImageData(noiseImage, 0, 0);
    return false;
  }

  function revealTick(now) {
    revealFrame = 0;
    if (!running) return;
    if (!drawDissolve(now)) revealFrame = requestAnimationFrame(revealTick);
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    revealStartedAt = performance.now();
    drawDissolve(revealStartedAt);
  }

  async function start() {
    video.src = asset('assets/flowers.mp4');
    video.load();
    resize();
  }

  return {
    start,
    resize,
    setRunning(next) {
      if (next === running) return;
      running = next;

      if (running) {
        reveal();
        if (!reduceMotion.matches) video.play().catch(() => {});
        cancelAnimationFrame(revealFrame);
        if (!drawDissolve(performance.now())) revealFrame = requestAnimationFrame(revealTick);
      } else {
        video.pause();
        cancelAnimationFrame(revealFrame);
        revealFrame = 0;
      }
    },
    debug: {
      get revealed() {
        return revealed;
      },
      get currentTime() {
        return video.currentTime;
      },
      get revealState() {
        if (!revealed) return 'waiting';
        return dissolve.hidden ? 'finished' : 'dissolving';
      },
      video,
    },
  };
}
