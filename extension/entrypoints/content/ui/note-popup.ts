// =========== 笔记弹窗 ===========
// 创建高亮时弹出笔记编辑框

import { colorConfig, currentSelection } from '../state';
import { createHighlight } from '../highlights/highlight-core';
import { records, STORAGE_KEYS } from '../state';

let notePopup: HTMLElement | null = null;

/** 显示笔记弹窗（工具栏模式下） */
export function showNotePopup(): void {
  if (notePopup) return;

  hideNotePopup();
  notePopup = document.createElement('div');
  notePopup.className = 'wa-note-popup';

  const header = document.createElement('div');
  header.className = 'wa-note-popup-header';
  header.textContent = '添加笔记';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'wa-note-popup-close';
  closeBtn.innerHTML = '×';
  closeBtn.addEventListener('click', hideNotePopup);
  header.appendChild(closeBtn);
  notePopup.appendChild(header);

  const textarea = document.createElement('textarea');
  textarea.className = 'wa-note-textarea';
  textarea.placeholder = '写下你的笔记...';
  notePopup.appendChild(textarea);

  const footer = document.createElement('div');
  footer.className = 'wa-note-popup-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'wa-btn wa-btn-secondary';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', hideNotePopup);
  const saveBtn = document.createElement('button');
  saveBtn.className = 'wa-btn wa-btn-primary';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', () => {
    const description = textarea.value.trim();
    const defaultColor = (colorConfig && colorConfig.colors.find((c: any) => c.id === colorConfig.defaultColorId)) || colorConfig?.colors?.[0] || { bg: '#166534', text: '#ffffff', id: 'color-12' };
    createHighlight(defaultColor, description);
    hideNotePopup();
  });
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  notePopup.appendChild(footer);

  document.body.appendChild(notePopup);

  // 定位在工具栏下方
  const toolbar = document.querySelector('.wa-toolbar');
  if (toolbar) {
    const toolbarRect = toolbar.getBoundingClientRect();
    notePopup.style.top = (toolbarRect.bottom + 8) + 'px';
    notePopup.style.left = (toolbarRect.left) + 'px';
  }

  textarea.focus();
}

/** 隐藏笔记弹窗 */
export function hideNotePopup(): void {
  if (notePopup) {
    notePopup.remove();
    notePopup = null;
  }
}

/** 检查是否点击在笔记弹窗上 */
export function isNotePopupClick(target: EventTarget | null): boolean {
  return notePopup !== null && notePopup.contains(target as Node);
}

/** 高亮创建后显示笔记弹窗 */
export function showNotePopupAfterHighlight(recordId: string): void {
  hideNotePopup();

  const highlightEl = document.querySelector(`[data-wa-id="${recordId}"]`);
  if (!highlightEl) return;

  notePopup = document.createElement('div');
  notePopup.className = 'wa-note-popup';

  const header = document.createElement('div');
  header.className = 'wa-note-popup-header';
  header.textContent = '添加笔记';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'wa-note-popup-close';
  closeBtn.innerHTML = '×';
  closeBtn.addEventListener('click', hideNotePopup);
  header.appendChild(closeBtn);
  notePopup.appendChild(header);

  const textarea = document.createElement('textarea');
  textarea.className = 'wa-note-textarea';
  textarea.placeholder = '写下你的笔记...';
  notePopup.appendChild(textarea);

  const footer = document.createElement('div');
  footer.className = 'wa-note-popup-footer';
  const skipBtn = document.createElement('button');
  skipBtn.className = 'wa-btn wa-btn-secondary';
  skipBtn.textContent = '跳过';
  skipBtn.addEventListener('click', hideNotePopup);
  const saveBtn = document.createElement('button');
  saveBtn.className = 'wa-btn wa-btn-primary';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', async () => {
    const description = textarea.value.trim();
    if (description) {
      const record = records.find((r: any) => r.id === recordId);
      if (record) {
        record.description = description;
        record.updated_at = Date.now();
        try {
          await chrome.storage.local.set({ [STORAGE_KEYS.RECORDS]: records });
        } catch (_) {}
      }
    }
    hideNotePopup();
  });
  footer.appendChild(skipBtn);
  footer.appendChild(saveBtn);
  notePopup.appendChild(footer);

  if (!document.body.contains(notePopup)) {
    document.body.appendChild(notePopup);
  }

  const rect = highlightEl.getBoundingClientRect();
  const popupRect = notePopup.getBoundingClientRect();
  let top = rect.bottom + 8;
  let left = rect.left;

  if (left + popupRect.width > window.innerWidth - 8) left = window.innerWidth - popupRect.width - 8;
  if (top + popupRect.height > window.innerHeight - 8) top = rect.top - popupRect.height - 8;
  if (top < 8) top = 8;

  notePopup.style.top = top + 'px';
  notePopup.style.left = left + 'px';

  setTimeout(() => textarea.focus(), 50);
}