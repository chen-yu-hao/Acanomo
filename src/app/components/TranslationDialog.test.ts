import { cleanup, fireEvent, render } from '@testing-library/svelte/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TranslationDialog from './TranslationDialog.svelte';

describe('TranslationDialog', () => {
  afterEach(cleanup);

  it('renders the original text, direction, result and actions in-app', async () => {
    const handlers = {
      onClose: vi.fn(),
      onRetry: vi.fn(),
      onCopy: vi.fn(),
    };
    const { container } = render(TranslationDialog, {
      props: {
        open: true,
        interfaceLocale: 'zh-CN',
        sourceText: '你好',
        result: { translatedText: 'Hello', sourceLanguage: 'zh-CN', targetLanguage: 'en' },
        ...handlers,
      },
    });

    expect(container.querySelector('.translation-dialog')).not.toBeNull();
    expect(container.querySelector('.translation-text.original')?.textContent).toContain('你好');
    expect(container.querySelector('.translation-direction')?.textContent).toContain('中文');
    expect(container.querySelector('.result-pane .translation-text')?.textContent).toContain('Hello');
    await fireEvent.click(container.querySelector('.translation-copy')!);
    await fireEvent.click(container.querySelector('.translation-footer .primary')!);
    expect(handlers.onCopy).toHaveBeenCalledOnce();
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it('offers retry without leaving the dialog when translation fails', async () => {
    const handlers = { onClose: vi.fn(), onRetry: vi.fn(), onCopy: vi.fn() };
    const { container } = render(TranslationDialog, {
      props: {
        open: true,
        interfaceLocale: 'en-US',
        sourceText: 'Hello',
        error: 'Translation failed',
        ...handlers,
      },
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Translation failed');
    await fireEvent.click(container.querySelector('.translation-button.secondary')!);
    expect(handlers.onRetry).toHaveBeenCalledOnce();
  });
});
