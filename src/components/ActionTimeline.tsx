import type { ActionEvent } from '../types/agent';

type Props = {
  actions: ActionEvent[];
};

export function ActionTimeline({ actions }: Props) {
  if (actions.length === 0) {
    return <p className="muted">任务启动后，这里会实时显示 Agent 的执行动作。</p>;
  }

  return (
    <div className="timeline">
      {actions.map((action) => (
        <details className={`action-card ${action.status}`} key={`${action.id}-${action.summary}`}>
          <summary>
            <span className="status-dot" />
            <span>
              <strong>{action.title}</strong>
              <small>{action.summary}</small>
            </span>
          </summary>
          <pre className="code-panel">{JSON.stringify(action.detail ?? { summary: action.summary }, null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}
