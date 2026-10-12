// The print desk previews the export geometry without encoding another PDF.
// Native PDF pixels come from the existing import preview, never the PDF writer.
(function () {
  'use strict';
  const MAX_SIDE = 1200;
  const MAX_ZOOM_SIDE = 2400;
  const ZOOM_STEPS = [1, 1.25, 1.5, 2, 3, 4];
  let revision = 0, scheduled = null, completedKey = null;
  let completedSide = 0, viewKey = null, zoom = 1, fitWidth = 0, pan = null;
  const element = id => document.getElementById(id);
  const value = (id, fallback) => element(id) ? element(id).value : fallback;
  const mm = number => Number(number.toFixed(1)).toLocaleString();

  function nodes() {
    return {
      paper: element('forgePaper'), canvas: element('forgePreviewCanvas'),
      empty: element('forgePreviewEmpty'), dimensions: element('forgeDimensions'),
      label: element('forgePreviewLabel'), note: element('forgePlacementNote'),
      stage: element('forgePreviewStage')
    };
  }

  function zoomControls() {
    const ui = nodes();
    const ready = !!ui.canvas && !ui.canvas.hidden && completedKey === snapshot()?.key;
    const label = element('previewZoomLabel');
    if (label) label.textContent = `${Math.round(zoom * 100)}%`;
    const hint = element('previewInteractionHint');
    if (hint) hint.hidden = !ready || zoom === 1;
    if (element('previewZoomIn')) element('previewZoomIn').disabled = !ready || zoom >= 4;
    if (element('previewZoomOut')) element('previewZoomOut').disabled = !ready || zoom <= 1;
    if (element('previewZoomFit')) element('previewZoomFit').disabled = zoom === 1;
  }

  function endPan() {
    const stage = nodes().stage;
    const previous = pan;
    pan = null;
    if (previous && stage?.releasePointerCapture) {
      try { stage.releasePointerCapture(previous.id); } catch (_) { /* Capture may already be released. */ }
    }
    stage?.classList.remove('is-panning');
  }

  function resetZoom() {
    endPan();
    zoom = 1;
    fitWidth = 0;
    const ui = nodes();
    if (ui.paper) {
      ui.paper.style.width = '';
      ui.paper.style.maxWidth = '';
      ui.paper.style.flexShrink = '';
    }
    if (ui.stage) {
      ui.stage.classList.remove('is-zoomed');
      ui.stage.scrollLeft = 0;
      ui.stage.scrollTop = 0;
    }
    zoomControls();
  }

  function setZoom(next) {
    if (!Number.isFinite(next)) return;
    // The displayed percentage and the wheel mode must agree at 100%.
    next = Math.min(4, Math.max(1, Math.round(next * 100) / 100));
    if (next === zoom) return;
    const ui = nodes(), state = snapshot();
    if (next > 1 && (!ui.stage || !ui.paper || ui.canvas?.hidden || completedKey !== state?.key)) return;
    if (next === 1) {
      resetZoom();
      refresh();
      return;
    }
    endPan();
    const paper = ui.paper.getBoundingClientRect(), stage = ui.stage.getBoundingClientRect();
    if (zoom === 1) fitWidth = paper.width;
    if (!fitWidth) return;
    // Keep the page point at the center of the viewport in view after scaling.
    const anchorX = stage.left + ui.stage.clientWidth / 2;
    const anchorY = stage.top + ui.stage.clientHeight / 2;
    const x = Math.max(0, Math.min(1, (anchorX - paper.left) / paper.width));
    const y = Math.max(0, Math.min(1, (anchorY - paper.top) / paper.height));
    const height = paper.height / zoom * next;
    zoom = next;
    ui.stage.classList.add('is-zoomed');
    ui.paper.style.width = `${fitWidth * zoom}px`;
    ui.paper.style.maxWidth = 'none';
    ui.paper.style.flexShrink = '0';
    const padding = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(ui.stage) : null;
    ui.stage.scrollLeft = Math.max(0, (parseFloat(padding?.paddingLeft) || 0) + x * fitWidth * zoom - ui.stage.clientWidth / 2);
    ui.stage.scrollTop = Math.max(0, (parseFloat(padding?.paddingTop) || 0) + y * height - ui.stage.clientHeight / 2);
    zoomControls();
    refresh();
  }

  function zoomIn() { setZoom(ZOOM_STEPS.find(step => step > zoom + 1e-6) || 4); }
  function zoomOut() { setZoom([...ZOOM_STEPS].reverse().find(step => step < zoom - 1e-6) || 1); }

  function resetView(message, detail) {
    const ui = nodes();
    if (ui.canvas) {
      ui.canvas.width = 0;
      ui.canvas.height = 0;
      ui.canvas.hidden = true;
    }
    resetZoom();
    if (ui.paper) {
      ui.paper.style.aspectRatio = '210 / 297';
      ui.paper.style.setProperty('--forge-paper-ratio', String(210 / 297));
      ui.paper.setAttribute('aria-busy', 'false');
    }
    if (ui.empty) { ui.empty.hidden = false; ui.empty.textContent = message; }
    if (ui.dimensions) ui.dimensions.textContent = 'Output preview';
    if (ui.label) ui.label.textContent = 'Your manuscript awaits';
    if (ui.note) ui.note.textContent = detail;
  }

  function clear() {
    revision++;
    completedKey = null;
    completedSide = 0;
    viewKey = null;
    if (scheduled !== null) {
      window.cancelAnimationFrame(scheduled);
      scheduled = null;
    }
    resetView('Add images to preview your PDF', 'The selected page will appear here with its final paper size and placement.');
  }

  function snapshot() {
    const list = typeof images === 'undefined' ? [] : images;
    const selected = typeof selectedConvertCard === 'undefined' ? null : selectedConvertCard;
    const index = Number.isInteger(selected) && list[selected] ? selected : 0;
    const current = list[index];
    if (!current) return null;
    const image = { ...current, filters: { ...(current.filters || {}) },
      pdfPageSizeMm: current.pdfPageSizeMm ? { ...current.pdfPageSizeMm } : undefined,
      pdfSource: current.pdfSource ? { ...current.pdfSource } : undefined };
    const settings = {
      pageSize: value('pageSize', 'a4'), orientation: value('orientation', 'auto'),
      imgFit: value('imgFit', 'contain'), margin: Math.max(0, parseFloat(value('margin', '0')) || 0),
      dpi: Number(value('printDpi', '300')), oversize: value('oversize', 'shrink')
    };
    const native = !!image.pdfSource && value('pdfContentMode', 'preserve') !== 'images';
    const preserve = typeof preserveOriginalQuality !== 'undefined' && preserveOriginalQuality;
    const identity = typeof pageIdentity === 'function' ? pageIdentity(current) : current._id;
    const key = JSON.stringify([identity, index, list.length, image.src, image.name,
      image.rotation, image.flipH, image.flipV, image.filters, image.pdfPageSizeMm,
      image.pdfSource, native, preserve, settings]);
    return { image, index, count: list.length, settings, native, preserve, key };
  }

  function current(request, key) {
    if (request !== revision) return false;
    const state = snapshot();
    return !!state && state.key === key;
  }

  function geometry(state, decoded) {
    const rotation = ((Number(state.image.rotation) || 0) % 360 + 360) % 360;
    const radians = rotation * Math.PI / 180;
    const width = decoded.naturalWidth, height = decoded.naturalHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('This image has no readable dimensions.');
    }
    // Match preparePdfImage's rounded canvas dimensions, including oblique turns.
    const rendered = {
      w: Math.round(width * Math.abs(Math.cos(radians)) + height * Math.abs(Math.sin(radians))),
      h: Math.round(width * Math.abs(Math.sin(radians)) + height * Math.abs(Math.cos(radians)))
    };
    if (!state.native) return { layout: computePdfLayout(state.image, rendered, state.settings), rendered, radians };
    if (rotation % 90 || state.image.flipH || state.image.flipV || Object.keys(state.image.filters).length) {
      throw new Error('Save this page’s edits or choose Images to preview this transformation.');
    }
    const page = rotatedPdfPageSize(state.image.pdfPageSizeMm, rotation);
    if (!page || !Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) {
      throw new Error('The original PDF paper size is unavailable. Import this PDF again.');
    }
    return { layout: { page, image: { x: 0, y: 0, width: page.width, height: page.height }, clip: null }, rendered, radians };
  }

  function placementNote(state, layout) {
    if (state.native) {
      return 'Native PDF page · saved paper size and rotation. Layout controls do not alter this page. The raster preview does not show every PDF interaction or annotation.';
    }
    const name = state.settings.pageSize === 'fit' ? 'Fit to image' : state.settings.pageSize.toUpperCase();
    const margin = Math.min(state.settings.margin, layout.page.width * 0.4, layout.page.height * 0.4);
    const mode = state.settings.imgFit === 'actual' ? 'Print size' : state.settings.imgFit === 'fill' ? 'Fill' : 'Contain';
    const detail = layout.cropped ? 'Content is cropped within the margins.' : layout.scaledDown
      ? 'Content is scaled down to fit the margins.' : 'The full image is visible.';
    const dpi = !state.image.pdfPageSizeMm && (state.settings.imgFit === 'actual' || state.settings.pageSize === 'fit')
      ? ` · ${state.settings.dpi} DPI` : '';
    return `${name} · ${mode} · ${mm(margin)} mm margins${dpi}. ${detail}`;
  }

  async function paint(request) {
    const state = snapshot();
    if (!state) { clear(); return; }
    if (viewKey !== state.key) {
      viewKey = state.key;
      resetZoom();
    }
    const side = Math.min(MAX_ZOOM_SIDE, Math.round(MAX_SIDE * zoom));
    if (completedKey === state.key && completedSide === side) {
      nodes().paper?.setAttribute('aria-busy', 'false');
      zoomControls();
      return;
    }
    const ui = nodes();
    if (!ui.paper || !ui.canvas) return;
    // A new selection never displays the previous page while its decode awaits.
    // Once that completed view is hidden it is no longer reusable: returning
    // to it while a different decode is pending must redraw and restore it.
    // Keep the existing page visible while a sharper zoom render is prepared.
    if (completedKey !== state.key) {
      completedKey = null;
      ui.canvas.hidden = true;
      if (ui.empty) { ui.empty.hidden = false; ui.empty.textContent = 'Preparing the page preview…'; }
    }
    zoomControls();
    ui.paper.setAttribute('aria-busy', 'true');
    if (ui.label) ui.label.textContent = `Page ${state.index + 1} of ${state.count} · ${state.image.name || 'Untitled image'}`;
    const source = state.image.src;
    let retained = false;
    try {
      if (typeof retainUrl === 'function') { retainUrl(source); retained = true; }
      const decoded = await loadImage(source);
      if (!current(request, state.key)) return;
      const { layout, rendered, radians } = geometry(state, decoded);
      const scale = side / Math.max(layout.page.width, layout.page.height);
      const canvas = ui.canvas;
      canvas.width = Math.max(1, Math.round(layout.page.width * scale));
      canvas.height = Math.max(1, Math.round(layout.page.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The browser could not draw the preview.');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.save();
      try {
        context.scale(canvas.width / layout.page.width, canvas.height / layout.page.height);
        if (layout.clip) {
          context.beginPath();
          context.rect(layout.clip.x, layout.clip.y, layout.clip.width, layout.clip.height);
          context.clip();
        }
        const box = layout.image;
        context.translate(box.x + box.width / 2, box.y + box.height / 2);
        context.scale(box.width / rendered.w, box.height / rendered.h);
        context.rotate(radians);
        context.scale(state.image.flipH ? -1 : 1, state.image.flipV ? -1 : 1);
        // Editor saves usually bake filters into src. The quality-preserving
        // writer also applies any remaining filter recipe; mirror that path.
        if (state.preserve && Object.keys(state.image.filters).length && typeof buildFilterStringFrom === 'function') {
          context.filter = buildFilterStringFrom(state.image.filters);
        }
        context.drawImage(decoded, -decoded.naturalWidth / 2, -decoded.naturalHeight / 2);
      } finally { context.restore(); }
      ui.paper.style.aspectRatio = `${layout.page.width} / ${layout.page.height}`;
      ui.paper.style.setProperty('--forge-paper-ratio', String(layout.page.width / layout.page.height));
      ui.paper.setAttribute('aria-busy', 'false');
      canvas.hidden = false;
      if (ui.empty) ui.empty.hidden = true;
      if (ui.dimensions) ui.dimensions.textContent = `${mm(layout.page.width)} × ${mm(layout.page.height)} mm`;
      if (ui.note) ui.note.textContent = placementNote(state, layout);
      canvas.setAttribute('aria-label', `PDF output preview, page ${state.index + 1}: ${state.image.name || 'Untitled image'}`);
      completedKey = state.key;
      completedSide = side;
      zoomControls();
    } catch (error) {
      if (!current(request, state.key)) return;
      completedKey = null;
      completedSide = 0;
      resetView('Preview unavailable', error && error.message ? error.message : 'This page could not be previewed. Try importing it again.');
      if (ui.label) ui.label.textContent = `Page ${state.index + 1} of ${state.count} · ${state.image.name || 'Untitled image'}`;
    } finally {
      if (retained && typeof releaseUrl === 'function') releaseUrl(source);
    }
  }

  const stage = nodes().stage;
  if (stage) {
    stage.addEventListener('pointerdown', event => {
      // Touch uses the browser's native two-axis scrolling in the viewport.
      if (zoom <= 1 || event.pointerType === 'touch' || event.button !== 0) return;
      pan = { id: event.pointerId, x: event.clientX, y: event.clientY,
        left: stage.scrollLeft, top: stage.scrollTop };
      stage.setPointerCapture?.(event.pointerId);
      stage.classList.add('is-panning');
      stage.focus({ preventScroll: true });
      event.preventDefault();
    });
    stage.addEventListener('pointermove', event => {
      if (!pan || pan.id !== event.pointerId) return;
      stage.scrollLeft = pan.left + pan.x - event.clientX;
      stage.scrollTop = pan.top + pan.y - event.clientY;
      event.preventDefault();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(name => stage.addEventListener(name, endPan));
    stage.addEventListener('keydown', event => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const steps = { ArrowLeft: [-64, 0], ArrowRight: [64, 0], ArrowUp: [0, -64], ArrowDown: [0, 64] };
      if (zoom > 1 && steps[event.key]) {
        stage.scrollLeft += steps[event.key][0];
        stage.scrollTop += steps[event.key][1];
      } else if (event.key === '+' || event.key === '=') zoomIn();
      else if (event.key === '-') zoomOut();
      else if (event.key === '0' || (event.key === 'Escape' && zoom > 1)) setZoom(1);
      else return;
      event.preventDefault();
      event.stopPropagation(); // Arrow panning must not switch document pages.
    });
    stage.addEventListener('wheel', event => {
      const ui = nodes();
      if (!event.deltaY || event.shiftKey || event.altKey || event.metaKey
        || Math.abs(event.deltaX || 0) > Math.abs(event.deltaY)) return;
      if (!ui.canvas || ui.canvas.hidden || completedKey !== snapshot()?.key) return;
      // Fit leaves ordinary scrolling to the document. Once enlarged, the
      // wheel zooms until Fit is reached; dragging/arrow keys still pan.
      if (zoom === 1 && !event.ctrlKey) return;
      event.preventDefault();
      setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });
  }

  function refresh() {
    revision++;
    if (scheduled !== null) window.cancelAnimationFrame(scheduled);
    scheduled = window.requestAnimationFrame(() => {
      scheduled = null;
      // paint handles decode and geometry errors without leaking rejections.
      void paint(revision);
    });
  }

  window.PageForgePreview = Object.freeze({ refresh, clear, zoom: setZoom, zoomIn, zoomOut, fit: () => setZoom(1) });
  window.addEventListener('pagehide', clear);
  window.addEventListener('pageshow', refresh);
  window.addEventListener('resize', () => { if (zoom > 1) setZoom(1); });
  zoomControls();
  refresh();
})();
