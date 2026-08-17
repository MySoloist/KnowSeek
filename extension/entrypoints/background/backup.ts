// =========== 备份系统（WebDAV + 服务器） ===========
import JSZip from 'jszip';

const STORAGE_KEYS_BACKUP = {
  BACKUP_LOGS: 'backup_logs',
  SERVER_BACKUP_LOGS: 'server_backup_logs'
} as const;

const ALARM_NAME = 'webdav-backup';
const SERVER_ALARM_NAME = 'server-backup';

// =========== 备份日志 ===========

async function addBackupLog(status: string, message: string): Promise<void> {
  const data = await chrome.storage.local.get(STORAGE_KEYS_BACKUP.BACKUP_LOGS);
  const logs = data[STORAGE_KEYS_BACKUP.BACKUP_LOGS] || [];
  const log = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
    status,
    message,
    time: Date.now()
  };
  logs.unshift(log);
  if (logs.length > 50) logs.length = 50;
  await chrome.storage.local.set({ [STORAGE_KEYS_BACKUP.BACKUP_LOGS]: logs });
}

async function addServerBackupLog(status: string, message: string): Promise<void> {
  const data = await chrome.storage.local.get(STORAGE_KEYS_BACKUP.SERVER_BACKUP_LOGS);
  const logs = data[STORAGE_KEYS_BACKUP.SERVER_BACKUP_LOGS] || [];
  const log = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
    status,
    message,
    time: Date.now()
  };
  logs.unshift(log);
  if (logs.length > 50) logs.length = 50;
  await chrome.storage.local.set({ [STORAGE_KEYS_BACKUP.SERVER_BACKUP_LOGS]: logs });
}

