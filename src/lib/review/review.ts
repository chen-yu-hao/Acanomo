export type ReviewChangeKind = 'insert' | 'delete' | 'replace';

export type ReviewDiffLineKind = 'context' | 'insert' | 'delete';

/** A line in a Git-style unified hunk. `text` excludes its line ending. */
export interface ReviewDiffLine {
  kind: ReviewDiffLineKind;
  text: string;
  baseLine: number | null;
  currentLine: number | null;
  /** Current-file insertion line for a deleted line. */
  currentAnchorLine?: number;
  hasNewline: boolean;
  /** Preserve the source line ending so patches also work with CRLF blobs. */
  lineEnding?: '\n' | '\r\n';
}

export interface ReviewHunk {
  id: string;
  kind: ReviewChangeKind;
  /** 1-based inclusive range of changed lines in the baseline. Empty ranges use end = start - 1. */
  baseStart: number;
  baseEnd: number;
  /** 1-based inclusive range of changed lines in the working copy. Empty ranges use end = start - 1. */
  currentStart: number;
  currentEnd: number;
  /** Unified patch range in the baseline. A zero-count range may start at 0. */
  patchBaseStart: number;
  patchBaseCount: number;
  /** Unified patch range in the working copy. A zero-count range may start at 0. */
  patchCurrentStart: number;
  patchCurrentCount: number;
  /** Changed lines only, retained for asset collection and compatibility with callers. */
  oldLines: string[];
  newLines: string[];
  /** Complete unified hunk, including context lines. */
  lines: ReviewDiffLine[];
  /** The same unified line stream split for consumers that do not render prefixes. */
  context: ReviewDiffLine[];
  added: ReviewDiffLine[];
  deleted: ReviewDiffLine[];
  /** Reliable same-line edits used only by the semantic review view. */
  inlineChanges?: ReviewInlineChange[];
  /** Line ending used by the baseline/index for this patch. */
  patchLineEnding?: '\n' | '\r\n';
}

/** One contiguous edit inside a Git-style hunk. */
export interface ReviewChange extends ReviewHunk {
  parentHunkId: string;
}

/** A character-level edit for a line that exists on both sides of a replace. */
export interface ReviewInlineChange {
  id: string;
  baseLine: number;
  currentLine: number;
  baseText: string;
  currentText: string;
  edits: ReviewInlineEdit[];
}

export interface ReviewInlineEdit {
  kind: 'insert' | 'delete';
  /** UTF-16 offsets in the baseline/current line text. */
  baseOffset: number;
  currentOffset: number;
  text: string;
}

export interface ReviewDeletedLine {
  /** Current-document insertion line, not the old line number. */
  line: number;
  baseLine: number;
  text: string;
  hunkId: string;
}

export interface ReviewDiff {
  baseline: string;
  current: string;
  hunks: ReviewHunk[];
  /** Individually reviewable contiguous edits, flattened in document order. */
  changes: ReviewChange[];
  addedLines: number[];
  deletedLines: ReviewDeletedLine[];
  changed: boolean;
}

interface LineToken {
  text: string;
  hasNewline: boolean;
  lineEnding: '' | '\n' | '\r\n';
}

interface ScriptEqual {
  kind: 'context';
  oldIndex: number;
  newIndex: number;
  line: LineToken;
}

interface ScriptDelete {
  kind: 'delete';
  oldIndex: number;
  line: LineToken;
}

interface ScriptInsert {
  kind: 'insert';
  newIndex: number;
  line: LineToken;
}

type ScriptItem = ScriptEqual | ScriptDelete | ScriptInsert;

