# Clip format

A clip is `animaPoseClip/2.0` JSON: named **beats** on a timeline, and
per-joint **tracks** whose keys belong to a beat. Validation reports every
problem with a JSON path.

```json
{
  "schema": "animaPoseClip/2.0",
  "id": "wave-hello",
  "name": "Wave Hello",
  "duration": 2.6,
  "basePose": "relaxedRest",
  "fadeIn": { "duration": 0.25 },
  "fadeOut": { "duration": 0.35 },
  "mutedProceduralLayers": ["sway", "bounce", "headNod", "headSideTilt", "cursorLookAt", "emotionPosture"],
  "plantFeet": true,
  "beats": [
    { "id": "start", "label": "Start", "time": 0 },
    { "id": "raise", "label": "Raise", "time": 0.5 },
    { "id": "wave", "label": "Wave", "time": 0.9 },
    { "id": "lower", "label": "Lower", "time": 2 },
    { "id": "settle", "label": "Settle", "time": 2.5 }
  ],
  "joints": {
    "rightUpperArm": {
      "elevation": [
        { "beat": "start", "v": "base" },
        { "beat": "raise", "dt": 0.05, "v": 108 },
        { "beat": "lower", "dt": -0.25, "v": 100 },
        { "beat": "settle", "dt": -0.2, "v": "base" }
      ]
    }
  },
  "hipsPosition": { "x": [{ "beat": "start", "v": 0 }, { "beat": "raise", "dt": 0.15, "v": 0.015 }, { "beat": "settle", "dt": 0.1, "v": 0 }] },
  "hands": { "right": [{ "beat": "start", "preset": "relaxed" }, { "beat": "raise", "dt": -0.05, "preset": "open-together", "spread": 8 }] },
  "expressions": { "happy": [{ "beat": "start", "v": 0 }, { "beat": "raise", "dt": -0.05, "v": 0.75 }, { "beat": "settle", "dt": 0.05, "v": 0 }] }
}
```

Full examples are the Included 2.0 Gestures, for example `wave-hello`, the
laugh tiers `mild-laugh`, `medium-laugh` and `hysterical-laughter`, and
`have-an-idea`, which solves hand contacts and plays an Avatar Effect.

## Fields

| Field | Meaning |
| --- | --- |
| `id`, `name` | Gesture display name; `id` is its lowercase kebab-case form (the creator reapplies it). |
| `duration` | Seconds (at most 3,600); every beat and key lies within 0…duration. |
| `loop` | `true` repeats while held; omit for a one-shot (enter, act, return). |
| `basePose` | Use `"relaxedRest"`; `"base"` values and untracked bones come from it. |
| `fadeIn`/`fadeOut` | `{ "duration": s }` blends from/to the live pose (about 0.3 / 0.4 s). |
| `plantFeet` | `true` solves the legs on each Avatar so both feet stay still; leg joints cannot then be keyed. Omit it only to key the legs yourself. |
| `mutedProceduralLayers` | Live layers muted while playing; usually all but `breathing`. |
| `beats` | `{ id, label, time, ease? }` in time order, at least 0.5 ms apart. `label` is what the creator shows; `ease` is the default arrival for the beat's keys. |
| `joints` | `{ jointId: { component: keys[] } }`; the [joint list](joints.md) gives each joint's components and ranges. |
| `hipsPosition` | `{ x, y, z }` metres from rest: x toward the Avatar's left, y up, z forward. |
| `hands` | `{ left, right }` hand-shape keys (see [hands](hands.md)). |
| `expressions` | `{ name: keys[] }`, one track per named face shape, weights 0–1 (see [faces](faces.md)). |
| `contacts` | Intended touches: the checks measure them, and `solve` makes playback land them (see Contacts below). |
| `events` | Effects the Gesture plays on its timeline (see Avatar Effect events below). |
| `rotations` | Raw quaternion tracks used by hand-made and converted clips; do not author them. |

## Beats and keys

`{ "beat": id, "dt"?: seconds, "v": number | "base", "ease"?: …, "tangent"?: "flat" }`

