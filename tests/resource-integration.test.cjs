const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const MiB = 1024 * 1024;
const tick = () => new Promise(resolve => setImmediate(resolve));
function script(file) { return fs.readFileSync(path.join(root, 'js', file), 'utf8'); }
function appFunction(name) {
  const source = script('app.js');
  const oneLine = source.match(new RegExp(`(?:async )?function ${name}\\([^\\r\\n]*\\}[^\\S\\r\\n]*(?:\\r?\\n|$)`));
  if (oneLine) return oneLine[0];
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  if (!match) throw new Error(`Missing app function ${name}`);
  return match[0];
}
function contextWithLimits(extras = {}) {
  const context = vm.createContext({ window: {}, Promise, Map, Set, ...extras });
  vm.runInContext(script('raster-limits.js'), context);
  return context;
}
function encoderHarness() {
  const revoked = [], created = [];
  const context = contextWithLimits({
    URL: { createObjectURL(blob) { const url = `blob:encoded-${created.length + 1}`; created.push({ url, blob }); return url; },
      revokeObjectURL(url) { revoked.push(url); } }
  });
  vm.runInContext(appFunction('canvasToUrl'), context);
  return { context, revoked, created, limits: context.window.PhotoPdfLimits,
    encode(bytes, width = 100, height = 80) {
      return context.canvasToUrl({ width, height, toBlob(done) { done({ size: bytes }); } }, undefined, 'image/png');
    } };
}
function decodeHarness() {
  const decoded = [];
  class ControlledImage {
    constructor() { this.naturalWidth = 100; this.naturalHeight = 80; decoded.push(this); }
    set src(value) { this.url = value; }
    get src() { return this.url; }
  }
  const context = contextWithLimits({ Image: ControlledImage });
  vm.runInContext(`const _imgCache = new Map(); const _imageDecodes = new Map();
    ${appFunction('loadImage')}
    ${appFunction('forgetImage')}`, context);
  const finish = (index, width = 100, height = 80) => {
    const image = decoded[index];
    assert.ok(image, 'Expected a decode to have started');
    image.naturalWidth = width; image.naturalHeight = height;
    assert.equal(typeof image.onload, 'function'); image.onload();
  };
  return { context, decoded, finish,
    cache: () => JSON.parse(vm.runInContext('JSON.stringify([..._imgCache.keys()])', context)),
    pendingCount: () => vm.runInContext('_imageDecodes.size', context) };
}
function job() {
  let current = true;
  const callbacks = new Set();
  return { isCurrent: () => current,
    onCancel(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
    cancel() { current = false; callbacks.forEach(callback => callback()); callbacks.clear(); } };
}

test('actual canvas encoder rejects unsafe dimensions before encoding or creating a URL', async () => {
  const h = encoderHarness(); let encodes = 0;
  await assert.rejects(h.context.canvasToUrl({ width: 100000, height: 100000,
    toBlob() { encodes++; } }), /large|megapixel/i);
  assert.equal(encodes, 0); assert.equal(h.created.length, 0); assert.equal(h.limits.stats().retainedBytes, 0);
});

test('actual canvas encoder tracks binary size and revokes an output rejected by the byte budget', async () => {
  const h = encoderHarness();
  await assert.rejects(h.encode(128 * MiB + 1), /128.*(?:MB|limit)/i);
  assert.deepEqual(h.revoked, ['blob:encoded-1']); assert.equal(h.limits.stats().retainedBytes, 0);
  const result = await h.encode(100);
  assert.equal(result.bytes, 100); assert.equal(h.limits.stats().retainedBytes, 100);
  assert.deepEqual(h.revoked, ['blob:encoded-1']);
});

test('canvas encode failures cannot consume a working-file reservation', async () => {
  const h = encoderHarness();
  await assert.rejects(h.context.canvasToUrl({ width: 100, height: 80,
    toBlob() { throw new Error('Browser encode failure'); } }), /Browser encode failure/);
  await assert.rejects(h.context.canvasToUrl({ width: 100, height: 80,
    toBlob(done) { done(null); }, toDataURL() { return 'data:,'; } }), /could not be encoded/);
  assert.equal(h.created.length, 0); assert.equal(h.limits.stats().retainedBytes, 0);
});

test('data URL fallback encoding is counted conservatively and fails at the shared byte quota', async () => {
  const h = encoderHarness(), first = 'data:image/png;base64,eA==', second = 'data:image/png;base64,eB==';
  h.limits.reserveBytes('other-resources', 128 * MiB - first.length * 2);
  const canvas = value => ({ width: 100, height: 80, toBlob(done) { done(null); }, toDataURL() { return value; } });
  const result = await h.context.canvasToUrl(canvas(first));
  assert.equal(result.url, first); assert.equal(result.bytes, first.length * 2);
  assert.equal(h.limits.stats().retainedBytes, 128 * MiB);
  await assert.rejects(h.context.canvasToUrl(canvas(second)), /128.*(?:MB|limit)/i);
  assert.equal(h.created.length, 0); assert.equal(h.limits.stats().allocations, 2);
  h.limits.forgetUrl(first);
  assert.equal(h.limits.stats().retainedBytes, 128 * MiB - first.length * 2);
});

test('actual loadImage serializes different decodes and deduplicates the same source', async () => {
  const h = decodeHarness();
  const first = h.context.loadImage('blob:first'), repeated = h.context.loadImage('blob:first');
  const second = h.context.loadImage('blob:second');
  assert.equal(first, repeated);
  await tick(); assert.equal(h.decoded.length, 1); assert.equal(h.decoded[0].src, 'blob:first');
  h.finish(0); assert.equal((await first).src, 'blob:first');
  await tick(); assert.equal(h.decoded.length, 2); assert.equal(h.decoded[1].src, 'blob:second');
  h.finish(1); assert.equal((await second).src, 'blob:second');
  assert.equal(h.pendingCount(), 0);
});

test('actual loadImage cache evicts by decoded weight and reuses an admitted image', async () => {
  const h = decodeHarness();
  for (const [index, src, width, height] of [[0, 'blob:a', 4000, 2000], [1, 'blob:b', 4000, 2000], [2, 'blob:c', 1, 1]]) {
    const pending = h.context.loadImage(src); await tick(); h.finish(index, width, height); await pending;
  }
  assert.deepEqual(h.cache(), ['blob:b', 'blob:c']);
  const cached = await h.context.loadImage('blob:b');
  assert.equal(cached.naturalWidth * cached.naturalHeight, 8000000);
  assert.equal(h.decoded.length, 3);
});

test('an oversized decoded image is rejected and cleared without poisoning the next decode', async () => {
  const h = decodeHarness(), pending = h.context.loadImage('blob:oversized');
  const rejected = assert.rejects(pending, /large|megapixel/i);
  await tick(); h.finish(0, 100000, 100000); await rejected;
  assert.equal(h.decoded[0].src, ''); assert.deepEqual(h.cache(), []); assert.equal(h.pendingCount(), 0);
  const next = h.context.loadImage('blob:safe'); await tick(); h.finish(1); await next;
  assert.deepEqual(h.cache(), ['blob:safe']);
});

test('actual loadImage skips a queued canceled import before creating an Image', async () => {
  const h = decodeHarness(), canceled = job();
  const first = h.context.loadImage('blob:first'), queued = h.context.loadImage('blob:canceled', canceled);
  const rejected = assert.rejects(queued, /cancel/i);
  await tick(); canceled.cancel(); h.finish(0); await first; await rejected;
  assert.equal(h.decoded.length, 1); assert.equal(h.pendingCount(), 0);
  assert.deepEqual(h.cache(), ['blob:first']);
});

test('canceling an active decode releases the shared scheduler and blocks a captured late callback', async () => {
  const h = decodeHarness(), canceled = job();
  const first = h.context.loadImage('blob:canceled', canceled), next = h.context.loadImage('blob:next');
  const rejected = assert.rejects(first, /cancel/i);
  await tick(); const staleOnload = h.decoded[0].onload; canceled.cancel(); await rejected;
  await tick(); assert.equal(h.decoded.length, 2); assert.equal(h.decoded[0].src, '');
  staleOnload(); assert.equal(h.cache().includes('blob:canceled'), false);
  h.finish(1); await next; assert.deepEqual(h.cache(), ['blob:next']);
});

test('the final store URL lease frees quota while shared references keep it reserved', () => {
  const revoked = [];
  const context = contextWithLimits({ URL: { revokeObjectURL(url) { revoked.push(url); } }, forgetImage() {} });
  vm.runInContext(`const _urlRefs = new Map(); ${appFunction('isBlobUrl')}
    ${appFunction('retainUrl')} ${appFunction('releaseUrl')}`, context);
  const limits = context.window.PhotoPdfLimits;
  for (const url of ['blob:source', 'data:image/png;base64,eA==']) {
    limits.trackUrl(url, 100, 10, 10);
    context.retainUrl(url); context.retainUrl(url); context.releaseUrl(url);
    assert.equal(limits.stats().retainedBytes, 100);
    context.releaseUrl(url); assert.equal(limits.stats().retainedBytes, 0);
  }
  assert.deepEqual(revoked, ['blob:source']);
});

function editorHarness() {
  const canvases = [], toasts = [], revoked = [], fields = { resW: { value: '100' }, resH: { value: '80' } };
  const context = contextWithLimits({
    document: { getElementById(id) { return fields[id]; }, querySelectorAll() { return []; },
      createElement() { const canvas = { width: 0, height: 0, getContext() {
        return { drawImage() {}, translate() {}, rotate() {}, scale() {}, filter: '' };
      } }; canvases.push(canvas); return canvas; } },
    URL: { revokeObjectURL(url) { revoked.push(url); } },
    showToast(message) { toasts.push(message); },
    renderPreviewCanvas() {}, updateSizeInfo() {},
    loadImage: async () => ({ naturalWidth: 4000, naturalHeight: 4000 }),
    encodeEditorCanvas: async () => 'blob:edited', generateThumb: async () => 'blob:thumb',
    buildFilterStringFrom: () => '',
    seedSession: { active: true, saving: false, generation: 0, pending: 0, failures: 0,
      queue: Promise.resolve(), tempUrls: new Set(), borrowedUrls: new Set(['blob:original']) }
  });
  vm.runInContext(`let editorSession = seedSession, editorCurrentSrc = 'blob:original';
    const _urlRefs = new Map();
    ${appFunction('isBlobUrl')} ${appFunction('retainUrl')} ${appFunction('releaseUrl')}
    function forgetImage() {}
    ${script('editor.js').match(/function isEditorSessionCurrent\([^]*?\n\}/)[0]}
    ${script('editor.js').match(/function isEditorSourceCurrent\([^]*?\n\}/)[0]}`, context);
  const editorFunction = name => {
    const match = script('editor.js').match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    if (!match) throw new Error(`Missing editor function ${name}`);
    return match[0];
  };
  for (const name of ['discardEditorOutput', 'updateEditorControls', 'setEditorSrc', 'releaseEditorTemps',
    'canChangeEditor', 'queueEditorOperation', 'applyResize', 'bakeTransform']) {
    vm.runInContext(editorFunction(name), context);
  }
  return { context, canvases, toasts, revoked, fields, limits: context.window.PhotoPdfLimits,
    run: code => vm.runInContext(code, context) };
}

test('editor resize rejects an oversized requested canvas before allocating it and explains the limit', async () => {
  const h = editorHarness(); h.fields.resW.value = '100000'; h.fields.resH.value = '100000';
  assert.equal(await h.context.applyResize(), false);
  assert.equal(h.canvases.length, 0);
  assert.ok(h.toasts.some(message => /16.*megapixel|8.?192|too large|limit/i.test(message)), h.toasts.join('\n'));
});

test('editor rotation rejects an oversized bounding canvas before allocating it', async () => {
  const h = editorHarness();
  await assert.rejects(h.context.bakeTransform('blob:original', 45, false, false, {}), /large|megapixel/i);
  assert.equal(h.canvases.length, 0);
});

test('unowned editor outputs free reservations for Blob and data URL fallback sources', () => {
  const h = editorHarness();
  for (const url of ['blob:orphan', 'data:image/png;base64,eA==']) {
    h.limits.trackUrl(url, 100, 10, 10);
    h.context.discardEditorOutput(url);
    assert.equal(h.limits.stats().retainedBytes, 0, `${url} quota was not freed`);
  }
  assert.deepEqual(h.revoked, ['blob:orphan']);
});

test('editor temporary data URL fallback outputs are owned until replacement or close', () => {
  const h = editorHarness(), first = 'data:image/png;base64,eA==', second = 'data:image/png;base64,eB==';
  h.limits.trackUrl(first, 100, 10, 10); h.limits.trackUrl(second, 100, 10, 10);
  assert.equal(h.context.setEditorSrc(first, { temporary: true }), true);
  assert.equal(h.run('editorSession.tempUrls.has(editorCurrentSrc)'), true);
  assert.equal(h.context.setEditorSrc(second, { temporary: true }), true);
  assert.equal(h.limits.stats().retainedBytes, 100, 'The replaced temporary fallback must be released');
  h.run('releaseEditorTemps(editorSession)');
  assert.equal(h.limits.stats().retainedBytes, 0); assert.deepEqual(h.revoked, []);
});

test('history pruning releases orphaned versions while retaining an original shared by the current image', () => {
  const revoked = [];
  const context = contextWithLimits({ URL: { revokeObjectURL(url) { revoked.push(url); } }, forgetImage() {} });
  vm.runInContext(`let images = [], history = []; let imgStore = {}; const pdfSources = new Map();
    const _urlRefs = new Map(); ${appFunction('isBlobUrl')} ${appFunction('retainUrl')}
    ${appFunction('releaseUrl')} const STORE_URL_KEYS = ['src', 'originalSrc', 'thumb'];
    ${appFunction('putStore')} ${appFunction('dropStore')}
    ${appFunction('prunePdfSources')} ${appFunction('pruneImgStore')}`, context);
  const limits = context.window.PhotoPdfLimits;
  for (const [url, bytes] of [['blob:old', 100], ['blob:old-thumb', 10], ['blob:new', 100], ['blob:new-thumb', 10]]) {
    limits.trackUrl(url, bytes, 10, 10);
  }
  context.putStore('old', { src: 'blob:old', originalSrc: 'blob:old', thumb: 'blob:old-thumb' });
  context.putStore('new', { src: 'blob:new', originalSrc: 'blob:old', thumb: 'blob:new-thumb' });
  vm.runInContext(`images = [{ _id: 'new' }]; history = [JSON.stringify([{ _id: 'old' }])];`, context);
  assert.equal(context.pruneImgStore(), 0); assert.equal(limits.stats().retainedBytes, 220);
  vm.runInContext('history = []', context);
  assert.equal(context.pruneImgStore(), 1); assert.equal(limits.stats().retainedBytes, 210);
  assert.deepEqual(revoked, ['blob:old-thumb']);
  context.dropStore('new'); assert.equal(limits.stats().retainedBytes, 0);
  assert.deepEqual(revoked.sort(), ['blob:new', 'blob:new-thumb', 'blob:old', 'blob:old-thumb'].sort());
});

test('PDF original-source reservations survive undo and revert references until their final pruning', () => {
  const context = contextWithLimits();
  vm.runInContext(`let images = [], history = []; const pdfSources = new Map();
    ${appFunction('prunePdfSources')}`, context);
  const limits = context.window.PhotoPdfLimits;
  limits.reserveBytes('pdf:old', 1000);
  vm.runInContext(`pdfSources.set('pdf:old', { bytes: new Uint8Array(1000) });
    history = [JSON.stringify([{ pdfSource: { sourceId: 'pdf:old', pageIndex: 0 } }])];`, context);
  context.prunePdfSources(); assert.equal(limits.stats().retainedBytes, 1000);
  vm.runInContext(`history = []; images = [{ originalPdfSource: { sourceId: 'pdf:old', pageIndex: 0 } }];`, context);
  context.prunePdfSources(); assert.equal(limits.stats().retainedBytes, 1000);
  vm.runInContext('images = []', context);
  context.prunePdfSources(); assert.equal(limits.stats().retainedBytes, 0);
  assert.equal(vm.runInContext('pdfSources.size', context), 0);
});

test('discarding a borrowed editor output preserves its retained reservation', () => {
  const h = editorHarness(), url = 'data:image/png;base64,eA==';
  h.limits.trackUrl(url, 100, 10, 10); h.context.retainUrl(url);
  h.context.discardEditorOutput(url); assert.equal(h.limits.stats().retainedBytes, 100);
  h.context.releaseUrl(url); assert.equal(h.limits.stats().retainedBytes, 0);
});

function exportLeaseHarness(options = {}) {
  const fields = new Map(), alerts = [], downloads = [], toasts = [];
  let start, finish;
  const started = new Promise(resolve => { start = resolve; });
  const paused = new Promise(resolve => { finish = resolve; });
  const defaults = { pageSize: 'fit', orientation: 'auto', imgFit: 'contain', margin: '0',
    filename: 'lease-test', printDpi: '300', oversize: 'shrink', pdfContentMode: 'preserve' };
  const element = id => {
    if (!fields.has(id)) fields.set(id, { value: defaults[id] || '', style: {},
      classList: { add() {}, remove() {} }, scrollIntoView() {}, disabled: false });
    return fields.get(id);
  };
  const context = contextWithLimits({
    document: { getElementById: element }, URL: { revokeObjectURL() {} },
    setTimeout: callback => { callback(); return 1; },
    confirm: () => options.confirm !== false, alert: message => alerts.push(message),
    estimateExportSize() {}, exportQuality: () => 0.85, sanitizeFilename: value => value,
    copyPdfPageSize: value => value, setExportProgress() {}, updatePdfContentUI() {},
    preparePdfImage() {}, computePdfLayout() {}, formatFileBytes: bytes => `${bytes} bytes`,
    showToast: message => toasts.push(message),
    downloadPdfBytes: (bytes, filename) => downloads.push({ bytes, filename }),
    cancelImports() {}, refreshAll() {}, fileInput: { value: '' }, forgetImage() {},
    captureSelection: () => ({}), restoreSelection() {}, pageIdentity: image => image._pageId,
    updateUndoUI() {}, clearNativeCardDrag() {},
    window: { PhotoPdfPreservation: { async prepareStructurePreservingPdf(images, options) {
      start({ images, options }); await paused; return { bytes: new Uint8Array([1, 2, 3]), notice: '' };
    } } }
  });
  vm.runInContext(`let images = [], history = [], historyIndex = -1, undoLabels = [];
    let imgStore = {}, documentRevision = 0, _imgIdCounter = 0; const MAX_HISTORY = 20;
    let selectedConvertCard = null, selectedPdfPage = null; const selectedSet = new Set();
    let preserveOriginalQuality = false, exportInProgress = false, currentTab = 'convert', lastExportReport = null;
    const pdfSources = new Map(); let pdfSourceCounter = 0; const _urlRefs = new Map();
    const STORE_URL_KEYS = ['src', 'originalSrc', 'thumb'];
    ${appFunction('_imgId')} ${appFunction('isBlobUrl')} ${appFunction('retainUrl')} ${appFunction('releaseUrl')}
    ${appFunction('copyPdfSource')} ${appFunction('putStore')} ${appFunction('dropStore')}
    ${appFunction('registerPdfSource')} ${appFunction('prunePdfSources')} ${appFunction('pruneImgStore')}
    ${appFunction('_lightImages')} ${appFunction('_restoreImages')} ${appFunction('snapshot')}
    ${appFunction('undo')} ${appFunction('redo')} ${appFunction('clearAll')} ${appFunction('discardUndoHistory')}
    ${appFunction('duplicateImage')} ${appFunction('duplicatePage')}
    ${appFunction('getExportReport')} ${appFunction('publishExportReport')} ${appFunction('generatePDF')}`, context);
  return { context, alerts, downloads, toasts, started, finish,
    limits: context.window.PhotoPdfLimits, run: code => vm.runInContext(code, context) };
}

test('native export retains its captured PDF quota after Clear All and history pruning', async () => {
  const h = exportLeaseHarness();
  h.run(`{
    const sourceId = registerPdfSource({ bytes: new Uint8Array([1,2,3]), name: 'Original.pdf', numPages: 1 });
    putStore('page', { src: 'blob:page', originalSrc: 'blob:page', thumb: 'blob:thumb' });
    images.push({ _id: 'page', _pageId: 'page', src: 'blob:page', originalSrc: 'blob:page', thumb: 'blob:thumb',
      name: 'Original.pdf', rotation: 0, filters: {}, pdfSource: { sourceId, pageIndex: 0 } });
    snapshot('Import');
  }`);
  h.limits.reserveBytes('other-work', 128 * MiB - 3);
  const job = h.context.generatePDF(), captured = await h.started;
  h.context.clearAll(); h.run('history = []; pruneImgStore()');
  assert.equal(h.run('images.length'), 0); assert.equal(h.run('pdfSources.size'), 0);
  assert.equal(h.limits.stats().retainedBytes, 128 * MiB);
  assert.throws(() => h.limits.reserveBytes('new-import', 1), /128.*(?:MB|limit)/i);
  assert.deepEqual(Array.from(captured.options.getSource(captured.images[0].pdfSource.sourceId).bytes), [1, 2, 3]);
  h.finish(); await job;
  assert.equal(h.downloads.length, 1); assert.deepEqual(h.alerts, []);
  assert.equal(h.limits.stats().retainedBytes, 128 * MiB - 3);
  assert.doesNotThrow(() => h.limits.reserveBytes('new-import', 3));
});

for (const method of ['duplicateImage', 'duplicatePage']) {
  test(`${method} cannot bypass the 200-page limit or mutate history when full`, () => {
    const h = exportLeaseHarness();
    h.run(`images = Array.from({ length: 200 }, (_, index) => ({ _id: 'page'+index, _pageId: 'page'+index,
      src: 'blob:shared', originalSrc: 'blob:shared', thumb: 'blob:thumb', filters: {}, name: 'Photo' }));`);
    const before = h.run('JSON.stringify(images)');
    h.context[method](0);
    assert.equal(h.run('images.length'), 200); assert.equal(h.run('JSON.stringify(images)'), before);
    assert.equal(h.run('history.length'), 0); assert.equal(h.run('Object.keys(imgStore).length'), 0);
    assert.ok(h.toasts.some(message => /200/.test(message)));
  });
}

function downloadHarness(failure) {
  const created = [], revoked = [], timers = [], clicks = [], removals = [];
  const context = contextWithLimits({
    URL: { createObjectURL(blob) {
      if (failure === 'url') throw new Error('URL failed');
      const url = `blob:download-${created.length + 1}`; created.push({ blob, url }); return url;
    }, revokeObjectURL(url) { revoked.push(url); } },
    document: { createElement(type) {
      assert.equal(type, 'a'); if (failure === 'element') throw new Error('Element failed');
      return { click() { if (failure === 'click') throw new Error('Click failed'); clicks.push(this.download); },
        remove() { removals.push(this.download); } };
    }, body: { appendChild() { if (failure === 'append') throw new Error('Append failed'); } } },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }
  });
  vm.runInContext(appFunction('downloadPdfBlob'), context);
  return { context, created, revoked, timers, clicks, removals, limits: context.window.PhotoPdfLimits,
    download: bytes => context.downloadPdfBlob({ size: bytes }, 'download.pdf') };
}

