// KnowSeek - 页面级钩子脚本
// 在 document_start 注入到页面主世界，拦截 Bilibili/YouTube 字幕 CDN 请求
// 通过 manifest 手动引用并配置 world: "MAIN"

(function() {
  if (window.__knowseekHookInjected) return;
  window.__knowseekHookInjected = true;

  function isSubtitleRequest(url) {
    if (!url || typeof url !== 'string') return false;
    url = url.toLowerCase();
    return (url.includes('hdslb.com') && (url.includes('subtitle') || url.includes('caption'))) ||
           (url.includes('aisubtitle')) ||
           (url.includes('youtube.com') && url.includes('caption'));
  }

  function tryExtractSubtitle(jsonText) {
    try {
      var json = JSON.parse(jsonText);
      if (json && json.body && Array.isArray(json.body) && json.body.length > 0) {
        var hasContent = json.body[0].content || json.body[0].text;
        if (hasContent) {
          var subText = json.body.map(function(b) { return b.content || b.text || ''; }).join('\n');
          if (subText.trim().length > 10) {
            window.dispatchEvent(new CustomEvent('__knowseek_subtitle', { detail: subText }));
          }
        }
      }
    } catch (e) {}
  }

  // 勾住 fetch
  var origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input instanceof Request ? input.url : (input.url || ''));
    return origFetch(input, init).then(async function(resp) {
      if (isSubtitleRequest(url)) {
        try {
          var clone = resp.clone();
          var txt = await clone.text();
          tryExtractSubtitle(txt);
        } catch (e) {}
      }
      return resp;
    });
  };

  // 勾住 XMLHttpRequest
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__knowseekUrl = typeof url === 'string' ? url : (url ? url.toString() : '');
    return origOpen.apply(this, arguments);
  };
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(body) {
    if (this.__knowseekUrl && isSubtitleRequest(this.__knowseekUrl)) {
      this.addEventListener('load', function() {
        try { tryExtractSubtitle(this.responseText); } catch (e) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  // ===== SPA URL 变化检测（在主世界拦截 pushState，可被页面真实调用拦截）=====
  function notifyUrlChange() {
    var now = location.href;
    if (window.__knowseekLastUrl === undefined) window.__knowseekLastUrl = now;
    if (now !== window.__knowseekLastUrl) {
      window.__knowseekLastUrl = now;
      window.dispatchEvent(new CustomEvent('__knowseek_urlchange', {
        detail: { url: now, title: document.title }
      }));
    }
  }

  // 拦截 pushState / replaceState
  var _origPushState = history.pushState.bind(history);
  history.pushState = function(state, unused, url) {
    _origPushState(state, unused, url);
    notifyUrlChange();
  };
  var _origReplaceState = history.replaceState.bind(history);
  history.replaceState = function(state, unused, url) {
    _origReplaceState(state, unused, url);
    notifyUrlChange();
  };

  // 监听浏览器前进/后退
  window.addEventListener('popstate', notifyUrlChange);
})();