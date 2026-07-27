import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { convertWxrToPreviewData } from '../src/converter.js';

test('custom_css accepts only the canonical non-blank object', async () => {
  const success = await convert('', { site: {}, custom_css: { content: ' body { color: red; } ' } });
  assert.deepEqual(success.previewData.custom_css, { content: ' body { color: red; } ' });

  for (const customCss of ['body {}', { content: '   ' }, { content: 'body {}', extra: true }, {}]) {
    await assert.rejects(() => convert('', { site: {}, custom_css: customCss }), /custom_css/);
  }
});

test('custom_html accepts only canonical bounded raw slot strings', async () => {
  const customHtml = {
    head_end: ' <meta name="verification" content="ok"> ',
    body_end: '<script src="/app.js"></script>',
  };
  const success = await convert('', { site: {}, custom_html: customHtml });
  assert.deepEqual(success.previewData.custom_html, customHtml);
  assert.deepEqual(success.base.custom_html, customHtml);
  assert.notStrictEqual(success.previewData.custom_html, success.base.custom_html);

  for (const invalid of [
    {},
    { head_end: '   ' },
    { head_end: { content: '<meta>' } },
    { head_end: '<meta>', extra: true },
    { body_end: 'x'.repeat(65537) },
  ]) {
    await assert.rejects(() => convert('', { site: {}, custom_html: invalid }), /custom_html/);
  }
});

test('emits preview-data in canonical schema order independently of base key order', async () => {
  const base = {
    site: {
      title: 'Canonical Import',
      description: 'Canonical ordering fixture',
      url: 'https://destination.example',
      media_origin: 'https://media.example',
      media_delivery_mode: 'media_domain',
      favicon: {
        icon: '/favicon.ico',
        icon_dark: '/favicon.dark.ico',
        svg: '/favicon.svg',
        png: '/favicon.png',
        apple_touch_icon: '/apple-touch-icon.png',
      },
      logo: { src: '/logo.svg', alt: 'Canonical Import' },
      expose_generator: false,
      search: { enabled: true },
      feed: { enabled: false },
      archive: { enabled: true },
      locale: 'en-US',
      posts_per_page: 12,
      date_style: 'long',
      time_style: 'short',
      timezone: 'UTC',
      robots: { allow_indexing: true },
      permalinks: {
        output_style: 'directory',
        posts: '/posts/:slug/',
        pages: '/:slug/',
        categories: '/categories/:slug/',
        tags: '/tags/:slug/',
      },
      front_page: { type: 'theme_index' },
      post_index: { enabled: true, path: '/', paginate: true },
      footer: { copyright_text: 'Canonical Import', attribution: true },
    },
    meta: { zeta: 'last', alpha: 'first' },
    newsletter: {
      enabled: true,
      title: 'Updates',
      description: 'Newsletter description',
      button_label: 'Subscribe',
      signup_url: '/newsletter',
      embed_url: '/newsletter/embed',
    },
    comments: {
      enabled: true,
      api_base_url: 'https://source.example/wp-json/wp/v2',
      provider: 'wordpress',
      per_page: 25,
      order: 'asc',
      threading: { enabled: false, max_depth: 4 },
    },
    widgets: {
      zeta: {
        name: 'Zeta',
        items: [{ type: 'text', title: 'Zeta item', settings: { zeta: 2, alpha: 1 } }],
      },
      alpha: {
        name: 'Alpha',
        items: [{ type: 'text', title: 'Alpha item', settings: { zeta: 2, alpha: 1 } }],
      },
    },
    collections: {
      zeta: {
        title: 'Zeta',
        description: 'Zeta collection',
        items: [{ type: 'page', path: 'zeta-page' }, { type: 'post', slug: 'alpha-post' }],
      },
      alpha: {
        title: 'Alpha',
        description: 'Alpha collection',
        items: [{ type: 'page', path: 'zeta-page' }, { type: 'post', slug: 'alpha-post' }],
      },
    },
    custom_css: { content: 'body { color: black; }' },
    custom_html: {
      head_end: '<meta name="canonical" content="true">',
      body_end: '<script src="/canonical.js"></script>',
    },
  };

  const content = [
    postItem({ id: 1, slug: 'alpha-post' }),
    pageItem({ id: 2, slug: 'zeta-page' }),
  ].join('');
  const forward = await convert(content, base);
  const reversed = await convert(content, reverseObjectKeys(base));
  const previewData = forward.previewData;

  assert.deepEqual(Object.keys(previewData), [
    '$schema', 'version', 'generator', 'generated_at', 'site', 'content',
    'widgets', 'collections', 'custom_css', 'custom_html',
  ]);
  assert.deepEqual(Object.keys(previewData.site), [
    'title', 'description', 'url', 'media_origin', 'media_delivery_mode', 'favicon', 'logo',
    'newsletter', 'comments', 'expose_generator', 'search', 'feed', 'archive', 'locale', 'posts_per_page',
    'date_style', 'time_style', 'timezone', 'robots', 'permalinks',
    'front_page', 'post_index', 'footer', 'meta',
  ]);
  assert.deepEqual(Object.keys(previewData.site.comments), [
    'enabled', 'api_base_url', 'provider', 'per_page', 'order', 'threading',
  ]);
  assert.deepEqual(Object.keys(previewData.site.comments.threading), ['enabled', 'max_depth']);
  assert.deepEqual(Object.keys(previewData.site.permalinks), [
    'output_style', 'posts', 'pages', 'categories', 'tags',
  ]);
  assert.deepEqual(Object.keys(previewData.site.favicon), [
    'icon', 'icon_dark', 'svg', 'png', 'apple_touch_icon',
  ]);
  assert.deepEqual(Object.keys(previewData.site.newsletter), [
    'enabled', 'title', 'description', 'button_label', 'signup_url', 'embed_url',
  ]);
  assert.deepEqual(Object.keys(previewData.site.meta), ['alpha', 'zeta']);
  assert.deepEqual(Object.keys(previewData.widgets), ['alpha', 'zeta']);
  assert.deepEqual(Object.keys(previewData.widgets.alpha.items[0]), ['type', 'title', 'settings']);
  assert.deepEqual(Object.keys(previewData.widgets.alpha.items[0].settings), ['alpha', 'zeta']);
  assert.deepEqual(Object.keys(previewData.collections), ['alpha', 'zeta']);
  assert.deepEqual(Object.keys(previewData.collections.alpha), ['title', 'description', 'items']);
  assert.deepEqual(Object.keys(previewData.collections.alpha.items[0]), ['type', 'path']);
  assert.deepEqual(
    previewData.collections.alpha.items.map((item) => item.path ?? item.slug),
    ['zeta-page', 'alpha-post'],
    'canonical key ordering must not reorder arrays',
  );
  assert.deepEqual(Object.keys(previewData.custom_html), ['head_end', 'body_end']);

  assert.equal(forward.previewData.generated_at, '2026-07-15T09:00:00Z');
  assert.equal(
    JSON.stringify(forward.previewData, null, 2),
    JSON.stringify(reversed.previewData, null, 2),
  );
});

test('uses channel pubDate deterministically and rejects missing or invalid values', async () => {
  const source = wxrDocument('').replace(
    'Wed, 15 Jul 2026 09:00:00 +0000',
    'Wed, 15 Jul 2026 18:00:00 +0900',
  );
  const first = await convertDocument(source, {});
  const second = await convertDocument(source, {});

  assert.equal(first.previewData.generated_at, '2026-07-15T09:00:00Z');
  assert.deepEqual(second.previewData, first.previewData);

  await assert.rejects(
    () => convertDocument(source.replace(/\s*<pubDate>[^<]+<\/pubDate>/u, ''), {}),
    /channel pubDate must be a valid RFC 2822 date/,
  );
  await assert.rejects(
    () => convertDocument(source.replace('Wed, 15 Jul 2026', 'Tue, 15 Jul 2026'), {}),
    /channel pubDate must be a valid RFC 2822 date/,
  );
});

