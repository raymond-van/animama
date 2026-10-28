# Digest-keyed URLs for Included content files

Source agreement: [raymond-van/animama#763](https://github.com/raymond-van/animama/issues/763)
(created and last updated 2026-10-28T04:53Z). The issue is the spec; this plan
adds no requirements.
Authorized scope: the whole plan, through a pull request that references #763
(task instruction, 2026-10-28). Decisions D1–D8 below are agent choices within
the options the issue states; the owner reviews them with the pull request.
Merge needs the owner's approval of the exact head.

## Purpose and context

`GET /v1/content/files/{file_ref}` (`stream_content_file` in
`src/backend/animama/product_http/routes/content.py`) answers with the file's
SHA-256 as its ETag and `private, no-cache`. A `file_ref` names an item's path
and survives a reconciliation that changes the file's bytes (`reconcile_source`
in `src/backend/animama/adapters/repositories/sqlalchemy/content_catalog_repo.py`),
so the URL cannot be kept as immutable. Each Library visit therefore sends one
conditional request per Included image, and the server authorizes and opens each
file record again.

After this plan:

- every Included content file also has a URL that names its digest,
  `/v1/content/files/{file_ref}/sha256/{sha256}`, answered by the local
  composition with `private, max-age=31536000, immutable`;
- the catalog, typed content lists, Anima presentation images and Avatar
  portraits name each Included file by that URL, and every other file by
  today's URL;
- a digest that no longer matches is refused without bytes, so a release that
  changes a file's bytes changes its URL and never serves other bytes under the
  old one.

Code and contracts:

- Delivery: `product_http/routes/content.py`, `ProductPorts.file_response`
  (`product_http/ports.py`) and the local policy `local_file_response`
  (`server/product_ports.py`). `immutable=True` already exists for runtime
  members (ADR 0028); `delivery.py` keeps its ETag and 304 handling.
- Lookup: `ContentCatalogService.open_registered_file`
  (`app/services/content_catalog_service.py`) over the repository's
  `get_visible_file`, which returns the file's source.
- Descriptors: `PyContentFile` (`app/contracts/content.py`), `PyTypedContentFile`
  (`app/contracts/typed_content.py`), the presentation image URL
  (`app/services/anima_presentation_service.py`, candidates from
  `adapters/repositories/sqlalchemy/anima_presentation_repo.py`) and
  `portrait_image_url` (`app/services/avatar_portraits.py`).
- Route inventory: `product_http/inventory.py`.
- Web: `src/frontend/web/src/lib/content/contentThumbnail.ts` builds Library
  thumbnail and particle-manifest URLs from `file_ref` today; the generated SDK
  under `packages/runtime-contracts/src/generated` is regenerated, never edited.

Unchanged: runtime revision members and bundles (already immutable by revision,
ADR 0028), previews, owner and installation-shared files, the content catalog's
own validator, and every other private reply. Nothing is cached by a shared
proxy or CDN: the policy stays `private`.

Concurrent work in sibling worktrees: #761 (the catalog route's validator),
#764 (a capability that turns Library previews off) and #699 (runtime issuance).
This plan does not edit `list_content_catalog`, runtime issuance or the
Library's preview gating.

## Progress

- [x] Phase 1: digest URLs served and named; web adoption; tests and docs
  (`10212469`, `88a57a37`, `1d883cc2`, `069c7673`; `main` merged at `4b669f03`,
  `9e722513` and `a75db09d`).
- [x] Final integration review (pass) and the full pre-push suite (pass).

## Surprises & Discoveries

- 2026-10-28, first journey run: the second Library visit still revalidated the
  two Avatar portraits. CDP showed `fetch()` requests carrying
  `Cache-Control: max-age=0` and `If-None-Match`, answered 304: the sidebar's
  Anima presentation image (`useAnimaPresentationImage` in `product-ui`) read with
  `cache: "no-cache"`, which forces revalidation whatever the reply allows. It now
  reads with `cache: "default"`, so the reply's policy decides; Local images are
  still revalidated because their replies are `private, no-cache`.
