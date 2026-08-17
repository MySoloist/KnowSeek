// Sidebar 记录列表渲染与管理
import { STORAGE_KEYS } from './state';

// ===== 类型 =====
export interface RecordItem {
  id: string;
  text: string;
  description?: string;
  url: string;
  page_title?: string;
  page_icon?: string;
  created_at: number;
  updated_at?: number;
  color?: { bg: string; text: string } | string;
  type?: string;
  videoTimestamp?: number;
  tags?: string[];
  [key: string]: any;
}

export interface TagItem {
  id: string;
  name: string;
  count?: number;
  color?: string;
  [key: string]: any;
}

export interface MarkTagItem {
  id: string;
  mark_id: string;
  tag_id: string;
  [key: string]: any;
}

export interface TreeNode {
  type: 'domain' | 'path' | 'page';
  name: string;
  url?: string;
  icon?: string;
  children: any;
}

export interface SidebarApis {
  renderMarkdown: (text: string, container?: HTMLElement) => Promise<string | void>;
  gotoRecord: (recordId: string) => void;
  loadSnapshotFromOPFS: (record: RecordItem) => Promise<string | null>;
  deleteSnapshotFromOPFS: (recordId: string) => Promise<void>;
  loadAllLegacySnapshots: () => Promise<{ name: string; dataUrl: string }[]>;
  showLegacyGallery: (images: { name: string; dataUrl: string }[]) => void;
  setupLinkAutocomplete: (textarea: HTMLTextAreaElement, currentRecord: RecordItem) => void;
  getActiveProvider: () => any;
  getActiveModel: () => any;
  syncActiveToBackend: () => Promise<void>;
  isVisionModel: (modelName: string) => boolean;
  handlePasteImage: (e: ClipboardEvent, recordId: string) => Promise<void>;
  clearNotificationsForUrl: (url: string) => Promise<void>;
}

// ===== 状态 =====
let records: RecordItem[] = [];
let tags: TagItem[] = [];
let markTags: MarkTagItem[] = [];
let currentFilter = 'all';
let searchQuery = '';
let selectedTagId: string | null = null;
let expandedNodes = new Set<string>();
let savedRecordOrder: string[] = [];
let recordsContainer: HTMLElement | null = null;

function getSidebar(): SidebarApis | undefined {
  return (window as any).__knowSeekSidebar;
}

// ===== 工具函数 =====

/** 判断 URL 是否为已知视频平台页面 */
function isVideoPageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // 已知视频平台
    const videoHosts = [
      'youtube.com', 'youtu.be',
      'bilibili.com',
    ];
    if (videoHosts.some(h => u.hostname.includes(h))) return true;
    // 常见视频路径模式
    const videoPathPatterns = ['/video/', '/watch', '/shorts/', '/live/'];
    if (videoPathPatterns.some(p => u.pathname.startsWith(p))) return true;
    return false;
  } catch {
    return false;
  }
}

function getDomainFromNode(node: TreeNode): string | null {
  // 尝试从节点名中提取域名
  if (node.type === 'domain') {
    const name = node.name.toLowerCase().trim();
    // 如果名字已经是域名格式，直接返回
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(name)) {
      return name;
    }
  }
  // 从子页面的 URL 中提取域名
  const walk = (items: any[]): string | null => {
    for (const item of items) {
      if (item.url) {
        try { return new URL(item.url).hostname; } catch {}
      }
      if (item.children) {
        const result = walk(item.children);
        if (result) return result;
      }
    }
    return null;
  };
  const records = node.type === 'domain' ? (node as any).children || [] : [];
  return walk(records);
}

function escapeHtml(text: string): string {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (date.toDateString() === now.toDateString()) return '今天';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function generateId(): string {
  return '01' + Date.now().toString(36) + Math.random().toString(36).substring(2, 10).toUpperCase();
}

async function loadData(): Promise<void> {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.RECORDS,
    STORAGE_KEYS.TAGS,
    STORAGE_KEYS.MARK_TAGS,
    'record_order'
  ]);
  records = data[STORAGE_KEYS.RECORDS] || [];
  tags = data[STORAGE_KEYS.TAGS] || [];
  markTags = data[STORAGE_KEYS.MARK_TAGS] || [];
  savedRecordOrder = data['record_order'] || [];
}

function setupStorageListener(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    let needsReload = false;
    if (changes[STORAGE_KEYS.RECORDS]) {
      records = changes[STORAGE_KEYS.RECORDS].newValue || [];
      needsReload = true;
    }
    if (changes[STORAGE_KEYS.TAGS]) {
      tags = changes[STORAGE_KEYS.TAGS].newValue || [];
      needsReload = true;
    }
    if (changes[STORAGE_KEYS.MARK_TAGS]) {
      markTags = changes[STORAGE_KEYS.MARK_TAGS].newValue || [];
      needsReload = true;
    }
    if (changes['record_order']) {
      savedRecordOrder = changes['record_order'].newValue || [];
      needsReload = true;
    }
    if (needsReload) renderRecords();
  });
}

async function updateTagCounts(): Promise<void> {
  tags.forEach(tag => {
    tag.count = markTags.filter(mt => mt.tag_id === tag.id).length;
  });
  await chrome.storage.local.set({ [STORAGE_KEYS.TAGS]: tags });
}

// ===== 渲染 =====
export function renderRecords(): void {
  if (!recordsContainer) return;

  let filteredRecords = [...records];

  if (currentFilter === 'current') {
    // 先清空容器，避免残留旧内容
    recordsContainer.innerHTML = '';
    const emptyState = document.getElementById('emptyState');
    if (emptyState) emptyState.classList.add('hidden');
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        filteredRecords = filteredRecords.filter(r => r.url === tabs[0].url);
        updateRecordsList(filteredRecords);
      } else {
        // 标签页查询失败 → 显示空状态
        if (emptyState) emptyState.classList.remove('hidden');
      }
    });
    return;
  }

  if (selectedTagId) {
    const markIds = markTags.filter(mt => mt.tag_id === selectedTagId).map(mt => mt.mark_id);
    filteredRecords = filteredRecords.filter(r => markIds.includes(r.id));
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filteredRecords = filteredRecords.filter(r =>
      (r.text && r.text.toLowerCase().includes(q)) ||
      (r.description && r.description.toLowerCase().includes(q)) ||
      (r.page_title && r.page_title.toLowerCase().includes(q)) ||
      (r.url && r.url.toLowerCase().includes(q))
    );
  }

  updateRecordsList(filteredRecords);
}

