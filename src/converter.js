import {
  canonicalizePreviewDataKeyOrder,
  validatePreviewData,
} from '@zeropress/preview-data-validator';
import {
  createBaseWidgets,
  createResolvedBase,
  createResolvedWordPressComments,
  inferMediaOriginFromImport,
  normalizeBase,
  PERMALINK_FIELDS,
} from './base.js';
import { computeImportedPostExcerpt } from './excerpt.js';
import { buildPreviewMenus, extractNavMenuItem, extractNavMenuTerms } from './menu.js';
import {
  inferWordPressMediaPrefixFromAttachmentUrl,
  normalizeMediaRewriteOptions,
  rewriteMediaUrl,
  rewriteMediaUrls,
} from './media.js';
import {
  MAX_UNIQUE_NAME_ATTEMPTS,
  normalizeSlugSegment,
  resolveUniqueSlug,
  slugFromText,
} from './slug.js';
import { addWarning, createReport } from './report.js';
import { hasQueryOrFragment, parseSafeHttpUrl } from './url.js';
import {
  datePartsInTimeZone,
  formatUtcOffsetTimeZone,
  inferWxrUtcOffsetMinutes,
  parseRssPubDateToUtcSecondIso,
  parseWxrGmtDateTimeToUtcSecondIso,
  parseWxrLocalDateParts,
} from './time.js';
import {
  contentText,
  creatorText,
  directChildText,
  excerptText,
  firstPostMetaValue,
  itemCategories,
  parseXml,
  postMetaValue,
  wpText,
} from './xml.js';

