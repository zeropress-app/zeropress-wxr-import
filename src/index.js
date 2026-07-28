import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { convertWxrToPreviewData } from './converter.js';
import { createColor } from './color.js';
import { toTerminalSafeText } from './terminal.js';
import {
  cleanupStagedFiles,
  commitStagedFiles,
  ensureSafeDirectory,
  stageAtomicFile,
  validateFilePlan,
} from './file-safety.js';

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../package.json');
const OPTION_IDENTITIES = new Map([
  ['--input', '--input'],
  ['--base', '--base'],
  ['--output', '--output'],
  ['--no-report', '--no-report'],
  ['--help', '--help'],
  ['-h', '--help'],
  ['--version', '--version'],
  ['-v', '--version'],
]);

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
  await validateFilePlan({
    input: args.input,
    base: args.base,
    output: args.output,
    artifactDir: args.artifactDir,
    resolvedBaseArtifact: args.resolvedBaseArtifact,
    reportArtifact: args.reportArtifact,
  });

  const base = args.base
    ? await readBaseJsonFile(args.base)
    : { version: '0.7' };
  const inputStream = createReadStream(args.input);
  let conversion;
  try {
    conversion = await convertWxrToPreviewData(inputStream, base, {
      packageVersion: PACKAGE_VERSION,
    });
  } catch (error) {
    inputStream.destroy();
    throw error;
  }
  const { previewData, report, base: resolvedBase } = conversion;

  await writeArtifactsAtomically({ args, previewData, report, resolvedBase });

  printWarnings(report);
  printSummary({
    output: args.output,
    resolvedBasePath: args.resolvedBaseArtifact,
    reportPath: args.writeReport ? args.reportArtifact : null,
    report,
  });
  return 0;
}

export function parseArgs(argv) {
  assertNoDuplicateOptions(argv);
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-report') {
      flags.noReport = true;
      continue;
    }
    if (arg === '--input' || arg === '--base' || arg === '--output') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Invalid arguments: ${arg} requires a value`);
      }
      flags[arg.slice(2)] = value;
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

  const artifactDir = path.join(process.cwd(), '.zeropress-wxr-import');

  return {
    input: path.resolve(process.cwd(), flags.input),
    base: flags.base ? path.resolve(process.cwd(), flags.base) : null,
    output: path.resolve(process.cwd(), flags.output),
    artifactDir,
    resolvedBaseArtifact: path.join(artifactDir, 'wxr-import-base.resolved.json'),
    // The report path stays reserved for collision checks even when the report
    // itself is not written, so it can never alias another artifact.
    reportArtifact: path.join(artifactDir, 'wxr-import-report.json'),
    writeReport: flags.noReport !== true,
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
  zeropress-wxr-import --input <file> --output <file.json> [--base <file>] [--no-report]

Required Options:
  --input <file>        WordPress WXR XML export file
  --output <file.json>  Output preview-data v0.7 JSON file

Options:
  --base <file>         Optional v0.7 JSON file containing site preset and import settings
  --no-report           Do not write .zeropress-wxr-import/wxr-import-report.json
  --help, -h            Show help
  --version, -v         Show version

Notes:
  - only published WordPress posts and pages are exported
  - WXR comment records are discarded; WordPress API runtime settings may be generated
  - site/theme-specific settings should be provided in the base file`);
}

async function readBaseJsonFile(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`base file not found: ${filePath}`);
    }
    if (error?.code === 'EISDIR') {
      throw new Error(`base path is not a file: ${filePath}`);
    }
    throw new Error(`Failed to read base file: ${filePath}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid base JSON: ${message}`);
  }
}

async function writeArtifactsAtomically({ args, previewData, report, resolvedBase }) {
  const stages = [];
  try {
    await ensureSafeDirectory(args.artifactDir);

    stages.push(await stageJsonFile(args.resolvedBaseArtifact, resolvedBase));
    if (args.writeReport) {
      stages.push(await stageJsonFile(args.reportArtifact, report));
    }
    stages.push(await stageJsonFile(args.output, previewData));

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
  return stageAtomicFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
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
    const unit = code === 'timezone_inference_ambiguous'
      ? 'offset(s)'
      : code === 'timezone_inference_skipped' || code === 'locale_inference_skipped'
        ? 'setting(s)'
        : 'item(s)';
    console.error(color.yellow(`WARN ${code}: ${count} ${unit}${affectedSummary}`));
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

function printSummary({ output, resolvedBasePath, reportPath, report }) {
  console.log(formatWxrImportSuccessMessage());
  console.log(`Output: ${toTerminalSafeText(output)}`);
  console.log(`Resolved base: ${toTerminalSafeText(resolvedBasePath)}`);
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
  if (reportPath) {
    console.log(`Report: ${toTerminalSafeText(reportPath)}`);
  }
}

function nonNegativeCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
