const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const editor = fs.readFileSync(path.join(root, 'js/editor.js'), 'utf8');
const layout = fs.readFileSync(path.join(root, 'js/pdf-layout.js'), 'utf8');
function functionSource(source, name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  if (!match) throw new Error(`Missing production function ${name}`);
  return match[0];
}
function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

// Exercise the real exporter and download helpers. Encoding and native PDF
// preparation return fixtures, so byte counts can be checked independently
// of image complexity, compression choice or source file size.
function harness({ native = false, preserveQuality = false, outputSize = 3581 } = {}) {
  const fields = new Map(), urls = [], downloads = [], alerts = [], prepared = [], outputs = [], budgetChecks = [];
  const downloadReservations = new Map();
  const values = { pageSize: 'a4', orientation: 'auto', imgFit: 'contain', margin: '0',
    quality: '0.2', filename: 'measured', printDpi: '300', oversize: 'shrink', pdfContentMode: native ? 'preserve' : 'images' };
  let prepareHook = null, outputFailure = false, downloadFailure = false, budgetFailure = null;
  const sourceBytes = new Uint8Array(8192).subarray(128, 128 + outputSize);
  function element(id) {
    if (!fields.has(id)) fields.set(id, {
      id, value: values[id] || '', style: {}, textContent: '', disabled: false,
      classList: { add() {}, remove() {}, toggle() {} }, scrollIntoView() {}
    });
    return fields.get(id);
  }
  class TestPdf {
    addPage() {} addImage() {}
    output(type) {
      assert.equal(type, 'blob');
      if (outputFailure) throw new Error('Serialization failed');
      const blob = new Blob([new Uint8Array(outputSize)], { type: 'application/pdf' });
      outputs.push(blob);
      return blob;
    }
    save() { throw new Error('The exporter must serialize only once'); }
  }
  const image = { name: 'page', src: 'blob:original', originalSrc: 'blob:original',
    size: 123456789, rotation: 0, flipH: false, flipV: false, filters: {} };
  if (native) image.pdfSource = { sourceId: 'source', pageIndex: 0 };
  const context = vm.createContext({
    Blob, Uint8Array, images: [image], currentTab: 'convert', preserveOriginalQuality: preserveQuality,
    exportInProgress: false, pdfSources: new Map([['source', { bytes: sourceBytes }]]),
    lastExportReport: null,
    copyPdfSource: value => value && { ...value }, retainUrl() {}, releaseUrl() {},
    exportQuality: () => Number(element('quality').value), sanitizeFilename: name => name,
    updatePdfContentUI() {}, setExportProgress() {}, showToast() {},
    setTimeout: callback => { queueMicrotask(callback); },
    alert: text => alerts.push(text),
    fetch() { throw new Error('Size reporting must not fetch images'); },
    URL: {
      createObjectURL(blob) { urls.push(blob); return `blob:download-${urls.length}`; }, revokeObjectURL() {}
    },
    document: {
      getElementById: element,
      createElement(type) {
        assert.equal(type, 'a');
        return { href: '', download: '', remove() {},
          click() {
            if (downloadFailure) throw new Error('Download failed');
            downloads.push({ blob: urls.at(-1), filename: this.download });
          } };
      }, body: { appendChild() {} }
    },
    async preparePdfImage(image, options) {
      prepared.push({ image, options });
      if (prepareHook) await prepareHook();
      return { data: new Uint8Array([1]), format: 'JPEG', w: 400, h: 300 };
    },
    window: {
      jspdf: { jsPDF: TestPdf },
      PhotoPdfLimits: {
        assertExport(pages, sources, options) {
          budgetChecks.push({ kind: 'export', pages, sources, options });
          if (budgetFailure === 'export') throw new Error('Export memory budget exceeded');
        },
        assertOutputBytes(bytes) {
          budgetChecks.push({ kind: 'output', bytes });
          if (budgetFailure === 'output') throw new Error('Output memory budget exceeded');
        },
        reserveDownload(key, bytes) {
          if (budgetFailure === 'download') throw new Error('Download memory budget exceeded');
          downloadReservations.set(key, bytes);
        },
        releaseDownload(key) { downloadReservations.delete(key); }
      },
      PhotoPdfPreservation: {
        async prepareStructurePreservingPdf(pages) {
          prepared.push({ pages });
          if (prepareHook) await prepareHook();
          return { bytes: sourceBytes, exactOriginal: true, notice: '' };
        }
      }
    }
  });
  vm.runInContext(layout, context);
  vm.runInContext(['formatFileBytes', 'estimateExportSize', 'getExportReport', 'publishExportReport', 'generatePDF', 'downloadPdfBytes', 'downloadPdfBlob']
    .map(name => functionSource(app, name)).join('\n') + '\n' + functionSource(editor, 'showSizeInfo'), context);
  const run = code => vm.runInContext(code, context);
  return { context, run, element, prepared, outputs, urls, downloads, alerts, budgetChecks, sourceBytes, downloadReservations,
    onPrepare(hook) { prepareHook = hook; },
    failOutput() { outputFailure = true; }, failDownload() { downloadFailure = true; },
    failBudget(kind) { budgetFailure = kind; } };
}

