import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSlugSegment, slugFromText } from '../src/slug.js';

test('preserves safe internal dots in imported WordPress slugs', () => {
  assert.equal(normalizeSlugSegment('Theme-Runtime-v0.6'), 'Theme-Runtime-v0.6');
  assert.equal(normalizeSlugSegment('release.2026.07'), 'release.2026.07');
});

test('repairs reserved dot placement in imported WordPress slugs', () => {
  assert.equal(normalizeSlugSegment('.hidden'), 'hidden');
  assert.equal(normalizeSlugSegment('version.'), 'version');
  assert.equal(normalizeSlugSegment('news...today'), 'news-today');
  assert.equal(normalizeSlugSegment('.'), '');
  assert.equal(normalizeSlugSegment('..'), '');
});

test('uses the shared content slug generator for fallback text', () => {
  assert.equal(slugFromText('Theme Runtime v0.6'), 'theme-runtime-v0.6');
  assert.equal(slugFromText('News...Today'), 'news-today');
});
