import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { convertWxrToPreviewData } from '../src/converter.js';

const BIN_PATH = fileURLToPath(new URL('../bin/zeropress-wxr-import.js', import.meta.url));

test('2 MB adversarial unclosed raw-text element remains linear and hides its tail', { timeout: 30_000 }, async () => {
  const content = `<p>Visible</p><script>${'</script "'.repeat(220_000)}`;
  const { previewData } = await convertWxrToPreviewData(
    Readable.from([wxrDocument(postItem(1, content))]),
    { version: '0.7', site: {} },
  );

  assert.equal(previewData.content.posts[0].excerpt, 'Visible');
});

test('large generated WXR converts, validates, and writes under a 128 MB old-space limit', { timeout: 30_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-wxr-memory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'large.xml');
  const base = path.join(root, 'base.json');
  const output = path.join(root, 'preview-data.json');
  const body = `<p>${'a'.repeat(4096)}</p>`;
  const items = [];
  for (let id = 1; id <= 2_500; id += 1) {
    items.push(postItem(id, body));
  }
  await fs.writeFile(input, wxrDocument(items.join('')), 'utf8');
  await fs.writeFile(base, '{"version":"0.7","site":{}}\n', 'utf8');

  const result = await executeNode([
    '--max-old-space-size=128',
    BIN_PATH,
    '--input', input,
    '--base', base,
    '--output', output,
  ], root);
  assert.equal(result.code, 0, result.stderr);

  const generated = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(generated.content.posts.length, 2_500);
  assert.equal(generated.content.posts[0].content, body);
  assert.equal(generated.content.posts.at(-1).content, body);
});

test('excluded item bodies do not accumulate under a 128 MB old-space limit', { timeout: 30_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-wxr-excluded-memory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'excluded.xml');
  const base = path.join(root, 'base.json');
  const output = path.join(root, 'preview-data.json');
  const body = 'x'.repeat(32 * 1024);
  const itemsPerKind = 250;
  const inputFile = await fs.open(input, 'w');
  try {
    await inputFile.write(wxrDocumentStart());
    for (let index = 0; index < itemsPerKind; index += 1) {
      const draftId = index + 1;
      const passwordId = index + 1 + itemsPerKind;
      const customId = index + 1 + (itemsPerKind * 2);
      const attachmentId = index + 1 + (itemsPerKind * 3);
      await inputFile.write(excludedBodyItem(draftId, body, {
        postType: 'post',
        status: 'draft',
      }));
      await inputFile.write(excludedBodyItem(passwordId, body, {
        postType: 'post',
        status: 'publish',
        password: 'secret',
      }));
      await inputFile.write(excludedBodyItem(customId, body, {
        postType: 'product',
        status: 'publish',
      }));
      await inputFile.write(excludedBodyItem(attachmentId, body, {
        postType: 'attachment',
        status: 'inherit',
        attachmentUrl: `https://example.com/wp-content/uploads/2026/image-${attachmentId}.jpg`,
      }));
    }
    await inputFile.write(postItem((itemsPerKind * 4) + 1, '<p>Retained</p>'));
    await inputFile.write(wxrDocumentEnd());
  } finally {
    await inputFile.close();
  }
  await fs.writeFile(base, '{"version":"0.7","site":{}}\n', 'utf8');

  const result = await executeNode([
    '--max-old-space-size=128',
    BIN_PATH,
    '--input', input,
    '--base', base,
    '--output', output,
    '--with-report',
  ], root);
  assert.equal(result.code, 0, result.stderr);

  const generated = JSON.parse(await fs.readFile(output, 'utf8'));
  const report = JSON.parse(await fs.readFile(
    path.join(root, '.zeropress-wxr-import', 'wxr-import-report.json'),
    'utf8',
  ));
  assert.equal(generated.content.posts.length, 1);
  assert.equal(generated.content.posts[0].content, '<p>Retained</p>');
  assert.equal(report.skipped.unpublished_posts, itemsPerKind);
  assert.equal(report.skipped.password_protected, itemsPerKind);
});

