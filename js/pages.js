/* System UI + experimental demo pages (ports of app/catalog/destinations):
 * LockScreen / ControlCenter / Magnifier / GlassPlayground /
 * AdaptiveLuminanceGlass / ProgressiveBlur / ScrollContainer / LazyScrollContainer
 */
(function () {
  'use strict';

  const { GlassElement, dpr } = window.LiquidGlass;
  const C = window.LiquidComponents;
  const { Spring, SpringAnimatable } = window.SpringSystem;

  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeIn = (t) => t * t;

  /* Per-frame updater loop for pages. */
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

  /* Pan / pinch / rotate gestures -> {offsetX, offsetY, zoom, rotation}. */
  function attachTransformGestures(el, state, onChange) {
    const pointers = new Map();
    let last = null;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (ev) => {
      try { el.setPointerCapture(ev.pointerId); } catch (e) {}
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      last = null;
      ev.preventDefault();
    });
    el.addEventListener('pointermove', (ev) => {
      if (!pointers.has(ev.pointerId)) return;
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size === 1) {
        const p = pointers.values().next().value;
        if (last && last.single) {
          state.offsetX += p.x - last.x;
          state.offsetY += p.y - last.y;
          onChange();
        }
        last = { single: true, x: p.x, y: p.y };
      } else if (pointers.size >= 2) {
        const pts = [...pointers.values()].slice(0, 2);
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const angle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * 180 / Math.PI;
        const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
        if (last && last.dist) {
          state.zoom = clamp(state.zoom * (dist / last.dist), 0.4, 4);
          let dA = angle - last.angle;
          if (dA > 180) dA -= 360;
          if (dA < -180) dA += 360;
          state.rotation += dA;
          state.offsetX += cx - last.cx;
          state.offsetY += cy - last.cy;
          onChange();
        }
        last = { dist, angle, cx, cy };
      }
    });
    const up = (ev) => { pointers.delete(ev.pointerId); last = null; };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /* Virtualized real-glass cards for scroll pages (WebGL context budget ~8 live). */
  function createScrollGlassCards(container, count, backdrop) {
    const cards = [];
    for (let i = 0; i < count; i++) {
      const card = document.createElement('div');
      card.className = 'scroll-card glass-fallback';
      container.appendChild(card);
      cards.push(card);
    }
    const live = new Map();
    const MAX_LIVE = 8;
    let raf = 0;
    function update() {
      raf = 0;
      const vh = window.innerHeight;
      for (const card of cards) {
        const r = card.getBoundingClientRect();
        const near = r.bottom > -300 && r.top < vh + 300;
        const has = live.has(card);
        if (near && !has && live.size < MAX_LIVE) {
          card.classList.remove('glass-fallback');
          const glass = new GlassElement(backdrop, { radii: [32, 32, 32, 32] });
          card.appendChild(glass.canvas);
          glass.setSize(card.clientWidth, card.clientHeight);
          glass.render({ vibrancy: true, refractionHeight: 16, refractionAmount: 32 });
          live.set(card, glass);
        } else if (!near && has) {
          live.get(card).dispose();
          live.delete(card);
          card.classList.add('glass-fallback');
        }
      }
    }
    function schedule() { if (!raf) raf = requestAnimationFrame(update); }
    container.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    schedule();
    return {
      dispose() {
        for (const g of live.values()) g.dispose();
        live.clear();
        container.removeEventListener('scroll', schedule);
        window.removeEventListener('resize', schedule);
        if (raf) cancelAnimationFrame(raf);
      }
    };
  }

  function roundedRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  /* =================== LockScreen (SDF texture) =================== */
  function renderLockScreen(content) {
    const page = document.createElement('div');
    page.className = 'lockscreen';
    const dim = document.createElement('div');
    dim.className = 'lockscreen-dim';
    page.appendChild(dim);
    const top = document.createElement('div');
    top.className = 'lockscreen-top';
    page.appendChild(top);
    const wrap = document.createElement('div');
    wrap.className = 'lockscreen-clock';
    top.appendChild(wrap);
    content.appendChild(page);

    const glass = new GlassElement(backdropOf(), { radii: [0, 0, 0, 0] });
    wrap.appendChild(glass.canvas);

    const sdfImg = new Image();
    let sdfReady = false;
    sdfImg.onload = () => {
      sdfReady = true;
      if (!customSdf) wrap.style.aspectRatio = sdfImg.naturalWidth + ' / ' + sdfImg.naturalHeight;
      glass.invalidate();
    };
    sdfImg.src = 'assets/clock_sdf.webp';

    /* 由文字生成 SDF 贴图（R=符号距离, GB=法线, A=覆盖），距离场用两遍 chamfer DT */
    function generateTextSdf(text) {
      const W = 480, H = 160;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let fs = Math.floor(H * 0.72);
      const fit = () => { ctx.font = '600 ' + fs + 'px system-ui, sans-serif'; };
      fit();
      while (ctx.measureText(text).width > W * 0.88 && fs > 12) { fs -= 4; fit(); }
      ctx.fillText(text, W / 2, H / 2);
      const data = ctx.getImageData(0, 0, W, H).data;
      const N = W * H;
      const inside = new Uint8Array(N);
      for (let i = 0; i < N; i++) inside[i] = data[i * 4 + 3] > 127 ? 1 : 0;
      const INF = 1e9;
      function chamfer(seed) {
        const d = new Float32Array(N);
        for (let i = 0; i < N; i++) d[i] = seed[i] ? 0 : INF;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = y * W + x;
            let v = d[i];
            if (x > 0 && d[i - 1] + 1 < v) v = d[i - 1] + 1;
            if (y > 0) {
              if (d[i - W] + 1 < v) v = d[i - W] + 1;
              if (x > 0 && d[i - W - 1] + 1.4142 < v) v = d[i - W - 1] + 1.4142;
              if (x < W - 1 && d[i - W + 1] + 1.4142 < v) v = d[i - W + 1] + 1.4142;
            }
            d[i] = v;
          }
        }
        for (let y = H - 1; y >= 0; y--) {
          for (let x = W - 1; x >= 0; x--) {
            const i = y * W + x;
            let v = d[i];
            if (x < W - 1 && d[i + 1] + 1 < v) v = d[i + 1] + 1;
            if (y < H - 1) {
              if (d[i + W] + 1 < v) v = d[i + W] + 1;
              if (x < W - 1 && d[i + W + 1] + 1.4142 < v) v = d[i + W + 1] + 1.4142;
              if (x > 0 && d[i + W - 1] + 1.4142 < v) v = d[i + W - 1] + 1.4142;
            }
            d[i] = v;
          }
        }
        return d;
      }
      const outSeed = new Uint8Array(N);
      const inSeed = new Uint8Array(N);
      for (let i = 0; i < N; i++) { outSeed[i] = inside[i] ? 0 : 1; inSeed[i] = inside[i] ? 1 : 0; }
      const dIn = chamfer(outSeed);  // 内部像素到边缘的距离
      const dOut = chamfer(inSeed);  // 外部像素到边缘的距离
      const NORM = 24;
      const out = ctx.createImageData(W, H);
      const od = out.data;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const sd = inside[i] ? -dIn[i] : dOut[i];
          const xl = x > 0 ? i - 1 : i, xr = x < W - 1 ? i + 1 : i;
          const yu = y > 0 ? i - W : i, yd = y < H - 1 ? i + W : i;
          const sdl = inside[xl] ? -dIn[xl] : dOut[xl];
          const sdr = inside[xr] ? -dIn[xr] : dOut[xr];
          const sdu = inside[yu] ? -dIn[yu] : dOut[yu];
          const sdd = inside[yd] ? -dIn[yd] : dOut[yd];
          let gx = (xr === xl) ? 0 : sdr - sdl;
          let gy = (yd === yu) ? 0 : sdd - sdu;
          const gm = Math.hypot(gx, gy) || 1;
          gx /= gm; gy /= gm;
          const sd01 = Math.max(0, Math.min(1, 0.5 + sd / (2 * NORM)));
          od[i * 4] = Math.round(sd01 * 255);
          od[i * 4 + 1] = Math.round((gx * 0.5 + 0.5) * 255);
          od[i * 4 + 2] = Math.round((gy * 0.5 + 0.5) * 255);
          od[i * 4 + 3] = data[i * 4 + 3];
        }
      }
      ctx.putImageData(out, 0, 0);
      return c;
    }

    // 自定义时钟 UI
    let customSdf = null, sdfVersion = 0;
    const bar = document.createElement('div');
    bar.className = 'lockscreen-edit';
    const input = document.createElement('input');
    input.className = 'lockscreen-input';
    input.maxLength = 10;
    input.placeholder = '输入时钟文字';
    input.value = '12:45';
    const applyBtn = document.createElement('button');
    applyBtn.className = 'lockscreen-apply';
    applyBtn.textContent = '应用';
    bar.appendChild(input);
    bar.appendChild(applyBtn);
    page.appendChild(bar);
    applyBtn.addEventListener('click', () => {
      const t = (input.value || '').trim() || '12:45';
      customSdf = generateTextSdf(t);
      sdfVersion++;
      wrap.style.aspectRatio = '480 / 160';
      glass.invalidate();
    });
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') applyBtn.click(); });

    let ox = 0, oy = 0, sx = 0, sy = 0, dragging = false;
    wrap.addEventListener('pointerdown', (ev) => {
      dragging = true;
      sx = ev.clientX - ox; sy = ev.clientY - oy;
      try { wrap.setPointerCapture(ev.pointerId); } catch (e) {}
      ev.preventDefault();
    });
    wrap.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      ox = ev.clientX - sx; oy = ev.clientY - sy;
      wrap.style.transform = 'translate(' + ox.toFixed(1) + 'px,' + oy.toFixed(1) + 'px)';
    });
    const up = () => { dragging = false; };
    wrap.addEventListener('pointerup', up);
    wrap.addEventListener('pointercancel', up);

    const update = () => {
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (w === 0 || h === 0) return;
      glass.setSize(w, h);
      const sdfImage = customSdf || (sdfReady ? sdfImg : null);
      glass.render({
        blurRadius: 2,
        colorControls: { brightness: -0.1, contrast: 0.75, saturation: 1.5 },
        surfaceColor: [1, 1, 1, 0.25],
        sdf: sdfImage ? { image: sdfImage, version: sdfVersion, refractionHeight: 48, lightAngle: 45 } : null
      });
    };
    updaters.add(update);
    ensureUpdaterLoop();
    content._dispose = () => { updaters.delete(update); glass.dispose(); };
  }

  /* =================== Control Center =================== */
  function renderControlCenter(content) {
    const accent = '#0088ff';
    const root = document.createElement('div');
    root.className = 'cc-root';
    const dim = document.createElement('div');
    dim.className = 'cc-dim';
    root.appendChild(dim);
    const col = document.createElement('div');
    col.className = 'cc-col';
    root.appendChild(col);
    content.appendChild(root);

    const wallpaper = content.parentElement ? content.parentElement.querySelector('.wallpaper') : null;

    const tiles = [];
    const spacers = [];

    function makeTile(parent, w, h, build) {
      const el = document.createElement('div');
      el.className = 'cc-tile';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      const glass = new GlassElement(backdropOf(), { radii: [34, 34, 34, 34], regionPad: 56 });
      el.appendChild(glass.canvas);
      glass.setSize(w, h);
      if (build) build(el);
      parent.appendChild(el);
      tiles.push({ el, glass });
      return el;
    }
    const addIcon = (el) => {
      const ic = document.createElement('div');
      ic.className = 'cc-icon';
      ic.innerHTML = C.flightSvg('#fff');
      el.appendChild(ic);
    };
    const iconTile = (parent, w, h) => makeTile(parent, w, h, addIcon);
    const row = (parent) => {
      const r = document.createElement('div');
      r.className = 'cc-row';
      parent.appendChild(r);
      return r;
    };
    const col2 = (parent) => {
      const c = document.createElement('div');
      c.className = 'cc-col2';
      parent.appendChild(c);
      return c;
    };
    const spacer = (parent, base, over) => {
      const s = document.createElement('div');
      s.className = 'cc-spacer';
      parent.appendChild(s);
      spacers.push({ el: s, base, over });
      return s;
    };
    const pill = (parent, cls, active) => {
      const p = document.createElement('div');
      p.className = 'cc-inner ' + cls;
      p.style.background = active ? accent : 'rgba(255,255,255,0.2)';
      p.innerHTML = C.flightSvg('#fff');
      parent.appendChild(p);
    };

    // row 1
    const row1 = row(col);
    makeTile(row1, 152, 152, (el) => {
      el.classList.add('cc-pad');
      pill(el, 'cc-inner-tl', false);
      pill(el, 'cc-inner-tr', true);
      pill(el, 'cc-inner-bl', true);
    });
    makeTile(row1, 152, 152);
    spacer(col, 16, 32);

    // row 2
    const row2 = row(col);
    const c21 = col2(row2);
    const r21 = row(c21);
    iconTile(r21, 68, 68);
    iconTile(r21, 68, 68);
    spacer(c21, 16, 16);
    makeTile(c21, 152, 68);
    const r22 = row(row2);
    makeTile(r22, 68, 152);
    makeTile(r22, 68, 152);
    spacer(col, 16, 32);

    // row 3
    const row3 = row(col);
    makeTile(row3, 152, 152);
    const c31 = col2(row3);
    const r31 = row(c31);
    iconTile(r31, 68, 68);
    iconTile(r31, 68, 68);
    spacer(c31, 16, 16);
    const r32 = row(c31);
    iconTile(r32, 68, 68);

    // enter/exit progress (drag vertically anywhere)
    const enter = new SpringAnimatable(1, new Spring(1, 300, 0.01));
    const safe = new SpringAnimatable(1, new Spring(1, 300, 0.01));
    let active = false, y0 = 0, vel = 0, lastT = 0;
    root.addEventListener('pointerdown', (ev) => {
      active = true; y0 = ev.clientY; vel = 0; lastT = performance.now();
      try { root.setPointerCapture(ev.pointerId); } catch (e) {}
    });
    root.addEventListener('pointermove', (ev) => {
      if (!active) return;
      const now = performance.now();
      const dt = Math.max(1, now - lastT);
      vel = (ev.clientY - y0) / dt * 1000 * 0.4 + vel * 0.6;
      lastT = now;
      const delta = ev.clientY - y0;
      y0 = ev.clientY;
      enter.snapTo(clamp(enter.value + delta / 500, -0.4, 1.4));
      safe.snapTo(clamp(enter.value, 0, 1));
    });
    const stop = () => {
      if (!active) return;
      active = false;
      const target = vel < -120 ? 0 : (vel > 120 ? 1 : (enter.value < 0.5 ? 0 : 1));
      enter.animateTo(target);
      safe.animateTo(target);
    };
    root.addEventListener('pointerup', stop);
    root.addEventListener('pointercancel', stop);

    const update = () => {
      const p = enter.value;
      const sp = safe.value;
      const over = Math.max(0, p - 1);
      for (const t of tiles) {
        t.el.style.transform = 'translateY(' + (-48 * (1 - p)).toFixed(2) + 'px)' +
          ' scale(' + (1 / (1 + 0.1 * over)).toFixed(4) + ',' + (1 + 0.1 * over).toFixed(4) + ')';
        t.el.style.opacity = easeIn(sp).toFixed(3);
        t.glass.render({
          vibrancy: true,
          refractionHeight: 24 * sp,
          refractionAmount: 48 * sp,
          depthEffect: true,
          highlight: { style: 'default', width: 0.5, blurRadius: 0.25, alpha: 1, angle: 45, falloff: 2 },
          surfaceColor: [0, 0, 0, 0.05]
        });
      }
      for (const s of spacers) {
        s.el.style.height = (s.base + s.over * over).toFixed(1) + 'px';
      }
      dim.style.opacity = (0.4 * sp).toFixed(3);
      if (wallpaper) wallpaper.style.filter = sp > 0.01 ? 'blur(' + (4 * sp).toFixed(1) + 'px)' : '';
    };
    updaters.add(update);
    ensureUpdaterLoop();
    content._dispose = () => {
      updaters.delete(update);
      for (const t of tiles) t.glass.dispose();
      if (wallpaper) wallpaper.style.filter = '';
    };
  }

  /* =================== Magnifier =================== */
  function renderMagnifier(content) {
    const DEFAULT_TEXT = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.';

    const page = document.createElement('div');
    page.className = 'mag-page';
    content.appendChild(page);

    let cardW = 0, cardH = 0, cardLeft = 0, cardTop = 0;
    const textPad = 28;
    const TEXT_LINE_HEIGHT = 24;
    const CARET_VISUAL_OFFSET_Y = -2;
    const LINE_SWITCH_SLOP = 4;
    let textValue = DEFAULT_TEXT;
    let textLines = [];
    let caretStops = [];
    let caretIndices = [];
    let lineBreakTypes = [];
    let scrollLine = 0;
    let cardVersion = 0;
    let editorFocused = false;
    let editorSelectionStart = 0;
    let editorSelectionEnd = 0;
    let editorSelectionDirection = 'none';

    // renderMagnifier is built before the scaffold is attached, so
    // content.clientWidth is still zero here. Size from the viewport instead:
    // the editor becomes the main surface while preserving room for the
    // bottom image picker.
    function updateCardGeometry() {
      const vw = Math.max(320, window.innerWidth);
      const vh = Math.max(480, window.innerHeight);
      const sideMargin = clamp(vw * 0.05, 16, 40);
      cardW = Math.max(280, Math.min(vw - sideMargin * 2, 960));
      cardLeft = Math.round((vw - cardW) * 0.5);
      cardTop = Math.round(clamp(vh * 0.045, 20, 36));
      cardH = Math.max(280, Math.min(vh - cardTop - 112, 620));
    }
    updateCardGeometry();

    // text card rendered onto a canvas (also used as the lens backdrop layer)
    const card = document.createElement('canvas');
    card.className = 'mag-text';
    page.appendChild(card);

    function visibleLineCount() {
      return Math.max(1, Math.floor((cardH - textPad * 2) / TEXT_LINE_HEIGHT));
    }

    function pushTextLine(ctx, start, end, breakType) {
      const line = textValue.slice(start, end);
      textLines.push(line);
      lineBreakTypes.push(breakType);
      const stops = [0];
      const indices = [start];
      for (let i = 1; i <= line.length; i++) {
        stops.push(ctx.measureText(line.slice(0, i)).width);
        indices.push(start + i);
      }
      caretStops.push(stops);
      caretIndices.push(indices);
    }

    function layoutEditableText(ctx, maxW) {
      textLines = [];
      caretStops = [];
      caretIndices = [];
      lineBreakTypes = [];

      let start = 0;
      let i = 0;
      let lastBreak = -1;
      while (i < textValue.length) {
        const ch = textValue[i];
        if (ch === '\n') {
          pushTextLine(ctx, start, i, 'hard');
          i++;
          start = i;
          lastBreak = -1;
          continue;
        }
        if (ch === ' ' || ch === '\t') lastBreak = i;
        const width = ctx.measureText(textValue.slice(start, i + 1)).width;
        if (width > maxW && i > start) {
          const breakAt = lastBreak >= start ? lastBreak + 1 : i;
          pushTextLine(ctx, start, breakAt, 'soft');
          start = breakAt;
          i = start;
          lastBreak = -1;
          continue;
        }
        i++;
      }
      pushTextLine(ctx, start, textValue.length, 'end');
    }

    function renderCard() {
      const ratio = dpr();
      const pad = textPad;
      card.width = Math.round(cardW * ratio);
      card.height = Math.round(cardH * ratio);
      card.style.width = cardW + 'px';
      card.style.height = cardH + 'px';
      card.style.left = cardLeft + 'px';
      card.style.top = cardTop + 'px';
      const ctx = card.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.font = '16px system-ui, sans-serif';
      layoutEditableText(ctx, cardW - pad * 2);
      scrollLine = clamp(scrollLine, 0, Math.max(0, textLines.length - visibleLineCount()));

      ctx.clearRect(0, 0, cardW, cardH);
      roundedRectPath(ctx, 0, 0, cardW, cardH, 32);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.save();
      roundedRectPath(ctx, 0, 0, cardW, cardH, 32);
      ctx.clip();
      if (editorFocused && editorSelectionEnd > editorSelectionStart) {
        ctx.fillStyle = 'rgba(0,136,255,0.18)';
        const visibleCount = visibleLineCount();
        for (let i = scrollLine; i < Math.min(textLines.length, scrollLine + visibleCount); i++) {
          const indices = caretIndices[i] || [0];
          const lineStart = indices[0];
          const lineEnd = indices[indices.length - 1];
          const from = Math.max(editorSelectionStart, lineStart);
          const to = Math.min(editorSelectionEnd, lineEnd);
          if (to <= from) continue;
          const stops = caretStops[i] || [0];
          const x1 = pad + stops[clamp(from - lineStart, 0, stops.length - 1)];
          const x2 = pad + stops[clamp(to - lineStart, 0, stops.length - 1)];
          const y = pad + (i - scrollLine) * TEXT_LINE_HEIGHT;
          ctx.fillRect(x1, y, Math.max(2, x2 - x1), TEXT_LINE_HEIGHT);
        }
      }
      ctx.fillStyle = '#000';
      ctx.font = '16px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      const visibleCount = visibleLineCount();
      for (let i = scrollLine; i < Math.min(textLines.length, scrollLine + visibleCount); i++) {
        ctx.fillText(textLines[i], pad, pad + (i - scrollLine) * TEXT_LINE_HEIGHT);
      }
      ctx.restore();
      if (editorFocused) {
        roundedRectPath(ctx, 0.75, 0.75, cardW - 1.5, cardH - 1.5, 31.25);
        ctx.strokeStyle = 'rgba(0,136,255,0.42)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      cardVersion++;
    }
    renderCard();

    // A real textarea owns editing semantics (IME, paste, undo, keyboard
    // navigation); the canvas above is its visual mirror and the texture used
    // by the magnifier. Keeping the native control visually hidden avoids a
    // second caret while preserving full text input behavior.
    const editor = document.createElement('textarea');
    editor.className = 'mag-editor-input';
    editor.value = textValue;
    editor.setAttribute('aria-label', '可编辑的放大镜文本');
    editor.spellcheck = true;
    page.appendChild(editor);

    // cursor (4x24 accent capsule) as a canvas layer
    const cursorW = 4, cursorH = 24;
    const cursor = document.createElement('canvas');
    cursor.width = cursorW * 2; cursor.height = cursorH * 2;
    (function () {
      const ctx = cursor.getContext('2d');
      ctx.scale(2, 2);
      ctx.fillStyle = '#0088ff';
      roundedRectPath(ctx, 0, 0, cursorW, cursorH, 2);
      ctx.fill();
    })();
    const cursorEl = document.createElement('div');
    cursorEl.className = 'mag-cursor';
    cursorEl.appendChild(cursor);
    page.appendChild(cursorEl);
    cursorEl.classList.add('mag-cursor-blink');

    // lens
    const lensEl = document.createElement('div');
    lensEl.className = 'mag-lens';
    page.appendChild(lensEl);
    const LENS_W = 128, LENS_H = 96;
    // Extra sampling room is intentional: the glass body trails the caret
    // while it is being dragged, so the magnified focus can briefly sit
    // outside the lens' untransformed bounds without exposing a hard edge.
    // The shadow needs enough transparent canvas around the lens to finish
    // fading. Without this pad its low-alpha tail is clipped to the 128x96
    // canvas and becomes visible as a faint rectangular silhouette.
    const lensGlass = new GlassElement(backdropOf(), {
      radii: [1000, 1000, 1000, 1000],
      regionPad: 128,
      shadowPad: 40
    });
    lensEl.appendChild(lensGlass.canvas);
    lensGlass.setSize(LENS_W, LENS_H);

    const LENS_GAP = 16;
    // Start on a real insertion point rather than at an arbitrary pixel.
    const initialLineIndex = 0;
    const initialCursorX = cardLeft + textPad - cursorW * 0.5;
    const initialCursorY = cardTop + textPad + initialLineIndex * TEXT_LINE_HEIGHT + CARET_VISUAL_OFFSET_Y;
    // The vertical spring settles slightly faster than the horizontal one.
    // On a line change this moves onto the new row first, then glides toward
    // the target character instead of cutting diagonally across the text.
    const cursorX = new SpringAnimatable(initialCursorX, new Spring(0.86, 700, 0.01));
    const cursorY = new SpringAnimatable(initialCursorY, new Spring(0.90, 900, 0.01));
    const initialTextIndex = (caretIndices[initialLineIndex] || [0])[0] || 0;
    editor.setSelectionRange(initialTextIndex, initialTextIndex);

    /* The caret is the precise interaction point; the glass body is a
     * separate, under-damped mass that chases it.  Keeping these motions
     * independent gives the lens real inertia instead of a canned scale
     * keyframe.  The same velocity -> squash/stretch idea is used by the
     * LiquidBottomTabs pill, extended here to both axes. */
    const initialLensTarget = lensTargetForCaret(cursorX.value, cursorY.value);
    const lensX = new SpringAnimatable(initialLensTarget.x, new Spring(0.56, 360, 0.02));
    const lensY = new SpringAnimatable(initialLensTarget.y, new Spring(0.58, 360, 0.02));
    const lensPress = new SpringAnimatable(0, new Spring(0.58, 320, 0.001));
    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function lensTargetForCaret(x, y) {
      const unclampedX = x + cursorW * 0.5 - LENS_W * 0.5;
      const above = y - LENS_GAP - LENS_H;
      const below = y + cursorH + LENS_GAP;
      const lensYTarget = above >= 8 ? above : below;
      return {
        x: clamp(unclampedX, 8, Math.max(8, window.innerWidth - LENS_W - 8)),
        y: clamp(lensYTarget, 8, Math.max(8, window.innerHeight - LENS_H - 8))
      };
    }

    function moveLensToCaret(x, y, immediate) {
      const target = lensTargetForCaret(x, y);
      if (immediate || reducedMotion) {
        lensX.snapTo(target.x);
        lensY.snapTo(target.y);
      } else {
        // animateTo preserves the body's current velocity, so rapid pointer
        // reversals become a visible compression followed by elastic recoil.
        lensX.animateTo(target.x);
        lensY.animateTo(target.y);
      }
    }

    // Native-style hit testing: the whole line box belongs to its line (not
    // merely the half nearest its top), and a small hysteresis zone prevents
    // a slightly low finger from accidentally switching to the next row.
    function nearestCaret(pageX, pageY, lineHint) {
      const localY = pageY - cardTop - textPad;
      const contentY = localY + scrollLine * TEXT_LINE_HEIGHT;
      const firstVisibleLine = scrollLine;
      const lastVisibleLine = Math.min(
        Math.max(0, textLines.length - 1),
        scrollLine + visibleLineCount() - 1
      );
      let lineIndex;
      if (lineHint == null) {
        // Clicks use line boxes: only crossing the line's bottom edge selects
        // the next line. Math.round() used to switch halfway down the row.
        lineIndex = clamp(
          Math.floor(contentY / TEXT_LINE_HEIGHT),
          firstVisibleLine,
          lastVisibleLine
        );
      } else {
        lineIndex = clamp(lineHint, firstVisibleLine, lastVisibleLine);
        while (lineIndex < lastVisibleLine &&
               contentY >= (lineIndex + 1) * TEXT_LINE_HEIGHT + LINE_SWITCH_SLOP) lineIndex++;
        while (lineIndex > firstVisibleLine &&
               contentY < lineIndex * TEXT_LINE_HEIGHT - LINE_SWITCH_SLOP) lineIndex--;
      }

      const stops = caretStops[lineIndex] || [0];
      const localX = clamp(pageX - cardLeft - textPad, 0, stops[stops.length - 1] || 0);
      let low = 0, high = stops.length - 1;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const boundary = (stops[mid] + stops[mid + 1]) * 0.5;
        if (localX < boundary) high = mid;
        else low = mid + 1;
      }
      return {
        x: cardLeft + textPad + stops[low] - cursorW * 0.5,
        y: cardTop + textPad + (lineIndex - scrollLine) * TEXT_LINE_HEIGHT + CARET_VISUAL_OFFSET_Y,
        lineIndex,
        charIndex: low,
        textIndex: (caretIndices[lineIndex] || [0])[low] || 0
      };
    }

    function caretForTextIndex(textIndex) {
      const index = clamp(textIndex, 0, textValue.length);
      let lineIndex = Math.max(0, textLines.length - 1);
      for (let i = 0; i < textLines.length; i++) {
        const indices = caretIndices[i] || [0];
        const end = indices[indices.length - 1];
        const selectsThisLine = index < end ||
          (index === end && (lineBreakTypes[i] !== 'soft' || i === textLines.length - 1));
        if (selectsThisLine) { lineIndex = i; break; }
      }
      const indices = caretIndices[lineIndex] || [0];
      let charIndex = clamp(index - indices[0], 0, indices.length - 1);
      // Defensive fallback for future layout variants with non-contiguous
      // indices (for example CRLF normalization).
      while (charIndex < indices.length - 1 && indices[charIndex] < index) charIndex++;
      const stops = caretStops[lineIndex] || [0];
      return {
        x: cardLeft + textPad + stops[charIndex] - cursorW * 0.5,
        y: cardTop + textPad + (lineIndex - scrollLine) * TEXT_LINE_HEIGHT + CARET_VISUAL_OFFSET_Y,
        lineIndex,
        charIndex,
        textIndex: index
      };
    }

    function ensureCaretVisible(lineIndex) {
      const count = visibleLineCount();
      const oldScrollLine = scrollLine;
      if (lineIndex < scrollLine) scrollLine = lineIndex;
      else if (lineIndex >= scrollLine + count) scrollLine = lineIndex - count + 1;
      scrollLine = clamp(scrollLine, 0, Math.max(0, textLines.length - count));
      if (scrollLine !== oldScrollLine) renderCard();
      return scrollLine !== oldScrollLine;
    }

    function restartCaretBlink() {
      // A new placement restarts the caret blink, as native editors do.
      cursorEl.classList.remove('mag-cursor-blink');
      void cursorEl.offsetWidth;
      cursorEl.classList.add('mag-cursor-blink');
    }

    function settleCursorAt(caret) {
      moveCursorVisualTo(caret);
      moveLensToCaret(caret.x, caret.y, false);
    }

    function moveCursorVisualTo(caret) {
      if (reducedMotion) {
        cursorX.snapTo(caret.x);
        cursorY.snapTo(caret.y);
        restartCaretBlink();
        return;
      }
      const changed = Math.abs(cursorX.targetValue - caret.x) > 0.01 ||
        Math.abs(cursorY.targetValue - caret.y) > 0.01;
      cursorX.animateTo(caret.x);
      cursorY.animateTo(caret.y);
      if (!changed && !cursorX.running && !cursorY.running) restartCaretBlink();
    }

    // The logical caret remains on legal text insertion positions while its
    // visual representation follows with a short non-linear spring.
    function trackCursor(pageX, pageY, acquireGesture, lineHint) {
      const caret = nearestCaret(pageX, pageY, lineHint);
      moveCursorVisualTo(caret);
      // Acquiring a drag may happen anywhere on the text. Place the lens at
      // that new handle immediately, then enable inertia for subsequent
      // pointer moves; otherwise a far-away press gives the body momentum in
      // the opposite direction before the user's actual drag even begins.
      moveLensToCaret(caret.x, caret.y, !!acquireGesture);
      return caret;
    }

    function setEditorSelection(caret, shouldFocus) {
      const hadSelection = editorSelectionEnd > editorSelectionStart;
      if (shouldFocus && document.activeElement !== editor) {
        try { editor.focus({ preventScroll: true }); } catch (e) { editor.focus(); }
      }
      try { editor.setSelectionRange(caret.textIndex, caret.textIndex); } catch (e) {}
      editorSelectionStart = caret.textIndex;
      editorSelectionEnd = caret.textIndex;
      editorSelectionDirection = 'none';
      if (hadSelection) renderCard();
    }

    function updateEditorSelectionState() {
      editorSelectionStart = editor.selectionStart || 0;
      editorSelectionEnd = editor.selectionEnd || 0;
      editorSelectionDirection = editor.selectionDirection || 'none';
    }

    function editorCaretIndex() {
      return editorSelectionDirection === 'backward' ? editorSelectionStart : editorSelectionEnd;
    }

    function syncCaretFromEditor() {
      if (document.activeElement !== editor) return;
      const textIndex = editorCaretIndex();
      let caret = caretForTextIndex(textIndex);
      if (ensureCaretVisible(caret.lineIndex)) caret = caretForTextIndex(textIndex);
      settleCursorAt(caret);
    }

    const onSelectionChange = () => {
      if (!dragging && document.activeElement === editor) {
        updateEditorSelectionState();
        renderCard();
        syncCaretFromEditor();
      }
    };
    editor.addEventListener('focus', () => {
      editorFocused = true;
      updateEditorSelectionState();
      renderCard();
      if (!dragging) syncCaretFromEditor();
    });
    editor.addEventListener('blur', () => {
      editorFocused = false;
      renderCard();
    });
    editor.addEventListener('input', () => {
      textValue = editor.value;
      updateEditorSelectionState();
      renderCard();
      syncCaretFromEditor();
    });
    editor.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') editor.blur();
    });
    document.addEventListener('selectionchange', onSelectionChange);

    let cursorWasMoving = false;
    let cursorTrackScaleX = 1, cursorTrackScaleY = 1;
    function apply() {
      const ox = cursorX.value, oy = cursorY.value;
      const cursorMoving = !reducedMotion && (cursorX.running || cursorY.running);
      const horizontalEnergy = cursorMoving ? clamp(Math.abs(cursorX.velocity) / 900, 0, 1) : 0;
      const verticalEnergy = cursorMoving ? clamp(Math.abs(cursorY.velocity) / 900, 0, 1) : 0;
      cursorTrackScaleX = 1 + horizontalEnergy * 0.48;
      cursorTrackScaleY = clamp(1 + verticalEnergy * 0.28 - horizontalEnergy * 0.16, 0.84, 1.28);
      cursorEl.style.transform =
        'translate(' + ox.toFixed(2) + 'px,' + oy.toFixed(2) + 'px)' +
        ' scale(' + cursorTrackScaleX.toFixed(4) + ',' + cursorTrackScaleY.toFixed(4) + ')';
      if (cursorMoving) {
        cursorEl.classList.add('mag-cursor-moving');
      } else {
        cursorEl.classList.remove('mag-cursor-moving');
        if (cursorWasMoving) restartCaretBlink();
      }
      cursorWasMoving = cursorMoving;

      if (reducedMotion) {
        lensEl.style.transform = 'translate(' + lensX.value.toFixed(1) + 'px,' + lensY.value.toFixed(1) + 'px)';
        return;
      }

      const p = clamp(lensPress.value, 0, 1);
      const pressScale = lerp(1, 1.055, p);
      // Signed velocity is important. Moving left squashes the body on X;
      // when the spring reverses, the positive velocity stretches it again.
      // The perpendicular response approximately preserves the droplet's
      // visual volume and keeps the shape soft instead of mechanically scaled.
      const strainX = clamp(lensX.velocity / 1700, -0.18, 0.18);
      const strainY = clamp(lensY.velocity / 1500, -0.16, 0.16);
      const scaleX = pressScale * clamp(1 + strainX - strainY * 0.28, 0.78, 1.24);
      const scaleY = pressScale * clamp(1 + strainY - strainX * 0.28, 0.80, 1.22);
      lensEl.style.transform =
        'translate(' + lensX.value.toFixed(2) + 'px,' + lensY.value.toFixed(2) + 'px)' +
        ' scale(' + scaleX.toFixed(4) + ',' + scaleY.toFixed(4) + ')';
    }
    cursorX.onChange = apply;
    cursorY.onChange = apply;
    lensX.onChange = apply;
    lensY.onChange = apply;
    lensPress.onChange = apply;
    apply();

    let dragging = false;
    let dragPoint = { x: 40, y: 200 };
    let dragVelocity = { x: 0, y: 0 };
    let lastPointerSample = null;
    let activeCaret = null;
    page.addEventListener('pointerdown', (ev) => {
      const pr = content.getBoundingClientRect();
      const point = { x: ev.clientX - pr.left, y: ev.clientY - pr.top };
      const insideCard = point.x >= cardLeft && point.x <= cardLeft + cardW &&
        point.y >= cardTop && point.y <= cardTop + cardH;
      if (!insideCard) {
        if (document.activeElement === editor) editor.blur();
        return;
      }
      dragging = true;
      dragVelocity = { x: 0, y: 0 };
      lastPointerSample = { x: ev.clientX, y: ev.clientY, time: ev.timeStamp || performance.now() };
      if (reducedMotion) lensPress.snapTo(1);
      else lensPress.animateTo(1);
      dragPoint = point;
      activeCaret = trackCursor(dragPoint.x, dragPoint.y, true, null);
      setEditorSelection(activeCaret, true);
      try { page.setPointerCapture(ev.pointerId); } catch (e) {}
      ev.preventDefault();
    });
    page.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const pr = content.getBoundingClientRect();
      const time = ev.timeStamp || performance.now();
      if (lastPointerSample) {
        const dt = clamp((time - lastPointerSample.time) / 1000, 1 / 240, 0.05);
        const rawVX = (ev.clientX - lastPointerSample.x) / dt;
        const rawVY = (ev.clientY - lastPointerSample.y) / dt;
        // Filtering pointer deltas avoids one coalesced browser event turning
        // into an implausibly violent release impulse.
        dragVelocity.x = lerp(dragVelocity.x, rawVX, 0.42);
        dragVelocity.y = lerp(dragVelocity.y, rawVY, 0.42);
      }
      lastPointerSample = { x: ev.clientX, y: ev.clientY, time };
      dragPoint = { x: ev.clientX - pr.left, y: ev.clientY - pr.top };
      activeCaret = trackCursor(
        dragPoint.x,
        dragPoint.y,
        false,
        activeCaret ? activeCaret.lineIndex : null
      );
      setEditorSelection(activeCaret, false);
    });
    const up = (ev) => {
      if (!dragging) return;
      dragging = false;
      if (reducedMotion) lensPress.snapTo(0);
      else lensPress.animateTo(0);

      if (!reducedMotion && ev.type !== 'pointercancel' && lastPointerSample) {
        const age = Math.max(0, (ev.timeStamp || performance.now()) - lastPointerSample.time);
        const freshness = clamp(1 - age / 140, 0, 1);
        if (freshness > 0) {
          // Hand a restrained amount of pointer momentum to the spring. It
          // carries the droplet past the release point; the existing target
          // then pulls it back and creates the requested rubber-band reversal.
          lensX.velocity = clamp(lensX.velocity * 0.65 + dragVelocity.x * 0.35 * freshness, -1350, 1350);
          lensY.velocity = clamp(lensY.velocity * 0.65 + dragVelocity.y * 0.35 * freshness, -1250, 1250);
        }
      }
      lastPointerSample = null;
      if (!activeCaret) activeCaret = nearestCaret(dragPoint.x, dragPoint.y, null);
      setEditorSelection(activeCaret, true);
      settleCursorAt(activeCaret);
      activeCaret = null;
    };
    page.addEventListener('pointerup', up);
    page.addEventListener('pointercancel', up);

    page.addEventListener('wheel', (ev) => {
      const pr = content.getBoundingClientRect();
      const x = ev.clientX - pr.left, y = ev.clientY - pr.top;
      if (x < cardLeft || x > cardLeft + cardW || y < cardTop || y > cardTop + cardH) return;
      const maxScroll = Math.max(0, textLines.length - visibleLineCount());
      if (maxScroll <= 0) return;
      const previous = scrollLine;
      scrollLine = clamp(scrollLine + Math.sign(ev.deltaY) * 3, 0, maxScroll);
      if (scrollLine !== previous) {
        renderCard();
        syncCaretFromEditor();
      }
      ev.preventDefault();
    }, { passive: false });

    const update = () => {
      const ox = cursorX.value, oy = cursorY.value;
      // Use the unscaled physics origin, not getBoundingClientRect(): the
      // latter includes squash/stretch and would make the sampled text swim.
      const relX = lensX.value, relY = lensY.value;
      const focusShiftX = ox + cursorW * 0.5 - relX - LENS_W * 0.5;
      const focusShiftY = oy + cursorH * 0.5 - relY - LENS_H * 0.5;
      const p = reducedMotion ? 0 : clamp(lensPress.value, 0, 1);
      const speed = reducedMotion ? 0 : clamp(Math.hypot(lensX.velocity, lensY.velocity) / 1800, 0, 1);
      lensGlass.render({
        refractionHeight: 8 + 3 * p + 3 * speed,
        refractionAmount: 24 + 6 * p + 5 * speed,
        depthEffect: true,
        chromaticAberration: true,
        innerShadow: { radius: 16 + 3 * p, offsetX: 0, offsetY: 0, color: [0, 0, 0, 0.3], alpha: 1 },
        highlight: { style: 'default', width: 0.6, blurRadius: 0.3, alpha: 0.55 + 0.4 * p, angle: 45, falloff: 1 },
        shadow: { radius: 18, offsetX: 0, offsetY: 5, color: [0, 0, 0, 0.12], alpha: 0.65 + 0.35 * p },
        surfaceColor: [1, 1, 1, 0.018 + 0.018 * p],
        contentZoom: 1.5,
        // The focus follows the caret even while the physical lens trails it.
        contentShift: [focusShiftX, focusShiftY],
        tracks: [
          { canvas: card, version: cardVersion, rect: [cardLeft - relX, cardTop - relY, cardW, cardH], scaleX: 1, scaleY: 1 },
          {
            canvas: cursor,
            version: 1,
            rect: [ox - relX, oy - relY, cursorW, cursorH],
            scaleX: cursorTrackScaleX,
            scaleY: cursorTrackScaleY
          }
        ]
      });
    };

    const onMagnifierResize = () => {
      updateCardGeometry();
      renderCard();
      const textIndex = editorCaretIndex();
      let caret = caretForTextIndex(textIndex);
      if (ensureCaretVisible(caret.lineIndex)) caret = caretForTextIndex(textIndex);
      cursorX.snapTo(caret.x);
      cursorY.snapTo(caret.y);
      cursorTrackScaleX = 1;
      cursorTrackScaleY = 1;
      moveLensToCaret(caret.x, caret.y, true);
    };
    window.addEventListener('resize', onMagnifierResize);
    updaters.add(update);
    ensureUpdaterLoop();
    content._dispose = () => {
      updaters.delete(update);
      window.removeEventListener('resize', onMagnifierResize);
      document.removeEventListener('selectionchange', onSelectionChange);
      cursorX.snapTo(cursorX.value); cursorY.snapTo(cursorY.value);
      lensX.snapTo(lensX.value); lensY.snapTo(lensY.value); lensPress.snapTo(lensPress.value);
      lensGlass.dispose();
    };
  }

  /* =================== Glass Playground =================== */
  function renderPlayground(content) {
    const state = { offsetX: 0, offsetY: 0, zoom: 1, rotation: 0 };
    const params = { corner: 0.5, blur: 0, refH: 0.2, refA: 0.2, chroma: 0 };
    let sheetExpanded = true;

    const main = document.createElement('div');
    main.className = 'pg-main';
    content.appendChild(main);
    const mainGlass = new GlassElement(backdropOf(), { radii: [128, 128, 128, 128], regionPad: 80 });
    main.appendChild(mainGlass.canvas);
    mainGlass.setSize(256, 256);
    function applyTransform() {
      main.style.transform = 'translate(' + state.offsetX.toFixed(1) + 'px,' + state.offsetY.toFixed(1) + 'px)' +
        ' rotate(' + state.rotation.toFixed(2) + 'deg) scale(' + state.zoom.toFixed(4) + ')';
    }
    attachTransformGestures(main, state, applyTransform);

    const sheet = document.createElement('div');
    sheet.className = 'pg-sheet';
    content.appendChild(sheet);
    const sheetGlass = new GlassElement(backdropOf(), { radii: [32, 32, 32, 32], shadowPad: 0 });
    sheet.insertBefore(sheetGlass.canvas, sheet.firstChild);
    const sheetInner = document.createElement('div');
    sheetInner.className = 'pg-sheet-inner';
    sheet.appendChild(sheetInner);

    const sheetLayer = document.createElement('canvas');
    let sheetVersion = 0;

    const sliders = [];
    function addSlider(label, min, max, val, set) {
      const row = document.createElement('div');
      row.className = 'pg-row';
      const lab = document.createElement('div');
      lab.className = 'pg-label';
      lab.textContent = label;
      const holder = document.createElement('div');
      row.appendChild(lab);
      row.appendChild(holder);
      sheetInner.appendChild(row);
      const get = () => val;
      const s = C.createLiquidSlider({
        backdrop: backdropOf(),
        value: get,
        onValueChange: (v) => { val = v; set(v); },
        valueRange: [min, max],
        visibilityThreshold: 0.001,
        layers: [{
          canvas: sheetLayer,
          version: () => sheetVersion,
          rect: () => {
            const sr = sheet.getBoundingClientRect();
            const th = holder.querySelector('.liquid-slider-thumb');
            if (!th) return [0, 0, 1, 1];
            const tr = th.getBoundingClientRect();
            return [sr.left - tr.left, sr.top - tr.top, sr.width, sr.height];
          }
        }]
      });
      holder.appendChild(s);
      sliders.push(s);
      return s;
    }

    addSlider('Corner radius', 0, 1, params.corner, (v) => { params.corner = v; });
    addSlider('Blur radius', 0, 32, params.blur, (v) => { params.blur = v; });
    addSlider('Refraction height', 0, 1, params.refH, (v) => { params.refH = v; });
    addSlider('Refraction amount', 0, 1, params.refA, (v) => { params.refA = v; });
    addSlider('Chromatic aberration', 0, 1, params.chroma, (v) => { params.chroma = v; });

    // buttons
    const btnRow = document.createElement('div');
    btnRow.className = 'pg-buttons';
    content.appendChild(btnRow);
    const mkBtn = (text, onClick) => {
      const b = C.createLiquidButton({
        backdrop: backdropOf(),
        tint: [0xff / 255, 0x8d / 255, 0x28 / 255, 0.8],
        onClick
      });
      const sp = document.createElement('span');
      sp.textContent = text;
      sp.style.cssText = 'color:#fff;font-size:15px;';
      b.querySelector('.liquid-content').appendChild(sp);
      btnRow.appendChild(b);
      return b;
    };
    let toggleBtn;
    toggleBtn = mkBtn('🔼', () => {
      sheetExpanded = !sheetExpanded;
      sheet.style.display = sheetExpanded ? '' : 'none';
      toggleBtn.querySelector('span').textContent = sheetExpanded ? '🔼' : '🔽';
    });
    mkBtn('Reset', () => {
      state.offsetX = 0; state.offsetY = 0; state.zoom = 1; state.rotation = 0;
      applyTransform();
      params.corner = 0.5; params.blur = 0; params.refH = 0.2; params.refA = 0.2; params.chroma = 0;
    });

    const update = () => {
      const w = main.clientWidth, h = main.clientHeight;
      if (w === 0) return;
      const r = Math.min(w, h) * 0.5 * params.corner;
      mainGlass.radii = [r, r, r, r];
      mainGlass.render({
        vibrancy: true,
        blurRadius: params.blur,
        refractionHeight: params.refH * Math.min(w, h) * 0.5,
        refractionAmount: params.refA * Math.min(w, h),
        depthEffect: true,
        chromaticAberration: params.chroma > 0,
        highlight: { style: 'plain', width: 0.5, blurRadius: 0.25, alpha: 1 }
      });

      if (sheetExpanded) {
        const sw = sheet.clientWidth, sh = sheet.clientHeight;
        if (sw > 0) {
          sheetGlass.setSize(sw, sh);
          sheetGlass.render({
            vibrancy: true,
            blurRadius: 4,
            refractionHeight: 16,
            refractionAmount: 32,
            highlight: { style: 'plain', width: 0.5, blurRadius: 0.25, alpha: 1 },
            surfaceColor: [1, 1, 1, 0.5]
          });
          const cw = sheetGlass.canvas.width, chh = sheetGlass.canvas.height;
          if (sheetLayer.width !== cw) sheetLayer.width = cw;
          if (sheetLayer.height !== chh) sheetLayer.height = chh;
          const lctx = sheetLayer.getContext('2d');
          lctx.clearRect(0, 0, cw, chh);
          lctx.drawImage(sheetGlass.canvas, 0, 0);
          sheetVersion++;
        }
      }
    };
    updaters.add(update);
    ensureUpdaterLoop();
    content._dispose = () => {
      updaters.delete(update);
      mainGlass.dispose();
      sheetGlass.dispose();
      sliders.forEach((s) => s.dispose());
      // The buttons are nested in layout wrappers. Dispose the component,
      // rather than the wrapper, so its WebGL context is released.
      btnRow.querySelectorAll('.liquid-btn').forEach((b) => b.dispose && b.dispose());
    };
  }

  /* =================== Adaptive Luminance Glass =================== */
  function renderLuminance(content) {
    const stage = document.createElement('div');
    stage.className = 'lum-stage';
    content.appendChild(stage);
    const glassEl = document.createElement('div');
    glassEl.className = 'lum-glass';
    stage.appendChild(glassEl);
    const glass = new GlassElement(backdropOf(), { radii: [24, 24, 24, 24], regionPad: 88 });
    glassEl.appendChild(glass.canvas);
    glass.setSize(160, 160);
    const label = document.createElement('div');
    label.className = 'lum-label';
    glassEl.appendChild(label);

    const state = { offsetX: 0, offsetY: 0, zoom: 1, rotation: 0 };
    attachTransformGestures(glassEl, state, function () {
      glassEl.style.transform = 'translate(' + state.offsetX.toFixed(1) + 'px,' + state.offsetY.toFixed(1) + 'px)' +
        ' rotate(' + state.rotation.toFixed(2) + 'deg) scale(' + state.zoom.toFixed(4) + ')';
    });

    let lum = 1, lumTarget = 1;
    let gray = 0;
    let measureT = 0;

    const mc = document.createElement('canvas');
    mc.width = 5; mc.height = 5;
    const mctx = mc.getContext('2d', { willReadFrequently: true });

    const update = () => {
      // measure backdrop luminance ~2x/s
      measureT += 16;
      if (measureT >= 500 && glass.canvas.width > 0) {
        measureT = 0;
        try {
          mctx.drawImage(glass.canvas, 0, 0, 5, 5);
          const d = mctx.getImageData(0, 0, 5, 5).data;
          let sum = 0;
          for (let i = 0; i < 25; i++) {
            sum += 0.2126 * d[i * 4] / 255 + 0.7152 * d[i * 4 + 1] / 255 + 0.0722 * d[i * 4 + 2] / 255;
          }
          lumTarget = sum / 25;
        } catch (e) {}
      }
      lum += (lumTarget - lum) * 0.03;
      gray += (((lum > 0.5) ? 1 : 0) - gray) * 0.03;

      const l = (lum * 2 - 1);
      const ls = Math.sign(l) * l * l;
      const bright = ls > 0 ? lerp(0.1, 0.5, ls) : lerp(0.1, -0.2, -ls);
      const contrast = ls > 0 ? lerp(1, 0, ls) : 1;
      const blurR = ls > 0 ? lerp(8, 16, ls) : lerp(8, 2, -ls);

      glass.render({
        colorControls: { brightness: bright, contrast: contrast, saturation: 1.5 },
        blurRadius: blurR,
        refractionHeight: 24,
        refractionAmount: 80,
        depthEffect: true,
        highlight: { style: 'plain', width: 0.5, blurRadius: 0.25, alpha: 1 }
      });
      const g = Math.round(gray * 255);
      label.style.color = 'rgb(' + g + ',' + g + ',' + g + ')';
      label.textContent = 'luminance:\n' + (Math.round(lum * 100) / 100);
    };
    updaters.add(update);
    ensureUpdaterLoop();
    content._dispose = () => { updaters.delete(update); glass.dispose(); };
  }

  /* =================== Progressive Blur =================== */
  function renderProgressiveBlur(content) {
    const wrap = document.createElement('div');
    wrap.className = 'pb-wrap';
    content.appendChild(wrap);
    const glass = new GlassElement(backdropOf(), { radii: [0, 0, 0, 0] });
    wrap.appendChild(glass.canvas);
    const label = document.createElement('div');
    label.className = 'pb-label';
    label.textContent = 'alpha-masked progressive blur';
    wrap.appendChild(label);

    const update = () => {
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (w === 0 || h === 0) return;
      glass.setSize(w, h);
      glass.render({
        blurRadius: 4,
        alphaMask: { tint: [1, 1, 1, 1], intensity: 0.8 }
      });
    };
    updaters.add(update);
    ensureUpdaterLoop();
    content._dispose = () => { updaters.delete(update); glass.dispose(); };
  }

  /* =================== Scroll containers =================== */
  function renderScroll(content) {
    const page = document.createElement('div');
    page.className = 'scroll-page';
    const inner = document.createElement('div');
    inner.className = 'scroll-inner';
    page.appendChild(inner);
    content.appendChild(page);
    const vg = createScrollGlassCards(inner, 20, backdropOf());
    content._dispose = () => vg.dispose();
  }

  function renderLazyScroll(content) {
    const page = document.createElement('div');
    page.className = 'scroll-page';
    const inner = document.createElement('div');
    inner.className = 'scroll-inner';
    page.appendChild(inner);
    content.appendChild(page);
    const vg = createScrollGlassCards(inner, 100, backdropOf());
    content._dispose = () => vg.dispose();
  }

  /* shared backdrop source (set by app.js) */
  let sharedBackdrop = null;
  function setSharedBackdrop(bd) { sharedBackdrop = bd; }
  function backdropOf() { return sharedBackdrop; }

  window.LiquidPages = {
    renderLockScreen,
    renderControlCenter,
    renderMagnifier,
    renderPlayground,
    renderLuminance,
    renderProgressiveBlur,
    renderScroll,
    renderLazyScroll,
    setSharedBackdrop
  };
})();
