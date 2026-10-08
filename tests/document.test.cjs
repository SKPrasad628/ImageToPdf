const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const appSource = ['js/pdf-layout.js', 'js/app.js', 'js/import-queue.js'].map(file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')).join('\n');
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Exercise the application's document, history, keyboard, and export code.
// Browser drawing and the PDF encoder are boundaries, so a conversion can be
// paused while the live document is edited without a browser dependency.
function harness() {
  const elements = new Map(), listeners = new Map(), renders = [], prepared = [], pdfs = [], alerts = [], revoked = [];
  let serial = 0, prepareHook = null, context;
  const drawing = {};
  for (const method of ['clearRect', 'fillRect', 'save', 'restore', 'translate', 'rotate', 'scale', 'drawImage']) drawing[method] = () => {};
  const element = id => {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set(), events = new Map();
    const values = { pageSize: 'a4', orientation: 'auto', imgFit: 'contain', margin: '10', quality: '0.85', filename: 'test-document', printDpi: '300', oversize: 'shrink' };
    const el = {
      id, tagName: 'DIV', style: {}, dataset: {}, disabled: false, value: values[id] || '', innerHTML: '',
      isConnected: true, open: false,
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); return on; }
      },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(name, callback) { events.set(name, callback); },
      fire(name, event) { events.get(name)?.(event); },
      appendChild(child) { child.parentElement = this; },
      getContext() { return drawing; },
      focus() { context.document.activeElement = this; },
      closest() { return null; },
      scrollIntoView(options) { this.lastScroll = options; }, remove() { this.isConnected = false; },
      showModal() { this.open = true; this.showModalCalls = (this.showModalCalls || 0) + 1; },
      close() { this.open = false; events.get('close')?.({}); }
    };
    elements.set(id, el);
    return el;
  };
  class TestImage {
    constructor() { this.naturalWidth = 100; this.naturalHeight = 80; }
    set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); }
    get src() { return this._src; }
  }
  class TestPdf {
    constructor(options) { this.options = plain(options); this.pages = []; pdfs.push(this); }
    addPage(format, orientation) { this.pages.push({ format, orientation }); }
    addImage(data, format, ...dimensions) { this.pages.push({ data, format, dimensions }); }
    output(type) { assert.equal(type, 'blob'); return { size: 100, pdf: this }; }
  }
  context = vm.createContext({
    console, setTimeout, clearTimeout, queueMicrotask, Image: TestImage,
    URL: { revokeObjectURL(url) { revoked.push(url); } },
    document: {
      getElementById: element, querySelector: selector => element(selector), querySelectorAll: () => [],
      createElement: type => element(`created-${type}-${++serial}`),
      body: element('body'), activeElement: { tagName: 'BODY' },
      addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener() {}
    },
    window: { addEventListener() {}, jspdf: { jsPDF: TestPdf } },
    localStorage: { getItem() { return null; }, setItem() {} },
    alert(message) { alerts.push(message); }, confirm() { return true; },
    bridgeRender(tab, images) { renders.push({ tab, images: plain(images) }); },
    bridgeDownload(blob, filename) { blob.pdf.filename = filename; },
    async bridgePrepare(image, options) {
      const record = { image, options };
      prepared.push(record);
      if (prepareHook) await prepareHook(record);
      assert.equal(revoked.includes(image.src), false, `export source ${image.src} must remain available`);
      return { data: image.src, format: 'JPEG', w: 100, h: 80 };
    }
  });
  vm.runInContext(appSource, context);
  vm.runInContext(`
    render = () => bridgeRender('convert', images);
    renderPdfEditor = () => bridgeRender('edit', images);
    showToast = () => {};
    preparePdfImage = bridgePrepare;
    downloadPdfBlob = bridgeDownload;
  `, context);
  const run = source => vm.runInContext(source, context);
  const state = () => plain(run('images'));
  const selection = () => plain(run(`({
    convert: images[selectedConvertCard]?._pageId ?? null,
    pdf: images[selectedPdfPage]?._pageId ?? null,
    multiple: [...selectedSet].map(i => images[i]?._pageId).filter(Boolean).sort()
  })`));
  function add(name) {
    context.seedName = name;
    run(`{
      const versionId = _imgId(), pageId = 'page-' + seedName;
      const src = 'blob:' + seedName, thumb = src + '-thumb';
      putStore(versionId, {src, originalSrc: src, thumb});
      images.push({_id: versionId, _pageId: pageId, name: seedName, src, originalSrc: src,
        thumb, size: 100, rotation: 0, flipH: false, flipV: false, filters: {brightness:100}});
    }`);
    return `page-${name}`;
  }
  function key(key, extra = {}) {
    let prevented = false;
    listeners.get('keydown')({ key, ...extra, preventDefault() { prevented = true; } });
    return prevented;
  }
  return { context, run, state, selection, add, key, element, renders, prepared, pdfs, alerts, revoked,
    setPrepareHook(hook) { prepareHook = hook; } };
}

