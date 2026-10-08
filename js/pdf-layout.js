// Millimetres are independent of the pixels used to render or encode a page.
const PDF_LAYOUT_PAGE_SIZES = { a4: [210, 297], letter: [215.9, 279.4], a3: [297, 420], a5: [148, 210] };
const PDF_MAX_PAGE_MM = 5080; // jsPDF's 14,400-point page limit.

function copyPdfPageSize(size) {
  return size ? { width: size.width, height: size.height } : undefined;
}

function rotatedPdfPageSize(size, rotation = 0) {
  if (!size) return undefined;
  const angle = ((rotation % 360) + 360) % 360 * Math.PI / 180;
  const snap = value => value < 1e-12 ? 0 : (Math.abs(value - 1) < 1e-12 ? 1 : value);
  const cosine = snap(Math.abs(Math.cos(angle))), sine = snap(Math.abs(Math.sin(angle)));
  return {
    width: size.width * cosine + size.height * sine,
    height: size.width * sine + size.height * cosine
  };
}

function computePdfLayout(image, rendered, settings) {
  const width = Number(rendered.w), height = Number(rendered.h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('The image has invalid dimensions.');
  }
  const physicalPage = rotatedPdfPageSize(image.pdfPageSizeMm, image.rotation || 0);
  if (physicalPage && (!Number.isFinite(physicalPage.width) || !Number.isFinite(physicalPage.height) ||
      physicalPage.width <= 0 || physicalPage.height <= 0)) {
    throw new Error('The imported PDF page has invalid physical dimensions.');
  }
  const needsPhotoDpi = !physicalPage && (settings.pageSize === 'fit' || settings.imgFit === 'actual');
  const suppliedDpi = settings.dpi === undefined ? 300 : Number(settings.dpi);
  if (needsPhotoDpi && (!Number.isFinite(suppliedDpi) || suppliedDpi < 1 || suppliedDpi > 2400)) {
    throw new Error('Enter a photo print DPI between 1 and 2400.');
  }
  const dpi = needsPhotoDpi ? suppliedDpi : 300;
  let printWidth = width * 25.4 / dpi, printHeight = height * 25.4 / dpi;
  if (physicalPage) {
    // Cropping/resizing edits the content; it keeps the imported paper size.
    // Fit the edited aspect ratio inside that physical box without stretching.
    const scale = Math.min(physicalPage.width / width, physicalPage.height / height);
    printWidth = width * scale;
    printHeight = height * scale;
  }
  let pageWidth, pageHeight;
  if (settings.pageSize === 'fit') {
    pageWidth = physicalPage ? physicalPage.width : printWidth;
    pageHeight = physicalPage ? physicalPage.height : printHeight;
  } else {
    [pageWidth, pageHeight] = PDF_LAYOUT_PAGE_SIZES[settings.pageSize] || PDF_LAYOUT_PAGE_SIZES.a4;
  }
  let orientation = settings.orientation;
  if (orientation !== 'portrait' && orientation !== 'landscape') {
    orientation = settings.pageSize === 'fit'
      ? (pageWidth > pageHeight ? 'landscape' : 'portrait')
      : (width > height ? 'landscape' : 'portrait');
  }
  [pageWidth, pageHeight] = orientation === 'landscape'
    ? [Math.max(pageWidth, pageHeight), Math.min(pageWidth, pageHeight)]
    : [Math.min(pageWidth, pageHeight), Math.max(pageWidth, pageHeight)];
  if (pageWidth > PDF_MAX_PAGE_MM || pageHeight > PDF_MAX_PAGE_MM) {
    throw new Error('This page exceeds the PDF size limit. ' + (physicalPage
      ? 'Choose a standard page size.' : 'Choose a larger photo DPI or a standard page size.'));
  }
  const requestedMargin = Number(settings.margin);
  const margin = Math.min(Number.isFinite(requestedMargin) ? Math.max(0, requestedMargin) : 0,
    pageWidth * 0.4, pageHeight * 0.4);
  const availableWidth = pageWidth - margin * 2, availableHeight = pageHeight - margin * 2;
  let drawWidth, drawHeight, scaledDown = false, cropped = false, clip = null;
  if (settings.imgFit === 'actual') {
    const tooLarge = printWidth > availableWidth + 1e-8 || printHeight > availableHeight + 1e-8;
    const shrink = settings.oversize !== 'crop';
    const scale = tooLarge && shrink ? Math.min(availableWidth / printWidth, availableHeight / printHeight) : 1;
    drawWidth = printWidth * scale;
    drawHeight = printHeight * scale;
    scaledDown = tooLarge && shrink;
    cropped = tooLarge && !shrink;
    if (cropped) clip = { x: margin, y: margin, width: availableWidth, height: availableHeight };
  } else {
    const fill = settings.imgFit === 'fill';
    const scale = (fill ? Math.max : Math.min)(availableWidth / width, availableHeight / height);
    drawWidth = width * scale;
    drawHeight = height * scale;
    if (fill) {
      clip = { x: margin, y: margin, width: availableWidth, height: availableHeight };
      cropped = drawWidth > availableWidth + 1e-8 || drawHeight > availableHeight + 1e-8;
    }
  }
  return {
    page: { width: pageWidth, height: pageHeight, orientation: orientation === 'landscape' ? 'l' : 'p' },
    image: { x: margin + (availableWidth - drawWidth) / 2, y: margin + (availableHeight - drawHeight) / 2,
      width: drawWidth, height: drawHeight },
    clip, scaledDown, cropped
  };
}

function writePdfImage(pdf, rendered, layout) {
  const image = layout.image;
  if (layout.clip) pdf.saveGraphicsState();
  try {
    if (layout.clip) {
      const box = layout.clip;
      pdf.rect(box.x, box.y, box.width, box.height, null);
      pdf.clip();
      pdf.discardPath();
    }
    pdf.addImage(rendered.data, rendered.format, image.x, image.y, image.width, image.height, undefined, 'FAST');
  } finally {
    if (layout.clip) pdf.restoreGraphicsState();
  }
}
