const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const modulePath = path.resolve(__dirname, '../js/raster-limits.js');
const MiB = 1024 * 1024;
const safetyError = /limit|large|maximum|exceed|too|dimension|pixel|size|budget|memory|finite|integer/i;
function harness() {
  const context = vm.createContext({ window: {}, Map, Set, Uint8Array, Promise });
  vm.runInContext(fs.readFileSync(modulePath, 'utf8'), context);
  return { context, limits: context.window.PhotoPdfLimits };
}
function image(width, height) { return { naturalWidth: width, naturalHeight: height }; }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('raster limits admit the exact side and pixel boundaries', () => {
  const { limits } = harness();
  assert.doesNotThrow(() => limits.assertRaster(8192, 1, 'Test image'));
  assert.doesNotThrow(() => limits.assertRaster(1, 8192, 'Test image'));
  assert.doesNotThrow(() => limits.assertRaster(4000, 4000, 'Test image'));
  assert.throws(() => limits.assertRaster(8193, 1, 'Test image'), safetyError);
  assert.throws(() => limits.assertRaster(1, 8193, 'Test image'), safetyError);
  assert.throws(() => limits.assertRaster(4001, 4000, 'Test image'), safetyError);
});

for (const value of [0, -1, NaN, Infinity, -Infinity, 1.5, '10', undefined, null]) {
  test(`raster allocation rejects invalid dimension ${String(value)}`, () => {
    const { limits } = harness();
    assert.throws(() => limits.assertRaster(value, 10, 'Resize'), safetyError);
    assert.throws(() => limits.assertRaster(10, value, 'Resize'), safetyError);
  });
}

test('decoded-image validation checks both actual browser dimensions', () => {
  const { limits } = harness();
  assert.doesNotThrow(() => limits.assertDecodedImage(image(100, 80)));
  assert.throws(() => limits.assertDecodedImage(image(100000, 80)), safetyError);
  assert.throws(() => limits.assertDecodedImage(image(4000, 4001)), safetyError);
  assert.throws(() => limits.assertDecodedImage(image(0, 80)), safetyError);
});

for (const [width, height] of [[100000, 100000], [100000000, 1000], [1000, 100000000],
  [12000.125, 48000.875], [0.125, 0.25], [600.125, 800.875]]) {
  test(`PDF raster plan stays bounded for ${width} × ${height} points`, () => {
    const { limits } = harness();
    const plan = limits.pdfRenderSize(width, height);
    assert.ok(Number.isFinite(plan.scale) && plan.scale > 0 && plan.scale <= 2);
    assert.ok(Number.isInteger(plan.width) && plan.width > 0 && plan.width <= 2400);
    assert.ok(Number.isInteger(plan.height) && plan.height > 0 && plan.height <= 2400);
    if (Math.max(width, height) > 2400) assert.ok(plan.scale < 1);
    assert.doesNotThrow(() => limits.assertRaster(plan.width, plan.height, 'PDF page'));
  });
}

for (const value of [0, -1, NaN, Infinity, '600', undefined]) {
  test(`PDF raster plan rejects invalid physical dimension ${String(value)}`, () => {
    const { limits } = harness();
    assert.throws(() => limits.pdfRenderSize(value, 800), safetyError);
    assert.throws(() => limits.pdfRenderSize(600, value), safetyError);
  });
}

test('file preflight rejects excessive encoded image and PDF bytes', () => {
  const { limits } = harness();
  const raster = { kind: 'image', format: 'png', width: 4000, height: 4000 };
  assert.doesNotThrow(() => limits.preflightFile({ name: 'photo.png', size: 32 * MiB }, raster));
  assert.throws(() => limits.preflightFile({ name: 'photo.png', size: 32 * MiB + 1 }, raster), safetyError);
  assert.doesNotThrow(() => limits.preflightFile({ name: 'pages.pdf', size: 50 * MiB }, { kind: 'pdf' }));
  assert.throws(() => limits.preflightFile({ name: 'pages.pdf', size: 50 * MiB + 1 }, { kind: 'pdf' }), safetyError);
});

test('file preflight rejects unknown and oversized image dimensions before decode', () => {
  const { limits } = harness();
  const file = { name: 'untrusted.png', size: 100 };
  assert.throws(() => limits.preflightFile(file, { kind: 'image', format: 'png' }), safetyError);
  assert.throws(() => limits.preflightFile(file, { kind: 'image', format: 'png', width: 100000, height: 100000 }), safetyError);
  assert.throws(() => limits.preflightFile(file, { kind: 'image', format: 'png', width: 4000, height: 4001 }), safetyError);
});

