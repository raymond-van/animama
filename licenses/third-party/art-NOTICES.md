# Third-party artwork notices

Application-source licensing does not replace the following artwork terms.
Exact paths and hashes are recorded in the adjacent `art-*.json` inventories.
These notices preserve source evidence and owner-confirmed model permissions.
Final source and binary publication approvals remain separate.

## Kenney and Brackeys particles

Kenney Particle Pack 1.1 is dedicated under CC0. Credit Kenney Vleugels and the
contributors named in the unmodified [archive notice](art-Kenney-License.txt).
[Primary source](https://kenney.nl/assets/particle-pack).

Brackeys' VFX Bundle v1 contains repackaged/remixed work by Picster/Raffaele
Picca, Kenney, Thomas Iché and CodeManu. Its original
[license and credits](art-Brackeys-License-and-Credits.txt) declare CC0.
[Primary source](https://brackeysgames.itch.io/brackeys-vfx-bundle).
[CC0 legal text](art-CC0-1.0.txt).

Animama normalizes selected alpha textures to 256×256 PNG, converts TGA
flipbooks to PNG, and resizes the CodeManu star atlas to 768×640. Exact source
filenames, input hashes and derivative hashes are in
[art-particles.json](art-particles.json). All 27 derivations were reproduced
byte-for-byte with the recorded Sharp version.

CodeManu's [primary page](https://codemanu.itch.io/vfx-free-pack) describes the
work as public domain while its metadata lists CC BY 4.0. Although the Brackeys
archive declares CC0, retain CodeManu credit, [CC BY 4.0](art-CC-BY-4.0.txt), the
source link and the change notice for `spark-pop-6x5.png`.
This conservative treatment satisfies the attribution requirements rather than
assuming the conflicting declaration away.

## Nunito lettering

The lettering images of five Included Avatar Effects (`bleh_lettering_head`,
`heh_lettering`, `rawr_lettering_chest`, `sorry_lettering` and `zzz` in
`content/included/vfx/avatar/`) were rendered from glyphs of the Nunito font
(Black weight, version 3.602), which an agent-written script outlined, fattened
and shaded. Nunito is Copyright 2014 The Nunito Project Authors
([googlefonts/nunito](https://github.com/googlefonts/nunito)) and licensed under
the [SIL Open Font License 1.1](https://openfontlicense.org/open-font-license-official-text/).
The OFL places no condition on images made with the font; this credit is
voluntary. The font file is not distributed with Animama; adding it would
require shipping the OFL text with it.

## VRoid models and portraits: owner-confirmed permissions

On 2026-09-15 Raymond confirmed that Annie (`AvatarSample_A_1_New.vrm`) is the
freely distributable pixiv VRoid preset and authorized correcting its embedded
license metadata, which now permits redistribution and use by everyone. On
2026-10-01 he approved Caitlyn's unmodified pixiv VRoid sample
(`AvatarSample_Y_0.vrm`). Both portraits are direct Animama renderer captures.

Annie retains pixiv VRoid Project credit and now links the applicable
[VRoidPreset A–Z conditions](https://vroid.pixiv.help/hc/en-us/articles/4402394424089-VRoidPreset-A-Z)
through `otherLicenseUrl`. The model is not CC0 or AGPL; preserve the prohibitions
on fee-based redistribution of the unmodified sample data and using its data in
a character-creation service. The official [AvatarSample A page](https://hub.vroid.com/en/characters/2843975675147313744/models/5644550979324015604)
links those same terms.

The metadata correction does not grant CC0/AGPL rights over Annie's
underlying components or expand its other use/modification settings; it retains
its noncommercial setting.

Caitlyn (`AvatarSample_Y_0.vrm`) is © pixiv VRoid Project and used unmodified.
Its embedded VRM 0 metadata declares [CC BY 4.0](art-CC-BY-4.0.txt) with commercial
use allowed and violent or sexual use disallowed; its portrait follows the same
terms. Do not edit its embedded permission flags.

The effect template thumbnails in
`src/frontend/web/src/assets/effect-templates/` (Avatar, Particle and Scene FX)
are also direct Animama renderer captures of Annie, each with one Included
effect and no other artwork: an Avatar Effect with Animama's own owner- or
agent-authored art, in some cases posed by an Included Gesture, an
owner-authored Particle Effect (Heart Stream's heart texture is from the
project's generated particle texture set) or an owner-authored Scene Effect.
Like Annie's portrait, they follow Annie's model terms and retain pixiv VRoid
Project credit. Their provenance and regeneration command are in that folder's
README.

Geometry, textures, non-metadata JSON and portrait bytes of both models are
unchanged; current hashes and metadata are recorded in
[art-vroid-review.json](art-vroid-review.json).

The earlier metadata discrepancy is resolved for source preparation by the
owner's explicit identification and authorization, together with the published
preset conditions. Final candidate and binary acceptance remain separate.

Current source inspection found model inspection, runtime preview edits, and
transport of existing model bytes in typed content packages. It found no export
of newly combined/deformed model meshes or textures. Recheck the character-tool
conditions before adding such an export feature.

## Excluded raw packs

LeLu's Noise Pack is ignored and has no tracked files or identified retained
texture derivatives. No LeLu bytes or license grant are being included here.
Its old inventory entry is historical acquisition information, not permission
for future reintroduction. Mixamo raw/converted clips are likewise outside this
art inventory. Desktop and hosted builds carry the owner's converted clips only
in the private, non-portable Mixamo-motion pack, under its own licence
inventory and Adobe's terms. WOW Sound's comedy sound effects are likewise
outside this inventory: they ship only in the private, non-portable comedy sound
pack under the owner's Media license, and the vendor's watermarked previews are
restricted by hash.
