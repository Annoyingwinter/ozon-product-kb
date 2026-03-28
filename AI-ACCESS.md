# AI Access Guide for ozon-product-kb

## Repository

```
https://github.com/Annoyingwinter/ozon-product-kb
```

## Prompt for Other AI Agents

Copy and paste the following prompt to let another AI agent pull and work with this knowledge base:

---

### English Prompt

```
You have access to a cross-border e-commerce product knowledge base at:
https://github.com/Annoyingwinter/ozon-product-kb

This repo contains 78+ product research records for the 1688-to-Ozon (Russia) sourcing pipeline.

## How to access the data

Use `gh` CLI or raw GitHub URLs:

# Clone the full repo
gh repo clone Annoyingwinter/ozon-product-kb

# Or fetch a single product's data via raw URL
curl -s https://raw.githubusercontent.com/Annoyingwinter/ozon-product-kb/main/knowledge-base/products/<slug>/product.json

# List all product slugs
curl -s https://api.github.com/repos/Annoyingwinter/ozon-product-kb/contents/knowledge-base/products | jq '.[].name'

## Data structure

Each product folder (`knowledge-base/products/<slug>/`) contains:

| File | Description |
|------|-------------|
| `product.json` | Core product record: name, category, pricing, weight, risk scores, workflow stage |
| `ozon-knowledge.json` | Ozon marketplace analysis: competition, trends, pricing benchmarks |
| `1688-search-plan.json` | Planned 1688 search queries for supplier sourcing |
| `1688-compare.summary.json` | Comparative analysis of 1688 supplier offers |
| `1688-competitor-offers.json` | Raw competitor offer data from 1688 |
| `supplier-search-plan.json` | Structured supplier outreach plan |
| `supplier-shortlist.template.json` | Template for evaluating shortlisted suppliers |
| `supplier-inquiry.md` | Generated supplier inquiry message (Chinese) |
| `listing-brief.md` | Product listing brief for Ozon |
| `listing-title.json` / `listing-title.ru.json` | Listing title in English and Russian |
| `listing-bullets.json` / `listing-bullets.ru.json` | Bullet points in English and Russian |
| `listing-attributes.json` | Ozon-specific product attributes |
| `listing-assets.md` / `listing-assets.ru.md` | Image and asset requirements |
| `main-image-copy.json` / `main-image-copy.ru.json` | Main image overlay text |

## Key files at root level

| File | Description |
|------|-------------|
| `knowledge-base/index.json` | Master index of all products with workflow status |
| `knowledge-base/products.json` | Flat product list with key fields |
| `knowledge-base/categories.json` | Ozon category tree |
| `knowledge-base/category_mapping.json` | 1688-to-Ozon category mapping |
| `knowledge-base/ozon_attributes.json` | Ozon attribute definitions |
| `knowledge-base/ozon_attribute_values.json` | Allowed attribute values per category |
| `knowledge-base/restricted_rules.md` | Product compliance and restriction rules |
| `knowledge-base/upload_rules.md` | Ozon listing upload format rules |

## product.json schema (key fields)

{
  "slug": "car-seat-gap-organizer-36237c9a",
  "workflow": { "current_stage": "approved_for_listing" },
  "product": {
    "name": "Car Seat Gap Organizer",
    "category": "Car Accessories",
    "target_price_rub": 2190,
    "supply_price_cny": 32,
    "est_weight_kg": 0.55,
    "competition_level": "high",
    "why_it_can_sell": "Strong utility..."
  },
  "listing": { "status": "draft_generated" },
  "research": { "outreach": { "status": "not_contacted" } }
}

## Common tasks you can do with this data

1. **Find products by stage**: Filter `product.json` by `workflow.current_stage`
2. **Price analysis**: Compare `target_price_rub` vs `supply_price_cny` across products
3. **Identify gaps**: Find products missing listing drafts or supplier data
4. **Generate new listings**: Use existing listing patterns as templates
5. **Supplier outreach**: Read `supplier-inquiry.md` for inquiry templates
6. **Market research**: Analyze `ozon-knowledge.json` for competitive landscape
```

---

### Chinese Prompt (中文提示词)

```
你可以访问一个跨境电商选品知识库：
https://github.com/Annoyingwinter/ozon-product-kb

该仓库包含78+个产品调研记录，用于1688采购→Ozon俄罗斯站上架的选品流水线。

## 如何获取数据

# 克隆整个仓库
gh repo clone Annoyingwinter/ozon-product-kb

# 获取单个产品数据
curl -s https://raw.githubusercontent.com/Annoyingwinter/ozon-product-kb/main/knowledge-base/products/<slug>/product.json

# 列出所有产品
curl -s https://api.github.com/repos/Annoyingwinter/ozon-product-kb/contents/knowledge-base/products | jq '.[].name'

## 数据结构

每个产品文件夹 (`knowledge-base/products/<slug>/`) 包含：

| 文件 | 说明 |
|------|------|
| `product.json` | 核心产品记录：名称、品类、定价、重量、风险评分、工作流阶段 |
| `ozon-knowledge.json` | Ozon市场分析：竞争情况、趋势、定价基准 |
| `1688-search-plan.json` | 1688供应商搜索计划 |
| `1688-compare.summary.json` | 1688供应商对比分析 |
| `supplier-inquiry.md` | 生成的供应商询价消息（中文） |
| `listing-brief.md` | Ozon产品listing简报 |
| `listing-title.ru.json` | 俄语listing标题 |
| `listing-bullets.ru.json` | 俄语卖点要点 |
| `listing-attributes.json` | Ozon平台属性 |

## 你可以用这些数据做什么

1. **按阶段筛选产品**：过滤 `workflow.current_stage` 字段
2. **价格分析**：比较各产品的 `target_price_rub` 和 `supply_price_cny`
3. **发现缺口**：找到缺少listing草稿或供应商数据的产品
4. **生成新listing**：参考已有listing模式作为模板
5. **供应商触达**：参考 `supplier-inquiry.md` 的询价模板
6. **市场调研**：分析 `ozon-knowledge.json` 了解竞争格局
```

---

## Quick Test (verify access works)

```bash
# Test: fetch one product
curl -s https://raw.githubusercontent.com/Annoyingwinter/ozon-product-kb/main/knowledge-base/products/car-seat-gap-organizer-36237c9a/product.json | head -20

# Test: list all products
curl -s https://api.github.com/repos/Annoyingwinter/ozon-product-kb/contents/knowledge-base/products | python3 -c "import sys,json; [print(x['name']) for x in json.load(sys.stdin)]"
```
