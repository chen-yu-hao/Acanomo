import { cleanup, fireEvent, render } from '@testing-library/svelte/pure';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeReviewDiff } from '../../lib/review/review';
import ReviewPanel from './ReviewPanel.svelte';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ReviewPanel', () => {
  it('renders the unified line stream and uses the parent selection', async () => {
    const diff = computeReviewDiff('before\nold\nafter\n', 'before\nnew\nafter\n');
    const onSelectionChange = vi.fn();
    const onAcceptChange = vi.fn();
    const { container, rerender } = render(ReviewPanel, {
      props: {
        diff,
        selectedChangeId: diff.changes[0].id,
        onAcceptChange,
        onSelectionChange,
      },
    });

    expect(container.querySelectorAll('.review-detail-line')).toHaveLength(4);
    expect(
      container.querySelector('.review-detail-deleted .review-detail-marker')?.textContent,
    ).toBe('-');
    expect(container.querySelector('.review-detail-added .review-detail-marker')?.textContent).toBe(
      '+',
    );
    expect(
      container.querySelector('.review-detail-deleted .review-detail-number')?.textContent,
    ).toBe('2');
    expect(
      container.querySelectorAll('.review-detail-added .review-detail-number')[1]?.textContent,
    ).toBe('2');

    await fireEvent.click(container.querySelector<HTMLButtonElement>('.review-action-accept')!);
    expect(onAcceptChange).toHaveBeenCalledWith(diff.changes[0]);

    await rerender({ selectedChangeId: '' });
    expect(container.querySelector('.review-detail')?.textContent).toContain('old');
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('lists nearby edits separately even when Git merges them into one hunk', async () => {
    const baseline = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
    const current = baseline.replace('line 2', 'changed 2').replace('line 8', 'changed 8');
    const diff = computeReviewDiff(baseline, current);
    const onSelectionChange = vi.fn();
    const { container, rerender } = render(ReviewPanel, {
      props: { diff, selectedChangeId: diff.changes[0].id, onSelectionChange },
    });

    expect(diff.hunks).toHaveLength(1);
    expect(diff.changes).toHaveLength(2);
    expect(container.querySelector('.review-count')?.textContent).toContain('2');
    expect(container.querySelectorAll('.review-change')).toHaveLength(2);

    await fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.review-change')[1]);
    expect(onSelectionChange).toHaveBeenCalledWith(diff.changes[1]);

    await rerender({ selectedChangeId: diff.changes[1].id });
    expect(
      container.querySelector('.review-detail-deleted .review-detail-number')?.textContent,
    ).toBe('8');
    expect(
      container.querySelectorAll('.review-detail-added .review-detail-number')[1]?.textContent,
    ).toBe('8');
  });

  it('shows every line in a long contiguous replacement', () => {
    const diff = computeReviewDiff(
      'before\nold 1\nold 2\nold 3\nafter\n',
      'before\nnew 1\nnew 2\nnew 3\nafter\n',
    );
    const { container } = render(ReviewPanel, {
      props: { diff, selectedChangeId: diff.changes[0].id },
    });

    expect(container.querySelectorAll('.review-detail-deleted')).toHaveLength(3);
    expect(container.querySelectorAll('.review-detail-added')).toHaveLength(3);
    expect(container.querySelector('.review-detail')?.textContent).toContain('old 3');
    expect(container.querySelector('.review-detail')?.textContent).toContain('new 3');
    expect(container.querySelector('.review-change-list')).not.toBeNull();
  });

  it('shows Git no-final-newline markers from the unified line model', () => {
    const diff = computeReviewDiff('old', 'new');
    const { container } = render(ReviewPanel, {
      props: { diff, selectedChangeId: diff.changes[0].id },
    });
    expect(container.querySelectorAll('.review-detail-no-newline')).toHaveLength(2);
    expect(container.textContent).toContain('No newline at end of file');
  });

  it('preserves trailing spaces in replacement rows', () => {
    const diff = computeReviewDiff('old \n', 'new  \n');
    const { container } = render(ReviewPanel, {
      props: { diff, selectedChangeId: diff.changes[0].id },
    });
    const rows = [...container.querySelectorAll<HTMLElement>('.review-detail-text')];

    expect(rows.find((row) => row.closest('.review-detail-deleted'))?.textContent).toBe('old ');
    expect(rows.find((row) => row.closest('.review-detail-added'))?.textContent).toBe('new  ');
  });

  it('keeps the change list and full detail independently scrollable', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/app/styles/app.css'), 'utf8');
    expect(styles).toMatch(
      /\.review-change-list\s*\{[^}]*max-height:\s*38%;[^}]*overflow:\s*auto;/,
    );
    expect(styles).toMatch(
      /\.review-detail\s*\{[^}]*flex:\s*1 1 0;[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/,
    );
    expect(styles).not.toMatch(/\.review-detail\s*\{[^}]*max-height:\s*220px;/);
    expect(styles).toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.review-panel\s*\{[^}]*flex:\s*0 0 clamp\(300px, 48vh, 380px\);[^}]*max-height:\s*none;/,
    );
  });
});
