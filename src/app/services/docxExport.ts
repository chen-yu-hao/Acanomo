const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const CSL_CITATION_SCHEMA =
  'https://github.com/citation-style-language/schema/raw/master/csl-citation.json';
const NATURE_STYLE_ID = 'http://www.zotero.org/styles/nature';
const APA_STYLE_ID = 'http://www.zotero.org/styles/apa';
const FIELD_CHUNK_SIZE = 240;
const EMU_PER_PIXEL = 9_525;
const MAX_IMAGE_WIDTH_EMU = 5_731_510;
const MAX_IMAGE_HEIGHT_EMU = 8_000_000;

export interface ZoteroWordExportItem {
  key: string;
  /** Canonical Zotero URI, for example http://zotero.org/users/123/items/ABCD1234. */
  uri: string;
  /** CSL JSON returned by Zotero's format=csljson or include=csljson API. */
  itemData: Record<string, unknown>;
  citationHtml?: string;
  /** Zotero `include=bib` HTML fetched with the same style as citationStyle. */
  bibliographyHtml?: string;
}

export interface ZoteroApiExportRecord {
  key: string;
  csljson?: string | Record<string, unknown> | Array<Record<string, unknown>>;
  citation?: string;
  bib?: string;
}

export type DocxCitationIssueReason = 'missing-item' | 'invalid-uri' | 'invalid-item-data';

export interface DocxCitationIssue {
  key: string;
  reason: DocxCitationIssueReason;
  message: string;
}

export interface AcademicDocxInput {
  renderedHtml: string;
  title: string;
  zoteroItems: readonly ZoteroWordExportItem[];
  /** Optional stable value for deterministic tests. */
  sessionId?: string;
  locale?: string;
  zoteroVersion?: string;
  citationStyle?: 'numeric' | 'author-year';
}

export interface AcademicDocxBuildResult {
  bytes: Uint8Array;
  warnings: string[];
  citationIssues: DocxCitationIssue[];
}

interface ValidatedItem extends ZoteroWordExportItem {
  itemData: Record<string, unknown> & { id: string };
}

interface BuildContext {
  items: Map<string, ValidatedItem>;
  citationNumbers: Map<string, number>;
  warnings: string[];
  citationIssues: DocxCitationIssue[];
  sessionId: string;
  citationSequence: number;
  citationStyle: 'numeric' | 'author-year';
  images: EmbeddedImage[];
}

type EmbeddedImageFormat = 'png' | 'jpeg' | 'gif' | 'bmp';

interface EmbeddedImage {
  relationshipId: string;
  fileName: string;
  extension: 'png' | 'jpg' | 'gif' | 'bmp';
  contentType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/bmp';
  bytes: Uint8Array;
  widthEmu: number;
  heightEmu: number;
}

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  code?: boolean;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Converts one Zotero local-API record into the exact CSL payload expected by Word fields.
 * The raw Web API `data` object is intentionally not accepted as a fallback.
 */
export function zoteroApiRecordToWordItem(
  record: ZoteroApiExportRecord,
): ZoteroWordExportItem | null {
  let parsed: unknown = record.csljson;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  const itemData = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRecord(itemData) || typeof itemData.id !== 'string') return null;
  return {
    key: record.key,
    uri: itemData.id,
    itemData,
    citationHtml: record.citation,
    bibliographyHtml: record.bib,
  };
}

