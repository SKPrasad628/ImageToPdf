// The print desk previews the export geometry without encoding another PDF.
// Native PDF pixels come from the existing import preview, never the PDF writer.
(function () {
  'use strict';
  const MAX_SIDE = 1200;
  let revision = 0, scheduled = null, completedKey = null;
  const element = id => document.getElementById(id);
  const value = (id, fallback) => element(id) ? element(id).value : fallback;
  const mm = number => Number(number.toFixed(1)).toLocaleString();

  function nodes() {
    return {
      paper: element('forgePaper'), canvas: element('forgePreviewCanvas'),
      empty: element('forgePreviewEmpty'), dimensions: element('forgeDimensions'),
      label: element('forgePreviewLabel'), note: element('forgePlacementNote')
    };
  }

  function resetView(message, detail) {
    const ui = nodes();
    if (ui.canvas) {
      ui.canvas.width = 0;
      ui.canvas.height = 0;
      ui.canvas.hidden = true;
    }
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
    if (completedKey === state.key) return;
    const ui = nodes();
    if (!ui.paper || !ui.canvas) return;
    // A new selection never displays the previous page while its decode awaits.
    // Once that completed view is hidden it is no longer reusable: returning
    // to it while a different decode is pending must redraw and restore it.
    completedKey = null;
    ui.canvas.hidden = true;
    if (ui.empty) { ui.empty.hidden = false; ui.empty.textContent = 'Preparing the page preview…'; }
    ui.paper.setAttribute('aria-busy', 'true');
    if (ui.label) ui.label.textContent = `Page ${state.index + 1} of ${state.count} · ${state.image.name || 'Untitled image'}`;
    const source = state.image.src;
    let retained = false;
    try {
      if (typeof retainUrl === 'function') { retainUrl(source); retained = true; }
      const decoded = await loadImage(source);
      if (!current(request, state.key)) return;
      const { layout, rendered, radians } = geometry(state, decoded);
      const scale = MAX_SIDE / Math.max(layout.page.width, layout.page.height);
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
    } catch (error) {
      if (!current(request, state.key)) return;
      completedKey = null;
      resetView('Preview unavailable', error && error.message ? error.message : 'This page could not be previewed. Try importing it again.');
      if (ui.label) ui.label.textContent = `Page ${state.index + 1} of ${state.count} · ${state.image.name || 'Untitled image'}`;
    } finally {
      if (retained && typeof releaseUrl === 'function') releaseUrl(source);
    }
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

  window.PageForgePreview = Object.freeze({ refresh, clear });
  window.addEventListener('pagehide', clear);
  window.addEventListener('pageshow', refresh);
  refresh();
})();