function seedSelection(h) {
  h.add('C'); h.add('A'); h.add('B');
  h.run("snapshot('Import'); selectedConvertCard=0; selectedPdfPage=2; selectedSet=new Set([0,1])");
  return { convert: 'page-C', pdf: 'page-B', multiple: ['page-A', 'page-C'] };
}

for (const dialogId of ['editorModal', 'lightbox']) {
  test(`${dialogId} cycles Tab at both boundaries and skips hidden or disabled controls`, () => {
    const h = harness(), dialog = h.element(dialogId);
    const first = h.element('first'), middle = h.element('middle'), last = h.element('last');
    const hidden = h.element('hidden'), disabled = h.element('disabled');
    hidden.getClientRects = () => [];
    disabled.disabled = true;
    dialog.querySelectorAll = () => [hidden, first, middle, last, disabled];
    dialog.classList.add('on');
    first.focus();
    assert.equal(h.key('Tab', { shiftKey: true }), true);
    assert.equal(h.context.document.activeElement, last);
    assert.equal(h.key('Tab'), true);
    assert.equal(h.context.document.activeElement, first);
    middle.focus();
    assert.equal(h.key('Tab'), false, 'Interior navigation remains native');
    h.element('body').focus();
    assert.equal(h.key('Tab'), true, 'A stray focus is brought back into the open modal');
    assert.equal(h.context.document.activeElement, first);
  });
}

test('a full-size dialog with one close control retains focus in both Tab directions', () => {
  const h = harness(), dialog = h.element('lightbox'), close = h.element('lightboxCloseBtn');
  dialog.querySelectorAll = () => [close];
  dialog.classList.add('on'); close.focus();
  assert.equal(h.key('Tab'), true); assert.equal(h.context.document.activeElement, close);
  assert.equal(h.key('Tab', { shiftKey: true }), true); assert.equal(h.context.document.activeElement, close);
});

test('switching tabs redraws the destination from the current document', () => {
  const h = harness(); h.add('A'); h.run("snapshot('Import'); switchTab('edit')");
  assert.equal(h.renders.at(-1).tab, 'edit');
  assert.deepEqual(h.renders.at(-1).images.map(image => image.name), ['A']);
  h.add('B'); h.run("snapshot('Append'); switchTab('convert')");
  assert.equal(h.renders.at(-1).tab, 'convert');
  assert.deepEqual(h.renders.at(-1).images.map(image => image.name), ['A', 'B']);
  assert.equal(h.element('settingsBar').parentElement, h.element('settingsMountConvert'));
});

for (const operation of ['reverseOrder()', 'sortByName()', "changeImageOrder(0,2,'Reorder')", 'movePage(2,-1)']) {
  test(`${operation} keeps both selections and multi-selection on the same pages`, () => {
    const h = harness(), before = seedSelection(h);
    h.run(operation);
    assert.deepEqual(h.selection(), before);
  });
}

