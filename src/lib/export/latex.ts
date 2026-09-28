import type { Mark, Node as ProseMirrorNode } from 'prosemirror-model';
import { parseAcademicSettings, type CitationStyle } from '../academic/academic';
import { parseMarkdown } from '../editor-core/markdown';
import { extractFrontMatterBlock } from '../markdown/frontMatter';
import type { ExportTemplateId } from './exportTemplates';

export interface ZoteroBibtexEntry {
  /** Zotero's stable, eight-character item key. */
  itemKey: string;
  /** The key declared after `@type{` in Zotero's BibTeX export. */
  citationKey: string;
  bibtex: string;
}

export interface LatexExportOptions {
  markdown: string;
  title?: string;
  author?: string;
  bibliographyName?: string;
  /** Absolute directory containing the source Markdown document. */
  sourceDirectory?: string | null;
  zoteroEntries?: readonly ZoteroBibtexEntry[];
  /** Journal-oriented preamble and bibliography preset. */
  template?: ExportTemplateId;
}

export interface LatexExportBundle {
  texContent: string;
  bibContent: string;
  bibliographyName: string;
  zoteroItemKeys: string[];
  citationKeys: string[];
  unresolvedItemKeys: string[];
  warnings: string[];
}

interface RenderContext {
  bibliographyName: string;
  bibliographyRendered: boolean;
  citationStyle: CitationStyle;
  citekeysByItemKey: ReadonlyMap<string, string>;
  footnotes: ReadonlyMap<string, ProseMirrorNode>;
  sourceDirectory: string | null;
  unresolvedItemKeys: Set<string>;
  warnings: string[];
  template: ExportTemplateId;
}

const ZOTERO_ITEM_KEY_RE = /^[A-Z0-9]{8}$/;
const SAFE_BIBTEX_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/;

export function collectZoteroItemKeys(markdown: string): string[] {
  const doc = parseMarkdown(markdown);
  const keys: string[] = [];
  doc.descendants((node) => {
    if (node.type.name !== 'citation') return true;
    for (const key of (node.attrs.keys as string[] | undefined) ?? []) {
      if (!keys.includes(key)) keys.push(key);
    }
    return false;
  });
  return keys;
}

export function isZoteroItemKey(value: string): boolean {
  return ZOTERO_ITEM_KEY_RE.test(value);
}

export function sanitizeBibliographyName(value: string): string {
  const withoutExtension = value.trim().replace(/\.bib$/i, '');
  const safe = withoutExtension.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'references';
}

