// =========== 高亮核心操作 ===========
// 创建、移除高亮，构建选择信息

import { generateId, getAnchorContainer, buildDomPath, normalizeText, getNormalizedOffsetFromRange } from '../utils';
import { records, colorConfig, STORAGE_KEYS, currentSelection, updateRecords, safeSendMessage } from '../state';

export interface HighlightColor {
  id: string;
  bg: string;
  text: string;
}

/** 构建选择信息（用于后续恢复高亮） */
export function buildSelectInfo(range: Range, text: string): any {
  const containerElement = getAnchorContainer(range);
  const exact = (text || '').trim();
  const normalizedExact = normalizeText(exact);
  // 从 Range 的实际 DOM 位置计算偏移（精确到用户选中的那一处，而非 indexOf 首次出现）
  const pageText = normalizeText(document.body?.innerText || '');
  const pageIndex = getNormalizedOffsetFromRange(range, document.body);
  const prefix = pageIndex !== -1
    ? pageText.slice(Math.max(0, pageIndex - 200), pageIndex)
    : '';
  const suffix = pageIndex !== -1
    ? pageText.slice(pageIndex + normalizedExact.length, pageIndex + normalizedExact.length + 200)
    : '';
  const containerText = containerElement ? normalizeText(containerElement.innerText || containerElement.textContent || '') : '';
  const containerIndex = containerElement && containerElement !== document.body
    ? getNormalizedOffsetFromRange(range, containerElement)
    : -1;

  const containerPaths: string[] = [];
  if (containerElement) {
    containerPaths.push(buildDomPath(containerElement));
    let parent = containerElement.parentElement;
    let depth = 0;
    while (parent && parent !== document.body && depth < 3) {
      const parentPath = buildDomPath(parent);
      if (parentPath) containerPaths.push(parentPath);
      parent = parent.parentElement;
      depth++;
    }
  }

  let containerTextFingerprint = '';
  if (containerElement && containerIndex >= 0) {
    const fpBefore = containerText.slice(Math.max(0, containerIndex - 150), containerIndex);
    const fpAfter = containerText.slice(
      containerIndex + normalizedExact.length,
      containerIndex + normalizedExact.length + 150
    );
    containerTextFingerprint = (fpBefore + '%%%HL%%%' + fpAfter).slice(0, 400);
  }

  return {
    type: 'text',
    version: 3,
    exact,
    prefix,
    suffix,
    normalizedExact,
    pageTitle: document.title,
    pageUrl: window.location.href,
    textPosition: {
      pageStart: pageIndex,
      pageEnd: pageIndex !== -1 ? pageIndex + normalizedExact.length : -1,
      containerStart: containerIndex,
      containerEnd: containerIndex !== -1 ? containerIndex + normalizedExact.length : -1
    },
    container: containerElement ? {
      tagName: containerElement.tagName,
      id: containerElement.id || '',
      classList: Array.from(containerElement.classList || []).slice(0, 8),
      path: containerPaths[0] || '',
      parentPaths: containerPaths.slice(1),
      textFingerprint: containerTextFingerprint
    } : null,
    select_info: [{
      exact,
      prefix,
      suffix,
      type: 'TextQuoteSelector',
      extra: containerElement ? {
        classList: Array.from(containerElement.classList || []),
        nodeName: containerElement.nodeName,
        firstCssParent: { id: containerElement.id || '' },
        path: containerPaths[0] || ''
      } : {}
    }]
  };
}

/** 包裹 Range 创建高亮元素 */
export function wrapRange(range: Range, id: string, color: HighlightColor): HTMLElement[] {
  const elements: HTMLElement[] = [];

  if (range.collapsed) return elements;

  const startContainer = range.startContainer;
  const endContainer = range.endContainer;

  if (startContainer === endContainer && startContainer.nodeType === Node.TEXT_NODE) {
    const span = document.createElement('span');
    span.className = 'wa-highlight';
    span.dataset.waId = id;
    span.dataset.waIndex = '0';
    span.style.backgroundColor = color.bg;
    span.style.color = color.text;
    try {
      range.surroundContents(span);
      elements.push(span);
    } catch (_) {
      const fragment = range.extractContents();
      span.appendChild(fragment);
      range.insertNode(span);
      elements.push(span);
    }
    return elements;
  }

  const root = (range.commonAncestorContainer.nodeType === Node.TEXT_NODE)
    ? range.commonAncestorContainer.parentElement
    : range.commonAncestorContainer;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || node.nodeValue.trim().length === 0) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  } as NodeFilter);

  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  let idx = 0;
  textNodes.forEach(textNode => {
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(textNode);

    const s = range.compareBoundaryPoints(Range.START_TO_END, nodeRange);
    const e = range.compareBoundaryPoints(Range.END_TO_START, nodeRange);
    if (s <= 0 || e >= 0) return;

    let startOffset = 0;
    let endOffset = textNode.nodeValue!.length;
    if (textNode === range.startContainer) startOffset = range.startOffset;
    if (textNode === range.endContainer) endOffset = range.endOffset;
    if (startOffset >= endOffset) return;

    const hlRange = document.createRange();
    hlRange.setStart(textNode, startOffset);
    hlRange.setEnd(textNode, endOffset);

    const span = document.createElement('span');
    span.className = 'wa-highlight';
    span.dataset.waId = id;
    span.dataset.waIndex = String(idx++);
    span.style.backgroundColor = color.bg;
    span.style.color = color.text;

    try {
      hlRange.surroundContents(span);
      elements.push(span);
    } catch (_) {
      const fragment = hlRange.extractContents();
      span.appendChild(fragment);
      hlRange.insertNode(span);
      elements.push(span);
    }
  });

  return elements;
}

