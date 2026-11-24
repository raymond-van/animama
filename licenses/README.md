# Source licensing review

Raymond Van is the recorded owner of original Animama code, documentation and
original artwork, which is licensed AGPL-3.0-only under the root
[LICENSE](../LICENSE). Third-party code and assets keep their own terms.

Outside contributions arrive under the
[Contributor Licence Agreement](../.github/CLA.md): contributors keep their
copyright, and their work is published AGPL-3.0-only with the rest. A file
that an outside contributor adds or substantially rewrites names them in its
entry: `copyright` lists them, beside Raymond Van for a rewritten file, and
`basis` reads "Outside contribution under the Contributor Licence Agreement".
Git authorship records smaller edits.

[source-review.json](source-review.json) gives every tracked file its licence,
the basis for it and, for third-party material, its source, evidence and
notices; [the coverage check](../scripts/public-release/README.md) keeps it
complete. Original-work entries rely on the owner's authorship attestation and
a bounded source review; they are not forensic certification that no external
influence exists. Known third-party sources override that default. Exact
third-party bytes, revisions, modifications and full notices are in
[third-party](third-party/):

- [Code, speech models and dashboards](third-party/code-and-models.md).
- [Code adapted from other open-source projects](third-party/adapted-code.md).
- [Artwork and particle sources](third-party/art-NOTICES.md).
- [VRoid owner confirmation and metadata](third-party/art-vroid-review.json).

Raymond confirmed the retained model identities, authorized correcting Annie's
use and redistribution metadata, and on 2026-10-19 approved Andrew, Raymond's
own edit of a VRoid preset with owner-set restrictive metadata; their derived
portraits and renders keep the corresponding model terms. Caitlyn's former
unmodified CC BY sample remains only as a test fixture. The retained PocketTTS
assets, including all 38 voice states (3 core, 35 downloaded on demand), are
CC BY 4.0, which permits commercial use with attribution; Kyutai's model-card
prohibited-use terms still apply. They are not relicensed as AGPL. The desktop
release policy separately records a noncommercial distribution basis; changing
it is a separate owner decision.

Mixamo clips and WOW Sound's licensed comedy sound effects are not in the
repository. Desktop and hosted builds may carry them only as the private,
non-portable packs described in
[ADR 0018](../docs/adr/0018-non-portable-included-content.md) and
[ADR 0022](../docs/adr/0022-optional-licensed-effect-sounds.md). Retained
replacement artwork uses PNG authoring assets, which packaged desktop and
hosted builds ship as WebP derivatives where smaller; see
[Included artwork](../content/included/README.md#retained-avatar-and-effect-artwork).

This record covers the current tree. The repository is published with its Git
history; files that earlier commits contain but the tree no longer does are not
covered by this record and are not offered under the repository's licence.

Keep upstream notices intact. The AGPL text and third-party legal texts are
preserved documents, not claims that Raymond authored their wording. Installed
dependencies and binary build inputs need the runtime notice generation and
final artifact review; this source record does not replace that dependency or
redistribution audit.

The desktop and hosted notice bundles read `adapted-code.md` and the upstream
licence texts for the code that ships from this folder, through the
`adapted-code` group in `src/frontend/desktop/runtime/license-sources.json`
(three-liltoon's licence ships with its npm package, and the plugin-react patch
is a build tool). The packed `runtime-contracts` and `product-ui` packages
carry the texts for the code they contain as `dist/THIRD_PARTY_NOTICES.md`
beside the AGPL `LICENSE`. When a package gains adapted code, update both the
list in `src/frontend/scripts/build-typescript-package.mjs` and the copyright
line `scripts/repository-boundary/check-packed-artifacts.py` requires.
