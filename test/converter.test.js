import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { validatePreviewData } from '@zeropress/preview-data-validator';
import { convertWxrToPreviewData } from '../src/converter.js';

test('converts published WXR content into valid preview-data', async () => {
  const { previewData, report, base: resolvedBase } = await convert(sampleWxr(), base(), {
    packageVersion: '0.7.0',
  });

  assert.equal(validatePreviewData(previewData).ok, true);
  assert.equal(previewData.$schema, 'https://schemas.zeropress.dev/preview-data/v0.7/schema.json');
  assert.equal(previewData.version, '0.7');
  assert.equal(previewData.generator, 'zeropress-wxr-import v0.7.0');
  assert.equal(previewData.site.title, 'Base Title');
  assert.equal(Object.hasOwn(previewData.site, 'datetime_display'), false);
  assert.equal(previewData.site.media_origin, 'https://media.example.com');
  assert.equal(previewData.content.authors.length, 1);
  assert.equal(previewData.content.posts.length, 1);
  assert.equal(previewData.content.pages.length, 2);
  assert.equal(previewData.content.categories.length, 1);
  assert.equal(previewData.content.tags.length, 1);
  assert.equal(previewData.content.posts[0].public_id, 100);
  assert.equal(previewData.content.posts[0].featured_image, '/imported/2026/01/hero.jpg');
  assert.deepEqual(previewData.content.media, [{
    src: '/imported/2026/01/hero.jpg',
    width: 1600,
    height: 900,
    alt: 'Imported hero',
  }]);
  assert.match(previewData.content.posts[0].content, /https:\/\/media\.example\.com\/imported\/2026\/01\/hero\.jpg/);
  assert.equal(previewData.content.pages[0].slug, 'test3');
  assert.equal(previewData.content.pages[1].slug, 'test3');
  assert.equal(previewData.content.pages[1].path, 'test3-102');
  assert.equal(previewData.content.pages[0].excerpt, 'Page one');
  assert.equal(previewData.content.pages[1].excerpt, 'Page two');
  assert.equal(previewData.content.pages[0].public_id, 101);
  assert.equal(Object.hasOwn(previewData.content.pages[0], 'meta'), false);
  assert.equal(previewData.content.pages[0].allow_comments, true);
  assert.equal(Object.hasOwn(previewData.content.pages[1], 'allow_comments'), false);
  assert.equal(previewData.menus.primary.items[0].title, 'Imported Post');
  assert.equal(previewData.menus.primary.items[0].url, '/post/100');
  assert.equal(previewData.menus.primary.items[0].type, undefined);
  assert.equal(
    resolvedBase.$schema,
    'https://schemas.zeropress.dev/wxr-import-base/v0.7/schema.json',
  );
  assert.equal(resolvedBase.version, '0.7');
  assert.deepEqual(previewData.site.comments, {
    enabled: true,
    provider: 'wordpress',
    api_base_url: 'https://blog.example/wp-json/wp/v2',
    per_page: 50,
    order: 'desc',
    threading: { enabled: true, max_depth: 2 },
  });
  assert.equal(Object.hasOwn(resolvedBase.site, 'datetime_display'), false);
  assert.equal(resolvedBase.site.media_origin, '');
  assert.equal(resolvedBase.site.permalinks.output_style, 'html-extension');
  assert.deepEqual(resolvedBase.comments, previewData.site.comments);
  assert.equal(resolvedBase.import.media_to, 'https://media.example.com/imported/');
  assert.equal(report.counts.posts, 1);
  assert.equal(report.counts.pages, 2);
  assert.equal(report.counts.media, 1);

  assert.deepEqual(Object.keys(previewData.content), [
    'authors', 'posts', 'pages', 'categories', 'tags', 'media',
  ]);
  assert.deepEqual(Object.keys(previewData.content.posts[0]), [
    'public_id', 'title', 'slug', 'content', 'document_type', 'excerpt',
    'published_at_iso', 'updated_at_iso', 'author_id', 'featured_image', 'status',
    'allow_comments', 'category_slugs', 'tag_slugs',
  ]);
  assert.deepEqual(Object.keys(previewData.content.pages[1]), [
    'public_id', 'title', 'slug', 'path', 'content', 'document_type', 'excerpt',
    'updated_at_iso', 'status',
  ]);
  assert.deepEqual(Object.keys(previewData.content.media[0]), ['src', 'width', 'height', 'alt']);
  assert.deepEqual(Object.keys(previewData.menus.primary), ['name', 'items']);
  assert.deepEqual(Object.keys(previewData.menus.primary.items[0]), ['title', 'url', 'target', 'children']);
  assert.deepEqual(Object.keys(previewData.widgets.sidebar.items[0].settings), [
    'button_label', 'placeholder',
  ]);
});

