<script lang="ts">
  import { onMount } from 'svelte';
  import { Copy, Languages, LoaderCircle, RotateCw, X } from '@lucide/svelte';
  import type {
    GoogleTranslationResult,
    TranslationLanguage,
  } from '../services/googleTranslate';
  import type { EffectiveInterfaceLocale } from '../i18n';
  import './TranslationDialog.css';

  export let open: boolean;
  export let interfaceLocale: EffectiveInterfaceLocale;
  export let sourceText = '';
  export let result: GoogleTranslationResult | null = null;
  export let busy = false;
  export let error = '';
  export let onClose: () => void;
  export let onRetry: () => void;
  export let onCopy: () => void;

  const labels = {
    'zh-CN': {
      title: '翻译',
      original: '原文',
      result: '译文',
      loading: '正在翻译...',
      empty: '暂无译文',
      retry: '重试',
      copy: '复制译文',
      close: '关闭',
      zhToEn: '中文 → English',
      enToZh: 'English → 中文',
    },
    'zh-TW': {
      title: '翻譯',
      original: '原文',
      result: '譯文',
      loading: '正在翻譯...',
      empty: '暫無譯文',
      retry: '重試',
      copy: '複製譯文',
      close: '關閉',
      zhToEn: '中文 → English',
      enToZh: 'English → 中文',
    },
    'en-US': {
      title: 'Translate',
      original: 'Original',
      result: 'Translation',
      loading: 'Translating...',
      empty: 'No translation yet',
      retry: 'Retry',
      copy: 'Copy translation',
      close: 'Close',
      zhToEn: 'Chinese → English',
      enToZh: 'English → Chinese',
    },
    'ja-JP': {
      title: '翻訳',
      original: '原文',
      result: '翻訳結果',
      loading: '翻訳中...',
      empty: '翻訳結果はありません',
      retry: '再試行',
      copy: '翻訳をコピー',
      close: '閉じる',
      zhToEn: '中国語 → 英語',
      enToZh: '英語 → 中国語',
    },
  };
  $: l = labels[interfaceLocale] ?? labels['en-US'];

  let dialogEl: HTMLDivElement;

  onMount(() => {
    dialogEl?.focus();
  });

  function languageDirection(sourceLanguage: TranslationLanguage | undefined) {
    return sourceLanguage === 'zh-CN' ? l.zhToEn : l.enToZh;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="translation-backdrop" on:click={onClose}>
    <div
      bind:this={dialogEl}
      class="translation-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={l.title}
      tabindex="-1"
      on:click|stopPropagation
    >
      <header class="translation-header">
        <Languages size={18} aria-hidden="true" />
        <h2>{l.title}</h2>
        <button class="translation-close" type="button" aria-label={l.close} title={l.close} on:click={onClose}>
          <X size={18} />
        </button>
      </header>

      <div class="translation-content">
        {#if result}
          <div class="translation-direction">{languageDirection(result.sourceLanguage)}</div>
        {/if}
        <section class="translation-pane">
          <div class="translation-pane-title">{l.original}</div>
          <div class="translation-text original">{sourceText}</div>
        </section>
        <section class="translation-pane result-pane">
          <div class="translation-pane-title">
            <span>{l.result}</span>
            {#if result && !busy}
              <button class="translation-copy" type="button" on:click={onCopy}>
                <Copy size={14} />
                {l.copy}
              </button>
            {/if}
          </div>
          {#if busy}
            <div class="translation-state" role="status">
              <LoaderCircle class="translation-spinner" size={18} />
              <span>{l.loading}</span>
            </div>
          {:else if error}
            <div class="translation-state error" role="alert">{error}</div>
          {:else if result}
            <div class="translation-text" aria-live="polite">{result.translatedText}</div>
          {:else}
            <div class="translation-state">{l.empty}</div>
          {/if}
        </section>
      </div>

      <footer class="translation-footer">
        {#if error}
          <button class="translation-button secondary" type="button" on:click={onRetry}>
            <RotateCw size={14} />
            {l.retry}
          </button>
        {/if}
        <button class="translation-button primary" type="button" on:click={onClose}>
          <X size={14} />
          {l.close}
        </button>
      </footer>
    </div>
  </div>
{/if}
