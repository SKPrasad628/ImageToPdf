// Page Forge chrome and page actions. Processing remains in the existing engine.
(function () {
  'use strict';
  const byId = id => document.getElementById(id);
  let lastDownload = null;
  let latestReport = null;
  let documentSignature = '', settingsSignature = '';
  let outputDocumentRevision = 0, outputSettingsRevision = 0;

  // Track only output-affecting state. Preview focus, checked pages, and freeing
  // undo history do not change the PDF. This small snapshot retains no bytes.
  function captureExportState() {
    const nextDocument = JSON.stringify(images.map(image => ({
      page: image._pageId || image._id, src: image.src,
      rotation: ((image.rotation || 0) % 360 + 360) % 360,
      flipH: !!image.flipH, flipV: !!image.flipV,
      filters: Object.keys(image.filters || {}).sort().map(key => [key, image.filters[key]]),
      pdfSource: image.pdfSource, pdfPageSizeMm: image.pdfPageSizeMm
    })));
    const nextSettings = JSON.stringify({
      values: ['pageSize', 'orientation', 'imgFit', 'margin', 'printDpi', 'oversize', 'pdfContentMode', 'filename']
        .map(id => byId(id)?.value || ''),
      preserveOriginalQuality, quality: preserveOriginalQuality ? null : byId('quality')?.value
    });
    if (nextDocument !== documentSignature) { documentSignature = nextDocument; outputDocumentRevision++; }
    if (nextSettings !== settingsSignature) { settingsSignature = nextSettings; outputSettingsRevision++; }
    return Object.freeze({ documentRevision: outputDocumentRevision, settingsRevision: outputSettingsRevision });
  }

  function refreshDownloadState() {
    const state = captureExportState();
    const stale = !!lastDownload && (lastDownload.state.documentRevision !== state.documentRevision ||
      lastDownload.state.settingsRevision !== state.settingsRevision);
    const previous = stale || exportInProgress || latestReport?.status === 'failed';
    const result = byId('forgeResult');
    if (result) {
      result.hidden = !latestReport && !lastDownload;
      result.dataset.status = latestReport?.status || (lastDownload ? 'previous' : '');
      result.dataset.stale = String(stale);
    }
    const success = byId('successMsg');
    if (success) success.classList.toggle('on', !!lastDownload && !exportInProgress &&
      latestReport?.status !== 'failed');
    const button = byId('downloadAgainBtn');
    if (button) {
      button.hidden = !lastDownload;
      button.textContent = previous ? 'Download previous PDF' : 'Download PDF';
    }
    const status = byId('exportFreshnessStatus');
    if (status) {
      status.hidden = !lastDownload || !previous;
      status.textContent = stale ? 'Changes since export — forge again'
        : exportInProgress ? 'Forging a new PDF — the previous download is still available.'
          : latestReport?.status === 'failed' ? 'Latest export failed — the previous PDF is still available.' : '';
      if (previous && lastDownload?.report?.status === 'partial') {
        status.textContent += ` Previous PDF is partial (${lastDownload.report.exportedPages} of ${lastDownload.report.requestedPages} pages).`;
      }
    }
  }

  function activeIndex() {
    return Number.isInteger(selectedConvertCard) && images[selectedConvertCard]
      ? selectedConvertCard : (images.length ? 0 : null);
  }

  function refresh() {
    const index = activeIndex();
    const has = index !== null;
    const importing = typeof hasPendingImports === 'function' && hasPendingImports();
    const importStatus = byId('importOrderStatus');
    if (importStatus) {
      importStatus.hidden = !importing;
      importStatus.textContent = importing
        ? 'Adding files in upload order… Forge PDF will be ready when all selected files finish loading.' : '';
    }
    byId('imgGrid')?.setAttribute('aria-busy', String(importing));
    if (byId('documentPageUnit')) byId('documentPageUnit').textContent = images.length === 1 ? 'page' : 'pages';
    document.querySelectorAll('[data-workspace-link]').forEach(link => {
      link.setAttribute('href', has ? '#forgeWorkspace' : '#dropZone');
    });
    document.querySelectorAll('[data-page-action]').forEach(button => {
      const action = button.dataset.pageAction;
      button.disabled = !has || (action === 'earlier' && index === 0) ||
        (action === 'later' && index === images.length - 1);
    });
    if (byId('toolsEditBtn')) byId('toolsEditBtn').disabled = !has;
    const rotate = byId('rotateSelectionBtn');
    if (rotate) rotate.textContent = selectedSet.size ? `Rotate ${selectedSet.size} selected 90°` : 'Rotate all 90°';
    const margin = byId('margin');
    document.querySelectorAll('[data-margin]').forEach(button => {
      button.disabled = margin.disabled;
      button.setAttribute('aria-pressed', String(Number(button.dataset.margin) === Number(margin.value)));
    });
    const advanced = byId('advancedBinding');
    if (advanced && (byId('pageSize').value === 'fit' || byId('imgFit').value === 'actual')) advanced.open = true;
    const group = byId('pdfContentGroup');
    if (group) group.hidden = !images.some(image => image.pdfSource || image.originalPdfSource);
    const hint = byId('qualityModeHint');
    if (hint) hint.textContent = preserveOriginalQuality
      ? 'Keeps current image detail without added lossy compression.'
      : 'For lossless output of current image detail, use Preserve original quality beside Forge PDF.';
    const lossless = byId('qualityLosslessStatus');
    if (lossless) {
      lossless.hidden = !preserveOriginalQuality;
      lossless.textContent = 'Original quality — lossless export';
    }
    const compression = byId('qualityCompressionControls');
    if (compression) compression.hidden = preserveOriginalQuality;
    document.querySelectorAll('[data-document-action]').forEach(button => { button.disabled = !has; });
    ['convertBtn', 'editExportBtn'].forEach(id => {
      if (byId(id)) byId(id).disabled = !has || importing || exportInProgress;
    });
    refreshDownloadState();
  }

  function forgetDownload() {
    if (!lastDownload) return;
    const previous = lastDownload;
    lastDownload = null;
    URL.revokeObjectURL(previous.url);
    previous.release();
    const button = byId('downloadAgainBtn');
    if (button) button.hidden = true;
    refreshDownloadState();
  }

  // Takes ownership of the already-budgeted output URL only after its download
  // succeeds. A new attempt can keep the previous file through a failure;
  // replacing it, resetting the document, or leaving releases it.
  function rememberDownload(url, filename, release, state) {
    forgetDownload();
    lastDownload = { url, filename, release, state: state || captureExportState() };
    refreshDownloadState();
    return true;
  }

  // Retained downloads share the existing 128 MB reservation. Keep the older
  // output whenever both fit; only evict it when the new output needs its space.
  function makeDownloadRoom(bytes) {
    const limits = window.PhotoPdfLimits;
    if (lastDownload && limits && bytes > limits.limits.maxOutputBytes - limits.stats().downloadBytes) {
      limits.assertOutputBytes(bytes);
      forgetDownload();
    }
  }

  function reportChanged(report) {
    latestReport = report;
    if (lastDownload && report && report.status !== 'failed' && Number.isInteger(report.exportedPages) &&
      Number.isInteger(report.requestedPages)) {
      lastDownload.report = { status: report.status, exportedPages: report.exportedPages, requestedPages: report.requestedPages };
    }
    if (!report && !exportInProgress) forgetDownload();
    refreshDownloadState();
  }

  window.setForgeActive = function (index) {
    if (!Number.isInteger(index) || !images[index]) return;
    selectedConvertCard = index;
    updateSelectionUI();
  };
  window.toggleForgeSelection = function (index, checked) {
    if (!Number.isInteger(index) || !images[index]) return;
    if (checked) selectedSet.add(index); else selectedSet.delete(index);
    updateSelectionUI();
  };
  window.editForgePage = () => { const index = activeIndex(); if (index !== null) openEditorFor(index); };
  window.rotateForgePage = () => { const index = activeIndex(); if (index !== null) quickRotateCard(index); };
  window.duplicateForgePage = () => { const index = activeIndex(); if (index !== null) duplicateImage(index); };
  window.moveForgePage = direction => {
    const index = activeIndex();
    if (index === null) return;
    movePage(index, direction);
    const current = activeIndex();
    focusConvertPage(current);
    showToast(`Page moved to position ${current + 1}.`);
  };
  window.viewForgePage = () => { const index = activeIndex(); if (index !== null) openLightbox(index); };
  window.setForgeMargin = margin => {
    const input = byId('margin');
    if (input.disabled) return;
    input.value = String(margin);
    updateSummary();
    saveSettings();
  };
  window.openForgeDialog = id => {
    const dialog = byId(id);
    if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
  };
  window.downloadLastForge = () => {
    if (!lastDownload) return;
    const link = document.createElement('a');
    link.href = lastDownload.url;
    link.download = lastDownload.filename;
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); }
  };
  window.returnToForgePages = () => {
    if (!images.length) { byId('fileInput').focus(); return; }
    byId('forgeWorkspace').scrollIntoView({ behavior: motionBehavior(), block: 'start' });
    focusConvertPage(activeIndex());
  };
  window.startAnotherForge = () => {
    clearAll();
    if (images.length) return; // The user canceled Clear document.
    publishExportReport(null);
    byId('fileInput').focus();
    byId('dropZone').scrollIntoView({ behavior: motionBehavior(), block: 'center' });
  };
  function motionBehavior() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
  }

  // Keep native typing and validation; show numeric changes in the paper preview.
  ['margin', 'printDpi', 'filename'].forEach(id => byId(id)?.addEventListener('input', () => {
    window.PageForgePreview?.refresh();
    refresh();
  }));
  ['toolsDialog', 'aboutDialog', 'privacyDialog'].map(byId).filter(Boolean).forEach(dialog => {
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  });
  const compact = window.matchMedia('(max-width: 900px)');
  const setBindingMode = event => { if (byId('bindingOptions')) byId('bindingOptions').open = !event.matches; };
  setBindingMode(compact);
  compact.addEventListener?.('change', setBindingMode);
  const more = byId('moreMenu');
  more?.addEventListener('click', event => {
    if (event.target.closest?.('button')) {
      more.open = false;
      more.querySelector?.('summary')?.focus();
    }
  });
  more?.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !more.open) return;
    event.preventDefault();
    more.open = false;
    more.querySelector?.('summary')?.focus();
  });
  window.PageForgeUI = Object.freeze({ refresh, rememberDownload, reportChanged, forgetDownload,
    captureExportState, makeDownloadRoom,
    isDialogOpen: () => ['toolsDialog', 'aboutDialog', 'privacyDialog'].some(id => byId(id)?.open === true) });
  window.addEventListener('pagehide', forgetDownload);
  refresh();
})();
