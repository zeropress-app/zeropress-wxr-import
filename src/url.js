/**
 * Shared URL guards for untrusted WXR data and base-file values.
 *
 * WordPress exports carry author-controlled URLs, so every URL that reaches
 * preview-data passes through one of these helpers instead of a locally spelled
 * set of regexes.
 */

const HTTP_SCHEME_REGEX = /^https?:\/\//iu;
const UNSAFE_CHARACTER_REGEX = /[\s\u0000-\u001F\u007F]/u;
const MALFORMED_PERCENT_ESCAPE_REGEX = /%(?![0-9A-Fa-f]{2})/u;
const CREDENTIAL_AUTHORITY_REGEX = /^https?:\/\/[^/?#]*@/iu;
const URL_SCHEME_REGEX = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

export function isHttpSchemeUrl(value) {
  return HTTP_SCHEME_REGEX.test(value);
}

/**
 * Reject characters that let a URL smuggle a second target past a naive parse:
 * backslashes, whitespace, C0/C1 controls, and truncated percent escapes.
 */
export function hasUnsafeUrlCharacters(value) {
  return value.includes('\\')
    || UNSAFE_CHARACTER_REGEX.test(value)
    || MALFORMED_PERCENT_ESCAPE_REGEX.test(value);
}

/**
 * Detect a userinfo section in the raw authority.
 *
 * `new URL()` reports empty credentials for `https://@host/`, so the raw form
 * has to be screened separately.
 */
export function hasCredentialAuthority(value) {
  return CREDENTIAL_AUTHORITY_REGEX.test(value);
}

export function hasQueryOrFragment(value) {
  return value.includes('?') || value.includes('#');
}

/**
 * Parse an absolute HTTP(S) URL that carries no credentials and no unsafe
 * characters, and that has no surrounding whitespace.
 *
 * Returns null rather than throwing so callers can supply their own error text
 * or treat the value as missing evidence.
 */
export function parseSafeHttpUrl(value) {
  if (typeof value !== 'string' || value === '' || value.trim() !== value) {
    return null;
  }
  if (!isHttpSchemeUrl(value)
    || hasUnsafeUrlCharacters(value)
    || hasCredentialAuthority(value)) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || !parsed.hostname
    || parsed.username
    || parsed.password) {
    return null;
  }
  return parsed;
}

/**
 * Resolve a navigation URL to the Preview Data URL contract.
 *
 * Missing values are represented by `{ url: null, reason: null }`. Invalid
 * non-empty values include a stable, user-facing rejection reason so callers
 * can attach their own source context.
 */
export function resolveNavigationUrl(value, sourceOrigin = '', sourceBasePath = '/') {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return { url: null, reason: null };
  }

  const reason = navigationUrlRejectionReason(trimmed);
  if (reason) {
    return { url: null, reason };
  }
  if (trimmed.startsWith('#')) {
    return { url: `/${trimmed}`, reason: null };
  }
  if (trimmed.startsWith('/')) {
    return { url: stripSourceBasePathWithSuffix(trimmed, sourceBasePath), reason: null };
  }

  const parsed = parseSafeHttpUrl(trimmed);
  const url = sourceOrigin && parsed.origin === sourceOrigin
    ? `${stripSourceBasePath(parsed.pathname || '/', sourceBasePath)}${parsed.search}${parsed.hash}`
    : parsed.href;
  return { url, reason: null };
}

/**
 * Remove the source WordPress blog pathname from a route-bound URL.
 *
 * Comments continue to use the complete WordPress source URL. This helper is
 * only for paths that will be emitted as routes or navigation within the new
 * root-hosted ZeroPress site.
 */
export function stripSourceBasePath(pathname, sourceBasePath = '/') {
  const normalizedPath = String(pathname || '/');
  const normalizedBase = normalizeSourceBasePath(sourceBasePath);
  if (normalizedBase === '/') {
    return normalizedPath;
  }
  if (normalizedPath === normalizedBase || normalizedPath === `${normalizedBase}/`) {
    return '/';
  }
  return normalizedPath.startsWith(`${normalizedBase}/`)
    ? normalizedPath.slice(normalizedBase.length)
    : normalizedPath;
}

