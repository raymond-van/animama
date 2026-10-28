"""The benchmark's tracked prompt set: format v1, its loader and its input hashes.

A prompt set is one JSON manifest. Paths inside it are relative to the
manifest's directory, so a set and its files move together:

``version``
    The prompt-set version a report names; any change to items, fixtures,
    checklists, guidance, acceptable lists, intensity bands, tones or rubrics
    makes a new one.
``loadout``
    ``{"path", "sha256"}``: the equipped Gesture list every turn sees, a JSON
    list of ``{selector, name, description}`` sorted by selector, as chat lists
    equipped Gestures. The hash pins the exact file.
``personas``
    ``{"id", "name", "identity"}`` for an inline identity, or ``{"id",
    "starter"}`` naming a starter Anima (``starter:annie``) whose shipped name
    and identity text the app uses.
``items``
    Single-turn prompts: ``{"id", "area", "language", "pair_id", "message",
    "tags", "acceptable", "intensity", "tones", "held_out", "tier"}``.
    ``acceptable`` lists the Gesture selectors (``null`` for no Gesture) that
    fit. The optional ``intensity`` is the intended ``[low, high]`` band of the
    1-10 emotional intensity, and the optional ``tones`` lists the emotional
    tones that fit; reports measure replies against both. A Japanese item's
    ``pair_id`` names the English item it translates.
``scripted_chats``
    ``{"id", "area", "language", "pair_id", "persona", "turns", "held_out",
    "tier"}``: fixed user messages sent turn by turn.
``memory_fixtures``
    ``{"id", "anima_memories", "user_files"}``: what an episodic-memory store
    starts with, the Anima's ``MEMORIES.md`` and the owner's shared files
    (``{"path", "content", "description"}``). The persona's identity becomes
    the Anima's ``IDENTITY.md``.
``memory_chats``
    ``{"id", "language", "pair_id", "persona", "fixture", "turns",
    "checklist", "recall", "held_out", "tier"}``. ``checklist`` lists what the
    chat plants, ``{"id", "kind", "text"}`` with kind ``keep`` (must be saved),
    ``noise`` (should not be) or ``sensitive`` (must not be, by the
    sensitive-memory rule). ``recall`` lists the later fresh chat's probes,
    ``{"id", "message", "expect", "checklist"}``: ``expect`` holds phrases a
    correct ``speech`` contains (any one matches, case-insensitively), and
    ``checklist`` names the items a probe asks about.
``episodic_guidance``
    ``{"path", "sha256"}``: the candidate ``MEMORIES.md`` write guidance the
    ``MEMORIES.md``-only arm uses in place of chat's own. It must name the
    ``[self]/MEMORIES.md`` path, since it replaces the only text that does.
``memory_manager``
    ``{"id", "kind", "persona", "fixture", "message", "episodes", "turns",
    "held_out", "tier"}``: one Memory Manager run. ``general`` sends
    ``message``; ``episode_processing`` first records ``episodes`` as pending
    episode items; ``reflection`` first records ``turns``, ``[user,
    assistant]`` pairs, as the Anima's chat.

``language`` is ``en`` or ``ja``; ``tier`` is ``smoke`` (in the smoke and the
full tier) or ``full`` (full tier only). Held-out items are never used for
tuning prompts, AI descriptions, rubrics or guidance; reports show them apart.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from animama.app.services.anima_identity_memory import ANIMA_SELF_MEMORIES_ALIAS
from animama.app.services.anima_starter_service import STARTER_ANIMA_SPECS
from animama.app.voice_emotional_tone import ELEVENLABS_EMOTIONAL_TONE_VALUES

from ..core.inputs import EvalInputError, read_json, require_unique, required_text
from ..core.loadouts import Loadout, load_loadout

__all__ = [
    "AREAS",
    "CHECKLIST_KINDS",
    "LANGUAGES",
    "MANAGER_KINDS",
    "TIERS",
    "ChecklistItem",
    "Item",
    "ManagerRun",
    "MemoryChat",
    "MemoryFile",
    "MemoryFixture",
    "Persona",
    "PromptSet",
    "RecallProbe",
    "ScriptedChat",
    "load_prompt_set",
]

CHECKLIST_KINDS = ("keep", "noise", "sensitive")
MANAGER_KINDS = ("general", "episode_processing", "reflection")

AREAS = ("core", "long_chat", "memory", "memory_manager")
LANGUAGES = ("en", "ja")
TIERS = ("smoke", "full")


@dataclass(frozen=True, slots=True)
class Persona:
    """The Anima a turn speaks as: the name and identity text chat puts in the prompt."""

    id: str
    name: str
    identity: str
    starter: str | None = None
    """The starter Anima id this persona uses, when it is one."""


@dataclass(frozen=True, slots=True)
class Item:
    """A single-turn prompt and the Gestures (``None`` for no Gesture), intensity band and tones that fit it."""

    id: str
    area: str
    language: str
    message: str
    acceptable: tuple[str | None, ...]
    tags: tuple[str, ...] = ()
    intensity: tuple[int, int] | None = None
    """The intended emotional intensity band, both ends included, or ``None`` when the item sets none."""
    tones: tuple[str, ...] = ()
    """The emotional tones that fit; empty when the item sets none."""
    pair_id: str | None = None
    held_out: bool = False
    tier: str = "full"


@dataclass(frozen=True, slots=True)
class ScriptedChat:
    """A multi-turn chat of fixed user messages, spoken to one persona."""

    id: str
    area: str
    language: str
    persona: str
    turns: tuple[str, ...]
    pair_id: str | None = None
    held_out: bool = False
    tier: str = "full"


@dataclass(frozen=True, slots=True)
class MemoryFile:
    """One shared memory file a store starts with."""

    path: str
    content: str
    description: str | None = None


@dataclass(frozen=True, slots=True)
class MemoryFixture:
    """What an episodic-memory store starts with, apart from the persona's identity."""

    id: str
    anima_memories: str
    user_files: tuple[MemoryFile, ...] = ()


