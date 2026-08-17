// KnowSeek 侧边栏 AI 对话模块
// 从旧 sidebar.js 迁移而来，独立管理多会话聊天、模型切换、思维导图、图片上传等功能。

import { marked } from 'marked';
import { DEFAULT_BASE_URLS, aiProviders, activeProviderId, updateActiveProviderId, loadAiProviders as loadSharedAiProviders } from './state';

/** 将 LaTeX 公式 \(...\) 和 \[...\] 转换为 $...$ 和 $$...$$，然后调用 marked.parse */
function renderMarkdown(text: string): string {
  // 块级公式 \[...\] → $$...$$（优先处理，避免被行内规则干扰）
  let result = text.replace(/\\\[([\s\S]*?)\\\]/g, '$$\n$1\n$$');
  // 行内公式 \(...\) → $...$
  result = result.replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$');
  return marked.parse(result) as string;
}

// ── 类型定义 ──
interface PageContext {
  title: string;
  url: string;
  content: string | null;
  noSubtitles?: boolean;
  isVideoPage?: boolean;
  subtitles?: string;
}

interface VideoFrame {
  seconds: number;
  frameId?: string;
  dataUrl?: string;
  timeStr: string;
  pageUrl?: string;
}

interface ChatMessage {
  role: string;
  content: string;
  display?: string;
  images?: string[];
  frames?: VideoFrame[];
  isMindmap?: boolean;
  pageUrl?: string;
}

interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  pageContext?: PageContext | null;
}

interface AIModel {
  modelId: string;
  model: string;
}

interface AIProvider {
  id: string;
  provider: string;
  label?: string;
  api_key: string;
  base_url: string;
  models: AIModel[];
  activeModelId: string | null;
  max_tokens: number;
  stream: boolean;
}

// ── 思维导图库动态加载 ──
let _mindmapLibsReady = false;
const _mindmapPendingQueue: Array<() => void> = [];

/** 预截取的视频帧缓存（timestamp → dataUrl），供渲染时直接使用 */
const _preCapturedVideoFrames = new Map<number, string>();

(function loadMindmapLibs() {
  const libs = ['lib/d3.min.js', 'lib/markmap-lib.min.js', 'lib/markmap-view.min.js'];
  function loadNext(index: number) {
    if (index >= libs.length) {
      _mindmapLibsReady = true;
      const queue = _mindmapPendingQueue.splice(0);
      queue.forEach((fn) => {
        try {
          fn();
        } catch (e) {
          console.warn('[KnowSeek] pending mindmap retry error:', e);
        }
      });
      return;
    }
    try {
      const url = chrome.runtime.getURL(libs[index]);
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => loadNext(index + 1);
      script.onerror = () => {
        console.error('[KnowSeek] failed to load:', libs[index]);
        loadNext(index + 1);
      };
      document.head.appendChild(script);
    } catch (e) {
      console.warn('[KnowSeek] loadMindmapLibs error:', e);
      loadNext(index + 1);
    }
  }
  loadNext(0);
})();

// ── DOM 元素 ──
const chatMessages = document.getElementById('chatMessages') as HTMLDivElement;
const chatInput = document.getElementById('chatInput') as HTMLTextAreaElement;
const chatSendBtn = document.getElementById('chatSendBtn') as HTMLButtonElement;
const chatNewBtn = document.getElementById('chatNewBtn') as HTMLButtonElement;
const chatPendingArea = document.getElementById('chatPendingArea') as HTMLDivElement;
const chatPendingText = document.getElementById('chatPendingText') as HTMLDivElement;
const chatPendingCancel = document.getElementById('chatPendingCancel') as HTMLButtonElement;
const chatPresets = document.getElementById('chatPresets') as HTMLDivElement;
const chatPresetBtns = document.querySelectorAll('.chat-preset-btn');
const chatContextIndicator = document.getElementById('chatContextIndicator') as HTMLDivElement;
const chatContextText = document.getElementById('chatContextText') as HTMLSpanElement;
const chatSubtitlePreview = document.getElementById('chatSubtitlePreview') as HTMLDivElement;
const chatSubtitleText = document.getElementById('chatSubtitleText') as HTMLSpanElement;
const chatImageInput = document.getElementById('chatImageInput') as HTMLInputElement;
const chatImgBtn = document.getElementById('chatImgBtn') as HTMLButtonElement;
const chatImagePreview = document.getElementById('chatImagePreview') as HTMLDivElement;
const chatGlobalPresets = document.getElementById('chatGlobalPresets') as HTMLDivElement;
const chatGlobalPresetsBtns = document.getElementById('chatGlobalPresetsBtns') as HTMLDivElement;
const chatSubtitleHint = document.getElementById('chatSubtitleHint') as HTMLDivElement;
const chatModelBtn = document.getElementById('chatModelBtn') as HTMLButtonElement;
const chatModelLabel = document.getElementById('chatModelLabel') as HTMLSpanElement;
const chatModelDropdown = document.getElementById('chatModelDropdown') as HTMLDivElement;
const chatModelDropdownList = document.getElementById('chatModelDropdownList') as HTMLDivElement;
const chatHistoryBtn = document.getElementById('chatHistoryBtn') as HTMLButtonElement;
const chatHistoryModal = document.getElementById('chatHistoryModal') as HTMLDivElement;
const chatHistoryOverlay = document.getElementById('chatHistoryOverlay') as HTMLDivElement;
const chatHistoryClose = document.getElementById('chatHistoryClose') as HTMLButtonElement;
const chatHistoryList = document.getElementById('chatHistoryList') as HTMLDivElement;
const chatInputWrap = document.querySelector('.chat-input-wrap') as HTMLDivElement;

// ── 状态 ──
let chatSessions: Record<string, ChatSession> = {};
let activeSessionId: string | null = null;
let pendingImages: Array<{ dataUrl: string; name: string }> = [];
let _pendingText = '';
let _streamEnabled = true;
let currentPageType: 'article' | 'video' = 'article';
let _mindmapInstance: any = null;
let asrEnabled: boolean = false;
let asrForced: boolean = false;

// ── 常量 ──
const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE = 4 * 1024 * 1024;
const MAX_DIMENSION = 2048;

const presetPrompts: Record<string, string> = {
  summarize: '请用中文总结以下内容：\n',
  translate: '请将以下内容翻译成中文：\n',
  explain: '请用通俗易懂的语言解释以下内容：\n',
};

const globalPresets = {
  summarizeArticle: {
    label: '📄 总结全文',
    prompt:
      '请用中文总结以下网页文章的主要内容，提取核心观点和关键信息。注意：段落之间使用缩进表示层级，不要使用空行分隔。不要使用"该文章""本文""文章中"等冗余表述，直接讲述内容本身。\n\n如果原文中包含图片（会以 [IMAGE:0]、[IMAGE:1] 等标记形式提供），请在总结中的合适位置使用 [IMAGE:N] 标记来引用对应的图片，让总结更直观、美观。\n\n在完整总结之后，在末尾用一句话对整篇文章进行精简总结，格式为：\n> **精简总结：**（一句话概括核心要点）\n',
  },
  mindmapArticle: {
    label: '🧠 思维导图',
    prompt:
      '请将以下内容整理成思维导图格式，使用 Markdown 的多级列表结构（如 - 主题\n  - 子主题\n    - 要点），层级要清晰，提取核心框架和关键知识点：\n\n',
  },
  summarizeVideo: {
    label: '🎬 总结视频',
    prompt:
      '请用中文总结当前视频的内容，在回答中必须包含时间戳标记。\n\n核心要求：按主题语义聚合，不要按字幕的时间碎片机械分段。把视频内容归纳为少量逻辑主题（通常 3-8 个，短视频可更少，长视频可略多），每个主题一个段落。\n\n格式要求：\n- 每个段落代表一个独立的逻辑主题或子话题\n- 每段只以一个 [MM:SS] 时间戳开头（该主题开始的时间点）\n- 同一个主题内即使有多个时间片段、停顿或发言轮次，也合并到同一段落中，不要在主题内部再插入新的时间戳\n- 如果一个主题持续时间很长但内容一致，仍然只用一个时间戳\n- 相邻的、内容相关的短片段必须合并，不要单独成段\n- 按时间顺序组织段落\n- 段落之间用缩进表示层级，不要使用空行分隔\n\n重要：不要使用"该视频""本视频""视频中"等冗余表述，直接讲述内容本身即可。\n\n示例格式：\n[00:00] 主持人介绍本期主题，概述了将要讨论的三个核心问题，并邀请嘉宾登场。\n  [05:22] 嘉宾围绕第一个核心论点展开讨论，通过两个具体案例来支撑自己的观点，并回应了主持人的补充提问。\n\n字幕内容已附在上下文中，请基于字幕内容生成带有时间戳的总结。\n\n在完整总结之后，在末尾用一句话对整段视频进行精简总结，格式为：\n> **精简总结：**（一句话概括核心要点）\n',
  },
  mindmapVideo: {
    label: '🧠 思维导图',
    prompt:
      '请将以下视频内容整理成思维导图格式，使用 Markdown 的多级列表结构（如 - 主题\n  - 子主题\n    - 要点），层级要清晰，提取整体框架和关键知识点。不需要时间戳，把内容按逻辑结构组织即可：\n\n',
  },
};

// ── 工具函数 ──
function genId(): string {
  return 's' + Date.now() + Math.random().toString(36).slice(2, 6);
}

function getActiveMessages(): ChatMessage[] {
  const s = activeSessionId ? chatSessions[activeSessionId] : null;
  return s ? s.messages : [];
}

