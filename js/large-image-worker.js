// One worker handles one source; terminating it cancels its decoder and canvas.
'use strict';
importScripts('large-image.js');
self.onmessage = async function (event) {
  try {
    const result = await self.PhotoPdfLargeImageWorkerCore(event.data.blob, event.data.plan);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, name: error.name || 'Error', message: error.message || 'Image resizing failed.' });
  }
};
