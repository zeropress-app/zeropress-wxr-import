import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { convertWxrToPreviewData, validateBase } from '../src/api.js';
import { BASE_TOP_LEVEL_KEYS } from '../src/base.js';
import { parseArgs } from '../src/index.js';
import { OVERRIDE_SHAPE } from '../src/override.js';
import { validateFilePlan } from '../src/file-safety.js';

const xml = `<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel><title>Example site</title><link>https://wordpress.example/</link>
    <language>en-US</language><pubDate>Wed, 28 Oct 2026 00:00:00 +0000</pubDate>
    <wp:wxr_version>1.2</wp:wxr_version><wp:base_blog_url>https://wordpress.example/</wp:base_blog_url>
  </channel></rss>`;
const convert = (base = { version: '0.7' }, override) =>
  convertWxrToPreviewData(new Blob([xml]).stream(), base, { override, generatorVersion: '0.7.8' });

test('filters unknown override properties while applying supported settings', async () => {
  assert.deepEqual(new Set(Object.keys(OVERRIDE_SHAPE.properties)), BASE_TOP_LEVEL_KEYS);
  const result = await convert(undefined, {
    site: { posts_per_page: 8, posts_per_page1: 9, posts_per_page2: 10 },
  });
  assert.equal(result.previewData.site.posts_per_page, 8);
  assert.deepEqual(result.report.warnings.ignored_override_properties, {
    count: 2, affected: ['site.posts_per_page1', 'site.posts_per_page2'],
  });
  assert.equal(Object.hasOwn(result.base.site, 'posts_per_page1'), false);
});

test('merges raw partial settings before defaults and preserves both input objects', async () => {
  const base = {
    version: '0.7', site: { title: 'Base title', media_origin: 'https://media.example', posts_per_page: 12 },
    comments: { api_base_url: '/wp-json/wp/v2', per_page: 40, threading: { max_depth: 4 } },
    newsletter: { enabled: true, signup_url: 'https://newsletter.example/signup', button_label: 'Subscribe' },
    custom_html: { head_end: '<meta name="example" content="ok">' },
  };
  const override = {
    site: { posts_per_page: 8 }, comments: { enabled: false, threading: { enabled: false } },
    newsletter: { button_label: 'Join' }, custom_html: { body_end: '<div>Example</div>' },
    custom_css: { content: '.site-title { letter-spacing: -0.02em; }' },
  };
  const originals = structuredClone({ base, override });
  const result = await convert(base, override);
  assert.equal(result.previewData.site.media_origin, 'https://media.example');
  assert.equal(result.previewData.site.title, 'Base title');
  assert.equal(result.previewData.site.posts_per_page, 8);
  assert.deepEqual(result.base.comments.threading, { enabled: false, max_depth: 4 });
  assert.equal(result.base.comments.per_page, 40);
  assert.equal(result.base.comments.enabled, false);
  assert.equal(result.base.newsletter.signup_url, base.newsletter.signup_url);
  assert.equal(result.base.newsletter.button_label, 'Join');
  assert.deepEqual(result.previewData.custom_html, { ...base.custom_html, ...override.custom_html });
  assert.deepEqual(result.previewData.custom_css, override.custom_css);
  assert.deepEqual({ base, override }, originals);
});

test('empty and entirely unsupported partial settings do not introduce blocks or defaults', async () => {
  const expected = await convert();
  assert.deepEqual(await convert(undefined, {}), expected);
  assert.deepEqual(await convert(undefined, {
    site: { logo: {}, search: {} }, comments: {}, custom_css: {}, custom_html: {}, newsletter: {},
  }), expected);
  const result = await convert(undefined, { comments: { unknown: false }, custom_css: { typo: '' }, unknown: {} });
  assert.deepEqual(result.previewData, expected.previewData);
  assert.deepEqual(result.base, expected.base);
  assert.deepEqual(result.report.warnings.ignored_override_properties.affected, ['comments.unknown', 'custom_css.typo', 'unknown']);
});