const PREVIEW_DATA_SCHEMA_URL = 'https://schemas.zeropress.dev/preview-data/v0.7/schema.json';
const DEFAULT_PERMALINKS = Object.freeze({
  output_style: 'directory',
  posts: '/posts/:slug/',
  pages: '/:slug/',
  categories: '/categories/:slug/',
  tags: '/tags/:slug/',
});
const SEO_DESCRIPTION_META_KEYS = Object.freeze([
  '_yoast_wpseo_metadesc',
  'rank_math_description',
  '_aioseo_description',
  '_genesis_description',
]);
export async function convertWxrToPreviewData(xmlSource, base, options = {}) {
  const baseData = normalizeBase(base);
  const widgets = createBaseWidgets(baseData.widgets);
  const doc = await parseXml(xmlSource, {
    shouldRetainItemBody: isConvertibleDocumentItem,
  });
  const channel = doc.channel;
  const generatedAt = parseRssPubDateToUtcSecondIso(directChildText(channel, 'pubDate'));
  if (!generatedAt) {
    throw new Error('Invalid WXR input: channel pubDate must be a valid RFC 2822 date');
  }
  const packageVersion = options.packageVersion || '0.0.0';
  const report = createReport();

  const items = doc.items;
  resolveMediaImport({ baseData, items, report });
  const rewrite = normalizeMediaRewriteOptions(baseData.import);
  const configuredMediaOrigin = baseData.site?.media_origin ?? '';
  const inferredMediaOrigin = configuredMediaOrigin === ''
    ? inferMediaOriginFromImport(baseData.import)
    : '';
  const effectiveMediaOrigin = configuredMediaOrigin || inferredMediaOrigin;
  if (inferredMediaOrigin) {
    report.inferred.media_origin = inferredMediaOrigin;
  }
  const effectiveTimeZone = resolveSiteTimeZone({
    baseSite: baseData.site,
    items,
    report,
  });
  const site = createSite(baseData.site, channel, effectiveMediaOrigin, effectiveTimeZone, report);
  const sourceOrigin = inferWxrSourceOrigin(channel);
  if (baseData.meta !== undefined) {
    site.meta = structuredClone(baseData.meta);
  }
  const comments = createSiteComments({
    baseComments: baseData.comments,
    channel,
    report,
  });
  if (comments !== undefined) {
    site.comments = comments;
  }
  if (baseData.newsletter !== undefined) {
    site.newsletter = baseData.newsletter;
  }
  const inferredPermalinks = inferPermalinksFromItems(items, sourceOrigin, site.permalinks);
  const permalinkPolicy = canonicalizePermalinkPolicy(
    effectivePermalinkPolicy(site.permalinks, inferredPermalinks),
  );
  site.permalinks = permalinkPolicy;
  if (Object.keys(inferredPermalinks).length > 0) {
    report.inferred.permalinks = Object.fromEntries(
      Object.keys(inferredPermalinks).map((key) => [key, permalinkPolicy[key]]),
    );
  }

  const authorRegistry = extractAuthors(doc);
  const categoriesBySlug = extractCategories(doc);
  const tagsBySlug = extractTags(doc);
  const navMenuTerms = extractNavMenuTerms(doc);
  const attachmentsByWpId = new Map();
  const pendingFeaturedImages = [];
  const mediaBySrc = new Map();
  const postsByWpId = new Map();
  const pagesByWpId = new Map();
  const pageRecords = [];
  const categoriesByWpId = new Map();
  const tagsByWpId = new Map();
  const usedPostSlugs = new Set();
  const rawMenuItems = [];
  const posts = [];
  const pages = [];

  for (const category of categoriesBySlug.values()) {
    if (category.wpId) {
      categoriesByWpId.set(category.wpId, {
        ...category,
        url: buildCategoryUrl(category.slug, permalinkPolicy),
      });
    }
  }
  for (const tag of tagsBySlug.values()) {
    if (tag.wpId) {
      tagsByWpId.set(tag.wpId, {
        ...tag,
        url: buildTagUrl(tag.slug, permalinkPolicy),
      });
    }
  }

  // This loop releases each parsed item as it is consumed so large exports do
  // not hold the whole channel in memory. Every pass that needs to read raw
  // items — media import, time zone, and permalink inference — must therefore
  // run before this point, and no pass may be added after it.
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex];
    items[itemIndex] = null;
    const postType = wpText(item, 'post_type');

    if (postType === 'attachment') {
      const wpId = wpText(item, 'post_id');
      const attachment = createAttachmentRecord({
        item,
        rewrite,
        mediaOrigin: effectiveMediaOrigin,
        importOptions: baseData.import,
      });
      if (wpId && attachment) {
        attachmentsByWpId.set(wpId, attachment);
      }
      continue;
    }

    if (postType === 'nav_menu_item') {
      if (wpText(item, 'status') !== 'publish') {
        report.skipped.unpublished_menu_items += 1;
        continue;
      }
      const rawMenuItem = extractNavMenuItem(item);
      if (rawMenuItem) {
        rawMenuItems.push(rawMenuItem);
      }
      continue;
    }

    if (postType !== 'post' && postType !== 'page') {
      continue;
    }

    const status = wpText(item, 'status');
    if (status !== 'publish') {
      if (postType === 'post') report.skipped.unpublished_posts += 1;
      if (postType === 'page') report.skipped.unpublished_pages += 1;
      continue;
    }

    if (wpText(item, 'post_password')) {
      report.skipped.password_protected += 1;
      continue;
    }

    const publicId = normalizeWordPressPublicId(wpText(item, 'post_id'));
    if (!publicId) {
      report.skipped.invalid_public_id += 1;
      continue;
    }

    const publishedAt = parseWxrGmtDateTimeToUtcSecondIso(wpText(item, 'post_date_gmt'));
    const updatedAt = parseWxrGmtDateTimeToUtcSecondIso(wpText(item, 'post_modified_gmt'));
    if (!publishedAt || !updatedAt) {
      report.skipped.invalid_date += 1;
      continue;
    }

    if (postType === 'post') {
      const post = convertPost({
        item,
        publicId,
        publishedAt,
        updatedAt,
        rewrite,
        authorRegistry,
        report,
        categoriesBySlug,
        tagsBySlug,
        pendingFeaturedImages,
        usedPostSlugs,
      });
      posts.push(post);
      postsByWpId.set(String(publicId), {
        slug: post.slug,
        title: post.title,
        url: buildPostUrl(post, permalinkPolicy, site.timezone),
      });
      continue;
    }

    const pageRecord = convertPage({
      item,
      publicId,
      updatedAt,
      rewrite,
      pendingFeaturedImages,
      report,
    });
    pages.push(pageRecord.page);
    pageRecords.push(pageRecord);
  }

  resolvePendingFeaturedImages({
    posts,
    pages,
    attachmentsByWpId,
    pendingFeaturedImages,
    mediaBySrc,
    report,
  });
  resolvePageHierarchy({
    pageRecords,
    pagesByWpId,
    permalinkPolicy,
    report,
  });

  const menus = buildPreviewMenus({
    terms: navMenuTerms,
    rawItems: rawMenuItems,
    postsByWpId,
    pagesByWpId,
    categoriesByWpId,
    tagsByWpId,
    sourceOrigin,
    report,
  });

  posts.sort(comparePostsByPublishedAtDesc);

  const media = Array.from(mediaBySrc.values(), (entry) => entry.media);
  const content = {
    authors: Array.from(authorRegistry.authorsByLogin.values()).map(({ id, display_name, avatar }) => ({
      id,
      display_name,
      ...(avatar ? { avatar } : {}),
    })),
    posts,
    pages,
    categories: Array.from(categoriesBySlug.values()).map(({ name, slug, description }) => ({
      name,
      slug,
      ...(description ? { description } : {}),
    })),
    tags: Array.from(tagsBySlug.values())
      .sort(compareTermsByNameThenSlug)
      .map(({ name, slug, description }) => ({
        name,
        slug,
        ...(description ? { description } : {}),
      })),
    ...(media.length > 0 ? { media } : {}),
  };

  const previewData = {
    $schema: PREVIEW_DATA_SCHEMA_URL,
    version: '0.7',
    generator: `zeropress-wxr-import v${packageVersion}`,
    generated_at: generatedAt,
    site,
    content,
    ...(Object.keys(menus).length > 0 ? { menus } : {}),
  };

  previewData.widgets = structuredClone(widgets);
  if (baseData.collections !== undefined) {
    previewData.collections = baseData.collections;
  }
  if (baseData.custom_css !== undefined) {
    previewData.custom_css = baseData.custom_css;
  }
  if (baseData.custom_html !== undefined) {
    previewData.custom_html = baseData.custom_html;
  }

  const canonicalPreviewData = canonicalizePreviewDataKeyOrder(previewData);
  const validation = validatePreviewData(canonicalPreviewData);
  if (!validation.ok) {
    const first = validation.errors[0];
    const reason = first ? `${first.code} ${first.path}: ${first.message}` : 'unknown validation error';
    throw new Error(`Generated preview-data failed validation: ${reason}`);
  }

  report.counts = {
    authors: content.authors.length,
    posts: content.posts.length,
    pages: content.pages.length,
    categories: content.categories.length,
    tags: content.tags.length,
    media: media.length,
    menus: Object.keys(menus).length,
  };

  return {
    previewData: canonicalPreviewData,
    report,
    base: createResolvedBase({
      baseData,
      site,
      widgets,
      configuredMediaOrigin,
    }),
  };
}

function comparePostsByPublishedAtDesc(left, right) {
  return right.published_at_iso.localeCompare(left.published_at_iso);
}

function compareTermsByNameThenSlug(left, right) {
  return compareLexically(left.name, right.name) || compareLexically(left.slug, right.slug);
}