for (const duplicate of ['duplicateImage(0)', 'duplicatePage(0)']) {
  test(`${duplicate} inserts a new identity without shifting selected pages`, () => {
    const h = harness(), before = seedSelection(h);
    h.run(duplicate);
    assert.equal(h.state().length, 4);
    assert.equal(new Set(h.state().map(image => image._pageId)).size, 4);
    assert.deepEqual(h.selection(), before);
    h.run('undo()'); assert.deepEqual(h.selection(), before);
    h.run('redo()'); assert.deepEqual(h.selection(), before);
  });
}

for (const remove of ['removeImage(0)', 'deletePage(0)']) {
  test(`${remove} clears only the deleted selection and preserves surviving selected pages`, () => {
    const h = harness(); seedSelection(h); h.run(remove);
    assert.deepEqual(h.selection(), { convert: null, pdf: 'page-B', multiple: ['page-A'] });
  });
}

test('undo and redo preserve page selections across order and pixel-version changes', () => {
  const h = harness(), before = seedSelection(h);
  h.run(`{
    const image = images[0], nextId = _imgId();
    putStore(nextId, {src:'blob:C-edited', originalSrc:image.originalSrc, thumb:'blob:C-edited-thumb'});
    image._id=nextId; image.src='blob:C-edited'; image.thumb='blob:C-edited-thumb';
    snapshot('Save edits');
  }`);
  h.run('reverseOrder()'); assert.deepEqual(h.selection(), before);
  h.run('undo()'); assert.deepEqual(h.selection(), before);
  h.run('undo()'); assert.deepEqual(h.selection(), before);
  assert.equal(h.state()[0].src, 'blob:C');
  h.run('redo()'); assert.deepEqual(h.selection(), before);
  assert.equal(h.state()[0].src, 'blob:C-edited');
  h.run('redo()'); assert.deepEqual(h.selection(), before);
});

test('undoing the first import keeps visible Redo recovery until the document is restored', () => {
  const h = harness();
  h.add('A'); h.run("snapshot('Import'); undo()");
  assert.deepEqual(h.state(), []);
  assert.equal(h.element('undoBar').classList.contains('on'), true);
  assert.equal(h.element('undoBtn').disabled, true);
  assert.equal(h.element('redoBtn').disabled, false);
  assert.equal(h.element('undoLabel').textContent, 'Document removed — Redo to restore.');
  h.run('redo()');
  assert.deepEqual(h.state().map(image => image.name), ['A']);
  assert.equal(h.element('undoBar').classList.contains('on'), true);
  assert.equal(h.element('undoBtn').disabled, false);
  assert.equal(h.element('redoBtn').disabled, true);
  assert.equal(h.element('undoLabel').textContent, 'Import');
  h.run('undo(); discardUndoHistory()');
  assert.equal(h.element('undoBar').classList.contains('on'), false);
  assert.equal(h.element('undoLabel').textContent, '');
});

for (const [key, start, next] of [['ArrowRight', 0, 1], ['ArrowDown', 1, 2], ['ArrowLeft', 0, 2], ['ArrowUp', 2, 1]]) {
  test(`${key} navigates the focused thumbnail without rebuilding the rail or losing checked pages`, () => {
    const h = harness(); h.add('A'); h.add('B'); h.add('C');
    h.run("snapshot('Import'); selectedConvertCard=0; selectedSet=new Set([0])");
    const buttons = [0, 1, 2].map(index => {
      const button = h.element(`[data-preview-page="${index}"]`);
      button.tagName = 'BUTTON'; button.dataset.previewPage = String(index);
      button.closest = selector => selector === '#imgGrid, .forge-proof' || selector === '[data-preview-page]' ? button : null;
      return button;
    });
    const cues = [0, 1, 2].map(index => {
      const cue = h.element(`viewing-${index}`); cue.dataset.viewingPage = String(index); return cue;
    });
    h.context.document.querySelectorAll = selector => selector === '[data-preview-page]' ? buttons : selector === '[data-viewing-page]' ? cues : [];
    buttons[start].focus();
    const rendersBefore = h.renders.length;
    assert.equal(h.key(key), true);
    assert.equal(h.run('selectedConvertCard'), next);
    assert.equal(h.renders.length, rendersBefore, 'Changing preview must keep the focused card node connected');
    assert.equal(h.context.document.activeElement, buttons[next]);
    assert.equal(buttons[next]['aria-pressed'], 'true');
    assert.equal(buttons[(next + 1) % 3]['aria-pressed'], 'false');
    assert.equal(cues[next].hidden, false);
    assert.equal(cues[(next + 1) % 3].hidden, true);
    assert.deepEqual(h.selection().multiple, ['page-A']);
    assert.deepEqual(plain(buttons[next].lastScroll), { block: 'nearest', inline: 'nearest' });
  });
}

