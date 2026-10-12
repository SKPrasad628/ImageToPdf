'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const libraryDir = (() => { try { return path.dirname(require.resolve('pdf-lib/package.json')); }
  catch { return path.join(bundled, 'pdf-lib'); } })();
const PDFLib = require(libraryDir);
const bundle = fs.readFileSync(path.join(libraryDir, 'dist/pdf-lib.min.js'), 'utf8');
function harness() {
  const context = vm.createContext({ window: {}, Uint8Array, ArrayBuffer, URL, TextDecoder, setTimeout, clearTimeout,
    document: { currentScript: { src: 'https://example.test/js/pdf-preserve.js' } } });
  vm.runInContext(bundle, context);
  for (const name of ['core', 'navigation', 'forms', 'tags']) {
    const target = path.join(root, `js/pdf-native-${name}.js`);
    if (fs.existsSync(target)) vm.runInContext(fs.readFileSync(target, 'utf8'), context);
  }
  let imported;
  new vm.Script(fs.readFileSync(path.join(root, 'js/pdf-preserve.js'), 'utf8'), {
    importModuleDynamically: async () => {
      if (!imported) {
        const library = context.PDFLib, keys = Object.keys(library);
        imported = new vm.SyntheticModule(keys, function () {
          for (const key of keys) this.setExport(key, library[key]);
        }, { context });
        await imported.link(() => {});
        await imported.evaluate();
      }
      return imported;
    }
  }).runInContext(context);
  return { context, library: context.PDFLib, window: context.window,
    api: context.window.PhotoPdfPreservation,
    async plan(records, images) {
      const loaded = new Map();
      for (const [id, record] of Object.entries(records)) loaded.set(id,
        { name: record.name || `${id}.pdf`, document: await context.PDFLib.PDFDocument.load(new Uint8Array(record.bytes), { updateMetadata: false }) });
      // Use the application's realm for Map/Array identity checks in pdf-lib.
      context.records = Array.from(loaded); context.images = images;
      const result = await vm.runInContext('window.PhotoPdfNativeCore.create(PDFLib, new Map(records), images, message => new Error(message))', context);
      delete context.records; delete context.images;
      return result;
    }
  };
}
function native(sourceId, pageIndex, overrides = {}) {
  return { name: `${sourceId} page ${pageIndex + 1}`, rotation: 0, filters: {},
    pdfSource: { sourceId, pageIndex }, ...overrides };
}
module.exports = { harness, PDFLib, native, root, bundled };
