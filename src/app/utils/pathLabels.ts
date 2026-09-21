import { t } from '../i18n';

/**
 * 规范化路径用于相等性比较，处理：
 * - 反斜杠统一为斜杠
 * - 去除末尾斜杠/多余斜杠
 * - 大小写不敏感（Windows/macOS 文件系统）
 * - Unicode NFC 规范化（macOS 文件系统使用 NFD）
 */
function normalizePathForComparison(path: string) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase().normalize('NFC');
}

/** 比较两个原生文件路径是否指向同一文件 */
export function sameNativePath(left: string, right: string) {
  return normalizePathForComparison(left) === normalizePathForComparison(right);
}

/** Resolve a local Markdown asset source relative to its document. */
export function resolveDocumentAssetPath(documentPath: string, source: string): string | null {
  let raw = source.trim();
  if (!raw) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // Keep malformed percent sequences literal; Git will validate the path.
  }

  // A Windows drive or UNC path contains a colon/backslashes that otherwise
  // look like a URI scheme. Recognize it before filtering remote resources.
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
  if (raw.startsWith('/')) return raw;

  const separatorIndex = Math.max(documentPath.lastIndexOf('/'), documentPath.lastIndexOf('\\'));
  if (separatorIndex < 0) return raw.replace(/\\/g, '/');
  return `${documentPath.slice(0, separatorIndex)}/${raw}`.replace(/\\/g, '/');
}

/** 检查 path 是否等于 ancestorPath 或是其子孙路径 */
export function pathEqualsOrDescendsFrom(path: string, ancestorPath: string) {
  const nPath = normalizePathForComparison(path);
  const nAncestor = normalizePathForComparison(ancestorPath);
  return nPath === nAncestor || nPath.startsWith(nAncestor + '/');
}

export function getFolderName(path: string) {
  if (!path || path === t.currentFolder()) {
    return t.currentFolder();
  }

  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const lastPart = parts[parts.length - 1] || path;

  if (lastPart.endsWith(':')) {
    return lastPart + '\\';
  }

  return lastPart;
}

export function getDirectoryLabel(path: string) {
  const normalizedPath = path.replace(/\//g, '\\');
  const separatorIndex = normalizedPath.lastIndexOf('\\');
  if (separatorIndex <= 0) {
    return t.currentFolder();
  }

  return normalizedPath.slice(0, separatorIndex);
}

export function getCompactPath(path: string) {
  const normalizedPath = path.replace(/\//g, '\\');
  const parts = normalizedPath.split('\\').filter(Boolean);

  if (parts.length <= 3) {
    return normalizedPath;
  }

  return `...\\${parts.slice(-3).join('\\')}`;
}