test('arrows outside the page workspace keep normal browser behavior', () => {
  const h = harness(); h.add('A'); h.add('B'); h.run("snapshot('Import'); selectedConvertCard=0");
  const forgeButton = h.element('convertBtn'); forgeButton.tagName = 'BUTTON'; forgeButton.focus();
  const rendersBefore = h.renders.length;
  for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) assert.equal(h.key(key), false);
  assert.equal(h.run('selectedConvertCard'), 0);
  assert.equal(h.context.document.activeElement, forgeButton);
  assert.equal(h.renders.length, rendersBefore);
});

test('arrow navigation from proof controls moves focus to the newly active thumbnail', () => {
  const h = harness(); h.add('A'); h.add('B'); h.run("snapshot('Import'); selectedConvertCard=0");
  const viewButton = h.element('full-size-button'); viewButton.tagName = 'BUTTON';
  viewButton.closest = selector => selector === '#imgGrid, .forge-proof' ? h.element('proof') : null;
  viewButton.focus();
  assert.equal(h.key('ArrowRight'), true);
  assert.equal(h.run('selectedConvertCard'), 1);
  assert.equal(h.context.document.activeElement, h.element('[data-preview-page="1"]'));
});

test('focusing a compact page reveals its entire card and Viewing cue, not just the thumbnail', () => {
  const h = harness(), button = h.element('[data-preview-page="1"]'), card = h.element('page-card');
  button.closest = selector => selector === '.img-card' ? card : null;
  h.run('focusConvertPage(1)');
  assert.equal(h.context.document.activeElement, button);
  assert.deepEqual(plain(card.lastScroll), { block: 'nearest', inline: 'nearest' });
  assert.equal(button.lastScroll, undefined);
});

test('keyboard multi-delete keeps the PDF selection on its surviving page', () => {
  const h = harness(); seedSelection(h);
  h.key('Delete');
  assert.deepEqual(h.state().map(image => image.name), ['B']);
  assert.deepEqual(h.selection(), {convert:null, pdf:'page-B', multiple:[]});
  assert.equal(h.run('selectedPdfPage'), 0);
});

for (const tab of ['convert', 'edit']) {
  test(`lightbox blocks destructive and navigation shortcuts in ${tab}`, () => {
    const h = harness(); h.add('A'); h.add('B');
    h.run(`snapshot('Import'); currentTab='${tab}'; selectedConvertCard=0; selectedPdfPage=0; openLightbox(1)`);
    const before = h.state(), beforeSelection = h.selection(), historyIndex = h.run('historyIndex');
    for (const [key, extra] of [['Delete', {}], ['Backspace', {}], ['d', {ctrlKey:true}], ['z', {ctrlKey:true}], ['Z', {ctrlKey:true,shiftKey:true}], ['ArrowDown', {}], ['ArrowRight', {}]]) h.key(key, extra);
    assert.deepEqual(h.state(), before);
    assert.deepEqual(h.selection(), beforeSelection);
    assert.equal(h.run('historyIndex'), historyIndex);
    assert.equal(h.element('lightbox').classList.contains('on'), true);
    h.key('Escape'); assert.equal(h.element('lightbox').classList.contains('on'), false);
  });
}

