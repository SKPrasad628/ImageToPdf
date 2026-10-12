const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const previewSource = fs.readFileSync(path.join(__dirname, '../js/forge-preview.js'), 'utf8');
const layoutSource = fs.readFileSync(path.join(__dirname, '../js/pdf-layout.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  const elements = new Map(), pending = [], leases = new Map(), frames = new Map();
  const windowEvents = new Map();
  let frameId = 0;
  const calls = [], filtersUsed = [], captures = [], releasedCaptures = [];
  const context2d = {};
  for (const name of ['fillRect', 'save', 'restore', 'scale', 'beginPath', 'rect', 'clip', 'translate', 'rotate', 'drawImage']) {
    context2d[name] = (...args) => {
      if (name === 'drawImage') filtersUsed.push(context2d.filter);
      calls.push([name, ...args]);
    };
  }
  function element(id) {
    const classes = new Set(), events = new Map();
    const result = { id, hidden: false, disabled: false, textContent: '', attributes: {},
      clientWidth: id === 'forgePreviewStage' ? 400 : 300,
      clientHeight: id === 'forgePreviewStage' ? 500 : 424,
      scrollLeft: 0, scrollTop: 0,
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); return on; }
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name] ?? null; },
      addEventListener(name, callback) { events.set(name, callback); },
      fire(name, extra = {}) {
        const event = { target: this, preventDefault() {}, stopPropagation() {}, ...extra };
        events.get(name)?.(event);
      },
      getBoundingClientRect() {
        const width = parseFloat(this.style.width) || this.clientWidth;
        const [paperWidth, paperHeight] = (this.style.aspectRatio || '210 / 297').split('/').map(Number);
        const height = id === 'forgePaper' ? width * paperHeight / paperWidth : parseFloat(this.style.height) || this.clientHeight;
        return { width, height, left: 0, top: 0, right: width, bottom: height };
      },
      scrollTo(options) { this.scrollLeft = options.left || 0; this.scrollTop = options.top || 0; },
      setPointerCapture(pointerId) { captures.push(pointerId); },
      releasePointerCapture(pointerId) { releasedCaptures.push(pointerId); }, focus() {}
    };
    Object.defineProperties(result, {
      scrollWidth: { get() { return Math.max(this.clientWidth, parseFloat(elements.get('forgePaper')?.style.width) || 300); } },
      scrollHeight: { get() { return Math.max(this.clientHeight, parseFloat(elements.get('forgePaper')?.style.height) || 424); } }
    });
    elements.set(id, result);
    return result;
  }
  const canvas = element('forgePreviewCanvas');
  canvas.width = 0; canvas.height = 0;
  canvas.getContext = () => context2d;
  for (const id of ['forgePaper', 'forgePreviewEmpty', 'forgeDimensions', 'forgePreviewLabel', 'forgePlacementNote',
    'forgePreviewStage', 'previewZoomLabel', 'previewZoomIn', 'previewZoomOut', 'previewZoomFit']) element(id);
  const settings = { pageSize: 'a4', orientation: 'portrait', imgFit: 'contain', margin: '10',
    printDpi: '300', oversize: 'shrink', pdfContentMode: 'preserve', ...options.settings };
  for (const [id, value] of Object.entries(settings)) element(id).value = value;
  const first = { _id: 'a', _pageId: 'a', name: 'First image.png', src: 'blob:a', rotation: 0, ...options.image };
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id) || null },
    window: {
      requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
      cancelAnimationFrame(id) { frames.delete(id); },
      addEventListener(name, callback) { windowEvents.set(name, callback); }
    },
    images: options.images || [first], selectedConvertCard: null, preserveOriginalQuality: !!options.preserve,
    buildFilterStringFrom: filters => `brightness(${filters.brightness}%)`,
    pageIdentity: image => image._pageId || image._id,
    loadImage(src) { return new Promise((resolve, reject) => pending.push({ src, resolve, reject })); },
    retainUrl(src) { leases.set(src, (leases.get(src) || 0) + 1); },
    releaseUrl(src) {
      const next = (leases.get(src) || 0) - 1;
      assert.ok(next >= 0, 'source lease released more than retained');
      if (next) leases.set(src, next); else leases.delete(src);
    }
  });
  vm.runInContext(layoutSource + '\n' + previewSource, context);
  return { context, elements, canvas, calls, filtersUsed, captures, releasedCaptures, pending, leases, frames, windowEvents,
    api: context.window.PageForgePreview,
    flush() { const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback()); },
    resolve(index = 0, width = 4000, height = 1000) {
      const item = pending[index];
      assert.ok(item, 'missing image decode');
      item.resolve({ src: item.src, naturalWidth: width, naturalHeight: height });
    },
    setting(name, value) { elements.get(name).value = value; }
  };
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `expected ${expected}; got ${actual}`);
}

