import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildSystemPrompt, buildUserPrompt, runCodeToolDefinition } from './prompts';
import { requestChatCompletion, type ChatMessage } from './llmClient';
import { normalizeBlocks, parseReportPayload } from './reportParser';
import { runCode } from '../tools/runCode';
import type { AgentEvent, ModelConfig, ReportBlock } from '../types/events';

export type AgentLoopInput = {
  taskId: string;
  filePath: string;
  fileName: string;
  filePaths?: string[];
  fileNames?: string[];
  requirement: string;
  modelConfig: ModelConfig;
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
};

const MAX_TURNS = 12;

export async function runAgentLoop(input: AgentLoopInput): Promise<void> {
  const blocks: ReportBlock[] = [];
  const workDir = path.resolve('server', 'storage', 'tasks', input.taskId);
  await mkdir(workDir, { recursive: true });
  let successfulToolRuns = 0;

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(input.requirement, input.fileNames ?? [input.fileName]) }
  ];

  throwIfCancelled(input.signal);
  input.emit({
    type: 'action',
    taskId: input.taskId,
    id: randomUUID(),
    title: '启动分析任务',
    summary: '已收到文件、分析需求和模型配置，开始规划数据复盘。',
    status: 'completed'
  });

  for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
    throwIfCancelled(input.signal);
    const decisionActionId = randomUUID();
    input.emit({
      type: 'action',
      taskId: input.taskId,
      id: decisionActionId,
      title: `请求模型决策 ${turn}`,
      summary: '模型正在基于前序操作决定下一步。',
      status: 'running'
    });

    const completion = await requestChatCompletion(input.modelConfig, messages, [runCodeToolDefinition], input.signal);
    const assistant = completion.choices[0]?.message;

    if (!assistant) {
      throw new Error('LLM returned no assistant message.');
    }

    input.emit({
      type: 'action',
      taskId: input.taskId,
      id: decisionActionId,
      title: `请求模型决策 ${turn}`,
      summary: '模型已返回下一步决策。',
      status: 'completed',
      detail: {
        hasContent: Boolean(assistant.content),
        toolCalls: assistant.tool_calls?.map((toolCall) => toolCall.function.name) ?? []
      }
    });

    messages.push({
      role: 'assistant',
      content: assistant.content ?? null,
      reasoning_content: assistant.reasoning_content,
      tool_calls: assistant.tool_calls
    });

    const toolCalls = assistant.tool_calls ?? [];
    if (toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        if (toolCall.function.name !== 'run_code') {
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ ok: false, error: `Unknown tool: ${toolCall.function.name}` })
          });
          continue;
        }

        const args = parseToolArgs(toolCall.function.arguments);
        const actionId = randomUUID();
        input.emit({
          type: 'action',
          taskId: input.taskId,
          id: actionId,
          title: '执行 Python 分析代码',
          summary: args.summary,
          status: 'running',
          detail: { code: args.code }
        });

        const result = await runCode({
          code: args.code,
          dataFile: input.filePath,
          dataFiles: input.filePaths ?? [input.filePath],
          workDir,
          signal: input.signal
        });
        if (result.ok) {
          successfulToolRuns += 1;
        }

        input.emit({
          type: 'action',
          taskId: input.taskId,
          id: actionId,
          title: '执行 Python 分析代码',
          summary: result.ok ? `${args.summary}，执行完成。` : `${args.summary}，执行失败，等待模型修正。`,
          status: result.ok ? 'completed' : 'failed',
          detail: { code: args.code, result }
        });

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      }
      if (successfulToolRuns >= 4) {
        messages.push({
          role: 'user',
          content:
            '你已经完成多轮数据读取、统计和图表数据生成。除非仍缺少关键数据，否则不要继续调用 run_code。请直接输出 final JSON，blocks 中必须包含 Markdown 复盘结论和至少 2 个 ECharts chart option。'
        });
      }
      continue;
    }

    const payload = parseReportPayload(assistant.content);
    if (!payload) {
      input.emit({
        type: 'action',
        taskId: input.taskId,
        id: randomUUID(),
        title: '模型输出格式修正',
        summary: '模型返回了非约定 JSON 内容，已要求其改为输出阶段结论或最终报告。',
        status: 'failed',
        detail: { contentPreview: assistant.content?.slice(0, 1200) ?? '' }
      });
      messages.push({
        role: 'user',
        content:
          '你的上一条回复不是约定 JSON 格式。现在不要调用 run_code，请只返回包含 action、summary、blocks 的 JSON。若已有足够分析结果，请返回 action="final"，并包含 Markdown 结论和 ECharts 图表。'
      });
      continue;
    }

    const newBlocks = normalizeBlocks(payload.blocks);
    blocks.push(...newBlocks);
    for (const block of newBlocks) {
      input.emit({ type: 'analysis', taskId: input.taskId, block });
    }

    if (payload.action === 'final') {
      input.emit({
        type: 'action',
        taskId: input.taskId,
        id: decisionActionId,
        title: `请求模型决策 ${turn}`,
        summary: '模型已返回下一步决策，报告已生成。',
        status: 'completed',
        detail: {
          hasContent: Boolean(assistant.content),
          toolCalls: []
        }
      });
      input.emit({
        type: 'final',
        taskId: input.taskId,
        blocks,
        summary: payload.summary ?? '分析报告已完成。'
      });
      input.emit({ type: 'done', taskId: input.taskId });
      return;
    }

    messages.push({
      role: 'user',
      content: '阶段性分析已展示给用户。请基于当前结论和工具结果继续决定下一步：调用 run_code 深入分析，或在足够完整时输出 final JSON。'
    });
  }

  input.emit({
    type: 'final',
    taskId: input.taskId,
    blocks,
    summary: '已达到最大推理轮次，返回当前阶段的分析结果。'
  });
  input.emit({ type: 'done', taskId: input.taskId });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('TASK_CANCELLED');
  }
}

function parseToolArgs(raw: string): { summary: string; code: string } {
  try {
    const parsed = JSON.parse(raw) as { summary?: unknown; code?: unknown };
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '运行数据分析代码',
      code: typeof parsed.code === 'string' ? parsed.code : ''
    };
  } catch {
    return { summary: '运行数据分析代码', code: raw };
  }
}
