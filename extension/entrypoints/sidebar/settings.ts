// KnowSeek 侧边栏设置与备份模块
// 从旧 sidebar.js 迁移而来，管理 AI Provider、后端服务、WebDAV/服务器备份、导入导出、主题切换等。

import JSZip from 'jszip';
import {
  STORAGE_KEYS,
  DEFAULT_BASE_URLS,
  records,
  tags,
  markTags,
  savedRecordOrder,
  aiProviders,
  activeProviderId,
  editingProviderId,
  backupLogs,
  updateRecords,
  updateTags,
  updateMarkTags,
  updateSavedRecordOrder,
  updateAiProviders,
  updateActiveProviderId,
  updateEditingProviderId,
  updateBackupLogs,
  loadAiProviders as loadSharedAiProviders,
} from './state';
import { toggleTheme, loadTheme } from './theme';

// ── 类型定义 ──
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

// ── 全局 Embedding 配置（独立于 LLM 提供商） ──

const EMBEDDING_CONFIG_KEY = '_embeddingConfig';

interface EmbeddingConfig {
  provider: string;
  api_key: string;
  base_url: string;
  model: string;
  label: string;
}

function defaultEmbeddingConfig(): EmbeddingConfig {
  return { provider: 'siliconflow', api_key: '', base_url: '', model: '', label: '' };
}

let _embeddingConfig: EmbeddingConfig = defaultEmbeddingConfig();

async function loadEmbeddingConfig(): Promise<void> {
  try {
    const data = await chrome.storage.local.get(EMBEDDING_CONFIG_KEY);
    _embeddingConfig = data[EMBEDDING_CONFIG_KEY] || defaultEmbeddingConfig();
  } catch {
    _embeddingConfig = defaultEmbeddingConfig();
  }
}

async function saveEmbeddingConfig(): Promise<void> {
  await chrome.storage.local.set({ [EMBEDDING_CONFIG_KEY]: _embeddingConfig });
}

function syncEmbeddingConfigToBackend(): void {
  // 由 syncActiveToBackend 统一发送
}

interface BackupLog {
  id: string;
  status: 'success' | 'error';
  message: string;
  time: number;
}

// ── DOM 元素 ──
const elements = {
  importMenuBtn: document.getElementById('importMenuBtn') as HTMLButtonElement,
  exportMenuBtn: document.getElementById('exportMenuBtn') as HTMLButtonElement,
  importFile: document.getElementById('importFile') as HTMLInputElement,
  githubStorageModal: document.getElementById('githubStorageModal') as HTMLDivElement,
  cancelGithubBtn: document.getElementById('cancelGithubBtn') as HTMLButtonElement,
  saveGithubBtn: document.getElementById('saveGithubBtn') as HTMLButtonElement,
  githubTokenInput: document.getElementById('githubTokenInput') as HTMLInputElement,
  gistIdInput: document.getElementById('gistIdInput') as HTMLInputElement,
  backupEnabled: document.getElementById('backupEnabled') as HTMLInputElement,
  backupTime: document.getElementById('backupTime') as HTMLInputElement,
  webdavUrl: document.getElementById('webdavUrl') as HTMLInputElement,
  webdavUsername: document.getElementById('webdavUsername') as HTMLInputElement,
  webdavPassword: document.getElementById('webdavPassword') as HTMLInputElement,
  webdavDir: document.getElementById('webdavDir') as HTMLInputElement,
  webdavFilename: document.getElementById('webdavFilename') as HTMLInputElement,
  backupStatus: document.getElementById('backupStatus') as HTMLDivElement,
  nextBackupTime: document.getElementById('nextBackupTime') as HTMLDivElement,
  backupLogList: document.getElementById('backupLogList') as HTMLDivElement,
  backupLogContent: document.getElementById('backupLogContent') as HTMLDivElement,
  triggerBackupBtn: document.getElementById('triggerBackupBtn') as HTMLButtonElement,
  overwriteLocalBtn: document.getElementById('overwriteLocalBtn') as HTMLButtonElement,
  syncMenuBtn: document.getElementById('syncMenuBtn') as HTMLButtonElement,
  obsidianExportBtn: document.getElementById('obsidianExportBtn') as HTMLButtonElement,
  themeToggleBtn: document.getElementById('themeToggleBtn') as HTMLButtonElement,
  backendServiceBtn: document.getElementById('backendServiceBtn') as HTMLButtonElement,
  backendServiceModal: document.getElementById('backendServiceModal') as HTMLDivElement,
  cancelBackendBtn: document.getElementById('cancelBackendBtn') as HTMLButtonElement,
  backendKey: document.getElementById('backendKey') as HTMLInputElement,
  testBackendBtn: document.getElementById('testBackendBtn') as HTMLButtonElement,
  backendTestResult: document.getElementById('backendTestResult') as HTMLDivElement,
  aiConfigModal: document.getElementById('aiConfigModal') as HTMLDivElement,
  cancelAiConfigBtn: document.getElementById('cancelAiConfigBtn') as HTMLButtonElement,
  saveAiConfigBtn: document.getElementById('saveAiConfigBtn') as HTMLButtonElement,
  testAiBtn: document.getElementById('testAiBtn') as HTMLButtonElement,
  aiTestResult: document.getElementById('aiTestResult') as HTMLDivElement,
  testEmbeddingBtn: document.getElementById('testEmbeddingBtn') as HTMLButtonElement,
  embeddingTestResult: document.getElementById('embeddingTestResult') as HTMLDivElement,
  aiProvider: document.getElementById('aiProvider') as HTMLSelectElement,
  aiApiKey: document.getElementById('aiApiKey') as HTMLInputElement,
  aiModelSelect: document.getElementById('aiModelSelect') as HTMLSelectElement,
  refreshModelsBtn: document.getElementById('refreshModelsBtn') as HTMLButtonElement,
  aiBaseUrl: document.getElementById('aiBaseUrl') as HTMLInputElement,
  aiMaxTokens: document.getElementById('aiMaxTokens') as HTMLInputElement,
  aiStream: document.getElementById('aiStream') as HTMLInputElement,
  aiStreamLabel: document.getElementById('aiStreamLabel') as HTMLSpanElement,
  aiLabel: document.getElementById('aiLabel') as HTMLInputElement,
  editingProviderIdInput: document.getElementById('editingProviderId') as HTMLInputElement,
  providerList: document.getElementById('providerList') as HTMLDivElement,
  addProviderBtn: document.getElementById('addProviderBtn') as HTMLButtonElement,
  aiModelList: document.getElementById('aiModelList') as HTMLDivElement,
  aiModelCount: document.getElementById('aiModelCount') as HTMLSpanElement,
  addModelBtn: document.getElementById('addModelBtn') as HTMLButtonElement,
  aiEmbeddingModel: document.getElementById('aiEmbeddingModel') as HTMLInputElement,
  aiEmbeddingProvider: document.getElementById('aiEmbeddingProvider') as HTMLSelectElement,
  aiEmbeddingApiKey: document.getElementById('aiEmbeddingApiKey') as HTMLInputElement,
  aiEmbeddingBaseUrl: document.getElementById('aiEmbeddingBaseUrl') as HTMLInputElement,
  aiEmbeddingLabel: document.getElementById('aiEmbeddingLabel') as HTMLInputElement,
  obsidianExportBtn: document.getElementById('obsidianExportBtn') as HTMLButtonElement,
};

// ── 状态 ──
let _backendConnected = false;
let _aiConfigured = false;
let _streamEnabled = true;
const _DEFAULT_BACKEND_URL = 'http://localhost:8765';

// ── 工具函数 ──
function generateId(): string {
  return '01' + Date.now().toString(36) + Math.random().toString(36).substring(2, 10).toUpperCase();
}

function escapeHtml(text: string): string {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function formatDateForFilename(): string {
  const date = new Date();
  return (
    date.getFullYear() +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0') +
    '-' +
    String(date.getHours()).padStart(2, '0') +
    String(date.getMinutes()).padStart(2, '0')
  );
}

// ── AI Provider 管理 ──
async function loadAiProviders(): Promise<void> {
  await loadSharedAiProviders();
  const providers = aiProviders as AIProvider[];
  const active = providers.find((p) => p.id === activeProviderId) || providers[0] || null;
  _streamEnabled = active ? active.stream : true;
}

async function saveAiProviders(): Promise<void> {
  await chrome.storage.local.set({
    ai_providers: aiProviders,
    ai_active_provider: activeProviderId,
  });
}

function getActiveProvider(): AIProvider | null {
  return (aiProviders as AIProvider[]).find((p) => p.id === activeProviderId) || aiProviders[0] || null;
}

function getActiveModel(): AIModel | null {
  const provider = getActiveProvider();
  if (!provider || !provider.models || !provider.activeModelId) return null;
  return (
    provider.models.find((m) => m.modelId === provider.activeModelId) || provider.models[0] || null
  );
}

async function updateImageButtonVisibility(): Promise<void> {
  const chatImgBtn = document.getElementById('chatImgBtn') as HTMLButtonElement | null;
  const activeModel = getActiveModel();
  const modelName = activeModel ? activeModel.model : '';
  // 委托 chat 模块的 isVisionModel（利用 litellm 的模型能力列表）
  const chatApi = (window as any).__knowSeekChat;
  const canUpload = chatApi?.isVisionModel
    ? await chatApi.isVisionModel(modelName)
    : false;
  if (chatImgBtn) chatImgBtn.style.display = canUpload ? '' : 'none';
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
          embedding_model: _embeddingConfig.model,
          embedding_provider: _embeddingConfig.provider,
          embedding_api_key: _embeddingConfig.api_key,
          embedding_base_url: _embeddingConfig.base_url,
        }),
      });
    }
  } catch (e) {
    console.warn('[KnowSeek Settings] 同步活跃配置到后端失败:', e);
  }
}

function renderProviderList(): void {
  const list = elements.providerList;
  if (!list) return;
  const providers = aiProviders as AIProvider[];

  if (providers.length === 0) {
    list.innerHTML = '<div style="padding:8px;text-align:center;font-size:12px;color:var(--text-dim);">暂无配置，请添加</div>';
    return;
  }

  list.innerHTML = providers
    .map((p) => {
      const isEditing = p.id === editingProviderId;
      const label = p.label || p.provider;
      const modelCount = (p.models || []).length;
      const modelLabel = modelCount > 0 ? `(${modelCount}个模型)` : '(无模型)';
      return `<div class="provider-item ${isEditing ? 'active' : ''}" data-id="${p.id}">
        <div class="provider-check"></div>
        <div class="provider-name">${label}</div>
        <div class="provider-model">${modelLabel}</div>
        <button class="provider-del" data-id="${p.id}" title="删除此配置">&times;</button>
      </div>`;
    })
    .join('');

  list.querySelectorAll('.provider-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.provider-del')) return;
      editProvider((item as HTMLElement).dataset.id!);
    });
  });

  list.querySelectorAll('.provider-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteProvider((btn as HTMLElement).dataset.id!);
    });
  });
}

function editProvider(id: string): void {
  const provider = (aiProviders as AIProvider[]).find((p) => p.id === id);
  if (!provider) return;
  updateEditingProviderId(id);
  elements.editingProviderIdInput.value = id;

  elements.aiLabel.value = provider.label || '';
  elements.aiProvider.value = provider.provider || 'deepseek';
  elements.aiApiKey.value = provider.api_key || '';
  elements.aiBaseUrl.value = provider.base_url || DEFAULT_BASE_URLS[provider.provider] || '';
  elements.aiMaxTokens.value = String(provider.max_tokens || 1024);
  elements.aiStream.checked = provider.stream !== undefined ? provider.stream : true;
  elements.aiStreamLabel.textContent = elements.aiStream.checked ? '已开启' : '已关闭';
  elements.aiEmbeddingProvider.value = _embeddingConfig.provider;
  elements.aiEmbeddingApiKey.value = _embeddingConfig.api_key;
  elements.aiEmbeddingBaseUrl.value = _embeddingConfig.base_url;
  elements.aiEmbeddingLabel.value = _embeddingConfig.label;
  elements.aiEmbeddingModel.value = _embeddingConfig.model;
  // 保存模型值，在 provider change 触发加载后恢复
  const savedModel = _embeddingConfig.model;
  // 触发 provider change 以更新 base URL 显示状态并加载模型列表
  const evt = new Event('change');
  (evt as any)._embeddingModel = savedModel;
  elements.aiEmbeddingProvider.dispatchEvent(evt);

  renderProviderList();
  renderModelList();
  fetchModels();
}

