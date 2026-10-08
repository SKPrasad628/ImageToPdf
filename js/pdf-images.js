// Preserve the current image's available detail: reuse encoded JPEG/PNG data
// where safe, otherwise export decoded pixels without another lossy encoding.
// Browser decoding and earlier editor operations still define available detail.
function pdfHasJpegSignature(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function pdfHasPngSignature(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return bytes.length >= 8 && signature.every((byte, i) => bytes[i] === byte);
}

function pdfCanEmbedJpeg(bytes) {
  // PDF image streams do not apply EXIF orientation. Normalize any EXIF-bearing
  // JPEG through the browser decoder, including mirrored/180-degree cases.
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda) return true; // start of encoded scan
    if (marker === 0xd9) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return false;
    if (marker === 0xe1 && length >= 8 &&
        bytes[offset + 2] === 69 && bytes[offset + 3] === 120 &&
        bytes[offset + 4] === 105 && bytes[offset + 5] === 102 &&
        bytes[offset + 6] === 0 && bytes[offset + 7] === 0) return false;
    offset += length;
  }
  return false;
}

function pdfCanEmbedPng(bytes) {
  // PNG can carry EXIF orientation too. Unknown/truncated chunks use the safe
  // decoded-pixel path rather than passing malformed data to the PDF writer.
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes[offset] * 16777216 + bytes[offset + 1] * 65536 +
      bytes[offset + 2] * 256 + bytes[offset + 3];
    if (length > bytes.length - offset - 12) return false;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'eXIf') return false;
    if (type === 'IEND') return true;
    offset += length + 12;
  }
  return false;
}

async function preparePdfImage(image, options = {}) {
  const limits = typeof window !== 'undefined' ? window.PhotoPdfLimits : null;
  let decoded;
  try { decoded = await loadImage(image.src); } catch (error) {
    if (error && error.name === 'ResourceLimitError') throw error;
    return null;
  }
  if (limits) limits.assertDecodedImage(decoded);
  const preserve = !!options.preserveQuality;
  const rotation = ((image.rotation || 0) % 360 + 360) % 360;
  const hasFilters = Object.keys(image.filters || {}).length > 0;
  if (preserve && rotation === 0 && !image.flipH && !image.flipV && !hasFilters) {
    try {
      const response = await fetch(image.src);
      if (!response.ok) throw new Error('Could not read image bytes');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (limits) limits.assertOutputBytes(bytes.byteLength);
      let format = null;
      if (pdfHasJpegSignature(bytes) && pdfCanEmbedJpeg(bytes)) format = 'JPEG';
      if (pdfHasPngSignature(bytes) && pdfCanEmbedPng(bytes)) format = 'PNG';
      if (format) return { data: bytes, format, w: decoded.naturalWidth, h: decoded.naturalHeight };
    } catch (error) {
      if (error && error.name === 'ResourceLimitError') throw error;
      // An already decoded image can still be exported without added JPEG loss.
    }
  }

  const radians = rotation * Math.PI / 180;
  // Snap right angles to exact dimensions, avoiding floating-point extra pixels.
  const cosine = Math.abs(Math.cos(radians)), sine = Math.abs(Math.sin(radians));
  const width = Math.round(decoded.naturalWidth * cosine + decoded.naturalHeight * sine);
  const height = Math.round(decoded.naturalWidth * sine + decoded.naturalHeight * cosine);
  if (limits) limits.assertRaster(width, height, 'Export canvas');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext('2d');
    if (!preserve) {
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(radians);
    context.scale(image.flipH ? -1 : 1, image.flipV ? -1 : 1);
    if (preserve && hasFilters) context.filter = buildFilterStringFrom(image.filters);
    context.drawImage(decoded, -decoded.naturalWidth / 2, -decoded.naturalHeight / 2);
    const format = preserve ? 'PNG' : 'JPEG';
    const data = preserve ? canvas.toDataURL('image/png') :
      canvas.toDataURL('image/jpeg', options.quality === undefined ? exportQuality() : options.quality);
    if (data === 'data:,') throw new Error('The image is too large to encode');
    return { data, format, w: canvas.width, h: canvas.height };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
