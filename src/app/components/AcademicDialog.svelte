<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { BookOpen, Search, X } from '@lucide/svelte';
  import type { AcademicDocumentSettings, ZoteroItem } from '../../lib/academic/academic';
  import { parseCitationKeys } from '../../lib/academic/academic';
  import { searchZotero } from '../../lib/services/zotero';
  import type { EffectiveInterfaceLocale } from '../i18n';
  import './AcademicDialog.css';

  export let mode: 'citation' | 'settings' | 'label' | 'reference';
  export let interfaceLocale: EffectiveInterfaceLocale;
  export let settings: AcademicDocumentSettings;
  export let equationLabels: string[] = [];
  export let onClose: () => void;
  export let onInsert: (keys: string[]) => void;
  export let onSettings: (settings: AcademicDocumentSettings) => void;
  export let onLabel: (label: string) => void;
  export let onReference: (label: string) => void;

  const labels = {
    'zh-CN': {
      citation: '插入文献引用',
      settings: '学术写作设置',
      label: '为公式添加标签',
      reference: '插入公式引用',
      search: '搜索 Zotero 标题、作者或 key',
      keys: '粘贴 [@KEY; @KEY] 或添加搜索结果',
      insert: '插入',
      apply: '应用',
      cancel: '取消',
      numbering: '行间公式编号',
      auto: '自动',
      section: '分节',
      manual: '手动',
      style: '文献引用样式',
      numeric: '数字制',
      authorYear: '作者年份制',
      eqLabel: '公式标签',
      noResults: '没有匹配的文献',
      unavailable: '无法连接 Zotero；仍可输入已有 item key',
      selected: '待插入',
      empty: '输入 Zotero item key 或选择文献',
      invalid: '标签只支持字母、数字、冒号、下划线和连字符',
    },
    'zh-TW': {
      citation: '插入文獻引用',
      settings: '學術寫作設定',
      label: '為公式加入標籤',
      reference: '插入公式引用',
      search: '搜尋 Zotero 標題、作者或 key',
      keys: '貼上 [@KEY; @KEY] 或加入搜尋結果',
      insert: '插入',
      apply: '套用',
      cancel: '取消',
      numbering: '行間公式編號',
      auto: '自動',
      section: '分節',
      manual: '手動',
      style: '文獻引用樣式',
      numeric: '數字制',
      authorYear: '作者年份制',
      eqLabel: '公式標籤',
      noResults: '沒有符合的文獻',
      unavailable: '無法連接 Zotero；仍可輸入現有 item key',
      selected: '待插入',
      empty: '輸入 Zotero item key 或選擇文獻',
      invalid: '標籤僅支援字母、數字、冒號、底線和連字號',
    },
    'en-US': {
      citation: 'Insert Citation',
      settings: 'Academic Writing Settings',
      label: 'Label Equation',
      reference: 'Insert Equation Reference',
      search: 'Search Zotero title, author, or key',
      keys: 'Paste [@KEY; @KEY] or add search results',
      insert: 'Insert',
      apply: 'Apply',
      cancel: 'Cancel',
      numbering: 'Display equation numbering',
      auto: 'Automatic',
      section: 'By section',
      manual: 'Manual',
      style: 'Citation style',
      numeric: 'Numeric',
      authorYear: 'Author-year',
      eqLabel: 'Equation label',
      noResults: 'No matching items',
      unavailable: 'Zotero is unavailable; existing item keys can still be entered',
      selected: 'Selected',
      empty: 'Enter a Zotero item key or select an item',
      invalid: 'Use only letters, numbers, colons, underscores, and hyphens',
    },
    'ja-JP': {
      citation: '文献引用を挿入',
      settings: '学術執筆の設定',
      label: '数式にラベルを付ける',
      reference: '数式参照を挿入',
      search: 'Zotero のタイトル・著者・キーを検索',
      keys: '[@KEY; @KEY] を貼り付けるか検索結果を追加',
      insert: '挿入',
      apply: '適用',
      cancel: 'キャンセル',
      numbering: '別行数式の番号',
      auto: '自動',
      section: '節ごと',
      manual: '手動',
      style: '引用スタイル',
      numeric: '数字',
      authorYear: '著者・年',
      eqLabel: '数式ラベル',
      noResults: '該当する文献はありません',
      unavailable: 'Zotero に接続できません。既存のキーは入力できます',
      selected: '挿入する文献',
      empty: 'Zotero キーを入力するか文献を選択してください',
      invalid: '英数字、コロン、アンダースコア、ハイフンのみ使用できます',
    },
  };
  $: l = labels[interfaceLocale] ?? labels['en-US'];

  let search = '';
  let rawKeys = '';
  let chosen: string[] = [];
  let results: ZoteroItem[] = [];
  let busy = false;
  let error = '';
  let localSettings = { ...settings };
  let equationLabel = '';
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let requestId = 0;
  let dialogEl: HTMLDivElement;

  onMount(() => {
    dialogEl.querySelector<HTMLElement>('input, select')?.focus();
    if (mode === 'citation') void lookup();
  });
  onDestroy(() => {
    clearTimeout(searchTimer);
    requestId += 1;
  });

  function scheduleLookup() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void lookup(), 250);
  }

  async function lookup() {
    const id = ++requestId;
    busy = true;
    error = '';
    try {
      const items = await searchZotero(search);
      if (id === requestId) results = items;
    } catch {
      if (id === requestId) {
        results = [];
        error = l.unavailable;
      }
    } finally {
      if (id === requestId) busy = false;
    }
  }

  function submit() {
    if (mode === 'citation') {
      const keys = [
        ...new Set([
          ...chosen,
          ...parseCitationKeys(rawKeys),
          ...rawKeys.split(/[;,\s]+/).filter((key) => /^[A-Z0-9]{8}$/.test(key)),
        ]),
      ];
      if (!keys.length) {
        error = l.empty;
        return;
      }
      onInsert(keys);
    } else if (mode === 'settings') {
      onSettings(localSettings);
    } else {
      const label = equationLabel.trim();
      if (!/^[A-Za-z0-9:_-]+$/.test(label)) {
        error = l.invalid;
        return;
      }
      if (mode === 'label') onLabel(label);
      else onReference(label);
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />
<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="academic-backdrop" on:click={onClose}>
  <div
    bind:this={dialogEl}
    class="academic-dialog"
    role="dialog"
    aria-modal="true"
    aria-label={l[mode]}
    tabindex="-1"
    on:click|stopPropagation
  >
    <header>
      <BookOpen size={17} />
      <h2>{l[mode]}</h2>
      <button class="icon" aria-label={l.cancel} title={l.cancel} on:click={onClose}
        ><X size={18} /></button
      >
    </header>
    {#if mode === 'citation'}
      <div class="academic-content">
        <label class="search"
          ><Search size={16} /><input
            placeholder={l.search}
            bind:value={search}
            on:input={scheduleLookup}
          /></label
        >
        {#if error}<p class="message" role="status">{error}</p>{/if}
        <div class="results" role="listbox" aria-label={l.search}>
          {#each results as item (item.key)}
            <button
              class="result"
              class:chosen={chosen.includes(item.key)}
              on:click={() =>
                (chosen = chosen.includes(item.key)
                  ? chosen.filter((key) => key !== item.key)
                  : [...chosen, item.key])}
            >
              <span class="result-title">{item.title ?? item.key}</span>
              <span class="result-meta"
                >{item.creators?.[0]?.lastName ?? ''} · {item.date?.slice(0, 4) ?? ''} · {item.key}</span
              >
            </button>
          {:else}{#if !busy && !error}<p class="empty">{l.noResults}</p>{/if}{/each}
        </div>
        <label class="field">{l.selected}<input placeholder={l.keys} bind:value={rawKeys} /></label>
        {#if chosen.length}<div class="chosen-list">
            {#each chosen as key}<button
                title={l.cancel}
                on:click={() => (chosen = chosen.filter((item) => item !== key))}
                >{key} <X size={13} /></button
              >{/each}
          </div>{/if}
      </div>
    {:else if mode === 'settings'}
      <div class="academic-content settings">
        <label class="field"
          >{l.numbering}<select bind:value={localSettings.equationNumbering}
            ><option value="auto">{l.auto}</option><option value="section">{l.section}</option
            ><option value="manual">{l.manual}</option></select
          ></label
        >
        <label class="field"
          >{l.style}<select bind:value={localSettings.citationStyle}
            ><option value="numeric">{l.numeric}</option><option value="author-year"
              >{l.authorYear}</option
            ></select
          ></label
        >
      </div>
    {:else}
      <div class="academic-content settings">
        <label class="field"
          >{l.eqLabel}<input
            bind:value={equationLabel}
            list="academic-equations"
            placeholder="eq:energy"
          /></label
        >
        <datalist id="academic-equations"
          >{#each equationLabels as label}<option value={label}></option>{/each}</datalist
        >
        {#if error}<p class="message" role="alert">{error}</p>{/if}
      </div>
    {/if}
    <footer>
      <button on:click={onClose}>{l.cancel}</button><button class="primary" on:click={submit}
        >{mode === 'settings' ? l.apply : l.insert}</button
      >
    </footer>
  </div>
</div>
