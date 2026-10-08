const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const app = fs.readFileSync(path.resolve(__dirname, '../js/app.js'), 'utf8');
const layout = fs.readFileSync(path.resolve(__dirname, '../js/pdf-layout.js'), 'utf8');
const exporter = app.slice(app.indexOf('let lastExportReport = null;'), app.indexOf('//  KEYBOARD SHORTCUTS'));
const productionFunction = name => app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0];
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}
function page(name, native = false) {
  return { name, src: 'blob:' + name, filters: {}, rotation: 0,
    ...(native ? { pdfSource: { sourceId: 'pdf', pageIndex: 0 } } : {}) };
}

function harness(pages, { tab = 'convert', native = false, filename = 'document' } = {}) {
  const elements = new Map(), downloads = [], alerts = [], toasts = [], progress = [], refs = new Map();
  let prepareHook = null, failure = null;
  const values = { pdfContentMode: native ? 'preserve' : 'images', pageSize: 'a4', orientation: 'auto',
    imgFit: 'contain', margin: '0', printDpi: '300', oversize: 'shrink', filename };
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { value: values[id] || '', textContent: '', hidden: false, dataset: {}, style: {},
        classList: { add: value => classes.add(value), remove: value => classes.delete(value),
          contains: value => classes.has(value) }, scrollIntoView() {} });
    }
    return elements.get(id);
  };
  class Pdf {
    addPage() {} addImage() {}
    output() { if (failure === 'serialize') throw new Error('Serialization failed'); return { size: 2345 }; }
  }
  const context = vm.createContext({
    images: pages, exportInProgress: false, currentTab: tab, preserveOriginalQuality: true,
    pdfSources: new Map([['pdf', { bytes: new Uint8Array([1, 2, 3]) }]]),
    copyPdfSource: value => value && { ...value }, updatePdfContentUI() {},
    estimateExportSize() {}, exportQuality: () => 0.8,
    setTimeout: callback => queueMicrotask(callback),
    document: { getElementById: element },
    setExportProgress: (...args) => progress.push(args),
    alert: message => alerts.push(message), showToast: message => toasts.push(message),
    retainUrl: src => refs.set(src, (refs.get(src) || 0) + 1),
    releaseUrl: src => refs.set(src, (refs.get(src) || 0) - 1),
    async preparePdfImage(image, options) {
      if (prepareHook) return prepareHook(image, options);
      return { w: 200, h: 100, data: image.src, format: 'JPEG' };
    },
    bridgeDownload(blob, filename) {
      if (failure === 'download') throw new Error('Download failed');
      downloads.push({ bytes: blob.size, filename });
    },
    bridgeNativeDownload(bytes, filename) {
      if (failure === 'download') throw new Error('Download failed');
      downloads.push({ bytes: bytes.byteLength, filename });
    },
    window: {
      jspdf: { jsPDF: Pdf },
      PhotoPdfPreservation: { async prepareStructurePreservingPdf(pages, options) {
        options.onProgress(0, pages.length);
        for (let index = 0; index < pages.length; index++) {
          const image = { ...pages[index] };
          if (!image.pdfSource) {
            const rendered = await options.prepareImage(image, options.imageOptions);
            if (!rendered) throw new Error('Could not decode image. No incomplete PDF was exported.');
          }
          options.onProgress(index + 1, pages.length);
        }
        if (failure === 'native') throw new Error('Native source is unavailable');
        return { bytes: new Uint8Array([1, 2, 3]), notice: '' };
      } }
    }
  });
  vm.runInContext(layout + '\n' + productionFunction('formatFileBytes') + '\n' + productionFunction('sanitizeFilename') +
    '\n' + exporter + '\ndownloadPdfBlob=bridgeDownload;downloadPdfBytes=bridgeNativeDownload;', context);
  return { context, element, downloads, alerts, toasts, progress, refs,
    run: code => vm.runInContext(code, context), report: () => plain(context.getExportReport()),
    onPrepare(hook) { prepareHook = hook; }, fail(kind) { failure = kind; } };
}

