// Large sources are decoded at a bounded working size; never through a full-size
// HTMLImageElement fallback. The worker uses this same implementation.
(function (root) {
  'use strict';
  const MAX_SIDE = 8192, MAX_PIXELS = 16000000, MAX_BYTES = 32 * 1024 * 1024;
  const DECODE_ATTEMPTS = 4, ENCODE_ATTEMPTS = 6;
  const script = typeof document !== 'undefined' && document.currentScript;
  const workerUrl = script && script.src ? new URL('large-image-worker.js', script.src).href : null;

  function canceledError() {
    const error = new Error('Image import canceled.');
    error.name = 'ImportCanceledError';
    return error;
  }
  function failure(message, name = 'ResourceLimitError') {
    const error = new Error(message); error.name = name; return error;
  }
  function checkCurrent(job) {
    if (job && !job.isCurrent()) throw canceledError();
  }
  function validatePlan(plan) {
    if (!plan || !['width', 'height', 'sourceWidth', 'sourceHeight', 'maxBytes'].every(key =>
      Number.isSafeInteger(plan[key]) && plan[key] > 0) || plan.width > MAX_SIDE || plan.height > MAX_SIDE ||
      plan.width > MAX_PIXELS / plan.height || plan.width > plan.sourceWidth || plan.height > plan.sourceHeight ||
      plan.maxBytes > MAX_BYTES) {
      throw failure('The large-image working-size plan is invalid.');
    }
    return { ...plan };
  }
  function reducedSize(width, height, scale) {
    return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
  }
  function fitDecodeWidth(ratio, pixelBudget) {
    let width = Math.max(1, Math.floor(Math.min(MAX_SIDE, MAX_SIDE / ratio, Math.sqrt(pixelBudget / ratio))));
    // The omitted resizeHeight rounds upward, so a continuous-area estimate can
    // exceed the limit by one row, especially for extremely narrow panoramas.
    while (width > 1 && (Math.ceil(width * ratio) > MAX_SIDE || width > pixelBudget / Math.ceil(width * ratio))) width--;
    return width;
  }
  function closeBitmap(bitmap) {
    if (bitmap && typeof bitmap.close === 'function') { try { bitmap.close(); } catch (_) {} }
  }
  function releaseCanvas(canvas) {
    if (canvas) {
      try { canvas.width = 0; } catch (_) {}
      try { canvas.height = 0; } catch (_) {}
    }
  }

  // Cancellation settles promptly even when a browser decoder/encoder cannot be
  // interrupted. Its eventual result is still disposed before it can be used.
  function cancellable(promise, job, discard) {
    if (!job) return Promise.resolve(promise);
    return new Promise((resolve, reject) => {
      let settled = false, stop;
      const finish = (error, value) => {
        if (settled) { if (!error && discard) discard(value); return; }
        settled = true;
        if (stop) stop();
        if (error) reject(error); else resolve(value);
      };
      stop = job.onCancel(() => finish(canceledError()));
      if (settled && stop) stop();
      Promise.resolve(promise).then(value => {
        if (!job.isCurrent()) { if (discard) discard(value); finish(canceledError()); }
        else finish(null, value);
      }, error => finish(error));
    });
  }

  async function decodeBounded(blob, plan, job) {
    if (typeof root.createImageBitmap !== 'function') {
      throw failure('This browser cannot safely resize large images. Try a current browser or a smaller image.', 'NotSupportedError');
    }
    const pixelBudget = plan.width * plan.height;
    const sourceRatio = plan.sourceHeight / plan.sourceWidth;
    // A bounded probe fits both possible EXIF axis orders before the decoder
    // tells us which one it uses. Close it before requesting full resolution.
    let axis = 'width', requestedSize = Math.min(plan.width, fitDecodeWidth(Math.max(sourceRatio, 1 / sourceRatio), pixelBudget));
    let plannedResolution = false, sourceWidth = plan.sourceWidth, sourceHeight = plan.sourceHeight;
    for (let attempt = 0; attempt < DECODE_ATTEMPTS; attempt++) {
      checkCurrent(job);
      let bitmap;
      try {
        const resize = axis === 'width' ? { resizeWidth: requestedSize } : { resizeHeight: requestedSize };
        bitmap = await cancellable(root.createImageBitmap(blob, {
          // A single resize axis preserves the decoder's EXIF-oriented ratio.
          // Passing both raw-header dimensions can stretch rotated JPEGs/PNGs.
          imageOrientation: 'from-image', ...resize, resizeQuality: 'high'
        }), job, closeBitmap);
        checkCurrent(job);
        if (!bitmap || bitmap[axis] !== requestedSize || !Number.isSafeInteger(bitmap.width) || !Number.isSafeInteger(bitmap.height) ||
          bitmap.width < 1 || bitmap.height < 1) {
          throw failure('The browser did not honor the safe large-image decode size.');
        }
        let ratio = bitmap.height / bitmap.width;
        const observedOther = axis === 'width' ? bitmap.height : bitmap.width;
        const originalOther = requestedSize * (axis === 'width' ? sourceRatio : 1 / sourceRatio);
        const rotatedOther = requestedSize * (axis === 'width' ? 1 / sourceRatio : sourceRatio);
        const originalDifference = Math.abs(observedOther - originalOther);
        const rotatedDifference = Math.abs(observedOther - rotatedOther);
        if (observedOther === Math.ceil(originalOther) && originalDifference <= rotatedDifference) ratio = sourceRatio;
        else if (observedOther === Math.ceil(rotatedOther)) {
          ratio = 1 / sourceRatio;
          sourceWidth = plan.sourceHeight; sourceHeight = plan.sourceWidth;
        }
        const oversized = bitmap.width > MAX_SIDE || bitmap.height > MAX_SIDE || bitmap.width > pixelBudget / bitmap.height;
        if (oversized || !plannedResolution) {
          // Dimensions found in a bounded file prefix may omit an orientation
          // tag farther into the file. Re-decode from source at its true ratio.
          // At extreme portrait ratios, even resizeWidth:1 has a tall result.
          // Once its orientation is observed, resize the long axis instead.
          const nextAxis = Math.ceil(ratio) > Math.min(MAX_SIDE, pixelBudget) ? 'height' : 'width';
          const nextSize = nextAxis === 'height'
            ? Math.min(sourceHeight, fitDecodeWidth(1 / ratio, pixelBudget))
            : Math.min(sourceWidth, fitDecodeWidth(ratio, pixelBudget));
          plannedResolution = true;
          if (nextAxis !== axis || nextSize !== requestedSize) {
            closeBitmap(bitmap); bitmap = null;
            axis = nextAxis; requestedSize = nextSize;
            continue;
          }
          if (oversized) throw failure('The browser could not honor the image raster bounds.');
        }
        return { bitmap, sourceWidth, sourceHeight };
      } catch (error) {
        closeBitmap(bitmap);
        if (error.name === 'ImportCanceledError' || job && !job.isCurrent()) throw canceledError();
        // A memory failure lowers the requested working size. A later success
        // must not immediately escalate to the size that just failed.
        plannedResolution = true;
        if (attempt === DECODE_ATTEMPTS - 1 || requestedSize === 1) {
          throw failure('The browser could not decode this large image at a safe working size. Try a smaller image.', 'ImageDecodeError');
        }
        requestedSize = Math.max(1, Math.floor(requestedSize * 0.75));
      }
    }
    throw failure('The browser could not resize this large image within its raster bounds.', 'ImageDecodeError');
  }
  function makeCanvas(width, height) {
    if (typeof root.OffscreenCanvas === 'function') return new root.OffscreenCanvas(width, height);
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const canvas = document.createElement('canvas');
      try { canvas.width = width; canvas.height = height; return canvas; }
      catch (error) { releaseCanvas(canvas); throw error; }
    }
    throw failure('This browser cannot safely create the resized image.', 'NotSupportedError');
  }
  function encodePng(canvas) {
    if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/png' });
    if (typeof canvas.toBlob === 'function') return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(failure('The browser could not encode the resized image.')), 'image/png');
    });
    throw failure('This browser cannot encode the resized image.', 'NotSupportedError');
  }
  function validBlob(blob, maximum) {
    return blob && blob.type === 'image/png' && Number.isSafeInteger(blob.size) && blob.size > 0 && blob.size <= maximum;
  }
  async function normalizeCore(blob, plan, job) {
    plan = validatePlan(plan);
    checkCurrent(job);
    let bitmap;
    try {
      const decoded = await decodeBounded(blob, plan, job);
      bitmap = decoded.bitmap;
      let size = { width: bitmap.width, height: bitmap.height };
      for (let attempt = 0; attempt < ENCODE_ATTEMPTS; attempt++) {
        checkCurrent(job);
        let canvas, scale = 0.75;
        try {
          canvas = makeCanvas(size.width, size.height);
          const context = canvas.getContext('2d', { alpha: true });
          if (!context) throw failure('The browser could not allocate the resized-image canvas.');
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = 'high';
          // Every retry samples the original bounded bitmap, avoiding cumulative
          // blur, and keeps the transparent canvas instead of adding a white fill.
          context.drawImage(bitmap, 0, 0, size.width, size.height);
          const output = await cancellable(encodePng(canvas), job);
          checkCurrent(job);
          if (validBlob(output, plan.maxBytes)) return { blob: output, width: size.width, height: size.height,
            sourceWidth: decoded.sourceWidth, sourceHeight: decoded.sourceHeight };
          if (!output || output.type !== 'image/png' || !Number.isSafeInteger(output.size) || output.size <= 0) {
            throw failure('The browser returned an invalid resized image.');
          }
          scale = Math.min(0.9, Math.sqrt(plan.maxBytes / output.size) * 0.96);
        } catch (error) {
          if (error.name === 'ImportCanceledError' || job && !job.isCurrent()) throw canceledError();
          if (error.name === 'NotSupportedError') throw error;
        } finally { releaseCanvas(canvas); }
        if (attempt === ENCODE_ATTEMPTS - 1 || size.width === 1 && size.height === 1) break;
        size = reducedSize(size.width, size.height, scale);
      }
      throw failure('This large image could not fit the available working-file budget. Free undo history or import fewer pages.');
    } finally { closeBitmap(bitmap); }
  }

  function normalizeInWorker(blob, plan, job) {
    return new Promise((resolve, reject) => {
      let worker, stop, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (stop) stop();
        if (worker) {
          worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
          try { worker.terminate(); } catch (_) {}
        }
        if (error) reject(error); else resolve(value);
      };
      const unavailable = () => finish(failure('The large-image worker is unavailable.', 'WorkerUnavailableError'));
      try {
        checkCurrent(job);
        worker = new root.Worker(workerUrl);
        if (job) {
          stop = job.onCancel(() => finish(canceledError()));
          if (settled) { if (stop) stop(); return; }
        }
        worker.onmessage = event => {
          if (job && !job.isCurrent()) { finish(canceledError()); return; }
          const data = event.data;
          if (data && data.ok === false) {
            const error = failure(data.message || 'The large image could not be resized.', data.name || 'ResourceLimitError');
            finish(error); return;
          }
          const result = data && data.result;
          if (!data || data.ok !== true || !result || !validBlob(result.blob, plan.maxBytes) ||
            !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width < 1 || result.height < 1 ||
            result.width > MAX_SIDE || result.height > MAX_SIDE || result.width > plan.width * plan.height / result.height) {
            finish(failure('The large-image worker returned an invalid working image.')); return;
          }
          finish(null, result);
        };
        worker.onerror = event => { if (event && event.preventDefault) event.preventDefault(); unavailable(); };
        worker.onmessageerror = unavailable;
        worker.postMessage({ blob, plan });
      } catch (error) {
        finish(error.name === 'ImportCanceledError' ? error : failure('The large-image worker could not start.', 'WorkerUnavailableError'));
      }
    });
  }
  async function normalize(blob, plan, job) {
    plan = validatePlan(plan);
    checkCurrent(job);
    if (workerUrl && typeof root.Worker === 'function' && typeof root.OffscreenCanvas === 'function') {
      try { return await normalizeInWorker(blob, plan, job); }
      catch (error) {
        checkCurrent(job);
        if (!['WorkerUnavailableError', 'NotSupportedError'].includes(error.name)) throw error;
      }
    }
    return normalizeCore(blob, plan, job);
  }
  if (typeof document === 'undefined') root.PhotoPdfLargeImageWorkerCore = normalizeCore;
  else root.PhotoPdfLargeImages = Object.freeze({ normalize });
})(typeof window !== 'undefined' ? window : self);
