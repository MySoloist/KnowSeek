// =========== Storage 工具模块 ===========
// 封装 chrome.storage.local 的增删改查操作

export const STORAGE_KEYS = {
  RECORDS: 'records',
  TAGS: 'tags',
  MARK_TAGS: 'mark_tags',
  COLOR_CONFIG: 'color_config',
  BACKUP_LOGS: 'backup_logs',
  BACKEND_URL: 'backend_url',
  BACKEND_KEY: 'backend_key',
  BACKEND_FEATURES: 'backend_features',
} as const;

interface ColorConfig {
  colors: { id: string; bg: string; text: string }[];
  defaultColorId: string;
  defaultStyle: string;
}

interface BackendConfig {
  url: string;
  key: string;
  features: Record<string, unknown>;
  connected: boolean;
}

export function generateId(): string {
  return '01' + Date.now().toString(36) + Math.random().toString(36).substring(2, 10).toUpperCase();
}

export async function storageGet<T>(key: string, defaultValue: T | null = null): Promise<T | null> {
  try {
    const result = await chrome.storage.local.get(key);
    return result[key] !== undefined ? result[key] : defaultValue;
  } catch (e) {
    console.error('Storage get error:', e);
    return defaultValue;
  }
}

export async function storageSet(key: string, value: unknown): Promise<boolean> {
  try {
    await chrome.storage.local.set({ [key]: value });
    return true;
  } catch (e) {
    console.error('Storage set error:', e);
    return false;
  }
}

// =========== 记录管理 ===========

export async function getAllRecords(): Promise<any[]> {
  return (await storageGet(STORAGE_KEYS.RECORDS, [])) || [];
}

export async function saveRecord(record: any): Promise<any> {
  const records = await getAllRecords();
  const existingIndex = records.findIndex((r: any) => r.id === record.id);
  if (existingIndex >= 0) {
    records[existingIndex] = record;
  } else {
    records.unshift(record);
  }
  await storageSet(STORAGE_KEYS.RECORDS, records);
  return record;
}

export async function deleteRecord(recordId: string): Promise<boolean> {
  const records = await getAllRecords();
  const filtered = records.filter((r: any) => r.id !== recordId);
  await storageSet(STORAGE_KEYS.RECORDS, filtered);
  await deleteMarkTagsByMarkId(recordId);
  return true;
}

export async function getRecordsByUrl(url: string): Promise<any[]> {
  const records = await getAllRecords();
  return records.filter((r: any) => r.url === url);
}

// =========== 标签管理 ===========

export async function getAllTags(): Promise<any[]> {
  return (await storageGet(STORAGE_KEYS.TAGS, [])) || [];
}

export async function saveTag(tag: any): Promise<any> {
  const tags = await getAllTags();
  const existingIndex = tags.findIndex((t: any) => t.id === tag.id);
  if (existingIndex >= 0) {
    tags[existingIndex] = tag;
  } else {
    tags.push(tag);
  }
  await storageSet(STORAGE_KEYS.TAGS, tags);
  return tag;
}

export async function deleteTag(tagId: string): Promise<boolean> {
  const tags = await getAllTags();
  const filtered = tags.filter((t: any) => t.id !== tagId);
  await storageSet(STORAGE_KEYS.TAGS, filtered);
  await deleteMarkTagsByTagId(tagId);
  return true;
}

// =========== 标签-记录关联 ===========

export async function getAllMarkTags(): Promise<any[]> {
  return (await storageGet(STORAGE_KEYS.MARK_TAGS, [])) || [];
}

export async function addMarkTag(markId: string, tagId: string): Promise<void> {
  const markTags = await getAllMarkTags();
  const exists = markTags.some((mt: any) => mt.mark_id === markId && mt.tag_id === tagId);
  if (exists) return;
  markTags.push({
    id: generateId(),
    mark_id: markId,
    tag_id: tagId,
    created_at: Date.now()
  });
  await storageSet(STORAGE_KEYS.MARK_TAGS, markTags);
  await updateTagCount(tagId);
}

