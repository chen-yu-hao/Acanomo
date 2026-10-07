import { describe, expect, it } from 'vitest';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { parseMarkdown, parseMarkdownWithSyncAnchors, serializeMarkdown } from './markdown';

function nodesOfType(doc: ProseMirrorNode, type: string): ProseMirrorNode[] {
  const nodes: ProseMirrorNode[] = [];
  doc.descendants((node) => {
    if (node.type.name === type) nodes.push(node);
  });
  return nodes;
}

describe('Markdown inline lookahead', () => {
  it.each([
    '[$x$]',
    '[draft value $x$ needs review]',
    '[unclosed note with $x$',
    '[[nested $x$] note]',
    '[value $x$](https://example.test)',
    '[value $x$][reference]\n\n[reference]: https://example.test',
  ])('keeps the document structured when scanning %j', (paragraph) => {
    const markdown = `# Heading\n\n${paragraph}\n\n## Following section`;
    const doc = parseMarkdown(markdown);

    expect(nodesOfType(doc, 'heading').map((node) => node.textContent)).toEqual([
      'Heading',
      'Following section',
    ]);
    expect(nodesOfType(doc, 'math_inline').map((node) => node.attrs.tex)).toEqual(['x']);
    expect(parseMarkdown(serializeMarkdown(doc)).eq(doc)).toBe(true);
  });

  it('preserves formulas and link marks inside a link label', () => {
    const doc = parseMarkdown('[value $x$](https://example.test)');
    const formula = nodesOfType(doc, 'math_inline')[0];

    expect(formula?.attrs.tex).toBe('x');
    expect(formula?.marks.find((mark) => mark.type.name === 'link')?.attrs.href).toBe(
      'https://example.test',
    );
  });

  it('parses an inline HTML image inside a link label', () => {
    const doc = parseMarkdown(
      '# Heading\n\n[<img src="./figure.png" width="80">](https://example.test)',
    );
    const image = nodesOfType(doc, 'image')[0];

    expect(doc.firstChild?.type.name).toBe('heading');
    expect(image?.attrs).toMatchObject({ src: './figure.png', width: '80' });
    expect(image?.marks.find((mark) => mark.type.name === 'link')?.attrs.href).toBe(
      'https://example.test',
    );
  });

  it('does not apply image attributes while looking ahead through the next link', () => {
    const doc = parseMarkdown(
      '# Heading\n\n![Figure](./figure.png) [label {width=64}](https://example.test)',
    );
    const image = nodesOfType(doc, 'image')[0];

    expect(doc.firstChild?.type.name).toBe('heading');
    expect(image?.attrs).toMatchObject({ src: './figure.png', width: null });
    expect(doc.lastChild?.textContent).toBe(' label {width=64}');
  });

  it('keeps mixed document structure and source anchors around bracketed math', () => {
    const markdown = [
      '# Research note',
      '',
      '**Result.** [Compare the error $D_1$ and the reference.]',
      '',
      '$$E = x^2$$',
      '',
      '| Quantity | Value |',
      '| :--- | :--- |',
      '| $D_1$ | 0.1 |',
      '',
      '## References',
      '',
      '1. Example reference.',
    ].join('\n');
    const { doc, anchors } = parseMarkdownWithSyncAnchors(markdown);

    expect(doc.eq(parseMarkdown(markdown))).toBe(true);
    expect(nodesOfType(doc, 'heading')).toHaveLength(2);
    expect(nodesOfType(doc, 'math_inline').map((node) => node.attrs.tex)).toEqual(['D_1', 'D_1']);
    expect(nodesOfType(doc, 'math_block').map((node) => node.attrs.tex)).toEqual(['E = x^2']);
    expect(nodesOfType(doc, 'table')).toHaveLength(1);
    expect(nodesOfType(doc, 'ordered_list')).toHaveLength(1);
    expect(
      anchors.filter((anchor) => anchor.kind === 'heading' && anchor.edge === 'start'),
    ).toHaveLength(2);
    expect(parseMarkdown(serializeMarkdown(doc)).eq(doc)).toBe(true);
  });
});