test('base validator checks nested types, enums, ranges, and closed objects before parsing WXR', async () => {
  const invalidBases = [
    [{ site: { posts_per_page: 0 } }, /site\.posts_per_page/],
    [{ site: { comments: { api_base_url: '/wp-json/wp/v2' } } }, /use top-level comments/],
    [{ site: { meta: {} } }, /use top-level meta/],
    [{ site: { newsletter: { enabled: false } } }, /use top-level newsletter/],
    [{ site: { disallow_comments: false } }, /site\.disallow_comments is not supported/],
    [{ site: { arbitrary: true } }, /unknown site key arbitrary/],
    [{ site: { search: true } }, /site\.search/],
    [{ site: { search: {} } }, /site\.search\.enabled is required/],
    [{ site: { feed: { enabled: true, extra: true } } }, /unknown site\.feed key extra/],
    [{ site: { archive: { enabled: null } } }, /site\.archive\.enabled/],
    [{ site: { date_style: 'compact' } }, /site\.date_style/],
    [{ site: { time_style: 'compact' } }, /site\.time_style/],
    [{ site: { expose_generator: 'yes' } }, /site\.expose_generator/],
    [{ site: { media_base_url: 'https://media.example' } }, /use site\.media_origin/],
    [{ site: { media_origin: 'https://user:pass@media.example' } }, /credentials, path, query, or fragment/],
    [{ site: { media_origin: 'https://media.example/imported/' } }, /credentials, path, query, or fragment/],
    [{ site: { media_origin: 'https://media.example/./' } }, /credentials, path, query, or fragment/],
    [{ site: { media_origin: 'https://media.example/%2e' } }, /credentials, path, query, or fragment/],
    [{ site: { media_origin: 'https:media.example' } }, /absolute HTTP\(S\) origin/],
    [{ site: { media_origin: 'https://media.example?x=1' } }, /credentials, path, query, or fragment/],
    [{ site: { media_origin: 'ftp://media.example' } }, /absolute HTTP\(S\) origin/],
    [{ site: { permalinks: { output_style: 'file' } } }, /output_style/],
    [{ site: { permalinks: { extra: '/x/' } } }, /unknown site\.permalinks key extra/],
    [{ site: { permalinks: { pages: '/.hidden/:slug' } } }, /unsafe path segment/],
    [{ site: { permalinks: { pages: '/hidden./:slug' } } }, /unsafe path segment/],
    [{ site: { permalinks: { pages: '/release..notes/:slug' } } }, /unsafe path segment/],
    [{ comments: {} }, /comments\.api_base_url is required/],
    [{ comments: { per_page: 25 } }, /comments\.api_base_url is required/],
    [{ comments: { api_base_url: '/wp-json/wp/v2', provider: 'zeropress' } }, /comments\.provider/],
    [{ comments: { enabled: 'yes', api_base_url: '/wp-json/wp/v2' } }, /comments\.enabled/],
    [{ comments: { api_base_url: '/wp-json/wp/v2', per_page: 101 } }, /comments\.per_page/],
    [{ comments: { api_base_url: '/wp-json/wp/v2', threading: { max_depth: 11 } } }, /comments\.threading\.max_depth/],
    [{ comments: { api_base_url: 'wp-json/wp/v2' } }, /comments\.api_base_url/],
    [{ comments: { api_base_url: 'https://user:pass@example.com/wp-json/wp/v2' } }, /credentials/],
    [{ comments: { api_base_url: 'https://@example.com/wp-json/wp/v2' } }, /credentials/],
    [{ comments: { api_base_url: 'https://example.com/wp-json/wp/v2?x=1' } }, /query/],
    [{ comments: { api_base_url: 'https://example.com/wp-json/wp/v2?' } }, /query/],
    [{ comments: { api_base_url: 'https://example.com/wp-json/wp/v2#' } }, /fragment/],
    [{ comments: { api_base_url: 'https://example.com/%ZZ' } }, /comments\.api_base_url/],
    [{ comments: { extra: true } }, /unknown comments key extra/],
    [{ newsletter: { enabled: false, extra: true } }, /unknown newsletter key extra/],
    [{ import: { typo: 'https:\/\/example.com/' } }, /unknown import key typo/],
  ];

  for (const [base, expected] of invalidBases) {
    await assert.rejects(() => convert('', base), expected);
  }
});

test('base preflight rejects invalid preview-data passthrough fields without reading WXR', async () => {
  const invalidBases = [
    [{ site: { title: '' } }, /INVALID_SITE_TITLE site\.title/],
    [{ site: { favicon: {} } }, /INVALID_SITE_FAVICON site\.favicon/],
    [{ site: { logo: { alt: 'Missing source' } } }, /MISSING_REQUIRED_PROPERTY site\.logo\.src/],
    [{ site: { front_page: { type: 'page' } } }, /INVALID_FRONT_PAGE_PAGE_PATH site\.front_page\.page_path/],
    [{ site: { post_index: { path: 'posts' } } }, /INVALID_POST_INDEX_PATH site\.post_index\.path/],
    [{ site: { footer: { attribution: 'yes' } } }, /INVALID_SITE_FOOTER_ATTRIBUTION site\.footer\.attribution/],
    [{ meta: { nested: { value: true } } }, /INVALID_META_VALUE site\.meta\.nested/],
    [{ newsletter: { enabled: true } }, /INVALID_SITE_NEWSLETTER_URL site\.newsletter/],
    [{
      widgets: {
        sidebar: {
          name: 'Sidebar',
          items: 'not-an-array',
        },
      },
    }, /INVALID_WIDGET_AREA_ITEMS widgets\.sidebar\.items/],
    [{
      collections: {
        featured: {
          title: 'Featured',
        },
      },
    }, /MISSING_REQUIRED_PROPERTY collections\.featured\.items/],
  ];

  for (const [base, expected] of invalidBases) {
    let readCount = 0;
    const unreadWxr = {
      async *[Symbol.asyncIterator]() {
        readCount += 1;
        throw new Error('WXR source must not be read during base preflight');
      },
    };

    await assert.rejects(
      () => convertWxrToPreviewData(unreadWxr, { version: '0.7', ...base }),
      expected,
    );
    assert.equal(readCount, 0);
  }
});

test('base preflight defers imported content references to final validation', async () => {
  await assert.rejects(
    () => convert('', {
      site: {
        front_page: { type: 'page', page_path: 'missing' },
      },
    }),
    /INVALID_FRONT_PAGE_PAGE_REFERENCE site\.front_page\.page_path/,
  );

  await assert.rejects(
    () => convert('', {
      collections: {
        featured: {
          items: [{ type: 'post', slug: 'missing' }],
        },
      },
    }),
    /INVALID_COLLECTION_ITEM_REFERENCE collections\.featured\.items\[0\]\.slug/,
  );
});

test('base validator requires the v0.7 contract version', async () => {
  const source = Readable.from([wxrDocument('')]);
  await assert.rejects(
    () => convertWxrToPreviewData(source, {}),
    /version must be exactly "0\.7"/,
  );
  await assert.rejects(
    () => convert('', { version: '0.6' }),
    /version must be exactly "0\.7"/,
  );
  await assert.rejects(
    () => convert('', { version: 0.7 }),
    /version must be exactly "0\.7"/,
  );
});

test('canonicalizes explicit site origin and locale without emitting an inference warning', async () => {
  const result = await convert('', {
    site: {
      url: 'https://Example.COM/',
      locale: 'EN-us',
      timezone: 'UTC',
    },
  });

  assert.equal(result.previewData.site.url, 'https://example.com');
  assert.equal(result.previewData.site.locale, 'en-US');
  assert.equal(result.base.site.url, 'https://example.com');
  assert.equal(result.base.site.locale, 'en-US');
  assert.equal(result.report.warnings.locale_inference_skipped.count, 0);

  for (const url of [
    'https://user@example.com',
    'https://example.com/blog',
    'https://example.com/?preview=1',
    'https://example.com/#top',
  ]) {
    await assert.rejects(
      () => convert('', { site: { url, locale: 'en', timezone: 'UTC' } }),
      /site\.url must be an absolute HTTP\(S\) origin/,
    );
  }
  await assert.rejects(
    () => convert('', { site: { locale: 'not_a_locale', timezone: 'UTC' } }),
    /site\.locale must be a valid BCP 47 language tag/,
  );
});

test('canonicalizes an inferred WXR locale and warns when inference is unavailable', async () => {
  const inferred = await convert('<language>ko-kr</language>', { site: { timezone: 'UTC' } });
  assert.equal(inferred.previewData.site.locale, 'ko-KR');
  assert.equal(inferred.base.site.locale, 'ko-KR');
  assert.equal(inferred.report.warnings.locale_inference_skipped.count, 0);

  const invalid = await convert('<language>not_a_locale</language>', { site: { timezone: 'UTC' } });
  assert.equal(invalid.previewData.site.locale, 'en');
  assert.deepEqual(invalid.report.warnings.locale_inference_skipped, {
    count: 1,
    affected: ['site:locale'],
  });
});

test('canonicalizes an explicit media_origin and preserves it in the resolved base', async () => {
  const result = await convert('', { site: { media_origin: 'HTTPS://MEDIA.EXAMPLE:443/' } });

  assert.equal(result.previewData.site.media_origin, 'https://media.example');
  assert.equal(result.base.site.media_origin, 'https://media.example');
  assert.equal(result.report.inferred.media_origin, undefined);
});

