const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../js/pdf-preserve.js'), 'utf8');
const bundledModules = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
let PDFLib = null;
let libraryBundle = null;
try {
  PDFLib = require('pdf-lib');
  libraryBundle = fs.readFileSync(path.join(path.dirname(require.resolve('pdf-lib/package.json')), 'dist/pdf-lib.min.js'), 'utf8');
} catch {
  try {
    PDFLib = require(path.join(bundledModules, 'pdf-lib'));
    libraryBundle = fs.readFileSync(path.join(bundledModules, 'pdf-lib/dist/pdf-lib.min.js'), 'utf8');
  } catch {}
}
const needsLibrary = { skip: PDFLib ? false : 'Install pdf-lib@1.17.1 to run real PDF regressions.' };

function harness(options = {}) {
  const imports = [];
  const context = vm.createContext({ window: {}, Uint8Array, ArrayBuffer, setTimeout, clearTimeout, URL,
    document: { currentScript: { src: 'https://example.test/personal-tools/photo-pdf/js/pdf-preserve.js' } } });
  // Execute the real bundled library in the application's realm, just as a
  // browser import does. pdf-lib validates arrays using instanceof Array.
  if (libraryBundle && !options.library) vm.runInContext(libraryBundle, context);
  const library = options.library || context.PDFLib;
  let module;
  let failedOnce = false;
  new vm.Script(source, {
    importModuleDynamically: async url => {
      imports.push(url);
      if (options.failOnce && !failedOnce) { failedOnce = true; throw new Error('Offline'); }
      if (options.importFailure) throw new Error('Offline');
      if (options.gate) await options.gate;
      if (!module) {
        const keys = Object.keys(library || {});
        module = new vm.SyntheticModule(keys, function () {
          for (const key of keys) this.setExport(key, library[key]);
        }, { context });
      }
      if (module.status === 'unlinked') await module.link(() => {});
      if (module.status !== 'evaluated') await module.evaluate();
      return module;
    }
  }).runInContext(context);
  return { api: context.window.PhotoPdfPreservation, imports };
}

function native(sourceId, pageIndex, overrides = {}) {
  return { name: `Page ${pageIndex + 1}`, src: 'blob:preview', rotation: 0, flipH: false, flipV: false,
    filters: {}, pdfSource: { sourceId, pageIndex }, ...overrides };
}
function optionsFor(records, overrides = {}) {
  return { getSource: id => records[id], ...overrides };
}
const placeholder = { bytes: Uint8Array.from(Buffer.from('%PDF-source-with-signed-and-encrypted-objects')), name: 'private.pdf', numPages: 3 };

test('the native exporter loads no dependency at startup', () => {
  const h = harness();
  assert.equal(h.imports.length, 0);
  assert.equal(h.api.pdfLibVersion, '1.17.1');
  assert.equal(Object.isFrozen(h.api), true);
});

test('an untouched whole PDF returns an isolated exact byte copy without reading previews', async () => {
  const h = harness({ importFailure: true });
  const result = await h.api.prepareStructurePreservingPdf([native('a', 0), native('a', 1), native('a', 2)],
    optionsFor({ a: placeholder }, { prepareImage() { throw new Error('Never rasterize'); } }));
  assert.deepEqual(Array.from(result.bytes), Array.from(placeholder.bytes));
  assert.notEqual(result.bytes, placeholder.bytes);
  assert.equal(result.exactOriginal, true);
  assert.equal(result.nativePages, 3);
  assert.equal(result.imagePages, 0);
  assert.equal(h.imports.length, 0);
  assert.match(result.notice, /signatures and encryption/);
});

test('source bytes and page metadata are captured before progress callbacks can mutate them', async () => {
  const h = harness();
  const record = { ...placeholder, bytes: new Uint8Array(placeholder.bytes) };
  const queue = [native('a', 0), native('a', 1), native('a', 2)];
  const result = await h.api.prepareStructurePreservingPdf(queue, optionsFor({ a: record }, {
    onProgress() { record.bytes.fill(0); queue[0].pdfSource.pageIndex = 2; queue.splice(1); }
  }));
  assert.deepEqual(Array.from(result.bytes), Array.from(placeholder.bytes));
  assert.equal(result.exactOriginal, true);
});

