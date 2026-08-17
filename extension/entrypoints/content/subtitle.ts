// =========== 视频字幕捕获 ===========
// YouTube / Bilibili 字幕获取

import { formatTimestamp } from './utils';

// ---- 共享状态（由 communication.ts 管理） ----
export let cachedSubtitles: string | null = null;
export let cachedSubtitlesUrl = '';

export function updateCachedSubtitles(subtitles: string | null, url: string): void {
  cachedSubtitles = subtitles;
  cachedSubtitlesUrl = url;
}

// ---- YouTube 字幕 ----

async function fetchYouTubeCaptions(): Promise<string | null> {
  try {
    const scripts = document.querySelectorAll('script');
    let playerResponse = null;
    for (const script of scripts) {
      if (script.textContent.includes('ytInitialPlayerResponse')) {
        const m = script.textContent.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
        if (m) { try { playerResponse = JSON.parse(m[1]); break; } catch (_) {} }
      }
    }
    if (!playerResponse) return null;
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || !tracks.length) return null;
    let track = tracks.find((t: any) => t.languageCode?.startsWith('zh'));
    if (!track) track = tracks.find((t: any) => t.languageCode === 'en');
    if (!track) track = tracks[0];
    if (!track) return null;
    const resp = await fetch(track.baseUrl);
    const xml = await resp.text();
    const xmlDoc = new DOMParser().parseFromString(xml, 'text/xml');
    const texts = xmlDoc.querySelectorAll('text');
    let captionText = '';
    texts.forEach(t => {
      if (t.textContent) {
        const start = parseFloat(t.getAttribute('start') || '0');
        const ts = formatTimestamp(start);
        captionText += `${ts} ${t.textContent.trim()}\n`;
      }
    });
    if (!captionText.trim()) return null;
    return captionText.trim();
  } catch (_) {
    return null;
  }
}

// ---- Bilibili 字幕 ----

function formatBilibiliSubs(body: any[]): string {
  return body.map((b: any) => {
    const secs = b.from || 0;
    const ts = formatTimestamp(secs);
    return `${ts} ${b.content}`;
  }).join('\n');
}

function logSubtitle(strategy: string, text: string | null): void {
  if (!text) { console.log(`[KnowSeek] 字幕策略 ${strategy}: 失败`); return; }
  const lines = text.split('\n').filter(l => l.trim());
  const preview = lines.slice(0, 5).join('\n');
  console.log(`[KnowSeek] 字幕策略 ${strategy}: 成功 (共 ${lines.length} 行)`);
  console.log(`[KnowSeek] 字幕预览 (前5行):\n${preview}`);
}

// B站 WBI 签名
const WBI_MIXIN_TABLE = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,37,12,52,56,7,39,48,59,36,30,57,41,6,13,20,16,51,11,40,55,17,34,24,1,38,4,0,21,25,60,26,54,61,44,62,22,63];

function wbiMd5(str: string): string {
  function rotl(x: number, n: number) { return (x << n) | (x >>> (32 - n)); }
  function toBytes(s: string): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 128) bytes.push(c);
      else if (c < 2048) bytes.push(192|(c>>6), 128|(c&63));
      else if (c < 55296 || c >= 57344) bytes.push(224|(c>>12), 128|((c>>6)&63), 128|(c&63));
      else { i++; c = 0x10000+(((c&0x3FF)<<10)|(s.charCodeAt(i)&0x3FF)); bytes.push(240|(c>>18), 128|((c>>12)&63), 128|((c>>6)&63), 128|(c&63)); }
    }
    return bytes;
  }
  function toWords(bytes: number[]): number[] {
    const words: number[] = [];
    for (let i = 0; i < bytes.length; i++) words[i>>2] |= bytes[i] << ((i%4)*8);
    return words;
  }
  function addWords(a: number, b: number): number {
    const lsw = (a & 0xFFFF) + (b & 0xFFFF);
    return ((a>>>16)+(b>>>16)+(lsw>>>16))<<16 | (lsw & 0xFFFF);
  }
  function F(x: number, y: number, z: number) { return (x & y) | (~x & z); }
  function G(x: number, y: number, z: number) { return (x & z) | (y & ~z); }
  function H(x: number, y: number, z: number) { return x ^ y ^ z; }
  function I(x: number, y: number, z: number) { return y ^ (x | ~z); }
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const T: number[] = [];
  for (let i = 1; i <= 64; i++) T.push(Math.floor(Math.abs(Math.sin(i)) * 0x100000000));
  const bytes = toBytes(str);
  const len = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const lenBytes: number[] = [];
  for (let i = 0; i < 8; i++) lenBytes.push((len >>> (i*8)) & 0xFF);
  bytes.push(...lenBytes);
  const words = toWords(bytes);
  let [a0, b0, c0, d0] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476];
  for (let i = 0; i < words.length; i += 16) {
    const X = words.slice(i, i+16);
    let [A, B, C, D] = [a0, b0, c0, d0];
    for (let j = 0; j < 64; j++) {
      let f: (x: number, y: number, z: number) => number, g: number;
      if (j < 16) { f = F; g = j; }
      else if (j < 32) { f = G; g = (5*j+1)%16; }
      else if (j < 48) { f = H; g = (3*j+5)%16; }
      else { f = I; g = (7*j)%16; }
      const temp = D;
      D = C; C = B;
      B = addWords(B, rotl(addWords(addWords(addWords(A, f(B, C, D)), T[j]), X[g]), S[j]));
      A = temp;
    }
    [a0, b0, c0, d0] = [addWords(a0, A), addWords(b0, B), addWords(c0, C), addWords(d0, D)];
  }
  function hex(n: number): string {
    const h = (n >>> 0).toString(16);
    return '0'.repeat(8-h.length)+h;
  }
  return hex(a0)+hex(b0)+hex(c0)+hex(d0);
}

