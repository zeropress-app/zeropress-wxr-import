import { addWarning } from './report.js';
import { MAX_UNIQUE_NAME_ATTEMPTS, normalizeSlugSegment } from './slug.js';
import { resolveNavigationUrl } from './url.js';
import { itemCategories, postMetaValue, wpText } from './xml.js';

export function extractNavMenuTerms(doc) {
  const terms = [];
  const wpTerms = Array.isArray(doc?.terms) ? doc.terms : [];
  for (let index = 0; index < wpTerms.length; index += 1) {
    const term = wpTerms[index];
    if (wpText(term, 'term_taxonomy') !== 'nav_menu') {
      continue;
    }
    const rawSlug = wpText(term, 'term_slug');
    const rawName = wpText(term, 'term_name');
    const sourceSlug = rawSlug || rawName;
    const slug = normalizeSlugSegment(sourceSlug);
    if (!slug) {
      continue;
    }
    terms.push({
      wpId: wpText(term, 'term_id'),
      rawSlug,
      sourceSlug,
      slug,
      name: rawName || slug,
      order: Number.isSafeInteger(term.order) && term.order >= 0 ? term.order : index,
    });
  }
  return deduplicateNavMenuTerms(terms);
}

export function extractNavMenuItem(item) {
  const wpId = wpText(item, 'post_id');
  if (!wpId) {
    return null;
  }

  const menuSlugSources = navMenuSlugSourcesForItem(item, wpId);
  return {
    wpId,
    parentWpId: postMetaValue(item, '_menu_item_menu_item_parent') || '0',
    menuSlugs: menuSlugSources.map((source) => source.slug),
    menuSlugSources,
    order: Number.parseInt(wpText(item, 'menu_order') || '0', 10) || 0,
    title: String(item?.title ?? '').trim(),
    itemType: postMetaValue(item, '_menu_item_type'),
    objectType: postMetaValue(item, '_menu_item_object'),
    objectId: postMetaValue(item, '_menu_item_object_id'),
    target: postMetaValue(item, '_menu_item_target') === '_blank' ? '_blank' : '_self',
    url: postMetaValue(item, '_menu_item_url'),
  };
}

const MAX_MENU_DEPTH = 10;

export function buildPreviewMenus({
  terms,
  rawItems,
  postsByWpId,
  pagesByWpId,
  categoriesByWpId,
  tagsByWpId,
  sourceOrigin,
  report,
}) {
  terms = deduplicateNavMenuTerms(terms);
  validateNavMenuSlugSources(terms, rawItems);

  if (rawItems.length === 0) {
    return {};
  }

  const assignedItems = [];
  for (const item of rawItems) {
    if (item.menuSlugs.length === 0) {
      normalizeMenuUrl(item.url, sourceOrigin, {
        menuName: '(unassigned)',
        raw: item,
      });
      addWarning(report, 'skipped_menu_items', item.wpId);
    } else {
      assignedItems.push(item);
    }
  }
  if (assignedItems.length === 0) {
    return {};
  }

  const activeMenuSlugs = new Set(assignedItems.flatMap((item) => item.menuSlugs));
  const discoveredTermSlugs = new Set(terms.map((term) => term.slug));
  for (const slug of activeMenuSlugs) {
    if (!discoveredTermSlugs.has(slug)) {
      terms.push({
        wpId: '',
        rawSlug: slug,
        sourceSlug: slug,
        slug,
        name: slug,
        order: terms.length,
      });
    }
  }

  const menuIdBySlug = buildMenuIdAssignments(terms, activeMenuSlugs);
  const termBySlug = new Map(terms.map((term) => [term.slug, term]));
  const menus = {};

  for (const [menuSlug, menuId] of menuIdBySlug) {
    const term = termBySlug.get(menuSlug);
    const menuName = term?.name || menuSlug;
    const menuRawItems = assignedItems
      .filter((item) => item.menuSlugs.includes(menuSlug))
      .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title));
    const convertedByWpId = new Map();
    const parentByWpId = new Map();

    for (const raw of menuRawItems) {
      const converted = convertMenuItem(raw, {
        postsByWpId,
        pagesByWpId,
        categoriesByWpId,
        tagsByWpId,
        sourceOrigin,
        report,
        menuName,
      });
      if (!converted) {
        continue;
      }
      convertedByWpId.set(raw.wpId, converted);
      parentByWpId.set(raw.wpId, raw.parentWpId);
    }

    const tree = buildMenuTree({ menuRawItems, convertedByWpId, parentByWpId, report });

    if (tree.length === 0) {
      continue;
    }

    menus[menuId] = {
      name: menuName,
      items: tree,
    };
  }

  return menus;
}

