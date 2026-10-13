# Promote to Included

Included content ships with the app. Promote a Scene Effect only when the
owner explicitly approves that item for Included content, on a task branch
whose PR they will review. Approval to save, preview or render is not
approval to promote.

## Before promoting

- The owner reviewed the saved Local item in the live preview on both
  Included Avatars, and it has not changed since.
- `pnpm -s effects check library:scene-effect/local/<name>` passes.
- Its images are PNGs (a promoted Scene keeps only PNG art) and it has no
  sound.
- Decide each item's mode with the owner: `add` (a new stem), `replace` (a new
  definition and images for an existing Included Scene of the same kind,
  keeping its folder, content ID, version and name) or `delete` (refused
  while any Included content depends on it).

## Promote

With the stack record sourced (Local items come from its
`ANIMAMA_LOCAL_CONTENT_HOST_PATH`), from `src/frontend/web`:

```bash
pnpm -s effects promote promote.json --dry-run
pnpm -s effects promote promote.json
```

```json
[
  { "kind": "scene_effect", "source": "library:local/Proud Radiance", "stem": "proud-radiance", "mode": "add" },
  { "kind": "scene_effect", "source": "library:local/Joy v2", "stem": "scene-vfx-emotion-joy", "mode": "replace" },
  { "kind": "scene_effect", "stem": "old-scene", "mode": "delete" }
]
```

It writes `content/included/vfx/scene/<stem>/` (descriptor and images) with
content ID `builtin:scene-effect:background:<stem>` or
`builtin:scene-effect:focus:<stem>` after its kind, after validating the
definition (runtime parse and shared limits) and re-checking each image
against its budget. A replace must keep the Scene's kind, which its ID names.
`name` and `description` may override the source's for an add; `description`
for a replace.

Licence records: Scene PNGs fall under the owner-authored rule
`vfx/scene/**/*.png`. Each written file gets a `licenses/source-review.json`
record in the owner form, except an image whose bytes repeat third-party
Included art: it keeps that file's record and, in an exact-path rule, its
licence terms. A removed or replaced third-party record (such as a Twemoji
copy an old Scene carried) is reported so its evidence files can be updated.

Reactions and Gestures that use the Scene are replaced in the same run from
creator project files, as in the Avatar Effect skill's promote reference;
dependencies on Local Scenes promoted in the run are re-pointed at their
Included IDs. Show the owner the dry-run list before writing.

## Afterwards

1. `git add` the new files: backend Included-content tests read tracked files
   only.
2. Templates: every Included Scene Effect needs an Effects picker template
   (`effectTemplates.test.ts` checks): add it to `SCENE_EFFECT_TEMPLATES`
   in `src/frontend/web/src/lib/effects/effectTemplates.ts` under its
   promoted name, in its family's group (Focus lines for focus lines), run
   `pnpm -s effects:thumbnails --kind scene <stem>`, and add a source-review
   record for the thumbnail in the existing thumbnail form. Give a Scene
   whose layers peak early or late a `thumbnail: { time }` (after any entry
   flash). Check every image. Regenerate thumbnails of replaced templates;
   remove a deleted effect's template, thumbnail and the
   thumbnail's source-review record (`effects promote` drops records only
   for effect files).
3. Update pinned expectations deliberately (Scene counts, presets and
   mappings in frontend tests).
4. Run `uv run pytest -q tests/test_included_content_integrity.py
   tests/test_included_content_catalog.py tests/test_starter_content_closure.py
   scripts/public-release/test_prepare_source.py`, then from `src/frontend`
   `pnpm check`, `pnpm web:lint`, `pnpm web:test` and `pnpm build`.
5. Do not change the starter loadout or equip anything unless asked.

A Local Reaction or Gesture that still names a deleted Included Scene keeps
playing without it and asks for repair in its creator; it is not migrated.
