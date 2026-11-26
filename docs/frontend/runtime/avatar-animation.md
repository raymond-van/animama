# Avatar + Animation Runtime Guide

The Avatar runtime loads VRMs and coordinates motion, expressions, effects and
speech-driven presentation from chat state.

For the lip-sync pipeline, from played audio and spoken text to VRM mouth
shapes, tag expressions and talking-hands beats, see
`docs/frontend/runtime/avatar-lipsync.md`.

For the focused guide to planner-owned state-triggered motion policy, see
`docs/frontend/runtime/avatar-planner.md`.

Library and Anima Gesture/Reaction previews compile one exact root plus its
transitive Effect/Sound closure and adapt that immutable closure to the existing
motion/media catalog. VRMA Gestures use the gesture animation lane; Anima Clip
Gestures use the pose-clip gesture lane; Reactions use the non-body reaction
lane. Chat consumes the same frozen runtime snapshot as the player.

The direct Gesture and Reaction creators preview the current in-memory draft
through the client-side timeline without saving it or changing an Anima
loadout. The editor prepares an exact dependency closure locally when timeline
events need Effects or Sounds. Gesture supports the Anima Clip schema and a
self-contained VRMA import. Reaction exposes expression/effect/sound timing and
rejects humanoid tracks. Its creator preview uses Relaxed Rest as a display-only
body pose while loading, seeking and playing; that backdrop is not written into
the Reaction document.

Standalone Included/Local Poses contain resolved static bone and expression values.
The Gesture editor saves them through `/v1/poses`; Library previews use a static
hold in the existing protected preview dock without changing an Anima. Selecting a
pose for a Gesture copies effective values, including inherited channels and the
clip base overlay. The insertion bakes the whole candidate clip and removes its
external base as one undoable edit, preserving existing samples. Saved/reopened
clips therefore remain independent of source edits or deletion. Reactions retain
their expression/effect/sound-only contract.

Included Poses are canonical documents under `content/included/poses`: the five
Starter Poses plus the hand-made poses the Included Gestures were built from.
A clip names one only as its `basePose`; package exports reference it as an
app primitive (`animama/builtin-pose/1/<id>`). The Gesture creator's Poses tab
lists Local
Poses; its "Show Included" checkbox (off by default) adds the Included ones.

The Anima's Idle pool adds a separate Gesture-backed idle lane. A mount freezes
each pool Gesture as its own root with exact finite playback facts; a Gesture
that cannot be admitted is left out alone. Each selection weights Default at
one half and the dominant emotion's cells from Mild up to its intensity at the
other, uniformly within each half; a Gesture in both takes both shares, and an
empty half gives the other the whole pool. Neutral uses Default alone. Each
half leaves out the previous Gesture when it has another choice.
Pool changes apply on the next mount; emotion changes affect the next
selection. Idle members are absent from the AI-invocable Gesture list.

## 1) High-level architecture

The avatar runtime is split into four layers:

1. **3D actor layer**  
   File: `src/frontend/web/src/ui/main/canvas/AvatarCanvasActor.tsx`  
   Loads the VRM model for the active anima, owns a runtime `Avatar` instance, and runs per-frame updates.

   The model source is the resolved `avatar_model` from
   `GET /v1/animas/{anima_id}/runtime`. Its effective/content revision,
   slot, and runtime ID form the stable canvas load key; short-lived download targets are
   never identities. `AnimaRouteProviders` freezes the first resolved response
   for the route mount, so a background refetch cannot replace a model during
   an active chat. Included and Local model files are verified through the application origin
   before the loader receives prepared Blob URLs. The same frozen response
   constructs one `AnimaRuntimeCatalog`, which appends verified optional roots
   without replacing the model or catalog. Owner, route, or explicit revision
   replacement cancels the old preparation and disposes its resources. A fully
   prepared creation handoff retains its existing StrictMode-safe ownership.

2. **Avatar runtime layer**  
   Files: `src/frontend/web/src/lib/avatar/*`  
   Core runtime classes:
   - `Avatar.ts`
   - `AnimationManager.ts`
   - `poses/PoseController.ts`
   - `planner/AvatarPlanner.ts`
   - `ExpressionController.ts`
   - `ProceduralAnimationController.ts`

- `proc-animation/*`
- `spring-bone/SpringBonePhysicsController.ts`
- `animationManifest.ts`

3. **Reactive state bridge layer**  
   File: `src/frontend/web/src/stores/avatar-runtime-store.ts`  
   Holds UI/runtime signals (`interactionPhase`, emotion state, and queued gesture requests).

4. **Chat/SSE integration layer**  
   Files:
   - `src/frontend/web/src/ui/main/chat/useChatSession.ts`
   - `src/frontend/packages/product-ui/src/query/mutations/useChatSse.ts`
   - `src/frontend/web/src/ui/main/chat/ChatInterface.tsx`  
     Converts chat lifecycle + SSE events into avatar store updates.

## 2) Core runtime classes

### `Avatar`

File: `src/frontend/web/src/lib/avatar/Avatar.ts`

Responsibilities:

- Load/unload VRM.
- Own `PoseController` (JSON-backed catalog poses).
- Own `AnimationManager` (skeletal/VRMA playback).
- Own `ExpressionController` (emotion expressions, blink, lip-sync APIs).
- Own `ProceduralAnimationController` (additive body motion and idle cursor
  look-at).
- Own `SpringBonePhysicsController` (runtime spring-bone tuning/helpers).
- Own `AvatarVFXController` (runtime material/texture VFX for the active VRM).
- Own `AvatarPlanner` (state-triggered VRMA loop/gesture, PoseController clip,
  and procedural layer policy).
- Expose high-level APIs for animation/expression/lip-sync operations.
- Consume the mounted `AvatarMotionCatalog` for idle animations, gestures,
  pose clips, reaction clips, static pose support, and VRMA resource loading.

Important behavior:

- `Avatar.load` applies the engine-owned default `relaxedRest` pose through
  `PoseController`, including VRM 0/1 retargeting. `prepareFirstFrame()` requires
  that pose to be active with both upper arms resolved, then updates the VRM
  rig and world transforms at zero elapsed time before scene attachment. A
  failure leaves the non-avatar fallback; it never exposes a T-pose.
- `resetAnimations()` resets procedural layers, clip animation, and
  PoseController state before explicitly reapplying default poses.
- `applyPose(...)`, `playClip(...)`, and `stopClip(...)` accept
  `preserveProceduralOffsets`. When enabled, `Avatar` removes the previous
  frame's procedural offsets from the old base pose, replaces the static
  pose/clip base, then reapplies procedural layers at `delta=0` so active
  layers such as sway do not visually restart during debug pose or clip
  invocation. Pose clips remember the flag so default-pose restoration on stop
  or non-looping completion uses the same preservation path.
- `playClip(...)` is synchronous for an already loaded catalog entry.
  `loadAndPlayClip(...)` lazily decodes a prepared private Anima Pose Clip
  manifest before playback. Planner-owned pose, reaction, and VRMA actions
  verify that the requesting owner/run/plan is still current after asynchronous
  work. Pending resources are skipped, never fetched around the preparation
  session. A disposed animation manager cannot cache or play a late decode.
- Planner-owned Gesture clips remain pending while their prepared sequence is
  decoded. Playback starts a finite horizon from the loaded timeline duration
  and configured speed; loading time is excluded. A looping clip instead uses
  its configured duration, or its timeline, with a two-second minimum. The
  player uses the configured speed for its timeline while entry and exit fades
  retain wall-clock timing.
- `update(delta)` is the per-frame coordination point:
  1. clear procedural offsets from the previous frame
  2. update `AnimationManager` so authored VRMA clips establish the base pose
  3. blend any automatic idle VRMA exit back to the default `relaxedRest` base
     pose
  4. update `PoseController` so active Anima Pose Clip samples can layer
     on top of mixer output, then pass the clip's presence (fade weight,
     `mutedProceduralLayers` and sampled expressions) to the procedural and
     expression controllers
  5. apply procedural animation layers on top of that pose; layers a playing
     clip mutes are scaled down by its fade weight and ease back over the
     activation blend time (0.28 s) when it ends, is stopped or is replaced
  6. sample active reaction clips into expression overlays and effect events
  7. update expressions, look-at, lip-sync, and VFX
  8. update spring-bone physics settings before three-vrm evaluates spring bones
  9. call `vrm.update(delta)`
  10. update optional spring-bone helper visuals
- `updateState(snapshot)`:
  - Resolves dominant emotion from `snapshot.emotionalState.activeEmotions`.
  - Asks `AvatarPlanner.plan(...)` for next VRMA, planner-owned pose clip,
    planner-owned procedural actions, and reaction clip actions.
  - Applies emotion preset only when label/intensity changed.
  - Plays gesture/loop VRMA clips only when the active plan key changes.
  - Runs idle VRMAs as intermittent stints from `manifest.json`: quiet
    period, one finite emotion-aware idle VRMA, then quiet again.
  - Plays and stops planner-owned PoseController clips through
    `Avatar.playClip(...)` / `Avatar.stopClip(...)` with procedural offset
    preservation.
  - Plays and clears planner-owned reaction clips through `ReactionClipPlayer`.
    Reaction clips are expression/VFX/SFX-only, can include particle VFX events,
    and do not suspend automatic VRMA playback.
  - Applies planner-owned procedural layer policy through
    `ProceduralAnimationController`, while debug/manual layer changes keep
    manual ownership.
  - Stores the latest planner debug snapshot for the Animation Debug modal.
  - Planner-owned VRMA playback always receives a nonzero transition duration
    when the planner supplies one, including the first automatic VRMA play.
    When automatic VRMA playback resumes after a coordinated PoseController
    clip, `Avatar` applies a one-shot short fade to the resumed VRMA plan.
  - VRMA action stops and natural finite completions capture the current
    humanoid base with procedural offsets stripped, blend that base back to
    `relaxedRest` over the relevant fade duration, and reapply procedural
    layers throughout the blend. Crossfades into another VRMA cancel the rest
    blend because the next authored clip becomes the base.

### `AnimationManager`

File: `src/frontend/web/src/lib/avatar/AnimationManager.ts`

Responsibilities:

- Own `THREE.AnimationMixer`.
- Load VRMA clips, cache clips, and play/crossfade actions.
- Track active actions and metadata (blend mode, additive ref, loop mode, etc.).

Important behavior:

- `playLoop(...)` and `playGesture(...)` are wrappers over `playAnimationWithName(...)`.
- `playGesture(...)` forces `loopType="once"`.
- Planner-owned idle stints use `playLoop(...)` with the production manifest
  `loop_type`, `loop_count`, and `time_scale`, then `stopAction(...)` when the
  computed finite stint duration elapses.
- Natural mixer `finished` events release the completed action; `Avatar` wraps
  VRMA playback callbacks so finite actions can fade the visible base back to
  `relaxedRest`.
- Supports additive clips when `blendMode="additive"` and an additive reference is supplied.
- Stops and cleans up stale actions/timers on fade completion and mixer `finished` events.
- `resetAll()` also resets humanoid pose when possible.
- The Animation Debug modal exposes a global **Root VRMA playback** toggle. When
  enabled, `AnimationManager` regenerates VRMA clips without `.position`
  translation tracks, so Mixamo-style root/hips translation does not move the
  avatar through the scene. Rotation, expression, and look-at tracks still play.
  Changing the toggle clears generated clip caches and restarts active VRMA
  playback through the normal planner/manual paths.

### `PoseController`

File: `src/frontend/web/src/lib/avatar/poses/PoseController.ts`

Responsibilities:

- Resolve `animaPose/1.0` poses and Action-owned Anima Pose Clip sequences
  through the injected motion catalog for the loaded VRM model.
- Own active clip playback state; the app catalog remains the fallback for
  authoring/debug surfaces outside an Anima runtime.
- Apply the app default `relaxedRest` catalog pose after load and after avatar
  resets.
- Invoke catalog poses as absolute normalized humanoid poses, not offsets from
  `relaxedRest` or from the previously active pose.
- Sample timed pose clips every frame when a clip is explicitly started through
  `Avatar.playClip(...)` or `Avatar.playAnimaPoseClip(...)`.

Important behavior:

- `applyPose(poseId)` resolves any `AnimaPose.parent` chain, clears other
  active PoseController state, resets the VRM humanoid to its normalized
  T-pose, then applies exactly one resolved catalog pose.
- `applyPose(poseId)` does not apply `relaxedRest` before other poses.
  `relaxedRest` is only the app default because `Avatar` explicitly applies it
  on load/reset through `applyDefaultPoses(...)`.
- Parent pose inheritance uses sparse absolute overrides, not quaternion
  deltas. Missing child humanoid targets inherit from the resolved parent;
  child-defined values replace the inherited field. Humanoid inheritance
  defaults on, expression inheritance defaults off.
- Expression values authored by a pose are restored to their captured
  pre-pose values when switching or clearing poses, so pose expression weights
  do not leak into later states.
- One active PoseController output is allowed at a time. Applying a static pose
  clears any active clip, and playing a clip clears active static pose state.
- Active clips are sampled after VRMA mixer output and before procedural
  animation layers. Procedural layers therefore remain additive on top of the
  sampled clip.
- Clips can define optional `fadeIn` and `fadeOut` playback envelopes. Fade-in
  blends from the current normalized avatar pose into the sampled clip, while
  fade-out blends sampled clip output back to the app default pose path
  (`relaxedRest` today) before automatic playback resumes. A bone position the
  fade's target leaves out (usually the hips) fades to rest rather than holding
  its offset, so a clip ends without a jump. Pose clip events are
  not newly dispatched during fade-out; active VFX events remain owned by the
  clip and clear when their event duration expires or when the clip fully
  stops.
- Clips can define optional `playback.lifetime` rules. A non-loop clip with a
  playback lifetime plays its authored timeline once, holds the final sample,
  and exits only when the planner/user stops it. A loop clip with a playback
  lifetime loops while that lifetime remains active.
- Loop clips should author the repeating body of the motion directly and use
  `fadeIn`/`fadeOut` for entry and exit instead of adding `relaxedRest`
  endpoint keyframes solely for runtime transitions.
- Active clips also evaluate optional effect events while playback advances.
  `PoseController` owns scheduling and diagnostics; runtime adapters owned by
  `Avatar`, scene VFX, and sound perform the actual avatar VFX, scene VFX, and
  SFX side effects.
- `Avatar.playClip(...)` temporarily suspends automatic VRMA playback while the
  clip is active and restores the previous automatic-playback setting when the
  clip stops. If automatic playback is restored, the next planner-owned VRMA
  plan gets a short resume fade so the handoff does not snap from the final
  pose-clip output.
- Non-looping clips without `playback` stop automatically at their duration,
  restore expression baselines, and return the avatar to the normal default
  pose/runtime path.
