const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const appSource = ['js/raster-limits.js', 'js/pdf-layout.js', 'js/app.js', 'js/import-queue.js'].map(read).join('\n');
const uiSource = read('js/forge-ui.js');
const plain = value => JSON.parse(JSON.stringify(value));

// Exercise the real document/history engine and workspace controller. The DOM
// drawing boundary is mocked; view and selection changes must keep the same
// document, history, layout settings, and export revision.
function harness() {
  const elements = new Map(), listeners = new Map(), media = new Map(), focus = [], scrolls = [];
  const values = { pageSize: 'a4', orientation: 'auto', imgFit: 'contain', margin: '10',
    quality: '0.85', filename: 'minimal-document', printDpi: '300', oversize: 'shrink', pdfContentMode: 'preserve' };
  const labels = { pageSize: { a4: 'A4', fit: 'Fit to image' },
    orientation: { auto: 'Auto orientation', landscape: 'Landscape', portrait: 'Portrait' },
    imgFit: { contain: 'Full image', cover: 'Fill page', actual: 'Print size' } };
  let context, serial = 0;
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set(), events = new Map(), attributes = new Map();
    const el = { id, tagName: 'DIV', value: values[id] || '', dataset: {}, style: {},
      hidden: false, disabled: false, open: false, tabIndex: 0, children: [],
      get selectedOptions() { return [{ textContent: labels[id]?.[this.value] || this.value, text: labels[id]?.[this.value] || this.value }]; },
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); return on; }
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      addEventListener(name, callback) { events.set(name, callback); },
      fire(name, extra = {}) { events.get(name)?.({ target: this, preventDefault() {}, ...extra }); },
      appendChild(child) { child.parentElement = this; this.children.push(child); },
      focus(options) { this.focusOptions = options; focus.push(id); context.document.activeElement = this; },
      scrollIntoView(options) { scrolls.push({ id, options: plain(options) }); },
      closest() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
      remove() {}, showModal() { this.open = true; }, close() { this.open = false; }
    };
    elements.set(id, el); return el;
  }
  const tabs = ['pages', 'preview', 'layout'].map(view => {
    const tab = element('workspace-' + view); tab.dataset.workspaceView = view;
    tab.closest = selector => selector === '[data-workspace-view]' ? tab : null;
    return tab;
  });
  const cards = [], checks = [], previewButtons = [];
  context = vm.createContext({
    console, setTimeout() { return ++serial; }, clearTimeout() {},
    document: {
      body: element('body'), activeElement: { tagName: 'BODY' }, getElementById: element,
      querySelector(selector) {
        const page = selector.match(/^\[data-preview-page="(\d+)"\]$/);
        const tab = selector.match(/^\[data-workspace-view="(\w+)"\]$/);
        return page ? previewButtons[Number(page[1])] || null : tab ? tabs.find(button => button.dataset.workspaceView === tab[1]) : element(selector);
      },
      querySelectorAll(selector) {
        if (selector === '[data-workspace-view]') return tabs;
        if (selector === '.img-card') return cards;
        if (selector === '[data-select-page]') return checks;
        if (selector === '[data-preview-page]') return previewButtons;
        return [];
      },
      createElement(tag) { return element('created-' + tag + '-' + ++serial); },
      addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener() {}
    },
    URL: { revokeObjectURL() {} }, localStorage: { getItem() { return null; }, setItem() {} },
    confirm() { return true; }, alert() {}, addEventListener() {},
    matchMedia(query) {
      if (!media.has(query)) media.set(query, { matches: true, callbacks: [],
        addEventListener(name, callback) { this.callbacks.push(callback); } });
      return media.get(query);
    }
  });
  context.window = context;
  vm.runInContext(appSource, context);
  vm.runInContext(`render = () => { updateSelectionUI(); updatePdfContentUI(); }; renderPdfEditor = () => {}; showToast = () => {};`, context);
  vm.runInContext(uiSource, context);
  const run = source => vm.runInContext(source, context);
  function seed() {
    run(`for (const name of ['A', 'B', 'C']) {
      const id = _imgId(), src = 'blob:' + name;
      putStore(id, { src, originalSrc: src, thumb: src });
      images.push({ _id: id, _pageId: 'page-' + name, name, src, originalSrc: src, thumb: src,
        size: 10, rotation: 0, flipH: false, flipV: false, filters: {} });
    }
    snapshot('Import'); selectedConvertCard = 1; selectedPdfPage = 1;`);
    for (let i = 0; i < 3; i++) {
      const card = element('card-' + i); card.dataset.i = String(i); cards.push(card);
      const check = element('check-' + i); check.dataset.selectPage = String(i); checks.push(check);
      const preview = element('preview-' + i); preview.dataset.previewPage = String(i); previewButtons.push(preview);
    }
    run('updateSelectionUI()');
  }
  return { context, run, element, tabs, focus, scrolls, seed, api: context.PageForgeUI,
    state: () => plain(run('images')),
    selection: () => plain(run('captureSelection()')),
    revision: () => plain(context.PageForgeUI.captureExportState()),
    resize(matches) {
      const compact = media.get('(max-width: 680px)');
      compact.matches = matches; compact.callbacks.forEach(callback => callback({ matches }));
    }
  };
}

