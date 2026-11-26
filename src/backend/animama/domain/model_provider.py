from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from .model_connection import (
    BUILTIN_OPENAI_CONNECTION_ID,
    MODEL_KIND_CHAT,
    MODEL_SOURCE_BUILTIN,
    ModelConnection,
)


@dataclass(slots=True)
class ModelProviderCapabilities:
    """Provider/model capability metadata used for selection and compatibility."""

    accepts: list[str] = field(default_factory=list)
    produces: list[str] = field(default_factory=list)
    supports_developer_role: bool = True
    supports_tools: bool = False
    supports_streaming: bool = False
    structured_kinds: list[str] = field(default_factory=list)
    structured_output_transport: str | None = None
    supports_reasoning: bool | None = None
    supported_reasoning_efforts: list[str] | None = None
    native_tool_support: list[str] | None = None
    tools_with_structured_output: bool = True
    """Whether one request may carry both function tools and a response format.

    Some local servers reject the combination or ignore the tools; those turns
    call tools first and request the structured reply in a separate round.
    """


@dataclass(slots=True)
class ModelProviderPricing:
    """Backend-internal pricing and rate-card source metadata for a catalog row."""

    pricing_status: str = "unpriced"
    pricing_source_provider: str | None = None
    pricing_source_model: str | None = None
    pricing_source_url: str | None = None
    pricing_source_checked_at: date | None = None
    currency: str | None = None
    billing_unit: str | None = None
    service_tiers_supported: list[str] = field(default_factory=list)
    standard_input_price_per_million: Decimal | None = None
    standard_cached_input_price_per_million: Decimal | None = None
    standard_output_price_per_million: Decimal | None = None
    batch_input_price_per_million: Decimal | None = None
    batch_cached_input_price_per_million: Decimal | None = None
    batch_output_price_per_million: Decimal | None = None
    flex_input_price_per_million: Decimal | None = None
    flex_cached_input_price_per_million: Decimal | None = None
    flex_output_price_per_million: Decimal | None = None
    priority_input_price_per_million: Decimal | None = None
    priority_cached_input_price_per_million: Decimal | None = None
    priority_output_price_per_million: Decimal | None = None
    long_context_token_threshold: int | None = None
    standard_long_context_input_price_per_million: Decimal | None = None
    standard_long_context_cached_input_price_per_million: Decimal | None = None
    standard_long_context_output_price_per_million: Decimal | None = None
    batch_long_context_input_price_per_million: Decimal | None = None
    batch_long_context_cached_input_price_per_million: Decimal | None = None
    batch_long_context_output_price_per_million: Decimal | None = None
    flex_long_context_input_price_per_million: Decimal | None = None
    flex_long_context_cached_input_price_per_million: Decimal | None = None
    flex_long_context_output_price_per_million: Decimal | None = None
    priority_long_context_input_price_per_million: Decimal | None = None
    priority_long_context_cached_input_price_per_million: Decimal | None = None
    priority_long_context_output_price_per_million: Decimal | None = None
    regional_processing_uplift_factor: Decimal | None = None
    pricing_notes: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ModelProvider:
    """Durable provider/model catalog row without leaking pricing into runtime Agent.

    Each row belongs to one model connection (``connection_id``). Repositories
    attach the loaded ``connection`` so model clients can reach its endpoint;
    rows built outside the database may leave it unset only on the built-in
    connection they name. ``source`` separates release-managed built-in
    rows from owner-added rows, which releases never modify.

    ``early_compaction`` is the owner's **Compact early** choice. It applies
    only to rows whose pricing has a long-context step; like ``hidden``,
    catalog re-seeding never changes it on built-in rows.
    """

    id: str
    model: str
    provider_type: str
    model_label: str
    provider_label: str
    logo_provider: str | None = None
    model_type: str | None = None
    current_snapshot: str | None = None
    context_window_tokens: int | None = None
    max_output_tokens: int | None = None
    connection_id: str = BUILTIN_OPENAI_CONNECTION_ID
    source: str = MODEL_SOURCE_BUILTIN
    model_kind: str = MODEL_KIND_CHAT
    hidden: bool = False
    early_compaction: bool = True
    allow_memory_writes: bool = True
    probe_result: dict[str, Any] | None = None
    active: bool = True
    deprecated_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    capabilities: ModelProviderCapabilities = field(default_factory=ModelProviderCapabilities)
    pricing: ModelProviderPricing = field(default_factory=ModelProviderPricing)
    metadata: dict[str, Any] = field(default_factory=dict)
    connection: ModelConnection | None = None

    @property
    def accepts_images(self) -> bool:
        """Whether the model takes image input, as its catalog row or the owner declares."""

        return "image" in self.capabilities.accepts

    @property
    def accepts_developer_role(self) -> bool:
        """Whether requests may send ``developer`` messages to this row.

        False when the model lacks the role or its connection folds developer
        messages into the system message.
        """

        folds = self.connection is not None and self.connection.compatibility.fold_developer_role
        return bool(self.capabilities.supports_developer_role) and not folds


@dataclass(frozen=True, slots=True)
class AnimaModelUsage:
    """An owned Anima whose chat profile selects a catalog row."""

    anima_id: str
    display_name: str
    model_provider_id: str


__all__ = [
    "AnimaModelUsage",
    "ModelProviderCapabilities",
    "ModelProvider",
    "ModelProviderPricing",
]
