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
  const elements = new Map(), revoked = [], resources = new Map(), encodes = [], toasts = [], rafs = new Map(), documentListeners = new Map();
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
  const editorTabs = ['rotate', 'crop', 'resize', 'filters'];
  const editorDetails = ['editorAngleDetails', 'editorResizeDetails', 'editorCropDetails', 'editorAdjustmentDetails', 'editorBatchDetails', 'editorRevertDetails'];
  editorTabs.forEach(name => { element('editor-tab-' + name).dataset.editorTab = name; });
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
    const captures = new Set();
    return { width: 0, height: 0, ctx, getContext: () => ctx,
      getBoundingClientRect() { return this.displayRect || { left: 0, top: 0, width: this.width, height: this.height }; },
      setPointerCapture(id) { captures.add(id); }, hasPointerCapture(id) { return captures.has(id); },
      releasePointerCapture(id) { captures.delete(id); } };
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
        if (selector === '.et-panel') return editorTabs.map(name => element(`panel-${name}`));
        if (selector === '#editorModal details') return editorDetails.map(element);
        return [];
      },
      createElement(type) { return type === 'canvas' ? canvas() : element(`created-${++serial}`); },
      body: element('body'), activeElement: { tagName: 'BODY' },
      addEventListener(type, handler) { if (!documentListeners.has(type)) documentListeners.set(type, new Set()); documentListeners.get(type).add(handler); },
      removeEventListener(type, handler) { documentListeners.get(type)?.delete(handler); }
    },
    window: { PointerEvent: function PointerEvent() {}, addEventListener() {} }, localStorage: { getItem() { return null; }, setItem() {} },
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
  Object.assign(element('previewCanvas'), canvas());
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
    context, run, state, element, resources, revoked, encodes, toasts, controls, rafs, documentListeners,
    dispatch(type, event) { for (const handler of documentListeners.get(type) || []) handler(event); },
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

test('editor tool tabs support arrow keys, wrapping, Home and End with one active panel and focus', async () => {
  const h = harness(); h.add('A'); await h.open();
  const press = (name, key) => {
    const target = h.element('editor-tab-' + name);
    let prevented = false;
    h.context.tabKeyEvent = { target, key, preventDefault() { prevented = true; } };
    h.run('handleEditorTabKey(tabKeyEvent)');
    return prevented;
  };
  assert.equal(h.element('editor-tab-rotate')['aria-selected'], 'true');
  assert.equal(press('rotate', 'ArrowLeft'), true);
  assert.equal(h.run('editorTab'), 'filters');
  assert.equal(h.context.document.activeElement.id, 'editor-tab-filters');
  assert.equal(h.element('editor-tab-filters').tabIndex, 0);
  assert.equal(h.element('editor-tab-rotate').tabIndex, -1);
  assert.equal(h.element('panel-filters').style.display, 'block');
  assert.equal(h.element('panel-rotate').style.display, 'none');
  assert.equal(press('filters', 'ArrowRight'), true);
  assert.equal(h.run('editorTab'), 'rotate');
  assert.equal(press('rotate', 'End'), true);
  assert.equal(h.run('editorTab'), 'filters');
  assert.equal(press('filters', 'Home'), true);
  assert.equal(h.run('editorTab'), 'rotate');
  assert.equal(press('rotate', 'Tab'), false, 'Tab keeps its normal browser navigation behavior');
  h.run("switchEditorTab('flip')");
  assert.equal(h.run('editorTab'), 'rotate', 'Old Flip callers use the combined transform view');
  assert.equal(h.state()[0].src, 'blob:A', 'Moving between tools does not commit an edit');
});

