const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = ['file-intake.js', 'import-queue.js'].map(name => fs.readFileSync(path.join(__dirname, '../js', name), 'utf8')).join('\n');
const appSource = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const file = (name, type = 'image/png') => ({ name, type, size: 123 });
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function harness(options = {}) {
  const images = [], refs = new Map(), revoked = [], starts = [], stores = new Map(), snapshots = [], toasts = [], loading = [], allocated = [];
  let id = 0, url = 0;
  const retain = value => {
    if (typeof value === 'string' && value.startsWith('blob:')) refs.set(value, (refs.get(value) || 0) + 1);
  };
  const release = value => {
    if (typeof value !== 'string' || !value.startsWith('blob:')) return;
    const count = (refs.get(value) || 0) - 1;
    if (count > 0) refs.set(value, count);
    else { refs.delete(value); revoked.push(value); }
  };
  const context = vm.createContext({
    images, Promise, setTimeout: callback => callback(),
    URL: { createObjectURL(value) { allocated.push(value); return 'blob:' + value.name + '-' + ++url; }, revokeObjectURL(value) { revoked.push(value); } },
    retainUrl: retain, releaseUrl: release,
    async loadImage(src) { starts.push(src); if (options.decode) await options.decode(src); return { naturalWidth: 100, naturalHeight: 200 }; },
    async generateThumb(src) { if (options.thumb) await options.thumb(src); return options.sharedThumb ? src : src + '-thumb'; },
    _imgId: () => 'image' + ++id,
    putStore(key, entry) { stores.set(key, entry); Object.values(entry).forEach(retain); },
    snapshot(label) { snapshots.push({ label, names: images.map(entry => entry.name) }); },
    refreshAll() {}, showToast(message) { toasts.push(message); }, showPdfLoading(...args) { loading.push(args); },
    async loadPdfFile(pdf, target, job) {
      starts.push(pdf.name);
      if (options.pdf) await options.pdf(pdf, target, job);
      if (!job.isCurrent() || pdf.fail) return false;
      images.push({ name: pdf.name + '-p1' }, { name: pdf.name + '-p2' });
      snapshots.push({ label: 'PDF', names: images.map(entry => entry.name) });
      return true;
    }
  });
  context.window = context;
  vm.runInContext(source, context);
  return { context, images, refs, revoked, starts, stores, snapshots, toasts, loading, allocated,
    import: (files, target = 'edit') => context.handleFiles(files, target), cancel: () => context.cancelImports() };
}

test('mixed selections keep exact file order and PDF page groups', async () => {
  const h = harness();
  assert.equal(await h.import([file('A.png'), file('B.pdf', 'application/pdf'), file('C.png'), file('D.pdf', 'application/pdf')]), true);
  assert.deepEqual(h.images.map(entry => entry.name), ['A.png', 'B.pdf-p1', 'B.pdf-p2', 'C.png', 'D.pdf-p1', 'D.pdf-p2']);
  assert.equal(h.snapshots.length, 4);
});

test('overlapping selections finish in picker/drop order rather than decode order', async () => {
  const gate = deferred(), started = deferred();
  const h = harness({ decode: src => { if (src.includes('A.png')) { started.resolve(); return gate.promise; } } });
  const first = h.import([file('A.png'), file('B.pdf', 'application/pdf')]);
  await started.promise;
  const second = h.import([file('C.png'), file('D.pdf', 'application/pdf')]);
  assert.deepEqual(h.starts, ['blob:A.png-1']);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(h.images.map(entry => entry.name), ['A.png', 'B.pdf-p1', 'B.pdf-p2', 'C.png', 'D.pdf-p1', 'D.pdf-p2']);
});

test('an overlapping selection cannot insert into the middle of a PDF', async () => {
  const gate = deferred(), started = deferred();
  const h = harness({ pdf: () => { started.resolve(); return gate.promise; } });
  const first = h.import([file('A.pdf', 'application/pdf'), file('B.png')]);
  await started.promise;
  const second = h.import([file('C.png')]);
  assert.deepEqual(h.starts, ['A.pdf']);
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(h.images.map(entry => entry.name), ['A.pdf-p1', 'A.pdf-p2', 'B.png', 'C.png']);
});

