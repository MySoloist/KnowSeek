// Sidebar 入口 — 逐步替换旧 sidebar.js 的逻辑
import { loadData, setupStorageListener, records, tags, markTags, searchQuery, selectedTagId, currentFilter, expandedNodes, savedRecordOrder, STORAGE_KEYS } from './state';
import { loadTheme } from './theme';
import { initRecords } from './records';
import { initTags } from './tags';
import { init as initChat } from './chat';
import { initSettings } from './settings';
import { initGraphUI } from './graph';
import { marked } from 'marked';
import 'katex/dist/katex.min.css';
import 'katex'; // 确保 KaTeX JS 被打包
import markedKatex from 'marked-katex-extension';
import './graph'; // 确保 graph 模块不被 tree-shake 删除

// 配置 marked 使用 KaTeX 扩展（放在入口文件以避免 tree-shake）
marked.use(markedKatex({ nonStandard: true }));
import { saveSnapshot, getSnapshot, deleteSnapshot, addRecordId, getAllSnapshots, getStorageEstimate, clearAllSnapshots } from '../../utils/indexedb';
import { stripExtraContent, stripMarkdown, normalizePara, splitParagraphs } from '../../utils/content-diff';
import { diffLines } from 'diff';

// 搜索防抖
let searchDebounceTimer: number | null = null;

// ===== 内容变更通知系统 =====
interface ContentChangeNotification {
  url: string;
  title: string;
  type: 'article' | 'video';
  added: number;
  modified: number;
  removed: number;
  detectedAt: number;
  oldContent: string;
  newContent: string;
  read: boolean;
}
let contentNotifications: ContentChangeNotification[] = [];

interface CheckConfig {
  mode: 'interval' | 'daily';
  intervalMinutes: number;
  dailyTime: string; // HH:MM
}
const DEFAULT_CHECK_CONFIG: CheckConfig = {
  mode: 'interval',
  intervalMinutes: 0,
  dailyTime: '09:00'
};
let checkConfig: CheckConfig = { ...DEFAULT_CHECK_CONFIG };

const NOTIF_STORAGE_KEY = '_contentChangeNotifications';
const CHECK_CONFIG_KEY = 'checkConfig';

/** 从 chrome.storage 加载通知列表到缓存 */
async function loadNotificationsFromStorage(): Promise<void> {
  try {
    const data = await chrome.storage.local.get(NOTIF_STORAGE_KEY);
    contentNotifications = (data[NOTIF_STORAGE_KEY] || []).map((n: any) => ({ ...n, read: n.read ?? false }));
  } catch {
    contentNotifications = [];
  }
  updateNotificationBadge();
}

/** 保存通知列表到 chrome.storage */
async function saveNotificationsToStorage(): Promise<void> {
  try {
    await chrome.storage.local.set({ [NOTIF_STORAGE_KEY]: contentNotifications });
  } catch {}
  updateNotificationBadge();
}

