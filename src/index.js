import { normalizeBodyPolicy } from '@zeropress/preview-data-validator/content-policy';
import { openLocalWxrBundle } from './wxr-bundle-node.js';
import { createDiskWorkStore, readBoundedJson, stagePreviewDataChunks } from '@zeropress/preview-data-validator/node';
import { jsonFragments } from '@zeropress/preview-data-validator/chunks';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { convertWxrToPreviewData, convertWxrToPreviewDataSource, convertWxrBundleToPreviewDataSource } from './converter.js';
import { createColor } from './color.js';
import { toTerminalSafeText } from './terminal.js';
import {
  cleanupStagedFiles,
  commitStagedFiles,
  ensureSafeDirectory,
  stageAtomicFile,
  validateFilePlan,
  resolvePathIdentity,
} from './file-safety.js';

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../package.json');
const OPTION_IDENTITIES = new Map([
  ['--input', '--input'],
  ['--input-format', '--input-format'],
  ['--base', '--base'],
  ['--override', '--override'],
  ['--max-body-bytes', '--max-body-bytes'],
  ['--output', '--output'],
  ['--output-format', '--output-format'],
  ['--with-report', '--with-report'],
  ['--override-generator-version', '--override-generator-version'],
  ['--help', '--help'],
  ['-h', '--help'],
  ['--version', '--version'],
  ['-v', '--version'],
]);
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export async function run(argv) {
  assertNoDuplicateOptions(argv);

  if (argv.length === 0) {
    printHelp();
    return 0;
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(PACKAGE_VERSION);
    return 0;
  }

  const args = parseArgs(argv);
  const startedAt = performance.now();
  const filePlan = {
    input: args.input,
    base: args.base,
    override: args.override,
    output: args.output,
  };
  if (args.withReport) {
    Object.assign(filePlan, {
      artifactDir: args.artifactDir,
      resolvedBaseArtifact: args.resolvedBaseArtifact,
      reportArtifact: args.reportArtifact,
    });
  }
  await validateFilePlan(filePlan);
  if (args.outputFormat === 'chunks') await assertChunkPartsSafe(filePlan);

  let conversion, workStore, bundle, inputStream;
  try {
    if (args.inputFormat === 'bundle') bundle = await openLocalWxrBundle(filePlan, { chunks: args.outputFormat === 'chunks' });
    const base = !bundle && args.base
      ? await readSettingsJsonFile(args.base, 'base', args.outputFormat === 'chunks') : { version: '0.7' };
    const override = args.override ? await readSettingsJsonFile(args.override, 'override', !!bundle || args.outputFormat === 'chunks') : undefined;
    const generatorVersion = args.generatorVersionOverride ?? PACKAGE_VERSION;
    if (bundle || args.outputFormat === 'chunks') workStore = await createDiskWorkStore();
    if (bundle) conversion = await convertWxrBundleToPreviewDataSource(bundle, { generatorVersion, override, workStore, maxBodyBytes: args.maxBodyBytes });
    else {
      inputStream = createReadStream(args.input);
      const convert = workStore ? convertWxrToPreviewDataSource : convertWxrToPreviewData;
      conversion = await convert(inputStream, base, { generatorVersion, override, workStore, maxBodyBytes: args.maxBodyBytes });
    }
    await writeArtifactsAtomically({ args, ...conversion, resolvedBase: conversion.base, beforeCommit: () => bundle?.assertCurrent() });
  } finally {
    inputStream?.destroy();
    await conversion?.source?.close();
    await workStore?.close();
    await bundle?.close();
  }
  const { report } = conversion;
  const outputFileSizeBytes = (await fs.stat(args.output)).size;
  const elapsedMs = Math.round(performance.now() - startedAt);
  const peakRssMiB = process.resourceUsage().maxRSS / 1024;

  printWarnings(report);
  printSummary({
    output: args.output,
    resolvedBasePath: args.resolvedBaseArtifact,
    reportPath: args.reportArtifact,
    withReport: args.withReport,
    generatorVersionOverride: args.generatorVersionOverride,
    report,
    outputFileSizeBytes,
    elapsedMs,
    peakRssMiB,
  });
  return 0;
}

