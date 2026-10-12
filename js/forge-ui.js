// Page Forge chrome and page actions. Processing remains in the existing engine.
(function () {
  'use strict';
  const byId = id => document.getElementById(id);
  let lastDownload = null;
  let latestReport = null;
  let documentSignature = '', settingsSignature = '';
  let outputDocumentRevision = 0, outputSettingsRevision = 0;
  let selectionMode = false;
  let workspaceView = 'preview';
  const viewPanels = { pages: 'pagesPanel', preview: 'previewPanel', layout: 'settingsMountConvert' };
  const phone = window.matchMedia('(max-width: 680px)');

  function refreshWorkspaceViews() {
    const workspace = byId('forgeWorkspace');
    if (workspace) workspace.dataset.view = workspaceView;
    document.querySelectorAll('[data-workspace-view]').forEach(tab => {
      const selected = tab.dataset.workspaceView === workspaceView;
      tab.setAttribute('aria-selected', String(selected));
      tab.setAttribute('tabindex', selected ? '0' : '-1');
    });
    Object.entries(viewPanels).forEach(([view, id]) => {
      const panel = byId(id);
      if (!panel) return;
      panel.setAttribute('role', phone.matches ? 'tabpanel' : 'region');
      panel.inert = !!(phone.matches && view !== workspaceView);
    });
  }

  function refreshLayoutSummary() {
    const nativeOnly = images.length > 0 && byId('pdfContentMode')?.value !== 'images' &&
      images.every(image => image.pdfSource);
    const controls = byId('imageLayoutControls');
    if (controls) controls.hidden = nativeOnly;
    const scope = byId('layoutScope');
    if (scope) scope.textContent = nativeOnly ? 'PDF pages keep their saved sizes and rotation.' : 'Applies to all image pages';
    const pageSize = byId('pageSize')?.value || 'a4';
    const fit = byId('imgFit')?.value || 'contain';
    const print = pageSize === 'fit' || fit === 'actual';
    const advanced = byId('advancedBinding');
    if (advanced) {
      const wasHidden = advanced.hidden;
      advanced.hidden = nativeOnly || !print;
      if (print && wasHidden && !nativeOnly) advanced.open = true;
    }
    const overflow = byId('printOverflowControls');
    if (overflow) overflow.hidden = fit !== 'actual';
    const summary = byId('layoutSummary');
    if (summary) {
      const orientation = byId('orientation')?.value || 'auto';
      const placement = { contain: 'Full image', fill: 'Fill page', actual: 'Photo print size' }[fit] || 'Full image';
      summary.textContent = nativeOnly ? 'Original PDF page sizes · Native content' :
        `${pageSize === 'fit' ? 'Fit to image' : pageSize.toUpperCase()} · ${orientation === 'auto' ? 'Auto orientation' : orientation === 'portrait' ? 'Portrait' : 'Landscape'} · ${byId('margin')?.value || '0'} mm margins · ${placement}`;
    }
  }

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
        const omitted = lastDownload.report.skipped || [];
        if (omitted.length) {
          status.textContent += '\nPages not included in the previous PDF:\n' + omitted.map(page =>
            `Page ${page.position}: ${page.name} — ${page.reason}`).join('\n');
          status.textContent += '\nTo include these pages, continue editing, replace or re-add the listed files, then forge the PDF again.';
        }
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
    const adjustment = has ? images[index].importAdjustment : null;
    const adjustmentNote = byId('pageImportAdjustment');
    if (adjustmentNote) {
      adjustmentNote.hidden = !adjustment;
      adjustmentNote.textContent = adjustment
        ? `Auto-fitted on import: ${adjustment.sourceWidth} × ${adjustment.sourceHeight} → ${adjustment.width} × ${adjustment.height} pixels. Original-quality export keeps this working detail.` : '';
    }
    const importing = typeof hasPendingImports === 'function' && hasPendingImports();
    const importStatus = byId('importOrderStatus');
    if (importStatus) {
      importStatus.hidden = !importing;
      importStatus.textContent = importing
        ? 'Adding files in upload order… Forge PDF will be ready when all selected files finish loading.' : '';
    }
    byId('imgGrid')?.setAttribute('aria-busy', String(importing));
    if (byId('documentPageUnit')) byId('documentPageUnit').textContent = images.length === 1 ? 'page' : 'pages';
    if (!has) selectionMode = false;
    else if (selectedSet.size) selectionMode = true;
    document.body.classList.toggle('selection-mode', selectionMode);
    if (byId('selectionToolbar')) byId('selectionToolbar').hidden = !selectionMode;
    if (byId('selectionStartBtn')) {
      byId('selectionStartBtn').hidden = selectionMode;
      byId('selectionStartBtn').setAttribute('aria-expanded', String(selectionMode));
    }
    if (byId('selInfo') && selectionMode) byId('selInfo').textContent = `${selectedSet.size} selected`;
    if (byId('removeSelectionBtn')) byId('removeSelectionBtn').disabled = !selectedSet.size;
    if (byId('activePagePosition')) byId('activePagePosition').textContent = has ? `Page ${index + 1} of ${images.length}` : 'No pages';
    refreshLayoutSummary();
    refreshWorkspaceViews();
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
    if (rotate) {
      rotate.textContent = selectedSet.size ? `Rotate ${selectedSet.size} selected 90°` : 'Rotate selected 90°';
      rotate.disabled = !selectedSet.size;
    }
    const margin = byId('margin');
    document.querySelectorAll('[data-margin]').forEach(button => {
      button.disabled = margin.disabled;
      button.setAttribute('aria-pressed', String(Number(button.dataset.margin) === Number(margin.value)));
    });
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
      lastDownload.report = { status: report.status, exportedPages: report.exportedPages, requestedPages: report.requestedPages,
        skipped: (report.skipped || []).map(page => ({ position: page.position, name: String(page.name), reason: String(page.reason) })) };
    }
    if (!report && !exportInProgress) forgetDownload();
    refreshDownloadState();
  }

  window.setForgeActive = function (index) {
    if (!Number.isInteger(index) || !images[index]) return;
    selectedConvertCard = index;
    updateSelectionUI();
  };
  window.activateForgePage = function (index) {
    if (!Number.isInteger(index) || !images[index]) return;
    window.setForgeActive(index);
    if (phone.matches && !selectionMode) window.setForgeWorkspaceView('preview');
  };
  window.setForgeWorkspaceView = function (view, focus = true) {
    if (!Object.hasOwn(viewPanels, view)) return;
    workspaceView = view;
    if (view === 'layout' && byId('bindingOptions')) byId('bindingOptions').open = true;
    refreshWorkspaceViews();
    window.PageForgePreview?.refresh();
    if (focus) {
      if (phone.matches) {
        document.querySelector(`[data-workspace-view="${view}"]`)?.focus({ preventScroll: true });
        byId('workspaceViews')?.scrollIntoView({ behavior: motionBehavior(), block: 'start' });
      }
      else byId(viewPanels[view])?.focus();
    }
  };
  window.startForgeSelection = function () {
    if (!images.length) return;
    selectionMode = true;
    window.setForgeWorkspaceView('pages', false);
    refresh();
    document.querySelector('[data-select-page]')?.focus();
  };
  window.finishForgeSelection = function () {
    selectionMode = false;
    selectedSet.clear();
    window.setForgeWorkspaceView('pages', false);
    updateSelectionUI();
    byId('selectionStartBtn')?.focus();
  };
  window.rotateForgeSelection = function () {
    if (selectedSet.size) rotateAll(90);
  };
  window.removeForgeSelection = function () {
    const targets = [...selectedSet].filter(index => images[index]).sort((a, b) => b - a);
    if (!targets.length) return;
    const selection = captureSelection();
    targets.forEach(index => images.splice(index, 1));
    restoreSelection(selection);
    snapshot('Remove selected pages');
    refreshAll();
    if (images.length) byId('selectionDoneBtn')?.focus();
    else byId('undoBtn')?.focus();
    showToast(`Removed ${targets.length} page${targets.length === 1 ? '' : 's'}. Undo to restore.`);
  };
  window.deleteForgePage = function () {
    const index = activeIndex();
    if (index === null) return;
    removeImage(index);
    if (images.length) byId('previewPanel')?.focus();
    else byId('undoBtn')?.focus();
  };
  window.showForgeShortcuts = function () {
    toggleHints(true);
    byId('kbdHints')?.scrollIntoView({ behavior: motionBehavior(), block: 'nearest' });
  };
  window.toggleForgeSelection = function (index, checked) {
    if (!Number.isInteger(index) || !images[index]) return;
    if (checked) selectedSet.add(index); else selectedSet.delete(index);
    updateSelectionUI();
  };
  window.editForgePage = () => { const index = activeIndex(); if (index !== null) openEditorFor(index); };
  window.rotateForgePage = () => { const index = activeIndex(); if (index !== null) quickRotateCard(index); };
  window.duplicateForgePage = () => { const index = activeIndex(); if (index !== null) duplicateImage(index); };
  function focusActivePage() {
    if (phone.matches && workspaceView !== 'pages') byId(viewPanels[workspaceView])?.focus();
    else focusConvertPage(activeIndex());
  }
  window.moveForgePage = direction => {
    const index = activeIndex();
    if (index === null) return;
    movePage(index, direction);
    const current = activeIndex();
    focusActivePage();
    showToast(`Page moved to position ${current + 1}.`);
  };
  window.viewForgePage = () => {
    const index = activeIndex();
    if (index === null) return;
    const menu = byId('pageActionsMenu');
    // The menu closes when its action runs. Restore the dialog to its visible
    // summary, rather than a menu item that will be hidden on close.
    if (menu?.open) menu.querySelector?.('summary')?.focus();
    openLightbox(index);
  };
  window.setForgeMargin = margin => {
    const input = byId('margin');
    if (input.disabled) return;
    input.value = String(margin);
    updateSummary();
    saveSettings();
  };
  window.openForgeDialog = id => {
    const dialog = byId(id);
    if (!dialog || typeof dialog.showModal !== 'function') return;
    const menu = byId('helpMenu');
    // Native dialogs remember their focused trigger. Help items disappear when
    // their menu closes, so give the browser its persistent summary instead.
    if (menu?.open) {
      menu.open = false;
      menu.querySelector?.('summary')?.focus();
    }
    dialog.showModal();
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
    if (phone.matches) { window.setForgeWorkspaceView('pages'); return; }
    window.setForgeWorkspaceView('pages', false);
    focusConvertPage(activeIndex());
    byId('toolbar')?.scrollIntoView({ behavior: motionBehavior(), block: 'start' });
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
  phone.addEventListener?.('change', () => {
    refreshWorkspaceViews();
    const activePanel = document.activeElement?.closest?.('#pagesPanel, #previewPanel, #settingsMountConvert');
    if (phone.matches && activePanel && activePanel.id !== viewPanels[workspaceView]) window.setForgeWorkspaceView(workspaceView);
  });
  byId('workspaceViews')?.addEventListener('keydown', event => {
    const views = Object.keys(viewPanels);
    const tab = event.target.closest?.('[data-workspace-view]');
    if (!tab) return;
    let index = views.indexOf(tab.dataset.workspaceView);
    if (event.key === 'ArrowRight') index = (index + 1) % views.length;
    else if (event.key === 'ArrowLeft') index = (index + views.length - 1) % views.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = views.length - 1;
    else return;
    event.preventDefault();
    window.setForgeWorkspaceView(views[index]);
  });
  ['moreMenu', 'pageActionsMenu', 'helpMenu'].forEach(id => {
    const menu = byId(id);
    menu?.addEventListener('click', event => {
      if (!event.target.closest?.('button')) return;
      menu.open = false;
      // Preserve native dialog focus and focus explicitly restored by actions.
      if (!window.PageForgeUI?.isDialogOpen() &&
          (document.activeElement === event.target || menu.contains?.(document.activeElement))) menu.querySelector?.('summary')?.focus();
    });
    menu?.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !menu.open) return;
      event.preventDefault();
      menu.open = false;
      menu.querySelector?.('summary')?.focus();
    });
  });
  window.PageForgeUI = Object.freeze({ refresh, rememberDownload, reportChanged, forgetDownload,
    captureExportState, makeDownloadRoom, isSelecting: () => selectionMode, focusActivePage,
    isDialogOpen: () => ['toolsDialog', 'aboutDialog', 'privacyDialog'].some(id => byId(id)?.open === true) });
  window.addEventListener('pagehide', forgetDownload);
  refresh();
})();
