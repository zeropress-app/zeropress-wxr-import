import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/index.js';

const BIN_PATH = fileURLToPath(new URL('../bin/zeropress-wxr-import.js', import.meta.url));

test('parseArgs accepts an omitted base, validates output files, and reserves every helper path', () => {
  assert.throws(() => parseArgs(['--input', 'a.xml']), /--output <file> is required/);
  assert.throws(
    () => parseArgs([
      '--input', 'a.xml',
      '--base', 'base.json',
      '--output', 'dist',
    ]),
    /--output must be a file with a \.json extension/,
  );
  assert.throws(
    () => parseArgs([
      '--input', 'a.xml',
      '--base', 'base.json',
      '--output', 'preview-data.JSON',
    ]),
    /--output must be a file with a \.json extension/,
  );

  const withoutBase = parseArgs([
    '--input', 'a.xml',
    '--output', 'preview-data.json',
  ]);
  assert.equal(withoutBase.base, null);
  assert.equal(withoutBase.writeReport, true);

  const args = parseArgs([
    '--input', 'a.xml',
    '--base', 'base.json',
    '--output', 'preview-data.json',
    '--no-report',
  ]);
  assert.equal(args.writeReport, false);
  assert.equal(args.base, path.resolve(process.cwd(), 'base.json'));
  assert.equal(
    args.resolvedBaseArtifact,
    path.join(args.artifactDir, 'wxr-import-base.resolved.json'),
  );
  assert.equal(args.reportArtifact, path.join(args.artifactDir, 'wxr-import-report.json'));
  assert.equal(Object.hasOwn(args, 'schemaArtifact'), false);
});

test('CLI shows help and exits successfully when no arguments are provided', async () => {
  const noArguments = await executeCli([]);
  assert.equal(noArguments.code, 0);
  assert.match(
    noArguments.stdout,
    /--input <file> --output <file\.json> \[--base <file>\]/,
  );
  assert.doesNotMatch(noArguments.stdout, /<(?:path)>/);
  assert.equal(noArguments.stderr, '');

  const help = await executeCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  assert.equal(help.stderr, '');

  const version = await executeCli(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\s*$/);
  assert.equal(version.stderr, '');

  const mixedHelp = await executeCli(['--help', '--version']);
  assert.equal(mixedHelp.code, 0);
  assert.match(mixedHelp.stdout, /Usage:/);
  assert.equal(mixedHelp.stderr, '');

  const mixedVersion = await executeCli(['--input', 'ignored.xml', '--version']);
  assert.equal(mixedVersion.code, 0);
  assert.match(mixedVersion.stdout, /^\d+\.\d+\.\d+\s*$/);
  assert.equal(mixedVersion.stderr, '');
});

test('CLI flushes complete stderr output before exiting on errors', async () => {
  const marker = `${'x'.repeat(100_000)}-tail-marker`;
  const result = await executeCli([`--${marker}`]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /tail-marker/);
  assert.equal(result.stderr.endsWith('\n'), true);

  const unsafe = await executeCli([`--unsafe\u001b\u202E`]);
  assert.equal(unsafe.code, 1);
  assert.equal(unsafe.stderr.includes('\u001b'), false);
  assert.equal(unsafe.stderr.includes('\u202E'), false);
  assert.match(unsafe.stderr, /\\u001B/);
  assert.match(unsafe.stderr, /\\u202E/);
});

test('CLI rejects illegal menu URLs without writing output or helper artifacts', async (t) => {
  const cases = [
    ['/../secret', /path traversal segments/],
    ['/foo\\bar', /backslashes are not allowed/],
    ['/foo%ZZ', /malformed percent encoding is not allowed/],
    ['https://user:password@external.example/private', /URL credentials are not allowed/],
  ];

  for (const [url, reason] of cases) {
    const fixture = await makeFixture(t, unsafeMenuWxr(url));
    const result = await executeCli(defaultArgs(), { cwd: fixture.root });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^\[zeropress-wxr-import\] Invalid WXR menu URL:/);
    assert.match(result.stderr, /menu "Main Menu"/);
    assert.match(result.stderr, /item ID "201"/);
    assert.match(result.stderr, /title "Bad Link"/);
    assert.match(result.stderr, reason);
    assert.equal(result.stderr.includes(`URL ${JSON.stringify(url)}`), true);

    for (const artifact of [
      fixture.output,
      fixture.resolvedBaseArtifact,
      fixture.reportArtifact,
    ]) {
      await assert.rejects(
        () => fs.access(artifact),
        (error) => error?.code === 'ENOENT',
      );
    }
  }
});