let wbiKeysCache: { imgKey: string; subKey: string } | null = null;
let wbiKeysCacheTime = 0;
const WBI_CACHE_TTL = 3600000;

async function getWbiKeys(): Promise<{ imgKey: string; subKey: string } | null> {
  if (wbiKeysCache && Date.now() - wbiKeysCacheTime < WBI_CACHE_TTL) return wbiKeysCache;
  try {
    const resp = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'Referer': 'https://www.bilibili.com', 'User-Agent': navigator.userAgent },
      credentials: 'include'
    });
    const data = await resp.json();
    if (data?.code === 0 && data?.data?.wbi_img) {
      const imgMatch = data.data.wbi_img.img_url?.match(/\/([^/]+)\.png$/);
      const subMatch = data.data.wbi_img.sub_url?.match(/\/([^/]+)\.png$/);
      if (imgMatch && subMatch) {
        wbiKeysCache = { imgKey: imgMatch[1], subKey: subMatch[1] };
        wbiKeysCacheTime = Date.now();
        return wbiKeysCache;
      }
    }
  } catch (_) {}
  return null;
}

async function signWbi(params: Record<string, any>): Promise<Record<string, any>> {
  const keys = await getWbiKeys();
  if (!keys) return { ...params };
  const mixKey = (keys.imgKey + keys.subKey).split('').map((_, i) => WBI_MIXIN_TABLE[i] !== undefined ? (keys.imgKey + keys.subKey)[WBI_MIXIN_TABLE[i]] || '' : '').join('').slice(0, 32);
  const sortedKeys = Object.keys(params).sort();
  const query = sortedKeys.map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
  const wts = Math.floor(Date.now() / 1000);
  const w_rid = wbiMd5(query + mixKey);
  return { ...params, w_rid, wts };
}

const biliViewCache: Record<string, { data: any; ts: number }> = {};
const BILI_CACHE_TTL = 120000;