function updateNotificationBadge(): void {
  const bellBtn = document.getElementById('notificationBellBtn') as HTMLElement | null;
  if (!bellBtn) return;
  const badge = bellBtn.querySelector('.notification-badge') as HTMLElement | null;
  if (!badge) return;
  if (contentNotifications.length > 0) {
    badge.textContent = String(contentNotifications.length);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

/** 删除某 URL 对应的内容变更通知 */
async function clearNotificationsForUrl(url: string): Promise<void> {
  if (!url) return;
  const before = contentNotifications.length;
  contentNotifications = contentNotifications.filter(n => n.url !== url);
  if (contentNotifications.length === before) return;
  updateNotificationBadge();
  await saveNotificationsToStorage();
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

async function showStorageModal(): Promise<void> {
  const modal = document.getElementById('storageModal') as HTMLElement | null;
  if (!modal) return;
  modal.classList.remove('hidden');

  // 查询各项存储用量
  try {
    // 1. chrome.storage.local
    const chromeBytes = await chrome.storage.local.getBytesInUse(null);

    // 2. 总存储（IndexedDB + OPFS + 其他）
    const estimate = await getStorageEstimate();

    // 3. 快照数量（IndexedDB）
    const snapshots = await getAllSnapshots();

    // 4. OPFS 实际文件大小（直接读取所有文件）
    let screenshotCount = 0;
    let opfsSize = 0;
    try {
      const root = await navigator.storage.getDirectory();
      // 递归遍历 OPFS 目录树
      async function walkOPFS(dir: FileSystemDirectoryHandle): Promise<void> {
        for await (const [name, entry] of (dir as any).entries()) {
          if (entry.kind === 'file') {
            const file = await (entry as FileSystemFileHandle).getFile();
            opfsSize += file.size;
            // snapshots/ 目录下的文件计为截图
            screenshotCount++;
          } else if (entry.kind === 'directory') {
            await walkOPFS(entry as FileSystemDirectoryHandle);
          }
        }
      }
      await walkOPFS(root);
    } catch {
      // OPFS 不可访问或无文件
    }

    // 5. 标注记录数量
    const recordCount = (await chrome.storage.local.get('records')).records?.length || 0;

    // 各存储用量（全部直接读取，不估算）
    // chrome.storage: 精确值（getBytesInUse）
    // OPFS: 直接遍历文件累加
    // IndexedDB: navigator.storage.estimate() - OPFS（均为浏览器报告的真实值）
    // 注意：estimate.usage 包含 IndexedDB + OPFS + Cache API，减去 OPFS 后即为 IndexedDB (含 cache)
    const idbActualSize = Math.max(0, estimate.usage - opfsSize);
    const totalUsage = chromeBytes + estimate.usage;

    // 更新 UI
    const totalQuota = estimate.quota || 0;
    const totalUsagePercent = totalQuota > 0 ? Math.min(100, (totalUsage / totalQuota) * 100) : 0;

    const fillEl = document.getElementById('storageTotalFill');
    const textEl = document.getElementById('storageTotalText');
    const chromeEl = document.getElementById('storageChromeStorage');
    const idbEl = document.getElementById('storageIndexedDB');
    const opfsEl = document.getElementById('storageOPFS');
    const snapCountEl = document.getElementById('storageSnapshotCount');
    const ssCountEl = document.getElementById('storageScreenshotCount');
    const recCountEl = document.getElementById('storageRecordCount');

    if (fillEl) fillEl.style.width = totalUsagePercent + '%';
    if (textEl) {
      const quotaStr = totalQuota > 0 ? `/ ${formatSize(totalQuota)}` : '';
      textEl.textContent = `合计 ${formatSize(totalUsage)} ${quotaStr} (${totalUsagePercent.toFixed(1)}%)`;
    }
    if (chromeEl) chromeEl.textContent = formatSize(chromeBytes);
    if (idbEl) idbEl.textContent = formatSize(idbActualSize);
    if (opfsEl) opfsEl.textContent = formatSize(opfsSize);
    if (snapCountEl) snapCountEl.textContent = String(snapshots.length);
    if (ssCountEl) ssCountEl.textContent = String(screenshotCount);
    if (recCountEl) recCountEl.textContent = String(recordCount);
  } catch (err) {
    console.error('[Storage] 查询存储用量失败:', err);
  }
}

function getFaviconUrl(url: string): string {
  try {
    const domain = new URL(url).hostname;
    return `https://${domain}/favicon.ico`;
  } catch {
    return '';
  }
}

function showEmbeddingToast(message: string): void {
  const existing = document.querySelector('.backup-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'backup-toast backup-toast-success';
  toast.innerHTML = `<span class="backup-toast-icon">✓</span><span>${escapeHtml(message)}</span>`;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('backup-toast-hide');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ===== 自动保存快照 + 变更检测 =====

async function autoSaveSnapshotForCurrentTab(url: string, title: string): Promise<void> {
  try {
    // 只对有标注的页面保存快照，避免未标注页面（如B站首页）产生变更通知
    if (!records.some(r => r.url === url)) {
      // 清理可能残留的旧快照（修复前已创建的无标注页面快照）
      const stale = await getSnapshot(url);
      if (stale) {
        await chrome.storage.local.get(NOTIF_STORAGE_KEY).then(async (data) => {
          const notifs = (data[NOTIF_STORAGE_KEY] || []) as ContentChangeNotification[];
          const filtered = notifs.filter(n => n.url !== url);
          if (filtered.length !== notifs.length) {
            await chrome.storage.local.set({ [NOTIF_STORAGE_KEY]: filtered });
            updateNotificationBadge();
          }
        });
        await deleteSnapshot(url);
      }
      // 同步删除后端的 embedding
      chrome.runtime.sendMessage({
        action: 'backendRequest',
        endpoint: '/api/embedding/delete',
        method: 'DELETE',
        body: { url }
      }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
      return;
    }

    const tabs = await new Promise<chrome.tabs.Tab[]>(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
    if (!tabs?.[0]?.id) return;
    const resp = await new Promise<any>(r => {
      chrome.tabs.sendMessage(tabs[0].id!, { action: 'getPageContext' }, (response) => {
        if (chrome.runtime.lastError) { r(null); return; }
        r(response);
      });
    });
    if (!resp || !resp.content) return;

    const existing = await getSnapshot(url);
    const cleanContent = stripExtraContent(resp.content);

    if (!existing) {
      await saveSnapshot({
        url,
        title: resp.title || title,
        type: resp.isVideoPage ? 'video' : 'article',
        content: cleanContent,
        stats: {
          charCount: resp.content.length,
          paraCount: resp.content.split('\n\n').length,
        },
        metadata: resp.isVideoPage ? {
          videoId: '',
          duration: 0,
          description: resp.title || ''
        } : undefined,
        savedAt: Date.now(),
        updatedAt: Date.now(),
        recordIds: []
      });
    }

    // 同步保存/更新 embedding 到后端（fire-and-forget，不阻塞）
    // 无论快照是否已存在，都执行 upsert 确保 embedding 与后端同步
    chrome.runtime.sendMessage({
      action: 'backendRequest',
      endpoint: '/api/embedding/save',
      method: 'POST',
      body: { url, title: resp.title || title, content: cleanContent }
    }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
  } catch (e) {
    // 静默失败，不干扰用户
  }
}

async function checkForChanges(url: string): Promise<void> {
  try {
    const existing = await getSnapshot(url);
    if (!existing) return;

    const tabs = await new Promise<chrome.tabs.Tab[]>(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
    if (!tabs?.[0]?.id) return;
    const resp = await new Promise<any>(r => {
      chrome.tabs.sendMessage(tabs[0].id!, { action: 'getPageContext' }, (response) => {
        if (chrome.runtime.lastError) { r(null); return; }
        r(response);
      });
    });
    if (!resp || !resp.content) return;

    // 清理不稳定内容，统一口径对比
    const oldContent = stripExtraContent(existing.content);
    const newContent = stripExtraContent(resp.content);

    // 段落级对比，避免位置移动导致的误报
    const oldParas = splitParagraphs(oldContent);
    const newParas = splitParagraphs(newContent);

    // 用规范化后的文本做精确匹配
    const oldNorm = new Map<string, string>();
    oldParas.forEach(p => { const k = normalizePara(p); if (!oldNorm.has(k)) oldNorm.set(k, p); });
    const newNorm = new Map<string, string>();
    newParas.forEach(p => { const k = normalizePara(p); if (!newNorm.has(k)) newNorm.set(k, p); });

    const oldKeys = new Set(oldNorm.keys());
    const newKeys = new Set(newNorm.keys());

    // 真正新增的段落
    const trulyAdded: string[] = [];
    const trulyRemoved: string[] = [];
    const trulyModified: Array<{ old: string; new: string }> = [];

    newKeys.forEach(k => {
      if (!oldKeys.has(k)) {
        trulyAdded.push(newNorm.get(k)!);
      }
    });

    oldKeys.forEach(k => {
      if (!newKeys.has(k)) {
        trulyRemoved.push(oldNorm.get(k)!);
      }
    });

    // 对于内容相同的 key 但原文不同（规范化后一致但原文有别），算修改
    // 这里简单处理：同时出现在两边的 key 不计入变更
    // 真正修改检测使用 diffLines 在具体段落内部做

    let added = trulyAdded.length;
    let removed = trulyRemoved.length;
    let modified = 0;

    // 对于被标记为新增和删除的段落，如果它们很相似（diff 变化小），则算修改
    for (let i = trulyRemoved.length - 1; i >= 0; i--) {
      for (let j = trulyAdded.length - 1; j >= 0; j--) {
        const lineDiff = diffLines(stripMarkdown(trulyRemoved[i]), stripMarkdown(trulyAdded[j]));
        let lineChanges = 0;
        lineDiff.forEach(p => { if (p.added || p.removed) lineChanges += p.count || 0; });
        // 如果两个段落差异很小（≤5行变化），认为是修改而非新增+删除
        if (lineChanges > 0 && lineChanges <= 5) {
          modified++;
          trulyRemoved.splice(i, 1);
          trulyAdded.splice(j, 1);
          break;
        }
      }
    }
    added = trulyAdded.length;
    removed = trulyRemoved.length;

    const totalChanged = added + modified + removed;
    // 检查是否已有该 URL 的通知
    const existingIdx = contentNotifications.findIndex(n => n.url === url);

    if (totalChanged === 0) {
      // 内容没有变化：移除已有通知（避免误报）
      if (existingIdx >= 0) {
        contentNotifications.splice(existingIdx, 1);
        await saveNotificationsToStorage();
      }
      return;
    }

    const notification: ContentChangeNotification = {
      url,
      title: existing.title,
      type: existing.type,
      added,
      modified,
      removed,
      detectedAt: Date.now(),
      oldContent: oldContent,
      newContent: newContent,
      read: false
    };

    if (existingIdx >= 0) {
      contentNotifications[existingIdx] = notification;
    } else {
      contentNotifications.push(notification);
    }

    await saveNotificationsToStorage();
  } catch (e) {
    // 静默失败
  }
}

// 存储已加载的扩展节点（用于定位记录）
let _expandedNodes = expandedNodes;

// ===== 定时检测（通过 chrome.alarms 在后台运行） =====

/** 手动检查当前标签页 */
async function checkCurrentTabForChanges(): Promise<void> {
  try {
    const tabs = await new Promise<chrome.tabs.Tab[]>(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
    if (!tabs?.[0]?.url || !tabs[0].url.startsWith('http') || !tabs[0].title) return;
    const existing = await getSnapshot(tabs[0].url);
    if (!existing) {
      await autoSaveSnapshotForCurrentTab(tabs[0].url, tabs[0].title);
    } else {
      await checkForChanges(tabs[0].url);
    }
  } catch (_) {}
}

async function startCheckAlarm(): Promise<void> {
  await new Promise<void>(r => chrome.runtime.sendMessage({
    action: 'startContentCheck',
    mode: checkConfig.mode,
    intervalMinutes: checkConfig.intervalMinutes,
    dailyTime: checkConfig.dailyTime
  }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } r(); }));

  const enabled = checkConfig.mode === 'interval'
    ? checkConfig.intervalMinutes > 0
    : !!checkConfig.dailyTime;
  if (enabled) {
    // 立即手动检查一次当前标签页
    await checkCurrentTabForChanges();
  }
}

async function stopCheckAlarm(): Promise<void> {
  await new Promise<void>(r => chrome.runtime.sendMessage({ action: 'stopContentCheck' }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } r(); }));
}

async function saveCheckConfig(newConfig: Partial<CheckConfig>): Promise<void> {
  checkConfig = { ...checkConfig, ...newConfig };
  try {
    await chrome.storage.local.set({ [CHECK_CONFIG_KEY]: checkConfig });
  } catch (_) {}

  const enabled = checkConfig.mode === 'interval'
    ? checkConfig.intervalMinutes > 0
    : !!checkConfig.dailyTime;
  if (enabled) {
    await startCheckAlarm();
  } else {
    await stopCheckAlarm();
  }
}

async function loadCheckConfig(): Promise<void> {
  try {
    const data = await chrome.storage.local.get([CHECK_CONFIG_KEY, 'checkIntervalMinutes']);
    const saved = data[CHECK_CONFIG_KEY] as CheckConfig | undefined;
    if (saved && (saved.mode === 'interval' || saved.mode === 'daily')) {
      checkConfig = {
        mode: saved.mode,
        intervalMinutes: saved.intervalMinutes ?? 0,
        dailyTime: saved.dailyTime ?? '09:00'
      };
    } else if (typeof data.checkIntervalMinutes === 'number' && data.checkIntervalMinutes > 0) {
      // 向后兼容旧配置
      checkConfig = {
        mode: 'interval',
        intervalMinutes: data.checkIntervalMinutes,
        dailyTime: '09:00'
      };
      await chrome.storage.local.set({ [CHECK_CONFIG_KEY]: checkConfig });
    }

    const enabled = checkConfig.mode === 'interval'
      ? checkConfig.intervalMinutes > 0
      : !!checkConfig.dailyTime;
    if (enabled) {
      await startCheckAlarm();
    }
  } catch (_) {}
}

// ── 面板切换 ──
function showPanelWithAnim(panel: HTMLElement): void {
  panel.classList.remove('hidden');
  panel.classList.remove('panel-fade-in');
  // 强制回流，确保动画重新触发
  void panel.offsetWidth;
  panel.classList.add('panel-fade-in');
}

function switchToFilter(filter: string): void {
  const graphPanel = document.getElementById('graphPanel') as HTMLElement;
  const chatPanel = document.getElementById('chatPanel') as HTMLElement;
  const recordsList = document.getElementById('recordsList') as HTMLElement;
  const tagsPanel = document.getElementById('tagsPanel') as HTMLElement;
  const emptyState = document.getElementById('emptyState') as HTMLElement;

  // 先全部隐藏
  graphPanel.classList.add('hidden');
  chatPanel.classList.add('hidden');
  recordsList.classList.add('hidden');
  tagsPanel.classList.add('hidden');
  emptyState.classList.add('hidden');

  // 切换标签时清空搜索状态
  const recordsApi = (window as any).__knowSeekRecords;
  if (recordsApi) recordsApi.setSearchQuery('');
  const graphApi = (window as any).__knowSeekGraph;
  const gEng = graphApi?.forceGraphEngine;
  if (gEng) gEng.nodes.forEach((n: any) => { n._searchMatch = false; });

  // 更新搜索框 placeholder
  const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
  if (searchInput) {
    searchInput.value = '';
    const placeholders: Record<string, string> = {
      current: '搜索当前页标注...',
      all: '搜索全部标注...',
      graph: '搜索图谱节点...', 
      chat: '搜索对话历史...',  
    };
    searchInput.placeholder = placeholders[filter] || '搜索标注、笔记...';
  }

  if (filter === 'graph') {
    showPanelWithAnim(graphPanel);
    const graphApi = (window as any).__knowSeekGraph;
    if (graphApi) graphApi.initGraphUI();
    const gEng = graphApi ? graphApi.forceGraphEngine : null;
    if (gEng) {
      const data = graphApi.buildGraphData();
      if (data.nodes.length === 0) {
        const ctx = gEng.ctx;
        const w = gEng.width;
        const h = gEng.height;
        ctx.clearRect(0, 0, w, h);
        const wrapper = document.getElementById('graphWrapper') as HTMLElement;
        const style = getComputedStyle(wrapper);
        ctx.fillStyle = style.getPropertyValue('--bg-surface').trim() || '#ffffff';
        ctx.fillRect(0, 0, w, h);
      } else {
        // 自适应初始视角：基于节点数量估算最终布局范围
        const estRadius = Math.max(100, Math.sqrt(data.nodes.length) * 60);
        const usableW = gEng.width - 120;
        const usableH = gEng.height - 120;
        gEng.viewScale = Math.max(0.2, Math.min(usableW / (estRadius * 2), usableH / (estRadius * 2), 1.5));
        gEng.viewX = 0;
        gEng.viewY = 0;
        gEng.setData(data.nodes, data.edges, true);
        gEng.start();
      }
    }
  } else if (filter === 'chat') {
    showPanelWithAnim(chatPanel);
    const chatApi = (window as any).__knowSeekChat;
    if (chatApi && typeof chatApi.onPanelShown === 'function') {
      chatApi.onPanelShown();
    }
  } else if (filter === 'current') {
    showPanelWithAnim(recordsList);
    tagsPanel.classList.add('hidden');
    const recordsApi = (window as any).__knowSeekRecords;
    if (recordsApi) {
      recordsApi.setFilter(filter);
      recordsApi.renderRecords();
    } else {
      renderRecords();
    }
    // 自动保存快照 + 变更检测
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs?.[0]?.url && tabs[0].url.startsWith('http')) {
        const url = tabs[0].url;
        const title = tabs[0].title || '';
        // 异步执行，不阻塞渲染
        autoSaveSnapshotForCurrentTab(url, title);
        checkForChanges(url);
      }
    });
  } else {
    // all
    showPanelWithAnim(recordsList);
    tagsPanel.classList.remove('hidden');
    const recordsApi = (window as any).__knowSeekRecords;
    if (recordsApi) {
      recordsApi.setFilter(filter);
      recordsApi.renderRecords();
    } else {
      renderRecords();
    }
  }
}

// ── 主渲染函数 ──
function render(): void {
  const tagsApi = (window as any).__knowSeekTags;
  if (tagsApi && typeof tagsApi.render === 'function') {
    tagsApi.render();
  }
  const recordsApi = (window as any).__knowSeekRecords;
  if (recordsApi) {
    recordsApi.renderRecords();
  } else {
    renderRecords();
  }
  // 如果图谱正在显示，重建图谱
  const gEng = (window as any).__knowSeekGraph ? (window as any).__knowSeekGraph.forceGraphEngine : null;
  if (gEng) {
    const graphPanel = document.getElementById('graphPanel') as HTMLElement;
    if (!graphPanel.classList.contains('hidden')) {
      const data = (window as any).__knowSeekGraph.buildGraphData();
      if (data.nodes.length > 0) {
        gEng.setData(data.nodes, data.edges);
        gEng.start();
      }
    }
  }
}

// ── 旧版 renderRecords（兼容旧模块未加载时）──
function renderRecords(): void {
  const recordsApi = (window as any).__knowSeekRecords;
  if (recordsApi && typeof recordsApi.renderRecords === 'function') {
    recordsApi.renderRecords();
  }
}

// ── 选项卡拖拽排序 ──
function setupTabDragSort(): void {
  const container = document.querySelector('.filter-tabs') as HTMLElement | null;
  if (!container) return;

  let draggedItem: HTMLElement | null = null;

  container.querySelectorAll('.filter-tab').forEach(tab => {
    (tab as HTMLElement).draggable = true;

    tab.addEventListener('dragstart', (e) => {
      draggedItem = tab as HTMLElement;
      tab.classList.add('dragging');
      (e as DragEvent).dataTransfer!.effectAllowed = 'move';
    });

    tab.addEventListener('dragend', () => {
      tab.classList.remove('dragging');
      draggedItem = null;
      saveTabOrder();
    });

    tab.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!draggedItem || draggedItem === tab) return;
      const rect = (tab as HTMLElement).getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      if ((e as DragEvent).clientX! < midX) {
        container.insertBefore(draggedItem, tab as HTMLElement);
      } else {
        container.insertBefore(draggedItem, (tab as HTMLElement).nextSibling);
      }
    });
  });
}