test('unknown PDF size has no guessed number or image reads in any export mode', () => {
  for (const native of [false, true]) for (const preserveQuality of [false, true]) {
    const h = harness({ native, preserveQuality });
    h.element('sizeEstimate').textContent = 'Last exported PDF: 3 MB';
    h.run('estimateExportSize()');
    assert.equal(h.element('sizeEstimate').textContent, 'PDF size is measured after export.');
    assert.equal(h.prepared.length, 0);
    assert.equal(h.outputs.length, 0);
    h.run('images=[]; estimateExportSize()');
    assert.equal(h.element('sizeEstimate').textContent, '');
  }
});

for (const preserveQuality of [false, true]) {
  test(`image export measures the same downloaded Blob with preserve quality ${preserveQuality}`, async () => {
    const h = harness({ preserveQuality, outputSize: 3581 });
    await h.run('generatePDF()');
    assert.equal(h.alerts.length, 0);
    assert.equal(h.prepared.length, 1, 'No extra estimate encoding');
    assert.equal(h.outputs.length, 1, 'One PDF serialization');
    assert.equal(h.downloads.length, 1);
    assert.equal(h.downloads[0].blob, h.outputs[0]);
    assert.equal(h.downloads[0].blob.size, 3581);
    assert.equal(h.element('sizeEstimate').textContent, 'Last exported PDF: 3.5 KB (3,581 bytes)');
    assert.match(h.element('successDetail').textContent, /3\.5 KB \(3,581 bytes\)/);
    assert.equal(h.budgetChecks.at(-1).bytes, 3581);
    assert.equal(h.prepared[0].options.preserveQuality, preserveQuality);
  });
}

test('native export reports the returned byte view length, rather than preview or backing buffer size', async () => {
  const h = harness({ native: true, outputSize: 3581 });
  assert.equal(h.sourceBytes.buffer.byteLength, 8192);
  await h.run('generatePDF()');
  assert.equal(h.alerts.length, 0);
  assert.equal(h.outputs.length, 0);
  assert.equal(h.downloads[0].blob.size, 3581);
  assert.equal(h.element('sizeEstimate').textContent, 'Last exported PDF: 3.5 KB (3,581 bytes)');
  assert.equal(h.budgetChecks.at(-1).bytes, 3581);
  assert.equal(h.budgetChecks[0].options.rasterizeNative, false);
});

test('explicit image export includes native PDF previews in the raster budget', async () => {
  const h = harness({ native: true });
  h.element('pdfContentMode').value = 'images';
  await h.run('generatePDF()');
  assert.equal(h.alerts.length, 0);
  assert.equal(h.outputs.length, 1);
  assert.equal(h.budgetChecks[0].options.rasterizeNative, true);
});

