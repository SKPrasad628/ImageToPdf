const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
function appFunction(name) {
  const match = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  if (!match) throw new Error(`Missing production function ${name}`);
  return match[0];
}

function harness() {
  const elements = new Map(), canvases = [], pending = [], timers = [], leases = new Map();
  function canvas() {
    const result = { width: 0, height: 0, draws: [], rotations: [] };
    const ctx = {
      clearRect() {}, save() {}, restore() {}, translate() {}, scale() {}, fillRect() {},
      rotate(value) { result.rotations.push(value); },
      drawImage(image) { result.draws.push(image.src); }
    };
    result.getContext = () => ctx;
    canvases.push(result);
    return result;
  }
  const detailPreview = { style: {} };
  Object.defineProperty(detailPreview, 'innerHTML', {
    set(value) {
      if (value.includes('detailCanvas')) elements.set('detailCanvas', canvas());
      else elements.delete('detailCanvas');
    }
  });
  elements.set('detailPreview', detailPreview);
  elements.set('detailActions', { style: {} });
  const context = vm.createContext({
    document: {
      getElementById: id => elements.get(id) || null,
      createElement: name => { assert.equal(name, 'canvas'); return canvas(); },
      querySelectorAll: () => [{ classList: { toggle() {} } }, { classList: { toggle() {} } }]
    },
    loadImage(src) {
      return new Promise((resolve, reject) => pending.push({ src, resolve, reject }));
    },
    retainUrl(src) { leases.set(src, (leases.get(src) || 0) + 1); return src; },
    releaseUrl(src) {
      const next = (leases.get(src) || 0) - 1;
      assert.ok(next >= 0, `Unbalanced source lease: ${src}`);
      if (next) leases.set(src, next); else leases.delete(src);
    },
    setTimeout(fn) { timers.push(fn); },
    async canvasToUrl() { throw new Error('Thumbnail encoder failed'); }
  });
  vm.runInContext(`
    let images = [
      {_id:'a',_pageId:'a',src:'blob:a',thumb:'blob:thumb-a',rotation:0},
      {_id:'b',_pageId:'b',src:'blob:b',thumb:'blob:thumb-b',rotation:90}
    ];
    let selectedPdfPage=null, currentTab='edit', documentRevision=1;
    let pdfListRender=1, pdfDetailRequest=0;
  ` + ['paintPdfPreview', 'clearPdfPreview', 'drawThumb', 'selectPdfPage', 'generateThumb']
    .map(name => appFunction(name)).join('\n'), context);
  return {
    context, canvases, pending, leases, elements,
    run: code => vm.runInContext(code, context),
    select: i => context.selectPdfPage(i),
    thumb: (i, version) => context.drawThumb(i, version),
    flushTimers() { while (timers.length) timers.shift()(); },
    resolve(index) {
      const item = pending[index];
      assert.ok(item, `Missing decode request ${index}`);
      item.resolve({ src: item.src, naturalWidth: 1200, naturalHeight: 800 });
    },
    replaceThumb(i = 0) { const result = canvas(); elements.set(`pthumb-${i}`, result); return result; },
    detail: () => elements.get('detailCanvas')
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('a late selected-page decode cannot replace a newer selected page', async () => {
  const h = harness();
  h.select(0); h.flushTimers(); const oldCanvas = h.detail();
  h.select(1); h.flushTimers(); const currentCanvas = h.detail();
  h.resolve(1); await settle(); h.resolve(0); await settle();
  assert.deepEqual(currentCanvas.draws, ['blob:thumb-b']);
  assert.deepEqual(currentCanvas.rotations, [Math.PI / 2]);
  assert.deepEqual(oldCanvas.draws, []);
  assert.equal(h.leases.size, 0);
});

test('clearing the selected page invalidates a pending detail preview', async () => {
  const h = harness(); h.select(0); h.flushTimers(); const oldCanvas = h.detail();
  h.context.clearPdfPreview(); h.resolve(0); await settle();
  assert.equal(h.detail(), undefined); assert.deepEqual(oldCanvas.draws, []);
  assert.equal(h.elements.get('detailActions').style.display, 'none');
  assert.equal(h.leases.size, 0);
});

test('removal during decoding cannot paint the old selected-page pixels', async () => {
  const h = harness(); h.select(0); h.flushTimers(); const oldCanvas = h.detail();
  h.run('images.splice(0,1); documentRevision++; selectedPdfPage=null;');
  h.resolve(0); await settle();
  assert.deepEqual(oldCanvas.draws, []); assert.equal(h.leases.size, 0);
});

test('leaving Edit PDF suppresses its pending detail preview', async () => {
  const h = harness(); h.select(0); h.flushTimers(); const oldCanvas = h.detail();
  h.run("currentTab='convert';"); h.resolve(0); await settle();
  assert.deepEqual(oldCanvas.draws, []); assert.equal(h.leases.size, 0);
});

test('invalid page indices cannot expose detail controls', () => {
  const h = harness();
  for (const value of [null, undefined, -1, 2, 0.5, '0']) h.select(value);
  h.flushTimers();
  assert.equal(h.pending.length, 0); assert.equal(h.canvases.length, 0);
  assert.equal(h.run('selectedPdfPage'), null);
});

test('a thumbnail from a previous list render cannot paint its replacement', async () => {
  const h = harness(); const oldCanvas = h.replaceThumb();
  h.thumb(0, 1); h.flushTimers();
  h.run('pdfListRender++; images.reverse(); documentRevision++;');
  const currentCanvas = h.replaceThumb();
  h.thumb(0, 2); h.flushTimers();
  h.resolve(1); await settle(); h.resolve(0); await settle();
  assert.deepEqual(oldCanvas.draws, []);
  assert.deepEqual(currentCanvas.draws, ['blob:thumb-b']);
  assert.equal(h.leases.size, 0);
});

test('an already superseded thumbnail timer does not start decoding', async () => {
  const h = harness(); h.replaceThumb(); h.run('pdfListRender=2;');
  await h.thumb(0, 1); h.flushTimers(); await settle();
  assert.equal(h.pending.length, 0); assert.equal(h.leases.size, 0);
});

test('detail decoding retains its source until completion and releases on failure', async () => {
  const h = harness(); h.select(0); h.flushTimers(); const currentCanvas = h.detail();
  assert.equal(h.leases.get('blob:thumb-a'), 1);
  h.pending[0].reject(new Error('Unreadable pixels')); await settle();
  assert.equal(h.leases.size, 0); assert.deepEqual(currentCanvas.draws, []);
});

test('thumbnail decoding releases its source when decoding fails', async () => {
  const h = harness(); const currentCanvas = h.replaceThumb();
  h.thumb(0, 1); h.flushTimers();
  assert.equal(h.leases.get('blob:thumb-a'), 1);
  h.pending[0].reject(new Error('Unreadable pixels')); await settle();
  assert.equal(h.leases.size, 0); assert.deepEqual(currentCanvas.draws, []);
});

test('thumbnail encoding failure frees its canvas allocation', async () => {
  const h = harness();
  await assert.rejects(h.context.generateThumb('blob:a', {
    src: 'blob:a', naturalWidth: 1200, naturalHeight: 800
  }), /Thumbnail encoder failed/);
  assert.equal(h.canvases.length, 1);
  assert.equal(h.canvases[0].width, 0); assert.equal(h.canvases[0].height, 0);
});

function encodeHarness(options = {}) {
  const calls = [], blob = options.blob || null;
  const canvas = {
    toBlob(callback, type, quality) {
      calls.push({ operation: 'toBlob', type, quality });
      // Browser encoders deliver the result after the Promise executor returns.
      setImmediate(() => callback(blob));
    },
    toDataURL(type, quality) {
      calls.push({ operation: 'toDataURL', type, quality });
      if (options.fallbackError) throw options.fallbackError;
      return options.fallback;
    }
  };
  const context = vm.createContext({
    URL: {
      createObjectURL(value) {
        assert.equal(value, blob);
        if (options.urlError) throw options.urlError;
        return 'blob:encoded';
      }
    }
  });
  vm.runInContext(appFunction('canvasToUrl'), context);
  return { calls, encode: quality => context.canvasToUrl(canvas, quality) };
}

test('an asynchronous null Blob and throwing fallback reject the encoding promise', async () => {
  const h = encodeHarness({ fallbackError: new Error('Canvas allocation failed') });
  await assert.rejects(h.encode(0.7), /Canvas allocation failed/);
});

for (const fallback of ['', 'data:,']) {
  test(`an asynchronous null Blob rejects ${fallback || 'empty'} fallback output`, async () => {
    const h = encodeHarness({ fallback });
    await assert.rejects(h.encode(0.7), /could not be encoded/);
  });
}

test('an object URL failure rejects the asynchronous encoding promise', async () => {
  const h = encodeHarness({ blob: { size: 123 }, urlError: new Error('Object URL failed') });
  await assert.rejects(h.encode(0.7), /Object URL failed/);
});

test('successful Blob encoding returns its source URL and measured byte count', async () => {
  const h = encodeHarness({ blob: { size: 123 } });
  const result = await h.encode(0.7);
  assert.equal(result.url, 'blob:encoded'); assert.equal(result.bytes, 123);
  assert.deepEqual(h.calls, [{ operation: 'toBlob', type: 'image/jpeg', quality: 0.7 }]);
});

test('a null Blob with valid fallback resolves using the requested quality', async () => {
  const h = encodeHarness({ fallback: 'data:image/jpeg;base64,encoded' });
  const result = await h.encode(0.94);
  assert.equal(result.url, 'data:image/jpeg;base64,encoded'); assert.equal(result.bytes, result.url.length * 2);
  assert.deepEqual(h.calls, [
    { operation: 'toBlob', type: 'image/jpeg', quality: 0.94 },
    { operation: 'toDataURL', type: 'image/jpeg', quality: 0.94 }
  ]);
});
