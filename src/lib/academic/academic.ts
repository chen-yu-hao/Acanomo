import type { Node as ProseMirrorNode } from 'prosemirror-model';

export type EquationNumberingMode = 'auto' | 'section' | 'manual';
export type CitationStyle = 'numeric' | 'author-year';

export interface AcademicDocumentSettings {
  equationNumbering: EquationNumberingMode;
  citationStyle: CitationStyle;
}

export const DEFAULT_ACADEMIC_SETTINGS: AcademicDocumentSettings = {
  equationNumbering: 'auto',
  citationStyle: 'numeric',
};

export interface EquationMetadata {
  tex: string;
  renderTex: string;
  label: string | null;
  manualNumber: string | null;
}

export interface EquationEntry extends EquationMetadata {
  pos: number;
  block: boolean;
  number: string | null;
  section: string | null;
  id: string | null;
}

export interface AcademicIndex {
  equations: EquationEntry[];
  equationsByLabel: Map<string, EquationEntry>;
  citationOrder: string[];
}

const indexCache = new WeakMap<ProseMirrorNode, Map<EquationNumberingMode, AcademicIndex>>();

export interface ZoteroCreator {
  name?: string;
  firstName?: string;
  lastName?: string;
  creatorType?: string;
}

export interface ZoteroItem {
  key: string;
  version?: number;
  title?: string;
  date?: string;
  itemType?: string;
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  DOI?: string;
  url?: string;
  creators?: ZoteroCreator[];
  citation?: string;
}