function compareLexically(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function inferLocale(channel, report) {
  const candidate = directChildText(channel, 'language');
  if (!candidate) {
    addWarning(report, 'locale_inference_skipped', 'site:locale');
    return 'en';
  }
  try {
    return Intl.getCanonicalLocales(candidate.trim())[0];
  } catch {
    addWarning(report, 'locale_inference_skipped', 'site:locale');
    return 'en';
  }
}

function resolveMediaImport({ baseData, items, report }) {
  const importOptions = baseData.import;
  const hasExplicitPair = isRecord(importOptions)
    && Object.hasOwn(importOptions, 'media_from')
    && Object.hasOwn(importOptions, 'media_to');
  if (hasExplicitPair) {
    return;
  }

  let attachmentCount = 0;
  let inferredPrefix = null;
  let inferenceFailed = false;
  for (const item of items) {
    if (wpText(item, 'post_type') !== 'attachment') {
      continue;
    }

    attachmentCount += 1;
    const candidate = inferWordPressMediaPrefixFromAttachmentUrl(wpText(item, 'attachment_url'));
    if (!candidate || (inferredPrefix !== null && candidate !== inferredPrefix)) {
      inferenceFailed = true;
      continue;
    }
    if (inferredPrefix === null) {
      inferredPrefix = candidate;
    }
  }

  if (attachmentCount === 0) {
    return;
  }

  if (inferenceFailed || !inferredPrefix) {
    reportUninferableAttachments(items, report);
    return;
  }

  baseData.import = {
    media_from: inferredPrefix,
    media_to: inferredPrefix,
  };
  report.inferred.media_prefix = inferredPrefix;
}

function reportUninferableAttachments(items, report) {
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex];
    if (wpText(item, 'post_type') !== 'attachment') {
      continue;
    }

    const wpId = wpText(item, 'post_id');
    addWarning(
      report,
      'media_prefix_inference_skipped',
      wpId ? `attachment:${wpId}` : `item:${itemIndex + 1}`,
    );
  }
}

function resolveSiteTimeZone({ baseSite, items, report }) {
  if (isRecord(baseSite) && Object.hasOwn(baseSite, 'timezone')) {
    return baseSite.timezone;
  }

  const offsets = new Set();
  for (const item of items) {
    if (!isConvertibleDocumentItem(item)) {
      continue;
    }

    const offset = inferWxrUtcOffsetMinutes(
      wpText(item, 'post_date'),
      wpText(item, 'post_date_gmt'),
    );
    if (offset !== null) offsets.add(offset);
  }

  if (offsets.size === 1) {
    const timeZone = formatUtcOffsetTimeZone(offsets.values().next().value);
    report.inferred.timezone = timeZone;
    return timeZone;
  }

  if (offsets.size === 0) {
    addWarning(report, 'timezone_inference_skipped', 'site:timezone');
    return 'UTC';
  }

  for (const offset of [...offsets].sort((left, right) => left - right)) {
    addWarning(report, 'timezone_inference_ambiguous', formatUtcOffsetTimeZone(offset));
  }
  return 'UTC';
}

function createSite(baseSite, channel, mediaOrigin, timeZone, report) {
  const explicitSiteUrl = isRecord(baseSite) && Object.hasOwn(baseSite, 'url');
  const explicitLocale = isRecord(baseSite) && Object.hasOwn(baseSite, 'locale');
  const site = {
    title: directChildText(channel, 'title') || 'WordPress Import',
    description: directChildText(channel, 'description') || '',
    url: '',
    media_origin: '',
    locale: explicitLocale ? baseSite.locale : inferLocale(channel, report),
    posts_per_page: 10,
    date_style: 'medium',
    time_style: 'short',
    timezone: 'UTC',
    ...baseSite,
  };
  site.media_origin = mediaOrigin;
  site.timezone = timeZone;
  site.url = explicitSiteUrl
    ? baseSite.url
    : originFromUrl(directChildText(channel, 'link'));
  return site;
}

function createSiteComments({ baseComments, channel, report }) {
  let apiBaseUrl;
  if (baseComments === undefined) {
    apiBaseUrl = inferWordPressCommentsApiBaseUrl(channel);
    if (apiBaseUrl) {
      report.inferred.comments_api_base_url = apiBaseUrl;
    } else {
      addWarning(report, 'comments_api_base_inference_skipped', 'site:comments');
      return undefined;
    }
  } else {
    apiBaseUrl = baseComments.api_base_url;
  }

  return createResolvedWordPressComments(baseComments, apiBaseUrl);
}

function inferWordPressCommentsApiBaseUrl(channel) {
  const candidates = [
    wpText(channel, 'base_blog_url'),
    directChildText(channel, 'link'),
    wpText(channel, 'base_site_url'),
  ];

  for (const candidate of candidates) {
    const sourceUrl = normalizeWordPressSourceUrl(candidate);
    if (!sourceUrl) continue;
    return new URL('wp-json/wp/v2', sourceUrl).toString().replace(/\/$/, '');
  }
  return '';
}

