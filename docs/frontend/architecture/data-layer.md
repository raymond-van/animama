# Data Layer Guide

The web app uses generated OpenAPI client methods plus TanStack Query.

## Generated client

Generated files live in `src/frontend/packages/runtime-contracts/src/generated`.
Do not hand-edit this directory. Consumers import `@animama/runtime-contracts/sdk`
for methods and `@animama/runtime-contracts/api-types` for types. `pnpm openapi-ts` asks the backend's deterministic offline exporter
to write a temporary schema, generates from that file, and always removes it.
Public HTTP OpenAPI routes are disabled. Install dependencies from the frozen
Python and pnpm lockfiles first; generation uses `uv run --frozen --no-sync`
and does not install or update dependencies.

Run `pnpm openapi-ts:check` to check SDK freshness without editing generated
files. It exports the schema and generates a candidate entirely in a temporary
directory, compares the tracked SDK inventory and canonical Prettier-formatted
bytes, then removes the temporary output even on failure. Formatting is applied
in memory to both sides so generator-style whitespace alone is not drift.
Missing, extra, or stale files fail with bounded path diagnostics; no schema or
source bodies are printed by the comparison. Fix drift with `pnpm openapi-ts`,
review the generated changes, and rebuild the package artifacts.

The generated client exposes infrastructure-only Content Catalog operations,
typed product List/Get/Save/Preview methods, package import/export,
registered-file delivery, typed Anima loadout commands/runtime closures,
Avatars, appearances, and the rest of the product API. Gesture, Reaction, Pose,
effect, sound, idle, Avatar, Appearance, and voice hooks consume their
generated discriminated contracts while retaining the one catalog item
identity underneath.

The client also exposes `AnimaSpec`, strict direct creation/options/validation,
backend starter ensure/repair, and Avatar portrait Save contracts. Direct
`POST /v1/animas` requires the complete `AnimaSpec` payload. Creation retries
must reuse the complete frozen spec and body idempotency key; replay resolves
before revalidating current sources. Typed preview responses expose the complete
creation-compatible `expected_source_revisions` map, including supports; it is
revision evidence, not a preview or runtime pin. Saved drafts retain retired clip
revision evidence for recovery. New commands reject it; an exact frozen legacy
request can only replay a recorded result through the private compatibility decoder.

The generated SDK includes `resolveContentEvidence` and `prepareContentPreviews`
methods. The former is a metadata-only batch read; the latter creates one
ephemeral protected-file lease for a successful root union. They remain
separate so a revision refresh cannot acquire files or write preview state.

`query/hooks/useAnimaCreation.ts` owns owner-scoped typed source/options reads,
Local Avatar/Appearance Save, exact protected preview, whole-draft validation,
and strict creation. Step components call these adapters rather than fetching
the backend directly. The creator freezes and durably saves its command before
dispatch; mutations never automatically retry or run on mount. Unknown outcomes
replay before any mutable-source read. Shared preview metadata uses its own
query cancellation signal; prepared bytes are consumer-owned. Onboarding uses
the generated starter-only SDK.

Actions-to-Review sends one evidence request containing all unique selected
roots and fixed Idle, applies nothing from a partial response, compares prior
support evidence, then calls whole-spec validation. It does not issue typed
previews. `useActionComponentPreviews` instead keys one bundled preparation by
owner and the canonical unique component-source set. Repeated aliases map to
the same closure locally; focus/reconnect renew only a lease already near
expiry.

## Typed loadout queries

`useAnimaLoadout` owns the server-composed typed loadout read model.
`useAnimaLoadoutMutations` exposes Gesture and Appearance plan/commit
commands, plus `changeIdle` and `changeReaction`, which plan and commit one
Idle or Reaction pool change in a single action under a fresh idempotency key
and never commit a rejected plan. `changeReaction` also returns the plan's
warnings, such as a starter Reaction a restore skipped. A plan carries the
current optimistic revision and typed intent; commit repeats it with the plan
digest and idempotency key. Successful reviewed commits, and pool changes
whether or not they succeed, narrowly invalidate the affected Anima's loadout
and next runtime mount. VFX and SFX have no direct equipment mutation. Standalone Pose Clips are not
supported catalog products; clip data belongs to its Gesture or Reaction.

