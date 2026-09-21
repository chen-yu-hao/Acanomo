import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanEditorArtifacts,
  createExportHtmlDocument,
  exportDocx,
  exportLatex,
  inlineLocalImages,
  splitExportPath,
  type ExportDocumentInput,
} from './exportService';

const mocks = vi.hoisted(() => ({
  buildAcademicDocx: vi.fn(),
  exportFile: vi.fn(),
  fetchZoteroExportItems: vi.fn(),
  prepareLatexExport: vi.fn(),
  readFileAsBase64: vi.fn(),
  save: vi.fn(),
}));

// 模拟 tauriStorage 的 readFileAsBase64，避免在单元测试中调用 Tauri。
vi.mock('../../lib/desktop/tauriStorage', () => ({
  exportFile: mocks.exportFile,
  exportHtmlFile: vi.fn(),
  exportPdfFromHtml: vi.fn(),
  readFileAsBase64: mocks.readFileAsBase64,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: mocks.save,
}));

vi.mock('../../lib/services/zotero', () => ({
  fetchZoteroExportItems: mocks.fetchZoteroExportItems,
}));

vi.mock('./docxExport', () => ({
  buildAcademicDocx: mocks.buildAcademicDocx,
}));

vi.mock('./latexExportService', () => ({
  prepareLatexExport: mocks.prepareLatexExport,
}));

const exportInput: ExportDocumentInput = {
  markdown: 'A cited result [@D9PGQUM4].',
  renderedHtml:
    '<div contenteditable="true"><p>A cited result <span class="citation-node" data-citation-keys="D9PGQUM4">1</span>.</p></div>',
  documentPath: 'C:\\Research\\draft.md',
  suggestedFileName: 'manuscript',
  title: 'Academic manuscript',
};

