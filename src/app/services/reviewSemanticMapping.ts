import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { EditorReviewDecoration } from '../../lib/editor-core';
import { parseMarkdownWithSyncAnchors, serializeMarkdown } from '../../lib/editor-core/markdown';
import {
  withoutMarkdownSpaceMarks,
  type EditorSyncSnapshot,
  type MarkdownSyncAnchor,
} from '../../lib/editor-core/scrollSyncMapping';
import { buildReviewInlineEdits, type ReviewDiff } from '../../lib/review/review';

function blockAnchors(anchors: readonly MarkdownSyncAnchor[]): MarkdownSyncAnchor[] {
  return anchors.filter(
    (anchor) => anchor.edge === 'start' && anchor.kind !== 'eof' && anchor.kind !== 'blank',
  );
}

function sameParents(
  before: ProseMirrorNode,
  basePos: number,
  after: ProseMirrorNode,
  currentPos: number,
): boolean {
  const base = before.resolve(basePos);
  const current = after.resolve(currentPos);
  if (base.depth !== current.depth) return false;
  for (let depth = 1; depth <= base.depth; depth++) {
    if (!base.node(depth).sameMarkup(current.node(depth))) return false;
  }
  return true;
}

function covers(anchor: MarkdownSyncAnchor, line: number): boolean {
  return anchor.fromLine <= line && anchor.toLine >= line;
}

// HEAD stays fixed while typing. Keep just its parsed snapshot, not a history
// of editor documents. The current blocks use the editor's verified anchors.
let baselineCache:
  | { markdown: string; parsed: ReturnType<typeof parseMarkdownWithSyncAnchors> }
  | undefined;

/** Visible characters and indivisible atoms, with boundaries in the real PM block. */
function inlineContent(node: ProseMirrorNode) {
  const units: string[] = [];
  const positions = new Map<number, number>([[0, 0]]);
  let offset = 0;
  node.forEach((child, pos) => {
    const values = child.isText
      ? Array.from(child.text!)
      : [
          child.type.name === 'hard_break'
            ? '\n'
            : serializeMarkdown(
                node.type.schema.nodes.doc.create(
                  null,
                  node.type.schema.nodes.paragraph.create(null, child),
                ),
              ),
        ];
    for (const value of values) {
      units.push(value);
      offset += value.length;
      pos += child.isText ? value.length : child.nodeSize;
      positions.set(offset, pos);
    }
  });
  return { units, positions };
}

function inlineBlockPairs(
  diff: ReviewDiff,
  baseAnchors: MarkdownSyncAnchor[],
  currentAnchors: MarkdownSyncAnchor[],
  sameContent: (base: MarkdownSyncAnchor, current: MarkdownSyncAnchor) => boolean,
): Array<[MarkdownSyncAnchor, MarkdownSyncAnchor]> {
  const pairs = new Map<MarkdownSyncAnchor, Set<MarkdownSyncAnchor>>();
  const addPair = (base: MarkdownSyncAnchor, current: MarkdownSyncAnchor) => {
    const targets = pairs.get(base) ?? new Set<MarkdownSyncAnchor>();
    targets.add(current);
    pairs.set(base, targets);
  };
  for (const change of diff.changes) {
    let before = baseAnchors.filter(
      (a) => a.fromLine <= change.baseEnd && a.toLine >= change.baseStart,
    );
    let after = currentAnchors.filter(
      (a) => a.fromLine <= change.currentEnd && a.toLine >= change.currentStart,
    );
    // A pure line insertion/deletion can still be inside one surviving
    // paragraph. Require a shared unchanged boundary inside that block;
    // never pair a removed paragraph with the next unrelated paragraph.
    if (change.baseEnd < change.baseStart && after.length === 1) {
      const boundary = covers(after[0], change.currentEnd + 1)
        ? change.baseStart
        : covers(after[0], change.currentStart - 1)
          ? change.baseStart - 1
          : 0;
      before = baseAnchors.filter((a) => covers(a, boundary));
    }
    if (change.currentEnd < change.currentStart && before.length === 1) {
      const boundary = covers(before[0], change.baseEnd + 1)
        ? change.currentStart
        : covers(before[0], change.baseStart - 1)
          ? change.currentStart - 1
          : 0;
      after = currentAnchors.filter((a) => covers(a, boundary));
    }
    if (before.length !== after.length) {
      // Git includes a surviving line in the change when its EOF newline
      // changes. Retain exact semantic matches in source order rather than
      // marking that unchanged item together with its new/deleted neighbor.
      let next = 0;
      for (const base of before) {
        const index = after.findIndex(
          (current, index) => index >= next && sameContent(base, current),
        );
        if (index < 0) continue;
        addPair(base, after[index]);
        next = index + 1;
      }
    } else {
      before.forEach((base, index) => addPair(base, after[index]));
    }
  }
  const result: Array<[MarkdownSyncAnchor, MarkdownSyncAnchor]> = [];
  for (const [base, targets] of pairs) {
    if (targets.size !== 1) continue;
    const current = [...targets][0];
    if ([...pairs.values()].filter((set) => set.has(current)).length !== 1) continue;
    result.push([base, current]);
  }
  return result;
}

