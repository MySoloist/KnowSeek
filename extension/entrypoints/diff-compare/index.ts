// ===== 新旧内容对比 - 独立页面 =====
import { stripMarkdown, normalizePara, splitParagraphs } from '../../utils/content-diff';
import { diffLines } from 'diff';

interface DiffLine { text: string; type: 'unchanged' | 'added' | 'removed' | 'empty' }

interface CompareData {
  url: string;
  title: string;
  oldContent: string;
  newContent: string;
  added: number;
  modified: number;
  removed: number;
}

let compareData: CompareData | null = null;
let currentMode: 'semantic' | 'text' = 'semantic';
let currentCompareVersion = 0;

// ===== DOM 引用 =====
const $ = (id: string) => document.getElementById(id);
const titleEl = $('dcTitle') as HTMLElement;
const oldContent = $('dcOldContent') as HTMLElement;
const newContent = $('dcNewContent') as HTMLElement;
const oldCount = $('dcOldCount') as HTMLElement;
const newCount = $('dcNewCount') as HTMLElement;
const badgeAdded = $('dcBadgeAdded') as HTMLElement;
const badgeModified = $('dcBadgeModified') as HTMLElement;
const badgeRemoved = $('dcBadgeRemoved') as HTMLElement;
const backBtn = $('dcBackBtn') as HTMLElement;
const reloadBtn = $('dcReloadBtn') as HTMLElement;
const modeSemantic = $('dcModeSemantic') as HTMLElement;
const modeText = $('dcModeText') as HTMLElement;
const errorToast = $('dcErrorToast') as HTMLElement;

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string, duration = 4000) {
  if (!errorToast) return;
  errorToast.textContent = msg;
  errorToast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => errorToast.classList.add('hidden'), duration);
}

// ===== 初始化 =====
async function init() {
  // 加载数据
  await loadData();
  if (!compareData) {
    showError('没有对比数据，请从知寻通知中心打开此页面');
    return;
  }

  // 渲染页面标题
  titleEl.textContent = `📄 ${compareData.title}`;

  // 更新统计徽章
  badgeAdded.textContent = `✚ ${compareData.added}`;
  badgeModified.textContent = `➜ ${compareData.modified}`;
  badgeRemoved.textContent = `✕ ${compareData.removed}`;

  // 执行对比
  await runCompare();

  // 事件绑定
  setupListeners();
}

async function loadData() {
  try {
    const data = await chrome.storage.local.get('_diffCompareData');
    const d = data._diffCompareData;
    if (d && d.oldContent && d.newContent) {
      compareData = d as CompareData;
      // 读取后可选清除
      // await chrome.storage.local.remove('_diffCompareData');
    }
  } catch {}
}

async function runCompare() {
  if (!compareData) return;

  const oldParas = splitParagraphs(compareData.oldContent);
  const newParas = splitParagraphs(compareData.newContent);

  oldContent.innerHTML = '<div class="dc-loading">正在分析...</div>';
  newContent.innerHTML = '<div class="dc-loading">正在分析...</div>';
  oldCount.textContent = `${oldParas.length} 个段落`;
  newCount.textContent = `${newParas.length} 个段落`;

  currentCompareVersion++;
  const version = currentCompareVersion;

  if (currentMode === 'semantic') {
    // 显示加载中，后台异步加载语义对比
    oldContent.innerHTML = '<div class="dc-loading">🔄 正在语义分析...</div>';
    newContent.innerHTML = '<div class="dc-loading">🔄 正在语义分析...</div>';
    renderSemanticCompare(oldParas, newParas, version);
  } else {
    try { renderTextCompare(oldParas, newParas); } catch {}
  }
}

