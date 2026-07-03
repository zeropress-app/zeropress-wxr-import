import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const REQUIRED_SOURCE_ROLES = ['input'];
const OPTIONAL_SOURCE_ROLES = ['base'];
const ARTIFACT_ROLES = ['baseArtifact', 'reportArtifact'];
const WRITE_ROLES = [...ARTIFACT_ROLES, 'output'];
const MAX_TEMP_FILE_ATTEMPTS = 16;

class FileSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FileSafetyError';
    this.code = code;
  }
}

/**
 * Resolve a path through its closest existing ancestor.
 *
 * Unlike realpath(), this also provides a stable identity for a target that
 * does not exist yet. Existing files additionally expose their device/inode
 * identity so hard-link aliases can be detected.
 */
export async function resolvePathIdentity(filePath) {
  const absolutePath = normalizePath(filePath, 'path');
  const missingSegments = [];
  let candidate = absolutePath;

  while (true) {
    let entry;
    try {
      entry = await fs.lstat(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        const parent = path.dirname(candidate);
        if (parent === candidate) {
          throw new FileSafetyError('PATH_NOT_FOUND', `No existing ancestor found for path: ${absolutePath}`);
        }
        missingSegments.unshift(path.basename(candidate));
        candidate = parent;
        continue;
      }
      if (error?.code === 'ENOTDIR') {
        throw new FileSafetyError(
          'INVALID_PATH',
          `Path has a non-directory ancestor: ${absolutePath}`,
        );
      }
      throw error;
    }

    let canonicalAncestor;
    try {
      canonicalAncestor = await fs.realpath(candidate);
    } catch (error) {
      if (entry.isSymbolicLink() && error?.code === 'ENOENT') {
        throw new FileSafetyError('DANGLING_SYMLINK', `Path contains a dangling symbolic link: ${candidate}`);
      }
      throw error;
    }

    const canonicalPath = path.join(canonicalAncestor, ...missingSegments);
    if (missingSegments.length > 0) {
      return Object.freeze({
        absolutePath,
        canonicalPath,
        exists: false,
        inode: null,
      });
    }

    const target = entry.isSymbolicLink() ? await fs.stat(candidate) : entry;
    return Object.freeze({
      absolutePath,
      canonicalPath,
      exists: true,
      inode: `${target.dev}:${target.ino}`,
    });
  }
}

/**
 * Validate every source and reserved destination before the CLI reads input.
 * reportArtifact is deliberately mandatory even when --no-report is active:
 * its path remains reserved and therefore cannot alias output or another file.
 *
 * Returns the resolved plan with the path identities the checks were based on.
 */
export async function validateFilePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new TypeError('File plan must be an object');
  }

  const sourceRoles = [
    ...REQUIRED_SOURCE_ROLES,
    ...OPTIONAL_SOURCE_ROLES.filter((role) => plan[role] !== undefined && plan[role] !== null),
  ];
  const planRoles = [...sourceRoles, ...WRITE_ROLES];
  const normalized = {};
  for (const role of planRoles) {
    normalized[role] = normalizePath(plan[role], role);
  }
  if (!sourceRoles.includes('base')) {
    normalized.base = null;
  }
  normalized.artifactDir = normalizePath(plan.artifactDir, 'artifactDir');

  await Promise.all(sourceRoles.map((role) => assertReadableRegularFile(normalized[role], role)));
  await assertSafeDirectory(normalized.artifactDir, 'artifact directory', { allowMissing: true });
  await Promise.all(WRITE_ROLES.map((role) => assertSafeWriteTarget(normalized[role], role)));

  const identities = Object.fromEntries(
    await Promise.all(
      planRoles.map(async (role) => [role, await resolvePathIdentity(normalized[role])]),
    ),
  );
  const artifactDirectoryIdentity = await resolvePathIdentity(normalized.artifactDir);
  const artifactDirectoryKey = pathCollisionKey(artifactDirectoryIdentity.canonicalPath);

  for (const role of ARTIFACT_ROLES) {
    const parentIdentity = await resolvePathIdentity(path.dirname(normalized[role]));
    if (parentIdentity.canonicalPath !== artifactDirectoryIdentity.canonicalPath) {
      throw new FileSafetyError(
        'ARTIFACT_OUTSIDE_DIRECTORY',
        `${role} must be a direct child of the artifact directory: ${normalized[role]}`,
      );
    }
  }

  for (let leftIndex = 0; leftIndex < planRoles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < planRoles.length; rightIndex += 1) {
      const leftRole = planRoles[leftIndex];
      const rightRole = planRoles[rightIndex];
      const left = identities[leftRole];
      const right = identities[rightRole];
      const leftKey = pathCollisionKey(left.canonicalPath);
      const rightKey = pathCollisionKey(right.canonicalPath);
      const sameCanonicalPath = leftKey === rightKey;
      const exactCanonicalPath = left.canonicalPath === right.canonicalPath;
      const sameInode = left.inode !== null && right.inode !== null && left.inode === right.inode;

      if (isBaseArtifactReuse(leftRole, rightRole) && exactCanonicalPath) {
        continue;
      }

      if (sameCanonicalPath || sameInode || isStrictPathAncestor(leftKey, rightKey) || isStrictPathAncestor(rightKey, leftKey)) {
        throw new FileSafetyError(
          'PATH_COLLISION',
          `Unsafe path collision: ${leftRole} conflicts with ${rightRole}`,
        );
      }
    }
  }

  if (pathCollisionKey(identities.output.canonicalPath) === artifactDirectoryKey) {
    throw new FileSafetyError(
      'PATH_COLLISION',
      'Unsafe path collision: artifactDir conflicts with output',
    );
  }

  return Object.freeze({
    ...normalized,
    identities: Object.freeze(identities),
  });
}

