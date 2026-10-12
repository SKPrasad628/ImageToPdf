const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const context = vm.createContext({ Uint8Array, DataView });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/file-intake.js'), 'utf8'), context);
const { classifyFile, HEADER_BYTES } = context.PhotoPdfFileIntake;
function file(bytes, name = 'photo', type = '') {
  const input = Uint8Array.from(bytes);
  return { name, type, size: input.length, reads: [], slice(start, end) {
    this.reads.push([start, end]);
    return { arrayBuffer: async () => input.slice(start, end).buffer };
  } };
}
function png(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(Buffer.from('IHDR'), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}
function webp(kind, payload) {
  const bytes = new Uint8Array(20 + payload.length);
  bytes.set(Buffer.from('RIFF')); bytes.set(Buffer.from('WEBP'), 8); bytes.set(Buffer.from(kind), 12);
  new DataView(bytes.buffer).setUint32(16, payload.length, true); bytes.set(payload, 20);
  return bytes;
}
function exifTiff(orientation, little = true) {
  const bytes = new Uint8Array(26), view = new DataView(bytes.buffer);
  bytes.set(Buffer.from(little ? 'II' : 'MM'));
  view.setUint16(2, 42, little); view.setUint32(4, 8, little);
  view.setUint16(8, 1, little);
  view.setUint16(10, 0x0112, little); view.setUint16(12, 3, little);
  view.setUint32(14, 1, little); view.setUint16(18, orientation, little);
  return bytes;
}
function jpegWithExif(tiff, afterSof = false) {
  const payload = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from(tiff)]);
  const size = payload.length + 2;
  const exif = Buffer.concat([Buffer.from([0xff, 0xe1, size >> 8, size & 255]), payload]);
  const sof = Buffer.from([0xff, 0xc0, 0, 8, 8, 0x1f, 0x40, 0x2e, 0xe0, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...(afterSof ? [sof, exif] : [exif, sof]), Buffer.from([0xff, 0xd9])]);
}
function pngChunk(type, payload) {
  const bytes = new Uint8Array(payload.length + 12), view = new DataView(bytes.buffer);
  view.setUint32(0, payload.length); bytes.set(Buffer.from(type), 4); bytes.set(payload, 8);
  return bytes;
}
function pngWithExif(tiff, afterIdat = false) {
  const ihdr = new Uint8Array(13), view = new DataView(ihdr.buffer);
  view.setUint32(0, 12000); view.setUint32(4, 8000);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    ...(afterIdat ? [pngChunk('IDAT', new Uint8Array(1))] : []), pngChunk('eXIf', tiff), pngChunk('IEND', [])]);
}

test('a PNG signature accepts an empty MIME and filename with no extension', async () => {
  const result = await classifyFile(file(png(2048, 1024)));
  assert.equal(result.kind, 'image'); assert.equal(result.format, 'png');
  assert.equal(result.mime, 'image/png'); assert.equal(result.width, 2048); assert.equal(result.height, 1024);
});

test('signatures override misleading MIME and extension', async () => {
  const result = await classifyFile(file(png(100, 50), 'report.pdf', 'application/pdf'));
  assert.equal(result.kind, 'image'); assert.equal(result.format, 'png');
  assert.equal(result.signatureDetected, true);
});

test('recognized extensions and MIME are fallbacks, with browser decoding still required', async () => {
  assert.equal((await classifyFile(file([], 'CAMERA.JPEG', 'application/octet-stream'))).format, 'jpeg');
  assert.equal((await classifyFile(file([], 'unnamed', 'image/png; charset=binary'))).format, 'png');
  assert.equal((await classifyFile(file([], 'report.PDF', 'image/jpeg'))).kind, 'pdf');
});

test('extension fallback cannot treat an unrecognized header as verified raster dimensions', async () => {
  const bytes = png(100, 200); bytes[0] = 0;
  const result = await classifyFile(file(bytes, 'photo.png', 'image/png'));
  assert.equal(result.kind, 'image'); assert.equal(result.signatureDetected, false);
  assert.equal(result.width, undefined); assert.equal(result.height, undefined);
});

test('JPEG baseline and progressive SOF dimensions are read after metadata segments', async () => {
  for (const marker of [0xc0, 0xc2]) {
    const bytes = [0xff, 0xd8, 0xff, 0xe1, 0, 4, 20, 30,
      0xff, marker, 0, 8, 8, 0x10, 0, 0x08, 0, 1];
    const result = await classifyFile(file(bytes, 'photo'));
    assert.equal(result.format, 'jpeg'); assert.equal(result.width, 2048); assert.equal(result.height, 4096);
  }
});

