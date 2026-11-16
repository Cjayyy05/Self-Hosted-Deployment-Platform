import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const manifestPath = 'dist/phase1-final-release.json';
const entrypoint = 'dist/server.js';
const installedTrustPath = '/etc/deployflow/backend-release-digests';
const required = [
  entrypoint,
  'dist/services/application-routing.service.js',
  'dist/services/backend-mode.service.js',
  'dist/services/project-approval.service.js',
  'dist/services/public-hosting-safety.service.js',
  'dist/services/build-network.service.js',
  'dist/services/public-ingress.service.js',
  'dist/utils/linux-boot.js',
];

/** @param {string} root @param {string} dirname @returns {Promise<string[]>} */
async function builtFiles(root, dirname) {
  const files = [];
  for (const entry of await readdir(join(root, dirname), { withFileTypes: true })) {
    const path = dirname + '/' + entry.name;
    if (entry.isDirectory()) files.push(...await builtFiles(root, path));
    else if (entry.isFile() || (dirname.startsWith('node_modules') && entry.isSymbolicLink())) files.push(path);
    else throw new Error('Release artifacts must be ordinary files');
  }
  return files;
}

/** @param {string} root */
async function snapshot(root) {
  if (!(await lstat(join(root, 'dist'))).isDirectory() || !(await lstat(join(root, 'node_modules'))).isDirectory()) {
    throw new Error('Release build and dependency directories must reside inside the release');
  }
  const files = (await builtFiles(root, 'dist')).filter((path) => path !== manifestPath);
  if (required.some((path) => !files.includes(path))) throw new Error('Incomplete Phase 1 backend release');
  files.push('package.json', 'package-lock.json');
  files.push(...await builtFiles(root, 'node_modules'));
  /** @type {Record<string, string>} */
  const digests = {};
  for (const path of files.sort()) {
    const file = join(root, path);
    const details = await lstat(file);
    if (details.isSymbolicLink()) {
      const link = await readlink(file);
      const destination = relative(join(root, 'node_modules'), await realpath(file));
      if (!path.startsWith('node_modules/') || isAbsolute(link) || isAbsolute(destination) || destination.startsWith('..')) {
        throw new Error('Release dependency symlink escapes the hashed dependency tree');
      }
      digests[path] = 'link:' + link;
    } else {
      digests[path] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }
  return {
    version: 'deployflow-phase1-verified-cutover',
    entrypoint,
    files: digests,
  };
}

/** @param {string} path @param {string} digest */
async function requireApprovedDigest(path, digest) {
  const info = await lstat(path);
  if (!info.isFile() || (path === installedTrustPath && (info.uid !== 0 || (info.mode & 0o022) !== 0))) {
    throw new Error('The release trust file must be a protected regular file');
  }
  const approved = (await readFile(path, 'utf8')).trim().split(/\r?\n/);
  if (approved.some((entry) => !/^[a-f0-9]{64}$/.test(entry)) || !approved.includes(digest)) {
    throw new Error('Backend release digest has not been approved');
  }
}

/** @param {string | undefined} action @param {string} directory @param {string | undefined} trustPath */
async function launchRelease(action, directory, trustPath) {
  // Resolve the release symlink once. Verification and execution use that directory.
  const root = await realpath(directory);
  const manifest = join(root, manifestPath);
  const current = JSON.stringify(await snapshot(root)) + '\n';
  const digest = createHash('sha256').update(current).digest('hex');
  if (action === 'seal') {
    await writeFile(manifest, current, { encoding: 'utf8' });
    return;
  }
  if (!['digest', 'verify', 'run'].includes(action ?? '')) throw new Error('Expected seal, digest, verify, or run');
  if (current !== await readFile(manifest, 'utf8')) throw new Error('Phase 1 backend release manifest does not match');
  if (action === 'run' && process.env.NODE_ENV === 'production' && trustPath === undefined) {
    throw new Error('Production startup requires an external release trust file');
  }
  if (trustPath !== undefined) await requireApprovedDigest(trustPath, digest);
  if (action === 'digest') process.stdout.write(digest + '\n');
  if (action === 'run') {
    process.chdir(root);
    await import(pathToFileURL(join(root, entrypoint)).href);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const installed = fileURLToPath(import.meta.url) === '/usr/local/libexec/deployflow-backend-release.mjs';
  await launchRelease(process.argv[2], process.argv[3] ?? '.', installed ? installedTrustPath : process.argv[4]);
}