async function fetchBilibiliCaptions(): Promise<string | null> {
  try {
    const pathMatch = location.pathname.match(/\/video\/([^/?#]+)/);
    if (!pathMatch) return null;
    const rawId = pathMatch[1];
    const isAv = rawId.startsWith('av');
    const queryParam = isAv ? 'aid=' + rawId.replace('av', '') : 'bvid=' + rawId;

    // 获取视频信息
    let info: any;
    const cacheKey = rawId;
    const cached = biliViewCache[cacheKey];
    if (cached && Date.now() - cached.ts < BILI_CACHE_TTL) {
      info = cached.data;
    } else {
      const infoResp = await fetch(`https://api.bilibili.com/x/web-interface/view?${queryParam}`, {
        headers: { 'Referer': location.href, 'User-Agent': navigator.userAgent },
        credentials: 'include'
      });
      if (!infoResp.ok) return null;
      const text1 = await infoResp.text();
      try { info = JSON.parse(text1); } catch (_) { return null; }
      if (info.code !== 0) return null;
      biliViewCache[cacheKey] = { data: info, ts: Date.now() };
    }
    const cid = info.data?.cid;
    const aid = info.data?.aid;
    if (!cid) return null;

    // 通过 player/wbi/v2 获取字幕
    const subParams = { cid, aid };
    const signedParams = await signWbi(subParams);
    const wbiQuery = Object.entries(signedParams).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const subResp = await fetch(`https://api.bilibili.com/x/player/wbi/v2?${wbiQuery}`, {
      headers: { 'Referer': location.href, 'User-Agent': navigator.userAgent },
      credentials: 'include'
    });
    const text2 = await subResp.text();
    let playerData: any;
    try { playerData = JSON.parse(text2); } catch (_) {}
    if (!playerData || playerData.code !== 0) { /* continue with fallbacks */ }

    const subtitleInfo = playerData?.data?.subtitle;
    const subtitles = subtitleInfo?.subtitles || playerData?.data?.subtitles;

    // 第1步：CDN 字幕下载
    if (subtitles?.length) {
      let validSubs = subtitles.filter((s: any) => s.lan && s.lan !== 'ai-zh');
      let usingAiZh = false;
      if (validSubs.length === 0) {
        validSubs = subtitles.filter((s: any) => s.lan === 'ai-zh');
        usingAiZh = true;
      }
      if (validSubs.length > 0) {
        let sub = validSubs.find((s: any) => s.lan_doc?.includes('中文')) || validSubs[0];
        if (sub?.subtitle_url) {
          const subUrl = sub.subtitle_url.startsWith('//') ? 'https:' + sub.subtitle_url
            : sub.subtitle_url.startsWith('http') ? sub.subtitle_url
            : 'https:' + sub.subtitle_url;
          const subJsonResp = await fetch(subUrl, { headers: { 'Referer': location.href } });
          const subJson = await subJsonResp.json();
          if (subJson?.body?.length) {
            const text = formatBilibiliSubs(subJson.body);
            logSubtitle('① CDN直下', text);
            return text;
          }
        }
      }
    }

    // 第2步：Cookie 代理
    if (subtitles?.length) {
      try {
        const wbiQuery2 = Object.entries(await signWbi(subParams)).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        const proxyResp = await new Promise<any>(r => chrome.runtime.sendMessage({
          action: 'proxyBilibiliApi',
          url: `https://api.bilibili.com/x/player/wbi/v2?${wbiQuery2}`
        }, (response) => {
          if (chrome.runtime.lastError) { r(null); return; }
          r(response);
        }));
        if (proxyResp && !proxyResp.error && proxyResp.data?.data?.subtitle?.subtitles?.length > 0) {
          const proxiedSubs = proxyResp.data.data.subtitle.subtitles;
          let proxiedSub = proxiedSubs.find((s: any) => s.lan && s.lan !== 'ai-zh') || proxiedSubs.find((s: any) => s.lan === 'ai-zh');
          let proxiedUrl = proxiedSub?.subtitle_url || '';
          if (proxiedUrl) {
            if (proxiedUrl.startsWith('//')) proxiedUrl = 'https:' + proxiedUrl;
            const subResp = await new Promise<any>(r => chrome.runtime.sendMessage({
              action: 'proxyFetchSubtitle',
              url: proxiedUrl
            }, (response) => {
              if (chrome.runtime.lastError) { r(null); return; }
              r(response);
            }));
            if (subResp && !subResp.error && subResp.data) {
              try {
                const subJson = JSON.parse(subResp.data);
                if (subJson?.body?.length) {
                  const text = formatBilibiliSubs(subJson.body);
                  logSubtitle('② Cookie代理', text);
                  return text;
                }
              } catch (_) {}
            }
          }
        }
      } catch (_) {}
    }

    // 第3步：background 拦截
    try {
      const cachedSub = await chrome.storage.local.get('interceptedSubtitle');
      if (cachedSub.interceptedSubtitle && cachedSub.interceptedSubtitle.url === location.href) {
        logSubtitle('③ 后台拦截', cachedSub.interceptedSubtitle.text);
        return cachedSub.interceptedSubtitle.text;
      }
    } catch (_) {}

    // 第4步：textTracks
    function extractTextTracks(): string | null {
      try {
        const v = getMainVideoElement();
        if (v && v.textTracks && v.textTracks.length > 0) {
          const tracks: string[] = [];
          for (let i = 0; i < v.textTracks.length; i++) {
            const t = v.textTracks[i];
            if (t.cues && t.cues.length > 0) {
              for (let j = 0; j < t.cues.length; j++) {
                const cue = t.cues[j];
                const secs = cue.startTime || 0;
                tracks.push(`${formatTimestamp(secs)} ${cue.text}`);
              }
            }
          }
          if (tracks.length > 0) {
            const text = tracks.join('\n');
            logSubtitle('④ textTracks', text);
            return text;
          }
        }
      } catch (_) {}
      return null;
    }

    let subText = extractTextTracks();
    if (!subText) {
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 600));
        subText = extractTextTracks();
        if (subText) break;
      }
    }
    if (subText) {
      logSubtitle('④ textTracks(延时)', subText);
      return subText;
    }

    // 第5步：重试
    await new Promise(r => setTimeout(r, 1500));
    const retryParams = await signWbi(subParams);
    const retryQuery = Object.entries(retryParams).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const retryResp = await fetch(`https://api.bilibili.com/x/player/wbi/v2?${retryQuery}`, {
      headers: { 'Referer': location.href, 'User-Agent': navigator.userAgent },
      credentials: 'include'
    });
    const retryText = await retryResp.text();
    try {
      const retryData = JSON.parse(retryText);
      if (retryData.code === 0 && retryData.data?.subtitle?.subtitles?.length > 0) {
        const retrySubs = retryData.data.subtitle.subtitles;
        let validRetrySubs = retrySubs.filter((s: any) => s.lan && s.lan !== 'ai-zh');
        if (validRetrySubs.length === 0) validRetrySubs = retrySubs.filter((s: any) => s.lan === 'ai-zh');
        if (validRetrySubs.length > 0) {
          const retrySub = validRetrySubs[0];
          if (retrySub?.subtitle_url) {
            const subUrl = retrySub.subtitle_url.startsWith('//') ? 'https:' + retrySub.subtitle_url
              : retrySub.subtitle_url.startsWith('http') ? retrySub.subtitle_url
              : 'https:' + retrySub.subtitle_url;
            const subJsonResp = await fetch(subUrl, { headers: { 'Referer': location.href } });
            const subJson = await subJsonResp.json();
            if (subJson?.body?.length) {
              const text = formatBilibiliSubs(subJson.body);
              logSubtitle('⑤ 重试WBI', text);
              return text;
            }
          }
        }
      }
    } catch (_) {}

    return null;
  } catch (_) {
    return null;
  }
}