export function parseArgs(argv) {
  assertNoDuplicateOptions(argv);
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--with-report') {
      flags.withReport = true;
      continue;
    }
    if (
      arg === '--input'
      || arg === '--input-format'
      || arg === '--base'
      || arg === '--override'
      || arg === '--max-body-bytes'
      || arg === '--output'
      || arg === '--output-format'
      || arg === '--override-generator-version'
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Invalid arguments: ${arg} requires a value`);
      }
      const key = arg === '--override-generator-version'
        ? 'generatorVersionOverride'
        : arg.slice(2);
      flags[key] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Invalid arguments: unknown option ${arg}`);
    }
    throw new Error(`Invalid arguments: unexpected positional argument ${arg}`);
  }

  for (const key of ['input', 'output']) {
    if (!flags[key]) {
      throw new Error(`Invalid arguments: --${key} <file> is required`);
    }
  }

  if (path.extname(flags.output) !== '.json') {
    throw new Error('Invalid arguments: --output must be a file with a .json extension');
  }
  if (
    flags.generatorVersionOverride !== undefined
    && !SEMVER_PATTERN.test(flags.generatorVersionOverride)
  ) {
    throw new Error(
      'Invalid arguments: --override-generator-version must be a complete SemVer version without a leading "v"',
    );
  }

  const rawMaximum = flags['max-body-bytes'];
  if (rawMaximum !== undefined && !/^[0-9]+$/.test(rawMaximum)) throw new Error('Invalid arguments: --max-body-bytes requires positive integer bytes');
  const { maxBodyBytes } = normalizeBodyPolicy({ maxBodyBytes: rawMaximum === undefined ? null : Number(rawMaximum) });
  const inputFormat = flags['input-format'] ?? 'xml';
  if (!['xml', 'bundle'].includes(inputFormat)) throw new Error('Invalid arguments: --input-format must be xml or bundle');
  const outputFormat = flags['output-format'] ?? 'json';
  if (!['json', 'chunks'].includes(outputFormat)) throw new Error('Invalid arguments: --output-format must be json or chunks');
  const withReport = flags.withReport === true;
  const artifactDir = withReport
    ? path.join(process.cwd(), '.zeropress-wxr-import')
    : null;

  return {
    input: path.resolve(process.cwd(), flags.input),
    base: flags.base ? path.resolve(process.cwd(), flags.base) : null,
    override: flags.override ? path.resolve(process.cwd(), flags.override) : null,
    output: path.resolve(process.cwd(), flags.output),
    artifactDir,
    resolvedBaseArtifact: artifactDir
      ? path.join(artifactDir, 'wxr-import-base.resolved.json')
      : null,
    reportArtifact: artifactDir
      ? path.join(artifactDir, 'wxr-import-report.json')
      : null,
    withReport,
    outputFormat,
    inputFormat,
    generatorVersionOverride: flags.generatorVersionOverride ?? null,
    maxBodyBytes,
  };
}

function assertNoDuplicateOptions(argv) {
  const seen = new Set();
  for (const argument of argv) {
    const identity = OPTION_IDENTITIES.get(argument);
    if (!identity) continue;
    if (seen.has(identity)) {
      throw new Error(`Invalid arguments: duplicate option ${identity}`);
    }
    seen.add(identity);
  }
}

