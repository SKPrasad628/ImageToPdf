const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const app = fs.readFileSync(path.resolve(__dirname, '../js/app.js'), 'utf8');
const source = app.match(/function sanitizeFilename\([^]*?\n\}/)[0];
const context = vm.createContext({});
vm.runInContext(source, context);

for (const [input, expected] of [
  ['report.pdf', 'report'], ['report.PDF', 'report'], ['report.pDf.pdf.PDF', 'report'],
  ['  report .PDF  .pdf \n', 'report'], ['.pdf', 'my-photos'], [' .PDF .pdf ', 'my-photos'],
  ['', 'my-photos'], [null, 'my-photos'], ['  ', 'my-photos'], ['...', 'my-photos'],
  [' .hidden.pdf ', 'hidden'], ['re<>:"/\\|?*port.pdf', 'report'],
  ['photo\x00\x1fname.pdf', 'photoname'], ['report.pdf.backup', 'report.pdf.backup'],
  ['report.txt', 'report.txt'], ['café_原稿.PDF', 'café_原稿'],
  ['A'.repeat(121) + '.pdf', 'A'.repeat(120)],
  ['A'.repeat(116) + '.pdf' + 'B'.repeat(20), 'A'.repeat(116)]
]) {
  test(`PDF filename normalization: ${JSON.stringify(input)}`, () => {
    const stem = context.sanitizeFilename(input);
    assert.equal(stem, expected);
    assert.ok(stem.length <= 120);
    assert.doesNotMatch(stem, /\.pdf\s*$/i);
    assert.equal((stem + '.pdf').match(/\.pdf$/gi).length, 1);
  });
}
