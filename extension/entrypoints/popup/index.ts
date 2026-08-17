const STORAGE_KEYS = {
  RECORDS: 'records',
  TAGS: 'tags',
  MARK_TAGS: 'mark_tags',
  COLOR_CONFIG: 'color_config',
  READ_STATUS: 'feed_read_status',
  RSSHUB_BASE_URL: 'rsshub_base_url',
  FEED_MAX_DAYS: 'feed_max_days'
};

const DEFAULT_RSSHUB_BASE = 'http://localhost:8080';
let RSSHUB_BASE = DEFAULT_RSSHUB_BASE;
const DEFAULT_FEED_MAX_DAYS = 3;
let FEED_MAX_DAYS = DEFAULT_FEED_MAX_DAYS;

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== 通知中心导入 =====
import { saveSnapshot, getSnapshot, deleteSnapshot } from '../../utils/indexedb';
import { stripExtraContent, stripMarkdown, normalizePara, splitParagraphs } from '../../utils/content-diff';
import { diffLines } from 'diff';

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
  dailyTime: string;
}
const DEFAULT_CHECK_CONFIG: CheckConfig = {
  mode: 'interval',
  intervalMinutes: 0,
  dailyTime: '09:00'
};
let checkConfig: CheckConfig = { ...DEFAULT_CHECK_CONFIG };

const NOTIF_STORAGE_KEY = '_contentChangeNotifications';
const CHECK_CONFIG_KEY = 'checkConfig';

