import type Token from 'markdown-it/lib/token.mjs';
import { Fragment, type Node as ProseMirrorNode } from 'prosemirror-model';
import { MarkdownParser } from 'prosemirror-markdown';

/** 只属于当前内容修订的源码位置，不写入文档或撤销历史。 */
export interface MarkdownSyncAnchor {
  key: string;
  fromLine: number;
  toLine: number;
  pos: number;
  endPos: number;
  kind: string;
  edge: 'start' | 'end' | 'line';
  depth: number;
  lineOffset?: number;
  /** Visible ProseMirror text used to validate raw Markdown offsets. */
  textContent?: string;
  contentSize?: number;
  /**
   * Mapping from visible UTF-16 offsets to ProseMirror positions. Atom inline
   * nodes (citations, equations, images, etc.) occupy a document position but
   * contribute no `Node.textContent`, so a plain `pos + offset` calculation is
   * not valid after one of them.
   */
  inlineSegments?: readonly MarkdownSyncTextSegment[];
}

export interface MarkdownSyncTextSegment {
  textStart: number;
  textEnd: number;
  posStart: number;
  posEnd: number;
  kind: 'text' | 'atom';
}

export interface EditorSyncSnapshot {
  revision: number;
  renderRevision: number;
  ready: boolean;
  markdown: string;
  anchors: readonly MarkdownSyncAnchor[];
}

export interface EditorSyncCaret {
  head: number;
  viewportTop?: number;
  /** 独立 NodeView 的未提交草稿只能使用所属块定位。 */
  blockOnly?: boolean;
}

interface SourceRange {
  fromLine: number;
  toLine: number;
  codeStartLine: number;
}

interface ParseState {
  openNode(...args: unknown[]): void;
  closeNode(): ProseMirrorNode | null;
  addNode(...args: unknown[]): ProseMirrorNode | null;
}
type TokenHandler = (state: ParseState, token: Token, tokens: Token[], index: number) => void;
type ParserWithHandlers = MarkdownParser & { tokenHandlers: Record<string, TokenHandler> };

/** Markdown expels spaces at emphasis boundaries. Ignore only those marks
 * when comparing sync documents; text, positions and the live doc stay intact. */
export function withoutMarkdownSpaceMarks(node: ProseMirrorNode): ProseMirrorNode {
  if (node.isTextblock) {
    const children: ProseMirrorNode[] = [];
    node.forEach((child, _pos, index) => {
      if (!child.isText || !child.marks.length) {
        children.push(child);
        return;
      }
      const text = child.text!;
      const head = text.match(/^[\t ]+/)?.[0].length ?? 0;
      const tail = text.match(/[\t ]+$/)?.[0].length ?? 0;
      const before = node.maybeChild(index - 1)?.marks ?? [];
      const after = node.maybeChild(index + 1)?.marks ?? [];
      const parts =
        head === text.length
          ? [[0, text.length]]
          : [
              [0, head],
              [head, text.length - tail],
              [text.length - tail, text.length],
            ];
      for (const [from, to] of parts) {
        if (to <= from) continue;
        const marks = child.marks.filter(
          (mark) =>
            !['em', 'strong', 'strikethrough', 'underline', 'highlight'].includes(mark.type.name) ||
            ((from >= head || mark.isInSet(before)) &&
              (to <= text.length - tail || mark.isInSet(after))),
        );
        children.push(node.type.schema.text(text.slice(from, to), marks));
      }
    });
    const content = Fragment.from(children);
    return content.eq(node.content) ? node : node.copy(content);
  }
  if (node.isLeaf) return node;
  const children: ProseMirrorNode[] = [];
  let changed = false;
  node.forEach((child) => {
    const normalized = withoutMarkdownSpaceMarks(child);
    children.push(normalized);
    changed ||= normalized !== child;
  });
  return changed ? node.copy(Fragment.from(children)) : node;
}

