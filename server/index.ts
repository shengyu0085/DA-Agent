import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { cancelTask, createTask, getTask, getUpload, pushTaskEvent, rememberUpload } from './agent/taskStore';
import { runAgentLoop } from './agent/agentLoop';
import { requestChatCompletion, type ChatMessage } from './agent/llmClient';
import type { AgentEvent, ModelConfig, StartTaskBody } from './types/events';

const PORT = Number(process.env.PORT ?? 8787);
const uploadDir = path.resolve('server', 'storage', 'uploads');
await mkdir(uploadDir, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

const subscribers = new Map<string, Set<(event: AgentEvent) => void>>();

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: '请上传 Excel 或 CSV 文件。' });
    return;
  }
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!['.xlsx', '.xls', '.csv'].includes(ext)) {
    res.status(400).json({ error: '仅支持 .xlsx、.xls 或 .csv 文件。' });
    return;
  }

  const uploadId = randomUUID();
  rememberUpload(uploadId, req.file.path, req.file.originalname);
  res.json({ uploadId, fileName: req.file.originalname });
});

app.post('/api/tasks', (req, res) => {
  const body = req.body as StartTaskBody;
  const uploadIds = body.uploadIds?.length ? body.uploadIds : body.uploadId ? [body.uploadId] : [];
  const uploadInfos = uploadIds.map((uploadId) => getUpload(uploadId));

  if (uploadInfos.length === 0 || uploadInfos.some((uploadInfo) => !uploadInfo)) {
    res.status(400).json({ error: '上传文件不存在或已失效。' });
    return;
  }
  if (!body.requirement?.trim()) {
    res.status(400).json({ error: '请输入分析需求。' });
    return;
  }
  if (!body.modelConfig?.model || !body.modelConfig?.baseUrl || !body.modelConfig?.apiKey) {
    res.status(400).json({ error: '请完整填写模型名称、base_url 和 API-KEY。' });
    return;
  }

  const taskId = randomUUID();
  const abortController = new AbortController();
  const firstUpload = uploadInfos[0]!;
  const filePaths = uploadInfos.map((uploadInfo) => uploadInfo!.filePath);
  const fileNames = uploadInfos.map((uploadInfo) => uploadInfo!.fileName);
  createTask({
    id: taskId,
    uploadId: uploadIds[0],
    filePath: firstUpload.filePath,
    fileName: fileNames.join(', '),
    requirement: body.requirement,
    events: [],
    abortController,
    startedAt: Date.now()
  });

  queueMicrotask(() => {
    runAgentLoop({
      taskId,
      filePath: firstUpload.filePath,
      fileName: fileNames.join(', '),
      filePaths,
      fileNames,
      requirement: body.requirement,
      modelConfig: body.modelConfig,
      signal: abortController.signal,
      emit: (event) => broadcast(taskId, event)
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (abortController.signal.aborted || message === 'TASK_CANCELLED' || message.includes('aborted')) {
        broadcast(taskId, { type: 'cancelled', taskId, message: '任务已停止。' });
        broadcast(taskId, { type: 'done', taskId });
        return;
      }
      broadcast(taskId, { type: 'error', taskId, message });
      broadcast(taskId, { type: 'done', taskId });
    });
  });

  res.json({ taskId });
});

app.post('/api/chat', async (req, res) => {
  const body = req.body as { message?: string; modelConfig?: ModelConfig; history?: ChatMessage[]; context?: string };
  if (!body.message?.trim()) {
    res.status(400).json({ error: '请输入消息。' });
    return;
  }
  if (!body.modelConfig?.model || !body.modelConfig?.baseUrl || !body.modelConfig?.apiKey) {
    res.status(400).json({ error: '请完整填写模型名称、base_url 和 API-KEY。' });
    return;
  }

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是观数 Agent，一个数据复盘与分析智能体，也可以进行普通聊天。所有用户消息、数据分析请求、报告结果和后续追问都属于同一次连续会话。回答时必须结合完整上下文和用户最新问题，不要把普通聊天与数据分析追问割裂处理。'
    },
    ...(body.context
      ? [
          {
            role: 'system' as const,
            content: `以下是当前页面已经生成的数据复盘报告上下文。它也是本次连续会话的一部分。若用户最新问题涉及这份报告，请基于报告回答；若最新问题是普通聊天，则自然回答。\n\n${body.context.slice(0, 12000)}`
          }
        ]
      : []),
    ...(Array.isArray(body.history) ? body.history.slice(-8) : []),
    { role: 'user', content: body.message }
  ];

  try {
    const completion = await requestChatCompletion(body.modelConfig, messages);
    res.json({ content: completion.choices[0]?.message.content ?? '模型没有返回内容。' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

app.delete('/api/tasks/:taskId', (req, res) => {
  const ok = cancelTask(req.params.taskId);
  if (!ok) {
    res.status(404).json({ error: '任务不存在或已结束。' });
    return;
  }
  broadcast(req.params.taskId, { type: 'cancelled', taskId: req.params.taskId, message: '任务已停止。' });
  broadcast(req.params.taskId, { type: 'done', taskId: req.params.taskId });
  res.json({ ok: true });
});

app.get('/api/tasks/:taskId/events', (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: '任务不存在。' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  for (const event of task.events) {
    writeSse(res, event);
  }

  const listener = (event: AgentEvent) => writeSse(res, event);
  const set = subscribers.get(task.id) ?? new Set();
  set.add(listener);
  subscribers.set(task.id, set);

  req.on('close', () => {
    const listeners = subscribers.get(task.id);
    listeners?.delete(listener);
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Data retro agent server listening on http://localhost:${PORT}`);
});

function broadcast(taskId: string, event: AgentEvent): void {
  pushTaskEvent(taskId, event);
  const listeners = subscribers.get(taskId);
  for (const listener of listeners ?? []) {
    listener(event);
  }
}

function writeSse(res: express.Response, event: AgentEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
