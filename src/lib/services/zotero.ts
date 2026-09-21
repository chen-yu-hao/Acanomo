import type { CitationStyle, ZoteroItem } from '../academic/academic';
import { invoke } from '@tauri-apps/api/core';

export interface ZoteroStatus {
  reachable: boolean;
  baseUrl: string;
  error?: string;
}

export type ZoteroCslItem = Record<string, unknown> & { id: string };

export interface ZoteroExportItem {
  /** Zotero's stable item key, for example D9PGQUM4. */
  key: string;
  /** BibTeX's entry key, for example gagliardi_multiconfiguration_2017. */
  citationKey: string;
  bibtex: string;
  /** CSL JSON with Zotero's canonical item URI in `id`. */
  cslItem: ZoteroCslItem;
  citationHtml?: string;
  bibliographyHtml?: string;
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

export async function fetchZoteroExportItems(
  keys: readonly string[],
  citationStyle: CitationStyle = 'numeric',
): Promise<ZoteroExportItem[]> {
  const uniqueKeys = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
  if (!uniqueKeys.length) return [];
  const rows: ZoteroExportItem[] = [];
  for (let index = 0; index < uniqueKeys.length; index += 50) {
    rows.push(
      ...(await invoke<ZoteroExportItem[]>('zotero_export_items', {
        keys: uniqueKeys.slice(index, index + 50),
        citationStyle,
      })),
    );
  }
  return rows;
}