test('preview uses export placement, white paper, physical dimensions, and a bounded canvas', async () => {
  const h = harness(); h.flush(); h.resolve(); await settle();
  assert.equal(h.canvas.width, 848); assert.equal(h.canvas.height, 1200);
  assert.equal(h.canvas.hidden, false);
  assert.deepEqual(h.calls.find(call => call[0] === 'fillRect'), ['fillRect', 0, 0, 848, 1200]);
  assert.deepEqual(h.calls.find(call => call[0] === 'translate'), ['translate', 105, 148.5]);
  const scales = h.calls.filter(call => call[0] === 'scale');
  close(scales[1][1], 190 / 4000); close(scales[1][2], 47.5 / 1000);
  assert.equal(h.elements.get('forgeDimensions').textContent, '210 × 297 mm');
  assert.match(h.elements.get('forgePlacementNote').textContent, /Contain · 10 mm margins.*full image/);
  assert.equal(h.leases.size, 0);
});

test('Fill and print-size crop use the same margin clipping box as export', async () => {
  for (const imgFit of ['fill', 'actual']) {
    const h = harness({ settings: { imgFit, printDpi: '72', oversize: 'crop' } });
    h.flush(); h.resolve(); await settle();
    assert.deepEqual(h.calls.find(call => call[0] === 'rect'), ['rect', 10, 10, 190, 277]);
    assert.equal(h.calls.filter(call => call[0] === 'clip').length, 1);
    assert.match(h.elements.get('forgePlacementNote').textContent, /Content is cropped within the margins/);
  }
});

test('oversized print content scales down without cropping when Shrink is selected', async () => {
  const h = harness({ settings: { imgFit: 'actual', printDpi: '72', oversize: 'shrink' } });
  h.flush(); h.resolve(); await settle();
  assert.equal(h.calls.some(call => call[0] === 'clip'), false);
  assert.match(h.elements.get('forgePlacementNote').textContent, /scaled down/);
  assert.match(h.elements.get('forgePlacementNote').textContent, /72 DPI/);
});

test('rotation and flips are applied in the same order and dimensions as export', async () => {
  const h = harness({ image: { rotation: 90, flipH: true, flipV: true } });
  h.flush(); h.resolve(0, 640, 480); await settle();
  const transforms = h.calls.filter(call => ['translate', 'scale', 'rotate'].includes(call[0]));
  assert.deepEqual(transforms.map(call => call[0]), ['scale', 'translate', 'scale', 'rotate', 'scale']);
  close(transforms[2][1], 190 / 480); close(transforms[2][2], (190 * 640 / 480) / 640);
  close(transforms[3][1], Math.PI / 2);
  assert.deepEqual(transforms[4], ['scale', -1, -1]);
});

test('preserved PDF pages use their saved dimensions and rotation regardless of image settings', async () => {
  const h = harness({ image: { rotation: 90, pdfSource: { sourceId: 'pdf', pageIndex: 0 },
    pdfPageSizeMm: { width: 210, height: 297 } },
    settings: { pageSize: 'letter', orientation: 'portrait', imgFit: 'fill', margin: '30', printDpi: '1' } });
  h.context.computePdfLayout = () => { throw new Error('Native pages must not use the image layout'); };
  h.flush(); h.resolve(0, 1191, 1684); await settle();
  assert.equal(h.canvas.width, 1200); assert.equal(h.canvas.height, 848);
  assert.equal(h.elements.get('forgeDimensions').textContent, '297 × 210 mm');
  assert.equal(h.calls.some(call => call[0] === 'clip'), false);
  assert.match(h.elements.get('forgePlacementNote').textContent, /Native PDF page.*raster preview/);
});

