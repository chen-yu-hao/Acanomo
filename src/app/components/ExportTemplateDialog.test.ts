import { cleanup, fireEvent, render } from '@testing-library/svelte/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExportTemplateDialog from './ExportTemplateDialog.svelte';

describe('ExportTemplateDialog', () => {
  afterEach(cleanup);

  it('lists Nature and ACS presets and returns the selected template', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = render(ExportTemplateDialog, {
      props: { open: true, format: 'latex', interfaceLocale: 'zh-CN', onSelect, onClose },
    });

    expect(container.querySelector('.export-template-dialog')).not.toBeNull();
    expect(container.querySelectorAll('.export-template-option')).toHaveLength(2);
    expect(container.textContent).toContain('Nature');
    expect(container.textContent).toContain('ACS');

    await fireEvent.click(container.querySelectorAll('.export-template-option')[1]);
    await fireEvent.click(container.querySelector('.export-template-button.primary')!);
    expect(onSelect).toHaveBeenCalledWith('acs');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes without selecting when cancelled', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = render(ExportTemplateDialog, {
      props: { open: true, format: 'docx', interfaceLocale: 'en-US', onSelect, onClose },
    });

    await fireEvent.click(container.querySelector('.export-template-button.secondary')!);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

