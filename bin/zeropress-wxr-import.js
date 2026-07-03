#!/usr/bin/env node
import { run } from '../src/index.js';
import { createColor } from '../src/color.js';
import { toTerminalSafeText } from '../src/terminal.js';

run(process.argv.slice(2))
  .then((code) => {
    if (Number.isInteger(code)) {
      process.exitCode = code;
    }
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(colorizeError(`[zeropress-wxr-import] ${toTerminalSafeText(message)}`));
    process.exitCode = 1;
  });

function colorizeError(message) {
  const color = createColor(process.stderr);

  return message
    .replace(/^(\[zeropress-wxr-import\].*)/m, (_, value) => color.red(value))
    .replace(/\bERROR\b/g, (value) => color.red(value))
    .replace(/\bWARN\b/g, (value) => color.yellow(value))
    .replace(/\bHint:/g, (value) => color.bold(value));
}
