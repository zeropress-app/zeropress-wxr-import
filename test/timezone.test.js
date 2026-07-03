import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { convertWxrToPreviewData } from '../src/converter.js';

test('canonicalizes authoritative explicit IANA and offset time zones', async () => {
  for (const [input, expected] of [
    [' asia/seoul ', 'Asia/Seoul'],
    ['+09:00', '+09:00'],
    ['-00:00', 'UTC'],
    ['utc', 'UTC'],
  ]) {
    const result = await convert('', { site: { timezone: input } });
    assert.equal(result.previewData.site.timezone, expected, input);
    assert.equal(result.base.site.timezone, expected, input);
    assert.equal(result.report.inferred.timezone, undefined, input);
    assert.equal(result.report.warnings.timezone_inference_skipped.count, 0, input);
    assert.equal(result.report.warnings.timezone_inference_ambiguous.count, 0, input);
  }
});

test('rejects blank and invalid explicit time zones before parsing WXR', async () => {
  for (const timezone of ['', '   ', 'Mars/Olympus', 'GMT+9']) {
    await assert.rejects(
      () => convert('', { site: { timezone } }),
      /site\.timezone must be a non-blank valid IANA time zone or canonical ±HH:MM offset/,
      timezone,
    );
  }
});

test('infers one fixed +09:00 offset and materializes an idempotent resolved base', async () => {
  const xml = postItem({
    id: 1,
    slug: 'seoul-post',
    local: '2026-01-02 08:30:00',
    gmt: '2026-01-01 23:30:00',
  });
  const first = await convert(xml, { site: {} });

  assert.equal(first.previewData.site.timezone, '+09:00');
  assert.equal(first.base.site.timezone, '+09:00');
  assert.equal(first.report.inferred.timezone, '+09:00');
  assert.equal(first.report.warnings.timezone_inference_skipped.count, 0);
  assert.equal(first.report.warnings.timezone_inference_ambiguous.count, 0);

  const second = await convert(xml, first.base);
  assert.equal(second.previewData.site.timezone, '+09:00');
  assert.deepEqual(second.base, first.base);
  assert.equal(second.report.inferred.timezone, undefined);
  assert.equal(second.report.warnings.timezone_inference_skipped.count, 0);
  assert.equal(second.report.warnings.timezone_inference_ambiguous.count, 0);
});

test('canonicalizes a consistently inferred zero offset as UTC', async () => {
  const result = await convert(postItem({
    id: 1,
    slug: 'utc-post',
    local: '2026-01-02 03:04:05',
    gmt: '2026-01-02 03:04:05',
  }), { site: {} });

  assert.equal(result.previewData.site.timezone, 'UTC');
  assert.equal(result.base.site.timezone, 'UTC');
  assert.equal(result.report.inferred.timezone, 'UTC');
  assert.equal(result.report.warnings.timezone_inference_skipped.count, 0);
});

test('accepts valid leap dates and both inclusive fourteen-hour offset boundaries', async () => {
  const leap = await convert(postItem({
    id: 1,
    slug: 'leap-day',
    local: '2024-02-29 12:00:00',
    gmt: '2024-02-29 12:00:00',
  }), { site: {} });
  assert.equal(leap.report.inferred.timezone, 'UTC');

  for (const [local, gmt, expected] of [
    ['2026-01-02 14:00:00', '2026-01-02 00:00:00', '+14:00'],
    ['2026-01-01 10:00:00', '2026-01-02 00:00:00', '-14:00'],
  ]) {
    const result = await convert(postItem({ id: 1, slug: 'boundary', local, gmt }), { site: {} });
    assert.equal(result.previewData.site.timezone, expected);
    assert.equal(result.report.inferred.timezone, expected);
  }
});

test('infers a fractional fixed offset from published Page-only evidence', async () => {
  const result = await convert(postItem({
    id: 1,
    slug: 'page-only',
    local: '2026-01-02 09:00:00',
    gmt: '2026-01-02 03:30:00',
    type: 'page',
  }), { site: {} });

  assert.equal(result.previewData.content.posts.length, 0);
  assert.equal(result.previewData.content.pages.length, 1);
  assert.equal(result.previewData.site.timezone, '+05:30');
  assert.equal(result.report.inferred.timezone, '+05:30');
});

test('falls back to UTC with an actionable warning when no trustworthy pair exists', async () => {
  const result = await convert(postItem({
    id: 1,
    slug: 'missing-local-date',
    local: 'not-a-date',
    gmt: '2026-01-02 03:04:05',
  }), { site: {} });

  assert.equal(result.previewData.site.timezone, 'UTC');
  assert.equal(result.base.site.timezone, 'UTC');
  assert.equal(result.report.inferred.timezone, undefined);
  assert.deepEqual(result.report.warnings.timezone_inference_skipped, {
    count: 1,
    affected: ['site:timezone'],
  });
});

