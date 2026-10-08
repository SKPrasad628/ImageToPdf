const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const scripts = ['js/pdf-layout.js', 'js/app.js', 'js/pdf-import.js', 'js/import-queue.js', 'js/editor.js'].map(file => fs.readFileSync(path.join(root, file), 'utf8'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Load the actual application scripts. Only browser/encoding boundaries are
// mocked, so races can be paused precisely without a browser or dependencies.
function harness() {
  const elements = new Map(), revoked = [], resources = new Map(), encodes = [], toasts = [], rafs = new Map();
  let serial = 0, rafSerial = 0, encodeHook = null, decodeHook = null, thumbHook = null;
  const element = id => {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set();
    const listeners = new Map();
    const el = {
      id, tagName: id === 'editorModal' ? 'DIALOG' : 'DIV', dataset: {}, style: {}, disabled: false, checked: true,
      isConnected: true, open: false, showModalCalls: 0, closeCalls: 0, listeners,
      setAttribute(name, value) { this[name] = value; },
      value: ({ quality: '0.85', resW: '100', resH: '80' })[id] || '',
      classList: {
        add(...values) { values.forEach(value => classes.add(value)); },
        remove(...values) { values.forEach(value => classes.delete(value)); },
        contains(value) { return classes.has(value); },
        toggle(value, on = !classes.has(value)) { if (on) classes.add(value); else classes.delete(value); return on; }
      },
      addEventListener(type, listener) { listeners.set(type, listener); }, appendChild() {},
      showModal() { this.showModalCalls++; this.open = true; },
      close() { this.closeCalls++; this.open = false; },
      focus() { if (this.isConnected) context.document.activeElement = this; }, scrollIntoView() {}
    };
    elements.set(id, el);
    return el;
  };
  const controls = [element('saveChangesBtn'), element('applyAllBtn'), element('resize-control'), element('filter-control')];
  function canvas() {
    const calls = [], fills = [], rotations = [], scales = [];
    const ctx = { calls, filter: 'none', drawImage(image, ...args) { calls.push({ src: image.src, args, filter: this.filter }); } };
    for (const name of ['fillRect', 'clearRect', 'save', 'restore', 'translate', 'rotate', 'scale', 'beginPath', 'rect', 'clip', 'strokeRect', 'moveTo', 'lineTo', 'stroke']) ctx[name] = () => {};
    ctx.fillRect = (...args) => fills.push({ style: ctx.fillStyle, args });
    ctx.rotate = angle => rotations.push(angle);
    ctx.scale = (x, y) => scales.push([x, y]);
    ctx.fills = fills;
    ctx.rotations = rotations;
    ctx.scales = scales;
    return { width: 0, height: 0, ctx, getContext: () => ctx };
  }
  function mint(kind, data) {
    const url = `blob:${kind}-${++serial}`;
    resources.set(url, data);
    return url;
  }
  const context = vm.createContext({
    console, setTimeout, clearTimeout, Promise, Map, Set,
    requestAnimationFrame(callback) { const id = ++rafSerial; rafs.set(id, callback); return id; },
    cancelAnimationFrame(id) { rafs.delete(id); },
    URL: { revokeObjectURL(url) { revoked.push(url); } },
    document: {
      getElementById: element, querySelector: selector => element(selector),
      querySelectorAll(selector) {
        if (selector.startsWith('#editorModal .modal-body')) return controls;
        if (selector === '.et-panel') return ['rotate', 'resize', 'crop', 'flip', 'filters'].map(name => element(`panel-${name}`));
        return [];
      },
      createElement(type) { return type === 'canvas' ? canvas() : element(`created-${++serial}`); },
      body: element('body'), activeElement: { tagName: 'BODY' }, addEventListener() {}, removeEventListener() {}
    },
    window: { addEventListener() {} }, localStorage: { getItem() { return null; }, setItem() {} },
    alert() {}, confirm() { return true; }, fetch: async () => { throw new Error('No network in tests'); },
    bridgeToast: message => toasts.push(message),
    async bridgeDecode(src) {
      if (decodeHook) await decodeHook(src);
      if (revoked.includes(src)) throw new Error(`Revoked source: ${src}`);
      const data = resources.get(src) || { width: 100, height: 80 };
      return { src, naturalWidth: data.width, naturalHeight: data.height };
    },
    async bridgeEncode(cvs, quality, type) {
      const record = { width: cvs.width, height: cvs.height, quality, type,
        calls: cvs.ctx.calls.slice(), fills: cvs.ctx.fills.slice(),
        rotations: cvs.ctx.rotations.slice(), scales: cvs.ctx.scales.slice() };
      encodes.push(record);
      if (encodeHook) await encodeHook(record);
      const url = mint('output', record);
      return { url, bytes: 100 };
    },
    async bridgeThumb(src) {
      if (thumbHook) await thumbHook(src);
      return mint('thumb', resources.get(src));
    }
  });
  scripts.forEach(source => vm.runInContext(source, context));
  vm.runInContext(`
    loadImage = bridgeDecode; canvasToUrl = bridgeEncode; generateThumb = bridgeThumb;
    showToast = bridgeToast; render = () => {}; renderPdfEditor = () => {}; refreshAll = () => {};
  `, context);
  const run = source => vm.runInContext(source, context);
  const state = () => JSON.parse(run('JSON.stringify(images)'));
  function add(name, shared = false) {
    const src = `blob:${name}`, thumb = shared ? src : `blob:${name}-thumb`;
    resources.set(src, { width: 100, height: 80 });
    resources.set(thumb, { width: 100, height: 80 });
    context.seed = { name, src, thumb };
    run(`{ const seedId = _imgId();
      putStore(seedId, { src: seed.src, originalSrc: seed.src, thumb: seed.thumb });
      images.push({ _id: seedId, _pageId: seedId, name: seed.name, src: seed.src, originalSrc: seed.src, thumb: seed.thumb,
        size: 100, rotation: 0, flipH: false, flipV: false, filters: {} }); }`);
    return state().at(-1)._id;
  }
  return {
    context, run, state, element, resources, revoked, encodes, toasts, controls, rafs,
    add,
    async open(index = 0) { run(`openEditorFor(${index})`); await tick(); },
    setEncodeHook(hook) { encodeHook = hook; }, setDecodeHook(hook) { decodeHook = hook; }, setThumbHook(hook) { thumbHook = hook; },
    flushRaf() { const callbacks = [...rafs.values()]; rafs.clear(); callbacks.forEach(callback => callback()); }
  };
}

test('editor opens a native modal and cancel closes the session and restores its connected trigger', async () => {
  const h = harness(); h.add('A');
  const initialLeaseCount = h.run('_urlRefs.get("blob:A")');
  const trigger = h.element('editor-trigger'); trigger.tagName = 'BUTTON'; trigger.focus();
  await h.open();
  const dialog = h.element('editorModal');
  assert.equal(dialog.showModalCalls, 1);
  assert.equal(dialog.open, true, 'Native modal opening makes the background inert in the browser');
  assert.equal(h.context.document.activeElement.id, 'editorCloseBtn');
  let prevented = false;
  dialog.listeners.get('cancel')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'Escape uses editor cleanup rather than closing only its visual shell');
  assert.equal(dialog.closeCalls, 1);
  assert.equal(dialog.open, false);
  assert.equal(h.run('editorSession'), null);
  assert.equal(h.context.document.activeElement, trigger);
  assert.equal(h.run('_urlRefs.get("blob:A")'), initialLeaseCount, 'Cancel releases borrowed editor leases');
});

test('saving restores focus after rendering to the same logical page when its original trigger was removed', async () => {
  const h = harness(); h.add('A'); h.run("snapshot('Import')");
  const trigger = h.element('old-page-edit'); trigger.tagName = 'BUTTON'; trigger.focus();
  const thumbnail = h.element('[data-preview-page="0"]'); thumbnail.tagName = 'BUTTON';
  const order = [];
  h.context.bridgeRefresh = () => {
    order.push('render');
    trigger.isConnected = false;
    h.context.document.activeElement = h.element('body');
  };
  const originalFocus = thumbnail.focus;
  thumbnail.focus = function() { order.push('focus-new-thumbnail'); originalFocus.call(this); };
  h.run('refreshAll = bridgeRefresh');
  await h.open(); h.run('quickRotate(90)');
  assert.equal(await h.run('saveEdits()'), true);
  assert.deepEqual(order, ['render', 'focus-new-thumbnail']);
  assert.equal(h.context.document.activeElement, thumbnail);
  assert.equal(h.element('editorModal').open, false);
});

test('closing after the original trigger is detached restores focus to a connected page control', async () => {
  const h = harness(); h.add('A');
  const trigger = h.element('old-page-edit'); trigger.tagName = 'BUTTON'; trigger.focus();
  await h.open(); trigger.isConnected = false;
  h.run('closeEditor()');
  assert.equal(h.context.document.activeElement, h.element('[data-preview-page="0"]'));
});

test('closing from a tool whose trigger is now hidden restores focus to the page rail', async () => {
  const h = harness(); h.add('A');
  const trigger = h.element('toolsEditBtn'); trigger.tagName = 'BUTTON'; trigger.focus();
  await h.open(); trigger.getClientRects = () => [];
  h.run('closeEditor()');
  assert.equal(h.context.document.activeElement, h.element('[data-preview-page="0"]'));
});

test('filter adjustment, presets, and reset expose current values with spoken units', async () => {
  const h = harness(); h.add('A'); await h.open();
  assert.equal(h.element('f-brightness')['aria-valuetext'], '100 percent');
  assert.equal(h.element('f-blur')['aria-valuetext'], '0 pixels');
  h.run("updateFilter('blur', '1', 'px'); updateFilter('hue-rotate', '45', 'deg')");
  assert.equal(h.element('f-blur')['aria-valuetext'], '1 pixel');
  assert.equal(h.element('fv-blur').textContent, '1px');
  assert.equal(h.element('f-hue-rotate')['aria-valuetext'], '45 degrees');
  assert.equal(h.element('fv-hue-rotate').textContent, '45°');
  h.run("applyFilterPreset('document')");
  assert.equal(h.element('f-brightness').value, 115);
  assert.equal(h.element('f-brightness')['aria-valuetext'], '115 percent');
  assert.equal(h.element('f-grayscale')['aria-valuetext'], '100 percent');
  assert.equal(h.element('f-hue-rotate')['aria-valuetext'], '0 degrees');
  h.run('resetFilters()');
  assert.equal(h.element('f-brightness')['aria-valuetext'], '100 percent');
  assert.equal(h.element('f-grayscale')['aria-valuetext'], '0 percent');
});

test('every editor input has an associated accessible label in the document', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const editor = html.slice(html.indexOf('id="editorModal"'), html.indexOf('<!-- Lightbox -->'));
  const inputs = [...editor.matchAll(/<input\b[^>]*\bid="([^"]+)"[^>]*>/g)];
  assert.ok(inputs.length >= 15, 'Check numeric fields, aspect lock, crop coordinates, and all filter sliders');
  for (const [markup, id] of inputs) {
    const associatedLabel = new RegExp(`<label\\b[^>]*\\bfor="${id}"[^>]*>[\\s\\S]*?</label>`).test(editor);
    assert.ok(associatedLabel || /aria-label(?:ledby)?="[^"]+"/.test(markup), `Editor input ${id} must have an accessible name`);
  }
});