export function buildLatexExport(options: LatexExportOptions): LatexExportBundle {
  const doc = parseMarkdown(options.markdown);
  const frontMatter = extractFrontMatterBlock(options.markdown);
  const citationStyle = parseAcademicSettings(frontMatter?.raw ?? '').citationStyle;
  const template = options.template ?? 'nature';
  const bibliographyName = sanitizeBibliographyName(options.bibliographyName ?? 'references');
  const itemKeys = collectCitationKeys(doc);
  const warnings: string[] = [];
  const entriesByItemKey = new Map<string, ZoteroBibtexEntry>();
  const sourceEntriesByItemKey = new Map<string, ZoteroBibtexEntry>();

  for (const entry of options.zoteroEntries ?? []) {
    if (!itemKeys.includes(entry.itemKey) || sourceEntriesByItemKey.has(entry.itemKey)) continue;
    sourceEntriesByItemKey.set(entry.itemKey, entry);
  }

  const usedCitationKeys = new Set<string>();
  for (const itemKey of itemKeys) {
    const entry = sourceEntriesByItemKey.get(itemKey);
    if (!entry) continue;
    const baseKey = normalizeBibtexCitationKey(entry.citationKey, itemKey);
    const citationKey = uniqueBibtexCitationKey(baseKey, usedCitationKeys);
    const bibtex = rewriteBibtexEntryKey(entry.bibtex, citationKey);
    if (bibtex === null) {
      warnings.push(`Zotero 条目 ${itemKey} 的 BibTeX 条目头无效，无法导出该引用。`);
      continue;
    }
    if (citationKey !== entry.citationKey) {
      warnings.push(
        `Zotero 条目 ${itemKey} 的 BibTeX citekey 已改为 ${citationKey}（原值：${entry.citationKey}）。`,
      );
    }
    usedCitationKeys.add(citationKey);
    entriesByItemKey.set(itemKey, { ...entry, citationKey, bibtex });
  }

  const unresolvedItemKeys = new Set<string>();
  const footnotes = collectFootnotes(doc);
  const context: RenderContext = {
    bibliographyName,
    bibliographyRendered: false,
    citationStyle,
    citekeysByItemKey: new Map(
      [...entriesByItemKey].map(([itemKey, entry]) => [itemKey, entry.citationKey]),
    ),
    footnotes,
    sourceDirectory: options.sourceDirectory?.trim() || null,
    unresolvedItemKeys,
    warnings,
    template,
  };
  const body = renderBlocks(doc, context).trim();
  const bibliography = context.bibliographyRendered ? '' : `\n\n${renderBibliography(context)}`;
  const title = options.title?.trim() || frontMatter?.fields.title || 'Untitled Manuscript';
  const author = options.author?.trim() ?? '';
  const containsCjk = /[\u3400-\u9fff\uf900-\ufaff]/u.test(`${title}\n${author}\n${body}`);
  const texContent = `${renderPreamble(title, author, citationStyle, containsCjk, template)}\n${body}${bibliography}\n\n\\end{document}\n`;

  for (const key of unresolvedItemKeys) {
    if (!isZoteroItemKey(key)) {
      warnings.push(`引用键 ${key} 不是 Zotero item key；需要使用类似 D9PGQUM4 的 8 位键。`);
    } else {
      warnings.push(`未能从 Zotero 解析文献 ${key}，已在 LaTeX 正文中标记。`);
    }
  }

  const usedEntries = itemKeys
    .map((key) => entriesByItemKey.get(key))
    .filter((entry): entry is ZoteroBibtexEntry => Boolean(entry));
  const citationKeys = [...new Set(usedEntries.map((entry) => entry.citationKey))];
  const bibContent = usedEntries.length
    ? `${usedEntries.map((entry) => entry.bibtex.trim()).join('\n\n')}\n`
    : '';

  return {
    texContent,
    bibContent,
    bibliographyName,
    zoteroItemKeys: itemKeys,
    citationKeys,
    unresolvedItemKeys: [...unresolvedItemKeys],
    warnings,
  };
}

function normalizeBibtexCitationKey(value: string, itemKey: string): string {
  if (SAFE_BIBTEX_KEY_RE.test(value)) return value;
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._:+-]+/g, '-')
    .replace(/^[._:+-]+|[._:+-]+$/g, '');
  return normalized || `zotero-${itemKey}`;
}

function uniqueBibtexCitationKey(baseKey: string, usedKeys: ReadonlySet<string>): string {
  if (!usedKeys.has(baseKey)) return baseKey;
  let suffix = 2;
  while (usedKeys.has(`${baseKey}-${suffix}`)) suffix += 1;
  return `${baseKey}-${suffix}`;
}

function rewriteBibtexEntryKey(bibtex: string, citationKey: string): string | null {
  const header = /(^|\r?\n)([ \t]*@([A-Za-z]+)\s*[({]\s*)([^,\r\n]+?)(\s*,)/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(bibtex)) !== null) {
    const entryType = match[3].toLowerCase();
    if (entryType === 'comment' || entryType === 'preamble' || entryType === 'string') continue;
    const keyStart = match.index + match[1].length + match[2].length;
    const keyEnd = keyStart + match[4].length;
    return `${bibtex.slice(0, keyStart)}${citationKey}${bibtex.slice(keyEnd)}`;
  }
  return null;
}

function collectCitationKeys(doc: ProseMirrorNode): string[] {
  const keys: string[] = [];
  doc.descendants((node) => {
    if (node.type.name !== 'citation') return true;
    for (const key of (node.attrs.keys as string[] | undefined) ?? []) {
      if (!keys.includes(key)) keys.push(key);
    }
    return false;
  });
  return keys;
}

function collectFootnotes(doc: ProseMirrorNode): Map<string, ProseMirrorNode> {
  const footnotes = new Map<string, ProseMirrorNode>();
  doc.descendants((node) => {
    if (node.type.name === 'footnote_def') {
      footnotes.set(String(node.attrs.id ?? ''), node);
      return false;
    }
    return true;
  });
  return footnotes;
}