interface DiffLine { text: string; type: 'unchanged' | 'added' | 'removed' | 'empty' }

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
  const badge = document.getElementById('notifTabBadge') as HTMLElement | null;
  if (!badge) return;
  const unread = contentNotifications.filter(n => !n.read).length;
  if (unread > 0) {
    badge.textContent = String(unread);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
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

function getTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

function renderNotificationList(container: HTMLElement): void {
  container.innerHTML = '';

  if (contentNotifications.length === 0) {
    container.innerHTML = '<div class="notification-empty">暂无通知</div>';
    return;
  }

  const items = [...contentNotifications].sort((a, b) => b.detectedAt - a.detectedAt);
  items.forEach((n, i) => {
    const timeAgo = getTimeAgo(n.detectedAt);
    const item = document.createElement('div');
    item.className = `notification-item${n.read ? '' : ' notification-item--unread'}`;

    const favicon = getFaviconUrl(n.url);
    item.innerHTML = `
      ${n.read ? '' : '<span class="notif-unread-dot"></span>'}
      <div class="notification-item-icon"><img class="notif-favicon" src="${favicon}" width="14" height="14" alt=""></div>
      <div class="notification-item-body">
        <div class="notification-item-title">${escapeHtml(n.title)}</div>
        <div class="notification-item-meta">${timeAgo}</div>
      </div>
      <div class="notification-item-diff">
        ${n.added > 0 ? `<span class="diff-added">✚${n.added}</span>` : ''}
        ${n.modified > 0 ? `<span class="diff-modified">➜${n.modified}</span>` : ''}
        ${n.removed > 0 ? `<span class="diff-removed">✕${n.removed}</span>` : ''}
      </div>
    `;
    const faviconImg = item.querySelector('.notif-favicon') as HTMLImageElement | null;
    if (faviconImg) {
      faviconImg.addEventListener('error', () => { faviconImg.style.display = 'none'; });
    }
    const actualIdx = contentNotifications.indexOf(n);
    item.addEventListener('click', () => {
      showChangeDetail(actualIdx);
    });
    container.appendChild(item);
  });
}

function showChangeDetail(index: number): void {
  const n = contentNotifications[index];
  if (!n) return;

  // 标记已读
  if (!n.read) {
    n.read = true;
    saveNotificationsToStorage();
    // 刷新通知列表 UI
    const list = document.getElementById('notifNotificationList') as HTMLElement | null;
    if (list) renderNotificationList(list);
  }

  const modal = document.getElementById('changeDetailModal') as HTMLElement | null;
  if (!modal) return;
  modal.classList.remove('hidden');

  const titleEl = modal.querySelector('.change-detail-title') as HTMLElement | null;
  const summaryEl = modal.querySelector('.change-detail-summary') as HTMLElement | null;
  const contentEl = modal.querySelector('.change-detail-content') as HTMLElement | null;
  const saveBtn = document.getElementById('changeDetailSaveBtn') as HTMLElement | null;
  const ignoreBtn = document.getElementById('changeDetailIgnoreBtn') as HTMLElement | null;
  const compareBtn = document.getElementById('changeDetailCompareBtn') as HTMLElement | null;
  if (titleEl) titleEl.textContent = `🔄 ${n.title}`;
  if (saveBtn) saveBtn.dataset.url = n.url;
  if (ignoreBtn) ignoreBtn.dataset.url = n.url;
  if (compareBtn) compareBtn.dataset.url = n.url;
  if (summaryEl) {
    summaryEl.innerHTML = `
      <span class="diff-added">✚ 新增 ${n.added} 个段落</span>
      <span class="diff-modified">➜ 修改 ${n.modified} 个段落</span>
      ${n.removed > 0 ? `<span class="diff-removed">✕ 删除 ${n.removed} 个段落</span>` : ''}
    `;
  }
  if (contentEl) {
    const oldParas = splitParagraphs(n.oldContent);
    const newParas = splitParagraphs(n.newContent);
    const oldNorms = new Map<string, string>();
    oldParas.forEach(p => { const k = normalizePara(p); if (!oldNorms.has(k)) oldNorms.set(k, p); });
    const newNorms = new Map<string, string>();
    newParas.forEach(p => { const k = normalizePara(p); if (!newNorms.has(k)) newNorms.set(k, p); });

    const oldKeys = new Set(oldNorms.keys());
    const newKeys = new Set(newNorms.keys());
    const commonKeys = new Set([...oldKeys].filter(k => newKeys.has(k)));

    const addedParas = [...newKeys].filter(k => !oldKeys.has(k)).map(k => newNorms.get(k)!);
    const removedParas = [...oldKeys].filter(k => !newKeys.has(k)).map(k => oldNorms.get(k)!);
    const modifiedPairs: Array<{ old: string; new: string }> = [];
    const remainingAdded = [...addedParas];
    const remainingRemoved = [...removedParas];
    for (let i = remainingRemoved.length - 1; i >= 0; i--) {
      for (let j = remainingAdded.length - 1; j >= 0; j--) {
        const lineDiff = diffLines(stripMarkdown(remainingRemoved[i]), stripMarkdown(remainingAdded[j]));
        let lineChanges = 0;
        lineDiff.forEach(p => { if (p.added || p.removed) lineChanges += p.count || 0; });
        if (lineChanges > 0 && lineChanges <= 5) {
          modifiedPairs.push({ old: remainingRemoved[i], new: remainingAdded[j] });
          remainingRemoved.splice(i, 1);
          remainingAdded.splice(j, 1);
          break;
        }
      }
    }

    contentEl.innerHTML = '';
    if (commonKeys.size > 0) {
      const unchanged = document.createElement('div');
      unchanged.className = 'diff-line diff-line-unchanged';
      unchanged.textContent = `  ⏎ (${commonKeys.size} 个段落未变化)`;
      contentEl.appendChild(unchanged);
    }
    modifiedPairs.forEach(pair => {
      const lineDiff = diffLines(stripMarkdown(pair.old), stripMarkdown(pair.new));
      lineDiff.forEach(part => {
        const div = document.createElement('div');
        div.className = 'diff-line';
        if (part.added) {
          div.classList.add('diff-line-added');
          div.textContent = `+ ${part.value}`;
        } else if (part.removed) {
          div.classList.add('diff-line-removed');
          div.textContent = `- ${part.value}`;
        } else {
          div.classList.add('diff-line-unchanged');
          div.textContent = `  ${part.value}`;
        }
        contentEl.appendChild(div);
      });
    });
    remainingAdded.forEach(p => {
      const div = document.createElement('div');
      div.className = 'diff-line diff-line-added';
      div.textContent = `+ ${p}`;
      contentEl.appendChild(div);
    });
    remainingRemoved.forEach(p => {
      const div = document.createElement('div');
      div.className = 'diff-line diff-line-removed';
      div.textContent = `- ${p}`;
      contentEl.appendChild(div);
    });
  }
}

/** 左右对比展示新旧内容差异 */
async function showDiffCompare(n: ContentChangeNotification): Promise<void> {
  const modal = document.getElementById('diffCompareModal') as HTMLElement | null;
  if (!modal) return;
  const titleEl = document.getElementById('diffCompareTitle') as HTMLElement | null;
  const oldPane = document.getElementById('diffCompareOld') as HTMLElement | null;
  const newPane = document.getElementById('diffCompareNew') as HTMLElement | null;
  if (!oldPane || !newPane) return;
  if (titleEl) titleEl.textContent = `📄 ${n.title}`;

  const oldParas = splitParagraphs(n.oldContent);
  const newParas = splitParagraphs(n.newContent);
  oldPane.innerHTML = '<div class="diff-cmp-block-placeholder">正在语义分析...</div>';
  newPane.innerHTML = '<div class="diff-cmp-block-placeholder">正在语义分析...</div>';

  try {
    const resp = await new Promise<any>(r => {
      chrome.runtime.sendMessage({
        action: 'backendRequest',
        endpoint: '/api/embedding/compare',
        method: 'POST',
        body: { old_paragraphs: oldParas, new_paragraphs: newParas },
      }, (response) => {
        if (chrome.runtime.lastError) { r(null); return; }
        r(response);
      });
    });
    if (!resp?.ok || !resp.data) {
      fallbackDiffCompare(n, oldPane, newPane);
      modal.classList.remove('hidden');
      return;
    }
    const results = resp.data?.data || resp.data;
    const { matched_pairs, unmatched_old_indices, unmatched_new_indices } = results;
    interface Block { type: 'matched' | 'removed' | 'added' | 'empty'; content: string; sim?: number; pairOther?: string }
    const oldBlocks: Block[] = [];
    const newBlocks: Block[] = [];
    const newToBlock = new Map<number, number>();
    const oldToBlockCount = new Map<number, number>();
    for (let oi = 0; oi < oldParas.length; oi++) {
      const pairs = matched_pairs.filter((p: any) => p.old_index === oi);
      if (pairs.length > 0) {
        for (let pi = 0; pi < pairs.length; pi++) {
          const pair = pairs[pi];
          const ni = pair.new_index;
          if (pi === 0) {
            oldBlocks.push({ type: 'matched', content: oldParas[oi], sim: pair.similarity, pairOther: newParas[ni] });
            newToBlock.set(ni, newBlocks.length);
            newBlocks.push({ type: 'matched', content: newParas[ni], sim: pair.similarity, pairOther: oldParas[oi] });
          } else {
            oldBlocks.push({ type: 'empty', content: '' });
            newToBlock.set(ni, newBlocks.length);
            newBlocks.push({ type: 'matched', content: newParas[ni], sim: pair.similarity, pairOther: oldParas[oi] });
          }
        }
        oldToBlockCount.set(oi, pairs.length);
      } else if (unmatched_old_indices.includes(oi)) {
        oldBlocks.push({ type: 'removed', content: oldParas[oi] });
        newBlocks.push({ type: 'empty', content: '' });
        oldToBlockCount.set(oi, 1);
      }
    }
    const sortedUnmatched = [...unmatched_new_indices].sort((a, b) => a - b);
    for (const ni of sortedUnmatched) {
      if (newToBlock.has(ni)) continue;
      let anchorNewIdx = -1;
      for (const pair of matched_pairs) {
        if (pair.new_index < ni && pair.new_index > anchorNewIdx) {
          anchorNewIdx = pair.new_index;
        }
      }
      let insertAt = 0;
      if (anchorNewIdx >= 0) {
        const anchorPair = matched_pairs.find((p: any) => p.new_index === anchorNewIdx);
        if (anchorPair) {
          let blockCount = 0;
          for (let oi = 0; oi <= anchorPair.old_index; oi++) {
            blockCount += oldToBlockCount.get(oi) || 0;
          }
          insertAt = blockCount;
        }
      }
      oldBlocks.splice(insertAt, 0, { type: 'empty', content: '' });
      newBlocks.splice(insertAt, 0, { type: 'added', content: newParas[ni] });
    }
    renderBlocks(oldPane, oldBlocks, 'old');
    renderBlocks(newPane, newBlocks, 'new');
  } catch {
    fallbackDiffCompare(n, oldPane, newPane);
  }
  modal.classList.remove('hidden');
}

/** 渲染单个 pane 的 blocks */
function renderBlocks(container: HTMLElement, blocks: { type: string; content: string; sim?: number; pairOther?: string }[], paneType: 'old' | 'new'): void {
  container.innerHTML = '';
  for (const block of blocks) {
    const wrapper = document.createElement('div');
    wrapper.className = 'diff-cmp-block';
    const badge = document.createElement('div');
    badge.className = 'diff-cmp-block-badge';
    if (block.type === 'matched') {
      badge.classList.add('matched');
      badge.textContent = `🔗 语义相似 ${(block.sim! * 100).toFixed(0)}%`;
    } else if (block.type === 'removed') {
      badge.classList.add('removed');
      badge.textContent = '✕ 已删除';
    } else if (block.type === 'added') {
      badge.classList.add('added');
      badge.textContent = '✚ 已新增';
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'diff-cmp-block-placeholder';
      placeholder.textContent = '(无对应内容)';
      wrapper.appendChild(placeholder);
      container.appendChild(wrapper);
      continue;
    }
    wrapper.appendChild(badge);
    const contentDiv = document.createElement('div');
    contentDiv.className = 'diff-cmp-block-content';
    if (block.type === 'matched') {
      const oldText = paneType === 'old' ? block.content : (block.pairOther || block.content);
      const newText = paneType === 'new' ? block.content : (block.pairOther || block.content);
      const cleanOld = stripMarkdown(oldText);
      const cleanNew = stripMarkdown(newText);
      const diff = cleanOld === cleanNew ? [{ value: block.content, count: 1 }] : diffLines(oldText, newText);
      const paneIsNew = paneType === 'new';
      const { lines } = flattenDiffForPane(diff, paneIsNew);
      lines.forEach(line => {
        const div = document.createElement('div');
        div.className = 'diff-cmp-line';
        if (line.type === 'added') {
          div.classList.add('diff-cmp-line-added');
          div.innerHTML = `<span class="diff-cmp-line-marker">+</span><span class="diff-cmp-line-text">${escapeHtml(line.text)}</span>`;
        } else if (line.type === 'removed') {
          div.classList.add('diff-cmp-line-removed');
          div.innerHTML = `<span class="diff-cmp-line-marker">-</span><span class="diff-cmp-line-text">${escapeHtml(line.text)}</span>`;
        } else if (line.type === 'empty') {
          div.classList.add('diff-cmp-line-empty');
          div.textContent = '\u00A0';
        } else {
          div.classList.add('diff-cmp-line-unchanged');
          div.textContent = `  ${line.text}`;
        }
        contentDiv.appendChild(div);
      });
    } else {
      const lines = block.content.split('\n');
      const lineType = block.type === 'removed' ? 'removed' : 'added';
      lines.forEach(line => {
        if (!line && lines.length > 1) return;
        const div = document.createElement('div');
        div.className = `diff-cmp-line diff-cmp-line-${lineType}`;
        div.innerHTML = `<span class="diff-cmp-line-marker">${block.type === 'removed' ? '-' : '+'}</span><span class="diff-cmp-line-text">${escapeHtml(line)}</span>`;
        contentDiv.appendChild(div);
      });
    }
    wrapper.appendChild(contentDiv);
    container.appendChild(wrapper);
  }
}

/** 将 diffLines 输出展平为对齐的行列表 */
function flattenDiffForPane(diff: { added?: boolean; removed?: boolean; value: string; count?: number }[], paneIsNew: boolean): { lines: DiffLine[], swapMarkers: boolean } {
  const lines: DiffLine[] = [];
  diff.forEach(part => {
    const rawLines = part.value.split('\n');
    if (rawLines[rawLines.length - 1] === '') rawLines.pop();
    if (part.added) {
      rawLines.forEach((line: string) => {
        if (paneIsNew) lines.push({ text: line, type: 'added' });
        else lines.push({ text: '', type: 'empty' });
      });
    } else if (part.removed) {
      rawLines.forEach((line: string) => {
        if (paneIsNew) lines.push({ text: '', type: 'empty' });
        else lines.push({ text: line, type: 'removed' });
      });
    } else {
      rawLines.forEach((line: string) => {
        lines.push({ text: line, type: 'unchanged' });
      });
    }
  });
  return { lines, swapMarkers: false };
}

/** fallback：使用全文行级 diff（当 embedding 不可用时） */
function fallbackDiffCompare(n: ContentChangeNotification, oldPane: HTMLElement, newPane: HTMLElement): void {
  const diff = diffLines(n.oldContent, n.newContent);
  const oldResult = flattenDiffForPane(diff, false).lines;
  const newResult = flattenDiffForPane(diff, true).lines;
  function render(container: HTMLElement, lines: DiffLine[]): void {
    container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'diff-cmp-block';
    lines.forEach((line) => {
      const div = document.createElement('div');
      div.className = 'diff-cmp-line';
      if (line.type === 'added') {
        div.classList.add('diff-cmp-line-added');
        div.innerHTML = `<span class="diff-cmp-line-marker">+</span><span class="diff-cmp-line-text">${escapeHtml(line.text)}</span>`;
      } else if (line.type === 'removed') {
        div.classList.add('diff-cmp-line-removed');
        div.innerHTML = `<span class="diff-cmp-line-marker">-</span><span class="diff-cmp-line-text">${escapeHtml(line.text)}</span>`;
      } else if (line.type === 'empty') {
        div.classList.add('diff-cmp-line-empty');
        div.textContent = '\u00A0';
      } else {
        div.classList.add('diff-cmp-line-unchanged');
        div.textContent = `  ${line.text}`;
      }
      wrapper.appendChild(div);
    });
    container.appendChild(wrapper);
  }
  render(oldPane, oldResult);
  render(newPane, newResult);
}

/** 定时检测 */
async function startCheckAlarm(): Promise<void> {
  await new Promise<void>(r => chrome.runtime.sendMessage({
    action: 'startContentCheck',
    mode: checkConfig.mode,
    intervalMinutes: checkConfig.intervalMinutes,
    dailyTime: checkConfig.dailyTime
  }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } r(); }));
}

