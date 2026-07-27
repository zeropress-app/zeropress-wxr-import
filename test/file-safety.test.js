import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanupStagedFiles,
  commitStagedFiles,
  ensureSafeDirectory,
  resolvePathIdentity,
  stageAtomicFile,
  validateFilePlan,
} from '../src/file-safety.js';

test('validateFilePlan rejects canonical, inode, and reserved report collisions', async (t) => {
  const root = await makeFixture(t);
  const realDirectory = path.join(root, 'real');
  const aliasDirectory = path.join(root, 'alias');
  await fs.mkdir(realDirectory);
  await fs.symlink(realDirectory, aliasDirectory);

  const plan = await makePlan(root);
  plan.output = plan.input;
  await assert.rejects(validateFilePlan(plan), collisionBetween('input', 'output'));

  plan.output = path.join(root, 'input-hardlink.xml');
  await fs.link(plan.input, plan.output);
  await assert.rejects(validateFilePlan(plan), collisionBetween('input', 'output'));

  await fs.unlink(plan.output);
  plan.artifactDir = realDirectory;
  plan.resolvedBaseArtifact = path.join(realDirectory, 'reserved.json');
  plan.reportArtifact = path.join(realDirectory, 'report.json');
  plan.output = path.join(aliasDirectory, 'reserved.json');
  await assert.rejects(validateFilePlan(plan), collisionBetween('resolvedBaseArtifact', 'output'));

  plan.output = plan.reportArtifact;
  await assert.rejects(validateFilePlan(plan), collisionBetween('reportArtifact', 'output'));
});

test('validateFilePlan rejects case-folded aliases and file path nesting before writes', async (t) => {
  const root = await makeFixture(t);

  if (process.platform === 'darwin') {
    const casePlan = await makePlan(root);
    casePlan.output = path.join(casePlan.artifactDir, 'WXR-IMPORT-REPORT.JSON');
    await assert.rejects(validateFilePlan(casePlan), collisionBetween('reportArtifact', 'output'));

    const unicodePlan = await makePlan(root);
    unicodePlan.reportArtifact = path.join(unicodePlan.artifactDir, 'Résumé.json');
    unicodePlan.output = path.join(unicodePlan.artifactDir, 'RE\u0301SUME\u0301.JSON');
    await assert.rejects(validateFilePlan(unicodePlan), collisionBetween('reportArtifact', 'output'));
  }

  const nestedPlan = await makePlan(root);
  nestedPlan.output = path.join(nestedPlan.resolvedBaseArtifact, 'preview-data.json');
  await assert.rejects(
    validateFilePlan(nestedPlan),
    collisionBetween('resolvedBaseArtifact', 'output'),
  );

  const directoryPlan = await makePlan(root);
  directoryPlan.output = directoryPlan.artifactDir;
  await assert.rejects(validateFilePlan(directoryPlan), { code: 'PATH_COLLISION' });
});

test('resolvePathIdentity canonicalizes a missing target through its nearest real ancestor', async (t) => {
  const root = await makeFixture(t);
  const realDirectory = path.join(root, 'real');
  const aliasDirectory = path.join(root, 'alias');
  await fs.mkdir(path.join(realDirectory, 'nested'), { recursive: true });
  await fs.symlink(realDirectory, aliasDirectory);

  const real = await resolvePathIdentity(path.join(realDirectory, 'nested', 'future.json'));
  const alias = await resolvePathIdentity(path.join(aliasDirectory, 'nested', 'future.json'));

  assert.equal(real.exists, false);
  assert.equal(alias.exists, false);
  assert.equal(alias.canonicalPath, real.canonicalPath);
});

test('validateFilePlan rejects a resolved artifact used directly or through a hard link as base', async (t) => {
  const root = await makeFixture(t);
  const plan = await makePlan(root);
  await fs.mkdir(plan.artifactDir);
  await fs.writeFile(plan.resolvedBaseArtifact, '{"site":{},"import":{}}\n');
  plan.base = plan.resolvedBaseArtifact;

  await assert.rejects(
    validateFilePlan(plan),
    collisionBetween('base', 'resolvedBaseArtifact'),
  );

  const hardLink = path.join(root, 'base-hardlink.json');
  await fs.link(plan.resolvedBaseArtifact, hardLink);
  plan.base = hardLink;
  await assert.rejects(
    validateFilePlan(plan),
    collisionBetween('base', 'resolvedBaseArtifact'),
  );
});

test('validateFilePlan accepts an omitted optional base source', async (t) => {
  const root = await makeFixture(t);
  const plan = await makePlan(root);
  plan.base = null;

  const result = await validateFilePlan(plan);
  assert.equal(result.base, null);
  assert.equal(Object.hasOwn(result.identities, 'base'), false);
});

