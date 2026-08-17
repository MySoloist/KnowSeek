// =========== 共享状态 ===========
// 被所有模块引用，不依赖其他内部模块（避免循环引用）

export const STORAGE_KEYS = {
  RECORDS: 'records',
  COLOR_CONFIG: 'color_config',
};

export let records: any[] = [];
export let colorConfig: any = null;
export let cachedSubtitles: string | null = null;
export let cachedSubtitlesUrl = '';
export let currentSelection: { text: string; range: Range } | null = null;

export function updateRecords(newRecords: any[]): void { records = newRecords; }
export function updateColorConfig(config: any): void { colorConfig = config; }
export function updateCachedSubtitles(subtitles: string | null, url: string): void {
  cachedSubtitles = subtitles;
  cachedSubtitlesUrl = url;
}
export function setCurrentSelection(sel: { text: string; range: Range } | null): void {
  currentSelection = sel;
}

/** 安全发送消息，忽略 context invalidated 错误 */
export function safeSendMessage(message: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage(message, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
  } catch (_) {}
}

/** 从 storage 加载数据 */
export async function loadData(): Promise<void> {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.RECORDS,
    STORAGE_KEYS.COLOR_CONFIG,
  ]);
  records = data[STORAGE_KEYS.RECORDS] || [];
  colorConfig = data[STORAGE_KEYS.COLOR_CONFIG] || {
    colors: [{ id: 'color-12', bg: '#166534', text: '#ffffff' }],
    defaultColorId: 'color-12',
    defaultStyle: 'background',
  };
  console.log(`[KnowSeek] loadData: ${records.length} records loaded`);
}