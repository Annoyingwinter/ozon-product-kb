# Ozon 选品脚本

这个仓库现在有两条路：

- `AlphaShop` 自动化：保留，但目标站登录链路很不稳定，经常卡在阿里登录组件或直接返回 `401`
- `Ozon` 本地评分器：稳定可用，不依赖 `AlphaShop`

当前建议默认使用第二条。

## 安装

```bash
npm install
```

## 1. 本地稳定版

输入一份候选品 `JSON` 或 `CSV`，脚本会按 `Ozon` 运营逻辑打分并输出：

- `Go`
- `Watch`
- `No-Go`

### 直接跑样例

```bash
npm run ozon:evaluate
```

### 跑你自己的文件

```bash
node scripts/ozon-evaluator.js --input path/to/candidates.json
```

也支持 `CSV`：

```bash
node scripts/ozon-evaluator.js --input path/to/candidates.csv
```

### 可选参数

```bash
node scripts/ozon-evaluator.js \
  --input path/to/candidates.json \
  --product-goal "筛选适合 Ozon 俄罗斯站秋冬季上新的家居收纳产品" \
  --category "Home Storage" \
  --target-users "俄罗斯城市家庭" \
  --price-min-rub 1000 \
  --price-max-rub 4000 \
  --max-weight-kg 1.2 \
  --max-long-edge-cm 45
```

### 输入字段

常用字段如下：

- `name`
- `category`
- `target_price_rub`
- `supply_price_cny`
- `est_weight_kg`
- `package_long_edge_cm`
- `fragility`
- `certification_risk`
- `return_risk`
- `competition_level`
- `content_potential`
- `search_trend`
- `seasonality`
- `why_it_can_sell`
- `risk_notes`
- `source`
- `source_url`

样例见 [examples/ozon-candidates.sample.json](/Users/More/Desktop/ai选品/examples/ozon-candidates.sample.json)。

### 输出文件

运行后会在 `output/` 下生成：

- `*.analysis.json`
- `*.report.md`
- `*.json`
- `*.input.txt`

## 2. AlphaShop 自动化

命令还保留：

```bash
npm run ozon
```

现在默认会使用仓库自己的持久化浏览器资料目录：

- 浏览器资料目录：`.profiles/alphashop/browser-user-data/`
- 会话快照：`.profiles/alphashop/storage-state.json`

推荐的长期运行方式：

1. 第一次不要加 `--headless`，直接运行 `npm run ozon`
2. 在弹出的自动化浏览器窗口里完成一次 AlphaShop 登录
3. 后续继续使用同一个仓库目录运行，脚本会复用这套持久化 profile

可选参数：

```bash
node scripts/alphashop-agent.js --browser-profile-dir path/to/browser-user-data
```

这样做的好处：

- 不依赖你日常使用的 Edge 标签页是否开着
- 不需要每次从真实 Edge 导入登录态
- Cookie、LocalStorage、站点会话会跟随专用 profile 持续保存

当前已知问题仍然很明显：

- 登录组件经常白屏或骨架屏
- 即使页面打开，业务接口仍可能返回 `FAIL_SYS_SESSION_EXPIRED`
- 会话链路依赖阿里登录体系，不适合作为稳定入口

所以更准确的结论是：

- 作为“临时抓取你日常浏览器登录态”的方案，不可靠
- 作为“固定专用 profile + 首次人工登录一次”的自动化方案，可以长期跑，但仍受 AlphaShop 自身登录体系稳定性影响

## Ozon 评分逻辑

当前脚本默认使用这套规则：

- 价格带：`1000-4000 RUB`
- 重量：`<= 1.2 kg`
- 最长边：`<= 45 cm`
- 优先：轻小件、标准化、低售后、易本地化
- 谨慎：强认证、易碎大件、复杂电子品、高退货类目

评分维度：

- 价格匹配
- 毛利空间
- 物流友好度
- 竞争强度
- 合规风险
- 退货风险
- 内容传播潜力
- 需求趋势

## 3. 商家调研与知识库流程

这条链路用于把选品结果继续推进到：

- 商家调研队列
- 单品知识库
- 人工审核队列
- 上架草稿队列

### 准备调研队列

默认读取 `output/` 下最新的 `*.analysis.json`：

```bash
npm run workflow:prepare
```

也可以手动指定：

```bash
node scripts/prepare-merchant-workflow.js --input output/your-run.analysis.json
```

运行后会生成：

