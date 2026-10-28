import previewSchema from '@zeropress/preview-data-validator/preview-data.v0.7.schema.json' with { type: 'json' };
import { BASE_SITE_KEYS, normalizeBase } from './base.js';
import { addWarning } from './report.js';

const closedObject = (properties) => ({ type: 'object', additionalProperties: false, properties });
const ref = (name) => ({ $ref: `#/$defs/${name}` });

// Use the installed contract's object shapes only to identify supported keys.
// Value constraints and complete configurations are checked by normalizeBase.
export const OVERRIDE_SHAPE = closedObject({
  $schema: { type: 'string' },
  version: { type: 'string' },
  site: closedObject(Object.fromEntries(
    [...BASE_SITE_KEYS].map((key) => [key, previewSchema.$defs.site.properties[key]]),
  )),
  meta: ref('previewMeta'),
  newsletter: ref('siteNewsletter'),
  comments: ref('siteComments'),
  widgets: ref('widgets'),
  collections: ref('collections'),
  custom_css: ref('customCss'),
  custom_html: ref('customHtml'),
  import: closedObject({
    menu_mapping: { type: 'object', additionalProperties: { type: 'string' } },
    media_rewrites: {
      type: 'array',
      items: closedObject({ from: { type: 'string' }, to: { type: 'string' } }),
    },
  }),
});
const REPLACED_OBJECTS = new Set(['widgets', 'collections', 'import.menu_mapping']);

export function normalizeBaseWithOverride(base, override, report) {
  // Validate the original base even if an override could hide its mistakes.
  const normalizedBase = normalizeBase(base);
  if (override === undefined) return normalizedBase;
  if (!isRecord(override)) throw new Error('Invalid override JSON: expected an object');
  if (Object.hasOwn(override, 'version') && override.version !== base.version) {
    throw new Error(`Invalid override JSON: version must match base version ${JSON.stringify(base.version)}`);
  }
  if (Object.hasOwn(override, '$schema') && typeof override.$schema !== 'string') {
    throw new Error('Invalid override JSON: $schema must be a string');
  }

  const patch = filterProperties(override, OVERRIDE_SHAPE, '', report);
  delete patch.version;
  delete patch.$schema;
  // Merge raw inputs: normalizing the override first would introduce defaults.
  const merged = mergeSettings(base, patch, OVERRIDE_SHAPE, '');
  try {
    return normalizeBase(merged);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid base JSON:')) {
      throw new Error(error.message.replace('Invalid base JSON:', 'Invalid merged base/override JSON:'));
    }
    throw error;
  }
}

function filterProperties(value, shape, path, report) {
  shape = resolveShape(shape);
  if (shape.type === 'array' && Array.isArray(value)) {
    return value.map((entry, index) => filterProperties(entry, shape.items, `${path}[${index}]`, report));
  }
  if (shape.type !== 'object' || !isRecord(value)) return structuredClone(value);

  const entries = [];
  for (const [key, entry] of Object.entries(value)) {
    const childPath = propertyPath(path, key);
    const childShape = propertyShape(shape, key);
    if (childShape === false) {
      report.warnings.ignored_override_properties ??= { count: 0, affected: [] };
      addWarning(report, 'ignored_override_properties', childPath);
    } else {
      entries.push([key, filterProperties(entry, childShape, childPath, report)]);
    }
  }
  // fromEntries preserves literal __proto__ keys without invoking setters.
  return Object.fromEntries(entries);
}

function mergeSettings(base, patch, shape, path) {
  shape = resolveShape(shape);
  if (shape.type !== 'object' || !isRecord(patch) || REPLACED_OBJECTS.has(path)) {
    return structuredClone(patch);
  }
  const entries = new Map(Object.entries(isRecord(base) ? base : {}));
  for (const [key, value] of Object.entries(patch)) {
    const childPath = propertyPath(path, key);
    const childShape = resolveShape(propertyShape(shape, key));
    const merged = mergeSettings(entries.get(key), value, childShape, childPath);
    // Empty partial settings do not create incomplete blocks. Whole-object
    // replacements, including {}, retain their explicit clearing semantics.
    if (!entries.has(key) && childShape.type === 'object' && isRecord(merged)
      && Object.keys(merged).length === 0 && !REPLACED_OBJECTS.has(childPath)) continue;
    entries.set(key, merged);
  }
  return Object.fromEntries(entries);
}

function propertyShape(shape, key) {
  return Object.hasOwn(shape.properties ?? {}, key)
    ? shape.properties[key]
    : shape.additionalProperties ?? true;
}

function resolveShape(shape) {
  if (shape === true || shape === undefined) return {};
  while (shape.$ref) {
    const name = shape.$ref.slice('#/$defs/'.length);
    if (!shape.$ref.startsWith('#/$defs/') || !Object.hasOwn(previewSchema.$defs, name)) {
      throw new Error(`Unsupported override contract reference: ${shape.$ref}`);
    }
    shape = previewSchema.$defs[name];
  }
  return shape;
}

function propertyPath(parent, key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? (parent ? `${parent}.${key}` : key)
    : `${parent}[${JSON.stringify(key)}]`;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
