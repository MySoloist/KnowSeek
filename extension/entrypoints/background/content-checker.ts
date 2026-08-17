// ===== 基于 chrome.alarms 的后台内容变更检测 =====
// 即使侧边栏关闭，也能定时检测所有已标注页面是否有更新
// 仅依赖后端 embedding API 做语义相似度检测

import { getSnapshot, getAllSnapshots } from '../../utils/indexedb';

const NOTIFICATIONS_KEY = '_contentChangeNotifications';

// ── 通知侧边栏 ──

/** 保存通知到 storage 后，通知侧边栏刷新 */
async function saveNotificationsAndNotify(notifications: ContentChangeNotification[]): Promise<void> {
  await chrome.storage.local.set({ [NOTIFICATIONS_KEY]: notifications });
  // 主动通知侧边栏（storage.onChanged 在侧边栏关闭时不会触发）
  chrome.runtime.sendMessage({ action: 'contentChangeDetected' }, () => { if (chrome.runtime.lastError) { /* background 无接收端时忽略 */ } });
}

// ── 后端 Embedding API 辅助 ──

/** 缓存 embedding 配置状态（避免每次检测都查询） */
let _embeddingConfigured: boolean | null = null;

/** 通过 backend-proxy 调用后端 API */
function callBackendApi<T = any>(endpoint: string, method: string = 'POST', body?: any): Promise<{ ok: boolean; data?: T; error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      action: 'backendRequest',
      endpoint,
      method,
      body,
    }, (response) => {
      if (chrome.runtime.lastError) { resolve({ ok: false, error: '无响应' }); return; }
      resolve(response || { ok: false, error: '无响应' });
    });
  });
}

/** 检查后端是否已配置 embedding 模型 */
async function isEmbeddingConfigured(): Promise<boolean> {
  if (_embeddingConfigured !== null) return _embeddingConfigured;
  try {
    const resp = await callBackendApi<{ configured: boolean }>('/api/embedding/status', 'GET');
    _embeddingConfigured = !!(resp.ok && resp.data?.configured);
  } catch {
    _embeddingConfigured = false;
  }
  return _embeddingConfigured;
}

/**
 * 使用后端 embedding 判断内容变化程度
 * @returns 'skip' - 无变化或页面结构变化，不通知
 *          'notify' - 有实质性变化
 */
async function embeddingDecision(url: string, newContent: string): Promise<'skip' | 'notify'> {
  const configured = await isEmbeddingConfigured();
  if (!configured) return 'skip';

  try {
    // 搜索最相似的旧快照
    const resp = await callBackendApi<{ results: { similarity: number }[] }>(
      '/api/embedding/search',
      'POST',
      { url, content: newContent, top_k: 1 }
    );

    if (!resp.ok || !resp.data?.results?.length) {
      // 没有旧快照（首次检测），保存当前快照并跳过本次通知
      const saveResp = await callBackendApi('/api/embedding/save', 'POST', { url, content: newContent });
      if (saveResp.ok) notifySidebarEmbeddingSaved();
      return 'skip';
    }

    const similarity = resp.data.results[0].similarity;

    // 保存新快照供下次对比
    const saveResp = await callBackendApi('/api/embedding/save', 'POST', { url, content: newContent });
    if (saveResp.ok) notifySidebarEmbeddingSaved();

    if (similarity > 0.95) return 'skip';  // 几乎没变
    if (similarity < 0.4) return 'skip';   // 页面结构整体变化
    return 'notify';                       // 有实质性变化
  } catch {
    return 'skip'; // 出错时不通知
  }
}

/** 通知侧边栏：向量保存成功 */
function notifySidebarEmbeddingSaved(): void {
  chrome.runtime.sendMessage({ action: 'embeddingSaved' }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
}

export interface ContentChangeNotification {
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

export function setupContentCheckerAlarm(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'contentCheck') {
      performContentCheck();
    }
  });

  // 监听来自侧边栏的消息
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'startContentCheck') {
      startContentAlarm(request);
      sendResponse({ success: true });
    } else if (request.action === 'stopContentCheck') {
      stopContentAlarm();
      sendResponse({ success: true });
    } else if (request.action === 'getNotifications') {
      getNotifications().then(notifs => sendResponse(notifs));
      return true; // async response
    } else if (request.action === 'clearNotifications') {
      clearNotifications().then(() => sendResponse({ success: true }));
      return true;
    } else if (request.action === 'getCheckInterval') {
      chrome.alarms.get('contentCheck', (alarm) => {
        sendResponse({ minutes: alarm ? alarm.periodInMinutes || 0 : 0 });
      });
      return true;
    }
    return false;
  });
}

/** 切换标签页时自动检测内容变更 */
export function setupTabActivationCheck(): void {
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      if (!tab.url || !tab.url.startsWith('http')) return;

      const existing = await getSnapshot(tab.url);
      if (!existing) return; // 没有快照，跳过
      if (!existing.recordIds?.length) return; // 无标注的快照不检测（如误保存的首页等）

      const resp = await new Promise<any>(r => chrome.tabs.sendMessage(activeInfo.tabId, { action: 'getPageContext' }, (response) => {
        if (chrome.runtime.lastError) { r(null); return; }
        r(response);
      }));
      if (!resp || !resp.content) return;

      const newNotifications: ContentChangeNotification[] = [];
      await checkPageChanges(existing.title, existing.type, existing.content, resp.content, existing.url!, newNotifications);

      if (newNotifications.length === 0) return;

      const data = await chrome.storage.local.get(NOTIFICATIONS_KEY);
      const existingNotifs: ContentChangeNotification[] = data[NOTIFICATIONS_KEY] || [];

      for (const n of newNotifications) {
        const idx = existingNotifs.findIndex(e => e.url === n.url);
        if (idx >= 0) {
          existingNotifs[idx] = n;
        } else {
          existingNotifs.push(n);
        }
      }

      await saveNotificationsAndNotify(existingNotifs);
    } catch {
      // 静默失败
    }
  });
}