/** Build a self-contained, uncompressed DOCX package suitable for a binary save command. */
export function buildAcademicDocx(input: AcademicDocxInput): AcademicDocxBuildResult {
  const parser = new DOMParser();
  const htmlDocument = parser.parseFromString(input.renderedHtml, 'text/html');
  const citationIssues: DocxCitationIssue[] = [];
  const items = validateItems(input.zoteroItems, citationIssues);
  const citationNumbers = collectCitationNumbers(htmlDocument.body);
  const context: BuildContext = {
    items,
    citationNumbers,
    warnings: [],
    citationIssues,
    sessionId: normalizeSessionId(input.sessionId),
    citationSequence: 0,
    citationStyle: input.citationStyle ?? 'numeric',
    images: [],
  };

  const body = serializeBlockChildren(htmlDocument.body, context);
  const hasCitations = citationNumbers.size > 0;
  const hasBibliography = htmlDocument.body.querySelector('.bibliography-block') !== null;
  if (hasCitations && !hasBibliography) {
    context.warnings.push('未找到参考文献占位符，已在文末追加 Zotero 参考文献域。');
    body.push(...bibliographyBlocks(context));
  }
  if (!body.length) body.push(paragraphXml(''));

  // Zotero's Word integration reads document preferences from the XML payload
  // stored in ZOTERO_PREF_n custom properties. `zoteroPreferencesXml` emits
  // the Zotero 9 XML form rather than opaque JSON so the fields remain
  // refreshable in Word.
  const documentPreferences = zoteroPreferencesXml({
    citationStyle: context.citationStyle,
    locale: input.locale ?? 'en-US',
    // A bibliography placeholder is itself a Zotero bibliography field, even
    // when the document currently has no resolved citation items. When no
    // placeholder is present, citations cause a bibliography field to be
    // appended above, so either condition must be reflected in the document
    // preferences consumed by Zotero's Word integration.
    hasBibliography: hasBibliography || hasCitations,
    sessionId: context.sessionId,
    zoteroVersion: input.zoteroVersion ?? '9.0',
  });

  const entries: ZipEntry[] = [
    textEntry('[Content_Types].xml', contentTypesXml(context.images)),
    textEntry('_rels/.rels', packageRelationshipsXml()),
    textEntry('docProps/core.xml', corePropertiesXml(input.title)),
    textEntry('docProps/app.xml', appPropertiesXml()),
    textEntry('docProps/custom.xml', customPropertiesXml(documentPreferences)),
    textEntry('word/document.xml', documentXml(body.join(''))),
    textEntry('word/styles.xml', stylesXml()),
    textEntry('word/settings.xml', settingsXml()),
    textEntry('word/fontTable.xml', fontTableXml()),
    textEntry('word/footer1.xml', footerXml()),
    textEntry('word/_rels/document.xml.rels', documentRelationshipsXml(context.images)),
    ...context.images.map((image) => ({
      name: `word/media/${image.fileName}`,
      data: image.bytes,
    })),
  ];

  return {
    bytes: createStoredZip(entries),
    warnings: context.warnings,
    citationIssues: context.citationIssues,
  };
}

function validateItems(
  source: readonly ZoteroWordExportItem[],
  issues: DocxCitationIssue[],
): Map<string, ValidatedItem> {
  const result = new Map<string, ValidatedItem>();
  for (const item of source) {
    const key = item.key.trim();
    if (!key) continue;
    if (!isCanonicalZoteroUri(item.uri, key)) {
      issues.push({
        key,
        reason: 'invalid-uri',
        message: `Zotero 条目 ${key} 缺少与 key 匹配的规范 URI。`,
      });
      continue;
    }
    const cslId = item.itemData?.id;
    if (typeof cslId !== 'string' || cslId !== item.uri) {
      issues.push({
        key,
        reason: 'invalid-item-data',
        message: `Zotero 条目 ${key} 的 itemData 不是匹配 URI 的 CSL JSON。`,
      });
      continue;
    }
    result.set(key, item as ValidatedItem);
  }
  return result;
}

function isCanonicalZoteroUri(uri: string, key: string): boolean {
  return new RegExp(
    `^https?://zotero\\.org/(?:users/(?:\\d+|local/\\w+)|groups/\\d+)/items/${escapeRegExp(key)}$`,
    'i',
  ).test(uri);
}

function collectCitationNumbers(root: ParentNode): Map<string, number> {
  const result = new Map<string, number>();
  for (const node of root.querySelectorAll<HTMLElement>('.citation-node[data-citation-keys]')) {
    for (const key of citationKeys(node)) {
      if (!result.has(key)) result.set(key, result.size + 1);
    }
  }
  return result;
}

function serializeBlockChildren(parent: ParentNode, context: BuildContext): string[] {
  const blocks: string[] = [];
  for (const node of parent.childNodes) serializeBlockNode(node, context, blocks);
  return blocks;
}