@dataclass(frozen=True, slots=True)
class ChecklistItem:
    """One thing a memory chat plants, and whether a good memory keeps it."""

    id: str
    kind: str
    text: str


@dataclass(frozen=True, slots=True)
class RecallProbe:
    """One message of the fresh chat that follows a memory chat, asking what was kept."""

    id: str
    message: str
    expect: tuple[str, ...] = ()
    checklist: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class MemoryChat:
    """A scripted chat with memory on, its checklist, and the recall chat that follows it."""

    id: str
    language: str
    persona: str
    fixture: str
    turns: tuple[str, ...]
    checklist: tuple[ChecklistItem, ...]
    recall: tuple[RecallProbe, ...]
    pair_id: str | None = None
    held_out: bool = False
    tier: str = "full"
    area: str = "memory"


@dataclass(frozen=True, slots=True)
class ManagerRun:
    """One Memory Manager run and what its store holds before it starts."""

    id: str
    kind: str
    persona: str
    fixture: str
    message: str | None = None
    episodes: tuple[str, ...] = ()
    turns: tuple[tuple[str, str], ...] = ()
    held_out: bool = False
    tier: str = "full"
    area: str = "memory_manager"


@dataclass(frozen=True, slots=True)
class PromptSet:
    version: str
    loadout: Loadout
    personas: tuple[Persona, ...]
    items: tuple[Item, ...] = ()
    scripted_chats: tuple[ScriptedChat, ...] = ()
    memory_fixtures: tuple[MemoryFixture, ...] = ()
    memory_chats: tuple[MemoryChat, ...] = ()
    manager_runs: tuple[ManagerRun, ...] = ()
    episodic_guidance: str | None = None
    """The candidate MEMORIES.md write guidance of the MEMORIES.md-only arm."""
    hashes: Mapping[str, str] = field(default_factory=dict, compare=False)
    """SHA-256 of each loaded file's bytes, by role: ``manifest``, ``loadout`` and ``episodic_guidance``."""

    def persona(self, persona_id: str) -> Persona:
        return next(persona for persona in self.personas if persona.id == persona_id)

    def fixture(self, fixture_id: str) -> MemoryFixture:
        return next(fixture for fixture in self.memory_fixtures if fixture.id == fixture_id)

    def for_tier(self, tier: str) -> PromptSet:
        """The entries in ``tier``: ``smoke`` keeps only those marked smoke."""

        if tier == "full":
            return self
        return replace(
            self,
            items=tuple(item for item in self.items if item.tier == "smoke"),
            scripted_chats=tuple(chat for chat in self.scripted_chats if chat.tier == "smoke"),
            memory_chats=tuple(chat for chat in self.memory_chats if chat.tier == "smoke"),
            manager_runs=tuple(run for run in self.manager_runs if run.tier == "smoke"),
        )