function escHtml(str: string): string {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function saveSessions(): void {
  try {
    // 将 Record<string, ChatSession> 转为数组以存入 storage
    const sessionsArr = Object.values(chatSessions);
    chrome.storage.local
      .set({ chat_sessions: sessionsArr, chat_active_session_id: activeSessionId })
      .catch((e) => {
        if (e.message && e.message.includes('Quota')) {
          console.warn('[KnowSeek] Storage quota exceeded, consider clearing old chat sessions');
        }
      });
  } catch (e) {
    // ignore
  }
}

// ── AI Provider 管理（共享状态）──
async function loadAiProviders(): Promise<void> {
  await loadSharedAiProviders();
  const active = getActiveProvider();
  _streamEnabled = active ? active.stream : true;
}

async function saveAiProviders(): Promise<void> {
  await chrome.storage.local.set({
    ai_providers: aiProviders,
    ai_active_provider: activeProviderId,
  });
}

function getActiveProvider(): AIProvider | null {
  return aiProviders.find((p) => p.id === activeProviderId) || aiProviders[0] || null;
}

function getActiveModel(): AIModel | null {
  const provider = getActiveProvider();
  if (!provider || !provider.models || !provider.activeModelId) return null;
  return (
    provider.models.find((m) => m.modelId === provider.activeModelId) || provider.models[0] || null
  );
}

async function syncActiveToBackend(): Promise<void> {
  const active = getActiveProvider();
  const activeModel = getActiveModel();
  if (!active || !activeModel) return;
  try {
    const cfg = await chrome.storage.local.get(['backend_url', 'backend_key']);
    if (cfg.backend_url) {
      await fetch(cfg.backend_url.replace(/\/+$/, '') + '/api/config/ai', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.backend_key || ''}`,
        },
        body: JSON.stringify({
          provider: active.provider,
          api_key: active.api_key,
          model: activeModel.model,
          base_url: active.base_url,
          max_tokens: active.max_tokens,
          stream: active.stream,
        }),
      });
    }
  } catch (e) {
    console.warn('[KnowSeek] 同步活跃配置到后端失败:', e);
  }
}

// 多模态模型缓存，避免重复 API 调用
const _visionCache = new Map<string, boolean>();

async function isVisionModel(modelName: string): Promise<boolean> {
  if (!modelName) return false;

  // 命中缓存直接返回
  const cached = _visionCache.get(modelName);
  if (cached !== undefined) return cached;

  // ① 快速正则检查（比 API 快，零网络）
  const name = modelName.toLowerCase();
  if (/vision|multimodal|claude-3|gemini-|4o|vl/i.test(name)) {
    _visionCache.set(modelName, true);
    return true;
  }

  // ② 正则没抓到时调服务器 API（利用 litellm 的模型能力列表）
  try {
    const cfg = await chrome.storage.local.get(['backend_url', 'backend_key']);
    if (cfg.backend_url) {
      const baseUrl = (cfg.backend_url as string).replace(/\/+$/, '');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const resp = await fetch(
        `${baseUrl}/api/check-vision?model=${encodeURIComponent(modelName)}`,
        { headers: { Authorization: `Bearer ${cfg.backend_key || ''}` }, signal: controller.signal },
      );
      clearTimeout(timer);
      if (resp.ok) {
        const data = await resp.json();
        if (data.ok && data.data.supports_vision) {
          _visionCache.set(modelName, true);
          return true;
        }
      }
    }
  } catch {}

  _visionCache.set(modelName, false);
  return false;
}

async function updateImageButtonVisibility(): Promise<void> {
  const activeModel = getActiveModel();
  const modelName = activeModel ? activeModel.model : '';
  const canUpload = await isVisionModel(modelName || '');
  chatImgBtn.style.display = canUpload ? '' : 'none';
  if (!canUpload && pendingImages.length > 0) {
    pendingImages = [];
    renderImagePreview();
  }
}

function renderModelSwitcher(): void {
  const active = getActiveProvider();
  const activeModel = getActiveModel();
  if (active && activeModel) {
    const label = active.label || active.provider;
    chatModelLabel.textContent = `${label}:${activeModel.model}`;
  } else if (active) {
    chatModelLabel.textContent = active.label || active.provider;
  } else {
    chatModelLabel.textContent = '未配置';
  }
}

function showModelDropdown(): void {
  const list = chatModelDropdownList;
  const hasAny = aiProviders.some((p) => (p.models || []).length > 0);
  if (!hasAny) {
    list.innerHTML =
      '<div style="padding:12px;text-align:center;font-size:12px;color:var(--text-dim);">请先在 AI 配置中添加模型</div>';
    chatModelDropdown.classList.remove('hidden');
    return;
  }

  let html = '';
  aiProviders.forEach((p) => {
    const models = p.models || [];
    if (models.length === 0) return;
    const pLabel = p.label || p.provider;
    html += `<div style="padding:4px 12px;font-size:10px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;">${pLabel}</div>`;
    models.forEach((m) => {
      const isActive = p.id === activeProviderId && m.modelId === p.activeModelId;
      html += `<div class="chat-model-dropdown-item ${isActive ? 'active' : ''}" data-provider-id="${p.id}" data-model-id="${m.modelId}">
        <div class="md-check"></div>
        <div>
          <div style="font-weight:500;font-size:13px;">${m.model}</div>
        </div>
      </div>`;
    });
  });

  list.innerHTML = html;
  list.querySelectorAll('.chat-model-dropdown-item').forEach((item) => {
    item.addEventListener('click', () => {
      const pId = (item as HTMLElement).dataset.providerId;
      const mId = (item as HTMLElement).dataset.modelId;
      const currentProvider = getActiveProvider();
      if (pId && mId && (pId !== activeProviderId || mId !== currentProvider?.activeModelId)) {
        selectModelGlobally(pId, mId);
      }
      hideModelDropdown();
    });
  });
  chatModelDropdown.classList.remove('hidden');
}

function hideModelDropdown(): void {
  chatModelDropdown.classList.add('hidden');
}

async function selectModelGlobally(providerId: string, modelId: string): Promise<void> {
  const provider = aiProviders.find((p) => p.id === providerId);
  if (!provider) return;
  provider.activeModelId = modelId;
  updateActiveProviderId(providerId);
  _streamEnabled = provider.stream !== undefined ? provider.stream : true;
  await saveAiProviders();
  renderModelSwitcher();
  await updateImageButtonVisibility();
  syncActiveToBackend();
}

// ── 会话管理 ──
function renderSessionList(): void {
  // 历史会话已迁移至弹窗，此处保留空函数以兼容旧调用
}

function createSession(): void {
  const id = genId();
  chatSessions[id] = { id, title: '新对话', messages: [], createdAt: Date.now() };
  activeSessionId = id;
  renderSessionList();
  migrateLegacyFrames();
  renderChat();
  updateContextIndicator(chatSessions[activeSessionId]);
  saveSessions();
  chatInput.focus();
  refreshPageContext();
}

function switchSession(id: string): void {
  if (id === activeSessionId || !chatSessions[id]) return;
  activeSessionId = id;
  renderSessionList();
  renderChat();
  updateContextIndicator(chatSessions[id]);
  saveSessions();
  refreshPageContext();
}

function deleteSession(id: string): void {
  delete chatSessions[id];
  const ids = Object.keys(chatSessions);
  if (ids.length === 0) {
    const nid = genId();
    chatSessions[nid] = { id: nid, title: '新对话', messages: [], createdAt: Date.now() };
    activeSessionId = nid;
  } else {
    if (id === activeSessionId) {
      activeSessionId = ids[ids.length - 1];
    }
  }
  renderSessionList();
  renderChat();
  saveSessions();
}

// ── 消息渲染 ──
function renderChat(): void {
  chatMessages.innerHTML = '';
  const msgs = getActiveMessages().filter((m) => m.role !== 'system');
  if (msgs.length === 0) {
    chatMessages.innerHTML = `<div class="chat-welcome">
      <div class="chat-welcome-icon">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="#fff"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
      </div>
      <h3>AI 对话</h3>
      <p>问我任何关于当前页面的问题</p>
    </div>`;
    return;
  }
  msgs.forEach((msg) => {
    const msgData: { images?: string[]; frames?: VideoFrame[]; pageUrl?: string } = {};
    if (msg.images && msg.images.length > 0) msgData.images = msg.images;
    if (msg.frames && msg.frames.length > 0) msgData.frames = msg.frames;
    if (msg.pageUrl) msgData.pageUrl = msg.pageUrl;
    const bubbleEl = addMessageBubble(
      msg.role,
      msg.display || msg.content,
      false,
      Object.keys(msgData).length > 0 ? msgData : undefined
    );
    if (bubbleEl) {
      // 从 session 的 pageContext 恢复 pageUrl（仅当消息中未存储时作为兜底）
      if (msg.images && msg.images.length > 0 && !msg.pageUrl) {
        const session = activeSessionId ? chatSessions[activeSessionId] : null;
        const pageUrl = session?.pageContext?.url;
        if (pageUrl) {
          const contentEl = bubbleEl.querySelector('.chat-msg-bubble') as HTMLDivElement;
          if (contentEl) contentEl.dataset.pageUrl = pageUrl;
        }
      }
      if (msg.isMindmap) {
        const contentEl = bubbleEl.querySelector('.chat-msg-bubble') as HTMLDivElement;
        if (contentEl) renderMindmapResultPanel(contentEl, msg.content);
      }
    }
  });
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addMessageBubble(
  role: string,
  content: string,
  animate = true,
  msgData?: { images?: string[]; frames?: VideoFrame[]; pageUrl?: string }
): HTMLDivElement {
  // 追加气泡时移除欢迎语
  const welcome = chatMessages.querySelector('.chat-welcome');
  if (welcome) welcome.remove();
  const div = document.createElement('div');
  div.className = 'chat-message ' + role;
  if (!animate) div.style.animation = 'none';

  if (role === 'system') {
    div.className = 'chat-message system-notice';
    div.textContent = content;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
  }

  const avatar = document.createElement('div');
  avatar.className = 'chat-avatar';
  if (role === 'user') {
    avatar.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="5"/><path d="M4 22c0-4 4-7 8-7s8 3 8 7"/></svg>';
  } else {
    avatar.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><circle cx="9" cy="13" r="1.5" fill="currentColor"/><circle cx="15" cy="13" r="1.5" fill="currentColor"/><path d="M9 3l3 3 3-3"/><line x1="12" y1="3" x2="12" y2="6"/></svg>';
  }
  div.appendChild(avatar);

  const body = document.createElement('div');
  body.className = 'chat-msg-body';

  const bubble = document.createElement('div');
  bubble.className = 'chat-msg-bubble';

  if (role === 'user' && msgData && msgData.images && msgData.images.length > 0) {
    const imgContainer = document.createElement('div');
    imgContainer.className = 'chat-msg-images';
    msgData.images.forEach((dataUrl) => {
      const img = document.createElement('img');
      img.className = 'chat-msg-image';
      img.src = dataUrl;
      img.loading = 'lazy';
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        openImageModal(dataUrl);
      });
      imgContainer.appendChild(img);
    });
    bubble.appendChild(imgContainer);
  }

  if (role === 'assistant') {
    if (msgData && msgData.images && msgData.images.length > 0) {
      // 重建帧画廊（含交错段落）
      const pageUrl = msgData.frames?.[0]?.pageUrl || msgData.pageUrl;
      if (pageUrl) bubble.dataset.pageUrl = pageUrl;
      const galleryHtml = buildFrameGalleryHtml(content || '', msgData.images);
      bubble.innerHTML = galleryHtml;
      attachGalleryHandlers(bubble);
    } else {
      bubble.innerHTML = renderMarkdown(content || '');
    }
    processTimestamps(bubble, msgData?.frames);
    if (msgData && msgData.frames && msgData.frames.length > 0) {
      for (const frame of msgData.frames) {
        insertFrameIntoContainer(frame, bubble);
      }
    }
  } else {
    if (content) {
      const textEl = document.createElement('div');
      textEl.textContent = content;
      bubble.appendChild(textEl);
    }
  }
  body.appendChild(bubble);

  const actions = document.createElement('div');
  actions.className = 'chat-msg-actions';

  if (role === 'assistant') {
    const editBtn = document.createElement('button');
    editBtn.className = 'chat-msg-action-btn';
    editBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
    editBtn.title = '编辑';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      editMessage(div, bubble, content);
    });
    actions.appendChild(editBtn);
  }

  const copyBtn = document.createElement('button');
  copyBtn.className = 'chat-msg-action-btn';
  copyBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
  copyBtn.title = '复制';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(content).catch(() => {});
    copyBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>';
    setTimeout(() => {
      copyBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
    }, 1500);
  });
  actions.appendChild(copyBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'chat-msg-action-btn chat-msg-action-del';
  delBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
  delBtn.title = '删除';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteMessage(div);
  });
  actions.appendChild(delBtn);

  body.appendChild(actions);
  div.appendChild(body);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function processTimestamps(container: HTMLElement, frames?: VideoFrame[]): void {
  const tsRegex = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
  const nodesToReplace: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement && node.parentElement.closest('a, button, pre, code')) continue;
    if (tsRegex.test(node.textContent || '')) {
      nodesToReplace.push(node);
    }
    tsRegex.lastIndex = 0;
  }

  for (const textNode of nodesToReplace) {
    const text = textNode.textContent || '';
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    tsRegex.lastIndex = 0;
    while ((match = tsRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const h = match[3] ? parseInt(match[1]) : 0;
      const m = match[3] ? parseInt(match[2]) : parseInt(match[1]);
      const s = match[3] ? parseInt(match[3]) : parseInt(match[2]);
      const totalSeconds = h * 3600 + m * 60 + s;

      let pageUrl: string | undefined;
      if (frames && frames.length > 0) {
        const frame = frames.find((f) => Math.abs(f.seconds - totalSeconds) < 0.5);
        if (frame && frame.pageUrl) pageUrl = frame.pageUrl;
      }

      const link = document.createElement('a');
      link.className = 'chat-timestamp-link';
      link.textContent = match[0];
      link.href = '#';
      link.title = '跳转到视频 ' + match[0] + ' 位置';
      link.addEventListener(
        'click',
        ((sec: number, url?: string) => (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          seekVideoTo(sec, url || container.dataset.pageUrl);
        })(totalSeconds, pageUrl)
      );

      fragment.appendChild(link);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    textNode.parentNode?.replaceChild(fragment, textNode);
  }
}

async function seekVideoTo(seconds: number, pageUrl?: string): Promise<void> {
  try {
    let tabId: number | null = null;
    console.log('[KnowSeek] seekVideoTo: seconds=%d, pageUrl=%s', seconds, pageUrl || '(none)');

    if (pageUrl) {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      console.log('[KnowSeek] seekVideoTo step1: pageUrl tabs found=%d', tabs ? tabs.length : 0);
      if (tabs && tabs.length > 0) {
        tabId = tabs[0].id!;
      }
    }

    if (!tabId && !pageUrl) {
      const session = activeSessionId ? chatSessions[activeSessionId] : null;
      if (session && session.messages) {
        for (const msg of session.messages) {
          if (msg.frames && msg.frames.length > 0) {
            const matchedFrame = msg.frames.find((f) => Math.abs(f.seconds - seconds) < 0.5);
            if (matchedFrame && matchedFrame.pageUrl) {
              pageUrl = matchedFrame.pageUrl;
              console.log('[KnowSeek] seekVideoTo step1.5: found pageUrl from frames=%s', pageUrl);
              try {
                const tabs = await chrome.tabs.query({ url: pageUrl });
                if (tabs && tabs.length > 0) {
                  tabId = tabs[0].id!;
                }
              } catch (_) {}
              break;
            }
            if (!pageUrl && msg.frames[0].pageUrl) {
              pageUrl = msg.frames[0].pageUrl;
            }
          }
        }
      }
      if (pageUrl) {
        console.log('[KnowSeek] seekVideoTo step1.5: resolved pageUrl=%s', pageUrl);
      }
    }

    if (!tabId) {
      const session = activeSessionId ? chatSessions[activeSessionId] : null;
      const sessionUrl = pageUrl || session?.pageContext?.url;
      console.log('[KnowSeek] seekVideoTo step3: sessionUrl=%s', sessionUrl || '(none)');
      if (sessionUrl && (sessionUrl.startsWith('http://') || sessionUrl.startsWith('https://'))) {
        try {
          const a = new URL(sessionUrl);
          const allTabs = await chrome.tabs.query({});
          console.log('[KnowSeek] seekVideoTo step3: total open tabs=%d', allTabs.length);
          const match = allTabs.find((t) => {
            try {
              const tu = new URL(t.url || '');
              if (!tu.protocol.startsWith('http')) return false;
              return tu.hostname === a.hostname && tu.pathname === a.pathname;
            } catch (_) {
              return false;
            }
          });
          console.log('[KnowSeek] seekVideoTo step3: match found=%s', match ? 'yes' : 'no');
          if (match) tabId = match.id!;
        } catch (e) {
          console.log('[KnowSeek] seekVideoTo step3 error:', (e as Error).message);
        }
      }
    }

    if (!tabId) {
      const session = activeSessionId ? chatSessions[activeSessionId] : null;
      const rawUrl = pageUrl || session?.pageContext?.url;
      const openUrl =
        rawUrl && (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) ? rawUrl : null;
      console.log('[KnowSeek] seekVideoTo step4: rawUrl=%s, openUrl=%s', rawUrl || '(none)', openUrl || '(none)');
      if (openUrl && typeof openUrl === 'string') {
        console.log('[KnowSeek] seekVideoTo step4: creating tab with', openUrl);
        const tab = await chrome.tabs.create({ url: openUrl, active: true });
        tabId = tab.id!;
        console.log('[KnowSeek] seekVideoTo step4: tab created, id=%d', tabId);
        const pollTimeout = 15000;
        const pollStart = Date.now();
        while (Date.now() - pollStart < pollTimeout) {
          try {
            const t = await chrome.tabs.get(tabId);
            if (t.status === 'complete') {
              console.log('[KnowSeek] seekVideoTo step4: tab loaded in %dms', Date.now() - pollStart);
              break;
            }
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 300));
        }
        console.log('[KnowSeek] seekVideoTo step4: waiting 1.5s for video player...');
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    if (!tabId) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || !tabs[0]) return;
      tabId = tabs[0].id!;
    }

    console.log('[KnowSeek] seekVideoTo: executing script on tab %d', tabId);
    const execResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (sec: number) => {
        function getMainVideo(): HTMLVideoElement | null {
          const bili = document.querySelector('.bpx-player-video-wrap video') as HTMLVideoElement | null;
          if (bili && bili.offsetParent !== null) return bili;
          const yt = document.querySelector('.html5-main-video') as HTMLVideoElement | null;
          if (yt && yt.offsetParent !== null) return yt;
          let best: HTMLVideoElement | null = null;
          let bestArea = 0;
          document.querySelectorAll('video').forEach((v) => {
            if (v.offsetParent === null) return;
            const rect = v.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area > bestArea) {
              bestArea = area;
              best = v;
            }
          });
          return best || document.querySelector('video');
        }
        for (let i = 0; i < 5; i++) {
          const video = getMainVideo();
          if (video) {
            console.log('[KnowSeek] seekVideoTo: found video at retry', i);
            video.currentTime = sec;
            video.play().catch(() => {});
            video.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return 'found';
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        return 'not_found';
      },
      args: [seconds],
    });
    console.log('[KnowSeek] seekVideoTo: execResult=%s', execResult?.[0]?.result || '(no result)');
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) {
    console.log('[KnowSeek] seekVideoTo error:', (e as Error).message);
  }
}

// ── OPFS 帧存储 ──
async function saveFrameToOPFS(frameId: string, dataUrl: string): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('snapshots', { create: true });
    const fileHandle = await dir.getFileHandle(frameId + '.jpg', { create: true });
    const writable = await fileHandle.createWritable();
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (e) {
    console.warn('[KnowSeek] saveFrameToOPFS failed:', e);
    return false;
  }
}

async function loadFrameFromOPFS(frameId: string): Promise<string | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('snapshots');
    const fileHandle = await dir.getFileHandle(frameId + '.jpg');
    const file = await fileHandle.getFile();
    const arrayBuffer = await file.arrayBuffer();
    const blob = new Blob([arrayBuffer], { type: 'image/jpeg' });
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    return null;
  }
}

async function deleteFrameFromOPFS(frameId: string): Promise<void> {
  if (!frameId) return;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('snapshots');
    await dir.removeEntry(frameId + '.jpg');
  } catch (err) {
    // ignore
  }
}

async function migrateLegacyFrames(): Promise<void> {
  let migrated = 0;
  for (const sid of Object.keys(chatSessions)) {
    const msgs = chatSessions[sid].messages || [];
    for (const msg of msgs) {
      if (msg.frames && msg.frames.length > 0) {
        for (const frame of msg.frames) {
          if (frame.dataUrl && !frame.frameId) {
            const frameId = 'chat_frame_' + sid + '_' + frame.seconds + '_' + Date.now();
            const ok = await saveFrameToOPFS(frameId, frame.dataUrl);
            if (ok) {
              delete frame.dataUrl;
              frame.frameId = frameId;
              migrated++;
            }
          }
        }
      }
    }
  }
  if (migrated > 0) {
    console.log('[KnowSeek] Migrated ' + migrated + ' frames to OPFS, saving sessions');
    saveSessions();
  }
}

function insertFrameIntoContainer(frame: VideoFrame, container: HTMLElement): void {
  const links = container.querySelectorAll('a.chat-timestamp-link');
  let targetLink: HTMLAnchorElement | null = null;
  for (const link of links) {
    const tsText = link.textContent?.replace(/[\[\]]/g, '').trim();
    if (tsText === frame.timeStr || tsText?.startsWith(frame.timeStr)) {
      targetLink = link as HTMLAnchorElement;
      break;
    }
  }
  if (!targetLink) {
    console.log('[KnowSeek] insertFrameIntoContainer: NO MATCH for', frame.timeStr);
    return;
  }

  const createImgElement = (parentEl: HTMLElement) => {
    if (frame.dataUrl) {
      parentEl.innerHTML = `<img src="${frame.dataUrl}" alt="${frame.timeStr}">`;
    } else if (frame.frameId) {
      const img = document.createElement('img');
      img.alt = frame.timeStr;
      img.style.cssText = 'min-height:60px;background:#e5e7eb;';
      parentEl.appendChild(img);
      loadFrameFromOPFS(frame.frameId).then((dataUrl) => {
        if (dataUrl) img.src = dataUrl;
      });
    }
    parentEl.addEventListener(
      'click',
      ((s: number, url?: string) => (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        seekVideoTo(s, url);
      })(frame.seconds, frame.pageUrl)
    );
  };

  const parentBlock = targetLink.closest('p, li, div');
  console.log(
    '[KnowSeek] insertFrameIntoContainer: timeStr=%s, parentTag=%s',
    frame.timeStr,
    parentBlock ? parentBlock.tagName : 'null'
  );

  if (parentBlock && parentBlock.tagName === 'LI') {
    const imgLi = document.createElement('li');
    imgLi.style.listStyle = 'none';
    imgLi.style.margin = '0';
    imgLi.style.padding = '0';
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-video-frame-inline';
    createImgElement(wrapper);
    imgLi.appendChild(wrapper);
    parentBlock.parentNode?.insertBefore(imgLi, parentBlock);
    return;
  }

  if (parentBlock && parentBlock.tagName === 'P') {
    const wrapper = document.createElement('span');
    wrapper.className = 'chat-video-frame-inline';
    wrapper.style.display = 'block';
    createImgElement(wrapper);
    parentBlock.insertBefore(wrapper, targetLink);
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'chat-video-frame-inline';
  createImgElement(wrapper);
  if (parentBlock && parentBlock.parentNode) {
    parentBlock.parentNode.insertBefore(wrapper, parentBlock);
  } else {
    targetLink.parentNode?.insertBefore(wrapper, targetLink);
  }
}

async function captureTimestampsFrames(text: string, container: HTMLElement): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0]) {
      console.log('[KnowSeek] captureTimestampsFrames: no active tab');
      return;
    }
    const tabId = tabs[0].id!;
    const url = tabs[0].url || '';
    if (!url.includes('bilibili.com/video/') && !url.includes('youtube.com/watch') && !url.includes('b23.tv/')) {
      console.log('[KnowSeek] captureTimestampsFrames: not a video page:', url);
      return;
    }

    console.log('[KnowSeek] captureTimestampsFrames: video page detected');

    const session = activeSessionId ? chatSessions[activeSessionId] : null;
    const msgs = session?.messages || [];
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    if (!lastMsg || lastMsg.role !== 'assistant') return;

    const tsRegex = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g;
    const tsMap = new Map<number, string>();
    let match: RegExpExecArray | null;
    while ((match = tsRegex.exec(text)) !== null) {
      const h = match[3] ? parseInt(match[1]) : 0;
      const m = match[3] ? parseInt(match[2]) : parseInt(match[1]);
      const s = match[3] ? parseInt(match[3]) : parseInt(match[2]);
      const totalSec = h * 3600 + m * 60 + s;
      if (!tsMap.has(totalSec)) {
        tsMap.set(totalSec, `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
      }
    }
    if (tsMap.size === 0) {
      console.log('[KnowSeek] captureTimestampsFrames: no timestamps found in AI reply');
      return;
    }

    console.log('[KnowSeek] captureTimestampsFrames: found timestamps:', [...tsMap.keys()].sort((a, b) => a - b));

    const sortedTs = [...tsMap.keys()].sort((a, b) => a - b);
    if (!lastMsg.frames) lastMsg.frames = [];

    let insertedCount = 0;
    for (const sec of sortedTs) {
      // 优先使用缓存的预截帧
      const cached = _preCapturedVideoFrames.get(sec);
      if (cached) {
        const frameId = 'chat_frame_' + activeSessionId + '_' + sec + '_' + Date.now();
        await saveFrameToOPFS(frameId, cached);
        const frame: VideoFrame = { seconds: sec, frameId, timeStr: tsMap.get(sec) || '', pageUrl: url };
        lastMsg.frames.push(frame);
        insertFrameIntoContainer({ ...frame, dataUrl: cached }, container);
        insertedCount++;
        continue;
      }

      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: async (timestamp: number) => {
            try {
              const video = document.querySelector('video') as HTMLVideoElement | null;
              if (!video) return { error: 'No video element' };
              video.pause();
              video.currentTime = timestamp;
              await new Promise<void>((resolve) => {
                const onSeeked = () => {
                  video.removeEventListener('seeked', onSeeked);
                  resolve();
                };
                video.addEventListener('seeked', onSeeked, { once: true });
                setTimeout(resolve, 3000);
              });
              const canvas = document.createElement('canvas');
              canvas.width = video.videoWidth || 640;
              canvas.height = video.videoHeight || 360;
              const ctx = canvas.getContext('2d');
              if (ctx) ctx.drawImage(video, 0, 0);
              return { dataUrl: canvas.toDataURL('image/jpeg', 0.3) };
            } catch (e) {
              return { error: (e as Error).message };
            }
          },
          args: [sec],
        });
        if (results && results[0] && results[0].result && results[0].result.dataUrl) {
          const dataUrl = results[0].result.dataUrl;
          const frameId = 'chat_frame_' + activeSessionId + '_' + sec + '_' + Date.now();
          await saveFrameToOPFS(frameId, dataUrl);
          const frame: VideoFrame = { seconds: sec, frameId, timeStr: tsMap.get(sec) || '', pageUrl: url };
          lastMsg.frames.push(frame);
          insertFrameIntoContainer({ ...frame, dataUrl }, container);
          insertedCount++;
        } else if (results && results[0] && results[0].result && results[0].result.error) {
          console.log('[KnowSeek] capture frame error at', sec, ':', results[0].result.error);
        }
      } catch (e) {
        console.log('[KnowSeek] executeScript failed at', sec, ':', (e as Error).message);
      }
    }

    console.log('[KnowSeek] captured frames:', insertedCount);
    saveSessions();
  } catch (e) {
    console.log('[KnowSeek] captureTimestampsFrames error:', (e as Error).message);
  }
}

