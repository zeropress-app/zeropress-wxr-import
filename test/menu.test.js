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
          term_taxonomy: 'nav_menu',
          term_slug: 'Main Menu',
          term_name: 'Main navigation',
        },
      },
    ],
  });

  assert.deepEqual(terms, [{
    slug: 'Main-Menu',
    name: 'Main navigation',
    order: 8,
  }]);
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
    order: 7,
    title: 'Documentation',
    itemType: 'custom',
    objectType: 'custom',
    objectId: '0',
    target: '_blank',
    url: 'https://docs.example/',
  });
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

function buildMenus({ rawItems, tagsByWpId = new Map(), report }) {
  return buildPreviewMenus({
    terms: [{ slug: 'primary', name: 'Primary', order: 0 }],
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
  title,
  order = 0,
  itemType = 'custom',
  objectType = '',
  objectId = '',
}) {
  return {
    wpId,
    parentWpId,
    menuSlugs: ['primary'],
    order,
    title,
    itemType,
    objectType,
    objectId,
    target: '_self',
    url: itemType === 'custom' ? `/menu/${wpId}` : '',
  };
}

