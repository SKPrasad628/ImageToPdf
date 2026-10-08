const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const source = ['js/pdf-layout.js', 'js/app.js', 'js/import-queue.js']
  .map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

// Native source records, page metadata and history use the actual app code.
// Only rendering and the final preservation/download boundaries are mocked.
function harness() {
  const fields = new Map(), downloads = [], alerts = [];
  let preserveHook = null;
  const values = { pageSize: 'fit', orientation: 'auto', imgFit: 'contain', margin: '0',
    quality: '0.85', filename: 'native-source', printDpi: '300', oversize: 'shrink', pdfContentMode: 'preserve' };
  function element(id) {
    if (!fields.has(id)) {
      const classes = new Set();
      fields.set(id, {
        id, value: values[id] || '', style: {}, dataset: {}, disabled: false,
        classList: { add: value => classes.add(value), remove: value => classes.delete(value),
          contains: value => classes.has(value),
          toggle(value, on = !classes.has(value)) { if (on) classes.add(value); else classes.delete(value); return on; } },
        setAttribute(name, value) { this[name] = value; },
        addEventListener() {}, appendChild() {}, scrollIntoView() {}, focus() {}
      });
    }
    return fields.get(id);
  }
  const context = vm.createContext({
    console, Uint8Array, ArrayBuffer,
    setTimeout: callback => queueMicrotask(callback), clearTimeout() {},
    URL: { revokeObjectURL() {} },
    document: { getElementById: element, querySelector: element, querySelectorAll: () => [],
      body: element('body'), activeElement: { tagName: 'BODY' }, addEventListener() {}, removeEventListener() {} },
    window: {
      addEventListener() {},
      PhotoPdfPreservation: {
        async prepareStructurePreservingPdf(images, options) {
          if (preserveHook) return preserveHook(images, options);
          return { bytes: new Uint8Array([1, 2, 3]) };
        }
      }
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    alert: value => alerts.push(value), confirm: () => true,
    bridgeDownload(bytes, filename) { downloads.push({ bytes, filename }); }
  });
  vm.runInContext(source, context);
  vm.runInContext(`render=()=>{}; renderPdfEditor=()=>{}; refreshAll=()=>{}; showToast=()=>{};
    downloadPdfBytes=bridgeDownload; preparePdfImage=async()=>{throw new Error('Native pages should not rasterize');}`, context);
  const run = code => vm.runInContext(code, context);
  const state = () => plain(run('images'));
  function register(bytes = new Uint8Array([10, 20, 30]), name = 'source.pdf', numPages = 5) {
    context.sourceInput = { bytes, name, numPages };
    return run('registerPdfSource(sourceInput)');
  }
  function add(sourceId, pageIndex = 0) {
    context.sourceId = sourceId; context.pageIndex = pageIndex;
    run(`{
      const id=_imgId(),src='blob:'+id,thumb=src+'-thumb';
      putStore(id,{src,originalSrc:src,thumb});
      images.push({_id:id,_pageId:id,src,originalSrc:src,thumb,name:'native.pdf',size:100,
        rotation:0,flipH:false,flipV:false,filters:{},
        pdfPageSizeMm:{width:210,height:297},originalPdfPageSizeMm:{width:210,height:297},
        pdfSource:{sourceId,pageIndex},originalPdfSource:{sourceId,pageIndex}});
    }`);
  }
  return { context, run, state, register, add, downloads, alerts,
    onPreserve(hook) { preserveHook = hook; } };
}

for (const inputType of ['typed-array', 'array-buffer', 'subarray']) {
  test(`registerPdfSource isolates ${inputType} source bytes from caller mutation`, () => {
    const h = harness(), original = new Uint8Array([1, 2, 3, 4, 5]);
    const bytes = inputType === 'array-buffer' ? original.buffer : inputType === 'subarray' ? original.subarray(1, 4) : original;
    const expected = inputType === 'subarray' ? [2, 3, 4] : [1, 2, 3, 4, 5];
    const id = h.register(bytes, 'input.pdf', 12);
    original.fill(99); h.context.sourceInput.name = 'changed.pdf'; h.context.sourceInput.numPages = 1;
    const stored = h.run(`pdfSources.get('${id}')`);
    assert.deepEqual(Array.from(stored.bytes), expected);
    assert.equal(stored.name, 'input.pdf');
    assert.equal(stored.numPages, 12);
  });
}

test('native and original descriptors are independently copied into snapshots and survive undo/redo', () => {
  const h = harness(), id = h.register(); h.add(id, 0);
  h.run('snapshot("Import"); globalThis.light=_lightImages()');
  assert.equal(h.run('light[0].pdfSource===images[0].pdfSource'), false);
  assert.equal(h.run('light[0].originalPdfSource===images[0].originalPdfSource'), false);
  h.run('images[0].pdfSource.pageIndex=1; images[0].originalPdfSource.pageIndex=2; snapshot("Change descriptors"); images[0].pdfSource.pageIndex=9; images[0].originalPdfSource.pageIndex=9');
  assert.deepEqual(plain(h.run('light[0].pdfSource')), { sourceId: id, pageIndex: 0 });
  assert.deepEqual(plain(h.run('light[0].originalPdfSource')), { sourceId: id, pageIndex: 0 });
  h.run('undo()');
  assert.deepEqual(h.state()[0].pdfSource, { sourceId: id, pageIndex: 0 });
  assert.deepEqual(h.state()[0].originalPdfSource, { sourceId: id, pageIndex: 0 });
  h.run('images[0].pdfSource.pageIndex=8; images[0].originalPdfSource.pageIndex=8; redo()');
  assert.deepEqual(h.state()[0].pdfSource, { sourceId: id, pageIndex: 1 });
  assert.deepEqual(h.state()[0].originalPdfSource, { sourceId: id, pageIndex: 2 });
  assert.equal(h.run('images[0].pdfSource===images[0].originalPdfSource'), false);
});

for (const duplicate of ['duplicateImage', 'duplicatePage']) {
  test(`${duplicate} shares PDF bytes while keeping independent native and original descriptors`, () => {
    const h = harness(), id = h.register(); h.add(id, 2); h.run('snapshot("Import")');
    h.run(`${duplicate}(0)`);
    assert.equal(h.run('images[0].pdfSource===images[1].pdfSource'), false);
    assert.equal(h.run('images[0].originalPdfSource===images[1].originalPdfSource'), false);
    assert.equal(h.run('pdfSources.size'), 1);
    h.run('images[1].pdfSource.pageIndex=4; images[1].originalPdfSource.pageIndex=3');
    assert.deepEqual(h.state()[0].pdfSource, { sourceId: id, pageIndex: 2 });
    assert.deepEqual(h.state()[0].originalPdfSource, { sourceId: id, pageIndex: 2 });
    h.run('undo(); redo()');
    assert.deepEqual(h.state()[1].pdfSource, { sourceId: id, pageIndex: 2 });
    assert.deepEqual(h.state()[1].originalPdfSource, { sourceId: id, pageIndex: 2 });
  });
}

test('pruning keeps both current and original source records while dropping unused records', () => {
  const h = harness(), current = h.register(), original = h.register(), unused = h.register();
  h.add(current);
  h.run(`images[0].originalPdfSource={sourceId:'${original}',pageIndex:0}; history=[]; historyIndex=-1; pruneImgStore()`);
  assert.equal(h.run(`pdfSources.has('${current}')`), true);
  assert.equal(h.run(`pdfSources.has('${original}')`), true);
  assert.equal(h.run(`pdfSources.has('${unused}')`), false);
  h.run(`delete images[0].pdfSource; prunePdfSources()`);
  assert.equal(h.run(`pdfSources.has('${current}')`), false);
  assert.equal(h.run(`pdfSources.has('${original}')`), true, 'A raster-edited page still needs original bytes for Revert');
});

test('deleted PDF bytes remain available through undo history and disappear when its last snapshot is trimmed', () => {
  const h = harness(), id = h.register(); h.add(id); h.run('snapshot("Import"); removeImage(0); pruneImgStore()');
  assert.equal(h.run(`pdfSources.has('${id}')`), true);
  h.run('undo()');
  assert.deepEqual(h.state()[0].pdfSource, { sourceId: id, pageIndex: 0 });
  h.run('redo()');
  assert.equal(h.state().length, 0);
  h.run('for(let i=0;i<MAX_HISTORY;i++) snapshot("Empty action")');
  assert.equal(h.run(`pdfSources.has('${id}')`), false);
  assert.equal(h.run('Object.keys(imgStore).length'), 0);
});

test('truncating a redo-only import branch releases its source bytes', () => {
  const h = harness(), id = h.register(); h.add(id); h.run('snapshot("Import"); undo()');
  assert.equal(h.state().length, 0);
  assert.equal(h.run(`pdfSources.has('${id}')`), true);
  h.run('snapshot("New branch")');
  assert.equal(h.run(`pdfSources.has('${id}')`), false);
});

test('captured native export descriptors remain stable across live descriptor changes', async () => {
  const h = harness(), id = h.register(new Uint8Array([7, 8, 9])); h.add(id, 2); h.run('snapshot("Import")');
  const started = deferred(), finish = deferred();
  let captured;
  h.onPreserve(async (images, options) => {
    started.resolve(); await finish.promise;
    captured = { native: plain(images[0].pdfSource), original: plain(images[0].originalPdfSource),
      bytes: Array.from(options.getSource(images[0].pdfSource.sourceId).bytes) };
    return { bytes: new Uint8Array([99]) };
  });
  const job = h.run('generatePDF()'); await started.promise;
  h.run('images[0].pdfSource.pageIndex=4; images[0].pdfSource.sourceId="missing"; images[0].originalPdfSource.pageIndex=3');
  finish.resolve(); await job;
  assert.deepEqual(captured, { native: { sourceId: id, pageIndex: 2 }, original: { sourceId: id, pageIndex: 2 }, bytes: [7, 8, 9] });
  assert.equal(h.downloads.length, 1);
  assert.deepEqual(h.alerts, []);
});

test('captured PDF source records survive Clear All and complete map pruning until export finishes', async () => {
  const h = harness(), id = h.register(new Uint8Array([7, 8, 9])); h.add(id, 2); h.run('snapshot("Import")');
  const started = deferred(), finish = deferred();
  let capturedBytes;
  h.onPreserve(async (images, options) => {
    started.resolve(); await finish.promise;
    capturedBytes = Array.from(options.getSource(images[0].pdfSource.sourceId).bytes);
    return { bytes: new Uint8Array([99]) };
  });
  const job = h.run('generatePDF()'); await started.promise;
  h.run('clearAll(); for(let i=0;i<MAX_HISTORY;i++) snapshot("Empty action")');
  assert.equal(h.run('pdfSources.size'), 0);
  finish.resolve(); await job;
  assert.deepEqual(capturedBytes, [7, 8, 9]);
  assert.equal(h.downloads.length, 1);
  assert.deepEqual(h.alerts, []);
  assert.equal(h.run('exportInProgress'), false);
});