test('accepts safe internal dots in explicit permalink path segments', async () => {
  const result = await convert('', {
    site: {
      permalinks: {
        pages: '/spec/v0.6/:slug',
      },
    },
  });

  assert.equal(result.previewData.site.permalinks.pages, '/spec/v0.6/:slug/');
  assert.equal(result.base.site.permalinks.pages, '/spec/v0.6/:slug/');
});

test('canonicalizes all emitted permalink patterns to the effective output style', async () => {
  const xml = `
    <wp:term><wp:term_slug>main</wp:term_slug><wp:term_name>Main</wp:term_name><wp:term_taxonomy>nav_menu</wp:term_taxonomy></wp:term>
    ${postItem({ id: 1, slug: 'hello-world' })}
    ${menuItem({ id: 100, objectType: 'post', objectId: 1, title: 'Post' })}`;
  const cases = [
    {
      outputStyle: 'directory',
      input: {
        output_style: 'directory',
        posts: '/journal/:slug',
        pages: '/docs/:slug',
        categories: '/topics/:slug',
        tags: '/labels/:slug',
      },
      expected: {
        output_style: 'directory',
        posts: '/journal/:slug/',
        pages: '/docs/:slug/',
        categories: '/topics/:slug/',
        tags: '/labels/:slug/',
      },
      menuUrl: '/journal/hello-world/',
    },
    {
      outputStyle: 'html-extension',
      input: {
        output_style: 'html-extension',
        posts: '/journal/:slug/',
        pages: '/docs/:slug/',
        categories: '/topics/:slug/',
        tags: '/labels/:slug/',
      },
      expected: {
        output_style: 'html-extension',
        posts: '/journal/:slug',
        pages: '/docs/:slug',
        categories: '/topics/:slug',
        tags: '/labels/:slug',
      },
      menuUrl: '/journal/hello-world',
    },
  ];

  for (const { outputStyle, input, expected, menuUrl } of cases) {
    const result = await convert(xml, { site: { permalinks: input } });
    assert.deepEqual(result.previewData.site.permalinks, expected, outputStyle);
    assert.deepEqual(result.base.site.permalinks, expected, outputStyle);
    assert.equal(result.previewData.menus.primary.items[0].url, menuUrl, outputStyle);

    const canonicalInput = await convert(xml, { site: { permalinks: expected } });
    assert.deepEqual(canonicalInput.previewData.site.permalinks, result.previewData.site.permalinks, outputStyle);
    assert.deepEqual(canonicalInput.previewData.menus, result.previewData.menus, outputStyle);

    const rerun = await convert(xml, result.base);
    assert.deepEqual(rerun.base.site.permalinks, result.base.site.permalinks, outputStyle);
    assert.deepEqual(rerun.previewData.menus, result.previewData.menus, outputStyle);
  }
});

test('comment-like meta keys remain ordinary site metadata', async () => {
  const meta = {
    comments_endpoint: 'https://legacy.example/wp-json/wp/v2/comments',
    per_page: 12,
    order: 'asc',
    thread_comments: false,
    thread_comments_depth: 9,
  };
  const first = await convert('', {
    site: {},
    meta,
    comments: { api_base_url: '/wp-json/wp/v2' },
  });

  assert.deepEqual(first.previewData.site.meta, meta);
  assert.deepEqual(first.base.meta, meta);
  assert.deepEqual(first.previewData.site.comments, {
    enabled: true,
    provider: 'wordpress',
    api_base_url: '/wp-json/wp/v2',
    per_page: 50,
    order: 'desc',
    threading: { enabled: true, max_depth: 2 },
  });

  const second = await convert('', first.base);
  assert.deepEqual(second.previewData.site.meta, meta);
  assert.deepEqual(second.base, first.base);
});

test('materializes WordPress comments defaults, preserves explicit enabled policy, and stays idempotent', async () => {
  const first = await convert('', {
    site: {},
    comments: {
      enabled: false,
      api_base_url: '/wp-json/wp/v2/',
      per_page: 25,
      threading: { enabled: false, max_depth: 4 },
    },
  });

  assert.deepEqual(first.previewData.site.comments, {
    enabled: false,
    provider: 'wordpress',
    api_base_url: '/wp-json/wp/v2',
    per_page: 25,
    order: 'desc',
    threading: { enabled: false, max_depth: 4 },
  });
  assert.deepEqual(first.base.comments, first.previewData.site.comments);
  assert.equal(first.report.inferred.comments_api_base_url, undefined);

  const second = await convert('', first.base);
  assert.deepEqual(second.previewData.site.comments, first.previewData.site.comments);
  assert.deepEqual(second.base, first.base);

  const safeAbsolute = await convert('', {
    site: {},
    comments: { api_base_url: 'HTTPS://[2001:db8::1]/wp-json/%76%32/' },
  });
  assert.equal(safeAbsolute.previewData.site.comments.api_base_url, 'HTTPS://[2001:db8::1]/wp-json/%76%32');
});

test('infers the WordPress API base by source priority while preserving a blog subpath', async () => {
  const xml = wxrDocument('').replace(
    '<link>https://source.example</link>',
    `<link>https://link.example/from-link/</link>
    <wp:base_blog_url>https://blog.example/wordpress/</wp:base_blog_url>
    <wp:base_site_url>https://site.example/from-site/</wp:base_site_url>`,
  );
  const result = await convertDocument(xml, { site: {} });

  assert.equal(result.previewData.site.comments.api_base_url, 'https://blog.example/wordpress/wp-json/wp/v2');
  assert.equal(result.report.inferred.comments_api_base_url, 'https://blog.example/wordpress/wp-json/wp/v2');
  assert.deepEqual(result.report.warnings.comments_api_base_inference_skipped, { count: 0, affected: [] });

  const linkFallbackXml = wxrDocument('').replace(
    '<link>https://source.example</link>',
    `<link>https://link.example/from-link/</link>
    <wp:base_blog_url>javascript:alert(1)</wp:base_blog_url>
    <wp:base_site_url>https://site.example/from-site/</wp:base_site_url>`,
  );
  const linkFallback = await convertDocument(linkFallbackXml, { site: {} });
  assert.equal(linkFallback.previewData.site.comments.api_base_url, 'https://link.example/from-link/wp-json/wp/v2');

  for (const unsafeCandidate of [
    'https://@blog.example/wordpress/',
    'https://blog.example/wordpress/?',
    'https://blog.example/wordpress/#',
  ]) {
    const rawMarkerFallbackXml = wxrDocument('').replace(
      '<link>https://source.example</link>',
      `<link>https://link.example/from-link/</link>
      <wp:base_blog_url>${unsafeCandidate}</wp:base_blog_url>
      <wp:base_site_url>https://site.example/from-site/</wp:base_site_url>`,
    );
    const rawMarkerFallback = await convertDocument(rawMarkerFallbackXml, { site: {} });
    assert.equal(rawMarkerFallback.previewData.site.comments.api_base_url, 'https://link.example/from-link/wp-json/wp/v2');
  }

  const siteFallbackXml = wxrDocument('').replace(
    '<link>https://source.example</link>',
    `<link>not-a-url</link>
    <wp:base_blog_url>javascript:alert(1)</wp:base_blog_url>
    <wp:base_site_url>https://site.example/from-site/</wp:base_site_url>`,
  );
  const siteFallback = await convertDocument(siteFallbackXml, { site: { url: 'https://new-static-site.example' } });
  assert.equal(siteFallback.previewData.site.comments.api_base_url, 'https://site.example/from-site/wp-json/wp/v2');

  for (const unsafeCandidate of [
    'https://@link.example/from-link/',
    'https://link.example/from-link/?',
    'https://link.example/from-link/#',
  ]) {
    const rawLinkFallbackXml = wxrDocument('').replace(
      '<link>https://source.example</link>',
      `<link>${unsafeCandidate}</link>
      <wp:base_blog_url>javascript:alert(1)</wp:base_blog_url>
      <wp:base_site_url>https://site.example/from-site/</wp:base_site_url>`,
    );
    const rawLinkFallback = await convertDocument(rawLinkFallbackXml, {
      site: { url: 'https://new-static-site.example' },
    });
    assert.equal(rawLinkFallback.previewData.site.comments.api_base_url, 'https://site.example/from-site/wp-json/wp/v2');
  }
});