test('actual PDF download keeps its URL and reservation for 30 seconds then releases both', () => {
  const h = downloadHarness(); h.download(100);
  assert.equal(h.limits.stats().downloadBytes, 100); assert.equal(h.limits.stats().downloads, 1);
  assert.deepEqual(h.clicks, ['download.pdf']); assert.deepEqual(h.removals, ['download.pdf']);
  assert.deepEqual(h.revoked, []); assert.equal(h.timers.length, 1); assert.equal(h.timers[0].delay, 30000);
  h.timers[0].callback();
  assert.deepEqual(h.revoked, ['blob:download-1']);
  assert.equal(h.limits.stats().downloadBytes, 0); assert.equal(h.limits.stats().downloads, 0);
});

test('download quota rejection happens before URL or anchor allocation', () => {
  const h = downloadHarness(); h.limits.reserveDownload('previous', 128 * MiB);
  assert.throws(() => h.download(1), /wait|download|30 seconds/i);
  assert.equal(h.created.length, 0); assert.equal(h.clicks.length, 0); assert.equal(h.timers.length, 0);
  assert.equal(h.limits.stats().downloadBytes, 128 * MiB); assert.equal(h.limits.stats().downloads, 1);
});

for (const failure of ['url', 'element', 'append', 'click']) {
  test(`${failure} download failure immediately releases its reservation and any created URL`, () => {
    const h = downloadHarness(failure);
    assert.throws(() => h.download(100), new RegExp(failure, 'i'));
    assert.equal(h.limits.stats().downloadBytes, 0); assert.equal(h.limits.stats().downloads, 0);
    assert.equal(h.timers.length, 0, 'Failed setup must not retain a download until its timer');
    assert.deepEqual(h.revoked, failure === 'url' ? [] : ['blob:download-1']);
  });
}

