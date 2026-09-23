import assert from 'node:assert/strict';
import test from 'node:test';
import { materializeWordPressClassicHtml } from '../src/wordpress-content.js';

test('materializes classic single line breaks as explicit soft breaks', () => {
  assert.equal(
    materializeWordPressClassicHtml('<p>첫 줄\n둘째 줄</p>'),
    '<p>첫 줄<br />\n둘째 줄</p>',
  );
  assert.equal(
    materializeWordPressClassicHtml('첫 문단\n둘째 줄\n\n새 문단'),
    '<p>첫 문단<br />\n둘째 줄</p>\n<p>새 문단</p>',
  );
});

test('keeps block and raw element structure while removing presentation whitespace', () => {
  assert.equal(
    materializeWordPressClassicHtml('<ol>\n  <li>One</li>\n  <li>Two</li>\n</ol>'),
    '<ol>\n<li>One</li>\n<li>Two</li>\n</ol>',
  );
  assert.equal(
    materializeWordPressClassicHtml('<pre>one\ntwo</pre>'),
    '<pre>one\ntwo</pre>',
  );
  assert.equal(
    materializeWordPressClassicHtml('<script>one\ntwo</script>'),
    '<script>one\ntwo</script>',
  );
});

test('does not turn line breaks inside a multiline tag into br elements', () => {
  const source = '<p><a href="https://example.com"\n  title="Example">Link</a></p>';
  assert.equal(materializeWordPressClassicHtml(source), source);
});

test('leaves Gutenberg block markup to its own renderer', () => {
  const source = '<!-- wp:paragraph -->\n<p>One\nTwo</p>\n<!-- /wp:paragraph -->';
  assert.equal(materializeWordPressClassicHtml(source), source);
});
