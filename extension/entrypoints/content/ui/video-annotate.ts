// =========== 视频标注按钮 ===========
// 鼠标悬停视频时显示标注和 AI 按钮

import { generateId, safeSendMessage } from '../utils';
import { records, STORAGE_KEYS, cachedSubtitles } from '../state';

let videoAnnotateBtn: HTMLElement | null = null;
let videoBtnScrollHandler: (() => void) | null = null;
let hoveredVideo: HTMLVideoElement | null = null;

/** 显示视频标注按钮 */
export function showVideoAnnotateButton(video: HTMLVideoElement): void {
  hideVideoAnnotateButton();
  hoveredVideo = video;

  const group = document.createElement('div');
  group.className = 'wa-image-btn-group';

  function positionGroup() {
    const rect = video.getBoundingClientRect();
    group.style.top = (rect.top + window.scrollY + 6) + 'px';
    group.style.left = (rect.left + (rect.width - 80) / 2 + window.scrollX) + 'px';
  }
  positionGroup();

  videoBtnScrollHandler = () => positionGroup();
  window.addEventListener('scroll', videoBtnScrollHandler, { passive: true });

  const annotateBtn = document.createElement('div');
  annotateBtn.className = 'wa-image-annotate-btn';
  annotateBtn.textContent = '✏️';
  annotateBtn.title = '在此时间点添加笔记';
  annotateBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    await annotateVideoFrame(video);
  });
  group.appendChild(annotateBtn);

  const aiBtn = document.createElement('div');
  aiBtn.className = 'wa-image-annotate-btn';
  aiBtn.textContent = '🤖';
  aiBtn.title = '发送到 AI 对话（带字幕）';
  aiBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    group.remove();
    await sendVideoToChat(video);
  });
  group.appendChild(aiBtn);

  document.body.appendChild(group);
  videoAnnotateBtn = group;
}

/** 隐藏视频标注按钮 */
export function hideVideoAnnotateButton(): void {
  if (videoBtnScrollHandler) {
    window.removeEventListener('scroll', videoBtnScrollHandler);
    videoBtnScrollHandler = null;
  }
  if (videoAnnotateBtn) {
    videoAnnotateBtn.remove();
    videoAnnotateBtn = null;
  }
  hoveredVideo = null;
}

/** 检查是否点击在视频按钮上 */
export function isVideoButtonClick(target: EventTarget | null): boolean {
  return videoAnnotateBtn !== null && videoAnnotateBtn.contains(target as Node);
}

/** 检查目标是否在 hoveredVideo 上 */
export function isHoveredVideo(target: EventTarget | null): boolean {
  return hoveredVideo !== null && (target === hoveredVideo || hoveredVideo.contains(target as Node));
}

/** 发送视频帧到 AI 对话 */
async function sendVideoToChat(video: HTMLVideoElement): Promise<void> {
  let dataUrl: string | null = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || video.width || 640;
    canvas.height = video.videoHeight || video.height || 360;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  } catch (_) {}

  const subtitles = cachedSubtitles || '';

  const pendingData: any = {
    action: 'sendVideoToChat',
    dataUrl: dataUrl,
    name: '视频帧',
    pageTitle: document.title,
    pageUrl: location.href,
    subtitles: subtitles
  };
  try { chrome.storage.local.set({ pendingVideoToChat: pendingData }); } catch (_) {}

  chrome.runtime.sendMessage({ action: 'openSidebar' }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
  chrome.runtime.sendMessage(pendingData, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });

  hideVideoAnnotateButton();
}

/** 标注视频帧 */
async function annotateVideoFrame(video: HTMLVideoElement): Promise<void> {
  const id = generateId();
  const timestamp = Math.floor(video.currentTime);

  let dataUrlForText = '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || video.width || 320;
    canvas.height = video.videoHeight || video.height || 180;
    try { video.crossOrigin = 'anonymous'; } catch (_) {}
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    dataUrlForText = canvas.toDataURL('image/jpeg', 0.6);
  } catch (_) {}

  if (dataUrlForText) {
    chrome.runtime.sendMessage({
      action: 'saveVideoFrame',
      recordId: id,
      dataUrl: dataUrlForText
    }, () => { if (chrome.runtime.lastError) return; });
  }

  const mins = Math.floor(timestamp / 60);
  const secs = timestamp % 60;
  const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  const record: any = {
    id,
    url: window.location.href,
    type: 'image',
    page_title: document.title,
    page_icon: getFavicon(),
    description: `⏱ ${timeStr}`,
    snapshot: '',
    select_info: JSON.stringify({ videoTimestamp: timestamp }),
    text: dataUrlForText,
    is_favorite: false,
    color: { id: 'video-annotation', bg: '#fef3c7', text: '#92400e' },
    created_at: Date.now(),
    updated_at: Date.now(),
    videoTimestamp: timestamp
  };

  records.unshift(record);
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.RECORDS]: records });
  } catch (_) {}

  video.dataset.waVideoId = id;
  hideVideoAnnotateButton();

  setTimeout(() => {
    // Import and call addVideoTimelineMarkers dynamically
    import('../highlights/highlight-restore').then(m => m.addVideoTimelineMarkers());
  }, 100);

  safeSendMessage({ action: 'recordCreated', record });
}

function getFavicon(): string {
  const selectors = [
    "link[rel='icon']", "link[rel='shortcut icon']", "link[rel='apple-touch-icon']",
    "link[rel='apple-touch-icon-precomposed']", "link[rel='mask-icon']", "link[rel='fluid-icon']"
  ];
  for (const selector of selectors) {
    const link = document.querySelector(selector) as HTMLLinkElement;
    if (link && link.href) return link.href;
  }
  return window.location.origin + '/favicon.ico';
}

/** 设置视频监听 */
export function setupVideoListeners(): void {
  document.addEventListener('mouseover', (e) => {
    const video = (e.target as HTMLElement).closest('video') as HTMLVideoElement;
    if (video && !video.closest('.wa-image-annotate-btn, .wa-toolbar, .wa-edit-popup, .wa-video-note-popup')) {
      showVideoAnnotateButton(video);
    }
  });

  document.addEventListener('mouseout', (e) => {
    const video = (e.target as HTMLElement).closest('video');
    const btn = (e.target as HTMLElement).closest('.wa-image-btn-group, .wa-image-annotate-btn');
    const target = video || btn;
    if (!target) return;
    setTimeout(() => {
      const mx = (e as MouseEvent).clientX, my = (e as MouseEvent).clientY;
      const el = document.elementFromPoint(mx, my);
      const overVideo = el && el.closest('video');
      const overBtn = el && el.closest('.wa-image-btn-group');
      if (!overVideo && !overBtn) hideVideoAnnotateButton();
    }, 120);
  });

  document.addEventListener('click', (e) => {
    if (!(e as MouseEvent).altKey) return;
    const video = (e.target as HTMLElement).closest('video') as HTMLVideoElement;
    if (video) {
      e.preventDefault();
      annotateVideoFrame(video);
    }
  });
}