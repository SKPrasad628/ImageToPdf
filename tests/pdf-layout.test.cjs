const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'js/pdf-layout.js'), 'utf8');
const context = vm.createContext({
  PAGE_SIZES: { a4: [210, 297], letter: [215.9, 279.4], a3: [297, 420], a5: [148, 210] }
});
vm.runInContext(source, context);

function rendered(width = 600, height = 800) {
  return { w: width, h: height, data: 'encoded image', format: 'JPEG' };
}
function layout(image = {}, pixels = rendered(), settings = {}) {
  return context.computePdfLayout({ rotation: 0, ...image }, pixels, {
    pageSize: 'a4', orientation: 'portrait', imgFit: 'contain', margin: 0,
    dpi: 300, oversize: 'shrink', ...settings
  });
}
function close(actual, expected, message = '') {
  assert.ok(Math.abs(actual - expected) < 1e-8,
    `${message}: expected ${expected}, received ${actual}`);
}
function rectangle(actual, expected) {
  for (const [key, value] of Object.entries(expected)) close(actual[key], value, key);
}
function inside(image, bounds) {
  assert.ok(image.x >= bounds.x - 1e-8);
  assert.ok(image.y >= bounds.y - 1e-8);
  assert.ok(image.x + image.width <= bounds.x + bounds.width + 1e-8);
  assert.ok(image.y + image.height <= bounds.y + bounds.height + 1e-8);
}

test('an A4 PDF keeps its physical page size despite raster scale, rounding, and print DPI', () => {
  const image = { pdfPageSizeMm: { width: 210, height: 297 } };
  for (const [width, height, dpi] of [[1191, 1684, 300], [595, 842, 72], [1786, 2526, 600]]) {
    const result = layout(image, rendered(width, height), {
      pageSize: 'fit', orientation: 'auto', dpi
    });
    rectangle(result.page, { width: 210, height: 297 });
    assert.equal(result.page.orientation, 'p');
  }
});

test('mixed imported page dimensions are retained separately', () => {
  for (const [width, height] of [[210, 297], [215.9, 279.4], [127, 50.8], [508, 254]]) {
    const result = layout({ pdfPageSizeMm: { width, height } }, rendered(1440, 720), {
      pageSize: 'fit', orientation: 'auto'
    });
    rectangle(result.page, { width, height });
  }
});

for (const [rotation, width, height] of [[0, 210, 297], [90, 297, 210], [180, 210, 297], [270, 297, 210], [-90, 297, 210], [450, 297, 210]]) {
  test(`pending ${rotation}-degree PDF rotation determines physical fit-page orientation`, () => {
    const result = layout({ pdfPageSizeMm: { width: 210, height: 297 }, rotation },
      rendered(width * 4, height * 4), { pageSize: 'fit', orientation: 'auto' });
    rectangle(result.page, { width, height });
  });
}

test('a forced orientation changes the fit-page rectangle without stretching its image', () => {
  const result = layout({}, rendered(600, 800), {
    pageSize: 'fit', orientation: 'landscape', imgFit: 'contain', dpi: 300
  });
  rectangle(result.page, { width: 800 * 25.4 / 300, height: 600 * 25.4 / 300 });
  assert.equal(result.page.orientation, 'l');
  close(result.image.width / result.image.height, 600 / 800);
  inside(result.image, { x: 0, y: 0, width: result.page.width, height: result.page.height });
  assert.ok(result.image.width < result.page.width, 'Portrait content should be letterboxed on the landscape page');
});

test('forced portrait is honored for a landscape imported PDF', () => {
  const result = layout({ pdfPageSizeMm: { width: 297, height: 210 } }, rendered(1684, 1191), {
    pageSize: 'fit', orientation: 'portrait', imgFit: 'contain'
  });
  rectangle(result.page, { width: 210, height: 297 });
  assert.equal(result.page.orientation, 'p');
  close(result.image.width / result.image.height, 1684 / 1191);
  inside(result.image, { x: 0, y: 0, width: 210, height: 297 });
});

test('fit-page margins shrink the available image rectangle without enlarging the physical page', () => {
  const result = layout({ pdfPageSizeMm: { width: 210, height: 297 } }, rendered(1191, 1684), {
    pageSize: 'fit', orientation: 'auto', margin: 10
  });
  rectangle(result.page, { width: 210, height: 297 });
  inside(result.image, { x: 10, y: 10, width: 190, height: 277 });
});

