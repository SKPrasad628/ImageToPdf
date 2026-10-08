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

  function materializeInheritedPageEntries(page, library) {
    // Moving a page away from its original parent tree must not lose inherited
    // resources, paper boxes, or rotation (PDF 32000, inheritable page entries).
    for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      const name = library.PDFName.of(key);
      const value = page.node.getInheritableAttribute(name);
      if (!page.node.get(name) && value) page.node.set(name, value);
    }
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

  async function addImagePage(document, image, options, library) {
    if (typeof options.prepareImage !== 'function' || typeof options.computeLayout !== 'function') {
      throw preservationError('The image export helpers are unavailable. Please reload the page.');
    }
    const rendered = await options.prepareImage(image, options.imageOptions || {});
    if (!rendered) throw preservationError(`Could not decode “${image.name || 'this image'}”. No incomplete PDF was exported.`);
    const layout = options.computeLayout(image, rendered, options.settings || {});
    const page = document.addPage([layout.page.width * POINTS_PER_MM, layout.page.height * POINTS_PER_MM]);
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
      filters: { ...(image.filters || {}) }, pdfSource: image.pdfSource ? { ...image.pdfSource } : undefined }));
    const sources = new Map();
    const getSource = options.getSource || (() => undefined);
    for (const image of images) if (image.pdfSource) sourceFor(image, sources, getSource);
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
    let document;
    let selectedPages = null;
    const loadedSources = new Map();
    if (singleSource) {
      document = await loadSource(library, source);
      const originals = document.getPages().slice();
      const seenIndices = new Set();
      selectedPages = [];
      for (const image of images) {
        const index = image.pdfSource.pageIndex;
        let page = originals[index];
        if (seenIndices.has(index)) {
          // Separate copy calls give each duplicated page its own page object.
          [page] = await document.copyPages(document, [index]);
        } else {
          seenIndices.add(index);
          materializeInheritedPageEntries(page, library);
        }
        selectedPages.push({ page, rotation: page.getRotation().angle + rotationOf(image) });
      }
      for (let index = document.getPageCount() - 1; index >= 0; index--) document.removePage(index);
    } else {
      document = await library.PDFDocument.create();
      // Validate every native source before staging any output pages.
      for (const [id, item] of sources) loadedSources.set(id, await loadSource(library, item));
    }

    let scaledDownPages = 0, croppedPages = 0;
    for (let index = 0; index < images.length; index++) {
      const image = images[index];
      if (image.pdfSource) {
        let page, rotation;
        if (singleSource) ({ page, rotation } = selectedPages[index]);
        else {
          [page] = await document.copyPages(loadedSources.get(image.pdfSource.sourceId), [image.pdfSource.pageIndex]);
          rotation = page.getRotation().angle + rotationOf(image);
        }
        page.setRotation(library.degrees(((rotation % 360) + 360) % 360));
        document.addPage(page);
      } else {
        const layout = await addImagePage(document, image, options, library);
        if (layout.scaledDown) scaledDownPages++;
        if (layout.cropped) croppedPages++;
      }
      progress(index + 1, images.length);
    }
    const bytes = await document.save({ updateFieldAppearances: false, addDefaultPage: false });
    return { bytes, exactOriginal: false, nativePages, imagePages, scaledDownPages, croppedPages,
      notice: singleSource
        ? 'Native PDF text, vectors and page objects retained. Changes invalidate digital signatures; forms, bookmarks, internal links and accessibility tags may no longer work correctly after page changes.'
        : 'Native PDF text and vectors retained on unedited pages. Merging does not preserve document-level forms, bookmarks, accessibility tags or signatures reliably; some links and annotations may not work. Edited PDF pages are exported as images.' };
  }

  window.PhotoPdfPreservation = Object.freeze({
    pdfLibVersion: LIBRARY_VERSION,
    prepareStructurePreservingPdf
  });
})();
