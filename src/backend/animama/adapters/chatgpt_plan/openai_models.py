"""The models a signed-in ChatGPT account may use, read from ``GET https://api.openai.com/v1/models``.

The access token goes only to OpenAI's API host, a constant; redirects are not
followed. The listing is written for OpenAI's own coding client and carries its
prompts (tens of thousands of characters an item): only the fields Animama uses
are read, and the response is never logged.
"""

from __future__ import annotations

from typing import Any

import httpx

from animama.adapters.chatgpt_plan.openai_identity import API_BASE
from animama.app.ports.chatgpt_plan_port import ChatGPTPlanModelListError, PlanModelListing

_MAX_ITEMS = 200


class OpenAIChatGPTPlanModels:
    """Implement ``ChatGPTPlanModelListPort`` over HTTPS."""

    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=False,
            transport=transport,
            trust_env=transport is None,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def list_models(self, access_token: str) -> list[PlanModelListing]:
        try:
            response = await self._client.get(
                f"{API_BASE}/models",
                headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
            )
        except httpx.HTTPError as error:
            raise ChatGPTPlanModelListError("network_error") from error
        if response.status_code == 401:
            raise ChatGPTPlanModelListError("token_rejected", rejected_token=True)
        if response.status_code != 200:
            raise ChatGPTPlanModelListError(f"status_{response.status_code}")
        try:
            payload = response.json()
        except ValueError as error:
            raise ChatGPTPlanModelListError("listing_invalid") from error
        items = payload.get("models") if isinstance(payload, dict) else None
        if not isinstance(items, list):
            raise ChatGPTPlanModelListError("listing_invalid")
        listings = [_listing(item) for item in items[:_MAX_ITEMS] if isinstance(item, dict)]
        return [listing for listing in listings if listing is not None]


def _listing(item: dict[str, Any]) -> PlanModelListing | None:
    slug = item.get("slug")
    if not isinstance(slug, str) or not slug.strip() or len(slug) > 128:
        return None
    display = item.get("display_name")
    window = item.get("context_window")
    levels = item.get("supported_reasoning_levels")
    efforts = tuple(
        level["effort"]
        for level in (levels if isinstance(levels, list) else [])
        if isinstance(level, dict) and isinstance(level.get("effort"), str)
    )
    modalities = item.get("input_modalities")
    return PlanModelListing(
        slug=slug.strip(),
        display_name=display.strip() if isinstance(display, str) and display.strip() else slug.strip(),
        listed=item.get("visibility") == "list",
        context_window=window if isinstance(window, int) and not isinstance(window, bool) and window > 0 else None,
        input_modalities=tuple(
            value for value in (modalities if isinstance(modalities, list) else []) if isinstance(value, str)
        ),
        reasoning_efforts=efforts,
        supports_search=item.get("supports_search_tool") is True,
    )