test('excludes non-published posts and pages', async () => {
  const { previewData, report } = await convert(sampleWxr(), base());

  assert.equal(previewData.content.posts.some((post) => post.slug === 'draft-post'), false);
  assert.equal(report.skipped.unpublished_posts, 1);
});

test('generates default WordPress comment configuration when base omits comments', async () => {
  const { previewData, report, base: resolvedBase } = await convert(sampleWxr(), baseWithoutComments());

  assert.deepEqual(previewData.site.comments, {
    enabled: true,
    provider: 'wordpress',
    api_base_url: 'https://old.example/wp-json/wp/v2',
    per_page: 50,
    order: 'desc',
    threading: { enabled: true, max_depth: 2 },
  });
  assert.deepEqual(resolvedBase.comments, previewData.site.comments);
  assert.equal(report.inferred.comments_api_base_url, 'https://old.example/wp-json/wp/v2');
});

test('sorts posts by published_at descending', async () => {
  const { previewData } = await convert(sampleWxrWithOutOfOrderPosts(), base());

  assert.deepEqual(
    previewData.content.posts.map((post) => post.public_id),
    [100, 200],
  );
  assert.deepEqual(
    previewData.content.posts.map((post) => post.published_at_iso),
    ['2026-01-05T00:00:00Z', '2026-01-01T00:00:00Z'],
  );
});

test('builds post excerpt from WXR excerpt, SEO description, then content', async () => {
  const { previewData } = await convert(sampleWxrWithPostExcerptFallbacks(), base());
  const postsById = new Map(previewData.content.posts.map((post) => [post.public_id, post]));

  assert.equal(postsById.get(100).excerpt, 'Explicit WXR excerpt');
  assert.equal(postsById.get(200).excerpt, 'SEO plugin description');
  assert.equal(postsById.get(200).meta.description, 'SEO plugin description');
  assert.equal(postsById.get(300).excerpt, 'Hello world with link & entities ©');
});

test('resolves featured images even when attachment items appear later', async () => {
  const { previewData, report } = await convert(sampleWxrWithLateAttachment(), base());

  assert.equal(previewData.content.posts[0].featured_image, '/imported/2026/01/late.jpg');
  assert.deepEqual(report.warnings.unresolved_featured_images, { count: 0, affected: [] });
});

test('uses ZeroPress default permalinks when base omits site.permalinks', async () => {
  const { previewData, base: resolvedBase } = await convert(sampleWxr(), baseWithoutPermalinks());

  assert.equal(previewData.content.posts[0].slug, 'imported-post');
  assert.equal(previewData.menus.primary.items[0].url, '/posts/imported-post/');
  assert.deepEqual(previewData.site.permalinks, {
    output_style: 'directory',
    posts: '/posts/:slug/',
    pages: '/:slug/',
    categories: '/categories/:slug/',
    tags: '/tags/:slug/',
  });
  assert.deepEqual(resolvedBase.site.permalinks, previewData.site.permalinks);
});

test('infers post public_id permalinks from same-origin WXR links', async () => {
  const { previewData, report } = await convert(sampleWxrWithPostIdPermalinks(), baseWithoutPermalinks());

  assert.equal(previewData.site.permalinks.output_style, 'html-extension');
  assert.equal(previewData.site.permalinks.posts, '/post/:public_id');
  assert.equal(previewData.site.permalinks.pages, '/:slug');
  assert.equal(previewData.site.permalinks.categories, '/categories/:slug');
  assert.equal(previewData.site.permalinks.tags, '/tags/:slug');
  assert.equal(previewData.menus.primary.items[0].url, '/post/100');
  assert.equal(report.inferred.permalinks.output_style, 'html-extension');
  assert.equal(report.inferred.permalinks.posts, '/post/:public_id');
});

