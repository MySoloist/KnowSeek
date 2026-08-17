import { getColorConfig, STORAGE_KEYS } from './init';

// =========== 发送消息到标签页 ===========
async function sendMessageToTab(tabId: number, message: Record<string, unknown>): Promise<void> {
  try {
    console.log('[Background] Sending message to tab', tabId, ':', message.action);
    await new Promise<void>(r => chrome.tabs.sendMessage(tabId, message, () => { if (chrome.runtime.lastError) { /* 忽略 */ } r(); }));
    console.log('[Background] Message sent successfully');
  } catch (e) {
    console.warn('[Background] Failed to send message to tab:', e);
  }
}

// =========== 创建右键菜单 ===========
export async function createContextMenus(): Promise<void> {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'wa-open-sidebar',
      title: '打开标注侧边栏',
      contexts: ['action']
    });

    chrome.contextMenus.create({
      id: 'wa-highlight-selection',
      title: '高亮选中文字',
      contexts: ['selection']
    });

    chrome.contextMenus.create({
      id: 'wa-separator-1',
      type: 'separator' as const,
      contexts: ['selection']
    });

    chrome.contextMenus.create({
      id: 'wa-color-parent',
      title: '选择高亮颜色',
      contexts: ['selection']
    });
  });

  // 子菜单：颜色选项
  const colorConfig = await getColorConfig();
  colorConfig.colors.slice(0, 6).forEach(color => {
    chrome.contextMenus.create({
      id: `wa-color-${color.id}`,
      parentId: 'wa-color-parent',
      title: color.name || color.id,
      contexts: ['selection']
    });
  });
}

// =========== 右键菜单点击处理 ===========
export function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab
): void {
  console.log('[Background] Context menu clicked:', info.menuItemId, 'tabId:', tab?.id);
  if (!tab?.id) return;

  if (info.menuItemId === 'wa-open-sidebar') {
    chrome.sidePanel.open({ windowId: tab.windowId });
    return;
  }

  if (info.menuItemId === 'wa-highlight-selection') {
    sendMessageToTab(tab.id, { action: 'highlightWithDefaultColor' });
    return;
  }

  if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('wa-color-')) {
    const colorId = info.menuItemId.replace('wa-color-', '');
    sendMessageToTab(tab.id, { action: 'highlightWithColor', colorId });
  }
}