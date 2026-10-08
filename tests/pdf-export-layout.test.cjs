const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const layoutSource = fs.readFileSync(path.join(root, 'js/pdf-layout.js'), 'utf8');
const exportSource = appSource.slice(appSource.indexOf('let lastExportReport = null;'),
  appSource.indexOf('//  KEYBOARD SHORTCUTS'));
const settingsSource = appSource.slice(appSource.indexOf('const SETTING_IDS'),
  appSource.indexOf('function updatePreserveQualityUI()'));
const controlsSource = appSource.slice(appSource.indexOf('function updatePrintSizeUI()'),
  appSource.indexOf('// Source image bytes'));
const sizeSource = appSource.slice(appSource.indexOf('function formatFileBytes('),
  appSource.indexOf("['pageSize','orientation','imgFit','margin','quality','printDpi','oversize','pdfContentMode'].forEach"));

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}
function entry(name, width, height, extras = {}) {
  return { _id: name, _pageId: name, name, src: `blob:${name}`, originalSrc: `blob:${name}`,
    rotation: 0, flipH: false, flipV: false, filters: {}, pixelWidth: width, pixelHeight: height, ...extras };
}
function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `Expected ${expected}; received ${actual}`);
}
function format(actual, width, height) {
  close(actual[0], width); close(actual[1], height);
}

function harness(images = [], settings = {}) {
  const fields = new Map(), records = [], alerts = [], toasts = [], progress = [];
  const refs = new Map(), storage = new Map();
  let prepareHook = null;
  const initial = { pageSize: 'a4', orientation: 'portrait', imgFit: 'contain', margin: '0',
    quality: '0.9', filename: 'Example', printDpi: '300', oversize: 'shrink', ...settings };
  function element(id) {
    if (!fields.has(id)) {
      const classes = new Set();
      fields.set(id, { value: initial[id] || '', textContent: '', disabled: false,
        classList: { add: name => classes.add(name), remove: name => classes.delete(name),
          contains: name => classes.has(name),
          toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } }, scrollIntoView() {} });
    }
    return fields.get(id);
  }
  class FakePDF {
    constructor(options) {
      this.record = { pages: [{ format: [...options.format], orientation: options.orientation }],
        options, calls: [], saved: null };
      records.push(this.record);
    }
    addPage(size, orientation) {
      this.record.pages.push({ format: [...size], orientation });
      this.record.calls.push(['addPage', [...size], orientation]);
    }
    addImage(...args) { this.record.calls.push(['addImage', ...args]); }
    output(type) { assert.equal(type, 'blob'); return { size: 100, record: this.record }; }
  }
  for (const method of ['saveGraphicsState', 'rect', 'clip', 'discardPath', 'restoreGraphicsState']) {
    FakePDF.prototype[method] = function (...args) { this.record.calls.push([method, ...args]); };
  }
  const context = vm.createContext({
    images, preserveOriginalQuality: false, currentTab: 'convert', exportInProgress: false,
    pdfSources: new Map(), copyPdfSource: value => value, updatePdfContentUI() {},
    window: { jspdf: { jsPDF: FakePDF } },
    document: { getElementById: element },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    setTimeout: callback => queueMicrotask(callback),
    exportQuality: () => 0.9, sanitizeFilename: value => value,
    retainUrl: url => refs.set(url, (refs.get(url) || 0) + 1),
    releaseUrl: url => refs.set(url, (refs.get(url) || 0) - 1),
    alert: value => alerts.push(value), showToast: value => toasts.push(value),
    setExportProgress: (...args) => progress.push(args),
    bridgeDownload(blob, filename) { blob.record.saved = filename; },
    async preparePdfImage(image, options) {
      if (prepareHook) await prepareHook(image, options);
      return { w: image.pixelWidth, h: image.pixelHeight, data: `data:${image.name}`, format: 'JPEG' };
    }
  });
  vm.runInContext(layoutSource, context);
  vm.runInContext(exportSource + '\n' + settingsSource + '\n' + controlsSource + '\n' + sizeSource +
    '\ndownloadPdfBlob=bridgeDownload;', context);
  return { context, fields, records, alerts, toasts, progress, refs, storage, element,
    export: () => context.generatePDF(),
    onPrepare: hook => { prepareHook = hook; } };
}