export async function removeMarkTag(markId: string, tagId: string): Promise<void> {
  const markTags = await getAllMarkTags();
  const filtered = markTags.filter((mt: any) => !(mt.mark_id === markId && mt.tag_id === tagId));
  await storageSet(STORAGE_KEYS.MARK_TAGS, filtered);
  await updateTagCount(tagId);
}

export async function getTagsByMarkId(markId: string): Promise<any[]> {
  const markTags = await getAllMarkTags();
  const tagIds = markTags.filter((mt: any) => mt.mark_id === markId).map((mt: any) => mt.tag_id);
  const tags = await getAllTags();
  return tags.filter((t: any) => tagIds.includes(t.id));
}

export async function getMarksByTagId(tagId: string): Promise<any[]> {
  const markTags = await getAllMarkTags();
  const markIds = markTags.filter((mt: any) => mt.tag_id === tagId).map((mt: any) => mt.mark_id);
  const records = await getAllRecords();
  return records.filter((r: any) => markIds.includes(r.id));
}

async function deleteMarkTagsByMarkId(markId: string): Promise<void> {
  const markTags = await getAllMarkTags();
  const toRemove = markTags.filter((mt: any) => mt.mark_id === markId);
  const filtered = markTags.filter((mt: any) => mt.mark_id !== markId);
  await storageSet(STORAGE_KEYS.MARK_TAGS, filtered);
  for (const mt of toRemove) {
    await updateTagCount(mt.tag_id);
  }
}

async function deleteMarkTagsByTagId(tagId: string): Promise<void> {
  const markTags = await getAllMarkTags();
  const filtered = markTags.filter((mt: any) => mt.tag_id !== tagId);
  await storageSet(STORAGE_KEYS.MARK_TAGS, filtered);
}

async function updateTagCount(tagId: string): Promise<void> {
  const markTags = await getAllMarkTags();
  const count = markTags.filter((mt: any) => mt.tag_id === tagId).length;
  const tags = await getAllTags();
  const tag = tags.find((t: any) => t.id === tagId);
  if (tag) {
    tag.count = count;
    await storageSet(STORAGE_KEYS.TAGS, tags);
  }
}

// =========== 颜色配置 ===========

export async function getColorConfig(): Promise<ColorConfig> {
  return (await storageGet(STORAGE_KEYS.COLOR_CONFIG, {
    colors: [
      { id: 'color-1', bg: '#fef08a', text: '#000000' },
      { id: 'color-2', bg: '#fed7aa', text: '#000000' },
      { id: 'color-3', bg: '#fecaca', text: '#000000' },
      { id: 'color-4', bg: '#fce7f3', text: '#000000' },
      { id: 'color-5', bg: '#e9d5ff', text: '#000000' },
      { id: 'color-6', bg: '#dbeafe', text: '#000000' },
      { id: 'color-7', bg: '#a7f3d0', text: '#000000' },
      { id: 'color-8', bg: '#bbf7d0', text: '#000000' },
      { id: 'color-9', bg: '#f3f4f6', text: '#000000' },
      { id: 'color-10', bg: '#d1d5db', text: '#000000' },
      { id: 'color-11', bg: '#1e40af', text: '#ffffff' },
      { id: 'color-12', bg: '#166534', text: '#ffffff' }
    ],
    defaultColorId: 'color-12',
    defaultStyle: 'background'
  })) as ColorConfig;
}

export async function saveColorConfig(config: ColorConfig): Promise<void> {
  await storageSet(STORAGE_KEYS.COLOR_CONFIG, config);
}

// =========== 数据导入导出 ===========

