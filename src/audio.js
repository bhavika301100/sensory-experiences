// The AudioContext is created and the files decoded at page load, so the very
// first tap already has buffers to play. The context starts suspended (browsers
// won't let it run without a gesture); unlock() resumes it.

import { asset } from './stage.js';

const AMBIENCE_GAIN = 0.05; // the still-water bed, deliberately far back
const MUSIC_GAIN = 0.5; // the halftone piece's soundtrack
const DRIP_GAIN = 0.62;
const SWIM_GAIN = 0.22;
const REVEAL_GAIN = 0.25; // your reveal clip, at about a third of its original level
const WIND_GAIN = 0.13; // peak of the gust when sweeping hard
const WIND_BED_GAIN = 0.011; // the calm wind that's just always there — barely perceptible
const CROSSFADE = 1.4; // s to hand over between pieces
const MUTE_KEY = 'koi-pond:muted';

let ctx = null;
let master = null;
let ready = null;
let buffers = { drip: null, swim: null, music: null, reveal: null };
let scratch = null; // lazily built noise rig for the scratch piece
let ambienceStarted = false;
let muted = false;
let suspendTimer = 0;

// each piece owns a bed; only one is ever up
let ambienceGain = null;
let musicGain = null;
let musicSource = null;
let windBedGain = null;
let scene = 'pond';

try {
  muted = localStorage.getItem(MUTE_KEY) === '1';
} catch {
  muted = false;
}

async function load(url) {
  const res = await fetch(url);
  const data = await res.arrayBuffer();
  return ctx.decodeAudioData(data);
}

/**
 * 8 seconds of seamlessly looping brown noise.
 *
 * Tapering both ends of the buffer to zero does NOT hide the loop point — it
 * creates one, dipping the bed to silence on every wrap. Instead we generate a
 * little extra and fold the tail back over the head with an equal-power
 * crossfade (√k / √(1−k), so two uncorrelated noise streams sum to constant
 * power rather than sagging 3dB through the middle). Level stays flat across
 * the seam and there's nothing to hear.
 */
function brownNoiseBuffer() {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 8);
  const wrap = Math.floor(sr * 1.5);

  const raw = new Float32Array(len + wrap);
  let last = 0;
  for (let i = 0; i < raw.length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    raw[i] = last * 3.5;
  }

  const buf = ctx.createBuffer(1, len, sr);
  const ch = buf.getChannelData(0);
  ch.set(raw.subarray(0, len));
  for (let i = 0; i < wrap; i++) {
    const k = i / wrap;
    ch[i] = raw[i] * Math.sqrt(k) + raw[len + i] * Math.sqrt(1 - k);
  }
  return buf;
}

function startAmbience() {
  const src = ctx.createBufferSource();
  src.buffer = brownNoiseBuffer();
  src.loop = true;

  // lowpass with a slow-drifting cutoff -> water that moves without splashing
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 380;
  lp.Q.value = 0.6;

  const cutoffLfo = ctx.createOscillator();
  cutoffLfo.frequency.value = 0.045;
  const cutoffDepth = ctx.createGain();
  cutoffDepth.gain.value = 150;
  cutoffLfo.connect(cutoffDepth).connect(lp.frequency);

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 55;

  const gain = ctx.createGain();
  gain.gain.value = 0;

  // No swell on the level — an amplitude LFO here is heard as the bed dropping
  // away and coming back. The cutoff drift above already gives it movement,
  // as a change in timbre rather than in loudness, so the volume stays put.
  src.connect(lp).connect(hp).connect(gain).connect(master);

  src.start();
  cutoffLfo.start();

  ambienceGain = gain;
  applyScene();
}

function startMusic() {
  if (musicSource || !buffers.music || !ctx) return;

  musicSource = ctx.createBufferSource();
  musicSource.buffer = buffers.music;
  musicSource.loop = true;

  musicGain = ctx.createGain();
  musicGain.gain.value = 0;

  musicSource.connect(musicGain).connect(master);
  musicSource.start();
  applyScene();
}

/**
 * The fog piece's bed: calm, constant wind, sitting under everything the whole
 * time you're on the piece. The gust from scratching rides on top of this —
 * this one never reacts to anything, it's just the air being there.
 */
function startWindBed() {
  if (windBedGain || !ctx || muted) return;

  const src = ctx.createBufferSource();
  src.buffer = whiteNoiseBuffer();
  src.loop = true;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 440;
  lp.Q.value = 0.7;

  // the cutoff wanders so it breathes, but the level never moves — an
  // amplitude swell would be heard as the wind dropping out
  const drift = ctx.createOscillator();
  drift.frequency.value = 0.037;
  const depth = ctx.createGain();
  depth.gain.value = 170;
  drift.connect(depth).connect(lp.frequency);

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 90;

  const gain = ctx.createGain();
  gain.gain.value = 0;

  src.connect(lp).connect(hp).connect(gain).connect(master);
  src.start();
  drift.start();

  windBedGain = gain;
  applyScene();
}

