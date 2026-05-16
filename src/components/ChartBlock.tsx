import ReactECharts from 'echarts-for-react';

type Props = {
  option: unknown;
};

export function ChartBlock({ option }: Props) {
  return (
    <div className="chart-shell">
      <ReactECharts option={option as object} style={{ height: 360, width: '100%' }} notMerge />
    </div>
  );
}
