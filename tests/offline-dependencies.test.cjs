'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { check, dependencies } = require('../scripts/dependency-check.cjs');

const root = path.resolve(__dirname, '..');
const localFile = relative => path.join(root, relative);

test('every shipped dependency has its reviewed hash, length and provenance', () => {
  const result = check();
  assert.ok(result.count >= 200);
  assert.ok(result.bytes > 5000000);
  assert.deepEqual(dependencies.map(value => [value.name, value.version]),
    [['jspdf', '2.5.1'], ['pdfjs-dist', '6.3.289'], ['pdf-lib', '1.17.1'],
      ['Cinzel', 'Google Fonts v26'], ['EB Garamond', 'Google Fonts v33']]);
});

test('PDF.js ships matching parser/worker, complete rendering assets and licenses', () => {
  for (const file of ['legacy/build/pdf.min.mjs', 'legacy/build/pdf.worker.min.mjs']) {
    const source = fs.readFileSync(localFile('vendor/pdfjs/' + file), 'utf8');
    assert.match(source, /pdfjsVersion = 6\.3\.289/);
  }
  for (const file of ['cmaps/Adobe-Japan1-UCS2.bcmap', 'standard_fonts/LiberationSans-Regular.ttf',
    'standard_fonts/FoxitSerif.pfb', 'wasm/openjpeg.wasm', 'wasm/openjpeg_nowasm_fallback.js',
    'wasm/jbig2.wasm', 'wasm/jbig2_nowasm_fallback.js', 'wasm/qcms_bg.wasm',
    'iccs/CGATS001Compat-v2-micro.icc', 'LICENSE', 'standard_fonts/LICENSE_FOXIT',
    'standard_fonts/LICENSE_LIBERATION', 'wasm/LICENSE_OPENJPEG', 'wasm/LICENSE_QCMS', 'iccs/LICENSE']) {
    assert.ok(fs.statSync(localFile('vendor/pdfjs/' + file)).size > 0, file);
  }
});

