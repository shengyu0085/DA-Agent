from pathlib import Path

import pandas as pd


rows = [
    {"date": "2026-04-01", "channel": "自然流量", "visits": 8420, "orders": 418, "revenue": 128600, "refunds": 18},
    {"date": "2026-04-02", "channel": "自然流量", "visits": 8610, "orders": 436, "revenue": 133200, "refunds": 16},
    {"date": "2026-04-03", "channel": "自然流量", "visits": 7900, "orders": 388, "revenue": 119400, "refunds": 21},
    {"date": "2026-04-01", "channel": "内容投放", "visits": 5260, "orders": 231, "revenue": 82400, "refunds": 9},
    {"date": "2026-04-02", "channel": "内容投放", "visits": 6120, "orders": 248, "revenue": 87900, "refunds": 12},
    {"date": "2026-04-03", "channel": "内容投放", "visits": 7440, "orders": 219, "revenue": 76100, "refunds": 15},
    {"date": "2026-04-01", "channel": "搜索广告", "visits": 4380, "orders": 302, "revenue": 104800, "refunds": 11},
    {"date": "2026-04-02", "channel": "搜索广告", "visits": 4510, "orders": 315, "revenue": 109200, "refunds": 10},
    {"date": "2026-04-03", "channel": "搜索广告", "visits": 4690, "orders": 284, "revenue": 98500, "refunds": 19},
]

df = pd.DataFrame(rows)
df["date"] = pd.to_datetime(df["date"])
df["conversion_rate"] = df["orders"] / df["visits"]
df["avg_order_value"] = df["revenue"] / df["orders"]

output = Path("samples/operation_review.xlsx")
output.parent.mkdir(parents=True, exist_ok=True)
df.to_excel(output, index=False)
print(f"created {output}")