_MANIFEST_KEYS = frozenset(
    {
        "version",
        "loadout",
        "personas",
        "items",
        "scripted_chats",
        "memory_fixtures",
        "memory_chats",
        "episodic_guidance",
        "memory_manager",
    }
)
_FIXTURE_KEYS = frozenset({"id", "anima_memories", "user_files"})
_FILE_KEYS = frozenset({"path", "content", "description"})
_MEMORY_CHAT_KEYS = frozenset(
    {"id", "language", "pair_id", "persona", "fixture", "turns", "checklist", "recall", "held_out", "tier"}
)
_CHECKLIST_KEYS = frozenset({"id", "kind", "text"})
_RECALL_KEYS = frozenset({"id", "message", "expect", "checklist"})
_MANAGER_KEYS = frozenset({"id", "kind", "persona", "fixture", "message", "episodes", "turns", "held_out", "tier"})
_PINNED_FILE_KEYS = frozenset({"path", "sha256"})
_PERSONA_KEYS = frozenset({"id", "name", "identity", "starter"})
_ITEM_KEYS = frozenset(
    {"id", "area", "language", "pair_id", "message", "tags", "acceptable", "intensity", "tones", "held_out", "tier"}
)
_CHAT_KEYS = frozenset({"id", "area", "language", "pair_id", "persona", "turns", "held_out", "tier"})


def _known_keys(entry: Mapping[str, Any], keys: frozenset[str], where: str) -> None:
    """Reject keys the format does not define, so a typo such as ``held-out`` cannot silently change an entry."""

    unknown = sorted(set(entry) - keys)
    if unknown:
        raise EvalInputError(f"{where}: unknown keys {', '.join(map(repr, unknown))}")


def _choice(entry: Mapping[str, Any], key: str, choices: Sequence[str], where: str, default: str) -> str:
    value = entry.get(key, default)
    if value not in choices:
        raise EvalInputError(f"{where}: {key!r} must be one of {', '.join(choices)}")
    return str(value)


def _flag(entry: Mapping[str, Any], key: str, where: str) -> bool:
    value = entry.get(key, False)
    if not isinstance(value, bool):
        raise EvalInputError(f"{where}: {key!r} must be true or false")
    return value


def _optional_text(entry: Mapping[str, Any], key: str, where: str) -> str | None:
    if entry.get(key) is None:
        return None
    return required_text(entry, key, where)


def _strings(entry: Mapping[str, Any], key: str, where: str) -> tuple[str, ...]:
    values = entry.get(key, [])
    if not isinstance(values, list) or not all(isinstance(value, str) and value.strip() for value in values):
        raise EvalInputError(f"{where}: {key!r} must be a list of non-empty strings")
    return tuple(values)


