import { afterEach, describe, expect, it } from 'vitest';
import type { EditorView } from 'prosemirror-view';
import { createEditorCore } from './createEditorCore';
import type { EditorCore } from './types';
import { computeReviewDiff } from '../review/review';
import { buildReviewSemanticDecorations } from '../../app/services/reviewSemanticMapping';
import { schema } from './schema';

let editor: EditorCore | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

const targetText =
  '用于训练 MC25 的激发能数据集，包括 TM-SpinSplitting10 和 MG-SpinSplitting20 激发能数据库，以及 QUESTDB 的垂直激发能 [@FIRST; @SECOND]。对于所有激发能数据，激发能和 descriptors 均使用与 MC25 工作相同的波函数计算。';
const fixtures = [
  ['tight bullet list', `- Unchanged first [@KEEP].\n- ${targetText}\n- Unchanged last.`],
  ['loose bullet list', `- Unchanged first [@KEEP].\n\n- ${targetText}\n\n- Unchanged last.`],
  ['ordered list', `1. Unchanged first.\n2. ${targetText}\n3. Unchanged last.`],
  [
    'nested bullet list',
    `- Parent item\n  - Unchanged child\n  - ${targetText}\n  - Last child\n- Unchanged last.`,
  ],
  [
    'mixed nested list',
    `1. Parent item\n   - Unchanged child\n   - ${targetText}\n2. Unchanged last.`,
  ],
  ['second paragraph of an item', `- First paragraph\n\n  ${targetText}\n\n- Unchanged last.`],
  ['multiline item', `- First item\n- Item start\n  ${targetText}\n  Item end\n- Last item`],
  ['blockquote', `> Unchanged first.\n>\n> ${targetText}\n>\n> Unchanged last.`],
  ['list in blockquote', `> - Unchanged first.\n> - ${targetText}\n> - Unchanged last.`],
  ['callout', `> [!NOTE]\n> Unchanged first.\n>\n> ${targetText}\n>\n> Unchanged last.`],
] as const;

function mount(markdown: string) {
  const target = document.createElement('div');
  editor = createEditorCore({ markdown, target });
  return { target, view: (editor as unknown as { view: EditorView }).view };
}

function refresh(baseline: string) {
  const current = editor!.getMarkdown();
  const snapshot = editor!.getScrollSyncSnapshot();
  const decorations = buildReviewSemanticDecorations(
    computeReviewDiff(baseline, current),
    snapshot,
  );
  expect(snapshot.ready).toBe(true);
  expect(decorations).not.toBeNull();
  editor!.setReviewDecorations(decorations ?? []);
  expect(editor!.getMarkdown()).toBe(current);
  return { current, decorations: decorations! };
}

