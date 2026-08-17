/** 去掉不稳定的「页面其他内容」部分，只保留 Readability 提取的正文 */
export function stripExtraContent(text: string): string {
  const idx = text.indexOf('\n---\n\n## 页面其他内容');
  return idx >= 0 ? text.slice(0, idx) : text;
}

/** 按段落分割文本 */
export function splitParagraphs(text: string): string[] {
  return text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 0);
}

/** 去除 Markdown 格式，只保留纯文本用于对比 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')       // **bold**
    .replace(/__(.+?)__/g, '$1')           // __bold__
    .replace(/\*(.+?)\*/g, '$1')           // *italic*
    .replace(/_(.+?)_/g, '$1')             // _italic_
    .replace(/`{1,3}[^`]*`{1,3}/g, '')     // inline code / code blocks
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // ![alt](url)
    .replace(/^#{1,6}\s+/gm, '')           // headings
    .replace(/^>\s+/gm, '')                // blockquotes
    .replace(/^[-*+]\s+/gm, '')            // unordered list items
    .replace(/^\d+\.\s+/gm, '')            // ordered list items
    .replace(/\|/g, ' ')                   // table separators
    .replace(/[-]{3,}/g, '')               // horizontal rules
    .replace(/<\/?[^>]+>/g, '')            // any remaining HTML tags
    .replace(/\s+/g, ' ')                  // collapse whitespace
    .trim();
}

/** 规范化段落：去 Markdown + 去空白，用于精确匹配 */
export function normalizePara(p: string): string {
  return stripMarkdown(p).replace(/\s+/g, '').trim();
}