function deleteMessage(bubbleEl: HTMLDivElement): void {
  const idx = Array.from(chatMessages.children).indexOf(bubbleEl);
  if (idx === -1) return;
  const session = activeSessionId ? chatSessions[activeSessionId] : null;
  if (!session || idx >= session.messages.length) return;
  const msg = session.messages[idx];
  if (msg.frames && msg.frames.length > 0) {
    for (const frame of msg.frames) {
      if (frame.frameId) deleteFrameFromOPFS(frame.frameId);
    }
  }
  session.messages.splice(idx, 1);
  if (session.messages.length === 0) {
    session.title = '新对话';
  } else {
    const firstUser = session.messages.find((m) => m.role === 'user');
    if (firstUser) {
      session.title = firstUser.content.length > 20 ? firstUser.content.slice(0, 20) + '…' : firstUser.content;
    }
  }
  renderChat();
  renderHistoryModal();
  saveSessions();
  updateContextIndicator(session);
}

function editMessage(bubbleEl: HTMLDivElement, bubble: HTMLDivElement, originalContent: string): void {
  const actions = bubbleEl.querySelector('.chat-msg-actions') as HTMLDivElement | null;
  if (actions) actions.style.display = 'none';

  bubble.textContent = originalContent;
  bubble.contentEditable = 'true';
  bubble.classList.add('editing');
  bubble.focus();
  const sel = window.getSelection();
  if (sel) {
    sel.selectAllChildren(bubble);
    sel.collapseToEnd();
  }

  const editActions = document.createElement('div');
  editActions.className = 'chat-msg-edit-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'chat-msg-edit-btn save';
  saveBtn.textContent = '保存';
  editActions.appendChild(saveBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'chat-msg-edit-btn cancel';
  cancelBtn.textContent = '取消';
  editActions.appendChild(cancelBtn);

  bubble.parentNode?.insertBefore(editActions, bubble.nextSibling);

  function finishEdit(save: boolean) {
    bubble.contentEditable = 'false';
    bubble.classList.remove('editing');
    if (save) {
      const newContent = bubble.textContent?.trim() || '';
      if (newContent && newContent !== originalContent) {
        const idx = Array.from(chatMessages.children).indexOf(bubbleEl);
        if (idx !== -1) {
          const session = activeSessionId ? chatSessions[activeSessionId] : null;
          if (session && idx < session.messages.length) {
            session.messages[idx].content = newContent;
            saveSessions();
          }
        }
      }
    }
    renderChat();
  }

  saveBtn.addEventListener('click', () => finishEdit(true));
  cancelBtn.addEventListener('click', () => finishEdit(false));
  bubble.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      finishEdit(true);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      finishEdit(false);
    }
  });
}

function addThinkingBubble(): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'chat-message assistant thinking';
  div.id = 'chatThinking';

  const avatar = document.createElement('div');
  avatar.className = 'chat-avatar';
  avatar.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><circle cx="9" cy="13" r="1.5" fill="currentColor"/><circle cx="15" cy="13" r="1.5" fill="currentColor"/><path d="M9 3l3 3 3-3"/><line x1="12" y1="3" x2="12" y2="6"/></svg>';
  div.appendChild(avatar);

  const body = document.createElement('div');
  body.className = 'chat-msg-body';

  const bubble = document.createElement('div');
  bubble.className = 'chat-msg-bubble';
  bubble.textContent = '⏳ 思考中';
  body.appendChild(bubble);

  div.appendChild(body);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function removeThinkingBubble(): void {
  const el = document.getElementById('chatThinking');
  if (el) el.remove();
}

// ── 思维导图 ──
function renderMindmapResultPanel(contentEl: HTMLDivElement, markdownContent: string): void {
  const markmapGlobal = (window as any).markmap;
  if (typeof markmapGlobal === 'undefined' || !markmapGlobal.Transformer || !markmapGlobal.Markmap) {
    if (!_mindmapLibsReady) {
      contentEl.innerHTML =
        '<div style="padding:24px;text-align:center;color:var(--text-muted,#999);font-size:13px;">⏳ 思维导图加载中...</div>';
      contentEl.dataset.mindmapContent = markdownContent;
      _mindmapPendingQueue.push(() => {
        if (document.contains(contentEl) && contentEl.dataset.mindmapContent) {
          renderMindmapResultPanel(contentEl, contentEl.dataset.mindmapContent);
        }
      });
    } else {
      contentEl.innerHTML =
        '<div style="padding:24px;text-align:center;color:var(--text-muted,#999);font-size:13px;">思维导图加载失败</div>';
    }
    return;
  }

  delete contentEl.dataset.mindmapContent;

  contentEl.innerHTML =
    '🧠 思维导图已生成完成，请<a href="#" class="mindmap-link preview-link" style="color:var(--accent,#10b981);text-decoration:underline;">预览</a>或<a href="#" class="mindmap-link edit-link" style="color:var(--accent,#10b981);text-decoration:underline;">编辑</a>思维导图。';

  const previewLink = contentEl.querySelector('.preview-link');
  const editLink = contentEl.querySelector('.edit-link');
  if (previewLink)
    previewLink.addEventListener('click', (e) => {
      e.preventDefault();
      showMindmap(markdownContent);
    });
  if (editLink)
    editLink.addEventListener('click', (e) => {
      e.preventDefault();
      openMindmapEditor(markdownContent, contentEl);
    });
}

function openMindmapEditor(markdownContent: string, contentEl: HTMLDivElement): void {
  const existing = document.getElementById('mindmapEditorOverlay');
  if (existing) existing.remove();

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  const overlay = document.createElement('div');
  overlay.id = 'mindmapEditorOverlay';
  overlay.className = 'mindmap-editor-overlay';

  const panel = document.createElement('div');
  panel.className = 'mindmap-editor-panel';

  const header = document.createElement('div');
  header.className = 'mindmap-editor-header';

  const title = document.createElement('span');
  title.textContent = '✏️ 编辑思维导图';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.className = 'mindmap-editor-close';
  closeBtn.addEventListener('click', () => overlay.remove());

  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'mindmap-editor-body';

  const leftCol = document.createElement('div');
  leftCol.className = 'mindmap-editor-left';

  const textarea = document.createElement('textarea');
  textarea.className = 'mindmap-editor-textarea';
  textarea.value = markdownContent;
  leftCol.appendChild(textarea);

  body.appendChild(leftCol);

  const rightCol = document.createElement('div');
  rightCol.className = 'mindmap-editor-right';

  const previewSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  previewSvg.setAttribute('class', 'mindmap-editor-preview-svg');
  rightCol.appendChild(previewSvg);

  body.appendChild(rightCol);
  panel.appendChild(body);

  const footer = document.createElement('div');
  footer.className = 'mindmap-editor-footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'mindmap-editor-btn cancel';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const applyBtn = document.createElement('button');
  applyBtn.className = 'mindmap-editor-btn apply';
  applyBtn.textContent = '✅ 应用到气泡';
  applyBtn.addEventListener('click', () => {
    const newContent = textarea.value.trim();
    if (!newContent) return;
    renderMindmapResultPanel(contentEl, newContent);
    if (activeSessionId && chatSessions[activeSessionId]) {
      const msgs = chatSessions[activeSessionId].messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].isMindmap) {
          msgs[i].content = newContent;
          break;
        }
      }
    }
    overlay.remove();
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(applyBtn);
  panel.appendChild(footer);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  let previewInstance: any = null;
  let debounceTimer: number | null = null;

  function renderPreview(md: string) {
    if (previewInstance) {
      previewInstance.destroy();
      previewInstance = null;
    }
    previewSvg.innerHTML = '';
    if (!md.trim()) return;
    try {
      const markmapGlobal = (window as any).markmap;
      if (typeof markmapGlobal === 'undefined' || !markmapGlobal.Transformer || !markmapGlobal.Markmap) return;
      const { Transformer, Markmap } = markmapGlobal;
      const transformer = new Transformer();
      const { root } = transformer.transform(md);
      previewInstance = Markmap.create(
        previewSvg,
        {
          zoom: true,
          pan: true,
          fitRatio: 0.95,
          duration: 100,
          maxWidth: 280,
          nodeMinHeight: 16,
          spacingVertical: 6,
          spacingHorizontal: 50,
          paddingX: 10,
          paddingY: 6,
          style: isDark
            ? () => `
              .markmap-node text, .markmap-node tspan { fill: #ffffff !important; }
              foreignObject div { color: #ffffff !important; }
            `
            : undefined,
        },
        root
      );
      setTimeout(() => {
        if (previewInstance) previewInstance.fit();
      }, 50);
    } catch (e) {
      console.warn('[KnowSeek] editor preview error:', e);
    }
  }

  textarea.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => renderPreview(textarea.value), 300);
  });

  setTimeout(() => {
    renderPreview(markdownContent);
    textarea.focus();
  }, 100);
}

function showMindmap(markdownContent: string): void {
  const modal = document.getElementById('mindmapModal') as HTMLDivElement;
  const svg = document.getElementById('mindmapSvg') as SVGSVGElement;
  modal.classList.remove('hidden');

  if (_mindmapInstance) {
    _mindmapInstance.destroy();
    _mindmapInstance = null;
  }

  svg.innerHTML = '';

  try {
    const markmapGlobal = (window as any).markmap;
    if (typeof markmapGlobal === 'undefined' || !markmapGlobal.Transformer || !markmapGlobal.Markmap) {
      svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="red">思维导图库加载失败</text>';
      return;
    }

    const { Transformer, Markmap } = markmapGlobal;
    const transformer = new Transformer();
    const { root } = transformer.transform(markdownContent);

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

    _mindmapInstance = Markmap.create(
      svg,
      {
        zoom: true,
        pan: true,
        fitRatio: 1,
        duration: 500,
        maxWidth: 300,
        nodeMinHeight: 20,
        spacingVertical: 8,
        spacingHorizontal: 60,
        paddingX: 14,
        paddingY: 8,
        style: isDark
          ? () => `
            .markmap-node text, .markmap-node tspan { fill: #ffffff !important; }
            foreignObject div { color: #ffffff !important; }
          `
          : undefined,
      },
      root
    );
    setTimeout(() => {
      if (_mindmapInstance) _mindmapInstance.fit();
    }, 100);
  } catch (e) {
    console.warn('[KnowSeek] markmap render error:', e);
    svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="red">思维导图渲染失败</text>';
  }
}

function closeMindmap(): void {
  const modal = document.getElementById('mindmapModal') as HTMLDivElement;
  modal.classList.add('hidden');
  if (_mindmapInstance) {
    _mindmapInstance.destroy();
    _mindmapInstance = null;
  }
}