function addPdfPage(h, name, width = 210, height = 297) {
  h.add(name);
  h.run(`images.at(-1).pdfPageSizeMm = { width: ${width}, height: ${height} };
    images.at(-1).originalPdfPageSizeMm = { width: ${width}, height: ${height} }`);
  h.resources.set(`blob:${name}`, { width: Math.round(width * 10), height: Math.round(height * 10) });
}

test('PDF physical dimensions are independently copied into metadata and undo history', () => {
  const h = harness(); addPdfPage(h, 'A');
  h.run("snapshot('Import'); globalThis.light = _lightImages()");
  assert.equal(h.run('light[0].pdfPageSizeMm === images[0].pdfPageSizeMm'), false);
  assert.equal(h.run('light[0].originalPdfPageSizeMm === images[0].originalPdfPageSizeMm'), false);
  h.run("images[0].pdfPageSizeMm = {width:297,height:210}; snapshot('Rotate paper'); images[0].pdfPageSizeMm.width=1; images[0].originalPdfPageSizeMm.height=2");
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(light[0].pdfPageSizeMm)')), { width: 210, height: 297 });
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(light[0].originalPdfPageSizeMm)')), { width: 210, height: 297 });
  h.run('undo()');
  assert.deepEqual(h.state()[0].pdfPageSizeMm, { width: 210, height: 297 });
  assert.deepEqual(h.state()[0].originalPdfPageSizeMm, { width: 210, height: 297 });
  h.run('images[0].pdfPageSizeMm.width=3; images[0].originalPdfPageSizeMm.height=4; redo()');
  assert.deepEqual(h.state()[0].pdfPageSizeMm, { width: 297, height: 210 });
  assert.deepEqual(h.state()[0].originalPdfPageSizeMm, { width: 210, height: 297 });
  assert.equal(h.run('images[0].pdfPageSizeMm === images[0].originalPdfPageSizeMm'), false);
});

