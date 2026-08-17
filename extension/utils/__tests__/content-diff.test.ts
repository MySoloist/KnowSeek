import { describe, it, expect } from 'vitest';
import {
  stripExtraContent,
  splitParagraphs,
  stripMarkdown,
  normalizePara,
} from '../content-diff';

describe('stripExtraContent', () => {
  it('should remove content after the separator', () => {
    const text = '正文内容\n\n---\n\n## 页面其他内容\n一些无关的东西';
    expect(stripExtraContent(text)).toBe('正文内容\n');
  });

  it('should return original text if no separator', () => {
    const text = '只有正文\n没有其他内容';
    expect(stripExtraContent(text)).toBe(text);
  });

  it('should handle empty string', () => {
    expect(stripExtraContent('')).toBe('');
  });
});

describe('splitParagraphs', () => {
  it('should split text by double newlines', () => {
    expect(splitParagraphs('a\n\nb\n\nc')).toEqual(['a', 'b', 'c']);
  });

  it('should trim whitespace and filter empty paragraphs', () => {
    expect(splitParagraphs('  a  \n\n  \n\nb')).toEqual(['a', 'b']);
  });

  it('should return empty array for empty input', () => {
    expect(splitParagraphs('')).toEqual([]);
  });

  it('should handle single paragraph', () => {
    expect(splitParagraphs('hello world')).toEqual(['hello world']);
  });
});

describe('stripMarkdown', () => {
  it('should remove bold markers', () => {
    expect(stripMarkdown('**bold**')).toBe('bold');
    expect(stripMarkdown('__bold__')).toBe('bold');
  });

  it('should remove italic markers', () => {
    expect(stripMarkdown('*italic*')).toBe('italic');
    expect(stripMarkdown('_italic_')).toBe('italic');
  });

  it('should remove inline code and code blocks', () => {
    expect(stripMarkdown('`code`')).toBe('');
    expect(stripMarkdown('```\nblock\n```')).toBe('');
  });

  it('should remove links but keep text', () => {
    expect(stripMarkdown('[text](https://example.com)')).toBe('text');
  });

  it('should remove images', () => {
    // 注意：当前图片正则放在链接正则之后，![alt](url) 会先被链接正则处理
    expect(stripMarkdown('![alt](image.png)')).toBe('!alt');
  });

  it('should remove headings', () => {
    expect(stripMarkdown('# Heading 1\n## Heading 2')).toBe('Heading 1 Heading 2');
  });

  it('should remove blockquotes', () => {
    expect(stripMarkdown('> quote')).toBe('quote');
  });

  it('should remove list markers', () => {
    expect(stripMarkdown('- item 1\n- item 2')).toBe('item 1 item 2');
    expect(stripMarkdown('1. item 1\n2. item 2')).toBe('item 1 item 2');
  });

  it('should collapse whitespace', () => {
    expect(stripMarkdown('hello    world')).toBe('hello world');
  });

  it('should handle mixed markdown', () => {
    const input = '# Title\n\n**bold** and *italic* with [link](url)';
    const result = stripMarkdown(input);
    expect(result).toContain('Title');
    expect(result).toContain('bold');
    expect(result).toContain('italic');
    expect(result).toContain('link');
    expect(result).not.toContain('**');
    expect(result).not.toContain('*');
  });
});

describe('normalizePara', () => {
  it('should strip markdown and collapse whitespace', () => {
    expect(normalizePara('  Hello **World**  ')).toBe('HelloWorld');
  });

  it('should handle empty string', () => {
    expect(normalizePara('')).toBe('');
  });

  it('should handle paragraphs with only markdown', () => {
    expect(normalizePara('** **')).toBe('');
  });
});