function saveTabOrder(): void {
  const container = document.querySelector('.filter-tabs') as HTMLElement | null;
  if (!container) return;
  const order = Array.from(container.querySelectorAll('.filter-tab')).map(tab => (tab as HTMLElement).dataset.filter);
  chrome.storage.local.set({ filter_tab_order: order }).catch(() => {});
}

// ── 颜色选择器 ──
function renderDefaultColorOptions(): void {
  chrome.storage.local.get(STORAGE_KEYS.COLOR_CONFIG).then(data => {
    const colorConfig = (data as any)[STORAGE_KEYS.COLOR_CONFIG];
    if (!colorConfig) return;

    const container = document.getElementById('defaultColorOptions') as HTMLElement | null;
    if (!container) return;

    container.innerHTML = '';
    colorConfig.colors.forEach((color: any) => {
      const option = document.createElement('div');
      option.className = 'color-option';
      option.style.backgroundColor = color.bg;
      if (color.id === colorConfig.defaultColorId) {
        option.classList.add('active');
      }
      option.addEventListener('click', () => {
        colorConfig.defaultColorId = color.id;
        chrome.storage.local.set({ [STORAGE_KEYS.COLOR_CONFIG]: colorConfig });
        renderDefaultColorOptions();
      });
      container.appendChild(option);
    });
  });
}