test('opening a lightbox activates its displayed photo and preserves the checked batch', () => {
  const h = harness(); h.add('A'); h.add('B');
  h.run("selectedConvertCard=0; selectedPdfPage=0; selectedSet=new Set([0]); currentTab='convert'; openLightbox(1)");
  assert.equal(h.selection().convert, 'page-B');
  assert.deepEqual(h.selection().multiple, ['page-A']);
  h.run("closeLightbox(); currentTab='edit'; openLightbox(0)");
  assert.equal(h.selection().pdf, 'page-A');
  assert.deepEqual(h.selection().multiple, ['page-A']);
});

test('full-size preview enters the native modal layer and cancel closes it with focus restored', () => {
  const h = harness(); h.add('A'); h.run('selectedConvertCard=0');
  const trigger = h.element('view-page-button'); trigger.tagName = 'BUTTON'; trigger.focus();
  h.run('openLightbox(0)');
  const dialog = h.element('lightbox');
  assert.equal(dialog.open, true);
  assert.equal(dialog.showModalCalls, 1);
  assert.equal(h.context.document.activeElement, h.element('lightboxCloseBtn'));
  let cancelled = false;
  dialog.fire('cancel', { preventDefault() { cancelled = true; } });
  assert.equal(cancelled, true);
  assert.equal(dialog.open, false);
  assert.equal(dialog.classList.contains('on'), false);
  assert.equal(h.context.document.activeElement, trigger);
  h.run('closeLightbox()');
  assert.equal(h.context.document.activeElement, trigger, 'Repeated backdrop/close events must retain restored trigger focus');
});

test('closing a full-size preview restores a current thumbnail when its trigger was removed', () => {
  const h = harness(); h.add('A'); h.run('selectedConvertCard=0');
  const trigger = h.element('old-thumbnail'); trigger.focus();
  h.run('openLightbox(0)'); trigger.remove(); h.run('closeLightbox()');
  assert.equal(h.context.document.activeElement, h.element('[data-preview-page="0"]'));
  assert.equal(h.element('lightbox').open, false);
});

test('export freezes image order, pixels, transforms, filters, and settings before yielding', async () => {
  const h = harness(); h.add('A'); h.add('B'); h.run("snapshot('Import')");
  const started = deferred(), gate = deferred();
  h.setPrepareHook(async record => { if (record.image.name === 'A') { started.resolve(); await gate.promise; } });
  const exportJob = h.run('generatePDF()'); await started.promise;
  h.run(`images[0].rotation=90; images[0].filters.brightness=25; images[1].src='blob:B-edited';
    reverseOrder(); duplicateImage(0); preserveOriginalQuality=true;`);
  h.element('filename').value='changed'; h.element('quality').value='0.1'; h.element('pageSize').value='a3';
  gate.resolve(); await exportJob;
  assert.deepEqual(h.prepared.map(record => record.image.name), ['A', 'B']);
  assert.deepEqual(h.prepared.map(record => record.image.src), ['blob:A', 'blob:B']);
  assert.deepEqual(h.prepared.map(record => record.image.rotation), [0, 0]);
  assert.deepEqual(h.prepared.map(record => record.image.filters.brightness), [100, 100]);
  assert.deepEqual(plain(h.prepared.map(record => record.options)), [{preserveQuality:false,quality:0.85}, {preserveQuality:false,quality:0.85}]);
  assert.equal(h.pdfs[0].filename, 'test-document.pdf');
  assert.deepEqual(h.pdfs[0].options.format, [297, 210]);
});

