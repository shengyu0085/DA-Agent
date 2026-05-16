export type ReportBlock =
  | { id: string; type: 'markdown'; title?: string; content: string }
  | { id: string; type: 'chart'; title?: string; option: unknown }
  | { id: string; type: 'mermaid'; title?: string; content: string };

export type AgentEvent =
  | {
      type: 'action';
      taskId: string;
      id: string;
      title: string;
      summary: string;
      status: 'running' | 'completed' | 'failed';
      detail?: unknown;
    }
  | { type: 'analysis'; taskId: string; block: ReportBlock }
  | { type: 'final'; taskId: string; blocks: ReportBlock[]; summary: string }
  | { type: 'error'; taskId: string; message: string; detail?: unknown }
  | { type: 'cancelled'; taskId: string; message: string }
  | { type: 'done'; taskId: string };

export type ActionEvent = Extract<AgentEvent, { type: 'action' }>;

export type ModelConfig = {
  model: string;
  baseUrl: string;
  apiKey: string;
};
