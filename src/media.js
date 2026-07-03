import { normalizeHttpUrlPrefix, parseSafeHttpUrl } from './url.js';

const WORDPRESS_UPLOADS_MARKER = '/wp-content/uploads/';

export function normalizeMediaRewriteOptions(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid media rewrite options: expected an object');
  }

  const hasFrom = Object.hasOwn(value, 'media_from');
  const hasTo = Object.hasOwn(value, 'media_to');
  if (!hasFrom && !hasTo) {
    return null;
  }
  if (hasFrom !== hasTo) {
    throw new Error('Invalid media rewrite options: media_from and media_to must be provided together');
  }

  const from = normalizeMediaPrefixOrThrow(value.media_from, 'media_from');
  const to = normalizeMediaPrefixOrThrow(value.media_to, 'media_to');

  return from === to ? null : { from, to };
}

/**
 * Derive the uploads prefix an attachment URL belongs to.
 *
 * Only the exact default WordPress uploads prefix counts, so a custom upload
 * path leaves media rewriting unconfigured instead of guessing.
 */
export function inferWordPressMediaPrefixFromAttachmentUrl(value) {
  if (typeof value !== 'string' || !parseSafeHttpUrl(value)) {
    return null;
  }

  const schemeEnd = value.indexOf('://') + 3;
  const pathStart = value.indexOf('/', schemeEnd);
  if (pathStart < 0) {
    return null;
  }

  const queryStart = value.indexOf('?', pathStart);
  const fragmentStart = value.indexOf('#', pathStart);
  const pathEnd = Math.min(
    queryStart < 0 ? value.length : queryStart,
    fragmentStart < 0 ? value.length : fragmentStart,
  );
  const rawPath = value.slice(pathStart, pathEnd);
  const markerIndex = rawPath.indexOf(WORDPRESS_UPLOADS_MARKER);
  if (markerIndex < 0 || markerIndex + WORDPRESS_UPLOADS_MARKER.length >= rawPath.length) {
    return null;
  }

  return normalizeHttpUrlPrefix(
    value.slice(0, pathStart + markerIndex + WORDPRESS_UPLOADS_MARKER.length),
  );
}

export function rewriteMediaUrls(value, rewrite) {
  const text = String(value ?? '');
  if (!rewrite || rewrite.from === rewrite.to) {
    return text;
  }

  return text.split(rewrite.from).join(rewrite.to);
}

export function rewriteMediaUrl(value, rewrite) {
  const text = String(value ?? '').trim();
  if (!text) {
    return '';
  }
  if (!rewrite || rewrite.from === rewrite.to || !text.startsWith(rewrite.from)) {
    return text;
  }
  return `${rewrite.to}${text.slice(rewrite.from.length)}`;
}

function normalizeMediaPrefixOrThrow(value, key) {
  const normalized = normalizeHttpUrlPrefix(value);
  if (!normalized) {
    throw new Error(
      `Invalid media rewrite options: ${key} must be an absolute HTTP(S) URL prefix without credentials, query, or fragment`,
    );
  }
  return normalized;
}