async function stopCheckAlarm(): Promise<void> {
  await new Promise<void>(r => chrome.runtime.sendMessage({ action: 'stopContentCheck' }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } r(); }));
}

async function saveCheckConfig(newConfig: Partial<CheckConfig>): Promise<void> {
  checkConfig = { ...checkConfig, ...newConfig };
  try {
    await chrome.storage.local.set({ [CHECK_CONFIG_KEY]: checkConfig });
  } catch (_) {}
  const enabled = checkConfig.mode === 'interval' ? checkConfig.intervalMinutes > 0 : !!checkConfig.dailyTime;
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
      checkConfig = { mode: 'interval', intervalMinutes: data.checkIntervalMinutes, dailyTime: '09:00' };
      await chrome.storage.local.set({ [CHECK_CONFIG_KEY]: checkConfig });
    }
    const enabled = checkConfig.mode === 'interval' ? checkConfig.intervalMinutes > 0 : !!checkConfig.dailyTime;
    if (enabled) {
      await startCheckAlarm();
    }
  } catch (_) {}
}

// ===== IndexedDB 持久化 =====
const DB_NAME = 'KnowSeek';
const DB_VERSION = 1;
const STORE_NAME = 'subscriptions';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getStoredSources(): Promise<string[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const get = store.get('sources');
      get.onsuccess = () => {
        resolve(get.result?.value ?? []);
      };
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return [];
  }
}

async function saveSources(sources: string[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ id: 'sources', value: sources });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

/** 从 chrome.storage 加载 RSSHub 基础 URL */
async function loadRSSHubBaseUrl(): Promise<void> {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.RSSHUB_BASE_URL);
    const stored = data[STORAGE_KEYS.RSSHUB_BASE_URL];
    if (stored && typeof stored === 'string' && stored.trim()) {
      RSSHUB_BASE = stored.trim().replace(/\/+$/, ''); // 去掉尾部斜杠
    } else {
      RSSHUB_BASE = DEFAULT_RSSHUB_BASE;
    }
  } catch {
    RSSHUB_BASE = DEFAULT_RSSHUB_BASE;
  }
}

/** 保存 RSSHub 基础 URL 到 chrome.storage */
async function saveRSSHubBaseUrl(url: string): Promise<void> {
  const oldBase = RSSHUB_BASE;
  const clean = url.trim().replace(/\/+$/, '') || DEFAULT_RSSHUB_BASE;
  RSSHUB_BASE = clean;
  await chrome.storage.local.set({ [STORAGE_KEYS.RSSHUB_BASE_URL]: clean });
  console.log('[saveRSSHubBaseUrl]', { oldBase, clean, RSSHUB_BASE });

  // 更新已存储的订阅源 URL，将旧 base 替换为新 base
  try {
    let sources = await getStoredSources();
    console.log('[saveRSSHubBaseUrl] sources from DB:', sources);
    if (sources.length === 0) {
      // 如果 IndexedDB 中没有存储的订阅源，用硬编码默认值作为后备
      sources = [...RSSHUB_SOURCES];
      console.log('[saveRSSHubBaseUrl] fallback to RSSHUB_SOURCES:', sources);
    }
    // 从存储的源 URL 中提取实际的基础地址进行替换，不依赖 RSSHUB_BASE
    const updated = sources.map(s => {
      try {
        const u = new URL(s);
        const sourceBase = `${u.protocol}//${u.host}`;
        if (sourceBase !== clean) {
          return s.replace(sourceBase, clean);
        }
        return s;
      } catch {
        // 如果 URL 解析失败，尝试用 oldBase 替换
        if (oldBase !== clean) return s.replace(oldBase, clean);
        return s;
      }
    });
    console.log('[saveRSSHubBaseUrl] updated sources:', updated);
    await saveSources(updated);
    console.log('[saveRSSHubBaseUrl] saved successfully');
    // 基础 URL 变更，清空缓存
    await clearFeedCache();
    console.log('[saveRSSHubBaseUrl] cache cleared');
  } catch (e) {
    console.error('[saveRSSHubBaseUrl] error:', e);
  }
}

/** 从 chrome.storage 加载动态显示天数 */
async function loadFeedMaxDays(): Promise<void> {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.FEED_MAX_DAYS);
    const stored = data[STORAGE_KEYS.FEED_MAX_DAYS];
    const days = parseInt(stored, 10);
    FEED_MAX_DAYS = (days >= 1 && days <= 30) ? days : DEFAULT_FEED_MAX_DAYS;
  } catch {
    FEED_MAX_DAYS = DEFAULT_FEED_MAX_DAYS;
  }
}

/** 保存动态显示天数 */
async function saveFeedMaxDays(days: number): Promise<void> {
  const clamped = Math.max(1, Math.min(30, days));
  FEED_MAX_DAYS = clamped;
  await chrome.storage.local.set({ [STORAGE_KEYS.FEED_MAX_DAYS]: clamped });
}

/** RSS 动态缓存（持久化存储，不自动刷新） */
interface FeedCache {
  [route: string]: {
    items: FeedItem[];
    fetchedAt: number;
    bloggerName?: string;
  };
}

async function getFeedCache(): Promise<FeedCache> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const get = store.get('rss_cache');
      get.onsuccess = () => resolve(get.result?.value ?? {});
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return {};
  }
}

async function saveFeedCache(cache: FeedCache): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ id: 'rss_cache', value: cache });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

async function clearFeedCache(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete('rss_cache');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}

// ===== RSSHub 数据源 =====
interface Blogger {
  id: string;
  name: string;
  platform: string;
  avatar: string;
  rsshubRoute: string;
}

interface FeedItem {
  title: string;
  link: string;
  pubDate: string;
}

/** 从 RSSHub 路由中提取平台和 ID */
function parseRSSHubRoute(route: string): { platform: string; id: string } {
  const parts = route.split('/').filter(Boolean);
  const platform = parts[0] || 'unknown';
  const id = parts[parts.length - 1] || 'unknown';
  return { platform, id };
}

/** 为订阅源 URL 列表补充平台和作者信息（用于导出） */
async function enrichSourcesWithMeta(sources: string[]): Promise<Array<{ url: string; platform: string; author: string }>> {
  return Promise.all(sources.map(async (url) => {
    let route: string;
    try {
      route = new URL(url).pathname;
    } catch {
      route = '/unknown';
    }
    const { platform } = parseRSSHubRoute(route);
    // 优先从已缓存的 bloggers 中取作者名，避免重复请求
    const blogger = bloggers.find(b => b.rsshubRoute === route);
    const author = blogger?.name || await fetchBloggerName(route);
    return { url, platform, author: author || platform };
  }));
}

