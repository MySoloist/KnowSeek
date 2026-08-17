// =========== 暗色主题管理 ===========

/** 加载暗色主题样式 */
export async function loadTheme(): Promise<void> {
  const { theme = 'light' } = await chrome.storage.sync.get('theme');
  const existing = document.getElementById('wa-theme-style');
  if (existing) existing.remove();
  if (theme === 'dark') {
    const style = document.createElement('style');
    style.id = 'wa-theme-style';
    style.textContent = `
      .wa-edit-popup, .wa-toolbar, .wa-color-picker, .wa-note-popup {
        background: #242424 !important;
        color: #d0d0d0 !important;
        border-color: #3a3a3a !important;
      }
      .wa-edit-popup-title, .wa-note-popup-header {
        color: #e8e8e8 !important;
      }
      .wa-edit-popup-time, .wa-edit-popup-close {
        color: #888888 !important;
      }
      .wa-edit-popup-close:hover {
        color: #d0d0d0 !important;
      }
      .wa-edit-popup-md, .wa-edit-popup-md p, .wa-edit-popup-md del {
        color: #b0b0b0 !important;
      }
      .wa-edit-popup-md h1, .wa-edit-popup-md h2, .wa-edit-popup-md h3,
      .wa-edit-popup-md h4, .wa-edit-popup-md h5, .wa-edit-popup-md h6 {
        color: #e8e8e8 !important;
      }
      .wa-edit-popup-md code, .wa-edit-popup-md pre {
        background: #2e2e2e !important;
        color: #b0b0b0 !important;
      }
      .wa-edit-popup-md a { color: #60a5fa !important; }
      .wa-edit-popup-md blockquote {
        border-left-color: #3a3a3a !important;
        color: #888888 !important;
      }
      .wa-edit-popup-md th, .wa-edit-popup-md td {
        border-color: #3a3a3a !important;
      }
      .wa-edit-popup-md th { background: #2e2e2e !important; }
      .wa-edit-popup-md hr { border-top-color: #3a3a3a !important; }
      .wa-note-textarea {
        background: #333333 !important;
        color: #d0d0d0 !important;
        border-color: #3a3a3a !important;
      }
      .wa-note-textarea::placeholder { color: #666666 !important; }
      .wa-btn-primary { background: #3b82f6 !important; }
      .wa-btn-secondary {
        background: #333333 !important;
        color: #d0d0d0 !important;
        border-color: #3a3a3a !important;
      }
      .wa-l1-btn { background: #2a2a2a !important; color: #d0d0d0 !important; box-shadow: 0 2px 8px rgba(0,0,0,0.4) !important; }
      .wa-l1-btn:hover { background: #333 !important; }
      .wa-l1-btn.active { box-shadow: 0 0 0 3px rgba(99,102,241,0.5), 0 3px 12px rgba(0,0,0,0.4) !important; }
      .wa-l1-btn[data-mode="ai"].active { box-shadow: 0 0 0 3px rgba(124,58,237,0.5), 0 3px 12px rgba(0,0,0,0.4) !important; }
      .wa-l1-btn[data-mode="both"].active { box-shadow: 0 0 0 3px rgba(22,163,74,0.5), 0 3px 12px rgba(0,0,0,0.4) !important; }
      .wa-l2-btn { background: #2a2a2a !important; color: #d0d0d0 !important; }
      .wa-l2-btn:hover { background: #3a3a3a !important; }
      .wa-ai-result-card { background: #242424 !important; border-color: #3a3a3a !important; color: #d0d0d0 !important; }
      .wa-ai-result-header { background: #2a2a2a !important; border-bottom-color: #333 !important; color: #d0d0d0 !important; }
      .wa-ai-result-close { color: #888 !important; }
      .wa-ai-result-close:hover { color: #ccc !important; }
      .wa-ai-result-body { color: #d0d0d0 !important; }
      .wa-color-picker { background: #242424 !important; border-color: #3a3a3a !important; }
      .wa-note-popup-header { border-bottom-color: #3a3a3a !important; }
      .wa-note-popup-footer { border-top-color: #3a3a3a !important; }
    `;
    document.head.appendChild(style);
  }
}