for (const duplicate of ['duplicateImage', 'duplicatePage']) {
  test(`${duplicate} creates independent current and original physical size objects`, () => {
    const h = harness(); addPdfPage(h, 'A');
    h.run(`${duplicate}(0)`);
    assert.equal(h.run('images[0].pdfPageSizeMm === images[1].pdfPageSizeMm'), false);
    assert.equal(h.run('images[0].originalPdfPageSizeMm === images[1].originalPdfPageSizeMm'), false);
    h.run('images[1].pdfPageSizeMm.width=1; images[1].originalPdfPageSizeMm.height=2');
    assert.deepEqual(h.state()[0].pdfPageSizeMm, { width: 210, height: 297 });
    assert.deepEqual(h.state()[0].originalPdfPageSizeMm, { width: 210, height: 297 });
  });
}

test('saving an editor quarter-turn rotates physical paper once and keeps the original basis', async () => {
  const h = harness(); addPdfPage(h, 'A'); h.run("snapshot('Import')");
  await h.open(); h.run('quickRotate(90)');
  assert.equal(await h.run('saveEdits()'), true);
  const rotated = h.state()[0];
  assert.equal(rotated.rotation, 0);
  assert.deepEqual(rotated.pdfPageSizeMm, { width: 297, height: 210 });
  assert.deepEqual(rotated.originalPdfPageSizeMm, { width: 210, height: 297 });
  assert.deepEqual([h.encodes[0].width, h.encodes[0].height], [2970, 2100]);
  await h.open(); h.run('editorFilters={sepia:50}');
  assert.equal(await h.run('saveEdits()'), true);
  assert.deepEqual(h.state()[0].pdfPageSizeMm, { width: 297, height: 210 });
  assert.deepEqual(h.state()[0].originalPdfPageSizeMm, { width: 210, height: 297 });
  assert.deepEqual([h.encodes[1].width, h.encodes[1].height], [2970, 2100]);
});

test('reopening and reverting a baked PDF rotation restores its original physical page size', async () => {
  const h = harness(); addPdfPage(h, 'A'); await h.open(); h.run('quickRotate(90)');
  assert.equal(await h.run('saveEdits()'), true);
  await h.open(); h.run('quickRotate(90); revertAll()');
  assert.equal(h.run('editorCurrentSrc'), 'blob:A');
  assert.equal(h.run('editorRotation'), 0);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(editorSession.pdfPageSizeMm)')), { width: 210, height: 297 });
  assert.equal(await h.run('saveEdits()'), true);
  assert.deepEqual(h.state()[0].pdfPageSizeMm, { width: 210, height: 297 });
  assert.deepEqual(h.state()[0].originalPdfPageSizeMm, { width: 210, height: 297 });
  assert.equal(h.encodes.length, 1, 'Revert reuses the original pixels instead of encoding them again');
  assert.equal(h.state()[0].src, 'blob:A');
});

for (const reset of ['resetResize', 'resetCrop']) {
  for (const pendingRotation of [0, 90]) {
    test(`${reset} uses original paper dimensions while preserving a pending ${pendingRotation}° rotation`, async () => {
      const h = harness(); addPdfPage(h, 'A'); await h.open(); h.run('quickRotate(90)');
      assert.equal(await h.run('saveEdits()'), true);
      await h.open(); h.run(`quickRotate(${pendingRotation}); ${reset}()`);
      assert.equal(h.run('editorCurrentSrc'), 'blob:A');
      assert.equal(h.run('editorRotation'), pendingRotation);
      assert.deepEqual(JSON.parse(h.run('JSON.stringify(editorSession.pdfPageSizeMm)')), { width: 210, height: 297 });
      assert.equal(await h.run('saveEdits()'), true);
      assert.deepEqual(h.state()[0].pdfPageSizeMm, pendingRotation === 90
        ? { width: 297, height: 210 } : { width: 210, height: 297 });
      assert.deepEqual(h.state()[0].originalPdfPageSizeMm, { width: 210, height: 297 });
    });
  }
}

for (const operation of ['resize', 'crop']) {
  test(`${operation} changes PDF content pixels and retains its physical paper dimensions`, async () => {
    const h = harness(); addPdfPage(h, 'A'); await h.open();
    if (operation === 'resize') {
      h.element('resW').value = '600'; h.element('resH').value = '400';
      assert.equal(await h.run('applyResize()'), true);
    } else {
      h.run('cropCachedImg={}; cropCanvasScale=1; cropRect={x:10,y:20,w:600,h:400}');
      assert.equal(await h.run('applyCrop()'), true);
    }
    assert.equal(await h.run('saveEdits()'), true);
    const page = h.state()[0], pixels = h.resources.get(page.src);
    assert.deepEqual([pixels.width, pixels.height], [600, 400]);
    assert.deepEqual(page.pdfPageSizeMm, { width: 210, height: 297 });
    assert.deepEqual(page.originalPdfPageSizeMm, { width: 210, height: 297 });
    const layout = JSON.parse(h.run(`JSON.stringify(computePdfLayout(images[0], {w:600,h:400},
      {pageSize:'fit',orientation:'auto',imgFit:'actual',margin:0,dpi:300,oversize:'shrink'}))`));
    assert.deepEqual(layout.page, { width: 210, height: 297, orientation: 'p' });
    assert.ok(layout.image.width <= 210 && layout.image.height <= 297);
    assert.equal(layout.image.width / layout.image.height, 1.5, 'Edited content must not stretch to the paper aspect ratio');
  });
}

test('Apply to all rotates every PDF page using its own physical size and original basis', async () => {
  const h = harness(); addPdfPage(h, 'A'); addPdfPage(h, 'B', 127, 50.8); h.add('Photo');
  await h.open(); h.run('quickRotate(90)');
  assert.equal(await h.run('saveEdits(true)'), true);
  const [a, b, photo] = h.state();
  assert.deepEqual(a.pdfPageSizeMm, { width: 297, height: 210 });
  assert.deepEqual(a.originalPdfPageSizeMm, { width: 210, height: 297 });
  assert.deepEqual(b.pdfPageSizeMm, { width: 50.8, height: 127 });
  assert.deepEqual(b.originalPdfPageSizeMm, { width: 127, height: 50.8 });
  assert.equal(photo.pdfPageSizeMm, undefined);
  assert.equal(photo.originalPdfPageSizeMm, undefined);
  assert.deepEqual(h.encodes.map(record => record.calls[0].src), ['blob:A', 'blob:B', 'blob:Photo']);
  assert.ok(h.state().every(page => page.rotation === 0));
});

for (const reset of ['resetResize', 'resetCrop', 'revertAll']) {
  test(`${reset} and close preserve shared originals, duplicates, and undo`, async () => {
    const h = harness(); h.add('A', true); h.run("snapshot('Import'); duplicateImage(0)");
    await h.open(); h.run(`${reset}(); closeEditor(); undo()`);
    assert.equal(h.revoked.includes('blob:A'), false);
    await h.run("loadImage(images[0].src)");
    assert.equal(h.state()[0].src, 'blob:A');
  });
}