function seedUndoVersions(h) {
  for (const [url, bytes] of [['blob:current', 100], ['blob:original', 100], ['blob:current-thumb', 10],
    ['blob:old', 120], ['blob:old-thumb', 10], ['blob:redo', 110], ['blob:redo-thumb', 10]]) {
    h.limits.trackUrl(url, bytes, 10, 10);
  }
  h.run(`{
    const originalPdf = registerPdfSource({ bytes: new Uint8Array([1,2,3]), name: 'Original.pdf', numPages: 1 });
    const stalePdf = registerPdfSource({ bytes: new Uint8Array([4,5,6,7]), name: 'Deleted.pdf', numPages: 1 });
    putStore('old', { src: 'blob:old', originalSrc: 'blob:original', thumb: 'blob:old-thumb' });
    images = [{ _id: 'old', _pageId: 'logical-page', src: 'blob:old', originalSrc: 'blob:original',
      thumb: 'blob:old-thumb', name: 'Old version', rotation: 0, filters: {},
      pdfSource: { sourceId: stalePdf, pageIndex: 0 } }];
    snapshot('Old edit');
    putStore('current', { src: 'blob:current', originalSrc: 'blob:original', thumb: 'blob:current-thumb' });
    images = [{ _id: 'current', _pageId: 'logical-page', src: 'blob:current', originalSrc: 'blob:original',
      thumb: 'blob:current-thumb', name: 'Current version', rotation: 90, flipH: true, flipV: false,
      filters: { brightness: 125 }, size: 100, pdfPageSizeMm: { width: 210, height: 297 },
      originalPdfPageSizeMm: { width: 210, height: 297 }, originalPdfSource: { sourceId: originalPdf, pageIndex: 0 } }];
    snapshot('Current edit');
    putStore('redo', { src: 'blob:redo', originalSrc: 'blob:original', thumb: 'blob:redo-thumb' });
    images = [{ _id: 'redo', _pageId: 'logical-page', src: 'blob:redo', originalSrc: 'blob:original',
      thumb: 'blob:redo-thumb', name: 'Redo version', rotation: 0, filters: {},
      pdfSource: { sourceId: stalePdf, pageIndex: 0 } }];
    snapshot('Redo edit');
    undo();
  }`);
}