/**
 * Create or validate the artifact directory without accepting a symbolic-link
 * directory at the requested path.
 */
export async function ensureSafeDirectory(directoryPath) {
  const absolutePath = normalizePath(directoryPath, 'directoryPath');
  await assertSafeDirectory(absolutePath, 'directory', { allowMissing: true });

  try {
    await fs.mkdir(absolutePath, { recursive: true });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }

  await assertSafeDirectory(absolutePath, 'directory', { allowMissing: false });
  return absolutePath;
}

/**
 * Write and fsync a sibling temporary file without changing the destination.
 * The returned stage can later be committed with an atomic rename or cleaned.
 */
export async function stageAtomicFile(targetPath, data, options = {}) {
  const absoluteTargetPath = normalizePath(targetPath, 'targetPath');
  const parentPath = path.dirname(absoluteTargetPath);
  await ensureParentDirectory(parentPath);

  const targetSnapshot = await inspectWriteTarget(absoluteTargetPath, 'target');
  // Preserve an existing file's permissions across the replacement.
  const mode = targetSnapshot.mode ?? 0o666;

  let temporaryPath;
  let handle;
  for (let attempt = 0; attempt < MAX_TEMP_FILE_ATTEMPTS; attempt += 1) {
    temporaryPath = path.join(
      parentPath,
      `.${path.basename(absoluteTargetPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      handle = await fs.open(temporaryPath, 'wx', mode);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  if (!handle || !temporaryPath) {
    throw new FileSafetyError(
      'TEMP_FILE_COLLISION',
      `Unable to create an exclusive temporary file for: ${absoluteTargetPath}`,
    );
  }

  try {
    if (typeof data === 'string') {
      await handle.writeFile(data, { encoding: options.encoding ?? 'utf8' });
    } else {
      await handle.writeFile(data);
    }
    await handle.sync();
  } catch (error) {
    await closeIgnoringError(handle);
    await unlinkIgnoringMissing(temporaryPath);
    throw error;
  }

  try {
    await handle.close();
  } catch (error) {
    await unlinkIgnoringMissing(temporaryPath);
    throw error;
  }

  let state = 'staged';
  return {
    targetPath: absoluteTargetPath,
    temporaryPath,
    get state() {
      return state;
    },
    async commit() {
      if (state === 'committed') {
        return;
      }
      if (state !== 'staged') {
        throw new FileSafetyError('INVALID_STAGE_STATE', `Atomic stage is not committable: ${state}`);
      }

      const currentTarget = await inspectWriteTarget(absoluteTargetPath, 'target');
      if (!sameTargetSnapshot(targetSnapshot, currentTarget)) {
        throw new FileSafetyError(
          'TARGET_CHANGED',
          `Atomic write target changed after staging: ${absoluteTargetPath}`,
        );
      }

      await fs.rename(temporaryPath, absoluteTargetPath);
      state = 'committed';
    },
    async cleanup() {
      if (state !== 'staged') {
        return;
      }
      await unlinkIgnoringMissing(temporaryPath);
      state = 'cleaned';
    },
  };
}

/**
 * Commit stages in caller-provided order and clean every uncommitted temp file.
 * Callers can pass base/report/output order so output remains the final public
 * success marker.
 */
export async function commitStagedFiles(stages) {
  assertStages(stages);
  let commitError = null;

  try {
    for (const stage of stages) {
      await stage.commit();
    }
  } catch (error) {
    commitError = error;
  }

  let cleanupError = null;
  try {
    await cleanupStagedFiles(stages);
  } catch (error) {
    cleanupError = error;
  }

  if (commitError) {
    throw commitError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

export async function cleanupStagedFiles(stages) {
  assertStages(stages);
  const results = await Promise.allSettled(stages.map((stage) => stage.cleanup()));
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to clean one or more staged files');
  }
}

function normalizePath(filePath, label) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError(`${label} must be a non-empty path string`);
  }
  return path.resolve(filePath);
}

async function assertReadableRegularFile(filePath, role) {
  let target;
  try {
    target = await fs.stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new FileSafetyError('SOURCE_NOT_FOUND', `${role} file not found: ${filePath}`);
    }
    throw error;
  }

  if (!target.isFile()) {
    throw new FileSafetyError('INVALID_SOURCE_TYPE', `${role} path is not a regular file: ${filePath}`);
  }
}

async function assertSafeDirectory(directoryPath, label, { allowMissing }) {
  let entry;
  try {
    entry = await fs.lstat(directoryPath);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') {
      return;
    }
    if (!allowMissing && error?.code === 'ENOENT') {
      throw new FileSafetyError('DIRECTORY_NOT_FOUND', `${label} does not exist: ${directoryPath}`);
    }
    if (error?.code === 'ENOTDIR') {
      throw new FileSafetyError('INVALID_DIRECTORY_TYPE', `${label} has a non-directory ancestor: ${directoryPath}`);
    }
    throw error;
  }

  if (entry.isSymbolicLink()) {
    throw new FileSafetyError('UNSAFE_SYMLINK', `${label} must not be a symbolic link: ${directoryPath}`);
  }
  if (!entry.isDirectory()) {
    throw new FileSafetyError('INVALID_DIRECTORY_TYPE', `${label} is not a directory: ${directoryPath}`);
  }
}

async function assertSafeWriteTarget(filePath, role) {
  await inspectWriteTarget(filePath, role);
}

async function inspectWriteTarget(filePath, role) {
  let entry;
  try {
    entry = await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({ exists: false, inode: null, mode: null });
    }
    if (error?.code === 'ENOTDIR') {
      throw new FileSafetyError('INVALID_PATH', `${role} has a non-directory ancestor: ${filePath}`);
    }
    throw error;
  }

  if (entry.isSymbolicLink()) {
    throw new FileSafetyError('UNSAFE_SYMLINK', `${role} must not be a symbolic link: ${filePath}`);
  }
  if (!entry.isFile()) {
    throw new FileSafetyError('INVALID_WRITE_TARGET', `${role} is not a regular file: ${filePath}`);
  }

  return Object.freeze({
    exists: true,
    inode: `${entry.dev}:${entry.ino}`,
    mode: entry.mode & 0o7777,
  });
}

async function ensureParentDirectory(directoryPath) {
  try {
    await fs.mkdir(directoryPath, { recursive: true });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }

  let target;
  try {
    target = await fs.stat(directoryPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new FileSafetyError('DIRECTORY_NOT_FOUND', `Parent directory does not exist: ${directoryPath}`);
    }
    throw error;
  }
  if (!target.isDirectory()) {
    throw new FileSafetyError('INVALID_DIRECTORY_TYPE', `Parent path is not a directory: ${directoryPath}`);
  }
}

function sameTargetSnapshot(before, after) {
  if (before.exists !== after.exists) {
    return false;
  }
  return !before.exists || before.inode === after.inode;
}

function isBaseArtifactReuse(leftRole, rightRole) {
  return (
    (leftRole === 'base' && rightRole === 'baseArtifact')
    || (leftRole === 'baseArtifact' && rightRole === 'base')
  );
}

function pathCollisionKey(canonicalPath) {
  const normalized = path.resolve(canonicalPath);
  if (process.platform === 'darwin') {
    return normalized.normalize('NFD').toUpperCase().toLowerCase();
  }
  if (process.platform === 'win32') {
    return normalized
      .split(path.sep)
      .map((segment) => segment.replace(/[ .]+$/g, ''))
      .join(path.sep)
      .toUpperCase()
      .toLowerCase();
  }
  return normalized;
}

function isStrictPathAncestor(ancestorKey, descendantKey) {
  if (ancestorKey === descendantKey) return false;
  const prefix = ancestorKey.endsWith(path.sep) ? ancestorKey : `${ancestorKey}${path.sep}`;
  return descendantKey.startsWith(prefix);
}

function assertStages(stages) {
  if (!Array.isArray(stages)) {
    throw new TypeError('Atomic stages must be an array');
  }
  for (const stage of stages) {
    if (!stage || typeof stage.commit !== 'function' || typeof stage.cleanup !== 'function') {
      throw new TypeError('Invalid atomic stage');
    }
  }
}

async function closeIgnoringError(handle) {
  try {
    await handle.close();
  } catch {
    // The original write/sync error is more useful to the caller.
  }
}

async function unlinkIgnoringMissing(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}