test('CLI removes malformed UTF-8 bytes without replacing a valid encoded U+FFFD', async (t) => {
  const [beforeTitle, afterTitle] = minimalWxr().split('Minimal Site');
  const input = Buffer.concat([
    Buffer.from(`${beforeTitle}Before`, 'utf8'),
    Buffer.from([0xc3, 0x28, 0x01]),
    Buffer.from('�After', 'utf8'),
    Buffer.from(afterTitle, 'utf8'),
  ]);
  const fixture = await makeFixture(t, input);

  const result = await executeCli(defaultArgs(), { cwd: fixture.root });
  assert.equal(result.code, 0, result.stderr);

  const previewData = JSON.parse(await fs.readFile(fixture.output, 'utf8'));
  assert.equal(previewData.site.title, 'Before(�After');
});

test('CLI streams WXR and atomically writes resolved base, report, then output', async (t) => {
  const fixture = await makeFixture(t);
  await fs.writeFile(fixture.output, '{"sentinel":true}\n');

  const result = await executeCli(defaultArgs(), { cwd: fixture.root });
  assert.equal(result.code, 0, result.stderr);

  const previewData = JSON.parse(await fs.readFile(fixture.output, 'utf8'));
  const report = JSON.parse(await fs.readFile(fixture.reportArtifact, 'utf8'));
  const resolvedBase = JSON.parse(await fs.readFile(fixture.resolvedBaseArtifact, 'utf8'));

  assert.equal(previewData.content.posts.length, 1);
  assert.equal(previewData.generated_at, '2026-07-15T09:00:00Z');
  assert.equal(report.counts.posts, 1);
  assert.equal(
    resolvedBase.$schema,
    'https://schemas.zeropress.dev/wxr-import-base/v0.7/schema.json',
  );
  assert.equal(resolvedBase.version, '0.7');
  assert.equal(Object.hasOwn(previewData.site, 'datetime_display'), false);
  assert.equal(Object.hasOwn(resolvedBase.site, 'datetime_display'), false);
  assert.deepEqual(previewData.widgets, defaultWidgets());
  assert.deepEqual(resolvedBase.widgets, defaultWidgets());
  assert.deepEqual(previewData.site.comments, {
    enabled: true,
    provider: 'wordpress',
    api_base_url: 'https://example.com/wp-json/wp/v2',
    per_page: 50,
    order: 'desc',
    threading: { enabled: true, max_depth: 2 },
  });
  assert.deepEqual(resolvedBase.comments, previewData.site.comments);
  assert.equal(report.inferred.comments_api_base_url, 'https://example.com/wp-json/wp/v2');
  assert.equal(Object.values(report.warnings).every(({ count }) => count === 0), true);
  assert.doesNotMatch(result.stderr, /^WARN /m);
  assert.doesNotMatch(result.stdout, /\nSchema:/);
  assert.match(result.stdout, new RegExp(`Report: ${escapeRegExp(fixture.reportArtifact)}`));
  assert.match(
    result.stdout,
    new RegExp(`Resolved base: ${escapeRegExp(fixture.resolvedBaseArtifact)}`),
  );
  await assertNoTemporaryFiles(fixture.root, fixture.artifactDir);
});

test('CLI uses an empty base when --base is omitted even if a resolved helper exists', async (t) => {
  const fixture = await makeFixture(t);
  await fs.mkdir(fixture.artifactDir);
  await fs.writeFile(
    fixture.resolvedBaseArtifact,
    `${JSON.stringify({ site: {}, widgets: {} }, null, 2)}\n`,
    'utf8',
  );

  const result = await executeCli([
    '--input', 'input.xml',
    '--output', 'preview-data.json',
  ], { cwd: fixture.root });
  assert.equal(result.code, 0, result.stderr);

  const previewData = JSON.parse(await fs.readFile(fixture.output, 'utf8'));
  const resolvedBase = JSON.parse(await fs.readFile(fixture.resolvedBaseArtifact, 'utf8'));
  assert.equal(resolvedBase.version, '0.7');
  assert.deepEqual(previewData.widgets, defaultWidgets());
  assert.deepEqual(resolvedBase.widgets, defaultWidgets());

  const firstOutput = await fs.readFile(fixture.output);
  const second = await executeCli([
    '--input', 'input.xml',
    '--output', 'preview-data-second.json',
  ], { cwd: fixture.root });
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(
    await fs.readFile(path.join(fixture.root, 'preview-data-second.json')),
    firstOutput,
  );
});

