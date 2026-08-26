/* Liquid Glass engine - WebGL port of com.kyant.backdrop (Android AGSL shaders).
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
