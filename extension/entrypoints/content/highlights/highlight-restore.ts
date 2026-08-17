// =========== 高亮恢复 ===========
// 恢复已保存的高亮到 DOM 中

import { records } from '../state';
import { parseSelectInfo, findAndHighlight } from './highlight-position';

let failedRecordIds = new Set<string>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let mutationObserver: MutationObserver | null = null;

/** 轮询重试次数和延迟 */
const POLL_RETRIES = [1000, 2000, 5000, 10000, 20000];

/** 恢复单个高亮 */
export function restoreHighlight(record: any, customRoot?: Document | Element): boolean {
  try {
    const selectInfo = parseSelectInfo(record.select_info, record.text);
    const found = findAndHighlight(selectInfo, record.id, record.color, customRoot);
    if (!found && !customRoot) {
      failedRecordIds.add(record.id);
    }
    return found;
  } catch (_) {
    if (!customRoot) failedRecordIds.add(record.id);
    return false;
  }
}

/** 恢复当前页面的所有高亮 */
export function restoreHighlights(): void {
  const url = window.location.href;
  const urlRecords = records.filter((r: any) => r.url === url && r.type === 'text');
  console.log(`[KnowSeek] restoreHighlights: records=${records.length}, urlRecords=${urlRecords.length}, url=${url}`);
  if (urlRecords.length === 0) {
    if (records.length > 0) {
      // 有记录但 URL 不匹配，打印第一个记录 URL 对比
      console.log('[KnowSeek] URL mismatch sample:', records[0].url, 'vs', url);
    }
    return;
  }

  const failedRecords: any[] = [];
  urlRecords.forEach((record: any) => {
    if (!restoreHighlight(record)) {
      failedRecords.push(record);
    }
  });

  if (failedRecords.length > 0) {
    console.log(`[KnowSeek] restoreHighlights: ${failedRecords.length}/${urlRecords.length} 失败，将在 Shadow DOM 中重试`);
    setTimeout(() => retryInShadowRoots(failedRecords), 500);
  } else {
    console.log(`[KnowSeek] restoreHighlights: ${urlRecords.length} 个高亮全部恢复成功`);
  }
}

/** 在 Shadow DOM 中重试 */
function retryInShadowRoots(records: any[]): void {
  const hosts = document.querySelectorAll('*');
  for (const host of hosts) {
    if (!(host as any).shadowRoot) continue;
    const shadowRecords = records.filter(r => !document.querySelector(`[data-wa-id="${r.id}"]`));
    if (shadowRecords.length === 0) break;
    shadowRecords.forEach(record => {
      restoreHighlight(record, (host as any).shadowRoot);
    });
  }
}

/** 设置 MutationObserver 自动重试失败的高亮 */
export function setupMutationRetry(): void {
  if (!document.body) {
    setTimeout(setupMutationRetry, 1000);
    return;
  }
  try {
    mutationObserver = new MutationObserver(() => {
      if (failedRecordIds.size === 0) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(retryFailedHighlights, 2000);
    });
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  } catch (_) {}

  // 轮询兜底：递增延迟重试，覆盖动态加载延迟较大的情况
  if (failedRecordIds.size > 0) {
    startPollingRetry();
  }

  // 延迟检查：应对 SPA 框架渐进式渲染导致高亮被移除的情况
  // 有限次数检查，避免持续闪烁
  scheduleIntegrityChecks();
}

/** 有限次数的延迟完整性检查（应对 SPA 框架重渲染移除高亮） */
function scheduleIntegrityChecks(): void {
  const CHECKS = [5000, 15000, 30000, 60000]; // 5s, 15s, 30s, 60s 各检查一次

  CHECKS.forEach(delay => {
    setTimeout(() => {
      const url = window.location.href;
      const urlRecords = records.filter((r: any) => r.url === url && r.type === 'text');
      if (urlRecords.length === 0) return;

      urlRecords.forEach(record => {
        const exists = document.querySelector(`[data-wa-id="${CSS.escape(record.id)}"]`);
        if (!exists) {
          console.log(`[KnowSeek] 延迟检查: 高亮 ${record.id} 缺失，尝试恢复`);
          restoreHighlight(record);
        }
      });
    }, delay);
  });
}

/** 轮询兜底重试 */
function startPollingRetry(): void {
  let attempt = 0;
  function poll() {
    if (failedRecordIds.size === 0) return;
    if (attempt >= POLL_RETRIES.length) {
      console.log('[KnowSeek] 高亮恢复轮询结束，剩余失败:', failedRecordIds.size);
      return;
    }
    const delay = POLL_RETRIES[attempt++];
    retryTimer = setTimeout(() => {
      retryFailedHighlights();
      poll();
    }, delay);
  }
  poll();
}

