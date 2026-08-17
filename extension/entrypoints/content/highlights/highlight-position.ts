// =========== 高亮位置查找与恢复 ===========
// 使用多种策略在 DOM 中定位并恢复高亮

import { buildTextSegments, createRangeFromSegments, normalizeText, longestCommonSubstringScore, similarityScore, levenshteinDistance } from '../utils';
import { applyHighlightRange, HighlightColor } from './highlight-core';

export interface SelectInfo {
  exact: string;
  prefix: string;
  suffix: string;
  container: any;
  textPosition: any;
}

/** 解析选择信息 */
export function parseSelectInfo(rawSelectInfo: string, fallbackText: string): SelectInfo {
  try {
    if (!rawSelectInfo) {
      return { exact: fallbackText || '', prefix: '', suffix: '', container: null, textPosition: null };
    }
    const parsed = JSON.parse(rawSelectInfo);
    return {
      exact: parsed.exact || parsed?.select_info?.[0]?.exact || fallbackText || '',
      prefix: parsed.prefix || parsed?.select_info?.[0]?.prefix || '',
      suffix: parsed.suffix || parsed?.select_info?.[0]?.suffix || '',
      container: parsed.container || null,
      textPosition: parsed.textPosition || null
    };
  } catch (_) {
    return { exact: fallbackText || '', prefix: '', suffix: '', container: null, textPosition: null };
  }
}

/** 解析容器元素（多级降级策略） */
export function resolveContainer(selectInfo: SelectInfo): Element {
  const container = selectInfo?.container;
  if (!container) return document.body;

  // 1. 精确 ID 匹配
  if (container.id) {
    const byId = document.getElementById(container.id);
    if (byId) return byId;
  }

  // 2. CSS 路径精确匹配
  if (container.path) {
    try {
      const byPath = document.querySelector(container.path);
      if (byPath) return byPath;
    } catch (_) {}
  }

  // 3. tagName + classList 匹配
  if (container.tagName) {
    const candidates = Array.from(document.getElementsByTagName(container.tagName));
    const byClass = candidates.find(el => {
      const classes = container.classList || [];
      return classes.length > 0 && classes.every((className: string) => el.classList.contains(className));
    });
    if (byClass) return byClass;
  }

  // 4. 父级路径降级匹配
  const parentPaths = container.parentPaths || [];
  for (const parentPath of parentPaths) {
    if (!parentPath) continue;
    try {
      const parentEl = document.querySelector(parentPath);
      if (!parentEl) continue;
      if (container.tagName) {
        const child = parentEl.querySelector(container.tagName);
        if (child) return child;
      }
      return parentEl;
    } catch (_) {}
  }

  // 5. tagName 首候选
  if (container.tagName) {
    const candidates = Array.from(document.getElementsByTagName(container.tagName));
    if (candidates[0]) return candidates[0];
  }

  // 6. 文本指纹匹配
  if (container.textFingerprint) {
    const fingerprint = container.textFingerprint;
    const parts = fingerprint.split('%%%HL%%%');
    const fpBefore = parts[0] || '';
    const fpAfter = parts[1] || '';
    const allCandidates = container.tagName
      ? Array.from(document.getElementsByTagName(container.tagName))
      : [document.body];
    let bestMatch: Element | null = null;
    let bestScore = -1;
    for (const el of allCandidates) {
      const elText = normalizeText((el as HTMLElement).innerText || el.textContent || '');
      if (!elText) continue;
      let score = 0;
      if (fpBefore && elText.includes(fpBefore)) score += 2;
      if (fpAfter && elText.includes(fpAfter)) score += 2;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = el;
      }
    }
    if (bestMatch && bestScore > 0) return bestMatch;
  }

  return document.body;
}