test('failed image decode or thumbnail is skipped without disturbing later order', async () => {
  const h = harness({ decode: src => { if (src.includes('bad.png')) throw new Error('Decode failure'); },
    thumb: src => { if (src.includes('thumb.png')) throw new Error('Thumbnail failure'); } });
  assert.equal(await h.import([file('bad.png'), file('A.pdf', 'application/pdf'), file('thumb.png'), file('good.png')]), true);
  assert.deepEqual(h.images.map(entry => entry.name), ['A.pdf-p1', 'A.pdf-p2', 'good.png']);
  assert.equal(h.toasts.length, 2); assert.equal(h.stores.size, 1);
  assert.deepEqual(h.revoked.sort(), ['blob:bad.png-1', 'blob:thumb.png-2']);
});

test('a failed PDF is skipped and the next mixed file still imports', async () => {
  const h = harness();
  assert.equal(await h.import([{ ...file('bad.pdf', 'application/pdf'), fail: true }, file('good.png')]), true);
  assert.deepEqual(h.images.map(entry => entry.name), ['good.png']);
});

test('the combined convert picker imports images and PDF page groups in order without silently skipping PDFs', async () => {
  const targets = [];
  const h = harness({ pdf: (file, target, job) => targets.push([file.name, target, job.target]) });
  assert.equal(await h.import([
    file('A.png'), file('B.pdf', 'application/pdf'), file('C.jpg', 'image/jpeg'), file('D.pdf', 'application/pdf')
  ], 'convert'), true);
  assert.deepEqual(h.images.map(entry => entry.name), ['A.png', 'B.pdf-p1', 'B.pdf-p2', 'C.jpg', 'D.pdf-p1', 'D.pdf-p2']);
  assert.deepEqual(targets, [['B.pdf', 'convert', 'convert'], ['D.pdf', 'convert', 'convert']]);
  const report = h.context.getImportReport('convert');
  assert.equal(report.selected, 4); assert.equal(report.imported, 4);
  assert.equal(report.skipped.length, 0); assert.equal(report.canceled, false);
  assert.deepEqual(h.toasts, []);
});

test('a PDF-only convert selection succeeds and a failed PDF remains visible in the same workspace report', async () => {
  const h = harness();
  assert.equal(await h.import([file('A.pdf', 'application/pdf')], 'convert'), true);
  assert.deepEqual(h.images.map(entry => entry.name), ['A.pdf-p1', 'A.pdf-p2']);
  assert.equal(h.context.getImportReport('convert').imported, 1);
  assert.equal(await h.import([{ ...file('bad.pdf', 'application/pdf'), fail: true }], 'convert'), false);
  const report = h.context.getImportReport('convert');
  assert.equal(report.imported, 0); assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].name, 'bad.pdf');
  assert.match(report.skipped[0].reason, /could not be imported/);
  assert.deepEqual(h.images.map(entry => entry.name), ['A.pdf-p1', 'A.pdf-p2']);
});

test('PDF filename fallback uses one classification even for an image MIME type', async () => {
  const h = harness();
  await h.import([file('A.PDF', 'image/png')]);
  assert.deepEqual(h.images.map(entry => entry.name), ['A.PDF-p1', 'A.PDF-p2']);
});

test('empty and unsupported selections settle without entering the queue', async () => {
  const h = harness();
  assert.equal(await h.import([]), false);
  assert.equal(await h.import([file('note.txt', 'text/plain')]), false);
  assert.equal(await h.import([file('note.txt', 'text/plain')], 'convert'), false);
  assert.deepEqual(h.starts, []);
});

test('a FileList is copied when enqueued so later mutations cannot change the selection', async () => {
  const gate = deferred(), started = deferred();
  const h = harness({ decode: () => { started.resolve(); return gate.promise; } });
  const files = [file('A.png'), file('B.png')];
  const pending = h.import(files);
  await started.promise;
  files.splice(0, files.length, file('replacement.png'));
  gate.resolve(); await pending;
  assert.deepEqual(h.images.map(entry => entry.name), ['A.png', 'B.png']);
});

