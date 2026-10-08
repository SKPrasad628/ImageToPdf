// One FIFO queue owns all imports. A selection's files and each PDF's pages
// stay together even when another picker/drop starts while decoding is pending.
let importGeneration = 0;
const importQueue = [];
let importRunnerActive = false;
let activeImportJob = null;
const importReports = new Map();
const MAX_IMPORT_SELECTION = 200;
const MAX_QUEUED_SELECTIONS = 10;
let importReportSequence = 0;

function hasPendingImports() {
  return importRunnerActive || activeImportJob !== null || importQueue.length > 0;
}

function notifyImportState() {
  // UI updates must not prevent a selection from settling or releasing files.
  try { if (typeof window !== 'undefined') window.PageForgeUI?.refresh(); } catch (_) {}
}

function getImportReport(target) {
  const report = importReports.get(target);
  return report ? { ...report, skipped: report.skipped.map(({ name, reason }) => ({ name, reason })) } : null;
}

function publishImportReport(job) {
  const report = { selected: job.selectedCount, imported: job.imported,
    canceled: !job.isCurrent(), cancellationReason: job.cancellationReason || '',
    sequence: job.reportSequence, skipped: job.skipped.map(({ name, reason }) => ({ name, reason })) };
  // A late older import must not erase a newer selection's rejection or result.
  const previous = importReports.get(job.target);
  if (previous && previous.sequence > report.sequence) return;
  importReports.set(job.target, report);
  if (typeof document === 'undefined') return;
  try {
    const panel = document.getElementById(job.target === 'edit' ? 'importReportEdit' : 'importReport');
    if (!panel) return;
    if (typeof panel.replaceChildren === 'function') panel.replaceChildren();
    else panel.textContent = '';
    panel.hidden = !report.skipped.length && !report.canceled;
    if (panel.hidden || typeof panel.appendChild !== 'function' || typeof document.createElement !== 'function') return;
    const heading = document.createElement('strong');
    heading.textContent = report.canceled
      ? report.cancellationReason || `Import canceled after ${report.imported} file(s) completed.`
      : `Imported ${report.imported} of ${report.selected} selected files.`;
    panel.appendChild(heading);
    if (report.skipped.length) {
      const list = document.createElement('ul');
      report.skipped.forEach(item => {
        const row = document.createElement('li');
        row.textContent = `${item.name}: ${item.reason}`;
        list.appendChild(row);
      });
      panel.appendChild(list);
    }
  } catch (_) {
    // A replaced/detached report surface must never prevent queue settlement.
    // The structured result remains available through getImportReport().
  }
}