/** Bounded Myers matching for both logical lines and inline characters. */
function matchingSequence<T>(
  before: T[],
  after: T[],
  maxDistance = Math.min(before.length + after.length, 2048),
): Array<[number, number]> | null {
  const trace: Map<number, number>[] = [];
  let frontier = new Map([[1, 0]]);
  let work = 0;
  for (let distance = 0; distance <= maxDistance; distance += 1) {
    const next = new Map<number, number>();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++work > 500_000) return null;
      const down =
        diagonal === -distance ||
        (diagonal !== distance &&
          (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1));
      let x = down ? (frontier.get(diagonal + 1) ?? 0) : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        if (++work > 500_000) return null;
        x += 1;
        y += 1;
      }
      next.set(diagonal, x);
      if (x >= before.length && y >= after.length) {
        const matches: Array<[number, number]> = [];
        for (let step = distance; step > 0; step -= 1) {
          const prior = trace[step - 1];
          const k = x - y;
          const priorK =
            k === -step || (k !== step && (prior.get(k - 1) ?? -1) < (prior.get(k + 1) ?? -1))
              ? k + 1
              : k - 1;
          const priorX = prior.get(priorK) ?? 0;
          const priorY = priorX - priorK;
          while (x > priorX && y > priorY) matches.push([--x, --y]);
          x = priorX;
          y = priorY;
        }
        while (x > 0 && y > 0) matches.push([--x, --y]);
        return matches.reverse();
      }
    }
    trace.push(next);
    frontier = next;
  }
  return null;
}

