// Import one PDF as a transaction: failed pages never enter the document or
// undo history, and every temporary render resource has a matching cleanup.
async function loadPdfFile(file, target, job) {
  let pdfDoc = null;
  let sourceBytes = null;
  let renderTask = null;
  let destroyPromise = null;
  const limits = window.PhotoPdfLimits;
  const pendingSource = {};
  const isCurrent = () => !job || job.isCurrent();
  const checkCurrent = () => {
    if (!isCurrent()) {
      const error = new Error('Import canceled.');
      error.name = 'ImportCanceledError';
      throw error;
    }
  };
  const destroyDocument = () => {
    if (!pdfDoc) return Promise.resolve();
    if (!destroyPromise) {
      destroyPromise = Promise.resolve().then(() => pdfDoc.destroy()).catch(() => {});
    }
    return destroyPromise;
  };
  const unsubscribe = job ? job.onCancel(() => {
    if (renderTask && typeof renderTask.cancel === 'function') {
      try { renderTask.cancel(); } catch (_) {}
    }
    return destroyDocument();
  }) : () => {};
  const stagedPages = [];
  const temporaryUrls = new Set();
  const ownUrl = url => {
    if (!temporaryUrls.has(url)) {
      temporaryUrls.add(url);
      retainUrl(url);
    }
    return url;
  };

  try {
    checkCurrent();
    if (limits) {
      limits.assertFileBytes(file, 'pdf');
      limits.reserveBytes(pendingSource, file.size);
    }
    showPdfLoading(target, true, `Loading "${file.name}"…`, 'Reading file…', 0);
    const pdfLoader = window.PhotoPdfLibraries;
    if (!pdfLoader || typeof pdfLoader.openPdfDocument !== 'function') {
      throw new Error('The PDF loader is unavailable. Please reload the page.');
    }

    // Each attempt reads fresh bytes because PDF.js can transfer its buffer.
    try {
      const data = await file.arrayBuffer();
      sourceBytes = data;
      checkCurrent();
      pdfDoc = await pdfLoader.openPdfDocument({ data }, job);
      checkCurrent();
    } catch (error) {
      checkCurrent();
      if (!error || error.name !== 'PasswordException') throw error;
      for (let attempt = 0; attempt < 3; attempt++) {
        const password = prompt(attempt === 0
          ? `"${file.name}" is password-protected. Enter the password:`
          : `Incorrect password — ${3 - attempt} attempt(s) left:`);
        if (password === null) return false;
        try {
          const data = await file.arrayBuffer();
          checkCurrent();
          pdfDoc = await pdfLoader.openPdfDocument({ data, password }, job);
          checkCurrent();
          break;
        } catch (retryError) {
          checkCurrent();
          if (!retryError || retryError.name !== 'PasswordException') throw retryError;
        }
      }
      if (!pdfDoc) throw new Error('Incorrect password.');
    }

    const totalPages = pdfDoc.numPages;
    if (!Number.isInteger(totalPages) || totalPages < 1) {
      throw new Error('The PDF contains no readable pages.');
    }
    if (limits) limits.assertPageCount(totalPages, images.length);
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      showPdfLoading(target, true, `Rendering "${file.name}"`,
        `Page ${pageNum} of ${totalPages}`, Math.round((pageNum - 1) / totalPages * 100));
      await new Promise(resolve => setTimeout(resolve, 0));
      checkCurrent();

      let page = null;
      let canvas = null;
      try {
        page = await pdfDoc.getPage(pageNum);
        checkCurrent();
        const base = page.getViewport({ scale: 1 });
        if (!Number.isFinite(base.width) || base.width <= 0 ||
            !Number.isFinite(base.height) || base.height <= 0) {
          throw new Error(`Page ${pageNum} has invalid dimensions.`);
        }
        // PDF.js includes the page rotation and UserUnit in this viewport.
        // Keep physical size separate from the chosen raster rendering scale.
        const pdfPageSizeMm = {
          width: base.width * (25.4 / 72),
          height: base.height * (25.4 / 72)
        };
        if (pdfPageSizeMm.width <= 0 || pdfPageSizeMm.height <= 0) {
          throw new Error(`Page ${pageNum} has invalid dimensions.`);
        }
        const plan = limits ? limits.pdfRenderSize(base.width, base.height)
          : { scale: Math.min(2.0, 2400 / Math.max(base.width, base.height)) };
        const viewport = page.getViewport({ scale: plan.scale });
        if (!Number.isFinite(viewport.width) || viewport.width <= 0 ||
            !Number.isFinite(viewport.height) || viewport.height <= 0 ||
            viewport.width > 2400 + 1e-7 || viewport.height > 2400 + 1e-7) {
          throw new Error(`Page ${pageNum} exceeds the 2,400-pixel preview limit.`);
        }
        const renderWidth = Math.max(1, Math.floor(Math.min(2400, viewport.width)));
        const renderHeight = Math.max(1, Math.floor(Math.min(2400, viewport.height)));
        if (limits) limits.assertRaster(renderWidth, renderHeight, 'PDF preview');
        canvas = document.createElement('canvas');
        canvas.width = renderWidth;
        canvas.height = renderHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('The browser could not create a PDF render canvas.');
        // PDF paper is white, but the working raster stays lossless.
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
        renderTask = null;
        checkCurrent();
        const { url } = await canvasToUrl(canvas, undefined, 'image/png');
        if (!url) throw new Error('The browser could not encode a PDF page.');
        const src = ownUrl(url);
        checkCurrent();
        const thumb = ownUrl(await generateThumb(src));
        checkCurrent();
        if (!thumb) throw new Error('The browser could not create a PDF page thumbnail.');
        const id = _imgId();
        stagedPages.push({
          _id: id, _pageId: id, src, originalSrc: src, thumb,
          name: totalPages === 1 ? file.name : `${file.name} – p${pageNum}`,
          size: file.size, rotation: 0, flipH: false, flipV: false, filters: {},
          pdfPageSizeMm, originalPdfPageSizeMm: { ...pdfPageSizeMm }
        });
      } finally {
        renderTask = null;
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        if (page) {
          try { page.cleanup(); } catch (_) { /* Preserve the load/render error. */ }
        }
      }
    }

    // Nothing is published until all page rendering and thumbnail work succeeds.
    checkCurrent();
    if (limits) limits.assertPageCount(stagedPages.length, images.length);
    const sourceId = registerPdfSource({ bytes: sourceBytes, name: file.name, numPages: totalPages });
    stagedPages.forEach((entry, pageIndex) => {
      entry.pdfSource = { sourceId, pageIndex };
      entry.originalPdfSource = { sourceId, pageIndex };
    });
    const firstDocument = images.length === 0;
    stagedPages.forEach(entry => putStore(entry._id, {
      src: entry.src, originalSrc: entry.originalSrc, thumb: entry.thumb
    }));
    stagedPages.forEach(entry => images.push(entry));
    if (firstDocument) {
      document.getElementById('pageSize').value = 'fit';
      document.getElementById('orientation').value = 'auto';
      document.getElementById('margin').value = 0;
      updateSummary();
    }
    snapshot(`Load PDF "${file.name}"`);
    refreshAll();
    return true;
  } catch (error) {
    if (isCurrent() && job && job.reportIssue) job.reportIssue(file, error && error.message || 'Could not read this PDF.');
    if (isCurrent()) alert(`Could not import "${file.name}".\n\n${error && error.message || error}`);
    return false;
  } finally {
    await destroyDocument();
    unsubscribe();
    temporaryUrls.forEach(releaseUrl);
    if (limits) limits.releaseBytes(pendingSource);
    showPdfLoading(target, false);
  }
}
