const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const context = vm.createContext({ Uint8Array, DataView });
vm.runInContext(fs.readFileSync(path.join(root, 'js/file-intake.js'), 'utf8'), context);
(async () => {
  const filePath = path.join(__dirname, 'intake-fixtures.json');
  const fixtures = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  for (const fixture of fixtures) {
    const blob = new Blob([fs.readFileSync(path.join(__dirname, fixture.file))], { type: 'image/jpeg' });
    const reads = [];
    const input = { name: fixture.file, type: blob.type, size: blob.size, slice(start, end) {
      reads.push([start, end]); return blob.slice(start, end);
    } };
    fixture.intake = { ...await context.PhotoPdfFileIntake.classifyFile(input), reads };
    if (fixture.intake.width !== fixture.encoded[0] || fixture.intake.height !== fixture.encoded[1] ||
        fixture.intake.displayWidth !== fixture.display[0] || fixture.intake.displayHeight !== fixture.display[1]) {
      throw new Error('Intake dimensions differ from independently decoded fixture: ' + fixture.file);
    }
  }
  fs.writeFileSync(filePath, JSON.stringify(fixtures, null, 2) + '\n');
  process.stdout.write(JSON.stringify(fixtures.map(({ file, intake }) => ({ file, headerBytes: intake.headerBytes,
    dimensions: [intake.width, intake.height], display: [intake.displayWidth, intake.displayHeight] })), null, 2));
})().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
