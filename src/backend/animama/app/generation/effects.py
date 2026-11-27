"""Existing effects on a draft's timeline: what a run may place, and whether a draft's events are placed rightly.

A Gesture drafted on the Generate page may play Avatar, Particle and Scene
Effects that are already in the owner's Library (spec R7.3). The model finds
them with two tools (``tools.py``): a list of names and short descriptions,
and one effect's definition as far as placing it needs. It then adds timeline
``events`` that name an effect by the ``id`` those tools gave, and this
backend derives the project's ``dependencies`` from the events; a model
never writes a dependency, a content id or a file name.

Three things here are untrusted. An effect's name, description and
definition were written by whoever made the effect, so they reach the model
only as tagged data (threat T10). A draft's events are a model's output:
each must name an effect this run listed or read, or one the draft already
plays, and an Avatar Effect's per-use ``override`` passes the check Save
itself applies (T1). Non-portable content never enters the Library a run is
given (T4): the caller builds it from portable items only.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final, Literal, cast, get_args

from animama.app.contracts.avatar_effect import AvatarEffectDefinitionV2, project_avatar_effect_definition
from animama.app.services.avatar_effect_overrides import check_clip_effect_overrides
from animama.domain.content_documents import ContentDocumentError

from .draft_validation import JsonObject, bounded_text, is_storable_text

EffectKind = Literal["avatar_effect", "particle_effect", "scene_effect"]
EFFECT_KINDS: Final[tuple[str, ...]] = get_args(EffectKind)

EVENT_KIND: Final[Mapping[str, str]] = {
    "avatar_effect": "avatar_vfx",
    "particle_effect": "particle_vfx",
    "scene_effect": "scene_vfx",
}
"""The timeline event that plays each kind of effect."""
_EFFECT_OF_EVENT: Final[Mapping[str, str]] = {event: effect for effect, event in EVENT_KIND.items()}
_ALIAS_FIELDS: Final = ("effectId", "presetId", "cueId")
"""Every field a timeline event can name a dependency in. An event kind uses one of them (``_alias_field``); the
creator reads whichever is present, so an event that carried a second one could mean two things."""
_KIND_LABEL: Final[Mapping[str, str]] = {
    "avatar_effect": "an Avatar Effect",
    "particle_effect": "a Particle Effect",
    "scene_effect": "a Scene Effect",
}

MAX_LISTED_EFFECTS: Final = 100
"""Effects one ``list_effects`` result holds; a longer list says how many it left out."""
MAX_EFFECT_NAME_LENGTH: Final = 80
MAX_EFFECT_DESCRIPTION_LENGTH: Final = 160
"""Characters of an effect's description a list or a read shows."""
MAX_EFFECT_ID_LENGTH: Final = 64
MAX_EFFECT_SEARCH_LENGTH: Final = 60
MAX_EFFECT_DEFINITION_BYTES: Final = 8 * 1024
"""The largest definition ``read_effect`` shows; a larger one is left out and the effect can still be placed."""
MAX_DRAFT_EVENTS: Final = 24
"""Timeline events one draft may hold."""
OVERRIDE_INVALID: Final = "generation_effect_override_invalid"

_NOT_ID_CHARACTERS = re.compile(r"[^a-z0-9]+")
_OVERRIDABLE_PARTS: Final = ("attachment", "appearance", "motion", "soundAlias")
"""The parts of an Avatar Effect an event's ``override`` may replace, which are all ``read_effect`` shows of it
besides its region: its art and face options stay the effect's."""


def _shown(text: str | None, limit: int) -> str:
    """Text from the Library on one line, without characters that cannot be shown, cut to ``limit``."""

    if not isinstance(text, str) or not is_storable_text(text):
        return ""
    line = " ".join("".join(character for character in " ".join(text.split()) if character.isprintable()).split())
    return bounded_text(line, limit)