function createImportJob(files, target) {
  const generation = importGeneration;
  const callbacks = new Set();
  let canceled = false;
  let settle;
  const promise = new Promise(resolve => { settle = resolve; });
  const job = {
    files, target, promise, settle, imported: 0, skipped: [],
    selectedCount: files.length, reportSequence: ++importReportSequence,
    isCurrent: () => !canceled && generation === importGeneration,
    reportIssue(file, reason) {
      if (!job.isCurrent()) return;
      const name = String(file && file.name || 'Unnamed file');
      // PDF import can provide a more specific reason before returning false.
      if (!job.skipped.some(item => item.file === file)) job.skipped.push({ name, reason: String(reason), file });
    },
    onCancel(callback) {
      if (!job.isCurrent()) {
        try { Promise.resolve(callback()).catch(() => {}); } catch (_) {}
        return () => {};
      }
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    cancel() {
      if (canceled) return;
      canceled = true;
      callbacks.forEach(callback => {
        try { Promise.resolve(callback()).catch(() => {}); } catch (_) {}
      });
      callbacks.clear();
    }
  };
  return job;
}

function cancelImports() {
  importGeneration++;
  if (activeImportJob) {
    activeImportJob.reportSequence = ++importReportSequence;
    activeImportJob.cancel();
    publishImportReport(activeImportJob);
    showPdfLoading(activeImportJob.target, false);
  }
  // Queued selections have not allocated any resources; settle them now.
  importQueue.splice(0).forEach(job => {
    job.reportSequence = ++importReportSequence;
    job.cancellationReason = `Queued import of ${job.selectedCount} file(s) canceled before it started.`;
    job.cancel(); publishImportReport(job); job.settle(false);
    job.files.length = 0; job.skipped.length = 0;
  });
}

async function importImageFile(file, job, classification) {
  const temporaryUrls = new Set();
  const ownUrl = url => {
    if (url && !temporaryUrls.has(url)) {
      temporaryUrls.add(url);
      retainUrl(url);
    }
    return url;
  };
  try {
    if (!job.isCurrent()) return false;
    const limits = typeof window !== 'undefined' && window.PhotoPdfLimits;
    if (limits) limits.assertPageCount(1, images.length);
    // Blob slicing changes only the declared media type, preserving source bytes.
    // This lets valid images with misleading MIME types reach the right decoder.
    const imageBlob = typeof file.slice === 'function'
      ? file.slice(0, file.size, classification.mime) : file;
    const allocated = URL.createObjectURL(imageBlob);
    try {
      if (limits) limits.trackUrl(allocated, file.size, classification.width, classification.height);
    } catch (error) {
      URL.revokeObjectURL(allocated);
      throw error;
    }
    const src = ownUrl(allocated);
    const decoded = await loadImage(src, job);
    if (!job.isCurrent()) return false;
    if (limits) limits.assertDecodedImage(decoded);
    const thumb = ownUrl(await generateThumb(src, decoded));
    if (!job.isCurrent()) return false;
    if (!thumb) throw new Error('The browser could not create an image thumbnail.');
    if (limits) limits.assertPageCount(1, images.length);
    const id = _imgId();
    putStore(id, { src, originalSrc: src, thumb });
    images.push({
      _id: id, _pageId: id, src, originalSrc: src, thumb,
      name: file.name, size: file.size,
      rotation: 0, flipH: false, flipV: false, filters: {}
    });
    snapshot('Add image');
    refreshAll();
    return true;
  } catch (error) {
    if (job.isCurrent()) {
      job.reportIssue(file, error && error.message || 'The browser could not decode this image.');
      showToast(`⚠️ Skipped "${file.name}": ${error && error.message || 'Unreadable image'}`);
    }
    return false;
  } finally {
    temporaryUrls.forEach(releaseUrl);
  }
}

async function runImportQueue() {
  if (importRunnerActive) return;
  importRunnerActive = true;
  notifyImportState();
  try {
    while (importQueue.length) {
      const job = importQueue.shift();
      activeImportJob = job;
      let imported = false;
      try {
        for (const file of job.files) {
          if (!job.isCurrent()) break;
          const intake = typeof window !== 'undefined' ? window.PhotoPdfFileIntake : globalThis.PhotoPdfFileIntake;
          if (!intake) throw new Error('The file reader is unavailable. Please reload the page.');
          const classification = await intake.classifyFile(file);
          if (!job.isCurrent()) break;
          if (classification.kind === 'unsupported') {
            job.reportIssue(file, classification.reason);
            showToast(`⚠️ Skipped "${file.name}": ${classification.reason}`);
            continue;
          }
          const limits = typeof window !== 'undefined' && window.PhotoPdfLimits;
          try { if (limits) limits.preflightFile(file, classification); }
          catch (error) {
            job.reportIssue(file, error && error.message || error);
            showToast(`⚠️ Skipped "${file.name}": ${error && error.message || error}`);
            continue;
          }
          const result = classification.kind === 'pdf'
            ? await loadPdfFile(file, job.target, job)
            : await importImageFile(file, job, classification);
          imported = imported || result;
          if (!job.isCurrent()) break;
          if (result) job.imported++;
          else job.reportIssue(file, 'The file could not be imported. It may be unreadable or unsupported by this browser.');
          // Give the browser a paint opportunity without starting another file.
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      } catch (error) {
        if (job.isCurrent()) {
          job.reportIssue({ name: 'Import' }, error && error.message || error);
          showToast(`⚠️ Import stopped: ${error && error.message || error}`);
        }
      } finally {
        publishImportReport(job);
        job.settle(imported && job.isCurrent());
        if (activeImportJob === job) activeImportJob = null;
        job.files.length = 0; job.skipped.length = 0;
      }
    }
  } finally {
    importRunnerActive = false;
    notifyImportState();
  }
}

function handleFiles(files, target) {
  const length = files && files.length;
  const rejectSelection = reason => {
    const job = createImportJob([], target);
    job.selectedCount = Number.isSafeInteger(length) && length >= 0 ? length : 0;
    job.reportIssue({ name: 'Selection' }, reason);
    publishImportReport(job); showToast(`⚠️ ${reason}`);
    job.settle(false);
    return job.promise;
  };
  if (!Number.isSafeInteger(length) || length < 0) {
    return rejectSelection('The file selection could not be read. Choose files using the picker or a file drop.');
  }
  if (!length) return Promise.resolve(false);
  // Check before copying the FileList so rejected selections retain no File array.
  if (length > MAX_IMPORT_SELECTION) {
    return rejectSelection(`Select at most ${MAX_IMPORT_SELECTION} files at once. This entire selection was skipped.`);
  }
  if (importQueue.length >= MAX_QUEUED_SELECTIONS) {
    return rejectSelection(`At most ${MAX_QUEUED_SELECTIONS} selections can wait to import. Wait for the current imports to finish or cancel them first. This selection was skipped.`);
  }
  // The picker/drop's order is the default page order. Never sort by filename,
  // size, or decode completion; later selections append after this selection.
  const selected = Array.from({ length }, (_, index) => files[index]);
  if (selected.some(file => !file)) return rejectSelection('The file selection could not be read. Choose the files again.');
  if (!selected.length) return Promise.resolve(false);
  const job = createImportJob(selected, target);
  importQueue.push(job);
  runImportQueue();
  return job.promise;
}
