export type ReviewChangeKind = 'insert' | 'delete' | 'replace';

export interface ReviewHunk {
  id: string;
  kind: ReviewChangeKind;
  /** 1-based inclusive line range in the baseline. */
  baseStart: number;
  baseEnd: number;
  /** 1-based inclusive line range in the working copy. */
  currentStart: number;
  currentEnd: number;
  oldLines: string[];
  newLines: string[];
}

export interface ReviewDiff {
  baseline: string;
  current: string;
  hunks: ReviewHunk[];
  addedLines: number[];
  deletedLines: Array<{ line: number; text: string }>;
  changed: boolean;
}

interface LineToken {
  text: string;
  hasNewline: boolean;
}

function splitLines(value: string): LineToken[] {
  if (value.length === 0) return [];
  const lines: LineToken[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\n') continue;
    lines.push({ text: value.slice(start, index), hasNewline: true });
    start = index + 1;
  }
  if (start < value.length || value.endsWith('\n') === false) {
    lines.push({ text: value.slice(start), hasNewline: false });
  }
  return lines;
}

function lineValue(line: LineToken): string {
  return line.text + (line.hasNewline ? '\n' : '');
}

/**
 * A bounded Myers diff over logical lines. The bound keeps typing responsive for
 * very large documents; the fallback treats the remaining region as one hunk.
 */
function matchingLines(before: string[], after: string[]): Array<[number, number]> | null {
  const trace: Map<number, number>[] = [];
  let frontier = new Map([[1, 0]]);
  let work = 0;
  const maxDistance = Math.min(before.length + after.length, 2048);
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

function createHunk(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  newStart: number,
  index: number,
): ReviewHunk {
  const kind: ReviewChangeKind =
    oldLines.length === 0 ? 'insert' : newLines.length === 0 ? 'delete' : 'replace';
  return {
    id: `review-${index + 1}`,
    kind,
    baseStart: oldStart + 1,
    baseEnd: oldStart + oldLines.length,
    currentStart: newStart + 1,
    currentEnd: newStart + newLines.length,
    oldLines,
    newLines,
  };
}

export function computeReviewDiff(baseline: string, current: string): ReviewDiff {
  if (baseline === current) {
    return { baseline, current, hunks: [], addedLines: [], deletedLines: [], changed: false };
  }
  const oldTokens = splitLines(baseline);
  const newTokens = splitLines(current);
  const old = oldTokens.map((line) => lineValue(line));
  const next = newTokens.map((line) => lineValue(line));
  const matches = matchingLines(old, next);
  const hunks: ReviewHunk[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  const emit = (oldEnd: number, newEnd: number) => {
    if (oldEnd === oldIndex && newEnd === newIndex) return;
    hunks.push(createHunk(old.slice(oldIndex, oldEnd), next.slice(newIndex, newEnd), oldIndex, newIndex, hunks.length));
    oldIndex = oldEnd;
    newIndex = newEnd;
  };
  if (!matches) {
    emit(old.length, next.length);
  } else {
    for (const [oldMatch, newMatch] of [...matches, [old.length, next.length] as [number, number]]) {
      emit(oldMatch, newMatch);
      if (oldMatch < old.length && newMatch < next.length) {
        oldIndex = oldMatch + 1;
        newIndex = newMatch + 1;
      }
    }
  }

  const addedLines: number[] = [];
  const deletedLines: Array<{ line: number; text: string }> = [];
  for (const hunk of hunks) {
    for (let line = hunk.currentStart; line <= hunk.currentEnd; line += 1) addedLines.push(line);
    const anchor = Math.max(1, hunk.currentStart);
    hunk.oldLines.forEach((text, offset) => deletedLines.push({ line: anchor + offset, text }));
  }
  return { baseline, current, hunks, addedLines, deletedLines, changed: hunks.length > 0 };
}

export function buildUnifiedPatch(path: string, baseline: string, current: string, selected: ReviewHunk): string {
  const oldLines = splitLines(baseline).map(lineValue);
  const newLines = splitLines(current).map(lineValue);
  const context = 3;
  const oldStart = Math.max(0, selected.baseStart - 1 - context);
  const oldEnd = Math.min(oldLines.length, Math.max(oldStart, selected.baseEnd) + context);
  const newStart = Math.max(0, selected.currentStart - 1 - context);
  const newEnd = Math.min(newLines.length, Math.max(newStart, selected.currentEnd) + context);
  const oldContext = oldLines.slice(oldStart, Math.max(oldStart, selected.baseStart - 1));
  const oldChanged = oldLines.slice(Math.max(oldStart, selected.baseStart - 1), Math.max(oldStart, selected.baseEnd));
  const newContext = newLines.slice(newStart, Math.max(newStart, selected.currentStart - 1));
  const newChanged = newLines.slice(Math.max(newStart, selected.currentStart - 1), Math.max(newStart, selected.currentEnd));
  const suffixOld = oldLines.slice(Math.max(oldStart, selected.baseEnd), oldEnd);
  const suffixNew = newLines.slice(Math.max(newStart, selected.currentEnd), newEnd);
  // Context is chosen from both sides. For a replacement, the prefixes/suffixes
  // must be identical for git apply to accept the patch against HEAD.
  const prefix = oldContext.length <= newContext.length ? oldContext : newContext;
  const suffix = suffixOld.length <= suffixNew.length ? suffixOld : suffixNew;
  const body = [
    ...prefix.map((line) => ` ${line.replace(/\n$/, '')}`),
    ...oldChanged.map((line) => `-${line.replace(/\n$/, '')}`),
    ...newChanged.map((line) => `+${line.replace(/\n$/, '')}`),
    ...suffix.map((line) => ` ${line.replace(/\n$/, '')}`),
  ];
  const oldCount = prefix.length + oldChanged.length + suffix.length;
  const newCount = prefix.length + newChanged.length + suffix.length;
  const oldHeader = `${oldStart + 1},${oldCount}`;
  const newHeader = `${newStart + 1},${newCount}`;
  const normalizedPath = path.replace(/\\/g, '/');
  return `diff --git a/${normalizedPath} b/${normalizedPath}\n--- a/${normalizedPath}\n+++ b/${normalizedPath}\n@@ -${oldHeader} +${newHeader} @@\n${body.join('\n')}\n`;
}