test('application scripts, styles and fonts have no remote resource dependencies', () => {
  const html = fs.readFileSync(localFile('index.html'), 'utf8');
  const tags = [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)=["']([^"']+)["'][^>]*>/gi)];
  assert.ok(tags.length >= 10);
  for (const stylesheet of ['css/styles.css', 'css/fonts.css', 'css/page-forge.css']) {
    assert.ok(tags.some(([, resource]) => resource === stylesheet), `${stylesheet} is loaded by the app`);
  }
  for (const [, resource] of tags) {
    assert.doesNotMatch(resource, /^(?:https?:)?\/\//i);
    assert.ok(fs.existsSync(localFile(resource)), resource);
  }
  for (const stylesheet of ['css/styles.css', 'css/fonts.css', 'css/page-forge.css']) {
    const css = fs.readFileSync(localFile(stylesheet), 'utf8');
    assert.doesNotMatch(css, /(?:url\(\s*["']?|@import\s*["'])\s*(?:https?:)?\/\//i);
    for (const [, resource] of css.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi)) {
      if (/^(?:data:|#)/i.test(resource)) continue;
      assert.ok(fs.existsSync(path.resolve(path.dirname(localFile(stylesheet)), resource)), `${stylesheet}: ${resource}`);
    }
  }
  for (const file of ['js/pdf-loader.js', 'js/pdf-preserve.js']) {
    const source = fs.readFileSync(localFile(file), 'utf8');
    assert.doesNotMatch(source, /cdn\.jsdelivr|cdnjs|unpkg/);
    assert.match(source, /new URL\('\.\.\/vendor\//);
    assert.match(source, /document\.currentScript\.src/);
  }
});

test('both display font families ship valid local TrueType files and their original OFL licenses', () => {
  const css = fs.readFileSync(localFile('css/fonts.css'), 'utf8');
  const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(([, block]) => {
    assert.match(block, /font-display:\s*swap/);
    return {
      family: block.match(/font-family:\s*'([^']+)'/)[1],
      weight: Number(block.match(/font-weight:\s*(\d+)/)[1]),
      style: block.match(/font-style:\s*(\w+)/)[1],
      resource: block.match(/url\('([^']+)'\)/)[1]
    };
  });
  assert.deepEqual(faces.map(({ family, weight, style }) => [family, weight, style]), [
    ['Cinzel', 400, 'normal'], ['Cinzel', 500, 'normal'], ['Cinzel', 600, 'normal'], ['Cinzel', 700, 'normal'],
    ['EB Garamond', 400, 'normal'], ['EB Garamond', 500, 'normal'], ['EB Garamond', 600, 'normal'], ['EB Garamond', 400, 'italic']
  ]);
  for (const face of faces) {
    const filename = path.resolve(localFile('css'), face.resource);
    const bytes = fs.readFileSync(filename);
    assert.equal(bytes.readUInt32BE(0), 0x00010000, `${face.resource} must be a TrueType font`);
    const tableCount = bytes.readUInt16BE(4), tables = new Set();
    assert.ok(tableCount > 0 && 12 + tableCount * 16 < bytes.length);
    for (let index = 0; index < tableCount; index++) {
      const offset = 12 + index * 16;
      tables.add(bytes.toString('ascii', offset, offset + 4));
      assert.ok(bytes.readUInt32BE(offset + 8) + bytes.readUInt32BE(offset + 12) <= bytes.length,
        `${face.resource} has a truncated font table`);
    }
    for (const table of ['name', 'cmap', 'glyf']) assert.ok(tables.has(table), `${face.resource}: missing ${table}`);
    const dependency = dependencies.find(item => item.name === face.family);
    assert.ok(dependency.files.some(item => item.name === path.basename(filename)), 'font is listed in pinned provenance');
  }
  for (const family of ['Cinzel', 'EBGaramond']) {
    const license = fs.readFileSync(localFile(`vendor/fonts/${family}-OFL.txt`), 'utf8');
    assert.match(license, /Copyright \d{4} The .+ Project Authors/);
    assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/i);
    assert.match(license, /PERMISSION & CONDITIONS/);
  }
});

test('the bundled libraries create and independently parse PDFs without CDN imports', async () => {
  // The CLI check does not render canvas pixels. PDF.js needs these browser
  // constructors at module evaluation even when testing only parsing/text.
  globalThis.DOMMatrix ||= class DOMMatrix {};
  globalThis.Path2D ||= class Path2D {};
  const pdfjs = await import(pathToFileURL(localFile('vendor/pdfjs/legacy/build/pdf.min.mjs')).href);
  const worker = await import(pathToFileURL(localFile('vendor/pdfjs/legacy/build/pdf.worker.min.mjs')).href);
  assert.equal(pdfjs.version, '6.3.289');
  assert.equal(typeof worker.WorkerMessageHandler.setup, 'function');
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(localFile('vendor/pdfjs/legacy/build/pdf.worker.min.mjs')).href;

  const { jsPDF } = require('../vendor/jspdf/jspdf.umd.min.js');
  assert.equal(jsPDF.version, '2.5.1');
  const imagePdf = new jsPDF();
  imagePdf.text('Bundled image export', 10, 10);
  imagePdf.addImage('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=',
    'PNG', 10, 20, 10, 10);

  const nativeLibrary = await import(pathToFileURL(localFile('vendor/pdf-lib/pdf-lib.esm.min.mjs')).href);
  const nativePdf = await nativeLibrary.PDFDocument.create();
  const font = await nativePdf.embedFont(nativeLibrary.StandardFonts.Helvetica);
  nativePdf.addPage([320, 480]).drawText('Bundled native export', { x: 20, y: 400, size: 16, font });
  const fixtures = [
    [new Uint8Array(imagePdf.output('arraybuffer')), 'Bundled image export'],
    [await nativePdf.save(), 'Bundled native export']
  ];
  for (const [bytes, expectedText] of fixtures) {
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false,
      // Node's official binary-data factory expects filesystem paths.
      cMapPacked: true, cMapUrl: localFile('vendor/pdfjs/cmaps') + '/',
      standardFontDataUrl: localFile('vendor/pdfjs/standard_fonts') + '/',
      wasmUrl: localFile('vendor/pdfjs/wasm') + '/',
      iccUrl: localFile('vendor/pdfjs/iccs') + '/' });
    let document;
    try {
      document = await task.promise;
      assert.equal(document.numPages, 1);
      const page = await document.getPage(1);
      const content = await page.getTextContent();
      assert.ok(content.items.some(item => item.str === expectedText));
      const operators = await page.getOperatorList();
      assert.ok(operators.fnArray.length > 0);
      if (expectedText === 'Bundled image export') {
        assert.ok(operators.fnArray.includes(pdfjs.OPS.paintImageXObject), 'The bundled PNG path creates a readable PDF image.');
      }
      page.cleanup();
    } finally {
      await task.destroy();
    }
  }
});
