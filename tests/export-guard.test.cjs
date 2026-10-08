const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const source = ['js/pdf-layout.js', 'js/app.js', 'js/import-queue.js']
  .map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

// Exercise the shared exporter and the real tab/render paths. Drawing,
// encoding and download are the only boundaries replaced by test doubles.
function harness() {
  const fields = new Map(), prepared = [], preserved = [], downloads = [], alerts = [];
  let serial = 0, prepareHook = null, preserveHook = null, saveFailure = false;
  const initial = { pageSize: 'a4', orientation: 'auto', imgFit: 'contain', margin: '0',
    quality: '0.85', filename: 'export-test', printDpi: '300', oversize: 'shrink', pdfContentMode: 'preserve' };
  const drawing = {};
  for (const method of ['clearRect', 'fillRect', 'save', 'restore', 'translate', 'rotate', 'scale', 'drawImage']) drawing[method] = () => {};
  function element(id) {
    if (fields.has(id)) return fields.get(id);
    const classes = new Set(), listeners = new Map();
    const el = {
      id, tagName: 'DIV', value: initial[id] || '', style: {}, dataset: {}, children: [], disabled: false,
      classList: {
        add(...values) { values.forEach(value => classes.add(value)); },
        remove(...values) { values.forEach(value => classes.delete(value)); },
        contains(value) { return classes.has(value); },
        toggle(value, on = !classes.has(value)) { if (on) classes.add(value); else classes.delete(value); return on; }
      },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(name, callback) { listeners.set(name, callback); },
      appendChild(child) { child.parentElement = this; this.children.push(child); },
      querySelector(selector) { return element(`${id}/${selector}`); }, querySelectorAll() { return []; },
      getContext() { return drawing; }, remove() {}, focus() {}, scrollIntoView() {}
    };
    Object.defineProperty(el, 'innerHTML', { get() { return this.html || ''; }, set(value) { this.html = value; this.children = []; } });
    fields.set(id, el);
    return el;
  }
  class TestImage {
    constructor() { this.naturalWidth = 100; this.naturalHeight = 80; }
    set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); }
    get src() { return this._src; }
  }
  class TestPdf {
    addPage() {} addImage() {}
    output(type) { assert.equal(type, 'blob'); return { size: 100 }; }
  }
  const context = vm.createContext({
    console, queueMicrotask, Image: TestImage, Uint8Array,
    setTimeout(callback) { queueMicrotask(callback); return ++serial; }, clearTimeout() {},
    URL: { revokeObjectURL() {} },
    document: {
      getElementById: element, querySelector: element, querySelectorAll: () => [],
      createElement: type => element(`created-${type}-${++serial}`),
      body: element('body'), activeElement: { tagName: 'BODY' }, addEventListener() {}, removeEventListener() {}
    },
    window: {
      addEventListener() {}, jspdf: { jsPDF: TestPdf },
      PhotoPdfPreservation: {
        async prepareStructurePreservingPdf(images, options) {
          preserved.push({ images, options });
          if (preserveHook) await preserveHook(images, options);
          return { bytes: new Uint8Array([1, 2, 3]), notice: '' };
        }
      }
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    alert: value => alerts.push(value), confirm: () => true,
    fetch: async () => { throw new Error('No network in tests'); },
    bridgeToast() {},
    async bridgePrepare(image, options) {
      prepared.push({ image, options });
      if (prepareHook) {
        const result = await prepareHook(image, options);
        if (result === null) return null;
      }
      return { data: image.src, format: 'JPEG', w: 100, h: 80 };
    },
    bridgeDownload(bytes, filename) { downloads.push({ bytes, filename, kind: 'native' }); },
    bridgeRasterDownload(blob, filename) {
      if (saveFailure) throw new Error('Download failed');
      downloads.push({ blob, filename, kind: 'raster' });
    }
  });
  vm.runInContext(source, context);
  vm.runInContext('showToast=bridgeToast; preparePdfImage=bridgePrepare; downloadPdfBytes=bridgeDownload; downloadPdfBlob=bridgeRasterDownload', context);
  element('filename').dataset.touched = '1';
  const run = code => vm.runInContext(code, context);
  function add(name = 'A', native = false) {
    context.seedName = name;
    run(`{
      const id=_imgId(), src='blob:'+seedName, thumb=src+'-thumb';
      putStore(id,{src,originalSrc:src,thumb});
      const image={_id:id,_pageId:id,src,originalSrc:src,thumb,name:seedName,size:100,rotation:0,flipH:false,flipV:false,filters:{}};
      ${native ? 'const sourceId=registerPdfSource({bytes:new Uint8Array([1,2,3]),name:seedName,numPages:1}); image.pdfSource={sourceId,pageIndex:0}; image.originalPdfSource={sourceId,pageIndex:0};' : ''}
      images.push(image); snapshot('Import');
    }`);
  }
  return { context, run, element, add, prepared, preserved, downloads, alerts, TestPdf,
    onPrepare(hook) { prepareHook = hook; }, onPreserve(hook) { preserveHook = hook; },
    failSave() { saveFailure = true; } };
}