function updateRecordsList(filteredRecords: RecordItem[]): void {
  if (!recordsContainer) return;
  recordsContainer.innerHTML = '';

  const emptyState = document.getElementById('emptyState');
  if (filteredRecords.length === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');

  const tree = buildTree(filteredRecords);
  tree.forEach(domain => {
    const domainEl = renderTreeNode(domain, '');
    recordsContainer!.appendChild(domainEl);
  });
}

function buildTree(recordsList: RecordItem[]): TreeNode[] {
  const tree: Record<string, TreeNode> = {};
  recordsList.forEach(record => {
    try {
      const url = new URL(record.url);
      const domain = url.hostname;

      if (!tree[domain]) {
        tree[domain] = {
          type: 'domain',
          name: domain,
          icon: record.page_icon,
          children: {}
        };
      }

      const segments = url.pathname.split('/').filter(s => s.length > 0);
      const searchStr = url.search;

      let current: any = tree[domain].children;

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const isLast = (i === segments.length - 1);

        if (isLast) {
          const pageKey = segments.slice(0, i + 1).join('/') + searchStr;
          if (!current[pageKey]) {
            current[pageKey] = {
              type: 'page',
              name: record.page_title || segment,
              url: record.url,
              icon: record.page_icon,
              children: []
            };
          }
          current[pageKey].children.push(record);
        } else {
          if (!current[segment]) {
            current[segment] = {
              type: 'path',
              name: segment,
              icon: record.page_icon,
              children: {}
            };
          }
          current = current[segment].children;
        }
      }

      if (segments.length === 0) {
        const pageKey = '/' + searchStr;
        if (!current[pageKey]) {
          current[pageKey] = {
            type: 'page',
            name: record.page_title || '/',
            url: record.url,
            icon: record.page_icon,
            children: []
          };
        }
        current[pageKey].children.push(record);
      }
    } catch (e) {
      console.warn('[KnowSeek] Invalid URL:', record.url);
    }
  });

  const domainList = Object.values(tree).sort((a, b) => a.name.localeCompare(b.name));
  domainList.forEach(domain => sortNodeChildren(domain));

  return domainList;
}

function sortNodeChildren(node: TreeNode): void {
  if (node.type === 'page') {
    node.children.sort((a: RecordItem, b: RecordItem) => {
      const aIsVideo = a.videoTimestamp !== undefined;
      const bIsVideo = b.videoTimestamp !== undefined;
      if (aIsVideo && bIsVideo) {
        return (a.videoTimestamp || 0) - (b.videoTimestamp || 0);
      }
      if (aIsVideo) return -1;
      if (bIsVideo) return 1;
      if (savedRecordOrder.length > 0) {
        const ai = savedRecordOrder.indexOf(a.id);
        const bi = savedRecordOrder.indexOf(b.id);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      }
      return 0;
    });
    return;
  }

  if (node.children && typeof node.children === 'object') {
    const entries = Object.entries(node.children);
    entries.sort(([aKey], [bKey]) => aKey.localeCompare(bKey));
    node.children = Object.fromEntries(entries);
    Object.values(node.children).forEach((child: any) => sortNodeChildren(child));
  }
}