test('whole turns do not change original native PDF page orientation', async () => {
  const h = harness();
  const result = await h.api.prepareStructurePreservingPdf([
    native('a', 0, { rotation: 360 }), native('a', 1, { rotation: -360 }), native('a', 2)
  ], optionsFor({ a: placeholder }));
  assert.equal(result.exactOriginal, true);
});

for (const [label, image, records] of [
  ['missing source', native('a', 0), {}],
  ['negative page', native('a', -1), { a: placeholder }],
  ['fractional page', native('a', 0.5), { a: placeholder }],
  ['missing page', native('a', 3), { a: placeholder }],
  ['non-native rotation', native('a', 0, { rotation: 10 }), { a: placeholder }],
  ['flip', native('a', 0, { flipH: true }), { a: placeholder }],
  ['unsaved filter', native('a', 0, { filters: { contrast: 120 } }), { a: placeholder }]
]) {
  test(`${label} cannot silently rasterize a page in native mode`, async () => {
    const h = harness(); let rasterized = false;
    await assert.rejects(h.api.prepareStructurePreservingPdf([image], optionsFor(records, {
      prepareImage() { rasterized = true; }
    })), error => error.name === 'PdfPreservationError');
    assert.equal(rasterized, false);
  });
}

test('empty documents are rejected before loading a library', async () => {
  const h = harness();
  await assert.rejects(h.api.prepareStructurePreservingPdf([], {}), /Add at least one page/);
  assert.equal(h.imports.length, 0);
});

test('dependency failure is actionable and supports a later retry', needsLibrary, async () => {
  const h = harness({ failOnce: true });
  const record = await fixture();
  await assert.rejects(h.api.prepareStructurePreservingPdf([native('a', 0)], optionsFor({ a: record })),
    /complete app folder was uploaded/);
  const result = await h.api.prepareStructurePreservingPdf([native('a', 0)], optionsFor({ a: record }));
  assert.equal(result.exactOriginal, false);
  assert.equal(h.imports.length, 2);
  assert.ok(h.imports.every(url => url === 'https://example.test/personal-tools/photo-pdf/vendor/pdf-lib/pdf-lib.esm.min.mjs'));
});

let fixturePromise;
async function fixture() {
  if (!fixturePromise) fixturePromise = (async () => {
    const pdf = await PDFLib.PDFDocument.create();
    pdf.setTitle('Native content fixture');
    pdf.setAuthor('Photo to PDF regression tests');
    pdf.setLanguage('en-US');
    const sizes = [[320, 480], [612, 792], [792, 612]];
    const pages = sizes.map((size, index) => {
      const page = pdf.addPage(size);
      page.drawText(`Native text page ${index + 1}`, { x: 24, y: size[1] - 90, size: 16 });
      page.drawRectangle({ x: 24, y: 60, width: 70, height: 40, color: PDFLib.rgb(0.1, 0.6, 0.9) });
      return page;
    });
    pages[1].setCropBox(20, 30, 500, 700);
    pages[2].setRotation(PDFLib.degrees(90));
    const annotation = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [24, 400, 240, 440],
      Border: [0, 0, 0], A: { S: 'URI', URI: PDFLib.PDFString.of('https://example.com/native-page') } });
    const annotationRef = pdf.context.register(annotation);
    pages[0].node.addAnnot(annotationRef);
    pages[0].node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link',
      Rect: [24, 300, 240, 340], Border: [0, 0, 0], Dest: [pages[2].ref, PDFLib.PDFName.of('Fit')] })));
    const form = pdf.getForm();
    const field = form.createTextField('personal.name');
    field.setText('Alice');
    field.addToPage(pages[0], { x: 24, y: 160, width: 170, height: 25 });
    const outlines = pdf.context.obj({ Type: 'Outlines', Count: 1 });
    const outlinesRef = pdf.context.register(outlines);
    const item = pdf.context.obj({ Title: PDFLib.PDFString.of('First native page'), Parent: outlinesRef,
      Dest: [pages[0].ref, PDFLib.PDFName.of('Fit')] });
    const itemRef = pdf.context.register(item);
    outlines.set(PDFLib.PDFName.of('First'), itemRef);
    outlines.set(PDFLib.PDFName.of('Last'), itemRef);
    pdf.catalog.set(PDFLib.PDFName.of('Outlines'), outlinesRef);
    pdf.catalog.set(PDFLib.PDFName.of('StructTreeRoot'), pdf.context.register(pdf.context.obj({ Type: 'StructTreeRoot', K: [] })));
    return { bytes: await pdf.save(), name: 'native.pdf', numPages: 3 };
  })();
  return fixturePromise;
}