/** 重试失败的高亮 */
function retryFailedHighlights(): void {
  if (failedRecordIds.size === 0) return;
  const toRetry = [...failedRecordIds];
  failedRecordIds.clear();

  toRetry.forEach(id => {
    const record = records.find((r: any) => r.id === id);
    if (record && record.url === window.location.href) {
      restoreHighlight(record);
    }
  });
}

/** 恢复图片标注 */
export function restoreImageAnnotations(): void {
  const imageRecords = records.filter((r: any) => r.url === window.location.href && r.type === 'image');
  imageRecords.forEach((record: any) => {
    try {
      const info = JSON.parse(record.select_info || '{}');
      const imageUrl = info.imageUrl;
      if (!imageUrl) return;
      Array.from(document.querySelectorAll('img')).forEach(img => {
        const src = (img as HTMLImageElement).currentSrc || img.getAttribute('src') || '';
        if (src === imageUrl || decodeURIComponent(src) === decodeURIComponent(imageUrl)) {
          img.dataset.waImageId = record.id;
          img.classList.add('wa-image-annotated');
        }
      });
    } catch (_) {}
  });
}

/** 恢复视频标注 */
export function restoreVideoAnnotations(): void {
  const tryAddMarkers = () => {
    const video = document.querySelector('video');
    if (video && video.duration) {
      addVideoTimelineMarkers();
    } else {
      const v = document.querySelector('video');
      if (v) {
        v.addEventListener('loadedmetadata', () => addVideoTimelineMarkers(), { once: true });
      }
    }
  };
  setTimeout(tryAddMarkers, 1500);

  const video = document.querySelector('video');
  if (video) {
    video.addEventListener('timeupdate', () => {
      addVideoTimelineMarkers();
    }, { once: true });
  }
}

/** 在视频进度条上添加时间戳标记 */
export function addVideoTimelineMarkers(): void {
  document.querySelectorAll('.wa-timeline-marker, .wa-timeline-note-popup').forEach(el => el.remove());

  const currentVideoUrl = (() => {
    try { const u = new URL(window.location.href); return u.hostname + u.pathname; }
    catch (_) { return window.location.href; }
  })();
  const videoRecords = records.filter((r: any) => {
    if (r.videoTimestamp === undefined || r.videoTimestamp < 0) return false;
    try { const u = new URL(r.url); return u.hostname + u.pathname === currentVideoUrl; }
    catch (_) { return r.url === window.location.href; }
  });
  if (videoRecords.length === 0) return;

  const video = document.querySelector('video');
  if (!video || !video.duration) return;

  const progressContainer = findVideoProgressBar();
  let container = progressContainer;
  if (!container) {
    const videoRect = video.getBoundingClientRect();
    if (videoRect.width === 0) return;
    const fallbackBar = document.createElement('div');
    fallbackBar.className = 'wa-timeline-fallback-bar';
    fallbackBar.style.cssText = `position:absolute;bottom:0;left:0;width:100%;height:20px;z-index:2147483646;pointer-events:auto;`;
    const parent = video.parentElement || video.offsetParent;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.appendChild(fallbackBar);
      container = fallbackBar;
    } else {
      return;
    }
  }

  if (container.querySelector('.wa-timeline-marker')) return;

  const style = getComputedStyle(container);
  if (style.position === 'static') container.style.position = 'relative';

  videoRecords.forEach((record: any) => {
    const pct = (record.videoTimestamp / video.duration) * 100;
    if (pct < 0 || pct > 100) return;

    const marker = document.createElement('div');
    marker.className = 'wa-timeline-marker';
    marker.style.left = pct + '%';
    marker.dataset.recordId = record.id;

    const icon = document.createElement('img');
    try {
      icon.src = chrome.runtime.getURL('icons/pencil.svg');
    } catch (_) {
      return;
    }
    icon.alt = '';
    icon.style.cssText = 'width:12px;height:12px;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none;';
    marker.appendChild(icon);

    marker.addEventListener('mouseenter', () => {
      const r = records.find((x: any) => x.id === record.id);
      if (r) showTimelineNoteTooltip(marker, r);
    });
    marker.addEventListener('mouseleave', () => hideTimelineNoteTooltip());

    marker.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ action: 'navigateToRecord', recordId: record.id }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
      chrome.runtime.sendMessage({ action: 'openSidebar' }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
      setTimeout(() => {
        chrome.runtime.sendMessage({ action: 'locateRecord', recordId: record.id }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
      }, 300);
    });

    container.appendChild(marker);
  });
}