/** 创建高亮文字（核心函数） */
export async function createHighlight(color: HighlightColor, description?: string, aiAction?: string): Promise<void> {
  if (!currentSelection) return;

  const id = generateId();
  const selectInfo = buildSelectInfo(currentSelection.range, currentSelection.text);
  const highlightElements = wrapRange(currentSelection.range, id, color);

  const record: any = {
    id,
    url: window.location.href,
    type: 'text',
    page_title: document.title,
    page_icon: getFavicon(),
    description: description || '',
    snapshot: '',
    select_info: JSON.stringify(selectInfo),
    text: currentSelection.text,
    is_favorite: false,
    color: {
      id: color.id,
      bg: color.bg,
      text: color.text,
      style: (colorConfig && colorConfig.defaultStyle) || 'background'
    },
    created_at: Date.now(),
    updated_at: Date.now()
  };

  records.unshift(record);
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.RECORDS]: records });
  } catch (_) {}

  // AI 动作
  if (aiAction && aiAction !== 'none') {
    triggerAiRequest(id, aiAction, currentSelection.text);
  }

  safeSendMessage({ action: 'recordCreated', record });

  // 截图
  chrome.runtime.sendMessage({ action: 'captureScreenshot', recordId: id }, () => {
    if (chrome.runtime.lastError) return;
  });
}

/** 获取 favicon */
function getFavicon(): string {
  const selectors = [
    "link[rel='icon']",
    "link[rel='shortcut icon']",
    "link[rel='apple-touch-icon']",
    "link[rel='apple-touch-icon-precomposed']",
    "link[rel='mask-icon']",
    "link[rel='fluid-icon']"
  ];
  for (const selector of selectors) {
    const link = document.querySelector(selector) as HTMLLinkElement;
    if (link && link.href) return link.href;
  }
  return window.location.origin + '/favicon.ico';
}

/** 触发 AI 请求 */
function triggerAiRequest(recordId: string, aiAction: string, text: string): void {
  try {
    chrome.storage.local.get(['backend_url'], (config: any) => {
      if (config.backend_url) {
        chrome.runtime.sendMessage({
          action: 'backendRequest',
          endpoint: '/api/' + aiAction,
          method: 'POST',
          body: { text, record_id: recordId }
        }, (response: any) => {
          if (chrome.runtime.lastError) return;
          if (response && response.data && response.data.data && response.data.data[aiAction]) {
            const idx = records.findIndex((r: any) => r.id === recordId);
            if (idx >= 0) {
              const prefix: Record<string, string> = { summarize: '📝 ', translate: '🌐 ', explain: '💡 ' };
              records[idx].description = (records[idx].description ? records[idx].description + '\n' : '') + (prefix[aiAction] || '') + response.data.data[aiAction];
              records[idx].updated_at = Date.now();
              try {
                chrome.storage.local.set({ [STORAGE_KEYS.RECORDS]: records });
              } catch (_) {}
            }
          }
        });
      }
    });
  } catch (_) {}
}

/** 移除指定 ID 的高亮 */
export function removeHighlightById(recordId: string): void {
  const elements = document.querySelectorAll(`[data-wa-id="${recordId}"]`);
  elements.forEach(el => {
    const parent = el.parentNode!;
    while (el.firstChild) {
      parent.insertBefore(el.firstChild, el);
    }
    parent.removeChild(el);
    parent.normalize();
  });
  updateRecords(records.filter((r: any) => r.id !== recordId));
  chrome.storage.local.set({ [STORAGE_KEYS.RECORDS]: records });
}

/** 移除所有高亮 */
export function removeAllHighlights(): void {
  document.querySelectorAll('.wa-highlight').forEach(el => {
    const parent = el.parentNode!;
    while (el.firstChild) {
      parent.insertBefore(el.firstChild, el);
    }
    parent.removeChild(el);
    parent.normalize();
  });
}

/** 应用高亮 Range */
export function applyHighlightRange(range: Range, id: string, color: HighlightColor): boolean {
  if (!range || range.collapsed) return false;

  const span = document.createElement('span');
  span.className = 'wa-highlight';
  span.dataset.waId = id;
  span.style.backgroundColor = color.bg;
  span.style.color = color.text;

  try {
    range.surroundContents(span);
    return true;
  } catch (_) {
    try {
      const fragment = range.extractContents();
      span.appendChild(fragment);
      range.insertNode(span);
      return true;
    } catch (_) {
      return false;
    }
  }
}

/** 保存高亮笔记 */
export async function saveHighlightNote(recordId: string, description: string): Promise<void> {
  const record = records.find((r: any) => r.id === recordId);
  if (!record) return;
  record.description = description;
  record.updated_at = Date.now();
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.RECORDS]: records });
  } catch (_) {}
}

/** 删除高亮 */
export async function deleteHighlight(recordId: string): Promise<void> {
  removeHighlightById(recordId);
  updateRecords(records.filter((r: any) => r.id !== recordId));
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.RECORDS]: records });
  } catch (_) {}
}