function normalizeWordPressSourceUrl(value) {
  const normalized = String(value ?? '').trim();
  if (hasQueryOrFragment(normalized)) {
    return '';
  }

  const parsed = parseSafeHttpUrl(normalized);
  if (!parsed || parsed.search || parsed.hash) {
    return '';
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`;
  return parsed.toString();
}

function effectivePermalinkPolicy(permalinks, inferredPermalinks = {}) {
  return {
    ...DEFAULT_PERMALINKS,
    ...inferredPermalinks,
    ...(isRecord(permalinks) ? permalinks : {}),
  };
}

function canonicalizePermalinkPolicy(permalinks) {
  const outputStyle = permalinks.output_style;
  const canonical = { output_style: outputStyle };

  for (const field of PERMALINK_FIELDS) {
    const withoutTrailingSlash = permalinks[field].replace(/\/+$/, '');
    canonical[field] = outputStyle === 'directory'
      ? `${withoutTrailingSlash}/`
      : withoutTrailingSlash;
  }

  return canonical;
}

function inferWxrSourceOrigin(channel) {
  for (const value of [wpText(channel, 'base_blog_url'), wpText(channel, 'base_site_url'), directChildText(channel, 'link')]) {
    const origin = originFromUrl(value);
    if (origin) {
      return origin;
    }
  }
  return '';
}

function originFromUrl(value) {
  return parseSafeHttpUrl(String(value ?? '').trim())?.origin ?? '';
}

function inferPermalinksFromItems(items, sourceOrigin, explicitPermalinks) {
  const explicit = isRecord(explicitPermalinks) ? explicitPermalinks : {};
  const inferred = {};
  if (!sourceOrigin) {
    return inferred;
  }

  if (!explicit.posts) {
    const posts = inferPermalinkPattern(items, sourceOrigin, 'post');
    if (posts) {
      inferred.posts = posts;
    }
  }

  if (!explicit.pages) {
    const pages = inferPagePermalinkPattern(items, sourceOrigin);
    if (pages) {
      inferred.pages = pages;
    }
  }

  if (!explicit.output_style) {
    const outputStyle = inferPermalinkOutputStyle(items, sourceOrigin);
    if (outputStyle) {
      inferred.output_style = outputStyle;
    }
  }

  return inferred;
}

function inferPermalinkPattern(items, sourceOrigin, postType) {
  const candidates = [];

  for (const item of items) {
    if (!isConvertibleDocumentItem(item, postType)) {
      continue;
    }

    const pathInfo = sameOriginPathInfo(directChildText(item, 'link'), sourceOrigin);
    if (!pathInfo) {
      continue;
    }

    const publicId = normalizeWordPressPublicId(wpText(item, 'post_id'));
    const title = resolveTitle(item, publicId, postType === 'post' ? 'Post' : 'Page');
    const slug = normalizeSlugSegment(wpText(item, 'post_name')) || slugFromText(title);
    const localDateParts = parseWxrLocalDateParts(wpText(item, 'post_date'));
    const candidate = permalinkPatternForPath(pathInfo.pathname, {
      postType,
      publicId,
      slug,
      localDateParts,
    });
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return choosePermalinkPattern(candidates);
}

function inferPagePermalinkPattern(items, sourceOrigin) {
  const recordsByWpId = new Map();
  const records = [];

  for (const item of items) {
    if (!isConvertibleDocumentItem(item, 'page')) {
      continue;
    }
    const publicId = normalizeWordPressPublicId(wpText(item, 'post_id'));
    const title = resolveTitle(item, publicId, 'Page');
    const slug = normalizeSlugSegment(wpText(item, 'post_name')) || slugFromText(title) || `page-${publicId}`;
    const record = {
      wpId: String(publicId),
      parentWpId: normalizeWordPressReferenceId(wpText(item, 'post_parent')),
      slug,
      pathInfo: sameOriginPathInfo(directChildText(item, 'link'), sourceOrigin),
    };
    if (!recordsByWpId.has(record.wpId)) {
      recordsByWpId.set(record.wpId, record);
      records.push(record);
    }
  }

  const candidates = [];
  for (const record of records) {
    if (!record.pathInfo) continue;
    const lineage = pageInferenceLineage(record, recordsByWpId);
    const candidate = lineage && pagePermalinkPatternForPath(record.pathInfo.pathname, lineage);
    if (candidate) candidates.push(candidate);
  }
  return choosePermalinkPattern(candidates);
}

function pageInferenceLineage(record, recordsByWpId) {
  const reversed = [];
  const seen = new Set();
  let current = record;

  while (current) {
    if (seen.has(current.wpId)) return null;
    seen.add(current.wpId);
    reversed.push(current.slug);
    if (!current.parentWpId || current.parentWpId === '0') break;
    current = recordsByWpId.get(current.parentWpId) ?? null;
  }
  return reversed.reverse();
}

function pagePermalinkPatternForPath(pathname, lineage) {
  const body = String(pathname || '').replace(/^\/+|\/+$/g, '');
  if (!body || lineage.length === 0) return null;
  const segments = body.split('/').map((segment) => normalizeSlugSegment(safeDecodeURIComponent(segment)));
  if (segments.some((segment) => !segment)) return null;

  let matchIndex = -1;
  for (let start = 0; start <= segments.length - lineage.length; start += 1) {
    if (lineage.every((slug, offset) => segments[start + offset] === slug)) {
      matchIndex = start;
    }
  }
  if (matchIndex < 0) return null;
  const patternSegments = [
    ...segments.slice(0, matchIndex),
    ':slug',
    ...segments.slice(matchIndex + lineage.length),
  ];
  return `/${patternSegments.join('/')}`;
}

function permalinkPatternForPath(pathname, { postType, publicId, slug, localDateParts }) {
  const body = String(pathname || '').replace(/^\/+|\/+$/g, '');
  if (!body) {
    return null;
  }

  const availableDateTokens = postType === 'post' && localDateParts
    ? [
        ['year', localDateParts.year],
        ['month', localDateParts.month],
        ['day', localDateParts.day],
      ]
    : [];
  let publicIdAvailable = Boolean(postType === 'post' && publicId);
  let slugAvailable = Boolean(slug);
  let hasPostIdentityToken = false;
  let hasPageSlugToken = false;
  const segments = [];

  for (const rawSegment of body.split('/')) {
    const decodedSegment = safeDecodeURIComponent(rawSegment);
    const normalizedSegment = normalizeSlugSegment(decodedSegment);

    const tokenMatches = [];
    if (publicIdAvailable && decodedSegment === String(publicId)) {
      tokenMatches.push({ token: 'public_id', kind: 'public-id' });
    }
    for (let index = 0; index < availableDateTokens.length; index += 1) {
      const [token, value] = availableDateTokens[index];
      if (decodedSegment === value) tokenMatches.push({ token, kind: 'date', index });
    }
    if (slugAvailable && normalizedSegment === slug) {
      tokenMatches.push({ token: 'slug', kind: 'slug' });
    }

    if (tokenMatches.length > 1) return null;
    if (tokenMatches.length === 1) {
      const [match] = tokenMatches;
      segments.push(`:${match.token}`);
      if (match.kind === 'public-id') {
        publicIdAvailable = false;
        hasPostIdentityToken = true;
      } else if (match.kind === 'date') {
        availableDateTokens.splice(match.index, 1);
      } else {
        slugAvailable = false;
        if (postType === 'post') hasPostIdentityToken = true;
        else hasPageSlugToken = true;
      }
      continue;
    }

    if (postType === 'post' && !localDateParts && /^\d+$/.test(decodedSegment)) {
      return null;
    }
    if (!normalizedSegment) {
      return null;
    }
    segments.push(normalizedSegment);
  }

  if (postType === 'post' && !hasPostIdentityToken) {
    return null;
  }
  if (postType === 'page' && !hasPageSlugToken) {
    return null;
  }

  return `/${segments.join('/')}`;
}

function choosePermalinkPattern(candidates) {
  if (candidates.length === 0) {
    return null;
  }

  const counts = new Map();
  for (const candidate of candidates) {
    counts.set(candidate, (counts.get(candidate) || 0) + 1);
  }

  let best = null;
  let bestCount = 0;
  for (const [candidate, count] of counts) {
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }

  if (!best) {
    return null;
  }

  const requiredCount = best.includes(':public_id') ? 1 : Math.max(2, Math.ceil(candidates.length * 0.6));
  return bestCount >= requiredCount ? best : null;
}

function inferPermalinkOutputStyle(items, sourceOrigin) {
  let directory = 0;
  let htmlExtension = 0;

  for (const item of items) {
    if (!isConvertibleDocumentItem(item)) {
      continue;
    }

    const pathInfo = sameOriginPathInfo(directChildText(item, 'link'), sourceOrigin);
    if (!pathInfo || pathInfo.pathname === '/') {
      continue;
    }

    if (pathInfo.pathname.endsWith('/')) {
      directory += 1;
    } else {
      htmlExtension += 1;
    }
  }

  if (directory === 0 && htmlExtension === 0) {
    return null;
  }
  return htmlExtension >= directory ? 'html-extension' : 'directory';
}

function sameOriginPathInfo(value, sourceOrigin) {
  try {
    const parsed = new URL(String(value ?? '').trim());
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== sourceOrigin) {
      return null;
    }
    return {
      pathname: parsed.pathname || '/',
    };
  } catch {
    return null;
  }
}

function extractAuthors(doc) {
  const authorsByLogin = new Map();
  const usedAuthorIds = new Set(['wordpress-unknown']);
  for (const entry of doc.authors) {
    const login = wpText(entry, 'author_login');
    const displayName = wpText(entry, 'author_display_name') || login;
    if (!login && !displayName) {
      continue;
    }
    addAuthor({
      authorsByLogin,
      usedAuthorIds,
      key: login || displayName,
      displayName: displayName || login,
      wpId: wpText(entry, 'author_id'),
    });
  }
  return { authorsByLogin, usedAuthorIds, unknownAuthor: null };
}

function resolvePostAuthor(authorRegistry, creator, report) {
  const normalizedCreator = String(creator ?? '').trim();
  if (normalizedCreator) {
    const existing = authorRegistry.authorsByLogin.get(normalizedCreator);
    if (existing) return existing;

    const synthesized = addAuthor({
      authorsByLogin: authorRegistry.authorsByLogin,
      usedAuthorIds: authorRegistry.usedAuthorIds,
      key: normalizedCreator,
      displayName: normalizedCreator,
      wpId: '',
    });
    addWarning(report, 'synthesized_authors', normalizedCreator);
    return synthesized;
  }

  if (!authorRegistry.unknownAuthor) {
    authorRegistry.unknownAuthor = {
      id: 'wordpress-unknown',
      display_name: 'Unknown WordPress Author',
    };
    authorRegistry.authorsByLogin.set('', authorRegistry.unknownAuthor);
  }
  return authorRegistry.unknownAuthor;
}

function addAuthor({ authorsByLogin, usedAuthorIds, key, displayName, wpId }) {
  const existing = authorsByLogin.get(key);
  if (existing) {
    return existing;
  }

  const id = allocateAuthorId({
    candidate: normalizeAuthorId(key) || 'author',
    wpId,
    usedAuthorIds,
  });
  const author = {
    id,
    display_name: displayName || key || 'WordPress',
  };
  authorsByLogin.set(key, author);
  return author;
}

function allocateAuthorId({ candidate, wpId, usedAuthorIds }) {
  if (!usedAuthorIds.has(candidate)) {
    usedAuthorIds.add(candidate);
    return candidate;
  }

  const normalizedWpId = normalizeWordPressPublicId(wpId);
  if (normalizedWpId) {
    const withWpId = `${candidate}-${normalizedWpId}`;
    if (!usedAuthorIds.has(withWpId)) {
      usedAuthorIds.add(withWpId);
      return withWpId;
    }
  }

  for (let suffix = 2; suffix < MAX_UNIQUE_NAME_ATTEMPTS; suffix += 1) {
    const withSuffix = `${candidate}-${suffix}`;
    if (!usedAuthorIds.has(withSuffix)) {
      usedAuthorIds.add(withSuffix);
      return withSuffix;
    }
  }
  throw new Error(`Unable to resolve a unique author id for ${candidate}`);
}

function extractCategories(doc) {
  return extractTaxonomyTerms(doc.categories, {
    taxonomy: 'category',
    slugField: 'category_nicename',
    nameField: 'cat_name',
    descriptionField: 'category_description',
  });
}

function extractTags(doc) {
  return extractTaxonomyTerms(doc.tags, {
    taxonomy: 'tag',
    slugField: 'tag_slug',
    nameField: 'tag_name',
    descriptionField: 'tag_description',
  });
}

function extractTaxonomyTerms(entries, {
  taxonomy,
  slugField,
  nameField,
  descriptionField,
}) {
  const terms = new Map();
  const sourcesBySlug = new Map();

  for (const entry of entries) {
    const rawSlug = wpText(entry, slugField);
    const rawName = wpText(entry, nameField);
    const slug = normalizeSlugSegment(rawSlug || rawName);
    const name = rawName || slug;
    if (!slug || !name) {
      continue;
    }

    const source = {
      wpId: wpText(entry, 'term_id'),
      name,
      rawSlug,
    };
    const previousSource = sourcesBySlug.get(slug);
    if (previousSource) {
      throw new Error(
        `Invalid WXR taxonomy slug collision: ${taxonomy} terms `
        + `${formatTaxonomyTermSource(previousSource)} and ${formatTaxonomyTermSource(source)} `
        + `both normalize to ${JSON.stringify(slug)}. Rename one of these terms in WordPress, `
        + 'then export the WXR again.',
      );
    }

    sourcesBySlug.set(slug, source);
    terms.set(slug, {
      wpId: source.wpId,
      name,
      slug,
      description: wpText(entry, descriptionField),
    });
  }
  return terms;
}

function formatTaxonomyTermSource({ wpId, rawSlug, name }) {
  const id = wpId ? `ID ${JSON.stringify(wpId)}` : 'without a term ID';
  const slug = rawSlug
    ? JSON.stringify(rawSlug)
    : '(missing; using the term name as fallback)';
  return `${id} (slug ${slug}, name ${JSON.stringify(name)})`;
}

/**
 * Derive the fields Posts and Pages compute identically from a WXR item.
 */
function convertSharedDocumentFields({ item, publicId, contentType, rewrite, report }) {
  const title = resolveTitle(item, publicId, contentType === 'post' ? 'Post' : 'Page');
  const metaDescription = rewriteMediaUrls(
    firstPostMetaValue(item, SEO_DESCRIPTION_META_KEYS),
    rewrite,
  );
  const content = rewriteMediaUrls(contentText(item), rewrite);

  return {
    title,
    slug: normalizeSlugSegment(wpText(item, 'post_name')) || slugFromText(title),
    content,
    metaDescription,
    excerpt: computeImportedPostExcerpt({
      excerpt: rewriteMediaUrls(excerptText(item), rewrite),
      metaDescription,
      content,
    }),
    thumbnailWpId: postMetaValue(item, '_thumbnail_id'),
    allowComments: resolveAllowComments(item, contentType, publicId, report),
  };
}

function convertPost({
  item,
  publicId,
  publishedAt,
  updatedAt,
  rewrite,
  authorRegistry,
  report,
  categoriesBySlug,
  tagsBySlug,
  pendingFeaturedImages,
  usedPostSlugs,
}) {
  const shared = convertSharedDocumentFields({
    item,
    publicId,
    contentType: 'post',
    rewrite,
    report,
  });
  const author = resolvePostAuthor(authorRegistry, creatorText(item), report);

  const post = {
    public_id: publicId,
    title: shared.title,
    slug: resolveUniqueSlug(shared.slug, publicId, usedPostSlugs, 'post'),
    content: shared.content,
    document_type: 'html',
    excerpt: shared.excerpt,
    published_at_iso: publishedAt,
    updated_at_iso: updatedAt,
    author_id: author.id,
    status: 'published',
    ...(shared.allowComments ? { allow_comments: true } : {}),
    category_slugs: collectItemTermSlugs(item, 'category', categoriesBySlug),
    tag_slugs: collectItemTermSlugs(item, 'post_tag', tagsBySlug),
  };

  if (shared.metaDescription) {
    post.meta = { description: shared.metaDescription };
  }
  queueFeaturedImage(pendingFeaturedImages, post, shared.thumbnailWpId, 'post', publicId);

  return post;
}

function convertPage({ item, publicId, updatedAt, rewrite, pendingFeaturedImages, report }) {
  const shared = convertSharedDocumentFields({
    item,
    publicId,
    contentType: 'page',
    rewrite,
    report,
  });
  const slug = shared.slug || `page-${publicId}`;

  const page = {
    public_id: publicId,
    title: shared.title,
    slug,
    content: shared.content,
    document_type: 'html',
    excerpt: shared.excerpt,
    updated_at_iso: updatedAt,
    status: 'published',
    ...(shared.allowComments ? { allow_comments: true } : {}),
  };

  if (shared.metaDescription) {
    page.meta = { description: shared.metaDescription };
  }
  queueFeaturedImage(pendingFeaturedImages, page, shared.thumbnailWpId, 'page', publicId);

  return {
    page,
    wpId: String(publicId),
    parentWpId: normalizeWordPressReferenceId(wpText(item, 'post_parent')),
    sourceSlug: slug,
    routeSegment: slug,
    parent: null,
    lineage: null,
  };
}

function queueFeaturedImage(pendingFeaturedImages, target, attachmentWpId, contentType, publicId) {
  if (!attachmentWpId) {
    return;
  }
  pendingFeaturedImages.push({
    target,
    attachmentWpId,
    affected: `${contentType}:${publicId}:attachment:${attachmentWpId}`,
  });
}

function resolveAllowComments(item, contentType, publicId, report) {
  const commentStatus = wpText(item, 'comment_status');
  if (commentStatus === 'open') return true;
  if (commentStatus === 'closed') return false;
  addWarning(report, 'invalid_comment_statuses', `${contentType}:${publicId}`);
  return false;
}

function normalizeWordPressReferenceId(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized || /^0+$/.test(normalized)) return '0';
  const publicId = normalizeWordPressPublicId(normalized);
  return publicId ? String(publicId) : normalized;
}

function collectItemTermSlugs(item, domain, knownTerms) {
  const seen = new Set();
  const slugs = [];
  for (const category of itemCategories(item, domain)) {
    const slug = normalizeSlugSegment(category.nicename ?? '');
    if (!slug || seen.has(slug)) {
      continue;
    }

    if (!knownTerms.has(slug)) {
      const name = category.textContent?.trim() || slug;
      knownTerms.set(slug, { name, slug, description: '' });
    }

    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

function createAttachmentRecord({ item, rewrite, mediaOrigin, importOptions }) {
  const sourceUrl = resolveAttachmentSourceUrl(item, importOptions);
  if (!sourceUrl) return null;

  const rewrittenUrl = rewriteMediaUrl(sourceUrl, rewrite);
  const src = compactStructuredMediaUrl(rewrittenUrl, mediaOrigin);
  if (!src) return null;

  return {
    src,
    metadata: item.attachmentMetadata,
    alt: postMetaValue(item, '_wp_attachment_image_alt'),
    modifiedAt: parseWxrGmtDateTimeToUtcSecondIso(wpText(item, 'post_modified_gmt')),
    wpId: wpText(item, 'post_id'),
  };
}

function resolveAttachmentSourceUrl(item, importOptions) {
  const attachmentUrl = normalizeAbsoluteMediaUrl(wpText(item, 'attachment_url'));
  if (attachmentUrl) return attachmentUrl;

  if (!isRecord(importOptions) || typeof importOptions.media_from !== 'string') {
    return '';
  }
  const relativeFile = normalizeAttachmentRelativeFile(
    postMetaValue(item, '_wp_attached_file') || item.attachmentMetadata?.file,
  );
  if (!relativeFile) return '';

  try {
    return normalizeAbsoluteMediaUrl(new URL(relativeFile, importOptions.media_from).toString());
  } catch {
    return '';
  }
}

function normalizeAttachmentRelativeFile(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.trim() !== value) return '';
  if (value.startsWith('/')
    || value.includes('\\')
    || value.includes('?')
    || value.includes('#')
    || /[\u0000-\u001F\u007F]/u.test(value)
    || /%(?:2f|5c)/iu.test(value)
    || /%(?![0-9A-Fa-f]{2})/u.test(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
    return '';
  }

  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return '';
  }
  if (/[\u0000-\u001F\u007F]/u.test(decoded)) {
    return '';
  }
  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return '';
  }
  return value;
}

function compactStructuredMediaUrl(value, mediaOrigin) {
  const absolute = normalizeAbsoluteMediaUrl(value);
  if (!absolute || !mediaOrigin) return absolute;

  try {
    const parsed = new URL(absolute);
    if (parsed.origin !== mediaOrigin) return absolute;
    if (parsed.pathname.startsWith('//')) return absolute;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '';
  }
}

function normalizeAbsoluteMediaUrl(value) {
  return parseSafeHttpUrl(value)?.toString() ?? '';
}

function registerManagedMedia(mediaBySrc, attachment) {
  const width = attachment.metadata?.width;
  const height = attachment.metadata?.height;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    return;
  }

  const candidate = {
    media: {
      src: attachment.src,
      width,
      height,
      ...(attachment.alt ? { alt: attachment.alt } : {}),
    },
    modifiedAt: attachment.modifiedAt,
    wpId: attachment.wpId,
  };
  const existing = mediaBySrc.get(attachment.src);
  if (!existing || shouldReplaceManagedMedia(existing, candidate)) {
    mediaBySrc.set(attachment.src, candidate);
  }
}

function shouldReplaceManagedMedia(existing, candidate) {
  const existingTime = Date.parse(existing.modifiedAt ?? '');
  const candidateTime = Date.parse(candidate.modifiedAt ?? '');
  const comparableExistingTime = Number.isFinite(existingTime) ? existingTime : Number.NEGATIVE_INFINITY;
  const comparableCandidateTime = Number.isFinite(candidateTime) ? candidateTime : Number.NEGATIVE_INFINITY;
  if (comparableCandidateTime !== comparableExistingTime) {
    return comparableCandidateTime > comparableExistingTime;
  }

  try {
    return BigInt(candidate.wpId) > BigInt(existing.wpId);
  } catch {
    return String(candidate.wpId) > String(existing.wpId);
  }
}

function resolvePendingFeaturedImages({
  posts,
  pages,
  attachmentsByWpId,
  pendingFeaturedImages,
  mediaBySrc,
  report,
}) {
  if (pendingFeaturedImages.length === 0) {
    return;
  }

  const validTargets = new Set([...posts, ...pages]);
  for (const entry of pendingFeaturedImages) {
    if (!validTargets.has(entry.target) || entry.target.featured_image) {
      continue;
    }

    const attachment = attachmentsByWpId.get(entry.attachmentWpId);
    if (attachment?.src) {
      entry.target.featured_image = attachment.src;
      registerManagedMedia(mediaBySrc, attachment);
    } else {
      addWarning(report, 'unresolved_featured_images', entry.affected);
    }
  }
}

function resolvePageHierarchy({ pageRecords, pagesByWpId, permalinkPolicy, report }) {
  const recordsByWpId = new Map();
  for (const record of pageRecords) {
    if (recordsByWpId.has(record.wpId)) {
      throw new Error(`Invalid WXR page hierarchy: duplicate WordPress page id ${record.wpId}`);
    }
    recordsByWpId.set(record.wpId, record);
  }

  for (const record of pageRecords) {
    if (!record.parentWpId || record.parentWpId === '0') continue;
    if (record.parentWpId === record.wpId) {
      throw new Error(`Invalid WXR page hierarchy: page ${record.wpId} is its own parent`);
    }
    const parent = recordsByWpId.get(record.parentWpId);
    if (!parent) {
      addWarning(report, 'orphan_page_parents', record.wpId);
      continue;
    }
    record.parent = parent;
  }

  const resolved = new Set();
  for (const start of pageRecords) {
    if (resolved.has(start)) continue;
    const path = [];
    const pathIndex = new Map();
    let current = start;
    while (current && !resolved.has(current)) {
      if (pathIndex.has(current)) {
        const cycle = path.slice(pathIndex.get(current)).map((record) => record.wpId);
        throw new Error(`Invalid WXR page hierarchy: cycle detected (${cycle.join(' -> ')} -> ${current.wpId})`);
      }
      pathIndex.set(current, path.length);
      path.push(current);
      current = current.parent;
    }
    for (const record of path) resolved.add(record);
  }

  const siblingsByParent = new Map();
  for (const record of pageRecords) {
    const parentKey = record.parent?.wpId ?? '';
    const siblings = siblingsByParent.get(parentKey) ?? [];
    siblings.push(record);
    siblingsByParent.set(parentKey, siblings);
  }
  for (const siblings of siblingsByParent.values()) {
    allocateSiblingPageSegments(siblings, report);
  }

  for (const start of pageRecords) {
    if (start.lineage) continue;
    const unresolved = [];
    let current = start;
    while (current && !current.lineage) {
      unresolved.push(current);
      current = current.parent;
    }
    let lineage = current?.lineage ? [...current.lineage] : [];
    for (let index = unresolved.length - 1; index >= 0; index -= 1) {
      lineage = [...lineage, unresolved[index].routeSegment];
      unresolved[index].lineage = lineage;
    }
  }

  for (const record of pageRecords) {
    const routePath = pageRoutePathForLineage(record.lineage, permalinkPolicy.pages);
    const fallbackRoutePath = applyPermalinkPattern(permalinkPolicy.pages, {
      slug: record.page.slug,
    });
    if (!hasEquivalentPageFallbackRoute(routePath, fallbackRoutePath, permalinkPolicy.output_style)) {
      record.page.path = normalizeRoutePath(routePath).replace(/^\/+|\/+$/g, '');
    }
    pagesByWpId.set(record.wpId, {
      slug: record.page.slug,
      title: record.page.title,
      url: pagePathToPublicUrl(routePath, permalinkPolicy.output_style),
    });
  }
}

function allocateSiblingPageSegments(siblings, report) {
  const ordered = [...siblings].sort((left, right) => compareWordPressIds(left.wpId, right.wpId));
  const firstBySlug = new Map();
  const used = new Set();

  for (const record of ordered) {
    if (!firstBySlug.has(record.sourceSlug)) {
      firstBySlug.set(record.sourceSlug, record);
      record.routeSegment = record.sourceSlug;
      used.add(record.routeSegment);
    }
  }

  for (const record of ordered) {
    if (firstBySlug.get(record.sourceSlug) === record) continue;
    const base = `${record.sourceSlug}-${record.wpId}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    record.routeSegment = candidate;
    used.add(candidate);
    addWarning(report, 'resolved_page_path_conflicts', record.wpId);
  }
}