// =========== WebDAV 备份 ===========

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
  label = 'WebDAV'
): Promise<Response> {
  let lastError: any;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      console.log(`[Background] ${label} attempt ${i + 1}: ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      console.warn(`[Background] ${label} attempt ${i + 1} failed:`, error);
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
  throw lastError;
}

export async function setupBackupAlarm(): Promise<void> {
  await chrome.alarms.clear(ALARM_NAME);

  const config = await chrome.storage.sync.get(['backupEnabled', 'backupInterval', 'backupTime']);
  if (!config.backupEnabled || !config.backupInterval) {
    console.log('[Background] Backup alarm not enabled');
    return;
  }

  const intervalMinutes = (parseInt(config.backupInterval) || 24) * 60;

  let delayInMinutes: number | undefined;
  if (config.backupTime) {
    const [targetHour, targetMinute] = (config.backupTime as string).split(':').map(Number);
    const now = new Date();
    const nowTotal = now.getHours() * 60 + now.getMinutes();
    const targetTotal = targetHour * 60 + targetMinute;

    if (targetTotal > nowTotal) {
      delayInMinutes = targetTotal - nowTotal;
    } else {
      delayInMinutes = (24 * 60 - nowTotal) + targetTotal;
    }
    console.log(`[Background] Backup first fire in ${delayInMinutes} minutes (at ${config.backupTime}), then every ${config.backupInterval} hours`);
  } else {
    console.log('[Background] Backup alarm set: starts immediately, then every', config.backupInterval, 'hours');
  }

  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes,
    periodInMinutes: intervalMinutes
  });
}

async function performBackup(source: string): Promise<void> {
  try {
    // 读取全部数据
    const [localData, syncConfig, embeddingData] = await Promise.all([
      chrome.storage.local.get([
        'records', 'tags', 'mark_tags',
        'color_config', STORAGE_KEYS_BACKUP.BACKUP_LOGS,
        'record_order',
        'ai_providers', 'ai_active_provider',
        'backend_url', 'backend_key',
        'chat_sessions', 'chat_active_session_id'
      ]),
      chrome.storage.sync.get([
        'webdavUrl', 'webdavUsername', 'webdavPassword',
        'webdavDir', 'webdavFilename', 'backupEnabled', 'backupTime'
      ]),
      chrome.storage.local.get('_embeddingConfig')
    ]);

    const records = localData.records || [];
    const tags = localData.tags || [];
    const markTags = localData.mark_tags || [];
    const colorConfig = localData.color_config || null;
    const savedRecordOrder = localData.record_order || [];
    const backupLogs = localData[STORAGE_KEYS_BACKUP.BACKUP_LOGS] || [];
    const aiProviders = localData.ai_providers || [];
    const aiActiveProvider = localData.ai_active_provider || '';
    const backendUrl = localData.backend_url || '';
    const backendKey = localData.backend_key || '';
    const rawChatSessions = localData.chat_sessions || {};
    const chatActiveSessionId = localData.chat_active_session_id || '';
    const embeddingConfig = embeddingData._embeddingConfig || null;

    // 清理 records 大字段
    const cleanRecords = records.map((r: any) => {
      const clean = { ...r };
      if (clean.snapshot && clean.snapshot.startsWith('data:')) {
        clean.snapshot = '';
      }
      if (clean.text && clean.text.startsWith('data:image/') && clean.videoTimestamp) {
        clean.text = '[base64-image]';
      }
      if (clean.description) {
        clean.description = clean.description.replace(/data:image\/[^;]+;base64,[^\s'"]+/g, '[base64-image]');
      }
      return clean;
    });

    // 创建 ZIP
    const zip = new JSZip();
    let chatImageIndex = 0;

    // 清理聊天会话中的 base64 图片
    const cleanChatSessions: Record<string, any> = {};
    // chat_sessions 可能是数组（chat.ts 以数组格式存储）或对象，统一转为 id-keyed 对象
    const sessions = Array.isArray(rawChatSessions)
      ? rawChatSessions
      : Object.values(rawChatSessions);
    for (const session of sessions) {
      const sid = (session as any).id || crypto.randomUUID();
      const restoredMessages = ((session as any).messages || []).map((msg: any) => {
        const restored = { ...msg };
        if (restored.images && Array.isArray(restored.images)) {
          restored.images = restored.images.map((img: any) => {
            if (typeof img === 'string' && img.startsWith('data:image/')) {
              const ext = img.startsWith('data:image/png') ? 'png' : 'jpg';
              const fname = `chat_img_${chatImageIndex++}.${ext}`;
              const b64 = img.split(',')[1];
              if (b64) {
                const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                zip.file(`chat/images/${fname}`, bytes);
              }
              return `[base64-image:${fname}]`;
            }
            return img;
          });
        }
        return restored;
      });
      cleanChatSessions[sid] = { ...(session as any), messages: restoredMessages };
    }

    zip.file('records.json', JSON.stringify({
      version: '2.0.0', exported_at: Date.now(),
      records: cleanRecords, tags, mark_tags: markTags,
      color_config: colorConfig, saved_record_order: savedRecordOrder,
      filter_tab_order: [], domain_order: []
    }, null, 2));

    zip.file('config.json', JSON.stringify({
      version: '2.0.0', exported_at: Date.now(),
      ai_providers: aiProviders, ai_active_provider: aiActiveProvider,
      backend_url: backendUrl, backend_key: backendKey,
      embedding_config: embeddingConfig,
      webdav: {
        url: syncConfig.webdavUrl || '', username: syncConfig.webdavUsername || '',
        password: syncConfig.webdavPassword || '', dir: syncConfig.webdavDir || 'KnowSeek',
        filename: syncConfig.webdavFilename || 'backup.zip',
        backup_enabled: syncConfig.backupEnabled || false, backup_time: syncConfig.backupTime || '03:00'
      }
    }, null, 2));

    zip.file('chat.json', JSON.stringify({
      version: '2.0.0', exported_at: Date.now(),
      sessions: cleanChatSessions, active_session_id: chatActiveSessionId
    }, null, 2));

    zip.file('logs.json', JSON.stringify({
      version: '2.0.0', exported_at: Date.now(),
      backup_logs: backupLogs
    }, null, 2));

    // 添加 OPFS 文件
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('snapshots');
      for await (const entry of (dir as any).values()) {
        if (entry.kind !== 'file') continue;
        if (!entry.name.endsWith('.png') && !entry.name.endsWith('.jpg')) continue;
        const file = await entry.getFile();
        const buffer = await file.arrayBuffer();
        if (entry.name.startsWith('chat_frame_')) {
          zip.file(`chat/frames/${entry.name}`, buffer);
        } else {
          zip.file(`annotations/snapshots/${entry.name}`, buffer);
        }
      }
    } catch (_) {
      // snapshots 目录可能不存在
    }

    const blob = await zip.generateAsync({ type: 'blob' });

    // 获取 WebDAV 配置
    const webdavConfig = await chrome.storage.sync.get([
      'webdavUrl', 'webdavUsername', 'webdavPassword', 'webdavDir', 'webdavFilename'
    ]);

    if (!webdavConfig.webdavUrl || !webdavConfig.webdavUsername || !webdavConfig.webdavPassword) {
      console.warn('[Background] WebDAV not configured, skipping backup');
      return;
    }

    // 构造上传 URL
    let uploadUrl = webdavConfig.webdavUrl.trim();
    if (!uploadUrl.endsWith('/')) uploadUrl += '/';
    const dir = webdavConfig.webdavDir ? webdavConfig.webdavDir.replace(/^\/|\/$/g, '') : '';
    if (dir) uploadUrl += dir + '/';
    uploadUrl += webdavConfig.webdavFilename;

    // 创建目录
    if (dir) {
      try {
        const dirUrl = webdavConfig.webdavUrl.trim();
        const dirEndpoint = dirUrl.endsWith('/') ? dirUrl + dir + '/' : dirUrl + '/' + dir + '/';
        const mkcolResponse = await fetchWithRetry(dirEndpoint, {
          method: 'MKCOL',
          headers: {
            'Authorization': `Basic ${btoa(`${webdavConfig.webdavUsername}:${webdavConfig.webdavPassword}`)}`
          }
        }, 3, 'WebDAV MKCOL');
        console.log('[Background] MKCOL result:', mkcolResponse.status);
      } catch (error) {
        console.warn('[Background] MKCOL failed after retries:', error);
        // 目录创建失败不一定影响上传，继续尝试
      }
    }

    // 上传
    const response = await fetchWithRetry(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${btoa(`${webdavConfig.webdavUsername}:${webdavConfig.webdavPassword}`)}`,
        'Content-Type': 'application/zip'
      },
      body: blob
    }, 3, 'WebDAV PUT');

    if (response.ok || response.status === 201 || response.status === 204) {
      console.log('[Background] Backup to WebDAV succeeded');
      const msg = source === 'manual' ? '手动备份成功' : '定时备份成功';
      await addBackupLog('success', msg);
    } else {
      const errorText = await response.text().catch(() => '');
      console.error('[Background] Backup to WebDAV failed:', response.status, errorText);
      await addBackupLog('error', `备份失败 (HTTP ${response.status}${errorText ? ': ' + errorText : ''})`);
    }
  } catch (error: any) {
    console.error('[Background] Backup error:', error);
    let msg = error.message;
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ERR_HTTP2')) {
      msg = '网络连接失败，请检查 WebDAV 配置和网络';
    } else if (msg.includes('401') || msg.includes('Unauthorized')) {
      msg = '认证失败，请检查用户名和密码';
    } else if (msg.includes('404') || msg.includes('Not Found')) {
      msg = 'WebDAV 地址不存在';
    }
    await addBackupLog('error', `备份失败: ${msg}`);
  }
}