function renderTreeNode(node: TreeNode, parentPath: string): HTMLElement {
  const nodeEl = document.createElement('div');
  nodeEl.className = 'tree-node';
  nodeEl.dataset.nodeType = node.type;

  if (node.type === 'domain') {
    nodeEl.dataset.nodeId = node.name;
    nodeEl.draggable = true;
  } else if (node.type === 'path') {
    nodeEl.dataset.nodeId = parentPath + '/' + node.name;
    nodeEl.draggable = true;
  } else if (node.type === 'page') {
    nodeEl.dataset.nodeId = node.url || '';
    nodeEl.draggable = true;
  }

  const myPath = node.type === 'domain' ? node.name :
    node.type === 'path' ? parentPath + '/' + node.name :
    node.url || '';

  const expandId = node.type === 'domain' ? 'domain-' + node.name :
    node.type === 'path' ? 'path-' + myPath :
    'page-' + (node.url || '');
  nodeEl.dataset.expandId = expandId;

  const hasChildren = node.type === 'page' ? node.children.length > 0 :
    Object.keys(node.children || {}).length > 0;
  const isExpanded = expandedNodes.has(expandId);

  let faviconHtml = '';
  if (node.type === 'domain' || node.type === 'path') {
    const domain = getDomainFromNode(node);
    const directUrl = domain ? `https://${domain}/favicon.ico` : '';
    // 优先使用记录的图标，否则用域名直接获取
    const iconSrc = node.icon || directUrl;
    // 有图标源时隐藏 fallback，等加载失败再显示
    const hideFallback = iconSrc ? 'none' : 'flex';
    faviconHtml = `
      <span class="tree-favicon">
        <img src="${iconSrc}" alt="">
        <span class="tree-favicon-fallback" style="display: ${hideFallback};">${node.name.charAt(0).toUpperCase()}</span>
      </span>
    `;
  } else {
    const isVideo = isVideoPageUrl((node as any).url || '') ||
      (node.children as any[]).some((r: any) => r.videoTimestamp !== undefined);
    const emoji = isVideo ? '🎬' : '📄';
    faviconHtml = `
      <span class="tree-favicon tree-favicon-emoji">${emoji}</span>
    `;
  }

  let countHtml = '';
  if (node.type === 'page') {
    countHtml = `<span class="tree-node-count">${node.children.length}</span>`;
  } else {
    const totalCount = countChildren(node);
    if (totalCount > 0) {
      countHtml = `<span class="tree-node-count">${totalCount}</span>`;
    }
  }

  const headerClass = node.type === 'page' ? 'tree-node-header page-header' : 'tree-node-header';

  nodeEl.innerHTML = `
    <div class="${headerClass}">
      ${hasChildren ? `<span class="tree-expand-icon">${isExpanded ? '▼' : '▶'}</span>` : '<span class="tree-expand-icon" style="visibility:hidden">▶</span>'}
      ${faviconHtml}
      <span class="tree-node-name">${escapeHtml(node.name)}</span>
      ${countHtml}
      ${hasChildren && node.type !== 'page' ? `<button class="tree-expand-all-btn" title="展开全部子节点">${isExpanded ? '−' : '+'}</button>` : ''}
    </div>
    <div class="tree-node-children ${(hasChildren && isExpanded) ? '' : 'hidden'}">
    </div>
  `;

  const faviconImg = nodeEl.querySelector('.tree-favicon img') as HTMLImageElement | null;
  if (faviconImg) {
    faviconImg.addEventListener('error', function handleError() {
      this.style.visibility = 'hidden';
      const fallback = this.nextElementSibling as HTMLElement | null;
      if (fallback) fallback.style.display = 'flex';
    });
  }

  const header = nodeEl.querySelector('.tree-node-header') as HTMLElement;
  // 展开/折叠图标独立处理
  const expandIcon = nodeEl.querySelector('.tree-expand-icon') as HTMLElement;
  if (expandIcon && hasChildren) {
    expandIcon.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleExpand(expandId, nodeEl);
    });
  }

  // 展开全部按钮
  const expandAllBtn = nodeEl.querySelector('.tree-expand-all-btn') as HTMLElement | null;
  if (expandAllBtn) {
    expandAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      expandAllChildren(nodeEl);
    });
  }

  if (node.type === 'page') {
    // 点击 page 节点 → 展开/折叠（不跳转）
    header.addEventListener('click', function(e) {
      if ((e.target as HTMLElement).closest('.tree-expand-icon')) return;
      if ((e.target as HTMLElement).closest('.tree-expand-all-btn')) return;
      toggleExpand(expandId, nodeEl);
    });
  } else if (hasChildren) {
    header.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.tree-expand-icon')) return;
      if ((e.target as HTMLElement).closest('.tree-expand-all-btn')) return;
      toggleExpand(expandId, nodeEl);
    });
  }

  const childrenContainer = nodeEl.querySelector('.tree-node-children') as HTMLElement;
  if (node.type === 'page') {
    node.children.forEach((record: RecordItem) => {
      const recordEl = createRecordCard(record);
      childrenContainer.appendChild(recordEl);
    });
  } else {
    const childKeys = Object.keys(node.children || {});
    childKeys.forEach(key => {
      const childNode = node.children[key];
      const childEl = renderTreeNode(childNode, myPath);
      childrenContainer.appendChild(childEl);
    });
  }

  setupNodeDrag(nodeEl, node, myPath);

  return nodeEl;
}

function setupNodeDrag(nodeEl: HTMLElement, node: TreeNode, myPath: string): void {
  nodeEl.addEventListener('dragstart', (e) => {
    if ((e.target as HTMLElement).closest('.tree-expand-icon')) {
      e.preventDefault();
      return;
    }
    nodeEl.classList.add('dragging');
    e.dataTransfer!.setData('text/plain', JSON.stringify({
      type: node.type,
      id: node.type === 'domain' ? node.name : node.type === 'path' ? myPath : node.url
    }));
    e.dataTransfer!.effectAllowed = 'move';
  });

  nodeEl.addEventListener('dragend', () => {
    nodeEl.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  });

  nodeEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    const data = e.dataTransfer!.getData('text/plain');
    if (!data) return;
    try {
      const { type } = JSON.parse(data);
      if (type === node.type) {
        nodeEl.classList.add('drag-over');
      }
    } catch {}
  });

  nodeEl.addEventListener('dragleave', () => {
    nodeEl.classList.remove('drag-over');
  });

  nodeEl.addEventListener('drop', (e) => {
    e.preventDefault();
    nodeEl.classList.remove('drag-over');
    const data = e.dataTransfer!.getData('text/plain');
    if (!data) return;
    try {
      const { type, id } = JSON.parse(data);
      const nodeId = node.type === 'domain' ? node.name : node.type === 'path' ? myPath : node.url;
      if (type === node.type && id !== nodeId) {
        const container = nodeEl.parentNode as HTMLElement;
        const selector = node.type === 'domain' ? `[data-node-id="${id}"][data-node-type="domain"]` :
          node.type === 'path' ? `[data-node-id="${id}"][data-node-type="path"]` :
          `[data-node-id="${id}"][data-node-type="page"]`;
        const draggedNode = container.querySelector(selector) as HTMLElement | null;
        if (draggedNode && draggedNode !== nodeEl) {
          const rect = nodeEl.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          if (e.clientY < midY) {
            container.insertBefore(draggedNode, nodeEl);
          } else {
            container.insertBefore(draggedNode, nodeEl.nextSibling);
          }
          if (node.type === 'domain') saveNodeOrder();
          if (node.type === 'page') saveRecordOrder();
        }
      }
    } catch {}
  });
}

function countChildren(node: TreeNode): number {
  if (node.type === 'page') return node.children.length;
  let total = 0;
  Object.values(node.children || {}).forEach((child: any) => {
    total += countChildren(child);
  });
  return total;
}

function toggleExpand(nodeId: string, nodeEl: HTMLElement): void {
  if (expandedNodes.has(nodeId)) {
    expandedNodes.delete(nodeId);
  } else {
    expandedNodes.add(nodeId);
  }

  const children = nodeEl.querySelector('.tree-node-children') as HTMLElement;
  const icon = nodeEl.querySelector('.tree-expand-icon') as HTMLElement;
  const expandBtn = nodeEl.querySelector('.tree-expand-all-btn') as HTMLElement | null;

  if (expandedNodes.has(nodeId)) {
    children.classList.remove('hidden');
    icon.textContent = '▼';
    if (expandBtn) expandBtn.textContent = '−';
  } else {
    children.classList.add('hidden');
    icon.textContent = '▶';
    if (expandBtn) expandBtn.textContent = '+';
  }
}

