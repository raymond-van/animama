# Batch mode

Use batch mode when the owner asks for several Gestures at once (up to ten
per batch; split larger requests). The steps per item are the normal
workflow; the batch sends every animation's interview questions at once,
then adds parallel authoring, a consistency pass, one review session and one
save run.

## 1. Brief every item together

Prepare each animation's own [interview](interview.md) questions and send
them all in one message, grouped by animation. With the answers, show one
table of briefs to confirm:

| Name | Selector ID | Intent | Once/held | Length | Intensity | Hand | Contacts | Face |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

Check the Selector IDs before authoring: unique in the batch, not used by an
Included Gesture (a replacement gets its own ID), reusing a Local Gesture's
ID only to revise that Gesture, and tiers of one action sharing a stem
(`laugh_mild`, `laugh_medium`).

## 2. Author items in parallel

When the host can run subagents, give each item its own: authoring is the
slow step, and a fresh context per item keeps attention on one motion. Run
about five at a time. Each subagent receives the confirmed brief, this skill
and its references, the draft path to write
(`.animama-drafts/<name>.clip.json` at the repository root), and these
instructions:

- follow workflow steps 1–5: write, validate, check (fix every FAIL) and
  render contact sheets to a scratch directory;
- inspect its own sheets and revise until the motion reads as the brief;
- do not save, start a preview for the owner, or change other items;
- return the clip path, the check summary with any accepted WARNs, the sheet
  paths, and what it could not judge.

Without subagents, author the items one after another the same way. Either
way, never run two saves at once: they share one app and one browser.

## 3. Consistency pass

Before the owner sees anything, compare the items side by side: matching
energy for the same intensity, the same hand-shape and expression style,
similar settle timing, and tiers that clearly step up. Fix outliers in their
clips and re-run validate and check on each changed item.

## 4. One review session

Start one preview with the first item (`pnpm -s animation:preview
<first>.clip.json`) and tell the owner to pick each item in the **Review**
picker, with **Compare** set to the original for a replacement. Notes are kept
per item. Apply each note, resolve it with `animation resolve`, and ask the
owner to look again.

## 5. Save the batch

Write one items file and save every item in one run:

```json
[
  {
    "clip": "/absolute/path/to/.animama-drafts/shy-wave.clip.json",
    "name": "Shy Wave",
    "aiDescription": "A small, bashful wave for greetings when shy.",
    "selectorId": "shy_wave"
  }
]
```

```bash
source ../../../.animama-stack.env   # from src/frontend/web: the stack's origin
pnpm -s animation:save <items.json>
```

Keep the items file in a scratch directory, outside the repository; clip
paths are absolute or relative to the items file. An optional `description`
sets a new Gesture's Library description (it defaults to the AI description).
An optional `project` path, also absolute or relative to the items file,
imports that project's sequence and dependencies instead of `clip`, resolving
Local and Included effect refs against the running Library; the item's name,
AI description and Selector ID still apply. For revisions, a project import
replaces the dependencies and project metadata too; without `project`, the
clip-only behavior below is unchanged.

The tool saves the items one after another through the Gesture creator,
exactly as a person would:

- a new Selector ID becomes a new Local Gesture;
- a Local Gesture's Selector ID revises that item in place: the clip is
  imported into it (its name, components, notes and description are kept),
  its AI description is set, and it is saved as a revision. The name must
  stay the same, because renaming in the creator can re-derive the Selector
  ID from the new name (by hand too), so leave renames to the owner;
- a Selector ID that belongs to an Included Gesture is refused.

After each save the tool reads the item back to confirm its Selector ID and
reopens it to confirm its beats load. It prints each item as it goes, so a
failure part-way does not hide earlier saves; fix the failing item and run
again (saved items are revised, not duplicated). Then run the chat check on a
sample of the batch.

## 6. Hand off

One table with a row per item: name, Selector ID, clip path, saved item URL,
check summary, review notes and resolutions, and known limits.
