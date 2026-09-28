<script lang="ts">
  import { onMount } from 'svelte';
  import { BookOpen, Check, FileText, X } from '@lucide/svelte';
  import type { EffectiveInterfaceLocale } from '../i18n';
  import type { ExportFormat, ExportTemplateId } from '../../lib/export/exportTemplates';
  import './ExportTemplateDialog.css';

  export let open: boolean;
  export let format: ExportFormat;
  export let interfaceLocale: EffectiveInterfaceLocale;
  export let onClose: () => void;
  export let onSelect: (template: ExportTemplateId) => void;

  const labels = {
    'zh-CN': {
      latex: 'LaTeX',
      docx: 'Word',
      title: '选择导出版式',
      description: '选择一个期刊系列预设，然后继续导出。导出后仍可按期刊最新指南微调。',
      nature: 'Nature 系列',
      natureDescription: 'Nature 投稿初稿版式，使用便于兼容的 article 结构和 Nature 参考文献样式。',
      acs: 'ACS 系列',
      acsDescription: 'ACS 投稿初稿版式；LaTeX 优先使用 achemso，Word 使用 ACS 参考文献样式。',
      cancel: '取消',
      export: '选择并导出',
      selected: '已选择',
    },
    'zh-TW': {
      latex: 'LaTeX',
      docx: 'Word',
      title: '選擇匯出版式',
      description: '選擇期刊系列預設後繼續匯出；匯出後仍可依最新投稿指南微調。',
      nature: 'Nature 系列',
      natureDescription:
        'Nature 投稿初稿版式，使用相容性較好的 article 結構和 Nature 參考文獻樣式。',
      acs: 'ACS 系列',
      acsDescription: 'ACS 投稿初稿版式；LaTeX 優先使用 achemso，Word 使用 ACS 參考文獻樣式。',
      cancel: '取消',
      export: '選擇並匯出',
      selected: '已選擇',
    },
    'en-US': {
      latex: 'LaTeX',
      docx: 'Word',
      title: 'Choose an export template',
      description:
        'Choose a journal preset before exporting. Review the current journal guide after export.',
      nature: 'Nature family',
      natureDescription:
        'Nature-oriented manuscript preset with a portable article structure and Nature bibliography style.',
      acs: 'ACS family',
      acsDescription:
        'ACS-oriented manuscript preset; LaTeX prefers achemso and Word uses the ACS bibliography style.',
      cancel: 'Cancel',
      export: 'Choose and export',
      selected: 'Selected',
    },
    'ja-JP': {
      latex: 'LaTeX',
      docx: 'Word',
      title: '出力テンプレートを選択',
      description:
        'ジャーナルのプリセットを選んでから出力します。出力後に最新の投稿規定を確認してください。',
      nature: 'Nature 系列',
      natureDescription:
        '互換性の高い article 構成と Nature 参考文献スタイルを使う原稿用プリセット。',
      acs: 'ACS 系列',
      acsDescription:
        'ACS 原稿用プリセット。LaTeX は achemso、Word は ACS 参考文献スタイルを優先します。',
      cancel: 'キャンセル',
      export: '選択して出力',
      selected: '選択済み',
    },
  };

  $: l = labels[interfaceLocale] ?? labels['en-US'];
  $: formatLabel = format === 'latex' ? l.latex : l.docx;

  let selectedTemplate: ExportTemplateId = 'nature';
  let dialogEl: HTMLDivElement;

  onMount(() => dialogEl?.focus());

  $: if (open) {
    // Keep the default predictable each time a new export request opens the dialog.
    selectedTemplate = 'nature';
  }

  function choose() {
    onSelect(selectedTemplate);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose();
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="export-template-backdrop" on:click={onClose}>
    <div
      bind:this={dialogEl}
      class="export-template-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-template-title"
      tabindex="-1"
      on:click|stopPropagation
    >
      <header class="export-template-header">
        <BookOpen size={18} aria-hidden="true" />
        <div>
          <h2 id="export-template-title">{l.title}</h2>
          <p>{formatLabel} · {l.description}</p>
        </div>
        <button
          class="export-template-close"
          type="button"
          aria-label={l.cancel}
          on:click={onClose}
        >
          <X size={18} />
        </button>
      </header>

      <div class="export-template-options" role="radiogroup" aria-label={l.title}>
        <button
          type="button"
          class:selected={selectedTemplate === 'nature'}
          class="export-template-option"
          role="radio"
          aria-checked={selectedTemplate === 'nature'}
          on:click={() => (selectedTemplate = 'nature')}
        >
          <span class="export-template-option-icon"><FileText size={18} /></span>
          <span class="export-template-option-copy">
            <strong>{l.nature}</strong>
            <span>{l.natureDescription}</span>
          </span>
          {#if selectedTemplate === 'nature'}<Check size={17} aria-label={l.selected} />{/if}
        </button>
        <button
          type="button"
          class:selected={selectedTemplate === 'acs'}
          class="export-template-option"
          role="radio"
          aria-checked={selectedTemplate === 'acs'}
          on:click={() => (selectedTemplate = 'acs')}
        >
          <span class="export-template-option-icon"><FileText size={18} /></span>
          <span class="export-template-option-copy">
            <strong>{l.acs}</strong>
            <span>{l.acsDescription}</span>
          </span>
          {#if selectedTemplate === 'acs'}<Check size={17} aria-label={l.selected} />{/if}
        </button>
      </div>

      <footer class="export-template-footer">
        <button class="export-template-button secondary" type="button" on:click={onClose}
          >{l.cancel}</button
        >
        <button class="export-template-button primary" type="button" on:click={choose}
          >{l.export}</button
        >
      </footer>
    </div>
  </div>
{/if}