test('truncated or malformed JPEG dimensions are unknown, never invented', async () => {
  for (const bytes of [[0xff, 0xd8, 0xff], [0xff, 0xd8, 0xff, 0xc0, 0, 0], [0xff, 0xd8, 0xff, 0xc0, 0, 8]]) {
    const result = await classifyFile(file(bytes));
    assert.equal(result.kind, 'image'); assert.equal(result.width, undefined);
  }
});

test('JPEG EXIF orientation keeps encoded dimensions and supplies correctly oriented display dimensions', async () => {
  for (const little of [true, false]) for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const result = await classifyFile(file(jpegWithExif(exifTiff(orientation, little))));
    assert.equal(result.width, 12000); assert.equal(result.height, 8000);
    assert.equal(result.orientation, orientation);
    assert.equal(result.displayWidth, orientation >= 5 ? 8000 : 12000);
    assert.equal(result.displayHeight, orientation >= 5 ? 12000 : 8000);
  }
});

test('JPEG orientation metadata after SOF is read before the compressed scan', async () => {
  const result = await classifyFile(file(jpegWithExif(exifTiff(6), true)));
  assert.equal(result.width, 12000); assert.equal(result.height, 8000);
  assert.equal(result.orientation, 6); assert.equal(result.displayWidth, 8000); assert.equal(result.displayHeight, 12000);
});

test('malformed JPEG EXIF fields default safely without altering verified dimensions', async () => {
  const mutations = [
    bytes => { bytes[0] = 0; },
    bytes => { new DataView(bytes.buffer).setUint16(2, 43, true); },
    bytes => { new DataView(bytes.buffer).setUint32(4, 0xffffffff, true); },
    bytes => { new DataView(bytes.buffer).setUint32(4, 2, true); },
    bytes => { new DataView(bytes.buffer).setUint16(8, 0xffff, true); },
    bytes => { new DataView(bytes.buffer).setUint16(12, 4, true); },
    bytes => { new DataView(bytes.buffer).setUint32(14, 2, true); },
    bytes => { new DataView(bytes.buffer).setUint16(18, 0, true); },
    bytes => { new DataView(bytes.buffer).setUint16(18, 9, true); }
  ];
  for (const mutate of mutations) {
    const tiff = exifTiff(6); mutate(tiff);
    const result = await classifyFile(file(jpegWithExif(tiff)));
    assert.equal(result.orientation, 1); assert.equal(result.width, 12000); assert.equal(result.height, 8000);
    assert.equal(result.displayWidth, 12000); assert.equal(result.displayHeight, 8000);
  }
  for (const length of [0, 7, 9, 20, 25]) {
    const result = await classifyFile(file(jpegWithExif(exifTiff(6).slice(0, length))));
    assert.equal(result.orientation, 1); assert.equal(result.width, 12000); assert.equal(result.height, 8000);
  }
});

test('PNG eXIf uses the same bounded endian-aware orientation parser', async () => {
  for (const little of [true, false]) for (const orientation of [1, 3, 6, 8]) {
    const result = await classifyFile(file(pngWithExif(exifTiff(orientation, little), true)));
    assert.equal(result.width, 12000); assert.equal(result.height, 8000); assert.equal(result.orientation, orientation);
    assert.equal(result.displayWidth, orientation >= 5 ? 8000 : 12000);
    assert.equal(result.displayHeight, orientation >= 5 ? 12000 : 8000);
  }
});

test('malformed PNG eXIf lengths and pointers cannot escape the bounded header', async () => {
  const truncatedTiff = pngWithExif(exifTiff(6).slice(0, 25));
  const badPointerTiff = exifTiff(6); new DataView(badPointerTiff.buffer).setUint32(4, 0xffffffff, true);
  const badChunk = new Uint8Array(pngWithExif(exifTiff(6)));
  new DataView(badChunk.buffer).setUint32(33, 0xffffffff);
  for (const bytes of [truncatedTiff, pngWithExif(badPointerTiff), badChunk]) {
    const result = await classifyFile(file(bytes));
    assert.equal(result.orientation, 1); assert.equal(result.width, 12000); assert.equal(result.height, 8000);
  }
});

test('orientation beyond the header read is not guessed or read through a full-file fallback', async () => {
  const base = pngWithExif(exifTiff(6));
  const bytes = Buffer.concat([base.subarray(0, 33), pngChunk('tEXt', new Uint8Array(HEADER_BYTES)), base.subarray(33)]);
  const input = file(bytes); input.arrayBuffer = () => { throw new Error('Full-file read'); };
  const result = await classifyFile(input);
  assert.equal(result.orientation, 1); assert.equal(result.width, 12000); assert.equal(result.height, 8000);
  assert.deepEqual(input.reads, [[0, HEADER_BYTES]]);
});