test('precise and bulk editor actions start collapsed for each page without carrying open state forward', async () => {
  const h = harness(); h.add('A'); h.add('B'); await h.open();
  for (const id of ['editorAngleDetails', 'editorResizeDetails', 'editorCropDetails', 'editorAdjustmentDetails', 'editorBatchDetails', 'editorRevertDetails']) {
    assert.equal(h.element(id).open, false);
    h.element(id).open = true;
  }
  h.run('closeEditor()'); await h.open(1);
  for (const id of ['editorAngleDetails', 'editorResizeDetails', 'editorCropDetails', 'editorAdjustmentDetails', 'editorBatchDetails', 'editorRevertDetails']) {
    assert.equal(h.element(id).open, false, `${id} should start collapsed on the next page`);
  }
  assert.equal(h.run('editorCurrentSrc'), 'blob:B');
  assert.equal(h.run('editorSession.filterRecipe.length'), 0);
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

for (const view of ['preview', 'layout']) {
  test(`closing an editor from Help returns focus to the visible mobile ${view} view`, async () => {
    const h = harness(); h.add('A');
    const trigger = h.element('toolsEditBtn'); trigger.tagName = 'BUTTON'; trigger.focus();
    const viewPanel = h.element('workspace-' + view);
    let calls = 0;
    h.context.window.PageForgeUI = { focusActivePage() { calls++; viewPanel.focus(); } };
    await h.open(); trigger.getClientRects = () => [];
    const railControl = h.element('[data-preview-page="0"]');
    railControl.getClientRects = () => [];
    h.run('closeEditor()');
    assert.equal(calls, 1);
    assert.equal(h.context.document.activeElement, viewPanel, 'The hidden Pages rail must not receive restored focus');
    assert.equal(h.run('_editorReturnFocus'), null);
  });
}

test('editor focus restoration keeps a visible trigger and uses the file picker when no pages remain', async () => {
  const h = harness(); h.add('A');
  const trigger = h.element('visible-edit'); trigger.tagName = 'BUTTON'; trigger.focus();
  let calls = 0;
  h.context.window.PageForgeUI = { focusActivePage() { calls++; } };
  await h.open(); h.run('closeEditor()');
  assert.equal(h.context.document.activeElement, trigger);
  assert.equal(calls, 0, 'A visible editor trigger remains the preferred focus target');
  await h.open(); trigger.isConnected = false;
  h.run('images = []; closeEditor()');
  assert.equal(h.context.document.activeElement, h.element('fileInput'));
  assert.equal(calls, 0, 'The empty workspace does not ask for an active page');
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

async function selectCrop(h, rect) {
  h.run("switchEditorTab('crop')"); await tick();
  for (const [key, value] of Object.entries(rect)) h.element('crop' + key.toUpperCase()).value = value;
  h.run('updateCropFromInputs()');
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
  test(`${operation} changes PDF content pixels and ${operation === 'crop' ? 'trims' : 'retains'} its physical paper dimensions`, async () => {
    const h = harness(); addPdfPage(h, 'A'); await h.open();
    if (operation === 'resize') {
      h.element('resW').value = '600'; h.element('resH').value = '400';
      assert.equal(await h.run('applyResize()'), true);
    } else {
      await selectCrop(h, { x: 10, y: 20, w: 600, h: 400 });
      assert.equal(await h.run('applyCrop()'), true);
    }
    assert.equal(await h.run('saveEdits()'), true);
    const page = h.state()[0], pixels = h.resources.get(page.src);
    assert.deepEqual([pixels.width, pixels.height], [600, 400]);
    assert.deepEqual(page.pdfPageSizeMm, operation === 'crop' ? { width: 60, height: 40 } : { width: 210, height: 297 });
    assert.deepEqual(page.originalPdfPageSizeMm, { width: 210, height: 297 });
    const layout = JSON.parse(h.run(`JSON.stringify(computePdfLayout(images[0], {w:600,h:400},
      {pageSize:'fit',orientation:'auto',imgFit:'actual',margin:0,dpi:300,oversize:'shrink'}))`));
    assert.deepEqual(layout.page, operation === 'crop'
      ? { width: 60, height: 40, orientation: 'l' } : { width: 210, height: 297, orientation: 'p' });
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
    await selectCrop(h, { x: 0, y: 0, w: 20, h: 20 });
    if (apply === 'applyFilters') h.run('editorFilters={grayscale:100}');
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
    await selectCrop(h, { x: 0, y: 0, w: 40, h: 30 }); h.run('editorFilters={sepia:50}');
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

test('editor quarter-turn PDF rotation preserves native content and survives undo/redo', async () => {
  const h = harness(); addPdfPage(h, 'PDF');
  h.run('images[0].pdfSource={sourceId:"source",pageIndex:3}; images[0].originalPdfSource={sourceId:"source",pageIndex:3}; snapshot("Import")');
  const before = h.state()[0];
  await h.open(); h.run('quickRotate(90)');
  assert.equal(await h.run('saveEdits()'), true);
  assert.equal(h.state()[0].src, before.src);
  assert.equal(h.state()[0].rotation, 90);
  assert.deepEqual(h.state()[0].pdfSource, before.pdfSource);
  assert.deepEqual(h.state()[0].pdfPageSizeMm, before.pdfPageSizeMm);
  assert.equal(h.encodes.length, 0);
  h.run('undo()'); assert.equal(h.state()[0].rotation, 0);
  h.run('redo()'); assert.equal(h.state()[0].rotation, 90);
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
    await selectCrop(h, { x: 0, y: 0, w: 40, h: 30 });
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

test('neutral Apply filters keeps native PDF pixels, descriptors, transforms, leases, and history', async () => {
  const h = harness(); addPdfPage(h, 'A'); addPdfPage(h, 'B');
  h.run('images[0].pdfSource={sourceId:"native",pageIndex:0}; images[0].rotation=90; images[1].pdfSource={sourceId:"native",pageIndex:1}; images[1].rotation=180; snapshot("Import")');
  const before = h.state(), historyLength = h.run('history.length'), leases = h.run('JSON.stringify([..._urlRefs])');
  await h.open();
  assert.equal(await h.run('applyFilters()'), true);
  h.run('editorFilters={brightness:100,contrast:100,saturate:100,blur:0,grayscale:0,sepia:0,"hue-rotate":0,invert:0}');
  assert.equal(await h.run('applyFilters()'), true);
  assert.equal(h.run('editorSession.pdfSource.sourceId'), 'native');
  assert.equal(h.run('editorCurrentSrc'), before[0].src);
  assert.equal(h.run('editorSession.filterRecipe.length'), 0);
  assert.equal(await h.run('saveEdits(true)'), true);
  assert.deepEqual(h.state(), before);
  assert.equal(h.encodes.length, 0);
  assert.equal(h.run('history.length'), historyLength);
  assert.equal(h.run('JSON.stringify([..._urlRefs])'), leases);
});

test('repeated Apply filters activation accepts one step while encoding and remains neutral afterward', async () => {
  const h = harness(); h.add('A'); h.add('B'); h.run('snapshot("Import")'); await h.open();
  h.run('editorFilters={contrast:130}');
  const gate = deferred(), started = deferred();
  h.setEncodeHook(async () => { started.resolve(); await gate.promise; });
  const first = h.run('applyFilters()'); await started.promise;
  const repeated = h.run('applyFilters()');
  assert.equal(repeated, first, 'Repeated activation waits for the accepted step');
  gate.resolve(); assert.equal(await first, true); assert.equal(await repeated, true);
  const working = h.run('editorCurrentSrc');
  assert.equal(await h.run('applyFilters()'), true);
  assert.equal(h.run('editorCurrentSrc'), working);
  assert.equal(h.run('editorSession.filterRecipe.length'), 1);
  assert.equal(h.encodes.length, 1);
  h.setEncodeHook(null); assert.equal(await h.run('saveEdits(true)'), true);
  assert.deepEqual(h.encodes.map(record => [record.calls[0].src, record.calls[0].filter]), [
    ['blob:A', 'contrast(130%)'], ['blob:B', 'contrast(130%)']
  ]);
  assert.equal(h.state()[0].src, working);
  h.run('undo()'); assert.deepEqual(h.state().map(page => page.src), ['blob:A', 'blob:B']);
});

test('reset invalidates an in-flight Apply guard and accepts a fresh filter step in the same session', async () => {
  const h = harness(); h.add('A'); h.add('B'); await h.open();
  h.run('editorFilters={grayscale:100}');
  const gate = deferred(), started = deferred();
  h.setEncodeHook(async record => { if (record.calls[0].filter === 'grayscale(100%)') { started.resolve(); await gate.promise; } });
  const canceled = h.run('applyFilters()'); await started.promise;
  h.run('revertAll(); editorFilters={sepia:40}');
  const fresh = h.run('applyFilters()'); assert.notEqual(fresh, canceled);
  gate.resolve(); assert.equal(await canceled, false); assert.equal(await fresh, true);
  assert.equal(h.run('editorSession.filterRecipe.length'), 1);
  const working = h.run('editorCurrentSrc'); assert.equal(await h.run('saveEdits(true)'), true);
  assert.deepEqual(h.encodes.map(record => [record.calls[0].src, record.calls[0].filter]), [
    ['blob:A', 'grayscale(100%)'], ['blob:A', 'sepia(40%)'], ['blob:B', 'sepia(40%)']
  ]);
  assert.equal(h.state()[0].src, working);
});

test('quarter-turn-only batch keeps each native page and adds the chosen rotation to its own orientation', async () => {
  const h = harness(); addPdfPage(h, 'A'); addPdfPage(h, 'B', 127, 50.8);
  h.run('images[0].pdfSource={sourceId:"native",pageIndex:0}; images[1].pdfSource={sourceId:"native",pageIndex:1}; images[0].rotation=90; images[1].rotation=270; snapshot("Import")');
  const before = h.state(); await h.open(); h.run('quickRotate(90)');
  assert.equal(await h.run('saveEdits(true)'), true);
  const after = h.state(); assert.deepEqual(after.map(page => page.rotation), [180, 0]);
  assert.deepEqual(after.map(page => page.src), before.map(page => page.src));
  assert.deepEqual(after.map(page => page.pdfSource), before.map(page => page.pdfSource));
  assert.deepEqual(after.map(page => page.pdfPageSizeMm), before.map(page => page.pdfPageSizeMm));
  assert.equal(h.encodes.length, 0);
  h.run('undo()'); assert.deepEqual(h.state(), before);
  h.run('redo()'); assert.deepEqual(h.state(), after);
});

test('filter batch preserves both an already baked rotation and a native quick rotation at the same displayed size', async () => {
  const h = harness(); h.add('A'); addPdfPage(h, 'B'); addPdfPage(h, 'C');
  h.run('images[2].pdfSource={sourceId:"native",pageIndex:2}; images[2].originalPdfSource={sourceId:"native",pageIndex:2}; snapshot("Import")');
  await h.open(1); h.run('quickRotate(90)'); assert.equal(await h.run('saveEdits()'), true);
  const bakedB = h.state()[1].src;
  h.run('images[2].rotation=90; snapshot("Quick rotate C")');
  const before = h.state(); await h.open(0); h.run('editorFilters={grayscale:100}');
  await h.run('applyFilters()'); const workingA = h.run('editorCurrentSrc');
  const encodeStart = h.encodes.length; assert.equal(await h.run('saveEdits(true)'), true);
  const batch = h.encodes.slice(encodeStart);
  assert.deepEqual(batch.map(record => [record.calls[0].src, record.rotations[0], record.width, record.height]), [
    [bakedB, 0, 2970, 2100], ['blob:C', Math.PI / 2, 2970, 2100]
  ]);
  assert.ok(batch.every(record => record.calls[0].filter === 'grayscale(100%)'));
  assert.equal(h.state()[0].src, workingA, 'A reuses its applied pixels');
  assert.deepEqual(h.state().slice(1).map(page => page.pdfPageSizeMm), [
    { width: 297, height: 210 }, { width: 297, height: 210 }
  ]);
  assert.equal(h.state()[2].pdfSource, undefined, 'C becomes an image after an explicit pixel filter');
  assert.deepEqual(h.state()[2].originalPdfSource, { sourceId: 'native', pageIndex: 2 });
  h.run('undo()'); assert.deepEqual(h.state(), before);
});

const cropRectState = h => JSON.parse(h.run('JSON.stringify(cropRect)'));
function pointer(x, y, id = 1, extra = {}) {
  return { clientX: x, clientY: y, pointerId: id, pointerType: 'touch', isPrimary: true, button: 0,
    preventDefault() { this.prevented = true; }, ...extra };
}

test('phone crop corner drag resizes the existing rectangle using displayed canvas coordinates', async () => {
  const h = harness(); h.add('Phone'); h.resources.set('blob:Phone', { width: 1000, height: 800 }); await h.open();
  await selectCrop(h, { x: 200, y: 100, w: 600, h: 500 });
  const cvs = h.element('previewCanvas'); cvs.displayRect = { left: 20, top: 30, width: 240, height: 192 };
  const before = cropRectState(h), down = pointer(68, 54);
  cvs.onpointerdown(down);
  assert.deepEqual(cropRectState(h), before, 'Grabbing a handle does not reset the rectangle');
  assert.equal(cvs.hasPointerCapture(1), true);
  h.dispatch('pointermove', pointer(44, 42)); h.dispatch('pointerup', pointer(44, 42));
  assert.deepEqual(['cropX', 'cropY', 'cropW', 'cropH'].map(id => h.element(id).value), [100, 50, 700, 550]);
  assert.equal(cvs.hasPointerCapture(1), false);
});

test('all crop corners and edges keep the opposite edge fixed and clamp to one source pixel', () => {
  const h = harness(), original = { x: 20, y: 15, w: 60, h: 50 };
  h.context.original = original;
  const drag = (mode, x, y) => JSON.parse(h.run(`JSON.stringify(cropDragRect('${mode}', {x:0,y:0}, {x:${x},y:${y}}, original,100,80,1,1))`));
  assert.deepEqual(drag('nw', -100, -100), { x: 0, y: 0, w: 80, h: 65 });
  assert.deepEqual(drag('ne', 1000, -100), { x: 20, y: 0, w: 80, h: 65 });
  assert.deepEqual(drag('sw', -100, 1000), { x: 0, y: 15, w: 80, h: 65 });
  assert.deepEqual(drag('se', 1000, 1000), { x: 20, y: 15, w: 80, h: 65 });
  assert.deepEqual(drag('w', 1000, 40), { x: 79, y: 15, w: 1, h: 50 });
  assert.deepEqual(drag('e', -100, 40), { x: 20, y: 15, w: 1, h: 50 });
  assert.deepEqual(drag('n', 40, 1000), { x: 20, y: 64, w: 60, h: 1 });
  assert.deepEqual(drag('s', 40, -100), { x: 20, y: 15, w: 60, h: 1 });
});

test('drawing a new crop beyond the top and left clamps endpoints before computing dimensions', () => {
  const h = harness();
  const rect = JSON.parse(h.run(`JSON.stringify(cropDragRect('new', {x:100,y:80},
    {x:-20,y:-50}, {x:0,y:0,w:480,h:400}, 480,400,0.1,0.1))`));
  assert.deepEqual(rect, { x: 0, y: 0, w: 100, h: 80 });
});

test('moving a crop retains its size and clamps the whole rectangle inside the image', async () => {
  const h = harness(); h.add('Phone'); h.resources.set('blob:Phone', { width: 1000, height: 800 }); await h.open();
  await selectCrop(h, { x: 200, y: 200, w: 500, h: 400 });
  const cvs = h.element('previewCanvas');
  cvs.onpointerdown(pointer(216, 192)); h.dispatch('pointermove', pointer(700, -300)); h.dispatch('pointerup', pointer(700, -300));
  assert.deepEqual(['cropX', 'cropY', 'cropW', 'cropH'].map(id => h.element(id).value), [500, 0, 500, 400]);
});

test('crop pointer cancellation and a second finger restore the chosen rectangle and stop dragging', async () => {
  const h = harness(); h.add('Phone'); h.resources.set('blob:Phone', { width: 1000, height: 800 }); await h.open();
  await selectCrop(h, { x: 200, y: 100, w: 600, h: 500 }); const original = cropRectState(h), cvs = h.element('previewCanvas');
  cvs.onpointerdown(pointer(96, 48)); h.dispatch('pointermove', pointer(48, 24));
  h.dispatch('pointermove', pointer(0, 0, 99)); assert.notDeepEqual(cropRectState(h), original);
  h.dispatch('pointercancel', pointer(48, 24)); assert.deepEqual(cropRectState(h), original);
  cvs.onpointerdown(pointer(96, 48)); h.dispatch('pointermove', pointer(48, 24));
  const second = pointer(150, 70, 2, { isPrimary: false }); cvs.onpointerdown(second);
  assert.equal(second.prevented, undefined, 'The second finger can start browser pinch zoom');
  assert.deepEqual(cropRectState(h), original); assert.equal(h.run('cropDragging'), false);
  h.dispatch('pointermove', pointer(0, 0)); assert.deepEqual(cropRectState(h), original);
});

test('tapping outside a crop leaves it intact while an actual outside drag starts a new rectangle', async () => {
  const h = harness(); h.add('Phone'); h.resources.set('blob:Phone', { width: 1000, height: 800 }); await h.open();
  await selectCrop(h, { x: 200, y: 200, w: 500, h: 400 }); const original = cropRectState(h), cvs = h.element('previewCanvas');
  cvs.onpointerdown(pointer(20, 20)); h.dispatch('pointerup', pointer(20, 20)); assert.deepEqual(cropRectState(h), original);
  cvs.onpointerdown(pointer(24, 24)); h.dispatch('pointermove', pointer(96, 72)); h.dispatch('pointerup', pointer(96, 72));
  assert.deepEqual(['cropX', 'cropY', 'cropW', 'cropH'].map(id => h.element(id).value), [50, 50, 150, 100]);
});

test('crop selection survives switching tools and handlers stop when the crop tool closes', async () => {
  const h = harness(); h.add('Phone'); await h.open(); await selectCrop(h, { x: 10, y: 20, w: 60, h: 40 });
  const original = cropRectState(h); h.run("switchEditorTab('filters')");
  assert.equal(h.element('previewCanvas').onpointerdown, null);
  assert.equal(h.documentListeners.get('pointermove').size, 0);
  h.run("switchEditorTab('crop')"); await tick(); assert.deepEqual(cropRectState(h), original);
  h.run('closeEditor()'); assert.equal(h.documentListeners.get('pointercancel').size, 0);
});

test('fractional preview axes round crop coordinates to exact valid source pixels without empty bands', async () => {
  const h = harness(); h.add('Phone'); h.resources.set('blob:Phone', { width: 1001, height: 3333 }); await h.open();
  await selectCrop(h, { x: 901, y: 3000, w: 100, h: 333 });
  assert.deepEqual(['cropX', 'cropY', 'cropW', 'cropH'].map(id => h.element(id).value), [901, 3000, 100, 333]);
  assert.equal(await h.run('applyCrop()'), true); assert.equal(await h.run('saveEdits()'), true);
  assert.deepEqual([h.encodes[0].width, h.encodes[0].height], [100, 333]);
  assert.deepEqual(h.encodes[0].calls[0].args, [901, 3000, 100, 333, 0, 0, 100, 333]);
  assert.deepEqual(h.state()[0].cropPageBounds, { width: 100, height: 333 }); assert.equal(h.state()[0].cropToBounds, true);
  assert.deepEqual(h.encodes[0].fills, []);
  const layout = JSON.parse(h.run(`JSON.stringify(computePdfLayout(images[0], {w:100,h:333},
    {pageSize:'a4',orientation:'portrait',imgFit:'contain',margin:10,dpi:300,oversize:'shrink'}))`));
  assert.ok(Math.abs(layout.page.width - 100 * 25.4 / 300) < 1e-10);
  assert.ok(Math.abs(layout.page.height - 333 * 25.4 / 300) < 1e-10);
  assert.ok(Math.abs(layout.image.x) < 1e-10); assert.ok(Math.abs(layout.image.y) < 1e-10);
  assert.ok(Math.abs(layout.image.width - layout.page.width) < 1e-10);
  assert.ok(Math.abs(layout.image.height - layout.page.height) < 1e-10);
});

test('numeric one-pixel crop on a large image encodes exactly the published source pixel', async () => {
  const h = harness(); h.add('Large'); h.resources.set('blob:Large', { width: 4800, height: 4000 }); await h.open();
  await selectCrop(h, { x: 4799, y: 3999, w: 1, h: 1 });
  assert.deepEqual(['cropX', 'cropY', 'cropW', 'cropH'].map(id => h.element(id).value), [4799, 3999, 1, 1]);
  assert.equal(await h.run('applyCrop()'), true);
  assert.deepEqual([h.encodes[0].width, h.encodes[0].height], [1, 1]);
  assert.deepEqual(h.encodes[0].calls[0].args, [4799, 3999, 1, 1, 0, 0, 1, 1]);
});

test('crop coordinates clamp negative origins and oversize dimensions to the actual source', async () => {
  const h = harness(); h.add('Phone'); await h.open(); await selectCrop(h, { x: -50, y: 75, w: 1000, h: 800 });
  assert.deepEqual(['cropX', 'cropY', 'cropW', 'cropH'].map(id => h.element(id).value), [0, 75, 100, 5]);
  assert.equal(await h.run('applyCrop()'), true);
  assert.deepEqual(h.encodes[0].calls[0].args, [0, 75, 100, 5, 0, 0, 100, 5]);
});

test('full-image crop is a no-op that keeps native PDF structure, original pixels, and history', async () => {
  const h = harness(); addPdfPage(h, 'PDF'); h.run('images[0].pdfSource={sourceId:"native",pageIndex:0}; snapshot("Import")');
  const before = h.state(), historyLength = h.run('history.length'); await h.open(); h.run("switchEditorTab('crop')"); await tick();
  assert.equal(await h.run('applyCrop()'), true); assert.equal(await h.run('saveEdits()'), true);
  assert.deepEqual(h.state(), before); assert.equal(h.encodes.length, 0); assert.equal(h.run('history.length'), historyLength);
});

test('repeated crop Apply starts one encode and canceled crop does not change bounds in a later editor', async () => {
  const h = harness(); h.add('A'); h.add('B'); await h.open(); await selectCrop(h, { x: 10, y: 20, w: 40, h: 30 });
  const started = deferred(), gate = deferred(); h.setEncodeHook(async () => { started.resolve(); await gate.promise; });
  const first = h.run('applyCrop()'); await started.promise; assert.equal(h.run('applyCrop()'), first);
  h.run('closeEditor()'); await h.open(1); gate.resolve(); assert.equal(await first, false);
  assert.equal(h.encodes.length, 1); assert.equal(h.run('editorSession.cropPageBounds'), undefined);
  assert.equal(h.run('editorSession.cropToBounds'), undefined); assert.equal(h.run('editorCurrentSrc'), 'blob:B');
});

test('crop shrinks PDF paper bounds and Revert restores native content, paper, and uncropped page metadata', async () => {
  const h = harness(); addPdfPage(h, 'PDF'); h.run('images[0].pdfSource={sourceId:"native",pageIndex:0}; images[0].originalPdfSource={sourceId:"native",pageIndex:0}; snapshot("Import")');
  const original = h.state(); await h.open(); await selectCrop(h, { x: 100, y: 200, w: 600, h: 400 });
  await h.run('applyCrop()'); assert.equal(await h.run('saveEdits()'), true);
  const cropped = h.state()[0]; assert.deepEqual(cropped.pdfPageSizeMm, { width: 60, height: 40 });
  assert.deepEqual(cropped.cropPageBounds, { width: 600, height: 400 }); assert.equal(cropped.cropToBounds, true); assert.equal(cropped.pdfSource, undefined);
  await h.open(); h.run('revertAll()'); assert.equal(await h.run('saveEdits()'), true);
  const restored = h.state()[0]; assert.equal(restored.src, 'blob:PDF'); assert.deepEqual(restored.pdfPageSizeMm, { width: 210, height: 297 });
  assert.deepEqual(restored.pdfSource, { sourceId: 'native', pageIndex: 0 }); assert.equal(restored.cropPageBounds, undefined); assert.equal(restored.cropToBounds, undefined);
  h.run('undo()'); assert.deepEqual(h.state()[0], cropped); h.run('undo()'); assert.deepEqual(h.state(), original);
});

test('cropped page metadata follows resize and rotation while bulk changes retain each page’s own bounds choice', async () => {
  const h = harness(); h.add('A'); h.add('B');
  h.run('images[1].cropPageBounds={width:100,height:80}; images[1].cropToBounds=false; snapshot("Import")');
  await h.open(); await selectCrop(h, { x: 10, y: 20, w: 60, h: 40 }); await h.run('applyCrop()');
  h.element('resW').value = 30; h.element('resH').value = 20; await h.run('applyResize()'); h.run('quickRotate(90)');
  assert.equal(await h.run('saveEdits(true)'), true);
  assert.deepEqual(h.state()[0].cropPageBounds, { width: 20, height: 30 }); assert.equal(h.state()[0].cropToBounds, true);
  assert.deepEqual(h.state()[1].cropPageBounds, { width: 80, height: 100 }); assert.equal(h.state()[1].cropToBounds, false);
});

test('reopening a cropped page retains its explicit fixed-paper choice until a new crop or Revert', async () => {
  const h = harness(); h.add('A'); await h.open(); await selectCrop(h, { x: 10, y: 20, w: 60, h: 40 });
  await h.run('applyCrop()'); await h.run('saveEdits()'); h.run('images[0].cropToBounds=false; snapshot("Paper choice")');
  const before = h.state(); await h.open(); assert.equal(h.run('editorSession.cropToBounds'), false);
  assert.equal(await h.run('saveEdits()'), true); assert.deepEqual(h.state(), before);
  await h.open(); await selectCrop(h, { x: 0, y: 0, w: 30, h: 20 }); await h.run('applyCrop()'); await h.run('saveEdits()');
  assert.equal(h.state()[0].cropToBounds, true); assert.deepEqual(h.state()[0].cropPageBounds, { width: 30, height: 20 });
});

test('legacy touch crop fallback tracks one finger and cancels cleanly when another finger arrives', async () => {
  const h = harness(); delete h.context.window.PointerEvent; h.add('Phone'); h.resources.set('blob:Phone', { width: 1000, height: 800 }); await h.open();
  await selectCrop(h, { x: 200, y: 100, w: 600, h: 500 }); const original = cropRectState(h), cvs = h.element('previewCanvas');
  const touch = (x, y) => ({ identifier: 11, clientX: x, clientY: y });
  cvs.ontouchstart({ touches: [touch(96, 48)], preventDefault() {} });
  h.dispatch('touchmove', { touches: [touch(48, 24)], preventDefault() {} }); assert.notDeepEqual(cropRectState(h), original);
  h.dispatch('touchmove', { touches: [touch(48, 24), { identifier: 12, clientX: 80, clientY: 60 }], preventDefault() {} });
  assert.deepEqual(cropRectState(h), original); assert.equal(h.run('cropDragging'), false);
});

test('legacy crop touchcancel restores the selection and fields without applying the canceled movement', async () => {
  const h = harness(); delete h.context.window.PointerEvent; h.add('Phone'); h.resources.set('blob:Phone', { width: 1000, height: 800 }); await h.open();
  await selectCrop(h, { x: 200, y: 100, w: 600, h: 500 });
  const original = cropRectState(h), cvs = h.element('previewCanvas');
  const touch = (x, y) => ({ identifier: 11, clientX: x, clientY: y });
  cvs.ontouchstart({ touches: [touch(96, 48)], preventDefault() {} });
  h.dispatch('touchmove', { touches: [touch(48, 24)], preventDefault() {} });
  assert.notDeepEqual(cropRectState(h), original);
  h.dispatch('touchcancel', { touches: [], changedTouches: [touch(48, 24)] });
  assert.deepEqual(cropRectState(h), original); assert.equal(h.run('cropDragging'), false);
  assert.deepEqual(['cropX', 'cropY', 'cropW', 'cropH'].map(id => h.element(id).value), [200, 100, 600, 500]);
  h.dispatch('touchend', { touches: [], changedTouches: [touch(48, 24)] });
  assert.deepEqual(cropRectState(h), original); assert.equal(h.encodes.length, 0);
});

test('cropping a pending quarter-turn PDF trims physical content bounds before baking that rotation once', async () => {
  const h = harness(); addPdfPage(h, 'PDF');
  h.run('images[0].pdfSource={sourceId:"native",pageIndex:0}; images[0].originalPdfSource={sourceId:"native",pageIndex:0}; images[0].rotation=90; snapshot("Import")');
  await h.open(); await selectCrop(h, { x: 10, y: 20, w: 600, h: 400 }); await h.run('applyCrop()');
  const croppedSource = h.run('editorCurrentSrc'); assert.equal(await h.run('saveEdits()'), true);
  assert.deepEqual(h.encodes.map(record => [record.width, record.height]), [[600, 400], [400, 600]]);
  assert.equal(h.encodes[1].calls[0].src, croppedSource); assert.equal(h.encodes[1].rotations[0], Math.PI / 2);
  assert.deepEqual(h.state()[0].pdfPageSizeMm, { width: 40, height: 60 });
  assert.deepEqual(h.state()[0].cropPageBounds, { width: 400, height: 600 }); assert.equal(h.state()[0].rotation, 0);
  const layout = JSON.parse(h.run(`JSON.stringify(computePdfLayout(images[0], {w:400,h:600},
    {pageSize:'a4',orientation:'landscape',imgFit:'contain',margin:10,dpi:300,oversize:'shrink'}))`));
  assert.deepEqual(layout.page, { width: 40, height: 60, orientation: 'p' });
  assert.deepEqual(layout.image, { x: 0, y: 0, width: 40, height: 60 });
});
