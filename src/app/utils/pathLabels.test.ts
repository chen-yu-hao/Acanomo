import { describe, expect, it } from 'vitest';
import { resolveDocumentAssetPath } from './pathLabels';

describe('resolveDocumentAssetPath', () => {
  it('resolves relative image sources beside a Windows document', () => {
    expect(resolveDocumentAssetPath('C:\\papers\\draft.md', './assets/figure.png')).toBe(
      'C:/papers/./assets/figure.png',
    );
  });

  it('keeps Windows drive and UNC paths instead of treating them as URI schemes', () => {
    expect(resolveDocumentAssetPath('C:\\papers\\draft.md', 'D:\\figures\\plot.png')).toBe(
      'D:\\figures\\plot.png',
    );
    expect(resolveDocumentAssetPath('C:\\papers\\draft.md', '\\\\server\\share\\plot.png')).toBe(
      '\\\\server\\share\\plot.png',
    );
    expect(resolveDocumentAssetPath('C:\\papers\\draft.md', 'D:%5Cfigures%5Cplot.png')).toBe(
      'D:\\figures\\plot.png',
    );
  });

  it('ignores remote and embedded image sources', () => {
    expect(resolveDocumentAssetPath('/papers/draft.md', 'https://example.com/plot.png')).toBeNull();
    expect(resolveDocumentAssetPath('/papers/draft.md', '//example.com/plot.png')).toBeNull();
    expect(resolveDocumentAssetPath('/papers/draft.md', 'data:image/png;base64,AA==')).toBeNull();
  });
});
