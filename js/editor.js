// ══════════════════════════════════════
//  EDITOR MODAL
// ══════════════════════════════════════
// A session borrows store sources and owns only explicitly created intermediates.
// All URL leases use the same refcounts as imgStore, including in-flight work.
let editorSession = null;
let editorSessionCounter = 0;
let editorTab = 'rotate';
let editorPreviewRequest = 0;
let editorSizeRequest = 0;

function isEditorSessionCurrent(session) {
  return !!session && session.active && editorSession === session;
}

function isEditorSourceCurrent(session, generation, src) {
  return isEditorSessionCurrent(session) && session.generation === generation && editorCurrentSrc === src;
}

function discardEditorOutput(url) {
  // A generated thumbnail may alias its source; never revoke a retained URL.
  if ((!isBlobUrl(url) && !(typeof url === 'string' && url.startsWith('data:'))) || _urlRefs.has(url)) return;
  forgetImage(url);
  if (window.PhotoPdfLimits) window.PhotoPdfLimits.forgetUrl(url);
  if (isBlobUrl(url)) URL.revokeObjectURL(url);
}

function updateEditorControls(session = editorSession) {
  if (session && !isEditorSessionCurrent(session)) return;
  const busy = !!(session && (session.saving || session.pending));
  document.querySelectorAll('#editorModal .modal-body button, #editorModal .modal-body input')
    .forEach(control => {
      const isSave = control.id === 'saveChangesBtn' || control.id === 'applyAllBtn';
      control.disabled = isSave ? !!(session && session.saving) : busy;
    });
}

function setEditorSrc(url, { temporary = false, session = editorSession } = {}) {
  if (!isEditorSessionCurrent(session)) {
    if (temporary) discardEditorOutput(url);
    return false;
  }
  const previous = editorCurrentSrc;
  if (temporary && !session.borrowedUrls.has(url) && !session.tempUrls.has(url)) {
    retainUrl(url);
    session.tempUrls.add(url);
  }
  editorCurrentSrc = url;
  if (temporary) session.pdfSource = undefined;
  if (previous !== url && session.tempUrls.delete(previous)) releaseUrl(previous);
  return true;
}

function releaseEditorTemps(session) {
  session.tempUrls.forEach(releaseUrl);
  session.tempUrls.clear();
}

function canChangeEditor() {
  return isEditorSessionCurrent(editorSession) && !editorSession.saving;
}

function resetEditorSource() {
  if (!canChangeEditor()) return false;
  // Cancel queued/running applies so a late result cannot undo the reset.
  editorSession.generation++;
  editorPreviewRequest++;
  editorSizeRequest++;
  editorSession.pdfPageSizeMm = copyPdfPageSize(editorSession.originalPdfPageSizeMm);
  editorSession.pdfSource = editorSession.originalPdfSource
    ? { ...editorSession.originalPdfSource } : undefined;
  editorSession.filterRecipe = [];
  // Source resets keep the visible pending sliders. Those retained values
  // still belong to this page until the user chooses another filter step.
  editorSession.pendingFilterBaseline = { ...editorFilters };
  return setEditorSrc(editorOriginalSrc);
}

function queueEditorOperation(label, produce, afterApply) {
  const session = editorSession;
  if (!canChangeEditor()) return Promise.resolve(false);
  const generation = session.generation;
  session.pending++;
  updateEditorControls(session);
  const operation = session.queue.then(async () => {
    if (!isEditorSessionCurrent(session) || session.generation !== generation) return false;
    const src = editorCurrentSrc;
    retainUrl(src);
    let output;
    try {
      const img = await loadImage(src);
      if (!isEditorSourceCurrent(session, generation, src)) return false;
      output = await produce(img);
      if (!isEditorSourceCurrent(session, generation, src)) {
        discardEditorOutput(output);
        output = null;
        return false;
      }
      setEditorSrc(output, { temporary: true, session });
      output = null; // ownership moved to the session
      afterApply();
      return true;
    } catch (err) {
      if (isEditorSessionCurrent(session) && session.generation === generation) {
        session.failures++;
        showToast(`⚠️ Could not ${label}. ${err && err.message || 'Please try again.'}`);
      }
      return false;
    } finally {
      if (output) discardEditorOutput(output);
      releaseUrl(src);
    }
  });
  session.queue = operation.finally(() => {
    session.pending--;
    if (isEditorSessionCurrent(session)) updateEditorControls(session);
  });
  return session.queue;
}

async function encodeEditorCanvas(cvs) {
  try {
    // Working pixels stay lossless, including alpha. Export alone chooses JPEG
    // compression, so a later edit never decodes an already-compressed edit.
    const { url } = await canvasToUrl(cvs, undefined, 'image/png');
    if (!url || url === 'data:,') throw new Error('Image encoding failed');
    return url;
  } finally {
    cvs.width = 0;
    cvs.height = 0;
  }
}