function showColorPicker(): void {
  renderDefaultColorOptions();
  const modal = document.getElementById('colorPickerModal') as HTMLElement;
  if (modal) modal.classList.remove('hidden');
}

// ── 定位记录（从消息或图谱跳转）──
async function locateRecordInSidebar(recordId: string): Promise<void> {
  const record = records.find((r: any) => r.id === recordId);
  if (!record) return;

  const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
  if (searchInput) searchInput.value = '';

  // 判断记录是否属于当前页面
  const tabs = await new Promise<chrome.tabs.Tab[]>(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
  const isCurrentPage = tabs && tabs[0] && record.url === tabs[0].url;
  const filter = isCurrentPage ? 'current' : 'all';

  // 更新过滤选项卡状态
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  const targetTab = document.querySelector<HTMLElement>(`.filter-tab[data-filter="${filter}"]`);
  if (targetTab) targetTab.classList.add('active');

  // 切换到正确的面板
  switchToFilter(filter);

  // 展开树状路径
  const recordsApi = (window as any).__knowSeekRecords;
  if (recordsApi && typeof recordsApi.expandRecordTreePath === 'function') {
    recordsApi.expandRecordTreePath(record);
    recordsApi.setSelectedTag(null);
    recordsApi.setFilter(filter);
    recordsApi.renderRecords();
  }

  // 滚动到记录卡片并高亮
  setTimeout(() => {
    const recordsList = document.getElementById('recordsList') as HTMLElement;
    const card = recordsList.querySelector(`[data-record-id="${recordId}"]`) as HTMLElement | null;
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.style.transition = 'background-color 0.3s';
      card.style.backgroundColor = '#eff6ff';
      setTimeout(() => {
        card.style.backgroundColor = '';
        card.style.transition = '';
      }, 1500);
    }
  }, 150);

  // 发送消息到 background，跳转到网页中的标注位置
  chrome.runtime.sendMessage({ action: 'navigateToRecord', recordId }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
}

function setupEventListeners(): void {
  // 搜索框
  const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const query = (e.target as HTMLInputElement).value;
      const activeTab = document.querySelector<HTMLElement>('.filter-tab.active');
      const filter = activeTab?.dataset?.filter || 'current';
      if (filter === 'chat') {
        // 搜索对话历史
        const chatApi = (window as any).__knowSeekChat;
        if (chatApi && typeof chatApi.searchChatSessions === 'function') {
          chatApi.searchChatSessions(query);
        }
      } else if (filter === 'graph') {
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = window.setTimeout(() => {
          const graphApi = (window as any).__knowSeekGraph;
          const gEng = graphApi?.forceGraphEngine;
          if (!gEng) return;
          // 清除上一次的搜索高亮
          gEng.nodes.forEach((n: any) => { n._searchMatch = false; });
          if (!query.trim()) {
            gEng.resetView();
          } else if (query.trim().length >= 2) {
            const q = query.toLowerCase().trim();
            const matched: any[] = gEng.nodes.filter((n: any) => n.label && n.label.toLowerCase().includes(q));
            matched.forEach((n: any) => { n._searchMatch = true; });
            if (matched.length > 0) {
              gEng.focusOnNodes(matched.map((n: any) => n.id));
            }
          }
          gEng._needsRender = true;
          if (!gEng.running) gEng._render();
        }, 300);
      } else {
        // 搜索标注记录
        const recordsApi = (window as any).__knowSeekRecords;
        if (recordsApi) {
          recordsApi.setSearchQuery(query);
          recordsApi.renderRecords();
        }
      }
    });
  }

  // 过滤选项卡
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const filter = (tab as HTMLElement).dataset.filter || 'all';
      switchToFilter(filter);
    });
  });

  // 选项卡拖拽排序
  setupTabDragSort();

  // 颜色选择器
  const defaultColorBtn = document.getElementById('defaultColorBtn') as HTMLElement | null;
  if (defaultColorBtn) {
    defaultColorBtn.addEventListener('click', showColorPicker);
  }

  // 颜色选择弹窗关闭
  document.querySelectorAll('#colorPickerModal .modal-close, #colorPickerModal .modal-overlay').forEach(el => {
    el.addEventListener('click', () => {
      document.getElementById('colorPickerModal')?.classList.add('hidden');
    });
  });

  // 通用 data-close 关闭所有弹窗
  document.querySelectorAll('[data-close="true"]').forEach(el => {
    el.addEventListener('click', () => {
      document.getElementById('recordDetailModal')?.classList.add('hidden');
      document.getElementById('githubStorageModal')?.classList.add('hidden');
      document.getElementById('backendServiceModal')?.classList.add('hidden');
      document.getElementById('aiConfigModal')?.classList.add('hidden');
      document.getElementById('colorPickerModal')?.classList.add('hidden');
      document.getElementById('serverBackupLogModal')?.classList.add('hidden');
    });
  });

  // 空状态导入按钮
  const emptyImportBtn = document.querySelector('.empty-state .import-btn') as HTMLElement | null;
  if (emptyImportBtn) {
    emptyImportBtn.addEventListener('click', () => {
      const settingsApi = (window as any).__knowSeekSettings;
      if (settingsApi && typeof settingsApi.openImportDialog === 'function') {
        settingsApi.openImportDialog();
      }
    });
  }

  // 初始化默认颜色选项
  renderDefaultColorOptions();

  // chrome.runtime.onMessage 监听
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'pageUrlChanged') {
      // 当前标签页 URL 变化 → 刷新当前页面记录
      const activeTab = document.querySelector<HTMLElement>('.filter-tab.active');
      const filter = activeTab?.dataset?.filter || 'current';
      if (filter === 'current') {
        const recordsApi = (window as any).__knowSeekRecords;
        if (recordsApi) {
          recordsApi.renderRecords();
        }
      }
      sendResponse({});
      return;
    }

    if (request.action === 'locateRecord') {
      locateRecordInSidebar(request.recordId);
      sendResponse({});
      return;
    }

    if (request.action === 'getRecordOrder') {
      // 外部更新记录排序
      if (request.savedOrder) {
        chrome.storage.local.set({ record_order: request.savedOrder }).catch(() => {});
      }
      const recordsApi = (window as any).__knowSeekRecords;
      if (recordsApi) {
        recordsApi.renderRecords();
      }
      sendResponse({});
    }

    if (request.action === 'saveSnapshotToLocal') {
      sendResponse({ saved: true, method: 'opfs' });
      return true;
    }

    if (request.action === 'addToChat') {
      chrome.storage.local.remove('pendingAddToChat').catch(() => {});
      switchToFilter('chat');
      const chatApi = (window as any).__knowSeekChat;
      if (chatApi && typeof chatApi.addToChat === 'function') {
        chatApi.addToChat(request.text, request.pageTitle, request.pageUrl, request.pageContent);
      }
      sendResponse({});
    }

    if (request.action === 'addImageToChat') {
      chrome.storage.local.remove('pendingImageToChat').catch(() => {});
      switchToFilter('chat');
      const chatApi = (window as any).__knowSeekChat;
      if (chatApi && typeof chatApi.addImageToChat === 'function') {
        chatApi.addImageToChat(request.dataUrl, request.name, request.pageTitle, request.pageUrl);
      }
      sendResponse({});
    }

    if (request.action === 'sendVideoToChat') {
      chrome.storage.local.remove('pendingVideoToChat').catch(() => {});
      switchToFilter('chat');
      const chatApi = (window as any).__knowSeekChat;
      if (chatApi && typeof chatApi.sendVideoToChat === 'function') {
        chatApi.sendVideoToChat(request.dataUrl, request.name, request.pageTitle, request.pageUrl, request.subtitles);
      }
      sendResponse({});
    }

    if (request.action === 'recordCreated') {
      // 有新的标注创建 → 自动保存当前页面快照
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs?.[0]?.url && tabs[0].url.startsWith('http')) {
          autoSaveSnapshotForCurrentTab(tabs[0].url, tabs[0].title || '');
        }
      });
      sendResponse({});
    }

    if (request.action === 'contentChangeDetected') {
      // 后台检测到内容变更，重新加载通知列表
      loadNotificationsFromStorage();
      sendResponse({});
    }

    if (request.action === 'embeddingSaved') {
      // 后台向量保存成功，显示提示
      showEmbeddingToast('✓ 页面快照已保存到向量库');
      sendResponse({});
    }
  });

  // 存储管理：按钮
  const storageBtn = document.getElementById('storageManagerBtn') as HTMLElement | null;
  if (storageBtn) {
    storageBtn.addEventListener('click', () => {
      showStorageModal();
    });
  }
  // 存储管理：关闭 & 清除（事件委托）
  const storageModal = document.getElementById('storageModal') as HTMLElement | null;
  if (storageModal) {
    storageModal.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement;

      // 关闭弹窗
      if (target.matches('[data-storage-close]') || target.closest('[data-storage-close]')) {
        storageModal.classList.add('hidden');
        return;
      }

      // 清除数据
      const clearBtn = target.closest('[data-clear]') as HTMLElement | null;
      if (!clearBtn) return;
      const action = clearBtn.dataset.clear || '';

      const confirmMsg: Record<string, string> = {
        chrome: '确定要清除所有标注记录、标签和配置吗？\n网页快照和截图不受影响。',
        snapshots: '确定要清除所有网页快照吗？\n标注记录和截图不受影响。',
        screenshots: '确定要清除所有截图文件吗？\n标注记录和网页快照不受影响。',
        all: '确定要清除所有数据吗？\n包括标注记录、网页快照和截图，此操作不可恢复！',
      };
      if (!confirm(confirmMsg[action] || '确定要执行此操作吗？')) return;

      try {
        if (action === 'chrome' || action === 'all') {
          await chrome.storage.local.clear();
          await chrome.storage.sync.clear();
          // 重置状态
          const { updateRecords, updateTags, updateMarkTags, updateSavedRecordOrder } = await import('./state');
          updateRecords([]);
          updateTags([]);
          updateMarkTags([]);
          updateSavedRecordOrder([]);
        }
        if (action === 'snapshots' || action === 'all') {
          await clearAllSnapshots();
        }
        if (action === 'screenshots' || action === 'all') {
          try {
            const root = await navigator.storage.getDirectory();
            await root.removeEntry('snapshots', { recursive: true });
          } catch { /* 目录可能不存在 */ }
        }

        // 刷新显示
        showStorageModal();
      } catch (err) {
        console.error('[Storage] 清除数据失败:', err);
        alert('清除数据失败，请重试');
      }
    });
  }

  // chrome.storage.onChanged 监听 — 检测 URL 变化（来自 content script 的 storage 广播）
  chrome.storage.onChanged.addListener((changes) => {
    if (changes._pageUrlChanged) {
      const activeTab = document.querySelector<HTMLElement>('.filter-tab.active');
      const filter = activeTab?.dataset?.filter || 'current';
      if (filter === 'current') {
        const recordsApi = (window as any).__knowSeekRecords;
        if (recordsApi) {
          recordsApi.renderRecords();
        }
      }
    }
    // 后台检测到变更时更新通知列表
    if (changes._contentChangeNotifications) {
      contentNotifications = changes._contentChangeNotifications.newValue || [];
      updateNotificationBadge();
    }
  });
}