test('CLI keeps the report path reserved under --no-report', async (t) => {
  const fixture = await makeFixture(t);
  const result = await executeCli([
    '--input', 'input.xml',
    '--base', 'wxr-import-base.json',
    '--output', '.zeropress-wxr-import/wxr-import-report.json',
    '--no-report',
  ], { cwd: fixture.root });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /reportArtifact conflicts with output/);
  await assert.rejects(fs.stat(fixture.artifactDir), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await fs.readFile(fixture.base, 'utf8')), minimalBase());
});

test('CLI omits report output but still writes the resolved base helper', async (t) => {
  const fixture = await makeFixture(t);
  const result = await executeCli([...defaultArgs(), '--no-report'], { cwd: fixture.root });

  assert.equal(result.code, 0, result.stderr);
  await fs.stat(fixture.output);
  await fs.stat(fixture.resolvedBaseArtifact);
  await assert.rejects(fs.stat(fixture.reportArtifact), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(fixture.artifactDir), ['wxr-import-base.resolved.json']);
  assert.doesNotMatch(result.stdout, /\nReport:/);
});

test('CLI rejects the generated resolved artifact as base without overwriting it', async (t) => {
  const fixture = await makeFixture(t);
  const first = await executeCli(defaultArgs(), { cwd: fixture.root });
  assert.equal(first.code, 0, first.stderr);
  const firstBase = await fs.readFile(fixture.resolvedBaseArtifact);

  const second = await executeCli([
    '--input', 'input.xml',
    '--base', '.zeropress-wxr-import/wxr-import-base.resolved.json',
    '--output', 'preview-data-second.json',
  ], { cwd: fixture.root });
  assert.equal(second.code, 1);
  assert.match(second.stderr, /base conflicts with resolvedBaseArtifact/);
  assert.deepEqual(await fs.readFile(fixture.resolvedBaseArtifact), firstBase);
  await assert.rejects(
    fs.stat(path.join(fixture.root, 'preview-data-second.json')),
    { code: 'ENOENT' },
  );
});

test('CLI reuses a generated resolved base only after copying it to a separate base file', async (t) => {
  const fixture = await makeFixture(t);
  const first = await executeCli(defaultArgs(), { cwd: fixture.root });
  assert.equal(first.code, 0, first.stderr);
  const firstBase = JSON.parse(await fs.readFile(fixture.resolvedBaseArtifact, 'utf8'));
  assert.deepEqual(firstBase.widgets, defaultWidgets());
  await fs.copyFile(fixture.resolvedBaseArtifact, fixture.base);
  const copiedBase = await fs.readFile(fixture.base);

  const secondOutputPath = path.join(fixture.root, 'preview-data-second.json');
  const second = await executeCli([
    '--input', 'input.xml',
    '--base', 'wxr-import-base.json',
    '--output', 'preview-data-second.json',
  ], { cwd: fixture.root });
  assert.equal(second.code, 0, second.stderr);

  const secondOutput = JSON.parse(await fs.readFile(secondOutputPath, 'utf8'));
  const secondBase = JSON.parse(await fs.readFile(fixture.resolvedBaseArtifact, 'utf8'));
  assert.deepEqual(await fs.readFile(fixture.base), copiedBase);
  assert.equal(secondOutput.content.posts.length, 1);
  assert.deepEqual(secondOutput.widgets, defaultWidgets());
  assert.deepEqual(secondBase.widgets, defaultWidgets());
  assert.deepEqual(secondOutput.site.comments, firstBase.comments);
  assert.deepEqual(secondBase.comments, firstBase.comments);
});

test('CLI preserves an explicit empty widgets object as a resolved opt-out', async (t) => {
  const fixture = await makeFixture(t);
  const base = minimalBase();
  base.widgets = {};
  await fs.writeFile(fixture.base, `${JSON.stringify(base, null, 2)}\n`, 'utf8');

  const result = await executeCli(defaultArgs(), { cwd: fixture.root });
  assert.equal(result.code, 0, result.stderr);

  const previewData = JSON.parse(await fs.readFile(fixture.output, 'utf8'));
  const resolvedBase = JSON.parse(await fs.readFile(fixture.resolvedBaseArtifact, 'utf8'));
  assert.deepEqual(previewData.widgets, {});
  assert.deepEqual(resolvedBase.widgets, {});
  assert.doesNotMatch(result.stderr, /^WARN /m);
});