/** 在分段中精确匹配文本 */
export function findExactRangeInSegments(segments: any[], exact: string, preferredPosition = -1): Range | null {
  const normalizedExact = normalizeText(exact);
  if (!normalizedExact) return null;

  const fullText = segments.map((s: any) => s.normalized).join('');

  // 优先在 preferredPosition 附近小范围搜索（允许位置前后少量偏差）
  let matchIndex = -1;
  if (preferredPosition >= 0) {
    const searchWindow = 20; // 前后允许偏差 20 个字符
    const start = Math.max(0, preferredPosition - searchWindow);
    const end = Math.min(fullText.length, preferredPosition + searchWindow + normalizedExact.length);
    const windowText = fullText.slice(start, end);
    const localIdx = windowText.indexOf(normalizedExact);
    if (localIdx !== -1) {
      matchIndex = start + localIdx;
    }
  }

  // 如果附近没找到，才退到全文本首次匹配
  if (matchIndex === -1) {
    matchIndex = fullText.indexOf(normalizedExact);
  }
  if (matchIndex === -1) return null;

  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const segmentLength = segments[i].normalized.length;
    if (matchIndex < cursor + segmentLength) {
      return createRangeFromSegments(segments, i, matchIndex - cursor, normalizedExact.length);
    }
    cursor += segmentLength;
  }

  return null;
}

/** 上下文匹配（前后文） */
export function findContextualRange(segments: any[], exact: string, prefix: string, suffix: string): Range | null {
  const normalizedExact = normalizeText(exact);
  const normalizedPrefix = normalizeText(prefix).slice(-150);
  const normalizedSuffix = normalizeText(suffix).slice(0, 150);
  if (!normalizedExact) return null;

  const fullText = segments.map((s: any) => s.normalized).join('');
  const candidates: { index: number; score: number; parts: number }[] = [];
  let searchFrom = 0;

  while (searchFrom < fullText.length) {
    const index = fullText.indexOf(normalizedExact, searchFrom);
    if (index === -1) break;

    const before = fullText.slice(Math.max(0, index - normalizedPrefix.length), index);
    const after = fullText.slice(index + normalizedExact.length, index + normalizedExact.length + normalizedSuffix.length);
    let score = 0;
    let parts = 0;

    if (normalizedPrefix) {
      parts++;
      score += before.endsWith(normalizedPrefix) ? 3 : longestCommonSubstringScore(before, normalizedPrefix) * 3;
    }
    if (normalizedSuffix) {
      parts++;
      score += after.startsWith(normalizedSuffix) ? 3 : longestCommonSubstringScore(after, normalizedSuffix) * 3;
    }

    if (normalizedPrefix && normalizedSuffix) {
      const prefixOk = before.endsWith(normalizedPrefix) || longestCommonSubstringScore(before, normalizedPrefix) > 0.7;
      const suffixOk = after.startsWith(normalizedSuffix) || longestCommonSubstringScore(after, normalizedSuffix) > 0.7;
      if (prefixOk && suffixOk) score += 1;
    }

    candidates.push({ index, score, parts });
    searchFrom = index + Math.max(1, normalizedExact.length);
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.parts - a.parts;
  });
  if (!candidates.length || candidates[0].score < 0.5) return null;

  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const segmentLength = segments[i].normalized.length;
    if (candidates[0].index < cursor + segmentLength) {
      return createRangeFromSegments(segments, i, candidates[0].index - cursor, normalizedExact.length);
    }
    cursor += segmentLength;
  }

  return null;
}

/** 模糊匹配（编辑距离） */
export function findFuzzyRange(segments: any[], exact: string): Range | null {
  const normalizedExact = normalizeText(exact);
  if (!normalizedExact) return null;

  const textLen = normalizedExact.length;
  const threshold = textLen >= 30 ? 0.82 : textLen <= 4 ? 0.50 : 0.82 - (30 - textLen) / (30 - 4) * (0.82 - 0.50);
  if (textLen < 4) return null;

  const fullText = segments.map((s: any) => s.normalized).join('');
  const windowSize = normalizedExact.length;
  const step = Math.max(1, Math.floor(windowSize / 5));
  let best: { index: number; score: number } | null = null;

  for (let index = 0; index <= fullText.length - windowSize; index += step) {
    const candidate = fullText.slice(index, index + windowSize);
    const score = similarityScore(normalizedExact, candidate);
    if (!best || score > best.score) best = { index, score };
  }

  if (!best || best.score < threshold) return null;

  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const segmentLength = segments[i].normalized.length;
    if (best.index < cursor + segmentLength) {
      return createRangeFromSegments(segments, i, best.index - cursor, windowSize);
    }
    cursor += segmentLength;
  }

  return null;
}

