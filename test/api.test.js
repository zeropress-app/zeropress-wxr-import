import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { converterVersion, convertWxrToPreviewData, validateBase } from '../src/api.js';
import { convertWxrToPreviewData as convertCore } from '../src/converter.js';

const xml = '<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/"><channel><title>Example site</title><link>https://example.com/</link><pubDate>Sun, 04 Oct 2026 00:00:00 +0000</pubDate><language>en</language><wp:wxr_version>1.2</wp:wxr_version></channel></rss>';

test('the public API accepts a Web byte stream and matches the CLI converter', async () => {
  const actual = await convertWxrToPreviewData(new Blob([xml]).stream());
  const expected = await convertCore(new Blob([xml]).stream(), { version: '0.7' }, {
    generatorVersion: converterVersion,
  });
  assert.deepEqual(actual, expected);
  assert.equal(actual.previewData.generator, `zeropress-wxr-import v${converterVersion}`);
});

test('public base validation preserves advanced settings and rejects generated sections', () => {
  const base = { version: '0.7', widgets: {}, custom_html: { body_end: '<script>example()</script>' } };
  assert.deepEqual(validateBase(base), base);
  assert.throws(() => validateBase({ ...base, content: {} }), /content is generated/);
});

test('public base validation preserves comments URL spelling and root paths', () => {
  for (const [input, expected] of [
    ['/', '/'],
    ['/wp-json//wp/v2///', '/wp-json//wp/v2'],
    ['HTTPS://API.EXAMPLE:443/wp-json/%76%32///', 'HTTPS://API.EXAMPLE:443/wp-json/%76%32'],
    ['https://api.example///', 'https://api.example'],
  ]) {
    const normalized = validateBase({ version: '0.7', comments: { api_base_url: input } });
    assert.equal(normalized.comments.api_base_url, expected);
  }
  assert.throws(() => validateBase({ version: '0.7', comments: { api_base_url: '//' } }), /safe root-relative path/);
});

test('public base validation completes with long internal slash runs', () => {
  assertApiCompletes(`
    const path = '/a' + '/'.repeat(500_000) + 'b';
    const source = 'HTTPS://SOURCE.EXAMPLE:443' + path;
    const destination = 'https://cdn.example' + path;
    for (const suffix of ['', '///']) {
      const normalized = validateBase({
        version: '0.7',
        import: { media_from: source + suffix, media_to: destination + suffix },
      });
      assert.ok(normalized.import.media_from === source + '/', 'source prefix must retain its spelling');
      assert.ok(normalized.import.media_to === destination + '/', 'destination prefix must end in one slash');
      for (const endpoint of [source, path]) {
        const comments = validateBase({ version: '0.7', comments: { api_base_url: endpoint + suffix } });
        assert.ok(comments.comments.api_base_url === endpoint, 'comments URL must trim only trailing slashes');
      }
    }
    assert.throws(() => validateBase({
      version: '0.7', site: { permalinks: { posts: path + '/:slug/' } },
    }), /non-empty path segments/);
  `);
});

test('public conversion completes with long slash runs in base settings and WXR source URLs', () => {
  assertApiCompletes(`
    const document = ${JSON.stringify(xml)};
    const source = 'https://blog.example/a' + '/'.repeat(500_000) + 'b';
    const destination = 'https://cdn.example/uploads';
    const explicit = await convertWxrToPreviewData(new Blob([document]).stream(), {
      version: '0.7', import: { media_from: source, media_to: destination },
    });
    assert.ok(explicit.base.import.media_from === source + '/', 'base media prefix must be normalized');
    assert.equal(explicit.base.import.media_to, destination + '/');

    const wxr = document.replace('</channel>',
      '<wp:base_blog_url>' + source + '///</wp:base_blog_url>' +
      '<item><title>Entry</title><link>' + source + '/posts/entry/</link>' +
      '<wp:post_id>1</wp:post_id><wp:post_type>post</wp:post_type>' +
      '<wp:status>publish</wp:status><wp:post_name>entry</wp:post_name>' +
      '<wp:post_date>2026-10-04 00:00:00</wp:post_date>' +
      '<wp:post_date_gmt>2026-10-04 00:00:00</wp:post_date_gmt>' +
      '<wp:post_modified_gmt>2026-10-04 00:00:00</wp:post_modified_gmt>' +
      '</item></channel>');
    const inferred = await convertWxrToPreviewData(new Blob([wxr]).stream());
    assert.ok(inferred.previewData.site.comments.api_base_url === source + '/wp-json/wp/v2',
      'inferred comments API must retain the WordPress subpath');
    assert.equal(inferred.previewData.content.posts[0].slug, 'entry');
    assert.equal(inferred.base.site.permalinks.posts, '/posts/:slug/');
  `);
});

test('conversion and PHP metadata work without a Node Buffer global', () => {
  const apiUrl = new URL('../src/api.js', import.meta.url).href;
  const metadataUrl = new URL('../src/wordpress-attachment-metadata.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { convertWxrToPreviewData } from ${JSON.stringify(apiUrl)};
    import { parseWordPressAttachmentMetadata } from ${JSON.stringify(metadataUrl)};
    globalThis.Buffer = undefined;
    const result = await convertWxrToPreviewData(new Blob([${JSON.stringify(xml)}]).stream());
    assert.equal(result.previewData.site.title, 'Example site');
    assert.deepEqual(parseWordPressAttachmentMetadata('a:3:{s:5:"width";i:640;s:6:"height";i:480;s:4:"file";s:10:"café.jpg";}'), null);
    assert.deepEqual(parseWordPressAttachmentMetadata('a:3:{s:5:"width";i:640;s:6:"height";i:480;s:4:"file";s:9:"café.jpg";}'), {width:640,height:480,file:'café.jpg'});
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

function assertApiCompletes(script) {
  const apiUrl = new URL('../src/api.js', import.meta.url).href;
  // A child-process timeout can stop a synchronous regex that blocks the event loop.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { convertWxrToPreviewData, validateBase } from ${JSON.stringify(apiUrl)};
    ${script}
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}