@dataclass(frozen=True)
class LibraryEffect:
    """One portable effect of the owner's Library, as a run may place it.

    ``id`` is the alias a draft's events use for it. ``definition`` is the
    effect's stored definition: an Avatar Effect's is what an event's
    override is checked against, and a Scene Effect's says which lane it
    plays in (``scene_kind``).
    """

    id: str
    kind: EffectKind
    name: str
    description: str
    catalog_item_id: str
    logical_key: str | None = None
    definition: Mapping[str, Any] | None = field(default=None, repr=False)
    scene_kind: Literal["background_layers", "focus_lines"] | None = None

    @property
    def avatar_definition(self) -> AvatarEffectDefinitionV2 | None:
        """The typed ``/2`` definition of an Avatar Effect; ``None`` for another kind or an unreadable one."""

        if self.kind != "avatar_effect":
            return None
        return project_avatar_effect_definition(dict(self.definition) if self.definition is not None else None)[0]

    def dependency(self) -> JsonObject:
        """The project dependency that pins this effect, in the creator's own shape."""

        return {
            "alias": self.id,
            "content_type": self.kind,
            "source": {"type": "catalog", "catalog_item_id": self.catalog_item_id, "logical_key": self.logical_key},
        }

    def listing(self) -> JsonObject:
        return {"id": self.id, "kind": self.kind, "name": self.name, "description": self.description}


def scene_kind_of(
    logical_key: str | None, definition: Mapping[str, Any] | None
) -> Literal["background_layers", "focus_lines"]:
    """The lane a Scene Effect plays in: its definition says, and an Included focus effect's key does."""

    if (definition or {}).get("kind") == "focus_lines" or ":focus:" in (logical_key or ""):
        return "focus_lines"
    return "background_layers"


def effect_id(name: str, taken: Iterable[str]) -> str:
    """An id for an effect from its name, as the creator derives a dependency's alias, not in ``taken``."""

    base = _NOT_ID_CHARACTERS.sub("_", name.lower()).strip("_")[: MAX_EFFECT_ID_LENGTH - 4].strip("_") or "effect"
    used = set(taken)
    if base not in used:
        return base
    suffix = 2
    while f"{base}_{suffix}" in used:
        suffix += 1
    return f"{base}_{suffix}"


@dataclass(frozen=True)
class EffectSource:
    """One portable effect as the Library holds it, before a run gives it an id."""

    kind: EffectKind
    name: str
    description: str | None
    catalog_item_id: str
    logical_key: str | None
    definition: Mapping[str, Any] | None


class EffectLibrary:
    """The portable effects a run may place, read once before the run starts.

    Ids are assigned here, in a fixed order (kind, name, catalog id), so the
    same Library gives the same ids. ``available`` is false when the Library
    could not be read: nothing can then be listed, and a draft keeps the
    effects it already plays unchecked.
    """

    def __init__(self, sources: Sequence[EffectSource] = (), *, available: bool = True) -> None:
        self.available = available
        self._by_id: dict[str, LibraryEffect] = {}
        self._by_item: dict[str, LibraryEffect] = {}
        ordered = sorted(sources, key=lambda source: (source.kind, source.name.lower(), source.catalog_item_id))
        for source in ordered:
            name = _shown(source.name, MAX_EFFECT_NAME_LENGTH)
            if source.kind not in EFFECT_KINDS or not name or source.catalog_item_id in self._by_item:
                continue
            definition = source.definition if isinstance(source.definition, Mapping) else None
            effect = LibraryEffect(
                id=effect_id(name, self._by_id),
                kind=source.kind,
                name=name,
                description=_shown(source.description, MAX_EFFECT_DESCRIPTION_LENGTH),
                catalog_item_id=source.catalog_item_id,
                logical_key=source.logical_key,
                definition=definition,
                scene_kind=scene_kind_of(source.logical_key, definition) if source.kind == "scene_effect" else None,
            )
            self._by_id[effect.id] = effect
            self._by_item[effect.catalog_item_id] = effect

    def __len__(self) -> int:
        return len(self._by_id)

    def get(self, effect_id: str) -> LibraryEffect | None:
        return self._by_id.get(effect_id)

    def by_item(self, catalog_item_id: object) -> LibraryEffect | None:
        return self._by_item.get(catalog_item_id) if isinstance(catalog_item_id, str) else None

    def listed(self, kind: str | None = None, search: str | None = None) -> list[LibraryEffect]:
        """Every effect of ``kind`` (any kind when ``None``) whose name or description holds ``search``."""

        needle = search.strip().lower() if isinstance(search, str) else ""
        return [
            effect
            for effect in self._by_id.values()
            if (kind is None or effect.kind == kind)
            and (not needle or needle in effect.name.lower() or needle in effect.description.lower())
        ]