export function parseEquationMetadata(tex: string): EquationMetadata {
  const labelMatch = /\\label\{([^{}]+)\}/.exec(tex);
  const tagMatches = [...tex.matchAll(/\\tag\*?\{([^{}]+)\}/g)];
  const manualNumber = tagMatches.length > 0 ? tagMatches[tagMatches.length - 1][1].trim() : null;
  const renderTex = tex
    .replace(/\\label\{[^{}]+\}/g, '')
    .replace(/\\tag\*?\{[^{}]+\}/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return {
    tex,
    renderTex,
    label: labelMatch?.[1].trim() || null,
    manualNumber,
  };
}

export function parseCitationKeys(value: string): string[] {
  const keys: string[] = [];
  for (const match of value.matchAll(/@([A-Za-z0-9][A-Za-z0-9_-]*)/g)) {
    const key = match[1];
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function serializeCitationKeys(keys: readonly string[]): string {
  return `[@${keys.join('; @')}]`;
}

export function parseAcademicSettings(frontMatter: string): AcademicDocumentSettings {
  const settings = { ...DEFAULT_ACADEMIC_SETTINGS };
  const equationMatch = /^(?:equation[-_]numbering|equationNumbering):\s*([^\s#]+)/im.exec(
    frontMatter,
  );
  const styleMatch = /^(?:citation[-_]style|citationStyle):\s*([^\s#]+)/im.exec(frontMatter);
  if (
    equationMatch?.[1] === 'auto' ||
    equationMatch?.[1] === 'section' ||
    equationMatch?.[1] === 'manual'
  ) {
    settings.equationNumbering = equationMatch[1];
  }
  if (styleMatch?.[1] === 'numeric' || styleMatch?.[1] === 'author-year') {
    settings.citationStyle = styleMatch[1];
  }
  return settings;
}

export function upsertAcademicSettings(
  frontMatter: string,
  next: Partial<AcademicDocumentSettings>,
): string {
  const current = parseAcademicSettings(frontMatter);
  const settings = { ...current, ...next };
  const lines = frontMatter ? frontMatter.replace(/\r\n/g, '\n').split('\n') : ['---', '---'];
  if (lines[0] !== '---') lines.unshift('---');
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  if (end < 0) lines.push('---');
  const replaceOrAdd = (key: string, value: string) => {
    const aliases =
      key === 'equation-numbering'
        ? /^(?:equation[-_]numbering|equationNumbering):\s*.*$/i
        : /^(?:citation[-_]style|citationStyle):\s*.*$/i;
    const close = lines.findIndex((line, index) => index > 0 && line === '---');
    const index = lines.findIndex(
      (line, lineIndex) => lineIndex > 0 && lineIndex < close && aliases.test(line),
    );
    if (index >= 0) lines[index] = `${key}: ${value}`;
    else lines.splice(close, 0, `${key}: ${value}`);
  };
  replaceOrAdd('equation-numbering', settings.equationNumbering);
  replaceOrAdd('citation-style', settings.citationStyle);
  return `${lines.join('\n').replace(/\n*$/, '')}\n`;
}

export function buildAcademicIndex(
  doc: ProseMirrorNode,
  settings: AcademicDocumentSettings = DEFAULT_ACADEMIC_SETTINGS,
): AcademicIndex {
  const cached = indexCache.get(doc)?.get(settings.equationNumbering);
  if (cached) return cached;
  const equations: EquationEntry[] = [];
  const equationsByLabel = new Map<string, EquationEntry>();
  const citationOrder: string[] = [];
  const sectionCounters: number[] = [];
  const sectionEquationCounts = new Map<string, number>();
  let globalNumber = 0;
  let currentSection: string | null = null;

  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const level = Math.max(1, Number(node.attrs.level) || 1);
      for (let index = 0; index < level - 1; index += 1) {
        if (!sectionCounters[index]) sectionCounters[index] = 1;
      }
      sectionCounters.length = level;
      sectionCounters[level - 1] = (sectionCounters[level - 1] ?? 0) + 1;
      currentSection = sectionCounters.join('.');
      return true;
    }
    if (node.type.name === 'math_block' || node.type.name === 'math_inline') {
      const metadata = parseEquationMetadata(String(node.attrs.tex ?? ''));
      const isBlock = node.type.name === 'math_block';
      if (isBlock && !metadata.manualNumber) globalNumber += 1;
      let number: string | null = metadata.manualNumber;
      if (!number && isBlock && settings.equationNumbering !== 'manual') {
        if (settings.equationNumbering === 'section' && currentSection) {
          const sectionNumber = (sectionEquationCounts.get(currentSection) ?? 0) + 1;
          sectionEquationCounts.set(currentSection, sectionNumber);
          number = `${currentSection}.${sectionNumber}`;
        } else {
          number = String(globalNumber);
        }
      }
      const entry: EquationEntry = {
        ...metadata,
        pos,
        block: isBlock,
        number: isBlock ? number : null,
        section: currentSection,
        id: metadata.label ? `eq-${metadata.label}` : null,
      };
      equations.push(entry);
      if (metadata.label && !equationsByLabel.has(metadata.label))
        equationsByLabel.set(metadata.label, entry);
      return false;
    }
    if (node.type.name === 'citation') {
      for (const key of node.attrs.keys ?? [])
        if (!citationOrder.includes(key)) citationOrder.push(key);
      return false;
    }
    return true;
  });

  const index = { equations, equationsByLabel, citationOrder };
  const modes = indexCache.get(doc) ?? new Map<EquationNumberingMode, AcademicIndex>();
  modes.set(settings.equationNumbering, index);
  indexCache.set(doc, modes);
  return index;
}

export function formatCitation(
  item: ZoteroItem | undefined,
  style: CitationStyle,
  number?: number,
): string {
  if (!item) return '?';
  if (style === 'numeric') return String(number ?? '?');
  const authors = formatAuthorShort(item.creators ?? []);
  return `${authors}, ${item.date?.slice(0, 4) ?? 'n.d.'}`;
}

export function formatBibliography(item: ZoteroItem | undefined, style: CitationStyle): string {
  if (!item) return '[unresolved reference]';
  const authors = formatAuthors(item.creators ?? []);
  const year = item.date?.slice(0, 4) ?? 'n.d.';
  const title = item.title ?? item.key;
  const venue = item.publicationTitle ?? '';
  const journal = venue
    ? `${venue}${item.volume ? ` ${item.volume}` : ''}${item.issue ? `(${item.issue})` : ''}${item.pages ? `, ${item.pages}` : ''}`
    : '';
  const suffix = item.DOI ? ` https://doi.org/${item.DOI}` : item.url ? ` ${item.url}` : '';
  if (style === 'numeric')
    return `${authors ? `${authors}. ` : ''}${title}.${journal ? ` ${journal}.` : ''}${suffix}`.trim();
  return `${authors ? `${authors} ` : ''}(${year}). ${title}.${journal ? ` ${journal}.` : ''}${suffix}`.trim();
}

export function bibliographyOrder(
  keys: readonly string[],
  items: ReadonlyMap<string, ZoteroItem>,
  style: CitationStyle,
): string[] {
  if (style === 'numeric') return [...keys];
  const sortKey = (key: string) => {
    const item = items.get(key);
    if (!item) return `\uffff${key}`;
    const author = item.creators?.find(
      (creator) => !creator.creatorType || creator.creatorType === 'author',
    );
    return `${author?.lastName ?? author?.name ?? item.title ?? key}\0${item.date?.slice(0, 4) ?? ''}\0${item.title ?? ''}`;
  };
  return [...keys].sort((left, right) =>
    sortKey(left).localeCompare(sortKey(right), 'en', { sensitivity: 'base' }),
  );
}

function formatAuthors(creators: ZoteroCreator[]): string {
  const authors = creators.filter(
    (creator) => !creator.creatorType || creator.creatorType === 'author',
  );
  return authors
    .map((creator) =>
      (
        creator.name ??
        `${creator.lastName ?? ''}${creator.firstName ? `, ${creator.firstName}` : ''}`
      ).trim(),
    )
    .filter(Boolean)
    .join(', ');
}

function formatAuthorShort(creators: ZoteroCreator[]): string {
  const authors = creators.filter(
    (creator) => !creator.creatorType || creator.creatorType === 'author',
  );
  if (!authors.length) return 'Unknown';
  const name = (creator: ZoteroCreator) =>
    creator.name ?? creator.lastName ?? creator.firstName ?? 'Unknown';
  if (authors.length === 1) return name(authors[0]);
  if (authors.length === 2) return `${name(authors[0])} & ${name(authors[1])}`;
  return `${name(authors[0])} et al.`;
}