function printHelp() {
  console.log(`zeropress-wxr-import - WordPress WXR to ZeroPress preview-data converter

Usage:
  zeropress-wxr-import --input <file> --output <file.json> [options]

Example:
  zeropress-wxr-import --input wordpress-export.xml --output zeropress-preview-data.json

Required Options:
  --input <file>        WordPress WXR XML export file
  --output <file.json>  Output preview-data v0.7 JSON file

Options:
  --input-format <xml|bundle>         Input format (default: xml); bundle takes wordpress-export.manifest.json
  --output-format <json|chunks>       Output format (default: json); chunks writes a manifest and immutable parts
  --base <file>                       Optional v0.7 JSON file containing site preset and import settings
  --override <file>                   Optional partial settings applied over the base; unknown keys warn and are ignored
  --max-body-bytes <bytes>             Optional inclusive UTF-8 body maximum; omitted means no body-policy ceiling
  --with-report                       Write the resolved base and import report JSON files
  --override-generator-version <ver>  Override only the SemVer label in preview-data.generator
  --help, -h                          Show help
  --version, -v                       Show version

Notes:
  - bodies of 256 KiB or more warn; format and resource protections always apply
  - only published WordPress posts and pages are exported
  - WXR comment records are discarded; WordPress API runtime settings may be generated
  - site/theme-specific settings should be provided in the base or override file`);
}

