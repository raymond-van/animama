# Convert MikuMikuDance (PMX) models to VRM for Animama

Status: Agreed
Owner decision: 2026-11-25. After an investigation of PMX support, the owner
approved evaluating pmx-to-vrm and asked for this spec. On reviewing the first
draft, the owner decided:

- **Terms:** no terms check; users are assumed to own their models and to have
  permission to use them as they wish (Q1).
- **Goal:** aim for the best possible experience in Animama. That includes
  translating a model's face morphs into emotion expressions where needed, and
  look-at wherever possible (R5, R7).
- **Other questions:** the proposed answers to Q2–Q6 are accepted.
- **Later the same day:** write the PMX module in JavaScript with JSDoc types
  rather than TypeScript (Q3; plan decision D1).

## Problem and intended users

Many companion characters exist as MikuMikuDance models (`.pmx`), from fan
creators and from game companies. Animama loads only VRM files
([ADR 0032](../../adr/0032-vrm-container-with-arkit-face-shapes.md)), so such a
model must be converted first. Animama does not offer a way to do that.

Users therefore reach for third-party converters, which differ widely:

- **Web converters built on three.js's `GLTFExporter`** write every material as
  unlit and drop MMD physics and look-at. A user reported such a file looking flat.
  #925 gives these files toon shading at load, but it cannot restore the physics,
  the look-at or the model's own materials.
- **The Blender route** (MMD Tools plus the VRM Add-on) needs three installs at
  matching versions. In VRM Add-on 4.10.2, switching an MMD material to MToon sets
  the lit colour to black. Its MMD spring helper takes colliders only from bones
  above each chain, so skirts pass through the legs, and it maps legs to bones
  that skin nothing on many models.
- **Standalone converters** exist:
  - pmx-to-vrm: MIT, .NET.
  - VRMify: GPL-3.0, Windows only.
  - yomotsu/mmd-to-vrm: a web app with no licence.

  Their output varies, and none knows what Animama needs. In particular, an MMD
  model's emotions often come out incomplete:
  - the standard MMD morphs Animama recognises cover sad only on the brows, and
    angry only on the brows and eyes;
  - models whose morphs are not named in standard Japanese get no emotions at all.

The intended users are Animama users who have an MMD model and want it as their
companion's Avatar. They are on macOS or Windows and can run one command in a
terminal, as the converter's terminal path already requires (Node 22 or later).
They then upload the file as a Local Avatar.

## Goals, scope and non-goals

Goals:

- The Animama Avatar Converter's command converts a PMX model to a VRM 1.0 file,
  without Unity or Blender.
- In Animama, the converted Avatar looks and behaves as close to the model as
  possible:
  - its own toon materials and outlines;
  - physics as springs;
  - every emotion on brows, eyes and mouth;
  - eyes that follow the cursor;
  - a humanoid on the bones that move the mesh.
- Animama handles converted MMD models correctly: no ambient forces on their
  springs, and their MMD names recognised.
- Documentation in the converter's README and in Animama.

Non-goals:

- A terms or licence check in the converter (Q1).
- Loading PMX natively in Animama. ADR 0032 stands: PMX reaches Animama only as
  a VRM.
- Importing PMX inside the app (Q6).
- The older PMD format, VMD motion, MikuMikuEffect effects, and PMX 2.1 soft
  bodies.
- Reproducing MMD's runtime exactly:
  - Bullet physics (joints between neighbouring chains, joint position limits);
  - IK;
  - append (付与) rotations;
  - SDEF skinning, which is converted as linear skinning.
- Changes to the Unity package or the VRChat conversion.
- Changes to #925's unlit fallback. Files from this converter are MToon, so the
  fallback does not apply to them.
- Uploading anything. The converter makes no network requests.

## Required behavior

- **R1 Command.**
  - `npx animama-avatar-converter <model.pmx>` converts the model when the
    argument names a `.pmx` file (any case). It needs no Unity project and no
    Unity install.
  - It accepts the existing `--out`, `--name`, `--version`, `--author`,
    `--copyright`, `--keep-pose` and `--validate` options, and the expression
    overrides of R5.
  - It writes `<name>.vrm` beside the model by default, and never overwrites a
    file.
  - Exit status is 0 when the file was written, or when `--validate` found nothing
    blocking. It is 2 when the model cannot be converted, and 1 otherwise,
    matching the VRChat path.
  - A failed conversion leaves no partial output.