function renderPreamble(
  title: string,
  author: string,
  citationStyle: CitationStyle,
  containsCjk: boolean,
  template: ExportTemplateId,
): string {
  const natbibOptions =
    citationStyle === 'author-year' ? 'authoryear,round' : 'numbers,super,sort&compress';
  const isAcs = template === 'acs';
  const documentClass = isAcs
    ? '\\IfFileExists{achemso.cls}{\\documentclass[journal=jacsat,manuscript=article]{achemso}}{\\documentclass[12pt,a4paper]{article}}'
    : '\\documentclass[12pt,a4paper]{article}';
  const templateComment = isAcs
    ? '% ACS preset: use achemso when installed; otherwise keep a portable article fallback.\n'
    : '% Nature preset: portable article manuscript layout with Nature-compatible bibliography fallback.\n';
  const geometry = isAcs
    ? '\\IfFileExists{achemso.cls}{}{\\usepackage[a4paper,top=25mm,bottom=25mm,left=25mm,right=25mm]{geometry}}'
    : '\\usepackage[a4paper,top=25mm,bottom=25mm,left=25mm,right=25mm]{geometry}';
  const natbib = `\\IfFileExists{achemso.cls}{}{\\usepackage[${natbibOptions}]{natbib}}`;
  const optionalCjk = containsCjk
    ? '\n% Prefer XeLaTeX or LuaLaTeX for CJK manuscripts.\n\\IfFileExists{ctex.sty}{\\usepackage[UTF8,scheme=plain]{ctex}}{}'
    : '';
  return `${templateComment}${documentClass}
\\usepackage{iftex}
\\ifPDFTeX
  \\usepackage[T1]{fontenc}
  \\usepackage[utf8]{inputenc}
  \\IfFileExists{newtxtext.sty}{\\usepackage{newtxtext}\\usepackage{newtxmath}}{\\usepackage{mathptmx}}
\\else
  \\usepackage{fontspec}
  \\IfFontExistsTF{Times New Roman}{\\setmainfont{Times New Roman}}{\\setmainfont{TeX Gyre Termes}}
  \\IfFileExists{unicode-math.sty}{
    \\usepackage{unicode-math}
    \\IfFontExistsTF{TeX Gyre Termes Math}{\\setmathfont{TeX Gyre Termes Math}}{}
  }{}
\\fi${optionalCjk}
${geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs,tabularx,array}
\\usepackage[normalem]{ulem}
\\usepackage{xcolor}
\\usepackage{float}
${natbib}
\\usepackage[hidelinks]{hyperref}
\\usepackage{xurl}
\\IfFileExists{microtype.sty}{\\usepackage{microtype}}{}
\\IfFileExists{setspace.sty}{\\usepackage{setspace}}{}
\\IfFileExists{lineno.sty}{\\usepackage{lineno}}{}

\\setlength{\\parindent}{1.5em}
\\setlength{\\parskip}{0pt}
\\IfFileExists{setspace.sty}{\\doublespacing}{\\linespread{2}}
\\setlength{\\textfloatsep}{16pt plus 3pt minus 3pt}
\\setlength{\\floatsep}{14pt plus 3pt minus 3pt}
\\renewcommand{\\topfraction}{0.95}
\\renewcommand{\\bottomfraction}{0.95}
\\renewcommand{\\textfraction}{0.06}
\\renewcommand{\\floatpagefraction}{0.80}
\\makeatletter
\\setlength{\\@fptop}{0pt}
\\setlength{\\@fpsep}{14pt}
\\setlength{\\@fpbot}{0pt plus 1fil}
\\makeatother
\\emergencystretch=2em
\\urlstyle{same}

\\title{${escapeLatex(title)}}
\\author{${escapeLatex(author)}}
\\date{}

\\begin{document}
\\IfFileExists{lineno.sty}{\\linenumbers}{}
\\maketitle`;
}

function renderBlocks(parent: ProseMirrorNode, context: RenderContext): string {
  const blocks: string[] = [];
  parent.forEach((node) => {
    const rendered = renderBlock(node, context);
    if (rendered.trim()) blocks.push(rendered.trimEnd());
  });
  return blocks.join('\n\n');
}

