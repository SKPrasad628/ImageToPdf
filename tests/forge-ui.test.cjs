const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const appSource = ['js/raster-limits.js', 'js/pdf-layout.js', 'js/app.js', 'js/import-queue.js']
  .map(read).join('\n');
const uiSource = read('js/forge-ui.js');
const plain = value => JSON.parse(JSON.stringify(value));

// Run the actual document/history, selection, keyboard, and download functions.
// DOM drawing and user-agent download behavior are the only mocked boundaries.
function harness({ realLightbox = false, autoTimers = false } = {}) {
  const elements = new Map(), documentListeners = new Map(), windowListeners = new Map();
  const mediaListeners = new Map();
  const timers = new Map(), links = [], createdUrls = [], revoked = [], focus = [], calls = [];
  let serial = 0, failClick = false;
  const values = { pageSize: 'a4', orientation: 'auto', imgFit: 'contain', margin: '10',
    quality: '0.85', filename: 'test-document', printDpi: '300', oversize: 'shrink', pdfContentMode: 'preserve' };
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set(), listeners = new Map();
    const el = { id, tagName: 'DIV', dataset: {}, style: {}, value: values[id] || '',
      hidden: false, disabled: false, open: false, children: [],
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); return on; }
      },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(name, callback) { listeners.set(name, callback); },
      appendChild(child) { child.parentElement = this; this.children.push(child); },
      focus() { focus.push(id); }, scrollIntoView() {},
      remove() { this.removed = true; },
      showModal() { this.open = true; }, close() { this.open = false; },
      fire(name, event) { listeners.get(name)?.(event); }
    };
    elements.set(id, el);
    return el;
  }
  const actions = ['earlier', 'later', 'rotate', 'duplicate', 'edit', 'view'].map(name => {
    const button = element('action-' + name); button.dataset.pageAction = name; return button;
  });
  const cards = [], checks = [], previewButtons = [];
  const dialogs = ['toolsDialog', 'aboutDialog', 'privacyDialog'].map(element);
  const context = vm.createContext({
    console,
    setTimeout(callback, delay) {
      const id = ++serial; timers.set(id, { callback, delay });
      if (autoTimers) queueMicrotask(() => { if (timers.delete(id)) callback(); });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    URL: {
      createObjectURL(blob) { const url = 'blob:output-' + (createdUrls.length + 1); createdUrls.push({ url, blob }); return url; },
      revokeObjectURL(url) { revoked.push(url); }
    },
    document: {
      getElementById: element, body: element('body'), activeElement: { tagName: 'BODY' },
      querySelector(selector) {
        const page = selector.match(/^\[data-preview-page="(\d+)"\]$/);
        return page ? previewButtons[Number(page[1])] || null : element(selector);
      },
      querySelectorAll(selector) {
        if (selector === '[data-page-action]') return actions;
        if (selector === '.forge-dialog') return dialogs;
        if (selector === '.img-card') return cards;
        if (selector === '[data-select-page]') return checks;
        if (selector === '[data-preview-page]') return previewButtons;
        return [];
      },
      createElement(tag) {
        const el = element('created-' + tag + '-' + ++serial);
        if (tag === 'a') {
          links.push(el);
          el.click = function () { if (failClick) throw new Error('Download click failed'); this.clicked = true; };
        }
        return el;
      },
      addEventListener(name, callback) { documentListeners.set(name, callback); }, removeEventListener() {}
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    confirm() { return true; }, alert(message) { calls.push(['alert', message]); },
    addEventListener(name, callback) { windowListeners.set(name, callback); },
    matchMedia(query) { return { matches: true,
      addEventListener(name, callback) { mediaListeners.set(query + ':' + name, callback); } }; },
    bridgeCall(...args) { calls.push(args); }
  });
  context.window = context;
  vm.runInContext(appSource, context);
  vm.runInContext(`
    render = () => { updateSelectionUI(); updatePdfContentUI(); };
    renderPdfEditor = () => {};
    openEditorFor = i => bridgeCall('edit', i);
    showToast = message => bridgeCall('toast', message);
  `, context);
  if (!realLightbox) vm.runInContext(`openLightbox = i => bridgeCall('view', i);`, context);
  vm.runInContext(uiSource, context);
  const run = code => vm.runInContext(code, context);
  function seed() {
    run(`for (const name of ['A', 'B', 'C']) {
      const id = _imgId(), src = 'blob:source-' + name;
      putStore(id, { src, originalSrc: src, thumb: src });
      images.push({ _id: id, _pageId: 'page-' + name, name, src, originalSrc: src, thumb: src,
        size: 10, rotation: 0, flipH: false, flipV: false, filters: {} });
    }
    snapshot('Import'); selectedConvertCard = 0; selectedPdfPage = 2;`);
    for (let i = 0; i < 3; i++) {
      const card = element('card-' + i); card.dataset.i = String(i); cards.push(card);
      const check = element('check-' + i); check.dataset.selectPage = String(i); checks.push(check);
      const preview = element('preview-' + i); preview.dataset.previewPage = String(i); previewButtons.push(preview);
    }
    run('updateSelectionUI()');
  }
  function key(key, options = {}) {
    let prevented = false;
    documentListeners.get('keydown')({ key, ...options, preventDefault() { prevented = true; } });
    return prevented;
  }
  return { context, run, seed, element, actions, cards, checks, previewButtons, calls, links, timers,
    focus, revoked, createdUrls, key, api: context.PageForgeUI,
    selected: () => plain(run(`({ active: pageIdentity(images[selectedConvertCard]),
      pdf: pageIdentity(images[selectedPdfPage]), checked: [...selectedSet].map(i => pageIdentity(images[i])).sort() })`)),
    stats: () => context.PhotoPdfLimits.stats(),
    pagehide() { windowListeners.get('pagehide')(); },
    compactBreakpoint(matches) { mediaListeners.get('(max-width: 900px):change')?.({ matches }); },
    failDownload() { failClick = true; }
  };
}

test('checkboxes and active preview remain independent in state and accessible controls', () => {
  const h = harness(); h.seed();
  h.context.toggleForgeSelection(2, true);
  h.context.setForgeActive(1);
  assert.deepEqual(h.selected(), { active: 'page-B', pdf: 'page-C', checked: ['page-C'] });
  assert.equal(h.cards[1].classList.contains('is-current'), true);
  assert.equal(h.cards[1].classList.contains('selected'), false);
  assert.equal(h.cards[2].classList.contains('selected'), true);
  assert.equal(h.cards[2].classList.contains('is-current'), false);
  assert.equal(h.checks[2].checked, true); assert.equal(h.checks[1].checked, false);
  assert.equal(h.previewButtons[1]['aria-pressed'], 'true');
  assert.equal(h.previewButtons[2]['aria-pressed'], 'false');
  assert.equal(h.element('rotateSelectionBtn').textContent, 'Rotate 1 selected 90°');
  h.context.toggleForgeSelection(2, false);
  assert.equal(h.selected().active, 'page-B');
  assert.deepEqual(h.selected().checked, []);
  assert.equal(h.element('rotateSelectionBtn').textContent, 'Rotate all 90°');
  h.context.toggleForgeSelection(-1, true); h.context.setForgeActive(20);
  assert.deepEqual(h.selected(), { active: 'page-B', pdf: 'page-C', checked: [] });
});

function enableExport(h, prepare = async image => ({ w: 200, h: 100, data: image.src, format: 'JPEG' })) {
  h.context.preparePdfImage = prepare;
  h.context.jspdf = { jsPDF: class {
    addPage() {} addImage() {}
    output() { return { size: 2345 }; }
  } };
}

test('document and layout changes mark the retained PDF as previous while selection and history disposal do not', async () => {
  const h = harness({ autoTimers: true }); h.seed(); enableExport(h);
  await h.context.generatePDF();
  assert.equal(h.element('downloadAgainBtn').textContent, 'Download PDF');
  assert.equal(h.element('exportFreshnessStatus').hidden, true);
  const freshState = plain(h.api.captureExportState());
  h.context.toggleForgeSelection(2, true); h.context.setForgeActive(1);
  h.run('discardUndoHistory()'); h.api.refresh();
  assert.deepEqual(plain(h.api.captureExportState()), freshState);
  assert.equal(h.element('downloadAgainBtn').textContent, 'Download PDF');

  h.context.rotateForgePage();
  assert.equal(h.element('downloadAgainBtn').textContent, 'Download previous PDF');
  assert.equal(h.element('exportFreshnessStatus').hidden, false);
  assert.equal(h.element('exportFreshnessStatus').textContent, 'Changes since export — forge again');
  assert.equal(h.element('forgeResult').dataset.stale, 'true');
  h.context.downloadLastForge();
  assert.equal(h.links.at(-1).href, h.links[0].href);
  assert.equal(h.stats().downloadBytes, 2345);

  await h.context.generatePDF();
  assert.equal(h.element('forgeResult').dataset.stale, 'false');
  assert.equal(h.element('downloadAgainBtn').textContent, 'Download PDF');
  assert.equal(h.element('exportFreshnessStatus').hidden, true);
  assert.deepEqual(h.revoked, ['blob:output-1']);
  h.element('margin').value = '20'; h.element('margin').fire('change');
  assert.equal(h.element('downloadAgainBtn').textContent, 'Download previous PDF');
  assert.equal(h.element('exportFreshnessStatus').textContent, 'Changes since export — forge again');
  assert.equal(h.element('successMsg').classList.contains('on'), true);
});

test('an export finishing after document and settings changes retains its click-time revision', async () => {
  const h = harness({ autoTimers: true }); h.seed();
  let start, finish;
  const started = new Promise(resolve => { start = resolve; });
  const continued = new Promise(resolve => { finish = resolve; });
  let first = true;
  enableExport(h, async image => {
    if (first) { first = false; start(); await continued; }
    return { w: 200, h: 100, data: image.src, format: 'JPEG' };
  });
  const exportJob = h.context.generatePDF(); await started;
  h.context.quickRotateCard(0);
  h.element('orientation').value = 'landscape'; h.element('orientation').fire('change');
  h.element('filename').value = 'changed-after-click'; h.element('filename').fire('input');
  finish(); await exportJob;
  assert.equal(h.links[0].download, 'test-document.pdf');
  assert.equal(h.element('downloadAgainBtn').textContent, 'Download previous PDF');
  assert.equal(h.element('exportFreshnessStatus').textContent, 'Changes since export — forge again');
  assert.equal(h.element('forgeResult').dataset.stale, 'true');
  assert.equal(h.element('successMsg').classList.contains('on'), true);
  h.context.downloadLastForge();
  assert.equal(h.links.at(-1).download, 'test-document.pdf');
  assert.equal(h.links.at(-1).href, h.links[0].href);
});

test('a failed retry keeps the previous download and its reservation available', async () => {
  const h = harness({ autoTimers: true }); h.seed(); enableExport(h);
  await h.context.generatePDF();
  h.context.preparePdfImage = async () => { throw new Error('New export could not decode the image'); };
  await h.context.generatePDF();
  assert.equal(h.context.getExportReport().status, 'failed');
  assert.equal(h.element('successMsg').classList.contains('on'), false);
  assert.equal(h.element('downloadAgainBtn').hidden, false);
  assert.equal(h.element('downloadAgainBtn').textContent, 'Download previous PDF');
  assert.match(h.element('exportFreshnessStatus').textContent, /Latest export failed/);
  assert.equal(h.stats().downloadBytes, 2345);
  assert.deepEqual(h.revoked, []);
  h.context.downloadLastForge();
  assert.equal(h.links.at(-1).href, 'blob:output-1');
  h.pagehide();
  assert.equal(h.stats().downloadBytes, 0);
  assert.deepEqual(h.revoked, ['blob:output-1']);
});

test('a replacement that cannot share the 128 MB budget releases only the older retained output', () => {
  const h = harness(), MiB = 1024 * 1024;
  h.context.downloadPdfBlob({ size: 70 * MiB }, 'older.pdf');
  h.run('exportInProgress = true'); h.api.reportChanged(null);
  assert.equal(h.stats().downloadBytes, 70 * MiB);
  h.context.downloadPdfBlob({ size: 80 * MiB }, 'newer.pdf');
  assert.equal(h.stats().downloadBytes, 80 * MiB);
  assert.equal(h.stats().downloads, 1);
  assert.deepEqual(h.revoked, ['blob:output-1']);
  h.context.downloadLastForge();
  assert.equal(h.links.at(-1).download, 'newer.pdf');
  h.pagehide();
  assert.equal(h.stats().downloadBytes, 0);
  assert.deepEqual(h.revoked, ['blob:output-1', 'blob:output-2']);
});

test('an impossible output cannot evict a valid previous PDF', () => {
  const h = harness(), MiB = 1024 * 1024;
  h.context.downloadPdfBlob({ size: 70 * MiB }, 'older.pdf');
  assert.throws(() => h.context.downloadPdfBlob({ size: 129 * MiB }, 'impossible.pdf'), /128 MB/);
  assert.equal(h.stats().downloadBytes, 70 * MiB);
  assert.deepEqual(h.revoked, []);
  h.context.downloadLastForge();
  assert.equal(h.links.at(-1).download, 'older.pdf');
});

test('a failed retry preserves the missing-page warning for a previous partial PDF', async () => {
  const h = harness({ autoTimers: true }); h.seed();
  enableExport(h, async image => image.name === 'C' ? null : { w: 200, h: 100, data: image.src, format: 'JPEG' });
  await h.context.generatePDF();
  assert.equal(h.context.getExportReport().status, 'partial');
  h.context.preparePdfImage = async () => { throw new Error('Could not generate replacement'); };
  await h.context.generatePDF();
  assert.match(h.element('exportFreshnessStatus').textContent, /Previous PDF is partial \(2 of 3 pages\)/);
  assert.equal(h.element('downloadAgainBtn').textContent, 'Download previous PDF');
  assert.equal(h.stats().downloadBytes, 2345);
});

test('original-quality mode replaces compression choices with an explicit lossless status', () => {
  const h = harness();
  assert.equal(h.element('qualityCompressionControls').hidden, false);
  assert.equal(h.element('qualityLosslessStatus').hidden, true);
  h.context.togglePreserveQuality();
  assert.equal(h.element('quality').disabled, true);
  assert.equal(h.element('qualityCompressionControls').hidden, true);
  assert.equal(h.element('qualityLosslessStatus').hidden, false);
  assert.equal(h.element('qualityLosslessStatus').textContent, 'Original quality — lossless export');
  assert.equal(h.element('preserveQualityBtn')['aria-pressed'], 'true');
  h.context.togglePreserveQuality();
  assert.equal(h.element('quality').disabled, false);
  assert.equal(h.element('qualityCompressionControls').hidden, false);
  assert.equal(h.element('qualityLosslessStatus').hidden, true);
});

test('compact binding options retain the user choice until crossing the desktop breakpoint', () => {
  const h = harness(), options = h.element('bindingOptions');
  assert.equal(options.open, false);
  options.open = true; h.api.refresh();
  assert.equal(options.open, true, 'Refreshing settings must not collapse the options again');
  h.compactBreakpoint(false);
  assert.equal(options.open, true);
  h.compactBreakpoint(true);
  assert.equal(options.open, false);
});

test('More closes after an action and Escape restores focus to its summary', () => {
  const h = harness(), menu = h.element('moreMenu'), summary = h.element('more-summary');
  menu.querySelector = selector => selector === 'summary' ? summary : null;
  menu.open = true;
  menu.fire('click', { target: { closest: () => h.element('sort-button') } });
  assert.equal(menu.open, false);
  menu.open = true; let prevented = false;
  menu.fire('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(menu.open, false); assert.equal(prevented, true);
  assert.equal(h.focus.at(-1), 'more-summary');
});

test('active page actions target the preview while move and undo preserve checked identities', () => {
  const h = harness(); h.seed();
  h.context.toggleForgeSelection(0, true);
  h.context.setForgeActive(1);
  h.context.editForgePage(); h.context.viewForgePage(); h.context.rotateForgePage();
  assert.ok(h.calls.some(call => call[0] === 'edit' && call[1] === 1));
  assert.ok(h.calls.some(call => call[0] === 'view' && call[1] === 1));
  assert.deepEqual(plain(h.run('images.map(image => image.rotation)')), [0, 90, 0]);
  const before = h.selected();
  h.context.moveForgePage(-1);
  assert.deepEqual(plain(h.run('images.map(image => image.name)')), ['B', 'A', 'C']);
  assert.deepEqual(h.selected(), before);
  assert.equal(h.focus.at(-1), 'preview-0');
  assert.equal(h.element('action-earlier').disabled, true);
  assert.equal(h.element('action-later').disabled, false);
  h.run('undo()');
  assert.deepEqual(plain(h.run('images.map(image => image.name)')), ['A', 'B', 'C']);
  assert.deepEqual(h.selected(), before);
  h.run('redo()');
  assert.deepEqual(h.selected(), before);
});

test('opening and closing the real full-size preview preserves the checked batch and its next action', () => {
  const h = harness({ realLightbox: true }); h.seed();
  h.context.toggleForgeSelection(0, true);
  h.context.toggleForgeSelection(2, true);
  h.context.setForgeActive(1);
  h.context.document.activeElement = h.previewButtons[1];
  const before = h.selected();

  h.context.viewForgePage();
  assert.equal(h.element('lightbox').classList.contains('on'), true);
  assert.equal(h.element('lightboxImg').src, 'blob:source-B');
  assert.equal(h.element('lightboxCaption').textContent, '2 of 3 · B');
  assert.deepEqual(h.selected(), before);
  assert.equal(h.checks[0].checked, true); assert.equal(h.checks[2].checked, true);
  assert.equal(h.key('Delete'), false, 'The open preview must block document shortcuts');
  assert.equal(h.run('images.length'), 3);

  h.context.closeLightbox();
  assert.equal(h.element('lightbox').classList.contains('on'), false);
  assert.equal(h.focus.at(-1), 'preview-1');
  assert.deepEqual(h.selected(), before);
  h.context.rotateAll(90);
  assert.deepEqual(plain(h.run('images.map(image => image.rotation)')), [90, 0, 90]);
  assert.deepEqual(h.selected(), before);
});

test('empty documents disable active actions and exporting, and active duplication gives a fresh page identity', () => {
  const h = harness();
  assert.ok(h.actions.every(button => button.disabled));
  assert.equal(h.element('convertBtn').disabled, true);
  h.context.editForgePage(); h.context.rotateForgePage(); h.context.moveForgePage(1);
  assert.deepEqual(h.calls, []);
  h.seed(); h.context.setForgeActive(1); h.context.toggleForgeSelection(2, true);
  const before = h.selected();
  h.context.duplicateForgePage();
  assert.equal(h.run('images.length'), 4);
  assert.equal(h.run('images[1].name === images[2].name'), true);
  assert.equal(h.run('pageIdentity(images[1]) === pageIdentity(images[2])'), false);
  assert.deepEqual(h.selected(), before);
});

test('native information dialogs block document delete, navigation and undo shortcuts', () => {
  const h = harness(); h.seed();
  for (const id of ['toolsDialog', 'aboutDialog', 'privacyDialog']) {
    h.context.openForgeDialog(id);
    assert.equal(h.api.isDialogOpen(), true);
    const before = h.run('JSON.stringify(images)'), historyIndex = h.run('historyIndex');
    for (const [key, options] of [['Delete', {}], ['ArrowRight', {}], ['z', { ctrlKey: true }]]) {
      assert.equal(h.key(key, options), false);
      assert.equal(h.run('JSON.stringify(images)'), before);
      assert.equal(h.run('historyIndex'), historyIndex);
      assert.equal(h.selected().active, 'page-A');
    }
    h.element(id).close();
    assert.equal(h.api.isDialogOpen(), false);
  }
  assert.equal(h.key('Delete'), true);
  assert.equal(h.run('images.length'), 2);
});

test('retained download reuses the captured URL and filename until a new export clears it', () => {
  const h = harness(); let released = 0;
  assert.equal(h.api.rememberDownload('blob:captured', 'original.pdf', () => released++), true);
  h.api.reportChanged({ status: 'complete' });
  h.element('filename').value = 'new-name';
  h.context.downloadLastForge(); h.context.downloadLastForge();
  assert.deepEqual(h.links.map(link => [link.href, link.download, link.clicked, link.removed]), [
    ['blob:captured', 'original.pdf', true, true], ['blob:captured', 'original.pdf', true, true]
  ]);
  assert.equal(h.createdUrls.length, 0); assert.equal(h.timers.size, 0);
  assert.equal(released, 0); assert.deepEqual(h.revoked, []);
  assert.equal(h.element('downloadAgainBtn').hidden, false);
  h.api.reportChanged(null);
  assert.equal(released, 1); assert.deepEqual(h.revoked, ['blob:captured']);
  assert.equal(h.element('downloadAgainBtn').hidden, true);
  h.context.downloadLastForge(); h.api.forgetDownload();
  assert.equal(h.links.length, 2); assert.equal(released, 1);
});

test('replacing a retained output and leaving the page release each URL exactly once', () => {
  const h = harness(), released = [];
  h.api.rememberDownload('blob:first', 'first.pdf', () => released.push('first'));
  h.api.rememberDownload('blob:second', 'second.pdf', () => released.push('second'));
  assert.deepEqual(h.revoked, ['blob:first']); assert.deepEqual(released, ['first']);
  h.api.reportChanged({ status: 'partial' });
  assert.equal(h.element('forgeResult').dataset.status, 'partial');
  assert.equal(h.element('downloadAgainBtn').hidden, false);
  h.pagehide(); h.pagehide();
  assert.deepEqual(h.revoked, ['blob:first', 'blob:second']);
  assert.deepEqual(released, ['first', 'second']);
  assert.equal(h.element('downloadAgainBtn').hidden, true);
});

test('the actual download transfers one URL and byte reservation to the result panel', () => {
  const h = harness();
  h.context.downloadPdfBlob({ size: 12345 }, 'proof.pdf');
  assert.equal(h.stats().downloadBytes, 12345); assert.equal(h.stats().downloads, 1);
  assert.equal(h.createdUrls.length, 1); assert.equal(h.timers.size, 0);
  h.context.downloadLastForge();
  assert.equal(h.createdUrls.length, 1);
  assert.deepEqual(h.links.map(link => link.href), ['blob:output-1', 'blob:output-1']);
  assert.equal(h.stats().downloadBytes, 12345);
  h.api.reportChanged(null);
  assert.equal(h.stats().downloadBytes, 0); assert.equal(h.stats().downloads, 0);
  assert.deepEqual(h.revoked, ['blob:output-1']);
});

test('a failed initial download cannot retain its URL or byte reservation', () => {
  const h = harness(); h.failDownload();
  assert.throws(() => h.context.downloadPdfBlob({ size: 321 }, 'broken.pdf'), /Download click failed/);
  assert.equal(h.stats().downloadBytes, 0); assert.equal(h.stats().downloads, 0);
  assert.deepEqual(h.revoked, ['blob:output-1']);
  assert.equal(h.links[0].removed, true); assert.equal(h.timers.size, 0);
  h.context.downloadLastForge(); assert.equal(h.links.length, 1);
  h.api.reportChanged({ status: 'failed' });
  assert.equal(h.element('downloadAgainBtn').hidden, true);
  assert.equal(h.element('successMsg').classList.contains('on'), false);
});
