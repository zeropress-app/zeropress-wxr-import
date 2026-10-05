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