test('does not guess a majority offset when trustworthy pairs span DST offsets', async () => {
  const result = await convert(`
    ${postItem({
      id: 1,
      slug: 'winter',
      local: '2026-01-01 07:00:00',
      gmt: '2026-01-01 12:00:00',
    })}
    ${postItem({
      id: 2,
      slug: 'summer',
      local: '2026-07-01 08:00:00',
      gmt: '2026-07-01 12:00:00',
    })}
    ${postItem({
      id: 3,
      slug: 'another-winter',
      local: '2026-02-01 07:00:00',
      gmt: '2026-02-01 12:00:00',
    })}
  `, { site: {} });

  assert.equal(result.previewData.site.timezone, 'UTC');
  assert.equal(result.report.inferred.timezone, undefined);
  assert.deepEqual(result.report.warnings.timezone_inference_ambiguous, {
    count: 2,
    affected: ['-05:00', '-04:00'],
  });
});

test('ignores attachments, menu items, excluded content, and invalid output rows as evidence', async () => {
  const result = await convert(`
    ${postItem({
      id: 1,
      slug: 'valid',
      local: '2026-01-02 09:00:00',
      gmt: '2026-01-02 00:00:00',
    })}
    ${postItem({
      id: 2,
      slug: 'invalid-modified',
      local: '2026-01-02 08:00:00',
      gmt: '2026-01-02 00:00:00',
      modified: 'not-a-date',
    })}
    ${postItem({
      id: 3,
      slug: 'password',
      local: '2026-01-02 07:00:00',
      gmt: '2026-01-02 00:00:00',
      password: 'protected',
    })}
    ${postItem({
      id: 'bad-id',
      slug: 'invalid-id',
      local: '2026-01-02 06:00:00',
      gmt: '2026-01-02 00:00:00',
    })}
    <item>
      <wp:post_id>100</wp:post_id>
      <wp:post_date>2026-01-02 05:00:00</wp:post_date>
      <wp:post_date_gmt>2026-01-02 00:00:00</wp:post_date_gmt>
      <wp:post_modified_gmt>2026-01-02 00:00:00</wp:post_modified_gmt>
      <wp:post_type>nav_menu_item</wp:post_type>
      <wp:status>publish</wp:status>
    </item>
    <item>
      <wp:post_id>101</wp:post_id>
      <wp:post_date>2026-01-02 04:00:00</wp:post_date>
      <wp:post_date_gmt>2026-01-02 00:00:00</wp:post_date_gmt>
      <wp:post_modified_gmt>2026-01-02 00:00:00</wp:post_modified_gmt>
      <wp:post_type>attachment</wp:post_type>
      <wp:status>inherit</wp:status>
    </item>
  `, { site: {} });

  assert.equal(result.previewData.site.timezone, '+09:00');
  assert.equal(result.report.inferred.timezone, '+09:00');
  assert.equal(result.report.warnings.timezone_inference_ambiguous.count, 0);
});

test('ignores out-of-range, sub-minute, invalid Gregorian, and unpublished evidence', async () => {
  const result = await convert(`
    ${postItem({
      id: 1,
      slug: 'valid',
      local: '2026-01-02 09:00:00',
      gmt: '2026-01-02 00:00:00',
    })}
    ${postItem({
      id: 2,
      slug: 'over-fourteen-hours-by-one-minute',
      local: '2026-01-02 14:01:00',
      gmt: '2026-01-02 00:00:00',
    })}
    ${postItem({
      id: 3,
      slug: 'sub-minute',
      local: '2026-01-02 09:00:01',
      gmt: '2026-01-02 00:00:00',
    })}
    ${postItem({
      id: 4,
      slug: 'invalid-leap-day',
      local: '2025-02-29 09:00:00',
      gmt: '2025-02-29 00:00:00',
    })}
    ${postItem({
      id: 5,
      slug: 'unpublished',
      local: '2026-01-02 08:00:00',
      gmt: '2026-01-02 00:00:00',
      status: 'draft',
    })}
  `, { site: {} });

  assert.equal(result.previewData.site.timezone, '+09:00');
  assert.equal(result.report.inferred.timezone, '+09:00');
  assert.equal(result.report.warnings.timezone_inference_ambiguous.count, 0);
});