/** 文本片段匹配（处理部分删除场景） */
function splitTextIntoFragments(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized || normalized.length < 6) return [];

  const fragments: string[] = [];

  const punctParts = normalized
    .split(/[。！？，、；：,\.!\?;:\n\r]+/)
    .map(p => p.trim())
    .filter(p => p.length >= 4);
  fragments.push(...punctParts);

  if (punctParts.length <= 1 && normalized.length > 10) {
    for (let len = Math.floor(normalized.length * 0.85); len >= 6; len -= Math.max(3, Math.floor(len * 0.15))) {
      fragments.push(normalized.slice(0, len));
    }
  }

  return [...new Set(fragments)];
}

export function findFragmentRange(segments: any[], exact: string, selectInfo: SelectInfo): Range | null {
  const fragments = splitTextIntoFragments(exact);
  if (fragments.length === 0) return null;

  fragments.sort((a, b) => b.length - a.length);

  for (const fragment of fragments) {
    const exactRange = findExactRangeInSegments(segments, fragment);
    if (exactRange) return exactRange;

    const ctxRange = findContextualRange(segments, fragment, selectInfo.prefix, selectInfo.suffix);
    if (ctxRange) return ctxRange;
  }

  return null;
}

/** 语义相似匹配（Dice 系数） */
export function findSemanticRange(segments: any[], exact: string): Range | null {
  const normalizedExact = normalizeText(exact);
  if (!normalizedExact || normalizedExact.length < 8) return null;

  const exactChars = new Set(normalizedExact);
  const exactBigrams = new Set<string>();
  for (let i = 0; i < normalizedExact.length - 1; i++) {
    exactBigrams.add(normalizedExact[i] + normalizedExact[i + 1]);
  }

  const fullText = segments.map((s: any) => s.normalized).join('');
  if (fullText.length < 4) return null;

  const textLen = normalizedExact.length;
  const threshold = textLen >= 20 ? 0.42 : 0.48;

  const baseLen = normalizedExact.length;
  const step = Math.max(2, Math.floor(baseLen / 5));
  let best: { index: number; length: number; score: number } | null = null;

  const minWindow = Math.max(4, Math.floor(baseLen * 0.7));
  const maxWindow = Math.min(fullText.length, Math.ceil(baseLen * 1.3));

  for (let winLen = minWindow; winLen <= maxWindow; winLen += step) {
    for (let pos = 0; pos <= fullText.length - winLen; pos += step) {
      const candidate = fullText.slice(pos, pos + winLen);
      const candidateChars = new Set(candidate);

      let charIntersection = 0;
      for (const ch of exactChars) {
        if (candidateChars.has(ch)) charIntersection++;
      }
      const charDice = (2 * charIntersection) / (exactChars.size + candidateChars.size);
      if (charDice < threshold * 0.75) continue;

      const candidateBigrams = new Set<string>();
      for (let i = 0; i < candidate.length - 1; i++) {
        candidateBigrams.add(candidate[i] + candidate[i + 1]);
      }
      let bigramIntersection = 0;
      for (const bg of exactBigrams) {
        if (candidateBigrams.has(bg)) bigramIntersection++;
      }
      const bigramDice = exactBigrams.size + candidateBigrams.size > 0
        ? (2 * bigramIntersection) / (exactBigrams.size + candidateBigrams.size)
        : 0;

      const combinedScore = charDice * 0.6 + bigramDice * 0.4;
      if (!best || combinedScore > best.score) {
        best = { index: pos, length: winLen, score: combinedScore };
      }
    }
  }

  if (!best || best.score < threshold) return null;

  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const segmentLength = segments[i].normalized.length;
    if (best.index < cursor + segmentLength) {
      return createRangeFromSegments(segments, i, best.index - cursor, best.length);
    }
    cursor += segmentLength;
  }

  return null;
}

