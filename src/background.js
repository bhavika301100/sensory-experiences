// The pond surface. The hand-written water is the default now; the shaders.com
// preset is still reachable with ?water=shaders for comparison.

const SHADER_ID = 'dfb68960-9443-4e14-891b-9031a68ee305';

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;

// rounded-rect pond, all in device pixels
uniform vec2 uPondC;
uniform vec2 uPondH;
uniform float uPondR;
uniform float uFeather;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

/**
 * Distance from the boundary, inward, for a rounded rect.
 *
 * The exact SDF would be min(max(q.x,q.y),0) + length(max(q,0)) - r, but a
 * rectangle's distance field has a gradient discontinuity along the diagonals
 * running out of each corner. Fading over a band this wide turns that into four
 * visible diagonal creases — a bevelled picture-frame look. Softening the inner
 * min removes them; the corner term still applies the true radius.
 */
float pondDepth(vec2 p, vec2 b, float r, float k) {
  vec2 e = b - abs(p);
  float depth = smin(e.x, e.y, k);

  vec2 q = abs(p) - b + r;
  if (q.x > 0.0 && q.y > 0.0) depth = min(depth, r - length(q));
  return depth;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uTime * 0.045;

  // two rounds of domain warping -> slow, unrepeating water movement
  vec2 q = vec2(fbm(uv * 2.2 + t), fbm(uv * 2.2 + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(uv * 2.6 + 3.0 * q + vec2(1.7, 9.2) + t * 1.4),
                fbm(uv * 2.6 + 3.0 * q + vec2(8.3, 2.8) - t * 1.1));
  float f = fbm(uv * 2.0 + 2.4 * r);

  // pulled ~20% toward their own luminance — still blue, less saturated
  vec3 deep = vec3(0.165, 0.260, 0.357);
  vec3 mid  = vec3(0.253, 0.372, 0.482);
  vec3 shal = vec3(0.352, 0.477, 0.593);

  vec3 col = mix(deep, mid, smoothstep(0.22, 0.80, f));
  col = mix(col, shal, smoothstep(0.50, 0.98, length(r)) * 0.38);

  // dappled light, kept faint — strong caustics read as marble, not water
  float c = fbm(uv * 5.0 + r * 2.0 + vec2(0.0, t * 2.0));
  c = pow(abs(1.0 - abs(c * 2.0 - 1.0)), 8.0);
  col += vec3(0.68, 0.75, 0.83) * c * 0.055;

  float c2 = fbm(uv * 8.5 - r * 1.5 + vec2(t * 1.6, 0.0));
  c2 = pow(abs(1.0 - abs(c2 * 2.0 - 1.0)), 14.0);
  col += vec3(0.72, 0.79, 0.87) * c2 * 0.028;

  // a little tooth in the water itself; the page grain sits on top of this
  col += (hash(gl_FragCoord.xy + fract(uTime) * 13.0) - 0.5) * 0.012;

  // gentle depth toward the middle, kept light so it doesn't fight the edge
  float vig = smoothstep(1.45, 0.30, length(uv * vec2(uRes.x / uRes.y, 1.0) * 0.85));
  col *= 0.86 + 0.14 * vig;

  // Dissolve into the paper: a clean smooth ramp running inward from the
  // rounded-rect boundary. Deliberately no noise on the distance field —
  // roughening it scallops the edge into a torn stamp. The page grain overlay
  // supplies the texture, uniformly across water and paper alike.
  float depth = pondDepth(gl_FragCoord.xy - uPondC, uPondH, uPondR, uFeather * 0.6);
  float e = clamp(depth / uFeather, 0.0, 1.0);
  float alpha = e * e * e * (e * (e * 6.0 - 15.0) + 10.0);
  if (alpha <= 0.002) discard;

  gl_FragColor = vec4(col * alpha, alpha);
}
`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
  }
  return sh;
}

function startLocalWater(canvas, world) {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: true, premultipliedAlpha: true });
  if (!gl) return null;

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) || 'program link failed');
  }
  gl.useProgram(prog);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const u = {
    res: gl.getUniformLocation(prog, 'uRes'),
    time: gl.getUniformLocation(prog, 'uTime'),
    pondC: gl.getUniformLocation(prog, 'uPondC'),
    pondH: gl.getUniformLocation(prog, 'uPondH'),
    pondR: gl.getUniformLocation(prog, 'uPondR'),
    feather: gl.getUniformLocation(prog, 'uFeather'),
  };

  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  // Checked every frame rather than bound to window resize: the canvas has to
  // follow its CSS box, which changes for reasons a resize event never sees —
  // a background tab getting its first real layout, most of all.
  const syncSize = () => {
    const want = [
      Math.max(1, Math.round(canvas.clientWidth * dpr)),
      Math.max(1, Math.round(canvas.clientHeight * dpr)),
    ];
    if (canvas.width === want[0] && canvas.height === want[1]) return;
    canvas.width = want[0];
    canvas.height = want[1];
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  syncSize();

  const start = performance.now();
  const frame = () => {
    syncSize();
    const s = canvas.width / Math.max(1, world.width); // css px -> this canvas's px
    const p = world.pond;

    gl.uniform2f(u.res, canvas.width, canvas.height);
    gl.uniform1f(u.time, (performance.now() - start) / 1000);
    gl.uniform2f(u.pondC, p.cx * s, canvas.height - p.cy * s);
    gl.uniform2f(u.pondH, p.hw * s, p.hh * s);
    gl.uniform1f(u.pondR, p.radius * s);
    gl.uniform1f(u.feather, p.feather * s);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(frame);
  };
  frame();
  return { resize: syncSize };
}

/**
 * The shaders runtime sizes itself from the canvas's width/height *attributes*
 * and writes that back as an inline pixel style, which pins an unsized canvas
 * at the 300x150 default. So set the attributes first, then drive resizes here.
 */
function fitToViewport(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = '100%';
  canvas.style.height = '100%';
}

async function startShadersPreset(canvas) {
  const { createPreview, isWebGPUSupported } = await import('shaders/js');
  if (!isWebGPUSupported()) throw new Error('no webgpu');

  fitToViewport(canvas);
  const preview = await createPreview(canvas, { shader: SHADER_ID });

  await new Promise((res) => setTimeout(res, 700));
  const failure = preview.getFailureReason?.();
  if (failure) {
    preview.destroy();
    throw new Error(failure);
  }

  fitToViewport(canvas);
  preview.resize(window.innerWidth, window.innerHeight);

  let pending = 0;
  window.addEventListener('resize', () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      fitToViewport(canvas);
      preview.resize(window.innerWidth, window.innerHeight);
    }, 120);
  });
}

export async function startBackground(canvas, world) {
  // ?water=shaders opts back into the shaders.com preset (needs WebGPU + network,
  // and renders its free-tier watermark). Anything else gets the local water.
  if (new URLSearchParams(location.search).get('water') === 'shaders') {
    try {
      await startShadersPreset(canvas);
      return { source: 'shaders.com', resize: () => {} };
    } catch (err) {
      console.info('[pond] shaders.com preset unavailable:', err.message);
      canvas.removeAttribute('style');
    }
  }

  const local = startLocalWater(canvas, world);
  return { source: 'local', resize: local ? local.resize : () => {} };
}