(function bindMindmapEvents() {
  const closeBtn = document.getElementById('mindmapModalClose');
  const overlay = document.getElementById('mindmapModalOverlay');
  if (closeBtn) closeBtn.addEventListener('click', closeMindmap);
  if (overlay) overlay.addEventListener('click', closeMindmap);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMindmap();
  });
})();

// ── 待发送文本与上下文 ──
function setPendingText(text: string): void {
  _pendingText = text;
  chatPendingText.textContent = text;
  chatPendingArea.classList.remove('hidden');
  chatPresets.classList.remove('hidden');
  chatInput.focus();
}

function clearPending(): void {
  _pendingText = '';
  chatPendingText.textContent = '';
  chatPendingArea.classList.add('hidden');
  chatPresets.classList.add('hidden');
}

function showContextIndicator(title: string): void {
  chatContextText.textContent = title ? `当前页面：${title}` : '当前页面作为上下文';
  chatContextIndicator.classList.remove('hidden');
}

function hideContextIndicator(): void {
  chatContextIndicator.classList.add('hidden');
  chatContextText.textContent = '';
}

function updateContextIndicator(session: ChatSession | null): void {
  if (session && session.pageContext && session.pageContext.title) {
    let title = session.pageContext.title;
    if (session.pageContext.noSubtitles) {
      title += ' ⚠️无字幕';
    }
    showContextIndicator(title);
  } else {
    hideContextIndicator();
  }
  updateSubtitlePreview(session);
}

let _subtitlePreviewSubtitles = '';

function updateSubtitlePreview(session: ChatSession | null): void {
  const subtitles = session?.pageContext?.subtitles;
  if (subtitles && subtitles.trim()) {
    const lines = subtitles.trim().split('\n').length;
    chatSubtitleText.textContent = `预览字幕 (${lines}行)`;
    chatSubtitlePreview.classList.remove('hidden');
  } else {
    chatSubtitlePreview.classList.add('hidden');
    chatSubtitleText.textContent = '预览字幕';
  }
}

function showSubtitlePreviewModal(subtitles: string): void {
  // 将行首 MM:SS 时间戳转为可点击链接（B站字幕格式：`00:00 文本`）
  const htmlContent = escHtml(subtitles.trim()).replace(
    /^(\d{1,2}):(\d{2})\s/gm,
    (_m, m, s) => {
      const secs = parseInt(m) * 60 + parseInt(s);
      return `<a href="#" class="st-link" data-ts="${secs}" style="color:var(--accent,#3b82f6);text-decoration:underline;cursor:pointer;">${m}:${s}</a> `;
    }
  );
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--bg-surface,#fff);border-radius:12px;max-width:600px;width:90%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.2);';
  modal.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border,#eee);">
      <span style="font-weight:600;font-size:14px;color:var(--text-color,#333);">📝 字幕预览</span>
      <button class="sp-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-dim,#999);padding:0 4px;">×</button>
    </div>
    <div class="st-body" style="flex:1;overflow-y:auto;padding:12px 16px;font-size:13px;line-height:1.7;white-space:pre-wrap;color:var(--text-color,#333);">${htmlContent}</div>
    <div style="display:flex;justify-content:space-between;padding:10px 16px;border-top:1px solid var(--border,#eee);">
      <button class="sp-copy-btn" style="padding:6px 16px;border:1px solid var(--border,#ddd);border-radius:6px;background:var(--bg-surface,#fff);color:var(--text-color,#333);font-size:13px;cursor:pointer;">复制</button>
      <button class="sp-close-btn" style="padding:6px 16px;border:1px solid var(--border,#ddd);border-radius:6px;background:var(--bg-surface,#fff);color:var(--text-color,#333);font-size:13px;cursor:pointer;">关闭</button>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // 时间轴点击跳转
  modal.querySelector('.st-body')!.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest('.st-link') as HTMLAnchorElement;
    if (!link) return;
    e.preventDefault();
    const ts = parseInt(link.dataset.ts || '0');
    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'seekToVideoTimestamp', timestamp: ts }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
      }
    });
  });

  modal.querySelector('.sp-close')!.addEventListener('click', () => overlay.remove());
  modal.querySelector('.sp-close-btn')!.addEventListener('click', () => overlay.remove());
  modal.querySelector('.sp-copy-btn')!.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(subtitles.trim());
      const btn = modal.querySelector('.sp-copy-btn') as HTMLButtonElement;
      btn.textContent = '✅ 已复制';
      setTimeout(() => { btn.textContent = '复制'; }, 2000);
    } catch { /* ignore */ }
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

async function onPanelShown(): Promise<void> {
  refreshPageContext();
  updateGlobalPresets();
  await updateImageButtonVisibility();
  renderModelSwitcher();
}

/** 检测是否有中断的视频总结（仅在侧边栏新打开时调用，面板切换不触发） */
async function _checkInterruptedSummary(): Promise<void> {
  try {
    const sessionId = activeSessionId;
    if (!sessionId) return;
    const data = await chrome.storage.session.get(`video_summary_${sessionId}`);
    const summaryState = data[`video_summary_${sessionId}`];
    if (!summaryState) return;

    // 找到最后一条 assistant 消息，如果内容是进度占位，追加中断提示
    const session = chatSessions[sessionId];
    if (session && session.messages.length > 0) {
      const lastMsg = session.messages[session.messages.length - 1];
      if (lastMsg.role === 'assistant' && lastMsg.content.startsWith('⏳')) {
        lastMsg.content += '\n\n> ⚠️ 总结已中断，请重新发起总结';
        saveSessions();
        renderChat();
      }
    }
    // 清理 session 存储
    chrome.storage.session.remove(`video_summary_${sessionId}`).catch(() => {});
  } catch (e) {
    // ignore
  }
}

/** 刷新当前页面的上下文并立即更新指示器 */
function refreshPageContext(): void {
  const panel = document.getElementById('chatPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  const session = activeSessionId ? chatSessions[activeSessionId] : null;
  if (!session) return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    const tab = tabs[0];
    const tabUrl = tab.url || '';
    const oldUrl = session.pageContext ? session.pageContext.url : null;

    // 非 http/https 页面不显示上下文
    if (!tabUrl.startsWith('http://') && !tabUrl.startsWith('https://')) return;

    // URL 变了 → 系统通知
    if (oldUrl && oldUrl !== tabUrl) {
      session.messages.push({ role: 'system', content: `[已切换到新页面：${tab.title}]` });
    }

    // 立即用标题设置上下文（不先清空，避免指示器闪烁）
    session.pageContext = { title: tab.title || '', url: tabUrl, content: null };
    updateContextIndicator(session);
    saveSessions();

    // 异步加载完整内容
    getPageContextNow().then((ctx) => {
      if (ctx && ctx.content) {
        session.pageContext = ctx;
        updateContextIndicator(session);
        saveSessions();
      }
    });
  });
}

function getPageContextNow(): Promise<PageContext | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) {
        resolve(null);
        return;
      }
      const tab = tabs[0];
      chrome.tabs.sendMessage(tab.id!, { action: 'getPageContext' }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.content) {
          resolve(null);
          return;
        }
        resolve({
          title: resp.title || tab.title,
          url: resp.url || tab.url,
          content: resp.content,
          noSubtitles: resp.noSubtitles === true,
          isVideoPage: resp.isVideoPage === true,
          subtitles: resp.subtitles || '',
        });
      });
    });
  });
}

async function updateGlobalPresets(): Promise<void> {
  try {
    const tabs = await new Promise<chrome.tabs.Tab[]>((r) =>
      chrome.tabs.query({ active: true, currentWindow: true }, r)
    );
    if (!tabs || !tabs[0]) return;
    const url = tabs[0].url || '';

    let isVideoPage = false;
    let hasSubtitles = false;
    try {
      const ctx = await getPageContextNow();
      if (ctx) {
        isVideoPage = ctx.isVideoPage === true;
        hasSubtitles =
          !!ctx.content &&
          (ctx.content.startsWith('## 视频字幕') ||
            ctx.content.includes('[00:') ||
            ctx.content.includes('[0:'));
        console.log(
          '[KnowSeek] updateGlobalPresets: ctx received, isVideoPage=' +
            isVideoPage +
            ' hasSubtitles=' +
            hasSubtitles +
            ' content_len=' +
            (ctx.content ? ctx.content.length : 0)
        );
      } else {
        console.log('[KnowSeek] updateGlobalPresets: ctx is null (content script not ready or empty content)');
      }
    } catch (e) {
      console.warn('[KnowSeek] updateGlobalPresets: getPageContextNow error:', e);
    }

    if (!isVideoPage) {
      isVideoPage = url.includes('bilibili.com/video/') || url.includes('youtube.com/watch') || url.includes('youtu.be/');
      if (isVideoPage) console.log('[KnowSeek] updateGlobalPresets: detected video page via URL fallback');
    }

    console.log(
      '[KnowSeek] updateGlobalPresets: final decision - currentPageType=' +
        (isVideoPage ? 'video' : 'article') +
        ' hasSubtitles=' +
        hasSubtitles
    );

    currentPageType = isVideoPage ? 'video' : 'article';
    chatSubtitleHint.classList.toggle('hidden', !(isVideoPage && !hasSubtitles));

    chatGlobalPresetsBtns.innerHTML = '';
    const summaryPreset = currentPageType === 'video' ? globalPresets.summarizeVideo : globalPresets.summarizeArticle;
    const mindmapPreset = currentPageType === 'video' ? globalPresets.mindmapVideo : globalPresets.mindmapArticle;

    // 无字幕视频：强制开启 ASR，用户不可关闭
    if (currentPageType === 'video' && !hasSubtitles) {
      asrEnabled = true;
      asrForced = true;
    } else {
      asrForced = false;
    }

    const summaryBtn = document.createElement('button');
    summaryBtn.className = 'chat-global-preset-btn';
    summaryBtn.textContent = summaryPreset.label;
    summaryBtn.title = currentPageType === 'video' ? '带时间轴跳转的视频总结' : '总结当前网页内容';
    summaryBtn.addEventListener('click', () => {
      const displayText = currentPageType === 'video' ? '总结此视频' : '总结此网页';
      if (currentPageType === 'video') {
        sendVideoSummaryWithFrames();
      } else {
        // 普通网页：提取页面图片后带图发送
        handleArticleSummaryWithImages(displayText, summaryPreset.prompt);
      }
    });
    chatGlobalPresetsBtns.appendChild(summaryBtn);

    if (currentPageType === 'video' || currentPageType === 'article') {
      const mindmapBtn = document.createElement('button');
      mindmapBtn.className = 'chat-global-preset-btn';
      mindmapBtn.textContent = mindmapPreset.label;
      mindmapBtn.title = currentPageType === 'video' ? '将视频内容整理为思维导图' : '将网页内容整理为思维导图';
      mindmapBtn.addEventListener('click', () => {
        if (currentPageType === 'video') {
          sendVideoSummaryWithFrames(mindmapPreset.prompt, true);
        } else {
          sendChatMessage(mindmapPreset.prompt, '文章思维导图', true);
        }
      });
      chatGlobalPresetsBtns.appendChild(mindmapBtn);
    }

    // ASR 切换按钮（所有视频页面均显示）
    if (currentPageType === 'video') {
      const asrBtn = document.createElement('button');
      asrBtn.className = 'chat-global-preset-btn asr-toggle-btn';
      asrBtn.textContent = asrForced ? '🔊 ASR(强制)' : '🔊 ASR';
      asrBtn.title = asrForced
        ? '此视频无可用字幕，已强制开启语音识别'
        : '使用语音识别生成字幕（替代 B 站字幕）';
      const updateAsrStyle = () => {
        asrBtn.style.border = asrEnabled ? '1px solid var(--accent,#10b981)' : '';
        asrBtn.style.background = asrEnabled ? 'var(--accent-bg,rgba(16,185,129,0.1))' : '';
        asrBtn.style.color = asrEnabled ? 'var(--accent,#10b981)' : '';
        if (asrForced) {
          asrBtn.style.cursor = 'not-allowed';
          asrBtn.style.opacity = '0.8';
        }
      };
      updateAsrStyle();
      asrBtn.addEventListener('click', () => {
        if (asrForced) return; // 强制开启时禁止关闭
        asrEnabled = !asrEnabled;
        updateAsrStyle();
        if (asrEnabled) {
          const engine = localStorage.getItem('knowseek_asr_engine') || 'whisper';
          console.log(`[KnowSeek] ASR 已开启 (${engine} 引擎)`);
        } else {
          console.log('[KnowSeek] ASR 已关闭');
        }
      });
      chatGlobalPresetsBtns.appendChild(asrBtn);
    }

    chatGlobalPresets.classList.remove('hidden');
  } catch (e) {
    console.warn('[KnowSeek] updateGlobalPresets failed:', e);
    chatGlobalPresets.classList.add('hidden');
  }
}

// ── 图片处理 ──
function compressImage(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    if (file.size > MAX_IMAGE_SIZE) {
      console.warn('[KnowSeek] Image too large, skipped:', file.name);
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
      const img = new Image();
      img.onload = function () {
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
          const ratio = Math.min(MAX_DIMENSION / w, MAX_DIMENSION / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = function () {
        resolve(null);
      };
      img.src = e.target?.result as string;
    };
    reader.onerror = function () {
      resolve(null);
    };
    reader.readAsDataURL(file);
  });
}

function renderImagePreview(): void {
  chatImagePreview.innerHTML = '';
  if (pendingImages.length === 0) {
    chatImagePreview.classList.remove('active');
    return;
  }
  chatImagePreview.classList.add('active');
  pendingImages.forEach((img, idx) => {
    const item = document.createElement('div');
    item.className = 'chat-image-preview-item';
    const imgEl = document.createElement('img');
    imgEl.src = img.dataUrl;
    imgEl.alt = img.name || '';
    const rmBtn = document.createElement('button');
    rmBtn.className = 'chat-image-preview-remove';
    rmBtn.innerHTML = '×';
    rmBtn.title = '移除';
    rmBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pendingImages.splice(idx, 1);
      renderImagePreview();
    });
    item.appendChild(imgEl);
    item.appendChild(rmBtn);
    chatImagePreview.appendChild(item);
  });
}

function addPendingImage(dataUrl: string, name: string): void {
  if (pendingImages.length >= MAX_IMAGES) return;
  pendingImages.push({ dataUrl, name });
  renderImagePreview();
}

function openImageModal(src: string): void {
  const modal = document.createElement('div');
  modal.className = 'chat-image-modal';
  const img = document.createElement('img');
  img.src = src;
  modal.appendChild(img);
  modal.addEventListener('click', () => modal.remove());
  document.body.appendChild(modal);
}

