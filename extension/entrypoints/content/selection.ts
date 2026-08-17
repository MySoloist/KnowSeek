// =========== 文本选择处理 ===========
// 鼠标事件处理、径向菜单、颜色选择器、AI 卡片

import { currentSelection, setCurrentSelection, colorConfig, cachedSubtitles, cachedSubtitlesUrl } from './state';
import { createHighlight, HighlightColor } from './highlights/highlight-core';
import { getPageContentForAI } from './page-context';
import { showNotePopup, hideNotePopup, isNotePopupClick } from './ui/note-popup';
import { showHighlightTooltip, hideTooltip, isTooltipClick } from './ui/tooltip';
import { hideImageAnnotateButton, isImageButtonClick, getHoveredImage, isHoveredImage } from './ui/image-annotate';
import { hideVideoAnnotateButton, isVideoButtonClick } from './ui/video-annotate';

let toolbar: HTMLElement | null = null;
let colorPicker: HTMLElement | null = null;

// ====== 鼠标事件 ======

/** 处理 mousedown（关闭弹出层） */
export function handleMouseDown(e: MouseEvent): void {
  if (toolbar && !toolbar.contains(e.target as Node)) {
    hideToolbarElements();
  }
  if (colorPicker && !colorPicker.contains(e.target as Node)) {
    hideColorPicker();
  }
  if (isNotePopupClick(e.target)) return;
  hideNotePopup();
  if (isTooltipClick(e.target)) return;
  hideTooltip();
}

/** 处理 mouseup（显示工具栏） */
export function handleMouseUp(e: MouseEvent): void {
  const selection = window.getSelection();
  const selText = selection ? selection.toString().trim() : '';

  if (selection && selText.length > 0 && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0).cloneRange();
    let rect: DOMRect | null = null;
    try {
      rect = range.getBoundingClientRect();
    } catch (_) {
      rect = null;
    }

    if (rect && rect.width > 0) {
      if ((e.target as HTMLElement).closest('.wa-toolbar')) return;

      requestAnimationFrame(() => {
        const currentSel = window.getSelection();
        if (currentSel && currentSel.toString().trim().length > 0) {
          showToolbar(rect!, currentSel);
        }
      });
      return;
    }
  }

  // 处理在高亮/标注上的点击
  setTimeout(() => {
    const highlightEl = (e.target as HTMLElement).closest('.wa-highlight');
    if (highlightEl) {
      showHighlightTooltip(highlightEl, e);
    } else {
      const annotatedImg = (e.target as HTMLElement).closest('img.wa-image-annotated');
      if (annotatedImg) {
        showHighlightTooltip(annotatedImg, e);
      }
    }
  }, 10);
}

// ====== 工具栏（径向菜单） ======

function showToolbar(rect: DOMRect, selection: Selection): void {
  hideToolbarElements();
  setCurrentSelection({
    text: selection.toString(),
    range: selection.getRangeAt(0).cloneRange(),
  });

  toolbar = document.createElement('div');
  toolbar.className = 'wa-toolbar wa-radial-menu';
  toolbar.style.position = 'fixed';
  toolbar.style.zIndex = '2147483647';
  toolbar.style.pointerEvents = 'auto';
  toolbar.style.opacity = '0';
  toolbar.style.transition = 'opacity 0.15s ease';

  const L1_RADIUS = 38;
  const l1Items = [
    { mode: 'highlight', icon: '✏️', title: '仅标注', angle: 45 },
    { mode: 'ai', icon: '🤖', title: '仅AI', angle: 135 },
  ];

  l1Items.forEach(({ mode, icon, title, angle }) => {
    const btn = document.createElement('button');
    btn.className = 'wa-l1-btn';
    btn.dataset.mode = mode;
    btn.textContent = icon;
    btn.title = title;
    btn.style.setProperty('--angle', angle + 'deg');
    btn.style.setProperty('--radius', L1_RADIUS + 'px');

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onL1Click(mode);
    });

    toolbar.appendChild(btn);
  });

  document.body.appendChild(toolbar);

  const tw = 160, th = 160;
  let finalTop = rect.top - th - 8;
  if (finalTop < 8) finalTop = rect.bottom + 8;
  let left = rect.left + rect.width / 2 - tw / 2;

  toolbar.style.width = tw + 'px';
  toolbar.style.height = th + 'px';
  toolbar.style.top = finalTop + 'px';
  toolbar.style.left = left + 'px';
  toolbar.style.opacity = '1';

  requestAnimationFrame(() => {
    toolbar!.querySelectorAll('.wa-l1-btn').forEach((btn, i) => {
      (btn as HTMLElement).style.transition = 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
      (btn as HTMLElement).style.transitionDelay = (i * 0.06) + 's';
      (btn as HTMLElement).style.opacity = '1';
      (btn as HTMLElement).style.transform = 'translate(-50%, -50%) rotate(var(--angle)) translateX(var(--radius)) rotate(calc(-1 * var(--angle))) scale(1)';
    });
  });
}