def _intensity_band(entry: Mapping[str, Any], where: str) -> tuple[int, int] | None:
    band = entry.get("intensity")
    if band is None:
        return None
    if (
        not isinstance(band, list)
        or len(band) != 2
        or not all(isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 10 for value in band)
        or band[0] > band[1]
    ):
        raise EvalInputError(f"{where}: 'intensity' must be [low, high] with 1 <= low <= high <= 10")
    return band[0], band[1]


def _tones(entry: Mapping[str, Any], where: str) -> tuple[str, ...]:
    tones = _strings(entry, "tones", where)
    unknown = [tone for tone in tones if tone not in ELEVENLABS_EMOTIONAL_TONE_VALUES]
    if unknown:
        raise EvalInputError(f"{where}: 'tones' names tones the reply schema does not allow: {unknown}")
    return tones


def _loadout(base: Path, entry: Any, where: str) -> Loadout:
    if not isinstance(entry, Mapping):
        raise EvalInputError(f"{where}: expected {{'path', 'sha256'}}")
    _known_keys(entry, _PINNED_FILE_KEYS, where)
    loadout = load_loadout(base / required_text(entry, "path", where))
    if loadout.sha256 != required_text(entry, "sha256", where):
        raise EvalInputError(f"{where}: {entry['path']} does not match its pinned sha256")
    if list(loadout.selectors) != sorted(loadout.selectors):
        # Chat lists an Anima's equipped Gestures sorted by selector; the benchmark lists them the same way.
        raise EvalInputError(f"{where}: {entry['path']} must list Gestures sorted by selector, as chat does")
    return loadout


def _persona(entry: Any, where: str) -> Persona:
    if not isinstance(entry, Mapping):
        raise EvalInputError(f"{where}: expected an object")
    _known_keys(entry, _PERSONA_KEYS, where)
    persona_id = required_text(entry, "id", where)
    starter = _optional_text(entry, "starter", where)
    if starter is not None:
        spec = next((spec for spec in STARTER_ANIMA_SPECS if spec.id == starter), None)
        if spec is None:
            raise EvalInputError(f"{where}: unknown starter Anima {starter!r}")
        return Persona(id=persona_id, name=spec.display_name, identity=spec.identity_markdown, starter=starter)
    return Persona(
        id=persona_id, name=required_text(entry, "name", where), identity=required_text(entry, "identity", where)
    )


def _item(entry: Any, where: str) -> Item:
    if not isinstance(entry, Mapping):
        raise EvalInputError(f"{where}: expected an object")
    _known_keys(entry, _ITEM_KEYS, where)
    acceptable = entry.get("acceptable")
    if (
        not isinstance(acceptable, list)
        or not acceptable
        or not all(value is None or (isinstance(value, str) and value.strip()) for value in acceptable)
    ):
        raise EvalInputError(f"{where}: 'acceptable' must be a non-empty list of selectors or null")
    # The message is sent exactly as written; it only has to say something.
    required_text(entry, "message", where)
    return Item(
        id=required_text(entry, "id", where),
        area=_choice(entry, "area", ("core",), where, "core"),
        language=_choice(entry, "language", LANGUAGES, where, "en"),
        message=entry["message"],
        acceptable=tuple(value.strip() if isinstance(value, str) else None for value in acceptable),
        tags=_strings(entry, "tags", where),
        intensity=_intensity_band(entry, where),
        tones=_tones(entry, where),
        pair_id=_optional_text(entry, "pair_id", where),
        held_out=_flag(entry, "held_out", where),
        tier=_choice(entry, "tier", TIERS, where, "full"),
    )


def _scripted_chat(entry: Any, where: str) -> ScriptedChat:
    if not isinstance(entry, Mapping):
        raise EvalInputError(f"{where}: expected an object")
    _known_keys(entry, _CHAT_KEYS, where)
    turns = entry.get("turns")
    if not isinstance(turns, list) or not turns or not all(isinstance(turn, str) and turn.strip() for turn in turns):
        raise EvalInputError(f"{where}: 'turns' must be a non-empty list of messages")
    return ScriptedChat(
        id=required_text(entry, "id", where),
        area=_choice(entry, "area", ("long_chat",), where, "long_chat"),
        language=_choice(entry, "language", LANGUAGES, where, "en"),
        persona=required_text(entry, "persona", where),
        turns=tuple(turns),
        pair_id=_optional_text(entry, "pair_id", where),
        held_out=_flag(entry, "held_out", where),
        tier=_choice(entry, "tier", TIERS, where, "full"),
    )