test('selection mode shows only contextual batch actions and finishing preserves the active page', () => {
  const h = harness(); h.seed();
  const before = h.state(), revision = h.revision(), history = h.run('history.length');
  assert.equal(h.element('selectionToolbar').hidden, true);
  h.context.startForgeSelection();
  assert.equal(h.element('body').classList.contains('selection-mode'), true);
  assert.equal(h.element('selectionToolbar').hidden, false);
  assert.equal(h.element('selectionStartBtn').hidden, true);
  assert.equal(h.element('rotateSelectionBtn').disabled, true, 'An empty batch must not fall back to rotating all pages');
  h.context.toggleForgeSelection(0, true);
  h.context.toggleForgeSelection(2, true);
  assert.equal(h.element('rotateSelectionBtn').disabled, false);
  assert.deepEqual(h.selection(), { convert: 'page-B', pdf: 'page-B', multiple: ['page-A', 'page-C'] });
  h.context.setForgeWorkspaceView('preview', false);
  h.context.finishForgeSelection();
  assert.equal(h.element('body').classList.contains('selection-mode'), false);
  assert.equal(h.element('selectionToolbar').hidden, true);
  assert.equal(h.element('selectionStartBtn').hidden, false);
  assert.equal(h.element('pagesPanel').inert, false, 'Done must reveal the panel containing its focus destination');
  assert.equal(h.focus.at(-1), 'selectionStartBtn');
  assert.deepEqual(h.selection(), { convert: 'page-B', pdf: 'page-B', multiple: [] });
  assert.deepEqual(h.state(), before); assert.deepEqual(h.revision(), revision);
  assert.equal(h.run('history.length'), history);
});

test('empty selection removal is harmless, while a checked batch is one undoable action', () => {
  const h = harness(); h.seed(); h.context.startForgeSelection();
  const history = h.run('history.length');
  h.context.removeForgeSelection();
  assert.deepEqual(h.state().map(page => page.name), ['A', 'B', 'C']);
  assert.equal(h.run('history.length'), history);
  h.context.toggleForgeSelection(0, true); h.context.toggleForgeSelection(2, true);
  h.context.removeForgeSelection();
  assert.deepEqual(h.state().map(page => page.name), ['B']);
  assert.equal(h.selection().convert, 'page-B'); assert.equal(h.selection().pdf, 'page-B');
  assert.equal(h.run('history.length'), history + 1);
  h.run('undo()');
  assert.deepEqual(h.state().map(page => page.name), ['A', 'B', 'C']);
  assert.equal(h.selection().convert, 'page-B');
});

