from pathlib import Path
import random

import pandas as pd


random.seed(42)

channels = [
    ("搜索广告", 1.18, 1.08),
    ("内容投放", 0.95, 0.88),
    ("公众号", 0.72, 1.15),
    ("自然流量", 0.66, 1.28),
    ("社群转介绍", 0.42, 1.55),
]

rows = []
dates = pd.date_range("2026-04-01", periods=30, freq="D")

for day_index, date in enumerate(dates):
    weekday_factor = 0.88 if date.weekday() >= 5 else 1.0
    campaign_factor = 1.0 + (0.18 if 10 <= day_index <= 16 else 0)

    for channel, traffic_weight, quality_weight in channels:
        base_spend = 3600 * traffic_weight * campaign_factor * weekday_factor
        spend = max(500, round(base_spend * random.uniform(0.86, 1.14), 2))

        impressions = int(spend * random.uniform(82, 128))
        click_rate = 0.032 * quality_weight * random.uniform(0.82, 1.18)
        clicks = max(20, int(impressions * click_rate))

        landing_rate = 0.68 * quality_weight * random.uniform(0.86, 1.08)
        visits = max(10, int(clicks * landing_rate))

        lead_rate = 0.118 * quality_weight * random.uniform(0.82, 1.22)
        leads = max(1, int(visits * lead_rate))

        qualified_rate = 0.52 * quality_weight * random.uniform(0.78, 1.12)
        qualified_leads = max(0, int(leads * min(qualified_rate, 0.86)))

        deal_rate = 0.25 * quality_weight * random.uniform(0.75, 1.18)
        deals = max(0, int(qualified_leads * min(deal_rate, 0.55)))

        avg_order_value = 12800 * quality_weight * random.uniform(0.82, 1.24)
        revenue = round(deals * avg_order_value, 2)

        # Create a visible anomaly for the Agent to discover.
        if channel == "内容投放" and date.day in [18, 19, 20]:
            spend = round(spend * 1.35, 2)
            leads = max(1, int(leads * 0.62))
            qualified_leads = max(0, int(qualified_leads * 0.58))
            deals = max(0, int(deals * 0.5))
            revenue = round(deals * avg_order_value, 2)

        rows.append(
            {
                "日期": date.strftime("%Y-%m-%d"),
                "渠道": channel,
                "投放费用": spend,
                "曝光量": impressions,
                "点击量": clicks,
                "落地页访问量": visits,
                "线索数": leads,
                "有效线索数": qualified_leads,
                "成交客户数": deals,
                "销售收入": revenue,
                "客单价": round(avg_order_value, 2),
                "点击率": round(clicks / impressions, 4),
                "线索转化率": round(leads / visits, 4) if visits else 0,
                "有效线索率": round(qualified_leads / leads, 4) if leads else 0,
                "成交转化率": round(deals / qualified_leads, 4) if qualified_leads else 0,
                "ROI": round(revenue / spend, 4) if spend else 0,
            }
        )

df = pd.DataFrame(rows)
output = Path("samples/marketing_funnel_agent_test.xlsx")
output.parent.mkdir(parents=True, exist_ok=True)

with pd.ExcelWriter(output, engine="openpyxl") as writer:
    df.to_excel(writer, sheet_name="明细数据", index=False)
    summary = (
        df.groupby("渠道", as_index=False)
        .agg(
            投放费用=("投放费用", "sum"),
            曝光量=("曝光量", "sum"),
            点击量=("点击量", "sum"),
            线索数=("线索数", "sum"),
            有效线索数=("有效线索数", "sum"),
            成交客户数=("成交客户数", "sum"),
            销售收入=("销售收入", "sum"),
        )
        .assign(ROI=lambda x: (x["销售收入"] / x["投放费用"]).round(4))
    )
    summary.to_excel(writer, sheet_name="渠道汇总", index=False)

print(f"created {output} with {len(df)} rows")