def _objects(data: Mapping[str, Any], key: str, where: str) -> list[Mapping[str, Any]]:
    values = data.get(key, [])
    if not isinstance(values, list) or not all(isinstance(value, Mapping) for value in values):
        raise EvalInputError(f"{where}: {key!r} must be a list of objects")
    return values


def _fixture(entry: Mapping[str, Any], where: str) -> MemoryFixture:
    _known_keys(entry, _FIXTURE_KEYS, where)
    files = []
    for index, raw in enumerate(_objects(entry, "user_files", where)):
        _known_keys(raw, _FILE_KEYS, f"{where}: user_files[{index}]")
        files.append(
            MemoryFile(
                path=required_text(raw, "path", f"{where}: user_files[{index}]"),
                content=required_text(raw, "content", f"{where}: user_files[{index}]") + "\n",
                description=_optional_text(raw, "description", f"{where}: user_files[{index}]"),
            )
        )
    require_unique((file.path for file in files), f"{where}: user_files")
    return MemoryFixture(
        id=required_text(entry, "id", where),
        anima_memories=required_text(entry, "anima_memories", where) + "\n",
        user_files=tuple(files),
    )


def _memory_chat(entry: Mapping[str, Any], where: str) -> MemoryChat:
    _known_keys(entry, _MEMORY_CHAT_KEYS, where)
    checklist = []
    for index, raw in enumerate(_objects(entry, "checklist", where)):
        _known_keys(raw, _CHECKLIST_KEYS, f"{where}: checklist[{index}]")
        checklist.append(
            ChecklistItem(
                id=required_text(raw, "id", f"{where}: checklist[{index}]"),
                kind=_choice(raw, "kind", CHECKLIST_KINDS, f"{where}: checklist[{index}]", "keep"),
                text=required_text(raw, "text", f"{where}: checklist[{index}]"),
            )
        )
    recall = []
    for index, raw in enumerate(_objects(entry, "recall", where)):
        _known_keys(raw, _RECALL_KEYS, f"{where}: recall[{index}]")
        recall.append(
            RecallProbe(
                id=required_text(raw, "id", f"{where}: recall[{index}]"),
                message=required_text(raw, "message", f"{where}: recall[{index}]"),
                expect=_strings(raw, "expect", f"{where}: recall[{index}]"),
                checklist=_strings(raw, "checklist", f"{where}: recall[{index}]"),
            )
        )
    turns = entry.get("turns")
    if not isinstance(turns, list) or not turns or not all(isinstance(turn, str) and turn.strip() for turn in turns):
        raise EvalInputError(f"{where}: 'turns' must be a non-empty list of messages")
    if not checklist or not recall:
        raise EvalInputError(f"{where}: a memory chat needs a checklist and recall probes")
    require_unique((item.id for item in checklist), f"{where}: checklist")
    require_unique((probe.id for probe in recall), f"{where}: recall")
    known = {item.id for item in checklist}
    for probe in recall:
        if not set(probe.checklist) <= known:
            raise EvalInputError(f"{where}: recall {probe.id!r} names checklist items the chat does not plant")
    return MemoryChat(
        id=required_text(entry, "id", where),
        language=_choice(entry, "language", LANGUAGES, where, "en"),
        persona=required_text(entry, "persona", where),
        fixture=required_text(entry, "fixture", where),
        turns=tuple(turns),
        checklist=tuple(checklist),
        recall=tuple(recall),
        pair_id=_optional_text(entry, "pair_id", where),
        held_out=_flag(entry, "held_out", where),
        tier=_choice(entry, "tier", TIERS, where, "full"),
    )