async function readWithIndependentParser(bytes) {
  const entry = path.join(bundledModules, 'pdfjs-dist/legacy/build/pdf.mjs');
  if (!fs.existsSync(entry)) return null;
  const pdfjs = await import(pathToFileURL(entry).href);
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true });
  const pdf = await task.promise;
  try {
    const texts = [], annotations = [], sizes = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      texts.push((await page.getTextContent()).items.map(item => item.str).join(' '));
      annotations.push(await page.getAnnotations());
      const viewport = page.getViewport({ scale: 1 });
      sizes.push([viewport.width, viewport.height]);
      page.cleanup();
    }
    return { texts, annotations, sizes };
  } finally { await pdf.destroy(); }
}

function contentBytes(document, page) {
  const contents = page.node.Contents();
  const references = contents instanceof PDFLib.PDFArray ? contents.asArray() : [contents];
  return Buffer.concat(references.map(ref => Buffer.from(PDFLib.decodePDFRawStream(document.context.lookup(ref)).decode())));
}

test('a real original PDF retains every byte, including form and catalog data', needsLibrary, async () => {
  const record = await fixture(); const h = harness();
  const result = await h.api.prepareStructurePreservingPdf([native('a', 0), native('a', 1), native('a', 2)], optionsFor({ a: record }));
  assert.deepEqual(result.bytes, record.bytes);
  const document = await PDFLib.PDFDocument.load(result.bytes);
  assert.equal(document.getForm().getTextField('personal.name').getText(), 'Alice');
  for (const key of ['Outlines', 'StructTreeRoot', 'Lang']) assert.ok(document.catalog.has(PDFLib.PDFName.of(key)));
});

test('reordering, deleting and rotating native PDF pages keeps text, vectors and external links', needsLibrary, async () => {
  const record = await fixture(); const h = harness();
  const result = await h.api.prepareStructurePreservingPdf([native('a', 2, { rotation: 90 }), native('a', 0)], optionsFor({ a: record }));
  const document = await PDFLib.PDFDocument.load(result.bytes);
  assert.equal(document.getPageCount(), 2);
  assert.equal(document.getPage(0).getRotation().angle, 180);
  assert.deepEqual(document.getPage(0).getSize(), { width: 792, height: 612 });
  assert.equal(document.getTitle(), 'Native content fixture');
  assert.equal(document.getForm().getTextField('personal.name').getText(), 'Alice');
  assert.ok(document.catalog.has(PDFLib.PDFName.of('Outlines')));
  assert.ok(document.catalog.has(PDFLib.PDFName.of('StructTreeRoot')));
  const parsed = await readWithIndependentParser(result.bytes);
  if (parsed) {
    assert.match(parsed.texts[0], /Native text page 3/);
    assert.match(parsed.texts[1], /Native text page 1/);
    assert.ok(parsed.annotations[1].some(annotation => annotation.url === 'https://example.com/native-page'));
  }
  const contents = document.getPage(0).node.Contents();
  assert.ok(contents, 'original content stream is retained');
  const original = await PDFLib.PDFDocument.load(record.bytes);
  assert.deepEqual(contentBytes(document, document.getPage(0)), contentBytes(original, original.getPage(2)),
    'text and vector drawing operators are retained exactly rather than rendered into an image');
  assert.match(result.notice, /signatures/);
  assert.match(result.notice, /may no longer work/);
});

