import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPreviewMenus, extractNavMenuItem, extractNavMenuTerms } from '../src/menu.js';
import { createReport } from '../src/report.js';

test('extracts navigation terms from SAX compact document records', () => {
  const terms = extractNavMenuTerms({
    terms: [
      {
        order: 3,
        wp: {
          term_taxonomy: 'post_tag',
          term_slug: 'ignored',
          term_name: 'Ignored',
        },
      },
      {
        order: 8,
        wp: {
          term_id: '42',
          term_taxonomy: 'nav_menu',
          term_slug: 'Main Menu',
          term_name: 'Main navigation',
        },
      },
    ],
  });

  assert.deepEqual(terms, [{
    wpId: '42',
    rawSlug: 'Main Menu',
    sourceSlug: 'Main Menu',
    slug: 'Main-Menu',
    name: 'Main navigation',
    order: 8,
  }]);
});

test('rejects declared navigation menus whose source slugs normalize to the same slug', () => {
  assert.throws(
    () => extractNavMenuTerms({
      terms: [
        {
          wp: {
            term_id: '12',
            term_taxonomy: 'nav_menu',
            term_slug: 'main..nav',
            term_name: 'First Menu',
          },
        },
        {
          wp: {
            term_id: '34',
            term_taxonomy: 'nav_menu',
            term_slug: 'main-nav',
            term_name: 'Second Menu',
          },
        },
      ],
    }),
    {
      message: 'Invalid WXR menu slug collision: menu sources '
        + 'term ID "12" (slug "main..nav", name "First Menu") and '
        + 'term ID "34" (slug "main-nav", name "Second Menu") '
        + 'both normalize to "main-nav". Rename one of these menus in WordPress, '
        + 'then export the WXR again.',
    },
  );
});

test('extracts navigation items from SAX compact item records', () => {
  const item = extractNavMenuItem({
    title: '  Documentation  ',
    wp: {
      post_id: '100',
      menu_order: '7',
    },
    postmeta: {
      _menu_item_menu_item_parent: '55',
      _menu_item_type: 'custom',
      _menu_item_object: 'custom',
      _menu_item_object_id: '0',
      _menu_item_target: '_blank',
      _menu_item_url: 'https://docs.example/',
    },
    categories: [
      { domain: 'category', nicename: 'ignored' },
      { domain: 'nav_menu', nicename: 'Main Menu' },
    ],
  });

  assert.deepEqual(item, {
    wpId: '100',
    parentWpId: '55',
    menuSlugs: ['Main-Menu'],
    menuSlugSources: [{
      kind: 'item',
      itemWpId: '100',
      rawSlug: 'Main Menu',
      sourceSlug: 'Main Menu',
      slug: 'Main-Menu',
      name: 'Main Menu',
    }],
    order: 7,
    title: 'Documentation',
    itemType: 'custom',
    objectType: 'custom',
    objectId: '0',
    target: '_blank',
    url: 'https://docs.example/',
  });
});

test('rejects colliding inline menu assignments while allowing repeated references', () => {
  const first = extractNavMenuItem({
    title: 'First',
    wp: { post_id: '101' },
    postmeta: { _menu_item_type: 'custom', _menu_item_url: '/first' },
    categories: [{ domain: 'nav_menu', nicename: 'main..nav', textContent: 'First Menu' }],
  });
  const second = extractNavMenuItem({
    title: 'Second',
    wp: { post_id: '102' },
    postmeta: { _menu_item_type: 'custom', _menu_item_url: '/second' },
    categories: [{ domain: 'nav_menu', nicename: 'main-nav', textContent: 'Second Menu' }],
  });

  assert.throws(
    () => buildMenus({ terms: [], rawItems: [first, second], report: createReport() }),
    /item ID "101" assignment.*slug "main\.\.nav".*item ID "102" assignment.*slug "main-nav".*normalize to "main-nav"/,
  );

  const repeated = extractNavMenuItem({
    title: 'Repeated',
    wp: { post_id: '103' },
    postmeta: { _menu_item_type: 'custom', _menu_item_url: '/repeated' },
    categories: [{ domain: 'nav_menu', nicename: 'main..nav', textContent: 'First Menu' }],
  });
  const menus = buildMenus({
    terms: [],
    rawItems: [first, repeated],
    report: createReport(),
  });
  assert.deepEqual(menus.primary.items.map((item) => item.title), ['First', 'Repeated']);
});

