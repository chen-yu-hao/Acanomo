import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorView } from 'prosemirror-view';
import { schema } from './schema';
import { createEditorCore } from './createEditorCore';
import type { EditorCore } from './types';
import { computeReviewDiff } from '../review/review';
import { buildReviewSemanticDecorations } from '../../app/services/reviewSemanticMapping';

let activeEditor: EditorCore | null = null;

afterEach(() => {
  activeEditor?.destroy();
  activeEditor = null;
});

describe('semantic review decorations', () => {
  function refreshReview(baseline: string) {
    const current = activeEditor!.getMarkdown();
    const snapshot = activeEditor!.getScrollSyncSnapshot();
    const decorations = buildReviewSemanticDecorations(
      computeReviewDiff(baseline, current),
      snapshot,
    );
    expect(snapshot.ready).toBe(true);
    expect(decorations).not.toBeNull();
    activeEditor!.setReviewDecorations(decorations ?? []);
    return current;
  }

  it.each([
    [
      'citation and paragraph tail',
      '理论 [@FIRST] 的局部解释与结果 [@LAST]。',
      '理论 [@FIRST] 的局部',
      '解释与结果 [@LAST]。',
    ],
    ['changed citation', '理论 [@FIRST] 的结果。', '理论 [@SECOND] 的结果。', '[@FIRST]'],
    [
      'emphasis',
      'The **removable old phrase** remains.',
      'The **phrase** remains.',
      'removable old ',
    ],
    [
      'link text',
      'See [the old result](https://example.test) here.',
      'See [the result](https://example.test) here.',
      'old ',
    ],
    [
      'reference link',
      'See [the old result][ref] here.\n\n[ref]: https://example.test',
      'See [the result][ref] here.\n\n[ref]: https://example.test',
      'old ',
    ],
    ['formula', 'The result $E=mc^2$ remains.', 'The result remains.', '$E=mc^2$ '],
  ])('keeps a local deletion inline across %s', (_name, baseline, current, deleted) => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: current, target });
    refreshReview(baseline);
    expect(target.querySelector('p.review-semantic-added')).toBeNull();
    expect(
      target.querySelector('.review-semantic-deleted:not(.review-semantic-deleted-inline)'),
    ).toBeNull();
    expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toBe(deleted);
    expect(activeEditor.flushMarkdown()).toBe(current);
  });

  it('keeps a local deletion inline when a source paragraph spans several lines', () => {
    const baseline = 'Paragraph start [@FIRST]\nwith an old phrase\nand a final sentence.';
    const current = baseline.replace('old ', '');
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: current, target });
    refreshReview(baseline);
    expect(target.querySelector('p.review-semantic-added')).toBeNull();
    expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toBe('old ');
    expect(activeEditor.flushMarkdown()).toBe(current);
  });

  it.each([
    [
      'remove a middle line',
      'Keep first\nremove middle\nKeep last',
      'Keep first\nKeep last',
      'remove middle\n',
    ],
    ['remove the first line', 'remove first\nKeep last', 'Keep last', 'remove first\n'],
    ['remove the last line', 'Keep first\nremove last', 'Keep first', '\nremove last'],
    [
      'two edits in a multi-line paragraph',
      'first old\nkeep\nlast old',
      'first new\nkeep\nlast new',
      'oldold',
    ],
    [
      'adjacent paragraph edits',
      'First old [@ONE].\n\nNext old [@TWO].',
      'First [@ONE].\n\nNext [@TWO].',
      'old old ',
    ],
  ])('preserves inline review for %s', (_name, baseline, current, deleted) => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: current, target });
    refreshReview(baseline);
    expect(target.querySelector('p.review-semantic-added')).toBeNull();
    expect(
      target.querySelector('.review-semantic-deleted:not(.review-semantic-deleted-inline)'),
    ).toBeNull();
    // textContent omits <br>; verify line breaks in the widget's source spec.
    const decorations = buildReviewSemanticDecorations(
      computeReviewDiff(baseline, current),
      activeEditor.getScrollSyncSnapshot(),
    );
    expect(
      decorations
        ?.filter((d) => d.kind === 'deleted')
        .map((d) => d.text)
        .join(''),
    ).toBe(deleted);
    expect(activeEditor.flushMarkdown()).toBe(current);
  });

  it('does not reuse an old parsed HEAD after the review baseline changes', () => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: 'Keep [@CITE] final.', target });
    refreshReview('Keep [@CITE] old final.');
    expect(target.querySelector('.review-semantic-deleted')?.textContent).toBe('old ');
    refreshReview('Keep [@CITE] second final.');
    expect(target.querySelector('.review-semantic-deleted')?.textContent).toBe('second ');
  });

  it('preserves a removed line break inside an inline deletion widget', () => {
    const baseline = 'Keep first\nremove middle\nKeep last';
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: 'Keep first\nKeep last', target });
    refreshReview(baseline);
    expect(target.querySelectorAll('.review-semantic-deleted-inline br')).toHaveLength(1);
    expect(activeEditor.flushMarkdown()).toBe('Keep first\nKeep last');
  });

  it('does not mark an unchanged citation between two adjacent edits', () => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: '丙[@CITE]丁', target });
    refreshReview('甲[@CITE]乙');
    expect(
      Array.from(target.querySelectorAll('.review-semantic-deleted')).map(
        (node) => node.textContent,
      ),
    ).toEqual(['甲', '乙']);
    expect(
      Array.from(target.querySelectorAll('.review-semantic-added')).map((node) => node.textContent),
    ).toEqual(['丙', '丁']);
    expect(target.querySelector('.review-semantic-added .citation-node')).toBeNull();
  });

  it('keeps pure deletions local across formatted text, emoji and multiple atoms', () => {
    const baseline =
      '研究 😀 **important results** [@FIRST; @SECOND] and [linked text](https://example.test) explain $E=mc^2$ before further evidence [@LAST] and the end.  ';
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: baseline, target });
    const view = (activeEditor as unknown as { view: EditorView }).view;
    const original = view.state.doc;
    const ranges: Array<[number, number]> = [
      [1, 3],
      [10, 16],
    ];
    original.descendants((node, pos) => {
      if (node.isInline && node.isAtom && !node.isText)
        ranges.push([pos, pos + node.nodeSize], [pos - 2, pos + node.nodeSize + 2]);
    });
    for (const [from, to] of ranges) {
      activeEditor.setMarkdown(baseline);
      view.dispatch(view.state.tr.delete(from, to));
      const current = activeEditor.getMarkdown();
      expect(activeEditor.getScrollSyncSnapshot().ready, `range ${from}:${to}: ${current}`).toBe(
        true,
      );
      refreshReview(baseline);
      expect(target.querySelector('.review-semantic-added'), `range ${from}:${to}`).toBeNull();
      expect(
        target.querySelector('.review-semantic-deleted:not(.review-semantic-deleted-inline)'),
      ).toBeNull();
      expect(target.querySelector('.review-semantic-deleted-inline')).not.toBeNull();
    }
  });

  it('updates the complete deleted text after every consecutive backspace', () => {
    const baseline = 'A long paragraph with removable content in the middle.';
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: baseline, target });
    const view = (activeEditor as unknown as { view: EditorView }).view;
    const end = baseline.indexOf(' in the middle.');
    for (let count = 1; count <= 'removable content'.length; count += 1) {
      view.dispatch(view.state.tr.delete(end - count + 1, end - count + 2));
      refreshReview(baseline);
      // At word boundaries Myers may attach the separating space to either
      // side. The complete rendered paragraph must still reconstruct HEAD.
      expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toHaveLength(
        count,
      );
      expect(target.querySelector('p')?.textContent).toBe(baseline);
      expect(target.querySelector('.review-semantic-added')).toBeNull();
      expect(activeEditor.flushMarkdown()).toBe(
        baseline.slice(0, end - count) + baseline.slice(end),
      );
    }
  });

  it.each([0, 1, 2])(
    'keeps all review marks while typing spaces at paragraph %i end',
    (blockIndex) => {
      const baseline = 'First old paragraph.\n\nMiddle paragraph.\n\nLast paragraph.';
      const target = document.createElement('div');
      activeEditor = createEditorCore({ markdown: baseline, target });
      const view = (activeEditor as unknown as { view: EditorView }).view;
      view.dispatch(view.state.tr.insertText('new', 7, 10));
      refreshReview(baseline);
      expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toBe('old');
      for (let count = 1; count <= 3; count += 1) {
        let pos = 0;
        for (let index = 0; index < blockIndex; index += 1)
          pos += view.state.doc.child(index).nodeSize;
        view.dispatch(
          view.state.tr.insertText(' ', pos + view.state.doc.child(blockIndex).nodeSize - 1),
        );
        const current = refreshReview(baseline);
        expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toBe('old');
        expect(
          Array.from(target.querySelectorAll('.review-semantic-added-inline')).map(
            (node) => node.textContent,
          ),
        ).toEqual(['new', ' '.repeat(count)]);
        expect(target.querySelector('p.review-semantic-added')).toBeNull();
        expect(current.split('\n\n')[blockIndex]).toMatch(new RegExp(` {${count}}$`));
      }
    },
  );

  it('shows a whitespace-only addition after loading source Markdown', () => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: 'Same text   ', target });
    refreshReview('Same text');
    expect(target.querySelector('.review-semantic-deleted')).toBeNull();
    expect(target.querySelector('p.review-semantic-added')).toBeNull();
    expect(target.querySelector('.review-semantic-added-inline')?.textContent).toBe('   ');
    expect(activeEditor.flushMarkdown()).toBe('Same text   ');
  });

  it.each([
    '**bold**',
    '*italic*',
    '[link](https://example.test)',
    'Result [@D9PGQUM4]',
    '# Heading',
  ])('keeps reliable anchors after typing a space at the end of %s', (baseline) => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: baseline, target });
    const view = (activeEditor as unknown as { view: EditorView }).view;
    view.dispatch(view.state.tr.insertText(' ', view.state.doc.firstChild!.nodeSize - 1));
    refreshReview(baseline);
    expect(target.querySelector('.review-semantic-added-whitespace')?.textContent).toBe(' ');
    expect(target.querySelector('.review-semantic-deleted')).toBeNull();
    expect(target.querySelector('p.review-semantic-added, h1.review-semantic-added')).toBeNull();
  });

  it.each(['', 'Before\n\n\n\nAfter'])(
    'shows spaces typed into an empty paragraph of %j',
    (baseline) => {
      const target = document.createElement('div');
      activeEditor = createEditorCore({ markdown: baseline, target });
      const view = (activeEditor as unknown as { view: EditorView }).view;
      let pos = 1;
      if (baseline) pos += view.state.doc.firstChild!.nodeSize;
      view.dispatch(view.state.tr.insertText('   ', pos));
      const current = refreshReview(baseline);
      expect(target.querySelector('.review-semantic-added-whitespace')?.textContent).toBe('   ');
      activeEditor.updateOptions({ mode: 'source' });
      activeEditor.setMarkdown(current);
      activeEditor.updateOptions({ mode: 'semantic' });
      refreshReview(baseline);
      expect(target.querySelector('.review-semantic-added-whitespace')?.textContent).toBe('   ');
      expect(activeEditor.flushMarkdown()).toBe(current);
    },
  );

  it('shows the complete deletion when the last paragraph is deleted', () => {
    const baseline = 'Every character is removed.';
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: baseline, target });
    const view = (activeEditor as unknown as { view: EditorView }).view;
    view.dispatch(view.state.tr.delete(1, baseline.length + 1));
    refreshReview(baseline);
    expect(target.querySelector('.review-semantic-deleted')?.textContent).toBe(baseline);
    expect(activeEditor.flushMarkdown()).toBe('');
  });

  it('keeps review decorations out of undo and redo history', () => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: 'Text', target });
    const view = (activeEditor as unknown as { view: EditorView }).view;
    view.dispatch(view.state.tr.insertText('  ', 5));
    refreshReview('Text');
    expect(target.querySelector('.review-semantic-added-whitespace')?.textContent).toBe('  ');
    expect(activeEditor.execute({ type: 'undo' })).toBe(true);
    expect(refreshReview('Text')).toBe('Text');
    expect(target.querySelector('.review-semantic-added')).toBeNull();
    expect(activeEditor.execute({ type: 'redo' })).toBe(true);
    expect(refreshReview('Text')).toBe('Text  ');
    expect(target.querySelector('.review-semantic-added-whitespace')?.textContent).toBe('  ');
    activeEditor.setReviewDecorations([]);
    expect(activeEditor.flushMarkdown()).toBe('Text  ');
  });

  it.each([
    ['Result [@D9PGQUM4] ', 'Result [@D9PGQUM4]'],
    ['Result old [@D9PGQUM4]', 'Result [@D9PGQUM4]'],
  ])('keeps deletion on the correct side of a citation: %s', (baseline, current) => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: current, target });
    refreshReview(baseline);
    expect(target.querySelector('p')?.textContent).toBe(baseline);
    expect(activeEditor.flushMarkdown()).toBe(current);
  });

  it('shows the entire growing forward deletion and restores it after undo', () => {
    const baseline = 'Keep 删除这一整段文字。 Keep';
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: baseline, target });
    const view = (activeEditor as unknown as { view: EditorView }).view;
    const removed = '删除这一整段文字。';
    for (let count = 1; count <= removed.length; count += 1) {
      view.dispatch(view.state.tr.delete(6, 7));
      refreshReview(baseline);
      expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toBe(
        removed.slice(0, count),
      );
      expect(target.querySelector('p')?.textContent).toBe(baseline);
    }
    activeEditor.execute({ type: 'undo' });
    expect(refreshReview(baseline)).toBe(baseline);
    expect(target.querySelector('.review-semantic-deleted')).toBeNull();
    activeEditor.execute({ type: 'redo' });
    refreshReview(baseline);
    expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toBe(removed);
  });

  it('renders a paragraph-internal deletion without replacing the paragraph', () => {
    const baseline = 'A long paragraph with a removable phrase in the middle.\n';
    const current = 'A long paragraph with a in the middle.\n';
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: current, target });
    const decorations = buildReviewSemanticDecorations(
      computeReviewDiff(baseline, current),
      activeEditor.getScrollSyncSnapshot(),
    );

    expect(decorations).toHaveLength(1);
    expect(decorations?.[0]).toMatchObject({ kind: 'deleted', inline: true });
    activeEditor.setReviewDecorations(decorations ?? []);

    expect(target.querySelectorAll('.review-semantic-deleted-inline')).toHaveLength(1);
    expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toContain(
      'removable phrase',
    );
    expect(target.querySelector('.review-semantic-added')).toBeNull();
    expect(activeEditor.flushMarkdown()).toBe(current);
  });

  it('renders a paragraph-internal replacement as separate old and new marks', () => {
    const baseline = 'The paragraph keeps its shape but says old here.\n';
    const current = 'The paragraph keeps its shape but says new here.\n';
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: current, target });
    const decorations = buildReviewSemanticDecorations(
      computeReviewDiff(baseline, current),
      activeEditor.getScrollSyncSnapshot(),
    );

    activeEditor.setReviewDecorations(decorations ?? []);
    expect(target.querySelectorAll('.review-semantic-added-inline')).toHaveLength(1);
    expect(target.querySelectorAll('.review-semantic-deleted-inline')).toHaveLength(1);
    expect(target.querySelector('.review-semantic-added-inline')?.textContent).toContain('new');
    expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toContain('old');
    const deleted = target.querySelector('.review-semantic-deleted-inline');
    const added = target.querySelector('.review-semantic-added-inline');
    expect(
      deleted && added && deleted.compareDocumentPosition(added) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(activeEditor.flushMarkdown()).toBe(current);
  });

  it('keeps a local deletion after a citation atom inline', () => {
    const baseline =
      'Intro [@D9PGQUM4]. The old phrase remains in this long paragraph for context.\n';
    const current = 'Intro [@D9PGQUM4]. The phrase remains in this long paragraph for context.\n';
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: current, target });
    const decorations = buildReviewSemanticDecorations(
      computeReviewDiff(baseline, current),
      activeEditor.getScrollSyncSnapshot(),
    );

    expect(decorations).not.toBeNull();
    expect(decorations).toContainEqual(
      expect.objectContaining({ kind: 'deleted', inline: true, text: 'old ' }),
    );
    expect(
      decorations?.some((decoration) => decoration.kind === 'added' && !decoration.inline),
    ).toBe(false);
    activeEditor.setReviewDecorations(decorations ?? []);

    expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toContain('old');
    expect(target.querySelector('.review-semantic-added')).toBeNull();
    expect(activeEditor.flushMarkdown()).toBe(current);
  });

  it('keeps a local deletion in a long paragraph with a citation atom', () => {
    const baseline =
      'GCDB137 tests thermochemistry, barrier heights, isomerisation energies, intermolecular and intramolecular noncovalent interactions, electric-field responses, vibrational frequencies and transition-metal chemistry [@GSDB137]. We selected 69 subsets for comparison and calculated normalised error ratios (NERs) as defined in the original database. For each subset, the NER is the ratio of the method error metric to the corresponding standardised error. Category means were first calculated at the subset level and then aggregated by category.\n';
    const current =
      'GCDB137 tests thermochemistry, barrier heights, isomerisation energies, intermolecular and intramolecular noncovalent interactions, electric-field responses, vibrational frequencies and transition-metal chemistry [@GSDB137]. We selected 69 subsets for comparison and calculated normalised error ratios (NERs) as defined in the original database. For each subset, error metric to the corresponding standardised error. Category means were first calculated at the subset level and then aggregated by category.\n';
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: current, target });
    const decorations = buildReviewSemanticDecorations(
      computeReviewDiff(baseline, current),
      activeEditor.getScrollSyncSnapshot(),
    );

    expect(decorations).not.toBeNull();
    expect(decorations).toContainEqual(
      expect.objectContaining({
        kind: 'deleted',
        inline: true,
        text: 'the NER is the ratio of the method ',
      }),
    );
    expect(
      decorations?.some((decoration) => decoration.kind === 'added' && !decoration.inline),
    ).toBe(false);
    activeEditor.setReviewDecorations(decorations ?? []);
    expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toContain(
      'the NER is the ratio',
    );
    expect(target.querySelector('.review-semantic-added')).toBeNull();
    expect(activeEditor.flushMarkdown()).toBe(current);
  });

  it('canonicalizes unchanged multi-key citation syntax before mapping nearby edits', () => {
    const baseline = 'A result [@D9PGQUM4; @T4IQZGRM] keeps the old phrase here.\n';
    const current = 'A result [@D9PGQUM4;@T4IQZGRM] keeps the phrase here.\n';
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: current, target });
    const decorations = buildReviewSemanticDecorations(
      computeReviewDiff(baseline, current),
      activeEditor.getScrollSyncSnapshot(),
    );

    expect(decorations).not.toBeNull();
    expect(decorations).toContainEqual(
      expect.objectContaining({ kind: 'deleted', inline: true, text: 'old ' }),
    );
    expect(
      decorations?.some((decoration) => decoration.kind === 'added' && !decoration.inline),
    ).toBe(false);
  });

  it('maps inline review marks through a normal edit without persisting widgets', () => {
    const baseline = 'A paragraph with an old token.\n';
    const current = 'A paragraph with a new token.\n';
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: current, target });
    const decorations = buildReviewSemanticDecorations(
      computeReviewDiff(baseline, current),
      activeEditor.getScrollSyncSnapshot(),
    );
    activeEditor.setReviewDecorations(decorations ?? []);

    const view = (activeEditor as unknown as { view: EditorView }).view;
    view.dispatch(view.state.tr.insertText('Note: ', 1));

    expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toContain('old');
    expect(
      Array.from(target.querySelectorAll('.review-semantic-added-inline'))
        .map((node) => node.textContent)
        .join(''),
    ).toContain('new');
    expect(activeEditor.flushMarkdown()).toContain('Note: A paragraph with a new token.');
  });

  it('renders every nearby inline edit from the real multilingual review fixture', () => {
    const baseline = '你好\n\nhello \n\njob ctl\n';
    const current = '你好，世界\n\nhello \n\njob control\n';
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: current, target });
    const decorations = buildReviewSemanticDecorations(
      computeReviewDiff(baseline, current),
      activeEditor.getScrollSyncSnapshot(),
    );

    expect(decorations).not.toBeNull();
    activeEditor.setReviewDecorations(decorations ?? []);
    // Each contiguous current-side insertion is one stable semantic mark;
    // the unchanged `t` in `ctl` -> `control` remains unmarked.
    expect(target.querySelectorAll('.review-semantic-added-inline')).toHaveLength(3);
    const addedText = Array.from(target.querySelectorAll('.review-semantic-added-inline'))
      .map((node) => node.textContent ?? '')
      .join('');
    expect(addedText).toContain('，世界');
    expect(addedText).toContain('onro');
    expect(target.querySelectorAll('.review-semantic-deleted')).toHaveLength(0);
    expect(target.textContent).toContain('你好');
    expect(activeEditor.flushMarkdown()).toContain('job control');
    expect(activeEditor.flushMarkdown()).toBe(current);
  });

  it.each([
    ['one trailing space', 'before \n', 'after \n'],
    ['Markdown hard-break spaces', 'before  \n', 'after  \n'],
    ['only a trailing-space change', 'same\n', 'same \n'],
  ])('renders semantic review marks for %s', (_name, baseline, current) => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: current, target });
    const decorations = buildReviewSemanticDecorations(
      computeReviewDiff(baseline, current),
      activeEditor.getScrollSyncSnapshot(),
    );

    expect(decorations).not.toBeNull();
    activeEditor.setReviewDecorations(decorations ?? []);
    const added = target.querySelector<HTMLElement>('.review-semantic-added');
    expect(added).not.toBeNull();
    expect(target.querySelector('p.review-semantic-added')).toBeNull();
    if (baseline.startsWith('same')) {
      expect(target.querySelectorAll('.review-semantic-deleted')).toHaveLength(0);
      expect(target.querySelector('.review-semantic-added-whitespace')?.textContent).toBe(' ');
    } else {
      expect(target.querySelectorAll('.review-semantic-deleted')).toHaveLength(1);
      // Unchanged paragraph-end spaces must not be marked as newly added.
      expect(target.querySelector('.review-semantic-added-whitespace')).toBeNull();
    }
    expect(activeEditor.flushMarkdown()).toBe(current);
  });

  it('renders additions and deleted widgets without changing Markdown', () => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: '# Title\n\nBody\n', target });
    const snapshot = activeEditor.getScrollSyncSnapshot();
    const blocks = snapshot.anchors.filter(
      (anchor) => anchor.depth === 0 && anchor.edge === 'start' && anchor.kind !== 'eof',
    );
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    const body = blocks.find((anchor) => anchor.fromLine === 3) ?? blocks.at(-1)!;
    activeEditor.setReviewDecorations([
      { id: 'added-body', kind: 'added', from: body.pos, to: body.endPos },
      {
        id: 'deleted-before-body',
        kind: 'deleted',
        from: body.pos,
        to: body.pos,
        text: 'Removed\n',
      },
    ]);

    expect(target.querySelector('.review-semantic-added')).not.toBeNull();
    expect(target.querySelector('.review-semantic-deleted')?.textContent).toContain('Removed');
    expect(activeEditor.flushMarkdown()).toBe('# Title\n\nBody\n');

    activeEditor.setReviewDecorations([]);
    expect(target.querySelector('.review-semantic-added')).toBeNull();
    expect(target.querySelector('.review-semantic-deleted')).toBeNull();
  });

  it('does not dispatch a redundant review transaction for identical specs', () => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: 'Body\n', target });
    const view = (activeEditor as unknown as { view: EditorView }).view;
    const dispatch = vi.spyOn(view, 'dispatch');
    const specs = [{ id: 'added', kind: 'added' as const, from: 0, to: 6 }];

    activeEditor.setReviewDecorations(specs);
    activeEditor.setReviewDecorations(specs);

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('refreshes an added decoration when only its trailing whitespace changes', () => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: 'Body  \n', target });
    const block = activeEditor
      .getScrollSyncSnapshot()
      .anchors.find(
        (anchor) => anchor.depth === 0 && anchor.edge === 'start' && anchor.kind !== 'eof',
      );
    expect(block).toBeDefined();
    const view = (activeEditor as unknown as { view: EditorView }).view;
    const dispatch = vi.spyOn(view, 'dispatch');

    activeEditor.setReviewDecorations([
      {
        id: 'added-body',
        kind: 'added',
        from: block!.pos,
        to: block!.endPos,
        trailingWhitespace: ' ',
      },
    ]);
    activeEditor.setReviewDecorations([
      {
        id: 'added-body',
        kind: 'added',
        from: block!.pos,
        to: block!.endPos,
        trailingWhitespace: '  ',
      },
    ]);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(
      target.querySelector<HTMLElement>('.review-semantic-added')?.dataset.reviewTrailingWhitespace,
    ).toBe('  ');
  });

  it('renders a deletion widget at the true document end and ignores stale node ranges', () => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: 'Title\n\nBody\n', target });
    const snapshot = activeEditor.getScrollSyncSnapshot();
    const eof = snapshot.anchors.find((anchor) => anchor.kind === 'eof');
    expect(eof).toBeDefined();

    activeEditor.setReviewDecorations([
      { id: 'deleted-at-eof', kind: 'deleted', from: eof!.endPos, to: eof!.endPos, text: 'Tail\n' },
      { id: 'stale-added', kind: 'added', from: 1, to: 2 },
    ]);

    const deleted = target.querySelector<HTMLElement>('.review-semantic-deleted');
    expect(deleted).not.toBeNull();
    expect(deleted?.getAttribute('contenteditable')).toBe('false');
    expect(deleted?.textContent).toContain('Tail');
    expect(target.querySelector('.review-semantic-added')).toBeNull();
    expect(activeEditor.flushMarkdown()).toBe('Title\n\nBody\n');
  });

  it('renders a deletion before the first block and keeps replacement marks together', () => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: 'new\n', target });
    const snapshot = activeEditor.getScrollSyncSnapshot();
    const first = snapshot.anchors.find(
      (anchor) => anchor.depth === 0 && anchor.edge === 'start' && anchor.kind !== 'eof',
    );
    expect(first).toBeDefined();

    activeEditor.setReviewDecorations([
      { id: 'deleted-at-start', kind: 'deleted', from: first!.pos, to: first!.pos, text: 'old\n' },
      { id: 'added-at-start', kind: 'added', from: first!.pos, to: first!.endPos },
    ]);

    const deleted = target.querySelector('.review-semantic-deleted');
    const added = target.querySelector('.review-semantic-added');
    expect(deleted?.textContent).toContain('old');
    expect(added?.textContent).toContain('new');
    expect(
      deleted && added && deleted.compareDocumentPosition(added) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(activeEditor.flushMarkdown()).toBe('new\n');
  });

  it('keeps an EOF deletion widget visible when the current document is empty', () => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: '', target });
    const eof = activeEditor
      .getScrollSyncSnapshot()
      .anchors.find((anchor) => anchor.kind === 'eof');
    expect(eof).toBeDefined();

    activeEditor.setReviewDecorations([
      {
        id: 'deleted-empty-doc',
        kind: 'deleted',
        from: eof!.endPos,
        to: eof!.endPos,
        text: 'Removed\n',
      },
    ]);

    expect(target.querySelector('.review-semantic-deleted')?.textContent).toContain('Removed');
    expect(activeEditor.flushMarkdown()).toBe('');
  });

  it('restores decorations that were set before the view is mounted', () => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: 'Draft\n' });
    activeEditor.setReviewDecorations([
      // A paragraph containing five characters has a seven-position node
      // range once the view is mounted.
      { id: 'pre-mount-added', kind: 'added', from: 0, to: 7 },
      { id: 'pre-mount-deleted', kind: 'deleted', from: 0, to: 0, text: 'Old\n' },
    ]);
    activeEditor.mount(target);

    expect(target.querySelector('.review-semantic-added')).not.toBeNull();
    expect(target.querySelector('.review-semantic-deleted')?.textContent).toContain('Old');
  });

  it('maps transient decorations through edits and clears them when the view is rebuilt', () => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: 'First\n\nSecond\n', target });
    const second = activeEditor
      .getScrollSyncSnapshot()
      .anchors.find(
        (anchor) => anchor.depth === 0 && anchor.edge === 'start' && anchor.fromLine === 3,
      );
    expect(second).toBeDefined();

    activeEditor.setReviewDecorations([
      { id: 'added-second', kind: 'added', from: second!.pos, to: second!.endPos },
      {
        id: 'deleted-before-second',
        kind: 'deleted',
        from: second!.pos,
        to: second!.pos,
        text: 'Old\n',
      },
    ]);
    const view = (activeEditor as unknown as { view: EditorView }).view;
    view.dispatch(view.state.tr.insertText(' changed', second!.pos + 1 + 'Second'.length));

    expect(target.querySelector('.review-semantic-added')?.textContent).toContain('Second changed');
    expect(target.querySelector('.review-semantic-deleted')?.textContent).toContain('Old');
    expect(activeEditor.flushMarkdown()).toContain('Second changed');

    activeEditor.setMarkdown('Rebuilt\n', { reason: 'programmatic-update' });
    expect(target.querySelector('.review-semantic-added')).toBeNull();
    expect(target.querySelector('.review-semantic-deleted')).toBeNull();
    expect(activeEditor.flushMarkdown()).toBe('Rebuilt\n');
  });

  it('keeps mapped decoration positions when an equivalent semantic view is rebuilt', () => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: 'First\n\nSecond\n', target });
    const second = activeEditor
      .getScrollSyncSnapshot()
      .anchors.find(
        (anchor) => anchor.depth === 0 && anchor.edge === 'start' && anchor.fromLine === 3,
      );
    expect(second).toBeDefined();

    activeEditor.setReviewDecorations([
      { id: 'added-second', kind: 'added', from: second!.pos, to: second!.endPos },
      {
        id: 'deleted-before-second',
        kind: 'deleted',
        from: second!.pos,
        to: second!.pos,
        text: 'Old\n',
      },
    ]);

    const view = (activeEditor as unknown as { view: EditorView }).view;
    view.dispatch(
      view.state.tr.insert(
        second!.pos,
        schema.nodes.paragraph.create(null, schema.text('Inserted')),
      ),
    );
    expect(target.querySelector('.review-semantic-added')?.textContent).toContain('Second');

    const current = activeEditor.flushMarkdown();
    activeEditor.setMarkdown(current, { reason: 'programmatic-update' });

    const added = target.querySelector('.review-semantic-added');
    expect(added?.textContent).toContain('Second');
    expect(added?.textContent).not.toContain('Inserted');
    expect(target.querySelector('.review-semantic-deleted')?.textContent).toContain('Old');
  });

  it('maps an EOF deletion widget when the current document is edited to empty', () => {
    const target = document.createElement('div');
    activeEditor = createEditorCore({ markdown: 'Keep\n', target });
    const eof = activeEditor
      .getScrollSyncSnapshot()
      .anchors.find((anchor) => anchor.kind === 'eof');
    expect(eof).toBeDefined();
    activeEditor.setReviewDecorations([
      { id: 'tail', kind: 'deleted', from: eof!.endPos, to: eof!.endPos, text: 'Tail\n' },
    ]);

    const view = (activeEditor as unknown as { view: EditorView }).view;
    expect(() => view.dispatch(view.state.tr.delete(0, view.state.doc.content.size))).not.toThrow();
    expect(target.querySelector('.review-semantic-deleted')?.textContent).toContain('Tail');
    expect(activeEditor.flushMarkdown()).toBe('');
  });
});
