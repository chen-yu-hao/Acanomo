import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { parseMarkdown, serializeMarkdown } from '../editor-core/markdown';
import { executeEditorCommand } from '../editor-core/editorCommands';
import {
  bibliographyOrder,
  buildAcademicIndex,
  formatBibliography,
  parseAcademicSettings,
  parseCitationKeys,
  upsertAcademicSettings,
} from './academic';

describe('academic Markdown', () => {
  it('round-trips citation clusters, inline references, manual tags and a movable bibliography', () => {
    const source = [
      'See [@D9PGQUM4; @T4IQZGRM] and $E=mc^2 \\label{eq:inline}$; compare \\eqref{eq:inline}.',
      '',
      '<!-- markedown:bibliography -->',
      '',
      '$$',
      'E = hf \\tag{S1} \\label{eq:energy}',
      '$$',
      '',
      'See \\eqref{eq:energy}.',
    ].join('\n');
    const doc = parseMarkdown(source);
    expect(serializeMarkdown(doc)).toBe(source);
    expect(buildAcademicIndex(doc).citationOrder).toEqual(['D9PGQUM4', 'T4IQZGRM']);
    expect(buildAcademicIndex(doc).equationsByLabel.get('eq:energy')?.number).toBe('S1');
    expect(buildAcademicIndex(doc).equationsByLabel.get('eq:inline')?.number).toBeNull();
  });

  it('preserves citations in table cells when serializing', () => {
    const source =
      '| Method | Source |\n| --- | --- |\n| PBE | [@D9PGQUM4; @T4IQZGRM] and $E=mc^2$ |';
    expect(serializeMarkdown(parseMarkdown(source))).toContain(
      '| PBE | [@D9PGQUM4; @T4IQZGRM] and $E=mc^2$ |',
    );
  });

  it('numbers by section with heading jumps and leaves manual tags out of automatic counts', () => {
    const source = [
      '## Methods',
      '',
      '$$a \\label{eq:first}$$',
      '',
      '$$b \\tag{S1} \\label{eq:manual}$$',
      '',
      '$$c \\label{eq:second}$$',
      '',
      '## Results',
      '',
      '$$d \\label{eq:third}$$',
    ].join('\n');
    const doc = parseMarkdown(source);
    expect(
      buildAcademicIndex(doc)
        .equations.filter((entry) => entry.number)
        .map((entry) => entry.number),
    ).toEqual(['1', 'S1', '2', '3']);
    expect(
      buildAcademicIndex(doc, { equationNumbering: 'section', citationStyle: 'numeric' })
        .equations.filter((entry) => entry.number)
        .map((entry) => entry.number),
    ).toEqual(['1.1.1', 'S1', '1.1.2', '1.2.1']);
    expect(
      buildAcademicIndex(doc, { equationNumbering: 'manual', citationStyle: 'numeric' })
        .equations.filter((entry) => entry.number)
        .map((entry) => entry.number),
    ).toEqual(['S1']);
  });

  it('updates front matter without duplicating aliases or losing body spacing', () => {
    const frontMatter = '---\r\ntitle: Draft\r\nequationNumbering: manual\r\n---\r\n';
    const updated = upsertAcademicSettings(frontMatter, {
      equationNumbering: 'section',
      citationStyle: 'author-year',
    });
    expect(updated).toContain('title: Draft');
    expect(updated.match(/equation[-_]?numbering|equationNumbering/g)).toHaveLength(1);
    expect(parseAcademicSettings(updated)).toEqual({
      equationNumbering: 'section',
      citationStyle: 'author-year',
    });
    expect(parseCitationKeys('[@D9PGQUM4; @T4IQZGRM; @D9PGQUM4]')).toEqual([
      'D9PGQUM4',
      'T4IQZGRM',
    ]);
  });

  it('inserts a bibliography at the document end without moving the citation caret', () => {
    const doc = parseMarkdown('A paragraph.');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 4) }),
    });
    expect(
      executeEditorCommand(
        { type: 'insertCitation', keys: ['D9PGQUM4'] },
        view,
        '',
        () => undefined,
      ),
    ).toBe(true);
    const caret = view.state.selection.from;
    expect(executeEditorCommand({ type: 'insertBibliography' }, view, '', () => undefined)).toBe(
      true,
    );
    expect(view.state.selection.from).toBe(caret);
    expect(serializeMarkdown(view.state.doc)).toContain('<!-- markedown:bibliography -->');
    expect(executeEditorCommand({ type: 'insertBibliography' }, view, '', () => undefined)).toBe(
      false,
    );
    view.destroy();
    host.remove();
  });

  it('leaves the numeric list marker to the ordered list', () => {
    const text = formatBibliography(
      { key: 'D9PGQUM4', title: 'A paper', creators: [{ lastName: 'Smith', firstName: 'Jane' }] },
      'numeric',
    );
    expect(text).toBe('Smith, Jane. A paper.');
  });

  it('sorts author-year references while numeric references keep citation order', () => {
    const keys = ['B2345678', 'A1234567'];
    const items = new Map([
      ['B2345678', { key: 'B2345678', creators: [{ lastName: 'Zhang' }] }],
      ['A1234567', { key: 'A1234567', creators: [{ lastName: 'Adams' }] }],
    ]);
    expect(bibliographyOrder(keys, items, 'author-year')).toEqual(['A1234567', 'B2345678']);
    expect(bibliographyOrder(keys, items, 'numeric')).toEqual(keys);
  });

  const samplePath = process.env.NOMO_ACADEMIC_SAMPLE;
  it.skipIf(!samplePath || !existsSync(samplePath))(
    'preserves Zotero keys and markers in a supplied manuscript',
    () => {
      const source = readFileSync(samplePath!, 'utf8');
      const doc = parseMarkdown(source);
      const serialized = serializeMarkdown(doc);
      const sourceKeys = [
        ...new Set(
          [...source.matchAll(/\[@([A-Z0-9]{8})(?:;\s*@[A-Z0-9]{8})*\]/g)].flatMap((match) =>
            parseCitationKeys(match[0]),
          ),
        ),
      ];
      expect(sourceKeys.length).toBeGreaterThan(0);
      expect(new Set(buildAcademicIndex(doc).citationOrder)).toEqual(new Set(sourceKeys));
      for (const key of sourceKeys) expect(serialized).toContain(`@${key}`);
      expect(serialized).toContain('<!-- markedown:bibliography -->');
      for (const tag of source.match(/\\tag\{[^{}]+\}/g) ?? []) expect(serialized).toContain(tag);
    },
  );
});
