import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { fetchZoteroExportItems } from './zotero';

describe('fetchZoteroExportItems', () => {
  beforeEach(() => invokeMock.mockReset());

  it('deduplicates keys and preserves Zotero item key, BibTeX key, and CSL data', async () => {
    invokeMock.mockResolvedValue([
      {
        key: 'D9PGQUM4',
        citationKey: 'gagliardi_multiconfiguration_2017',
        bibtex: '@article{gagliardi_multiconfiguration_2017,title={Test}}',
        cslItem: { id: 'http://zotero.org/users/1/items/D9PGQUM4', type: 'article-journal' },
        citationHtml: '<sup>1</sup>',
        bibliographyHtml: '<div class="csl-entry"><i>Journal</i></div>',
      },
    ]);

    const result = await fetchZoteroExportItems(['D9PGQUM4', ' D9PGQUM4 ']);

    expect(invokeMock).toHaveBeenCalledWith('zotero_export_items', {
      keys: ['D9PGQUM4'],
      citationStyle: 'numeric',
    });
    expect(result[0]).toMatchObject({
      key: 'D9PGQUM4',
      citationKey: 'gagliardi_multiconfiguration_2017',
      cslItem: { id: 'http://zotero.org/users/1/items/D9PGQUM4' },
      citationHtml: '<sup>1</sup>',
      bibliographyHtml: '<div class="csl-entry"><i>Journal</i></div>',
    });
  });

  it('chunks large export requests for the local Zotero API', async () => {
    invokeMock.mockResolvedValue([]);
    const keys = Array.from({ length: 51 }, (_, index) => `KEY${String(index).padStart(5, '0')}`);

    await fetchZoteroExportItems(keys, 'author-year');

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[0][1].keys).toHaveLength(50);
    expect(invokeMock.mock.calls[1][1].keys).toHaveLength(1);
    expect(invokeMock.mock.calls[0][1].citationStyle).toBe('author-year');
    expect(invokeMock.mock.calls[1][1].citationStyle).toBe('author-year');
  });
});
