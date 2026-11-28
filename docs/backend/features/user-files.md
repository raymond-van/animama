# User Files

User files are installation-owned uploaded documents and chat images. They are
stored separately from anima archives and the memory filesystem. The upload API supports
upload, processing, listing, deletion, and debug retrieval validation. Uploaded
files can be attached to direct chat turns by backend file ID after upload
initialization. Processed attached chunks are available to direct chat through
`search_uploaded_files` for relevance retrieval and
`read_uploaded_file_chunks` for bounded ordered reading. When those tools are
available, the prompt includes a request-local
`# List of attached user-uploaded files` section with each validated filename
and persisted chunk count, plus any safe processing overview available for the
current turn. The count helps the model plan bounded sequential reads without
exposing opaque backend file IDs, which remain outside model-facing prompts and
tool results. A model without tool calling receives neither the tools nor the
list, so its turns cannot search or read attachments; the chat composer says
so.

## Current Surfaces

Backend API:

- `POST /v1/files/uploads`
- `POST /v1/files/{file_id}:finalize`
- `POST /v1/files/{file_id}:process`
- `POST /v1/files/debug/search`
- `POST /v1/memory/debug/search-memory-files`
- `GET /v1/files`
- `GET /v1/files/{file_id}`
- `GET /v1/files/{file_id}/content` (a ready chat image's stored copy; `?variant=thumbnail` for a 128 px copy, `?variant=preview` for a 320 px one)
- `DELETE /v1/files/{file_id}`
- `DELETE /v1/files/uploads/{file_id}`
- `GET /v1/runtime-capabilities`

Frontend UI:

- Chat composer paperclip button opens an attachment popover with **Upload from
  computer** first and a searchable list of the current user's existing
  `ready`/`ready_keyword_only` documents and ready images below it. New-upload IDs and selected
  existing IDs are merged into `attached_file_ids` for the next `chat:sse`
  request.
- `/library?section=chat-uploads` shows private upload status,
  processing status, selected delete controls, process/reprocess actions, and
  debug search.

Processing:

- `server/user_file_processing.py`: the processing runner that every local
  composition starts inside the server. No other process needs to run.
- `adapters/parsers/`: the format parsers, which run in a bounded child
  process (the `parse-upload` subcommand of `runtime/cli.py`).

## In-Server Processing

Every local composition (packaged desktop, built self-host and development)
processes uploads in its server process; the hosted composition does not
process uploads. `create_local_app` starts the processing runner, which claims
durable jobs one at a time. The `:process` route wakes it, so a new upload
starts at once, and it polls for due retries. Every five seconds it records a
heartbeat and renews its running job's lease, so a long parse keeps its claim.
Each composition runs one server process and so one runner. Several processes
would still claim jobs safely (`SKIP LOCKED`), but they would share one
liveness row.

The server never parses a document's bytes itself (it does decode chat images,
with Pillow, when they are finalized). For each file the runner starts a
child of the same runtime (`parse-upload`, implemented in
`adapters/parsers/parse_child.py`) and sends it the bytes on standard input:

- The parent kills a child that runs past
  `ANIMAMA_USER_FILE_PARSE_TIMEOUT_SECONDS` (default 120) or whose resident
  memory passes `ANIMAMA_USER_FILE_PARSE_MEMORY_MB` (default 1024), sampled
  every 10 ms. The file fails with a reason naming the limit. On Linux the child
  also sets an address-space backstop of twice the memory limit plus 512 MB.
- The child inherits only an allowlisted environment (program and library
  paths, temporary directories, locale, and Python and PyInstaller settings),
  never database credentials or provider keys. Before any parser runs, it
  refuses every outbound connection and name lookup, turns off core dumps and
  bounds its CPU time. Nothing in a document runs or is fetched.
- Chunking, overviews and embedding happen back in the server, off its event
  loop, so chat and other requests keep responding while a file processes.

A failure that a retry cannot fix fails the job and file on the first attempt
with its reason: a missing, changed, empty or oversized original, content a
parser refuses, a parse limit, or a document without searchable text. Anything
else, such as a child that crashes or a database or embedding-provider error,
retries after `min(300, 2^(attempts-1))` seconds until the attempt limit. A
graceful stop waits five seconds for the current job, then cancels it and
returns it to the queue without spending its attempt. After a crash, the job is
claimed again once its lease expires; if that was its last attempt, it fails
with "Processing was interrupted", so no file stays at Processing.

