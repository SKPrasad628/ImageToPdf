// ══════════════════════════════════════
//  STATE
// ══════════════════════════════════════
let images = []; // {src, name, size, rotation, flipH, flipV, filters, originalSrc}
let editingIndex = null;
let selectedPdfPage = null;
let currentTab = 'convert';
let documentRevision = 0;
let preserveOriginalQuality = false;
let exportInProgress = false;
const pdfSources = new Map();
let pdfSourceCounter = 0;

function registerPdfSource(source) {
  const id = 'pdf_' + (++pdfSourceCounter);
  const limits = window.PhotoPdfLimits;
  if (limits) limits.reserveBytes(id, source.bytes.byteLength);
  try {
    pdfSources.set(id, { name: source.name, numPages: source.numPages,
      bytes: new Uint8Array(source.bytes).slice() });
  } catch (error) {
    if (limits) limits.releaseBytes(id);
    throw error;
  }
  return id;
}
function copyPdfSource(source) {
  return source ? { sourceId: source.sourceId, pageIndex: source.pageIndex } : undefined;
}
function prunePdfSources() {
  const live = new Set();
  const collect = entries => entries.forEach(image => {
    if (image.pdfSource) live.add(image.pdfSource.sourceId);
    if (image.originalPdfSource) live.add(image.originalPdfSource.sourceId);
  });
  collect(images);
  history.forEach(state => { try { collect(JSON.parse(state)); } catch (_) {} });
  for (const id of pdfSources.keys()) if (!live.has(id)) {
    pdfSources.delete(id);
    if (window.PhotoPdfLimits) window.PhotoPdfLimits.releaseBytes(id);
  }
}

// ── UNDO/REDO HISTORY ──
// We store only lightweight metadata (no base64 src/originalSrc/thumb) in history.
// The actual pixel data lives in imgStore keyed by a stable imgId.
let history = [];
let historyIndex = -1;
let undoLabels = [];
let imgStore = {}; // imgId -> {src, originalSrc, thumb}
let _imgIdCounter = 0;
const MAX_HISTORY = 20; // cap to avoid OOM on mobile

function _imgId() { return 'img_' + (++_imgIdCounter); }

// ── BLOB-BACKED PIXEL STORAGE ──────────────────────────────────────────────
// Pixels are held as Blobs referenced by object URLs, not base64 data URLs.
// Base64 is ~33% larger than the bytes it encodes and lives as an immovable JS
// string; a Blob stays in the browser's own storage and can be paged out. Every
// consumer just sees a URL string, so `img.src = entry.src` works unchanged.
//
// Object URLs must be revoked or they leak for the page's lifetime, but the same
// URL can be shared (duplicating a page copies the store entry), so they're
// refcounted rather than revoked on first release.
const _urlRefs = new Map();
function isBlobUrl(u) { return typeof u === 'string' && u.startsWith('blob:'); }
function retainUrl(u) {
  if (isBlobUrl(u) || (typeof u === 'string' && u.startsWith('data:'))) _urlRefs.set(u, (_urlRefs.get(u) || 0) + 1);
  return u;
}
function releaseUrl(u) {
  if (!isBlobUrl(u) && !(typeof u === 'string' && u.startsWith('data:'))) return;
  const n = (_urlRefs.get(u) || 0) - 1;
  if (n > 0) { _urlRefs.set(u, n); return; }
  _urlRefs.delete(u);
  forgetImage(u);
  if (window.PhotoPdfLimits) window.PhotoPdfLimits.forgetUrl(u);
  if (isBlobUrl(u)) URL.revokeObjectURL(u);
}
const STORE_URL_KEYS = ['src', 'originalSrc', 'thumb'];
// Always write to imgStore through this so the refcounts stay honest.
function putStore(id, entry) {
  const prev = imgStore[id];
  STORE_URL_KEYS.forEach(k => retainUrl(entry[k]));
  imgStore[id] = entry;
  if (prev) STORE_URL_KEYS.forEach(k => releaseUrl(prev[k]));
  return entry;
}
function dropStore(id) {
  const e = imgStore[id];
  if (!e) return;
  delete imgStore[id];
  STORE_URL_KEYS.forEach(k => releaseUrl(e[k]));
}

// Encode a canvas straight to a Blob URL, skipping the base64 round trip.
function canvasToUrl(cvs, quality, type = 'image/jpeg') {
  return new Promise((resolve, reject) => {
    const limits = typeof window !== 'undefined' ? window.PhotoPdfLimits : null;
    if (limits) limits.assertRaster(cvs.width, cvs.height, 'Working image');
    cvs.toBlob(blob => {
      try {
        if (!blob) {
          const url = cvs.toDataURL(type, quality);
          if (!url || url === 'data:,') throw new Error('The image could not be encoded');
          if (limits) limits.trackUrl(url, url.length * 2, cvs.width, cvs.height);
          resolve({ url, bytes: url.length * 2 });
          return;
        }
        const url = URL.createObjectURL(blob);
        try { if (limits) limits.trackUrl(url, blob.size, cvs.width, cvs.height); }
        catch (error) { URL.revokeObjectURL(url); throw error; }
        resolve({ url, bytes: blob.size });
      } catch (error) { reject(error); }
    }, type, quality);
  });
}

// Decoding a multi-megabyte data URL costs tens of ms. The editor re-decodes the
// same source on every filter tick / resize keystroke, so keep the last few
// decoded bitmaps around. Small cap: these hold full-resolution pixel data.
const _imgCache = new Map();
const _imageDecodes = new Map();
function loadImage(src, job) {
  if (job && !job.isCurrent()) {
    return Promise.reject(Object.assign(new Error('Image import canceled.'), { name: 'ImportCanceledError' }));
  }
  const hit = _imgCache.get(src);
  if (hit) { _imgCache.delete(src); _imgCache.set(src, hit); return Promise.resolve(hit); }
  if (_imageDecodes.has(src)) return _imageDecodes.get(src);
  const decode = () => new Promise((resolve, reject) => {
    const im = new Image();
    let stop = null, settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      if (stop) stop();
      im.onload = im.onerror = null;
      if (error) reject(error); else resolve(value);
    };
    im.onload = () => {
      if (settled) return;
      if (job && !job.isCurrent()) {
        finish(null, Object.assign(new Error('Image import canceled.'), { name: 'ImportCanceledError' }));
        return;
      }
      try {
        if (window.PhotoPdfLimits) window.PhotoPdfLimits.cacheAdmit(_imgCache, src, im);
        else {
          if (_imgCache.size >= 3) _imgCache.clear();
          _imgCache.set(src, im);
        }
      } catch (error) { finish(null, error); im.src = ''; return; }
      finish(im);
    };
    im.onerror = () => finish(null, new Error('Image failed to decode'));
    if (job) {
      stop = job.onCancel(() => {
        finish(null, Object.assign(new Error('Image import canceled.'), { name: 'ImportCanceledError' }));
        im.src = '';
      });
      if (!job.isCurrent()) return;
    }
    im.src = src;
  });
  const pending = window.PhotoPdfLimits ? window.PhotoPdfLimits.enqueueDecode(decode, job) : decode();
  _imageDecodes.set(src, pending);
  pending.then(() => _imageDecodes.delete(src), () => _imageDecodes.delete(src));
  return pending;
}
function forgetImage(src) { _imgCache.delete(src); }

// JPEG quality for the final export, chosen by the user.
function exportQuality() {
  const v = parseFloat((document.getElementById('quality') || {}).value);
  return isFinite(v) ? v : 0.85;
}
// Filenames are user data interpolated into innerHTML — a quote or angle
// bracket would otherwise break the card markup (or worse).
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _lightImages() {
  // Snapshot only the non-pixel metadata
  return images.map(img => ({
    _id: img._id,
    _pageId: pageIdentity(img),
    name: img.name, size: img.size,
    pdfPageSizeMm: copyPdfPageSize(img.pdfPageSizeMm),
    originalPdfPageSizeMm: copyPdfPageSize(img.originalPdfPageSizeMm),
    pdfSource: copyPdfSource(img.pdfSource),
    originalPdfSource: copyPdfSource(img.originalPdfSource),
    rotation: img.rotation, flipH: img.flipH, flipV: img.flipV,
    filters: {...(img.filters||{})}
  }));
}

function _restoreImages(light) {
  return light.map(meta => {
    const stored = imgStore[meta._id] || {};
    return { ...meta, src: stored.src, originalSrc: stored.originalSrc, thumb: stored.thumb };
  });
}