test('Images mode lays out a former native page through the normal image exporter geometry', async () => {
  const h = harness({ image: { pdfSource: { sourceId: 'pdf', pageIndex: 0 }, pdfPageSizeMm: { width: 210, height: 297 } },
    settings: { pageSize: 'letter', pdfContentMode: 'images' } });
  h.flush(); h.resolve(0, 1191, 1684); await settle();
  assert.equal(h.elements.get('forgeDimensions').textContent, '215.9 × 279.4 mm');
  assert.match(h.elements.get('forgePlacementNote').textContent, /LETTER · Contain/);
});

test('a late selection decode cannot replace the latest page', async () => {
  const h = harness(); h.flush();
  h.context.images.push({ _pageId: 'b', name: 'Second image.png', src: 'blob:b', rotation: 0 });
  h.context.selectedConvertCard = 1; h.api.refresh(); h.flush();
  h.resolve(1); await settle(); h.resolve(0); await settle();
  assert.deepEqual(h.calls.filter(call => call[0] === 'drawImage').map(call => call[1].src), ['blob:b']);
  assert.match(h.elements.get('forgePreviewLabel').textContent, /Page 2 of 2 · Second image/);
  assert.equal(h.leases.size, 0);
});

test('clearing during decode frees the canvas and prevents stale pixels and text', async () => {
  const h = harness(); h.flush();
  assert.equal(h.leases.get('blob:a'), 1);
  h.api.clear(); h.resolve(); await settle();
  assert.equal(h.canvas.width, 0); assert.equal(h.canvas.height, 0);
  assert.equal(h.canvas.hidden, true);
  assert.equal(h.calls.some(call => call[0] === 'drawImage'), false);
  assert.match(h.elements.get('forgePreviewEmpty').textContent, /Add images/);
  assert.equal(h.leases.size, 0);
});

test('returning to a completed page while a different page is loading restores its preview', async () => {
  const h = harness({ images: [
    { _pageId: 'a', name: 'First image.png', src: 'blob:a', rotation: 0 },
    { _pageId: 'b', name: 'Second image.png', src: 'blob:b', rotation: 0 }
  ] });
  h.flush(); h.resolve(0); await settle();
  assert.equal(h.canvas.hidden, false);
  h.context.selectedConvertCard = 1; h.api.refresh(); h.flush();
  assert.equal(h.canvas.hidden, true);
  h.context.selectedConvertCard = 0; h.api.refresh(); h.flush();
  h.resolve(2); await settle();
  assert.equal(h.canvas.hidden, false);
  assert.equal(h.elements.get('forgePaper').attributes['aria-busy'], 'false');
  assert.equal(h.elements.get('forgePreviewEmpty').hidden, true);
  assert.match(h.elements.get('forgePreviewLabel').textContent, /Page 1 of 2 · First image/);
  h.resolve(1); await settle();
  assert.deepEqual(h.calls.filter(call => call[0] === 'drawImage').map(call => call[1].src), ['blob:a', 'blob:a']);
  assert.equal(h.leases.size, 0);
});

test('removed pages cannot paint even when their removal has not refreshed the view yet', async () => {
  const h = harness(); h.flush(); h.context.images = []; h.resolve(); await settle();
  assert.equal(h.calls.some(call => call[0] === 'drawImage'), false);
  assert.equal(h.leases.size, 0);
});

test('decoding errors clear stale canvas data and report a readable error', async () => {
  const h = harness(); h.flush(); h.resolve(); await settle();
  h.context.images[0].src = 'blob:bad'; h.api.refresh(); h.flush();
  h.pending[1].reject(new Error('Image failed to decode')); await settle();
  assert.equal(h.canvas.hidden, true); assert.equal(h.canvas.width, 0);
  assert.equal(h.elements.get('forgePreviewEmpty').textContent, 'Preview unavailable');
  assert.equal(h.elements.get('forgePlacementNote').textContent, 'Image failed to decode');
  assert.equal(h.leases.size, 0);
});

