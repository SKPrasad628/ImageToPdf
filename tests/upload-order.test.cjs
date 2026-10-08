const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const scripts = ['js/pdf-layout.js', 'js/app.js', 'js/file-intake.js', 'js/import-queue.js', 'js/forge-ui.js'];
const source = scripts.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
const plain = value => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function imageFile(name) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(Buffer.from('IHDR'), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 100); view.setUint32(20, 200);
  return { name, type: 'image/png', size: bytes.length,
    slice(start, end, type) {
      return { name, type: type || 'image/png', size: Math.min(bytes.length, end) - start,
        arrayBuffer: async () => bytes.slice(start, end).buffer };
    }
  };
}

// Run the actual picker intake, FIFO queue, document rendering, UI state, and
// export loop together. Browser decoding and PDF encoding are the boundaries;
// a delayed decoder exposes attempts to export a partially imported selection.
function harness(onDecode = () => {}) {
  const fields = new Map(), urls = new Map(), decodeNames = [], prepared = [], downloads = [], toasts = [], alerts = [];
  let serial = 0, context;
  const initial = { pageSize: 'a4', orientation: 'portrait', imgFit: 'contain', margin: '10',
    quality: '0.85', filename: 'upload-order', printDpi: '300', oversize: 'shrink', pdfContentMode: 'images' };
  function element(id) {
    if (fields.has(id)) return fields.get(id);
    const classes = new Set(), events = new Map();
    const el = { id, tagName: 'DIV', value: initial[id] || '', style: {}, dataset: {}, children: [], disabled: false,
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); return on; }
      },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(name, callback) { events.set(name, callback); },
      appendChild(child) { child.parentElement = this; this.children.push(child); },
      replaceChildren(...children) { this.children = children; },
      querySelector(selector) { return element(`${id}/${selector}`); }, querySelectorAll() { return []; },
      focus() { context.document.activeElement = this; }, scrollIntoView() {}, remove() {},
      getContext() { return {}; }
    };
    Object.defineProperty(el, 'innerHTML', { get() { return this.html || ''; }, set(value) { this.html = value; this.children = []; } });
    fields.set(id, el);
    return el;
  }
  class DecoderImage {
    constructor() { this.naturalWidth = 100; this.naturalHeight = 200; }
    set src(value) {
      this._src = value;
      if (!value) return;
      const name = urls.get(value).name;
      decodeNames.push(name);
      Promise.resolve().then(() => onDecode(name)).then(() => this.onload?.(), () => this.onerror?.());
    }
    get src() { return this._src; }
  }
  class EncoderPdf {
    constructor() { this.pages = [[]]; }
    addPage() { this.pages.push([]); }
    addImage(data) { this.pages.at(-1).push(data); }
    output(type) { assert.equal(type, 'blob'); return { size: 100, pages: plain(this.pages) }; }
  }
  context = vm.createContext({
    console, Uint8Array, DataView, Image: DecoderImage, queueMicrotask,
    setTimeout(callback) { queueMicrotask(callback); return ++serial; }, clearTimeout() {},
    URL: { createObjectURL(file) { const url = `blob:source-${++serial}`; urls.set(url, file); return url; }, revokeObjectURL() {} },
    document: {
      getElementById: element, querySelector: element, querySelectorAll: () => [],
      createElement: type => element(`created-${type}-${++serial}`),
      body: element('body'), activeElement: { tagName: 'BODY' }, addEventListener() {}, removeEventListener() {}
    },
    window: { addEventListener() {}, jspdf: { jsPDF: EncoderPdf },
      matchMedia: () => ({ matches: false, addEventListener() {} }) },
    localStorage: { getItem() { return null; }, setItem() {} },
    alert: message => alerts.push(message), confirm: () => true,
    bridgeToast: message => toasts.push(message),
    bridgeThumb: async src => `${src}-thumb`,
    bridgePrepare: async image => { prepared.push(image.name); return { data: image.name, format: 'JPEG', w: 100, h: 200 }; },
    bridgeDownload: (blob, filename) => downloads.push({ pages: blob.pages, filename })
  });
  vm.runInContext(source, context);
  vm.runInContext('showToast=bridgeToast; generateThumb=bridgeThumb; preparePdfImage=bridgePrepare; downloadPdfBlob=bridgeDownload', context);
  element('filename').dataset.touched = '1';
  const run = code => vm.runInContext(code, context);
  const importFiles = names => { context.selectedFiles = names.map(imageFile); return run("handleFiles(selectedFiles, 'convert')"); };
  const pageLabels = () => element('imgGrid').children.map(card => {
    const match = card.innerHTML.match(/aria-label="Preview page (\d+): ([^"]+)"/);
    assert.ok(match, 'The actual page renderer must label each thumbnail');
    return { page: Number(match[1]), name: match[2] };
  });
  return { run, element, importFiles, pageLabels, decodeNames, prepared, downloads, toasts, alerts,
    names: () => plain(run('images.map(image => image.name)')) };
}