// Pixel data outlives the images that referenced it: entries stay in imgStore
// after a delete (so undo can restore them) but were never reclaimed once the
// snapshot holding the last reference fell off the end of the history.
function pruneImgStore() {
  const live = new Set(images.map(i => i._id));
  history.forEach(h => {
    try { JSON.parse(h).forEach(m => live.add(m._id)); } catch(e) {}
  });
  let freed = 0;
  Object.keys(imgStore).forEach(id => {
    if (!live.has(id)) { dropStore(id); freed++; } // also revokes the object URLs
  });
  prunePdfSources();
  return freed;
}

function snapshot(label) {
  documentRevision++;
  clearNativeCardDrag();
  // Truncating the redo branch and trimming the tail both orphan pixel data.
  const truncated = history.length > historyIndex + 1;
  history = history.slice(0, historyIndex + 1);
  undoLabels = undoLabels.slice(0, historyIndex + 1);
  history.push(JSON.stringify(_lightImages()));
  undoLabels.push(label || 'Action');
  // Cap history size — drop oldest entries
  let trimmed = false;
  if (history.length > MAX_HISTORY) {
    history.shift();
    undoLabels.shift();
    trimmed = true;
  }
  historyIndex = history.length - 1;
  if (truncated || trimmed) pruneImgStore();
  updateUndoUI();
}

function undo() {
  cancelImports();
  if (historyIndex <= 0) return;
  const selection = captureSelection();
  documentRevision++;
  clearNativeCardDrag();
  historyIndex--;
  images = _restoreImages(JSON.parse(history[historyIndex]));
  restoreSelection(selection);
  refreshAll();
  showToast('↩ Undid: ' + (undoLabels[historyIndex + 1] || 'action'));
  updateUndoUI();
}

function redo() {
  cancelImports();
  if (historyIndex >= history.length - 1) return;
  const selection = captureSelection();
  documentRevision++;
  clearNativeCardDrag();
  historyIndex++;
  images = _restoreImages(JSON.parse(history[historyIndex]));
  restoreSelection(selection);
  refreshAll();
  showToast('↪ Redid: ' + (undoLabels[historyIndex] || 'action'));
  updateUndoUI();
}

function updateUndoUI() {
  const bar = document.getElementById('undoBar');
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  const lbl = document.getElementById('undoLabel');
  bar.classList.toggle('on', images.length > 0 || historyIndex > 0);
  undoBtn.disabled = historyIndex <= 0;
  redoBtn.disabled = historyIndex >= history.length - 1;
  const discard = document.getElementById('discardHistoryBtn');
  if (discard) discard.disabled = history.length <= 1;
  if (historyIndex > 0) lbl.textContent = undoLabels[historyIndex] || '';
  else lbl.textContent = '';
}

function discardUndoHistory() {
  if (!confirm('Discard Undo and Redo history to free old edits? Your current pages will be kept.')) return;
  documentRevision++;
  clearNativeCardDrag();
  history = [JSON.stringify(_lightImages())];
  historyIndex = 0;
  undoLabels = ['Current document'];
  pruneImgStore();
  updateUndoUI();
  showToast('✓ Undo history cleared; current pages kept');
}

// Logical page identity survives edited pixel versions and undo. Duplicates
// receive their own identity, even when their source URLs are shared.
function pageIdentity(image) { return image ? image._pageId || image._id : null; }
function captureSelection() {
  return {
    convert: pageIdentity(images[selectedConvertCard]),
    pdf: pageIdentity(images[selectedPdfPage]),
    multiple: [...selectedSet].map(i => pageIdentity(images[i])).filter(Boolean)
  };
}
function restoreSelection(selection) {
  const indices = new Map(images.map((image, i) => [pageIdentity(image), i]));
  selectedConvertCard = indices.has(selection.convert) ? indices.get(selection.convert) : null;
  selectedPdfPage = indices.has(selection.pdf) ? indices.get(selection.pdf) : null;
  selectedSet = new Set(selection.multiple.filter(id => indices.has(id)).map(id => indices.get(id)));
}
function changeImageOrder(from, to, label = 'Reorder') {
  if (!Number.isInteger(from) || !Number.isInteger(to) || !images[from] ||
      to < 0 || to >= images.length || from === to) return;
  const selection = captureSelection();
  const [image] = images.splice(from, 1);
  images.splice(to, 0, image);
  restoreSelection(selection);
  snapshot(label);
  refreshAll();
}
function clearPdfPreview() {
  pdfDetailRequest++;
  document.getElementById('detailPreview').innerHTML = '<span style="color:var(--muted);font-size:.8rem">Select a page</span>';
  document.getElementById('detailActions').style.display = 'none';
}
function refreshAll() {
  if (!Number.isInteger(selectedPdfPage) || !images[selectedPdfPage]) selectedPdfPage = null;
  if (!Number.isInteger(selectedConvertCard) || !images[selectedConvertCard]) selectedConvertCard = null;
  selectedSet = new Set([...selectedSet].filter(i => Number.isInteger(i) && images[i]));
  if (currentTab === 'convert') render();
  else renderPdfEditor();
  if (currentTab === 'edit') {
    if (selectedPdfPage !== null) selectPdfPage(selectedPdfPage);
    else clearPdfPreview();
    suggestFilename();
    updateSummary();
  }
}

// ── DARK MODE ──
function toggleDark() {
  const dark = document.body.classList.toggle('dark');
  document.getElementById('darkToggle').textContent = dark ? '☀️' : '🌙';
  try { localStorage.setItem('photopdf-dark', dark ? '1' : '0'); } catch(e) {}
}
(function() {
  try {
    if (localStorage.getItem('photopdf-dark') === '1') {
      document.body.classList.add('dark');
      document.getElementById('darkToggle').textContent = '☀️';
    }
  } catch(e) {}
})();

// Strip characters Windows/macOS reject in filenames, plus path separators.
function sanitizeFilename(name) {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .trim()
    .replace(/(?:\.pdf\s*)+$/i, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
    .replace(/(?:\.pdf\s*)+$/i, '')
    .trim();
  return cleaned || 'my-photos';
}

// Guard against losing an arranged document to an accidental tab close.
window.addEventListener('beforeunload', e => {
  if (images.length) { e.preventDefault(); e.returnValue = ''; }
});

// ── PERSISTED SETTINGS ──
// Personal use means the same export settings nearly every time; re-picking
// them each session is pure friction. Dark mode already persisted — this
// extends the same idea to the settings bar.
const SETTING_IDS = ['pageSize','orientation','imgFit','margin','quality','filename','printDpi','oversize','pdfContentMode'];
function saveSettings() {
  try {
    const o = {};
    SETTING_IDS.forEach(id => { const el = document.getElementById(id); if (el) o[id] = el.value; });
    o.preserveOriginalQuality = preserveOriginalQuality;
    localStorage.setItem('photopdf-settings', JSON.stringify(o));
  } catch(e) {}
}
function restoreSettings() {
  try {
    const o = JSON.parse(localStorage.getItem('photopdf-settings') || '{}');
    preserveOriginalQuality = o.preserveOriginalQuality === true;
    SETTING_IDS.forEach(id => {
      // Filename is derived per-document instead of restored verbatim.
      if (id === 'filename' || o[id] === undefined) return;
      const el = document.getElementById(id);
      if (el) el.value = o[id];
    });
  } catch(e) {}
}

function updatePreserveQualityUI() {
  const button = document.getElementById('preserveQualityBtn');
  if (button) button.setAttribute('aria-pressed', String(preserveOriginalQuality));
  const state = document.getElementById('preserveQualityState');
  if (state) state.textContent = preserveOriginalQuality ? 'On' : 'Off';
  const quality = document.getElementById('quality');
  if (quality) quality.disabled = preserveOriginalQuality;
}

function togglePreserveQuality() {
  preserveOriginalQuality = !preserveOriginalQuality;
  updatePreserveQualityUI();
  saveSettings();
  updateSummary();
}

// ── KEYBOARD HINT BAR ──
function toggleHints(show) {
  document.body.classList.toggle('hints-off', !show);
  try { localStorage.setItem('photopdf-hints', show ? '1' : '0'); } catch(e) {}
}

// Collapse the first-run furniture once there's a document to work on.
function updateChrome() {
  document.body.classList.toggle('has-doc', images.length > 0);
}

// Derive a filename from the content instead of leaving "my-photos" forever.
function suggestFilename() {
  const el = document.getElementById('filename');
  if (!el || el.dataset.touched === '1') return; // never override manual input
  if (!images.length) { el.value = 'my-photos'; return; }
  const first = images[0].name.replace(/\.[^.]+$/, '').replace(/\s*[–-]\s*p\d+$/, '');
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  el.value = sanitizeFilename(images.length === 1 ? first : `${first}-${stamp}`);
}

// ── TOAST ──
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}

