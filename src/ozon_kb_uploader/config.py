from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from dotenv import load_dotenv


DEFAULT_HOST = "https://api-seller.ozon.ru"
DEFAULT_IMPORT_PATH = "/v3/product/import"
DEFAULT_IMPORT_INFO_PATH = "/v1/product/import/info"
DEFAULT_STOCK_PATH = "/v2/products/stocks"
DEFAULT_WAREHOUSE_LIST_PATH = "/v1/warehouse/list"


@dataclass(slots=True)
class AccountSettings:
    host: str = DEFAULT_HOST
    client_id: str = ""
    api_key: str = ""
    import_path: str = DEFAULT_IMPORT_PATH
    import_info_path: str = DEFAULT_IMPORT_INFO_PATH
    stock_path: str = DEFAULT_STOCK_PATH
    warehouse_list_path: str = DEFAULT_WAREHOUSE_LIST_PATH
    currency_code: str = "RUB"
    vat: str = "0"
    old_price_factor: float = 1.15
    offer_id_prefix: str = "KB-"
    default_warehouse_id: int = 0
    default_initial_stock: int = 100
    default_import_fields: dict[str, Any] = field(default_factory=dict)


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def load_account_settings(root: Path) -> AccountSettings:
    load_dotenv(root / ".env")

    account_path = root / "configs" / "account.json"
    data = _read_json(account_path)

    return AccountSettings(
        host=os.getenv("OZON_API_HOST", data.get("host", DEFAULT_HOST)),
        client_id=os.getenv("OZON_CLIENT_ID", data.get("client_id", "")),
        api_key=os.getenv("OZON_API_KEY", data.get("api_key", "")),
        import_path=os.getenv(
            "OZON_IMPORT_PATH", data.get("import_path", DEFAULT_IMPORT_PATH)
        ),
        import_info_path=os.getenv(
            "OZON_IMPORT_INFO_PATH",
            data.get("import_info_path", DEFAULT_IMPORT_INFO_PATH),
        ),
        stock_path=data.get("stock_path", DEFAULT_STOCK_PATH),
        warehouse_list_path=data.get(
            "warehouse_list_path", DEFAULT_WAREHOUSE_LIST_PATH
        ),
        currency_code=data.get("currency_code", "RUB"),
        vat=str(data.get("vat", "0")),
        old_price_factor=float(data.get("old_price_factor", 1.15)),
        offer_id_prefix=data.get("offer_id_prefix", "KB-"),
        default_warehouse_id=int(data.get("default_warehouse_id", 0) or 0),
        default_initial_stock=int(data.get("default_initial_stock", 100) or 100),
        default_import_fields=data.get("default_import_fields", {}),
    )
