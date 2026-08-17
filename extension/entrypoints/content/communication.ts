// =========== Content Script 消息通信 ===========
// 接收来自 background 和 sidebar 的消息，分发给对应处理函数

import { STORAGE_KEYS, updateRecords, loadData, cachedSubtitles, cachedSubtitlesUrl, colorConfig } from './state';
import { fetchVideoSubtitles, resolveBilibiliVideoUrl } from './subtitle';
import { getPageText, extractPageImages } from './page-context';
import { createHighlight, removeHighlightById, removeAllHighlights } from './highlights/highlight-core';
import { restoreHighlights, addVideoTimelineMarkers } from './highlights/highlight-restore';
import { showNotePopup } from './ui/note-popup';

// 字幕缓存状态（用于 getPageContext 的优化检查）
let lastSubtitleCached = false;
let lastSubtitleUrl = '';

// 隐藏视频元素：所有截帧操作在其上执行，不影响页面视频
let _offscreenVideo: HTMLVideoElement | null = null;
let _offscreenVideoReady = false;
let _offscreenVideoInit: Promise<void> | null = null; // blob URL 异步初始化

/** 创建或获取隐藏视频元素。blob/data URL 会尝试异步解析直链。 */
function getOffscreenVideo(pageVideo: HTMLVideoElement): HTMLVideoElement | null {
  if (_offscreenVideo) return _offscreenVideoReady ? _offscreenVideo : null;
  // 已在初始化中（blob URL 异步解析），等待后续调用
  if (_offscreenVideoInit) return null;

  let src = pageVideo.currentSrc || pageVideo.src;
  if (!src) return null;

  // blob/data URL → 异步尝试 resolve 直链
  if (src.startsWith('blob:') || src.startsWith('data:')) {
    _offscreenVideoInit = (async () => {
      const realUrl = await resolveBilibiliVideoUrl();
      if (!realUrl) return;
      const video = document.createElement('video');
      video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;pointer-events:none';
      video.crossOrigin = 'anonymous';
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      video.loop = false;
      video.setAttribute('width', String(pageVideo.videoWidth));
      video.setAttribute('height', String(pageVideo.videoHeight));
      video.addEventListener('loadedmetadata', () => { _offscreenVideoReady = true; }, { once: true });
      video.addEventListener('error', () => { /* 静默 */ }, { once: true });
      video.src = realUrl;
      video.load();
      document.body.appendChild(video);
      _offscreenVideo = video;
      // 5s 超时
      setTimeout(() => { if (!_offscreenVideoReady) _offscreenVideoReady = false; }, 5000);
    })();
    return null;
  }

  // 普通 https:// 源 → 直接创建
  const video = document.createElement('video');
  video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;pointer-events:none';
  video.crossOrigin = 'anonymous';
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.loop = false;
  video.setAttribute('width', String(pageVideo.videoWidth));
  video.setAttribute('height', String(pageVideo.videoHeight));
  const onReady = () => { _offscreenVideoReady = true; };
  video.addEventListener('loadedmetadata', onReady, { once: true });
  video.addEventListener('error', () => { /* 静默失败 */ }, { once: true });
  video.src = src;
  video.load();
  document.body.appendChild(video);
  _offscreenVideo = video;
  // 3s 超时标记不可用
  setTimeout(() => { if (!_offscreenVideoReady) _offscreenVideoReady = false; }, 3000);
  return null; // 首次返回 null，后续调用使用就绪的隐藏视频
}

/** 监听 storage 变化 */
export function setupStorageListener(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEYS.RECORDS]) {
      updateRecords(changes[STORAGE_KEYS.RECORDS].newValue || []);
      addVideoTimelineMarkers();
    }
  });
}

