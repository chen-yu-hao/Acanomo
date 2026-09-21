import { describe, expect, it } from 'vitest';
import {
  buildLatexExport,
  collectZoteroItemKeys,
  escapeLatex,
  sanitizeBibliographyName,
  type ZoteroBibtexEntry,
} from './latex';

const entries: ZoteroBibtexEntry[] = [
  {
    itemKey: 'D9PGQUM4',
    citationKey: 'gagliardi_multiconfiguration_2017',
    bibtex: '@article{gagliardi_multiconfiguration_2017,\n  title={First paper}\n}',
  },
  {
    itemKey: 'T4IQZGRM',
    citationKey: 'li_manni_multiconfiguration_2014',
    bibtex: '@article{li_manni_multiconfiguration_2014,\n  title={Second paper}\n}',
  },
];

describe('LaTeX export', () => {
  it('maps Zotero item keys to real BibTeX citekeys and exports only cited entries', () => {
    const result = buildLatexExport({
      markdown: [
        '---',
        'title: Pair-density study',
        'citation-style: numeric',
        '---',
        '',
        '# Results',
        '',
        'Prior work [@D9PGQUM4; @T4IQZGRM].',
        '',
        '<!-- markedown:bibliography -->',
      ].join('\n'),
      bibliographyName: 'paper-references',
      zoteroEntries: [
        ...entries,
        {
          itemKey: 'UNUSED123',
          citationKey: 'unused',
          bibtex: '@article{unused,title={Unused}}',
        },
      ],
    });

    expect(result.texContent).toContain('\\title{Pair-density study}');
    expect(result.texContent).toContain(
      '\\citep{gagliardi_multiconfiguration_2017,li_manni_multiconfiguration_2014}',
    );
    expect(result.texContent).not.toContain('\\citep{D9PGQUM4');
    expect(result.texContent).toContain('\\bibliography{paper-references}');
    expect(result.bibContent).toContain('@article{gagliardi_multiconfiguration_2017');
    expect(result.bibContent).toContain('@article{li_manni_multiconfiguration_2014');
    expect(result.bibContent).not.toContain('@article{unused');
    expect(result.unresolvedItemKeys).toEqual([]);
    expect(result.citationKeys).toEqual([
      'gagliardi_multiconfiguration_2017',
      'li_manni_multiconfiguration_2014',
    ]);
  });

  it('places the bibliography exactly at the movable marker', () => {
    const result = buildLatexExport({
      markdown: [
        '# Main text',
        '',
        'Citation [@D9PGQUM4].',
        '',
        '<!-- markedown:bibliography -->',
        '',
        '# Appendix',
      ].join('\n'),
      zoteroEntries: entries,
    });

    expect(result.texContent.indexOf('\\bibliography{references}')).toBeLessThan(
      result.texContent.indexOf('\\section{Appendix}'),
    );
    expect(result.texContent.match(/\\bibliography\{references\}/g)).toHaveLength(1);
  });

  it('appends a bibliography when the marker is absent', () => {
    const result = buildLatexExport({
      markdown: 'Text [@D9PGQUM4].',
      zoteroEntries: entries,
    });

    expect(result.texContent.indexOf('Text ')).toBeLessThan(
      result.texContent.indexOf('\\bibliographystyle{unsrtnat}'),
    );
    expect(result.warnings).toContain(
      'LaTeX 编译环境缺少 naturemag.bst 时将回退为 unsrtnat；请安装 Nature 样式以获得目标期刊格式。',
    );
  });

  it('resolves relative local images against the saved Markdown directory', () => {
    const windows = buildLatexExport({
      markdown: '![Result](../figures/result.png)',
      sourceDirectory: 'C:\\Research\\manuscript\\',
    });
    const posix = buildLatexExport({
      markdown: '![Result](./figures/result.png)',
      sourceDirectory: '/home/research/manuscript/',
    });

    expect(windows.texContent).toContain(
      '\\includegraphics[width=0.9\\linewidth]{\\detokenize{C:/Research/figures/result.png}}',
    );
    expect(posix.texContent).toContain(
      '\\includegraphics[width=0.9\\linewidth]{\\detokenize{/home/research/manuscript/figures/result.png}}',
    );
  });

  it('keeps absolute image paths rooted and warns for unsaved relative images', () => {
    const result = buildLatexExport({
      markdown: ['![Absolute](D:/Figures/result.png)', '', '![Relative](./figures/local.png)'].join(
        '\n',
      ),
    });

    expect(result.texContent).toContain('\\detokenize{D:/Figures/result.png}');
    expect(result.texContent).toContain('\\detokenize{figures/local.png}');
    expect(result.warnings).toContain(
      'LaTeX 无法解析相对图片路径 ./figures/local.png：请先保存 Markdown 文档。',
    );
  });

  it('continues to warn instead of treating remote images as local paths', () => {
    const result = buildLatexExport({
      markdown: '![Remote](https://example.com/result.png)',
      sourceDirectory: 'C:\\Research\\',
    });

    expect(result.texContent).toContain('\\href{https://example.com/result.png}{Remote}');
    expect(result.warnings).toContain(
      'LaTeX 无法直接嵌入远程或内存图片：https://example.com/result.png',
    );
  });

  it('does not treat citation-shaped text in code as a Zotero item', () => {
    const markdown = ['`[@T4IQZGRM]` and [@D9PGQUM4].', '', '```text', '[@MRHTZ5CI]', '```'].join(
      '\n',
    );
    expect(collectZoteroItemKeys(markdown)).toEqual(['D9PGQUM4']);
    const result = buildLatexExport({ markdown, zoteroEntries: entries });
    expect(result.texContent).toContain('\\texttt{[@T4IQZGRM]}');
    expect(result.texContent).toContain('[@MRHTZ5CI]');
  });

  it('keeps output compilable and reports unresolved or non-item citation keys', () => {
    const result = buildLatexExport({
      markdown: 'Missing [@MRHTZ5CI] and invalid [@smith2024].',
      zoteroEntries: [],
    });

    expect(result.texContent).not.toContain('\\citep{MRHTZ5CI}');
    expect(result.texContent).toContain('Unresolved Zotero item');
    expect(result.unresolvedItemKeys).toEqual(['MRHTZ5CI', 'smith2024']);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('未能从 Zotero 解析文献 MRHTZ5CI'),
        expect.stringContaining('不是 Zotero item key'),
      ]),
    );
  });

  it('renders equations, lists and tables with the academic preamble', () => {
    const result = buildLatexExport({
      markdown: [
        'Equation $x_1$:',
        '',
        '$$',
        'E = mc^2 \\label{eq:energy}',
        '$$',
        '',
        '- first',
        '- second',
        '',
        '| Left | Right |',
        '| :--- | ---: |',
        '| A&B | 2 |',
      ].join('\n'),
    });

    expect(result.texContent).toContain('\\documentclass[12pt,a4paper]{article}');
    expect(result.texContent).toContain('\\usepackage[numbers,super,sort&compress]{natbib}');
    expect(result.texContent).toContain(
      '\\IfFileExists{setspace.sty}{\\doublespacing}{\\linespread{2}}',
    );
    expect(result.texContent).toContain('\\IfFileExists{lineno.sty}{\\usepackage{lineno}}{}');
    expect(result.texContent).toContain('\\IfFileExists{lineno.sty}{\\linenumbers}{}');
    expect(result.texContent).toContain('\\begin{equation}');
    expect(result.texContent).toContain('E = mc^2 \\label{eq:energy}');
    expect(result.texContent).toContain('\\begin{itemize}');
    expect(result.texContent).toContain('A\\&B & 2');
    expect(result.texContent).toContain('\\begin{tabularx}{\\linewidth}');
  });

  it('honors author-year settings and sanitizes the bibliography file stem', () => {
    const result = buildLatexExport({
      markdown: '---\ncitation-style: author-year\n---\n\nText [@D9PGQUM4].',
      bibliographyName: 'My refs.bib',
      zoteroEntries: entries,
    });

    expect(result.bibliographyName).toBe('My-refs');
    expect(result.texContent).toContain('\\usepackage[authoryear,round]{natbib}');
    expect(result.texContent).toContain('\\bibliographystyle{plainnat}');
    expect(result.warnings.some((warning) => warning.includes('naturemag.bst'))).toBe(false);
  });

  it('renames unsafe BibTeX citekeys and rewrites both citations and entry headers', () => {
    const result = buildLatexExport({
      markdown: 'Text [@D9PGQUM4].',
      zoteroEntries: [
        {
          itemKey: 'D9PGQUM4',
          citationKey: 'gagliardi 2017#main',
          bibtex: '@article{gagliardi 2017#main,\n  title={First paper}\n}',
        },
      ],
    });

    expect(result.texContent).toContain('\\citep{gagliardi-2017-main}');
    expect(result.bibContent).toContain('@article{gagliardi-2017-main,');
    expect(result.bibContent).not.toContain('@article{gagliardi 2017#main,');
    expect(result.citationKeys).toEqual(['gagliardi-2017-main']);
  });

  it('renames duplicate BibTeX citekeys deterministically in citation order', () => {
    const result = buildLatexExport({
      markdown: 'Text [@D9PGQUM4; @T4IQZGRM].',
      zoteroEntries: [
        {
          itemKey: 'T4IQZGRM',
          citationKey: 'shared_key',
          bibtex: '@article{shared_key,\n  title={Second paper}\n}',
        },
        {
          itemKey: 'D9PGQUM4',
          citationKey: 'shared_key',
          bibtex: '@article{shared_key,\n  title={First paper}\n}',
        },
      ],
    });

    expect(result.texContent).toContain('\\citep{shared_key,shared_key-2}');
    expect(result.bibContent).toContain('@article{shared_key,\n  title={First paper}');
    expect(result.bibContent).toContain('@article{shared_key-2,\n  title={Second paper}');
    expect(result.citationKeys).toEqual(['shared_key', 'shared_key-2']);
  });

  it('escapes LaTeX text and uses a stable fallback bibliography name', () => {
    expect(escapeLatex('A&B_50%')).toBe('A\\&B\\_50\\%');
    expect(sanitizeBibliographyName('  中文 .bib ')).toBe('references');
  });
});