- `knowledge-base/products/<slug>/product.json`
- `knowledge-base/products/<slug>/supplier-search-plan.json`
- `knowledge-base/products/<slug>/supplier-inquiry.md`
- `knowledge-base/products/<slug>/supplier-shortlist.template.json`
- `knowledge-base/products/<slug>/supplier-response.template.json`
- `knowledge-base/index.json`
- `queues/supplier-research-queue.json`
- `queues/human-review-queue.json`
- `queues/listing-draft-queue.json`

### 回填商家回复

单个商品：

```bash
node scripts/ingest-supplier-response.js --slug product-slug --input path/to/response.json
```

批量目录：

```bash
node scripts/ingest-supplier-response.js --input-dir path/to/responses
```

回填后商品会进入人工审核队列。

### 选商家和提问逻辑

现在每个商品都会自动生成：

- `supplier-search-plan.json`
  - 用哪个平台优先找商家
  - 搜索关键词
  - 首轮抓多少店
  - 先联系前几家
  - 商家排序规则
- `supplier-inquiry.md`
  - 第一轮短消息问题
  - 第二轮深挖问题
  - 不同类目会有不同问题
- `supplier-shortlist.template.json`
  - 用来记录 1688 / Alibaba 候选店铺的打分和风险

当前默认策略是：

- 先在 `1688` 找 8 家候选
- 缩到前 3 家发首轮消息
- 有出口、认证或复杂风险时，再补 `Alibaba`
- 站外沟通默认用微信/企微做第二轮深聊

### 生成 OpenClaw stop 包

把一个商品打成 OpenClaw 可执行任务包：

```bash
npm run workflow:stop -- --slug item-5-83448823
```

如果不传 `--slug`，会自动取当前最早的 `supplier_research_pending` 商品。

生成结果会放在：

- `output/openclaw/<package-id>/<slug>/openclaw-stop.md`
- `output/openclaw/<package-id>/<slug>/openclaw-stop.json`
- `output/openclaw/<package-id>/<slug>/task.json`

这个包不是“聊天记录”，而是给 OpenClaw 的执行输入：

- 找哪类商家
- 用什么关键词搜
- 先问哪 3 家
- 第一轮问什么
- 第二轮问什么
- 什么时候停下来交给人审

### 人工审核

审核通过：

```bash
node scripts/update-product-review.js --slug product-slug --approve --notes "ready for listing"
```

审核拒绝：

```bash
node scripts/update-product-review.js --slug product-slug --reject --notes "compliance risk too high"
```

审核通过后会自动生成：

- `knowledge-base/products/<slug>/listing-brief.md`

这样就可以把 `approved_for_listing` 阶段的数据继续交给 OpenClaw 或其他上架执行器。

### Draft-only Ozon flow

```bash
npm run ozon:draft
```

This flow will:

- auto-approve low-complexity `Go` items that do not require supplier replies
- generate `output/ozon-drafts/<run-id>/<slug>/ozon-listing-draft.{json,md}`
- update the product record to `approved_for_listing`
- keep publish disabled and stop at draft-ready output

### Generated listing assets

For each eligible `Go` product, the flow now also writes these source files under `knowledge-base/products/<slug>/`:

- `listing-title.json`
- `listing-title.ru.json`
- `listing-bullets.json`
- `listing-bullets.ru.json`
- `listing-attributes.json`
- `main-image-copy.json`
- `main-image-copy.ru.json`
- `listing-assets.md`
- `listing-assets.ru.md`

## Selection + Inquiry Automation

If you want one entry point that does all three stages:

1. run Ozon selection
2. prepare knowledge-base and queues
3. send the first round of 1688 supplier inquiries

use:

```bash
npm run select:inquiry
```

Useful flags:

```bash
node scripts/select-and-inquire.js \
  --platform ozon \
  --timeout-ms 180000 \
  --limit 3 \
  --keep-open
```

This command also writes a machine-readable summary to:

- `output/latest-selection-inquiry-summary.json`
- `output/automation/*.selection-inquiry-summary.json`

## Selection + Inquiry Automation

If you want one entry point that does all three stages:

1. run Ozon selection
2. prepare knowledge-base and queues
3. send the first round of 1688 supplier inquiries

use:

```bash
npm run select:inquiry
```

Useful flags:

```bash
node scripts/select-and-inquire.js \
  --platform ozon \
  --timeout-ms 180000 \
  --limit 3 \
  --keep-open
```

This command also writes a machine-readable summary to:

- `output/latest-selection-inquiry-summary.json`
- `output/automation/*.selection-inquiry-summary.json`
