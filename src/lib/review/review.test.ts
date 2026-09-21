import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReviewSourceDecorations, buildUnifiedPatch, computeReviewDiff } from './review';

describe('Git review diff model', () => {
  it('keeps a local character deletion local to its line', () => {
    const diff = computeReviewDiff(
      'A long paragraph with a removable phrase in the middle.\n',
      'A long paragraph with a in the middle.\n',
    );
    const inlineChanges = diff.hunks[0]?.inlineChanges ?? [];
    expect(inlineChanges).toHaveLength(1);
    expect(inlineChanges[0]).toMatchObject({
      baseLine: 1,
      currentLine: 1,
      edits: [{ kind: 'delete', text: 'removable phrase ' }],
    });
  });

  it('splits multiple local edits and preserves Unicode offsets', () => {
    const diff = computeReviewDiff('前缀 alpha 中段 beta 结尾\n', '前缀 omega 中段 γ 结尾\n');
    const edits = diff.hunks[0]?.inlineChanges?.[0]?.edits ?? [];
    expect(
      edits
        .filter((edit) => edit.kind === 'delete')
        .map((edit) => edit.text)
        .join(''),
    ).toContain('lpha');
    expect(
      edits
        .filter((edit) => edit.kind === 'insert')
        .map((edit) => edit.text)
        .join(''),
    ).toContain('omeg');
    expect(edits.some((edit) => edit.text === 'γ')).toBe(true);
    expect(edits.every((edit) => Number.isInteger(edit.currentOffset))).toBe(true);
  });

  it('groups nearby insertions and deletions into one Git-style hunk', () => {
    const diff = computeReviewDiff('one\ntwo\nthree\n', 'one\nnew\ntwo\n');
    expect(diff.changed).toBe(true);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.changes).toHaveLength(2);
    expect(diff.changes.map((change) => change.kind)).toEqual(['insert', 'delete']);
    expect(diff.changes.map((change) => change.parentHunkId)).toEqual(['review-1', 'review-1']);
    expect(diff.hunks[0].kind).toBe('replace');
    expect(diff.hunks[0].newLines).toEqual(['new\n']);
    expect(diff.hunks[0].oldLines).toEqual(['three\n']);
    expect(diff.addedLines).toEqual([2]);
    expect(diff.deletedLines).toEqual([
      { line: 4, baseLine: 3, text: 'three\n', hunkId: 'review-1' },
    ]);
    expect(diff.hunks[0].lines.map((line) => `${line.kind}:${line.text}`)).toEqual([
      'context:one',
      'insert:new',
      'context:two',
      'delete:three',
    ]);
  });

  it('keeps distant changes in separate hunks', () => {
    const baseline = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join('\n');
    const current = baseline.replace('line 2', 'changed 2').replace('line 12', 'changed 12');
    expect(computeReviewDiff(baseline, current).hunks).toHaveLength(2);
  });

  it('merges changes separated by six context lines but not seven', () => {
    const baseline =
      Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
    const sixApart = baseline.replace('line 1', 'changed 1').replace('line 8', 'changed 8');
    const sevenApart = baseline.replace('line 1', 'changed 1').replace('line 9', 'changed 9');
    const merged = computeReviewDiff(baseline, sixApart);
    expect(merged.hunks).toHaveLength(1);
    expect(merged.changes).toHaveLength(2);
    expect(computeReviewDiff(baseline, sevenApart).hunks).toHaveLength(2);
  });

  it('keeps a contiguous deletion and insertion as one replacement change', () => {
    const diff = computeReviewDiff(
      'before\nold one\nold two\nafter\n',
      'before\nnew one\nnew two\nafter\n',
    );
    expect(diff.hunks).toHaveLength(1);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      kind: 'replace',
      oldLines: ['old one\n', 'old two\n'],
      newLines: ['new one\n', 'new two\n'],
    });
  });

  it('separates nearby edits in the real multilingual review fixture', () => {
    const baseline = '你好\n\nhello \n\njob ctl\n';
    const current = '你好，世界\n\nhello \n\njob control\n';
    const diff = computeReviewDiff(baseline, current);

    expect(diff.hunks).toHaveLength(1);
    expect(diff.changes).toHaveLength(2);
    expect(diff.changes.map((change) => [change.oldLines, change.newLines])).toEqual([
      [['你好\n'], ['你好，世界\n']],
      [['job ctl\n'], ['job control\n']],
    ]);
  });

  it.each([
    ['one trailing space', 'before\n', 'after \n'],
    ['Markdown hard-break spaces', 'before\n', 'after  \n'],
    ['only a trailing-space change', 'same\n', 'same \n'],
  ])('keeps %s in the diff and source decorations', (_name, baseline, current) => {
    const diff = computeReviewDiff(baseline, current);

    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].oldLines).toEqual([baseline]);
    expect(diff.changes[0].newLines).toEqual([current]);
    expect(diff.addedLines).toEqual([1]);
    expect(buildReviewSourceDecorations(diff)).toEqual([
      { line: 1, kind: 'deleted', text: baseline },
      {
        line: 1,
        kind: 'added',
        trailingWhitespace: current.match(/[\t ]+$/m)?.[0],
      },
    ]);
  });

  it('builds a unified patch with accurate ranges and context', () => {
    const baseline = 'alpha\nbeta\ngamma\n';
    const current = 'alpha\nBETA\ngamma\n';
    const diff = computeReviewDiff(baseline, current);
    const patch = buildUnifiedPatch('notes\\paper.md', baseline, current, diff.hunks[0]);
    expect(patch).toContain('--- a/notes/paper.md');
    expect(patch).toContain('+++ b/notes/paper.md');
    expect(patch).toContain('@@ -1,3 +1,3 @@');
    expect(patch).toContain('-beta');
    expect(patch).toContain('+BETA');
    expect(patch).toContain(' alpha');
    expect(patch).toContain(' gamma');
  });

  it('uses zero-count ranges for insertion into an empty file and deletion to an empty file', () => {
    const insertion = computeReviewDiff('', 'new\n').hunks[0];
    expect(insertion.patchBaseStart).toBe(0);
    expect(insertion.patchBaseCount).toBe(0);
    expect(insertion.patchCurrentStart).toBe(1);
    expect(insertion.patchCurrentCount).toBe(1);
    expect(buildUnifiedPatch('empty.md', '', 'new\n', insertion)).toContain('@@ -0,0 +1 @@');

    const deletion = computeReviewDiff('old\n', '').hunks[0];
    expect(deletion.patchBaseStart).toBe(1);
    expect(deletion.patchBaseCount).toBe(1);
    expect(deletion.patchCurrentStart).toBe(0);
    expect(deletion.patchCurrentCount).toBe(0);
    expect(buildUnifiedPatch('empty.md', 'old\n', '', deletion)).toContain('@@ -1 +0,0 @@');
  });

  it('keeps zero-range headers and no-final-newline markers for empty-file edits', () => {
    const insertion = computeReviewDiff('', 'new').hunks[0];
    expect(insertion).toMatchObject({
      patchBaseStart: 0,
      patchBaseCount: 0,
      patchCurrentStart: 1,
      patchCurrentCount: 1,
    });
    expect(buildUnifiedPatch('empty.md', '', 'new', insertion)).toContain('@@ -0,0 +1 @@');
    expect(buildUnifiedPatch('empty.md', '', 'new', insertion)).toContain(
      '+new\n\\ No newline at end of file',
    );

    const deletion = computeReviewDiff('old', '').hunks[0];
    expect(buildUnifiedPatch('empty.md', 'old', '', deletion)).toContain('@@ -1 +0,0 @@');
    expect(buildUnifiedPatch('empty.md', 'old', '', deletion)).toContain(
      '-old\n\\ No newline at end of file',
    );
  });

  it('uses the same current insertion anchor for a multi-line deletion', () => {
    const diff = computeReviewDiff('removed one\nremoved two\nkeep\n', 'keep\n');
    expect(diff.deletedLines.map((line) => line.line)).toEqual([1, 1]);

    const eof = computeReviewDiff('keep\nremoved one\nremoved two\n', 'keep\n');
    expect(eof.deletedLines.map((line) => line.line)).toEqual([2, 2]);
  });

  it('exposes the same insertion anchor on unified delete lines and source specs', () => {
    const diff = computeReviewDiff('keep\nremoved one\nremoved two\n', 'keep\n');
    expect(
      diff.hunks[0].lines
        .filter((line) => line.kind === 'delete')
        .map((line) => line.currentAnchorLine),
    ).toEqual([2, 2]);
    expect(buildReviewSourceDecorations(diff)).toEqual([
      { line: 2, kind: 'deleted', text: 'removed one\nremoved two\n' },
    ]);
  });

  it('preserves no-final-newline markers', () => {
    const diff = computeReviewDiff('before', 'after');
    const patch = buildUnifiedPatch('notes.md', 'before', 'after', diff.hunks[0]);
    expect(patch).toContain('-before\n\\ No newline at end of file');
    expect(patch).toContain('+after\n\\ No newline at end of file');
  });

  it('produces a patch that Git can stage for only the selected hunk', () => {
    let root = '';
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      root = mkdtempSync(join(tmpdir(), 'nomo-review-'));
      const path = join(root, 'paper.md');
      const baseline =
        Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
      const current = baseline.replace('line 2', 'changed 2').replace('line 12', 'changed 12');
      writeFileSync(path, baseline);
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Nomo Test'], { cwd: root });
      execFileSync('git', ['add', '--', 'paper.md'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
      writeFileSync(path, current);

      const diff = computeReviewDiff(baseline, current);
      expect(diff.hunks).toHaveLength(2);
      const patch = buildUnifiedPatch('paper.md', baseline, current, diff.hunks[0]);
      execFileSync('git', ['apply', '--cached', '--recount', '--whitespace=nowarn'], {
        cwd: root,
        input: patch,
      });
      const staged = execFileSync('git', ['show', ':paper.md'], { cwd: root, encoding: 'utf8' });
      expect(staged).toContain('changed 2');
      expect(staged).toContain('line 12');
      expect(staged).not.toContain('changed 12');
    } catch (error) {
      if (error instanceof Error && /ENOENT|not found/i.test(error.message)) return;
      throw error;
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('stages only one change from a merged hunk and leaves the adjacent edit unstaged', () => {
    let root = '';
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      root = mkdtempSync(join(tmpdir(), 'nomo-review-change-'));
      const path = join(root, 'paper.md');
      const baseline = `${Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')}\n`;
      const current = baseline.replace('line 2', 'changed 2').replace('line 8', 'changed 8');
      writeFileSync(path, baseline);
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Nomo Test'], { cwd: root });
      execFileSync('git', ['add', '--', 'paper.md'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
      writeFileSync(path, current);

      const diff = computeReviewDiff(baseline, current);
      expect(diff.hunks).toHaveLength(1);
      expect(diff.changes).toHaveLength(2);
      execFileSync('git', ['apply', '--cached', '--recount', '--whitespace=nowarn'], {
        cwd: root,
        input: buildUnifiedPatch('paper.md', baseline, current, diff.changes[0]),
      });

      const staged = execFileSync('git', ['show', ':paper.md'], { cwd: root, encoding: 'utf8' });
      expect(staged).toContain('changed 2');
      expect(staged).toContain('line 8');
      expect(staged).not.toContain('changed 8');
      expect(
        execFileSync('git', ['diff', '--', 'paper.md'], { cwd: root, encoding: 'utf8' }),
      ).toContain('+changed 8');
      execFileSync('git', ['commit', '-qm', 'accept first change'], { cwd: root });
      const newBaseline = execFileSync('git', ['show', 'HEAD:paper.md'], {
        cwd: root,
        encoding: 'utf8',
      });
      const remaining = computeReviewDiff(newBaseline, current);
      expect(remaining.changes).toHaveLength(1);
      expect(remaining.changes[0].newLines).toEqual(['changed 8\n']);
    } catch (error) {
      if (error instanceof Error && /ENOENT|not found/i.test(error.message)) return;
      throw error;
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'an earlier insertion',
      (baseline: string) => `intro\n${baseline.replace('line 7', 'changed 7')}`,
    ],
    [
      'an earlier deletion',
      (baseline: string) => baseline.replace('line 1\n', '').replace('line 7', 'changed 7'),
    ],
  ])('applies a later change independently after %s shifts current line numbers', (_name, edit) => {
    let root = '';
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      root = mkdtempSync(join(tmpdir(), 'nomo-review-shifted-change-'));
      const path = join(root, 'paper.md');
      const baseline = `${Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')}\n`;
      const current = edit(baseline);
      writeFileSync(path, baseline);
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Nomo Test'], { cwd: root });
      execFileSync('git', ['add', '--', 'paper.md'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
      writeFileSync(path, current);

      const diff = computeReviewDiff(baseline, current);
      expect(diff.hunks).toHaveLength(1);
      expect(diff.changes).toHaveLength(2);
      execFileSync('git', ['apply', '--cached', '--recount', '--whitespace=nowarn'], {
        cwd: root,
        input: buildUnifiedPatch('paper.md', baseline, current, diff.changes[1]),
      });
      const staged = execFileSync('git', ['show', ':paper.md'], { cwd: root, encoding: 'utf8' });
      expect(staged).toContain('changed 7');
      expect(staged).not.toContain('intro');
      expect(staged).toContain('line 1');
    } catch (error) {
      if (error instanceof Error && /ENOENT|not found/i.test(error.message)) return;
      throw error;
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates a Git-applicable patch for a path with spaces and non-ASCII characters', () => {
    let root = '';
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      root = mkdtempSync(join(tmpdir(), 'nomo-review-path-'));
      const relativePath = 'papers/论文 draft.md';
      const path = join(root, relativePath);
      const baseline = 'before\n';
      const current = 'after\n';
      mkdirSync(join(root, 'papers'));
      writeFileSync(path, baseline);
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Nomo Test'], { cwd: root });
      execFileSync('git', ['add', '--', relativePath], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
      writeFileSync(path, current);

      const hunk = computeReviewDiff(baseline, current).hunks[0];
      execFileSync('git', ['apply', '--cached', '--recount', '--whitespace=nowarn'], {
        cwd: root,
        input: buildUnifiedPatch(relativePath, baseline, current, hunk),
      });
      expect(
        execFileSync('git', ['show', `:${relativePath}`], { cwd: root, encoding: 'utf8' }),
      ).toBe(current);
    } catch (error) {
      if (error instanceof Error && /ENOENT|not found/i.test(error.message)) return;
      throw error;
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['insert at start', 'one\ntwo\n', 'zero\none\ntwo\n'],
    ['insert at end', 'one\ntwo\n', 'one\ntwo\nthree\n'],
    ['delete at start', 'zero\none\ntwo\n', 'one\ntwo\n'],
    ['delete at end', 'one\ntwo\nthree\n', 'one\ntwo\n'],
    ['replace at start', 'old\ntwo\n', 'new\ntwo\n'],
    ['replace at end', 'one\nold', 'one\nnew'],
    ['empty to content', '', 'first\nsecond\n'],
    ['empty to CRLF content', '', 'first\r\nsecond\r\n'],
    ['content to empty', 'first\nsecond\n', ''],
    ['no-final-newline insertion', 'one', 'one\ntwo'],
    ['no-final-newline deletion', 'one\ntwo', 'one'],
    ['one trailing-space replacement', 'old \n', 'new \n'],
    ['Markdown hard-break spaces', 'old\n', 'new  \n'],
    ['only a trailing-space change', 'same\n', 'same \n'],
  ])('creates a Git-applicable patch for %s', (_name, baseline, current) => {
    let root = '';
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      root = mkdtempSync(join(tmpdir(), 'nomo-review-boundary-'));
      const path = join(root, 'paper.md');
      writeFileSync(path, baseline);
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Nomo Test'], { cwd: root });
      execFileSync('git', ['add', '--', 'paper.md'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
      writeFileSync(path, current);

      const diff = computeReviewDiff(baseline, current);
      expect(diff.hunks.length).toBeGreaterThan(0);
      for (const hunk of diff.hunks) {
        const patch = buildUnifiedPatch('paper.md', baseline, current, hunk);
        execFileSync('git', ['apply', '--cached', '--recount', '--whitespace=nowarn'], {
          cwd: root,
          input: patch,
        });
      }
      const staged = execFileSync('git', ['show', ':paper.md'], { cwd: root, encoding: 'buffer' });
      expect(staged.toString()).toBe(current);
    } catch (error) {
      if (error instanceof Error && /ENOENT|not found/i.test(error.message)) return;
      throw error;
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['nearby mixed edits', 'a\nb\nc\nd\ne\nf\ng\n', 'zero\na\nB\nc\nY\ne\nf\nlast\n'],
    ['repeated lines', 'same\nkeep\nsame\n', 'same\nnew\nkeep\nsame\n'],
    ['CRLF working copy against LF baseline', 'one\ntwo\nthree\n', 'one\r\nTWO\r\nthree\r\n'],
    ['CRLF baseline and working copy', 'one\r\ntwo\r\nthree\r\n', 'one\r\nTWO\r\nthree\r\n'],
  ])('applies a complete mixed patch for %s', (_name, baseline, current) => {
    let root = '';
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      root = mkdtempSync(join(tmpdir(), 'nomo-review-mixed-'));
      const path = join(root, 'paper.md');
      writeFileSync(path, baseline);
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Nomo Test'], { cwd: root });
      execFileSync('git', ['add', '--', 'paper.md'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
      writeFileSync(path, current);

      const diff = computeReviewDiff(baseline, current);
      expect(diff.hunks.length).toBeGreaterThan(0);
      for (const hunk of diff.hunks) {
        execFileSync('git', ['apply', '--cached', '--recount', '--whitespace=nowarn'], {
          cwd: root,
          input: buildUnifiedPatch('paper.md', baseline, current, hunk),
        });
      }
      const staged = execFileSync('git', ['show', ':paper.md'], {
        cwd: root,
        encoding: 'buffer',
      }).toString();
      const expected =
        current.includes('\r\n') && baseline.includes('\r\n')
          ? current
          : current.replace(/\r\n/g, '\n');
      expect(staged).toBe(expected);
    } catch (error) {
      if (error instanceof Error && /ENOENT|not found/i.test(error.message)) return;
      throw error;
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an empty diff for identical content', () => {
    const diff = computeReviewDiff('same', 'same');
    expect(diff).toEqual({
      baseline: 'same',
      current: 'same',
      hunks: [],
      changes: [],
      addedLines: [],
      deletedLines: [],
      changed: false,
    });
  });

  it('stages deterministic mixed line edits from the same unified hunk model', () => {
    let root = '';
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      root = mkdtempSync(join(tmpdir(), 'nomo-review-matrix-'));
      const path = join(root, 'paper.md');
      const baseline = `${Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join('\n')}\n`;
      writeFileSync(path, baseline);
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Nomo Test'], { cwd: root });
      execFileSync('git', ['add', '--', 'paper.md'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });

      const variants = [
        `${baseline.replace('line 1', 'changed 1').replace('line 20', 'changed 20')}tail\n`,
        `inserted\n${baseline.replace('line 8', 'changed 8')}`,
        baseline.replace('line 1\nline 2\n', '').replace('line 23\nline 24\n', ''),
        baseline.replace('line 12\n', 'line 12a\nline 12b\n'),
        '',
      ];
      for (const current of variants) {
        writeFileSync(path, current);
        execFileSync('git', ['reset', '-q', '--mixed', 'HEAD'], { cwd: root });
        const diff = computeReviewDiff(baseline, current);
        for (const hunk of diff.hunks) {
          execFileSync('git', ['apply', '--cached', '--recount', '--whitespace=nowarn'], {
            cwd: root,
            input: buildUnifiedPatch('paper.md', baseline, current, hunk),
          });
        }
        const staged = execFileSync('git', ['show', ':paper.md'], { cwd: root });
        expect(staged.toString()).toBe(current);
      }
    } catch (error) {
      if (error instanceof Error && /ENOENT|not found/i.test(error.message)) return;
      throw error;
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });
});
