import type { ReportBlock } from '../types/agent';
import { ChartBlock } from './ChartBlock';
import { MarkdownBlock } from './MarkdownBlock';
import { MermaidBlock } from './MermaidBlock';

type Props = {
  block: ReportBlock;
};

export function ReportBlockView({ block }: Props) {
  return (
    <section className="report-block">
      {block.title && <h3>{block.title}</h3>}
      {block.type === 'markdown' && <MarkdownBlock content={block.content} />}
      {block.type === 'chart' && <ChartBlock option={block.option} />}
      {block.type === 'mermaid' && <MermaidBlock content={block.content} />}
    </section>
  );
}
