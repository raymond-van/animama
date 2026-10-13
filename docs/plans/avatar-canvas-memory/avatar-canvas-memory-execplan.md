# Release Avatar canvas memory promptly

Source agreement: [avatar-canvas-memory-spec.md](avatar-canvas-memory-spec.md),
agreed on 2026-10-12 and published to issue
[#472](https://github.com/raymond-van/animama/issues/472) at 2026-10-12T21:36:42Z.
The issue is authoritative; the spec file is its snapshot.

Authorized scope:
- Phase 1 is delivered.
- Phases 2–5 were approved by the owner on 2026-10-12, Phase 5 included. Phases 2–4 are delivered.
- The owner deferred Phase 5 later the same day; see the Decision Log.
- The owner gave a conditional approval to merge PR #474 once review and checks pass; see the Decision Log.

## Purpose and context

Several surfaces that mount a WebGL canvas and an Avatar leak GPU and decoded
texture memory, or rebuild their whole scene when they could reuse it. The spec
lists the measured findings, F1–F7, and the requirements, R1–R6.

The relevant code:
- **Avatar runtime:** `src/frontend/web/src/lib/avatar/Avatar.ts`.
  - `load()` calls `unload()` first.
  - `unload()` deep-disposes `vrm.scene`.
  - `dispose()` calls `unload()` and marks the Avatar disposed.
- **Surfaces that call `avatar.dispose()` while the model can still be attached through `<primitive object={scene}>`:**
  - `ui/content-creator/useContentCreatorAvatar.ts`
  - `ui/main/canvas/AvatarCanvasActor.tsx`
  - `ui/animas/AnimaAvatarStage.tsx`
  - `ui/pose-creator/PoseCreatorAvatarActor.tsx`
  - the create-Anima stages
- **App router:** `src/frontend/web/src/app/router.tsx` builds a router per QueryClient. `app/runtime/runtime-controller.ts` creates one QueryClient while loading and one per admitted session.
  - TanStack router-core 1.168 installs scroll restoration listeners when a router's stores are first created, and never removes them.
  - Its handler ignores scroll events while `router.isScrollRestoring` is false.
- **Chat:** `src/frontend/web/src/routes/_app/$animaId.tsx` keys `CompanionSafetyProvider`, and therefore all of `MainShell`, by `animaId`. `AnimaRouteProviders` already swaps the runtime catalog without remounting.
- **Desktop:**
  - `src/frontend/desktop/src/main-process/pip/pip-window-manager.ts` owns the native PiP window, which renders `/desktop/pip/$animaId`.
  - The main renderer stays the runtime owner and sends visual-state snapshots. See [Desktop PiP](../../frontend/desktop/picture-in-picture.md) and [Quick Chat](../../frontend/desktop/quick-chat.md).
- **Related:** the [creator resource lifetimes plan](../creator-resource-lifetimes/creator-resource-lifetimes-execplan.md) explicitly left React timing and bitmap disposal out of its scope. This plan covers them.

Working directory: the task worktree for branch `fix/preview-dock-scene-reuse`, from
base `95a2db39`. One branch and PR ([#474](https://github.com/raymond-van/animama/pull/474))
serve the whole plan. The branch name predates the expanded scope and is kept.

## Measurement method

Measure each browser acceptance item the same way, before and after:
- **Stack:** a disposable built task stack (`ANIMAMA_WEB_BUILD_MODE=production ./reset.sh --name <n> --base-port <p>`), plus the main stack's build as the baseline.
- **Browser:** an isolated Chrome profile with a loopback DevTools port. Use `--disable-renderer-backgrounding` when windows overlap.
- **Process memory:** renderer and GPU process footprint, read with macOS `footprint -p <pid>`.
- **Page metrics over CDP:**
  - `Runtime.getHeapUsage` (used size and ArrayBuffer backing store);
  - `Performance.getMetrics` (DOM nodes and listeners);
  - WebGL contexts created and canvases still connected;
  - ImageBitmaps created, closed and still live, via an init script that wraps the constructors;
  - Blob URLs created and revoked.
- **GC:** force it with `HeapProfiler.collectGarbage` at baselines and after each scenario.

Desktop measurements also read Electron helper processes. The development desktop
app has to expose a loopback DevTools port; Phase 4 confirms how. Record numbers in
this plan without machine paths.

## Progress

- [x] Phase 1: Library Dock reuse (R1). Delivered in `7172794f`. Review passed after two repair rounds; the evidence is below.
- [x] Phase 2: Avatar disposal releases GPU and decoded resources (R2, R3). `afacb9fe`; review passed.
- [x] Phase 3: One live scroll tracker per admitted session (R4). `fa3caa9f`; review passed after one repair round.
- [x] Phase 4: Desktop and PiP window memory (R6). `acea31d5`. F7.1 was fixed by Phase 2; the F7.2 PiP owner-listener leak is fixed here. Review passed after two repair rounds. Packaged, Windows, long-session and Quick Chat design checks remain owner gates.
- [ ] Phase 5: Chat keeps its renderer across Animas (R5). Deferred by the owner on 2026-10-12; #478 stays open as the follow-up.
- [ ] Final integration review, fast browser journeys and PR update.

## Surprises & Discoveries

- 2026-10-12: The Dock's scene gate compared prepared and current target keys. A minimized Dock derives its target without the Anima suffix, so minimizing also unmounted the scene.
- 2026-10-12: A second load on the same Avatar while the first is in flight can orphan a model. `Avatar.load()` has no cancellation. So Phase 1 keys the preview actor by model revision instead of reloading in place.
- 2026-10-12: The parsed model and textures are per load. No three.js global cache is enabled, and `GLTFLoader` keeps no cross-load cache. Releasing a model's ImageBitmaps on unload therefore cannot affect another Avatar.
- 2026-10-12: The router is deliberately rebuilt per admitted session: `publish()` creates a new QueryClient for each new session. Building one router for the whole page would weaken hosted session isolation.

## Decision Log

- 2026-10-12, owner: expand #472 from the Library Dock fix to the measured canvas leaks and churn, then add PiP and desktop windows.
- 2026-10-12, owner: approve the spec and this plan as written, and include Phase 5 (R5).
- 2026-10-12, owner: approve merging PR #474 "if review/checks pass". The approval came before the final review found that R3's per-load peak had not been compared against a baseline. The PR discloses that gap at merge.
- 2026-10-12, owner: defer Phase 5 after the Phase 2 measurements. The per-switch model load is inherent, and the old renderer and model are now released promptly. Keeping the renderer would mainly save one WebGL context and scene rebuild per switch, but it would need an explicit reset for the canvas mode, fullscreen, both PiP kinds, transforms, camera and safety state.
- 2026-10-12, agent: treat this as substantial and risky work, because it touches the shared Avatar runtime, router lifetime and chat remount semantics. Hence this ExecPlan.
- 2026-10-12, agent: fix R2 centrally in `Avatar.unload()` by detaching before disposing, rather than reordering every caller's cleanup.
- 2026-10-12, agent: for R4, build routers only for ready admissions, and stop scroll tracking on a retired router, instead of keeping one router for the whole page.
- 2026-10-12, agent: order the phases 2 → 3 → 4 → 5. R5 depends on R2, because reusing the chat renderer without detach-before-dispose would recreate F2 in the main scene. R6 measurements are more meaningful after R2 and R3.

## Phased implementation

### Phase 1: Library Preview Dock reuses its scene (R1) — delivered

Issue: #472. Starting revision: `95a2db39`. Commit: `7172794f`.

Changes:
- `ContentPreviewHost` renders the last prepared scene. Its controls stay gated on the current target.
- `PreviewActor` is keyed by model revision. It loads once per Avatar and retries only a failed load.
- A per-preparation request reports a reused Avatar ready.
- The camera resets on each replacement.
- The current behavior is documented in `docs/frontend/runtime/content-previews.md`.

Results:
- Local checks:
  - `pnpm check` and `pnpm web:lint` pass.
  - `pnpm web:test` passes in isolation: Vitest 471 files and 4198 tests, browser scripts 114/114.
  - An earlier run failed one effect-render browser test because it overlapped a stack build that was rebuilding `@animama/product-ui`.
  - The new host and scene tests fail on the baseline.
- `pnpm e2e:test:fast` passes, 38/38.
- Built stack, 15 Gesture previews:
  - WebGL contexts created: 15 → 1.
  - Model fetches: 15 → 1.
  - ArrayBuffer storage: up to 300 MB → flat 53–58 MB.
  - Renderer peak: 1145 → 673 MB.
- Minimize and restore fetch nothing. Model switches fetch only on change, on one canvas.

#### Code Review #1 Findings

Independent `sdlc-reviewer` review of the working tree against `95a2db39`.
- CR1-F1, blocking: a failed load was never retried, because the actor froze its entry.
- CR1-F2: Avatar targets did not get the ready signal.
- CR1-F3: reduced-motion autoplay after a model change. This existed before.
- CR1-F4: test gaps; the mock skipped the success path.
- CR1-F5: the doc omitted Destroy.
- CR1-F6: the stale scene keeps rendering under the error overlay.

#### Code Review #1 Revisions

- **Accepted and fixed:**
  - F1 and F2: a per-preparation request, a load-state ref and a load-attempt counter, with a retry test.
  - F4: the mock now reaches the success path, and a failure test was added.
  - F5: Destroy is documented.
- **Deferred:** F3. It existed before and is now narrower; at mount, autoplay cannot be told apart from an already-handled request.
- **Rejected:** F6. It is transient and plays nothing.

Code Review #2 passed. CR2-N1 (missing `IS_REACT_ACT_ENVIRONMENT`) was accepted. CR2-N2 (a duplicate error for an entry without a runtime file) and CR2-N3 (no host-to-scene ordering test) were deferred. Code Review #3 passed. Two repair rounds were used.

### Phase 2: Avatar disposal releases GPU and decoded resources (R2, R3)

Issue: [#475](https://github.com/raymond-van/animama/issues/475). Starting revision: the plan commit on this branch.

Steps:
1. **Detach before dispose.** Write a failing `Avatar` unit test: with the model attached to a parent group, `unload()` must leave `vrm.scene.parent === null` before any geometry, material or texture is disposed. Use spies on the disposal path. Then call `this.vrm.scene.removeFromParent()` in `unload()` before `VRMUtils.deepDispose`. Keep `preloadVrm()` consistent.
2. **Close decoded textures.** Before disposing, collect the textures the model's materials reference. After disposal, call `close()` on each texture whose `source.data` is an `ImageBitmap`. Test this with stub bitmaps.
   - Confirm in three r182 that a disposed and detached texture is never uploaded again. Phase 2 must show no "image is closed" or `texImage2D` errors in any surface's console.
3. **Drop external references.** Make `dispose()`, and where they belong to the model, `unload()`, clear externally supplied sinks and callbacks: the pose and reaction clip event sinks, `_poseClipOnFinished`, and any others found while auditing. Test that a disposed Avatar no longer reaches a supplied sink.
4. **Review callers.** Audit every `avatar.dispose()` caller listed above. Keep their `setSceneObject(null)`. Add no per-caller ordering logic unless a caller attaches the model in a way that `removeFromParent()` cannot reach.
5. **Optional extra copy.** Remove the 17 MB `bytes.slice()` copy in `VerifiedByteLoader` before creating the Blob, if it type-checks without casts that hide a real shared-buffer case. Otherwise record why it stays.
6. **Checks:** focused Avatar and creator tests, `pnpm check`, `pnpm web:lint`, and `pnpm web:test` run in isolation.
7. **Built stack:**
   - Avatar Effect creator: 20 preview-model switches, comparing renderer and GPU after GC.
   - Chat: 10 Chat only ↔ Avatar + Chat toggles, comparing live ImageBitmaps after GC.
   - Per-load peak against the baseline.
   - Visual checks: the creator, chat, `/animas/<id>` and the Library Dock still render models after switching.
8. **Review and commit:** bounded review, then `fix(avatar)[p2]: …`.

Recovery: revert the phase commit. No data or contract changes.

Results (2026-10-12):
- **Changes:**
  - New `lib/avatar/releaseModelScene.ts` detaches the model, runs `VRMUtils.deepDispose`, then closes the ImageBitmaps behind its textures.
  - `Avatar.unload()` detaches first and uses the helper; so do the disposed-after-load path and `preloadVrm()`.
  - `dispose()` clears both clip event sinks, the cursor look-at provider and the viewport element.
  - `VerifiedByteLoader` passes the verified view straight to `Blob`. The old code made an extra full copy of the model first.
  - The Avatar cleanup constraint is documented in `docs/frontend/runtime/avatar-animation.md`.
- **Caller audit:** every `avatar.load()` caller creates a fresh Avatar per load. The exception is the Library Dock, which retries a failed load on the same Avatar; that is safe, because the model is attached only after a successful load. No caller needs per-caller ordering.
- **Local checks:**
  - `pnpm check` and `pnpm web:lint` exit 0.
  - `pnpm web:test` exit 0: Vitest 473 files, 4204 passed; browser scripts 0 failures.
  - Prettier check passes on the changed files.
  - The new tests fail on the phase baseline.
- **Built task stack `animama-dockfix`** (isolated Chrome, forced GC; before = baseline main build from the investigation):

  | Scenario | Before | After |
  | --- | --- | --- |
  | Avatar Effect creator, 20 preview-model switches: renderer after GC (baseline before the first switch → after the 20th) | 520 → 1705 MB | 306 → 329 MB; +7.5% against the first switch's 306 MB |
  | Same: GPU | 885 → 2129 MB | 778 → 825 MB; +6.0% |
  | Same: live ImageBitmaps | 52 → 356 after GC | one model's set (26–29) throughout, before any GC |
  | Chat, 10 Chat only ↔ Avatar + Chat toggles: live ImageBitmaps after GC | 78 | 26 |
  | Same: canvases alive | 2 extra detached | 1 |

  - In chat-only mode, live bitmaps drop to 0 before any GC.
  - **Per-load peak (R3), measured during final review:**
    - Task build, peak renderer growth from a GC'd base during one Avatar Effect creator model switch, sampled every 150 ms: +66, +59 and +45 MB (median +59 MB).
    - The same run on the baseline was not run. The shared main stack had been stopped at 23:03Z by something outside this task, and no separate baseline stack was built. So the per-load peak was not compared directly, and the R3 peak criterion is not claimed as met.
    - What was established: retained growth per switch after GC fell from about +59 MB (baseline, 520 → 1705 MB over 20 switches) to about +1 MB, and live decoded textures stay bounded to the current model.
  - Chat Anima switching still creates one WebGL context per switch; that is Phase 5. Live decoded textures stay bounded to the current model (88–119 MB). The remaining per-switch peak is the model's ArrayBuffers and the new context.
  - No console errors about closed images or `texImage2D`.
- **Visual checks:** models render after switching in chat, `/animas/<id>` (including the carousel), the Avatar Effect creator (Annie ↔ Caitlyn) and the Library Dock (Annie → Caitlyn → Gesture).

#### Code Review #1 Findings

Independent `sdlc-reviewer` review of the working tree against `305665d8`: pass, no blocking findings. Optional findings:
- P2-CR1-N1: assert a precondition in the retention test.
- P2-CR1-N2: read uniforms only for shader materials, as `deepDispose` does.
- P2-CR1-N3: detach at the very start of `unload()`.
- P2-CR1-N4: document the cleanup constraint.
- P2-CR1-N5: a pre-existing `sha256Hex` slice.

The review also corrected the caller audit for the Dock's same-Avatar retry. It confirmed that no model texture is shared across loads or with other surfaces, that R3F `<primitive>` removal is safe, and that the cleared fields are unused after dispose.

#### Code Review #1 Revisions

- **Accepted and fixed:** N1 to N4. Focused tests (75 files), eslint, `tsc -b` and prettier pass.
- **Deferred:** N5. The slice never copies for whole-buffer model bytes, and it is outside this phase.

Code Review #2 (repair round 1 of 2) passed and confirmed N1–N4 with no regressions. P2-CR2-N1, a doc wording nit (sinks are dropped on disposal, not on unload), was accepted and fixed. One repair round remains unused.

### Phase 3: One live scroll tracker per admitted session (R4)

Issue: [#476](https://github.com/raymond-van/animama/issues/476). Depends on nothing; it runs after Phase 2 to keep reviews focused.

Steps:
1. Write a failing test for `AppRouter`: rendering while admission is loading builds no router, and a router replaced by a new admission, or unmounted, stops tracking scroll positions.
2. Build the router only when admission is ready, still keyed by the session's QueryClient.
3. In an effect cleanup, retire the previous router by turning off its scroll restoration. Use a small helper that documents its reliance on router-core's `isScrollRestoring`, and covers it with a test.
4. Check hosted composition behavior through the existing hosted browser scripts in `pnpm web:test` and the hosted-composition tests.
5. **Built stack:**
   - 20 Anima selections on `/animas/<id>`: detached canvases and DOM nodes after GC return to baseline.
   - Window `pagehide` listeners from the router: 1.
   - Back/forward scroll restoration still works on a long page.
6. Bounded review, then commit `fix(router)[p3]: …`.

Recovery: revert the phase commit.

Results (2026-10-12):
- **Changes:**
  - New `app/admitted-router.ts` hook `useAdmittedRouter` builds a router only for a ready admission, still one per session QueryClient.
  - Its effect cleanup turns off `isScrollRestoring` on a replaced or unmounted router.
  - The effect restores the creation-time value when StrictMode replays it.
  - `AppRouter` uses the hook.
- **Tests:** a unit test covers no router while loading, one router per session, retirement on replacement, admission end and unmount, and StrictMode. The router change itself has no failing-first test, because `AppRouter` imports the whole route tree; the hook carries the behavior.
- **Local checks:**
  - `vitest run src/app/` (14 files, 139 tests), `tsc -b`, eslint and prettier pass.
  - `pnpm web:test` exit 0 before the review revisions: Vitest 474 files, 4209 passed; browser scripts, including the hosted-composition, hosted-workflows and retained-screens scripts that mount `AppRouter`, 0 failures.
- **Built task stack**, 20 Anima selections through the `/animas/<id>` carousel:

  | | Before (investigation) | After |
  | --- | --- | --- |
  | Router `pagehide`, `popstate` and document capture-scroll listeners | 2 each | 1 each |
  | Live canvases after GC | 1 → 11 | 1 |
  | DOM nodes after GC | +1063 | back to baseline (10665) |
  | Renderer after GC | — | 999 → 1012 MB |

  - Back navigation restores the Library scroll container to 1500 px.
- **After the review revisions:**
  - A rebuilt task stack still shows 1 router listener of each kind.
  - 20 carousel selections leave canvases and DOM nodes at baseline after GC.
  - Back navigation still restores 1500 px.
- **Pre-existing, unchanged:** reloading the Library restores its scroll container to 13625.5 px rather than the 2200 px it was scrolled to. The main build does exactly the same, so this change did not cause it.
- **Residual (bounded):** a retired router keeps the elements it tracked since its last navigation, because router-core never removes its listener closure. That is at most one page per readmission.

#### Code Review #1 Findings

Independent `sdlc-reviewer` review against `afacb9fe`. Blocking:
- **P3-CR1-1:** under development StrictMode, React runs the memo twice and discards one result. The discarded router was already tracking and never retired, so the leak persisted in development builds. A happy-dom probe with real `createRouter` confirmed it.

Optional:
- **N1:** a retired router keeps the entries it already tracked.
- **N2:** a router was built behind the app-file-error screen.
- **N3:** no contract test runs against the real router-core.
- **N4:** the full `web:test` result was missing from this record.
- **N5:** the file name should be kebab-case, and `router.tsx` had duplicate imports.

#### Code Review #1 Revisions

- **P3-CR1-1, fixed:**
  - The memo now builds each router with tracking off. Only the mounted router turns it back on, through the effect or `<ScrollRestoration />` during render.
  - The StrictMode test now asserts that every non-mounted router is silent. It fails without the fix.
- **N2, N4 and N5:** fixed.
- **N1:** recorded above as bounded residue.
- **N3:** deferred. It needs a browser export condition in Vitest; the built-stack check covers the behavior.

Code Review #2 (repair round 1 of 2) passed. A real-router probe under StrictMode now shows `[true, false]` routers, and no scroll is recorded after retirement. After the revisions, `pnpm web:test` exits 0: Vitest 474 files, 4209 passed; browser scripts 0 failures. One repair round remains unused.

### Phase 4: Desktop and PiP window memory (R6)

Issue: [#477](https://github.com/raymond-van/animama/issues/477). Runs after Phase 2, so its measurements include the shared disposal fix.

Steps:
1. **Measurement harness:**
   - Confirm how to expose a loopback DevTools port for `pnpm desktop:dev`.
   - Run against the baseline main build and against a built task stack from this branch, through `ANIMAMA_DESKTOP_WEB_URL`.
   - Identify the main window, PiP and Quick Chat renderer processes, the GPU process and the Electron main process.
2. **Scenarios, measured before and after with GC:**
   - Open and close native PiP 20 times.
   - Switch Anima 10 times while PiP is open.
   - Resize and move PiP repeatedly.
   - Leave PiP open and idle for 10 minutes, to measure snapshot traffic.
   - Open and close Quick Chat 20 times.
   - Open and close browser Document PiP 20 times in Chrome.
   - Check the main window's suspended scene while PiP is open.
3. **Record findings** F7.x in this plan, with causes traced in source and heap snapshots.
   - Fix lifetime defects within R6 test-first: listeners, IPC subscriptions, snapshot buffers, canvases, Avatars and windows not released.
   - Bring any fix that changes visible behavior to the owner before implementing it, for example releasing the main window's Avatar while PiP is shown.
4. **Checks:** `pnpm desktop:check`, desktop unit tests, focused web tests, then a re-measurement of each scenario.
5. Bounded review, then commit `fix(desktop)[p4]: …`. Use separate phase commits if the web and desktop fixes are independent.

Gates:
- Packaged macOS app behavior, Windows behavior, and a long real-session PiP check are owner checks unless they are measured here.
- Record them in the PR rather than as issues.

Recovery: revert the phase commits. No persisted window state changes, unless a finding needs them; that would be an owner decision.

Results (2026-10-12):
- **Harness:**
  - Process: the unpackaged desktop app ran from `src/frontend/desktop` as `ANIMAMA_DESKTOP_WEB_URL=<stack> ANIMAMA_DESKTOP_DEV_USER_DATA=<disposable profile> electron --inspect=9229 --trace-warnings . --remote-debugging-port=<port> --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`.
  - Builds: the baseline main build first, then the Phase 2/3 task build.
  - Main-window instrumentation: WebGL contexts, canvases, ImageBitmaps and `requestAnimationFrame` calls.
  - Main-process counters, read through the inspector:
    - live `BrowserWindow`s and `webContents`;
    - `destroyed` listeners on the main window's `webContents`;
    - heap after GC.
  - Process footprints were read with `footprint`.
- **F7.2, fixed:**
  - **Defect:** every native PiP open added a `destroyed` listener to the main window's `webContents`. Nothing removed it, and it captured the closed PiP window. The development logs showed `MaxListenersExceededWarning: 11 destroyed listeners added to [WebContents]` at the 7th open on both builds.
  - **Fix:** `PipWindowManager` now watches each owner once, from the start of every `open()`, keyed by an id captured up front. When the listener fires, it closes whichever PiP window is current, and only if that owner still owns PiP.
  - **Test:** `desktop/tests/pip-window-manager.test.ts`. 12 cycles leave one listener (12 before the fix); destroying the owner still closes an open PiP; a destroyed former owner does not close the current owner's PiP.
- **Native PiP, task build plus the fix, 20 cycles and then 40 more:**

  | | Result |
  | --- | --- |
  | Main window `destroyed` listeners | 5 throughout (4 from other subsystems plus 1 PiP binding); no `MaxListenersExceeded` warning |
  | Live windows and `webContents` after close | 2 |
  | Main-process heap after GC | 7.3 → 7.7 MB (20 cycles) → 7.9 MB (60 cycles), tapering. The unfixed baseline rose about as much, so the leaked closures were below heap resolution. The cause of this residue is not established; it stays under the long-session gate |
  | GPU after GC | 663 → 675 → 683 MB |
  | Main renderer | one canvas, one model's textures |
  | Main-window animation frames while PiP is open | 0 per 2 s, against 120 when shown |

  - PiP is a separate renderer process that exits on close.
  - The main window unmounts its scene while PiP is shown and rebuilds it on close, so the model is never held twice.
  - **F7.1:** the baseline main build kept one previous main canvas and its model (52 bitmaps, about 177 MB) after GC. Phase 2 fixed it.
  - An earlier 6-cycle instrumented task-build run, before the fix, showed the same canvas and texture results.
- **Switching Anima with PiP open, 10 times, opening PiP before each switch:**
  - PiP was open before and closed after the switch in 10 of 10 cycles. This is existing behavior: the chat shell remounts per Anima, and `useDesktopPiP` closes PiP on unmount.
  - Windows and listeners stayed flat, the main-process heap after GC went 7.9 → 8.0 MB, and the main window kept one canvas and one model.
  - **Phase 5 constraint:** without the remount, PiP must still close on a switch.
- **PiP resized 20 times (`setSizeScale`), then idle for 10 minutes:**
  - After GC: main renderer 489 → 486 MB, PiP renderer 277 → 239 MB, main-process heap 7.9 → 7.9 MB, GPU 450 → 430 MB.
  - Snapshot traffic only creates collectable garbage; the main-process heap swings between 9 and 15 MB before GC.
  - The main-process footprint rose 132 → 141 MB and was flat (141) for the last 4 minutes, while its heap stayed flat. The source of that native growth is not established; it stays under the long-session owner gate.
  - Moving PiP was not exercised.
- **Quick Chat, 20 open/close cycles:**
  - After GC: renderer 107 → 107 MB, listeners 172 → 172, DOM nodes 165 → 165, main-process heap 7.4 → 7.4 MB, GPU 663 → 679 MB.
  - By existing design, Quick Chat keeps one prepared, hidden renderer, and a 50 ms cursor poll, for the whole session; closing it only hides it. This is bounded. Releasing it would change open latency, so it is recorded as accepted existing design for the owner to confirm rather than changed here.
- **Browser Document PiP, 20 and then 10 cycles, task build:**
  - One WebGL context and one model's textures throughout.
  - After GC, listeners and DOM nodes return to baseline, and documents rise by one (bounded).
  - Cycles were closed through `documentPictureInPicture.window.close()`; the in-app toggle close path was not exercised.
  - No baseline-build comparison or GPU record exists for Document PiP.
- **Pre-existing, unchanged:**
  - Snapshots are published even while PiP is closed. The main process clones each one and then drops it, so this is collectable churn.
  - The first snapshot after a switch can log a harmless "anima mismatch" error (8 times in 10 switches).
- **Owner gates:**
  - the packaged macOS app;
  - Windows;
  - a long real-session PiP check with speech, which should cover the unexplained native footprint rise;
  - confirming that Quick Chat's prepared hidden renderer is acceptable under R6.

#### Code Review #1 Findings

Independent `sdlc-reviewer` review of the measurement record against `fa3caa9f`. Blocking:
- **P4-CR1-1:** a main-process `destroyed` listener leaked per PiP open. The source and the logged `MaxListenersExceededWarning` show it.
- **P4-CR1-2:** the task-build PiP run was 6 cycles, not 20.
- **P4-CR1-3:** only 1 of the 10 "switches with PiP open" actually had PiP open.
- **P4-CR1-4:** Quick Chat's prepared hidden renderer does not meet R6 as written.
- **P4-CR1-5:** the unexplained footprint growth and the GPU numbers were missing from the record.

Optional:
- **N1:** add direct main-process counters.
- **N2:** snapshots are published while PiP is closed.
- **N3:** a harmless "anima mismatch" error.
- **N4:** Quick Chat's owner binding captures a window.
- **N5:** gaps in Document PiP coverage.
- **N6:** measure animation frames while PiP is open.
- **N7:** Phase 4 was marked complete before review.
- **N8:** record how to reproduce the runs.

#### Code Review #1 Revisions

- **Accepted and fixed:**
  - CR1-1: the code fix and test above, plus a re-measurement over 60 cycles with direct counters.
  - CR1-2 and CR1-3: re-run as described above.
  - CR1-4: recorded as accepted existing design and an owner gate.
  - CR1-5: GPU numbers recorded; the native rise is labelled unexplained and placed under the long-session gate.
  - N1 and N6: added to the harness.
  - N7: Progress corrected.
  - N8: the launch shape is recorded.
- **Recorded as pre-existing or limits, not changed:** N2, N3 and N5.
- **Not applicable:** N4. The fix reads the current PiP window when the listener fires.

Code Review #2 (repair round 1 of 2) confirmed the CR1 revisions and the record, and found:
- **P4-CR2-1, blocking:** reading `.id` on a destroyed `webContents` might throw.
- **N1:** the owner that takes over through the reuse path is not watched.
- **N2:** no test pins the ownership guard.
- **N3:** heap-growth wording.
- **N4:** "logs" should be "can log".

#### Code Review #2 Revisions

- **P4-CR2-1, rejected with evidence:** in the running Electron 39.8.9 main process, a `destroyed` handler read `webContents.id` successfully (`id=73`). The id is captured up front anyway, which costs nothing.
- **N1, accepted:** the watch now starts at the beginning of every `open()`.
- **N2, accepted:** the takeover test fails without the change.
- **N3 and N4, accepted:** wording above.
- **Checks:**
  - desktop Vitest 509 passed;
  - `pnpm desktop:check` exit 0;
  - rebuilt app, 10 PiP cycles: listeners 4 → 5 and flat, windows 2, heap after GC 7.3 → 7.6 MB, no `MaxListenersExceeded`.

Code Review #3 (final targeted recheck) passed. Mutation runs confirmed the takeover test catches both a missing reuse-path watch and a missing ownership guard. Two repair rounds were used.

### Phase 5: Chat keeps its renderer across Animas (R5)

Issue: [#478](https://github.com/raymond-van/animama/issues/478). **Deferred by the owner on 2026-10-12** (see the Decision Log). The steps below are kept for the follow-up. One extra constraint comes from Phase 4: without the remount, an Anima switch must still close native PiP, as it does today.

Steps:
1. **Audit what must reset per Anima** under `MainShell` and the canvas actor:
   - safety notice and crisis card;
   - chat (already keyed by `ChatInterface key={animaId}`);
   - avatar transform, scene camera and background;
   - emotion and playback state;
   - lip-sync and voice registration;
   - PiP snapshot identity;
   - desktop runtime messages.
   Record each item and how it resets.
2. **Write failing tests:**
   - `CompanionSafetyProvider` resets its state when its `animaId` changes, without remounting its children.
   - Each audited item that currently relies on the remount resets on an Anima change.
3. Replace `CompanionSafetyProvider key={animaId}` with an `animaId` prop. Move per-Anima resets into the owning components. Keep the `ChatInterface` key.
4. **Built stack:**
   - 20 Annie ↔ Caitlyn switches create one WebGL context, and the renderer after GC stays within 10% of the first switch.
   - Visual checks of each Anima's model, transform and background, a fresh chat, and the safety UI.
   - With desktop PiP open, an Anima switch closes native PiP, as it does today, unless the owner decides PiP should follow the switch.
5. Bounded review, then commit `fix(chat)[p5]: …`.

Recovery: revert the phase commit to restore the remount.

## Final integration review

Independent `sdlc-reviewer` review of `acea31d5` against `95a2db39`, covering Phases 1–4 with Phase 5 deferred.

**Cross-phase integration passed:**
- the Phase 1 keyed actor and retry work with Phase 2's release;
- bitmap closing does not affect textures shared across the Dock, chat, the PiP route, creators or portrait capture;
- Phase 3 router retirement works with the auxiliary windows and the warm Dock;
- Phase 4 is independent of Phase 2;
- boundaries hold: no Cloud imports, auth changes or generated edits.

**Findings:**
- **FIR-1, required:** the R3 per-load peak had no evidence.
- **FIR-2, required:** the PR body still described only Phase 1.
- **FIR-3, required:** the R5 deferral was not reflected in #478 or in this plan's Phase 5 PiP expectation.
- **FIR-4, required:** this plan's final sections were incomplete.
- **Optional:**
  - O1: wording drift between the spec and the issue.
  - O2: R3 says unload drops callbacks; dispose does that, by design.
  - O3: state the within-10% reference values.
  - O4: doc placement and the router architecture note.
  - O5: commit scope naming.

**Revisions:**
- **FIR-1:** measured on the task build (median +59 MB). The baseline comparison was not possible, so R3's peak criterion is recorded as not met rather than claimed (Phase 2 results).
- **FIR-2:** PR #474 updated for the full scope.
- **FIR-3:** #478 records the deferral and that PR #474 does not deliver it. The Phase 5 PiP expectation now matches current behavior.
- **FIR-4:** this section, Authorized scope, Progress and Outcomes completed.
- **O1:** the spec status notes the deferral.
- **O3:** the reference values are added.
- **O2, O4 and O5:** accepted as is. The R3 refinement is recorded in Phase 2, and future plan docs use a non-colliding scope.

**Reused evidence:**
- **Web:**
  - `pnpm check`, `pnpm web:lint` and `pnpm web:test` (474 files, 4209 tests, browser scripts 0 failures) on `fa3caa9f`.
  - `pnpm e2e:test:fast` 38/38 on a built stack serving `fa3caa9f`.
  - `git diff --stat fa3caa9f..acea31d5` touches only desktop and plan files, so the web build is identical.
- **Desktop:** Vitest 509 passed and `pnpm desktop:check` exit 0 on `acea31d5`.

## Validation and acceptance

Use the spec's acceptance criteria. Each phase records its exact commands, results,
before/after measurements and unperformed checks here. Hosted validation is
currently disabled, so the PR records local evidence only.

## Idempotence and recovery

Every phase is source-only and revertible by commit. Task stacks are disposable
and are taken down after their last use; their volumes are kept. Measurement
profiles and scripts live outside the repository. Main-stack measurements stay
read-only. They save no content, and they restore any changed preference, such as
the last active Anima.

## Outcomes & Retrospective

**Delivered:**
- R1, R2 and R4 are met.
- R6 is met within the recorded limits.
- R3 is met for decoded-texture release and dropped references, but its per-load peak criterion was not compared against a baseline.
- R5 is deferred to #478.

**Remaining owner gates:**
- the packaged macOS app;
- Windows;
- a long real-session PiP check with speech, covering the unexplained main-process footprint and heap residue;
- confirming that Quick Chat's prepared hidden renderer is acceptable.

**Lessons:**
- A heap-only measurement missed a listener leak that the logged `MaxListenersExceededWarning` and direct counters showed. Measure listeners and windows directly.
- Each removed remount needs its own explicit resets, so measure the benefit before taking on that risk. That is why R5 was deferred.
