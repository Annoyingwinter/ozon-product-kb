# 商家问询模块 交接报告
**日期：** 2026-03-24
**项目：** ai选品 → Ozon 自动化选品流水线
**状态：** 管线运行中，存在若干需立即修复的逻辑问题

---

## 一、管线全局状态（截至报告日期）

| 阶段 | 数量 | 关键备注 |
|------|------|---------|
| 待供应商调研 (`supplier_research_pending`) | 32 | 未开始联系，积压中 |
| 已联系等回复 (`supplier_contacted_waiting_reply`) | 11 个商品 / 25 条队列记录 | 存在大量重复条目 |
| 已回复待人工审核 (`human_review_pending`) | 4 | 可立即处理 |
| 已出 listing 草稿 (`approved_for_listing`) | 2 | 正常流转 |

### 等待回复的 11 个商品（去重后）

| slug | 商品名 | 供应商 | 首发时间 | 已催次数 | 状态 |
|------|--------|--------|---------|---------|------|
| `3-847e4f82` | 蜂蜡食品保鲜布（3件套） | 玺胜蜡制品 + 瑞欣蜡制品厂 + 海燕工具 | 2026-03-19 | 5/3/5 | ⚠️ 海燕工具找错产品 |
| `260-0cbddda0` | 厨房硅胶防烫手套 | 阳江辉诚工贸 | 2026-03-22 | **19** | 🔴 严重超发 |
| `item-3-6840d35f` | 硅胶折叠收纳盒 | 未知 | — | **19** | 🔴 严重超发 |
| `20kg-4416d2dc` | 可折叠购物袋（20kg） | 亿华星科技 | 2026-03-24 | 0 | 🟡 刚联系 |
| `item-2-a92b0751` | 可折叠硅胶洗碗刷 | 义乌市颜芮日用品 | 2026-03-24 | 1 | 🟡 正常 |
| `item-3-2b849d87` | 硅胶折叠宠物食碗 | 顺0705 | — | 0 | 🟡 刚联系 |
| `item-3-774a33c3` | 可折叠硅胶宠物饮水碗 | — | — | 0 | 🟡 刚联系 |
| `item-3-cb77a8ce` | 硅胶折叠宠物饮水碗 | — | — | 0 | 🟡 刚联系 |
| `item-4-9540f3d2` | 宠物梳毛手套（双面硅胶） | — | — | 0 | 🟡 刚联系 |
| `item-4-e650144a` | 宠物毛发清理滚筒 | — | — | 0 | 🟡 刚联系 |
| `usb-657aef64` | 桌面理线收纳盒（带USB孔） | — | — | 3 | 🟡 等待中 |

### 待人工审核的 4 个商品（已有供应商回复）

| slug | 商品名 | 回复路径 |
|------|--------|---------|
| `item-1-0e4d9796` | 可重复使用蜂蜡食品保鲜布 | `supplier-response.2026-03-21T12-39-55.530Z.json` |
| `item-2-6df4177f` | 可伸缩宠物拾便袋盒（带挂钩） | `supplier-response.2026-03-21T14-40-13.473Z.json` |
| `item-4-da8723c1` | 可伸缩缝隙收纳盒（厨房/浴室） | `supplier-response.2026-03-21T11-52-05.848Z.json` |
| `item-5-83448823` | 汽车座椅缝隙收纳袋 | `supplier-response.2026-03-21T12-05-51.247Z.json` |

---

## 二、已识别的逻辑问题（Bugs）

### 🔴 严重（需立即修复）

#### Bug-1：无追问次数上限，供应商被轰炸
- **文件：** `scripts/watch-1688-supplier-reply.js:385-412`
- **现象：** `260-0cbddda0` 和 `item-3-6840d35f` 各被发送了 **19 条** 催促消息
- **根因：** `DEFAULT_FOLLOW_UP_AFTER_MS = 30000`（30秒就发 follow-up），nudge 在 45 秒后发送，且全局无 max 限制
- **风险：** 极大概率触发 1688 风控导致账号被限制
- **修复方案：**
  - follow-up 最早 **5分钟** 后发送
  - nudge 最早 **15分钟** 后发送
  - 全局 `follow_up_sent_count` 上限设为 **3**，超过自动标记 `no_response`

