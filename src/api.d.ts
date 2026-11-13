export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue; }
export interface ConversionReport {
  counts: Record<string, number>;
  skipped: Record<string, number>;
  warnings: Record<string, { count: number; affected: string[]; max_body_bytes?: number; omitted_examples?: number; message?: string }>;
  inferred: JsonObject;
}
export interface ConversionResult {
  previewData: JsonObject;
  base: JsonObject;
  report: ConversionReport;
}
export const converterVersion: string;
export function convertWxrToPreviewData(
  source: AsyncIterable<Uint8Array | string>,
  base?: JsonObject,
  options?: { override?: JsonObject; maxBodyBytes?: number | null; generatorVersion?: string },
): Promise<ConversionResult>;
export function validateBase(base: unknown): JsonObject;

/** The caller closes the returned source and its supplied work store. No filesystem access in this API. */
export function convertWxrToPreviewDataSource(
  source: AsyncIterable<Uint8Array | string>,
  base: JsonObject | undefined,
  options: {
    override?: JsonObject;
    maxBodyBytes?: number | null; generatorVersion?: string;
    workStore: import('@zeropress/preview-data-validator').PreviewDataWorkStore;
  },
): Promise<{ source: import('@zeropress/preview-data-validator').PreviewDataSource; base: JsonObject; report: ConversionReport }>;

/** Explicit allowlisted byte resolver; no implicit network or filesystem access. */
export function convertWxrBundleToPreviewDataSource(
  bundle: { manifest: unknown; openFile(path: string): AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>> },
  options: { override?: JsonObject; maxBodyBytes?: number | null; generatorVersion?: string; workStore: import('@zeropress/preview-data-validator').PreviewDataWorkStore },
): ReturnType<typeof convertWxrToPreviewDataSource>;