for (const reset of ['resetResize', 'resetCrop']) {
  test(`${reset} does not turn an opening page’s retained filter into a chosen bulk step`, async () => {
    const h = harness(); h.add('A'); h.add('B');
    h.run('images[0].filters={contrast:130}; images[1].filters={brightness:115}; images[1].rotation=90; snapshot("Effects")');
    const before = h.state(), historyLength = h.run('history.length'); await h.open();
    h.run(`${reset}()`); assert.equal(await h.run('saveEdits(true)'), true);
    assert.deepEqual(h.state(), before);
    assert.equal(h.encodes.length, 0);
    assert.equal(h.run('history.length'), historyLength);
  });
}

test('Revert all from nonneutral opening filters clears the pending baseline without filtering other pages', async () => {
  const h = harness(); h.add('A'); h.add('B');
  h.run('images[0].filters={contrast:130}; images[1].filters={brightness:115}; snapshot("Effects")');
  const beforeB = h.state()[1]; await h.open(); h.run('revertAll()');
  assert.equal(h.run('JSON.stringify(editorSession.pendingFilterBaseline)'), '{}');
  assert.equal(await h.run('saveEdits(true)'), true);
  assert.deepEqual(h.state()[1], beforeB);
  assert.deepEqual(h.state()[0].filters, {});
  assert.equal(h.encodes.length, 0);
});

test('a fresh filter selection after Revert all propagates even when it matches the opening filter', async () => {
  const h = harness(); h.add('A'); h.add('B');
  h.run('images[0].filters={contrast:130}; snapshot("Effects")'); await h.open();
  h.run('revertAll(); updateFilter("contrast",130,"%")');
  assert.equal(await h.run('saveEdits(true)'), true);
  assert.deepEqual(h.encodes.map(record => [record.calls[0].src, record.calls[0].filter]), [['blob:B', 'contrast(130%)']]);
  assert.equal(h.state()[0].src, 'blob:A', 'A keeps the identical pending effect without a needless bake');
  assert.deepEqual(h.state()[0].filters, { contrast: 130 });
});

test('reset then a new edit frees only intermediates, not the original', async () => {
  const h = harness(); h.add('A'); await h.open();
  h.run('revertAll()'); await h.run('applyResize()'); h.run('closeEditor()');
  assert.equal(h.revoked.includes('blob:A'), false);
  assert.ok(h.revoked.some(url => url.startsWith('blob:output-')));
});

for (const apply of ['applyResize', 'applyCrop', 'applyFilters']) {
  test(`late ${apply} cannot change a newly opened editor`, async () => {
    const h = harness(); h.add('A'); h.add('B'); await h.open();
    h.run("cropCachedImg = {}; cropCanvasScale = 1; cropRect = {x:0,y:0,w:20,h:20}");
    const gate = deferred(), started = deferred();
    h.setEncodeHook(async () => { started.resolve(); await gate.promise; });
    const operation = h.run(`${apply}()`); await started.promise;
    h.run('closeEditor()'); await h.open(1); gate.resolve(); await operation;
    assert.equal(h.run('editorCurrentSrc'), 'blob:B');
    assert.equal(h.controls.some(control => control.disabled), false);
    assert.equal(h.revoked.filter(url => url.startsWith('blob:output-')).length, 1);
  });
}

test('revert invalidates a pending apply within the same session', async () => {
  const h = harness(); h.add('A'); await h.open();
  const gate = deferred(), started = deferred();
  h.setEncodeHook(async () => { started.resolve(); await gate.promise; });
  const operation = h.run('applyResize()'); await started.promise;
  h.run('revertAll()'); gate.resolve(); await operation;
  assert.equal(h.run('editorCurrentSrc'), 'blob:A');
  assert.equal(h.revoked.includes('blob:A'), false);
});

test('save waits for accepted resize and filter operations', async () => {
  const h = harness(); h.add('A'); await h.open();
  h.element('resW').value = '40'; h.element('resH').value = '30';
  h.run('editorFilters = {grayscale:100}');
  const resized = h.run('applyResize()');
  const filtered = h.run('applyFilters()');
  const saved = h.run('saveEdits()');
  await resized; await filtered; assert.equal(await saved, true);
  assert.equal(h.encodes.length, 2, 'Save keeps the applied pixels without a third encoding');
  assert.deepEqual(h.encodes.map(record => [record.width, record.height]), [[40,30],[40,30]]);
  assert.equal(h.encodes[1].calls[0].filter, 'grayscale(100%)');
  assert.equal(h.state()[0].src, 'blob:output-2');
});

test('ordinary Apply to all uses each photo’s own source and preserves undo', async () => {
  const h = harness(); h.add('A'); h.add('B'); h.run("snapshot('Import')"); await h.open();
  h.run('quickRotate(90)');
  assert.equal(await h.run('saveEdits(true)'), true);
  assert.deepEqual(h.encodes.map(record => record.calls[0].src), ['blob:A','blob:B']);
  assert.ok(h.state().every(image => image.src.startsWith('blob:output-')));
  h.run('undo()'); assert.deepEqual(h.state().map(image => image.src), ['blob:A','blob:B']);
  assert.equal(h.revoked.includes('blob:A') || h.revoked.includes('blob:B'), false);
});

test('saving edited pixels preserves logical page identity and selections through undo and redo', async () => {
  const h = harness(); h.add('A'); h.add('B');
  h.run("snapshot('Import'); selectedConvertCard=0; selectedPdfPage=0; selectedSet=new Set([0])");
  const before = h.state()[0];
  await h.open(); h.run('quickRotate(90)');
  assert.equal(await h.run('saveEdits()'), true);
  const edited = h.state()[0];
  assert.notEqual(edited._id, before._id);
  assert.equal(edited._pageId, before._pageId);
  for (const action of ['', 'undo()', 'redo()']) {
    if (action) h.run(action);
    assert.equal(h.state()[0]._pageId, before._pageId);
    assert.equal(h.run('selectedConvertCard'), 0);
    assert.equal(h.run('selectedPdfPage'), 0);
    assert.equal(h.run('selectedSet.has(0)'), true);
  }
});

test('closing and reopening during Apply to all cancels without copying A onto B', async () => {
  const h = harness(); h.add('A'); h.add('B'); await h.open(); h.run('quickRotate(90)');
  const before = h.state(), gate = deferred(), started = deferred();
  h.setEncodeHook(async () => { started.resolve(); await gate.promise; });
  const save = h.run('saveEdits(true)'); await started.promise;
  h.run('closeEditor()'); await h.open(1); gate.resolve();
  assert.equal(await save, false); assert.deepEqual(h.state(), before);
  assert.equal(h.run('editorCurrentSrc'), 'blob:B');
  assert.equal(h.encodes.length, 1);
  assert.equal(h.run('editorSession.saving'), false);
});