test('records published menu items without a menu assignment as skipped', () => {
  const report = createReport();
  const menus = buildPreviewMenus({
    terms: [],
    rawItems: [{
      wpId: '99',
      parentWpId: '0',
      menuSlugs: [],
      order: 0,
      title: 'Unassigned',
      itemType: 'custom',
      objectType: '',
      objectId: '',
      target: '_self',
      url: '/unassigned',
    }],
    postsByWpId: new Map(),
    pagesByWpId: new Map(),
    categoriesByWpId: new Map(),
    tagsByWpId: new Map(),
    sourceOrigin: '',
    report,
  });

  assert.deepEqual(menus, {});
  assert.deepEqual(report.warnings.skipped_menu_items, { count: 1, affected: ['99'] });
});

test('rejects an illegal URL even when the menu item is unassigned', () => {
  assert.throws(
    () => buildPreviewMenus({
      terms: [],
      rawItems: [{
        wpId: '98',
        parentWpId: '0',
        menuSlugs: [],
        order: 0,
        title: 'Unassigned unsafe URL',
        itemType: 'custom',
        objectType: '',
        objectId: '',
        target: '_self',
        url: '/foo%ZZ',
      }],
      postsByWpId: new Map(),
      pagesByWpId: new Map(),
      categoriesByWpId: new Map(),
      tagsByWpId: new Map(),
      sourceOrigin: '',
      report: createReport(),
    }),
    /menu "\(unassigned\)".*item ID "98".*malformed percent encoding/,
  );
});

test('converts WordPress post_tag taxonomy menu items', () => {
  const report = createReport();
  const menus = buildMenus({
    rawItems: [menuItem({
      wpId: '1',
      itemType: 'taxonomy',
      objectType: 'post_tag',
      objectId: '42',
      title: '',
    })],
    tagsByWpId: new Map([
      ['42', { name: 'Release notes', url: '/tag/release-notes' }],
    ]),
    report,
  });

  assert.deepEqual(menus.primary.items, [{
    title: 'Release notes',
    url: '/tag/release-notes',
    target: '_self',
    children: [],
  }]);
  assert.equal(report.warnings.skipped_menu_items.count, 0);
});

test('rejects illegal menu URLs with actionable item context', () => {
  const cases = [
    ['/../secret', /path traversal segments/],
    ['/foo\\bar', /backslashes are not allowed/],
    ['/foo%ZZ', /malformed percent encoding is not allowed/],
    ['https://user:password@external.example/private', /URL credentials are not allowed/],
    ['//external.example/path', /protocol-relative URLs are not allowed/],
    ['javascript:alert(1)', /only absolute HTTP\(S\) URLs and root-relative URLs are allowed/],
  ];

  for (const [url, reason] of cases) {
    assert.throws(
      () => buildMenus({
        rawItems: [menuItem({
          wpId: '41',
          title: 'Unsafe destination',
          url,
        })],
        report: createReport(),
      }),
      (error) => {
        assert.match(error.message, /^Invalid WXR menu URL:/);
        assert.match(error.message, /menu "Primary"/);
        assert.match(error.message, /item ID "41"/);
        assert.match(error.message, /title "Unsafe destination"/);
        assert.match(error.message, reason);
        assert.equal(error.message.includes(`URL ${JSON.stringify(url)}`), true);
        return true;
      },
    );
  }
});

test('keeps an empty custom menu URL in the incomplete-item warning path', () => {
  const report = createReport();
  const menus = buildMenus({
    rawItems: [menuItem({
      wpId: '42',
      title: 'Missing destination',
      url: '',
    })],
    report,
  });

  assert.deepEqual(menus, {});
  assert.deepEqual(report.warnings.skipped_menu_items, {
    count: 1,
    affected: ['42'],
  });
});

test('promotes an item with a missing parent to the menu root', () => {
  const report = createReport();
  const menus = buildMenus({
    rawItems: [menuItem({ wpId: '7', parentWpId: '404', title: 'Orphan' })],
    report,
  });

  assert.equal(menus.primary.items[0].title, 'Orphan');
  assert.deepEqual(report.warnings.orphan_menu_parents, {
    count: 1,
    affected: ['7'],
  });
});

