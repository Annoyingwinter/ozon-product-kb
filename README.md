# ozon-product-kb

This folder now combines two parts in one workspace:

- The upstream `ozon-product-kb` knowledge base, selection pipeline, images, queues, and Node scripts
- Your local Python Ozon uploader, which is now the default upload path

## Current Layout

- `knowledge-base/products/<slug>/`
  - Upstream product knowledge base
  - May already contain `ozon-import-mapping.json`
- `configs/mappings/<slug>.json`
  - Local override mappings
  - If a slug exists here, it overrides the upstream mapping
- `src/ozon_kb_uploader/`
  - The active Ozon uploader used for scan, build, submit, stock, and raw API calls
- `scripts/`
  - Upstream Node workflow scripts plus local Python helper entrypoints

## Mapping Resolution

The uploader now resolves mappings in this order:

1. `configs/mappings/<slug>.json`
2. `knowledge-base/products/<slug>/ozon-import-mapping.json`

This means you can keep the upstream KB as-is, and only create local overrides when needed.

## Product Discovery

The uploader now scans both:

- legacy top-level product folders such as `item-*`
- upstream folders under `knowledge-base/products/<slug>/`

It also supports non-`item-*` slugs such as `car-seat-gap-organizer-36237c9a`.

## Ozon Upload Commands

### Python CLI

```powershell
python -m ozon_kb_uploader.cli scan
python -m ozon_kb_uploader.cli scaffold --all
python -m ozon_kb_uploader.cli build --all
python -m ozon_kb_uploader.cli submit --all
python -m ozon_kb_uploader.cli stock --all
python -m ozon_kb_uploader.cli status 123456789 --raw
python -m ozon_kb_uploader.cli call --path /v1/warehouse/list
```

### npm Shortcuts

```powershell
npm run ozon:upload:scan
npm run ozon:upload:scaffold
npm run ozon:upload:build
npm run ozon:upload:submit
npm run ozon:upload:stock
```

## Upstream Workflow Commands

These scripts are still available for selection, supplier discovery, and draft generation:

```powershell
npm run select:1688:ozon
npm run pipeline:1688:ozon
npm run ozon:chief
npm run ozon:draft
npm run kb:audit
```

Two missing upstream entrypoints were bridged locally:

- `npm run workflow:prepare`
- `npm run kb:pipeline`

## Notes

- The active upload implementation is the Python uploader, not a separate upstream uploader.
- Upstream `ozon-import-mapping.json` files are accepted directly.
- Upstream shorthand attributes such as `{ "id": 85, "value": "...", "dictionary_value_id": ... }` are automatically normalized into Ozon API payload format.
- Account-level defaults remain in `.env` and `configs/account.json`.
