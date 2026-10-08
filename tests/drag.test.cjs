const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const appSource = ['js/pdf-layout.js', 'js/app.js', 'js/import-queue.js']
  .map(file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')).join('\n');
const plain = value => JSON.parse(JSON.stringify(value));

// Keep the actual render() handlers and native event boundaries. Layout and
// timers are outside this regression: no long-press operation is simulated.
function harness() {
  const elements = new Map(), windowListeners = new Map(), imports = [], timers = new Map();
  let serial = 0;
  const createElement = id => {
    const classes = new Set(), listeners = new Map();
    let markup = '';
    const element = {
      id, tagName: 'DIV', dataset: {}, style: {}, value: '', children: [], parentElement: null,
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); return on; }
      },
      set className(value) { classes.clear(); value.split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); },
      get className() { return [...classes].join(' '); },
      set innerHTML(value) { markup = value; this.children.forEach(child => child.parentElement = null); this.children = []; },
      get innerHTML() { return markup; },
      setAttribute(name, value) { this[name] = value; },
      appendChild(child) { child.parentElement = this; this.children.push(child); },
      addEventListener(name, callback) { listeners.set(name, callback); },
      closest(selector) { return selector.startsWith('.img-card') && classes.has('img-card') ? this : null; },
      focus() {}, scrollIntoView() {},
      fire(name, extra = {}) {
        const event = { target: this, prevented: false,
          preventDefault() { this.prevented = true; }, ...extra };
        listeners.get(name)?.(event);
        return event;
      }
    };
    return element;
  };
  const element = id => {
    if (!elements.has(id)) elements.set(id, createElement(id));
    return elements.get(id);
  };
  const context = vm.createContext({
    console,
    setTimeout(callback) { const id = ++serial; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    document: {
      getElementById: element, body: element('body'), activeElement: { tagName: 'BODY' },
      querySelector: selector => element(selector),
      querySelectorAll: selector => selector === '.img-card' ? element('imgGrid').children : [],
      createElement: type => createElement(`${type}-${++serial}`),
      addEventListener() {}, removeEventListener() {}
    },
    window: { addEventListener(name, callback) { windowListeners.set(name, callback); } },
    localStorage: { getItem() { return null; }, setItem() {} },
    URL: { revokeObjectURL() {} },
    confirm() { return true; },
    bridgeImport(files, tab) { imports.push({ files: Array.from(files), tab }); }
  });
  vm.runInContext(appSource, context);
  vm.runInContext(`
    updateChrome = suggestFilename = updateSummary = showToast = () => {};
    handleFiles = bridgeImport;
  `, context);
  const run = source => vm.runInContext(source, context);
  function seed() {
    run(`for (const name of ['A','B','C']) {
      const id=_imgId(), src='blob:'+name;
      putStore(id, {src,originalSrc:src,thumb:src});
      images.push({_id:id,_pageId:'page-'+name,name,src,originalSrc:src,thumb:src,
        rotation:0,flipH:false,flipV:false,filters:{},size:10});
    }
    snapshot('Import'); selectedConvertCard=0; selectedPdfPage=1; selectedSet=new Set([0,2]); render();`);
  }
  seed();
  return { run, imports, timers, element,
    cards: () => element('imgGrid').children,
    state: () => plain(run('images.map(image=>image.name)')),
    selection: () => plain(run(`({convert:pageIdentity(images[selectedConvertCard]),
      pdf:pageIdentity(images[selectedPdfPage]), multiple:[...selectedSet].map(i=>pageIdentity(images[i])).sort()})`)),
    windowDrop(event) { windowListeners.get('drop')(event); }
  };
}

function transfer(files = []) {
  return { files, types: files.length ? ['Files'] : [], data: new Map(),
    setData(type, value) { this.data.set(type, value); this.types.push(type); } };
}

test('internal native drop moves its source once and preserves page selections', () => {
  const h = harness(), [source, , target] = h.cards(), before = h.selection(), dataTransfer = transfer();
  source.fire('dragstart', { dataTransfer });
  assert.equal(h.run('dragSrcIdx'), null, 'native drag must not write hold state');
  assert.equal(source.classList.contains('dragging'), true);
  assert.equal(dataTransfer.effectAllowed, 'move');
  assert.equal(dataTransfer.data.get('application/x-photopdf-page'), 'page-A');
  assert.equal(target.fire('dragover', { dataTransfer }).prevented, true);
  const event = target.fire('drop', { dataTransfer }); h.windowDrop(event);
  assert.equal(event.prevented, true);
  assert.deepEqual(h.state(), ['B','C','A']);
  assert.deepEqual(h.selection(), before);
  assert.equal(h.run('nativeCardDrag'), null);
  assert.equal(source.classList.contains('dragging'), false);
  assert.equal(h.imports.length, 0);
  target.fire('drop', { dataTransfer });
  assert.deepEqual(h.state(), ['B','C','A']);
});