/** 通过后端代理请求 RSSHub（后端不受 CORS 限制） */
async function rssFetch(url: string): Promise<{ ok: boolean; status: number; data?: any; error?: string }> {
  try {
    const { backend_url = 'http://localhost:8765' } = await chrome.storage.local.get('backend_url');
    const baseUrl = (backend_url as string).replace(/\/+$/, '');
    const resp = await fetch(`${baseUrl}/api/rss-proxy?url=${encodeURIComponent(url)}`);
    const data = await resp.json();
    return { ok: resp.ok, status: resp.status, data };
  } catch (err: any) {
    return { ok: false, status: 0, error: err.message };
  }
}

/** 从 RSSHub 获取博主名称 */
async function fetchBloggerName(route: string): Promise<string> {
  // 检查缓存
  const cache = await getFeedCache();
  if (cache[route]?.bloggerName) {
    return cache[route].bloggerName!;
  }
  try {
    const res = await rssFetch(`${RSSHUB_BASE}${route}?format=json`);
    if (!res.ok) return '';
    const data = res.data;
    let name = '';
    if (data.items?.[0]?.authors?.[0]?.name) {
      name = data.items[0].authors[0].name;
    } else if (data.title) {
      name = data.title.replace(/的\s*\w+\s*动态$/, '').trim();
    }
    // 写入缓存
    if (name) {
      const newCache = await getFeedCache();
      newCache[route] = { ...(newCache[route] || { items: [], fetchedAt: 0 }), bloggerName: name };
      await saveFeedCache(newCache);
    }
    return name;
  } catch {
    return '';
  }
}

/** 从 RSSHub URL 自动创建 Blogger 配置 */
async function createBloggerFromRSSHub(fullUrl: string): Promise<Blogger> {
  let route: string;
  try {
    route = new URL(fullUrl).pathname; // 只取路径部分，如 /bilibili/user/dynamic/625267185
  } catch {
    route = '/unknown';
  }
  const { platform, id } = parseRSSHubRoute(route);
  const name = await fetchBloggerName(route);
  return {
    id: `${platform}_${id}`,
    name: name || `${platform}_${id}`,
    platform,
    avatar: '📡',
    rsshubRoute: route,
  };
}

const RSSHUB_SOURCES = [
  'http://localhost:8080/bilibili/user/dynamic/625267185',
  'http://localhost:8080/bilibili/user/dynamic/3706929260006322',
  'http://localhost:8080/bilibili/user/dynamic/316183842',
  'http://localhost:8080/bilibili/user/dynamic/12890453',
];

// 运行时初始化的博主列表
let bloggers: Blogger[] = [];

/** 初始化博主列表（异步） */
async function initBloggers(): Promise<void> {
  let stored = await getStoredSources();
  console.log('[initBloggers] stored sources:', stored);
  let sources: string[];
  if (stored.length > 0) {
    sources = stored;
  } else {
    // 首次初始化：保存默认订阅源到 IndexedDB
    sources = [...RSSHUB_SOURCES];
    await saveSources(sources);
    console.log('[initBloggers] saved default sources:', sources);
  }
  bloggers = await Promise.all(sources.map(url => createBloggerFromRSSHub(url)));
  console.log('[initBloggers] bloggers created:', bloggers.length);
}

/** 格式化相对时间 */
function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  if (isNaN(date)) return '';
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return new Date(dateStr).toLocaleDateString('zh-CN');
}

/** 从 RSSHub 获取某个路由的 feed */
async function fetchRSSHubFeed(route: string): Promise<FeedItem[]> {
  try {
    const res = await rssFetch(`${RSSHUB_BASE}${route}?format=json`);
    if (!res.ok) {
      console.warn(`RSSHub fetch failed: ${res.status} for ${route}`);
      return [];
    }
    const data = res.data;
    if (data.error) {
      console.warn(`RSSHub error for ${route}:`, data.error.message);
      return [];
    }
    const cutoff = Date.now() - FEED_MAX_DAYS * 24 * 60 * 60 * 1000;
    return (data.items || [])
      .filter((item: any) => {
        const pubDate = item.pubDate || item.date_published;
        if (!pubDate) return true;
        const t = new Date(pubDate).getTime();
        return !isNaN(t) && t >= cutoff;
      })
      .slice(0, 5).map((item: any) => ({
        title: item.title || '无标题',
        link: item.link || item.url || '',
        pubDate: item.pubDate || item.date_published || '',
      }));
  } catch (err) {
    console.warn(`RSSHub fetch error for ${route}:`, err);
    return [];
  }
}

/** 获取 feed（从缓存读取，不触发网络请求） */
async function getFeed(route: string): Promise<FeedItem[]> {
  const cache = await getFeedCache();
  return cache[route]?.items || [];
}

/** 刷新所有博主动态（网络请求 → 更新缓存 → 返回数据） */
async function refreshAllFeeds(): Promise<{ allFeed: { blogger: Blogger; item: FeedItem }[]; feedErrors: { blogger: Blogger; error: string }[] }> {
  const allFeed: { blogger: Blogger; item: FeedItem }[] = [];
  const feedErrors: { blogger: Blogger; error: string }[] = [];
  const cache: FeedCache = {};

  const promises = bloggers.map(async (blogger) => {
    try {
      const items = await fetchRSSHubFeed(blogger.rsshubRoute);
      cache[blogger.rsshubRoute] = { items, fetchedAt: Date.now() };
      if (items.length === 0) {
        feedErrors.push({ blogger, error: '暂无动态' });
      } else {
        for (const item of items) {
          allFeed.push({ blogger, item });
        }
      }
    } catch {
      feedErrors.push({ blogger, error: '获取失败' });
    }
  });

  await Promise.all(promises);
  await saveFeedCache(cache);
  return { allFeed, feedErrors };
}

let records = [];
let activeTab: 'pages' | 'subscription' | 'notification' = 'pages';

init();

async function init() {
  const { theme = 'dark' } = await chrome.storage.sync.get('theme');
  document.documentElement.setAttribute('data-theme', theme);

  const data = await chrome.storage.local.get([
    STORAGE_KEYS.RECORDS,
  ]);
  records = data[STORAGE_KEYS.RECORDS] || [];

  // 加载 RSSHub 基础 URL
  await loadRSSHubBaseUrl();

  // 加载动态显示天数
  await loadFeedMaxDays();

  // 初始化博主列表（延迟到首次打开动态标签时执行）
  // 不阻塞首次渲染

  // 标签切换
  const tabBar = document.getElementById('tabBar');
  if (tabBar) {
    tabBar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.tab-btn') as HTMLElement | null;
      if (!btn) return;
      const tab = btn.dataset.tab as 'pages' | 'subscription' | 'notification';
      if (tab === activeTab) return;
      activeTab = tab;
      tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTabContent(activeTab);
    });
  }

  // 初始统计
  updateStats('pages');

  document.getElementById('openSidebarBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.sidePanel.open({ windowId: tab.windowId });
      window.close();
    }
  });

  // 加载通知配置和通知列表
  await loadCheckConfig();
  await loadNotificationsFromStorage();

  // 通知系统事件监听现在在 renderNotificationTab 中通过 bindNotificationEvents 绑定

  // 定时轮询通知列表
  setInterval(() => {
    loadNotificationsFromStorage();
  }, 5000);

  // 监听 chrome.runtime 消息
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'contentChangeDetected') {
      loadNotificationsFromStorage();
    }
  });

  // 监听 storage 变化
  chrome.storage.onChanged.addListener((changes) => {
    if (changes._contentChangeNotifications) {
      contentNotifications = changes._contentChangeNotifications.newValue || [];
      updateNotificationBadge();
    }
  });

  // 初始渲染
  renderTabContent('pages');
}

// ===== 标签内容渲染 =====
function renderTabContent(tab: 'pages' | 'subscription' | 'notification'): void {
  const content = document.getElementById('tabContent');
  if (!content) return;

  if (tab === 'pages') {
    updateStats('pages');
    renderPagesTab(content);
  } else if (tab === 'notification') {
    renderNotificationTab(content);
  } else {
    renderSubscriptionTab(content);
  }
}