- VFX events can remain active for a duration and are cleaned up when the clip
  stops, switches, resets, or unloads. VFX events without duration remain
  active until the owning clip clears. SFX events are one-shot events and are
  not replayed during manual scrub preview or a held final sample.
- The animation debug modal's `PoseController` section lists built-in catalog
  poses and invokes them through `Avatar.applyPose(...)` with procedural
  offset preservation enabled.
- The animation debug modal's `PoseController Clips` section lists the mounted
  Anima catalog clips and invokes them through `Avatar.loadAndPlayClip(...)` and
  `Avatar.stopClip()` with procedural offset preservation enabled. The UI does
  not sample clip data directly; it reads the runtime `AvatarPoseClipSnapshot`
  for active clip id, elapsed time, resolved targets, missing targets, and
  missing pose refs. The same snapshot reports effect-event totals by kind,
  fired/active runtime counts, chat availability, skipped events, and the
  latest event adapter error when present.
- The animation debug modal's `Reactions` section lists clips mounted in the
  reaction runtime slot with the cells whose pools hold them; the filters match
  any of those cells, and a Reaction in no pool shows only while every filter
  is open. It resolves clips lazily through debug-only `ReactionClipPlayer`
  APIs and shows both live reaction playback state and planner reaction
  diagnostics. Manual debug reaction playback is runtime-only:
  it does not enqueue planner events or mutate canonical emotion state.

#### Rest normalization

Catalog poses (including `relaxedRest`), Gestures, hand shapes, talking hands,
VRMA playback and Pose creator authoring all write rotations for VRoid's rest:
arms straight out to the sides (a T-pose), and hands with the fingers straight
along the arm, palms down and the thumbs angled forward. A model that rests
otherwise (an A-pose; fingers bent down, the hand rolled or thumbs further
forward, as on many converted VRChat Avatars) would move its arms and fingers
in the wrong planes.

At load, `prepareLoadedVrm` calls `installRestNormalization`
(`poses/anatomy/restNormalization.ts`). It measures each upper arm and forearm
against horizontal, and each hand and finger bone's rest frame (bone direction
and palm normal) against VRoid's, measured on Annie and carried by the hand's
own forearm's rest direction, so an arm's tilt never counts against its hand.
Arms 10° or more from a T-pose are normalized, and a corrected forearm carries
its hand and fingers with it (rigidly when the hand cannot be measured, as on
a hand without a little finger or finger bones). Hands are normalized when they
differ by 5° or more:

- The instance's `humanoid.update` transfers each corrected bone's rotation N
  as `W_parent⁻¹ · N · W_bone`, where `W` turns the model's rest frame into
  VRoid's, and restores the authored rotations afterwards. Every `vrm.update`
  passes through it, so every writer above is covered, in the app,
  `animation:render` and the tests alike.
- The normalized rig's child offsets below each corrected bone (and three-vrm's
  normalized rest pose) are turned by their parent's `W`, so the normalized arm
  and hand have VRoid's shape with the model's lengths. Readers of normalized
  geometry (the arm-contact solver, thumb and pinch fits, fingertip and palm
  contacts, Pose creator markers) then see the arm as drawn.
- Each bone is measured from its nearest present ancestor, as three-vrm
  parents it; a bone with nothing to measure (no later bone in its digit)
  follows its parent rigidly.

`Avatar.restPose` keeps the measurement, and Avatar Diagnostics shows it under
Motion ("Rest pose"). The Included Avatars and VRoid models are within both
tolerances and take the same path as before. A normalized hand rests straight,
palm down, like VRoid's; the idle pose bends it as on the Included Avatars.