test('omits site.comments and warns when no safe source URL can be inferred', async () => {
  const xml = wxrDocument('').replace(
    '<link>https://source.example</link>',
    `<link>not-a-url</link>
    <wp:base_blog_url>javascript:alert(1)</wp:base_blog_url>
    <wp:base_site_url>https://user:password@source.example/</wp:base_site_url>`,
  );
  const result = await convertDocument(xml, {
    site: { url: 'https://new-static-site.example' },
  });

  assert.equal(Object.hasOwn(result.previewData.site, 'comments'), false);
  assert.equal(Object.hasOwn(result.base, 'comments'), false);
  assert.deepEqual(result.report.warnings.comments_api_base_inference_skipped, {
    count: 1,
    affected: ['site:comments'],
  });

  const second = await convertDocument(xml, result.base);
  assert.deepEqual(second.base, result.base);
  assert.equal(Object.hasOwn(second.previewData.site, 'comments'), false);
});

test('maps only exact open and closed comment statuses and fails unknown values closed', async () => {
  const xml = `
    ${postItem({ id: 1, slug: 'open', commentStatus: 'open' })}
    ${postItem({ id: 2, slug: 'closed', commentStatus: 'closed' })}
    ${postItem({ id: 3, slug: 'uppercase', commentStatus: 'OPEN' })}
    ${postItem({ id: 4, slug: 'missing', commentStatus: null })}
    ${pageItem({ id: 11, slug: 'page-open', commentStatus: 'open' })}
    ${pageItem({ id: 12, slug: 'page-closed', commentStatus: 'closed' })}
    ${pageItem({ id: 13, slug: 'page-unknown', commentStatus: 'inherit' })}`;
  const { previewData, report } = await convert(xml, { site: {} });
  const posts = new Map(previewData.content.posts.map((post) => [post.public_id, post.allow_comments]));
  const pages = new Map(previewData.content.pages.map((page) => [page.public_id, page.allow_comments]));

  assert.deepEqual(posts, new Map([[1, true], [2, undefined], [3, undefined], [4, undefined]]));
  assert.deepEqual(pages, new Map([[11, true], [12, undefined], [13, undefined]]));
  assert.equal(previewData.content.posts.filter((post) => Object.hasOwn(post, 'allow_comments')).length, 1);
  assert.equal(previewData.content.pages.filter((page) => Object.hasOwn(page, 'allow_comments')).length, 1);
  assert.deepEqual(report.warnings.invalid_comment_statuses, {
    count: 3,
    affected: ['post:3', 'post:4', 'page:13'],
  });
});

test('preserves isolated internal dots and repairs unsafe dot placement in WXR slugs', async () => {
  const xml = `
    ${postItem({ id: 1, slug: 'theme-runtime-v0.6' })}
    ${postItem({ id: 2, slug: '.hidden' })}
    ${postItem({ id: 3, slug: 'news...today' })}`;
  const { previewData } = await convert(xml, { site: {} });

  assert.deepEqual(
    previewData.content.posts.map((post) => post.slug),
    ['theme-runtime-v0.6', 'hidden', 'news-today'],
  );
});

test('rejects removed site.datetime_display without passthrough compatibility', async () => {
  await assert.rejects(
    () => convert('', { site: { datetime_display: 'static' } }),
    /Invalid base JSON: unknown site key datetime_display/,
  );
});

test('materializes independent default sidebar widgets and keeps the resolved base idempotent', async () => {
  const first = await convert('', { site: { locale: 'en', timezone: 'UTC' } });
  const expected = defaultWidgets();

  assert.deepEqual(first.previewData.widgets, expected);
  assert.deepEqual(first.base.widgets, expected);
  assert.notStrictEqual(first.previewData.widgets, first.base.widgets);
  assert.notStrictEqual(first.previewData.widgets.sidebar, first.base.widgets.sidebar);
  assert.notStrictEqual(first.previewData.widgets.sidebar.items, first.base.widgets.sidebar.items);
  assert.equal(Object.values(first.report.warnings).every(({ count }) => count === 0), true);
  assert.equal(first.previewData.site.search, undefined);
  assert.equal(first.base.site.search, undefined);

  first.previewData.widgets.sidebar.items[0].title = 'Changed only in preview-data';
  assert.equal(first.base.widgets.sidebar.items[0].title, 'Search');

  const second = await convert('', first.base);
  assert.deepEqual(second.previewData.widgets, expected);
  assert.deepEqual(second.base.widgets, expected);
});

test('treats an explicit empty widgets object as an opt-out', async () => {
  const { previewData, base: resolvedBase } = await convert('', { site: {}, widgets: {} });

  assert.deepEqual(previewData.widgets, {});
  assert.deepEqual(resolvedBase.widgets, {});
  assert.notStrictEqual(previewData.widgets, resolvedBase.widgets);
});

test('preserves provided widget maps without adding or augmenting a sidebar', async () => {
  const widgets = {
    rail: {
      name: 'Article Rail',
      items: [{
        type: 'text',
        title: 'Introduction',
        settings: { content: 'Custom content', document_type: 'markdown' },
      }],
    },
  };
  const { previewData, base: resolvedBase } = await convert('', { site: {}, widgets });

  assert.deepEqual(previewData.widgets, widgets);
  assert.deepEqual(resolvedBase.widgets, widgets);
  assert.equal(Object.hasOwn(previewData.widgets, 'sidebar'), false);
  assert.notStrictEqual(previewData.widgets, widgets);
  assert.notStrictEqual(resolvedBase.widgets, widgets);
  assert.notStrictEqual(previewData.widgets, resolvedBase.widgets);
});

test('does not override an explicit site search preference while applying widget fallback', async () => {
  const { previewData, base: resolvedBase } = await convert('', {
    site: {
      search: { enabled: false },
      feed: { enabled: false },
      archive: { enabled: false },
    },
  });

  assert.deepEqual(previewData.site.search, { enabled: false });
  assert.deepEqual(resolvedBase.site.search, { enabled: false });
  assert.deepEqual(previewData.site.feed, { enabled: false });
  assert.deepEqual(resolvedBase.site.feed, { enabled: false });
  assert.deepEqual(previewData.site.archive, { enabled: false });
  assert.deepEqual(resolvedBase.site.archive, { enabled: false });
  assert.deepEqual(previewData.widgets, defaultWidgets());
});

test('passes an explicitly empty widget title through to preview-data and the resolved base', async () => {
  const widgets = {
    sidebar: {
      name: 'Sidebar Widgets',
      items: [{ type: 'search', title: '', settings: { placeholder: 'Search...' } }],
    },
  };
  const { previewData, base: resolvedBase } = await convert('', { site: {}, widgets });

  assert.equal(previewData.widgets.sidebar.items[0].title, '');
  assert.equal(resolvedBase.widgets.sidebar.items[0].title, '');
});

test('infers media_origin, keeps the resolved auto sentinel, and compacts featured media', async () => {
  const source = 'https://media.example/wp-content/uploads';
  const destination = `${source}/imported`;
  const xml = `
    ${attachmentItem(90, `${source}/hero.jpg`, { width: 1018, height: 724, alt: 'Hero' })}
    ${attachmentItem(91, `${source}/unused.jpg`, { width: 640, height: 480 })}
    ${postItem({
      id: 1,
      slug: 'post',
      content: `<img src="${source}/hero.jpg">`,
      postmeta: [['_thumbnail_id', '90'], ['_yoast_wpseo_metadesc', `${source}/hero.jpg`]],
    })}`;
  const { previewData, base: resolvedBase } = await convert(xml, {
    site: {},
    import: {
      media_from: source,
      media_to: destination,
    },
  });
  const post = previewData.content.posts[0];

  assert.equal(resolvedBase.import.media_from, `${source}/`);
  assert.equal(resolvedBase.import.media_to, `${destination}/`);
  assert.equal(previewData.site.media_origin, 'https://media.example');
  assert.equal(resolvedBase.site.media_origin, '');
  assert.equal(post.featured_image, '/wp-content/uploads/imported/hero.jpg');
  assert.equal(post.content, `<img src="${destination}/hero.jpg">`);
  assert.equal(post.meta.description, `${destination}/hero.jpg`);
  assert.equal(post.featured_image.includes('/imported/imported/'), false);
  assert.deepEqual(previewData.content.media, [{
    src: '/wp-content/uploads/imported/hero.jpg',
    width: 1018,
    height: 724,
    alt: 'Hero',
  }]);
});