#### Bug-2：监控循环无止境创建 capture 文件
- **文件：** `scripts/watch-1688-supplier-reply.js:249-271` (`upsertChatCapture`)
- **现象：** 产品 `3-847e4f82` 目录下有 **258 个** `supplier-chat.*.json` 文件
- **根因：** 每个监控周期无论聊天内容是否变化都写一份新文件，`chat_captures` 数组无限追加
- **修复方案：**
  - 对比本次 `transcript_text` 的哈希与上次记录，相同则跳过
  - `chat_captures` 数组上限 20 条，超出保留最新的

#### Bug-3：产品不匹配却被当成有效回复推进
- **文件：** `scripts/watch-1688-supplier-reply.js:133-192` (`classifyConversation`)
- **现象：** 产品目标是「蜂蜡食品保鲜布」，系统联系了「海燕工具」（卖蜡烛原料白蜂蜡），商家回复「不是食品级的」，系统仍标记 `has_human_reply: true` 推进到下一阶段
- **根因：** `classifyConversation` 只判断"是否有人工回复"，不判断回复是否为拒绝/不匹配
- **修复方案：** 增加否定意图检测：
  ```js
  const rejectionPatterns = [
    /不是.*级/, /没有这个/, /做不了/, /不做/, /没有现货/,
    /不生产/, /已停产/, /缺货/, /下架/, /不符合/
  ];
  ```
  - 检测到否定回复 → 标记 `reply_type: "rejection"`，不推进到 human_review

### 🟡 中等（计划内修复）

#### Bug-4：`detectProductProfile` if-else 优先级错误导致误分类
- **文件：** `scripts/merchant-workflow-lib.js:570-586`
- **典型案例：**
  - `PP塑料抽屉式衣物收纳盒` → 被分类为 `apparel`（实为 `storage-home`，因"衣"命中）
  - `硅胶折叠水杯（便携车载款）` → 被分类为 `automotive-accessories`（实为食品级产品，因"车"优先）
- **修复方案：** 用关键词权重评分代替 if-else 链，或将单字匹配改为更精确的词组

#### Bug-5：`supplier-chat-lib.js` 缺失 3 个 profile 的话术模板
- **文件：** `scripts/supplier-chat-lib.js:21-41`
- **缺失：** `magnetic-accessories`、`storage-home`、`household-tools` 全部 fallback 到通用模板
- **影响：** 磁铁类产品不会问磁力等级，收纳类不会问折叠方式等关键信息

#### Bug-6：followup 队列存在重复条目（`"primary"` vs `"_"` 键名差异）
- **文件：** `scripts/test-1688-supplier-inquiry.js:743-760`
- **现象：** 25 条队列记录中有 2 条完全重复（供应商 URL 相同，supplierKey 不同）
- **修复方案：** 去重逻辑改为基于 `supplier_im_url` 匹配，而不是 `supplier_key` 精确匹配

### ⚪ 次要（低优先级）

#### Bug-7：`classifyConversation` 存在矛盾状态
- `auto_only: true` 和 `has_human_reply: true` 可同时为真，下游状态机混乱

#### Bug-8：搜索词典疑似 GBK/UTF-8 双重编码乱码
- **文件：** `scripts/test-1688-supplier-inquiry.js:81-106`
- `TYPE_TERM_DICTIONARY` 内容显示为乱码（如 `搴ф缂濋殭鏀剁撼琚?`）
- 若源文件确实如此，候选商家相关性评分将完全失效

#### Bug-9：Windows 下每次搜索 spawn PowerShell 做 URL 编码
- **文件：** `scripts/test-1688-supplier-inquiry.js:341-363`
- 建议改用 `iconv-lite` 包在进程内完成，避免额外进程开销

---

## 三、执行计划

### 第0批：立即止血（当天）

```
1. 停止 260-0cbddda0（防烫手套）和 item-3-6840d35f（折叠收纳盒）的监控
   → 将这两个产品标记为 no_response，重新选供应商联系

2. 将 3-847e4f82 → 海燕工具 这条记录标记为 reply_rejected（产品不匹配）
   → 保留玺胜蜡制品和瑞欣蜡制品厂两条正常联系

3. 清理 followup 队列重复条目（25条 → 约 13 条唯一联系）
```

### 第1批：收割已有回复（当天）

```
处理 4 个 human_review_pending 商品：
→ 读取 auto-draft，核查数据完整度
→ 缺 MOQ/价格/材质/重量 则补问，否则推进到 approved
```

### 第2-6批：新发消息（每天 6 个商品 × 2-3 家供应商）

