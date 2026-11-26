# Repository boundary checks

These tools verify shared-code import direction, isolated wheel/npm consumers
and the emitted whole application.
Repository ownership is documented in
[repository boundaries](../../docs/architecture/repository-boundaries.md).

For per-file licence coverage, use the
[source review check](../public-release/README.md).

Run the tooling tests from the repository root:

```bash
uv run --no-sync python -m unittest discover -s scripts/repository-boundary -p 'test_*.py'
node --test scripts/repository-boundary/consumers/hosted-app/*.test.mjs
```

Full validation runs both through `scripts/ci/tooling_tests.py`.

## Shared import and artifact checks

`check-python-imports.py` statically follows every domain, application and shared
product HTTP (`animama.product_http`) module,
including relative imports, package initializers and transitive helpers. A
dependency on local installation state, server construction, migrations,
local HTTP admission or private service modules fails. Local compositions may
depend on shared APIs; the reverse direction is forbidden.

`check-packed-artifacts.py` requires a verified package-set manifest with one
Python wheel and the three packed npm packages (`runtime-contracts`, `product-ui`,
`discover-client`). Format 2 also carries the complete hosted application and
non-static Included seed; strict format 1 retains its package-only consumers.
The checker validates emitted exports and rejects workspace/source dependencies, then copies consumer
fixtures into a new directory outside the checkout. The frontend installs only
tarballs and declared registry dependencies, checks declarations, builds with
Vite and mounts two fake owners in Chromium. It exercises real Anima selection,
chat/session/SSE code, cancellation, stale event fencing, failed-POST retry
policy, emitted CSS and transport-supplied thumbnails. The backend installs the
wheel into a new virtual environment and exercises real bootstrap, Anima and
chat services with fake ports/model clients. Separate consumers render the shared
request/response schemas, exercise content save, export, import and receipt
recovery with owner-scoped memory storage and the canonical archive inspector, and
mount the shared product routers with a consumer's own resolver and ports
(fail-closed without either, per-owner sessions, a failed deferred commit reported).
Local-composition imports are
actively blocked and loaded modules must not resolve into the source checkout.

From the repository root:

```bash
uv run --no-sync python scripts/repository-boundary/check-python-imports.py
uv run --no-sync python scripts/package-sets/build.py build \
  --source /path/to/animama --commit <full-40-character-commit> \
  --output /tmp/animama-package-set
uv run --no-sync python scripts/repository-boundary/check-packed-artifacts.py /tmp/animama-package-set
```

The artifact checker needs Node/pnpm, uv and Playwright's Chromium browser.
The frontend's normal `pnpm e2e:install` command installs that browser. Optional
`--offline` requires a populated dependency cache; `--pnpm-store PATH` selects a
content-addressed store whose package bytes are copied into the consumer, never
linked back to application source. `--work-dir PATH` chooses a new empty output
directory outside the checkout. The checker prints the evidence directory and
retains logs, the browser screenshot, installed dependency locks and a summary.
It never reads the maintainer's application `.env` or calls an external provider.

For format 2 and later, the checker verifies and extracts the closed application inventory,
then serves those emitted bytes through an independent ordinary HTTP cookie/CSRF
authority. The browser exercises deep links, CSP, nested workers, real VRM and
Pocket PCM/worklet playback, two-owner lifetime cleanup, and creator
import/edit/save/export/reopen. The installed wheel resolves the seed's complete
starters without local-server imports. Included content is not exposed
through the static allowlist.

Use `--previous-app-set /tmp/previous-whole-app` for a verified compatible clean
format-2 or later predecessor with distinct resource bytes; a byte-identical pair is
rejected. This exercises an already-open tab's late worker, the new selection,
and rollback, while every route, static and measurement check runs on the
candidate. Without a predecessor, the labelled controlled byte-change fixture
leaves the genuine two-source gate unperformed. See
[package-set tooling](../package-sets/README.md#validation-receipt) for the
receipt schema and the [hosted contract](../../contracts/hosted-web.md) for exact
identities and grammar.

To check wheel reproducibility within one build environment, build twice from
unchanged inputs and compare SHA-256 digests. This does not establish universal
cross-platform reproducibility. Consumer dependencies resolve freshly from
package metadata, separately from the producer's frozen locks; retained inventories
identify what was actually tested.

Fresh resolution means an upstream release can break the frontend consumer
without any change here. When the break lies outside the packed packages, hold
the offending transitive dependency back with a `pnpm.overrides` entry in
[consumers/frontend/package.json](consumers/frontend/package.json). The checker
keeps fixture overrides beside its tarball overrides, refuses an override key
that names a packed package and a `resolutions` field, and drops every other
`pnpm` setting. Current hold: `csstype` 3.2.3. Version 3.2.4 adds a
CSS `pathLength` property whose type conflicts with `framer-motion`'s own
`MotionStyle` declarations, so `tsc` fails with TS2320 under `skipLibCheck: false`
(`motion` 12.43.0 and 14.14.0 both do; #907). Remove the hold once a `motion`
release that `product-ui` accepts type-checks against the latest `csstype`.

Timing, transfer, sampled heap and process RSS observations do not establish a
capacity budget. Same-source local production comparison, physical microphone
and heard audio, native acceptance, live hosted/provider behavior and publication
rights remain separate gates. A fixture or matching version number cannot
substitute for them.

## Candidate scanner pins

[scanner-pins.json](scanner-pins.json) records the official Gitleaks and
ScanCode release versions, exact archive digests, supported runner choice,
command shapes and recorded tool-verification scope. Verify the
selected download digest and executable version before use. Require a synthetic
secret-detection canary and a known-license fixture before accepting empty
candidate reports. Scanner output and any remediation evidence belong in private
storage outside the source tree. Do not interpret a pin or a passing inventory
check as a completed candidate scan or a license grant.
