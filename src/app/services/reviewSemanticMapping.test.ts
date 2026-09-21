import { describe, expect, it } from 'vitest';
import { computeReviewDiff } from '../../lib/review/review';
import { buildReviewSemanticDecorations } from './reviewSemanticMapping';
import type { EditorSyncSnapshot } from '../../lib/editor-core/scrollSyncMapping';

function snapshot(markdown: string, anchors: EditorSyncSnapshot['anchors']): EditorSyncSnapshot {
  return { revision: 1, renderRevision: 1, ready: true, markdown, anchors };
}

const block = (
  fromLine: number,
  toLine: number,
  pos: number,
  endPos: number,
  kind = 'paragraph',
) => ({
  key: `${pos}:start`,
  fromLine,
  toLine,
  pos,
  endPos,
  kind,
  edge: 'start' as const,
  depth: 0,
});

const inlineBlock = (line: number, text: string, pos = 0) => ({
  ...block(line, line, pos, pos + text.length + 2),
  textContent: text,
  contentSize: text.length,
});

describe('semantic review line mapping', () => {
  it('maps a local deletion to an inline widget instead of the whole block', () => {
    const current = 'A long paragraph with a in the middle.\n';
    const diff = computeReviewDiff(
      'A long paragraph with a removable phrase in the middle.\n',
      current,
    );
    const decorations = buildReviewSemanticDecorations(
      diff,
      snapshot(current, [
        inlineBlock(1, 'A long paragraph with a in the middle.'),
        {
          key: 'eof',
          fromLine: 2,
          toLine: 2,
          pos: 0,
          endPos: current.length + 1,
          kind: 'eof',
          edge: 'end',
          depth: 0,
        },
      ]),
    );

    expect(decorations).toEqual([
      {
        id: 'review-1:inline-1:deleted-1',
        kind: 'deleted',
        from: 25,
        to: 25,
        text: 'removable phrase ',
        inline: true,
      },
    ]);
  });

  it('maps link text using parsed semantic positions instead of Markdown offsets', () => {
    const current = '[new](https://example.test)\n';
    const diff = computeReviewDiff('[old](https://example.test)\n', current);
    const decorations = buildReviewSemanticDecorations(
      diff,
      snapshot(current, [
        {
          ...inlineBlock(1, 'new', 0),
          endPos: 5,
        },
        {
          key: 'eof',
          fromLine: 2,
          toLine: 2,
          pos: 0,
          endPos: 5,
          kind: 'eof',
          edge: 'end',
          depth: 0,
        },
      ]),
    );

    expect(decorations).toEqual([
      expect.objectContaining({ kind: 'deleted', inline: true, from: 1, to: 1, text: 'old' }),
      expect.objectContaining({ kind: 'added', inline: true, from: 1, to: 4 }),
    ]);
  });

  it('does not hide a changed citation atom while mapping surrounding text', () => {
    const current = 'Result [@NEWKEY].\n';
    const diff = computeReviewDiff('Result [@OLDKEY].\n', current);
    const decorations = buildReviewSemanticDecorations(
      diff,
      snapshot(current, [
        {
          ...inlineBlock(1, 'Result .', 0),
          contentSize: 9,
          endPos: 11,
        },
        {
          key: 'eof',
          fromLine: 2,
          toLine: 2,
          pos: 0,
          endPos: 11,
          kind: 'eof',
          edge: 'end',
          depth: 0,
        },
      ]),
    );

    expect(decorations).toEqual([
      expect.objectContaining({ kind: 'deleted', inline: true, from: 8, text: '[@OLDKEY]' }),
      expect.objectContaining({ kind: 'added', inline: true, from: 8, to: 9 }),
    ]);
  });

  it('does not hide a citation atom moved within the same paragraph', () => {
    const current = 'Result remains [@D9PGQUM4].\n';
    const diff = computeReviewDiff('Result [@D9PGQUM4] remains.\n', current);
    const decorations = buildReviewSemanticDecorations(
      diff,
      snapshot(current, [
        {
          ...inlineBlock(1, 'Result remains .', 0),
          contentSize: 17,
          endPos: 19,
        },
        {
          key: 'eof',
          fromLine: 2,
          toLine: 2,
          pos: 0,
          endPos: 19,
          kind: 'eof',
          edge: 'end',
          depth: 0,
        },
      ]),
    );

    expect(decorations?.every((decoration) => decoration.inline)).toBe(true);
    expect(decorations?.some((decoration) => decoration.kind === 'added')).toBe(true);
    expect(decorations?.some((decoration) => decoration.kind === 'deleted')).toBe(true);
    expect(decorations?.find((decoration) => decoration.kind === 'deleted')?.text).toContain(
      '[@D9PGQUM4]',
    );
  });

  it('marks the top-level block covering an inserted line', () => {
    const current = '# Title\n\nchanged\n';
    const diff = computeReviewDiff('# Title\n\nold\n', current);
    const decorations = buildReviewSemanticDecorations(
      diff,
      snapshot(current, [
        block(1, 1, 0, 8, 'heading'),
        block(3, 3, 8, 17),
        { ...block(4, 4, 8, 17), key: '8:end', edge: 'end' },
        {
          key: 'eof',
          fromLine: 5,
          toLine: 5,
          pos: 8,
          endPos: 17,
          kind: 'eof',
          edge: 'end',
          depth: 0,
        },
      ]),
    );
    expect(decorations).toEqual([
      { id: 'review-1:added:8:3', kind: 'added', from: 8, to: 17 },
      { id: 'review-1:deleted:8', kind: 'deleted', from: 8, to: 8, text: 'old\n' },
    ]);
  });

  it('anchors a deletion to the next top-level block, not a containing block', () => {
    const current = '- keep\n\nAfter\n';
    const diff = computeReviewDiff('- keep\n- removed\n\nAfter\n', current);
    const decorations = buildReviewSemanticDecorations(
      diff,
      snapshot(current, [
        block(1, 1, 0, 10, 'bullet_list'),
        block(3, 3, 10, 17),
        {
          key: 'eof',
          fromLine: 4,
          toLine: 4,
          pos: 10,
          endPos: 17,
          kind: 'eof',
          edge: 'end',
          depth: 0,
        },
      ]),
    );
    expect(decorations).toContainEqual({
      id: 'review-1:deleted:10',
      kind: 'deleted',
      from: 10,
      to: 10,
      text: '- removed\n',
    });
  });

  it('uses EOF for a deletion after the last block', () => {
    const current = 'Keep\n';
    const diff = computeReviewDiff('Keep\nTail\n', current);
    const decorations = buildReviewSemanticDecorations(
      diff,
      snapshot(current, [
        block(1, 1, 0, 6),
        {
          key: 'eof',
          fromLine: 3,
          toLine: 3,
          pos: 0,
          endPos: 6,
          kind: 'eof',
          edge: 'end',
          depth: 0,
        },
      ]),
    );
    expect(decorations).toContainEqual({
      id: 'review-1:deleted:6',
      kind: 'deleted',
      from: 6,
      to: 6,
      text: 'Tail\n',
    });
  });

  it('returns null when a changed line has no reliable semantic anchor', () => {
    const current = 'new\n';
    const diff = computeReviewDiff('', current);
    expect(buildReviewSemanticDecorations(diff, snapshot(current, []))).toBeNull();
  });

  it('keeps a real inserted block visible when the hunk also inserts a blank separator', () => {
    const current = 'Existing\n\nNew block\n';
    const diff = computeReviewDiff('Existing\n', current);
    const decorations = buildReviewSemanticDecorations(
      diff,
      snapshot(current, [
        block(1, 1, 0, 10),
        block(3, 3, 10, 21),
        {
          key: 'eof',
          fromLine: 4,
          toLine: 4,
          pos: 10,
          endPos: 21,
          kind: 'eof',
          edge: 'end',
          depth: 0,
        },
      ]),
    );

    expect(decorations).toContainEqual({
      id: 'review-1:added:10:3',
      kind: 'added',
      from: 10,
      to: 21,
    });
  });
});
