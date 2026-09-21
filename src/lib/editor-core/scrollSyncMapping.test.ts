import { describe, expect, it, vi } from 'vitest';
import { parseMarkdown, parseMarkdownWithSyncAnchors } from './markdown';
import { createEditorCore } from './createEditorCore';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Keep this contract independent of edits to the repository's README.
const scrollSyncFixture = [
  '<p align="center">',
  '<img src="logo.png" width="120">',
  '</p>',
  '',
  ...Array.from({ length: 12 }, (_, index) => [
    `## Section ${index + 1}`,
    '',
    'A long editable paragraph with enough context to verify all source anchors after an edit.',
    '',
    '| Name | Value |',
    '| :--- | :--- |',
    '| **First** | [link](https://example.test) |',
    '| Second | plain text |',
    '',
  ]).flat(),
  'Final paragraph after the last table.',
].join('\n');

describe('Markdown source provenance for scroll synchronization', () => {
  it('keeps proven suffix anchors when typing beside a leading aligned image', () => {
    const editor = createEditorCore({
      markdown: scrollSyncFixture,
      target: document.createElement('div'),
    });
    try {
      const view = (editor as unknown as { view: EditorView }).view;
      view.dispatch(view.state.tr.insertText('测试', 1));
      editor.flushMarkdown();
      const mapping = editor.getScrollSyncSnapshot();
      expect(mapping.ready).toBe(true);
      const headings: number[] = [];
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') headings.push(pos);
      });
      expect(headings.length).toBeGreaterThan(10);
      expect(
        mapping.anchors
          .filter((anchor) => anchor.kind === 'heading' && anchor.edge === 'start')
          .map((anchor) => anchor.pos),
      ).toEqual(headings);
      const parsed = parseMarkdownWithSyncAnchors(mapping.markdown);
      for (const anchor of mapping.anchors.filter(
        (item) => item.kind !== 'eof' && item.kind !== 'blank',
      )) {
        const original = parsed.anchors.find((item) => item.key === anchor.key)!;
        expect(parsed.doc.nodeAt(original.pos)?.eq(view.state.doc.nodeAt(anchor.pos)!)).toBe(true);
      }
      expect(mapping.anchors.some((anchor) => anchor.pos === 0)).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it.each(['fixture', 'sample.md'])(
    'retains reliable anchors beyond complex tables after editing %s',
    (file) => {
      const editor = createEditorCore({
        markdown:
          file === 'fixture'
            ? scrollSyncFixture
            : readFileSync(resolve(process.cwd(), file), 'utf8'),
        target: document.createElement('div'),
      });
      try {
        const view = (editor as unknown as { view: EditorView }).view;
        const before = editor.getScrollSyncSnapshot();
        let pos = 0;
        view.state.doc.descendants((node, offset) => {
          if (
            !pos &&
            node.type.name === 'paragraph' &&
            node.textContent.length > 30 &&
            offset > view.state.doc.content.size * 0.45
          )
            pos = offset + 5;
        });
        expect(pos).toBeGreaterThan(0);
        view.dispatch(view.state.tr.insertText('测试', pos));
        editor.flushMarkdown();
        const after = editor.getScrollSyncSnapshot();
        expect(after.ready).toBe(true);
        expect(after.revision).toBeGreaterThan(before.revision);
        const parsed = parseMarkdownWithSyncAnchors(after.markdown);
        for (const anchor of parsed.anchors) {
          expect(
            after.anchors.some((item) => item.key === anchor.key && item.pos === anchor.pos),
          ).toBe(true);
        }
      } finally {
        editor.destroy();
      }
    },
  );

  it('records actual nested nodes, table rows and code lines without changing the parsed document', () => {
    const markdown = [
      '# Title',
      '',
      '- first',
      '  - nested',
      '- last',
      '',
      '| A | B |',
      '| - | - |',
      '| C | D |',
      '',
      '```js',
      'one()',
      'two()',
      '```',
      '',
      '> [!NOTE]',
      '> hello',
    ].join('\n');
    const { doc, anchors } = parseMarkdownWithSyncAnchors(markdown);
    expect(doc.eq(parseMarkdown(markdown))).toBe(true);
    const starts = anchors.filter((anchor) => anchor.edge === 'start');
    expect(
      starts.filter((anchor) => anchor.kind === 'list_item').map((anchor) => anchor.fromLine),
    ).toEqual([3, 4, 5]);
    expect(
      starts.filter((anchor) => anchor.kind === 'table_row').map((anchor) => anchor.fromLine),
    ).toEqual([7, 9]);
    expect(
      anchors.filter((anchor) => anchor.edge === 'line').map((anchor) => anchor.fromLine),
    ).toEqual([12, 13]);
    expect(starts.some((anchor) => anchor.kind === 'callout')).toBe(true);
    for (const anchor of starts) expect(doc.nodeAt(anchor.pos)?.type.name).toBe(anchor.kind);
  });

  it('preserves original source lines through front matter and image HTML preprocessing', () => {
    const markdown =
      '---\ntitle: Demo\n---\n\n# Title\n\n<p align="center">\n<img src="demo.png" width="100">\n</p>\n\nAfter\n';
    const result = parseMarkdownWithSyncAnchors(markdown);
    expect(result.doc.eq(parseMarkdown(markdown))).toBe(true);
    expect(result.anchors.find((anchor) => anchor.kind === 'heading')?.fromLine).toBe(5);
    expect(
      result.anchors.filter((anchor) => anchor.edge === 'start').map((anchor) => anchor.fromLine),
    ).toContain(11);
    expect(JSON.stringify(result.doc.toJSON())).not.toContain('fromLine');
  });

  it('keeps collapsed caret events independent of selection statistics and mapping revisions', () => {
    const onSelectionChange = vi.fn();
    const editor = createEditorCore({
      markdown: '# One\n\nBody',
      target: document.createElement('div'),
      onSelectionChange,
    });
    const before = editor.getSnapshot();
    const mapping = editor.getScrollSyncSnapshot();
    expect(mapping.ready).toBe(true);
    editor.selectAll();
    expect(editor.getScrollSyncSnapshot()).toBe(mapping);
    expect(editor.getScrollSyncCaret()?.head).toBeGreaterThan(0);
    expect(editor.getMarkdown()).toBe(before.markdown);
    expect(editor.getSnapshot().version).toBeGreaterThan(before.version);
    const view = (editor as unknown as { view: EditorView }).view;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selection: null,
        selectedMarkdown: '',
        caret: expect.objectContaining({ head: 1 }),
      }),
    );
    editor.destroy();
  });

  it('tracks lines consumed by standalone HTML images without altering parser behavior', () => {
    const markdown = '# Before\n\n<img src="demo.png">\n\nAfter\n\n# Last';
    const result = parseMarkdownWithSyncAnchors(markdown);
    expect(result.doc.eq(parseMarkdown(markdown))).toBe(true);
    expect(
      result.anchors.find((item) => item.edge === 'start' && item.fromLine === 3)?.toLine,
    ).toBe(5);
    expect(
      result.anchors
        .filter((item) => item.kind === 'heading' && item.edge === 'start')
        .map((item) => item.fromLine),
    ).toEqual([1, 7]);
  });

  it('keeps blank regions, complex blocks and the synthetic tail separate from body nodes', () => {
    const markdown =
      '# Title\n\n\n![image](demo.png)\n\n$$\nx^2\n$$\n\n```mermaid\nflowchart LR\nA --> B\n```';
    const target = document.createElement('div');
    const editor = createEditorCore({ markdown, target });
    const before = editor.getSnapshot();
    const mapping = editor.getScrollSyncSnapshot();
    expect(mapping.anchors.some((item) => item.kind === 'blank' && item.fromLine === 2)).toBe(true);
    expect(mapping.anchors.some((item) => item.kind === 'math_block')).toBe(true);
    expect(mapping.anchors.some((item) => item.kind === 'mermaid_block')).toBe(true);
    expect(mapping.anchors.filter((item) => item.edge === 'line')).toEqual([]);
    const tail = mapping.anchors.find((item) => item.kind === 'eof')!;
    expect(tail.pos).toBeGreaterThan(
      mapping.anchors.find((item) => item.kind === 'mermaid_block')!.pos,
    );
    for (const item of mapping.anchors) editor.getScrollSyncAnchorRect(item);
    expect(editor.getSnapshot()).toEqual(before);
    expect(editor.getMarkdown()).toBe(markdown);
    editor.destroy();
    const metadata = createEditorCore({
      markdown: '---\ntitle: Empty\n---\n',
      target: document.createElement('div'),
    });
    expect(metadata.getScrollSyncSnapshot().ready).toBe(true);
    metadata.destroy();
  });

  it('withholds old maps while source or semantic content is pending and remaps inserted blocks', () => {
    const editor = createEditorCore({
      markdown: '# One\n\nBody',
      target: document.createElement('div'),
    });
    const previous = editor.getScrollSyncSnapshot();
    editor.setMarkdown('Before\n\n# One\n\nBody', { sourceInput: true });
    expect(editor.getScrollSyncSnapshot().ready).toBe(false);
    editor.refreshSemanticView();
    const next = editor.getScrollSyncSnapshot();
    expect(next.ready).toBe(true);
    expect(next.revision).toBeGreaterThan(previous.revision);
    expect(next.anchors.find((anchor) => anchor.kind === 'heading')?.fromLine).toBe(3);
    expect(next.anchors.some((anchor) => anchor.key === 'eof')).toBe(true);
    editor.selectAll();
    editor.pasteClipboardText('replacement');
    expect(editor.getScrollSyncSnapshot().ready).toBe(false);
    editor.flushMarkdown();
    expect(editor.getScrollSyncSnapshot().ready).toBe(true);
    editor.destroy();
  });
});
