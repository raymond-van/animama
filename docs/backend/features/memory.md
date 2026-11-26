# Memory

Animama stores scoped Markdown memory as versioned SQL-backed files and
directories. Direct chat reads the Anima's identity and relationship memories and
can use constrained tools over user memory; the Memory Manager provides a
separate maintenance and approval workflow.

## Built-in filenames

The user profile is `PROFILE.md` at the user-scope root and is shared by every
Anima. Each Anima has two required files at its own scope root: `IDENTITY.md`
(who the Anima is) and `MEMORIES.md` (its shared history with the user). Lookups
remain case-insensitive, so existing lowercase links and tool requests keep
reaching the same entry.

Stored entries, versions, and chat manifests preserve their original spelling;
identity context matches manifests case-insensitively.

## Current Direct Chat Boundary

Normal `chat:sse` uses `ChatManager`, `DirectChatMemoryContextService`, and
`DirectChatPromptAssembler` to build the OpenAI Chat Completions-compatible
prompt passed to direct model clients. Direct chat opens these memory file
entries in the active anima scope (`anima_id = {anima_id}`) before model
invocation:

- required anima identity: cached path `IDENTITY.md`
- anima memories: cached path `MEMORIES.md`, only when memory influence is
  enabled

With memory influence enabled it also reads two kinds of user-scope memory for
the same system message:

- the user profile: `PROFILE.md`, as `# User Profile` after the Anima memories.
  Content up to 16 KiB is included whole; a longer file contributes its start, cut
  at a line boundary, and a line saying the rest can be read with
  `memory_read_files`. A missing, blank or unreadable file is omitted without
  failing the turn and is fingerprinted like `MEMORIES.md`. The file still
  appears in the memory file list.
- recent notes: this Anima's newest `remember` notes (episode items whose
  `source_anima_id` is the Anima), as `# Recent Notes` after the profile. They
  come from other chats only, pending or processed, at most 20 notes and 3,000
  characters of note text from the last 14 local days in the owner's
  `preferences.timezone`, counted in whole days. Selection runs newest first and
  stops before the first note that would pass the character budget; the section
  lists the result oldest first with each note's local date. Other Animas' notes
  stay out of the instructions and remain reachable through `search_memory_files`.
  The chat manifest records the included item IDs as `episode_note_ids`.

Note text never changes after capture and processing status is not shown, so
within one chat the notes section changes only when another chat with the same
Anima saves a note or a day boundary moves the window.

The required anima identity is treated as anima configuration, not optional
memory influence. If the identity entry is missing or blank, chat setup fails
before the upstream model is called and requires explicit owner repair. There
is no read-time Avatar identity fallback or automatic identity write. New Animas
receive identity through creation; the current baseline does not adopt legacy
Avatar identity from databases stamped with removed revisions.

The identity markdown is appended to the single system instruction using only
the file content, after one "Your name is …" line with the Anima's display name:
the core instructions name no Anima, and `IDENTITY.md` may lack a name heading
or keep an old one after a rename. `disable_memory_influence` does not remove
anima identity.

