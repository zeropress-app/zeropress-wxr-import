import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeHttpUrlPrefix, stripSourceBasePath } from '../src/url.js';

test('URL prefixes normalize trailing slashes without changing internal slashes or URL spelling', () => {
  for (const [input, expected] of [
    ['https://example.com', 'https://example.com/'],
    ['https://example.com///', 'https://example.com/'],
    ['HTTPS://MEDIA.EXAMPLE:443/a//b///', 'HTTPS://MEDIA.EXAMPLE:443/a//b/'],
    ['https://example.com/a%2F///', 'https://example.com/a%2F/'],
  ]) {
    assert.equal(normalizeHttpUrlPrefix(input), expected);
  }
  for (const input of ['', '/', '//', null, 'https://example.com/a/?', 'https://example.com/a/#', 'https://example.com/a/\n']) {
    assert.equal(normalizeHttpUrlPrefix(input), null);
  }
});

test('source paths trim trailing slashes while retaining root and segment boundaries', () => {
  for (const root of ['', '/', '///']) {
    assert.equal(stripSourceBasePath('/post/', root), '/post/');
  }
  assert.equal(stripSourceBasePath('/blog', '/blog///'), '/');
  assert.equal(stripSourceBasePath('/blog/', '/blog///'), '/');
  assert.equal(stripSourceBasePath('/blog/post/', '/blog///'), '/post/');
  assert.equal(stripSourceBasePath('/blog-other/post/', '/blog/'), '/blog-other/post/');
  assert.equal(stripSourceBasePath('/a//b/post/', '/a//b///'), '/post/');
});
