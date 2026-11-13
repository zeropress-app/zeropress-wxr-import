import metadata from '../package.json' with { type: 'json' };
import { convertWxrToPreviewData as convert, convertWxrToPreviewDataSource as convertSource, convertWxrBundleToPreviewDataSource as convertBundle } from './converter.js';

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

/** Replayable conversion; the caller owns the supplied temporary work store. */
export function convertWxrToPreviewDataSource(source, base = { version: '0.7' }, options = {}) {
  return convertSource(source, base, { ...options, generatorVersion: options.generatorVersion ?? converterVersion });
}

/** Convert one verified WXR bundle as one logical export. */
export function convertWxrBundleToPreviewDataSource(bundle, options = {}) {
  return convertBundle(bundle, { ...options, generatorVersion: options.generatorVersion ?? converterVersion });
}
