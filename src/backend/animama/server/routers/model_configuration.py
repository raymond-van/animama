"""Owner model configuration routes: mounted only by the local composition.

These routes accept owner-supplied endpoints and send requests to them (model
listing and the capability probe), and read OpenRouter's public model list. On
the built-in Anthropic connection, listing and the probe read Anthropic's Models
API instead. The hosted composition never mounts them; see ``create_local_app``.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from animama.adapters.model_clients.anthropic_messages.probe import AnthropicConnectionProbe
from animama.adapters.model_clients.openai_chat_completions.probe import OpenAICompatibleConnectionProbe
from animama.adapters.model_clients.openrouter_models import OpenRouterModelCatalog, OpenRouterModelListError
from animama.adapters.repositories.sqlalchemy.anima_chat_profile_repo import SQLAlchemyAnimaChatProfileRepository
from animama.adapters.repositories.sqlalchemy.model_connection_repo import SQLAlchemyModelConnectionRepository
from animama.adapters.repositories.sqlalchemy.model_provider_repo import SQLAlchemyModelProviderRepository
from animama.adapters.repositories.sqlalchemy.settings_repo import SQLAlchemyUserSettingsRepository
from animama.adapters.repositories.sqlalchemy.uow import SQLAlchemyUnitOfWork
from animama.app.chat.api_standard import ANTHROPIC_MESSAGES_PROVIDER_TYPE, OPENAI_RESPONSES_PROVIDER_TYPE
from animama.app.model_catalog import early_compaction_available
from animama.app.model_clients.credentials import ModelCredentialResolver
from animama.app.model_clients.error_categories import ERROR_CREDENTIAL_MISSING, ERROR_INVALID_BASE_URL
from animama.app.model_clients.probe import ModelConnectionProbe, ModelConnectionProbeError, ModelProbeReport
from animama.app.model_connection_presets import MODEL_CONNECTION_PRESETS, model_connection_preset
from animama.app.services.model_configuration_service import (
    CredentialSetting,
    ModelConfigurationError,
    ModelConfigurationService,
    ModelConnectionDraft,
    ModelConnectionPatch,
    ModelInUseError,
    ModelUsage,
    OwnerModelCapabilities,
    OwnerModelDraft,
    OwnerModelPatch,
    detect_local_server,
)
from animama.domain import ModelProvider
from animama.domain.model_connection import MODEL_KIND_EMBEDDING, ModelConnection, ModelConnectionCompatibility
from animama.domain.request_principal import RequestPrincipal
from animama.server.chatgpt_plan import chatgpt_plan_credential_state
from animama.server.config import Settings
from animama.server.deps import get_async_session, get_current_principal
from animama.server.embedding_refresh import (
    wake_embedding_refresh,
)
from animama.server.model_clients import build_model_credential_resolver
from animama.server.runtime_capabilities import get_runtime_settings
from animama.server.schemas.model_configuration import (
    PyAvailableModels,
    PyConfiguredModel,
    PyModelCapabilitiesView,
    PyModelConnection,
    PyModelConnectionCompatibility,
    PyModelConnectionDetection,
    PyModelConnectionPreset,
    PyModelConnectionRequest,
    PyModelConnectionUpdate,
    PyModelProbeReport,
    PyModelProbeRequest,
    PyModelProbeStep,
    PyModelRemovalResult,
    PyModelUsage,
    PyModelUsageAnima,
    PyOpenRouterModel,
    PyOpenRouterModels,
    PyOwnerModelCapabilities,
    PyOwnerModelPatch,
    PyOwnerModelRequest,
)

router = APIRouter(tags=["model-configuration"])


def get_model_credential_resolver() -> ModelCredentialResolver:
    return build_model_credential_resolver()


def get_model_connection_probe(
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
    credentials: Annotated[ModelCredentialResolver, Depends(get_model_credential_resolver)],
) -> ModelConnectionProbe:
    return OpenAICompatibleConnectionProbe(
        credential_resolver=credentials,
        default_timeout=runtime_settings.anima_model_client_timeout_seconds,
    )


def get_anthropic_connection_probe(
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
    credentials: Annotated[ModelCredentialResolver, Depends(get_model_credential_resolver)],
) -> ModelConnectionProbe:
    """Return the Models API probe for the built-in Anthropic connection."""

    return AnthropicConnectionProbe(
        credential_resolver=credentials,
        default_timeout=runtime_settings.anima_model_client_timeout_seconds,
    )


def _probe_for(
    connection: ModelConnection,
    probe: ModelConnectionProbe,
    anthropic_probe: ModelConnectionProbe,
) -> ModelConnectionProbe:
    """The Anthropic connection is described by Anthropic's Models API; every other one by request probes."""

    return anthropic_probe if connection.is_builtin_anthropic else probe