/** 渲染通知中心标签页内容 */
function renderNotificationTab(container: HTMLElement): void {
  // 显示通知统计
  updateStats('notification');

  // 构建通知面板 HTML
  container.innerHTML = `
    <div class="notif-panel">
      <div class="notif-panel-actions">
        <button id="notifSettingsBtn" class="notif-icon-btn" data-notif-action="toggle-settings" title="检测间隔设置">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
        <button id="notifClearBtn" class="notif-clear-btn" data-notif-action="clear-notifications">清空全部</button>
      </div>
      <div id="notifSettingsPanel" class="notif-settings hidden">
        <div class="notif-settings-label">检测模式</div>
        <div class="notif-settings-options" id="checkModeOptions">
          <button class="interval-option" data-notif-action="mode" data-mode="interval">间隔检测</button>
          <button class="interval-option" data-notif-action="mode" data-mode="daily">每天定时</button>
        </div>
        <div id="intervalOptionsContainer">
          <div class="notif-settings-label">自动检测间隔</div>
          <div class="notif-settings-options" id="intervalOptions">
            <button class="interval-option" data-notif-action="interval" data-minutes="0">停用</button>
            <button class="interval-option" data-notif-action="interval" data-minutes="5">5分钟</button>
            <button class="interval-option" data-notif-action="interval" data-minutes="15">15分钟</button>
            <button class="interval-option" data-notif-action="interval" data-minutes="30">30分钟</button>
            <button class="interval-option" data-notif-action="interval" data-minutes="60">1小时</button>
          </div>
        </div>
        <div id="dailyTimeContainer" class="hidden">
          <div class="notif-settings-label">每天定时检测</div>
          <div class="daily-time-row">
            <input type="time" id="dailyTimeInput" value="09:00">
            <button class="interval-option" id="dailyTimeSaveBtn" data-notif-action="save-daily-time">保存</button>
            <button class="interval-option" id="dailyTimeOffBtn" data-notif-action="off-daily-time">停用定时</button>
          </div>
        </div>
      </div>
      <div class="notif-list" id="notifList"></div>
    </div>
  `;

  // 渲染通知列表
  const list = document.getElementById('notifList');
  if (list) renderNotificationList(list);

  // 在 HTML 渲染后重新绑定事件监听（因为 setupNotificationListeners 在 init 中执行时通知 tab 还未渲染）
  bindNotificationEvents();
}

/** 绑定通知中心的事件监听（事件委托模式，不会破坏已有监听器） */
let _notifDelegated = false;
let _cdDelegated = false;
let _diffDelegated = false;

function bindNotificationEvents(): void {
  // ── 通知面板事件委托 ──
  const panel = document.querySelector('.notif-panel');
  if (panel && !_notifDelegated) {
    _notifDelegated = true;
    panel.addEventListener('click', (e: Event) => {
      const target = (e.target as HTMLElement).closest('[data-notif-action]') as HTMLElement | null;
      if (!target) return;
      const action = target.dataset.notifAction;
      e.stopPropagation();

      if (action === 'toggle-settings') {
        const settingsPanel = document.getElementById('notifSettingsPanel');
        const list = document.getElementById('notifList');
        if (settingsPanel) {
          const willShow = settingsPanel.classList.contains('hidden');
          settingsPanel.classList.toggle('hidden');
          if (list) list.classList.toggle('hidden', willShow);
        }
        return;
      }

      if (action === 'mode') {
        const mode = target.dataset.mode as 'interval' | 'daily';
        target.closest('#checkModeOptions')?.querySelectorAll('.interval-option').forEach(b => b.classList.remove('active'));
        target.classList.add('active');
        const intervalContainer = document.getElementById('intervalOptionsContainer');
        const dailyContainer = document.getElementById('dailyTimeContainer');
        if (intervalContainer) intervalContainer.classList.toggle('hidden', mode !== 'interval');
        if (dailyContainer) dailyContainer.classList.toggle('hidden', mode !== 'daily');
        saveCheckConfig({ mode });
        return;
      }

      if (action === 'interval') {
        const minutes = parseInt(target.dataset.minutes || '0', 10);
        target.closest('#intervalOptions')?.querySelectorAll('.interval-option').forEach(b => b.classList.remove('active'));
        target.classList.add('active');
        saveCheckConfig({ intervalMinutes: minutes });
        document.getElementById('notifSettingsPanel')?.classList.add('hidden');
        document.getElementById('notifList')?.classList.remove('hidden');
        return;
      }

      if (action === 'save-daily-time') {
        const time = (document.getElementById('dailyTimeInput') as HTMLInputElement | null)?.value;
        if (!time) return;
        saveCheckConfig({ dailyTime: time });
        document.getElementById('notifSettingsPanel')?.classList.add('hidden');
        document.getElementById('notifList')?.classList.remove('hidden');
        return;
      }

      if (action === 'off-daily-time') {
        saveCheckConfig({ dailyTime: '' });
        document.getElementById('notifSettingsPanel')?.classList.add('hidden');
        document.getElementById('notifList')?.classList.remove('hidden');
        return;
      }

      if (action === 'clear-notifications') {
        contentNotifications = [];
        updateNotificationBadge();
        chrome.runtime.sendMessage({ action: 'clearNotifications' }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
        saveNotificationsToStorage();
        const list = document.getElementById('notifList');
        if (list) renderNotificationList(list);
        return;
      }
    });
  }

  // ── 变更详情弹窗事件委托 ──
  const cdModal = document.getElementById('changeDetailModal');
  if (cdModal && !_cdDelegated) {
    _cdDelegated = true;
    cdModal.addEventListener('click', async (e: Event) => {
      const target = e.target as HTMLElement;

      // 关闭（背景点击或关闭按钮）
      if (target === cdModal || target.closest('[data-cd-close]')) {
        cdModal.classList.add('hidden');
        return;
      }

      // 忽略按钮
      if (target.closest('#changeDetailIgnoreBtn')) {
        const url = (document.getElementById('changeDetailIgnoreBtn') as HTMLElement | null)?.dataset.url;
        if (!url) return;
        contentNotifications = contentNotifications.filter(n => n.url !== url);
        await saveNotificationsToStorage();
        renderNotificationTab(document.getElementById('tabContent')!);
        cdModal.classList.add('hidden');
        return;
      }

      // 详情按钮
      if (target.closest('#changeDetailCompareBtn')) {
        const url = (document.getElementById('changeDetailCompareBtn') as HTMLElement | null)?.dataset.url;
        if (!url) return;
        const n = contentNotifications.find(notif => notif.url === url);
        if (n) {
          await chrome.storage.local.set({ _diffCompareData: n });
          cdModal.classList.add('hidden');
          const diffUrl = chrome.runtime.getURL('/diff-compare.html');
          await chrome.tabs.create({ url: diffUrl, active: true });
          window.close();
        }
        return;
      }

      // 保存更新按钮
      if (target.closest('#changeDetailSaveBtn')) {
        const url = (document.getElementById('changeDetailSaveBtn') as HTMLElement | null)?.dataset.url;
        if (!url) return;
        const n = contentNotifications.find(notif => notif.url === url);
        if (n) {
          await saveSnapshot({
            url,
            title: n.title,
            content: n.newContent,
            type: n.type,
            stats: { charCount: n.newContent.length, paraCount: n.newContent.split('\n').length },
            savedAt: n.detectedAt,
            updatedAt: Date.now(),
            recordIds: []
          });
          try {
            await chrome.runtime.sendMessage({ action: 'updateEmbedding', url, title: n.title, content: n.newContent, type: n.type });
          } catch (_) { /* 忽略 */ }
          contentNotifications = contentNotifications.filter(notif => notif.url !== url);
          await saveNotificationsToStorage();
          renderNotificationTab(document.getElementById('tabContent')!);
          cdModal.classList.add('hidden');
        }
        return;
      }
    });
  }

  // ── 左右对比弹窗事件委托 ──
  const diffModal = document.getElementById('diffCompareModal');
  if (diffModal && !_diffDelegated) {
    _diffDelegated = true;
    diffModal.addEventListener('click', (e: Event) => {
      const target = e.target as HTMLElement;
      if (target === diffModal || target.closest('[data-diff-close]')) {
        diffModal.classList.add('hidden');
      }
    });
  }
}

/** @deprecated 事件绑定已移至 bindNotificationEvents，在 renderNotificationTab 中调用 */

/** 清除某 URL 对应的内容变更通知 */
async function clearNotificationsForUrl(url: string): Promise<void> {
  if (!url) return;
  const before = contentNotifications.length;
  contentNotifications = contentNotifications.filter(n => n.url !== url);
  if (contentNotifications.length === before) return;
  updateNotificationBadge();
  await saveNotificationsToStorage();
}

/** 更新统计卡片 */
function updateStats(mode: 'pages' | 'subscription' | 'notification', counts?: { total: number; read: number; unread: number }): void {
  const el = document.querySelector('.stats-card');
  if (!el) return;
  if (mode === 'notification') {
    const total = contentNotifications.length;
    const unread = contentNotifications.filter(n => !n.read).length;
    const read = total - unread;
    el.innerHTML = `
      <div class="stats-row">
        <div class="stat-block">
          <span class="stat-value">${total}</span>
          <span class="stat-label">总变更</span>
        </div>
        <div class="stat-block">
          <span class="stat-value">${read}</span>
          <span class="stat-label">已读</span>
        </div>
        <div class="stat-block">
          <span class="stat-value">${unread}</span>
          <span class="stat-label">未读</span>
        </div>
      </div>
    `;
  } else if (mode === 'subscription' && counts) {
    el.innerHTML = `
      <div class="stats-row">
        <div class="stat-block">
          <span class="stat-value">${counts.total}</span>
          <span class="stat-label">总动态</span>
        </div>
        <div class="stat-block">
          <span class="stat-value">${counts.read}</span>
          <span class="stat-label">已读</span>
        </div>
        <div class="stat-block">
          <span class="stat-value">${counts.unread}</span>
          <span class="stat-label">未读</span>
        </div>
      </div>
    `;
  } else {
    el.innerHTML = `
      <div class="stats-row">
        <div class="stat-block">
          <span class="stat-value">${records.length}</span>
          <span class="stat-label">条标注</span>
        </div>
        <div class="stat-block">
          <span class="stat-value">${new Set(records.filter(r => r.url).map(r => r.url)).size}</span>
          <span class="stat-label">个页面</span>
        </div>
        <div class="stat-block">
          <span class="stat-value">${new Set(records.map(r => { try { return new URL(r.url).hostname; } catch { return null; } }).filter(Boolean)).size}</span>
          <span class="stat-label">个网站</span>
        </div>
      </div>
    `;
  }
}

// ===== 最近标注标签 =====
function renderPagesTab(container: HTMLElement): void {
  const pageMap = new Map();
  for (const r of records) {
    if (!r.url) continue;
    if (!pageMap.has(r.url)) {
      pageMap.set(r.url, { url: r.url, title: r.page_title || r.url, count: 0, lastTime: 0 });
    }
    const entry = pageMap.get(r.url);
    entry.count++;
    if (r.created_at > entry.lastTime) {
      entry.lastTime = r.created_at;
      if (r.page_title) entry.title = r.page_title;
    }
  }

  const pages = Array.from(pageMap.values())
    .sort((a, b) => b.lastTime - a.lastTime)
    .slice(0, 5);

  if (pages.length === 0) {
    container.innerHTML = '<div class="empty-state">还没有标注，快去标记吧</div>';
    return;
  }

  container.innerHTML = `<div class="page-list">${pages.map(p => {
    let hostname = '';
    try { hostname = new URL(p.url).hostname; } catch {}
    return `
      <div class="page-item" data-url="${p.url.replace(/"/g, '&quot;')}">
        <img class="page-favicon" src="https://${hostname}/favicon.ico" alt="" loading="lazy">
        <span class="page-name" title="${p.title.replace(/"/g, '&quot;')}">${p.title}</span>
        <span class="page-count">${p.count}</span>
      </div>
    `;
  }).join('')}</div>`;

  container.querySelectorAll('.page-item').forEach(el => {
    el.addEventListener('click', () => {
      const url = (el as HTMLElement).dataset.url;
      if (url) { chrome.tabs.update({ url }); window.close(); }
    });
  });
  container.querySelectorAll('.page-favicon').forEach(img => {
    img.addEventListener('error', () => { (img as HTMLElement).style.display = 'none'; });
  });
}

