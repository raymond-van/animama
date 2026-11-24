# Embedded desktop backend operations

This is the desktop composition (macOS arm64 and Windows x64) of the same
accountless backend used by the local Compose stack. Electron supervises private PostgreSQL 16, the frozen
FastAPI application and upload cleanup. FastAPI processes uploaded files itself
and serves the production React files on the saved loopback origin;
there is no Vite server or external Python/Node installation in the installed app.
Signed release acceptance remains pending. Windows has an unsigned development
package and installer and builds signed local candidates; Windows updates and
publication are not implemented.

For end-user instructions use [Installation](../../frontend/desktop/installation.md)
and [Troubleshooting](../../frontend/desktop/troubleshooting.md). For
native builds use [Runtime staging](../../frontend/desktop/runtime-staging.md).

## Identity and service boundary

The `baseline_20260908` accountless baseline generates one durable
`installation_settings.installation_principal_id`. Bootstrap requires it;
the supervisor never fabricates a replacement when owner data already exists.
Existing `user_id`/`owner_user_id` columns retain that owner value. Backend
bootstrap idempotently ensures settings, profile and starters without overwriting
edits or deleted starter receipts. No local password or hosted identity is involved.

FastAPI accepts renderer HTTP, SSE, WebSocket and registered-byte traffic. Its
local boundary checks exact authority, browser metadata and the per-launch
HttpOnly renderer capability. Server-owned admission state resolves the
bootstrap-established installation owner; caller identity headers confer no
authority. PostgreSQL remains private. `/_desktop` readiness, drain, removal
and credential routes require a separate control credential, reject renderer
cookies alone and refuse browser-context requests.

The supervisor compares readiness against the exact app build, Alembic head,
principal, HTTP schema, exact PID/start token and Included reconciliation. It retains child handles and stops only
its own processes. An occupied port or PID record does not establish ownership.
Provider and model-connection key changes apply without a restart. Main writes
the vault, then sends the whole saved set to the running FastAPI with
`PUT /_desktop/credentials` (see
[local HTTP components](local-http-components.md)). A failed delivery is retried once. A second failure
falls back to the restart path below from the vault, even when the drain
reports busy, so FastAPI never keeps a key the vault no longer has. A batch
that would store more than 32 connection keys, or a failed vault write, is
refused before anything is sent.

Pack activation restarts consumers while preserving PostgreSQL, the owner and
the saved application origin. Restarts destroy product windows, show
independent recovery, quiesce active work, and recreate the renderer only
after the restarted child passes readiness.

## Roots, secrets and private bytes

All paths below are relative to `~/Library/Application Support/Animama`:

| Path                     | Responsibility                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `postgres/16/data`       | Private PostgreSQL cluster; database commands verify `SHOW data_directory`.                    |
| `secrets/vault.bin`      | OS-encrypted database password, provider keys and model-connection keys; requires matching secure storage. |
| `runtime/state.json`     | Stable application port, stored as `{version:1,gatewayPort}`; `gatewayPort` is the application port.          |
| `runtime/processes.json` | Owned-process evidence, never authority to kill a discovered process.                          |
| `runtime/logs`           | Redacted main and child diagnostics in `main.log`, rotated at 10 MiB with three older files; review before sharing. |
| `content/local`          | Writable typed library.                                                                        |
| `data`                   | Private uploads, downloaded model assets (`internal/model-assets`), staging and other non-portable application data. |
| `packs`, `downloads`     | Verified optional pack versions and bounded resumable pack downloads.                          |
| `ui-locale.json`         | Last UI Locale the app applied, so the startup page and menu follow it before the backend runs. |
| `pip-placement.json`     | Where the PiP window was last left on this machine's displays, and its size scale.             |
| `backups/pre-migration`  | Verified database snapshots and migration journals, not full backups.                          |

Core Included content is mounted read-only from the application's runtime
resources. Optional expanded Included content comes from an immutable verified
pack. Every catalog item/byte retains its exact source-mount identity. Roots
must be disjoint absolute paths without symlink ancestors. Only Local is watched;
the backend never creates or write-probes an Included root. React receives
registered byte descriptors, not arbitrary host paths or object-store URLs.

Main encrypts the vault with Electron's asynchronous `safeStorage` calls. They
use the same Keychain item or DPAPI key as the synchronous calls that Electron
44 and earlier builds used, and both write the same `v10` format, so those
vaults open unchanged. When decryption reports that a key was rotated, main rewrites the
vault with the current key. A Keychain that is locked or refused reports
`secure_storage_unavailable` and leaves the vault untouched; Electron keeps
that answer until the app restarts.

The control token and renderer capability are generated in main memory for
each app launch; they are not persisted in the vault. The principal persists in
PostgreSQL. Loss of per-launch credentials is
handled by a normal relaunch; a missing/unreadable vault alongside PGDATA fails
closed because its database password cannot be silently regenerated.

