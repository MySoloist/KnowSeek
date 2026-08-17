// Sidebar 标签管理面板
import { STORAGE_KEYS } from './state';

interface TagItem {
  id: string;
  name: string;
  count?: number;
  color?: string;
  created_at?: number;
  updated_at?: number;
  [key: string]: any;
}

interface MarkTagItem {
  id: string;
  mark_id: string;
  tag_id: string;
  created_at?: number;
  [key: string]: any;
}

// ===== 状态 =====
let tags: TagItem[] = [];
let markTags: MarkTagItem[] = [];
let selectedTagId: string | null = null;
let editingTagId: string | null = null;

let tagsListEl: HTMLElement | null = null;
let tagModalEl: HTMLElement | null = null;
let tagModalTitleEl: HTMLElement | null = null;
let tagNameInputEl: HTMLInputElement | null = null;
let addTagBtnEl: HTMLElement | null = null;
let saveTagBtnEl: HTMLElement | null = null;
let cancelTagBtnEl: HTMLElement | null = null;

function getRecordsApi(): any {
  return (window as any).__knowSeekRecords;
}

// ===== 工具函数 =====
function escapeHtml(text: string): string {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function generateId(): string {
  return '01' + Date.now().toString(36) + Math.random().toString(36).substring(2, 10).toUpperCase();
}

async function loadData(): Promise<void> {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.TAGS,
    STORAGE_KEYS.MARK_TAGS
  ]);
  tags = data[STORAGE_KEYS.TAGS] || [];
  markTags = data[STORAGE_KEYS.MARK_TAGS] || [];
}

function setupStorageListener(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    let needsRender = false;
    if (changes[STORAGE_KEYS.TAGS]) {
      tags = changes[STORAGE_KEYS.TAGS].newValue || [];
      needsRender = true;
    }
    if (changes[STORAGE_KEYS.MARK_TAGS]) {
      markTags = changes[STORAGE_KEYS.MARK_TAGS].newValue || [];
      needsRender = true;
    }
    if (needsRender) {
      renderTags();
    }
  });
}

function bindElements(): boolean {
  tagsListEl = document.getElementById('tagsList');
  tagModalEl = document.getElementById('tagModal');
  tagModalTitleEl = document.getElementById('tagModalTitle');
  tagNameInputEl = document.getElementById('tagNameInput') as HTMLInputElement | null;
  addTagBtnEl = document.getElementById('addTagBtn');
  saveTagBtnEl = document.getElementById('saveTagBtn');
  cancelTagBtnEl = document.getElementById('cancelTagBtn');
  return !!tagsListEl;
}

function setupEventListeners(): void {
  addTagBtnEl?.addEventListener('click', () => {
    editingTagId = null;
    if (tagModalTitleEl) tagModalTitleEl.textContent = '新建标签';
    if (tagNameInputEl) tagNameInputEl.value = '';
    tagModalEl?.classList.remove('hidden');
    tagNameInputEl?.focus();
  });

  saveTagBtnEl?.addEventListener('click', saveTag);

  cancelTagBtnEl?.addEventListener('click', closeTagModal);

  document.querySelectorAll('[data-close-tag="true"]').forEach(el => {
    el.addEventListener('click', closeTagModal);
  });

  tagNameInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveTag();
    } else if (e.key === 'Escape') {
      closeTagModal();
    }
  });
}

function closeTagModal(): void {
  tagModalEl?.classList.add('hidden');
  editingTagId = null;
}

async function updateTagCounts(): Promise<void> {
  tags.forEach(tag => {
    tag.count = markTags.filter(mt => mt.tag_id === tag.id).length;
  });
  await chrome.storage.local.set({ [STORAGE_KEYS.TAGS]: tags });
}

// ===== 渲染 =====
export function renderTags(): void {
  const container = tagsListEl;
  if (!container) return;
  container.innerHTML = '';

  tags.forEach(tag => {
    const tagEl = document.createElement('div');
    tagEl.className = 'tag-item';
    if (tag.id === selectedTagId) {
      tagEl.classList.add('active');
    }
    tagEl.innerHTML = `
      <span class="tag-name">${escapeHtml(tag.name)}</span>
      <span class="tag-count">${tag.count || 0}</span>
      <span class="tag-delete" data-tag-id="${tag.id}">×</span>
    `;

    tagEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('tag-delete')) {
        e.stopPropagation();
        deleteTag(tag.id);
        return;
      }

      selectedTagId = selectedTagId === tag.id ? null : tag.id;
      renderTags();

      const recordsApi = getRecordsApi();
      if (recordsApi) {
        recordsApi.setSelectedTag(selectedTagId);
      }
    });

    tagEl.addEventListener('dblclick', () => {
      editTag(tag.id);
    });

    container.appendChild(tagEl);
  });
}

function editTag(tagId: string): void {
  const tag = tags.find(t => t.id === tagId);
  if (!tag) return;
  editingTagId = tagId;
  if (tagModalTitleEl) tagModalTitleEl.textContent = '编辑标签';
  if (tagNameInputEl) tagNameInputEl.value = tag.name;
  tagModalEl?.classList.remove('hidden');
  tagNameInputEl?.focus();
  tagNameInputEl?.select();
}

async function saveTag(): Promise<void> {
  if (!tagNameInputEl) return;
  const name = tagNameInputEl.value.trim();
  if (!name) {
    alert('请输入标签名称');
    return;
  }

  if (editingTagId) {
    const tag = tags.find(t => t.id === editingTagId);
    if (tag) {
      tag.name = name;
      tag.updated_at = Date.now();
    }
  } else {
    tags.push({
      id: generateId(),
      name,
      created_at: Date.now(),
      updated_at: Date.now(),
      count: 0
    });
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.TAGS]: tags });
  closeTagModal();
}

async function deleteTag(tagId: string): Promise<void> {
  const tag = tags.find(t => t.id === tagId);
  if (!tag) return;
  if (!confirm(`确定要删除标签"${tag.name}"吗？`)) return;

  tags = tags.filter(t => t.id !== tagId);
  markTags = markTags.filter(mt => mt.tag_id !== tagId);

  await chrome.storage.local.set({
    [STORAGE_KEYS.TAGS]: tags,
    [STORAGE_KEYS.MARK_TAGS]: markTags
  });

  if (selectedTagId === tagId) {
    selectedTagId = null;
    const recordsApi = getRecordsApi();
    if (recordsApi) {
      recordsApi.setSelectedTag(null);
    }
  }
}

// ===== 公共 API =====
export function setSelectedTag(tagId: string | null): void {
  selectedTagId = tagId;
  renderTags();
}

export function initTags(): void {
  if (!bindElements()) {
    console.warn('[知寻] 未找到标签列表面板');
    return;
  }

  loadData().then(() => {
    renderTags();
  });
  setupStorageListener();
  setupEventListeners();

  (window as any).__knowSeekTags = {
    render: renderTags,
    addTag: () => {
      editingTagId = null;
      if (tagModalTitleEl) tagModalTitleEl.textContent = '新建标签';
      if (tagNameInputEl) tagNameInputEl.value = '';
      tagModalEl?.classList.remove('hidden');
      tagNameInputEl?.focus();
    },
    editTag,
    saveTag,
    cancelTag: closeTagModal,
    deleteTag,
    updateTagCounts,
    setSelectedTag
  };
}