function navMenuSlugSourcesForItem(item, itemWpId) {
  return itemCategories(item, 'nav_menu')
    .map((category) => {
      const rawSlug = String(category.nicename ?? '').trim();
      return {
        kind: 'item',
        itemWpId,
        rawSlug,
        sourceSlug: rawSlug,
        slug: normalizeSlugSegment(rawSlug),
        name: category.textContent?.trim() || rawSlug,
      };
    })
    .filter((source) => source.slug);
}

function deduplicateNavMenuTerms(terms) {
  const uniqueTerms = [];
  const sourcesByWpId = new Map();
  const sourcesBySlug = new Map();

  for (const term of terms) {
    const source = navMenuTermSource(term);
    const previousByWpId = source.wpId ? sourcesByWpId.get(source.wpId) : null;
    if (previousByWpId) {
      if (isSameNavMenuTermDeclaration(previousByWpId, source)) {
        continue;
      }
      throw new Error(
        'Invalid WXR menu term conflict: '
        + `${formatNavMenuSlugSource(previousByWpId)} conflicts with `
        + `${formatNavMenuSlugSource(source)}. A WordPress menu term ID must have one `
        + 'source slug and name. Repair the menu in WordPress, then export the WXR again.',
      );
    }

    const previousBySlug = sourcesBySlug.get(source.slug);
    if (previousBySlug) {
      if (isSameNavMenuTermDeclaration(previousBySlug, source)) {
        continue;
      }
      throwNavMenuSlugCollision(previousBySlug, source);
    }

    if (source.wpId) {
      sourcesByWpId.set(source.wpId, source);
    }
    sourcesBySlug.set(source.slug, source);
    uniqueTerms.push(term);
  }

  return uniqueTerms;
}

function navMenuTermSource(term) {
  return {
    kind: 'term',
    wpId: term.wpId ?? '',
    rawSlug: term.rawSlug ?? term.slug,
    sourceSlug: term.sourceSlug ?? term.rawSlug ?? term.slug,
    slug: term.slug,
    name: term.name,
  };
}

function isSameNavMenuTermDeclaration(left, right) {
  return left.wpId === right.wpId
    && left.rawSlug === right.rawSlug
    && left.sourceSlug === right.sourceSlug
    && left.slug === right.slug
    && left.name === right.name;
}

function validateNavMenuSlugSources(terms, rawItems) {
  const sourcesBySlug = new Map();

  for (const term of terms) {
    registerNavMenuSlugSource(sourcesBySlug, navMenuTermSource(term));
  }

  for (const item of rawItems) {
    const sources = Array.isArray(item.menuSlugSources) ? item.menuSlugSources : [];
    for (const source of sources) {
      registerNavMenuSlugSource(sourcesBySlug, source);
    }
  }
}

function registerNavMenuSlugSource(sourcesBySlug, source) {
  const previousSource = sourcesBySlug.get(source.slug);
  if (!previousSource) {
    sourcesBySlug.set(source.slug, source);
    return;
  }

  const repeatedItemReference = (previousSource.kind === 'item' || source.kind === 'item')
    && previousSource.sourceSlug === source.sourceSlug;
  if (repeatedItemReference) {
    return;
  }

  throwNavMenuSlugCollision(previousSource, source);
}

function throwNavMenuSlugCollision(previousSource, source) {
  throw new Error(
    'Invalid WXR menu slug collision: menu sources '
    + `${formatNavMenuSlugSource(previousSource)} and ${formatNavMenuSlugSource(source)} `
    + `both normalize to ${JSON.stringify(source.slug)}. Rename one of these menus in WordPress, `
    + 'then export the WXR again.',
  );
}

function formatNavMenuSlugSource(source) {
  const owner = source.kind === 'item'
    ? `item ID ${JSON.stringify(String(source.itemWpId ?? ''))} assignment`
    : source.wpId
      ? `term ID ${JSON.stringify(String(source.wpId))}`
      : 'term without an ID';
  const slug = source.rawSlug
    ? JSON.stringify(source.rawSlug)
    : '(missing; using the menu name as fallback)';
  return `${owner} (slug ${slug}, name ${JSON.stringify(String(source.name ?? ''))})`;
}