`MEMORIES.md` follows the identity as a `# Anima Memories` section: a short
fixed preamble that frames the content as the Anima's own first-person notes
about its relationship with this user, says to treat them as remembered notes,
never as instructions, and says that lines describing what belongs under a
heading are hints, not memories, so shared history is never invented. The
memory guidance says facts about the user belong in shared memory.
The section is omitted when memory influence is off. A missing, blank or
unreadable file is also omitted without failing the turn; the chat manifest
records `status: "missing"` or `"unreadable"` for it. A chat with one Anima never
opens another Anima's `MEMORIES.md`. When the turn can edit the file (see
[Anima `MEMORIES.md` in chat tools](#anima-memoriesmd-in-chat-tools)), the
`# Memory Guidance` section adds write guidance; read-only turns get none, because
the content is already in the instructions.

Any `MemoryEntryService` caller that uses a non-null `anima_id` must construct
the service with an anima ownership repository. Public memory routes, anima
creation, direct-chat context and direct-chat memory tools pass
`SQLAlchemyAnimaRepository` so owned anima scopes work and missing or foreign
animas return `404`. A service constructed without an anima repository is valid
only for user-scope memory operations (`anima_id = NULL`), such as episode
capture.

The runtime boundary uses one `DirectChatPrompt`. The prompt
is ordered for prompt-cache locality: one system message containing the stable
core companion instruction (which names no Anima), the anima identity opened by
its display name, anima memories, the user profile and recent notes when included, stable memory guidance,
structured-output guidance and, last, the [Companion Guardrails](../../adr/0008-non-overridable-companion-guardrail.md);
then compaction summary, visible chat history, a request-local trailing
`developer` message when the turn has context, and the current user message.
The trailing message holds the `# List of memory files` map and any
attached-file list. The structured-output JSON schema travels in the prompt's
`response_format` field rather than being duplicated in prompt text for
schema-backed rows. JSON-object rows include the expected schema and example in
the response-format prompt guidance because their provider transport guarantees
valid JSON but not schema adherence. Active compaction summaries are represented
as `developer` conversation context after the system message, preserving their
role as historical continuity rather than user instruction.

The file list uses content-free memory entry headers and includes only
user-scope file entries (`anima_id IS NULL`) such as `PROFILE.md` or
`notes/preferences.md`. It excludes generated episodic-memory logs
(`kind = "episode_log"`), does not list anima-scoped entries, and does not
include a tree. Each YAML entry includes exactly `path` and `description`.
Opened-file status, versions, and SHA fingerprints remain durable metadata
under `chats.metadata.memory_context.opened_files`; they are not rendered in the
model-facing list. When `disable_memory_influence` is true, direct chat omits
the list and `MEMORIES.md` while still injecting anima identity.

Memory influence, memory updates and emotion updates resolve per turn in
`app/chat/options.py` (`merge_chat_request_options`; the shared
`product_http/chat/options.py` only loads the stored preferences): a request option
wins, then the Anima's `anima_settings.preferences`, then the owner's App
Settings in `user_settings.preferences`, then enabled. New Animas store no
memory/emotion flags, so they follow App Settings until an Anima sets its own
value. Memory updates are forced off whenever memory influence resolves off,
even when the two flags come from different levels.

Provider clients still stay independent from memory internals. They receive only
the OpenAI-compatible prompt and provider options, not ORM rows or filesystem
services. The prompt metadata may carry the durable memory-context manifest for
persistence, but file fingerprints are not rendered into model instruction text.
AI memory tools run through application services before the model-client
boundary, not inside provider adapters.

## Episodic Memory Capture

Direct chat's main structured response includes a required `remember` key whose
value can be a short string, `null`, or an empty string. The model should use it
only for notable durable context from the completed turn, such as new user
facts, preferences, decisions, active projects, or relationship/context changes.
The memory guidance states one sensitive-memory rule, once, for every memory
the model writes (memory files, `MEMORIES.md` and `remember`): no secrets, credentials or raw sensitive data, and no
suicide or self-harm crisis specifics (methods, plans, means) unless the user
explicitly asked; at most a general note. Ordinary health context may be
remembered.
It also states the shared memory-language rule (`MEMORY_LANGUAGE_RULE` in
`app/chat/conversation_language.py`, also stated to every Memory Manager run):
write new memory in the language of the conversation it comes from, keep
names, nicknames and quoted words as the user wrote them, leave existing text
untranslated, and name files in ASCII, which memory paths require. Notes then
match the words a later search uses. Memory tool results return non-English
text as written rather than as JSON `\uXXXX` escapes.

After a successful non-incognito `chat:sse` turn is parsed and persisted, the
backend best-effort captures nonblank `remember` text when memory updates are
enabled. Capture creates one `memory_episode_items` row and refreshes a
generated user-scope daily markdown file at:

```text
episodes/YYYY/MM/YYYY-MM-DD.md
```

The table is the source of truth for episode text, provenance, status, and local
date. The markdown file is a generated projection with unchecked checkbox items,
for example `- [ ] <!-- episode:mei-... --> ...`, so episode logs can be read
and searched through the memory filesystem. Capture is skipped for incognito
turns, for blank/null `remember`, and when memory updates are disabled. Capture
failures are logged and do not turn an otherwise successful chat response into
an SSE error.

Episode logs are excluded from the prompt's `# List of memory files`, and only
the Anima's recent notes from other chats enter its instructions (see
[Current Direct Chat Boundary](#current-direct-chat-boundary)). `search_memory_files`
includes the whole log by default. Callers can set
`include_episodic_memory=false` to search curated user memory only. Generated
episode files and their `episodes/**` parent directories are read-only to
public memory APIs and ordinary chat memory write tools. Internal episode
services can still refresh them when source-of-truth episode rows change.

## Chat Memory Cue

A persisted turn records what it remembered on its final visible assistant
message, so the chat can show a memory cue while streaming and after reload.
Before the turn is recorded, the executor stores `message_data.memory`:

- `updates_enabled`: whether memory updates were enabled for the turn.
- `memories`: the turn's net change to the Anima's `MEMORIES.md` as
  `{entry_id, version, excerpt}`, or `null`. `version` is the last version the
  turn wrote; `excerpt` holds the trimmed, non-blank lines added or changed
  between the content before the turn's first write and after its last one,
  joined by newlines and cut to 600 characters. A change that only removes text
  has an empty excerpt. An owner save between two of the Anima's writes in the
  same turn falls inside that range, so its lines can appear in the excerpt.
  Failed writes, and writes that leave the content unchanged, record `null`.

A captured `remember` note links back to the same message through
`memory_episode_items.source_message_id`. Both parts combine into one
`memory_cue` object:

```text
{
  "episode": {"text": str} | null,
  "memories": {"entry_id": str, "version": int, "excerpt": str} | null
}
```

`GET /v1/chats/{chat_id}/messages` returns it as `memory_cue` on visible
assistant messages, loading episode notes for the page in one owner-scoped
query; it is `null` when neither part exists and for all other messages. During
streaming the same object arrives in the `memory.updated` SSE event (see
[Direct chat runtime](../runtime/chat.md#sse-events)). Incognito turns are not
persisted and never carry a cue.

## Memory Manager API

The Memory Manager is a separate user-invoked workflow over user-scope memory
and, in general runs, owned Anima identities and `MEMORIES.md` files (changed
only when the owner asks). It proposes create/update patches for approval and
keeps episode logs read-only. Approvals use optimistic versions; rejection
leaves memory unchanged, and Undo is available only while the target still
matches the approved version. Identity approvals, Auto approve and Undo use the
trusted current-revision path described below, so an Anima rename does not
block them; a deleted Anima's pending approval returns `409` and can still be
rejected. Episode processing never reaches Anima files.

A **Reflection** (`POST /v1/memory/manager/runs:reflect`) is a Memory Manager
run bound to one Anima. It reads that Anima's chat turns that no applied
Reflection has covered, oldest first and at most 400 turns or 51,000 estimated
tokens of turn text per run, and may propose
changes only to that Anima's `MEMORIES.md`; other memory is read-only context.
Turns taken with memory updates off are never read. Its turns count as covered
only once its `MEMORIES.md` change is applied, and Undo of that change uncovers
them again.

The live runtime uses the Memory Manager model role: the App Settings
assignment `user_settings.preferences.models.memory_manager_model_provider_id`,
else `ANIMAMA_DEFAULT_MEMORY_MANAGER_MODEL_PROVIDER_ID`, else the default chat
model when it supports tool calling. The row's connection supplies the base URL
and key. Without a tool-capable model, runs fail with a message to choose one in
App Settings. `ANIMAMA_LLM_SKIP=1` selects the deterministic test runtime.

See [Memory Manager and episodic memory](memory-manager-and-episodic-memory.md)
for routes, fixed episode batches, approval/resume behavior, Undo, and recovery.

## Direct Chat Memory Tools

Direct `chat:sse` uses request-local JSON-schema function tools. These resolve
paths through the `memory_entries` cached path indexes and are scoped to user
memory (`anima_id IS NULL`), plus the active Anima's own `MEMORIES.md` through a
reserved alias. Models refer to files by user-scope paths such as `PROFILE.md`
or `notes/preferences.md`. Tool path validation rejects absolute paths,
`.`/`..`, explicit bracketed roots such as `[user]/...` other than the alias, and
`animas/...`; the identity stays backend-injected only.

### Anima `MEMORIES.md` in chat tools

The Anima addresses its own `MEMORIES.md` as `[self]/MEMORIES.md`, which the
tools resolve to the turn's Anima (`MemoryToolExecutionContext.anima_id`).
Bracketed names are never valid stored names, so the alias cannot collide with
a user file. Any other bracketed path, such as `[self]/IDENTITY.md` or
`[other]/MEMORIES.md`, returns `invalid_path`, so identities and other Animas'
files stay unreachable.

- `memory_read_files` reads it when memory influence is on.
- `memory_apply_patch`, `memory_write_file` in `replace` mode and native
  `update_file` edit the existing file when write tools are enabled (memory
  updates on and not incognito). Creating, deleting, moving or renaming it is
  refused: `memory_write_file` `create` returns `file_exists`, native
  `create_file`/`delete_file` return `patch_rejected`, and no chat tool moves
  files.
- A write over the 16 KiB `MEMORIES.md` limit saves nothing and returns
  `memories_too_large` (`retryable: true`) with a message asking the Anima to
  condense the file.
- A missing file returns `not_found` (`retryable: false`) naming the owner's
  repair action, for reads and writes alike (native `update_file` returns
  `patch_rejected` with the same message); with memory influence off the alias
  is unavailable.
- Whole-file replacement is fenced on the version the Anima last saw (the one in
  its instructions, a later read or its own write). A replacement after a newer
  owner edit returns the retryable `conflict` until the Anima reads the file
  again. Text replacements and native patches apply to the current content and
  keep the ordinary optimistic version check.

Successful edits keep `last_ai_write` audit metadata and feed the turn's
[memory cue](#chat-memory-cue). The list tool, search tool and memory map keep
excluding Anima files, whose content is already in the instructions. When the
turn can edit the file and it exists, the memory guidance tells the Anima to make
small relationship-only edits in the first person (user facts go to shared
memory such as `PROFILE.md`), to keep the file's existing headings (including
owner-written ones) and file each memory under the best fit, never to rewrite it
every turn, to stay well under
about 6,000 characters (about 3,000 in a non-Latin script such as Japanese,
Chinese, Korean, Thai or Hindi, whose characters take two or three bytes
against the 16 KiB limit), and never to frame the relationship as missing the
user, loneliness, jealousy or discouraging other relationships. The always-present
memory guidance says how `remember` (the shared episode log) differs from
`MEMORIES.md` (what the relationship means). It also says that notes from past
chats are logged and searchable, tells the model to search or read memory before
answering about the user's news, plans, projects or something they said earlier,
and before saying it does not remember, and to retry an empty search once with
other words. It skips memory when the answer is already in the conversation or
instructions, and for unrelated technical and attachment questions.

When memory influence is enabled, direct chat attaches:

- `memory_list_files`
- `memory_read_files`
- `search_memory_files`

Memory tools follow the selected row. A row without tool calling
(`supports_tools = false`) chats without any memory or upload tools instead of
failing setup; identity, `MEMORIES.md` and the memory map still reach its
prompt. A row whose owner turned off `allow_memory_writes` gets the read tools
only.

The request-local memory map is still injected into the prompt, and
`memory_list_files` gives the model an explicit way to refresh that navigation
context during a tool loop. Its output is a compact `files` array containing
only user-scope paths and descriptions. Generated episode logs are omitted from
this list. The same navigation projection is injected into the normal Anima
prompt, so directories, episode logs, and anima identity files are absent there;
general Memory Manager runs additionally list Anima identities and `MEMORIES.md`
files (see [Memory Manager and episodic memory](memory-manager-and-episodic-memory.md)).

When memory updates are enabled and the turn is not incognito, direct chat uses
one write transport selected from the persisted model capability:

- OpenAI Responses models whose catalog capability includes `apply_patch`
  receive the native Responses `apply_patch` tool. They do not receive
  `memory_apply_patch` or `memory_write_file`.
- Other providers, including Responses models without that capability, retain
  the `memory_apply_patch` and `memory_write_file` function tools.

The official OpenAI Responses `gpt-6-luna` row currently advertises native
Apply Patch; Chat Completions rows retain the function-tool writers. The capability is
an internal memory-write gate: clients cannot request `apply_patch` through the
generic `native_tools` request option. Incognito and
`disable_memory_updates=true` expose neither native nor function-tool writers.

When the model returns memory tool calls, `DirectChatTurnExecutor` validates
that the requested tool is available for the turn, parses the JSON arguments,
executes the call through `DirectChatMemoryToolService`, appends the assistant
tool-call message and matching tool-result message to the in-memory prompt, and
then calls the model again. The tool loop is bounded; if the model keeps asking
for tools at the limit, the executor makes one final no-tools call, then fails
the turn only if the model still requests tools.

Tool outputs are compact JSON strings. SHA fingerprints, byte sizes, timestamps,
and AI audit metadata stay in backend storage and are not sent back to the
model. Successful native Apply Patch output is the one exception for Version:
it returns the path, operation, and resulting Version. Error outputs use
`ok: false`, a stable error code, and only actionable retry hints such as
`path`, `matches`, or `retryable`.
`memory_read_files` is the exception for per-file failures: a valid batch keeps
`ok: true` and reports missing, invalid, or over-budget paths in its `errors`
array without discarding successful files.

### `memory_list_files`

Lists all live user-scope markdown file entries recursively. It calls
`MemoryEntryService.list_entry_headers(user_id=..., anima_id=None,
recursive=True)` so markdown content is not loaded for the list, then filters
the result to `type = "file"`. Directory entries are not returned directly, so
empty directories are invisible to this tool.

The model receives only a compact `files` array with each file's user-scope
`path` and `description`. Generated episode logs are not listed.

### `memory_read_files`

Reads one or more live user-scope markdown files, or `[self]/MEMORIES.md`. The
required `paths` argument accepts either one string or a non-empty list of
strings. Paths must be relative, POSIX-style, end in `.md`, and pass the same
tool path restrictions described above. The service deduplicates normalized
paths while preserving request order, accepts at most 10 unique paths, and
resolves each user path through `MemoryEntryService.get_entry_by_path(...)` with
`anima_id=None` and `type="file"`; `[self]/MEMORIES.md` resolves to the turn's
Anima.

The model receives stable `files` and `errors` arrays. Each successful item has
`path`, `description`, and `content`; each failed item has `path`, `code`,
`message`, and `retryable`. In custom-tool mode, `content` is the stored
Markdown body. In native-patch mode, the same field is a synthetic patch
document whose first three lines are `---`, a JSON-string-or-null
`description: ...`, and `---`, followed by the body. The 128 KiB call limit is
still calculated from stored body bytes, not the transient header. Generated
episode logs remain readable by an exact known path even though they are absent
from navigation.

### `search_memory_files`

Searches live user-scope markdown files by path, description, and content. The
model supplies `query` and `include_episodic_memory`; it cannot choose anima
scope, chat scope, file IDs, result limits, or context window size. Existing
callers that omit the boolean retain the default `true` behavior. With `false`,
the backend excludes both `kind = "episode_log"` files and paths under
`episodes/**` before ranking and applying the 10-result limit.

The query accepts PostgreSQL web-search syntax, but a file matches when it
contains any query word or quoted phrase, so natural queries such as
`new job start date` find a note that mentions only the job and its start.
Each space-separated word or quoted phrase is parsed with
`websearch_to_tsquery('english', ...)`, which applies stemming, stop words and
phrase adjacency; `OR` is redundant. `-term` exclusions remove every file that
contains the term. Files that match more of the query's words and phrases rank
above files that match fewer, and `ts_rank_cd` orders files with the same
count. Only the first 32 words or phrases are used; every exclusion applies.

The `english` parser splits words only at spaces and punctuation, so Japanese,
Chinese and Thai text becomes one token per run and Korean words keep their
particles (`서울에서`). A word or quoted phrase containing a non-ASCII letter or
digit therefore also matches as a case-insensitive substring (`ILIKE`, with
`%`, `_` and `\` matched literally) of the path, description and content,
after punctuation at its ends such as `「」` is removed. A non-ASCII `-term`
excludes files containing it anywhere, and an exclusion that is only a stop
word or punctuation excludes nothing. `京都` finds
`週末に京都で抹茶を飲みました。`. A substring-only match counts toward the
matched-word ranking with a `ts_rank_cd` of 0, so whole-word matches rank first
among files with the same count. ASCII-only words keep word matching, so `cat`
does not find `category`, but a non-ASCII word in a spaced script also matches
inside longer words (`кот` finds `который`). An unspaced run must appear
verbatim (`京都で抹茶` does not find `京都の抹茶`), and case folding of
non-ASCII letters follows the database LC_CTYPE. Substring matching needs no
extension or schema change and scans the owner's live files in scope without an
index. A `pg_trgm` index would not help: it cannot index two-character words
such as `京都` and extracts no trigrams from CJK text under a `C` locale.

The tool description asks the model for 2-5 distinctive keywords
rather than a full question, separated by spaces in Japanese, Chinese or Thai
too, and explains that matching any keyword is enough;
both Memory Manager runtimes reuse that description.

The model receives a `memory_results` array. Markdown memory hits include
`path`, `description`, and `snippet`. The tool does not return entry IDs,
versions, hashes, timestamps, user IDs, metadata, scores, or match types.
Episode-log content can appear in default searches but not curated-only searches.

### `search_uploaded_files`

Searches processed uploaded-file chunks attached to the current chat request.
The model supplies `query` plus the required nullable `file_names` filter. The
filter accepts one filename, an array of filenames, or `null`; `null` searches
all attached files. Matching is case-insensitive, and any invalid selected
filename makes the call fall back to searching every attachment. The model cannot
choose opaque file IDs, result limits, retrieval modes, or context window size.
The tool is only equipped when memory influence/read tools are enabled and the
`chat:sse` request includes attached file IDs that validate as current-user
uploads in searchable processed statuses such as `ready` and
`ready_keyword_only` with at least one chunk.

When the upload tools are equipped, the prompt includes a request-local list of
the validated attached filenames and their persisted chunk counts. The list
opens with the attachment guidance (when to read files before answering, and
not to answer from memory files instead), so turns without attachments carry
none of it. A count is
backend-derived navigation metadata that helps the model plan bounded reads; it
is not document-content evidence. The list follows the memory map in the
`developer` message before the user's message; providers without developer-role
support receive it in the `<turn_context>` block that starts the user message.
Distinct attachments with the same filename stay
as separate map entries because filename-based upload tools operate on every
matching attachment.

Uploaded chunks use hybrid keyword plus semantic search when the owner's
Embeddings role is on and every searched chunk was embedded with that model.
While the role is off, or the attached files await re-embedding, the search is
keyword-only; a failed query embedding or search also falls back to keywords.
The model receives an
`uploaded_file_results` array. Hits include only `filename`, `chunk_index`, and
`snippet`. The tool does not return file IDs, chunk IDs, extensions,
object-storage keys, download URLs, user IDs, embeddings, metadata, scores,
match types, hashes, or timestamps.

One query is intentionally used for both retrieval legs. Its keyword leg accepts
PostgreSQL web-search syntax such as quoted phrases, `OR`, and `-term`
exclusions, while the unchanged query text is embedded for semantic retrieval
only when the semantic leg runs.

### `read_uploaded_file_chunks`

Reads a bounded ordered range from one processed uploaded filename attached to
the current chat request. It is equipped beside `search_uploaded_files` under
the same memory-read and validated-attachment policy. The model supplies the
required `file_name`, `start_chunk`, and `chunk_count`; chunk counts are limited
to 1 through 5. Filename matching is exact and case-insensitive. An unknown or
blank filename returns `attached_file_not_found` and never falls back to another
attachment. If multiple validated attachments have the same filename, the tool
returns one file group for each in request attachment order.

Each result group contains the canonical `filename`, requested `start_chunk`,
complete `chunks` containing only `chunk_index` and `text`, and
`next_start_chunk`/`has_more` pagination. The serialized result is bounded to
about 6,000 estimated tokens (24,000 English characters, or about 6,000
Japanese or Chinese ones). The reader never exposes file IDs, chunk IDs, embeddings,
parser metadata, object-storage keys, URLs, or database errors.

Use uploaded-file search for relevance lookup, exact phrases, and finding a
likely chunk index. Use ordered reads for whole-document synthesis, sequential
sections, and surrounding context. Whole-document synthesis begins at chunk
zero and continues from `next_start_chunk` while `has_more` is true.

### Native Responses `apply_patch`

Native-capable Responses requests send the OpenAI SDK `apply_patch` tool
alongside the existing read/search functions and the normal structured response
format. A completed `apply_patch_call` is converted to Animama's
provider-neutral tool-call record, planned against the virtual user-memory
workspace with the Agents SDK V4A `apply_diff(...)` implementation, and
committed immediately through `MemoryEntryService`. Direct chat does not add a
human approval step.

The planner accepts exactly one `create_file` or `update_file` operation for a
relative Markdown path, or an `update_file` of `[self]/MEMORIES.md`. It rejects
delete, absolute/traversal and non-Markdown paths, `episodes/**`, `animas/**`,
other bracketed paths, existing-file creates, missing-file updates,
oversized results, malformed synthetic headers, complete normalized no-ops,
and stale versions without mutation. Creates and updates apply the diff to the
complete synthetic document returned by `memory_read_files`, then strictly
split its normalized description from its byte-preserved Markdown body. Only a
JSON string or `null` is accepted for the one reserved description field;
duplicate, additional, missing, and unterminated fields are invalid. The header
is never persisted. Creates use `kind="user_memory"`, and both operations write
body and description atomically through one optimistic check and one Version.
The model never receives an entry ID; successful output returns the resulting
Version so it can reason about the completed write.

The write tools' `description` parameters (and the native patch guidance)
treat descriptions as the file index shown in the memory map. Every content
edit must reconsider whether the description still accurately summarizes the
file: preserve it verbatim when it does, update it when scope or durable
contents materially change, and give new files a concise useful description.
This is guidance rather than a requirement that every body patch also change
the description. `description: null` remains valid.

Every native call receives one matching Responses `apply_patch_call_output`
whose status is `completed` or `failed`. Cursor-backed rounds send only the
trailing outputs with `previous_response_id`; explicit replay sends the typed
call and output items. Results are cached by call ID so an identical repeated
call is not written twice, while reuse of an ID with different operation data
fails. Successful turns persist hidden provider-neutral call/result rows for
future replay. Sanitized provider observations retain call ID, operation type,
status, and path length, but never the path or diff.

### `memory_apply_patch`

Edits one existing user-scope markdown file, or `[self]/MEMORIES.md`, using
exact text replacements. The backend first loads the current file by path, then
applies each replacement to the loaded content in memory. `old_text` must be
non-empty. If `old_text` is not found, no write happens. If `old_text` appears
multiple times and `replace_all=false`, no write happens and the tool returns an
`ambiguous_replacement` error with the match count. Each call may include at
most 10 replacements.

If every replacement is valid, the backend writes through
`MemoryEntryService.patch_entry(...)` with `expected_version` set to the
version observed during the read. The model never supplies the version. A
concurrent edit therefore returns a retryable conflict instead of overwriting
newer content. Generated episode logs and any path under `episodes/**` return
the stable `protected_memory_file` tool error and are not modified.

Every chat memory tool call runs in its own short write session whose lock waits
end after 6 seconds (`MEMORY_TOOL_LOCK_TIMEOUT_SECONDS`). A write to a file another
transaction still holds, such as an owner-started Memory Manager approval resuming
its model, returns the retryable `busy` tool error instead of stalling the turn.

The model receives only the affected `path` and the total
`replacements_applied`. If `update_description=true`, the supplied
`description` is also stored.

### `memory_write_file`

Creates or fully replaces one user-scope markdown file; `[self]/MEMORIES.md` can
only be replaced. The model supplies `path`, `mode`, `content`, and
`description`. The mode must be `create` or `replace`.

In `create` mode, an existing file returns `file_exists`; otherwise the backend
creates the file with `kind = "user_memory"` and `expected_version = 0`.
Missing user-scope parent directories are auto-created as durable directory
entries. Paths under `episodes/**` return `protected_memory_file`.

In `replace` mode, a missing file returns `file_missing`; otherwise the backend
overwrites the full file content, preserves the existing `kind`, and writes with
`expected_version` set to the version observed during the pre-write read.
Existing generated episode logs return `protected_memory_file`.

The model receives only the affected `path` and the write `mode`.

Successful AI writes append normal `memory_entry_versions` rows. Version
change metadata records the AI actor type, anima, chat, run, provider, model, tool
name/type, operation, and tool-call ID when applicable. A native patch is an
immediate side effect: if it commits but the later visible final response
fails, the memory version remains durable and its audit metadata is
authoritative. Non-incognito successful tool-assisted chat turns also
persist compact internal `chat_messages` rows for assistant tool calls and tool
results, including the raw provider-message shapes replayed on later turns.
Visible chat history and chat search continue to exclude internal rows.

Memory tool support is enabled for `OpenAIHTTPAgent` (Chat Completions on any
connection), `OpenAIResponsesHTTPAgent`, `ChatGPTPlanResponsesHTTPAgent`,
`AnthropicMessagesHTTPAgent` and `MockModelClient` rows that support tool
calling. The Responses adapter maps read/search and writer functions onto
Responses `function` and `function_call_output` items, and maps native-capable
writes onto SDK `apply_patch_call` and `apply_patch_call_output` items. A
ChatGPT plan model writes memory through the functions only, because its route
refuses `apply_patch`
([model client providers](../runtime/model-client-providers.md)). The Anthropic adapter
sends the same functions as strict tools and replays their calls as
`tool_use`/`tool_result` blocks; chat never uses Anthropic's native memory
tool, which only the Memory Manager offers. Other rows chat without memory
tools.

## User Memory Entry Tree

The memory filesystem uses a scoped `memory_entries` tree. The root is virtual; a row with `parent_id = NULL` is a
top-level entry in the selected scope. Rows with `anima_id IS NULL` are
account-wide user memory, and rows with `anima_id IS NOT NULL` are scoped to one
anima. Files and directories share identity, parent/name uniqueness, soft-delete
lifecycle, move/rename behavior, and version history.

Files are markdown documents. Directories are durable entries that can be empty.
User-visible paths are cached from parent/name relationships for fast exact
lookup, for example:

- user scope: `PROFILE.md`
- user scope: `notes/preferences.md`
- active anima scope: `IDENTITY.md` and `MEMORIES.md`

The backend exposes authenticated CRUD routes under `/v1/memory/entries`:

- `GET /v1/memory/entries?anima_id=&parent_id=&recursive=false`: list live
  entries under a virtual root or directory parent.
- `GET /v1/memory/entries/by-path?anima_id=&path=...&type=file`: read one live
  entry by cached path in a scope.
- `GET /v1/memory/entries/{entry_id}`: read one live entry by stable ID.
- `POST /v1/memory/entries/{entry_id}:revert`: copy content and normalized
  description from an older Version into a new latest Version, guarded by the
  current `expected_version`.
- `POST /v1/memory/entries`: create a file or directory under an explicit
  `parent_id`; `expected_version` defaults to `0`. A file request may set
  `create_parents=true` and provide a relative Markdown path in `name`, such as
  `projects/launch.md`, to create missing directories beneath that parent.
- `PATCH /v1/memory/entries/{entry_id}`: update file content/metadata or
  move/rename one entry. It requires `expected_version` and rejects mixed
  content edits plus move/rename.
- `DELETE /v1/memory/entries/{entry_id}?expected_version=N&recursive=false`:
  soft-delete one entry. Non-recursive directory deletes return `409 Conflict`
  when live children exist; `recursive=true` soft-deletes descendants too.
- `GET /v1/memory/anima-identities`: list every owned Anima in creation order
  with `display_name`, `aggregate_revision`, `identity_status`, its
  content-free `IDENTITY.md` header (`entry`) and `MEMORIES.md` header
  (`memories_entry`). Either header is `null` when that file is missing and
  needs repair. The Memory workspace uses it for the virtual Animas directory.
- `POST /v1/memory/anima-memories/{anima_id}:repair`: recreate a missing
  `MEMORIES.md` from the template and return its header. An existing file,
  including a blank one, is returned unchanged. A missing or foreign Anima
  returns `404`.

A move that supplies `parent_id` runs through `MemoryEntryService` in one unit
of work. The moved row receives its new parent and cached path, and every live
descendant receives the corresponding `path` and `normalized_path` prefix
replacement. The moved row and each affected descendant advance exactly one
version and append exactly one `move` snapshot to
`memory_entry_versions`; collision, cycle, scope, protected-path, and maximum
path checks happen before commit. A failed operation therefore does not leave a
partially moved subtree.

Repository descendant lookups treat normalized path prefixes literally.
Recursive listing and search plus subtree move and delete operations use
SQLAlchemy's escaped `startswith(..., autoescape=True)` predicate, so valid
characters such as `_` cannot act as SQL `LIKE` wildcards and include an
unrelated sibling subtree.

Generated episode logs reserve the user-scope `episodes/**` namespace. Public
create, patch, move/rename, metadata edit, and delete operations against
`episodes/**` entries or entries with `kind = "episode_log"` return `403
Forbidden`. Internal episodic-memory services pass a system-managed write flag
when regenerating those files from `memory_episode_items`.

User scope also reserves `animas` and `animas/**` (case-insensitively) for the
Memory workspace's virtual Anima folders. Creating, moving or
renaming a user entry to those paths returns `403 Forbidden`. An entry that
already exists there stays readable and can be moved, renamed out or deleted,
but content, description and Revert edits return `403` until it is moved.
Anima-scoped paths are unaffected.

All entry routes are scoped by the admitted installation request principal. When `anima_id` is non-null, the API
validates that the anima belongs to that owner. Unit tests replace the FastAPI
principal dependency explicitly; there is no test-header authentication path.

Responses include `id`, `parent_id`, `anima_id`, derived `scope`, `type`,
`name`, cached `path`, `kind`, `description`, `version`, timestamps, metadata,
and file header fields such as `size_bytes` and `content_sha256`. The list
endpoint returns that same header shape without selecting markdown `content`.
File reads by ID or by path include `content`; directory reads have
`content = null`.

Anima identity file detail responses also carry `aggregate_revision`. Its
create/repair, PATCH, and Revert operations require a positive
`expected_aggregate_revision` in addition to the memory `expected_version`.
The common Anima row lock is acquired before the memory row lock; a concurrent
name/equipment/identity edit returns `409` rather than overwriting newer
definition state. Successful identity writes increment memory and aggregate
revision once and append a compact definition audit pointer in the same
transaction. A materializer's initial identity/history and aggregate both
start at revision 1 without an intermediate edit revision.

The Anima-scoped root `IDENTITY.md` must be a file with kind `anima_identity`.
New/edited identity is nonblank UTF-8 Markdown, rejects NUL, normalizes CRLF/CR
to LF, and preserves other Markdown whitespace. Its byte limit is the smaller
of 32 KiB and `ANIMAMA_MEMORY_FILE_MAX_BYTES`. Generic API paths cannot bypass
these rules by changing kind or moving/renaming/deleting the file. Ordinary
user memory retains its existing version-only behavior.

Trusted internal service callers (Memory Manager approval and Undo) omit the
aggregate revision by passing `use_current_aggregate_revision` to
`MemoryEntryService`; the public API does not expose it. They lock the Anima at its current revision, so a
concurrent rename does not invalidate an already-reviewed identity change,
while the memory `expected_version` still rejects newer identity content. These
writes keep the nonblank rule and record a definition revision like explicit edits.

The Anima-scoped root `MEMORIES.md` must be a file with kind `anima_memories`.
It follows the identity's Markdown rules except that it may be blank, and its
byte limit is the smaller of 16 KiB and `ANIMAMA_MEMORY_FILE_MAX_BYTES`
(`anima_memories_invalid` and `anima_memories_too_large` return `400`). It
cannot be renamed, moved, deleted or retyped. Unlike identity it is not part of
the Anima definition: writes use only the memory `expected_version`, return
`aggregate_revision: null`, and never advance or conflict with the aggregate
revision.

An Anima scope admits only these two root files. Creating any other file or
directory there, or moving or renaming an entry within it, returns `403`.

Deleting an Anima (`DELETE /v1/animas/{anima_id}`) permanently removes all of
its Anima-scoped memory entries and their versions, including `IDENTITY.md` and
`MEMORIES.md`, and its Reflection coverage, in the same transaction as the Anima row. Memory Manager approvals and messages
that quoted the identity remain as run history, so a pending proposal can still
be rejected.
A legacy directory obstructing the reserved path is not an identity file:
the owner may explicitly delete it, then create the missing identity with the
current aggregate revision. Nothing deletes or overwrites it automatically.

Entry names are stable POSIX path segments, not display names. The service
rejects blank names, `.`, `..`, slashes, backslashes, control characters,
unsupported display characters, paths over 512 characters, segments over 128
characters, and non-`.md` file paths. Parent entries must be directories in the
same user/anima scope. Move operations reject cycles, cross-user moves,
cross-anima-scope moves, and parenting under files. Renaming or moving a
directory recomputes cached paths for all live descendants in the same
transaction using a bounded repository subtree update. Each live descendant
whose cached path changes also receives a version increment and an internal
`move` audit row with its new cached path.

Each current file entry stores content, SHA-256, byte size, version, optional
`kind`, optional `description`, metadata JSON, timestamps, and `deleted_at`.
Content is always the stored Markdown body; the native-patch synthetic header
never participates in content bytes, hashes, full-text body search, or Version
snapshots.
Directory entries store the same identity/metadata fields but no content,
content hash, or size. Source/provenance details such as avatar template origin
belong under metadata, for example `metadata.source.avatar_id`, not dedicated
columns. Content is limited by `ANIMAMA_MEMORY_FILE_MAX_BYTES`, default `32768`
bytes. Successful create/update/move/delete operations append internal
`memory_entry_versions` audit rows. Recursive directory deletes soft-delete all
live descendants with a bounded repository subtree update and append descendant
`delete` audit rows in the same transaction. Blank descriptions are normalized
to `NULL`.

### Immutable version history

Every successful create, update, move, soft delete, Undo, or Revert appends a
complete, immutable post-change snapshot to `memory_entry_versions`. The current entry
and its snapshots share a positive, monotonically increasing `version` number.
Audit-only provenance is stored separately as `change_metadata`; it does not
change the entry's own metadata snapshot.

Admitted local clients can read history by stable entry ID:

- `GET /v1/memory/entries/{entry_id}/versions?before_version=&limit=50` lists
  content-free summaries newest first. `before_version` provides cursor
  pagination; the default page size is 50 and the maximum is 100.
- `GET /v1/memory/entries/{entry_id}/versions/{version}` returns one immutable
  snapshot and only its adjacent change. Version N compares with Version N-1;
  Version 1 compares with a virtual empty Version 0 creation baseline.

The detail response includes a unified content diff and structured old/new
values for path and description, so move-only and description-only changes stay
understandable. A missing predecessor for Version N greater than 1 is treated as
corrupt history rather than compared with another row. Ownership checks include
soft-deleted current entries, and generated episode logs expose the same
history. It does not provide arbitrary two-version comparison. Generated logs,
protected entries, directories, deleted entries, and foreign entries cannot be
Reverted.

Revert accepts an older `target_version` and exact positive
`expected_version`. It copies only the target snapshot's content and normalized
description into the editable live Markdown file and appends a `revert`
Version. Identity, name, parent, path, kind, metadata, scope, and live state are
preserved. Current/future/missing/no-change targets are rejected. The version's
`change_metadata` records that the mutation came from the entry itself and
which historical Version was selected; this is audit provenance and is not
copied into the entry's user-facing metadata.

`AnimaAggregateMaterializer` stores the resolved identity in an Anima-scoped
`IDENTITY.md` entry with `kind = "anima_identity"` and
`description = "{anima.display_name}'s identity"`, then creates
`MEMORIES.md` from its template (sections Our story, How we are together, What
works between us and Open threads, each with a hint line) with
`kind = "anima_memories"` and `description = "{anima.display_name}'s memories"`
(also used when a missing `MEMORIES.md` is repaired). Later renames leave both
descriptions unchanged. It uses the caller's SQL transaction with no physical-file projection or
independent commit, so a failure leaves neither file.
Strict live creation supplies the authored Markdown, and backend starters
supply their configured identity through the same materializer. Later Avatar edits and chat turns
cannot synchronize or overwrite the existing live identity.

Installation bootstrap seeds one user-scope `PROFILE.md` entry with
`kind = "user_profile"` from template version 2: an `# About me` heading and
Basics, Life right now, People, Interests, Goals, Routines and How I like to be
treated sections, each with a hint line. Optional first-run display-name
completion writes a bootstrap-managed `Preferred name:` line in the same backend
transaction: it replaces an existing line, otherwise goes under a Basics heading,
the first heading or the top, so it does not depend on the template's wording.
Any other edit to the file stops later personalization from overwriting it. While memory influence is enabled, direct chat
includes the profile's content in its instructions (see
[Current Direct Chat Boundary](#current-direct-chat-boundary)), and its path and
description appear in the memory file list.

The current direct-chat path feeds the selected anima identity and memories
entries into prompt context and exposes the scoped AI tools above. The frontend
exposes user-scope memory files from `/memories` and anima identity editing
from `/animas/{anima_id}/identity`. AI tools still do not expose delete,
move/copy, arbitrary metadata editing, or anima-scoped file reads or writes.

## User Files And Archives

User-file uploads are separate from memory. The private `/memories` Uploads
tab is currently an operational debug/upload page for installation-owned files,
processing jobs, and retrieval search. Chat turns may attach processed upload
IDs, which lets the backend equip the read-only `search_uploaded_files` and
`read_uploaded_file_chunks` AI tools for that request.

Anima archives store passages separately from the memory filesystem.
Archive routes create/list/update/delete passages and search them:

- `GET /v1/animas/{anima_id}/archive`
- `GET /v1/animas/{anima_id}/archive/passages`
- `POST /v1/animas/{anima_id}/archive/passages`
- `PATCH /v1/animas/{anima_id}/archive/passages/{passage_id}`
- `DELETE /v1/animas/{anima_id}/archive/passages/{passage_id}`
- `POST /v1/animas/{anima_id}/archive/search`

Creating a passage, or changing its text, embeds the text with the Embeddings
role model when the role is on; a failure leaves the passage for the
re-embedding task. Search embeds the query and uses pgvector cosine distance
over that model's vectors through `SQLAlchemyArchiveRepository.search_passages`.
While the role is off, passages await re-embedding or the query embedding
fails, search uses PostgreSQL full-text ranking instead and ignores
`threshold`.

## Extension constraints

Changes to the memory filesystem must:

1. preserve incognito and memory-disabled behavior for durable writes
2. continue hardening the frontend workflows for profile and anima identity
   editing
3. consider delete, move/copy, and richer metadata workflows only after their
   ownership and audit behavior are explicit

Use this guide's current API and ownership invariants when proposing those
changes. Record new behavior and validation in the change's review record;
private planning documents are not required to maintain the filesystem.