- A key's time is its beat's time plus `dt` (default 0). Keys lie between the
  neighbouring beats of their beat, and a track's keys increase in time.
- Beats are the readable structure: the creator shows them as keyframes on the
  Pose lane, and moving a beat moves all its keys with it. Give each beat a
  short label for what happens ("Raise", "Clap 2", "Settle"); 3–8 beats per
  Gesture, plus one per repeated accent.
- Assign each key to the beat it belongs to musically, with a small `dt` for
  staggered arrival: a hand that lands 0.1 s after the arm is
  `{ "beat": "raise", "dt": 0.1, … }`. Keys stay with their beat when it moves.
- `"base"` means the Relaxed Rest value of that component, which the
  [joint list](joints.md) gives; expressions have no base.
- `ease` says how motion arrives at the key: `smooth` (the default for joints,
  hips and expressions; monotone cubic, keeps speed through a key unless it is
  a peak or valley), `linear` (constant speed, kinks at keys), `hold` (stay on
  the previous value, then snap at this key — deliberate snaps only), or a
  named easing (`easeInOutSine`, the default for hands, `easeOutCubic` and so
  on). A key's `ease` overrides its beat's.
- `"tangent": "flat"` stops motion at a smooth key.
- In a one-shot, a track holds its first value before its first key and its
  last after its last. In a loop, tracks wrap: after the last key the value
  blends back to the first key across the seam. Key 0 and the duration with
  equal values to hold at the seam.
- A joint you never mention stays at the base pose; a component you omit
  holds its base value. A joint must name at least one component.
- Values beyond a component's anatomical limit fail validation.

## Contacts

```json
"contacts": [
  { "bone": "rightHand", "point": "palm", "target": "head", "offset": [0, -0.07, 0.09],
    "beat": "rest", "from": 0, "to": 1.2, "facing": true, "solve": {} },
  { "bone": "leftHand", "point": "palm", "target": "rightLowerArm", "offset": [-0.12, 0, 0.03],
    "beat": "fold", "from": 0.1, "to": 2, "solve": { "blendIn": 0.3 } },
  { "bone": "rightThumbDistal", "point": "tip", "target": "rightIndexDistal", "targetPoint": "tip",
    "beat": "pinch", "from": 0, "to": 0.4, "tolerance": 0.01 }
]
```

| Field | Meaning |
| --- | --- |
| `bone`, `target` | Humanoid bones that touch. |
| `beat`, `from`, `to` | The window, in seconds from the beat (`from` ≤ `to`, inside the clip). |
| `point`, `targetPoint` | Where each bone touches: `joint` (default, the bone's origin), `palm` (hand bones: the palm surface) or `tip` (finger bones: the next joint, or the pad of a last segment). |
| `offset` | Metres from the target point in the target bone's frame (at rest x toward the Avatar's left, y up, z forward; it turns with the bone), for a 1.25 m Avatar; each Avatar scales it by its height. |
| `tolerance` | Metres the checks accept. |
| `facing` | `true`: the checks also verify that the palm turns toward the target (hand or finger bones). |
| `solve` | `{}` or `{ "blendIn": s, "blendOut": s }` (0–2 s, default 0.15): playback lands the touch on every Avatar. |

- A solved contact re-solves only the upper arm and elbow of `bone`'s side,
  easing in before the window and out after it. The collarbone, forearm
  rotation, wrist, fingers and palm direction stay as you key them, so pose
  the arm within a few centimetres of the touch and turn the palm yourself
  (`facing` checks it). Keep the elbow bent near the touch.
- A solved contact's `bone` is a hand or finger bone and its `target` is not
  on the same arm. One solved window per side at a time: windows on one side
  may touch but not overlap. Ramps of consecutive windows shorten to meet
  midway, so claps 0.2 s apart chain. A window that starts where another ends
  gets no ramps: continue the same contact there, or leave a gap so the arm
  can travel between two different targets; otherwise it jumps.
