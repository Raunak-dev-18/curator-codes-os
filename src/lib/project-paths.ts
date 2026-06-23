export function normalizeProjectPath(path: string) {
  const normalized = path.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');

  if (!normalized || normalized === '.') {
    throw new Error('A file path is required.');
  }

  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error('Absolute paths are not allowed.');
  }

  if (normalized.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new Error('Path traversal is not allowed.');
  }

  return normalized;
}

export function normalizeDirectoryPath(path = '.') {
  const normalized = path.trim();

  if (!normalized || normalized === '.') {
    return '.';
  }

  return normalizeProjectPath(normalized);
}