def _invalid_probe_request(code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"code": code, "message": message})


def get_openrouter_model_catalog(request: Request) -> OpenRouterModelCatalog:
    """Return the application's catalog, so its short cache spans requests."""

    catalog = getattr(request.app.state, "openrouter_model_catalog", None)
    if catalog is None:
        catalog = OpenRouterModelCatalog()
        request.app.state.openrouter_model_catalog = catalog
    return catalog


def _service(session: AsyncSession, credentials: ModelCredentialResolver | None = None) -> ModelConfigurationService:
    return ModelConfigurationService(
        connections=SQLAlchemyModelConnectionRepository(session),
        model_providers=SQLAlchemyModelProviderRepository(session),
        profiles=SQLAlchemyAnimaChatProfileRepository(session),
        user_settings=SQLAlchemyUserSettingsRepository(session),
        uow=SQLAlchemyUnitOfWork(session),
        credentials=credentials,
    )


def _probe_http_error(exc: ModelConnectionProbeError) -> HTTPException:
    """Configuration problems are the owner's to fix (400); upstream failures are 502."""

    owner_fixable = exc.category in {ERROR_CREDENTIAL_MISSING, ERROR_INVALID_BASE_URL}
    status_code = status.HTTP_400_BAD_REQUEST if owner_fixable else status.HTTP_502_BAD_GATEWAY
    return HTTPException(status_code=status_code, detail={"code": exc.category, "message": str(exc)})


def _http_error(exc: ModelConfigurationError) -> HTTPException:
    detail: dict[str, object] = {"code": exc.code, "message": str(exc)}
    if isinstance(exc, ModelInUseError):
        detail["usage"] = _usage_view(exc.usage).model_dump()
    return HTTPException(status_code=exc.status, detail=detail)


@router.get("/v1/model-connection-presets", response_model=list[PyModelConnectionPreset])
async def list_model_connection_presets(
    _principal: Annotated[RequestPrincipal, Depends(get_current_principal)],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> list[PyModelConnectionPreset]:
    return [
        PyModelConnectionPreset(
            id=preset.id,
            label=preset.label,
            logo_provider=preset.logo_provider,
            local=preset.local,
            expects_key=preset.expects_key,
            default_base_url=preset.base_url(local_host=runtime_settings.animama_local_model_host),
            suggested_credential_env=preset.suggested_credential_env,
            compatibility=_compatibility_view(preset.compatibility),
            timeout_seconds=preset.timeout_seconds,
        )
        for preset in MODEL_CONNECTION_PRESETS.values()
        if preset.owner_selectable
    ]


@router.post("/v1/model-connection-presets/{preset_id}/detect", response_model=PyModelConnectionDetection)
async def detect_model_connection_preset(
    preset_id: str,
    _principal: Annotated[RequestPrincipal, Depends(get_current_principal)],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
    probe: Annotated[ModelConnectionProbe, Depends(get_model_connection_probe)],
) -> PyModelConnectionDetection:
    """Check a local preset's default address and list the models its server offers.

    The address comes from the composition's local model host and the preset's
    default port; the request cannot supply one. An unreachable server is a
    normal result (``reachable`` false with a ``category``), not an error.
    """

    try:
        detection = await detect_local_server(
            preset_id,
            local_host=runtime_settings.animama_local_model_host,
            probe=probe,
        )
    except ModelConfigurationError as exc:
        raise _http_error(exc) from exc
    return PyModelConnectionDetection(
        preset=detection.preset,
        base_url=detection.base_url,
        reachable=detection.reachable,
        models=list(detection.models),
        category=detection.category,
    )


@router.get("/v1/model-connection-presets/openrouter/models", response_model=PyOpenRouterModels)
async def list_openrouter_models(
    _principal: Annotated[RequestPrincipal, Depends(get_current_principal)],
    catalog: Annotated[OpenRouterModelCatalog, Depends(get_openrouter_model_catalog)],
) -> PyOpenRouterModels:
    """List the models OpenRouter offers, from its public list (no key is sent).

    The add-model picker searches and filters this list; an upstream failure
    is a 502 with code ``openrouter_models_unavailable``.
    """

    try:
        models = await catalog.list_models()
    except OpenRouterModelListError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "openrouter_models_unavailable", "message": str(exc)},
        ) from exc
    return PyOpenRouterModels(
        models=[
            PyOpenRouterModel(
                id=model.id,
                name=model.name,
                context_length=model.context_length,
                supports_tools=model.supports_tools,
                supports_structured_outputs=model.supports_structured_outputs,
            )
            for model in models
        ]
    )


