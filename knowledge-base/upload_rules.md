# Ozon Upload Rules

## Required product coverage
- Identification: spu_id, sku_id, source_platform, source_url, vendor_code, barcode
- Selling: price, currency, stock, min_order_qty, package_quantity, dimensions, weight
- Category and attributes: category_path, ozon_category_id, attributes
- Media: main_image, images, image_count, image_hash
- Compliance: dangerous_goods, country_of_origin, certificate_files, customs_code

## Field policy
- Leave unknown fields blank but keep the key in JSON.
- Prefer values extracted from 1688 detail pages over search-card snippets.
- One product must contain at least three comparable 1688 offers before it can be marked knowledge_base_ready.
- Images should be URL-based and deduplicated before export.

## Variant policy
- group_id must stay stable across all variants.
- variant_theme stays blank unless the detail page clearly exposes a variant dimension such as color or size.
- variant_values must be an object, even when empty.