test('page admission accounts for existing pages and rejects invalid counts', () => {
  const { limits } = harness();
  assert.doesNotThrow(() => limits.assertPageCount(200));
  assert.doesNotThrow(() => limits.assertPageCount(1, 199));
  assert.throws(() => limits.assertPageCount(201), safetyError);
  assert.throws(() => limits.assertPageCount(2, 199), safetyError);
  for (const invalid of [-1, NaN, Infinity, 0.5, '200']) {
    assert.throws(() => limits.assertPageCount(invalid), safetyError);
  }
});

test('retained URL allocations share an exact aggregate byte budget', () => {
  const { limits } = harness();
  limits.trackUrl('blob:a', 70 * MiB, 100, 100);
  limits.trackUrl('blob:b', 58 * MiB, 100, 100);
  assert.throws(() => limits.trackUrl('blob:c', 1, 100, 100), safetyError);
  limits.forgetUrl('blob:a');
  assert.doesNotThrow(() => limits.trackUrl('blob:c', 70 * MiB, 100, 100));
  assert.throws(() => limits.trackUrl('blob:d', 1, 100, 100), safetyError);
  limits.forgetUrl('blob:a');
  assert.throws(() => limits.trackUrl('blob:d', 1, 100, 100), safetyError,
    'Repeated release must not create extra capacity');
});

test('duplicate URL references do not count the same encoded allocation twice', () => {
  const { limits } = harness();
  limits.trackUrl('blob:shared', 64 * MiB, 100, 100);
  limits.trackUrl('blob:shared', 64 * MiB, 100, 100);
  assert.doesNotThrow(() => limits.trackUrl('blob:other', 64 * MiB, 100, 100));
  assert.throws(() => limits.trackUrl('blob:last', 1, 1, 1), safetyError);
});

test('URL and original-PDF reservations use the same retained-byte budget', () => {
  const { limits } = harness();
  limits.reserveBytes('pdf:original', 50 * MiB);
  limits.trackUrl('blob:previews', 78 * MiB, 100, 100);
  assert.throws(() => limits.reserveBytes('pdf:second', 1), safetyError);
  limits.releaseBytes('pdf:original');
  assert.doesNotThrow(() => limits.reserveBytes('pdf:second', 50 * MiB));
  assert.throws(() => limits.trackUrl('blob:edit', 1, 1, 1), safetyError);
});

test('a rejected reservation does not poison subsequent admission', () => {
  const { limits } = harness();
  assert.throws(() => limits.reserveBytes('oversized', 128 * MiB + 1), safetyError);
  assert.doesNotThrow(() => limits.reserveBytes('safe', 128 * MiB));
  limits.releaseBytes('oversized');
  assert.throws(() => limits.reserveBytes('still-full', 1), safetyError);
  limits.releaseBytes('safe');
  assert.doesNotThrow(() => limits.trackUrl('blob:whole-budget', 128 * MiB, 100, 100));
});

test('cache admission uses decoded pixel weight rather than only an image count', () => {
  const { limits } = harness(), cache = new Map();
  limits.cacheAdmit(cache, 'a', image(4000, 2000));
  limits.cacheAdmit(cache, 'b', image(4000, 2000));
  assert.deepEqual([...cache.keys()], ['a', 'b']);
  limits.cacheAdmit(cache, 'c', image(1, 1));
  assert.deepEqual([...cache.keys()], ['b', 'c']);
  limits.cacheAdmit(cache, 'large', image(4000, 4000));
  assert.deepEqual([...cache.keys()], ['large']);
});

test('cache also caps tiny entries and treats the same source as one entry', () => {
  const { limits } = harness(), cache = new Map();
  for (const key of ['a', 'b', 'c']) limits.cacheAdmit(cache, key, image(1, 1));
  limits.cacheAdmit(cache, 'c', image(2, 2));
  assert.equal(cache.size, 3);
  limits.cacheAdmit(cache, 'd', image(1, 1));
  assert.equal(cache.size, 3); assert.equal(cache.has('a'), false);
  assert.throws(() => limits.cacheAdmit(cache, 'oversized', image(4001, 4000)), safetyError);
  assert.equal(cache.has('oversized'), false);
});

test('the shared decode scheduler starts only one decode at a time', async () => {
  const { limits } = harness(), pending = deferred(), started = [];
  const first = limits.enqueueDecode(async () => { started.push('first'); await pending.promise; return 1; });
  const second = limits.enqueueDecode(async () => { started.push('second'); return 2; });
  await tick(); assert.deepEqual(started, ['first']);
  pending.resolve(); assert.equal(await first, 1); assert.equal(await second, 2);
  assert.deepEqual(started, ['first', 'second']);
});