for (const [name, width, height] of [['a4', 210, 297], ['letter', 215.9, 279.4], ['a3', 297, 420], ['a5', 148, 210]]) {
  test(`${name} fixed-page layout keeps the requested paper dimensions`, () => {
    rectangle(layout({}, rendered(), { pageSize: name }).page, { width, height });
    rectangle(layout({}, rendered(), { pageSize: name, orientation: 'landscape' }).page,
      { width: height, height: width });
  });
}

for (const [description, width, height] of [['wide', 4000, 1000], ['tall', 1000, 4000]]) {
  test(`fill-page clips a ${description} image inside the requested margins`, () => {
    const result = layout({}, rendered(width, height), { imgFit: 'fill', margin: 10 });
    rectangle(result.clip, { x: 10, y: 10, width: 190, height: 277 });
    close(result.image.width / result.image.height, width / height);
    assert.ok(result.image.width >= 190 - 1e-8 && result.image.height >= 277 - 1e-8);
    close(result.image.x + result.image.width / 2, 105);
    close(result.image.y + result.image.height / 2, 148.5);
    assert.equal(result.cropped, true);
  });
}

test('contain keeps the entire image inside margins without a clipping path', () => {
  const result = layout({}, rendered(4000, 1000), { imgFit: 'contain', margin: 10 });
  inside(result.image, { x: 10, y: 10, width: 190, height: 277 });
  assert.equal(result.clip, null);
  assert.equal(result.cropped, false);
});

for (const [dpi, width, height] of [[300, 50.8, 67.73333333333333], [150, 101.6, 135.46666666666667]]) {
  test(`print-size mode converts image pixels using the explicit ${dpi} DPI`, () => {
    const result = layout({}, rendered(600, 800), { imgFit: 'actual', dpi, margin: 10 });
    rectangle(result.image, { width, height });
    inside(result.image, { x: 10, y: 10, width: 190, height: 277 });
    assert.equal(result.scaledDown, false);
    assert.equal(result.cropped, false);
  });
}

test('print-size shrink policy scales down only an oversized image', () => {
  const result = layout({}, rendered(6000, 4000), {
    imgFit: 'actual', dpi: 300, margin: 10, oversize: 'shrink'
  });
  inside(result.image, { x: 10, y: 10, width: 190, height: 277 });
  close(result.image.width / result.image.height, 1.5);
  close(result.image.width, 190);
  assert.equal(result.scaledDown, true);
  assert.equal(result.cropped, false);
});

test('print-size crop policy retains the exact print dimensions and clips overflow at margins', () => {
  const result = layout({}, rendered(6000, 4000), {
    imgFit: 'actual', dpi: 300, margin: 10, oversize: 'crop'
  });
  rectangle(result.image, { width: 508, height: 4000 * 25.4 / 300 });
  rectangle(result.clip, { x: 10, y: 10, width: 190, height: 277 });
  assert.equal(result.scaledDown, false);
  assert.equal(result.cropped, true);
});

test('print-size mode respects the imported PDF physical size rather than reinterpreting its pixels', () => {
  const result = layout({ pdfPageSizeMm: { width: 210, height: 297 } }, rendered(1191, 1684), {
    pageSize: 'fit', orientation: 'auto', imgFit: 'actual', dpi: 600
  });
  rectangle(result.page, { width: 210, height: 297 });
  close(result.image.width / result.image.height, 1191 / 1684);
  assert.ok(result.image.width > 209 && result.image.height > 296);
});

test('fit-page photo dimensions use the same selected DPI as print-size mode', () => {
  const result = layout({}, rendered(600, 800), {
    pageSize: 'fit', orientation: 'auto', dpi: 150
  });
  rectangle(result.page, { width: 101.6, height: 135.46666666666667 });
});

test('a non-right-angle rotation retains the physical bounding box of an imported page', () => {
  const result = layout({ pdfPageSizeMm: { width: 210, height: 297 }, rotation: 45 },
    rendered(1434, 1434), { pageSize: 'fit', orientation: 'auto' });
  const side = (210 + 297) / Math.sqrt(2);
  rectangle(result.page, { width: side, height: side });
});

test('invalid print DPI produces an actionable error instead of an assumed size', () => {
  for (const dpi of [0, -1, NaN, Infinity, 2401, 'not a number']) {
    assert.throws(() => layout({}, rendered(), { imgFit: 'actual', dpi }), /DPI.*1.*2400/);
  }
});