`GET /v1/runtime-capabilities` reports `user_file_processing`. `enabled`
follows `ANIMAMA_USER_FILE_PROCESSING_ENABLED` (default `true`). `worker_state`
is the runner's liveness: `starting` until this server's runner has recorded a
heartbeat, `ready` while that heartbeat is less than twenty seconds old, then
`stale`. Enabled work queues durably while the runner is starting or stale.
`pack_id` is a fixed `document-processing` label on desktop and null elsewhere;
it keeps the response shape and names no installable pack.

A self-host operator can set `ANIMAMA_USER_FILE_PROCESSING_ENABLED=false`. The
runner then does not start, and process requests return 409
`{"detail":{"code":"file_processing_unavailable"}}` before file lookup or job
creation. Upload initialization, bytes and finalization still work, saved
originals stay `uploaded`, existing indexed chunks stay searchable, and queued
jobs resume when processing is turned back on. Desktop never sets the switch.

On desktop, private originals live below the supervisor's `ANIMAMA_DATA_ROOT`
inside `~/Library/Application Support/Animama/data`, not in app resources. See
[Desktop operations](../operations/desktop-runtime.md) for backups, and
[upload processing](../operations/development.md#upload-processing) for
development stacks.

## Supported Files

Allowed extensions:

- text and markup: `.txt`, `.md`, `.rst`, `.org`, `.json`, `.html`, `.htm`,
  `.xml`
- tabular text: `.csv`, `.tsv`
- rich documents: `.pdf`, `.docx`, `.pptx`, `.xlsx`

Chat images (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, up to 20 MiB) are also
accepted; see [Chat Images](#chat-images). The upload API rejects every other
extension. Macro-enabled Office
files such as `.docm`, `.xlsm`, and `.pptm` remain blocked, along with
executables, scripts, installers, and archive formats.

Upload size defaults to `25 MiB` through `ANIMAMA_USER_FILE_MAX_UPLOAD_BYTES`.
Processing size defaults to `10 MiB` through `ANIMAMA_USER_FILE_MAX_PROCESS_BYTES`.

Each format becomes Markdown text (`adapters/parsers/dispatch.py` chooses the
parser by extension):

- `.txt`, `.rst` and `.org` keep their text, and `.md` its Markdown. `.json` is
  reformatted, `.xml` keeps its text once it parses, and `.csv` and `.tsv`
  become a Markdown table.
- HTML keeps headings, paragraphs, lists, tables and link text in document
  order, and drops scripts, styles and markup.
- DOCX keeps headings (Title is level 1 and "Heading N" level N + 1),
  paragraphs, lists and tables in body order. Headers, footers, footnotes,
  comments, text boxes and images are not read.
- PPTX gives each slide a heading with its title, followed by its text, tables
  and speaker notes.
- XLSX gives each sheet a heading and a table of the cell values last saved with
  the workbook, never formulas.
- PDF is read from each page's text layer, in the order the PDF stores it,
  without OCR or layout analysis. Pages without selectable text are skipped and
  named in the file's [overview](#processing-overviews); a PDF with no
  selectable text fails with "This PDF has no selectable text; it may be
  scanned." A PDF that only restricts permissions opens without a password and
  is read.

Office documents, PDFs and `.xml` need the `documents` extra (python-docx,
python-pptx, openpyxl, pypdfium2 and defusedxml). Every local installation
includes it; without it those files fail with "This installation cannot read
.docx files: the documents extra is not installed." (naming the extension).

Uploads are untrusted, and every refusal names its reason:

- Content of another kind than its extension, such as a `.docx` that is not a
  ZIP package or a `.pdf` without a `%PDF-` header, fails with "The file does
  not match its .docx extension." A truncated file of the right kind is
  "damaged or incomplete".
- A document that needs a password to open fails with "Encrypted or
  password-protected documents are not supported", and so does an Office file
  stored as an encrypted package. Any other OLE file under an Office extension,
  such as a legacy `.doc` renamed `.docx`, gets the mismatch reason.
- Office packages are checked before a library opens them: at most 10,000
  parts and 256 MiB unpacked, a compression ratio of at most 100 for parts over
  1 MiB, and only stored or deflated parts. Every part is inflated once to
  prove it stays within its recorded size.
- XML that declares any entity, in a `.xml` file or inside an Office package,
  is refused, and no external content is loaded.

## Chat Images

PNG, JPEG, WebP and GIF files (by extension, then by content) upload as chat
images, up to 20 MiB (`MAX_USER_IMAGE_UPLOAD_BYTES`). HEIC and HEIF are
refused at init with a message that names the format. `metadata.kind` is
`"image"` from init, so every reader can tell an image from a document
(`is_image_user_file`).

An image is never processed. `:finalize` decodes it in the server
(`app/services/content_image.py`), through the bounded reader content images
use: at most 40 megapixels and 16,384 px a side, and only the PNG, JPEG, WebP
and GIF decoders, at most two images at a time. It stores a canonical copy in
place of the upload at the same locator: orientation applied, metadata such as
EXIF and GPS removed, a GIF's first frame, long edge at most 2,000 px. The copy
is PNG when the source is PNG or GIF and the copy fits 3.5 MiB, otherwise JPEG
(quality 90, stepping down to 50) with transparency flattened onto white. The
row becomes `ready` with `metadata.image` (`width`, `height`, `media_type`),
with no processing job, chunks or embeddings, and `search_uploaded_files` never
returns it. An unreadable or damaged image, one with too many pixels, or one too
detailed to fit 3.5 MiB even at JPEG quality 50 becomes `failed` with its reason
in `last_error`, and its bytes are deleted. The storage write or delete runs
under the row lock, so a delete during decoding wins. If `:finalize` stops after
the upload was saved, `:process` stores the canonical copy for an image still at
`uploaded`; for any other image it returns its state without a job, and the
processing switch does not apply to images.

`GET /v1/files/{file_id}/content` serves the canonical copy, or a smaller
copy, only to its owner ([HTTP API](../architecture/http-api.md)). A chat turn
carries at most four images; how it refuses others and saves references
instead of bytes is in [direct chat](../runtime/chat.md#chat-images) and
[ADR 0038](../../adr/0038-chat-images-saved-as-references.md).

## Step-By-Step Upload And Processing Walkthrough

Chat and Library use the same upload lifecycle. A chat image stops at step 3,
where it becomes `ready` or `failed` ([Chat Images](#chat-images)):

1. Uppy checks the browser allowlist and size, then calls
   `POST /v1/files/uploads` with filename, content type, and declared size.
   The backend validates these fields and creates an owned `pending_upload`
   row with expiry and a private `user-files/{user_id}/{file_id}/original`
   locator.
2. The response supplies the file ID, API-relative PUT target, required headers,
   and expiry. The browser uploads to `/v1/files/{file_id}/content` at the same
   origin. FastAPI bounds the stream, spools under `data/staging/uploads`, and
   atomically promotes the bytes to the private locator.
3. `POST /v1/files/{file_id}:finalize` rechecks ownership, pending status,
   containment, existence, and exact size before marking the file `uploaded`.
   Successful byte transfer alone does not finalize an upload.
4. When fresh capabilities allow processing, the client calls
   `POST /v1/files/{file_id}:process`. This creates a durable queued job and
   returns `202`; parsing never runs in the API request. Normal requests reuse
   queued/running work or an already-ready result. `force=true` reprocesses it.
5. The server's [processing runner](#in-server-processing) claims the job with
   `FOR UPDATE SKIP LOCKED`, records its lease and attempt, and reads the
   original. A missing, changed, empty or oversized original fails at once. A
   job whose lease expired after a crash can be claimed again.
6. Before parsing, a non-forced job may reuse an owned ready file with the same
   SHA-256, normalized extension, and at least one chunk. It copies chunks,
   overview, and processing results into independent rows, and copies vectors
   only when they come from the owner's current embeddings model. Otherwise a
   bounded child process [parses](#supported-files) the document, and the server
   [chunks](#chunking) it and embeds it when the
   [embeddings role](#embeddings-role) is on. Embedding failure retains
   keyword-searchable chunks with a warning.
7. Successful processing replaces chunks, stores the digest and timestamp, and
   marks the job `succeeded`. The file becomes `ready`, or `ready_keyword_only`
   when embedding failed. A failure records `last_error`: one that a retry
   cannot fix fails the job and file at once, and others retry with bounded
   backoff until the attempt limit, then fail. The client polls
   `GET /v1/files` for authoritative status and processing summaries.

Reused uploads remain independent for attachment, deletion, and forced
reprocessing. `content_reused: true` records reuse without exposing the source
file ID. Existing null digests are not backfilled; simultaneous duplicate
uploads may both process before either result is ready.

## Embeddings role

Vectors come from the owner's embeddings model role: an App Settings
assignment (`models.embedding_model_provider_id`), else
`ANIMAMA_DEFAULT_EMBEDDING_MODEL_PROVIDER_ID`. Embeddings are off until one is
chosen; files are still processed and searched by keyword. Any row of kind
`embedding` works, including the built-in `OpenAIHTTPAgent:text-embedding-3-small`
and local models served through a connection's `/v1/embeddings`.

Each chunk records the catalog row id of the model that produced its vector
(`embedding_model_id`) and the contextualized text that was embedded
(`embedding_text`, when it differs from the display text). Search compares only
vectors from the current model. After the role changes, an in-process task
started by the local application re-embeds chunks and archive passages in
batches, resting when nothing is stale, waking when settings change and backing
off after failures. Text the model cannot embed (too long, blank, refused
while the rest of the batch succeeds, or refused on its own three times) is
recorded without a vector so it cannot stall the rest. Until the third
rejection the batch fails and the role reports `retrying`; the count
(`embedding_rejections`) belongs to the rejecting model and the current text,
and restarts for another model or edited text. A rejection counts only when the
model then embeds a fixed check text containing no owner content, so a
misconfigured or failing model that refuses everything keeps retrying instead
of dropping vectors. `GET /v1/model-roles` reports progress under
`embeddings_refresh`, including the category of a failing batch.

## Statuses

File statuses:

- `pending_upload`: metadata row exists but its local file is not finalized.
- `uploaded`: the promoted local file exists and passed finalize checks.
- `processing`: at least one processing job has been enqueued.
- `ready`: chunks are available, with vectors when embeddings are on; a chat
  image is `ready` once stored and has none.
- `ready_keyword_only`: chunks are available, but embedding failed. Re-embedding
  marks the file `ready` once every chunk has a vector.
- `failed`: upload finalization or processing failed.
- `aborted`: pending upload was canceled.
- `delete_pending`: object cleanup failed; normal list/search should hide or
  ignore the row as appropriate.
- `deleted`: tombstoned row, hidden from normal list APIs.

Processing job statuses:

- `queued`
- `running`
- `succeeded`
- `failed`
- `canceled`

Frontend tracks transient Uppy metadata stages: `preparing`, `initializing`, `uploading`, `finalizing`, `queued`, `processing`, `failed`. These fill UI gaps before backend polling returns an authoritative file status.

## Chunking

Chunking turns one parsed file into smaller searchable rows in
`user_file_chunk`. Each chunk has a stable `chunk_index`, its text, character
count, the token count of its embedding text (`token_estimate`), optional
embedding, and compact metadata. Reprocessing
deletes existing chunks for the file and writes a new chunk set before marking
the job succeeded; the same file always gives the same chunks.

The server chunks every parsed document at its headings
(`app/services/user_file_chunking.py`), in a worker thread:

- Markdown headings divide the text into sections with a heading path, such as
  `Report > Results > Costs`. Office documents, HTML, Markdown, PDF text and the
  tables of CSV, TSV and XLSX files are Markdown. Plain text (`.txt`, `.rst`,
  `.org`), JSON and XML have no headings, so their `#` lines are text.
- A section that fits is one chunk, and adjacent sections merge while they fit.
  Heading lines stay in the chunk text, and a merged chunk's path is the
  headings its sections share. Worksheets never share a chunk.
- A larger section is cut one chunk at a time. Each chunk takes as much as fits
  and ends at the best boundary in the second half of that span: a blank line
  or block start, then a sentence end (`. ! ?` before whitespace, or `。！？`;
  not in code), a line break, a space, and only then anywhere. Nothing is
  materialized per word, line or paragraph, so a pathological file costs time
  in proportion to its chunks.
- A table split across chunks ends a chunk after a row, else after a cell, and
  every chunk of rows repeats the header and delimiter rows. A header that
  would take more than half a chunk is cut to its first columns, with an `…`
  column, and gets chunks of its own.
- `ANIMAMA_USER_FILE_CHUNK_MAX_TOKENS` bounds each chunk's embedding text: its
  heading path, a blank line, then its text. The stored text has no path;
  `embedding_text` keeps the embedded form so re-embedding matches, and is not
  exposed through public APIs. A path longer than a quarter of the limit drops
  its outer headings.
- The stored text also holds at most four characters per token of the chunk
  size (3,200 at the default). `read_uploaded_file_chunks` estimates four ASCII
  characters per token, so text where one token covers a long run of spaces,
  such as a fixed-width report, still fits one read.
- Tokens are `cl100k_base`, read from the encoding file llama-index bundles; no
  tokenizer is downloaded. Every chunk's count is exact: its embedding text is
  encoded whole. If that file is missing or damaged, counts fall back to a
  CJK-aware estimate and the server logs a warning once.
- Metadata holds `chunk_type` (`prose` or `table`), `headings` (the path),
  `pages` (`[first, last]` for a PDF), and `table_index`, `row_start` and
  `row_end` for rows of one table. Per-page character offsets stay out of the
  stored metadata; `processing.parser_metadata` keeps a PDF's `page_count` and
  `pdf_skipped_pages`.

Chunks that the retired Docling parser stored keep their own metadata
(`chunker: docling_hybrid`) and stay searchable; content reuse copies them
unchanged, and reprocessing with `force=true` replaces them.

## Processing Overviews

Newly processed and force-reprocessed files receive deterministic navigation
metadata at `user_file.metadata.overview`. The version 1 object contains a
bounded `description`, ordered `outline` entries with heading levels, an
extraction `method`, and an `outline_truncated` flag. Operational parser,
embedding, warning, and chunk-count details remain under
`user_file.metadata.processing`.

Office documents, HTML and Markdown take their outline from their headings, and
a PDF from its bookmarks; other Markdown formats fall back to their text's
headings. JSON, XML, and table-only files use format-specific structural
summaries. Plain text without recognized structure receives an extractive
description and an empty outline rather than fabricated sections. A PDF with
pages that have no selectable text starts its description by naming them, for
example "Pages 2–3 have no selectable text.", in at most 160 characters, so the
Anima can say which pages it could not read. Overview extraction is local and
deterministic: it does not call a model provider, and a safe fallback prevents
overview failures from failing an otherwise searchable processing job.

Existing ready files are not backfilled automatically. Reprocess with
`force=true` to replace their chunks and generate the current overview version.
The overview is processing metadata for later source selection; search results,
not the overview alone, remain the evidence for document-content answers.

## Search And Retrieval

`POST /v1/files/debug/search` accepts:

- `query`: required search text.
- `limit`: 1 to 50, default 10.
- `file_ids`: optional current-user file filter.
- `mode`: `keyword`, `semantic`, or `hybrid`.

Search modes:

- `keyword`: PostgreSQL full-text search over chunk text.
- `semantic`: embed the query and search pgvector chunk embeddings. Returns
  `503` while embeddings are off.
- `hybrid`: run keyword search plus semantic search, then combine ranks with
  reciprocal rank fusion. While embeddings are off or the searched files wait
  for re-embedding, hybrid search returns keyword results only; a failed query
  embedding returns keyword results with a warning.

Results include file ID, original filename, extension, chunk ID, chunk index,
score, match type, chunk text, and chunk metadata. Original object keys and
download URLs are not exposed.

`POST /v1/memory/debug/search-memory-files` is the smaller read-only debug route
for the direct-chat `search_memory_files` tool path. It accepts only `query` and
returns `memory_results` for user-scope markdown memory entries. Uploaded-file
debugging remains under `POST /v1/files/debug/search`, which can be scoped with
`file_ids` and run in `hybrid` mode to exercise the same retrieval machinery
used by `search_uploaded_files`.

Keyword search uses PostgreSQL full-text search. PostgreSQL turns chunk text
into a `tsvector`: normalized searchable lexemes produced by dictionaries such
as the English stemmer and stop-word filter. It turns the user's query into a
`tsquery` with `websearch_to_tsquery`, which accepts familiar web-search syntax.
Rows match when the text vector satisfies the query, and Anima ranks matches
with `ts_rank_cd`, PostgreSQL's cover-density rank function. Cover-density
ranking rewards matches where query terms appear close together.

The `english` parser keeps unspaced Japanese, Chinese and Thai text as one
lexeme. So besides the whole query's full-text match, a chunk also matches when
it contains every query word or quoted phrase with a non-ASCII letter or digit
as a case-insensitive substring and its other words match
([memory search](memory.md#search_memory_files) has the matching rules). A
`-term` of that kind excludes chunks containing it. `OR` beside a non-ASCII word
works only through the full-text match, and chunks that match only by substring
rank with a score of 0. The `search_uploaded_files` description asks the model to
separate words with spaces in Japanese, Chinese or Thai too.

Semantic search embeds the query with the embeddings-role model, then uses
pgvector cosine distance against stored chunk embeddings from that same model.
The SQL orders by nearest vector first with `<=>` and reports score as
`1 - distance`. Chunks without a current vector are skipped.

Hybrid search asks both retrievers for a wider candidate set, then combines
their ranks with reciprocal rank fusion. For each ranked list, result rank `r`
contributes `1 / (60 + r)` to that chunk's fused score. A chunk returned by both
keyword and semantic search receives both contributions, so agreement between
retrievers is rewarded. Final results sort by fused score descending, then by
file ID and chunk index for deterministic tie-breaking.

Direct chat also exposes `read_uploaded_file_chunks` for attached files that
passed the same request-local ownership, searchable-status, and non-empty-chunk
validation as uploaded-file search. The tool requires one exact filename, a
zero-based starting chunk index, and a chunk count from 1 through 5. Filename
matching is case-insensitive; an unknown name returns an error and never
broadens into reading every attachment. Same-named attachments are returned as
separate groups in request attachment order.

The reader returns complete stored chunks in source order with explicit
`next_start_chunk` and `has_more` pagination. One serialized result is bounded
to about 6,000 estimated tokens (24,000 English characters) and reports response truncation rather than splitting
chunk text. Results contain only the canonical filename, chunk index, chunk
text, and pagination fields—never internal file/chunk IDs, embeddings, parser
metadata, object keys, or storage URLs. The Anima should use search for
relevance, exact phrases, and locating a chunk; it should use bounded reads for
whole-document synthesis, sequential sections, or surrounding context.

## Configuration

Storage:

- `ANIMAMA_DATA_ROOT` supplies the private data root. Compose mounts it at
  `/var/lib/animama/data`.
- Originals live below `data/user-files`; request spools live below
  `data/staging/uploads`.
- No R2/S3/MinIO endpoint, bucket, or credentials are required.

Limits:

- `ANIMAMA_USER_FILE_MAX_UPLOAD_BYTES`: upload declaration limit. Defaults to
  `25 MiB`.
- `ANIMAMA_USER_FILE_MAX_PROCESS_BYTES`: largest original that is processed.
  Defaults to `10 MiB`; a larger upload is saved but fails processing.
- `ANIMAMA_USER_FILE_PARSE_TIMEOUT_SECONDS`: wall-clock limit for one file's
  parse child. Defaults to `120`.
- `ANIMAMA_USER_FILE_PARSE_MEMORY_MB`: resident-memory limit for one file's
  parse child. Defaults to `1024`. The server refuses to start with a zero,
  negative or infinite parse limit.
- `ANIMAMA_USER_FILE_CHUNK_MAX_TOKENS`: [chunk](#chunking) size in
  `cl100k_base` tokens, heading path included. Defaults to `800`; the server
  refuses to start outside `64` to `1400`, the largest size whose chunks always
  fit one `read_uploaded_file_chunks` read in any script. It sizes chunks only
  and is independent of the embeddings model.

Processing loop:

- `ANIMAMA_USER_FILE_PROCESSING_ENABLED`: `false` turns processing off for a
  self-hosted installation; uploads are still saved. Defaults to `true`.
- `ANIMAMA_USER_FILE_PROCESSING_POLL_SECONDS`: how often the runner looks for
  due jobs when nothing wakes it. Defaults to `2`.
- `ANIMAMA_USER_FILE_PROCESSING_LEASE_SECONDS`: running-job lease, after which
  a crashed server's job is claimed again. Defaults to `300`.
- `ANIMAMA_USER_FILE_PROCESSING_MAX_ATTEMPTS`: attempts before a file that
  keeps failing for a retryable reason fails. Defaults to `3`.

## Data Model And Ownership

`ORMUserFile` stores the upload's metadata (for a chat image, that of its
canonical copy, which replaced the upload). It is scoped by the generated
installation principal in `user_id` and uses backend-generated object keys. `ORMUserFileProcessingJob`
stores durable processing work and lease metadata. `ORMUserFileChunk` stores
searchable extracted chunks and denormalizes `user_id` for ownership filters.

Current APIs always filter file, job, and chunk access by the admitted installation
request principal. One installation cannot list, finalize, process, search, or
delete another owner's files. Original locators are not accepted from clients and are
not returned by the public APIs.

The original-file, chunk, job and processing-heartbeat tables are part of
the accountless `baseline_20260908` baseline. A database stamped with a removed
revision needs the explicit development reset boundary described in
[Database operations](../operations/development.md#database); ordinary server
restarts preserve ownership, uploads and queued jobs.

## Deletion And Recovery

Deleting a file is best-effort for local private storage and durable for
search. The API attempts to delete the local file, tombstones the row as
`deleted` when deletion succeeds, marks it `delete_pending` when filesystem
cleanup fails,
and deletes stored chunks so debug search no longer returns them.
A file deleted while its processing job runs stays deleted: the job locks the
file row before it stores chunks, reuses another file's chunks or records a
failure, and when it finds the file `deleted`, `delete_pending` or `aborted` it
writes nothing and ends `failed` with "The file was deleted before processing
finished".

Deleting a chat deletes the images its user messages reference unless a
message in another chat references them too (an image can be attached again
from the Library). Deleting an Anima applies the same rule to all its chats: it
deletes the images they reference unless a chat of another Anima references
them too. The images are read before the chat or Anima is deleted and removed
after that delete commits, each deleted and committed on its own, like a file
the person removed.

A content assistant conversation keeps its reference images through rows of
`generation_reference_images`
([data model](../architecture/data-model.md#content-assistant)). Both rules
count them: deleting a chat or an Anima spares an image such a conversation
still links, and discarding a conversation deletes the images it links
unless another conversation links them or a chat message references them.
Both are repository queries (`image_file_ids_only_in_chat`,
`image_file_ids_only_in_anima_chats` and
`image_file_ids_only_in_conversation`).

Pending uploads can be aborted with `DELETE /v1/files/uploads/{file_id}`. If the
browser PUT fails, the pending row remains until abort or expiry cleanup is
added later.

Processing enqueue is idempotent. Job leases are recoverable after they
expire. Reprocessing with `force=true` replaces chunks idempotently.

## Known Limitations

- PDFs are read from their text layer only. There is no OCR, layout analysis
  or table-structure recognition, so scanned pages are skipped, a multi-column
  page reads in the order the PDF stores its text, and PDF tables read as text.
- Stored vectors are keyed by catalog row ID. Pointing an embeddings
  connection at another server keeps the row ID, so existing vectors still
  count as current: search compares them with the new server's vectors, and a
  dimension mismatch fails semantic search. To re-embed, switch the Embeddings
  role to a different model row, for example one added on a new connection.

## Non-Goals

The API serves no document bytes, and a chat image's canonical copy only to its
owner; agent tools never read file bytes, and a model sees an image only inside
a chat request. OCR, encrypted or password-protected documents and macro-enabled
Office files are unsupported.