`useAnimaRuntimeCatalog` loads one exact closure descriptor.
`AnimaRouteProviders` prepares every admitted byte once, verifies size/digest,
creates mount-scoped object URLs, freezes the resulting revision, and passes
that same revision to chat. It never silently retries a message against a newer
revision; `runtime_remount_required` preserves the unsent text and offers a
fresh Avatar-session mount.

After creation, `CreateAnimaCompletion` prepares one mount and seeds the same
runtime query key. The owner/revision-scoped `creationRuntimeHandoff` lease
lets `AnimaRouteProviders` claim those prepared bytes instead of preparing them
again. Unclaimed offers expire; released leases dispose after StrictMode effect
replay. Runtime failure never retries creation or creates a Chat row.

## Private file delivery and previews

Browser runtime code receives registered FastAPI file URLs and never a host
storage locator. `VerifiedByteLoader` fetches each admitted member through the
same-origin application route, checks its declared size and digest, and hands the bytes
to `RuntimeMountPreparer` or `PreviewByteSession`. Images, VRMs, VRMAs, JSON,
and audio become mount-owned Blob URLs or decoded resources. Runtime playback
does not perform another API capability exchange or typed-content fetch.

Typed preview hooks resolve deliberate Included or Local catalog items into
short-lived exact preview closures. Gesture and Reaction previews include their
complete effect and sound dependencies. The Action editor reuses a loaded
saved root closure initially and prepares one bundled lease only when its
dependency set changes. The Library Preview Dock and Anima
management stage own the existing Canvas; dialogs pass targets and callbacks
rather than mounting another WebGL renderer. Preview state never mutates the
Anima loadout or the live runtime catalog.

## API client and capabilities

