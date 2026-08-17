// Sidebar 主题切换（暗色模式）

const THEME_ICON_LIGHT_ID = 'themeIconLight';
const THEME_ICON_DARK_ID = 'themeIconDark';

export async function loadTheme(): Promise<void> {
  const { theme = 'light' } = await chrome.storage.sync.get('theme');
  applyTheme(theme);
}

export function applyTheme(theme: string): void {
  document.documentElement.setAttribute('data-theme', theme);
  const isDark = theme === 'dark';
  const iconLight = document.getElementById(THEME_ICON_LIGHT_ID);
  const iconDark = document.getElementById(THEME_ICON_DARK_ID);
  if (iconLight) iconLight.classList.toggle('hidden', isDark);
  if (iconDark) iconDark.classList.toggle('hidden', !isDark);
}

export async function toggleTheme(): Promise<void> {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await chrome.storage.sync.set({ theme: next });
}