test('the runtime exporter retains an imported A4 page at 210 by 297 mm', async () => {
  const h = harness([entry('A4.pdf', 1191, 1684, { pdfPageSizeMm: { width: 210, height: 297 } })],
    { pageSize: 'fit', orientation: 'auto' });
  await h.export();
  assert.equal(h.alerts.length, 0);
  assert.equal(h.records.length, 1);
  format(h.records[0].pages[0].format, 210, 297);
  assert.equal(h.records[0].pages[0].orientation, 'p');
  assert.equal(h.records[0].saved, 'Example.pdf');
  assert.equal(h.element('convertBtn').disabled, false);
  assert.equal(h.refs.get('blob:A4.pdf'), 0);
});

test('runtime export uses distinct page formats for mixed PDF sizes and pending rotations', async () => {
  const h = harness([
    entry('portrait', 1191, 1684, { pdfPageSizeMm: { width: 210, height: 297 } }),
    entry('letter', 1224, 1584, { pdfPageSizeMm: { width: 215.9, height: 279.4 } }),
    entry('rotated', 1684, 1191, { rotation: 90, pdfPageSizeMm: { width: 210, height: 297 } })
  ], { pageSize: 'fit', orientation: 'auto' });
  await h.export();
  assert.equal(h.alerts.length, 0);
  const pages = h.records[0].pages;
  assert.equal(pages.length, 3);
  format(pages[0].format, 210, 297); format(pages[1].format, 215.9, 279.4);
  format(pages[2].format, 297, 210);
  assert.equal(pages[2].orientation, 'l');
});

test('the runtime fill exporter clips image content to the area inside the margins', async () => {
  const h = harness([entry('wide', 4000, 1000)], { imgFit: 'fill', margin: '10' });
  await h.export();
  assert.equal(h.alerts.length, 0);
  assert.deepEqual(h.records[0].calls.map(call => call[0]),
    ['saveGraphicsState', 'rect', 'clip', 'discardPath', 'addImage', 'restoreGraphicsState']);
  assert.deepEqual(h.records[0].calls[1], ['rect', 10, 10, 190, 277, null]);
  assert.match(h.element('successDetail').textContent, /1 cropped within margins/);
});

for (const [orientation, width, height, expectedOrientation] of [
  ['portrait', 50.8, 67.73333333333333, 'p'],
  ['landscape', 67.73333333333333, 50.8, 'l']
]) {
  test(`runtime Fit to image honors forced ${orientation}`, async () => {
    const h = harness([entry('photo', 600, 800)], { pageSize: 'fit', orientation, printDpi: '300' });
    await h.export();
    assert.equal(h.alerts.length, 0);
    format(h.records[0].pages[0].format, width, height);
    assert.equal(h.records[0].pages[0].orientation, expectedOrientation);
    const image = h.records[0].calls.find(call => call[0] === 'addImage');
    close(image[5] / image[6], 600 / 800);
  });
}

test('print DPI and crop policy are captured before asynchronous image preparation', async () => {
  const h = harness([entry('oversized', 6000, 4000)],
    { imgFit: 'actual', printDpi: '300', oversize: 'crop', margin: '10' });
  const started = deferred(), finish = deferred();
  h.onPrepare(async () => { started.resolve(); await finish.promise; });
  const job = h.export();
  await started.promise;
  h.element('printDpi').value = '600';
  h.element('oversize').value = 'shrink';
  h.element('orientation').value = 'landscape';
  h.element('margin').value = '0';
  finish.resolve(); await job;
  const image = h.records[0].calls.find(call => call[0] === 'addImage');
  close(image[5], 508); close(image[6], 4000 * 25.4 / 300);
  assert.deepEqual(h.records[0].calls[1], ['rect', 10, 10, 190, 277, null]);
  assert.match(h.element('successDetail').textContent, /1 cropped within margins/);
  assert.doesNotMatch(h.element('successDetail').textContent, /scaled down/);
});