test('uses a safe attached-file fallback and omits unreferenced or dimensionless media rows', async () => {
  const source = 'https://blog.example/wp-content/uploads/';
  const destination = 'https://media.example/imported/';
  const xml = `
    ${attachmentItem(90, '', { width: 800, height: 600, attachedFile: '2026/01/fallback image.jpg' })}
    ${attachmentItem(91, `${source}unused.jpg`, { width: 320, height: 200 })}
    ${attachmentItem(92, `${source}dimensionless.jpg`)}
    ${attachmentItem(93, '', { width: 320, height: 200, attachedFile: '2026/01/%00unsafe.jpg' })}
    ${attachmentItem(94, 'https:invalid.example/not-absolute.jpg', { width: 640, height: 480, attachedFile: '2026/01/valid-fallback.jpg' })}
    ${postItem({ id: 1, slug: 'fallback', postmeta: [['_thumbnail_id', '90']] })}
    ${postItem({ id: 2, slug: 'dimensionless', postmeta: [['_thumbnail_id', '92']] })}
    ${postItem({ id: 3, slug: 'unsafe', postmeta: [['_thumbnail_id', '93']] })}
    ${postItem({ id: 4, slug: 'malformed-absolute', postmeta: [['_thumbnail_id', '94']] })}`;
  const { previewData, report } = await convert(xml, {
    site: {},
    import: { media_from: source, media_to: destination },
  });

  assert.deepEqual(previewData.content.posts.map((post) => post.featured_image), [
    '/imported/2026/01/fallback%20image.jpg',
    '/imported/dimensionless.jpg',
    undefined,
    '/imported/2026/01/valid-fallback.jpg',
  ]);
  assert.deepEqual(previewData.content.media, [
    {
      src: '/imported/2026/01/fallback%20image.jpg',
      width: 800,
      height: 600,
    },
    {
      src: '/imported/2026/01/valid-fallback.jpg',
      width: 640,
      height: 480,
    },
  ]);
  assert.deepEqual(report.warnings.unresolved_featured_images, {
    count: 1,
    affected: ['post:3:attachment:93'],
  });
});

test('selects duplicate managed-media metadata deterministically when attachment dates are invalid', async () => {
  const url = 'https://media.example/wp-content/uploads/shared.jpg';
  const attachments = [
    attachmentItem(90, url, { width: 800, height: 600, alt: 'Lower ID', modifiedAt: 'invalid' }),
    attachmentItem(91, url, { width: 1600, height: 1200, alt: 'Higher ID', modifiedAt: 'invalid' }),
  ];
  const posts = [
    postItem({ id: 1, slug: 'first', postmeta: [['_thumbnail_id', '90']] }),
    postItem({ id: 2, slug: 'second', postmeta: [['_thumbnail_id', '91']] }),
  ];

  const forward = await convert([...attachments, ...posts].join(''), { site: {} });
  const reversed = await convert([...attachments].reverse().concat([...posts].reverse()).join(''), { site: {} });

  const expected = [{
    src: '/wp-content/uploads/shared.jpg',
    width: 1600,
    height: 1200,
    alt: 'Higher ID',
  }];
  assert.deepEqual(forward.previewData.content.media, expected);
  assert.deepEqual(reversed.previewData.content.media, expected);
});

test('infers an identity media pair only when every attachment has one safe WordPress uploads prefix', async () => {
  const source = 'https://blog.example/wp-content/uploads/';
  const xml = `
    ${attachmentItem(90, `${source}2025/hero.jpg`)}
    ${attachmentItem(91, `${source}2026/photo.jpg`)}
    ${postItem({
      id: 1,
      slug: 'post',
      content: `<img src="${source}2025/hero.jpg">`,
      postmeta: [['_thumbnail_id', '90']],
    })}`;
  const { previewData, base: resolvedBase, report } = await convert(xml, { site: {} });

  assert.deepEqual(resolvedBase.import, {
    media_from: source,
    media_to: source,
  });
  assert.equal(previewData.site.media_origin, 'https://blog.example');
  assert.equal(resolvedBase.site.media_origin, '');
  assert.equal(previewData.content.posts[0].featured_image, '/wp-content/uploads/2025/hero.jpg');
  assert.equal(previewData.content.posts[0].content, `<img src="${source}2025/hero.jpg">`);
  assert.equal(report.inferred.media_prefix, source);
  assert.equal(report.inferred.media_origin, 'https://blog.example');
  assert.deepEqual(report.warnings.media_prefix_inference_skipped, { count: 0, affected: [] });
});

test('does not infer media settings without attachments or from unsafe and conflicting attachment URLs', async () => {
  const source = 'https://blog.example/wp-content/uploads/';
  const noAttachments = await convert(
    postItem({ id: 1, slug: 'content-only', content: `<img src="${source}hero.jpg">` }),
    { site: {} },
  );
  assert.equal(noAttachments.base.import, undefined);
  assert.equal(noAttachments.previewData.site.media_origin, '');
  assert.equal(noAttachments.report.inferred.media_prefix, undefined);
  assert.deepEqual(noAttachments.report.warnings.media_prefix_inference_skipped, { count: 0, affected: [] });

  const invalidCases = [
    [attachmentItem(10, `${source}one.jpg`), attachmentItem(11, 'https://cdn.example/wp-content/uploads/two.jpg')],
    [attachmentItem(20, `${source}one.jpg`), attachmentItem(21, 'not-a-url')],
    [attachmentItem(30, 'https://cdn.example/media/one.jpg')],
    [attachmentItem(40, '')],
  ];
  for (const attachments of invalidCases) {
    const result = await convert(attachments.join(''), { site: {} });
    assert.equal(result.base.import, undefined);
    assert.equal(result.previewData.site.media_origin, '');
    assert.equal(result.report.inferred.media_prefix, undefined);
    assert.equal(result.report.warnings.media_prefix_inference_skipped.count, attachments.length);
  }
});

test('accepts an explicit identity media pair as a normalized runtime no-op', async () => {
  const source = 'https://blog.example/wp-content/uploads';
  const url = `${source}/hero.jpg`;
  const { previewData, base: resolvedBase, report } = await convert(
    `${attachmentItem(90, url)}${postItem({
      id: 1,
      slug: 'identity',
      content: `<img src="${url}">`,
      postmeta: [['_thumbnail_id', '90'], ['_yoast_wpseo_metadesc', url]],
    })}`,
    {
      site: {},
      import: { media_from: source, media_to: `${source}/` },
    },
  );

  assert.deepEqual(resolvedBase.import, {
    media_from: `${source}/`,
    media_to: `${source}/`,
  });
  assert.equal(previewData.site.media_origin, 'https://blog.example');
  assert.equal(resolvedBase.site.media_origin, '');
  assert.equal(previewData.content.posts[0].featured_image, '/wp-content/uploads/hero.jpg');
  assert.equal(previewData.content.posts[0].content, `<img src="${url}">`);
  assert.equal(previewData.content.posts[0].meta.description, url);
  assert.equal(report.inferred.media_prefix, undefined);
});

test('preserves an explicit media_origin and keeps cross-origin featured media absolute', async () => {
  const source = 'https://blog.example/wp-content/uploads/';
  const destination = 'https://media.example/imported/';
  const explicitOrigin = 'https://assets.example/';
  const { previewData, base: resolvedBase } = await convert(
    `${attachmentItem(90, `${source}hero.jpg`)}${postItem({
      id: 1,
      slug: 'explicit-base',
      postmeta: [['_thumbnail_id', '90']],
    })}`,
    {
      site: { media_origin: explicitOrigin },
      import: { media_from: source, media_to: destination },
    },
  );

  assert.equal(previewData.site.media_origin, 'https://assets.example');
  assert.equal(resolvedBase.site.media_origin, 'https://assets.example');
  assert.equal(previewData.content.posts[0].featured_image, `${destination}hero.jpg`);
});

test('does not compact a same-origin absolute URL into a protocol-relative structured URL', async () => {
  const url = 'https://media.example//external-looking/hero.jpg';
  const { previewData } = await convert(
    `${attachmentItem(90, url, { width: 800, height: 600 })}${postItem({
      id: 1,
      slug: 'protocol-relative-boundary',
      postmeta: [['_thumbnail_id', '90']],
    })}`,
    { site: { media_origin: 'https://media.example' } },
  );

  assert.equal(previewData.content.posts[0].featured_image, url);
  assert.deepEqual(previewData.content.media, [{ src: url, width: 800, height: 600 }]);
});

