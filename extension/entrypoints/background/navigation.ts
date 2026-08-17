// =========== 跳转到标注位置 ===========

export function setupNavigationHandlers(): void {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action !== 'navigateToRecord') return;

    // 从 storage 读取 records
    chrome.storage.local.get(['records']).then(data => {
      const records = data.records || [];
      const record = records.find((r: any) => r.id === request.recordId);
      if (!record) { sendResponse({ success: false }); return; }

      // 使用 sender.tab 定位当前标签页
      const tabId = sender.tab?.id;
      if (tabId) {
        // 激活当前标签页
        chrome.tabs.update(tabId, { active: true });
        chrome.windows.update(sender.tab.windowId, { focused: true });

        setTimeout(() => {
          if (record.videoTimestamp !== undefined) {
            chrome.tabs.sendMessage(tabId, {
              action: 'seekToVideoTimestamp',
              timestamp: record.videoTimestamp,
              recordId: record.id
            });
          } else {
            chrome.tabs.sendMessage(tabId, {
              action: 'scrollToHighlight',
              recordId: record.id
            });
          }
        }, 300);
      } else {
        // 兜底：没有 sender.tab 时通过 URL 查找标签页
        chrome.tabs.query({}, (tabs) => {
          const existingTab = tabs.find((t: any) => {
            try {
              const u1 = new URL(t.url || '');
              const u2 = new URL(record.url || '');
              return u1.hostname === u2.hostname && u1.pathname === u2.pathname;
            } catch (_) { return t.url === record.url; }
          });

          if (existingTab) {
            chrome.tabs.update(existingTab.id!, { active: true });
            chrome.windows.update(existingTab.windowId!, { focused: true });
            setTimeout(() => {
              if (record.videoTimestamp !== undefined) {
                chrome.tabs.sendMessage(existingTab.id!, {
                  action: 'seekToVideoTimestamp',
                  timestamp: record.videoTimestamp,
                  recordId: record.id
                });
              } else {
                chrome.tabs.sendMessage(existingTab.id!, {
                  action: 'scrollToHighlight',
                  recordId: record.id
                });
              }
            }, 300);
          } else {
            chrome.tabs.create({ url: record.url }, (newTab) => {
              const onUpdated = (tabId: number, changeInfo: any) => {
                if (tabId === newTab.id && changeInfo.status === 'complete') {
                  chrome.tabs.onUpdated.removeListener(onUpdated);
                  setTimeout(() => {
                    if (record.videoTimestamp !== undefined) {
                      chrome.tabs.sendMessage(newTab.id!, {
                        action: 'seekToVideoTimestamp',
                        timestamp: record.videoTimestamp,
                        recordId: record.id
                      });
                    } else {
                      chrome.tabs.sendMessage(newTab.id!, {
                        action: 'scrollToHighlight',
                        recordId: record.id
                      });
                    }
                  }, 1500);
                }
              };
              chrome.tabs.onUpdated.addListener(onUpdated);
            });
          }
          sendResponse({ success: true });
        });
        return; // 保持消息通道
      }
      sendResponse({ success: true });
    }).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  });
}