interface ChangeRun {
  scriptStart: number;
  scriptEnd: number;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

interface HunkGroup {
  runs: ChangeRun[];
  scriptStart: number;
  scriptEnd: number;
}

const UNIFIED_CONTEXT_LINES = 3;

function splitLines(value: string): LineToken[] {
  if (value.length === 0) return [];
  const lines: LineToken[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\n') continue;
    // Git blobs are normally LF even when the Windows working tree is CRLF.
    // Keep the logical line model consistent so a patch built from an editor
    // snapshot can still be applied to the index.
    const isCrLf = index > start && value[index - 1] === '\r';
    const textEnd = isCrLf ? index - 1 : index;
    lines.push({
      text: value.slice(start, textEnd),
      hasNewline: true,
      lineEnding: isCrLf ? '\r\n' : '\n',
    });
    start = index + 1;
  }
  if (start < value.length) {
    lines.push({ text: value.slice(start), hasNewline: false, lineEnding: '' });
  }
  return lines;
}

function lineValue(line: LineToken): string {
  return line.text + (line.hasNewline ? line.lineEnding : '');
}

function logicalLineValue(line: LineToken): string {
  return line.text + (line.hasNewline ? '\n' : '');
}

/**
 * A bounded Myers diff over logical lines. The bound keeps typing responsive for
 * very large documents; the fallback treats the remaining region as one change run.
 */
function matchingLines(before: string[], after: string[]): Array<[number, number]> | null {
  return matchingSequence(before, after);
}

function utf16Offsets(units: string[]): number[] {
  const offsets = [0];
  for (const unit of units) offsets.push(offsets.at(-1)! + unit.length);
  return offsets;
}

function pushInlineEdit(
  edits: ReviewInlineEdit[],
  kind: ReviewInlineEdit['kind'],
  oldUnits: string[],
  newUnits: string[],
  oldOffsets: number[],
  newOffsets: number[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): void {
  if (kind === 'delete' && oldStart < oldEnd) {
    edits.push({
      kind,
      baseOffset: oldOffsets[oldStart],
      currentOffset: newOffsets[newStart],
      text: oldUnits.slice(oldStart, oldEnd).join(''),
    });
  } else if (kind === 'insert' && newStart < newEnd) {
    edits.push({
      kind,
      baseOffset: oldOffsets[oldStart],
      currentOffset: newOffsets[newStart],
      text: newUnits.slice(newStart, newEnd).join(''),
    });
  }
}

/**
 * Keep only stable, non-whitespace matches as internal anchors. A single
 * repeated character is often an accidental alignment (for example the `n`
 * shared by `n old` and ` new`); a run of at least two characters containing a
 * non-space character is a safer boundary for semantic review marks.
 */
function stableInlineMatches(
  matches: Array<[number, number]>,
  oldUnits: string[],
  newUnits: string[],
): Array<[number, number]> {
  const stable: Array<[number, number]> = [];
  // A single non-whitespace match is safe when one side is only that token:
  // `ctl` -> `control` should keep the unchanged `t` and mark the inserted
  // text around it. A lone whitespace match is deliberately never a boundary.
  const allowSingleBoundaryMatch = oldUnits.length === 1 || newUnits.length === 1;
  let index = 0;
  while (index < matches.length) {
    const start = index;
    index += 1;
    while (
      index < matches.length &&
      matches[index][0] === matches[index - 1][0] + 1 &&
      matches[index][1] === matches[index - 1][1] + 1
    ) {
      index += 1;
    }
    const run = matches.slice(start, index);
    if (
      (run.length >= 2 ||
        (allowSingleBoundaryMatch && run.length === 1) ||
        // A semantic atom is one unit containing its complete source label.
        // Unlike a coincidental single letter, it is a stable shared boundary.
        run.some(([oldIndex]) => oldUnits[oldIndex].length > 2)) &&
      run.some(
        ([oldIndex, newIndex]) =>
          /\S/u.test(oldUnits[oldIndex] ?? '') || /\S/u.test(newUnits[newIndex] ?? ''),
      )
    ) {
      stable.push(...run);
    }
  }
  return stable;
}

/** Strings are diffed by code point; semantic callers can keep inline atoms indivisible. */
export function buildReviewInlineEdits(
  before: string | readonly string[],
  after: string | readonly string[],
): ReviewInlineEdit[] {
  if (before === after) return [];
  const oldUnits = typeof before === 'string' ? Array.from(before) : [...before];
  const newUnits = typeof after === 'string' ? Array.from(after) : [...after];
  const oldOffsets = utf16Offsets(oldUnits);
  const newOffsets = utf16Offsets(newUnits);

  // Always retain the unambiguous common prefix and suffix. This keeps a
  // local deletion local even when the surrounding text contains duplicates.
  let prefix = 0;
  while (
    prefix < oldUnits.length &&
    prefix < newUnits.length &&
    oldUnits[prefix] === newUnits[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldUnits.length - prefix &&
    suffix < newUnits.length - prefix &&
    oldUnits[oldUnits.length - suffix - 1] === newUnits[newUnits.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const oldMiddleEnd = oldUnits.length - suffix;
  const newMiddleEnd = newUnits.length - suffix;
  const oldMiddle = oldUnits.slice(prefix, oldMiddleEnd);
  const newMiddle = newUnits.slice(prefix, newMiddleEnd);
  const edits: ReviewInlineEdit[] = [];

  const addSimpleMiddle = () => {
    pushInlineEdit(
      edits,
      'delete',
      oldUnits,
      newUnits,
      oldOffsets,
      newOffsets,
      prefix,
      oldMiddleEnd,
      prefix,
      prefix,
    );
    pushInlineEdit(
      edits,
      'insert',
      oldUnits,
      newUnits,
      oldOffsets,
      newOffsets,
      prefix,
      prefix,
      prefix,
      newMiddleEnd,
    );
  };

  if (oldMiddle.length === 0 || newMiddle.length === 0) {
    addSimpleMiddle();
    return edits;
  }

  const matches = matchingSequence(
    oldMiddle,
    newMiddle,
    Math.min(oldMiddle.length + newMiddle.length, 4096),
  );
  if (!matches) {
    addSimpleMiddle();
    return edits;
  }
  const stableMatches = stableInlineMatches(matches, oldMiddle, newMiddle);
  if (stableMatches.length === 0) {
    addSimpleMiddle();
    return edits;
  }

  let oldIndex = prefix;
  let newIndex = prefix;
  for (const [matchedOldRelative, matchedNewRelative] of [
    ...stableMatches,
    [oldMiddle.length, newMiddle.length] as [number, number],
  ]) {
    const matchedOld = prefix + matchedOldRelative;
    const matchedNew = prefix + matchedNewRelative;
    // Emit replacements in Git's intuitive order: deleted text first, then
    // inserted text at the same current offset.
    pushInlineEdit(
      edits,
      'delete',
      oldUnits,
      newUnits,
      oldOffsets,
      newOffsets,
      oldIndex,
      matchedOld,
      newIndex,
      newIndex,
    );
    pushInlineEdit(
      edits,
      'insert',
      oldUnits,
      newUnits,
      oldOffsets,
      newOffsets,
      oldIndex,
      oldIndex,
      newIndex,
      matchedNew,
    );
    oldIndex = matchedOld + 1;
    newIndex = matchedNew + 1;
  }
  return edits;
}

function buildEditScript(oldLines: LineToken[], newLines: LineToken[]): ScriptItem[] {
  const oldValues = oldLines.map(logicalLineValue);
  const newValues = newLines.map(logicalLineValue);
  const matches = matchingLines(oldValues, newValues);
  if (!matches) {
    return [
      ...oldLines.map((line, oldIndex): ScriptDelete => ({ kind: 'delete', oldIndex, line })),
      ...newLines.map((line, newIndex): ScriptInsert => ({ kind: 'insert', newIndex, line })),
    ];
  }

  const script: ScriptItem[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const [matchedOld, matchedNew] of [
    ...matches,
    [oldLines.length, newLines.length] as [number, number],
  ]) {
    while (oldIndex < matchedOld) {
      script.push({ kind: 'delete', oldIndex, line: oldLines[oldIndex] });
      oldIndex += 1;
    }
    while (newIndex < matchedNew) {
      script.push({ kind: 'insert', newIndex, line: newLines[newIndex] });
      newIndex += 1;
    }
    if (matchedOld < oldLines.length && matchedNew < newLines.length) {
      script.push({
        kind: 'context',
        oldIndex: matchedOld,
        newIndex: matchedNew,
        line: oldLines[matchedOld],
      });
      oldIndex = matchedOld + 1;
      newIndex = matchedNew + 1;
    }
  }
  return script;
}

function findChangeRuns(script: ScriptItem[]): ChangeRun[] {
  const runs: ChangeRun[] = [];
  let index = 0;
  while (index < script.length) {
    if (script[index].kind === 'context') {
      index += 1;
      continue;
    }
    const scriptStart = index;
    let oldStart = Number.POSITIVE_INFINITY;
    let oldEnd = -1;
    let newStart = Number.POSITIVE_INFINITY;
    let newEnd = -1;
    while (index < script.length && script[index].kind !== 'context') {
      const item = script[index];
      if (item.kind === 'delete') {
        oldStart = Math.min(oldStart, item.oldIndex);
        oldEnd = Math.max(oldEnd, item.oldIndex + 1);
      } else {
        newStart = Math.min(newStart, item.newIndex);
        newEnd = Math.max(newEnd, item.newIndex + 1);
      }
      index += 1;
    }
    const previousContext = script[scriptStart - 1];
    const nextContext = script[index];
    const oldInsertionPoint =
      previousContext?.kind === 'context'
        ? previousContext.oldIndex + 1
        : nextContext?.kind === 'context'
          ? nextContext.oldIndex
          : 0;
    const newInsertionPoint =
      previousContext?.kind === 'context'
        ? previousContext.newIndex + 1
        : nextContext?.kind === 'context'
          ? nextContext.newIndex
          : 0;
    runs.push({
      scriptStart,
      scriptEnd: index,
      oldStart: Number.isFinite(oldStart) ? oldStart : oldInsertionPoint,
      oldEnd: oldEnd >= 0 ? oldEnd : oldInsertionPoint,
      newStart: Number.isFinite(newStart) ? newStart : newInsertionPoint,
      newEnd: newEnd >= 0 ? newEnd : newInsertionPoint,
    });
  }
  return runs;
}

function groupChangeRuns(runs: ChangeRun[], script: ScriptItem[]): HunkGroup[] {
  const groups: HunkGroup[] = [];
  for (const run of runs) {
    const previousGroup = groups.at(-1);
    const previousRun = previousGroup?.runs.at(-1);
    if (!previousGroup || !previousRun) {
      groups.push({ runs: [run], scriptStart: run.scriptStart, scriptEnd: run.scriptEnd });
      continue;
    }
    const unchangedItems = script.slice(previousRun.scriptEnd, run.scriptStart);
    if (unchangedItems.length <= UNIFIED_CONTEXT_LINES * 2) {
      previousGroup.runs.push(run);
      previousGroup.scriptEnd = run.scriptEnd;
    } else {
      groups.push({ runs: [run], scriptStart: run.scriptStart, scriptEnd: run.scriptEnd });
    }
  }
  return groups;
}

function withContext(
  range: { scriptStart: number; scriptEnd: number },
  script: ScriptItem[],
  lowerBound = 0,
  upperBound = script.length,
): { start: number; end: number } {
  let start = range.scriptStart;
  let before = 0;
  while (
    start > lowerBound &&
    script[start - 1].kind === 'context' &&
    before < UNIFIED_CONTEXT_LINES
  ) {
    start -= 1;
    before += 1;
  }
  let end = range.scriptEnd;
  let after = 0;
  while (end < upperBound && script[end].kind === 'context' && after < UNIFIED_CONTEXT_LINES) {
    end += 1;
    after += 1;
  }
  return { start, end };
}

/**
 * Git presents a replacement as deleted lines followed by inserted lines even
 * when the shortest edit script found a different but equivalent ordering.
 * Keep each contiguous change run in that stable order while leaving context
 * lines in their original positions.
 */
function orderPatchItems(items: ScriptItem[]): ScriptItem[] {
  const ordered: ScriptItem[] = [];
  let index = 0;
  while (index < items.length) {
    if (items[index].kind === 'context') {
      ordered.push(items[index]);
      index += 1;
      continue;
    }
    const run: ScriptItem[] = [];
    while (index < items.length && items[index].kind !== 'context') {
      run.push(items[index]);
      index += 1;
    }
    ordered.push(...run.filter((item) => item.kind === 'delete'));
    ordered.push(...run.filter((item) => item.kind === 'insert'));
  }
  return ordered;
}

function buildInlineChanges(
  runs: ChangeRun[],
  oldLines: LineToken[],
  newLines: LineToken[],
  idPrefix: string,
): ReviewInlineChange[] {
  const result: ReviewInlineChange[] = [];
  for (const run of runs) {
    // A character-level mapping is only reliable when one old line becomes
    // one new line. Multi-line edits remain block-level review marks.
    if (run.oldEnd - run.oldStart !== 1 || run.newEnd - run.newStart !== 1) continue;
    const oldLine = oldLines[run.oldStart];
    const newLine = newLines[run.newStart];
    if (!oldLine || !newLine || oldLine.text === newLine.text) continue;
    const edits = buildReviewInlineEdits(oldLine.text, newLine.text);
    if (edits.length === 0) continue;
    result.push({
      id: `${idPrefix}:inline-${result.length + 1}`,
      baseLine: run.oldStart + 1,
      currentLine: run.newStart + 1,
      baseText: oldLine.text,
      currentText: newLine.text,
      edits,
    });
  }
  return result;
}

function formatRange(start: number, count: number): string {
  if (count === 0) return `${Math.max(0, start)},0`;
  return count === 1 ? `${start}` : `${start},${count}`;
}

function createReviewRange(
  runs: ChangeRun[],
  context: { start: number; end: number },
  script: ScriptItem[],
  oldLines: LineToken[],
  newLines: LineToken[],
  id: string,
): ReviewHunk {
  const changedOldStart = Math.min(...runs.map((run) => run.oldStart));
  const changedOldEnd = Math.max(...runs.map((run) => run.oldEnd));
  const changedNewStart = Math.min(...runs.map((run) => run.newStart));
  const changedNewEnd = Math.max(...runs.map((run) => run.newEnd));
  const patchItems = orderPatchItems(script.slice(context.start, context.end));
  const patchLines: ReviewDiffLine[] = [];
  for (const item of patchItems) {
    if (item.kind === 'context') {
      patchLines.push({
        kind: 'context',
        text: item.line.text,
        baseLine: item.oldIndex + 1,
        currentLine: item.newIndex + 1,
        hasNewline: item.line.hasNewline,
        lineEnding: item.line.lineEnding || undefined,
      });
    } else if (item.kind === 'delete') {
      patchLines.push({
        kind: 'delete',
        text: item.line.text,
        baseLine: item.oldIndex + 1,
        currentLine: null,
        hasNewline: item.line.hasNewline,
        lineEnding: item.line.lineEnding || undefined,
      });
    } else {
      patchLines.push({
        kind: 'insert',
        text: item.line.text,
        baseLine: null,
        currentLine: item.newIndex + 1,
        hasNewline: item.line.hasNewline,
        lineEnding: item.line.lineEnding || undefined,
      });
    }
  }

  const oldSide = patchLines.filter((line) => line.kind !== 'insert');
  const newSide = patchLines.filter((line) => line.kind !== 'delete');
  const patchBaseStart = oldSide[0]?.baseLine ?? changedOldStart;
  const patchCurrentStart = newSide[0]?.currentLine ?? changedNewStart;
  const patchBaseCount = oldSide.length;
  const patchCurrentCount = newSide.length;
  const patchLineEnding =
    oldSide.find((line) => line.hasNewline)?.lineEnding ??
    newSide.find((line) => line.hasNewline)?.lineEnding ??
    '\n';
  const contextLines = patchLines.filter((line) => line.kind === 'context');
  const addedLines = patchLines.filter((line) => line.kind === 'insert');
  const deletedLines = patchLines.filter((line) => line.kind === 'delete');
  const oldChanged = runs.flatMap((run) => oldLines.slice(run.oldStart, run.oldEnd).map(lineValue));
  const newChanged = runs.flatMap((run) => newLines.slice(run.newStart, run.newEnd).map(lineValue));
  const inlineChanges = buildInlineChanges(runs, oldLines, newLines, id);
  const kind: ReviewChangeKind =
    oldChanged.length === 0 ? 'insert' : newChanged.length === 0 ? 'delete' : 'replace';

  return {
    id,
    kind,
    baseStart: changedOldStart + 1,
    baseEnd: changedOldEnd,
    currentStart: changedNewStart + 1,
    currentEnd: changedNewEnd,
    patchBaseStart,
    patchBaseCount,
    patchCurrentStart,
    patchCurrentCount,
    oldLines: oldChanged,
    newLines: newChanged,
    lines: patchLines,
    context: contextLines,
    added: addedLines,
    deleted: deletedLines,
    inlineChanges,
    patchLineEnding,
  };
}

function createHunk(
  group: HunkGroup,
  script: ScriptItem[],
  oldLines: LineToken[],
  newLines: LineToken[],
  index: number,
): ReviewHunk {
  return createReviewRange(
    group.runs,
    withContext(group, script),
    script,
    oldLines,
    newLines,
    `review-${index + 1}`,
  );
}

export function computeReviewDiff(baseline: string, current: string): ReviewDiff {
  if (baseline === current) {
    return {
      baseline,
      current,
      hunks: [],
      changes: [],
      addedLines: [],
      deletedLines: [],
      changed: false,
    };
  }
  const oldLines = splitLines(baseline);
  const newLines = splitLines(current);
  const script = buildEditScript(oldLines, newLines);
  const runs = findChangeRuns(script);
  const groups = groupChangeRuns(runs, script);
  const hunks = groups.map((group, index) => createHunk(group, script, oldLines, newLines, index));
  const runIndexes = new Map(runs.map((run, index) => [run, index]));
  const changes: ReviewChange[] = [];
  for (const [hunkIndex, group] of groups.entries()) {
    for (const [changeIndex, run] of group.runs.entries()) {
      const runIndex = runIndexes.get(run)!;
      const previousRun = runs[runIndex - 1];
      const nextRun = runs[runIndex + 1];
      const reviewRange = createReviewRange(
        [run],
        withContext(
          run,
          script,
          previousRun?.scriptEnd ?? 0,
          nextRun?.scriptStart ?? script.length,
        ),
        script,
        oldLines,
        newLines,
        `${hunks[hunkIndex].id}:change-${changeIndex + 1}`,
      );
      changes.push({ ...reviewRange, parentHunkId: hunks[hunkIndex].id });
    }
  }
  const addedLines: number[] = [];
  const deletedLines: ReviewDeletedLine[] = [];
  for (const hunk of hunks) {
    const nextCurrentLines: Array<number | null> = new Array(hunk.lines.length).fill(null);
    let nextCurrent: number | null = null;
    for (let index = hunk.lines.length - 1; index >= 0; index -= 1) {
      nextCurrentLines[index] = nextCurrent;
      const currentLine = hunk.lines[index].currentLine;
      if (currentLine !== null) nextCurrent = currentLine;
    }
    let previousCurrent: number | null = null;
    for (let index = 0; index < hunk.lines.length; index += 1) {
      const line = hunk.lines[index];
      if (line.kind === 'insert' && line.currentLine !== null) {
        addedLines.push(line.currentLine);
      }
      if (line.kind === 'delete' && line.baseLine !== null) {
        // The next current line is the insertion point for a deleted run. For
        // grouped hunks this is reconstructed from the unified line stream.
        const anchorLine = nextCurrentLines[index] ?? (previousCurrent ?? 0) + 1;
        line.currentAnchorLine = anchorLine;
        deletedLines.push({
          line: anchorLine,
          baseLine: line.baseLine,
          text: `${line.text}${line.hasNewline ? (line.lineEnding ?? '\n') : ''}`,
          hunkId: hunk.id,
        });
      }
      if (line.currentLine !== null) previousCurrent = line.currentLine;
    }
  }
  return {
    baseline,
    current,
    hunks,
    changes,
    addedLines: [...new Set(addedLines)],
    deletedLines,
    changed: hunks.length > 0,
  };
}

export interface ReviewSourceDecoration {
  line: number;
  kind: 'added' | 'deleted';
  text?: string;
  trailingWhitespace?: string;
}

/** Build CodeMirror line/widget specs from the same unified hunk stream. */
export function buildReviewSourceDecorations(diff: ReviewDiff | null): ReviewSourceDecoration[] {
  const deletedByLine = new Map<number, string[]>();
  const addedTrailingWhitespace = new Map<number, string>();
  for (const hunk of diff?.hunks ?? []) {
    for (const line of hunk.added) {
      if (line.currentLine === null) continue;
      const trailingWhitespace = line.text.match(/[\t ]+$/)?.[0];
      if (
        trailingWhitespace &&
        trailingWhitespace.length > (addedTrailingWhitespace.get(line.currentLine)?.length ?? 0)
      ) {
        addedTrailingWhitespace.set(line.currentLine, trailingWhitespace);
      }
    }
  }
  for (const deleted of diff?.deletedLines ?? []) {
    const lines = deletedByLine.get(deleted.line) ?? [];
    lines.push(deleted.text);
    deletedByLine.set(deleted.line, lines);
  }
  return [
    ...(diff?.addedLines ?? []).map((line) => ({
      line,
      kind: 'added' as const,
      ...(addedTrailingWhitespace.has(line)
        ? { trailingWhitespace: addedTrailingWhitespace.get(line) }
        : {}),
    })),
    ...Array.from(deletedByLine, ([line, lines]) => ({
      line,
      kind: 'deleted' as const,
      text: lines.join(''),
    })),
  ].sort((left, right) => left.line - right.line || (left.kind === 'deleted' ? -1 : 1));
}

function patchLineText(line: ReviewDiffLine, patchLineEnding: '\n' | '\r\n'): string {
  const prefix = line.kind === 'context' ? ' ' : line.kind === 'delete' ? '-' : '+';
  // Keep the patch stream on the baseline/index line-ending convention. Git
  // treats unchanged lines as context, so preserving that convention avoids
  // accidentally introducing mixed CRLF/LF bytes into the staged blob when
  // an editor normalizes only the changed lines.
  const lineEnding = line.hasNewline
    ? line.kind === 'insert'
      ? patchLineEnding
      : (line.lineEnding ?? patchLineEnding)
    : '\n';
  return `${prefix}${line.text}${lineEnding}${line.hasNewline ? '' : '\\ No newline at end of file\n'}`;
}

export function buildUnifiedPatch(
  path: string,
  _baseline: string,
  _current: string,
  selected: ReviewHunk,
): string {
  const normalizedPath = path.replace(/\\/g, '/');
  const body = selected.lines
    .map((line) => patchLineText(line, selected.patchLineEnding ?? '\n'))
    .join('');
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    `@@ -${formatRange(selected.patchBaseStart, selected.patchBaseCount)} +${formatRange(selected.patchCurrentStart, selected.patchCurrentCount)} @@`,
    body.replace(/\n$/, ''),
    '',
  ].join('\n');
}