async function init() {
  try {
    await loadData();
    await loadTheme();
    setupStorageListener();
    await loadCheckConfig();

    // 初始化记录列表模块
    const recordsContainer = document.getElementById('recordsList');
    if (recordsContainer) {
      initRecords(recordsContainer);
    }

    // 初始化标签管理面板
    initTags();

    // 初始化 AI 对话面板
    try {
      await initChat();
    } catch (err) {
      console.warn('[知寻] Chat 模块初始化失败:', err);
    }

    // 初始化设置与备份面板
    try {
      await initSettings();
    } catch (err) {
      console.warn('[知寻] Settings 模块初始化失败:', err);
    }

    // 初始化事件绑定
    setupEventListeners();

    // 加载通知列表
    await loadNotificationsFromStorage();

    // 定时轮询通知列表（chrome.runtime.sendMessage 和 storage.onChanged 在侧边栏中不可靠）
    setInterval(() => {
      loadNotificationsFromStorage();
    }, 5000);

    // 首次渲染
    render();

    // 同步初始筛选状态（根据 HTML 中 active 的 tab）
    const activeTab = document.querySelector<HTMLElement>('.filter-tab.active');
    if (activeTab) {
      const initialFilter = activeTab.dataset.filter || 'current';
      switchToFilter(initialFilter);
    }

    // 渲染模型切换器
    const chatApi = (window as any).__knowSeekChat;
    if (chatApi && typeof chatApi.renderModelSwitcher === 'function') {
      chatApi.renderModelSwitcher();
    }

    // 渲染备份状态
    const settingsApi = (window as any).__knowSeekSettings;
    if (settingsApi && typeof settingsApi.renderBackupStatus === 'function') {
      settingsApi.renderBackupStatus();
    }

    console.log('[知寻] Sidebar 模块初始化完成');
  } catch (err) {
    console.warn('[知寻] Sidebar 模块初始化失败:', err);
  }

  // ===== URL 变化检测（事件驱动，不轮询）=====
  // chrome.tabs.onUpdated：捕获标签页 URL 变化（非 SPA 导航）
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url) {
      const activeTab = document.querySelector<HTMLElement>('.filter-tab.active');
      const filter = activeTab?.dataset?.filter || 'current';
      if (filter === 'current') {
        const recordsApi = (window as any).__knowSeekRecords;
        if (recordsApi) recordsApi.renderRecords();
      }
    }
  });

  // chrome.tabs.onActivated：捕获标签页切换（用户在不同已打开标签页间点击切换）
  chrome.tabs.onActivated.addListener(() => {
    const activeTab = document.querySelector<HTMLElement>('.filter-tab.active');
    const filter = activeTab?.dataset?.filter || 'current';
    if (filter === 'current') {
      const recordsApi = (window as any).__knowSeekRecords;
      if (recordsApi) recordsApi.renderRecords();
    }
  });
}