- 2026-10-28, a probe of two visits to an Anima page on the task stack also showed
  every runtime JSON bundle and two runtime revision members read again from the
  network on the second visit. Those are revision URLs (ADR 0028), outside this
  plan; recorded as a follow-up for the runtime delivery work.

## Decision Log

- D1 (agent, 2026-10-28): a digest path, `/v1/content/files/{file_ref}/sha256/{sha256}`,
  rather than `?sha256=`. A distinct route lets a composition recognise the
  immutable replies by path, and `?variant=thumbnail` composes with it.
- D2 (agent, 2026-10-28): the digest route serves Included files only. An owner
  or installation-shared file there is `404 content_file_not_found`, so their
  bytes are never kept as immutable and their URLs stay unchanged.
- D3 (agent, 2026-10-28): a digest that differs from the registered digest is
  `404 content_file_not_found`, as an unknown reference or a stale preview
  revision is today. The reply has no bytes and no cache policy.
- D4 (agent, 2026-10-28): descriptors carry the URL. `PyContentFile` and
  `PyTypedContentFile` gain a required `url`, and the presentation and portrait
  URLs use the same helper, so the server alone decides which files are
  digest-addressed. Measured cost on a fresh built stack (557 Included items,
  1,265 files): the catalog grows from 1,656,778 to 1,827,553 bytes (+10%) as
  identity and from 234,991 to 250,412 bytes (+7%) gzipped; an unchanged
  catalog's 304 is unaffected.
- D5 (agent, 2026-10-28): the thumbnail variant of a digest URL is immutable
  too: it derives from the exact source digest. A thumbnail format change that
  must reach kept copies needs a new variant name.
- D6 (agent, 2026-10-28): ADR 0033 records the policy beside ADR 0028.
- D7 (agent, 2026-10-28): the Anima presentation image fetch moves from
  `cache: "no-cache"` to `cache: "default"`, so the reply's policy decides reuse
  (see Surprises). Runtime delivery's own `no-cache` fetches are left to the
  runtime work.