function openEditorFor(i) {
  if (!Number.isInteger(i) || !images[i]) return;
  if (editorSession) closeEditor();
  const image = images[i];
  editingIndex = i;
  editorOriginalSrc = image.originalSrc || image.src;
  editorCurrentSrc = image.src;
  const borrowedUrls = new Set([editorOriginalSrc, editorCurrentSrc]);
  borrowedUrls.forEach(retainUrl);
  editorSession = {
    id: ++editorSessionCounter, imageId: image._id, imageFingerprint: JSON.stringify(image), active: true,
    generation: 0, queue: Promise.resolve(), pending: 0, failures: 0,
    saving: false, borrowedUrls, tempUrls: new Set(), filterRecipe: [],
    pendingFilterBaseline: { ...(image.filters || {}) },
    pdfSource: image.pdfSource ? { ...image.pdfSource } : undefined,
    originalPdfSource: image.originalPdfSource ? { ...image.originalPdfSource } : undefined,
    pdfPageSizeMm: copyPdfPageSize(image.pdfPageSizeMm),
    originalPdfPageSizeMm: copyPdfPageSize(image.originalPdfPageSizeMm || image.pdfPageSizeMm)
  };
  editorRotation = image.rotation || 0;
  editorFlipH = image.flipH || false;
  editorFlipV = image.flipV || false;
  editorFilters = {...(image.filters||{})};
  const pdfWarning = document.getElementById('editorPdfWarning');
  if (pdfWarning) pdfWarning.hidden = !(image.pdfSource || image.originalPdfSource);
  document.getElementById('editorModalTitle').textContent = `Edit: ${image.name}`;
  // Capture the trigger before the browser moves focus into the top layer.
  _editorReturnFocus = document.activeElement;
  _editorReturnPageId = pageIdentity(image);
  const dialog = document.getElementById('editorModal');
  dialog.classList.add('on');
  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  updateEditorControls();
  switchEditorTab('rotate');
  loadEditorPreview();
  document.getElementById('editorCloseBtn').focus();
}

let _editorReturnFocus = null;
let _editorReturnPageId = null;
function restoreEditorFocus() {
  const trigger = _editorReturnFocus;
  const index = images.findIndex(image => pageIdentity(image) === _editorReturnPageId);
  const fallbackIndex = index >= 0 ? index : selectedConvertCard;
  const pageControl = Number.isInteger(fallbackIndex) && images[fallbackIndex]
    ? document.querySelector(`[data-preview-page="${fallbackIndex}"]`) : null;
  const fallback = pageControl || document.getElementById('fileInput');
  const target = trigger && trigger.isConnected && !trigger.disabled && trigger.tagName !== 'BODY'
    && (!trigger.getClientRects || trigger.getClientRects().length > 0)
    ? trigger : fallback;
  if (target && typeof target.focus === 'function') target.focus();
  _editorReturnFocus = null;
  _editorReturnPageId = null;
}

function closeEditor({ restoreFocus = true } = {}) {
  const session = editorSession;
  if (session) {
    session.active = false;
    session.generation++;
  }
  editorSession = null;
  editorPreviewRequest++;
  editorSizeRequest++;
  const dialog = document.getElementById('editorModal');
  if (dialog.open && typeof dialog.close === 'function') dialog.close();
  dialog.classList.remove('on');
  editingIndex = null;
  teardownCropDrag();
  cropCachedImg = null;
  if (session) {
    releaseEditorTemps(session);
    session.borrowedUrls.forEach(releaseUrl);
    session.borrowedUrls.clear();
  }
  editorCurrentSrc = null;
  editorOriginalSrc = null;
  _imgCache.clear(); // release full-res editor bitmaps
  // Saving rebuilds the page rail, so it restores focus after that render.
  if (restoreFocus) restoreEditorFocus();
  updateEditorControls();
}

document.getElementById('editorModal').addEventListener('cancel', event => {
  event.preventDefault();
  closeEditor();
});

function loadEditorPreview() {
  renderPreviewCanvas(editorCurrentSrc);
  document.getElementById('currentAngleDisplay').textContent = editorRotation + '°';
  document.getElementById('customAngle').value = editorRotation;
  updateSizeInfo();
  resetFilterSliders();
}

let _previewRaf = null;
function renderPreviewCanvas(src) {
  // Dragging a filter slider fires far faster than we can repaint; collapse
  // bursts into one redraw per frame.
  if (_previewRaf) cancelAnimationFrame(_previewRaf);
  const session = editorSession, generation = session && session.generation;
  const request = ++editorPreviewRequest;
  const rot = editorRotation, fh = editorFlipH, fv = editorFlipV;
  const filters = { ...editorFilters };
  _previewRaf = requestAnimationFrame(() => {
    _previewRaf = null;
    if (!isEditorSourceCurrent(session, generation, src) || editorTab === 'crop') return;
    loadImage(src).then(img => {
      if (!isEditorSourceCurrent(session, generation, src) || request !== editorPreviewRequest || editorTab === 'crop') return;
      const cvs = document.getElementById('previewCanvas');
      if (!cvs) return;
      const ctx = cvs.getContext('2d');
      const MAX = 480;
      let w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.min(MAX/w, MAX/h, 1);
      w = Math.round(w*scale); h = Math.round(h*scale);
      const rad = (rot * Math.PI) / 180;
      const cw = Math.abs(w*Math.cos(rad)) + Math.abs(h*Math.sin(rad));
      const ch = Math.abs(w*Math.sin(rad)) + Math.abs(h*Math.cos(rad));
      cvs.width = Math.round(cw); cvs.height = Math.round(ch);
      ctx.save();
      ctx.translate(cvs.width/2, cvs.height/2);
      ctx.rotate(rad);
      ctx.scale(fh ? -1 : 1, fv ? -1 : 1);
      ctx.filter = buildFilterStringFrom(filters);
      ctx.drawImage(img, -w/2, -h/2, w, h);
      ctx.restore();
    }).catch(() => {
      if (isEditorSourceCurrent(session, generation, src) && request === editorPreviewRequest) showToast('⚠️ Could not display this image');
    });
  });
}

