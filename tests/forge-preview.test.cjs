const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const previewSource = fs.readFileSync(path.join(__dirname, '../js/forge-preview.js'), 'utf8');
const layoutSource = fs.readFileSync(path.join(__dirname, '../js/pdf-layout.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const elements = new Map(), pending = [], leases = new Map(), frames = new Map();
  let frameId = 0;
  const calls = [];
  const context2d = {};
  for (const name of ['fillRect', 'save', 'restore', 'scale', 'beginPath', 'rect', 'clip', 'translate', 'rotate', 'drawImage']) {
    context2d[name] = (...args) => calls.push([name, ...args]);
  }
  function element(id) {
    const result = { hidden: false, textContent: '', attributes: {},
      style: { setProperty(name, value) { this[name] = value; } },
      setAttribute(name, value) { this.attributes[name] = value; } };
    elements.set(id, result);
    return result;
  }
  const canvas = element('forgePreviewCanvas');
  canvas.width = 0; canvas.height = 0;
  canvas.getContext = () => context2d;
  for (const id of ['forgePaper', 'forgePreviewEmpty', 'forgeDimensions', 'forgePreviewLabel', 'forgePlacementNote']) element(id);
  const settings = { pageSize: 'a4', orientation: 'portrait', imgFit: 'contain', margin: '10',
    printDpi: '300', oversize: 'shrink', pdfContentMode: 'preserve', ...options.settings };
  for (const [id, value] of Object.entries(settings)) element(id).value = value;
  const first = { _id: 'a', _pageId: 'a', name: 'First image.png', src: 'blob:a', rotation: 0, ...options.image };
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id) || null },
    window: {
      requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
      cancelAnimationFrame(id) { frames.delete(id); }, addEventListener() {}
    },
    images: options.images || [first], selectedConvertCard: null, preserveOriginalQuality: false,
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
  return { context, elements, canvas, calls, pending, leases, frames,
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