test('artifact directories and write targets reject symbolic links without touching sentinels', async (t) => {
  const root = await makeFixture(t);
  const sentinel = path.join(root, 'sentinel.txt');
  const unsafeOutput = path.join(root, 'unsafe-output.json');
  await fs.writeFile(sentinel, 'keep me');
  await fs.symlink(sentinel, unsafeOutput);

  const plan = await makePlan(root);
  plan.output = unsafeOutput;
  await assert.rejects(validateFilePlan(plan), { code: 'UNSAFE_SYMLINK' });
  await assert.rejects(stageAtomicFile(unsafeOutput, 'replacement'), { code: 'UNSAFE_SYMLINK' });
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep me');

  const realArtifactDirectory = path.join(root, 'real-artifacts');
  await fs.mkdir(realArtifactDirectory);
  await fs.symlink(realArtifactDirectory, plan.artifactDir);
  plan.output = path.join(root, 'safe-output.json');
  await assert.rejects(validateFilePlan(plan), { code: 'UNSAFE_SYMLINK' });
  await assert.rejects(ensureSafeDirectory(plan.artifactDir), { code: 'UNSAFE_SYMLINK' });

  await fs.unlink(plan.artifactDir);
  await fs.writeFile(plan.artifactDir, 'not a directory');
  await assert.rejects(validateFilePlan(plan), { code: 'INVALID_DIRECTORY_TYPE' });

  await fs.unlink(plan.artifactDir);
  await fs.mkdir(plan.artifactDir);
  await fs.mkdir(plan.output);
  await assert.rejects(validateFilePlan(plan), { code: 'INVALID_WRITE_TARGET' });
});

test('staged files replace destinations atomically and clean temporary siblings', async (t) => {
  const root = await makeFixture(t);
  const target = path.join(root, 'result.json');
  await fs.writeFile(target, 'old');

  const stage = await stageAtomicFile(target, 'new');
  assert.equal(await fs.readFile(target, 'utf8'), 'old');
  assert.equal(await fs.readFile(stage.temporaryPath, 'utf8'), 'new');

  await commitStagedFiles([stage]);
  assert.equal(stage.state, 'committed');
  assert.equal(await fs.readFile(target, 'utf8'), 'new');
  await assert.rejects(fs.stat(stage.temporaryPath), { code: 'ENOENT' });

  const abandoned = await stageAtomicFile(target, 'abandoned');
  await cleanupStagedFiles([abandoned]);
  assert.equal(abandoned.state, 'cleaned');
  assert.equal(await fs.readFile(target, 'utf8'), 'new');
  await assert.rejects(fs.stat(abandoned.temporaryPath), { code: 'ENOENT' });
});

test('commit rejects a changed target and cleans all remaining temporary files', async (t) => {
  const root = await makeFixture(t);
  const firstTarget = path.join(root, 'schema.json');
  const secondTarget = path.join(root, 'output.json');
  await fs.writeFile(firstTarget, 'schema-old');
  await fs.writeFile(secondTarget, 'output-old');

  const first = await stageAtomicFile(firstTarget, 'schema-new');
  const second = await stageAtomicFile(secondTarget, 'output-new');
  await fs.rename(path.join(root, 'output.json'), path.join(root, 'output-old.json'));
  await fs.writeFile(secondTarget, 'external-change');

  await assert.rejects(commitStagedFiles([first, second]), { code: 'TARGET_CHANGED' });
  assert.equal(await fs.readFile(firstTarget, 'utf8'), 'schema-new');
  assert.equal(await fs.readFile(secondTarget, 'utf8'), 'external-change');
  await assert.rejects(fs.stat(first.temporaryPath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(second.temporaryPath), { code: 'ENOENT' });
});

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zeropress-file-safety-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function makePlan(root) {
  const input = path.join(root, 'input.xml');
  const base = path.join(root, 'base.json');
  const artifactDir = path.join(root, '.zeropress-wxr-import');
  await fs.writeFile(input, '<rss/>');
  await fs.writeFile(base, '{}');

  return {
    input,
    base,
    output: path.join(root, 'preview-data.json'),
    artifactDir,
    resolvedBaseArtifact: path.join(artifactDir, 'wxr-import-base.resolved.json'),
    reportArtifact: path.join(artifactDir, 'wxr-import-report.json'),
  };
}

function collisionBetween(left, right) {
  return (error) => {
    assert.equal(error?.code, 'PATH_COLLISION');
    assert.match(error.message, new RegExp(`${left} conflicts with ${right}`));
    return true;
  };
}