async function deleteProvider(id: string): Promise<void> {
  const providers = aiProviders as AIProvider[];
  if (providers.length <= 1) {
    alert('至少需要保留一个配置');
    return;
  }
  if (!confirm('确定要删除此配置吗？')) return;

  updateAiProviders(providers.filter((p) => p.id !== id));
  if (activeProviderId === id) {
    updateActiveProviderId(aiProviders[0]?.id || null);
  }
  if (editingProviderId === id) {
    updateEditingProviderId(aiProviders[0]?.id || null);
  }
  await saveAiProviders();
  renderProviderList();

  if (editingProviderId) {
    editProvider(editingProviderId);
  } else if (aiProviders.length > 0) {
    editProvider(aiProviders[0].id);
  }
  syncActiveToBackend();
}

function addNewProvider(): void {
  if (editingProviderId) {
    const cur = (aiProviders as AIProvider[]).find((p) => p.id === editingProviderId);
    if (cur) {
      cur.provider = elements.aiProvider.value;
      cur.api_key = elements.aiApiKey.value.trim();
      cur.base_url = elements.aiBaseUrl.value.trim();
      cur.max_tokens = parseInt(elements.aiMaxTokens.value, 10) || 1024;
      cur.stream = elements.aiStream.checked;
    }
  }
  const id = 'p_' + Date.now();
  const newProviders = [...aiProviders, {
    id,
    provider: 'deepseek',
    label: '新配置',
    api_key: '',
    base_url: DEFAULT_BASE_URLS.deepseek,
    models: [],
    activeModelId: null,
    max_tokens: 1024,
    stream: true,
  }];
  updateAiProviders(newProviders);
  saveAiProviders();
  updateEditingProviderId(id);
  editProvider(id);
}

function renderModelList(): void {
  const provider = (aiProviders as AIProvider[]).find((p) => p.id === editingProviderId);
  const container = elements.aiModelList;
  const countEl = elements.aiModelCount;
  if (!container) return;

  if (!provider || !provider.models || provider.models.length === 0) {
    container.innerHTML = '<div class="model-list-empty">暂无模型，从下方选择后点击「添加」</div>';
    if (countEl) countEl.textContent = '';
    return;
  }

  if (countEl) countEl.textContent = `(${provider.models.length}个)`;

  container.innerHTML = provider.models
    .map((m) => {
      const isActive = m.modelId === provider.activeModelId;
      return `<div class="model-list-item ${isActive ? 'active' : ''}" data-model-id="${m.modelId}">
        <div class="mli-dot"></div>
        <span class="mli-name">${m.model}</span>
        <button class="mli-del" data-model-id="${m.modelId}" title="移除模型">&times;</button>
      </div>`;
    })
    .join('');

  container.querySelectorAll('.model-list-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.mli-del')) return;
      const mId = (item as HTMLElement).dataset.modelId;
      if (provider && mId && provider.activeModelId !== mId) {
        provider.activeModelId = mId;
        renderModelList();
        syncActiveToBackend();
      }
    });
  });

  container.querySelectorAll('.mli-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const mId = (btn as HTMLElement).dataset.modelId;
      if (provider && mId) deleteModelFromProvider(provider, mId);
    });
  });
}

async function addModelToProvider(): Promise<void> {
  const provider = (aiProviders as AIProvider[]).find((p) => p.id === editingProviderId);
  if (!provider) {
    alert('请先选择或创建一个提供商配置');
    return;
  }
  const modelName = elements.aiModelSelect.value.trim();
  if (!modelName) {
    alert('请先选择或输入模型名称');
    return;
  }
  if ((provider.models || []).some((m) => m.model === modelName)) {
    alert(`模型「${modelName}」已存在`);
    return;
  }
  const mId = 'm_' + Date.now();
  if (!provider.models) provider.models = [];
  provider.models.push({ modelId: mId, model: modelName });
  if (!provider.activeModelId) {
    provider.activeModelId = mId;
  }
  saveAiProviders();
  renderModelList();
  await updateImageButtonVisibility();
}

async function deleteModelFromProvider(provider: AIProvider, modelId: string): Promise<void> {
  if (!provider.models || provider.models.length <= 1) {
    alert('至少保留一个模型');
    return;
  }
  provider.models = provider.models.filter((m) => m.modelId !== modelId);
  if (provider.activeModelId === modelId) {
    provider.activeModelId = provider.models[0]?.modelId || null;
  }
  saveAiProviders();
  renderModelList();
  await updateImageButtonVisibility();
  syncActiveToBackend();
}

async function openAiConfig(): Promise<void> {
  await loadAiProviders();
  await loadEmbeddingConfig();

  if (aiProviders.length > 0) {
    const targetId = editingProviderId || activeProviderId || aiProviders[0].id;
    editProvider(targetId);
  } else {
    addNewProvider();
  }

  elements.aiTestResult.classList.add('hidden');
  elements.aiConfigModal.classList.remove('hidden');

  // 加载 ASR 配置
  let savedEngine = localStorage.getItem('knowseek_asr_engine') || 'whisper';
  let savedModel = localStorage.getItem('knowseek_asr_model') || 'tiny';
  const savedApiKey = localStorage.getItem('knowseek_asr_api_key') || '';
  // 校验引擎值是否有效，无效则清理并回退
  const validEngines = ['whisper', 'bailian'];
  if (!validEngines.includes(savedEngine)) {
    savedEngine = 'whisper';
    localStorage.setItem('knowseek_asr_engine', 'whisper');
  }
  const engineEl = document.getElementById('asrEngine') as HTMLSelectElement;
  const apiKeyEl = document.getElementById('asrApiKey') as HTMLInputElement;
  if (engineEl) engineEl.value = savedEngine;
  if (apiKeyEl) apiKeyEl.value = savedApiKey;
  // 模型列表由 loadAsrModels() 填充
  updateAsrUIVisibility(savedEngine);
  await loadAsrModels(savedEngine, savedModel);
}

async function fetchModels(): Promise<void> {
  const select = elements.aiModelSelect;
  const btn = elements.refreshModelsBtn;
  btn.classList.add('spinning');
  select.innerHTML = '<option value="">正在加载模型列表…</option>';

  try {
    const saved = await chrome.storage.local.get(['backend_url', 'backend_key']);
    if (!saved.backend_url) {
      select.innerHTML = '<option value="">请先连接高级服务</option>';
      btn.classList.remove('spinning');
      return;
    }

    const provider = elements.aiProvider.value;
    const apiKey = elements.aiApiKey.value.trim();
    const baseUrl = elements.aiBaseUrl.value.trim();

    const params = new URLSearchParams({ provider, api_key: apiKey });
    if (baseUrl) params.set('base_url', baseUrl);

    const url = (saved.backend_url as string).replace(/\/+$/, '') + '/api/models?' + params.toString();
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${saved.backend_key || ''}` },
    });
    const data = await resp.json();
    if (!data.ok) {
      select.innerHTML = `<option value="">加载失败：${data.data?.error || '未知错误'}</option>`;
      btn.classList.remove('spinning');
      return;
    }
    const models = ((data.data && data.data.models) || []).map((m: any) => m.id);

    if (models.length > 0) {
      select.innerHTML =
        '<option value="">— 选择模型添加 —</option>' +
        models.map((m: string) => `<option value="${m}">${m}</option>`).join('');
    } else {
      select.innerHTML = '<option value="">(未获取到模型列表)</option>';
    }
  } catch (err) {
    select.innerHTML = '<option value="">加载失败，点击刷新重试</option>';
  }

  btn.classList.remove('spinning');
}

async function fetchEmbeddingModels(selectedModel?: string): Promise<void> {
  const select = elements.aiEmbeddingModel;
  const btn = document.getElementById('refreshEmbeddingModelsBtn') as HTMLButtonElement;
  if (btn) btn.classList.add('spinning');
  select.innerHTML = '<option value="">正在加载模型列表…</option>';

  try {
    const saved = await chrome.storage.local.get(['backend_url', 'backend_key']);
    if (!saved.backend_url) {
      select.innerHTML = '<option value="">请先连接高级服务</option>';
      if (btn) btn.classList.remove('spinning');
      return;
    }

    const provider = elements.aiEmbeddingProvider.value;
    const apiKey = elements.aiEmbeddingApiKey.value.trim();
    const baseUrl = elements.aiEmbeddingBaseUrl.value.trim();

    // 自定义提供商必须有 baseUrl
    if (provider === 'custom' && !baseUrl) {
      select.innerHTML = '<option value="">请先填写 API 地址后刷新</option>';
      if (btn) btn.classList.remove('spinning');
      return;
    }

    const params = new URLSearchParams({ provider, api_key: apiKey });
    if (baseUrl) params.set('base_url', baseUrl);

    const url = (saved.backend_url as string).replace(/\/+$/, '') + '/api/models?' + params.toString();
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${saved.backend_key || ''}` },
    });
    const data = await resp.json();
    if (!data.ok) {
      select.innerHTML = `<option value="">加载失败：${data.data?.error || '未知错误'}</option>`;
      if (btn) btn.classList.remove('spinning');
      return;
    }
    const models = ((data.data && data.data.models) || []).map((m: any) => m.id);

    if (models.length > 0) {
      select.innerHTML =
        '<option value="">— 选择 Embedding 模型 —</option>' +
        models.map((m: string) => `<option value="${m}">${m}</option>`).join('');
    } else {
      select.innerHTML = '<option value="">(未获取到模型列表)</option>';
    }

    // 恢复之前选中的模型值
    if (selectedModel && [...select.options].some(o => o.value === selectedModel)) {
      select.value = selectedModel;
    }
  } catch (err) {
    select.innerHTML = '<option value="">加载失败，点击刷新重试</option>';
  }

  if (btn) btn.classList.remove('spinning');
}

async function saveAiConfig(): Promise<void> {
  const provider = elements.aiProvider.value;
  const apiKey = elements.aiApiKey.value.trim();
  const model = elements.aiModelSelect.value;
  const baseUrl = elements.aiBaseUrl.value.trim();
  const maxTokens = parseInt(elements.aiMaxTokens.value, 10) || 1024;
  const streamEnabled = elements.aiStream.checked;
  const label = elements.aiLabel.value.trim() || provider;

  if (!apiKey) {
    alert('请填写 API Key');
    return;
  }

  const editId = editingProviderId;
  const existing = (aiProviders as AIProvider[]).find((p) => p.id === editId);

  if (existing) {
    existing.provider = provider;
    existing.api_key = apiKey;
    existing.base_url = baseUrl;
    existing.max_tokens = maxTokens;
    existing.stream = streamEnabled;
    existing.label = label;
    if (model && !existing.models.some((m) => m.model === model)) {
      const mId = 'm_' + Date.now();
      existing.models.push({ modelId: mId, model });
      if (!existing.activeModelId) existing.activeModelId = mId;
    }
  } else {
    const id = 'p_' + Date.now();
    const mId = model ? 'm_' + Date.now() : null;
    const newProviders: AIProvider[] = [
      ...(aiProviders as AIProvider[]),
      {
        id,
        provider,
        label,
        api_key: apiKey,
        base_url: baseUrl,
        models: mId ? [{ modelId: mId, model }] : [],
        activeModelId: mId,
        max_tokens: maxTokens,
        stream: streamEnabled,
      },
    ];
    updateAiProviders(newProviders);
    updateEditingProviderId(id);
  }

  // 保存独立 Embedding 配置
  _embeddingConfig.provider = elements.aiEmbeddingProvider.value;
  _embeddingConfig.api_key = elements.aiEmbeddingApiKey.value.trim();
  _embeddingConfig.base_url = elements.aiEmbeddingBaseUrl.value.trim();
  _embeddingConfig.model = elements.aiEmbeddingModel.value.trim();
  _embeddingConfig.label = elements.aiEmbeddingLabel.value.trim();
  await saveEmbeddingConfig();

  if (!activeProviderId) {
    updateActiveProviderId(editingProviderId);
  }

  _streamEnabled = streamEnabled;
  await saveAiProviders();
  renderProviderList();

  syncActiveToBackend();

  // 保存 ASR 配置
  const asrEngine = (document.getElementById('asrEngine') as HTMLSelectElement)?.value || 'whisper';
  const asrModel = (document.getElementById('asrModel') as HTMLSelectElement)?.value || 'tiny';
  const asrApiKey = (document.getElementById('asrApiKey') as HTMLInputElement)?.value || '';
  localStorage.setItem('knowseek_asr_engine', asrEngine);
  localStorage.setItem('knowseek_asr_model', asrModel);
  localStorage.setItem('knowseek_asr_api_key', asrApiKey);

  _aiConfigured = true;
  elements.aiConfigModal.classList.add('hidden');
  await updateImageButtonVisibility();
}