function renderBlock(node: ProseMirrorNode, context: RenderContext): string {
  switch (node.type.name) {
    case 'paragraph':
      if (node.childCount === 1 && node.firstChild?.type.name === 'image') {
        return renderImage(node.firstChild, context, true);
      }
      return renderInlineContent(node, context);
    case 'heading':
      return renderHeading(node, context);
    case 'blockquote':
      return `\\begin{quote}\n${renderBlocks(node, context)}\n\\end{quote}`;
    case 'bullet_list':
      return renderList(node, context, 'itemize');
    case 'ordered_list':
      return renderList(node, context, 'enumerate');
    case 'code_block':
      return renderVerbatim(String(node.textContent ?? ''), context);
    case 'horizontal_rule':
      return '\\noindent\\rule{\\linewidth}{0.4pt}';
    case 'math_block':
      return renderDisplayMath(String(node.attrs.tex ?? ''));
    case 'table':
      return renderTable(node, context);
    case 'bibliography_block':
      if (context.bibliographyRendered) {
        context.warnings.push('检测到多个参考文献占位符，仅使用第一个。');
        return '';
      }
      context.bibliographyRendered = true;
      return renderBibliography(context);
    case 'footnote_def':
    case 'comment_block':
      return '';
    case 'toc_block':
      return '\\tableofcontents';
    case 'mermaid_block':
      context.warnings.push('Mermaid 图未转换为矢量图，已作为源代码附在 LaTeX 中。');
      return `\\textbf{Mermaid source}\n\n${renderVerbatim(String(node.attrs.code ?? ''), context)}`;
    case 'callout':
      return `\\begin{quote}\n\\textbf{${escapeLatex(String(node.attrs.type ?? 'note').toUpperCase())}}\\quad ${renderBlocks(node, context)}\n\\end{quote}`;
    case 'html_block':
      return renderInlineContent(node, context);
    default:
      if (node.isInline) return renderInlineNode(node, context);
      if (node.childCount > 0) return renderBlocks(node, context);
      return '';
  }
}

function renderHeading(node: ProseMirrorNode, context: RenderContext): string {
  const title = renderInlineContent(node, context);
  const level = Math.max(1, Math.min(6, Number(node.attrs.level) || 1));
  const commands = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'];
  if (level <= commands.length) return `\\${commands[level - 1]}{${title}}`;
  return `\\textbf{${title}}`;
}

function renderList(
  node: ProseMirrorNode,
  context: RenderContext,
  environment: 'itemize' | 'enumerate',
): string {
  const items: string[] = [];
  node.forEach((item) => {
    const parts: string[] = [];
    item.forEach((child) => {
      const rendered = renderBlock(child, context).trim();
      if (rendered) parts.push(rendered);
    });
    items.push(`\\item ${parts.join('\n')}`);
  });
  return `\\begin{${environment}}\n${items.join('\n')}\n\\end{${environment}}`;
}

function renderInlineContent(node: ProseMirrorNode, context: RenderContext): string {
  const parts: string[] = [];
  node.forEach((child) => parts.push(renderInlineNode(child, context)));
  return parts.join('');
}

function renderInlineNode(node: ProseMirrorNode, context: RenderContext): string {
  if (node.isText) return applyMarks(escapeLatex(node.text ?? ''), node.marks);
  switch (node.type.name) {
    case 'hard_break':
      return node.attrs.soft ? '\n' : '\\\\\n';
    case 'math_inline':
      return `$${String(node.attrs.tex ?? '')}$`;
    case 'citation':
      return renderCitation((node.attrs.keys as string[] | undefined) ?? [], context);
    case 'equation_ref':
      return `\\eqref{${sanitizeLatexLabel(String(node.attrs.label ?? ''))}}`;
    case 'image':
      return renderImage(node, context, false);
    case 'footnote_ref': {
      const id = String(node.attrs.id ?? '');
      const definition = context.footnotes.get(id);
      if (!definition) {
        context.warnings.push(`脚注 ${id} 没有定义。`);
        return `\\textsuperscript{${escapeLatex(id)}}`;
      }
      return `\\footnote{${renderInlineContent(definition, context)}}`;
    }
    case 'comment_inline':
      return '';
    default:
      return node.childCount > 0 ? renderInlineContent(node, context) : '';
  }
}