// ── 帧画面评分：淘汰废片 + 清晰度×信息密度排序 ──
// 返回 { score, histogram }，histogram 用于后续去重
// 淘汰条件（一项不满足 → 0 分）：
//   - 黑帧（>80% 像素亮度 < 5）
//   - 白帧（>80% 像素亮度 > 250）
//   - 模糊帧（拉普拉斯方差 < 5）
//   - 均匀画面（90% 像素集中在 ≤30 亮度范围）
// 排序条件（仅在未淘汰帧之间）：
//   - 拉普拉斯方差 × 0.5 + 信息熵 × 0.5（归一化到 0~100）
function scoreFrameDataUrl(dataUrl: string): Promise<{ score: number; histogram: number[] }> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const W = 320, H = 240;
          const canvas = document.createElement('canvas');
          canvas.width = W;
          canvas.height = H;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) { resolve({ score: 0, histogram: [] }); return; }
          ctx.drawImage(img, 0, 0, W, H);
          const imageData = ctx.getImageData(0, 0, W, H);
          const data = imageData.data;

          // 灰度化 + 直方图 + 统计
          const gray = new Uint8Array(W * H);
          const histogram = new Array(256).fill(0);
          let darkPixels = 0, whitePixels = 0;
          let totalGray = 0;
          const totalPixels = W * H;

          for (let i = 0; i < totalPixels; i++) {
            const idx = i * 4;
            const g = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
            gray[i] = g;
            histogram[g]++;
            totalGray += g;
            if (g < 5) darkPixels++;
            if (g > 250) whitePixels++;
          }

          // ── 淘汰条件 ──
          // 纯黑/近黑帧（平均亮度 < 10 或 >50% 像素为纯黑）
          const avgGray = totalGray / totalPixels;
          if (avgGray < 10 || darkPixels / totalPixels > 0.5) {
            resolve({ score: 0, histogram });
            return;
          }
          // 纯白帧
          if (whitePixels / totalPixels > 0.8) {
            resolve({ score: 0, histogram });
            return;
          }
          // 均匀画面（90% 像素集中在 ≤ 30 亮度范围）
          let cumulative = 0;
          const threshold5 = totalPixels * 0.05;
          let lowBound = 0;
          for (let i = 0; i < 256; i++) {
            cumulative += histogram[i];
            if (cumulative >= threshold5) { lowBound = i; break; }
          }
          cumulative = 0;
          let highBound = 255;
          for (let i = 255; i >= 0; i--) {
            cumulative += histogram[i];
            if (cumulative >= threshold5) { highBound = i; break; }
          }
          if (highBound - lowBound < 30) {
            resolve({ score: 0, histogram });
            return;
          }

          // ── 拉普拉斯方差（清晰度） ──
          let lapSum = 0, lapSumSq = 0, lapCount = 0;
          for (let y = 1; y < H - 1; y++) {
            for (let x = 1; x < W - 1; x++) {
              const idx = y * W + x;
              const val = 4 * gray[idx] - gray[idx - W] - gray[idx + W] - gray[idx - 1] - gray[idx + 1];
              lapSum += val;
              lapSumSq += val * val;
              lapCount++;
            }
          }
          const lapMean = lapSum / lapCount;
          const lapVar = lapSumSq / lapCount - lapMean * lapMean;

          // 模糊帧 → 淘汰
          if (lapVar < 5) {
            resolve({ score: 0, histogram });
            return;
          }

          // ── 信息熵 ──
          let entropy = 0;
          for (let i = 0; i < 256; i++) {
            if (histogram[i] > 0) {
              const p = histogram[i] / totalPixels;
              entropy -= p * Math.log2(p);
            }
          }

          // ── Sobel 边缘密度（衡量内容丰富度） ──
          let edgeCount = 0;
          for (let y = 1; y < H - 1; y++) {
            for (let x = 1; x < W - 1; x++) {
              const idx = y * W + x;
              const gx = -gray[idx - W - 1] + gray[idx - W + 1]
                       - 2 * gray[idx - 1] + 2 * gray[idx + 1]
                       - gray[idx + W - 1] + gray[idx + W + 1];
              const gy = -gray[idx - W - 1] - 2 * gray[idx - W] - gray[idx - W + 1]
                       + gray[idx + W - 1] + 2 * gray[idx + W] + gray[idx + W + 1];
              const mag = Math.sqrt(gx * gx + gy * gy);
              if (mag > 30) edgeCount++;
            }
          }
          const edgeDensity = edgeCount / ((W - 2) * (H - 2));

          // ── 综合评分（归一化 0~100） ──
          const lapScore = Math.min(lapVar / 50, 100);     // 方差 50 ≈ 清晰画面
          const entScore = (entropy / 8) * 100;            // 熵 0~8 → 0~100
          const edgeScore = Math.min(edgeDensity / 0.15, 100) * 100; // 边缘占比 15% ≈ 内容丰富
          const score = lapScore * 0.3 + entScore * 0.3 + edgeScore * 0.4;

          resolve({ score, histogram });
        } catch { resolve({ score: 0, histogram: [] }); }
      };
      img.onerror = () => resolve({ score: 0, histogram: [] });
      img.src = dataUrl;
    } catch { resolve({ score: 0, histogram: [] }); }
  });
}

/** 直方图交集相似度（0~1），用于去重 */
function histogramSimilarity(h1: number[], h2: number[]): number {
  if (!h1.length || !h2.length) return 0;
  let intersection = 0;
  const total = 320 * 240;
  for (let i = 0; i < 256; i++) {
    intersection += Math.min(h1[i], h2[i]);
  }
  return intersection / total;
}

// ── 帧差分分析：计算两帧之间的差异分数（MSE + 直方图）─
async function computeFrameDiff(dataUrl1: string, dataUrl2: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      const img1 = new Image();
      const img2 = new Image();
      let loaded = 0;
      const onLoad = () => {
        loaded++;
        if (loaded < 2) return;
        const W = 160, H = 120;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) { resolve(0); return; }
        // 第一帧灰度化
        ctx.drawImage(img1, 0, 0, W, H);
        const data1 = ctx.getImageData(0, 0, W, H).data;
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(img2, 0, 0, W, H);
        const data2 = ctx.getImageData(0, 0, W, H).data;
        const totalPixels = W * H;
        // MSE
        let mse = 0;
        for (let i = 0; i < totalPixels; i++) {
          const idx = i * 4;
          const g1 = 0.299 * data1[idx] + 0.587 * data1[idx + 1] + 0.114 * data1[idx + 2];
          const g2 = 0.299 * data2[idx] + 0.587 * data2[idx + 1] + 0.114 * data2[idx + 2];
          mse += (g1 - g2) * (g1 - g2);
        }
        mse /= totalPixels;
        const normalizedMse = Math.min(mse / 10000, 1);
        // 直方图差异
        const hist1 = new Array(256).fill(0);
        const hist2 = new Array(256).fill(0);
        for (let i = 0; i < totalPixels; i++) {
          const idx = i * 4;
          const g1 = Math.round(0.299 * data1[idx] + 0.587 * data1[idx + 1] + 0.114 * data1[idx + 2]);
          const g2 = Math.round(0.299 * data2[idx] + 0.587 * data2[idx + 1] + 0.114 * data2[idx + 2]);
          hist1[g1]++;
          hist2[g2]++;
        }
        let histDiff = 0;
        for (let i = 0; i < 256; i++) {
          histDiff += Math.abs(hist1[i] - hist2[i]) / totalPixels;
        }
        histDiff = Math.min(histDiff / 2, 1);
        resolve(normalizedMse * 0.5 + histDiff * 0.5);
      };
      img1.onload = img2.onload = onLoad;
      img1.onerror = () => resolve(0);
      img2.onerror = () => resolve(0);
      img1.src = dataUrl1;
      img2.src = dataUrl2;
    } catch { resolve(0); }
  });
}

// ── 稠密采样：在时间窗口内按固定间隔采样评分，取最优帧 ─
async function denseSampleBestFrame(
  startSec: number,
  endSec: number,
  tabId: number,
  videoRect?: { x: number; y: number; width: number; height: number; innerWidth: number; innerHeight: number; devicePixelRatio: number },
  sampleInterval: number = 1,
  cache?: Map<number, { seconds: number; score: number }>
): Promise<{ seconds: number; score: number } | null> {
  let best: { seconds: number; score: number } | null = null;
  for (let t = startSec; t <= endSec; t += sampleInterval) {
    // 检查缓存（±0.5s 内已有帧则复用）
    let scored: { seconds: number; score: number } | null = null;
    if (cache) {
      const cachedKey = Math.round(t);
      const cached = cache.get(cachedKey);
      if (cached && Math.abs(cached.seconds - t) <= 0.5) {
        scored = cached;
      }
    }
    if (!scored) {
      const frame = await captureSingleFrame(t, tabId, videoRect);
      if (frame) {
        scored = { seconds: frame.seconds, score: frame.score };
        cache?.set(Math.round(frame.seconds), scored);
      }
    }
    if (scored && (!best || scored.score > best.score)) {
      best = scored;
    }
  }
  return best;
}

// ── 段落内程序化找最佳截帧位置（自适应粗扫 + 帧差分 + 稠密采样）──
async function findBestFramesInSegment(
  start: number,
  end: number,
  tabId: number,
  videoRect?: { x: number; y: number; width: number; height: number; innerWidth: number; innerHeight: number; devicePixelRatio: number },
  usingPageVideo: boolean = false,
  maxFrames: number = 3
): Promise<Array<{ seconds: number; dataUrl: string; score: number }>> {
  if (usingPageVideo) {
    // 页面视频回退模式：节俭采样，每 5s 一帧
    const interval = Math.max(5, Math.ceil((end - start) / 10));
    const samples: Array<{ seconds: number; dataUrl: string; score: number }> = [];
    for (let t = start; t <= end && samples.length < 8; t += interval) {
      const frame = await captureSingleFrame(t, tabId, videoRect);
      if (frame && frame.dataUrl) {
        samples.push({ seconds: frame.seconds, dataUrl: frame.dataUrl, score: frame.score });
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    samples.sort((a, b) => b.score - a.score);
    return samples.slice(0, maxFrames);
  }
  // ★ 隐藏视频模式（推荐）：自适应粗扫 + 帧差分 + 稠密采样
  const segDuration = end - start;
  const coarseInterval = segDuration > 60 ? 5 : 3; // 长段 5s，短段 3s
  const coarseFrames: Array<{ seconds: number; dataUrl: string; score: number; histogram: number[] }> = [];
  // 同时构建采样缓存，供稠密采样复用
  const sampleCache = new Map<number, { seconds: number; score: number }>();
  for (let t = start; t <= end; t += coarseInterval) {
    const frame = await captureSingleFrame(t, tabId, videoRect);
    if (frame) {
      coarseFrames.push(frame);
      sampleCache.set(Math.round(frame.seconds), { seconds: frame.seconds, score: frame.score });
    }
  }
  if (coarseFrames.length === 0) return [];
  // 帧差分分析
  const diffs: Array<{ index: number; value: number; timeStart: number; timeEnd: number }> = [];
  for (let i = 0; i < coarseFrames.length - 1; i++) {
    const diffValue = await computeFrameDiff(coarseFrames[i].dataUrl, coarseFrames[i + 1].dataUrl);
    diffs.push({ index: i, value: diffValue, timeStart: coarseFrames[i].seconds, timeEnd: coarseFrames[i + 1].seconds });
  }
  // 选 top 高差异区域（最多 maxFrames 个即可，因为每区域只出 1 帧）
  diffs.sort((a, b) => b.value - a.value);
  const highDiffRegions = diffs.filter((d) => d.value > 0.12).slice(0, maxFrames);
  // 对每个高差异区域稠密采样（1s 间隔，复用缓存）
  const candidates: Array<{ seconds: number; dataUrl: string; score: number }> = [];
  const visited = new Set<number>();
  for (const region of highDiffRegions) {
    const best = await denseSampleBestFrame(region.timeStart, region.timeEnd, tabId, videoRect, 1, sampleCache);
    if (best && !visited.has(Math.round(best.seconds))) {
      visited.add(Math.round(best.seconds));
      // 检查缓存中是否有 dataUrl（粗扫帧）
      const cachedCoarse = coarseFrames.find((f) => Math.abs(f.seconds - best.seconds) <= 0.5);
      if (cachedCoarse) {
        candidates.push({ seconds: cachedCoarse.seconds, dataUrl: cachedCoarse.dataUrl, score: cachedCoarse.score });
      } else {
        const frame = await captureSingleFrame(best.seconds, tabId, videoRect);
        if (frame) candidates.push({ seconds: frame.seconds, dataUrl: frame.dataUrl, score: frame.score });
      }
    }
  }
  // 从粗扫帧补充高分帧（如果候选不足）
  if (candidates.length < maxFrames) {
    const sortedCoarse = [...coarseFrames].sort((a, b) => b.score - a.score);
    for (const cf of sortedCoarse) {
      if (candidates.length >= maxFrames) break;
      if (!candidates.some((c) => Math.abs(c.seconds - cf.seconds) < 2)) {
        candidates.push({ seconds: cf.seconds, dataUrl: cf.dataUrl, score: cf.score });
      }
    }
  }
  // 评分排序 + 直方图去重
  candidates.sort((a, b) => b.score - a.score);
  const deduped: Array<{ seconds: number; dataUrl: string; score: number }> = [];
  for (const c of candidates) {
    if (deduped.length >= maxFrames) break;
    const cFull = coarseFrames.find((f) => f.seconds === c.seconds);
    if (!cFull) { deduped.push(c); continue; }
    const tooSimilar = deduped.some((d) => {
      const dFull = coarseFrames.find((f) => f.seconds === d.seconds);
      return dFull && histogramSimilarity(cFull.histogram, dFull.histogram) > 0.98;
    });
    if (!tooSimilar) deduped.push(c);
  }
  return deduped;
}

/** 裁剪 dataUrl 图片，返回指定区域的新 dataUrl */
async function cropImageDataUrl(dataUrl: string, x: number, y: number, w: number, h: number, viewportW: number, viewportH: number, dpr: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          // captureVisibleTab 以设备像素分辨率截取，缩放至 CSS 像素
          const scaleX = img.naturalWidth / (viewportW * dpr);
          const scaleY = img.naturalHeight / (viewportH * dpr);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(w * scaleX * dpr);
          canvas.height = Math.round(h * scaleY * dpr);
          const ctx = canvas.getContext('2d');
          if (!ctx) { resolve(null); return; }
          ctx.drawImage(img, Math.round(x * scaleX * dpr), Math.round(y * scaleY * dpr), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.3));
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    } catch { resolve(null); }
  });
}

/** 在聊天气泡中替换 [IMAGE:N] 标记为实际图片，返回替换数量 */
function renderImageMarkers(container: HTMLElement, images: string[]): number {
  if (!images || images.length === 0) return 0;
  // 构建反向映射：dataUrl → timestamp（用于视频帧跳转）
  const urlToTimestamp = new Map<string, number>();
  _preCapturedVideoFrames.forEach((dataUrl, timestamp) => {
    urlToTimestamp.set(dataUrl, timestamp);
  });
  const regex = /\[IMAGE:(\d+)\]/g;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
  const nodesToReplace: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest('a, button, pre, code')) continue;
    if (regex.test(node.textContent || '')) {
      nodesToReplace.push(node);
    }
    regex.lastIndex = 0;
  }
  let replacedCount = 0;
  for (const textNode of nodesToReplace) {
    const text = textNode.textContent || '';
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const idx = parseInt(match[1], 10);
      if (idx >= 0 && idx < images.length) {
        const img = document.createElement('img');
        img.src = images[idx];
        img.className = 'chat-msg-image';
        img.alt = '配图';
        img.loading = 'lazy';
        const ts = urlToTimestamp.get(images[idx]);
        img.addEventListener('click', () => {
          if (ts !== undefined) {
            chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
              if (tabs[0]?.id) {
                chrome.tabs.sendMessage(tabs[0].id, { action: 'seekToVideoTimestamp', timestamp: ts }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
              }
            });
          }
          openImageModal(images[idx]);
        });
        fragment.appendChild(img);
        replacedCount++;
      } else {
        fragment.appendChild(document.createTextNode(match[0]));
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    textNode.parentNode?.replaceChild(fragment, textNode);
  }
  return replacedCount;
}

/** 在聊天气泡中为每个段落自动插入对应的最佳视频帧
 *  先尝试在 <h2> 后插入，若无则用 <p> 定位，再不行就全部放在开头 */
function renderVideoFramesPerParagraph(container: HTMLElement): void {
  if (_segmentBestFrames.length === 0) return;
  // 构建 dataUrl → timestamp 映射（用于点击跳转）
  const urlToTimestamp = new Map<string, number>();
  _preCapturedVideoFrames.forEach((dataUrl, timestamp) => {
    urlToTimestamp.set(dataUrl, timestamp);
  });

  function createImageEl(frame: typeof _segmentBestFrames[0], label: string): HTMLImageElement {
    const img = document.createElement('img');
    img.src = frame.dataUrl;
    img.className = 'chat-msg-image';
    img.alt = label;
    img.loading = 'lazy';
    const ts = urlToTimestamp.get(frame.dataUrl);
    img.addEventListener('click', () => {
      if (ts !== undefined) {
        chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
          if (tabs[0]?.id) {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'seekToVideoTimestamp', timestamp: ts }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
          }
        });
      }
      openImageModal(frame.dataUrl);
    });
    return img;
  }

  // 策略1：在 <h2> 后插入
  const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
  let segIdx = 0;
  for (const h of headings) {
    if (segIdx >= _segmentBestFrames.length) break;
    const frame = _segmentBestFrames[segIdx];
    if (!frame.dataUrl) { segIdx++; continue; }
    const img = createImageEl(frame, `段落 ${segIdx + 1}`);
    if (h.nextSibling) {
      h.parentNode?.insertBefore(img, h.nextSibling);
    } else {
      h.parentNode?.appendChild(img);
    }
    segIdx++;
  }

  // 如果标题不够用，用 <p> 补足
  if (segIdx < _segmentBestFrames.length) {
    const paragraphs = container.querySelectorAll('p');
    let pIdx = 0;
    while (segIdx < _segmentBestFrames.length && pIdx < paragraphs.length) {
      const frame = _segmentBestFrames[segIdx];
      if (!frame.dataUrl) { segIdx++; continue; }
      const img = createImageEl(frame, `段落 ${segIdx + 1}`);
      paragraphs[pIdx].parentNode?.insertBefore(img, paragraphs[pIdx].nextSibling);
      segIdx++;
      pIdx++;
    }
  }

  // 最后还有剩余，全部追加到末尾
  while (segIdx < _segmentBestFrames.length) {
    const frame = _segmentBestFrames[segIdx];
    if (frame.dataUrl) {
      container.appendChild(createImageEl(frame, `段落 ${segIdx + 1}`));
    }
    segIdx++;
  }
}

