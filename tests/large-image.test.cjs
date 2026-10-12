const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../js/large-image.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(__dirname, '../js/large-image-worker.js'), 'utf8');
const plan = (extra = {}) => ({ width: 4000, height: 4000, sourceWidth: 12000, sourceHeight: 12000, maxBytes: 32 * 1024 * 1024, ...extra });
const input = new Blob(['source'], { type: 'image/png' });
const output = (size = 100) => new Blob([new Uint8Array(size)], { type: 'image/png' });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function job() {
  const callbacks = new Set(); let current = true;
  return { isCurrent: () => current,
    onCancel(callback) { if (!current) callback(); else callbacks.add(callback); return () => callbacks.delete(callback); },
    cancel() { current = false; [...callbacks].forEach(callback => callback()); callbacks.clear(); },
    get callbackCount() { return callbacks.size; } };
}
function harness(options = {}) {
  const decodes = [], bitmaps = [], canvases = [], draws = [], encodes = [], workers = [];
  const context = vm.createContext({ Promise, Number, Math, Object, Error, URL, Blob,
    document: { currentScript: { src: 'http://localhost/js/large-image.js' } } });
  context.window = context;
  class Canvas {
    constructor(width, height) {
      if (options.allocate && options.allocate(canvases.length, width, height) === false) throw new Error('Memory allocation failed');
      this.width = width; this.height = height; canvases.push(this);
    }
    getContext(kind, settings) {
      this.settings = settings;
      if (options.noContext) return null;
      const ctx = { drawImage(bitmap, ...args) { draws.push({ bitmap, args, context: ctx }); } };
      this.context = ctx; return ctx;
    }
    async convertToBlob(settings) {
      const index = encodes.length; encodes.push({ canvas: this, width: this.width, height: this.height, settings });
      if (options.encode) return options.encode(index, this.width, this.height);
      return output();
    }
  }
  context.OffscreenCanvas = Canvas;
  context.createImageBitmap = async (blob, settings) => {
    const index = decodes.length; decodes.push({ blob, settings });
    if (options.decode) {
      const value = await options.decode(index, settings);
      if (value) { bitmaps.push(value); return value; }
    }
    const ratio = options.ratio || 1;
    const bitmap = { width: settings.resizeWidth || Math.ceil(settings.resizeHeight / ratio),
      height: settings.resizeHeight || Math.ceil(settings.resizeWidth * ratio), closes: 0,
      close() { this.closes++; } };
    bitmaps.push(bitmap); return bitmap;
  };
  if (options.noBitmap) delete context.createImageBitmap;
  if (options.domCanvas) {
    delete context.OffscreenCanvas;
    context.document.createElement = name => {
      assert.equal(name, 'canvas');
      const canvas = new Canvas(0, 0);
      canvas.convertToBlob = undefined;
      canvas.toBlob = (callback, type) => { encodes.push({ width: canvas.width, height: canvas.height, settings: { type } }); callback(output()); };
      return canvas;
    };
  }
  if (options.worker) {
    context.Worker = class {
      constructor(url) { this.url = url; this.terminated = 0; workers.push(this); if (options.constructError) throw new Error('CSP blocked'); }
      postMessage(data) { this.message = data; if (options.postError) throw new Error('Clone failed'); }
      terminate() { this.terminated++; }
    };
  }
  if (options.workerContext) {
    delete context.window; delete context.document; context.self = context;
    context.importScripts = name => { assert.equal(name, 'large-image.js'); vm.runInContext(source, context); };
    context.postMessage = value => { workers.push(value); };
    vm.runInContext(workerSource, context);
  } else vm.runInContext(source, context);
  return { context, api: context.PhotoPdfLargeImages, decodes, bitmaps, canvases, draws, encodes, workers };
}
function cleaned(h) {
  assert.ok(h.bitmaps.every(bitmap => bitmap.closes === 1), 'Every decoded bitmap closes exactly once');
  assert.ok(h.canvases.every(canvas => canvas.width === 0 && canvas.height === 0), 'Every canvas is zeroed');
}