async function testAiConnection(): Promise<void> {
  const provider = elements.aiProvider.value;
  const apiKey = elements.aiApiKey.value.trim();
  const baseUrl = elements.aiBaseUrl.value.trim();

  const editProvider = (aiProviders as AIProvider[]).find((p) => p.id === editingProviderId);
  let model = '';
  if (editProvider && editProvider.models && editProvider.activeModelId) {
    const activeM = editProvider.models.find((m) => m.modelId === editProvider.activeModelId);
    if (activeM) model = activeM.model;
  }
  if (!model) model = elements.aiModelSelect.value;

  if (!apiKey) {
    showAiTestResult('error', '请先填写 API Key');
    return;
  }
  if (!model) {
    showAiTestResult('error', '请先添加并选中一个模型');
    return;
  }

  const resultEl = elements.aiTestResult;
  resultEl.classList.remove('hidden', 'success', 'error', 'loading');
  resultEl.classList.add('loading');
  resultEl.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 4V2A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8z"/></svg> 正在测试...';

  try {
    const config = await chrome.storage.local.get(['backend_url', 'backend_key']);
    if (!config.backend_url) {
      showAiTestResult('error', '请先配置并连接高级服务');
      return;
    }

    const response = await fetch((config.backend_url as string).replace(/\/+$/, '') + '/api/ai/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.backend_key || ''}`,
      },
      body: JSON.stringify({
        provider,
        api_key: apiKey,
        base_url: baseUrl || undefined,
        model: model || undefined,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (response.ok && data.success) {
      showAiTestResult('success', '✓ AI 连接成功！');
      _aiConfigured = true;
      await chrome.storage.local.set({ ai_connected: true });
    } else {
      showAiTestResult('error', '✗ ' + (data.message || '连接失败'));
      _aiConfigured = false;
      await chrome.storage.local.set({ ai_connected: false });
    }
  } catch (err) {
    showAiTestResult('error', '✗ 连接失败: ' + (err as Error).message);
  }
  updateAiFeatureStatus(_aiConfigured);
}

function updateAiFeatureStatus(connected: boolean): void {
  const items = [
    { item: document.getElementById('chatFeatureItem'), status: document.getElementById('featureChatStatus') },
    { item: document.getElementById('summaryFeatureItem'), status: document.getElementById('featureSummaryStatus') },
  ];
  for (const { item, status } of items) {
    if (!item || !status) continue;
    if (connected) {
      item.classList.remove('disabled');
      item.classList.add('active');
      status.textContent = '已连接';
    } else {
      item.classList.remove('active');
      item.classList.add('disabled');
      status.textContent = '未连接';
    }
  }
}

function showAiTestResult(type: string, message: string): void {
  const el = elements.aiTestResult;
  el.classList.remove('hidden', 'loading');
  el.classList.add(type);
  el.textContent = message;
}

// ── Embedding 连接测试 ──

async function testEmbeddingConnection(): Promise<void> {
  const apiKey = elements.aiEmbeddingApiKey.value.trim();
  const baseUrl = elements.aiEmbeddingBaseUrl.value.trim();
  const model = elements.aiEmbeddingModel.value.trim();

  if (!apiKey) {
    showEmbeddingTestResult('error', '请填写 Embedding API Key');
    return;
  }
  if (!model) {
    showEmbeddingTestResult('error', '请先填写 Embedding 模型名');
    return;
  }

  const resultEl = elements.embeddingTestResult;
  resultEl.classList.remove('hidden', 'success', 'error', 'loading');
  resultEl.classList.add('loading');
  resultEl.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 4V2A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8z"/></svg> 正在测试...';

  try {
    const config = await chrome.storage.local.get(['backend_url', 'backend_key']);
    if (!config.backend_url) {
      showEmbeddingTestResult('error', '请先配置并连接高级服务');
      return;
    }

    const response = await fetch((config.backend_url as string).replace(/\/+$/, '') + '/api/embedding/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.backend_key || ''}`,
      },
      body: JSON.stringify({
        api_key: apiKey,
        model,
        base_url: baseUrl || undefined,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (response.ok && data.ok) {
      showEmbeddingTestResult('success', '✓ ' + (data.message || '连接成功'));
    } else {
      showEmbeddingTestResult('error', '✗ ' + (data.message || '连接失败'));
    }
  } catch (err) {
    showEmbeddingTestResult('error', '✗ 连接失败: ' + (err as Error).message);
  }
}

function showEmbeddingTestResult(type: string, message: string): void {
  const el = elements.embeddingTestResult;
  el.classList.remove('hidden', 'loading');
  el.classList.add(type);
  el.textContent = message;
}


async function testAsrConnection(): Promise<void> {
  const engine = (document.getElementById('asrEngine') as HTMLSelectElement)?.value || 'whisper';
  const model = (document.getElementById('asrModel') as HTMLSelectElement)?.value || 'tiny';
  const apiKey = (document.getElementById('asrApiKey') as HTMLInputElement)?.value || '';

  const resultEl = document.getElementById('asrTestResult') as HTMLDivElement;
  if (!resultEl) return;
  resultEl.classList.remove('hidden', 'success', 'error', 'loading');
  resultEl.classList.add('loading');
  resultEl.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 4V2A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8z"/></svg> 正在测试...';

  try {
    const config = await chrome.storage.local.get(['backend_url', 'backend_key']);
    if (!config.backend_url) {
      showAsrTestResult('error', '请先配置并连接高级服务');
      return;
    }

    const response = await fetch((config.backend_url as string).replace(/\/+$/, '') + '/api/asr/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.backend_key || ''}`,
      },
      body: JSON.stringify({ engine, model, api_key: apiKey }),
    });

    const data = await response.json().catch(() => ({}));
    if (response.ok && data.success) {
      showAsrTestResult('success', '✓ ' + (data.message || 'ASR 连接成功'));
    } else {
      showAsrTestResult('error', '✗ ' + (data.message || '连接失败'));
    }
  } catch (err) {
    showAsrTestResult('error', '✗ 连接失败: ' + (err as Error).message);
  }
}

function showAsrTestResult(type: string, message: string): void {
  const el = document.getElementById('asrTestResult') as HTMLDivElement;
  if (!el) return;
  el.classList.remove('hidden', 'loading');
  el.classList.add(type);
  el.textContent = message;
}


// ── ASR 引擎/模型管理 ──

function updateAsrUIVisibility(engine: string): void {
  const isOnline = engine === 'bailian';
  document.getElementById('asrApiKeySection')?.classList.toggle('hidden', !isOnline);
  document.getElementById('asrCacheSection')?.classList.toggle('hidden', isOnline);
  // 本地引擎显示缓存信息
  if (!isOnline) {
    loadAsrCache();
  }
}

async function loadAsrModels(engine: string, selectModel?: string): Promise<void> {
  const select = document.getElementById('asrModel') as HTMLSelectElement;
  const info = document.getElementById('asrModelInfo') as HTMLDivElement;
  if (!select) return;

  select.innerHTML = '<option value="">加载中...</option>';

  // 从后端获取静态模型列表，失败时使用 fallback
  try {
    const config = await chrome.storage.local.get(['backend_url', 'backend_key']);
    if (!config.backend_url) {
      throw new Error('未配置后端服务');
    }
    const url = (config.backend_url as string).replace(/\/+$/, '') + '/api/asr/engines';
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${config.backend_key || ''}` },
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.message || '获取失败');
    const eng = data.data.engines.find((e: any) => e.id === engine);
    if (eng && eng.models) {
      select.innerHTML = eng.models.map((m: any) =>
        `<option value="${m.id}" ${m.id === selectModel ? 'selected' : ''}>${m.label}${m.size_mb > 0 ? ` (~${m.size_mb}MB / ${m.description})` : ` (${m.description})`}</option>`
      ).join('');
      if (info) info.textContent = engine === 'bailian'
        ? `共 ${eng.models.length} 个模型`
        : `共 ${eng.models.length} 个模型，首次使用自动下载`;
    }
  } catch {
    // 完全 fallback
    if (engine === 'bailian') {
      select.innerHTML = `
        <option value="paraformer-realtime-v2" ${selectModel === 'paraformer-realtime-v2' ? 'selected' : ''}>Paraformer-实时-v2 (多语种·字级时间戳)</option>
        <option value="paraformer-realtime-v1" ${selectModel === 'paraformer-realtime-v1' ? 'selected' : ''}>Paraformer-实时-v1 (中英文·字级时间戳)</option>
        <option value="fun-asr-realtime" ${selectModel === 'fun-asr-realtime' ? 'selected' : ''}>Fun-ASR-实时 (通用·字级时间戳)</option>
        <option value="fun-asr-realtime-2026-02-28" ${selectModel === 'fun-asr-realtime-2026-02-28' ? 'selected' : ''}>Fun-ASR-最新快照 (最新版·字级时间戳)</option>
      `;
    } else {
      select.innerHTML = `
        <option value="tiny" ${selectModel === 'tiny' ? 'selected' : ''}>Whisper Tiny (~75MB / 39M参数·~1GB显存·~10x)</option>
        <option value="base" ${selectModel === 'base' ? 'selected' : ''}>Whisper Base (~142MB / 74M参数·~1GB显存·~7x)</option>
        <option value="small" ${selectModel === 'small' ? 'selected' : ''}>Whisper Small (~466MB / 244M参数·~2GB显存·~4x)</option>
        <option value="medium" ${selectModel === 'medium' ? 'selected' : ''}>Whisper Medium (~1.4GB / 769M参数·~5GB显存·~2x)</option>
        <option value="large-v3" ${selectModel === 'large-v3' ? 'selected' : ''}>Whisper Large-v3 (~2.9GB / 1550M参数·~10GB显存·1x)</option>
        <option value="turbo" ${selectModel === 'turbo' ? 'selected' : ''}>Whisper Turbo (~1.6GB / 809M参数·~6GB显存·~8x·推荐)</option>
      `;
    }
    if (info) info.textContent = engine === 'bailian' ? '' : '首次使用自动下载模型';
  }
}

async function loadAsrCache(): Promise<void> {
  try {
    const config = await chrome.storage.local.get(['backend_url', 'backend_key']);
    if (!config.backend_url) return;
    const url = (config.backend_url as string).replace(/\/+$/, '') + '/api/asr/cache';
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${config.backend_key || ''}` },
    });
    const data = await resp.json();
    if (!data.ok) return;
    const cache = data.data;
    const count = Object.keys(cache.whisper || {}).length;
    const label = document.getElementById('asrCacheLabel');
    if (label) {
      label.textContent = `📦 已缓存 ${count} 个模型 (${cache.total_mb}MB)`;
    }
  } catch {
    // 静默失败
  }
}

function openAsrCacheModal(): void {
  const modal = document.getElementById('asrCacheModal') as HTMLDivElement;
  if (!modal) return;
  modal.classList.remove('hidden');
  refreshAsrCacheContent();
}

async function refreshAsrCacheContent(): Promise<void> {
  const content = document.getElementById('asrCacheContent') as HTMLDivElement;
  if (!content) return;
  content.innerHTML = '<p style="color:var(--text-dim);">加载中...</p>';

  try {
    const config = await chrome.storage.local.get(['backend_url', 'backend_key']);
    if (!config.backend_url) {
      content.innerHTML = '<p style="color:var(--text-dim);">请先配置高级服务</p>';
      return;
    }
    const url = (config.backend_url as string).replace(/\/+$/, '') + '/api/asr/cache';
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${config.backend_key || ''}` },
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.message);
    const cache = data.data;

    let html = '';

    // Whisper 模型
    const whisperModels = Object.entries(cache.whisper || {}) as [string, number][];
    if (whisperModels.length > 0) {
      html += '<div style="font-weight:600;font-size:12px;margin:8px 0 4px;">Whisper</div>';
      for (const [name, size] of whisperModels) {
        html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);">
          <span>whisper-${name}</span>
          <span style="display:flex;align-items:center;gap:8px;">
            <span style="color:var(--text-dim);font-size:12px;">${size}MB</span>
            <button class="delete-asr-cache-btn icon-btn" data-engine="whisper" data-model="${name}" title="删除" style="color:var(--danger, #e74c3c);font-size:14px;">🗑</button>
          </span>
        </div>`;
      }
    }

    if (!html) {
      html = '<p style="color:var(--text-dim);">暂无已缓存的模型</p>';
    }

    html += `<div style="margin-top:8px;font-size:12px;color:var(--text-dim);text-align:right;">总计: ${cache.total_mb}MB</div>`;
    content.innerHTML = html;

    // 绑定删除按钮
    content.querySelectorAll('.delete-asr-cache-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const engine = (btn as HTMLElement).dataset.engine;
        const model = (btn as HTMLElement).dataset.model;
        if (!engine || !model) return;
        await deleteAsrCacheModel(engine, model);
        await refreshAsrCacheContent();
        await loadAsrCache(); // 刷新主界面的缓存信息
      });
    });
  } catch (e) {
    content.innerHTML = `<p style="color:var(--danger, #e74c3c);">加载失败: ${(e as Error).message}</p>`;
  }
}

