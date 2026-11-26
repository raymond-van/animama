# Send images to the Anima in chat

Source agreement: [#904](https://github.com/raymond-van/animama/issues/904),
published from the agreed [spec](chat-image-input-spec.md) at
2026-11-24T16:51:31Z (accepted by the owner on 2026-11-24 with the recommended
defaults).
Authorized scope: the whole plan. The owner approved this plan, including D1
to D7, and Phase 1 on 2026-11-24 (G0), then authorized Phases 2 to 7 the same
day. G1 to G3 still need the owner.
Planning baseline and implementation base: `origin/main` at `f612be08d`.
Workspace: worktree `chat-image-input`, branch `feat/chat-image-input`. Task
stack `animama-cii` (development build, `ANIMAMA_LLM_SKIP=1`) at
http://animama-cii.localhost:8400, started in Phase 5; tear it down after the
last manual check.

## Purpose and context

After this plan, a person using the desktop app or a self-hosted stack can
pick, paste or drag up to four images into the chat composer. A model that
accepts images receives them with the message through any of the three model
adapters, earlier images stay available for follow-up questions, and the chat
shows thumbnails live and after a reload. With a model that cannot take images
the composer says so and the API refuses the turn. Hosted, image output and
OCR are out of scope. The database schema does not change.

Orientation, from read-only surveys on 2026-11-24 (paths under
`src/backend/animama` unless they start with `src/frontend`, `tests` or
`docs`; line numbers at `f612be08d`):

- **Uploads.** `server/routers/user_files.py` owns the lifecycle:
  `POST /v1/files/uploads` (L170) validates the name and size through
  `app/services/user_file_service.py` (`ALLOWED_USER_FILE_EXTENSIONS` L25,
  validation L120) and creates a `pending_upload` row with the locator
  `user-files/{user}/{file}/original`; `PUT /v1/files/{id}/content` (L223)
  spools the body into private storage; `:finalize` (L265) checks the stored
  size and sets `uploaded`. Finalize neither inspects the bytes nor computes a
  digest. The client then calls `:process` (L343), and the processing runner
  sets `ready` or `ready_keyword_only` with chunks. Statuses are string
  constants in `domain/user_file.py` L7-15. `orm/user_file.py` has no kind
  column; its `metadata` JSON is the extension point.
- **Storage.** `app/ports/private_file_storage.py` (`put_stream`,
  `open_bounded`, `head`, `delete`) with the filesystem adapter
  `adapters/content_store/private_file_store.py` L66. `put_stream` replaces
  atomically. Delete removes the one locator of a file.
- **Images.** `app/services/content_image.py` decodes with Pillow under global
  limits (40 megapixels, 16,384 px a side, decompression-bomb warnings raised
  as errors). `canonicalize_image_stream` (L139) applies EXIF orientation,
  scales down, copies pixels into a fresh image (which drops metadata) and
  encodes WebP. It accepts PNG, JPEG and WebP only, and rejects animated PNG
  and WebP (`_require_supported_frame_policy` L373). Callers run it through
  `asyncio.to_thread`. `app/services/content_thumbnails.py` `thumbnail_file`
  (L83) derives a cached 128 px WebP thumbnail from PNG, JPEG or WebP bytes.
- **Serving bytes.** `product_http/delivery.py` `verified_file_response` (L70)
  streams with an `ETag`, `X-Content-Type-Options: nosniff` and a sandbox
  CSP. `product_http/routes/content.py` L195 is the model: it depends on
  `get_current_principal`. No route returns user-file bytes.
  `product_http/inventory.py` L284-292 lists the user-file routes as
  `_excluded("chat_file_uploads", ...)`, and
  `tests/test_product_http_inventory.py` requires every local route there in
  mount order.
- **Turn setup.** `product_http/chat/turn_setup.py` `prepare_direct_chat_turn`
  (L141) calls `validate_searchable_attached_files`
  (`app/chat/memory_search.py` L112), which keeps files that are `ready` or
  `ready_keyword_only` with chunks and drops the rest with a log line. It
  builds `DirectChatTurnRequest` (`app/chat/direct_turn/types.py` L48) with a
  string `user_message`. `DirectChatTurnSetupError` maps to HTTP 400 (L279).
- **Prompt and history.** `app/chat/openai_prompt.py`
  `DirectChatPromptAssembler.assemble` (L123) builds the current user message
  from a string (L201-207); models without a developer role get a
  `<turn_context>` text prefix (L242). Prompt messages are plain dicts in Chat
  Completions shape (`app/model_clients/prompt.py` L34). The user row is saved
  in `app/chat/direct_executor.py` (L928-947) with `content`, `data`
  (`attached_file_ids`) and `raw_provider_message`. Later turns replay
  `raw_provider_message` verbatim (`_history_message`, `openai_prompt.py`
  L635), so its shape is sent on every later turn through every adapter.
- **Adapters.** OpenAI Responses (`adapters/model_clients/openai_responses/request.py`
  `_input_items_from_message` L212) silently drops a message whose content is
  not a string. Chat Completions (`openai_chat_completions/request.py`
  `_messages_for_spec` L72) passes a parts list through unchanged. Anthropic
  (`anthropic_messages/request.py` `_content_blocks` L447) passes parts
  through as blocks. With an OpenAI Responses cursor
  (`previous_response_id`) no history is loaded; a stale cursor reloads it.
- **Budgets and logs.** `app/model_clients/context_budget.py`
  `estimate_value_tokens` (L105) estimates from the JSON text of a message, so
  inline base64 would count as hundreds of thousands of tokens.
  `app/model_clients/logging_context.py` `_prompt_preview` (L95) logs a JSON
  preview of prompt messages when previews are enabled.
- **Capabilities.** The executor reads `model_provider.capabilities.accepts`
  (`domain/model_provider.py` L17). Catalog models declare it
  (`app/model_catalog.py`); for an owner-configured model it comes from the
  owner's "accepts images" setting
  (`app/services/model_configuration_service.py` L646). Probes do not detect
  it. The chat page sees `accepts` on `PyModelProviderCatalogItem`.
- **Text readers.** Compaction, Memory Manager reflection, the search vector
  and title generation read `chat_messages.content` or the request text.
- **Composer.** `src/frontend/web/src/lib/user-files/uploads.ts` holds the
  accepted extensions and Uppy restrictions. `useUserFileUpload`
  (`web/src/hooks/useUserFileUpload.ts`) runs init, PUT, finalize, then
  process. `chat-attachments.ts` and `chat-attachment-hold.ts` let a file be
  attached or sent only when it is `ready` with chunks.
  `web/src/ui/main/chat/ChatInterface.tsx` wires the tray, the popover and
  the model note (`composer.files.noToolsNote`, L313-319).
  `ChatFileDropOverlay.tsx` handles drops. Nothing handles paste, and the tray
  is never cleared after a send.
- **Messages.** `packages/product-ui` owns `ChatConversation` and
  `ChatDisplayMessage` (`src/lib/chat/display-message-mapping.ts`), which
  carries text only. The history API already returns `data.attached_file_ids`.
  Private images elsewhere load through fetch and a blob URL
  (`web/src/query/hooks/useRuntimeContentMediaUrl.ts`). The app's CSP allows
  `blob:` images. `web/src/ui/components/dialog.tsx` is the only dialog.
- **Packages.** A structural change to the local OpenAPI contract needs a new
  `local-http` major in `contracts/versions.json` (now `23.0.0`). A changed
  product-ui or runtime-contracts declaration needs a package version bump
  (now `0.20.0` and `0.23.0`). `scripts/package-sets` `compare` enforces both.
- **Records.** `licenses/source-review.json` lists every tracked file; each
  phase adds entries for its new files.

Provider facts, read from the official documentation on 2026-11-24:

| | Anthropic Messages | OpenAI Responses and Chat Completions |
| --- | --- | --- |
| Formats | JPEG, PNG, GIF, WebP; first frame of an animation | PNG, JPEG, WebP, non-animated GIF |
| Wire shape | `{"type": "image", "source": {"type": "base64", "media_type", "data"}}` | Responses `{"type": "input_image", "image_url": "data:…", "detail": "auto"}`; Chat Completions `{"type": "image_url", "image_url": {"url": "data:…"}}` |
| Per image | 10 MB base64, 8000 × 8000 px | Rejected above 30,000 patches of 32 px after resizing |
| Per request | 100 images (200k-context models) or 600; 128 MB. Above 20 images every image must fit 3,000 px a side | 1,500 images; 512 MB |
| Tokens | `ceil(w/28) × ceil(h/28)`, capped at 1,568 or 4,784 by model tier | `ceil(w/32) × ceil(h/32) × 1.2` for current models |

The agreed limits fit: a 2000 px long edge, 20 images in a request and a
canonical copy of at most 3.5 MiB (under 5 MB as base64). One estimate,
`min(ceil(w/28) × ceil(h/28), 4784)`, is an upper bound for every adapter.

## Progress

- [x] Phase 0: issue #904 published, spec snapshot and plan tracked.
- [x] G0: the owner approved the plan and Phase 1 (2026-11-24).
- [x] Phase 1: image uploads are validated and stored as canonical copies.
  Three reviews; all blocking findings repaired. P1-A13 moves to Phase 2.
- [x] Phase 2: the owner can fetch image bytes. Two reviews; should-fix
  items repaired; chat deletion moves to Phase 3 (D12).
- [x] Phase 3: a turn with images is checked, saved and assembled without bytes.
  Two reviews; all findings repaired.
- [x] Phase 4: each adapter sends images. Two reviews; should-fix items
  repaired. G1 confirms against real providers.
- [x] Phase 5: the composer accepts images. Re-tiered high risk; two
  reviews and an independent checks rerun; all blocking findings repaired.
- [x] Phase 6: chat and the Library show images. Three reviews and two
  independent checks reruns; package-set compatibility passed against `main`.
- [x] Phase 7: documentation and decision record (light tier; covered by the
  final integration review).
- [x] Final integration review (three rounds, pass) and the full pre-push
  suite (G3, passed).
- [x] Pull request #923; the OpenAI mid-stream error fix joined it at the
  owner's request, and the full suite passed again on `2fad4050b`.
- [x] G2: the desktop check passed, except that a Safari- or Firefox-style
  "Copy Image" paste (image plus URL text) pastes the URL (P5-A15, emulated).
- [ ] G1 for the OpenAI families (Anthropic passed; the OpenAI account has no
  credit).

## Surprises & Discoveries

- 2026-11-24 (planning): provider limits differ from older published figures
  (Anthropic allows 10 MB an image and 600 images; OpenAI allows 512 MB and
  1,500 images). The binding limits are Anthropic's rule above 20 images and
  the safe 5 MB base64 size, which the agreed defaults already meet.
- 2026-11-24 (planning): replaying `raw_provider_message` verbatim means
  inline image bytes would be stored in every user row, resent each turn and
  counted as text tokens. The plan stores references instead (D1).
- 2026-11-24 (planning): OpenAI Responses requests carry the existing inline
  moderation field, which scores the whole request input. Images in a
  Responses turn are therefore covered by that existing check. No moderation
  call is added (R4.2); the operator check on Anthropic turns stays text-only.
- 2026-11-24 (planning): the composer keeps attachments after a send. That
  suits documents, which the Anima searches on every turn, but would attach
  the same image again each turn (D5).

- 2026-11-24 (Phase 1): the backend guide says upload bytes are never parsed
  in the server process. That rule was written for document parsers. Chat
  images are decoded in the server with Pillow, as content images already are
  (D8); the guide now says so.
- 2026-11-24 (Phase 1): Pillow refuses `formats=["MPO"]` because the JPEG
  decoder opens multi-picture files, so the decoder list leaves MPO out.
- 2026-11-24 (Phase 1): saving a JPEG with `optimize=True` at full colour
  resolution fails on a noisy image ("broken data stream"), because Pillow
  sizes one buffer from the pixel count. The encoder runs without it.
- 2026-11-24 (Phase 1, review): Pillow's decoders raise `SyntaxError`,
  `IndexError`, `TypeError` and `struct.error` on damaged input, beyond the
  error types the existing image code catches. `ImageOps.exif_transpose`
  fails on a photo with one malformed EXIF tag because it rewrites the EXIF
  block. The chat path reads the orientation itself and treats every decoder
  error as an unreadable image. The older content-image functions keep their
  narrower handling; changing them is outside this plan.
- 2026-11-24 (Phase 1, review): Pillow scales palette and 1-bit images with
  nearest-neighbour and clips 16-bit greyscale when converting. The chat path
  converts to 8-bit RGB first.
- 2026-11-24 (Phase 1, review): storage `delete` succeeds for a missing file.
  An earlier draft kept a refused upload's bytes on the opposite assumption.

## Decision Log

- 2026-11-24, owner: scope is local compositions only; the recommended
  defaults for formats, limits, replay, storage, moderation and originals are
  accepted (recorded in #904).
- 2026-11-03, owner (standing instruction, recorded during #823): phases run
  the checks their changes affect, not the full pre-push suite. The full suite
  runs once on the final candidate after the owner agrees to the run (G3).
- 2026-11-24, owner: plan approved with D1 to D7 as proposed; Phase 1
  authorized (G0).
- 2026-11-24, owner: Phases 2 to 7 authorized ("the rest of the execplan once
  phase 1 is complete").
- 2026-11-24, agent proposals, approved by the owner at G0. Each is an
  implementation choice inside the agreed behavior:
  - **D1. References, not bytes.** A user message with images is saved as
    text plus image reference parts (`file_id`, name, width, height). The
    executor loads bytes from private storage just before a request and hands
    them to the adapter beside the prompt. Rows, logs, previews, estimates and
    prompt copies never hold bytes (R2.3).
  - **D2. One stored copy.** At finalize the canonical copy replaces the
    uploaded bytes at the same locator, so delete and storage accounting stay
    as they are (R1.3, R3.3).
  - **D3. Canonical format.** PNG when the source is PNG or GIF and the result
    is at most 3.5 MiB, otherwise JPEG at quality 90 with transparency
    flattened onto white. WebP is not sent because support varies among
    OpenAI-compatible local servers.
  - **D4. Text stays required.** A turn still needs a message; an image alone
    cannot be sent. Title generation, reflection and search keep a text
    anchor, and the request contract is unchanged.
  - **D5. Images are attached for one turn.** After a successful send the
    composer drops its image attachments and keeps its documents. Earlier
    images reach the model through history replay.
  - **D6. A missing image stops the turn.** If an attached image no longer
    exists or is not ready, the API refuses the turn with a clear error.
    Documents keep today's drop-and-log behavior.
  - **D7. Placeholders in saved text.** `content` holds the person's text
    followed by one `[Image: name]` line per image, so every text reader sees
    it (R4.1). `data` keeps the person's text and the image list so the
    bubble shows text and thumbnails without placeholder lines.

- 2026-11-24, agent (Phase 1), within the approved behavior:
  - **D3, extended.** When quality 90 does not fit 3.5 MiB the JPEG encoder
    steps down (82, 74, 66, 58, 50) and then refuses. Random noise at
    2000 × 2000 fits at quality 50, so a refusal is practically unreachable.
  - **D8. Chat images are decoded in the server.** Finalize decodes on a worker
    thread through the bounded opener content images use, restricted to the
    PNG, JPEG, WebP and GIF decoders, at most two images at a time. The parse
    child stays for documents: it returns text over a pipe and serves a
    durable job, and R1.4 gives images no job. The owner can redirect this
    without changing the stored format.
  - **D9. The kind is recorded when the upload starts.** `metadata.kind` is
    `"image"` from init, and `metadata.image` (width, height, media type) is
    added when the canonical copy is stored. One predicate reads the kind.
  - **D10. Storage changes run under the row lock.** Decoding takes no lock.
    The service re-reads the row for update and checks it is still an
    uploaded image before the canonical copy is written or a refused upload
    is deleted, so a delete or a second request during decoding cannot be
    followed by a write.
  - **D11. `:process` completes an interrupted image.** A finalize that stops
    after marking the file uploaded cannot be retried (the upload is no longer
    pending). `:process` stores the canonical copy for such an image and
    otherwise returns an image's state without a job. Phase 5 makes the
    composer call it when a finalize fails.

- 2026-11-24, agent (Phase 2 review), within R3.3:
  - **D12. Deleting a chat deletes its images when nothing else uses them.**
    When a chat is deleted, each image its user messages reference is deleted
    like a file the person removed, unless a message in another chat
    references it too (an image can be attached again from the Library).

- 2026-11-24, agent (Phase 5), within R2.2:
  - **D5, revised.** The shared chat session reports a turn's attachments
    (`onAttachmentsSubmitted`) when the turn completes, which is when the
    server has saved it, and the composer removes the images among them. A
    turn that is refused (for example `attached_image_unavailable` or
    `runtime_remount_required`), fails after its reply starts, or is stopped
    keeps them, so the failure guidance can say to remove or replace them
    and a resend carries them again. (Phase 5 first cleared them when the
    send was accepted, then at the first stream event; the final review,
    F-A2, showed a turn failing after that is never saved.)
  - **The product-ui version moves in Phase 5.** The session option and three
    chat failure codes change product-ui's declarations, so 0.21.0 lands
    here. Phase 6 ships in the same pull request and needs no second bump.

- 2026-11-24, agent (final review), for the owner to confirm at pull request
  review:
  - **D13. Deleting an Anima leaves its chats' images.** The Anima's chats go
    by database cascade, which does not run the chat-delete image cleanup
    (D12), so their images stay in private storage and in the Library, as
    document attachments do. The owner can delete them there. Cleaning them
    up with the Anima needs another repository query (images referenced only
    by that Anima's chats) that Cloud would also have to implement.

- 2026-11-24, agent (final review), within R4.1: the spec lists copied text
  among the readers that see an image's placeholder. The chat bubble shows
  `data.user_text` (D7) and the app has no copy action for messages, so the
  placeholder reaches compaction, memory and search, which is the part of
  R4.1 that matters: no reader gets bytes.

- 2026-11-24, owner: fold the fix for OpenAI mid-stream error events into
  this pull request (found during G1), instead of a separate one.

## Phased implementation

Each phase starts from the previous phase's commit and writes its tests first.
Phases 1 and 2 need nothing else. Phase 3 needs Phase 1's image facts. Phase 4
needs Phase 3. Phase 5 needs Phases 1 and 3. Phase 6 needs Phases 2 and 5.
Phase 7 follows Phase 6.

### Workspace setup

After G0, in worktree `chat-image-input`:

1. Merge `origin/main` if it moved. Run `uv sync --python 3.12.13 --extra
   voice --extra viz --extra realtime --extra encrypt --extra documents
   --all-packages --group dev` (the `make sync` set, pinned to Python
   3.12.13). Before the frontend phases run `pnpm install` in `src/frontend`,
   and run `git lfs pull` before backend content tests.
2. Set #904's triage label to `triage:ready-for-agent`.

### Phase 1: Image uploads are validated and stored as canonical copies

Review tier: high risk (decoding untrusted files, removing private metadata,
stored private data).

Requirements: R1.1 (server limits), R1.2, R1.3, R1.4 (server), R1.5 (errors).

Starting revision: `bdc7ea710`. Built as follows, tests first in
`tests/test_content_image.py` and `tests/test_user_file_uploads.py`:

1. `content_image.py`: `canonicalize_chat_image_stream` takes only the bytes.
   It opens them with the PNG, JPEG, WebP and GIF decoders through
   `_open_bounded_formats` (split out of `_open_bounded_image`, which now also
   restricts Pillow to the decoders its extension allows), takes the first
   frame, converts to 8-bit RGB or RGBA, scales the long edge to 2000 px,
   applies the EXIF orientation, copies the pixels into a fresh image and
   encodes per D3. A pixel-budget refusal now has that reason for a
   decompression bomb too, for every caller of the opener.
2. `user_file_service.py`: image extensions with a 20 MiB limit, a refusal
   that names HEIC and HEIF, the kind recorded at init (D9), and
   `complete_image_upload` and `fail_image_upload` (D10).
3. Finalize: for an image, the router decodes the stored upload on a worker
   thread, then the service stores the canonical copy at the same locator and
   sets `ready`, the stored size, digest, media type, `processed_at` and
   `metadata.image`. A file that cannot be stored as an image becomes `failed`
   with a reason for the composer, and its uploaded bytes are deleted.
4. `:process` on an image returns its state without a job, first completing an
   image left at `uploaded` (D11).
5. `src/backend/AGENTS.md` and one sentence of
   `docs/backend/features/user-files.md` describe the in-server decode. The
   rest of the documentation is Phase 7.

Completion: an uploaded image ends `ready` with a canonical copy and image
facts; the original bytes are gone; a refused upload is `failed` with a reason
and no bytes; documents behave as before.

Recovery: a read failure, a write failure or a server fault leaves the row
`uploaded` with the original bytes; `:process` completes it, and delete
removes it. Only a refusal of the image itself fails the file and deletes its
bytes.

Check record (working directory: the checkout root; all on the working tree
recorded under Code Review #2 Revisions):

| Command | Result |
| --- | --- |
| `uv run --no-sync ruff format --check src/backend/animama tests` | exit 0 |
| `uv run --no-sync ruff check` | exit 0 |
| `uv run --no-sync mypy src/backend/animama tests` | exit 0, 907 files |
| `uv run --no-sync python scripts/repository-boundary/check-python-imports.py` | exit 0 |
| `timeout 900 uv run --no-sync pytest -q -n 2` on the 16 files below | exit 0, 367 passed |
| `timeout 900 uv run --no-sync pytest -q -n 2` on the 27 wider files below | exit 0, 310 passed |
| `uv run --no-sync python -m animama.server.export_openapi --output <file>` | byte-identical to the export from `main` |

The 16 files: `test_content_image`, `test_content_gltf`,
`test_content_thumbnails`, `test_user_file_processing`,
`test_user_file_processing_runner`, `test_user_file_parsers`,
`test_user_file_uploads`, `test_user_file_storage`,
`test_runtime_capabilities`, `test_product_http_inventory`,
`test_content_package_import_resources`, `test_typed_content_apis`,
`test_anima_creation_batching`, `test_accountless_repository_boundaries`,
`test_openapi_export`, `test_product_http_runtime_capabilities`.

The 27 wider files are the other tests that reach the shared image opener:
`test_anima_chat_profile`, `test_anima_creation`, `test_anima_creation_voice`,
`test_anima_reaction_pools`, `test_anima_starters`, `test_avatar_face_parts`,
`test_avatar_settings`, `test_content_evidence`,
`test_content_package_cross_installation`,
`test_content_package_export_review`, `test_content_package_import_anima`,
`test_content_package_import_avatar`, `test_content_package_voice_export`,
`test_content_portrait_mutation_replay`, `test_creation_content_admission`,
`test_included_content_catalog`, `test_included_content_digest_urls`,
`test_included_derivative_packaging`, `test_included_derivatives`,
`test_local_content_catalog`, `test_non_portable_packages`,
`test_optional_sound_dependencies`, `test_product_http_typed_content`,
`test_runtime_content_catalog_completeness`, `test_starter_content_closure`,
`test_typed_content_preview_batch`, `test_generate_synthetic_docs`.

Not run: the full pre-push suite (owner's standing instruction; G3), and
`pnpm openapi-ts:check`, because the worktree has no frontend dependencies
yet. The identical schema export shows the generated client is not stale.

#### Code Review #1 Findings

Reviewed source: uncommitted working tree `74319f4248e7` on `bdc7ea710`, high
risk, initial review, by an analysis reviewer and a checks reviewer. The
checks reviewer reproduced all four recorded checks (329 passed) and ran 30
more test files that reach the changed code (327 passed).

Blocking:

- **P1-A1.** Decoder errors outside the caught types (`SyntaxError`,
  `IndexError`, `TypeError`, `struct.error`) escaped as HTTP 500 and left the
  row `uploaded` with its original bytes. Found by mutating 52,000 inputs; a
  rotated JPEG with one mistyped EXIF tag reproduces it.
- **P1-A2.** The canonical copy was written before the row was locked or
  re-checked. A delete during decoding was followed by a write that no API
  could remove, and a concurrent `:process` could overwrite the copy after its
  size and digest were recorded.
- **P1-A3.** A refused upload kept its original bytes, against R1.3. The
  reason given for keeping them was wrong: deleting a missing file succeeds.
- **P1-C1.** The longer `process_user_file` docstring changed the operation's
  OpenAPI description, so the generated client was stale.

Should fix:

- **P1-A4.** A decompression bomb was reported as an unsupported format.
- **P1-A5.** `PrivateFileReadError` was not caught, so a read failure was an
  unlogged 500 instead of a 503.
- **P1-A6.** 16-bit greyscale PNGs were stored nearly white.
- **P1-A7.** Palette and 1-bit sources were scaled with nearest-neighbour.
- **P1-A9, P1-C4.** No tests for the read, write and conflict failures, the
  other refusal messages, a pixel-area refusal, a multi-picture source, or the
  real storage adapter.
- **P1-A10, P1-C6.** Inexact guide wording, unrecorded plan deviations and a
  misleading sentence in `user-files.md`.
- **P1-C2.** `test_accountless_repository_boundaries` was missing from the
  record.

Optional, not taken: sharing the decode steps with `canonicalize_image_stream`
(the chat path now differs on purpose, and changing content images is outside
this plan); a reduced-size JPEG decode to lower peak memory. Noted, existing
behavior: a `PUT` racing a finalize can rewrite same-size bytes.

Sound as built, per the reviewers: decoder restriction and bounds (a
1,000,000-frame GIF took 0.7 s; no mutated input over 1 s), metadata removal
(output holds only image data chunks), ownership checks, no change for the
existing callers of the opener across 61,335 comparisons, the document paths.

#### Code Review #1 Revisions

Repair round 1 of 2. Every finding was verified before the change.

| Finding | Disposition | Change |
| --- | --- | --- |
| P1-A1 | Accepted | The chat path treats any decoder error as `invalid_image`, the opener treats any open error as an unsupported format, and the orientation is read without rewriting EXIF, so a photo with a malformed tag is accepted. Tests: a mistyped-tag JPEG, a PNG with a damaged chunk. |
| P1-A2 | Accepted | D10: the service checks the row under its lock and then runs the write or delete. A conflict returns the file's current state. Tests: delete during decoding (nothing written, 404), another request finishing first (nothing written). |
| P1-A3 | Accepted | A refused upload's bytes are deleted under the same lock, as the plan said. Test covers four refusals. |
| P1-C1 | Accepted | The explanation moved to a comment; the schema export is byte-identical to `main`. |
| P1-A4 | Accepted | A bomb is a pixel-budget refusal for every caller; the thumbnail test that pinned the old reason is updated. |
| P1-A5 | Accepted | Caught with the other read failures; test for the 503. |
| P1-A6 | Accepted | 16-bit greyscale is scaled to 8 bits; gradient test. |
| P1-A7 | Accepted | Conversion happens before scaling; striped palette test for GIF and PNG. |
| P1-A9, P1-C4 | Accepted | Added the tests above plus write failure (507), missing bytes on `:process`, a multi-picture JPEG, both pixel refusals, and finalize against the real filesystem storage. |
| P1-A10, P1-C6 | Accepted | Guide paragraph rewritten; D8 to D11 and this section record the deviations; the `user-files.md` sentence is corrected. |
| P1-C2 | Accepted | Added to the record with two more route and schema tests. |

Verification: the check record above, on working tree `37a7e9b49c39` (taken before this line was filled in). Remaining
repair budget: one round.

#### Code Review #2 Findings

Reviewed source: working tree `774e40e02534` (the repaired tree `37a7e9b49c39`
plus one plan line), high risk, targeted recheck after repair round 1.

The checks reviewer reran all seven checks clean (363 and 310 passed, schema
byte-identical to `main`, no flakiness in three runs) and found P1-C1, P1-C2
and P1-C4 fixed. The analysis reviewer found every accepted finding fixed:
52,000 mutated inputs with nothing escaping, both lock interleavings correct
on PostgreSQL with the real repository and storage, all eight orientations
matching `ImageOps.exif_transpose`, and peak memory unchanged at 634 MiB for a
40-megapixel RGBA source.

Blocking:

- **P1-A11 (new, from the repair).** The catch-all added for P1-A1 also
  covered the server's own encoding and `MemoryError`. With the P1-A3 delete,
  a server fault on a valid photo failed the file, deleted the upload and
  logged nothing.
- **P1-A9 (partly fixed).** The damaged-PNG test used an input the first tree
  already refused, so nothing pinned the wider error handling.

Non-blocking: **P1-A12**, the locked read (an existing repository method) does
not refresh a row already loaded in the session, so D10 depended on no earlier
reference being alive. Also noted and accepted as built: a failed delete of a
refused upload keeps the bytes until the person deletes the file; a damaged
animated GIF is reported as an unsupported file; scaled palette images fall
back to JPEG more often. Coverage gaps left: the 404 after a conflict, a
storage stat error, an invalid locator, the failed-delete warning and the
damaged-EXIF fallback.

#### Code Review #2 Revisions

Repair round 2 of 2.

| Finding | Disposition | Change |
| --- | --- | --- |
| P1-A11 | Accepted | Only the decode steps sit in the catch-all, and `MemoryError` propagates from it and from the opener. Encoding runs outside it, so a server fault raises, the row stays `uploaded` and the bytes stay. A refusal is now logged with its reason. Tests: a failing encoder at function level and through finalize. |
| P1-A9 | Accepted | The test uses a non-letter chunk name and first asserts that Pillow raises `SyntaxError` for it. |
| P1-A12 | Accepted | The locked read uses `populate_existing`. A PostgreSQL test holds a loaded row, changes it from a second session and reads it under the lock; it fails without the option. |
| Refusal message | Accepted | The "too detailed to store" message is asserted through finalize. |
| Remaining coverage gaps | Not taken | Each is a defensive branch with no behavior of its own beyond a status code or a log line. |

Verification: the check record above, on working tree `df7d9f2534bd` (taken before this line was filled in). The repair
budget is used; the next review is the final targeted recheck.

#### Code Review #3 Findings

Reviewed source: working tree `81eb22f7545b` (the repaired tree
`df7d9f2534bd` plus one plan line), high risk, final targeted recheck.

Both reviewers pass the phase. The checks reviewer reran every check from the
record (367 and 310 passed, schema byte-identical to `main`), ran 13 more
files that touch user-file rows or mount the router (405 passed, 1 skipped on
macOS), and showed the locked-read test fails without `populate_existing`. The
analysis reviewer confirmed P1-A11, P1-A9 and P1-A12 fixed: a server fault
(runtime, attribute, memory or decode-step `MemoryError`) leaves the row
`uploaded` with its bytes and `:process` completes it afterwards; the
52,000-input fuzz gives the same refusals as before with nothing escaping;
every new test fails under the mutation it targets; and `populate_existing`
cannot discard unflushed changes in any caller.

Non-blocking, not repaired in this phase because the repair budget is used:

- **P1-A13 / P1-C8.** An `OSError` from the server's own encoder is reported
  as a read failure (logged "User image read failed", answered 503), because
  the storage adapter wraps errors inside its `with` block. The upload is
  kept and `:process` completes it. Phase 2 edits the same router and fixes
  it under its own review.
- The `MemoryError` clauses and the opener's catch-all are verified by probes
  but not pinned by tests. Phase 2 adds a GIF frame-count test for the opener.
- **P1-C7.** The service's locked paths run against PostgreSQL in one test;
  the reviewers covered the rest with scratch probes.
- The Recovery sentence does not cover a commit that fails after the
  canonical write: the row stays `uploaded` with the canonical copy stored,
  and `:process` completes it.

Phase commit: `feat(chat)[p1]: store chat images as canonical copies`.

### Phase 2: The owner can fetch image bytes

Review tier: high risk (ownership boundary, API contract, generated client).

Requirements: R3.2, R3.3 (server).

Steps, tests first in `tests/test_user_file_uploads.py` and
`tests/test_product_http_inventory.py`:

1. Add `GET /v1/files/{file_id}/content` beside the PUT. It requires the
   installation owner, serves only `ready` image files (404 for another
   owner's, a deleted or a non-image file), and answers through
   `verified_file_response` with the digest as `ETag` and
   `Cache-Control: private, no-cache`. `?variant=thumbnail` serves
   `thumbnail_file`'s 128 px copy.
2. Add the route to `product_http/inventory.py` as
   `_excluded("chat_file_uploads", ...)` in mount order.
3. Raise `local-http` to `24.0.0` in `contracts/versions.json`, run
   `pnpm openapi-ts`, raise the runtime-contracts package version, and run
   `pnpm packages:build`.

Checks: the two test files; `uv run ruff check`; from `src/frontend`
`pnpm openapi-ts:check` and `pnpm check`; the package-set `compare` against a
`main` baseline.

Completion: the owner receives image bytes and thumbnails with revalidation;
every other request is refused; the inventory and contract checks pass.

Starting revision: `4f5205edc`, the Phase 1 commit `0c150a155` merged with
`origin/main` at `c7b98f73a`. Built as planned, plus:

- **P1-A13 / P1-C8 (from Phase 1).** The router reads an image's bytes
  (`_read_private_file`) before decoding them, so a storage error is the only
  thing reported as a read failure. An encoder `OSError` now surfaces as
  itself and the upload is kept; the encoder-fault test covers `RuntimeError`
  and `OSError`.
- A GIF whose frame count raises `IndexError` pins the opener's catch-all.
- The route reads the stored copy into memory (at most 3.5 MiB) and checks its
  digest against the record: missing or changed bytes are `409`
  `user_file_content_changed`, a read error `503`. It answers with
  `local_file_response`, the policy content files use.
- `docs/backend/architecture/http-api.md` and the route list in
  `docs/backend/features/user-files.md` describe the route and the image
  behavior of `:finalize` and `:process`.

Check record (working directory: the checkout root unless noted; working tree
recorded under Code Review #1 Revisions; the frontend commands ran on tree
`dc7c88d731b3` and the repair touched no frontend file):

| Command | Result |
| --- | --- |
| `uv run --no-sync ruff format --check src/backend/animama tests` | exit 0 |
| `uv run --no-sync ruff check` | exit 0 |
| `uv run --no-sync mypy src/backend/animama tests` | exit 0, 907 files |
| `uv run --no-sync python scripts/repository-boundary/check-python-imports.py` | exit 0 |
| `timeout 900 uv run --no-sync pytest -q -n 2` on the 16 Phase 1 files | exit 0, 387 passed |
| `pnpm openapi-ts` then `pnpm openapi-ts:check` (in `src/frontend`) | regenerated; "Generated SDK is current (17 files)" |
| `pnpm packages:build` (in `src/frontend`) | exit 0 |
| `pnpm check` (in `src/frontend`) | exit 0 |

Not run: the package-set `compare`, which builds sets from an exact commit and
runs once on the final candidate before the pull request, and the full
pre-push suite (G3).

#### Code Review #1 Findings

Reviewed source: working tree `dc7c88d731b3` on `4f5205edc`, high risk,
initial review. Both reviewers pass the phase with no blocking findings.

The checks reviewer reran every recorded check (379 passed, SDK current,
`pnpm check` clean), added `pnpm packages:check` and `pnpm packages:test`
(61 tests), 17 more backend files on routing, admission and composition (600
passed, 1 skipped on macOS) and the package-set, repository-boundary and CI
script tests. An HTTP probe through the real local app showed the new route
gets exactly the status `GET /v1/files/{file_id}` gets for every request
shape: same-origin `fetch` and `<img>` 200; cross-site, same-site, foreign or
`null` Origin 403; wrong Host 421; desktop without the renderer cookie 401.

The analysis reviewer confirmed ownership (every non-servable case is the same
404, with no existence oracle), headers, the 3.5 MiB memory bound, thumbnails,
the P1-A13 fix, the contract bump and that no stale version remains.

Should fix:

- **P2-A1 / P2-C1.** A parent directory that became unreadable, or was
  replaced by a link, fails in the storage adapter before its own error
  handling, so the route answered a bare 500.
- **P2-A2.** Spec R3.3 also says deleting a chat removes its images' bytes;
  no phase did that, and one image can be attached in several chats.

Optional: describe the byte responses in OpenAPI (P2-A3; the content route
does not either); more tests (P2-A4); documentation details (P2-A5); the
upload now waits for a decode slot in memory rather than spooled (P2-A6).

#### Code Review #1 Revisions

Repair round 1 of 2.

| Finding | Disposition | Change |
| --- | --- | --- |
| P2-A1 / P2-C1 | Accepted | Reads from private storage map `OSError` and `PrivateFilePathError` to the 503 path, in the new route and in finalize; this is safe now that reading and decoding are separate. Test: read error, parent permission error and parent link, each 503. |
| P2-A2 | Accepted | D12: Phase 3 deletes a chat's images that no remaining chat message references. |
| P2-A4 | Accepted in part | Tests for missing bytes (409), the sandbox CSP header, aborted and delete-pending files, and a small image returned as its own thumbnail. |
| P2-A5 | Accepted in part | The `http-api.md` entry names the 503 and the thumbnail format; `auth-server.md` moves to Phase 7. |
| P2-A3, P2-A6 | Not taken | Undeclared byte responses follow the content route; P2-A6 is bounded by the thread pool and is small beside a decode. |

Verification: the check record above, on working tree `aa70448df83d` (taken before this line was filled in).

#### Code Review #2 Findings

Reviewed source: working tree `1c7205fceedb`, high risk, targeted recheck.
Pass, with no blocking findings. Probes through the real storage adapter gave
503 with the "User image read failed" log for an unreadable or linked parent
directory, on the new route, finalize and `:process`, and all three escaped as
500 with the old error tuple. Missing bytes stay 409. Mutations confirmed each
new test fails under the change it targets, and the encoder-fault test fails
if decoding moves inside the read's error handling. `ruff check`, `mypy`, the
16 files (385 passed) and `pnpm openapi-ts:check` reran clean.

Non-blocking: **P2-A7**, the finalize half of the repair had no test.

#### Code Review #2 Revisions

| Finding | Disposition | Change |
| --- | --- | --- |
| P2-A7 | Accepted | The finalize read-failure test covers a read error, a parent permission error and a parent link. Test-only, verified by running the file (65 passed) and the 16-file set (387 passed). |

Phase commit: `feat(chat)[p2]: serve chat images to their owner`.

### Phase 3: A turn with images is checked, saved and assembled without bytes

Review tier: high risk (the saved message shape is replayed on every later
turn; private bytes must stay out of rows and logs).

Requirements: R2.2 (server), R2.3, R2.4, R2.5, R2.6, R4.1.

Steps, tests first in `tests/test_direct_chat_turn_executor.py`,
`tests/test_direct_chat_context_window.py`, `tests/test_context_budget.py`,
`tests/test_turn_instruction_layout.py` and `tests/test_anima_chat_sse.py`:

1. New module `app/model_clients/image_parts.py`: the neutral part
   `{"type": "model_client_image", "file_id", "name", "width", "height"}`,
   `ModelClientImage` (media type and bytes, excluded from `repr`), the token
   estimate above, the placeholder text and helpers to walk a prompt's parts.
   `ModelClientRequest` gains `images: Mapping[str, ModelClientImage]`.
2. Turn setup: split `attached_file_ids` into documents and images. Documents
   keep `validate_searchable_attached_files`. Images go through a new
   `validate_attached_images`, which refuses the turn (HTTP 400 with a code)
   when there are more than four, when one is missing or not ready (D6), or
   when the model does not accept images. `DirectChatTurnRequest` gains
   `attached_images`; upload tools are offered for documents only.
3. Prompt assembly: with images, the user message content is the image parts
   followed by one text part. The `<turn_context>` prefix and the tag escaping
   apply to the text part. `prompt_last_user_message` and
   `_message_content_text` join text parts.
4. Saving: `raw_provider_message` holds the parts; `content` and `data` follow
   D7. Deleting a chat deletes the images only it references (D12), through
   the same storage delete and row status as `DELETE /v1/files/{file_id}`.
5. Selection: before context fitting, keep the newest 20 image parts in the
   prompt (the current turn's first) and turn every other image part into
   placeholder text; when the model does not accept images, turn all of them
   into placeholders. After fitting, load the bytes of the parts that remain
   through `open_bounded`, checking the owner. A file that has since been
   deleted becomes a placeholder.
6. Estimates: `history_item_tokens` and `estimate_prompt_tokens` count an
   image part with the estimate instead of its JSON text.
7. `adapters/model_clients/mock.py` answers a parts message from its text.

Tests cover: the three refusals; a saved row with no bytes and the expected
`content` and `data`; a follow-up turn that replays the earlier image; the
21st image becoming a placeholder; trimming a history with images; a model
switch to a text-only model; an image deleted between turns; a log capture
with previews enabled that holds no image data.

Checks: the listed test files; `uv run ruff check`.

Completion: a turn with images produces a prompt that holds references, a
request that holds the bytes beside it, and rows and logs with neither bytes
nor base64.

Starting revision: `26d435824` (the Phase 2 commit). Built as planned, with
these choices:

- **Where bytes enter.** `DirectChatTurnExecutor.stream` is the one place
  every request of a turn passes through (tool rounds and the stale-cursor
  retry that reloads history included). It loads the bytes of the image parts
  in that request's prompt through the `ChatImageLoader`, caching them for the
  turn, and sets `ModelClientRequest.images`. Loading after context fitting
  happens naturally, because fitting rebuilds the prompt before dispatch.
- **Loader.** `SessionBackedChatImageLoader` (product HTTP) opens a short read
  session, reads only the owner's ready images whose stored copy still matches
  its digest, and leaves anything else out (its placeholder is sent).
- **Validation.** `app/chat/attached_images.py` splits a turn's attached ids
  into images and others. An image that is failed, deleted or not ready, or a
  fifth image, refuses the turn with HTTP 400 and `detail.code`
  `attached_image_unavailable` or `too_many_images`; a model without image
  input gives `model_does_not_accept_images`. An id naming no file of the
  owner, another owner's image included, goes on with the documents, which
  ignore it, so the route reveals nothing about other owners' files.
- **Selection** runs in `_build_prompt`, so context fitting sees the same
  choice. Prompt and history estimates count each image with the provider
  estimate.
- **D12.** `DELETE /v1/chats/{chat_id}` reads the images only that chat
  references (`image_file_ids_only_in_chat`), deletes the chat, then deletes
  those images' bytes and marks their rows deleted (`record_file_deleted`), as
  `DELETE /v1/files/{file_id}` would, committing each image on its own. A
  cleanup failure is logged and leaves the images not yet reached in the
  Library. The hosted composition's null `UserFileProcessingRepository`
  (Cloud's `NoUserFiles`) needs the two new methods at its next repin, or every
  hosted chat delete fails; the pull request carries this follow-up.
- **Known limit.** Deleting an Anima removes its chats through the database
  cascade, without this cleanup; their images stay in the Library.
- **Between Phases 3 and 4** a turn with images reaches adapters that do not
  yet understand image parts (Responses drops the message, the others pass an
  unknown part type). Both phases ship in one pull request.

Check record (working directory: the checkout root; working tree recorded under
Code Review #1 Revisions):

| Command | Result |
| --- | --- |
| `uv run --no-sync ruff format --check src/backend/animama tests` | exit 0 |
| `uv run --no-sync ruff check` | exit 0 |
| `uv run --no-sync mypy src/backend/animama tests` | exit 0, 911 files |
| `uv run --no-sync python scripts/repository-boundary/check-python-imports.py` | exit 0 |
| `uv run --no-sync python scripts/public-release/check_source.py` (new files added with `git add -N`) | exit 0 |
| `timeout 1200 uv run --no-sync pytest -q -n 2` on the 24 files below | exit 0, 751 passed |
| `pnpm openapi-ts:check` (in `src/frontend`) | "Generated SDK is current (17 files)" |

The 24 files: `test_model_client_image_parts` (new), `test_chat_image_loader`
(new), `test_direct_chat_turn_executor`, `test_anima_chat_sse`,
`test_turn_instruction_layout`, `test_direct_chat_context_window`,
`test_context_budget`, `test_chats_api`, `test_product_http_chats`,
`test_anthropic_direct_chat`, `test_direct_chat_model_clients`,
`test_product_http_chat_turns`, `test_chat_compaction_service`,
`test_model_call_boundary`, `test_anthropic_messages_client`,
`test_openai_moderation_crisis_moderator`, `test_user_file_uploads`,
`test_user_file_processing`, `test_content_image`,
`test_product_http_inventory`, `test_accountless_repository_boundaries`,
`test_openapi_export`, `test_memory_file_tools`, `test_product_http_consumer`.

Not run: the full pre-push suite (G3).

#### Code Review #1 Findings

Reviewed source: working tree `23b10e88206a` on `26d435824`, high risk,
initial review.

The checks reviewer reproduced every recorded check (745 passed), ran 52 more
files that reach the changed code (1,025 passed), found no flakiness in three
runs, and probed two things the tests did not cover: with prompt previews on,
no log record held image bytes or base64; and a history of 12 image turns
fitted to small windows sent exactly the kept turns' images. The analysis
reviewer confirmed that bytes live only in `ModelClientRequest.images` (no
repr, preview, row or event carries them), that every chat request passes
through `DirectChatTurnExecutor.stream`, that chats without images behave as
before, and the ownership of validation, the loader and the D12 query.

Blocking:

- **P3-A1.** The four new files had no `licenses/source-review.json` entries.
- **P3-C1.** The plan's log test (previews on, no image data) was missing.
- **P3-C2.** The plan's trimming test was missing.

Should fix:

- **P3-A2.** History estimates counted earlier images at full cost even for a
  model that receives their placeholders, so a text-only model's history was
  trimmed far more than needed.
- **P3-A3.** A weak estimate test, and the missing tests above.
- **P3-A4.** The D12 query read every message of the owner on each chat
  delete, with or without images.
- **P3-A5 / P3-C4.** Cloud's hosted chat delete fails after its repin until
  its null repository gains the new methods; this belongs in the pull request.
- **P3-C3 / P3-A9.** Untested cleanup failures, and one commit for all images
  could leave a ready row whose bytes were already deleted.

Optional: a current-turn image whose bytes vanish after validation is answered
with its placeholder, against the module text (P3-A6); image names in
placeholders could open a turn-context tag (P3-A7); a loader-level failure
ended the turn (P3-A8); the Phase 3-only adapter state and the Anima-deletion
gap were not recorded (P3-A10, P3-A11); duplicated image-part code (P3-A12).

#### Code Review #1 Revisions

Repair round 1 of 2.

| Finding | Disposition | Change |
| --- | --- | --- |
| P3-A1 | Accepted | Entries added; `check_source.py` passes with the files added to the index. |
| P3-C1 | Accepted | `test_prompt_previews_never_carry_image_bytes` turns previews on and checks every log record for the bytes and their base64. |
| P3-C2 | Accepted | `test_a_trimmed_history_sends_only_the_kept_turns_images` fits 12 image turns to a small window. |
| P3-A2 | Accepted | Fitting passes `count_images=accepts_images`; the estimate test now uses a large image and checks both cases. |
| P3-A4 | Accepted | The query starts from this chat's user messages and checks other chats with JSON containment only for those ids. |
| P3-A5 / P3-C4 | Accepted | Recorded above for the pull request. |
| P3-C3 / P3-A9 | Accepted | Each image is committed on its own; tests for a delete that reports failure (delete-pending) and one that raises (earlier images stay deleted). |
| P3-A6 | Accepted | The module text says what is refused and what degrades. |
| P3-A7 | Accepted | `image_placeholder` escapes `<`; test added. |
| P3-A8 | Accepted | A loader failure is logged and the turn continues without images; test added. |
| P3-A10, P3-A11 | Accepted | Recorded above. |
| P3-A12 | Accepted in part | `attached_image_parts` builds the turn's parts once; `record_file_deleted` keeps its own two literals. |

Verification: the check record above, on working tree `bcc30853a663` (taken before this line was filled in).

#### Code Review #2 Findings

Reviewed source: working tree `389831b046dc`, high risk, targeted recheck.
Pass, with no blocking findings. Every accepted finding is fixed: the preview
test fails when bytes or their base64 reach a log record; the trimming test
fails without fitting; with images not counted, a text-only model kept 2 to 6
of 10 image turns in small windows where it kept none before; the rewritten
query handled owner scoping, roles, malformed data and shared images on
PostgreSQL, and for a chat without images its inner search never ran. All
checks reran clean (751 passed, SDK current, licence check passes).

New, from the repair: **P3-C5**, the cleanup-failure test passed against the
old single commit because it read inside the same transaction; **P3-C6**, the
preview test captured DEBUG only on the root logger. Noted: the chat-image
cleanup docstring overstated its guarantee for a failure between an image's
byte delete and its commit, which `DELETE /v1/files/{file_id}` shares.

#### Code Review #2 Revisions

| Finding | Disposition | Change |
| --- | --- | --- |
| P3-C5 | Accepted | The test rolls back the session before its asserts, as the request's session would; per the reviewer's probe, the old single commit then fails it. |
| P3-C6 | Accepted | The test captures DEBUG on the `anima` logger. |
| Docstring | Accepted | `_delete_chat_images` names the remaining window. |

Test and wording changes only, verified by rerunning the Phase 3 check set
(751 passed).

Phase commit: `feat(chat)[p3]: send and save chat turns with image references`.

### Phase 4: Each adapter sends images

Review tier: high risk (private data leaves the machine in provider requests).

Requirements: R2.1, R2.6 (cache markers), R4.2.

Before coding, read the current OpenAI Responses and Chat Completions
references for image parts and the Anthropic Messages image block, and record
any difference from the provider table above.

Steps, tests first in `tests/test_turn_instruction_layout.py`,
`tests/test_direct_chat_model_clients.py`,
`tests/test_anthropic_messages_client.py` and
`tests/test_anthropic_direct_chat.py`:

1. Responses: `_input_items_from_message` maps a parts list to `input_text`
   and `input_image` parts. `_history_user_breakpoint_indexes` includes user
   messages with parts and attaches the marker to the text part.
2. Chat Completions: `_messages_for_spec` maps image parts to `image_url`
   data URLs.
3. Anthropic: `_content_blocks` maps image parts to base64 `image` blocks.
4. Each adapter turns an image part without bytes into the placeholder text,
   so a request is never built with a dangling reference.
5. Confirm the operator moderation call still receives text only.

Tests assert the exact wire request for a turn with text and two images, for
a history message with an image, and for a placeholder, on each adapter.

Checks: the listed test files; `uv run ruff check`.

Completion: each adapter builds a valid image request; G1 confirms it against
real providers.

Starting revision: `10c55b756` (the Phase 3 commit). Official references read
on 2026-11-24: Responses `input_image` with a `data:` URL in `image_url`;
Chat Completions `{"type": "image_url", "image_url": {"url": ...}}`, which
also takes an optional `detail` and cache breakpoint; Anthropic `image` blocks
with a base64 `source`. No difference from the provider table above; neither
optional field is used.

Built as planned:

- `_common.image_data_url` writes the `data:` URL both OpenAI adapters use.
- Responses: `_input_items_from_message` maps a user message's part list to
  `input_image` and `input_text` parts; the cache breakpoint goes on the last
  part (after review), and `_history_user_breakpoint_indexes` now counts user
  messages with parts. A message with no text and no image produces no item.
- Chat Completions: `_messages_for_spec` maps user part lists to `image_url`
  and `text` parts; a message left with text only (every image a placeholder)
  is sent as one string, for OpenAI-compatible servers whose templates expect
  string content.
- Anthropic: `_content_blocks` writes `image` blocks (user messages only) and
  placeholders, so a history image also carries the history cache marker
  after it.
- No adapter logs its wire request; the operator crisis moderator still reads
  the turn's text only (test added).

Check record (working directory: the checkout root; working tree recorded under
Code Review #1 Revisions):

| Command | Result |
| --- | --- |
| `uv run --no-sync ruff format --check src/backend/animama tests` | exit 0 |
| `uv run --no-sync ruff check` | exit 0 |
| `uv run --no-sync mypy src/backend/animama tests` | exit 0, 913 files |
| `uv run --no-sync python scripts/repository-boundary/check-python-imports.py` | exit 0 |
| `uv run --no-sync python scripts/public-release/check_source.py` | exit 0 |
| `timeout 1200 uv run --no-sync pytest -q -n 2` on the Phase 3 files plus `test_model_client_image_requests` and `test_provider_sdk_logging` (new) | exit 0, 766 passed |

Not run: G1 (real providers) and the full pre-push suite (G3).

#### Code Review #1 Findings

Reviewed source: working tree `c028871e7a08` on `10c55b756`, high risk, one
reviewer for analysis and checks. Pass, with no blocking findings. The wire
shapes match the current official references; per-image base64 stays under 5
MB and 20 images under Anthropic's 128 MB request limit; probes showed a
Responses cursor sends only the new message and its images, tool rounds resend
none, no-developer-role models keep the turn context in the text part, and the
Utility runner never carries image bytes. All checks reran clean (761 passed,
plus 944 in 43 more files that reach the adapters).

Should fix:

- **P4-A1.** With `ANIMAMA_DEBUG` on, the Anthropic SDK's DEBUG log writes each
  request body, base64 images included, to Animama's log file and broadcast
  stream. The default configuration is clean.
- **P4-A2.** No Chat Completions test replayed a history image (the plan asks
  for one on each adapter).

Optional: the image walk repeated in three adapters (P4-A3); the Responses
breakpoint skipped an image-last message (P4-A4); `image_data_url` missing from
`__all__` (P4-A5); untested cursor, tool-tail and no-developer-role paths
(P4-A6); images re-encoded on every round of a turn (P4-A7); the SDK types
Responses `detail` as required (P4-A8).

#### Code Review #1 Revisions

Repair round 1 of 2.

| Finding | Disposition | Change |
| --- | --- | --- |
| P4-A1 | Accepted | `logging_config` keeps the `anthropic` and `openai` loggers at INFO; `test_provider_sdk_logging` pins it with debug on. |
| P4-A2 | Accepted | Chat Completions history test: the image message is replayed unmarked, the system message and reply keep their breakpoints. |
| P4-A3 | Accepted | `image_parts.resolved_parts` yields each image or text once; the three adapters only shape it. |
| P4-A4 | Accepted | The Responses breakpoint goes on the last part, whatever its type. |
| P4-A5 | Accepted | Exported. |
| P4-A6 | Accepted in part | Tests for the Responses cursor and the no-developer-role text part; the tool tail stays covered by the existing tool-round tests. |
| P4-A8 | Accepted | Responses images carry `"detail": "auto"`, the documented default. |
| P4-A7 | Not taken | Re-encoding costs memory only while a request is built; measure before caching. |

Verification: the check record above, on working tree `59832d127e2d` (taken before this line was filled in).

#### Code Review #2 Findings

Reviewed source: working tree `8b6baf843768`, high risk, targeted recheck.
Pass, with no blocking findings. With `ANIMAMA_DEBUG` on and real console,
file and broadcast handlers, the first tree leaked image base64 from
`anthropic._base_client` to all three and this tree leaks none; the new test
fails on the first tree. The shared part walk behaves exactly as before across
12 message shapes apart from the intended `detail` field and image-last
breakpoint, both allowed by the Responses reference. All checks reran clean
(766 passed, plus 774 in 35 more files).

Optional, taken: **P4-A9**, the cursor test now checks the new message's text;
**P4-A11**, plan text and counts; `_common.__all__` order (P4-A12). Not taken:
the other P4-A12 nits and P4-A10 (an image-last message, which the app never
builds).

Phase commit: `feat(chat)[p4]: send chat images through every model adapter`.

### Phase 5: The composer accepts images

Review tier: high risk. Planned as standard; re-tiered after Code Review #1
(P5-A1) because the phase changes product-ui's public declarations and
version, the shared session's submit flow and an upload recovery path.

Requirements: R1.1, R1.5 and R2.2 in the composer.

Start a task stack for this branch with `./reset.sh --name <name> --base-port
<free port>` and record its URL above. Follow the `animama-ui` skill and reuse
the existing tray, popover and note components.

Steps, tests first in `web/src/lib/user-files/*.test.ts`,
`web/src/ui/main/chat/chatAttachmentHold.test.tsx` and
`ChatUploadCapability.test.tsx`:

1. `uploads.ts`: add the image extensions and the 20 MiB limit; refuse HEIC
   and HEIF with a message that names the format.
2. `useUserFileUpload`: skip `:process` when finalize returns an image.
3. `chat-attachments.ts` and `chat-attachment-hold.ts`: a `ready` image is
   attachable and sendable without chunks, and still works when document
   processing is disabled. Refuse a fifth image with a reason.
4. `ChatInterface.tsx`: when the active model is known not to accept images,
   disable adding images and show a note in the tray, following
   `composer.files.noToolsNote`. Pasting an image file into the text area adds
   it to the tray. After a successful send, remove image attachments (D5).
5. Tray cards show a small preview for images.
6. Add the English strings and their Japanese, Korean and Chinese
   translations; run `pnpm i18n:extract`.

Checks from `src/frontend`: the touched Vitest files, `pnpm check`,
`pnpm web:lint`, `pnpm i18n:check`. Manual check on the task stack at desktop
width, then a narrow width: pick, paste and drag an image, send it with a
vision model and get a reply about it.

Completion: an image can be attached three ways and sent; refusals explain
themselves; documents behave as before.

Starting revision: `c3e059766` (the Phase 4 commit).

Built as planned, with these details:

- `uploads.ts` adds the image extensions and the 20 MiB image limit. HEIC
  and HEIF stay out of Uppy's type list: the composer's
  `onBeforeFileAdded` runs first and refuses them by name.
- `chat-images.ts` holds the composer's image rules: the format, the size,
  four images a message (tray uploads and Library picks together, through
  `attachedImageCount`) and the active model. An unknown model counts as
  accepting images; the server still refuses. `sentChatImages` picks the
  images to clear after a send, and `pastedImageFiles` the images a paste
  attaches (none when the clipboard also carries text).
- `useUserFileUpload` ends an image at finalize: `uploaded` with a ready row,
  or `failed` with the server's reason, worded like other stored errors
  (English only as detail outside English). It never calls `:process` for an
  image, except once after a failed finalize, which completes an image left
  at `uploaded` (D11) and logs the outcome.
- `chat-attachments.ts` offers ready images, which have no chunks.
  `chat-attachment-hold.ts` lets a saved image wait for its ready row even
  while document processing is off, instead of blocking the send.
- `ChatInterface` refuses an image through Uppy's `onBeforeFileAdded` (one
  toast for the picker, a drop or a paste, keeping Uppy's duplicate check),
  guards the Library picker the same way, shows a muted tray note while an
  image is attached to a model known not to accept images, attaches pasted
  images (or says uploads are unavailable while a reply streams), and
  removes the sent images once the server accepts the turn (D5, revised;
  moved to the turn's completion by the final review, F-A2).
- Tray cards show a local preview of an image (an object URL of the picked
  file, released when the card goes) in a box that keeps its size while the
  preview loads.
- `docs/frontend/features/user-file-uploads.md` describes paste, the image
  rules, image finalize and which attachments a send clears.
- product-ui 0.21.0: the `onAttachmentsSubmitted` session option and failure
  copy for `too_many_images`, `attached_image_unavailable` and
  `model_does_not_accept_images`; `contracts/hosted-web.md` names the new
  version.
- Strings in all five locales; `resources.d.ts` regenerated with
  `pnpm i18n:extract`.

Check record after Code Review #1 repairs (working directory `src/frontend`
unless noted; source tree `db163fd0dccf`, taken before this record was
written):

| Command | Result |
| --- | --- |
| `pnpm packages:build`, `pnpm packages:check`, `pnpm packages:test` | exit 0 |
| `pnpm check` | exit 0 |
| `pnpm web:lint` | exit 0 |
| `pnpm web:test` | exit 0, 6434 passed, 2 skipped |
| `pnpm i18n:check` | exit 0 |
| `pnpm exec prettier --check` on the touched web, product-ui, locale and i18n files (from `web`) | exit 0 |
| `python3 scripts/public-release/check_source.py` (root) | exit 0 |

The first record (tree `09d001897a41`, before review) passed the same
commands with 6427 web tests.

Manual check on the task stack (mock model, desktop width): a pasted image
uploads to Ready with a preview; the send clears it and the reply arrives;
the saved `content` ends with `[Image: name]` and `data` holds `images` and
`user_text`; a HEIC file is refused with its format named; a fifth image is
refused by paste, drop and the picker with one toast each; a drop with room
is accepted; the picker offers image types; with the model treated as
text-only (its cache entry set to `accepts: ["text"]`) the tray shows the note
and a pasted image is refused. At 900 px in the dark theme the tray card and
its preview render correctly. After the repairs: a paste carrying text and a
picture pastes the text and attaches nothing; an image deleted after it was
attached makes the server refuse the turn, the failure card shows the
`attached_image_unavailable` copy and the image stays in the tray; the next
accepted turn clears its image once the reply starts. The stack's web
container builds the packages into its own `dist`, so product-ui changes
need `pnpm packages:build` inside the container before a browser check.

Not checked here: a reply from a real vision model (G1), Electron (G2), the
Library picker's image guard by hand (its counting is unit-tested), and the
full pre-push suite (G3; owner instruction: no per-phase full suite). The
package-set `compare` for product-ui 0.21.0 runs in Phase 6, once its
declarations are final for this pull request.

#### Code Review #1 Findings

Reviewed source: working tree `1ff0e4a0d544` on `c3e059766`, standard tier as
briefed, one reviewer. Blocked. The reviewer reused the check record and ran
an Uppy probe for P5-A5.

Blocking:

- **P5-A1.** The phase changes product-ui's public declarations and version,
  the shared submit flow and an upload recovery path, so it is high risk, not
  standard; the package-set `compare` is neither run nor deferred.

Should fix:

- **P5-A2.** Images clear when the send is accepted locally, so a turn the
  server refuses (such as `runtime_remount_required`) loses them silently.
- **P5-A3.** A known text-only model does not hold a send with images, and
  the new failure guidance ("remove the images") assumes images the composer
  has already cleared.
- **P5-A4.** A paste carrying text and a picture (spreadsheets, documents)
  attaches the picture and drops the text.
- **P5-A5.** HEIC in Uppy's type list is unnecessary (`onBeforeFileAdded`
  runs first) and makes every type refusal list HEIC as uploadable.
- **P5-A6.** A refused image shows the server's English reason as the primary
  message in every locale, and its card says "Processing failed."
- **P5-A7.** The composer wiring (counting, clearing, paste, note) has no
  tests; `ChatUploadCapability.test.tsx` is unchanged.
- **P5-A8.** `docs/frontend/features/user-file-uploads.md` is now misleading
  and Phase 7 does not list it.

Optional: image entries in the Library picker show a document icon and
"0 chunks" (P5-A9); an image pasted while a reply streams is dropped silently
(P5-A10); the tray note reuses the toast wording in a warning tone (P5-A11);
duplicated counting and model lookup (P5-A12); no log on finalize recovery,
and a refused recovery shows the generic finalize message (P5-A13); the
preview shifts the card while it loads, and a GIF animates in it (P5-A14).

#### Code Review #1 Revisions

Repair round 1 of 2.

| Finding | Disposition | Change |
| --- | --- | --- |
| P5-A1 | Accepted | Re-tiered high risk; a checks subagent reruns the affected checks; the `compare` is recorded for Phase 6. |
| P5-A2 | Accepted | `onAttachmentsSubmitted` fires on the stream's first event (D5, revised); tests cover the accepted and the refused turn. |
| P5-A3 | Accepted in part | With P5-A2 a refused turn keeps its images, so the guidance is accurate. No extra send hold: the tray note already explains, adding images is refused, and a hold would add a state to product-ui's public `ChatAttachmentHold` for a case the server refuses clearly. |
| P5-A4 | Accepted | `pastedImageFiles` attaches nothing when the clipboard carries text. |
| P5-A5 | Accepted | HEIC and HEIF left out of Uppy's type list; a test pins it. |
| P5-A6 | Accepted | `storedUploadErrorLine` words a refused image with `uploads.imageRefused`; the hook uses it for the toast and card. |
| P5-A7 | Accepted | Counting, clearing and paste rules moved to `chat-images.ts` with unit tests; the hold and stream tests cover the session side. |
| P5-A8 | Accepted | The doc is updated in this phase. |
| P5-A9 | Deferred | Phase 6 step 3 now covers the picker's image entries. |
| P5-A10 | Accepted | A pasted image while a reply streams shows `composer.drop.unavailable`. |
| P5-A11 | Accepted | New `composer.images.noImagesNote`, muted like the tools note. |
| P5-A12 | Accepted | `useActiveChatModel` and `attachedImageCount` remove the duplicates. |
| P5-A13 | Accepted | The recovery logs its outcome and a refused recovery shows the image refusal. |
| P5-A14 | Accepted in part | The preview box keeps its size; a GIF animating in the local preview is left as is. |

Verification: the check record above and the manual checks after the
repairs.

Independent checks rerun (high-risk tier, a separate subagent, on working
tree `598a1e7c6acd`, which equals `db163fd0dccf` apart from this plan): the
same commands as the check record, all exit 0 (`pnpm packages:test` 61
tests; `pnpm web:test` 6434 passed, 2 skipped; i18n catalogs complete); the
runs changed no tracked file.

#### Code Review #2 Findings

Reviewed source: working tree `598a1e7c6acd`, high risk, targeted recheck.
Pass, with no blocking findings. P5-A1, A2, A4 to A8 and A10 to A14 are
resolved; the reasons for the partial or deferred dispositions of P5-A3, A9
and A14 hold. The reviewer confirmed that every image refusal and
`runtime_remount_required` is an HTTP error raised before the stream, so
`onFirstEvent` never fires for them, and that both new session tests fail on
the round 1 code.

- **P5-A15** (optional, not reproduced): some sources put text beside a
  copied image (Firefox and Safari "Copy Image" write the image URL, a Finder
  copy may carry the file name), so such a paste would paste the text and
  attach nothing. Chromium's "Copy image", which Electron uses, writes the
  image with HTML only.
- **P5-A16** (should fix, wording): `user-file-uploads.md` still says the
  picker offers only files with chunks; ready images have none.
- **P5-A17** (optional): Phase 6 step 1 still said to raise the product-ui
  version, against the Decision Log.

Optional and not taken: the tray's `hasImage` could reuse
`attachedImageCount`; the recovery's `.catch(() => null)` does not log the
`:process` error (the finalize error is logged).

#### Code Review #2 Revisions

No repair round used (one remains for this phase).

| Finding | Disposition | Change |
| --- | --- | --- |
| P5-A15 | Deferred to G2 | G2's manual check adds Firefox and Safari "Copy Image" and a Finder copy; the rule narrows only if one of them fails. |
| P5-A16 | Deferred to Phase 6 | Phase 6 changes the picker's image entries and fixes this sentence with them. |
| P5-A17 | Accepted | Phase 6 step 1 now keeps product-ui at 0.21.0 (plan text only). |

Phase commit: `feat(chat)[p5]: attach images in the chat composer`.

### Phase 6: Chat and the Library show images

Review tier: high risk (product-ui's public declarations and package version
change).

Requirements: R3.1, R3.3 and R1.4 in the interface.

Steps, tests first in `web/src/lib/chat/display-message-mapping.test.ts`,
`packages/product-ui/tests/chat-lifecycle.test.mjs`,
`web/src/ui/components/message.test.tsx` and
`web/src/lib/uploads/libraryUploads.test.ts`:

1. product-ui: `ChatDisplayMessage` gains an optional image list. The
   optimistic user message carries it, and history mapping reads it and the
   person's text from `data`. `ChatConversation` gains a render prop for user
   message attachments, like `renderAssistantAccessory`. product-ui stays at
   0.21.0, raised in Phase 5 for this pull request.
2. web: a hook loads an image through fetch and a blob URL, following
   `useRuntimeContentMediaUrl`. A component renders the thumbnails in the
   bubble, opens the image larger in the existing dialog, and shows a
   placeholder when the file is gone.
3. Library → Chat uploads: an image row shows its thumbnail and a ready
   state without processing wording. The composer's Library picker shows an
   image entry with its thumbnail instead of a document icon and chunk count
   (P5-A9), and `docs/frontend/features/user-file-uploads.md` says the picker
   also offers ready images (P5-A16).
4. Strings in all five locales.

Checks from `src/frontend`: the touched test files, `pnpm check`,
`pnpm web:lint`, `pnpm i18n:check`, `pnpm packages:build`, the package-set
`compare`. Manual check on the task stack: thumbnails after a send and after a
reload, the larger view, a deleted image, the Library row, at desktop and
narrow widths.

Completion: images are visible wherever the message is; a deleted image
leaves a placeholder; the package checks pass.

Starting revision: `a69b5f6e5` (the Phase 5 commit).

Built as planned, with these details:

- product-ui (still 0.21.0): `ChatDisplayImage` and
  `ChatDisplayMessage.images`. History mapping reads `data.images` and shows
  `data.user_text` beside them, skipping entries it cannot read (then the
  saved text with its placeholders stays). The session option
  `describeAttachedImages` names the images among a turn's attachments, so
  the sent message shows them at once, and the stand-in history row written
  after a completed turn carries the same `data`. `ChatConversation` gains
  `renderUserAttachments`, drawn above the user bubble.
  `queryKeys.userFileImages` caches image bytes apart from the file list, so
  an upload's list refresh does not refetch them.
- backend (after review, P6-A3): `GET /v1/files/{id}/content` also takes
  `variant=preview`, a WebP at most 320 px (`PREVIEW_EDGE`) cached apart from
  the 128 px thumbnail, so transcript previews stay sharp at twice their
  size. The SDK is regenerated; `local-http` stays at the 24.0.0 this pull
  request introduced.
- web: `useUserFileImageUrl` reads `/v1/files/{id}/content` (thumbnail,
  preview or original) through the protected same-origin fetch once the
  runtime is admitted and holds a Blob URL; a 404 or 409 is `isGone` and a
  422 is final, neither retried. `ChatMessageImages` shows the previews
  (height 80 px, width from the stored aspect within 48 to 160 px), opens the
  original in the shared dialog (inside the fullscreen element when the chat
  is fullscreen, and returning focus to the thumbnail on close), and leaves a
  labelled placeholder for a gone or failed image. Deleting a file
  invalidates its image cache.
- `UserFileThumbnail` shows a ready image in the composer card, the
  composer's Library picker (with size and status instead of a chunk count,
  P5-A9) and the Library's Chat Uploads row (`imageFileId`). The Library's
  debug panel offers Process for an image only to finish one left at
  `uploaded` (`canProcessLibraryUpload`).
- Tests: history mapping (`display-message-mapping.test.ts`), the sent
  message's images before and after history confirms it
  (`chatAttachmentHold.test.tsx`), the transcript slot, image states, dialog
  focus and fullscreen (`ChatMessageImages.test.tsx`), the hook's caching,
  retries and delete invalidation (`useUserFileImageUrl.test.tsx`), the
  helpers (`chat-images.test.ts`, `libraryUploads.test.ts`) and the preview
  size (`test_content_thumbnails.py`, `test_user_file_uploads.py`). They
  replace the planned `chat-lifecycle.test.mjs` and `message.test.tsx`
  additions, which exercise neither the mapping nor the slot.
- `docs/frontend/features/user-file-uploads.md` covers the picker's images
  (P5-A16), the transcript images and the byte route.
- Strings in all five locales.

Check record after Code Review #1 repairs (working directory `src/frontend`
unless noted; source tree `e3bfe7a06e8c`, taken before this record was
written):

| Command | Result |
| --- | --- |
| `pnpm packages:build`, `pnpm packages:check`, `pnpm packages:test` | exit 0 |
| `pnpm check` | exit 0 |
| `pnpm web:lint` | exit 0 |
| `pnpm web:test` | exit 0, 6451 passed, 2 skipped, on an earlier tree before the last two component tests; the independent rerun below covers this tree |
| `pnpm i18n:check` | exit 0 |
| `pnpm openapi-ts:check` | exit 0, SDK current |
| `pnpm exec prettier --check` on the touched web, product-ui and locale directories (from `web`) | exit 0 |
| `uv run --no-sync ruff format --check src/backend/animama tests`, `ruff check` (root) | exit 0 |
| `uv run --no-sync mypy src/backend/animama tests` (root) | exit 0, 913 files |
| `uv run --no-sync python scripts/repository-boundary/check-python-imports.py` (root) | exit 0 |
| `uv run --no-sync pytest -q -n 2` on `test_content_thumbnails`, `test_user_file_uploads`, `test_openapi_export`, `test_product_http_inventory`, `test_shared_product_contracts`, `test_content_image`, `test_typed_content_apis` (root) | exit 0, 154 passed |
| `python3 scripts/public-release/check_source.py` (root) | exit 0 |

The first record (tree `1bb350d2e28b`, before review) passed the frontend
commands with 6444 web tests, confirmed by an independent rerun (all nine
commands exit 0, on the same source).

Package-set compatibility (P5-A1, P6-A5), after the Phase 6 commit
`c55d06737`, through `scripts/heavy-slot.py`, using this branch's tooling:
`build.py build` of `main` at `c7b98f73a` (the branch's merge base) and of
`c55d06737` (214 files each, format 3), then `build.py compare` of the two:
exit 0, "Compatibility policy passed". The candidate set carries product-ui
0.21.0 and runtime-contracts 0.24.0 against 0.20.0 and 0.23.0 on `main`. The
sets themselves were scratch output and are not kept.

Manual check on the task stack (mock model) after rebuilding the packages in
the web container: after a reload, earlier image turns show their thumbnails
above the bubble; a thumbnail opens the image in the dialog; an image deleted
through the API shows "Image no longer available" after a reload; a new turn
shows its image with the message at once, in its aspect ratio; the Library
lists ready images with thumbnails and a plain Ready status; the composer's
Library picker shows thumbnails and "3 kB · Ready"; an image picked from it
shows its thumbnail in the tray, is sent, appears in the transcript and
leaves the composer. Desktop width and 900 px in the dark theme render
correctly.

After the repairs: a 1600 × 900 screenshot pasted on the stack returns a
128 × 72 thumbnail and a 320 × 180 preview (WebP), and the transcript loads
previews. The browser pane does not grant fullscreen, so the dialog inside a
fullscreen chat is covered by its unit test only.

Not checked here: the full pre-push suite (G3), Electron and Quick Chat (G2)
and a real vision model (G1).

#### Code Review #1 Findings

Reviewed source: working tree `1bb350d2e28b` on `a69b5f6e5`, high risk, one
analysis reviewer and an independent checks rerun (all commands exit 0).
Pass, with no blocking findings. The reviewer confirmed the history mapping
on six edge rows, that the sent message, the stand-in row and a refetch
share one id and image shape, the session-scoped cache keys, the fetch
boundary, i18n in five locales and that Cloud uses none of the changed APIs.

Should fix:

- **P6-A1.** The dialog opens without a Radix trigger, so closing it drops
  keyboard focus to the page body.
- **P6-A2.** In browser fullscreen (self-host) the dialog portals to `body`,
  outside the fullscreen element: it is invisible but traps focus.
- **P6-A3.** Transcript thumbnails stretch the 128 px thumbnail up to 160 ×
  80 CSS px, so screenshots look blurry, most on high-density displays.
- **P6-A4.** The hook's behavior (gone, retry, Blob URL release, cache key,
  delete invalidation) and the dialog have no tests.

Optional: record the `compare` result in Phase 6 (P6-A5); Quick Chat shows
images in its own window, unchecked (P6-A6); the debug panel offers Process
for images (P6-A7); no admission gate on the query (P6-A8); global `fetch`
instead of the session transport (P6-A9); one thumbnail request per picker
entry (P6-A10); the planned test files were replaced without a note
(P6-A11); a 422 is retried (P6-A12).

#### Code Review #1 Revisions

Repair round 1 of 2.

| Finding | Disposition | Change |
| --- | --- | --- |
| P6-A1 | Accepted | The opener is kept and focused in `onCloseAutoFocus`; a happy-dom test fails without it. |
| P6-A2 | Accepted | The dialog portals into `document.fullscreenElement` when there is one; unit-tested. |
| P6-A3 | Accepted | New `variant=preview` (320 px) on the byte route, used by the transcript; backend tests and SDK regeneration. |
| P6-A4 | Accepted | `useUserFileImageUrl.test.tsx` covers the Blob URL and its release, the session key, 404/409 once, 422 once, 503 retried, and refetch after delete; the dialog test covers open and close. |
| P6-A5 | Accepted | The `compare` result is recorded here before Phase 6 is ticked. |
| P6-A6 | Accepted | G2 covers Quick Chat images and the dialog; Phase 7 notes it in `quick-chat.md`. |
| P6-A7 | Accepted | The debug panel's Process is unavailable for images. |
| P6-A8 | Accepted | The query waits for the admitted runtime's cache key. |
| P6-A9 | Not taken | Session end cancels the query; the reference hook uses the same fetch. |
| P6-A10 | Not taken | Measure before changing; an unobserved image query is dropped after five minutes, and reopening the picker then revalidates (a 304 from the server's cache). |
| P6-A11 | Accepted | "Built as planned" lists the tests that replaced them. |
| P6-A12 | Accepted | A 422 is final. |

Verification: the check record above and the manual checks after the
repairs. An independent rerun on tree `cea897be6459` (the repaired source
with this record) passed every frontend command (`pnpm web:test` 6452
passed, 2 skipped; `openapi-ts:check` current), backend format, lint, mypy
(913 files) and boundary checks, 335 tests in ten affected backend files,
and the licence check; the runs changed no tracked file.

#### Code Review #2 Findings

Reviewed source: working tree `cea897be6459`, high risk, targeted recheck.
Pass, with no blocking findings. P6-A1 to A8, A11 and A12 are resolved; the
reasons for P6-A9 and A10 hold (A10's wording was inexact). The reviewer
confirmed that the Included and digest content routes still serve only the
128 px thumbnail, so the year-long digest URLs of ADR 0033 are unchanged,
that the cache keys cannot collide, that the contract versions raised in this
pull request cover the new enum value, and that Cloud uses neither the route
nor the preview size.

- **P6-A13** (should fix, regression from P6-A7): the debug panel also
  disabled Process for an image left at `uploaded`, whose only completion is
  `:process` (D11).
- **P6-A14** (optional): the thumbnail module's comments did not mention that
  chat previews share its cache.
- **P6-A15** (optional): no test asserted that the transcript asks for the
  preview and the dialog for the original.
- Optional: the preview comment held only up to about 2:1; the `web:test`
  row named a tree it did not run on.

#### Code Review #2 Revisions

Repair round 2 of 2.

| Finding | Disposition | Change |
| --- | --- | --- |
| P6-A13 | Accepted | `canProcessLibraryUpload` (in `libraryUploads.ts`, tested) offers Process for an image only at `uploaded`, whatever the processing switch says, and for documents as before. |
| P6-A14 | Accepted | The module docstring and cache budget comment describe previews. |
| P6-A15 | Accepted | The component test records each requested copy and asserts preview and original, never the thumbnail. |
| Preview comment | Accepted | Qualified for wide images. |
| Check record | Accepted | The `web:test` row names its tree. |

Verification (source tree before this record): `pnpm check` and
`pnpm web:lint` exit 0; Vitest on `src/lib/uploads`, `src/ui/main/chat`,
`src/ui/library` and the hook test, 141 passed; prettier `--check` exit 0;
`ruff format --check` (913 files) and `ruff check` exit 0;
`test_content_thumbnails.py`, 13 passed.

#### Code Review #3 Findings

Reviewed source: working tree `d7dabc94bb12`, high risk, final targeted
recheck; the reviewer reran the checks above on it with the same results.
Pass. P6-A13 to A15, the preview comment and the record row are resolved, and
the debug panel's refactor keeps the document behavior. Non-blocking: a stale
"Built as planned" sentence about the debug panel (corrected in this record),
the cache comment's "about 500 previews" is at the generous end (measured
previews are 15 to 25 KB, so 330 to 540), and the panel's existing toast says
"queued for processing" when it completes an image. No repair rounds remain;
the comment and the debug-only toast are left as they are.

Phase commit: `c55d06737` `feat(chat)[p6]: show sent images in chat and the
Library`.


### Phase 7: Documentation and decision record

Review tier: light; the final integration review covers it.

1. `docs/backend/features/user-files.md`: image formats and limits, the
   canonical copy, the byte route, and what images do not get (processing,
   search).
2. `docs/frontend/runtime/chat.md`: attaching images, the per-turn limit, the
   model note and thumbnails.
3. `docs/frontend/features/model-settings.md`: the Vision chip and the "accepts
   images" setting now decide whether chat sends images.
4. `docs/backend/runtime/chat.md` (image parts, replay and placeholders),
   `model-client-providers.md` (each adapter's image format) and
   `prompt-caching.md` (cache markers on messages with images). Note that an
   OpenAI Responses conversation stored by OpenAI now includes its images.
5. A new ADR recording D1 and D2 with the alternatives considered (inline
   bytes in saved messages, provider file uploads, a separate image store).
6. Source-review entries for every new file.
7. `docs/frontend/desktop/quick-chat.md`: Quick Chat shows a message's images
   from the mirrored transcript (P6-A6).

`docs/frontend/features/user-file-uploads.md` was updated in Phases 5 and 6
(P5-A8, P5-A16).

Check: the documentation links resolve.

Done as planned, plus the stored-bytes policy list in
`docs/frontend/architecture/auth-server.md` (moved here from Phase 2, P2-A5):
`docs/backend/features/user-files.md` (a Chat Images section, the walkthrough,
chat deletion, non-goals), `docs/backend/runtime/chat.md` (Chat Images),
`model-client-providers.md` (Images, the image token estimate, image
references in `raw_provider_message`), `prompt-caching.md` (Images),
`docs/frontend/runtime/chat.md` (Images in chat),
`docs/frontend/features/model-settings.md`, `docs/frontend/desktop/quick-chat.md`,
and [ADR 0038](../../adr/0038-chat-images-saved-as-references.md) with its
index row and source-review entry. The ADR records that a Responses
conversation OpenAI stores keeps the images it received.

Check record (root): a script resolving every relative link and heading
anchor in the changed Markdown files, the ADR, `user-file-uploads.md` and
`http-api.md` reported no broken link;
`python3 scripts/public-release/check_source.py` exit 0. Review: the final
integration review covers this phase (light tier).

## Final integration review

One review of the combined change against #904's acceptance criteria, covering
Phase 7 and reusing phase evidence. After its repairs and the owner's
agreement (G3), the full pre-push suite runs once on the final candidate
through the heavy slot: `python3 scripts/heavy-slot.py -- make check-test`;
from `src/frontend`, `python3 ../../scripts/heavy-slot.py -- pnpm verify` and
`pnpm web:test:browser`; and `pnpm e2e:test:fast` against a disposable built
stack. Results go in the pull request.

Gates:

- **G0.** Owner review of this plan, including D1 to D7.
- **G1.** Provider check. With the owner's agreement to a bounded paid run
  (three calls, well under US$1), send one image through a vision model on
  each adapter family from the task stack and confirm the reply describes it.
- **G2.** Desktop check. Pasting and dragging in the Electron app need the
  owner's go-ahead before the agent drives the app, or the owner checks them.
  It includes pasting after "Copy Image" in Firefox and Safari and after a
  Finder copy (P5-A15), images and their dialog in Quick Chat (P6-A6), and
  Stop between a saved turn and its completion (Final Review #2).
- **G3.** Owner agreement to the full pre-push run.

Hosted validation stays off unless the owner starts a run; the pull request
states which evidence is local.

### Final Review #1 Findings

Reviewed source: `853ddcd44` (clean) against `main` `c7b98f73a`, high risk,
final integration mode, one reviewer; no checks of its own. Blocked. It found
contracts, privacy, ownership and boundaries consistent and every acceptance
criterion met or pending its gate, except one.

- **F-A1** (blocking): no test showed that stream events or memory files
  hold no image bytes, although the acceptance table cited one.
- **F-A2** (should fix): images left the composer at the first stream event,
  but a turn that fails after that is never saved, so a resend went without
  them.
- **F-A3** (should fix): deleting an Anima leaves its chats' images, and no
  owner decision records it.
- **F-A4** (should fix): `user-files.md` still listed only document
  extensions, defined `ready` as having chunks, and said the picker offered
  only searchable files.
- **F-A5** (should fix): ADR 0038 said bytes are not cached between requests
  (they are held for the turn), understated the Cloud consequence and named
  the wrong finalize module; two docs said "copied text" names images.
- **F-A6** (should fix): the pull request must carry Cloud's repin
  obligations.
- Optional: repeated refusal and byte-route text, "too large" for a pixel
  refusal and a missing verb (F-A7); one 4,784-token estimate for every
  provider can refuse a large image on a small local window (F-A8);
  re-confirm provider request size limits (F-A9); a Responses cursor kept
  after a switch to a row without image input (F-A10).

### Final Review #1 Revisions

Repair round 1 of 2.

| Finding | Disposition | Change |
| --- | --- | --- |
| F-A1 | Accepted | The SSE route test and a new executor test assert that the bytes, raw or base64, appear in no stream event, saved turn or recorded episode. |
| F-A2 | Accepted | `onAttachmentsSubmitted` fires on `run.completed`; tests cover a reply that starts and then fails (images kept) and a completed turn (images cleared). D5 and the frontend docs say so. |
| F-A3 | Recorded for the owner | D13, to confirm at pull request review. |
| F-A4 | Accepted | `user-files.md` lists image extensions and limits, `ready` for images, the picker's images, the copy's metadata and the non-goal. |
| F-A5 | Accepted | ADR 0038 and the chat doc corrected. |
| F-A6 | Accepted | The pull request lists Cloud's repin work: the two `NoUserFiles` methods and admitting local-http 24, runtime-contracts 0.24.0 and product-ui 0.21.0. |
| F-A7 | Accepted | The refusal codes live in the chat doc and the byte route in the HTTP API doc; wording fixed. |
| F-A8 | Recorded | Known limit below. |
| F-A9 | Not taken | The limits were read from the providers' current documents at planning (Surprises & Discoveries); G1 does not change them. |
| F-A10 | Recorded | Known limit below. |

Check record (source tree `02b4101a620f`, before this record): from
`src/frontend`, `pnpm packages:build`, `packages:check`, `packages:test`,
`check`, `web:lint` exit 0 and `pnpm web:test` 6454 passed, 2 skipped;
prettier `--check` exit 0; from the root, `ruff format --check` (913 files),
`ruff check`, mypy on the two changed test files, and `pytest` on
`test_anima_chat_sse.py` and `test_direct_chat_turn_executor.py` (248 passed)
exit 0; the link script found no broken link.

### Final Review #2 Findings

Reviewed source: working tree `9bb55eae4393`, high risk, targeted recheck;
the reviewer reran `chatAttachmentHold.test.tsx` (11 passed) and the image
tests in the two backend files (21 passed). Pass. F-A1, F-A2, F-A4, F-A5 and
F-A7 are resolved; the dispositions of F-A3 (D13), F-A6, F-A8, F-A9 and F-A10
are sound. It traced the completion-time clearing through Stop, chat switches,
error frames, interrupted streams, `runtime_remount_required`, structured and
voice turns, and the optimistic and stand-in messages. Non-blocking:

- **F-A11.** A code comment still said "copied text", and the chat doc said
  bytes are read before each request (they are read once per turn).
- **F-A12.** The failure list omitted an image too detailed to fit 3.5 MiB
  at JPEG quality 50.
- **F-A13.** The repair dropped `user-files.md`'s final newline.
- Observation: a saved turn's images stay in the tray while the server
  finishes speech, the title and compaction before `run.completed`; Stop in
  that window keeps them, so a resend would send them again. Never losing an
  unsaved image is the intended trade.

### Final Review #2 Revisions

Repair round 2 of 2.

| Finding | Disposition | Change |
| --- | --- | --- |
| F-A11 | Accepted | The `message_builders.py` docstring drops "copied text"; `docs/backend/runtime/chat.md` says bytes load once per turn. |
| F-A12 | Accepted | The failure list names it. |
| F-A13 | Accepted | Newline restored. |
| Observation | Recorded | G2's manual check includes Stop during that window. |

### Final Review #3 Findings

Reviewed source: working tree `089d1bdccf16`, high risk, the last targeted
recheck. Pass: F-A11 to F-A13 are resolved and the records match the diff,
apart from the F-A11 wording, corrected above. The reviewer reran, at the root
on that tree, `ruff check` and `ruff format --check src/backend/animama tests`
(913 files), a link check of the two changed docs and
`git diff --check`, all exit 0, and confirmed the runs changed nothing. It
also noted that spec R4.1 lists "copied text" among the placeholder's
readers, while the bubble shows the person's own text (D7); see the
Decision Log. The review budget is spent; no repair rounds remain.

### Full pre-push suite (G3)

The owner agreed on 2026-11-24. Run on `1d4b60b6d` (clean), each through
`scripts/heavy-slot.py`:

| Command | Result |
| --- | --- |
| `make check-test` (root) | exit 0: typed-content audit, ruff format (913 files) and lint, mypy (913 files), pytest 5715 passed, 30 skipped |
| `pnpm verify && pnpm prettier:check` (`src/frontend`) | exit 0: `pnpm web:test` 6454 passed, 2 skipped; build and every Prettier check passed |
| `pnpm web:test:browser` (`src/frontend`) | 139 of 140 passed; `animation-combo.browser.test.mjs` measured 1.16× real time (limit 1.15) while the backend suite ran beside it, then passed alone |
| `pnpm e2e:test:fast` (`src/frontend`) against a disposable built stack (`ANIMAMA_LLM_SKIP=1`, production build, base port 8600) | exit 0, 40 passed in 6.3 minutes; the stack and its volume were removed afterwards |

The full `pnpm e2e:test` is not required: this change touches no content
packages, imports, cleanup or Anima content.

### Provider check (G1)

The owner agreed on 2026-11-24. The task stack `animama-cii` was restarted
with real model clients and the owner's development credentials file selected
through `COMPOSE_ENV_FILES`. One 800 × 500 PNG (a red circle, a blue square
and the number 42) was uploaded, and each turn was sent as a scripted
`chat:sse` request in a new chat, naming its catalog row:

| Adapter | Row | Result |
| --- | --- | --- |
| Anthropic Messages | `claude-haiku-5-5` | Passed. Reply: "A red circle and a blue square, with the number 42 above them." The saved user row ends with `[Image: g1-shapes.png]` and `data.images` holds one reference. A follow-up without the image ("which shape was on the right, and what colour?") got "On the right was a blue square", so the replayed image reached the model. About 17,000 input and 58 output tokens a turn. |
| OpenAI Responses | `gpt-6-luna` | Not completed: OpenAI refused the request with `insufficient_quota` / `credit_balance_exhausted` (the account has no credit), confirmed by a minimal host-side Responses call with the same kind of image. |
| OpenAI Chat Completions | `gpt-6-luna` (hidden row) | Not sent: the same account. |

No stream frame and no server log line held image bytes. The OpenAI families
stay pending until the account has credit; their request shapes are covered
by `test_model_client_image_requests.py`. The refusal reached the person as a
generic "OpenAI request failed", because a mid-stream `error` event's code is
not classified (`classify_openai_exception` reads no body from a bare
`APIError`). That gap predated this change; at the owner's request the fix
joined this pull request (Addendum: OpenAI mid-stream errors).

### Addendum: OpenAI mid-stream errors

Owner request after G1. An error OpenAI reports inside a stream (the SDK's
bare `APIError` for an `error` event, or a Responses `response.failed` or
`error` event) became the generic `openai_request_failed` or
`openai_stream_error`, so a turn refused for an exhausted credit balance said
only "OpenAI request failed". `classify_openai_exception` and
`classify_openai_response_event` (`adapters/model_clients/openai_errors.py`)
now read the provider's type and code and give the error the code and message
the same HTTP error has (`openai_quota_exceeded`, `openai_rate_limit`,
`openai_server_error`, `openai_overloaded`, `openai_authentication_error`,
`openai_permission_denied`, `openai_bad_request`, including OpenAI's image
errors), with the provider fields sanitized into the metadata. The adapter
still never retries them: the stream had begun. An error whose type and code
are not recognized keeps its generic code. Quota versus rate limit follows
one shared rule (`_QUOTA_TERMS`, now also "credit") for HTTP 429s and stream
errors, reading the message too. The Responses event metadata now carries
`response.error.type`. The chat already has copy for these codes;
`docs/backend/runtime/model-client-providers.md` describes the stream
mapping.

Review tier: standard (backend error classification; no contract, schema or
frontend change).

Check record (root, source tree `1c49023aa467`, before this record):

| Command | Result |
| --- | --- |
| `uv run --no-sync pytest -q -n 2` on `test_model_error_categories.py`, `test_model_client_registry.py`, `test_direct_chat_turn_executor.py`, `test_anima_chat_sse.py` | exit 0, 324 passed (new: four stream-event cases, a code-only credit case, an unreadable body, secret redaction; the `response.failed`/`error` event test now expects classified codes) |
| `ruff check`, `ruff format --check src/backend/animama tests`, `mypy src/backend/animama tests` | exit 0 (913 files) |
| Live, task stack: a Responses turn on the account without credit | `error` event `openai_quota_exceeded`, category `quota_exceeded`, provider code `credit_balance_exhausted`, not retryable |

#### Code Review #1 Findings

Reviewed source: tree `1c49023aa467`, standard tier, one reviewer with
read-only probes. Blocked.

- **OE-A1** (blocking): a Responses `response.failed` event whose nested
  error names quota or credit became `openai_rate_limit`, because the 429
  re-read saw only the event's own fields.
- **OE-A2** (should fix): the Responses event metadata dropped
  `response.error.type`, and OpenAI's image error codes (`image_too_large`,
  `invalid_base64_image` and others) matched nothing.
- **OE-A3** (should fix): the docs said only an error without a type or code
  stays generic; unrecognized ones do too.
- **OE-A4** (should fix): the G1 record still said the gap was left for its
  own fix.
- Optional: the message counts for quota versus rate limit (OE-A5, as for
  HTTP 429); the bare-`APIError` path skipped the previous-response check
  (OE-A6); "never retried" holds for the adapter, while the turn can still
  shrink and retry a context overflow (OE-A7); the quota terms were
  duplicated (OE-A8).

#### Code Review #1 Revisions

Repair round 1 of 2.

| Finding | Disposition | Change |
| --- | --- | --- |
| OE-A1 | Accepted | The stream classification decides quota versus rate limit from every nested error's type, code and message; tests cover `insufficient_quota`, `billing_hard_limit_reached` and a quota `type` inside `response.failed`. |
| OE-A2 | Accepted | `events.py` forwards `response.error.type`; image codes map to `openai_bad_request`; `provider_error_type` now comes from the nested error, not the event type. |
| OE-A3 | Accepted | Doc and addendum wording. |
| OE-A4 | Accepted | The G1 record points here. |
| OE-A5 | Accepted as designed | Stream errors follow the HTTP 429 rule. |
| OE-A6 | Accepted | The bare-`APIError` path returns `openai_previous_response_unresolvable` when a cursor turn names an unknown response; tested. |
| OE-A7 | Accepted | The doc says the adapter never retries it. |
| OE-A8 | Accepted | One `_QUOTA_TERMS` tuple. |

Verification (root, tree `073112d7724f`): `pytest -q -n 2` on the four test
files, 332 passed; `ruff check` exit 0; mypy on the changed modules exit 0
(rerun by the round-2 reviewer).

#### Code Review #2 Findings

Reviewed source: working tree `073112d7724f`, standard tier, targeted
recheck with probes against HEAD's classifier. Pass. OE-A1 to OE-A8 are
resolved: every quota, credit and billing code inside `response.failed`
becomes `openai_quota_exceeded`, all 14 of the SDK's image codes become
`openai_bad_request`, unrecognized codes stay generic, and HTTP
classification changes only where a 429 names "credit" (now quota, not a
retryable rate limit). Optional: the classifier still read the event's own
type, so an event named for an image call could match "image" (OE-A9); the
round-1 verification named no tree (OE-A10); "describes the rule" overstates
what the doc covers (OE-A11).

#### Code Review #2 Revisions

Repair round 2 of 2 (trivial repairs, verified by the coordinator at the
standard tier).

| Finding | Disposition | Change |
| --- | --- | --- |
| OE-A9 | Accepted | `classify_openai_response_event` classifies the mapping without the event's type; a test pins `response.image_generation_call.failed` as `openai_stream_error`. |
| OE-A10 | Accepted | The round-1 verification names its tree. |
| OE-A11 | Accepted | The addendum says the doc describes the stream mapping. |

Check record (root, tree `dc0d11dd3e7e`, before this record): `pytest -q -n 2` on
the four test files, 333 passed; `ruff check`, `ruff format --check`
(913 files) and `mypy src/backend/animama tests` (913 files) exit 0.

Full pre-push suite rerun on `2fad4050b` (clean; the owner agreed), each
through `scripts/heavy-slot.py`:

| Command | Result |
| --- | --- |
| `make check-test` (root) | exit 0: audit, ruff, mypy (913 files), pytest 5731 passed, 30 skipped |
| `pnpm verify && pnpm prettier:check` (`src/frontend`) | exit 0: `pnpm web:test` 6454 passed, 2 skipped |
| `pnpm web:test:browser` (`src/frontend`), run alone | 139 of 140 passed; `animation-reel.browser.test.mjs` ("records the take after a failed one") mismatched one frame capture, then passed alone twice (3 of 3 each); no frontend file changed since the first suite run |
| `pnpm e2e:test:fast` on a disposable built stack | 39 of 40 passed; `accountless-creator-discard-local.spec.ts` timed out waiting for the Gesture name field, then passed alone on the same stack (3 of 3); the stack and its volume were removed |

Both single failures are in areas this change does not touch, and each
passed on its own rerun.

### Desktop check (G2)

The owner agreed on 2026-11-25 to the agent driving Electron. The unpackaged
desktop app (Electron 45.3.1, `ANIMAMA_DESKTOP_WEB_URL` = the task stack, a
throwaway `ANIMAMA_DESKTOP_DEV_USER_DATA` profile) was scripted over the main
process inspector; the window was brought forward so it rendered. This
process cannot post macOS mouse events, so a real Finder drag-and-drop was not
performed (web drops were checked in Phase 5).

| Check | Result |
| --- | --- |
| Paste an image through Chromium's clipboard (`webContents.paste()`) | Attached as "image.png · 5 kB · Ready" with its preview; the composer stayed empty |
| A file reference on the macOS clipboard, also with its name as text (Finder-style) | Chromium exposes only the file; attached as `input-shapes.png` |
| Image plus HTML `<img>` (Chrome's "Copy image") | Attached |
| Image plus its URL as `public.url` and plain text (Safari- and Firefox-style "Copy Image", emulated with AppKit's pasteboard) | The URL pasted as text and nothing was attached, as P5-A15 predicted. Real Safari and Firefox were not driven. |
| Quick Chat, opened through `animamaDesktop.quickChat.open` on a chat with an image turn | The preview shows above the user bubble (320 × 200); the thumbnail opens the 800 × 500 original in the dialog; Escape closes it and focus returns to the thumbnail |
| Image turns from the desktop composer on `claude-haiku-5-5` | Saved with one image each; replies "Green." (triangle) and "Yellow." (circle) were correct; the tray cleared when each turn completed |
| Stop between the saved turn and its completion | Not reachable: the Stop control showed, but the turn completed about 2.2 s after sending, before a 40 ms poll saw the saved reply. The trade-off stays theoretical for ordinary turns. |

Electron was quit and its profile removed. The system clipboard was replaced
with the test image during the check.

## Validation and acceptance

Each #904 acceptance criterion and the evidence planned for it:

| Criterion | Evidence |
| --- | --- |
| Each adapter builds and sends an image request | Phase 4 request tests; G1 (Anthropic passed; both OpenAI families wait for account credit) |
| A model without image input is refused | Phase 3 API test; Phase 5 composer test |
| Pick, paste and drag in web and desktop | Phase 5 manual check; G2 (desktop paste, Finder and Chrome copies attach; a Safari- or Firefox-style "Copy Image" pastes its URL; no real OS drag) |
| Thumbnails after reload; placeholder after delete | Phase 6 tests and manual check |
| No EXIF or GPS; no bytes in rows, events, logs or memory files | Phase 1 and Phase 3 tests; final review tests for stream events and episode memory (F-A1) |
| Replay, the 21st image, context fitting | Phase 3 tests |
| Library lists images | Phase 6 test and manual check |
| Suites and documentation | Final suite (G3, passed); Phase 7 |

## Idempotence and recovery

- No schema or data migration. Existing rows, uploads and chats are untouched.
- Every phase is a commit on the task branch and can be reverted alone in
  reverse order. Reverting Phase 3 after images were sent leaves user rows
  whose `raw_provider_message` has a parts list: Chat Completions and
  Anthropic would then receive an unknown part type. Before such a revert,
  keep Phase 3's placeholder conversion or delete the test chats.
- An interrupted image finalize can be retried; a failed image can be deleted.
- The task stack holds only test chats and can be removed with its volumes.

## Outcomes & Retrospective

Delivered in Phases 1 to 7; the full pre-push suite (G3) passed on
`1d4b60b6d`. G1 passed for Anthropic; the OpenAI families wait for account
credit. G2 remains with the owner.

Known limits:

- Deleting an Anima leaves its chats' images (D13, for the owner to confirm).
- Every provider is estimated at up to 4,784 tokens an image. A local vision
  model with a small window (for example 8k) can refuse a turn with one large
  image as `context_window_exceeded`.
- A Responses conversation keeps the images it received in OpenAI's stored
  chain, and a cursor turn on a row without image input continues it.
- Cloud must, when it adopts this release, add `image_file_ids_only_in_chat`
  and `record_file_deleted` to its `NoUserFiles` port, or every hosted chat
  delete fails, and admit local-http 24, runtime-contracts 0.24.0 and
  product-ui 0.21.0.