test('batch rotation never uses the active page or an implicit all-pages fallback', () => {
  const h = harness(); h.seed(); h.context.startForgeSelection();
  const history = h.run('history.length');
  h.context.rotateForgeSelection();
  assert.deepEqual(h.state().map(page => page.rotation), [0, 0, 0]);
  assert.equal(h.run('history.length'), history);
  h.context.toggleForgeSelection(0, true); h.context.toggleForgeSelection(2, true);
  h.context.rotateForgeSelection();
  assert.deepEqual(h.state().map(page => page.rotation), [90, 0, 90]);
  assert.equal(h.selection().convert, 'page-B');
  assert.deepEqual(h.selection().multiple, ['page-A', 'page-C']);
  assert.equal(h.run('history.length'), history + 1);
  h.run('undo()');
  assert.deepEqual(h.state().map(page => page.rotation), [0, 0, 0]);
  assert.deepEqual(h.selection().multiple, ['page-A', 'page-C']);
});

test('Remove page deletes the active preview independently of checked pages and remains undoable', () => {
  const h = harness(); h.seed(); h.context.startForgeSelection(); h.context.toggleForgeSelection(0, true);
  h.context.deleteForgePage();
  assert.deepEqual(h.state().map(page => page.name), ['A', 'C']);
  assert.deepEqual(h.selection().multiple, ['page-A']);
  h.run('undo()');
  assert.deepEqual(h.state().map(page => page.name), ['A', 'B', 'C']);
  assert.deepEqual(h.selection().multiple, ['page-A']);
});

test('mobile view switches keep the document and export revision and expose the selected tab', () => {
  const h = harness(); h.seed(); h.context.toggleForgeSelection(2, true);
  const document = h.state(), selection = h.selection(), revision = h.revision(), history = h.run('history.length');
  for (const view of ['preview', 'layout', 'pages']) {
    h.context.setForgeWorkspaceView(view, false);
    assert.equal(h.element('forgeWorkspace').dataset.view, view);
    h.tabs.forEach(tab => assert.equal(tab.getAttribute('aria-selected'), String(tab.dataset.workspaceView === view)));
    assert.deepEqual(h.state(), document); assert.deepEqual(h.selection(), selection);
    assert.deepEqual(h.revision(), revision); assert.equal(h.run('history.length'), history);
  }
  h.context.setForgeWorkspaceView('unknown', false);
  assert.equal(h.element('forgeWorkspace').dataset.view, 'pages');
});