export async function exportAllData(): Promise<Record<string, unknown>> {
  const records = await getAllRecords();
  const tags = await getAllTags();
  const markTags = await getAllMarkTags();
  const colorConfig = await getColorConfig();
  const snapshotsData = await storageGet('snapshots', {});
  return {
    version: '1.1.0',
    exported_at: Date.now(),
    records,
    tags,
    mark_tags: markTags,
    color_config: colorConfig,
    snapshots: snapshotsData
  };
}

export async function importAllData(data: any): Promise<boolean> {
  if (data.records) await storageSet(STORAGE_KEYS.RECORDS, data.records);
  if (data.tags) await storageSet(STORAGE_KEYS.TAGS, data.tags);
  if (data.mark_tags) await storageSet(STORAGE_KEYS.MARK_TAGS, data.mark_tags);
  if (data.color_config) await storageSet(STORAGE_KEYS.COLOR_CONFIG, data.color_config);
  if (data.snapshots) await storageSet('snapshots', data.snapshots);
  return true;
}

export function exportToMarkdown(records: any[], tagsMap: Record<string, string[]> = {}): string {
  let content = '# 网页标注笔记\n\n';
  const urlGroups: Record<string, { title: string; records: any[] }> = {};
  for (const record of records) {
    if (!urlGroups[record.url]) {
      urlGroups[record.url] = {
        title: record.page_title || record.url,
        records: []
      };
    }
    urlGroups[record.url].records.push(record);
  }
  for (const url of Object.keys(urlGroups)) {
    const group = urlGroups[url];
    content += `## [${group.title}](${url})\n\n`;
    for (const record of group.records) {
      const tagIds = tagsMap[record.id] || [];
      const tagStr = tagIds.length > 0 ? tagIds.map((t: string) => `\`${t}\``).join(' ') : '';
      content += `> ${record.text.replace(/\n/g, '\n> ')}\n\n`;
      if (record.description) {
        content += `${record.description}\n\n`;
      }
      if (tagStr) {
        content += `标签: ${tagStr}\n\n`;
      }
      content += `---\n\n`;
    }
  }
  return content;
}

// =========== 后端配置 ===========

export async function getBackendConfig(): Promise<BackendConfig> {
  const url = (await storageGet(STORAGE_KEYS.BACKEND_URL, '')) as string;
  const key = (await storageGet(STORAGE_KEYS.BACKEND_KEY, '')) as string;
  const features = await storageGet(STORAGE_KEYS.BACKEND_FEATURES, {});
  return { url, key, features: features as Record<string, unknown>, connected: !!url };
}

export async function saveBackendConfig(config: { url?: string; key?: string; features?: Record<string, unknown> }): Promise<void> {
  if (config.url !== undefined) await storageSet(STORAGE_KEYS.BACKEND_URL, config.url);
  if (config.key !== undefined) await storageSet(STORAGE_KEYS.BACKEND_KEY, config.key);
  if (config.features) await storageSet(STORAGE_KEYS.BACKEND_FEATURES, config.features);
}

export async function clearBackendConfig(): Promise<void> {
  await storageSet(STORAGE_KEYS.BACKEND_URL, '');
  await storageSet(STORAGE_KEYS.BACKEND_KEY, '');
  await storageSet(STORAGE_KEYS.BACKEND_FEATURES, {});
}

// 兼容旧版全局 Storage 对象
if (typeof window !== 'undefined') {
  (window as any).Storage = {
    KEYS: STORAGE_KEYS,
    get: storageGet,
    set: storageSet,
    getAllRecords,
    saveRecord,
    deleteRecord,
    getRecordsByUrl,
    getAllTags,
    saveTag,
    deleteTag,
    getAllMarkTags,
    addMarkTag,
    removeMarkTag,
    getTagsByMarkId,
    getMarksByTagId,
    getColorConfig,
    saveColorConfig,
    generateId,
    exportAllData,
    importAllData,
    exportToMarkdown,
    getBackendConfig,
    saveBackendConfig,
    clearBackendConfig
  };
}