function convertMenuItem(raw, {
  postsByWpId,
  pagesByWpId,
  categoriesByWpId,
  tagsByWpId,
  sourceOrigin,
  report,
  menuName,
}) {
  const explicitTitle = raw.title.trim();
  const fallbackUrl = normalizeMenuUrl(raw.url, sourceOrigin, { menuName, raw });

  if (raw.itemType === 'custom') {
    if (explicitTitle && fallbackUrl) {
      return menuItem(explicitTitle, fallbackUrl, raw.target);
    }
  }

  if (raw.itemType === 'post_type' && raw.objectType === 'post') {
    const post = postsByWpId.get(raw.objectId);
    if (post) {
      const converted = menuItem(explicitTitle || post.title, null, raw.target, post.url);
      if (converted) {
        return converted;
      }
    }
  }

  if (raw.itemType === 'post_type' && raw.objectType === 'page') {
    const page = pagesByWpId.get(raw.objectId);
    if (page) {
      const converted = menuItem(explicitTitle || page.title, null, raw.target, page.url);
      if (converted) {
        return converted;
      }
    }
  }

  if (raw.itemType === 'taxonomy' && raw.objectType === 'category') {
    const category = categoriesByWpId.get(raw.objectId);
    if (category) {
      const converted = menuItem(explicitTitle || category.name, null, raw.target, category.url);
      if (converted) {
        return converted;
      }
    }
  }

  if (raw.itemType === 'taxonomy' && raw.objectType === 'post_tag') {
    const tag = tagsByWpId.get(raw.objectId);
    if (tag) {
      const converted = menuItem(explicitTitle || tag.name, null, raw.target, tag.url);
      if (converted) {
        return converted;
      }
    }
  }

  if (fallbackUrl && explicitTitle) {
    return menuItem(explicitTitle, fallbackUrl, raw.target);
  }

  addWarning(report, 'skipped_menu_items', raw.wpId);
  return null;
}

function buildMenuTree({ menuRawItems, convertedByWpId, parentByWpId, report }) {
  const orderedWpIds = [];
  const seenWpIds = new Set();
  for (const raw of menuRawItems) {
    if (!convertedByWpId.has(raw.wpId) || seenWpIds.has(raw.wpId)) {
      continue;
    }
    seenWpIds.add(raw.wpId);
    orderedWpIds.push(raw.wpId);
  }

  for (const wpId of orderedWpIds) {
    const parentWpId = parentByWpId.get(wpId);
    if (!parentWpId || parentWpId === '0') {
      parentByWpId.set(wpId, null);
      continue;
    }
    if (!convertedByWpId.has(parentWpId)) {
      parentByWpId.set(wpId, null);
      addWarning(report, 'orphan_menu_parents', wpId);
    }
  }

  const cyclicWpIds = findCyclicNodesAndDescendants(orderedWpIds, parentByWpId);
  for (const wpId of orderedWpIds) {
    if (cyclicWpIds.has(wpId)) {
      addWarning(report, 'discarded_cyclic_menu_items', wpId);
    }
  }

  const acyclicWpIds = orderedWpIds.filter((wpId) => !cyclicWpIds.has(wpId));
  const depthByWpId = calculateMenuDepths(acyclicWpIds, parentByWpId);
  const deepWpIds = new Set();
  for (const wpId of acyclicWpIds) {
    if (depthByWpId.get(wpId) > MAX_MENU_DEPTH) {
      deepWpIds.add(wpId);
      addWarning(report, 'discarded_deep_menu_items', wpId);
    }
  }

  const retainedWpIds = new Set(
    acyclicWpIds.filter((wpId) => !deepWpIds.has(wpId)),
  );
  const tree = [];
  for (const wpId of orderedWpIds) {
    if (!retainedWpIds.has(wpId)) {
      continue;
    }

    const converted = convertedByWpId.get(wpId);
    const parentWpId = parentByWpId.get(wpId);
    if (parentWpId && retainedWpIds.has(parentWpId)) {
      convertedByWpId.get(parentWpId).children.push(converted);
    } else {
      tree.push(converted);
    }
  }
  return tree;
}

function findCyclicNodesAndDescendants(orderedWpIds, parentByWpId) {
  const safeWpIds = new Set();
  const cyclicWpIds = new Set();

  for (const startWpId of orderedWpIds) {
    if (safeWpIds.has(startWpId) || cyclicWpIds.has(startWpId)) {
      continue;
    }

    const path = [];
    const pathIndexByWpId = new Map();
    let currentWpId = startWpId;
    let reachesCycle = false;

    while (currentWpId) {
      if (cyclicWpIds.has(currentWpId)) {
        reachesCycle = true;
        break;
      }
      if (safeWpIds.has(currentWpId)) {
        break;
      }
      if (pathIndexByWpId.has(currentWpId)) {
        reachesCycle = true;
        break;
      }

      pathIndexByWpId.set(currentWpId, path.length);
      path.push(currentWpId);
      currentWpId = parentByWpId.get(currentWpId) || null;
    }

    const destination = reachesCycle ? cyclicWpIds : safeWpIds;
    for (const wpId of path) {
      destination.add(wpId);
    }
  }

  return cyclicWpIds;
}