/** 处理「总结此网页」：提取页面图片后带图发送 */
async function handleArticleSummaryWithImages(displayText: string, prompt: string): Promise<void> {
  // 检查模型是否支持图片
  const activeModel = getActiveModel();
  if (!activeModel || !(await isVisionModel(activeModel.model))) {
    await sendChatMessage(prompt, displayText);
    return;
  }
  let extraImages: string[] = [];
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      const resp = await new Promise<any>(r => chrome.tabs.sendMessage(tabs[0].id, { action: 'getPageImages' }, (response) => {
        if (chrome.runtime.lastError) { r(null); return; }
        r(response);
      }));
      if (resp?.images?.length) {
        extraImages = resp.images.map((i: { base64: string; alt: string }) => i.base64);
        // prompt 已包含 [IMAGE:N] 说明，无需重复
        await sendChatMessage(prompt, displayText, false, extraImages);
        return;
      }
    }
  } catch {}
  // 无图片时正常发送
  await sendChatMessage(prompt, displayText);
}

/** 在指定时间点截取一帧视频画面
 *  优先使用 content script Canvas 截帧，失败时回退到 captureVisibleTab */
let _useFallbackCapture = false;
let _seekBudget = 500; // 页面视频回退时的 seek 预算（增大以支持完整截帧）
let _usingPageVideo = false; // 是否在使用页面视频截帧（blob URL 回退）

// 视频总结段落→最佳帧映射，供自动插入图片渲染
let _segmentBestFrames: Array<{ seconds: number; dataUrl: string; timeStr: string }> = [];

async function captureSingleFrame(
  seconds: number,
  tabId: number,
  videoRect?: { x: number; y: number; width: number; height: number; innerWidth: number; innerHeight: number; devicePixelRatio: number }
): Promise<{ dataUrl: string; seconds: number; score: number; histogram: number[] } | null> {
  try {
    // 页面视频模式：先检查预算
    if (_usingPageVideo && _seekBudget <= 0) return null;

    let dataUrl: string | null = null;

    if (!_useFallbackCapture) {
      // 方案 A：通过 content script Canvas 截取纯视频帧
      const resp = await new Promise<any>(r => chrome.tabs.sendMessage(tabId, { action: 'captureFrame', timestamp: seconds }, (response) => {
        if (chrome.runtime.lastError) { r(null); return; }
        r(response);
      }));
      if (resp && resp.dataUrl) {
        dataUrl = resp.dataUrl;
        // 检测是否在使用页面视频回退
        if (resp.isOffscreen === false) _usingPageVideo = true;
        if (resp.isOffscreen === true) _usingPageVideo = false;
        // 页面视频模式消耗预算
        if (_usingPageVideo) _seekBudget--;
      } else if (resp?.error === 'canvas') {
        // Canvas CORS 受限，后续全部回退到 captureVisibleTab
        console.log('[KnowSeek] Canvas capture failed (CORS), falling back to captureVisibleTab');
        _useFallbackCapture = true;
      }
      // timeout 或 null → 等下一轮重试 fallback
    }

    // 方案 B：回退 — captureVisibleTab + 裁剪
    if (!dataUrl && videoRect) {
      if (_usingPageVideo) _seekBudget--;
      // 等待视频帧渲染到屏幕上
      await new Promise((r) => setTimeout(r, 500));
      const fullDataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 50 });
      if (fullDataUrl) {
        dataUrl = await cropImageDataUrl(fullDataUrl, videoRect.x, videoRect.y, videoRect.width, videoRect.height, videoRect.innerWidth, videoRect.innerHeight, videoRect.devicePixelRatio);
        if (!dataUrl) dataUrl = fullDataUrl;
      }
    }

    if (!dataUrl) return null;
    const result = await scoreFrameDataUrl(dataUrl);
    return { dataUrl, seconds, score: result.score, histogram: result.histogram };
  } catch { return null; }
}

/** 构建帧画廊交错 HTML：按时间戳匹配帧到段落 */
function buildFrameGalleryHtml(content: string, fullFrameUrls: string[]): string {
  // 解析帧时间戳（从文件名中提取）
  const frameTs = fullFrameUrls.map((url) => {
    const m = url.match(/_(\d+\.\d+)s\.jpg/);
    return m ? parseFloat(m[1]) : null;
  });

  // 解析 AI 回复段落（按 [MM:SS] 分割）
  interface Seg {
    timestamp: string;
    seconds: number;
    text: string;
  }
  const segments: Seg[] = [];
  const lines = content.split('\n');
  let current: Seg | null = null;

  for (const line of lines) {
    const m = line.match(/^\s*\[(\d{1,2}:\d{2})\]/);
    if (m) {
      if (current) segments.push(current);
      const [min, sec] = m[1].split(':').map(Number);
      current = { timestamp: m[1], seconds: min * 60 + sec, text: line };
    } else if (current) {
      current.text += '\n' + line;
    } else {
      if (!current) {
        current = { timestamp: '', seconds: -1, text: line };
      } else {
        current.text += '\n' + line;
      }
    }
  }
  if (current) segments.push(current);

  // 按时间范围匹配帧到段落
  const framesBySegment: string[][] = segments.map(() => []);
  for (let si = 0; si < segments.length; si++) {
    if (segments[si].seconds < 0) continue;
    const segStart = segments[si].seconds;
    const segEnd = si < segments.length - 1 && segments[si + 1].seconds >= 0
      ? segments[si + 1].seconds
      : Infinity;

    for (let fi = 0; fi < fullFrameUrls.length; fi++) {
      const ts = frameTs[fi];
      if (ts === null) continue;
      if (ts >= segStart && ts < segEnd) {
        framesBySegment[si].push(fullFrameUrls[fi]);
      }
    }
  }

  // 构建交错 HTML
  let html = '<style>.vf-gallery{display:flex;flex-wrap:nowrap;overflow-x:auto;gap:6px;margin:8px 0;padding-bottom:4px;scroll-behavior:smooth;}.vf-gallery::-webkit-scrollbar{height:4px;}.vf-gallery::-webkit-scrollbar-thumb{background:rgba(128,128,128,0.5);border-radius:2px;}.vf-thumb{cursor:pointer;width:120px;height:67px;object-fit:cover;border-radius:4px;flex-shrink:0;}.vf-lightbox{position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.85);z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;}.vf-lightbox img{max-width:90vw;max-height:80vh;object-fit:contain;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6);}.vf-lb-arrow{position:fixed;top:50%;transform:translateY(-50%);font-size:48px;color:#fff;cursor:pointer;padding:20px;user-select:none;z-index:100000;text-shadow:0 2px 8px rgba(0,0,0,0.5);}.vf-lb-arrow:hover{color:#007aff;}.vf-lb-left{left:16px;}.vf-lb-right{right:16px;}.vf-lb-bar{display:flex;align-items:center;gap:16px;margin-top:16px;color:#ccc;font-size:14px;}.vf-lightbox-btn{padding:8px 24px;border:none;border-radius:6px;background:#007aff;color:#fff;font-size:14px;cursor:pointer;}.vf-lightbox-btn:hover{opacity:.8;}.vf-segment p{text-indent:2em;}.vf-segment p:first-child,.vf-segment h2{text-indent:0;}</style>';

  // 前导内容（无时间戳的段落先渲染）
  let segIdx = 0;
  if (segments.length > 0 && segments[0].seconds < 0) {
    html += renderMarkdown(segments[0].text.replace(/^[^\S\n]+/gm, ''));
    segIdx = 1;
  }

  // 逐段渲染：段落 → 匹配的帧
  for (; segIdx < segments.length; segIdx++) {
    html += `<div class="vf-segment">`;
    html += renderMarkdown(segments[segIdx].text.replace(/^[^\S\n]+/gm, ''));

    const segFrames = framesBySegment[segIdx];
    if (segFrames.length > 0) {
      const galleryHtml = segFrames.map((url) =>
        `<img src="${url}" class="vf-thumb" loading="lazy">`
      ).join('');
      html += `<div class="vf-gallery">${galleryHtml}</div>`;
    }
  }

  // 无时间戳的帧放在末尾
  const unmatchedFrames = fullFrameUrls.filter((_, fi) => frameTs[fi] === null);
  if (unmatchedFrames.length > 0) {
    const galleryHtml = unmatchedFrames.map((url) =>
      `<img src="${url}" class="vf-thumb" loading="lazy">`
    ).join('');
    html += `<div class="vf-gallery" style="margin:12px 0;padding-top:12px;border-top:1px solid var(--border-color,#333);">${galleryHtml}</div>`;
  }

  return html;
}

/** 为帧画廊添加水平滚轮 + 点击放大（lightbox）事件 */
function attachGalleryHandlers(container: HTMLElement, pageUrl?: string): void {
  if (pageUrl) container.dataset.pageUrl = pageUrl;
  container.querySelectorAll('.vf-gallery').forEach(gallery => {
    gallery.addEventListener('wheel', (e) => {
      e.preventDefault();
      gallery.scrollLeft += e.deltaY;
    }, { passive: false });
  });
  container.querySelectorAll('.vf-gallery').forEach(gallery => {
    const thumbs = Array.from(gallery.querySelectorAll('.vf-thumb'));
    thumbs.forEach(img => {
      img.addEventListener('click', function() {
        const existing = document.querySelector('.vf-lightbox');
        if (existing) { existing.remove(); return; }

        const idx = thumbs.indexOf(this);

        function openLightbox(index: number) {
          const existingLb = document.querySelector('.vf-lightbox');
          if (existingLb) existingLb.remove();

          const currentImg = thumbs[index];
          const src = (currentImg as HTMLImageElement).src;
          const tsMatch = src.match(/_(\d+\.\d+)s\.jpg/);
          const seconds = tsMatch ? parseFloat(tsMatch[1]) : null;

          const lightbox = document.createElement('div');
          lightbox.className = 'vf-lightbox';

          if (thumbs.length > 1) {
            const leftArrow = document.createElement('div');
            leftArrow.className = 'vf-lb-arrow vf-lb-left';
            leftArrow.textContent = '❮';
            leftArrow.addEventListener('click', (e) => {
              e.stopPropagation();
              const prev = (index - 1 + thumbs.length) % thumbs.length;
              openLightbox(prev);
            });
            lightbox.appendChild(leftArrow);
          }

          const bigImg = document.createElement('img');
          bigImg.src = src;
          bigImg.alt = '';
          lightbox.appendChild(bigImg);

          if (thumbs.length > 1) {
            const rightArrow = document.createElement('div');
            rightArrow.className = 'vf-lb-arrow vf-lb-right';
            rightArrow.textContent = '❯';
            rightArrow.addEventListener('click', (e) => {
              e.stopPropagation();
              const next = (index + 1) % thumbs.length;
              openLightbox(next);
            });
            lightbox.appendChild(rightArrow);
          }

          const bottomBar = document.createElement('div');
          bottomBar.className = 'vf-lb-bar';

          if (thumbs.length > 1) {
            const pageInfo = document.createElement('span');
            pageInfo.textContent = `${index + 1} / ${thumbs.length}`;
            bottomBar.appendChild(pageInfo);
          }

          if (seconds !== null) {
            const m = Math.floor(seconds / 60);
            const s = Math.floor(seconds % 60);
            const timeStr = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            const btn = document.createElement('button');
            btn.className = 'vf-lightbox-btn';
            btn.textContent = `⏱ 跳转到 ${timeStr}`;
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              lightbox.remove();
              seekVideoTo(seconds, container.dataset.pageUrl);
            });
            bottomBar.appendChild(btn);
          }

          lightbox.appendChild(bottomBar);

          const keyHandler = (ke: KeyboardEvent) => {
            if (ke.key === 'ArrowLeft') {
              ke.preventDefault();
              const prev = (index - 1 + thumbs.length) % thumbs.length;
              openLightbox(prev);
            } else if (ke.key === 'ArrowRight') {
              ke.preventDefault();
              const next = (index + 1) % thumbs.length;
              openLightbox(next);
            } else if (ke.key === 'Escape') {
              lightbox.remove();
            }
          };
          document.addEventListener('keydown', keyHandler);

          lightbox.addEventListener('click', () => {
            lightbox.remove();
            document.removeEventListener('keydown', keyHandler);
          });

          document.body.appendChild(lightbox);
        }

        openLightbox(idx);
      });
    });
  });
}