// =========== 服务器定时备份 ===========

export async function setupServerBackupAlarm(): Promise<void> {
  await chrome.alarms.clear(SERVER_ALARM_NAME);

  const config = await chrome.storage.sync.get(['server_backup_enabled', 'server_backup_time']);
  if (!config.server_backup_enabled) {
    console.log('[Background] Server backup alarm not enabled');
    return;
  }

  const timeStr = config.server_backup_time || '03:00';
  const [targetHour, targetMinute] = timeStr.split(':').map(Number);
  const now = new Date();
  const nowTotal = now.getHours() * 60 + now.getMinutes();
  const targetTotal = targetHour * 60 + targetMinute;

  let delayInMinutes: number;
  if (targetTotal > nowTotal) {
    delayInMinutes = targetTotal - nowTotal;
  } else {
    delayInMinutes = (24 * 60 - nowTotal) + targetTotal;
  }

  console.log('[Background] Server backup alarm set: daily at', timeStr, ', first fire in', delayInMinutes, 'minutes');

  chrome.alarms.create(SERVER_ALARM_NAME, {
    delayInMinutes,
    periodInMinutes: 24 * 60
  });
}

async function serverBackup(): Promise<void> {
  try {
    // 读取全部数据
    const [localData, syncConfig, embeddingData] = await Promise.all([
      chrome.storage.local.get([
        'records', 'tags', 'mark_tags',
        'color_config', STORAGE_KEYS_BACKUP.BACKUP_LOGS,
        'record_order',
        'ai_providers', 'ai_active_provider',
        'backend_url', 'backend_key',
        'chat_sessions', 'chat_active_session_id'
      ]),
      chrome.storage.sync.get([
        'webdavUrl', 'webdavUsername', 'webdavPassword',
        'webdavDir', 'webdavFilename', 'backupEnabled', 'backupTime'
      ]),
      chrome.storage.local.get('_embeddingConfig')
    ]);

    const records = localData.records || [];
    const tags = localData.tags || [];
    const markTags = localData.mark_tags || [];
    const colorConfig = localData.color_config || null;
    const savedRecordOrder = localData.record_order || [];
    const backupLogs = localData[STORAGE_KEYS_BACKUP.BACKUP_LOGS] || [];
    const aiProviders = localData.ai_providers || [];
    const aiActiveProvider = localData.ai_active_provider || '';
    const backendUrl = localData.backend_url || '';
    const backendKey = localData.backend_key || '';
    const rawChatSessions = localData.chat_sessions || {};
    const chatActiveSessionId = localData.chat_active_session_id || '';
    const embeddingConfig = embeddingData._embeddingConfig || null;

    const cleanRecords = records.map((r: any) => {
      const clean = { ...r };
      if (clean.snapshot && clean.snapshot.startsWith('data:')) clean.snapshot = '';
      if (clean.text && clean.text.startsWith('data:image/') && clean.videoTimestamp) clean.text = '[base64-image]';
      if (clean.description) clean.description = clean.description.replace(/data:image\/[^;]+;base64,[^\s'"]+/g, '[base64-image]');
      return clean;
    });

    const zip = new JSZip();
    let chatImageIndex = 0;

    const cleanChatSessions: Record<string, any> = {};
    // chat_sessions 可能是数组（chat.ts 以数组格式存储）或对象，统一转为 id-keyed 对象
    const sessions = Array.isArray(rawChatSessions)
      ? rawChatSessions
      : Object.values(rawChatSessions);
    for (const session of sessions) {
      const sid = (session as any).id || crypto.randomUUID();
      const restoredMessages = ((session as any).messages || []).map((msg: any) => {
        const restored = { ...msg };
        if (restored.images && Array.isArray(restored.images)) {
          restored.images = restored.images.map((img: any) => {
            if (typeof img === 'string' && img.startsWith('data:image/')) {
              const ext = img.startsWith('data:image/png') ? 'png' : 'jpg';
              const fname = `chat_img_${chatImageIndex++}.${ext}`;
              const b64 = img.split(',')[1];
              if (b64) {
                const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                zip.file(`chat/images/${fname}`, bytes);
              }
              return `[base64-image:${fname}]`;
            }
            return img;
          });
        }
        return restored;
      });
      cleanChatSessions[sid] = { ...(session as any), messages: restoredMessages };
    }

    zip.file('records.json', JSON.stringify({
      version: '2.0.0', exported_at: Date.now(),
      records: cleanRecords, tags, mark_tags: markTags,
      color_config: colorConfig, saved_record_order: savedRecordOrder,
      filter_tab_order: [], domain_order: []
    }, null, 2));

    zip.file('config.json', JSON.stringify({
      version: '2.0.0', exported_at: Date.now(),
      ai_providers: aiProviders, ai_active_provider: aiActiveProvider,
      backend_url: backendUrl, backend_key: backendKey,
      embedding_config: embeddingConfig,
      webdav: {
        url: syncConfig.webdavUrl || '', username: syncConfig.webdavUsername || '',
        password: syncConfig.webdavPassword || '', dir: syncConfig.webdavDir || 'KnowSeek',
        filename: syncConfig.webdavFilename || 'backup.zip',
        backup_enabled: syncConfig.backupEnabled || false, backup_time: syncConfig.backupTime || '03:00'
      }
    }, null, 2));

    zip.file('chat.json', JSON.stringify({
      version: '2.0.0', exported_at: Date.now(),
      sessions: cleanChatSessions, active_session_id: chatActiveSessionId
    }, null, 2));

    zip.file('logs.json', JSON.stringify({
      version: '2.0.0', exported_at: Date.now(),
      backup_logs: backupLogs
    }, null, 2));

    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('snapshots');
      for await (const entry of (dir as any).values()) {
        if (entry.kind !== 'file') continue;
        if (!entry.name.endsWith('.png') && !entry.name.endsWith('.jpg')) continue;
        const file = await entry.getFile();
        const buffer = await file.arrayBuffer();
        if (entry.name.startsWith('chat_frame_')) {
          zip.file(`chat/frames/${entry.name}`, buffer);
        } else {
          zip.file(`annotations/snapshots/${entry.name}`, buffer);
        }
      }
    } catch (_) {}

    const blob = await zip.generateAsync({ type: 'blob' });

    // 推送到后端
    const backendUrlStr = backendUrl || 'http://localhost:8765';
    const formData = new FormData();
    formData.append('file', blob, 'knowseek_backup.zip');

    const response = await fetch(`${backendUrlStr}/api/backup/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${backendKey || 'sk-knowseek-demo'}`
      },
      body: formData
    });

    if (response.ok) {
      const result = await response.json();
      console.log('[Background] Server backup succeeded:', result.message);
      await addServerBackupLog('success', `服务器备份成功: ${result.data?.filename || ''}`);
    } else {
      const errorText = await response.text().catch(() => '');
      console.error('[Background] Server backup failed:', response.status, errorText);
      await addServerBackupLog('error', `服务器备份失败 (HTTP ${response.status})`);
    }
  } catch (error: any) {
    console.error('[Background] Server backup error:', error);
    let msg = error.message;
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      msg = '连接服务器失败，请检查后端地址和网络';
    }
    await addServerBackupLog('error', `服务器备份失败: ${msg}`);
  }
}

