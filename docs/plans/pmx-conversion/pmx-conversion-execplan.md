# Convert MikuMikuDance (PMX) models to VRM for Animama

Source agreement: https://github.com/raymond-van/animama/issues/927, published
2026-11-25T17:13:57Z from the spec agreed by the owner that day, including the
same-day Q3 amendment (D1). Snapshot: [pmx-conversion-spec.md](pmx-conversion-spec.md).
Authorized scope: Phases 1–6 (owner, 2026-11-25: "Authorize all phases"). The
owner gates G1–G4 below apply inside the phases; merge, release and publication
approvals stay separate.

## Purpose and context

The spec asks for one command, `npx animama-avatar-converter <model.pmx>`, that
turns an MMD model into a VRM 1.0 file Animama renders and animates as close to
the model as possible, without Unity or Blender (R1–R9). It also asks Animama to
recognise and handle these files (R10–R12).

This plan delivers that in six phases:

- **Converter, Phases 1–4:**
  1. reading and writing;
  2. materials;
  3. face morphs and emotions;
  4. physics and look-at.
- **Animama, Phase 5:** the marker, the springs exemption, MMD hair names, the
  Create Anima line and the docs page.
- **Converter, Phase 6:** release preparation and verification.

The converter's existing VRChat path (Unity package and command) is untouched.

### Repositories and working directories

| Repository | Checkout | Branch | Contents |
| --- | --- | --- | --- |
| `raymond-van/animama` | a task worktree for this plan | `feat/pmx-conversion` (from `origin/main` `db603bcfe`) | this plan and the spec, Phase 5 |
| `raymond-van/animama-avatar-converter` | a task worktree of the converter | `feat/pmx-conversion` (from `origin/main` `0b24f4e`, release 0.1.1) | Phases 1–4 and 6 |

This plan records the converter's steps and evidence too, as the VRChat export
plan did: that repository has no planning setup, and this work serves this spec.
Converter commits are cited by SHA here. Nothing in the converter refers to this
plan.

Private test material lives outside every repository (written `<private>`
below): MMD models, converted files, reports and renders. Evidence from it is
counts, timings and pass/fail only; the models and their authors are never
named.

### Current code

**Converter** (`0b24f4e`):

- `cli/main.mjs`: the command.
  - It finds Avatar prefabs in a Unity project, adds the Unity package to the
    project and runs Unity in batch mode.
  - Exit codes: 0 written or validated, 2 cannot convert, 1 otherwise.
  - It never overwrites a file.
- `cli/args.mjs`: options, with one positional argument (the prefab). Unknown
  options are errors.
- Tests are `cli/*.test.mjs` and `scripts/*.test.mjs` under `node --test`
  (`npm test`). CI runs them on Ubuntu and Windows with Node 22.
- `scripts/check.mjs`, run in CI and before release:
  - the versions of `package.json` and the Unity package agree;
  - dependency pins agree;
  - no network code (`NETWORK_CODE` patterns per file type) in the package or the
    command.
- `package.json` publishes only `cli/*.mjs` (tests excluded) and has no
  dependencies.

**Reference implementation:** GoldenCarrotMLP/pmx-to-vrm at `43ce9eb`, MIT.
About 190 KB of C#; its notice must be kept with ported code.

| Area | Files |
| --- | --- |
| Reading | `Pmx/PmxReader.cs`, `Pmx/PmxModel.cs` |
| Images | `Images/Decoders.cs` (BMP, TGA, DDS), `Images/Png.cs` |
| glTF | `Gltf/GltfBuilder.cs` |
| Conversion | `Convert/Converter.cs` (space, T-pose, mesh), `Humanoid.cs`, `Materials.cs`, `Expressions.cs`, `MorphBaker.cs`, `Physics.cs`, `Vrm.cs`, `Names.cs` |
| Tests | `tests/…/PmxWriter.cs` and `SyntheticModel.cs`: a test-only PMX writer and a small MMD-style humanoid |

**The 2026-11-25 evaluation** (summarised in the spec, Q3) built `43ce9eb` with
.NET 10 and converted a fan-made test model in 0.6 s. The output passed
`validate_vrm_stream` and `vrm:inspect`.

**Animama** (`db603bcfe`):

- **Ambient forces:** `src/frontend/web/src/lib/avatar/spring-bone/SpringBonePhysicsController.ts`.
  `springsTunedWithoutAmbientForces` returns true when `extensionsUsed` contains
  `MOCHIYA_avatar_composition`. Ambient forces are then off.
- **Extension allowlists** that name Mochiya's extensions:
  - `src/frontend/web/src/lib/avatar/diagnostics/avatarGltfExtensions.ts`
    (`LOADABLE_GLTF_EXTENSIONS`);
  - `src/backend/animama/app/services/content_package_capabilities.py`
    (`_GLTF_EXTENSIONS`, used by Library package validation);
  - `src/frontend/web/scripts/vrm-optimize/optimize.mjs`: the safe list, plus
    `JSON_ONLY_EXTENSIONS` for extensions that must not point into the binary.
- **Upload validation:** `validate_vrm_stream` in `content_gltf.py` does not
  restrict `extensionsUsed`, so a marked file already uploads on today's Animama.
- **Hair:** `src/frontend/web/src/lib/avatar/vfx/faceParts.ts`.
  `HAIR_NAME_PATTERN = /hair|bang|fringe/i` is matched against material, object
  and node names.
- **Own face parts:** `ownFaceNames` in `arkitFaceExpressions.ts` counts a name as
  the model's own when it is a morph target or an expression the file authors.
  So a file that authors expressions named `Fcl_BRW_Sorrow`, `Fcl_EYE_Sorrow`
  and `Fcl_MTH_Sorrow` gives Animama per-region moods (spec R5), and
  `registerMmdFace` then leaves those regions to the file.
- **Create Anima:** `src/frontend/web/src/ui/create-anima/CreateAnimaAvatarStep.tsx`.
  The file input accepts `.vrm`; its text comes from the `create` i18n namespace.
- **Docs:** `docs/frontend/runtime/vrchat-avatar-conversion.md` is the sibling
  page; `docs/frontend/README.md` indexes the runtime docs.

## Progress