@router.get("/v1/model-connections", response_model=list[PyModelConnection])
async def list_model_connections(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    _principal: Annotated[RequestPrincipal, Depends(get_current_principal)],
    credentials: Annotated[ModelCredentialResolver, Depends(get_model_credential_resolver)],
) -> list[PyModelConnection]:
    service = _service(session)
    views: list[PyModelConnection] = []
    for connection in await service.list_connections():
        models = await service.list_models(connection.id)
        view = _connection_view(connection, credentials, models)
        if connection.is_builtin_chatgpt_plan:
            # A sign-in, not a key: its state comes from the session (spec #919).
            view.credential_state = await chatgpt_plan_credential_state(request.app)
        views.append(view)
    return views


@router.post("/v1/model-connections", response_model=PyModelConnection, status_code=status.HTTP_201_CREATED)
async def create_model_connection(
    body: PyModelConnectionRequest,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    _principal: Annotated[RequestPrincipal, Depends(get_current_principal)],
    credentials: Annotated[ModelCredentialResolver, Depends(get_model_credential_resolver)],
) -> PyModelConnection:
    try:
        connection = await _service(session, credentials).create_connection(_connection_draft(body))
    except ModelConfigurationError as exc:
        raise _http_error(exc) from exc
    return _connection_view(connection, credentials, [])


@router.patch("/v1/model-connections/{connection_id}", response_model=PyModelConnection)
async def update_model_connection(
    connection_id: str,
    request: Request,
    body: PyModelConnectionUpdate,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    _principal: Annotated[RequestPrincipal, Depends(get_current_principal)],
    credentials: Annotated[ModelCredentialResolver, Depends(get_model_credential_resolver)],
) -> PyModelConnection:
    service = _service(session, credentials)
    try:
        connection = await service.update_connection(
            connection_id,
            ModelConnectionPatch(
                name=body.name,
                preset=body.preset,
                base_url=body.base_url,
                credential=(
                    CredentialSetting(mode=body.credential.mode, env=body.credential.env)
                    if body.credential is not None
                    else None
                ),
                compatibility=(
                    ModelConnectionCompatibility(**body.compatibility.model_dump())
                    if body.compatibility is not None
                    else None
                ),
                timeout_seconds=body.timeout_seconds,
            ),
        )
        models = await service.list_models(connection_id)
    except ModelConfigurationError as exc:
        raise _http_error(exc) from exc
    # A fixed URL or key may let waiting re-embedding proceed.
    wake_embedding_refresh(request.app)
    return _connection_view(connection, credentials, models)


@router.delete("/v1/model-connections/{connection_id}", response_model=PyModelRemovalResult)
async def remove_model_connection(
    connection_id: str,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    principal: Annotated[RequestPrincipal, Depends(get_current_principal)],
    confirm: Annotated[bool, Query()] = False,
) -> PyModelRemovalResult:
    try:
        usage = await _service(session).remove_connection(connection_id, owner_id=principal.id, confirm=confirm)
    except ModelConfigurationError as exc:
        raise _http_error(exc) from exc
    wake_embedding_refresh(request.app)
    return PyModelRemovalResult(removed=True, usage=_usage_view(usage))


@router.get("/v1/model-connections/{connection_id}/available-models", response_model=PyAvailableModels)
async def list_available_models(
    connection_id: str,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    _principal: Annotated[RequestPrincipal, Depends(get_current_principal)],
    probe: Annotated[ModelConnectionProbe, Depends(get_model_connection_probe)],
    anthropic_probe: Annotated[ModelConnectionProbe, Depends(get_anthropic_connection_probe)],
) -> PyAvailableModels:
    connection = await _probeable_connection_or_404(session, connection_id)
    try:
        return PyAvailableModels(models=await _probe_for(connection, probe, anthropic_probe).list_models(connection))
    except ModelConnectionProbeError as exc:
        raise _probe_http_error(exc) from exc


