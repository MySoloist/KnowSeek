// Sidebar 共享状态管理
import { STORAGE_KEYS } from '../../utils/storage';

export { STORAGE_KEYS };

export const DEFAULT_BASE_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com',
  siliconflow: 'https://api.siliconflow.cn',
  ollama: 'http://localhost:11434',
};

export let records: any[] = [];
export let tags: any[] = [];
export let markTags: any[] = [];
export let currentFilter = 'all';
export let searchQuery = '';
export let selectedTagId: string | null = null;
export let currentRecordId: string | null = null;
export let editingTagId: string | null = null;
export let expandedNodes = new Set<string>();
export let savedRecordOrder: string[] = [];
export let aiProviders: any[] = [];
export let activeProviderId: string | null = null;
export let editingProviderId: string | null = null;
export let backupLogs: any[] = [];

export function updateRecords(newRecords: any[]) { records = newRecords; }
export function updateTags(newTags: any[]) { tags = newTags; }
export function updateMarkTags(newMarkTags: any[]) { markTags = newMarkTags; }
export function updateSavedRecordOrder(order: string[]) { savedRecordOrder = order; }
export function updateBackupLogs(logs: any[]) { backupLogs = logs; }
export function updateAiProviders(newProviders: any[]) { aiProviders = newProviders; }
export function updateActiveProviderId(id: string | null) { activeProviderId = id; }
export function updateEditingProviderId(id: string | null) { editingProviderId = id; }

export async function loadAiProviders(): Promise<void> {
  const data = await chrome.storage.local.get(['ai_providers', 'ai_active_provider']);
  let providers = (data.ai_providers as any[]) || [];
  let activeId = (data.ai_active_provider as string | null) || null;

  // 向后兼容：从旧的单配置迁移
  if (providers.length === 0) {
    const old = await chrome.storage.local.get([
      'ai_provider',
      'ai_api_key',
      'ai_model',
      'ai_base_url',
      'ai_max_tokens',
      'ai_stream',
    ]);
    if (old.ai_provider && old.ai_api_key && old.ai_model) {
      const pId = 'p_' + Date.now();
      const mId = 'm_' + Date.now();
      providers.push({
        id: pId,
        provider: old.ai_provider,
        label:
          old.ai_provider === 'deepseek'
            ? 'DeepSeek'
            : old.ai_provider === 'siliconflow'
              ? '硅基流动'
              : old.ai_provider === 'openai'
                ? 'OpenAI'
                : old.ai_provider,
        api_key: old.ai_api_key,
        base_url: old.ai_base_url || DEFAULT_BASE_URLS[old.ai_provider] || '',
        models: [{ modelId: mId, model: old.ai_model }],
        activeModelId: mId,
        max_tokens: old.ai_max_tokens || 1024,
        stream: old.ai_stream !== undefined ? old.ai_stream : true,
      });
      activeId = pId;
      await chrome.storage.local.set({
        ai_providers: providers,
        ai_active_provider: activeId,
      });
    }
  } else {
    // 确保旧格式 providers 升级到多模型格式
    providers.forEach((p) => {
      if (!p.models) {
        const mId = 'm_' + Date.now();
        const oldModel = (p as any).model;
        p.models = oldModel ? [{ modelId: mId, model: oldModel }] : [];
        p.activeModelId = p.models.length > 0 ? mId : null;
        delete (p as any).model;
      }
    });
  }

  aiProviders = providers;
  activeProviderId = activeId;
}

export async function loadData(): Promise<void> {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.RECORDS,
    STORAGE_KEYS.TAGS,
    STORAGE_KEYS.MARK_TAGS,
    STORAGE_KEYS.BACKUP_LOGS,
    'record_order'
  ]);
  records = data[STORAGE_KEYS.RECORDS] || [];
  tags = data[STORAGE_KEYS.TAGS] || [];
  markTags = data[STORAGE_KEYS.MARK_TAGS] || [];
  savedRecordOrder = data['record_order'] || [];
  backupLogs = data[STORAGE_KEYS.BACKUP_LOGS] || [];
}

export function setupStorageListener(onDataChange?: () => void): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    let needsReload = false;
    if (changes[STORAGE_KEYS.RECORDS]) {
      records = changes[STORAGE_KEYS.RECORDS].newValue || [];
      needsReload = true;
    }
    if (changes[STORAGE_KEYS.TAGS]) {
      tags = changes[STORAGE_KEYS.TAGS].newValue || [];
      needsReload = true;
    }
    if (changes[STORAGE_KEYS.MARK_TAGS]) {
      markTags = changes[STORAGE_KEYS.MARK_TAGS].newValue || [];
      needsReload = true;
    }
    if (changes[STORAGE_KEYS.BACKUP_LOGS]) {
      backupLogs = changes[STORAGE_KEYS.BACKUP_LOGS].newValue || [];
    }
    if (needsReload && onDataChange) {
      onDataChange();
    }
  });
}

export function generateId(): string {
  return '01' + Date.now().toString(36) + Math.random().toString(36).substring(2, 10).toUpperCase();
}