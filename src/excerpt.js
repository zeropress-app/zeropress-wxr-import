const DEFAULT_EXCERPT_LENGTH = 160;
const EXCERPT_SCAN_LIMIT = DEFAULT_EXCERPT_LENGTH + 1;
const BLOCK_TAG_NAMES = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'col', 'colgroup', 'dd', 'details',
  'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'head', 'header', 'html', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
const LINE_BREAK_TAG_NAMES = new Set(['br', 'hr']);
const NAMED_HTML_ENTITIES = Object.freeze({
  nbsp: ' ',
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  middot: '·',
  ndash: '–',
  mdash: '—',
});

export function computeImportedPostExcerpt({ excerpt, metaDescription, content }) {
  const explicitExcerpt = normalizeSafePlainText(excerpt);
  if (explicitExcerpt) {
    return explicitExcerpt;
  }

  const explicitMetaDescription = normalizeSafePlainText(metaDescription);
  if (explicitMetaDescription) {
    return explicitMetaDescription;
  }

  const plainText = htmlToPlainText(content);
  if (!plainText) {
    return '';
  }

  return truncateExcerpt(plainText, DEFAULT_EXCERPT_LENGTH);
}

function htmlToPlainText(value) {
  const html = String(value || '');
  let output = '';
  let pendingWhitespace = false;
  let index = 0;

  const appendWhitespace = () => {
    if (output) pendingWhitespace = true;
  };
  const appendVisible = (text) => {
    for (let offset = 0; offset < text.length && output.length < EXCERPT_SCAN_LIMIT; offset += 1) {
      const character = text[offset];
      if (/\s/.test(character)) {
        appendWhitespace();
        continue;
      }
      const code = character.charCodeAt(0);
      if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
        continue;
      }
      if (pendingWhitespace && output.length < EXCERPT_SCAN_LIMIT) {
        if (output.length === EXCERPT_SCAN_LIMIT - 1) {
          output += character;
          pendingWhitespace = false;
          continue;
        }
        output += ' ';
      }
      pendingWhitespace = false;
      if (output.length < EXCERPT_SCAN_LIMIT) {
        output += character;
      }
    }
  };

  while (index < html.length && output.length < EXCERPT_SCAN_LIMIT) {
    if (html.startsWith('<!--', index)) {
      const commentEnd = html.indexOf('-->', index + 4);
      if (commentEnd < 0) break;
      appendWhitespace();
      index = commentEnd + 3;
      continue;
    }

    if (html[index] === '<' && looksLikeHtmlMarkupStart(html, index)) {
      const tag = scanHtmlTag(html, index);
      if (!tag) {
        while (index < html.length && output.length < EXCERPT_SCAN_LIMIT) {
          if (html[index] === '&') {
            const entity = decodeHtmlEntityAt(html, index);
            if (entity) {
              appendVisible(entity.value);
              index = entity.end;
              continue;
            }
          }
          appendVisible(html[index]);
          index += 1;
        }
        break;
      }
      if (!tag.closing && (tag.name === 'script' || tag.name === 'style')) {
        const rawTextEnd = findRawTextElementEnd(html, tag.end, tag.name);
        if (!rawTextEnd) break;
        appendWhitespace();
        index = rawTextEnd;
        continue;
      }
      if (BLOCK_TAG_NAMES.has(tag.name) || LINE_BREAK_TAG_NAMES.has(tag.name)) {
        appendWhitespace();
      }
      index = tag.end;
      continue;
    }

    if (html[index] === '&') {
      const entity = decodeHtmlEntityAt(html, index);
      if (entity) {
        appendVisible(entity.value);
        index = entity.end;
        continue;
      }
    }

    appendVisible(html[index]);
    index += 1;
  }

  return output.trim();
}

function looksLikeHtmlMarkupStart(html, start) {
  const next = html[start + 1] ?? '';
  if (/[A-Za-z!?]/.test(next)) return true;
  return next === '/' && /[A-Za-z]/.test(html[start + 2] ?? '');
}

function scanHtmlTag(html, start) {
  let index = start + 1;
  let quote = '';
  while (index < html.length) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      const body = html.slice(start + 1, index).trim();
      const closing = body.startsWith('/');
      const nameStart = closing ? 1 : 0;
      const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(body.slice(nameStart).trimStart());
      return {
        name: nameMatch ? nameMatch[0].toLowerCase() : '',
        closing,
        end: index + 1,
      };
    }
    index += 1;
  }
  return null;
}

function findRawTextElementEnd(html, start, tagName) {
  for (let index = start; index < html.length; index += 1) {
    if (html[index] !== '<' || html[index + 1] !== '/') continue;
    if (!asciiCaseInsensitiveMatch(html, index + 2, tagName)) continue;
    let end = index + 2 + tagName.length;
    const boundary = html[end];
    if (boundary && !/[\s>]/.test(boundary)) continue;
    while (/\s/.test(html[end] ?? '')) end += 1;
    if (html[end] === '>') return end + 1;
  }
  return null;
}

function asciiCaseInsensitiveMatch(value, start, expected) {
  if (start + expected.length > value.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (value.charCodeAt(start + index) === expected.charCodeAt(index)) continue;
    if (value[start + index].toLowerCase() !== expected[index]) return false;
  }
  return true;
}

function decodeHtmlEntityAt(value, start) {
  const maxEnd = Math.min(value.length, start + 34);
  let semicolon = -1;
  for (let index = start + 1; index < maxEnd; index += 1) {
    if (value[index] === ';') {
      semicolon = index;
      break;
    }
  }
  if (semicolon < 0) return null;
  const candidate = value.slice(start, semicolon + 1);
  const decoded = decodeHtmlEntities(candidate);
  return decoded === candidate ? null : { value: decoded, end: semicolon + 1 };
}

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]+));/g, (match, decimal, hex, named) => {
    const codePoint = decimal
      ? Number.parseInt(decimal, 10)
      : hex
        ? Number.parseInt(hex, 16)
        : null;

    if (codePoint !== null) {
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        return match;
      }

      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }

    return NAMED_HTML_ENTITIES[named.toLowerCase()] ?? match;
  });
}

function normalizeSafePlainText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateExcerpt(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  let truncated = value.slice(0, maxLength);
  const finalCodeUnit = truncated.charCodeAt(truncated.length - 1);
  const nextCodeUnit = value.charCodeAt(truncated.length);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
    truncated = truncated.slice(0, -1);
  }
  const lastSpaceIndex = truncated.lastIndexOf(' ');

  if (lastSpaceIndex > 0) {
    return `${truncated.slice(0, lastSpaceIndex)}...`;
  }

  return `${truncated}...`;
}