test('export leases its sources after clear and history pruning, then releases them', async () => {
  const h = harness(); h.add('A'); h.add('B'); h.run("snapshot('Import')");
  const started = deferred(), gate = deferred();
  h.setPrepareHook(async record => { if (record.image.name === 'A') { started.resolve(); await gate.promise; } });
  const exportJob = h.run('generatePDF()'); await started.promise;
  h.run("clearAll(); for(let i=0;i<MAX_HISTORY+1;i++) snapshot('Other action'); pruneImgStore()");
  assert.equal(h.revoked.includes('blob:A'), false);
  assert.equal(h.revoked.includes('blob:B'), false);
  gate.resolve(); await exportJob;
  assert.deepEqual(h.prepared.map(record => record.image.name), ['A', 'B']);
  assert.equal(h.pdfs[0].filename, 'test-document.pdf');
  assert.equal(h.revoked.filter(url => url === 'blob:A').length, 1);
  assert.equal(h.revoked.filter(url => url === 'blob:B').length, 1);
  assert.equal(h.element('convertBtn').disabled, false);
});

test('export retains a shared source once and releases it after exporting both duplicates', async () => {
  const h = harness(); h.add('A'); h.run("snapshot('Import'); duplicateImage(0)");
  const referencesBeforeExport = h.run("_urlRefs.get('blob:A')");
  const started = deferred(), gate = deferred();
  let first = true;
  h.setPrepareHook(async () => { if (first) { first = false; started.resolve(); await gate.promise; } });
  const exportJob = h.run('generatePDF()'); await started.promise;
  assert.equal(h.run("_urlRefs.get('blob:A')"), referencesBeforeExport + 1);
  h.run("clearAll(); for(let i=0;i<MAX_HISTORY+1;i++) snapshot('Other action'); pruneImgStore()");
  assert.equal(h.run("_urlRefs.get('blob:A')"), 1);
  gate.resolve(); await exportJob;
  assert.deepEqual(h.prepared.map(record => record.image.src), ['blob:A', 'blob:A']);
  assert.equal(h.revoked.filter(url => url === 'blob:A').length, 1);
  assert.equal(h.run("_urlRefs.has('blob:A')"), false);
});

test('export progress remains visible across tab switches and clears from both views', async () => {
  const h = harness(); h.add('A');
  const started = deferred(), gate = deferred();
  h.setPrepareHook(async () => { started.resolve(); await gate.promise; });
  const exportJob = h.run('generatePDF()'); await started.promise;
  h.run("switchTab('edit')");
  for (const suffix of ['', 'Edit']) {
    assert.equal(h.element('progWrap' + suffix).classList.contains('on'), true);
    assert.match(h.element('progLbl' + suffix).textContent, /1 of 1/);
  }
  gate.resolve(); await exportJob;
  for (const suffix of ['', 'Edit']) assert.equal(h.element('progWrap' + suffix).classList.contains('on'), false);
});

for (const fail of ['unreadable', 'encoder failure']) {
  test(`export cleanup releases pinned sources and restores controls after ${fail}`, async () => {
    const h = harness(); h.add('A'); h.run("snapshot('Import')");
    const started = deferred(), gate = deferred();
    h.setPrepareHook(async () => { started.resolve(); await gate.promise; if (fail === 'encoder failure') throw new Error('Encode failed'); });
    if (fail === 'unreadable') h.run('preparePdfImage = async (image, options) => { await bridgePrepare(image, options); return null; }');
    const exportJob = h.run('generatePDF()'); await started.promise;
    h.run("clearAll(); for(let i=0;i<MAX_HISTORY+1;i++) snapshot('Other action'); pruneImgStore()");
    assert.equal(h.revoked.includes('blob:A'), false);
    gate.resolve(); await exportJob;
    assert.equal(h.revoked.filter(url => url === 'blob:A').length, 1);
    assert.equal(h.element('convertBtn').disabled, false);
    assert.equal(h.element('preserveQualityBtn').disabled, false);
    for (const suffix of ['', 'Edit']) assert.equal(h.element('progWrap' + suffix).classList.contains('on'), false);
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0], fail === 'unreadable' ? /none of the images could be read/i : /Encode failed/);
    assert.equal(h.pdfs.length, 0);
  });
}