test('normalization requests one high-quality oriented resize axis, preserves PNG alpha, and releases resources', async () => {
  const h = harness(), active = job();
  const result = await h.api.normalize(input, plan(), active);
  assert.deepEqual({ width: result.width, height: result.height }, { width: 4000, height: 4000 });
  assert.equal(result.blob.type, 'image/png');
  const settings = h.decodes[0].settings;
  assert.equal(settings.resizeWidth, 4000); assert.equal(settings.resizeHeight, undefined);
  assert.equal(settings.resizeQuality, 'high'); assert.equal(settings.imageOrientation, 'from-image');
  assert.equal(h.canvases[0].settings.alpha, true);
  assert.equal(h.draws[0].context.imageSmoothingQuality, 'high');
  assert.equal(h.draws[0].context.imageSmoothingEnabled, true);
  assert.equal(h.encodes[0].settings.type, 'image/png');
  assert.equal(active.callbackCount, 0); cleaned(h);
});

test('oversized encoded PNG shrinks by byte ratio while every pass samples the initial bounded bitmap', async () => {
  const h = harness({ encode: index => output(index === 0 ? 4000 : 900) });
  const result = await h.api.normalize(input, plan({ width: 1000, height: 1000, maxBytes: 1000 }));
  assert.equal(result.width, 480); assert.equal(result.height, 480); assert.ok(result.blob.size <= 1000);
  assert.equal(h.decodes.length, 1); assert.equal(h.draws.length, 2);
  assert.ok(h.draws.every(draw => draw.bitmap === h.bitmaps[0])); cleaned(h);
});

test('decoder allocation failures retry smaller requests instead of a full-source decode', async () => {
  const h = harness({ decode: index => { if (index < 2) throw new Error('Decoder memory failure'); } });
  const result = await h.api.normalize(input, plan());
  assert.equal(result.width, 2250);
  assert.deepEqual(h.decodes.map(item => item.settings.resizeWidth), [4000, 3000, 2250]);
  assert.ok(h.decodes.every(item => item.settings.resizeWidth && item.settings.resizeHeight === undefined)); cleaned(h);
});

test('decoder fails after bounded retries and never creates a canvas or full-size Image fallback', async () => {
  const h = harness({ decode: () => { throw new Error('Decode failure'); } });
  await assert.rejects(h.api.normalize(input, plan()), { name: 'ImageDecodeError' });
  assert.deepEqual(h.decodes.map(item => item.settings.resizeWidth), [4000, 3000, 2250, 1687]);
  assert.equal(h.canvases.length, 0); cleaned(h);
});

test('unknown rotated orientation is corrected from the decoder ratio without stretching', async () => {
  const h = harness({ ratio: 2 });
  const result = await h.api.normalize(input, plan({ width: 5656, height: 2828, sourceWidth: 12000, sourceHeight: 6000 }));
  assert.equal(h.decodes.length, 1);
  assert.ok(result.width < result.height); assert.equal(result.height, result.width * 2);
  assert.ok(result.width * result.height <= 5656 * 2828);
  assert.equal(result.sourceWidth, 6000); assert.equal(result.sourceHeight, 12000);
  assert.ok(h.canvases.every(canvas => canvas.settings.alpha)); cleaned(h);
});

test('a landscape probe fits either orientation and then recovers maximum planned resolution', async () => {
  const h = harness({ ratio: 0.5 });
  const result = await h.api.normalize(input, plan({ width: 5656, height: 2828, sourceWidth: 12000, sourceHeight: 6000 }));
  assert.deepEqual(h.decodes.map(item => item.settings.resizeWidth), [2828, 5656]);
  const probe = h.decodes[0].settings.resizeWidth;
  assert.ok(probe * Math.ceil(probe * 2) <= 5656 * 2828);
  assert.equal(result.width, 5656); assert.equal(result.height, 2828);
  assert.equal(result.sourceWidth, 12000); assert.equal(result.sourceHeight, 6000); cleaned(h);
});

test('a failed full-resolution decode stays reduced after the successful orientation probe', async () => {
  const h = harness({ ratio: 0.5, decode: index => { if (index === 1) throw new Error('Target memory failure'); } });
  const result = await h.api.normalize(input, plan({ width: 5656, height: 2828, sourceWidth: 12000, sourceHeight: 6000 }));
  assert.deepEqual(h.decodes.map(item => item.settings.resizeWidth), [2828, 5656, 4242]);
  assert.equal(result.width, 4242); assert.equal(result.height, 2121); cleaned(h);
});

