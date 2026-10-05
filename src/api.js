import metadata from '../package.json' with { type: 'json' };
import { convertWxrToPreviewData as convert } from './converter.js';

export const converterVersion = metadata.version;

/**
 * Convert a stream of UTF-8 bytes or text chunks without file-system access.
 * The CLI and browser entry point share the same conversion and validation.
 */
export function convertWxrToPreviewData(source, base = { version: '0.7' }, options = {}) {
  return convert(source, base, {
    ...options,
    generatorVersion: options.generatorVersion ?? converterVersion,
  });
}

export { normalizeBase as validateBase } from './base.js';