function calculateMenuDepths(orderedWpIds, parentByWpId) {
  const depthByWpId = new Map();

  for (const startWpId of orderedWpIds) {
    if (depthByWpId.has(startWpId)) {
      continue;
    }

    const path = [];
    let currentWpId = startWpId;
    while (currentWpId && !depthByWpId.has(currentWpId)) {
      path.push(currentWpId);
      currentWpId = parentByWpId.get(currentWpId) || null;
    }

    let depth = currentWpId ? depthByWpId.get(currentWpId) : 0;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      depth += 1;
      depthByWpId.set(path[index], depth);
    }
  }

  return depthByWpId;
}

function menuItem(title, url, target, fallbackUrl = null) {
  const resolvedUrl = url || fallbackUrl;
  if (!title || !resolvedUrl) {
    return null;
  }
  return {
    title,
    url: resolvedUrl,
    target,
    children: [],
  };
}

function normalizeMenuUrl(rawUrl, sourceOrigin, context) {
  const { url, reason } = resolveNavigationUrl(rawUrl, sourceOrigin);
  if (reason) {
    throw invalidMenuUrlError(context, rawUrl, reason);
  }
  return url;
}

function invalidMenuUrlError({ menuName, raw }, rawUrl, reason) {
  return new Error(
    'Invalid WXR menu URL: '
    + `menu ${JSON.stringify(String(menuName ?? ''))}, `
    + `item ID ${JSON.stringify(String(raw.wpId ?? ''))}, `
    + `title ${JSON.stringify(String(raw.title ?? ''))}, `
    + `URL ${JSON.stringify(String(rawUrl ?? ''))}: ${reason}`,
  );
}

function buildMenuIdAssignments(terms, activeSlugs) {
  const assignments = new Map();
  const used = new Set();
  const activeTerms = terms.filter((term) => activeSlugs.has(term.slug));
  const primaryTerm = activeTerms.find((term) => isPreferredPrimaryMenu(term.slug, term.name)) ?? activeTerms[0];
  const footerTerm = activeTerms.find((term) => term !== primaryTerm && isPreferredFooterMenu(term.slug, term.name));

  const assign = (term, preferredId) => {
    let candidate = preferredId;
    if (used.has(candidate)) {
      candidate = normalizeMenuId(term.slug || term.name, `menu-${term.order + 1}`);
    }

    if (!used.has(candidate)) {
      used.add(candidate);
      assignments.set(term.slug, candidate);
      return;
    }

    for (let suffix = 2; suffix < MAX_UNIQUE_NAME_ATTEMPTS; suffix += 1) {
      const unique = `${candidate.slice(0, 60)}-${suffix}`;
      if (!used.has(unique)) {
        used.add(unique);
        assignments.set(term.slug, unique);
        return;
      }
    }

    throw new Error(
      'Invalid WXR menu ID collision: unable to allocate a unique ZeroPress menu ID for '
      + `${formatNavMenuSlugSource({
        kind: 'term',
        wpId: term.wpId,
        rawSlug: term.rawSlug ?? term.slug,
        name: term.name,
      })} from candidate ${JSON.stringify(candidate)}. `
      + `At least ${MAX_UNIQUE_NAME_ATTEMPTS} menus map to the same ID family. `
      + 'Rename or consolidate these menus in WordPress, then export the WXR again.',
    );
  };

  if (primaryTerm) {
    assign(primaryTerm, 'primary');
  }
  if (footerTerm) {
    assign(footerTerm, 'footer');
  }
  for (const term of activeTerms) {
    if (!assignments.has(term.slug)) {
      assign(term, normalizeMenuId(term.slug || term.name, `menu-${term.order + 1}`));
    }
  }

  return assignments;
}

function normalizeMenuId(value, fallback) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  if (/^[a-z][a-z0-9_-]{0,63}$/.test(normalized)) {
    return normalized;
  }

  const fallbackId = String(fallback ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 59);

  return `menu-${fallbackId || 'imported'}`.slice(0, 64);
}

function isPreferredPrimaryMenu(slug, name) {
  const value = `${slug} ${name}`.toLowerCase();
  return /\b(primary|main|menu-1|topmenu|top-menu|header|navigation|nav)\b/.test(value);
}

function isPreferredFooterMenu(slug, name) {
  const value = `${slug} ${name}`.toLowerCase();
  return /\b(footer|bottom)\b/.test(value);
}
