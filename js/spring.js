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
