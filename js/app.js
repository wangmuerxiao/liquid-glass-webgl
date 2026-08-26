/* App: catalog routes (MainContent.kt / HomeContent.kt port) */
(function () {
  'use strict';

  const { BackdropSource, GlassElement } = window.LiquidGlass;
  const C = window.LiquidComponents;
  const P = window.LiquidPages;

  /* Shared wallpaper backdrop (BackdropDemoScaffold). */
  const backdrop = new BackdropSource();
  P.setSharedBackdrop(backdrop);
  const WALLPAPER = 'assets/wallpaper_light.webp';
  const wallpaperImg = new Image();
  wallpaperImg.crossOrigin = 'anonymous';
  wallpaperImg.onload = () => backdrop.setImage(wallpaperImg);
  wallpaperImg.onerror = () => {
    console.warn('壁纸加载失败，使用纯色背景');
    backdrop.setSolid(0.85, 0.9, 0.92, 1);
  };
  wallpaperImg.src = WALLPAPER;
  if (wallpaperImg.complete && wallpaperImg.naturalWidth > 0) {
    backdrop.setImage(wallpaperImg);
  }

  // 检测 WebGL 是否可用，不可用则启用 CSS 降级
  try {
    const testCanvas = document.createElement('canvas');
    const testGl = testCanvas.getContext('webgl');
    if (!testGl) document.documentElement.classList.add('no-webgl');
  } catch (e) {
    document.documentElement.classList.add('no-webgl');
  }

  // file:// 协议下 WebGL 贴图会被污染，提示用户用 HTTP 服务打开
  if (location.protocol === 'file:') {
    const warn = document.createElement('div');
    warn.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#ff3b30;color:#fff;font-size:13px;text-align:center;padding:8px 12px;';
    warn.textContent = '检测到通过 file:// 直接打开，玻璃效果可能无法显示。请双击“启动服务.bat”或用 npx serve . 启动后访问 http://localhost:8080';
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(warn));
    setTimeout(() => warn.remove(), 8000);
  }

  function makeSolidBackdrop(r, g, b, a) {
    const bd = new BackdropSource();
    bd.setSolid(r, g, b, a);
    return bd;
  }

  let pageDisposers = [];

  function disposePage() {
    for (const d of pageDisposers) { try { d(); } catch (e) {} }
    pageDisposers = [];
  }

  /* ---- scaffold: wallpaper + content + pick button ---- */
  function scaffold(contentBuilder) {
    const root = document.getElementById('app');
    root.innerHTML = '';

    const sc = document.createElement('div');
    sc.className = 'scaffold';

    const img = document.createElement('img');
    img.className = 'wallpaper';
    img.src = WALLPAPER;
    img.draggable = false;
    sc.appendChild(img);

    const content = document.createElement('div');
    content.className = 'page-content';
    sc.appendChild(content);

    // "选择图片" 液态按钮（tint #0088FF）
    const wrap = document.createElement('div');
    wrap.className = 'pick-btn-wrap';
    const label = document.createElement('span');
    label.textContent = '选择图片';
    label.style.cssText = 'color:#fff;font-size:16px;padding:0 8px;';
    const pickBtn = C.createLiquidButton({
      backdrop,
      tint: [0, 0x88 / 255, 1, 0.8],
      content: label
    });
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    pickBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const im = new Image();
        im.onload = () => {
          backdrop.setImage(im);
          img.src = reader.result;
        };
        im.src = reader.result;
      };
      reader.readAsDataURL(f);
    });
    wrap.appendChild(pickBtn);
    sc.appendChild(wrap);
    sc.appendChild(fileInput);

    contentBuilder(content);
    root.appendChild(sc);
    pageDisposers.push(() => {
      try { pickBtn.dispose(); } catch (e) {}
      if (content._dispose) content._dispose();
    });
  }
