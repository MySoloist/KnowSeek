// =========== 截图管理（OPFS 存储） ===========
// 使用 Origin Private File System (OPFS) 存储截图文件

export function setupScreenshotHandlers(): void {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    // ---- 截取当前标签页的可见区域 ----
    if (request.action === 'captureScreenshot') {
      chrome.tabs.captureVisibleTab(sender.tab?.windowId || 0, { format: 'png' }, async (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
          return;
        }

        try {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle('snapshots', { create: true });
          const fileName = `snapshot_${request.recordId}.png`;
          const fileHandle = await dir.getFileHandle(fileName, { create: true });
          const writable = await fileHandle.createWritable();

          const response = await fetch(dataUrl);
          const blob = await response.blob();
          await writable.write(blob);
          await writable.close();

          console.log('[Background] 截图已保存到 OPFS:', fileName);
          sendResponse({ saved: true, method: 'opfs' });
        } catch (err: any) {
          console.error('[Background] 保存截图失败:', err);
          sendResponse({ error: err.message, saved: false });
        }
      });
      return true;
    }

    // ---- 保存视频帧截图 ----
    if (request.action === 'saveVideoFrame') {
      (async () => {
        try {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle('snapshots', { create: true });
          const fileName = `snapshot_${request.recordId}.png`;
          const fileHandle = await dir.getFileHandle(fileName, { create: true });
          const writable = await fileHandle.createWritable();
          const response = await fetch(request.dataUrl);
          const blob = await response.blob();
          await writable.write(blob);
          await writable.close();
          sendResponse({ saved: true });
        } catch (err: any) {
          sendResponse({ saved: false, error: err.message });
        }
      })();
      return true;
    }

    // ---- 读取已保存的截图（返回 dataUrl） ----
    if (request.action === 'getPasteImage') {
      (async () => {
        try {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle('snapshots');
          const fileHandle = await dir.getFileHandle(request.snapshotId + '.png');
          const file = await fileHandle.getFile();
          const dataUrl = await new Promise<string | ArrayBuffer | null>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          sendResponse({ dataUrl });
        } catch (err: any) {
          sendResponse({ error: err.message });
        }
      })();
      return true;
    }
  });
}