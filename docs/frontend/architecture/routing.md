# Routing Guide

The web app uses TanStack Router with file routes in
`src/frontend/web/src/routes`.

Typed creators use stable product routes such as `/particle-effects/new`,
`/avatar-effects/new`, `/scene-effects/new`,
`/gestures/new`, and `/reactions/new`.

## Route Tree

- `__root.tsx`: root route, document head, scroll restoration, scripts, and
  not-found view.
- `setup.tsx`: required private display-name setup with Continue and no Skip. It
  is reachable only while the backend reports first run incomplete.
- `_app.tsx`: pathless app layout (no URL segment) with the app shell; redirects
  to `/setup` until the wizard is finished, then loads the app behind the blocking
  age-confirmation modal. Chat and voice handlers wait for confirmation. App routes live at
  top-level paths such as `/library` and `/$animaId`. Static routes take
  precedence over the `/$animaId` parameter, so new top-level route names must
  never collide with valid Anima IDs.
- `_app/index.tsx`: the entry route at `/`. Waits for saved settings and owned
  Animas, then replaces `/`
  with `/$animaId` for the last visited owned Anima, or the first in creation
  order (Annie on a fresh installation). A stale ID falls back; no owned Animas
  opens `/animas/new` only when creation is permitted, otherwise an empty-roster
  view preserves access to the remaining app. Query failures offer Retry without
  replacing selection.
  Explicit chat and management URLs are unaffected.
- `a.tsx` and `a/$.tsx`: redirect legacy `/a` and `/a/...` URLs to the same
  path without the prefix, preserving search and hash and staying on-origin.
- `_app/create.tsx`: creator hub for Anima, Action, and Effects authoring. Its
  effect cards open the Effects template picker
  (`ui/create/EffectTemplatePickerDialog.tsx`, registry
  `lib/effects/effectTemplates.ts`) in place, as does the sidebar Create menu's
  **Effects** item; closing it leaves the user where they were.
- `_app/effects.new.tsx`: the Create page with the picker open; closing it
  navigates to `/create`. A choice opens the kind's `/new` route, with
  `?template=<id>` for a template.
- Legacy Sound Effect new/edit routes redirect to `/library?section=fx&fx=sound`;
  sounds are uploaded in action/effect pickers and managed in Library.
- `_app/animas.new.tsx`: the four-step `ui/create-anima/CreateAnimaPage` in the
  app shell. It accepts only the optional bounded logical `avatar` ID and
  resolves its admitted revision. Saved owner-scoped drafts take precedence
  over a new hint. Invalid/unavailable sources do not create an Anima or
  redirect away. Cancel exits through `/create`, avoiding the empty-roster
  `/animas` loop. Success prepares one runtime and opens `/$animaId`.
- `_app/memories.tsx`: installation-wide markdown memory workspace. Legacy
  `tab=uploads` URLs redirect to Library's Chat Uploads section.
- `_app/library.tsx`: installation-owned typed product Library with URL-backed All,
  Avatars, Gestures & Reactions, FX, and Chat Uploads sections. Search,
  Starter visibility, sort, family filters, upload status, and the Gesture
  update/status/motion/order filters survive navigation and reload. Chat
  Uploads also owns upload management and retrieval-debug
  tools.
- `_app/gestures.new.tsx` and `_app/gestures.$gestureId.edit.tsx`: Gesture creation
  and stable-item editing with VRMA or Pose Clip motion.
- `_app/reactions.new.tsx` and `_app/reactions.$reactionId.edit.tsx`: Reaction
  creation and stable-item editing with expression/effect/sound timelines.
- `_app/particle-effects.new.tsx` and `_app/particle-effects.$particleEffectId.edit.tsx`:
  [Particle Effect authoring](../runtime/avatar-particle-vfx.md).
- `_app/avatar-effects.new.tsx` and `_app/avatar-effects.$avatarEffectId.edit.tsx`:
  [Avatar Effect authoring](../runtime/avatar-vfx.md).
- `_app/scene-effects.new.tsx` and `_app/scene-effects.$sceneEffectId.edit.tsx`:
  [Scene Effect authoring](../runtime/scene-vfx.md).
  Both `/new` routes accept an optional `?template=<id>` that `validateSearch`
  restricts to the registry's IDs (unknown IDs are dropped); the creator is
  keyed by template, so a different template starts a separate draft.
  Bare `/avatar-effects` and `/scene-effects` URLs redirect to their creators.