test('CLI persists inferred media settings and reuses them for an idempotent destination rewrite', async (t) => {
  const fixture = await makeFixture(t, mediaWxr());
  const source = 'https://blog.example/wp-content/uploads/';
  const destination = 'https://media.example/imported/';

  const first = await executeCli(defaultArgs(), { cwd: fixture.root });
  assert.equal(first.code, 0, first.stderr);
  const firstOutput = JSON.parse(await fs.readFile(fixture.output, 'utf8'));
  const firstBase = JSON.parse(await fs.readFile(fixture.resolvedBaseArtifact, 'utf8'));
  assert.deepEqual(firstBase.import, { media_from: source, media_to: source });
  assert.equal(firstBase.site.media_origin, '');
  assert.equal(firstOutput.site.media_origin, 'https://blog.example');
  assert.equal(firstOutput.content.posts[0].featured_image, '/wp-content/uploads/hero.jpg');
  assert.deepEqual(firstOutput.content.media, [{
    src: '/wp-content/uploads/hero.jpg',
    width: 1200,
    height: 800,
    alt: 'Hero image',
  }]);

  firstBase.import.media_to = destination;
  await fs.writeFile(fixture.base, `${JSON.stringify(firstBase, null, 2)}\n`, 'utf8');
  const secondOutputPath = path.join(fixture.root, 'preview-data-second.json');
  const second = await executeCli([
    '--input', 'input.xml',
    '--base', 'wxr-import-base.json',
    '--output', 'preview-data-second.json',
  ], { cwd: fixture.root });
  assert.equal(second.code, 0, second.stderr);
  const secondOutput = JSON.parse(await fs.readFile(secondOutputPath, 'utf8'));
  const secondBase = JSON.parse(await fs.readFile(fixture.resolvedBaseArtifact, 'utf8'));
  assert.deepEqual(secondBase.import, { media_from: source, media_to: destination });
  assert.equal(secondBase.site.media_origin, '');
  assert.equal(secondOutput.site.media_origin, 'https://media.example');
  assert.equal(secondOutput.content.posts[0].featured_image, '/imported/hero.jpg');

  const thirdOutputPath = path.join(fixture.root, 'preview-data-third.json');
  const third = await executeCli([
    '--input', 'input.xml',
    '--base', 'wxr-import-base.json',
    '--output', 'preview-data-third.json',
  ], { cwd: fixture.root });
  assert.equal(third.code, 0, third.stderr);
  const thirdOutput = JSON.parse(await fs.readFile(thirdOutputPath, 'utf8'));
  assert.equal(thirdOutput.site.media_origin, 'https://media.example');
  assert.equal(thirdOutput.content.posts[0].featured_image, '/imported/hero.jpg');
  assert.equal(JSON.stringify(thirdOutput).includes('/imported/imported/'), false);
  await assertNoTemporaryFiles(fixture.root, fixture.artifactDir);
});

test('CLI reports warnings to stderr identically with and without a report file', async (t) => {
  const withReport = await makeFixture(t, warningWxr());
  const withoutReport = await makeFixture(t, warningWxr());

  const reported = await executeCli(defaultArgs(), { cwd: withReport.root });
  const unreported = await executeCli([...defaultArgs(), '--no-report'], { cwd: withoutReport.root });
  assert.equal(reported.code, 0, reported.stderr);
  assert.equal(unreported.code, 0, unreported.stderr);

  const reportedWarnings = warningLines(reported.stderr);
  const unreportedWarnings = warningLines(unreported.stderr);
  assert.deepEqual(unreportedWarnings, reportedWarnings);
  assert.match(reported.stderr, /WARN invalid_public_id: 1 item\(s\) skipped/);
  assert.match(reported.stderr, /WARN invalid_date: 1 item\(s\) skipped/);
  assert.match(reported.stderr, /WARN synthesized_authors: 1 item\(s\)/);
  assert.match(reported.stderr, /WARN media_prefix_inference_skipped: 1 item\(s\)/);
  assert.match(reported.stderr, /WARN unresolved_featured_images: 1 item\(s\)/);
  assert.match(reported.stderr, /WARN timezone_inference_skipped: 1 setting\(s\); affected: "site:timezone"/);
  assert.match(reported.stdout, /Excluded unpublished posts: 1/);
  assert.match(reported.stdout, /Excluded unpublished pages: 1/);
  assert.match(reported.stdout, /Excluded unpublished menu items: 1/);
  assert.match(reported.stdout, /Excluded password-protected items: 1/);
});

