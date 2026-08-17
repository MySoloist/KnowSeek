// =========== 常量 ===========
export const STORAGE_KEYS = {
  RECORDS: 'records',
  COLOR_CONFIG: 'color_config',
  SNAPSHOTS: 'snapshots',
};

// =========== 通用工具函数 ===========

/** 从 Range 中计算文本在标准化全文中的偏移位置（精确到用户实际选中的位置，而非 indexOf 首次出现） */
export function getNormalizedOffsetFromRange(range: Range, root: Document | Element = document.body): number {
  const segments = buildTextSegments(root);
  const startNode = range.startContainer;
  const startOffset = range.startOffset;

  let accumulated = 0;
  for (const seg of segments) {
    if (seg.node === startNode) {
      // 计算在此文本节点中，startOffset 之前的文本在标准化后占多少字符
      const rawBefore = seg.raw.substring(0, startOffset);
      const normalizedBefore = normalizeText(rawBefore);
      return accumulated + normalizedBefore.length;
    }
    accumulated += seg.normalized.length;
  }

  return -1;
}

/** 安全发送消息，忽略 context invalidated 错误 */
export function safeSendMessage(message: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage(message, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
  } catch (_) {
    // Context invalidated, ignore silently
  }
}

/** 生成唯一 ID */
export function generateId(): string {
  return '01' + Date.now().toString(36) + Math.random().toString(36).substring(2, 10).toUpperCase();
}

/** 标准化文本（合并空白字符） */
export function normalizeText(text: string): string {
  return (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 转义正则表达式特殊字符 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 判断元素是否在交互式元素内（如 input、textarea、button 等） */
export function isInInteractiveElement(el: Element | null): boolean {
  let current: Element | null = el;
  while (current && current !== document.body) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(current.nodeName)) {
      return true;
    }
    if ((current as HTMLElement).contentEditable === 'true') {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

/** 获取可搜索的文本节点列表（跳过空白、高亮元素、交互式元素） */
export function getSearchableTextNodes(root: Document | Element = document.body): Text[] {
  const treeWalker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.trim().length === 0) {
          return NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentElement;
        if (!parent) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest('.wa-highlight')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (isInInteractiveElement(parent)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    } as NodeFilter,
  );

  const nodes: Text[] = [];
  while (treeWalker.nextNode()) {
    nodes.push(treeWalker.currentNode as Text);
  }
  return nodes;
}

/** 构建文本分段数组（每段包含节点和原始/标准化文本） */
export interface TextSegment {
  node: Text;
  raw: string;
  normalized: string;
}

export function buildTextSegments(root: Document | Element = document.body): TextSegment[] {
  const nodes = getSearchableTextNodes(root);
  const segments: TextSegment[] = [];

  nodes.forEach(node => {
    const raw = node.nodeValue || '';
    const normalized = normalizeText(raw);
    if (!normalized) return;
    segments.push({ node, raw, normalized });
  });

  return segments;
}

/** 从分段中创建 Range（处理标准化与原始文本的偏移转换） */
export function createRangeFromSegments(
  segments: TextSegment[],
  startSegmentIndex: number,
  startOffset: number,
  length: number,
): Range | null {
  if (!segments[startSegmentIndex] || length <= 0) return null;

  let remaining = length;
  let segmentIndex = startSegmentIndex;
  let startNode: Text | null = null;
  let startNodeOffset = 0;
  let endNode: Text | null = null;
  let endNodeOffset = 0;

  while (segmentIndex < segments.length && remaining > 0) {
    const segment = segments[segmentIndex];
    const segmentStart = segmentIndex === startSegmentIndex ? startOffset : 0;
    if (segmentStart >= segment.normalized.length) {
      segmentIndex++;
      continue;
    }

    const taken = Math.min(remaining, segment.normalized.length - segmentStart);
    const rawStart = findRawOffsetFromNormalized(segment.raw, segmentStart);
    const rawEnd = findRawOffsetFromNormalized(segment.raw, segmentStart + taken);

    if (!startNode) {
      startNode = segment.node;
      startNodeOffset = rawStart;
    }

    endNode = segment.node;
    endNodeOffset = rawEnd;
    remaining -= taken;
    segmentIndex++;
  }

  if (!startNode || !endNode || remaining > 0) return null;

  const range = document.createRange();
  range.setStart(startNode, startNodeOffset);
  range.setEnd(endNode, endNodeOffset);
  return range;
}

/** 从标准化偏移量转换回原始文本中的偏移量 */
export function findRawOffsetFromNormalized(rawText: string, normalizedOffset: number): number {
  if (normalizedOffset <= 0) return 0;

  let normalizedCount = 0;
  let inWhitespace = false;

  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];
    const isWhitespace = /\s/.test(ch) || ch === '\u00a0';

    if (isWhitespace) {
      if (!inWhitespace && normalizedCount > 0) {
        normalizedCount += 1;
        if (normalizedCount >= normalizedOffset) return i;
      }
      inWhitespace = true;
    } else {
      inWhitespace = false;
      normalizedCount += 1;
      if (normalizedCount >= normalizedOffset) return i + 1;
    }
  }

  return rawText.length;
}

/** 构建元素的 DOM 路径（用于后续重新定位） */
export function buildDomPath(element: Element): string {
  const segments: string[] = [];
  let current: Element | null = element;

  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body && segments.length < 6) {
    const tag = current.tagName.toLowerCase();
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(el => el.tagName === current.tagName)
      : [];
    const index = siblings.length > 1 ? siblings.indexOf(current) : -1;
    segments.unshift(index >= 0 ? `${tag}:nth-of-type(${index + 1})` : tag);
    if (current.id) {
      segments[0] = `${tag}#${current.id}`;
      break;
    }
    current = current.parentElement;
  }

  return segments.join(' > ');
}

/** 获取可以锚定的容器元素 */
export function getAnchorContainer(range: Range): Element {
  let node: Node | null = range.commonAncestorContainer;
  if (node?.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }

  while (node && node !== document.body) {
    if (node.nodeType === Node.ELEMENT_NODE && !isInInteractiveElement(node as Element)) {
      return node as Element;
    }
    node = node.parentElement;
  }

  return document.body;
}

/** 格式化秒数为 mm:ss */
export function formatTimestamp(seconds: number): string {
  if (!seconds || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// =========== 字符串相似度匹配 ===========

/** 最长公共子串得分（0~1） */
export function longestCommonSubstringScore(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let len = 0;
      while (a[i + len] && b[j + len] && a[i + len] === b[j + len]) {
        len++;
      }
      best = Math.max(best, len);
    }
  }
  return best / Math.max(a.length, b.length, 1);
}

/** 编辑距离（Levenshtein） */
export function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[a.length][b.length];
}

/** 相似度得分（1 - 编辑距离/最大长度） */
export function similarityScore(source: string, target: string): number {
  const maxLen = Math.max(source.length, target.length, 1);
  return 1 - levenshteinDistance(source, target) / maxLen;
}