- **R2 Readable input.**
  - Model and texture paths, which are often Japanese or Chinese, are resolved
    relative to the `.pmx` and ignoring case.
  - PMX text is read in either of its encodings (UTF-16 or UTF-8).
  - PNG, JPEG, BMP, TGA and DDS (DXT1, DXT3, DXT5 and uncompressed) textures are
    read.
  - A missing or unreadable texture does not stop the conversion: the material is
    written untextured and the report names the file.
- **R3 Space and skeleton.**
  - The model is scaled 0.08 m per MMD unit, mirrored to face +Z with its front
    faces kept front, and placed with its lowest point at y = 0.
  - Its arms are baked into the T-pose that VRM 1.0 expects, unless `--keep-pose`
    is given.
  - Humanoid bones come from MMD's standard bone names, in Japanese and common
    English forms.
    - Legs use the D-bones (足D, ひざD, 足首D) when present, because those carry
      the skin.
    - Hips are the deepest common ancestor of 上半身 and both legs.
  - IK, twist, append and helper bones stay as ordinary nodes.
  - When a bone VRM requires is missing, conversion stops (exit 2) and the report
    names it.
- **R4 Materials.** Every PMX material becomes MToon:
  - **Lit colour:** the texture times MMD's lit colour (diffuse and ambient as MMD
    combines them).
  - **Shadow:** the dark end of the material's toon ramp, with the base texture as
    the shade texture.
    - The ten shared MMD ramps (toon01–toon10) use built-in colour values; no MMD
      images are shipped.
    - A model's own toon texture is sampled.
    - A material without a toon ramp is not shaded, as in MMD.
  - **Outline:** the edge flag, size and colour become an MToon outline that is
    not lit, as in MMD.
  - **Sphere maps:** an additive sphere map (`.spa`) becomes the matcap.
  - **Transparency and sides:**
    - a material with diffuse alpha below 1, or soft texture alpha, is
      transparent, drawn in PMX material order;
    - hard texture alpha becomes a cutout;
    - the double-sided flag is kept.
  - **Reported as dropped, with counts:** multiplicative sphere maps,
    sub-texture spheres, specular highlights and per-vertex edge scale.
- **R5 Face morphs and emotions.**
  - **Every face morph is kept.**
    - Every vertex morph is a morph target named as in the PMX, so Animama's MMD
      face table finds the standard ones by name.
    - Group morphs are baked into a morph target named after the group when they
      contain only vertex and bone parts. Otherwise they become a VRM expression
      of the same name.
    - Bone morphs are baked into approximate morph targets.
    - Material morphs become VRM expressions with material colour binds. Hidden
      materials that a morph reveals stay hidden at weight 0.
    - A UV morph that moves a whole material evenly becomes a texture offset bind.
      Other UV morphs, and flip and impulse morphs, are dropped and reported.
  - **Every emotion is filled.** The five VRM emotion presets (`happy`, `angry`,
    `sad`, `relaxed`, `surprised`) are composed from the model's morphs, region by
    region: brows, eyes, mouth.
    - The converter translates morphs it recognises by meaning, not only MMD's
      standard Japanese names: common variants (half-width, numbered), and common
      English, Chinese and Korean names.
    - A morph's region comes from its PMX panel (brow, eye, mouth) and from the
      vertices it moves.
    - Where the standard names give no morph for a region (sad eyes and mouth,
      angry mouth), the converter uses the closest suitable morph the model has,
      for example a lowered mouth corner for sad. It leaves the region neutral
      only when nothing suitable exists.
  - **Blink and visemes:** `blink`, `blinkLeft`, `blinkRight` and `aa`, `ih`,
    `ou`, `ee`, `oh` are filled the same way. Wink sides are checked from the
    vertices each morph moves.
  - **In Animama:** each mood plays region by region (brows, eyes, mouth) from the
    model's own morphs wherever a suitable morph exists, rather than only as a
    whole-face preset. Animama's content keys moods by region.
  - **Overrides:** the report lists which morphs each preset uses, and the user can
    override any preset's composition from the command line.
  - **Storage:** morph targets are stored sparse, so files stay well under the
    upload limit.