/** Map the same Git line diff onto verified ProseMirror blocks and inline positions. */
export function buildReviewSemanticDecorations(
  diff: ReviewDiff,
  snapshot: EditorSyncSnapshot,
): EditorReviewDecoration[] | null {
  const anchors = blockAnchors(snapshot.anchors).sort(
    (a, b) => a.fromLine - b.fromLine || a.pos - b.pos,
  );
  const eof = snapshot.anchors.find((a) => a.kind === 'eof' && a.edge === 'end' && a.depth === 0);
  const decorations: EditorReviewDecoration[] = [];
  const mappedCurrentLines = new Set<number>();
  const mappedBaseLines = new Set<number>();
  const decoratedBlocks = new Set<number>();

  if (diff.changed) {
    if (baselineCache?.markdown !== diff.baseline) {
      baselineCache = {
        markdown: diff.baseline,
        parsed: parseMarkdownWithSyncAnchors(diff.baseline),
      };
    }
    const baseline = baselineCache.parsed;
    // Parse the complete source so reference links and other document-wide
    // syntax resolve exactly as in the editor, including multi-line blocks.
    const parsedCurrent = parseMarkdownWithSyncAnchors(snapshot.markdown);
    const parsedAnchors = new Map(
      blockAnchors(parsedCurrent.anchors).map((anchor) => [anchor.key, anchor]),
    );
    const baseTextBlocks = blockAnchors(baseline.anchors).filter((anchor) => {
      const node = baseline.doc.nodeAt(anchor.pos);
      return node?.isTextblock && !node.type.spec.code;
    });
    const currentTextBlocks = anchors.filter((anchor) => {
      const parsed = parsedAnchors.get(anchor.key);
      const node = parsed ? parsedCurrent.doc.nodeAt(parsed.pos) : null;
      return node?.isTextblock && !node.type.spec.code;
    });
    // A list/quote is a container, not one text edit. Pair its actual nested
    // textblocks so changing one item cannot decorate its siblings.
    for (const [base, current] of inlineBlockPairs(
      diff,
      baseTextBlocks,
      currentTextBlocks,
      (base, current) => {
        const parsed = parsedAnchors.get(current.key);
        const after = parsed ? parsedCurrent.doc.nodeAt(parsed.pos) : null;
        return Boolean(after && baseline.doc.nodeAt(base.pos)?.eq(after));
      },
    )) {
      const before = baseline.doc.nodeAt(base.pos);
      // Keys identify parser nodes even when several nested blocks cover the
      // same source line; line number + node kind alone is not unique.
      const parsedAnchor = parsedAnchors.get(current.key);
      const after = parsedAnchor ? parsedCurrent.doc.nodeAt(parsedAnchor.pos) : null;
      if (
        !before?.isTextblock ||
        before.type.spec.code ||
        !after ||
        !parsedAnchor ||
        !sameParents(baseline.doc, base.pos, parsedCurrent.doc, parsedAnchor.pos) ||
        !before.sameMarkup(after) ||
        current.textContent !== after.textContent ||
        current.contentSize !== after.content.size
      )
        continue;

      const oldContent = inlineContent(before);
      const newContent = inlineContent(after);
      const edits = buildReviewInlineEdits(oldContent.units, newContent.units);
      // Serializer-only changes (citation separators, emphasis around trailing
      // spaces) have no semantic edit. Actual formatting-only edits keep the
      // block fallback rather than disappearing from the review.
      if (!edits.length && !withoutMarkdownSpaceMarks(before).eq(withoutMarkdownSpaceMarks(after)))
        continue;
      const hunk = diff.hunks.find(
        (h) =>
          h.deleted.some((line) => line.baseLine !== null && covers(base, line.baseLine)) ||
          h.added.some((line) => line.currentLine !== null && covers(current, line.currentLine)),
      );
      const id =
        hunk?.inlineChanges?.find((change) => covers(base, change.baseLine))?.id ??
        `review-block:${base.pos}`;
      const inline: EditorReviewDecoration[] = [];
      for (const [index, edit] of edits.entries()) {
        const from = newContent.positions.get(edit.currentOffset);
        const to =
          edit.kind === 'insert'
            ? newContent.positions.get(edit.currentOffset + edit.text.length)
            : from;
        if (from === undefined || to === undefined) break;
        const position = current.pos + 1 + from;
        inline.push({
          id: `${id}:${edit.kind === 'insert' ? 'added' : 'deleted'}-${index + 1}`,
          kind: edit.kind === 'insert' ? 'added' : 'deleted',
          from: position,
          to: current.pos + 1 + to,
          inline: true,
          ...(edit.kind === 'delete' ? { text: edit.text } : {}),
        });
      }
      if (inline.length !== edits.length) continue;
      decorations.push(...inline);
      for (let line = base.fromLine; line <= base.toLine; line++) mappedBaseLines.add(line);
      for (let line = current.fromLine; line <= current.toLine; line++)
        mappedCurrentLines.add(line);
    }
  }

  for (const hunk of diff.hunks) {
    for (const line of hunk.added) {
      if (line.currentLine === null || mappedCurrentLines.has(line.currentLine)) continue;
      const anchor = anchors
        .filter((a) => covers(a, line.currentLine!))
        .sort((a, b) => b.depth - a.depth || a.endPos - a.pos - (b.endPos - b.pos))[0];
      if (!anchor || anchor.endPos <= anchor.pos) {
        if (line.text.trim() === '') continue;
        return null;
      }
      if (decoratedBlocks.has(anchor.pos)) continue;
      decoratedBlocks.add(anchor.pos);
      const trailingWhitespace = line.text.match(/[\t ]+$/)?.[0];
      decorations.push({
        id: `${hunk.id}:added:${anchor.pos}:${line.currentLine}`,
        kind: 'added',
        from: anchor.pos,
        to: anchor.endPos,
        ...(trailingWhitespace ? { trailingWhitespace } : {}),
      });
    }

    const deletedByAnchor = new Map<number, string[]>();
    for (const line of hunk.deleted) {
      if (
        line.currentAnchorLine === undefined ||
        (line.baseLine !== null && mappedBaseLines.has(line.baseLine))
      )
        continue;
      const deleted = deletedByAnchor.get(line.currentAnchorLine) ?? [];
      deleted.push(`${line.text}${line.hasNewline ? (line.lineEnding ?? '\n') : ''}`);
      deletedByAnchor.set(line.currentAnchorLine, deleted);
    }
    for (const [insertionLine, deletedLines] of deletedByAnchor) {
      const target = anchors.find((a) => a.fromLine >= insertionLine) ?? eof;
      if (!target) return null;
      const position = target.kind === 'eof' ? target.endPos : target.pos;
      decorations.push({
        id: `${hunk.id}:deleted:${position}`,
        kind: 'deleted',
        from: position,
        to: position,
        text: deletedLines.join(''),
      });
    }
  }
  return decorations;
}