test('reuses the inferred resolved base and remains idempotent after selecting a destination', async () => {
  const source = 'https://blog.example/wp-content/uploads/';
  const destination = 'https://media.example/imported/';
  const xml = `${attachmentItem(90, `${source}hero.jpg`)}${postItem({
    id: 1,
    slug: 'rerun',
    content: `<img src="${source}hero.jpg">`,
    postmeta: [['_thumbnail_id', '90']],
  })}`;

  const first = await convert(xml, { site: {} });
  assert.deepEqual(first.base.import, { media_from: source, media_to: source });
  assert.equal(first.previewData.site.media_origin, 'https://blog.example');
  assert.equal(first.base.site.media_origin, '');

  const selectedBase = structuredClone(first.base);
  selectedBase.import.media_to = destination;
  const second = await convert(xml, selectedBase);
  assert.deepEqual(second.base.import, { media_from: source, media_to: destination });
  assert.equal(second.previewData.site.media_origin, 'https://media.example');
  assert.equal(second.base.site.media_origin, '');
  assert.equal(second.previewData.content.posts[0].featured_image, '/imported/hero.jpg');

  const third = await convert(xml, second.base);
  assert.deepEqual(third.base.import, second.base.import);
  assert.equal(third.previewData.site.media_origin, 'https://media.example');
  assert.equal(third.base.site.media_origin, '');
  assert.equal(third.previewData.content.posts[0].featured_image, '/imported/hero.jpg');
  assert.equal(JSON.stringify(third.previewData).includes('/imported/imported/'), false);
});

test('warns only for featured-image references that remain unresolved', async () => {
  const source = 'https://blog.example/wp-content/uploads/';
  const xml = `
    ${postItem({ id: 1, slug: 'missing', postmeta: [['_thumbnail_id', '999']] })}
    ${postItem({ id: 2, slug: 'late', postmeta: [['_thumbnail_id', '90']] })}
    ${attachmentItem(90, `${source}late.jpg`)}`;
  const { previewData, report } = await convert(xml, { site: {} });
  const posts = new Map(previewData.content.posts.map((post) => [post.public_id, post]));

  assert.equal(posts.get(1).featured_image, undefined);
  assert.equal(posts.get(2).featured_image, '/wp-content/uploads/late.jpg');
  assert.deepEqual(report.warnings.unresolved_featured_images, {
    count: 1,
    affected: ['post:1:attachment:999'],
  });
});

test('media rewrite preserves exact URL spelling while normalizing only the trailing slash', async () => {
  const source = 'HTTPS://MEDIA.EXAMPLE:443/uploads';
  const destination = 'HTTPS://CDN.EXAMPLE:443/imported';
  const { previewData, base: resolvedBase } = await convert(
    postItem({ id: 1, slug: 'exact', content: `<img src="${source}/image.jpg">` }),
    { site: {}, import: { media_from: source, media_to: destination } },
  );

  assert.equal(resolvedBase.import.media_from, `${source}/`);
  assert.equal(resolvedBase.import.media_to, `${destination}/`);
  assert.equal(previewData.content.posts[0].content, `<img src="${destination}/image.jpg">`);
});

test('media rewrite rejects missing, misspelled, relative, non-HTTP, credentialed, query, and fragment prefixes', async () => {
  const invalidImports = [
    { media_from: 'https://example.com/media/' },
    { media_to: 'https://example.com/media/' },
    { media_form: 'https://example.com/media/', media_to: 'https://cdn.example.com/' },
    { media_from: '/media/', media_to: 'https://cdn.example.com/' },
    { media_from: 'https:example.com/media/', media_to: 'https://cdn.example.com/' },
    { media_from: 'https:/example.com/media/', media_to: 'https://cdn.example.com/' },
    { media_from: 'https://example.com\\media/', media_to: 'https://cdn.example.com/' },
    { media_from: 'ftp://example.com/media/', media_to: 'https://cdn.example.com/' },
    { media_from: 'https://user:pass@example.com/media/', media_to: 'https://cdn.example.com/' },
    { media_from: 'https://@example.com/media/', media_to: 'https://cdn.example.com/' },
    { media_from: 'https://example.com/media/?v=1', media_to: 'https://cdn.example.com/' },
    { media_from: 'https://example.com/media/?', media_to: 'https://cdn.example.com/' },
    { media_from: 'https://example.com/media/#x', media_to: 'https://cdn.example.com/' },
    { media_from: 'https://example.com/media/#', media_to: 'https://cdn.example.com/' },
    { media_from: 'https://example.com/media/', media_to: 'https://cdn.example.com/out?q=1' },
  ];

  for (const importOptions of invalidImports) {
    await assert.rejects(() => convert('', { site: {}, import: importOptions }), /Invalid base JSON:.*import/);
  }
});

test('page hierarchy uses the explicit permalink, promotes orphans, resolves sibling conflicts, and drives menu URLs', async () => {
  const xml = `
    <wp:term><wp:term_slug>main</wp:term_slug><wp:term_name>Main</wp:term_name><wp:term_taxonomy>nav_menu</wp:term_taxonomy></wp:term>
    ${pageItem({ id: 10, slug: 'parent', link: 'https://source.example/from-wxr/parent/' })}
    ${pageItem({ id: 40, parent: 10, slug: 'child', title: 'Later child' })}
    ${pageItem({ id: 20, parent: 10, slug: 'child', title: 'Chosen child' })}
    ${pageItem({ id: 30, parent: 999, slug: 'orphan' })}
    ${menuItem({ id: 200, objectType: 'page', objectId: 20, title: 'Child menu' })}`;
  const { previewData, report } = await convert(xml, {
    site: {
      permalinks: {
        output_style: 'directory',
        pages: '/docs/:slug/archive',
      },
    },
  });
  const pageByWpId = new Map(previewData.content.pages.map((page) => [page.public_id, page]));

  assert.equal(pageByWpId.get(10).path, undefined);
  assert.equal(pageByWpId.get(20).path, 'docs/parent/child/archive');
  assert.equal(pageByWpId.get(40).path, 'docs/parent/child-40/archive');
  assert.equal(pageByWpId.get(30).path, undefined);
  assert.equal(previewData.menus.primary.items[0].url, '/docs/parent/child/archive/');
  assert.deepEqual(report.warnings.orphan_page_parents, { count: 1, affected: ['30'] });
  assert.deepEqual(report.warnings.resolved_page_path_conflicts, { count: 1, affected: ['40'] });
});

test('page permalink inference replaces the complete WordPress ancestor lineage', async () => {
  const xml = `
    ${pageItem({ id: 10, slug: 'about', link: 'https://source.example/about/' })}
    ${pageItem({ id: 20, parent: 10, slug: 'team', link: 'https://source.example/about/team/' })}
    ${pageItem({ id: 30, parent: 10, slug: 'contact', link: 'https://source.example/about/contact/' })}`;
  const { previewData, report } = await convert(xml, { site: {} });
  const paths = new Map(previewData.content.pages.map((page) => [page.public_id, page.path]));

  assert.equal(report.inferred.permalinks.pages, '/:slug/');
  assert.equal(paths.get(10), undefined);
  assert.equal(paths.get(20), 'about/team');
  assert.equal(paths.get(30), 'about/contact');
});

test('keeps a top-level page path when html-extension index semantics differ from fallback', async () => {
  const xml = pageItem({ id: 10, slug: 'guide' });
  const { previewData } = await convert(xml, {
    site: {
      permalinks: {
        output_style: 'html-extension',
        pages: '/docs/:slug/index',
      },
    },
  });

  assert.equal(previewData.content.pages[0].path, 'docs/guide/index');
});

test('page self-parent and cycles fail the entire conversion', async () => {
  await assert.rejects(
    () => convert(pageItem({ id: 1, parent: 1, slug: 'self' }), { site: {} }),
    /page 1 is its own parent/,
  );
  await assert.rejects(
    () => convert(`${pageItem({ id: 1, parent: 2, slug: 'one' })}${pageItem({ id: 2, parent: 1, slug: 'two' })}`, { site: {} }),
    /cycle detected/,
  );
});

test('author allocator preserves unique IDs and synthesizes one author per non-empty creator', async () => {
  const xml = `
    ${author({ id: 11, login: 'john doe' })}
    ${author({ id: 22, login: 'john-doe' })}
    ${author({ login: 'john/doe' })}
    ${postItem({ id: 1, slug: 'one', creator: 'john doe' })}
    ${postItem({ id: 2, slug: 'two', creator: 'john-doe' })}
    ${postItem({ id: 3, slug: 'three', creator: 'john/doe' })}
    ${postItem({ id: 4, slug: 'four', creator: 'ghost one' })}
    ${postItem({ id: 5, slug: 'five', creator: 'ghost/one' })}
    ${postItem({ id: 6, slug: 'six', creator: '' })}`;
  const { previewData, report } = await convert(xml, { site: {} });
  const ids = previewData.content.authors.map((entry) => entry.id);
  const postAuthors = new Map(previewData.content.posts.map((post) => [post.public_id, post.author_id]));

  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ['john-doe', 'john-doe-22', 'john-doe-2', 'ghost-one', 'ghost-one-2', 'wordpress-unknown']);
  assert.equal(postAuthors.get(1), 'john-doe');
  assert.equal(postAuthors.get(2), 'john-doe-22');
  assert.equal(postAuthors.get(3), 'john-doe-2');
  assert.equal(postAuthors.get(4), 'ghost-one');
  assert.equal(postAuthors.get(5), 'ghost-one-2');
  assert.equal(postAuthors.get(6), 'wordpress-unknown');
  assert.deepEqual(report.warnings.synthesized_authors, { count: 2, affected: ['ghost one', 'ghost/one'] });
});