// ===== 从 chat API 委托的函数 =====
function chatApiDelegate(name: string) {
  return (...args: any[]) => {
    const chatApi = (window as any).__knowSeekChat;
    if (chatApi && typeof chatApi[name] === 'function') return chatApi[name](...args);
  };
}
const getActiveProvider = chatApiDelegate('getActiveProvider');
const getActiveModel = chatApiDelegate('getActiveModel');
const isVisionModel = chatApiDelegate('isVisionModel');
const syncActiveToBackend = chatApiDelegate('syncActiveToBackend');

// 暴露到 window 供其他模块调用
(window as any).__knowSeekSidebar = {
  switchToFilter,
  render,
  renderRecords,
  setupTabDragSort,
  showColorPicker,
  renderDefaultColorOptions,
  locateRecordInSidebar,
  gotoRecord: (recordId: string) => locateRecordInSidebar(recordId),
  renderMarkdown,
  loadSnapshotFromOPFS,
  deleteSnapshotFromOPFS,
  loadAllLegacySnapshots,
  showLegacyGallery,
  handlePasteImage,
  setupLinkAutocomplete,
  getActiveProvider,
  getActiveModel,
  isVisionModel,
  syncActiveToBackend,
  clearNotificationsForUrl,
};

/** 异步加载粘贴图片（从 OPFS 加载并设置 img.src） */
async function loadPasteImagesAsync(container: HTMLElement): Promise<void> {
  const imgs = container.querySelectorAll('.content-paste-image-loading');
  if (imgs.length === 0) return;
  for (const img of imgs) {
    const snapshotId = (img as HTMLElement).dataset.snapshotId;
    if (!snapshotId) continue;
    let loaded = false;
    // 尝试从 OPFS 加载
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('snapshots');
      const fileHandle = await dir.getFileHandle(snapshotId + '.png');
      const file = await fileHandle.getFile();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      (img as HTMLImageElement).src = dataUrl;
      img.classList.remove('content-paste-image-loading');
      loaded = true;
    } catch {
      // OPFS 没有该图片
    }
    if (!loaded) {
      (img as HTMLImageElement).outerHTML = `<span style="color:#999;font-size:12px;display:inline-block;padding:8px;border:1px dashed #ddd;border-radius:4px;margin:8px 0;">图片不可用 (${snapshotId})</span>`;
    }
  }
}