describe('review changes inside containers', () => {
  it.each(fixtures)('keeps a short deletion local in %s', (_name, baseline) => {
    const { target, view } = mount(baseline);
    const match = editor!.findSearchMatches('ting20 ', { caseSensitive: true })[0];
    expect(match).toBeDefined();
    view.dispatch(view.state.tr.delete(match.from, match.to));
    const { current, decorations } = refresh(baseline);
    expect(decorations).toHaveLength(1);
    expect(decorations[0]).toMatchObject({
      kind: 'deleted',
      inline: true,
      from: match.from,
      text: 'ting20 ',
    });
    expect(target.querySelector('.review-semantic-added')).toBeNull();
    expect(
      target.querySelector('.review-semantic-deleted-inline')?.closest('p')?.textContent,
    ).toContain(targetText);
    expect(current).toContain('MG-SpinSplit激发能');
    expect(current).not.toContain('ting20');
  });

  it.each(fixtures)('keeps additions and citation deletion local in %s', (_name, baseline) => {
    const { target, view } = mount(baseline);
    const match = editor!.findSearchMatches('QUESTDB', { caseSensitive: true })[0];
    view.dispatch(view.state.tr.insertText('new ', match.from));
    const first = refresh(baseline);
    expect(first.decorations.filter((d) => d.kind === 'added')).toHaveLength(1);
    expect(
      Array.from(target.querySelectorAll('.review-semantic-added'))
        .map((node) => node.textContent)
        .join(''),
    ).toBe('new ');
    let citation = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'citation' && node.attrs.keys.includes('FIRST')) citation = pos;
    });
    expect(citation).toBeGreaterThan(0);
    view.dispatch(view.state.tr.delete(citation, citation + 1));
    refresh(baseline);
    expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toBe(
      '[@FIRST; @SECOND]',
    );
    expect(
      Array.from(target.querySelectorAll('.review-semantic-added'))
        .map((node) => node.textContent)
        .join(''),
    ).toBe('new ');
    expect(
      target.querySelector(
        'ul.review-semantic-added, ol.review-semantic-added, blockquote.review-semantic-added',
      ),
    ).toBeNull();
  });

  it.each([0, 1, 2])('marks only the inserted list item at index %i', (index) => {
    const lines = ['- Keep first.', '- Keep last.'];
    const baseline = lines.join('\n');
    lines.splice(index, 0, '- New item [@NEW].');
    const { target } = mount(lines.join('\n'));
    refresh(baseline);
    expect(target.querySelector('ul.review-semantic-added, ol.review-semantic-added')).toBeNull();
    expect(target.querySelectorAll('p.review-semantic-added')).toHaveLength(1);
    expect(target.querySelector('p.review-semantic-added')?.textContent).toBe('New item [@NEW].');
    expect(target.querySelector('.review-semantic-deleted')).toBeNull();
  });

  it.each([0, 1, 2])('does not mark surviving items when removing list item %i', (index) => {
    const lines = ['- Remove first.', '- Remove middle.', '- Remove last.'];
    const baseline = lines.join('\n');
    const [removed] = lines.splice(index, 1);
    const { target } = mount(lines.join('\n'));
    refresh(baseline);
    expect(target.querySelector('.review-semantic-added')).toBeNull();
    expect(target.querySelector('.review-semantic-deleted')?.textContent).toContain(removed);
    expect(editor!.getMarkdown()).toBe(lines.join('\n'));
  });

  it.each([
    ['- Prefix\n  old middle\n  Last', '- Prefix\n  Last', 'old middle\n'],
    [
      '- **First** [@ONE]\n- Second old [@TWO]\n- Last',
      '- **First** [@ONE]\n- Second [@TWO]\n- Last',
      'old ',
    ],
    ['- First old\n- Second old\n- Last', '- First new\n- Second new\n- Last', 'oldold'],
  ])('keeps neighboring list text edits independent: %s', (baseline, current, deleted) => {
    const { target } = mount(current);
    const { decorations } = refresh(baseline);
    expect(
      decorations
        .filter((d) => d.kind === 'deleted')
        .map((d) => d.text)
        .join(''),
    ).toBe(deleted);
    expect(decorations.every((d) => d.inline)).toBe(true);
    expect(target.querySelector('ul.review-semantic-added, li.review-semantic-added')).toBeNull();
  });

  it('does not hide a real list-to-paragraph structural change', () => {
    const { target } = mount('Same words');
    const { decorations } = refresh('- Same words');
    expect(decorations.some((d) => d.kind === 'deleted')).toBe(true);
    expect(target.querySelector('.review-semantic-added')?.textContent).toBe('Same words');
  });

  it.each(fixtures)(
    'preserves other edits when adding trailing spaces in %s',
    (_name, baseline) => {
      const { target, view } = mount(baseline);
      const match = editor!.findSearchMatches('ting20 ', { caseSensitive: true })[0];
      view.dispatch(view.state.tr.delete(match.from, match.to));
      refresh(baseline);
      const ending = editor!.findSearchMatches('波函数计算。', { caseSensitive: true })[0];
      const block = view.state.doc.resolve(ending.to);
      view.dispatch(view.state.tr.insertText('   ', block.end()));
      refresh(baseline);
      expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toBe('ting20 ');
      expect(
        Array.from(target.querySelectorAll('.review-semantic-added'))
          .map((node) => node.textContent)
          .join(''),
      ).toBe('   ');
      const current = editor!.getMarkdown();
      editor!.updateOptions({ mode: 'source' });
      editor!.setMarkdown(current);
      editor!.updateOptions({ mode: 'semantic' });
      refresh(baseline);
      expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toBe('ting20 ');
      expect(editor!.getMarkdown()).toBe(current);
    },
  );

  describe.each(['Alpha beta [@CITE].', '**Alpha beta** [@CITE].'])(
    'leading-word deletion in %s',
    (text) => {
      it.each(fixtures)('keeps literal leading spaces and local review in %s', (_name, fixture) => {
        const baseline = fixture.replace(targetText, text);
        const { target, view } = mount(baseline);
        const match = editor!.findSearchMatches('Alpha', { caseSensitive: true })[0];
        view.dispatch(view.state.tr.delete(match.from, match.to));
        const { current } = refresh(baseline);
        expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toBe('Alpha');
        expect(target.querySelector('.review-semantic-added')).toBeNull();
        const content = view.state.doc;
        editor!.updateOptions({ mode: 'source' });
        editor!.setMarkdown(current);
        editor!.updateOptions({ mode: 'semantic' });
        refresh(baseline);
        expect((editor as unknown as { view: EditorView }).view.state.doc.eq(content)).toBe(true);
        expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toBe('Alpha');
        expect(target.querySelector('.review-semantic-added')).toBeNull();

        // Typing at the start of the surviving mark can create unmarked text
        // before a marked leading space, as native browser input does.
        const currentView = (editor as unknown as { view: EditorView }).view;
        const leading = editor!.findSearchMatches(' beta', { caseSensitive: true })[0];
        currentView.dispatch(currentView.state.tr.insert(leading.from, schema.text('New')));
        const edited = refresh(baseline).current;
        expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toBe('Alpha');
        expect(
          Array.from(target.querySelectorAll('.review-semantic-added'))
            .map((node) => node.textContent)
            .join(''),
        ).toBe('New');
        editor!.updateOptions({ mode: 'source' });
        editor!.setMarkdown(edited);
        editor!.updateOptions({ mode: 'semantic' });
        refresh(baseline);
        expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toBe('Alpha');
        expect(
          Array.from(target.querySelectorAll('.review-semantic-added'))
            .map((node) => node.textContent)
            .join(''),
        ).toBe('New');
      });
    },
  );

  it.each(['', '- ', '> '])(
    'keeps local review after deleting at a formatting boundary in %j',
    (prefix) => {
      const baseline = `${prefix}Before **Alpha beta** after.`;
      const { target, view } = mount(baseline);
      const match = editor!.findSearchMatches('beta', { caseSensitive: true })[0];
      view.dispatch(view.state.tr.delete(match.from, match.to));
      refresh(baseline);
      expect(target.querySelector('.review-semantic-deleted-inline')?.textContent).toBe('beta');
      expect(target.querySelector('.review-semantic-added')).toBeNull();
      expect(target.querySelector('strong')?.textContent).toContain('Alpha');
    },
  );
});
