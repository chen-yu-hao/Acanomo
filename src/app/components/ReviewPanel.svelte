<script lang="ts">
  import { Check, GitBranch, RefreshCw, RotateCcw, X } from '@lucide/svelte';
  import type { ReviewDiff, ReviewHunk } from '../../lib/review/review';

  export let diff: ReviewDiff | null = null;
  export let interfaceLocale = 'zh-CN';
  export let baselineCommit = '';
  export let repoRoot = '';
  export let busy = false;
  export let onAcceptHunk: (hunk: ReviewHunk) => void = () => undefined;
  export let onAcceptAll: () => void = () => undefined;
  export let onReject: () => void = () => undefined;
  export let onRefresh: () => void = () => undefined;
  export let onClose: () => void = () => undefined;
  export let onSelectionChange: (hunk: ReviewHunk) => void = () => undefined;

  let selectedId = '';
  $: selected = diff?.hunks.find((hunk) => hunk.id === selectedId) ?? diff?.hunks[0] ?? null;
  $: copy = interfaceLocale.startsWith('en')
    ? { title: 'Review mode', changes: 'changes', baseline: 'Baseline', refresh: 'Refresh review baseline', empty: 'The working copy matches the baseline.', insert: 'Added', delete: 'Deleted', replace: 'Changed', accept: 'Accept', all: 'Accept all', restore: 'Restore from index', exit: 'Exit review mode', added: 'Added', deleted: 'Deleted' }
    : interfaceLocale.startsWith('ja')
      ? { title: 'レビュー モード', changes: '件の変更', baseline: 'ベースライン', refresh: 'レビューの基準を更新', empty: '作業コピーは基準と一致しています。', insert: '追加', delete: '削除', replace: '変更', accept: '承認', all: 'すべて承認', restore: 'ステージから復元', exit: 'レビュー モードを終了', added: '追加', deleted: '削除' }
      : { title: '审阅模式', changes: '处修改', baseline: '基线', refresh: '刷新审阅基线', empty: '当前工作区与基线一致。', insert: '新增', delete: '删除', replace: '替换', accept: '接受', all: '接受全部', restore: '根据暂存区回滚', exit: '退出审阅模式', added: '新增', deleted: '删除' };

  function select(hunk: ReviewHunk) {
    selectedId = hunk.id;
    onSelectionChange(hunk);
  }
</script>

{#if diff}
  <aside class="review-panel" aria-label={copy.title}>
    <header class="review-panel-header">
      <div class="review-panel-title">
        <GitBranch size={15} />
        <strong>{copy.title}</strong>
        <span class="review-count">{diff.hunks.length} {copy.changes}</span>
      </div>
      <button class="review-icon-button" type="button" title={copy.refresh} aria-label={copy.refresh} on:click={onRefresh} disabled={busy}>
        <RefreshCw size={14} />
      </button>
    </header>
    <div class="review-panel-meta" title={repoRoot}>
      {copy.baseline} {baselineCommit.slice(0, 8) || 'uncommitted'}
    </div>
    {#if diff.hunks.length === 0}
      <p class="review-empty">{copy.empty}</p>
    {:else}
      <div class="review-hunk-list" role="listbox" aria-label="审阅修改">
        {#each diff.hunks as hunk (hunk.id)}
          <button
            class:selected={selected?.id === hunk.id}
            class="review-hunk"
            type="button"
            role="option"
            aria-selected={selected?.id === hunk.id}
            on:click={() => select(hunk)}
          >
            <span class="review-hunk-marker" class:deleted={hunk.kind === 'delete'}></span>
            <span class="review-hunk-label">
              {hunk.kind === 'insert' ? copy.insert : hunk.kind === 'delete' ? copy.delete : copy.replace}
              · {hunk.currentStart}
            </span>
            <span class="review-hunk-preview">
              {hunk.newLines[0] ?? hunk.oldLines[0] ?? ''}
            </span>
          </button>
        {/each}
      </div>
      {#if selected}
        <div class="review-detail" aria-label="当前修改内容">
          {#each selected.oldLines as line}
            <div class="review-detail-line review-detail-deleted">{line.replace(/\n$/, '')}</div>
          {/each}
          {#each selected.newLines as line}
            <div class="review-detail-line review-detail-added">{line.replace(/\n$/, '')}</div>
          {/each}
        </div>
        <div class="review-panel-actions">
          <button type="button" class="review-action review-action-accept" on:click={() => onAcceptHunk(selected)} disabled={busy}>
            <Check size={14} />{copy.accept}
          </button>
          <button type="button" class="review-action" on:click={onAcceptAll} disabled={busy}>
            <Check size={14} />{copy.all}
          </button>
          <button type="button" class="review-action review-action-reject" on:click={onReject} disabled={busy}>
            <RotateCcw size={14} />{copy.restore}
          </button>
        </div>
      {/if}
    {/if}
    <div class="review-legend">
      <span class="review-legend-added">{copy.added}</span>
      <span class="review-legend-deleted">{copy.deleted}</span>
      <button class="review-close-button" type="button" title={copy.exit} aria-label={copy.exit} on:click={onClose} disabled={busy}>
        <X size={13} />
      </button>
    </div>
  </aside>
{/if}