for (const tab of ['convert', 'edit']) {
  test(`partial ${tab} export persists source positions, names, reasons and an explicit partial result`, async () => {
    const h = harness([page('first'), page('<img src=x onerror=alert(1)>'), page('last')], { tab });
    h.onPrepare(async image => image.name === 'first' || image.name === 'last'
      ? { w: 200, h: 100, data: image.src, format: 'JPEG' } : null);
    await h.run('generatePDF()');
    assert.equal(h.downloads.length, 1);
    assert.equal(h.alerts.length, 0);
    const report = h.report();
    assert.equal(report.status, 'partial');
    assert.equal(report.requestedPages, 3); assert.equal(report.exportedPages, 2);
    assert.deepEqual(report.skipped, [{ position: 2, name: '<img src=x onerror=alert(1)>',
      reason: 'The image could not be decoded for PDF export.' }]);
    assert.match(h.element('exportReport').textContent, /^Partial PDF saved/);
    assert.match(h.element('exportReport').textContent, /Page 2: <img src=x onerror=alert\(1\)>/);
    assert.equal('innerHTML' in h.element('exportReport'), false, 'Names are assigned as text');
    assert.equal(h.element('exportReport').hidden, false);
    assert.match(h.element('successTitle').textContent, /^Partial PDF saved/);
    assert.equal(h.element('successMsg').dataset.status, 'partial');
    assert.match(h.element('successDetail').textContent, /^2 of 3 pages/);
    assert.match(h.element('pdfExportNotice').textContent, /^Partial export: 2 of 3 pages/);
    assert.match(h.toasts[0], /^Partial PDF saved/);
    assert.equal(h.element('successMsg').classList.contains('on'), tab === 'convert');
    assert.ok(h.progress.some(args => /Finalizing partial PDF/.test(args[1])));
    assert.equal(h.run('exportInProgress'), false);
    assert.ok([...h.refs.values()].every(count => count === 0));
  });
}

test('all unreadable pages persist each source name and position without producing a download', async () => {
  const h = harness([page('duplicate-name'), page('duplicate-name')]);
  h.onPrepare(async () => null);
  await h.run('generatePDF()');
  const report = h.report();
  assert.equal(h.downloads.length, 0); assert.equal(h.alerts.length, 1);
  assert.equal(report.status, 'failed'); assert.equal(report.exportedPages, 0);
  assert.deepEqual(report.skipped.map(page => page.position), [1, 2]);
  assert.match(h.element('exportReport').textContent, /^Export failed — no PDF was downloaded/);
  assert.equal(h.element('successMsg').classList.contains('on'), false);
  assert.equal(h.element('pdfExportNotice').hidden, true);
});

test('a fatal page error stops download and persists its source name, position and actionable reason', async () => {
  const h = harness([page('first'), page('oversized'), page('last')]);
  h.onPrepare(async image => {
    if (image.name === 'oversized') throw new Error('Decoded image exceeds the memory limit');
    return { w: 200, h: 100, data: image.src, format: 'JPEG' };
  });
  await h.run('generatePDF()');
  const report = h.report();
  assert.equal(h.downloads.length, 0); assert.equal(report.exportedPages, 0);
  assert.equal(report.status, 'failed'); assert.deepEqual(report.skipped,
    [{ position: 2, name: 'oversized', reason: 'Decoded image exceeds the memory limit' }]);
  assert.equal(h.run('exportInProgress'), false);
});

test('a failed mixed native export identifies an unreadable raster page and does not export incomplete native content', async () => {
  const h = harness([page('native', true), page('bad photo')], { native: true, tab: 'edit' });
  h.onPrepare(async () => null);
  await h.run('generatePDF()');
  const report = h.report();
  assert.equal(h.downloads.length, 0); assert.equal(report.status, 'failed');
  assert.deepEqual(report.skipped, [{ position: 2, name: 'bad photo',
    reason: 'The image could not be decoded for PDF export.' }]);
  assert.match(h.element('exportReport').textContent, /No incomplete PDF was exported/);
});