@router.post("/v1/model-connections/{connection_id}/probe", response_model=PyModelProbeReport)
async def probe_model(
    connection_id: str,
    body: PyModelProbeRequest,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    _principal: Annotated[RequestPrincipal, Depends(get_current_principal)],
    probe: Annotated[ModelConnectionProbe, Depends(get_model_connection_probe)],
    anthropic_probe: Annotated[ModelConnectionProbe, Depends(get_anthropic_connection_probe)],
) -> PyModelProbeReport:
    """Suggest the model's capabilities.

    Other connections answer a few small requests; the built-in Anthropic
    connection reports what Anthropic's Models API publishes for the model.
    """

    connection = await _probeable_connection_or_404(session, connection_id)
    try:
        if connection.is_builtin_anthropic:
            if body.kind == MODEL_KIND_EMBEDDING:
                raise _invalid_probe_request("invalid_model_kind", "Anthropic offers no embedding models")
            if body.provider_type not in {None, ANTHROPIC_MESSAGES_PROVIDER_TYPE}:
                raise _invalid_probe_request(
                    "invalid_provider_type", "The Anthropic connection uses the Anthropic Messages API"
                )
            report = await anthropic_probe.probe_chat_model(connection, model=body.model)
        elif body.provider_type == ANTHROPIC_MESSAGES_PROVIDER_TYPE:
            raise _invalid_probe_request("invalid_provider_type", "Anthropic Messages needs the Anthropic connection")
        elif body.kind == MODEL_KIND_EMBEDDING:
            report = await probe.probe_embedding_model(connection, model=body.model)
        elif body.provider_type == OPENAI_RESPONSES_PROVIDER_TYPE:
            if not connection.is_builtin_openai:
                raise _invalid_probe_request("invalid_provider_type", "Responses needs the OpenAI connection")
            report = await probe.probe_responses_model(connection, model=body.model)
        else:
            report = await probe.probe_chat_model(connection, model=body.model)
    except ModelConnectionProbeError as exc:
        raise _probe_http_error(exc) from exc
    return _probe_view(report)


@router.post(
    "/v1/model-connections/{connection_id}/models",
    response_model=PyConfiguredModel,
    status_code=status.HTTP_201_CREATED,
)
async def add_owner_model(
    connection_id: str,
    body: PyOwnerModelRequest,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    _principal: Annotated[RequestPrincipal, Depends(get_current_principal)],
) -> PyConfiguredModel:
    draft = OwnerModelDraft(
        model=body.model,
        label=body.label,
        kind=body.kind,
        provider_type=body.provider_type,
        template_id=body.template_id,
        capabilities=_owner_capabilities(body.capabilities),
        context_window_tokens=body.context_window_tokens,
        allow_memory_writes=body.allow_memory_writes,
        probe_result=body.probe_result,
    )
    try:
        row = await _service(session).add_model(connection_id, draft)
    except ModelConfigurationError as exc:
        raise _http_error(exc) from exc
    return _model_view(row)


@router.patch("/v1/model-providers/{model_provider_id}", response_model=PyConfiguredModel)
async def update_model(
    model_provider_id: str,
    request: Request,
    body: PyOwnerModelPatch,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    _principal: Annotated[RequestPrincipal, Depends(get_current_principal)],
) -> PyConfiguredModel:
    patch = OwnerModelPatch(
        label=body.label,
        capabilities=_owner_capabilities(body.capabilities),
        context_window_tokens=body.context_window_tokens,
        clear_context_window=body.clear_context_window,
        allow_memory_writes=body.allow_memory_writes,
        probe_result=body.probe_result,
        hidden=body.hidden,
        early_compaction=body.early_compaction,
    )
    try:
        row = await _service(session).update_model(model_provider_id, patch)
    except ModelConfigurationError as exc:
        raise _http_error(exc) from exc
    wake_embedding_refresh(request.app)
    return _model_view(row)


@router.delete("/v1/model-providers/{model_provider_id}", response_model=PyModelRemovalResult)
async def remove_model(
    model_provider_id: str,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    principal: Annotated[RequestPrincipal, Depends(get_current_principal)],
    confirm: Annotated[bool, Query()] = False,
) -> PyModelRemovalResult:
    try:
        usage = await _service(session).remove_model(model_provider_id, owner_id=principal.id, confirm=confirm)
    except ModelConfigurationError as exc:
        raise _http_error(exc) from exc
    wake_embedding_refresh(request.app)
    return PyModelRemovalResult(removed=True, usage=_usage_view(usage))


async def _connection_or_404(session: AsyncSession, connection_id: str) -> ModelConnection:
    try:
        return await _service(session).get_connection(connection_id)
    except ModelConfigurationError as exc:
        raise _http_error(exc) from exc


async def _probeable_connection_or_404(session: AsyncSession, connection_id: str) -> ModelConnection:
    """A connection whose server may be asked for models: not the ChatGPT plan, whose list is the account's."""

    connection = await _connection_or_404(session, connection_id)
    if connection.is_builtin_chatgpt_plan:
        raise _http_error(
            ModelConfigurationError(
                "The ChatGPT plan's models come from the signed-in account", code="connection_read_only"
            )
        )
    return connection