Besides the OpenAI, Anthropic, ElevenLabs and Gemini keys, the vault holds a `connections` map of
model-connection keys under their managed names, `ANIMAMA_CONNECTION_<ID>_API_KEY`
derived from the connection id. Each model-connection key keeps the origin of
the address it was entered for (the web-search key has none), and main delivers
it beside the key as `ANIMAMA_CONNECTION_<ID>_ORIGIN`; the backend sends the
key only to that origin, so a connection moved to another address needs its key
entered again. The origin is not a secret and is not added to log redaction.
The vault stores at most 32 connection keys in a file
of at most 512 KiB, and one batch changes at most eight keys, one per provider
or connection. A vault beyond those bounds is `vault_unreadable`. Provider
entries for `deepseek`, `huggingface` and `gemini` that earlier builds wrote
under `providers` are retired: they are dropped on load and at the next save.
Enter DeepSeek and Hugging Face keys on a model connection, and a Gemini key
again for Gemini voices.

The current Gemini key (`GEMINI_API_KEY`, read only by Gemini voices) is stored
in a separate `restoredProviders` section, so a retired `providers.gemini`
entry is never revived, even in a vault that was never re-saved. Earlier
releases ignore that section and keep it when they save. `restoredProviders`
may name only the providers in `restoredProviderNames` (`vault.ts`), currently
`gemini`; any other name makes the vault `vault_unreadable`. A release that
restores another retired provider adds it there, and downgrading its vault to a
release that reads `restoredProviders` but lacks that name fails the same way.

## Supervisor environment and frozen CLI

These are private composition inputs, not end-user configuration switches:

| Input                                                                                                             | Contract                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ANIMAMA_DATABASE_URL`, `ANIMAMA_DESKTOP_PGDATA`                                                                  | Supervisor-owned loopback connection and expected cluster path. Never pass the password in argv or logs. |
| `ANIMAMA_PUBLIC_ORIGIN`, `ANIMAMA_WEB_ROOT` | Exact saved loopback origin and packaged React build root. |
| `ANIMAMA_DESKTOP_RENDERER_CAPABILITY` | Per-launch renderer admission cookie; never a private-control credential. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `GEMINI_API_KEY`, `ANIMAMA_CONNECTION_<ID>_API_KEY` | Saved vault keys at spawn for FastAPI, which moves them into its runtime store and removes them from its environment; withheld from the cleanup worker, `database` commands and upload parse children; redacted from logs. |
| `ANIMAMA_PROCESS_START_TOKEN` | Fresh owned-child UUID returned with its PID in private readiness. |
| `ANIMAMA_PARAKEET_SOURCE` | `asset-store`: FastAPI installs and serves the speech-to-text sets (Parakeet and SenseVoice) from its own model-asset store, without a restart. |
| `ANIMAMA_DESKTOP_CONTROL_TOKEN`, `ANIMAMA_DESKTOP_BUILD_ID`                                                       | Separate private readiness credential and expected build.                                                |
| `ANIMAMA_INCLUDED_CONTENT_SOURCES_JSON`                                                                           | Ordered bounded `{id, version, root, pack_id}` sources, core first; `pack_id` is `expanded-included-content` or a private pack (`mixamo-motion`, `wow-comedy-sfx`). |
| `ANIMAMA_LOCAL_CONTENT_ROOT`, `ANIMAMA_DATA_ROOT`                                                                 | Writable Local and private-data roots.                                                                   |
| `ANIMAMA_DISABLE_WEBUI_TELEMETRY`, `OTEL_SDK_DISABLED`, `OPENAI_AGENTS_DISABLE_TRACING` | Always set: no telemetry export, and no Agents SDK traces from any Memory Manager run, whatever its connection. |

Desktop does not set `ANIMAMA_LOCAL_MODEL_HOST`, so the Ollama, LM Studio,
llama.cpp and vLLM connection presets use `127.0.0.1`. See
[Local model servers](local-models.md).

The packaged `animama-runtime` command parser is in `animama/runtime/cli.py`:

| Command                                | Use                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--version`, `audit-resources`         | Inspect frozen version/resources. The orchestrated audit disables runtime log files.                                   |
| `database provision`                   | Create only the fixed desktop database after owned `initdb`.                                                           |
| `database inspect`                     | Read versions, schema and principal from the verified owned cluster.                                                   |
| `database bootstrap`                   | Hold the bootstrap lock across packaged migrations (which own extensions) and idempotent seeds.                         |
| `serve --host 127.0.0.1 --port <port>` | Start the application at its saved origin; non-loopback or mismatched owned inputs are rejected.                        |
| `content rescan`                       | Reconcile registered roots for the required installation owner.                                                        |
| `content audit`                        | Resolve the actual starter closure at `ANIMAMA_DESKTOP_INCLUDED_ROOT`.                                                 |
| `worker avatar-cleanup`                | Owned upload cleanup process.                                                                                          |
| `parse-upload`                         | Started by FastAPI for each uploaded file: reads it from standard input within the parse limits and answers on standard output. Not for manual use. |

