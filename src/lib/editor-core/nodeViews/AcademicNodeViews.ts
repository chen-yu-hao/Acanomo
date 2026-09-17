import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import {
  buildAcademicIndex,
  bibliographyOrder,
  formatBibliography,
  formatCitation,
  parseAcademicSettings,
  type ZoteroItem,
} from '../../academic/academic';

let zoteroItems = new Map<string, ZoteroItem>();
const instances = new Set<{ view: EditorView; refresh(): void }>();

export function refreshAcademicNodeViews(view?: EditorView): void {
  for (const instance of instances) {
    if (!view || instance.view === view) instance.refresh();
  }
}

export function setAcademicZoteroItems(items: ZoteroItem[]): void {
  zoteroItems = new Map(items.map((item) => [item.key, item]));
  refreshAcademicNodeViews();
}

export class CitationNodeView implements NodeView {
  dom: HTMLElement;
  private node: ProseMirrorNode;
  view: EditorView;

  constructor(node: ProseMirrorNode, view: EditorView) {
    this.node = node;
    this.view = view;
    this.dom = document.createElement('span');
    this.dom.className = 'citation-node';
    this.dom.contentEditable = 'false';
    this.dom.addEventListener('click', () => {
      const key = (this.node.attrs.keys as string[])?.[0];
      if (key)
        this.view.dom
          .querySelector(`#ref-${key}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    this.render(view);
    instances.add(this);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.refresh();
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }
  destroy(): void {
    instances.delete(this);
  }

  refresh(): void {
    this.render(this.view);
  }

  private render(view: EditorView): void {
    const keys = (this.node.attrs.keys as string[]) ?? [];
    const settings = parseAcademicSettings(String(view.state.doc.attrs.frontMatterPrefix ?? ''));
    const order = buildAcademicIndex(view.state.doc, settings).citationOrder;
    const missing = keys.filter((key) => !zoteroItems.has(key));
    this.dom.textContent = missing.length
      ? `[@${keys.join('; @')}]`
      : settings.citationStyle === 'numeric'
        ? `[${keys.map((key) => order.indexOf(key) + 1).join(', ')}]`
        : `(${keys.map((key) => formatCitation(zoteroItems.get(key), settings.citationStyle)).join('; ')})`;
    this.dom.classList.toggle('is-unresolved', missing.length > 0);
    this.dom.title = missing.length
      ? `Unresolved Zotero key: ${missing.join(', ')}`
      : keys.join('; ');
    this.dom.setAttribute('data-citation-keys', keys.join(';'));
  }
}

export class EquationRefNodeView implements NodeView {
  dom: HTMLAnchorElement;
  private node: ProseMirrorNode;
  view: EditorView;

  constructor(node: ProseMirrorNode, view: EditorView) {
    this.node = node;
    this.view = view;
    this.dom = document.createElement('a');
    this.dom.className = 'equation-ref';
    this.dom.contentEditable = 'false';
    this.dom.addEventListener('click', (event) => {
      event.preventDefault();
      const target = [...this.view.dom.querySelectorAll<HTMLElement>('[id]')].find(
        (element) => element.id === `eq-${String(this.node.attrs.label ?? '')}`,
      );
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    this.render();
    instances.add(this);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }
  destroy(): void {
    instances.delete(this);
  }
  refresh(): void {
    this.render();
  }

  private render(): void {
    const label = String(this.node.attrs.label ?? '');
    const index = buildAcademicIndex(
      this.view.state.doc,
      parseAcademicSettings(String(this.view.state.doc.attrs.frontMatterPrefix ?? '')),
    );
    const target = index.equationsByLabel.get(label);
    this.dom.href = `#eq-${label}`;
    this.dom.dataset.equationLabel = label;
    this.dom.textContent = target ? `(${target.number ?? label})` : `(?${label})`;
    this.dom.classList.toggle('is-unresolved', !target);
  }
}

export class BibliographyNodeView implements NodeView {
  dom: HTMLElement;
  private node: ProseMirrorNode;
  view: EditorView;

  constructor(node: ProseMirrorNode, view: EditorView) {
    this.node = node;
    this.view = view;
    this.dom = document.createElement('section');
    this.dom.className = 'bibliography-block';
    this.dom.contentEditable = 'false';
    this.render();
    instances.add(this);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }
  destroy(): void {
    instances.delete(this);
  }
  refresh(): void {
    this.render();
  }

  private render(): void {
    const settings = parseAcademicSettings(
      String(this.view.state.doc.attrs.frontMatterPrefix ?? ''),
    );
    const index = buildAcademicIndex(this.view.state.doc, settings);
    this.dom.replaceChildren();
    const heading = document.createElement('h2');
    heading.textContent = 'References';
    this.dom.appendChild(heading);
    const list = document.createElement(settings.citationStyle === 'numeric' ? 'ol' : 'ul');
    for (const key of bibliographyOrder(index.citationOrder, zoteroItems, settings.citationStyle)) {
      const item = document.createElement('li');
      item.id = `ref-${key}`;
      item.textContent = zoteroItems.has(key)
        ? formatBibliography(zoteroItems.get(key), settings.citationStyle)
        : `[@${key}] unresolved`;
      if (!zoteroItems.has(key)) item.classList.add('is-unresolved');
      list.appendChild(item);
    }
    this.dom.appendChild(list);
  }
}
