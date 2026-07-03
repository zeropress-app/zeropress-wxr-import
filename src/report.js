const WARNING_CODES = Object.freeze([
  'skipped_menu_items',
  'synthesized_authors',
  'orphan_page_parents',
  'orphan_menu_parents',
  'resolved_page_path_conflicts',
  'discarded_deep_menu_items',
  'discarded_cyclic_menu_items',
  'media_prefix_inference_skipped',
  'unresolved_featured_images',
  'comments_api_base_inference_skipped',
  'invalid_comment_statuses',
  'locale_inference_skipped',
  'timezone_inference_skipped',
  'timezone_inference_ambiguous',
]);

/**
 * Dedupe indexes for warning `affected` lists, keyed by report.
 *
 * The sets live outside the report so the report stays plain JSON data, and so
 * repeated warnings for large exports stay linear instead of rescanning the
 * growing `affected` array.
 */
const affectedIndexes = new WeakMap();

export function createReport() {
  return {
    counts: {
      authors: 0,
      posts: 0,
      pages: 0,
      categories: 0,
      tags: 0,
      media: 0,
      menus: 0,
    },
    skipped: {
      unpublished_posts: 0,
      unpublished_pages: 0,
      unpublished_menu_items: 0,
      password_protected: 0,
      invalid_public_id: 0,
      invalid_date: 0,
    },
    warnings: Object.fromEntries(
      WARNING_CODES.map((code) => [code, { count: 0, affected: [] }]),
    ),
    inferred: {
      permalinks: {},
    },
  };
}

export function addWarning(report, code, affected) {
  const warning = report.warnings[code];
  if (!warning) {
    throw new Error(`Unknown warning code: ${code}`);
  }

  const normalized = String(affected);
  const affectedSet = affectedIndexFor(report, code, warning);
  if (affectedSet.has(normalized)) {
    return;
  }

  affectedSet.add(normalized);
  warning.affected.push(normalized);
  warning.count = warning.affected.length;
}

function affectedIndexFor(report, code, warning) {
  let byCode = affectedIndexes.get(report);
  if (!byCode) {
    byCode = new Map();
    affectedIndexes.set(report, byCode);
  }

  let affectedSet = byCode.get(code);
  if (!affectedSet) {
    affectedSet = new Set(warning.affected);
    byCode.set(code, affectedSet);
  }
  return affectedSet;
}