/*__A2__*/
/* ---- Home (HomeContent.kt) ---- */
const HOME_ICONS = {
  buttons: 'M3 7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7zm5 11a1 1 0 0 1 1-1h6a1 1 0 0 1 0 2H9a1 1 0 0 1-1-1z',
  toggle: 'M7 6h10a6 6 0 0 1 0 12H7A6 6 0 0 1 7 6zm10 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  slider: 'M3 11h18a1 1 0 0 1 0 2H3a1 1 0 0 1 0-2zm14-4a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
  bottomtabs: 'M2 5a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5zm9 2v10h2V7h-2z',
  dialog: 'M4 4h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  lockscreen: 'M12 2a5 5 0 0 0-5 5v2H6a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3h-1V7a5 5 0 0 0-5-5zm-3 7V7a3 3 0 0 1 6 0v2H9z',
  controlcenter: 'M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z',
  magnifier: 'M10 3a7 7 0 1 1-4.2 12.6l-3.1 3.1a1 1 0 0 1-1.4-1.4l3.1-3.1A7 7 0 0 1 10 3zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  playground: 'M12 1l2.6 6.4L21 10l-6.4 2.6L12 19l-2.6-6.4L3 10l6.4-2.6z',
  luminance: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 1a1 1 0 0 1 1 1v1a1 1 0 0 1-2 0V2a1 1 0 0 1 1-1zm0 19a1 1 0 0 1 1 1v1a1 1 0 0 1-2 0v-1a1 1 0 0 1 1-1zM4.2 4.2a1 1 0 0 1 1.4 0l.7.7a1 1 0 1 1-1.4 1.4l-.7-.7a1 1 0 0 1 0-1.4zm12.5 12.5a1 1 0 0 1 1.4 0l.7.7a1 1 0 0 1-1.4 1.4l-.7-.7a1 1 0 0 1 0-1.4zM1 12a1 1 0 0 1 1-1h1a1 1 0 0 1 0 2H2a1 1 0 0 1-1-1zm19 0a1 1 0 0 1 1-1h1a1 1 0 0 1 0 2h-1a1 1 0 0 1-1-1zM4.2 19.8a1 1 0 0 1 0-1.4l.7-.7a1 1 0 1 1 1.4 1.4l-.7.7a1 1 0 0 1-1.4 0zm12.5-12.5a1 1 0 0 1 0-1.4l.7-.7a1 1 0 1 1 1.4 1.4l-.7.7a1 1 0 0 1-1.4 0z',
  progressiveblur: 'M3 4h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm0 6h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1zm0 6h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z',
  scroll: 'M12 3a1 1 0 0 1 1 1v10.6l3.3-3.3a1 1 0 0 1 1.4 1.4l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.4L11 15.6V4a1 1 0 0 1 1-1z',
  lazyscroll: 'M4 5h16a1 1 0 0 1 0 2H4a1 1 0 0 1 0-2zm0 5h16a1 1 0 0 1 0 2H4a1 1 0 0 1 0-2zm0 5h10a1 1 0 0 1 0 2H4a1 1 0 0 1 0-2z'
};
function homeIcon(route) {
  const d = HOME_ICONS[route] || HOME_ICONS.buttons;
  return '<svg viewBox="0 0 24 24" fill="currentColor" style="display:block;width:18px;height:18px"><path d="' + d + '"/></svg>';
}
const CHEVRON_SVG = '<svg viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;width:7px;height:12px"><path d="M1 1l6 6-6 6"/></svg>';

const HERO_PARAMS = {
  vibrancy: true, blurRadius: 7, refractionHeight: 16, refractionAmount: 28,
  surfaceColor: [1, 1, 1, 0.1],
  highlight: { style: 'default', width: 0.5, blurRadius: 0.25, alpha: 1, angle: 45, falloff: 1 },
  shadow: { radius: 14, offsetX: 0, offsetY: 6, color: [0, 0, 0, 0.14], alpha: 1 }
};
const SECTION_PARAMS = {
  vibrancy: true, blurRadius: 6, refractionHeight: 14, refractionAmount: 24,
  surfaceColor: [1, 1, 1, 0.1],
  highlight: { style: 'default', width: 0.5, blurRadius: 0.25, alpha: 1, angle: 45, falloff: 1 },
  shadow: { radius: 12, offsetX: 0, offsetY: 4, color: [0, 0, 0, 0.12], alpha: 1 }
};