async function deleteAsrCacheModel(engine: string, model: string): Promise<void> {
  try {
    const config = await chrome.storage.local.get(['backend_url', 'backend_key']);
    if (!config.backend_url) return;
    const url = (config.backend_url as string).replace(/\/+$/, '') + `/api/asr/cache/${engine}/${encodeURIComponent(model)}`;
    await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${config.backend_key || ''}` },
    });
  } catch {
    // 静默失败
  }
}

async function clearAllAsrCache(): Promise<void> {
  if (!confirm('确定要清空所有本地 ASR 模型缓存吗？')) return;
  try {
    const config = await chrome.storage.local.get(['backend_url', 'backend_key']);
    if (!config.backend_url) return;
    // 先获取缓存列表
    const listUrl = (config.backend_url as string).replace(/\/+$/, '') + '/api/asr/cache';
    const listResp = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${config.backend_key || ''}` },
    });
    const listData = await listResp.json();
    if (!listData.ok) return;
    const cache = listData.data;
    const allModels: { engine: string; model: string }[] = [];
    for (const [name] of Object.entries(cache.whisper || {})) {
      allModels.push({ engine: 'whisper', model: name });
    }
    for (const item of allModels) {
      await deleteAsrCacheModel(item.engine, item.model);
    }
    await refreshAsrCacheContent();
    await loadAsrCache();
  } catch {
    // 静默
  }
}

// ── 模块 API 访问 ──
function getChatApi(): any {
  return (window as any).__knowSeekChat;
}

function getRecordsApi(): any {
  return (window as any).__knowSeekRecords;
}

function refreshChatModelSwitcher(): void {
  const api = getChatApi();
  if (api && typeof api.renderModelSwitcher === 'function') {
    api.renderModelSwitcher();
  }
  if (api && typeof api.updateImageButtonVisibility === 'function') {
    api.updateImageButtonVisibility();
  }
}

function refreshRecords(): void {
  const api = getRecordsApi();
  if (api && typeof api.renderRecords === 'function') {
    api.renderRecords();
  }
}

// ── 后端服务配置 ──
async function openBackendServiceConfig(): Promise<void> {
  const config = await chrome.storage.local.get(['backend_key', 'backend_connected']);
  elements.backendKey.value = config.backend_key || '';
  if (config.backend_connected && !config.backend_key) {
    await chrome.storage.local.set({ backend_connected: false });
    _backendConnected = false;
    updateBackendButtonStatus();
  }
  elements.backendTestResult.classList.add('hidden');
  elements.backendServiceModal.classList.remove('hidden');
  updateBackendButtonStatus();

  const syncConfig = await chrome.storage.sync.get('server_backup_enabled');
  const toggle = document.getElementById('backupToggle') as HTMLInputElement | null;
  if (toggle) toggle.checked = syncConfig.server_backup_enabled || false;
  const configDiv = document.getElementById('serverBackupConfig');
  if (configDiv) configDiv.style.display = syncConfig.server_backup_enabled ? 'block' : 'none';

  const timeConfig = await chrome.storage.sync.get('server_backup_time');
  const timeEl = document.getElementById('serverBackupTime') as HTMLInputElement | null;
  if (timeEl) timeEl.value = timeConfig.server_backup_time || '03:00';

  if (syncConfig.server_backup_enabled) {
    updateServerBackupStatus();
  }
}

async function saveBackendServiceConfig(): Promise<void> {
  const key = elements.backendKey.value.trim();
  await chrome.storage.local.set({ backend_key: key });
  elements.backendServiceModal.classList.add('hidden');
}

async function testBackendConnection(silent = false): Promise<void> {
  const url = _DEFAULT_BACKEND_URL;
  const key = elements.backendKey.value.trim();

  if (!url) {
    if (!silent) showBackendTestResult('error', '请输入服务器地址');
    return;
  }

  const resultEl = elements.backendTestResult;
  if (!silent) {
    resultEl.classList.remove('hidden', 'success', 'error', 'loading');
    resultEl.classList.add('loading');
    resultEl.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 4V2A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8z"/></svg> 正在测试连接...';
  }

  try {
    const endpoint = url.replace(/\/+$/, '') + '/api/health';
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      _backendConnected = true;
      await saveBackendConfigOnly(url, key, data);
      await chrome.storage.local.set({ backend_connected: true });
      if (!silent) {
        showBackendTestResult('success', '✓ 连接成功！后端版本: ' + (data.version || 'unknown'));
      }
      updateBackendButtonStatus();
      const featuresData = JSON.parse(JSON.stringify(data));
      if (featuresData.features && featuresData.features.ai) {
        const saved = await chrome.storage.local.get('ai_api_key');
        const hasOldKey = !!saved.ai_api_key;
        const hasNewKey = (aiProviders as AIProvider[]).some((p) => p.api_key);
        if (!hasOldKey && !hasNewKey) {
          featuresData.features = { ...featuresData.features, ai: false };
        }
      }
    } else {
      _backendConnected = false;
      await chrome.storage.local.set({ backend_connected: false });
      if (!silent) {
        showBackendTestResult('error', `✗ 连接失败 (HTTP ${response.status})`);
      }
      updateBackendButtonStatus();
      updateAiFeatureStatus(false);
    }
  } catch (err) {
    _backendConnected = false;
    await chrome.storage.local.set({ backend_connected: false });
    if (!silent) {
      showBackendTestResult('error', '✗ 连接失败: ' + (err as Error).message);
    }
    updateBackendButtonStatus();
    updateAiFeatureStatus(false);
  }
}

async function saveBackendConfigOnly(url: string, key: string, healthData: any): Promise<void> {
  await chrome.storage.local.set({ backend_url: url, backend_key: key });
  if (healthData && healthData.features) {
    await chrome.storage.local.set({ backend_features: healthData.features });
  }
  updateBackendButtonStatus();
}

async function disconnectBackend(): Promise<void> {
  await chrome.storage.local.set({
    backend_url: '',
    backend_key: '',
    backend_features: {},
    backend_connected: false,
  });
  _backendConnected = false;
  elements.backendKey.value = '';
  elements.backendTestResult.classList.add('hidden');
  elements.backendServiceModal.classList.add('hidden');
  updateBackendButtonStatus();
}

function showBackendTestResult(type: string, message: string): void {
  const el = elements.backendTestResult;
  el.classList.remove('hidden', 'loading');
  el.classList.add(type);
  el.textContent = message;
}

async function updateBackendButtonStatus(): Promise<void> {
  const config = await chrome.storage.local.get(['backend_url', 'backend_key', 'backend_connected']);
  const btn = elements.backendServiceBtn;
  btn.classList.remove('backend-connected', 'backend-error');
  if (config.backend_url) {
    if (config.backend_connected || _backendConnected) {
      btn.classList.add('backend-connected');
    } else {
      btn.classList.add('backend-error');
    }
  }
}

async function loadServerBackupLogs(): Promise<void> {
  try {
    const res = await new Promise<any>(r => chrome.runtime.sendMessage({ action: 'getServerBackupLogs' }, (response) => {
      if (chrome.runtime.lastError) { r(null); return; }
      r(response);
    }));
    const logs = res?.logs || [];
    const content = document.getElementById('serverBackupLogContent');
    const empty = document.getElementById('serverBackupLogEmpty');
    if (!content || !empty) return;
    if (logs.length === 0) {
      content.innerHTML = '';
      (empty as HTMLElement).style.display = 'block';
      return;
    }
    (empty as HTMLElement).style.display = 'none';
    content.innerHTML = logs
      .map((log: any) => {
        const date = new Date(log.time);
        const timeStr = date.toLocaleString('zh-CN', { hour12: false });
        const isSuccess = log.status === 'success';
        const bgColor = isSuccess ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)';
        const borderColor = isSuccess ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)';
        return `<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 10px;margin-bottom:6px;border-radius:8px;background:${bgColor};border:1px solid ${borderColor};">
          <span style="font-size:14px;line-height:1.6;">${isSuccess ? '✅' : '❌'}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:2px;">${timeStr}</div>
            <div style="font-size:13px;color:var(--text-color);line-height:1.5;word-break:break-word;">${log.message}</div>
          </div>
        </div>`;
      })
      .join('');
  } catch (err) {
    console.warn('[KnowSeek Settings] loadServerBackupLogs error:', err);
  }
}

async function updateServerBackupStatus(): Promise<void> {
  try {
    const res = await new Promise<any>(r => chrome.runtime.sendMessage({ action: 'getServerBackupStatus' }, (response) => {
      if (chrome.runtime.lastError) { r(null); return; }
      r(response);
    }));
    const el = document.getElementById('serverBackupStatusText');
    if (!el) return;
    if (res && res.enabled) {
      el.textContent = `下次备份: ${res.nextScheduledTimeText || '即将执行'}`;
    } else {
      el.textContent = '定时备份未设置';
    }
  } catch (err) {
    console.warn('[KnowSeek Settings] getServerBackupStatus error:', err);
  }
}

// ── WebDAV / GitHub 存储配置 ──
async function openGithubStorageConfig(): Promise<void> {
  const config = await chrome.storage.sync.get([
    'webdavUrl',
    'webdavUsername',
    'webdavPassword',
    'webdavDir',
    'webdavFilename',
    'backupEnabled',
    'backupTime',
  ]);

  elements.webdavUrl.value = config.webdavUrl || '';
  elements.webdavUsername.value = config.webdavUsername || '';
  elements.webdavPassword.value = config.webdavPassword || '';
  elements.webdavDir.value = config.webdavDir || 'KnowSeek';
  elements.webdavFilename.value = config.webdavFilename || 'backup.zip';
  elements.backupEnabled.checked = config.backupEnabled || false;
  elements.backupTime.value = config.backupTime || '03:00';

  elements.githubStorageModal.classList.remove('hidden');
  renderBackupStatus();
  renderBackupLogs();
  renderNextBackupTime();
}

async function saveGithubStorageConfig(): Promise<void> {
  const webdavUrl = elements.webdavUrl.value.trim().replace(/\/$/, '');
  const webdavUsername = elements.webdavUsername.value.trim();
  const webdavPassword = elements.webdavPassword.value;
  const webdavDir = elements.webdavDir.value.trim().replace(/^\/+|\/+$/g, '');
  const webdavFilename = elements.webdavFilename.value.trim() || 'backup.zip';
  const backupEnabled = elements.backupEnabled.checked;

  if (backupEnabled && (!webdavUrl || !webdavUsername || !webdavPassword)) {
    alert('请填写完整的 WebDAV 配置信息');
    return;
  }

  try {
    await chrome.storage.sync.set({
      webdavUrl: webdavUrl || null,
      webdavUsername: webdavUsername || null,
      webdavPassword: webdavPassword || null,
      webdavDir: webdavDir || null,
      webdavFilename: webdavFilename,
      backupEnabled: backupEnabled,
      backupInterval: backupEnabled ? 24 : null,
      backupTime: backupEnabled ? elements.backupTime.value || null : null,
    });

    chrome.runtime.sendMessage({ action: 'updateBackupAlarm' }, () => {
      if (chrome.runtime.lastError) { /* 忽略 */ }
      renderNextBackupTime();
    });

    elements.githubStorageModal.classList.add('hidden');
    alert('配置已保存！');

    if (backupEnabled && webdavUrl && webdavUsername && webdavPassword && !elements.backupTime.value) {
      chrome.runtime.sendMessage({ action: 'backupNow' }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
    }
  } catch (error) {
    alert('保存配置失败：' + (error as Error).message);
  }
}

// ── 备份操作 ──
async function triggerBackup(): Promise<void> {
  try {
    await new Promise<void>(r => chrome.runtime.sendMessage({ action: 'backupNow' }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } r(); }));
    const result = await chrome.storage.local.get(STORAGE_KEYS.BACKUP_LOGS);
    updateBackupLogs(result[STORAGE_KEYS.BACKUP_LOGS] || []);
    renderBackupStatus();
    if (!elements.githubStorageModal.classList.contains('hidden')) {
      renderBackupLogs();
    }
  } catch (error) {
    console.error('[KnowSeek Settings] Backup trigger failed:', error);
  }
}

async function manualTriggerBackup(): Promise<void> {
  setBackupLoading(true);
  await triggerBackup();
  setBackupLoading(false);
  renderBackupLogs();
}

