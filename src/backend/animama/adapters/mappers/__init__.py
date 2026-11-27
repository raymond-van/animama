"""Schema/ORM ↔ domain mappers (Stage 3).

These helpers translate between Pydantic schemas, ORM models, and domain
dataclasses. Keep mapping logic localised to avoid leaking framework types
into the domain layer.
"""

from .anima_chat_profile_map import (
    anima_chat_profile_domain_to_orm,
    anima_chat_profile_orm_to_domain,
    apply_anima_chat_profile_to_orm,
)
from .anima_map import (
    anima_domain_to_orm,
    anima_domain_to_schema,
    anima_orm_to_domain,
)
from .avatar_map import avatar_domain_to_orm, avatar_domain_to_schema, avatar_orm_to_domain
from .chat_compaction_map import chat_compaction_domain_to_orm, chat_compaction_orm_to_domain
from .chat_map import chat_domain_to_orm, chat_orm_to_domain
from .chat_message_map import chat_message_domain_to_orm, chat_message_orm_to_domain
from .generation_map import (
    generation_conversation_orm_to_domain,
    generation_draft_orm_to_domain,
    generation_message_orm_to_domain,
)
from .model_provider_map import (
    apply_model_provider_to_orm,
    model_provider_domain_to_orm,
    model_provider_domain_to_public_catalog_row,
    model_provider_orm_to_domain,
    model_provider_registry_row_to_domain,
)
from .settings_map import (
    anima_settings_domain_to_orm,
    anima_settings_domain_to_schema,
    anima_settings_orm_to_domain,
    apply_anima_settings_to_orm,
    apply_user_settings_to_orm,
    user_settings_domain_to_orm,
    user_settings_domain_to_schema,
    user_settings_orm_to_domain,
)
from .user_profile_map import (
    apply_user_profile_to_orm,
    user_profile_domain_to_orm,
    user_profile_orm_to_domain,
)

__all__ = [
    "apply_model_provider_to_orm",
    "model_provider_domain_to_orm",
    "model_provider_domain_to_public_catalog_row",
    "model_provider_orm_to_domain",
    "model_provider_registry_row_to_domain",
    # Avatar
    "avatar_domain_to_schema",
    "avatar_domain_to_orm",
    "avatar_orm_to_domain",
    # Anima
    "anima_domain_to_schema",
    "anima_domain_to_orm",
    "anima_orm_to_domain",
    "apply_anima_chat_profile_to_orm",
    "anima_chat_profile_domain_to_orm",
    "anima_chat_profile_orm_to_domain",
    # Chats
    "chat_domain_to_orm",
    "chat_orm_to_domain",
    "chat_compaction_domain_to_orm",
    "chat_compaction_orm_to_domain",
    "chat_message_domain_to_orm",
    "chat_message_orm_to_domain",
    # Content assistant
    "generation_conversation_orm_to_domain",
    "generation_draft_orm_to_domain",
    "generation_message_orm_to_domain",
    # Settings
    "user_settings_orm_to_domain",
    "anima_settings_orm_to_domain",
    "user_settings_domain_to_orm",
    "anima_settings_domain_to_orm",
    "apply_user_settings_to_orm",
    "apply_anima_settings_to_orm",
    "user_settings_domain_to_schema",
    "anima_settings_domain_to_schema",
    # User Profiles
    "apply_user_profile_to_orm",
    "user_profile_domain_to_orm",
    "user_profile_orm_to_domain",
]
