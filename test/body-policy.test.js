import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDiskWorkStore } from '@zeropress/preview-data-validator/node';
import { convertWxrToPreviewData, convertWxrToPreviewDataSource, convertWxrBundleToPreviewDataSource } from '../src/api.js';
import { rewriteMediaUrls } from '../src/media.js';

const wrap = body => `<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Example</title><link>https://example.com/</link><language>en</language><pubDate>Thu, 01 Jan 2026 00:00:00 +0000</pubDate><wp:wxr_version>1.2</wp:wxr_version>${body}</channel></rss>`;
const item = (content, extra = '', id = 1) => `<item><title>Example</title><content:encoded><![CDATA[${content}]]></content:encoded><wp:post_id>${id}</wp:post_id><wp:post_type>post</wp:post_type><wp:post_name>example-${id}</wp:post_name><wp:status>publish</wp:status><wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt><wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt>${extra}</item>`;
const base = { version: '0.7', comments: { enabled: false } };
async function* input(text) { const bytes = Buffer.from(text); for (let n = 0; n < bytes.length; n += 16383) yield bytes.subarray(n, n + 16383); }
function body(bytes) {
  const start = '<!-- wp:html -->', end = '<!-- /wp:html -->', unit = '한😀"\\&';
  const count = Math.floor((bytes - start.length - end.length) / Buffer.byteLength(unit));
  const value = start + unit.repeat(count) + end;
  return value + 'a'.repeat(bytes - Buffer.byteLength(value));
}
for (const bytes of [262143, 262144, 262145, 1048575, 1048576, 1048577]) {
  test(`legacy and streamed conversion enforce UTF-8 boundary ${bytes}`, async t => {
    const store = await createDiskWorkStore(); t.after(() => store.close());
    const content = body(bytes), xml = wrap(item(content));
    const legacy = () => convertWxrToPreviewData(input(xml), base, { maxBodyBytes: 1048576 });
    const chunked = () => convertWxrToPreviewDataSource(input(xml), base, { workStore: store, maxBodyBytes: 1048576 });
    if (bytes > 1048576) {
      await assert.rejects(legacy, { code: 'CONTENT_BODY_TOO_LARGE' });
      await assert.rejects(chunked, { code: 'CONTENT_BODY_TOO_LARGE' });
    } else {
      const a = await legacy(), b = await chunked(); t.after(() => b.source.close());
      assert.equal(a.previewData.content.posts[0].content, content);
      assert.deepEqual(b.report, a.report);
      assert.equal(a.report.warnings.large_content_bodies?.count || 0, bytes >= 262144 ? 1 : 0);
      const values = []; for await (const row of b.source.records('posts')) values.push(row.value);
      assert.deepEqual(values, a.previewData.content.posts);
    }
  });
}
test('oversized excluded items are discarded after late eligibility fields; repeated bodies cannot bypass the cap', async () => {
  const big = 'x'.repeat(2 * 1048576);
  for (const extra of ['<wp:status>draft</wp:status>', '<wp:post_password>example</wp:post_password>', '<wp:post_type>attachment</wp:post_type>', '<wp:post_id>invalid</wp:post_id>', '<wp:post_date_gmt>invalid</wp:post_date_gmt>']) {
    const result = await convertWxrToPreviewData(input(wrap(item(big, extra))), base, { maxBodyBytes: 1048576 });
    assert.equal(result.previewData.content.posts.length, 0);
    assert.equal(result.report.warnings.large_content_bodies, undefined);
  }
  await assert.rejects(() => convertWxrToPreviewData(input(wrap(item(big, '<content:encoded>small</content:encoded>'))), base, { maxBodyBytes: 1048576 }), { code: 'CONTENT_BODY_TOO_LARGE' });
});
test('converted HTML and media expansion are checked, and warnings are bounded', async () => {
  await assert.rejects(() => convertWxrToPreviewData(input(wrap(item('x'.repeat(1048576)))), base, { maxBodyBytes: 1048576 }), { code: 'CONTENT_BODY_TOO_LARGE' });
  assert.throws(() => rewriteMediaUrls('a'.repeat(10000), [{ from: 'a', to: 'b'.repeat(10000) }], 'post:1', { maxBodyBytes: 1048576 }), { code: 'CONTENT_BODY_TOO_LARGE' });
  const result = await convertWxrToPreviewData(input(wrap(Array.from({ length: 23 }, (_, i) => item(body(262144), '', i + 1)).join(''))), base, { maxBodyBytes: 1048576 });
  const warning = result.report.warnings.large_content_bodies;
  assert.equal(warning.count, 23); assert.equal(warning.affected.length, 20); assert.equal(warning.omitted_examples, 3);
});
test('media expansion preserves the complete body when no maximum is specified', () => {
  const replacement = '한😀'.repeat(Math.ceil(1048577 / 7));
  assert.ok(Buffer.byteLength(replacement) > 1048576);
  const rules = [{ from: 'a', to: replacement }];
  assert.equal(rewriteMediaUrls('a', rules, 'post:1'), replacement);
  for (const policy of [{}, { maxBodyBytes: undefined }, { maxBodyBytes: null }]) {
    assert.equal(rewriteMediaUrls('a', rules, 'post:1', policy), replacement);
  }
});
test('CLI refusal preserves input, previous output and reports', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wxr-body-policy-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const xml = wrap(item(body(1048577)));
  await fs.writeFile(path.join(dir, 'input.xml'), xml);
  await fs.writeFile(path.join(dir, 'previous.json'), 'previous');
  await fs.writeFile(path.join(dir, 'wxr-import-report.json'), 'previous report');
  const result = spawnSync(process.execPath, [new URL('../bin/zeropress-wxr-import.js', import.meta.url).pathname, '--input', 'input.xml', '--output', 'previous.json', '--with-report', '--max-body-bytes', '1048576'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /CONTENT_BODY_TOO_LARGE/);
  assert.equal(await fs.readFile(path.join(dir, 'previous.json'), 'utf8'), 'previous');
  assert.equal(await fs.readFile(path.join(dir, 'wxr-import-report.json'), 'utf8'), 'previous report');
  assert.equal(await fs.readFile(path.join(dir, 'input.xml'), 'utf8'), xml);
});

