# Handoff: OpenClaw + AlphaShop/Ozon + 1688 Supplier Loop

## Goal

Build an end-to-end AI-operated workflow:

1. Take AlphaShop/Ozon selection outputs
2. Contact suppliers on 1688
3. Persist supplier replies into the knowledge base
4. Prepare Ozon listing drafts
5. Later mirror status back into OpenClaw UI/chat

## Current State

### Working

- Batch first-round 1688 outreach works.
- Real IM conversations are being created and messages are being sent.
- Successful first-round outreach updates product records into `supplier_contacted_waiting_reply`.
- Supplier chat captures are being written into each product knowledge folder.
- Follow-up logic now uses AI for decision-making, while the script only executes.
- Duplicate follow-up sending for the same seller reply has been prevented.
- Batch monitoring can now loop over the follow-up queue and open each seller conversation using the correct per-product `search_summary_path`.

### Key Scripts

- First-round single outreach:
  - `C:\Users\More\Desktop\ai选品\scripts\test-1688-supplier-inquiry.js`
- First-round batch outreach:
  - `C:\Users\More\Desktop\ai选品\scripts\batch-1688-supplier-inquiry.js`
- Single seller watch / follow-up / ingest:
  - `C:\Users\More\Desktop\ai选品\scripts\watch-1688-supplier-reply.js`
- Batch follow-up queue monitor:
  - `C:\Users\More\Desktop\ai选品\scripts\batch-monitor-1688-supplier-replies.js`
- AI message + extraction helper:
  - `C:\Users\More\Desktop\ai选品\scripts\supplier-dialog-ai.js`
- Core workflow / queue refresh:
  - `C:\Users\More\Desktop\ai选品\scripts\merchant-workflow-lib.js`

### NPM Commands

- Batch first-round outreach:
  - `npm run 1688:batch -- --slug item-3-2b849d87 --slug item-4-da8723c1`
- Single seller watch:
  - `npm run 1688:watch -- --slug 3-847e4f82 --wait-reply-ms 15000`
- Batch queue watch:
  - `npm run 1688:monitor:batch -- --limit 6 --cycles 9999 --interval-ms 300000 --wait-reply-ms 8000`

## Queue Status At Handoff

### Still pending first outreach

From `C:\Users\More\Desktop\ai选品\queues\supplier-research-queue.json`

- `item-2-2050c16a`
- `pet-hair-remover-roller-e82f3297`

### Already contacted, waiting for seller reply

From `C:\Users\More\Desktop\ai选品\queues\supplier-followup-queue.json`

- `3-847e4f82` -> `祥通蜡业`
- `car-seat-gap-organizer-36237c9a` -> `畏莱服饰商行`
- `foldable-wardrobe-storage-box-70524214` -> `广东玖通塑业`
- `item-3-2b849d87` -> `伍伍叁橡塑科技`
- `item-4-da8723c1` -> `义乌市灵云百货`
- `item-7-9b608d96` -> `罗诚隆五金制品厂`
- `usb-657aef64` -> `河北信特塑料制品有限公司`

There is also one stale dirty queue item with no slug:

- supplier name: `众横汽车用品`

This should be removed or ignored safely.

## Important Lessons / Known Pitfalls

### 1. Do not use global-latest summary for seller watch

Each watched seller must use its own:

- `record.research.outreach.search_summary_path`

This was already fixed in:

- `C:\Users\More\Desktop\ai选品\scripts\batch-monitor-1688-supplier-replies.js`

### 2. English-only keywords on 1688 are dangerous

`Car Seat Gap Organizer` and `Foldable Wardrobe Storage Box` were contacted using weak English-biased search queries earlier.
The outreach technically succeeded, but search relevance is not trustworthy.

Next AI should:

- prefer Chinese keywords from `supplier-search-plan.json`
- avoid sending if keyword is effectively English-only
- optionally translate / regenerate Chinese keywords first

### 3. Follow-up should be AI-decided, not template-driven

The current watch script now does:

- seller reply capture
- AI decision: wait / send next natural message / ingest
- script execution only

This is the correct architecture.

### 4. Same seller reply must not trigger duplicate sends

This was fixed by:

- limiting autonomous sends
- tracking reply signature before another send

### 5. Queue refresh and old records are messy

Some historical records contain mojibake and one stale no-slug item.
Be careful when refreshing queues.

## Recommended Next Steps

### Immediate

1. Remove or sanitize the stale no-slug follow-up entry.
2. Build a live status file:
   - `C:\Users\More\Desktop\ai选品\output\live-status.json`
   - `C:\Users\More\Desktop\ai选品\output\live-status.md`
3. Mirror that status into OpenClaw chat or dashboard summary.

### Supplier loop

4. Run first outreach for the remaining pending items:
   - `item-2-2050c16a`
   - `pet-hair-remover-roller-e82f3297`
5. Keep batch monitoring running over all follow-up items.
6. When seller replies contain enough data, write:
   - `supplier-response.auto-draft.json`
   - archived `supplier-response.<timestamp>.json`
   and move the product to `human_review_pending`.

### Ozon automation

7. Build `draft-only` Ozon automation first:
   - generate listing title / bullets / attributes
   - prepare listing brief
   - save as Ozon draft
   - do not auto-publish yet

## What Not To Redo

- Do not re-debug the old OpenClaw 3.13 install path.
- Do not rely on the unstable OpenClaw UI as the source of truth.
- Do not reintroduce fixed follow-up templates as the main logic.
- Do not assume all 1688 contacts are relevant if the search keyword was weak.

## Source Of Truth

- Product knowledge records:
  - `C:\Users\More\Desktop\ai选品\knowledge-base\products\*\product.json`
- Queues:
  - `C:\Users\More\Desktop\ai选品\queues\*.json`
- Browser artifacts:
  - `C:\Users\More\Desktop\ai选品\output\playwright\`