for (const [name, mutate] of [
  ['reorder', "images.reverse(); snapshot('Reorder')"],
  ['delete', "images.splice(0,1); snapshot('Delete')"],
  ['quick rotation', "images[1].rotation=90; snapshot('Rotate')"],
  ['undo', 'undo()'],
  ['unsnapshotted metadata change', 'images[1].rotation=180']
]) {
  test(`${name} during save cancels the complete transaction`, async () => {
    const h = harness(); h.add('A'); h.add('B'); h.run("snapshot('Import')"); await h.open();
    h.run('quickRotate(90)');
    const gate = deferred(), started = deferred();
    h.setEncodeHook(async () => { started.resolve(); await gate.promise; });
    const save = h.run('saveEdits(true)'); await started.promise; h.run(mutate);
    const changed = h.state(), historyLength = h.run('history.length');
    gate.resolve(); assert.equal(await save, false);
    assert.deepEqual(h.state(), changed); assert.equal(h.run('history.length'), historyLength);
    assert.ok(h.revoked.some(url => url.startsWith('blob:output-')));
  });
}

test('later target failure causes no partial save and frees all staged outputs', async () => {
  const h = harness(); h.add('A'); h.add('B'); await h.open(); h.run('quickRotate(90)'); const before = h.state();
  h.setEncodeHook(async record => { if (record.calls[0].src === 'blob:B') throw new Error('Encode failed'); });
  assert.equal(await h.run('saveEdits(true)'), false);
  assert.deepEqual(h.state(), before);
  assert.ok(h.revoked.some(url => url.startsWith('blob:output-')));
  assert.ok(h.revoked.some(url => url.startsWith('blob:thumb-')));
  assert.equal(h.controls.some(control => control.disabled), false);
});

test('thumbnail failure releases the prepared image without changing the page', async () => {
  const h = harness(); h.add('A'); await h.open(); h.run('quickRotate(90)'); const before = h.state();
  h.setThumbHook(async () => { throw new Error('Thumbnail failed'); });
  assert.equal(await h.run('saveEdits()'), false);
  assert.deepEqual(h.state(), before);
  assert.equal(h.revoked.filter(url => url.startsWith('blob:output-')).length, 1);
});

test('repeated save starts only one encoding transaction', async () => {
  const h = harness(); h.add('A'); await h.open(); h.run('quickRotate(90)'); const gate = deferred(), started = deferred();
  h.setEncodeHook(async () => { started.resolve(); await gate.promise; });
  const first = h.run('saveEdits()'); await started.promise;
  assert.equal(await h.run('saveEdits()'), false); gate.resolve(); assert.equal(await first, true);
  assert.equal(h.encodes.length, 1);
});

test('Save stays available during Apply, waits for it, and locks duplicate saves', async () => {
  const h = harness(); h.add('A'); await h.open(); const gate = deferred(), started = deferred();
  let first = true;
  h.setEncodeHook(async () => { if (first) { first = false; started.resolve(); await gate.promise; } });
  const apply = h.run('applyResize()'); await started.promise;
  assert.equal(h.element('saveChangesBtn').disabled, false);
  assert.equal(h.element('applyAllBtn').disabled, false);
  assert.equal(h.element('resize-control').disabled, true);
  const save = h.run('saveEdits()');
  assert.equal(h.element('saveChangesBtn').disabled, true);
  gate.resolve(); await apply; assert.equal(await save, true);
});

test('background page changes before Save cannot be overwritten by an old editor', async () => {
  const h = harness(); h.add('A'); await h.open();
  h.run("images[0].rotation=90; snapshot('Rotate')"); const changed = h.state();
  assert.equal(await h.run('saveEdits()'), false);
  assert.deepEqual(h.state(), changed); assert.equal(h.encodes.length, 0);
});

test('session and operation leases protect a source removed from history', async () => {
  const h = harness(); const id = h.add('A', true); await h.open();
  const gate = deferred(), started = deferred();
  h.setDecodeHook(async src => { if (src === 'blob:A') { started.resolve(); await gate.promise; } });
  const apply = h.run('applyResize()'); await started.promise;
  h.run(`images=[]; dropStore('${id}'); closeEditor()`);
  assert.equal(h.revoked.includes('blob:A'), false);
  gate.resolve(); await apply;
  assert.equal(h.revoked.filter(url => url === 'blob:A').length, 1);
});

test('stale size and crop loads do not update a new session or install handlers', async () => {
  const h = harness(); h.add('A'); h.add('B'); await h.open();
  const gate = deferred();
  h.setDecodeHook(async src => { if (src === 'blob:A') await gate.promise; });
  h.run("updateSizeInfo(); switchEditorTab('crop'); closeEditor()"); await h.open(1);
  h.element('resW').value = '777'; gate.resolve(); await tick();
  assert.equal(h.element('resW').value, '777');
  assert.equal(h.run('cropCachedImg'), null);
  assert.equal(h.element('previewCanvas').onmousedown, null);
});

test('application PDF import and password retry both use the protected loader', async () => {
  const h = harness(), calls = [];
  const pdf = {
    numPages: 1, async destroy() {},
    async getPage() { return {
      getViewport: ({scale}) => ({width:72 * scale, height:72 * scale}),
      render: () => ({promise:Promise.resolve()}), cleanup() {}
    }; }
  };
  h.context.window.PhotoPdfLibraries = {
    async openPdfDocument(options) {
      calls.push(options);
      if (calls.length === 1) throw Object.assign(new Error('Password required'), {name:'PasswordException'});
      return pdf;
    }
  };
  h.context.prompt = () => 'open-sesame';
  let reads = 0;
  h.context.testPdf = {name:'sample.pdf', size:100, async arrayBuffer() { reads++; return new ArrayBuffer(4); }};
  await h.run("loadPdfFile(testPdf, 'edit')");
  assert.equal(calls.length, 2); assert.equal(reads, 2);
  assert.equal(calls[1].password, 'open-sesame');
  assert.equal(h.state().length, 1); assert.equal(h.state()[0].name, 'sample.pdf');
});

for (const operation of ['applyResize()', 'applyCrop()', 'applyFilters()', 'saveEdits()']) {
  test(`${operation} produces lossless PNG working pixels without flattening alpha`, async () => {
    const h = harness(); h.add('Transparent'); await h.open();
    h.run('cropCachedImg={}; cropCanvasScale=1; cropRect={x:0,y:0,w:40,h:30}; editorFilters={sepia:50}');
    if (operation === 'saveEdits()') h.run('quickRotate(45); applyFlip("h")');
    assert.equal(await h.run(operation), true);
    assert.equal(h.encodes.length, 1);
    assert.equal(h.encodes[0].type, 'image/png');
    assert.equal(h.encodes[0].quality, undefined, 'Lossless pixels do not use the export JPEG quality setting');
    assert.deepEqual(h.encodes[0].fills, [], 'A transparent canvas stays transparent where no pixels are drawn');
    assert.equal(h.revoked.includes('blob:Transparent'), false);
  });
}

