// =========== Background 消息路由 ===========
// 接收来自 content script 和 sidebar 的消息，分发给对应处理函数
// 后续按功能逐步扩展各模块

export function setupMessageListener(): void {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // ---- 通用消息 ----
    if (request.action === 'openSidebar') {
      if (sender.tab?.windowId) {
        chrome.sidePanel.open({ windowId: sender.tab.windowId });
      }
      sendResponse({ success: true });
      return true;
    }

    if (request.action === 'recordCreated') {
      chrome.runtime.sendMessage({ action: 'recordsUpdated' }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
      sendResponse({ success: true });
      return;
    }

    if (request.action === 'getActiveTabUrl') {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        if (tabs && tabs[0]) {
          sendResponse({ url: tabs[0].url, title: tabs[0].title });
        } else {
          sendResponse({ url: '', title: '' });
        }
      });
      return true;
    }

    // 从 content script 转发 URL 变化消息到所有扩展页面（包括侧边栏）
    if (request.action === 'pageUrlChanged') {
      chrome.runtime.sendMessage({ action: 'pageUrlChanged', url: request.url, title: request.title }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
      sendResponse({});
      return;
    }

    // content script 代理 fetch 图片（绕过 CORS）
    if (request.action === 'fetchImageProxy') {
      handleFetchImageProxy(request.url).then((result) => {
        sendResponse(result);
      });
      return true; // 保持通道开放等待异步结果
    }

    // ---- 未识别消息（可能是其他扩展上下文处理的），静默忽略 ----
    return;
  });
}

/** 通过 background 代理 fetch 图片（绕过 CORS 限制） */
async function handleFetchImageProxy(url: string): Promise<{ blob: Blob } | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return { blob };
  } catch {
    return null;
  }
}