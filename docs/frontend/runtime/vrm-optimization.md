# VRM optimization

`pnpm -s vrm:optimize` (from `src/frontend/web`) shrinks a VRM 1.0 Avatar that
Animama ships, without changing how it looks or behaves in the app. The Included
Avatars in `content/included/avatars/` are produced with it, and
`vrm:convert-vrchat` runs it on every VRChat conversion unless told not to
(see [VRChat Avatar conversion](vrchat-avatar-conversion.md)).

```bash
pnpm -s vrm:optimize <source.vrm> --out <optimized.vrm> [--meta <meta.json>]
pnpm -s vrm:optimize verify <source.vrm> <optimized.vrm> [--meta <meta.json>]
pnpm -s vrm:optimize compare <source.vrm> <optimized.vrm> --out <dir> [--min-psnr 45]
```

## What it changes

- **Colour textures** become WebP at quality 90 with full-quality alpha:
  - base colour and emissive;
  - the MToon shade multiply, matcap and rim multiply textures.
- **Normal maps and other data textures** become lossless WebP: normal maps,
  outline width, shading shift and the UV animation mask. Any texture slot it
  does not recognise also counts as data.
- **Converted Avatars' lilToon textures** (`MOCHIYA_materials_liltoon`) follow
  the same split: main, shadow, emission, matcap, rim, reflection, backlight,
  glitter and outline colour textures are colour; masks, normal, smoothness and
  metallic maps are data. A texture used in both kinds of slot is data. Lossless WebP drops the colour under
  fully transparent pixels, so a data texture keeps its original bytes unless
  WebP decodes to identical pixels.
- **A texture keeps its original encoding** when WebP would be larger.
- **The VRM thumbnail** becomes a JPEG of at most 1024 px. Animama does not
  display it, but other VRM tools do.
- **Morph targets** (expression shapes) are stored as sparse accessors, which
  hold only the vertices a shape moves. An all-zero target keeps no data. three.js
  expands both back to full arrays at load, so GPU memory is unchanged.
- **Metadata:** `--meta` replaces `VRMC_vrm.meta` with the given JSON and keeps
  the file's `thumbnailImage` reference.

The tool edits the GLB in place. It changes the binary layout (buffers,
buffer views and accessor storage), image encodings, the texture references
and `EXT_texture_webp` declarations that WebP images need, and the metadata.
Every other part of the JSON, including every VRM extension, index and name,
is untouched. It accepts only the extensions it knows to be safe to carry,
including Mochiya's `MOCHIYA_avatar_composition` and
`MOCHIYA_materials_liltoon` and Animama Avatar Converter's
`ANIMAMA_avatar_conversion`, while they point at nothing in the binary. It
refuses:
- VRM 0 files;
- files with external buffers or images;
- any other extension, declared or not, such as `EXT_meshopt_compression`.

## What it must never do

Animama depends on details that stock glTF optimizers remove:

- **Every morph target stays.** Animama registers every morph target name as
  an expression (`morphTargetExpressions.ts`). Built-in content and user
  Gestures key VRoid `Fcl_*` parts by name.
- **Order and names stay.** Saved face-part corrections key node, mesh and
  primitive positions. The MToon retune matches material names, and the spring
  classifier reads node and spring names. So the tool never merges, reorders or
  renames anything.
- **No quantization and no re-indexed vertices.** glTF-Transform's
  `optimize`, `quantize`, `weld` and `prune` drop `VRMC_*` extensions, MToon-only
  textures and, in testing, skins. vrm-transform's `pruneMorphTargets` deletes
  the `Fcl_*` shapes.
- **No Draco or KTX2.** The app registers no decoders for them; it decodes
  `EXT_meshopt_compression`, which this tool does not write. The backend
  validator rejects KTX2 images, and texture-painted Avatar Effects need
  images a canvas can draw.

## Checks

The default command checks its own output before writing it:

- **`verify`** compares the two files:
  - the JSON must match, with buffer storage normalised away;
  - every accessor value must match (`-0` may become `0`);
  - every image must keep its size, and every data texture its exact pixels;
  - the thumbnail must be at most 1024 px;
  - both files are then loaded through the headless three-vrm loader
    (`motion-authoring/headlessVrm.ts`), which must report the same meshes,
    morph names, expressions, humanoid bones and spring joints.
- **`compare`** renders the face, torso, full body and back of both files with
  the app's MToon patch, writes the renders to `--out`, and fails when any view
  scores below `--min-psnr` (default 45 dB).

Also run the backend validator (`validate_vrm_stream`) on the result before
shipping it. It accepts sparse and all-zero morph targets only within its bounds.

## Regenerating the Included Avatars

Each shipped file is its source run through the default command with its
owner metadata from `src/frontend/web/scripts/vrm-optimize/included-meta/`:

- **`Annie.vrm` (Annie):** the source is the file at commit
  `0a9b3549`.
- **`Andrew.vrm`:** the source is the owner's export, committed unoptimized in
  `faa29944`.

Check out the source with Git LFS, then run, for example:

```bash
pnpm -s vrm:optimize <source.vrm> --out ../../../content/included/avatars/Andrew.vrm \
  --meta scripts/vrm-optimize/included-meta/Andrew.json
```

The tool is deterministic, so unchanged sources and dependencies reproduce
the shipped bytes.

Replacing an Included Avatar changes its SHA-256. Update the records keyed by it:
- the verified eyelid profiles in `eyelidClosure.ts`;
- `licenses/third-party/art-vroid-review.json`;
- the licence inventory and notices.