// editor state
let editorRotation = 0;
let editorFlipH = false, editorFlipV = false;
let editorFilters = {};
let editorOriginalSrc = null;
let editorCurrentSrc = null;
let cropDragging = false, cropStart = {x:0,y:0}, cropRect = {x:0,y:0,w:0,h:0};

// ══════════════════════════════════════
//  TAB SWITCHING
// ══════════════════════════════════════
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelector(`.tab[onclick="switchTab('${tab}')"]`).classList.add('active');
  document.getElementById('page-' + tab).classList.add('active');
  // Both views edit one document — carry the single export-settings bar across.
  const sb = document.getElementById('settingsBar');
  const mount = document.getElementById(tab === 'convert' ? 'settingsMountConvert' : 'settingsMountEdit');
  if (sb && mount && sb.parentElement !== mount) mount.appendChild(sb);
  if (sb) sb.classList.toggle('on', images.length > 0);
  refreshAll();
}

// ══════════════════════════════════════
//  FILE HANDLING
// ══════════════════════════════════════
const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const pdfFileInput = document.getElementById('pdfFileInput');
const pdfDropZone = document.getElementById('pdfDropZone');

// Reset .value after handling: without it, picking the same file twice in a row
// fires no change event and appears to do nothing. handleFiles() copies the
// FileList synchronously, so clearing it here is safe.
fileInput.addEventListener('change', e => { handleFiles(e.target.files, 'convert'); e.target.value = ''; });
pdfFileInput.addEventListener('change', e => { handleFiles(e.target.files, 'edit'); e.target.value = ''; });

[dropZone, pdfDropZone].forEach(dz => {
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('over');
    const mode = dz === dropZone ? 'convert' : 'edit';
    handleFiles(e.dataTransfer.files, mode);
  });
});

// Accept a drop anywhere on the window, not just on the drop zone — once the
// zone is collapsed it's a small target, and aiming at it is busywork.
window.addEventListener('dragover', e => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
});
window.addEventListener('drop', e => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  if (e.target.closest('.drop-zone')) return; // the zone's own handler has it
  e.preventDefault();
  handleFiles(e.dataTransfer.files, currentTab === 'edit' ? 'edit' : 'convert');
});

// Generate a small thumbnail (max 320px) as a Blob URL. Grid and page-list
// rendering use this rather than the full image, so it stays cheap at scale.
// `preloaded` lets callers that already decoded the image skip a second decode.
async function generateThumb(fullSrc, preloaded) {
  let img = preloaded;
  // A failed thumbnail must not put a full-resolution image in every grid slot.
  if (!img) img = await loadImage(fullSrc);
  if (typeof window !== 'undefined' && window.PhotoPdfLimits) window.PhotoPdfLimits.assertDecodedImage(img);
  const MAX = 320;
  const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const cvs = document.createElement('canvas');
  cvs.width = w; cvs.height = h;
  try {
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // JPEG has no alpha
    ctx.drawImage(img, 0, 0, w, h);
    const { url } = await canvasToUrl(cvs, 0.7);
    return url;
  } finally {
    cvs.width = 0; cvs.height = 0; // also free backing memory on failure
  }
}

function handleMergeFiles(files) {
  handleFiles(files, 'edit');
  showToast('Merging pages…');
  const el = document.getElementById('mergePdfInput');
  if (el) el.value = ''; // allow re-picking the same file
}

function showPdfLoading(tab, show, label, sub, pct) {
  const id = tab === 'convert' ? 'pdfLoading' : 'pdfLoadingEdit';
  const el = document.getElementById(id);
  el.classList.toggle('on', show);
  if (show) {
    document.getElementById(tab === 'convert' ? 'pdfLoadingLbl' : 'pdfLoadingEditLbl').textContent = label || 'Loading PDF…';
    document.getElementById(tab === 'convert' ? 'pdfLoadingSub' : 'pdfLoadingEditSub').textContent = sub || '';
    document.getElementById(tab === 'convert' ? 'pdfProgFill' : 'pdfProgFillEdit').style.width = (pct || 0) + '%';
  }
}

// ══════════════════════════════════════
//  CONVERT PAGE RENDER
// ══════════════════════════════════════
let dragSrcIdx = null;
// Native dragging has its own state: hold dragging must never leave a source
// behind for a later file drop to use. A rebuilt grid also cancels that drag.
let nativeCardDrag = null;
let convertGridRender = 0;
function clearNativeCardDrag() {
  if (nativeCardDrag) nativeCardDrag.card.classList.remove('dragging');
  nativeCardDrag = null;
  document.querySelectorAll('.img-card').forEach(card => card.classList.remove('drag-over'));
}
function isFileDrag(event) {
  return !!event.dataTransfer && (Array.from(event.dataTransfer.types || []).includes('Files') ||
    !!event.dataTransfer.files?.length);
}
// hold-to-drag state for convert grid
let holdTimer = null;
let holdCard = null;
let ghostEl = null;
let holdActive = false;

function render() {
  clearNativeCardDrag();
  const renderVersion = ++convertGridRender;
  const grid = document.getElementById('imgGrid');
  grid.innerHTML = '';
  images.forEach((img, i) => {
    const card = document.createElement('div');
    card.className = 'img-card' + (selectedConvertCard === i ? ' selected' : '');
    card.dataset.i = i;
    const cardIdentity = pageIdentity(img);

    const rotLabel = img.rotation ? `<div class="rotation-badge">${img.rotation}°</div>` : '';
    const displaySrc = img.thumb || img.src;
    const label = esc(img.name);
    // The thumb box is 3:4, so a 90°/270° turn leaves the image no longer
    // covering it. Scale by the box's aspect ratio to keep it filled.
    const rot = ((img.rotation % 360) + 360) % 360;
    const coverScale = (rot === 90 || rot === 270) ? (4/3) : 1;
    card.innerHTML = `
      <div class="img-thumb-wrap">
        <img src="${displaySrc}" alt="${label}" style="transform:rotate(${img.rotation}deg) scale(${coverScale}) scaleX(${img.flipH?-1:1}) scaleY(${img.flipV?-1:1})">
        ${rotLabel}
        <div class="img-overlay">
          <button class="ov-btn" title="View full size" aria-label="View ${label} full size" onclick="openLightbox(${i})">🔍</button>
          <button class="ov-btn" title="Edit" aria-label="Edit ${label}" onclick="openEditorFor(${i})">✏️</button>
          <button class="ov-btn" title="Rotate 90°" aria-label="Rotate ${label} 90 degrees" onclick="quickRotateCard(${i})">↻</button>
          <button class="ov-btn" title="Duplicate" aria-label="Duplicate ${label}" onclick="duplicateImage(${i})">⧉</button>
        </div>
      </div>
      <div class="img-footer">
        <span class="img-num">#${i+1}</span>
        <button class="img-del" title="Remove" aria-label="Remove ${label}" onclick="removeImage(${i})">✕</button>
      </div>
      <div class="img-name" title="${esc(img.name)}">${esc(img.name)}</div>`;

    // Click to select. Ctrl/Cmd toggles one, Shift extends a range — so a batch
    // of scans can be picked without clicking each card's controls.
    card.addEventListener('click', (e) => {
      if (e.target.closest('.ov-btn') || e.target.closest('.img-del')) return;
      if (e.ctrlKey || e.metaKey) {
        selectedSet.has(i) ? selectedSet.delete(i) : selectedSet.add(i);
      } else if (e.shiftKey && Number.isInteger(selectedConvertCard)) {
        const [lo,hi] = [selectedConvertCard, i].sort((a,b)=>a-b);
        for (let k=lo;k<=hi;k++) selectedSet.add(k);
      } else {
        selectedSet.clear();
      }
      selectedConvertCard = i;
      updateSelectionUI();
    });

    // Hold-to-drag (mousedown hold 200ms) — mouse
    card.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ov-btn') || e.target.closest('.img-del') || e.button !== 0) return;
      holdTimer = setTimeout(() => {
        holdActive = true;
        holdCard = card;
        dragSrcIdx = i;
        card.classList.add('hold-active');
        createGhost(card, e);
        document.addEventListener('mousemove', onHoldMove);
        document.addEventListener('mouseup', onHoldEnd);
      }, 200);
    });
    card.addEventListener('mouseup', () => clearTimeout(holdTimer));
    card.addEventListener('mouseleave', () => { if (!holdActive) clearTimeout(holdTimer); });

    // Hold-to-drag — touch (500ms hold before drag activates, scroll if released sooner)
    card.addEventListener('touchstart', (e) => {
      if (e.target.closest('.ov-btn') || e.target.closest('.img-del')) return;
      const touch = e.touches[0];
      holdTimer = setTimeout(() => {
        holdActive = true;
        holdCard = card;
        dragSrcIdx = i;
        card.classList.add('hold-active');
        createGhost(card, { clientX: touch.clientX, clientY: touch.clientY });
        document.addEventListener('touchmove', onTouchHoldMove, { passive: false });
        document.addEventListener('touchend', onTouchHoldEnd);
        document.addEventListener('touchcancel', onTouchHoldEnd);
      }, 450);
    }, { passive: true });
    card.addEventListener('touchend',    () => clearTimeout(holdTimer));
    card.addEventListener('touchcancel', () => clearTimeout(holdTimer));

    // Standard drag-drop fallback
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      // Native HTML5 drag beat the 200ms hold timer; without cancelling it the
      // hold would fire mid-drag and spawn a second ghost on top.
      clearTimeout(holdTimer);
      if (holdActive) { e.preventDefault(); return; }
      clearNativeCardDrag();
      if (renderVersion !== convertGridRender || card.parentElement !== grid ||
          pageIdentity(images[i]) !== cardIdentity) { e.preventDefault(); return; }
      nativeCardDrag = { identity: cardIdentity, revision: documentRevision, renderVersion, card };
      card.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-photopdf-page', cardIdentity);
      }
    });
    card.addEventListener('dragend', clearNativeCardDrag);
    card.addEventListener('dragover', e => {
      if (isFileDrag(e)) { clearNativeCardDrag(); return; }
      if (!nativeCardDrag || nativeCardDrag.revision !== documentRevision ||
          nativeCardDrag.renderVersion !== renderVersion || renderVersion !== convertGridRender) {
        clearNativeCardDrag(); return;
      }
      e.preventDefault(); card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', e => {
      // Leave external files to the window's single import handler.
      if (isFileDrag(e)) { clearNativeCardDrag(); return; }
      const drag = nativeCardDrag;
      clearNativeCardDrag();
      if (!drag || drag.revision !== documentRevision || drag.renderVersion !== renderVersion ||
          renderVersion !== convertGridRender || card.parentElement !== grid ||
          drag.card.parentElement !== grid || pageIdentity(images[i]) !== cardIdentity) return;
      const from = images.findIndex(image => pageIdentity(image) === drag.identity);
      if (from < 0) return;
      e.preventDefault();
      changeImageOrder(from, i);
    });

    grid.appendChild(card);
  });

  const has = images.length > 0;
  document.getElementById('toolbar').classList.toggle('on', has);
  document.getElementById('settingsBar').classList.toggle('on', has);
  document.getElementById('convertSection').classList.toggle('on', has);
  document.getElementById('countBadge').textContent = images.length;
  updateChrome();
  suggestFilename();
  updateSelectionUI();
  updateSummary();
  document.getElementById('successMsg').classList.remove('on');
  updateUndoUI();
}