test('decode failure releases the scheduler for the next request', async () => {
  const { limits } = harness();
  const first = limits.enqueueDecode(async () => { throw new Error('Decode failed'); });
  const rejection = assert.rejects(first, /Decode failed/);
  const second = limits.enqueueDecode(async () => 42);
  await rejection; assert.equal(await second, 42);
});

test('a queued canceled import is rejected without starting its decode', async () => {
  const { limits } = harness(), pending = deferred();
  let current = true, decoded = false;
  const first = limits.enqueueDecode(() => pending.promise);
  const queued = limits.enqueueDecode(async () => { decoded = true; }, { isCurrent: () => current });
  const rejected = assert.rejects(queued, /cancel/i);
  current = false; pending.resolve(); await first; await rejected;
  assert.equal(decoded, false);
  assert.equal(await limits.enqueueDecode(async () => 'next'), 'next');
});

test('output size is measured against its exact binary byte length', () => {
  const { limits } = harness();
  assert.doesNotThrow(() => limits.assertOutputBytes(128 * MiB));
  assert.throws(() => limits.assertOutputBytes(128 * MiB + 1), safetyError);
  for (const invalid of [-1, NaN, Infinity, '100']) {
    assert.throws(() => limits.assertOutputBytes(invalid), safetyError);
  }
});

test('export admission counts all image pages against the aggregate pixel budget', () => {
  const { limits } = harness();
  const page = () => ({ pixelWidth: 4000, pixelHeight: 4000, rotation: 0 });
  const pages = [page(), page(), page(), page()];
  assert.doesNotThrow(() => limits.assertExport(pages, new Map()));
  assert.throws(() => limits.assertExport([...pages, { pixelWidth: 1, pixelHeight: 1 }], new Map()), safetyError);
  assert.throws(() => limits.assertExport([{ pixelWidth: 4001, pixelHeight: 4000 }], new Map()), safetyError);
});

test('native pages count against page limits without spending a raster export budget', () => {
  const { limits } = harness();
  const nativePage = () => ({ pdfSource: { sourceId: 'pdf', pageIndex: 0 }, pixelWidth: 2400, pixelHeight: 2400 });
  assert.doesNotThrow(() => limits.assertExport(Array.from({ length: 200 }, nativePage), new Map()));
  assert.throws(() => limits.assertExport(Array.from({ length: 201 }, nativePage), new Map()), safetyError);
});

test('native export revalidates each captured original PDF size', () => {
  const { limits } = harness();
  const pages = [{ pdfSource: { sourceId: 'pdf', pageIndex: 0 } }];
  assert.doesNotThrow(() => limits.assertExport(pages, new Map([['pdf', { bytes: { byteLength: 50 * MiB } }]])));
  assert.throws(() => limits.assertExport(pages, new Map([['pdf', { bytes: { byteLength: 50 * MiB + 1 } }]])), safetyError);
});

test('PDF scaled-viewport validation rejects dimensions outside the rendering cap', () => {
  const { limits } = harness();
  assert.doesNotThrow(() => limits.assertPdfViewport({ width: 2400, height: 2400 }));
  for (const width of [0, -1, NaN, Infinity, 2401, '2400']) {
    assert.throws(() => limits.assertPdfViewport({ width, height: 2400 }), safetyError);
  }
});

test('invalid resource byte counts cannot alter retained allocation accounting', () => {
  const { limits } = harness();
  for (const value of [-1, NaN, Infinity, '100', 1.5]) {
    assert.throws(() => limits.reserveBytes('invalid', value), safetyError);
    assert.throws(() => limits.trackUrl('blob:invalid', value, 100, 100), safetyError);
  }
  assert.doesNotThrow(() => limits.reserveBytes('valid', 128 * MiB));
  assert.throws(() => limits.reserveBytes('full', 1), safetyError);
});

test('rotated export bounds count the actual canvas area', () => {
  const { limits } = harness();
  const rotated = () => ({ pixelWidth: 2800, pixelHeight: 2800, rotation: 45 });
  assert.doesNotThrow(() => limits.assertExport(Array.from({ length: 4 }, rotated), new Map()));
  assert.throws(() => limits.assertExport(Array.from({ length: 5 }, rotated), new Map()), safetyError);
  assert.throws(() => limits.assertExport([{ pixelWidth: 4000, pixelHeight: 4000, rotation: 45 }], new Map()), safetyError);
});

test('explicit PDF image export counts native preview rasters against the pixel budget', () => {
  const { limits } = harness();
  const nativePage = () => ({ pdfSource: { sourceId: 'pdf', pageIndex: 0 }, pixelWidth: 2400, pixelHeight: 2400 });
  const pages = Array.from({ length: 12 }, nativePage);
  assert.doesNotThrow(() => limits.assertExport(pages, new Map()));
  assert.throws(() => limits.assertExport(pages, new Map(), { rasterizeNative: true }), safetyError);
});

