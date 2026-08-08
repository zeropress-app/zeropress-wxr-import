import sax from 'sax';
import { createUtf8Sanitizer } from './utf8.js';
import { parseWordPressAttachmentMetadata } from './wordpress-attachment-metadata.js';

const WXR_NAMESPACE = 'http://wordpress.org/export/1.2/';

const CONTENT_NAMESPACE = 'http://purl.org/rss/1.0/modules/content/';
const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/';
const EXCERPT_NAMESPACE = 'http://wordpress.org/export/1.2/excerpt/';
const CHANNEL_TEXT_FIELDS = new Set(['title', 'description', 'link', 'language', 'pubDate']);
const CHANNEL_WP_FIELDS = new Set(['base_blog_url', 'base_site_url', 'wxr_version']);
const AUTHOR_WP_FIELDS = new Set(['author_id', 'author_login', 'author_display_name']);
const CATEGORY_WP_FIELDS = new Set(['term_id', 'category_nicename', 'cat_name', 'category_description']);
const TAG_WP_FIELDS = new Set(['term_id', 'tag_slug', 'tag_name', 'tag_description']);
const TERM_WP_FIELDS = new Set(['term_id', 'term_slug', 'term_name', 'term_taxonomy']);
const ITEM_WP_FIELDS = new Set([
  'attachment_url',
  'comment_status',
  'menu_order',
  'post_date',
  'post_date_gmt',
  'post_id',
  'post_modified_gmt',
  'post_name',
  'post_parent',
  'post_password',
  'post_type',
  'status',
]);
const IMPORTED_POST_META_KEYS = new Set([
  '_aioseo_description',
  '_genesis_description',
  '_menu_item_menu_item_parent',
  '_menu_item_object',
  '_menu_item_object_id',
  '_menu_item_target',
  '_menu_item_type',
  '_menu_item_url',
  '_thumbnail_id',
  '_wp_attached_file',
  '_wp_attachment_image_alt',
  '_wp_attachment_metadata',
  '_yoast_wpseo_metadesc',
  'rank_math_description',
]);

export async function parseXml(source, options = {}) {
  if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
    throw new Error('Invalid WXR input: expected an async iterable XML source');
  }
  const shouldRetainItemBody = options?.shouldRetainItemBody;
  if (shouldRetainItemBody !== undefined && typeof shouldRetainItemBody !== 'function') {
    throw new Error('Invalid WXR input: shouldRetainItemBody must be a function');
  }

  const document = createDocumentRecord();
  const stack = [];
  const parser = sax.parser(true, {
    xmlns: true,
    strictEntities: true,
    trim: false,
    normalize: false,
  });

  parser.onerror = (error) => {
    throw error;
  };
  parser.ondoctype = () => {
    throw new Error('Invalid WXR XML: DOCTYPE is not allowed');
  };
  parser.onopentag = (node) => {
    const parent = stack.at(-1) ?? null;
    const frame = createFrame(node);

    if (!parent) {
      validateRootElement(node);
      frame.role = 'root';
      document.hasWxrNamespace = Object.values(node.ns ?? {}).includes(WXR_NAMESPACE);
    } else if (parent.role === 'root' && isElement(node, '', 'channel')) {
      document.channelCount += 1;
      if (document.channelCount > 1) {
        throw new Error('Invalid WXR XML: expected exactly one direct channel element');
      }
      frame.role = 'channel';
      frame.record = document.channel;
    } else if (parent.role === 'channel') {
      if (isElement(node, WXR_NAMESPACE, 'author')) {
        frame.role = 'author';
        frame.record = { wp: {} };
      } else if (isElement(node, WXR_NAMESPACE, 'category')) {
        frame.role = 'category-record';
        frame.record = { wp: {} };
      } else if (isElement(node, WXR_NAMESPACE, 'tag')) {
        frame.role = 'tag-record';
        frame.record = { wp: {} };
      } else if (isElement(node, WXR_NAMESPACE, 'term')) {
        frame.role = 'term';
        frame.record = { wp: {}, order: document.terms.length };
      } else if (isElement(node, '', 'item')) {
        frame.role = 'item';
        frame.record = createItemRecord();
      }
    } else if (parent.role === 'item' && isElement(node, WXR_NAMESPACE, 'postmeta')) {
      frame.role = 'postmeta';
      frame.record = { key: '', value: '' };
    }

    frame.collectText = shouldCollectText(frame, parent);
    stack.push(frame);
  };
  parser.ontext = (text) => appendText(stack, text);
  parser.oncdata = (text) => appendText(stack, text);
  parser.onclosetag = () => {
    const frame = stack.pop();
    if (!frame) {
      throw new Error('Invalid WXR XML: unexpected closing tag');
    }
    const parent = stack.at(-1) ?? null;
    const rawText = frame.text ? normalizeXmlLineEndings(frame.text.join('')) : '';
    const value = rawText.trim();

    captureClosedFrame({
      document,
      frame,
      parent,
      value,
      shouldRetainItemBody,
    });
  };

  const decoder = createUtf8Sanitizer();
  let inputMode = null;
  try {
    for await (const chunk of source) {
      if (typeof chunk === 'string') {
        if (inputMode === 'bytes') {
          throw new Error('Invalid WXR input: mixed string and byte chunks are not supported');
        }
        inputMode = 'string';
        writeParserChunk(parser, chunk);
        continue;
      }
      if (!(chunk instanceof Uint8Array)) {
        throw new Error('Invalid WXR input: XML chunks must be strings or bytes');
      }
      if (inputMode === 'string') {
        throw new Error('Invalid WXR input: mixed string and byte chunks are not supported');
      }
      inputMode = 'bytes';
      writeParserChunk(parser, decoder.write(chunk));
    }
    if (inputMode === 'bytes') {
      writeParserChunk(parser, decoder.end());
    }
    parser.close();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid WXR')) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid WXR XML: ${message}`);
  }

  validateParsedDocument(document);
  return document;
}

