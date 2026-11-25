# Converting an MMD model

Animama loads VRM files. A MikuMikuDance model (`.pmx`) reaches it through a
VRM 1.0 conversion with the command of
[Animama Avatar Converter](https://github.com/raymond-van/animama-avatar-converter),
which needs no Unity or Blender: `npx animama-avatar-converter <model.pmx>`.
The converter's README is the user guide. This page covers the developer
workflow and what Animama does with the result. Create Anima's avatar step
links the README for MMD models; its picker still accepts only `.vrm`.

## Third-party models stay private

- **Where they live:** keep MMD models, converted files, reports and renders
  outside every repository. Never add them to tests, content packages, Animama
  Cloud or shared review evidence.
- **Naming:** issues and PRs never name a test model or its author. Evidence is
  counts, timings and pass/fail.
- **Tests:** the converter's own tests build synthetic PMX files in code
  (`pmx/testing/` in the converter repository).

## Convert

```bash
npx animama-avatar-converter <model.pmx> --out <private-dir>/<name>.vrm
```

- **Options:** `--name`, `--version`, `--author` and `--copyright` fill the VRM
  metadata; the author otherwise comes from the model's comment ("モデル製作：…",
  "Model: …"). `--keep-pose` keeps MMD's modelled pose instead of the T-pose;
  `--validate` prints the report and writes nothing.
- **Faces:** `--expression <name>=<morph>[*<weight>][+<morph>…]`, repeatable,
  chooses the morphs of a preset (`happy`, `blinkLeft` …) or of one mood region
  (`Fcl_EYE_Joy` …) when the composed face looks wrong.
- **Unreleased changes:** run `node cli/main.mjs` from a converter checkout
  instead of `npx`.
- **Safety:** the command never overwrites a file and leaves no partial file
  when it fails.
- **Report:** it counts the humanoid bones mapped and lists each expression
  with the morphs it uses, the spring chains, the look-at method, missing
  textures and what was dropped.

## What the converter writes

- **Skeleton:**
  - 8 cm per MMD unit, facing +Z, with a baked T-pose.
  - Humanoid legs on the D-bones (足D, ひざD, 足首D) when the model has them, and
    the hips moved between the legs and the spine.
  - IK, twist and append bones stay as ordinary nodes.
- **Materials:** MToon following MMD's shading.
  - The lit colour is diffuse × MMD's default light (154/255) + ambient, and the
    shade comes from the material's toon ramp.
  - Outlines are unlit and in screen space, about edge size × 0.0037 of the
    screen.
  - Additive sphere maps become matcaps, and transparent materials keep MMD's
    draw order.
- **Faces:**
  - Every vertex and bone morph, and every group morph that moves vertices or
    bones, is a morph target under its PMX name, so Animama's MMD table
    ([Faces on non-VRoid Avatars](avatar-emotion.md#faces-on-non-vroid-avatars))
    finds the standard ones. Every converted morph is also a custom expression of
    that name; material and UV morphs reach Animama only this way, as colour
    binds and texture offsets.
  - `--expression` can't leave a blink or viseme empty: Animama fills an empty
    one from the model's standard morphs.
  - The converter fills the blink, viseme and five emotion presets. It writes
    region parts (`Fcl_BRW_<Mood>`, `Fcl_EYE_<Mood>`, `Fcl_MTH_<Mood>`) and
    `Fcl_ALL_<Mood>` from the model's own morphs, translated from Japanese,
    English, Chinese or Korean names, and Animama plays these as the model's own
    parts. As on VRoid models, a mood preset equals its `Fcl_ALL_` part: the
    three regions together, or the model's own `Fcl_ALL_<Mood>` morph when it has
    one. `--expression` overrides keep the two in step.
- **Physics:**
  - Simulated rigid bodies become spring joints; bodies that follow a bone
    become colliders.
  - Which colliders a spring uses follows the model's MMD collision groups.
- **Look-at:** bone look-at on 左目/右目. Bones beside the eye bones that skin
  only the eyes (separate pupil or highlight bones) are re-parented under them.
  Without eye bones that can turn the eyes whole, the eyes get expression
  look-at from synthesized morph targets; eyes painted on the face get none, and
  the report says why.
- **Marker:** `ANIMAMA_avatar_conversion` (`{ "source": "pmx", "converter":
"<version>" }`) in `extensionsUsed`. It means the springs were tuned without
  ambient forces; Animama checks only that it is present.

Not carried over, each counted in the report:

- joints between neighbouring spring chains;
- multiplicative and sub-texture sphere maps;
- specular highlights, outline transparency and per-vertex edge scale;
- SDEF (skinned linearly);
- UV morphs that do not move a whole material evenly, morphs of the
  additional UV channels, flip and impulse morphs, fades of every material at
  once, and tints that brighten a texture;
- PMX 2.1 soft bodies.

IK and append (付与) bones stay as ordinary nodes that drive nothing (bone
morphs do follow append bones), and the older PMD format is refused.

## What Animama does with it

- **Springs:** under the Automatic wind setting, a marked Avatar gets no wind,
  updraft or zero-gravity baseline
  ([`SpringBonePhysicsController`](avatar-animation.md#springbonephysicscontroller)).
  MMD physics has none, and with them the hair blows sideways and the skirt
  balloons. A re-export that drops the marker brings them back.
- **Hair:** face-part detection also finds hair by the Japanese, Chinese and
  Korean names models use (髪, 发, 刘海, 앞머리 …), when springs do not reveal it
  ([Effects](avatar-vfx.md)).
- **Accepted everywhere Mochiya's is:** the marker is accepted by the loader,
  Avatar Diagnostics, `vrm:optimize` and Library packages.

## Check the conversion

From `src/frontend/web`:

```bash
pnpm -s vrm:inspect <private-dir>/<name>.vrm
```

Check that:

- the file is VRM 1.0 with `ANIMAMA_avatar_conversion` among its extensions;
- every vertex morph of the model is listed by name;
- "blink and visemes" lists no `none`;
- "mood faces" plays each region from the model's own parts (`vroid`, the
  converter's `Fcl_` parts), with `none` only where the model has no suitable
  morph;
- "face parts" finds `face_skin`, both eyes and hair.

Then render it with
`pnpm -s effects:render <effect> --avatar-file <private-dir>/<name>.vrm --times 1,3,8 --out <private-dir>/renders`
to see that the springs hang and settle, and upload it as a Local Avatar to
check motion, faces and cursor look-at in chat. `pnpm -s vrm:optimize` shrinks
the file and keeps the marker ([VRM optimization](vrm-optimization.md)).
Renders show a third-party model: keep them private.