/**
 * Normalize an absolute HTTP(S) URL prefix to exactly one trailing slash,
 * preserving the caller's scheme and host spelling.
 *
 * Returns null when the value is not a safe prefix.
 */
export function normalizeHttpUrlPrefix(value) {
  if (typeof value !== 'string' || hasQueryOrFragment(value) || !parseSafeHttpUrl(value)) {
    return null;
  }
  return `${value.replace(/\/+$/u, '')}/`;
}

/**
 * Normalize an absolute HTTP(S) origin, accepting a single trailing root slash
 * and canonicalizing it away.
 *
 * Returns null when the value carries a path, query, fragment, or credentials.
 */
export function normalizeHttpOrigin(value) {
  const parsed = typeof value === 'string' ? parseSafeHttpUrl(value) : null;
  if (!parsed || parsed.search || parsed.hash) {
    return null;
  }

  const authorityStart = value.indexOf('://') + 3;
  const rawPathStart = value.indexOf('/', authorityStart);
  const hasNonRootRawPath = rawPathStart !== -1 && value.slice(rawPathStart) !== '/';
  if (hasNonRootRawPath || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    return null;
  }
  return parsed.origin;
}

function navigationUrlRejectionReason(value) {
  if (value.includes('\\')) {
    return 'backslashes are not allowed';
  }
  if (MALFORMED_PERCENT_ESCAPE_REGEX.test(value)) {
    return 'malformed percent encoding is not allowed';
  }
  if (UNSAFE_CHARACTER_REGEX.test(value)) {
    return 'whitespace and control characters are not allowed';
  }
  if (value.startsWith('//')) {
    return 'protocol-relative URLs are not allowed';
  }
  if (value.startsWith('/') || value.startsWith('#')) {
    return hasDotPathSegment(value)
      ? 'path traversal segments "." and ".." are not allowed'
      : null;
  }
  if (!URL_SCHEME_REGEX.test(value) || !isHttpSchemeUrl(value)) {
    return 'only absolute HTTP(S) URLs and root-relative URLs are allowed';
  }
  if (hasDotPathSegment(value)) {
    return 'path traversal segments "." and ".." are not allowed';
  }
  if (hasCredentialAuthority(value)) {
    return 'URL credentials are not allowed';
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return 'expected an absolute HTTP(S) URL with a hostname';
  }
  if (parsed.username || parsed.password) {
    return 'URL credentials are not allowed';
  }
  if (!parseSafeHttpUrl(value)) {
    return 'expected an absolute HTTP(S) URL with a hostname';
  }
  return null;
}

function stripSourceBasePathWithSuffix(value, sourceBasePath) {
  const suffixIndex = value.search(/[?#]/u);
  const pathname = suffixIndex === -1 ? value : value.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : value.slice(suffixIndex);
  return `${stripSourceBasePath(pathname || '/', sourceBasePath)}${suffix}`;
}

function normalizeSourceBasePath(value) {
  const pathname = String(value || '/');
  const withoutTrailingSlash = pathname.replace(/\/+$/u, '');
  return withoutTrailingSlash || '/';
}

function hasDotPathSegment(value) {
  let rawPath;
  if (URL_SCHEME_REGEX.test(value)) {
    const authorityStart = value.indexOf('://') + 3;
    const suffix = value.slice(authorityStart);
    const delimiterIndex = suffix.search(/[/?#]/u);
    rawPath = delimiterIndex === -1 || suffix[delimiterIndex] !== '/'
      ? '/'
      : suffix.slice(delimiterIndex).split(/[?#]/u, 1)[0];
  } else {
    rawPath = value.split(/[?#]/u, 1)[0];
  }

  return rawPath.split('/').some((segment) => {
    if (segment === '') return false;
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === '.' || decoded === '..';
    } catch {
      return true;
    }
  });
}
