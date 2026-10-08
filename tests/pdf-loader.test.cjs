// Run with: node --experimental-vm-modules --test tests/pdf-loader.test.cjs
// This tests the production loader's policy and asynchronous behavior using
// a mocked PDF.js ESM module; actual parsing/rendering needs a browser check.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/pdf-loader.js'), 'utf8');
const version = '6.3.289';
const packageUrl = 'https://example.test/personal-tools/photo-pdf/vendor/pdfjs/';

function harness(config = {}) {
  const imports = [];
  const calls = [];
  const workerOptions = {};
  let documentDestroyed = 0;
  const document = { numPages: 1 };
  if (!config.noDocumentDestroy) document.destroy = async function () { documentDestroyed++; };
  let destroyed = 0;
  const context = vm.createContext({ window: {}, ArrayBuffer, Uint8Array, URL,
    document: { currentScript: { src: 'https://example.test/personal-tools/photo-pdf/js/pdf-loader.js' } } });
  const module = new vm.SyntheticModule(['version', 'GlobalWorkerOptions', 'getDocument'], function () {
    this.setExport('version', config.version || version);
    this.setExport('GlobalWorkerOptions', workerOptions);
    this.setExport('getDocument', function (options) {
      calls.push(options);
      if (config.onGetDocument) config.onGetDocument();
      return {
        promise: config.pdfPromise || (config.pdfError ? Promise.reject(config.pdfError) : Promise.resolve(document)),
        destroy: async function () { destroyed++; if (config.onDestroy) await config.onDestroy(); }
      };
    });
  }, { context });
  const script = new vm.Script(source, {
    importModuleDynamically: async function (url) {
      imports.push(url);
      if (config.importError) throw config.importError;
      if (config.gate) await config.gate;
      if (module.status === 'unlinked') await module.link(() => {});
      if (module.status !== 'evaluated') await module.evaluate();
      return module;
    }
  });
  script.runInContext(context);
  return { api: context.window.PhotoPdfLibraries, imports, calls, workerOptions,
    document, get destroyed() { return destroyed; }, get documentDestroyed() { return documentDestroyed; } };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function cancelJob() {
  let current = true, subscribed = 0, unsubscribed = 0;
  const callbacks = new Set();
  return {
    isCurrent: () => current,
    onCancel(callback) {
      subscribed++; callbacks.add(callback);
      return () => { if (callbacks.delete(callback)) unsubscribed++; };
    },
    cancel() { current = false; callbacks.forEach(callback => callback()); },
    stats: () => ({ subscribed, unsubscribed, active: callbacks.size })
  };
}

test('loading the page does not fetch PDF.js', function () {
  const h = harness();
  assert.equal(h.imports.length, 0);
  assert.equal(typeof h.api.openPdfDocument, 'function');
  assert.equal(h.api.pdfjsVersion, version);
});

test('concurrent opens await one import and use the matching patched worker', async function () {
  let ready;
  const h = harness({ gate: new Promise(resolve => { ready = resolve; }) });
  const first = h.api.openPdfDocument({ data: new Uint8Array([1]) });
  const second = h.api.openPdfDocument({ data: new Uint8Array([2]), password: 'secret' });
  assert.equal(h.calls.length, 0);
  ready();
  const documents = await Promise.all([first, second]);
  assert.equal(h.imports.length, 1);
  assert.equal(h.imports[0], packageUrl + 'legacy/build/pdf.min.mjs');
  assert.equal(h.workerOptions.workerSrc, packageUrl + 'legacy/build/pdf.worker.min.mjs');
  assert.equal(h.calls[1].password, 'secret');
  assert.ok(documents.every(document => document === h.document));
});

test('all calls force eval off, including a caller attempting to enable it', async function () {
  const h = harness();
  const options = { data: new Uint8Array([5, 6]), isEvalSupported: true };
  await h.api.openPdfDocument(options);
  await h.api.openPdfDocument({ data: new Uint8Array([7]), password: 'retry' });
  assert.ok(h.calls.every(options => options.isEvalSupported === false));
  assert.equal(options.isEvalSupported, true, 'caller options remain unchanged');
  assert.equal(h.calls[0].cMapUrl, packageUrl + 'cmaps/');
  assert.equal(h.calls[0].standardFontDataUrl, packageUrl + 'standard_fonts/');
  assert.equal(h.calls[0].wasmUrl, packageUrl + 'wasm/');
  assert.equal(h.calls[0].iccUrl, packageUrl + 'iccs/');
});

test('callers cannot redirect rendering assets to external servers', async function () {
  const h = harness();
  await h.api.openPdfDocument({ data: new Uint8Array([1]), cMapUrl: 'https://other.test/cmaps/',
    standardFontDataUrl: 'https://other.test/fonts/', wasmUrl: 'https://other.test/wasm/',
    iccUrl: 'https://other.test/iccs/', cMapPacked: false });
  const parameters = h.calls[0];
  assert.equal(parameters.cMapUrl, packageUrl + 'cmaps/');
  assert.equal(parameters.standardFontDataUrl, packageUrl + 'standard_fonts/');
  assert.equal(parameters.wasmUrl, packageUrl + 'wasm/');
  assert.equal(parameters.iccUrl, packageUrl + 'iccs/');
  assert.equal(parameters.cMapPacked, true);
});

test('PDF.js 6 proxies expose the importer cleanup hook through their loading task', async function () {
  const h = harness({ noDocumentDestroy: true });
  const document = await h.api.openPdfDocument({ data: new Uint8Array([1]) });
  assert.equal(typeof document.destroy, 'function');
  await document.destroy();
  await document.destroy();
  assert.equal(h.destroyed, 1);
});

test('password retries retain original bytes and failed tasks release resources', async function () {
  const passwordError = Object.assign(new Error('Password required'), { name: 'PasswordException' });
  const h = harness({ pdfError: passwordError });
  const bytes = new Uint8Array([1, 2, 3]);
  await assert.rejects(h.api.openPdfDocument({ data: bytes }), error => error === passwordError);
  h.calls[0].data.fill(0);
  await assert.rejects(h.api.openPdfDocument({ data: bytes, password: 'retry' }), error => error === passwordError);
  assert.deepEqual(Array.from(h.calls[1].data), [1, 2, 3]);
  assert.deepEqual(Array.from(bytes), [1, 2, 3]);
  assert.equal(h.destroyed, 2);
});

test('a parser with the wrong version is rejected without opening documents', async function () {
  const h = harness({ version: '3.11.174' });
  await assert.rejects(h.api.openPdfDocument({ data: new Uint8Array([1]) }), function (error) {
    assert.equal(error.name, 'PdfLibraryLoadError');
    assert.match(error.cause.message, /version does not match/);
    return true;
  });
  assert.equal(h.calls.length, 0);
});

test('dependency failure gives an actionable error and no insecure fallback', async function () {
  const h = harness({ importError: new Error('Offline') });
  await assert.rejects(h.api.openPdfDocument({ data: new Uint8Array([1]) }), function (error) {
    assert.equal(error.name, 'PdfLibraryLoadError');
    assert.match(error.message, /complete app folder was uploaded/);
    return true;
  });
  assert.equal(h.calls.length, 0);
  assert.equal(h.imports.length, 1);
});

test('index loads the safe local wrapper and does not load the vulnerable parser', function () {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.doesNotMatch(html, /pdf\.js\/3\.11\.174/);
  assert.match(html, /<script src="js\/pdf-loader\.js"><\/script>/);
});

test('cancellation before library readiness never starts a PDF loading task', async () => {
  const ready = deferred(), h = harness({ gate: ready.promise }), job = cancelJob();
  const pending = h.api.openPdfDocument({ data: new Uint8Array([1]) }, job);
  job.cancel(); ready.resolve();
  await assert.rejects(pending, { name: 'ImportCanceledError' });
  assert.equal(h.calls.length, 0); assert.equal(h.destroyed, 0);
  assert.deepEqual(job.stats(), { subscribed: 0, unsubscribed: 0, active: 0 });
});

test('canceling an active parser stops its loading task and rejects a late successful document', async () => {
  const parser = deferred(), started = deferred(), job = cancelJob();
  const h = harness({ pdfPromise: parser.promise, onGetDocument: () => started.resolve() });
  const pending = h.api.openPdfDocument({ data: new Uint8Array([1]) }, job);
  await started.promise;
  job.cancel();
  assert.ok(h.destroyed >= 1, 'Cancellation must destroy the loading task before its promise settles');
  parser.resolve(h.document);
  await assert.rejects(pending, { name: 'ImportCanceledError' });
  assert.equal(h.documentDestroyed, 1, 'A late document must release its worker and transport');
  assert.deepEqual(job.stats(), { subscribed: 1, unsubscribed: 1, active: 0 });
});

test('an active parser canceled through its loading-task rejection unsubscribes cleanup', async () => {
  const parser = deferred(), started = deferred(), job = cancelJob();
  const cancelError = Object.assign(new Error('PDF task destroyed'), { name: 'AbortException' });
  const h = harness({ pdfPromise: parser.promise, onGetDocument: () => started.resolve(), onDestroy: () => parser.reject(cancelError) });
  const pending = h.api.openPdfDocument({ data: new Uint8Array([1]) }, job);
  await started.promise; job.cancel();
  await assert.rejects(pending);
  assert.ok(h.destroyed >= 1); assert.equal(h.documentDestroyed, 0);
  assert.deepEqual(job.stats(), { subscribed: 1, unsubscribed: 1, active: 0 });
});

test('successful loading removes cancellation hooks and never forwards the job to PDF.js', async () => {
  const h = harness(), job = cancelJob();
  assert.equal(await h.api.openPdfDocument({ data: new Uint8Array([1]), password: 'secret' }, job), h.document);
  assert.deepEqual(job.stats(), { subscribed: 1, unsubscribed: 1, active: 0 });
  assert.ok(!Object.values(h.calls[0]).includes(job));
  assert.equal(h.calls[0].onCancel, undefined); assert.equal(h.calls[0].isCurrent, undefined);
  assert.equal(h.calls[0].password, 'secret'); assert.equal(h.calls[0].isEvalSupported, false);
  job.cancel(); assert.equal(h.destroyed, 0); assert.equal(h.documentDestroyed, 0);
});

test('failed loading removes its cancellation hook while retaining the original parser error', async () => {
  const parseError = new Error('Malformed PDF'), h = harness({ pdfError: parseError }), job = cancelJob();
  await assert.rejects(h.api.openPdfDocument({ data: new Uint8Array([1]) }, job), error => error === parseError);
  assert.equal(h.destroyed, 1); assert.deepEqual(job.stats(), { subscribed: 1, unsubscribed: 1, active: 0 });
  job.cancel(); assert.equal(h.destroyed, 1);
});