// Page record ids always come from normalizeWordPressPublicId, so they are
// safe positive integers and compare numerically.
function compareWordPressIds(left, right) {
  return Number(left) - Number(right);
}

function pageRoutePathForLineage(lineage, pattern) {
  const body = String(pattern || DEFAULT_PERMALINKS.pages).replace(/^\/+|\/+$/g, '');
  const segments = body.split('/').flatMap((segment) => (segment === ':slug' ? lineage : [segment]));
  return `/${segments.join('/')}`;
}

/**
 * Whether a WXR item is converted into a preview-data Post or Page.
 *
 * Every inference pass shares this predicate with the main conversion loop, so
 * inferred settings such as time zone and permalinks describe exactly the item
 * set that ends up in preview-data. Pass `postType` to narrow to one kind.
 */
function isConvertibleDocumentItem(item, postType = null) {
  const itemPostType = wpText(item, 'post_type');
  const matchesPostType = postType === null
    ? itemPostType === 'post' || itemPostType === 'page'
    : itemPostType === postType;

  return matchesPostType
    && wpText(item, 'status') === 'publish'
    && !wpText(item, 'post_password')
    && normalizeWordPressPublicId(wpText(item, 'post_id')) !== null
    && parseWxrGmtDateTimeToUtcSecondIso(wpText(item, 'post_date_gmt')) !== null
    && parseWxrGmtDateTimeToUtcSecondIso(wpText(item, 'post_modified_gmt')) !== null;
}