test('ambiguous attachment inference and warning aggregation remain linear under 128 MB', { timeout: 30_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-wxr-media-memory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'attachments.xml');
  const base = path.join(root, 'base.json');
  const output = path.join(root, 'preview-data.json');
  const attachmentCount = 40_000;
  const items = [];
  for (let id = 1; id <= attachmentCount; id += 1) {
    const origin = id % 2 === 0 ? 'https://one.example' : 'https://two.example';
    items.push(attachmentItem(id, `${origin}/wp-content/uploads/2026/image-${id}.jpg`));
  }
  await fs.writeFile(input, wxrDocument(items.join('')), 'utf8');
  await fs.writeFile(base, '{"version":"0.7","site":{}}\n', 'utf8');

  const result = await executeNode([
    '--max-old-space-size=128',
    BIN_PATH,
    '--input', input,
    '--base', base,
    '--output', output,
    '--with-report',
  ], root);
  assert.equal(result.code, 0, result.stderr);

  const report = JSON.parse(await fs.readFile(
    path.join(root, '.zeropress-wxr-import', 'wxr-import-report.json'),
    'utf8',
  ));
  assert.equal(report.warnings.media_prefix_inference_skipped.count, attachmentCount);
  assert.equal(report.warnings.media_prefix_inference_skipped.affected.length, attachmentCount);
});

test('unresolved featured-image warning aggregation remains linear under 128 MB', { timeout: 30_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-wxr-thumbnail-memory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'missing-thumbnails.xml');
  const base = path.join(root, 'base.json');
  const output = path.join(root, 'preview-data.json');
  const postCount = 40_000;
  const items = [];
  for (let id = 1; id <= postCount; id += 1) {
    items.push(postWithMissingThumbnailItem(id, id + postCount));
  }
  await fs.writeFile(input, wxrDocument(items.join('')), 'utf8');
  await fs.writeFile(base, '{"version":"0.7","site":{}}\n', 'utf8');

  const result = await executeNode([
    '--max-old-space-size=128',
    BIN_PATH,
    '--input', input,
    '--base', base,
    '--output', output,
    '--with-report',
  ], root);
  assert.equal(result.code, 0, result.stderr);

  const report = JSON.parse(await fs.readFile(
    path.join(root, '.zeropress-wxr-import', 'wxr-import-report.json'),
    'utf8',
  ));
  assert.equal(report.warnings.unresolved_featured_images.count, postCount);
  assert.equal(report.warnings.unresolved_featured_images.affected.length, postCount);
});

function postItem(id, content) {
  return `<item>
    <title>Post ${id}</title>
    <content:encoded><![CDATA[${content}]]></content:encoded>
    <wp:post_id>${id}</wp:post_id>
    <wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt>
    <wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt>
    <wp:post_name>post-${id}</wp:post_name>
    <wp:post_type>post</wp:post_type>
    <wp:status>publish</wp:status>
    <wp:comment_status>open</wp:comment_status>
  </item>`;
}

function excludedBodyItem(id, content, {
  postType,
  status,
  password = '',
  attachmentUrl = '',
}) {
  return `<item>
    <title>Excluded ${id}</title>
    <content:encoded><![CDATA[${content}]]></content:encoded>
    <excerpt:encoded><![CDATA[${content}]]></excerpt:encoded>
    <wp:post_id>${id}</wp:post_id>
    <wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt>
    <wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt>
    <wp:post_name>excluded-${id}</wp:post_name>
    ${password ? `<wp:post_password>${password}</wp:post_password>` : ''}
    <wp:post_type>${postType}</wp:post_type>
    <wp:status>${status}</wp:status>
    ${attachmentUrl ? `<wp:attachment_url>${attachmentUrl}</wp:attachment_url>` : ''}
  </item>`;
}

function attachmentItem(id, url) {
  return `<item>
    <wp:post_id>${id}</wp:post_id>
    <wp:post_type>attachment</wp:post_type>
    <wp:status>inherit</wp:status>
    <wp:attachment_url>${url}</wp:attachment_url>
  </item>`;
}

function postWithMissingThumbnailItem(id, thumbnailId) {
  return `<item>
    <wp:post_id>${id}</wp:post_id>
    <wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt>
    <wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt>
    <wp:post_type>post</wp:post_type>
    <wp:status>publish</wp:status>
    <wp:comment_status>open</wp:comment_status>
    <wp:postmeta>
      <wp:meta_key>_thumbnail_id</wp:meta_key>
      <wp:meta_value>${thumbnailId}</wp:meta_value>
    </wp:postmeta>
  </item>`;
}

function wxrDocument(items) {
  return `${wxrDocumentStart()}${items}${wxrDocumentEnd()}`;
}

function wxrDocumentStart() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <pubDate>Wed, 15 Jul 2026 09:00:00 +0000</pubDate>
    <title>Large Test</title>
    <link>https://example.com</link>
    <wp:wxr_version>1.2</wp:wxr_version>
`;
}

function wxrDocumentEnd() {
  return `
  </channel>
</rss>`;
}

function executeNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
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
