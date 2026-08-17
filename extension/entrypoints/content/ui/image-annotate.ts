// =========== 图片标注按钮 ===========
// 鼠标悬停图片时显示标注和 AI 按钮

import { generateId, safeSendMessage } from '../utils';
import { records, STORAGE_KEYS } from '../state';

let imageAnnotateBtn: HTMLElement | null = null;
let imageBtnScrollHandler: (() => void) | null = null;
let hoveredImage: HTMLImageElement | null = null;

function getImageAnnotateButtons(): HTMLElement | null {
  return imageAnnotateBtn;
}

/** 显示图片标注按钮 */
export function showImageAnnotateButton(img: HTMLImageElement): void {
  const w = img.offsetWidth || img.naturalWidth || 0;
  const h = img.offsetHeight || img.naturalHeight || 0;
  if (w < 50 || h < 50) return;

  hideImageAnnotateButton();
  hoveredImage = img;

  const group = document.createElement('div');
  group.className = 'wa-image-btn-group';

  function positionGroup() {
    const rect = img.getBoundingClientRect();
    group.style.top = (rect.top + window.scrollY + 6) + 'px';
    group.style.left = (rect.left + window.scrollX + 6) + 'px';
  }
  positionGroup();

  imageBtnScrollHandler = () => positionGroup();
  window.addEventListener('scroll', imageBtnScrollHandler, { passive: true });

  if (!img.dataset.waImageId) {
    const annotateBtn = document.createElement('div');
    annotateBtn.className = 'wa-image-annotate-btn';
    annotateBtn.textContent = '✏️';
    annotateBtn.title = '标注此图片';
    annotateBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      await annotateImage(img);
    });
    group.appendChild(annotateBtn);
  }

  const aiBtn = document.createElement('div');
  aiBtn.className = 'wa-image-annotate-btn';
  aiBtn.textContent = '🤖';
  aiBtn.title = '发给 AI 对话';
  aiBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    group.remove();
    await sendImageToChat(img);
  });
  group.appendChild(aiBtn);

  document.body.appendChild(group);
  imageAnnotateBtn = group;
}

/** 隐藏图片标注按钮 */
export function hideImageAnnotateButton(): void {
  if (imageBtnScrollHandler) {
    window.removeEventListener('scroll', imageBtnScrollHandler);
    imageBtnScrollHandler = null;
  }
  if (imageAnnotateBtn) {
    imageAnnotateBtn.remove();
    imageAnnotateBtn = null;
  }
  hoveredImage = null;
}

/** 检查是否点击在图片按钮上 */
export function isImageButtonClick(target: EventTarget | null): boolean {
  return imageAnnotateBtn !== null && imageAnnotateBtn.contains(target as Node);
}

/** 检查目标是否在 hoveredImage 上 */
export function isHoveredImage(target: EventTarget | null): boolean {
  return hoveredImage !== null && (target === hoveredImage || hoveredImage.contains(target as Node));
}

/** 获取 hoveredImage */
export function getHoveredImage(): HTMLImageElement | null {
  return hoveredImage;
}

/** 标注图片 */
async function annotateImage(img: HTMLImageElement): Promise<void> {
  const id = generateId();
  const imageUrl = img.currentSrc || img.src || '';

  img.dataset.waImageId = id;
  img.classList.add('wa-image-annotated');
  hideImageAnnotateButton();

  const record: any = {
    id,
    url: window.location.href,
    type: 'image',
    page_title: document.title,
    page_icon: getFavicon(),
    description: '',
    snapshot: '',
    select_info: JSON.stringify({ imageUrl }),
    text: imageUrl,
    is_favorite: false,
    color: { id: 'image-annotation', bg: '#e8f4f8', text: '#1a5276' },
    created_at: Date.now(),
    updated_at: Date.now()
  };

  records.unshift(record);
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.RECORDS]: records });
  } catch (_) {}

  safeSendMessage({ action: 'recordCreated', record });

  chrome.runtime.sendMessage({ action: 'captureScreenshot', recordId: id }, () => {
    if (chrome.runtime.lastError) return;
  });
}

/** 发送图片到 AI 对话 */
async function sendImageToChat(img: HTMLImageElement): Promise<void> {
  let dataUrl: string | null = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  } catch (_) {
    dataUrl = img.currentSrc || img.src;
  }

  const pendingData = {
    action: 'addImageToChat',
    dataUrl: dataUrl,
    name: img.alt || '图片',
    pageTitle: document.title,
    pageUrl: location.href
  };
  try { chrome.storage.local.set({ pendingImageToChat: pendingData }); } catch (_) {}

  chrome.runtime.sendMessage({ action: 'openSidebar' }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
  chrome.runtime.sendMessage(pendingData, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });

  hideImageAnnotateButton();
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

/** 设置图片 hover 监听 */
export function setupImageHoverListeners(): void {
  document.addEventListener('mouseover', (e) => {
    const img = (e.target as HTMLElement).closest('img') as HTMLImageElement;
    if (img && !img.closest('[role="dialog"],[role="presentation"],[class*="modal" i],[class*="overlay" i],[class*="lightbox" i],[class*="viewer" i]')) {
      if (!img.closest('.wa-image-annotate-btn, .wa-toolbar, .wa-edit-popup, .wa-note-popup')) {
        showImageAnnotateButton(img);
      }
    }
  });

  document.addEventListener('mouseout', (e) => {
    const img = (e.target as HTMLElement).closest('img');
    if (!img || img !== hoveredImage) {
      setTimeout(() => {
        if (imageAnnotateBtn && hoveredImage) {
          const mx = (e as MouseEvent).clientX, my = (e as MouseEvent).clientY;
          const el = document.elementFromPoint(mx, my);
          const overBtn = el && el.closest('.wa-image-btn-group');
          const overImg = el && el.closest('img');
          const stillOverBtn = overBtn !== null;
          const stillOverImg = overImg !== null && (overImg === hoveredImage || hoveredImage.contains(overImg));
          if (!stillOverBtn && !stillOverImg) hideImageAnnotateButton();
        } else {
          hideImageAnnotateButton();
        }
      }, 100);
    }
  });
}