function normalizeWordPressPublicId(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const publicId = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(publicId) && publicId > 0 ? publicId : null;
}

function resolveTitle(item, publicId, fallbackPrefix) {
  return directChildText(item, 'title') || `${fallbackPrefix} ${publicId}`;
}

function normalizeAuthorId(value) {
  return normalizeSlugSegment(value).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || '';
}

function buildPostUrl(post, permalinkPolicy, timeZone) {
  const pattern = permalinkPolicy.posts;
  const routePath = applyPermalinkPattern(pattern, {
    slug: post.slug,
    public_id: String(post.public_id),
    ...datePartsInTimeZone(post.published_at_iso, timeZone),
  });
  return routePathToPublicUrl(routePath, permalinkPolicy.output_style);
}

function buildCategoryUrl(slug, permalinkPolicy) {
  const pattern = permalinkPolicy.categories;
  const routePath = applyPermalinkPattern(pattern, { slug });
  return routePathToPublicUrl(routePath, permalinkPolicy.output_style);
}

function buildTagUrl(slug, permalinkPolicy) {
  const pattern = permalinkPolicy.tags;
  const routePath = applyPermalinkPattern(pattern, { slug });
  return routePathToPublicUrl(routePath, permalinkPolicy.output_style);
}

function applyPermalinkPattern(pattern, values) {
  let output = pattern;
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`:${key}`, value);
  }
  return output || '/';
}