test('invalid layout values report export validation errors instead of a misleading preview', async () => {
  const h = harness({ settings: { imgFit: 'actual', printDpi: '0' } });
  h.flush(); h.resolve(); await settle();
  assert.equal(h.canvas.hidden, true);
  assert.match(h.elements.get('forgePlacementNote').textContent, /DPI between 1 and 2400/);
  assert.equal(h.leases.size, 0);
});

test('refresh calls in one frame coalesce and a completed unchanged view does not decode again', async () => {
  const h = harness(); h.api.refresh(); h.api.refresh();
  assert.equal(h.frames.size, 1); h.flush();
  assert.equal(h.pending.length, 1); h.resolve(); await settle();
  h.api.refresh(); h.flush(); await settle();
  assert.equal(h.pending.length, 1);
});

async function renderChange(h, change = () => {}) {
  const before = h.pending.length;
  change(); h.flush();
  if (h.pending.length > before) h.resolve(h.pending.length - 1);
  await settle();
}

function wheel(stage, extra = {}) {
  const result = { prevented: false, stopped: false };
  stage.fire('wheel', { deltaX: 0, deltaY: -100, ...extra,
    preventDefault() { result.prevented = true; }, stopPropagation() { result.stopped = true; } });
  return result;
}

test('zoom sharpens a bounded canvas without changing export geometry, filters, or document state', async () => {
  const h = harness({ image: { rotation: 90, flipH: true, filters: { brightness: 115 } },
    settings: { imgFit: 'fill' }, preserve: true });
  h.context.documentRevision = 42; h.context.historyIndex = 1; h.context.history = ['original', 'current'];
  const document = plain(h.context.images), history = plain(h.context.history);
  const settings = Object.fromEntries(['pageSize', 'orientation', 'imgFit', 'margin', 'printDpi', 'oversize', 'pdfContentMode']
    .map(id => [id, h.elements.get(id).value]));
  h.flush(); h.resolve(); await settle();
  const dimensions = h.elements.get('forgeDimensions').textContent;
  const transforms = h.calls.filter(call => ['scale', 'translate', 'rotate'].includes(call[0])).slice(1);
  const start = h.calls.length;
  await renderChange(h, () => h.api.zoom(2));
  assert.equal(h.canvas.height, 2400); assert.equal(h.canvas.width, 1697);
  assert.equal(h.elements.get('previewZoomLabel').textContent, '200%');
  assert.deepEqual(h.calls.slice(start).filter(call => ['scale', 'translate', 'rotate'].includes(call[0])).slice(1), transforms);
  assert.deepEqual(h.calls.slice(start).find(call => call[0] === 'rect'), ['rect', 10, 10, 190, 277]);
  assert.deepEqual(h.filtersUsed, ['brightness(115%)', 'brightness(115%)']);
  assert.equal(h.elements.get('forgeDimensions').textContent, dimensions);
  const decodes = h.pending.length;
  await renderChange(h, () => h.api.zoom(4));
  assert.equal(h.canvas.height, 2400); assert.equal(h.pending.length, decodes, 'The sharp preview must remain bounded at 4×');
  assert.equal(h.elements.get('previewZoomLabel').textContent, '400%');
  assert.deepEqual(plain(h.context.images), document); assert.deepEqual(plain(h.context.history), history);
  assert.equal(h.context.documentRevision, 42); assert.equal(h.context.historyIndex, 1);
  assert.deepEqual(Object.fromEntries(Object.keys(settings).map(id => [id, h.elements.get(id).value])), settings);
  assert.equal(h.leases.size, 0);
});

