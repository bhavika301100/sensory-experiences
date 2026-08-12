# sensory experiences

Two interactive pieces, scroll-snapped one per screen, presented alike: each
sits on the same stage — a rounded rect at 65% of the viewport dissolving into
warm paper — with its title bottom-left and its instruction bottom-right.

1. **koi fish pond** — one koi to start. Tap the water and another arrives,
   fading in, rippling the surface, dripping. Press `feed` and the whole pond
   converges on the food, then fans out again.
2. **oh, to be young and free** — a halftone video. Hover it and a 150×150
   magnifier follows the cursor, showing that square of the frame enlarged and
   in monotone.

```bash
npm install
npm run dev
```

## deploying

Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. Set **Settings → Pages → Source** to
*GitHub Actions* once, and it's automatic after that.

Vite's `base` is `'./'`, so the built site works at any path — a project page
under `/<repo>/`, a user page at `/`, or a custom domain — without the repo name
being written into anything. Files in `public/` are resolved through `asset()`
in `stage.js` for the same reason; a bare `/assets/…` would 404 on a project
page.

## how the page is put together

| file | |
| --- | --- |
| `stage.js` | the shared geometry every piece is presented in, plus the feather mask |
| `pond.js` | piece one |
| `halftone.js` | piece two |
| `audio.js` | one graph for both pieces, one toggle, crossfaded by scene |
| `main.js` | builds the pieces, runs only the one on screen |

Each piece exposes `start / resize / setRunning`. An IntersectionObserver runs
only the piece you're looking at and hands the soundtrack over to it — both
pieces render every frame and one of them decodes video, so leaving the
off-screen one going would cost for nothing. Coordinates are stage-local: the
canvases *are* the stage box, so nothing has to reason about page scroll.

## how it behaves

| interaction | what happens |
| --- | --- |
| tap the water | a koi fades in over ~2.8s, a soft ripple spreads, `drip.mp3` plays |
| past 12 koi | tapping still always adds — the eldest waits ~1.2s then dissolves into the water over 2.6s, still swimming as it goes |
| `feed` | 7–22 dots scatter; every koi rushes, eats, then **fans out on its own bearing** — evenly spaced angles with jitter, so they genuinely scatter instead of drifting off together |
| a koi rushing | leaves a wake and plays a slice of `swim.mp3` |
| always | a synthesised still-water bed sits low under everything |

Koi vary in **size only** — noticeably different ages (roughly 0.66× to 1.4×),
with the bigger ones cruising slightly slower. Every fish is the same red as
the source SVG.

They also hold their distance: soft mutual repulsion keeps nearest-neighbour
spacing around 120–170px rather than clumping. Steering alone couldn't do it
(two fish pointed at each other just orbit), so there's a gentle positional
drift on top — invisible at this magnitude, but it actually resolves clumps.

## layout

The pond is a 16px-radius rect taking `POND_FRACTION` (0.6) of the viewport in
each direction, centred, with the 20% bands above and below carrying the sound
toggle and the footer — `koi fish pond` left, `feed` centred, `tap the water`
right — all on the paper, in dark ink. Taps on the paper are ignored; only the
water stocks the pond.

`resize()` publishes the pond's **visible** edges as `--pond-left/-width/-top/
-bottom`. Visible, not geometric: the water fades out across the feather, so its
rect edge is not the edge you see. The published contour is inset by half the
feather — where alpha passes 50% — which is what the type actually lines up with.

Everything sits `--gap` (8px) off the water: the header band ends 8px above it
with the icon at its foot, the footer starts 8px below with its rows pinned to
the top. The sound icon is 16px with padding around it purely as touch target,
cancelled by negative margins so it's the *icon* — not its hit box — that lands
on those edges. The footer labels centre against the taller feed button, so
their cap height sits a little below the button's 8px.

Below 560px there isn't room for label + button + label on one line, and since a
`1fr` track is `minmax(auto, 1fr)` the nowrap labels force the side columns wide
and shove the button off the pond's axis. The footer becomes two rows there:
button centred above, labels still pinned to the edges.

Koi are sized off the pond rather than the viewport, so the school keeps its
proportions when the water changes size.

## the water and the edge

The pond dissolves into warm paper (`#efeee9`). The fade is a smooth ramp on the
distance to the rect — deliberately **no noise on the distance field**, since
roughening it scallops the boundary into a torn stamp instead of a soft blend.

That distance needs care: a rectangle's true SDF has a gradient discontinuity
along the diagonals running out of each corner, and fading over a wide band
turns it into four visible creases — a bevelled picture-frame. `pondDepth()`
softens the inner `min` to remove them while the corner term still applies the
real 16px radius.

A single grain overlay sits above water and paper alike so the two read as one
surface.

The koi canvas is masked with the same rounded rect, pulled slightly inside the
water's own fade so a fish can never end up floating on the paper.

The hand-written WebGL water is the default. Your shaders.com preset is still
one flag away:

```
http://localhost:5183/?water=shaders
```

That path needs live network and WebGPU, and on the free preview tier renders a
tiled "shaders" watermark plus a corner licence link — both left untouched. The
shaders runtime is behind a dynamic `import()`, so by default its 2.7 MB never
downloads; the app's own code is ~20 KB.

## the halftone piece

The video is drawn to a canvas rather than shown directly, so it can take the
same feathered edge as the water and so the lens can redraw one square of it.
Each frame: the video cover-fitted into the stage, then the lens, then the
shared feather mask.

The lens is a magnifying glass — it samples a patch `ZOOM` times smaller than
the cell and blows it up to fill it, evenly, no barrel distortion. It's composed
into its own small canvas first so `grayscale(1)` is applied once to the
finished square. Its outline is a dark line just outside a light one, so the
cell reads against both the bright sky and the dark water.

