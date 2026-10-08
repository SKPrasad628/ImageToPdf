(function (root) {
  'use strict';

  // Read a bounded prefix, never the whole file, before browser image decoding.
  // Header dimensions are a preflight hint; the decoder still verifies the file.
  const HEADER_BYTES = 64 * 1024;
  const FORMAT_MIMES = Object.freeze({
    jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    bmp: 'image/bmp', avif: 'image/avif', pdf: 'application/pdf'
  });
  const EXTENSIONS = Object.freeze({ jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg',
    jfif: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', bmp: 'bmp', avif: 'avif', pdf: 'pdf' });
  const TIFF_REASON = 'TIFF and multipage TIFF are not supported. Convert the file to PNG, JPEG, or PDF first.';
  const ascii = (bytes, start, count) => String.fromCharCode(...bytes.subarray(start, start + count));
  const uint24le = (bytes, start) => bytes[start] | bytes[start + 1] << 8 | bytes[start + 2] << 16;

  function dimensions(bytes, format) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (format === 'png' && bytes.length >= 24 && ascii(bytes, 12, 4) === 'IHDR') {
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (format === 'gif' && bytes.length >= 10) {
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    if (format === 'bmp' && bytes.length >= 26) {
      const dibSize = view.getUint32(14, true);
      if (dibSize === 12) return { width: view.getUint16(18, true), height: view.getUint16(20, true) };
      if (dibSize >= 40) return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
    }
    if (format === 'jpeg') {
      // SOF records supply dimensions without expanding compressed image pixels.
      for (let offset = 2; offset + 3 < bytes.length;) {
        if (bytes[offset++] !== 0xff) break;
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0x01 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7) continue;
        if (offset + 2 > bytes.length) break;
        const length = view.getUint16(offset);
        if (length < 2 || offset + length > bytes.length) break;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
          return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
        }
        offset += length;
      }
    }
    if (format === 'webp') {
      for (let offset = 12; offset + 8 <= bytes.length;) {
        const kind = ascii(bytes, offset, 4), size = view.getUint32(offset + 4, true), start = offset + 8;
        if (kind === 'VP8X' && size >= 10 && start + 10 <= bytes.length) {
          return { width: uint24le(bytes, start + 4) + 1, height: uint24le(bytes, start + 7) + 1 };
        }
        if (kind === 'VP8L' && size >= 5 && start + 5 <= bytes.length && bytes[start] === 0x2f) {
          const bits = view.getUint32(start + 1, true);
          return { width: (bits & 0x3fff) + 1, height: (bits >>> 14 & 0x3fff) + 1 };
        }
        if (kind === 'VP8 ' && size >= 10 && start + 10 <= bytes.length &&
            bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
          return { width: view.getUint16(start + 6, true) & 0x3fff, height: view.getUint16(start + 8, true) & 0x3fff };
        }
        offset = start + size + (size & 1);
      }
    }
    return {};
  }

  function signature(bytes) {
    if (bytes.length >= 4 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && (bytes[2] === 42 || bytes[2] === 43) && bytes[3] === 0) ||
        (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && (bytes[3] === 42 || bytes[3] === 43)))) return 'tiff';
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
    if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return 'gif';
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
    if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
    if (bytes.length >= 16 && ascii(bytes, 4, 4) === 'ftyp') {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const end = Math.min(bytes.length, view.getUint32(0));
      if (['avif', 'avis'].includes(ascii(bytes, 8, 4))) return 'avif';
      for (let offset = 16; offset + 4 <= end; offset += 4) {
        if (['avif', 'avis'].includes(ascii(bytes, offset, 4))) return 'avif';
      }
    }
    // PDF readers accept the header within the first 1,024 bytes.
    if (/%PDF-\d\.\d/.test(ascii(bytes, 0, Math.min(bytes.length, 1024)))) return 'pdf';
    return null;
  }

  async function classifyFile(file) {
    const name = String(file && file.name || 'Unnamed file');
    const extension = (name.match(/\.([^.]+)$/) || [])[1];
    const ext = extension && extension.toLowerCase();
    const type = String(file && file.type || '').toLowerCase().split(';')[0].trim();
    let header = new Uint8Array();
    if (file && typeof file.slice === 'function') {
      try { header = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer()); }
      catch (_) { return { kind: 'unsupported', format: 'unknown', reason: 'The file could not be read.' }; }
    }
    const detected = signature(header);
    if (detected === 'tiff' || !detected && (['tif', 'tiff'].includes(ext) || ['image/tiff', 'image/x-tiff'].includes(type))) {
      return { kind: 'unsupported', format: 'tiff', reason: TIFF_REASON };
    }
    const byMime = Object.keys(FORMAT_MIMES).find(format => FORMAT_MIMES[format] === type);
    const format = detected || EXTENSIONS[ext] || byMime;
    if (!format) {
      return { kind: 'unsupported', format: 'unknown', reason: 'Unsupported format. Use JPEG, PNG, WebP, GIF, BMP, or PDF.' };
    }
    return { kind: format === 'pdf' ? 'pdf' : 'image', format, mime: FORMAT_MIMES[format],
      signatureDetected: Boolean(detected), headerBytes: header.byteLength, ...dimensions(header, detected) };
  }

  root.PhotoPdfFileIntake = Object.freeze({ classifyFile, HEADER_BYTES });
})(typeof window !== 'undefined' ? window : globalThis);