function serializeBlockNode(node: Node, context: BuildContext, blocks: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.textContent?.trim()) blocks.push(paragraphXml(runXml(node.textContent)));
    return;
  }
  if (!(node instanceof HTMLElement)) return;
  if (node.matches('script, style, button, textarea, .ProseMirror-widget')) return;

  if (node.classList.contains('bibliography-block')) {
    blocks.push(...bibliographyBlocks(context));
    return;
  }

  const tag = node.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) {
    blocks.push(paragraphXml(inlineChildrenXml(node, context), `Heading${tag.slice(1)}`));
    return;
  }
  if (tag === 'p') {
    blocks.push(paragraphXml(inlineChildrenXml(node, context)));
    return;
  }
  if (tag === 'ul' || tag === 'ol') {
    serializeList(node, context, blocks, 0, tag === 'ol');
    return;
  }
  if (tag === 'blockquote') {
    const content = inlineChildrenXml(node, context) || runXml(node.textContent ?? '');
    blocks.push(paragraphXml(content, 'Quote'));
    return;
  }
  if (tag === 'pre') {
    blocks.push(paragraphXml(runXml(node.textContent ?? '', { code: true }), 'Code'));
    return;
  }
  if (tag === 'table') {
    blocks.push(tableXml(node, context));
    return;
  }
  if (node.classList.contains('math-block')) {
    const tex = node.dataset.tex?.trim() ?? '';
    addLinearMathWarning(context);
    blocks.push(paragraphXml(displayMathXml(tex || node.textContent || ''), 'Equation'));
    return;
  }
  if (tag === 'img' || node.querySelector(':scope > img')) {
    const image = tag === 'img' ? node : node.querySelector<HTMLImageElement>(':scope > img');
    blocks.push(paragraphXml(imageXml(image, context), 'Caption'));
    return;
  }
  if (tag === 'hr') {
    blocks.push(paragraphXml(''));
    return;
  }

  for (const child of node.childNodes) serializeBlockNode(child, context, blocks);
}

function serializeList(
  list: HTMLElement,
  context: BuildContext,
  blocks: string[],
  depth: number,
  ordered: boolean,
): void {
  let index = 0;
  for (const child of list.children) {
    if (child.tagName.toLowerCase() !== 'li') continue;
    index += 1;
    const prefix = ordered ? `${index}. ` : '\u2022 ';
    let content = runXml(prefix);
    for (const liChild of child.childNodes) {
      if (liChild instanceof HTMLElement && /^(ul|ol)$/i.test(liChild.tagName)) continue;
      if (liChild instanceof HTMLElement && liChild.tagName.toLowerCase() === 'p') {
        content += inlineChildrenXml(liChild, context);
      } else {
        content += inlineNodeXml(liChild, context, {});
      }
    }
    blocks.push(paragraphXml(content, 'ListParagraph', depth));
    for (const nested of child.children) {
      const nestedTag = nested.tagName.toLowerCase();
      if (nestedTag === 'ul' || nestedTag === 'ol') {
        serializeList(nested as HTMLElement, context, blocks, depth + 1, nestedTag === 'ol');
      }
    }
  }
}

function inlineChildrenXml(element: Element, context: BuildContext, style: RunStyle = {}): string {
  let xml = '';
  for (const child of element.childNodes) xml += inlineNodeXml(child, context, style);
  return xml;
}

function inlineNodeXml(node: Node, context: BuildContext, style: RunStyle): string {
  if (node.nodeType === Node.TEXT_NODE) return runXml(node.textContent ?? '', style);
  if (!(node instanceof HTMLElement)) return '';
  if (node.matches('button, textarea, .ProseMirror-widget')) return '';

  if (node.classList.contains('citation-node')) return citationFieldXml(node, context);
  if (node.classList.contains('math-inline')) {
    const tex = node.dataset.tex?.trim() ?? node.textContent?.trim() ?? '';
    addLinearMathWarning(context);
    return inlineMathXml(tex);
  }
  if (node.tagName.toLowerCase() === 'br') return '<w:r><w:br/></w:r>';
  if (node.tagName.toLowerCase() === 'img') {
    return imageXml(node, context, style);
  }

  const tag = node.tagName.toLowerCase();
  const next: RunStyle = {
    ...style,
    bold: style.bold || tag === 'strong' || tag === 'b',
    italic: style.italic || tag === 'em' || tag === 'i',
    underline: style.underline || tag === 'u' || tag === 'a',
    strike: style.strike || tag === 's' || tag === 'del',
    superscript: style.superscript || tag === 'sup',
    subscript: style.subscript || tag === 'sub',
    code: style.code || tag === 'code',
  };
  return inlineChildrenXml(node, context, next);
}

