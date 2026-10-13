# Optional Local Mixamo animations

Animama starts and creates its two starter companions without Mixamo assets.
The shipped starter pack has all 95 non-idle project-authored gestures and 72
reactions; new companions have an empty Idle selection. The 12 Streamer Idle
gestures are not starters. Required selected content still passes the normal
strict revision, dependency and file checks, including the tracked-only native
staging gate.

Motions installed this way are optional, editable Local content. They are never
automatically equipped or included in source, Docker build contexts or
self-host images. Desktop and hosted builds ship a separate, owner-acquired set
as the non-portable [Mixamo-motion pack](../../backend/operations/mixamo-motion-pack.md);
its files are restricted wherever they appear, so a Local copy with identical
bytes is non-portable too.
The acquisition inventory and control-document templates live in
`scripts/mixamo-assets.json`.
Existing companions referencing those old Included IDs need explicit replacement
or a development database reset. No starter policy migration is provided.

## Download and convert

From the repository root, run:

```bash
python3 scripts/acquire-mixamo.py --prepare --open
```

This opens Adobe's website and writes a private checklist at
`data/mixamo-acquisition/checklist.json`. Sign in yourself, select a character,
search the Animations tab, preview each motion, then download FBX files using
Adobe's Download button. Keep the originals and conversion work in
`data/mixamo-acquisition/`. Existing checklist answers are preserved.
Running without flags prints instructions and target paths.

The helper covers the 29 former starter clips: 23 gestures and six idle motions.
Labels are search hints; the exact original Adobe animation IDs, character and
export settings have not been recovered. Record them while downloading.
Download and FBX-to-VRMA conversion remain manual; the helper does neither.
Renaming FBX to `.vrma` does not convert it. Verify retargeting/playback after
conversion; a matching label or structurally valid VRMA does not prove the motion
is correct.

## Install converted files

Arrange converted files under a source directory using the manifest's
`target_path` with the `content/included/` prefix removed, for example:

```text
data/mixamo-acquisition/converted/
  gestures/wave/wave.vrma
  gestures/blush/blush.vrma
  ...
  idle-styles/starter/animations/angry.vrma
  idle-styles/starter/animations/sway.vrma
  ...
```

Once all 29 target clips are present, install them:

```bash
python3 scripts/acquire-mixamo.py --install-from data/mixamo-acquisition/converted
```

The default destination is this checkout's ignored `content/local/` library.
Use `--local-root /absolute/path/to/local` for a different installation.
The result is 29 Gesture items: 23 in `gestures/mixamo-<name>/` and six idle
Gestures in `gestures/mixamo-idle-<name>/`. The Idle Style in
`idle-styles/mixamo-starter/` references those six Gestures through Default and
emotion/intensity pools. Each Gesture retains its original motion settings;
installation does not equip it for AI invocation. The script
prints an installation receipt with hashes.

The installer checks GLB/VRMA structure, rejects symlink destinations and inputs,
and stages complete item folders before placing them in their typed roots.
Identical retries are safe; differing existing items stop installation, preserving
owner edits. Temporary staging is removed when installation finishes.

Rescan My Content if the filesystem watcher has not refreshed it, then select
these items through the normal Gesture/Idle loadout controls. Installation does
not change the database, current loadouts or starter defaults. Local files remain
ignored; do not force-add them to Git or copy them into a release stage.

This helper grants no rights to Adobe assets. Applicable use and redistribution
terms remain the operator's responsibility; optional local installation is not
source or binary distribution approval.
