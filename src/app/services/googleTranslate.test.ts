import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectTranslationLanguage, translateText } from './googleTranslate';

describe('googleTranslate', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('detects Chinese and English and rejects unsupported text', () => {
    expect(detectTranslationLanguage('你好，世界')).toBe('zh-CN');
    expect(detectTranslationLanguage('Hello, world')).toBe('en');
    expect(detectTranslationLanguage('123 !!!')).toBeNull();
  });

  it('translates Chinese to English and joins returned segments', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [[['Hello', '你好']], null, 'zh-CN'],
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(translateText('你好')).resolves.toEqual({
      translatedText: 'Hello',
      sourceLanguage: 'zh-CN',
      targetLanguage: 'en',
    });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.origin).toBe('https://translate.googleapis.com');
    expect(url.searchParams.get('sl')).toBe('zh-CN');
    expect(url.searchParams.get('tl')).toBe('en');
    expect(url.searchParams.get('q')).toBe('你好');
  });

  it('translates English to Chinese', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [[['你好', 'Hello']], null, 'en'],
    }));

    await expect(translateText('Hello')).resolves.toMatchObject({
      translatedText: '你好',
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
    });
  });

  it('reports unsupported languages and HTTP failures', async () => {
    await expect(translateText('123')).rejects.toMatchObject({
      code: 'unsupported-language',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    await expect(translateText('Hello')).rejects.toMatchObject({
      code: 'request-failed',
    });
  });
});