test('canceling Free undo history leaves document, histories, revisions and resource reservations intact', () => {
  const h = exportLeaseHarness({ confirm: false }); seedUndoVersions(h);
  const before = h.run('JSON.stringify({ images, history, historyIndex, undoLabels, documentRevision, refs: [..._urlRefs], stores: imgStore })');
  const bytes = h.limits.stats().retainedBytes, allocations = h.limits.stats().allocations;
  h.context.discardUndoHistory();
  assert.equal(h.run('JSON.stringify({ images, history, historyIndex, undoLabels, documentRevision, refs: [..._urlRefs], stores: imgStore })'), before);
  assert.equal(h.limits.stats().retainedBytes, bytes); assert.equal(h.limits.stats().allocations, allocations);
});

test('Free undo history prunes discarded and redo versions while preserving current metadata and originals', () => {
  const h = exportLeaseHarness(); seedUndoVersions(h);
  const before = h.run('JSON.stringify(images)'), revision = h.run('documentRevision');
  assert.equal(h.limits.stats().retainedBytes, 467);
  h.context.discardUndoHistory();
  assert.equal(h.run('JSON.stringify(images)'), before);
  assert.equal(h.run('documentRevision'), revision + 1);
  assert.equal(h.run('history.length'), 1); assert.equal(h.run('historyIndex'), 0);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(undoLabels)')), ['Current document']);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(Object.keys(imgStore))')), ['current']);
  assert.equal(h.run('pdfSources.size'), 1);
  assert.equal(h.limits.stats().retainedBytes, 213, 'Only current image, original, thumbnail and original PDF should remain');
  h.context.undo(); h.context.redo(); assert.equal(h.run('JSON.stringify(images)'), before);
  assert.equal(h.run('history.length'), 1); assert.equal(h.run('historyIndex'), 0);
});