test('zoom steps and numeric inputs stay between Fit page and 400%, and Fit clears both pan axes', async () => {
  const h = harness(); h.flush(); h.resolve(); await settle();
  const stage = h.elements.get('forgePreviewStage'), paper = h.elements.get('forgePaper');
  assert.equal(h.elements.get('previewZoomOut').disabled, true);
  for (const percent of ['125%', '150%', '200%', '300%', '400%']) {
    await renderChange(h, () => h.api.zoomIn());
    assert.equal(h.elements.get('previewZoomLabel').textContent, percent);
  }
  assert.equal(h.elements.get('previewZoomIn').disabled, true);
  const decodes = h.pending.length;
  h.api.zoomIn(); h.api.zoom(100); h.api.zoom(NaN); h.api.zoom(Infinity); h.flush(); await settle();
  assert.equal(h.elements.get('previewZoomLabel').textContent, '400%');
  assert.equal(h.pending.length, decodes);
  await renderChange(h, () => h.api.zoomOut());
  assert.equal(h.elements.get('previewZoomLabel').textContent, '300%');
  stage.scrollLeft = 333; stage.scrollTop = 444;
  await renderChange(h, () => h.api.fit());
  assert.equal(stage.scrollLeft, 0); assert.equal(stage.scrollTop, 0);
  assert.equal(stage.classList.contains('is-zoomed'), false); assert.equal(paper.style.width, '');
  assert.equal(h.elements.get('previewZoomLabel').textContent, '100%');
  assert.equal(h.elements.get('previewZoomOut').disabled, true); assert.equal(h.elements.get('previewZoomFit').disabled, true);
  assert.equal(h.canvas.height, 1200);
  h.api.zoomOut(); h.api.zoom(-10); h.flush(); await settle();
  assert.equal(h.elements.get('previewZoomLabel').textContent, '100%');
  await renderChange(h, () => h.api.zoom(1.25));
  stage.scrollLeft = 100; stage.scrollTop = 200;
  await renderChange(h, () => h.api.zoom(1.004));
  assert.equal(h.elements.get('previewZoomLabel').textContent, '100%');
  assert.equal(stage.classList.contains('is-zoomed'), false, 'A displayed 100% must actually use Fit page');
  assert.equal(stage.scrollLeft, 0); assert.equal(stage.scrollTop, 0);
});

test('same-page refresh preserves zoom but new selection and changed layout return to Fit page', async () => {
  const h = harness(); h.flush(); h.resolve(); await settle();
  await renderChange(h, () => h.api.zoom(1.5));
  const decodes = h.pending.length;
  h.api.refresh(); h.flush(); await settle();
  assert.equal(h.elements.get('previewZoomLabel').textContent, '150%'); assert.equal(h.pending.length, decodes);
  h.context.images.push({ _pageId: 'b', name: 'Second image.png', src: 'blob:b', rotation: 0 });
  h.context.selectedConvertCard = 1; h.api.refresh(); h.flush();
  assert.equal(h.elements.get('previewZoomLabel').textContent, '100%'); assert.equal(h.canvas.hidden, true);
  h.api.zoomIn(); assert.equal(h.elements.get('previewZoomLabel').textContent, '100%', 'An unpainted page cannot reuse the last page zoom');
  h.resolve(h.pending.length - 1); await settle();
  await renderChange(h, () => h.api.zoom(2));
  h.setting('margin', '20'); h.api.refresh(); h.flush();
  assert.equal(h.elements.get('previewZoomLabel').textContent, '100%');
  h.resolve(h.pending.length - 1); await settle();
  assert.match(h.elements.get('forgePlacementNote').textContent, /20 mm margins/);
  assert.equal(h.canvas.height, 1200); assert.equal(h.leases.size, 0);
});

test('Fit during a sharper decode preserves the finished paper and blocks the late zoom render', async () => {
  for (const outcome of ['success', 'failure']) {
    const h = harness(); h.flush(); h.resolve(); await settle();
    h.api.zoom(2); h.flush();
    assert.equal(h.canvas.hidden, false); assert.equal(h.canvas.height, 1200);
    assert.equal(h.elements.get('previewZoomOut').disabled, false, 'Fit and zoom controls stay usable while detail loads');
    assert.equal(h.leases.get('blob:a'), 1);
    h.api.fit(); h.flush(); await settle();
    assert.equal(h.elements.get('previewZoomLabel').textContent, '100%');
    assert.equal(h.elements.get('forgePaper').attributes['aria-busy'], 'false');
    if (outcome === 'success') h.resolve(1);
    else h.pending[1].reject(new Error('Superseded zoom decode failed'));
    await settle();
    assert.equal(h.canvas.hidden, false); assert.equal(h.canvas.height, 1200);
    assert.equal(h.calls.filter(call => call[0] === 'drawImage').length, 1); assert.equal(h.leases.size, 0);
  }
});

