# Avatar FX template thumbnails

The Effects template picker shows these images on its Avatar FX templates. Each
`<id>.webp` belongs to the template with that ID in
`src/lib/effects/effectTemplates.ts`; a test checks that every template has a
thumbnail and every thumbnail a template. The picker imports them lazily.

## Regenerating

From `src/frontend/web`, after changing the template list or an Included Avatar
Effect it uses:

```bash
pnpm -s effects:thumbnails              # every template; removes stale files
pnpm -s effects:thumbnails eye_vv star3 # only the named templates
```

The command uses the `effects:render --thumbnail` renderer: headless Chromium
with SwiftShader, Annie (`content/included/avatars/AvatarSample_A_1_New.vrm`)
with the portrait capture's head framing and lighting, the effect applied from
its Included descriptor and held for 1 s, at 320×320 px. A template marked
`thumbnail: { framing: "wide" }` (art on the chest or beside the head) is
framed 2.2 times wider, and `framing: "body"` (art at the belly, hips or a
lowered hand) 3.2 times wider with the camera aimed lower, so the frame runs
from the head to the upper thighs centred on the torso; one with a `time` is
captured at that moment instead
(looping art that has faded out at 1 s). A `clip` names an Included Gesture by
folder stem that poses Annie, for art attached to a hand that hangs out of
frame at rest, or that is placed for that pose: the clip is sampled at `time`
with the effect applied at 0, as `effects:render --with-clip` does (for example
`idea_bulb_fingertip` with `have-an-idea` at 3 s). Because `time` is also the
effect's age, pick a moment where the pose shows the art and the effect is
visible (a looping effect at the start of a cycle). With `fromEvent: true`,
the clip plays and its events start the effect (with the effect's own
definition, not the events' overrides), so `time` is the clip's time and the
pose matches the moment the effect appears in chat (for example
`mind_blown_burst` with `mind-blown` at 1.8 s, 0.79 s after its event). Renders are deterministic, so unchanged inputs
reproduce the same pixels. Review the images before committing them.

## Provenance and terms

Each thumbnail is a direct Animama renderer capture of Annie, the unmodified
pixiv VRoid Project preset, wearing an Included Avatar Effect with Animama's
own owner- or agent-authored art from `content/included/vfx/avatar/`, in some
cases posed by an Included Gesture. No other artwork is used. Like Annie's
Library portrait, the images follow Annie's model terms
(`LicenseRef-pixiv-VRoidPreset`, the
[VRoidPreset A–Z conditions](https://vroid.pixiv.help/hc/en-us/articles/4402394424089-VRoidPreset-A-Z));
they are not CC0 or AGPL. Credit pixiv VRoid Project. See
`licenses/third-party/art-NOTICES.md`, `licenses/source-review.json` and the
desktop runtime notice `effect-template-thumbnails-attribution.txt`.