test('new export clears the previous size while preparation is pending', async () => {
  const h = harness();
  const started = deferred(), finish = deferred();
  h.element('sizeEstimate').textContent = 'Last exported PDF: 999 MB';
  h.onPrepare(async () => { started.resolve(); await finish.promise; });
  const job = h.run('generatePDF()'); await started.promise;
  assert.equal(h.element('sizeEstimate').textContent, 'PDF size is measured after export.');
  assert.equal(h.outputs.length, 0);
  finish.resolve(); await job;
  assert.match(h.element('sizeEstimate').textContent, /^Last exported PDF:/);
});

test('captured export size remains explicitly about the exported file after the live document changes', async () => {
  const h = harness();
  const started = deferred(), finish = deferred();
  h.onPrepare(async () => { started.resolve(); await finish.promise; });
  const job = h.run('generatePDF()'); await started.promise;
  h.run('images=[]; estimateExportSize()');
  assert.equal(h.element('sizeEstimate').textContent, '');
  finish.resolve(); await job;
  assert.equal(h.element('sizeEstimate').textContent, 'Last exported PDF: 3.5 KB (3,581 bytes)');
});

for (const failure of ['serialization', 'download', 'export budget', 'output budget']) {
  test(`${failure} failure does not display a successful or stale measured size`, async () => {
    const h = harness();
    h.element('sizeEstimate').textContent = 'Last exported PDF: 999 MB';
    if (failure === 'serialization') h.failOutput();
    else if (failure === 'download') h.failDownload();
    else h.failBudget(failure.split(' ')[0]);
    await h.run('generatePDF()');
    assert.equal(h.alerts.length, 1);
    assert.equal(h.downloads.length, 0);
    assert.equal(h.element('sizeEstimate').textContent, 'PDF size is measured after export.');
    assert.equal(h.run('exportInProgress'), false);
    if (failure === 'export budget') assert.equal(h.prepared.length, 0);
  });
}

for (const native of [false, true]) {
  test(`download quota failure clears the previous size and unlocks ${native ? 'native' : 'image'} export`, async () => {
    const h = harness({ native });
    h.element('sizeEstimate').textContent = 'Last exported PDF: 999 MB';
    h.failBudget('download');
    await h.run('generatePDF()');
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0], /Download memory budget exceeded/);
    assert.equal(h.downloads.length, 0);
    assert.equal(h.urls.length, 0, 'Reservation refusal prevents URL allocation');
    assert.equal(h.downloadReservations.size, 0);
    assert.equal(h.element('sizeEstimate').textContent, 'PDF size is measured after export.');
    assert.equal(h.run('exportInProgress'), false);
    for (const id of ['convertBtn', 'editExportBtn', 'preserveQualityBtn']) {
      assert.equal(h.element(id).disabled, false);
    }
  });
}

test('resize reports current and requested dimensions without a bytes-per-pixel estimate', () => {
  const h = harness();
  h.run('showSizeInfo(1200,800,2400,1600)');
  const html = h.element('sizeInfo').innerHTML;
  assert.match(html, /Current:.*1200×800px/);
  assert.match(html, /Requested:.*2400×1600px/);
  assert.match(html, /File size depends on image content/);
  assert.doesNotMatch(html, /\d+\s*(?:KB|MB|bytes)/);
  assert.equal(h.prepared.length, 0);
});

test('size formatting includes an exact byte count at small and large sizes', () => {
  const h = harness();
  assert.equal(h.run('formatFileBytes(0)'), '0 bytes');
  assert.equal(h.run('formatFileBytes(1)'), '1 byte');
  assert.equal(h.run('formatFileBytes(1023)'), '1,023 bytes');
  assert.equal(h.run('formatFileBytes(1024)'), '1.0 KB (1,024 bytes)');
  assert.equal(h.run('formatFileBytes(1048576)'), '1.0 MB (1,048,576 bytes)');
  for (const value of ['-1', 'NaN', 'Infinity', '0.5']) {
    assert.throws(() => h.run(`formatFileBytes(${value})`), /Invalid file byte count/);
  }
});