test('unexpected landscape orientation recovers available resolution instead of retaining a tiny portrait width', async () => {
  const h = harness({ ratio: 0.25 });
  const result = await h.api.normalize(input, plan({ width: 2000, height: 8000, sourceWidth: 3000, sourceHeight: 12000 }));
  assert.equal(result.width, 8000); assert.equal(result.height, 2000);
  assert.deepEqual(h.decodes.map(item => item.settings.resizeWidth), [2000, 8000]); cleaned(h);
});

test('decoder ceil rounding cannot admit a raster over the pixel budget', async () => {
  const h = harness({ ratio: 1.00025 });
  const result = await h.api.normalize(input, plan());
  assert.ok(result.width * result.height <= 16000000);
  assert.ok(h.draws.every(draw => draw.args[2] * draw.args[3] <= 16000000)); cleaned(h);
});

test('extremely thin image ratios account for a rounded-up row before requesting the full decode', async () => {
  const ratio = 11 / 80000, h = harness({ ratio });
  const result = await h.api.normalize(input, plan({ width: 8192, height: 1, sourceWidth: 80000, sourceHeight: 11 }));
  assert.ok(result.width * result.height <= 8192);
  assert.equal(result.height, 1); assert.ok(result.width <= Math.floor(1 / ratio));
  assert.ok(h.decodes.every(item => item.settings.resizeWidth * Math.ceil(item.settings.resizeWidth * ratio) <= 8192));
  cleaned(h);
});

for (const example of [
  { name: 'verified thin portrait', sourceWidth: 1, sourceHeight: 65535, width: 1, height: 8192, ratio: 65535, finalWidth: 1, finalHeight: 8192 },
  { name: 'verified thin landscape', sourceWidth: 65535, sourceHeight: 1, width: 8192, height: 1, ratio: 1 / 65535, finalWidth: 8192, finalHeight: 1 },
  { name: 'unknown orientation flipping thin landscape into portrait', sourceWidth: 65535, sourceHeight: 1, width: 8192, height: 1, ratio: 65535, finalWidth: 1, finalHeight: 8192 },
  { name: 'unknown orientation flipping thin portrait into landscape', sourceWidth: 1, sourceHeight: 65535, width: 1, height: 8192, ratio: 1 / 65535, finalWidth: 8192, finalHeight: 1 }
]) {
  test(`${example.name} is fitted on its long axis without drawing the oversized probe`, async () => {
    let h;
    h = harness({ ratio: example.ratio, decode: index => { if (index) assert.equal(h.bitmaps[index - 1].closes, 1); } });
    const result = await h.api.normalize(input, plan(example));
    assert.equal(result.width, example.finalWidth); assert.equal(result.height, example.finalHeight);
    assert.equal(result.sourceWidth, example.finalWidth === 1 ? 1 : 65535);
    assert.equal(result.sourceHeight, example.finalHeight === 1 ? 1 : 65535);
    assert.equal(h.decodes.length, 2);
    assert.ok(h.decodes.every(item => Boolean(item.settings.resizeWidth) !== Boolean(item.settings.resizeHeight)));
    assert.ok(h.draws.every(draw => draw.args[2] <= 8192 && draw.args[3] <= 8192 && draw.args[2] * draw.args[3] <= 8192));
    if (example.finalHeight > 1) {
      assert.equal(h.decodes[0].settings.resizeWidth, 1);
      assert.equal(h.decodes[1].settings.resizeHeight, 8192);
      assert.notEqual(h.draws[0].bitmap, h.bitmaps[0]);
    }
    cleaned(h);
  });
}

test('an allocation failure after switching to the tall-image axis remains at a smaller height', async () => {
  const h = harness({ ratio: 65535, decode: index => { if (index === 1) throw new Error('Height decode memory failure'); } });
  const result = await h.api.normalize(input, plan({ width: 1, height: 8192, sourceWidth: 1, sourceHeight: 65535 }));
  assert.deepEqual(h.decodes.map(item => item.settings.resizeWidth || item.settings.resizeHeight), [1, 8192, 6144]);
  assert.equal(result.width, 1); assert.equal(result.height, 6144); cleaned(h);
});

