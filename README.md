# 观数 Agent

一个对话式数据复盘与分析智能体。用户可以直接提问，也可以附加 Excel / CSV 表格并输入分析需求；后端维护多轮 LLM Agent 循环，模型自主决定何时编写 Python、调用 `run_code`、继续分析或输出最终报告。

## 功能

- OpenAI-compatible 模型配置：`model`、`base_url`、`API-KEY`
- 普通对话、数据分析和报告追问共享同一次会话上下文
- Excel / CSV 多文件上传，可移除误选附件
- 多轮 Agent 循环：LLM makes the loop、LLM in the loop、LLM ends the loop
- `run_code` Python 工具：读取表格、分析数据、返回 stdout / stderr / artifacts
- SSE 实时过程流：默认折叠动作详情，只显示摘要
- 任务执行中支持停止分析
- 报告渲染：Markdown、ECharts、Mermaid
- 报告导出：Markdown、HTML、JSON，其中 HTML 会渲染 ECharts 图表
- 新会话与浏览器本地历史记录
- 视觉限制：无蓝紫主色、无大面积渐变、无 `border-left`，墨绿色点缀

## 运行

```bash
npm install
npm run dev
```

前端默认运行在 `http://localhost:5173`，后端默认运行在 `http://localhost:8787`。

## 样例数据

```bash
npm run sample:data
```

这会生成 `samples/operation_review.xlsx`。需要本机 Python 环境包含 `pandas` 和 `openpyxl`。

也可以生成一份更适合测试 Agent 分析链路的营销漏斗数据：

```bash
python scripts/create_marketing_agent_test_data.py
```

生成文件：

```text
samples/marketing_funnel_agent_test.xlsx
```

这份数据包含 30 天、5 个渠道的投放和转化明细，共 150 行，并包含两个 Sheet：

- `明细数据`：日期、渠道、投放费用、曝光量、点击量、落地页访问量、线索数、有效线索数、成交客户数、销售收入、客单价、点击率、线索转化率、有效线索率、成交转化率、ROI
- `渠道汇总`：按渠道聚合的投放、点击、线索、成交、收入和 ROI

可用于测试趋势分析、渠道对比、漏斗转化、ROI 评估和异常识别。

推荐测试需求：

```text
请分析这份营销漏斗数据，输出一份完整复盘报告。重点包括：
1. 总体投放效果、收入、ROI 和成交表现；
2. 各渠道的转化漏斗差异，找出最优和最差渠道；
3. 识别日期维度上的异常波动，并解释可能原因；
4. 用 ECharts 图表展示趋势、渠道对比和漏斗转化；
5. 最后给出可执行的优化建议。
```

## run_code 输出建议

模型生成的 Python 可以直接使用：

```python
DATA_FILE
WORK_DIR
```

推荐将关键统计结果打印为 JSON，并将较大的中间产物写入 `WORK_DIR`。

## 历史记录说明

历史记录保存在浏览器 `localStorage` 中，只用于当前浏览器和当前站点地址。清理浏览器站点数据、更换浏览器或更换设备后，历史记录不会同步保留。

## 安全注意事项

本项目默认面向本地可信环境使用，不建议直接部署给不可信用户。

需要特别注意：

- `run_code` 会执行 LLM 生成的 Python 代码，当前没有真正的系统级沙箱。
- Python 代码理论上可以读写本机文件、访问网络或执行系统命令。
- 后端默认开启 CORS，适合本地开发；公开部署前应增加鉴权和来源限制。
- 用户填写的 `base_url` 会由后端请求，公开部署前建议加白名单，避免被滥用为请求代理。
- 工具返回中可能包含本机临时文件路径，公开部署前建议改成只返回文件名或相对路径。
