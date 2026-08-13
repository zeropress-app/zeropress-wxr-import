import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { parseXml } from '../src/xml.js';

const WXR_NAMESPACE = 'http://wordpress.org/export/1.2/';

test('strict streaming parser preserves UTF-8, tag, and CDATA data across arbitrary byte boundaries', async () => {
  const xml = wxrDocument(`
    <item>
      <title><![CDATA[한글 🚀 title]]></title>
      <content:encoded><![CDATA[<p>멀티바이트 본문 &amp; text</p>]]></content:encoded>
      <wp:post_id>7</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
    </item>`);
  const expected = await parseXml(Readable.from([xml]));
  const bytes = Buffer.from(xml, 'utf8');
  const oneByteChunks = (async function* chunks() {
    for (const byte of bytes) yield Uint8Array.of(byte);
  }());
  const actual = await parseXml(oneByteChunks);

  assert.deepEqual(actual, expected);
  assert.equal(actual.channel.pubDate, 'Wed, 15 Jul 2026 09:00:00 +0000');
  assert.equal(actual.items[0].title, '한글 🚀 title');
  assert.equal(actual.items[0].content, '<p>멀티바이트 본문 &amp; text</p>');
});

test('parser normalizes Unicode line separators to LF across byte boundaries', async () => {
  const xml = wxrDocument(`
    <item>
      <title>Unicode separators</title>
      <content:encoded><![CDATA[Before\u2028Middle\u2029After]]></content:encoded>
      <wp:post_id>8</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
    </item>`);
  const bytes = Buffer.from(xml, 'utf8');
  const oneByteChunks = (async function* chunks() {
    for (const byte of bytes) yield Uint8Array.of(byte);
  }());

  const document = await parseXml(oneByteChunks);

  assert.equal(document.items[0].content, 'Before\nMiddle\nAfter');
});

test('parser normalizes CRLF once when CR and LF cross input chunk boundaries', async () => {
  const xml = wxrDocument(`
    <item>
      <title>Line endings</title>
      <content:encoded><![CDATA[Before\r\n\r\nMiddle\rAfter]]></content:encoded>
      <wp:post_id>9</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
    </item>`);
  const expected = await parseXml(Readable.from([xml]));
  const bytes = Buffer.from(xml, 'utf8');
  const oneByteChunks = (async function* chunks() {
    for (const byte of bytes) yield Uint8Array.of(byte);
  }());
  const byteChunkResult = await parseXml(oneByteChunks);
  const firstCrLf = xml.indexOf('\r\n');
  const stringChunkResult = await parseXml(Readable.from([
    xml.slice(0, firstCrLf + 1),
    xml.slice(firstCrLf + 1),
  ]));

  assert.equal(expected.items[0].content, 'Before\n\nMiddle\nAfter');
  assert.deepEqual(byteChunkResult, expected);
  assert.deepEqual(stringChunkResult, expected);
});