function buildFilterString() { return buildFilterStringFrom(editorFilters); }
// Takes an explicit filter set so bulk operations can bake a transform without
// depending on the live editor state.
function buildFilterStringFrom(filters) {
  if (Array.isArray(filters)) {
    return filters.map(buildFilterStringFrom).filter(value => value !== 'none').join(' ') || 'none';
  }
  const f = filters || {};
  let s = '';
  if (f.brightness !== undefined) s += `brightness(${f.brightness}%) `;
  if (f.contrast !== undefined) s += `contrast(${f.contrast}%) `;
  if (f.saturate !== undefined) s += `saturate(${f.saturate}%) `;
  if (f.blur !== undefined && f.blur > 0) s += `blur(${f.blur}px) `;
  if (f.grayscale !== undefined && f.grayscale > 0) s += `grayscale(${f.grayscale}%) `;
  if (f.sepia !== undefined && f.sepia > 0) s += `sepia(${f.sepia}%) `;
  if (f['hue-rotate'] !== undefined && f['hue-rotate'] > 0) s += `hue-rotate(${f['hue-rotate']}deg) `;
  if (f.invert !== undefined && f.invert > 0) s += `invert(${f.invert}%) `;
  return s.trim() || 'none';
}

function teardownCropDrag() {
  const cvs = document.getElementById('previewCanvas');
  if (!cvs) return;
  cvs.onmousedown = null;
  cvs.ontouchstart = null;
  if (cvs._cropMoveHandler)  { document.removeEventListener('mousemove', cvs._cropMoveHandler);  cvs._cropMoveHandler  = null; }
  if (cvs._cropUpHandler)    { document.removeEventListener('mouseup',   cvs._cropUpHandler);    cvs._cropUpHandler    = null; }
  if (cvs._cropTMoveHandler) { document.removeEventListener('touchmove', cvs._cropTMoveHandler); cvs._cropTMoveHandler = null; }
  if (cvs._cropTUpHandler)   { document.removeEventListener('touchend',  cvs._cropTUpHandler);   cvs._cropTUpHandler   = null; }
  cropDragging = false;
}

function switchEditorTab(name) {
  if (!canChangeEditor()) return;
  editorTab = name;
  editorPreviewRequest++;
  document.querySelectorAll('.et').forEach(e => e.classList.remove('on'));
  document.querySelector(`.et[onclick="switchEditorTab('${name}')"]`).classList.add('on');
  document.querySelectorAll('.et-panel').forEach(p => p.style.display = 'none');
  document.getElementById('panel-' + name).style.display = 'block';
  if (name === 'crop') {
    setupCropMode();
  } else {
    // Leaving crop: tear down crop drag so it doesn't bleed into other tabs
    teardownCropDrag();
    cropCachedImg = null;
    if (name === 'resize') updateSizeInfo();
    else renderPreviewCanvas(editorCurrentSrc);
  }
}

// ── ROTATE ──
function quickRotate(deg, reset=false) {
  if (!canChangeEditor()) return;
  if (reset) { editorRotation = 0; }
  else { editorRotation = ((editorRotation + deg) % 360 + 360) % 360; }
  document.getElementById('currentAngleDisplay').textContent = editorRotation + '°';
  document.getElementById('customAngle').value = editorRotation;
  renderPreviewCanvas(editorCurrentSrc);
}
function applyCustomAngle() {
  if (!canChangeEditor()) return;
  editorRotation = ((parseInt(document.getElementById('customAngle').value)||0) % 360 + 360) % 360;
  document.getElementById('currentAngleDisplay').textContent = editorRotation + '°';
  renderPreviewCanvas(editorCurrentSrc);
}