async function overwriteFromBackup(): Promise<void> {
  if (!confirm('该操作会导致本地的数据被清除，且会加载 WebDAV 里面最新的备份数据，是否继续？')) {
    return;
  }

  setOverwriteLoading(true);

  const config = await chrome.storage.sync.get([
    'webdavUrl',
    'webdavUsername',
    'webdavPassword',
    'webdavDir',
    'webdavFilename',
  ]);

  if (!config.webdavUrl || !config.webdavUsername || !config.webdavPassword) {
    alert('请先配置 WebDAV');
    setOverwriteLoading(false);
    return;
  }

  let downloadUrl = config.webdavUrl.trim();
  if (!downloadUrl.endsWith('/')) downloadUrl += '/';
  const dir = config.webdavDir ? (config.webdavDir as string).replace(/^\/|\/$/g, '') : '';
  if (dir) downloadUrl += dir + '/';
  downloadUrl += config.webdavFilename;

  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', downloadUrl, true);
      xhr.setRequestHeader('Authorization', `Basic ${btoa(`${config.webdavUsername}:${config.webdavPassword}`)}`);
      xhr.responseType = 'blob';
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.response);
        } else if (xhr.status === 404) {
          reject(new Error('备份文件不存在'));
        } else {
          reject(new Error(`下载失败 (HTTP ${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error('网络连接失败'));
      xhr.ontimeout = () => reject(new Error('连接超时，请检查网络或稍后重试'));
      xhr.timeout = 300000;
      xhr.send();
    });

    const zip = await JSZip.loadAsync(blob);
    let data: any = {};
    const opfsFiles: Record<string, Blob> = {};
    const chatImages: Record<string, Blob> = {};

    const recordsEntry = zip.file('records.json');
    if (recordsEntry) {
      Object.assign(data, JSON.parse(await recordsEntry.async('string')));
      const configEntry = zip.file('config.json');
      if (configEntry) Object.assign(data, JSON.parse(await configEntry.async('string')));
      const chatEntry = zip.file('chat.json');
      if (chatEntry) {
        const chatData = JSON.parse(await chatEntry.async('string'));
        data.chat_sessions = chatData.sessions;
        data.chat_active_session_id = chatData.active_session_id;
      }
      const logsEntry = zip.file('logs.json');
      if (logsEntry) {
        data.backup_logs = JSON.parse(await logsEntry.async('string')).backup_logs;
      }
      for (const [name, entry] of Object.entries(zip.files)) {
        if (!entry.dir && (name.startsWith('annotations/snapshots/') || name.startsWith('snapshots/'))) {
          opfsFiles[name.replace(/^(annotations\/)?snapshots\//, '')] = await entry.async('blob');
        }
        if (!entry.dir && name.startsWith('chat/frames/')) {
          opfsFiles[name.replace('chat/frames/', '')] = await entry.async('blob');
        }
        if (!entry.dir && (name.startsWith('chat/images/') || name.startsWith('chat_images/'))) {
          chatImages[name.replace(/^chat\/images\//, '').replace(/^chat_images\//, '')] = await entry.async('blob');
        }
      }
    } else {
      const dataFile = zip.file('data.json');
      if (!dataFile) {
        alert('备份文件中未找到数据文件，请检查备份是否完整');
        setOverwriteLoading(false);
        return;
      }
      data = JSON.parse(await dataFile.async('text'));
      for (const [name, entry] of Object.entries(zip.files)) {
        if (name.startsWith('snapshots/') && !entry.dir) {
          opfsFiles[name.replace('snapshots/', '')] = await entry.async('blob');
        }
        if (name.startsWith('chat_images/') && !entry.dir) {
          chatImages[name.replace('chat_images/', '')] = await entry.async('blob');
        }
      }
    }

    updateRecords(Array.isArray(data.records) ? data.records : []);
    updateTags(Array.isArray(data.tags) ? data.tags : []);
    updateMarkTags(Array.isArray(data.mark_tags) ? data.mark_tags : []);
    updateSavedRecordOrder(Array.isArray(data.saved_record_order) ? data.saved_record_order : []);

    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      [STORAGE_KEYS.RECORDS]: records,
      [STORAGE_KEYS.TAGS]: tags,
      [STORAGE_KEYS.MARK_TAGS]: markTags,
      record_order: savedRecordOrder,
    });
    if (data.color_config) {
      await chrome.storage.local.set({ [STORAGE_KEYS.COLOR_CONFIG]: data.color_config });
    }
    if (data.ai_providers) {
      updateAiProviders(data.ai_providers);
      await chrome.storage.local.set({ ai_providers: aiProviders });
    }
    if (data.ai_active_provider) {
      updateActiveProviderId(data.ai_active_provider);
      await chrome.storage.local.set({ ai_active_provider: activeProviderId });
    }
    if (data.backend_url !== undefined || data.backend_key !== undefined) {
      const backendItems: any = {};
      if (data.backend_url !== undefined) backendItems.backend_url = data.backend_url;
      if (data.backend_key !== undefined) backendItems.backend_key = data.backend_key;
      await chrome.storage.local.set(backendItems);
    }
    if (data.backup_logs) {
      updateBackupLogs(data.backup_logs);
      await chrome.storage.local.set({ [STORAGE_KEYS.BACKUP_LOGS]: backupLogs });
    }

    if (data.chat_sessions) {
      const restoredSessions: any = {};
      // chat_sessions 可能是数组或对象，统一用 session.id 作为 key
      const sessions = Array.isArray(data.chat_sessions)
        ? data.chat_sessions
        : Object.values(data.chat_sessions);
      for (const session of sessions) {
        const sid = (session as any).id || crypto.randomUUID();
        const restoredMessages = await Promise.all(
          ((session as any).messages || []).map(async (msg: any) => {
            const restored = { ...msg };
            if (restored.images && Array.isArray(restored.images)) {
              restored.images = await Promise.all(
                restored.images.map(async (img: string) => {
                  if (typeof img === 'string' && img.startsWith('[base64-image:')) {
                    const fname = img.slice('[base64-image:'.length, -1);
                    const blob = chatImages[fname];
                    if (blob) {
                      return new Promise<string>((resolve) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result as string);
                        reader.onerror = () => resolve(img);
                        reader.readAsDataURL(blob);
                      });
                    }
                  }
                  return img;
                })
              );
            }
            return restored;
          })
        );
        restoredSessions[sid] = { ...(session as any), messages: restoredMessages };
      }
      await chrome.storage.local.set({ chat_sessions: restoredSessions });
    }
    if (data.chat_active_session_id) {
      await chrome.storage.local.set({ chat_active_session_id: data.chat_active_session_id });
    }

    if (data.webdav) {
      await chrome.storage.sync.set({
        webdavUrl: data.webdav.url || '',
        webdavUsername: data.webdav.username || '',
        webdavPassword: data.webdav.password || '',
        webdavDir: data.webdav.dir || 'KnowSeek',
        webdavFilename: data.webdav.filename || 'backup.zip',
        backupEnabled: data.webdav.backup_enabled || false,
        backupTime: data.webdav.backup_time || '03:00',
      });
    }

    if (Object.keys(opfsFiles).length > 0) {
      const root = await navigator.storage.getDirectory();
      try { await root.removeEntry('snapshots', { recursive: true }); } catch (e) {}
      try { await root.removeEntry('chat', { recursive: true }); } catch (e) {}
      const snapDir = await root.getDirectoryHandle('snapshots', { create: true });
      for (const [name, blob] of Object.entries(opfsFiles)) {
        try {
          const fh = await snapDir.getFileHandle(name, { create: true });
          const w = await fh.createWritable();
          await w.write(blob);
          await w.close();
        } catch (e) {
          console.warn('[KnowSeek Settings] 写入 OPFS 文件失败:', name, e);
        }
      }
    }

    refreshRecords();
    refreshChatModelSwitcher();
    elements.githubStorageModal.classList.add('hidden');
    setOverwriteLoading(false);
    renderProviderList();
    renderBackupStatus();
    await addBackupLog('success', '覆盖本地成功');
    alert(`已从 WebDAV 覆盖本地数据！\n记录：${records.length} 条\n标签：${tags.length} 个`);
  } catch (error) {
    console.error('[KnowSeek Settings] 覆盖本地失败:', error);
    setOverwriteLoading(false);
    await addBackupLog('error', `覆盖本地失败: ${(error as Error).message}`);
    alert('覆盖失败：' + (error as Error).message);
  }
}

async function restoreFromServerBackup(blob: Blob): Promise<void> {
  let data: any = {};
  const opfsFiles: Record<string, Blob> = {};
  const chatImages: Record<string, Blob> = {};

  const zip = await JSZip.loadAsync(blob);
  const recordsEntry = zip.file('records.json');
  if (recordsEntry) {
    Object.assign(data, JSON.parse(await recordsEntry.async('string')));
    const configEntry = zip.file('config.json');
    if (configEntry) Object.assign(data, JSON.parse(await configEntry.async('string')));
    const chatEntry = zip.file('chat.json');
    if (chatEntry) {
      const chatData = JSON.parse(await chatEntry.async('string'));
      data.chat_sessions = chatData.sessions;
      data.chat_active_session_id = chatData.active_session_id;
    }
    const logsEntry = zip.file('logs.json');
    if (logsEntry) data.backup_logs = JSON.parse(await logsEntry.async('string')).backup_logs;
    for (const [name, entry] of Object.entries(zip.files)) {
      if (!entry.dir && (name.startsWith('annotations/snapshots/') || name.startsWith('snapshots/'))) {
        opfsFiles[name.replace(/^(annotations\/)?snapshots\//, '')] = await entry.async('blob');
      }
      if (!entry.dir && name.startsWith('chat/frames/')) {
        opfsFiles[name.replace('chat/frames/', '')] = await entry.async('blob');
      }
      if (!entry.dir && (name.startsWith('chat/images/') || name.startsWith('chat_images/'))) {
        chatImages[name.replace(/^chat\/images\//, '').replace(/^chat_images\//, '')] = await entry.async('blob');
      }
    }
  } else {
    const dataFile = zip.file('data.json');
    if (!dataFile) throw new Error('备份文件中未找到数据文件');
    data = JSON.parse(await dataFile.async('text'));
    for (const [name, entry] of Object.entries(zip.files)) {
      if (name.startsWith('snapshots/') && !entry.dir) opfsFiles[name.replace('snapshots/', '')] = await entry.async('blob');
      if (name.startsWith('chat_images/') && !entry.dir) chatImages[name.replace('chat_images/', '')] = await entry.async('blob');
    }
  }

  const parsedRecords = Array.isArray(data.records) ? data.records : [];
  const parsedTags = Array.isArray(data.tags) ? data.tags : [];
  const parsedMarkTags = Array.isArray(data.mark_tags) ? data.mark_tags : [];
  const parsedRecordOrder = Array.isArray(data.saved_record_order) ? data.saved_record_order : [];

  if (parsedRecords.length === 0 && parsedTags.length === 0 && parsedMarkTags.length === 0 && (!data.chat_sessions || Object.keys(data.chat_sessions).length === 0)) {
    throw new Error('备份文件未包含有效数据（标注、标签、聊天均为空）');
  }

  if (!confirm(`即将从服务器备份恢复 ${parsedRecords.length} 条记录、${parsedTags.length} 个标签${data.chat_sessions ? '、' + Object.keys(data.chat_sessions).length + ' 个聊天会话' : ''}，当前本地数据将被覆盖。是否继续？`)) {
    return;
  }

  await chrome.storage.local.clear();
  await chrome.storage.local.set({
    [STORAGE_KEYS.RECORDS]: parsedRecords,
    [STORAGE_KEYS.TAGS]: parsedTags,
    [STORAGE_KEYS.MARK_TAGS]: parsedMarkTags,
    record_order: parsedRecordOrder,
  });

  updateRecords(parsedRecords);
  updateTags(parsedTags);
  updateMarkTags(parsedMarkTags);
  updateSavedRecordOrder(parsedRecordOrder);

  if (data.color_config) await chrome.storage.local.set({ [STORAGE_KEYS.COLOR_CONFIG]: data.color_config });
  if (data.ai_providers) { updateAiProviders(data.ai_providers); await chrome.storage.local.set({ ai_providers: aiProviders }); }
  if (data.ai_active_provider) { updateActiveProviderId(data.ai_active_provider); await chrome.storage.local.set({ ai_active_provider: activeProviderId }); }
  if (data.backend_url !== undefined || data.backend_key !== undefined) {
    const items: any = {};
    if (data.backend_url !== undefined) items.backend_url = data.backend_url;
    if (data.backend_key !== undefined) items.backend_key = data.backend_key;
    await chrome.storage.local.set(items);
  }
  if (data.backup_logs) { updateBackupLogs(data.backup_logs); await chrome.storage.local.set({ [STORAGE_KEYS.BACKUP_LOGS]: backupLogs }); }

  if (data.chat_sessions) {
    const restored: any = {};
    // chat_sessions 可能是数组或对象，统一用 session.id 作为 key
    const sessions = Array.isArray(data.chat_sessions)
      ? data.chat_sessions
      : Object.values(data.chat_sessions);
    for (const session of sessions) {
      const sid = (session as any).id || crypto.randomUUID();
      const msgs = await Promise.all(
        ((session as any).messages || []).map(async (msg: any) => {
          const m = { ...msg };
          if (m.images && Array.isArray(m.images)) {
            m.images = await Promise.all(
              m.images.map(async (img: string) => {
                if (typeof img === 'string' && img.startsWith('[base64-image:')) {
                  const fname = img.slice('[base64-image:'.length, -1);
                  const b = chatImages[fname];
                  if (b) {
                    return new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(b); });
                  }
                }
                return img;
              })
            );
          }
          return m;
        })
      );
      restored[sid] = { ...(session as any), messages: msgs };
    }
    await chrome.storage.local.set({ chat_sessions: restored });
  }
  if (data.chat_active_session_id) { await chrome.storage.local.set({ chat_active_session_id: data.chat_active_session_id }); }

  if (data.webdav) {
    await chrome.storage.sync.set({
      webdavUrl: data.webdav.url || '',
      webdavUsername: data.webdav.username || '',
      webdavPassword: data.webdav.password || '',
      webdavDir: data.webdav.dir || 'KnowSeek',
      webdavFilename: data.webdav.filename || 'backup.zip',
      backupEnabled: data.webdav.backup_enabled || false,
      backupTime: data.webdav.backup_time || '03:00',
    });
  }

  if (Object.keys(opfsFiles).length > 0) {
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry('snapshots', { recursive: true }); } catch (e) {}
    try { await root.removeEntry('chat', { recursive: true }); } catch (e) {}
    const snapDir = await root.getDirectoryHandle('snapshots', { create: true });
    for (const [name, b] of Object.entries(opfsFiles)) {
      try { const fh = await snapDir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(b); await w.close(); } catch (e) {
        console.warn('[KnowSeek Settings] OPFS写入失败:', name, e);
      }
    }
  }

  refreshRecords();
  refreshChatModelSwitcher();
  renderProviderList();
  renderBackupStatus();

  const logEntry = { time: Date.now(), status: 'success', message: '从服务器备份恢复成功' };
  const existLogs = (await chrome.storage.local.get('server_backup_logs')).server_backup_logs || [];
  existLogs.push(logEntry);
  await chrome.storage.local.set({ server_backup_logs: existLogs });

  alert(`已从服务器备份恢复数据！\n记录：${records.length} 条\n标签：${tags.length} 个`);
}

function openServerBackupLog(): void {
  loadServerBackupLogs();
  document.getElementById('serverBackupLogModal')?.classList.remove('hidden');
}

async function manualServerBackup(): Promise<void> {
  const btn = document.getElementById('serverBackupManualBtn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.textContent = '⏳ 备份中...';
  btn.disabled = true;
  try {
    await new Promise<void>(r => chrome.runtime.sendMessage({ action: 'serverBackupNow' }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } r(); }));
    btn.textContent = '✅ 备份完成';
    setTimeout(() => { btn.textContent = '💾 立即备份'; btn.disabled = false; }, 2000);
    updateServerBackupStatus();
  } catch {
    btn.textContent = '💾 立即备份';
    btn.disabled = false;
  }
}

async function restoreLatestServerBackup(): Promise<void> {
  const config = await chrome.storage.local.get(['backend_url', 'backend_key']);
  if (!config.backend_url) {
    alert('请先配置后端服务地址');
    return;
  }
  const btn = document.getElementById('serverRestoreBtn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.textContent = '⏳ 下载中...';
  btn.disabled = true;
  try {
    const baseUrl = (config.backend_url as string).replace(/\/+$/, '');
    const listResp = await fetch(baseUrl + '/api/backup/list', {
      headers: { Authorization: `Bearer ${config.backend_key || ''}` },
    });
    if (!listResp.ok) throw new Error('获取备份列表失败 (HTTP ' + listResp.status + ')');
    const listData = await listResp.json();
    const backups = listData.data?.backups || [];
    if (backups.length === 0) { alert('服务器上没有备份文件'); return; }
    const latest = backups[backups.length - 1];
    btn.textContent = '⏳ 下载备份...';
    const dlResp = await fetch(baseUrl + '/api/backup/download/' + encodeURIComponent(latest.filename), {
      headers: { Authorization: `Bearer ${config.backend_key || ''}` },
    });
    if (!dlResp.ok) throw new Error('下载备份失败 (HTTP ' + dlResp.status + ')');
    const blob = await dlResp.blob();
    btn.textContent = '⏳ 恢复中...';
    await restoreFromServerBackup(blob);
    btn.textContent = '✅ 恢复完成';
    setTimeout(() => { btn.textContent = '🔄 立即覆盖'; btn.disabled = false; }, 2000);
  } catch (err) {
    alert('覆盖失败：' + (err as Error).message);
    btn.textContent = '🔄 立即覆盖';
    btn.disabled = false;
  }
}

async function addBackupLog(status: 'success' | 'error', message: string): Promise<void> {
  const log: BackupLog = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
    status,
    message,
    time: Date.now(),
  };
  const logs = [log, ...backupLogs].slice(0, 50);
  updateBackupLogs(logs);
  await chrome.storage.local.set({ [STORAGE_KEYS.BACKUP_LOGS]: logs });
  renderBackupStatus();
  if (!elements.githubStorageModal.classList.contains('hidden')) {
    renderBackupLogs();
  }
  showBackupToast(status, message);
}

function renderBackupStatus(): void {
  const el = elements.backupStatus;
  if (!el) return;
  const lastLog = backupLogs[0];
  if (!lastLog) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const isSuccess = lastLog.status === 'success';
  const timeStr = new Date(lastLog.time).toLocaleString('zh-CN');
  el.className = 'backup-status ' + (isSuccess ? 'backup-status-success' : 'backup-status-error');
  el.innerHTML = `
    <span class="backup-status-icon">${isSuccess ? '✓' : '✕'}</span>
    <span class="backup-status-text">${isSuccess ? '上次备份成功' : '上次备份失败'} · ${timeStr}</span>
  `;
}

async function renderNextBackupTime(): Promise<void> {
  const el = elements.nextBackupTime;
  if (!el) return;
  try {
    const result = await new Promise<any>(r => chrome.runtime.sendMessage({ action: 'getBackupAlarmStatus' }, (response) => {
      if (chrome.runtime.lastError) { r(null); return; }
      r(response);
    }));
    if (result && result.enabled && result.nextScheduledTimeText) {
      el.textContent = '下次定时备份：' + result.nextScheduledTimeText;
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  } catch (e) {
    el.classList.add('hidden');
  }
}

function setBackupLoading(loading: boolean): void {
  const btn = elements.triggerBackupBtn;
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.innerHTML = '<span style="display:inline-block;animation:spin 1s linear infinite;">⟳</span> 备份中...';
  } else {
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align:middle;margin-right:4px;"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg> 立即备份';
  }
}

function setOverwriteLoading(loading: boolean): void {
  const btn = elements.overwriteLocalBtn;
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.innerHTML = '<span style="display:inline-block;animation:spin 1s linear infinite;">⟳</span> 覆盖中...';
  } else {
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align:middle;margin-right:4px;"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg> 覆盖本地';
  }
}

function renderBackupLogs(): void {
  const container = elements.backupLogList;
  const content = elements.backupLogContent;
  if (!container || !content) return;

  if (backupLogs.length === 0) {
    content.innerHTML = '<div class="backup-log-empty">暂无备份记录</div>';
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  content.innerHTML = backupLogs
    .map((log) => {
      const timeStr = new Date(log.time).toLocaleString('zh-CN');
      const isSuccess = log.status === 'success';
      return `<div class="backup-log-item ${isSuccess ? 'backup-log-item-success' : 'backup-log-item-error'}">
        <span class="backup-log-icon">${isSuccess ? '✓' : '✕'}</span>
        <span class="backup-log-msg">${log.message}</span>
        <span class="backup-log-time">${timeStr}</span>
      </div>`;
    })
    .join('');
}

function showBackupToast(status: string, message: string): void {
  const old = document.querySelector('.backup-toast');
  if (old) old.remove();

  const toast = document.createElement('div');
  toast.className = 'backup-toast ' + (status === 'success' ? 'backup-toast-success' : 'backup-toast-error');
  toast.innerHTML = `<span class="backup-toast-icon">${status === 'success' ? '✓' : '✕'}</span><span>${message}</span>`;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('backup-toast-hide');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

async function clearBackupLogs(): Promise<void> {
  if (!confirm('确定要清空所有备份日志吗？')) return;
  updateBackupLogs([]);
  await chrome.storage.local.set({ [STORAGE_KEYS.BACKUP_LOGS]: backupLogs });
  renderBackupStatus();
  renderBackupLogs();
}

// ── 导入导出 ──
async function exportData(): Promise<void> {
  const colorConfig = await chrome.storage.local.get(STORAGE_KEYS.COLOR_CONFIG);
  const allColorConfig = colorConfig[STORAGE_KEYS.COLOR_CONFIG] || null;
  const zip = new JSZip();

  const cleanRecords = records.map((r: any) => {
    const clean = { ...r };
    if (clean.snapshot && typeof clean.snapshot === 'string' && clean.snapshot.startsWith('data:')) {
      clean.snapshot = '';
    }
    if (clean.text && typeof clean.text === 'string' && clean.text.startsWith('data:image/') && clean.videoTimestamp !== undefined) {
      clean.text = '[base64-image]';
    }
    if (clean.description) {
      clean.description = clean.description.replace(/data:image\/[^;]+;base64,[^\s'"]+/g, '[base64-image]');
    }
    return clean;
  });

  const [otherConfig, syncConfig] = await Promise.all([
    chrome.storage.local.get([
      'backend_url', 'backend_key',
      'chat_sessions', 'chat_active_session_id',
      'backup_logs',
      'ai_active_provider'
    ]),
    chrome.storage.sync.get([
      'webdavUrl', 'webdavUsername', 'webdavPassword', 'webdavDir', 'webdavFilename',
      'backupEnabled', 'backupTime'
    ]),
  ]);

  const cleanChatSessions: any = {};
  let chatImageIndex = 0;
  if (otherConfig.chat_sessions) {
    // chat_sessions 可能是数组（chat.ts 以数组格式存储）或对象，统一转为 id-keyed 对象
    const sessions = Array.isArray(otherConfig.chat_sessions)
      ? otherConfig.chat_sessions
      : Object.values(otherConfig.chat_sessions);
    for (const session of sessions) {
      const sid = (session as any).id || crypto.randomUUID();
      const cleanMessages = ((session as any).messages || []).map((msg: any) => {
        const clean = { ...msg };
        if (clean.images && Array.isArray(clean.images)) {
          clean.images = clean.images.map((img: string) => {
            if (typeof img === 'string' && img.startsWith('data:')) {
              const ext = img.startsWith('data:image/png') ? 'png' : 'jpg';
              const fname = `chat_img_${chatImageIndex}.${ext}`;
              chatImageIndex++;
              const base64Data = img.split(',')[1];
              try {
                const binaryStr = atob(base64Data);
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
                zip.file(`chat/images/${fname}`, bytes);
              } catch (e) {
                console.warn('[KnowSeek Settings] Failed to save chat image to zip:', e);
              }
              return `[base64-image:${fname}]`;
            }
            return img;
          });
        }
        return clean;
      });
      cleanChatSessions[sid] = { ...(session as any), messages: cleanMessages };
    }
  }

  zip.file('records.json', JSON.stringify({
    version: '2.0.0',
    exported_at: Date.now(),
    records: cleanRecords,
    tags,
    mark_tags: markTags,
    color_config: allColorConfig,
    saved_record_order: savedRecordOrder,
    filter_tab_order: Array.from(document.querySelectorAll('.filter-tab')).map((t) => (t as HTMLElement).dataset.filter),
    domain_order: Array.from(document.querySelectorAll(':scope > [data-node-type="domain"]')).map((n) => (n as HTMLElement).dataset.nodeId),
  }, null, 2));

  const embeddingConfig = await chrome.storage.local.get('_embeddingConfig');

  zip.file('config.json', JSON.stringify({
    version: '2.0.0',
    exported_at: Date.now(),
    ai_providers: aiProviders,
    ai_active_provider: otherConfig.ai_active_provider || '',
    backend_url: otherConfig.backend_url || '',
    backend_key: otherConfig.backend_key || '',
    embedding_config: embeddingConfig._embeddingConfig || null,
    webdav: {
      url: syncConfig.webdavUrl || '',
      username: syncConfig.webdavUsername || '',
      password: syncConfig.webdavPassword || '',
      dir: syncConfig.webdavDir || 'KnowSeek',
      filename: syncConfig.webdavFilename || 'backup.zip',
      backup_enabled: syncConfig.backupEnabled || false,
      backup_time: syncConfig.backupTime || '03:00'
    }
  }, null, 2));

  zip.file('chat.json', JSON.stringify({
    version: '2.0.0',
    exported_at: Date.now(),
    sessions: cleanChatSessions,
    active_session_id: otherConfig.chat_active_session_id || ''
  }, null, 2));

  zip.file('logs.json', JSON.stringify({
    version: '2.0.0',
    exported_at: Date.now(),
    backup_logs: otherConfig.backup_logs || []
  }, null, 2));

  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('snapshots');
    for await (const entry of dir.values()) {
      if (entry.kind !== 'file') continue;
      if (!entry.name.endsWith('.png') && !entry.name.endsWith('.jpg')) continue;
      const file = await entry.getFile();
      const buffer = await file.arrayBuffer();
      if (entry.name.startsWith('chat_frame_')) {
        zip.file(`chat/frames/${entry.name}`, buffer);
      } else {
        zip.file(`annotations/snapshots/${entry.name}`, buffer);
      }
    }
  } catch (e) {
    // snapshots 目录可能不存在
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `知寻-export-${formatDateForFilename()}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function exportToObsidian(): Promise<void> {
  if (records.length === 0) {
    alert('暂无可导出的标注');
    return;
  }

  const tagMap: Record<string, string[]> = {};
  for (const mt of markTags) {
    const tag = tags.find((t: any) => t.id === mt.tag_id);
    if (tag && tag.name) {
      if (!tagMap[mt.mark_id]) tagMap[mt.mark_id] = [];
      tagMap[mt.mark_id].push(tag.name);
    }
  }

  const urlGroups: Record<string, any> = {};
  for (const record of records) {
    const key = record.url || '未知来源';
    if (!urlGroups[key]) {
      urlGroups[key] = { title: record.page_title || key, url: key, records: [] };
    }
    urlGroups[key].records.push(record);
  }

  const zip = new JSZip();
  for (const [url, group] of Object.entries(urlGroups)) {
    const allTags = new Set<string>();
    let earliestTs = Infinity;

    let md = '---\n';
    md += `url: "${url}"\n`;
    md += `title: "${(group.title || url).replace(/"/g, '\\"')}"\n`;
    md += `source: "${url}"\n`;

    for (const record of group.records) {
      const recordTags = tagMap[record.id] || [];
      recordTags.forEach((t) => allTags.add(t));
      if (record.created_at && record.created_at < earliestTs) earliestTs = record.created_at;
    }

    if (allTags.size > 0) {
      const tagsArr = Array.from(allTags).map((t) => t.replace(/\s+/g, '-'));
      md += `tags:\n${tagsArr.map((t) => `  - ${t}`).join('\n')}\n`;
    }
    if (earliestTs !== Infinity) {
      const d = new Date(earliestTs);
      md += `created: ${d.toISOString().split('T')[0]}\n`;
    }
    md += '---\n\n';
    md += `> 来源: [${group.title}](${url})\n\n`;
    md += `---\n\n`;

    const sorted = [...group.records].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    for (const record of sorted) {
      const recordTags = tagMap[record.id] || [];
      if (record.text) {
        md += `> ${record.text.replace(/\n/g, '\n> ')}\n\n`;
      }
      if (record.description) {
        md += `${record.description}\n\n`;
      }
      const parts = [];
      if (recordTags.length > 0) {
        parts.push(recordTags.map((t) => `#${t.replace(/\s+/g, '-')}`).join(' '));
      }
      if (record.created_at) {
        parts.push(formatDate(record.created_at));
      }
      if (parts.length > 0) {
        md += `*${parts.join(' · ')}*\n\n`;
      }
      md += `---\n\n`;
    }

    const safeName = (group.title || url)
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .substring(0, 100) || 'untitled';
    zip.file(`${safeName}.md`, md);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const urlObj = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = urlObj;
  a.download = `知寻-Obsidian-${formatDateForFilename()}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(urlObj);

  alert('导出 Obsidian 成功！下载后解压到 Obsidian Vault 即可使用');
}

function openImportDialog(): void {
  showImportConfirmDialog(() => elements.importFile.click());
}

async function importData(e: Event): Promise<void> {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;

  try {
    let data: any = null;
    const opfsFiles: Record<string, Blob> = {};
    const chatImages: Record<string, Blob> = {};

    if (file.name.endsWith('.zip')) {
      const zip = await JSZip.loadAsync(file);
      data = {};
      const recordsEntry = zip.file('records.json');
      if (recordsEntry) {
        Object.assign(data, JSON.parse(await recordsEntry.async('string')));
        const configEntry = zip.file('config.json');
        if (configEntry) Object.assign(data, JSON.parse(await configEntry.async('string')));
        const chatEntry = zip.file('chat.json');
        if (chatEntry) {
          const chatData = JSON.parse(await chatEntry.async('string'));
          data.chat_sessions = chatData.sessions;
          data.chat_active_session_id = chatData.active_session_id;
        }
        const logsEntry = zip.file('logs.json');
        if (logsEntry) {
          data.backup_logs = JSON.parse(await logsEntry.async('string')).backup_logs;
        }
      } else {
        const dataEntry = zip.file('data.json');
        if (!dataEntry) throw new Error('ZIP 文件中缺少数据文件');
        data = JSON.parse(await dataEntry.async('string'));
      }

      for (const [name, entry] of Object.entries(zip.files)) {
        if (!entry.dir && (name.startsWith('annotations/snapshots/') || name.startsWith('snapshots/'))) {
          opfsFiles[name.replace(/^(annotations\/)?snapshots\//, '')] = await entry.async('blob');
        }
        if (!entry.dir && (name.startsWith('chat/images/') || name.startsWith('chat_images/'))) {
          chatImages[name.replace(/^chat\/images\//, '').replace(/^chat_images\//, '')] = await entry.async('blob');
        }
        if (!entry.dir && name.startsWith('chat/frames/')) {
          opfsFiles[name.replace('chat/frames/', '')] = await entry.async('blob');
        }
      }
    } else {
      const text = await file.text();
      data = JSON.parse(text);
      if (data.opfs_snapshots) {
        for (const [name, dataUrl] of Object.entries(data.opfs_snapshots)) {
          const response = await fetch(dataUrl as string);
          opfsFiles[name] = await response.blob();
        }
      }
    }

    updateRecords(Array.isArray(data.records) ? data.records : []);
    updateTags(Array.isArray(data.tags) ? data.tags : []);
    updateMarkTags(Array.isArray(data.mark_tags) ? data.mark_tags : []);
    updateSavedRecordOrder(Array.isArray(data.saved_record_order) ? data.saved_record_order : []);

    await chrome.storage.local.set({
      [STORAGE_KEYS.RECORDS]: records,
      [STORAGE_KEYS.TAGS]: tags,
      [STORAGE_KEYS.MARK_TAGS]: markTags,
    });

    if (data.domain_order) {
      chrome.storage.local.set({ domain_order: data.domain_order }).catch(() => {});
    }
    if (data.filter_tab_order) {
      chrome.storage.local.set({ filter_tab_order: data.filter_tab_order }).catch(() => {});
    }
    if (data.saved_record_order) {
      chrome.storage.local.set({ record_order: data.saved_record_order }).catch(() => {});
    }

    if (data.color_config) {
      await chrome.storage.local.set({ [STORAGE_KEYS.COLOR_CONFIG]: data.color_config });
    }
    if (data.ai_providers) {
      updateAiProviders(data.ai_providers);
      await chrome.storage.local.set({ ai_providers: aiProviders });
      renderProviderList();
      refreshChatModelSwitcher();
    }
    if (data.ai_active_provider) {
      updateActiveProviderId(data.ai_active_provider);
      await chrome.storage.local.set({ ai_active_provider: activeProviderId });
      refreshChatModelSwitcher();
    }
    if (data.embedding_config) {
      await chrome.storage.local.set({ _embeddingConfig: data.embedding_config });
    }

    const backendItems: any = {};
    if (data.backend_url !== undefined) backendItems.backend_url = data.backend_url;
    if (data.backend_key !== undefined) backendItems.backend_key = data.backend_key;
    if (Object.keys(backendItems).length > 0) {
      await chrome.storage.local.set(backendItems);
    }

    if (data.webdav) {
      await chrome.storage.sync.set({
        webdavUrl: data.webdav.url || '',
        webdavUsername: data.webdav.username || '',
        webdavPassword: data.webdav.password || '',
        webdavDir: data.webdav.dir || 'KnowSeek',
        webdavFilename: data.webdav.filename || 'backup.zip',
        backupEnabled: data.webdav.backup_enabled || false,
        backupTime: data.webdav.backup_time || '03:00'
      });
    }

    if (data.chat_sessions) {
      const restoredSessions: any = {};
      // chat_sessions 可能是数组或对象，统一用 session.id 作为 key
      const sessions = Array.isArray(data.chat_sessions)
        ? data.chat_sessions
        : Object.values(data.chat_sessions);
      for (const session of sessions) {
        const sid = (session as any).id || crypto.randomUUID();
        const restoredMessages = await Promise.all(
          ((session as any).messages || []).map(async (msg: any) => {
            const restored = { ...msg };
            if (restored.images && Array.isArray(restored.images)) {
              restored.images = await Promise.all(
                restored.images.map(async (img: string) => {
                  if (typeof img === 'string' && img.startsWith('[base64-image:')) {
                    const fname = img.slice('[base64-image:'.length, -1);
                    const blob = chatImages[fname];
                    if (blob) {
                      return new Promise<string>((resolve) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result as string);
                        reader.readAsDataURL(blob);
                      });
                    }
                  }
                  return img;
                })
              );
            }
            return restored;
          })
        );
        restoredSessions[sid] = { ...(session as any), messages: restoredMessages };
      }
      await chrome.storage.local.set({ chat_sessions: restoredSessions });
    }
    if (data.chat_active_session_id) {
      await chrome.storage.local.set({ chat_active_session_id: data.chat_active_session_id });
    }

    if (data.backup_logs) {
      updateBackupLogs(data.backup_logs);
      await chrome.storage.local.set({ [STORAGE_KEYS.BACKUP_LOGS]: backupLogs });
    }

    if (Object.keys(opfsFiles).length > 0) {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('snapshots', { create: true });
      for (const [name, blob] of Object.entries(opfsFiles)) {
        try {
          const fileHandle = await dir.getFileHandle(name, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
        } catch (e) {
          console.warn(`[KnowSeek Settings] 写入 OPFS 截图失败: ${name}`, e);
        }
      }
    }

    refreshRecords();
    renderBackupStatus();
    alert(`导入成功！\n记录：${records.length} 条\n标签：${tags.length} 个`);
  } catch (err) {
    alert('导入失败：文件格式不正确');
    console.error(err);
  }

  target.value = '';
}

function showImportConfirmDialog(onConfirm: () => void): void {
  const v = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:10000;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';

  const card = document.createElement('div');
  overlay.appendChild(card);
  card.innerHTML = `
    <div style="background:${v('--bg-surface')};border-radius:14px;padding:24px;max-width:340px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.25);text-align:center;animation:fadeScaleIn 0.2s ease">
      <div style="width:44px;height:44px;border-radius:50%;background:${v('--accent-bg')};display:flex;align-items:center;justify-content:center;margin:0 auto 14px">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="${v('--accent')}">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
        </svg>
      </div>
      <h3 style="margin:0 0 4px;font-size:15px;font-weight:700;color:${v('--text-primary')}">导入数据提醒</h3>
      <p style="margin:0 0 18px;font-size:12px;color:${v('--text-dim')};line-height:1.5">此操作会清理并覆盖现有的所有数据，<br>请问您是否已导出数据？</p>
      <div style="display:flex;gap:8px">
        <button id="importConfirmCancelBtn" style="flex:1;padding:8px;border:1px solid ${v('--border')};border-radius:8px;background:${v('--bg-surface')};font-size:13px;font-weight:600;color:${v('--text-muted')};cursor:pointer;transition:background 0.15s">还没导出</button>
        <button id="importConfirmOkBtn" style="flex:1;padding:8px;border:none;border-radius:8px;background:#2563eb;font-size:13px;font-weight:600;color:#fff;cursor:pointer;transition:opacity 0.15s">继续导入</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('importConfirmCancelBtn')!.onclick = () => overlay.remove();
  document.getElementById('importConfirmOkBtn')!.onclick = () => {
    overlay.remove();
    onConfirm();
  };
}

// ── 清空所有数据 ──
async function clearAllData(): Promise<void> {
  const result = await new Promise<string>((resolve) => {
    const dlg = showClearConfirmDialog((action) => {
      if (action === 'export') {
        dlg.close();
        exportData();
        return;
      }
      dlg.close();
      resolve(action);
    });
  });

  if (result === 'confirm') {
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();

    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('snapshots', { recursive: true });
    } catch (e) { /* 目录可能不存在 */ }
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('chat', { recursive: true });
    } catch (e) { /* 目录可能不存在 */ }

    updateRecords([]);
    updateTags([]);
    updateMarkTags([]);
    updateSavedRecordOrder([]);
    updateAiProviders([]);
    updateActiveProviderId(null);
    updateEditingProviderId(null);
    updateBackupLogs([]);

    chrome.storage.local.remove(['chat_sessions', 'chat_active_session_id']);

    refreshRecords();
    renderProviderList();
    refreshChatModelSwitcher();
    renderBackupStatus();
    alert('所有数据已清理完毕');
  }
}

function showClearConfirmDialog(onAction: (result: string) => void): { close: () => void } {
  const v = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:10000;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';

  const card = document.createElement('div');
  overlay.appendChild(card);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { close(); onAction('cancel'); } });

  function buildStep1() {
    card.innerHTML = `
      <div style="background:${v('--bg-surface')};border-radius:14px;padding:24px;max-width:340px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.25);text-align:center;animation:fadeScaleIn 0.2s ease">
        <div style="width:44px;height:44px;border-radius:50%;background:${v('--danger-bg')};display:flex;align-items:center;justify-content:center;margin:0 auto 14px">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="${v('--danger')}">
            <path d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10-4.477 10-10 10zm-1-7v2h2v-2h-2zm0-8v6h2V7h-2z"/>
          </svg>
        </div>
        <h3 style="margin:0 0 4px;font-size:15px;font-weight:700;color:${v('--text-primary')}">请问您导出数据了吗？</h3>
        <p style="margin:0 0 18px;font-size:12px;color:${v('--text-dim')};line-height:1.5">清理后所有标注、标签、截图将永久丢失，此操作不可恢复。</p>
        <div style="display:flex;gap:8px">
          <button id="clearCancelBtn" style="flex:1;padding:8px;border:1px solid ${v('--border')};border-radius:8px;background:${v('--bg-surface')};font-size:13px;font-weight:600;color:${v('--text-muted')};cursor:pointer;transition:background 0.15s">还没导出</button>
          <button id="clearConfirmStep1Btn" style="flex:1;padding:8px;border:none;border-radius:8px;background:${v('--danger')};font-size:13px;font-weight:600;color:#fff;cursor:pointer;transition:opacity 0.15s">已导出</button>
        </div>
        <div style="margin-top:10px">
          <a id="clearExportBtn" href="#" style="font-size:12px;color:${v('--accent')};text-decoration:none;font-weight:500;display:inline-flex;align-items:center;gap:4px">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            先导出数据
          </a>
        </div>
      </div>
    `;

    document.getElementById('clearCancelBtn')!.onclick = () => { close(); onAction('cancel'); };
    document.getElementById('clearConfirmStep1Btn')!.onclick = () => buildStep2();
    document.getElementById('clearExportBtn')!.onclick = (e) => {
      e.preventDefault();
      close();
      onAction('export');
    };
  }

  function buildStep2() {
    card.innerHTML = `
      <div style="background:${v('--bg-surface')};border-radius:14px;padding:24px;max-width:340px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.25);text-align:center;animation:fadeScaleIn 0.2s ease">
        <div style="width:44px;height:44px;border-radius:50%;background:${v('--danger-bg')};display:flex;align-items:center;justify-content:center;margin:0 auto 14px">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="${v('--danger')}">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
          </svg>
        </div>
        <h3 style="margin:0 0 4px;font-size:15px;font-weight:700;color:${v('--text-primary')}">确认清理所有数据？</h3>
        <p style="margin:0 0 18px;font-size:12px;color:${v('--text-dim')};line-height:1.5">此操作无法撤销，所有标注记录、标签和截图将被永久删除。</p>
        <div style="display:flex;gap:8px">
          <button id="clearBackBtn" style="flex:1;padding:8px;border:1px solid ${v('--border')};border-radius:8px;background:${v('--bg-surface')};font-size:13px;font-weight:600;color:${v('--text-muted')};cursor:pointer;transition:background 0.15s">取消</button>
          <button id="clearFinalBtn" style="flex:1;padding:8px;border:none;border-radius:8px;background:${v('--danger')};font-size:13px;font-weight:600;color:#fff;cursor:pointer;transition:opacity 0.15s">确认清理</button>
        </div>
        <div style="margin-top:10px">
          <a href="#" id="clearBackLink" style="font-size:12px;color:${v('--text-faint')};text-decoration:none">返回上一步</a>
        </div>
      </div>
    `;

    document.getElementById('clearBackBtn')!.onclick = () => { close(); onAction('cancel'); };
    document.getElementById('clearBackLink')!.onclick = (e) => { e.preventDefault(); buildStep1(); };
    document.getElementById('clearFinalBtn')!.onclick = () => { close(); onAction('confirm'); };
  }

  const style = document.createElement('style');
  style.textContent = `
    @keyframes fadeScaleIn{from{opacity:0;transform:scale(0.95)}to{opacity:1;transform:scale(1)}}
    #clearCancelBtn:hover,#clearBackBtn:hover{background:${v('--bg-muted')}!important}
    #clearConfirmStep1Btn:hover,#clearFinalBtn:hover{opacity:0.85}
    #clearExportBtn:hover{text-decoration:underline}
    #importConfirmCancelBtn:hover{background:${v('--bg-muted')}!important}
    #importConfirmOkBtn:hover{opacity:0.85}
  `;
  document.head.appendChild(style);
  document.body.appendChild(overlay);
  buildStep1();

  return { close };
}

