import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorReviewDecoration } from '../types';

const REVIEW_DECORATION_KEY = new PluginKey<ReviewDecorationState>('reviewDecorations');
const REVIEW_DECORATION_META = 'nomo:review-decorations';

interface ReviewDecorationState {
  specs: readonly EditorReviewDecoration[];
  decorations: DecorationSet;
}

function appendDeletedLine(root: HTMLElement, line: string) {
  const trailingWhitespace = line.match(/[\t ]+$/)?.[0] ?? (line ? '' : ' ');
  const body = trailingWhitespace ? line.slice(0, line.length - trailingWhitespace.length) : line;
  if (body) root.appendChild(document.createTextNode(body));
  if (trailingWhitespace) {
    const trailing = document.createElement('span');
    trailing.className = 'review-semantic-deleted-trailing-whitespace';
    trailing.textContent = trailingWhitespace;
    root.appendChild(trailing);
  }
}

function createReviewDeletedWidget(text: string, id: string, inline: boolean): () => HTMLElement {
  return () => {
    const root = document.createElement(inline ? 'span' : 'div');
    root.className = inline
      ? 'review-semantic-deleted review-semantic-deleted-inline'
      : 'review-semantic-deleted';
    root.contentEditable = 'false';
    root.setAttribute('contenteditable', 'false');
    root.dataset.reviewId = id;
    root.setAttribute('role', 'note');
    root.setAttribute('aria-label', `Deleted: ${text}`);

    // Normalize CRLF only for the transient widget layout. The source text in
    // the diff remains untouched; removing a trailing CR prevents an invisible
    // carriage character from appearing before each rendered line on Windows.
    const lines = (inline ? text : text.replace(/\r?\n$/, '')).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (index > 0) root.appendChild(document.createElement('br'));
      const lineElement = document.createElement('span');
      appendDeletedLine(lineElement, line);
      root.appendChild(lineElement);
    }
    return root;
  };
}

function buildReviewDecorations(
  doc: ProseMirrorNode,
  specs: readonly EditorReviewDecoration[],
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const spec of specs) {
    const from = Math.max(0, Math.min(spec.from, doc.content.size));
    if (spec.kind === 'added') {
      const to = Math.max(from, Math.min(spec.to, doc.content.size));
      if (spec.inline) {
        if (to <= from) continue;
        const attributes: Record<string, string> = {
          class: 'review-semantic-added review-semantic-added-inline',
          'data-review-id': spec.id,
        };
        if (spec.trailingWhitespace) {
          attributes['data-review-trailing-whitespace'] = spec.trailingWhitespace;
        }
        decorations.push(Decoration.inline(from, to, attributes, { inclusiveEnd: false }));
      } else {
        const node = doc.nodeAt(from);
        // Node decorations must cover exactly one node. A stale sync anchor is
        // transient; skip it until the next semantic-view refresh rather than
        // throwing and interrupting normal editing.
        if (!node?.isBlock || to !== from + node.nodeSize) continue;
        const attributes: Record<string, string> = {
          class: 'review-semantic-added',
          'data-review-id': spec.id,
        };
        if (spec.trailingWhitespace) {
          attributes['data-review-trailing-whitespace'] = spec.trailingWhitespace;
        }
        decorations.push(Decoration.node(from, to, attributes));
      }
      // Paint actual whitespace, rather than appending synthetic spaces that
      // duplicate the width and move the apparent caret position.
      doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isText) return;
        for (const match of node.text!.matchAll(/[\t ]+/g)) {
          const start = Math.max(from, pos + match.index!);
          const end = Math.min(to, pos + match.index! + match[0].length);
          if (start < end) {
            decorations.push(
              Decoration.inline(start, end, { class: 'review-semantic-added-whitespace' }),
            );
          }
        }
      });
      continue;
    }

    decorations.push(
      Decoration.widget(
        from,
        createReviewDeletedWidget(spec.text ?? '', spec.id, Boolean(spec.inline)),
        {
          // Block widgets remain separate rows; inline widgets sit at the exact
          // character insertion point and must not change the document model.
          block: !spec.inline,
          // Keep the caret before an inline deletion. With side:-1 the
          // expanding widget stays before the caret on every Backspace,
          // leaving the visible caret stationary at the old deletion end.
          side: spec.inline ? 1 : -1,
          ignoreSelection: true,
          // Widget DOM is reused by key even across a new DecorationSet.
          // Consecutive deletions keep their edit id but grow their text.
          key: JSON.stringify([spec.id, spec.inline ?? false, spec.text ?? '']),
        },
      ),
    );
  }
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

function mapReviewSpecs(
  specs: readonly EditorReviewDecoration[],
  transaction: Transaction,
): EditorReviewDecoration[] {
  return specs.map((spec) => {
    if (spec.kind === 'deleted') {
      const position = transaction.mapping.map(spec.from, -1);
      return { ...spec, from: position, to: position };
    }

    const from = transaction.mapping.map(spec.from, 1);
    const to = transaction.mapping.map(spec.to, -1);
    return { ...spec, from: Math.min(from, to), to: Math.max(from, to) };
  });
}

export function reviewDecorationPlugin(): Plugin<ReviewDecorationState> {
  return new Plugin<ReviewDecorationState>({
    key: REVIEW_DECORATION_KEY,
    state: {
      init: () => ({ specs: [], decorations: DecorationSet.empty }),
      apply(transaction: Transaction, value: ReviewDecorationState) {
        const nextSpecs = transaction.getMeta(REVIEW_DECORATION_META) as
          | readonly EditorReviewDecoration[]
          | undefined;
        if (nextSpecs !== undefined) {
          return {
            specs: [...nextSpecs],
            decorations: buildReviewDecorations(transaction.doc, nextSpecs),
          };
        }
        const mappedSpecs = transaction.docChanged
          ? mapReviewSpecs(value.specs, transaction)
          : value.specs;
        return {
          specs: mappedSpecs,
          decorations: transaction.docChanged
            ? buildReviewDecorations(transaction.doc, mappedSpecs)
            : value.decorations.map(transaction.mapping, transaction.doc),
        };
      },
    },
    props: {
      decorations: (state) =>
        REVIEW_DECORATION_KEY.getState(state)?.decorations ?? DecorationSet.empty,
    },
  });
}

export function setReviewDecorations(
  transaction: Transaction,
  decorations: readonly EditorReviewDecoration[],
): Transaction {
  return transaction.setMeta(REVIEW_DECORATION_META, decorations).setMeta('addToHistory', false);
}

/**
 * Return the mapped specifications currently owned by the plugin. The editor
 * core uses this when it recreates an otherwise identical EditorState; the
 * plugin state is the source of truth because ordinary document transactions
 * may have remapped positions since the last public setter call.
 */
export function getReviewDecorationSpecs(state: EditorState): readonly EditorReviewDecoration[] {
  return REVIEW_DECORATION_KEY.getState(state)?.specs ?? [];
}

export function isReviewDecorationTransaction(transaction: Transaction): boolean {
  return transaction.getMeta(REVIEW_DECORATION_META) !== undefined;
}