function getMainVideoElement(): HTMLVideoElement | null {
  const bili = document.querySelector('.bpx-player-video-wrap video') as HTMLVideoElement;
  if (bili && bili.offsetParent !== null) return bili;
  const yt = document.querySelector('.html5-main-video') as HTMLVideoElement;
  if (yt && yt.offsetParent !== null) return yt;
  let best: HTMLVideoElement | null = null, bestArea = 0;
  document.querySelectorAll('video').forEach(v => {
    if ((v as HTMLVideoElement).offsetParent === null) return;
    const rect = v.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) { bestArea = area; best = v; }
  });
  return best || document.querySelector('video');
}

// ---- 字幕获取入口 ----

let subtitleFetchPromise: Promise<string | null> | null = null;
let lastSubtitleResult: string | null = null;
let lastSubtitleUrl = '';
let lastSubtitleCached = false;

export async function fetchVideoSubtitles(): Promise<string | null> {
  if (subtitleFetchPromise) return subtitleFetchPromise;
  if (location.href === lastSubtitleUrl && lastSubtitleCached) return lastSubtitleResult;

  const host = location.hostname;
  const startUrl = location.href;

  if (host.includes('bilibili.com') && !location.pathname.match(/\/video\/(BV|av)/)) return null;
  if (host.includes('youtube.com') && location.pathname !== '/watch') return null;
  if (host.includes('youtu.be') && location.pathname === '/') return null;

  subtitleFetchPromise = (async () => {
    let result = null;
    if (host.includes('youtube.com') || host.includes('youtu.be')) result = await fetchYouTubeCaptions();
    else if (host.includes('bilibili.com')) result = await fetchBilibiliCaptions();
    if (location.href !== startUrl) return null;
    return result;
  })();

  try {
    const ret = await subtitleFetchPromise;
    if (location.href === startUrl) {
      lastSubtitleResult = ret;
      lastSubtitleUrl = startUrl;
      lastSubtitleCached = true;
    }
    return ret;
  } finally {
    subtitleFetchPromise = null;
  }
}

// ---- 页面脚本字幕钩子 ----

export function setupSubtitleHook(): void {
  window.addEventListener('__knowseek_subtitle', ((e: CustomEvent) => {
    if (e.detail && e.detail.length > 10) {
      cachedSubtitles = e.detail;
      cachedSubtitlesUrl = location.href;
    }
  }) as EventListener);
}