/** 渲染 Markdown */
async function renderMarkdown(text: string, container?: HTMLElement): Promise<string | void> {
  if (!text) {
    const empty = '<p style="color:#9ca3af;font-style:italic">暂无笔记</p>';
    if (container) container.innerHTML = empty;
    return empty;
  }

  const imagePlaceholders: string[] = [];
  let placeholderIndex = 0;
  let processed = text.replace(/!\[图片\]\(snapshot:([^\)]+)\)/g, (_match, snapshotId) => {
    imagePlaceholders.push(snapshotId);
    return `%%IMAGE_PLACEHOLDER_${placeholderIndex++}%%`;
  });

  let html: string;
  if (typeof marked.parse === 'function') {
    html = marked.parse(processed, { breaks: true, gfm: true }) || processed;
  } else {
    html = processed;
  }

  html = html.replace(/%%IMAGE_PLACEHOLDER_(\d+)%%/g, (_match, idx) => {
    const snapshotId = imagePlaceholders[parseInt(idx)];
    return `<img data-snapshot-id="${snapshotId}" class="content-paste-image-loading" alt="图片加载中..." style="max-width:100%;margin:8px 0;display:block;min-height:40px;">`;
  });

  if (container) {
    container.innerHTML = html;
    // 等待 OPFS 图片加载完成，避免异步竞态
    await loadPasteImagesAsync(container);
  }
  return html;
}

/** HTML 转义 */
function escapeHtml(text: string): string {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** 显示截图弹窗 */
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

  modal.querySelector('.snapshot-overlay')!.addEventListener('click', () => modal.remove());
  modal.querySelector('.snapshot-close')!.addEventListener('click', () => modal.remove());
}

/** 从 OPFS 加载截图 */
async function loadSnapshotFromOPFS(record: any): Promise<string | null> {
  if (!record) return null;
  const recordId = record.id;
  const recordTime = record.created_at;

  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('snapshots');

    // 1. 先尝试精确匹配新截图
    try {
      const fileName = `snapshot_${recordId}.png`;
      const fileHandle = await dir.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      const arrayBuffer = await file.arrayBuffer();
      const blob = new Blob([arrayBuffer], { type: 'image/png' });
      const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
      return base64 as string;
    } catch (e) {
      // 没有新截图，继续尝试旧截图匹配
    }

    // 2. 尝试按创建时间匹配旧截图（legacy_img_{timestamp}_xxx.png）
    if (!recordTime) return null;
    let bestMatch: any = null;
    let minDiff = Infinity;

    for await (const entry of dir.values()) {
      if (entry.kind === 'file' && entry.name.startsWith('legacy_img_')) {
        const parts = entry.name.split('_');
        if (parts.length >= 3) {
          const imgTime = parseInt(parts[2]);
          if (!isNaN(imgTime)) {
            const diff = Math.abs(imgTime - recordTime);
            if (diff < minDiff) {
              minDiff = diff;
              bestMatch = entry;
            }
          }
        }
      }
    }

    if (bestMatch && minDiff < 10000) {
      const file = await bestMatch.getFile();
      const arrayBuffer = await file.arrayBuffer();
      const blob = new Blob([arrayBuffer], { type: 'image/png' });
      const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
      return base64 as string;
    }

    return null;
  } catch (err: any) {
    if (err.name === 'NotFoundError') return null;
    console.error('[KnowSeek] 加载 OPFS 截图失败:', err);
    return null;
  }
}

/** 从 OPFS 删除截图 */
async function deleteSnapshotFromOPFS(recordId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('snapshots');
    const fileName = `snapshot_${recordId}.png`;
    await dir.removeEntry(fileName);
  } catch (err) {
    // 文件可能不存在，忽略错误
  }
}

/** 读取所有旧截图 */
async function loadAllLegacySnapshots(): Promise<{ name: string; dataUrl: string }[]> {
  const results: { name: string; dataUrl: string }[] = [];
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('snapshots');
    for await (const entry of dir.values()) {
      if (entry.kind === 'file' && entry.name.startsWith('legacy_')) {
        const file = await entry.getFile();
        const arrayBuffer = await file.arrayBuffer();
        const blob = new Blob([arrayBuffer], { type: 'image/png' });
        const base64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
        results.push({ name: entry.name, dataUrl: base64 as string });
      }
    }
  } catch (err) {
    console.warn('[KnowSeek] 读取旧截图失败:', err);
  }
  return results;
}