/** Hand the bed over to whichever piece is on screen. Only one is ever up. */
function applyScene() {
  if (!ctx) return;
  const t = ctx.currentTime;
  // setTargetAtTime is exponential; a third of the crossfade as the time
  // constant lands it ~95% of the way there in CROSSFADE seconds
  const tau = CROSSFADE / 3;

  if (ambienceGain) {
    ambienceGain.gain.cancelScheduledValues(t);
    ambienceGain.gain.setTargetAtTime(scene === 'pond' ? AMBIENCE_GAIN : 0, t, tau);
  }
  if (musicGain) {
    musicGain.gain.cancelScheduledValues(t);
    musicGain.gain.setTargetAtTime(scene === 'halftone' ? MUSIC_GAIN : 0, t, tau);
  }
  if (windBedGain) {
    windBedGain.gain.cancelScheduledValues(t);
    windBedGain.gain.setTargetAtTime(scene === 'scratch' ? WIND_BED_GAIN : 0, t, tau);
  }
}

export function setScene(next) {
  if (scene === next) return;
  scene = next;
  if (!muted) {
    ensureAmbience();
    startMusic();
    startWindBed();
  }
  applyScene();
}

export function getScene() {
  return scene;
}

function connectThrough(node, x) {
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.7, Math.min(0.7, (x / window.innerWidth) * 2 - 1)) * 0.6;
    node.connect(p).connect(master);
  } else {
    node.connect(master);
  }
}

/** Build the graph and start decoding. Safe to call at page load. */
export function prepare() {
  if (ctx) return ready;

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return Promise.resolve();

  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 1;
  master.connect(ctx.destination);

  ready = Promise.all([
    load(asset('assets/drip.mp3')).catch(() => null),
    load(asset('assets/swim.mp3')).catch(() => null),
    load(asset('assets/music.m4a')).catch(() => null),
    load(asset('assets/reveal.mp3')).catch(() => null),
  ]).then(([drip, swim, music, reveal]) => {
    buffers = { drip, swim, music, reveal };
    if (!muted && scene === 'halftone') startMusic();
  });

  return ready;
}

function ensureAmbience() {
  if (ambienceStarted || muted || !ctx) return;
  ambienceStarted = true;
  startAmbience();
}

/** Resume on a user gesture and bring the current piece's bed up. */
export async function unlock() {
  prepare();
  if (!ctx || muted) return;
  if (ctx.state === 'suspended') await ctx.resume();
  ensureAmbience();
  startMusic();
  startWindBed();
}

/**
 * If the buffer isn't decoded yet — only really possible on the very first tap —
 * the sound is held and fired the moment it lands, provided that happens soon
 * enough to still belong to the gesture that asked for it.
 */
function whenReady(play) {
  if (!ready) return;
  const asked = performance.now();
  ready.then(() => {
    if (performance.now() - asked < 1500) play();
  });
}

function emitDrip(x) {
  const src = ctx.createBufferSource();
  src.buffer = buffers.drip;
  src.playbackRate.value = 0.9 + Math.random() * 0.25;

  const gain = ctx.createGain();
  gain.gain.value = DRIP_GAIN * (0.8 + Math.random() * 0.4);

  src.connect(gain);
  connectThrough(gain, x);
  src.start();
}

export function playDrip(x = window.innerWidth / 2) {
  // not just inaudible: starting sources on a suspended context would queue
  // them all up to fire at once on unmute
  if (!ctx || muted) return;
  if (!buffers.drip) {
    whenReady(() => buffers.drip && emitDrip(x));
    return;
  }
  emitDrip(x);
}

/**
 * The touching-the-water recording is one continuous take, so each fish pass
 * grabs a short random window of it with its own envelope. That way repeated
 * plays never sound like the same sample retriggering.
 */
export function playSwim(x = window.innerWidth / 2, intensity = 1) {
  if (!ctx || muted || !buffers.swim) return;

  const buf = buffers.swim;
  const dur = 0.5 + Math.random() * 0.4;
  if (buf.duration <= dur + 0.1) return;

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = 0.94 + Math.random() * 0.16;

  const gain = ctx.createGain();
  const peak = SWIM_GAIN * intensity * (0.7 + Math.random() * 0.5);
  const now = ctx.currentTime;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(peak, now + 0.07);
  gain.gain.setValueAtTime(peak, now + dur * 0.6);
  gain.gain.linearRampToValueAtTime(0, now + dur);

  src.connect(gain);
  connectThrough(gain, x);
  src.start(now, Math.random() * (buf.duration - dur - 0.05), dur + 0.05);
}