/** 递归展开当前节点下的所有子节点 */
function expandAllChildren(nodeEl: HTMLElement): void {
  const expandIcon = nodeEl.querySelector('.tree-expand-icon') as HTMLElement;
  const childrenContainer = nodeEl.querySelector('.tree-node-children') as HTMLElement;
  if (!childrenContainer) return;

  // 展开当前节点
  childrenContainer.classList.remove('hidden');
  if (expandIcon) expandIcon.textContent = '▼';

  // 按钮文字改为 −
  const expandBtn = nodeEl.querySelector('.tree-expand-all-btn') as HTMLElement | null;
  if (expandBtn) expandBtn.textContent = '−';

  // 记录展开状态
  const expandId = nodeEl.dataset.expandId;
  if (expandId) expandedNodes.add(expandId);

  // 递归展开下一级子节点
  const childNodes = childrenContainer.querySelectorAll(':scope > [data-expand-id]');
  childNodes.forEach((child: Element) => {
    expandAllChildren(child as HTMLElement);
  });
}

function saveNodeOrder(): void {
  if (!recordsContainer) return;
  const order = Array.from(recordsContainer.querySelectorAll(':scope > [data-node-type="domain"]')).map(
    node => (node as HTMLElement).dataset.nodeId!
  );
  chrome.storage.local.set({ 'domain_order': order }).catch(() => {});
}

function saveRecordOrder(): void {
  const allCards = document.querySelectorAll('.record-card');
  const order = Array.from(allCards).map(card => (card as HTMLElement).dataset.recordId!);
  chrome.storage.local.set({ 'record_order': order }).catch(() => {});
}

function getTagsForRecord(recordId: string): TagItem[] {
  const tagIds = markTags.filter(mt => mt.mark_id === recordId).map(mt => mt.tag_id);
  return tags.filter(t => tagIds.includes(t.id));
}