// ---- SPA 导航检测 ----

let lastKnownUrl = location.href;

function checkUrlChange(): void {
  const now = location.href;
  if (now !== lastKnownUrl) {
    cachedSubtitles = null;
    cachedSubtitlesUrl = '';
    lastKnownUrl = now;
    setTimeout(() => {
      fetchVideoSubtitles().then(s => {
        if (s) { cachedSubtitles = s; cachedSubtitlesUrl = location.href; }
      });
    }, 3000);
  }
}

export function setupSpaNavigationDetection(): void {
  const origPushState = history.pushState;
  history.pushState = function(...args) {
    const r = origPushState.apply(this, args);
    checkUrlChange();
    return r;
  };
  const origReplaceState = history.replaceState;
  history.replaceState = function(...args) {
    const r = origReplaceState.apply(this, args);
    checkUrlChange();
    return r;
  };
  window.addEventListener('popstate', checkUrlChange);

  const titleObserver = new MutationObserver(() => {
    if (location.href !== lastKnownUrl) checkUrlChange();
  });
  const titleEl = document.querySelector('title');
  if (titleEl) titleObserver.observe(titleEl, { childList: true, subtree: true });
}

// ---- 页面加载预抓取 ----

export function setupAutoFetchSubtitles(): void {
  if (document.readyState === 'complete') {
    setTimeout(() => {
      fetchVideoSubtitles().then(s => {
        if (s) { cachedSubtitles = s; cachedSubtitlesUrl = location.href; }
        chrome.runtime.sendMessage({ action: 'subtitlesReady', hasSubtitles: !!s }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
      });
    }, 2000);
  } else {
    window.addEventListener('load', () => {
      setTimeout(() => {
        fetchVideoSubtitles().then(s => {
          if (s) { cachedSubtitles = s; cachedSubtitlesUrl = location.href; }
          chrome.runtime.sendMessage({ action: 'subtitlesReady', hasSubtitles: !!s }, () => { if (chrome.runtime.lastError) { /* 忽略 */ } });
        });
      }, 2000);
    });
  }
}

/** 从 Bilibili 页面提取视频直链（不依赖 blob: URL）
 *  优先级：① __playinfo__（无需 API 调用）② player/wbi/v2 API */
export async function resolveBilibiliVideoUrl(): Promise<string | null> {
  try {
    // 优先级 1：window.__playinfo__（B 站注入的播放信息，零网络请求）
    const playinfo = (window as any).__playinfo__;
    if (playinfo?.data) {
      const dash = playinfo.data.dash?.video;
      if (dash?.length > 0) {
        return dash[0].baseUrl || dash[0].backup_url?.[0] || null;
      }
      const durl = playinfo.data.durl;
      if (durl?.length > 0) {
        return durl[0].url || durl[0].backup_url?.[0] || null;
      }
    }

    // 优先级 2：通过 player/wbi/v2 API 获取
    const pathMatch = location.pathname.match(/\/video\/([^/?#]+)/);
    if (!pathMatch) return null;
    const rawId = pathMatch[1];
    const isAv = rawId.startsWith('av');
    const queryParam = isAv ? 'aid=' + rawId.replace('av', '') : 'bvid=' + rawId;

    const infoResp = await fetch(`https://api.bilibili.com/x/web-interface/view?${queryParam}`, {
      headers: { 'Referer': location.href, 'User-Agent': navigator.userAgent },
      credentials: 'include',
    });
    if (!infoResp.ok) return null;
    const info = await infoResp.json();
    if (info.code !== 0) return null;

    const cid = info.data?.cid;
    const aid = info.data?.aid;
    if (!cid || !aid) return null;

    const subParams = { cid: String(cid), aid: String(aid), fourk: '1' };
    const signedParams = await signWbi(subParams);
    const wbiQuery = Object.entries(signedParams).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const playResp = await fetch(`https://api.bilibili.com/x/player/wbi/v2?${wbiQuery}`, {
      headers: { 'Referer': location.href, 'User-Agent': navigator.userAgent },
      credentials: 'include',
    });
    if (!playResp.ok) return null;
    const playData = await playResp.json();
    if (playData.code !== 0) return null;

    const dash = playData?.data?.dash?.video;
    if (dash?.length > 0) {
      return dash[0].baseUrl || dash[0].backup_url?.[0] || null;
    }
    const durl = playData?.data?.durl;
    if (durl?.length > 0) {
      return durl[0].url || durl[0].backup_url?.[0] || null;
    }
  } catch {}
  return null;
}