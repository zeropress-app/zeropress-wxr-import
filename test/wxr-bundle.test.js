import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createDiskWorkStore, openPreviewDataSource } from '@zeropress/preview-data-validator/node';
import { convertWxrBundleToPreviewDataSource, convertWxrToPreviewData } from '../src/api.js';
import { openLocalWxrBundle } from '../src/wxr-bundle-node.js';

const prefix = '<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>';
const header = '<title>Example</title><link>https://example.com/</link><language>en</language><wp:wxr_version>1.2</wp:wxr_version>';
const suffix = '</channel></rss>';
const date = '<pubDate>Thu, 01 Jan 2026 00:00:00 +0000</pubDate>';
const author = '<wp:author><wp:author_id>1</wp:author_id><wp:author_login>writer</wp:author_login><wp:author_display_name>Writer</wp:author_display_name></wp:author>';
const item = (id, type, extra = '') => `<item><title>Item ${id}</title><link>https://example.com/${id}/</link><dc:creator>writer</dc:creator><content:encoded><![CDATA[<p>한글 😀 &amp; quoted "text"</p>]]></content:encoded><wp:post_id>${id}</wp:post_id><wp:post_type>${type}</wp:post_type><wp:post_name>item-${id}</wp:post_name><wp:status>publish</wp:status><wp:post_date>2026-01-01 00:00:00</wp:post_date><wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt><wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt>${extra}</item>`;
const records = [author, item(1, 'post', '<wp:postmeta><wp:meta_key>_thumbnail_id</wp:meta_key><wp:meta_value>3</wp:meta_value></wp:postmeta>'), item(2, 'page'), item(3, 'attachment', '<wp:attachment_url>https://example.com/uploads/image.jpg</wp:attachment_url>')];
async function* bytes(value) { yield Buffer.from(value); }
const sha = (value) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const base = { version: '0.7', comments: { enabled: false } };
  const files = { 'wxr-import-base.json': Buffer.from(JSON.stringify(base)) };
  const manifest = { format: 'zeropress-wxr-bundle', format_version: 1, wxr_version: '1.2', generated_at: '2026-01-01T00:00:00Z', data_hash: 'a'.repeat(64), base: { path: 'wxr-import-base.json', bytes: files['wxr-import-base.json'].length, sha256: sha(files['wxr-import-base.json']) }, parts: [] };
  for (const [i, record] of records.entries()) {
    const xml = Buffer.from(prefix + header + record + suffix); const hash = sha(xml);
    const name = `wordpress-export.parts/p-${hash}.xml`; files[name] = xml;
    manifest.parts.push({ path: name, bytes: xml.length, sha256: hash, records: { authors: i === 0 ? 1 : 0, categories: 0, tags: 0, terms: 0, items: i === 0 ? 0 : 1 } });
  }
  return { manifest, files, base, openFile: (name) => bytes(files[name]) };
}
async function materialize(source) {
  const data = { ...source.header, content: {} };
  for (const name of source.collections) { data.content[name] = []; for await (const { value } of source.records(name)) data.content[name].push(value); }
  return data;
}
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wxr-bundle-test-'));
  const store = await createDiskWorkStore();
  t.after(async () => { await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const data = fixture();
  for (const [name, content] of Object.entries(data.files)) { await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await fs.writeFile(path.join(dir, name), content); }
  await fs.writeFile(path.join(dir, 'wordpress-export.manifest.json'), JSON.stringify(data.manifest));
  return { dir, store, data };
}
test('bundle uses one global conversion, preserves forward media references, reports and overrides', async t => {
  const { data, store } = await setup(t);
  const options = { override: { site: { posts_per_page: 8 } } };
  const expected = await convertWxrToPreviewData(bytes(prefix + date + header + records.join('') + suffix), data.base, options);
  const result = await convertWxrBundleToPreviewDataSource(data, { ...options, workStore: store });
  t.after(() => result.source.close());
  assert.deepEqual(await materialize(result.source), expected.previewData);
  assert.deepEqual(result.report, expected.report); assert.deepEqual(result.base, expected.base);
});
test('invalid inventory, checksum, counts, channel and duplicate identities fail', async t => {
  const { store } = await setup(t);
  for (const mutate of [
    d => { d.manifest.parts[0].path = '../other.xml'; },
    d => { d.manifest.parts.push(d.manifest.parts[0]); },
    d => { d.manifest.parts[0].records.authors = 2; },
    d => { d.manifest.format_version = 2; },
    d => { d.files[d.manifest.parts[1].path] = Buffer.from('broken'); },
    d => { d.manifest.extra = true; },
    d => { d.manifest.generated_at = '2026-02-31T00:00:00Z'; },
  ]) {
    const data = fixture(); mutate(data);
    await assert.rejects(() => convertWxrBundleToPreviewDataSource(data, { workStore: store }), /Invalid WXR bundle/);
  }
});
test('CLI supports bundle chunks and JSON; failures preserve old output and protect parts', async t => {
  const { dir, data } = await setup(t);
  const bin = new URL('../bin/zeropress-wxr-import.js', import.meta.url).pathname;
  const run = (args = []) => spawnSync(process.execPath, [bin, '--input-format', 'bundle', '--input', 'wordpress-export.manifest.json', '--output', 'out.json', ...args], { cwd: dir, encoding: 'utf8' });
  const expected = await convertWxrToPreviewData(bytes(prefix + date + header + records.join('') + suffix), data.base);
  const normal = run(); assert.equal(normal.status, 0, normal.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'out.json'))), expected.previewData);
  const chunk = run(['--output-format', 'chunks', '--with-report']); assert.equal(chunk.status, 0, chunk.stderr);
  const source = await openPreviewDataSource(path.join(dir, 'out.json'));
  assert.deepEqual(await materialize(source), expected.previewData); await source.close();
  const before = await fs.readFile(path.join(dir, 'out.json'));
  await fs.writeFile(path.join(dir, data.manifest.parts[0].path), 'corrupt');
  assert.notEqual(run().status, 0); assert.deepEqual(await fs.readFile(path.join(dir, 'out.json')), before);
  await fs.writeFile(path.join(dir, data.manifest.parts[0].path), data.files[data.manifest.parts[0].path]);
  await fs.unlink(path.join(dir, 'out.json')); await fs.link(path.join(dir, data.manifest.parts[0].path), path.join(dir, 'out.json'));
  assert.match(run().stderr, /collision/);
});
test('snapshot detects later source changes and rejects symlink parts directory', async t => {
  const { dir, data } = await setup(t);
  const plan = { input: path.join(dir, 'wordpress-export.manifest.json'), output: path.join(dir, 'out.json') };
  const bundle = await openLocalWxrBundle(plan);
  try {
    await fs.writeFile(path.join(dir, data.manifest.parts[1].path), 'changed');
    await assert.rejects(() => bundle.assertCurrent(), /source changed/);
  } finally { await bundle.close(); }
  await fs.rename(path.join(dir, 'wordpress-export.parts'), path.join(dir, 'other-parts'));
  await fs.symlink(path.join(dir, 'other-parts'), path.join(dir, 'wordpress-export.parts'));
  await assert.rejects(() => openLocalWxrBundle(plan), /regular directory/);
});