function createRecordCard(record: RecordItem): HTMLElement {
  const card = document.createElement('div');
  card.className = 'record-card';
  card.dataset.recordId = record.id;
  card.style.cursor = 'grab';
  card.draggable = true;

  const recordTags = getTagsForRecord(record.id);
  const tagHtml = recordTags.length > 0 ? `
    <div class="record-tags">
      ${recordTags.map(t => `<span class="record-tag">${escapeHtml(t.name)}</span>`).join('')}
    </div>
  ` : '';

  const color = record.color || { bg: '#fef08a', text: '#000000' };
  const snapshotIcon = `
    <div class="record-snapshot-icon" title="查看截图">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
    </div>
  `;

  const isImageRecord = record.type === 'image';
  const isVideoRecord = record.videoTimestamp !== undefined;
  const videoTimestampStr = isVideoRecord ? formatTimestamp(record.videoTimestamp) : '';
  const highlightContent = isImageRecord
    ? `<img src="${escapeHtml(record.text)}" class="record-image-thumb" style="width:36px;height:36px;border-radius:4px;object-fit:cover;flex-shrink:0;display:block;" loading="lazy">`
    : escapeHtml(record.text);

  if (isVideoRecord) {
    setTimeout(() => loadVideoFrameThumbnail(card, record.id), 50);
  }

  const videoBadge = isVideoRecord ? `<span class="record-video-badge">⏱ ${videoTimestampStr}</span>` : '';

  card.innerHTML = `
    <div class="record-highlight" style="background-color: ${typeof color === 'object' ? color.bg : color}; color: ${typeof color === 'object' ? color.text : '#000000'}">
      ${highlightContent}
      ${videoBadge}
    </div>
    ${record.description ? `<div class="record-description">${escapeHtml(record.description)}</div>` : ''}
    ${tagHtml}
    <div class="record-meta">
      <div class="record-source">
        <span class="record-source-title">${formatDate(record.created_at)}</span>
      </div>
      <div class="record-actions">
        <div class="record-edit-btn" title="编辑笔记">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </div>
        <div class="record-ai-explain-btn" title="AI 解释">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3l2 4 4.5 1-3.2 3.5.8 5L12 14l-4.1 2.5.8-5L5.5 8 10 7z"/>
            <path d="M18 4l1.5 2.5L22 7.5l-2 2 .5 3L18 11l-2.5 1.5.5-3-2-2 2.5-1.5z"/>
            <path d="M6 4L4.5 6.5 2 7.5l2 2-.5 3L6 11l2.5 1.5L8 9.5l2-2-2.5-1.5z"/>
          </svg>
        </div>
        <div class="record-delete-btn" title="删除笔记">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            <line x1="10" y1="11" x2="10" y2="17"/>
            <line x1="14" y1="11" x2="14" y2="17"/>
          </svg>
        </div>
        ${snapshotIcon}
        <div class="record-locate-btn" title="在图谱中定位">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <circle cx="12" cy="12" r="3"/>
            <line x1="12" y1="2" x2="12" y2="6"/>
            <line x1="12" y1="18" x2="12" y2="22"/>
            <line x1="2" y1="12" x2="6" y2="12"/>
            <line x1="18" y1="12" x2="22" y2="12"/>
          </svg>
        </div>
      </div>
    </div>
    <div class="record-detail hidden">
      <div class="record-detail-section">
        <div class="record-detail-note-header">
          <label>笔记</label>
          <div class="record-detail-note-actions">
            <button class="record-detail-cancel-btn hidden">取消</button>
            <button class="record-detail-save-btn hidden">保存</button>
          </div>
        </div>
        <div class="record-detail-md"></div>
        <div class="record-editor-wrapper hidden">
          <div class="record-editor-toolbar">
            <button class="editor-toolbar-btn" data-md="bold" title="粗体 Ctrl+B"><strong>B</strong></button>
            <button class="editor-toolbar-btn" data-md="italic" title="斜体 Ctrl+I"><em>I</em></button>
            <button class="editor-toolbar-btn" data-md="strike" title="删除线">S̶</button>
            <button class="editor-toolbar-btn" data-md="code" title="行内代码 Ctrl+Shift+C"><code>&lt;/&gt;</code></button>
            <span class="editor-toolbar-sep"></span>
            <button class="editor-toolbar-btn" data-md="link" title="链接 Ctrl+K">🔗</button>
            <button class="editor-toolbar-btn" data-md="quote" title="引用">❝</button>
            <button class="editor-toolbar-btn" data-md="list" title="无序列表">•</button>
            <button class="editor-toolbar-btn" data-md="task" title="任务列表">☐</button>
            <button class="editor-toolbar-btn" data-md="heading" title="标题">H</button>
            <button class="editor-toolbar-btn" data-md="hr" title="分割线">—</button>
            <span class="editor-toolbar-sep"></span>
            <button class="editor-toolbar-btn editor-toolbar-preview" data-md="preview" title="预览">👁</button>
          </div>
          <div class="record-subtitle-hint hidden">⚠️ 当前视频无法提取字幕，AI 只能分析画面内容</div>
          <textarea class="record-detail-textarea" placeholder="添加笔记...">${escapeHtml(record.description || '')}</textarea>
          <div class="record-editor-statusbar">
            <span class="record-editor-char-count">0 字</span>
            <span class="record-editor-preview-label hidden">预览模式</span>
          </div>
        </div>
      </div>
      <div class="record-detail-section">
        <label>标签</label>
        <div class="record-detail-tags"></div>
      </div>
      <div class="record-detail-section">
        <label>来源页面</label>
        <a href="${escapeHtml(record.url)}" target="_blank" rel="noopener" class="record-detail-url">${escapeHtml(record.page_title || record.url)}</a>
      </div>
    </div>
  `;

  renderCardTagsForRecord(card, record.id);

  (async () => {
    const mdDiv = card.querySelector('.record-detail-md') as HTMLElement;
    const sidebar = getSidebar();
    if (record.description && sidebar) {
      await sidebar.renderMarkdown(record.description || '', mdDiv);
    }
  })();

  // 记录卡片拖拽
  let wasDragged = false;
  card.addEventListener('dragstart', (e) => {
    wasDragged = true;
    card.classList.add('dragging');
    e.dataTransfer!.setData('text/plain', JSON.stringify({ type: 'record', id: record.id }));
    e.dataTransfer!.effectAllowed = 'move';
    e.stopPropagation();
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    setTimeout(() => { wasDragged = false; }, 100);
  });

  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    const data = e.dataTransfer!.getData('text/plain');
    if (!data) return;
    try {
      const { type } = JSON.parse(data);
      if (type === 'record') {
        card.classList.add('drag-over');
      }
    } catch {}
  });

  card.addEventListener('dragleave', () => {
    card.classList.remove('drag-over');
  });

  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    const data = e.dataTransfer!.getData('text/plain');
    if (!data) return;
    try {
      const { type, id } = JSON.parse(data);
      if (type === 'record' && id !== record.id) {
        let container = card.closest('.tree-node-children') as HTMLElement | null;
        if (!container && recordsContainer) container = recordsContainer;
        const draggedNode = container?.querySelector(`[data-record-id="${id}"]`) as HTMLElement | null;
        if (draggedNode && draggedNode !== card && container) {
          const rect = card.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          if (e.clientY < midY) {
            container.insertBefore(draggedNode, card);
          } else {
            container.insertBefore(draggedNode, card.nextSibling);
          }
          saveRecordOrder();
        }
      }
    } catch {}
  });

  const snapshotBtn = card.querySelector('.record-snapshot-icon') as HTMLElement;
  snapshotBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    const sidebar = getSidebar();
    if (!sidebar) return;

    try {
      const imageUrl = await sidebar.loadSnapshotFromOPFS(record);
      if (imageUrl) {
        showSnapshotModal(imageUrl);
        return;
      }
      const legacyImages = await sidebar.loadAllLegacySnapshots();
      if (legacyImages.length > 0) {
        if (confirm(`该标注没有截图，是否查看${legacyImages.length}张已迁移的旧截图？`)) {
          sidebar.showLegacyGallery(legacyImages);
        }
      } else {
        alert('该标注没有截图');
      }
    } catch (err) {
      console.warn('[KnowSeek] 打开截图失败:', err);
      alert('打开截图失败');
    }
  });

  const editBtn = card.querySelector('.record-edit-btn') as HTMLElement;
  const detail = card.querySelector('.record-detail') as HTMLElement;
  const mdDiv = card.querySelector('.record-detail-md') as HTMLElement;
  const editorWrapper = card.querySelector('.record-editor-wrapper') as HTMLElement;
  const textarea = card.querySelector('.record-detail-textarea') as HTMLTextAreaElement;
  const saveBtn = card.querySelector('.record-detail-save-btn') as HTMLElement;
  const cancelBtn = card.querySelector('.record-detail-cancel-btn') as HTMLElement;

  if (textarea) {
    setTimeout(() => autoGrowTextarea(textarea), 10);
  }

  function toggleDetail() {
    detail.classList.toggle('hidden');
  }

  // 格式化工具栏
  const toolbarBtns = card.querySelectorAll('.editor-toolbar-btn');
  toolbarBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const type = (btn as HTMLElement).dataset.md!;
      const ta = textarea;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const selectedText = ta.value.substring(start, end);
      const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = ta.value.indexOf('\n', end);
      const line = ta.value.substring(lineStart, lineEnd === -1 ? ta.value.length : lineEnd);

      let insert = '';
      let cursorOffset = 0;

      switch (type) {
        case 'bold':
          insert = `**${selectedText || '粗体文字'}**`;
          cursorOffset = selectedText ? 2 : -4;
          break;
        case 'italic':
          insert = `*${selectedText || '斜体文字'}*`;
          cursorOffset = selectedText ? 1 : -2;
          break;
        case 'strike':
          insert = `~~${selectedText || '删除线'}~~`;
          cursorOffset = selectedText ? 2 : -4;
          break;
        case 'code':
          insert = `\`${selectedText || '代码'}\``;
          cursorOffset = selectedText ? 1 : -2;
          break;
        case 'link':
          insert = selectedText ? `[${selectedText}](url)` : `[链接文字](url)`;
          cursorOffset = selectedText ? -3 : 0;
          break;
        case 'quote':
          insert = selectedText
            ? selectedText.split('\n').map(s => `> ${s}`).join('\n')
            : `> `;
          cursorOffset = selectedText ? -(selectedText.length) : 0;
          break;
        case 'list':
          insert = selectedText
            ? selectedText.split('\n').map(s => `- ${s}`).join('\n')
            : `- `;
          cursorOffset = selectedText ? -(selectedText.length) : 0;
          break;
        case 'task':
          insert = selectedText
            ? selectedText.split('\n').map(s => `- [ ] ${s}`).join('\n')
            : `- [ ] `;
          cursorOffset = selectedText ? -(selectedText.length) : 0;
          break;
        case 'heading':
          const level = line.match(/^#+/);
          insert = level ? line.replace(/^#+/, '#' + '#') : `# ${line}`;
          break;
        case 'hr':
          insert = `\n---\n`;
          cursorOffset = 0;
          break;
        case 'preview':
          e.stopPropagation();
          e.preventDefault();
          togglePreview(ta);
          return;
      }

      if (type === 'heading') {
        const before = ta.value.substring(0, lineStart);
        const after = ta.value.substring(lineEnd === -1 ? ta.value.length : lineEnd);
        ta.value = before + insert + after;
        const newPos = lineStart + insert.length;
        ta.setSelectionRange(newPos, newPos);
      } else {
        const before = ta.value.substring(0, start);
        const after = ta.value.substring(end);
        ta.value = before + insert + after;
        const newPos = start + insert.length + cursorOffset;
        ta.setSelectionRange(newPos, newPos);
      }

      ta.focus();
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      autoGrowTextarea(ta);
    });
  });

  const charCountEl = card.querySelector('.record-editor-char-count') as HTMLElement;
  const previewLabelEl = card.querySelector('.record-editor-preview-label') as HTMLElement;

  function autoGrowTextarea(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  function updateCharCount() {
    let text = textarea.value;
    text = text.replace(/%%IMAGE_PLACEHOLDER_\d+%%/g, '').replace(/!\[.*?\]\(.*?\)/g, '');
    const len = [...text].length;
    const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    if (charCountEl) charCountEl.textContent = `${len} 字 · ${wordCount} 词`;
  }

  textarea.addEventListener('input', () => {
    autoGrowTextarea(textarea);
    updateCharCount();
  });

  let previewVisible = false;
  async function togglePreview(ta: HTMLTextAreaElement) {
    const sidebar = getSidebar();
    if (!sidebar) return;

    if (!previewVisible) {
      previewVisible = true;
      const md = ta.value;
      const previewDiv = document.createElement('div');
      previewDiv.className = 'record-editor-preview';
      previewDiv.style.cssText = 'padding:12px 14px;font-size:13px;line-height:1.65;min-height:80px;word-break:break-word;';
      await sidebar.renderMarkdown(md || '', previewDiv);
      ta.style.display = 'none';
      ta.parentNode!.insertBefore(previewDiv, ta.nextSibling);
      if (charCountEl) charCountEl.style.display = 'none';
      if (previewLabelEl) previewLabelEl.classList.remove('hidden');
      const previewBtn = card.querySelector('.editor-toolbar-preview') as HTMLElement;
      if (previewBtn) previewBtn.style.background = '#e5e7eb';
    } else {
      previewVisible = false;
      const previewDiv = ta.parentNode!.querySelector('.record-editor-preview');
      if (previewDiv) previewDiv.remove();
      ta.style.display = '';
      if (charCountEl) charCountEl.style.display = '';
      if (previewLabelEl) previewLabelEl.classList.add('hidden');
      const previewBtn = card.querySelector('.editor-toolbar-preview') as HTMLElement;
      if (previewBtn) previewBtn.style.background = '';
      ta.focus();
    }
  }

  textarea.addEventListener('keydown', (e) => {
    const isCtrl = e.ctrlKey || e.metaKey;
    if (!isCtrl) return;
    const key = e.key.toLowerCase();

    let mdType: string | null = null;
    if (key === 'b') mdType = 'bold';
    else if (key === 'i') mdType = 'italic';
    else if (key === 'k') mdType = 'link';
    else if (key === 'c' && e.shiftKey) mdType = 'code';

    if (mdType) {
      e.preventDefault();
      const btn = card.querySelector(`.editor-toolbar-btn[data-md="${mdType}"]`) as HTMLElement;
      if (btn) btn.click();
    }
  });

  function enterEditMode() {
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    if (detail.classList.contains('hidden')) {
      detail.classList.remove('hidden');
    }
    if (previewVisible) togglePreview(textarea);
    mdDiv.classList.add('hidden');
    editorWrapper.classList.remove('hidden');
    saveBtn.classList.remove('hidden');
    cancelBtn.classList.remove('hidden');
    textarea.focus();
    autoGrowTextarea(textarea);
    updateCharCount();

    const sidebar = getSidebar();
    if (sidebar) {
      textarea.addEventListener('paste', function pasteHandler(e) {
        sidebar.handlePasteImage(e, record.id);
      });
      sidebar.setupLinkAutocomplete(textarea, record);
    }
  }

  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    enterEditMode();
  });

  const deleteBtn = card.querySelector('.record-delete-btn') as HTMLElement;
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    if (confirm('确定要删除这条笔记吗？')) {
      deleteRecordById(record.id);
    }
  });

  const locateBtn = card.querySelector('.record-locate-btn') as HTMLElement;
  locateBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    // 切换到图谱面板，跳过位置重置，保持节点当前位置
    const graphEngine = (window as any).__knowSeekGraphEngine;
    if (graphEngine) graphEngine._skipPositionReset = true;
    const graphTab = document.querySelector('.filter-tab[data-filter="graph"]') as HTMLElement;
    if (graphTab) graphTab.click();
    requestAnimationFrame(() => {
      if (graphEngine) graphEngine.focusOnNode(record.id);
    });
  });

  // AI 解释按钮
  const aiExplainBtn = card.querySelector('.record-ai-explain-btn') as HTMLElement;
  aiExplainBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    const sidebar = getSidebar();
    if (!sidebar) return;

    const isImageRecord = record.type === 'image';
    if (!isImageRecord && !record.text) return;

    if (detail.classList.contains('hidden')) {
      detail.classList.remove('hidden');
    }

    const subtitleHint = card.querySelector('.record-subtitle-hint') as HTMLElement;

    let images: string[] = [];
    if (isImageRecord) {
      const activeProvider = sidebar.getActiveProvider();
      const activeModel = sidebar.getActiveModel();
      if (!activeModel || !sidebar.isVisionModel(activeModel.model)) {
        textarea.value = '⚠️ 当前模型不支持图片理解，请切换其它模型。';
        editorWrapper.classList.remove('hidden');
        mdDiv.classList.add('hidden');
        saveBtn.classList.remove('hidden');
        cancelBtn.classList.remove('hidden');
        return;
      }
      images = record.text && record.text.startsWith('data:') ? [record.text] : [];
    }

    textarea.value = '🤖 AI 正在处理，请稍候...';
    editorWrapper.classList.remove('hidden');
    mdDiv.classList.add('hidden');
    saveBtn.classList.remove('hidden');
    cancelBtn.classList.remove('hidden');

    await sidebar.syncActiveToBackend();

    const cfg = await chrome.storage.local.get(['backend_url', 'backend_key']);

    let pageCtx: any = null;
    try {
      const tabs = await new Promise<chrome.tabs.Tab[]>(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
      if (tabs && tabs[0] && tabs[0].id) {
        const resp = await new Promise<any>(r => chrome.tabs.sendMessage(tabs[0].id!, { action: 'getPageContext' }, (response) => {
          if (chrome.runtime.lastError) { r(null); return; }
          r(response);
        }));
        if (resp && resp.content) {
          pageCtx = { title: resp.title, url: resp.url, content: resp.content };
        }
      }
    } catch (e) { /* ignore */ }

    const isVideoAnnotation = record.videoTimestamp !== undefined;
    const hasSubtitles = pageCtx && pageCtx.content && pageCtx.content.includes('## 视频字幕');

    if (isVideoAnnotation && !hasSubtitles && subtitleHint) {
      subtitleHint.classList.remove('hidden');
    }

    const prompt = isVideoAnnotation
      ? (hasSubtitles
        ? `分析视频帧画面并结合视频字幕内容，解释当前时间点（${formatTimestamp(record.videoTimestamp!)}）的内容。说明画面中发生了什么、对应什么对话或旁白。不要任何开场白或概括性引导语：\n`
        : `分析视频帧画面，解释当前时间点（${formatTimestamp(record.videoTimestamp!)}）的画面内容。不要任何开场白或概括性引导语：\n`)
      : (isImageRecord
        ? '直接解释图片中的内容，不要任何开场白或概括性引导语。如果是代码或文字，请解释其含义：\n'
        : '直接解释以下文本，不要任何开场白或概括性引导语：\n' + record.text);

    try {
      if (!cfg.backend_url) throw new Error('未配置后端服务');

      const resp = await fetch(cfg.backend_url.replace(/\/+$/, '') + '/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.backend_key || ''}`
        },
        body: JSON.stringify({
          message: prompt,
          history: [],
          images: images,
          page_context: pageCtx ? { title: pageCtx.title, url: pageCtx.url, content: pageCtx.content } : null
        })
      });

      const data = await resp.json().catch(() => ({}));
      const reply = data && data.data && data.data.reply ? data.data.reply : '⚠️ AI 处理失败';

      let displayReply = reply;
      if (isVideoAnnotation && !hasSubtitles) {
        displayReply = '⚠️ 当前视频无法提取字幕，以下分析仅基于画面内容。\n\n---\n\n' + reply;
      }

      textarea.value = displayReply;
      autoGrowTextarea(textarea);
    } catch (err: any) {
      textarea.value = '⚠️ 调用 AI 失败：' + (err.message || '未知错误');
      autoGrowTextarea(textarea);
    }
  });

  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    saveRecordNote(record.id, textarea.value, mdDiv, editorWrapper, saveBtn, cancelBtn, textarea);
  });

  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    textarea.value = record.description || '';
    editorWrapper.classList.add('hidden');
    saveBtn.classList.add('hidden');
    cancelBtn.classList.add('hidden');
    if (record.description) {
      mdDiv.classList.remove('hidden');
    }
  });

  let clickTimer: ReturnType<typeof setTimeout> | null = null;
  card.addEventListener('click', function(e) {
    if (wasDragged) return;
    const target = e.target as HTMLElement;
    // 点击操作按钮或详情区域时不应触发卡片跳转/折叠
    if (target.closest('.record-actions') || target.closest('.record-detail')) return;
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      toggleDetail();
      return;
    }
    clickTimer = setTimeout(() => {
      clickTimer = null;
      const sidebar = getSidebar();
      if (sidebar) sidebar.gotoRecord(record.id);
    }, 250);
  });

  if (isImageRecord) {
    const thumb = card.querySelector('.record-image-thumb') as HTMLImageElement;
    if (thumb) {
      thumb.addEventListener('error', () => { thumb.style.display = 'none'; });
    }
  }

  return card;
}