// ── 事件绑定与初始化 ──
function bindEvents(): void {
  elements.exportMenuBtn?.addEventListener('click', exportData);
  elements.importMenuBtn?.addEventListener('click', openImportDialog);
  elements.importFile?.addEventListener('change', importData);
  elements.obsidianExportBtn?.addEventListener('click', exportToObsidian);
  elements.syncMenuBtn?.addEventListener('click', openGithubStorageConfig);
  elements.cancelGithubBtn?.addEventListener('click', () => elements.githubStorageModal.classList.add('hidden'));
  elements.saveGithubBtn?.addEventListener('click', saveGithubStorageConfig);
  elements.backendServiceBtn?.addEventListener('click', openBackendServiceConfig);
  elements.cancelBackendBtn?.addEventListener('click', () => elements.backendServiceModal.classList.add('hidden'));
  document.getElementById('saveBackendBtn')?.addEventListener('click', saveBackendServiceConfig);
  elements.testBackendBtn?.addEventListener('click', () => testBackendConnection());
  document.getElementById('aiConfigBtn')?.addEventListener('click', openAiConfig);
  elements.cancelAiConfigBtn?.addEventListener('click', () => elements.aiConfigModal.classList.add('hidden'));
  elements.saveAiConfigBtn?.addEventListener('click', saveAiConfig);
  elements.testAiBtn?.addEventListener('click', testAiConnection);
  elements.testEmbeddingBtn?.addEventListener('click', testEmbeddingConnection);
  elements.aiEmbeddingProvider?.addEventListener('change', (evt) => {
    const provider = elements.aiEmbeddingProvider.value;
    const isCustom = provider === 'custom';
    const section = document.getElementById('embeddingBaseUrlSection');
    if (section) {
      section.style.display = isCustom ? '' : 'none';
    }
    const labelSection = document.getElementById('embeddingLabelSection');
    if (labelSection) {
      labelSection.style.display = isCustom ? '' : 'none';
    }
    if (DEFAULT_BASE_URLS[provider]) {
      elements.aiEmbeddingBaseUrl.value = DEFAULT_BASE_URLS[provider];
    }
    const savedModel = (evt as any)._embeddingModel;
    fetchEmbeddingModels(savedModel);
  });
  document.getElementById('refreshEmbeddingModelsBtn')?.addEventListener('click', fetchEmbeddingModels);
  document.getElementById('testAsrBtn')?.addEventListener('click', testAsrConnection);

  // ASR 引擎切换
  document.getElementById('asrEngine')?.addEventListener('change', () => {
    const v = (document.getElementById('asrEngine') as HTMLSelectElement)?.value || 'whisper';
    updateAsrUIVisibility(v);
    loadAsrModels(v);
  });

  // ASR 模型刷新
  document.getElementById('refreshAsrModelsBtn')?.addEventListener('click', () => {
    const v = (document.getElementById('asrEngine') as HTMLSelectElement)?.value || 'whisper';
    const current = (document.getElementById('asrModel') as HTMLSelectElement)?.value;
    loadAsrModels(v, current);
  });

  // ASR 缓存管理
  document.getElementById('manageAsrCacheBtn')?.addEventListener('click', openAsrCacheModal);
  document.getElementById('closeAsrCacheBtn')?.addEventListener('click', () => {
    document.getElementById('asrCacheModal')?.classList.add('hidden');
  });
  document.getElementById('refreshAsrCacheBtn')?.addEventListener('click', refreshAsrCacheContent);
  document.getElementById('clearAllAsrCacheBtn')?.addEventListener('click', clearAllAsrCache);
  // 点击弹窗外关闭
  document.getElementById('asrCacheModal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      document.getElementById('asrCacheModal')?.classList.add('hidden');
    }
  });
  elements.addProviderBtn?.addEventListener('click', addNewProvider);
  elements.aiProvider?.addEventListener('change', () => {
    const provider = elements.aiProvider.value;
    if (DEFAULT_BASE_URLS[provider]) elements.aiBaseUrl.value = DEFAULT_BASE_URLS[provider];
    fetchModels();
  });
  elements.refreshModelsBtn?.addEventListener('click', fetchModels);
  elements.addModelBtn?.addEventListener('click', addModelToProvider);
  elements.aiStream?.addEventListener('change', () => {
    const on = elements.aiStream.checked;
    elements.aiStreamLabel.textContent = on ? '已开启' : '已关闭';
    _streamEnabled = on;
  });
  elements.themeToggleBtn?.addEventListener('click', toggleTheme);
  document.getElementById('backupLogClearBtn')?.addEventListener('click', clearBackupLogs);
  elements.triggerBackupBtn?.addEventListener('click', manualTriggerBackup);
  elements.overwriteLocalBtn?.addEventListener('click', overwriteFromBackup);

  document.getElementById('backupToggle')?.addEventListener('change', async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    await chrome.storage.sync.set({ server_backup_enabled: enabled });
    chrome.runtime.sendMessage({ action: 'updateServerBackupAlarm' }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
    const configDiv = document.getElementById('serverBackupConfig');
    if (configDiv) configDiv.style.display = enabled ? 'block' : 'none';
    if (enabled) updateServerBackupStatus();
  });

  document.getElementById('serverBackupTime')?.addEventListener('change', async (e) => {
    const time = (e.target as HTMLInputElement).value || '03:00';
    await chrome.storage.sync.set({ server_backup_time: time });
    chrome.runtime.sendMessage({ action: 'updateServerBackupAlarm' }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
  });

  document.getElementById('serverBackupLogBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openServerBackupLog();
  });

  document.getElementById('serverBackupManualBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    manualServerBackup();
  });

  document.getElementById('serverRestoreBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    restoreLatestServerBackup();
  });

  document.getElementById('cancelServerLogBtn')?.addEventListener('click', () => {
    document.getElementById('serverBackupLogModal')?.classList.add('hidden');
  });
  document.getElementById('serverLogCloseBtn')?.addEventListener('click', () => {
    document.getElementById('serverBackupLogModal')?.classList.add('hidden');
  });
  document.getElementById('serverLogOverlay')?.addEventListener('click', () => {
    document.getElementById('serverBackupLogModal')?.classList.add('hidden');
  });
  document.getElementById('aiConfigCloseBtn')?.addEventListener('click', () => {
    document.getElementById('aiConfigModal')?.classList.add('hidden');
  });
  document.getElementById('aiConfigOverlay')?.addEventListener('click', () => {
    document.getElementById('aiConfigModal')?.classList.add('hidden');
  });
}