@dataclass
class EffectAccess:
    """What the passes of one run may place: the Library, and the ids the run has listed or read so far.

    Shared by every pass of the run, so an effect found in the write pass
    can still be placed by a repair.
    """

    library: EffectLibrary
    known: set[str] = field(default_factory=set)

    def resolve(self, alias: str, kept: Mapping[str, Mapping[str, Any]]) -> tuple[LibraryEffect | None, str | None]:
        """The effect an event's alias names in a draft, or the problem with naming it.

        ``kept`` are the draft's own dependencies by alias. An alias the
        draft already uses keeps meaning the effect it pinned, whatever the
        Library calls that effect now; when that effect is gone, the event
        cannot stay. With the Library unavailable a kept alias resolves to
        no effect and no problem: it cannot be checked, and Save checks it.
        """

        shown = bounded_text(alias, MAX_EFFECT_ID_LENGTH)
        dependency = kept.get(alias)
        if dependency is not None:
            if not self.library.available:
                return None, None
            source = dependency.get("source")
            effect = self.library.by_item(source.get("catalog_item_id") if isinstance(source, Mapping) else None)
            if effect is None:
                return None, (
                    f"the effect {shown} is no longer in the Library; remove this event or place another effect "
                    "from list_effects"
                )
            return effect, None
        effect = self.library.get(alias)
        if effect is None or alias not in self.known:
            return None, (
                f"{shown} is not an effect you listed or read in this task; use an id from list_effects or read_effect"
            )
        return effect, None


def kept_dependencies(project: Mapping[str, Any]) -> dict[str, JsonObject]:
    """A stored project's effect dependencies by alias, as this backend wrote them; anything else is dropped."""

    kept: dict[str, JsonObject] = {}
    listed = project.get("dependencies")
    for entry in listed if isinstance(listed, list) else ():
        if not isinstance(entry, dict):
            continue
        alias, source = entry.get("alias"), entry.get("source")
        if (
            isinstance(alias, str)
            and alias
            and entry.get("content_type") in EFFECT_KINDS
            and isinstance(source, dict)
            and source.get("type") == "catalog"
            and isinstance(source.get("catalog_item_id"), str)
        ):
            kept[alias] = {
                "alias": alias,
                "content_type": entry["content_type"],
                "source": {
                    "type": "catalog",
                    "catalog_item_id": source["catalog_item_id"],
                    "logical_key": source.get("logical_key") if isinstance(source.get("logical_key"), str) else None,
                },
            }
    return kept


def _alias_field(kind: object) -> str:
    """The field in which an event of ``kind`` names its effect."""

    return "presetId" if kind == "scene_vfx" else "effectId"


def _event_alias(event: Mapping[str, Any]) -> str | None:
    alias = event.get(_alias_field(event.get("kind")))
    return alias if isinstance(alias, str) and alias else None


