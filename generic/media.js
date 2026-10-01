import { fail } from '../core/errors.js';
const ascii = (bytes, start, end) => bytes.subarray(start, end).toString('ascii');
const has = (bytes, prefix) => bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(Buffer.from(prefix));
export const uploadFormats = Object.freeze({
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'video/mp4': 'mp4', 'video/x-msvideo': 'avi', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
  'application/zip': 'zip',
});
export function signature(bytes, extension) {
  if (!bytes.length) return false;
  if (extension === 'png') return has(bytes, [137, 80, 78, 71, 13, 10, 26, 10]);
  if (extension === 'jpg') return has(bytes, [255, 216, 255]);
  if (extension === 'webp') return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP';
  if (extension === 'wav') return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE';
  if (extension === 'flac') return ascii(bytes, 0, 4) === 'fLaC';
  if (extension === 'mp3') return ascii(bytes, 0, 3) === 'ID3' || bytes.length >= 3 && bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 8 && (bytes[1] & 6) !== 0;
  if (extension === 'mp4') return bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp';
  if (extension === 'mov') return bytes.length >= 8 && ['ftyp', 'moov', 'mdat', 'wide'].includes(ascii(bytes, 4, 8));
  if (extension === 'avi') return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'AVI ';
  if (extension === 'mkv') return has(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
  if (extension === 'zip') return has(bytes, [0x50, 0x4b, 3, 4]) || has(bytes, [0x50, 0x4b, 5, 6]) || has(bytes, [0x50, 0x4b, 7, 8]);
  return false;
}
export function admitFile(blob, raw) {
  const extension = uploadFormats[blob.mediaType];
  const bytes = raw instanceof Uint8Array ? Buffer.from(raw) : undefined;
  if (!extension || !bytes || !bytes.length || bytes.length !== blob.size || bytes.length > 30 * 1024 * 1024) fail('UNSUPPORTED_REFERENCE_MEDIA');
  if (!signature(bytes, extension)) fail('REFERENCE_SIGNATURE_MISMATCH');
  return { bytes, extension };
}
export function safeMime(contentType) {
  if (!contentType) return 'application/octet-stream';
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) fail('DOWNLOAD_MEDIA_MISMATCH');
  return mime;
}