test('duplicated native pages get independent page refs and independent rotations', needsLibrary, async () => {
  const record = await fixture(); const h = harness();
  const result = await h.api.prepareStructurePreservingPdf([
    native('a', 0), native('a', 0, { rotation: 90 }), native('a', 0, { rotation: 180 })
  ], optionsFor({ a: record }));
  const document = await PDFLib.PDFDocument.load(result.bytes);
  assert.equal(new Set(document.getPages().map(page => page.ref.toString())).size, 3);
  assert.deepEqual(document.getPages().map(page => page.getRotation().angle), [0, 90, 180]);
  const parsed = await readWithIndependentParser(result.bytes);
  if (parsed) assert.ok(parsed.texts.every(text => /Native text page 1/.test(text)));
});

test('same-document internal page-ref links follow surviving pages after a reorder', needsLibrary, async () => {
  const record = await fixture();
  const result = await harness().api.prepareStructurePreservingPdf([native('a', 2), native('a', 0)], optionsFor({ a: record }));
  const document = await PDFLib.PDFDocument.load(result.bytes);
  const annotations = document.getPage(1).node.Annots();
  const destinations = annotations.asArray().map(ref => document.context.lookup(ref))
    .filter(annotation => annotation.has(PDFLib.PDFName.of('Dest')))
    .map(annotation => annotation.lookup(PDFLib.PDFName.of('Dest'), PDFLib.PDFArray));
  assert.equal(destinations.length, 1);
  assert.equal(destinations[0].get(0).toString(), document.getPage(0).ref.toString());
});

test('deleting a link or bookmark target exposes a remaining advanced-feature limitation', needsLibrary, async () => {
  const record = await fixture();
  const result = await harness().api.prepareStructurePreservingPdf([native('a', 0)], optionsFor({ a: record }));
  const document = await PDFLib.PDFDocument.load(result.bytes);
  const pageRefs = new Set(document.getPages().map(page => page.ref.toString()));
  const annotations = document.getPage(0).node.Annots();
  const destination = annotations.asArray().map(ref => document.context.lookup(ref))
    .find(annotation => annotation.has(PDFLib.PDFName.of('Dest')))
    .lookup(PDFLib.PDFName.of('Dest'), PDFLib.PDFArray);
  assert.equal(pageRefs.has(destination.get(0).toString()), false,
    'a deleted target is no longer a rendered page; this export cannot claim full link preservation');
  assert.match(result.notice, /internal links.*may no longer work/s);
});

test('inherited resources and boxes are materialized before pages move to a new parent', needsLibrary, async () => {
  const pdf = await PDFLib.PDFDocument.create();
  const page = pdf.addPage([321, 456]);
  page.drawText('Inherited native text', { x: 20, y: 400 });
  const parent = page.node.Parent();
  for (const key of ['Resources', 'MediaBox']) {
    const name = PDFLib.PDFName.of(key);
    parent.set(name, page.node.get(name)); page.node.delete(name);
  }
  parent.set(PDFLib.PDFName.of('Rotate'), PDFLib.PDFNumber.of(90));
  const record = { bytes: await pdf.save(), name: 'inherited.pdf', numPages: 1 };
  const result = await harness().api.prepareStructurePreservingPdf([native('a', 0, { rotation: 90 })], optionsFor({ a: record }));
  const document = await PDFLib.PDFDocument.load(result.bytes);
  assert.deepEqual(document.getPage(0).getSize(), { width: 321, height: 456 });
  assert.equal(document.getPage(0).getRotation().angle, 180);
  assert.ok(document.getPage(0).node.get(PDFLib.PDFName.of('Resources')));
  const parsed = await readWithIndependentParser(result.bytes);
  if (parsed) assert.match(parsed.texts[0], /Inherited native text/);
});