test('Free undo history keeps borrowed editor pixels and captured export sources reserved until their leases end', () => {
  const h = exportLeaseHarness(); seedUndoVersions(h);
  h.context.retainUrl('blob:old');
  const staleSourceId = h.run("[...pdfSources.keys()].find(id => pdfSources.get(id).name === 'Deleted.pdf')");
  const releaseExport = h.limits.leaseBytes(staleSourceId);
  h.context.discardUndoHistory();
  assert.equal(h.run('Object.keys(imgStore).length'), 1); assert.equal(h.run('pdfSources.size'), 1);
  assert.equal(h.limits.stats().retainedBytes, 213 + 120 + 4);
  h.context.releaseUrl('blob:old'); assert.equal(h.limits.stats().retainedBytes, 213 + 4);
  releaseExport(); assert.equal(h.limits.stats().retainedBytes, 213);
});

test('thumbnail decode failure rejects before canvas allocation instead of aliasing the full-resolution source', async () => {
  let canvases = 0, encodes = 0;
  const context = contextWithLimits({
    loadImage: async () => { throw new Error('Image decode failed'); },
    document: { createElement() { canvases++; } }, canvasToUrl: async () => { encodes++; }
  });
  vm.runInContext(appFunction('generateThumb'), context);
  await assert.rejects(context.generateThumb('blob:full-resolution'), /Image decode failed/);
  assert.equal(canvases, 0); assert.equal(encodes, 0);
});
