"""Anima list, read, edit and delete routes, shared by every composition (ADR 0021)."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from animama.adapters.mappers.anima_map import anima_domain_to_schema, anima_update_request_to_domain
from animama.app.contracts.anima import (
    PyAnimaChatProfileUpdateRequest,
    PyAnimaListItem,
    PyAnimaResponse,
    PyAnimaUpdateRequest,
    PyEmotionalState,
)
from animama.app.services import AnimaChatProfileService, AnimaService
from animama.app.services.anima_presentation_service import AnimaPresentationService
from animama.domain.anima import Anima
from animama.domain.anima_chat_profile import AnimaChatProfile
from animama.domain.anima_definition import AnimaDefinitionError
from animama.domain.anima_loadout import AnimaLoadoutError
from animama.domain.emotions import normalize_emotional_state
from animama.domain.request_principal import RequestPrincipal
from animama.logging import get_logger
from animama.product_http.chat.active_turns import ActiveTurns
from animama.product_http.ports import Ports, ProductRepositories, ReadRepositories, WriteRepositories
from animama.product_http.principal import get_current_principal
from animama.product_http.routes._deletion import delete_chat_images, pending_episode_removal, stop_turns_before_delete
from animama.product_http.routes._owner import require_owned_anima

router = APIRouter()
_log = get_logger("product_http.animas")


def _anima_payload(anima: Anima) -> dict[str, Any]:
    return anima_domain_to_schema(anima).model_dump(mode="json")


def _chat_profile_payload(profile: AnimaChatProfile | None) -> dict[str, Any] | None:
    if profile is None:
        return None
    return {
        "anima_id": profile.anima_id,
        "default_model_provider_id": profile.default_model_provider_id,
        "reasoning_effort": profile.reasoning_effort,
        "metadata": dict(profile.metadata or {}),
        "created_at": profile.created_at,
        "updated_at": profile.updated_at,
    }


async def _with_chat_profile(repositories: ProductRepositories, payload: dict[str, Any]) -> dict[str, Any]:
    anima_id = payload.get("id")
    if not isinstance(anima_id, str) or not anima_id:
        payload["chat_profile"] = None
        return payload
    payload["chat_profile"] = _chat_profile_payload(await repositories.anima_chat_profiles.get(anima_id))
    return payload


@router.get("/v1/animas", response_model=list[PyAnimaListItem])
async def list_animas(
    repositories: ReadRepositories,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
) -> JSONResponse:
    """List owned Animas in stable creation order (fresh starters begin with Annie)."""
    _log.info("HTTP Anima List")

    animas = await repositories.animas.list_owned(user_id=user.id)
    anima_ids = tuple(anima.id for anima in animas)
    chat_profiles = await repositories.anima_chat_profiles.get_many(anima_ids)
    presentations = await AnimaPresentationService(
        presentations=repositories.anima_presentations
    ).list_owned_presentations(user_id=user.id, anima_ids=anima_ids)
    out: list[dict[str, Any]] = []
    for anima in animas:
        payload = _anima_payload(anima)
        payload["chat_profile"] = _chat_profile_payload(chat_profiles.get(anima.id))
        presentation = presentations.get(anima.id)
        if presentation is None:  # pragma: no cover - same owner predicate
            raise HTTPException(
                status_code=500,
                detail={"code": "anima_presentation_unavailable"},
            )
        thumbnail = presentation.profile_thumbnail
        payload["presentation"] = {
            "anima_id": presentation.anima_id,
            "presentation_revision": presentation.presentation_revision,
            "display_name": presentation.display_name,
            "profile_thumbnail": (
                {
                    "source_type": thumbnail.source_type,
                    "url": thumbnail.url,
                    "content_type": thumbnail.content_type,
                    "width": thumbnail.width,
                    "height": thumbnail.height,
                    "content_revision": thumbnail.content_revision,
                    "presentation": {
                        "fit": thumbnail.presentation.fit,
                        "focal_x": thumbnail.presentation.focal_x,
                        "focal_y": thumbnail.presentation.focal_y,
                        "zoom": thumbnail.presentation.zoom,
                    },
                }
                if thumbnail is not None
                else None
            ),
        }
        out.append(payload)
    return JSONResponse(content=jsonable_encoder(out))


@router.get("/v1/animas/{anima_id}", response_model=PyAnimaResponse)
async def get_anima(
    anima_id: str,
    repositories: ReadRepositories,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
) -> JSONResponse:
    """Get a anima by id."""
    _log.info("HTTP Anima Get", id=anima_id)
    await require_owned_anima(repositories.animas, anima_id=anima_id, user_id=user.id)
    anima = await repositories.animas.get(anima_id)
    if anima is None:
        raise HTTPException(status_code=404, detail="Anima not found")
    payload = await _with_chat_profile(repositories, _anima_payload(anima))
    _log.info("HTTP Anima Get Complete", id=anima_id)
    return JSONResponse(content=jsonable_encoder(payload))


@router.patch("/v1/animas/{anima_id}/chat-profile", response_model=PyAnimaResponse)
async def update_anima_chat_profile(
    anima_id: str,
    req: PyAnimaChatProfileUpdateRequest,
    repositories: WriteRepositories,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
) -> JSONResponse:
    """Update the anima-level direct chat model and reasoning effort selector."""

    await require_owned_anima(repositories.animas, anima_id=anima_id, user_id=user.id)
    service = AnimaChatProfileService(
        profiles=repositories.anima_chat_profiles,
        model_providers=repositories.model_providers,
        uow=repositories.unit_of_work,
    )
    try:
        await service.set_default_model_provider(
            anima_id=anima_id,
            model_provider_id=req.default_model_provider_id,
            # An omitted effort (not an explicit null) lets the service keep or reset it.
            reasoning_effort=req.reasoning_effort if "reasoning_effort" in req.model_fields_set else ...,
            metadata_patch={"source": "anima_chat_profile_update"},
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    anima = await repositories.animas.get(anima_id)
    if anima is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Anima not found")
    payload = await _with_chat_profile(repositories, _anima_payload(anima))
    return JSONResponse(content=jsonable_encoder(payload))


@router.patch("/v1/animas/{anima_id}", response_model=PyAnimaResponse)
async def patch_anima(
    anima_id: str,
    req: PyAnimaUpdateRequest,
    repositories: WriteRepositories,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
) -> JSONResponse:
    """Guard explicit definition edits separately from mutable runtime state."""
    repo = repositories.animas
    uow = repositories.unit_of_work
    await require_owned_anima(repo, anima_id=anima_id, user_id=user.id)
    anima_patch = req.anima
    fields = anima_patch.model_fields_set if anima_patch else set()
    if "profile_picture_url" in fields:
        raise HTTPException(status_code=422, detail={"code": "use_typed_appearance_command"})
    definition_edit = bool(fields & {"display_name", "avatar_id"})
    if definition_edit and req.expected_aggregate_revision is None:
        raise HTTPException(status_code=409, detail={"code": "expected_aggregate_revision_required"})
    try:
        dom = (
            await repo.lock_definition(
                user_id=user.id, anima_id=anima_id, expected_revision=req.expected_aggregate_revision
            )
            if definition_edit
            else await repo.get(anima_id)
        )
        assert dom is not None
        changed = False
        if "avatar_id" in fields:
            assert anima_patch is not None
            changed = await repositories.anima_loadouts.set_legacy_avatar_in_uow(
                user_id=user.id,
                anima_id=anima_id,
                avatar_id=anima_patch.avatar_id,
            )
        display_name = anima_patch.display_name if anima_patch else None
        changed = changed or (display_name is not None and display_name != dom.display_name)
        await repo.update(anima_update_request_to_domain(req, dom))
        if changed:
            assert req.expected_aggregate_revision is not None
            await repo.record_definition_revision(
                user_id=user.id,
                anima_id=anima_id,
                expected_revision=req.expected_aggregate_revision,
                reason="anima_definition_update",
                display_name=display_name,
            )
        await uow.commit()
    except AnimaDefinitionError as exc:
        await uow.rollback()
        code = 404 if exc.code == "anima_not_found" else 409
        raise HTTPException(
            status_code=code, detail={"code": exc.code, "current_revision": exc.current_revision}
        ) from exc
    except AnimaLoadoutError as exc:
        await uow.rollback()
        raise HTTPException(status_code=409, detail={"code": exc.code}) from exc
    except ValueError as exc:
        await uow.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception:
        await uow.rollback()
        raise
    refreshed = await repo.get(anima_id)
    if refreshed is None:
        raise HTTPException(status_code=500, detail="Failed to reload updated anima")
    payload = await _with_chat_profile(repositories, _anima_payload(refreshed))
    return JSONResponse(content=jsonable_encoder(payload))


@router.delete("/v1/animas/{anima_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_anima(
    anima_id: str,
    repositories: WriteRepositories,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
    ports: Ports,
    turns: ActiveTurns,
) -> Response:
    # (Comments, not a docstring: the docstring is the operation's OpenAPI description.)
    # Deleting an Anima first stops any reply in its chats, then deletes it with its
    # chats, Anima memory files, pending episodes and the chat images only its chats
    # use. A reply that does not stop in time refuses the delete with 409
    # chat_turn_stopping.
    service = AnimaService(
        animas=repositories.animas,
        uow=repositories.unit_of_work,
        pending_episodes=pending_episode_removal(repositories),
    )
    await require_owned_anima(repositories.animas, anima_id=anima_id, user_id=user.id)
    await stop_turns_before_delete(turns, owner_id=user.id, anima_id=anima_id)
    # Read the images before the delete: the chats' messages go with it.
    image_ids = await repositories.user_file_processing.image_file_ids_only_in_anima_chats(
        user_id=user.id, anima_id=anima_id
    )
    deleted = await service.delete(anima_id, user_id=user.id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Anima not found")
    if image_ids:
        await delete_chat_images(ports, user, repositories, image_ids)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/v1/animas/{anima_id}/emotional-state", response_model=PyAnimaResponse)
async def update_anima_emotional_state(
    anima_id: str,
    emotional_state: PyEmotionalState,
    repositories: WriteRepositories,
    user: Annotated[RequestPrincipal, Depends(get_current_principal)],
) -> JSONResponse:
    _log.info("HTTP Anima EmotionalState Update start", anima_id=anima_id, user=user)
    repo = repositories.animas
    service = AnimaService(animas=repo, uow=repositories.unit_of_work)
    await require_owned_anima(repo, anima_id=anima_id, user_id=user.id)

    dom = await repo.get(anima_id)
    if dom is None:
        raise HTTPException(status_code=404, detail="Anima not found")

    dom.emotional_state = normalize_emotional_state(
        emotional_state.model_dump(mode="python"),
    )
    stored = await service.update(dom)
    refreshed = await service.get(stored.id)
    if refreshed is None:
        raise HTTPException(status_code=500, detail="Failed to reload updated anima")

    payload = await _with_chat_profile(repositories, _anima_payload(refreshed))
    return JSONResponse(content=jsonable_encoder(payload))


__all__ = ["router"]