These operations are not a recipe for connecting a second process to live
desktop data. Use the supervisor and documented stage/audit commands. Keep
resource inspection and mutation separate, and preserve ownership/manifest checks
for any support action. Build details are in the [packaging README](../../../src/backend/packaging/desktop/README.md).

## Upload processing and content transitions

FastAPI processes uploaded files itself. It reads each one in a `parse-upload`
child of the frozen runtime, under the parse time and memory limits and without
network access or credentials, then chunks and embeds it. The supervisor does
not set `ANIMAMA_USER_FILE_PROCESSING_ENABLED`, so processing is always on, and
`GET /v1/runtime-capabilities` reports the processor's liveness as
`worker_state`. Parsing and token counting work offline (`cl100k_base` comes
from the encoding file bundled with llama-index); embedding uses the Embeddings
role's model connection, and files are searched by keyword while that role is
off. See [User files](../features/user-files.md#in-server-processing).

Pack removal checks Anima/content references, runtime and preview leases and
content operations before and after quiescing. An atomic pointer switch is followed by
reconciliation/readiness; failure rolls back the previous mount. Packs carry
data only; no pack contains executable code.

## Migration snapshots and recovery

The `baseline_20260908` revision creates the schema released in desktop 0.1.2,
and later revisions upgrade a profile in place during database bootstrap, after a
pre-migration snapshot. Databases stamped with unsupported revision IDs have no forward upgrade through
this graph. Preserve an old profile and its matching app/checkout if its data
matters; use a separate disposable fresh profile for
current native validation. Do not relabel an old database with `alembic stamp`,
automatically purge it, or treat its snapshot as restore-compatible with the new
history. See [Database operations](development.md#database) for the reset and
Local/private-file boundary.

Because a schema can differ at the same Alembic head (for example a profile
from the 0.1.3 preview, built while the baseline was still edited in place),
the runtime manifest also records `database_schema_sha256`. Staging bootstraps a disposable profile
database with the bundled PostgreSQL and frozen backend, then hashes its
`pg_dump --schema-only --no-owner --no-privileges --no-comments` output with
version headers and per-run `\restrict` keys removed. The supervisor hashes
the profile the same way and stops with `database_schema_mismatch` before
launching any service if the digests differ. It checks a profile already at the
packaged head before bootstrap, so seeds never run against a stale schema, and
checks a fresh or upgraded profile after bootstrap.
Every revision must therefore leave an upgraded profile with exactly the
schema of a fresh database, including column order. If content reconciliation fails at backend startup, `/_desktop/health`
returns a terminal `content_startup_failed` and the supervisor reports it
immediately instead of waiting for the readiness deadline.

Before upgrading an existing schema, the supervisor runs bundled `pg_dump` in
custom format, verifies the archive with `pg_restore --list`, fsyncs and publishes
it atomically. A retry reuses the original dump. After two distinct successful
app launches on the new head, older known-successful snapshots can be pruned;
the newest, failed/interrupted and unknown entries remain. Consumer restarts
and Retry do not count as launches. The native stage audit separately restores
a dump into a disposable database and verifies owner, schema and rows; that is
not a signed application-upgrade or full-profile recovery test.

Snapshots omit Local files, uploads, vault and keychain. Quit before a coordinated
backup of the complete data tree, preserving the matching app/version and OS
encryption context. Cross-machine vault recovery and a full desktop restore UI
are not established. Never delete PGDATA, replace the principal, merge conflicting
legacy profiles, or auto-restore/downgrade after migration failure. Preserve the
current state and use the [recovery guide](../../frontend/desktop/troubleshooting.md).

## Compose and intentional remote self-hosting

Without desktop source overrides, Compose retains `ANIMAMA_CONTENT_ROOT`
(`included`/`local`) and the separate `ANIMAMA_DATA_ROOT`; host bind mounts use
`ANIMAMA_INCLUDED_CONTENT_HOST_PATH`, `ANIMAMA_LOCAL_CONTENT_HOST_PATH` and
`ANIMAMA_DATA_HOST_PATH`. Compose does not generate or read a gateway token.
The existing Compose backup,
restore and reset scripts apply to their selected Compose project, not desktop
PGDATA or the encrypted vault. See [Development](development.md#self-hosted-local-roots).

Built self-host publishes only FastAPI on loopback; development publishes Vite
and keeps FastAPI private. Intentional remote access requires an operator-owned
TLS and authentication boundary such as an authenticated tunnel or reverse
proxy. Every admitted request is still the same installation owner. Do not bind
the native app to the LAN, expose the app directly to the Internet, add local
multi-user accounts or treat desktop as the future hosted Cloud composition.
Configure the exact public Host and Origin without bypassing those checks.