// =========== 备份消息处理 ===========

export function setupBackupHandlers(): void {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    // ---- WebDAV 备份消息 ----
    if (request.action === 'updateBackupAlarm') {
      setupBackupAlarm()
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }

    if (request.action === 'backupNow') {
      performBackup('manual')
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }

    if (request.action === 'getBackupLogs') {
      chrome.storage.local.get(STORAGE_KEYS_BACKUP.BACKUP_LOGS)
        .then(data => sendResponse({ logs: data[STORAGE_KEYS_BACKUP.BACKUP_LOGS] || [] }))
        .catch(e => sendResponse({ logs: [], error: e.message }));
      return true;
    }

    if (request.action === 'getBackupAlarmStatus') {
      chrome.alarms.get(ALARM_NAME).then(alarm => {
        let nextTime: number | null = null;
        let nextTimeText: string | null = null;
        if (alarm && alarm.scheduledTime) {
          nextTime = alarm.scheduledTime;
          const diff = alarm.scheduledTime - Date.now();
          if (diff > 0) {
            const hours = Math.floor(diff / 3600000);
            const minutes = Math.floor((diff % 3600000) / 60000);
            nextTimeText = `${hours}小时${minutes}分钟后`;
          } else {
            nextTimeText = '即将执行';
          }
        }
        sendResponse({
          enabled: !!alarm,
          periodInMinutes: alarm ? alarm.periodInMinutes : null,
          nextScheduledTime: nextTime,
          nextScheduledTimeText: nextTimeText
        });
      });
      return true;
    }

    // ---- 服务器备份消息 ----
    if (request.action === 'updateServerBackupAlarm') {
      setupServerBackupAlarm()
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }

    if (request.action === 'serverBackupNow') {
      serverBackup()
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }

    if (request.action === 'getServerBackupLogs') {
      chrome.storage.local.get(STORAGE_KEYS_BACKUP.SERVER_BACKUP_LOGS)
        .then(data => sendResponse({ logs: data[STORAGE_KEYS_BACKUP.SERVER_BACKUP_LOGS] || [] }))
        .catch(e => sendResponse({ logs: [], error: e.message }));
      return true;
    }

    if (request.action === 'getServerBackupStatus') {
      chrome.alarms.get(SERVER_ALARM_NAME).then(alarm => {
        let nextTime: number | null = null;
        let nextTimeText: string | null = null;
        if (alarm && alarm.scheduledTime) {
          nextTime = alarm.scheduledTime;
          const diff = alarm.scheduledTime - Date.now();
          if (diff > 0) {
            const hours = Math.floor(diff / 3600000);
            const minutes = Math.floor((diff % 3600000) / 60000);
            nextTimeText = `${hours}小时${minutes}分钟后`;
          } else {
            nextTimeText = '即将执行';
          }
        }
        sendResponse({
          enabled: !!alarm,
          periodInMinutes: alarm ? alarm.periodInMinutes : null,
          nextScheduledTime: nextTime,
          nextScheduledTimeText: nextTimeText
        });
      });
      return true;
    }
  });
}

// =========== 备份定时器处理 ===========

export function setupBackupAlarmHandler(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
      console.log('[Background] Alarm triggered backup');

      const keepAlive = setInterval(() => {
        chrome.storage.local.get(null, () => {});
      }, 15000);

      (async () => {
        try {
          await performBackup('scheduled');
        } finally {
          clearInterval(keepAlive);
        }
      })();
    } else if (alarm.name === SERVER_ALARM_NAME) {
      console.log('[Background] Server backup alarm triggered');

      const keepAlive = setInterval(() => {
        chrome.storage.local.get(null, () => {});
      }, 15000);

      (async () => {
        try {
          await serverBackup();
        } finally {
          clearInterval(keepAlive);
        }
      })();
    }
  });
}