| 天 | 商品类型 | 优先理由 |
|----|---------|---------|
| Day 2 | 家具脚垫、水槽过滤网、桌面理线器、收纳盒 | 低风险、小体积、无认证要求 |
| Day 3 | 宠物喂食垫、梳毛手套、饮水碗、拾便袋 | 同类批量效率高 |
| Day 4 | 座椅收纳盒、手机支架、厨房剪刀 | 中等复杂度 |
| Day 5 | 带LED宠物指甲剪、USB收纳盒 | 带电产品需确认认证 |
| Day 6 | 磁性挂钩、车载支架（磁吸） | 磁铁类需特殊询问 |

### 每日运营时间表

| 时段 | 动作 | 耗时 |
|------|------|------|
| 09:00 | 检查所有 waiting_reply 的回复情况 | 15min |
| 09:15 | 处理已回复：补问或推进审核 | 30min |
| 09:45 | 处理超时未回复：发最后催促或标记放弃 | 15min |
| 10:00 | 新发一批（6个商品） | 45min |
| 14:00 | 午后巡检：确认上午的有无回复 | 15min |
| 17:00 | 收盘：更新状态，规划明天批次 | 15min |

---

## 四、消息节奏规范

| 动作 | 触发条件 | 时机 |
|------|---------|------|
| 首发消息 | 新联系供应商 | T+0 |
| 跟进 #1 | 仅收到自动推荐卡片 | T+5min |
| 跟进 #2 | 完全无任何回复 | T+2h |
| 最终催促 | 仍无回复 | T+24h |
| 标记放弃 | 仍无回复 | T+48h → `no_response` |
| 换供应商 | 标记 `no_response` 后 | 重新从候选列表取下一家 |

**铁律：** 同一供应商全局催促上限 **3次**，超过即放弃。

---

## 五、待修复的代码工作单

| 优先级 | 任务 | 文件 | 预计工作量 |
|--------|------|------|-----------|
| P0 | 加全局 followUp 上限（3次） | `watch-1688-supplier-reply.js` | 小 |
| P0 | capture 去重（哈希对比） | `watch-1688-supplier-reply.js` | 小 |
| P0 | 否定回复检测（增加 `reply_rejected` 状态） | `watch-1688-supplier-reply.js` | 中 |
| P1 | followup 队列去重（基于 supplier_im_url） | `merchant-workflow-lib.js` | 小 |
| P1 | follow-up 间隔改为 5min / 2h / 24h | `watch-1688-supplier-reply.js` | 小 |
| P2 | profile 分类改为评分制 | `merchant-workflow-lib.js` | 中 |
| P2 | 补齐 magnetic/storage/household 话术 | `supplier-chat-lib.js` | 小 |
| P3 | 新增批量调度脚本 | `scripts/batch-inquiry-scheduler.js` | 大 |

---

## 六、项目关键文件索引

```
scripts/
  test-1688-supplier-inquiry.js  → 搜索1688并发送首条消息
  watch-1688-supplier-reply.js   → 监听回复、发跟进/nudge
  monitor-1688-supplier-replies.js → 定时轮询调用 watch 脚本
  supplier-chat-lib.js           → 话术模板构建
  merchant-workflow-lib.js       → 公共工具：profile检测、状态管理、队列刷新

queues/
  supplier-research-queue.json   → 待联系的商品列表
  supplier-followup-queue.json   → 已联系待回复/跟进的联系人
  human-review-queue.json        → 已有回复待人工审核
  listing-draft-queue.json       → 已审核待出稿

knowledge-base/products/{slug}/
  product.json                   → 商品完整记录（含 workflow.current_stage）
  supplier-inquiry.md            → 问询话术草稿
  supplier-response.auto-draft.json → 供应商回复自动解析结果
  supplier-chat.{timestamp}.json → 每次聊天捕获快照
```

---

## 七、接手者须知

1. **不要直接跑 `monitor-1688-supplier-replies.js`**，除非已修复 Bug-1（无上限追问）
2. **260-0cbddda0 和 item-3-6840d35f 两个商品需要人工介入**：登录 1688 查看对话，若商家已屏蔽则换供应商
3. **4 个 human_review 商品可以直接处理**，不需要等代码修复
4. **32 个 research_pending 商品**建议等 P0 Bug 修复后再批量启动，否则会重现轰炸问题

---

*报告生成时间：2026-03-24 | 基于代码审查及队列数据分析*