// ── RESIZE ──
function updateSizeInfo() {
  const session = editorSession, generation = session && session.generation;
  const src = editorCurrentSrc, request = ++editorSizeRequest;
  loadImage(src).then(img => {
    if (!isEditorSourceCurrent(session, generation, src) || request !== editorSizeRequest) return;
    document.getElementById('resW').value = img.naturalWidth;
    document.getElementById('resH').value = img.naturalHeight;
    showSizeInfo(img.naturalWidth, img.naturalHeight, img.naturalWidth, img.naturalHeight);
  }).catch(() => {});
}
function showSizeInfo(ow, oh, nw, nh) {
  document.getElementById('sizeInfo').innerHTML =
    `<span>Current: <strong>${ow}×${oh}px</strong></span>
     <span>Requested: <strong class="live-size">${nw}×${nh}px</strong></span>
     <span>File size depends on image content and is measured after export.</span>`;
}
function onResizeInput(changed) {
  if (!canChangeEditor()) return;
  const session = editorSession, generation = session.generation;
  const src = editorCurrentSrc, request = ++editorSizeRequest;
  const lock = document.getElementById('lockAR').checked;
  let w = Math.max(1, parseInt(document.getElementById('resW').value)||1);
  let h = Math.max(1, parseInt(document.getElementById('resH').value)||1);
  loadImage(src).then(img => {
    if (!isEditorSourceCurrent(session, generation, src) || request !== editorSizeRequest) return;
    if (lock) {
      const ar = img.naturalWidth / img.naturalHeight;
      if (changed === 'w') { h = Math.max(1, Math.round(w / ar)); document.getElementById('resH').value = h; }
      else { w = Math.max(1, Math.round(h * ar)); document.getElementById('resW').value = w; }
    }
    showSizeInfo(img.naturalWidth, img.naturalHeight, w, h);
  }).catch(() => {});
}
function setResizePercent(pct) {
  if (!canChangeEditor()) return;
  const session = editorSession, generation = session.generation;
  const src = editorCurrentSrc, request = ++editorSizeRequest;
  loadImage(src).then(img => {
    if (!isEditorSourceCurrent(session, generation, src) || request !== editorSizeRequest) return;
    const w = Math.max(1, Math.round(img.naturalWidth * pct / 100));
    const h = Math.max(1, Math.round(img.naturalHeight * pct / 100));
    document.getElementById('resW').value = w;
    document.getElementById('resH').value = h;
    showSizeInfo(img.naturalWidth, img.naturalHeight, w, h);
  }).catch(() => {});
}
function applyResize() {
  const w = Number(document.getElementById('resW').value);
  const h = Number(document.getElementById('resH').value);
  try {
    if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1) {
      throw new Error('Enter positive whole-number dimensions.');
    }
    if (window.PhotoPdfLimits) window.PhotoPdfLimits.assertRaster(w, h, 'Resize');
  } catch (error) {
    showToast(`⚠️ Could not resize. ${error.message}`);
    return Promise.resolve(false);
  }
  return queueEditorOperation('resize', async img => {
    const cvs = document.createElement('canvas');
    cvs.width = w; cvs.height = h;
    const ctx = cvs.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return encodeEditorCanvas(cvs);
  }, () => {
    renderPreviewCanvas(editorCurrentSrc);
    updateSizeInfo();
  });
}
function resetResize() {
  if (!resetEditorSource()) return;
  renderPreviewCanvas(editorCurrentSrc);
  updateSizeInfo();
}

// ── CROP ──
let cropImgNaturalW=0, cropImgNaturalH=0, cropCanvasScale=1;
let cropCachedImg = null; // cached image element so drawCropOverlay never reloads it

// Convert a mouse event position into canvas-internal pixel coordinates,
// accounting for any CSS scaling between the canvas element's displayed size
// and its internal resolution (canvas.width / canvas.height).
function getCanvasPos(cvs, e) {
  const r = cvs.getBoundingClientRect();
  const scaleX = cvs.width  / r.width;
  const scaleY = cvs.height / r.height;
  return {
    x: (e.clientX - r.left) * scaleX,
    y: (e.clientY - r.top)  * scaleY
  };
}

function setupCropMode() {
  const cvs = document.getElementById('previewCanvas');
  cropCachedImg = null; // reset cache
  const session = editorSession, generation = session && session.generation;
  const src = editorCurrentSrc, request = ++editorPreviewRequest;
  loadImage(src).then(img => {
    if (!isEditorSourceCurrent(session, generation, src) || request !== editorPreviewRequest || editorTab !== 'crop') return;
    cropImgNaturalW = img.naturalWidth;
    cropImgNaturalH = img.naturalHeight;
    const MAX = 480;
    const scale = Math.min(MAX / img.naturalWidth, MAX / img.naturalHeight, 1);
    cropCanvasScale = scale;
    cvs.width  = Math.round(img.naturalWidth  * scale);
    cvs.height = Math.round(img.naturalHeight * scale);
    cropCachedImg = img; // store for fast redraws
    cropRect = {x:0, y:0, w:cvs.width, h:cvs.height};
    drawCropOverlay();
    updateCropInputs();
    setupCropDrag();
  }).catch(() => {
    if (isEditorSourceCurrent(session, generation, src) && request === editorPreviewRequest && editorTab === 'crop') showToast('⚠️ Could not load image for cropping');
  });
}