test('canceling the tall-image re-decode closes both the probe and the eventual result', async () => {
  const started = deferred(), gate = deferred(), active = job();
  const h = harness({ ratio: 65535, decode: index => { if (index === 1) { started.resolve(); return gate.promise; } } });
  const pending = h.api.normalize(input, plan({ width: 1, height: 8192, sourceWidth: 1, sourceHeight: 65535 }), active);
  await started.promise; active.cancel(); await assert.rejects(pending, { name: 'ImportCanceledError' });
  const bitmap = { width: 1, height: 8192, closes: 0, close() { this.closes++; } };
  gate.resolve(bitmap); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.draws.length, 0); cleaned(h);
});

test('a decoder that ignores resize options has every bitmap closed and is never drawn', async () => {
  const h = harness({ decode: () => ({ width: 12000, height: 12000, closes: 0, close() { this.closes++; } }) });
  await assert.rejects(h.api.normalize(input, plan()), { name: 'ImageDecodeError' });
  assert.equal(h.draws.length, 0); assert.equal(h.bitmaps.length, 4); cleaned(h);
});

test('canvas allocation failure retries smaller canvas from the same bitmap', async () => {
  let allocations = 0;
  const h = harness({ allocate: () => ++allocations > 1 });
  const result = await h.api.normalize(input, plan());
  assert.equal(result.width, 3000); assert.equal(h.decodes.length, 1); cleaned(h);
});

test('canvas encoding failures are bounded and all canvases and bitmaps release', async () => {
  const h = harness({ encode: () => { throw new Error('Canvas encode failed'); } });
  await assert.rejects(h.api.normalize(input, plan()), /working-file budget/);
  assert.equal(h.encodes.length, 6); cleaned(h);
});

test('an encoder that returns another MIME type cannot lose transparency silently', async () => {
  const h = harness({ encode: () => new Blob(['jpeg'], { type: 'image/jpeg' }) });
  await assert.rejects(h.api.normalize(input, plan()), /working-file budget/);
  assert.equal(h.encodes.length, 6); cleaned(h);
});

test('an encoded file too large even at one pixel reports failure without endless retries', async () => {
  const h = harness({ encode: () => output(20) });
  await assert.rejects(h.api.normalize(input, plan({ width: 1, height: 1, maxBytes: 1 })), /working-file budget/);
  assert.equal(h.encodes.length, 1); cleaned(h);
});

test('canceling pending decode rejects promptly and closes the bitmap when the browser later completes', async () => {
  const gate = deferred(), h = harness({ decode: () => gate.promise }), active = job();
  const pending = h.api.normalize(input, plan(), active);
  active.cancel(); await assert.rejects(pending, { name: 'ImportCanceledError' });
  const bitmap = { width: 4000, height: 4000, closes: 0, close() { this.closes++; } };
  gate.resolve(bitmap); await new Promise(resolve => setImmediate(resolve));
  assert.equal(bitmap.closes, 1); assert.equal(h.draws.length, 0); assert.equal(active.callbackCount, 0);
});

test('canceling pending encoding rejects promptly and releases canvas and bitmap', async () => {
  const started = deferred(), gate = deferred(), active = job();
  const h = harness({ encode: () => { started.resolve(); return gate.promise; } });
  const pending = h.api.normalize(input, plan(), active);
  await started.promise; active.cancel(); await assert.rejects(pending, { name: 'ImportCanceledError' });
  cleaned(h); gate.resolve(output()); await new Promise(resolve => setImmediate(resolve)); cleaned(h);
});

test('the DOM canvas fallback preserves alpha and zeroes canvas dimensions', async () => {
  const h = harness({ domCanvas: true });
  const result = await h.api.normalize(input, plan());
  assert.equal(result.blob.type, 'image/png'); assert.equal(h.canvases[0].settings.alpha, true); cleaned(h);
});

test('without a bounded bitmap decoder, large-image normalization refuses a full-source fallback', async () => {
  const h = harness({ noBitmap: true });
  await assert.rejects(h.api.normalize(input, plan()), { name: 'NotSupportedError' });
  assert.equal(h.canvases.length, 0);
});

