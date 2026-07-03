import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWordPressAttachmentMetadata } from '../src/wordpress-attachment-metadata.js';

test('extracts top-level dimensions and file from WordPress PHP metadata', () => {
  const value = 'a:6:{s:5:"width";i:1018;s:6:"height";i:724;s:4:"file";s:24:"2025/10/대표-image.png";s:8:"filesize";i:12345;s:5:"sizes";a:1:{s:9:"thumbnail";a:2:{s:5:"width";i:150;s:6:"height";i:107;}}s:10:"image_meta";a:0:{}}';

  assert.deepEqual(parseWordPressAttachmentMetadata(value), {
    width: 1018,
    height: 724,
    file: '2025/10/대표-image.png',
  });
});

test('does not mistake nested thumbnail dimensions for original dimensions', () => {
  const value = 'a:1:{s:5:"sizes";a:1:{s:9:"thumbnail";a:2:{s:5:"width";i:150;s:6:"height";i:150;}}}';
  assert.equal(parseWordPressAttachmentMetadata(value), null);
});

test('accepts a compact JSON metadata fallback', () => {
  assert.deepEqual(parseWordPressAttachmentMetadata(JSON.stringify({
    width: 640,
    height: 480,
    file: '2026/01/photo.jpg',
    sizes: { thumbnail: { width: 150, height: 113 } },
  })), {
    width: 640,
    height: 480,
    file: '2026/01/photo.jpg',
  });
});

test('rejects malformed, unsafe, non-positive, and unsupported serialized metadata', () => {
  const invalid = [
    '',
    'not serialized',
    'a:2:{s:5:"width";i:0;s:6:"height";i:-1;}',
    'a:1:{s:5:"width";O:8:"stdClass":0:{}}',
    'a:1:{s:5:"width";R:1;}',
    'a:1:{s:5:"width";i:9007199254740992;}',
    'a:1:{s:4:"file";s:99:"short";}',
    'a:2:{s:5:"width";i:10;s:5:"sizes";d:;}',
  ];

  for (const value of invalid) {
    assert.equal(parseWordPressAttachmentMetadata(value), null, value);
  }
});

test('handles deeply nested input without recursive stack growth', () => {
  let value = 'N;';
  for (let depth = 0; depth < 200; depth += 1) {
    value = `a:1:{i:0;${value}}`;
  }
  const wrapped = `a:1:{s:5:"sizes";${value}}`;

  assert.equal(parseWordPressAttachmentMetadata(wrapped), null);
});
