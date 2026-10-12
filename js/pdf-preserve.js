// Native PDF pages are exported from source PDF objects, never from previews.
// An untouched whole document uses its exact bytes, including signatures and
// encryption. Rewriting PDF objects cannot make that same fidelity promise.
(function () {
  'use strict';
  const LIBRARY_VERSION = '1.17.1';
  const LIBRARY_URL = new URL('../vendor/pdf-lib/pdf-lib.esm.min.mjs', document.currentScript.src).href;
  const POINTS_PER_MM = 72 / 25.4;
  let libraryPromise = null;

  function preservationError(message, cause) {
    const error = new Error(message);
    error.name = 'PdfPreservationError';
    if (cause) error.cause = cause;
    return error;
  }

  async function loadLibrary() {
    if (!libraryPromise) {
      libraryPromise = import(LIBRARY_URL).then(library => {
        if (!library.PDFDocument || typeof library.PDFDocument.load !== 'function' ||
            typeof library.PDFDocument.create !== 'function' ||
            typeof library.degrees !== 'function' || !library.PDFName) {
          throw new Error('The PDF preservation library is incomplete.');
        }
        return library;
      }).catch(error => {
        libraryPromise = null;
        throw preservationError('The local PDF preservation tools could not load. Check that the complete app folder was uploaded, then reload this page.', error);
      });
    }
    return libraryPromise;
  }

  function copyBytes(bytes) {
    if (bytes instanceof Uint8Array) return new Uint8Array(bytes);
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0));
    throw preservationError('The original PDF bytes are unavailable. Import that PDF again.');
  }

  function rotationOf(image) {
    const rotation = image.rotation === undefined ? 0 : Number(image.rotation);
    if (!Number.isFinite(rotation) || rotation % 90 !== 0) {
      throw preservationError('Native PDF pages support rotations in 90° steps. Choose Images for other transformations.');
    }
    return ((rotation % 360) + 360) % 360;
  }

  function sourceFor(image, sources, getSource) {
    const descriptor = image.pdfSource;
    if (!descriptor || typeof descriptor.sourceId !== 'string' ||
        !Number.isInteger(descriptor.pageIndex) || descriptor.pageIndex < 0) {
      throw preservationError('A native PDF page has lost its source reference. Import that PDF again.');
    }
    if (image.flipH || image.flipV || Object.keys(image.filters || {}).length) {
      throw preservationError('A transformed PDF page cannot be exported as native content. Save its edits or choose Images.');
    }
    if (!sources.has(descriptor.sourceId)) {
      const record = getSource(descriptor.sourceId);
      if (!record || !Number.isInteger(record.numPages) || record.numPages < 1) {
        throw preservationError('The original PDF source is unavailable. Import that PDF again.');
      }
      // Own an isolated byte copy before any await or progress callback.
      sources.set(descriptor.sourceId, { ...record, bytes: copyBytes(record.bytes) });
    }
    const source = sources.get(descriptor.sourceId);
    if (descriptor.pageIndex >= source.numPages) {
      throw preservationError('A native PDF page refers to a missing source page. Import that PDF again.');
    }
    rotationOf(image);
    return source;
  }

  async function loadSource(library, source) {
    try {
      // ignoreEncryption is deliberately never used: it does not decrypt data.
      const document = await library.PDFDocument.load(new Uint8Array(source.bytes), { updateMetadata: false });
      if (document.getPageCount() !== source.numPages) {
        throw new Error('The source page count differs from the imported document.');
      }
      return document;
    } catch (error) {
      if (error && (error.name === 'EncryptedPDFError' || /encrypted/i.test(error.message || ''))) {
        throw preservationError(`“${source.name || 'This PDF'}” is encrypted. Only its untouched full document can preserve native content. Choose Images to export modified pages.`, error);
      }
      throw preservationError(`Could not preserve native content from “${source.name || 'this PDF'}”. Import it again or choose Images.`, error);
    }
  }

  async function addImagePage(document, image, options, library, existingPage) {
    if (typeof options.prepareImage !== 'function' || typeof options.computeLayout !== 'function') {
      throw preservationError('The image export helpers are unavailable. Please reload the page.');
    }
    const rendered = await options.prepareImage(image, options.imageOptions || {});
    if (!rendered) throw preservationError(`Could not decode “${image.name || 'this image'}”. No incomplete PDF was exported.`);
    const layout = options.computeLayout(image, rendered, options.settings || {});
    const page = existingPage || document.addPage([layout.page.width * POINTS_PER_MM, layout.page.height * POINTS_PER_MM]);
    if (existingPage) page.setSize(layout.page.width * POINTS_PER_MM, layout.page.height * POINTS_PER_MM);
    const embedded = rendered.format === 'PNG'
      ? await document.embedPng(rendered.data) : await document.embedJpg(rendered.data);
    if (layout.clip) {
      const box = layout.clip;
      page.pushOperators(library.pushGraphicsState(),
        library.rectangle(box.x * POINTS_PER_MM,
          (layout.page.height - box.y - box.height) * POINTS_PER_MM,
          box.width * POINTS_PER_MM, box.height * POINTS_PER_MM),
        library.clip(), library.endPath());
    }
    try {
      const box = layout.image;
      page.drawImage(embedded, {
        x: box.x * POINTS_PER_MM,
        y: (layout.page.height - box.y - box.height) * POINTS_PER_MM,
        width: box.width * POINTS_PER_MM, height: box.height * POINTS_PER_MM
      });
    } finally {
      if (layout.clip) page.pushOperators(library.popGraphicsState());
    }
    return layout;
  }

  async function prepareStructurePreservingPdf(inputImages, options = {}) {
    if (!Array.isArray(inputImages) || !inputImages.length) {
      throw preservationError('Add at least one page before exporting.');
    }
    const images = inputImages.map(image => ({ ...image,
      filters: { ...(image.filters || {}) }, pdfSource: image.pdfSource ? { ...image.pdfSource } : undefined,
      originalPdfSource: image.originalPdfSource ? { ...image.originalPdfSource } : undefined }));
    const sources = new Map();
    const getSource = options.getSource || (() => undefined);
    for (const image of images) if (image.pdfSource) sourceFor(image, sources, getSource);
    // A raster-edited page still belongs to its source document. Retain that
    // document's attachments and check signatures even if no native page remains.
    for (const image of images) if (image.originalPdfSource) sourceFor({ ...image,
      pdfSource: image.originalPdfSource, rotation: 0, flipH: false, flipV: false, filters: {} }, sources, getSource);
    const nativePages = images.filter(image => image.pdfSource).length;
    const imagePages = images.length - nativePages;
    const singleSource = nativePages === images.length && sources.size === 1;
    const source = singleSource ? sources.values().next().value : null;
    const exactOriginal = singleSource && images.length === source.numPages &&
      images.every((image, index) => image.pdfSource.pageIndex === index && rotationOf(image) === 0);
    const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    progress(0, images.length);
    if (exactOriginal) {
      progress(images.length, images.length);
      return { bytes: source.bytes, exactOriginal: true, nativePages, imagePages,
        scaledDownPages: 0, croppedPages: 0,
        notice: 'Original PDF bytes preserved exactly, including existing forms, links, bookmarks, tags, signatures and encryption.' };
    }

    const library = await loadLibrary();
    const loadedSources = new Map();
    // Validate all sources before staging output, then copy the connected graph
    // with one shared reference map per source and independent duplicate maps.
    for (const [id, item] of sources) {
      loadedSources.set(id, { name: item.name || 'This PDF', document: await loadSource(library, item) });
    }
    const core = window.PhotoPdfNativeCore;
    if (!core) throw preservationError('The PDF structure tools are incomplete. Reload the complete app folder.');
    const plan = await core.create(library, loadedSources, images, preservationError);
    const document = plan.document;

    let scaledDownPages = 0, croppedPages = 0;
    for (let index = 0; index < images.length; index++) {
      const image = images[index];
      if (image.pdfSource) {
        const page = plan.entries[index].page;
        const rotation = plan.entries[index].sourcePage.getRotation().angle + rotationOf(image);
        page.setRotation(library.degrees(((rotation % 360) + 360) % 360));
      } else {
        const layout = await addImagePage(document, image, options, library, plan.entries[index].page);
        if (layout.scaledDown) scaledDownPages++;
        if (layout.cropped) croppedPages++;
      }
      progress(index + 1, images.length);
    }
    // Image/font embedders reserve references and materialize them on flush.
    // Validate only after those objects exist, before returning any bytes.
    await document.flush();
    const report = core.finalize(plan);
    const bytes = await document.save({ updateFieldAppearances: false, addDefaultPage: false });
    return { bytes, exactOriginal: false, nativePages, imagePages, scaledDownPages, croppedPages,
      adjustments: report.adjustments.slice(),
      notice: 'Native PDF content retained with rebuilt forms, bookmarks, links, attachments and supported accessibility structure where present. Signed and encrypted PDFs require untouched export; known unsafe or unsupported structures block native changes.' +
        (imagePages ? ' Image-edited PDF pages and photos contain image content.' : '') +
        (report.adjustments.length ? ' Changes: ' + report.adjustments.join(' ') : '') };
  }

  window.PhotoPdfPreservation = Object.freeze({
    pdfLibVersion: LIBRARY_VERSION,
    prepareStructurePreservingPdf
  });
})();