function drawCropOverlay() {
  const cvs = document.getElementById('previewCanvas');
  const ctx = cvs.getContext('2d');
  if (!cropCachedImg) return; // not ready yet

  // 1. Draw the base image
  ctx.drawImage(cropCachedImg, 0, 0, cvs.width, cvs.height);

  // 2. Dark overlay over the whole canvas
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, cvs.width, cvs.height);

  // 3. Punch a clear hole where the crop selection is, then redraw image there
  if (cropRect.w > 0 && cropRect.h > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
    ctx.clip();
    ctx.drawImage(cropCachedImg, 0, 0, cvs.width, cvs.height);
    ctx.restore();

    // 4. Crop border
    ctx.strokeStyle = '#2040e8';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cropRect.x + 0.5, cropRect.y + 0.5, cropRect.w, cropRect.h);

    // 5. Rule-of-thirds grid inside the crop
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 0.75;
    for (let t = 1; t < 3; t++) {
      const gx = cropRect.x + cropRect.w * t / 3;
      const gy = cropRect.y + cropRect.h * t / 3;
      ctx.beginPath(); ctx.moveTo(gx, cropRect.y); ctx.lineTo(gx, cropRect.y + cropRect.h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cropRect.x, gy); ctx.lineTo(cropRect.x + cropRect.w, gy); ctx.stroke();
    }

    // 6. Corner handles
    const hs = 7; // handle size
    ctx.fillStyle = '#2040e8';
    [[cropRect.x, cropRect.y],[cropRect.x+cropRect.w, cropRect.y],
     [cropRect.x, cropRect.y+cropRect.h],[cropRect.x+cropRect.w, cropRect.y+cropRect.h]]
      .forEach(([hx,hy]) => ctx.fillRect(hx - hs/2, hy - hs/2, hs, hs));
  }
}

function setupCropDrag() {
  const cvs = document.getElementById('previewCanvas');

  // Tear down any previous handlers to prevent leaking into other tabs
  cvs.onmousedown = null;
  cvs.ontouchstart = null;
  if (cvs._cropMoveHandler) { document.removeEventListener('mousemove', cvs._cropMoveHandler); cvs._cropMoveHandler = null; }
  if (cvs._cropUpHandler)   { document.removeEventListener('mouseup',   cvs._cropUpHandler);   cvs._cropUpHandler   = null; }
  if (cvs._cropTMoveHandler) { document.removeEventListener('touchmove', cvs._cropTMoveHandler); cvs._cropTMoveHandler = null; }
  if (cvs._cropTUpHandler)   { document.removeEventListener('touchend',  cvs._cropTUpHandler);   cvs._cropTUpHandler   = null; }

  // Helper: get canvas position from any pointer event (mouse or touch)
  function posFromEvent(e) {
    const src = e.touches ? e.touches[0] : e;
    return getCanvasPos(cvs, { clientX: src.clientX, clientY: src.clientY });
  }

  function onCropMove(e) {
    if (!cropDragging) return;
    e.preventDefault();
    const pos = posFromEvent(e);
    const x = pos.x, y = pos.y;
    cropRect = {
      x: Math.max(0, Math.min(cropStart.x, x)),
      y: Math.max(0, Math.min(cropStart.y, y)),
      w: Math.abs(x - cropStart.x),
      h: Math.abs(y - cropStart.y)
    };
    // Clamp to canvas bounds
    cropRect.w = Math.min(cropRect.w, cvs.width  - cropRect.x);
    cropRect.h = Math.min(cropRect.h, cvs.height - cropRect.y);
    drawCropOverlay();
    updateCropInputs();
  }

  function onCropUp(e) {
    cropDragging = false;
  }

  cvs._cropMoveHandler  = onCropMove;
  cvs._cropUpHandler    = onCropUp;
  cvs._cropTMoveHandler = onCropMove;
  cvs._cropTUpHandler   = onCropUp;

  function startCrop(e) {
    if (!canChangeEditor() || editorSession.pending) return;
    if (document.getElementById('panel-crop').style.display === 'none') return;
    e.preventDefault();
    cropDragging = true;
    const pos = posFromEvent(e);
    cropStart = pos;
    cropRect = {x: pos.x, y: pos.y, w: 0, h: 0};
  }

  cvs.onmousedown = startCrop;
  cvs.ontouchstart = startCrop;

  // Attach move/up to document so dragging outside canvas still works
  document.addEventListener('mousemove', onCropMove);
  document.addEventListener('mouseup',   onCropUp);
  document.addEventListener('touchmove', onCropMove, { passive: false });
  document.addEventListener('touchend',  onCropUp);
}

function updateCropInputs() {
  const s = cropCanvasScale || 1;
  document.getElementById('cropX').value = Math.round(cropRect.x / s);
  document.getElementById('cropY').value = Math.round(cropRect.y / s);
  document.getElementById('cropW').value = Math.round(cropRect.w / s) || cropImgNaturalW;
  document.getElementById('cropH').value = Math.round(cropRect.h / s) || cropImgNaturalH;
}

function updateCropFromInputs() {
  if (!canChangeEditor()) return;
  const cvs = document.getElementById('previewCanvas');
  const s = cropCanvasScale || 1;
  let x = (parseInt(document.getElementById('cropX').value) || 0) * s;
  let y = (parseInt(document.getElementById('cropY').value) || 0) * s;
  let w = (parseInt(document.getElementById('cropW').value) || cropImgNaturalW) * s;
  let h = (parseInt(document.getElementById('cropH').value) || cropImgNaturalH) * s;
  // Keep the selection inside the image: an out-of-bounds source rect makes
  // drawImage emit blank bands (which then bake in as black on JPEG export).
  x = Math.max(0, Math.min(x, cvs.width  - 1));
  y = Math.max(0, Math.min(y, cvs.height - 1));
  w = Math.max(1, Math.min(w, cvs.width  - x));
  h = Math.max(1, Math.min(h, cvs.height - y));
  cropRect = { x, y, w, h };
  drawCropOverlay();
}