/** White noise, wrapped the same way as the ambience so the loop is seamless. */
function whiteNoiseBuffer(seconds = 3) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const wrap = Math.floor(sr * 0.4);

  const raw = new Float32Array(len + wrap);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.random() * 2 - 1;

  const buf = ctx.createBuffer(1, len, sr);
  const ch = buf.getChannelData(0);
  ch.set(raw.subarray(0, len));
  for (let i = 0; i < wrap; i++) {
    const k = i / wrap;
    ch[i] = raw[i] * Math.sqrt(k) + raw[len + i] * Math.sqrt(1 - k);
  }
  return buf;
}

/**
 * Wind, for sweeping the cloud off.
 *
 * Two layers, because one band of noise sounds like a hairdryer: a low body
 * that carries the weight of moving air, and a resonant upper band that gives
 * it the thin edge wind gets around an obstacle. Both open up as the hand
 * speeds up — louder, brighter, and the top band climbs — so a slow drag is a
 * breath and a fast sweep is a gust.
 */
function ensureWindRig() {
  if (scratch || !ctx || muted) return scratch;

  const src = ctx.createBufferSource();
  src.buffer = whiteNoiseBuffer();
  src.loop = true;

  const body = ctx.createBiquadFilter();
  body.type = 'lowpass';
  body.frequency.value = 420;
  body.Q.value = 0.9;
  const bodyGain = ctx.createGain();
  bodyGain.gain.value = 0;

  const edge = ctx.createBiquadFilter();
  edge.type = 'bandpass';
  edge.frequency.value = 900;
  edge.Q.value = 1.6;
  const edgeGain = ctx.createGain();
  edgeGain.gain.value = 0;

  src.connect(body).connect(bodyGain).connect(master);
  src.connect(edge).connect(edgeGain).connect(master);
  src.start();

  scratch = { body, bodyGain, edge, edgeGain };
  return scratch;
}

/** @param {number} speed 0..1, how fast the hand is sweeping. */
export function windGust(speed) {
  if (!ctx || muted) return;
  const rig = ensureWindRig();
  if (!rig) return;

  const v = Math.max(0, Math.min(1, speed));
  const now = ctx.currentTime;

  // rises quickly, falls away a little slower — the tail of a gust
  rig.bodyGain.gain.setTargetAtTime(v * WIND_GAIN, now, 0.07);
  rig.edgeGain.gain.setTargetAtTime(v * v * WIND_GAIN * 0.55, now, 0.09);
  rig.body.frequency.setTargetAtTime(360 + v * 900, now, 0.12);
  rig.edge.frequency.setTargetAtTime(750 + v * 1700, now, 0.12);
}

export function windStop() {
  if (!ctx || !scratch) return;
  const now = ctx.currentTime;
  scratch.bodyGain.gain.setTargetAtTime(0, now, 0.18);
  scratch.edgeGain.gain.setTargetAtTime(0, now, 0.14);
}

/** Your reveal clip, straight — just turned down. */
export function playReveal() {
  if (!ctx || muted || !buffers.reveal) return;
  const src = ctx.createBufferSource();
  src.buffer = buffers.reveal;
  const gain = ctx.createGain();
  gain.gain.value = REVEAL_GAIN;
  src.connect(gain).connect(master);
  src.start();
}

export function isMuted() {
  return muted;
}

export function setMuted(next) {
  muted = next;
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* private mode — the toggle still works for this session */
  }
  if (!ctx || !master) return muted;

  // short ramp rather than a step, so muting doesn't click
  master.gain.cancelScheduledValues(ctx.currentTime);
  master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.04);

  clearTimeout(suspendTimer);
  if (muted) {
    // Once the ramp has run, stop the graph outright. Gain alone leaves the
    // still-water bed running and merely inaudible; sound off should mean off.
    suspendTimer = setTimeout(() => {
      if (muted && ctx.state === 'running') ctx.suspend();
    }, 300);
  } else if (ctx.state === 'suspended') {
    ctx.resume().then(() => {
      ensureAmbience();
      startMusic();
      startWindBed();
    });
  } else {
    ensureAmbience();
    startMusic();
    startWindBed();
  }

  return muted;
}

/** Inspection hook — the render loop never calls this. */
export function audioState() {
  return {
    muted,
    scene,
    ambienceStarted,
    musicStarted: !!musicSource,
    masterGain: master ? +master.gain.value.toFixed(4) : null,
    ambienceLevel: ambienceGain ? +ambienceGain.gain.value.toFixed(4) : null,
    musicLevel: musicGain ? +musicGain.gain.value.toFixed(4) : null,
    windBedLevel: windBedGain ? +windBedGain.gain.value.toFixed(4) : null,
    contextState: ctx?.state ?? null,
    sampleRate: ctx?.sampleRate ?? null,
    dripSeconds: buffers.drip ? +buffers.drip.duration.toFixed(2) : null,
    swimSeconds: buffers.swim ? +buffers.swim.duration.toFixed(2) : null,
    musicSeconds: buffers.music ? +buffers.music.duration.toFixed(2) : null,
  };
}
