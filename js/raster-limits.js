// Bounds for allocations controlled by this application. Browser decoders and
// PDF parsers have their own overhead; these are not a total RAM guarantee.
(function () {
  'use strict';
  const MiB = 1024 * 1024;
  const limits = Object.freeze({ maxSide: 8192, maxPixels: 16000000,
    maxImageBytes: 32 * MiB, maxPdfBytes: 50 * MiB, maxRetainedBytes: 128 * MiB,
    maxPages: 200, maxExportPixels: 64000000, maxCachePixels: 16000000,
    maxPdfPreviewSide: 2400, maxOutputBytes: 128 * MiB });
  const allocations = new Map();
  const rasters = new Map();
  const leases = new Map(), pendingRelease = new Set();
  const downloads = new Map();
  let downloadBytes = 0;
  let retainedBytes = 0, decodeTail = Promise.resolve();

  function fail(message) {
    const error = new Error(message);
    error.name = 'ResourceLimitError';
    throw error;
  }
  function validSize(width, height, integer = true) {
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 &&
      (!integer || (Number.isSafeInteger(width) && Number.isSafeInteger(height)));
  }
  function assertRaster(width, height, label = 'Image') {
    if (!validSize(width, height)) fail(`${label} dimensions must be positive whole numbers.`);
    if (width > limits.maxSide || height > limits.maxSide || width > limits.maxPixels / height) {
      fail(`${label} is too large. Use at most 16 megapixels and 8,192 pixels on either side.`);
    }
    return width * height;
  }
  function assertDecodedImage(image) {
    return assertRaster(image.naturalWidth, image.naturalHeight, 'Decoded image');
  }
  function assertFileBytes(file, kind) {
    const maximum = kind === 'pdf' ? limits.maxPdfBytes : limits.maxImageBytes;
    if (!Number.isSafeInteger(file.size) || file.size < 0) fail('The file size could not be verified.');
    if (file.size > maximum) fail(`${kind === 'pdf' ? 'PDF' : 'Image'} exceeds the ${maximum / MiB} MB file limit.`);
  }
  function preflightFile(file, classification) {
    assertFileBytes(file, classification.kind);
    if (classification.kind === 'image') {
      if (!validSize(classification.width, classification.height)) {
        fail('Image dimensions could not be verified safely. Convert this file to PNG or JPEG first.');
      }
      assertRaster(classification.width, classification.height);
    }
  }
  function assertPageCount(adding, existing = 0) {
    if (!Number.isSafeInteger(adding) || adding < 0 || !Number.isSafeInteger(existing) || existing < 0 ||
        adding > limits.maxPages - existing) fail('A document can contain at most 200 pages.');
  }
  function reserveBytes(key, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) fail('The resource size could not be verified.');
    const previous = allocations.get(key) || 0;
    if (!allocations.has(key) && allocations.size >= 10000) fail('Too many working resources. Reload before adding more.');
    if (bytes > limits.maxRetainedBytes - retainedBytes + previous) {
      fail('The 128 MB working-file limit was reached. Use Free undo history to discard old edits, or export and reload before adding more.');
    }
    allocations.set(key, bytes);
    pendingRelease.delete(key);
    retainedBytes += bytes - previous;
  }
  function releaseBytes(key) {
    if (leases.has(key)) { pendingRelease.add(key); return; }
    retainedBytes -= allocations.get(key) || 0;
    allocations.delete(key);
    rasters.delete(key);
    pendingRelease.delete(key);
  }
  function leaseBytes(key) {
    if (!allocations.has(key)) fail('The original PDF allocation is unavailable. Import the PDF again.');
    leases.set(key, (leases.get(key) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = leases.get(key) - 1;
      if (remaining) leases.set(key, remaining);
      else {
        leases.delete(key);
        if (pendingRelease.has(key)) releaseBytes(key);
      }
    };
  }
  function trackUrl(url, bytes, width, height) {
    if (width !== undefined || height !== undefined) assertRaster(width, height);
    reserveBytes(url, bytes);
    if (width !== undefined) rasters.set(url, { width, height });
  }
  function pdfRenderSize(width, height) {
    if (!validSize(width, height, false)) fail('PDF page dimensions are invalid.');
    const scale = Math.min(2, limits.maxPdfPreviewSide / Math.max(width, height));
    if (!Number.isFinite(scale) || scale <= 0) fail('PDF page dimensions are too large to render.');
    return { scale, width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
  }
  function assertPdfViewport(viewport) {
    if (!validSize(viewport.width, viewport.height, false) ||
        viewport.width > limits.maxPdfPreviewSide + 1e-7 || viewport.height > limits.maxPdfPreviewSide + 1e-7) {
      fail('The PDF page could not be rendered within the 2,400-pixel preview limit.');
    }
  }
  function cacheAdmit(cache, src, image) {
    const cost = assertDecodedImage(image);
    cache.delete(src);
    let total = [...cache.values()].reduce((sum, item) => sum + item.naturalWidth * item.naturalHeight, 0);
    while (cache.size && (cache.size >= 3 || total + cost > limits.maxCachePixels)) {
      const oldest = cache.keys().next().value, entry = cache.get(oldest);
      total -= entry.naturalWidth * entry.naturalHeight;
      cache.delete(oldest);
    }
    cache.set(src, image);
  }
  function enqueueDecode(work, job) {
    const result = decodeTail.then(() => {
      if (job && !job.isCurrent()) {
        const error = new Error('Image import canceled.'); error.name = 'ImportCanceledError'; throw error;
      }
      return work();
    });
    decodeTail = result.catch(() => {});
    return result;
  }
  function assertExport(images, sources, options = {}) {
    assertPageCount(images.length);
    let pixels = 0;
    for (const image of images) {
      if (image.pdfSource && !options.rasterizeNative) continue;
      const raster = rasters.get(image.src) || {};
      const width = raster.width === undefined ? image.pixelWidth : raster.width;
      const height = raster.height === undefined ? image.pixelHeight : raster.height;
      if (width !== undefined || height !== undefined) {
        assertRaster(width, height, 'Export image');
        const angle = (Number(image.rotation) || 0) * Math.PI / 180;
        const outWidth = Math.round(width * Math.abs(Math.cos(angle)) + height * Math.abs(Math.sin(angle)));
        const outHeight = Math.round(width * Math.abs(Math.sin(angle)) + height * Math.abs(Math.cos(angle)));
        pixels += assertRaster(outWidth, outHeight, 'Rotated export image');
      }
    }
    if (pixels > limits.maxExportPixels) fail('This export exceeds 64 megapixels. Export fewer image pages at a time.');
    if (sources) for (const source of sources.values()) assertFileBytes({ size: source.bytes.byteLength }, 'pdf');
  }
  function assertOutputBytes(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limits.maxOutputBytes) {
      fail('The generated PDF exceeds the 128 MB export limit. Export fewer pages at a time.');
    }
  }
  function reserveDownload(key, bytes) {
    assertOutputBytes(bytes);
    const previous = downloads.get(key) || 0;
    if ((!downloads.has(key) && downloads.size >= 10) || bytes > limits.maxOutputBytes - downloadBytes + previous) {
      fail('Previous downloads are still being prepared. Wait 30 seconds, then export again.');
    }
    downloads.set(key, bytes);
    downloadBytes += bytes - previous;
  }
  function releaseDownload(key) {
    downloadBytes -= downloads.get(key) || 0;
    downloads.delete(key);
  }
  window.PhotoPdfLimits = Object.freeze({ limits, assertRaster, assertDecodedImage, assertFileBytes,
    preflightFile, assertPageCount, reserveBytes, releaseBytes, leaseBytes, trackUrl, forgetUrl: releaseBytes,
    pdfRenderSize, assertPdfViewport, cacheAdmit, enqueueDecode, assertExport, assertOutputBytes,
    reserveDownload, releaseDownload,
    stats: () => ({ retainedBytes, allocations: allocations.size, downloadBytes, downloads: downloads.size }) });
})();