function applyCrop() {
  if (!cropCachedImg) return;
  const s = cropCanvasScale || 1;
  const x = cropRect.x / s, y = cropRect.y / s;
  const w = Math.max(1, cropRect.w / s), h = Math.max(1, cropRect.h / s);
  // Draw from the original editorCurrentSrc at natural resolution
  return queueEditorOperation('crop', async img => {
    if (window.PhotoPdfLimits) window.PhotoPdfLimits.assertRaster(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)), 'Crop');
    const cvs = document.createElement('canvas');
    cvs.width = w; cvs.height = h;
    const ctx = cvs.getContext('2d');
    ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
    return encodeEditorCanvas(cvs);
  }, () => {
    cropCachedImg = null;
    setupCropMode();
  });
}

function resetCrop() {
  if (!resetEditorSource()) return;
  cropCachedImg = null;
  setupCropMode();
}

function setCropPreset(rw, rh) {
  if (!canChangeEditor()) return;
  const cvs = document.getElementById('previewCanvas');
  const aspect = rw / rh;
  let w, h;
  if (cvs.width / cvs.height > aspect) { h = cvs.height; w = h * aspect; }
  else { w = cvs.width; h = w / aspect; }
  cropRect = {x:(cvs.width-w)/2, y:(cvs.height-h)/2, w, h};
  updateCropInputs();
  drawCropOverlay();
}

// ── FLIP ──
function applyFlip(dir) {
  if (!canChangeEditor()) return;
  if (dir==='h'||dir==='both') editorFlipH=!editorFlipH;
  if (dir==='v'||dir==='both') editorFlipV=!editorFlipV;
  renderPreviewCanvas(editorCurrentSrc);
}
function resetFlip() { if (!canChangeEditor()) return; editorFlipH=false; editorFlipV=false; renderPreviewCanvas(editorCurrentSrc); }

// ── FILTERS ──
function updateFilter(name, val, unit) {
  if (!canChangeEditor()) return;
  editorFilters[name] = parseFloat(val);
  setEditorFilterValue(name, editorFilters[name]);
  renderPreviewCanvas(editorCurrentSrc);
}
function setEditorFilterValue(name, value) {
  const unit = name === 'blur' ? 'px' : name === 'hue-rotate' ? '°' : '%';
  const spokenUnit = name === 'blur' ? (value === 1 ? 'pixel' : 'pixels')
    : name === 'hue-rotate' ? (value === 1 ? 'degree' : 'degrees') : 'percent';
  const slider = document.getElementById(`f-${name}`);
  if (slider) slider.setAttribute('aria-valuetext', `${value} ${spokenUnit}`);
  const output = document.getElementById(`fv-${name}`);
  if (output) output.textContent = value + unit;
}
function resetFilterSliders() {
  const defaults = {brightness:100,contrast:100,saturate:100,blur:0,grayscale:0,sepia:0,'hue-rotate':0,invert:0};
  Object.entries(defaults).forEach(([k,v]) => {
    const el = document.getElementById(`f-${k}`);
    if (el) el.value = editorFilters[k]!==undefined ? editorFilters[k] : v;
    setEditorFilterValue(k, editorFilters[k] !== undefined ? editorFilters[k] : v);
  });
}
function applyFilters() {
  const filters = { ...editorFilters };
  const session = editorSession;
  return queueEditorOperation('apply filters', async img => {
    if (window.PhotoPdfLimits) window.PhotoPdfLimits.assertDecodedImage(img);
    const cvs = document.createElement('canvas');
    cvs.width=img.naturalWidth; cvs.height=img.naturalHeight;
    const ctx=cvs.getContext('2d');
    ctx.filter = buildFilterStringFrom(filters);
    ctx.drawImage(img,0,0);
    return encodeEditorCanvas(cvs);
  }, () => {
    // The current source already contains this step. Other pages receive the
    // recipe once, in order, when Apply to all commits the session.
    if (hasEditorPixelTransform(0, false, false, filters)) session.filterRecipe.push(filters);
    editorFilters={};
    session.pendingFilterBaseline = {};
    resetFilterSliders();
    renderPreviewCanvas(editorCurrentSrc);
  });
}
function resetFilters() {
  if (!canChangeEditor()) return;
  editorFilters={};
  resetFilterSliders();
  renderPreviewCanvas(editorCurrentSrc);
}

// Eight sliders is a lot of fiddling for what are, in practice, three or four
// recurring looks. "Document" is tuned for scanned text: drop colour, push
// contrast and brightness so paper goes white and ink goes black.
const FILTER_PRESETS = {
  document:  { grayscale:100, contrast:165, brightness:115, saturate:0 },
  grayscale: { grayscale:100, contrast:105, brightness:100 },
  vivid:     { saturate:150, contrast:115, brightness:104 },
  soften:    { blur:1, brightness:104, contrast:96, saturate:106 }
};
function applyFilterPreset(name) {
  if (!canChangeEditor()) return;
  const p = FILTER_PRESETS[name];
  if (!p) return;
  editorFilters = { ...p };
  resetFilterSliders();
  renderPreviewCanvas(editorCurrentSrc);
  showToast(`Preset: ${name}`);
}

