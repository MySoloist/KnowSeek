// =========== 后端服务请求代理 ===========

export function setupBackendProxyHandler(): void {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action !== 'backendRequest' && request.action !== 'proxyFetch') return;

    (async () => {
      try {
        if (request.action === 'proxyFetch') {
          // 通过 background 代理任意请求，绕开扩展页面的 CORS 限制
          const response = await fetch(request.url, {
            method: request.method || 'GET',
            signal: AbortSignal.timeout(request.timeout || 15000),
          });
          const text = await response.text();
          sendResponse({ ok: response.ok, status: response.status, text });
          return;
        }

        const config = await chrome.storage.local.get(['backend_url', 'backend_key']);
        if (!config.backend_url) {
          sendResponse({ error: '后端服务未配置' });
          return;
        }
        const baseUrl = config.backend_url.replace(/\/+$/, '');
        const response = await fetch(`${baseUrl}${request.endpoint}`, {
          method: request.method || 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.backend_key || ''}`
          },
          body: request.body ? JSON.stringify(request.body) : undefined
        });
        const data = await response.json().catch(() => ({}));
        sendResponse({ ok: response.ok, status: response.status, data });
      } catch (err: any) {
        sendResponse({ error: err.message, ok: false });
      }
    })();
    return true;
  });
}