test('keeps depth 10 and discards the depth 11 node and its descendants', () => {
  const report = createReport();
  const rawItems = [];
  for (let depth = 1; depth <= 12; depth += 1) {
    rawItems.push(menuItem({
      wpId: String(depth),
      parentWpId: depth === 1 ? '0' : String(depth - 1),
      title: `Depth ${depth}`,
      order: depth,
    }));
  }

  const menus = buildMenus({ rawItems, report });
  let current = menus.primary.items[0];
  for (let depth = 1; depth <= 10; depth += 1) {
    assert.equal(current.title, `Depth ${depth}`);
    if (depth < 10) {
      assert.equal(current.children.length, 1);
      current = current.children[0];
    }
  }
  assert.deepEqual(current.children, []);
  assert.deepEqual(report.warnings.discarded_deep_menu_items, {
    count: 2,
    affected: ['11', '12'],
  });
});

test('discards cycle components and their descendants while retaining other roots', () => {
  const report = createReport();
  const menus = buildMenus({
    rawItems: [
      menuItem({ wpId: '1', parentWpId: '2', title: 'Cycle one', order: 1 }),
      menuItem({ wpId: '2', parentWpId: '1', title: 'Cycle two', order: 2 }),
      menuItem({ wpId: '3', parentWpId: '1', title: 'Cycle descendant', order: 3 }),
      menuItem({ wpId: '4', parentWpId: '0', title: 'Retained', order: 4 }),
    ],
    report,
  });

  assert.deepEqual(menus.primary.items.map((item) => item.title), ['Retained']);
  assert.deepEqual(report.warnings.discarded_cyclic_menu_items, {
    count: 3,
    affected: ['1', '2', '3'],
  });
});

test('fails quickly after exhausting bounded menu ID suffixes', () => {
  const accepted = collidingMenuIds(1000);
  const menus = buildMenus({ ...accepted, report: createReport() });
  const menuIds = Object.keys(menus);
  assert.equal(menuIds.length, 1000);
  assert.equal(new Set(menuIds).size, 1000);
  assert.equal(menuIds.includes(`${'a'.repeat(60)}-999`), true);

  const rejected = collidingMenuIds(1001);
  assert.throws(
    () => buildMenus({ ...rejected, report: createReport() }),
    (error) => {
      assert.match(error.message, /^Invalid WXR menu ID collision:/);
      assert.match(error.message, /term ID "1001"/);
      assert.match(error.message, /candidate "a{64}"/);
      assert.match(error.message, /At least 1000 menus map to the same ID family/);
      assert.match(error.message, /Rename or consolidate these menus in WordPress/);
      return true;
    },
  );
});

function buildMenus({
  rawItems,
  terms = [{ slug: 'primary', name: 'Primary', order: 0 }],
  tagsByWpId = new Map(),
  report,
}) {
  return buildPreviewMenus({
    terms,
    rawItems,
    postsByWpId: new Map(),
    pagesByWpId: new Map(),
    categoriesByWpId: new Map(),
    tagsByWpId,
    sourceOrigin: 'https://wordpress.example',
    report,
  });
}

function menuItem({
  wpId,
  parentWpId = '0',
  menuSlugs = ['primary'],
  title,
  order = 0,
  itemType = 'custom',
  objectType = '',
  objectId = '',
  url = itemType === 'custom' ? `/menu/${wpId}` : '',
}) {
  return {
    wpId,
    parentWpId,
    menuSlugs,
    order,
    title,
    itemType,
    objectType,
    objectId,
    target: '_self',
    url,
  };
}

function collidingMenuIds(count) {
  const prefix = 'a'.repeat(64);
  const terms = [];
  const rawItems = [];
  for (let index = 0; index < count; index += 1) {
    const slug = `${prefix}-${index}`;
    terms.push({
      wpId: String(index + 1),
      rawSlug: slug,
      sourceSlug: slug,
      slug,
      name: `Menu ${index + 1}`,
      order: index,
    });
    rawItems.push(menuItem({
      wpId: String(index + 1),
      menuSlugs: [slug],
      title: `Item ${index + 1}`,
    }));
  }
  return { terms, rawItems };
}
