import { normalizeHttpUrlPrefix, parseSafeHttpUrl } from './url.js';

const WORDPRESS_UPLOADS_MARKER = '/wp-content/uploads/';

/** Normalize media rewrite rules, retaining identity exceptions. */
export function normalizeMediaRewriteOptions(value) {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid base JSON: import must be an object');
  }
  if (!Object.hasOwn(value, 'media_rewrites')) return [];
  const rules = value.media_rewrites;
  if (!Array.isArray(rules) || rules.length > 50) {
    throw new Error('Invalid base JSON: import.media_rewrites must contain at most 50 rules');
  }
  const bySource = new Map();
  for (const [index, rule] of rules.entries()) {
    const field = `import.media_rewrites[${index}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)
      || Object.keys(rule).some((key) => key !== 'from' && key !== 'to')) {
      throw new Error(`Invalid base JSON: ${field} must be a from/to object`);
    }
    const from = normalizeMediaPrefixOrThrow(rule.from, `${field}.from`);
    const to = normalizeMediaPrefixOrThrow(rule.to, `${field}.to`);
    if (bySource.has(from) && bySource.get(from) !== to) {
      throw new Error(`Invalid base JSON: ${field}.from has conflicting destinations`);
    }
    bySource.set(from, to);
  }
  return [...bySource].map(([from, to]) => ({ from, to }))
    .sort((a, b) => b.from.length - a.from.length || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
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

/** Replace original text matches once, without feeding destinations into later rules. */
export function rewriteMediaUrls(value, rules) {
  const text = String(value ?? '');
  if (!rules.length) return text;
  const parts = [];
  // Cache the next match per rule so absent or later prefixes are not rescanned
  // for every URL in a large export. Rules are ordered longest first.
  const next = rules.map((rule) => text.indexOf(rule.from));
  let cursor = 0;
  while (cursor < text.length) {
    let selected = -1;
    for (let index = 0; index < rules.length; index += 1) {
      if (next[index] >= 0 && next[index] < cursor) {
        next[index] = text.indexOf(rules[index].from, cursor);
      }
      if (next[index] >= 0 && (selected < 0 || next[index] < next[selected])) selected = index;
    }
    if (selected < 0) break;
    parts.push(text.slice(cursor, next[selected]), rules[selected].to);
    cursor = next[selected] + rules[selected].from.length;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

export function rewriteMediaUrl(value, rules) {
  const text = String(value ?? '').trim();
  const rule = rules.find(({ from }) => text.startsWith(from));
  return rule ? `${rule.to}${text.slice(rule.from.length)}` : text;
}

function normalizeMediaPrefixOrThrow(value, key) {
  const normalized = normalizeHttpUrlPrefix(value);
  if (!normalized) {
    throw new Error(
      `Invalid base JSON: ${key} must be an absolute HTTP(S) URL prefix without credentials, query, or fragment`,
    );
  }
  return normalized;
}
