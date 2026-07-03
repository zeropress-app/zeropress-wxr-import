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