There is no global API client: compositions and feature code never configure or
use `@animama/runtime-contracts/default-client`. Query hooks and mutations take
the admitted session's client from `useProductApiClient()` (see
[Packed product boundary](#packed-product-boundary)) and pass it as `client` to
each SDK call. The local entrypoint's browser-wide interceptor
(`lib/local-gateway/fetch-interceptor.ts`) adds only `X-Animama-CSRF: 1` to
same-origin mutating `/v1` fetches; the hosted transport sends its session CSRF
token. Owner-scoped query keys use the session cache key from
`useRuntimeCacheKey()`, never the server owner ID, and wait for it.

`useRuntimeCapabilities()` starts from the admitted capabilities. A hosted
runtime keeps the permissions of its current admission; a local runtime
refreshes them from `GET /v1/runtime-capabilities` (worker heartbeats and speech
model changes). Product entry points are offered only for a capability that is
`true`. An entry point whose capability the runtime reports `false` stays
visible but disabled with the shared hosted exclusion reason
(`RuntimeFeatureGate`, `UnavailableAction`); while capabilities are unknown it
stays hidden.

Frontend env access should go through `src/frontend/web/src/platform/env.ts`.

## Query Conventions

- Query keys are owned by `@animama/product-ui/query`; the local `query/keys.ts`
  path re-exports them.
- Read hooks live under `src/frontend/web/src/query/hooks`.
- Mutations live under `src/frontend/web/src/query/mutations`.
- Use narrow cache invalidation or explicit cache updates after mutations.
- Keep server state in TanStack Query; keep transient runtime/UI state in
  Zustand stores.

## Packed product boundary

`@animama/product-ui` owns the existing Anima selection, chat session, SSE
classification, transcript, and composer primitives. It exports query hooks via
`/query`, session and pure stream helpers via `/chat`, the dependency-free audio
tag grammar via `/audio-tags`, presentation via `/components`, the UI Locale
runtime and formatters via `/i18n`, and compiled
`/styles.css`. The local paths re-export these implementations, so the ordinary
application uses the packed core. `@animama/runtime-contracts/locale` holds the
supported UI Locales and their resolution
([internationalization](i18n.md)).

`ProductRuntimeProvider` takes an explicit `RuntimeOwner`, chat capability,
`ProductApiTransport`, optional session key and diagnostics adapter. The host
provides a TanStack `QueryClientProvider`; private queries and recovery drafts
partition by session key, and the generated client is created separately for each
transport. `useRuntimeOwnerId` remains the opaque product owner;
`useRuntimeCacheKey` identifies the private browser lifetime. No installation
readiness, local account policy, desktop bridge, router, or settings provider is
imported by the package. Runtime image URLs resolve against this transport and
keep owner-scoped Blob leases; they never assume the consuming page's origin.

`RuntimeOwnerProvider` adapts admitted ownership to this provider. Shared hooks
use `useProductApiClient`; content and speech helpers receive that client
explicitly. Each entrypoint installs its same-origin transport before React.
Local requests retain the mutation CSRF marker; hosted requests use current
cookie and CSRF authority without a browser credential store or owner header.

`main.local.tsx` and `main.hosted.tsx` mount the same providers, router, screens
and styles. `RuntimeController` owns each query cache and request/body lifetime.
Sign-out, revoked admission and a changed session key abort old work, clear private
module state and dispose workers, microphone tracks, playback, audio graphs and
object URLs before the next session mounts. A feature that keeps a private draft
in a module-level variable registers its reset with `registerPrivateStateReset`
(`app/runtime/private-module-state.ts`); worker clients end synchronously, since
the session also terminates their workers. Hosted recovery drafts use a fresh
session namespace, including same-owner reauthentication; local recovery retains
its installation namespace. Hosted teardown fences new recovery writes, waits
for started writes, then removes that lifetime's creator IndexedDB records,
private image bytes and recovery fallbacks. Awaited sign-out and replacement
admission wait for the deletion commits. Browser device preferences and downloaded public
model data retain their existing storage. See the [hosted contract](../../../contracts/hosted-web.md).

## Local Runtime And Profile

The local adapter first calls `GET /v1/runtime-context`. A ready backend
does not need another content scan or defaults ensure. Only a `repair_required`
response triggers `POST /v1/runtime/bootstrap:ensure`; its returned context is
used directly without another GET. The adapter shares concurrent initialization
requests but retains no completed-context cache. It exposes loading, ready, and
unavailable states; Retry makes a fresh context read and repairs only if
needed. Network/authorization failures are surfaced without issuing repair
mutations. Only admitted state supplies the installation principal to shared
features through `RuntimeOwnerContext`. First-run state remains local to the
local composition.

The app layout gates application content on the backend's `first_run_complete`.
`/setup` collects a nonblank private name, then Finish opens the first Anima URL
with a blocking 18+ modal. Explicit confirmation
calls `POST /v1/runtime/onboarding:complete` with `adult_confirmed: true` and
the model set up last in the AI step (saving the OpenAI or Anthropic key,
signing in with a ChatGPT plan, or adding a chat model), if any. Text-to-Speech is on by
default with built-in voices (`DEFAULT_ANIMAMA_PREFERENCES`); `/setup` sits outside
`SettingsProvider`, so a provider chosen in the Voice step is saved with
`useMergeUserPreferences` (fresh read, merge, write). The step and nonsecret
choices persist in a per-owner localStorage draft (`setup-draft.ts`), never
keys or proof of age confirmation. Repeating the request after a lost response returns the completed
context. The `/` entry route shares the owned Anima and user
settings queries, waits for both, and opens the remembered owned Anima
(`last_active_anima_id`) or the first in stable creation order. Desktop PiP
and quick-chat windows wait for readiness without rendering setup.

`useUserProfile` reads the minimal private profile and
`useUpdateUserProfile` writes its required nonblank display name; only the
pre-setup bootstrap placeholder may be null. Successful updates
publish the authoritative response under the principal-scoped profile query
key. There are no browser profile-ensure, username, creator-resolution, public
visibility, or account-session operations. Installation bootstrap and the
guarded `PROFILE.md` preferred-name update belong to FastAPI.

## Chat Search

Sidebar chat search uses the generated `POST /v1/chats/search` client through
`useSearchChatMessages`. The modal keeps query text, pagination, and open/close
state locally because search results are transient navigation data rather than
cached chat state. It shares the user-scoped `useAnimas` list query to map each
result's `anima_id` to its lightweight display name and profile thumbnail,
instead of resolving one complete runtime catalog per result. The endpoint
paginates distinct chats, not individual message hits. Matching snippet terms are highlighted as escaped React text nodes; `chatSearchHighlightTerms`
(`web/src/lib/chat/chat-search-terms.ts`) follows the backend's word rules, so a
non-ASCII word such as `京都` is highlighted whole.

## Anima presentation and typed catalogs

`useAnimas` returns `PyAnimaListItem` rows. Management navigation and chat
search render the required bounded `presentation` projection and load private
thumbnails with `useAnimaPresentationImage`. That hook fetches protected local
bytes through the application origin, owns the Blob URL, and revokes it on change or
unmount. These surfaces never fetch a full runtime snapshot or load a VRM merely to
show a thumbnail.

Content family hooks call the typed product routes and adapt their results for creator views. They preserve
source, search, sort, and family-specific presentation while retaining the
catalog item ID used by Preview, Edit, and typed loadout commands. Included
entries are read-only; Local entries are ordinary editable files. Runtime
projection remains handler-owned on the backend, so frontend code does not
derive playable semantics from an arbitrary metadata dictionary.

## User Files

Installation-owned uploaded files use the generated `/v1/files` client methods plus
thin TanStack wrappers:

- `useUserFiles`: list current-user files and optionally poll while upload or
  processing state is active.
- `useInitUserFileUpload`: request a backend-generated file ID and private
  API-relative `PUT` target.
- `useFinalizeUserFileUpload`: mark atomically promoted local bytes durable
  after backend verification.
- `useProcessUserFile`: enqueue or reuse a processing job.
- `useDeleteUserFile`: delete/tombstone a file and remove its chunks from debug
  search.
- `useDebugSearchMemoryFiles`: run the AI memory-tool debug path over
  user-scope markdown memory.
- `useDebugUserFileSearch`: run keyword, semantic, or hybrid chunk search.

`useUserFileUpload` combines these mutations with Uppy. The browser PUTs the
original bytes through the application origin to FastAPI, which bounds and atomically
promotes them beneath `data/user-files`; server state is refreshed by
invalidating `queryKeys.userFiles`. Chat uploads send known backend `file_id`
values through `useChatSse` as `attached_file_ids`; the backend validates them
and exposes `search_uploaded_files` only for attached searchable uploads.

## Library source composition

The `/library` route presents family-specific views over the one catalog.
Gesture, Reaction, Pose, typed effect/sound, and Avatar
hooks use their typed product responses while sharing stable catalog
identities.

The Actions section contains All, Gestures, Reactions and Poses. Pose queries list
metadata; loading or inserting a pose resolves its exact registered preview bytes.
Local poses open in the standalone editor, while Included Customize starts a Local
copy. Creation remains inside the Gesture editor, with no Library new-pose button
or Create-page entry. Pose editing retains loaded identity/revision and transient
drafts; the old browser-saved collection is neither read nor migrated.

`ActionManageDialog` reads every Anima's current catalog loadout. A Gesture is
planned and committed per Anima with its own idempotency key. A Reaction row
adds the item to, or removes it from, the chosen cell's pool through that
Anima's `changeReaction`, so it shares the Loadout's one-step commit, warnings
and invalidation. Successful targets remain committed if another target fails.

Chat Uploads remain separate through `useUserFiles({ pollActive: true })`;
polling runs only while upload or processing work is active. Creator Save calls
the matching typed product API. The backend stages and atomically replaces the
normal readable file or directory under `content/local`, validates it through
the kind handler, reconciles the changed entry, and returns its discriminated
typed response. Temporary upload targets never enter
TanStack Query, Zustand, route state, toasts, or telemetry.

Avatar and appearance previews use their registered catalog files through the
same preview-byte session. Live Appearance and Avatar changes invalidate their
loadout/runtime and revision-bearing Anima/identity views. Name or identity
edits refresh definition views without remounting runtime. Shared helpers
`invalidateAnimaDefinition` and `invalidateAnimaLoadoutAndRuntime` keep these
boundaries owner-scoped.

## Memory Entries

Markdown memory files and directories use generated `/v1/memory/entries`
methods wrapped by `useMemoryEntries`, `useMemoryEntry`,
`useMemoryEntryByPath`, `useCreateMemoryEntry`, `usePatchMemoryEntry`, and
`useDeleteMemoryEntry`. `useMemoryEntryVersions` wraps the newest-first
cursor-paginated history list, while `useMemoryEntryVersion` loads one exact
version's adjacent detail. Query keys are scoped under
`queryKeys.memoryEntries` by user, nullable `anima_id`, parent, path, entry ID,
and immutable version history.

The `/memories` page uses those hooks for user-scope markdown entries and
`useAnimaIdentities` (`queryKeys.memoryEntries.animaIdentities`) for the virtual
Animas folders; Anima definition changes also invalidate that listing and the
Anima's identity detail entries under `queryKeys.memoryEntries.details`. The
same listing supplies each Anima's `MEMORIES.md` header (`useAnimaMemoriesEntry`),
and `useRepairAnimaMemories` resolves only after refetching it. Anima details use
the same hooks for the selected anima's `IDENTITY.md` editor route.
The shared editor keeps draft state local to the modal and saves with the
draft's `expected_version`. Anima identity responses also provide
`aggregate_revision`, captured as `baseAggregateRevision` and sent as
`expected_aggregate_revision` on saves and Revert. A name/equipment change can
therefore conflict even when the memory version is unchanged. The editor
detects `409`, refetches current state, and preserves a dirty draft and its
original guards until the user explicitly chooses latest state or overwrites
against freshly fetched guards. Clean drafts resynchronize automatically.

Generated Anima responses expose `display_name`, `aggregate_revision`, and
`identity_status`. `getAnimaDisplayName` uses live authority and never falls back
to editable Avatar metadata. Typed loadout plans fence the aggregate revision
inside their reviewed digest; existing plan/commit request shapes are retained.

Version-list pages contain content-free summaries and use `before_version` as
their cursor. Version detail is adjacent-only: selecting Version N asks the
backend for the immutable Version N snapshot, the N-1-to-N unified diff, and
structured path/description changes. Version 1 uses an empty Version 0
creation baseline. The query layer has no arbitrary two-version comparison or
history mutation method.

Memory-manager runs use generated `/v1/memory/episodes` and
`/v1/memory/manager` methods. `useMemoryEpisodes` fetches pending episode
counts for `/memories`; `useMemoryManagerRun`,
`useCreateMemoryManagerRun`, `useProcessMemoryEpisodes`,
`useAppendMemoryManagerMessage`, and `useDecideMemoryManagerApproval` wrap the
manager run/message/approval API.
Query keys live under `queryKeys.memoryEpisodes` and
`queryKeys.memoryManager`. Approval decisions update the returned run and
invalidate affected memory-entry state because an approved patch is an
authoritative backend write.

## Streaming

Normal chat SSE is implemented by `useChatSse`. It is a mutation-style runtime
transport for `POST /v1/animas/{anima_id}/chat:sse`, not a normal cached
query. Route and chat code should coordinate stream lifecycle through
`useChatSession`.