def _manager_run(entry: Mapping[str, Any], where: str) -> ManagerRun:
    _known_keys(entry, _MANAGER_KEYS, where)
    kind = _choice(entry, "kind", MANAGER_KINDS, where, "general")
    raw_turns = entry.get("turns", [])
    if not isinstance(raw_turns, list) or not all(
        isinstance(pair, list) and len(pair) == 2 and all(isinstance(text, str) and text.strip() for text in pair)
        for pair in raw_turns
    ):
        raise EvalInputError(f"{where}: 'turns' must be a list of [user, assistant] message pairs")
    run = ManagerRun(
        id=required_text(entry, "id", where),
        kind=kind,
        persona=required_text(entry, "persona", where),
        fixture=required_text(entry, "fixture", where),
        message=_optional_text(entry, "message", where),
        episodes=_strings(entry, "episodes", where),
        turns=tuple((pair[0], pair[1]) for pair in raw_turns),
        held_out=_flag(entry, "held_out", where),
        tier=_choice(entry, "tier", TIERS, where, "full"),
    )
    needs = {"general": run.message, "episode_processing": run.episodes, "reflection": run.turns}[kind]
    if not needs:
        field_name = {"general": "message", "episode_processing": "episodes", "reflection": "turns"}[kind]
        raise EvalInputError(f"{where}: a {kind} run needs {field_name!r}")
    return run


def _episodic_guidance(base: Path, entry: Any, where: str) -> tuple[str, str]:
    if not isinstance(entry, Mapping):
        raise EvalInputError(f"{where}: expected {{'path', 'sha256'}}")
    _known_keys(entry, _PINNED_FILE_KEYS, where)
    path = base / required_text(entry, "path", where)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise EvalInputError(f"{where}: cannot read {path} ({exc})") from exc
    sha256 = hashlib.sha256(raw).hexdigest()
    if sha256 != required_text(entry, "sha256", where):
        raise EvalInputError(f"{where}: {entry['path']} does not match its pinned sha256")
    guidance = raw.decode("utf-8").strip()
    if ANIMA_SELF_MEMORIES_ALIAS not in guidance:
        raise EvalInputError(f"{where}: the guidance must name {ANIMA_SELF_MEMORIES_ALIAS}, the only path to the file")
    return guidance, sha256


def _check_references(prompt_set: PromptSet, where: str) -> None:
    persona_ids = {persona.id for persona in prompt_set.personas}
    selectors = set(prompt_set.loadout.selectors)
    english_items = {item.id for item in prompt_set.items if item.language == "en"}
    english_chats = {chat.id for chat in prompt_set.scripted_chats if chat.language == "en"}
    for item in prompt_set.items:
        unknown = [value for value in item.acceptable if value is not None and value not in selectors]
        if unknown:
            raise EvalInputError(f"{where}: item {item.id!r} accepts Gestures not in the loadout: {unknown}")
        _check_pair(item.id, item.language, item.pair_id, english_items, where)
    for chat in prompt_set.scripted_chats:
        if chat.persona not in persona_ids:
            raise EvalInputError(f"{where}: chat {chat.id!r} names unknown persona {chat.persona!r}")
        _check_pair(chat.id, chat.language, chat.pair_id, english_chats, where)
    fixture_ids = {fixture.id for fixture in prompt_set.memory_fixtures}
    english_memory = {chat.id for chat in prompt_set.memory_chats if chat.language == "en"}
    entries: tuple[MemoryChat | ManagerRun, ...] = (*prompt_set.memory_chats, *prompt_set.manager_runs)
    for entry in entries:
        if entry.persona not in persona_ids:
            raise EvalInputError(f"{where}: {entry.id!r} names unknown persona {entry.persona!r}")
        if entry.fixture not in fixture_ids:
            raise EvalInputError(f"{where}: {entry.id!r} names unknown memory fixture {entry.fixture!r}")
    for memory_chat in prompt_set.memory_chats:
        _check_pair(memory_chat.id, memory_chat.language, memory_chat.pair_id, english_memory, where)
    if prompt_set.memory_chats and prompt_set.episodic_guidance is None:
        raise EvalInputError(f"{where}: memory chats need 'episodic_guidance' for the MEMORIES.md-only arm")