for (const applyToAll of [false, true]) {
  test(`unchanged Save${applyToAll ? ' to all' : ''} keeps source bytes, version IDs, history, and other page transforms`, async () => {
    const h = harness(); h.add('OriginalJPEG'); h.add('B');
    h.run('images[0].filters={brightness:100,contrast:100,saturate:100,blur:0,grayscale:0,sepia:0,"hue-rotate":0,invert:0}; images[1].rotation=90; images[1].filters={contrast:120}; snapshot("Import")');
    const before = h.state(), historyLength = h.run('history.length');
    const refs = h.run('JSON.stringify([..._urlRefs])');
    await h.open();
    assert.equal(await h.run(`saveEdits(${applyToAll})`), true);
    assert.deepEqual(h.state(), before);
    assert.equal(h.encodes.length, 0);
    assert.equal(h.run('history.length'), historyLength);
    assert.equal(h.run('editorSession'), null);
    assert.equal(h.run('JSON.stringify([..._urlRefs])'), refs, 'Closing a no-op save releases only the editor leases');
    assert.deepEqual(h.revoked, []);
  });
}

test('saved applied pixels are reused across reopening without another encoding or undo entry', async () => {
  const h = harness(); h.add('A'); h.run('snapshot("Import")'); await h.open();
  assert.equal(await h.run('applyResize()'), true);
  const workingSrc = h.run('editorCurrentSrc');
  assert.equal(await h.run('saveEdits()'), true);
  assert.equal(h.state()[0].src, workingSrc);
  assert.equal(h.encodes.length, 1);
  const saved = h.state(), historyLength = h.run('history.length');
  await h.open(); assert.equal(await h.run('saveEdits()'), true);
  assert.deepEqual(h.state(), saved);
  assert.equal(h.encodes.length, 1);
  assert.equal(h.run('history.length'), historyLength);
  h.run('undo()'); assert.equal(h.state()[0].src, 'blob:A');
  h.run('redo()'); assert.equal(h.state()[0].src, workingSrc);
  assert.equal(h.revoked.includes(workingSrc), false);
});

test('no-op PDF save preserves the original native page descriptor and no new pixel version', async () => {
  const h = harness(); addPdfPage(h, 'PDF');
  h.run('images[0].pdfSource={sourceId:"source",pageIndex:3}; images[0].originalPdfSource={sourceId:"source",pageIndex:3}; snapshot("Import")');
  const before = h.state(); await h.open();
  assert.equal(await h.run('saveEdits()'), true);
  assert.deepEqual(h.state(), before);
  assert.equal(h.encodes.length, 0);
});

test('opening and saving a page-list rotated native PDF preserves text source, pending rotation, pixels, and history', async () => {
  const h = harness(); addPdfPage(h, 'PDF');
  h.run('images[0].pdfSource={sourceId:"source",pageIndex:3}; images[0].originalPdfSource={sourceId:"source",pageIndex:3}; snapshot("Import"); rotatePage(0,90)');
  const before = h.state(), historyLength = h.run('history.length');
  const refs = h.run('JSON.stringify([..._urlRefs])');
  assert.equal(before[0].rotation, 90);
  await h.open();
  assert.equal(await h.run('saveEdits()'), true);
  assert.deepEqual(h.state(), before);
  assert.equal(h.encodes.length, 0);
  assert.equal(h.run('history.length'), historyLength);
  assert.equal(h.run('JSON.stringify([..._urlRefs])'), refs);
  assert.equal(h.revoked.includes('blob:PDF'), false);
});

test('ordinary unchanged Save also preserves an existing flip and effective filter state', async () => {
  const h = harness(); h.add('A');
  h.run('images[0].rotation=45; images[0].flipH=true; images[0].filters={contrast:130}; snapshot("Transform")');
  const before = h.state(), historyLength = h.run('history.length');
  await h.open(); h.run('editorFilters.brightness=100');
  assert.equal(await h.run('saveEdits()'), true);
  assert.deepEqual(h.state(), before);
  assert.equal(h.encodes.length, 0);
  assert.equal(h.run('history.length'), historyLength);
});

test('real PDF pixel editing clears the native descriptor and Revert restores its original source', async () => {
  const h = harness(); addPdfPage(h, 'PDF');
  h.run('images[0].pdfSource={sourceId:"source",pageIndex:3}; images[0].originalPdfSource={sourceId:"source",pageIndex:3}; snapshot("Import")');
  await h.open(); h.run('quickRotate(45)');
  assert.equal(await h.run('saveEdits()'), true);
  assert.equal(h.state()[0].pdfSource, undefined);
  assert.deepEqual(h.state()[0].originalPdfSource, { sourceId: 'source', pageIndex: 3 });
  await h.open(); h.run('revertAll()');
  assert.equal(await h.run('saveEdits()'), true);
  assert.equal(h.state()[0].src, 'blob:PDF');
  assert.deepEqual(h.state()[0].pdfSource, { sourceId: 'source', pageIndex: 3 });
  assert.equal(h.encodes.length, 1);
});

for (const fallback of [false, true]) {
  test(`the actual canvas encoder keeps PNG${fallback ? ' in its data URL fallback' : ' through Blob creation'} and frees the canvas`, async () => {
    const extract = (source, name) => {
      const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
      assert.ok(match, `Missing ${name}`);
      return match[0];
    };
    const calls = [], encodedBlob = { type: 'image/png', size: 12 };
    const context = vm.createContext({
      URL: { createObjectURL(blob) { assert.equal(blob, encodedBlob); return 'blob:lossless'; } }
    });
    vm.runInContext(`${extract(scripts[1], 'canvasToUrl')}\n${extract(scripts[4], 'encodeEditorCanvas')}`, context);
    context.canvas = {
      width: 100, height: 80,
      toBlob(callback, type, quality) { calls.push({ method: 'blob', type, quality }); callback(fallback ? null : encodedBlob); },
      toDataURL(type, quality) { calls.push({ method: 'data', type, quality }); return 'data:image/png;base64,test'; }
    };
    const result = await vm.runInContext('encodeEditorCanvas(canvas)', context);
    assert.equal(result, fallback ? 'data:image/png;base64,test' : 'blob:lossless');
    assert.ok(calls.every(call => call.type === 'image/png' && call.quality === undefined));
    assert.deepEqual([context.canvas.width, context.canvas.height], [0, 0]);
  });
}