/** 显示旧截图库 */
function showLegacyGallery(images: { name: string; dataUrl: string }[]): void {
  const modal = document.createElement('div');
  modal.className = 'snapshot-modal';
  modal.innerHTML = `
    <div class="snapshot-overlay"></div>
    <div class="snapshot-content" style="max-width:90vw;max-height:90vh;overflow-y:auto;padding:20px">
      <button class="snapshot-close">&times;</button>
      <h3 style="margin-bottom:12px">已迁移的旧截图 (${images.length}张)</h3>
      <div class="legacy-gallery" style="display:flex;flex-wrap:wrap;gap:10px">
        ${images.map((img, i) => `
          <img src="${img.dataUrl}" data-url="${i}" 
               style="width:200px;height:auto;cursor:pointer;border-radius:4px;object-fit:cover">
        `).join('')}
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('.snapshot-overlay')!.addEventListener('click', () => modal.remove());
  modal.querySelector('.snapshot-close')!.addEventListener('click', () => modal.remove());
  modal.querySelector('.legacy-gallery')!.addEventListener('click', (e) => {
    const img = (e.target as HTMLElement).closest('img');
    if (img) {
      const idx = parseInt(img.dataset.url!);
      modal.remove();
      showSnapshotModal(images[idx].dataUrl);
    }
  });
}

/** 处理粘贴图片 — 保存到 OPFS，插入 snapshot 引用 */
async function handlePasteImage(e: ClipboardEvent, recordId: string): Promise<void> {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.indexOf('image') !== -1) {
      e.preventDefault();
      const blob = items[i].getAsFile();
      if (!blob) {
        console.warn('[KnowSeek] 无法获取粘贴的图片数据');
        break;
      }

      const snapshotId = 'paste_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('snapshots', { create: true });
        const fileHandle = await dir.getFileHandle(snapshotId + '.png', { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch (opfsErr) {
        console.error('[KnowSeek] OPFS 写入失败:', opfsErr);
      }

      const ta = e.target as HTMLTextAreaElement;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const taText = ta.value;
      const mdImage = `![图片](snapshot:${snapshotId})`;
      ta.value = taText.substring(0, start) + mdImage + taText.substring(end);
      ta.selectionStart = ta.selectionEnd = start + mdImage.length;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      break;
    }
  }
}

/** 设置 [[ 链接自动补全 */
const _activeAutocompletes = new Set<HTMLTextAreaElement>();

function setupLinkAutocomplete(textarea: HTMLTextAreaElement, currentRecord: any): void {
  let dropdown: HTMLElement | null = null;
  let activeIdx = -1;
  let items: any[] = [];

  function removeDropdown() {
    if (dropdown) { dropdown.remove(); dropdown = null; }
    activeIdx = -1; items = [];
    _activeAutocompletes.delete(textarea);
  }

  function onInput() {
    const val = textarea.value;
    const sel = textarea.selectionStart;
    const before = val.slice(0, sel);
    const lastOpen = before.lastIndexOf('[[');
    if (lastOpen === -1) { removeDropdown(); return; }
    const afterOpen = val.slice(lastOpen + 2, sel);
    if (afterOpen.includes(']]')) { removeDropdown(); return; }
    const query = afterOpen.toLowerCase().trim();

    items = [];
    activeIdx = -1;
    // 用模块级的 records 变量（从 state.ts 导入）
    for (const r of records) {
      if (currentRecord && r.id === currentRecord.id) continue;
      const label = r.text || r.title || '';
      if (!query || label.toLowerCase().includes(query)) {
        items.push(r);
        if (items.length >= 20) break;
      }
    }

    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.className = 'link-autocomplete-dropdown';
      document.body.appendChild(dropdown);
      _activeAutocompletes.add(textarea);
    }

    if (items.length === 0) {
      dropdown.innerHTML = '<div class="link-autocomplete-empty">无匹配标注</div>';
      return;
    }

    dropdown.innerHTML = '';
    items.forEach((r, i) => {
      const div = document.createElement('div');
      div.className = 'link-autocomplete-item';
      const color = (r.color && r.color.bg) || '#3b82f6';
      const label = r.text || r.title || '';
      let host = '';
      try { host = r.url ? new URL(r.url).hostname : ''; } catch (_) {}
      div.innerHTML = `<span class="ac-dot" style="background:${color}"></span><span class="ac-label">${escapeHtml(label)}</span><span class="ac-url">${host}</span>`;
      div.dataset.idx = String(i);
      div.addEventListener('click', () => selectItem(i));
      div.addEventListener('mousedown', (e) => e.preventDefault());
      dropdown.appendChild(div);
    });

    positionDropdown();
  }

  function positionDropdown() {
    if (!dropdown) return;
    const rect = textarea.getBoundingClientRect();
    const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 20;
    const before = textarea.value.slice(0, textarea.selectionStart);
    const lines = before.split('\n');
    const linePos = lines[lines.length - 1].length;
    const left = rect.left + Math.min(linePos * 7.5, rect.width - 220);
    const top = rect.top + (lines.length - 1) * lineHeight + 30;
    dropdown.style.left = Math.max(4, Math.min(left, window.innerWidth - 240)) + 'px';
    dropdown.style.top = Math.min(top, window.innerHeight - 260) + 'px';
  }

  function selectItem(idx: number) {
    if (!items[idx]) return;
    const selectedText = items[idx].text || items[idx].title || '';
    const val = textarea.value;
    const sel = textarea.selectionStart;
    const before = val.slice(0, sel);
    const lastOpen = before.lastIndexOf('[[');
    if (lastOpen === -1) { removeDropdown(); return; }
    const afterClose = val.indexOf(']]', sel);
    const endPos = afterClose !== -1 ? afterClose + 2 : sel;
    const newVal = val.slice(0, lastOpen) + '[[' + selectedText + ']] ' + val.slice(endPos);
    textarea.value = newVal;
    const newCursor = lastOpen + 2 + selectedText.length + 3;
    textarea.selectionStart = textarea.selectionEnd = newCursor;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    removeDropdown();
    textarea.focus();
  }

  function updateActive() {
    if (!dropdown) return;
    dropdown.querySelectorAll('.link-autocomplete-item').forEach((el, i) => {
      el.classList.toggle('active', i === activeIdx);
    });
    if (activeIdx >= 0) {
      const el = dropdown.querySelector(`.link-autocomplete-item[data-idx="${activeIdx}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (!dropdown || items.length === 0) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      removeDropdown();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
      updateActive();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, -1);
      updateActive();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (activeIdx >= 0 && activeIdx < items.length) {
        e.preventDefault();
        selectItem(activeIdx);
      } else if (e.key === 'Enter') {
        removeDropdown();
      }
      return;
    }
  }

  function onClickOutside(e: MouseEvent) {
    if (dropdown && !dropdown.contains(e.target as Node) && e.target !== textarea) {
      removeDropdown();
    }
  }

  // 清理旧的监听器
  if ((textarea as any)._linkAutocompleteCleanup) (textarea as any)._linkAutocompleteCleanup();
  textarea.addEventListener('input', onInput);
  textarea.addEventListener('keydown', onKeydown);
  document.addEventListener('mousedown', onClickOutside);
  (textarea as any)._linkAutocompleteCleanup = () => {
    textarea.removeEventListener('input', onInput);
    textarea.removeEventListener('keydown', onKeydown);
    document.removeEventListener('mousedown', onClickOutside);
    removeDropdown();
  };
}

init();

export { };