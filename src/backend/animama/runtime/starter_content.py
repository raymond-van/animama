"""Resolve the desktop core with the same typed handlers as local creation.

This adapter has no database and invents no product defaults: the starter
specifications, loadout policy, and typed resolver own those contracts. Paths in
its inventories are Included-relative and never contain local owner data.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import stat
from dataclasses import asdict
from pathlib import Path, PurePosixPath
from typing import Any

from animama.adapters.content_store import FilesystemContentStore
from animama.app.services.anima_starter_service import STARTER_ANIMA_SPECS
from animama.app.services.content_kind_registry import resolve_optional_dependencies
from animama.app.services.content_portability import (
    DISTRIBUTION_EXCLUDED,
    DISTRIBUTION_NON_PORTABLE,
    INVENTORY_DISTRIBUTIONS,
)
from animama.app.services.starter_loadout_policy import starter_loadout_policy, starter_pack_identity
from animama.app.services.typed_content_service import TypedContentAdmissionError, TypedContentResolutionContext
from animama.domain.content_catalog import (
    CatalogContentEntry,
    CatalogContentFile,
    ContentKind,
    ContentScope,
    ContentSource,
    ContentStatus,
    ScannedContentEntry,
)
from animama.utils.files import path_is_link

# Included Library content bundled with desktop core without changing any Anima's
# starter loadout. Together with the starter closure and authoring Poses, these
# roots cover every valid tracked Included item, so desktop matches self-host.
# Resolve these exact IDs through the same typed admission gates.
CORE_LIBRARY_ROOTS = (
    "builtin:gesture:bgm-bob",
    "builtin:gesture:bored-wait",
    "builtin:gesture:chat-glance",
    "builtin:gesture:downcast-sigh",
    "builtin:gesture:dreamy-gaze",
    "builtin:gesture:hair-tuck-settle",
    "builtin:gesture:happy-sway",
    "builtin:gesture:hmm-drift",
    "builtin:gesture:nervous-fidget",
    "builtin:gesture:offscreen-look",
    "builtin:gesture:simmering-huff",
    "builtin:gesture:sleepy-nod-off",
    "builtin:avatar-effect:annoyed_scribble",
    "builtin:avatar-effect:gloomy_cloud",
    "builtin:avatar-effect:mouth_hover_w",
    "builtin:avatar-effect:mouth_w",
    "builtin:avatar-effect:music_notes",
    "builtin:avatar-effect:sigh_puff_droop",
    "builtin:avatar-effect:zzz",
    "builtin:scene-effect:focus:dark",
    "builtin:scene-effect:focus:light-streak",
    "builtin:avatar-effect:awkward-ellipsis",
    "builtin:avatar-effect:blank-dot-eyes",
    "builtin:avatar-effect:broken-heart",
    "builtin:avatar-effect:burning-resolve-eyes",
    "builtin:avatar-effect:calculating-glasses",
    "builtin:avatar-effect:gray-silhouette",
    "builtin:avatar-effect:knockout-x-eyes",
    "builtin:avatar-effect:little-devil-horns",
    "builtin:avatar-effect:mended-heart",
    "builtin:avatar-effect:money-eyes",
    "builtin:avatar-effect:suspicious-side-eye",
    "builtin:avatar-effect:ticking-fuse",
    "builtin:avatar-effect:tiny-victory-crown",
    "builtin:avatar-effect:twitching-cat-ears",
    "builtin:particle-effect:butterfly-flutter",
    "builtin:particle-effect:musical-cascade",
    "builtin:particle-effect:snow-crystal-flurry",
    "builtin:scene-effect:background:awkward-silence",
    "builtin:gesture:air-guitar",
    "builtin:gesture:big-arm-heart",
    "builtin:gesture:big-yawn",
    "builtin:gesture:brain-overload",
    "builtin:gesture:brush-off-shoulders",
    "builtin:gesture:dramatic-swoon",
    "builtin:gesture:energy-wave",
    "builtin:gesture:excited-two-arm-wave",
    "builtin:gesture:freezing-shiver",
    "builtin:gesture:idol-glowstick-cheer",
    "builtin:gesture:innocent-whistle",
    "builtin:gesture:jazz-hands-ta-da",
    "builtin:gesture:nom-nom",
    "builtin:gesture:raise-the-roof",
    "builtin:gesture:rock-paper-scissors-paper",
    "builtin:gesture:rock-paper-scissors-rock",
    "builtin:gesture:rock-paper-scissors-scissors",
    "builtin:gesture:sassy-hair-flip",
    "builtin:gesture:shadow-boxing",
    "builtin:gesture:slow-sarcastic-clap",
    "builtin:gesture:sniff-sniff",
    "builtin:gesture:spit-take",
    "builtin:avatar-effect:delicious_sparkle",
    "builtin:avatar-effect:dizzy_birds",
    "builtin:avatar-effect:glowstick",
    "builtin:avatar-effect:hitodama_flames",
    "builtin:avatar-effect:interrobang",
    "builtin:avatar-effect:overheat_smoke",
    "builtin:avatar-effect:shiver_chatter",
    "builtin:avatar-effect:shiver_undereye",
    "builtin:avatar-effect:sniff_lines",
    "builtin:avatar-effect:snot_bubble",
    "builtin:avatar-effect:star_pupils",
    "builtin:avatar-effect:whistle_notes",
    "builtin:avatar-effect:yawn_tear",
    "builtin:particle-effect:aroma-ribbons",
    "builtin:particle-effect:cheer-streamers",
    "builtin:particle-effect:electric-crackle",
    "builtin:particle-effect:energy-wave-charge",
    "builtin:particle-effect:overheat-steam",
    "builtin:particle-effect:spit-spray-mist",
    "builtin:particle-effect:ta-da-glitter",
)


def _regular_path(root: Path, relative: str) -> Path:
    parts = PurePosixPath(relative)
    if (
        not relative
        or parts.is_absolute()
        or "\\" in relative
        or any(p in {"", ".", ".."} for p in relative.split("/"))
    ):
        raise ValueError(f"Unsafe content path: {relative}")
    candidate = root
    for part in parts.parts:
        candidate /= part
        if path_is_link(candidate):
            raise ValueError(f"Symlinked content path: {relative}")
    metadata = candidate.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError(f"Non-regular content path: {relative}")
    return candidate


def catalog_from_scan(entries: list[ScannedContentEntry]) -> dict[str, CatalogContentEntry]:
    """Project exact scanner identities and edges into the existing typed resolver."""

    keys: dict[str, str] = {}
    for entry in entries:
        for key in (entry.relative_locator, entry.logical_key):
            if key is None:
                continue
            if key in keys and keys[key] != entry.relative_locator:
                raise ValueError(f"Colliding Included identity: {key}")
            keys[key] = entry.relative_locator
    result = {}
    for entry in entries:
        item_id = entry.relative_locator
        if item_id in result:
            raise ValueError(f"Duplicate Included locator: {item_id}")
        result[item_id] = CatalogContentEntry(
            id=item_id,
            source=ContentSource.INCLUDED,
            scope=ContentScope.INCLUDED,
            owner_user_id=None,
            kind=entry.kind,
            relative_locator=entry.relative_locator,
            display_name=entry.display_name,
            status=entry.status,
            revision_sha256=entry.revision_sha256,
            files=tuple(
                CatalogContentFile(
                    item_id=item_id, file_ref=f.relative_path, source=ContentSource.INCLUDED, **asdict(f)
                )
                for f in entry.files
            ),
            logical_key=entry.logical_key,
            dependencies=entry.dependencies,
            # Missing targets stay missing, allowing the typed resolver to fail.
            dependency_item_ids=tuple(keys.get(ref, f"missing:{ref}") for ref in entry.dependencies),
            provenance=entry.provenance,
            metadata=entry.metadata,
            diagnostics=entry.diagnostics,
        )
    return result


def starter_inventory(included_root: Path, *, allowed_paths: set[str] | None = None) -> dict[str, Any]:
    """Audit core/expanded closures; never silently omit a required dependency."""

    root = included_root.resolve(strict=True)
    license_path = _regular_path(root, "licenses/inventory.json")
    rules = json.loads(license_path.read_text(encoding="utf-8"))["rules"]
    if not isinstance(rules, list) or not rules:
        raise ValueError("Missing license record: Included inventory has no rules")

    def file_license(relative_path: str) -> dict[str, Any]:
        """Keep distribution exclusions independent of editable entry metadata."""

        record = next((rule for rule in rules if fnmatch.fnmatchcase(relative_path, rule["glob"])), None)
        if not record or not record.get("license_id") or not record.get("provenance"):
            raise ValueError(f"Missing license record: {relative_path}")
        if record.get("distribution") not in (None, *INVENTORY_DISTRIBUTIONS):
            raise ValueError(f"Invalid distribution policy: {relative_path}")
        return dict(record)

    store = FilesystemContentStore(included_root=root, local_root=root / ".unused", operations_root=root / ".unused")
    scanned = store.scan(ContentSource.INCLUDED)
    excluded: list[dict[str, Any]] = []
    admitted = []
    for entry in scanned:
        if any(d.code == "provenance_missing" for d in entry.diagnostics):
            raise ValueError(f"Missing license record: {entry.relative_locator}")
        if allowed_paths is not None and any(f.relative_path not in allowed_paths for f in entry.files):
            excluded.append({"locator": entry.relative_locator, "reason": "not_tracked_distribution_input"})
        elif any(file_license(f.relative_path).get("distribution") == DISTRIBUTION_EXCLUDED for f in entry.files):
            # Exclude the whole typed entry from both partitions. A required
            # starter dependency then fails resolution instead of being trimmed.
            excluded.append({"locator": entry.relative_locator, "reason": "redistribution_excluded"})
        elif any(file_license(f.relative_path).get("distribution") == DISTRIBUTION_NON_PORTABLE for f in entry.files):
            # Non-portable content ships only as its own private Included source,
            # never in core or the publicly downloadable expanded pack.
            excluded.append({"locator": entry.relative_locator, "reason": "non_portable"})
        else:
            admitted.append(entry)
    # Optional sounds excluded above (a private pack) leave their effects silent.
    visible = catalog_from_scan(resolve_optional_dependencies(admitted))
    context = TypedContentResolutionContext(visible)
    logical = {item.logical_key: item.id for item in visible.values() if item.logical_key}
    policy = starter_loadout_policy()
    recommended = [
        *(choice["content_id"] for lane in ("gestures", "reactions") for choice in policy[lane]),
    ]

    def resolve_roots(roots: list[str]) -> set[str]:
        closure: set[str] = set()
        for key in roots:
            item_id = logical.get(key, key)
            for typed in context.resolve(item_id):
                if typed.item.diagnostics:
                    raise ValueError(f"Content diagnostics for {typed.item.relative_locator}")
                closure.add(typed.item.id)
        return closure

    common = resolve_roots(recommended)
    # The authoring collection ships with core even when no Anima equips it.
    # Select before admission filtering so excluded/untracked/invalid required
    # poses fail resolution instead of silently disappearing from distribution.
    authoring_roots = [entry.relative_locator for entry in scanned if entry.kind is ContentKind.POSE]
    core = common | resolve_roots(authoring_roots)
    starters = []
    for spec in STARTER_ANIMA_SPECS:
        roots = [spec.avatar_locator]
        # Match bootstrap's optional presentation; never bundle legacy public URLs.
        if spec.portrait_logical_key in logical:
            roots.append(spec.portrait_logical_key)
        closure = common | resolve_roots(roots)
        core.update(closure)
        starters.append(
            {
                "id": spec.id,
                "version": spec.version,
                "name": spec.display_name,
                "roots": roots + recommended,
                "entries": sorted(closure),
                "diagnostics": [],
            }
        )

    # Library availability is separate from the unchanged per-starter receipts.
    core.update(resolve_roots(list(CORE_LIBRARY_ROOTS)))

    expanded: set[str] = set()
    for item_id, catalog_entry in sorted(visible.items()):
        if catalog_entry.status is not ContentStatus.VALID:
            if not catalog_entry.diagnostics:
                raise ValueError(f"Invalid content has no diagnostic: {catalog_entry.relative_locator}")
            excluded.append(
                {
                    "locator": item_id,
                    "reason": "content_invalid",
                    "diagnostics": [asdict(d) for d in catalog_entry.diagnostics],
                }
            )
            continue
        try:
            expanded.update(resolve_roots([item_id]))
        except ValueError:
            raise
        except TypedContentAdmissionError as exc:
            # An invalid optional graph is not a redistributable pack input.
            excluded.append({"locator": item_id, "reason": getattr(exc, "code", "dependency_invalid")})
    expanded -= core
    files: dict[str, dict[str, Any]] = {}
    items = []
    for item_id in sorted(core | expanded):
        item = visible[item_id]
        for file in item.files:
            path = _regular_path(root, file.relative_path)
            hasher = hashlib.sha256()
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    hasher.update(chunk)
            digest = hasher.hexdigest()
            if path.stat().st_size != file.size_bytes or digest != file.sha256:
                raise ValueError(f"Content changed during inventory: {file.relative_path}")
            license_record = file_license(file.relative_path)
            partition = "core" if item_id in core else "expanded"
            previous = files.get(file.relative_path)
            if previous and (previous["sha256"] != file.sha256 or previous["size_bytes"] != file.size_bytes):
                raise ValueError(f"Colliding Included bytes: {file.relative_path}")
            if previous and previous["partition"] == "core":
                partition = "core"
            files[file.relative_path] = {
                "path": file.relative_path,
                "size_bytes": file.size_bytes,
                "sha256": file.sha256,
                "partition": partition,
                "license": {key: value for key, value in license_record.items() if key != "glob"},
            }
        items.append(
            {
                "locator": item_id,
                "logical_key": item.logical_key,
                "kind": item.kind.value,
                "revision_sha256": item.revision_sha256,
                "partition": "core" if item_id in core else "expanded",
                "dependencies": list(item.dependency_item_ids),
                "files": [f.relative_path for f in item.files],
            }
        )
    payload = {
        "schema": "animama-starter-content/1",
        "starter_pack": starter_pack_identity(),
        "starters": starters,
        "entries": items,
        "files": [files[key] for key in sorted(files)],
        "excluded": sorted(excluded, key=lambda item: item["locator"]),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return {"id": hashlib.sha256(encoded).hexdigest(), **payload}