function assertButtons(h, disabled) {
  for (const id of ['convertBtn', 'editExportBtn', 'preserveQualityBtn']) assert.equal(h.element(id).disabled, disabled, id);
  assert.equal(h.run('exportInProgress'), disabled);
}

for (const [first, second] of [['generatePDF()', 'exportEditedPDF()'], ['exportEditedPDF()', 'generatePDF()']]) {
  test(`${first} and ${second} share one active export and both button states across tab rendering`, async () => {
    const h = harness(); h.add();
    const started = deferred(), finish = deferred();
    h.onPrepare(async () => { started.resolve(); await finish.promise; });
    const job = h.run(first); await started.promise;
    assertButtons(h, true);
    h.run("switchTab('edit'); renderPdfEditor(); refreshAll(); switchTab('convert'); render()");
    assertButtons(h, true);
    await h.run(second);
    assert.equal(h.prepared.length, 1);
    assert.equal(h.downloads.length, 0);
    assertButtons(h, true);
    finish.resolve(); await job;
    assert.equal(h.downloads.length, 1);
    assert.equal(h.alerts.length, 0);
    assertButtons(h, false);
    h.onPrepare(null);
    await h.run(second);
    assert.equal(h.prepared.length, 2, 'A later export may start after the first completes');
    assert.equal(h.downloads.length, 2);
    assertButtons(h, false);
  });
}

test('clearing all live pages does not release the lock held by their captured export', async () => {
  const h = harness(); h.add();
  const started = deferred(), finish = deferred();
  h.onPrepare(async () => { started.resolve(); await finish.promise; });
  const job = h.run('generatePDF()'); await started.promise;
  h.run('clearAll()');
  assert.equal(h.run('images.length'), 0);
  await h.run('exportEditedPDF()');
  assertButtons(h, true);
  assert.equal(h.prepared.length, 1);
  finish.resolve(); await job;
  assert.equal(h.downloads.length, 1);
  assertButtons(h, false);
});

for (const failure of ['prepare', 'download', 'unreadable']) {
  test(`${failure} failure restores both export buttons, quality toggle, global guard, and URL leases`, async () => {
    const h = harness(); h.add();
    const initialRefs = h.run('JSON.stringify([..._urlRefs])');
    if (failure === 'prepare') h.onPrepare(async () => { throw new Error('Encoding failed'); });
    if (failure === 'unreadable') h.onPrepare(async () => null);
    if (failure === 'download') h.failSave();
    await h.run('exportEditedPDF()');
    assert.equal(h.downloads.length, 0);
    assert.equal(h.alerts.length, 1);
    assertButtons(h, false);
    assert.equal(h.run('JSON.stringify([..._urlRefs])'), initialRefs);
    assert.equal(h.element('progWrap').classList.contains('on'), false);
    assert.equal(h.element('progWrapEdit').classList.contains('on'), false);
  });
}

test('missing raster PDF library leaves controls usable and a later restored library can export', async () => {
  const h = harness(); h.add();
  delete h.context.window.jspdf;
  await h.run('generatePDF()');
  assert.equal(h.alerts.length, 1);
  assertButtons(h, false);
  assert.equal(h.prepared.length, 0);
  h.context.window.jspdf = { jsPDF: h.TestPdf };
  await h.run('exportEditedPDF()');
  assert.equal(h.downloads.length, 1);
  assertButtons(h, false);
});

test('native PDF preparation shares the same lock and performs one download', async () => {
  const h = harness(); h.add('PDF', true);
  const started = deferred(), finish = deferred();
  h.onPreserve(async () => { started.resolve(); await finish.promise; });
  const job = h.run('exportEditedPDF()'); await started.promise;
  h.run("switchTab('convert'); switchTab('edit')");
  await h.run('generatePDF()');
  assertButtons(h, true);
  assert.equal(h.preserved.length, 1);
  assert.equal(h.prepared.length, 0);
  finish.resolve(); await job;
  assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].kind, 'native');
  assertButtons(h, false);
});

for (const missing of [false, true]) {
  test(`${missing ? 'missing' : 'rejecting'} native PDF tools restore both buttons and clear the guard`, async () => {
    const h = harness(); h.add('PDF', true);
    const initialRefs = h.run('JSON.stringify([..._urlRefs])');
    if (missing) delete h.context.window.PhotoPdfPreservation;
    else h.onPreserve(async () => { throw new Error('Native PDF loading failed'); });
    await h.run('exportEditedPDF()');
    assertButtons(h, false);
    assert.equal(h.downloads.length, 0);
    assert.equal(h.alerts.length, 1);
    assert.equal(h.run('JSON.stringify([..._urlRefs])'), initialRefs);
    assert.equal(h.element('progWrap').classList.contains('on'), false);
    assert.equal(h.element('progWrapEdit').classList.contains('on'), false);
  });
}