test('normalizes same-origin custom menu URLs to root-relative URLs', async () => {
  const { previewData } = await convert(sampleWxrWithCustomMenus(), base());

  assert.equal(previewData.menus.primary.items[0].url, '/');
  assert.equal(previewData.menus.primary.items[1].url, '/about/?ref=menu#top');
  assert.equal(previewData.menus.primary.items[2].url, 'https://external.example/path/');
});

test('removes unsafe menu URLs', async () => {
  const { previewData, report } = await convert(sampleWxrWithUnsafeMenu(), base());

  assert.equal(previewData.menus, undefined);
  assert.deepEqual(report.warnings.skipped_menu_items, { count: 1, affected: ['201'] });
});

test('rejects generated sections in base files', async () => {
  await assert.rejects(
    () => convert(sampleWxr(), { preview_data: {} }),
    /preview_data is generated by wxr-import/,
  );
  await assert.rejects(() => convert(sampleWxr(), { content: {} }), /content is generated by wxr-import/);
  await assert.rejects(() => convert(sampleWxr(), { menus: {} }), /menus is generated by wxr-import/);
  await assert.rejects(() => convert(sampleWxr(), { unknown: true }), /unknown top-level key unknown/);
});

function convert(xml, baseData, options) {
  return convertWxrToPreviewData(Readable.from([xml]), baseData, options);
}

function base() {
  return {
    $schema: 'https://schemas.zeropress.dev/wxr-import-base/v0.7/schema.json',
    version: '0.7',
    site: {
      title: 'Base Title',
      description: '',
      url: 'https://zeropress.example',
      locale: 'en',
      posts_per_page: 10,
      date_style: 'medium',
      time_style: 'short',
      timezone: 'UTC',
      permalinks: {
        output_style: 'html-extension',
        posts: '/post/:public_id',
        pages: '/:slug',
        categories: '/category/:slug',
        tags: '/tag/:slug',
      },
    },
    comments: {
      enabled: true,
      provider: 'wordpress',
      api_base_url: 'https://blog.example/wp-json/wp/v2',
      per_page: 50,
      order: 'desc',
      threading: { enabled: true, max_depth: 2 },
    },
    import: {
      media_from: 'https://old.example/wp-content/uploads/',
      media_to: 'https://media.example.com/imported/',
    },
  };
}

function baseWithoutPermalinks() {
  const value = base();
  delete value.site.permalinks;
  return value;
}

function baseWithoutComments() {
  const value = base();
  delete value.comments;
  return value;
}

