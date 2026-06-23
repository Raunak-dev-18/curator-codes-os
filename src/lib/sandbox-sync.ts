import { saveProjectFile } from './db/projects';
import { normalizeDirectoryPath, normalizeProjectPath } from './project-paths';

interface SandboxFileInfo {
  name?: string;
  isDir?: boolean;
  size?: number;
}

interface SandboxLike {
  fs: {
    listFiles(path: string): Promise<SandboxFileInfo[]>;
    downloadFile(path: string): Promise<Buffer>;
  };
}

interface SyncSandboxFilesOptions {
  sandbox: SandboxLike;
  projectId: string;
  userId: string;
  rootPath?: string;
  maxDepth?: number;
  maxFiles?: number;
  maxFileSize?: number;
}

export interface SyncSandboxFilesResult {
  synced: number;
  skipped: number;
  errors: string[];
}

const IGNORED_NAMES = new Set([
  '.daytona',
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.mts',
  '.postcss',
  '.svg',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const TEXT_FILENAMES = new Set([
  '.gitignore',
  'README',
  'README.md',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'package.json',
  'postcss.config.js',
  'postcss.config.mjs',
  'tailwind.config.js',
  'tailwind.config.ts',
  'tsconfig.json',
]);

function joinProjectPath(base: string, name: string) {
  return base === '.' ? name : `${base}/${name}`;
}

function getExtension(path: string) {
  const name = path.split('/').pop() || path;
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index).toLowerCase();
}

function shouldSkipFile(path: string, size = 0, maxFileSize: number) {
  const name = path.split('/').pop() || path;

  if (size > maxFileSize) return true;
  if (TEXT_FILENAMES.has(name)) return false;

  return !TEXT_EXTENSIONS.has(getExtension(path));
}

export async function syncSandboxFilesToProject({
  sandbox,
  projectId,
  userId,
  rootPath = '.',
  maxDepth = 8,
  maxFiles = 120,
  maxFileSize = 250_000,
}: SyncSandboxFilesOptions): Promise<SyncSandboxFilesResult> {
  const result: SyncSandboxFilesResult = { synced: 0, skipped: 0, errors: [] };
  const normalizedRoot = normalizeDirectoryPath(rootPath);

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth || result.synced >= maxFiles) return;

    let entries: SandboxFileInfo[];
    try {
      entries = await sandbox.fs.listFiles(directory);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown list error';
      result.errors.push(`${directory}: ${message}`);
      return;
    }

    for (const entry of entries) {
      if (result.synced >= maxFiles) return;
      if (!entry.name || IGNORED_NAMES.has(entry.name)) {
        result.skipped += 1;
        continue;
      }

      const path = joinProjectPath(directory, entry.name);

      if (entry.isDir) {
        await walk(path, depth + 1);
        continue;
      }

      if (shouldSkipFile(path, entry.size, maxFileSize)) {
        result.skipped += 1;
        continue;
      }

      try {
        const cleanPath = normalizeProjectPath(path);
        const buffer = await sandbox.fs.downloadFile(cleanPath);
        await saveProjectFile(projectId, userId, cleanPath, buffer.toString('utf8'));
        result.synced += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown sync error';
        result.errors.push(`${path}: ${message}`);
      }
    }
  }

  await walk(normalizedRoot, 0);
  return result;
}