test('fit-page dimensions exceeding the PDF writer limit are rejected before silent page truncation', () => {
  assert.throws(() => layout({ pdfPageSizeMm: { width: 5081, height: 210 } }, rendered(),
    { pageSize: 'fit', orientation: 'auto' }), /PDF size limit/);
  assert.throws(() => layout({}, rendered(6000, 8000),
    { pageSize: 'fit', orientation: 'auto', dpi: 1 }), /PDF size limit/);
});

test('layout does not mutate imported size metadata or captured export settings', () => {
  const image = { rotation: 90, pdfPageSizeMm: { width: 210, height: 297 } };
  const settings = { pageSize: 'fit', orientation: 'portrait', imgFit: 'fill', margin: 10, dpi: 300 };
  const beforeImage = JSON.stringify(image), beforeSettings = JSON.stringify(settings);
  context.computePdfLayout(image, rendered(1684, 1191), settings);
  assert.equal(JSON.stringify(image), beforeImage);
  assert.equal(JSON.stringify(settings), beforeSettings);
});

test('unused invalid photo DPI does not block fixed-paper contain/fill or imported PDF dimensions', () => {
  for (const dpi of [0, NaN, Infinity, 'invalid']) {
    for (const imgFit of ['contain', 'fill']) {
      rectangle(layout({}, rendered(), { pageSize: 'a4', imgFit, dpi }).page, { width: 210, height: 297 });
    }
    for (const imgFit of ['contain', 'actual']) {
      rectangle(layout({ pdfPageSizeMm: { width: 210, height: 297 } }, rendered(1191, 1684),
        { pageSize: 'fit', orientation: 'auto', imgFit, dpi }).page, { width: 210, height: 297 });
    }
  }
});

test('right-angle rotation preserves exact dimensions at the PDF page limit', () => {
  for (const rotation of [90, 180, 270, 360]) {
    const result = layout({ pdfPageSizeMm: { width: 5080, height: 4000 }, rotation },
      rendered(1270, 1000), { pageSize: 'fit', orientation: 'auto' });
    assert.equal(Math.max(result.page.width, result.page.height), 5080);
    assert.equal(Math.min(result.page.width, result.page.height), 4000);
  }
});

function recorder(throwOnImage = false) {
  const calls = [];
  const pdf = {};
  for (const method of ['saveGraphicsState', 'rect', 'clip', 'discardPath', 'restoreGraphicsState']) {
    pdf[method] = (...args) => { calls.push([method, ...args]); return pdf; };
  }
  pdf.addImage = (...args) => {
    calls.push(['addImage', ...args]);
    if (throwOnImage) throw new Error('Image encoder failed');
    return pdf;
  };
  return { pdf, calls };
}

test('the writer uses a non-painted PDF clipping path and balances the graphics state', () => {
  const h = recorder();
  const pixels = rendered(4000, 1000);
  const result = layout({}, pixels, { imgFit: 'fill', margin: 10 });
  context.writePdfImage(h.pdf, pixels, result);
  assert.deepEqual(h.calls.map(call => call[0]),
    ['saveGraphicsState', 'rect', 'clip', 'discardPath', 'addImage', 'restoreGraphicsState']);
  assert.deepEqual(h.calls[1], ['rect', 10, 10, 190, 277, null]);
  const imageCall = h.calls[4];
  assert.equal(imageCall[1], pixels.data);
  assert.equal(imageCall[2], pixels.format);
  rectangle({ x: imageCall[3], y: imageCall[4], width: imageCall[5], height: imageCall[6] }, result.image);
});

test('the writer restores the previous clipping state even when addImage throws', () => {
  const h = recorder(true);
  const pixels = rendered(4000, 1000);
  const result = layout({}, pixels, { imgFit: 'fill', margin: 10 });
  assert.throws(() => context.writePdfImage(h.pdf, pixels, result), /Image encoder failed/);
  assert.equal(h.calls.at(-1)[0], 'restoreGraphicsState');
});

test('a contained image is written without altering the PDF clipping state', () => {
  const h = recorder();
  const pixels = rendered();
  context.writePdfImage(h.pdf, pixels, layout({}, pixels));
  assert.deepEqual(h.calls.map(call => call[0]), ['addImage']);
});