function sampleWxrWithOutOfOrderPosts() {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <pubDate>Wed, 15 Jul 2026 09:00:00 +0000</pubDate>
    <wp:wxr_version>1.2</wp:wxr_version>
    <title>WordPress Site</title>
    <link>https://old.example</link>
    <description>Imported from WXR</description>
    <language>en</language>
    <item>
      <title><![CDATA[Older Post]]></title>
      <content:encoded><![CDATA[<p>Older</p>]]></content:encoded>
      <wp:post_id>200</wp:post_id>
      <wp:post_date_gmt><![CDATA[2026-01-01 00:00:00]]></wp:post_date_gmt>
      <wp:post_modified_gmt><![CDATA[2026-01-01 00:00:00]]></wp:post_modified_gmt>
      <wp:post_name><![CDATA[older-post]]></wp:post_name>
      <wp:post_type><![CDATA[post]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
    </item>
    <item>
      <title><![CDATA[Newer Post]]></title>
      <content:encoded><![CDATA[<p>Newer</p>]]></content:encoded>
      <wp:post_id>100</wp:post_id>
      <wp:post_date_gmt><![CDATA[2026-01-05 00:00:00]]></wp:post_date_gmt>
      <wp:post_modified_gmt><![CDATA[2026-01-05 00:00:00]]></wp:post_modified_gmt>
      <wp:post_name><![CDATA[newer-post]]></wp:post_name>
      <wp:post_type><![CDATA[post]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
    </item>
  </channel>
</rss>`;
}

function sampleWxrWithPostExcerptFallbacks() {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <pubDate>Wed, 15 Jul 2026 09:00:00 +0000</pubDate>
    <wp:wxr_version>1.2</wp:wxr_version>
    <title>WordPress Site</title>
    <link>https://old.example</link>
    <description>Imported from WXR</description>
    <language>en</language>
    <item>
      <title><![CDATA[Explicit Excerpt]]></title>
      <content:encoded><![CDATA[<p>Content should not be used.</p>]]></content:encoded>
      <excerpt:encoded><![CDATA[Explicit WXR excerpt]]></excerpt:encoded>
      <wp:post_id>100</wp:post_id>
      <wp:post_date_gmt><![CDATA[2026-01-03 00:00:00]]></wp:post_date_gmt>
      <wp:post_modified_gmt><![CDATA[2026-01-03 00:00:00]]></wp:post_modified_gmt>
      <wp:post_name><![CDATA[explicit-excerpt]]></wp:post_name>
      <wp:post_type><![CDATA[post]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:postmeta>
        <wp:meta_key><![CDATA[_yoast_wpseo_metadesc]]></wp:meta_key>
        <wp:meta_value><![CDATA[SEO description should not be used]]></wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title><![CDATA[SEO Description]]></title>
      <content:encoded><![CDATA[<p>Content should not be used.</p>]]></content:encoded>
      <excerpt:encoded><![CDATA[]]></excerpt:encoded>
      <wp:post_id>200</wp:post_id>
      <wp:post_date_gmt><![CDATA[2026-01-02 00:00:00]]></wp:post_date_gmt>
      <wp:post_modified_gmt><![CDATA[2026-01-02 00:00:00]]></wp:post_modified_gmt>
      <wp:post_name><![CDATA[seo-description]]></wp:post_name>
      <wp:post_type><![CDATA[post]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:postmeta>
        <wp:meta_key><![CDATA[_yoast_wpseo_metadesc]]></wp:meta_key>
        <wp:meta_value><![CDATA[SEO plugin description]]></wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title><![CDATA[Content Fallback]]></title>
      <content:encoded><![CDATA[<p>Hello <strong>world</strong><br>with <a href="https://example.com">link</a> &amp; entities &copy;</p>]]></content:encoded>
      <excerpt:encoded><![CDATA[]]></excerpt:encoded>
      <wp:post_id>300</wp:post_id>
      <wp:post_date_gmt><![CDATA[2026-01-01 00:00:00]]></wp:post_date_gmt>
      <wp:post_modified_gmt><![CDATA[2026-01-01 00:00:00]]></wp:post_modified_gmt>
      <wp:post_name><![CDATA[content-fallback]]></wp:post_name>
      <wp:post_type><![CDATA[post]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
    </item>
  </channel>
</rss>`;
}

function sampleWxr() {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <pubDate>Wed, 15 Jul 2026 09:00:00 +0000</pubDate>
    <wp:wxr_version>1.2</wp:wxr_version>
    <title>WordPress Site</title>
    <link>https://old.example</link>
    <description>Imported from WXR</description>
    <language>en</language>
    <wp:author>
      <wp:author_login><![CDATA[alice]]></wp:author_login>
      <wp:author_display_name><![CDATA[Alice Doe]]></wp:author_display_name>
    </wp:author>
    <wp:category>
      <wp:term_id>7</wp:term_id>
      <wp:category_nicename><![CDATA[news]]></wp:category_nicename>
      <wp:cat_name><![CDATA[News]]></wp:cat_name>
      <wp:category_description><![CDATA[News posts]]></wp:category_description>
    </wp:category>
    <wp:tag>
      <wp:tag_slug><![CDATA[release]]></wp:tag_slug>
      <wp:tag_name><![CDATA[Release]]></wp:tag_name>
    </wp:tag>
    <wp:term>
      <wp:term_slug><![CDATA[main-menu]]></wp:term_slug>
      <wp:term_name><![CDATA[Main Menu]]></wp:term_name>
      <wp:term_taxonomy><![CDATA[nav_menu]]></wp:term_taxonomy>
    </wp:term>
    <item>
      <title><![CDATA[Hero Image]]></title>
      <wp:post_id>900</wp:post_id>
      <wp:post_date_gmt><![CDATA[2026-01-01 00:00:00]]></wp:post_date_gmt>
      <wp:post_modified_gmt><![CDATA[2026-01-01 00:00:00]]></wp:post_modified_gmt>
      <wp:post_type><![CDATA[attachment]]></wp:post_type>
      <wp:status><![CDATA[inherit]]></wp:status>
      <wp:attachment_url><![CDATA[https://old.example/wp-content/uploads/2026/01/hero.jpg]]></wp:attachment_url>
      <wp:postmeta>
        <wp:meta_key><![CDATA[_wp_attachment_metadata]]></wp:meta_key>
        <wp:meta_value><![CDATA[a:2:{s:5:"width";i:1600;s:6:"height";i:900;}]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key><![CDATA[_wp_attachment_image_alt]]></wp:meta_key>
        <wp:meta_value><![CDATA[Imported hero]]></wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title><![CDATA[Imported Post]]></title>
      <dc:creator><![CDATA[alice]]></dc:creator>
      <content:encoded><![CDATA[<p><img src="https://old.example/wp-content/uploads/2026/01/hero.jpg"></p>]]></content:encoded>
      <excerpt:encoded><![CDATA[Post excerpt]]></excerpt:encoded>
      <wp:post_id>100</wp:post_id>
      <wp:post_date_gmt><![CDATA[2026-01-02 03:04:05]]></wp:post_date_gmt>
      <wp:post_modified_gmt><![CDATA[2026-01-03 03:04:05]]></wp:post_modified_gmt>
      <wp:post_name><![CDATA[imported-post]]></wp:post_name>
      <wp:post_type><![CDATA[post]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:comment_status><![CDATA[open]]></wp:comment_status>
      <wp:postmeta>
        <wp:meta_key><![CDATA[_thumbnail_id]]></wp:meta_key>
        <wp:meta_value><![CDATA[900]]></wp:meta_value>
      </wp:postmeta>
      <category domain="category" nicename="news"><![CDATA[News]]></category>
      <category domain="post_tag" nicename="release"><![CDATA[Release]]></category>
    </item>
    <item>
      <title><![CDATA[Draft Post]]></title>
      <wp:post_id>1010</wp:post_id>
      <wp:post_date_gmt><![CDATA[2026-01-02 03:04:05]]></wp:post_date_gmt>
      <wp:post_modified_gmt><![CDATA[2026-01-03 03:04:05]]></wp:post_modified_gmt>
      <wp:post_name><![CDATA[draft-post]]></wp:post_name>
      <wp:post_type><![CDATA[post]]></wp:post_type>
      <wp:status><![CDATA[draft]]></wp:status>
    </item>
    <item>
      <title><![CDATA[Test 3]]></title>
      <content:encoded><![CDATA[<p>Page one</p>]]></content:encoded>
      <wp:post_id>101</wp:post_id>
      <wp:post_date_gmt><![CDATA[2026-01-02 03:04:05]]></wp:post_date_gmt>
      <wp:post_modified_gmt><![CDATA[2026-01-03 03:04:05]]></wp:post_modified_gmt>
      <wp:post_name><![CDATA[test3]]></wp:post_name>
      <wp:post_type><![CDATA[page]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:comment_status><![CDATA[open]]></wp:comment_status>
    </item>
    <item>
      <title><![CDATA[Test 3 Duplicate]]></title>
      <content:encoded><![CDATA[<p>Page two</p>]]></content:encoded>
      <wp:post_id>102</wp:post_id>
      <wp:post_date_gmt><![CDATA[2026-01-02 03:04:05]]></wp:post_date_gmt>
      <wp:post_modified_gmt><![CDATA[2026-01-03 03:04:05]]></wp:post_modified_gmt>
      <wp:post_name><![CDATA[test3]]></wp:post_name>
      <wp:post_type><![CDATA[page]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:comment_status><![CDATA[closed]]></wp:comment_status>
    </item>
    <item>
      <title><![CDATA[Imported Post]]></title>
      <wp:post_id>201</wp:post_id>
      <wp:post_type><![CDATA[nav_menu_item]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:menu_order>1</wp:menu_order>
      <category domain="nav_menu" nicename="main-menu"><![CDATA[Main Menu]]></category>
      <wp:postmeta><wp:meta_key><![CDATA[_menu_item_type]]></wp:meta_key><wp:meta_value><![CDATA[post_type]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key><![CDATA[_menu_item_object]]></wp:meta_key><wp:meta_value><![CDATA[post]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key><![CDATA[_menu_item_object_id]]></wp:meta_key><wp:meta_value><![CDATA[100]]></wp:meta_value></wp:postmeta>
    </item>
  </channel>
</rss>`;
}

function sampleWxrWithUnsafeMenu() {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <pubDate>Wed, 15 Jul 2026 09:00:00 +0000</pubDate>
    <wp:wxr_version>1.2</wp:wxr_version>
    <title>WordPress Site</title>
    <wp:term>
      <wp:term_slug><![CDATA[main-menu]]></wp:term_slug>
      <wp:term_name><![CDATA[Main Menu]]></wp:term_name>
      <wp:term_taxonomy><![CDATA[nav_menu]]></wp:term_taxonomy>
    </wp:term>
    <item>
      <title><![CDATA[Bad Link]]></title>
      <wp:post_id>201</wp:post_id>
      <wp:post_type><![CDATA[nav_menu_item]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
      <category domain="nav_menu" nicename="main-menu"><![CDATA[Main Menu]]></category>
      <wp:postmeta><wp:meta_key><![CDATA[_menu_item_type]]></wp:meta_key><wp:meta_value><![CDATA[custom]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key><![CDATA[_menu_item_url]]></wp:meta_key><wp:meta_value><![CDATA[javascript:alert(1)]]></wp:meta_value></wp:postmeta>
    </item>
  </channel>
</rss>`;
}

function sampleWxrWithPostIdPermalinks() {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <pubDate>Wed, 15 Jul 2026 09:00:00 +0000</pubDate>
    <wp:wxr_version>1.2</wp:wxr_version>
    <title>WordPress Site</title>
    <link>https://old.example</link>
    <wp:base_blog_url>https://old.example</wp:base_blog_url>
    <wp:term>
      <wp:term_slug><![CDATA[main-menu]]></wp:term_slug>
      <wp:term_name><![CDATA[Main Menu]]></wp:term_name>
      <wp:term_taxonomy><![CDATA[nav_menu]]></wp:term_taxonomy>
    </wp:term>
    <item>
      <title><![CDATA[Imported Post]]></title>
      <link>https://old.example/post/100</link>
      <content:encoded><![CDATA[<p>Body</p>]]></content:encoded>
      <wp:post_id>100</wp:post_id>
      <wp:post_date><![CDATA[2026-01-02 03:04:05]]></wp:post_date>
      <wp:post_date_gmt><![CDATA[2026-01-02 03:04:05]]></wp:post_date_gmt>
      <wp:post_modified_gmt><![CDATA[2026-01-03 03:04:05]]></wp:post_modified_gmt>
      <wp:post_name><![CDATA[imported-post]]></wp:post_name>
      <wp:post_type><![CDATA[post]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
    </item>
    <item>
      <title><![CDATA[Second Post]]></title>
      <link>https://old.example/post/200</link>
      <content:encoded><![CDATA[<p>Body</p>]]></content:encoded>
      <wp:post_id>200</wp:post_id>
      <wp:post_date><![CDATA[2026-01-04 03:04:05]]></wp:post_date>
      <wp:post_date_gmt><![CDATA[2026-01-04 03:04:05]]></wp:post_date_gmt>
      <wp:post_modified_gmt><![CDATA[2026-01-05 03:04:05]]></wp:post_modified_gmt>
      <wp:post_name><![CDATA[second-post]]></wp:post_name>
      <wp:post_type><![CDATA[post]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
    </item>
    <item>
      <title><![CDATA[Imported Post]]></title>
      <wp:post_id>201</wp:post_id>
      <wp:post_type><![CDATA[nav_menu_item]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:menu_order>1</wp:menu_order>
      <category domain="nav_menu" nicename="main-menu"><![CDATA[Main Menu]]></category>
      <wp:postmeta><wp:meta_key><![CDATA[_menu_item_type]]></wp:meta_key><wp:meta_value><![CDATA[post_type]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key><![CDATA[_menu_item_object]]></wp:meta_key><wp:meta_value><![CDATA[post]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key><![CDATA[_menu_item_object_id]]></wp:meta_key><wp:meta_value><![CDATA[100]]></wp:meta_value></wp:postmeta>
    </item>
  </channel>
</rss>`;
}

function sampleWxrWithCustomMenus() {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <pubDate>Wed, 15 Jul 2026 09:00:00 +0000</pubDate>
    <wp:wxr_version>1.2</wp:wxr_version>
    <title>WordPress Site</title>
    <link>https://old.example</link>
    <wp:base_blog_url>https://old.example</wp:base_blog_url>
    <wp:term>
      <wp:term_slug><![CDATA[main-menu]]></wp:term_slug>
      <wp:term_name><![CDATA[Main Menu]]></wp:term_name>
      <wp:term_taxonomy><![CDATA[nav_menu]]></wp:term_taxonomy>
    </wp:term>
    <item>
      <title><![CDATA[Home]]></title>
      <wp:post_id>301</wp:post_id>
      <wp:post_type><![CDATA[nav_menu_item]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:menu_order>1</wp:menu_order>
      <category domain="nav_menu" nicename="main-menu"><![CDATA[Main Menu]]></category>
      <wp:postmeta><wp:meta_key><![CDATA[_menu_item_type]]></wp:meta_key><wp:meta_value><![CDATA[custom]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key><![CDATA[_menu_item_url]]></wp:meta_key><wp:meta_value><![CDATA[https://old.example/]]></wp:meta_value></wp:postmeta>
    </item>
    <item>
      <title><![CDATA[About]]></title>
      <wp:post_id>302</wp:post_id>
      <wp:post_type><![CDATA[nav_menu_item]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:menu_order>2</wp:menu_order>
      <category domain="nav_menu" nicename="main-menu"><![CDATA[Main Menu]]></category>
      <wp:postmeta><wp:meta_key><![CDATA[_menu_item_type]]></wp:meta_key><wp:meta_value><![CDATA[custom]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key><![CDATA[_menu_item_url]]></wp:meta_key><wp:meta_value><![CDATA[https://old.example/about/?ref=menu#top]]></wp:meta_value></wp:postmeta>
    </item>
    <item>
      <title><![CDATA[External]]></title>
      <wp:post_id>303</wp:post_id>
      <wp:post_type><![CDATA[nav_menu_item]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:menu_order>3</wp:menu_order>
      <category domain="nav_menu" nicename="main-menu"><![CDATA[Main Menu]]></category>
      <wp:postmeta><wp:meta_key><![CDATA[_menu_item_type]]></wp:meta_key><wp:meta_value><![CDATA[custom]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key><![CDATA[_menu_item_url]]></wp:meta_key><wp:meta_value><![CDATA[https://external.example/path/]]></wp:meta_value></wp:postmeta>
    </item>
  </channel>
</rss>`;
}

function sampleWxrWithLateAttachment() {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <pubDate>Wed, 15 Jul 2026 09:00:00 +0000</pubDate>
    <wp:wxr_version>1.2</wp:wxr_version>
    <title>WordPress Site</title>
    <link>https://old.example</link>
    <language>en</language>
    <item>
      <title><![CDATA[Post With Late Attachment]]></title>
      <content:encoded><![CDATA[<p>Body</p>]]></content:encoded>
      <wp:post_id>300</wp:post_id>
      <wp:post_date_gmt><![CDATA[2026-01-02 03:04:05]]></wp:post_date_gmt>
      <wp:post_modified_gmt><![CDATA[2026-01-03 03:04:05]]></wp:post_modified_gmt>
      <wp:post_name><![CDATA[post-with-late-attachment]]></wp:post_name>
      <wp:post_type><![CDATA[post]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:postmeta>
        <wp:meta_key><![CDATA[_thumbnail_id]]></wp:meta_key>
        <wp:meta_value><![CDATA[901]]></wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title><![CDATA[Late Image]]></title>
      <wp:post_id>901</wp:post_id>
      <wp:post_date_gmt><![CDATA[2026-01-01 00:00:00]]></wp:post_date_gmt>
      <wp:post_modified_gmt><![CDATA[2026-01-01 00:00:00]]></wp:post_modified_gmt>
      <wp:post_type><![CDATA[attachment]]></wp:post_type>
      <wp:status><![CDATA[inherit]]></wp:status>
      <wp:attachment_url><![CDATA[https://old.example/wp-content/uploads/2026/01/late.jpg]]></wp:attachment_url>
    </item>
  </channel>
</rss>`;
}
