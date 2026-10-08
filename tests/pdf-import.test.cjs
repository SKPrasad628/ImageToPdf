const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../js/pdf-import.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const queueSource = fs.readFileSync(path.join(__dirname, '../js/import-queue.js'), 'utf8');
const limitsSource = fs.readFileSync(path.join(__dirname, '../js/raster-limits.js'), 'utf8');

function appFunction(name) {
  const match = appSource.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  if (!match) throw new Error(`Missing app function ${name}`);
  return match[0];
}

function harness(options = {}) {
  const images = options.empty ? [] : [{ _id: 'existing', name: 'Existing photo', src: 'blob:existing' }];
  const refs = new Map(), revoked = [], stores = new Map(), canvases = [], cleaned = [];
  const loading = [], alerts = [], opens = [], snapshots = [], prompts = [], viewports = [], renders = [], registered = [], encodings = [], canceledRenders = [];
  const fields = { pageSize: { value: 'a4' }, orientation: { value: 'landscape' }, margin: { value: '10' } };
  let destroyed = 0, refreshed = 0, summaries = 0, reads = 0, nextId = 0;
  const retain = url => { if (typeof url === 'string' && url.startsWith('blob:')) refs.set(url, (refs.get(url) || 0) + 1); };
  const release = url => {
    if (typeof url !== 'string' || !url.startsWith('blob:')) return;
    const n = (refs.get(url) || 0) - 1;
    if (n > 0) refs.set(url, n);
    else {
      refs.delete(url); revoked.push(url);
      if (context.window.PhotoPdfLimits) context.window.PhotoPdfLimits.forgetUrl(url);
    }
  };
  const doc = {
    numPages: options.pages ?? 2,
    async getPage(number) {
      if (options.getPage) await options.getPage(number);
      return {
        getViewport({ scale }) {
          viewports.push({ number, scale });
          return options.viewport ? options.viewport(number, scale) : { width: 600 * scale, height: 800 * scale };
        },
        render({ canvasContext, viewport }) {
          canvasContext.canvas.page = number;
          renders.push({ number, width: canvasContext.canvas.width, height: canvasContext.canvas.height, viewport });
          return {
            promise: options.render ? Promise.resolve().then(() => options.render(number)) : Promise.resolve(),
            cancel() { canceledRenders.push(number); if (options.cancelRender) options.cancelRender(number); }
          };
        },
        cleanup() { cleaned.push(number); if (options.cleanupThrows) throw new Error('Cleanup failed'); }
      };
    },
    async destroy() { destroyed++; if (options.destroyThrows) throw new Error('Destroy failed'); }
  };
  const context = vm.createContext({
    images, window: { PhotoPdfFileIntake: { async classifyFile() { return { kind: 'pdf', format: 'pdf' }; } },
      PhotoPdfLibraries: options.missingLoader ? undefined : {
      async openPdfDocument(parameters) {
        opens.push(parameters);
        return options.open ? options.open(parameters, doc) : doc;
      }
    } },
    document: {
      getElementById: id => fields[id],
      createElement(tag) {
        assert.equal(tag, 'canvas');
        const canvas = { width: 0, height: 0 };
        const canvasContext = { canvas, fillRect() {} };
        canvas.getContext = () => options.missingContext ? null : canvasContext;
        canvases.push(canvas);
        return canvas;
      }
    },
    setTimeout: resolve => resolve(),
    retainUrl: retain, releaseUrl: release,
    async canvasToUrl(canvas, quality, format) {
      encodings.push({ quality, format });
      if (options.encode) await options.encode(canvas.page);
      const url = `blob:page${canvas.page}`;
      if (options.trackResources) {
        try { context.window.PhotoPdfLimits.trackUrl(url, options.pageBytes ?? 1000, canvas.width, canvas.height); }
        catch (error) { revoked.push(url); throw error; }
      }
      return { url };
    },
    async generateThumb(src) {
      if (options.thumb) await options.thumb(src);
      if (options.sharedThumb) return src;
      const url = `${src}-thumb`;
      if (options.trackResources) context.window.PhotoPdfLimits.trackUrl(url, 100, 120, 120);
      return url;
    },
    _imgId: () => `new${++nextId}`,
    registerPdfSource(details) {
      const id = 'pdf-source' + (registered.length + 1);
      if (options.trackResources) context.window.PhotoPdfLimits.reserveBytes(id, details.bytes.byteLength);
      registered.push(details); return id;
    },
    putStore(id, entry) { stores.set(id, entry); Object.values(entry).forEach(retain); },
    snapshot(label) { snapshots.push({ label, names: images.map(image => image.name) }); },
    refreshAll() { refreshed++; }, updateSummary() { summaries++; },
    showPdfLoading(...args) { loading.push(args); },
    showToast() {},
    alert(message) { alerts.push(message); },
    prompt(message) { prompts.push(message); return options.passwords ? options.passwords.shift() : null; }
  });
  vm.runInContext(limitsSource, context);
  vm.runInContext(source, context);
  const file = { name: 'Example.pdf', size: options.fileSize ?? 1234, async arrayBuffer() {
    reads++;
    if (options.read) await options.read(reads);
    return new Uint8Array([reads]).buffer;
  } };
  return {
    context,
    images, refs, revoked, stores, canvases, cleaned, loading, alerts, opens, snapshots, fields, prompts, viewports, renders, registered, encodings, canceledRenders,
    run: job => context.loadPdfFile(file, 'edit', job),
    stats: () => ({ destroyed, refreshed, summaries, reads })
  };
}

