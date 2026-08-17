// =========== Content Script 主入口 ===========
// 负责初始化所有模块

import './content.css';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { loadData } from './state';
import { loadTheme } from './theme';
import { setupMessageListener, setupStorageListener, setupUrlChangeDetection } from './communication';
import { setupSubtitleHook, setupSpaNavigationDetection, setupAutoFetchSubtitles } from './subtitle';
import { restoreHighlights, restoreImageAnnotations, restoreVideoAnnotations, setupMutationRetry } from './highlights/highlight-restore';
import { setupSelectionListeners } from './selection';
import { setupImageHoverListeners } from './ui/image-annotate';
import { setupVideoListeners } from './ui/video-annotate';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    console.log('[KnowSeek] Content script loaded');

    // 初始化
    (async () => {
      await loadData();
      await loadTheme();

      // 恢复高亮和标注
      restoreHighlights();
      restoreImageAnnotations();
      restoreVideoAnnotations();

      // 设置事件监听
      setupSelectionListeners();
      setupImageHoverListeners();
      setupVideoListeners();

      // 消息通信
      setupMessageListener();
      setupStorageListener();

      // 高亮恢复重试
      setupMutationRetry();

      // 字幕
      setupSubtitleHook();
      setupSpaNavigationDetection();
      setupAutoFetchSubtitles();

      // URL 变化检测（通知侧边栏刷新当前页）
      setupUrlChangeDetection();
    })();
  },
});