function renderHome(content) {
  const page = document.createElement('div');
  page.className = 'home-page';

  const sections = [
    ['液态玻璃组件', [
      ['按钮', 'buttons'],
      ['开关', 'toggle'],
      ['滑块', 'slider'],
      ['底部标签栏', 'bottomtabs'],
      ['对话框', 'dialog']
    ]],
    ['系统界面', [
      ['锁屏（SDF 纹理）', 'lockscreen'],
      ['控制中心', 'controlcenter'],
      ['放大镜', 'magnifier']
    ]],
    ['实验性效果', [
      ['玻璃游乐场', 'playground'],
      ['自适应亮度玻璃', 'luminance'],
      ['渐进式模糊', 'progressiveblur'],
      ['滚动容器', 'scroll'],
      ['懒加载滚动容器', 'lazyscroll']
    ]]
  ];

  const total = sections.reduce((n, s) => n + s[1].length, 0);

  const hero = document.createElement('div');
  hero.className = 'home-hero';
  const heroInner = document.createElement('div');
  heroInner.className = 'home-hero-inner';
  const hTitle = document.createElement('div');
  hTitle.className = 'home-hero-title';
  hTitle.textContent = '液态玻璃组件库';
  const hSub = document.createElement('div');
  hSub.className = 'home-hero-subtitle';
  hSub.textContent = 'Web 复刻 · 实时折射 · 原生动效';
  const hMeta = document.createElement('div');
  hMeta.className = 'home-hero-meta';
  hMeta.textContent = total + ' 个组件示例';
  heroInner.appendChild(hTitle);
  heroInner.appendChild(hSub);
  heroInner.appendChild(hMeta);
  hero.appendChild(heroInner);
  page.appendChild(hero);

  const sectionEls = [];
  for (const [name, items] of sections) {
    const sec = document.createElement('div');
    sec.className = 'home-section';
    const inner = document.createElement('div');
    inner.className = 'home-section-inner';
    const label = document.createElement('div');
    label.className = 'home-section-label';
    label.textContent = name;
    inner.appendChild(label);
    for (const [labelText, route] of items) {
      const row = document.createElement('div');
      row.className = 'home-row';
      const icon = document.createElement('div');
      icon.className = 'home-row-icon';
      icon.innerHTML = homeIcon(route);
      const lab = document.createElement('div');
      lab.className = 'home-row-label';
      lab.textContent = labelText;
      const chev = document.createElement('div');
      chev.className = 'home-row-chevron';
      chev.innerHTML = CHEVRON_SVG;
      row.appendChild(icon);
      row.appendChild(lab);
      row.appendChild(chev);
      row.addEventListener('click', () => { location.hash = '#/' + route; });
      inner.appendChild(row);
    }
    sec.appendChild(inner);
    page.appendChild(sec);
    sectionEls.push(sec);
  }
  content.appendChild(page);

  /* Attach real liquid-glass surfaces after DOM insertion so clientWidth is
   * available. Kept to 4 live contexts (hero + 3 sections) to stay well
   * under the browser's WebGL context budget; the global render loop keeps
   * them re-sampling the live wallpaper on scroll/resize. */
  const glasses = [];
  let disposed = false;
  function attach(host, radii, params, shadowPad) {
    const g = new GlassElement(backdrop, { radii: radii, shadowPad: shadowPad });
    host.appendChild(g.canvas);
    g.setSize(host.clientWidth, host.clientHeight);
    g.render(params);
    glasses.push({ g: g, host: host, params: params });
  }
  function buildGlass() {
    if (disposed) return;
    attach(hero, [32, 32, 32, 32], HERO_PARAMS, 20);
    for (const sec of sectionEls) attach(sec, [28, 28, 28, 28], SECTION_PARAMS, 16);
  }
  function onResize() {
    if (disposed) return;
    for (const e of glasses) {
      e.g.setSize(e.host.clientWidth, e.host.clientHeight);
      e.g.render(e.params);
    }
  }
  requestAnimationFrame(buildGlass);
  window.addEventListener('resize', onResize);

  content._dispose = () => {
    disposed = true;
    window.removeEventListener('resize', onResize);
    for (const e of glasses) { try { e.g.dispose(); } catch (err) {} }
  };
}

