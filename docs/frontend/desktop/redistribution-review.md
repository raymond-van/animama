# Desktop redistribution review

This guide identifies the source mappings and exact-artifact checks required
before desktop distribution. Source preparation is not permission to publish.
Current source and notice changes require a fresh runtime inventory and matching
human review; stored receipts apply only to their exact inputs.

## Source mappings

- [Code and model notices](../../../licenses/third-party/code-and-models.md)
  identify retained ONNX, Basis, SentencePiece, Pocket, VAD, Smart Turn, Parakeet,
  Transformers.js and fft.js inputs, license texts and local modifications.
- [Artwork notices](../../../licenses/third-party/art-NOTICES.md) identify
  retained textures, particle derivatives, models and portraits.
- `content/included/licenses/inventory.json` records Included-content provenance
  and distribution rules. Required excluded or untracked inputs fail staging.
- [Source review inventory](../../../licenses/README.md) describes the broader
  source-publication review, which is distinct from packaged redistribution.

Pocket ONNX weights, tokenizer and the two core voice states are CC BY 4.0, which
permits commercial use with attribution. Kyutai's model-card prohibited-use
terms still apply. The 36 downloadable voices, four of which derive from CC0
recordings, are installed at runtime, outside the packaged core. `runtime/release-policy.json`
separately records a noncommercial distribution basis, which release validation
requires; changing it is a separate owner decision. Per-file terms are documented
in the code/model notices; source-code licensing does not replace model terms.

Annie's model uses VRoid preset terms. Caitlyn is pixiv VRoid Project's unmodified
sample model under CC BY 4.0. Their embedded metadata and
renderer-captured portraits do not make all underlying material AGPL or CC0.
Keep notices and exact file mappings with each candidate.

Mixamo-derived VRMA files are ignored and excluded from source tracking and
Docker contexts. Desktop and hosted builds may include them only as the
non-portable [Mixamo-motion pack](../../backend/operations/mixamo-motion-pack.md),
staged from a verified private build input that exactly matches the tracked
manifest; its own licence inventory joins the redistribution inventory. The
[optional Local installer](../runtime/mixamo-acquisition.md) can install
manually converted motions as ordinary Local content. The shipped starter does
not require any of them. Ignored copies elsewhere cannot become release inputs.

WOW Sound's licensed comedy sound effects follow the same rules as the
non-portable [comedy sound pack](../../backend/operations/comedy-sound-pack.md),
with its own licence inventory (Media license) and a hash deny list for the
vendor's watermarked previews, which may ship nowhere. Built-in effects name
their sounds through optional dependencies, so a build without the pack is
complete and silent.

## Pack and native dependencies

`desktop/runtime/feature-pack-releases.json` has no active pack. Expanded
Included content and Docling document processing are deferred: they produce no
initial-release archive or catalog entry. Both Parakeet sets are published as
shared model objects and downloaded at runtime, outside the packaged core; their
attribution and the onnx-asr MIT notice stay in the packaged notice bundle, and
each installed set carries its own README and attribution. Settings retains recovery/removal controls for
installed files even when a pack has no compatible catalog entry.

The first-party global input addon exposes only the configured binding's down/up
transitions to JavaScript. Its native binary requires platform/signing acceptance.
The LGPL dependencies `psycopg` and `psycopg-binary` retain their
source coordinates and bundled terms in the runtime inventory. Review linkage,
notices and distribution obligations for the exact build. A generated inventory
or a successful Apple notarization does not grant redistribution permission.

Before activating document processing, review its models/native libraries and
exact signed worker inventory. Rebuilding or changing signed worker bytes
requires fresh signatures, notarization, inventory and review.

## Exact artifact review

Run a fresh [stage and audit](runtime-staging.md) after changing source, build
inputs or notices. Inspect `runtime/licenses/inventory.json`,
`runtime/licenses/THIRD_PARTY_NOTICES.txt` and active-pack reports. Notice hashes
and source metadata are bound into the inventory, so changing either invalidates
an approval for different bytes. Resolve unclassified or unclear records; do not
fill approval fields automatically from a passing scan.

The approved core inventory in `release-policy.json` predates the removal of
the `google-genai` and `litellm` runtime dependencies, so the next stage needs a
fresh inventory review. Allowlist entries in `release-scan.gitleaks.toml` that
only covered `litellm` can be dropped once that scan passes without them; keep
any that the returned `google-genai` package still needs. The inventory also predates three
later changes that the owner must re-review before the next desktop release:

- the Python license inventory gains the `anthropic` client SDK and its new
  dependencies (`httpx2`, `httpcore2`, `truststore` and `docstring-parser`;
  `idna` moves to 3.20). `httpx2` verifies TLS through the operating system's
  trust store (`truststore`) rather than certifi, so release acceptance should
  include an Anthropic request from the frozen runtime on each target;
- the `google-genai` stack returns at new versions for
  [Gemini voices](../runtime/gemini-tts.md): `google-genai` 2.29.0
  (Apache-2.0), `google-auth` 2.61.0, `pyasn1` 0.6.4 and `pyasn1-modules`
  0.4.2; `cachetools` and `rsa` are no longer present. Release
  acceptance should include one Gemini voice request from the frozen runtime on
  each target, confirming that the SDK's lazily imported modules were bundled
  and that TLS succeeds;
- the notice inventory changes because the `model-provider-logos` group in
  `runtime/license-sources.json` now covers ten logos, including the
  Anthropic mark from models.dev.

The generated `desktop/release/review/redistribution-review.md` packet links the
current local artifacts for the target last staged. Keep the reviewer's
decision with exact inventory and artifact hashes. `release-policy.json` and
`feature-pack-releases.json` supply machine-checked receipts; they are valid
only when the produced inventory matches. Each target has its own native
components and lock, so `release-policy.json` keeps one receipt per target under
`redistribution_reviews` (`darwin-arm64`, `win32-x64`); a receipt for one never
admits the other.

Fresh native notice bundles, complete starter behavior and signed/native
acceptance remain release gates. Follow [Releases](releases.md) and the
[manual release process](release-process.md) for separate build, acceptance and
publication actions.