for (const kind of ['serialize', 'download', 'native']) {
  test(`${kind} failure persists a failed result without a stale success banner`, async () => {
    const h = harness([page('source', kind === 'native')], { native: kind === 'native' });
    await h.run('generatePDF()');
    assert.equal(h.report().status, 'complete');
    h.fail(kind);
    await h.run('generatePDF()');
    assert.equal(h.report().status, 'failed'); assert.equal(h.report().exportedPages, 0);
    assert.equal(h.element('successMsg').classList.contains('on'), false);
    assert.equal(h.element('pdfExportNotice').hidden, true);
    assert.equal(h.downloads.length, 1);
  });
}

test('partial report describes the captured document even after its live pages and filename change', async () => {
  const h = harness([page('original first'), page('original missing')], { filename: 'original.PDF.pdf' });
  const started = deferred(), finish = deferred();
  h.onPrepare(async image => {
    if (image.name === 'original first') {
      started.resolve(); await finish.promise;
      return { w: 200, h: 100, data: image.src, format: 'JPEG' };
    }
    return null;
  });
  const job = h.run('generatePDF()'); await started.promise;
  h.run('images[1].name="mutated"; images=[]; currentTab="edit";');
  h.element('filename').value = 'changed';
  finish.resolve(); await job;
  assert.equal(h.report().filename, 'original.pdf');
  assert.equal(h.report().requestedPages, 2);
  assert.equal(h.report().skipped[0].name, 'original missing');
  assert.equal(h.downloads[0].filename, 'original.pdf');
  assert.match(h.element('exportReport').textContent, /original missing/);
});

test('report copies do not expose mutable internal state or retain image byte references', async () => {
  const h = harness([page('missing')]); h.onPrepare(async () => null);
  await h.run('generatePDF()');
  h.run('const report=getExportReport(); report.filename="mutated"; report.skipped[0].name="mutated"; report.skipped.push({});');
  assert.equal(h.report().filename, 'document.pdf'); assert.equal(h.report().skipped[0].name, 'missing');
  assert.equal(h.report().skipped.length, 1);
  assert.deepEqual(Object.keys(h.report().skipped[0]).sort(), ['name', 'position', 'reason']);
});

test('a later complete export replaces an earlier partial report and restores full success wording', async () => {
  const h = harness([page('good'), page('bad')]);
  h.onPrepare(async image => image.name === 'bad' ? null : { w: 200, h: 100, data: image.src, format: 'JPEG' });
  await h.run('generatePDF()'); assert.equal(h.report().status, 'partial');
  h.onPrepare(null);
  await h.run('generatePDF()');
  assert.equal(h.report().status, 'complete'); assert.deepEqual(h.report().skipped, []);
  assert.equal(h.element('successTitle').textContent, 'Thy tome is forged');
  assert.equal(h.element('successMsg').dataset.status, 'complete');
  assert.doesNotMatch(h.element('exportReport').textContent, /Partial|Pages not included/);
  assert.equal(h.element('pdfExportNotice').textContent.startsWith('Last exported PDF:'), true);
});

test('a missing PDF library replaces previous success with a persistent failure and restores controls', async () => {
  const h = harness([page('photo')]); await h.run('generatePDF()');
  assert.equal(h.report().status, 'complete');
  h.context.window.jspdf = null;
  await h.run('generatePDF()');
  assert.equal(h.downloads.length, 1); assert.equal(h.report().status, 'failed');
  assert.match(h.element('exportReport').textContent, /PDF export library is unavailable/);
  assert.equal(h.element('successMsg').classList.contains('on'), false);
  assert.equal(h.run('exportInProgress'), false);
  assert.equal(h.element('convertBtn').disabled, false);
});

for (const filename of ['report.pdf', 'report.PDF .pdf', ' .pdf .PDF ', 'report']) {
  test(`actual exported download normalizes exactly one PDF extension for ${JSON.stringify(filename)}`, async () => {
    const h = harness([page('photo')], { filename }); await h.run('generatePDF()');
    const expected = filename.includes('report') ? 'report.pdf' : 'my-photos.pdf';
    assert.equal(h.downloads[0].filename, expected); assert.equal(h.report().filename, expected);
  });
}
