<script lang="ts">
  import { Check, GitBranch, RefreshCw, RotateCcw, X } from '@lucide/svelte';
  import type { ReviewChange, ReviewDiff } from '../../lib/review/review';

  export let diff: ReviewDiff | null = null;
  export let interfaceLocale = 'zh-CN';
  export let baselineCommit = '';
  export let repoRoot = '';
  export let busy = false;
  export let selectedChangeId = '';
  export let onAcceptChange: (change: ReviewChange) => void = () => undefined;
  export let onAcceptAll: () => void = () => undefined;
  export let onReject: () => void = () => undefined;
  export let onRefresh: () => void = () => undefined;
  export let onClose: () => void = () => undefined;
  export let onSelectionChange: (change: ReviewChange) => void = () => undefined;

  $: selected =
    diff?.changes.find((change) => change.id === selectedChangeId) ?? diff?.changes[0] ?? null;
  $: copy = interfaceLocale.startsWith('en')
    ? {
        title: 'Review mode',
        changes: 'changes',
        baseline: 'Baseline',
        refresh: 'Refresh review baseline',
        empty: 'The working copy matches the baseline.',
        insert: 'Added',
        delete: 'Deleted',
        replace: 'Changed',
        accept: 'Accept',
        all: 'Accept all',
        restore: 'Restore from index',
        exit: 'Exit review mode',
        added: 'Added',
        deleted: 'Deleted',
        oldLine: 'Old line',
        newLine: 'New line',
      }
    : interfaceLocale.startsWith('ja')
      ? {
          title: 'レビュー モード',
          changes: '件の変更',
          baseline: 'ベースライン',
          refresh: 'レビューの基準を更新',
          empty: '作業コピーは基準と一致しています。',
          insert: '追加',
          delete: '削除',
          replace: '変更',
          accept: '承認',
          all: 'すべて承認',
          restore: 'ステージから復元',
          exit: 'レビュー モードを終了',
          added: '追加',
          deleted: '削除',
          oldLine: '旧行',
          newLine: '新行',
        }
      : {
          title: '审阅模式',
          changes: '处修改',
          baseline: '基线',
          refresh: '刷新审阅基线',
          empty: '当前工作区与基线一致。',
          insert: '新增',
          delete: '删除',
          replace: '替换',
          accept: '接受',
          all: '接受全部',
          restore: '根据暂存区回滚',
          exit: '退出审阅模式',
          added: '新增',
          deleted: '删除',
          oldLine: '旧行',
          newLine: '新行',
        };

  function select(change: ReviewChange) {
    onSelectionChange(change);
  }

  function rangeLabel(start: number, count: number): string {
    if (count === 0) return `${Math.max(0, start)},0`;
    return count === 1 ? String(start) : `${start},${count}`;
  }

  function unifiedHeader(change: ReviewChange): string {
    return `@@ -${rangeLabel(change.patchBaseStart, change.patchBaseCount)} +${rangeLabel(change.patchCurrentStart, change.patchCurrentCount)} @@`;
  }

  function previewLine(change: ReviewChange): string {
    return (
      change.lines.find((line) => line.kind !== 'context')?.text ?? change.lines[0]?.text ?? ''
    );
  }

  function lineBody(text: string): string {
    const trailingLength = text.match(/[\t ]+$/)?.[0].length ?? 0;
    return trailingLength ? text.slice(0, -trailingLength) : text;
  }

  function lineTrailingWhitespace(text: string): string {
    return text.match(/[\t ]+$/)?.[0] ?? '';
  }
</script>

{#if diff}
  <aside class="review-panel" aria-label={copy.title}>
    <header class="review-panel-header">
      <div class="review-panel-title">
        <GitBranch size={15} />
        <strong>{copy.title}</strong>
        <span class="review-count">{diff.changes.length} {copy.changes}</span>
      </div>
      <button
        class="review-icon-button"
        type="button"
        title={copy.refresh}
        aria-label={copy.refresh}
        on:click={onRefresh}
        disabled={busy}
      >
        <RefreshCw size={14} />
      </button>
    </header>
    <div class="review-panel-meta" title={repoRoot}>
      {copy.baseline}
      {baselineCommit.slice(0, 8) || 'uncommitted'}
    </div>
    {#if diff.changes.length === 0}
      <p class="review-empty">{copy.empty}</p>
    {:else}
      <div class="review-change-list" role="listbox" aria-label={copy.title}>
        {#each diff.changes as change (change.id)}
          <button
            class:selected={selected?.id === change.id}
            class="review-change"
            type="button"
            role="option"
            aria-selected={selected?.id === change.id}
            on:click={() => select(change)}
          >
            <span class="review-change-marker" class:deleted={change.kind === 'delete'}></span>
            <span class="review-change-label">
              {change.kind === 'insert'
                ? copy.insert
                : change.kind === 'delete'
                  ? copy.delete
                  : copy.replace}
              · {unifiedHeader(change)}
            </span>
            <span class="review-change-preview">{previewLine(change)}</span>
          </button>
        {/each}
      </div>
      {#if selected}
        <div class="review-detail" aria-label={copy.title}>
          <div class="review-detail-header" aria-hidden="true">
            <span>{copy.oldLine}</span>
            <span>{copy.newLine}</span>
            <span></span>
            <span></span>
          </div>
          {#each selected.lines as line, lineIndex (`${selected.id}:${lineIndex}`)}
            <div
              class:review-detail-added={line.kind === 'insert'}
              class:review-detail-deleted={line.kind === 'delete'}
              class="review-detail-line"
              data-review-kind={line.kind}
              data-old-line={line.baseLine ?? ''}
              data-new-line={line.currentLine ?? ''}
            >
              <span class="review-detail-number">{line.baseLine ?? ''}</span>
              <span class="review-detail-number">{line.currentLine ?? ''}</span>
              <span class="review-detail-marker"
                >{line.kind === 'insert' ? '+' : line.kind === 'delete' ? '-' : ' '}</span
              >
              <span class="review-detail-text"
                >{lineBody(line.text) ||
                  (lineTrailingWhitespace(line.text)
                    ? ''
                    : ' ')}{#if lineTrailingWhitespace(line.text)}<span
                    class="review-detail-trailing-whitespace"
                    >{lineTrailingWhitespace(line.text)}</span
                  >{/if}</span
              >
            </div>
            {#if !line.hasNewline}
              <div class="review-detail-no-newline">\ No newline at end of file</div>
            {/if}
          {/each}
        </div>
        <div class="review-panel-actions">
          <button
            type="button"
            class="review-action review-action-accept"
            on:click={() => onAcceptChange(selected)}
            disabled={busy}
          >
            <Check size={14} />{copy.accept}
          </button>
          <button type="button" class="review-action" on:click={onAcceptAll} disabled={busy}>
            <Check size={14} />{copy.all}
          </button>
          <button
            type="button"
            class="review-action review-action-reject"
            on:click={onReject}
            disabled={busy}
          >
            <RotateCcw size={14} />{copy.restore}
          </button>
        </div>
      {/if}
    {/if}
    <div class="review-legend">
      <span class="review-legend-added">{copy.added}</span>
      <span class="review-legend-deleted">{copy.deleted}</span>
      <button
        class="review-close-button"
        type="button"
        title={copy.exit}
        aria-label={copy.exit}
        on:click={onClose}
        disabled={busy}
      >
        <X size={13} />
      </button>
    </div>
  </aside>
{/if}