test('retained source dimensions are used when exporting metadata-only images', () => {
  const { limits } = harness();
  limits.trackUrl('blob:photo', 100, 4000, 4000);
  const pages = Array.from({ length: 5 }, () => ({ src: 'blob:photo', rotation: 0 }));
  assert.throws(() => limits.assertExport(pages, new Map()), safetyError);
  assert.doesNotThrow(() => limits.assertExport(pages.slice(0, 4), new Map()));
});

test('resource metadata has a count cap even for zero-byte allocations', () => {
  const { limits } = harness();
  for (let index = 0; index < 10000; index++) limits.reserveBytes(`empty:${index}`, 0);
  assert.equal(limits.stats().allocations, 10000);
  assert.throws(() => limits.reserveBytes('one-more', 0), safetyError);
  assert.equal(limits.stats().allocations, 10000);
  limits.releaseBytes('empty:0');
  assert.doesNotThrow(() => limits.reserveBytes('replacement', 0));
  assert.equal(limits.stats().allocations, 10000);
});

test('leases defer freeing a pruned original PDF until every consumer releases it', () => {
  const { limits } = harness();
  limits.reserveBytes('pdf:source', 128 * MiB);
  const first = limits.leaseBytes('pdf:source'), second = limits.leaseBytes('pdf:source');
  limits.releaseBytes('pdf:source');
  assert.equal(limits.stats().retainedBytes, 128 * MiB);
  assert.throws(() => limits.reserveBytes('new-import', 1), safetyError);
  first(); first(); assert.equal(limits.stats().retainedBytes, 128 * MiB);
  second(); assert.equal(limits.stats().retainedBytes, 0);
  second(); assert.equal(limits.stats().retainedBytes, 0);
  assert.doesNotThrow(() => limits.reserveBytes('new-import', 128 * MiB));
});

test('leasing an unknown original source cannot fabricate a reservation', () => {
  const { limits } = harness();
  assert.throws(() => limits.leaseBytes('pdf:missing'), /unavailable|import/i);
  assert.equal(limits.stats().retainedBytes, 0); assert.equal(limits.stats().allocations, 0);
});

test('pending downloads have a separate exact aggregate byte budget', () => {
  const { limits } = harness();
  limits.reserveBytes('working-files', 128 * MiB);
  limits.reserveDownload('first', 64 * MiB); limits.reserveDownload('second', 64 * MiB);
  assert.equal(limits.stats().downloadBytes, 128 * MiB);
  assert.equal(limits.stats().retainedBytes, 128 * MiB);
  assert.throws(() => limits.reserveDownload('overflow', 1), /wait|download|30 seconds/i);
  assert.equal(limits.stats().downloads, 2);
  limits.releaseDownload('first'); limits.releaseDownload('first');
  assert.equal(limits.stats().downloadBytes, 64 * MiB);
  assert.doesNotThrow(() => limits.reserveDownload('third', 64 * MiB));
});

test('pending download metadata also has a count cap for tiny files', () => {
  const { limits } = harness();
  for (let index = 0; index < 10; index++) limits.reserveDownload(index, 0);
  assert.throws(() => limits.reserveDownload(10, 0), /wait|download|30 seconds/i);
  assert.equal(limits.stats().downloads, 10); assert.equal(limits.stats().downloadBytes, 0);
  limits.releaseDownload(0);
  assert.doesNotThrow(() => limits.reserveDownload(10, 0));
  assert.equal(limits.stats().downloads, 10);
});

test('a duplicate pending download key cannot corrupt byte accounting', () => {
  const { limits } = harness();
  limits.reserveDownload('one', 10);
  limits.reserveDownload('one', 20);
  assert.equal(limits.stats().downloadBytes, 20); assert.equal(limits.stats().downloads, 1);
  assert.throws(() => limits.reserveDownload('one', 128 * MiB + 1), safetyError);
  assert.equal(limits.stats().downloadBytes, 20); assert.equal(limits.stats().downloads, 1);
  limits.releaseDownload('one'); assert.equal(limits.stats().downloadBytes, 0);
});

test('invalid pending download sizes leave no reservation', () => {
  const { limits } = harness();
  for (const bytes of [-1, NaN, Infinity, 0.5, '100', 128 * MiB + 1]) {
    assert.throws(() => limits.reserveDownload('invalid', bytes), safetyError);
    assert.equal(limits.stats().downloads, 0); assert.equal(limits.stats().downloadBytes, 0);
  }
});
