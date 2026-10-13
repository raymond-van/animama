# Effect template thumbnails

The Effects template picker shows these images on its templates: Avatar FX
thumbnails are `<id>.webp` at this folder's top level, Particle FX thumbnails
`particle/<id>.webp` and Scene FX thumbnails `scene/<id>.webp`. Each belongs
to the template with that ID (the Included effect's folder stem) in
`src/lib/effects/effectTemplates.ts`; a test checks that every template has a
thumbnail and every thumbnail a template. The picker imports them lazily.

## Regenerating

From `src/frontend/web`, after changing a template list or an Included effect
it uses:

```bash
pnpm -s effects:thumbnails                      # every template; removes stale files
pnpm -s effects:thumbnails --kind particle      # one kind; removes only its stale files
pnpm -s effects:thumbnails eye_vv heart-burst   # only the named templates
```

A template ID names one template of any kind; when an ID exists for several
kinds, `--kind` chooses one. A run removes stale files only from the folders
of the kinds it rendered.

All thumbnails are 320×320 px renders of Annie
(`content/included/avatars/AvatarSample_A_1_New.vrm`) in headless Chromium,
with WebGL on SwiftShader. Renders are deterministic, so unchanged inputs
reproduce the same files. Review the images before committing them.

**Avatar FX** thumbnails use the `effects:render --thumbnail` renderer: the
portrait capture's head framing and lighting, the effect applied from its
Included descriptor and held for 1 s. A template marked
`thumbnail: { framing: "wide" }` (art on the chest or beside the head) is
framed 2.2 times wider, and `framing: "body"` (art at the belly, hips or a
lowered hand) 3.2 times wider with the camera aimed lower, so the frame runs
from the head to the upper thighs centred on the torso; one with a `time` is
captured at that moment instead (looping art that has faded out at 1 s). A
`clip` names an Included Gesture by folder stem that poses Annie, for art
attached to a hand that hangs out of frame at rest, or that is placed for that
pose: the clip is sampled at `time` with the effect applied at 0, as
`effects:render --with-clip` does (for example `idea_bulb_fingertip` with
`have-an-idea` at 3 s). Because `time` is also the effect's age, pick a moment
where the pose shows the art and the effect is visible (a looping effect at
the start of a cycle).

**Particle FX and Scene FX** thumbnails use the review stage of
`effects:render` sheets: Annie from the front with the chat's Portrait
framing (head to waist), particles seeded so they repeat, and Scene layers
behind and in front of her over the mid-grey review backdrop. The stage is
captured at 768 px and downscaled. Each is captured 1 s after the effect
starts, or at the template's `thumbnail.time`: early for a burst, later for a
stream that builds up, before a Scene's swaying lines leave the view. A
template marked `thumbnail: { framing: "head" }` (an effect around or above
the head) is framed closer, with room above the head.

## Provenance and terms

Each thumbnail is a direct Animama renderer capture of Annie, the unmodified
pixiv VRoid Project preset, with an Included effect and no other artwork:

- Avatar FX: an Included Avatar Effect with Animama's own owner- or
  agent-authored art from `content/included/vfx/avatar/`, in some cases posed
  by an Included Gesture;
- Particle FX: an owner-authored Included Particle Effect from
  `content/included/vfx/particle/quark/`; Heart Stream's heart texture comes
  from the project's generated particle texture set
  (`LicenseRef-Animama-generated-and-CC0-particle-VFX`, see
  `content/included/licenses/inventory.json`);
- Scene FX: an owner-authored Included Scene Effect from
  `content/included/vfx/scene/`.

Like Annie's Library portrait, the images follow Annie's model terms
(`LicenseRef-pixiv-VRoidPreset`, the
[VRoidPreset A–Z conditions](https://vroid.pixiv.help/hc/en-us/articles/4402394424089-VRoidPreset-A-Z));
they are not CC0 or AGPL. Credit pixiv VRoid Project. See
`licenses/third-party/art-NOTICES.md`, `licenses/source-review.json` and the
desktop runtime notice `effect-template-thumbnails-attribution.txt`.