function textButtonLabel(text, color, size, padH) {
  const s = document.createElement('span');
  s.textContent = text;
  s.style.cssText = `color:${color};font-size:${size}px;` + (padH ? `padding:0 ${padH}px;` : '');
  return s;
}
/*__A3__*/
/* ---- Buttons (ButtonsContent.kt) ---- */
function renderButtons(content) {
  const col = document.createElement('div');
  col.className = 'demo-column';

  const mk = (opts, label, color) => {
    const b = C.createLiquidButton(Object.assign({ backdrop }, opts));
    b.querySelector('.liquid-content').appendChild(textButtonLabel(label, color, 15));
    return b;
  };
  col.appendChild(mk({}, '透明液态按钮', '#000'));
  col.appendChild(mk({ surfaceColor: [1, 1, 1, 0.3] }, '半透液态按钮', '#000'));
  col.appendChild(mk({ tint: [0, 0x88 / 255, 1, 0.8] }, '蓝色液态按钮', '#fff'));
  const orange = [0xff / 255, 0x8d / 255, 0x28 / 255, 0.8];
  col.appendChild(mk({ tint: orange }, '橙色液态按钮', '#fff'));

  content.appendChild(col);
}

/* ---- Toggle (ToggleContent.kt) ---- */
function renderToggle(content) {
  const col = document.createElement('div');
  col.className = 'demo-column';
  let selected = false;
  let t1, t2;
  const setSelected = (value) => {
    selected = value;
    // The catalogue presents two views of one Compose state. Update both
    // immediately; their own springs retain the native transition.
    if (t1) t1._setSelected(value);
    if (t2) t2._setSelected(value);
  };

  t1 = C.createLiquidToggle({
    backdrop,
    selected: () => selected,
    onSelect: setSelected
  });
  const w1 = document.createElement('div');
  w1.style.cssText = 'width:100%;display:flex;justify-content:center;';
  w1.appendChild(t1);
  col.appendChild(w1);

  const box = document.createElement('div');
  box.className = 'demo-box';
  t2 = C.createLiquidToggle({
    backdrop: makeSolidBackdrop(1, 1, 1, 1),
    selected: () => selected,
    onSelect: setSelected
  });
  const w2 = document.createElement('div');
  w2.style.cssText = 'width:100%;display:flex;justify-content:center;';
  w2.appendChild(t2);
  box.appendChild(w2);
  col.appendChild(box);

  content._dispose = () => { t1.dispose(); t2.dispose(); };
  content.appendChild(col);
}
/*__A4__*/
/* ---- Slider (SliderContent.kt) ---- */
function renderSlider(content) {
  const col = document.createElement('div');
  col.className = 'demo-column';
  let value = 50;

  const mkSlider = (bd) => C.createLiquidSlider({
    backdrop: bd,
    value: () => value,
    onValueChange: (v) => { value = v; },
    valueRange: [0, 100],
    visibilityThreshold: 0.01
  });

  const w1 = document.createElement('div');
  w1.style.cssText = 'width:calc(100% - 64px);display:flex;';
  w1.appendChild(mkSlider(backdrop));
  col.appendChild(w1);

  const box = document.createElement('div');
  box.className = 'demo-box';
  const w2 = document.createElement('div');
  w2.style.cssText = 'width:100%;display:flex;';
  w2.appendChild(mkSlider(makeSolidBackdrop(1, 1, 1, 1)));
  box.appendChild(w2);
  col.appendChild(box);

  content._dispose = () => {
    col.querySelectorAll('.liquid-slider').forEach((s) => s.dispose());
  };
  content.appendChild(col);
}

/* ---- BottomTabs (BottomTabsContent.kt) ---- */
function renderBottomTabs(content) {
  const wrap = document.createElement('div');
  wrap.className = 'demo-tabs-wrap';

  const disposers = [];
  for (const count of [3, 4]) {
    let selectedIndex = 0;
    const tabs = C.createLiquidBottomTabs({
      backdrop,
      tabsCount: count,
      selectedTabIndex: () => selectedIndex,
      onTabSelected: (index) => { selectedIndex = index; }
    });
    disposers.push(tabs);
    wrap.appendChild(tabs);
  }

  content._dispose = () => disposers.forEach((t) => t.dispose());
  content.appendChild(wrap);
}

