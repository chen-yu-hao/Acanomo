export type TranslationLanguage = 'zh-CN' | 'en';

export interface GoogleTranslationResult {
  translatedText: string;
  sourceLanguage: TranslationLanguage;
  targetLanguage: TranslationLanguage;
}

export type GoogleTranslateErrorCode =
  | 'empty-text'
  | 'unsupported-language'
  | 'request-failed'
  | 'invalid-response';

export class GoogleTranslateError extends Error {
  readonly code: GoogleTranslateErrorCode;

  constructor(code: GoogleTranslateErrorCode, message = code) {
    super(message);
    this.name = 'GoogleTranslateError';
    this.code = code;
  }
}

const GOOGLE_TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

/** Detect the dominant language supported by the in-app translator. */
export function detectTranslationLanguage(text: string): TranslationLanguage | null {
  const chineseCharacters = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latinCharacters = text.match(/[A-Za-z]/g)?.length ?? 0;
  if (chineseCharacters > 0) return 'zh-CN';
  if (latinCharacters > 0) return 'en';
  return null;
}

function parseTranslatedText(payload: unknown): string {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) return '';
  return (payload[0] as unknown[])
    .filter((segment): segment is unknown[] => Array.isArray(segment))
    .map((segment) => (typeof segment[0] === 'string' ? segment[0] : ''))
    .join('');
}

/** Translate Chinese to English or English to Chinese through Google's public text endpoint. */
export async function translateText(
  text: string,
  signal?: AbortSignal,
): Promise<GoogleTranslationResult> {
  const normalizedText = text.trim();
  if (!normalizedText) throw new GoogleTranslateError('empty-text');

  const sourceLanguage = detectTranslationLanguage(normalizedText);
  if (!sourceLanguage) throw new GoogleTranslateError('unsupported-language');
  const targetLanguage: TranslationLanguage = sourceLanguage === 'zh-CN' ? 'en' : 'zh-CN';
  const params = new URLSearchParams({
    client: 'gtx',
    sl: sourceLanguage,
    tl: targetLanguage,
    dt: 't',
    q: normalizedText,
  });

  let response: Response;
  try {
    response = await fetch(`${GOOGLE_TRANSLATE_ENDPOINT}?${params.toString()}`, { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new GoogleTranslateError('request-failed');
  }
  if (!response.ok) throw new GoogleTranslateError('request-failed');

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GoogleTranslateError('invalid-response');
  }
  const translatedText = parseTranslatedText(payload).trim();
  if (!translatedText) throw new GoogleTranslateError('invalid-response');
  return { translatedText, sourceLanguage, targetLanguage };
}
