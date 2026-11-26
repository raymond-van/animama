# 0032: VRM stays the Avatar container; ARKit shapes are a face capability

- Status: accepted
- Recorded: 2026-10-24
- Retrospective: no
- Original decision date: 2026-10-24, owner decision recorded in [#687](https://github.com/raymond-van/animama/issues/687) and the [VRChat ARKit Avatars ExecPlan](../plans/vrchat-arkit-avatars/vrchat-arkit-avatars-execplan.md)
- Decision basis: Explicit owner decision

## Context

Many anime Avatars are sold for VRChat as Unity prefabs, not VRM files. They
carry ARKit-named face shapes (`jawOpen`, `mouthSmileLeft` …) but no VRM
expression presets or VRoid `Fcl_*` parts, which Animama's emotions and
Reactions rely on. Supporting them raised the question of loading such Avatars
natively (FBX or plain glTF) rather than converting them to VRM.

Every Avatar subsystem sits on three-vrm: humanoid motion, Gestures, poses and
VRMA retargeting, spring bones, look-at, expressions, VFX anchors and portraits.
The backend upload validator requires a VRM humanoid. An FBX export holds none of
the Unity humanoid mapping, PhysBones or lilToon material settings, and morph
target names survive a VRM conversion unchanged.

## Decision

Avatars stay VRM files (0.x or 1.0). VRChat Avatars reach the app through a VRM
conversion that preserves their morph targets. ARKit-52 is a face capability the
runtime detects from each Avatar's morph-target names, tolerating case, side and
common face-tracking naming (`arkitFaceCapability.ts`), and registers under the
canonical ARKit names. Features use those names directly on Avatars that have
them and fall back to existing behavior on Avatars that do not.

## Rationale and consequences

- One loading, motion and physics path; no second humanoid mapping or spring
  implementation to keep in step with three-vrm.
- ARKit support works for any VRM that carries the shapes, whether converted
  from VRChat, exported from Blender or authored for face tracking.
- Conversion quality bounds what the app receives: the converter's humanoid,
  spring approximation and material export carry over as they are.
- Avatar files that cannot be converted to VRM remain unsupported.

## Evidence

- `src/frontend/web/src/lib/avatar/Avatar.ts` (`_loadVrm`): loading requires
  a VRM.
- `src/backend/animama/app/services/content_gltf.py` (`_validate_vrm_humanoid`):
  uploads require a VRM humanoid.
- `src/frontend/web/src/lib/avatar/arkitFaceCapability.ts` and
  `morphTargetExpressions.ts` (`registerArkitExpressions`): the face capability.