test('dragend cancels the source and all target styling', () => {
  const h = harness(), [source, target] = h.cards(), dataTransfer = transfer();
  source.fire('dragstart', { dataTransfer }); target.fire('dragover', { dataTransfer });
  source.fire('dragend');
  assert.equal(h.run('nativeCardDrag'), null);
  assert.equal(source.classList.contains('dragging'), false);
  assert.equal(target.classList.contains('drag-over'), false);
  target.fire('drop', { dataTransfer });
  assert.deepEqual(h.state(), ['A','B','C']);
});

for (const end of ['dragend', 'removeImage(0)', 'none']) {
  test(`file drop after ${end} imports once without using a native or hold source`, () => {
    const h = harness(), source = h.cards()[0], dataTransfer = transfer();
    source.fire('dragstart', { dataTransfer });
    if (end === 'dragend') source.fire('dragend');
    else if (end !== 'none') h.run(end);
    h.run('dragSrcIdx=0'); // Old hold indices must never participate in native drops.
    const before = h.state(), files = [{ name:'new.png', type:'image/png' }];
    const event = h.cards().at(-1).fire('drop', { dataTransfer: transfer(files) }); h.windowDrop(event);
    assert.deepEqual(h.state(), before);
    assert.equal(h.imports.length, 1);
    assert.equal(h.imports[0].files[0], files[0]);
    assert.equal(h.imports[0].tab, 'convert');
    assert.equal(h.run('nativeCardDrag'), null);
  });
}

test('external file dragover cancels an unfinished native drag', () => {
  const h = harness(), [source, target] = h.cards();
  source.fire('dragstart', { dataTransfer: transfer() });
  target.fire('dragover', { dataTransfer: transfer([{name:'scan.png'}]) });
  assert.equal(h.run('nativeCardDrag'), null);
  assert.equal(source.classList.contains('dragging'), false);
  assert.equal(target.classList.contains('drag-over'), false);
});

test('a document revision change rejects a drop and clears its drag state', () => {
  const h = harness(), [source, target] = h.cards(), dataTransfer = transfer();
  source.fire('dragstart', { dataTransfer });
  h.run("images[0].rotation=90; snapshot('Rotate')");
  assert.equal(h.run('nativeCardDrag'), null, 'snapshot clears native dragging immediately');
  assert.equal(source.classList.contains('dragging'), false);
  target.fire('drop', { dataTransfer });
  assert.deepEqual(h.state(), ['A','B','C']);
  assert.equal(h.run('nativeCardDrag'), null);
  assert.equal(source.classList.contains('dragging'), false);
});

for (const action of ['undo()', 'redo()']) {
  test(`${action} immediately cancels native dragging before any view refresh`, () => {
    const h = harness();
    h.run("images[0].rotation=90; snapshot('Rotate'); render(); refreshAll=()=>{};");
    if (action === 'redo()') h.run('undo()');
    const [source, target] = h.cards(), dataTransfer = transfer();
    source.fire('dragstart', { dataTransfer });
    assert.equal(source.classList.contains('dragging'), true);
    h.run(action);
    assert.equal(h.run('nativeCardDrag'), null);
    assert.equal(source.classList.contains('dragging'), false);
    const before = h.state(); target.fire('drop', { dataTransfer });
    assert.deepEqual(h.state(), before);
  });
}

test('a grid rebuild cancels dragging and rejects retained old card handlers', () => {
  const h = harness(), [source, target] = h.cards(), dataTransfer = transfer();
  source.fire('dragstart', { dataTransfer }); h.run('render()');
  assert.equal(h.run('nativeCardDrag'), null);
  target.fire('drop', { dataTransfer });
  assert.equal(source.fire('dragstart', { dataTransfer }).prevented, true);
  assert.deepEqual(h.state(), ['A','B','C']);
});

test('changed source or target identities reject drops even before a revision is recorded', () => {
  for (const mutation of ['images.splice(0,1)', 'images[1]._pageId="replaced-page"']) {
    const h = harness(), [source, target] = h.cards(), dataTransfer = transfer();
    source.fire('dragstart', { dataTransfer }); h.run(mutation);
    const before = h.state(); target.fire('drop', { dataTransfer });
    assert.deepEqual(h.state(), before);
    assert.equal(h.run('nativeCardDrag'), null);
  }
});

test('native drag cannot start during an active hold drag', () => {
  const h = harness(), source = h.cards()[0];
  h.run('holdActive=true; dragSrcIdx=1');
  assert.equal(source.fire('dragstart', { dataTransfer: transfer() }).prevented, true);
  assert.equal(h.run('nativeCardDrag'), null);
  assert.equal(h.run('dragSrcIdx'), 1);
});