test('CLI reports ambiguous timezone offsets identically with and without a report file', async (t) => {
  const withReport = await makeFixture(t, ambiguousTimezoneWxr());
  const withoutReport = await makeFixture(t, ambiguousTimezoneWxr());

  const reported = await executeCli(defaultArgs(), { cwd: withReport.root });
  const unreported = await executeCli([...defaultArgs(), '--no-report'], { cwd: withoutReport.root });
  assert.equal(reported.code, 0, reported.stderr);
  assert.equal(unreported.code, 0, unreported.stderr);
  assert.deepEqual(warningLines(unreported.stderr), warningLines(reported.stderr));
  assert.match(
    reported.stderr,
    /WARN timezone_inference_ambiguous: 2 offset\(s\); affected: "-05:00", "-04:00"/,
  );
});

function defaultArgs() {
  return [
    '--input', 'input.xml',
    '--base', 'wxr-import-base.json',
    '--output', 'preview-data.json',
  ];
}

async function makeFixture(t, wxr = minimalWxr()) {
  const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-wxr-import-'));
  const root = await fs.realpath(createdRoot);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifactDir = path.join(root, '.zeropress-wxr-import');
  const fixture = {
    root,
    input: path.join(root, 'input.xml'),
    base: path.join(root, 'wxr-import-base.json'),
    output: path.join(root, 'preview-data.json'),
    artifactDir,
    resolvedBaseArtifact: path.join(artifactDir, 'wxr-import-base.resolved.json'),
    reportArtifact: path.join(artifactDir, 'wxr-import-report.json'),
  };
  await fs.writeFile(fixture.input, wxr, 'utf8');
  await fs.writeFile(fixture.base, `${JSON.stringify(minimalBase(), null, 2)}\n`, 'utf8');
  return fixture;
}

