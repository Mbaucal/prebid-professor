// Bundled as a complete browser program, then embedded as data in the Worker.
export function testPageClient() {
  'use strict';
  const model = JSON.parse(document.querySelector('[data-test-model]').textContent);
  const one = selector => document.querySelector(selector);
  const action = name => one('[data-action="' + name + '"]');
  const requests = Object.create(null), replies = Object.create(null), errors = [], rows = new Map();
  const assets = {ads:'not started', gpt:'not started', prebid:model.prebidVersion ? 'not started' : 'disabled'};
  const ids = new Set(model.units.map(u => u.id));
  let started = false, scanning = false, scanToken = 0, readyAt = 0;
  let consoleSnapshot = null;
  const stickyViews = new Map();
  function record(message) {
    message = String(message).slice(0,600);
    if (errors.length < 30 && !errors.includes(message)) errors.push(message);
    one('[data-errors]').textContent = errors.join('\n') || 'No errors recorded.';
  }
  window.addEventListener('error', e => { if (e.message) record(e.message); });
  window.addEventListener('unhandledrejection', e => record(e.reason?.message || e.reason));
  function sizesFor(unit) {
    const rules = model.maps[unit.sizeMapName];
    if (!Array.isArray(rules)) return unit.sizes;
    const match = rules.slice().sort((a,b) => b.viewport[0] - a.viewport[0] || b.viewport[1] - a.viewport[1])
      .find(row => innerWidth >= row.viewport[0] && innerHeight >= row.viewport[1]);
    return match?.sizes || [];
  }
  function collect() {
    const dom = new Map(), slots = new Map();
    document.querySelectorAll('[id]').forEach(node => { if (ids.has(node.id)) dom.set(node.id,[...(dom.get(node.id) || []),node]); });
    if (window.googletag?.apiReady) {
      try { googletag.pubads().getSlots().forEach(slot => { const id = slot.getSlotElementId(); slots.set(id,[...(slots.get(id) || []),slot]); }); }
      catch (e) { record(e.message); }
    }
    return {
      testedAt:new Date().toISOString(), siteId:model.siteId, releaseId:model.releaseId, runtimeVersion:model.runtimeVersion,
      prebidVersion:model.prebidVersion, assets:{...assets}, viewport:{width:innerWidth,height:innerHeight}, gptReady:!!window.googletag?.apiReady,
      consoleSnapshot, cssPreviews:[...stickyViews].filter(([,view]) => view.preview).map(([id]) => id),
      units:model.units.map(unit => {
        const nodes = dom.get(unit.id) || [], found = slots.get(unit.id) || [], path = found[0]?.getAdUnitPath() || null;
        const node = nodes[0], rect = node?.getBoundingClientRect(), style = node && getComputedStyle(node), sizes = sizesFor(unit);
        return {id:unit.id, type:unit.type, sticky:unit.sticky, lazy:unit.lazy, domCount:nodes.length, wrapper:!!node?.classList.contains('wrapperAd'),
          slotCount:found.length, path, pathOk:path === model.adUnitPath + unit.id, active:sizes.length > 0, sizes,
          requests:requests[unit.id] || 0, response:replies[unit.id] || null, width:Math.round(rect?.width || 0),height:Math.round(rect?.height || 0),
          visible:!!(rect?.width && rect?.height && style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0),
          ...(unit.sticky ? {layout:style ? {position:style.position,top:style.top,bottom:style.bottom,display:style.display,visibility:style.visibility,opacity:style.opacity,
            transform:style.transform,zIndex:style.zIndex,loaded:node.classList.contains('ad-loaded'),
            rect:{top:Math.round(rect.top),bottom:Math.round(rect.bottom),left:Math.round(rect.left),right:Math.round(rect.right)},
            viewportBottomGap:Math.round(innerHeight - rect.bottom)} : null} : {})};
      }),
      additionalSlots:[...slots].filter(([id]) => !ids.has(id)).map(([id, values]) => ({id,path:values[0].getAdUnitPath(),requests:requests[id] || 0,response:replies[id] || null})), errors:errors.slice(),
    };
  }
  function badge(cell, text, color) { const tag = document.createElement('span'); tag.className = 'pill ' + color; tag.textContent = text; cell.replaceChildren(tag); }
  const cards = new Map([...document.querySelectorAll('[data-slot-card]')].map(node => [node.dataset.slotCard,node]));
  const labels = new Map([...document.querySelectorAll('[data-slot-state]')].map(node => [node.dataset.slotState,node]));
  model.units.forEach(unit => {
    const row = document.createElement('tr'); for (let n = 0; n < 6; n++) row.appendChild(document.createElement('td'));
    const jump = document.createElement('button'); jump.textContent = unit.id; jump.addEventListener('click',() => cards.get(unit.id).scrollIntoView({block:'start',behavior:'smooth'}));
    row.children[0].append(jump,document.createElement('br'),document.createTextNode(unit.type + (unit.sticky ? ' · Sticky' : unit.lazy.enabled ? ' · lazy' : ' · immediate')));
    row.children[3].className = 'sizes'; one('[data-rows]').appendChild(row); rows.set(unit.id,row);
  });
  function closePreview(view) { view.preview?.remove(); view.preview = null; }
  function previewSize(unit) { return unit.sizes.find(size => Array.isArray(size) && size[0] <= innerWidth && size[1] <= innerHeight); }
  function openConsole(id) {
    for (const view of stickyViews.values()) closePreview(view);
    const state = collect();
    consoleSnapshot = {capturedAt:state.testedAt,viewport:state.viewport,units:state.units.filter(unit => unit.sticky)};
    try { if (id) googletag.openConsole(id); else googletag.openConsole(); }
    catch(e) { record('Publisher Console: ' + e.message); }
    render();
  }
  function describeSticky(unit) {
    if (!unit?.layout) return 'Container missing';
    const l = unit.layout;
    return (unit.visible ? 'Visible' : 'Hidden') + ' · ' + (unit.response || 'Waiting for response') + '\n' +
      'position: ' + l.position + '; top: ' + l.top + '; bottom: ' + l.bottom + '; display: ' + l.display +
      '; visibility: ' + l.visibility + '; opacity: ' + l.opacity + '; z-index: ' + l.zIndex +
      '\nBox: ' + unit.width + ' × ' + unit.height + ' px; viewport top: ' + l.rect.top + ' px; bottom gap: ' + l.viewportBottomGap + ' px; ad-loaded: ' + l.loaded;
  }
  for (const unit of model.units.filter(unit => unit.sticky)) {
    const section = document.createElement('div'); section.className = 'sticky-state'; section.dataset.stickyState = unit.id;
    const title = document.createElement('strong'); title.textContent = unit.id;
    const live = document.createElement('pre'); live.dataset.stickyLive = unit.id;
    const before = document.createElement('pre'); before.dataset.stickyBefore = unit.id;
    const controls = document.createElement('div'); controls.className = 'actions';
    const previewButton = document.createElement('button'); previewButton.textContent = 'Show Sticky CSS preview'; previewButton.setAttribute('aria-pressed','false');
    const consoleButton = document.createElement('button'); consoleButton.textContent = 'Inspect ' + unit.id + ' in GAM';
    const note = document.createElement('p'); note.className = 'muted';
    const view = {live,before,previewButton,consoleButton,note,preview:null}; stickyViews.set(unit.id,view);
    previewButton.addEventListener('click',() => {
      if (view.preview) { closePreview(view); render(); return; }
      const current = collect().units.find(row => row.id === unit.id), size = previewSize(current);
      if (!model.assets.stickyCss || !size || current.visible) return;
      // The original archived selectors apply inside a separate shadow tree.
      // GPT and document ID queries only see the untouched real ad container.
      const host = document.createElement('div'); host.dataset.stickyCssPreview = unit.id;
      const root = host.attachShadow({mode:'open'}), css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = 'data:text/css;base64,' + model.assets.stickyCss;
      css.onload = render;
      css.onerror = () => { closePreview(view); record('Saved Sticky CSS could not load.'); render(); };
      const box = document.createElement('div'); box.id = unit.id; box.className = 'ad-loaded';
      box.style.minHeight = size[1] + 'px'; box.style.paddingBottom = '5px';
      const label = document.createElement('div'); label.dataset.previewLabel = '';
      label.style.cssText = 'box-sizing:border-box;display:grid;place-items:center;border:2px dashed #08795f;background:#e8f5ef;color:#163e3d;text-align:center;font:12px/1.3 system-ui;';
      label.style.width = size[0] + 'px'; label.style.height = size[1] + 'px';
      label.textContent = unit.id + ' · CSS preview · ' + size.join('×') + ' · No ad';
      const close = document.createElement('button'); close.id = 'close_sticky_ad'; close.textContent = '×'; close.setAttribute('aria-label','Close Sticky CSS preview');
      close.addEventListener('click',() => { closePreview(view); render(); });
      box.append(label,close); root.append(css,box); document.body.appendChild(host); view.preview = host; render();
    });
    consoleButton.addEventListener('click',() => openConsole(unit.id));
    controls.append(previewButton,consoleButton); section.append(title,live,before,controls,note); one('[data-sticky-inspection]').appendChild(section);
  }
  function render() {
    const s = collect(), dom = s.units.filter(u => u.domCount === 1 && u.wrapper).length;
    const gpt = s.units.filter(u => u.slotCount === 1 && u.pathOk).length, active = s.units.filter(u => u.active);
    for (const [key,value] of Object.entries({dom:dom + ' / ' + s.units.length,gpt:gpt + ' / ' + s.units.length,active:active.length + ' / ' + s.units.length,requests:active.filter(u => u.requests).length + ' / ' + active.length})) one('[data-metric="' + key + '"]').textContent = value;
    for (const [key,value] of Object.entries(assets)) { const tag = one('[data-asset="' + key + '"]'); if(tag) { tag.textContent = key + ': ' + value; tag.className = 'pill ' + (value === 'ready' ? 'ok' : value === 'failed' ? 'bad' : 'wait'); } }
    one('[data-viewport]').textContent = innerWidth + ' × ' + innerHeight + ' px';
    action('console').disabled = !s.gptReady; action('scan').disabled = !s.gptReady || scanning;
    for (const unit of s.units) {
      const cells = rows.get(unit.id).children;
      badge(cells[1],unit.domCount === 1 && unit.wrapper ? 'Present' : unit.domCount > 1 ? 'Duplicate ID' : 'Missing / class',unit.domCount === 1 && unit.wrapper ? 'ok' : 'bad');
      badge(cells[2],unit.slotCount === 1 && unit.pathOk ? 'Registered' : unit.slotCount > 1 ? 'Duplicate slot' : unit.slotCount ? 'Wrong GAM path' : s.gptReady ? 'Waiting' : 'Waiting for GPT',unit.slotCount === 1 && unit.pathOk ? 'ok' : unit.slotCount ? 'bad' : 'wait');
      cells[2].title = unit.path || ''; cells[3].textContent = unit.active ? unit.sizes.map(size => Array.isArray(size) ? size.join('×') : size).join(', ') : 'Disabled at this width';
      cells[4].textContent = String(unit.requests); cells[5].textContent = unit.response || (unit.active ? 'Waiting' : 'Not required');
      labels.get(unit.id).textContent = (unit.active ? 'Active' : 'Disabled at this width') + ' · ' + unit.width + ' × ' + unit.height + ' px';
      const view = stickyViews.get(unit.id);
      if (view) {
        const size = previewSize(unit);
        if (unit.visible || !size) closePreview(view);
        view.live.textContent = 'Live state\n' + describeSticky(unit);
        view.before.textContent = consoleSnapshot ? 'Before console (' + consoleSnapshot.capturedAt + ')\n' + describeSticky(consoleSnapshot.units.find(row => row.id === unit.id)) : 'Before console: no snapshot yet. Use a console button on this page.';
        view.previewButton.disabled = !model.assets.stickyCss || !size || unit.visible;
        view.previewButton.textContent = view.preview ? 'Hide Sticky CSS preview' : 'Show Sticky CSS preview';
        view.previewButton.setAttribute('aria-pressed',String(!!view.preview)); view.consoleButton.disabled = !s.gptReady;
        view.note.textContent = !model.assets.stickyCss ? 'This older package has no separate sticky.css for preview.' : unit.visible ? 'The real Sticky is visible. CSS preview is off.' : !size ? 'No fixed preview size fits this viewport.' : view.preview ? 'CSS preview is visible. The real slot and its GAM response are unchanged.' : 'CSS preview uses a saved size at this width and the original sticky.css.';
      }
    }
    // Keep test controls clear of the actual fixed ad and its close button.
    // Only the test toolbar moves; saved Sticky placement stays untouched.
    let controlsBottom = 12;
    const reserve = rect => { if (rect && rect.bottom >= innerHeight - 1 && rect.top > 0) controlsBottom = Math.max(controlsBottom,innerHeight - rect.top + 20); };
    for (const unit of s.units) if (unit.sticky && unit.visible && unit.layout?.position === 'fixed') reserve(unit.layout.rect);
    for (const [id,view] of stickyViews) if (view.preview) reserve(view.preview.shadowRoot.getElementById(id)?.getBoundingClientRect());
    one('.float').style.bottom = controlsBottom + 'px';
    const extras = one('[data-extras]'); extras.textContent = s.additionalSlots.length ? 'Runtime-created / additional GPT slots: ' + s.additionalSlots.map(slot => slot.id + ' · ' + slot.path + ' · requests: ' + slot.requests).join('; ') : '';
    one('[data-summary]').textContent = Object.values(assets).includes('failed') ? 'A required script failed to load. Check the errors and your ad blocker, then restart.'
      : !started ? 'Ready. Click Start test to load this saved package.' : !s.gptReady ? 'Loading the saved scripts and Google GPT…'
      : dom === s.units.length && gpt === s.units.length ? 'All ' + gpt + ' positions are present and registered. ' + active.length + ' active at this width. Empty ads are OK.'
      : 'Registered ' + gpt + ' / ' + s.units.length + ' positions. ' + (Date.now() - readyAt > 12000 ? 'Check waiting rows and recorded errors.' : 'Waiting for initialization…');
  }
  window.googletag = window.googletag || {cmd:[]};
  googletag.cmd.push(() => {
    assets.gpt = 'ready'; readyAt = Date.now();
    googletag.pubads().addEventListener('slotRequested',event => { const id = event.slot.getSlotElementId(); requests[id] = (requests[id] || 0) + 1; replies[id] = 'Waiting for response'; render(); });
    googletag.pubads().addEventListener('slotRenderEnded',event => { replies[event.slot.getSlotElementId()] = event.isEmpty ? 'Empty — OK for this test' : 'Ad ' + (Array.isArray(event.size) ? event.size.join('×') : 'rendered'); render(); });
    render();
  });
  function script(src, name, cors = false) {
    assets[name] = 'loading'; render();
    return new Promise((resolve,reject) => {
      const tag = document.createElement('script'); tag.async = true; if(cors) tag.crossOrigin = 'anonymous'; tag.src = src;
      const timer = setTimeout(() => { assets[name] = 'failed'; record(name + ' did not load within 20 seconds. Restart to try again.'); render(); reject(new Error(name + ' timeout')); },20000);
      tag.onload = () => { clearTimeout(timer); if(assets[name] === 'failed') return; if(name !== 'gpt') assets[name] = 'ready'; render(); resolve(); };
      tag.onerror = () => { clearTimeout(timer); assets[name] = 'failed'; record(name + ' could not load. Check network / ad blocker.'); render(); reject(new Error(name + ' failed')); };
      document.head.appendChild(tag);
    });
  }
  action('start').addEventListener('click',async () => {
    if(started) return; started = true; action('start').disabled = true; action('start').textContent = 'Test started';
    try {
      if(model.assets.prebid) await script('data:application/javascript;base64,' + model.assets.prebid,'prebid');
      await script('data:application/javascript;base64,' + model.assets.ads,'ads');
      await script('https://securepubads.g.doubleclick.net/tag/js/gpt.js','gpt',true);
    } catch (e) { record(e.message); }
    render();
  });
  action('console').addEventListener('click',() => openConsole());
  function stop() { scanning = false; scanToken++; action('stop').hidden = true; render(); }
  action('scan').addEventListener('click',async () => {
    scanning = true; const token = ++scanToken; action('stop').hidden = false; render();
    for(const unit of model.units) {
      if(!scanning || token !== scanToken) break;
      if(unit.sticky || !sizesFor(unit).length) continue;
      const node = document.getElementById(unit.id), rect = node?.getBoundingClientRect();
      if(rect) scrollTo({top:Math.max(0,scrollY + rect.top - 40),behavior:'instant'});
      await new Promise(resolve => setTimeout(resolve,1300));
    }
    if(token === scanToken) { stop(); scrollTo({top:0,behavior:'smooth'}); }
  });
  action('stop').addEventListener('click',stop);
  action('top').addEventListener('click',() => { stop(); scrollTo({top:0,behavior:'smooth'}); });
  action('restart').addEventListener('click',() => location.reload());
  action('copy').addEventListener('click',async () => {
    const report = JSON.stringify(collect(),null,2);
    try { await navigator.clipboard.writeText(report); action('copy').textContent = 'Report copied'; }
    catch { const field = one('[data-report]'); field.hidden = false; field.value = report; field.focus(); field.select(); action('copy').textContent = 'Copy selected report (Ctrl/Cmd+C)'; }
  });
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'data:text/css;base64,' + model.assets.css;
  css.onerror = () => record('Saved placeholder CSS could not load.'); document.head.appendChild(css);
  window.addEventListener('resize',() => { for(const view of stickyViews.values()) closePreview(view); render(); }); render(); setInterval(render,1000);
}
