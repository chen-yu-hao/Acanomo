import { describe, expect, it } from 'vitest';
import {
  buildAcademicDocx,
  zoteroApiRecordToWordItem,
  type ZoteroWordExportItem,
} from './docxExport';

const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const gagliardi: ZoteroWordExportItem = {
  key: 'D9PGQUM4',
  uri: 'http://zotero.org/users/20774538/items/D9PGQUM4',
  itemData: {
    id: 'http://zotero.org/users/20774538/items/D9PGQUM4',
    type: 'article-journal',
    'container-title': 'Accounts of Chemical Research',
    DOI: '10.1021/acs.accounts.6b00471',
    issue: '1',
    page: '66-73',
    title:
      'Multiconfiguration Pair-Density Functional Theory: A New Way To Treat Strongly Correlated Systems',
    URL: 'https://doi.org/10.1021/acs.accounts.6b00471',
    volume: '50',
    author: [
      { family: 'Gagliardi', given: 'Laura' },
      { family: 'Truhlar', given: 'Donald G.' },
      { family: 'Li Manni', given: 'Giovanni' },
    ],
    issued: { 'date-parts': [['2017']] },
  },
  citationHtml: '<sup>1</sup>',
};

const liManni: ZoteroWordExportItem = {
  key: 'T4IQZGRM',
  uri: 'http://zotero.org/users/20774538/items/T4IQZGRM',
  itemData: {
    id: 'http://zotero.org/users/20774538/items/T4IQZGRM',
    type: 'article-journal',
    'container-title': 'Journal of Chemical Theory and Computation',
    DOI: '10.1021/ct500483t',
    issue: '9',
    page: '3669-3680',
    title: 'Multiconfiguration Pair-Density Functional Theory',
    volume: '10',
    author: [
      { family: 'Li Manni', given: 'Giovanni' },
      { family: 'Carlson', given: 'Rebecca K.' },
    ],
    issued: { 'date-parts': [['2014']] },
  },
};