`LENS`, `ZOOM` and `FOLLOW` in `halftone.js` control its size, magnification and
how tightly it tracks the cursor. Cost is about 0.03ms a frame all in, measured
— the whole piece is three `drawImage` calls.

**The video is 42 MB for 6.9s (~48 Mbps).** Fine over localhost, heavy over a
network — worth re-encoding before this goes anywhere public. There was no
ffmpeg on the machine to do it here.

The stage crops the video to fill (your call: match the pond's box exactly).
On a desktop the stage is near-square so the crop is mild. On a **portrait
phone** the stage is roughly 244×528, which cuts about three quarters of the
frame's width. If that's not wanted, the fix is in `coverRect()` in
`halftone.js` — fit instead of fill when the stage is taller than the video.

## audio

The AudioContext is built and every file decoded at **page load**, not on first
gesture. Doing it on the gesture meant `unlock()` kicked off the fetch and
decode while `playDrip()` ran on that same tap against a still-null buffer — so
the first fish arrived silently every time. The context starts suspended (no
browser lets it run without a gesture) and `unlock()` just resumes it. If a
sound is somehow asked for before its buffer lands, it's held and fired on
arrival, provided that's within 1.5s so it still belongs to the gesture.

The sound toggle sits top-right, aligned to the pond's edge. The label states
where the sound *is* (`sound on` / `sound off`), not what the click will do, and
the choice persists in `localStorage`.

Each piece owns a bed — the pond's synthesised still water, the halftone's
looping `music.m4a` — and only one is ever up. Scrolling between them crossfades
over `CROSSFADE` seconds via `setScene()`, so you never hear both at once.

Muting ramps the master gain down — a ramp, not a step, so it doesn't click —
and then **suspends the context**. Gain alone leaves the still-water bed running
and merely inaudible; sound off should mean off. `playDrip`/`playSwim` also bail
out while muted: starting sources on a suspended context would queue them all to
fire at once on unmute.

- `drip.mp3` (1.3s) — plays whole, with a randomised rate so repeats don't
  sound identical.
- `swim.mp3` (18.6s, one continuous take) — each fish pass plays a random
  0.5–0.9s window with its own envelope, so it never sounds retriggered.
- the still-water bed is **synthesised**, not a file: brown noise through a
  lowpass whose cutoff drifts on a slow LFO. You didn't attach an ambience
  track. Swap it for a recording in `startAmbience()` if you'd rather.

Two things keep that bed continuous, both of which it originally got wrong.
Tapering the noise buffer's ends to zero does not hide the loop point, it
*creates* one — measured at **−12 dB every 4 seconds**. The buffer now folds its
tail back over its head with an equal-power crossfade (√k / √(1−k), so two
uncorrelated noise streams sum to constant power instead of sagging 3 dB through
the middle); measured **+0.1 dB** across the seam. And there is no LFO on the
level: an amplitude swell is heard as the bed dropping away and coming back. The
cutoff drift supplies the movement, as timbre rather than loudness.

## how the koi swim

The SVG is rasterised once, cropped tight to its ink via `getBBox`, knocked
back to `brightness(0.84) saturate(0.9)` so it sits in the water rather than
glaring off it, plus a pre-blurred black copy for the shadow.

The shadow is drawn in its own transform, offset in **world** space. Nudging it
inside the fish's rotated frame swung the light around with the fish; now it
falls the same way whichever way the koi points. It also has to clear the body
to read at all — tucked underneath, it disappeared entirely once the water was
lightened. `SHADOW_OFFSET` and `SHADOW_ALPHA` in `koi.js` control it.

Each frame the head and front 42% draw rigid, and the rear body is sliced into
30 horizontal strips whose offsets follow a travelling sine. Offsetting strips
alone leaves a hard staircase on a tail this long and thin, so **each strip is
also sheared by the local slope of the wave** — consecutive strips meet edge to
edge and the tail reads as one continuous ribbon.

Those strips overlap slightly so no seam shows. That's invisible at full
opacity, but a *translucent* fish composites every overlap twice and the seams
darken into bands — right on the two moments that matter, arriving and
dissolving. So a fading koi is painted opaque into a scratch buffer first and
that buffer is faded as one piece.

Idle heading uses an Ornstein–Uhlenbeck drift on turn rate (lazy arcs, no
jitter), with a soft inward steer near the rim.

The rim push is **blended** into the steering, never substituted for it. When it
used to override, a fish inside the avoidance band (17% of the pond — right
where food scatters) could not steer at a pellet at all: it orbited forever, the
food was never eaten and the feed button stayed disabled for the rest of the
session. The band also narrows while feeding. `STALL_TIMEOUT` in `main.js` is a
backstop that clears uneaten food after 25s of nothing being eaten.

Ripples are diffuse radial halos with no opaque stop — stroked circles read as
hard concentric lines on water, which is exactly what you don't want.

## tuning

| constant | file | |
| --- | --- | --- |
| `MAX_KOI` | `main.js` | 12 before the eldest starts dissolving |
| `DISSOLVE_DELAY` | `main.js` | 1150ms grace before it begins |
| `margin` / `feather` / `radius` | `main.js` `resize()` | the pond shape and how far it dissolves |
| `R` in `computeSeparation` | `main.js` | how far apart they hold |
| `sizeVar` | `koi.js` | size spread across the school |
| `AMBIENCE_GAIN` | `audio.js` | the still-water bed |

`window.__pond` is exposed in dev (`kois`, `pellets`, `world`, `addKoi`,
`scatterFood`, `audioState`, `Ripple`) for poking at it from the console.
