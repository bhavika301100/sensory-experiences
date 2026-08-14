import './style.css';
import { computeStage } from './stage.js';
import { createPond } from './pond.js';
import { createHalftone } from './halftone.js';
import { createScratch } from './scratch.js';
import { createFire } from './fire.js';
import { prepare, unlock, audioState, isMuted, setMuted, setScene } from './audio.js';

const soundBtn = document.getElementById('sound');
const sections = [...document.querySelectorAll('.piece')];

const BUILDERS = { pond: createPond, halftone: createHalftone, scratch: createScratch, fire: createFire };

const pieces = sections.map((section) => {
  const kind = section.dataset.scene;
  return { section, kind, piece: BUILDERS[kind](section) };
});

/** The label states where the sound currently is, not what the click will do. */
function paintSoundBtn() {
  const on = !isMuted();
  const label = on ? 'sound on' : 'sound off';
  soundBtn.setAttribute('aria-pressed', String(on));
  soundBtn.setAttribute('aria-label', label);
  soundBtn.dataset.tip = label;
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
  paintSoundBtn();
  soundBtn.addEventListener('click', () => {
    setMuted(!isMuted());
    paintSoundBtn();
    if (!isMuted()) unlock();
  });

  for (const { section, piece } of pieces) {
    const replay = section.querySelector('.replay');
    if (replay && piece.reset) replay.addEventListener('click', () => piece.reset());
  }

  await Promise.all(pieces.map(({ piece }) => piece.start()));

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
        if (visible) setScene(found.kind);
      }
    },
    { threshold: [0, 0.5, 0.75] }
  );
  for (const { section } of pieces) io.observe(section);

  // Page theme follows the fire piece as it arrives: 0 is paper, 1 is night.
  // Tied to scroll rather than to the section becoming active, so the change is
  // something you watch happen rather than something that has happened.
  const fireSection = pieces.find((p) => p.kind === 'fire')?.section;
  const root = document.documentElement;

  const syncTheme = () => {
    if (!fireSection) return;
    const r = fireSection.getBoundingClientRect();
    const shown = window.innerHeight - r.top;
    const t = Math.max(0, Math.min(1, shown / Math.max(1, window.innerHeight)));
    root.style.setProperty('--dark', t.toFixed(3));
  };

  window.addEventListener('scroll', syncTheme, { passive: true });
  window.addEventListener('resize', syncTheme);
  syncTheme();

  const syncToViewport = () => {
    for (const { section, piece, kind } of pieces) {
      const r = section.getBoundingClientRect();
      const shown = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      const visible = shown > window.innerHeight * 0.5;
      piece.setRunning(visible);
      if (visible) setScene(kind);
    }
  };

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
