// PDF.js is loaded only when importing a PDF. The parser, worker and rendering
// assets are bundled together; no CDN or older-parser fallback is used.
// Security advisory: https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq
(function () {
  'use strict';

  const PDFJS_VERSION = '6.3.289';
  const PACKAGE_URL = new URL('../vendor/pdfjs/', document.currentScript.src).href;
  const MODULE_URL = PACKAGE_URL + 'legacy/build/pdf.min.mjs';
  const WORKER_URL = PACKAGE_URL + 'legacy/build/pdf.worker.min.mjs';
  let libraryPromise = null;

  function loadPdfLibrary() {
    if (!libraryPromise) {
      libraryPromise = import(MODULE_URL).then(function (pdfjs) {
        if (pdfjs.version !== PDFJS_VERSION || typeof pdfjs.getDocument !== 'function') {
          throw new Error('The PDF library version does not match its worker.');
        }
        pdfjs.GlobalWorkerOptions.workerSrc = WORKER_URL;
        return pdfjs;
      }).catch(function (cause) {
        libraryPromise = null;
        const error = new Error('The local PDF tools could not load. Check that the complete app folder was uploaded, then reload this page.');
        error.name = 'PdfLibraryLoadError';
        error.cause = cause;
        throw error;
      });
    }
    return libraryPromise;
  }

  async function openPdfDocument(options, job) {
    const pdfjs = await loadPdfLibrary();
    const canceled = () => job && !job.isCurrent();
    const cancellationError = () => Object.assign(new Error('PDF import canceled.'), { name: 'ImportCanceledError' });
    if (canceled()) throw cancellationError();
    const parameters = Object.assign({}, options, {
      cMapUrl: PACKAGE_URL + 'cmaps/',
      cMapPacked: true,
      iccUrl: PACKAGE_URL + 'iccs/',
      standardFontDataUrl: PACKAGE_URL + 'standard_fonts/',
      wasmUrl: PACKAGE_URL + 'wasm/',
      isEvalSupported: false
    });

    // PDF.js transfers binary buffers to its worker. Preserve the caller's
    // bytes so a password retry can safely reopen the same file.
    if (parameters.data instanceof ArrayBuffer) {
      parameters.data = parameters.data.slice(0);
    } else if (ArrayBuffer.isView(parameters.data)) {
      parameters.data = new Uint8Array(parameters.data.buffer,
        parameters.data.byteOffset, parameters.data.byteLength).slice(0);
    }
    const loadingTask = pdfjs.getDocument(parameters);
    let destroyPromise = null;
    const destroyTask = () => {
      if (!destroyPromise) {
        try { destroyPromise = Promise.resolve(loadingTask.destroy()); }
        catch (error) { destroyPromise = Promise.reject(error); }
      }
      return destroyPromise;
    };
    const stop = job ? job.onCancel(() => { destroyTask().catch(() => {}); }) : null;
    try {
      const document = await loadingTask.promise;
      // PDF.js 6 moved teardown from PDFDocumentProxy to its loading task.
      // Keep the importer contract explicit and idempotent for that API.
      if (typeof document.destroy !== 'function') {
        Object.defineProperty(document, 'destroy', { value: destroyTask });
      }
      if (canceled()) {
        try { await document.destroy(); } catch (_) {}
        throw cancellationError();
      }
      return document;
    } catch (error) {
      // Failed/password-protected loads still own a worker and transport.
      try { await destroyTask(); } catch (_) { /* Keep the original PDF error. */ }
      throw error;
    } finally {
      if (stop) stop();
    }
  }

  window.PhotoPdfLibraries = Object.freeze({ openPdfDocument, pdfjsVersion: PDFJS_VERSION });
})();