async function readSettingsJsonFile(filePath, kind, bounded = false) {
  if (bounded) {
    try { return await readBoundedJson(await fs.realpath(filePath), 16 * 1024 * 1024); }
    catch (error) { throw new Error(`Invalid ${kind} file: ${error.message}`); }
  }
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${kind} file not found: ${filePath}`);
    }
    if (error?.code === 'EISDIR') {
      throw new Error(`${kind} path is not a file: ${filePath}`);
    }
    throw new Error(`Failed to read ${kind} file: ${filePath}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${kind} JSON: ${message}`);
  }
}

async function writeArtifactsAtomically({ args, previewData, source, report, resolvedBase, beforeCommit }) {
  const stages = [];
  try {
    const stagedChunks = source && args.outputFormat === 'chunks' ? await stagePreviewDataChunks(source, args.output) : null;
    if (args.withReport) {
      await ensureSafeDirectory(args.artifactDir);
      stages.push(await stageJsonFile(args.resolvedBaseArtifact, resolvedBase));
      stages.push(await stageJsonFile(args.reportArtifact, report));
    }
    stages.push(stagedChunks
      ? await stageAtomicFile(args.output, stagedChunks.text, { encoding: 'utf8' })
      : source ? await stageAtomicFile(args.output, streamSourceJson(source), { encoding: 'utf8' }) : await stageJsonFile(args.output, previewData));

    await beforeCommit?.();
    await commitStagedFiles(stages);
  } catch (error) {
    try {
      await cleanupStagedFiles(stages);
    } catch {
      // Keep the conversion/write failure as the primary CLI error.
    }
    throw error;
  }
}

async function stageJsonFile(filePath, value) {
  return stageAtomicFile(filePath, streamJson(value), { encoding: 'utf8' });
}

function* streamJson(value) {
  let buffer = '';
  for (const fragment of jsonFragments(value)) {
    buffer += fragment;
    if (buffer.length >= 64 * 1024) { yield buffer; buffer = ''; }
  }
  yield buffer + '\n';
}

async function assertChunkPartsSafe(plan) {
  const partsPath = path.join(path.dirname(plan.output), path.basename(plan.output).replace(/(?:\.manifest)?\.json$/, '') + '.parts');
  const parts = await resolvePathIdentity(partsPath);
  for (const [role, file] of Object.entries(plan)) {
    if (!file || role === 'artifactDir') continue;
    const other = await resolvePathIdentity(file);
    const relative = path.relative(parts.canonicalPath, other.canonicalPath);
    const inverse = path.relative(other.canonicalPath, parts.canonicalPath);
    const within = (value) => value === '' || (value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value));
    if (within(relative) || within(inverse)) throw new Error(`Unsafe path collision: chunk parts conflict with ${role}`);
  }
}

function printWarnings(report) {
  const color = createColor(process.stderr);
  const skipped = report?.skipped ?? {};
  for (const code of ['invalid_public_id', 'invalid_date']) {
    const count = nonNegativeCount(skipped[code]);
    if (count > 0) {
      console.error(color.yellow(`WARN ${code}: ${count} item(s) skipped`));
    }
  }

  const warnings = report?.warnings ?? {};
  for (const [code, details] of Object.entries(warnings)) {
    const count = nonNegativeCount(details?.count);
    if (count <= 0) {
      continue;
    }
    const affected = Array.isArray(details.affected)
      ? details.affected.map((value) => toTerminalSafeText(JSON.stringify(String(value))))
      : [];
    const affectedSummary = affected.length > 0
      ? `; affected: ${affected.slice(0, 10).join(', ')}${affected.length > 10 ? `, … (+${affected.length - 10})` : ''}`
      : '';
    const unit = code === 'ignored_override_properties'
      ? 'unknown property/properties ignored'
      : code === 'timezone_inference_ambiguous'
      ? 'offset(s)'
      : code === 'timezone_inference_skipped' || code === 'locale_inference_skipped'
        ? 'setting(s)'
        : 'item(s)';
    const guidance = code === 'large_content_bodies' ? `; ${details.message}; ${Math.max(0, count - Math.min(10, affected.length))} additional example(s) not shown` : '';
    console.error(color.yellow(`WARN ${code}: ${count} ${unit}${affectedSummary}${guidance}`));
  }
}

export function formatWxrImportSuccessMessage(stream = process.stdout) {
  return createColor(stream).green('Converted WXR to ZeroPress preview-data successfully');
}

const EXCLUSION_SUMMARY_LABELS = Object.freeze([
  ['unpublished_posts', 'Excluded unpublished posts'],
  ['unpublished_pages', 'Excluded unpublished pages'],
  ['unpublished_menu_items', 'Excluded unpublished menu items'],
  ['password_protected', 'Excluded password-protected items'],
]);

function printSummary({
  output,
  resolvedBasePath,
  reportPath,
  withReport,
  generatorVersionOverride,
  report,
  outputFileSizeBytes,
  elapsedMs,
  peakRssMiB,
}) {
  console.log(formatWxrImportSuccessMessage());
  console.log('');
  console.log(`Output: ${toTerminalSafeText(output)}`);
  if (generatorVersionOverride) {
    console.log(
      `Generator label: zeropress-wxr-import v${generatorVersionOverride} `
      + `(overridden; CLI v${PACKAGE_VERSION})`,
    );
  }
  if (withReport) {
    console.log(`Resolved base: ${toTerminalSafeText(resolvedBasePath)}`);
  }
  console.log(`Posts: ${report.counts.posts}`);
  console.log(`Pages: ${report.counts.pages}`);
  console.log(`Categories: ${report.counts.categories}`);
  console.log(`Tags: ${report.counts.tags}`);
  console.log(`Menus: ${report.counts.menus}`);
  for (const [code, label] of EXCLUSION_SUMMARY_LABELS) {
    const count = nonNegativeCount(report.skipped?.[code]);
    if (count > 0) {
      console.log(`${label}: ${count}`);
    }
  }
  if (withReport) {
    console.log(`Report: ${toTerminalSafeText(reportPath)}`);
  }
  console.log('');
  console.log(
    `Output FileSize: ${(outputFileSizeBytes / (1024 * 1024)).toFixed(2)} MiB `
    + `(${outputFileSizeBytes} bytes)`,
  );
  console.log(`Elapsed: ${elapsedMs}ms`);
  console.log(`Peak RSS: ${peakRssMiB.toFixed(1)} MiB`);
}

function nonNegativeCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

async function* streamSourceJson(source) {
  yield '{\n';
  for (const [key, value] of Object.entries(source.header)) {
    yield `  ${JSON.stringify(key)}: `;
    yield* jsonFragments(value, 1);
    yield ',\n';
  }
  yield '  "content": {\n';
  for (const [i, collection] of source.collections.entries()) {
    if (i) yield ',\n';
    yield `    ${JSON.stringify(collection)}: [`;
    let index = 0;
    for await (const entry of source.records(collection)) {
      yield index++ ? ',\n      ' : '\n      ';
      yield* jsonFragments(entry.value, 3);
    }
    yield index ? '\n    ]' : ']';
  }
  yield '\n  }\n}\n';
}