/** 视频总结：后端 yt-dlp 下载 + ffmpeg 场景检测截帧 + AI 一轮总结（SSE 流式） */
async function sendVideoSummaryWithFrames(customPrompt?: string, isMindmap = false): Promise<void> {
  const session = activeSessionId ? chatSessions[activeSessionId] : null;
  const ctx = session?.pageContext;

  // 无视频上下文时回退到纯文本消息
  if (!ctx || !ctx.url) {
    const fallbackPrompt = isMindmap ? globalPresets.mindmapVideo.prompt : globalPresets.summarizeVideo.prompt;
    const fallbackDisplay = isMindmap ? '视频思维导图' : '总结此视频';
    sendChatMessage(fallbackPrompt, fallbackDisplay, isMindmap);
    return;
  }

  // 无字幕且未启用 ASR 时无法继续
  if (!ctx.subtitles && !asrEnabled) {
    const fallbackPrompt = isMindmap ? globalPresets.mindmapVideo.prompt : globalPresets.summarizeVideo.prompt;
    const fallbackDisplay = isMindmap ? '视频思维导图' : '总结此视频';
    sendChatMessage(fallbackPrompt, fallbackDisplay, isMindmap);
    return;
  }

  // 检查模型是否支持图片，决定是否发送帧画面
  const activeModel = getActiveModel();
  const isVision = activeModel && await isVisionModel(activeModel.model);
  const skipFrames = !isVision;

  // 获取后端配置
  const config = await chrome.storage.local.get(['backend_url', 'backend_key']);
  if (!config.backend_url) {
    if (!activeSessionId || !chatSessions[activeSessionId]) createSession();
    const sess = chatSessions[activeSessionId!];
    sess.messages.push({ role: 'assistant', content: '请先配置并连接后端服务' });
    addMessageBubble('assistant', '请先配置并连接后端服务');
    saveSessions();
    return;
  }
  const baseUrl = (config.backend_url as string).replace(/\/+$/, '');

  // 确保有活跃 session
  if (!activeSessionId || !chatSessions[activeSessionId]) createSession();
  const sess = chatSessions[activeSessionId!];

  // 添加用户消息
  const displayText = isMindmap ? '视频思维导图' : (customPrompt ? '总结此视频' : '总结此视频');
  sess.messages.push({
    role: 'user',
    content: displayText,
    display: displayText,
  });
  addMessageBubble('user', displayText, true, { text: displayText });
  addThinkingBubble();

  try {
    const abortController = new AbortController();
    const response = await fetch(baseUrl + '/api/video/summarize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.backend_key || ''}`,
      },
      signal: abortController.signal,
      body: JSON.stringify({
        url: ctx.url,
        title: ctx.title || '',
        subtitles: ctx.subtitles || '',
        model: activeModel?.model || '',
        use_asr: asrEnabled,
        asr_engine: localStorage.getItem('knowseek_asr_engine') || 'whisper',
        asr_local_model: localStorage.getItem('knowseek_asr_model') || 'tiny',
         asr_model: localStorage.getItem('knowseek_asr_model') || 'FunAudioLLM/SenseVoiceSmall',
        asr_api_key: localStorage.getItem('knowseek_asr_api_key') || '',
        custom_prompt: isMindmap ? (customPrompt || globalPresets.mindmapVideo.prompt) : '',
        skip_frames: skipFrames,
      }),
    });

    removeThinkingBubble();

    if (!response.ok) {
      let errMsg = '⚠️ 视频总结请求失败 (' + response.status + ')';
      try {
        const errData = await response.json().catch(() => ({}));
        if (errData.detail) errMsg = '⚠️ ' + errData.detail;
      } catch (e) {}
      sess.messages.push({ role: 'assistant', content: errMsg });
      addMessageBubble('assistant', errMsg);
      saveSessions();
      return;
    }

    const bubbleEl = addMessageBubble('assistant', '');
    const contentEl = bubbleEl.querySelector('.chat-msg-bubble') as HTMLDivElement;
    let fullReply = '';
    let frameUrls: string[] = [];
    let hasProgress = false;

    // 立即在会话中占位，关闭侧边栏再打开时至少能看到进度状态
    const msgIndex = sess.messages.length;
    sess.messages.push({ role: 'assistant', content: '⏳ 正在准备总结...' });
    saveSessions();
    // 同时保存到 session 存储（更快速地持久化，页面关闭后仍保留）
    chrome.storage.session.set({
      [`video_summary_${activeSessionId}`]: {
        progress: '正在准备总结...',
        timestamp: Date.now()
      }
    }).catch(() => {});
    

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') break;
        try {
          const parsed = JSON.parse(dataStr);
          const type = parsed.type;

          if (type === 'progress') {
            // 显示进度信息
            hasProgress = true;
            contentEl.innerHTML = `<div style="padding:8px 0;color:var(--text-muted,#999);font-size:13px;">⏳ ${parsed.message}</div>`;
            // 实时保存进度到会话，关闭侧边栏再打开时能看到进度
            if (sess.messages[msgIndex]) {
              sess.messages[msgIndex].content = `⏳ ${parsed.message}`;
              saveSessions();
            }
            // 同时保存到 session 存储（页面关闭后仍保留）
            chrome.storage.session.set({
              [`video_summary_${activeSessionId}`]: {
                progress: parsed.message,
                timestamp: Date.now()
              }
            }).catch(() => {});
          } else if (type === 'frames') {
            // 存储帧 URL
            frameUrls = parsed.urls || [];
          } else if (type === 'chunk') {
            // 流式渲染 AI 回复
            if (hasProgress) {
              contentEl.innerHTML = '';
              hasProgress = false;
            }
            fullReply += parsed.chunk;
            if (!isMindmap) {
              contentEl.innerHTML = renderMarkdown(fullReply);
            }
            // 实时保存部分回复，关闭侧边栏再打开不会丢失
            if (sess.messages[msgIndex]) {
              sess.messages[msgIndex].content = fullReply;
              saveSessions();
            }
            // 更新 session 存储中的进度
            chrome.storage.session.set({
              [`video_summary_${activeSessionId}`]: {
                progress: 'AI 回复中...',
                content: fullReply.slice(-200),
                timestamp: Date.now()
              }
            }).catch(() => {});
            const msgContainer = document.getElementById('chatMessages');
            if (msgContainer) msgContainer.scrollTop = msgContainer.scrollHeight;
          } else if (type === 'frames_data') {
            // 更新最终帧 URL
            frameUrls = parsed.urls || frameUrls;
          } else if (type === 'error') {
            fullReply = `⚠️ ${parsed.message}`;
            contentEl.innerHTML = fullReply;
            // 清除 session 存储中的进度标记
            chrome.storage.session.remove(`video_summary_${activeSessionId}`).catch(() => {});
            break;
          } else if (type === 'done') {
            break;
          }
        } catch (e) {
          // ignore parse errors
        }
      }
    }

    // 总结完成，清除 session 存储中的进度标记
    chrome.storage.session.remove(`video_summary_${activeSessionId}`).catch(() => {});

    fullReply = fullReply.trim();
    if (!fullReply) {
      fullReply = '⚠️ AI 返回为空';
      contentEl.innerHTML = fullReply;
    }

    // 保存消息（更新占位消息，避免重复 push）
    if (isMindmap) {
      // 思维导图模式
      sess.messages[msgIndex] = { role: 'assistant', content: fullReply, isMindmap: true };
      renderMindmapResultPanel(contentEl, fullReply);
    } else if (frameUrls.length > 0) {
      // 普通总结 + 有帧：构建交错内容
      const origin = baseUrl.replace(/\/api$/, '').replace(/\/+$/, '');
      const fullFrameUrls = frameUrls.map((p) => {
        if (p.startsWith('http://') || p.startsWith('https://')) return p;
        return origin + '/' + p.replace(/^\//, '');
      });

      // 保存消息（含完整帧URL和视频页面URL）
      sess.messages[msgIndex] = { role: 'assistant', content: fullReply, images: fullFrameUrls, pageUrl: ctx?.url };

      // 使用函数式构建交错内容，以便 reload 时复用同一套解析逻辑
      const galleryHtml = buildFrameGalleryHtml(fullReply, fullFrameUrls);
      contentEl.innerHTML = galleryHtml;

      if (ctx?.url) contentEl.dataset.pageUrl = ctx.url;
      attachGalleryHandlers(contentEl);
    } else {
      // 普通总结 + 无帧
      sess.messages[msgIndex] = { role: 'assistant', content: fullReply };
      contentEl.innerHTML = renderMarkdown(fullReply);
    }
    if (!isMindmap) processTimestamps(contentEl);

    // 滚动到底部
    const msgContainer = document.getElementById('chatMessages');
    if (msgContainer) msgContainer.scrollTop = msgContainer.scrollHeight;

    saveSessions();
  } catch (e) {
    removeThinkingBubble();
    // 如果用户主动取消总结，不触发 fallback
    if ((e as Error)?.name === 'AbortError') {
      console.log('[KnowSeek] 用户取消了视频总结');
      return;
    }
    console.error('[KnowSeek] sendVideoSummaryWithFrames error:', e);
    const fallbackPrompt = isMindmap ? globalPresets.mindmapVideo.prompt : globalPresets.summarizeVideo.prompt;
    const fallbackDisplay = isMindmap ? '视频思维导图' : '总结此视频';
    sendChatMessage(fallbackPrompt, fallbackDisplay, isMindmap);
  }
}

