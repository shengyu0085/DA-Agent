import { randomUUID } from 'node:crypto';
import type { ReportBlock } from '../types/events';

type LlmReportPayload = {
  action?: 'analysis' | 'final';
  summary?: string;
  blocks?: Array<Record<string, unknown>>;
};

export function parseReportPayload(content: string | null | undefined): LlmReportPayload | null {
  if (!content) return null;
  const trimmed = content.trim();
  const jsonText = extractJson(trimmed);
  if (!jsonText) return null;

  try {
    return JSON.parse(jsonText) as LlmReportPayload;
  } catch {
    return null;
  }
}

export function normalizeBlocks(blocks: LlmReportPayload['blocks']): ReportBlock[] {
  if (!Array.isArray(blocks)) return [];

  const normalized: ReportBlock[] = [];
  for (const block of blocks) {
    const title = typeof block.title === 'string' ? block.title : undefined;
    if (block.type === 'markdown' && typeof block.content === 'string') {
      normalized.push({ id: randomUUID(), type: 'markdown', title, content: block.content });
      continue;
    }
    if (block.type === 'mermaid' && typeof block.content === 'string') {
      normalized.push({ id: randomUUID(), type: 'mermaid', title, content: block.content });
      continue;
    }
    if (block.type === 'chart' && block.option && typeof block.option === 'object') {
      normalized.push({ id: randomUUID(), type: 'chart', title, option: block.option });
    }
  }
  return normalized;
}

function extractJson(text: string): string | null {
  if (text.startsWith('{') && text.endsWith('}')) return text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}