// ── SAVE / REVERT ──
// Prepare pixels without mutating the document. A save commits all prepared
// pages together, only if the editor and captured document are still current.
function hasEditorPixelTransform(rot, fh, fv, filters) {
  if (((rot || 0) % 360 + 360) % 360 || fh || fv) return true;
  if (Array.isArray(filters)) return filters.some(step => hasEditorPixelTransform(0, false, false, step));
  const defaults = { brightness: 100, contrast: 100, saturate: 100,
    blur: 0, grayscale: 0, sepia: 0, 'hue-rotate': 0, invert: 0 };
  return Object.entries(defaults).some(([name, neutral]) =>
    filters && filters[name] !== undefined && filters[name] !== neutral);
}

function editorTransformFingerprint(rot, fh, fv, filters) {
  const defaults = { brightness: 100, contrast: 100, saturate: 100,
    blur: 0, grayscale: 0, sepia: 0, 'hue-rotate': 0, invert: 0 };
  return JSON.stringify([((rot || 0) % 360 + 360) % 360, !!fh, !!fv,
    Object.entries(defaults).map(([name, neutral]) =>
      filters && filters[name] !== undefined ? filters[name] : neutral)]);
}

async function bakeTransform(srcUrl, rot, fh, fv, filters) {
  const img = await loadImage(srcUrl);
  const rad = (rot * Math.PI) / 180;
  const bw = Math.abs(img.naturalWidth*Math.cos(rad))+Math.abs(img.naturalHeight*Math.sin(rad));
  const bh = Math.abs(img.naturalWidth*Math.sin(rad))+Math.abs(img.naturalHeight*Math.cos(rad));
  if (window.PhotoPdfLimits) window.PhotoPdfLimits.assertRaster(Math.round(bw), Math.round(bh), 'Rotated image');
  const cvs = document.createElement('canvas');
  cvs.width=Math.round(bw); cvs.height=Math.round(bh);
  const ctx=cvs.getContext('2d');
  ctx.translate(cvs.width/2,cvs.height/2);
  ctx.rotate(rad);
  ctx.scale(fh?-1:1, fv?-1:1);
  ctx.filter = buildFilterStringFrom(filters);
  ctx.drawImage(img,-img.naturalWidth/2,-img.naturalHeight/2);
  const finalSrc = await encodeEditorCanvas(cvs);
  try {
    const thumb = await generateThumb(finalSrc);
    return { src: finalSrc, thumb };
  } catch (err) {
    discardEditorOutput(finalSrc);
    throw err;
  }
}

function editorDocumentFingerprint() {
  return JSON.stringify(images.map(image => ({
    ...image, filters: { ...(image.filters || {}) }
  })));
}