function renderCardTagsForRecord(card: HTMLElement, recordId: string): void {
  const container = card.querySelector('.record-detail-tags') as HTMLElement;
  if (!container) return;
  const recordTagIds = markTags.filter(mt => mt.mark_id === recordId).map(mt => mt.tag_id);
  container.innerHTML = '';

  if (tags.length === 0) {
    container.innerHTML = '<span style="font-size: 12px; color: #9ca3af;">暂无标签</span>';
    return;
  }

  tags.forEach(tag => {
    const option = document.createElement('div');
    option.className = 'tag-option';
    if (recordTagIds.includes(tag.id)) {
      option.classList.add('selected');
    }
    option.textContent = tag.name;
    option.addEventListener('click', async () => {
      const existing = markTags.find(mt => mt.mark_id === recordId && mt.tag_id === tag.id);
      if (existing) {
        markTags = markTags.filter(mt => !(mt.mark_id === recordId && mt.tag_id === tag.id));
      } else {
        markTags.push({
          id: generateId(),
          mark_id: recordId,
          tag_id: tag.id,
          created_at: Date.now()
        });
      }
      await chrome.storage.local.set({ [STORAGE_KEYS.MARK_TAGS]: markTags });
      await updateTagCounts();
      renderCardTagsForRecord(card, recordId);
      renderRecords();
    });
    container.appendChild(option);
  });
}