// ===== 订阅动态标签（RSSHub 数据源） =====
async function renderSubscriptionTab(container: HTMLElement): Promise<void> {
  // 确保博主列表已初始化
  if (bloggers.length === 0) {
    container.innerHTML = '<div class="sub-loading">📡 正在获取订阅配置...</div>';
    await initBloggers();
  }

  // 加载已读/忽略状态
  const statusData = (await chrome.storage.local.get(STORAGE_KEYS.READ_STATUS))[STORAGE_KEYS.READ_STATUS] || {};
  const readStatus: Record<string, { read: boolean; ignored: boolean }> = statusData;

  // 从缓存加载（不触发网络请求）
  const cache = await getFeedCache();
  const allFeed: { blogger: Blogger; item: FeedItem }[] = [];
  const feedErrors: { blogger: Blogger; error: string }[] = [];

  let hasCache = false;
  for (const blogger of bloggers) {
    const cached = cache[blogger.rsshubRoute];
    if (cached?.items?.length) {
      hasCache = true;
      for (const item of cached.items) {
        allFeed.push({ blogger, item });
      }
    } else {
      feedErrors.push({ blogger, error: '暂无动态' });
    }
  }

  if (!hasCache) {
    // 无缓存数据，显示空状态 + 刷新/设置按钮
    container.innerHTML = `
      <div class="sub-card" style="position:relative">
        <button class="sub-settings-btn" id="subSettingsBtn" title="订阅管理">⚙️</button>
        <button class="sub-refresh-btn" id="subRefreshBtn" title="刷新动态">🔄 刷新</button>
        <div class="sub-empty-hint">暂无缓存数据，点击刷新获取最新动态</div>
      </div>
    `;
    const settingsBtn = container.querySelector('#subSettingsBtn') as HTMLElement | null;
    settingsBtn?.addEventListener('click', () => renderSubscriptionSettings(container));
    const refreshBtn = container.querySelector('#subRefreshBtn') as HTMLElement | null;
    refreshBtn?.addEventListener('click', async () => {
      container.innerHTML = '<div class="sub-loading">📡 正在刷新...</div>';
      await refreshAllFeeds();
      await renderSubscriptionTab(container);
    });
    return;
  }

  // 按 pubDate 排序
  allFeed.sort((a, b) => {
    const da = new Date(a.item.pubDate).getTime();
    const db = new Date(b.item.pubDate).getTime();
    if (isNaN(da) && isNaN(db)) return 0;
    if (isNaN(da)) return 1;
    if (isNaN(db)) return -1;
    return db - da;
  });

  // 统计已读/未读
  let totalCount = 0, readCount = 0, unreadCount = 0;
  for (const { item } of allFeed) {
    if (readStatus[item.link]?.ignored) continue;
    totalCount++;
    if (readStatus[item.link]?.read) readCount++;
    else unreadCount++;
  }
  updateStats('subscription', { total: totalCount, read: readCount, unread: unreadCount });

  // 过滤掉被忽略的动态
  const visibleFeed = allFeed.filter(({ item }) => !readStatus[item.link]?.ignored);

  // 按博主分组
  const grouped = new Map<string, { blogger: Blogger; items: FeedItem[] }>();
  for (const { blogger, item } of visibleFeed) {
    if (!grouped.has(blogger.id)) {
      grouped.set(blogger.id, { blogger, items: [] });
    }
    grouped.get(blogger.id)!.items.push(item);
  }

  // 错误也分组
  const errorMap = new Map<string, string>();
  for (const { blogger, error } of feedErrors) {
    if (!errorMap.has(blogger.id)) {
      errorMap.set(blogger.id, error);
    }
  }

  const bloggerEntries = Array.from(grouped.entries());
  const errorEntries = Array.from(errorMap.entries());

  container.innerHTML = `
    <div class="sub-card" style="position:relative">
      <button class="sub-settings-btn" id="subSettingsBtn" title="订阅管理">⚙️</button>
      <button class="sub-refresh-btn" id="subRefreshBtn" title="刷新动态">🔄 刷新</button>
      ${bloggerEntries.length > 0 ? `
        <div class="sub-feed">
          ${bloggerEntries.map(([id, { blogger, items }]) => {
            const first = items[0];
            const moreCount = items.length - 1;
            const isUnread = !readStatus[first.link]?.read;
            return `
              <div class="sub-blogger-block">
                <div class="sub-blogger-row">
                  <span class="sub-feed-icon">${blogger.avatar}</span>
                  <span class="sub-blogger-name">${blogger.name}</span>
                  <span class="sub-badge">${blogger.platform}</span>
                </div>
                <div class="sub-feed-item ${isUnread ? 'sub-feed-item--unread' : ''}" data-url="${first.link}">
                  <div class="sub-feed-body">
                    <div class="sub-feed-title" title="${escapeHtml(first.title)}">${isUnread ? '<span class="sub-unread-dot">●</span> ' : ''}${first.title}</div>
                    <div class="sub-feed-time">${timeAgo(first.pubDate)}</div>
                  </div>
                </div>
                ${moreCount > 0 ? `
                  <div class="sub-more-link" data-blogger-id="${id}">more +${moreCount}</div>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      ` : errorEntries.length > 0 ? `
        <div class="sub-feed">
          ${errorEntries.map(([id, error]) => {
            const blogger = bloggers.find(b => b.id === id)!;
            return `
              <div class="sub-blogger-block">
                <div class="sub-blogger-row">
                  <span class="sub-feed-icon">${blogger.avatar}</span>
                  <span class="sub-blogger-name">${blogger.name}</span>
                  <span class="sub-badge">${blogger.platform}</span>
                </div>
                <div class="sub-feed-item sub-feed-item--error">
                  <div class="sub-feed-body">
                    <div class="sub-feed-title">${error}</div>
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      ` : `
        <div class="sub-empty-hint">暂无动态，博主可能近期未发布内容</div>
      `}
    </div>

    <!-- 更多动态弹窗 -->
    <div class="sub-modal-overlay" id="subModal" style="display:none">
      <div class="sub-modal">
        <div class="sub-modal-header">
          <span class="sub-modal-title" id="subModalTitle"></span>
          <button class="sub-modal-close" id="subModalClose">&times;</button>
        </div>
        <div class="sub-modal-body" id="subModalBody"></div>
      </div>
    </div>
  `;

  // 点击某个动态 → 标记已读 + 打开
  container.querySelectorAll('.sub-feed-item:not(.sub-feed-item--error)').forEach(el => {
    el.addEventListener('click', () => {
      const url = (el as HTMLElement).dataset.url;
      if (!url) return;
      if (readStatus[url]) {
        readStatus[url].read = true;
        chrome.storage.local.set({ [STORAGE_KEYS.READ_STATUS]: readStatus }).catch(() => {});
      }
      chrome.tabs.create({ url });
      window.close();
    });
  });

  // 点击 more 展开弹窗
  const modalOverlay = container.querySelector('#subModal') as HTMLElement;
  const modalTitle = container.querySelector('#subModalTitle') as HTMLElement;
  const modalBody = container.querySelector('#subModalBody') as HTMLElement;
  const modalClose = container.querySelector('#subModalClose') as HTMLElement;

  container.querySelectorAll('.sub-more-link').forEach(el => {
    el.addEventListener('click', () => {
      const bloggerId = (el as HTMLElement).dataset.bloggerId;
      const entry = grouped.get(bloggerId!);
      if (!entry) return;
      modalTitle.textContent = `${entry.blogger.avatar} ${entry.blogger.name} 的所有动态`;
      modalBody.innerHTML = entry.items.map((item, idx) => {
        const isUnread = !readStatus[item.link]?.read;
        return `
          <div class="sub-modal-item ${isUnread ? 'sub-modal-item--unread' : ''}" data-url="${item.link}">
            <div class="sub-feed-body">
              <div class="sub-feed-title" title="${escapeHtml(item.title)}">${isUnread ? '<span class="sub-unread-dot">●</span> ' : ''}${item.title}</div>
              <div class="sub-feed-time">${timeAgo(item.pubDate)}</div>
            </div>
            <button class="sub-ignore-btn" data-url="${item.link}" title="忽略此动态">✕</button>
          </div>
        `;
      }).join('');
      modalBody.querySelectorAll('.sub-modal-item').forEach(mi => {
        mi.addEventListener('click', () => {
          const url = (mi as HTMLElement).dataset.url;
          if (!url) return;
          if (readStatus[url]) {
            readStatus[url].read = true;
            chrome.storage.local.set({ [STORAGE_KEYS.READ_STATUS]: readStatus }).catch(() => {});
          }
          chrome.tabs.create({ url });
          window.close();
        });
      });
      modalBody.querySelectorAll('.sub-ignore-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const url = (btn as HTMLElement).dataset.url;
          if (!url) return;
          if (readStatus[url]) {
            readStatus[url].ignored = true;
            chrome.storage.local.set({ [STORAGE_KEYS.READ_STATUS]: readStatus }).catch(() => {});
          }
          modalOverlay.style.display = 'none';
          renderSubscriptionTab(container);
        });
      });
      modalOverlay.style.display = 'flex';
    });
  });

  if (modalClose) {
    modalClose.addEventListener('click', () => { modalOverlay.style.display = 'none'; });
  }
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) modalOverlay.style.display = 'none';
    });
  }

  // 设置按钮
  const settingsBtn = container.querySelector('#subSettingsBtn') as HTMLElement | null;
  settingsBtn?.addEventListener('click', () => renderSubscriptionSettings(container));

  // 刷新按钮
  const refreshBtn = container.querySelector('#subRefreshBtn') as HTMLElement | null;
  refreshBtn?.addEventListener('click', async () => {
    container.innerHTML = '<div class="sub-loading">📡 正在刷新...</div>';
    await refreshAllFeeds();
    await renderSubscriptionTab(container);
  });
}

// ===== 订阅管理弹窗 =====
async function renderSubscriptionSettings(container: HTMLElement): Promise<void> {
  // 获取当前订阅源
  const sources = (await getStoredSources()).length > 0
    ? await getStoredSources()
    : [...RSSHUB_SOURCES];
  console.log('[renderSubscriptionSettings] sources for preview:', sources);

  container.innerHTML = `
    <div class="sub-card" style="position:relative">
      <div class="sub-settings-header">
        <span class="sub-settings-title">订阅管理</span>
        <button class="sub-settings-close" id="subSettingsClose">&times;</button>
      </div>
      <div class="sub-settings-body">
        <!-- RSSHub 地址配置 -->
        <div class="rsshub-config">
          <div class="rsshub-config-label">RSSHub 地址</div>
          <div class="rsshub-config-row">
            <input class="rsshub-config-input" id="rsshubUrlInput" type="text" value="${RSSHUB_BASE}" placeholder="http://localhost:8080" spellcheck="false">
            <button class="rsshub-config-test-btn" id="rsshubTestBtn">测试</button>
          </div>
          <div class="rsshub-config-status" id="rsshubTestResult"></div>
        </div>
        <!-- 添加订阅源 -->
        <div class="rsshub-config">
          <div class="rsshub-config-label">📡 添加订阅源</div>
          <div class="rsshub-config-row">
            <input class="rsshub-config-input" id="addSourceInput" placeholder="输入 RSS 链接或路由..." spellcheck="false">
            <button class="rsshub-config-test-btn" id="addSourceBtn">添加</button>
          </div>
          <div class="rsshub-config-status" id="addSourceStatus"></div>
        </div>
        <!-- 显示天数配置 -->
        <div class="rsshub-config">
          <div class="rsshub-config-label">动态显示</div>
          <div class="rsshub-config-row">
            <input class="rsshub-config-input" id="feedDaysInput" type="number" min="1" max="30" value="${FEED_MAX_DAYS}" style="width:50px;flex:none;text-align:center">
            <span style="font-size:11px;color:var(--text-dim);line-height:28px">天内的动态</span>
            <button class="rsshub-config-test-btn" id="feedDaysSave" style="margin-left:auto">应用</button>
          </div>
        </div>
        <!-- 分隔线 -->
        <div style="border-top:1px solid var(--border);margin:4px 0 6px"></div>
        <!-- 导入导出 -->
        <div class="sub-settings-actions">
          <button class="sub-settings-action-btn" id="subSettingsImport">📥 导入</button>
          <button class="sub-settings-action-btn" id="subSettingsExport">📤 导出</button>
        </div>
        <div class="sub-settings-hint">导入 JSON 配置文件可添加订阅源</div>
      </div>
    </div>
  `;

  // 关闭
  const closeBtn = container.querySelector('#subSettingsClose') as HTMLElement;
  closeBtn.addEventListener('click', () => renderSubscriptionTab(container));

  // 隐藏的文件输入
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json';
  fileInput.style.display = 'none';
  container.appendChild(fileInput);

  // 导入
  const importBtn = container.querySelector('#subSettingsImport') as HTMLElement;
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      // 兼容三种格式：
      //   1. 旧格式：字符串数组 ["url1", "url2"]
      //   2. 旧格式：对象数组 [{url: "url1", ...}]
      //   3. 新格式：按平台分类 { bilibili: [{url: "url1", ...}], zhihu: [...] }
      let rawSources: any[];
      if (Array.isArray(data.sources)) {
        rawSources = data.sources;
      } else if (data.sources && typeof data.sources === 'object') {
        rawSources = Object.values(data.sources).flat();
      } else {
        throw new Error('格式错误：未找到订阅源列表');
      }
      const urls: string[] = rawSources.map((s: any) => typeof s === 'string' ? s : s.url);
      const currentSources = await getStoredSources();
      const merged = [...new Set([...currentSources, ...urls])];
      await saveSources(merged);
      renderSubscriptionSettings(container);
    } catch (e: any) {
      importBtn.textContent = `❌ ${e.message || '格式错误'}`;
      setTimeout(() => { importBtn.textContent = '📥 导入'; }, 2000);
    }
    fileInput.value = '';
  });

  // 导出
  const exportBtn = container.querySelector('#subSettingsExport') as HTMLElement;
  exportBtn.addEventListener('click', async () => {
    exportBtn.textContent = '⏳ 导出中...';
    exportBtn.disabled = true;
    try {
      const enriched = await enrichSourcesWithMeta(sources);
      // 按平台分类
      const grouped: Record<string, typeof enriched> = {};
      for (const item of enriched) {
        const key = item.platform || '其他';
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(item);
      }
      const exportData = {
        _comment: 'KnowSeek 订阅源导出文件。导入时只需 RSS 链接，平台和作者信息仅供参考。',
        sources: grouped
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `knowseek-subscriptions-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      exportBtn.textContent = '📤 导出';
      exportBtn.disabled = false;
    }
  });

  // RSSHub 地址测试连接
  const rsshubTestBtn = container.querySelector('#rsshubTestBtn') as HTMLElement;
  const rsshubUrlInput = container.querySelector('#rsshubUrlInput') as HTMLInputElement;
  const rsshubTestResult = container.querySelector('#rsshubTestResult') as HTMLElement;

  rsshubTestBtn.addEventListener('click', async () => {
    const url = rsshubUrlInput.value.trim().replace(/\/+$/, '');
    if (!url) {
      rsshubTestResult.textContent = '❌ 请输入地址';
      rsshubTestResult.className = 'rsshub-config-status rsshub-config-status--error';
      return;
    }
    rsshubTestBtn.textContent = '测试中...';
    rsshubTestBtn.disabled = true;
    rsshubTestResult.textContent = '';
    try {
      // 尝试请求 RSSHub 的一个简单路由来测试连接
      const testUrl = `${url}/bilibili/user/dynamic/625267185?format=json&limit=1`;
      const res = await rssFetch(testUrl);
      if (!res.ok) {
        throw new Error(res.error || `HTTP ${res.status}`);
      }
      const data = res.data;
      if (data && (data.items || data.data)) {
          // 保存到存储
          await saveRSSHubBaseUrl(url);
          // 重新初始化博主列表（使用更新后的订阅源）
          await initBloggers();
          // 重新渲染设置面板，更新订阅源预览
          await renderSubscriptionSettings(container);
          // 重新渲染后，在新 DOM 上显示成功提示
          const newResult = container.querySelector('#rsshubTestResult') as HTMLElement;
          const newBtn = container.querySelector('#rsshubTestBtn') as HTMLElement;
          if (newResult) {
            newResult.textContent = '✅ 连接成功';
            newResult.className = 'rsshub-config-status rsshub-config-status--success';
          }
          if (newBtn) {
            newBtn.textContent = '测试';
            newBtn.disabled = false;
          }
      } else {
        throw new Error('响应格式异常');
      }
    } catch (err: any) {
      rsshubTestResult.textContent = `❌ 连接失败: ${err.message || '未知错误'}`;
      rsshubTestResult.className = 'rsshub-config-status rsshub-config-status--error';
    } finally {
      rsshubTestBtn.textContent = '测试';
      rsshubTestBtn.disabled = false;
    }
  });

  // 添加订阅源
  const addSourceBtn = container.querySelector('#addSourceBtn') as HTMLElement;
  const addSourceInput = container.querySelector('#addSourceInput') as HTMLInputElement;
  const addSourceStatus = container.querySelector('#addSourceStatus') as HTMLElement;
  addSourceBtn.addEventListener('click', async () => {
    let val = addSourceInput.value.trim();
    if (!val) {
      addSourceStatus.textContent = '❌ 请输入订阅源地址';
      addSourceStatus.className = 'rsshub-config-status rsshub-config-status--error';
      return;
    }
    // 如果是相对路径，拼接 RSSHub 地址
    if (val.startsWith('/')) {
      const rsshubUrl = (document.getElementById('rsshubUrlInput') as HTMLInputElement)?.value.trim().replace(/\/+$/, '') || RSSHUB_BASE;
      val = `${rsshubUrl}${val}`;
    }
    // 简单 URL 校验
    if (!val.startsWith('http://') && !val.startsWith('https://')) {
      addSourceStatus.textContent = '❌ 请输入有效的 URL（以 http:// 或 https:// 开头）或以 / 开头的路由';
      addSourceStatus.className = 'rsshub-config-status rsshub-config-status--error';
      return;
    }
    addSourceBtn.textContent = '添加中...';
    addSourceBtn.disabled = true;
    try {
      const current = await getStoredSources();
      if (current.includes(val)) {
        addSourceStatus.textContent = '⚠️ 该订阅源已存在';
        addSourceStatus.className = 'rsshub-config-status rsshub-config-status--error';
        return;
      }
      current.push(val);
      await saveSources(current);
      // 重新初始化博主列表并刷新设置面板
      await initBloggers();
      renderSubscriptionSettings(container);
      // 在新 DOM 上显示成功提示
      const newStatus = container.querySelector('#addSourceStatus') as HTMLElement;
      if (newStatus) {
        newStatus.textContent = '✅ 添加成功';
        newStatus.className = 'rsshub-config-status rsshub-config-status--success';
      }
    } catch (err: any) {
      addSourceStatus.textContent = `❌ 添加失败: ${err.message || '未知错误'}`;
      addSourceStatus.className = 'rsshub-config-status rsshub-config-status--error';
    } finally {
      addSourceBtn.textContent = '添加';
      addSourceBtn.disabled = false;
    }
  });

  // RSSHub 地址输入框失焦时保存
  rsshubUrlInput.addEventListener('change', async () => {
    const url = rsshubUrlInput.value.trim().replace(/\/+$/, '');
    if (url && url !== RSSHUB_BASE) {
      await saveRSSHubBaseUrl(url);
      // 重新初始化博主列表并刷新设置面板
      await initBloggers();
      renderSubscriptionSettings(container);
    }
  });

  // 动态显示天数
  const feedDaysInput = container.querySelector('#feedDaysInput') as HTMLInputElement;
  const feedDaysSave = container.querySelector('#feedDaysSave') as HTMLElement;
  feedDaysSave.addEventListener('click', async () => {
    const days = parseInt(feedDaysInput.value, 10);
    if (isNaN(days) || days < 1 || days > 30) {
      feedDaysSave.textContent = '❌ 1-30';
      setTimeout(() => { feedDaysSave.textContent = '应用'; }, 2000);
      return;
    }
    await saveFeedMaxDays(days);
    feedDaysSave.textContent = '✅ 已应用';
    setTimeout(() => { feedDaysSave.textContent = '应用'; }, 1500);
  });
}

function animateNumber(el, target) {
  let current = 0;
  const step = Math.max(1, Math.ceil(target / 20));
  const timer = setInterval(() => {
    current += step;
    if (current >= target) { current = target; clearInterval(timer); }
    el.querySelector('.stat-value').textContent = String(current);
  }, 20);
}