Contact offsets scale with `avatarScale` (rest head height above the feet over
1.25 m), and the solver reaches with the model's own arm lengths, so a
uniformly larger model solves the same arm turns. Offsets from the `head` of a
big-headed Avatar (chibi, mascot or robot proportions, measured at load by
`avatarProportions.ts`; see [Size-aware
placement](avatar-vfx.md#size-aware-placement)) scale with its face's size
instead, so hands reach its cheeks rather than stopping inside the head at the
jaw. Adult and anime proportions, the Included Avatars among them, are
unaffected.

### Optional bones a rig lacks

VRM requires only the hips, spine, head and limbs; Gestures, poses and
contacts also use the chest, upper chest, neck, shoulders, eyes and every
finger segment, which VRChat conversions and low-poly Avatars often lack
(`poses/anatomy/optionalBones.ts`). A complete rig, such as either Included
Avatar, takes none of these paths.

- **Torso:** in Gestures and poses, the rotation of a missing `upperChest`
  (or `chest`) folds into the nearest torso bone below it, so everything above
  bends as on a complete rig, pivoting at that bone. Prepared clips fold before
  contacts are solved, default poses before a fade blends them, and poses
  where they are applied. Procedural layers (sway, breathing, talking hands,
  emotion posture, head nods and tilts, cursor look-at) still skip it.
- **Contacts:** a contact on a missing `upperChest` uses the chest (or the
  spine) at an estimated upper-chest joint: 0.635 of the height from the spine
  joint to the neck (the Included Avatars' share), at the stand-in's own depth,
  wherever the rig puts its chest. A contact on a missing finger segment
  uses the nearest segment of the same finger toward the hand, with the same
  point (`tip` then extrapolates that segment). A finger with no segments has
  no stand-in, so its contacts are skipped.
- **Skipped:** finger curls on a missing segment (the remaining segment already
  carries the rest of the finger), and any motion of a missing neck, shoulder
  or eye.

Avatar Diagnostics lists each missing bone under Motion with what stands in
for it, and `vrm:inspect` prints the same list.

### Pose and clip JSON artifacts

`AnimaPose` and `AnimaPoseClip` are separate JSON artifacts. `animaPoseClip/2.0`
(beats and tracks; see
[ADR 0014](../../adr/0014-track-based-anima-pose-clips.md)) is the only clip
format. Gesture, Reaction and Idle playback, the runtime and built-in
catalogs, the creators, the preview and render tools and package import all
read it. The retired `animaPoseClip/1.0` is identified by its `schema` and
rejected, never converted
([ADR 0016](../../adr/0016-anima-pose-clip-2-only.md)): `parseAnimaPoseClip`
throws `UnsupportedAnimaPoseClipFormatError`, and the backend reports
`clip_format_unsupported` with the same per-clip message (package import
uses a fixed package-level message).

- `animaPose/1.0` is a single absolute pose snapshot. It can contain partial
  normalized humanoid bone transforms, expression weights, and an optional
  `parent` ref to another catalog pose. `parent` fills missing targets before
  application; no `parent` means omitted static-pose bones fall back to the VRM
  normalized T-pose after `PoseController` resets the humanoid. The Included
  `relaxedRest` snapshot contains every bone's resolved transform, including
  identity anchors used when authoring sparse overlays.
- A clip has `id`, `name`, a required `duration`, and optional `loop`,
  `basePose` (an Included Pose id), `playback`, `fadeIn`/`fadeOut`,
  `mutedProceduralLayers` and `events`. `role` is accepted only as legacy
  compatibility metadata (`"motion"` or `"reaction"`); parsing does not inject
  a default, and runtime routing does not inspect it. The effective loadout
  collection determines whether a clip runs as a gesture, pose, or reaction.
- `duration` is required. `beats` lists `{ id, label, time, ease? }` between 0
  and the duration, at least 0.5 ms apart in increasing time. Labels are the
  readable names the creator shows.
- Every key names its `beat` and an offset `dt` from it (default 0), and holds
  an absolute value. A key lies between its beat's neighbouring beats, so
  retiming a beat moves its keys, and deleting a beat removes them. Keys on one
  channel are also at least 0.5 ms apart. Times are validated in 0.1 ms ticks, the
  precision the serializer writes.
- Track kinds: `joints` (anatomical components in degrees, keyed per joint and
  component, for example `joints.leftUpperArm.elevation`; `v: "base"` means the base
  pose's value), `rotations` (normalized bone quaternions `q`, used by
  hand-made poses and the Gestures converted from 1.0), `hipsPosition`
  (`x`/`y`/`z` in metres), `hands` (hand-shape keys, below) and `expressions`
  (weights from 0 to 1). A track that is absent leaves its bones to the base
  pose. A track drives its channel for the whole clip, so a keyed expression
  (even at 0) holds while the clip plays.
- A hand key names one of the twelve Hands-tool presets (`HAND_PRESETS`), then
  optional relative `curl` and `spread`, then optional `fingers.<digit>`
  offsets in joint-model degrees: `curl` (one value, or one per segment) and
  proximal `splay` for fingers; `curl`, `palmarAbduction` and `twist` for the
  thumb (`HAND_DIGIT_OFFSETS`, at most ±90°). They apply in that order
  (`handShapeRotations`), and the whole shape blends between keys. A keyed
  finger joint or rotation replaces the hand key on that segment for the whole
  clip. See [ADR 0019](../../adr/0019-hand-keys-with-fitted-presets-and-finger-offsets.md).
- A key's `ease` describes how motion arrives at it. It falls back to the
  beat's `ease`, then to the track default: `smooth` (monotone cubic; motion
  carries through keys without overshoot) for scalar tracks and
  `easeInOutSine` for rotation and hand tracks. `linear`, `hold`, sine, cubic,
  and the stylized `back`, `elastic` and `bounce` easings are also available;
  `tangent: "flat"` stops motion at a smooth key. The stylized curves are
  soft-blended with `easeInOutSine`, but can still overshoot, so reserve them
  for playful motion. A loop whose tracks key both 0 and the duration closes
  smoothly across the seam.
- `plantFeet: true` solves the legs during playback so both feet stay at
  rest.
- `contacts` declare intended touches: `bone` touches `target` from `from` to
  `to` seconds after `beat`, with optional `tolerance` and `offset` (metres for
  a 1.25 m rest head height, in the target's rest-aligned frame, scaled by each
  Avatar's height). `point` and `targetPoint` measure at the joint origin
  (`joint`, the default), the palm surface (`palm`, hand bones) or a finger
  segment's far end (`tip`, finger bones). `facing: true` (hand or finger
  bones) asks the checks to verify that the palm turns toward the target. The
  motion checks measure every contact.
- A contact with `solve` (`{}` or `{ blendIn?, blendOut? }`, 0–2 s, default
  0.15 s) also plays: during its window that arm's upper arm and elbow are
  re-solved on each Avatar so the point lands on the target, keeping the
  authored collarbone, elbow swivel, forearm rotation, wrist and fingers, and
  easing in and out (ramps of consecutive windows on one side shorten to meet
  midway, so claps chain). Within 3 cm of full reach the arm saturates softly
  instead of snapping straight, so a target at full reach misses by about
  1.1 cm. A solved contact moves a hand or finger bone, does not target its
  own arm, and solved windows on one side do not overlap. Two solved contacts
  whose targets each lie on the other arm are rejected when their windows
  with blends overlap, unless both target an upper arm or forearm (crossed
  arms): a hand target would make each hand chase the other, so a clap
  solves one palm onto the other. Retiming a beat maps solved windows through
  the beat times; unsolved contacts keep their offsets from their beat. Live
  layers applied after the clip (breathing, unmuted head or torso layers) can
  still move a solved contact by millimetres, so clips with solved head
  contacts mute the head and torso layers. See
  [ADR 0020](../../adr/0020-solved-hand-contacts.md).
- Clips are prepared once per Avatar when playback starts
  (`createAnimaPoseClipProgram`): hand presets are fitted to its fingers (the
  thumb, and for `pinch` and `ok` also the index so the pads meet), and planted
  legs and solved contacts are solved on its rig after the rest of the pose
  (`solveContacts: false` plays the authored arms). Sampling a frame then costs
  about 0.01 ms.
- Parsing rejects a duration over 3,600 s, more than 1,000 beats, 400 tracks
  or 50,000 keys, beat ids over 64 characters and labels over 80, and
  preserves unknown top-level fields verbatim. A clip needs at least one track
  key or event. Validation errors name the field path, for example
  `expressions.happy[0].beat`. The Gesture creator writes back fields it does
  not edit (for example `playback`, `role` or tool metadata) on Save and export.
- Clips may include timed `events` for avatar VFX, scene VFX, particle VFX and
  SFX. Events store catalog ids, not embedded effect assets. An effect-only
  clip has no tracks and at least one event; the editor does not manufacture a
  neutral expression landmark merely to carry VFX or sound. Event-only Gesture
  playback, fades and cleanup preserve the selected body/expression pose; only
  the clip's events own effects until their end or cancellation. VFX event
  duration does not extend the clip because it describes the event lifecycle.
- `playback.lifetime.kind: "whileInteractionPhase"` keeps a planner-owned clip
  eligible while the current interaction phase is in `phases`. Reaction clips
  use this with `phases: ["talking"]` and `scope: "activeRun"` so they fade in
  and hold for the same speaking run, then fade out when talking ends or the
  run changes; the timeline's `duration` does not limit that hold. The
  creators preview only the timeline, so Included Reactions run at least 2 s
  (longer when a timed effect does) to show the held Reaction there.
  `whileAvatarState` is available for future state-owned clips.
- `mutedProceduralLayers` optionally lists live layers (`breathing`, `sway`,
  `bounce`, `headNod`, `headSideTilt`, `cursorLookAt`, `emotionPosture`) muted
  while the clip plays, including Idle playback. Muting never changes
  layer settings or planner ownership; a clip without the field leaves layers
  untouched. `talkingHands` is already suppressed for every Gesture. The Gesture
  creator sets these under Clip settings → Mute while playing; its preview runs
  no live layers, so check muting in a chat.
- Expressions keyed by a playing clip take precedence over the emotion system:
  keyed values blend in by the clip's fade weight, and if the clip keys any
  emotion preset (`happy`, `angry`, `sad`, `relaxed`, `surprised`, `neutral`)
  the emotion system's whole face fades out by the same weight. A keyed `blink`
  overrides automatic blinking; lip-sync and manual overrides still apply last.
- Clip fade envelopes are objects with `duration` plus optional `easing` and
  optional interpolation overrides (default `slerp` rotation, linear
  position/expression).

### Mounted motion catalog

`src/frontend/web/src/lib/avatar/motion/AvatarMotionCatalog.ts` defines the
small runtime boundary consumed by `Avatar`, `AvatarPlanner`,
`PoseController`, and preload planning. The explicit built-in implementation
adapts the existing animation/pose/reaction registries for standalone creator,
preview, and compatibility surfaces.

Live Anima routes instead build
`src/frontend/web/src/lib/runtime-content/AnimaRuntimeCatalog.ts` from the exact
frozen `GET /v1/animas/{anima_id}/runtime` response. It projects only
that Anima's effective idle, gesture, pose, and reaction entries. Removing a
Starter binding therefore removes it from the next mount; another Anima's
similarly named content item cannot be discovered through a global lookup.
Each Reaction is one entry (runtime ID `reaction:<item_id>`) however many cells
hold it, and the response's `reaction_cells` become `reaction_pools`: each
cell's mounted members by runtime ID. A member that did not mount is left out
of every pool, and the pools fixed for the revision include members still
preparing, which are skipped with a diagnostic until they are ready.

VRMAs resolve to verified prepared resources for the active mount. Their cache
identity is `runtime_id + content_revision`, not a short-lived protected URL. Idle entries
use resolved emotion weights and finite loop metadata; preload tiers come from
the binding configuration. Private pose/reaction manifests stay lazy, have a
2 MiB streamed-read limit, parse once, and are aborted/released when their
catalog is disposed. User clip event references are accepted only when their
SFX/VFX runtime IDs occur in the same effective response. Events whose alias the
projection lists in `missing_references` are skipped instead: a Local Action's
removed Included effects (with a `missing_effect_dependency` diagnostic), and a
built-in Action's optional pack sound that this build doesn't install
(silently; see the [comedy sound pack](../../backend/operations/comedy-sound-pack.md)).
Duplicate or invalid
motion identities are omitted with safe diagnostics. Effect and audio resources
resolve through the mounted media providers with the same revision and
prepared-byte boundary.

The Animation Debug modal and the compact Anima debug panel list the mounted
catalog rather than the process-global motion inventory. The compact panel can
play both active VRMA entries and `animaPoseClip` gestures, while the larger
modal can manually resolve mounted Gesture and Reaction entries by runtime ID.
Standalone authoring pages explicitly receive the built-in provider and never
acquire private Anima resources implicitly.

Expanding the compact panel's Active Motion Catalog does not enable the
500 ms live animation-snapshot publisher. Catalog membership is static for the
route mount, so it renders without polling; current playback and fade telemetry
belongs to the separate Active Actions section, which opts into live snapshots.

Standalone Included poses are authored in `content/included/poses/<id>/<id>.json`
as self-contained, parent-free content descriptors. The synchronous App provider
uses a generated projection; run `pnpm poses:generate` from `src/frontend` after
changing these descriptors. The web build and source check reject projection drift.

Built-in runtime inputs behind the App provider are:

- `src/frontend/web/src/lib/avatar/poses/pose_catalog.generated.json` (generated poses)
- the Included Gesture and Reaction clips, bundled straight from
  `content/included/gestures/<id>/<id>.json` and
  `content/included/reactions/<id>/<id>.json` (metadata files excluded)

`catalog.ts` validates these files on load and exposes raw and resolved pose
helpers. Missing, invalid, duplicate, or id-mismatched pose/clip entries are
skipped with console warnings instead of breaking app startup. Poses whose
parent chain cannot resolve are also skipped, so UI lists only usable catalog
poses. `getAvatarPose(...)` returns the raw catalog artifact, while
`getResolvedAvatarPose(...)` returns a parent-free clone from a cached resolved
catalog path so per-frame clip playback does not repeatedly walk parent
chains. `getAvatarPoseClip(...)` returns a fresh copy of a Gesture clip; a file
in another clip format is skipped with the unsupported-format warning. The clip
id is the Included folder name; the
default pose is `relaxedRest`. There is no frontend copy of Included clips:
the Vite dev server allows `content/included` (`server.fs.allow`), the
development web container mounts it at `/content/included`, and the
production image copies it before the web build.

Reaction clips are loaded separately from `content/included/reactions/` by file
name. The built-in catalog contains 168 files: for each `TRACKED_EMOTIONS`
value from `src/frontend/web/src/lib/emotion`, `<emotion>-1` at intensity 1
and `<emotion>-<intensity>` with a second `<emotion>-<intensity>-b` at
intensities 2–4. Like a new Anima's starter pools, each built-in cell's pool
holds the Included Reactions its ids name (`groupIncludedReactionPools` in
`lib/avatar/reactionPools.ts`). Anima routes play the Anima's own pools
instead. Reaction clips are not in the Gesture clip
catalog, do not run through `Avatar.playClip(...)`, and are skipped
if channel analysis finds any humanoid transforms. This strict authoring rule
applies to Included and Local Reaction entries. Playback projects Reaction
sequences to expressions/events and defensively ignores humanoid samples.
Selection is per cell: exact tracked emotion tones and intensities 1–4
pick from the cell's pool, while `neutral`, blank, unknown values, and group
names such as `alarm` produce no clip. The clips are
playback-scoped to same-run `talking`, so a single peak expression or VFX event
can hold without looping or replaying SFX. Included Reactions follow the
[Reaction ladder](../../../content/included/README.md#reactions): a
full-strength expression at intensity 1, then Avatar Effects at 2, a Particle
Effect at 3 and a Scene Effect at 4, where the first Reaction plays its
emotion's `scene-vfx-emotion-<emotion>` background and the `-b` Reaction
another Scene. The `presentation.disable_vfx` preference suppresses
clip-owned avatar, scene, and particle VFX from pose/reaction playback while
leaving SFX and manual/debug VFX controls unchanged.

The Included Pose collection contains Relaxed Rest, Shy Finger Poke 1 and 2,
and Thinking Head Scratch 1 and 2. `relaxedRest` retains resolved transforms
for every `VRMHumanBoneList` bone, including identity anchors for sparse
child poses. Other shipped gestures own their pose snapshots inside their
clips; they do not require extra discoverable Pose items. A clip whose former
base pose is absent carries those base values in each local pose snapshot.

Runtime pose application checks `vrm.meta.metaVersion` through `isVrm0(...)`.
VRM 1.x models use the catalog's normalized rotations unchanged. VRM 0.x models
use `retargetPoseForVrm0(...)` and `retargetClipSampleForVrm0(...)` at the
runtime application boundary, treating the built-in JSON pose catalog as VRM
1-authored data and converting it into the VRM 0 normalized basis before
`setNormalizedPose(...)`. The conversion flips authored position X/Z values and
conjugates quaternion rotations with the equivalent `[-x, y, -z, w]` component
mapping. The conversion is centralized in
`poses/poseRetargeting.ts` without changing the `animaPose/1.0` or Anima Pose
Clip schemas.

Procedural layers that write authored bone offsets (breathing, sway, bounce,
head nod, head side tilt, talking hands and emotion posture) are also
VRM 1-authored. `ProceduralAnimationController` passes `isVrm0` to each layer,
and the layers apply the same conversion through
`retargetVrm1AuthoredQuaternionOffsetToVrm0(...)` and
`retargetVrm1AuthoredPositionOffsetToVrm0(...)` before writing to normalized bones.
Geometry-derived axes, such as the talking-hands forearm twist, are already in
the model's frame and are not converted.

Expression names are canonical VRM 1 preset names (`happy`, `surprised`, `aa`, ...).
three-vrm maps VRM 0 presets, but VRM 0 has no `surprised` slot, so VRoid exports
it as a custom expression named `Surprised`. After loading, `Avatar` calls
`canonicalizeCustomPresetExpressions(...)` to re-register such custom expressions
under the matching preset name when the model, of either version, does not
already bind that preset. Content and creator pickers therefore use one name across VRM versions.

Typed Gesture and Reaction editors reuse the shared timeline, pose, expression,
and preview primitives through their product routes. They keep an editable
client document and resolve its component dependencies into an editor-owned
sandbox. Playback belongs to the timeline Play/Pause/Stop/Restart controls and
does not persist the Action. Save sends the sequence or VRMA file and its
descriptor through `saveCatalogItem(...)` to the typed catalog Save endpoint.
Updates include the catalog item ID and expected revision; the backend validates
and atomically updates readable Local files. Save & Equip saves, then opens the
equip dialog for the saved catalog item, whose changes apply at once (see
[Library Add and Manage](../features/library.md#add-and-manage)). Existing and
starter Actions use typed preview reads to hydrate protected files and
dependency runtime.

A Local Action that names a removed Included effect still opens and plays
without it (see the catalog exception in
[the data model](../../backend/architecture/data-model.md)). The editor warns
which effects were removed, does not declare them again, and lists their
events as unknown event IDs, so Save waits until they are mapped to other
effects or removed. In chat, `AnimaRuntimeCatalog` skips those events
(`runtime_missing_references`) with a `missing_effect_dependency` diagnostic,
and the Library's content-attention list names the Action.

Gesture Pose mode's Hands tool edits ordinary finger-bone drafts. Presets replace
the chosen whole hand(s); Curl and Spread apply relative deltas to selected
segments. Returning a control to zero after release leaves the pose unchanged.
Both adjusts each hand from its own current values independently of the
single-bone mirror option. Selection and tool visibility are transient; Save
uses the existing pose contract without helper metadata.

While a clip beat is edited, the Hands tool works on hand shapes instead
(`poseCreatorHandInteraction.ts`, `lib/avatar/poses/anatomy/handOffsets.ts`).
A preset records that side's shape for the edit (Undo includes it); Curl and
Spread adjust the recorded shape, or else the beat's hand key, with offsets
refitted to the fingers as shown so earlier bone edits are kept. Over every
eligible segment of a hand they change the shape's relative `curl` or
`spread`; over some segments, those segments' `fingers` offsets. Only selected
segments move, and they show exactly what the shape plays. Selected bones the
shape does not drive (their own tracks, or an earlier edit offsets cannot
carry, such as a twisted finger) turn as bones, as they do on a hand without
hand keys and no preset chosen. Applying the edit writes the shape as the
beat's hand key (below).

Gesture and Reaction clips open as beats, shown as keyframes on the Pose (or
Expression) lane and named by their labels; the draft keeps the clip's tracks
as their source (`poseCreatorClipMotion.ts`, operations in
`lib/avatar/poses/animaPoseClip/beatEditing.ts`). A new document starts with
no beats. Opening or importing a clip in another format, such as the retired
`animaPoseClip/1.0`, fails with the unsupported-format message instead of
opening an empty timeline. A beat that owns generated
detail (keys away from its own time) shows a dot in its diamond, and the
keyframe inspector shows a read-only note on how far that detail reaches. The
inspector's Label field renames the beat; its Easing sets how motion arrives
at all of the beat's keys. Editing follows the beat:

- moving a beat (drag or Time) moves its keys with it; the facing detail of
  neighbouring beats stretches or compresses with the gap, a beat with detail
  stops before it would pass a neighbour, and beats without detail may pass
  other beats without detail;
- a Pose tab edit applies to the beat: a changed joint's keys owned by the beat
  shift by the change (so overshoots ride along), untouched joints keep their
  keys, bones the edit resets return to the base pose and cleared expressions
  to 0, and bones without tracks gain a track keyed at every beat (other
  beats hold the rotation the clip authors there);
- the edit starts from the beat as the creator Avatar plays it, solved
  contacts included. An arm a solved contact places takes the edit as the
  same local change of its authored rotation (`relativeToPlayback` in
  `setBeatPose`), so forearm, wrist and upper-arm swivel changes persist when
  playback solves again, while the solve still decides how far the arm
  reaches. One Avatar's solve is never written into the clip or other beats.
  The inline editor does not solve live: dragging a solved arm moves the hand
  off its target until the edit is applied;
- hands keep their hand keys (`setBeatHand` in `beatEditing.ts`). A Hands-tool
  shape replaces the beat's own key (`dt` 0), or adds one; on a hand without
  keys, every other beat first gets a key holding its current hand (the
  simplest preset with offsets that fits). Finger-bone edits of a hand with
  keys become `fingers` offsets on the beat's key, read against its preset,
  Curl and Spread as fitted on the editing Avatar; a beat without its own key
  gets one with the nearest key's preset, Curl and Spread (across a loop's
  seam) and offsets for the whole hand as shown. Between two different keys
  the shown hand is a blend that offsets only approximate, so its fingers
  there can move by a few degrees. Keys at other beats are untouched. An edit
  is judged by the change it makes, not by that approximation: one that turns
  what offsets do not carry by more than 0.5° (finger twist, splay or
  abduction past the proximal segment) or needs offsets beyond ±90° gets a
  joint track for that bone, and a thumb metacarpal edit a rotation
  track, keyed at every hand key of that side with the values played there
  now, so the hand elsewhere is unchanged; the key keeps the closest offsets
  for such a bone. Bones that already have tracks are edited as tracks;
- deleting a beat removes all of its keys; capturing at the playhead adds a
  beat holding the current motion, and inserting a Library Pose adds (or
  re-poses) a beat with the pose by value, its omitted bones at the base pose,
  then freezes the base pose into the tracks and removes the reference
  (`detachBasePose`) in the same undoable edit;
- Start and End base add Base beats holding the base pose, which follow a Base
  pose change (an authored beat already at that end is kept).

Save, Clip JSON and project export write `animaPoseClip/2.0`. A timeline whose
beats hold no keys, such as Base
beats alone, cannot be saved, because a 2.0 clip needs a track key or event.

`CreatorTimeline` supplies controlled transport and track presentation to Gesture,
Reaction and all three VFX creators. Each editor retains its own playback owner:
Particle exposes its elapsed preview clock, while Avatar/Scene rulers show saved
lifetime configuration without seeking or an elapsed playhead. Avatar's run-end
buffer starts after a conversation run; it is not a standalone preview deadline.

Agents author Gestures directly as `animaPoseClip/2.0` clips. Commands run
from `src/frontend/web`:

- `pnpm -s animation joints` lists joints, components and ranges.
- `pnpm -s animation validate <clip.json> [--out <compact.json>]` reports
  structural problems and values beyond anatomical limits by JSON path and the
  saved size; `--out` writes the compact saved form only when valid.
- `pnpm -s animation check <clip.json>` runs motion checks on both Included
  Avatars, each with its own prepared clip; a 2.0 clip supplies its contacts
  and `plantFeet`.
- `pnpm -s animation:render <clip.json> --out <dir>` draws review sheets.
  `--avatar-file <a.vrm>` draws them on that VRM instead of the Included
  Avatars, for example a converted Avatar kept outside the repository; keep
  its sheets outside the repository too. On a big-headed Avatar the body and
  face views frame the measured head ([Size-aware
  placement](avatar-vfx.md#size-aware-placement)); the `--view hands`
  close-ups keep their distance from the head bone's height, so where a
  chibi's hands meet its large head they can show only skin or clothing.
- `pnpm -s animation:reel --gestures|--reactions|--effects [<source>...] --out <file.mp4>`
  records a 1920×1080, 30 fps video of every Included Gesture, Reaction (by
  emotion, then intensity) or Avatar, Particle and Scene Effect
  (`--avatar-effects`, `--particle-effects` or `--scene-effects` for one
  kind), or the named sources, one at a time on Annie (`--avatar andrew` for
  Andrew). Each clip plays through the Avatar's own clip player with its
  Avatar, Particle and Scene Effects and its sounds. An effect plays for
  `--hold` seconds (default 3) from a one-event clip, as an Action event
  would play it, with its accompanying sound. A
  corner label names the item (a Reaction with its emotion, intensity label
  and the model intensities that play it) and its effects, lighting each
  while it is active and each sound while it plays, and lists the Avatar's
  live expression weights; the video has a chapter per item. A
  loop plays one pass, and a talking-scoped Reaction is held for `--talk`
  seconds (default 3, at least until its timed effects end) as chat holds it
  while the Anima speaks. Sounds come from local `sound_effect` sidecars, by
  default the private [comedy sound pack](../../backend/operations/comedy-sound-pack.md)
  under `build-inputs/wow-comedy-sfx`; a worktree passes the primary
  checkout's copy with `--sounds`, and without one the reel is silent. A reel
  with pack sounds contains licensed audio, so keep it out of Git and public
  channels. Requires `ffmpeg` with libx264. Frames render on the GPU on macOS
  (about real time) and with SwiftShader elsewhere.
  - `--sheet <takes.json>` (repeatable) records scripted takes for trailers
    and reviews; the format is documented in
    `web/scripts/animation-reel-sheet.mjs`. A take lists Gesture and Reaction
    cues on its own clock: a Gesture plays on the clip player and a Reaction
    on the reaction layer beside it, as chat plays them together. A Gesture
    can start part-way through (`from` a clip time or beat id), or `beat` and
    `beatAt` land a named beat on a take time; events still running at the
    start point restart there, and earlier sounds are dropped. `until` stops
    a clip with its fade; without it a talking-scoped Reaction is held for
    `--talk` seconds or, in a take that speaks, until the speech ends. A take
    may also speak a recorded voice take:
    `speech` names the audio and its ElevenLabs `with-timestamps` response
    (or alignment). The app's lip-sync planner plans the whole take at once,
    and the take drives the mouth, tag expressions, speech gesture timeline
    and talking hands as chat does, with talking hands off while a Gesture
    plays. `shaping` picks viseme presets or ARKit mouth mixes, `gain`
    widens the mouth and `lead` moves it ahead of the sound (the planned
    mouth peaks about a frame after the audio). `face` cues add expression
    weights over the face for a window, ramping in and out, and `mood` cues
    set the feelings chat would report, which drive the emotion face and
    posture. A take can set its own `avatar`, `camera` and `duration`.
    `enter` replaces a Gesture cue's own fade-in. A `vrma` cue plays a VRM
    Animation file as the app plays a VRMA Gesture, and a take's `root` keys
    move the Avatar on the floor. A camera can also stand still at a
    `position` and `target` in metres, or ease between timed `keys`, so
    several takes share one scene and their layers stack.
  - `--avatar-file <file.vrm>` reads a local VRM in place (lilToon included);
    keep third-party Avatars and their reels out of the repository.
  - `--camera pip` frames the desktop PiP window's default preset (record at
    its 3:4 shape, such as `--size 1080x1440`), `--camera face` a face
    close-up that follows the head; `--camera landing` the landing
    page hero close-up and `landing:<stop>` any landing stop, using its tall
    framing when the frame is narrower than 4:5.
  - `--out` picks the format: `.mp4` (H.264 with the label, `--no-label` to
    hide it), `.mov` (ProRes 4444 with alpha) or a folder of PNG frames with
    alpha plus `audio.wav` and `takes.json` (frame ranges). The alpha formats
    have no label and a transparent background (Scene Effects still draw);
    `--background <css>` sets one for any format. ProRes needs `ffmpeg` with
    `prores_ks`.
- `pnpm -s animation:combo [--avatar-file <file.vrm>]... [--avatar annie|andrew]... [--port <n>] [--no-open]`
  (both Included Avatars by default) opens a live page for trying combinations before recording them: pick any
  Included Gesture (optionally from a beat) and Reaction, with start delays
  and a Reaction hold, and play them together on the chosen Avatar as chat
  does, with their effects but no sounds. Ticked Included Avatar Effects stay
  on over them and ticked Particle Effects replay whenever they end; both
  share the app's effect limits with the clips' own effects, so the page can
  drop a clip particle the recording would keep. The expression panel lists every
  expression and ARKit shape the Avatar has with its live weight, and its
  sliders add weight over the face. "Copy cue sheet" gives the setup as an
  `animation:reel --sheet` take (Gesture, Reaction and face cues, the Avatar
  file and camera; ticked effects are not part of it). Avatar files are read in place, and the page writes
  nothing.
- `pnpm -s content:tune` opens the owner's tuning page for Included Gestures
  and the Reaction ladder (see [Tuning Included content](#tuning-included-content)).
- `pnpm -s animation:save <items.json>` saves clips as Local Gestures through
  the Gesture creator in a headless browser, revising an existing Local
  Gesture with the same Selector ID. An optional `project` path (absolute or
  relative to the items file) imports its sequence and dependencies instead
  of `clip`, resolving Local and Included effect refs against the running
  Library and replacing dependencies on revisions too; name, AI description
  and Selector ID still come from the item.
- `pnpm -s animation:preview [<source>]` plays a clip, project file or Library
  item live on both Included Avatars through `Avatar`/`PoseController`, lit
  like the chat canvas, with the chat's Scene layers around each view. A
  Library Gesture or Reaction, or a project file, plays its Avatar, Particle
  and Scene Effects from its dependencies, with their fades; seeking such a
  clip replays it from the start so earlier effects show. Sounds are not
  played, and the page says so. It also previews Avatar, Particle and Scene
  Effect sources (see the [Avatar VFX guide](avatar-vfx.md#headed-preview)).
  Its Review and Compare pickers switch to any clip beside a file source and
  any Library Gesture, Reaction or effect without a restart; Prev and Next
  (or `[` and `]`) step through the Review item's picker group, such as a
  folder of drafts, and show its position. Review notes are saved beside a
  file source (in the working directory for a Library item or any file inside
  Library content); `animation review` and `animation resolve` manage them.

The workflow, conventions and review guidance live in the
`animama-animation` agent skill. The code is in
`src/lib/avatar/motion-authoring/`. Clips live only as content: drafts in the
ignored `.animama-drafts/` folder until saved, then Local items in
`content/local/`, and owner-approved Gestures in `content/included/` (through
`pnpm -s animation promote`). The earlier `animamaMotion/1` description format and its bake step are
retired; the tools explain this when given a description.

There is no separate generic Pose Creator route or raw package save provider.
Clip JSON is `animaPoseClip/2.0`; a separate versioned project envelope
(`animamaActionProject/1.0`) carries the name, AI description, Selector ID and
typed effect/sound dependencies with the sequence. Import accepts either
format; the sequence must be `animaPoseClip/2.0`.

For an Action implemented by an Anima Pose Clip, the Action display name is
the authoritative authoring name. The embedded clip `name` matches it, and the
clip `id` is its normalized lowercase ASCII kebab-case form. Creator rename,
load, import, JSON export, and Save boundaries all reapply this invariant, so
generic timeline identities such as `pose_creator_clip` cannot leak into newly
saved Gesture or Reaction files.

Saving updates the Local catalog item. It does not advance immutable releases
or hot-swap a mounted chat: active chats retain their prepared bytes until
reopened. See [Local content runtime](../architecture/local-content-runtime.md)
for revision checks, preparation, and recovery behavior.

#### Tuning Included content

`pnpm -s content:tune` (from `src/frontend/web`) opens a local page, served
on 127.0.0.1 only, for the owner to review and change Included Gestures and
Reactions. It is not part of any build.

- **Lists:** every Included Gesture, and the Reaction ladder as a grid of
  emotions by intensity. Each cell shows its Reactions' effect counts, peak
  expression weights and sounds, and outlines departures from the ladder
  guidance.
- **Sounds tab:** auditions the WOW Sound catalog.
  - `--catalog <dir>` (or `ANIMAMA_WOW_SOUND_CATALOG`) names the vendor
    folder, with category subfolders of `AC_*.ogg` files.
  - `--sounds <dir>` names the comedy pack (default
    `build-inputs/wow-comedy-sfx`; a worktree passes the primary checkout's
    copy).
  - Sounds in the tracked pack manifest are marked "In pack".
  - Licensed audio is streamed from those folders and never copied.
- **Preview:** plays the selected item, as edited, on Annie
  (`--avatar andrew` for Andrew) in real time through the review stage,
  with its effects and sounds.
- **Editing:**
  - Add, remove or replace effect events (Avatar, Particle, Scene) and `sfx`
    sound events, and change their times.
  - Change a sound's volume, mute an Avatar Effect's accompanying sound, or
    change a Particle Effect's duration.
  - Set a Reaction's peak expression weights.
  - Place an Avatar Effect for one event with the Action creator's "This
    use" controls (an `override`, ADR 0025). For an effect that declares
    several sounds, the same panel picks which one this use plays.
  - Change an Avatar Effect's own sound (its "effect sound" under an event)
    for every Gesture and Reaction that uses it. The control shows how many
    use it. A new sound replaces the effect's default edge under the same
    alias; a sound the effect already declares becomes its default; a
    silent effect gains an optional `on-apply` edge. "No sound" removes a
    single sound; it isn't offered for a merged effect (several sounds), and
    is refused while a use picks that sound. The change is applied and saved
    like any other edit, and the preview and placement panel show it once
    applied.
  - Every sound dropdown entry can be previewed before it is picked.
- **Apply and Save all:**
  - **Apply** keeps an item's edits as a draft in the browser's local
    storage, marked "applied, not saved" in the lists. It doesn't write
    files or reload the editor or preview. Applied drafts survive switching
    items, reloading the page and restarting `content:tune` on the same port
    (default 4791). Drafts are kept per port and per checkout, so another
    worktree's page has its own. **Discard applied** (per item) and
    **Discard all** drop them.
  - **Save all** writes every applied item's clip and `.meta.json` in
    `content/included` together. If any item is refused, nothing is
    written. If a file rename fails partway, the error names the files
    already replaced; `git restore` recovers them.
- **Proposals:** `--proposals <file>` loads suggested edits for review, each
  applied once as a draft, so they show as "applied, not saved". The file is
  JSON. `items` maps a Gesture or Reaction content ID to
  `{ "note", "add": [{ "time", "sound", "volume"? }] }`, where `sound` is a
  catalog sound ID. `effects` maps an Avatar Effect content ID to
  `{ "note", "sound" }`, where `null` makes it silent. An item's note shows
  on the item; effect proposals are listed at the top with their notes. Keep
  a proposal with Save all, or drop it with **Discard applied**. A discarded
  or saved proposal isn't applied again unless its sounds change (not its
  note); a changed one is applied on top of the file as it is then. A
  proposal for an item that already has an applied edit waits until that
  edit is saved or discarded, then applies on the next load. Proposals that
  can't be applied (malformed entry, unknown item or sound) are listed at
  the top. Keep proposal files outside Git, for example under
  `.animama-drafts/`.
- **Saving rules:**
  - It rebuilds the dependencies from the events (unused edges drop) and
    writes pack sounds as optional edges.
  - It keeps the content ID, version and clip identity, and keeps the clip
    file's form.
  - It refuses audible events under 0.3 s apart, sounds on starter idle
    Gestures, an invalid clip, and a file changed since its edit was applied
    (discard and redo that edit).
- **After saving:**
  - A changed Gesture clip needs its sample baseline updated: add the slug
    to `REBASELINED` in
    `src/lib/avatar/motion-authoring/includedClipBaseline.test.ts`, then run
    `UPDATE_CLIP_BASELINE=1 pnpm exec vitest run src/lib/avatar/motion-authoring/includedClipBaseline.test.ts`.
  - A sound not yet in the pack needs a new pack version before the content
    merges (see the [comedy sound pack](../../backend/operations/comedy-sound-pack.md)).
    `pnpm -s content:tune --pending` lists the sounds to add or remove; the
    Included-content tests fail until the pack matches.
  - Re-record the changed items with `pnpm -s animation:reel`, run the
    backend Included-content tests, and ship the edits in their own PR. Edits
    to Reactions in starter pools also need the full browser journeys.

### `AvatarPlanner`

`web/src/lib/avatar/planner/AvatarPlanner.ts` chooses autonomous motion,
procedural and reaction actions from interaction phase, emotion and run-scoped
events. `Avatar` executes those actions. See [Avatar Planner](avatar-planner.md)
for lane ownership, idle timing, talking-motion arbitration and transition rules.

### `ExpressionController`

File: `src/frontend/web/src/lib/avatar/ExpressionController.ts`

Responsibilities:

- Manage expression weights and transitions.
- Apply emotion presets by intensity (`EMOTION_INTENSITY_MAP`).
- Run auto-blink.
- Provide lip-sync timeline APIs (segment/frame registration, sampling, interpolation, decay).

Important behavior:

- Emotion weights fade toward targets over time (`EMOTION_FADE_SPEED`).
- Blink is auto-driven while respecting emotion-provided baseline blink. The
  blink scheduler samples a non-zero, center-biased open wait bounded by
  `BLINK_OPEN_MAX`, eases eyelids closed and open, randomizes the fully closed
  hold with `BLINK_CLOSE_MAX`, and occasionally schedules shorter partial
  follow-up blinks.
- Eyelid closure correction (`eyelidClosure.ts`, installed by `Avatar.load`):
  VRM morphs add up, and on VRoid faces `happy` already closes the eyelids
  while `relaxed` partly does, so blink on top deformed the lids past shut.
  At every expression-manager update, `blink`, `blinkLeft` and `blinkRight`
  are multiplied by `clamp01(1 − happy − k × relaxed)` through three-vrm's
  `overrideBlinkAmount`. Expression weights keep their composed values
  (inspectors, `getValue`), and every path that updates the manager — chat,
  creator writes, previews and review renders — gets the same correction.
  The profile is chosen by the VRM's `vrmSha256`: verified for Annie (k 0.2164).
  Other VRoid faces (with VRoid eye parts of their own), including Andrew, get
  happy 1 / k 0.2 for each of happy and relaxed whose morphs measurably move
  blink's vertices closed, and nothing otherwise. Other models are measured
  instead ([Faces on non-VRoid Avatars](avatar-emotion.md#faces-on-non-vroid-avatars)). VRoid's eye parts `Fcl_EYE_Joy` and
  `Fcl_EYE_Fun` carry all of happy's and relaxed's eyelid motion, so they take
  the same factors; the correction registers them from the face's morph
  targets when a VRM 0 file has no expressions for them. An expression with a
  native `overrideBlink` keeps it uncorrected. Load paths that know the model digest must pass it;
  the review harness pages hash their Avatar files for parity.
- Morph targets become expressions: every morph-target name is registered as
  an expression of the same name (case-sensitive) unless the file already has
  one. ARKit face shapes are also registered under their canonical ARKit names
  (see below).
- Lip-sync has:
  - segment scheduling by audio start,
  - interpolation between frames,
  - transition blending between segments,
  - post-segment decay back to neutral.

See [Avatar lip-sync](avatar-lipsync.md) for how each reply's mouth is planned.

#### ARKit face shapes

Avatars made for VRChat or face tracking often carry Apple's 52 ARKit face
shapes under their own spelling. At construction, `ExpressionController`
resolves them from each mesh's morph-target names (`arkitFaceCapability.ts`)
and registers each found shape under its canonical name from `arkit.ts`, bound
to every mesh's own spelling: `mouthSmileLeft` drives the face's
`MouthSmile_L` and the teeth's `mouthSmileLeft`. Matching on each mesh, in
order of preference:

1. the exact canonical name, then a case-insensitive match;
2. the same words with separators, camel case and the side token ignored:
   `_L`/`_R`, `.L`/`.R`, `Left`/`Right`, also mid-name as in SRanipal's
   `Eye_Left_Blink`;
3. a face-tracking alias for shapes whose words differ, such as Unified
   Expressions' `EyeClosedLeft` (`eyeBlinkLeft`) or `MouthCornerPullLeft`
   (`mouthSmileLeft`). The table is `FACE_TRACKING_ALIASES`.

An unsided ARKit shape such as `browInnerUp` or `cheekPuff` that an Avatar
splits into halves binds both. Several equally good candidates leave the shape
unresolved on that mesh, and the controller logs them as ambiguous. A name the
file already uses for an expression keeps that expression.
`getArkitFaceCapability()` returns the resolved shapes, the missing ones and the
ambiguous candidates. `getAvailableExpressions()` lists each resolved shape
once, under its canonical name. Each mood region whose shapes the Avatar has
also plays an ARKit mix, after the Avatar's own VRoid parts and standard MMD
morphs; see [Faces on non-VRoid Avatars](avatar-emotion.md#faces-on-non-vroid-avatars).

`pnpm -s vrm:inspect <file.vrm>` (from `src/frontend/web`) reports the same
resolution for a file before import, including shapes found under another
spelling, ARKit-named expressions the file authors itself, and whether
Animama will play the Avatar's faces as ARKit mixes, where each blink and
viseme preset comes from, and the face parts detection finds after the
load-time installs (`prepareLoadedVrm`). It also reports
the VRM version, extensions, materials, images, and each mesh's size and
morph-target names with where they are stored. three.js reads only mesh-level
`extras.targetNames`; every Avatar loader (`configureAvatarGltfLoader`) also
applies names some exporters store per primitive when all of a mesh's
primitives agree (`primitiveTargetNames.ts`). A mesh whose primitives disagree
("primitives, mismatched") loads unnamed, and Diagnostics reports it from the
file (`morph_target_names_mismatched`). Add `--json` for the full report.

### `ProceduralAnimationController`

File: `src/frontend/web/src/lib/avatar/ProceduralAnimationController.ts`
Layer files: `src/frontend/web/src/lib/avatar/proc-animation/*`

Responsibilities:

- Own optional code-generated animation layers that run alongside VRMA clips.
- Clear prior-frame additive offsets before the mixer writes the next pose.
- Apply procedural layers after the mixer writes the base pose.
- Manage smooth layer activation/deactivation for manual debug controls and
  planner-owned policy actions.
- Forward per-frame speech timing from the canvas actor to layers that need
  real audio playback windows.

Important behavior:

Current layers include breathing, idle sway, bounce, listening head nods,
curious head-side tilt, idle cursor look-at, talking-hands gestures, and
emotion posture. The `cursorLookAt` layer owns `vrm.lookAt.target` while
active; `ExpressionController` does not install a camera-owned look-at target.
Cursor look-at normalizes pointer coordinates against the active WebGL canvas,
measures movement from the camera-projected look-at origin at the eyes, mirrors
horizontal cursor offsets for VRM0 `faceFront = -Z`, and keeps VRM1 neutral
gaze from depending on raw window center. The same smoothed target delta also
drives conservative additive head, neck, and torso follow offsets, with
separate visual-axis compensation for VRM0 horizontal body yaw and VRM1
vertical body pitch.
In native Desktop PiP, the layer can receive an Electron global-cursor provider
instead of DOM `pointermove`; this lets the PiP avatar follow the desktop cursor
outside the PiP window and while Anima is unfocused, while preserving the same
idle-only tracking windows and calibrated mapping.

Default activation policy:

- `breathing` is enabled by default.
- `sway` is enabled by default, but only contributes visible motion during idle
  windows. The current default requests 10 seconds of sway about every 60
  seconds with 2.0 second enter and 2.4 second exit blends.
- `headSideTilt` is enabled by default as scheduled curious motion.
- `cursorLookAt` is enabled by default, but only contributes while idle and
  inside its tracking windows.
- `bounce`, `headNod`, `talkingHands`, and `emotionPosture` are disabled by
  default. The avatar planner can policy-enable `bounce` or `headNod` during
  listening, `talkingHands` during talking after no-hint emotion arbitration
  or once the run's gesture has finished,
  and `emotionPosture` whenever the dominant emotion group is `gloom`,
  `revulsion`, or `rejection` with an enabled level 1-3 posture preset. The
  controller executes those actions and
  disables planner-owned activations again when policy no longer wants them;
  manually enabled debug layers are left alone.

Procedural offsets are frame-local. `Avatar.update(...)` clears each layer's
previous additive offsets before the mixer writes the clip pose, then active
layers rebuild their offsets after clip animation for that frame.

Debug controls in the animation debug modal tune procedural parameters at
runtime. They do not persist defaults by themselves.

#### Emotion posture procedural layer

- File: `src/frontend/web/src/lib/avatar/proc-animation/EmotionPostureProceduralAnimationLayer.ts`
- Params: `src/frontend/web/src/lib/avatar/proc-animation/types.ts`
- Debug UI: `src/frontend/web/src/ui/debug/AnimationDebugModal.tsx`

The `emotionPosture` layer is a single additive posture layer for emotion body
language. It resolves the avatar's dominant emotion group from the full
`EmotionRuntimeState`, chooses that group's level 1, 2, or 3 posture intensity,
scales the group's single authored posture target by that intensity, and blends
head, neck, torso, and shoulder offsets toward the scaled target. Neutral
emotion state, intensity level 0, a disabled global planner gate, or a disabled
dominant-group preset resolves to no posture target.

Posture targets are authored in the same VRM1-style basis used by
`PoseController` catalog poses: VRM1 faces +Z, so positive local X pitch bends
the torso/head forward and negative local X pitch opens or leans back. VRM0
models receive the shared procedural-layer conversion described in the pose
retargeting section.

The supported default presets are Gloom, Revulsion, and Rejection. Gloom is the
clearest preset: disappointment, grief, and sadness lower the head, round the
upper body, and droop the shoulders more strongly as the emotion level rises.
Revulsion uses a pronounced recoil and turn-away posture for disgust,
embarrassment, and remorse. Rejection uses a strong forward, squared posture for
anger, annoyance, and disapproval. Other dominant emotion groups do not drive
posture.

By default, Gloom scales its single target at 0.3 for level 1, 0.5 for level 2,
and 0.7 for level 3. Revulsion scales at 0.15, 0.30, and 0.45. Rejection scales
at 0.20, 0.30, and 0.40. The debug modal can tune those per-group level
intensities directly.

The animation debug modal has an `Emotion Posture` section with:

- a planner gate, live runtime enabled toggle, and debug mode override,
- enter blend and exit blend sliders,
- supported-group preset toggles and level-intensity sliders,
- a single target editor for each supported posture group,
- the currently resolved group, level, primary emotion, reason, selected level
  intensity, effective activation intensity, active target, and blended current
  target.

`Planner gate` controls whether `AvatarPlanner` is allowed to automatically
enable emotion posture from the live emotion state. `Runtime enabled` is the
current layer activation flag itself; toggling it manually takes the layer out
of planner ownership like other procedural debug controls. `Debug mode`
temporarily enables the layer and resolves posture from the selected debug
group and level instead of the live avatar emotion state. Turning debug mode
off disables that manual layer activation so normal planner ownership can
resume if the live emotion state still qualifies.

#### Talking-hands procedural layer

- File: `src/frontend/web/src/lib/avatar/proc-animation/TalkingHandsProceduralAnimationLayer.ts`
- Params: `src/frontend/web/src/lib/avatar/proc-animation/types.ts`
- Debug UI: `src/frontend/web/src/ui/debug/AnimationDebugModal.tsx`

The `talkingHands` layer is an additive procedural gesture scheduler for
speech. It does not own the avatar's static relaxed arms-down pose; that
base comes from the active `PoseController` catalog pose, usually the
explicitly applied default `relaxedRest` pose. Talking hands contributes
temporary offsets on top of the current clip/rest pose while the layer is
active.

Activation:

- The layer default is `enabled=false`.
- `AvatarPlanner` can request policy enablement while `avatarState="talking"`;
  it does so after same-run emotion arbitration confirms no primary-chat
  gesture request has claimed talking motion, or after the run's gesture has
  finished (including its exit fade) while the reply is still talking. `ProceduralAnimationController`
  owns the activation blend and offsets.
- The animation debug modal exposes a one-shot Play control instead of a
  persistent talking-hands toggle. Pressing Play enables the layer if needed
  and restarts a single randomized group using the current slider values.
- The Talking Hands debug section also shows the last live TTS speech-plan
  diagnostics, including chunk decisions, selected pulse apexes, and skipped
  beat reasons. When the last plan is playable, Replay TTS replays that same
  speech-planned group without requiring a new chat response. The last
  speech-plan diagnostics remain visible after the chat turn ends and the
  policy-enabled layer deactivates.
- The same section exposes live TTS timing controls for minimum primary-stress
  beat spacing, gesture entry, entry grace, gesture return, pulse attack, pulse
  release, and the ordinary sentence-chunk skip chance.
- When the layer is disabled or its weight/intensity reaches zero, it clears
  its additive offsets and scheduled playback state.
- During deactivation, the controller stops the layer from starting new gesture
  groups; current offsets fade through the generic layer activation weight.
- While `avatarState="talking"`, gesture groups require a speech timing context
  from Pocket TTS, ElevenLabs or Gemini audio playback. Browser TTS does not currently
  provide this audio-clock timing context, so policy activation alone is not
  enough to start talking-hands groups.
- If talking hands are enabled after speech audio has already started, the
  layer uses the live speech timing context and skips elapsed beats rather than
  replaying earlier hand motion.
- Manual debug animation outside `avatarState="talking"` still runs without
  live TTS timing.

Execution paths:

- Debug Play samples one randomized group immediately, using `gestureDurationSec / speed`.
  Entry/middle/return proportions are approximately 28%/44%/28%.
- Live TTS schedules pulse apexes against primary-stress beats for the active run.
  Replay TTS reuses that speech plan. It uses beat spacing rather than randomized
  micro-pauses; `pulseScale` is fixed at `1`.
- Both paths sample elbow, palm and rest-jitter values per group and finger,
  thumb, hand-flex and secondary-twist variation per pulse.

Scheduling model:

- The layer plays one group at a time. It does not autonomously alternate
  pauses and groups.
- Debug Play uses `gestureDurationSec`, scaled by `speed`, as the manual group
  duration. The legacy `pauseMinSec` and `pauseMaxSec` params are kept for
  compatibility but are not used by talking-hands playback.
- In `avatarState="talking"`, the layer waits until speech chunks and a
  speech gesture beat timeline are available, then attempts at most one group
  per eligible chunk. The lip-sync planner's phrases stand in for the chunks.
  Its timeline grows with the audio, so early beats are available before the
  whole reply has played.
- Chunks provide word ranges; the timeline provides beat times on prominent
  syllables (see [Avatar lip-sync](avatar-lipsync.md#talking-hands)). Chunks
  with no beats are skipped automatically.
- Ordinary chunks sample one stable left/right hand for the whole speech
  `runId` and can be skipped by `speechChunkSkipChance`. Exclamation chunks
  with usable beats bypass random skipping and use both hands.
- If duration or timeline data arrives after early beats have passed, those
  beats are skipped without speeding up the remaining gesture. Later usable
  beats in the same chunk can still play.
- Live TTS uses an explicit main gesture envelope. `speechGestureEntrySec`
  controls the neutral-to-first-pulse entry stroke, and
  `speechGestureReturnSec` controls the final return to neutral. Beats that are
  too early for the configured entry envelope, minus
  `speechGestureEntryGraceSec`, are skipped instead of causing a rushed hand
  raise.
- Beat selection uses the chunk/window end as the final beat cutoff, not
  `chunkEnd - speechGestureReturnSec`. If a selected beat lands near the end of
  the chunk, the return envelope starts after that beat and may slightly overrun
  the chunk instead of deleting the beat.
- Micro-pulse apexes are scheduled to land on selected beat times; nearby beats
  hold the base gesture pose between pulses instead of forcing the group to
  reset.
- Manual debug groups choose one-hand or both-hand playback from
  `oneHandChance` and `bothHandsChance`.
- Active elbows sample a base bend from `elbowBendMin..elbowBendMax`.
- Both-hand groups can add `elbowBendAsymmetry`, splitting a sampled signed
  bend difference across left and right hands.
- Elbow side drift samples one signed value from
  `elbowSideDriftMin..elbowSideDriftMax` and mirrors it by side in the apply
  path.
- `shoulderForward` samples a signed shoulder-forward amount up to the
  configured magnitude; `shoulderBeat` follows elbow bend magnitude.
- `palmDirectionRange` samples a signed base palm direction around the inward
  default so the palm can trend downward, inward, or upward on a continuum.

Gesture shape:

- Each group starts at neutral procedural offsets and moves into a stroke.
- If micro motion is active, the stroke target is the first micro pulse rather
  than a separate base-pose stop. This makes gesture entry and the first micro
  movement read as one motion. Live TTS uses the same shape for the first
  selected speech beat through `speechGestureEntrySec`.
- `microEntryBlend` controls how long the first micro pulse settles back into
  the base gesture pose.
- Debug Play schedules `microBendCount` randomized pulse cycles. In live TTS,
  `microBendCount` is the maximum selected speech beats for one TTS chunk
  group; if a chunk has fewer usable beats, the group has fewer pulses.
- Live TTS beat selection enforces `speechBeatMinSpacingSec`, then caps
  selected primary-stress beats to `microBendCount`. Timing and cap skips are
  recorded in speech-plan diagnostics.
- Optional base-pose holds between later pulses are sampled from
  `microBendPauseChance`, `microBendPauseMinSec`, and
  `microBendPauseMaxSec` during debug playback. Live TTS instead lengthens
  holds as needed to wait for the next selected speech beat.
- `speechBeatPulseAttackSec` and `speechBeatPulseReleaseSec` tune later live
  TTS pulse envelopes around selected beat times; the pulse apex remains tied
  to the beat time when enough schedule space is available.
- The return segment eases back to neutral procedural offsets over
  `speechGestureReturnSec` during live TTS. The return duration shapes the exit
  motion; it is not a strict reservation that prevents end-of-chunk beats from
  playing.

Current live TTS timing defaults:

| Param                        | Default | Effect                                                                                              |
| ---------------------------- | ------: | --------------------------------------------------------------------------------------------------- |
| `speechGestureEntrySec`      | `0.56s` | Duration of the neutral-to-first-pulse entry stroke.                                                |
| `speechGestureEntryGraceSec` | `0.08s` | Tolerance that keeps a small frame miss from skipping an otherwise usable first beat.               |
| `speechGestureReturnSec`     | `0.56s` | Duration of the final return to neutral.                                                            |
| `speechBeatMinSpacingSec`    | `0.40s` | Minimum spacing between selected primary-stress beats in a chunk.                                   |
| `speechBeatPulseAttackSec`   | `0.40s` | Maximum lead-in time for later pulses before their beat apex.                                       |
| `speechBeatPulseReleaseSec`  | `0.40s` | Maximum settle time after a pulse before holding the base pose.                                     |
| `speechChunkSkipChance`      |  `0.30` | Random skip chance for ordinary non-exclamation chunks only.                                        |
| `microBendCount`             |     `8` | Exact pulse count for debug Play; maximum selected beat count per live TTS chunk group.             |
| `gestureDurationSec`         | `2.00s` | Manual debug Play duration only; live TTS group timing comes from speech beats and envelope params. |

Speech-plan diagnostics:

- `status` is `ready`, `waiting`, or `skipped`. Waiting means the required
  speech data exists but the first usable beat is still in the future.
- `scope` is usually `chunk` during live TTS. The older `utterance` scope
  remains in the planner/replay types for compatibility.
- `windowEndSec` is the selected chunk/window end used for beat cutoff.
- `returnStartSec` is the planned start of the final return after the selected
  beats are laid out.
- `selectedBeats` are the primary-stress beats that became pulse apexes.
- `pulseApexes` records each beat time, planned apex time, drift, and
  `pulseScale`. `pulseScale` currently remains `1`.
- Chunk skip reasons include `missing_beat_timeline`, `no_primary_beats`,
  `no_usable_beats`, `random_skip`, and `planner_skipped`.
- Beat skip reasons include `too_early_for_gesture_entry`,
  `after_window_end`, `too_close_to_previous_beat`, and
  `exceeds_max_pulse_count`.

Arm, wrist, and palm motion:

- `microBendAmount` adds to the active elbow bend during each micro pulse. In
  the current live TTS planner this amount is multiplied by fixed
  `pulseScale=1`, so selected beats do not yet get stronger/weaker elbow
  pulses from the speech plan.
- `microTwistAmount` applies primary micro twist through the configured
  `microTwistMode`:
  - `forearmRoll`: lower-arm roll only.
  - `forearmRollWithHandFollow`: lower-arm roll plus local hand follow.
  - `handOnly`: hand twist only.
- `secondaryMicroTwistMin..secondaryMicroTwistMax` samples a per-pulse
  secondary twist on `secondaryMicroTwistAxis`, which can be `x`, `y`, or `z`.
- `microHandFlexAmount` is sampled per pulse as a signed maximum. For example,
  `30deg` samples `0..30deg`; `-30deg` samples `-30..0deg`.
- Hand flex uses the same mirrored local hand `Z` axis family as the relaxed
  hand pose and intentionally bypasses rendered-pose lag so the wrist accent
  stays crisp.
- `microHeadNodAmount` rides the same micro-pulse schedule and contributes
  small spine/chest/neck/head offsets.

Finger and thumb motion:

- Rest finger curls are configured independently with
  `restIndexFingerCurlOffset`, `restMiddleFingerCurlOffset`,
  `restRingFingerCurlOffset`, and `restLittleFingerCurlOffset`.
- Thumb rest shape is split across `restThumbCurlOffset`,
  `restThumbMetacarpalCurlOffset`, `restThumbProximalCurlOffset`,
  `restThumbDistalCurlOffset`, and `restThumbSpreadOffset`.
- Rest finger/thumb curl offsets are gesture-scoped. They blend in during
  gesture entry and back out during return for the selected active side or
  sides only. An inactive hand does not receive talking-hands rest curl offsets
  just because the layer is active.
- `restFingerCurlJitter` samples stable per-group rest curl offsets for index,
  middle, ring, and little fingers on active sides. The sampled jitter stays
  fixed for the whole gesture group and blends with the same gesture envelope.
- `microFingerUncurlAmount` drives the main finger release on each micro pulse,
  but the layer samples independent index/middle/ring/little values using
  `microFingerUncurlVariance` so the hand does not open as one rigid shape.
- Thumb uncurl is sampled independently using the effective thumb amount
  `microFingerUncurlAmount + microThumbUncurlAmount`, then varied by
  `microThumbUncurlVariance`.
- `microThumbUnspreadAmount` and the linked finger-release spread signal relax
  the thumb spread during the pulse.
- Finger bones use fixed proximal/intermediate/distal multipliers, then apply
  `fingerLagSec` plus extra proximal-to-distal lag so fingertips trail the base
  knuckles.
- `fingerCascadeLag` scales per-finger timing so index can lead, middle stays
  near baseline timing, and ring/little trail slightly.

Rendered-pose lag:

- The scheduler produces target poses, then a separate rendered pose follows
  those targets.
- `armLagSec` damps elbow, shoulder, and micro head channels.
- `palmLagSec` damps palm direction and twist channels.
- `fingerLagSec` damps finger and thumb channels.
- `microHandFlexAmount` is excluded from this lag path by design.

VRM bone usage:

- The layer uses `@pixiv/three-vrm` normalized humanoid bones rather than raw
  glTF extension traversal.
- Dynamic offsets can target spine/chest/neck/head, shoulder/upper/lower arm,
  hand, thumb, and finger bones when those normalized bones are present.
- Missing optional finger/thumb bones are reported in the debug snapshot and
  skipped rather than throwing.
- Forearm roll resolves a runtime lower-arm-to-hand axis in the target bone's
  local space so the same control can work across VRM0 and VRM1 models.

### `SpringBonePhysicsController`

File: `src/frontend/web/src/lib/avatar/spring-bone/SpringBonePhysicsController.ts`

Responsibilities:

- Own runtime spring-bone tuning for VRM secondary motion.
- Snapshot original spring joint stiffness, gravity, and drag settings.
- Apply debug parameters for gravity, drag, updraft, wind, gusts, and helper
  visibility before three-vrm's update. `Avatar.updateModel(delta)` runs both;
  every per-frame update goes through it (`Avatar.update`, the content
  creators, the Pose creator and review renders), never `vrm.update(delta)`
  directly. Zero-delta `vrm.update(0)` refreshes remain; they never step the
  springs.
- Scale environmental physics per semantic spring-bone profile. Hair receives
  full intensity; named non-hair profiles and unprofiled joints receive the
  conservative fallback intensity unless their profile is tuned.
- Restore cached settings on disable, reset, or dispose.

Current defaults keep spring physics enabled, use a stronger drag multiplier,
apply a subtle updraft, enable gust shaping, and keep helpers hidden.

Each Avatar has a wind setting and a wind strength ([Avatar settings](../features/anima-management.md#avatar-settings)),
applied at load (`AvatarLoadSpec.springMode`, `windStrength`) and live through
`Avatar.setSpringMode` and `Avatar.setWindStrength`. The strength multiplies
wind and the updraft (`SpringBonePhysicsController.setAmbientStrength`; 0
adds none):

- **Automatic** keeps the choice below: ambient forces, except for Avatars
  converted by Mochiya or by Animama Avatar Converter from an MMD model, and
  Avatars whose hair is too soft to hold against them.
- **On** and **Off** force ambient forces on or off
  (`SpringBonePhysicsController.setAmbientForces`).
- **Springs off** also holds every spring joint at its rest rotation.
  three-vrm has no switch for its springs, so `updateModel` calls
  `springBoneManager.reset()` after each `vrm.update`; leaving the mode
  resumes the simulation from rest. `avatarSpringMode.test.ts` pins this
  against the installed three-vrm.

Under Automatic, converted Avatars get no ambient forces: no wind, no updraft
and, at the default gravity multiplier, no zero-gravity baseline. That covers
Avatars converted by Mochiya Avatar Tools, the supported VRChat conversion
route, and MikuMikuDance models converted by Animama Avatar Converter
([MMD model conversion](mmd-model-conversion.md)). `Avatar.load` detects them
by the glTF extension each converter adds to every file it writes,
`MOCHIYA_avatar_composition` or `ANIMAMA_avatar_conversion`
(`springsTunedWithoutAmbientForces`), so detection holds only while a re-export
keeps that extension. The snapshot and the debug panel's Spring Bones section
report it ("Ambient forces: off (converted Avatar)"). Their springs come from
PhysBones tuned with low pull and little gravity, or from MMD's rigid bodies,
both made for a world without ambient forces. VRM-authored hair is stiff enough
to resist the updraft; such springs are not: a hanging ponytail would point
straight up and a skirt would balloon. The drag multiplier still applies.

Under Automatic, an Avatar whose hair the updraft would lift at the chosen
strength also gets no ambient forces (`SpringBonePhysicsController.updraftLiftsHair`,
decided at load and again when the strength changes). Each hair joint (every
joint when none is classified as hair) is read at rest: the updraft as
`update` applies it there, less the joint's authored gravity or the
zero-gravity baseline, against its stiffness. When that net upward pull beats
the stiffness of more than half of them, a hanging strand would turn up, so
Automatic leaves wind and the updraft off. VRM-authored hair, the Included
Avatars' among it, holds; springs tuned for a world without ambient forces,
as on many chibi Avatars, do not. A lower strength can keep them on. Diagnostics
reports the reason. Effective drag never exceeds 1 on any Avatar, because three-vrm's
inertia is 1 − drag; converted PhysBones can author drag up to about 0.86.

Semantic profile behavior:

- `hair` receives the global spring-bone controls at full intensity.
- Named non-hair profiles (`cloth`, `accessory`, `tail`, `ear`, and `chest`)
  and unprofiled or unmapped joints use the conservative half-intensity
  fallback unless a profile override is active.
- Global Spring Bones controls are the shared baseline for all joints and are
  the only controls that affect unprofiled or unmapped joints.
- Semantic profile controls are runtime-only debug overrides layered on top of
  the global defaults for named profiles. They can tune profile intensity and
  per-profile numeric physics values.
- Resetting spring-bone defaults restores authored spring settings and clears
  semantic profile overrides.

Semantic profile assignment:

- Spring bones are identified from VRM spring-bone metadata: VRM 1.0
  `extensions.VRMC_springBone.springs[*].name` and VRM 0.x
  `extensions.VRM.secondaryAnimation.boneGroups[*].comment`.
- Runtime `VRMSpringBoneJoint` instances are mapped back to source glTF node
  indices through parser associations, then classified using spring names,
  comments, and participating joint node names.
- Token matching groups joints into `hair`, `cloth`, `accessory`, `tail`,
  `ear`, or `chest`; missing, ambiguous, or unmapped joints remain unprofiled
  and use the conservative fallback intensity.

Debug visibility:

- The Spring Bones section reports semantic totals, profile counts, unmapped
  joints, low-confidence assignments, and a collapsible per-joint assignment
  table for diagnosing model-specific classification issues.
- Helper visualization draws spring-bone lines as overlay helpers with semantic
  colors and collider helpers in magenta. Helpers are still anchored to the
  authored spring bones, so they may appear inside the avatar mesh; the overlay
  styling is intended to keep those lines visible through geometry.
- The color legend in the Spring Bones diagnostics panel maps helper colors to
  `hair`, `cloth`, `accessory`, `tail`, `ear`, `chest`, unprofiled, unmapped,
  and collider helpers.

## 3) Animation manifest resolution

File: `src/frontend/web/src/lib/avatar/animationManifest.ts`  
Source data: `src/frontend/web/src/assets/vrm/animations/manifest.json`

The manifest is bundled authoring/policy metadata, not a playable byte
inventory. Included VRMA files live under `content/included/gestures`; Local
content lives under `content/local`. Both are registered by the backend Content
Catalog. Preview and live Anima preparation fetch protected registered files,
verify their size and hash, and give the loader ephemeral Blob URLs. There is
no supported `/vrm/animations` public content directory.

Creator Save performs backend type validation before reconciling the catalog.
Runtime VRMA loading uses `VRMAnimationLoaderPlugin`; avatar loading uses
`Avatar.preloadVrm(...)`. Neither a manifest filename nor an old public URL
bypasses catalog preparation. See
[Content and browser workers](../architecture/content-and-workers.md) for the
storage and byte-delivery contract.

Current format admission is owned by
`src/backend/animama/app/services/content_kind_registry.py`:

- Avatar Save and scanning call the strong validator in
  `src/backend/animama/app/services/content_gltf.py`. VRMs must be
  self-contained GLB 2 with a supported VRM 0.x or 1.0 extension, valid embedded
  resource ranges, and the required humanoid bone map. External resources are
  rejected. See the backend
  [Avatar content contract](../../backend/features/custom-animas-and-content.md#confirmed-avatar-and-appearance-content).
- VRMA catalog admission accepts bounded JSON glTF or GLB, verifies the GLB
  envelope when present, and requires a glTF 2 asset and the
  `VRMC_vrm_animation` extension. The stronger canonicalizer in
  `content_gltf.py` validates one animation, finite samples, and embedded
  resources and can emit canonical GLB, but the current catalog admission path
  does not call it. Those stronger checks and canonical rewriting must not be
  described as guarantees of current VRMA Save or Rescan.

How selection is indexed:

- `Animations.idle` entries are parsed as idle-stint candidates.
- `Animations.gesture` entries are parsed as gesture candidates keyed by
  normalized manifest id.
- The helper also exposes a flattened manifest inventory for debug surfaces and
  VRMA preload planning.

Normalization rules:

- Leading `/` removed.
- `vrm/animations/` prefix removed.
- Any legacy emotion/role path segment is reduced to the filename.
- `.vrma` suffix normalized when deriving ids from VRMA file paths.
- The retained `resolveAnimationUrl(...)` helper can form legacy
  `/vrm/animations/<filename>.vrma` paths; those paths are not the current
  catalog delivery contract and must not be used to infer playable files.

Built-in production animation manifest and mounted live catalog:

- File: `src/frontend/web/src/lib/avatar/animationManifest.ts`
- Source data:
  `src/frontend/web/src/assets/vrm/animations/manifest.json`
- Scope: authoring metadata and motion policy. Live Anima chat uses a prepared
  `AnimaRuntimeCatalog` containing registered Included and Local Gesture,
  Reaction, and Idle pool selections with frozen bytes for that mount.
- Candidate rules: use non-disabled `Animations.idle` entries with
  `type: "vrma"` and finite effective duration. Empty `emotions` maps are
  neutral; non-empty maps match active tracked emotions at intensity levels 1,
  2, or 3.
- Gesture rules: use every non-disabled `Animations.gesture` entry without
  emotion filtering. `vrma` entries resolve to gesture VRMA actions;
  `animaPoseClip` entries resolve to planner-owned pose clip actions.
- Preload rules: preload non-disabled `vrma` entries only. Idle entries are
  tier A; the remaining VRMA entries are tier B. `animaPoseClip` entries are
  local JSON pose clips and are not treated as VRMA preload URLs.
- Timing: active stint duration comes from `duration / time_scale` multiplied
  by loop repetitions. `repeat` requires positive `loop_count`; `pingpong`
  uses positive `loop_count` or the runtime default of 2.
- Debug: the Avatar Planner section of `AnimationDebugModal` exposes the idle
  quiet interval and lists eligible/excluded idle candidates with match,
  weight, loop metadata, and effective duration.

## 4) Store: the runtime bridge

File: `src/frontend/web/src/stores/avatar-runtime-store.ts`

State tracked:

- Anima/run context:
  - `animaId`
  - `activeRunId`
  - `activeSpeechRunId`
- Signals:
  - `interactionPhase`
  - `activeVoiceTurn`
  - `plannerEvents` (bounded queue of typed planner events)
- Emotion:
  - `emotionalState`
  - `activeEmotions`
  - `activeEmotionGroups`
  - `dominantGroup`
  - `lastEmotionEventId` for dedupe

Important actions:

- `resetForAnima(animaId)` resets runtime state.
- `setAnimaEmotionSnapshot(snapshot)` seeds current emotional baseline from anima API state.
- `startRun(runId)` sets `interactionPhase="thinking"` and queues a
  `runStarted` planner event for the new run.
- `markSpeechStarted(runId)` transitions to `interactionPhase="talking"` based on real audio playback start.
- `markSpeechEnded(runId)` clears active speech and returns phase to idle.
- `markNonTtsResponseStarted(runId)` transitions to
  `interactionPhase="responding_no_tts"` for visible assistant presentation
  without TTS audio.
- `requestNonTtsResponseCompletion(runId)` defers run cleanup until
  `AvatarCanvasActor` observes no same-run gesture or reaction planner work.
  Reactions started during `responding_no_tts` clear after 6s, even when their
  authored lifetime is phase-bound.
- `finishRun(runId?)` clears active run/speech and returns phase to idle.
- `abortRun(runId?)` immediately clears run, speech, VFX, and planner-event
  state (used for stop/error/navigation).
- `beginListeningCapture()` / `endListeningCapture()` mirror dictation listening lifecycle.
- `applyEmotionUpdate(update)`:
  - ignores duplicate event IDs,
  - ignores stale run updates when active run mismatches,
  - stores the full per-emotion runtime state,
  - stores ranked active emotions/groups,
  - enqueues an `emotionUpdated` planner event,
  - enqueues an `emotionReactionUpdated` planner event so `AvatarPlanner` can
    start a same-run reaction clip during `talking`.
- `requestGesture(request)`:
  - ignores empty, inactive-run, and stale-run requests,
  - normalizes the gesture id,
  - enqueues a `gestureRequested` planner event from
    `avatar.gesture.requested`.
  - receives events only after the chat transport has matched the event's
    `runtime_revision` to the same mounted catalog used by the canvas.
- `consumePlannerEvents(eventIds)` removes planner events after the
  planner consumes or explicitly ignores them.

The store enforces these interaction-phase transitions through `canTransitionPhase`:

- `idle -> user_typing | listening | thinking`
- `user_typing -> idle | listening | submitting | thinking`
- `listening -> idle | user_speaking | semantic_check | submitting | thinking`
- `user_speaking -> listening | semantic_check | submitting | thinking | idle`
- `semantic_check -> listening | submitting | thinking | idle`
- `submitting -> thinking | listening | idle`
- `thinking -> talking | responding_no_tts | idle | listening`
- `responding_no_tts -> idle | listening`
- `talking -> idle | listening`

`activeEmotions` come from the backend-provided emotional state; the frontend
does not derive them from valence/control/openness axes.

## 5) Canvas runtime lifecycle

### Scene setup

`src/frontend/web/src/ui/main/canvas/Scene.tsx` renders `<AvatarCanvasActor />`
inside the main `Canvas`. Live, management, creator, and Create Anima Avatar
canvases share `CONTINUOUS_CANVAS_RESIZE` to keep renderer and camera dimensions
aligned during sidebar resizing.

### Enhanced rendering

The Advanced setting **Enable enhanced renderer and shaders** (app preference
`presentation.enhanced_rendering`, on unless turned off) switches every Avatar
canvas between enhanced and classic rendering. `SettingsProvider` mirrors the
preference into `useEnhancedRenderingStore`
(`src/lib/avatar/enhanced-rendering/`), which non-React code reads.

- **Materials:** `withEnhancedMToonPatch` retunes a VRoid export's MToon
  materials in the glTF after three-vrm's VRM 0.x conversion and before any
  material is built: coloured shadows, a crisper terminator, rim light and
  screen-space outlines. Colours come from VRoid material-name suffixes
  (`_SKIN`, `_CLOTH`, `_HAIR`, `vroidPalette.ts`) tuned on Annie; eyes, brows
  and mouth stay flat. A model is a VRoid export when an MToon material carries
  VRoid's face skin name (`_Face_` with `_SKIN`), unless Animama Avatar
  Converter marked it as a converted MMD model, whose MToon follows MMD's toon
  ramps even when the names are VRoid's. Every other model keeps all its
  materials as authored, even ones with VRoid-like suffixes, so no Avatar
  mixes retuned and authored materials; the lights and tone mapping below
  apply to all models. A change reloads the chat Avatar
  (`AvatarCanvasActor`); other canvases pick it up on their next load.
- **Lights and tone mapping:** `AvatarSceneLighting` gives the chat, preview
  and Create Anima canvases three-point lighting (`ENHANCED_SCENE_LIGHTS`) and
  Neutral tone mapping at exposure 1.1; classic keeps one key light and ACES.
- **Chat canvas filter:** a CSS filter adds a soft colour grade and a glow
  around the Avatar, standing in for colour grading and bloom. The glow
  follows the backdrop's average colour (`backdropGlow.ts`): white on light
  stage images, a faint tint of the backdrop on dark ones, and none in a
  transparent window or while an image is being sampled. It samples the stage
  image, or the theme background (including Appearance colour overrides) when
  no image is drawn, not Scene Effect backgrounds drawn over them.
- **Portraits and effect thumbnails:** `captureAvatarPortrait` repeats the
  chat look offscreen: the chat lights, a 4x MSAA half-float target (8-bit
  where the GPU cannot render float colour), an output pass with the chat
  tone mapping and sRGB encoding, and the chat grade applied to the read-back
  pixels by `applyChatCanvasGrade` rather than a canvas `filter`. The
  background stays transparent with no glow. It follows the setting at
  capture time, as the Avatar's materials did at load.

#### Authored lilToon materials

Avatars converted from VRChat by Mochiya Avatar Tools carry their lilToon
settings in the `MOCHIYA_materials_liltoon` glTF extension, beside plain glTF
fallback materials. `withOnDemandLilToon` (`src/lib/avatar/liltoon/lilToon.ts`)
wraps the VRM loader plugin. For a file whose `extensionsUsed` lists the
extension, it imports [three-liltoon](https://github.com/mochiya-labs/three-liltoon)
and builds a `LilToonMaterial` for each material that carries it. It also
adapts colour and UV expression binds to those materials.

- **Loaded on demand:** other files never import the package, about 1.9 MB of
  shader code in its own chunk. Their materials load exactly as before, so the
  enhanced and classic looks above are unchanged for them.
- **Render passes:** once the package has loaded, `AvatarSceneLighting` and the
  review stage install lilToon's outline and extra passes on their renderers
  (`installLilToonRenderingWhenLoaded`). The passes stay until the canvas
  unmounts, so after a lilToon Avatar each render of that canvas also walks
  the scene for lilToon materials; other materials draw as before.
- **Opaque passes unblended:** lilToon's opaque surfaces and their outlines
  write alpha 1, and its default opaque blend (colour One/Zero, alpha One and
  One-minus-source-alpha) then replaces the target exactly. Animama's patch of
  three-liltoon (`src/frontend/patches/`) draws such passes without blending:
  the same pixels (no byte changed in exact render comparisons), and the
  depth pre-pass below can then cover them. An authored opaque blend that can
  show (for example additive) keeps lilToon's state, as do cutout and
  transparent materials.
- **Depth pre-pass:** with those passes, `installLilToonDepthPrepass`
  (`depthPrepass.ts`) draws each opaque lilToon primitive's depth first, with
  colour writes off, so the depth test rejects hidden layers (the body under
  clothing, hair behind the face) before the lilToon shader runs. Its meshes
  exist only while the renderer draws, like lilToon's outlines. Its depth
  sits eight units and one slope step behind the surface, the drift between
  lilToon's skinning and three.js's, so a surface drawn at its own depth
  still passes its own test. A primitive takes the pre-pass only when its
  material replaces colour and alpha (blend factors One and Zero, or no
  blending), has no alpha-to-coverage and no polygon offset of its own, and
  is not hidden by lilToon's Invisible toggle (`depthPrepassBlocker`);
  otherwise a fragment it rejects could have shown in the canvas's alpha or
  its offset surface could fail the test. With the opaque passes unblended,
  the converted test Avatar takes it on 9 of its 11 primitives, which about
  halved its frame on an Apple M5 at the chat canvas (see Frame cost).
  The pre-pass skins with three.js, whose result differs slightly from
  lilToon's, so at a silhouette it can cover a multisample sample that the
  surface does not: exact render comparisons of that Avatar changed about one
  edge pixel per frame (channel delta up to 21). A frame draws without it
  when a visible material tests depth other than less, less-or-equal or
  always, or writes stencil into a target with a stencil buffer (Avatar
  canvases have none).
- **Lighting:** lilToon reads only the first visible directional light plus the
  ambient and hemisphere lights, so the enhanced look's fill and rim lights do
  not reach it. Tone mapping applies to both looks; the MToon retune does not.
  three-liltoon passes the ambient as the constant spherical-harmonics term
  only, with no direction, and lilToon (OpenLit) normalizes that direction to
  light shadows by the environment (`_ShadowEnvStrength`); unguarded that is
  `normalize(0)`, whose result differs by GPU. Animama's patch uses no
  direction instead, which is what Unity converges to for an almost uniform
  ambient, so shadowed areas lighten by the ambient colour as in Unity.
- **Materials setting:** an Avatar's Simple setting
  ([Avatar settings](../features/anima-management.md#avatar-settings)) loads
  it through a loader without `withOnDemandLilToon` (`createAvatarGltfLoader`
  in `avatarGltfLoader.ts`), so the glTF fallback materials load and
  three-liltoon is not imported. lilToon always loads lilToon at the full
  frame rate; Automatic loads lilToon at the frame rate the GPU check below
  allows, or Simple. The same setting keeps an unlit-only file unlit
  ([Unlit materials](#unlit-materials)). `Avatar.lilToonMaterials` reports `rendered`, `fallback`
  or `none`, and `Avatar.automaticMaterials` what Automatic chose (materials
  and frame cap) and why.
- **GPU check for Automatic** (`lilToonGpuCheck.ts`): the main Avatar canvas
  (`AvatarSceneHost` in `main` mode, which passes `measureLilToonGpu` to
  `Scene`: chat and any surface that reuses it) times lilToon frames on the
  GPU with `EXT_disjoint_timer_query_webgl2`. A measurement skips 60 warm-up
  frames, times the next 60 that draw a lilToon Avatar on a drawing buffer
  of at least one million pixels, and adds their median to the GPU's
  measurements in `localStorage`, per GPU (vendor and renderer strings) and
  per viewer; the newest three are kept. Frames another timer query already
  wraps, such as `effects:bench`'s, are skipped, and repeated disjoint
  timings give up until the next hourly check. Picture in Picture and the
  other Avatar canvases (previews, Create Anima, the review tools) never
  measure, though their loads read the result.
- **Automatic's choice** (`decideAutomaticMaterials`): each load under
  Automatic reads the measurements of the GPU the latest Avatar canvas uses
  or, before any canvas has mounted (the Library, an off-screen Diagnostics
  load), of the GPU a short-lived WebGL context names; it asks for
  `powerPreference: "high-performance"`, as R3F's canvases do, so a machine
  with two GPUs names the same one. The fastest measurement decides: lilToon
  at the highest of 60, 45, 30 and 24 fps whose budget it fits, the frame
  time times `LILTOON_FRAME_HEADROOM` (1.3) within the frame interval (60 fps
  up to 12.8 ms, 45 up to 17.1, 30 up to 25.6, 24 up to 32.1). Slower than
  that, it loads Simple once two measurements agree and the newest is under a
  week old; until then it loads lilToon at 24 fps, because only lilToon
  frames can be measured again. A GPU not measured yet, or a browser without
  the timer extension (stored as unsupported), keeps lilToon uncapped;
  blocked storage counts as not measured. The time is compared as measured,
  not scaled by canvas size: on an Apple M5 a converted Avatar's lilToon
  frame took 5.3–6.0 ms from 1.0 to 5.9 million drawing-buffer pixels,
  where Andrew's grew from 2.4 to 4.5 ms (the default window's chat canvas
  is about 3.7 million pixels at DPR 2).
- **Frame cap:** a loaded lilToon Avatar under Automatic sets its cap on the
  canvas it was constructed with (`canvasFrameCap.ts`, keyed by the R3F
  canvas element; cleared on unload), and that canvas's `SceneFramePacer`
  renders at most that often ([Frame rate](#frame-rate)). An Avatar without
  lilToon materials, such as an Included Avatar, one whose lilToon failed to
  load, and an explicit lilToon setting set none.
- **Measuring again:** the chat canvas measures a GPU once per session (an
  app launch or page load) until it has three measurements, then whenever
  the newest is over a week old (checked when the main canvas mounts and
  hourly while it stays mounted). Automatic uses the fastest, so a
  measurement taken while the machine was busy gives way to a faster later
  one. Materials and the cap are chosen at load, so a new measurement
  applies from the next load; Diagnostics shows a "Next load" line when it
  would change either. Removing the `animama.lilToonGpuCheck` key from the
  app's `localStorage` (for example in the developer tools) and reloading
  measures every GPU from scratch. Raising `METHOD` in `lilToonGpuCheck.ts`
  does that for every viewer, for a changed measurement or a rendering
  change that moves lilToon's cost.
- **Fallback base colours:** Mochiya writes `metallicFactor` 1 on the fallback
  materials, which renders them almost black without an environment map.
  `UnmetallicMaterialsPlugin` (`unmetallicMaterials.ts`) builds every lit glTF
  material an Avatar loads, these fallbacks and plain PBR materials alike,
  with metalness 0. It skips MToon materials by their `VRMC_materials_mtoon`
  extension (VRM 0 MToon gains it before materials load); GLTFLoader never
  extends unlit materials or the materials lilToon builds itself.
  Vertex colours on lilToon materials' meshes are lilToon outline data, so
  the same plugin turns them off on those fallbacks (`COLOR_0`); other
  materials keep glTF's colour multiply.
- **Outlines from vertex colours:** with `_OutlineVertexR2Width` 2, lilToon
  takes an outline's direction from the vertex colour's RGB (a tangent-space
  normal the author baked, often for hair) and its width from the alpha.
  On a mesh without vertex colours, three-liltoon reads white, which pushes
  the outline through thin parts as dark patches (hair bang tips).
  `withOnDemandLilToon` then sets such outlined materials to mode 0 (the mesh
  normal, or the outline vector texture, at full width still scaled by the
  width mask) and logs a warning naming them. Outline tips then read
  slightly heavier than in Unity, where the colours taper them; meshes that
  keep their vertex colours draw as authored. Mode 1 (width from red) keeps
  its direction without colours and reads full width, as Unity does for a
  mesh without colours; on exports that drop them its tips also read
  heavier than in Unity.
- **Fallback:** in development and the review tools, a failed import loads the
  glTF fallback materials instead, and a later Avatar retries. In a built app a
  failed chunk download shows the app's reload screen (`PageLoadError`), as for
  any other lazily loaded code. The `vrm:optimize` compare page uses its own
  loader and always draws the fallback materials; `animation:render` loads
  lilToon as the app does.
- **Silhouettes and release:** silhouette overlays bias lilToon materials eight
  depth units, because lilToon skins and projects in its own order. A cut-out
  lilToon material's overlay discards by its `_Cutoff` (three-liltoon reports
  it as `alphaTest`), reading the main texture through `_MainTex_ST` and its
  fixed rotation and applying its `_AlphaMask` (`lilToonAlphaSource`).
  `releaseModelScene` disposes their `lilToonTextures`, which neither
  `VRMUtils.deepDispose` nor the material's `dispose` releases.
- **Frame cost:** lilToon shading is much heavier than MToon. On an Apple M5
  at the chat canvas (800×600 at DPR 2) with `effects:bench --saturate 10`,
  which is meant to keep the GPU at its top clock, a converted Avatar's
  lilToon frame took 4.6–4.8 ms, and its fallback materials and the Included
  Avatars about 0.8 ms each (the Included Avatars are CPU-bound there, so
  their GPU share is lower). The same run alternated with the code from
  before this work's lilToon changes, where that lilToon frame took 9.1–9.3 ms
  and the fallback materials and Included Avatars measured about the same as
  after (2026-10-27). The first lilToon Avatar a fresh bench page renders
  runs about three times slower than the same Avatar loaded again in that
  page (5.1–5.2 against 1.8–1.9 ms after the change, 9.6–10.8 against
  2.7–3.0 ms before it), with the same draws and resolution; the cause is not
  known. `effects:bench` loads one Avatar per launch, so it measures that
  first state. Compare only runs made together. Frames paced
  like the app (`--fps 60`) also leave the GPU at a lower clock when the work
  is light, so paced timings narrow the differences between frames and
  understate the savings of a change. Before the change, outlines acted as a
  partial pre-pass (switching them off made frames slower), and switching off
  toon shadow or reflection saved about a sixth of the frame each, but
  changes the look, so authored features stay on. Most of the cost is
  fragment shading of large layered surfaces (the clothing material alone
  took about 60% of it before the change). `effects:bench --breakdown` breaks
  the cost down by material, lilToon feature and layer.

On an Apple M5 the enhanced look adds about 0.1–0.15 ms per frame over classic.
Review renders and benchmarks use enhanced rendering unless given
`--rendering classic`.

#### Unlit materials

A VRM 1.0 file whose materials are all `KHR_materials_unlit` (no MToon,
lilToon or standard material) would draw flat: three builds unlit materials as
`MeshBasicMaterial`, which no light reaches, so neither look above can shade
it. Such files usually come from MikuMikuDance (PMX) models converted with a
tool built on three's `GLTFExporter`, which cannot write MMD's toon material
and drops its shading and outlines. A file that mixes unlit with other
materials keeps them as authored. VRM 0.x files are out of scope and still
look flat: three-vrm draws their `VRM/Unlit*` shaders as MToon whose shade
equals the lit colour, without outlines, and their glTF unlit materials as
unlit.

`withUnlitToonShading` (`src/lib/avatar/unlitToonShading.ts`) gives these
files MToon in the glTF after the VRM 0.x conversion, before any material is
built, unless the Avatar's Materials setting is Simple:

- **Face:** face parts are the primitives of the meshes the VRM expressions
  bind (every mesh with morph targets when none is bound) whose drawn
  vertices one of their morph targets moves. A converted MMD model is usually
  one mesh, so pupil shapes that no expression binds count too, while
  clothing shape keys on separate meshes do not. The largest textured face
  part is the face skin and gets a mostly lit look with a warm shade and a
  brown outline. The other face parts (eyes, lashes, mouth) stay unlit.
- **Body:** every other textured material that is not blended gets a cool
  shade, rim light and a thin dark screen-space outline. The shade reuses the
  base texture (`shadeMultiplyTexture`), so painted effects paint both sides.
- **Unchanged:** blended (transparent) and untextured materials stay unlit.
- **Brightness:** the lit colour is raised by 1.25 (`LIT_GAIN`), so lit areas
  under the enhanced chat lights stay within a few percent of the unlit
  texture; classic lighting leaves them about a tenth darker. MMD models
  converted by Animama Avatar Converter, whose MToon is lit for MMD's light,
  take the same gain on their lit and shade colours, under every Materials
  setting
  ([Converting an MMD model](mmd-model-conversion.md#what-animama-does-with-it)).
- **Limits:** the look is Animama's, not the author's: a converter that keeps
  the model's own toon materials does better. Any shape key on a face mesh
  makes the parts it moves face parts, so on a one-mesh model a body, bust or
  skirt shape leaves that part unlit, and if it is larger than the face, it
  takes the face look while the face stays unlit. Eye whites or teeth that no
  shape moves get the body look and its outline. Physics and look-at that a
  converter dropped stay missing.

The step runs after the enhanced MToon retune, so the retune sees only a
file's own MToon. Automatic's GPU check never turns it off: it weighs
lilToon's cost, and a file has either lilToon or only unlit materials.
Diagnostics names such files from their file facts (`materials_unlit`).

### Actor setup

`src/frontend/web/src/ui/main/canvas/AvatarCanvasActor.tsx`:

- Reads `animaId` from route params.
- Uses the model and stable catalog supplied by `AnimaRouteProviders` after
  essential bytes are verified; it never substitutes a sample model.
- Creates `Avatar` with the mounted motion/media catalog and loads the verified
  model plus its exact prepared resource map.
- Calls `prepareFirstFrame()` before attaching `avatar.scene` as `<primitive />`.
  The planner cannot run before the first actual main-camera mesh draw.
- `observeFirstPosedFrame` ignores offscreen/shadow passes and releases optional
  preparation on the following animation frame. It restores mesh callbacks
  after observation and cancels a stale callback on cleanup.
- Schedules bounded, yielding animation/particle warm-up after that first frame.
  New ready roots join the same background job; they do not restart the avatar,
  camera, or canvas. An applicable idle then uses the existing planner and blend
  from relaxed-rest. No/failed idle leaves the resting model visible.
- Registers the loaded avatar with debug-only stores:
  - VRM object inspection/editing target
  - animation/procedural/spring-bone tuning target
- Passes the R3F scene as the spring-bone helper host so helper visuals can render outside `vrm.scene`.
- On cleanup, cancels first-frame/warm-up callbacks, unsubscribes availability,
  and disposes the avatar instance. Late decoding cannot animate the old rig.
  Unloading detaches the model, disposes its GPU resources and closes its
  decoded texture images, and disposal also drops caller sinks. Nothing may keep
  using the model's textures or materials after its Avatar unloads.

### Per-frame update

After the first posed draw, on every `useFrame` tick:

- Pull latest store snapshot via `useAvatarRuntimeStore.getState()`.
- Call `avatar.updateState({ emotionalState, signals })`.
- If returned plan is a gesture with `gestureRequestId`, call `consumeGestureRequest(...)`.
- Tick the lip-sync bridge gate so a run's planned segment can start once audio
  and avatar state are ready, then its tag expression overlays.
- Read a provider-agnostic speech timing context from the same bridge. The
  context contains `runId`, `elapsedSec`, `utteranceDurationSec`, `durationSec`,
  `remainingSec`, `durationKnown`, and a speech gesture timeline when available;
  it is emitted once a run's audio has started. The gesture timeline grows as
  the lip-sync planner plans more of the run's audio.
- Call `avatar.update(delta, { speechTiming })`.

This avoids coupling avatar updates to React render frequency.

### Frame rate

The chat `Scene` (main window and PiP) renders on demand at the rate it needs,
not at the display rate (120 Hz on ProMotion displays). `SceneFramePacer`
(`ui/main/canvas/SceneFramePacer.tsx`) runs a display-rate loop and renders due
frames there with R3F's `advance`: 60 fps while the Avatar is active, 30 fps
while it idles. Requesting frames with `invalidate` instead renders them one
display frame late, and on a 60 Hz display R3F's stopped loop then drops every
other one. Each
frame costs renderer and GPU-process CPU, so on a 120 Hz display this measured
about 75% → 45% of a core idle, and about 26% at the idle rate.

The Avatar is idle when the interaction phase is `idle` and
`avatar.isMotionActive()` is false: an `idle` animation state, no reaction clip
and no Avatar or particle effect (finishing particles included). `AvatarCanvasActor` writes this into the
scene's `SceneFrameDemand` after each update. Window pointer, wheel and key
input, and in PiP the desktop cursor feed, keep the full rate for
`SCENE_INPUT_ACTIVE_MS` (1.5 s) so cursor look-at stays smooth. Scenes with a
custom `avatarActor` never report idle and keep 60 fps. Delta-time consumers see
the real interval since the previous rendered frame.

A canvas showing a lilToon Avatar that Automatic capped (45, 30 or 24 fps on a
GPU too slow for 60; see the [frame cap](#authored-liltoon-materials)) renders
at most at the cap, active or idle; idle uses the lower of the cap and 30.
Picture in Picture shares the chat `Scene`, so the cap applies there too, as on
every `PacedScene` canvas below.

The other Avatar canvases use the same `PacedScene` wrapper. An active
`AvatarPreviewSurface` (the Animas page, the Library preview, creators and
editors) and the Create Anima upload preview render at 60 fps; the Animas page,
the Library preview and Create Anima report idle through `useSceneFrameDemand`
and drop to 30 while nothing plays, while creators and editors keep 60. An
inactive surface renders only when invalidated. These canvases render at most
1.5× device pixels (`PREVIEW_CANVAS_DPR`) with 4× MSAA kept; chat and PiP keep
2×. On a Retina display 1.5× is 44% fewer pixels; for a full-window chat canvas
it measured about 230 MB less GPU memory and no CPU change.

### Animation debug modal

Files:

- `src/frontend/web/src/ui/debug/AnimationDebugModal.tsx`
- `src/frontend/web/src/stores/animation-debug-store.ts`

The Animation Debug modal is available with development debug enabled and a
registered Avatar target.

The modal currently exposes:

- **Breathing** controls for enablement, layer weight, BPM, intensity, torso/head/shoulder amplitudes, breath sway, and lag.
- **Sway** controls for enablement, layer weight, CPM, side shift, torso lean, head counterbalance, shoulder drift, and lag.
- **Bounce**, **Head Nods**, **Head Side Tilt**, **Cursor Look At**, **Talking Hands**, and **Emotion Posture** controls for optional procedural layers.
- **Spring Bones** controls for enablement, helper visibility, gusts, global physics values, and semantic profile overrides.
- **PoseController** catalog pose controls that invoke `Avatar.applyPose(...)`, show active/missing target diagnostics, and clear the active pose.
- **PoseController Clips** catalog clip controls that invoke `Avatar.playClip(...)`, stop active clips, restart the selected clip, and show active clip diagnostics.
- The clip controls also show effect-event counts by kind and runtime dispatch diagnostics while a built-in clip is playing.
- **Avatar Planner** readouts for planner state, active planner-owned VRMA,
  active planner-owned pose clip, pending delayed work, cancellation reasons,
  ignored request reasons, and planner-owned procedural layers.
- **Runtime** readouts for loaded/missing bones, active pose state, spring-bone manager counts, helper counts, and gust state.

These controls are runtime-only tuning tools. They do not persist procedural parameters, spring-bone settings, pose selection, or helper visibility to anima settings or VRM files.

## 6) Dispatch lifecycle -> avatar behavior

Chat maps submit, text, speech, gesture, emotion and completion events into the
store actions above. The [Chat guide](chat.md#8-avatar-updates-from-chat) owns
that integration contract. Audio start/end drives talking; non-TTS responses
retain presentation until text and same-run planner work finish. Stop, error,
navigation and unmount abort the active run.

## 7) Dictation -> listening state

File: `src/frontend/web/src/ui/main/chat/ChatInterface.tsx`

`useDictation` state drives:

- `beginListeningCapture()` / `endListeningCapture()` via effect.
- Cleanup forces `endListeningCapture()` on unmount.

Listening transitions are constrained by legal transition rules in the runtime store. Dictation attempts to enter/exit listening, but illegal transitions are rejected when run/speech state is active.

## 8) Typing -> idle-base procedural state

File: `src/frontend/web/src/ui/main/chat/ChatInterface.tsx`

Manual textarea edits with non-empty text call `beginTypingActivity()` and
refresh a short inactivity timer. If the user stops typing, clears the input,
submits, starts dictation/voice mode, or leaves the component, the chat UI calls
`endTypingActivity()`. The planner maps `user_typing` to the idle base state,
so idle stints remain governed by the same quiet/active policy while the
procedural lane borrows the listening `bounce` / `headNod` policy.

## 9) Event filtering and safety guards

SSE integration (`useChatSse.ts`) filters by expected `run_id` before invoking callbacks.

Store guards add another layer:

- Ignore duplicate emotion event IDs.
- Ignore emotion deltas from non-active runs.

Together this prevents stale cross-run emotion/gesture contamination.

## Runtime tuning limits

`playDefaultAnimation()` is a no-op; state-machine plans drive automatic motion.
Debug procedural, spring-bone and pose settings last only for the Avatar instance.