test('replaces widget, collection, menu maps and arrays, including explicit clearing', async () => {
  const base = {
    version: '0.7', widgets: { sidebar: { name: 'Old', items: [{ type: 'search', title: '' }] } },
    collections: { old: { items: [] } },
    import: { menu_mapping: { primary: '12' }, media_rewrites: [{ from: 'https://old.example/uploads/', to: 'https://cdn.example/uploads/' }] },
  };
  const override = {
    widgets: { footer: { name: 'New', items: [{ type: 'custom', title: '', settings: { arbitrary: { nested: [1, null, false] } }, typo: true }], typo: true } },
    collections: { recent: { items: [], typo: true } },
    import: { menu_mapping: {}, media_rewrites: [{ from: 'https://source.example/files/', to: 'https://static.example/files/', typo: true }] },
  };
  const result = await convert(base, override);
  assert.deepEqual(Object.keys(result.base.widgets), ['footer']);
  assert.deepEqual(result.base.widgets.footer.items[0].settings, override.widgets.footer.items[0].settings);
  assert.deepEqual(result.base.collections, { recent: { items: [] } });
  assert.deepEqual(result.base.import.menu_mapping, {});
  assert.equal(result.base.import.media_rewrites.length, 1);
  assert.equal(result.base.import.media_rewrites[0].from, 'https://source.example/files/');
  assert.deepEqual(result.report.warnings.ignored_override_properties.affected, [
    'widgets.footer.items[0].typo', 'widgets.footer.typo', 'collections.recent.typo', 'import.media_rewrites[0].typo',
  ]);
  const cleared = await convert(base, { widgets: {}, collections: {}, import: { menu_mapping: {}, media_rewrites: [] } });
  assert.deepEqual(cleared.base.widgets, {});
  assert.deepEqual(cleared.base.collections, {});
  assert.deepEqual(cleared.base.import, { menu_mapping: {}, media_rewrites: [] });
});

test('preserves arbitrary metadata keys and null without mutating prototypes', async () => {
  const base = { version: '0.7', meta: { kept: 'base', changed: 'old' } };
  const override = JSON.parse('{"meta":{"changed":null,"enabled":false,"zero":0,"empty":"","__proto__":"literal","constructor":"literal"},"__proto__":{"polluted":true}}');
  const result = await convert(base, override);
  assert.deepEqual(result.base.meta, { ...base.meta, ...override.meta });
  assert.equal(Object.getPrototypeOf(result.base.meta), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(result.report.warnings.ignored_override_properties.affected, ['__proto__']);
});

test('invalid known values and incomplete replacement entries fail without coercion', async () => {
  for (const override of [
    null, [], false, 'settings', { site: [] }, { site: { posts_per_page: '8' } },
    { site: { posts_per_page: 0 } }, { site: { posts_per_page: {} } },
    { comments: { enabled: 'false' } }, { comments: { enabled: null } },
    { comments: { per_page: 101 } }, { comments: { api_base_url: '//example.test' } },
    { site: { media_delivery_mode: 'media_domain' } },
    { newsletter: { button_label: 'Join' } }, { custom_css: { content: '' } },
    { widgets: { sidebar: {} } }, { widgets: { sidebar: { name: 'Sidebar', items: [{}] } } },
    { collections: { featured: {} } }, { import: { menu_mapping: { primary: 12 } } },
    { import: { media_rewrites: [{ from: 'https://example.test/uploads/', typo: 'missing destination' }] } },
  ]) {
    await assert.rejects(convert(undefined, override), /Invalid (override|merged base\/override) JSON/, JSON.stringify(override));
  }
  await assert.rejects(convert({ version: '0.7', site: { posts_per_page: '8' } }, { site: { posts_per_page: 8 } }), /Invalid base JSON/);
  await assert.rejects(convert({ version: '0.7', site: { typo: true } }, { site: {} }), /unknown site key/);
});

test('metadata hints do not override the base contract', async () => {
  assert.deepEqual(await convert(undefined, { version: '0.7', $schema: 'https://schema.example/unused.json' }), await convert());
  for (const override of [{ version: '0.6' }, { version: 0.7 }, { $schema: {} }]) {
    await assert.rejects(convert(undefined, override), /Invalid override JSON/);
  }
});

test('disabled comments need no API and stay disabled when the resolved base is reused', async () => {
  const disabled = { enabled: false, per_page: 20, threading: { enabled: false } };
  assert.deepEqual(validateBase({ version: '0.7', comments: disabled }).comments, disabled);
  const result = await convert(undefined, { comments: disabled });
  assert.equal(Object.hasOwn(result.previewData.site, 'comments'), false);
  assert.deepEqual(result.base.comments, disabled);
  assert.equal(Object.hasOwn(result.report.inferred, 'comments_api_base_url'), false);
  assert.equal(result.report.warnings.comments_api_base_inference_skipped.count, 0);
  const reused = await convert(result.base);
  assert.deepEqual(reused.base, result.base);
  assert.deepEqual(reused.previewData, result.previewData);
  const withApi = await convert({ version: '0.7', comments: { ...disabled, api_base_url: '/wp-json/wp/v2' } });
  assert.equal(withApi.previewData.site.comments.enabled, false);
  assert.equal(withApi.previewData.site.comments.api_base_url, '/wp-json/wp/v2');
  for (const comments of [{}, { enabled: true }, { enabled: false, api_base_url: '' }]) {
    assert.throws(() => validateBase({ version: '0.7', comments }), /comments.api_base_url/);
  }
});

test('CLI override matches the API and leaves artifacts untouched on failure', async (t) => {
  const root = await fixture(t);
  const base = { version: '0.7', site: { title: 'Base title' } };
  const override = { site: { posts_per_page: 8, posts_per_page1: 'SECRET-VALUE', posts_per_page2: 10 }, comments: { enabled: false } };
  await writeFile(join(root, 'base.json'), JSON.stringify(base));
  await writeFile(join(root, 'override.json'), JSON.stringify(override));
  const args = ['--input', 'input.xml', '--base', 'base.json', '--override', 'override.json', '--output', 'output.json', '--with-report', '--override-generator-version', '0.7.8'];
  const success = cli(root, args);
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stderr, /ignored_override_properties.*2/);
  assert.match(success.stderr, /site.posts_per_page1/);
  assert.doesNotMatch(success.stderr, /SECRET-VALUE/);
  const expected = await convert(base, override);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'output.json'))), expected.previewData);
  assert.deepEqual(JSON.parse(await readFile(join(root, '.zeropress-wxr-import/wxr-import-report.json'))), expected.report);
  assert.deepEqual(JSON.parse(await readFile(join(root, '.zeropress-wxr-import/wxr-import-base.resolved.json'))), expected.base);
  const files = ['input.xml', 'base.json', 'output.json', '.zeropress-wxr-import/wxr-import-report.json', '.zeropress-wxr-import/wxr-import-base.resolved.json'];
  const snapshots = await Promise.all(files.map(file => readFile(join(root, file))));
  for (const invalid of ['{', '[]', 'null', '{"site":{"posts_per_page":"8"}}']) {
    await writeFile(join(root, 'override.json'), invalid);
    assert.notEqual(cli(root, args).status, 0);
    for (const [index, file] of files.entries()) assert.deepEqual(await readFile(join(root, file)), snapshots[index]);
    assert.equal(await readFile(join(root, 'override.json'), 'utf8'), invalid);
  }
  await rm(join(root, 'override.json'));
  assert.notEqual(cli(root, args).status, 0);
  await mkdir(join(root, 'override.json'));
  assert.notEqual(cli(root, args).status, 0);
});