- Only crossed arms solve both ways. A clap solves one palm onto the other
  (that arm meets the other hand). Two solved contacts whose targets each lie
  on the other arm, at overlapping times (windows with blends), fail
  validation unless both target an upper arm or forearm: when each hand rests
  on the other upper arm or forearm, solve both; they are solved together.
- A target at or beyond full reach stops short (about 1 cm at full reach), and
  a large correction in a short ramp moves fast: pose the arm close to the
  touch.
- Mute the head and torso layers when a solved touch is on the head: live
  layers run after the clip and would move it.
- Unsolved contacts are only measured. Retiming a beat in the creator moves an
  unsolved contact with its beat and stretches solved windows with the beats
  around them.

## Avatar Effect events

An `avatar_vfx` event in `events` plays an Avatar Effect:

| Field | Meaning |
| --- | --- |
| `id` | Unique within the clip. |
| `time` | Start, in seconds from the clip's start. |
| `kind` | `"avatar_vfx"`. |
| `effectId` | The `alias` of one of the Gesture's `avatar_effect` dependencies, not a content ID. |
| `duration` | Seconds it shows; omit it to keep the effect until the Gesture ends. |
| `envelope` | `{ "intensity": { "fadeIn": s, "fadeOut": s } }` fades the art in and out; only for an event with a `duration`. |
| `parameterKeyframes` | Not supported for Avatar Effects; leave it out. |
| `playAccompanyingSound` | `false` silences the effect's sound for this event; omitted, it plays. |
| `override` | `{ attachment?, appearance?, motion?, soundAlias? }`: changes to the effect for this event only. |

Use `override` to place an existing effect differently, change its look or
motion, or pick another of its sounds, instead of asking for a variant effect:

- Each part present replaces the effect's part whole; nothing is merged
  field by field. Copy the part from the effect's definition and change
  what this use needs; leave a part out to keep the effect's own.
- `attachment.kind` must equal the effect's kind. The fields follow the
  effect definition.
- `soundAlias` should name one of the effect's declared sounds; an unknown
  or unmounted one plays silently.
- The art, flipbook, region and face options stay the effect's.
- An empty override or a `null` part is refused. Save, import and export
  check the effect with the override applied and name the failing field.

`drumroll_ticks` sits on the right hand. This event mirrors it onto the left
hand (offset `x` negated; negate `rotationDeg` too when it is set), silently,
because another event plays the right-hand ticks with their sound:

```json
{
  "id": "ticks-left",
  "time": 0.4,
  "kind": "avatar_vfx",
  "effectId": "drumroll_ticks",
  "duration": 1.5,
  "envelope": { "intensity": { "fadeIn": 0.1, "fadeOut": 0.2 } },
  "playAccompanyingSound": false,
  "override": {
    "attachment": { "kind": "body", "bone": "leftHand", "offset": { "x": 0.122, "y": 0.006, "z": 0.016 }, "size": 0.18 }
  }
}
```

## Joint ids

`hips`, `spine`, `chest`, `upperChest`, `neck`, `head`, `eyes`, then per side
(`left…`/`right…`): `Shoulder`, `UpperArm`, `LowerArm`, `Hand`, `UpperLeg`,
`LowerLeg`, `Foot`, `Toes`, finger segments such as `rightIndexProximal`,
`rightMiddleIntermediate`, `rightRingDistal`, and `rightThumbProximal`,
`rightThumbDistal`. Sides are the Avatar's own. Components the
[joint list](joints.md) marks auxiliary complete a joint's three axes for
converted clips; leave them at their base.

## Size and playback

Clips store keys, not frames: the six migrated evaluation Gestures save at
3–13 KB, 1.1–8.2% of their former baked size, and a 20 s Gesture stays far below the 2 MB the app loads
(validation reports the saved size). Each Avatar prepares the clip when it
starts playing: hand presets are fitted to its fingers and planted legs are
solved on its own rig, so both Included Avatars keep their feet still (within
about a millimetre on Andrew, whose straight rest legs leave a wide hip shift
slightly out of reach).
