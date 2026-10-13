# Local Profile

The accountless backend profile is private personalization for one installation.
It stores a display name normalized to at most 80 Unicode characters.

The backend exposes `GET /v1/users/me/profile` and
`PATCH /v1/users/me/profile`, plus the local runtime/bootstrap endpoints used by
first run. The generated installation principal owns the row but is not a
secret or public identity.

On first run, `/setup` has three steps: **Welcome** → **AI** → **Voice**.
Welcome asks “What should Animama call you?” and accepts a required nonblank
display name up to 80 characters. Welcome has no Skip action. AI
(model and the OpenAI or Anthropic key) and Voice (speech downloads,
Text-to-Speech and the ElevenLabs key) offer "Skip for now". Finish writes changed
Text-to-Speech preferences and opens a blocking 18+ modal on the first Anima.
The app shell and Avatar load behind the modal and stay mounted when it closes;
chat, microphone and Quick Chat handlers start only after confirmation.
The modal links `/safety`; only explicit confirmation stores the name,
age confirmation and any chosen model. Completion is idempotent and controlled by backend runtime
context rather than browser storage. The bootstrap placeholder may be null
before setup. An earlier skipped or unconfirmed setup reopens without resetting
data.

After setup and on future root launches, `/` opens `/$animaId` for the last
visited owned Anima, or the first in creation order (Annie on a fresh install).
Saved settings and the owned list must load before selecting a fallback. A
deleted selection falls back to the first remaining Anima; an empty list opens
creation. Explicit deep links are preserved.

After setup, App Settings → General edits the display name. Blank names are
rejected; saving updates the sidebar, and closing settings discards unsaved edits.
The sidebar displays “You” while the profile is loading or unavailable.

The installation bootstrap service owns initial profile and `PROFILE.md`
creation. Later profile changes update the bootstrap-managed preferred-name line
in the same guarded backend transaction; a person's direct edit to that line
wins. This private display name is not a hosted identity or public creator
handle.