def event_problems(clip: Mapping[str, Any], access: EffectAccess, kept: Mapping[str, Mapping[str, Any]]) -> list[str]:
    """Why the timeline events of a draft's clip cannot stay, as sentences for the model; empty when they can.

    The clip has already passed the structural validation, which checks
    each event's own fields. Here every event must play an effect (a
    Gesture sounds only through its effects, so no ``sfx`` event), name one
    the run listed or read or the draft already plays, by the event kind of
    that effect, in the lane a Scene Effect plays in; and an Avatar Effect's
    override must be one the effect can play, by the check Save applies.

    An event names its effect in one field, its kind's own. Any other alias
    field is refused whatever it holds: the clip validation ignores it, the
    check here would not see it, and the creator reads the first alias
    field an event has, so it could take the stray one for the event's
    effect. While the Library cannot be read, an effect the draft already
    plays is still held to the kind its dependency pins.
    """

    events = clip.get("events")
    if not isinstance(events, list) or not events:
        return []
    if len(events) > MAX_DRAFT_EVENTS:
        return [f"events: a draft may hold at most {MAX_DRAFT_EVENTS} events"]
    problems: list[str] = []
    definitions: dict[str, AvatarEffectDefinitionV2 | None] = {}
    for event in events:
        if not isinstance(event, dict):
            continue
        where = f"event {bounded_text(str(event.get('id')), MAX_EFFECT_ID_LENGTH)}"
        kind = event.get("kind")
        if kind == "sfx":
            problems.append(f"{where}: a Gesture sounds only through its effects; remove this sfx event")
            continue
        if not isinstance(kind, str) or kind not in _EFFECT_OF_EVENT:
            continue
        own = _alias_field(kind)
        strays = [name for name in _ALIAS_FIELDS if name != own and name in event]
        if strays:
            problems.extend(
                f"{where}: {name} does not belong on an event of kind {kind}, which names its effect in {own}; "
                f"remove {name}"
                for name in strays
            )
            continue
        alias = _event_alias(event)
        if alias is None:
            continue
        effect, problem = access.resolve(alias, kept)
        if problem is not None:
            problems.append(f"{where}: {problem}")
            continue
        # Without the Library a kept alias resolves to no effect; its dependency still says what kind it pins.
        pinned = effect.kind if effect is not None else kept.get(alias, {}).get("content_type")
        if isinstance(pinned, str) and pinned in _KIND_LABEL and pinned != _EFFECT_OF_EVENT[kind]:
            problems.append(f"{where}: {alias} is {_KIND_LABEL[pinned]}; its event kind is {EVENT_KIND[pinned]}")
            continue
        if effect is None:
            continue
        if kind == "scene_vfx" and event.get("sceneKind") != effect.scene_kind:
            problems.append(f"{where}: sceneKind must be {effect.scene_kind} for {alias}")
        if kind == "avatar_vfx":
            definitions[alias] = effect.avatar_definition
    if not problems:
        try:
            check_clip_effect_overrides(clip, definitions, code=OVERRIDE_INVALID)
        except ContentDocumentError as error:
            problems.append(str(error))
    return problems


def dependencies_for(
    clip: Mapping[str, Any], access: EffectAccess | None, kept: Mapping[str, Mapping[str, Any]]
) -> list[JsonObject]:
    """The dependencies of a draft's project: one for each effect its events name, in the order first named.

    Call it for a clip without event problems. A dependency the draft
    already had is kept as it was stored; a newly placed effect is pinned
    to its Library item.
    """

    events = clip.get("events")
    dependencies: dict[str, JsonObject] = {}
    for event in events if isinstance(events, list) else ():
        alias = _event_alias(event) if isinstance(event, dict) else None
        if alias is None or alias in dependencies:
            continue
        if alias in kept:
            dependencies[alias] = cast(JsonObject, dict(kept[alias]))
        elif access is not None and (effect := access.library.get(alias)) is not None:
            dependencies[alias] = effect.dependency()
    return list(dependencies.values())


def effect_for_reading(effect: LibraryEffect) -> JsonObject:
    """One effect as ``read_effect`` shows it: what it is, the event that plays it, and what a use may change.

    An Avatar Effect shows its region and the parts an event's override may
    replace. Every kind shows the minimal event to add; the clip format
    gives the other fields an event may carry.
    """

    shown: JsonObject = effect.listing()
    event: JsonObject = {"id": f"{effect.id}-1", "time": 0, "kind": EVENT_KIND[effect.kind]}
    if effect.kind == "scene_effect":
        event |= {"sceneKind": effect.scene_kind, "presetId": effect.id}
    else:
        event["effectId"] = effect.id
    shown["event"] = event
    definition = effect.avatar_definition
    if definition is not None:
        dumped = definition.model_dump(by_alias=True, exclude_unset=True, mode="json")
        shown["definition"] = {
            "region": dumped.get("region"),
            **{part: dumped[part] for part in _OVERRIDABLE_PARTS if part in dumped},
        }
    return shown


__all__ = [
    "EFFECT_KINDS",
    "EVENT_KIND",
    "MAX_DRAFT_EVENTS",
    "MAX_EFFECT_DEFINITION_BYTES",
    "MAX_EFFECT_DESCRIPTION_LENGTH",
    "MAX_EFFECT_ID_LENGTH",
    "MAX_EFFECT_NAME_LENGTH",
    "MAX_EFFECT_SEARCH_LENGTH",
    "MAX_LISTED_EFFECTS",
    "OVERRIDE_INVALID",
    "EffectAccess",
    "EffectKind",
    "EffectLibrary",
    "EffectSource",
    "LibraryEffect",
    "dependencies_for",
    "effect_for_reading",
    "effect_id",
    "event_problems",
    "kept_dependencies",
    "scene_kind_of",
]