// ===== 语义对比（Embedding API） =====
async function renderSemanticCompare(oldParas: string[], newParas: string[], version: number) {
  try {
    // 版本校验：如果用户已经切换了模式，放弃本次结果
    if (version !== currentCompareVersion) return;

    const resp = await new Promise<any>(r => {
      chrome.runtime.sendMessage({
        action: 'backendRequest',
        endpoint: '/api/embedding/compare',
        method: 'POST',
        body: { old_paragraphs: oldParas, new_paragraphs: newParas },
      }, (response) => {
        if (chrome.runtime.lastError) { r(null); return; }
        r(response);
      });
    });

    if (version !== currentCompareVersion) return;

    if (!resp?.ok || !resp.data) {
      throw new Error('语义分析不可用');
    }

    const results = resp.data?.data || resp.data;
    const { matched_pairs, unmatched_old_indices, unmatched_new_indices } = results;

    interface Block { type: 'matched' | 'removed' | 'added' | 'empty'; content: string; sim?: number; pairOther?: string; badgeText?: string }
    const oldBlocks: Block[] = [];
    const newBlocks: Block[] = [];
    const newToBlock = new Map<number, number>();
    const oldToBlockCount = new Map<number, number>();

    for (let oi = 0; oi < oldParas.length; oi++) {
      const pairs = matched_pairs.filter((p: any) => p.old_index === oi);
      if (pairs.length > 0) {
        for (let pi = 0; pi < pairs.length; pi++) {
          const pair = pairs[pi];
          const ni = pair.new_index;
          if (pi === 0) {
            oldBlocks.push({ type: 'matched', content: oldParas[oi], sim: pair.similarity, pairOther: newParas[ni] });
            newToBlock.set(ni, newBlocks.length);
            newBlocks.push({ type: 'matched', content: newParas[ni], sim: pair.similarity, pairOther: oldParas[oi] });
          } else {
            oldBlocks.push({ type: 'empty', content: '' });
            newToBlock.set(ni, newBlocks.length);
            newBlocks.push({ type: 'matched', content: newParas[ni], sim: pair.similarity, pairOther: oldParas[oi] });
          }
        }
        oldToBlockCount.set(oi, pairs.length);
      } else if (unmatched_old_indices.includes(oi)) {
        oldBlocks.push({ type: 'removed', content: oldParas[oi] });
        newBlocks.push({ type: 'empty', content: '' });
        oldToBlockCount.set(oi, 1);
      }
    }

    const sortedUnmatched = [...unmatched_new_indices].sort((a, b) => a - b);
    for (const ni of sortedUnmatched) {
      if (newToBlock.has(ni)) continue;
      let anchorNewIdx = -1;
      for (const pair of matched_pairs) {
        if (pair.new_index < ni && pair.new_index > anchorNewIdx) {
          anchorNewIdx = pair.new_index;
        }
      }
      let insertAt = 0;
      if (anchorNewIdx >= 0) {
        const anchorPair = matched_pairs.find((p: any) => p.new_index === anchorNewIdx);
        if (anchorPair) {
          let blockCount = 0;
          for (let oi = 0; oi <= anchorPair.old_index; oi++) {
            blockCount += oldToBlockCount.get(oi) || 0;
          }
          insertAt = blockCount;
        }
      }
      oldBlocks.splice(insertAt, 0, { type: 'empty', content: '' });
      newBlocks.splice(insertAt, 0, { type: 'added', content: newParas[ni] });
    }

    // 最终渲染前再做一次版本校验
    if (version !== currentCompareVersion) return;
    renderBlocks(oldContent, oldBlocks, 'old');
    renderBlocks(newContent, newBlocks, 'new');
  } catch {
    // 降级到文本对比（仅在版本匹配时）
    if (version === currentCompareVersion) {
      renderTextCompare(oldParas, newParas);
      showToast('语义分析失败，已切换至文本对比', 5000);
    }
  }
}