test('parser removes malformed UTF-8 bytes and forbidden controls without removing valid U+FFFD', async () => {
  const prefix = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0" xmlns:wp="${WXR_NAMESPACE}">
      <channel>
        <title>Before`, 'utf8');
  const suffix = Buffer.from(`After</title>
        <pubDate>Wed, 15 Jul 2026 09:00:00 +0000</pubDate>
        <wp:wxr_version>1.2</wp:wxr_version>
      </channel>
    </rss>`, 'utf8');
  const source = Readable.from([
    prefix,
    Buffer.from([0xc3]),
    Buffer.from([0x28, 0x01, 0xef]),
    Buffer.from([0xbf, 0xbd]),
    suffix,
  ]);

  const document = await parseXml(source);

  assert.equal(document.channel.title, 'Before(�After');
});

test('parser rejects malformed XML, DOCTYPE, and undeclared entities', async () => {
  await assert.rejects(() => parseXml(stream('<rss>')), /Invalid WXR XML/);
  await assert.rejects(
    () => parseXml(stream(`<!DOCTYPE rss [<!ENTITY x "unsafe">]>${wxrDocument('<item/>')}`)),
    /DOCTYPE is not allowed/,
  );
  await assert.rejects(
    () => parseXml(stream(wxrDocument('<title>&notDeclared;</title>'))),
    /Invalid WXR XML/,
  );
});

test('parser enforces RSS root, one direct channel, WXR namespace, and direct version 1.2', async () => {
  const cases = [
    ['root', '<feed/>', /rss 2\.0 root/],
    ['rss version', '<rss version="1.0"><channel/></rss>', /rss 2\.0 root/],
    ['channel', '<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/"/>', /exactly one direct channel/],
    ['multiple channels', '<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/"><channel/><channel/></rss>', /exactly one direct channel/],
    ['namespace', '<rss version="2.0"><channel><wxr_version>1.2</wxr_version></channel></rss>', /missing WordPress export 1.2 namespace/],
    ['version', '<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/"><channel><wp:wxr_version>1.1</wp:wxr_version></channel></rss>', /only WXR version 1.2/],
    ['nested version', '<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/"><channel><wrapper><wp:wxr_version>1.2</wp:wxr_version></wrapper></channel></rss>', /only WXR version 1.2/],
  ];

  for (const [name, xml, expected] of cases) {
    await assert.rejects(() => parseXml(stream(xml)), expected, name);
  }
});

test('parser discards comments and unknown plugin metadata while retaining allowed postmeta', async () => {
  const document = await parseXml(stream(wxrDocument(`
    <item>
      <title>Post</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:comment><wp:comment_id>100</wp:comment_id><wp:comment_content>secret</wp:comment_content></wp:comment>
      <plugin:large xmlns:plugin="https://plugin.example/ns"><plugin:value>discard me</plugin:value></plugin:large>
      <wp:postmeta><wp:meta_key>unknown_plugin_key</wp:meta_key><wp:meta_value>discard me</wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key>_thumbnail_id</wp:meta_key><wp:meta_value>9</wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key>_wp_attachment_metadata</wp:meta_key><wp:meta_value><![CDATA[a:3:{s:5:"width";i:1018;s:6:"height";i:724;s:5:"sizes";a:1:{s:5:"large";a:2:{s:5:"width";i:800;s:6:"height";i:569;}}}]]></wp:meta_value></wp:postmeta>
    </item>`)));

  assert.deepEqual(document.items[0].postmeta, { _thumbnail_id: '9' });
  assert.deepEqual(document.items[0].attachmentMetadata, { width: 1018, height: 724 });
  assert.equal(JSON.stringify(document).includes('sizes'), false);
  assert.equal(JSON.stringify(document).includes('secret'), false);
  assert.equal(JSON.stringify(document).includes('discard me'), false);
});

test('parser releases selected item bodies after all item metadata has been parsed', async () => {
  const inspected = [];
  const document = await parseXml(stream(wxrDocument(`
    <item>
      <title>Draft</title>
      <content:encoded><![CDATA[<p>Discarded content</p>]]></content:encoded>
      <excerpt:encoded><![CDATA[Discarded excerpt]]></excerpt:encoded>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>draft</wp:status>
    </item>
    <item>
      <title>Published</title>
      <content:encoded><![CDATA[<p>Retained content</p>]]></content:encoded>
      <excerpt:encoded><![CDATA[Retained excerpt]]></excerpt:encoded>
      <wp:post_id>2</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
    </item>`)), {
    shouldRetainItemBody(item) {
      inspected.push({
        content: item.content,
        excerpt: item.excerpt,
        status: item.wp.status,
      });
      return item.wp.status === 'publish';
    },
  });

  assert.deepEqual(inspected, [
    {
      content: '<p>Discarded content</p>',
      excerpt: 'Discarded excerpt',
      status: 'draft',
    },
    {
      content: '<p>Retained content</p>',
      excerpt: 'Retained excerpt',
      status: 'publish',
    },
  ]);
  assert.equal(document.items[0].content, '');
  assert.equal(document.items[0].excerpt, '');
  assert.equal(document.items[0].title, 'Draft');
  assert.equal(document.items[0].wp.status, 'draft');
  assert.equal(document.items[1].content, '<p>Retained content</p>');
  assert.equal(document.items[1].excerpt, 'Retained excerpt');
});

test('parser accepts only async iterable sources', async () => {
  await assert.rejects(() => parseXml(wxrDocument('')), /expected an async iterable XML source/);
});

function stream(value) {
  return Readable.from([value]);
}

function wxrDocument(channelChildren) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <pubDate>Wed, 15 Jul 2026 09:00:00 +0000</pubDate>
    <title>Test</title>
    <wp:wxr_version>1.2</wp:wxr_version>
    ${channelChildren}
  </channel>
</rss>`;
}