test('mobile tabs support arrow wrapping and Home/End without changing the document', () => {
  const h = harness(); h.seed();
  const document = h.state(), revision = h.revision(), history = h.run('history.length');
  for (const [from, key, destination] of [
    ['pages', 'ArrowLeft', 'layout'], ['layout', 'ArrowRight', 'pages'],
    ['pages', 'End', 'layout'], ['layout', 'Home', 'pages'], ['pages', 'ArrowRight', 'preview']
  ]) {
    h.context.setForgeWorkspaceView(from, false);
    const tab = h.tabs.find(button => button.dataset.workspaceView === from);
    let prevented = false;
    h.element('workspaceViews').fire('keydown', { target: tab, key, preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(h.element('forgeWorkspace').dataset.view, destination);
    assert.equal(h.focus.at(-1), 'workspace-' + destination);
    h.tabs.forEach(button => assert.equal(button.getAttribute('tabindex'), button.dataset.workspaceView === destination ? '0' : '-1'));
    assert.deepEqual(h.state(), document); assert.deepEqual(h.revision(), revision);
    assert.equal(h.run('history.length'), history);
  }
});

test('explicit mobile navigation places tabs and the panel above the export dock without losing document state', () => {
  const h = harness(); h.seed();
  const document = h.state(), selection = h.selection(), revision = h.revision();
  h.context.setForgeWorkspaceView('layout');
  assert.equal(h.focus.at(-1), 'workspace-layout');
  assert.deepEqual(plain(h.tabs[2].focusOptions), { preventScroll: true });
  assert.equal(h.scrolls.at(-1).id, 'workspaceViews');
  assert.equal(h.scrolls.at(-1).options.block, 'start');
  const scrolled = h.scrolls.length;
  h.context.setForgeWorkspaceView('preview', false);
  assert.equal(h.scrolls.length, scrolled, 'Background view changes must not move the viewport');
  h.context.returnToForgePages();
  assert.equal(h.element('forgeWorkspace').dataset.view, 'pages');
  assert.equal(h.focus.at(-1), 'workspace-pages');
  assert.deepEqual(plain(h.tabs[0].focusOptions), { preventScroll: true });
  assert.equal(h.scrolls.length, scrolled + 1, 'Continue editing should perform one deliberate tablist scroll');
  assert.equal(h.scrolls.at(-1).id, 'workspaceViews');
  assert.equal(h.scrolls.at(-1).options.block, 'start');
  assert.deepEqual(h.state(), document); assert.deepEqual(h.selection(), selection); assert.deepEqual(h.revision(), revision);
});

test('full-size preview restores visible focus after its Page actions menu closes', () => {
  const h = harness(); h.seed();
  const menu = h.element('pageActionsMenu'), summary = h.element('pageActionsSummary');
  summary.isConnected = true;
  const trigger = h.element('fullsize-menu-item'); trigger.tagName = 'BUTTON'; trigger.isConnected = true;
  trigger.closest = selector => selector === 'button' ? trigger :
    selector.includes('pageActionsMenu') || selector === 'details' || selector === '.more-menu' ? menu : null;
  trigger.getClientRects = () => menu.open ? [{}] : [];
  menu.contains = target => target === trigger || target === summary;
  menu.querySelector = selector => selector === 'summary' ? summary : null;
  menu.open = true; trigger.focus();
  const before = h.selection();
  h.context.viewForgePage(); menu.fire('click', { target: trigger });
  assert.equal(menu.open, false);
  assert.equal(h.element('lightbox').open, true);
  h.context.closeLightbox();
  assert.equal(h.element('lightbox').open, false);
  assert.ok(['pageActionsSummary', 'previewPanel'].includes(h.focus.at(-1)),
    'Modal close must return to a visible menu summary or workspace control');
  assert.deepEqual(h.selection(), before);
});

test('opening layout is a user choice that survives refresh and breakpoint changes', () => {
  const h = harness(); h.seed(); const options = h.element('bindingOptions');
  assert.equal(options.open, false);
  options.open = true; h.api.refresh(); h.resize(false); h.resize(true);
  assert.equal(options.open, true);
  options.open = false; h.api.refresh(); h.resize(false);
  assert.equal(options.open, false);
});

test('a native-only PDF hides photo layout controls until image output is chosen', () => {
  const h = harness(); h.seed();
  h.run(`images.forEach((page, pageIndex) => { page.pdfSource = { sourceId: 'native-source', pageIndex }; }); updatePdfContentUI();`);
  h.api.refresh();
  assert.equal(h.element('imageLayoutControls').hidden, true);
  assert.equal(h.element('pdfContentGroup').hidden, false);
  h.element('pdfContentMode').value = 'images'; h.run('updatePdfContentUI()'); h.api.refresh();
  assert.equal(h.element('imageLayoutControls').hidden, false);
  assert.equal(h.element('pageSize').disabled, false);
  assert.deepEqual(h.state().map(page => page.pdfSource.pageIndex), [0, 1, 2]);
});

test('print precision controls appear when needed and hiding them preserves the chosen values', () => {
  const h = harness(); h.seed();
  assert.equal(h.element('advancedBinding').hidden, true);
  h.element('printDpi').value = '180'; h.element('oversize').value = 'crop';
  h.element('imgFit').value = 'actual'; h.run('updatePrintSizeUI()'); h.api.refresh();
  assert.equal(h.element('advancedBinding').hidden, false);
  assert.equal(h.element('printOverflowControls').hidden, false);
  assert.equal(h.element('printDpi').disabled, false); assert.equal(h.element('oversize').disabled, false);
  h.element('imgFit').value = 'contain'; h.element('pageSize').value = 'fit';
  h.run('updatePrintSizeUI()'); h.api.refresh();
  assert.equal(h.element('advancedBinding').hidden, false);
  assert.equal(h.element('printOverflowControls').hidden, true);
  assert.equal(h.element('printDpi').disabled, false);
  h.element('pageSize').value = 'a4'; h.run('updatePrintSizeUI()'); h.api.refresh();
  assert.equal(h.element('advancedBinding').hidden, true);
  assert.equal(h.element('printDpi').value, '180'); assert.equal(h.element('oversize').value, 'crop');
});
