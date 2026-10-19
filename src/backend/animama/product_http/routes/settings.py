"""User and per-Anima settings routes shared by every composition (ADR 0021)."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Response, status

from animama.adapters.mappers.settings_map import anima_settings_domain_to_schema, user_settings_domain_to_schema
from animama.app.contracts.settings import PyAnimaSettings, PyAnimaSettingsUpdate, PyUserSettings, PyUserSettingsUpdate
from animama.app.services.model_role_resolver import unusable_role_preferences
from animama.app.services.settings_service import SettingsService, default_anima_preferences
from animama.domain.request_principal import RequestPrincipal
from animama.domain.settings import AnimaSettings, UserSettings
from animama.product_http.ports import (
    Ports,
    ProductPorts,
    ProductRepositories,
    ReadRepositories,
    UserSettingsMutation,
    WriteRepositories,
    WriteSession,
)
from animama.product_http.principal import get_current_principal
from animama.product_http.routes._owner import require_owned_anima

router = APIRouter()


def _service(repositories: ProductRepositories) -> SettingsService:
    return SettingsService(
        user_settings=repositories.user_settings,
        anima_settings=repositories.anima_settings,
        uow=repositories.unit_of_work,
    )


async def _refuse_unusable_model_roles(
    ports: ProductPorts, repositories: ProductRepositories, patch: dict[str, Any]
) -> None:
    """Refuse a role preference the composition's catalog cannot serve, when it validates them."""

    policy = ports.model_catalog_policy
    preferences = patch.get("preferences")
    if not policy.validate_role_preferences or not isinstance(preferences, dict):
        return
    if await unusable_role_preferences(repositories.model_providers, preferences, offered=policy.allows):
        raise HTTPException(status_code=422, detail={"code": "model_role_unavailable"})


@router.get("/v1/users/me/settings", response_model=PyUserSettings)
async def get_user_settings(
    repositories: ReadRepositories,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
) -> PyUserSettings:
    settings = await _service(repositories).get_user_settings(user.id)
    if settings is None:
        settings = UserSettings(user_id=user.id)
    return user_settings_domain_to_schema(settings)


@router.post("/v1/users/me/settings", response_model=PyUserSettings, status_code=status.HTTP_201_CREATED)
async def create_user_settings(
    ports: Ports,
    repositories: WriteRepositories,
    session: WriteSession,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
    req: PyUserSettingsUpdate | None = None,
) -> PyUserSettings:
    service = _service(repositories)
    existing = await service.get_user_settings(user.id)
    if existing is not None:
        raise HTTPException(status_code=409, detail="User settings already exist")
    patch = req.model_dump(exclude_unset=True) if req is not None else {}
    await _refuse_unusable_model_roles(ports, repositories, patch)
    await ports.prepare_user_settings_change(session, user, UserSettingsMutation("create", patch))
    settings = await service.patch_user_settings(user_id=user.id, **patch)
    ports.user_settings_changed(user)
    return user_settings_domain_to_schema(settings)


@router.patch("/v1/users/me/settings", response_model=PyUserSettings)
async def patch_user_settings(
    req: PyUserSettingsUpdate,
    ports: Ports,
    repositories: WriteRepositories,
    session: WriteSession,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
) -> PyUserSettings:
    patch = req.model_dump(exclude_unset=True)
    await _refuse_unusable_model_roles(ports, repositories, patch)
    await ports.prepare_user_settings_change(session, user, UserSettingsMutation("patch", patch))
    settings = await _service(repositories).patch_user_settings(user_id=user.id, **patch)
    ports.user_settings_changed(user)
    return user_settings_domain_to_schema(settings)


@router.delete("/v1/users/me/settings", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user_settings(
    ports: Ports,
    repositories: WriteRepositories,
    session: WriteSession,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
) -> Response:
    await ports.prepare_user_settings_change(session, user, UserSettingsMutation("reset"))
    await _service(repositories).delete_user_settings(user.id)
    ports.user_settings_changed(user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/v1/animas/{anima_id}/settings", response_model=PyAnimaSettings)
async def get_anima_settings(
    anima_id: str,
    repositories: ReadRepositories,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
) -> PyAnimaSettings:
    await require_owned_anima(repositories.animas, anima_id=anima_id, user_id=user.id)
    settings = await _service(repositories).get_anima_settings(user_id=user.id, anima_id=anima_id)
    if settings is None:
        settings = AnimaSettings(
            user_id=user.id,
            anima_id=anima_id,
            preferences=default_anima_preferences(),
        )
    return anima_settings_domain_to_schema(settings)


@router.patch("/v1/animas/{anima_id}/settings", response_model=PyAnimaSettings)
async def patch_anima_settings(
    anima_id: str,
    req: PyAnimaSettingsUpdate,
    repositories: WriteRepositories,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
) -> PyAnimaSettings:
    await require_owned_anima(repositories.animas, anima_id=anima_id, user_id=user.id)
    patch = req.model_dump(exclude_unset=True)
    settings = await _service(repositories).patch_anima_settings(user_id=user.id, anima_id=anima_id, **patch)
    return anima_settings_domain_to_schema(settings)


@router.delete("/v1/animas/{anima_id}/settings", status_code=status.HTTP_204_NO_CONTENT)
async def delete_anima_settings(
    anima_id: str,
    repositories: WriteRepositories,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
) -> Response:
    await require_owned_anima(repositories.animas, anima_id=anima_id, user_id=user.id)
    await _service(repositories).delete_anima_settings(user_id=user.id, anima_id=anima_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
