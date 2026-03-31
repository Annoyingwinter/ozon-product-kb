from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


PRODUCT_DATA_FILES = ("product.json", "ozon-knowledge.json")


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _pick_first(*values: Any) -> Any:
    for value in values:
        if value is None:
            continue
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, list) and value:
            return value
        if isinstance(value, (int, float)) and value:
            return value
    return None


def _clean_text(value: str | None) -> str:
    if not value:
        return ""
    return " ".join(value.replace("\u3000", " ").split())


def _clean_bullets(values: list[str] | None) -> list[str]:
    if not values:
        return []
    cleaned = []
    for value in values:
        text = _clean_text(value)
        if text:
            cleaned.append(text)
    return cleaned


def _join_description(description: str, bullets: list[str]) -> str:
    parts: list[str] = []
    if description:
        parts.append(description)
    if bullets:
        parts.append("\n".join(f"- {bullet}" for bullet in bullets))
    return "\n\n".join(parts)


def _safe_number(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _kg_to_g(value: Any) -> int | None:
    number = _safe_number(value)
    if number is None:
        return None
    return int(round(number * 1000))


def _cm_to_mm(value: Any) -> int | None:
    number = _safe_number(value)
    if number is None:
        return None
    return int(round(number * 10))


@dataclass(slots=True)
class ProductRecord:
    slug: str
    folder: str
    title: str
    description: str
    bullet_points: list[str]
    brand: str
    vendor_code: str
    barcode: str
    price_rub: float | None
    old_price_rub: float | None
    weight_g: int | None
    depth_mm: int | None
    width_mm: int | None
    height_mm: int | None
    primary_image: str
    images: list[str]
    source_files: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _load_listing_data(folder: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    listing_title = {}
    listing_bullets = {}
    listing_attributes = {}

    title_ru = folder / "listing-title.ru.json"
    title_default = folder / "listing-title.json"
    bullets_ru = folder / "listing-bullets.ru.json"
    bullets_default = folder / "listing-bullets.json"
    listing_attr = folder / "listing-attributes.json"

    if title_ru.exists():
        listing_title = _read_json(title_ru)
    elif title_default.exists():
        listing_title = _read_json(title_default)

    if bullets_ru.exists():
        listing_bullets = _read_json(bullets_ru)
    elif bullets_default.exists():
        listing_bullets = _read_json(bullets_default)

    if listing_attr.exists():
        listing_attributes = _read_json(listing_attr)

    return listing_title, listing_bullets, listing_attributes


def load_product_record(folder: Path) -> ProductRecord:
    product_data = _read_json(folder / "product.json") if (folder / "product.json").exists() else {}
    knowledge = _read_json(folder / "ozon-knowledge.json") if (folder / "ozon-knowledge.json").exists() else {}
    listing_title, listing_bullets, listing_attributes = _load_listing_data(folder)

    product_block = product_data.get("product", {})

    title = _clean_text(
        _pick_first(
            listing_title.get("selected_title_ru"),
            listing_title.get("selected_title"),
            knowledge.get("title_ru"),
            knowledge.get("title_en"),
            knowledge.get("title_cn"),
            product_block.get("name"),
            listing_attributes.get("product_name"),
        )
        or folder.name
    )

    bullets = _clean_bullets(
        _pick_first(
            listing_bullets.get("bullets_ru"),
            listing_bullets.get("bullets"),
            knowledge.get("bullet_points"),
        )
        or []
    )
    description = _clean_text(knowledge.get("description")) or _join_description("", bullets)
    if bullets and description and description not in bullets:
        description = _join_description(description, bullets)

    brand = _clean_text(_pick_first(knowledge.get("brand"), product_block.get("brand")) or "")
    vendor_code = _clean_text(
        _pick_first(knowledge.get("vendor_code"), product_block.get("vendor_code")) or folder.name
    )
    barcode = _clean_text(knowledge.get("barcode") or "")

    price_rub = _safe_number(
        _pick_first(
            product_block.get("target_price_rub"),
            listing_attributes.get("target_price_rub"),
        )
    )

    old_price_rub = None
    if knowledge.get("currency") == "RUB":
        old_price_rub = _safe_number(knowledge.get("old_price"))

    weight_g = _kg_to_g(
        _pick_first(
            product_block.get("est_weight_kg"),
            listing_attributes.get("weight_kg"),
            knowledge.get("weight"),
        )
    )

    depth_mm = _cm_to_mm(
        _pick_first(
            knowledge.get("length"),
            product_block.get("package_long_edge_cm"),
            listing_attributes.get("long_edge_cm"),
        )
    )
    width_mm = _cm_to_mm(knowledge.get("width"))
    height_mm = _cm_to_mm(knowledge.get("height"))

    images = knowledge.get("images") or []
    primary_image = _clean_text(_pick_first(knowledge.get("main_image"), images[0] if images else ""))

    source_files = [
        path.name
        for path in (
            folder / "product.json",
            folder / "ozon-knowledge.json",
            folder / "listing-title.json",
            folder / "listing-title.ru.json",
            folder / "listing-bullets.json",
            folder / "listing-bullets.ru.json",
            folder / "listing-attributes.json",
        )
        if path.exists()
    ]

    return ProductRecord(
        slug=folder.name,
        folder=str(folder),
        title=title,
        description=description,
        bullet_points=bullets,
        brand=brand,
        vendor_code=vendor_code,
        barcode=barcode,
        price_rub=price_rub,
        old_price_rub=old_price_rub,
        weight_g=weight_g,
        depth_mm=depth_mm,
        width_mm=width_mm,
        height_mm=height_mm,
        primary_image=primary_image,
        images=images,
        source_files=source_files,
    )


def discover_product_folders(root: Path) -> list[Path]:
    folders: list[Path] = []
    seen_slugs: set[str] = set()

    def add_folder(folder: Path) -> None:
        if not folder.is_dir():
            return
        if folder.name in seen_slugs:
            return
        if not any((folder / filename).exists() for filename in PRODUCT_DATA_FILES):
            return
        seen_slugs.add(folder.name)
        folders.append(folder)

    for child in sorted(root.iterdir()):
        if child.name.startswith("item-") or child.name.startswith("ITEM-"):
            add_folder(child)

    kb_products_dir = root / "knowledge-base" / "products"
    if kb_products_dir.exists():
        for child in sorted(kb_products_dir.iterdir()):
            add_folder(child)

    return folders
