// =========== 页面文本提取 ===========
// 使用 Readability + Turndown 提取网页正文

import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { cachedSubtitles, cachedSubtitlesUrl } from './state';

/** 提取网页正文（Readability + Turndown） */
export function getPageText(): string {
  function fallback(): string {
    const bodyText = document.body ? document.body.innerText || '' : '';
    if (bodyText) return bodyText;
    return document.documentElement ? document.documentElement.innerText || '' : '';
  }

  let article: ReturnType<Readability['parse']> = null;
  let turndown: TurndownService | null = null;

  let clone: Document;
  try {
    clone = document.cloneNode(true) as Document;
    clone.querySelectorAll('script,style,svg,.wa-toolbar,.wa-radial-menu').forEach(el => el.remove());
  } catch (_) {
    return fallback();
  }

  try {
    const reader = new Readability(clone);
    article = reader.parse();
  } catch (_) {}

  try {
    turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced'
    });
  } catch (_) {}

  if (article && article.content && turndown) {
    try {
      const articleMd = turndown.turndown(article.content);
      let result = `# ${article.title || ''}\n\n${articleMd}`;

      try {
        const fullText = document.body ? document.body.innerText || '' : '';
        const articleText = article.textContent || '';
        const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
        const normFull = norm(fullText);
        const normArticle = norm(articleText);

        if (normArticle && normFull.includes(normArticle)) {
          const idx = normFull.indexOf(normArticle);
          const before = normFull.slice(0, idx);
          const after = normFull.slice(idx + normArticle.length);
          const restNorm = (before + ' ' + after).trim();
          if (restNorm.length > 60) {
            const MAX_REST = 3000;
            result += `\n\n---\n\n## 页面其他内容（纯文本摘要）\n\n${restNorm.slice(0, MAX_REST)}`;
          }
        } else if (clone.body) {
          const restText = (clone.body.innerText || '').trim();
          if (restText.length > 60) {
            const MAX_REST = 3000;
            result += `\n\n---\n\n## 页面其他内容（纯文本摘要）\n\n${restText.slice(0, MAX_REST)}`;
          }
        }
      } catch (_) {}

      return result;
    } catch (_) {}
  }

  if (turndown && clone && clone.body) {
    try {
      const md = turndown.turndown(clone.body);
      if (md && md.trim()) return md;
    } catch (_) {}
  }

  return fallback();
}

/** 获取带字幕的页面上下文（用于 AI 对话） */
export function getPageContentForAI(): string {
  let pageContent = getPageText();
  if (cachedSubtitles && cachedSubtitlesUrl === location.href) {
    pageContent += '\n\n---\n\n## 视频字幕\n\n' + cachedSubtitles;
  }
  return pageContent;
}

/** 提取正文区域中有意义的图片，返回 base64 数组 */
export async function extractPageImages(): Promise<Array<{ base64: string; alt: string }>> {
  const results: Array<{ base64: string; alt: string }> = [];
  try {
    // 在正文区域内查找 img
    const article = document.querySelector('article, [role="main"], .post-content, .article-content, .entry-content, .content');
    const container = article || document.body;
    const imgs = container.querySelectorAll<HTMLImageElement>('img:not([aria-hidden="true"])');
    const seen = new Set<string>();

    for (const img of imgs) {
      if (!img.src || !img.src.startsWith('http')) continue;
      if (img.width < 100 && img.height < 100) continue; // 过滤图标
      if (seen.has(img.src)) continue;
      seen.add(img.src);

      try {
        // 先尝试直接 fetch
        let blob: Blob | null = null;
        try {
          const resp = await fetch(img.src, { signal: AbortSignal.timeout(5000) });
          if (resp.ok) blob = await resp.blob();
        } catch {
          // 直接 fetch 失败（通常是 CORS），尝试通过 background proxy
          try {
            const resp = await new Promise<any>(r => chrome.runtime.sendMessage({ action: 'fetchImageProxy', url: img.src }, (res) => {
              if (chrome.runtime.lastError) { r(null); return; }
              r(res);
            }));
            if (resp?.blob) blob = resp.blob;
          } catch {}
        }
        if (!blob || blob.size < 1024) continue;
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
        results.push({ base64, alt: img.alt || '' });
      } catch {
        // 单个图片失败跳过
      }
    }
  } catch {
    // 整体失败返回空
  }
  return results;
}