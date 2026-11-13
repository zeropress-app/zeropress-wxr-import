import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateFilePlan, resolvePathIdentity } from './file-safety.js';
import { validateWxrBundleManifest, WXR_BUNDLE_LIMITS } from './wxr-bundle.js';

const fingerprint = (s) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
async function readRegular(file, limit) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Invalid WXR bundle file type or size');
    const chunks = []; let count = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      count += chunk.length;
      if (count > limit) throw new Error('WXR bundle file exceeds size limit');
      chunks.push(chunk);
    }
    if (fingerprint(stat) !== fingerprint(await handle.stat())) throw new Error('WXR bundle input changed during read');
    return { bytes: Buffer.concat(chunks), stat };
  } finally { await handle.close(); }
}

/** Snapshot all allowlisted inputs privately, before any output is staged. */
export async function openLocalWxrBundle(plan, { chunks = false } = {}) {
  const original = await readRegular(plan.input, WXR_BUNDLE_LIMITS.manifest);
  const manifest = validateWxrBundleManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(original.bytes)));
  const root = path.dirname(plan.input);
  const basePath = path.join(root, manifest.base.path);
  if (plan.base && path.resolve(plan.base) !== basePath) throw new Error('Bundle --base must identify the bound wxr-import-base.json');
  const partsDir = path.join(root, 'wordpress-export.parts');
  const dir = await fs.lstat(partsDir);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('WXR parts must be a regular directory');
  const entries = [manifest.base, ...manifest.parts];
  const paths = entries.map((entry) => path.join(root, entry.path));
  const identities = new Set([`${original.stat.dev}:${original.stat.ino}`]);
  // Validate each part against all output roles and the legacy protected inputs.
  for (const file of paths) {
    await validateFilePlan({ ...plan, input: file, base: file === basePath ? null : basePath });
    const identity = await resolvePathIdentity(file);
    if (identities.has(identity.inode)) throw new Error('WXR bundle inputs alias one another');
    identities.add(identity.inode);
    if (chunks) {
      const outParts = path.join(path.dirname(plan.output), path.basename(plan.output).replace(/(?:\.manifest)?\.json$/, '') + '.parts');
      const target = await resolvePathIdentity(outParts);
      for (const [parent, child] of [[target.canonicalPath, identity.canonicalPath], [identity.canonicalPath, target.canonicalPath]]) {
        const rel = path.relative(parent, child);
        if (rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))) throw new Error('WXR bundle collides with output parts');
      }
    }
  }
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'zeropress-wxr-bundle-'));
  const snapshots = new Map(); const stats = new Map();
  try {
    for (const [index, entry] of entries.entries()) {
      const input = paths[index];
      const { bytes, stat } = await readRegular(input, entry.bytes);
      if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('WXR bundle file checksum/size mismatch');
      const dest = path.join(scratch, String(index));
      await fs.writeFile(dest, bytes, { flag: 'wx', mode: 0o600 });
      snapshots.set(entry.path, dest); stats.set(input, fingerprint(stat));
    }
    return {
      manifest,
      openFile(relative) {
        if (!snapshots.has(relative)) throw new Error('Unlisted WXR bundle input');
        return createReadStream(snapshots.get(relative));
      },
      async assertCurrent() {
        const now = await readRegular(plan.input, WXR_BUNDLE_LIMITS.manifest);
        if (!now.bytes.equals(original.bytes) || fingerprint(now.stat) !== fingerprint(original.stat)) throw new Error('WXR bundle manifest changed; retry import');
        const currentDir = await fs.lstat(partsDir);
        if (currentDir.isSymbolicLink() || currentDir.ino !== dir.ino || currentDir.dev !== dir.dev) throw new Error('WXR parts directory changed; retry import');
        for (const [file, before] of stats) {
          const after = await fs.lstat(file);
          if (after.isSymbolicLink() || fingerprint(after) !== before) throw new Error('WXR bundle source changed; retry import');
        }
      },
      async close() { await fs.rm(scratch, { recursive: true, force: true }); },
    };
  } catch (error) { await fs.rm(scratch, { recursive: true, force: true }); throw error; }
}
