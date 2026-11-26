"""Every HTTP route the local composition serves, and who may share it (ADR 0021).

Each route has one disposition:

- ``shared``: product HTTP that moves into this package in the #379 stage named by
  ``stage`` (2 owner-scoped, 3 content, 4 paid utilities, 5 chat streaming). Every
  composition mounts it.
- ``local``: owned by the local composition (installation bootstrap and runtime
  context, model custody, owner events, archive, per-owner Avatar settings,
  ElevenLabs audio isolation, Gemini voice samples, health, telemetry and the web
  asset catch-all). A consumer serves its own equivalent or nothing.
- ``hosted-excluded``: withheld by a false permission in
  ``contracts/runtime-capabilities/hosted.json``, named by ``capability``.

``access`` names the port a handler needs: ``read`` or ``write`` sessions (the
composition keeps commit authority), ``staged`` work prepared on a read session and
then written on a short write session the handler opens, a ``stream`` response
prepared on a write session that ends before the body runs, ``bytes`` delivered
under the composition's caching policy, or the ``speech`` port without a session. A test binds it to the
session each shared handler depends on; for local routes it only describes them.

Entries follow the local app's route order, one per method, which matters:
``/v1/animas/creation-options`` must match before ``/v1/animas/{anima_id}``, and
every route precedes the asset catch-all that a web root adds. Tests keep this table
equal to the local route table in development, built and desktop modes, and
consistent with the hosted capability contract.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Disposition = Literal["shared", "local", "hosted-excluded"]
Access = Literal["read", "write", "staged", "stream", "bytes", "speech"]
Stage = Literal[2, 3, 4, 5]
# Stages whose shared routes this package serves: every stage, since chat streaming
# (stage 5) moved. Tests keep the routers and the local composition in step with it.
SERVED_STAGES: frozenset[Stage] = frozenset({2, 3, 4, 5})


@dataclass(frozen=True)
class RouteSpec:
    """One route of the local app. ``handler`` is part of its public operation ID."""

    method: str
    path: str
    handler: str
    disposition: Disposition
    access: Access
    stage: Stage | None = None
    capability: str | None = None
    desktop_only: bool = False
    web_root_only: bool = False

    def __post_init__(self) -> None:
        # Only shared routes move in a stage; only excluded routes name the
        # permission that withholds them.
        if (self.stage is None) == (self.disposition == "shared"):
            raise ValueError(f"{self.path}: a stage belongs to shared routes only")
        if (self.capability is None) == (self.disposition == "hosted-excluded"):
            raise ValueError(f"{self.path}: a capability belongs to hosted-excluded routes only")


def _shared(stage: Stage, method: str, path: str, handler: str, access: Access) -> RouteSpec:
    return RouteSpec(method, path, handler, "shared", access, stage=stage)


def _local(method: str, path: str, handler: str, access: Access, *, web_root_only: bool = False) -> RouteSpec:
    return RouteSpec(method, path, handler, "local", access, web_root_only=web_root_only)


def _excluded(
    capability: str, method: str, path: str, handler: str, access: Access, *, desktop_only: bool = False
) -> RouteSpec:
    return RouteSpec(method, path, handler, "hosted-excluded", access, capability=capability, desktop_only=desktop_only)


ROUTES: tuple[RouteSpec, ...] = (
    # Health
    _local("GET", "/health", "health", "read"),
    # Anima creation (hosted withholds creation; starters belong to each bootstrap)
    _excluded("anima_creation", "GET", "/v1/animas/creation-options", "get_anima_creation_options", "read"),
    _excluded("anima_creation", "POST", "/v1/animas:validate", "validate_anima", "write"),
    _excluded("anima_creation", "POST", "/v1/animas", "create_anima", "write"),
    _local("POST", "/v1/animas/starters:ensure", "ensure_anima_starters", "write"),
    # Animas, their voice catalogs and chat
    _shared(3, "GET", "/v1/animas", "list_animas", "read"),
    _shared(3, "GET", "/v1/animas/{anima_id}", "get_anima", "read"),
    _shared(3, "PATCH", "/v1/animas/{anima_id}/chat-profile", "update_anima_chat_profile", "write"),
    _shared(3, "PATCH", "/v1/animas/{anima_id}", "patch_anima", "write"),
    _shared(3, "DELETE", "/v1/animas/{anima_id}", "delete_anima", "write"),
    _shared(3, "PUT", "/v1/animas/{anima_id}/emotional-state", "update_anima_emotional_state", "write"),
    _shared(4, "POST", "/v1/animas/voice-catalogs/uploads", "init_anima_voice_catalog_upload", "write"),
    _shared(
        4, "PUT", "/v1/animas/voice-catalogs/uploads/{upload_id}/content", "upload_anima_voice_catalog_content", "write"
    ),
    _shared(
        4,
        "POST",
        "/v1/animas/voice-catalogs/uploads/{upload_id}:finalize",
        "finalize_anima_voice_catalog_upload",
        "write",
    ),
    _shared(4, "DELETE", "/v1/animas/voice-catalogs/uploads/{upload_id}", "abort_anima_voice_catalog_upload", "write"),
    _shared(5, "POST", "/v1/animas/{anima_id}/chat:sse", "chat_anima_direct_sse", "stream"),
    # Loadouts
    _shared(2, "GET", "/v1/animas/{anima_id}/loadout", "get_anima_loadout", "read"),
    _shared(2, "POST", "/v1/animas/{anima_id}/gestures:plan", "plan_gesture", "read"),
    _shared(2, "POST", "/v1/animas/{anima_id}/gestures:commit", "commit_gesture", "write"),
    _shared(2, "POST", "/v1/animas/{anima_id}/reactions:plan", "plan_reaction", "read"),
    _shared(2, "POST", "/v1/animas/{anima_id}/reactions:commit", "commit_reaction", "write"),
    _shared(2, "POST", "/v1/animas/{anima_id}/idle:plan", "plan_idle", "read"),
    _shared(2, "POST", "/v1/animas/{anima_id}/idle:commit", "commit_idle", "write"),
    _shared(2, "POST", "/v1/animas/{anima_id}/music-tracks:commit", "replay_music_track_commit", "write"),
    _shared(2, "POST", "/v1/animas/{anima_id}/avatar:plan", "plan_avatar", "read"),
    _shared(2, "POST", "/v1/animas/{anima_id}/avatar:commit", "commit_avatar", "write"),
    _shared(2, "POST", "/v1/animas/{anima_id}/voice:plan", "plan_voice", "read"),
    _shared(2, "POST", "/v1/animas/{anima_id}/voice:commit", "commit_voice", "write"),
    _shared(2, "POST", "/v1/animas/{anima_id}/appearance:plan", "plan_appearance", "read"),
    _shared(2, "POST", "/v1/animas/{anima_id}/appearance:commit", "commit_appearance", "write"),
    # Anima runtime
    _shared(3, "GET", "/v1/animas/{anima_id}/runtime", "get_anima_runtime", "staged"),
    _shared(3, "POST", "/v1/animas/{anima_id}/runtime/revisions/{revision}:renew", "renew_anima_runtime", "write"),
    _shared(
        3,
        "GET",
        "/v1/animas/{anima_id}/runtime/revisions/{revision}/bundles/{bundle_id}",
        "get_runtime_bundle",
        "bytes",
    ),
    _shared(
        3,
        "GET",
        "/v1/animas/{anima_id}/runtime/revisions/{revision}/files/{file_ref}",
        "stream_anima_runtime_file",
        "bytes",
    ),
    # Model catalog and model roles (adding models is host administration)
    _shared(4, "GET", "/v1/model-providers", "list_model_providers", "read"),
    _shared(4, "GET", "/v1/model-roles", "get_model_roles", "read"),
    # Model custody (installation is host administration)
    _local("GET", "/v1/model-assets", "list_model_assets", "read"),
    _local("GET", "/v1/model-assets/{asset_id}", "get_model_asset", "read"),
    _excluded(
        "local_filesystem_administration", "POST", "/v1/model-assets/{asset_id}:install", "install_model_asset", "write"
    ),
    _excluded(
        "local_filesystem_administration", "DELETE", "/v1/model-assets/{asset_id}", "remove_model_asset", "write"
    ),
    _local("POST", "/v1/model-assets/{asset_id}:lease", "lease_model_asset", "write"),
    _local("DELETE", "/v1/model-assets/{asset_id}/leases/{lease_id}", "release_model_asset_lease", "write"),
    _local("GET", "/v1/model-assets/{asset_id}/content", "get_model_asset_content", "bytes"),
    _local("HEAD", "/v1/model-assets/{asset_id}/content", "get_model_asset_content", "bytes"),
    # Local runtime context and bootstrap
    _local("GET", "/v1/runtime-context", "get_runtime_context", "read"),
    _local("POST", "/v1/runtime/bootstrap:ensure", "ensure_runtime_bootstrap", "write"),
    _local("POST", "/v1/runtime/onboarding:complete", "complete_runtime_onboarding", "write"),
    # Runtime capabilities (each composition reports its own through a port)
    _shared(2, "GET", "/v1/runtime-capabilities", "get_runtime_capabilities", "read"),
    # Safety
    _shared(2, "GET", "/v1/safety/crisis-resources", "get_crisis_resources", "read"),
    # Avatars
    _shared(3, "GET", "/v1/avatars", "list_avatars", "read"),
    _shared(3, "GET", "/v1/avatars/{avatar_id}", "get_avatar", "read"),
    _shared(3, "POST", "/v1/avatars", "register_avatar", "write"),
    _shared(3, "PATCH", "/v1/avatars/{avatar_id}", "update_avatar", "write"),
    _shared(3, "DELETE", "/v1/avatars/{avatar_id}", "delete_avatar", "write"),
    _shared(3, "GET", "/v1/avatar-catalog", "list_avatar_catalog", "read"),
    # File logs
    _excluded("local_filesystem_administration", "WEBSOCKET", "/v1/logs", "logs_socket", "stream"),
    # Content catalog (rescan is host administration)
    _shared(3, "GET", "/v1/content/catalog", "list_content_catalog", "read"),
    _shared(3, "GET", "/v1/content/items/{item_id}", "get_content_item", "read"),
    _shared(3, "DELETE", "/v1/content/items/{item_id}", "delete_content_item", "write"),
    _shared(3, "GET", "/v1/content/files/{file_ref}", "stream_content_file", "bytes"),
    _shared(3, "GET", "/v1/content/files/{file_ref}/sha256/{sha256}", "stream_included_content_file", "bytes"),
    _shared(
        3,
        "GET",
        "/v1/content/previews/{preview_id}/revisions/{revision_sha256}/files/{file_ref}",
        "stream_content_preview_file",
        "bytes",
    ),
    _excluded("local_filesystem_administration", "POST", "/v1/content:rescan", "rescan_content_catalog", "write"),
    # Content packages
    _shared(3, "POST", "/v1/content/package-exports:summary", "summarize_package_export", "write"),
    _shared(3, "POST", "/v1/content/package-exports", "prepare_package_export", "write"),
    _shared(3, "GET", "/v1/content/package-exports/{export_id}/file", "download_package_export", "bytes"),
    _shared(3, "DELETE", "/v1/content/package-exports/{export_id}", "discard_package_export", "write"),
    _shared(3, "POST", "/v1/content/package-imports", "allocate_package_import", "write"),
    _shared(3, "PUT", "/v1/content/package-imports/{stage_id}/parts/{index}", "upload_package_part", "write"),
    _shared(3, "GET", "/v1/content/package-imports/{stage_id}", "get_package_import", "read"),
    _shared(3, "POST", "/v1/content/package-imports/{stage_id}/review", "review_package_import", "write"),
    _shared(3, "POST", "/v1/content/package-imports/{stage_id}/commit", "commit_package_import", "write"),
    _shared(3, "GET", "/v1/content/package-operations/{operation_id}", "get_package_operation", "write"),
    _shared(3, "DELETE", "/v1/content/package-imports/{stage_id}", "discard_package_import", "write"),
    # Typed content, portraits and face parts
    _shared(3, "POST", "/v1/content/evidence:resolve", "resolve_content_evidence", "read"),
    _shared(3, "POST", "/v1/content/previews:prepare", "prepare_content_previews", "write"),
    _shared(3, "GET", "/v1/gestures/{item_id}/idle-playback", "get_gesture_idle_playback", "read"),
    _shared(3, "GET", "/v1/gestures", "list_gestures", "read"),
    _shared(3, "GET", "/v1/gestures/{item_id}", "get_gesture", "read"),
    _shared(3, "POST", "/v1/gestures/{item_id}:preview", "preview_gesture", "write"),
    _shared(3, "PUT", "/v1/gestures/{entry_name}", "save_gesture", "write"),
    _shared(3, "GET", "/v1/reactions", "list_reactions", "read"),
    _shared(3, "GET", "/v1/reactions/{item_id}", "get_reaction", "read"),
    _shared(3, "POST", "/v1/reactions/{item_id}:preview", "preview_reaction", "write"),
    _shared(3, "PUT", "/v1/reactions/{entry_name}", "save_reaction", "write"),
    _shared(3, "GET", "/v1/poses", "list_poses", "read"),
    _shared(3, "GET", "/v1/poses/{item_id}", "get_pose", "read"),
    _shared(3, "POST", "/v1/poses/{item_id}:preview", "preview_pose", "write"),
    _shared(3, "PUT", "/v1/poses/{entry_name}", "save_pose", "write"),
    _shared(3, "PUT", "/v1/pose-clips/{entry_name}", "save_pose_clip", "write"),
    _shared(3, "GET", "/v1/particle-effects", "list_particle_effects", "read"),
    _shared(3, "GET", "/v1/particle-effects/{item_id}", "get_particle_effect", "read"),
    _shared(3, "POST", "/v1/particle-effects/{item_id}:preview", "preview_particle_effect", "write"),
    _shared(3, "PUT", "/v1/particle-effects/{entry_name}", "save_particle_effect", "write"),
    _shared(3, "GET", "/v1/avatar-effects", "list_avatar_effects", "read"),
    _shared(3, "GET", "/v1/avatar-effects/{item_id}", "get_avatar_effect", "read"),
    _shared(3, "POST", "/v1/avatar-effects/{item_id}:preview", "preview_avatar_effect", "write"),
    _shared(3, "PUT", "/v1/avatar-effects/{entry_name}", "save_avatar_effect", "write"),
    _shared(3, "GET", "/v1/scene-effects", "list_scene_effects", "read"),
    _shared(3, "GET", "/v1/scene-effects/{item_id}", "get_scene_effect", "read"),
    _shared(3, "POST", "/v1/scene-effects/{item_id}:preview", "preview_scene_effect", "write"),
    _shared(3, "PUT", "/v1/scene-effects/{entry_name}", "save_scene_effect", "write"),
    _shared(3, "GET", "/v1/sound-effects", "list_sound_effects", "read"),
    _shared(3, "GET", "/v1/sound-effects/{item_id}", "get_sound_effect", "read"),
    _shared(3, "POST", "/v1/sound-effects/{item_id}:preview", "preview_sound_effect", "write"),
    _shared(3, "PUT", "/v1/sound-effects/{entry_name}", "save_sound_effect", "write"),
    _shared(3, "PUT", "/v1/music-tracks/{entry_name}", "save_music_track", "write"),
    _shared(3, "GET", "/v1/avatar-content", "list_avatar_contents", "read"),
    _shared(3, "GET", "/v1/avatar-content/{item_id}", "get_avatar_content", "read"),
    _shared(3, "POST", "/v1/avatar-content/{item_id}:preview", "preview_avatar_content", "write"),
    _shared(3, "PUT", "/v1/avatar-content/{entry_name}", "save_avatar_content", "write"),
    _shared(3, "GET", "/v1/appearance-content", "list_appearance_contents", "read"),
    _shared(3, "GET", "/v1/appearance-content/{item_id}", "get_appearance_content", "read"),
    _shared(3, "POST", "/v1/appearance-content/{item_id}:preview", "preview_appearance_content", "write"),
    _shared(3, "PUT", "/v1/appearance-content/{entry_name}", "save_appearance_content", "write"),
    _shared(3, "GET", "/v1/voice-content", "list_voice_contents", "read"),
    _shared(3, "GET", "/v1/voice-content/{item_id}", "get_voice_content", "read"),
    _shared(3, "POST", "/v1/voice-content/{item_id}:preview", "preview_voice_content", "write"),
    _shared(3, "PUT", "/v1/voice-content/{entry_name}", "save_voice_content", "write"),
    _shared(3, "PUT", "/v1/avatar-content/{item_id}/portrait", "save_avatar_portrait", "write"),
    _shared(3, "GET", "/v1/avatar-content/{item_id}/face-parts", "get_avatar_face_parts", "read"),
    _shared(3, "PUT", "/v1/avatar-content/{item_id}/face-parts", "save_avatar_face_parts", "write"),
    # Per-owner Avatar settings (wind, materials) are stored only by the local composition.
    _local("GET", "/v1/avatar-content/{item_id}/settings", "get_avatar_settings", "read"),
    _local("PUT", "/v1/avatar-content/{item_id}/settings", "save_avatar_settings", "write"),
    # Chats
    _shared(2, "POST", "/v1/chats", "create_chat", "write"),
    _shared(2, "GET", "/v1/chats", "list_chats", "read"),
    _shared(2, "POST", "/v1/chats/search", "search_chat_messages", "read"),
    _shared(2, "GET", "/v1/chats/{chat_id}", "get_chat", "read"),
    _shared(2, "PATCH", "/v1/chats/{chat_id}", "update_chat", "write"),
    _shared(2, "DELETE", "/v1/chats/{chat_id}", "delete_chat", "write"),
    _shared(2, "GET", "/v1/chats/{chat_id}/messages", "list_chat_messages", "read"),
    # ElevenLabs speech and voices
    _shared(4, "POST", "/v1/elevenlabs/voices/clone", "clone_voice_endpoint", "speech"),
    _shared(4, "POST", "/v1/elevenlabs/text-to-speech", "text_to_speech_endpoint", "speech"),
    _shared(4, "POST", "/v1/elevenlabs/sound-effects", "sound_effects_endpoint", "speech"),
    # Audio isolation has no web caller and stays local (owner, 2026-10-10).
    _local("POST", "/v1/elevenlabs/audio-isolation", "audio_isolation_endpoint", "write"),
    # Gemini voice is offered only by the local composition.
    _local("GET", "/v1/gemini/voices/{voice}/sample", "get_gemini_voice_sample", "speech"),
    # Owner events
    _local("GET", "/v1/events:sse", "get_owner_events_sse", "stream"),
    # Anima archive (no web caller; stays local)
    _local("GET", "/v1/animas/{anima_id}/archive", "get_anima_archive", "read"),
    _local("GET", "/v1/animas/{anima_id}/archive/passages", "list_anima_archive_passages", "read"),
    _local("POST", "/v1/animas/{anima_id}/archive/passages", "create_anima_archive_passage", "write"),
    _local("PATCH", "/v1/animas/{anima_id}/archive/passages/{passage_id}", "update_anima_archive_passage", "write"),
    _local("DELETE", "/v1/animas/{anima_id}/archive/passages/{passage_id}", "delete_anima_archive_passage", "write"),
    _local("POST", "/v1/animas/{anima_id}/archive/search", "search_anima_archive_passages", "write"),
    # Settings
    _shared(2, "GET", "/v1/users/me/settings", "get_user_settings", "read"),
    _shared(2, "POST", "/v1/users/me/settings", "create_user_settings", "write"),
    _shared(2, "PATCH", "/v1/users/me/settings", "patch_user_settings", "write"),
    _shared(2, "DELETE", "/v1/users/me/settings", "delete_user_settings", "write"),
    _shared(2, "GET", "/v1/animas/{anima_id}/settings", "get_anima_settings", "read"),
    _shared(2, "PATCH", "/v1/animas/{anima_id}/settings", "patch_anima_settings", "write"),
    _shared(2, "DELETE", "/v1/animas/{anima_id}/settings", "delete_anima_settings", "write"),
    # Chat attachments and document processing
    _excluded("chat_file_uploads", "POST", "/v1/files/uploads", "init_user_file_upload", "write"),
    _excluded("chat_file_uploads", "PUT", "/v1/files/{file_id}/content", "upload_user_file_content", "write"),
    _excluded("chat_file_uploads", "POST", "/v1/files/{file_id}:finalize", "finalize_user_file_upload", "write"),
    _excluded("chat_file_uploads", "GET", "/v1/files", "list_user_files", "read"),
    _excluded("chat_file_uploads", "GET", "/v1/files/{file_id}", "get_user_file", "read"),
    _excluded("chat_file_uploads", "GET", "/v1/files/{file_id}/content", "get_user_file_content", "read"),
    _excluded("user_file_processing.enabled", "POST", "/v1/files/{file_id}:process", "process_user_file", "write"),
    _excluded("user_file_processing.enabled", "POST", "/v1/files/debug/search", "search_user_file_chunks", "write"),
    _excluded("chat_file_uploads", "DELETE", "/v1/files/uploads/{file_id}", "abort_user_file_upload", "write"),
    _excluded("chat_file_uploads", "DELETE", "/v1/files/{file_id}", "delete_user_file", "write"),
    # Profile
    _shared(2, "GET", "/v1/users/me/profile", "get_user_profile", "read"),
    _shared(2, "PATCH", "/v1/users/me/profile", "update_user_profile", "write"),
    # Memory entries
    _shared(2, "GET", "/v1/memory/entries", "list_memory_entries", "read"),
    _shared(2, "GET", "/v1/memory/anima-identities", "list_anima_identities", "read"),
    _shared(2, "POST", "/v1/memory/anima-memories/{anima_id}:repair", "repair_anima_memories", "write"),
    _shared(2, "GET", "/v1/memory/entries/by-path", "get_memory_entry_by_path", "read"),
    _shared(2, "GET", "/v1/memory/entries/{entry_id}/versions", "list_memory_entry_versions", "read"),
    _shared(2, "GET", "/v1/memory/entries/{entry_id}/versions/{version}", "get_memory_entry_version", "read"),
    _shared(2, "GET", "/v1/memory/entries/{entry_id}", "get_memory_entry", "read"),
    _shared(2, "POST", "/v1/memory/debug/search-memory-files", "debug_search_memory_files", "read"),
    _shared(2, "POST", "/v1/memory/entries", "create_memory_entry", "write"),
    _shared(2, "PATCH", "/v1/memory/entries/{entry_id}", "patch_memory_entry", "write"),
    _shared(2, "POST", "/v1/memory/entries/{entry_id}:revert", "revert_memory_entry", "write"),
    _shared(2, "DELETE", "/v1/memory/entries/{entry_id}", "delete_memory_entry", "write"),
    # Memory episodes and Memory Manager runs
    _shared(2, "GET", "/v1/memory/episodes", "list_memory_episodes", "read"),
    _shared(4, "POST", "/v1/memory/manager/runs", "create_memory_manager_run", "write"),
    _shared(
        4, "POST", "/v1/memory/manager/runs:process-episodes", "create_episode_processing_memory_manager_run", "write"
    ),
    _shared(4, "POST", "/v1/memory/manager/runs:reflect", "create_reflection_memory_manager_run", "write"),
    _shared(4, "GET", "/v1/memory/manager/runs/current", "get_current_memory_manager_run", "read"),
    _shared(4, "GET", "/v1/memory/manager/runs/{run_id}", "get_memory_manager_run", "read"),
    _shared(4, "POST", "/v1/memory/manager/runs/{run_id}:complete", "complete_memory_manager_run", "write"),
    _shared(4, "POST", "/v1/memory/manager/runs/{run_id}/messages", "append_memory_manager_message", "write"),
    _shared(4, "POST", "/v1/memory/manager/approvals/{approval_id}:decide", "decide_memory_manager_approval", "write"),
    _shared(4, "POST", "/v1/memory/manager/approvals/{approval_id}:undo", "undo_memory_manager_approval", "write"),
    # Model connections and models
    _excluded("model_configuration", "GET", "/v1/model-connection-presets", "list_model_connection_presets", "read"),
    _excluded(
        "model_configuration",
        "POST",
        "/v1/model-connection-presets/{preset_id}/detect",
        "detect_model_connection_preset",
        "write",
    ),
    _excluded(
        "model_configuration", "GET", "/v1/model-connection-presets/openrouter/models", "list_openrouter_models", "read"
    ),
    _excluded("model_configuration", "GET", "/v1/model-connections", "list_model_connections", "read"),
    _excluded("provider_credentials", "POST", "/v1/model-connections", "create_model_connection", "write"),
    _excluded(
        "provider_credentials", "PATCH", "/v1/model-connections/{connection_id}", "update_model_connection", "write"
    ),
    _excluded(
        "model_configuration", "DELETE", "/v1/model-connections/{connection_id}", "remove_model_connection", "write"
    ),
    _excluded(
        "model_configuration",
        "GET",
        "/v1/model-connections/{connection_id}/available-models",
        "list_available_models",
        "read",
    ),
    _excluded("model_configuration", "POST", "/v1/model-connections/{connection_id}/probe", "probe_model", "write"),
    _excluded(
        "model_configuration", "POST", "/v1/model-connections/{connection_id}/models", "add_owner_model", "write"
    ),
    _excluded("model_configuration", "PATCH", "/v1/model-providers/{model_provider_id}", "update_model", "write"),
    _excluded("model_configuration", "DELETE", "/v1/model-providers/{model_provider_id}", "remove_model", "write"),
    # ChatGPT plan sign-in (the local composition only, spec #919); the return is the browser's
    # navigation back from OpenAI, admitted by its own rule.
    _excluded("chatgpt_plan", "GET", "/v1/chatgpt-plan", "get_chatgpt_plan", "read"),
    _excluded("chatgpt_plan", "POST", "/v1/chatgpt-plan/sign-in", "begin_chatgpt_plan_sign_in", "write"),
    _excluded("chatgpt_plan", "DELETE", "/v1/chatgpt-plan/sign-in", "cancel_chatgpt_plan_sign_in", "write"),
    _excluded("chatgpt_plan", "POST", "/v1/chatgpt-plan:sign-out", "sign_out_of_chatgpt_plan", "write"),
    _excluded("chatgpt_plan", "PUT", "/v1/chatgpt-plan/preferences", "update_chatgpt_plan_preferences", "write"),
    _excluded("chatgpt_plan", "POST", "/v1/chatgpt-plan/models:refresh", "refresh_chatgpt_plan_models", "write"),
    _local("GET", "/auth/callback", "complete_chatgpt_plan_sign_in", "write"),
    # Web search settings
    _excluded("web_search.configuration", "GET", "/v1/web-search/settings", "get_web_search_settings", "read"),
    _excluded("web_search.configuration", "PUT", "/v1/web-search/settings", "update_web_search_settings", "write"),
    _excluded("web_search.configuration", "DELETE", "/v1/web-search/settings", "clear_web_search_settings", "write"),
    _excluded("web_search.configuration", "POST", "/v1/web-search/settings/test", "test_web_search_settings", "write"),
    # Automatic episode processing (the local composition only, spec #775)
    _excluded(
        "automatic_episode_processing",
        "GET",
        "/v1/memory/automatic-processing",
        "get_automatic_episode_processing",
        "read",
    ),
    _excluded(
        "automatic_episode_processing",
        "PUT",
        "/v1/memory/automatic-processing",
        "update_automatic_episode_processing",
        "write",
    ),
    # Desktop controls (mounted only with desktop credentials)
    _excluded(
        "native_features",
        "POST",
        "/_desktop/feature-packs/{pack_id}:removal-check",
        "feature_pack_removal_check",
        "write",
        desktop_only=True,
    ),
    _excluded("native_features", "PUT", "/_desktop/credentials", "replace_credentials", "write", desktop_only=True),
    _excluded("native_features", "GET", "/_desktop/health", "desktop_health", "read", desktop_only=True),
    _excluded("native_features", "POST", "/_desktop/runtime:quiesce", "quiesce", "write", desktop_only=True),
    # Telemetry
    _local("POST", "/api/telemetry/{signal}", "forward_telemetry", "write"),
    # Web assets (only with a web root; always last)
    _local("GET", "/{asset_path:path}", "serve_asset", "bytes", web_root_only=True),
    _local("HEAD", "/{asset_path:path}", "serve_asset", "bytes", web_root_only=True),
)
