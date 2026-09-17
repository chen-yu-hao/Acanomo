import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AcademicDialog from './AcademicDialog.svelte';

vi.mock('../../lib/services/zotero', () => ({
  searchZotero: vi.fn(async () => [
    { key: 'MRHTZ5CI', title: 'Pair-density theory', date: '2015' },
  ]),
}));

const callbacks = () => ({
  onClose: vi.fn(),
  onInsert: vi.fn(),
  onSettings: vi.fn(),
  onLabel: vi.fn(),
  onReference: vi.fn(),
});

describe('AcademicDialog', () => {
  afterEach(cleanup);

  it('combines searched Zotero items with pasted citation clusters', async () => {
    const handlers = callbacks();
    const { container } = render(AcademicDialog, {
      props: {
        mode: 'citation',
        interfaceLocale: 'zh-CN',
        settings: { equationNumbering: 'auto', citationStyle: 'numeric' },
        ...handlers,
      },
    });
    await waitFor(() => expect(container.querySelector('.result')).not.toBeNull());
    await fireEvent.click(container.querySelector('.result')!);
    const inputs = container.querySelectorAll('input');
    await fireEvent.input(inputs[1], { target: { value: '[@D9PGQUM4; @T4IQZGRM]' } });
    await fireEvent.click(container.querySelector('footer .primary')!);
    expect(handlers.onInsert).toHaveBeenCalledWith(['MRHTZ5CI', 'D9PGQUM4', 'T4IQZGRM']);
  });

  it('applies section numbering and author-year citations', async () => {
    const handlers = callbacks();
    const { container } = render(AcademicDialog, {
      props: {
        mode: 'settings',
        interfaceLocale: 'en-US',
        settings: { equationNumbering: 'auto', citationStyle: 'numeric' },
        ...handlers,
      },
    });
    const selects = container.querySelectorAll('select');
    await fireEvent.change(selects[0], { target: { value: 'section' } });
    await fireEvent.change(selects[1], { target: { value: 'author-year' } });
    await fireEvent.click(container.querySelector('footer .primary')!);
    expect(handlers.onSettings).toHaveBeenCalledWith({
      equationNumbering: 'section',
      citationStyle: 'author-year',
    });
  });
});