function stripNonPrintableAscii(text) {
  return String(text).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

export function directChildText(node, tagName) {
  return typeof node?.[tagName] === 'string' ? node[tagName].trim() : '';
}

export function creatorText(node) {
  return typeof node?.creator === 'string' ? node.creator.trim() : '';
}

export function wpText(node, localName) {
  return typeof node?.wp?.[localName] === 'string' ? node.wp[localName].trim() : '';
}

export function contentText(node) {
  return typeof node?.content === 'string' ? node.content.trim() : '';
}

export function excerptText(node) {
  return typeof node?.excerpt === 'string' ? node.excerpt.trim() : '';
}

export function postMetaValue(item, key) {
  return typeof item?.postmeta?.[key] === 'string' ? item.postmeta[key].trim() : '';
}

export function firstPostMetaValue(item, keys) {
  for (const key of keys) {
    const value = postMetaValue(item, key);
    if (value) return value;
  }
  return '';
}

export function itemCategories(item, domain) {
  return Array.isArray(item?.categories)
    ? item.categories.filter((entry) => entry.domain === domain)
    : [];
}

function createDocumentRecord() {
  return {
    channel: { title: '', description: '', link: '', language: '', pubDate: '', wp: {} },
    channelCount: 0,
    hasWxrNamespace: false,
    authors: [],
    categories: [],
    tags: [],
    terms: [],
    items: [],
  };
}

function createItemRecord() {
  return {
    title: '',
    link: '',
    creator: '',
    content: '',
    excerpt: '',
    wp: {},
    postmeta: {},
    attachmentMetadata: null,
    categories: [],
  };
}

function createFrame(node) {
  return {
    local: node.local || node.name,
    uri: node.uri || '',
    attributes: node.attributes ?? {},
    role: '',
    record: null,
    collectText: false,
    text: null,
  };
}

function shouldCollectText(frame, parent) {
  if (!parent) return false;
  if (parent.role === 'channel') {
    return (frame.uri === '' && CHANNEL_TEXT_FIELDS.has(frame.local))
      || (frame.uri === WXR_NAMESPACE && CHANNEL_WP_FIELDS.has(frame.local));
  }
  if (parent.role === 'author') return frame.uri === WXR_NAMESPACE && AUTHOR_WP_FIELDS.has(frame.local);
  if (parent.role === 'category-record') return frame.uri === WXR_NAMESPACE && CATEGORY_WP_FIELDS.has(frame.local);
  if (parent.role === 'tag-record') return frame.uri === WXR_NAMESPACE && TAG_WP_FIELDS.has(frame.local);
  if (parent.role === 'term') return frame.uri === WXR_NAMESPACE && TERM_WP_FIELDS.has(frame.local);
  if (parent.role === 'postmeta' && frame.uri === WXR_NAMESPACE) {
    if (frame.local === 'meta_key') return true;
    return frame.local === 'meta_value' && IMPORTED_POST_META_KEYS.has(parent.record.key);
  }
  if (parent.role !== 'item') return false;
  return (frame.uri === '' && (frame.local === 'title' || frame.local === 'link' || frame.local === 'category'))
    || (frame.uri === DC_NAMESPACE && frame.local === 'creator')
    || (frame.uri === CONTENT_NAMESPACE && frame.local === 'encoded')
    || (frame.uri === EXCERPT_NAMESPACE && frame.local === 'encoded')
    || (frame.uri === WXR_NAMESPACE && ITEM_WP_FIELDS.has(frame.local));
}

function validateRootElement(node) {
  if (!isElement(node, '', 'rss') || attributeValue(node, 'version') !== '2.0') {
    throw new Error('Invalid WXR XML: expected an rss 2.0 root element');
  }
}

function validateParsedDocument(document) {
  if (document.channelCount !== 1) {
    throw new Error('Invalid WXR XML: expected exactly one direct channel element');
  }
  if (!document.hasWxrNamespace) {
    throw new Error('Invalid WXR XML: missing WordPress export 1.2 namespace');
  }
  if (wpText(document.channel, 'wxr_version') !== '1.2') {
    throw new Error('Invalid WXR XML: only WXR version 1.2 is supported');
  }
}

function captureClosedFrame({
  document,
  frame,
  parent,
  value,
  shouldRetainItemBody,
}) {
  if (!parent) return;

  if (parent.role === 'channel') {
    captureChannelChild(document.channel, frame, value);
    if (frame.role === 'author') document.authors.push(frame.record);
    if (frame.role === 'category-record') document.categories.push(frame.record);
    if (frame.role === 'tag-record') document.tags.push(frame.record);
    if (frame.role === 'term') document.terms.push(frame.record);
    if (frame.role === 'item') {
      if (shouldRetainItemBody && !shouldRetainItemBody(frame.record)) {
        frame.record.content = '';
        frame.record.excerpt = '';
      }
      document.items.push(frame.record);
    }
    return;
  }

  if (parent.role === 'author' && frame.uri === WXR_NAMESPACE && AUTHOR_WP_FIELDS.has(frame.local)) {
    parent.record.wp[frame.local] = value;
    return;
  }
  if (parent.role === 'category-record' && frame.uri === WXR_NAMESPACE && CATEGORY_WP_FIELDS.has(frame.local)) {
    parent.record.wp[frame.local] = value;
    return;
  }
  if (parent.role === 'tag-record' && frame.uri === WXR_NAMESPACE && TAG_WP_FIELDS.has(frame.local)) {
    parent.record.wp[frame.local] = value;
    return;
  }
  if (parent.role === 'term' && frame.uri === WXR_NAMESPACE && TERM_WP_FIELDS.has(frame.local)) {
    parent.record.wp[frame.local] = value;
    return;
  }
  if (parent.role === 'postmeta' && frame.uri === WXR_NAMESPACE) {
    if (frame.local === 'meta_key') parent.record.key = value;
    if (frame.local === 'meta_value') parent.record.value = value;
    return;
  }
  if (frame.role === 'postmeta' && parent.role === 'item') {
    const { key, value: metaValue } = frame.record;
    if (key === '_wp_attachment_metadata') {
      parent.record.attachmentMetadata = parseWordPressAttachmentMetadata(metaValue);
      return;
    }
    if (IMPORTED_POST_META_KEYS.has(key) && parent.record.postmeta[key] === undefined) {
      parent.record.postmeta[key] = metaValue;
    }
    return;
  }
  if (parent.role === 'item') {
    captureItemChild(parent.record, frame, value);
  }
}

function captureChannelChild(channel, frame, value) {
  if (frame.uri === '' && CHANNEL_TEXT_FIELDS.has(frame.local)) {
    channel[frame.local] = value;
  } else if (frame.uri === WXR_NAMESPACE && ['base_blog_url', 'base_site_url', 'wxr_version'].includes(frame.local)) {
    channel.wp[frame.local] = value;
  }
}

function captureItemChild(item, frame, value) {
  if (frame.uri === '' && (frame.local === 'title' || frame.local === 'link')) {
    item[frame.local] = value;
    return;
  }
  if (frame.uri === DC_NAMESPACE && frame.local === 'creator') {
    item.creator = value;
    return;
  }
  if (frame.uri === CONTENT_NAMESPACE && frame.local === 'encoded') {
    item.content = value;
    return;
  }
  if (frame.uri === EXCERPT_NAMESPACE && frame.local === 'encoded') {
    item.excerpt = value;
    return;
  }
  if (frame.uri === WXR_NAMESPACE && ITEM_WP_FIELDS.has(frame.local)) {
    item.wp[frame.local] = value;
    return;
  }
  if (frame.uri === '' && frame.local === 'category') {
    item.categories.push({
      domain: attributeValue(frame, 'domain'),
      nicename: attributeValue(frame, 'nicename'),
      textContent: value,
    });
  }
}

function appendText(stack, text) {
  const frame = stack.at(-1);
  if (!frame?.collectText) return;
  if (!frame.text) frame.text = [];
  frame.text.push(text);
}

function writeParserChunk(parser, chunk) {
  const sanitized = normalizeXmlLineEndings(stripNonPrintableAscii(chunk));
  if (sanitized) parser.write(sanitized);
}

function normalizeXmlLineEndings(value) {
  return /[\r\u2028\u2029]/.test(value)
    ? value.replace(/\r\n?|[\u2028\u2029]/g, '\n')
    : value;
}

function isElement(node, uri, local) {
  return (node.uri || '') === uri && (node.local || node.name) === local;
}

function attributeValue(node, localName) {
  for (const attribute of Object.values(node.attributes ?? {})) {
    if ((attribute.uri || '') === '' && (attribute.local || attribute.name) === localName) {
      return String(attribute.value ?? '');
    }
  }
  return '';
}