def _check_pair(entry_id: str, language: str, pair_id: str | None, english: set[str], where: str) -> None:
    if language == "en" and pair_id is not None:
        raise EvalInputError(f"{where}: English entry {entry_id!r} must not name a pair_id")
    if language != "en" and pair_id not in english:
        raise EvalInputError(f"{where}: {language} entry {entry_id!r} must name the English original it translates")


def load_prompt_set(path: Path) -> PromptSet:
    """Read and validate a format-v1 prompt-set manifest and the files it pins."""

    data, manifest_sha256 = read_json(path)
    where = str(path)
    if not isinstance(data, Mapping):
        raise EvalInputError(f"{where}: expected a JSON object")
    _known_keys(data, _MANIFEST_KEYS, where)
    raw_personas = data.get("personas")
    raw_items = data.get("items", [])
    raw_chats = data.get("scripted_chats", [])
    if not isinstance(raw_personas, list) or not raw_personas:
        raise EvalInputError(f"{where}: 'personas' must be a non-empty list")
    if not isinstance(raw_items, list) or not isinstance(raw_chats, list):
        raise EvalInputError(f"{where}: 'items' and 'scripted_chats' must be lists")
    loadout = _loadout(path.parent, data.get("loadout"), f"{where}: loadout")
    hashes = {"manifest": manifest_sha256, "loadout": loadout.sha256}
    guidance: str | None = None
    if data.get("episodic_guidance") is not None:
        guidance, hashes["episodic_guidance"] = _episodic_guidance(
            path.parent, data["episodic_guidance"], f"{where}: episodic_guidance"
        )
    prompt_set = PromptSet(
        version=required_text(data, "version", where),
        loadout=loadout,
        personas=tuple(_persona(entry, f"{where}: personas[{index}]") for index, entry in enumerate(raw_personas)),
        items=tuple(_item(entry, f"{where}: items[{index}]") for index, entry in enumerate(raw_items)),
        scripted_chats=tuple(
            _scripted_chat(entry, f"{where}: scripted_chats[{index}]") for index, entry in enumerate(raw_chats)
        ),
        memory_fixtures=tuple(
            _fixture(entry, f"{where}: memory_fixtures[{index}]")
            for index, entry in enumerate(_objects(data, "memory_fixtures", where))
        ),
        memory_chats=tuple(
            _memory_chat(entry, f"{where}: memory_chats[{index}]")
            for index, entry in enumerate(_objects(data, "memory_chats", where))
        ),
        manager_runs=tuple(
            _manager_run(entry, f"{where}: memory_manager[{index}]")
            for index, entry in enumerate(_objects(data, "memory_manager", where))
        ),
        episodic_guidance=guidance,
        hashes=hashes,
    )
    if not (prompt_set.items or prompt_set.scripted_chats or prompt_set.memory_chats or prompt_set.manager_runs):
        raise EvalInputError(f"{where}: no items, chats or Memory Manager runs")
    require_unique((persona.id for persona in prompt_set.personas), f"{where}: personas")
    require_unique((item.id for item in prompt_set.items), f"{where}: items")
    require_unique((chat.id for chat in prompt_set.scripted_chats), f"{where}: scripted_chats")
    require_unique((fixture.id for fixture in prompt_set.memory_fixtures), f"{where}: memory_fixtures")
    require_unique((chat.id for chat in prompt_set.memory_chats), f"{where}: memory_chats")
    require_unique((run.id for run in prompt_set.manager_runs), f"{where}: memory_manager")
    _check_references(prompt_set, where)
    return prompt_set