- **R6 Physics.**
  - Rigid bodies that MMD simulates become VRM spring joints, chained along the
    bone hierarchy.
  - Bodies that follow their bone become colliders: spheres and capsules as they
    are, boxes as capsules along their longest axis.
  - Which colliders each spring uses follows the model's MMD collision groups,
    not bone ancestry, so skirts collide with the legs where the author set that.
  - Stiffness, drag, gravity and radius are derived from the bodies and joints.
  - The report lists the chains, and the count of joints between chains that VRM
    cannot express.
- **R7 Look-at.** Every model whose eyes are separate parts gets look-at, and the
  iris never tears:
  - When 左目 and 右目, with the bones below them, move the whole eye parts, the
    file gets bone look-at with its offset between the eyes.
  - When eye parts are partly skinned to bones beside the eye bones, as on models
    with separate pupil or highlight bones, the converter makes those parts
    follow the eye bones, so bone look-at moves the whole eye.
  - When no eye bones can drive the eyes, the converter builds expression look-at
    from the eye parts' own movement: look up, down, left and right.
  - Only eyes that are painted onto the face, with no separate eye parts, get no
    look-at.
  - The report states which method was used, or why look-at was not possible.
- **R8 Metadata.**
  - VRM meta takes the name and author from the options, or else from the PMX
    name and from credit lines in its comment (モデル製作, 模型制作, Model, and
    similar), or else "unknown".
  - Permissions stay at VRM's most restrictive defaults, as in the VRChat path.
- **R9 Report.** Like the VRChat path's report, in plain language:
  - the humanoid bones mapped;
  - each preset and the morphs it uses;
  - the morph targets, spring chains, joints and colliders;
  - the look-at method;
  - every dropped feature with its count;
  - missing textures.
- **R10 Animama: springs without ambient forces.**
  - Files from this converter carry an `ANIMAMA_avatar_conversion` extension,
    declared in `extensionsUsed`, that records the source format and the
    converter version (Q4).
  - Under the Automatic wind setting, Animama adds no wind, updraft or
    zero-gravity baseline to the springs of such an Avatar, as it already does
    for Mochiya conversions.
  - The extension is accepted wherever Mochiya's is: loading, Diagnostics,
    `vrm:optimize` and Library package import.
- **R11 Animama: MMD names.** Face-part detection recognises hair materials named
  in Japanese or Chinese (髪, 头发, 发, and similar) as well as by the current
  English patterns.
- **R12 Documentation.**
  - The converter's README covers converting an MMD model: the command, what
    carries over and what doesn't, the expression overrides, and uploading.
  - Animama gains a "Converting an MMD model" page beside
    [VRChat Avatar conversion](../../frontend/runtime/vrchat-avatar-conversion.md)
    for developers. It covers checking a conversion with `vrm:inspect` and keeping
    third-party models out of the repository.
  - Create Anima shows one line under **Upload VRM** that links the converter's
    README for MMD models. The picker keeps accepting only `.vrm` (Q5).

## Constraints

- **Licences.**
  - The converter stays MIT. Code taken from pmx-to-vrm (MIT) keeps its copyright
    notice.
  - No code from GPL projects (MMD Tools, VRMify) or unlicensed ones
    (yomotsu/mmd-to-vrm).
  - MMD's shared toon images are not redistributed; only colour values derived
    from them are used.
- **Third-party models in our records.**
  - No MMD model, converted file, render or shape data enters either repository,
    tests, content packages or public evidence.
  - Issues and PRs never name the test models or their authors; evidence is
    counts, timings and pass/fail.
  - Tests use synthetic PMX files written by a test-only writer.
- **No network.** The converter contains no network code; review and a CI source
  search confirm it.
- **Dependencies.** The npm package keeps no runtime dependencies. The PMX code is
  a separate module that an in-app importer could reuse (Q3).
- **Platforms.** macOS and Windows with Node 22 or later, verified before release.
  Linux is not promised.
- **Compatibility.**
  - Output is VRM 1.0 using only extensions Animama already loads, plus the R10
    marker.
  - It passes the backend upload validator (`validate_vrm_stream`) and loads with
    three-vrm 3.5.
- **Performance.** A model of about 100,000 vertices converts in under 30 seconds
  on a typical laptop.
- **Publication.** Releasing the converter (GitHub release and npm) needs the
  owner's approval, as before.

## Acceptance criteria

