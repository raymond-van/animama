# Convert MikuMikuDance (PMX) models to VRM for Animama

Status: Proposal
Owner decision: Pending. 2026-11-25: after an investigation of PMX support, the
owner approved evaluating pmx-to-vrm and asked for this spec.

## Problem and intended users

Many companion characters exist as MikuMikuDance models (`.pmx`). They come from
fan creators, and from game companies that release official models for video
making. Animama loads only VRM files
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

  Their output varies, and none knows what Animama needs, such as keeping every
  face morph under its MMD name.

The intended users are Animama users who have an MMD model whose terms allow them
to convert it for their own use. They are on macOS or Windows and can run one
command in a terminal, as the converter's terminal path already requires (Node
22 or later). They then upload the file as a Local Avatar.

## Goals, scope and non-goals

Goals:

- The Animama Avatar Converter's command converts a PMX model to a VRM 1.0 file
  that Animama loads well, without Unity or Blender.
- The file keeps the model's own look and behaviour as far as VRM 1.0 allows:
  toon materials and outlines, physics as springs, look-at, every face morph, and
  a humanoid on the bones that move the mesh.
- The model's terms are shown and acknowledged before conversion, and they travel
  with the output.
- Animama handles converted MMD models correctly: no ambient forces on their
  springs, and their MMD names recognised.
- Documentation in the converter's README and in Animama.

Non-goals:

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
    `--copyright`, `--keep-pose` and `--validate` options, plus `--accept-terms`
    (R2).
  - It writes `<name>.vrm` and `<name>.license.txt` beside the model by default,
    and never overwrites a file.
  - Exit status is 0 when the files were written, or when `--validate` found
    nothing blocking. It is 2 when the model cannot be converted, and 1 otherwise,
    matching the VRChat path.
  - A failed conversion leaves no partial output.
- **R2 Terms first.**
  - Before writing, the command prints:
    - the model's comment, in the PMX's local and English fields;
    - the text of the terms and readme files beside the model, with their file
      names. Text is decoded from UTF-8, UTF-16, Shift-JIS or GBK.
  - It highlights lines that contain phrases that commonly restrict use: no use
    outside video or MMD, no conversion or modification, no redistribution, no
    commercial use. It never states that a model may be converted.
  - In a terminal it then asks whether the terms allow converting the model for
    the user's own use. The default answer is no. Without a terminal it requires
    `--accept-terms`.
  - Declining, or a missing flag, writes nothing and exits non-zero.
  - `--validate` writes nothing and needs no acknowledgement.
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
- **R5 Face morphs and expressions.**
  - **Vertex morphs:** every one is a morph target named as in the PMX, so
    Animama's MMD face table finds it by name.
  - **Group morphs:**
    - made only of vertex morphs: baked into a morph target named after the group;
    - otherwise: a VRM expression of the same name.
  - **Material morphs:** a VRM expression with material colour binds. Hidden
    materials that a morph reveals stay hidden at weight 0.
  - **Bone morphs:** baked into approximate morph targets (Q2).
  - **UV, flip and impulse morphs:** dropped and reported.
  - **VRM presets** are filled from the standard names, checking the eye side from
    the vertices for winks:
    - あいうえお → `aa`, `ih`, `ou`, `ee`, `oh`
    - まばたき → `blink`; ウィンク/ウィンク右 → `blinkLeft`/`blinkRight`
    - 笑い, 怒り, 困る, なごみ, びっくり → the emotion presets
  - Morph targets are stored sparse, so files stay well under the upload limit.
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
- **R7 Look-at.**
  - When 左目 and 右目 exist, the file gets bone look-at with its offset between
    the eyes.
  - If moving the eye bones would move only part of an eye mesh (some of its
    vertices follow bones the eyes do not move), look-at is left out and the
    report says why. Otherwise the iris would tear.
- **R8 Metadata and terms with the file.**
  - VRM meta takes the name and author from the options, or else from the PMX
    name and from credit lines in its comment (モデル製作, 模型制作, Model, and
    similar), or else "unknown".
  - Permissions stay at VRM's most restrictive values: only the author, personal
    non-profit use, no redistribution, no modification.
  - `<name>.license.txt` holds the comment and terms files from R2. The comment
    is also written into the file's metadata (Q1).
- **R9 Report.** Like the VRChat path's report, in plain language:
  - the humanoid bones mapped, expressions, morph targets, spring chains, joints
    and colliders;
  - every dropped feature with its count;
  - missing textures;
  - warnings such as look-at left out.

  Missing or unreadable textures do not stop the conversion: the material is
  written untextured and named in the report. PNG, JPEG, BMP, TGA and DDS (DXT1,
  DXT3, DXT5 and uncompressed) are read.
- **R10 Animama: springs without ambient forces.**
  - Files from this converter carry a marker (Q4).
  - Under the Automatic wind setting, Animama adds no wind, updraft or
    zero-gravity baseline to the springs of a marked Avatar, as it already does
    for Mochiya conversions. Diagnostics and Library import keep accepting the
    marker.
- **R11 Animama: MMD names.** Face-part detection recognises hair materials named
  in Japanese or Chinese (髪, 头发, 发, and similar) as well as by the current
  English patterns.
- **R12 Documentation.**
  - The converter's README covers converting an MMD model: terms first, the
    command, what carries over and what doesn't, and uploading.
  - Animama gains a "Converting an MMD model" page beside
    [VRChat Avatar conversion](../../frontend/runtime/vrchat-avatar-conversion.md),
    with the same licence-first rules.
  - Where Animama points users to it is Q5.