test('uses WXR local dates for permalink inference and effective timezone for generated menu URLs', async () => {
  const result = await convert(`
    <wp:term>
      <wp:term_slug>main</wp:term_slug>
      <wp:term_name>Main</wp:term_name>
      <wp:term_taxonomy>nav_menu</wp:term_taxonomy>
    </wp:term>
    ${postItem({
      id: 1,
      slug: 'boundary-post',
      local: '2026-01-02 01:30:00',
      gmt: '2026-01-01 16:30:00',
      link: 'https://source.example/2026/01/02/boundary-post/',
    })}
    ${postItem({
      id: 2,
      slug: 'second-post',
      local: '2026-02-03 01:30:00',
      gmt: '2026-02-02 16:30:00',
      link: 'https://source.example/2026/02/03/second-post/',
    })}
    ${menuItem({ id: 100, objectId: 1, title: 'Boundary' })}
  `, { site: {} });

  assert.equal(result.previewData.site.timezone, '+09:00');
  assert.equal(result.previewData.site.permalinks.posts, '/:year/:month/:day/:slug/');
  assert.equal(result.report.inferred.permalinks.posts, '/:year/:month/:day/:slug/');
  assert.equal(result.previewData.menus.primary.items[0].url, '/2026/01/02/boundary-post/');
});

test('skips ambiguous public-id/year and repeated month/day permalink candidates', async () => {
  const result = await convert(`
    ${postItem({
      id: 2026,
      slug: 'id-year-collision',
      local: '2026-02-03 00:00:00',
      gmt: '2026-02-03 00:00:00',
      link: 'https://source.example/2026/02/03/id-year-collision/',
    })}
    ${postItem({
      id: 10,
      slug: 'month-day-collision',
      local: '2026-01-01 00:00:00',
      gmt: '2026-01-01 00:00:00',
      link: 'https://source.example/2026/01/01/month-day-collision/',
    })}
    ${postItem({
      id: 11,
      slug: 'first-safe',
      local: '2026-02-03 00:00:00',
      gmt: '2026-02-03 00:00:00',
      link: 'https://source.example/2026/02/03/first-safe/',
    })}
    ${postItem({
      id: 12,
      slug: 'second-safe',
      local: '2026-04-05 00:00:00',
      gmt: '2026-04-05 00:00:00',
      link: 'https://source.example/2026/04/05/second-safe/',
    })}
  `, { site: {} });

  assert.equal(result.previewData.site.permalinks.posts, '/:year/:month/:day/:slug/');
  assert.equal(result.report.inferred.permalinks.posts, '/:year/:month/:day/:slug/');
});

test('keeps identity-only permalink inference without a local date and rejects unidentified numeric segments', async () => {
  const identityOnly = await convert(postItem({
    id: 123,
    slug: 'identity-only',
    local: 'not-a-date',
    gmt: '2026-01-02 03:04:05',
    link: 'https://source.example/post/123',
  }), { site: {} });

  assert.equal(identityOnly.previewData.site.permalinks.posts, '/post/:public_id');
  assert.equal(identityOnly.report.inferred.permalinks.posts, '/post/:public_id');

  const dateLooking = await convert(postItem({
    id: 124,
    slug: 'date-looking',
    local: 'not-a-date',
    gmt: '2026-01-02 03:04:05',
    link: 'https://source.example/2026/date-looking/',
  }), { site: {} });

  assert.equal(dateLooking.previewData.site.permalinks.posts, '/posts/:slug/');
  assert.equal(dateLooking.report.inferred.permalinks.posts, undefined);
});

function convert(channelChildren, base) {
  return convertWxrToPreviewData(
    Readable.from([wxrDocument(channelChildren)]),
    { version: '0.7', ...base },
  );
}

function postItem({
  id,
  slug,
  local,
  gmt,
  modified = gmt,
  password = '',
  link = '',
  type = 'post',
  status = 'publish',
}) {
  return `<item>
    <title>${slug}</title>
    ${link ? `<link>${link}</link>` : ''}
    <content:encoded><![CDATA[<p>Body</p>]]></content:encoded>
    <wp:post_id>${id}</wp:post_id>
    <wp:post_date>${local}</wp:post_date>
    <wp:post_date_gmt>${gmt}</wp:post_date_gmt>
    <wp:post_modified_gmt>${modified}</wp:post_modified_gmt>
    <wp:post_name>${slug}</wp:post_name>
    <wp:post_password>${password}</wp:post_password>
    <wp:post_type>${type}</wp:post_type>
    <wp:status>${status}</wp:status>
    <wp:comment_status>open</wp:comment_status>
  </item>`;
}

function menuItem({ id, objectId, title }) {
  return `<item>
    <title>${title}</title>
    <wp:post_id>${id}</wp:post_id>
    <wp:post_type>nav_menu_item</wp:post_type>
    <wp:status>publish</wp:status>
    <category domain="nav_menu" nicename="main">Main</category>
    <wp:postmeta><wp:meta_key>_menu_item_type</wp:meta_key><wp:meta_value>post_type</wp:meta_value></wp:postmeta>
    <wp:postmeta><wp:meta_key>_menu_item_object</wp:meta_key><wp:meta_value>post</wp:meta_value></wp:postmeta>
    <wp:postmeta><wp:meta_key>_menu_item_object_id</wp:meta_key><wp:meta_value>${objectId}</wp:meta_value></wp:postmeta>
  </item>`;
}

function wxrDocument(channelChildren) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
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
