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