test('canceling a save that reuses the original source cleans only its newly generated thumbnail', async () => {
  const h = harness(); h.add('A'); await h.open(); h.run('quickRotate(90)');
  assert.equal(await h.run('saveEdits()'), true);
  await h.open(); h.run('revertAll()');
  const gate = deferred(), started = deferred();
  h.setThumbHook(async () => { started.resolve(); await gate.promise; });
  const save = h.run('saveEdits()'); await started.promise;
  h.run('closeEditor()'); gate.resolve();
  assert.equal(await save, false);
  assert.equal(h.revoked.includes('blob:A'), false);
  assert.equal(h.state()[0].src, 'blob:output-1');
  assert.equal(h.encodes.length, 1);
  assert.equal(h.revoked.filter(url => url.startsWith('blob:thumb-')).length, 1);
});

test('Apply filters then Apply to all reuses the current pixels and filters every other source once', async () => {
  const h = harness(); h.add('A'); h.add('B'); h.run('snapshot("Import")'); await h.open();
  h.run('applyFilterPreset("grayscale")');
  assert.equal(await h.run('applyFilters()'), true);
  const currentPixels = h.run('editorCurrentSrc');
  assert.equal(await h.run('saveEdits(true)'), true);
  assert.equal(h.state()[0].src, currentPixels);
  assert.deepEqual(h.encodes.map(record => record.calls[0].src), ['blob:A', 'blob:B']);
  assert.equal(h.encodes[0].calls[0].filter, 'brightness(100%) contrast(105%) grayscale(100%)');
  assert.equal(h.encodes[1].calls[0].filter, h.encodes[0].calls[0].filter);
  assert.ok(h.encodes.every(record => record.type === 'image/png' && record.fills.length === 0));
  h.run('undo()'); assert.deepEqual(h.state().map(page => page.src), ['blob:A', 'blob:B']);
  h.run('redo()'); assert.equal(h.state()[0].src, currentPixels);
  assert.equal(h.revoked.includes(currentPixels), false);
});

test('Apply to all retains another page’s existing filter effects before the selected recipe', async () => {
  const h = harness(); h.add('A'); h.add('B');
  h.run('images[0].filters={contrast:130}; images[1].filters={brightness:115,contrast:110}; snapshot("Effects")');
  await h.open(); assert.equal(await h.run('applyFilters()'), true);
  assert.equal(await h.run('saveEdits(true)'), true);
  assert.deepEqual(h.encodes.map(record => record.calls[0].filter), [
    'contrast(130%)', 'brightness(115%) contrast(110%) contrast(130%)'
  ]);
  assert.equal(h.state()[0].src, 'blob:output-1', 'The opened page must not receive its own effect twice');
});

test('multiple Apply steps and a pending filter form one ordered recipe without repeating current effects', async () => {
  const h = harness(); h.add('A'); h.add('B'); h.run('images[1].filters={contrast:110}'); await h.open();
  h.run('editorFilters={grayscale:100}'); await h.run('applyFilters()');
  const first = h.run('editorCurrentSrc');
  h.run('editorFilters={invert:25}'); await h.run('applyFilters()');
  const second = h.run('editorCurrentSrc');
  h.run('editorFilters={sepia:40}'); assert.equal(await h.run('saveEdits(true)'), true);
  assert.deepEqual(h.encodes.map(record => [record.calls[0].src, record.calls[0].filter]), [
    ['blob:A', 'grayscale(100%)'], [first, 'invert(25%)'], [second, 'sepia(40%)'],
    ['blob:B', 'contrast(110%) grayscale(100%) invert(25%) sepia(40%)']
  ]);
});

test('reselecting an applied opening filter adds the same second step to every page', async () => {
  const h = harness(); h.add('A'); h.add('B');
  h.run('images[0].filters={contrast:130}; snapshot("Effects")'); await h.open();
  assert.equal(await h.run('applyFilters()'), true);
  const working = h.run('editorCurrentSrc');
  h.run('updateFilter("contrast",130,"%")');
  assert.equal(await h.run('saveEdits(true)'), true);
  assert.deepEqual(h.encodes.map(record => [record.calls[0].src, record.calls[0].filter]), [
    ['blob:A', 'contrast(130%)'], [working, 'contrast(130%)'],
    ['blob:B', 'contrast(130%) contrast(130%)']
  ]);
});

test('Reset sliders clears a pending selection but keeps already applied filter steps for Apply to all', async () => {
  const h = harness(); h.add('A'); h.add('B'); await h.open();
  h.run('editorFilters={grayscale:100}'); await h.run('applyFilters()');
  h.run('editorFilters={sepia:80}; resetFilters()');
  assert.equal(await h.run('saveEdits(true)'), true);
  assert.deepEqual(h.encodes.map(record => record.calls[0].filter), ['grayscale(100%)', 'grayscale(100%)']);
});

for (const reset of ['resetResize', 'resetCrop', 'revertAll']) {
  test(`${reset} clears baked filter recipes when it restores original pixels`, async () => {
    const h = harness(); h.add('A'); h.add('B');
    h.run('images[1].rotation=90; images[1].flipV=true; images[1].filters={contrast:120}; snapshot("Import")');
    const before = h.state(); await h.open();
    h.run('editorFilters={grayscale:100}'); await h.run('applyFilters()');
    h.run(`${reset}()`);
    assert.equal(h.run('editorSession.filterRecipe.length'), 0);
    assert.equal(await h.run('saveEdits(true)'), true);
    assert.deepEqual(h.state(), before);
    assert.equal(h.encodes.length, 1);
  });
}

test('a filter-only batch bakes each page’s own pending rotation and flip without replacing them', async () => {
  const h = harness(); addPdfPage(h, 'A'); addPdfPage(h, 'B', 127, 50.8);
  h.run('images[1].rotation=90; images[1].flipV=true; images[1].pdfSource={sourceId:"native",pageIndex:1}; images[1].originalPdfSource={sourceId:"native",pageIndex:1}; snapshot("Import")');
  await h.open(); h.run('editorFilters={grayscale:100}');
  assert.equal(await h.run('saveEdits(true)'), true);
  assert.deepEqual(h.encodes.map(record => record.rotations[0]), [0, Math.PI / 2]);
  assert.deepEqual(h.encodes[1].scales, [[1, -1]]);
  const b = h.state()[1];
  assert.deepEqual(b.pdfPageSizeMm, { width: 50.8, height: 127 });
  assert.deepEqual(b.originalPdfPageSizeMm, { width: 127, height: 50.8 });
  assert.equal(b.pdfSource, undefined);
  assert.deepEqual(b.originalPdfSource, { sourceId: 'native', pageIndex: 1 });
  assert.equal(b.rotation, 0, 'The existing quarter-turn is now represented by the baked pixels and paper size');
  await h.open(1); h.run('revertAll()'); assert.equal(await h.run('saveEdits()'), true);
  assert.deepEqual(h.state()[1].pdfSource, { sourceId: 'native', pageIndex: 1 });
  assert.deepEqual(h.state()[1].pdfPageSizeMm, { width: 127, height: 50.8 });
});