function onL1Click(mode: string): void {
  if (mode === 'highlight') {
    const defaultColor = getDefaultColor();
    createHighlight(defaultColor);
    hideToolbarElements();
    window.getSelection()?.removeAllRanges();
    return;
  }

  // AI 模式
  const text = currentSelection!.text;
  const pageContent = getPageContentForAI();
  const pendingData = {
    action: 'addToChat',
    text,
    pageTitle: document.title,
    pageUrl: location.href,
    pageContent
  };
  try { chrome.storage.local.set({ pendingAddToChat: pendingData }); } catch (_) {}

  chrome.runtime.sendMessage({ action: 'openSidebar' }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
  chrome.runtime.sendMessage(pendingData, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });

  hideToolbarElements();
  window.getSelection()?.removeAllRanges();
}

function getDefaultColor(): HighlightColor {
  return (colorConfig && colorConfig.colors.find((c: any) => c.id === colorConfig.defaultColorId)) || colorConfig?.colors?.[0] || { id: 'color-12', bg: '#166534', text: '#ffffff' };
}

// ====== 颜色选择器 ======

function toggleColorPicker(): void {
  if (colorPicker) {
    hideColorPicker();
  } else {
    showColorPicker();
  }
}

function showColorPicker(): void {
  hideColorPicker();
  if (!toolbar || !colorConfig) return;

  colorPicker = document.createElement('div');
  colorPicker.className = 'wa-color-picker';

  colorConfig.colors.forEach((color: any) => {
    const option = document.createElement('div');
    option.className = 'wa-color-option';
    option.style.backgroundColor = color.bg;
    option.title = color.id;
    if (color.id === colorConfig.defaultColorId) {
      option.classList.add('active');
    }
    option.addEventListener('click', (e) => {
      e.stopPropagation();
      createHighlight(color);
      hideColorPicker();
    });
    colorPicker!.appendChild(option);
  });

  toolbar.appendChild(colorPicker);
}

function hideColorPicker(): void {
  if (colorPicker) {
    colorPicker.remove();
    colorPicker = null;
  }
}

// ====== AI 悬浮卡片 ======

export async function showAiFloatingCard(aiAction: string, text: string): Promise<void> {
  hideToolbarElements();
  window.getSelection()?.removeAllRanges();

  const card = document.createElement('div');
  card.className = 'wa-ai-result-card';
  card.style.position = 'fixed';
  card.style.zIndex = '2147483647';

  const actionLabels: Record<string, string> = { summarize: '📝 总结', translate: '🌐 翻译', explain: '💡 解释' };
  const header = document.createElement('div');
  header.className = 'wa-ai-result-header';
  header.innerHTML = `<span>🤖 ${actionLabels[aiAction] || aiAction}</span>`;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'wa-ai-result-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => card.remove());
  header.appendChild(closeBtn);
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'wa-ai-result-body';
  body.textContent = '⏳ 处理中...';
  card.appendChild(body);

  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    card.style.maxWidth = '360px';
    let top = rect.top - 10;
    let left = rect.left;
    if (top < 10) top = rect.bottom + 10;
    if (left + 360 > window.innerWidth - 10) left = window.innerWidth - 370;
    if (left < 10) left = 10;
    card.style.top = top + 'px';
    card.style.left = left + 'px';
  } else {
    card.style.top = '100px';
    card.style.left = '20px';
  }

  document.body.appendChild(card);

  const result = await callAiBackend(aiAction, text);
  if (result) {
    body.textContent = result;
  } else {
    body.textContent = '⚠️ AI 处理失败，请检查后端和 AI 配置';
  }
}

function callAiBackend(aiAction: string, text: string): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['backend_url'], (config: any) => {
      if (!config.backend_url) { resolve(null); return; }
      chrome.runtime.sendMessage({
        action: 'backendRequest',
        endpoint: '/api/' + aiAction,
        method: 'POST',
        body: { text, record_id: 'ai_only_' + Date.now() }
      }, (response: any) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        if (response && response.data && response.data.data && response.data.data[aiAction]) {
          resolve(response.data.data[aiAction]);
        } else {
          resolve(null);
        }
      });
    });
  });
}

// ====== 清理 ======

function closeAiMenu(): void {
  if (!toolbar) return;
  const l1Btns = toolbar.querySelectorAll('.wa-l1-btn');
  const l2Btns = toolbar.querySelectorAll('.wa-l2-btn');
  l1Btns.forEach(b => b.classList.remove('active'));
  l2Btns.forEach(b => b.classList.add('hidden'));
}

function hideToolbarElements(): void {
  if (toolbar) {
    closeAiMenu();
    toolbar.remove();
    toolbar = null;
  }
  hideColorPicker();
  setCurrentSelection(null);
}

/** 设置文本选择相关事件监听 */
export function setupSelectionListeners(): void {
  document.addEventListener('mouseup', handleMouseUp);
  document.addEventListener('mousedown', handleMouseDown);
  document.addEventListener('scroll', hideToolbarElements, true);
  window.addEventListener('resize', hideToolbarElements);

  window.addEventListener('beforeunload', () => {
    hideToolbarElements();
    hideColorPicker();
    hideNotePopup();
    hideTooltip();
  });
}