// ── MULTI-SELECT ──
// Rotating a batch of sideways scans one card at a time was the single most
// repetitive thing in the app; selection makes it one action.
let selectedSet = new Set();

function updateSelectionUI() {
  const n = selectedSet.size;
  const info = document.getElementById('selInfo');
  const btn = document.getElementById('selectAllBtn');
  if (info) info.textContent = n ? `${n} selected` : '';
  if (btn) btn.textContent = (n && n === images.length) ? 'Select none' : 'Select all';
  document.querySelectorAll('.img-card').forEach(c => {
    c.classList.toggle('selected', selectedSet.has(+c.dataset.i) || selectedConvertCard === +c.dataset.i);
  });
}

function toggleSelectAll() {
  if (selectedSet.size === images.length) selectedSet.clear();
  else selectedSet = new Set(images.map((_, i) => i));
  updateSelectionUI();
}

// Indices the next bulk action applies to: the explicit selection, or everything.
function targetIndices() {
  return selectedSet.size ? [...selectedSet].filter(i => images[i]).sort((a,b)=>a-b)
                          : images.map((_, i) => i);
}

function rotateAll(deg) {
  const idx = targetIndices();
  if (!idx.length) return;
  idx.forEach(i => { images[i].rotation = ((images[i].rotation||0) + deg + 360) % 360; });
  snapshot(selectedSet.size ? 'Rotate selected' : 'Rotate all');
  refreshAll();
  showToast(`↻ Rotated ${idx.length} image${idx.length>1?'s':''}`);
}

// ── HOLD-TO-DRAG logic (convert grid) ──
let selectedConvertCard = null;

function createGhost(card, e) {
  ghostEl = card.cloneNode(true);
  ghostEl.className = 'drag-ghost img-card';
  ghostEl.style.width = card.offsetWidth + 'px';
  ghostEl.style.position = 'fixed';
  ghostEl.style.left = (e.clientX - card.offsetWidth / 2) + 'px';
  ghostEl.style.top = (e.clientY - card.offsetHeight / 2) + 'px';
  ghostEl.style.pointerEvents = 'none';
  document.body.appendChild(ghostEl);
}

function onHoldMove(e) {
  if (!ghostEl) return;
  ghostEl.style.left = (e.clientX - ghostEl.offsetWidth / 2) + 'px';
  ghostEl.style.top = (e.clientY - ghostEl.offsetHeight / 2) + 'px';

  // find drop target
  ghostEl.style.display = 'none';
  const el = document.elementFromPoint(e.clientX, e.clientY);
  ghostEl.style.display = '';
  const targetCard = el && el.closest('.img-card');
  document.querySelectorAll('.img-card').forEach(c => c.classList.remove('drag-over'));
  if (targetCard && targetCard !== holdCard) {
    targetCard.classList.add('drag-over');
  }
}

function onHoldEnd(e) {
  document.removeEventListener('mousemove', onHoldMove);
  document.removeEventListener('mouseup', onHoldEnd);

  if (ghostEl) { ghostEl.remove(); ghostEl = null; }
  if (holdCard) holdCard.classList.remove('hold-active', 'dragging');

  // find drop target
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const targetCard = el && el.closest('.img-card[data-i]');
  if (targetCard) {
    const targetIdx = parseInt(targetCard.dataset.i);
    if (targetIdx !== dragSrcIdx) {
      changeImageOrder(dragSrcIdx, targetIdx);
    }
  }

  holdActive = false; holdCard = null; dragSrcIdx = null;
  refreshAll();
}

function onTouchHoldMove(e) {
  if (!holdActive || !ghostEl) return;
  e.preventDefault();
  const touch = e.touches[0];
  ghostEl.style.left = (touch.clientX - ghostEl.offsetWidth / 2) + 'px';
  ghostEl.style.top  = (touch.clientY - ghostEl.offsetHeight / 2) + 'px';
  ghostEl.style.display = 'none';
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  ghostEl.style.display = '';
  const targetCard = el && el.closest('.img-card');
  document.querySelectorAll('.img-card').forEach(c => c.classList.remove('drag-over'));
  if (targetCard && targetCard !== holdCard) targetCard.classList.add('drag-over');
}

function onTouchHoldEnd(e) {
  document.removeEventListener('touchmove', onTouchHoldMove);
  document.removeEventListener('touchend',  onTouchHoldEnd);
  document.removeEventListener('touchcancel', onTouchHoldEnd);

  if (ghostEl) { ghostEl.remove(); ghostEl = null; }
  if (holdCard) holdCard.classList.remove('hold-active', 'dragging');

  const touch = e.changedTouches ? e.changedTouches[0] : null;
  if (touch) {
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    const targetCard = el && el.closest('.img-card[data-i]');
    if (targetCard) {
      const targetIdx = parseInt(targetCard.dataset.i);
      if (targetIdx !== dragSrcIdx) {
        changeImageOrder(dragSrcIdx, targetIdx);
      }
    }
  }
  holdActive = false; holdCard = null; dragSrcIdx = null;
  refreshAll();
}

function updateSummary() {
  const ps = document.getElementById('pageSize').value;
  const or = document.getElementById('orientation').value;
  document.getElementById('convertSummary').textContent =
    `${images.length} image${images.length>1?'s':''} · ${ps.toUpperCase()} · ${or}`;
  updatePrintSizeUI();
  updatePdfContentUI();
  estimateExportSize();
}

function updatePrintSizeUI() {
  const pageSize = document.getElementById('pageSize').value;
  const printSize = document.getElementById('imgFit').value === 'actual';
  const dpi = document.getElementById('printDpi');
  const oversize = document.getElementById('oversize');
  const hint = document.getElementById('printSizeHint');
  if (dpi) dpi.disabled = pageSize !== 'fit' && !printSize;
  if (oversize) oversize.disabled = !printSize;
  if (hint) {
    hint.textContent = 'Photos use the chosen DPI for print size and Fit to image; embedded DPI is not used. PDF pages keep their saved paper dimensions. ' +
      (printSize ? (oversize && oversize.value === 'crop'
        ? 'Oversized content keeps its print size and is cropped within the margins.'
        : 'Oversized content is scaled down to fit within the margins.')
        : 'Contain keeps the full image; Fill crops within the margins.');
  }
}

