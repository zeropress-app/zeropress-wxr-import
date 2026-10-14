import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inferWordPressMediaPrefixFromAttachmentUrl,
  normalizeMediaRewriteOptions,
  rewriteMediaUrl,
  rewriteMediaUrls,
} from '../src/media.js';

test('infers the WordPress uploads prefix from an attachment URL', () => {
  assert.equal(
    inferWordPressMediaPrefixFromAttachmentUrl(
      'https://blog.example/wp-content/uploads/2025/12/photo%202.jpg?download=1#image',
    ),
    'https://blog.example/wp-content/uploads/',
  );
});

test('preserves the exact source spelling when inferring a media prefix', () => {
  const prefix = 'HTTPS://MEDIA.EXAMPLE:443/blog/wp-content/uploads/';
  assert.equal(
    inferWordPressMediaPrefixFromAttachmentUrl(`${prefix}2025/01/one.png`),
    prefix,
  );
});

test('does not infer a prefix from empty, unsafe, or non-WordPress attachment URLs', () => {
  const invalidValues = [
    '',
    '   ',
    null,
    undefined,
    'https://blog.example/wp-content/uploads/',
    'https://blog.example/image.jpg',
    'https://blog.example/not-wp-content/uploads/image.jpg',
    'https://blog.example/wp-content/uploads.evil/image.jpg',
    'https://blog.example/image.jpg?next=/wp-content/uploads/file.jpg',
    '/wp-content/uploads/image.jpg',
    'ftp://blog.example/wp-content/uploads/image.jpg',
    'https://user:pass@blog.example/wp-content/uploads/image.jpg',
    'https://@blog.example/wp-content/uploads/image.jpg',
    'https://blog.example\\wp-content\\uploads\\image.jpg',
    ' https://blog.example/wp-content/uploads/image.jpg',
    42,
  ];

  for (const value of invalidValues) {
    assert.equal(inferWordPressMediaPrefixFromAttachmentUrl(value), null);
  }
});

test('retains normalized identity rules as explicit exceptions', () => {
  assert.deepEqual(
    normalizeMediaRewriteOptions({ media_rewrites: [{ from: 'https://blog.example/wp-content/uploads', to: 'https://blog.example/wp-content/uploads/' }] }),
    [{ from: 'https://blog.example/wp-content/uploads/', to: 'https://blog.example/wp-content/uploads/' }],
  );

  const identity = [{
    from: 'https://blog.example/wp-content/uploads/',
    to: 'https://blog.example/wp-content/uploads/',
  }];
  const content = '<img src="https://blog.example/wp-content/uploads/2025/hero.jpg">';
  const url = 'https://blog.example/wp-content/uploads/2025/hero.jpg';

  assert.equal(rewriteMediaUrls(content, identity), content);
  assert.equal(rewriteMediaUrl(url, identity), url);
});

test('rewrites a media prefix and normalizes its trailing slash', () => {
  const rewrite = normalizeMediaRewriteOptions({ media_rewrites: [{ from: 'https://blog.example/wp-content/uploads', to: 'https://media.example/imported' }] });

  assert.deepEqual(rewrite, [{
    from: 'https://blog.example/wp-content/uploads/',
    to: 'https://media.example/imported/',
  }]);
  assert.equal(
    rewriteMediaUrls(
      '<img src="https://blog.example/wp-content/uploads/2025/hero.jpg">',
      rewrite,
    ),
    '<img src="https://media.example/imported/2025/hero.jpg">',
  );
  assert.equal(
    rewriteMediaUrl('https://blog.example/wp-content/uploads/2025/hero.jpg', rewrite),
    'https://media.example/imported/2025/hero.jpg',
  );
});

test('rewrites the exact source prefix once even when the original asset is under the destination path', () => {
  const rewrite = normalizeMediaRewriteOptions({ media_rewrites: [{ from: 'https://blog.example/wp-content/uploads/', to: 'https://blog.example/wp-content/uploads/imported/' }] });
  const sourceUrl = 'https://blog.example/wp-content/uploads/source.jpg';
  const destinationUrl = 'https://blog.example/wp-content/uploads/imported/already.jpg';

  const nestedDestinationUrl = 'https://blog.example/wp-content/uploads/imported/imported/already.jpg';
  assert.equal(rewriteMediaUrl(destinationUrl, rewrite), nestedDestinationUrl);
  assert.equal(
    rewriteMediaUrls(`<img src="${sourceUrl}"><img src="${destinationUrl}">`, rewrite),
    `<img src="https://blog.example/wp-content/uploads/imported/source.jpg"><img src="${nestedDestinationUrl}">`,
  );
});


test('applies longest matches once with identity exceptions and multiple sources', () => {
  const rules = normalizeMediaRewriteOptions({ media_rewrites: [
    { from: 'https://old.example/media', to: 'https://cdn.example/images' },
    { from: 'https://older.example/media', to: 'https://cdn.example/images' },
    { from: 'https://old.example/media/keep', to: 'https://old.example/media/keep' },
    { from: 'https://cdn.example/images', to: 'https://final.example/images' },
  ] });
  assert.equal(rewriteMediaUrl('https://old.example/media/keep/a.png', rules), 'https://old.example/media/keep/a.png');
  assert.equal(rewriteMediaUrl('https://older.example/media/a.png?x=1#view', rules), 'https://cdn.example/images/a.png?x=1#view');
  assert.equal(rewriteMediaUrls('<img src="https://old.example/media/a.png"><img src="https://cdn.example/images/b.png">', rules),
    '<img src="https://cdn.example/images/a.png"><img src="https://final.example/images/b.png">');
  assert.equal(rewriteMediaUrl('https://old.example/media-other/a.png', rules), 'https://old.example/media-other/a.png');
  assert.deepEqual(normalizeMediaRewriteOptions({ media_rewrites: [...rules].reverse() }), rules);
});

test('deduplicates identical sources and rejects conflicting destinations', () => {
  const rule = { from: 'https://old.example/media/', to: 'https://cdn.example/images/' };
  assert.deepEqual(normalizeMediaRewriteOptions({ media_rewrites: [rule, { ...rule }] }), [rule]);
  assert.throws(() => normalizeMediaRewriteOptions({ media_rewrites: [rule, { ...rule, to: 'https://other.example/' }] }), /conflicting destinations/);
});
