// =========== 字幕 CDN 请求拦截 ===========
// 在 MV3 中，service worker 会在匹配的网络请求发生时自动唤醒

const SUBTITLE_URL_PATTERNS = [
  '*://*.hdslb.com/*subtitle*',
  '*://*.hdslb.com/*caption*'
];

// 字幕 CDN URL 缓存（最近捕获的 URL），避免重复处理
let backgroundSubtitleUrls: string[] = [];

export function setupSubtitleCDNInterceptor(): void {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const url = details.url;

      // 避免重复处理同一个 URL
      if (backgroundSubtitleUrls.includes(url)) return;
      backgroundSubtitleUrls.push(url);
      if (backgroundSubtitleUrls.length > 30) backgroundSubtitleUrls.shift();

      console.log('[KnowSeek] Background detected subtitle CDN: tab=' + details.tabId + ' url=' + url.slice(0, 100));

      // 异步获取字幕内容并缓存到 storage
      (async () => {
        try {
          const resp = await fetch(url);
          const text = await resp.text();
          let json: any;
          try { json = JSON.parse(text); } catch (_) { return; }

          if (json?.body?.length > 0) {
            const subText = json.body.map((b: any) => b.content || b.text || '').filter(Boolean).join('\n');
            if (subText.trim().length > 10) {
              // 用 details.tabId 获取真正发起请求的标签页 URL，而非当前活跃标签页
              let pageUrl = '';
              try {
                if (details.tabId > 0) {
                  const tab = await chrome.tabs.get(details.tabId);
                  pageUrl = tab?.url || '';
                }
              } catch (_) {
                // tab 可能已关闭，回退到 active tab
              }
              if (!pageUrl) {
                const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
                pageUrl = tabs[0]?.url || '';
              }
              console.log('[KnowSeek] Background stored subtitle len=' + subText.length + ' for tab=' + details.tabId + ' url=' + pageUrl.slice(0, 60));
              await chrome.storage.local.set({
                interceptedSubtitle: {
                  url: pageUrl,
                  text: subText.trim(),
                  time: Date.now()
                }
              });
            }
          }
        } catch (_) {
          // 静默失败，不干扰其他功能
        }
      })();
    },
    { urls: SUBTITLE_URL_PATTERNS }
  );
}

// =========== Bilibili API 代理消息处理 ===========
export function setupSubtitleProxyMessages(): void {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 代理 Bilibili API 请求，自动携带 HttpOnly Cookie
    if (request.action === 'proxyBilibiliApi') {
      (async () => {
        try {
          const cookies = await chrome.cookies.getAll({ domain: '.bilibili.com' });
          const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');

          if (!cookieStr || !cookieStr.includes('SESSDATA')) {
            console.warn('[KnowSeek] Bilibili cookie proxy: No SESSDATA cookie found');
            sendResponse({ error: 'no_cookie', data: null });
            return;
          }

          const resp = await fetch(request.url, {
            headers: {
              'Cookie': cookieStr,
              'Referer': 'https://www.bilibili.com',
              'User-Agent': navigator.userAgent
            }
          });
          const text = await resp.text();
          let json: any;
          try { json = JSON.parse(text); } catch (_) {
            sendResponse({ error: 'parse_error', data: text.slice(0, 200) });
            return;
          }
          sendResponse({ error: null, data: json });
        } catch (e: any) {
          console.warn('[KnowSeek] Bilibili proxy failed:', e);
          sendResponse({ error: e.message, data: null });
        }
      })();
      return true; // 异步回复
    }

    // 代理获取字幕内容（从 CDN URL）
    if (request.action === 'proxyFetchSubtitle') {
      (async () => {
        try {
          const resp = await fetch(request.url, {
            headers: { 'Referer': 'https://www.bilibili.com' }
          });
          const text = await resp.text();
          sendResponse({ error: null, data: text });
        } catch (e: any) {
          sendResponse({ error: e.message, data: null });
        }
      })();
      return true;
    }
  });
}