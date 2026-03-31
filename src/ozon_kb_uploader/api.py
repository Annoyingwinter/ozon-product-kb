from __future__ import annotations

from typing import Any

import requests

from .config import AccountSettings


class OzonSellerClient:
    def __init__(self, settings: AccountSettings, timeout_seconds: int = 60) -> None:
        self.settings = settings
        self.timeout_seconds = timeout_seconds

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Client-Id": self.settings.client_id,
            "Api-Key": self.settings.api_key,
            "Content-Type": "application/json",
        }

    def _url(self, path: str) -> str:
        return f"{self.settings.host.rstrip('/')}/{path.lstrip('/')}"

    def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        response = requests.post(
            self._url(path),
            headers=self.headers,
            json=payload,
            timeout=self.timeout_seconds,
        )
        content_type = response.headers.get("Content-Type", "")
        if "application/json" in content_type.lower():
            data = response.json()
            if response.ok:
                return data
            return {"http_status": response.status_code, **data}
        response.raise_for_status()
        return {"http_status": response.status_code, "message": response.text}

    def import_products(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        return self.post(self.settings.import_path, {"items": items})

    def import_info(self, task_id: int) -> dict[str, Any]:
        return self.post(self.settings.import_info_path, {"task_id": task_id})

    def warehouse_list(self) -> dict[str, Any]:
        return self.post(self.settings.warehouse_list_path, {})

    def update_stocks(self, stocks: list[dict[str, Any]]) -> dict[str, Any]:
        return self.post(self.settings.stock_path, {"stocks": stocks})
