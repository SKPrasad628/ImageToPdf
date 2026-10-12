'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { check, dependencies } = require('../scripts/dependency-check.cjs');
const { checkApplicationAssets } = require('../scripts/application-assets.cjs');

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
  const { files } = checkApplicationAssets();
  for (const resource of ['css/styles.css', 'css/fonts.css', 'css/page-forge.css',
    'css/minimal-ui.css', 'css/minimal-editor.css', 'js/large-image-worker.js',
    'vendor/pdf-lib/pdf-lib.esm.min.mjs']) {
    assert.ok(files.includes(resource), `${resource} is followed by the app resource check`);
  }
  for (const file of ['js/pdf-loader.js', 'js/pdf-preserve.js']) {
    const source = fs.readFileSync(localFile(file), 'utf8');
    assert.doesNotMatch(source, /cdn\.jsdelivr|cdnjs|unpkg/);
    assert.match(source, /new URL\('\.\.\/vendor\//);
    assert.match(source, /document\.currentScript\.src/);
  }
});

function assetFixture(t, files) {
  const prefix = path.join(os.tmpdir(), 'page-forge-assets-');
  const directory = fs.mkdtempSync(prefix);
  t.after(() => {
    const absolute = path.resolve(directory);
    assert.ok(absolute.startsWith(path.resolve(prefix)), 'cleanup stays inside its created temporary folder');
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(directory, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
  }
  return directory;
}

test('the resource check follows nested stylesheets and their relative font URLs', t => {
  const directory = assetFixture(t, {
    'index.html': '<link rel="stylesheet" href="css/ui.css">',
    'css/ui.css': '@import "components/editor.css";',
    'css/components/editor.css': '@font-face { src: url("../../fonts/local.ttf"); }',
    'fonts/local.ttf': 'fixture'
  });
  assert.deepEqual(checkApplicationAssets(directory).files,
    ['css/components/editor.css', 'css/ui.css', 'fonts/local.ttf', 'index.html']);
});

test('an external request in a newly loaded or nested stylesheet fails packaging', t => {
  const directory = assetFixture(t, {
    'index.html': '<link rel="stylesheet" href="css/new-layout.css">',
    'css/new-layout.css': '@import url("nested.css");',
    'css/nested.css': '@font-face { src: url("//fonts.example.test/remote.ttf"); }'
  });
  assert.throws(() => checkApplicationAssets(directory), /External application resource in css[\\/]nested.css/);
});

test('missing lazy worker resources fail packaging before a browser needs them', t => {
  const directory = assetFixture(t, {
    'index.html': '<script src="js/main.js"></script>',
    'js/main.js': 'const worker = new URL("worker.js", document.currentScript.src);'
  });
  assert.throws(() => checkApplicationAssets(directory), /Missing application resource.*worker.js/);
});

test('remote lazy module fallbacks fail packaging', t => {
  const directory = assetFixture(t, {
    'index.html': '<script src="js/main.js"></script>',
    'js/main.js': 'import("https://cdn.example.test/pdf.mjs");'
  });
  assert.throws(() => checkApplicationAssets(directory), /External application resource.*cdn.example.test/);
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