test('worker success returns its PNG, resolves its sibling script URL, and terminates', async () => {
  const h = harness({ worker: true }), active = job();
  const pending = h.api.normalize(input, plan(), active), worker = h.workers[0];
  assert.equal(worker.url, 'http://localhost/js/large-image-worker.js');
  assert.equal(worker.message.blob, input);
  worker.onmessage({ data: { ok: true, result: { blob: output(), width: 4000, height: 4000 } } });
  assert.equal((await pending).width, 4000); assert.equal(worker.terminated, 1);
  assert.equal(active.callbackCount, 0); assert.equal(h.decodes.length, 0);
});

test('canceling a worker terminates it immediately and never starts main-thread decoding', async () => {
  const h = harness({ worker: true }), active = job();
  const pending = h.api.normalize(input, plan(), active), worker = h.workers[0];
  active.cancel(); await assert.rejects(pending, { name: 'ImportCanceledError' });
  assert.equal(worker.terminated, 1); assert.equal(worker.onmessage, null); assert.equal(h.decodes.length, 0);
});

test('worker reports decode failures without trying another full-source decode on the main thread', async () => {
  const h = harness({ worker: true });
  const pending = h.api.normalize(input, plan()), worker = h.workers[0];
  worker.onmessage({ data: { ok: false, name: 'ImageDecodeError', message: 'Broken image' } });
  await assert.rejects(pending, { name: 'ImageDecodeError' });
  assert.equal(worker.terminated, 1); assert.equal(h.decodes.length, 0);
});

test('worker loading failure falls back to a bounded main-thread resize after terminating the worker', async () => {
  const h = harness({ worker: true });
  const pending = h.api.normalize(input, plan()), worker = h.workers[0];
  let prevented = false; worker.onerror({ preventDefault() { prevented = true; } });
  const result = await pending;
  assert.ok(prevented); assert.equal(worker.terminated, 1); assert.equal(result.width, 4000);
  assert.equal(h.decodes[0].settings.resizeWidth, 4000); cleaned(h);
});

test('invalid worker output is rejected and worker resources are terminated', async () => {
  const h = harness({ worker: true });
  const pending = h.api.normalize(input, plan()), worker = h.workers[0];
  worker.onmessage({ data: { ok: true, result: { blob: output(), width: 10000, height: 10000 } } });
  await assert.rejects(pending, /invalid working image/); assert.equal(worker.terminated, 1);
});

test('worker can return a corrected orientation within the plan pixel budget', async () => {
  const h = harness({ worker: true });
  const pending = h.api.normalize(input, plan({ width: 8000, height: 2000 })), worker = h.workers[0];
  worker.onmessage({ data: { ok: true, result: { blob: output(), width: 2000, height: 8000 } } });
  assert.equal((await pending).height, 8000); assert.equal(worker.terminated, 1);
});

test('dedicated worker executes the shared safe core and posts a PNG result', async () => {
  const h = harness({ workerContext: true });
  await h.context.onmessage({ data: { blob: input, plan: plan() } });
  assert.equal(h.workers[0].ok, true); assert.equal(h.workers[0].result.blob.type, 'image/png');
  assert.equal(h.decodes[0].settings.resizeHeight, undefined); cleaned(h);
});

test('dedicated worker forwards a meaningful decode error', async () => {
  const h = harness({ workerContext: true, noBitmap: true });
  await h.context.onmessage({ data: { blob: input, plan: plan() } });
  assert.equal(h.workers[0].ok, false); assert.equal(h.workers[0].name, 'NotSupportedError');
});

test('invalid plans fail before creating decoder, canvas, or worker resources', async () => {
  const h = harness({ worker: true });
  for (const invalid of [{ width: 8193 }, { height: 8193 }, { width: 4001, height: 4000 }, { maxBytes: 33554433 },
    { maxBytes: 0 }, { width: 1.2 }, { sourceWidth: 3000 }, { sourceHeight: 3000 }]) {
    await assert.rejects(h.api.normalize(input, plan(invalid)), { name: 'ResourceLimitError' });
  }
  assert.equal(h.decodes.length, 0); assert.equal(h.canvases.length, 0); assert.equal(h.workers.length, 0);
});