export async function initSettings(): Promise<void> {
  await loadAiProviders();
  bindEvents();
  renderProviderList();
  renderBackupStatus();
  updateBackendButtonStatus();
  // 异步更新图片按钮，不阻塞初始化
  updateImageButtonVisibility().catch(() => {});
  refreshChatModelSwitcher();

  // 打开侧边栏时自动检测后端连接状态
  (async () => {
    try {
      const saved = await chrome.storage.local.get(['backend_url', 'backend_key']);
      if (!saved.backend_url) return;
      const url = saved.backend_url.replace(/\/+$/, '');
      const key = saved.backend_key || '';
      const endpoint = url + '/api/health';
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        _backendConnected = true;
        await chrome.storage.local.set({ backend_connected: true });
        if (data.features) await chrome.storage.local.set({ backend_features: data.features });
      } else {
        _backendConnected = false;
        await chrome.storage.local.set({ backend_connected: false });
      }
    } catch {
      _backendConnected = false;
      await chrome.storage.local.set({ backend_connected: false });
    }
    updateBackendButtonStatus();
  })();

  (window as any).__knowSeekSettings = {
    openAiConfig,
    openBackendServiceConfig,
    openGithubStorageConfig,
    saveBackendServiceConfig,
    exportData,
    importData,
    openImportDialog,
    exportToObsidian,
    clearAllData,
    toggleTheme,
    testBackendConnection,
    testAiConnection,
    testEmbeddingConnection,
    disconnectBackend,
    addNewProvider,
    addModelToProvider,
    clearBackupLogs,
    openServerBackupLog,
    manualServerBackup,
    restoreLatestServerBackup,
    renderProviderList,
    renderBackupStatus,
    triggerBackup,
    manualTriggerBackup,
    overwriteFromBackup,
    restoreFromServerBackup,
    addBackupLog,
    saveAiConfig,
    fetchModels,
  };

  console.log('[知寻] Settings 模块初始化完成');
}