- `_app/animas/index.tsx`: compatibility resolver. It replaces `/animas` with
  the first owned Anima's canonical management URL. An empty roster opens
  `/animas/new` only when creation is permitted; otherwise it shows the same
  empty-roster view. The creation route must not redirect an empty roster back
  here, because that would create a loop.
- `_app/animas/$animaId.tsx`: Anima details and management with URL-backed
  Identity, Emotions, Loadout, and Settings tabs. The Loadout view records
  `tab=loadout`. A bare management URL resolves to Identity; invalid tab values
  do the same. Tab changes and Anima carousel navigation create history entries
  while retaining the selected tab.
- `_app/animas/$animaId/identity.tsx`: modal route for editing the anima-scoped
  `IDENTITY.md` memory entry.
- `_app/avatar-portrait-debug.tsx`: development-only local VRM portrait-capture
  harness; its route guard returns not found outside Vite development mode.
- `_app/$animaId.tsx`: live anima runtime shell.
  Valid owned visits asynchronously update the user's last-active-Anima
  preference for cross-route authoring defaults without delaying the shell.
- `_app/$animaId/c/$chatId.tsx`: chat-id child route; intentionally renders
  nothing because the parent owns the runtime effects.

## Router Context

The explicit local and hosted entrypoints supply a `RuntimeController` to
`AppProviders`. `RuntimeAdmissionProvider` exposes admission and the current
session-owned TanStack Query client to `src/frontend/web/src/app/router.tsx`.
The same router mounts product routes only for ready admission; other states
show the composition's sign-in, restriction or recovery view. Session replacement
disposes private resources and caches before readmission. Shared routes consume
the neutral owner and injected client, never the local startup adapter.

The local composition retains first-run setup. Capability guards explain
unavailable direct links; native utility routes still require the desktop
platform. See the [composition contract](../../../contracts/hosted-web.md) for
consumer-owned admission and the eight hosted exceptions.

App Settings opens a route-independent modal without changing the active Anima,
chat or URL.

## Route Patterns

- Use TanStack Router `Link`, `useNavigate`, `Route.useParams`, and
  `Route.useSearch`.
- Keep URL params in route files and pass plain ids/callbacks to feature
  components.
- Use sparse, section-specific Library search state. Omit default values and
  remove filters owned by hidden sections, so the default route is
  `/library` and Scene FX is `/library?section=fx&fx=scene`. Use normal
  history entries for sections, discrete filters, and Upload status changes.
  Replace the current entry for either debounced text-query change so typing
  does not fill browser history. Drop a Library search update once the router
  has started leaving `/library`; a query committed after the owner followed a
  row's Edit link would otherwise replace that navigation.
- Keep subtype disclosure and locally revealed Starter page counts out of the
  URL. Changing Library category, query, or Starter inclusion remounts the
  inventory scope and opens its first non-empty subtype.
- Preserve Library search state on hard reload. Legacy `/creator` URLs
  resolve to the `/create` hub.
- Use route `beforeLoad` for navigation decisions that must happen before a
  route renders.
- Normalize optional search values in the route's search helper and pass plain
  values and callbacks into feature components.
- Keep creator route identity stable and content-free. Gesture, Reaction,
  Particle Effect, Avatar Effect and Scene Effect edit routes
  carry only the logical typed content ID. Exact revisions, JSON,
  uploaded bytes, Blob URLs, and recovery state remain outside browser history.
  Dirty documents and active uploads block route and browser exit until the
  user stays or explicitly discards or pauses. Preview camera, Avatar
  visibility, shape outline, selected Avatar, and selected emitter remain
  route-independent preview state.
- Gesture and Reaction creators claim exclusive preview ownership before
  mounting their route Canvas. They preserve one typed draft identity and one
  `ActionDocument`; exact dependency IDs and local timeline preview state do not
  enter route search state. The public JSON interchange is `animaPoseClip/2.0`
  (the retired 1.0 format is rejected); an optional versioned typed-project
  envelope retains exact
  dependency pins without placing draft IDs or save state in the URL.
- Effect handoffs use only `component=<stable item id>` and
  `componentType=particle_effect|avatar_effect|scene_effect|sound_effect`.
  The destination resolves the item's current exact source through its typed
  endpoint; definitions, files, Blob URLs, and signed capabilities never enter
  route history.
- Do not introduce compatibility wrappers for older router concepts.

## Runtime Route Ownership

`/:animaId` owns `AnimaRouteProviders`, `MainShell`, and
`ChatInterface`. The `/c/:chatId` child route exists only to put the active
chat in the URL. This prevents the chat, avatar, SSE, TTS, and canvas runtime
from remounting when a new chat route is created.
