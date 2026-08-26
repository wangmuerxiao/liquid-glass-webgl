/*!
 * Liquid Glass Web Library v1.0.0
 * ============================================================
 * 一个 Web 端的"液态玻璃"效果库，移植自 Android AGSL 着色器
 * (com.kyant.backdrop)。通过 WebGL 实时模拟玻璃的折射 / 色散 /
 * 高斯模糊 / 振动饱和度 / 高光 / 阴影 / 内阴影等光学特性，
 * 并提供液态按钮、开关、滑块、底部标签栏等开箱即用的组件。
 *
 * 特性：
 *   - 实时折射 + 色散（基于圆角矩形 SDF）
 *   - 可分离高斯模糊（Skia σ = radius * 0.57735）
 *   - 振动饱和度（saturation 1.5）
 *   - 默认 / 环境高光、阴影、内阴影
 *   - 色调混合（BlendMode.Hue）、表面色叠加
 *   - 弹簧物理动效（移植 androidx.compose.animation.core）
 *   - WebGL 不可用时自动降级为 CSS backdrop-filter
 *   - 上下文数量超限时自动回收最老的 GL 上下文
 *
 * 用法（最简）：
 *   <link rel="stylesheet" href="lib/liquid-glass.css">
 *   <script src="lib/liquid-glass.js"></script>
 *   <script>
 *     const { BackdropSource, GlassElement, Components } = LiquidGlass;
 *     const backdrop = new BackdropSource();
 *     // ... 见 README.md
 *   </script>
 *
 * 许可：随源项目，请保留本头部。
 * ============================================================ */
(function (root) {
  'use strict';

  /* ===== 模块 1/4：WebGL 工具 (gl.js) ===== */
/* Minimal WebGL helpers for the liquid glass pipeline. */
(function () {
  'use strict';

  window.GLU = {
    createContext(canvas) {
      const gl = canvas.getContext('webgl', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true
      });
      if (!gl) return null;
      return gl;
    },

    compileShader(gl, type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error('Shader compile error: ' + info + '\n' + source);
      }
      return shader;
    },

    createProgram(gl, vsSource, fsSource) {
      const vs = this.compileShader(gl, gl.VERTEX_SHADER, vsSource);
      const fs = this.compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.bindAttribLocation(program, 0, 'aPosition');
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error('Program link error: ' + gl.getProgramInfoLog(program));
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return program;
    },

    getUniforms(gl, program, names) {
      const out = {};
      for (const name of names) {
        out[name] = gl.getUniformLocation(program, name);
      }
      return out;
    },

    /* Shared fullscreen quad buffer (created once per context). */
    getQuadBuffer(gl) {
      if (gl._quadBuffer) return gl._quadBuffer;
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 1, -1, -1, 1,
        -1, 1, 1, -1, 1, 1
      ]), gl.STATIC_DRAW);
      gl._quadBuffer = buf;
      return buf;
    },

    drawQuad(gl) {
      const buf = this.getQuadBuffer(gl);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },

    createTexture(gl, width, height) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      return tex;
    },

    createTarget(gl, width, height) {
      width = Math.max(1, width | 0);
      height = Math.max(1, height | 0);
      const texture = this.createTexture(gl, width, height);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return {
        texture, fbo, width, height,
        dispose() {
          gl.deleteTexture(texture);
          gl.deleteFramebuffer(fbo);
        }
      };
    },

    uploadTexture(gl, image) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      return tex;
    }
  };
})();

  /* ===== 模块 2/4：弹簧物理 (spring.js) ===== */
/* Port of androidx.compose.animation.core spring physics (mass = 1).
 *
 * Compose: spring(dampingRatio, stiffness, visibilityThreshold)
 *   omega = sqrt(stiffness)
 *   damping = 2 * dampingRatio * sqrt(stiffness * mass)
 * Integrated with semi-implicit Euler in fixed sub-steps, which matches
 * Compose's numerical behavior closely for these critically/over-damped specs.
 */
(function () {
  'use strict';

  const rafCallbacks = new Set();
  let rafId = 0;
  let lastTime = 0;

  function tick(time) {
    const dt = Math.min((time - lastTime) / 1000, 0.064);
    lastTime = time;
    for (const cb of Array.from(rafCallbacks)) cb(dt);
    if (rafCallbacks.size > 0) {
      rafId = requestAnimationFrame(tick);
    } else {
      rafId = 0;
    }
  }

  function requestTick(cb) {
    rafCallbacks.add(cb);
    if (!rafId) {
      lastTime = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  }

  function cancelTick(cb) {
    rafCallbacks.delete(cb);
  }

  class Spring {
    constructor(dampingRatio, stiffness, visibilityThreshold) {
      this.dampingRatio = dampingRatio;
      this.stiffness = stiffness;
      this.threshold = visibilityThreshold || 0.001;
      this.mass = 1;
      this.damping = 2 * dampingRatio * Math.sqrt(stiffness);
    }
  }

  /* A scalar animated value driven by a spring, mirroring Compose's Animatable. */
  class SpringAnimatable {
    constructor(initialValue, spring, onChange) {
      this.spring = spring;
      this.value = initialValue;
      this.targetValue = initialValue;
      this.velocity = 0;
      this.onChange = onChange || null;
      this._running = false;
      this._tickFn = (dt) => this._step(dt);
    }

    get running() { return this._running; }

    /* animateTo: spring toward target. */
    animateTo(target) {
      this.targetValue = target;
      if (!this._running) {
        this._running = true;
        requestTick(this._tickFn);
      }
    }

    /* snapTo: jump instantly. */
    snapTo(value) {
      this.value = value;
      this.targetValue = value;
      this.velocity = 0;
      this._stop();
      if (this.onChange) this.onChange(value);
    }

    _stop() {
      if (this._running) {
        this._running = false;
        cancelTick(this._tickFn);
      }
    }

    _step(dt) {
      if (!this._running) return;
      const k = this.spring.stiffness;
      const c = this.spring.damping;
      const target = this.targetValue;

      // Fixed 1ms sub-steps for stability (values can be stiff).
      let remaining = dt;
      const h = 0.001;
      let value = this.value;
      let velocity = this.velocity;
      let guard = 0;
      while (remaining > 1e-6 && guard < 200) {
        const step = Math.min(h, remaining);
        const accel = -k * (value - target) - c * velocity;
        velocity += accel * step;
        value += velocity * step;
        remaining -= step;
        guard++;
      }
      this.value = value;
      this.velocity = velocity;

      const atRest = Math.abs(value - target) < this.spring.threshold &&
                     Math.abs(velocity) < this.spring.threshold * 100;
      if (atRest) {
        this.value = target;
        this.velocity = 0;
        this._stop();
      }
      if (this.onChange) this.onChange(this.value);
    }
  }

  /* 2D offset animatable (Offset.VectorConverter equivalent). */
  class OffsetAnimatable {
    constructor(springX, springY) {
      this.x = new SpringAnimatable(0, springX);
      this.y = new SpringAnimatable(0, springY);
    }
    get value() { return { x: this.x.value, y: this.y.value }; }
    animateTo(x, y) { this.x.animateTo(x); this.y.animateTo(y); }
    snapTo(x, y) { this.x.snapTo(x); this.y.snapTo(y); }
  }

  window.SpringSystem = { Spring, SpringAnimatable, OffsetAnimatable };
})();

  /* ===== 模块 3/4：液态玻璃引擎 (liquid-glass.js) ===== */
﻿/* Liquid Glass engine - WebGL port of com.kyant.backdrop (Android AGSL shaders).
 * Ports: refraction/dispersion lens, gaussian blur (sigma = radius * 0.57735),
 * vibrancy (saturation 1.5), Default/Ambient highlight, Shadow, InnerShadow,
 * tint (BlendMode.Hue + 0.75 alpha), surfaceColor, combined backdrop layer.
 */
(function () {
  'use strict';

  function dpr() { return Math.min(window.devicePixelRatio || 1, 2); }

  const VERT = `
attribute vec2 aPosition;
uniform vec2 uResolution;
varying vec2 vCoord;
void main() {
  vCoord = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5) * uResolution;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

  const SDF = `
float radiusAt(vec2 coord, vec4 radii) {
  if (coord.x >= 0.0) {
    if (coord.y <= 0.0) return radii.y;
    else return radii.z;
  } else {
    if (coord.y <= 0.0) return radii.x;
    else return radii.w;
  }
}

float sdRoundedRect(vec2 coord, vec2 halfSize, float radius) {
  vec2 cornerCoord = abs(coord) - (halfSize - vec2(radius));
  float outside = length(max(cornerCoord, vec2(0.0))) - radius;
  float inside = min(max(cornerCoord.x, cornerCoord.y), 0.0);
  return outside + inside;
}

vec2 gradSdRoundedRect(vec2 coord, vec2 halfSize, float radius) {
  vec2 cornerCoord = abs(coord) - (halfSize - vec2(radius));
  if (cornerCoord.x >= 0.0 || cornerCoord.y >= 0.0) {
    vec2 m = max(cornerCoord, vec2(0.0));
    float l = length(m);
    vec2 n = l > 0.0001 ? m / l : vec2(0.0);
    return sign(coord) * n;
  } else {
    float gradX = step(cornerCoord.y, cornerCoord.x);
    return sign(coord) * vec2(gradX, 1.0 - gradX);
  }
}

float circleMap(float x) {
  return 1.0 - sqrt(max(1.0 - x * x, 0.0));
}`;

  /* Region compose pass: cover-fitted backdrop image (or solid color),
   * optional extra backdrop layer (track) drawn scaled, vibrancy matrix. */
  const REGION_FRAG = `
precision highp float;
varying vec2 vCoord;
uniform vec2 uResolution;
uniform vec2 uCanvasOrigin;
uniform float uRegionPad;
uniform float uDpr;
uniform sampler2D uBackdrop;
uniform vec2 uImageSize;
uniform vec2 uScreenSize;
uniform float uSolidBackdrop;
uniform vec4 uSolidColor;
uniform float uVibrancy;
uniform sampler2D uTrack;
uniform float uHasTrack;
uniform vec4 uTrackRect;
uniform vec2 uTrackScale;
uniform vec2 uElemSize;

void main() {
  /* vCoord is deliberately top-left based for DOM geometry.  A framebuffer
   * texture, however, is addressed bottom-left by WebGL.  Render the region
   * upside down into its FBO so that later samples at a top-left DOM uv read
   * the same backdrop point as direct (Canvas/Image) texture uploads. */
  vec2 regionCoord = vec2(vCoord.x, uResolution.y - vCoord.y);
  vec2 screenPt = uCanvasOrigin + regionCoord / uDpr;
  float scale = max(uScreenSize.x / uImageSize.x, uScreenSize.y / uImageSize.y);
  vec2 offset = (uScreenSize - uImageSize * scale) * 0.5;
  vec2 uv = (screenPt - offset) / (uImageSize * scale);
  uv = clamp(uv, vec2(0.0), vec2(1.0));
  vec4 color = mix(texture2D(uBackdrop, uv), uSolidColor, uSolidBackdrop);

  if (uHasTrack > 0.5) {
    vec2 e = regionCoord / uDpr - uRegionPad;
    vec2 center = uElemSize * 0.5;
    vec2 tl = (e - center) / uTrackScale + center;
    vec2 tuv = (tl - uTrackRect.xy) / uTrackRect.zw;
    if (all(greaterThanEqual(tuv, vec2(0.0))) && all(lessThanEqual(tuv, vec2(1.0)))) {
      vec4 t = texture2D(uTrack, tuv);
      color = vec4(mix(color.rgb, t.rgb, t.a), 1.0);
    }
  }

  if (uVibrancy > 0.5) {
    mat3 sat = mat3(
      1.3935, -0.1065, -0.1065,
      -0.3575, 1.1425, -0.3575,
      -0.0360, -0.0360, 1.4640
    );
    color = vec4(clamp(sat * color.rgb, 0.0, 1.0), color.a);
  }
  gl_FragColor = color;
}`;

  /* Separable gaussian blur pass. */
  const BLUR_FRAG = `
precision mediump float;
varying vec2 vCoord;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uWeights[32];
uniform int uN;

  void main() {
  vec2 uv = vCoord * uTexel;
  vec4 sum = texture2D(uTex, uv) * uWeights[0];
  for (int i = 1; i < 32; i++) {
    if (i > uN) break;
    vec2 off = uDir * float(i);
    sum += texture2D(uTex, uv + off * uTexel) * uWeights[i];
    sum += texture2D(uTex, uv - off * uTexel) * uWeights[i];
  }
  gl_FragColor = sum;
}`;

  /* Final pass: lens refraction + dispersion + tint/surface + inner shadow
   * + edge highlight + drop shadow, clipped to the rounded-rect shape.
   * Optional: SDF-texture shape (clock), content zoom/shift (magnifier),
   * color controls (brightness/contrast/saturation), alpha mask (progressive blur). */
  const FINAL_FRAG = `
precision highp float;
varying vec2 vCoord;
uniform sampler2D uContent;
uniform float uRegionPad;
uniform vec2 uRegionSize;
uniform vec2 uSize;
uniform float uShadowPad;
uniform vec4 uRadii;
uniform float uRefractHeight;
uniform float uRefractAmount;
uniform float uDepth;
uniform float uChromatic;
uniform vec4 uTint;
uniform vec4 uSurface;

uniform float uCCSat;
uniform float uCCCon;
uniform float uCCBright;
uniform float uContentZoom;
uniform vec2 uContentShift;
uniform float uAlphaMaskOn;
uniform vec4 uAlphaTint;
uniform float uAlphaTintI;
uniform float uSdfEnabled;
uniform sampler2D uSdf;
uniform vec2 uSdfSize;
uniform float uSdfRefractionHeight;
uniform float uSdfLightAngle;

__SDF__

vec4 sampleContent(vec2 e) {
  vec2 s = e;
  if (uContentZoom > 1.0001 || uContentShift.x != 0.0 || uContentShift.y != 0.0) {
    s = (e - uSize * 0.5) / uContentZoom + uSize * 0.5 + uContentShift;
  }
  vec2 uv = (s + vec2(uRegionPad)) / uRegionSize;
  vec2 texel = 1.0 / uRegionSize;
  uv = clamp(uv, texel * 0.5, vec2(1.0) - texel * 0.5);
  return texture2D(uContent, uv);
}

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }

float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }

vec3 setSat(vec3 c, float s) {
  float mn = min(c.r, min(c.g, c.b));
  float mx = max(c.r, max(c.g, c.b));
  if (mx <= mn) return vec3(0.0);
  return (c - vec3(mn)) * (s / (mx - mn));
}

vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - vec3(l)) * (l / (l - n + 1e-6));
  if (x > 1.0) c = l + (c - vec3(l)) * ((1.0 - l) / (x - l + 1e-6));
  return c;
}

vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }

/* Skia BlendMode.Hue: hue+saturation of src, luminosity of dst. */
vec3 hueBlend(vec3 dst, vec3 src) {
  return setLum(setSat(src, sat(dst)), lum(dst));
}`;

  const FINAL_FRAG_MAIN = `
uniform float uInnerRadius;
uniform vec2 uInnerOffset;
uniform vec4 uInnerColor;
uniform float uShadowRadius;
uniform vec2 uShadowOffset;
uniform vec4 uShadowColor;
uniform float uHlMode;
uniform float uHlWidth;
uniform float uHlBlur;
uniform float uHlAlpha;
uniform float uHlAngle;
uniform float uHlFalloff;
uniform vec4 uHlColor;

void main() {
  vec2 e = vCoord - vec2(uShadowPad);
  vec2 halfSize = uSize * 0.5;
  vec2 centered = e - halfSize;
  float radius = radiusAt(e, uRadii);
  float sd = sdRoundedRect(centered, halfSize, radius);
  float gradRadius = min(radius * 1.5, min(halfSize.x, halfSize.y));
  vec2 gradR = gradSdRoundedRect(centered, halfSize, gradRadius);
  float hardIn = smoothstep(0.5, -0.5, sd);
  vec4 glass = sampleContent(e);

  if (uSdfEnabled > 0.5) {
    /* --- SDF-texture shape (port of catalog SdfShader) --- */
    vec2 local = e;
    vec2 p = local / uSize * uSdfSize;
    vec2 tuv = local / uSize;
    if (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x > 1.0 || tuv.y > 1.0) {
      hardIn = 0.0;
    } else {
      vec4 v = texture2D(uSdf, tuv);
      float sdv = v.r * 2.0 - 1.0;
      float cov = smoothstep(0.5, 1.0, v.a);
      if (cov <= 0.0) {
        hardIn = 0.0;
      } else {
        if (cov < 1.0) sdv = 0.0;
        vec2 normal = normalize(v.gb * 2.0 - 1.0);
        float intensity = circleMap(1.0 - min(1.0, -sdv * 1.5));
        vec2 refrLocal = local - intensity * uSdfRefractionHeight * normal;
        vec4 color = sampleContent(refrLocal) * cov;
        vec2 lightDir = vec2(cos(uSdfLightAngle), sin(uSdfLightAngle));
        float bevel = clamp(dot(normal, lightDir), 0.0, 1.0);
        color.rgb *= 1.0 + 0.5 * intensity * bevel;
        bevel = clamp(dot(normal, -lightDir), 0.0, 1.0);
        color.rgb *= 1.0 + 0.5 * bevel * min(1.0, smoothstep(1.0, 0.0, abs(intensity - 0.25) * 6.0));
        glass = color;
        hardIn = cov;
      }
    }
  } else if (uRefractHeight > 0.0 && -sd < uRefractHeight) {
    /* --- glass: refraction (port of RoundedRectRefractionShader) --- */
    float sdC = min(sd, 0.0);
    float d = circleMap(1.0 - (-sdC) / uRefractHeight) * uRefractAmount;
    vec2 grad = normalize(gradR + uDepth * normalize(centered + vec2(0.0001)));
    vec2 refr = e + d * grad;
    if (uChromatic > 0.5) {
      float di = (centered.x * centered.y) / (halfSize.x * halfSize.y);
      vec2 disp = d * grad * di;
      vec4 c;
      c = sampleContent(refr + disp);
      glass = vec4(c.r / 3.5, 0.0, 0.0, c.a / 7.0);
      c = sampleContent(refr + disp * (2.0 / 3.0));
      glass += vec4(c.r / 3.5, c.g / 7.0, 0.0, c.a / 7.0);
      c = sampleContent(refr + disp * (1.0 / 3.0));
      glass += vec4(c.r / 3.5, c.g / 3.5, 0.0, c.a / 7.0);
      c = sampleContent(refr);
      glass += vec4(0.0, c.g / 3.5, 0.0, c.a / 7.0);
      c = sampleContent(refr - disp * (1.0 / 3.0));
      glass += vec4(0.0, c.g / 3.5, c.b / 3.0, c.a / 7.0);
      c = sampleContent(refr - disp * (2.0 / 3.0));
      glass += vec4(0.0, 0.0, c.b / 3.0, c.a / 7.0);
      c = sampleContent(refr - disp);
      glass += vec4(c.r / 7.0, 0.0, c.b / 3.0, c.a / 7.0);
    } else {
      glass = sampleContent(refr);
    }
  }
`;

  const FINAL_FRAG_MAIN2 = `
  /* --- alpha mask (progressive blur) --- */
  if (uAlphaMaskOn > 0.5) {
    float h = uSize.y;
    float t = clamp((e.y - h * 0.5) / (h * 0.5), 0.0, 1.0);
    float m = 1.0 - t * t * (3.0 - 2.0 * t);
    glass.rgb = mix(glass.rgb, uAlphaTint.rgb, uAlphaTintI) * m;
    hardIn *= m;
  }
  /* --- color controls (brightness/contrast/saturation) --- */
  if (uCCSat != 1.0 || uCCCon != 1.0 || uCCBright != 0.0) {
    float lum = dot(glass.rgb, vec3(0.2126, 0.7152, 0.0722));
    glass.rgb = mix(vec3(lum), glass.rgb, uCCSat);
    glass.rgb = (glass.rgb - 0.5) * uCCCon + 0.5;
    glass.rgb += uCCBright;
  }
  /* --- onDrawSurface: tint (Hue blend + alpha-scaled overlay), surfaceColor --- */
  if (uTint.a > 0.0) {
    vec3 hb = hueBlend(glass.rgb, uTint.rgb);
    glass.rgb = mix(glass.rgb, hb, uTint.a);
    glass.rgb = mix(glass.rgb, uTint.rgb, 0.75 * uTint.a);
  }
  if (uSurface.a > 0.0) {
    glass.rgb = mix(glass.rgb, uSurface.rgb, uSurface.a);
  }

  /* --- inner shadow (crescent + blur, clipped inside) --- */
  if (uInnerColor.a > 0.0 && uInnerRadius > 0.0) {
    float sig = uInnerRadius * 0.57735;
    float soft = max(sig * 1.5, 0.5);
    vec2 eB = e - uInnerOffset;
    float sdB = sdRoundedRect(eB - halfSize, halfSize, radiusAt(eB, uRadii));
    float crescent = max(smoothstep(soft, -soft, sd) - smoothstep(soft, -soft, sdB), 0.0);
    float a = crescent * hardIn * uInnerColor.a;
    glass.rgb = mix(glass.rgb, uInnerColor.rgb, a);
  }

  /* --- edge highlight (stroke clipped to shape) --- */
  if (uHlMode > 0.5 && uHlAlpha > 0.0) {
    float b = max(uHlBlur, 0.001);
    float cov = clamp((uHlWidth + b - abs(sd)) / (2.0 * b), 0.0, 1.0) * hardIn;
    if (cov > 0.0) {
      float d2 = dot(gradR, vec2(cos(uHlAngle), sin(uHlAngle)));
      if (uHlMode < 1.5) {
        float intensity = pow(abs(d2), uHlFalloff);
        glass.rgb = min(glass.rgb + uHlColor.rgb * (intensity * cov * uHlAlpha), vec3(1.0));
      } else if (uHlMode < 2.5) {
        float intensity = step(0.0, d2) * pow(abs(d2), uHlFalloff);
        glass.rgb = mix(glass.rgb, vec3(1.0), intensity * cov * uHlAlpha);
      } else {
        glass.rgb = min(glass.rgb + uHlColor.rgb * (uHlColor.a * cov * uHlAlpha), vec3(1.0));
      }
    }
  }

  /* --- drop shadow (blurred shape at offset, hole under element) --- */
  float shadowA = 0.0;
  if (uShadowColor.a > 0.0 && uShadowRadius > 0.0) {
    float sigS = uShadowRadius * 0.57735;
    vec2 eS = e - uShadowOffset;
    float sdS = sdRoundedRect(eS - halfSize, halfSize, radiusAt(eS, uRadii));
    float covS = smoothstep(3.0 * sigS, -3.0 * sigS, sdS);
    shadowA = covS * (1.0 - hardIn) * uShadowColor.a;
  }

  float gA = hardIn;
  vec3 gRGB = glass.rgb;
  vec3 sRGB = uShadowColor.rgb;
  float sA = shadowA;
  gl_FragColor = vec4(gRGB * gA + sRGB * sA * (1.0 - gA), gA + sA * (1.0 - gA));
}`;

  const FINAL_SHADER = FINAL_FRAG + FINAL_FRAG_MAIN + FINAL_FRAG_MAIN2;

  /* ------------------------------------------------------------------ */

  /* Shared backdrop: the wallpaper image displayed with ContentScale.Crop. */
  class BackdropSource {
    constructor() {
      this.image = null;
      this.solidColor = null; // [r,g,b,a] 0..1, when set replaces the image
      this.listeners = new Set();
    }
    setImage(img) {
      this.image = img;
      this.solidColor = null;
      this._notify();
    }
    setSolid(r, g, b, a) {
      this.solidColor = [r, g, b, a];
      this._notify();
    }
    clearSolid() {
      this.solidColor = null;
      this._notify();
    }
    onChange(cb) { this.listeners.add(cb); }
    _notify() { for (const cb of this.listeners) cb(); }
  }

  const allGlass = new Set();
  let globalRaf = 0;
  function ensureLoop() {
    if (globalRaf) return;
    const loop = () => {
      for (const g of allGlass) g.renderIfNeeded();
      globalRaf = requestAnimationFrame(loop);
    };
    globalRaf = requestAnimationFrame(loop);
  }

  class GlassElement {
    constructor(backdrop, opts) {
      opts = opts || {};
      this.backdrop = backdrop;
      this.radii = opts.radii || [0, 0, 0, 0]; // CSS px [tl, tr, br, bl]
      this.shadowPad = opts.shadowPad || 0;    // CSS px margin for drop shadow
      this.regionPad = opts.regionPad || 30;   // CSS px backdrop sampling margin
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'liquid-glass-canvas';
      this.gl = GLU.createContext(this.canvas);
      // 若因数量超限创建失败，尝试释放最老的上下文后重试
      if (!this.gl && allGlass.size > 0) {
        const oldest = allGlass.values().next().value;
        if (oldest) {
          try { oldest.dispose(); } catch (e) {}
          this.gl = GLU.createContext(this.canvas);
        }
      }
      if (!this.gl) {
        // 仍失败则启用 CSS 降级
        this.canvas.style.background = 'rgba(255,255,255,0.35)';
        this.canvas.style.backdropFilter = 'blur(18px) saturate(1.4)';
        this.canvas.style.webkitBackdropFilter = 'blur(18px) saturate(1.4)';
        this.canvas.style.borderRadius = '999px';
      }
      this.width = 0;
      this.height = 0;
      this.params = {};
      this.dirty = true;
      this.lastRect = null;
      this._targets = null;
      this._backdropTex = null;
      this._trackTex = null;
      this._combinedCanvas = null;
      if (this.gl) this._initGL();
      backdrop.onChange(() => { this._backdropDirty = true; this.invalidate(); });
      allGlass.add(this);
      ensureLoop();
    }

    _initGL() {
      const gl = this.gl;
      this.progRegion = GLU.createProgram(gl, VERT, REGION_FRAG);
      this.progBlur = GLU.createProgram(gl, VERT, BLUR_FRAG);
      this.progFinal = GLU.createProgram(gl, VERT, FINAL_SHADER.replace('__SDF__', SDF));
      this.uRegion = GLU.getUniforms(gl, this.progRegion, [
        'uResolution', 'uCanvasOrigin', 'uRegionPad', 'uDpr', 'uBackdrop',
        'uImageSize', 'uScreenSize', 'uSolidBackdrop', 'uSolidColor', 'uVibrancy',
        'uTrack', 'uHasTrack', 'uTrackRect', 'uTrackScale', 'uElemSize'
      ]);
      this.uBlur = GLU.getUniforms(gl, this.progBlur, [
        'uResolution', 'uTex', 'uTexel', 'uDir', 'uWeights', 'uN'
      ]);
      this.uFinal = GLU.getUniforms(gl, this.progFinal, [
        'uResolution', 'uContent', 'uRegionPad', 'uRegionSize', 'uSize',
        'uShadowPad', 'uRadii', 'uRefractHeight', 'uRefractAmount', 'uDepth',
        'uChromatic', 'uTint', 'uSurface', 'uInnerRadius', 'uInnerOffset',
        'uInnerColor', 'uShadowRadius', 'uShadowOffset', 'uShadowColor',
        'uHlMode', 'uHlWidth', 'uHlBlur', 'uHlAlpha', 'uHlAngle',
        'uHlFalloff', 'uHlColor',
        'uCCSat', 'uCCCon', 'uCCBright', 'uContentZoom', 'uContentShift',
        'uAlphaMaskOn', 'uAlphaTint', 'uAlphaTintI',
        'uSdfEnabled', 'uSdf', 'uSdfSize', 'uSdfRefractionHeight', 'uSdfLightAngle'
      ]);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this._backdropDirty = true;
    }

    setSize(w, h) {
      if (w === this.width && h === this.height) return;
      this.width = w;
      this.height = h;
      const ratio = dpr();
      const S = this.shadowPad;
      this.canvas.style.width = (w + 2 * S) + 'px';
      this.canvas.style.height = (h + 2 * S) + 'px';
      this.canvas.style.left = (-S) + 'px';
      this.canvas.style.top = (-S) + 'px';
      this.canvas.width = Math.max(1, Math.round((w + 2 * S) * ratio));
      this.canvas.height = Math.max(1, Math.round((h + 2 * S) * ratio));
      if (this._targets) {
        for (const t of this._targets) t.dispose();
        this._targets = null;
      }
      this.invalidate();
    }

    invalidate() { this.dirty = true; }

    render(params) {
      this.params = params;
      this.invalidate();
    }

    renderIfNeeded() {
      if (!this.gl || this.width === 0) return;
      const rect = this._samplingRect();
      const key = rect.left + ',' + rect.top + ',' +
                  window.innerWidth + ',' + window.innerHeight;
      if (key !== this.lastRect) {
        this.lastRect = key;
        this.dirty = true;
      }
      if (!this.backdrop.image && !this.backdrop.solidColor) return;
      if (!this.dirty) return;
      this.dirty = false;
      this._draw(rect);
    }

    /* The glass canvas is a child of its host and inherits the host's CSS
     * transform, so getBoundingClientRect() returns the visual rect which
     * already includes that transform (value/drag translate + press scale).
     *
     * For backdrop sampling we want the canvas centre (which tracks the
     * host's real on-screen position, including any value/drag translate) but
     * must cancel only the *scale*: keeping it would grow/shrink the sampled
     * region during the press animation and make the refracted backdrop swim
     * while a control is held.  Centre minus the unscaled canvas size does
     * exactly that: translate is preserved (a slider thumb refracts the live
     * background as it moves), scale is cancelled (press stays stable). */
    _samplingRect() {
      const visual = this.canvas.getBoundingClientRect();
      const host = this.canvas.parentElement;
      if (!host) return visual;
      const transform = getComputedStyle(host).transform;
      const m = transform && transform.match(/^matrix\(([^)]+)\)$/);
      if (!m) return visual;
      const values = m[1].split(',').map(Number);
      if (values.length !== 6 || !values.every(Number.isFinite)) return visual;
      const [a, b, c, d] = values;
      // Rotation/skew is used only by the free-form playground.  Its axis
      // aligned bounding box cannot be inverted without a full matrix map.
      if (Math.abs(b) > 0.0001 || Math.abs(c) > 0.0001 ||
          Math.abs(a) < 0.0001 || Math.abs(d) < 0.0001) return visual;
      const canvasW = this.width + this.shadowPad * 2;
      const canvasH = this.height + this.shadowPad * 2;
      const left = visual.left + visual.width * 0.5 - canvasW * 0.5;
      const top = visual.top + visual.height * 0.5 - canvasH * 0.5;
      return { left, top, width: canvasW, height: canvasH };
    }

    _draw(rect) {
      const gl = this.gl;
      const p = this.params;
      const w = this.width, h = this.height, S = this.shadowPad;
      const blur = p.blurRadius || 0;
      const amount = p.refractionAmount || 0;
      const sigma = blur * 0.57735;
      // 固定 M 避免按压时 FBO 尺寸变化导致重建闪黑
      const M = this.regionPad;
      // 宽窗口 × 高 DPI 时区域纹理可能超过 MAX_TEXTURE_SIZE（FBO 失败→渲染异常），按上限降采样
      const maxTex = this._maxTex || (this._maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096);
      let ratio = dpr();
      if ((w + 2 * M) * ratio > maxTex || (h + 2 * M) * ratio > maxTex) {
        ratio = Math.max(0.5, maxTex / Math.max(w + 2 * M, h + 2 * M));
      }
      const rdw = Math.max(1, Math.round((w + 2 * M) * ratio));
      const rdh = Math.max(1, Math.round((h + 2 * M) * ratio));
      this._ensureTargets(rdw, rdh);
      this._uploadBackdrop();

      // element screen origin (canvas is offset by -S)
      const Mdev = M * ratio;

      const track = p.track;
      if (track && track.canvas) {
        this._uploadTrack(track);
        if (window._glassGLErr) console.error(window._glassGLErr);
      }

      /* pass 1: region compose */
      const A = this._targets[0];
      const B = this._targets[1];
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, A.fbo);
      gl.viewport(0, 0, rdw, rdh);
      gl.useProgram(this.progRegion);
      const ur = this.uRegion;
      gl.uniform2f(ur.uResolution, rdw, rdh);
      gl.uniform2f(ur.uCanvasOrigin, rect.left + S - M, rect.top + S - M);
      gl.uniform1f(ur.uRegionPad, M);
      gl.uniform1f(ur.uDpr, ratio);

      // CPU compositing for track overlay(s)
      const trackList = [];
      if (p.tracks) for (const t of p.tracks) { if (t) trackList.push(t); }
      if (p.track) trackList.push(p.track);
      const useCPUComposite = trackList.some((t) => t.canvas && t.canvas.width > 0);

      if (useCPUComposite) {
        if (!this._combinedCanvas) this._combinedCanvas = document.createElement('canvas');
        const cc = this._combinedCanvas;
        if (cc.width !== rdw || cc.height !== rdh) { cc.width = rdw; cc.height = rdh; }
        const ctx2 = cc.getContext('2d');
        ctx2.setTransform(ratio, 0, 0, ratio, 0, 0);
        // 先填充底色，避免图片未覆盖区域透出黑色
        ctx2.fillStyle = '#c8d8e0';
        ctx2.fillRect(0, 0, rdw / ratio, rdh / ratio);
        const img2 = this.backdrop.image;
        const solid2 = this.backdrop.solidColor;
        if (solid2) {
          ctx2.fillStyle = `rgba(${Math.round(solid2[0]*255)},${Math.round(solid2[1]*255)},${Math.round(solid2[2]*255)},${solid2[3]})`;
          ctx2.fillRect(0, 0, rdw / ratio, rdh / ratio);
        } else if (img2 && img2.naturalWidth > 0) {
          const sw = window.innerWidth, sh = window.innerHeight;
          const sc = Math.max(sw / img2.naturalWidth, sh / img2.naturalHeight);
          const offX = (sw - img2.naturalWidth * sc) * 0.5;
          const offY = (sh - img2.naturalHeight * sc) * 0.5;
          const rx = rect.left + S - M, ry = rect.top + S - M;
          const sx = (rx - offX) / sc;
          const sy = (ry - offY) / sc;
          const sw2 = (rdw / ratio) / sc;
          const sh2 = (rdh / ratio) / sc;
          // 裁剪源区域到图片边界内，避免负坐标导致透明
          const sxClamped = Math.max(0, sx);
          const syClamped = Math.max(0, sy);
          const dx = sx < 0 ? -sx * sc : 0;
          const dy = sy < 0 ? -sy * sc : 0;
          const swClamped = Math.min(sw2 - (sxClamped - sx), img2.naturalWidth - sxClamped);
          const shClamped = Math.min(sh2 - (syClamped - sy), img2.naturalHeight - syClamped);
          if (swClamped > 0 && shClamped > 0) {
            ctx2.drawImage(img2, sxClamped, syClamped, swClamped, shClamped, dx, dy, swClamped * sc, shClamped * sc);
          }
        }
        for (const track2 of trackList) {
          if (!track2.canvas || !(track2.canvas.width > 0)) continue;
          const cx = M + track2.rect[0];
          const cy = M + track2.rect[1];
          ctx2.save();
          ctx2.translate(cx + track2.rect[2] * 0.5, cy + track2.rect[3] * 0.5);
          ctx2.scale(track2.scaleX, track2.scaleY);
          ctx2.translate(-track2.rect[2] * 0.5, -track2.rect[3] * 0.5);
          ctx2.drawImage(track2.canvas, 0, 0, track2.rect[2], track2.rect[3]);
          ctx2.restore();
        }
        // upload directly to region texture (no shader needed)
        gl.bindTexture(gl.TEXTURE_2D, A.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cc);
      } else {
        /* normal GPU region compose (no track) */
        gl.bindFramebuffer(gl.FRAMEBUFFER, A.fbo);
        gl.viewport(0, 0, rdw, rdh);
        gl.useProgram(this.progRegion);
        const ur = this.uRegion;
        gl.uniform2f(ur.uResolution, rdw, rdh);
        gl.uniform2f(ur.uCanvasOrigin, rect.left + S - M, rect.top + S - M);
        gl.uniform1f(ur.uRegionPad, M);
        gl.uniform1f(ur.uDpr, ratio);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._backdropTex);
        gl.uniform1i(ur.uBackdrop, 0);
        const img = this.backdrop.image;
        const iw = img ? (img.naturalWidth || img.width) : 1;
        const ih = img ? (img.naturalHeight || img.height) : 1;
        gl.uniform2f(ur.uImageSize, iw, ih);
        gl.uniform2f(ur.uScreenSize, window.innerWidth, window.innerHeight);
        const solid = this.backdrop.solidColor;
        gl.uniform1f(ur.uSolidBackdrop, solid ? 1 : 0);
        if (solid) gl.uniform4f(ur.uSolidColor, solid[0], solid[1], solid[2], solid[3]);
        gl.uniform1f(ur.uVibrancy, p.vibrancy ? 1 : 0);
        gl.uniform1f(ur.uHasTrack, 0);
        gl.uniform2f(ur.uElemSize, w, h);
        GLU.drawQuad(gl);
      }

      /* pass 2/3: gaussian blur (Skia sigma = radius * 0.57735) */
      if (blur > 0.05) {
        const sigmaDev = sigma * ratio;
        const n = Math.min(Math.ceil(3 * sigmaDev), 31);
        const weights = this._gaussWeights(sigmaDev, n);
        gl.useProgram(this.progBlur);
        gl.uniform2f(this.uBlur.uResolution, rdw, rdh);
        gl.uniform2f(this.uBlur.uTexel, 1 / rdw, 1 / rdh);
        gl.uniform1fv(this.uBlur.uWeights, weights);
        gl.uniform1i(this.uBlur.uN, n);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(this.uBlur.uTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, B.fbo);
        gl.bindTexture(gl.TEXTURE_2D, A.texture);
        gl.uniform2f(this.uBlur.uDir, 1, 0);
        GLU.drawQuad(gl);
        gl.bindFramebuffer(gl.FRAMEBUFFER, A.fbo);
        gl.bindTexture(gl.TEXTURE_2D, B.texture);
        gl.uniform2f(this.uBlur.uDir, 0, 1);
        GLU.drawQuad(gl);
      }

      /* pass 4: final composite to canvas */
      const cw = this.canvas.width, ch = this.canvas.height;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cw, ch);
      gl.useProgram(this.progFinal);
      const uf = this.uFinal;
      gl.uniform2f(uf.uResolution, cw, ch);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, A.texture);
      gl.uniform1i(uf.uContent, 0);
      gl.uniform1f(uf.uRegionPad, Mdev);
      gl.uniform2f(uf.uRegionSize, rdw, rdh);
      gl.uniform2f(uf.uSize, w * ratio, h * ratio);
      gl.uniform1f(uf.uShadowPad, S * ratio);
      const maxR = Math.min(w, h) * 0.5 * ratio;
      const rr = this.radii;
      gl.uniform4f(uf.uRadii,
        Math.min(rr[0] * ratio, maxR), Math.min(rr[1] * ratio, maxR),
        Math.min(rr[2] * ratio, maxR), Math.min(rr[3] * ratio, maxR));
      gl.uniform1f(uf.uRefractHeight, (p.refractionHeight || 0) * ratio);
      // Lens.kt passes -refractionAmount to the AGSL shader.  The rounded
      // rectangle gradient points outward, so a positive public amount must
      // sample inward; using a positive value here inverted every glass edge.
      gl.uniform1f(uf.uRefractAmount, -amount * ratio);
      gl.uniform1f(uf.uDepth, p.depthEffect ? 1 : 0);
      gl.uniform1f(uf.uChromatic, p.chromaticAberration ? 1 : 0);
      const tint = p.tint;
      gl.uniform4f(uf.uTint, tint ? tint[0] : 0, tint ? tint[1] : 0, tint ? tint[2] : 0, tint ? tint[3] : 0);
      const surf = p.surfaceColor;
      gl.uniform4f(uf.uSurface, surf ? surf[0] : 0, surf ? surf[1] : 0, surf ? surf[2] : 0, surf ? surf[3] : 0);
      const is = p.innerShadow;
      gl.uniform1f(uf.uInnerRadius, is ? is.radius * ratio : 0);
      gl.uniform2f(uf.uInnerOffset, is ? is.offsetX * ratio : 0, is ? is.offsetY * ratio : 0);
      gl.uniform4f(uf.uInnerColor, is ? is.color[0] : 0, is ? is.color[1] : 0,
        is ? is.color[2] : 0, is ? is.color[3] * is.alpha : 0);
      const sh = p.shadow;
      gl.uniform1f(uf.uShadowRadius, sh ? sh.radius * ratio : 0);
      gl.uniform2f(uf.uShadowOffset, sh ? sh.offsetX * ratio : 0, sh ? sh.offsetY * ratio : 0);
      gl.uniform4f(uf.uShadowColor, sh ? sh.color[0] : 0, sh ? sh.color[1] : 0,
        sh ? sh.color[2] : 0, sh ? sh.color[3] * sh.alpha : 0);
      const hl = p.highlight;
      if (hl && hl.width > 0 && hl.alpha > 0) {
        const modes = { default: 1, ambient: 2, plain: 3 };
        gl.uniform1f(uf.uHlMode, modes[hl.style] || 1);
        gl.uniform1f(uf.uHlWidth, Math.ceil(Math.min(hl.width * ratio, Math.min(w, h) * ratio / 2)));
        gl.uniform1f(uf.uHlBlur, (hl.blurRadius != null ? hl.blurRadius : hl.width / 2) * ratio);
        gl.uniform1f(uf.uHlAlpha, hl.alpha);
        gl.uniform1f(uf.uHlAngle, (hl.angle != null ? hl.angle : 45) * Math.PI / 180);
        gl.uniform1f(uf.uHlFalloff, hl.falloff != null ? hl.falloff : 1);
        const hc = hl.color || [1, 1, 1, hl.style === 'plain' ? 0.38 : 0.5];
        gl.uniform4f(uf.uHlColor, hc[0], hc[1], hc[2], hc[3]);
      } else {
        gl.uniform1f(uf.uHlMode, 0);
      }
      const cc = p.colorControls;
      gl.uniform1f(uf.uCCSat, cc ? (cc.saturation != null ? cc.saturation : 1) : 1);
      gl.uniform1f(uf.uCCCon, cc ? (cc.contrast != null ? cc.contrast : 1) : 1);
      gl.uniform1f(uf.uCCBright, cc ? (cc.brightness != null ? cc.brightness : 0) : 0);
      gl.uniform1f(uf.uContentZoom, p.contentZoom || 1);
      const cshift = p.contentShift;
      gl.uniform2f(uf.uContentShift, cshift ? cshift[0] * ratio : 0, cshift ? cshift[1] * ratio : 0);
      const am = p.alphaMask;
      if (am) {
        gl.uniform1f(uf.uAlphaMaskOn, 1);
        gl.uniform4f(uf.uAlphaTint, am.tint[0], am.tint[1], am.tint[2], am.tint[3]);
        gl.uniform1f(uf.uAlphaTintI, am.intensity != null ? am.intensity : 0.8);
      } else {
        gl.uniform1f(uf.uAlphaMaskOn, 0);
        gl.uniform4f(uf.uAlphaTint, 0, 0, 0, 0);
        gl.uniform1f(uf.uAlphaTintI, 0);
      }
      const sdf = p.sdf;
      const sdfW = sdf && sdf.image ? (sdf.image.naturalWidth || sdf.image.width) : 0;
      const sdfH = sdf && sdf.image ? (sdf.image.naturalHeight || sdf.image.height) : 0;
      if (sdf && sdf.image && sdfW > 0 && sdfH > 0) {
        this._uploadSdf(sdf.image, sdf.version || 0);
        gl.uniform1f(uf.uSdfEnabled, 1);
        gl.uniform1i(uf.uSdf, 1);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._sdfTex);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform2f(uf.uSdfSize, sdfW, sdfH);
        gl.uniform1f(uf.uSdfRefractionHeight, (sdf.refractionHeight != null ? sdf.refractionHeight : 48) * ratio);
        gl.uniform1f(uf.uSdfLightAngle, (sdf.lightAngle != null ? sdf.lightAngle : 45) * Math.PI / 180);
      } else {
        gl.uniform1f(uf.uSdfEnabled, 0);
        gl.uniform2f(uf.uSdfSize, 1, 1);
        gl.uniform1f(uf.uSdfRefractionHeight, 0);
        gl.uniform1f(uf.uSdfLightAngle, 0);
      }
      GLU.drawQuad(gl);
    }

    _ensureTargets(w, h) {
      if (this._targets && this._targets[0].width === w && this._targets[0].height === h) return;
      if (this._targets) for (const t of this._targets) t.dispose();
      this._targets = [
        GLU.createTarget(this.gl, w, h),
        GLU.createTarget(this.gl, w, h)
      ];
    }

    _uploadBackdrop() {
      if (!this._backdropDirty) return;
      this._backdropDirty = false;
      const gl = this.gl;
      const img = this.backdrop.image;
      if (this._backdropTex) { gl.deleteTexture(this._backdropTex); this._backdropTex = null; }
      if (img) this._backdropTex = GLU.uploadTexture(gl, img);
      else this._backdropTex = GLU.createTexture(gl, 1, 1);
    }

    _uploadTrack(track) {
      const gl = this.gl;
      if (this._trackTex && this._trackVersion === track.version) return;
      this._trackVersion = track.version;
      if (this._trackTex) gl.deleteTexture(this._trackTex);
      this._trackTex = GLU.uploadTexture(gl, track.canvas);
    }

    _uploadSdf(image, version) {
      const gl = this.gl;
      if (this._sdfTex && this._sdfImage === image && this._sdfVersion === version) return;
      this._sdfImage = image;
      this._sdfVersion = version;
      if (this._sdfTex) gl.deleteTexture(this._sdfTex);
      this._sdfTex = GLU.uploadTexture(gl, image);
    }

    _gaussWeights(sigma, n) {
      const w = new Float32Array(32);
      if (sigma < 0.01) { w[0] = 1; return w; }
      // 中心权重必须显式置 1：此前缺失导致小 σ 时总权重趋近 0，
      // 模糊输出近乎全透明，按压动画（blur 8→0）末尾出现闪黑
      w[0] = 1;
      let sum = 1;
      for (let i = 1; i <= n; i++) {
        w[i] = Math.exp(-0.5 * (i / sigma) * (i / sigma));
        sum += 2 * w[i];
      }
      for (let i = 0; i <= n; i++) w[i] /= sum;
      return w;
    }

    dispose() {
      allGlass.delete(this);
      if (this._targets) for (const t of this._targets) t.dispose();
      if (this._backdropTex) { try { this.gl.deleteTexture(this._backdropTex); } catch (e) {} }
      if (this._trackTex) { try { this.gl.deleteTexture(this._trackTex); } catch (e) {} }
      if (this._sdfTex) { try { this.gl.deleteTexture(this._sdfTex); } catch (e) {} }
      // 显式释放上下文，避免达到浏览器上下文数量上限（通常 8-16 个）
      try {
        const loseExt = this.gl.getExtension('WEBGL_lose_context');
        if (loseExt) loseExt.loseContext();
      } catch (e) {}
      if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
      // 停止全局循环（若无活跃元素）
      if (allGlass.size === 0 && globalRaf) {
        cancelAnimationFrame(globalRaf);
        globalRaf = 0;
      }
    }
  }

  window.LiquidGlass = { BackdropSource, GlassElement, dpr };
})();

  /* ===== 模块 4/4：组件库 (components.js) ===== */
/* Web ports of the catalog components:
 * LiquidButton / LiquidToggle / LiquidSlider / LiquidBottomTabs
 * (app/src/commonMain/kotlin/com/kyant/backdrop/catalog/components)
 */
(function () {
  'use strict';

  const { Spring, SpringAnimatable } = window.SpringSystem;
  const { GlassElement, dpr } = window.LiquidGlass;

  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const lerp = (a, b, t) => a + (b - a) * t;

  function lerpColor(c1, c2, t) {
    return [
      lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t),
      lerp(c1[2], c2[2], t), lerp(c1[3], c2[3], t)
    ];
  }

  function cssColor(c) {
    return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;
  }

  function hexColor(hex, alpha) {
    return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, alpha];
  }

  /* Compose EaseOut = CubicBezierEasing(0.0, 0.0, 0.58, 1.0) */
  function cubicBezier(x1, y1, x2, y2) {
    return function (x) {
      let t = x;
      for (let i = 0; i < 8; i++) {
        const cx = 3 * x1 * t * (1 - t) * (1 - t) + 3 * x2 * t * t * (1 - t) + t * t * t - x;
        const dx = 3 * x1 * (1 - t) * (1 - 3 * t) + 3 * x2 * (2 * t - 3 * t * t) + 3 * t * t;
        if (Math.abs(dx) < 1e-6) break;
        t -= cx / dx;
      }
      t = clamp(t, 0, 1);
      return 3 * y1 * t * (1 - t) * (1 - t) + 3 * y2 * t * t * (1 - t) + t * t * t;
    };
  }
  const EaseOut = cubicBezier(0, 0, 0.58, 1);

  /* Port of utils/InteractiveHighlight.kt: press glow overlay drawn with
   * BlendMode.Plus (mix-blend-mode: plus-lighter). */
  class InteractiveHighlight {
    constructor(host, opts) {
      opts = opts || {};
      this.host = host;             // element whose bounds are drawn on
      this.positionFn = opts.position || null; // (size, offset) => {x, y}
      this.pressProgress = new SpringAnimatable(0, new Spring(0.5, 300, 0.001));
      this.posX = new SpringAnimatable(0, new Spring(0.5, 300, 0.1));
      this.posY = new SpringAnimatable(0, new Spring(0.5, 300, 0.1));
      this.startPosition = { x: 0, y: 0 };
      this.pressProgress.onChange = () => this._draw();
      this.posX.onChange = () => this._draw();
      this.posY.onChange = () => this._draw();
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'interactive-highlight';
      host.appendChild(this.canvas);
    }

    get progress() { return this.pressProgress.value; }
    get offset() {
      return {
        x: this.posX.value - this.startPosition.x,
        y: this.posY.value - this.startPosition.y
      };
    }

    localPos(ev) {
      const r = this.host.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }

    onDown(ev) {
      const p = this.localPos(ev);
      this.startPosition = p;
      this.pressProgress.animateTo(1);
      this.posX.snapTo(p.x);
      this.posY.snapTo(p.y);
    }

    onMove(ev) {
      const p = this.localPos(ev);
      this.posX.snapTo(p.x);
      this.posY.snapTo(p.y);
    }

    onUp() {
      this.pressProgress.animateTo(0);
      this.posX.animateTo(this.startPosition.x);
      this.posY.animateTo(this.startPosition.y);
    }

    _draw() {
      const p = this.pressProgress.value;
      const cvs = this.canvas;
      const ratio = dpr();
      const w = this.host.clientWidth, h = this.host.clientHeight;
      if (cvs.width !== w * ratio || cvs.height !== h * ratio) {
        cvs.width = Math.max(1, w * ratio);
        cvs.height = Math.max(1, h * ratio);
      }
      const ctx = cvs.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (p <= 0) return;
      const r = Math.min(w, h) / 2;
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, r);
      ctx.clip();
      ctx.fillStyle = `rgba(255,255,255,${0.08 * p})`;
      ctx.fillRect(0, 0, w, h);
      let pos = { x: this.posX.value, y: this.posY.value };
      if (this.positionFn) pos = this.positionFn({ width: w, height: h }, pos);
      pos = { x: clamp(pos.x, 0, w), y: clamp(pos.y, 0, h) };
      const rad = Math.min(w, h) * 1.5;
      const g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, rad);
      const a = 0.15 * p;
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(0.5, `rgba(255,255,255,${a})`);
      g.addColorStop(0.75, `rgba(255,255,255,${a * 0.5})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    dispose() { this.canvas.remove(); }
  }

  /* Port of utils/DampedDragAnimation.kt (spring specs preserved). */
  class DampedDragAnimation {
    constructor(opts) {
      this.min = opts.valueRange[0];
      this.max = opts.valueRange[1];
      this.vis = opts.visibilityThreshold;
      this.pressedScale = opts.pressedScale;
      this.initialScale = opts.initialScale;
      this.onDragStarted = opts.onDragStarted || null;
      this.onDragStopped = opts.onDragStopped || null;
      this.onDrag = opts.onDrag || null;

      this.valueAnim = new SpringAnimatable(opts.initialValue, new Spring(1, 1000, this.vis));
      this.velocityAnim = new SpringAnimatable(0, new Spring(0.5, 300, this.vis * 10));
      this.pressAnim = new SpringAnimatable(0, new Spring(1, 1000, 0.001));
      this.scaleXAnim = new SpringAnimatable(this.initialScale, new Spring(0.6, 250, 0.001));
      this.scaleYAnim = new SpringAnimatable(this.initialScale, new Spring(0.7, 250, 0.001));

      this._lastValue = this.valueAnim.value;
      this._lastTime = performance.now();
      this._pendingRelease = false;
      this._raf = 0;
      this.valueAnim.onChange = () => this._trackVelocity();
    }

    get value() { return this.valueAnim.value; }
    get targetValue() { return this.valueAnim.targetValue; }
    get progress() { return (this.value - this.min) / (this.max - this.min); }
    get pressProgress() { return this.pressAnim.value; }
    get scaleX() { return this.scaleXAnim.value; }
    get scaleY() { return this.scaleYAnim.value; }
    get velocity() { return this.velocityAnim.value; }

    _trackVelocity() {
      const now = performance.now();
      const dt = (now - this._lastTime) / 1000;
      if (dt > 0.0005) {
        const v = (this.valueAnim.value - this._lastValue) / dt / (this.max - this.min);
        this.velocityAnim.animateTo(clamp(v, -100, 100));
        this._lastValue = this.valueAnim.value;
        this._lastTime = now;
      }
    }

    press() {
      this.pressAnim.animateTo(1);
      this.scaleXAnim.animateTo(this.pressedScale);
      this.scaleYAnim.animateTo(this.pressedScale);
    }

    release() {
      const range = this.max - this.min;
      const threshold = range * 0.025;
      if (this.value !== this.targetValue) {
        this._pendingRelease = true;
        const check = () => {
          if (Math.abs(this.value - this.targetValue) < threshold || !this.valueAnim.running) {
            this._pendingRelease = false;
            this._doRelease();
          } else {
            this._raf = requestAnimationFrame(check);
          }
        };
        this._raf = requestAnimationFrame(check);
      } else {
        this._doRelease();
      }
    }

    _doRelease() {
      this.pressAnim.animateTo(0);
      this.scaleXAnim.animateTo(this.initialScale);
      this.scaleYAnim.animateTo(this.initialScale);
      this.velocityAnim.animateTo(0);
    }

    updateValue(v) {
      this.valueAnim.animateTo(clamp(v, this.min, this.max));
    }

    animateToValue(v) {
      this.press();
      this.valueAnim.animateTo(clamp(v, this.min, this.max));
      if (this.velocity !== 0) this.velocityAnim.animateTo(0);
      this.release();
    }

    /* Attach drag gestures to an element. */
    attach(el, getSize) {
      let dragging = false;
      let last = null;
      el.addEventListener('pointerdown', (ev) => {
        dragging = true;
        last = { x: ev.clientX, y: ev.clientY };
        el.setPointerCapture(ev.pointerId);
        if (this.onDragStarted) this.onDragStarted(this._local(el, ev));
        this.press();
        ev.preventDefault();
      });
      el.addEventListener('pointermove', (ev) => {
        if (!dragging) return;
        const size = getSize();
        const amount = { x: ev.clientX - last.x, y: ev.clientY - last.y };
        last = { x: ev.clientX, y: ev.clientY };
        if (this.onDrag) this.onDrag(size, amount);
      });
      const stop = () => {
        if (!dragging) return;
        dragging = false;
        if (this.onDragStopped) this.onDragStopped();
        this.release();
      };
      el.addEventListener('pointerup', stop);
      el.addEventListener('pointercancel', stop);
    }

    _local(el, ev) {
      const r = el.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }
  }

  /* Shared per-frame updater loop for component transforms/effects. */
  const updaters = new Set();
  let updaterRaf = 0;
  function ensureUpdaterLoop() {
    if (updaterRaf) return;
    const loop = () => {
      for (const u of updaters) u();
      updaterRaf = requestAnimationFrame(loop);
    };
    updaterRaf = requestAnimationFrame(loop);
  }

  const CAPSULE = [1000, 1000, 1000, 1000];

  /* ---- LiquidButton (components/LiquidButton.kt) ----
   * effects: vibrancy(); blur(2dp); lens(12dp, 24dp)
   * highlight: Highlight.Default; shadow: Shadow.Default */
  function createLiquidButton(opts) {
    const el = document.createElement('div');
    el.className = 'liquid-btn';
    if (opts.className) el.className += ' ' + opts.className;

    const glass = new GlassElement(opts.backdrop, { radii: CAPSULE, shadowPad: 48 });
    el.appendChild(glass.canvas);

    const ih = new InteractiveHighlight(el);

    const content = document.createElement('div');
    content.className = 'liquid-content';
    if (typeof opts.content === 'string') content.textContent = opts.content;
    else if (opts.content) content.appendChild(opts.content);
    el.appendChild(content);

    let lastTransform = '';
    const update = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (w === 0) return;
      glass.setSize(w, h);
      const extraLayers = (opts.layers || []).map((l) => ({
        canvas: l.canvas, version: l.version(), rect: l.rect(), scaleX: 1, scaleY: 1
      }));
      glass.render({
        vibrancy: true,
        blurRadius: 2,
        refractionHeight: 12,
        refractionAmount: 24,
        tint: opts.tint || null,
        surfaceColor: opts.surfaceColor || null,
        shadow: { radius: 24, offsetX: 0, offsetY: 4, color: [0, 0, 0, 0.1], alpha: 1 },
        highlight: { style: 'default', width: 0.5, blurRadius: 0.25, alpha: 1, angle: 45, falloff: 1, color: [1, 1, 1, 1] },
        tracks: extraLayers
      });
      const p = ih.progress;
      const off = ih.offset;
      const scale = lerp(1, 1 + 4 / h, p);
      const maxOffset = Math.min(w, h);
      const tx = maxOffset * Math.tanh(0.05 * off.x / maxOffset);
      const ty = maxOffset * Math.tanh(0.05 * off.y / maxOffset);
      const maxDragScale = 4 / h;
      const angle = Math.atan2(off.y, off.x);
      const maxDim = Math.max(w, h);
      const sx = scale + maxDragScale * Math.abs(Math.cos(angle) * off.x / maxDim) * Math.min(w / h, 1);
      const sy = scale + maxDragScale * Math.abs(Math.sin(angle) * off.y / maxDim) * Math.min(h / w, 1);
      const t = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
      if (t !== lastTransform) { lastTransform = t; el.style.transform = t; }
    };
    updaters.add(update);
    ensureUpdaterLoop();

    el.addEventListener('pointerdown', (ev) => { ih.onDown(ev); el.setPointerCapture(ev.pointerId); });
    el.addEventListener('pointermove', (ev) => { if (ev.buttons) ih.onMove(ev); });
    const up = () => ih.onUp();
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    if (opts.onClick) el.addEventListener('click', opts.onClick);

    el.dispose = () => { updaters.delete(update); glass.dispose(); ih.dispose(); };
    return el;
  }

  /* ---- LiquidToggle (components/LiquidToggle.kt) ----
   * track 64x28, thumb 40x24, dragWidth 20dp, accent #34C759. */
  function createLiquidToggle(opts) {
    const accent = hexColor(0x34C759, 1);
    const trackColor = hexColor(0x787878, 0.2);

    const el = document.createElement('div');
    el.className = 'liquid-toggle';

    const trackEl = document.createElement('div');
    trackEl.className = 'liquid-toggle-track';
    el.appendChild(trackEl);

    const thumb = document.createElement('div');
    thumb.className = 'liquid-toggle-thumb';
    el.appendChild(thumb);

    const glass = new GlassElement(opts.backdrop, { radii: CAPSULE, shadowPad: 12 });
    thumb.appendChild(glass.canvas);

    // track texture for the thumb's combined backdrop
    const trackCanvas = document.createElement('canvas');
    let trackVersion = 0;
    const drawTrack = (fraction) => {
      const ratio = dpr();
      trackCanvas.width = 64 * ratio;
      trackCanvas.height = 28 * ratio;
      const ctx = trackCanvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, 64, 28);
      ctx.fillStyle = cssColor(lerpColor(trackColor, accent, fraction));
      ctx.beginPath();
      ctx.roundRect(0, 0, 64, 28, 14);
      ctx.fill();
      trackVersion++;
    };

    let fraction = opts.selected() ? 1 : 0;
    let lastSelected = opts.selected();
    let didDrag = false;
    const anim = new DampedDragAnimation({
      initialValue: fraction, valueRange: [0, 1], visibilityThreshold: 0.001,
      initialScale: 1, pressedScale: 1.5,
      onDrag: (size, amount) => {
        if (!didDrag) didDrag = amount.x !== 0;
        fraction = clamp(fraction + amount.x / 20, 0, 1);
        anim.updateValue(fraction);
      },
      onDragStopped: () => {
        if (didDrag) {
          fraction = anim.targetValue >= 0.5 ? 1 : 0;
          opts.onSelect(fraction === 1);
          didDrag = false;
        } else {
          fraction = opts.selected() ? 0 : 1;
          opts.onSelect(fraction === 1);
        }
        anim.animateToValue(fraction);
      }
    });
    anim.attach(thumb, () => ({ width: 64, height: 28 }));

    // 点击轨道任意位置直接切换（拇指拖拽逻辑不变）
    trackEl.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      const v = !opts.selected();
      fraction = v ? 1 : 0;
      opts.onSelect(v);
      anim.animateToValue(fraction);
    });

    let lastFractionStr = '';
    let lastTransform = '';
    const update = () => {
      const tw = el.clientWidth, th = el.clientHeight;
      if (tw === 0) return;
      // Keep sibling toggles bound to the same selected state synchronized,
      // matching the original snapshotFlow { selected() } collector.
      const selected = opts.selected();
      if (selected !== lastSelected) {
        lastSelected = selected;
        const target = selected ? 1 : 0;
        if (target !== fraction) {
          fraction = target;
          anim.animateToValue(target);
        }
      }
      const f = anim.value;

      // track visual + texture
      const fs = f.toFixed(3);
      if (fs !== lastFractionStr) {
        lastFractionStr = fs;
        trackEl.style.background = cssColor(lerpColor(trackColor, accent, f));
        drawTrack(f);
      }

      const p = anim.pressProgress;
      glass.setSize(40, 24);
      glass.render({
        blurRadius: 8 * (1 - p),
        refractionHeight: 5 * p,
        refractionAmount: 10 * p,
        chromaticAberration: true,
        highlight: { style: 'ambient', width: 0.5 / 1.5, blurRadius: 0.25 / 1.5, alpha: p },
        shadow: { radius: 4, offsetX: 0, offsetY: 2 / 3, color: [0, 0, 0, 0.05], alpha: 1 },
        innerShadow: p > 0.001 ? { radius: 4 * p, offsetX: 0, offsetY: 4 * p, color: [0, 0, 0, 0.15], alpha: p } : null,
        surfaceColor: p < 0.999 ? [1, 1, 1, 1 - p] : null,
        track: {
          canvas: trackCanvas, version: trackVersion,
          rect: [-(anim.value * 20 + 2), -2, 64, 28],
          scaleX: lerp(2 / 3, 0.75, p), scaleY: lerp(0, 0.75, p)
        }
      });

      // thumb position + velocity squash (layerBlock)
      const v = clamp(anim.velocity / 50, -0.2, 0.2);
      let sx = anim.scaleX / (1 - clamp(v * 0.75, -0.2, 0.2));
      let sy = anim.scaleY * (1 - clamp(v * 0.25, -0.2, 0.2));
      const tx = lerp(2, 2 + 20, f);
      const t = `translate(${tx.toFixed(2)}px, 0px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
      if (t !== lastTransform) { lastTransform = t; thumb.style.transform = t; }
    };
    updaters.add(update);
    ensureUpdaterLoop();

    el._setSelected = (v) => {
      fraction = v ? 1 : 0;
      anim.animateToValue(fraction);
    };
    el.dispose = () => { updaters.delete(update); glass.dispose(); cancelAnimationFrame(anim._raf); };
    return el;
  }

  /* ---- LiquidSlider (components/LiquidSlider.kt) ----
   * track 6dp tall full width, thumb 40x24, accent #0088FF. */
  function createLiquidSlider(opts) {
    const accent = hexColor(0x0088FF, 1);
    const trackColor = hexColor(0x787878, 0.2);
    const range = opts.valueRange[1] - opts.valueRange[0];

    const el = document.createElement('div');
    el.className = 'liquid-slider';

    const trackEl = document.createElement('div');
    trackEl.className = 'liquid-slider-track';
    const accentEl = document.createElement('div');
    accentEl.className = 'liquid-slider-accent';
    el.appendChild(trackEl);
    el.appendChild(accentEl);

    const thumb = document.createElement('div');
    thumb.className = 'liquid-slider-thumb';
    el.appendChild(thumb);

    const glass = new GlassElement(opts.backdrop, { radii: CAPSULE, shadowPad: 12 });
    thumb.appendChild(glass.canvas);

    const trackCanvas = document.createElement('canvas');
    let trackVersion = 0;
    const drawTrack = (progress) => {
      const W = Math.max(1, Math.round(el.clientWidth));
      const ratio = dpr();
      trackCanvas.width = W * ratio;
      trackCanvas.height = 6 * ratio;
      const ctx = trackCanvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, W, 6);
      ctx.fillStyle = cssColor(trackColor);
      ctx.beginPath(); ctx.roundRect(0, 0, W, 6, 3); ctx.fill();
      ctx.fillStyle = cssColor(accent);
      if (progress > 0.001) {
        ctx.beginPath(); ctx.roundRect(0, 0, W * progress, 6, 3); ctx.fill();
      }
      trackVersion++;
    };

    let didDrag = false;
    let lastExternalValue = opts.value();
    const anim = new DampedDragAnimation({
      initialValue: opts.value(), valueRange: opts.valueRange,
      visibilityThreshold: opts.visibilityThreshold || 0.01,
      initialScale: 1, pressedScale: 1.5,
      onDrag: (size, amount) => {
        if (!didDrag) didDrag = amount.x !== 0;
        const W = size.width;
        const nv = clamp(anim.targetValue + range * (amount.x / W), opts.valueRange[0], opts.valueRange[1]);
        anim.updateValue(nv);
        opts.onValueChange(nv);
      },
      onDragStopped: () => {
        if (didDrag) { opts.onValueChange(anim.targetValue); didDrag = false; }
      }
    });

    anim.attach(thumb, () => ({ width: el.clientWidth, height: 24 }));
    el.addEventListener('pointerdown', (ev) => {
      if (ev.target !== trackEl && ev.target !== accentEl && !trackEl.contains(ev.target)) return;
      const r = el.getBoundingClientRect();
      const target = opts.valueRange[0] + range * ((ev.clientX - r.left) / el.clientWidth);
      anim.animateToValue(clamp(target, opts.valueRange[0], opts.valueRange[1]));
      // Compose reports the tap's target value, not the current spring value.
      opts.onValueChange(target);
    });

    let lastProgressStr = '';
    let lastTransform = '';
    const update = () => {
      const W = el.clientWidth;
      if (W === 0) return;
      // Match snapshotFlow { value() } so every slider sharing a value moves.
      const externalValue = opts.value();
      if (externalValue !== lastExternalValue) {
        lastExternalValue = externalValue;
        if (anim.targetValue !== externalValue) anim.updateValue(externalValue);
      }
      const progress = anim.progress;

      const ps = progress.toFixed(3);
      if (ps !== lastProgressStr) {
        lastProgressStr = ps;
        accentEl.style.width = (progress * 100).toFixed(2) + '%';
        drawTrack(progress);
      }

      const p = anim.pressProgress;
      glass.setSize(40, 24);
      const extraLayers = (opts.layers || []).map((l) => ({
        canvas: l.canvas, version: l.version(), rect: l.rect(), scaleX: 1, scaleY: 1
      }));
      glass.render({
        blurRadius: 8 * (1 - p),
        refractionHeight: 10 * p,
        refractionAmount: 14 * p,
        chromaticAberration: true,
        highlight: { style: 'ambient', width: 0.5 / 1.5, blurRadius: 0.25 / 1.5, alpha: p },
        shadow: { radius: 4, offsetX: 0, offsetY: 2 / 3, color: [0, 0, 0, 0.05], alpha: 1 },
        innerShadow: p > 0.001 ? { radius: 4 * p, offsetX: 0, offsetY: 4 * p, color: [0, 0, 0, 0.15], alpha: p } : null,
        surfaceColor: p < 0.999 ? [1, 1, 1, 1 - p] : null,
        track: {
          canvas: trackCanvas, version: trackVersion,
          rect: [-thumbX(), 9, W, 6],
          scaleX: lerp(2 / 3, 1, p), scaleY: lerp(0, 1, p)
        },
        tracks: extraLayers
      });

      const v = clamp(anim.velocity / 10, -0.2, 0.2);
      let sx = anim.scaleX / (1 - clamp(v * 0.75, -0.2, 0.2));
      let sy = anim.scaleY * (1 - clamp(v * 0.25, -0.2, 0.2));
      const tx = thumbX();
      const t = `translate(${tx.toFixed(2)}px, 0px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
      if (t !== lastTransform) { lastTransform = t; thumb.style.transform = t; }
    };

    function thumbX() {
      const W = el.clientWidth;
      return clamp(-20 + W * anim.progress, -10, W - 30);
    }

    updaters.add(update);
    ensureUpdaterLoop();

    el.dispose = () => { updaters.delete(update); glass.dispose(); cancelAnimationFrame(anim._raf); };
    return el;
  }

  /* FlightIcon vector path (catalog/FlightIcon.kt), viewBox 960x960 */
  const FLIGHT_PATH = 'M400 552 L147 653 Q123 663 101.5 648.5 T80 608 L80 586 Q80 574 85.5 563 T101 545 L400 336 L400 160 Q400 127 423.5 103.5 T480 80 Q513 80 536.5 103.5 T560 160 L560 336 L859 545 Q869 552 874.5 563 T880 586 L880 608 Q880 634 858.5 648.5 T813 653 L560 552 L560 696 L663 768 Q671 774 675.5 782.5 T680 801 L680 825 Q680 845 663.5 857.5 T627 864 L480 820 L333 864 Q313 870 296.5 857.5 T280 825 L280 801 Q280 791 284.5 782.5 T297 768 L400 696 Z';

  /* Diverse tab icons (24x24 viewBox), cycled per tab. */
  const TAB_ICONS = [
    'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
    'M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z',
    'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
    'M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
    'M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5a6 6 0 0 0-4.5-5.8V4a1.5 1.5 0 0 0-3 0v1.2A6 6 0 0 0 6 11v5l-2 2v1h16v-1z'
  ];
  function tabIconSvg(i, color, size) {
    const d = TAB_ICONS[i % TAB_ICONS.length];
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" style="display:block" fill="' + color + '"><path d="' + d + '"/></svg>';
  }
  function drawTabIcon(ctx, i, color, size, cx, cy) {
    const d = TAB_ICONS[i % TAB_ICONS.length];
    ctx.save();
    ctx.translate(cx - size / 2, cy - size / 2);
    ctx.scale(size / 24, size / 24);
    ctx.fillStyle = color;
    ctx.fill(new Path2D(d));
    ctx.restore();
  }

  function flightSvg(color) {
    return '<svg viewBox="0 0 960 960" width="28" height="28" style="display:block" fill="' + color + '"><path d="' + FLIGHT_PATH + '"/></svg>';
  }

  /* ---- LiquidBottomTabs (components/LiquidBottomTabs.kt) ----
   * container h64 p4: vibrancy+blur(8)+lens(24,24); pill: combined backdrop. */
  function createLiquidBottomTabs(opts) {
    const accent = hexColor(0x0088FF, 1);
    const containerColor = hexColor(0xFAFAFA, 0.4);
    const n = opts.tabsCount;
    const labels = opts.labels || Array.from({ length: n }, (_, i) => '标签 ' + (i + 1));

    const el = document.createElement('div');
    el.className = 'liquid-tabs';

    const glass = new GlassElement(opts.backdrop, { radii: CAPSULE, shadowPad: 48 });
    el.appendChild(glass.canvas);

    const ih = new InteractiveHighlight(el);

    const row = document.createElement('div');
    row.className = 'liquid-tabs-row';
    el.appendChild(row);
    for (let i = 0; i < n; i++) {
      const tab = document.createElement('div');
      tab.className = 'liquid-tab';
      tab.innerHTML = tabIconSvg(i, '#000000', 26);
      const label = document.createElement('span');
      label.textContent = labels[i];
      tab.appendChild(label);
      tab.addEventListener('click', () => selectTab(i));
      row.appendChild(tab);
    }

    // 隐形行的毛玻璃记录（Kotlin: alpha(0)+layerBackdrop 的 56dp Row）：
    // 模糊壁纸 + 容器表面色 + 蓝色内容 —— 胶囊透过它看到的就是"毛玻璃上的液态玻璃"
    const tintedCanvas = document.createElement('canvas');
    let tintedVersion = 0;
    let frostDirty = true;
    opts.backdrop.onChange(() => { frostDirty = true; });
    const drawTintedRow = (progress, po) => {
      const W = el.clientWidth;
      if (W <= 0) return;
      const ratio = dpr();
      const w = W - 8, h = 56;
      tintedCanvas.width = Math.round(w * ratio);
      tintedCanvas.height = Math.round(h * ratio);
      const ctx = tintedCanvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // The visible row scales during a press, while Android's layerBackdrop
      // is recorded before that graphicsLayer transform.  Using its visual
      // rect made the texture crop shift and leak a foreign strip at index 0.
      const tabsRect = el.getBoundingClientRect();
      const rr = { left: tabsRect.left + 4, top: tabsRect.top + 4 };

      // 1) 毛玻璃底：模糊壁纸（与容器一致的 blur 8）
      const img = opts.backdrop.image;
      const iw = img ? (img.naturalWidth || img.width) : 0;
      const ih = img ? (img.naturalHeight || img.height) : 0;
      if (img && iw > 0 && ih > 0) {
        const sw = window.innerWidth, sh = window.innerHeight;
        const sc = Math.max(sw / iw, sh / ih);
        const offX = (sw - iw * sc) * 0.5;
        const offY = (sh - ih * sc) * 0.5;
        const pad = 16;
        const sx = (rr.left - pad - offX) / sc;
        const sy = (rr.top - pad - offY) / sc;
        const sw2 = (w + pad * 2) / sc;
        const sh2 = (h + pad * 2) / sc;
        ctx.save();
        ctx.filter = 'blur(8px)';
        ctx.drawImage(img, sx, sy, sw2, sh2, -pad, -pad, w + pad * 2, h + pad * 2);
        ctx.restore();
      } else if (opts.backdrop.solidColor) {
        ctx.fillStyle = cssColor(opts.backdrop.solidColor);
        ctx.fillRect(0, 0, w, h);
      }
      // 2) 容器表面色 FAFAFA@0.4
      ctx.fillStyle = cssColor(containerColor);
      ctx.fillRect(0, 0, w, h);

      // 3) 蓝色内容（按 DOM 布局位置绘制，与玻璃下黑色 DOM 图标重合）
      // 可见行在按压时有 scale(cscale)，而原版隐形行（layerBackdrop 源）
      // 只有 translationX 没有 scale。因此这里要把视觉矩形反解回 row
      // 的布局坐标。不能直接依赖 offsetLeft/offsetTop：Chromium 对作为
      // flex item 的 SVGElement 会返回 0，导致图标被画到标签左边缘。
      // press 放大 s=lerp(1,1.2,progress) 围绕【每个 tab 自身中心】进行
      // （对应原版 LiquidBottomTab 的 graphicsLayer scaleX/Y = scale()），
      // 切不可围绕整行中心，否则端点图标会被甩出胶囊外。
      const tabs = row.querySelectorAll('.liquid-tab');
      const s = lerp(1, 1.2, progress);
      const rowRect = row.getBoundingClientRect();
      const rowW = row.offsetWidth || w;
      const rowH = row.offsetHeight || h;
      // drawTintedRow runs before the current row transform is applied, so use
      // the scale that is actually on screen rather than the requested one.
      const rowScaleX = rowW > 0 ? rowRect.width / rowW : 1;
      const rowScaleY = rowH > 0 ? rowRect.height / rowH : 1;
      const rowCenterX = rowRect.left + rowRect.width / 2;
      const rowCenterY = rowRect.top + rowRect.height / 2;
      const layoutCenter = (node, scaleX, scaleY) => {
        const r = node.getBoundingClientRect();
        return {
          x: (r.left + r.width / 2 - rowCenterX) / Math.max(scaleX, 0.0001) + rowW / 2,
          y: (r.top + r.height / 2 - rowCenterY) / Math.max(scaleY, 0.0001) + rowH / 2
        };
      };
      for (let i = 0; i < n; i++) {
        const tb = tabs[i];
        if (!tb) continue;
        const ic = tb.querySelector('svg');
        const sp = tb.querySelector('span');
        if (!ic || !sp) continue;
        const tabCenter = layoutCenter(tb, rowScaleX, rowScaleY);
        const iconCenter = layoutCenter(ic, rowScaleX, rowScaleY);
        const labelCenter = layoutCenter(sp, rowScaleX, rowScaleY);
        const tcx = tabCenter.x, tcy = tabCenter.y;
        const ix = iconCenter.x, iy = iconCenter.y;
        const lx = labelCenter.x, ly = labelCenter.y;
        // 围绕 tab 中心放大 s 倍
        const ixS = tcx + (ix - tcx) * s;
        const iyS = tcy + (iy - tcy) * s;
        const lxS = tcx + (lx - tcx) * s;
        const lyS = tcy + (ly - tcy) * s;
        const iconSize = 26 * s;
        drawTabIcon(ctx, i, cssColor(accent), iconSize, ixS, iyS);
        ctx.fillStyle = cssColor(accent);
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(labels[i], lxS, lyS);
      }
      tintedVersion++;
    };

    const pill = document.createElement('div');
    pill.className = 'liquid-tabs-pill';
    el.appendChild(pill);
    const pillGlass = new GlassElement(opts.backdrop, { radii: CAPSULE, shadowPad: 48 });
    pill.appendChild(pillGlass.canvas);

    let currentIndex = opts.selectedTabIndex();
    let lastExternalIndex = currentIndex;
    const offsetAnim = new SpringAnimatable(0, new Spring(1, 300, 0.5));

    const tabWidth = () => (el.clientWidth - 8) / n;

    const anim = new DampedDragAnimation({
      initialValue: opts.selectedTabIndex(), valueRange: [0, n - 1],
      visibilityThreshold: 0.001, initialScale: 1, pressedScale: 78 / 56,
      onDrag: (size, amount) => {
        anim.updateValue(anim.targetValue + amount.x / tabWidth());
        offsetAnim.snapTo(offsetAnim.value + amount.x);
      },
      onDragStopped: () => {
        const ti = clamp(Math.round(anim.targetValue), 0, n - 1);
        currentIndex = ti;
        anim.animateToValue(ti);
        offsetAnim.animateTo(0);
        if (opts.onTabSelected) opts.onTabSelected(ti);
      }
    });
    anim.attach(pill, () => ({ width: el.clientWidth, height: 64 }));

    function selectTab(i) {
      currentIndex = i;
      anim.animateToValue(i);
      if (opts.onTabSelected) opts.onTabSelected(i);
    }

    ih.positionFn = (size, pos) => ({
      x: (anim.value + 0.5) * tabWidth() + panelOffset(),
      y: size.height / 2
    });

    function panelOffset() {
      const frac = clamp(offsetAnim.value / el.clientWidth, -1, 1);
      return 4 * Math.sign(frac) * EaseOut(Math.abs(frac));
    }

    let lastProg = '', lastPillT = '', lastRowT = '', lastWidth = 0, lastPo = 0;
    const update = () => {
      const W = el.clientWidth;
      if (!W) return;
      const externalIndex = clamp(opts.selectedTabIndex(), 0, n - 1);
      if (externalIndex !== lastExternalIndex) {
        lastExternalIndex = externalIndex;
        currentIndex = externalIndex;
        if (anim.targetValue !== externalIndex) anim.animateToValue(externalIndex);
      }
      const p = anim.pressProgress;
      const po = panelOffset();

      glass.setSize(W, 64);
      glass.render({
        vibrancy: true, blurRadius: 8,
        refractionHeight: 24, refractionAmount: 24,
        tint: null, surfaceColor: containerColor,
        shadow: { radius: 24, offsetX: 0, offsetY: 4, color: [0, 0, 0, 0.1], alpha: 1 },
        highlight: { style: 'default', width: 0.5, blurRadius: 0.25, alpha: 1, angle: 45, falloff: 1 }
      });

      const widthChanged = W !== lastWidth;
      if (widthChanged) {
        lastWidth = W;
        pill.style.width = ((W - 8) / n).toFixed(2) + 'px';
      }

      if (widthChanged || p.toFixed(3) !== lastProg || Math.abs(po - lastPo) > 0.5 || frostDirty) {
        drawTintedRow(p, po);
        lastProg = p.toFixed(3);
        lastPo = po;
        frostDirty = false;
      }

      pillGlass.setSize((W - 8) / n, 56);
      const a1 = 0.1 * (1 - p), a2 = 0.03 * p;
      const pillSurfaceA = a1 + (1 - a1) * a2;

      const v = clamp(anim.velocity / 10, -0.2, 0.2);
      const sy = anim.scaleY * (1 - clamp(v * 0.25, -0.2, 0.2));
      const sx = (1 + (anim.scaleY - 1) * 0.35) / (1 - clamp(v * 0.75, -0.2, 0.2));
      // The tinted row (track) is the capsule's combined backdrop: it is the
      // full-width frosted row recorded *before* the pill's graphicsLayer, so
      // it must stay at 1:1 with the region regardless of the pill's press
      // scale.  Do NOT use 1/sx here:
      //  - 1/sx shrinks the row content; the enlarged pill then refracts past
      //    the row's edge near the end tabs, leaking a hard square border +
      //    bare wallpaper (bug A).
      //  - 1  keeps the row covering the pill's window.  The press "content
      //    follows pill scale" effect comes from the pill's own DOM scale, and
      //    end-tab label drift (bug B) is prevented by converting visual child
      //    rectangles back to layout coordinates, so the row's cscale does not
      //    leak into the refracted content.
      const trackScaleX = 1;
      const trackScaleY = 1;

      pillGlass.render({
        refractionHeight: 10 * p, refractionAmount: 14 * p, chromaticAberration: true,
        highlight: { style: 'default', width: 0.5, blurRadius: 0.25, alpha: p, angle: 45, falloff: 1 },
        shadow: p > 0.001 ? { radius: 24, offsetX: 0, offsetY: 4, color: [0, 0, 0, 0.1], alpha: p } : null,
        innerShadow: p > 0.001 ? { radius: 8 * p, offsetX: 0, offsetY: 0, color: [0, 0, 0, 0.15], alpha: p } : null,
        surfaceColor: pillSurfaceA > 0.0005 ? [0, 0, 0, Math.min(pillSurfaceA, 1)] : null,
        track: {
          canvas: tintedCanvas, version: tintedVersion,
          rect: [-anim.value * tabWidth() - po, 0, W - 8, 56],
          scaleX: trackScaleX, scaleY: trackScaleY
        }
      });

      // transforms
      const pillTx = anim.value * tabWidth() + po;
      const tPill = `translate(${pillTx.toFixed(2)}px, 0px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
      if (tPill !== lastPillT) { lastPillT = tPill; pill.style.transform = tPill; }

      // 容器按压缩放（Kotlin: lerp(1, 1+16dp/W, progress)），玻璃与内容同步
      const cscale = lerp(1, 1 + 16 / W, p).toFixed(4);
      const tRow = `translateX(${po.toFixed(2)}px) scale(${cscale})`;
      if (tRow !== lastRowT) { lastRowT = tRow; row.style.transform = tRow; glass.canvas.style.transform = `scale(${cscale})`; }
    };
    updaters.add(update);
    ensureUpdaterLoop();

    el.dispose = () => {
      updaters.delete(update);
      glass.dispose(); pillGlass.dispose(); ih.dispose();
      cancelAnimationFrame(anim._raf);
    };
    el._debug = { glass, pillGlass, anim, offsetAnim, tintedCanvas, drawTintedRow };
    return el;
  }

  window.LiquidComponents = {
    createLiquidButton,
    createLiquidToggle,
    createLiquidSlider,
    createLiquidBottomTabs,
    flightSvg,
    FLIGHT_PATH
  };
})();


  /* ============================================================
   * 统一命名空间：把所有子模块收拢到 LiquidGlass 之下，
   * 方便一次性解构使用。同时保留旧的 window 全局以向后兼容。
   * ============================================================ */
  var LG = root.LiquidGlass = root.LiquidGlass || {};
  LG.version = '1.0.0';
  LG.GLU = root.GLU;
  LG.SpringSystem = root.SpringSystem;
  LG.BackdropSource = LG.BackdropSource || null;
  LG.GlassElement = LG.GlassElement || null;
  LG.dpr = LG.dpr || null;
  LG.Components = root.LiquidComponents || null;
})(typeof window !== 'undefined' ? window : this);
