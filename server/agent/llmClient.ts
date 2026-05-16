import type { ModelConfig } from '../types/events';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

export type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type ChatCompletionResponse = {
  choices: Array<{
    message: {
      role: 'assistant';
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string;
  }>;
};

export async function requestChatCompletion(
  config: ModelConfig,
  messages: ChatMessage[],
  tools: unknown[] = [],
  signal?: AbortSignal
): Promise<ChatCompletionResponse> {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: 0.2
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 800)}`);
  }

  return (await response.json()) as ChatCompletionResponse;
}