- D8 (agent, 2026-10-28): a new `local-http` major and `runtime-contracts` minor,
  per the [compatibility policy](../../../scripts/package-sets/README.md#compatibility-policy).
  #764 took 19.0.0 and 0.19.0 and merged first, so this change takes 20.0.0 and
  0.20.0.

## Phased implementation

### Phase 1: Included content files have digest-keyed, immutable URLs

Review tier: high risk (a public API and shared contracts, the generated client,
and what browsers keep).

Starting source: `main` at `62fd8394`, branch `perf/included-digest-urls`;
`main` was merged in three times: `f7a1ba01` (a desktop-staging fix) before the
final review, then `981182d9` (#761's catalog validator and #762, import-only
conflict in `routes/content.py`) and `bdb7cddd` (#764's Library previews
capability, which took `local-http` 19.0.0 first; see D8).

Intended changes:

1. Backend, test first:
   - `ContentCatalogService.open_included_file(file_ref, sha256, user_id)`:
     the visible registration must be Included and carry that digest, else
     `ContentNotFoundError`; then the same verified open as today.
   - Route `stream_included_content_file` at the digest path: same integrity
     (409) and thumbnail handling as `stream_content_file`, answered with
     `file_response(..., revalidate=True, immutable=True)`. Inventory entry,
     stage 3, `bytes`.
   - `content_file_url(file_ref, sha256, source)` in `app/services/content_file_urls.py`;
     `PyContentFile.url`, `PyTypedContentFile.url`, the presentation candidate's
     source and the portrait URL use it.
2. Web: regenerate the SDK; `contentThumbnailUrl` and `particleThumbnailSource`
   use `file.url`; the Anima presentation image fetch uses `cache: "default"`;
   fixtures gain `url`. Bump `local-http` to 20.0.0 and `runtime-contracts` to
   0.20.0 (a structural OpenAPI change and changed declarations; see D8).
3. Docs: `docs/backend/architecture/http-api.md`,
   `docs/backend/architecture/local-content-storage.md`,
   `docs/frontend/architecture/local-content-runtime.md`,
   `contracts/hosted-web.md`, ADR 0033 and the ADR index.

Checks (record below): new and touched backend tests, `uv run ruff check`, the
Python import-boundary check, `pnpm openapi-ts` drift, affected web unit tests,
`pnpm verify`, a browser journey for the second visit, then the full pre-push
suite before review.

Completion: the acceptance below holds, checks pass and review finds no
supported blocking defect.

Check record (implementer, 2026-10-28; macOS arm64, Python 3.12.13, Node 24, pnpm 10.33.0;
working-tree hashes use the index-copy recipe):

- Red first: the three tests in `tests/test_included_content_digest_urls.py` failed
  before the backend change (`KeyError: 'url'`; the digest path answered 404 where
  422 was expected); `contentThumbnail.test.ts` and
  `useAnimaPresentationImage.test.tsx` failed before their fixes.
- Full pre-push suite through `scripts/heavy-slot.py` on tree `b8f1c454`: from
  `src/frontend`, `pnpm verify` passed (189 s), `pnpm web:test:browser` passed
  (730 s), `pnpm prettier:check`, `pnpm openapi-ts:check` and
  `pnpm e2e:check:source` passed. Root `make check-test` failed at mypy
  (`no-any-return` in the new test); fixed in tree `9d9fe34d`.
- Checks reviewer on `9d9fe34d`: 14 affected backend test files, 98 passed; ruff
  check and format check, mypy on the 19 changed Python files, the import-boundary
  check (0 forbidden edges), `pnpm openapi-ts:check` and 97 web test files
  (660 tests) passed.
- Mutation checks (implementer, after review): dropping the digest comparison in
  `open_included_file` fails 2 of the 3 new tests; naming every file by its plain
  URL fails 4 tests across the new file, `test_pose_content.py`,
  `test_avatar_portraits.py` and `test_anima_presentations.py`. Both restored.
- Browser journey on the built named stack `animama-digest`: the first run failed
  on the second visit (see Surprises); after the presentation fetch fix, on
  `/library?section=fx`, it passed with 136 Included digest reads on the first
  visit and 136 of 136 from the browser cache on the second.

#### Code Review #1 Findings

Reviewed source: working tree `9d9fe34d` against `62fd8394`; analysis reviewer and
an independent checks reviewer (results above).

- F1 (blocking): `contracts/hosted-web.md` narrowed the hosted exception to
  Included files at their digest URLs, although ADR 0033 keeps the revalidated
  `file_ref` reply for clients that still read by registration.
- F2: a consumer composition that stores only selected immutable replies must
  recognise the digest route when it adopts `local-http` 19.
- F3: the `IMMUTABLE_PRIVATE` comment in `server/product_ports.py` named only
  runtime revisions.
- F4: `content_thumbnails.py` did not say that kept thumbnails need a new variant
  name for a format change.
- F5: plan and ADR drift (helper location, decision range, missing check record).
- F6: `PyTypedPreviewFile` redeclares `url: str`, now inherited.
- F7: the journey asserted only digest-URL reads, so a reader that still named an
  Included file by `file_ref` alone would pass.
- F8 (style): `_registered_file_response` receives an un-awaited coroutine.

#### Code Review #1 Revisions

- F1 accepted: the exception now lists Included content files "revalidated by
  ETag, or kept as immutable at their digest URLs".
- F2 accepted as a pull-request note; no public change.
- F3, F4 accepted: comments updated.
- F5 accepted: plan and ADR corrected; this record added.
- F6 rejected: behaviour-neutral, and removing it would only churn the generated
  schema.
- F7 accepted: the journey reads the catalog, treats every read of an Included
  `file_ref` as an Included read whatever its URL, and requires each to be a
  digest URL on the first visit and served from cache on the second.
- F8 rejected: the coroutine is awaited first inside the `try`, which keeps the
  404/409/422 mapping in one place.
- Repair round 1 of 2. Repair evidence on tree `852f3ee3` (committed as
  `10212469`): `pnpm e2e:check:source` passed and the journey passed again
  (136 Included reads, all digest URLs, 0 other reads; 136 of 136 from cache on
  the second visit).

#### Code Review #1 Recheck

Targeted recheck of tree `852f3ee3`: F1, F3, F4, F5 and F7 verified; the F6 and
F8 rejections judged reasonable; no regression; result pass. The recheck reran
`pnpm e2e:check:source` and ruff check and format check on the repaired Python
files. It suggested one non-blocking guard, applied afterwards: the journey also
requires every digest read to name a catalog Included `file_ref`, so an empty or
misread catalog cannot make the Included-read check vacuous (`pnpm
e2e:check:source` passed; the journey reruns with the final candidate).

## Final integration review

Code Review #2 (final integration, high-risk tier) of `4b669f03` against
`f7a1ba01`, running no checks: all six acceptance criteria met in code; docs,
contracts, ADR and versions agree; no private names; result pass. Non-blocking:

- N1: rerun the journey on the final candidate. Done: passed on a stack rebuilt at `069c7673` (136 Included reads, all digest URLs, 0 other reads; 136 of 136 from the browser cache on the second visit).
- N2: ADR 0033 said every client reads the server's URL, but voice sample playback
  still reads by `file_ref`. Fixed in `1d883cc2` (docs only).
- N3: these plan records. Done here.
- N4: the issue's scene criterion is met for content-file reads (presentation
  images and portraits). A scene's remaining revalidations are runtime delivery
  reads (JSON bundles and two revision-member fetches with `cache: "no-cache"` in
  `runtimeContentDelivery.ts`), outside this plan; the pull request names them
  as a follow-up.

