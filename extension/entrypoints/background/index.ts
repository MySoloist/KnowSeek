import { defineBackground } from 'wxt/utils/define-background';
import { initDefaultData, ensureDataInitialized, setupSidePanel } from './init';
import { createContextMenus, handleContextMenuClick } from './context-menus';
import { setupMessageListener } from './messages';
import { setupSubtitleCDNInterceptor, setupSubtitleProxyMessages } from './subtitle-proxy';
import { setupScreenshotHandlers } from './screenshot';
import { setupNavigationHandlers } from './navigation';
import { setupBackendProxyHandler } from './backend-proxy';
import {
  setupBackupAlarm,
  setupServerBackupAlarm,
  setupBackupHandlers,
  setupBackupAlarmHandler
} from './backup';
import { setupContentCheckerAlarm, setupTabActivationCheck, setupPageUpdateCheck } from './content-checker';

export default defineBackground({
  main() {
    console.log('[Background] Service worker started');

    // ---- 安装 / 更新时初始化 ----
    chrome.runtime.onInstalled.addListener(async () => {
      await initDefaultData();
      await createContextMenus();
      await setupSidePanel();
      await setupBackupAlarm();
      await setupServerBackupAlarm();
    });

    // ---- 浏览器启动时 ----
    chrome.runtime.onStartup.addListener(async () => {
      await ensureDataInitialized();
      await setupBackupAlarm();
      await setupServerBackupAlarm();
    });

    // ---- 右键菜单点击 ----
    chrome.contextMenus.onClicked.addListener(handleContextMenuClick);

    // ---- 字幕 CDN 拦截 ----
    setupSubtitleCDNInterceptor();

    // ---- 备份定时器 ----
    setupBackupAlarmHandler();

    // ---- 内容变更检测定时器 ----
    setupContentCheckerAlarm();

    // ---- 标签页切换时自动检测 ----
    setupTabActivationCheck();

    // ---- 页面更新时自动检测 ----
    setupPageUpdateCheck();

    // ---- 消息路由 ----
    setupMessageListener();
    setupSubtitleProxyMessages();
    setupScreenshotHandlers();
    setupNavigationHandlers();
    setupBackendProxyHandler();
    setupBackupHandlers();
  }
});