test('five images keep upload order in page numbers and PDF; export waits for the whole selection', async () => {
  const paused = deferred(), release = deferred();
  const names = ['z-first.png', 'b-second.png', 'q-third.png', 'a-fourth.png', 'm-last.png'];
  const h = harness(async name => { if (name === names[1]) { paused.resolve(); await release.promise; } });
  const importing = h.importFiles(names);
  await paused.promise;
  assert.deepEqual(h.names(), [names[0]], 'The first page is available before the second finishes decoding');
  assert.equal(h.element('convertBtn').disabled, true, 'Forge stays disabled while any selected file is importing');
  assert.equal(h.element('editExportBtn').disabled, true);
  assert.equal(h.element('imgGrid')['aria-busy'], 'true');
  assert.equal(h.element('importOrderStatus').hidden, false);
  await h.run('generatePDF()');
  assert.deepEqual(h.prepared, [], 'A direct export call must not capture an incomplete prefix either');
  assert.deepEqual(h.downloads, []);
  assert.ok(h.toasts.length, 'A blocked export explains that import must finish');
  release.resolve();
  assert.equal(await importing, true);
  assert.equal(h.run('hasPendingImports()'), false);
  assert.equal(h.element('convertBtn').disabled, false, 'The queue finishing restores Forge without another user action');
  assert.equal(h.element('editExportBtn').disabled, false);
  assert.equal(h.element('imgGrid')['aria-busy'], 'false');
  assert.equal(h.element('importOrderStatus').hidden, true);
  assert.deepEqual(h.names(), names);
  assert.deepEqual(h.pageLabels(), names.map((name, i) => ({ page: i + 1, name })));
  await h.run('generatePDF()');
  assert.deepEqual(h.prepared, names);
  assert.deepEqual(h.downloads, [{ pages: names.map(name => [name]), filename: 'upload-order.pdf' }]);
  assert.deepEqual(h.alerts, []);
});

test('overlapping upload batches append in selection order and cannot export between batches', async () => {
  const paused = deferred(), release = deferred();
  const secondPaused = deferred(), secondRelease = deferred();
  const first = ['z-first.png', 'm-second.png'], second = ['a-third.png', 'q-fourth.png', 'b-last.png'];
  const h = harness(async name => {
    if (name === first[1]) { paused.resolve(); await release.promise; }
    if (name === second[0]) { secondPaused.resolve(); await secondRelease.promise; }
  });
  const firstImport = h.importFiles(first);
  await paused.promise;
  const secondImport = h.importFiles(second);
  assert.deepEqual(h.decodeNames, first, 'The next selection may not decode ahead of the current one');
  assert.equal(h.element('convertBtn').disabled, true);
  await h.run('exportEditedPDF()');
  assert.deepEqual(h.downloads, [], 'The legacy export entry point shares the same import guard');
  release.resolve();
  assert.equal(await firstImport, true);
  await secondPaused.promise;
  assert.deepEqual(h.names(), first, 'The first selection is complete while the next one is still importing');
  assert.equal(h.element('convertBtn').disabled, true, 'Completing one batch must not unlock Forge ahead of queued batches');
  await h.run('generatePDF()');
  assert.deepEqual(h.downloads, []);
  secondRelease.resolve();
  assert.equal(await secondImport, true);
  const expected = [...first, ...second];
  assert.deepEqual(h.decodeNames, expected);
  assert.deepEqual(h.pageLabels(), expected.map((name, i) => ({ page: i + 1, name })));
  assert.equal(h.element('convertBtn').disabled, false);
  await h.run('generatePDF()');
  assert.deepEqual(h.downloads[0].pages, expected.map(name => [name]));
});

test('an explicit page reorder overrides upload order in thumbnail numbers and final PDF', async () => {
  const names = ['z-first.png', 'b-second.png', 'q-third.png', 'a-fourth.png', 'm-last.png'];
  const h = harness();
  await h.importFiles(names);
  h.run('changeImageOrder(4, 0)');
  const expected = [names[4], ...names.slice(0, 4)];
  assert.deepEqual(h.pageLabels(), expected.map((name, i) => ({ page: i + 1, name })));
  await h.run('generatePDF()');
  assert.deepEqual(h.prepared, expected, 'Default upload order must not undo an intentional arrangement');
  assert.deepEqual(h.downloads[0].pages, expected.map(name => [name]));
});

test('canceling an active and queued selection releases the import guard and preserves completed pages', async () => {
  const paused = deferred(), release = deferred();
  const h = harness(async name => { if (name === 'b-second.png') { paused.resolve(); await release.promise; } });
  const active = h.importFiles(['z-first.png', 'b-second.png']);
  await paused.promise;
  const queued = h.importFiles(['a-queued.png', 'm-queued.png']);
  h.run('cancelImports()');
  assert.equal(h.element('convertBtn').disabled, true, 'The canceled decoder must finish cleanup before exports unlock');
  assert.deepEqual(await Promise.all([active, queued]), [false, false]);
  release.resolve();
  assert.equal(h.run('hasPendingImports()'), false);
  assert.equal(h.element('convertBtn').disabled, false);
  assert.equal(h.element('editExportBtn').disabled, false);
  assert.equal(h.element('imgGrid')['aria-busy'], 'false');
  assert.equal(h.element('importOrderStatus').hidden, true);
  assert.deepEqual(h.decodeNames, ['z-first.png', 'b-second.png'], 'Queued files never decode after cancellation');
  assert.deepEqual(h.pageLabels(), [{ page: 1, name: 'z-first.png' }]);
  await h.run('generatePDF()');
  assert.deepEqual(h.downloads[0].pages, [['z-first.png']]);
});