for (const phase of ['decode', 'thumbnail']) {
  test(`cancellation during image ${phase} releases late resources without committing`, async () => {
    const gate = deferred(), started = deferred();
    const options = { [phase === 'decode' ? 'decode' : 'thumb']: () => { started.resolve(); return gate.promise; } };
    const h = harness(options);
    const first = h.import([file('A.png'), file('B.pdf', 'application/pdf')]);
    await started.promise;
    const queued = h.import([file('C.png')]);
    h.cancel();
    assert.equal(await queued, false, 'Queued imports settle immediately on cancellation');
    gate.resolve(); assert.equal(await first, false);
    assert.deepEqual(h.images, []); assert.equal(h.stores.size, 0); assert.equal(h.snapshots.length, 0);
    assert.equal(h.refs.size, 0); assert.equal(h.toasts.length, 0);
    assert.equal(h.revoked.length, phase === 'decode' ? 1 : 2);
    assert.deepEqual(h.starts, ['blob:A.png-1']);
  });
}

test('shared source and thumbnail leases release only temporary ownership', async () => {
  const h = harness({ sharedThumb: true });
  await h.import([file('A.png')]);
  assert.equal(h.refs.get('blob:A.png-1'), 3);
  assert.deepEqual(h.revoked, []);
});

test('a new selection after cancellation imports normally after stale decoding settles', async () => {
  const gate = deferred(), started = deferred();
  const h = harness({ decode: src => { if (src.includes('old.png')) { started.resolve(); return gate.promise; } } });
  const old = h.import([file('old.png')]); await started.promise;
  h.cancel();
  const fresh = h.import([file('new.png')]);
  gate.resolve(); assert.deepEqual(await Promise.all([old, fresh]), [false, true]);
  assert.deepEqual(h.images.map(entry => entry.name), ['new.png']);
  assert.deepEqual(h.revoked, ['blob:old.png-1']);
});

test('canceling a PDF invokes its cleanup subscriptions once and prevents subsequent files', async () => {
  const gate = deferred(), started = deferred();
  let canceled = 0;
  const h = harness({ pdf: async (_, target, job) => {
    assert.equal(target, 'edit');
    const unsubscribe = job.onCancel(() => { canceled++; gate.resolve(); });
    started.resolve(); await gate.promise; unsubscribe();
  } });
  const pending = h.import([file('A.pdf', 'application/pdf'), file('B.png')]);
  await started.promise; h.cancel(); h.cancel();
  assert.equal(await pending, false); assert.equal(canceled, 1);
  assert.deepEqual(h.images, []); assert.deepEqual(h.starts, ['A.pdf']);
  assert.equal(h.loading.at(-1)[1], false);
});

test('undo-style cancellation stops later files even after earlier files were committed', async () => {
  const gate = deferred(), started = deferred();
  const h = harness({ decode: src => { if (src.includes('B.png')) { started.resolve(); return gate.promise; } } });
  const pending = h.import([file('A.png'), file('B.png'), file('C.png')]);
  await started.promise;
  assert.deepEqual(h.images.map(entry => entry.name), ['A.png']);
  h.cancel(); h.images.splice(0); // The root undo/clear action restores the document synchronously.
  gate.resolve(); assert.equal(await pending, false);
  assert.deepEqual(h.images, []); assert.equal(h.snapshots.length, 1);
  assert.deepEqual(h.starts, ['blob:A.png-1', 'blob:B.png-2']);
});

function installActualDecoder(h) {
  const decodedImages = [];
  h.context.Image = class {
    constructor() { decodedImages.push(this); this._src = ''; }
    set src(value) { this._src = value; }
    get src() { return this._src; }
  };
  const actualFunction = appSource.match(/function loadImage\([^]*?\n\}/)[0];
  vm.runInContext('const _imgCache = new Map(); const _imageDecodes = new Map();\n' + actualFunction, h.context);
  return decodedImages;
}