for (const [initialA, initialB, finalA, finalB] of [[0, 180, 90, 270], [90, 180, 180, 270]]) {
  test(`a 90° batch change adds to A ${initialA}° and B ${initialB}° independently`, async () => {
    const h = harness(); addPdfPage(h, 'A'); addPdfPage(h, 'B', 127, 50.8);
    h.run(`images[0].rotation=${initialA}; images[1].rotation=${initialB}; snapshot("Import")`);
    await h.open(); h.run('quickRotate(90)'); assert.equal(await h.run('saveEdits(true)'), true);
    assert.deepEqual(h.encodes.map(record => Math.round(record.rotations[0] * 180 / Math.PI)), [finalA, finalB]);
    assert.deepEqual(h.state()[1].pdfPageSizeMm, { width: 50.8, height: 127 });
    assert.deepEqual(h.state()[1].originalPdfPageSizeMm, { width: 127, height: 50.8 });
  });
}

test('batch flip changes toggle each page’s own flip instead of copying the opened state', async () => {
  const h = harness(); h.add('A'); h.add('B');
  h.run('images[0].flipH=true; images[1].flipH=true; images[1].flipV=true; snapshot("Import")');
  await h.open(); h.run('applyFlip("h")'); assert.equal(await h.run('saveEdits(true)'), true);
  assert.deepEqual(h.encodes.map(record => record.scales[0]), [[1, -1]], 'A’s flip cancels without an encoding; B retains its vertical flip');
  assert.equal(h.encodes[0].calls[0].src, 'blob:B');
  assert.equal(h.state()[0].src, 'blob:A');
  assert.ok(h.state().every(page => !page.flipH && !page.flipV));
});

test('opening Apply to all without choosing a change retains all pages’ existing transforms and native sources', async () => {
  const h = harness(); addPdfPage(h, 'A'); addPdfPage(h, 'B');
  h.run('images[0].rotation=90; images[0].flipH=true; images[0].filters={contrast:130}; images[1].rotation=180; images[1].pdfSource={sourceId:"native",pageIndex:1}; snapshot("Import")');
  const before = h.state(), historyLength = h.run('history.length'); await h.open();
  assert.equal(await h.run('saveEdits(true)'), true);
  assert.deepEqual(h.state(), before);
  assert.equal(h.encodes.length, 0);
  assert.equal(h.run('history.length'), historyLength);
});

for (const apply of ['applyResize()', 'applyCrop()']) {
  test(`${apply} followed by Apply to all keeps unrelated pages’ pending edits untouched`, async () => {
    const h = harness(); h.add('A'); h.add('B');
    h.run('images[1].rotation=180; images[1].flipH=true; images[1].filters={contrast:130}; snapshot("Import")');
    const beforeB = h.state()[1]; await h.open();
    h.run('cropCachedImg={}; cropCanvasScale=1; cropRect={x:0,y:0,w:40,h:30}');
    assert.equal(await h.run(apply), true); assert.equal(await h.run('saveEdits(true)'), true);
    assert.deepEqual(h.state()[1], beforeB);
    assert.equal(h.encodes.length, 1);
  });
}

test('failed and canceled Apply filters steps never leak into a later batch recipe', async () => {
  const h = harness(); h.add('A'); h.add('B'); await h.open(); h.run('editorFilters={grayscale:100}');
  h.setEncodeHook(async () => { throw new Error('Encoding failed'); });
  assert.equal(await h.run('applyFilters()'), false);
  assert.equal(h.run('editorSession.filterRecipe.length'), 0);
  h.setEncodeHook(null);
  const gate = deferred(), started = deferred();
  h.setEncodeHook(async () => { started.resolve(); await gate.promise; });
  const applying = h.run('applyFilters()'); await started.promise;
  h.run('closeEditor()'); await h.open(1); gate.resolve(); assert.equal(await applying, false);
  assert.equal(h.run('editorSession.filterRecipe.length'), 0);
  assert.equal(h.run('editorCurrentSrc'), 'blob:B');
});

test('filter recipe staging remains atomic when a later batch target fails', async () => {
  const h = harness(); h.add('A'); h.add('B'); h.add('C'); h.run('snapshot("Import")'); await h.open();
  h.run('editorFilters={grayscale:100}'); await h.run('applyFilters()');
  const before = h.state(), workingSrc = h.run('editorCurrentSrc');
  h.setEncodeHook(async record => { if (record.calls[0].src === 'blob:C') throw new Error('Encoding failed'); });
  assert.equal(await h.run('saveEdits(true)'), false);
  assert.deepEqual(h.state(), before);
  assert.equal(h.run('editorCurrentSrc'), workingSrc);
  assert.equal(h.revoked.includes(workingSrc), false, 'The active editor still owns the applied working pixels');
  assert.equal(h.run('editorSession.filterRecipe.length'), 1);
  assert.equal(h.revoked.some(url => url.startsWith('blob:output-') && url !== workingSrc), true);
});

test('applied filters plus pending per-page rotations bake each orientation without repeating current filters', async () => {
  const h = harness(); addPdfPage(h, 'A'); addPdfPage(h, 'B', 127, 50.8);
  h.run('images[0].rotation=90; images[1].rotation=180; snapshot("Import")'); await h.open();
  h.run('editorFilters={grayscale:100}'); await h.run('applyFilters()');
  const working = h.run('editorCurrentSrc'); assert.equal(await h.run('saveEdits(true)'), true);
  assert.deepEqual(h.encodes.map(record => [record.calls[0].src, record.calls[0].filter]), [
    ['blob:A', 'grayscale(100%)'], [working, 'none'], ['blob:B', 'grayscale(100%)']
  ]);
  assert.deepEqual(h.encodes.slice(1).map(record => Math.round(record.rotations[0] * 180 / Math.PI)), [90, 180]);
  assert.deepEqual(h.state()[0].pdfPageSizeMm, { width: 297, height: 210 });
  assert.deepEqual(h.state()[1].pdfPageSizeMm, { width: 127, height: 50.8 });
});

test('an applied filter saved on one page is not reapplied or propagated by reopening with no chosen change', async () => {
  const h = harness(); h.add('A'); h.add('B'); await h.open();
  h.run('editorFilters={grayscale:100}'); await h.run('applyFilters()');
  const working = h.run('editorCurrentSrc'); assert.equal(await h.run('saveEdits()'), true);
  assert.equal(h.encodes.length, 1); assert.equal(h.state()[0].src, working);
  const before = h.state(), historyLength = h.run('history.length'); await h.open();
  assert.equal(await h.run('saveEdits(true)'), true);
  assert.deepEqual(h.state(), before); assert.equal(h.encodes.length, 1);
  assert.equal(h.run('history.length'), historyLength);
});