function assertCleaned(h, pages) {
  assert.equal(h.loading.at(-1)[1], false, 'Loading indicator must be hidden');
  assert.equal(h.stats().destroyed, 1, 'Opened document must release its worker');
  assert.deepEqual(h.cleaned, pages);
  assert.ok(h.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
}

test('successful PDF import commits all pages once and releases only temporary leases', async () => {
  const h = harness();
  assert.equal(await h.run(), true);
  assert.deepEqual(h.images.map(image => image.name), ['Existing photo', 'Example.pdf – p1', 'Example.pdf – p2']);
  assert.equal(h.stores.size, 2); assert.equal(h.snapshots.length, 1); assert.equal(h.stats().refreshed, 1);
  assert.equal(h.refs.get('blob:page1'), 2); assert.equal(h.refs.get('blob:page1-thumb'), 1);
  assert.deepEqual(h.revoked, []); assert.deepEqual(h.alerts, []);
  assert.equal(h.registered.length, 1); assert.equal(h.registered[0].numPages, 2);
  assert.deepEqual(h.images.slice(1).map(image => ({ ...image.pdfSource })), [
    { sourceId: 'pdf-source1', pageIndex: 0 }, { sourceId: 'pdf-source1', pageIndex: 1 }
  ]);
  assert.notEqual(h.images[1].pdfSource, h.images[1].originalPdfSource);
  assert.ok(h.encodings.every(call => call.format === 'image/png' && call.quality === undefined));
  assertCleaned(h, [1, 2]);
});

test('the first imported PDF changes fit settings only on success', async () => {
  const h = harness({ empty: true, pages: 1 });
  assert.equal(await h.run(), true);
  assert.equal(h.fields.pageSize.value, 'fit'); assert.equal(h.fields.margin.value, 0);
  assert.equal(h.fields.orientation.value, 'auto');
  assert.equal(h.stats().summaries, 1); assert.equal(h.images[0].name, 'Example.pdf');
});

test('an oversized PDF is rejected before reading bytes or opening the parser', async () => {
  const h = harness({ empty: true, fileSize: 50 * 1024 * 1024 + 1 });
  assert.equal(await h.run(), false);
  assert.equal(h.stats().reads, 0); assert.equal(h.opens.length, 0);
  assert.equal(h.canvases.length, 0); assert.equal(h.stores.size, 0);
  assert.equal(h.snapshots.length, 0); assert.equal(h.registered.length, 0);
  assert.equal(h.alerts.length, 1); assert.match(h.alerts[0], /50.*(?:MB|file limit)/i);
  assert.equal(h.loading.at(-1)[1], false);
});

test('a PDF above the page budget is rejected before rendering', async () => {
  const h = harness({ empty: true, pages: 201 });
  assert.equal(await h.run(), false);
  assert.equal(h.canvases.length, 0); assert.equal(h.renders.length, 0);
  assert.equal(h.stores.size, 0); assert.equal(h.snapshots.length, 0);
  assert.equal(h.registered.length, 0); assert.deepEqual(h.images, []);
  assert.match(h.alerts[0], /200/); assertCleaned(h, []);
});

test('PDF page admission includes existing document pages', async () => {
  const h = harness({ pages: 200 });
  assert.equal(await h.run(), false);
  assert.equal(h.images.length, 1); assert.equal(h.images[0].name, 'Existing photo');
  assert.equal(h.canvases.length, 0); assert.equal(h.renders.length, 0);
  assert.equal(h.stores.size, 0); assert.equal(h.snapshots.length, 0);
  assert.equal(h.registered.length, 0); assert.match(h.alerts[0], /200/);
  assertCleaned(h, []);
});

test('pending PDF bytes obey the retained quota before opening its parser', async () => {
  const h = harness({ empty: true, fileSize: 50 * 1024 * 1024 });
  h.context.window.PhotoPdfLimits.reserveBytes('existing-history', 100 * 1024 * 1024);
  assert.equal(await h.run(), false);
  assert.equal(h.stats().reads, 0); assert.equal(h.opens.length, 0);
  assert.equal(h.registered.length, 0); assert.equal(h.snapshots.length, 0);
  assert.equal(h.context.window.PhotoPdfLimits.stats().retainedBytes, 100 * 1024 * 1024);
  assert.match(h.alerts[0], /128.*(?:MB|limit)/i);
});

test('a staged PDF encoding budget failure rolls back all retained pages and the pending source', async () => {
  const h = harness({ empty: true, pages: 6, trackResources: true, pageBytes: 24 * 1024 * 1024 });
  assert.equal(await h.run(), false);
  assert.deepEqual(h.images, []); assert.equal(h.stores.size, 0); assert.equal(h.snapshots.length, 0);
  assert.equal(h.registered.length, 0); assert.equal(h.refs.size, 0);
  assert.equal(h.context.window.PhotoPdfLimits.stats().retainedBytes, 0);
  assert.equal(h.context.window.PhotoPdfLimits.stats().allocations, 0);
  assert.match(h.alerts[0], /128.*(?:MB|limit)/i); assertCleaned(h, [1, 2, 3, 4, 5, 6]);
});

test('canceling after a retained PDF page releases its preview, thumbnail and pending source quota', async () => {
  let resume, started;
  const pending = new Promise(resolve => { resume = resolve; });
  const boundary = new Promise(resolve => { started = resolve; });
  const h = harness({ empty: true, trackResources: true,
    render: number => { if (number === 2) { started(); return pending; } } });
  const job = cancelJob(), result = h.run(job);
  await boundary;
  assert.equal(h.context.window.PhotoPdfLimits.stats().retainedBytes, 1234 + 1000 + 100);
  job.cancel(); resume(); assert.equal(await result, false);
  assert.equal(h.context.window.PhotoPdfLimits.stats().retainedBytes, 0);
  assert.equal(h.context.window.PhotoPdfLimits.stats().allocations, 0);
  assert.equal(h.refs.size, 0); assert.equal(h.registered.length, 0); assert.deepEqual(h.images, []);
  assertCleaned(h, [1, 2]);
});

test('adding a PDF to an existing document preserves the chosen orientation', async () => {
  const h = harness({ pages: 1 });
  assert.equal(await h.run(), true);
  assert.equal(h.fields.orientation.value, 'landscape');
});

for (const [description, width, height, expectedWidthMm, expectedHeightMm] of [
  ['A4 portrait', 210 * 72 / 25.4, 297 * 72 / 25.4, 210, 297],
  ['A4 landscape', 297 * 72 / 25.4, 210 * 72 / 25.4, 297, 210],
  ['a custom page', 360, 144, 127, 50.8],
  ['a page already rotated by PDF.js', 720, 360, 254, 127],
  ['a page with UserUnit already applied by PDF.js', 1224, 1584, 431.8, 558.8]
]) {
  test(`PDF import preserves physical dimensions for ${description}`, async () => {
    const h = harness({ empty: true, pages: 1,
      viewport: (_, scale) => ({ width: width * scale, height: height * scale }) });
    assert.equal(await h.run(), true);
    const size = h.images[0].pdfPageSizeMm;
    assert.ok(Math.abs(size.width - expectedWidthMm) < 1e-9);
    assert.ok(Math.abs(size.height - expectedHeightMm) < 1e-9);
    assert.deepEqual(h.images[0].originalPdfPageSizeMm, size);
    assert.notEqual(h.images[0].originalPdfPageSizeMm, size, 'Original size must be an independent value');
    const originalWidth = h.images[0].originalPdfPageSizeMm.width;
    size.width = 1;
    assert.equal(h.images[0].originalPdfPageSizeMm.width, originalWidth);
    assert.equal(h.viewports[0].scale, 1);
    assert.equal(h.images[0].rotation, 0, 'The PDF page rotation is already in the rendered pixels');
  });
}

test('PDF physical dimensions are independent of raster scale and canvas rounding', async () => {
  const h = harness({ empty: true, pages: 2,
    viewport: (number, scale) => ({ width: (number === 1 ? 600.125 : 1200.375) * scale,
      height: (number === 1 ? 800.875 : 1800.625) * scale }) });
  assert.equal(await h.run(), true);
  const scale1 = h.viewports.filter(call => call.number === 1)[1].scale;
  const scale2 = h.viewports.filter(call => call.number === 2)[1].scale;
  assert.equal(scale1, 2);
  assert.ok(scale2 > 1 && scale2 < 2);
  assert.ok(Math.abs(h.images[0].pdfPageSizeMm.width - 600.125 * 25.4 / 72) < 1e-9);
  assert.ok(Math.abs(h.images[1].pdfPageSizeMm.height - 1800.625 * 25.4 / 72) < 1e-9);
  assert.ok(h.renders[0].width > 600.125, 'The raster is deliberately larger than the physical-size viewport');
});

for (const [description, width, height] of [
  ['a square page above the rendering cap', 100000, 100000],
  ['a very wide page', 100000000, 1000],
  ['a very tall page', 1000, 100000000],
  ['an irregular page requiring a sub-one scale', 12000.125, 48000.875]
]) {
  test(`PDF import bounds raster allocation for ${description} without changing paper size`, async () => {
    const h = harness({ empty: true, pages: 1,
      viewport: (_, scale) => ({ width: width * scale, height: height * scale }) });
    assert.equal(await h.run(), true);
    assert.equal(h.renders.length, 1);
    const rendered = h.renders[0];
    assert.ok(rendered.width > 0 && rendered.height > 0);
    assert.ok(rendered.width <= 2400 && rendered.height <= 2400,
      `Unsafe raster allocated at ${rendered.width} × ${rendered.height}`);
    assert.ok(h.viewports[1].scale < 1, 'Large pages must be allowed to render below scale one');
    assert.ok(Math.abs(h.images[0].pdfPageSizeMm.width - width * 25.4 / 72) < 1e-5);
    assert.ok(Math.abs(h.images[0].pdfPageSizeMm.height - height * 25.4 / 72) < 1e-5);
    assertCleaned(h, [1]);
  });
}

test('a rendered PDF viewport that ignores its safe scale is rejected before canvas allocation', async () => {
  const h = harness({ empty: true, pages: 1, viewport: (_, scale) =>
    scale === 1 ? { width: 100000, height: 100000 } : { width: 50000, height: 50000 } });
  assert.equal(await h.run(), false);
  assert.equal(h.canvases.length, 0, 'Invalid render dimensions must be rejected before canvas creation');
  assert.equal(h.stores.size, 0); assert.equal(h.snapshots.length, 0);
  assert.deepEqual(h.images, []); assert.equal(h.registered.length, 0);
  assert.equal(h.alerts.length, 1); assertCleaned(h, [1]);
});

for (const invalidDimension of [0, -1, NaN, Infinity]) {
  test(`invalid scaled PDF viewport ${String(invalidDimension)} rolls back before allocation`, async () => {
    const h = harness({ empty: true, pages: 1, viewport: (_, scale) =>
      scale === 1 ? { width: 600, height: 800 } : { width: invalidDimension, height: 800 } });
    assert.equal(await h.run(), false);
    assert.equal(h.canvases.length, 0); assert.equal(h.registered.length, 0);
    assert.equal(h.stores.size, 0); assert.equal(h.snapshots.length, 0);
    assert.deepEqual(h.images, []); assertCleaned(h, [1]);
  });
}

for (const [description, invalidWidth, invalidHeight] of [
  ['zero width', 0, 800], ['negative width', -600, 800], ['NaN width', NaN, 800],
  ['infinite height', 600, Infinity], ['zero height', 600, 0], ['a nonnumeric height', 600, '800']
]) {
  test(`PDF import rejects ${description} and rolls back the whole file`, async () => {
    const h = harness({ empty: true, pages: 2,
      viewport: (number, scale) => number === 1
        ? { width: 600 * scale, height: 800 * scale }
        : { width: invalidWidth, height: invalidHeight } });
    assert.equal(await h.run(), false);
    assert.deepEqual(h.images, []); assert.equal(h.stores.size, 0); assert.equal(h.snapshots.length, 0);
    assert.equal(h.fields.pageSize.value, 'a4'); assert.equal(h.fields.margin.value, '10');
    assert.equal(h.fields.orientation.value, 'landscape');
    assert.match(h.alerts[0], /Page 2 has invalid dimensions/);
    assert.equal(h.canvases.length, 1);
    assert.deepEqual(h.revoked.sort(), ['blob:page1', 'blob:page1-thumb']);
    assertCleaned(h, [1, 2]);
  });
}

for (const [phase, makeOptions, expectedCleaned, expectedRevoked] of [
  ['getPage', () => ({ getPage: number => { if (number === 2) throw new Error('Page read failed'); } }), [1], ['blob:page1', 'blob:page1-thumb']],
  ['render', () => ({ render: number => { if (number === 2) throw new Error('Render failed'); } }), [1, 2], ['blob:page1', 'blob:page1-thumb']],
  ['encode', () => ({ encode: number => { if (number === 2) throw new Error('Encode failed'); } }), [1, 2], ['blob:page1', 'blob:page1-thumb']],
  ['thumbnail', () => ({ thumb: src => { if (src === 'blob:page2') throw new Error('Thumbnail failed'); } }), [1, 2], ['blob:page1', 'blob:page1-thumb', 'blob:page2']]
]) {
  test(`${phase} failure rolls back staged pages, history, settings and resources`, async () => {
    const h = harness({ empty: true, ...makeOptions() });
    assert.equal(await h.run(), false);
    assert.deepEqual(h.images, []); assert.equal(h.stores.size, 0); assert.equal(h.snapshots.length, 0);
    assert.equal(h.stats().refreshed, 0); assert.equal(h.fields.pageSize.value, 'a4'); assert.equal(h.fields.margin.value, '10');
    assert.equal(h.fields.orientation.value, 'landscape');
    assert.equal(h.refs.size, 0); assert.deepEqual(h.revoked.sort(), expectedRevoked.sort());
    assert.equal(h.alerts.length, 1); assert.match(h.alerts[0], /Could not import "Example.pdf"/);
    assertCleaned(h, expectedCleaned);
  });
}

test('pages remain private while later PDF page work is in progress', async () => {
  let continueRender;
  const pendingRender = new Promise(resolve => { continueRender = resolve; });
  let renderingSecond;
  const secondStarted = new Promise(resolve => { renderingSecond = resolve; });
  const h = harness({ render: number => { if (number === 2) { renderingSecond(); return pendingRender; } } });
  const result = h.run();
  await secondStarted;
  assert.equal(h.images.length, 1); assert.equal(h.stores.size, 0); assert.equal(h.snapshots.length, 0);
  continueRender(); assert.equal(await result, true); assert.equal(h.images.length, 3);
});

test('load failure hides the spinner and preserves the document', async () => {
  const h = harness({ open: () => { throw new Error('Malformed PDF'); } });
  assert.equal(await h.run(), false); assert.equal(h.images.length, 1); assert.equal(h.snapshots.length, 0);
  assert.equal(h.loading.at(-1)[1], false); assert.equal(h.stats().destroyed, 0); assert.equal(h.alerts.length, 1);
});

test('a missing PDF library reports failure and cleans up its loading indicator', async () => {
  const h = harness({ missingLoader: true });
  assert.equal(await h.run(), false); assert.match(h.alerts[0], /PDF loader is unavailable/);
  assert.equal(h.loading.at(-1)[1], false); assert.equal(h.snapshots.length, 0);
});

test('password retries use fresh file buffers and successful pages import normally', async () => {
  const h = harness({ pages: 1, passwords: ['wrong', 'correct'], open(parameters, doc) {
    if (parameters.password !== 'correct') { const error = new Error('Password required'); error.name = 'PasswordException'; throw error; }
    return doc;
  } });
  assert.equal(await h.run(), true); assert.equal(h.stats().reads, 3); assert.equal(h.prompts.length, 2);
  assert.equal(new Set(h.opens.map(parameters => parameters.data)).size, 3);
  assert.deepEqual(h.opens.map(parameters => parameters.password), [undefined, 'wrong', 'correct']);
  assertCleaned(h, [1]);
});

test('password cancellation stops cleanly without an error alert', async () => {
  const h = harness({ passwords: [null], open() { const error = new Error('Password required'); error.name = 'PasswordException'; throw error; } });
  assert.equal(await h.run(), false); assert.deepEqual(h.alerts, []); assert.equal(h.snapshots.length, 0);
  assert.equal(h.loading.at(-1)[1], false); assert.equal(h.stats().reads, 1);
});

test('three incorrect password attempts report failure without changing the document', async () => {
  const h = harness({ passwords: ['a', 'b', 'c'], open() { const error = new Error('Password required'); error.name = 'PasswordException'; throw error; } });
  assert.equal(await h.run(), false); assert.equal(h.stats().reads, 4); assert.equal(h.prompts.length, 3);
  assert.match(h.alerts[0], /Incorrect password/); assert.equal(h.images.length, 1); assert.equal(h.loading.at(-1)[1], false);
});

test('cleanup errors cannot strand the spinner or override a rendering error', async () => {
  const h = harness({ cleanupThrows: true, destroyThrows: true, render() { throw new Error('Original render failure'); } });
  assert.equal(await h.run(), false); assert.match(h.alerts[0], /Original render failure/);
  assertCleaned(h, [1]);
});

test('shared source and thumbnail URLs retain all committed store references', async () => {
  const h = harness({ pages: 1, sharedThumb: true });
  assert.equal(await h.run(), true); assert.equal(h.refs.get('blob:page1'), 3); assert.deepEqual(h.revoked, []);
});

test('a canvas allocation failure releases the current page and PDF worker', async () => {
  const h = harness({ missingContext: true });
  assert.equal(await h.run(), false); assert.equal(h.snapshots.length, 0); assertCleaned(h, [1]);
});

test('an empty PDF fails without altering settings or creating a history entry', async () => {
  const h = harness({ empty: true, pages: 0 });
  assert.equal(await h.run(), false); assert.equal(h.fields.pageSize.value, 'a4');
  assert.equal(h.snapshots.length, 0); assertCleaned(h, []);
});

test('the actual handleFiles PDF loop continues after an earlier PDF render failure', async () => {
  const h = harness({ open(parameters, doc) {
    if (new Uint8Array(parameters.data)[0] === 1) {
      return { ...doc, async getPage(number) {
        const page = await doc.getPage(number);
        if (number === 2) page.render = ({ canvasContext }) => {
          canvasContext.canvas.page = number;
          return { promise: Promise.reject(new Error('First PDF render failed')) };
        };
        return page;
      } };
    }
    return doc;
  } });
  vm.runInContext(queueSource, h.context);
  const originalLoad = h.context.loadPdfFile;
  const calls = [];
  let completeLoop;
  const completed = new Promise(resolve => { completeLoop = resolve; });
  h.context.loadPdfFile = async (file, target) => {
    const success = await originalLoad(file, target);
    calls.push([file.name, success]);
    if (calls.length === 2) completeLoop();
    return success;
  };
  const file = (name, id) => ({ name, type: 'application/pdf', size: 100,
    async arrayBuffer() { return new Uint8Array([id]).buffer; } });
  h.context.handleFiles([file('Broken.pdf', 1), file('Good.pdf', 2)], 'edit');
  await completed;
  assert.deepEqual(calls, [['Broken.pdf', false], ['Good.pdf', true]]);
  assert.deepEqual(h.images.map(image => image.name), ['Existing photo', 'Good.pdf – p1', 'Good.pdf – p2']);
  assert.equal(h.snapshots.length, 1); assert.match(h.snapshots[0].label, /Good.pdf/);
  assert.equal(h.stores.size, 2); assert.equal(h.stats().destroyed, 2);
  assert.equal(h.alerts.length, 1); assert.match(h.alerts[0], /First PDF render failed/);
  assert.equal(h.loading.at(-1)[1], false);
  assert.deepEqual(h.cleaned, [1, 2, 1, 2]);
  assert.ok(h.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

function cancelJob() {
  let current = true;
  const callbacks = new Set();
  return {
    isCurrent: () => current,
    onCancel(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
    cancel() { current = false; callbacks.forEach(callback => callback()); }
  };
}

for (const phase of ['read', 'open', 'getPage', 'render', 'encode', 'thumbnail']) {
  test(`cancellation during PDF ${phase} discards staged pages and all late resources`, async () => {
    let resume, started;
    const pending = new Promise(resolve => { resume = resolve; });
    const boundary = new Promise(resolve => { started = resolve; });
    const pause = () => { started(); return pending; };
    const options = { empty: true, pages: 1 };
    if (phase === 'read') options.read = pause;
    if (phase === 'open') options.open = async (_, doc) => { await pause(); return doc; };
    if (phase === 'getPage') options.getPage = pause;
    if (phase === 'render') options.render = pause;
    if (phase === 'encode') options.encode = pause;
    if (phase === 'thumbnail') options.thumb = pause;
    const h = harness(options), job = cancelJob();
    const result = h.run(job);
    await boundary;
    job.cancel(); resume();
    assert.equal(await result, false);
    assert.deepEqual(h.images, []); assert.equal(h.stores.size, 0); assert.equal(h.snapshots.length, 0);
    assert.equal(h.registered.length, 0); assert.equal(h.refs.size, 0); assert.deepEqual(h.alerts, []);
    assert.equal(h.fields.pageSize.value, 'a4'); assert.equal(h.loading.at(-1)[1], false);
    assert.equal(h.stats().destroyed, phase === 'read' ? 0 : 1);
    assert.ok(h.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
    assert.equal(h.revoked.length, phase === 'thumbnail' ? 2 : phase === 'encode' ? 1 : 0);
    if (phase === 'render') assert.deepEqual(h.canceledRenders, [1]);
  });
}

test('cancellation after a staged PDF page also discards previous pages without source registration', async () => {
  let resume, started;
  const pending = new Promise(resolve => { resume = resolve; });
  const boundary = new Promise(resolve => { started = resolve; });
  const h = harness({ empty: true, render: number => { if (number === 2) { started(); return pending; } } });
  const job = cancelJob(), result = h.run(job);
  await boundary; job.cancel(); resume();
  assert.equal(await result, false); assert.deepEqual(h.images, []); assert.equal(h.registered.length, 0);
  assert.deepEqual(h.revoked.sort(), ['blob:page1', 'blob:page1-thumb']);
  assert.equal(h.stats().destroyed, 1); assert.deepEqual(h.cleaned, [1, 2]);
});

test('an already canceled PDF job does not read the file or open the parser', async () => {
  const h = harness(), job = cancelJob(); job.cancel();
  assert.equal(await h.run(job), false);
  assert.equal(h.stats().reads, 0); assert.equal(h.opens.length, 0); assert.deepEqual(h.alerts, []);
  assert.equal(h.snapshots.length, 0); assert.equal(h.registered.length, 0);
});

test('an asynchronous object URL creation error rejects canvas encoding', async () => {
  const context = vm.createContext({ window: {}, URL: { createObjectURL() { throw new Error('URL allocation failed'); } } });
  vm.runInContext(appFunction('canvasToUrl'), context);
  const canvas = { toBlob(callback) { setImmediate(() => callback({ size: 1 })); } };
  await assert.rejects(context.canvasToUrl(canvas, 0.88), /URL allocation failed/);
});

test('an asynchronous fallback encoding error rejects rather than leaving import pending', async () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(appFunction('canvasToUrl'), context);
  const canvas = {
    toBlob(callback) { setImmediate(() => callback(null)); },
    toDataURL() { throw new Error('Fallback encoding failed'); }
  };
  await assert.rejects(context.canvasToUrl(canvas, 0.88), /Fallback encoding failed/);
});

test('thumbnail encoding failure releases its actual helper canvas', async () => {
  const canvas = { width: 0, height: 0, getContext() { return { fillRect() {}, drawImage() {} }; } };
  const context = vm.createContext({
    document: { createElement: () => canvas },
    loadImage: async () => ({ naturalWidth: 1200, naturalHeight: 800 }),
    canvasToUrl: async () => { throw new Error('Thumbnail encode failed'); }
  });
  vm.runInContext(appFunction('generateThumb'), context);
  await assert.rejects(context.generateThumb('blob:page'), /Thumbnail encode failed/);
  assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
});