test('tag term IDs resolve post_tag taxonomy menu URLs', async () => {
  const xml = `
    <wp:tag><wp:term_id>77</wp:term_id><wp:tag_slug>release</wp:tag_slug><wp:tag_name>Release</wp:tag_name></wp:tag>
    <wp:term><wp:term_slug>main</wp:term_slug><wp:term_name>Main</wp:term_name><wp:term_taxonomy>nav_menu</wp:term_taxonomy></wp:term>
    ${menuItem({ id: 700, objectType: 'post_tag', objectId: 77, title: '' })}`;
  const { previewData } = await convert(xml, {
    site: { permalinks: { tags: '/topics/:slug/' } },
  });

  assert.equal(previewData.menus.primary.items[0].title, 'Release');
  assert.equal(previewData.menus.primary.items[0].url, '/topics/release/');
});

test('rejects category terms whose source slugs normalize to the same slug', async () => {
  const xml = `
    <wp:category><wp:term_id>12</wp:term_id><wp:category_nicename>.news</wp:category_nicename><wp:cat_name>Dot News</wp:cat_name></wp:category>
    <wp:category><wp:term_id>34</wp:term_id><wp:category_nicename>news</wp:category_nicename><wp:cat_name>News</wp:cat_name></wp:category>`;

  await assert.rejects(
    () => convert(xml, { site: {} }),
    {
      message: 'Invalid WXR taxonomy slug collision: category terms '
        + 'ID "12" (slug ".news", name "Dot News") and '
        + 'ID "34" (slug "news", name "News") both normalize to "news". '
        + 'Rename one of these terms in WordPress, then export the WXR again.',
    },
  );
});

test('rejects tag terms whose source slugs normalize to the same slug', async () => {
  const xml = `
    <wp:tag><wp:term_id>56</wp:term_id><wp:tag_slug>release...notes</wp:tag_slug><wp:tag_name>Release Dots</wp:tag_name></wp:tag>
    <wp:tag><wp:term_id>78</wp:term_id><wp:tag_slug>release-notes</wp:tag_slug><wp:tag_name>Release Notes</wp:tag_name></wp:tag>`;

  await assert.rejects(
    () => convert(xml, { site: {} }),
    {
      message: 'Invalid WXR taxonomy slug collision: tag terms '
        + 'ID "56" (slug "release...notes", name "Release Dots") and '
        + 'ID "78" (slug "release-notes", name "Release Notes") '
        + 'both normalize to "release-notes". Rename one of these terms in WordPress, '
        + 'then export the WXR again.',
    },
  );
});

test('rejects colliding category slugs synthesized from inline-only terms', async () => {
  const xml = `
    ${postItem({
      id: 1,
      slug: 'first-category-post',
      categories: [['alpha..beta', 'First Category']],
    })}
    ${postItem({
      id: 2,
      slug: 'second-category-post',
      categories: [['alpha-beta', 'Second Category']],
    })}`;

  await assert.rejects(
    () => convert(xml, { site: {} }),
    {
      message: 'Invalid WXR taxonomy slug collision: category terms '
        + 'post ID "1" inline term (slug "alpha..beta", name "First Category") and '
        + 'post ID "2" inline term (slug "alpha-beta", name "Second Category") '
        + 'both normalize to "alpha-beta". Rename one of these terms in WordPress, '
        + 'then export the WXR again.',
    },
  );
});

test('rejects colliding tag slugs synthesized from inline-only terms', async () => {
  const xml = `
    ${postItem({
      id: 1,
      slug: 'first-tag-post',
      tags: [['release...notes', 'First Tag']],
    })}
    ${postItem({
      id: 2,
      slug: 'second-tag-post',
      tags: [['release-notes', 'Second Tag']],
    })}`;

  await assert.rejects(
    () => convert(xml, { site: {} }),
    {
      message: 'Invalid WXR taxonomy slug collision: tag terms '
        + 'post ID "1" inline term (slug "release...notes", name "First Tag") and '
        + 'post ID "2" inline term (slug "release-notes", name "Second Tag") '
        + 'both normalize to "release-notes". Rename one of these terms in WordPress, '
        + 'then export the WXR again.',
    },
  );
});

test('rejects a collision between a declared term and an inline term', async () => {
  const xml = `
    <wp:category><wp:term_id>12</wp:term_id><wp:category_nicename>.news</wp:category_nicename><wp:cat_name>Dot News</wp:cat_name></wp:category>
    ${postItem({
      id: 1,
      slug: 'inline-category-post',
      categories: [['news', 'Inline News']],
    })}`;

  await assert.rejects(
    () => convert(xml, { site: {} }),
    {
      message: 'Invalid WXR taxonomy slug collision: category terms '
        + 'ID "12" (slug ".news", name "Dot News") and '
        + 'post ID "1" inline term (slug "news", name "Inline News") '
        + 'both normalize to "news". Rename one of these terms in WordPress, '
        + 'then export the WXR again.',
    },
  );
});

test('allows repeated inline references to the same source taxonomy slug', async () => {
  const xml = `
    ${postItem({
      id: 1,
      slug: 'first-news-post',
      categories: [['news', 'News']],
    })}
    ${postItem({
      id: 2,
      slug: 'second-news-post',
      categories: [['news', 'News']],
    })}`;
  const { previewData } = await convert(xml, { site: {} });

  assert.deepEqual(previewData.content.categories, [{
    name: 'News',
    slug: 'news',
  }]);
  assert.deepEqual(
    previewData.content.posts.map((post) => post.category_slugs),
    [['news'], ['news']],
  );
});

test('allows category and tag terms to share the same normalized slug', async () => {
  const xml = `
    <wp:category><wp:term_id>12</wp:term_id><wp:category_nicename>.news</wp:category_nicename><wp:cat_name>Category News</wp:cat_name></wp:category>
    <wp:tag><wp:term_id>34</wp:term_id><wp:tag_slug>news</wp:tag_slug><wp:tag_name>Tag News</wp:tag_name></wp:tag>`;
  const { previewData } = await convert(xml, { site: {} });

  assert.deepEqual(previewData.content.categories, [{
    name: 'Category News',
    slug: 'news',
  }]);
  assert.deepEqual(previewData.content.tags, [{
    name: 'Tag News',
    slug: 'news',
  }]);
});

test('sorts global tags by name and slug while preserving each post WXR tag order', async () => {
  const xml = `
    <wp:tag><wp:term_id>30</wp:term_id><wp:tag_slug>zulu</wp:tag_slug><wp:tag_name>Zulu</wp:tag_name></wp:tag>
    <wp:tag><wp:term_id>20</wp:term_id><wp:tag_slug>beta-slug</wp:tag_slug><wp:tag_name>Alpha</wp:tag_name></wp:tag>
    <wp:tag><wp:term_id>10</wp:term_id><wp:tag_slug>alpha-slug</wp:tag_slug><wp:tag_name>Alpha</wp:tag_name></wp:tag>
    <wp:tag><wp:term_id>40</wp:term_id><wp:tag_slug>middle</wp:tag_slug><wp:tag_name>Beta</wp:tag_name></wp:tag>
    <wp:tag><wp:term_id>50</wp:term_id><wp:tag_slug>umlaut</wp:tag_slug><wp:tag_name>äther</wp:tag_name></wp:tag>
    ${postItem({
      id: 1,
      slug: 'ordered-tags',
      tags: [
        ['zulu', 'Zulu'],
        ['middle', 'Beta'],
        ['alpha-slug', 'Alpha'],
        ['beta-slug', 'Alpha'],
        ['zulu', 'Duplicate Zulu'],
      ],
    })}`;
  const { previewData } = await convert(xml, { site: {} });

  assert.deepEqual(
    previewData.content.tags.map(({ name, slug }) => [name, slug]),
    [
      ['Alpha', 'alpha-slug'],
      ['Alpha', 'beta-slug'],
      ['Beta', 'middle'],
      ['Zulu', 'zulu'],
      ['äther', 'umlaut'],
    ],
  );
  assert.deepEqual(
    previewData.content.posts[0].tag_slugs,
    ['zulu', 'middle', 'alpha-slug', 'beta-slug'],
  );
});

