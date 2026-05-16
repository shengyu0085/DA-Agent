import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ActionTimeline } from './components/ActionTimeline';
import { ReportBlockView } from './components/ReportBlockView';
import type { ActionEvent, AgentEvent, ModelConfig, ReportBlock } from './types/agent';

const defaultRequirement = '请分析这份表格的核心指标变化、异常点、原因假设和可执行建议，并输出包含图表的复盘报告。';

type UserMessage = {
  fileNames?: string[];
  requirement: string;
};

type ConversationMemoryMessage = { role: 'user' | 'assistant'; content: string };
type ChatMessage = { role: 'user' | 'assistant'; content: string };
type HistoryItem = {
  id: string;
  createdAt: string;
  title: string;
  status: string;
  taskId: string | null;
  isRunning: boolean;
  userMessage: UserMessage | null;
  chatMessages: ChatMessage[];
  actions: ActionEvent[];
  blocks: ReportBlock[];
  conversationMemory: ConversationMemoryMessage[];
  analysisStartIndex: number | null;
};

const historyStorageKey = 'guanshu-agent-history';

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [requirement, setRequirement] = useState('');
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    model: '',
    baseUrl: '',
    apiKey: ''
  });
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [actions, setActions] = useState<ActionEvent[]>([]);
  const [blocks, setBlocks] = useState<ReportBlock[]>([]);
  const [status, setStatus] = useState('等待开始');
  const [isRunning, setIsRunning] = useState(false);
  const [isChatThinking, setIsChatThinking] = useState(false);
  const [userMessage, setUserMessage] = useState<UserMessage | null>(null);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [analysisStartIndex, setAnalysisStartIndex] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistory());
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const userMessageRef = useRef<UserMessage | null>(null);
  const actionsRef = useRef<ActionEvent[]>([]);
  const blocksRef = useRef<ReportBlock[]>([]);
  const conversationMemoryRef = useRef<ConversationMemoryMessage[]>([]);
  const currentSessionIdRef = useRef<string | null>(null);
  const currentTaskIdRef = useRef<string | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chatMessages.length, actions.length, blocks.length, userMessage, isChatThinking, isRunning, status]);

  const canSubmit = useMemo(
    () => Boolean(requirement.trim() && !isRunning),
    [requirement, isRunning]
  );
  const isModelReady = Boolean(modelConfig.model && modelConfig.baseUrl && modelConfig.apiKey);
  const hasSession = Boolean(userMessage || chatMessages.length > 0 || actions.length > 0 || blocks.length > 0);

  async function startTask(event: FormEvent) {
    event.preventDefault();
    if (!requirement.trim()) return;
    if (!isModelReady) {
      setStatus('请先完成模型配置。');
      setIsConfigOpen(true);
      return;
    }
    if (files.length === 0) {
      await sendChatMessage(requirement, blocksRef.current);
      return;
    }

    setIsRunning(true);
    setActions([]);
    actionsRef.current = [];
    setBlocks([]);
    blocksRef.current = [];
    const nextUserMessage = { fileNames: files.map((selectedFile) => selectedFile.name), requirement };
    setAnalysisStartIndex(chatMessages.length);
    setUserMessage(nextUserMessage);
    userMessageRef.current = nextUserMessage;
    appendConversationMemory('user', `请基于以下文件进行数据分析。\n文件：${nextUserMessage.fileNames.join(', ')}\n分析需求：${requirement}`);
    setStatus('上传文件中');

    try {
      const uploadIds = await Promise.all(
        files.map(async (selectedFile) => {
          const formData = new FormData();
          formData.append('file', selectedFile);
          const uploadResponse = await fetch('/api/upload', { method: 'POST', body: formData });
          const uploadData = await parseJson(uploadResponse);
          return uploadData.uploadId as string;
        })
      );

      setStatus('启动 Agent 任务');
      const taskResponse = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uploadIds,
          requirement,
          modelConfig
        })
      });
      const taskData = await parseJson(taskResponse);

      setCurrentTaskId(taskData.taskId);
      currentTaskIdRef.current = taskData.taskId;
      subscribeToTask(taskData.taskId);
      setRequirement('');
      setFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      setStatus('Agent 正在分析');
      saveSessionSnapshot({ status: 'Agent 正在分析', taskId: taskData.taskId, isRunning: true });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setIsRunning(false);
    }
  }

  async function sendChatMessage(message: string, contextBlocks: ReportBlock[] = []) {
    appendConversationMemory('user', message);
    setIsRunning(true);
    setIsChatThinking(true);
    setStatus('Agent 正在思考');
    setChatMessages((current) => [...current, { role: 'user', content: message }]);
    setRequirement('');

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          modelConfig,
          history: conversationMemoryRef.current,
          context: contextBlocks.length > 0 ? summarizeReportContext(contextBlocks, userMessageRef.current) : ''
        })
      });
      const data = await parseJson(response);
      appendConversationMemory('assistant', data.content);
      const nextMessages = [...chatMessages, { role: 'user' as const, content: message }, { role: 'assistant' as const, content: data.content }];
      setChatMessages(nextMessages);
      setStatus(contextBlocks.length > 0 ? '已基于当前报告回复' : '等待开始');
      saveSessionSnapshot({
        status: contextBlocks.length > 0 ? '已基于当前报告回复' : '普通对话',
        chatMessages: nextMessages
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      appendConversationMemory('assistant', messageText);
      const nextMessages = [...chatMessages, { role: 'user' as const, content: message }, { role: 'assistant' as const, content: messageText }];
      setChatMessages(nextMessages);
      setStatus(messageText);
      saveSessionSnapshot({ status: messageText, chatMessages: nextMessages });
    } finally {
      setIsChatThinking(false);
      setIsRunning(false);
    }
  }

  function subscribeToTask(taskId: string) {
    eventSourceRef.current?.close();
    const source = new EventSource(`/api/tasks/${taskId}/events`);
    let completed = false;
    eventSourceRef.current = source;

    const handleEvent = (raw: MessageEvent) => {
      const event = JSON.parse(raw.data) as AgentEvent;
      if (event.type === 'action') {
        setActions((current) => {
          const next = upsertAction(current, event);
          actionsRef.current = next;
          saveSessionSnapshot({ actions: next, taskId, isRunning: true, status });
          return next;
        });
      }
      if (event.type === 'analysis') {
        setBlocks((current) => {
          const next = appendUniqueBlock(current, event.block);
          blocksRef.current = next;
          saveSessionSnapshot({ blocks: next, taskId, isRunning: true, status });
          return next;
        });
      }
      if (event.type === 'final') {
        setBlocks(event.blocks);
        blocksRef.current = event.blocks;
        setStatus(event.summary);
        appendConversationMemory('assistant', summarizeReportContext(event.blocks, userMessageRef.current));
        saveSessionSnapshot({ status: event.summary, blocks: event.blocks, taskId, isRunning: false });
      }
      if (event.type === 'error') {
        completed = true;
        setStatus(event.message);
        setIsRunning(false);
        appendConversationMemory('assistant', `数据分析任务失败：${event.message}`);
        saveSessionSnapshot({ status: event.message, taskId, isRunning: false });
      }
      if (event.type === 'cancelled') {
        completed = true;
        setStatus(event.message);
        setIsRunning(false);
        settleRunningActions(event.message);
        appendConversationMemory('assistant', `数据分析任务已停止：${event.message}`);
        saveSessionSnapshot({ status: event.message, taskId, isRunning: false });
      }
      if (event.type === 'done') {
        completed = true;
        setIsRunning(false);
        saveSessionSnapshot({ taskId, isRunning: false });
        source.close();
      }
    };

    ['action', 'analysis', 'final', 'error', 'cancelled', 'done'].forEach((type) => {
      source.addEventListener(type, handleEvent);
    });
    source.onopen = () => setStatus('Agent 正在分析');

    source.onerror = () => {
      if (!completed) {
        setStatus('事件流连接中断，请检查后端服务。');
        setIsRunning(false);
      }
      source.close();
    };
  }

  async function stopTask() {
    if (!currentTaskId) return;
    setStatus('正在停止任务...');
    await fetch(`/api/tasks/${currentTaskId}`, { method: 'DELETE' });
    eventSourceRef.current?.close();
    setIsRunning(false);
    saveSessionSnapshot({ status: '任务已停止。', taskId: currentTaskId, isRunning: false });
  }

  function settleRunningActions(message: string) {
    const next = stopRunningActions(actionsRef.current, message);
    actionsRef.current = next;
    setActions(next);
  }

  function appendConversationMemory(role: ConversationMemoryMessage['role'], content: string) {
    const next = [...conversationMemoryRef.current, { role, content: content.slice(0, 12000) }];
    conversationMemoryRef.current = next.slice(-24);
  }

  function startNewSession() {
    if (hasSession) {
      saveSessionSnapshot({ taskId: currentTaskIdRef.current, isRunning });
    }
    eventSourceRef.current?.close();
    setFiles([]);
    setRequirement('');
    setActions([]);
    actionsRef.current = [];
    setBlocks([]);
    blocksRef.current = [];
    setStatus('等待开始');
    setIsRunning(false);
    setIsChatThinking(false);
    setUserMessage(null);
    userMessageRef.current = null;
    setCurrentTaskId(null);
    currentTaskIdRef.current = null;
    setChatMessages([]);
    setAnalysisStartIndex(null);
    conversationMemoryRef.current = [];
    currentSessionIdRef.current = null;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function saveSessionSnapshot(overrides: Partial<HistoryItem> = {}) {
    const savedChatMessages = overrides.chatMessages ?? chatMessages;
    const savedBlocks = overrides.blocks ?? blocksRef.current;
    const savedUserMessage = overrides.userMessage ?? userMessageRef.current;
    const savedActions = overrides.actions ?? actionsRef.current;
    const savedConversationMemory = overrides.conversationMemory ?? conversationMemoryRef.current;
    const savedAnalysisStartIndex = overrides.analysisStartIndex ?? analysisStartIndex;
    const savedTaskId = overrides.taskId ?? currentTaskIdRef.current;
    const savedIsRunning = overrides.isRunning ?? isRunning;
    const title = buildHistoryTitle(savedUserMessage, savedChatMessages);

    if (!title) return;

    setHistory((current) => {
      const id = overrides.id ?? currentSessionIdRef.current ?? crypto.randomUUID();
      currentSessionIdRef.current = id;
      const item: HistoryItem = {
        id,
        createdAt: new Date().toISOString(),
        title,
        status: overrides.status ?? status,
        taskId: savedTaskId,
        isRunning: savedIsRunning,
        userMessage: savedUserMessage,
        chatMessages: savedChatMessages,
        actions: savedActions,
        blocks: savedBlocks,
        conversationMemory: savedConversationMemory,
        analysisStartIndex: savedAnalysisStartIndex
      };
      const next = [item, ...current.filter((entry) => entry.id !== id)].slice(0, 20);
      localStorage.setItem(historyStorageKey, JSON.stringify(next));
      return next;
    });
  }

  function restoreHistory(item: HistoryItem) {
    if (hasSession) {
      saveSessionSnapshot({ taskId: currentTaskIdRef.current, isRunning });
    }
    eventSourceRef.current?.close();
    setIsHistoryOpen(false);
    setIsRunning(item.isRunning);
    setIsChatThinking(false);
    setCurrentTaskId(item.taskId);
    currentTaskIdRef.current = item.taskId;
    setFiles([]);
    setRequirement('');
    setUserMessage(item.userMessage);
    userMessageRef.current = item.userMessage;
    setChatMessages(item.chatMessages);
    setActions(item.actions);
    actionsRef.current = item.actions;
    setBlocks(item.blocks);
    blocksRef.current = item.blocks;
    conversationMemoryRef.current = item.conversationMemory;
    setAnalysisStartIndex(item.analysisStartIndex);
    setStatus(item.status);
    currentSessionIdRef.current = item.id;
    if (item.isRunning && item.taskId) {
      subscribeToTask(item.taskId);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <CuteAgentIcon />
          </span>
          <span>观数 Agent</span>
        </div>

        <div className="config-entry">
          <button className="ghost-button compact-button" type="button" onClick={startNewSession} disabled={!hasSession && files.length === 0 && !requirement.trim()}>
            新会话
          </button>
          <button className="ghost-button compact-button" type="button" onClick={() => setIsHistoryOpen(true)}>
            历史记录
          </button>
          <button className="ghost-button" type="button" onClick={() => setIsConfigOpen(true)}>
            模型配置
          </button>
          <span className={`config-state ${isModelReady ? 'ready' : ''}`}>
            {isModelReady ? modelConfig.model : '尚未配置模型'}
          </span>
        </div>
      </header>

      {isConfigOpen && (
        <div className="config-overlay" role="presentation" onMouseDown={() => setIsConfigOpen(false)}>
          <section
            className="config-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="模型配置"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow compact">Model Settings</p>
                <h2>模型配置</h2>
              </div>
              <button className="icon-button" type="button" aria-label="关闭模型配置" onClick={() => setIsConfigOpen(false)}>
                关闭
              </button>
            </div>
            <label>
              模型名称
              <input
                value={modelConfig.model}
                onChange={(event) => setModelConfig({ ...modelConfig, model: event.target.value })}
                placeholder="例如 gpt-4.1 或 deepseek-chat"
              />
            </label>
            <label>
              base_url
              <input
                value={modelConfig.baseUrl}
                onChange={(event) => setModelConfig({ ...modelConfig, baseUrl: event.target.value })}
                placeholder="https://api.example.com/v1"
              />
            </label>
            <label>
              API-KEY
              <input
                type="password"
                value={modelConfig.apiKey}
                onChange={(event) => setModelConfig({ ...modelConfig, apiKey: event.target.value })}
                placeholder="sk-..."
              />
            </label>
            <button type="button" onClick={() => setIsConfigOpen(false)}>
              保存配置
            </button>
          </section>
        </div>
      )}

      {isHistoryOpen && (
        <div className="config-overlay" role="presentation" onMouseDown={() => setIsHistoryOpen(false)}>
          <section
            className="config-dialog history-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="历史记录"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow compact">Session History</p>
                <h2>历史记录</h2>
              </div>
              <button className="icon-button" type="button" aria-label="关闭历史记录" onClick={() => setIsHistoryOpen(false)}>
                关闭
              </button>
            </div>
            {history.length === 0 ? (
              <p className="muted">暂无历史记录。完成一次对话或分析后会自动保存。</p>
            ) : (
              <div className="history-list">
                {history.map((item) => (
                  <button className="history-item" type="button" key={item.id} onClick={() => restoreHistory(item)}>
                    <span>{item.isRunning ? '分析中 · ' : ''}{item.title}</span>
                    <small>{new Date(item.createdAt).toLocaleString()} · {item.status}</small>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      <section className={`chat-stage ${hasSession ? 'has-session' : ''}`}>
        {!userMessage && chatMessages.length === 0 ? (
          <div className="empty-state">
            <HeroLogo />
            <p className="eyebrow compact">Agent Workspace</p>
            <h1>提问或附加表格，交给观数 Agent</h1>
            <p className="intro-copy">
              可直接提问，也可附加 .xlsx / .xls / .csv 表格；观数 Agent 会结合当前上下文读取数据、执行分析，并把结论、图表和报告呈现在对话里。
            </p>
            <div className="format-notes">
              <section>
                <h2>连续上下文</h2>
                <p>普通交流、数据分析和报告追问会记录在同一次会话中，后续问题可承接前文继续展开。</p>
              </section>
              <section>
                <h2>表格与报告</h2>
                <p>支持 .xlsx、.xls、.csv；可生成 Markdown 复盘正文、ECharts 图表和 Mermaid 结构图。</p>
              </section>
            </div>
          </div>
        ) : (
          <div className="message-list">
            {!userMessage && chatMessages.map((message, index) => (
              <ChatMessageView message={message} index={index} key={`${message.role}-${index}`} />
            ))}
            {!userMessage && isChatThinking && <ChatThinkingView />}

            {userMessage && chatMessages.slice(0, analysisStartIndex ?? 0).map((message, index) => (
              <ChatMessageView message={message} index={index} key={`before-${message.role}-${index}`} />
            ))}

            {userMessage && (
              <article className="message-row user-row">
                <div className="message-bubble user-bubble">
                  {userMessage.fileNames?.map((fileName) => (
                    <p className="file-pill" key={fileName}>{fileName}</p>
                  ))}
                  <p>{userMessage.requirement}</p>
                </div>
              </article>
            )}

            {userMessage && (
              <article className="message-row agent-row">
              <AgentAvatar />
              <div className="message-bubble agent-bubble">
                <div className="agent-status-bar">
                  <div className={`agent-status ${isRunning ? 'running' : 'settled'}`}>
                    <span className={`status-pulse ${isRunning ? 'active' : ''}`} />
                    <span>{status}</span>
                  </div>
                  {isRunning && (
                    <button className="stop-button" type="button" onClick={stopTask}>
                      停止分析
                    </button>
                  )}
                </div>

                <section className="agent-section">
                  <div className="section-heading">
                    <span>执行过程</span>
                    <small>代码与工具返回默认折叠</small>
                  </div>
                  <ActionTimeline actions={actions} />
                </section>

                <section className="agent-section">
                  <div className="section-heading">
                    <span>阶段结论与报告</span>
                    <small>Markdown / ECharts / Mermaid</small>
                  </div>
                  {blocks.length > 0 && (
                    <div className="report-actions">
                      <button type="button" onClick={() => exportReport('md', blocks)}>
                        导出 Markdown
                      </button>
                      <button type="button" onClick={() => exportReport('html', blocks)}>
                        导出 HTML
                      </button>
                      <button type="button" onClick={() => exportReport('json', blocks)}>
                        导出 JSON
                      </button>
                    </div>
                  )}
                  <div className="report-stack">
                    {blocks.length === 0 ? (
                      <p className="muted">Agent 产生阶段性结论后会显示在这里。</p>
                    ) : (
                      blocks.map((block) => <ReportBlockView block={block} key={block.id} />)
                    )}
                  </div>
                </section>
              </div>
            </article>
            )}

            {userMessage && chatMessages.slice(analysisStartIndex ?? 0).map((message, index) => (
              <ChatMessageView
                message={message}
                index={(analysisStartIndex ?? 0) + index}
                key={`after-${message.role}-${(analysisStartIndex ?? 0) + index}`}
              />
            ))}
            {userMessage && isChatThinking && <ChatThinkingView />}
            <div ref={messageEndRef} />
          </div>
        )}
      </section>

      <form className="composer" onSubmit={startTask}>
        <input
          ref={fileInputRef}
          className="hidden-file"
          type="file"
          accept=".xlsx,.xls,.csv"
          multiple
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? []);
            setFiles((current) => [...current, ...selected]);
            event.currentTarget.value = '';
          }}
        />
        {files.length > 0 && (
          <div className="attachment-list">
            {files.map((selectedFile, index) => (
              <span className="attachment-chip" key={`${selectedFile.name}-${selectedFile.lastModified}-${index}`}>
                {selectedFile.name}
                <button
                  type="button"
                  className="remove-attachment"
                  aria-label={`移除 ${selectedFile.name}`}
                  onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-inner">
          <button className="attach-button" type="button" onClick={() => fileInputRef.current?.click()} aria-label="上传表格">
            +
          </button>
          <textarea
            value={requirement}
            onChange={(event) => setRequirement(event.target.value)}
            placeholder={defaultRequirement}
            rows={2}
          />
          <button className="send-button" disabled={!canSubmit} aria-label="发送分析任务">
            {isRunning ? '...' : 'Send'}
          </button>
        </div>
        <p className="composer-hint">
          {isModelReady
            ? '可直接提问，也可附加 .xlsx / .xls / .csv 表格，让观数 Agent 结合当前上下文分析。'
            : '请先在右上角配置模型，再开始提问或附加 .xlsx / .xls / .csv 表格。'}
        </p>
      </form>
    </main>
  );
}

function ChatThinkingView() {
  return (
    <article className="message-row agent-row">
      <AgentAvatar />
      <div className="message-bubble agent-bubble plain-chat-bubble">
        <div className="agent-status chat-thinking-status">
          <span className="thinking-dot active" />
          <span>Agent 正在思考</span>
        </div>
      </div>
    </article>
  );
}

function HeroLogo() {
  return (
    <div className="hero-logo" aria-hidden="true">
      <CuteAgentIcon />
    </div>
  );
}

function ChatMessageView({
  message,
  index
}: {
  message: { role: 'user' | 'assistant'; content: string };
  index: number;
}) {
  return (
    <article className={`message-row ${message.role === 'user' ? 'user-row' : 'agent-row'}`} key={`${message.role}-${index}`}>
      {message.role === 'assistant' && <AgentAvatar />}
      <div className={`message-bubble ${message.role === 'user' ? 'user-bubble' : 'agent-bubble plain-chat-bubble'}`}>
        {message.role === 'assistant' ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        ) : (
          <p>{message.content}</p>
        )}
      </div>
    </article>
  );
}

function AgentAvatar() {
  return (
    <div className="agent-avatar" aria-hidden="true">
      <CuteAgentIcon />
    </div>
  );
}

function CuteAgentIcon() {
  return (
    <svg viewBox="0 0 120 120" role="img">
      <path className="cute-logo-spark" d="M24 32L29 27L34 32L29 37Z" />
      <path className="cute-logo-spark" d="M88 24L92 20L96 24L92 28Z" />
      <path d="M60 31V22" />
      <circle className="cute-logo-node" cx="60" cy="19" r="4" />
      <rect className="cute-logo-face" x="27" y="32" width="66" height="56" rx="24" />
      <path className="cute-logo-cheek" d="M37 65C39 63 42 63 44 65" />
      <path className="cute-logo-cheek" d="M76 65C78 63 81 63 83 65" />
      <circle className="cute-logo-eye-dot" cx="46" cy="56" r="4" />
      <circle className="cute-logo-eye-dot" cx="74" cy="56" r="4" />
      <path d="M52 70C56 74 64 74 68 70" />
      <path d="M33 86L25 96" />
      <path d="M87 86L95 96" />
      <circle className="cute-logo-node" cx="23" cy="98" r="4" />
      <circle className="cute-logo-node" cx="97" cy="98" r="4" />
      <path d="M46 88L43 101" />
      <path d="M74 88L77 101" />
    </svg>
  );
}

async function parseJson(response: Response) {
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? '请求失败');
  }
  return payload;
}

function upsertAction(actions: ActionEvent[], next: ActionEvent): ActionEvent[] {
  const index = actions.findIndex((action) => action.id === next.id);
  if (index < 0) return [...actions, next];
  const copy = [...actions];
  copy[index] = next;
  return copy;
}

function appendUniqueBlock(blocks: ReportBlock[], next: ReportBlock): ReportBlock[] {
  if (blocks.some((block) => block.id === next.id)) return blocks;
  return [...blocks, next];
}

function stopRunningActions(actions: ActionEvent[], message: string): ActionEvent[] {
  return actions.map((action) => {
    if (action.status !== 'running') return action;
    return {
      ...action,
      status: 'failed',
      summary: `${action.summary}（${message}）`
    };
  });
}

function summarizeReportContext(blocks: ReportBlock[], userMessage?: UserMessage | null) {
  if (blocks.length === 0) return '';
  const taskContext = userMessage
    ? `当前分析任务：\n文件：${userMessage.fileNames?.join(', ') ?? '未记录'}\n需求：${userMessage.requirement}\n\n`
    : '';
  const reportContext = blocks
    .map((block, index) => {
      const title = block.title ? `【${block.title}】` : `【报告块 ${index + 1}】`;
      if (block.type === 'markdown') return `${title}\n${block.content.slice(0, 3000)}`;
      if (block.type === 'mermaid') return `${title}\nMermaid: ${block.content.slice(0, 1200)}`;
      return `${title}\nECharts option 摘要: ${JSON.stringify(block.option).slice(0, 1600)}`;
    })
    .join('\n\n');
  return `${taskContext}${reportContext}`.slice(0, 12000);
}

function buildHistoryTitle(userMessage: UserMessage | null, chatMessages: ChatMessage[]) {
  if (userMessage) {
    const fileName = userMessage.fileNames?.[0] ?? '数据分析';
    return `${fileName} · ${userMessage.requirement}`.slice(0, 80);
  }
  const firstUserMessage = chatMessages.find((message) => message.role === 'user')?.content.trim();
  return firstUserMessage ? firstUserMessage.slice(0, 80) : '';
}

function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(historyStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function exportReport(format: 'md' | 'html' | 'json', blocks: ReportBlock[]) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (format === 'json') {
    downloadFile(`agent-report-${stamp}.json`, JSON.stringify({ blocks }, null, 2), 'application/json');
    return;
  }

  const markdown = blocks
    .map((block) => {
      const title = block.title ? `## ${block.title}\n\n` : '';
      if (block.type === 'markdown') return `${title}${block.content}`;
      if (block.type === 'mermaid') return `${title}\`\`\`mermaid\n${block.content}\n\`\`\``;
      return `${title}> 图表已在 HTML 导出中渲染；完整 ECharts 配置请查看 JSON 导出。`;
    })
    .join('\n\n');

  if (format === 'md') {
    downloadFile(`agent-report-${stamp}.md`, markdown, 'text/markdown');
    return;
  }

  const htmlBlocks = blocks
    .map((block, index) => {
      const title = block.title ? `<h2>${escapeHtml(block.title)}</h2>` : '';
      if (block.type === 'markdown') {
        return `<section class="block">${title}<div class="markdown">${renderMarkdownLikeHtml(block.content)}</div></section>`;
      }
      if (block.type === 'mermaid') {
        return `<section class="block">${title}<pre class="mermaid">${escapeHtml(block.content)}</pre></section>`;
      }
      return `<section class="block">${title}<div class="chart" id="chart-${index}"></div></section>`;
    })
    .join('\n');
  const chartScripts = blocks
    .map((block, index) => {
      if (block.type !== 'chart') return '';
      return `const chart${index} = echarts.init(document.getElementById('chart-${index}'));\nchart${index}.setOption(${JSON.stringify(block.option)});`;
    })
    .filter(Boolean)
    .join('\n');

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>数据复盘报告</title>
  <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; line-height: 1.7; max-width: 1040px; margin: 40px auto; padding: 0 24px; color: #1d241f; background: #fffdf7; }
    .block { margin: 26px 0; padding: 22px; border: 1px solid #ded7ca; border-radius: 14px; background: #fffefa; }
    .chart { width: 100%; height: 420px; }
    pre { background: #f5f1e8; padding: 16px; overflow: auto; white-space: pre-wrap; }
    h1, h2 { color: #174d3a; }
  </style>
</head>
<body>
  <h1>数据复盘报告</h1>
  ${htmlBlocks}
  <script>
    if (window.mermaid) mermaid.initialize({ startOnLoad: true });
    ${chartScripts}
    window.addEventListener('resize', () => {
      ${blocks.map((block, index) => (block.type === 'chart' ? `chart${index}.resize();` : '')).join('\n')}
    });
  </script>
</body>
</html>`;
  downloadFile(`agent-report-${stamp}.html`, html, 'text/html');
}

function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return entities[char];
  });
}

function renderMarkdownLikeHtml(content: string) {
  return escapeHtml(content)
    .split('\n')
    .map((line) => {
      if (line.startsWith('### ')) return `<h3>${line.slice(4)}</h3>`;
      if (line.startsWith('## ')) return `<h2>${line.slice(3)}</h2>`;
      if (line.startsWith('# ')) return `<h1>${line.slice(2)}</h1>`;
      if (line.trim().startsWith('- ')) return `<p>${line}</p>`;
      if (!line.trim()) return '<br />';
      return `<p>${line}</p>`;
    })
    .join('');
}