test('mixed PDFs and photos retain native page text while laying out only the photo', needsLibrary, async () => {
  const record = await fixture(); const h = harness(); const prepared = [], layouts = [];
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZB+UAAAAASUVORK5CYII=';
  const result = await h.api.prepareStructurePreservingPdf([
    native('a', 1), { name: 'photo.png', src: 'blob:photo', filters: {} }, native('b', 0)
  ], optionsFor({ a: record, b: record }, {
    imageOptions: { preserveQuality: true }, settings: { pageSize: 'a4', margin: 10 },
    async prepareImage(image, settings) { prepared.push({ image, settings }); return { data: pixel, format: 'PNG', w: 1, h: 1 }; },
    computeLayout(image, rendered, settings) {
      layouts.push({ image, rendered, settings });
      return { page: { width: 210, height: 297 }, image: { x: 10, y: 20, width: 190, height: 257 },
        clip: { x: 10, y: 10, width: 190, height: 277 }, scaledDown: true, cropped: true };
    }
  }));
  const document = await PDFLib.PDFDocument.load(result.bytes);
  assert.equal(document.getPageCount(), 3);
  assert.deepEqual(document.getPage(0).getCropBox(), { x: 20, y: 30, width: 500, height: 700 });
  assert.ok(Math.abs(document.getPage(1).getWidth() - 210 * 72 / 25.4) < 1e-9);
  assert.equal(prepared.length, 1); assert.equal(layouts.length, 1);
  assert.equal(prepared[0].settings.preserveQuality, true);
  assert.equal(result.nativePages, 2); assert.equal(result.imagePages, 1);
  assert.equal(result.scaledDownPages, 1); assert.equal(result.croppedPages, 1);
  assert.equal(document.catalog.has(PDFLib.PDFName.of('AcroForm')), false);
  assert.match(result.notice, /does not preserve document-level forms/);
  const photoOperators = contentBytes(document, document.getPage(1)).toString('latin1');
  assert.match(photoOperators, /re\nW\nn\n/);
  assert.match(photoOperators, /Do\nQ\nQ\n/, 'drawing and clip graphics states are both restored');
  const parsed = await readWithIndependentParser(result.bytes);
  if (parsed) {
    assert.match(parsed.texts[0], /Native text page 2/);
    assert.match(parsed.texts[2], /Native text page 1/);
  }
});

test('a modified encrypted source is rejected without ignoreEncryption or image fallback', needsLibrary, async () => {
  const pdf = await PDFLib.PDFDocument.create(); pdf.addPage([100, 200]);
  pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: 'Standard', V: 1, R: 2 }));
  const record = { bytes: await pdf.save(), name: 'encrypted.pdf', numPages: 1 };
  let rasterized = false;
  await assert.rejects(harness().api.prepareStructurePreservingPdf([native('a', 0, { rotation: 90 })], optionsFor({ a: record }, {
    prepareImage() { rasterized = true; }
  })), error => error.name === 'PdfPreservationError' && /encrypted.*Choose Images/s.test(error.message));
  assert.equal(rasterized, false);
});

test('a corrupt native PDF never silently exports its raster preview', needsLibrary, async () => {
  await assert.rejects(harness().api.prepareStructurePreservingPdf([native('a', 0)], optionsFor({ a: placeholder })),
    /Could not preserve native content/);
});

test('a source count mismatch is rejected before exporting a different document', needsLibrary, async () => {
  const record = await fixture();
  await assert.rejects(harness().api.prepareStructurePreservingPdf([native('a', 0)], optionsFor({ a: { ...record, numPages: 4 } })),
    /Could not preserve native content/);
});

test('concurrent exports share one pinned library import', needsLibrary, async () => {
  const record = await fixture(); let release;
  const h = harness({ gate: new Promise(resolve => { release = resolve; }) });
  const first = h.api.prepareStructurePreservingPdf([native('a', 0)], optionsFor({ a: record }));
  const second = h.api.prepareStructurePreservingPdf([native('a', 1)], optionsFor({ a: record }));
  release(); const results = await Promise.all([first, second]);
  assert.equal(h.imports.length, 1);
  assert.equal(results.length, 2);
});

test('an unreadable photo aborts mixed export without returning an incomplete PDF', needsLibrary, async () => {
  const record = await fixture();
  await assert.rejects(harness().api.prepareStructurePreservingPdf([native('a', 0), { name: 'broken.png' }], optionsFor({ a: record }, {
    async prepareImage() { return null; }, computeLayout() { throw new Error('Must not run'); }
  })), /No incomplete PDF was exported/);
});