async function saveRecordNote(
  recordId: string,
  description: string,
  mdDiv: HTMLElement,
  editorWrapper: HTMLElement,
  saveBtn: HTMLElement,
  cancelBtn: HTMLElement,
  textarea: HTMLTextAreaElement
): Promise<void> {
  const record = records.find(r => r.id === recordId);
  if (!record) return;

  record.description = description;
  record.updated_at = Date.now();

  await chrome.storage.local.set({ [STORAGE_KEYS.RECORDS]: records });

  const sidebar = getSidebar();
  if (sidebar) {
    await sidebar.renderMarkdown(record.description || '', mdDiv);
  }
  mdDiv.classList.remove('hidden');
  editorWrapper.classList.add('hidden');
  saveBtn.classList.add('hidden');
  if (cancelBtn) cancelBtn.classList.add('hidden');

  const descEl = textarea && textarea.closest('.record-card')?.querySelector('.record-description') as HTMLElement | null;
  if (descEl) {
    if (record.description) {
      descEl.textContent = record.description;
      descEl.classList.remove('hidden');
    } else {
      descEl.classList.add('hidden');
    }
  }

  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      if (tab.id) chrome.tabs.sendMessage(tab.id, { action: 'updateRecord', record }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
    });
  });
}

async function deleteRecordById(recordId: string): Promise<void> {
  const record = records.find(r => r.id === recordId);
  if (!record) return;

  records = records.filter(r => r.id !== recordId);
  markTags = markTags.filter(mt => mt.mark_id !== recordId);

  await chrome.storage.local.set({
    [STORAGE_KEYS.RECORDS]: records,
    [STORAGE_KEYS.MARK_TAGS]: markTags
  });

  // 若该 URL 下已无任何标注，同步清理对应的内容变更通知和向量数据
  const hasOtherRecordsForUrl = records.some(r => r.url === record.url);
  if (!hasOtherRecordsForUrl) {
    const sidebar = getSidebar();
    if (sidebar) {
      await sidebar.clearNotificationsForUrl(record.url).catch(() => {});
    }
    // 同步删除后端 embedding 向量数据
    chrome.runtime.sendMessage({
      action: 'backendRequest',
      endpoint: '/api/embedding/delete',
      method: 'DELETE',
      body: { url: record.url }
    }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
  }

  await updateTagCounts();
  renderRecords();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      await new Promise<void>(r => chrome.tabs.sendMessage(tab.id, { action: 'deleteHighlight', recordId }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } r(); }));
      await new Promise<void>(r => chrome.tabs.sendMessage(tab.id, { action: 'updateRecordOrder', savedOrder: savedRecordOrder }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } r(); }));
    }
  } catch (e) {}

  const sidebar = getSidebar();
  if (sidebar) {
    await sidebar.deleteSnapshotFromOPFS(recordId).catch(() => {});
  }

  if (record.description) {
    const pasteRefs = [...record.description.matchAll(/!\[图片\]\(snapshot:(paste_[^\)]+)\)/g)];
    for (const [, snapshotId] of pasteRefs) {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('snapshots');
        await dir.removeEntry(snapshotId + '.png');
      } catch (e) {}
    }
  }
}