function collectInlineSegments(node: ProseMirrorNode, nodePos: number): MarkdownSyncTextSegment[] {
  const segments: MarkdownSyncTextSegment[] = [];
  let textOffset = 0;

  const visit = (child: ProseMirrorNode, childPos: number) => {
    if (child.isText) {
      const length = child.text?.length ?? 0;
      segments.push({
        textStart: textOffset,
        textEnd: textOffset + length,
        posStart: childPos,
        posEnd: childPos + child.nodeSize,
        kind: 'text',
      });
      textOffset += length;
      return;
    }
    // Inline atoms have no textContent but still consume nodeSize positions.
    // A non-leaf inline container is traversed so marks or custom inline
    // wrappers remain addressable when a parser extension provides one.
    if (child.isInline && (child.isLeaf || child.isAtom || child.content.size === 0)) {
      segments.push({
        textStart: textOffset,
        textEnd: textOffset,
        posStart: childPos,
        posEnd: childPos + child.nodeSize,
        kind: 'atom',
      });
      return;
    }
    child.forEach((grandChild, offset) => visit(grandChild, childPos + 1 + offset));
  };

  node.forEach((child, offset) => visit(child, nodePos + 1 + offset));
  return segments;
}

/**
 * 在现有解析器真正创建节点时记录 token 来源。避免另外按节点数量或文本猜测对应关系；
 * 包装仅属于本次同步解析，不改变全局 parser、schema 或节点 attrs。
 */
export function parseWithSyncAnchors(
  parser: MarkdownParser,
  text: string,
  sourceLine: (line: number, end: boolean) => number | undefined,
): { doc: ProseMirrorNode; anchors: MarkdownSyncAnchor[] } {
  const ranges = new WeakMap<ProseMirrorNode, SourceRange>();
  const initialized = new WeakSet<ParseState>();
  const contexts = new WeakMap<ParseState, SourceRange | undefined>();
  const mappedParser = new MarkdownParser(
    parser.schema,
    parser.tokenizer,
    parser.tokens,
  ) as ParserWithHandlers;
  const handlers = (parser as ParserWithHandlers).tokenHandlers;
  mappedParser.tokenHandlers = Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      (state: ParseState, token: Token, tokens: Token[], index: number) => {
        if (!initialized.has(state)) {
          initialized.add(state);
          const stack: Array<SourceRange | undefined> = [undefined];
          const openNode = state.openNode.bind(state);
          const closeNode = state.closeNode.bind(state);
          const addNode = state.addNode.bind(state);
          state.openNode = (...args) => {
            stack.push(contexts.get(state));
            openNode(...args);
          };
          state.addNode = (...args) => {
            const node = addNode(...args);
            const range = contexts.get(state);
            if (node && range) ranges.set(node, range);
            return node;
          };
          state.closeNode = () => {
            const range = stack.pop();
            const node = closeNode();
            if (node && range) ranges.set(node, range);
            return node;
          };
        }
        const previous = contexts.get(state);
        const fromLine = token.map ? sourceLine(token.map[0], false) : undefined;
        const toLine = token.map ? sourceLine(token.map[1] - 1, true) : undefined;
        contexts.set(
          state,
          fromLine != null && toLine != null
            ? {
                fromLine,
                toLine,
                codeStartLine: token.type === 'fence' ? fromLine + 1 : fromLine,
              }
            : undefined,
        );
        try {
          handler(state, token, tokens, index);
        } finally {
          contexts.set(state, previous);
        }
      },
    ]),
  );
  const doc = mappedParser.parse(text);
  const anchors: MarkdownSyncAnchor[] = [];
  doc.descendants((node, pos) => {
    const range = ranges.get(node);
    if (!node.isBlock || !range) return;
    const depth = doc.resolve(pos).depth;
    const common = {
      pos,
      endPos: pos + node.nodeSize,
      kind: node.type.name,
      depth,
      textContent: node.textContent,
      contentSize: node.content.size,
      inlineSegments: collectInlineSegments(node, pos),
    };
    anchors.push({
      ...common,
      key: `${pos}:start`,
      fromLine: range.fromLine,
      toLine: range.toLine,
      edge: 'start',
    });
    anchors.push({
      ...common,
      key: `${pos}:end`,
      fromLine: range.toLine + 1,
      toLine: range.toLine + 1,
      edge: 'end',
    });
    if (node.type.name === 'code_block') {
      node.textContent.split('\n').forEach((_line, lineOffset) => {
        const line = range.codeStartLine + lineOffset;
        if (line <= range.toLine)
          anchors.push({
            ...common,
            key: `${pos}:line:${lineOffset}`,
            fromLine: line,
            toLine: line,
            edge: 'line',
            lineOffset,
          });
      });
    }
    // HTML 内部节点并没有独立的 Markdown 来源。
    return node.type.name !== 'html_block';
  });
  anchors.sort((a, b) => a.fromLine - b.fromLine || a.pos - b.pos);
  return { doc, anchors };
}
