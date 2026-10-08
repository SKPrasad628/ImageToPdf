const fs = require('node:fs');
const source = fs.readFileSync('index.html', 'utf8');
const legacyStart = source.indexOf('<div class="page" id="page-edit">');
const editorStart = source.indexOf('<div class="modal-bg" id="editorModal"');
const footerStart = source.indexOf('<footer>PhotoPDF Studio');
if (legacyStart < 0 || editorStart < legacyStart || footerStart < editorStart) {
  throw new Error('Original application section markers did not match; no files changed.');
}
const legacy = source.slice(legacyStart, source.lastIndexOf('<!--', editorStart));
const editor = source.slice(editorStart, footerStart);
const shell = fs.readFileSync('tmp/page-forge-shell.html', 'utf8');
const tail = fs.readFileSync('tmp/page-forge-tail.html', 'utf8');
fs.writeFileSync('tmp/pre-page-forge-index.html', source);
fs.writeFileSync('index.html', shell + '\n<!-- Compatibility surfaces for saved processing paths; the visible workspace is unified. -->\n<div id="legacyViews" hidden inert>\n<div class="tab-bar"><button class="tab active" onclick="switchTab(\'convert\')">Convert</button><button class="tab" onclick="switchTab(\'edit\')">Edit PDF</button></div>\n' + legacy + '\n</div>\n' + editor + tail);
console.log('Rebuilt Page Forge shell; retained existing editor and processing surfaces.');