function showSnapshotModal(dataUrl: string): void {
  const modal = document.createElement('div');
  modal.className = 'snapshot-modal';
  modal.innerHTML = `
    <div class="snapshot-overlay"></div>
    <div class="snapshot-content">
      <button class="snapshot-close">&times;</button>
      <img src="${dataUrl}" alt="截图">
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('.snapshot-overlay')?.addEventListener('click', () => modal.remove());
  modal.querySelector('.snapshot-close')?.addEventListener('click', () => modal.remove());
}

async function loadVideoFrameThumbnail(card: HTMLElement, recordId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('snapshots');
    const fileHandle = await dir.getFileHandle(`snapshot_${recordId}.png`);
    const file = await fileHandle.getFile();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const img = card.querySelector('.record-image-thumb') as HTMLImageElement;
    if (img) img.src = dataUrl;
  } catch (e) {
    // 缩略图暂时不可用
  }
}

export function expandRecordTreePath(record: RecordItem): void {
  try {
    const url = new URL(record.url);
    const domain = url.hostname;
    const segments = url.pathname.split('/').filter(segment => segment.length > 0);
    const searchStr = url.search;

    expandedNodes.add('domain-' + domain);

    let currentPath = domain;
    for (let i = 0; i < segments.length - 1; i++) {
      currentPath += '/' + segments[i];
      expandedNodes.add('path-' + currentPath);
    }

    expandedNodes.add('page-' + record.url);

    if (segments.length === 0) {
      expandedNodes.add('page-' + url.origin + '/' + searchStr);
    }
  } catch (e) {
    console.warn('[KnowSeek] Invalid URL:', record.url);
  }
}

// ===== 公共 API =====
export function setFilter(filter: string): void {
  currentFilter = filter;
}

export function setSearchQuery(query: string): void {
  searchQuery = query.toLowerCase();
}

export function setSelectedTag(tagId: string | null): void {
  selectedTagId = tagId;
  renderRecords();
}

export function initRecords(container: HTMLElement): void {
  recordsContainer = container;

  // 从 DOM 读取默认激活的筛选器，与 HTML 保持同步
  const activeTab = document.querySelector<HTMLElement>('.filter-tab.active');
  if (activeTab && activeTab.dataset.filter) {
    currentFilter = activeTab.dataset.filter;
  }

  loadData().then(() => {
    renderRecords();
  });
  setupStorageListener();

  (window as any).__knowSeekRecords = {
    renderRecords,
    setFilter,
    setSearchQuery,
    setSelectedTag,
    expandRecordTreePath
  };
}
