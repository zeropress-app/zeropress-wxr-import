export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue; }
export interface ConversionReport {
  counts: Record<string, number>;
  skipped: Record<string, number>;
  warnings: Record<string, { count: number; affected: string[] }>;
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
  options?: { override?: JsonObject; generatorVersion?: string },
): Promise<ConversionResult>;
export function validateBase(base: unknown): JsonObject;