function minimalBase() {
  return {
    $schema: 'https://schemas.zeropress.dev/wxr-import-base/v0.7/schema.json',
    version: '0.7',
    site: {},
    import: {},
  };
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

function minimalWxr() {
  return wxrDocument(`
    <item>
      <title><![CDATA[Hello]]></title>
      <content:encoded><![CDATA[<p>Hello</p>]]></content:encoded>
      <wp:post_id>1</wp:post_id>
      <wp:post_date><![CDATA[2026-01-02 03:04:05]]></wp:post_date>
      <wp:post_date_gmt><![CDATA[2026-01-02 03:04:05]]></wp:post_date_gmt>
      <wp:post_modified_gmt><![CDATA[2026-01-03 03:04:05]]></wp:post_modified_gmt>
      <wp:post_name><![CDATA[hello]]></wp:post_name>
      <wp:post_type><![CDATA[post]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:comment_status><![CDATA[open]]></wp:comment_status>
    </item>`);
}

function unsafeMenuWxr(url) {
  return wxrDocument(`
    <wp:term>
      <wp:term_slug>main-menu</wp:term_slug>
      <wp:term_name>Main Menu</wp:term_name>
      <wp:term_taxonomy>nav_menu</wp:term_taxonomy>
    </wp:term>
    <item>
      <title><![CDATA[Bad Link]]></title>
      <wp:post_id>201</wp:post_id>
      <wp:post_type>nav_menu_item</wp:post_type>
      <wp:status>publish</wp:status>
      <category domain="nav_menu" nicename="main-menu">Main Menu</category>
      <wp:postmeta>
        <wp:meta_key>_menu_item_type</wp:meta_key>
        <wp:meta_value>custom</wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_menu_item_url</wp:meta_key>
        <wp:meta_value><![CDATA[${url}]]></wp:meta_value>
      </wp:postmeta>
    </item>`);
}

function mediaWxr() {
  return wxrDocument(`
    <item>
      <wp:post_id>90</wp:post_id>
      <wp:post_type>attachment</wp:post_type>
      <wp:status>inherit</wp:status>
      <wp:attachment_url>https://blog.example/wp-content/uploads/hero.jpg</wp:attachment_url>
      <wp:postmeta><wp:meta_key>_wp_attachment_metadata</wp:meta_key><wp:meta_value><![CDATA[a:2:{s:5:"width";i:1200;s:6:"height";i:800;}]]></wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key>_wp_attachment_image_alt</wp:meta_key><wp:meta_value>Hero image</wp:meta_value></wp:postmeta>
    </item>
    <item>
      <title>Media Post</title>
      <content:encoded><![CDATA[<img src="https://blog.example/wp-content/uploads/hero.jpg">]]></content:encoded>
      <wp:post_id>1</wp:post_id>
      <wp:post_date>2026-01-02 03:04:05</wp:post_date>
      <wp:post_date_gmt>2026-01-02 03:04:05</wp:post_date_gmt>
      <wp:post_modified_gmt>2026-01-03 03:04:05</wp:post_modified_gmt>
      <wp:post_name>media-post</wp:post_name>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:comment_status>open</wp:comment_status>
      <wp:postmeta>
        <wp:meta_key>_thumbnail_id</wp:meta_key>
        <wp:meta_value>90</wp:meta_value>
      </wp:postmeta>
    </item>`);
}

function warningWxr() {
  return wxrDocument(`
    <item>
      <title>Published</title>
      <dc:creator>undeclared-author</dc:creator>
      <content:encoded><![CDATA[<p>Published</p>]]></content:encoded>
      <wp:post_id>1</wp:post_id>
      <wp:post_date_gmt>2026-01-02 03:04:05</wp:post_date_gmt>
      <wp:post_modified_gmt>2026-01-03 03:04:05</wp:post_modified_gmt>
      <wp:post_name>published</wp:post_name>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:comment_status>open</wp:comment_status>
      <wp:postmeta>
        <wp:meta_key>_thumbnail_id</wp:meta_key>
        <wp:meta_value>999</wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <wp:post_id>90</wp:post_id>
      <wp:post_type>attachment</wp:post_type>
      <wp:status>inherit</wp:status>
      <wp:attachment_url>https://cdn.example/media/unrecognized.jpg</wp:attachment_url>
    </item>
    <item>
      <wp:post_id>2</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>draft</wp:status>
    </item>
    <item>
      <wp:post_id>3</wp:post_id>
      <wp:post_type>page</wp:post_type>
      <wp:status>draft</wp:status>
    </item>
    <item>
      <wp:post_id>4</wp:post_id>
      <wp:post_type>nav_menu_item</wp:post_type>
      <wp:status>draft</wp:status>
    </item>
    <item>
      <wp:post_id>5</wp:post_id>
      <wp:post_password>secret</wp:post_password>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
    </item>
    <item>
      <wp:post_id>not-an-id</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
    </item>
    <item>
      <wp:post_id>6</wp:post_id>
      <wp:post_date_gmt>not-a-date</wp:post_date_gmt>
      <wp:post_modified_gmt>2026-01-03 03:04:05</wp:post_modified_gmt>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
    </item>`);
}

function ambiguousTimezoneWxr() {
  return wxrDocument(`
    <item>
      <title>Winter</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_date>2026-01-01 07:00:00</wp:post_date>
      <wp:post_date_gmt>2026-01-01 12:00:00</wp:post_date_gmt>
      <wp:post_modified_gmt>2026-01-01 12:00:00</wp:post_modified_gmt>
      <wp:post_name>winter</wp:post_name>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:comment_status>open</wp:comment_status>
    </item>
    <item>
      <title>Summer</title>
      <wp:post_id>2</wp:post_id>
      <wp:post_date>2026-07-01 08:00:00</wp:post_date>
      <wp:post_date_gmt>2026-07-01 12:00:00</wp:post_date_gmt>
      <wp:post_modified_gmt>2026-07-01 12:00:00</wp:post_modified_gmt>
      <wp:post_name>summer</wp:post_name>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:comment_status>open</wp:comment_status>
    </item>`);
}

function wxrDocument(items) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <pubDate>Wed, 15 Jul 2026 09:00:00 +0000</pubDate>
    <title>Minimal Site</title>
    <link>https://example.com</link>
    <description></description>
    <language>en</language>
    <wp:wxr_version>1.2</wp:wxr_version>
    ${items}
  </channel>
</rss>`;
}

function executeCli(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function assertNoTemporaryFiles(...directories) {
  for (const directory of directories) {
    const entries = await fs.readdir(directory);
    assert.equal(entries.some((entry) => entry.endsWith('.tmp')), false, `temporary file remains in ${directory}`);
  }
}

function warningLines(stderr) {
  return stderr.split(/\r?\n/).filter((line) => line.startsWith('WARN '));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