test('layout change during a sharper decode paints only the new fitted geometry', async () => {
  const h = harness(); h.flush(); h.resolve(); await settle();
  h.api.zoom(2); h.flush();
  h.setting('orientation', 'landscape'); h.api.refresh(); h.flush();
  h.resolve(2); await settle(); h.resolve(1); await settle();
  assert.equal(h.canvas.width, 1200); assert.equal(h.canvas.height, 848);
  assert.equal(h.elements.get('previewZoomLabel').textContent, '100%');
  assert.equal(h.elements.get('forgeDimensions').textContent, '297 × 210 mm');
  assert.equal(h.calls.filter(call => call[0] === 'drawImage').length, 2);
  assert.equal(h.leases.size, 0);
});

test('native PDF zoom retains saved paper dimensions and page transforms', async () => {
  const h = harness({ image: { rotation: 90, pdfSource: { sourceId: 'pdf', pageIndex: 0 },
    pdfPageSizeMm: { width: 210, height: 297 } }, settings: { pageSize: 'letter', margin: '30' } });
  h.context.computePdfLayout = () => { throw new Error('Zoom must preserve native PDF geometry'); };
  h.flush(); h.resolve(0, 1191, 1684); await settle();
  h.api.zoom(2); h.flush(); h.resolve(1, 1191, 1684); await settle();
  assert.equal(h.canvas.width, 2400); assert.equal(h.canvas.height, 1697);
  assert.equal(h.elements.get('forgeDimensions').textContent, '297 × 210 mm');
  assert.equal(h.calls.some(call => call[0] === 'clip'), false);
  assert.equal(h.leases.size, 0);
});