describe('academic DOCX export', () => {
  it('creates native Zotero citation and bibliography fields from real CSL JSON', () => {
    const result = buildAcademicDocx({
      title: 'MC PDFT manuscript',
      sessionId: 'NOMOTEST',
      zoteroVersion: '9.0.6',
      zoteroItems: [gagliardi, liManni],
      renderedHtml: [
        '<h1>MC PDFT manuscript</h1>',
        '<p>Prior work <span class="citation-node" data-citation-keys="D9PGQUM4;T4IQZGRM">[1, 2]</span>.</p>',
        '<section class="bibliography-block"><h2>Rendered references must be replaced</h2></section>',
      ].join(''),
    });

    expect(result.bytes.slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
    expect(result.citationIssues).toEqual([]);
    const entries = readStoredZip(result.bytes);
    const documentXml = text(entries, 'word/document.xml');
    const instructions = fieldInstructions(documentXml);
    const citationInstruction = instructions.find((value) =>
      value.includes('ADDIN ZOTERO_ITEM CSL_CITATION'),
    );
    expect(citationInstruction).toBeDefined();
    const citation = JSON.parse(citationInstruction!.slice(citationInstruction!.indexOf('{'))) as {
      citationID: string;
      citationItems: Array<{ id: string; uris: string[]; itemData: Record<string, unknown> }>;
      schema: string;
    };
    expect(citation.citationID).toBe('NOMOTEST-1');
    expect(citation.citationItems).toHaveLength(2);
    expect(citation.citationItems[0]).toMatchObject({
      id: gagliardi.uri,
      uris: [gagliardi.uri],
      itemData: {
        id: gagliardi.uri,
        type: 'article-journal',
        DOI: '10.1021/acs.accounts.6b00471',
      },
    });
    expect(citation).toMatchObject({
      properties: {
        formattedCitation: '1,2',
        plainCitation: '1,2',
        noteIndex: 0,
      },
    });
    expect(citation.schema).toContain('csl-citation.json');
    expect(instructions).toContain(
      ' ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY',
    );
    expect(documentXml).toContain('<w:vertAlign w:val="superscript"/>');
    expect(documentXml).not.toContain('Rendered references must be replaced');
  });

  it('splits long Word field instructions into safe UTF-16 chunks', () => {
    const longItem: ZoteroWordExportItem = {
      ...gagliardi,
      itemData: { ...gagliardi.itemData, abstract: `Long ${'x'.repeat(900)} \ud83d\udcd6` },
    };
    const result = buildAcademicDocx({
      title: 'Long field',
      sessionId: 'NOMOTEST',
      zoteroItems: [longItem],
      renderedHtml: '<p><span class="citation-node" data-citation-keys="D9PGQUM4">[1]</span></p>',
    });
    const xml = text(readStoredZip(result.bytes), 'word/document.xml');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const chunks = [...doc.getElementsByTagNameNS(WORD_NAMESPACE, 'instrText')]
      .map((node) => node.textContent ?? '')
      .filter(
        (value) =>
          value.includes('ZOTERO_ITEM') || value.includes('"citationID"') || value.includes('xxx'),
      );
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((chunk) => chunk.length <= 240)).toBe(true);
    expect(fieldInstructions(xml).join('')).toContain(`Long ${'x'.repeat(900)} \ud83d\udcd6`);
  });

  it('keeps bibliography placement and applies conservative Nature manuscript styles', () => {
    const result = buildAcademicDocx({
      title: 'Layout',
      sessionId: 'NOMOTEST',
      zoteroItems: [gagliardi],
      renderedHtml:
        '<p>Before <span class="citation-node" data-citation-keys="D9PGQUM4">[1]</span></p><section class="bibliography-block"></section><p>After</p>',
    });
    const entries = readStoredZip(result.bytes);
    const document = text(entries, 'word/document.xml');
    expect(document.indexOf('Before')).toBeLessThan(document.indexOf('References'));
    expect(document.indexOf('References')).toBeLessThan(document.indexOf('After'));
    expect(document).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
    expect(document).toContain(
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"',
    );
    expect(document).toContain('<w:lnNumType w:countBy="1" w:restart="continuous"/>');
    expect(document).toContain('<w:footerReference w:type="default" r:id="rId4"/>');

    const styles = text(entries, 'word/styles.xml');
    expect(styles).toContain('w:ascii="Times New Roman"');
    expect(styles).toContain('<w:sz w:val="24"/>');
    expect(styles).toContain('w:line="480"');
    expect(styles).not.toMatch(/<w:sz(?:Cs)? w:val="(?!24")[^"]+"\/>/);
    expect(styles).not.toContain('Courier New');
    expect(styles).not.toContain('<w:jc w:val="both"/>');
    expect(text(entries, 'word/footer1.xml')).toContain('> PAGE <');
    expect(text(entries, '[Content_Types].xml')).toContain(
      'application/vnd.openxmlformats-officedocument.custom-properties+xml',
    );
    expect(text(entries, '_rels/.rels')).toContain('relationships/custom-properties');

    const customProperties = new DOMParser().parseFromString(
      text(entries, 'docProps/custom.xml'),
      'application/xml',
    );
    const customPropertyNamespace =
      'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties';
    const valueNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
    const properties = [
      ...customProperties.getElementsByTagNameNS(customPropertyNamespace, 'property'),
    ];
    expect(properties[0].getAttribute('name')).toBe('ZOTERO_PREF_1');
    expect(
      properties.every(
        (property) =>
          (property.getElementsByTagNameNS(valueNamespace, 'lpwstr')[0]?.textContent ?? '')
            .length <= 240,
      ),
    ).toBe(true);
    const preferencesXml = properties
      .map(
        (property) =>
          property.getElementsByTagNameNS(valueNamespace, 'lpwstr')[0]?.textContent ?? '',
      )
      .join('');
    const preferences = new DOMParser().parseFromString(preferencesXml, 'application/xml');
    const data = preferences.documentElement;
    expect(data.tagName).toBe('data');
    expect(data.getAttribute('data-version')).toBe('3');
    expect(data.getAttribute('zotero-version')).toBe('9.0');
    expect(data.querySelector('session')?.getAttribute('id')).toBe('NOMOTEST');
    expect(data.querySelector('style')?.getAttribute('id')).toBe(
      'http://www.zotero.org/styles/nature',
    );
    expect(data.querySelector('style')?.getAttribute('locale')).toBe('en-US');
    expect(data.querySelector('style')?.getAttribute('hasBibliography')).toBe('1');
    expect(data.querySelector('style')?.getAttribute('bibliographyStyleHasBeenSet')).toBe('1');
    const preference = (name: string) =>
      data.querySelector(`prefs > pref[name="${name}"]`)?.getAttribute('value');
    expect(preference('fieldType')).toBe('Field');
    expect(preference('noteType')).toBe('0');
    expect(preference('automaticJournalAbbreviations')).toBe('false');
    expect(preference('delayCitationUpdates')).toBe('false');
  });

  it('applies the ACS page, typography, and Zotero style preset', () => {
    const result = buildAcademicDocx({
      template: 'acs',
      title: 'ACS layout',
      sessionId: 'NOMOTEST',
      zoteroItems: [gagliardi],
      citationStyle: 'numeric',
      renderedHtml:
        '<p>Result <span class="citation-node" data-citation-keys="D9PGQUM4">[1]</span></p>',
    });
    const entries = readStoredZip(result.bytes);
    const document = text(entries, 'word/document.xml');
    const styles = text(entries, 'word/styles.xml');
    const preferences = new DOMParser().parseFromString(
      text(entries, 'docProps/custom.xml'),
      'application/xml',
    );

    expect(document).toContain('<w:pgSz w:w="12240" w:h="15840"/>');
    expect(document).toContain('<w:pgMar w:top="1440" w:right="1440" w:bottom="1440"');
    expect(styles).toContain('w:ascii="Arial"');
    expect(styles).toContain('w:line="360"');
    expect(text(entries, 'word/fontTable.xml')).toContain('w:name="Arial"');
    expect(
      [...preferences.getElementsByTagName('*')].some((node) =>
        (node.textContent ?? '').includes('american-chemical-society'),
      ),
    ).toBe(true);
    expect(text(entries, 'docProps/app.xml')).toContain('<AppVersion>0.5.6</AppVersion>');
  });

  it('embeds supported base64 images with DrawingML, relationships and media content types', () => {
    const fixtures = [
      {
        mime: 'image/png',
        extension: 'png',
        contentType: 'image/png',
        bytes: imageHeader('png', 1200, 600),
        widthEmu: 5_731_510,
        heightEmu: 2_865_755,
      },
      {
        mime: 'image/jpeg',
        extension: 'jpg',
        contentType: 'image/jpeg',
        bytes: imageHeader('jpeg', 2, 1),
        widthEmu: 19_050,
        heightEmu: 9_525,
      },
      {
        mime: 'image/gif',
        extension: 'gif',
        contentType: 'image/gif',
        bytes: imageHeader('gif', 2, 1),
        widthEmu: 19_050,
        heightEmu: 9_525,
      },
      {
        mime: 'image/bmp',
        extension: 'bmp',
        contentType: 'image/bmp',
        bytes: imageHeader('bmp', 2, 1),
        widthEmu: 19_050,
        heightEmu: 9_525,
      },
    ] as const;

    for (const fixture of fixtures) {
      const result = buildAcademicDocx({
        title: 'Embedded image',
        zoteroItems: [],
        renderedHtml: `<p><img alt="Result plot" src="${dataUri(fixture.mime, fixture.bytes)}"></p>`,
      });
      const entries = readStoredZip(result.bytes);
      expect(entries.get(`word/media/image1.${fixture.extension}`)).toEqual(fixture.bytes);

      const document = text(entries, 'word/document.xml');
      expect(document).toContain(
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
      );
      expect(document).toContain('<w:drawing>');
      expect(document).toContain('r:embed="rId5"');
      expect(document).toContain(`<wp:extent cx="${fixture.widthEmu}" cy="${fixture.heightEmu}"/>`);
      expect(document).toContain(`<a:ext cx="${fixture.widthEmu}" cy="${fixture.heightEmu}"/>`);
      expect(document).toContain('<a:graphicFrameLocks noChangeAspect="1"/>');

      const relationships = text(entries, 'word/_rels/document.xml.rels');
      expect(relationships).toContain(
        `Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.${fixture.extension}"`,
      );
      expect(text(entries, '[Content_Types].xml')).toContain(
        `<Default Extension="${fixture.extension}" ContentType="${fixture.contentType}"/>`,
      );
      expect(result.warnings).toEqual([]);
    }
  });

  it('keeps an explicit placeholder and warning when an image cannot be embedded', () => {
    const result = buildAcademicDocx({
      title: 'Remote image',
      zoteroItems: [],
      renderedHtml: '<p><img alt="Remote plot" src="https://example.com/plot.png"></p>',
    });
    const entries = readStoredZip(result.bytes);

    expect([...entries.keys()].some((name) => name.startsWith('word/media/'))).toBe(false);
    expect(text(entries, 'word/document.xml')).toContain('[Remote plot]');
    expect(result.warnings).toContain('图片“Remote plot”无法嵌入 Word，仅保留了文字占位。');
  });

  it('keeps inline and display formulas as editable linear OMML', () => {
    const result = buildAcademicDocx({
      title: 'Equations',
      zoteroItems: [],
      renderedHtml:
        '<p>Energy <span class="math-inline" data-tex="E = mc^2">rendered</span>.</p>' +
        '<div class="math-block" data-tex="\\frac{a}{b}">rendered block</div>',
    });
    const document = text(readStoredZip(result.bytes), 'word/document.xml');
    const parsed = new DOMParser().parseFromString(document, 'application/xml');
    const mathNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

    expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(parsed.getElementsByTagNameNS(mathNamespace, 'oMath')).toHaveLength(2);
    expect(parsed.getElementsByTagNameNS(mathNamespace, 'oMathPara')).toHaveLength(1);
    expect(
      parsed.getElementsByTagNameNS(mathNamespace, 'oMathPara')[0]?.parentElement?.localName,
    ).toBe('p');
    expect(
      [...parsed.getElementsByTagNameNS(mathNamespace, 't')].map((node) => node.textContent),
    ).toEqual(['E = mc^2', '\\frac{a}{b}']);
    expect(result.warnings).toEqual([
      'Word 导出将 LaTeX 公式作为可编辑的线性 OMML 文本保留，未执行完整的 TeX 二维公式转换。',
    ]);
  });

  it('marks an explicit empty bibliography field in Zotero document data', () => {
    const result = buildAcademicDocx({
      title: 'Empty bibliography',
      sessionId: 'NOMOTEST',
      renderedHtml: '<p>No citations yet.</p><section class="bibliography-block"></section>',
      zoteroItems: [],
    });
    const entries = readStoredZip(result.bytes);
    const document = text(entries, 'word/document.xml');
    expect(fieldInstructions(document)).toContain(
      ' ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY',
    );
    const customProperties = new DOMParser().parseFromString(
      text(entries, 'docProps/custom.xml'),
      'application/xml',
    );
    const valueNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
    const preferencesXml = [
      ...customProperties.getElementsByTagNameNS(
        'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties',
        'property',
      ),
    ]
      .map(
        (property) =>
          property.getElementsByTagNameNS(valueNamespace, 'lpwstr')[0]?.textContent ?? '',
      )
      .join('');
    const preferences = new DOMParser().parseFromString(preferencesXml, 'application/xml');
    expect(
      preferences.documentElement.querySelector('style')?.getAttribute('hasBibliography'),
    ).toBe('1');
  });

  it('leaves unresolved or invalid citations visible instead of creating corrupt fields', () => {
    const invalid = { ...gagliardi, uri: 'http://zotero.org/users/20774538/items/OTHERKEY' };
    const result = buildAcademicDocx({
      title: 'Unresolved',
      sessionId: 'NOMOTEST',
      zoteroItems: [invalid],
      renderedHtml:
        '<p><span class="citation-node" data-citation-keys="D9PGQUM4;MISSING1">citation</span></p>',
    });
    const document = text(readStoredZip(result.bytes), 'word/document.xml');
    expect(document).toContain('[@D9PGQUM4; @MISSING1]');
    expect(document).not.toContain('ADDIN ZOTERO_ITEM');
    expect(result.citationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'D9PGQUM4', reason: 'invalid-uri' }),
        expect.objectContaining({ key: 'D9PGQUM4', reason: 'missing-item' }),
        expect.objectContaining({ key: 'MISSING1', reason: 'missing-item' }),
      ]),
    );
  });

  it('accepts Zotero local-user URIs for unsynced libraries', () => {
    const localUri = 'http://zotero.org/users/local/a1_B2/items/D9PGQUM4';
    const result = buildAcademicDocx({
      title: 'Local library',
      sessionId: 'NOMOTEST',
      zoteroItems: [
        { ...gagliardi, uri: localUri, itemData: { ...gagliardi.itemData, id: localUri } },
      ],
      renderedHtml:
        '<p><span class="citation-node" data-citation-keys="D9PGQUM4">citation</span></p>',
    });
    const document = text(readStoredZip(result.bytes), 'word/document.xml');
    expect(document).toContain('ADDIN ZOTERO_ITEM');
    expect(result.citationIssues).toEqual([]);
  });

  it('uses APA document preferences and author-year field results when requested', () => {
    const result = buildAcademicDocx({
      title: 'Author year',
      sessionId: 'NOMOTEST',
      citationStyle: 'author-year',
      zoteroItems: [gagliardi, liManni],
      renderedHtml:
        '<p><span class="citation-node" data-citation-keys="T4IQZGRM;D9PGQUM4">citation</span></p><section class="bibliography-block"></section>',
    });
    const entries = readStoredZip(result.bytes);
    const document = text(entries, 'word/document.xml');
    expect(document).toContain('(Li Manni &amp; Carlson, 2014; Gagliardi et al., 2017)');
    expect(document).not.toContain('<w:vertAlign w:val="superscript"/>');
    const bibliography = document.slice(document.indexOf('References'));
    expect(bibliography.indexOf('Gagliardi')).toBeLessThan(bibliography.indexOf('Li Manni'));

    const customProperties = new DOMParser().parseFromString(
      text(entries, 'docProps/custom.xml'),
      'application/xml',
    );
    const customPropertyNamespace =
      'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties';
    const valueNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
    const preferencesXml = [
      ...customProperties.getElementsByTagNameNS(customPropertyNamespace, 'property'),
    ]
      .map(
        (property) =>
          property.getElementsByTagNameNS(valueNamespace, 'lpwstr')[0]?.textContent ?? '',
      )
      .join('');
    const preferences = new DOMParser().parseFromString(preferencesXml, 'application/xml');
    expect(preferences.documentElement.querySelector('style')?.getAttribute('id')).toBe(
      'http://www.zotero.org/styles/apa',
    );
    expect(
      preferences.documentElement
        .querySelector('prefs > pref[name="automaticJournalAbbreviations"]')
        ?.getAttribute('value'),
    ).toBe('false');
  });

  it('uses Zotero bibliography HTML as the initial field result and keeps its emphasis', () => {
    const withBibliography = {
      ...gagliardi,
      bibliographyHtml:
        '<div class="csl-bib-body"><div class="csl-entry"><div class="csl-left-margin">1. </div><div class="csl-right-inline">Gagliardi, L. <i>et al.</i> Example. <i>Accounts of Chemical Research</i> <b>50</b>, 66-73 (2017).</div></div></div>',
    };
    const result = buildAcademicDocx({
      title: 'Zotero bibliography result',
      sessionId: 'NOMOTEST',
      zoteroItems: [withBibliography],
      renderedHtml:
        '<p><span class="citation-node" data-citation-keys="D9PGQUM4">1</span></p><section class="bibliography-block"></section>',
    });
    const document = text(readStoredZip(result.bytes), 'word/document.xml');
    expect(document).toContain('1. ');
    expect(document).not.toContain('1. 1.');
    expect(document).toContain('<w:rPr><w:i/></w:rPr><w:t xml:space="preserve">et al.</w:t>');
    expect(document).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">50</w:t>');
    expect(result.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining('bibliography HTML')]),
    );
  });

  it('parses Zotero include=csljson records but rejects raw Web API data', () => {
    const converted = zoteroApiRecordToWordItem({
      key: gagliardi.key,
      csljson: JSON.stringify([gagliardi.itemData]),
      citation: '<sup>1</sup>',
    });
    expect(converted).toEqual(gagliardi);
    expect(
      zoteroApiRecordToWordItem({
        key: gagliardi.key,
        csljson: { title: 'Raw API data without CSL id' },
      }),
    ).toBeNull();
  });
});

function readStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    expect(method).toBe(0);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(bytes.slice(nameStart, nameStart + nameLength));
    entries.set(name, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}

function text(entries: Map<string, Uint8Array>, name: string): string {
  const value = entries.get(name);
  expect(value, `${name} is present`).toBeDefined();
  return new TextDecoder().decode(value);
}

function fieldInstructions(xml: string): string[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return [...doc.getElementsByTagNameNS(WORD_NAMESPACE, 'p')]
    .map((paragraph) =>
      [...paragraph.getElementsByTagNameNS(WORD_NAMESPACE, 'instrText')]
        .map((node) => node.textContent ?? '')
        .join(''),
    )
    .filter(Boolean);
}

function dataUri(mime: string, bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mime};base64,${btoa(binary)}`;
}

function imageHeader(
  format: 'png' | 'jpeg' | 'gif' | 'bmp',
  width: number,
  height: number,
): Uint8Array {
  if (format === 'png') {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width, false);
    view.setUint32(20, height, false);
    return bytes;
  }
  if (format === 'gif') {
    const bytes = new Uint8Array(10);
    bytes.set([...new TextEncoder().encode('GIF89a')], 0);
    const view = new DataView(bytes.buffer);
    view.setUint16(6, width, true);
    view.setUint16(8, height, true);
    return bytes;
  }
  if (format === 'bmp') {
    const bytes = new Uint8Array(26);
    bytes.set([0x42, 0x4d], 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(14, 40, true);
    view.setInt32(18, width, true);
    view.setInt32(22, height, true);
    return bytes;
  }

  const bytes = new Uint8Array(23);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height, false);
  view.setUint16(9, width, false);
  bytes.set([0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9], 11);
  return bytes;
}