function routePathToPublicUrl(routePath, outputStyle) {
  const normalizedPath = normalizeRoutePath(routePath);
  if (normalizedPath === '/') {
    return '/';
  }
  if (outputStyle === 'html-extension') {
    return normalizedPath.replace(/\/$/, '');
  }
  return normalizedPath;
}

function pagePathToPublicUrl(routePath, outputStyle) {
  const normalizedPath = normalizeRoutePath(routePath);
  if (outputStyle !== 'html-extension') {
    return routePathToPublicUrl(normalizedPath, outputStyle);
  }

  const withoutTrailingSlash = normalizedPath.replace(/\/$/, '');
  if (withoutTrailingSlash === '/index') {
    return '/';
  }
  if (withoutTrailingSlash.endsWith('/index')) {
    return `${withoutTrailingSlash.slice(0, -'/index'.length)}/`;
  }
  return withoutTrailingSlash;
}

function routePathToOutputPath(routePath, outputStyle) {
  const normalizedPath = normalizeRoutePath(routePath);
  if (normalizedPath === '/') {
    return 'index.html';
  }
  if (outputStyle === 'html-extension') {
    return `${normalizedPath.replace(/^\/+|\/+$/g, '')}.html`;
  }
  return `${normalizedPath.replace(/^\//, '')}index.html`;
}

function hasEquivalentPageFallbackRoute(explicitRoutePath, fallbackRoutePath, outputStyle) {
  return pagePathToPublicUrl(explicitRoutePath, outputStyle)
      === routePathToPublicUrl(fallbackRoutePath, outputStyle)
    && routePathToOutputPath(explicitRoutePath, outputStyle)
      === routePathToOutputPath(fallbackRoutePath, outputStyle);
}

function normalizeRoutePath(routePath) {
  const body = String(routePath || '').trim().replace(/^\/+|\/+$/g, '');
  return body ? `/${body}/` : '/';
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