function replacePart(data, index, content, counts = data.manifest.parts[index].records) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const hash = sha(bytes), name = `wordpress-export.parts/p-${hash}.xml`;
  data.files[name] = bytes;
  data.manifest.parts[index] = { path: name, bytes: bytes.length, sha256: hash, records: counts };
}
test('verified bytes still reject inconsistent headers, duplicate IDs, unsafe XML and invalid UTF-8', async t => {
  const { store } = await setup(t);
  const cases = [
    [d => replacePart(d, 1, prefix + header.replace('Example', 'Other') + records[1] + suffix), /inconsistent channel/],
    [d => replacePart(d, 2, prefix + header + records[2].replace('<wp:post_id>2', '<wp:post_id>1') + suffix), /duplicate record identity/],
    [d => replacePart(d, 1, prefix + date + header + records[1] + suffix), /generation time/],
    [d => replacePart(d, 1, '<!DOCTYPE rss [<!ENTITY bad SYSTEM "https://example.com/private">]>' + prefix + header + records[1] + suffix), /DOCTYPE/],
    [d => replacePart(d, 1, Buffer.from([0xff, 0xfe, 0x00])), /UTF-8/],
    [d => { d.manifest.base.sha256 = [d.manifest.base.sha256]; }, /Invalid WXR bundle/],
  ];
  for (const [mutate, expected] of cases) {
    const data = fixture(); mutate(data);
    await assert.rejects(() => convertWxrBundleToPreviewDataSource(data, { workStore: store }), expected);
  }
});
test('empty bundle preserves empty-site semantics and limits reject before opening content', async t => {
  const { store } = await setup(t);
  const data = fixture();
  data.manifest.parts = data.manifest.parts.slice(0, 1);
  replacePart(data, 0, prefix + header + suffix, { authors: 0, categories: 0, tags: 0, terms: 0, items: 0 });
  const expected = await convertWxrToPreviewData(bytes(prefix + date + header + suffix), data.base);
  const result = await convertWxrBundleToPreviewDataSource(data, { workStore: store });
  t.after(() => result.source.close());
  assert.deepEqual(await materialize(result.source), expected.previewData);
  for (const mutate of [d => { d.manifest.base.bytes = 8 * 1024 * 1024 + 1; }, d => { d.manifest.parts = Array(257).fill(d.manifest.parts[0]); }]) {
    const invalid = fixture(); mutate(invalid);
    invalid.openFile = () => { assert.fail('Invalid inventory must fail before reading bytes'); };
    await assert.rejects(() => convertWxrBundleToPreviewDataSource(invalid, { workStore: store }), /Invalid WXR bundle/);
  }
});
test('bundle snapshot protects output/report aliases, strict base identity and manifest bounds', async t => {
  const { dir, data } = await setup(t);
  const plan = { input: path.join(dir, 'wordpress-export.manifest.json'), output: path.join(dir, 'out.json') };
  await fs.link(path.join(dir, data.manifest.parts[1].path), path.join(dir, 'report.json'));
  await assert.rejects(() => openLocalWxrBundle({ ...plan, artifactDir: dir, resolvedBaseArtifact: path.join(dir, 'resolved-base.json'), reportArtifact: path.join(dir, 'report.json') }), /collision/);
  await assert.rejects(() => openLocalWxrBundle({ ...plan, base: path.join(dir, 'other-base.json') }), /bound wxr-import-base/);
  await fs.writeFile(plan.input, ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(() => openLocalWxrBundle(plan), /type or size/);
});
