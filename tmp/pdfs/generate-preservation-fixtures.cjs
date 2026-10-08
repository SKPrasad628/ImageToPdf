// QA only. This script is intentionally not run by the unit-test suite.
// After the required PDF skill marker, run from the project directory:
// node --experimental-vm-modules tmp/pdfs/generate-preservation-fixtures.cjs
// It writes native-original.pdf, native-reordered.pdf, native-mixed.pdf and
// preservation-notices.json beside this script. Render and inspect all pages.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '../..');
const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
let libraryDir;
try { libraryDir = path.dirname(require.resolve('pdf-lib/package.json')); }
catch { libraryDir = path.join(bundled, 'pdf-lib'); }
const library = require(libraryDir);

function crc32(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
function patternedPhoto() {
  const width = 400, height = 300, rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      rows[offset] = x < 200 ? 220 : 35;
      rows[offset + 1] = y < 150 ? 70 : 185;
      rows[offset + 2] = x % 40 < 2 || y % 40 < 2 ? 255 : 100;
      rows[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return new Uint8Array(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]));
}
function native(id, pageIndex, rotation = 0) {
  return { name: `Native page ${pageIndex + 1}`, pdfSource: { sourceId: id, pageIndex },
    rotation, flipH: false, flipV: false, filters: {} };
}

async function main() {
  const source = await library.PDFDocument.create();
  source.setTitle('Native PDF preservation QA');
  source.setLanguage('en-US');
  const pages = [[320,480], [612,792], [792,612]].map((size, index) => {
    const page = source.addPage(size);
    page.drawText(`Native text page ${index + 1}`, { x: 24, y: size[1] - 90, size: 20 });
    page.drawText('Selectable text and vector shapes', { x: 24, y: size[1] - 120, size: 12 });
    page.drawRectangle({ x: 24, y: 60, width: 150, height: 45, color: library.rgb(0.1, 0.65, 0.9) });
    page.drawLine({ start: { x: 24, y: 115 }, end: { x: 250, y: 240 }, thickness: 3, color: library.rgb(0.85, 0.2, 0.2) });
    return page;
  });
  pages[1].setCropBox(20, 30, 500, 700);
  pages[2].setRotation(library.degrees(90));
  const link = source.context.register(source.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [24,350,270,395],
    Border: [0,0,1], A: { S: 'URI', URI: library.PDFString.of('https://example.com/native-page') } }));
  pages[0].node.addAnnot(link);
  const field = source.getForm().createTextField('personal.name');
  field.setText('Alice'); field.addToPage(pages[0], { x:24, y:160, width:170, height:25 });
  const outlines = source.context.obj({ Type:'Outlines', Count:1 });
  const outlineRef = source.context.register(outlines);
  const itemRef = source.context.register(source.context.obj({ Title:library.PDFString.of('First native page'),
    Parent:outlineRef, Dest:[pages[0].ref, library.PDFName.of('Fit')] }));
  outlines.set(library.PDFName.of('First'), itemRef); outlines.set(library.PDFName.of('Last'), itemRef);
  source.catalog.set(library.PDFName.of('Outlines'), outlineRef);
  const record = { bytes:await source.save(), name:'native-original.pdf', numPages:3 };

  const context = vm.createContext({ window:{}, Uint8Array, ArrayBuffer, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(libraryDir, 'dist/pdf-lib.min.js'), 'utf8'), context);
  const keys = Object.keys(context.PDFLib);
  const module = new vm.SyntheticModule(keys, function () {
    for (const key of keys) this.setExport(key, context.PDFLib[key]);
  }, { context });
  new vm.Script(fs.readFileSync(path.join(root, 'js/pdf-preserve.js'), 'utf8'), {
    importModuleDynamically:async () => {
      if (module.status === 'unlinked') await module.link(() => {});
      if (module.status !== 'evaluated') await module.evaluate();
      return module;
    }
  }).runInContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/pdf-layout.js'), 'utf8'), context);
  const api = context.window.PhotoPdfPreservation;
  const getSource = () => record;
  const original = await api.prepareStructurePreservingPdf([native('a',0),native('a',1),native('a',2)], {getSource});
  const reordered = await api.prepareStructurePreservingPdf([native('a',2,90),native('a',0)], {getSource});
  const mixed = await api.prepareStructurePreservingPdf([native('a',0),{name:'patterned-photo.png'},native('b',1,180)], {
    getSource, async prepareImage() { return {data:patternedPhoto(),format:'PNG',w:400,h:300}; },
    computeLayout:context.computePdfLayout,
    settings:{pageSize:'a4',orientation:'portrait',margin:20,imgFit:'fill',dpi:300,oversize:'shrink'}
  });
  for (const [name, result] of [['original',original],['reordered',reordered],['mixed',mixed]]) {
    fs.writeFileSync(path.join(__dirname, `native-${name}.pdf`), result.bytes);
  }
  fs.writeFileSync(path.join(__dirname, 'preservation-notices.json'), JSON.stringify(
    {original:original.notice,reordered:reordered.notice,mixed:mixed.notice}, null, 2));
  process.stdout.write('Wrote native-original.pdf, native-reordered.pdf, native-mixed.pdf and preservation-notices.json\n');
}
main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