function applyMarks(content: string, marks: readonly Mark[]): string {
  let result = content;
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const mark = marks[index];
    switch (mark.type.name) {
      case 'strong':
        result = `\\textbf{${result}}`;
        break;
      case 'em':
        result = `\\emph{${result}}`;
        break;
      case 'code':
        result = `\\texttt{${result}}`;
        break;
      case 'strikethrough':
        result = `\\sout{${result}}`;
        break;
      case 'underline':
        result = `\\underline{${result}}`;
        break;
      case 'highlight':
        result = `\\colorbox{yellow}{${result}}`;
        break;
      case 'link':
        result = `\\href{${escapeLatexUrl(String(mark.attrs.href ?? ''))}}{${result}}`;
        break;
    }
  }
  return result;
}

function renderCitation(keys: readonly string[], context: RenderContext): string {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const key of keys) {
    const citekey = context.citekeysByItemKey.get(key);
    if (citekey) resolved.push(citekey);
    else {
      unresolved.push(key);
      context.unresolvedItemKeys.add(key);
    }
  }
  const citation = resolved.length ? `\\citep{${[...new Set(resolved)].join(',')}}` : '';
  const missing = unresolved.length
    ? `\\textbf{[Unresolved Zotero item${unresolved.length > 1 ? 's' : ''}: \\texttt{${unresolved.map(escapeLatex).join(', ')}}]}`
    : '';
  return `${citation}${missing}`;
}

function renderDisplayMath(tex: string): string {
  const trimmed = tex.trim();
  if (/^\\begin\{(?:align\*?|gather\*?|multline\*?|equation\*?)\}/.test(trimmed)) {
    return trimmed;
  }
  return `\\begin{equation}\n${trimmed}\n\\end{equation}`;
}

function renderImage(node: ProseMirrorNode, context: RenderContext, block: boolean): string {
  const src = String(node.attrs.src ?? '').trim();
  const alt = String(node.attrs.alt ?? node.attrs.title ?? '').trim();
  if (!src) return '';
  if (/^(?:https?:|data:|blob:)/i.test(src)) {
    context.warnings.push(`LaTeX 无法直接嵌入远程或内存图片：${src}`);
    return `\\href{${escapeLatexUrl(src)}}{${escapeLatex(alt || src)}}`;
  }
  const normalizedSource = normalizeLocalPath(src.replace(/[{}]/g, ''));
  let normalizedPath = normalizedSource;
  if (!isAbsoluteLocalPath(normalizedSource)) {
    if (context.sourceDirectory) {
      const sourceDirectory = normalizeLocalPath(context.sourceDirectory.replace(/[{}]/g, ''));
      if (isAbsoluteLocalPath(sourceDirectory)) {
        normalizedPath = normalizeLocalPath(`${sourceDirectory}/${normalizedSource}`);
      } else {
        context.warnings.push(
          `LaTeX 无法解析相对图片路径 ${src}：源 Markdown 文档目录不是绝对路径。`,
        );
      }
    } else {
      context.warnings.push(`LaTeX 无法解析相对图片路径 ${src}：请先保存 Markdown 文档。`);
    }
  }
  const width = latexImageWidth(String(node.attrs.width ?? ''));
  const include = `\\includegraphics[width=${width}]{\\detokenize{${normalizedPath}}}`;
  if (!block) return include;
  const caption = alt ? `\n\\caption{${escapeLatex(alt)}}` : '';
  return `\\begin{figure}[htbp]\n\\centering\n${include}${caption}\n\\end{figure}`;
}

function isAbsoluteLocalPath(value: string): boolean {
  return /^(?:[A-Za-z]:\/|\/)/.test(value);
}

function normalizeLocalPath(value: string): string {
  const path = value.replace(/\\/g, '/');
  const isUnc = path.startsWith('//');
  const drive = /^([A-Za-z]:)\//.exec(path)?.[1] ?? '';
  const isRooted = isUnc || Boolean(drive) || path.startsWith('/');
  const prefix = isUnc ? '//' : drive ? `${drive}/` : path.startsWith('/') ? '/' : '';
  const start = isUnc ? 2 : drive ? drive.length + 1 : path.startsWith('/') ? 1 : 0;
  const components: string[] = [];
  const rootDepth = isUnc ? 2 : 0;

  for (const component of path.slice(start).split('/')) {
    if (!component || component === '.') continue;
    if (component === '..') {
      if (components.length > rootDepth && components.at(-1) !== '..') components.pop();
      else if (!isRooted) components.push(component);
      continue;
    }
    components.push(component);
  }

  return `${prefix}${components.join('/')}`;
}