beforeEach(() => {
  mocks.buildAcademicDocx.mockReset();
  mocks.exportFile.mockReset();
  mocks.fetchZoteroExportItems.mockReset();
  mocks.prepareLatexExport.mockReset();
  mocks.readFileAsBase64.mockReset();
  mocks.save.mockReset();

  mocks.exportFile.mockResolvedValue({ file_path: '', bytes_written: 4 });
  mocks.fetchZoteroExportItems.mockResolvedValue([]);
  mocks.readFileAsBase64.mockResolvedValue({
    data_url: 'data:image/png;base64,MOCK',
    mime_type: 'image/png',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('exportService', () => {
  it('createExportHtmlDocument 生成完整独立 HTML', () => {
    const html = createExportHtmlDocument('<p>hello</p>', 'Test', 'body{}');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>Test</title>');
    expect(html).toContain('body{}');
    expect(html).toContain('<p>hello</p>');
    expect(html).toContain('nomo-export');
  });

  it('createExportHtmlDocument 对标题进行 HTML 转义', () => {
    const html = createExportHtmlDocument('<p></p>', '<script>alert(1)</script>', '');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('cleanEditorArtifacts 将 .image-node 的对齐样式迁移到 <img>', () => {
    const input = `
      <div class="image-node" style="display: block; margin-left: auto; margin-right: auto;">
        <img src="./a.png" alt="居中" style="width: 400px;" />
      </div>
      <div class="image-node" style="display: block; margin-left: auto; margin-right: 0px;">
        <img src="./b.png" alt="右对齐" />
      </div>
      <div class="image-node">
        <img src="./c.png" alt="无对齐" />
      </div>
    `;
    const output = cleanEditorArtifacts(input);

    // 居中图片：margin-left/margin-right 应为 auto（style 顺序由浏览器决定，分别断言）
    expect(output).toContain('margin-left: auto');
    expect(output).toContain('margin-right: auto');
    expect(output).toContain('width: 400px;');

    // 右对齐图片：margin-left 应为 auto
    expect(output).toContain('margin-left: auto; margin-right: 0px;');

    // 无对齐图片：不应有额外的 margin 样式
    expect(output).toContain('<img src="./c.png" alt="无对齐">');

    // 不应残留 .image-node wrapper
    expect(output).not.toContain('image-node');
  });

  it('cleanEditorArtifacts 移除 contenteditable 属性，防止导出 HTML 点击时出现黑边框', () => {
    const input = `
      <div contenteditable="true" class="ProseMirror">
        <p>正文内容</p>
        <span contenteditable="false">不可编辑装饰</span>
      </div>
    `;
    const output = cleanEditorArtifacts(input);
    // contenteditable 属性应被完全移除
    expect(output).not.toContain('contenteditable="true"');
    expect(output).not.toContain('contenteditable="false"');
    expect(output).not.toContain('contenteditable');
    // 正文内容应保留
    expect(output).toContain('正文内容');
  });

  it('keeps academic citations, formula links, numbering and bibliography in exported HTML', () => {
    const input =
      '<div class="math-block" contenteditable="false" id="eq-energy">E<span class="equation-number">(1)</span></div>' +
      '<p><span class="citation-node" contenteditable="false">[1]</span> <a class="equation-ref" contenteditable="false" href="#eq-energy">(1)</a></p>' +
      '<section class="bibliography-block" contenteditable="false"><h2>References</h2><ol><li>Paper</li></ol></section>';
    const output = cleanEditorArtifacts(input);
    expect(output).toContain('id="eq-energy"');
    expect(output).toContain('equation-number');
    expect(output).toContain('citation-node');
    expect(output).toContain('href="#eq-energy"');
    expect(output).toContain('<li>Paper</li>');
    expect(output).not.toContain('contenteditable');
  });

  it('inlineLocalImages 保留 data/blob 图片链接，对 http/https 尝试转 base64', async () => {
    const originalFetch = globalThis.fetch;
    // 模拟 fetch 返回图片 blob
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['fake-png'], { type: 'image/png' })),
    });

    try {
      const html = `
        <img src="https://example.com/a.png" />
        <img src="data:image/png;base64,ABC" />
        <img src="blob:abc" />
      `;
      const { html: result, warnings } = await inlineLocalImages(html, null);
      // data: 和 blob: 保持原样
      expect(result).toContain('data:image/png;base64,ABC');
      expect(result).toContain('blob:abc');
      // https:// 远程图片被转换为 base64 data URL
      expect(result).toContain('data:');
      expect(result).not.toContain('https://example.com/a.png');
      expect(warnings).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('inlineLocalImages 对未保存文档的相对路径给出 warning', async () => {
    const html = '<img src="./images/a.png" />';
    const { html: result, warnings } = await inlineLocalImages(html, null);
    expect(result).toContain('./images/a.png');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('inlineLocalImages 远程图片 fetch 超时后保留原链接并给出 warning', async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((_url, init) => {
      const signal = init && typeof init === 'object' ? init.signal : null;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });

    try {
      const promise = inlineLocalImages('<img src="https://example.com/slow.png" />', null);
      await vi.advanceTimersByTimeAsync(8_000);
      const { html: result, warnings } = await promise;

      expect(result).toContain('https://example.com/slow.png');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('fetch timeout after 8000ms');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('splitExportPath handles Windows, POSIX and empty extensions without losing the stem', () => {
    expect(splitExportPath('C:\\Research\\draft.md', '')).toEqual({
      directory: 'C:\\Research\\',
      stem: 'draft.md',
    });
    expect(splitExportPath('/tmp/Paper.TEX', '.tex')).toEqual({
      directory: '/tmp/',
      stem: 'Paper',
    });
    expect(splitExportPath('paper', '.tex')).toEqual({
      directory: '',
      stem: 'paper',
    });
  });

  it('exports DOCX bytes and combines generator and citation warnings', async () => {
    mocks.save.mockResolvedValue('C:\\Exports\\manuscript.docx');
    mocks.fetchZoteroExportItems.mockResolvedValue([
      {
        key: 'D9PGQUM4',
        citationKey: 'gagliardi_2017',
        bibtex: '@article{gagliardi_2017}',
        cslItem: {
          id: 'http://zotero.org/users/1/items/D9PGQUM4',
          type: 'article-journal',
          title: 'Paper',
        },
        citationHtml: '<span class="citation">1</span>',
        bibliographyHtml: '<div class="csl-entry">Paper</div>',
      },
    ]);
    mocks.buildAcademicDocx.mockReturnValue({
      bytes: new Uint8Array([0x50, 0x4b, 0x00, 0xff]),
      warnings: ['Formula kept as text'],
      citationIssues: [{ message: 'Missing citation' }],
    });

    await expect(exportDocx(exportInput)).resolves.toEqual({
      success: true,
      filePath: 'C:\\Exports\\manuscript.docx',
      warnings: ['Formula kept as text', 'Missing citation'],
    });
    expect(mocks.save).toHaveBeenCalledWith({
      defaultPath: 'C:\\Research\\manuscript.docx',
      filters: [{ name: 'Word', extensions: ['docx'] }],
    });
    expect(mocks.fetchZoteroExportItems).toHaveBeenCalledWith(['D9PGQUM4'], 'numeric');
    expect(mocks.buildAcademicDocx).toHaveBeenCalledWith(
      expect.objectContaining({
        citationStyle: 'numeric',
        title: 'Academic manuscript',
        zoteroItems: [
          expect.objectContaining({
            bibliographyHtml: '<div class="csl-entry">Paper</div>',
            citationHtml: '<span class="citation">1</span>',
            key: 'D9PGQUM4',
            uri: 'http://zotero.org/users/1/items/D9PGQUM4',
          }),
        ],
      }),
    );
    expect(mocks.exportFile).toHaveBeenCalledWith({
      file_path: 'C:\\Exports\\manuscript.docx',
      bytes: [0x50, 0x4b, 0x00, 0xff],
    });
  });

  it('does no DOCX work when the save dialog is cancelled', async () => {
    mocks.save.mockResolvedValue(null);

    await expect(exportDocx(exportInput)).resolves.toEqual({
      success: false,
      cancelled: true,
    });
    expect(mocks.fetchZoteroExportItems).not.toHaveBeenCalled();
    expect(mocks.buildAcademicDocx).not.toHaveBeenCalled();
    expect(mocks.exportFile).not.toHaveBeenCalled();
  });

  it('inlines local images before building the Word package', async () => {
    mocks.save.mockResolvedValue('C:\\Exports\\manuscript.docx');
    mocks.buildAcademicDocx.mockReturnValue({
      bytes: new Uint8Array([0x50, 0x4b]),
      warnings: [],
      citationIssues: [],
    });

    const result = await exportDocx({
      ...exportInput,
      renderedHtml: '<p>Figure</p><img src="C:\\Research\\figure.png" alt="Result" />',
    });

    expect(result.success).toBe(true);
    expect(mocks.readFileAsBase64).toHaveBeenCalledWith('C:\\Research\\figure.png');
    expect(mocks.buildAcademicDocx).toHaveBeenCalledWith(
      expect.objectContaining({
        renderedHtml: expect.stringContaining('data:image/png;base64,MOCK'),
      }),
    );
  });

  it('requests and builds author-year Zotero content when configured in front matter', async () => {
    mocks.save.mockResolvedValue('C:\\Exports\\author-year.docx');
    mocks.fetchZoteroExportItems.mockResolvedValue([]);
    mocks.buildAcademicDocx.mockReturnValue({
      bytes: new Uint8Array([0x50, 0x4b]),
      warnings: [],
      citationIssues: [],
    });

    const input = {
      ...exportInput,
      markdown: '---\ncitation-style: author-year\n---\n\nResult [@D9PGQUM4].',
    };
    await exportDocx(input);

    expect(mocks.fetchZoteroExportItems).toHaveBeenCalledWith(['D9PGQUM4'], 'author-year');
    expect(mocks.buildAcademicDocx).toHaveBeenCalledWith(
      expect.objectContaining({ citationStyle: 'author-year' }),
    );
  });

  it('exports matching .tex and .bib files and reports the sidecar and warnings', async () => {
    mocks.save.mockResolvedValue('D:\\Papers\\manuscript.tex');
    mocks.prepareLatexExport.mockResolvedValue({
      texContent: '\\documentclass{article}\n',
      bibContent: '@article{paper}\n',
      warnings: ['One citation is unresolved'],
    });

    await expect(exportLatex(exportInput)).resolves.toEqual({
      success: true,
      filePath: 'D:\\Papers\\manuscript.tex',
      relatedFiles: ['D:\\Papers\\manuscript.bib'],
      warnings: ['One citation is unresolved'],
    });
    expect(mocks.save).toHaveBeenCalledWith({
      defaultPath: 'C:\\Research\\manuscript.tex',
      filters: [{ name: 'LaTeX', extensions: ['tex'] }],
    });
    expect(mocks.prepareLatexExport).toHaveBeenCalledWith({
      markdown: exportInput.markdown,
      bibliographyName: 'manuscript',
      sourceDirectory: 'C:\\Research\\',
    });
    expect(mocks.exportFile).toHaveBeenNthCalledWith(1, {
      file_path: 'D:\\Papers\\manuscript.bib',
      bytes: Array.from(new TextEncoder().encode('@article{paper}\n')),
    });
    expect(mocks.exportFile).toHaveBeenNthCalledWith(2, {
      file_path: 'D:\\Papers\\manuscript.tex',
      bytes: Array.from(new TextEncoder().encode('\\documentclass{article}\n')),
    });
    expect(mocks.exportFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.exportFile.mock.invocationCallOrder[1],
    );
  });

  it('does no LaTeX work when the save dialog is cancelled', async () => {
    mocks.save.mockResolvedValue(null);

    await expect(exportLatex(exportInput)).resolves.toEqual({
      success: false,
      cancelled: true,
    });
    expect(mocks.prepareLatexExport).not.toHaveBeenCalled();
    expect(mocks.exportFile).not.toHaveBeenCalled();
  });

  it('passes no source directory for an unsaved Markdown document', async () => {
    mocks.save.mockResolvedValue('D:\\Papers\\untitled.tex');
    mocks.prepareLatexExport.mockResolvedValue({
      texContent: '\\documentclass{article}\n',
      bibContent: '',
      warnings: [],
    });

    await exportLatex({ ...exportInput, documentPath: null });

    expect(mocks.prepareLatexExport).toHaveBeenCalledWith(
      expect.objectContaining({ sourceDirectory: null }),
    );
  });
});