test('GIF logical canvas dimensions are preflighted for both versions', async () => {
  for (const version of ['GIF87a', 'GIF89a']) {
    const bytes = new Uint8Array(10); bytes.set(Buffer.from(version));
    const view = new DataView(bytes.buffer); view.setUint16(6, 640, true); view.setUint16(8, 480, true);
    const result = await classifyFile(file(bytes));
    assert.equal(result.format, 'gif'); assert.equal(result.width, 640); assert.equal(result.height, 480);
  }
});

test('BMP core and top-down Windows dimensions are read without decoding', async () => {
  for (const core of [true, false]) {
    const bytes = new Uint8Array(26); bytes.set(Buffer.from('BM'));
    const view = new DataView(bytes.buffer); view.setUint32(14, core ? 12 : 40, true);
    if (core) { view.setUint16(18, 800, true); view.setUint16(20, 600, true); }
    else { view.setInt32(18, 800, true); view.setInt32(22, -600, true); }
    const result = await classifyFile(file(bytes));
    assert.equal(result.width, 800); assert.equal(result.height, 600);
  }
});

test('WebP extended, lossy, and lossless dimensions are read', async () => {
  const extended = new Uint8Array(10);
  extended.set([0xff, 0x03, 0], 4); extended.set([0xff, 0x01, 0], 7);
  const lossy = new Uint8Array(10); lossy.set([0x9d, 0x01, 0x2a], 3);
  const lossyView = new DataView(lossy.buffer); lossyView.setUint16(6, 1024, true); lossyView.setUint16(8, 512, true);
  const lossless = new Uint8Array(5); lossless[0] = 0x2f;
  new DataView(lossless.buffer).setUint32(1, 1023 | 511 << 14, true);
  for (const [kind, bytes] of [['VP8X', extended], ['VP8 ', lossy], ['VP8L', lossless]]) {
    const result = await classifyFile(file(webp(kind, bytes)));
    assert.equal(result.format, 'webp'); assert.equal(result.width, 1024); assert.equal(result.height, 512);
  }
});

test('malformed WebP chunk lengths cannot cause an unbounded parser loop', async () => {
  const bytes = webp('META', new Uint8Array(2)); new DataView(bytes.buffer).setUint32(16, 0xffffffff, true);
  const result = await classifyFile(file(bytes));
  assert.equal(result.format, 'webp'); assert.equal(result.width, undefined);
});

test('AVIF is identified without guessing which image item supplies dimensions', async () => {
  const bytes = new Uint8Array(24); new DataView(bytes.buffer).setUint32(0, 24);
  bytes.set(Buffer.from('ftyp'), 4); bytes.set(Buffer.from('mif1'), 8); bytes.set(Buffer.from('avif'), 16);
  const result = await classifyFile(file(bytes));
  assert.equal(result.format, 'avif'); assert.equal(result.width, undefined);
});

test('PDF signatures route unnamed or misleading image MIME files to PDF import', async () => {
  const result = await classifyFile(file(Buffer.from('prefix\n%PDF-1.7\n'), 'scan.bin', 'image/png'));
  assert.equal(result.kind, 'pdf'); assert.equal(result.mime, 'application/pdf');
  assert.equal((await classifyFile(file(Buffer.from('%PDF-2.0\n')))).kind, 'pdf');
});

test('classic TIFF and BigTIFF are explicitly refused regardless of MIME', async () => {
  for (const bytes of [[73, 73, 42, 0], [77, 77, 0, 42], [73, 73, 43, 0], [77, 77, 0, 43]]) {
    const result = await classifyFile(file(bytes, 'photo.png', 'image/png'));
    assert.equal(result.kind, 'unsupported'); assert.equal(result.format, 'tiff');
    assert.match(result.reason, /multipage TIFF.*not supported/);
  }
});

test('TIFF extensions and MIME are explicitly refused when no signature is available', async () => {
  for (const [name, type] of [['scan.TIFF', ''], ['scan.tif', 'application/octet-stream'], ['scan', 'image/tiff']]) {
    assert.equal((await classifyFile(file([], name, type))).format, 'tiff');
  }
});

test('unsupported formats and inaccessible files provide a visible reason', async () => {
  assert.match((await classifyFile(file(Buffer.from('<svg/>'), 'drawing.svg', 'image/svg+xml'))).reason, /Unsupported format/);
  assert.equal((await classifyFile({ name: 'broken.png', slice() { throw new Error('denied'); } })).reason, 'The file could not be read.');
});

test('header reads stay bounded and never use a full-file arrayBuffer fallback', async () => {
  const input = file(png(1, 1));
  input.size = 50 * 1024 * 1024; input.arrayBuffer = () => { throw new Error('Full-file read'); };
  await classifyFile(input);
  assert.deepEqual(input.reads, [[0, HEADER_BYTES]]);
  const noSlice = { name: 'photo.jpg', type: '', arrayBuffer() { throw new Error('Full-file read'); } };
  assert.equal((await classifyFile(noSlice)).format, 'jpeg');
});