test('zoomed arrow keys pan locally without changing pages and ignore browser modifier shortcuts', async () => {
  const h = harness(); h.flush(); h.resolve(); await settle(); await renderChange(h, () => h.api.zoom(2));
  const stage = h.elements.get('forgePreviewStage'); stage.scrollLeft = 100; stage.scrollTop = 100;
  const document = plain(h.context.images);
  for (const [key, left, top] of [['ArrowRight', 164, 100], ['ArrowDown', 164, 164], ['ArrowLeft', 100, 164], ['ArrowUp', 100, 100]]) {
    let prevented = false, stopped = false;
    stage.fire('keydown', { key, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    assert.equal(prevented, true); assert.equal(stopped, true);
    assert.equal(stage.scrollLeft, left); assert.equal(stage.scrollTop, top);
  }
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    let prevented = false, stopped = false;
    stage.fire('keydown', { key: 'ArrowRight', [modifier]: true,
      preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    assert.equal(prevented, false); assert.equal(stopped, false); assert.equal(stage.scrollLeft, 100);
  }
  await renderChange(h, () => stage.fire('keydown', { key: '0' }));
  assert.equal(h.elements.get('previewZoomLabel').textContent, '100%');
  let prevented = false, stopped = false;
  stage.fire('keydown', { key: 'ArrowRight', preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented, false); assert.equal(stopped, false);
  assert.deepEqual(plain(h.context.images), document); assert.equal(h.context.selectedConvertCard, null);
});

test('pointer cancellation ends mouse panning and touch gestures stay native', async () => {
  const h = harness(); h.flush(); h.resolve(); await settle(); await renderChange(h, () => h.api.zoom(2));
  const stage = h.elements.get('forgePreviewStage'); stage.scrollLeft = 100; stage.scrollTop = 200;
  stage.fire('pointerdown', { pointerId: 7, pointerType: 'mouse', button: 0, clientX: 50, clientY: 60 });
  stage.fire('pointermove', { pointerId: 7, clientX: 20, clientY: 10 });
  assert.equal(stage.scrollLeft, 130); assert.equal(stage.scrollTop, 250);
  assert.equal(stage.classList.contains('is-panning'), true); assert.deepEqual(h.captures, [7]);
  stage.fire('pointercancel', { pointerId: 7 });
  assert.equal(stage.classList.contains('is-panning'), false); assert.deepEqual(h.releasedCaptures, [7]);
  stage.fire('pointermove', { pointerId: 7, clientX: 0, clientY: 0 });
  assert.equal(stage.scrollLeft, 130); assert.equal(stage.scrollTop, 250);
  let prevented = false;
  stage.fire('pointerdown', { pointerId: 8, pointerType: 'touch', button: 0, clientX: 50, clientY: 60,
    preventDefault() { prevented = true; } });
  assert.equal(prevented, false); assert.deepEqual(h.captures, [7]);
});

test('normal wheel zooms an enlarged page, returns to native webpage scrolling at Fit, and stays bounded', async () => {
  const h = harness(); h.flush(); h.resolve(); await settle();
  const stage = h.elements.get('forgePreviewStage'), document = plain(h.context.images);
  assert.deepEqual(wheel(stage), { prevented: false, stopped: false });
  assert.deepEqual(wheel(stage, { deltaY: 100 }), { prevented: false, stopped: false });
  assert.equal(h.elements.get('previewZoomLabel').textContent, '100%');
  await renderChange(h, () => h.api.zoomIn());
  let gesture;
  await renderChange(h, () => { gesture = wheel(stage); });
  assert.equal(gesture.prevented, true); assert.equal(h.elements.get('previewZoomLabel').textContent, '138%');
  assert.equal(h.canvas.height, 1656);
  await renderChange(h, () => { gesture = wheel(stage, { deltaY: 100 }); });
  assert.equal(gesture.prevented, true); assert.equal(h.elements.get('previewZoomLabel').textContent, '125%');
  await renderChange(h, () => h.api.zoom(4));
  const decodes = h.pending.length;
  assert.equal(wheel(stage).prevented, true); h.flush(); await settle();
  assert.equal(h.elements.get('previewZoomLabel').textContent, '400%');
  assert.equal(h.canvas.height, 2400); assert.equal(h.pending.length, decodes);
  await renderChange(h, () => h.api.zoom(1.01));
  await renderChange(h, () => { gesture = wheel(stage, { deltaY: 100 }); });
  assert.equal(gesture.prevented, true, 'The wheel event that reaches Fit still belongs to the preview');
  assert.equal(h.elements.get('previewZoomLabel').textContent, '100%');
  assert.equal(stage.classList.contains('is-zoomed'), false);
  assert.deepEqual(wheel(stage, { deltaY: 100 }), { prevented: false, stopped: false });
  await renderChange(h, () => { gesture = wheel(stage, { ctrlKey: true }); });
  assert.equal(gesture.prevented, true); assert.equal(h.elements.get('previewZoomLabel').textContent, '110%');
  assert.equal(h.canvas.height, 1320);
  stage.scrollLeft = 120; stage.scrollTop = 180;
  await renderChange(h, () => h.windowEvents.get('resize')());
  assert.equal(h.elements.get('previewZoomLabel').textContent, '100%');
  assert.equal(stage.scrollLeft, 0); assert.equal(stage.scrollTop, 0); assert.equal(h.canvas.height, 1200);
  assert.deepEqual(plain(h.context.images), document); assert.equal(h.context.selectedConvertCard, null);
  assert.equal(h.leases.size, 0);
});

test('zero, horizontal, and modifier wheel gestures remain native while a page is enlarged', async () => {
  const h = harness(); h.flush(); h.resolve(); await settle(); await renderChange(h, () => h.api.zoom(2));
  const stage = h.elements.get('forgePreviewStage'), decodes = h.pending.length;
  for (const gesture of [
    { deltaY: 0 }, { deltaY: 0, deltaX: 100 }, { deltaX: -150, deltaY: 20 },
    { deltaX: 150, deltaY: -20, ctrlKey: true }, { shiftKey: true }, { shiftKey: true, ctrlKey: true },
    { altKey: true }, { metaKey: true }, { altKey: true, ctrlKey: true }, { metaKey: true, ctrlKey: true }
  ]) assert.deepEqual(wheel(stage, gesture), { prevented: false, stopped: false });
  h.flush(); await settle();
  assert.equal(h.elements.get('previewZoomLabel').textContent, '200%');
  assert.equal(h.pending.length, decodes);
});

test('wheel ignores unready pages but remains usable during a same-page sharper render', async () => {
  const h = harness(), stage = h.elements.get('forgePreviewStage');
  for (const ctrlKey of [false, true]) assert.deepEqual(wheel(stage, { ctrlKey }), { prevented: false, stopped: false });
  h.flush();
  for (const ctrlKey of [false, true]) assert.deepEqual(wheel(stage, { ctrlKey }), { prevented: false, stopped: false });
  h.resolve(); await settle(); await renderChange(h, () => h.api.zoom(1.25));
  assert.equal(wheel(stage).prevented, true); h.flush();
  assert.equal(h.elements.get('previewZoomLabel').textContent, '138%');
  assert.equal(h.canvas.hidden, false);
  assert.equal(wheel(stage, { deltaY: 100 }).prevented, true); h.flush(); await settle();
  assert.equal(h.elements.get('previewZoomLabel').textContent, '125%');
  assert.equal(h.elements.get('forgePaper').attributes['aria-busy'], 'false');
  h.resolve(2); await settle();
  assert.equal(h.canvas.height, 1500); assert.equal(h.leases.size, 0);
  h.context.images.push({ _pageId: 'b', name: 'Second image.png', src: 'blob:b', rotation: 0 });
  h.context.selectedConvertCard = 1; h.api.refresh();
  for (const ctrlKey of [false, true]) assert.deepEqual(wheel(stage, { ctrlKey }), { prevented: false, stopped: false },
    'A stale visible canvas must not consume scrolling before the selected page refreshes');
  h.flush();
  for (const ctrlKey of [false, true]) assert.deepEqual(wheel(stage, { ctrlKey }), { prevented: false, stopped: false });
  h.resolve(h.pending.length - 1); await settle(); h.api.clear();
  for (const ctrlKey of [false, true]) assert.deepEqual(wheel(stage, { ctrlKey }), { prevented: false, stopped: false });
  assert.equal(h.leases.size, 0);
});

test('clearing or failed zoom decoding resets controls, pans, and leases without stale pixels', async () => {
  for (const outcome of ['clear', 'failure']) {
    const h = harness(); h.flush(); h.resolve(); await settle();
    h.api.zoom(2); h.flush(); const stage = h.elements.get('forgePreviewStage');
    stage.scrollLeft = 100; stage.scrollTop = 200;
    stage.fire('pointerdown', { pointerId: 77, pointerType: 'pen', button: 0, clientX: 50, clientY: 60 });
    if (outcome === 'clear') { h.api.clear(); h.resolve(1); }
    else h.pending[1].reject(new Error('Zoom decode failed'));
    await settle();
    assert.equal(h.elements.get('previewZoomLabel').textContent, '100%');
    assert.equal(h.canvas.hidden, true); assert.equal(h.canvas.width, 0); assert.equal(h.canvas.height, 0);
    assert.equal(stage.scrollLeft, 0); assert.equal(stage.scrollTop, 0);
    assert.equal(stage.classList.contains('is-panning'), false); assert.deepEqual(h.releasedCaptures, [77]);
    for (const id of ['previewZoomIn', 'previewZoomOut', 'previewZoomFit']) assert.equal(h.elements.get(id).disabled, true);
    for (const ctrlKey of [false, true]) assert.deepEqual(wheel(stage, { ctrlKey }), { prevented: false, stopped: false });
    assert.equal(h.calls.filter(call => call[0] === 'drawImage').length, 1); assert.equal(h.leases.size, 0);
  }
});