// ── 发送消息 ──
async function sendChatMessage(overrideText?: string, displayText?: string, isMindmap = false, extraImages?: string[]): Promise<void> {
  let text = overrideText || chatInput.value.trim();
  if (!text && !_pendingText) return;

  if (!overrideText && _pendingText) {
    text = _pendingText + '\n\n' + text;
    clearPending();
  }

  chatInput.value = '';
  chatInput.style.height = 'auto';

  if (!activeSessionId || !chatSessions[activeSessionId]) createSession();

  const session = chatSessions[activeSessionId!];
  const pendingUrls = pendingImages.length > 0 ? pendingImages.map((i) => i.dataUrl) : null;
  const allImages = pendingUrls && extraImages ? [...pendingUrls, ...extraImages] : (pendingUrls || extraImages || undefined);

  if (session.pageContext && session.pageContext.content) {
    try {
      const tabs = await new Promise<chrome.tabs.Tab[]>((r) =>
        chrome.tabs.query({ active: true, currentWindow: true }, r)
      );
      if (tabs && tabs[0] && tabs[0].url && tabs[0].url !== session.pageContext!.url) {
        console.log(
          '[KnowSeek] sendChatMessage: URL changed from "%s" to "%s", clearing cached page context',
          session.pageContext!.url,
          tabs[0].url
        );
        session.pageContext = { ...session.pageContext!, content: null };
      }
    } catch (_) {}
  }

  session.messages.push({
    role: 'user',
    content: text,
    ...(displayText ? { display: displayText } : {}),
    ...(allImages ? { images: allImages } : {}),
  });
  if (session.title === '新对话') {
    session.title = text.length > 20 ? text.slice(0, 20) + '…' : text;
    renderSessionList();
  }
  const msgData = { text: displayText || text, images: allImages };
  addMessageBubble('user', msgData.text, true, msgData);

  pendingImages = [];
  renderImagePreview();

  addThinkingBubble();

  if (session.pageContext && session.pageContext.url && !session.pageContext.content) {
    for (let retry = 0; retry < 4; retry++) {
      const tabCtx = await getPageContextNow();
      if (tabCtx && tabCtx.content && tabCtx.content.length > 100) {
        session.pageContext = tabCtx;
        updateContextIndicator(session);
        console.log('[KnowSeek] sendChatMessage: page context loaded, len=' + tabCtx.content.length);
        break;
      }
      console.log('[KnowSeek] sendChatMessage: retry ' + (retry + 1) + ' page context empty, waiting...');
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!session.pageContext || !session.pageContext.content) {
      const lastTry = await getPageContextNow();
      if (lastTry && lastTry.content) {
        session.pageContext = lastTry;
        updateContextIndicator(session);
      }
    }
  }

  if (!session.pageContext || !session.pageContext.content) {
    try {
      const tabs = await new Promise<chrome.tabs.Tab[]>((r) =>
        chrome.tabs.query({ active: true, currentWindow: true }, r)
      );
      if (tabs && tabs[0]) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id! },
          world: 'MAIN',
          func: () => {
            const bodyText = document.body ? document.body.innerText || '' : '';
            if (bodyText) return bodyText;
            const tags = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, th, pre, blockquote');
            let text = '';
            tags.forEach((el) => {
              const t = (el.textContent || '').trim();
              if (t.length > 15) text += t + '\n';
            });
            return text || document.documentElement ? document.documentElement.innerText || '' : '';
          },
        });
        if (results && results[0] && results[0].result) {
          const rawText = (results[0].result as string).trim();
          if (rawText.length > 50) {
            session.pageContext = session.pageContext || { title: '', url: '', content: '' };
            session.pageContext.title = session.pageContext.title || tabs[0].title || '';
            session.pageContext.url = session.pageContext.url || tabs[0].url || '';
            session.pageContext.content = rawText;
            session.pageContext.isVideoPage = false;
            session.pageContext.noSubtitles = false;
            session.pageContext.subtitles = '';
            updateContextIndicator(session);
            console.log('[KnowSeek] sendChatMessage: executeScript fallback got text, len=' + rawText.length);
          }
        }
      }
    } catch (e) {
      console.warn('[KnowSeek] sendChatMessage: executeScript fallback error:', e);
    }
  }

  try {
    const config = await chrome.storage.local.get(['backend_url', 'backend_key']);
    if (!config.backend_url) {
      removeThinkingBubble();
      session.messages.push({ role: 'assistant', content: '请先配置并连接后端服务' });
      addMessageBubble('assistant', '请先配置并连接后端服务');
      saveSessions();
      return;
    }

    const baseUrl = (config.backend_url as string).replace(/\/+$/, '');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.backend_key || ''}`,
    };

    const historyMessages = (session.messages.slice(0, -1) || [])
      .filter((m) => m && typeof m.content === 'string' && typeof m.role === 'string')
      .map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.images ? { images: m.images } : {}),
      }));

    const body = JSON.stringify({
      message: text,
      images: allImages || [],
      history: historyMessages,
      page_context: session.pageContext
        ? {
            ...session.pageContext,
            content: session.pageContext.content || '',
          }
        : null,
    });

    if (_streamEnabled) {
      const response = await fetch(baseUrl + '/api/chat/stream', {
        method: 'POST',
        headers,
        body,
      });

      removeThinkingBubble();

      if (!response.ok) {
        let errMsg = '⚠️ 连接失败 (' + response.status + ')';
        try {
          const errData = await response.json().catch(() => ({}));
          if (errData.detail) errMsg = '⚠️ ' + errData.detail;
        } catch (e) {}
        session.messages.push({ role: 'assistant', content: errMsg });
        addMessageBubble('assistant', errMsg);
        saveSessions();
        return;
      }

      const bubbleEl = addMessageBubble('assistant', '');
      const contentEl = bubbleEl.querySelector('.chat-msg-bubble') as HTMLDivElement;
      let fullReply = '';
      const isMindmapReq = isMindmap;

      if (isMindmapReq) {
        contentEl.innerHTML =
          '<div style="padding:8px 0;color:var(--text-muted,#999);font-size:13px;">🧠 正在生成思维导图...</div>';
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6);
            if (dataStr === '[DONE]') break;
            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.chunk) {
                fullReply += parsed.chunk;
                if (!isMindmapReq) {
                  contentEl.innerHTML = renderMarkdown(fullReply);
                }
                const msgContainer = document.getElementById('chatMessages');
                if (msgContainer) msgContainer.scrollTop = msgContainer.scrollHeight;
              }
            } catch (e) {
              // ignore
            }
          }
        }
      }

      fullReply = fullReply.trim();
      if (fullReply) {
        session.messages.push({ role: 'assistant', content: fullReply, isMindmap });
        if (isMindmap) {
          renderMindmapResultPanel(contentEl, fullReply);
        } else {
          contentEl.innerHTML = renderMarkdown(fullReply);
          processTimestamps(contentEl);
          // 先让 AI 用 [IMAGE:N] 选择（优先内容相关性），没选时自动保底
          if (allImages && allImages.length > 0) {
            const replaced = renderImageMarkers(contentEl, allImages);
            if (replaced === 0 && _segmentBestFrames.length > 0) {
              renderVideoFramesPerParagraph(contentEl);
            }
          } else if (_segmentBestFrames.length > 0) {
            renderVideoFramesPerParagraph(contentEl);
          } else {
            // 没有预置图片时才走时间戳截图（兼容旧版手动 [MM:SS]）
            captureTimestampsFrames(fullReply, contentEl);
          }
          // 渲染完成，释放截帧缓存
          _preCapturedVideoFrames.clear();
          _segmentBestFrames = [];
        }
      } else {
        session.messages.push({ role: 'assistant', content: '⚠️ AI 返回为空' });
        addMessageBubble('assistant', '⚠️ AI 返回为空');
      }
    } else {
      const response = await fetch(baseUrl + '/api/chat', {
        method: 'POST',
        headers,
        body,
      });

      removeThinkingBubble();

      const data = await response.json().catch(() => ({}));
      if (response.ok && data.data && data.data.reply) {
        const reply = data.data.reply;
        session.messages.push({ role: 'assistant', content: reply, isMindmap });
        if (isMindmap) {
          const bubbleEl = addMessageBubble('assistant', reply);
          const contentEl = bubbleEl.querySelector('.chat-msg-bubble') as HTMLDivElement;
          if (contentEl) renderMindmapResultPanel(contentEl, reply);
        } else {
          const bubbleEl = addMessageBubble('assistant', reply);
          const contentEl = bubbleEl.querySelector('.chat-msg-bubble') as HTMLDivElement;
          if (contentEl) {
            // 先让 AI 用 [IMAGE:N] 选择（优先内容相关性），没选时自动保底
            if (allImages && allImages.length > 0) {
              const replaced = renderImageMarkers(contentEl, allImages);
              if (replaced === 0 && _segmentBestFrames.length > 0) {
                renderVideoFramesPerParagraph(contentEl);
              }
            } else if (_segmentBestFrames.length > 0) {
              renderVideoFramesPerParagraph(contentEl);
            } else {
              captureTimestampsFrames(reply, contentEl);
            }
            // 渲染完成，释放截帧缓存
            _preCapturedVideoFrames.clear();
            _segmentBestFrames = [];
          }
        }
      } else {
        const errMsg = data.detail || data.message || data.error || '连接失败';
        session.messages.push({ role: 'assistant', content: '⚠️ ' + errMsg });
        addMessageBubble('assistant', '⚠️ ' + errMsg);
      }
    }
  } catch (err) {
    removeThinkingBubble();
    session.messages.push({ role: 'assistant', content: '⚠️ 请求失败: ' + (err as Error).message });
    addMessageBubble('assistant', '⚠️ 请求失败: ' + (err as Error).message);
  }

  saveSessions();
}

// ── 历史会话弹窗 ──
function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderHistoryModal(): void {
  chatHistoryList.innerHTML = '';
  const ids = Object.keys(chatSessions);
  if (ids.length === 0) {
    chatHistoryList.innerHTML = '<div class="chat-history-empty">暂无对话</div>';
    return;
  }
  ids.forEach((id) => {
    const s = chatSessions[id];
    const msgCount = s.messages.length;
    const item = document.createElement('div');
    item.className = 'chat-history-item' + (id === activeSessionId ? ' active' : '');
    item.innerHTML = `<span class="chat-history-item-icon">💬</span>
      <div class="chat-history-item-info">
        <div class="chat-history-item-title">${escHtml(s.title)}</div>
        <div class="chat-history-item-meta">${msgCount} 条消息 · ${formatTime(s.createdAt)}</div>
      </div>
      <div class="chat-history-item-actions">
        <button class="chat-history-item-rename" data-sid="${id}">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        </button>
        <button class="chat-history-item-del" data-sid="${id}">✕</button>
      </div>`;
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.chat-history-item-actions')) return;
      switchSession(id);
      chatHistoryModal.classList.add('hidden');
    });
    const renameBtn = item.querySelector('.chat-history-item-rename') as HTMLButtonElement;
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(id, item);
    });
    const delBtn = item.querySelector('.chat-history-item-del') as HTMLButtonElement;
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(id);
      renderHistoryModal();
    });
    chatHistoryList.appendChild(item);
  });
}

function startRename(id: string, item: HTMLDivElement): void {
  const s = chatSessions[id];
  if (!s) return;
  const titleEl = item.querySelector('.chat-history-item-title') as HTMLDivElement;
  const currentTitle = s.title;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chat-history-rename-input';
  input.value = currentTitle;
  input.maxLength = 50;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  function finishRename() {
    const newTitle = input.value.trim() || currentTitle;
    s.title = newTitle;
    saveSessions();
    renderHistoryModal();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      input.value = currentTitle;
      input.blur();
    }
  });
  input.addEventListener('blur', finishRename);
}

/** 清除当前会话中的搜索高亮 */
function clearChatSearchHighlight(): void {
  if (!chatMessages) return;
  chatMessages.querySelectorAll('.chat-msg-bubble .chat-search-highlight').forEach((el) => {
    const parent = el.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(el.textContent || ''), el);
      parent.normalize();
    }
  });
  chatMessages.querySelectorAll('.chat-message.search-matched').forEach((el) => {
    el.classList.remove('search-matched');
  });
}

/** 在当前会话中高亮匹配的消息并滚动到目标位置 */
function highlightChatMessages(query: string, targetMsgIndex = -1): void {
  clearChatSearchHighlight();
  if (!chatMessages || !query.trim()) return;
  const q = query.toLowerCase().trim();
  const bubbles = Array.from(chatMessages.querySelectorAll('.chat-message:not(.system-notice)'));
  if (bubbles.length === 0) return;

  let firstMatchedIndex = -1;
  bubbles.forEach((bubbleEl, idx) => {
    const bubble = bubbleEl.querySelector('.chat-msg-bubble') as HTMLElement | null;
    if (!bubble) return;
    const text = bubble.textContent || '';
    if (!text.toLowerCase().includes(q)) return;

    bubbleEl.classList.add('search-matched');
    if (firstMatchedIndex === -1) firstMatchedIndex = idx;

    // 高亮文本：仅在文本节点中替换，避免破坏 HTML 结构
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, null);
    const textNodes: Text[] = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

    textNodes.forEach((node) => {
      const val = node.nodeValue || '';
      const lower = val.toLowerCase();
      let pos = lower.indexOf(q);
      if (pos === -1) return;
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      while (pos !== -1) {
        if (pos > lastIndex) {
          fragment.appendChild(document.createTextNode(val.slice(lastIndex, pos)));
        }
        const mark = document.createElement('mark');
        mark.className = 'chat-search-highlight';
        mark.textContent = val.slice(pos, pos + q.length);
        fragment.appendChild(mark);
        lastIndex = pos + q.length;
        pos = lower.indexOf(q, lastIndex);
      }
      if (lastIndex < val.length) {
        fragment.appendChild(document.createTextNode(val.slice(lastIndex)));
      }
      node.parentNode?.replaceChild(fragment, node);
    });
  });

  const scrollIdx = targetMsgIndex >= 0 ? targetMsgIndex : firstMatchedIndex;
  if (scrollIdx >= 0 && scrollIdx < bubbles.length) {
    // 即时滚动，不带动画，避免延迟感
    bubbles[scrollIdx].scrollIntoView({ behavior: 'auto', block: 'center' });
    // 给目标气泡一个明显的脉冲提示
    const targetBubble = bubbles[scrollIdx].querySelector('.chat-msg-bubble') as HTMLElement | null;
    if (targetBubble) {
      targetBubble.classList.add('search-scroll-target');
      setTimeout(() => targetBubble.classList.remove('search-scroll-target'), 1200);
    }
  }
}

/** 搜索聊天历史（按标题和消息内容），同时高亮当前会话的匹配消息 */
function searchChatSessions(query: string): void {
  if (!chatHistoryModal) return;
  chatHistoryList.innerHTML = '';
  const ids = Object.keys(chatSessions);
  const q = query.toLowerCase().trim();

  // 无论是否打开弹窗，都先高亮当前会话中的匹配消息
  if (activeSessionId && chatSessions[activeSessionId]) {
    highlightChatMessages(query);
  }

  if (!q || ids.length === 0) {
    renderHistoryModal();
    if (q) chatHistoryList.innerHTML = '<div class="chat-history-empty">无匹配的对话</div>';
    return;
  }

  const matched: Array<{ id: string; s: ChatSession; matchIn: string; msgIndex: number }> = [];
  ids.forEach((id) => {
    const s = chatSessions[id];
    // 按标题匹配
    if (s.title.toLowerCase().includes(q)) {
      matched.push({ id, s, matchIn: '标题', msgIndex: -1 });
      return;
    }
    // 按消息内容匹配，记录第一条匹配的消息索引（只统计实际渲染的非 system 消息）
    const visibleMsgs = s.messages.filter((m) => m.role !== 'system');
    for (let i = 0; i < visibleMsgs.length; i++) {
      const msg = visibleMsgs[i];
      if (msg.content && msg.content.toLowerCase().includes(q)) {
        matched.push({ id, s, matchIn: `第 ${i + 1} 条消息`, msgIndex: i });
        return;
      }
    }
  });

  if (matched.length === 0) {
    chatHistoryList.innerHTML = '<div class="chat-history-empty">无匹配的对话</div>';
    return;
  }

  matched.forEach(({ id, s, matchIn, msgIndex }) => {
    const msgCount = s.messages.length;
    const item = document.createElement('div');
    item.className = 'chat-history-item' + (id === activeSessionId ? ' active' : '');
    item.innerHTML = `<span class="chat-history-item-icon">💬</span>
      <div class="chat-history-item-info">
        <div class="chat-history-item-title">${escHtml(s.title)}</div>
        <div class="chat-history-item-meta">${msgCount} 条消息 · ${formatTime(s.createdAt)} · 匹配：${matchIn}</div>
      </div>
      <div class="chat-history-item-actions">
        <button class="chat-history-item-rename" data-sid="${id}">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        </button>
        <button class="chat-history-item-del" data-sid="${id}">✕</button>
      </div>`;
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.chat-history-item-actions')) return;
      switchSession(id);
      chatHistoryModal.classList.add('hidden');
      // 切换到对应会话后，高亮匹配消息并滚动
      setTimeout(() => highlightChatMessages(query, msgIndex), 50);
    });
    const renameBtn = item.querySelector('.chat-history-item-rename') as HTMLButtonElement;
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(id, item);
    });
    const delBtn = item.querySelector('.chat-history-item-del') as HTMLButtonElement;
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(id);
      searchChatSessions(query);
    });
    chatHistoryList.appendChild(item);
  });

  chatHistoryModal.classList.remove('hidden');
}

// ── 外部入口 ──
function addToChat(text: string, pageTitle?: string, pageUrl?: string, pageContent?: string): void {
  setPendingText(text);
  if (pageTitle || pageUrl) {
    if (!activeSessionId || !chatSessions[activeSessionId]) createSession();
    const session = chatSessions[activeSessionId!];
    session.pageContext = {
      title: pageTitle || '',
      url: pageUrl || '',
      content: pageContent || '',
    };
    saveSessions();
    updateContextIndicator(session);
  }
}

function addImageToChat(dataUrl: string, name: string, pageTitle?: string, pageUrl?: string): void {
  if (!activeSessionId || !chatSessions[activeSessionId]) createSession();
  if (dataUrl) addPendingImage(dataUrl, name || '图片');
  if (pageTitle || pageUrl) {
    const session = chatSessions[activeSessionId!];
    session.pageContext = {
      title: pageTitle || '',
      url: pageUrl || '',
      content: '',
    };
    saveSessions();
    updateContextIndicator(session);
  }
}

function sendVideoToChat(dataUrl: string, name: string, pageTitle?: string, pageUrl?: string, subtitles?: string): void {
  if (!activeSessionId || !chatSessions[activeSessionId]) createSession();
  if (dataUrl) addPendingImage(dataUrl, name || '视频帧');
  if (pageTitle || pageUrl || subtitles) {
    const session = chatSessions[activeSessionId!];
    const hasSubtitles = !!subtitles;
    session.pageContext = {
      title: pageTitle || '',
      url: pageUrl || '',
      content: hasSubtitles ? `## 视频字幕\n\n${subtitles}` : '',
      noSubtitles: !hasSubtitles,
    };
    saveSessions();
    updateContextIndicator(session);
  }
}

// ── 事件绑定 ──
function bindEvents(): void {
  chatSendBtn.addEventListener('click', () => sendChatMessage());

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });

  chatNewBtn.addEventListener('click', createSession);
  chatPendingCancel.addEventListener('click', clearPending);

  chatPresetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = (btn as HTMLElement).dataset.action;
      const prompt = presetPrompts[action || ''];
      if (!prompt) return;
      if (!_pendingText) return;
      const fullText = prompt + _pendingText;
      clearPending();
      sendChatMessage(fullText);
    });
  });

  chatImgBtn.addEventListener('click', () => chatImageInput.click());

  chatSubtitlePreview.addEventListener('click', () => {
    const session = activeSessionId ? chatSessions[activeSessionId] : null;
    const subtitles = session?.pageContext?.subtitles;
    if (subtitles && subtitles.trim()) {
      _subtitlePreviewSubtitles = subtitles.trim();
      showSubtitlePreviewModal(subtitles.trim());
    }
  });

  chatImageInput.addEventListener('change', async () => {
    const files = Array.from(chatImageInput.files || []);
    chatImageInput.value = '';
    for (const file of files) {
      if (pendingImages.length >= MAX_IMAGES) break;
      if (!file.type.startsWith('image/')) continue;
      const dataUrl = await compressImage(file);
      if (dataUrl) addPendingImage(dataUrl, file.name);
    }
  });

  chatInput.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (pendingImages.length >= MAX_IMAGES) break;
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const dataUrl = await compressImage(file);
          if (dataUrl) addPendingImage(dataUrl, 'clipboard');
        }
      }
    }
  });

  chatInputWrap.addEventListener('dragover', (e) => {
    e.preventDefault();
    (chatInputWrap.style as any).borderColor = 'var(--accent)';
  });
  chatInputWrap.addEventListener('dragleave', () => {
    (chatInputWrap.style as any).borderColor = '';
  });
  chatInputWrap.addEventListener('drop', async (e) => {
    e.preventDefault();
    (chatInputWrap.style as any).borderColor = '';
    const files = Array.from(e.dataTransfer?.files || []);
    for (const file of files) {
      if (pendingImages.length >= MAX_IMAGES) break;
      if (!file.type.startsWith('image/')) continue;
      const dataUrl = await compressImage(file);
      if (dataUrl) addPendingImage(dataUrl, file.name);
    }
  });

  chatModelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (chatModelDropdown.classList.contains('hidden')) {
      showModelDropdown();
    } else {
      hideModelDropdown();
    }
  });

  document.addEventListener('click', () => hideModelDropdown());

  chatHistoryBtn.addEventListener('click', () => {
    renderHistoryModal();
    chatHistoryModal.classList.remove('hidden');
  });
  chatHistoryOverlay.addEventListener('click', () => chatHistoryModal.classList.add('hidden'));
  chatHistoryClose.addEventListener('click', () => chatHistoryModal.classList.add('hidden'));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !chatHistoryModal.classList.contains('hidden')) {
      chatHistoryModal.classList.add('hidden');
    }
  });

  chrome.tabs.onActivated.addListener((activeInfo) => {
    chrome.tabs.get(activeInfo.tabId, (tab) => {
      if (tab && tab.url) {
        updateGlobalPresets();
        refreshPageContext();
      }
    });
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete' || changeInfo.url) {
      chrome.tabs.get(tabId, (tab) => {
        if (tab && tab.url && tab.active) {
          updateGlobalPresets();
          refreshPageContext();
        }
      });
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      updateGlobalPresets();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'subtitlesReady') {
      console.log('[KnowSeek] chat: subtitles ready, updating presets...');
      updateGlobalPresets();
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.ai_providers || changes.ai_active_provider) {
      loadAiProviders().then(() => {
        renderModelSwitcher();
        updateImageButtonVisibility();
      });
    }
  });
}

// ── 初始化 ──
async function init(): Promise<void> {
  await loadAiProviders();
  bindEvents();

  chrome.storage.local.get(
    ['chat_sessions', 'chat_active_session_id', 'pendingAddToChat', 'pendingImageToChat'],
    (result) => {
      if (result.chat_sessions && Object.keys(result.chat_sessions).length > 0) {
        // 兼容处理：存储格式可能是数组或对象，统一转为 Record<string, ChatSession>
        const raw = result.chat_sessions;
        if (Array.isArray(raw)) {
          chatSessions = {};
          for (const s of raw) {
            if (s && s.id) chatSessions[s.id] = s;
          }
        } else {
          chatSessions = raw as Record<string, ChatSession>;
        }
        for (const sid of Object.keys(chatSessions)) {
          if (chatSessions[sid].messages && Array.isArray(chatSessions[sid].messages)) {
            chatSessions[sid].messages = chatSessions[sid].messages.filter(
              (m) => m && typeof m.content === 'string' && typeof m.role === 'string'
            );
          }
        }
        activeSessionId = result.chat_active_session_id || Object.keys(chatSessions)[0];
        if (!chatSessions[activeSessionId]) activeSessionId = Object.keys(chatSessions)[0];
      } else {
        const id = genId();
        chatSessions[id] = { id, title: '新对话', messages: [], createdAt: Date.now() };
        activeSessionId = id;
      }
      renderSessionList();
      renderChat();
      updateContextIndicator(activeSessionId ? chatSessions[activeSessionId] : null);
      saveSessions();
      renderModelSwitcher();
      updateImageButtonVisibility();

      if (result.pendingAddToChat) {
        const pending = result.pendingAddToChat;
        chrome.storage.local.remove('pendingAddToChat');
        addToChat(pending.text, pending.pageTitle, pending.pageUrl, pending.pageContent);
      }

      if (result.pendingImageToChat) {
        const pending = result.pendingImageToChat;
        chrome.storage.local.remove('pendingImageToChat');
        addImageToChat(pending.dataUrl, pending.name || '图片', pending.pageTitle, pending.pageUrl);
      }

      // 侧边栏新打开时检测是否有中断的视频总结
      _checkInterruptedSummary();
    }
  );
}

// 暴露给旧 sidebar.js 和其他模块使用
(window as any).__knowSeekChat = {
  init,
  onPanelShown,
  addToChat,
  addImageToChat,
  sendVideoToChat,
  setPendingText,
  addPendingImage,
  renderModelSwitcher,
  updateGlobalPresets,
  updateImageButtonVisibility,
  isVisionModel,
  getActiveProvider,
  getActiveModel,
  syncActiveToBackend,
  searchChatSessions,
};

export { init };