/** 超短文本匹配（1-3 字符） */
export function findShortTextRange(segments: any[], exact: string, selectInfo: SelectInfo): Range | null {
  const normalizedExact = normalizeText(exact);
  if (!normalizedExact || normalizedExact.length === 0 || normalizedExact.length >= 4) return null;

  const fullText = segments.map((s: any) => s.normalized).join('');
  if (!fullText) return null;

  const savedPositions = [
    selectInfo?.textPosition?.containerStart,
    selectInfo?.textPosition?.pageStart
  ];

  for (const savedPos of savedPositions) {
    if (savedPos == null || savedPos < 0 || savedPos >= fullText.length) continue;
    for (let offset = -3; offset <= 3; offset++) {
      const tryPos = savedPos + offset;
      if (tryPos < 0 || tryPos + normalizedExact.length > fullText.length) continue;
      if (fullText.slice(tryPos, tryPos + normalizedExact.length) === normalizedExact) {
        let cursor = 0;
        for (let i = 0; i < segments.length; i++) {
          const segLen = segments[i].normalized.length;
          if (tryPos < cursor + segLen) {
            return createRangeFromSegments(segments, i, tryPos - cursor, normalizedExact.length);
          }
          cursor += segLen;
        }
      }
    }
  }

  if (selectInfo.prefix || selectInfo.suffix) {
    const ctxRange = findContextualRange(segments, normalizedExact, selectInfo.prefix, selectInfo.suffix);
    if (ctxRange) return ctxRange;
  }

  return null;
}

/** 查找并应用高亮（多策略组合） */
export function findAndHighlight(selectInfo: SelectInfo, id: string, color: HighlightColor, customRoot?: Document | Element): boolean {
  const exact = selectInfo?.exact || '';
  if (!exact || exact.trim().length === 0) return false;

  const container = resolveContainer(selectInfo);
  const scopedSegments = buildTextSegments(customRoot || container);
  const globalSegments = customRoot
    ? scopedSegments
    : (container === document.body ? scopedSegments : buildTextSegments(document.body));
  const preferredContainerStart = selectInfo?.textPosition?.containerStart ?? -1;
  const preferredPageStart = selectInfo?.textPosition?.pageStart ?? -1;

  const strategies = [
    // 1. 首选：精确位置匹配（用户实际选中的位置）
    () => preferredContainerStart >= 0 ? findExactRangeInSegments(scopedSegments, exact, preferredContainerStart) : null,
    () => preferredPageStart >= 0 ? findExactRangeInSegments(globalSegments, exact, preferredPageStart) : null,
    // 2. 兜底：上下文匹配
    () => findContextualRange(scopedSegments, exact, selectInfo.prefix, selectInfo.suffix),
    () => findContextualRange(globalSegments, exact, selectInfo.prefix, selectInfo.suffix),
    // 3. 再降级：模糊匹配
    () => findExactRangeInSegments(scopedSegments, exact),
    () => findExactRangeInSegments(globalSegments, exact),
    () => findFuzzyRange(scopedSegments, exact),
    () => findFuzzyRange(globalSegments, exact),
    () => findFragmentRange(scopedSegments, exact, selectInfo),
    () => findFragmentRange(globalSegments, exact, selectInfo),
    () => findSemanticRange(scopedSegments, exact),
    () => findSemanticRange(globalSegments, exact),
    () => findShortTextRange(scopedSegments, exact, selectInfo),
    () => findShortTextRange(globalSegments, exact, selectInfo)
  ];

  for (const getRange of strategies) {
    const range = getRange();
    if (range && applyHighlightRange(range, id, color)) {
      return true;
    }
  }

  return false;
}