The full pre-push suite first passed on `4b669f03` (tree `c839d0a9`). After the
later merges it ran once more on the final candidate: tree `205f2dbf` (HEAD `069c7673`). From `src/frontend`, `pnpm verify` passed (635 test files, 6,025 tests), `pnpm web:test:browser` passed (136 of 136), and `pnpm prettier:check`, `pnpm openapi-ts:check` and `pnpm e2e:check:source` passed. Root `make check-test` failed twice on one test, `tests/test_model_assets.py::test_an_interrupted_http_body_logs_its_cause_and_resumes_with_a_range` (5,093 passed, 1 failed). The test passes alone and with its own file, this branch does not touch it, and `main` at `bdb7cddd` fails it identically in a clean detached worktree (5,090 passed, 1 failed), so the failure comes from `main`'s test ordering, not this change.

Package-set compatibility on the final candidate: `build.py build` of `bdb7cddd` (base) and `069c7673` (candidate), then `build.py compare`, reported "Compatibility policy passed".

## Validation and acceptance

- A second visit to the Library sends no request for an unchanged Included file:
  a browser journey (`accountless Library keeps Included files between visits`)
  opens the Library's FX section twice in one browser context, as new documents,
  and finds every digest-URL read of the second visit (Library thumbnails,
  particle manifests and the sidebar's presentation images) served from the
  browser's cache. A probe of the same page on the task stack read 136 Included
  files on the first visit and sent 0 of them to the server on the second.
- A release that changes an Included file's bytes changes its URL: a backend
  test reconciles changed Included bytes, keeps the `file_ref`, names a new URL,
  refuses the old URL with 404 and serves the new one as immutable.
- An owner's file URL and policy are unchanged: a backend test finds the owner
  file named by `/v1/content/files/{file_ref}` with `private, no-cache`, and its
  digest path refused.

## Idempotence and recovery

The change adds a route and a response field; it writes no data and needs no
migration. Reverting the commit restores today's URLs. A browser that kept a
digest-URL reply holds exact bytes for that digest, which stay correct for it.

## Outcomes & Retrospective

Delivered for review: Included content files have digest-keyed URLs that the
browser keeps, and the descriptors name them. The Library's FX section reads 136
Included files on a first visit and sends none of them on a second. Lessons: a
client's `cache: "no-cache"` silently defeats an immutable reply, so cache
evidence must come from a browser (CDP wire status), not response headers alone;
the runtime delivery helpers have the same pattern and are the follow-up.
