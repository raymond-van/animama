# Release Avatar canvas memory promptly

Status: Agreed; R5 deferred
Snapshot: [issue #472](https://github.com/raymond-van/animama/issues/472), published at 2026-10-12T21:36:42Z and updated at 2026-10-12T23:25:36Z for the R5 deferral. The issue is authoritative.
Owner decision: 2026-10-12, the owner asked to expand issue #472 to fix the memory
leaks and churn found while investigating Library previews, and then to include
investigating and fixing PiP and desktop window memory. On 2026-10-12 the owner
approved this spec and the ExecPlan as written, including R5.

## Problem and intended users

The owner noticed a browser tab grow by about 1.4 GB while previewing Library
content in a built local stack. Investigation measured every surface that mounts a
WebGL canvas and an Avatar (VRM). People using Animama for long sessions, and
creators switching preview models or Animas, pay for these leaks and churn in
memory, responsiveness and, on the desktop app, system pressure.

Measurements were taken in an isolated Chrome against a built stack, recording the
renderer and GPU process footprint, the JS heap, ArrayBuffer storage, live
WebGL contexts, canvases and ImageBitmaps. A forced garbage collection (GC)
separated true leaks from collectable churn.

| ID | Surface | Finding |
| --- | --- | --- |
| F1 | Library Preview Dock | Every preview, and every minimize, remounted the scene: a new WebGL context and Avatar, and a re-fetch and re-parse of the 18 MB model. Over 15 previews the renderer peaked at 1145 MB; after GC it settled at 435 MB. Churn. |
| F2 | Avatar Effect creator, switching the preview model | Each switch kept about 60 MB in the renderer and 60 MB on the GPU after GC. After 20 switches: renderer 520 → 1705 MB, GPU 885 → 2129 MB. Leaving the route freed it. True leak. |
| F3 | App router | A second, never-mounted router tracked every scrolled element. About 0.5 MB and 100 DOM nodes stayed alive per Anima selection on `/animas/<id>`, including detached canvases. True leak, unbounded. |
| F4 | Chat, toggling Chat only ↔ Avatar + Chat | The previous two models' textures (about 177 MB) stayed reachable after GC. Retention is bounded. |
| F5 | Every Avatar load | Decoded model textures (88–119 MB per model) are released only by GC. This is the largest single source of churn behind F1, F6 and creator navigation. |
| F6 | Chat, switching Anima | Each switch rebuilds the whole scene: a new WebGL context, Avatar and model. Peak +90–150 MB, collectable. Churn. |
| F7 | Desktop windows and PiP | Not yet measured. Native PiP is a separate Electron window that renders its own scene from the main window's visual-state snapshots. Browser Document PiP is the web fallback. Quick Chat is a second auxiliary window. |

Causes:
- **F2:** the Avatar is disposed while its model is still attached to the scene, so the next frame re-uploads the disposed textures, buffers and programs to the GPU. Nothing releases them again.
- **F3:** a router is built for the loading-phase QueryClient and never mounted. TanStack scroll restoration listeners are never removed.
- **F4:** a disposed Avatar keeps externally supplied callbacks, which reach the unmounted actor's last state.
- **F6:** chat keys its whole shell by Anima id.

Surfaces measured as healthy:
- switching chats of one Anima;
- `/animas/<id>` tabs and loadout previews;
- particle and scene effect previews;
- repeated route round trips once warmed up.

## Goals, scope and non-goals

Goals:

- Remove the true leaks (F2, F3) and the bounded retention (F4).
- Reduce collectable churn where Animama itself causes it: F1, F5 and F6.
- Keep every surface's visible behavior unchanged, except that it no longer reloads needlessly.

Non-goals:

- Sharing one canvas across routes. Each surface owns its canvas by design; see
  [Typed content previews](../../frontend/runtime/content-previews.md).
- The model reload when the `/animas/<id>` stage changes avatar. After R3 it becomes collectable churn of the same kind as the creators.
- Voice, TTS and lip-sync audio paths. These were not measured, except where a PiP or desktop window owns them.
- The remaining reduced-motion autoplay after a model change in the Library Dock. It existed before this work.

## Required behavior

- **R1 Library Dock reuse.** The Library Preview Dock keeps one canvas and its loaded Avatar when targets replace each other and while it is minimized or closed. It still frees them on Destroy, warm-idle eviction, or a management or creator claim. Targets that share a model revision do not fetch or parse it again. A different model mounts a fresh Avatar in the same canvas. A failed model load is retried by the next preparation or Retry.
- **R2 Detach before dispose.** Disposing or unloading an Avatar removes its model from any scene before releasing its GPU resources. No later frame can draw, and so re-upload, disposed resources. Switching a creator's preview model leaves no growth after GC that scales with the number of switches.
- **R3 Release decoded textures.** Unloading an Avatar promptly releases the decoded image data of the model textures it owns. An unload or dispose drops every externally supplied callback and event sink, so an old closure cannot keep a previous model alive.
- **R4 One live scroll tracker.** At most one router tracks scroll positions at a time, and it belongs to the current admitted session. A retired or never-mounted router tracks no elements. Readmitting a new session still builds a fresh router and QueryClient for that session.
- **R5 Chat keeps its renderer across Animas (deferred; see Open questions and decisions).** Switching Anima in chat keeps the WebGL renderer and loads the new Anima's model into it. All state scoped to the previous Anima still resets: chat, safety notice and crisis card, avatar transform, scene, emotion and playback. The new Anima appears exactly as a fresh visit would show it.
- **R6 Desktop and PiP windows release memory.** Repeatedly opening and closing native PiP, browser Document PiP and Quick Chat, and switching Anima while PiP is open, leaves no growth after GC that scales with repetitions in any affected process. That covers the main renderer, the auxiliary window renderers, the GPU process and the Electron main process. A closed auxiliary window releases its renderer, canvas, Avatar, IPC listeners and snapshot subscriptions. While PiP is open, the main window's suspended scene does not keep work or allocations running that exist only for its own rendering.

## Constraints

- No change to persisted data, APIs, generated clients or content formats.
- No new dependencies. The fixes use installed three.js r182, three-vrm and TanStack Router behavior. Any reliance on a TanStack Router field outside its typed public surface is isolated in one helper and covered by a test.
- Hosted (Cloud) session isolation is preserved: each admitted session keeps its own QueryClient and router state.
- Retain [creator resource lifetime](../creator-resource-lifetimes/creator-resource-lifetimes-execplan.md) guarantees: owned and borrowed Blob URLs, and TransformControls cleanup.

## Acceptance criteria

All browser measurements use a built task stack, an isolated Chrome and forced GC, and are reported as before/after with this draft's method.

- [ ] **R1:**
  - Built-stack evidence: 15 consecutive Library previews create one WebGL context and fetch the model once, and ArrayBuffer storage stays flat.
  - Minimize and restore fetch nothing.
  - Automated tests cover reuse, failure and retry.
- [ ] **R2:**
  - Built-stack evidence: after 20 Avatar Effect creator preview-model switches, renderer and GPU footprint after GC stay within 10% of the value after the first switch.
  - A unit test shows the model is detached before disposal.
- [ ] **R3:**
  - Unit tests show unload closes owned ImageBitmaps and drops external sinks.
  - Built-stack evidence:
    - After 10 chat Chat-only ↔ Avatar + Chat toggles, live ImageBitmaps after GC equal one model's set.
    - Peak renderer growth per avatar load is lower than the recorded baseline.
- [ ] **R4:**
  - A unit test shows that no router is built before admission is ready and that a retired router stops tracking.
  - Built-stack evidence: after 20 Anima selections on `/animas/<id>`, detached canvases and DOM nodes after GC return to their baseline. `pagehide` has one router listener.
- [ ] **R5:**
  - Built-stack evidence: 20 chat Anima switches create one WebGL context, and the renderer after GC stays within 10% of the first switch.
  - Tests show safety state resets per Anima.
  - Browser checks show the new Anima's model, transform and background, and a fresh chat.
- [ ] **R6:**
  - A recorded measurement of each desktop and PiP scenario before and after the fixes, with any growth explained.
  - Automated tests cover every repaired lifetime.
  - Packaged-app and Windows behavior are owner checks, recorded as gates, unless they are measured.
- [ ] The fast browser journeys pass on the final candidate. `pnpm desktop:check`, unit, type, lint and format checks pass.

## Open questions and decisions

- **R5 deferred (owner, 2026-10-12).** The owner first included R5. Phase 2 measurements then showed its remaining benefit is small. Switching Anima must load the other Anima's model either way, and the old renderer and model are already released promptly: the GPU stays flat and memory returns to baseline after GC. What remains is one WebGL context and scene rebuild per switch. Against that saving, the change would need an explicit reset for every piece of per-Anima state the remount now handles. On review the owner chose to defer R5. It stays a follow-up in #478.
- **R6 behavior changes.** Any R6 fix that would change visible behavior, rather than only release memory, goes back to the owner. An example is unloading the main window's Avatar while PiP is open.
- **R4 implementation choice (agent, 2026-10-12):** keep one router per admitted session for hosted isolation, rather than one router for the page lifetime.

## Spec

[Issue #472](https://github.com/raymond-van/animama/issues/472) is authoritative; this file is a snapshot.

## ExecPlan

[avatar-canvas-memory-execplan.md](avatar-canvas-memory-execplan.md)

## Delivery links

- Issue: [#472](https://github.com/raymond-van/animama/issues/472)
- PR: [#474](https://github.com/raymond-van/animama/pull/474)