test('override is explicit, needs one option value, and works without a base', async (t) => {
  const required = ['--input', 'input.xml', '--output', 'output.json'];
  assert.throws(() => parseArgs([...required, '--override']), /requires a value/);
  assert.throws(() => parseArgs([...required, '--override', 'a.json', '--override', 'b.json']), /duplicate option/);
  const root = await fixture(t);
  await writeFile(join(root, 'wxr-import-base.override.json'), '{invalid JSON');
  assert.equal(cli(root, required).status, 0);
  await writeFile(join(root, 'override.json'), '{"site":{"posts_per_page":8}}');
  assert.equal(cli(root, [...required, '--override', 'override.json']).status, 0);
  assert.equal(JSON.parse(await readFile(join(root, 'output.json'))).site.posts_per_page, 8);
});

test('override cannot alias an output or report through direct paths or links', async (t) => {
  const root = await fixture(t);
  const override = join(root, 'override.json');
  await writeFile(override, '{}');
  const plan = { input: join(root, 'input.xml'), override, output: override };
  await assert.rejects(validateFilePlan(plan), { code: 'PATH_COLLISION' });
  plan.output = join(root, 'output.json');
  await link(override, plan.output);
  await assert.rejects(validateFilePlan(plan), { code: 'PATH_COLLISION' });
  await rm(plan.output);
  plan.artifactDir = join(root, 'report');
  await mkdir(plan.artifactDir);
  plan.resolvedBaseArtifact = join(plan.artifactDir, 'resolved.json');
  plan.reportArtifact = join(plan.artifactDir, 'report.json');
  for (const reserved of [plan.resolvedBaseArtifact, plan.reportArtifact]) {
    await writeFile(reserved, '{}');
    await rm(override);
    await symlink(reserved, override);
    await assert.rejects(validateFilePlan(plan), { code: 'PATH_COLLISION' });
    await rm(override);
    await link(reserved, override);
    await assert.rejects(validateFilePlan(plan), { code: 'PATH_COLLISION' });
    await rm(reserved);
  }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wxr-override-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'input.xml'), xml);
  return root;
}

function cli(root, args) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('../bin/zeropress-wxr-import.js', import.meta.url)), ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}