// ===== 文本对比（fallback / 手动切换） =====
function renderTextCompare(oldParas: string[], newParas: string[]) {
  // 归一化映射
  const oldNorms = new Map<string, string>();
  oldParas.forEach(p => { const k = normalizePara(p); if (!oldNorms.has(k)) oldNorms.set(k, p); });
  const newNorms = new Map<string, string>();
  newParas.forEach(p => { const k = normalizePara(p); if (!newNorms.has(k)) newNorms.set(k, p); });
  const oldKeys = new Set(oldNorms.keys());
  const newKeys = new Set(newNorms.keys());

  const commonKeys = new Set([...oldKeys].filter(k => newKeys.has(k)));
  const addedKeys = [...newKeys].filter(k => !oldKeys.has(k));
  const removedKeys = [...oldKeys].filter(k => !newKeys.has(k));

  // 找修改段落
  const modifiedPairs: Array<{ oldKey: string; newKey: string }> = [];
  const remainingAdded = [...addedKeys];
  const remainingRemoved = [...removedKeys];
  for (let i = remainingRemoved.length - 1; i >= 0; i--) {
    for (let j = remainingAdded.length - 1; j >= 0; j--) {
      const lineDiff = diffLines(
        stripMarkdown(oldNorms.get(remainingRemoved[i])!),
        stripMarkdown(newNorms.get(remainingAdded[j])!)
      );
      let lineChanges = 0;
      lineDiff.forEach(p => { if (p.added || p.removed) lineChanges += p.count || 0; });
      if (lineChanges > 0 && lineChanges <= 5) {
        modifiedPairs.push({ oldKey: remainingRemoved[i], newKey: remainingAdded[j] });
        remainingRemoved.splice(i, 1);
        remainingAdded.splice(j, 1);
        break;
      }
    }
  }

  const modifiedOldKeys = new Set(modifiedPairs.map(p => p.oldKey));
  const modifiedNewKeys = new Set(modifiedPairs.map(p => p.newKey));

  // 构建对齐的 blocks（与语义模式相同的 renderBlocks 结构）
  interface BlockData { type: 'matched' | 'removed' | 'added' | 'empty'; content: string; sim?: number; pairOther?: string; badgeText?: string }
  const oldBlocks: BlockData[] = [];
  const newBlocks: BlockData[] = [];

  // 跟踪已使用的新段落索引
  const usedNewIdx = new Set<number>();

  // 按旧段落顺序处理
  for (let oi = 0; oi < oldParas.length; oi++) {
    const oldText = oldParas[oi];
    const k = normalizePara(oldText);

    if (commonKeys.has(k) && !modifiedOldKeys.has(k)) {
      // 未变：两侧都显示
      const newText = newNorms.get(k)!;
      const ni = newParas.indexOf(newText);
      if (ni >= 0) usedNewIdx.add(ni);
      oldBlocks.push({ type: 'matched', content: oldText, sim: 1, pairOther: newText, badgeText: '⏎ 未变化' });
      newBlocks.push({ type: 'matched', content: newText, sim: 1, pairOther: oldText, badgeText: '⏎ 未变化' });
    } else if (modifiedOldKeys.has(k)) {
      // 修改：两侧分别显示，pairOther 供 renderBlocks 做行级 diff
      const pair = modifiedPairs.find(p => p.oldKey === k)!;
      const newText = newNorms.get(pair.newKey)!;
      const ni = newParas.indexOf(newText);
      if (ni >= 0) usedNewIdx.add(ni);
      oldBlocks.push({ type: 'matched', content: oldText, sim: 0.5, pairOther: newText, badgeText: '➜ 已修改' });
      newBlocks.push({ type: 'matched', content: newText, sim: 0.5, pairOther: oldText, badgeText: '➜ 已修改' });
    } else if (!modifiedOldKeys.has(k)) {
      // 删除：旧侧显示，新侧 placeholder
      oldBlocks.push({ type: 'removed', content: oldText });
      newBlocks.push({ type: 'empty', content: '' });
    }
  }

  // 插入纯新增段落（在旧文中没有对应段落）
  // 按新段落原文顺序查找未被使用的
  for (let ni = 0; ni < newParas.length; ni++) {
    if (usedNewIdx.has(ni)) continue;
    const newText = newParas[ni];
    const k = normalizePara(newText);
    if (modifiedNewKeys.has(k) || addedKeys.includes(k)) {
      oldBlocks.push({ type: 'empty', content: '' });
      newBlocks.push({ type: 'added', content: newText });
    }
  }

  renderBlocks(oldContent, oldBlocks, 'old');
  renderBlocks(newContent, newBlocks, 'new');
}

