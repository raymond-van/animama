# 0033: Digest-keyed URLs for Included content files

- Status: proposed (for owner acceptance with the PR)
- Recorded: 2026-10-28
- Retrospective: no
- Original decision date: 2026-10-28, through the implementation plan for [#763](https://github.com/raymond-van/animama/issues/763)
- Decision basis: Agent proposal within the options the issue states; awaiting the owner's review with its pull request

## Context

A content file is read at `/v1/content/files/{file_ref}`. A `file_ref` names an
item's path and survives a release that changes the file's bytes, so its replies
are `private, no-cache` and revalidated by their digest ETag. Each Library visit
therefore sent one conditional request per Included image, and each request
authorized and opened the file record again. A Library page or a scene was never
free of these requests, although Included files change only with a release.

Runtime revision members are already kept as immutable because their URLs name an
exact revision (ADR 0028).

## Decision

- Every Included content file is also served at
  `/v1/content/files/{file_ref}/sha256/{sha256}`. The route answers only while the
  file is Included and its registered digest is `sha256`; otherwise it is
  `404 content_file_not_found`, so it never answers with other bytes. Shared routes
  pass `immutable=True` to `ProductPorts.file_response` for it, and the local
  composition answers `private, max-age=31536000, immutable`. Its thumbnail variant
  is kept the same way, since it derives from the exact source digest.
- Catalog items, typed content files, Anima presentation images and Avatar portraits
  name each file by a `url`: the digest path for an Included file and
  `/v1/content/files/{file_ref}` for every other file. Library thumbnails, particle
  manifests and Anima presentation images read the URL they are given instead of
  building one from `file_ref`, with a cache mode that lets the reply's policy
  decide reuse (`<img>` loads, and `cache: "default"` for the presentation image
  fetch, which used `no-cache`). Readers that still name a file by `file_ref`, such
  as voice sample playback, keep the revalidated reply.
- Owner and installation-shared files, previews, runtime manifests and bundles keep
  their policies. Nothing is offered to shared caches: the policy stays `private`.

## Rationale and consequences

- A second visit reuses unchanged Included files without a request. A release that
  changes a file changes its digest and so its URL; the old URL is refused.
- A distinct path, rather than a `?sha256=` query, lets a composition recognise the
  immutable replies by path alone and composes with `?variant=thumbnail`.
- Authorization still runs for every request that reaches the server. A kept reply
  is reused without a request only in the browser profile that already received it,
  for exact Included bytes that every caller may read. A composition that clears
  kept replies at sign-out clears these too.
- A change to the thumbnail format does not reach thumbnails already kept under a
  digest URL; such a change needs a new variant name.
- Requests that still name an Included file by `file_ref` alone keep today's
  revalidated reply.

Alternatives considered: a `?sha256=` query on the existing route (a path-only cache
rule cannot tell it apart); digest URLs for every file (owner bytes would then be
kept for a year after an edit or deletion); and a stronger ETag policy alone (it
still costs one request per file per visit).

## Evidence

- [ExecPlan](../plans/included-digest-urls/included-digest-urls-execplan.md): decisions
  D1–D8, the checks and the browser journey.
- `src/backend/animama/product_http/routes/content.py` (`stream_included_content_file`),
  `src/backend/animama/app/services/content_file_urls.py` and
  `ContentCatalogService.open_included_file`.
- `tests/test_included_content_digest_urls.py` and the Library journey in
  `src/frontend/e2e/journeys/accountless-library.spec.ts`.