async function saveEdits(applyToAll = false) {
  const session = editorSession;
  if (!isEditorSessionCurrent(session) || session.saving) return false;
  session.saving = true;
  updateEditorControls(session);
  const failuresBeforeSave = session.failures;
  const staged = [], leasedUrls = new Set();
  let committed = false;
  try {
    // Finish every accepted Apply before capturing the pixels/filters to save.
    await session.queue;
    if (!isEditorSessionCurrent(session)) return false;
    if (session.failures !== failuresBeforeSave) {
      showToast('⚠️ The pending edit failed. Review the image before saving.');
      return false;
    }
    const currentImage = images.find(image => image._id === session.imageId);
    if (!currentImage || JSON.stringify(currentImage) !== session.imageFingerprint) {
      showToast('⚠️ This page changed or was removed. Reopen its editor.');
      return false;
    }
    const rot = editorRotation, fh = editorFlipH, fv = editorFlipV;
    const filters = { ...editorFilters };
    const sameTransform = editorTransformFingerprint(rot, fh, fv, filters) ===
      editorTransformFingerprint(currentImage.rotation, currentImage.flipH, currentImage.flipV, currentImage.filters);
    const sourceChanged = editorCurrentSrc !== currentImage.src ||
      JSON.stringify(session.pdfPageSizeMm) !== JSON.stringify(currentImage.pdfPageSizeMm);
    const rotationDelta = rot - (currentImage.rotation || 0);
    const flipHDelta = !!fh !== !!currentImage.flipH;
    const flipVDelta = !!fv !== !!currentImage.flipV;
    const pendingFiltersChanged = editorTransformFingerprint(0, false, false, filters) !==
      editorTransformFingerprint(0, false, false, session.pendingFilterBaseline);
    const filterRecipe = session.filterRecipe.map(step => ({ ...step }));
    // Existing pending filters belong to this page. Only a changed selection,
    // or an explicitly applied step, is added over other pages' own effects.
    if (pendingFiltersChanged && hasEditorPixelTransform(0, false, false, filters)) filterRecipe.push(filters);
    const hasBulkEdit = ((rotationDelta % 360 + 360) % 360) !== 0 ||
      flipHDelta || flipVDelta || filterRecipe.length > 0;
    if (sameTransform && !sourceChanged && (!applyToAll || !hasBulkEdit)) {
      // Opening and saving a page with a pending page-list rotation must keep
      // its native PDF text and source bytes. Only a changed editor state bakes.
      // Apply to all without a chosen edit must leave other pages' individual
      // pending rotations/filters alone as well as preserve this page's bytes.
      committed = true;
      closeEditor();
      showToast('✓ No changes to save');
      return true;
    }
    const currentId = session.imageId;
    const targets = (applyToAll ? images : [currentImage]).map(image => {
      const isCurrent = image._id === currentId;
      const targetRotation = isCurrent ? rot : ((image.rotation || 0) + rotationDelta + 360) % 360;
      const targetFlipH = isCurrent ? fh : !!image.flipH !== flipHDelta;
      const targetFlipV = isCurrent ? fv : !!image.flipV !== flipVDelta;
      const targetFilters = isCurrent ? filters : [{ ...(image.filters || {}) }, ...filterRecipe];
      const changed = isCurrent ? sourceChanged || !sameTransform : hasBulkEdit;
      return {
        ...image, filters: { ...(image.filters || {}) }, changed,
        inputPageSizeMm: copyPdfPageSize(isCurrent ? session.pdfPageSizeMm : image.pdfPageSizeMm),
        inputPdfSource: isCurrent ? session.pdfSource : image.pdfSource,
        inputSrc: isCurrent ? editorCurrentSrc : image.src,
        targetRotation, targetFlipH, targetFlipV, targetFilters,
        needsBake: changed && hasEditorPixelTransform(targetRotation, targetFlipH, targetFlipV, targetFilters)
      };
    });
    const revision = documentRevision, fingerprint = editorDocumentFingerprint();
    targets.forEach(target => {
      leasedUrls.add(target.inputSrc);
      leasedUrls.add(target.originalSrc || target.src);
    });
    leasedUrls.forEach(retainUrl);
    const unchanged = () => isEditorSessionCurrent(session) &&
      documentRevision === revision && editorDocumentFingerprint() === fingerprint;

    for (const target of targets) {
      if (!unchanged()) break;
      // Resize/crop/Apply already produced the working pixels. Saving those
      // pixels, or simply opening and saving an untouched image, needs no
      // additional canvas round trip.
      const result = target.needsBake
        ? await bakeTransform(target.inputSrc, target.targetRotation, target.targetFlipH, target.targetFlipV, target.targetFilters)
        : { src: target.inputSrc, thumb: target.inputSrc === target.src
          ? target.thumb : await generateThumb(target.inputSrc) };
      staged.push({ target, result });
      if (!unchanged()) break;
      if (applyToAll && targets.length > 3) {
        showToast(`Applying to all… ${staged.length}/${targets.length}`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    if (!unchanged() || staged.length !== targets.length) {
      if (isEditorSessionCurrent(session)) showToast('⚠️ The document changed while saving. Your edits were not applied; please save again.');
      return false;
    }

    // Locate every captured version before the synchronous commit. New store
    // IDs preserve the previous pixels for undo; array positions are never used
    // as identities across an asynchronous boundary.
    const updates = staged.filter(({ target }) => target.changed).map(({ target, result }) => {
      const image = images.find(candidate => candidate._id === target._id);
      if (!image) throw new Error('A page was removed while saving');
      return { image, id: _imgId(), pdfPageSizeMm: rotatedPdfPageSize(target.inputPageSizeMm, target.targetRotation),
        pdfSource: !target.needsBake
          ? target.inputPdfSource || (target.inputSrc === target.originalSrc ? target.originalPdfSource : undefined) : undefined,
        entry: {
        src: result.src, thumb: result.thumb, originalSrc: target.originalSrc || target.src
      } };
    });
    updates.forEach(({ image, id, entry, pdfPageSizeMm, pdfSource }) => {
      putStore(id, entry);
      Object.assign(image, entry, { _pageId: pageIdentity(image), _id: id, pdfPageSizeMm,
        rotation: 0, flipH: false, flipV: false, filters: {} });
      // Only an untouched original PDF page can be exported as native PDF.
      // A real pixel edit requires a raster page; Revert can restore the source.
      if (pdfSource) image.pdfSource = { ...pdfSource };
      else delete image.pdfSource;
    });
    committed = true;
    if (updates.length) snapshot(applyToAll ? 'Apply to all' : 'Edit image');
    closeEditor({ restoreFocus: false });
    refreshAll();
    restoreEditorFocus();
    showToast(!updates.length ? '✓ No changes to save' : applyToAll
      ? `✓ Applied to ${updates.length} image${updates.length > 1 ? 's' : ''}` : '✓ Changes saved');
    return true;
  } catch (err) {
    if (isEditorSessionCurrent(session)) showToast(`⚠️ Could not save changes. ${err && err.message || 'Please try again.'}`);
    return false;
  } finally {
    if (!committed) {
      const outputs = new Set();
      staged.forEach(({ result }) => { outputs.add(result.src); outputs.add(result.thumb); });
      outputs.forEach(discardEditorOutput);
    }
    leasedUrls.forEach(releaseUrl);
    session.saving = false;
    if (isEditorSessionCurrent(session)) updateEditorControls(session);
  }
}
function revertAll() {
  if (!resetEditorSource()) return;
  editorRotation=0; editorFlipH=false; editorFlipV=false; editorFilters={};
  editorSession.pendingFilterBaseline = {};
  loadEditorPreview();
}