for (const bytes of [1048577, 4194303, 4194304, 4194305]) {
  test(`default and null policies preserve the complete ${bytes}-byte body`, async t => {
    const content = body(bytes), xml = wrap(item(content));
    const a = await convertWxrToPreviewData(input(xml), base);
    const store = await createDiskWorkStore(); t.after(() => store.close());
    const b = await convertWxrToPreviewDataSource(input(xml), base, { maxBodyBytes: null, workStore: store });
    t.after(() => b.source.close());
    assert.equal(a.previewData.content.posts[0].content, content);
    assert.equal(a.report.warnings.large_content_bodies.max_body_bytes, bytes);
    assert.deepEqual(b.report, a.report);
    for await (const row of b.source.records('posts')) assert.equal(row.value.content, content);
    if (bytes > 4194304) await assert.rejects(() => convertWxrToPreviewData(input(xml), base, { maxBodyBytes: 4194304 }), { code: 'CONTENT_BODY_TOO_LARGE' });
    else assert.equal((await convertWxrToPreviewData(input(xml), base, { maxBodyBytes: 4194304 })).previewData.content.posts[0].content, content);
  });
}
test('small explicit maxima cannot be bypassed by trimming, late eligibility or duplicate bodies', async () => {
  for (const content of ['x'.repeat(33), ' '.repeat(32) + 'x']) {
    const xml = wrap(item(content, '<content:encoded>x</content:encoded>'));
    await assert.rejects(() => convertWxrToPreviewData(input(xml), base, { maxBodyBytes: 32 }), { code: 'CONTENT_BODY_TOO_LARGE' });
    const skipped = await convertWxrToPreviewData(input(wrap(item(content, '<wp:status>draft</wp:status>'))), base, { maxBodyBytes: 1 });
    assert.equal(skipped.previewData.content.posts.length, 0);
  }
  await assert.rejects(() => convertWxrToPreviewData(input(wrap(item('x'))), base, { maxBodyBytes: 1 }), { code: 'CONTENT_BODY_TOO_LARGE' }); // Classic HTML materialization adds markup.
  assert.throws(() => rewriteMediaUrls('a', [{ from: 'a', to: 'xx' }], 1, { maxBodyBytes: 1 }), { code: 'CONTENT_BODY_TOO_LARGE' });
  assert.equal(rewriteMediaUrls('a', [{ from: 'a', to: 'x'.repeat(1048577) }], 1, { maxBodyBytes: null }).length, 1048577);
});
test('invalid API maxima fail before reading a source or opening a bundle', async () => {
  const source = { async *[Symbol.asyncIterator]() { assert.fail('source consumed'); } };
  const store = { put() { assert.fail('store written'); }, get() { assert.fail('store read'); } };
  for (const maxBodyBytes of [0, -1, 1.5, NaN, Infinity, true, '1', Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(() => convertWxrToPreviewData(source, base, { maxBodyBytes }), TypeError);
    await assert.rejects(() => convertWxrToPreviewDataSource(source, base, { maxBodyBytes, workStore: store }), TypeError);
    await assert.rejects(() => convertWxrBundleToPreviewDataSource({ get manifest() { assert.fail('bundle opened'); } }, { maxBodyBytes, workStore: store }), TypeError);
  }
});
test('CLI body maximum accepts decimal bytes and rejects ambiguous options before input I/O', async () => {
  const { parseArgs } = await import('../src/index.js');
  const args = ['--input', 'example.xml', '--output', 'example.json'];
  assert.equal(parseArgs(args).maxBodyBytes, null);
  assert.equal(parseArgs([...args, '--max-body-bytes', '1']).maxBodyBytes, 1);
  for (const value of ['0', '-1', '+1', '1.0', '1e3', '4MiB', 'Infinity', '9007199254740991']) {
    assert.throws(() => parseArgs([...args, '--max-body-bytes', value]));
  }
  assert.throws(() => parseArgs([...args, '--max-body-bytes']));
  assert.throws(() => parseArgs([...args, '--max-body-bytes', '1', '--max-body-bytes', '2']), /duplicate/);
});
