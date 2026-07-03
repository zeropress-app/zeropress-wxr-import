import {
  generateContentSlug,
  normalizeStoredSlug,
  validateSlugSegment,
} from '@zeropress/slug-policy';

export function normalizeSlugSegment(value) {
  const source = normalizeStoredSlug(String(value ?? ''));
  if (!source) {
    return '';
  }

  const normalized = source
    .trim()
    .replace(/[\s/\\%?#\u0000-\u001F\u007F]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .replace(/^-+|-+$/g, '');

  if (!normalized) {
    return '';
  }

  const validation = validateSlugSegment(normalized);
  return validation.ok ? validation.normalized : generateContentSlug(normalized);
}

export function slugFromText(value) {
  return generateContentSlug(String(value ?? ''));
}

/**
 * Shared cap for numeric disambiguation suffixes.
 *
 * A WXR export that collides this many times on one name is malformed rather
 * than large, so conversion fails instead of looping.
 */
export const MAX_UNIQUE_NAME_ATTEMPTS = 1000;

export function resolveUniqueSlug(slug, publicId, usedSlugs, fallbackPrefix) {
  const baseSlug = slug || (publicId ? `${fallbackPrefix}-${publicId}` : fallbackPrefix);

  if (!usedSlugs.has(baseSlug)) {
    usedSlugs.add(baseSlug);
    return baseSlug;
  }

  const suffixBase = publicId ? `${baseSlug}-${publicId}` : baseSlug;
  if (!usedSlugs.has(suffixBase)) {
    usedSlugs.add(suffixBase);
    return suffixBase;
  }

  let counter = 2;
  while (counter < MAX_UNIQUE_NAME_ATTEMPTS) {
    const nextSlug = `${suffixBase}-${counter}`;
    if (!usedSlugs.has(nextSlug)) {
      usedSlugs.add(nextSlug);
      return nextSlug;
    }
    counter += 1;
  }

  throw new Error(`Unable to resolve a unique slug for ${baseSlug}`);
}