/** 查找视频进度条元素 */
function findVideoProgressBar(): Element | null {
  const highPriority = [
    '.ytp-progress-bar',
    '.bpx-player-video-progress',
    '.vjs-progress-holder',
    '.jw-progress',
    '.mejs__time-total',
  ];
  for (const sel of highPriority) {
    const el = document.querySelector(sel);
    if (el && (el as HTMLElement).offsetParent !== null) return el;
  }

  const hosts = document.querySelectorAll('#movie_player, ytp-player, .video-player, [class*="player"]');
  for (const host of hosts) {
    if ((host as any).shadowRoot) {
      for (const sel of highPriority) {
        const el = (host as any).shadowRoot.querySelector(sel);
        if (el) return el;
      }
      for (const sel of ['[role="slider"]', 'input[type="range"]', 'progress', '[class*="progress"]']) {
        const el = (host as any).shadowRoot.querySelector(sel);
        if (el && (el as HTMLElement).getBoundingClientRect().height >= 4) return el;
      }
    }
  }

  const genericSelectors = [
    'input[type="range"]',
    '[role="slider"]',
    'progress',
    '.seek-bar',
    '.video-progress-bar',
    '.progress-bar',
    '.timeline-bar',
    '[class*="progress"]',
    '[class*="timeline"]',
    '[class*="seek"]',
    '[class*="scrubber"]',
  ];

  for (const sel of genericSelectors) {
    const el = document.querySelector(sel);
    if (el && (el as HTMLElement).offsetParent !== null && (el as HTMLElement).getBoundingClientRect().height >= 4) return el;
  }

  return null;
}

/** 显示时间轴标记的笔记预览 */
function showTimelineNoteTooltip(marker: Element, record: any): void {
  hideTimelineNoteTooltip();

  chrome.storage.local.get(['records']).then(data => {
    const allRecords = data.records || [];
    const latest = allRecords.find((r: any) => r.id === record.id) || record;

    const popup = document.createElement('div');
    popup.className = 'wa-edit-popup wa-timeline-note-popup';
    popup.innerHTML = `
      <div class="wa-edit-popup-header">
        <span class="wa-edit-popup-title">视频笔记</span>
        <button class="wa-edit-popup-close" title="关闭">&times;</button>
      </div>
      <div class="wa-edit-popup-body">
        <div class="wa-edit-popup-time">${new Date(latest.created_at).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
        <div class="wa-edit-popup-md">${renderMarkdown(latest.description || '') || '(无笔记)'}</div>
      </div>
    `;

    document.body.appendChild(popup);

    const closeBtn = popup.querySelector('.wa-edit-popup-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideTimelineNoteTooltip();
      });
    }

    const rect = marker.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - popupRect.width / 2;
    let top = rect.top - popupRect.height - 8;
    if (top < 0) top = rect.bottom + 8;
    if (left < 4) left = 4;
    if (left + popupRect.width > window.innerWidth - 4) left = window.innerWidth - popupRect.width - 4;
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
  });
}

/** 隐藏时间轴标记弹窗 */
function hideTimelineNoteTooltip(): void {
  document.querySelector('.wa-timeline-note-popup')?.remove();
}

/** 渲染 Markdown */
function renderMarkdown(text: string): string {
  if (!text) return '<p style="color:#9ca3af;font-style:italic">暂无笔记</p>';

  const imagePlaceholders: string[] = [];
  let placeholderIndex = 0;
  const tempPlaceholderRegex = /!\[图片\]\(snapshot:([^\)]+)\)/g;
  text = text.replace(tempPlaceholderRegex, (match, snapshotId) => {
    imagePlaceholders.push(snapshotId);
    return `%%IMAGE_PLACEHOLDER_${placeholderIndex++}%%`;
  });

  let html = (window as any).marked?.parse(text, { breaks: true, gfm: true }) || text;

  html = html.replace(/%%IMAGE_PLACEHOLDER_(\d+)%%/g, (_, idx) => {
    const snapshotId = imagePlaceholders[parseInt(idx)];
    return `<img data-snapshot-id="${snapshotId}" class="content-paste-image-loading" alt="图片加载中..." style="max-width:100%;margin:8px 0;display:block;min-height:40px;">`;
  });

  return html;
}