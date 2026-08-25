import './style.css';
import { computeStage } from './stage.js';
import { createPond } from './pond.js';
import { createHalftone } from './halftone.js';
import { createScratch } from './scratch.js';
import { createFire } from './fire.js';
import {
  prepare,
  unlock,
  audioState,
  isMuted,
  isAudioRunning,
  setMuted,
  setScene,
} from './audio.js';

const sections = [...document.querySelectorAll('.piece')];

const BUILDERS = { pond: createPond, halftone: createHalftone, scratch: createScratch, fire: createFire };

const pieces = sections.map((section) => {
  const kind = section.dataset.scene;
  return { section, kind, piece: BUILDERS[kind](section) };
});

/** Every local control reflects the one shared mute choice. */
function paintSoundBtns() {
  const on = !isMuted();
  const label = on ? 'sound on' : 'sound off';
  for (const soundBtn of document.querySelectorAll('.sound')) {
    soundBtn.setAttribute('aria-pressed', String(on));
    soundBtn.setAttribute('aria-label', label);
    soundBtn.dataset.tip = label;
  }
}

function resizeAll() {
  // A tab opened in the background can report a zero-size viewport while it
  // runs. Computing off that bakes in a 20px stage, and without this guard
  // nothing would put it right when the tab is finally shown.
  if (window.innerWidth < 50 || window.innerHeight < 50) return;
  computeStage();
  for (const { piece } of pieces) piece.resize();
}

async function init() {
  // a reload should open on the first piece, not wherever you happened to be
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);

  computeStage();

  let pending = 0;
  const scheduleResize = (delay = 120) => {
    clearTimeout(pending);
    pending = setTimeout(resizeAll, delay);
  };

  window.addEventListener('resize', () => scheduleResize());
  // fires when the viewport gains a real size — including a background tab
  // being shown for the first time, which `resize` alone does not cover
  new ResizeObserver(() => scheduleResize(60)).observe(document.documentElement);
  window.addEventListener('pageshow', () => scheduleResize(0));

  // decode up front so the very first tap has something to play
  prepare();
  paintSoundBtns();

  // Browsers can suspend first-load audio until a valid user gesture. The
  // preference still begins on, and playback resumes on the first interaction.
  const resumeOnGesture = async () => {
    if (!isMuted()) await unlock();
    paintSoundBtns();
    if (isAudioRunning()) {
      window.removeEventListener('pointerdown', resumeOnGesture, true);
      window.removeEventListener('pointerup', resumeOnGesture, true);
      window.removeEventListener('keydown', resumeOnGesture, true);
    }
  };
  window.addEventListener('pointerdown', resumeOnGesture, true);
  window.addEventListener('pointerup', resumeOnGesture, true);
  window.addEventListener('keydown', resumeOnGesture, true);

  // Reloads may retain browser permission from the previous page. If so, start
  // immediately; otherwise the gesture handler above takes over.
  if (!isMuted()) unlock().then(paintSoundBtns);

  for (const { section, piece, kind } of pieces) {
    const soundBtn = section.querySelector('.sound');
    if (soundBtn) {
      soundBtn.addEventListener('click', async () => {
        setScene(kind);
        const muted = setMuted(!isMuted());
        paintSoundBtns();
        if (!muted) await unlock();
      });
    }

    const replay = section.querySelector('.replay');
    if (replay && piece.reset) replay.addEventListener('click', () => piece.reset());
  }

  await Promise.all(pieces.map(({ piece }) => piece.start()));

  // Choose one owner for audio from actual visible pixels. This avoids
  // competing observer callbacks while snapping between two sections.
  const syncToViewport = () => {
    let active = null;
    let mostVisible = -1;

    for (const { section, piece, kind } of pieces) {
      const r = section.getBoundingClientRect();
      const shown = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      piece.setRunning(shown > window.innerHeight * 0.5);

      if (shown > mostVisible) {
        mostVisible = shown;
        active = kind;
      }
    }

    if (active && mostVisible > 0) setScene(active);
  };

  let sceneFrame = 0;
  const scheduleSceneSync = () => {
    if (sceneFrame) return;
    sceneFrame = requestAnimationFrame(() => {
      sceneFrame = 0;
      syncToViewport();
    });
  };

  window.addEventListener('scroll', scheduleSceneSync, { passive: true });
  window.addEventListener('resize', scheduleSceneSync);

  // Only the piece on screen animates, and only its bed plays. Both pieces run
  // a render loop and one of them decodes video, so leaving the off-screen one
  // going would cost for nothing.
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const found = pieces.find((p) => p.section === entry.target);
        if (!found) continue;
        const visible = entry.isIntersecting && entry.intersectionRatio > 0.5;
        found.piece.setRunning(visible);
      }
    },
    { threshold: [0, 0.5, 0.75] }
  );
  for (const { section } of pieces) io.observe(section);
  syncToViewport();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      for (const { piece } of pieces) piece.setRunning(false);
    } else {
      // the observer won't re-fire on its own — nothing intersected differently
      syncToViewport();
    }
  });

  if (import.meta.env.DEV) {
    window.__pond = {
      ...pieces[0].piece.debug,
      halftone: pieces[1].piece.debug,
      scratch: pieces[2].piece.debug,
      fire: pieces[3].piece.debug,
      audioState,
      setScene,
      sections,
    };
  }
}

init();
