import {
  buildLatexExport,
  collectZoteroItemKeys,
  isZoteroItemKey,
  type LatexExportBundle,
} from '../../lib/export/latex';
import { fetchZoteroExportItems } from '../../lib/services/zotero';
import type { ExportTemplateId } from '../../lib/export/exportTemplates';

export interface PrepareLatexExportInput {
  markdown: string;
  title?: string;
  author?: string;
  /** File stem only. The caller may derive it from the chosen `.tex` path. */
  bibliographyName?: string;
  /** Absolute directory containing the source Markdown document. */
  sourceDirectory?: string | null;
  template?: ExportTemplateId;
}

/**
 * Resolves Zotero item keys before producing the two files that the UI saves.
 * File selection and disk writes deliberately remain outside this service.
 */
export async function prepareLatexExport(
  input: PrepareLatexExportInput,
): Promise<LatexExportBundle> {
  const itemKeys = collectZoteroItemKeys(input.markdown);
  const validItemKeys = itemKeys.filter(isZoteroItemKey);
  const zoteroItems = validItemKeys.length ? await fetchZoteroExportItems(validItemKeys) : [];
  return buildLatexExport({
    ...input,
    zoteroEntries: zoteroItems.map((item) => ({
      itemKey: item.key,
      citationKey: item.citationKey,
      bibtex: item.bibtex,
    })),
    template: input.template,
  });
}
