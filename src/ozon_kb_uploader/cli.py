from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from .api import OzonSellerClient
from .config import load_account_settings
from .loader import ProductRecord, discover_product_folders, load_product_record


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _timestamp_for_filename() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S-%f")


def _legacy_mapping_path(root: Path, slug: str) -> Path:
    return root / "configs" / "mappings" / f"{slug}.json"


def _kb_mapping_path(root: Path, slug: str) -> Path:
    return root / "knowledge-base" / "products" / slug / "ozon-import-mapping.json"


def _mapping_path(root: Path, slug: str) -> Path:
    legacy_path = _legacy_mapping_path(root, slug)
    kb_path = _kb_mapping_path(root, slug)

    if legacy_path.exists():
        return legacy_path
    if kb_path.exists():
        return kb_path

    kb_product_dir = root / "knowledge-base" / "products" / slug
    legacy_product_dir = root / slug
    if kb_product_dir.is_dir() and not legacy_product_dir.is_dir():
        return kb_path

    return legacy_path


def _normalize_mapping_value(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        normalized: dict[str, Any] = {}
        if value.get("dictionary_value_id") not in (None, ""):
            normalized["dictionary_value_id"] = value["dictionary_value_id"]
        if value.get("value") not in (None, ""):
            normalized["value"] = value["value"]
        return normalized
    if value in (None, ""):
        return {}
    return {"value": value}


def _normalize_mapping_attribute(attribute: Any) -> Any:
    if not isinstance(attribute, dict):
        return attribute
    if isinstance(attribute.get("values"), list):
        normalized = dict(attribute)
        normalized.setdefault("complex_id", 0)
        return normalized

    attribute_id = attribute.get("id")
    if attribute_id in (None, ""):
        return attribute

    raw_value = attribute.get("value")
    if isinstance(raw_value, list):
        values = [
            normalized
            for item in raw_value
            if (normalized := _normalize_mapping_value(item))
        ]
    else:
        normalized_value = _normalize_mapping_value(attribute)
        values = [normalized_value] if normalized_value else []

    normalized_attribute = {
        "complex_id": int(attribute.get("complex_id") or 0),
        "id": attribute_id,
        "values": values,
    }
    return normalized_attribute


def _normalize_mapping(mapping: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(mapping)
    import_fields = dict(normalized.get("import_fields") or {})
    attributes = import_fields.get("attributes")
    if isinstance(attributes, list):
        import_fields["attributes"] = [
            _normalize_mapping_attribute(attribute)
            for attribute in attributes
        ]
    normalized["import_fields"] = import_fields
    return normalized


def _load_mapping(root: Path, slug: str) -> dict[str, Any]:
    path = _mapping_path(root, slug)
    if not path.exists():
        return {}
    return _normalize_mapping(_read_json(path))


def _format_money(value: float | int | None) -> str | None:
    if value is None:
        return None
    return f"{float(value):.2f}"


def _clean_payload(data: dict[str, Any]) -> dict[str, Any]:
    cleaned: dict[str, Any] = {}
    for key, value in data.items():
        if value in (None, "", [], {}):
            continue
        cleaned[key] = value
    return cleaned


def _deep_merge(base: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in extra.items():
        if (
            key in merged
            and isinstance(merged[key], dict)
            and isinstance(value, dict)
        ):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _default_old_price(record: ProductRecord, factor: float) -> float | None:
    if record.old_price_rub is not None:
        return record.old_price_rub
    if record.price_rub is None:
        return None
    return round(record.price_rub * factor, 2)


def _scaffold_mapping(record: ProductRecord, settings: Any) -> dict[str, Any]:
    return {
        "slug": record.slug,
        "enabled": True,
        "offer_id": record.vendor_code or f"{settings.offer_id_prefix}{record.slug}",
        "title_override": "",
        "description_override": "",
        "price_override": record.price_rub,
        "old_price_override": _default_old_price(record, settings.old_price_factor),
        "price_override_rub": record.price_rub,
        "old_price_override_rub": _default_old_price(record, settings.old_price_factor),
        "initial_stock": settings.default_initial_stock,
        "warehouse_id": settings.default_warehouse_id,
        "weight_override_g": record.weight_g,
        "depth_override_mm": record.depth_mm,
        "width_override_mm": record.width_mm,
        "height_override_mm": record.height_mm,
        "barcode_override": record.barcode,
        "primary_image_override": record.primary_image,
        "images_override": record.images,
        "import_fields": {
            "description_category_id": 0,
            "type_id": 0,
            "attributes": []
        },
        "notes": [
            "Fill import_fields.description_category_id with the Ozon category ID.",
            "Fill import_fields.type_id with the Ozon type ID.",
            "Fill import_fields.attributes with all required Ozon attributes for this category.",
            "Keep title and description derived from the local knowledge base unless moderation requires changes."
        ]
    }


def _record_summary(root: Path, record: ProductRecord) -> dict[str, Any]:
    mapping = _load_mapping(root, record.slug)
    mapping_exists = bool(mapping)
    effective_images = mapping.get("images_override") or record.images
    return {
        "slug": record.slug,
        "title": record.title,
        "price_rub": record.price_rub,
        "images": len(effective_images),
        "has_mapping": mapping_exists,
        "mapping_ready": _mapping_is_ready(mapping)[0] if mapping else False,
        "mapping_path": str(_mapping_path(root, record.slug)) if mapping_exists else "",
        "source_files": record.source_files,
    }


def _load_records(root: Path, slugs: Iterable[str] | None = None) -> list[ProductRecord]:
    slug_set = set(slugs or [])
    records = []
    for folder in discover_product_folders(root):
        if slug_set and folder.name not in slug_set:
            continue
        records.append(load_product_record(folder))
    return records


def _mapping_is_ready(mapping: dict[str, Any]) -> tuple[bool, list[str]]:
    if not mapping:
        return False, ["missing mapping file"]
    import_fields = mapping.get("import_fields", {})
    reasons: list[str] = []
    if int(import_fields.get("description_category_id") or 0) <= 0:
        reasons.append("description_category_id is missing")
    if int(import_fields.get("type_id") or 0) <= 0:
        reasons.append("type_id is missing")
    if not isinstance(import_fields.get("attributes"), list) or not import_fields.get("attributes"):
        reasons.append("attributes are missing")
    return not reasons, reasons


def _build_stock_payload(
    record: ProductRecord,
    mapping: dict[str, Any],
    settings: Any,
    stock_override: int | None = None,
) -> tuple[dict[str, Any] | None, list[str]]:
    reasons: list[str] = []
    offer_id = mapping.get("offer_id") or record.vendor_code or record.slug
    warehouse_id = int(mapping.get("warehouse_id") or settings.default_warehouse_id or 0)
    stock = stock_override
    if stock is None:
        stock = mapping.get("initial_stock", settings.default_initial_stock)
    try:
        stock = int(stock)
    except (TypeError, ValueError):
        stock = 0

    if warehouse_id <= 0:
        reasons.append("warehouse_id is missing")
    if stock < 0:
        reasons.append("initial_stock must be >= 0")

    if reasons:
        return None, reasons

    return {
        "offer_id": offer_id,
        "stock": stock,
        "warehouse_id": warehouse_id,
    }, []


def _build_item_payload(
    record: ProductRecord,
    mapping: dict[str, Any],
    settings: Any,
) -> dict[str, Any]:
    offer_id = mapping.get("offer_id") or record.vendor_code or f"{settings.offer_id_prefix}{record.slug}"
    title = mapping.get("title_override") or record.title
    description = mapping.get("description_override") or record.description
    price_value = mapping.get(
        "price_override",
        mapping.get("price_override_rub", record.price_rub),
    )
    old_price_value = mapping.get(
        "old_price_override",
        mapping.get(
            "old_price_override_rub",
            _default_old_price(record, settings.old_price_factor),
        ),
    )
    currency_code = mapping.get("currency_code") or settings.currency_code
    vat = mapping.get("vat") or settings.vat
    barcode = mapping.get("barcode_override") or record.barcode
    primary_image = mapping.get("primary_image_override") or record.primary_image
    images = mapping.get("images_override") or record.images
    weight_g = mapping.get("weight_override_g", record.weight_g)
    depth_mm = mapping.get("depth_override_mm", record.depth_mm)
    width_mm = mapping.get("width_override_mm", record.width_mm)
    height_mm = mapping.get("height_override_mm", record.height_mm)

    base_payload = _clean_payload(
        {
            "offer_id": offer_id,
            "name": title,
            "description": description,
            "barcode": barcode,
            "price": _format_money(price_value),
            "old_price": _format_money(old_price_value),
            "currency_code": currency_code,
            "vat": vat,
            "primary_image": primary_image,
            "images": images,
            "weight": weight_g,
            "weight_unit": "g" if weight_g else None,
            "depth": depth_mm,
            "width": width_mm,
            "height": height_mm,
            "dimension_unit": "mm" if any(
                value is not None
                for value in (depth_mm, width_mm, height_mm)
            ) else None,
        }
    )

    payload = _deep_merge(base_payload, settings.default_import_fields)
    payload = _deep_merge(payload, mapping.get("import_fields", {}))
    return _clean_payload(payload)


def cmd_scan(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    records = _load_records(root, args.slug)
    summary = [_record_summary(root, record) for record in records]
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    for item in summary:
        print(
            f"{item['slug']}\n"
            f"  title: {item['title']}\n"
            f"  price_rub: {item['price_rub']}\n"
            f"  images: {item['images']}\n"
            f"  mapping: {'yes' if item['has_mapping'] else 'no'}\n"
            f"  mapping_ready: {'yes' if item['mapping_ready'] else 'no'}\n"
        )
    print(f"total: {len(summary)}")
    return 0


def cmd_scaffold(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    settings = load_account_settings(root)
    records = _load_records(root, args.slug)
    created = 0
    for record in records:
        path = _mapping_path(root, record.slug)
        if path.exists() and not args.force:
            continue
        _write_json(path, _scaffold_mapping(record, settings))
        created += 1
        print(f"scaffolded {record.slug}: {path}")
    print(f"created: {created}")
    return 0


def cmd_build(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    settings = load_account_settings(root)
    records = _load_records(root, args.slug)
    items: list[dict[str, Any]] = []
    skipped: list[str] = []

    for record in records:
        mapping = _load_mapping(root, record.slug)
        if not mapping:
            skipped.append(record.slug)
            continue
        if mapping.get("enabled", True) is False:
            skipped.append(record.slug)
            continue
        ready, reasons = _mapping_is_ready(mapping)
        if not ready:
            skipped.append(f"{record.slug} ({'; '.join(reasons)})")
            continue
        items.append(_build_item_payload(record, mapping, settings))

    if not items:
        print("No mapped products to build.")
        if skipped:
            print("Skipped:", ", ".join(skipped))
        return 1

    timestamp = _timestamp_for_filename()
    request_path = root / "dist" / "imports" / f"{timestamp}-request.json"
    _write_json(request_path, {"items": items})
    print(f"built request: {request_path}")
    print(f"items: {len(items)}")
    if skipped:
        print(f"skipped: {', '.join(skipped)}")
    return 0


def cmd_submit(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    settings = load_account_settings(root)
    missing = []
    if not settings.client_id:
        missing.append("OZON_CLIENT_ID")
    if not settings.api_key:
        missing.append("OZON_API_KEY")
    if missing:
        print("Missing credentials:", ", ".join(missing))
        return 1

    records = _load_records(root, args.slug)
    items: list[dict[str, Any]] = []
    for record in records:
        mapping = _load_mapping(root, record.slug)
        if not mapping or mapping.get("enabled", True) is False:
            continue
        ready, reasons = _mapping_is_ready(mapping)
        if not ready:
            print(f"Skipping {record.slug}: {'; '.join(reasons)}")
            continue
        items.append(_build_item_payload(record, mapping, settings))

    if not items:
        print("No mapped products to submit.")
        return 1

    client = OzonSellerClient(settings)
    response = client.import_products(items)

    timestamp = _timestamp_for_filename()
    response_path = root / "dist" / "imports" / f"{timestamp}-response.json"
    _write_json(response_path, response)
    print(json.dumps(response, ensure_ascii=False, indent=2))
    print(f"saved response: {response_path}")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    settings = load_account_settings(root)
    missing = []
    if not settings.client_id:
        missing.append("OZON_CLIENT_ID")
    if not settings.api_key:
        missing.append("OZON_API_KEY")
    if missing:
        print("Missing credentials:", ", ".join(missing))
        return 1

    client = OzonSellerClient(settings)
    response = client.import_info(args.task_id)
    if args.raw:
        print(json.dumps(response, ensure_ascii=False, indent=2))
        return 0

    print(json.dumps(response, ensure_ascii=False, indent=2))
    return 0


def cmd_call(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    settings = load_account_settings(root)
    missing = []
    if not settings.client_id:
        missing.append("OZON_CLIENT_ID")
    if not settings.api_key:
        missing.append("OZON_API_KEY")
    if missing:
        print("Missing credentials:", ", ".join(missing))
        return 1

    payload: dict[str, Any] = {}
    if args.body_file:
        payload = _read_json(Path(args.body_file))

    client = OzonSellerClient(settings)
    response = client.post(args.path, payload)
    print(json.dumps(response, ensure_ascii=False, indent=2))
    return 0


def cmd_stock(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    settings = load_account_settings(root)
    missing = []
    if not settings.client_id:
        missing.append("OZON_CLIENT_ID")
    if not settings.api_key:
        missing.append("OZON_API_KEY")
    if missing:
        print("Missing credentials:", ", ".join(missing))
        return 1

    records = _load_records(root, args.slug)
    stocks: list[dict[str, Any]] = []
    skipped: list[str] = []

    for record in records:
        mapping = _load_mapping(root, record.slug)
        if not mapping or mapping.get("enabled", True) is False:
            skipped.append(f"{record.slug} (missing or disabled mapping)")
            continue
        stock_payload, reasons = _build_stock_payload(record, mapping, settings, args.stock)
        if stock_payload is None:
            skipped.append(f"{record.slug} ({'; '.join(reasons)})")
            continue
        stocks.append(stock_payload)

    if not stocks:
        print("No products ready for stock update.")
        if skipped:
            print("Skipped:", ", ".join(skipped))
        return 1

    client = OzonSellerClient(settings)
    response = client.update_stocks(stocks)

    timestamp = _timestamp_for_filename()
    response_path = root / "dist" / "stocks" / f"{timestamp}-response.json"
    _write_json(response_path, response)
    print(json.dumps(response, ensure_ascii=False, indent=2))
    print(f"saved response: {response_path}")
    if skipped:
        print(f"skipped: {', '.join(skipped)}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build and submit Ozon product imports from local KB folders.")
    parser.add_argument("--root", default=".", help="Repository root.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    scan_parser = subparsers.add_parser("scan", help="Scan local product KB folders.")
    scan_parser.add_argument("--slug", action="append", help="Only include one slug. Repeatable.")
    scan_parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    scan_parser.set_defaults(func=cmd_scan)

    scaffold_parser = subparsers.add_parser("scaffold", help="Create mapping scaffold files.")
    scaffold_parser.add_argument("--slug", action="append", help="Only scaffold one slug. Repeatable.")
    scaffold_parser.add_argument("--all", action="store_true", help="Ignored flag for convenience.")
    scaffold_parser.add_argument("--force", action="store_true", help="Overwrite existing mapping files.")
    scaffold_parser.set_defaults(func=cmd_scaffold)

    build_parser_cmd = subparsers.add_parser("build", help="Build Ozon import payloads without submitting.")
    build_parser_cmd.add_argument("--slug", action="append", help="Only build one slug. Repeatable.")
    build_parser_cmd.add_argument("--all", action="store_true", help="Ignored flag for convenience.")
    build_parser_cmd.set_defaults(func=cmd_build)

    submit_parser = subparsers.add_parser("submit", help="Submit mapped products to Ozon.")
    submit_parser.add_argument("--slug", action="append", help="Only submit one slug. Repeatable.")
    submit_parser.add_argument("--all", action="store_true", help="Ignored flag for convenience.")
    submit_parser.set_defaults(func=cmd_submit)

    stock_parser = subparsers.add_parser("stock", help="Update stock for mapped products.")
    stock_parser.add_argument("--slug", action="append", help="Only update one slug. Repeatable.")
    stock_parser.add_argument("--all", action="store_true", help="Ignored flag for convenience.")
    stock_parser.add_argument("--stock", type=int, help="Override stock quantity for this run.")
    stock_parser.set_defaults(func=cmd_stock)

    status_parser = subparsers.add_parser("status", help="Check import task status.")
    status_parser.add_argument("task_id", type=int, help="Ozon import task id.")
    status_parser.add_argument("--raw", action="store_true", help="Print raw JSON only.")
    status_parser.set_defaults(func=cmd_status)

    call_parser = subparsers.add_parser("call", help="Call any Ozon POST endpoint with a JSON body.")
    call_parser.add_argument("--path", required=True, help="API path like /v1/description-category/tree")
    call_parser.add_argument("--body-file", help="Path to a JSON request body file.")
    call_parser.set_defaults(func=cmd_call)

    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