test('excerpt scanner hides unclosed script, style, and comment tails while preserving entity and whitespace policy', async () => {
  const xml = `
    ${postItem({ id: 1, slug: 'script', content: '<p>Hello&nbsp; world</p><script>hidden forever' })}
    ${postItem({ id: 2, slug: 'style', content: '<p>Visible</p><style>.secret {}</style><p>After</p>' })}
    ${postItem({ id: 3, slug: 'comment', content: '<div>A\n\tB &amp; C</div><!-- hidden forever' })}
    ${postItem({ id: 4, slug: 'less-than', content: '<p>Price < 10 and 2 > 1</p>' })}
    ${postItem({ id: 5, slug: 'self-closing-script', content: '<p>Safe</p><script/>alert(1)' })}
    ${postItem({ id: 6, slug: 'ellipsis', content: `${'a'.repeat(160)} b` })}
    ${postItem({ id: 7, slug: 'surrogate', content: `${'a'.repeat(159)}😀b` })}
    ${postItem({ id: 8, slug: 'unclosed-tag-text', content: '<p>Keep</p> <broken tail &amp; words' })}
    ${postItem({ id: 9, slug: 'unclosed-declaration-text', content: '<p>Keep</p> <! broken tail words' })}
    ${postItem({ id: 10, slug: 'unclosed-pi-text', content: '<p>Keep</p> <? broken tail words' })}`;
  const { previewData } = await convert(xml, { site: {} });
  const excerpts = new Map(previewData.content.posts.map((post) => [post.public_id, post.excerpt]));

  assert.equal(excerpts.get(1), 'Hello world');
  assert.equal(excerpts.get(2), 'Visible After');
  assert.equal(excerpts.get(3), 'A B & C');
  assert.equal(excerpts.get(4), 'Price < 10 and 2 > 1');
  assert.equal(excerpts.get(5), 'Safe');
  assert.equal(excerpts.get(6), `${'a'.repeat(160)}...`);
  assert.equal(excerpts.get(7), `${'a'.repeat(159)}...`);
  assert.doesNotMatch(excerpts.get(7), /[\uD800-\uDFFF]/);
  assert.equal(excerpts.get(8), 'Keep <broken tail & words');
  assert.equal(excerpts.get(9), 'Keep <! broken tail words');
  assert.equal(excerpts.get(10), 'Keep <? broken tail words');
});

function convert(channelChildren, base, options) {
  return convertWxrToPreviewData(
    Readable.from([wxrDocument(channelChildren)]),
    { version: '0.7', ...base },
    options,
  );
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => reverseObjectKeys(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
  );
}

function convertDocument(xml, base, options) {
  return convertWxrToPreviewData(
    Readable.from([xml]),
    { version: '0.7', ...base },
    options,
  );
}

function defaultWidgets() {
  return {
    sidebar: {
      name: 'Sidebar Widgets',
      items: [
        {
          type: 'search',
          title: 'Search',
          settings: { placeholder: 'Search...', button_label: 'Search' },
        },
        {
          type: 'recent-posts',
          title: 'Recent Posts',
          settings: { limit: 5, show_date: true },
        },
        {
          type: 'categories',
          title: 'Categories',
          settings: { show_count: false, hierarchical: false },
        },
        {
          type: 'tags',
          title: 'Tags',
          settings: { limit: 20, show_count: false },
        },
        {
          type: 'archives',
          title: 'Archives',
          settings: { limit: 12 },
        },
      ],
    },
  };
}

function wxrDocument(channelChildren) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <pubDate>Wed, 15 Jul 2026 09:00:00 +0000</pubDate>
    <title>Test Site</title>
    <link>https://source.example</link>
    <wp:wxr_version>1.2</wp:wxr_version>
    ${channelChildren}
  </channel>
</rss>`;
}

function author({ id = '', login }) {
  return `<wp:author>
    ${id ? `<wp:author_id>${id}</wp:author_id>` : ''}
    <wp:author_login><![CDATA[${login}]]></wp:author_login>
    <wp:author_display_name><![CDATA[${login}]]></wp:author_display_name>
  </wp:author>`;
}

function postItem({
  id,
  slug,
  creator = '',
  content = '<p>Body</p>',
  postmeta = [],
  commentStatus = 'open',
  categories = [],
  tags = [],
}) {
  return `<item>
    <title>${slug}</title>
    ${creator ? `<dc:creator><![CDATA[${creator}]]></dc:creator>` : ''}
    <content:encoded><![CDATA[${content}]]></content:encoded>
    <wp:post_id>${id}</wp:post_id>
    <wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt>
    <wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt>
    <wp:post_name>${slug}</wp:post_name>
    <wp:post_type>post</wp:post_type>
    <wp:status>publish</wp:status>
    ${commentStatus === null ? '' : `<wp:comment_status>${commentStatus}</wp:comment_status>`}
    ${postmeta.map(([key, value]) => `<wp:postmeta><wp:meta_key>${key}</wp:meta_key><wp:meta_value><![CDATA[${value}]]></wp:meta_value></wp:postmeta>`).join('')}
    ${categories.map(([categorySlug, categoryName]) => `<category domain="category" nicename="${categorySlug}"><![CDATA[${categoryName}]]></category>`).join('')}
    ${tags.map(([tagSlug, tagName]) => `<category domain="post_tag" nicename="${tagSlug}"><![CDATA[${tagName}]]></category>`).join('')}
  </item>`;
}

function pageItem({ id, parent = 0, slug, title = slug, link = '', commentStatus = 'open' }) {
  return `<item>
    <title>${title}</title>
    ${link ? `<link>${link}</link>` : ''}
    <content:encoded><![CDATA[<p>${title}</p>]]></content:encoded>
    <wp:post_id>${id}</wp:post_id>
    <wp:post_parent>${parent}</wp:post_parent>
    <wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt>
    <wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt>
    <wp:post_name>${slug}</wp:post_name>
    <wp:post_type>page</wp:post_type>
    <wp:status>publish</wp:status>
    ${commentStatus === null ? '' : `<wp:comment_status>${commentStatus}</wp:comment_status>`}
  </item>`;
}

function attachmentItem(id, url, {
  width,
  height,
  alt = '',
  attachedFile = '',
  modifiedAt = '2026-01-01 00:00:00',
} = {}) {
  const metadata = Number.isInteger(width) && Number.isInteger(height)
    ? `<wp:postmeta><wp:meta_key>_wp_attachment_metadata</wp:meta_key><wp:meta_value><![CDATA[a:2:{s:5:"width";i:${width};s:6:"height";i:${height};}]]></wp:meta_value></wp:postmeta>`
    : '';
  const altMeta = alt
    ? `<wp:postmeta><wp:meta_key>_wp_attachment_image_alt</wp:meta_key><wp:meta_value><![CDATA[${alt}]]></wp:meta_value></wp:postmeta>`
    : '';
  const fileMeta = attachedFile
    ? `<wp:postmeta><wp:meta_key>_wp_attached_file</wp:meta_key><wp:meta_value><![CDATA[${attachedFile}]]></wp:meta_value></wp:postmeta>`
    : '';
  return `<item>
    <wp:post_id>${id}</wp:post_id>
    <wp:post_modified_gmt>${modifiedAt}</wp:post_modified_gmt>
    <wp:post_type>attachment</wp:post_type>
    <wp:status>inherit</wp:status>
    <wp:attachment_url><![CDATA[${url}]]></wp:attachment_url>
    ${metadata}
    ${altMeta}
    ${fileMeta}
  </item>`;
}

function menuItem({ id, objectType, objectId, title }) {
  const itemType = objectType === 'page' || objectType === 'post' ? 'post_type' : 'taxonomy';
  return `<item>
    <title>${title}</title>
    <wp:post_id>${id}</wp:post_id>
    <wp:post_type>nav_menu_item</wp:post_type>
    <wp:status>publish</wp:status>
    <category domain="nav_menu" nicename="main">Main</category>
    <wp:postmeta><wp:meta_key>_menu_item_type</wp:meta_key><wp:meta_value>${itemType}</wp:meta_value></wp:postmeta>
    <wp:postmeta><wp:meta_key>_menu_item_object</wp:meta_key><wp:meta_value>${objectType}</wp:meta_value></wp:postmeta>
    <wp:postmeta><wp:meta_key>_menu_item_object_id</wp:meta_key><wp:meta_value>${objectId}</wp:meta_value></wp:postmeta>
  </item>`;
}