/** 监听来自 background/sidebar 的消息 */
export function setupMessageListener(): void {
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    try {
      // ---- 高亮消息 ----
      if (request.action === 'refreshHighlights') {
        loadData().then(() => {
          removeAllHighlights();
          restoreHighlights();
          sendResponse({ success: true });
        });
        return true;
      }

      if (request.action === 'scrollToHighlight') {
        const element =
          document.querySelector(`[data-wa-id="${request.recordId}"]`) ||
          document.querySelector(`[data-wa-image-id="${request.recordId}"]`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          element.classList.add('wa-highlight-flash');
          setTimeout(() => element.classList.remove('wa-highlight-flash'), 1500);
        }
        sendResponse({ success: !!element });
        return true;
      }

      if (request.action === 'updateRecordOrder') {
        (window as any).savedRecordOrder = request.savedOrder || [];
        sendResponse({ success: true });
        return true;
      }

      if (request.action === 'updateRecord') {
        chrome.storage.local.get([STORAGE_KEYS.RECORDS]).then(data => {
          updateRecords(data[STORAGE_KEYS.RECORDS] || []);
          addVideoTimelineMarkers();
        });
        sendResponse({ success: true });
        return true;
      }

      if (request.action === 'deleteHighlight') {
        removeHighlightById(request.recordId);
        sendResponse({ success: true });
        return true;
      }

      // ---- 右键菜单高亮消息 ----
      if (request.action === 'highlightWithDefaultColor') {
        (async () => {
          const sel = window.getSelection();
          if (sel && sel.toString().trim().length > 0 && sel.rangeCount > 0) {
            const { setCurrentSelection } = await import('./state');
            setCurrentSelection({
              text: sel.toString(),
              range: sel.getRangeAt(0).cloneRange(),
            });
            const color = colorConfig.colors.find((c: any) => c.id === colorConfig.defaultColorId) || colorConfig.colors[0];
            await createHighlight(color);
          }
          sendResponse({ success: true });
        })();
        return true;
      }

      if (request.action === 'highlightWithNote') {
        (async () => {
          const sel = window.getSelection();
          if (sel && sel.toString().trim().length > 0 && sel.rangeCount > 0) {
            const { setCurrentSelection } = await import('./state');
            setCurrentSelection({
              text: sel.toString(),
              range: sel.getRangeAt(0).cloneRange(),
            });
            showNotePopup();
          }
          sendResponse({ success: true });
        })();
        return true;
      }

      if (request.action === 'highlightWithColor') {
        (async () => {
          const sel = window.getSelection();
          if (sel && sel.toString().trim().length > 0 && sel.rangeCount > 0) {
            const { setCurrentSelection } = await import('./state');
            setCurrentSelection({
              text: sel.toString(),
              range: sel.getRangeAt(0).cloneRange(),
            });
            const color = colorConfig.colors.find((c: any) => c.id === request.colorId) || colorConfig.colors[0];
            await createHighlight(color);
          }
          sendResponse({ success: true });
        })();
        return true;
      }

      if (request.action === 'seekToVideoTimestamp') {
        const video = document.querySelector('video');
        if (video && request.timestamp !== undefined) {
          video.currentTime = request.timestamp;
          video.play().catch(() => {});
          video.scrollIntoView({ behavior: 'smooth', block: 'center' });
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'No video found' });
        }
        return true;
      }

      // 视频帧截取（Canvas 方案，优先使用隐藏视频不影响页面播放）
      if (request.action === 'captureFrame') {
        const timestamp = request.timestamp;
        if (timestamp === undefined) { sendResponse({ dataUrl: null }); return true; }

        const pageVideo = document.querySelector('video') as HTMLVideoElement | null;
        if (!pageVideo) { sendResponse({ dataUrl: null }); return true; }

        // 尝试使用隐藏视频（如果可用）
        const captureVideo = getOffscreenVideo(pageVideo) || pageVideo;
        const isOffscreen = captureVideo !== pageVideo;

        captureVideo.currentTime = timestamp;
        let resolved = false;
        let retryCount = 0;
        const doCapture = () => {
          if (resolved) return;
          try {
            const canvas = document.createElement('canvas');
            const w = captureVideo.videoWidth;
            const h = captureVideo.videoHeight;
            if (!w || !h) { if (retryCount < 2) { retryCount++; requestAnimationFrame(() => requestAnimationFrame(() => doCapture())); } else { resolved = true; sendResponse({ dataUrl: null }); } return; }
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) { resolved = true; sendResponse({ dataUrl: null }); return; }
            ctx.drawImage(captureVideo, 0, 0);
            // 校验帧是否空白：采样中心区域像素
            const sample = ctx.getImageData(Math.floor(w/2)-10, Math.floor(h/2)-10, 20, 20);
            let sum = 0;
            for (let i = 0; i < sample.data.length; i += 4) {
              sum += sample.data[i] + sample.data[i+1] + sample.data[i+2];
            }
            const avgBrightness = sum / (sample.data.length / 4 * 3);
            if (avgBrightness < 10 && retryCount < 2) {
              retryCount++;
              requestAnimationFrame(() => requestAnimationFrame(() => doCapture()));
              return;
            }
            resolved = true;
            sendResponse({ dataUrl: canvas.toDataURL('image/jpeg', 0.5), isOffscreen });
          } catch (e) {
            resolved = true;
            sendResponse({ dataUrl: null, error: 'canvas', isOffscreen });
          }
        };
        captureVideo.addEventListener('seeked', () => {
          requestAnimationFrame(() => requestAnimationFrame(() => doCapture()));
        }, { once: true });
        setTimeout(() => { if (!resolved) { resolved = true; sendResponse({ dataUrl: null, error: 'timeout', isOffscreen }); } }, 3000);
        return true;
      }

      if (request.action === 'getVideoRect') {
        const video = document.querySelector('video');
        if (video) {
          const rect = video.getBoundingClientRect();
          sendResponse({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
          });
        } else {
          sendResponse({ error: 'No video found' });
        }
        return true;
      }

      if (request.action === 'getPageContext') {
        const currentUrl = location.href;
        const hasVideo = !!document.querySelector('video');
        const isOnBilibiliVideo = location.hostname.includes('bilibili.com') && /\/video\/(BV|av)/.test(location.pathname);
        const isOnYoutubeVideo = (location.hostname.includes('youtube.com') && location.pathname === '/watch') || (location.hostname.includes('youtu.be') && location.pathname !== '/');
        const isVideoPage = isOnBilibiliVideo || isOnYoutubeVideo || (hasVideo && !location.hostname.includes('bilibili.com') && !location.hostname.includes('youtube.com') && !location.hostname.includes('youtu.be'));
        const subtitles = (cachedSubtitles && cachedSubtitlesUrl === currentUrl) ? cachedSubtitles : null;

        if (isVideoPage && subtitles) {
          const content = '## 视频字幕\n\n' + subtitles;
          sendResponse({ title: document.title, url: currentUrl, content, isVideoPage, noSubtitles: false, subtitles });
        } else if (isVideoPage && !subtitles) {
          // 上次已确认无结果（无字幕视频），直接返回 null，不再重复请求
          if (lastSubtitleCached && lastSubtitleUrl === currentUrl) {
            sendResponse({ title: document.title, url: currentUrl, content: '', isVideoPage, noSubtitles: true, subtitles: '' });
            return;
          }
          // 异步抓取字幕
          (async () => {
            const st = await fetchVideoSubtitles();
            if (st) {
              const { updateCachedSubtitles } = await import('./state');
              updateCachedSubtitles(st, currentUrl);
            } else {
              lastSubtitleCached = true;
              lastSubtitleUrl = currentUrl;
            }
            const content = st ? ('## 视频字幕\n\n' + st) : '';
            sendResponse({ title: document.title, url: currentUrl, content, isVideoPage, noSubtitles: !!isVideoPage && !st, subtitles: st || '' });
            chrome.runtime.sendMessage({ action: 'subtitlesReady', hasSubtitles: !!st }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
          })();
        } else {
          // 普通页面 → Readability 提取正文
          try {
            const title = document.title;
            const content = getPageText();
            sendResponse({ title, url: currentUrl, content, isVideoPage: false, noSubtitles: false, subtitles: '' });
          } catch (_) {
            sendResponse({ title: document.title, url: currentUrl, content: document.body.innerText.slice(0, 5000), isVideoPage: false, noSubtitles: false, subtitles: '' });
          }
        }
        return true;
      }

      // ---- 其他消息 ----
      // saveSnapshotToLocal → 已迁移到 background
      // captureVideoFrame → sidebar 通过 scripting.executeScript 实现

      if (request.action === 'getPageImages') {
        extractPageImages().then((images) => {
          sendResponse({ images });
        });
        return true;
      }

    } catch (_) {
      // 忽略错误
    }
  });
}

// ===== URL 变化检测 =====
// 依赖 content-hook.js（MAIN world）拦截 pushState/replaceState 后通过
// __knowseek_urlchange 自定义事件通知隔离世界（DOM 事件可以跨世界传递）

export function setupUrlChangeDetection(): void {
  // 接收主世界（MAIN world）的 URL 变化通知
  window.addEventListener('__knowseek_urlchange', ((e: CustomEvent) => {
    chrome.storage.local.set({
      _pageUrlChanged: { url: e.detail.url, title: e.detail.title, time: Date.now() }
    }).catch(() => {});
  }) as EventListener);

  // popstate 事件可以跨隔离世界传递 — 处理浏览器前进/后退
  //（也作为 content-hook.js 的 popstate 监听的冗余备份）
  let lastUrl = location.href;
  window.addEventListener('popstate', () => {
    const now = location.href;
    if (now !== lastUrl) {
      lastUrl = now;
      chrome.storage.local.set({ _pageUrlChanged: { url: now, title: document.title, time: Date.now() } }).catch(() => {});
    }
  });
}