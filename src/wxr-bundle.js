import { parseXml } from './xml.js';

export const WXR_BUNDLE_LIMITS = Object.freeze({ file: 8 * 1024 * 1024, manifest: 1024 * 1024, parts: 256 });
const kinds = ['authors', 'categories', 'tags', 'terms', 'items'];
const hex = /^[a-f0-9]{64}$/;
const fail = (message) => { throw new Error(`Invalid WXR bundle: ${message}`); };
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail('unexpected or missing fields');
}
function descriptor(value, part) {
  keys(value, part ? ['path', 'bytes', 'sha256', 'records'] : ['path', 'bytes', 'sha256']);
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > WXR_BUNDLE_LIMITS.file
    || typeof value.sha256 !== 'string' || !hex.test(value.sha256)) fail('invalid file size or digest');
  if (part) {
    if (value.path !== `wordpress-export.parts/p-${value.sha256}.xml`) fail('invalid part path');
    keys(value.records, kinds);
    for (const count of Object.values(value.records)) if (!Number.isSafeInteger(count) || count < 0 || count > value.bytes) fail('invalid record count');
  } else if (value.path !== 'wxr-import-base.json') fail('invalid base path');
}

export function validateWxrBundleManifest(input) {
  keys(input, ['format', 'format_version', 'wxr_version', 'generated_at', 'data_hash', 'base', 'parts']);
  if (input.format !== 'zeropress-wxr-bundle' || input.format_version !== 1 || input.wxr_version !== '1.2') fail('unsupported format');
  if (typeof input.generated_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(input.generated_at)
    || !Number.isFinite(Date.parse(input.generated_at)) || new Date(input.generated_at).toISOString() !== input.generated_at.replace('Z', '.000Z')) fail('invalid generation time');
  if (typeof input.data_hash !== 'string' || !hex.test(input.data_hash)) fail('invalid logical digest');
  descriptor(input.base, false);
  if (!Array.isArray(input.parts) || !input.parts.length || input.parts.length > WXR_BUNDLE_LIMITS.parts) fail('invalid part inventory');
  const seen = new Set();
  for (const part of input.parts) {
    descriptor(part, true);
    if (seen.has(part.path)) fail('duplicate part');
    seen.add(part.path);
    if (input.parts.length > 1 && Object.values(part.records).every((n) => n === 0)) fail('empty part in nonempty inventory');
  }
  const copy = structuredClone(input);
  if (new TextEncoder().encode(JSON.stringify(copy)).length > WXR_BUNDLE_LIMITS.manifest) fail('manifest too large');
  return copy;
}

/** Bounded byte reader shared by Node and the browser API. Never resolves URLs. */
export async function readBundleFile(openFile, entry) {
  const bytes = new Uint8Array(entry.bytes);
  let offset = 0;
  for await (const chunk of await openFile(entry.path)) {
    if (!(chunk instanceof Uint8Array) || chunk.length > entry.bytes - offset) fail('file size mismatch');
    bytes.set(chunk, offset); offset += chunk.length;
  }
  if (offset !== entry.bytes) fail('file size mismatch');
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  if (Array.from(hash, (v) => v.toString(16).padStart(2, '0')).join('') !== entry.sha256) fail('file checksum mismatch');
  // Do not allow the legacy sanitizer to repair corrupted bundle transport bytes.
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('invalid UTF-8'); }
  return bytes;
}

export async function openBundleInput({ manifest, openFile }) {
  const validated = validateWxrBundleManifest(manifest);
  if (typeof openFile !== 'function') fail('openFile is required');
  const base = JSON.parse(new TextDecoder().decode(await readBundleFile(openFile, validated.base)));
  return {
    base,
    async parse(_unused, options) {
      let combined;
      const identities = Object.fromEntries(kinds.map((kind) => [kind, new Set()]));
      for (const part of validated.parts) {
        const bytes = await readBundleFile(openFile, part);
        const doc = await parseXml((async function* () { yield bytes; })(), options);
        if (doc.channel.pubDate) fail('part must not override manifest generation time');
        if (combined && JSON.stringify(doc.channel) !== JSON.stringify(combined.channel)) fail('inconsistent channel fields');
        if (!combined) combined = { ...doc, ...Object.fromEntries(kinds.map((kind) => [kind, []])) };
        for (const kind of kinds) {
          if (doc[kind].length !== part.records[kind]) fail('record count mismatch');
          for (const record of doc[kind]) {
            const id = kind === 'items' ? record.wp.post_id : kind === 'authors' ? record.wp.author_id : record.wp.term_id;
            const key = kind === 'terms' ? `${record.wp.term_taxonomy}:${id}` : id;
            if (!id || identities[kind].has(key)) fail('missing or duplicate record identity');
            identities[kind].add(key);
            if (kind === 'terms') record.order = combined.terms.length;
            combined[kind].push(record);
          }
        }
      }
      combined.channel.pubDate = new Date(validated.generated_at).toUTCString().replace('GMT', '+0000');
      return combined;
    },
  };
}