function addLinearMathWarning(context: BuildContext): void {
  const warning =
    'Word 导出将 LaTeX 公式作为可编辑的线性 OMML 文本保留，未执行完整的 TeX 二维公式转换。';
  if (!context.warnings.includes(warning)) context.warnings.push(warning);
}

function inlineMathXml(tex: string): string {
  return `<m:oMath>${mathRunXml(tex)}</m:oMath>`;
}

function displayMathXml(tex: string): string {
  return `<m:oMathPara><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr><m:oMath>${mathRunXml(tex)}</m:oMath></m:oMathPara>`;
}

function mathRunXml(tex: string): string {
  return `<m:r><m:t xml:space="preserve">${escapeXml(tex)}</m:t></m:r>`;
}

function imageXml(
  image: HTMLElement | null,
  context: BuildContext,
  fallbackStyle: RunStyle = {},
): string {
  const label = image?.getAttribute('alt')?.trim() || 'Figure';
  const embedded = image ? registerEmbeddedImage(image.getAttribute('src') ?? '', context) : null;
  if (!embedded) {
    context.warnings.push(`图片“${label}”无法嵌入 Word，仅保留了文字占位。`);
    return runXml(`[${label}]`, fallbackStyle);
  }

  const drawingId = context.images.indexOf(embedded) + 1;
  const description = escapeXml(label);
  const name = escapeXml(embedded.fileName);
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${embedded.widthEmu}" cy="${embedded.heightEmu}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${drawingId}" name="Picture ${drawingId}" descr="${description}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${name}" descr="${description}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${embedded.relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${embedded.widthEmu}" cy="${embedded.heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function registerEmbeddedImage(src: string, context: BuildContext): EmbeddedImage | null {
  const parsed = decodeImageDataUri(src);
  if (!parsed) return null;
  const dimensions = readImageDimensions(parsed.bytes, parsed.format);
  if (!dimensions) return null;

  const naturalWidth = dimensions.width * EMU_PER_PIXEL;
  const naturalHeight = dimensions.height * EMU_PER_PIXEL;
  const scale = Math.min(
    1,
    MAX_IMAGE_WIDTH_EMU / naturalWidth,
    MAX_IMAGE_HEIGHT_EMU / naturalHeight,
  );
  const index = context.images.length + 1;
  const metadata = imageFormatMetadata(parsed.format);
  const image: EmbeddedImage = {
    relationshipId: `rId${index + 4}`,
    fileName: `image${index}.${metadata.extension}`,
    extension: metadata.extension,
    contentType: metadata.contentType,
    bytes: parsed.bytes,
    widthEmu: Math.max(1, Math.round(naturalWidth * scale)),
    heightEmu: Math.max(1, Math.round(naturalHeight * scale)),
  };
  context.images.push(image);
  return image;
}

function decodeImageDataUri(
  src: string,
): { format: EmbeddedImageFormat; bytes: Uint8Array } | null {
  const match = /^data:image\/(png|jpeg|gif|bmp);base64,([\s\S]+)$/i.exec(src.trim());
  if (!match) return null;
  try {
    const binary = atob(match[2].replace(/\s+/g, ''));
    if (!binary.length) return null;
    return {
      format: match[1].toLowerCase() as EmbeddedImageFormat,
      bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    };
  } catch {
    return null;
  }
}

function imageFormatMetadata(format: EmbeddedImageFormat): {
  extension: EmbeddedImage['extension'];
  contentType: EmbeddedImage['contentType'];
} {
  switch (format) {
    case 'jpeg':
      return { extension: 'jpg', contentType: 'image/jpeg' };
    case 'gif':
      return { extension: 'gif', contentType: 'image/gif' };
    case 'bmp':
      return { extension: 'bmp', contentType: 'image/bmp' };
    default:
      return { extension: 'png', contentType: 'image/png' };
  }
}

function readImageDimensions(
  bytes: Uint8Array,
  format: EmbeddedImageFormat,
): { width: number; height: number } | null {
  let width = 0;
  let height = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (
    format === 'png' &&
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR'
  ) {
    width = view.getUint32(16, false);
    height = view.getUint32(20, false);
  } else if (
    format === 'gif' &&
    bytes.length >= 10 &&
    (String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a' ||
      String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a')
  ) {
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
  } else if (format === 'bmp' && bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const dibSize = view.getUint32(14, true);
    if (dibSize === 12) {
      width = view.getUint16(18, true);
      height = view.getUint16(20, true);
    } else if (dibSize >= 40) {
      width = Math.abs(view.getInt32(18, true));
      height = Math.abs(view.getInt32(22, true));
    }
  } else if (format === 'jpeg') {
    const dimensions = readJpegDimensions(bytes);
    width = dimensions?.width ?? 0;
    height = dimensions?.height ?? 0;
  }

  return width > 0 && height > 0 ? { width, height } : null;
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += segmentLength;
  }
  return null;
}

function citationFieldXml(element: HTMLElement, context: BuildContext): string {
  const keys = citationKeys(element);
  const missing = keys.filter((key) => !context.items.has(key));
  if (!keys.length || missing.length) {
    for (const key of missing) addMissingItemIssue(context, key);
    return runXml(`[@${keys.join('; @')}]`);
  }

  const citationItems = keys.map((key) => {
    const item = context.items.get(key)!;
    return {
      id: item.itemData.id,
      uris: [item.uri],
      itemData: item.itemData,
    };
  });
  context.citationSequence += 1;
  const display =
    context.citationStyle === 'numeric'
      ? compactNumberList(keys.map((key) => context.citationNumbers.get(key) ?? 0).filter(Boolean))
      : `(${keys.map((key) => authorYearCitation(context.items.get(key)!)).join('; ')})`;
  const citation = {
    citationID: `${context.sessionId}-${context.citationSequence}`,
    properties: {
      // These values are the cached result Zotero writes into Word fields.
      // Keeping them in the field code lets Zotero refresh without first
      // treating the citation as an unknown/legacy field.
      formattedCitation: display,
      plainCitation: display,
      noteIndex: 0,
    },
    citationItems,
    schema: CSL_CITATION_SCHEMA,
  };
  return complexFieldXml(
    ` ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify(citation)}`,
    runXml(display, { superscript: context.citationStyle === 'numeric' }),
  );
}

function bibliographyBlocks(context: BuildContext): string[] {
  let orderedItems = [...context.citationNumbers]
    .sort((left, right) => left[1] - right[1])
    .map(([key]) => context.items.get(key))
    .filter((item): item is ValidatedItem => Boolean(item));
  if (context.citationStyle === 'author-year') {
    orderedItems = orderedItems.sort((left, right) =>
      bibliographySortKey(left).localeCompare(bibliographySortKey(right), 'en', {
        sensitivity: 'base',
      }),
    );
  }
  const result = orderedItems
    .map((item, index) => bibliographyResultXml(item, index, context))
    .join('<w:r><w:br/></w:r>');
  const bibliographyData = { uncited: [], omitted: [], custom: [] };
  const field = complexFieldXml(
    ` ADDIN ZOTERO_BIBL ${JSON.stringify(bibliographyData)} CSL_BIBLIOGRAPHY`,
    result,
  );
  return [paragraphXml(runXml('References'), 'Heading1'), paragraphXml(field, 'Bibliography')];
}

function tableXml(table: HTMLElement, context: BuildContext): string {
  const rows = [...table.querySelectorAll('tr')];
  const rowXml = rows
    .map((row) => {
      const cells = [...row.children].filter((cell) => /^(td|th)$/i.test(cell.tagName));
      return `<w:tr>${cells
        .map((cell) => {
          const content = inlineChildrenXml(cell, context, {
            bold: cell.tagName.toLowerCase() === 'th',
          });
          return `<w:tc><w:tcPr><w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar></w:tcPr>${paragraphXml(content)}</w:tc>`;
        })
        .join('')}</w:tr>`;
    })
    .join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D9D9D9"/><w:left w:val="single" w:sz="4" w:color="D9D9D9"/><w:bottom w:val="single" w:sz="4" w:color="D9D9D9"/><w:right w:val="single" w:sz="4" w:color="D9D9D9"/><w:insideH w:val="single" w:sz="4" w:color="D9D9D9"/><w:insideV w:val="single" w:sz="4" w:color="D9D9D9"/></w:tblBorders></w:tblPr>${rowXml}</w:tbl>`;
}

function citationKeys(element: HTMLElement): string[] {
  const raw = element.dataset.citationKeys ?? '';
  return [
    ...new Set(
      raw
        .split(';')
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  ];
}

function addMissingItemIssue(context: BuildContext, key: string): void {
  if (
    context.citationIssues.some((issue) => issue.key === key && issue.reason === 'missing-item')
  ) {
    return;
  }
  context.citationIssues.push({
    key,
    reason: 'missing-item',
    message: `未找到 Zotero 条目 ${key} 的 CSL JSON，引用已保留为 Markdown 文本。`,
  });
}

function bibliographyResultXml(item: ValidatedItem, index: number, context: BuildContext): string {
  const prefix = context.citationStyle === 'numeric' ? runXml(`${index + 1}. `) : '';
  if (item.bibliographyHtml) {
    const doc = new DOMParser().parseFromString(item.bibliographyHtml, 'text/html');
    doc.querySelectorAll('.csl-left-margin, .Z3988').forEach((node) => node.remove());
    const content = doc.querySelector('.csl-right-inline, .csl-entry') ?? doc.body;
    return prefix + inlineChildrenXml(content, context);
  }
  const warning = `Zotero 条目 ${item.key} 未提供当前样式的 bibliography HTML，参考文献预览使用后备格式；在 Word 中刷新 Zotero 后会按所选样式重排。`;
  if (!context.warnings.includes(warning)) context.warnings.push(warning);
  return prefix + runXml(bibliographyText(item));
}

function bibliographyText(item: ValidatedItem): string {
  const data = item.itemData;
  const authors = Array.isArray(data.author)
    ? data.author
        .filter(isRecord)
        .map((author) => {
          const family = typeof author.family === 'string' ? stripHtml(author.family) : '';
          const given = typeof author.given === 'string' ? initials(author.given) : '';
          return [family, given].filter(Boolean).join(', ');
        })
        .filter(Boolean)
        .join(', ')
    : '';
  const title = typeof data.title === 'string' ? stripHtml(data.title) : item.key;
  const container =
    typeof data['container-title'] === 'string' ? stripHtml(data['container-title']) : '';
  const volume = typeof data.volume === 'string' ? data.volume : '';
  const page = typeof data.page === 'string' ? data.page : '';
  const year = cslYear(data.issued);
  const doi = typeof data.DOI === 'string' ? ` https://doi.org/${data.DOI}` : '';
  return `${authors ? `${authors}. ` : ''}${title}. ${container}${volume ? ` ${volume}` : ''}${page ? `, ${page}` : ''}${year ? ` (${year})` : ''}.${doi}`
    .replace(/\s+/g, ' ')
    .replace(/\s+\./g, '.')
    .trim();
}

function cslYear(issued: unknown): string {
  if (!isRecord(issued) || !Array.isArray(issued['date-parts'])) return '';
  const first = issued['date-parts'][0];
  return Array.isArray(first) && first[0] != null ? String(first[0]) : '';
}

function authorYearCitation(item: ValidatedItem): string {
  const authors = Array.isArray(item.itemData.author) ? item.itemData.author.filter(isRecord) : [];
  const familyName = (author: Record<string, unknown>) =>
    typeof author.family === 'string'
      ? stripHtml(author.family)
      : typeof author.literal === 'string'
        ? stripHtml(author.literal)
        : 'Unknown';
  const author =
    authors.length === 0
      ? typeof item.itemData.title === 'string'
        ? stripHtml(item.itemData.title)
        : item.key
      : authors.length === 1
        ? familyName(authors[0])
        : authors.length === 2
          ? `${familyName(authors[0])} & ${familyName(authors[1])}`
          : `${familyName(authors[0])} et al.`;
  return `${author}, ${cslYear(item.itemData.issued) || 'n.d.'}`;
}

function bibliographySortKey(item: ValidatedItem): string {
  const authors = Array.isArray(item.itemData.author) ? item.itemData.author.filter(isRecord) : [];
  const firstAuthor = authors[0];
  const author =
    firstAuthor && typeof firstAuthor.family === 'string'
      ? firstAuthor.family
      : typeof item.itemData.title === 'string'
        ? item.itemData.title
        : item.key;
  return `${author}\u0000${cslYear(item.itemData.issued)}\u0000${String(item.itemData.title ?? '')}`;
}

function initials(given: string): string {
  return given
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}.`)
    .join('');
}

function stripHtml(value: string): string {
  const doc = new DOMParser().parseFromString(value, 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function compactNumberList(values: readonly number[]): string {
  const sorted = [...new Set(values)].sort((left, right) => left - right);
  const ranges: string[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const start = sorted[index];
    let end = start;
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) {
      end = sorted[++index];
    }
    ranges.push(
      end > start + 1 ? `${start}\u2013${end}` : end === start + 1 ? `${start},${end}` : `${start}`,
    );
  }
  return ranges.join(',');
}

function complexFieldXml(instruction: string, resultXml: string): string {
  const instructionRuns = chunkText(instruction, FIELD_CHUNK_SIZE)
    .map(
      (chunk) =>
        `<w:r><w:rPr><w:noProof/></w:rPr><w:instrText xml:space="preserve">${escapeXml(chunk)}</w:instrText></w:r>`,
    )
    .join('');
  return `<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>${instructionRuns}<w:r><w:fldChar w:fldCharType="separate"/></w:r>${resultXml}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
}

function chunkText(value: string, size: number): string[] {
  const result: string[] = [];
  for (let index = 0; index < value.length; ) {
    let end = Math.min(index + size, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1;
    result.push(value.slice(index, end));
    index = end;
  }
  return result;
}

function paragraphXml(content: string, style?: string, listDepth = 0): string {
  const properties = [
    style ? `<w:pStyle w:val="${escapeXml(style)}"/>` : '',
    listDepth > 0 ? `<w:ind w:left="${720 * (listDepth + 1)}"/>` : '',
  ].join('');
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${content}</w:p>`;
}

function runXml(text: string, style: RunStyle = {}): string {
  if (!text) return '';
  const properties = [
    style.bold ? '<w:b/>' : '',
    style.italic ? '<w:i/>' : '',
    style.underline ? '<w:u w:val="single"/>' : '',
    style.strike ? '<w:strike/>' : '',
    style.superscript ? '<w:vertAlign w:val="superscript"/>' : '',
    style.subscript ? '<w:vertAlign w:val="subscript"/>' : '',
  ].join('');
  const parts = text.split('\n');
  const content = parts
    .map((part, index) => {
      const before = index > 0 ? '<w:br/>' : '';
      return `${before}<w:t xml:space="preserve">${escapeXml(part)}</w:t>`;
    })
    .join('');
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}${content}</w:r>`;
}

function documentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${WORD_NAMESPACE}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}<w:sectPr><w:footerReference w:type="default" r:id="rId4"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:lnNumType w:countBy="1" w:restart="continuous"/><w:pgNumType w:start="1"/><w:cols w:space="720"/></w:sectPr></w:body></w:document>`;
}

function stylesXml(): string {
  const heading = (level: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${level === 1 ? 360 : 240}" w:after="120" w:line="480" w:lineRule="auto"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:b/><w:color w:val="000000"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${WORD_NAMESPACE}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:color w:val="000000"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="480" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="0" w:line="480" w:lineRule="auto"/><w:jc w:val="left"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/><w:spacing w:after="240" w:line="480" w:lineRule="auto"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
${heading(1)}${heading(2)}${heading(3)}${heading(4)}${heading(5)}${heading(6)}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720" w:right="720"/><w:spacing w:line="480" w:lineRule="auto"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="480" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Bibliography"><w:name w:val="Bibliography"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360" w:hanging="360"/><w:spacing w:after="120" w:line="480" w:lineRule="auto"/><w:jc w:val="left"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Equation"><w:name w:val="Equation"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="480" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
</w:styles>`;
}

function settingsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="${WORD_NAMESPACE}"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:updateFields w:val="true"/></w:settings>`;
}

interface ZoteroPreferencesInput {
  citationStyle: 'numeric' | 'author-year';
  locale: string;
  hasBibliography: boolean;
  sessionId: string;
  zoteroVersion: string;
}

/**
 * Serialize the document preferences understood by Zotero's Word plugin.
 *
 * Zotero stores this XML as an escaped string in one or more `ZOTERO_PREF_n`
 * custom properties. Zotero 9 reads preferences from child `<pref>` elements
 * under `<prefs>`; attributes on `<prefs>` are ignored by its XML parser.
 * Keep the names and values aligned with the payload emitted by Zotero.dotm.
 */
function zoteroPreferencesXml(input: ZoteroPreferencesInput): string {
  const styleId = input.citationStyle === 'numeric' ? NATURE_STYLE_ID : APA_STYLE_ID;
  const hasBibliography = input.hasBibliography ? '1' : '0';
  const locale = input.locale.trim() || 'en-US';
  return `<data data-version="3" zotero-version="${escapeXml(input.zoteroVersion)}"><session id="${escapeXml(input.sessionId)}"/><style id="${escapeXml(styleId)}" locale="${escapeXml(locale)}" hasBibliography="${hasBibliography}" bibliographyStyleHasBeenSet="1"/><prefs><pref name="fieldType" value="Field"/><pref name="noteType" value="0"/><pref name="automaticJournalAbbreviations" value="false"/><pref name="delayCitationUpdates" value="false"/></prefs></data>`;
}

function customPropertiesXml(documentPreferences: string): string {
  const properties = chunkText(documentPreferences, FIELD_CHUNK_SIZE)
    .map(
      (chunk, index) =>
        `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${index + 2}" name="ZOTERO_PREF_${index + 1}"><vt:lpwstr>${escapeXml(chunk)}</vt:lpwstr></property>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${properties}</Properties>`;
}

function fontTableXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:fonts xmlns:w="${WORD_NAMESPACE}"><w:font w:name="Times New Roman"><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font></w:fonts>`;
}

function contentTypesXml(images: readonly EmbeddedImage[]): string {
  const imageDefaults = [...new Map(images.map((image) => [image.extension, image.contentType]))]
    .map(
      ([extension, contentType]) =>
        `<Default Extension="${extension}" ContentType="${contentType}"/>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${imageDefaults}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>`;
}

function packageRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>`;
}

function documentRelationshipsXml(images: readonly EmbeddedImage[]): string {
  const imageRelationships = images
    .map(
      (image) =>
        `<Relationship Id="${image.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${image.fileName}"/>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>${imageRelationships}</Relationships>`;
}

function footerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="${WORD_NAMESPACE}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
}

function corePropertiesXml(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>AcaNomo</dc:creator><cp:lastModifiedBy>AcaNomo</cp:lastModifiedBy></cp:coreProperties>`;
}

function appPropertiesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>AcaNomo</Application><AppVersion>0.5.4</AppVersion></Properties>`;
}

function textEntry(name: string, value: string): ZipEntry {
  return { name, data: new TextEncoder().encode(value) };
}

function createStoredZip(entries: readonly ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length + entry.data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 33, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.data.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 33, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);
  return concatBytes([...localParts, ...centralParts, end]);
}

let crcTable: Uint32Array | undefined;

function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function normalizeSessionId(value?: string): string {
  const normalized = value?.replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
  if (normalized) return normalized;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
