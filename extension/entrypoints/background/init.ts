// =========== Storage 键名常量 ===========
export const STORAGE_KEYS = {
  RECORDS: 'records',
  TAGS: 'tags',
  MARK_TAGS: 'mark_tags',
  COLOR_CONFIG: 'color_config',
  BACKUP_LOGS: 'backup_logs',
  SERVER_BACKUP_LOGS: 'server_backup_logs'
};

// =========== 默认颜色配置 ===========
export const DEFAULT_COLOR_CONFIG = {
  colors: [
    { id: 'color-1', bg: '#fef08a', text: '#000000', name: '淡黄' },
    { id: 'color-2', bg: '#fed7aa', text: '#000000', name: '橘黄' },
    { id: 'color-3', bg: '#fecaca', text: '#000000', name: '淡红' },
    { id: 'color-4', bg: '#fce7f3', text: '#000000', name: '粉红' },
    { id: 'color-5', bg: '#e9d5ff', text: '#000000', name: '淡紫' },
    { id: 'color-6', bg: '#dbeafe', text: '#000000', name: '淡蓝' },
    { id: 'color-7', bg: '#a7f3d0', text: '#000000', name: '青绿' },
    { id: 'color-8', bg: '#bbf7d0', text: '#000000', name: '草绿' },
    { id: 'color-9', bg: '#f3f4f6', text: '#000000', name: '浅灰' },
    { id: 'color-10', bg: '#d1d5db', text: '#000000', name: '中灰' },
    { id: 'color-11', bg: '#1e40af', text: '#ffffff', name: '深蓝' },
    { id: 'color-12', bg: '#166534', text: '#ffffff', name: '深绿' }
  ],
  defaultColorId: 'color-12',
  defaultStyle: 'background'
};

// =========== 初始化默认数据 ===========
export async function initDefaultData(): Promise<void> {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.RECORDS,
    STORAGE_KEYS.TAGS,
    STORAGE_KEYS.MARK_TAGS,
    STORAGE_KEYS.COLOR_CONFIG
  ]);

  if (!data[STORAGE_KEYS.COLOR_CONFIG]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.COLOR_CONFIG]: DEFAULT_COLOR_CONFIG });
  }
  if (!data[STORAGE_KEYS.TAGS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.TAGS]: [] });
  }
  if (!data[STORAGE_KEYS.MARK_TAGS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.MARK_TAGS]: [] });
  }
  if (!data[STORAGE_KEYS.RECORDS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.RECORDS]: [] });
  }
}

export async function ensureDataInitialized(): Promise<void> {
  await initDefaultData();
}

// =========== 侧边栏行为 ===========
export async function setupSidePanel(): Promise<void> {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (e) {
    console.warn('Failed to set side panel behavior:', e);
  }
}

// =========== 获取颜色配置（自动补全缺失的 name 字段） ===========
export async function getColorConfig(): Promise<typeof DEFAULT_COLOR_CONFIG> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.COLOR_CONFIG);
  const config = data[STORAGE_KEYS.COLOR_CONFIG] || DEFAULT_COLOR_CONFIG;
  // 补全旧数据中缺少的 name 字段
  if (config.colors) {
    config.colors = config.colors.map(c => {
      const def = DEFAULT_COLOR_CONFIG.colors.find(d => d.id === c.id);
      return { ...def, ...c }; // 用默认值补全缺失字段，同时保留用户自定义覆盖
    });
  }
  return config;
}