/** 页面内容更新时自动检测（不切换标签页的情况） */
export function setupPageUpdateCheck(): void {
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // 只在页面加载完成时检测，避免重复触发
    if (changeInfo.status !== 'complete') return;
    if (!tab.url || !tab.url.startsWith('http')) return;

    try {
      const existing = await getSnapshot(tab.url);
      if (!existing) return; // 没有快照，跳过
      if (!existing.recordIds?.length) return; // 无标注的快照不检测

      const resp = await new Promise<any>(r => chrome.tabs.sendMessage(tabId, { action: 'getPageContext' }, (response) => {
        if (chrome.runtime.lastError) { r(null); return; }
        r(response);
      }));
      if (!resp || !resp.content) return;

      const newNotifications: ContentChangeNotification[] = [];
      await checkPageChanges(existing.title, existing.type, existing.content, resp.content, existing.url!, newNotifications);

      if (newNotifications.length === 0) return;

      const data = await chrome.storage.local.get(NOTIFICATIONS_KEY);
      const existingNotifs: ContentChangeNotification[] = data[NOTIFICATIONS_KEY] || [];

      for (const n of newNotifications) {
        const idx = existingNotifs.findIndex(e => e.url === n.url);
        if (idx >= 0) {
          existingNotifs[idx] = n;
        } else {
          existingNotifs.push(n);
        }
      }

      await saveNotificationsAndNotify(existingNotifs);
    } catch {
      // 静默失败
    }
  });
}

interface StartAlarmRequest {
  mode: 'interval' | 'daily';
  intervalMinutes?: number;
  dailyTime?: string; // HH:MM
}

export function startContentAlarm(request: StartAlarmRequest): void {
  chrome.alarms.clear('contentCheck');

  if (request.mode === 'interval') {
    const minutes = request.intervalMinutes || 0;
    if (minutes <= 0) return;
    chrome.alarms.create('contentCheck', { periodInMinutes: minutes });
  } else if (request.mode === 'daily') {
    const timeStr = request.dailyTime || '09:00';
    const [hours, minutes] = timeStr.split(':').map(Number);
    const now = new Date();
    let target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    chrome.alarms.create('contentCheck', {
      when: target.getTime(),
      periodInMinutes: 24 * 60
    });
  }

  // 立即执行一次
  performContentCheck();
}

export function stopContentAlarm(): void {
  chrome.alarms.clear('contentCheck');
}

/** 检查所有已打开标签页中，有快照的页面 */
async function performContentCheck(): Promise<void> {
  // 每次检测前失效 embedding 配置缓存，确保能获取最新配置
  _embeddingConfigured = null;
  try {
    // 先获取所有有快照的 URL
    const allSnapshots = await getAllSnapshots();
    const snapshotUrls = new Set(allSnapshots.map(s => s.url));

    const tabs = await chrome.tabs.query({});
    const httpTabs = tabs.filter(t => t.url?.startsWith('http') && t.id != null);

    const newNotifications: ContentChangeNotification[] = [];

    for (const tab of httpTabs) {
      if (!snapshotUrls.has(tab.url!)) continue; // 没有快照，跳过

      try {
        const existing = allSnapshots.find(s => s.url === tab.url);
        if (!existing) continue;
        if (!existing.recordIds?.length) continue; // 无标注的快照不检测

        const resp = await new Promise<any>(r => chrome.tabs.sendMessage(tab.id!, { action: 'getPageContext' }, (response) => {
          if (chrome.runtime.lastError) { r(null); return; }
          r(response);
        }));
        if (!resp || !resp.content) continue;

        await checkPageChanges(existing.title, existing.type, existing.content, resp.content, existing.url!, newNotifications);
      } catch {
        // 该标签页没有被注入 content script，跳过
      }
    }

    if (newNotifications.length === 0) return;

    // 合并到现有通知中
    const data = await chrome.storage.local.get(NOTIFICATIONS_KEY);
    const existingNotifs: ContentChangeNotification[] = data[NOTIFICATIONS_KEY] || [];

    for (const n of newNotifications) {
      const idx = existingNotifs.findIndex(e => e.url === n.url);
      if (idx >= 0) {
        existingNotifs[idx] = n;
      } else {
        existingNotifs.push(n);
      }
    }

    await saveNotificationsAndNotify(existingNotifs);
  } catch {
    // 静默失败
  }
}

/** 对比新旧内容，如果有变化则加入通知列表 */
async function checkPageChanges(
  title: string,
  type: 'article' | 'video',
  oldRaw: string,
  newRaw: string,
  url: string,
  out: ContentChangeNotification[]
): Promise<void> {
  // 仅依赖后端 embedding 语义相似度判断
  const decision = await embeddingDecision(url, newRaw);
  if (decision !== 'notify') return;

  out.push({
    url,
    title,
    type,
    added: 0,
    modified: 0,
    removed: 0,
    detectedAt: Date.now(),
    oldContent: oldRaw,
    newContent: newRaw,
    read: false
  });
}

/** 获取所有通知 */
export async function getNotifications(): Promise<ContentChangeNotification[]> {
  try {
    const data = await chrome.storage.local.get(NOTIFICATIONS_KEY);
    return data[NOTIFICATIONS_KEY] || [];
  } catch {
    return [];
  }
}

/** 清除所有通知 */
export async function clearNotifications(): Promise<void> {
  await chrome.storage.local.remove(NOTIFICATIONS_KEY);
}