def _connection_draft(body: PyModelConnectionRequest) -> ModelConnectionDraft:
    return ModelConnectionDraft(
        name=body.name,
        preset=body.preset,
        base_url=body.base_url,
        credential=CredentialSetting(mode=body.credential.mode, env=body.credential.env),
        compatibility=(
            ModelConnectionCompatibility(**body.compatibility.model_dump()) if body.compatibility is not None else None
        ),
        timeout_seconds=body.timeout_seconds,
    )


def _owner_capabilities(body: PyOwnerModelCapabilities | None) -> OwnerModelCapabilities | None:
    if body is None:
        return None
    return OwnerModelCapabilities(
        accepts_images=body.accepts_images,
        supports_streaming=body.supports_streaming,
        structured_output_transport=body.structured_output_transport,
        supports_tools=body.supports_tools,
        tools_with_structured_output=body.tools_with_structured_output,
        supported_reasoning_efforts=tuple(body.supported_reasoning_efforts),
    )


def _compatibility_view(compatibility: ModelConnectionCompatibility) -> PyModelConnectionCompatibility:
    return PyModelConnectionCompatibility.model_validate(compatibility.to_dict())


def _connection_view(
    connection: ModelConnection,
    credentials: ModelCredentialResolver,
    models: list[ModelProvider],
) -> PyModelConnection:
    return PyModelConnection(
        id=connection.id,
        name=connection.name,
        preset=connection.preset,
        source="builtin" if connection.is_builtin else "owner",
        logo_provider=model_connection_preset(connection.preset).logo_provider,
        base_url=connection.base_url,
        credential_env=connection.credential_env,
        credential_state=credentials.resolve(connection).state,
        compatibility=_compatibility_view(connection.compatibility),
        timeout_seconds=connection.timeout_seconds,
        models=[_model_view(row) for row in models],
    )


def _model_view(row: ModelProvider) -> PyConfiguredModel:
    capabilities = row.capabilities
    template_id = row.metadata.get("template_id") if isinstance(row.metadata, dict) else None
    return PyConfiguredModel(
        id=row.id,
        model=row.model,
        model_label=row.model_label or row.model,
        provider_type=row.provider_type,
        source=row.source,
        model_kind=row.model_kind,
        hidden=row.hidden,
        # Only rows with a long-context price step offer Compact early.
        early_compaction=row.early_compaction if early_compaction_available(row) else None,
        connection_id=row.connection_id,
        context_window_tokens=row.context_window_tokens,
        allow_memory_writes=row.allow_memory_writes,
        capabilities=PyModelCapabilitiesView(
            accepts=list(capabilities.accepts),
            supports_streaming=capabilities.supports_streaming,
            supports_tools=capabilities.supports_tools,
            structured_output_transport=capabilities.structured_output_transport,
            tools_with_structured_output=capabilities.tools_with_structured_output,
            supports_reasoning=capabilities.supports_reasoning,
            supported_reasoning_efforts=capabilities.supported_reasoning_efforts,
            native_tool_support=capabilities.native_tool_support,
        ),
        probe_result=row.probe_result,
        template_id=template_id if isinstance(template_id, str) else None,
    )


def _usage_view(usage: ModelUsage) -> PyModelUsage:
    return PyModelUsage(
        animas=[
            PyModelUsageAnima(
                anima_id=item.anima_id,
                display_name=item.display_name,
                model_provider_id=item.model_provider_id,
            )
            for item in usage.animas
        ],
        roles=list(usage.roles),
    )


def _probe_view(report: ModelProbeReport) -> PyModelProbeReport:
    return PyModelProbeReport(
        model=report.model,
        steps=[
            PyModelProbeStep(name=step.name, ok=step.ok, category=step.category, detail=step.detail)
            for step in report.steps
        ],
        supports_streaming=report.supports_streaming,
        structured_output_transport=report.structured_output_transport,
        supports_tools=report.supports_tools,
        tools_with_structured_output=report.tools_with_structured_output,
        context_window_tokens=report.context_window_tokens,
        embedding_dimensions=report.embedding_dimensions,
        max_output_tokens=report.max_output_tokens,
        supported_reasoning_efforts=(
            list(report.supported_reasoning_efforts) if report.supported_reasoning_efforts is not None else None
        ),
        native_tool_support=list(report.native_tool_support) if report.native_tool_support is not None else None,
        notes=list(report.notes),
    )


__all__ = [
    "get_anthropic_connection_probe",
    "get_model_connection_probe",
    "get_model_credential_resolver",
    "get_openrouter_model_catalog",
    "router",
]