test('runtime export retains independent copies of physical dimensions across awaits', async () => {
  const page = entry('imported', 1191, 1684, { pdfPageSizeMm: { width: 210, height: 297 } });
  const h = harness([page], { pageSize: 'fit', orientation: 'auto' });
  const started = deferred(), finish = deferred();
  h.onPrepare(async () => { started.resolve(); await finish.promise; });
  const job = h.export(); await started.promise;
  page.pdfPageSizeMm.width = 297;
  page.pdfPageSizeMm.height = 210;
  page.rotation = 90;
  finish.resolve(); await job;
  format(h.records[0].pages[0].format, 210, 297);
});

test('runtime print-size shrinking is reported in the saved result', async () => {
  const h = harness([entry('oversized', 6000, 4000)],
    { imgFit: 'actual', printDpi: '300', oversize: 'shrink', margin: '10' });
  await h.export();
  const image = h.records[0].calls.find(call => call[0] === 'addImage');
  close(image[5], 190); close(image[6], 190 / 1.5);
  assert.match(h.element('successDetail').textContent, /1 scaled down to fit/);
  assert.match(h.toasts[0], /1 scaled down to fit/);
});

test('invalid needed photo DPI fails export with resource and control cleanup', async () => {
  const h = harness([entry('photo', 600, 800)], { imgFit: 'actual', printDpi: '0' });
  await h.export();
  assert.equal(h.records.length, 0);
  assert.match(h.alerts[0], /DPI/);
  assert.equal(h.element('convertBtn').disabled, false);
  assert.equal(h.element('preserveQualityBtn').disabled, false);
  assert.equal(h.refs.get('blob:photo'), 0);
  assert.deepEqual(h.progress.at(-1), [false]);
});

test('fixed-paper contain exports successfully with an unused invalid DPI field', async () => {
  const h = harness([entry('photo', 600, 800)], { printDpi: '0' });
  await h.export();
  assert.equal(h.alerts.length, 0);
  assert.equal(h.records[0].saved, 'Example.pdf');
});

test('print DPI and oversize policy survive a settings save and restore', () => {
  const h = harness([], { printDpi: '150', oversize: 'crop' });
  h.context.saveSettings();
  const saved = JSON.parse(h.storage.get('photopdf-settings'));
  assert.equal(saved.printDpi, '150'); assert.equal(saved.oversize, 'crop');
  h.element('printDpi').value = '300'; h.element('oversize').value = 'shrink';
  h.context.restoreSettings();
  assert.equal(h.element('printDpi').value, '150'); assert.equal(h.element('oversize').value, 'crop');
});

test('print-size controls and explanations follow the selected layout mode', () => {
  const h = harness();
  h.context.updatePrintSizeUI();
  assert.equal(h.element('printDpi').disabled, true);
  assert.equal(h.element('oversize').disabled, true);
  h.element('pageSize').value = 'fit';
  h.context.updatePrintSizeUI();
  assert.equal(h.element('printDpi').disabled, false);
  assert.equal(h.element('oversize').disabled, true);
  h.element('pageSize').value = 'a4'; h.element('imgFit').value = 'actual';
  h.element('oversize').value = 'crop';
  h.context.updatePrintSizeUI();
  assert.equal(h.element('printDpi').disabled, false);
  assert.equal(h.element('oversize').disabled, false);
  assert.match(h.element('printSizeHint').textContent, /keeps its print size.*cropped within the margins/);
  h.element('oversize').value = 'shrink'; h.context.updatePrintSizeUI();
  assert.match(h.element('printSizeHint').textContent, /scaled down to fit/);
});
