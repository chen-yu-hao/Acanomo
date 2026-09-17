import type { ZoteroItem } from '../academic/academic';
import { invoke } from '@tauri-apps/api/core';

export interface ZoteroStatus {
  reachable: boolean;
  baseUrl: string;
  error?: string;
}

const CACHE_KEY = 'nomo-zotero-metadata-v1';
let itemCache = new Map<string, ZoteroItem>();

try {
  const saved = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '[]') as ZoteroItem[];
  itemCache = new Map(saved.filter((item) => item?.key).map((item) => [item.key, item]));
} catch {
  itemCache = new Map();
}

export function getCachedZoteroItems(): ZoteroItem[] {
  return [...itemCache.values()];
}

export async function checkZotero(): Promise<ZoteroStatus> {
  const baseUrl = 'http://127.0.0.1:23119/api';
  try {
    const reachable = await invoke<boolean>('zotero_status');
    if (!reachable) throw new Error('Zotero API 未响应');
    return { reachable: true, baseUrl };
  } catch (error) {
    return {
      reachable: false,
      baseUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function fetchZoteroItems(keys: readonly string[]): Promise<ZoteroItem[]> {
  const uniqueKeys = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
  if (!uniqueKeys.length) return [];
  const rows: Array<{ key: string; version?: number; data?: ZoteroItem; citation?: string }> = [];
  for (let index = 0; index < uniqueKeys.length; index += 50) {
    rows.push(
      ...(await invoke<typeof rows>('zotero_items', {
        keys: uniqueKeys.slice(index, index + 50),
        style: 'nature',
      })),
    );
  }
  const items = rows.map((row) => ({
    ...(row.data ?? {}),
    key: row.key,
    version: row.version,
    citation: row.citation,
  }));
  for (const item of items) itemCache.set(item.key, item);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify([...itemCache.values()]));
  } catch {
    /* cache is optional */
  }
  return items;
}

export async function searchZotero(query: string): Promise<ZoteroItem[]> {
  const rows = await invoke<Array<{ key: string; version?: number; data?: ZoteroItem }>>(
    'zotero_search',
    { query },
  );
  return rows.map((row) => ({ ...(row.data ?? {}), key: row.key, version: row.version }));
}

export async function refreshZoteroItems(keys: readonly string[]): Promise<ZoteroItem[]> {
  return fetchZoteroItems(keys);
}