test('actual image cancellation aborts decoding and lets the next import run immediately', async () => {
  const h = harness(), decodedImages = installActualDecoder(h);
  const old = h.import([file('old.png')]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(decodedImages.length, 1);
  const lateOnload = decodedImages[0].onload;
  h.cancel();
  const fresh = h.import([file('new.png')]);
  assert.equal(await old, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(decodedImages[0].src, '', 'The canceled image request must be aborted');
  assert.equal(decodedImages.length, 2, 'New imports must not wait for canceled decoding');
  assert.deepEqual(h.revoked, ['blob:old.png-1']);
  lateOnload();
  assert.equal(vm.runInContext('_imgCache.size', h.context), 0, 'Stale callbacks must not cache a revoked source');
  decodedImages[1].onload();
  assert.equal(await fresh, true);
  assert.deepEqual(h.images.map(entry => entry.name), ['new.png']);
  assert.equal(vm.runInContext('_imgCache.size', h.context), 1);
});

test('the actual decoder rejects an already canceled job without allocating an Image', async () => {
  const h = harness(), decodedImages = installActualDecoder(h);
  const job = h.context.createImportJob([], 'edit');
  job.cancel();
  await assert.rejects(h.context.loadImage('blob:never-requested', job), { name: 'ImportCanceledError' });
  assert.equal(decodedImages.length, 0);
});

function headerFile(name, width = 100, height = 200, type = '') {
  const bytes = new Uint8Array(24); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(Buffer.from('IHDR'), 12); const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return { ...file(name, type), slice(start, end, mime) { return { name, type: mime || type, arrayBuffer: async () => bytes.slice(start, end).buffer }; } };
}
function installLimits(h) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/raster-limits.js'), 'utf8'), h.context);
  return h.context.PhotoPdfLimits;
}

test('empty and misleading image MIME types import by signature in the original order', async () => {
  const h = harness();
  await h.import([headerFile('no-extension'), headerFile('photo.txt', 100, 200, 'text/plain'), file('third.JPG', '')]);
  assert.deepEqual(h.images.map(entry => entry.name), ['no-extension', 'photo.txt', 'third.JPG']);
});

test('unsupported drops have persistent names and reasons, including explicit TIFF refusal', async () => {
  const h = harness();
  await h.import([file('scan.TIFF', ''), file('notes.txt', 'text/plain'), file('good.png')]);
  const report = h.context.getImportReport('edit');
  assert.equal(report.selected, 3); assert.equal(report.imported, 1);
  assert.deepEqual(Array.from(report.skipped, item => item.name), ['scan.TIFF', 'notes.txt']);
  assert.match(report.skipped[0].reason, /multipage TIFF/);
  assert.match(report.skipped[1].reason, /Unsupported format/);
  assert.equal('file' in report.skipped[0], false, 'The retained report must not keep File objects alive');
  report.skipped[0].reason = 'mutated';
  assert.match(h.context.getImportReport('edit').skipped[0].reason, /TIFF/);
});

test('a recognized PDF signature with unknown name and MIME uses PDF import', async () => {
  const h = harness(), bytes = Uint8Array.from(Buffer.from('%PDF-1.7\n'));
  await h.import([{ ...file('unnamed', 'image/jpeg'), slice() { return { arrayBuffer: async () => bytes.buffer }; } }]);
  assert.deepEqual(h.images.map(entry => entry.name), ['unnamed-p1', 'unnamed-p2']);
});

test('limits reject oversized or unknown header dimensions before allocating or decoding', async () => {
  const h = harness(); installLimits(h);
  await h.import([headerFile('giant.png', 9000, 2), file('no-dimensions.jpg'), headerFile('good.png')]);
  assert.deepEqual(h.starts, ['blob:good.png-1']);
  assert.deepEqual(h.images.map(entry => entry.name), ['good.png']);
  assert.equal(h.context.getImportReport('edit').skipped.length, 2);
  assert.match(h.context.getImportReport('edit').skipped[0].reason, /too large/);
  assert.match(h.context.getImportReport('edit').skipped[1].reason, /verified safely/);
});

test('oversized compressed files are rejected before image URLs are created', async () => {
  const h = harness(); installLimits(h);
  await h.import([{ ...headerFile('giant.png'), size: 33 * 1024 * 1024 }]);
  assert.deepEqual(h.starts, []); assert.deepEqual(h.revoked, []);
  assert.match(h.context.getImportReport('edit').skipped[0].reason, /32 MB/);
});

test('retained-byte admission failure revokes the new input URL and reports the reason', async () => {
  const h = harness(), limits = installLimits(h);
  limits.reserveBytes('occupied', 128 * 1024 * 1024);
  await h.import([headerFile('photo.png')]);
  assert.deepEqual(h.starts, []); assert.deepEqual(h.revoked, ['blob:photo.png-1']);
  assert.equal(h.refs.size, 0); assert.match(h.context.getImportReport('edit').skipped[0].reason, /128 MB/);
});

test('decoded dimensions are checked before thumbnail allocation', async () => {
  const h = harness(); installLimits(h);
  h.context.loadImage = async () => ({ naturalWidth: 8193, naturalHeight: 1 });
  h.context.generateThumb = () => { throw new Error('The thumbnail must not be allocated'); };
  await h.import([headerFile('photo.png')]);
  assert.deepEqual(h.images, []); assert.deepEqual(h.revoked, ['blob:photo.png-1']);
  assert.match(h.context.getImportReport('edit').skipped[0].reason, /Decoded image is too large/);
});

test('page-count limits are checked before new images allocate resources', async () => {
  const h = harness(); installLimits(h);
  h.images.push(...Array.from({ length: 200 }, () => ({ name: 'existing' })));
  await h.import([headerFile('photo.png')]);
  assert.deepEqual(h.starts, []); assert.match(h.context.getImportReport('edit').skipped[0].reason, /200 pages/);
});

test('cancellation during bounded header reading prevents late decode and commit', async () => {
  const h = harness(), gate = deferred(), started = deferred();
  const pending = h.import([{ ...file('old.png'), slice() { started.resolve(); return { arrayBuffer: () => gate.promise }; } }]);
  await started.promise; h.cancel();
  const fresh = h.import([headerFile('new.png')]);
  gate.resolve(new ArrayBuffer(0)); assert.deepEqual(await Promise.all([pending, fresh]), [false, true]);
  assert.deepEqual(h.starts, ['blob:new.png-1']);
});

test('PDF importer failure reasons persist without duplicate generic entries', async () => {
  const h = harness({ pdf(pdf, target, job) { job.reportIssue(pdf, 'Page render exceeded the safety limit.'); } });
  await h.import([{ ...file('bad.pdf', 'application/pdf'), fail: true }]);
  const report = h.context.getImportReport('edit');
  assert.equal(report.skipped.length, 1); assert.match(report.skipped[0].reason, /Page render/);
});

test('persistent report renders filenames as text rather than HTML', async () => {
  const h = harness();
  const node = () => ({ children: [], appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
  const panel = node();
  h.context.document = { getElementById() { return panel; }, createElement() { return node(); } };
  await h.import([file('<img src=x onerror=alert(1)>.tiff', '')]);
  assert.equal(panel.hidden, false);
  assert.equal(panel.children[1].children[0].textContent.startsWith('<img src=x onerror=alert(1)>.tiff:'), true);
  assert.equal('innerHTML' in panel.children[1].children[0], false);
});

test('a selection above 200 files is rejected before copying its FileList or allocating resources', async () => {
  const h = harness(); let iterated = false;
  const files = { length: 201, get [Symbol.iterator]() { iterated = true; throw new Error('Do not copy'); } };
  assert.equal(await h.import(files), false);
  assert.equal(iterated, false); assert.deepEqual(h.starts, []); assert.deepEqual(h.allocated, []);
  const report = h.context.getImportReport('edit');
  assert.equal(report.selected, 201); assert.equal(report.imported, 0);
  assert.match(report.skipped[0].reason, /entire selection was skipped/);
  assert.equal(vm.runInContext('importQueue.length', h.context), 0);
});

test('exactly 200 selected files can enter the queue in order', async () => {
  const h = harness();
  const files = Array.from({ length: 200 }, (_, index) => file(index + '.png'));
  assert.equal(await h.import(files), true);
  assert.equal(h.images.length, 200); assert.equal(h.images[199].name, '199.png');
});

test('the queue holds at most ten waiting selections and rejects extra selections before copying', async () => {
  const gate = deferred(), started = deferred();
  const h = harness({ decode: src => { if (src.includes('active.png')) { started.resolve(); return gate.promise; } } });
  const active = h.import([file('active.png')]); await started.promise;
  const queued = Array.from({ length: 10 }, (_, index) => h.import([file(index + '.png')]));
  let iterated = false;
  assert.equal(await h.import({ length: 1, get [Symbol.iterator]() { iterated = true; throw new Error('Do not copy'); } }), false);
  assert.equal(iterated, false); assert.equal(vm.runInContext('importQueue.length', h.context), 10);
  assert.equal(h.allocated.length, 1);
  assert.match(h.context.getImportReport('edit').skipped[0].reason, /ten|10 selections/);
  h.cancel(); assert.deepEqual(await Promise.all(queued), Array(10).fill(false));
  const report = h.context.getImportReport('edit');
  assert.equal(report.canceled, true); assert.equal(report.selected, 1);
  assert.match(report.cancellationReason, /canceled before it started/);
  assert.equal('files' in report, false);
  gate.resolve(); assert.equal(await active, false);
  assert.deepEqual(h.starts, ['blob:active.png-1']);
  assert.match(h.context.getImportReport('edit').cancellationReason, /before it started/, 'The older active job must not overwrite the newer queued report');
});

test('a newer selection rejection remains visible when an older accepted import later finishes', async () => {
  const gate = deferred(), started = deferred();
  const h = harness({ decode: () => { started.resolve(); return gate.promise; } });
  const accepted = h.import([file('old.png')]); await started.promise;
  assert.equal(await h.import({ length: 500 }), false);
  gate.resolve(); assert.equal(await accepted, true);
  assert.equal(h.context.getImportReport('edit').selected, 500);
});

test('missing or stale report DOM methods cannot strand import promises or following selections', async () => {
  for (const panel of [{}, { replaceChildren() { throw new Error('Removed DOM'); } }]) {
    const h = harness();
    h.context.document = { getElementById() { return panel; }, createElement() { return {}; } };
    assert.equal(await h.import([file('scan.tiff')]), false);
    assert.equal(await h.import([file('good.png')]), true);
    assert.equal(vm.runInContext('importRunnerActive', h.context), false);
  }
});

test('signature-detected images normalize Blob MIME while preserving exact input bytes', async () => {
  for (const type of ['', 'text/plain']) {
    const h = harness(); installLimits(h);
    const header = headerFile('photo.bin'); const bytes = await header.slice(0, header.size).arrayBuffer();
    const image = new Blob([bytes], { type }); image.name = 'photo.bin';
    assert.equal(await h.import([image]), true);
    assert.equal(h.allocated[0].type, 'image/png');
    assert.deepEqual(new Uint8Array(await h.allocated[0].arrayBuffer()), new Uint8Array(bytes));
  }
});

test('real classifier plus limits rejects a malformed PNG header before URL or decoding allocation', async () => {
  const h = harness(); installLimits(h);
  const malformed = new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
  malformed.name = 'malformed.png';
  assert.equal(await h.import([malformed]), false);
  assert.deepEqual(h.allocated, []); assert.deepEqual(h.starts, []);
  assert.match(h.context.getImportReport('edit').skipped[0].reason, /dimensions could not be verified/);
});

test('real PNG Blob headers above the raster cap are rejected before URL allocation', async () => {
  const h = harness(); installLimits(h);
  const header = headerFile('giant.png', 9000, 2);
  const input = new Blob([await header.slice(0, header.size).arrayBuffer()], { type: '' }); input.name = 'giant.png';
  assert.equal(await h.import([input]), false);
  assert.deepEqual(h.allocated, []); assert.deepEqual(h.starts, []);
  assert.match(h.context.getImportReport('edit').skipped[0].reason, /too large/);
});

test('real TIFF input is explicitly skipped without a decoder or image URL allocation', async () => {
  const h = harness(); installLimits(h);
  const input = new Blob([Uint8Array.from([73, 73, 42, 0])], { type: 'image/png' }); input.name = 'scan.png';
  assert.equal(await h.import([input]), false);
  assert.deepEqual(h.allocated, []); assert.deepEqual(h.starts, []);
  assert.match(h.context.getImportReport('edit').skipped[0].reason, /multipage TIFF/);
});