/* ---- Dialog (DialogContent.kt) ---- */
function renderDialog(content) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;inset:0;background:rgba(41,41,58,0.23);display:flex;align-items:center;justify-content:center;padding:40px;';

  const cardWrap = document.createElement('div');
  cardWrap.style.cssText = 'position:relative;width:100%;max-width:340px;border-radius:48px;overflow:hidden;';

  const cardGlass = new LiquidGlass.GlassElement(backdrop, { radii: [48, 48, 48, 48], shadowPad: 24, regionPad: 56 });
  cardWrap.appendChild(cardGlass.canvas);

  // 卡片玻璃记录为图层，供对话框内液态按钮折射
  const cardLayer = document.createElement('canvas');
  let cardLayerVersion = 0;

  requestAnimationFrame(() => {
    const r = cardWrap.getBoundingClientRect();
    cardGlass.setSize(r.width, r.height);
    cardGlass.render({
      blurRadius: 8,
      refractionHeight: 24,
      refractionAmount: 48,
      depthEffect: true,
      highlight: { style: 'plain', width: 0.5, blurRadius: 0.25, alpha: 0.6 },
      surfaceColor: [0.98, 0.98, 0.98, 0.35]
    });
    cardLayer.width = cardGlass.canvas.width;
    cardLayer.height = cardGlass.canvas.height;
    cardLayer.getContext('2d').drawImage(cardGlass.canvas, 0, 0);
    cardLayerVersion++;
  });

  const cardContent = document.createElement('div');
  cardContent.style.cssText = 'position:relative;z-index:2;padding:24px 28px;';
  cardContent.innerHTML = `
    <div style="font-size:24px;font-weight:500;color:#000;padding-bottom:12px;">对话框标题</div>
    <div style="font-size:15px;color:rgba(0,0,0,0.68);line-height:1.5;padding-bottom:16px;">
      液态玻璃通过实时模糊、折射和色散模拟真实玻璃的光学效果。拖拽滑块或点击开关可感受按压时的形变与高光变化。
    </div>
  `;
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:16px;padding-top:12px;';
  const dialogButtons = [];
  const mkDlgBtn = (label, color, opts) => {
    const holder = document.createElement('div');
    holder.style.cssText = 'flex:1;';
    const b = C.createLiquidButton(Object.assign({ backdrop, layers: [{
      canvas: cardLayer,
      version: () => cardLayerVersion,
      rect: () => {
        const cr = cardWrap.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const S = 24;
        return [cr.left - br.left - S, cr.top - br.top - S, cr.width + S * 2, cr.height + S * 2];
      }
    }] }, opts));
    b.style.width = '100%';
    const sp = document.createElement('span');
    sp.textContent = label;
    sp.style.cssText = 'color:' + color + ';font-size:16px;';
    b.querySelector('.liquid-content').appendChild(sp);
    b.addEventListener('click', () => history.back());
    holder.appendChild(b);
    btnRow.appendChild(holder);
    dialogButtons.push(b);
  };
  mkDlgBtn('取消', '#000', { surfaceColor: [0.98, 0.98, 0.98, 0.2] });
  mkDlgBtn('确定', '#fff', { tint: [0, 0x88 / 255, 1, 0.8] });
  cardContent.appendChild(btnRow);
  cardWrap.appendChild(cardContent);
  overlay.appendChild(cardWrap);
  content.appendChild(overlay);
  content._dispose = () => {
    cardGlass.dispose();
    dialogButtons.forEach((button) => button.dispose());
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) history.back(); });
}

/* ---- fallback page (unported destinations) ---- */
function renderPlaceholder(content) {
  const hint = document.createElement('div');
  hint.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(0,0,0,0.5);font-size:15px;text-align:center;padding:24px;';
  hint.textContent = '此页面为占位演示，完整效果请查看「按钮 / 开关 / 滑块 / 底部标签栏 / 对话框」';
  content.appendChild(hint);
}
/*__A5__*/
const routes = {
  home: renderHome,
  buttons: renderButtons,
  toggle: renderToggle,
  slider: renderSlider,
  bottomtabs: renderBottomTabs,
  dialog: renderDialog,
  lockscreen: P.renderLockScreen,
  controlcenter: P.renderControlCenter,
  magnifier: P.renderMagnifier,
  playground: P.renderPlayground,
  luminance: P.renderLuminance,
  progressiveblur: P.renderProgressiveBlur,
  scroll: P.renderScroll,
  lazyscroll: P.renderLazyScroll
};

function currentRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  return routes[h] ? h : (h === '' ? 'home' : 'other');
}

function render() {
  disposePage();
  const route = currentRoute();
  if (route === 'home') {
    scaffold(renderHome);
    return;
  }
  const builder = route === 'other' ? renderPlaceholder : routes[route];
  scaffold(builder);
}

window.addEventListener('hashchange', render);
if (!location.hash) location.hash = '#/home';
render();
})();
