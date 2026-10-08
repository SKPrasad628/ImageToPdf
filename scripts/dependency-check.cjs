// Regenerate intentionally after updating a pinned dependency:
// node scripts/dependency-check.cjs --write
// Verify shipped files without network access: node scripts/dependency-check.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const vendorRoot = path.join(root, 'vendor');
const manifestPath = path.join(vendorRoot, 'manifest.json');
const dependencies = [
  { name: 'jspdf', version: '2.5.1', directory: 'vendor/jspdf', license: 'MIT',
    source: 'https://registry.npmjs.org/jspdf/-/jspdf-2.5.1.tgz',
    archiveSha256: '106070cae9e15de91e02ad40fdbf5cda97d41f390f06d46f5b06c2a623b09e97' },
  { name: 'pdfjs-dist', version: '6.3.289', directory: 'vendor/pdfjs', license: 'Apache-2.0',
    source: 'https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.3.289.tgz',
    archiveSha256: '06f25e887adc6489f04c9fcb14198c77e4e5623a59a0bba5c4cea5838a4f1241' },
  { name: 'pdf-lib', version: '1.17.1', directory: 'vendor/pdf-lib', license: 'MIT',
    source: 'https://registry.npmjs.org/pdf-lib/-/pdf-lib-1.17.1.tgz',
    acquisition: 'Copied unchanged from the bundled pdf-lib 1.17.1 npm package; the ESM bundle extension was changed from .js to .mjs.' },
  { name: 'Cinzel', version: 'Google Fonts v26', directory: 'vendor/fonts', license: 'OFL-1.1',
    source: 'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700&display=swap',
    sourceRepository: 'https://github.com/google/fonts/tree/main/ofl/cinzel',
    licenseSource: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/cinzel/OFL.txt',
    acquisition: 'Unmodified static TrueType files from the versioned Google Fonts CSS delivery URLs; license copied from the Google Fonts repository mirror.',
    files: [
      { name: 'Cinzel-Regular.ttf', source: 'https://fonts.gstatic.com/s/cinzel/v26/8vIU7ww63mVu7gtR-kwKxNvkNOjw-tbnTYo.ttf' },
      { name: 'Cinzel-Medium.ttf', source: 'https://fonts.gstatic.com/s/cinzel/v26/8vIU7ww63mVu7gtR-kwKxNvkNOjw-uTnTYo.ttf' },
      { name: 'Cinzel-SemiBold.ttf', source: 'https://fonts.gstatic.com/s/cinzel/v26/8vIU7ww63mVu7gtR-kwKxNvkNOjw-gjgTYo.ttf' },
      { name: 'Cinzel-Bold.ttf', source: 'https://fonts.gstatic.com/s/cinzel/v26/8vIU7ww63mVu7gtR-kwKxNvkNOjw-jHgTYo.ttf' }
    ] },
  { name: 'EB Garamond', version: 'Google Fonts v33', directory: 'vendor/fonts', license: 'OFL-1.1',
    source: 'https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap',
    sourceRepository: 'https://github.com/google/fonts/tree/main/ofl/ebgaramond',
    licenseSource: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/ebgaramond/OFL.txt',
    acquisition: 'Unmodified static TrueType files from the versioned Google Fonts CSS delivery URLs; license copied from the Google Fonts repository mirror.',
    files: [
      { name: 'EBGaramond-Regular.ttf', source: 'https://fonts.gstatic.com/s/ebgaramond/v33/SlGDmQSNjdsmc35JDF1K5E55YMjF_7DPuGi-6_RUAw.ttf' },
      { name: 'EBGaramond-Medium.ttf', source: 'https://fonts.gstatic.com/s/ebgaramond/v33/SlGDmQSNjdsmc35JDF1K5E55YMjF_7DPuGi-2fRUAw.ttf' },
      { name: 'EBGaramond-SemiBold.ttf', source: 'https://fonts.gstatic.com/s/ebgaramond/v33/SlGDmQSNjdsmc35JDF1K5E55YMjF_7DPuGi-NfNUAw.ttf' },
      { name: 'EBGaramond-Italic.ttf', source: 'https://fonts.gstatic.com/s/ebgaramond/v33/SlGFmQSNjdsmc35JDF1K5GRwUjcdlttVFm-rI7e8QI96.ttf' }
    ] }
];

function inventory(directory = vendorRoot) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Vendor symlinks are not permitted: ${target}`);
    if (entry.isDirectory()) files.push(...inventory(target));
    else if (target !== manifestPath) {
      const bytes = fs.readFileSync(target);
      files.push({ path: path.relative(root, target).split(path.sep).join('/'), bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function check() {
  const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const actual = inventory();
  if (JSON.stringify(actual) !== JSON.stringify(expected.files)) {
    throw new Error('Vendor file hashes/inventory differ from vendor/manifest.json. Restore the pinned files or intentionally regenerate after reviewing an update.');
  }
  if (JSON.stringify(expected.dependencies) !== JSON.stringify(dependencies)) {
    throw new Error('Pinned dependency provenance differs from the checker.');
  }
  return { count: actual.length, bytes: actual.reduce((sum, file) => sum + file.bytes, 0) };
}

if (require.main === module) {
  try {
    if (process.argv.includes('--write')) {
      const manifest = { format: 1, dependencies, files: inventory() };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    }
    const result = check();
    process.stdout.write(`Verified ${result.count} local dependency files (${result.bytes} bytes).\n`);
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
module.exports = { check, inventory, dependencies };