// ===== 区块渲染（语义模式） =====
function renderBlocks(container: HTMLElement, blocks: { type: string; content: string; sim?: number; pairOther?: string }[], paneType: 'old' | 'new') {
  container.innerHTML = '';
  for (const block of blocks) {
    const wrapper = document.createElement('div');
    wrapper.className = 'dc-cmp-block';
    const badge = document.createElement('div');
    badge.className = 'dc-cmp-block-badge';
    if (block.type === 'matched') {
      badge.classList.add('matched');
      badge.textContent = block.badgeText || `🔗 语义相似 ${(block.sim! * 100).toFixed(0)}%`;
    } else if (block.type === 'removed') {
      badge.classList.add('removed');
      badge.textContent = '✕ 已删除';
    } else if (block.type === 'added') {
      badge.classList.add('added');
      badge.textContent = '✚ 已新增';
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'dc-cmp-block-placeholder';
      placeholder.textContent = '(无对应内容)';
      wrapper.appendChild(placeholder);
      container.appendChild(wrapper);
      continue;
    }
    wrapper.appendChild(badge);
    const contentDiv = document.createElement('div');
    contentDiv.className = 'dc-cmp-block-content';
    if (block.type === 'matched') {
      const oldText = paneType === 'old' ? block.content : (block.pairOther || block.content);
      const newText = paneType === 'new' ? block.content : (block.pairOther || block.content);
      const cleanOld = stripMarkdown(oldText);
      const cleanNew = stripMarkdown(newText);
      const diff = cleanOld === cleanNew ? [{ value: block.content, count: 1 }] : diffLines(oldText, newText);
      const paneIsNew = paneType === 'new';
      const { lines } = flattenDiffForPane(diff, paneIsNew);
      lines.forEach(line => {
        const div = document.createElement('div');
        div.className = 'dc-cmp-line';
        if (line.type === 'added') {
          div.classList.add('dc-cmp-line-added');
          div.innerHTML = `<span class="dc-cmp-line-marker">+</span><span class="dc-cmp-line-text">${escapeHtml(line.text)}</span>`;
        } else if (line.type === 'removed') {
          div.classList.add('dc-cmp-line-removed');
          div.innerHTML = `<span class="dc-cmp-line-marker">-</span><span class="dc-cmp-line-text">${escapeHtml(line.text)}</span>`;
        } else if (line.type === 'empty') {
          div.classList.add('dc-cmp-line-empty');
          div.textContent = '\u00A0';
        } else {
          div.classList.add('dc-cmp-line-unchanged');
          div.textContent = `  ${line.text}`;
        }
        contentDiv.appendChild(div);
      });
    } else {
      const lines = block.content.split('\n');
      const lineType = block.type === 'removed' ? 'removed' : 'added';
      lines.forEach(line => {
        if (!line && lines.length > 1) return;
        const div = document.createElement('div');
        div.className = `dc-cmp-line dc-cmp-line-${lineType}`;
        div.innerHTML = `<span class="dc-cmp-line-marker">${block.type === 'removed' ? '-' : '+'}</span><span class="dc-cmp-line-text">${escapeHtml(line)}</span>`;
        contentDiv.appendChild(div);
      });
    }
    wrapper.appendChild(contentDiv);
    container.appendChild(wrapper);
  }
}

function flattenDiffForPane(diff: { added?: boolean; removed?: boolean; value: string; count?: number }[], paneIsNew: boolean): { lines: DiffLine[], swapMarkers: boolean } {
  const lines: DiffLine[] = [];
  diff.forEach(part => {
    const rawLines = part.value.split('\n');
    if (rawLines[rawLines.length - 1] === '') rawLines.pop();
    if (part.added) {
      rawLines.forEach((line: string) => {
        if (paneIsNew) lines.push({ text: line, type: 'added' });
        else lines.push({ text: '', type: 'empty' });
      });
    } else if (part.removed) {
      rawLines.forEach((line: string) => {
        if (paneIsNew) lines.push({ text: '', type: 'empty' });
        else lines.push({ text: line, type: 'removed' });
      });
    } else {
      rawLines.forEach((line: string) => {
        lines.push({ text: line, type: 'unchanged' });
      });
    }
  });
  return { lines, swapMarkers: false };
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showError(msg: string) {
  errorToast.textContent = msg;
  errorToast.classList.remove('hidden');
  setTimeout(() => errorToast.classList.add('hidden'), 4000);
}

// ===== 事件绑定 =====
function setupListeners() {
  // 返回按钮
  backBtn.addEventListener('click', () => {
    window.close();
  });

  // 重新分析
  reloadBtn.addEventListener('click', () => {
    runCompare();
  });

  // 模式切换
  modeSemantic.addEventListener('click', () => {
    if (currentMode === 'semantic') return;
    currentMode = 'semantic';
    modeSemantic.classList.add('active');
    modeText.classList.remove('active');
    runCompare();
  });
  modeText.addEventListener('click', () => {
    if (currentMode === 'text') return;
    currentMode = 'text';
    modeText.classList.add('active');
    modeSemantic.classList.remove('active');
    runCompare();
  });

  // 分割线拖拽
  const divider = document.getElementById('dcDivider') as HTMLElement;
  const compare = document.querySelector('.dc-compare') as HTMLElement;
  let isDragging = false;

  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = compare.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(20, Math.min(80, (x / rect.width) * 100));
    const oldPane = compare.querySelector('.dc-pane-old') as HTMLElement;
    const newPane = compare.querySelector('.dc-pane-new') as HTMLElement;
    if (oldPane) oldPane.style.flex = `0 0 ${pct}%`;
    if (newPane) newPane.style.flex = `0 0 ${100 - pct}%`;
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// ===== 启动 =====
init();