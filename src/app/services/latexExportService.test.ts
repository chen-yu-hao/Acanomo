import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareLatexExport } from './latexExportService';
import { fetchZoteroExportItems } from '../../lib/services/zotero';

vi.mock('../../lib/services/zotero', () => ({
  fetchZoteroExportItems: vi.fn(),
}));

describe('prepareLatexExport', () => {
  beforeEach(() => vi.mocked(fetchZoteroExportItems).mockReset());

  it('resolves only valid Zotero item keys and passes true BibTeX keys to LaTeX', async () => {
    vi.mocked(fetchZoteroExportItems).mockResolvedValue([
      {
        key: 'D9PGQUM4',
        citationKey: 'gagliardi_2017',
        bibtex: '@article{gagliardi_2017,title={Test}}',
        cslItem: { id: 'http://zotero.org/users/1/items/D9PGQUM4' },
      },
    ]);

    const result = await prepareLatexExport({
      markdown: 'Valid [@D9PGQUM4], invalid [@not-a-zotero-key].',
      bibliographyName: 'article',
    });

    expect(fetchZoteroExportItems).toHaveBeenCalledWith(['D9PGQUM4']);
    expect(result.texContent).toContain('\\citep{gagliardi_2017}');
    expect(result.bibContent).toContain('@article{gagliardi_2017');
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('不是 Zotero item key')]),
    );
  });

  it('does not contact Zotero when the manuscript has no citations', async () => {
    const result = await prepareLatexExport({
      markdown: '# No citations\n\n![Figure](../figures/result.png)',
      sourceDirectory: 'C:\\Research\\drafts\\',
    });
    expect(fetchZoteroExportItems).not.toHaveBeenCalled();
    expect(result.bibContent).toBe('');
    expect(result.texContent).toContain('\\detokenize{C:/Research/figures/result.png}');
  });

  it('keeps exporting when Zotero no longer contains one cited item', async () => {
    vi.mocked(fetchZoteroExportItems).mockResolvedValue([]);

    const result = await prepareLatexExport({ markdown: 'Missing [@MRHTZ5CI].' });

    expect(result.unresolvedItemKeys).toEqual(['MRHTZ5CI']);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('未能从 Zotero 解析文献 MRHTZ5CI')]),
    );
  });
});
