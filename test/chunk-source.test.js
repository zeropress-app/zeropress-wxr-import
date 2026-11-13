import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { convertWxrToPreviewData, convertWxrToPreviewDataSource } from '../src/api.js';
import { createDiskWorkStore, openPreviewDataSource } from '@zeropress/preview-data-validator/node';
import { parseXml } from '../src/xml.js';

// Synthetic records deliberately put parents, authors, and featured media after users.
const item = (id, type, extra = '') => `<item><title>Record ${id}</title><link>https://example.com/${id}/</link><dc:creator>writer</dc:creator><content:encoded><![CDATA[<p>한글 😀 content ${id}</p>]]></content:encoded><wp:post_id>${id}</wp:post_id><wp:post_type>${type}</wp:post_type><wp:post_name>record-${id}</wp:post_name><wp:status>publish</wp:status><wp:post_date>2026-01-01 09:00:00</wp:post_date><wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt><wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt>${extra}</item>`;
const xml = `<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Example</title><link>https://example.com/</link><language>en</language><pubDate>Thu, 01 Jan 2026 00:00:00 +0000</pubDate><wp:wxr_version>1.2</wp:wxr_version>${item(2, 'page', '<wp:post_parent>3</wp:post_parent>')}${item(1, 'post', '<category domain="category" nicename="news">News</category><wp:postmeta><wp:meta_key>_thumbnail_id</wp:meta_key><wp:meta_value>4</wp:meta_value></wp:postmeta>')}${item(3, 'page')}${item(4, 'attachment', '<wp:attachment_url>https://example.com/wp-content/uploads/picture.jpg</wp:attachment_url>')}<wp:author><wp:author_id>1</wp:author_id><wp:author_login>writer</wp:author_login><wp:author_display_name>Writer</wp:author_display_name></wp:author></channel></rss>`;
async function* bytes(text) { const buffer = Buffer.from(text); for (let i = 0; i < buffer.length; i += 71) yield buffer.subarray(i, i + 71); }
async function materialize(source) {
  const data = { ...source.header, content: {} };
  for (const name of source.collections) { data.content[name] = []; for await (const entry of source.records(name)) data.content[name].push(entry.value); }
  return data;
}
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wxr-chunks-'));
  const store = await createDiskWorkStore({ directory: dir });
  t.after(async () => { await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, store };
}
for (const base of [{ version: '0.7' }, { version: '0.7', comments: { enabled: false }, site: { timezone: 'UTC', permalinks: { posts: '/:public_id/' } } }]) {
  test('disk-backed source preserves inference, forward references, reports and replay', async t => {
    const { store } = await setup(t);
    const options = { override: { site: { posts_per_page: 8, unknown: 1 }, custom_css: { content: 'body { color: red; }' } } };
    const expected = await convertWxrToPreviewData(bytes(xml), base, options);
    const actual = await convertWxrToPreviewDataSource(bytes(xml), base, { ...options, workStore: store });
    assert.deepEqual(await materialize(actual.source), expected.previewData);
    assert.deepEqual(await materialize(actual.source), expected.previewData);
    assert.deepEqual(actual.base, expected.base);
    assert.deepEqual(actual.report, expected.report);
    assert.ok(store.stats.records > 0);
    await actual.source.close();
    await assert.rejects(() => materialize(actual.source), /closed/);
  });
}

for (const reference of [0, '', false, null, undefined, NaN, 0n]) {
  const label = typeof reference === 'bigint' ? `${reference}n` : String(reference);
  test(`source preserves bodies, excerpts and replay with an opaque ${typeof reference} reference (${label})`, async t => {
    const fixture = xml
      .replace('xmlns:content=', 'xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content=')
      .replaceAll('</content:encoded>', '</content:encoded><excerpt:encoded><![CDATA[Explicit excerpt 한글 😀]]></excerpt:encoded>');
    const records = new Map();
    const store = {
      async put(value) {
        // Exercise a falsy body reference alongside opaque references for other records.
        const key = !Object.hasOwn(value, 'wp') && !records.has(reference) ? reference : {};
        records.set(key, structuredClone(value));
        return key;
      },
      async get(key) {
        assert.ok(records.has(key), 'the converter must use the original reference');
        return structuredClone(records.get(key));
      },
      async close() { records.clear(); },
    };
    t.after(() => store.close());
    const expected = await convertWxrToPreviewData(bytes(fixture));
    const actual = await convertWxrToPreviewDataSource(bytes(fixture), undefined, { workStore: store });
    t.after(() => actual.source.close());
    assert.ok(records.has(reference), 'the store must exercise the falsy reference');
    assert.ok(expected.previewData.content.posts[0].content.length > 0);
    assert.ok(expected.previewData.content.posts[0].excerpt.length > 0);
    assert.deepEqual(await materialize(actual.source), expected.previewData);
    assert.deepEqual(await materialize(actual.source), expected.previewData);
    assert.deepEqual(actual.base, expected.base);
    assert.deepEqual(actual.report, expected.report);
  });
}

test('XML item sink applies backpressure and stops oversized retained values', async () => {
  let pending = 0, maximum = 0, count = 0;
  await parseXml(bytes(xml), { async onItem(item) {
    pending++; maximum = Math.max(maximum, pending);
    await new Promise(resolve => setTimeout(resolve, 1));
    pending--; count++;
    return { wp: item.wp };
  } });
  assert.equal(maximum, 1); assert.equal(count, 4);
  await assert.rejects(() => parseXml(bytes(xml), { maxRetainedTextBytes: 10 }), /limit/);
});

test('CLI chunk mode commits manifest last, preserves old output on malformed XML and rejects path aliases', async t => {
  const { dir } = await setup(t);
  await fs.writeFile(path.join(dir, 'input.xml'), xml);
  const bin = new URL('../bin/zeropress-wxr-import.js', import.meta.url);
  const run = extra => spawnSync(process.execPath, [bin.pathname, '--input', 'input.xml', '--output', 'input.manifest.json', '--output-format', 'chunks', ...extra], { cwd: dir, encoding: 'utf8' });
  const good = run(['--with-report']); assert.equal(good.status, 0, good.stderr);
  const source = await openPreviewDataSource(path.join(dir, 'input.manifest.json'));
  const expected = await convertWxrToPreviewData(bytes(xml));
  assert.deepEqual(await materialize(source), expected.previewData);
  await source.close();
  const before = await fs.readFile(path.join(dir, 'input.manifest.json'));
  await fs.writeFile(path.join(dir, 'input.xml'), '<rss>');
  assert.notEqual(run([]).status, 0);
  assert.deepEqual(await fs.readFile(path.join(dir, 'input.manifest.json')), before);
  await fs.writeFile(path.join(dir, 'input.xml'), xml);
  await fs.writeFile(path.join(dir, 'input.parts', 'settings.json'), '{}');
  assert.match(run(['--override', 'input.parts/settings.json']).stderr, /collision/);
  assert.notEqual(run(['--output-format', 'json']).status, 0);
});