function latexImageWidth(value: string): string {
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(value.trim());
  if (!percent) return '0.9\\linewidth';
  const ratio = Math.max(0.05, Math.min(1, Number(percent[1]) / 100));
  return `${Number(ratio.toFixed(3))}\\linewidth`;
}

function renderTable(table: ProseMirrorNode, context: RenderContext): string {
  const rows: ProseMirrorNode[] = [];
  table.forEach((row) => rows.push(row));
  const columnCount = Math.max(1, ...rows.map((row) => row.childCount));
  const specs = Array.from({ length: columnCount }, (_, column) => {
    const align = readTableColumnAlignment(rows, column);
    if (align === 'right') return '>{\\raggedleft\\arraybackslash}X';
    if (align === 'center') return '>{\\centering\\arraybackslash}X';
    return '>{\\raggedright\\arraybackslash}X';
  }).join('');
  const renderedRows = rows.map((row, rowIndex) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(renderTableCell(cell, context)));
    while (cells.length < columnCount) cells.push('');
    return `${cells.join(' & ')} \\\\${rowIndex === 0 ? '\n\\midrule' : ''}`;
  });
  return `\\begin{table}[htbp]
\\centering
\\small
\\begin{tabularx}{\\linewidth}{${specs}}
\\toprule
${renderedRows.join('\n')}
\\bottomrule
\\end{tabularx}
\\end{table}`;
}

function renderTableCell(cell: ProseMirrorNode, context: RenderContext): string {
  const paragraphs: string[] = [];
  cell.forEach((child) => {
    if (child.type.name === 'paragraph') paragraphs.push(renderInlineContent(child, context));
    else paragraphs.push(renderBlock(child, context));
  });
  return paragraphs.join(' \\newline ');
}

function readTableColumnAlignment(
  rows: readonly ProseMirrorNode[],
  column: number,
): 'left' | 'center' | 'right' | null {
  for (const row of rows) {
    if (column >= row.childCount) continue;
    const align = row.child(column).attrs.align;
    if (align === 'left' || align === 'center' || align === 'right') return align;
  }
  return null;
}

function renderVerbatim(content: string, context: RenderContext): string {
  if (content.includes('\\end{verbatim}')) {
    context.warnings.push('代码块包含 \\end{verbatim}，已插入空格以保持 LaTeX 可编译。');
  }
  const safe = content.replace(/\\end\{verbatim\}/g, '\\end {verbatim}').replace(/\n$/, '');
  return `\\begin{verbatim}\n${safe}\n\\end{verbatim}`;
}

function renderBibliography(context: RenderContext): string {
  if (context.template === 'acs') {
    const warning =
      'ACS LaTeX 模板优先使用 achemso.bst；未安装时将回退为 unsrtnat（请安装 achemso 以获得目标期刊格式）。';
    if (!context.warnings.includes(warning)) context.warnings.push(warning);
    const style =
      '\\IfFileExists{achemso.bst}{\\bibliographystyle{achemso}}{\\bibliographystyle{unsrtnat}}';
    return `${style}\n\\bibliography{${context.bibliographyName}}`;
  }
  if (context.citationStyle === 'author-year') {
    return `\\bibliographystyle{plainnat}\n\\bibliography{${context.bibliographyName}}`;
  }
  const warning =
    'LaTeX 编译环境缺少 naturemag.bst 时将回退为 unsrtnat；请安装 Nature 样式以获得目标期刊格式。';
  if (!context.warnings.includes(warning)) context.warnings.push(warning);
  const style =
    '\\IfFileExists{naturemag.bst}{\\bibliographystyle{naturemag}}{\\bibliographystyle{unsrtnat}}';
  return `${style}\n\\bibliography{${context.bibliographyName}}`;
}

function sanitizeLatexLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9:._/-]+/g, '-');
}

export function escapeLatex(value: string): string {
  return value.replace(/[\\{}$&#_%~^]/g, (character) => {
    switch (character) {
      case '\\':
        return '\\textbackslash{}';
      case '~':
        return '\\textasciitilde{}';
      case '^':
        return '\\textasciicircum{}';
      default:
        return `\\${character}`;
    }
  });
}

function escapeLatexUrl(value: string): string {
  return value.replace(/\\/g, '/').replace(/([%#{}])/g, '\\$1');
}