- [ ] **Synthetic tests** (`node --test` in the converter) cover:
  - the humanoid map with and without D-bones;
  - the T-pose bake;
  - material mapping, including shared and custom toons, toon-less materials,
    outlines and transparency;
  - morph names, group and bone-morph baking, and material and UV binds;
  - presets composed from Japanese, English and Chinese morph names, with each
    region's fallback;
  - springs with collider groups from collision masks;
  - each look-at method, including eye parts skinned beside the eye bones, where
    every iris vertex must move rigidly with the eye;
  - never overwriting, and exit codes.
- [ ] **Private corpus.** At least five MMD models each convert. Together they
  cover:
  - D-bone and plain rigs;
  - group, bone and UV morphs;
  - morphs not named in standard Japanese;
  - split eye skinning;
  - custom toon textures;
  - non-PNG textures;
  - a PMX 2.1 file.

  Each output:
  - passes `validate_vrm_stream`;
  - shows in `vrm:inspect` all the model's vertex morph names, and no `none` under
    blink and visemes;
  - has no neutral mood region where the model has a suitable morph;
  - has look-at unless its eyes are painted on.

  Evidence: counts only.
- [ ] **Owner manual check.** In Animama's chat, converted models show:
  - toon shading and outlines;
  - springs that hang at rest and move with Gestures without blowing out;
  - all five moods and visemes playing on the face;
  - eyes that follow the cursor without tearing.
- [ ] **Platforms.** The command runs on macOS and on Windows. Evidence: one
  conversion each, counts only.
- [ ] **Animama.**
  - Unit tests show that an Avatar with `ANIMAMA_avatar_conversion` gets no
    ambient forces, and that an MMD-named hair material is found as hair.
  - A marked file survives `vrm:optimize` and Library export and import.
  - Create Anima shows the MMD line.
- [ ] **Docs.** The converter README and the Animama page describe the shipped
  behaviour.

## Open questions and decisions

- **Q1 Terms check.** Decided 2026-11-25 (owner): none. Users are assumed to own
  their models and to have permission to do what they want with them.
  - The converter shows no terms, asks for no acknowledgement and writes no terms
    file.
  - The README's existing general licence note stays as it is.
- **Q2 Morph scope in v1.** Decided 2026-11-25: vertex, group, material and bone
  morphs are converted.
  - Bone morphs are baked by skinning at full weight, which is approximate for
    large rotations.
  - Owner direction the same day: translate face morphs into emotions where needed
    (R5), and convert UV morphs where VRM can express them.
- **Q3 Implementation basis.** Decided 2026-11-25: port pmx-to-vrm's design and
  code into the converter's npm package, with no runtime dependencies, keeping the
  PMX code a separate module.
  - The language was amended the same day (owner): JavaScript ES modules with
    JSDoc types, like the rest of the command, instead of TypeScript. An npm
    package run by `npx` cannot ship `.ts` without a build step.
  - An evaluation that day converted a fan-made test model (69k vertices, 15
    materials, 679 bones, 459 rigid bodies) in under a second.
  - The output passed `validate_vrm_stream` and `vrm:inspect`, and showed toon
    shading in Animama's chat lighting.
  - Its gaps are what R4, R5, R7 and R8 add:
    - by default it kept only the standard morphs;
    - every material got the same shadow colour;
    - outlines were lit;
    - a material morph was dropped;
    - bone look-at would tear that model's iris, which is partly skinned to bones
      beside the eye bones;
    - it could not read the author from a Chinese comment.
- **Q4 Marker for R10.** Decided 2026-11-25: an `ANIMAMA_avatar_conversion`
  extension, added to the loader, package-import and `vrm:optimize` lists as
  Mochiya's was.
  - The evaluation showed that the hair blew sideways and the skirt ballooned with
    ambient forces on, and hung naturally with them off.
- **Q5 How Animama points to the converter.** Decided 2026-11-25: the
  documentation page and one line under Create Anima's **Upload VRM** (R12).
- **Q6 Importing inside the app.** Decided 2026-11-25: out of scope. Reconsider
  after the release, with evidence of demand.

## Spec

This document (agreed draft). The owning issue will be created when
implementation is authorized.

## ExecPlan

Required: the work spans two repositories (the converter and Animama), a new
conversion path, a public distribution channel and verification on two
platforms. [`pmx-conversion-execplan.md`](pmx-conversion-execplan.md) on
`feat/pmx-conversion` (draft, awaiting owner review).

## Delivery links

None yet. Related: #925 (load-time toon shading for unlit-only files, PR #926).
