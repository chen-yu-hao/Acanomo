import { describe, expect, it } from 'vitest';
import { buildUnifiedPatch, computeReviewDiff } from './review';

describe('Git review diff model', () => {
  it('keeps insertions and deletions as selectable hunks', () => {
    const diff = computeReviewDiff('one\ntwo\nthree\n', 'one\nnew\ntwo\n');
    expect(diff.changed).toBe(true);
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0].kind).toBe('insert');
    expect(diff.hunks[0].newLines).toEqual(['new\n']);
    expect(diff.hunks[1].kind).toBe('delete');
    expect(diff.hunks[1].oldLines).toEqual(['three\n']);
    expect(diff.addedLines).toContain(2);
    expect(diff.deletedLines[0].text).toBe('three\n');
  });

  it('builds a unified patch with the selected hunk and context', () => {
    const baseline = 'alpha\nbeta\ngamma\n';
    const current = 'alpha\nBETA\ngamma\n';
    const diff = computeReviewDiff(baseline, current);
    const patch = buildUnifiedPatch('notes/paper.md', baseline, current, diff.hunks[0]);
    expect(patch).toContain('--- a/notes/paper.md');
    expect(patch).toContain('+++ b/notes/paper.md');
    expect(patch).toContain('-beta');
    expect(patch).toContain('+BETA');
    expect(patch).toContain(' alpha');
    expect(patch).toContain(' gamma');
  });

  it('returns an empty diff for identical content', () => {
    const diff = computeReviewDiff('same', 'same');
    expect(diff).toEqual({
      baseline: 'same',
      current: 'same',
      hunks: [],
      addedLines: [],
      deletedLines: [],
      changed: false,
    });
  });
});