## Constraints

- **Licences.**
  - The converter stays MIT. Code taken from pmx-to-vrm (MIT) keeps its copyright
    notice.
  - No code from GPL projects (MMD Tools, VRMify) or unlicensed ones
    (yomotsu/mmd-to-vrm).
  - MMD's shared toon images are not redistributed; only colour values derived
    from them are used.
- **Third-party models.**
  - No MMD model, converted file, render or shape data enters either repository,
    tests, content packages or public evidence.
  - Issues and PRs never name the test models or their authors; evidence is
    counts, timings and pass/fail.
  - Tests use synthetic PMX files written by a test-only writer.
- **No network.** The converter contains no network code; review and a CI source
  search confirm it.
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
  - morph names, group baking and material-morph binds;
  - springs with collider groups from collision masks;
  - look-at left out for split eye meshes;
  - no file without terms acknowledgement;
  - never overwriting, and exit codes.
- [ ] **Private corpus.** At least five MMD models whose terms allow personal
  conversion each convert. Together they cover:
  - D-bone and plain rigs;
  - group, bone and UV morphs;
  - custom toon textures;
  - non-PNG textures;
  - a PMX 2.1 file.

  Each output:
  - passes `validate_vrm_stream`;
  - shows in `vrm:inspect` all the model's vertex morph names, no `none` under
    blink and visemes, and MMD-played mood regions where the model has the
    standard morphs.

  Evidence: counts only.
- [ ] **Owner manual check.** In Animama's chat, converted models show:
  - toon shading and outlines;
  - springs that hang at rest and move with Gestures without blowing out;
  - faces and visemes that play;
  - eyes that follow the cursor where look-at was written.
- [ ] **Platforms.** The command runs on macOS and on Windows. Evidence: one
  conversion each, counts only.
- [ ] **Terms gate.** Declining the terms prompt, or running without a terminal
  and without `--accept-terms`, writes no file.
- [ ] **Animama.** Unit tests show that a marked Avatar gets no ambient forces and
  that an MMD-named hair material is found as hair. The marked file survives
  `vrm:optimize` and Library export and import.
- [ ] **Docs.** The converter README and the Animama page describe the shipped
  behaviour.

## Open questions and decisions

- **Q1 How strict the terms gate is.** Proposed (R2): show the terms and require a
  per-model acknowledgement, with highlighted phrases but no automatic refusal.
  - The README says not to convert official game-company models that are marked
    for video production only. The official miHoYo and Kuro models on 模之屋 carry
    that flag.
  - The model's comment is also written into the VRM's `thirdPartyLicenses`
    metadata (trimmed), so the terms stay with the file.
  - Alternative: refuse when highlighted phrases are found unless the user passes
    an override.
- **Q2 Morph scope in v1.** Proposed: vertex, group, material and bone morphs (R5).
  UV, flip and impulse morphs are dropped and reported.
  - Bone morphs are baked by skinning at full weight, which is approximate for
    large rotations.
  - Alternative: drop bone morphs too in v1.
- **Q3 Implementation basis.** Proposed: port pmx-to-vrm's design and code to
  TypeScript inside the converter's npm package, with no runtime dependencies.
  Keep the PMX code a separate module that an in-app importer could reuse.
  - An evaluation on 2026-11-25 converted a fan-made test model (69k vertices, 15
    materials, 679 bones, 459 rigid bodies) in under a second.
  - The output passed `validate_vrm_stream` and `vrm:inspect`, and showed toon
    shading in Animama's chat lighting.
  - Its gaps are what R4, R5 and R8 add:
    - by default it kept only the standard morphs;
    - every material got the same shadow colour;
    - outlines were lit;
    - a material morph was dropped;
    - it could not read the author from a Chinese comment.
  - Alternatives: ship pmx-to-vrm's .NET binary, which needs a .NET runtime or
    per-platform binaries; or write from scratch.
- **Q4 Marker for R10.** Proposed: an `ANIMAMA_avatar_conversion` extension listed
  in `extensionsUsed`, recording the source format and converter version.
  - It must be added to the loader's loadable list, the package import list and
    `vrm:optimize`'s safe list, as Mochiya's extension was.
  - Alternative: recognise the converter's `asset.generator` string. That needs
    no allowlist changes, but it is free text that other tools overwrite.
  - Either way, the evaluation showed that the hair blew sideways and the skirt
    ballooned with ambient forces on, and hung naturally with them off.
- **Q5 How Animama points to the converter.** Proposed: the documentation page and
  one line under Create Anima's **Upload VRM** that links the converter's README
  for MMD models. The picker keeps accepting only `.vrm`.
  - Alternative: documentation only.
- **Q6 Importing inside the app.** Proposed: out of scope. Reconsider after the
  release, with evidence of demand. It would reuse Q3's module, need a zip or
  folder upload, and show the same terms acknowledgement in the app.

## Spec

This document (draft). The owning issue will be created when implementation is
authorized.

## ExecPlan

Required: the work spans two repositories (the converter and Animama), a new
conversion path, a public distribution channel and verification on two
platforms. To be written as `pmx-conversion-execplan.md` beside this spec once
the spec is agreed.

## Delivery links

None yet. Related: #925 (load-time toon shading for unlit-only files, PR #926).
