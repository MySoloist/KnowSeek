// =========== 高亮气泡提示 ===========
// 点击高亮时显示编辑弹窗

import { records } from '../state';

let tooltip: HTMLElement | null = null;
let activeHighlightId: string | null = null;

/** 显示高亮提示 */
export function showHighlightTooltip(highlightEl: Element, e: MouseEvent): void {
  const recordId = (highlightEl as HTMLElement).dataset.waId || (highlightEl as HTMLElement).dataset.waImageId;
  const record = records.find((r: any) => r.id === recordId);
  if (!record) return;

  hideTooltip();
  activeHighlightId = recordId;

  tooltip = document.createElement('div');
  tooltip.className = 'wa-edit-popup';
  tooltip.innerHTML = `
    <div class="wa-edit-popup-header">
      <span class="wa-edit-popup-title">笔记</span>
      <button class="wa-edit-popup-close" title="关闭">&times;</button>
    </div>
    <div class="wa-edit-popup-body">
      <div class="wa-edit-popup-time">${new Date(record.created_at).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
      <div class="wa-edit-popup-md">${renderMarkdown(record.description || '')}</div>
    </div>
  `;

  document.body.appendChild(tooltip);

  loadPasteImagesAsync(tooltip);

  const closeBtn = tooltip.querySelector('.wa-edit-popup-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTooltip();
    });
  }

  tooltip.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { chrome.runtime.sendMessage({ action: 'openSidebar' }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } }); } catch (_) {}
    setTimeout(() => {
      try {
        chrome.runtime.sendMessage({
          action: 'locateRecord',
          recordId: recordId,
          savedOrder: (window as any).savedRecordOrder || []
        }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
      } catch (_) {}
    }, 300);
    hideTooltip();
  });

  tooltip.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  const rect = highlightEl.getBoundingClientRect();
  const popupRect = tooltip.getBoundingClientRect();
  let top = rect.top - popupRect.height - 8;
  let left = rect.left + rect.width / 2 - popupRect.width / 2;

  if (top < 8) top = rect.bottom + 8;
  if (left < 8) left = 8;
  if (left + popupRect.width > window.innerWidth - 8) left = window.innerWidth - popupRect.width - 8;

  tooltip.style.top = top + 'px';
  tooltip.style.left = left + 'px';
}

/** 隐藏提示 */
export function hideTooltip(): void {
  if (tooltip) {
    tooltip.remove();
    tooltip = null;
  }
  activeHighlightId = null;
}

/** 检查是否点击在工具提示上 */
export function isTooltipClick(target: EventTarget | null): boolean {
  return tooltip !== null && tooltip.contains(target as Node);
}

/** 异步加载笔记中的粘贴图片 */
async function loadPasteImagesAsync(container: HTMLElement): Promise<void> {
  const imgs = container.querySelectorAll('.content-paste-image-loading');
  if (imgs.length === 0) return;
  for (const img of imgs) {
    const snapshotId = (img as HTMLElement).dataset.snapshotId;
    if (!snapshotId) continue;
    try {
      const response = await new Promise<any>(r => chrome.runtime.sendMessage({ action: 'getPasteImage', snapshotId }, (resp) => {
        if (chrome.runtime.lastError) { r(null); return; }
        r(resp);
      }));
      if (response && response.dataUrl) {
        (img as HTMLImageElement).src = response.dataUrl;
        img.classList.remove('content-paste-image-loading');
      } else {
        img.outerHTML = `<span style="color:#999;font-size:12px;display:inline-block;padding:4px 8px;border:1px dashed #ddd;border-radius:4px;margin:4px 0;">图片不可用 (需在侧边栏中查看)</span>`;
      }
    } catch (_) {
      img.outerHTML = `<span style="color:#999;font-size:12px;display:inline-block;padding:4px 8px;border:1px dashed #ddd;border-radius:4px;margin:4px 0;">图片加载失败</span>`;
    }
  }
}

/** 渲染 Markdown */
function renderMarkdown(text: string): string {
  if (!text) return '<p style="color:#9ca3af;font-style:italic">暂无笔记</p>';

  const imagePlaceholders: string[] = [];
  let placeholderIndex = 0;
  text = text.replace(/!\[图片\]\(snapshot:([^\)]+)\)/g, (_match, snapshotId) => {
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