- [x] Decision D1 (owner, 2026-11-25): JavaScript with JSDoc types.
- [x] Plan review and phase authorization (owner, 2026-11-25: Phases 1–6).
- [x] Workspace: issue #927 published; Animama branch pushed.
- [x] Phase 1: reading, skeleton and writing (converter `190eace`; review passed after two repair rounds; hosted CI on raymond-van/animama-avatar-converter#4).
- [x] Phase 2: materials (converter `fe7c757`; review passed after one repair round).
- [x] Phase 3: face morphs and emotions (converter `b0ee627`; review passed after two repair rounds).
- [x] Phase 4: physics and look-at (converter `49e9729`; review passed after one repair round and a trivial repair).
- [x] Phase 5: Animama recognises converted MMD models (Animama `879bf6e91`; high-risk review, fixes verified by the final integration review).
- [x] Phase 5 follow-up, converted Avatars' brightness (owner request, 2026-11-26): Animama `484572619` and `de7ab9213`, after merging `origin/main` (`0a9026d87`); review passed after one repair round.
- [ ] Phase 6: release preparation and verification. Steps 1–4 and the macOS run are done (converter `de6efd7`, `b51a0f4`, `4c7442f`; G1 met by a five-model corpus); G2 (Windows), G4 and G3 wait for the owner.
- [x] Final integration review (one repair round; the full checks ran on the final candidates).

## Surprises & Discoveries

From the investigation and evaluation of 2026-11-25:

- **Ambient forces:** with Animama's wind, updraft and zero-gravity baseline, the
  converted test model's hair blew sideways and its skirt ballooned for at least
  8 s. A copy marked with Mochiya's extension hung naturally.
- **pmx-to-vrm's defaults:**
  - it kept only the 13 standard morphs (`--all-morphs` keeps all of them);
  - it gave every material shade 0.8 and lit outlines;
  - it dropped the test model's material morph;
  - it read no author from a Chinese comment.
- **Eye skinning (corrected in Phase 4):** the investigation said the test model's
  iris was skinned partly to bones beside the eye bones. Those pupil and
  highlight joints are in fact children of 瞳左/瞳右, under the eye bones, so
  plain bone look-at turns the eyes whole.
- **No TypeScript from npm:** Node strips TypeScript types only outside
  `node_modules`, so an npm package run by `npx` cannot ship `.ts` sources
  without a build step (D1).
- **Library sharing:** packages and `vrm:optimize` reject extensions they do not
  list, so a marked file needs Phase 5 before Library sharing and optimizing
  accept it.

From the five-model evaluation of 2026-11-26 (private renders; counts only):

- **Brightness:** converted faces rendered about a tenth darker than their MMD
  references under enhanced rendering. Fixed by the brightness follow-up in
  Phase 5.
- **Expressions:** on all five models, blink, both winks on the correct side,
  the five visemes and the five moods are visible at full weight. One model's
  brow, eye and mouth morphs each turn its ears with bone morphs. Its sad and
  angry moods combine two or three of them, and the baked targets add linearly,
  so the ears swing out flat and stretch. Converter follow-up: bake a mood's
  parts together when two or more move the same bones.
- **Avatar Effects:** 70 of 75 renders (15 Included effects × 5 models) pass
  `effects:render`'s check; all head, chest, sticker, silhouette and emote effects
  land correctly. Animama follow-ups:
  - mouth art scales to MMD's small mouths and falls under the size bar on three
    models;
  - two models lay opaque, skin-coloured meshes over the cheeks and around the
    eyes, which hide face paint beneath them;
  - eye effects close the eyes but cannot hide MMD lashes and lid lines, which
    sit in shared or differently named meshes, so the closed lash line shows
    under heart eyes on all five.

## Decision Log

- **2026-11-25, owner (spec):**
  - no terms check;
  - aim for the best experience in Animama: emotions on every region, look-at
    wherever possible;
  - Q2–Q6 as proposed: bone morphs converted; a port of pmx-to-vrm with no runtime
    dependencies; an `ANIMAMA_avatar_conversion` marker; a docs page and one
    Create Anima line; no in-app import.
- **2026-11-25, agent:** record the converter's steps in this plan, following the
  VRChat export plan, because the converter has no planning setup.
- **2026-11-25, agent:** give Animama per-region moods by writing VRoid-named
  region expressions (`Fcl_<BRW|EYE|MTH>_<Mood>`) over the model's morphs,
  besides the five presets. Animama already treats authored expressions with
  those names as the model's own parts, so this needs no Animama change and no
  extra morph data. Other VRM apps ignore them.
- **2026-11-25, agent (Phase 3):** every converted morph is also a custom
  expression; `--expression` overrides keep a mood's preset, `Fcl_ALL_` part and
  regions in step and write neutral faces as empty expressions; a faded material
  is BLEND and one only ever shown fully is MASK (details in the Phase 3 record).
- **2026-11-25, agent (Phase 4):** collider groups follow MMD collision groups;
  physics on a humanoid bone is left off; a bone beside the eye is moved under it
  only when it hangs from the head and skins only the eye; eye vertices that also
  follow the head stretch as in MMD (details in the Phase 4 record).
- **2026-11-25, agent (Phase 5):** the marker means "springs tuned without
  ambient forces" and Animama checks only its presence; the hint's ship order
  (converter 0.2.0 published right after the Animama merge, before a build with
  the hint reaches users) is for the owner at G3.
- **2026-11-26, owner:** after comparing #926's Automatic toon shading with the converted test model, "Yes, add the
  lift": Animama raises converted files' MToon colours by #926's gain.
- **2026-11-26, agent (brightness):**
  - the gain applies under every Materials setting, because the setting is not offered for these files;
  - the enhanced VRoid retune skips marked files;
  - `origin/main` is merged into the branch to build on #926: an ordinary merge, no rebase or force-push.
- **D1, decided 2026-11-25 by the owner:** write the PMX module as JavaScript ES
  modules (`.mjs`) with JSDoc types, like the rest of the command.
  - There is no build step and no new dependency, and Animama can import the module
    later.
  - This replaces the spec's "TypeScript" (Q3, amended the same day).
  - The alternative, `.ts` compiled with `tsc` before packing, would have added a
    dev dependency, a build step in CI and release, and compiled files in the
    package.

## Phased implementation

Starting revisions:

- Converter phases start from `0b24f4e`.
- Phase 5 starts from `fc9a2fae6` in Animama, or that branch rebased on the
  current `origin/main` before the phase starts. Record the base used.

Each phase commits on its repository's `feat/pmx-conversion` branch with phase
commits `feat(pmx)[p#]: …` in the converter and `feat(avatars)[p5]: …` in
Animama.

Phases 1–4 run in order: each builds on the previous module. Phase 5 depends only
on the marker's name, so it may run alongside Phases 2–4. Phase 6 needs all of
them.

Shared checks for converter phases, from the converter checkout:

- `npm test`
- `node scripts/check.mjs`
- converting the synthetic fixtures: `node cli/main.mjs <fixture>.pmx --out <tmp>/<name>.vrm`

Shared checks for Animama, from `src/frontend/web`:

- `pnpm -s vrm:inspect <file>`
- the backend upload validator, from the Animama root:
  `uv run --frozen python -c "import os,sys; from animama.app.services.content_gltf import validate_vrm_stream as v; f=sys.argv[1]; print(v(content=open(f,'rb'), size_bytes=os.path.getsize(f))[0])" <file>`

Private-model runs repeat the same commands on `<private>` files and record
counts only.

### Phase 1: reading, skeleton and writing

Review tier: standard. A new module and a new command path; no packaging change
yet.

Requirements: R1, R2, R3; R8; the marker of R10 (writing only); constraints on
licences, no network and performance.

Steps:

1. Add a `pmx/` module beside `cli/`, porting from pmx-to-vrm and keeping its
   MIT notice in `pmx/LICENSE-pmx-to-vrm` and the README's licence section:
   - **Reader:** PMX 2.0 and 2.1, both text encodings, all index sizes; BDEF1,
     BDEF2, BDEF4, SDEF as BDEF2, QDEF as BDEF4; additional UVs ignored.
   - **Textures:** resolved relative to the `.pmx`, ignoring case and either path
     separator. PNG and JPEG are copied; BMP, TGA and DDS (DXT1, DXT3, DXT5,
     uncompressed) are decoded to PNG through `node:zlib`. Unreadable files are
     reported and the material is written untextured.
   - **Space:** ×0.08, Z mirrored with the triangle winding reversed, lowest
     vertex at y = 0.
   - **Humanoid map:** standard names normalised with NFKC; D-bones when present;
     hips as the deepest common ancestor of 上半身 and both legs, with only its
     pivot moved. Simulated bones are never human bones. A missing required bone
     stops the conversion with exit 2.
   - **T-pose bake** (unless `--keep-pose`): rotate the upper arm, forearm and
     hand onto ±X and bake the rotation into descendants, vertices, morph offsets
     and rigid bodies. Nodes carry translation only.
   - **GLB writer:** one mesh with a primitive per PMX material; a skin over every
     bone; morph targets as sparse accessors; VRM meta (R8: name and author from
     the options, the PMX name and credit lines; restrictive permissions); and
     `ANIMAMA_avatar_conversion` `{ "source": "pmx", "converter": "<version>" }`
     in `extensions` and `extensionsUsed`.
   - **Placeholder materials:** plain MToon, filled in Phase 2.
2. **The command:** `cli/main.mjs` sends an argument ending in `.pmx` (any case)
   to the PMX path, which needs no Unity project.
   - It accepts `--out`, `--name`, `--version`, `--author`, `--copyright`,
     `--keep-pose` and `--validate`, and rejects the Unity-only options with a
     clear message.
   - It writes to a temporary file beside the output, then renames it, refusing
     an existing output first.
   - It prints the R9 report (sections fill in over Phases 2–4).
   - Update `USAGE` for both paths.
3. **Tests:** port the test-only PMX writer and the synthetic humanoid to
   `pmx/testing/`. Add `pmx/*.test.mjs`, which `npm test` includes:
   - reader round trips in both encodings;
   - each texture decoder;
   - the humanoid map with and without D-bones;
   - hips;
   - the T-pose, where every node rotation is identity;
   - a missing required bone gives exit 2;
   - never overwriting, and no partial file after a failure;
   - the marker is present.
4. **Network check:** extend `scripts/check.mjs` so its no-network scan covers
   `pmx/`.

Checks:

- The shared converter checks.
- `vrm:inspect` and the backend validator on the synthetic fixture's VRM and on
  the private test model's VRM.
- Conversion time of the private test model (target: under 30 s).

Completion: the tests pass on the local machine and in CI (Ubuntu and Windows),
and both VRMs pass the validator and load in `vrm:inspect` with every humanoid
bone mapped.

Check record (converter checkout, macOS, Node 24.15; trees are working-tree hashes before the phase commit):

| Check | Directory | Tree | Result |
| --- | --- | --- | --- |
| `npm test` | converter root | `fed6247e` | 77 pass, 0 fail |
| `node scripts/check.mjs` | converter root | `fed6247e` | OK, 57 sources |
| synthetic fixture: `node cli/main.mjs <tmp>/model.pmx`, then the backend `validate_vrm_stream` and `pnpm -s vrm:inspect` (Animama `src/frontend/web`) | converter root, Animama | `fed6247e` | written (0.02 MB); accepted; VRM 1.0, 2 MToon, 4 named morph targets |
| private model (69k vertices, 679 bones): conversion, validator, `vrm:inspect`, `avatar:parity-render` | converter root, Animama | `fed6247e` | 68 ms, 15.9 MB; accepted; 53 human bones, 40 named morph targets; T-pose render correct |
| `npm test` | converter root | `e28e3107` | 84 pass, 0 fail |
| `node scripts/check.mjs`; `npm pack --dry-run` | converter root | `e28e3107` | OK, 58 sources; 15 `pmx/` files, no tests |
| private model conversion and validator | converter root, Animama | `e28e3107` | written, accepted |
| Hosted CI (Ubuntu, Windows) | — | — | not run yet: runs on the converter PR |

#### Code Review #1 Findings

Reviewed `fed6247e` against `0b24f4e`, standard tier, by an independent read-only agent (the repository's
`sdlc-reviewer` definition is not available to sessions started in the converter checkout, so a general agent
ran with the same brief). It reran `npm test` and `check.mjs` and a structural GLB checker on the synthetic
output (alignment, accessor bounds, sparse indices, bind matrices: no problems).

- P1-F1 (blocking): `package.json` `files` left out `pmx/`, so the published command failed to start
  (`ERR_MODULE_NOT_FOUND`), and the pmx-to-vrm notice would not ship.
- P1-F2 (blocking, security): texture paths were followed from the filesystem root and through unlimited `..`,
  so a model could make the converter read any image on disk, or open an SMB share on Windows (UNC path).
- P1-F3: negative four-byte vertex indices passed the reader's range checks.
- P1-F4: NaN floats in the file propagated into positions, bind matrices, morph offsets and colours.
- P1-F5: `--validate --out x.vrm` wrote the file.
- P1-F6: BMP palette size, BMP/TGA/DDS image sizes and PNG inflate output were trusted before allocation
  (a 70-byte BMP exhausted memory).
- P1-F7: `guessAuthor` took plain words after English credit keys as authors, and line order beat key priority.
- P1-F8 (optional): huge declared counts allocated before failing.
- P1-F9 (optional): every BMP/TGA/DDS was re-encoded eagerly at deflate level 9.
- P1-F10 (optional): a stale header comment, an incomplete report type, unused exports, the README's missing
  PMX section, and no licence reminder on the PMX path.
- P1-F11 (optional): a narrow window in which `rename` could overwrite a file that appeared meanwhile.

#### Code Review #1 Revisions

- P1-F1 fixed: `files` adds `pmx/*.mjs`, `!pmx/*.test.mjs` and `pmx/LICENSE-pmx-to-vrm`; `npm pack --dry-run`
  lists 15 `pmx/` files and no tests.
- P1-F2 fixed: absolute, drive and UNC paths use only their file name inside the model's folder; `..` may go one
  folder above the model at most; the resolved file's real path must stay inside; tests cover each case,
  including a symlink leading out.
- P1-F3 fixed: indices below 0 are rejected for faces and vertex and UV morph parts; test added.
- P1-F4 fixed: the reader reads non-finite floats as 0; test added.
- P1-F5 fixed: validation ignores `--out` and writes nothing; test added.
- P1-F6 fixed: images above 8192² are refused; the BMP palette is capped; BMP, TGA and DDS check their data
  length before allocating; PNG inflate is bounded by the size its header implies; tests added.
- P1-F7 fixed: credit keys are tried in priority order, English keys need a colon (or "… by"); the VRM name falls
  back to the file name, then "unknown"; tests added.
- P1-F8 fixed: counts are checked against the bytes left; test added.
- P1-F9 fixed: textures are read, decoded and re-encoded only when a material uses them, at the default level.
- P1-F10: comment, type and usage fixed and unused exports removed. The README's PMX section is Phase 6 work.
  The licence reminder is rejected: the owner decided on 2026-11-25 that the PMX path shows no terms (spec Q1).
- P1-F11 fixed: the VRM gets its name through a hard link, which fails rather than overwrite, with a
  check-and-rename fallback where hard links are unsupported.

#### Code Review #2 Findings

Repair round 1 on `e28e3107`. The reviewer reran `npm test` (84 pass), `check.mjs`, a packed-install run and
reproductions for each finding. Resolved: P1-F1–F5 and F7–F11. Not resolved: P1-F6 (a BMP with a negative depth
or offset and a TGA with depth 0 still bypassed the size checks). New:

- P1-F12: textures were reported missing when the model's folder is reached through a symlink.
- P1-F13: decoded pixels were kept for the whole conversion, and two spellings of one path decoded twice.
- P1-F14: a generic "Model:" line beat an explicit "Author:" line.
- P1-F15: a failed write could leave the temporary `.part` file.
- Advisory on P1-F2: one folder up reaches sibling folders of the model's folder.
- Nits: header index sizes not checked; `alphaUsage` used only by tests.

Nothing blocking remained.

#### Code Review #2 Revisions

- P1-F6 fixed: BMP depths outside 1/4/8/16/24/32 and data offsets outside the header and file are refused before
  anything is allocated; TGA depths outside 8/15/16/24/32 too; test added.
- P1-F12 fixed: paths are walked from the folder's real path; test added.
- P1-F13 fixed: one record per resolved file; pixels are decoded on demand and dropped after the alpha analysis or
  PNG encoding.
- P1-F14 fixed: "author" precedes the generic "model" keys; test added.
- P1-F15 fixed: a failed write removes its `.part` file unless the file was not ours (EEXIST).
- Nits fixed: the PMX header's index sizes must be 1, 2 or 4; `alphaUsage` is used by the texture loader.
- Advisory accepted as a risk: MMD packs with several variants often share a texture folder beside the model
  folders (`../Texture/…`); the reach stays inside the model's parent folder, and the result only goes into the
  user's own VRM.
- Checks on `14fb1cde`: `npm test` 86 pass; `check.mjs` OK (58 sources); private model converts.

#### Code Review #3 Findings

Repair round 2 on `14fb1cde`: every item resolved, no regressions, nothing blocking (86 tests pass, `check.mjs`
OK, pack lists 15 `pmx/` files). Carried into Phase 2:

- an image an alias names twice is embedded twice (`gltfTextures` is keyed by PMX index);
- once materials call `alpha()`, PNGs are decoded in production; BMP, TGA and DDS would decode twice; and an
  alpha-analysis failure must not mark a texture missing.

#### Code Review #3 Revisions

No repair needed. The three Phase 2 items are recorded under Phase 2.

Result: Phase 1 complete. Commit `190eace` (`feat(pmx)[p1]: convert MMD (PMX) models to VRM 1.0 without Unity`,
tree `14fb1cde`, the reviewed tree) on the converter's `feat/pmx-conversion`, in draft PR
raymond-van/animama-avatar-converter#4 for hosted CI.


### Phase 2: materials

Review tier: standard. Behaviour inside the new module.

Requirements: R4.

Steps:

1. Port `Materials.cs`, then apply the spec's corrections:
   - **Lit colour:** the texture times `min(1, diffuse × L + ambient)` in sRGB,
     stored as linear factors. L is MMD's default light (about 0.6); confirm it
     against a reference before fixing the constant.
   - **Shade:** `shadeMultiplyTexture` is the base texture. `shadeColorFactor` is
     the dark end of the material's toon ramp:
     - the shared toon01–toon10 ramps come from a colour table in code, citing
       where the values come from;
     - a model's own toon texture is sampled at its dark end;
     - a material without a toon ramp gets a shade equal to its lit colour.
   - **Step position:** taken from the ramp, giving `shadingShiftFactor` and a
     high `shadingToonyFactor`.
   - **Outline:** from the edge flag, size and colour, with
     `outlineLightingMixFactor` 0. Choose screen-space (`edgeSize / 300`, three's
     MMD mapping) or world-space by rendering both in Animama; record the choice in
     the Decision Log.
   - **Matcap:** `.spa` becomes `matcapTexture`.
   - **Transparency:** `BLEND` with `transparentWithZWrite` and
     `renderQueueOffsetNumber` in PMX material order; `MASK` for hard alpha;
     `doubleSided` from flag 0x01.
   - **Report:** count `.sph` maps, sub-texture spheres, non-zero specular and
     vertex edge scales other than 1.
2. **Tests:**
   - shared and custom toons;
   - toon-less materials;
   - outline on, off and colour;
   - each alpha case and the draw order;
   - matcap.

Checks:

- The shared converter checks.
- Private renders of the test model in Animama, against the Phase 1 output and
  the pmx-to-vrm baseline: `pnpm -s effects:render <an Included Avatar Effect> --avatar-file <private>.vrm --views front,three-quarter,face --out <private>`
  and `pnpm -s avatar:parity-render --avatar-file <private>.vrm --out <private>`.
  Record observations only.

Completion: the tests pass; skin shadows are warm where the ramp is; eyes are
unshaded; outlines are dark and unlit; transparent layers draw in order in the
private renders.

Check record (converter checkout, macOS, Node 24.15):

| Check | Tree | Result |
| --- | --- | --- |
| `npm test`; `node scripts/check.mjs` | `a20d1d76` | 95 pass; OK, 59 sources |
| private model: conversion, material dump, backend validator, chat-lighting render (`effects:render` with a scene effect, since the face needs Phase 3's expressions) | `a20d1d76` | accepted; skin and face shadows warm (toon02), hair and cloth toon01 grey, eyes unshaded, unlit screen-space outlines 0.00185 for edge size 0.5, two semi-transparent cloth materials blended in PMX order |
| `npm test`; `node scripts/check.mjs`; private model | `7622a129` | 100 pass; OK; converts |
| `npm test` after the trivial JPEG-toon wording repair | `9bbdf9d5` | 100 pass |

Decisions made in this phase (agent, within the agreed scope):

- **Lit colour and toon multiply:** they follow nanoem as ported by mdanceio
  (MIT, `model_color.wgsl`, `model.rs`), whose default light is 154/255.
- **Outline:** screen-space at 0.0037 × edge size. That is MMD's edge formula at
  its 30° field of view, calibrated to three-vrm's NDC offset. The MToon spec calls
  the factor a ratio of the screen height and UniVRM doubles it, so UniVRM-based
  viewers draw it twice as wide. That is recorded rather than halving Animama's
  outlines.
- **Shared toon values:** read from column 0 of three.js's embedded ramps;
  toon07–toon10 are placeholders there (white).

#### Code Review #1 Findings

Reviewed `a20d1d76` against `190eace`, standard tier, by an independent read-only agent. It confirmed the colour,
toon and shading formulas against mdanceio and the MToon 1.0 spec, and the shared-toon offsets. Nothing blocking.

- P2-F1: a material hidden at rest (alpha 0) wrote depth and could hide later transparent materials.
- P2-F2: the outline width matches MMD only in three-vrm; UniVRM doubles it.
- P2-F3 (optional): ramps were read from the middle column, and a highlight band was taken for the shadow's
  start (toon05 and toon06 entries too wide).
- P2-F4 (optional): an undecodable own toon was dropped silently.
- P2-F5 (optional): stale report wording; an unshipped `toon0.bmp` was reported missing.
- P2-F6 (optional): toon07–10 are placeholders, not MMD's values.
- P2-F7 (optional): missing tests (undecodable PNG embeds), edge scale over-counted, translucent edges unreported.

#### Code Review #1 Revisions

- P2-F1 fixed: only blended materials with alpha above 0 write depth and take a render-queue slot; test added.
- P2-F2 kept as a recorded decision; the module comment states the calibration and the UniVRM difference.
- P2-F3 fixed: column 0, shadow found from the bottom up to the nearest lit row; toon05 and toon06 re-derived
  (20/32–24/32 and 22/32–26/32); test added.
- P2-F4 fixed: a report warning names the toon; test added.
- P2-F5 fixed: wording; unshipped `toon0.bmp`/`toon00.bmp` mean no toon; test added.
- P2-F6 fixed: the comment calls them placeholders, a known gap.
- P2-F7 fixed: the tests and both counts.

#### Code Review #2 Findings

Repair round 1 on `7622a129`: all seven resolved, no regressions, nothing blocking. Nits: a JPEG toon's warning gave
no reason; single-digit `toon1.bmp` maps to the shared ramp; a single-colour ramp yields shift −1 (no visible
effect).

#### Code Review #2 Revisions

The JPEG wording was a trivial repair, verified by `npm test`; the other two nits change nothing visible and were
left. Result: Phase 2 complete. Commit `fe7c757` (`feat(pmx)[p2]: draw PMX materials with MToon the way MMD shades
them`, tree `9bbdf9d5`) on the converter's `feat/pmx-conversion`, pushed to raymond-van/animama-avatar-converter#4.

### Phase 3: face morphs and emotions

Review tier: standard. The largest new behaviour; it has its own phase so the
heuristics get a focused review.

Requirements: R5, and R9's preset listing; R1's override option.

Steps:

1. **Every morph:**
   - every vertex morph is a named morph target;
   - group morphs made only of vertex and bone parts are baked into a target named
     after the group;
   - other group morphs become a custom expression;
   - bone morphs are baked by skinning the bind pose at weight 1 (linear-blend
     approximation);
   - material morphs become `materialColorBinds` (`color`, `shadeColor`,
     `outlineColor`). Find why pmx-to-vrm dropped the test model's material morph,
     and keep a material that a morph reveals hidden at weight 0 (`MASK` with
     alpha 0);
   - a UV morph that offsets every vertex of one material equally becomes a
     `textureTransformBind`;
   - other UV morphs, and flip and impulse morphs, are counted in the report.
2. **Understanding the morphs:**
   - **Meaning:** a table of standard MMD names, normalised with NFKC to cover
     half-width and numbered variants, plus common English, Chinese and Korean
     names for the same meanings.
   - **Region:** the PMX panel (1 brow, 2 eye, 3 mouth). When the panel is "other"
     or wrong, use the vertices the morph moves, measured against the eye bones
     and the mouth area.
   - **Wink side:** from the moved vertices' x.
3. **Composing the expressions:**
   - **Presets:** blink, blinkLeft, blinkRight, aa, ih, ou, ee, oh, and the five
     emotions, each region by region.
   - **Fallbacks:** for regions without a standard morph, use the closest suitable
     morph, for example 口角下げ for sad mouth, a lowered-lid or tearful eye morph
     for sad eyes, and ∧ or 口角下げ for angry mouth. Leave the region neutral when
     nothing fits.
   - **Region expressions:** write `Fcl_BRW_<Mood>`, `Fcl_EYE_<Mood>` and
     `Fcl_MTH_<Mood>` for each region with a morph (Decision Log), so Animama plays
     moods by region.
4. **Overrides:** `--expression <name>=<morph>[*<weight>][+<morph>…]`, repeatable,
   for a preset or a region expression. It replaces the composed binds and is
   echoed in the report.
5. **Tests:**
   - synthetic models with Japanese, English and Chinese morph names;
   - a group morph with a bone part;
   - a bone morph;
   - a material morph that reveals a hidden layer;
   - an even and an uneven UV morph;
   - presets and region expressions, with fallbacks and a neutral region;
   - wink sides;
   - overrides.

Checks:

- The shared converter checks.
- On the private test model, `vrm:inspect`'s "mood faces" must show the model's
  own parts or MMD for every region where it has a suitable morph, and no `none`
  for blink and visemes.
- Private face renders per mood: `--expression <preset>` with `effects:render`.

Completion: the tests pass, and the private model shows every mood region it can.

Check record (converter checkout, macOS, Node 24.15):

| Check | Tree | Result |
| --- | --- | --- |
| `npm test`; `node scripts/check.mjs` | `7e041c0b` | 116 pass; OK, 63 sources |
| private model: conversion, report, Animama `vrm:inspect` | `7e041c0b` | all five moods composed by region (happy にこり/笑い/にっこり, relaxed にこり/なごみ/にっこり, sad 困る/じと目×0.5/口角下げ, angry 怒り/じと目/∧, surprised 上/びっくり/お); inspector: every mood region "vroid", face skin found |
| private model with `--expression "sad=困る+口角下げ*0.6"` | `7e041c0b` | sad: brows 困る, eyes —, mouth 口角下げ×0.6 |
| `npm test`; `node scripts/check.mjs`; private model | `835b8cc5` | 123 pass; OK; moods unchanged |
| `npm test`; `node scripts/check.mjs`; private model; backend upload validator | `927a9641` | 126 pass; OK; moods unchanged; accepted |

Decisions made in this phase (agent, within the agreed scope):

- **Every converted morph is also a custom expression** under its PMX name, even one
  a preset plays. Animama plays MMD faces through registered expressions, not
  morph weights, so the duplicates are harmless, and apps that list expressions
  see every morph.
- **Overrides keep VRoid's shape:** a mood preset, `Fcl_ALL_<Mood>` and its three
  region parts always agree. Overriding a preset splits it into the regions by
  each morph's region; overriding a region recomposes its mood. A neutral
  override writes an empty expression, because Animama fills a missing part from
  the morph names. A preset and one of its regions cannot both be overridden.
- **A material a morph fades is BLEND; one revealed from alpha 0 is MASK** (the
  plan's choice, so a revealed layer writes depth). A fade of every material at
  once leaves them opaque and is reported, since blending every material would
  lose their draw order.

#### Code Review #1 Findings

Reviewed `7e041c0b` against `fe7c757`, standard tier, by an independent read-only agent. It checked bone-morph
mirroring and the T-pose conjugation numerically (X, Y and arbitrary axes, weights 0.5 and −1, a straightened
elbow, `--keep-pose`: all within 4e-8 m), group weights and cycles, out-of-range indices, and the VRM enums.

- P3-F1 (important): a whole-face morph took one region from its mean height, so a PMX made from VRoid played
  brows and mouth twice in `happy`, and a panel-4 sad group doubled `sad`.
- P3-F2 (important): texture-tint colour morphs folded into the diffuse colour only, so they barely showed; the
  toon tint was never read.
- P3-F3: a bone morph's rotation stopped at weight 1.
- P3-F4: a bone morph on a bone others inherit from (両目) moved nothing, and a duplicate-named morph's custom
  expression was dropped, both without a report line.
- P3-F5: a fade on "all materials" made every material BLEND.
- P3-F6: a layer revealed from alpha 0 was BLEND without depth; the plan asks for MASK.
- P3-F7: `happy=あ*` parsed as weight 0.
- Tests: the bone-morph test used a Z turn (mirroring untested), a faces test line did nothing, the CLI test title
  overstated when names are refused, and the group test only visited vertices already in the target.

#### Code Review #1 Revisions

- P3-F1 fixed: VRoid's own `Fcl_<R>_<Mood>` morphs win their slots and `Fcl_ALL_<Mood>` is the preset; a morph
  named as the whole face, or moving a second region by a fifth or more, takes no region slot; tests added.
- P3-F2 fixed: both tints multiply the lit and shade colours and the alpha, as MMD multiplies the whole colour;
  test added.
- P3-F3 fixed: weights beyond 1 and below 0 extrapolate; tested at 0.5 and 2 on a Y turn.
- P3-F4 fixed: bone morphs follow inherit-rotation and -translation bones; a duplicate gets its expression under the
  target's unique name (`あ_2`); morphs that change nothing are reported; tests added.
- P3-F5 fixed: such a fade is reported once and leaves materials opaque; test added.
- P3-F6 fixed: MASK at alpha 0 unless the texture blends; test added.
- P3-F7 fixed: an empty weight is an error, and override names are checked when the command line is parsed.
- Tests: rewritten as listed.

#### Code Review #2 Findings

Repair round 1 on `835b8cc5`, by the same agent: six of the seven fixes were confirmed by its probes. Those cover the
VRoid-made PMX, the panel-4 group, weight 2 (5e-8 m from MMD), inheritance at weights 1 and 0.5, and a cycle.

- P3-F8 (important, from P3-F6): every layer revealed from alpha 0 became MASK, so one shown only to alpha 0.4 never
  showed.
- P3-F9: the height bands are absolute, so a large eye morph reaching the brows' band counted as the whole face.
- P3-F10: the tints applied to untextured or toonless materials, which MMD leaves alone, and an added
  (brightening) tint was reported as changing nothing.
- Test gaps: no X-axis turn, inheritance only at weight 1 and for rotation, and no end-to-end whole-face name.

#### Code Review #2 Revisions

- P3-F8 fixed: MASK only when every morph that changes the layer's alpha shows it fully; test added.
- P3-F9 fixed: "ALL" needs the mouth and the eyes or brows each to hold a fifth of the movement.
- P3-F10 fixed: the texture tint needs a texture and the toon tint a toon; brightening tints are reported as
  such, since VRM colours can only darken; test added.
- Tests: X, Y and Z turns; inheritance at 0.5, with translation; `Fcl_ALL_Joy` end to end.

Result: Phase 3 complete. Commit `b0ee627` (`feat(pmx)[p3]: turn MMD face morphs into VRM expressions and moods`,
tree `927a9641`) on the converter's `feat/pmx-conversion`, pushed to raymond-van/animama-avatar-converter#4.

### Phase 4: physics and look-at

Review tier: standard. Behaviour inside the new module.

Requirements: R6, R7, and R9's spring and look-at sections.

Steps:

1. **Physics:** port `Physics.cs`.
   - Simulated bodies become spring joints along the bone chains. A branch starts
     its own spring, and each chain ends on a tail node.
   - Bodies on body bones become colliders; a box becomes a capsule along its
     longest axis.
   - Collider groups come from each body's MMD collision group and mask.
   - Joint parameters use pmx-to-vrm's documented formulas; tune them on the
     private models in Phase 6.
   - Report the chains, the cross-chain joints and the joints that start inside a
     collider.
2. **Look-at, tried in order:**
   1. **Bone:** when 左目/右目 and the bones below them skin every vertex of the
      eye parts, write bone look-at with the offset between the eyes. Eye parts
      are the primitives, or vertex sets within a primitive, that the eye bones
      skin.
   2. **Re-parented bone:** some eye-part vertices may be skinned to bones that are
      neither the eye bones nor below them, but lie within the eye's bounds and
      skin only eye-part vertices (separate pupil or highlight bones). Re-parent
      those bones under the matching eye bone, keeping their rest transforms, then
      write bone look-at.
   3. **Expression:** when no eye bones can drive the eyes, synthesize `lookUp`,
      `lookDown`, `lookLeft` and `lookRight` morph targets by rotating each eye
      part's vertices about its centre by the VRM range-map output angle. Write
      look-at of type `expression`.
   4. **None:** eyes painted on the face. Report why.
3. **Tests:**
   - a skirt colliding with the legs;
   - a branching chain;
   - each look-at path on synthetic eyes, including one skinned partly to a
     sibling pupil bone. Rotating the eye bone must move every eye-part vertex
     rigidly, within float tolerance.

Checks:

- The shared converter checks.
- Private Animama renders over time on the test model: `effects:render … --times 1,3,8`.
  Springs must hang and settle. Until Phase 5 lands, render a private copy that
  also lists Mochiya's marker, as in the evaluation, so Animama skips ambient
  forces.
- A look-left expression render showing the whole iris moved.

Completion: the tests pass, private springs hang, and the private model gets
re-parented bone look-at with no tearing.

Check record (converter checkout, macOS, Node 24.15):

| Check | Tree | Result |
| --- | --- | --- |
| `npm test`; `node scripts/check.mjs` | `fca69d26` | 138 pass; OK, 66 sources |
| private model: conversion and report | `fca69d26` | 57 chains, 488 joints (44 under chest, 11 under head, one per upper arm); 24 colliders in 7 MMD groups; 347 cross-chain joints reported; 19 inner-skirt chains warned for joints starting inside a collider; look-at bone ('左目', '右目') |
| private render, `effects:render` scene effect `--times 1,3,8`, Phase 5's marker in the Animama tree | `fca69d26` | hair, skirt and sleeves hang and settle; no change between 3 s and 8 s; a strap flap stands up as in the pmx-to-vrm conversion |
| private render with both eye nodes turned 10° | `fca69d26` | each iris and its highlight move whole; no tearing |
| private blush render (`effects:render` blush, face view) | `fca69d26` | blush on the cheeks: with springs, face-skin detection no longer takes the hair (the Phase 3 open question) |
| backend upload validator on the private conversion | `fca69d26` | `model/gltf-binary` |
| `npm test`; `node scripts/check.mjs`; private model; render `--times 1,3,8` | `848477ed` | 145 pass; OK; 25 colliders (the hip body added); springs still hang and settle |
| `npm test`; `node scripts/check.mjs` after the trivial stuck-count repair | `e2fda089` | 146 pass; OK |

Decisions and discoveries in this phase (agent, within the agreed scope):

- **The test model needs no re-parenting.** The investigation said half its iris
  was skinned to bones the eye bones do not move. In fact those pupil and
  highlight joints are children of 瞳左/瞳右, under 左目/右目; the first probe
  listed only direct children. The private report is corrected. The model gets
  plain bone look-at, and the re-parenting path is covered by synthetic tests.
- **What may be re-parented:** only a bone that skins eye-part vertices, sits
  within the eye's bounds (padded by a quarter of their size and 3 mm) and skins
  nothing outside the part. A first draft also took bones that merely sat near
  the eye and skinned only nearby vertices. On the test model that pulled in
  brow and eyelid bones, so it was dropped.
- **Collider groups by MMD collision group** (one per group and mask), named
  "MMD group N", instead of pmx-to-vrm's humanoid regions. Each spring uses the
  groups whose colliders it collides with both ways. Animama reads no group
  names.
- **Expression look-at** turns the eye parts 10° about the eye bones, or, for eyes
  found only by material, about a point one eye-width behind them. The range maps
  are VRM's usual 90°/10° for bones and 90°/1 for expressions, and the blinks
  block look-at so the iris does not cross a closed lid.
- **Eye vertices that also follow the head stretch, as in MMD** (P4-F10 kept): bone
  look-at is used even when some eye-part vertices are partly on the head; the
  report counts them.

#### Code Review #1 Findings

Reviewed `fca69d26` against `b0ee627`, standard tier, by an independent read-only agent with synthetic probes. It
confirmed the tail nodes after the T-pose bake, node numbering, collider offsets and capsule ends, the collision
mask direction, the look direction and pivots, `offsetFromHeadBone`, the range maps and the inverse bind matrices
after re-parenting.

- P4-F1 (important): re-parenting cut a bone off a parent that is not the head, so a bone morph on that parent
  moved nothing.
- P4-F2 (important): the standard 下半身 body counted as a chain anchor, so skirts never hit the hips.
- P4-F3 (important): the eye-material fallback missed 黒目, 眼睛 and Eye_L, and never read the English name.
- P4-F4: a simulated body on a humanoid bone (a neck) took the neck out of the humanoid, made the head a spring
  tail and dropped the head collider, silently; the warning meant for it could never fire.
- P4-F5: a lid bone whose lashes follow the eye 0.3 was moved under the eye.
- P4-F6: a pupil bone at the eyeball's centre counted as outside the eye, with the wrong reason reported.
- P4-F7: the overlap test never overlapped the two eyes' parts.
- P4-F8: a joint across a bone without physics, along one strand, was reported as between chains.
- P4-F9: eyeball materials turned about their back pole.
- P4-F10: bone look-at is used though some eye vertices follow the head (a judgement call).

#### Code Review #1 Revisions

- P4-F1 fixed: a bone is moved only when its parent is above the eye bone; each stuck bone carries its reason into
  the report.
- P4-F2 fixed: a bone with humanoid bones below it is never an anchor.
- P4-F3 fixed: more names, and both names tested.
- P4-F4 fixed: physics on a bone the humanoid needs is left off with a warning, and its body becomes a collider.
- P4-F5 fixed: a vertex belongs to an eye part only when the eye carries half its weight or more.
- P4-F6 fixed: the eye's box includes the eye bone.
- P4-F7 fixed: one vertex weighted to both eyes; sparse indices checked strictly increasing.
- P4-F8 fixed: ancestor and descendant bodies are not "between chains".
- P4-F9 fixed: a part as deep as half its width turns about its centre.
- P4-F10 kept as recorded above.

#### Code Review #2 Findings

Repair round 1 on `848477ed`, by the same agent: all nine fixes hold. It removed each fix in a copy and saw its own
new test fail. A single bone stuck on both eyes was counted twice in the report (cosmetic). Residual points to
watch in Phase 6:
- skirts may flare now that 下半身 collides (MMD turns off collision between jointed bodies; VRM cannot);
- an iris whose vertices the eye carries less than half of could be left out of an expression part;
- diagonal joints to a deeper branch are no longer reported.

#### Code Review #2 Revisions

The double count was a trivial repair (distinct bones), verified by a new test and `npm test`. The residual
points go to Phase 6's private-corpus checks. Result: Phase 4 complete. Commit `49e9729` (`feat(pmx)[p4]: turn MMD
physics into springs and give the eyes look-at`, tree `e2fda089`) on the converter's `feat/pmx-conversion`, pushed
to raymond-van/animama-avatar-converter#4.

### Phase 5: Animama recognises converted MMD models

Review tier: high risk. It changes the shared content-package contract (accepted
extensions) and the optimizer's safe list.

Requirements: R10, R11, R12 (Animama's part).

Steps, in the Animama worktree:

1. **Marker:**
   - Add `ANIMAMA_avatar_conversion` to `LOADABLE_GLTF_EXTENSIONS`, to
     `_GLTF_EXTENSIONS` in `content_package_capabilities.py`, and to
     `optimize.mjs`'s safe list and `JSON_ONLY_EXTENSIONS`.
   - Extend `springsTunedWithoutAmbientForces` to recognise it, and update its
     comment to cover both converters.
   - Update the docs that name Mochiya's marker for the wind exemption:
     `avatar-animation.md` (`SpringBonePhysicsController`) and
     `vrm-optimization.md`.
2. **Hair names:** extend `HAIR_NAME_PATTERN` to Japanese and Chinese hair words
   (髪, 頭髪, 头发, 发), so they match material, object and node names. Avoid
   false matches: 发 alone must be a whole name or a name prefix, never inside an
   unrelated word.
3. **Create Anima:** add one line under **Upload VRM** linking the converter's
   README for MMD models, in the `create` namespace for every shipped locale. The
   picker keeps `accept=".vrm"`.
4. **Docs:** add `docs/frontend/runtime/mmd-model-conversion.md` and index it in
   `docs/frontend/README.md`. It covers:
   - the command;
   - checks with `vrm:inspect`;
   - what carries over;
   - the marker and the springs exemption;
   - keeping third-party models out of repositories.
5. **Tests:**
   - unit tests for the marker (no ambient forces);
   - the extension accepted by the diagnostics list and by backend package
     validation;
   - hair names, including a false-match case;
   - the Create Anima line rendered.

Checks:

- **Tests:** targeted `pnpm web:test` and backend `uv run pytest -q` for the
  touched modules.
- **Optimizer:** `pnpm -s vrm:optimize <marked synthetic file> --out <tmp>` then
  `verify`.
- **Library sharing:** export and import of a marked Local Avatar on a disposable
  stack. Run the full `pnpm e2e:test` through the heavy-job slots, as
  AGENTS.md requires for import and export changes.
- **Full pre-push suite** first, as the high-risk tier requires.

Completion: all checks pass; a marked Avatar gets no ambient forces in Automatic;
the docs page is linked.

Base: `fc9a2fae6` on `feat/pmx-conversion` (not rebased); disposable stack `pmx` (`docker compose -p animama-pmx`). The
full pre-push suite reruns on the final candidate before the PR (Final integration).

Check record (Animama worktree, macOS):

| Check | Tree | Result |
| --- | --- | --- |
| `pnpm verify` | `19952ec8` | exit 0; 6495 tests passed |
| `pnpm prettier:check` | `19952ec8` | exit 0 |
| `make check-test` | `19952ec8` | 5736 passed, 30 skipped; mypy clean (after the worktree venv got the documented extras; the first run stopped at mypy on a missing `pptx`) |
| `pnpm -s vrm:optimize` on a marked synthetic VRM, then `verify` | `19952ec8` | equivalent; marker kept |
| backend upload validator on the converted private model (Phases 3 and 4) | `19952ec8` | `model/gltf-binary` |
| `pnpm e2e:test` through the heavy-job slots, `pmx` stack | `19952ec8` | 39 passed, 3 failed in 1.1 h: two Local Gesture discard journeys (name field not found in 10 s) and the Library's "keeps Included files between visits" (4 thumbnails fetched again) |
| `pnpm e2e:test` on those two spec files, same stack | `338dffd9` | 7 of 7 passed: the three failures were load, not this change |
| Library sharing of a marked Avatar | `1a42ec96`, `338dffd9` | backend validation and Library export/import tests parametrized over `CONVERTED_AVATAR_EXTENSIONS`, which now holds the marker (in the 687 above) |
| checks agent: vitest beside and related to the touched sources | `1a42ec96`, `338dffd9` | exit 0; 2475 passed, 2 skipped (related run on 8 sources) |
| checks agent: `node --test scripts/vrm-optimize.test.mjs` | `1a42ec96` | 11 of 11 |
| checks agent: `pnpm i18n:check` | `1a42ec96`, `338dffd9` | exit 0 |
| checks agent: backend `pytest` on 12 content-package and glTF files; `ruff check`, `ruff format --check`, `mypy` on the touched Python | `1a42ec96`, `338dffd9` | 687 passed; all exit 0 |
| checks agent: `check_source.py` (licence review) | `338dffd9` | exit 0 |
| checks agent: browser suite (`test:browser:source` through the heavy-job slot; the package rebuild skipped while e2e used the same worktree) | `338dffd9` | 140 of 141; `animation-combo.browser.test.mjs` ran at 1.166× real time against a 1.15× limit under load, then passed alone |

Decisions made in this phase (agent, within the agreed scope):

- **The marker means "springs tuned without ambient forces"**, as Mochiya's does.
  Animama checks only that it is present, and the docs say so.
- **Hair names** cover the Japanese, Chinese and Korean words models use, skip
  ornaments and words that only contain a hair word, and take 发 only at the
  start of a name or after a position, length or colour.
- **Ship order** (for G3): the Create Anima hint and the docs name
  `npx animama-avatar-converter <model.pmx>` and the README's `#mmd-models`
  section. Both exist only once converter 0.2.0 is published. Animama must
  accept the marker before users share marked files. So the converter release
  follows the Animama merge before a build with the hint reaches users. The
  owner decides at G3.

#### Code Review #1 Findings

High-risk tier: an independent analysis agent read `1a42ec96`, compared it with the converter at `b0ee627` plus
its Phase 4, and ran the touched vitest files (12 tests passed). A separate checks agent reran the affected checks
(above). No blocker.

It confirmed:
- every allow-list is updated (loader, backend `_GLTF_EXTENSIONS`, the shared fixture, the optimizer's safe and
  JSON-only lists, test helpers), and none is missed;
- accepting the marker adds no executable surface: at most a hostile package turns off wind;
- older installs reject a package with a marked Avatar, as they do Mochiya's extensions;
- the i18n keys and the link's screen-reader text are present in every locale.

- P5-F1: the hint and docs point at a converter README section and release that do not exist until Phase 6.
- P5-F2: the new files, and the committed plan files, had no licence-review entries.
- P5-F3: the hair pattern missed 前发, 后发, 侧发, 刘海, 呆毛, アホ毛, ツインテール and Korean names, and matched 发条,
  发射 and 髪飾り.
- P5-F4: comments and docs still called the wind exemption Mochiya-only.
- P5-F5: five statements in `mmd-model-conversion.md` did not match the converter.
- P5-F6 (pre-existing): the optimizer's JSON-only check looks only for `bufferView` and `accessor` keys.
- P5-F7: the springs exemption ignores the marker's `source`.

#### Code Review #1 Revisions

- P5-F1: kept as the ship-order decision above, for the owner at G3.
- P5-F2 fixed: four entries; `check_source.py` passes.
- P5-F3 fixed: wider pattern, a not-hair pattern, tests for each case.
- P5-F4 fixed: `avatar-animation.md`, `avatarSettings.ts`, `AnimationDebugModal.tsx`, `avatarGltfExtensions.ts` and
  `content_package_capabilities.py`.
- P5-F5 fixed: the report, morph, mood, look-at and not-carried-over statements now match the converter.
- P5-F6: left. It is shared with Mochiya's extensions, and the converter writes two strings.
- P5-F7: documented (the marker means springs tuned without ambient forces).

Result: Phase 5 complete, committed with this record as `feat(avatars)[p5]: recognise MMD models converted by
Animama Avatar Converter` on Animama's `feat/pmx-conversion`.

#### Follow-up: brightness of converted Avatars (2026-11-26)

The owner compared #926's Automatic toon shading of an unlit-only file with the converted test model and found the
conversion dark. Measured under enhanced rendering, the converted face was about 9% darker than the MMD reference
(cheek luminance 172 against 189; the unlit-only file under #926's Automatic, 180). Animama's chat lights draw an
MToon lit colour about a fifth darker than MMD's light, and #926's 1.25 gain reaches only files it converts on load.
The converter cannot raise it, because glTF caps `baseColorFactor` at 1. The owner chose an Animama-side gain
("Yes, add the lift").

Review tier: standard. The change applies only to files carrying the marker.

Changes:
- `convertedAvatarBrightness.ts` raises every MToon material's lit and shade colours in a marked file by `LIT_GAIN`
  (1.25, exported from `unlitToonShading.ts`), in the glTF before three-vrm builds materials, under every Materials
  setting. The setting is not offered for these files, so Simple must not change a hidden look.
- It runs between the enhanced retune and the unlit toon step, so no file takes both gains.
- `avatarConversionMarker.ts` holds the marker's name and check, shared by the springs, the extension list, the
  retune and the new step.
- The enhanced VRoid retune skips marked files, which may keep VRoid's material names.
- Docs: `mmd-model-conversion.md` (What Animama does with it), `avatar-animation.md` (enhanced materials, unlit
  brightness).

Base: `origin/main` `4ba6db1c5` (with #926) merged into the branch as `0a9026d87`, an ordinary merge without
conflicts. Candidate: `484572619` and `de7ab9213`, tree `41d77374`.

Checks (macOS, Node 24; heavy jobs through `scripts/heavy-slot.py`):
- Full pre-push suite on `de7ab9213`, while another session's six-CPU job held the other heavy slot:
  - `make check-test`: exit 0; 6073 passed, 30 skipped.
  - `pnpm verify`: exit 0; 6557 passed, 2 skipped.
  - `pnpm prettier:check`: exit 0. `check_source.py`: passes.
  - `pnpm web:test:browser`: 139 of 141. "records the take after a failed one as it records alone" passed when its
    file was rerun alone. "plays a combination and copies it as a cue sheet take" asserts playback within 15% of
    real time on Annie and Andrew, which carry no marker. It failed 2 of 3 runs alone on the candidate and 1 of 3 on
    its parent `0a9026d87` under the same load: a timing flake, not this change.
- Affected vitest files (loader, retune, unlit, diagnostics, springs): 74 passed.
- Mutation checks: without the loader wiring the loader test fails; without the retune skip three tests fail.
- `effects:render` on the five private models, 3 s, front and face, enhanced rendering. Face-tile mean luminance
  before → with the gain (MMD reference):

  | Model | Before | With the gain | MMD |
  | --- | --- | --- | --- |
  | M1 | 138 | 149 | 151 |
  | M2 | 149 | 156 | 155 |
  | M3 | 176 | 184 | 179 |
  | M4 | 188 | 198 | 196 |
  | M5 | 73 | 78 | 97 |

  No white-clipped pixels appear with the gain. M1's cheek is 191 (MMD 189). M5 stays darker: its hair is
  darker than in the reference, and the reference framing shows more of its white collar.

#### Code Review #1 Findings (brightness)

An independent read-only agent reviewed `484572619`. No blocker. It confirmed:
- the step runs before three-vrm builds materials;
- nothing serialises or hashes `parser.json` after load;
- factors above 1 are safe in three-vrm;
- outlines, rim and matcaps are unchanged for the converter's output;
- applying the gain under every Materials setting is consistent with the hidden setting.

- B-F1 (should-fix): a VRoid model exported to PMX keeps VRoid's material names, so the enhanced retune replaced
  the converted shading with VRoid's palette before the gain raised it; two comments claimed no earlier step touches
  these files.
- B-F2: the step ran outside the unlit step, so a marked unlit-only file could take both gains.
- B-F3: a `baseColorFactor` that is not an array lost its alpha.
- B-F4: the NaN guard and test covered input JSON cannot hold; string channels were raised as 1.
- B-F5: the loader test covered only the default loader settings.
- B-F6: the marker's name was written in three places; a diagnostics comment was out of date.
- B-F7: `avatar-animation.md` placed the converted-model sentence in a list that Simple skips.

#### Code Review #1 Revisions (brightness)

All fixed in `de7ab9213`:
- B-F1: the retune skips marked files; tests compare the loaded colours with the file's own factors, which a retuned
  shade fails, plus a retune unit test; comments corrected.
- B-F2: the step now runs between the retune and the unlit step.
- B-F3, B-F4: a non-array factor reads as glTF's default; an array whose first three channels are not all numbers is
  left as authored; tests cover a string channel, a short array and a non-array factor.
- B-F5: the loader test also runs with lilToon and unlit toon shading off.
- B-F6: `avatarConversionMarker.ts`; the comment updated.
- B-F7: "under every Materials setting" added.

Also added: licence-review entries for the three new files (`check_source.py` passes).

The same agent confirmed every finding fixed in `de7ab9213` (11 tests in the two touched test files pass) and
nothing new blocking. Its one new nit, an import out of alphabetical order in `SpringBonePhysicsController.ts`, is
left: no lint or format rule checks import order.

Result: one repair round; the follow-up is complete.

### Phase 6: release preparation and verification

Review tier: high risk. Packaging and a public release.

Requirements: R12 (converter README); every acceptance criterion's evidence.

Steps:

1. **Packaging:** add the `pmx/` runtime files to `package.json` `files`, excluding
   tests and `pmx/testing/`. Check with `npm pack --dry-run`.
2. **README:** an "MMD models" section covering the command, what carries over and
   what doesn't, expression overrides, and uploading. Update the description in
   `package.json` and the top of the README to name MMD models.
3. **Version:** 0.2.0 in both `package.json` files (`check.mjs` requires them to
   agree), with a `CHANGELOG.md` entry noting that the Unity package is unchanged.
4. **Private corpus (G1):** convert every model and record, per model, counts
   only:
   - `vrm:inspect`;
   - the validator;
   - conversion time;
   - the look-at method;
   - the mood regions filled.

   Tune spring parameters and the expression table where the corpus shows
   problems, with tests for each change.
5. **Platforms (G2):** on macOS and Windows, install from the packed tarball
   (`npx <tarball> <model.pmx>`) and convert one model each.
6. **Owner manual check (G4):** in Animama's chat, with Phase 5 built:
   - toon shading and outlines;
   - springs at rest and during Gestures;
   - five moods and visemes;
   - cursor look-at without tearing.
7. **Release (G3), after the Animama PR merges:** follow `RELEASING.md` (tag
   `v0.2.0`, GitHub release, then `npm publish` from the tag). Update the Animama
   docs page with the released version if it names one.

Checks: the shared converter checks; `node scripts/pack.mjs --out <tmp>/zips`;
`npm pack --dry-run`; the corpus and platform runs above.

Completion: every acceptance criterion has its evidence, and gates G1–G4 are
passed.

Check record (converter checkout, macOS, Node 24.15):

| Check | Tree | Result |
| --- | --- | --- |
| `npm test`; `node scripts/check.mjs`; `node scripts/pack.mjs --out <tmp>/zips`; `npm pack --dry-run` | `5018d93e` | 146 pass; OK at 0.2.0; the Unity zip holds the Unity package only (75 entries); the npm package holds 27 files, every runtime module and `pmx/LICENSE-pmx-to-vrm`, no tests |
| step 5, macOS: `npx <tarball> <private model>.pmx` from the packed 0.2.0 tarball | `5018d93e` | converted in 0.8 s; backend validator accepts it; `vrm:inspect`: all five moods "vroid" in every region, no `none` under blink and visemes, face skin, eyes, eye line and hair found |
| checks agent: `npm test`, `check.mjs`, `check.mjs --tag v0.2.0`, `pack.mjs`, `npm pack`, `npx` smoke from the tarball, `npm publish --dry-run` | `5018d93e` | all as expected; `--tag` and `publish --dry-run` refuse only on the unreleased changelog heading and the untagged checkout (the release guards) |
| `npm test`; `node scripts/check.mjs` | `4e1141f7` (`de6efd7`) | 147 pass; OK |
| `npm test`; `node scripts/check.mjs` | `c917f392` (`b51a0f4`, final) | 147 pass; OK |

Open gates (owner): G2's Windows run, G4 (manual check in chat) and G3
(release). G1 is met by the corpus below. Phase 4's review left three things to watch on the corpus: skirts
flaring against the hip collider, irises the eye carries less than half of, and
unreported diagonal joints.

#### Step 4: private corpus (G1)

Five private models; the owner approved each download and its source. They are labelled here by trait only and are kept outside every repository. Counts come from the final converter tree `37e9c5bb` (`4c7442f`) (macOS, Node 24):

| Model | Rig and content | Time, size | Validator | `vrm:inspect` | Look-at | Springs |
| --- | --- | --- | --- | --- | --- | --- |
| M1 | D-bones; 679 bones; 40 vertex morphs, 1 material morph; PNG; 431 simulated bodies | 0.46 s, 14.8 MB | accepted | moods 5/5 "vroid"; blink and visemes all; face skin, eyes, eye line, lashes, hair | bone | 57 chains |
| M2 | plain rig; 302 bones; 216 morphs (20 group, 7 bone, 5 material), 114 English and ARKit names; sleeves turned by one-link IKs | 1.82 s, 75.4 MB | accepted | moods 5/5; all | bone | 57 chains |
| M3 | plain rig; 224 bones; 184 morphs (3 group, 1 UV, 3 material), 109 English and ARKit names; one-sided mood morphs (`_L`/`_R`) | 1.87 s, 57.7 MB | accepted | moods 5/5; all | bone (259 eye vertices stretch, as in MMD) | 38 chains |
| M4 | plain rig (2013); own toon; BMP textures; zero-width outline vertices; winks named opposite their side | 0.19 s, 3.0 MB | accepted | moods 5/5; all | bone | 31 chains |
| M5 | plain rig; 117 bones; own toon; winks named opposite their side | 0.26 s, 4.6 MB | accepted | moods 5/5; all | bone | 25 chains |

Over-time renders (`effects:render`, 1, 3 and 8 s) show every model's springs hanging and settling.

Coverage of the spec's list:
- D-bone and plain rigs: M1; M2–M5.
- Group, bone and UV morphs: M2, M3.
- Morphs not in standard Japanese: M2, M3.
- Custom toons: M4, M5.
- Non-PNG textures: M4.
- Separately skinned eyes: none in the corpus. M1's pupil joints sit under the eye bones. Synthetic tests only.
- PMX 2.1: none found publicly (only PMX Editor writes it). Synthetic tests only.

What the corpus changed (tuning, with tests):

1. **One mesh per opaque material; blended ones share one, in PMX order.**
   - M2 first failed Animama's validator. Its 211 targets × 50k vertices expanded to 126.5 MB against the 100 MB cap.
   - Per-material meshes hold only the targets that move them, which cut that expansion 10–30× (M2 10.4 MB). They also cut a viewer's memory.
   - The converter warns if a model still exceeds the cap.
2. **One-link IK followers.** M2's sleeves are turned by IKs riding on the arm; they now hang from the arm bone on their joint, before the T-pose bake. Before, they stayed out to the side as the arms moved.
3. **Faces.**
   - A one-sided mood morph plays with its mirror partner (M3's sad eyes).
   - A region with no named morph takes Animama's ARKit mix when the model has its shapes (M2 and M3 relaxed eyes, which were neutral).
   - ARKit shapes never pass for mood morphs by name.
4. **Outlines.** Faces whose vertices MMD draws without an edge get an outline-free copy of their material (M4's hem), except on face materials, which Animama needs as one primitive.

#### Code Review #3 Findings (corpus tuning)

High-risk tier: an independent analysis agent read `a2e88ae5` against `b51a0f4`. A separate checks agent reran
`npm test`, `check.mjs`, packing, `npx` from the tarball on three synthetic models, Animama's validator and
`vrm:inspect`; all passed. No blocker.

- CT-F1 (important): separate meshes let a viewer sort blended materials by depth, losing PMX order.
- CT-F2 (important): the outline split could cut a face material in two, and Animama finds the face skin as one
  primitive.
- CT-F3 (important): ARKit names passed for mood morphs by name (`mouthFunnel` read as "fun"), so the ARKit mix never
  ran for the mouth.
- CT-F4–F8 (minor): empty bind lists for targets in no mesh, no guard for the 100 MB cap, IK carriers on unused leg or
  physics bones, a miscounted lost width, and four tests that did not test what they claimed.

#### Code Review #3 Revisions

- Repair round 1 (`8d1738d5`): fixed CT-F2 to CT-F8. CT-F1's fix, one mesh for every blended material, brought back
  part of the expansion it was meant to cut.
- Repair round 2 (`37e9c5bb`): only blended materials that tie on render order share a mesh. Tests were added for the
  invisible-target, cap-warning and IK-carrier fixes, and each was checked by removing its fix. The same agent confirmed
  both rounds.
- Left as follow-ups (report only): a morph whose only target shows nothing is counted under two dropped headings, and
  overriding with it says the morph does not exist.

Result: committed as `4c7442f` (`feat(pmx)[p6]: tune the converter on a corpus of real MMD models`, tree
`37e9c5bb`): 159 pass; `check.mjs` OK; all five corpus models accepted.

#### Code Review #1 Findings

High-risk tier: an independent analysis agent read `5018d93e`, and a separate checks agent reran the release checks
(above). No blocker.

- P6-F1 (important): the README said additive `.sph` sphere maps were dropped; `.sph` is multiplicative, and `.spa`
  converts.
- P6-F2 (important): the README goes public on GitHub before `npm publish`, and 0.1.1 treats a `.pmx` as a prefab.
- P6-F3 to P6-F9: the mood names and two override rules were missing; two Options rows were VRChat-only; the
  not-carried-over list was incomplete; PMD was not mentioned, and a `.pmd` got the Unity error; the licence note had
  changed against spec Q1; the npm keywords lacked MMD words.

#### Code Review #1 Revisions

- P6-F1, F3–F9 fixed in `de6efd7`: the README lists every preset and `Fcl_<BRW|EYE|MTH>_<mood>` with the mood words,
  both rules, the full not-carried-over list and PMD; a `.pmd` gets the reader's PMD message (exit 2, tested); the
  licence note is restored; keywords added.
- P6-F2: the section says it needs 0.2.0, and the changelog's marker line is conditional; the release order is for
  the owner at G3.

#### Code Review #2 Findings

Repair round 1 on `c0ef72f4`: all nine fixes correct, no regressions. Two wording nits (the report "counts each"
and "as the report lists them") were fixed and confirmed by the same agent on `4e1141f7`.

#### Code Review #2 Revisions

None further. Phase 6 steps 1–3 committed as `de6efd7` (`feat(pmx)[p6]: document MMD models and prepare version
0.2.0`, tree `4e1141f7`), pushed to raymond-van/animama-avatar-converter#4.

### Owner gates

| Gate | What | Needed by |
| --- | --- | --- |
| **G1** | A private corpus of at least five MMD models covering the spec's list. Each download needs the owner's explicit yes, with its source. | Phase 6; earlier availability helps tune Phases 2–4 |
| **G2** | A Windows machine with Node 22 or later for the platform run. Without it the Windows criterion stays open and blocks the release. | Phase 6 |
| **G3** | Approval to tag, release and publish converter 0.2.0. | Phase 6, after the Animama PR merges |
| **G4** | The manual check in Animama's chat. | Phase 6 |

Merge approval for each PR stays separate.

### Pull requests

- **Converter:** one PR from `feat/pmx-conversion` for Phases 1–4 and 6's code and
  README.
- **Animama:** one PR from `feat/pmx-conversion` for the spec, this plan and
  Phase 5.

The Animama PR merges first, so the springs exemption, Library sharing and
optimizer support exist before the release. Files from an unreleased converter
already upload on today's Animama, because uploads do not restrict
`extensionsUsed`.

## Final integration review

- **Scope:** the combined acceptance criteria across both repositories, reusing
  still-valid phase evidence.
- **Repairs:** at most two rounds.
- **After it:** the full pre-push suite runs once on the final Animama candidate,
  and `npm test` plus `node scripts/check.mjs` on the final converter candidate.
  Their results go in the PRs.

#### Code Review #1 Findings

An independent read-only agent reviewed both branches: converter `0b24f4e..de6efd7`, and Animama from the merge base
with `origin/main` to `879bf6e91`. It ran no suites.

What it confirmed:
- **Marker:** the converter's marker matches every Animama list and the springs predicate.
- **Moods:** the mood names, the VRoid invariant and the MMD first-choice names agree on both sides.
- **Springs and look-at:** the spring output is valid and unaffected by Animama's zero-gravity baseline and drag
  clamp; look-at uses only types three-vrm supports.
- **Project rules:**
  - no dependencies or network code;
  - the licence notice is kept;
  - no third-party files and no attribution lines.
- **Commit trees:** every commit tree matches its recorded tree.

No blocker.

- FI-F1 (important): Phase 6 steps 1–3 and the verification of Phase 5's review fixes were not recorded, and the
  Progress list was stale.
- FI-F2: `--expression blink=` (or a vowel) is not neutral in Animama, which fills an empty blink or viseme preset
  from the model's morphs. A model whose only ウィンク closes the right eye also gets that wink in both presets
  through Animama's name-based fill.
- FI-F3: the Animama page left out outline transparency and additional-UV morphs, and overstated which group
  morphs become targets.
- FI-F4: the final full checks had not yet run on the repaired trees.
- FI-F5 (optional): the marker has no Avatar-level Automatic or diagnostics test, though the wiring is shared.
- FI-F6: a synthetic test string named a well-known character.

It reviewed the Phase 5 fixes (hair pattern, docs and comments) and found no defect. That serves as their
verification round.

#### Code Review #1 Revisions

- FI-F1 fixed: this record, the Phase 6 record and the Progress list.
- FI-F2 fixed in the converter (`b51a0f4`): an empty or all-zero blink or vowel override is refused, with the rule in
  USAGE, the README and the Animama page; confirmed by the reviewer. The wink edge case is Animama's name-based fill
  and is left as a follow-up.
- FI-F3 fixed in `mmd-model-conversion.md`; confirmed by the reviewer.
- FI-F4: the converter's `npm test` and `check.mjs` ran on the final tree `c917f392` (147 pass; OK). Animama's full
  pre-push suite ran on `879bf6e91` (tree `e6ef3089`): `make check-test` passed (5736). The frontend steps are
  recorded below. Later Animama commits change only this plan and the docs page, which no check covers.
- FI-F5: skipped (optional).
- FI-F6 fixed (`b51a0f4`).

Final full checks:

| Check | Tree | Result |
| --- | --- | --- |
| `make check-test` (root, heavy-job slot) | `e6ef3089` (`879bf6e91`) | exit 0; 5736 passed, 30 skipped |
| `pnpm verify` (`src/frontend`, heavy-job slot) | `e6ef3089` | exit 0; 6497 tests passed, 2 skipped |
| `pnpm web:test:browser` (`src/frontend`, heavy-job slot) | `e6ef3089` | exit 0; 141 of 141 |
| `pnpm prettier:check` (`src/frontend`) | `e6ef3089` | exit 0 |
| converter `npm test`; `node scripts/check.mjs` | `c917f392` (`b51a0f4`) | 147 pass; OK |

Result: both branches ready for their PRs. Gates G1, G2 (Windows), G4 and G3 stay open for the owner.

## Validation and acceptance

Each spec criterion maps to this plan's evidence:

| Criterion | Evidence |
| --- | --- |
| Synthetic tests | Phases 1–4 `npm test` records |
| Private corpus | Phase 6 step 4 (counts) |
| Owner manual check | G4 |
| Platforms | Phase 6 step 5 |
| Animama | Phase 5 tests, optimizer and Library checks, Create Anima line |
| Docs | Phase 5 step 4 and Phase 6 step 2 |

An unperformed check is never recorded as passed.

## Idempotence and recovery

- **Converter outputs:** a conversion never overwrites. A failed one leaves no
  output, because the temporary file is removed. Re-running is safe.
- **Rollback:**
  - The PMX path is new; the VRChat path is untouched, so reverting the converter
    PR removes PMX support only.
  - The marker is additive. Older Animama versions load marked files, but apply
    ambient forces and refuse them in Library packages and `vrm:optimize`.
  - Reverting Phase 5 restores that behaviour.
- **Releases:** never move or delete a published tag; ship fixes as patch
  versions (`RELEASING.md`).
- **Private material:** stays in `<private>`. Nothing from it is committed. Phase
  evidence is counts only.

## Outcomes & Retrospective

_Pending._