function updatePdfContentUI() {
  const mode = document.getElementById('pdfContentMode');
  const hint = document.getElementById('pdfContentHint');
  const hasPdf = images.some(image => image.pdfSource || image.originalPdfSource);
  const preserve = mode && mode.value !== 'images';
  const onlyNative = hasPdf && images.every(image => image.pdfSource);
  if (mode) mode.disabled = !hasPdf || exportInProgress;
  ['pageSize', 'orientation', 'imgFit', 'margin'].forEach(id => {
    const control = document.getElementById(id);
    if (control) control.disabled = !!(preserve && onlyNative);
  });
  if (hint) {
    hint.hidden = !hasPdf;
    hint.textContent = preserve
      ? 'Unedited PDF pages keep text and vectors. Their saved paper size and rotation are used; layout settings apply to photos and image-edited pages. An untouched single PDF downloads its original bytes. Edited or merged documents can lose forms, bookmarks, links, accessibility tags, attachments, encryption, and valid signatures.'
      : 'Image export turns PDF pages into pictures. Searchable text, vectors, links, forms, bookmarks, accessibility tags, attachments, encryption, and valid signatures are lost.';
    hint.classList.toggle('pdf-content-warning', hasPdf);
  }
}

// Source image bytes cannot predict the PDF encoding or document overhead.
// Report the actual generated file, without encoding another copy to estimate it.
function formatFileBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('Invalid file byte count');
  const exact = `${bytes.toLocaleString('en-US')} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1024) return exact;
  const unit = bytes >= 1048576 ? 'MB' : 'KB';
  const divisor = unit === 'MB' ? 1048576 : 1024;
  return `${(bytes / divisor).toFixed(1)} ${unit} (${exact})`;
}
function estimateExportSize() {
  const el = document.getElementById('sizeEstimate');
  if (!el) return;
  el.textContent = images.length ? 'PDF size is measured after export.' : '';
}
['pageSize','orientation','imgFit','margin','quality','printDpi','oversize','pdfContentMode'].forEach(id => {
  document.getElementById(id)?.addEventListener('change', () => { updateSummary(); saveSettings(); });
});
// Mark the filename as manually set so suggestFilename() stops overriding it.
document.getElementById('filename')?.addEventListener('input', e => {
  e.target.dataset.touched = e.target.value.trim() ? '1' : '';
});

function removeImage(i) {
  if (!images[i]) return;
  const selection = captureSelection();
  images.splice(i,1);
  restoreSelection(selection);
  snapshot('Delete image');
  refreshAll();
}
function duplicateImage(i) {
  const orig = images[i];
  if (!orig) return;
  try { if (window.PhotoPdfLimits) window.PhotoPdfLimits.assertPageCount(1, images.length); }
  catch (error) { showToast(`⚠️ ${error.message}`); return; }
  const selection = captureSelection();
  const newId = _imgId();
  // Shares the source's object URLs — putStore bumps their refcounts so neither
  // copy can revoke pixels the other still needs.
  putStore(newId, { ...(imgStore[orig._id] || { src: orig.src, originalSrc: orig.originalSrc, thumb: orig.thumb }) });
  images.splice(i+1, 0, { ...orig, _id: newId, _pageId: newId,
    pdfSource: copyPdfSource(orig.pdfSource), originalPdfSource: copyPdfSource(orig.originalPdfSource),
    pdfPageSizeMm: copyPdfPageSize(orig.pdfPageSizeMm),
    originalPdfPageSizeMm: copyPdfPageSize(orig.originalPdfPageSizeMm) });
  restoreSelection(selection);
  snapshot('Duplicate');
  refreshAll();
}
function clearAll() {
  if (images.length && !confirm(`Remove all ${images.length} image${images.length>1?'s':''}?`)) return;
  cancelImports();
  images=[]; selectedConvertCard=null; selectedPdfPage=null; selectedSet.clear();
  snapshot('Clear all');   // prune runs here once the old entries fall out of history
  refreshAll();
  fileInput.value='';
}
function sortByName() {
  const selection = captureSelection();
  images.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'}));
  restoreSelection(selection); snapshot('Sort A-Z'); refreshAll();
}
function reverseOrder() {
  const selection = captureSelection();
  images.reverse(); restoreSelection(selection); snapshot('Reverse order'); refreshAll();
}
function quickRotateCard(i) { if (!images[i]) return; images[i].rotation=(images[i].rotation+90)%360; snapshot('Rotate'); refreshAll(); }

// ══════════════════════════════════════
//  PDF EDITOR PAGE
// ══════════════════════════════════════
// hold-to-drag for pdf page list
let pdfDragSrc = null;
let pdfHoldTimer = null;
let pdfHoldActive = false;
let pdfGhost = null;
let pdfHoldEl = null;
let pdfDropIndex = null; // where the item will be inserted (0..images.length)
let pdfListRender = 0;
let pdfDetailRequest = 0;

function renderPdfEditor() {
  const renderVersion = ++pdfListRender;
  const wrap = document.getElementById('pdfEditorWrap');
  const list = document.getElementById('pdfPageList');
  const mergeSection = document.getElementById('mergePdfSection');
  const uploadDrop = document.getElementById('pdfDropZone');

  updateChrome();
  const sBar = document.getElementById('settingsBar');
  if (!images.length) {
    wrap.style.display='none';
    mergeSection.style.display = 'none';
    uploadDrop.style.display = '';
    if (sBar) sBar.classList.remove('on');
    return;
  }
  wrap.style.display='grid';
  mergeSection.style.display = 'flex';
  uploadDrop.style.display = 'none';
  if (sBar && currentTab === 'edit') sBar.classList.add('on');

  document.getElementById('pdfPageCount').textContent = images.length;
  list.innerHTML = '';

  // Build items with drop-line indicators between each
  // Structure: [drop-line-0] [item-0] [drop-line-1] [item-1] ... [drop-line-N]
  function makeDropLine(idx) {
    const dl = document.createElement('div');
    dl.className = 'drop-line-indicator';
    dl.dataset.dropIdx = idx;
    return dl;
  }

  // Drop line before item 0
  list.appendChild(makeDropLine(0));

  images.forEach((img, i) => {
    const el = document.createElement('div');
    el.className = 'pdf-page-item' + (selectedPdfPage===i?' selected':'');
    el.dataset.i = i;

    el.innerHTML = `
      <div class="pdf-drag-handle" title="Hold & drag to reorder">⠿</div>
      <div class="pdf-page-thumb">
        <canvas id="pthumb-${i}" width="44" height="60"></canvas>
      </div>
      <div class="pdf-page-info">
        <strong>Page ${i+1}</strong>
        <span title="${esc(img.name)}">${esc(img.name.length > 22 ? img.name.substring(0,20)+'…' : img.name)}</span>
      </div>
      <div class="pdf-page-actions">
        <button class="pba" title="Edit" aria-label="Edit page ${i+1}" onclick="event.stopPropagation();openEditorFor(${i})">✏</button>
        <button class="pba" title="Move up" aria-label="Move page ${i+1} up" onclick="event.stopPropagation();movePage(${i},-1)">↑</button>
        <button class="pba" title="Move down" aria-label="Move page ${i+1} down" onclick="event.stopPropagation();movePage(${i},1)">↓</button>
        <button class="pba" title="Duplicate" aria-label="Duplicate page ${i+1}" onclick="event.stopPropagation();duplicatePage(${i})">⧉</button>
        <button class="pba del" title="Delete" aria-label="Delete page ${i+1}" onclick="event.stopPropagation();deletePage(${i})">🗑</button>
      </div>`;

    // Click to select
    el.addEventListener('click', (e) => {
      if (e.target.closest('.pba') || e.target.closest('.pdf-drag-handle')) return;
      selectPdfPage(i);
    });

    // ── MOUSE hold-to-drag (desktop) ──
    const handle = el.querySelector('.pdf-drag-handle');

    function startPdfHold(srcIdx, itemEl, clientX, clientY) {
      pdfHoldActive = true;
      pdfDragSrc = srcIdx;
      pdfHoldEl = itemEl;
      itemEl.classList.add('hold-active');
      // Ghost
      pdfGhost = itemEl.cloneNode(true);
      pdfGhost.style.cssText = `position:fixed;width:${itemEl.offsetWidth}px;opacity:.88;z-index:9999;pointer-events:none;border-radius:7px;box-shadow:0 10px 30px rgba(0,0,0,.3);transform:scale(1.03) rotate(-0.5deg);left:${itemEl.getBoundingClientRect().left}px;top:${clientY - itemEl.offsetHeight/2}px`;
      document.body.appendChild(pdfGhost);
    }

    handle.addEventListener('mousedown', (e) => {
      e.stopPropagation(); e.preventDefault();
      pdfHoldTimer = setTimeout(() => {
        startPdfHold(i, el, e.clientX, e.clientY);
        document.addEventListener('mousemove', onPdfHoldMove);
        document.addEventListener('mouseup', onPdfHoldEnd);
      }, 150);
    });
    handle.addEventListener('mouseup', () => clearTimeout(pdfHoldTimer));
    handle.addEventListener('mouseleave', () => { if (!pdfHoldActive) clearTimeout(pdfHoldTimer); });

    // ── TOUCH hold-to-drag (mobile) ──
    handle.addEventListener('touchstart', (e) => {
      e.stopPropagation();
      const touch = e.touches[0];
      pdfHoldTimer = setTimeout(() => {
        // Vibrate to signal drag start
        if (navigator.vibrate) navigator.vibrate(30);
        startPdfHold(i, el, touch.clientX, touch.clientY);
        document.addEventListener('touchmove', onPdfTouchMove, { passive: false });
        document.addEventListener('touchend', onPdfTouchEnd);
        document.addEventListener('touchcancel', onPdfTouchEnd);
      }, 400);
    }, { passive: true });
    handle.addEventListener('touchend', () => clearTimeout(pdfHoldTimer));
    handle.addEventListener('touchcancel', () => clearTimeout(pdfHoldTimer));

    list.appendChild(el);
    // Drop line after each item
    list.appendChild(makeDropLine(i + 1));

    setTimeout(() => drawThumb(i, renderVersion), 0);
  });
  updateUndoUI();
}

// ── Shared: find which drop slot the pointer is at ──
function getPdfDropIndex(clientY) {
  // Walk the items and find which gap the pointer sits in.
  const items = document.querySelectorAll('.pdf-page-item');
  if (!items.length) return 0;
  let slot = 0;
  for (let k = 0; k < items.length; k++) {
    const r = items[k].getBoundingClientRect();
    if (clientY > r.top + r.height / 2) slot = k + 1;
    else break;
  }
  return slot;
}

function showDropLine(dropIdx) {
  document.querySelectorAll('.drop-line-indicator').forEach(dl => {
    dl.classList.toggle('active', parseInt(dl.dataset.dropIdx) === dropIdx);
  });
}

function clearDropLines() {
  document.querySelectorAll('.drop-line-indicator').forEach(dl => dl.classList.remove('active'));
}

function onPdfHoldMove(e) {
  if (!pdfGhost) return;
  pdfGhost.style.top = (e.clientY - pdfGhost.offsetHeight / 2) + 'px';
  pdfDropIndex = getPdfDropIndex(e.clientY);
  showDropLine(pdfDropIndex);
}

function onPdfHoldEnd(e) {
  document.removeEventListener('mousemove', onPdfHoldMove);
  document.removeEventListener('mouseup', onPdfHoldEnd);
  _finishPdfDrop(pdfDropIndex);
}

function onPdfTouchMove(e) {
  if (!pdfHoldActive || !pdfGhost) return;
  e.preventDefault();
  const touch = e.touches[0];
  pdfGhost.style.top = (touch.clientY - pdfGhost.offsetHeight / 2) + 'px';
  pdfGhost.style.left = (touch.clientX - pdfGhost.offsetWidth / 2) + 'px';
  pdfDropIndex = getPdfDropIndex(touch.clientY);
  showDropLine(pdfDropIndex);
}

function onPdfTouchEnd(e) {
  document.removeEventListener('touchmove', onPdfTouchMove);
  document.removeEventListener('touchend', onPdfTouchEnd);
  document.removeEventListener('touchcancel', onPdfTouchEnd);
  _finishPdfDrop(pdfDropIndex);
}

function _finishPdfDrop(dropIdx) {
  clearTimeout(pdfHoldTimer);
  if (pdfGhost) { pdfGhost.remove(); pdfGhost = null; }
  if (pdfHoldEl) pdfHoldEl.classList.remove('hold-active');
  clearDropLines();

  if (pdfHoldActive && dropIdx !== null && pdfDragSrc !== null) {
    // dropIdx is where to insert after removing src
    let insertAt = dropIdx;
    // Adjust: if dropping below the source, account for removal shifting
    if (insertAt > pdfDragSrc) insertAt--;
    if (insertAt !== pdfDragSrc) {
      changeImageOrder(pdfDragSrc, insertAt, 'Reorder pages');
    }
  }

  pdfHoldActive = false; pdfHoldEl = null; pdfDragSrc = null; pdfDropIndex = null;
  refreshAll();
}

// A decode may finish after a tab switch, reorder, or a newer selection. Paint
// captured pixels only while this exact canvas and document are still current.
async function paintPdfPreview(cvs, image, width, height, isCurrent) {
  const source = image.thumb || image.src;
  retainUrl(source);
  try {
    const img = await loadImage(source);
    if (!isCurrent()) return;
    const ctx = cvs.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width / 2, height / 2);
    const rot = (((image.rotation || 0) % 360) + 360) % 360;
    ctx.rotate(rot * Math.PI / 180);
    ctx.scale(image.flipH ? -1 : 1, image.flipV ? -1 : 1);
    const swap = rot === 90 || rot === 270;
    const fitW = swap ? img.naturalHeight : img.naturalWidth;
    const fitH = swap ? img.naturalWidth : img.naturalHeight;
    const scale = Math.min(width / fitW, height / fitH);
    ctx.drawImage(img, -img.naturalWidth * scale / 2, -img.naturalHeight * scale / 2,
      img.naturalWidth * scale, img.naturalHeight * scale);
    ctx.restore();
  } catch (_) {
    // An unreadable preview must not leave a rejected asynchronous callback.
  } finally {
    releaseUrl(source);
  }
}
function drawThumb(i, renderVersion = pdfListRender) {
  const cvs = document.getElementById('pthumb-' + i);
  if (!cvs || !images[i] || renderVersion !== pdfListRender) return;
  const image = { ...images[i] }, revision = documentRevision;
  return paintPdfPreview(cvs, image, 44, 60, () =>
    currentTab === 'edit' && renderVersion === pdfListRender && revision === documentRevision &&
    document.getElementById('pthumb-' + i) === cvs);
}

function selectPdfPage(i) {
  if (!Number.isInteger(i) || !images[i]) return;
  selectedPdfPage = i;
  document.querySelectorAll('.pdf-page-item').forEach((el, idx) => {
    el.classList.toggle('selected', idx === i);
  });
  const dp = document.getElementById('detailPreview');
  const da = document.getElementById('detailActions');
  dp.innerHTML = `<canvas id="detailCanvas" width="240" height="320"></canvas>`;
  const cvs = document.getElementById('detailCanvas');
  const request = ++pdfDetailRequest, revision = documentRevision, image = { ...images[i] };
  const isCurrent = () => currentTab === 'edit' && request === pdfDetailRequest &&
    revision === documentRevision && document.getElementById('detailCanvas') === cvs;
  da.style.display = 'flex';
  da.style.flexDirection = 'column';
  setTimeout(() => {
    if (cvs && isCurrent()) paintPdfPreview(cvs, image, 240, 320, isCurrent);
  }, 50);
}

function movePage(i, dir) {
  const ni = i + dir;
  if (!Number.isInteger(i) || !images[i] || ni < 0 || ni >= images.length) return;
  const selection = captureSelection();
  [images[i], images[ni]] = [images[ni], images[i]];
  restoreSelection(selection);
  snapshot('Move page');
  refreshAll();
}

function duplicatePage(i) {
  const orig = images[i];
  if (!orig) return;
  try { if (window.PhotoPdfLimits) window.PhotoPdfLimits.assertPageCount(1, images.length); }
  catch (error) { showToast(`⚠️ ${error.message}`); return; }
  const selection = captureSelection();
  const newId = _imgId();
  // Shares the source's object URLs — putStore bumps their refcounts so neither
  // copy can revoke pixels the other still needs.
  putStore(newId, { ...(imgStore[orig._id] || { src: orig.src, originalSrc: orig.originalSrc, thumb: orig.thumb }) });
  images.splice(i+1, 0, { ...orig, _id: newId, _pageId: newId,
    pdfSource: copyPdfSource(orig.pdfSource), originalPdfSource: copyPdfSource(orig.originalPdfSource),
    pdfPageSizeMm: copyPdfPageSize(orig.pdfPageSizeMm),
    originalPdfPageSizeMm: copyPdfPageSize(orig.originalPdfPageSizeMm) });
  restoreSelection(selection);
  snapshot('Duplicate page');
  refreshAll();
}

function deletePage(i) {
  if (!images[i]) return;
  const selection = captureSelection();
  images.splice(i, 1);
  restoreSelection(selection);
  snapshot('Delete page');
  refreshAll();
}

function rotatePage(i, deg) {
  if (!images[i]) return;
  images[i].rotation = ((images[i].rotation||0) + deg + 360) % 360;
  snapshot('Rotate page');
  refreshAll();
}

// Both views export the same document through the same code path, so the Edit
// view now honours page size / orientation / fit / margin / filename too.
async function exportEditedPDF() { return generatePDF(); }

// ── LIGHTBOX ──
let _lightboxReturnFocus = null;
function openLightbox(idx) {
  const i = Number.isInteger(idx) ? idx : selectedPdfPage;
  if (!Number.isInteger(i) || !images[i]) return;
  if (currentTab === 'convert') {
    selectedConvertCard = i;
    selectedSet.clear();
    updateSelectionUI();
  } else selectPdfPage(i);
  const img = images[i];
  const lb = document.getElementById('lightbox');
  const lbImg = document.getElementById('lightboxImg');
  const rot = (((img.rotation || 0) % 360) + 360) % 360;
  lbImg.src = img.src;
  lbImg.style.transform = `rotate(${rot}deg)`;
  // A 90°-rotated image is bounded by the OPPOSITE viewport axis, otherwise it
  // overflows the screen once turned.
  const swap = (rot === 90 || rot === 270);
  lbImg.style.maxWidth  = swap ? '90vh' : '90vw';
  lbImg.style.maxHeight = swap ? '90vw' : '90vh';
  document.getElementById('lightboxCaption').textContent = `${i + 1} of ${images.length} · ${img.name}`;
  lb.classList.add('on');
  _lightboxReturnFocus = document.activeElement;
  document.getElementById('lightboxCloseBtn').focus();
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('on');
  if (_lightboxReturnFocus && _lightboxReturnFocus.focus) _lightboxReturnFocus.focus();
  _lightboxReturnFocus = null;
}

// ══════════════════════════════════════
//  GENERATE PDF
// ══════════════════════════════════════
// Both tabs show the same job. Import and export have separate indicators so
// completing one cannot hide the other while the user switches views.
function setExportProgress(show, label, pct) {
  ['', 'Edit'].forEach(suffix => {
    document.getElementById('progWrap' + suffix).classList.toggle('on', show);
    if (show) {
      document.getElementById('progLbl' + suffix).textContent = label || 'Processing…';
      document.getElementById('progFill' + suffix).style.width = (pct || 0) + '%';
    }
  });
}

let lastExportReport = null;

function getExportReport() {
  return lastExportReport ? { ...lastExportReport,
    skipped: lastExportReport.skipped.map(page => ({ ...page })) } : null;
}

function publishExportReport(report) {
  lastExportReport = report ? { ...report, skipped: report.skipped.map(page => ({ ...page })) } : null;
  const element = document.getElementById('exportReport');
  if (!element) return;
  element.hidden = !report;
  if (!report) { element.textContent = ''; return; }
  if (element.dataset) element.dataset.status = report.status;
  const title = report.status === 'partial' ? 'Partial PDF saved — pages are missing.'
    : report.status === 'complete' ? 'PDF exported.' : 'Export failed — no PDF was downloaded.';
  const lines = [title, `"${report.filename}" · ${report.exportedPages} of ${report.requestedPages} pages exported.`];
  if (report.bytes !== null) lines.push(`Downloaded file: ${formatFileBytes(report.bytes)}`);
  if (report.error) lines.push(report.error);
  if (report.skipped.length) {
    lines.push('Pages not included:');
    report.skipped.forEach(page => lines.push(`Page ${page.position}: ${page.name} — ${page.reason}`));
  }
  element.textContent = lines.join('\n');
}

async function generatePDF() {
  if (exportInProgress || !images.length) return;
  estimateExportSize();
  const contentMode = document.getElementById('pdfContentMode').value;
  const preservePdf = contentMode !== 'images' && images.some(image => image.pdfSource || image.originalPdfSource);
  const jsPDF = window.jspdf && window.jspdf.jsPDF;
  const pageSize = document.getElementById('pageSize').value;
  const orientation = document.getElementById('orientation').value;
  const imgFit = document.getElementById('imgFit').value;
  const imageOptions = { preserveQuality: preserveOriginalQuality, quality: exportQuality() };
  // Clamp: the HTML max is advisory only, and a margin wider than the page
  // makes the available area negative and the layout maths meaningless.
  const marginEl = document.getElementById('margin');
  let margin = parseFloat(marginEl.value); if (!isFinite(margin) || margin < 0) margin = 0;
  const layoutSettings = {
    pageSize, orientation, imgFit, margin,
    dpi: Number(document.getElementById('printDpi').value),
    oversize: document.getElementById('oversize').value
  };
  const filename = sanitizeFilename(document.getElementById('filename').value) + '.pdf';
  // Export exactly the document captured at the click, even if its live pages
  // are edited, removed, imported, or reordered while encoding awaits.
  const exportImages = images.map(image => ({ ...image, filters: { ...(image.filters || {}) },
    pdfPageSizeMm: copyPdfPageSize(image.pdfPageSizeMm),
    originalPdfPageSizeMm: copyPdfPageSize(image.originalPdfPageSizeMm),
    pdfSource: copyPdfSource(image.pdfSource), originalPdfSource: copyPdfSource(image.originalPdfSource) }));
  const exportSources = new Map();
  exportImages.forEach(image => {
    const source = image.pdfSource;
    if (source && pdfSources.has(source.sourceId)) exportSources.set(source.sourceId, pdfSources.get(source.sourceId));
  });
  const sourceUrls = new Set(exportImages.map(image => image.src));
  sourceUrls.forEach(retainUrl);

  const btn = document.getElementById('convertBtn');
  const preserveButton = document.getElementById('preserveQualityBtn');
  const editButton = document.getElementById('editExportBtn');
  exportInProgress = true;
  btn.disabled=true;
  if (editButton) editButton.disabled = true;
  if (preserveButton) preserveButton.disabled = true;
  updatePdfContentUI();
  setExportProgress(true, 'Preparing…', 0);
  document.getElementById('successMsg').classList.remove('on');
  publishExportReport(null);
  const previousNotice = document.getElementById('pdfExportNotice');
  if (previousNotice) previousNotice.hidden = true;

  let pdf = null, pages = 0, scaledPages = 0, croppedPages = 0;
  let preservationNotice = '', exportedBytes = null;
  const sourceLeaseReleases = [];
  const skipped = [];
  let activePage = null;
  const recordPageIssue = (position, reason) => {
    if (!position || skipped.some(page => page.position === position)) return;
    skipped.push({ position, name: String(exportImages[position - 1].name || `Page ${position}`), reason: String(reason) });
  };
  const failedReport = error => publishExportReport({ status: 'failed', filename,
    requestedPages: exportImages.length, exportedPages: 0, bytes: null, error, skipped });
  try {
  if (!preservePdf && !jsPDF) throw new Error('The PDF export library is unavailable. Reload the page.');
  const limits = window.PhotoPdfLimits;
  if (limits) limits.assertExport(exportImages, exportSources, { rasterizeNative: !preservePdf });
  if (limits && limits.leaseBytes) {
    for (const id of exportSources.keys()) sourceLeaseReleases.push(limits.leaseBytes(id));
  }
  if (preservePdf) {
    const api = window.PhotoPdfPreservation;
    if (!api) throw new Error('The PDF preservation tools are unavailable. Reload the page.');
    let preservationNextPage = 1;
    const result = await api.prepareStructurePreservingPdf(exportImages, {
      getSource: id => exportSources.get(id),
      prepareImage: async (image, options) => {
        // The preservation helper clones pages; its completed-page count keeps
        // positions accurate even for duplicated pages with identical sources.
        activePage = preservationNextPage;
        const rendered = await preparePdfImage(image, options);
        if (!rendered) recordPageIssue(activePage, 'The image could not be decoded for PDF export.');
        return rendered;
      },
      computeLayout: computePdfLayout, imageOptions, settings: layoutSettings,
      onProgress: (completed, total) => {
        preservationNextPage = completed + 1;
        activePage = null;
        setExportProgress(true, `Preparing page ${completed} of ${total}…`, completed / total * 90);
      }
    });
    pages = exportImages.length;
    scaledPages = result.scaledDownPages || 0;
    croppedPages = result.croppedPages || 0;
    preservationNotice = result.notice || '';
    if (limits) limits.assertOutputBytes(result.bytes.byteLength);
    downloadPdfBytes(result.bytes, filename);
    exportedBytes = result.bytes.byteLength;
  } else {
  for (let i=0;i<exportImages.length;i++) {
    const image = exportImages[i];
    activePage = i + 1;
    setExportProgress(true, `Processing image ${i+1} of ${exportImages.length}…`, (i/exportImages.length)*90);
    await new Promise(r=>setTimeout(r,5));

    const rendered = await preparePdfImage(image, imageOptions);
    if (!rendered) {
      recordPageIssue(activePage, 'The image could not be decoded for PDF export.');
      activePage = null;
      continue;
    }
    const layout = computePdfLayout(image, rendered, layoutSettings);
    const format = [layout.page.width, layout.page.height];
    if (!pdf) pdf = new jsPDF({ orientation: layout.page.orientation, unit: 'mm', format });
    else pdf.addPage(format, layout.page.orientation);
    writePdfImage(pdf, rendered, layout);
    if (layout.scaledDown) scaledPages++;
    if (layout.cropped) croppedPages++;
    pages++;
    activePage = null;
  }

  setExportProgress(true, skipped.length ? `Finalizing partial PDF (${pages} of ${exportImages.length} pages)…` : 'Finalizing…', 100);
  await new Promise(r=>setTimeout(r,120));
  if (!pdf || !pages) {
    const error = 'Nothing could be exported — none of the images could be read.';
    failedReport(error);
    alert(error);
    return;
  }
  // Serialize once, then measure and download that same Blob.
  const output = pdf.output('blob');
  if (!output || !Number.isSafeInteger(output.size) || output.size < 0) {
    throw new Error('The PDF library did not produce a valid file.');
  }
  if (limits) limits.assertOutputBytes(output.size);
  downloadPdfBlob(output, filename);
  exportedBytes = output.size;
  }

  const sizeNotes = [scaledPages ? `${scaledPages} scaled down to fit` : '',
    croppedPages ? `${croppedPages} cropped within margins` : ''].filter(Boolean).join(' · ');
  const measuredSize = formatFileBytes(exportedBytes);
  const partial = skipped.length > 0;
  publishExportReport({ status: partial ? 'partial' : 'complete', filename,
    requestedPages: exportImages.length, exportedPages: pages, bytes: exportedBytes, error: '', skipped });
  const sizeLabel = document.getElementById('sizeEstimate');
  if (sizeLabel) sizeLabel.textContent = `Last exported PDF: ${measuredSize}`;
  const successTitle = document.getElementById('successTitle');
  if (successTitle) successTitle.textContent = partial ? 'Partial PDF saved — pages missing' : 'PDF saved!';
  const successMessage = document.getElementById('successMsg');
  if (successMessage.dataset) successMessage.dataset.status = partial ? 'partial' : 'complete';
  document.getElementById('successDetail').textContent=`${partial ? `${pages} of ${exportImages.length} pages` : `${pages} page${pages>1?'s':''}`} · "${filename}" · ${measuredSize}${sizeNotes ? ' · ' + sizeNotes : ''}${preservationNotice ? ' · ' + preservationNotice : ''}`;
  const resultNotice = document.getElementById('pdfExportNotice');
  if (resultNotice) {
    resultNotice.textContent = `${partial ? `Partial export: ${pages} of ${exportImages.length} pages · ` : ''}Last exported PDF: ${measuredSize}${preservationNotice ? ' · ' + preservationNotice : ''}`;
    resultNotice.hidden = false;
  }
  // The success banner lives in the Convert view; only surface it when visible.
  if (currentTab === 'convert') {
    document.getElementById('successMsg').classList.add('on');
    document.getElementById('successMsg').scrollIntoView({behavior:'smooth',block:'nearest'});
  }
  showToast(skipped.length
    ? `Partial PDF saved: ${pages} of ${exportImages.length} pages — see the export report`
    : `✓ Saved "${filename}"${sizeNotes ? ' · ' + sizeNotes : ''}`);
  } catch (err) {
    // A mid-export failure used to leave the button disabled and the progress
    // bar spinning forever with no explanation.
    const reason = String(err && err.message ? err.message : err);
    recordPageIssue(activePage, reason);
    failedReport(reason);
    alert(`Export failed.\n\n${reason}`);
  } finally {
    exportInProgress = false;
    sourceLeaseReleases.forEach(release => release());
    sourceUrls.forEach(releaseUrl);
    btn.disabled=false;
    if (editButton) editButton.disabled = false;
    if (preserveButton) preserveButton.disabled = false;
    setExportProgress(false);
    updatePdfContentUI();
  }
}

function downloadPdfBytes(bytes, filename) {
  downloadPdfBlob(new Blob([bytes], { type: 'application/pdf' }), filename);
}

function downloadPdfBlob(blob, filename) {
  const limits = window.PhotoPdfLimits, key = {};
  if (limits) limits.reserveDownload(key, blob.size);
  let url = null, link = null, clicked = false;
  try {
  url = URL.createObjectURL(blob);
  link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  clicked = true;
  } finally {
    if (link) link.remove();
    if (url && clicked) setTimeout(() => {
      URL.revokeObjectURL(url);
      if (limits) limits.releaseDownload(key);
    }, 30000);
    else {
      if (url) URL.revokeObjectURL(url);
      if (limits) limits.releaseDownload(key);
    }
  }
}

// ══════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ══════════════════════════════════════
document.addEventListener('keydown', e => {
  // Block when typing in inputs
  const tag = document.activeElement.tagName;
  const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  const modalOpen = document.getElementById('editorModal').classList.contains('on');
  const lightboxOpen = document.getElementById('lightbox').classList.contains('on');

  if (e.key === 'Escape') {
    if (lightboxOpen) { closeLightbox(); return; }
    if (modalOpen) { closeEditor(); return; }
  }

  if (modalOpen || lightboxOpen || inInput) return;

  // Normalise: with Shift held, e.key for the Z key is 'Z', not 'z'.
  const k = (e.key || '').toLowerCase();

  // Undo/Redo
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'z') { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && k === 'z') || k === 'y')) { e.preventDefault(); redo(); return; }

  if (currentTab === 'convert') {
    const hasSel = Number.isInteger(selectedConvertCard) && !!images[selectedConvertCard];
    // Delete selected — the whole multi-selection if there is one
    if ((e.key === 'Delete' || e.key === 'Backspace') && (hasSel || selectedSet.size)) {
      e.preventDefault();
      if (selectedSet.size) {
        const n = selectedSet.size;
        const selection = captureSelection();
        [...selectedSet].sort((a,b)=>b-a).forEach(i => { if (images[i]) images.splice(i,1); });
        restoreSelection(selection);
        snapshot('Delete selected');
        refreshAll();
        showToast(`Removed ${n} image${n>1?'s':''}`);
      } else {
        removeImage(selectedConvertCard); // adjusts the selection itself
      }
      return;
    }
    // Arrow navigate
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!images.length) return;
      selectedConvertCard = hasSel ? (selectedConvertCard + 1) % images.length : 0;
      render();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!images.length) return;
      selectedConvertCard = hasSel ? (selectedConvertCard - 1 + images.length) % images.length : images.length - 1;
      render();
      return;
    }
    // Duplicate
    if ((e.ctrlKey || e.metaKey) && k === 'd' && hasSel) {
      e.preventDefault();
      duplicateImage(selectedConvertCard);
      return;
    }
  }

  if (currentTab === 'edit') {
    const hasPage = Number.isInteger(selectedPdfPage) && !!images[selectedPdfPage];
    // Delete selected page
    if ((e.key === 'Delete' || e.key === 'Backspace') && hasPage) {
      e.preventDefault();
      deletePage(selectedPdfPage);
      return;
    }
    // Arrow navigate pages
    if (e.key === 'ArrowDown' && hasPage && selectedPdfPage < images.length - 1) {
      e.preventDefault();
      selectPdfPage(selectedPdfPage + 1);
      // scroll into view
      const items = document.querySelectorAll('.pdf-page-item');
      if (items[selectedPdfPage]) items[selectedPdfPage].scrollIntoView({block:'nearest'});
      return;
    }
    if (e.key === 'ArrowUp' && hasPage && selectedPdfPage > 0) {
      e.preventDefault();
      selectPdfPage(selectedPdfPage - 1);
      const items = document.querySelectorAll('.pdf-page-item');
      if (items[selectedPdfPage]) items[selectedPdfPage].scrollIntoView({block:'nearest'});
      return;
    }
    // Duplicate
    if ((e.ctrlKey || e.metaKey) && k === 'd' && hasPage) {
      e.preventDefault();
      duplicatePage(selectedPdfPage);
      return;
    }
  }
});

// ── Init ──
restoreSettings();
updatePreserveQualityUI();
updatePrintSizeUI();
updatePdfContentUI();
try { toggleHints(localStorage.getItem('photopdf-hints') !== '0'); } catch(e) {}
updateChrome();
snapshot('Start');
