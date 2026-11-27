# Motion checks

The motion checks play a clip through the production sampler on both Included
Avatars, `Andrew` and `Annie` (both VRM 1), each with its own fitted hands,
solved legs and solved contacts. Fix every FAIL; treat WARN as a prompt to
look. The checks catch anatomy, collisions, grounding and continuity; they
cannot judge naturalness.

A 2.0 clip supplies its `contacts`; feet are checked unless it keys its legs
itself without `plantFeet`. Findings marked `[canonical]` come from the first
Avatar's playback and stand for both; others name the Avatar. Arms moved by
solved contacts are the exception: there a `[canonical]` range or smoothness
finding describes the first Avatar's solve only, and each other Avatar's
solved arms are reported under its own name.

| Category | Means | Typical fix |
| --- | --- | --- |
| `pose` | A referenced pose is missing from the catalog | Use `"relaxedRest"` as the base pose; 2.0 tracks reference no other poses |
| `range` | A joint exceeds its natural (WARN) or anatomical (FAIL) range | Reduce the value or share it with neighbouring joints |
| `smoothness` | Pop, speed or acceleration spike, or a mid-motion stall (WARN) | Spread keys, remove `hold`/`linear` jumps, add an easing key, drop accidental `flat` holds |
| `oscillation` | WARN: a joint swings back and forth faster than about 4 Hz for three cycles or more | Fewer, slower pulses (see [human movement](human-movement.md#laughing-and-bouncing)) |
| `intersection` | Hand or forearm passes into the torso, neck, head or the other arm (capsule approximation, calibrated against the base pose) | Raise elevation before or with elbow flexion (a bent elbow on a hanging arm drives the forearm into the hip); move the arm outward or forward; avoid shoulder depression with a bent elbow; declare an intended touch as a contact |
| `fingers` | A finger passes through another finger or its own palm (FAIL when the cores cross, WARN for a deep overlap), or into the other hand (WARN) | Reduce `curl`, inward `spread` or the finger offsets; keep the hands apart, or declare the touch as a contact |
| `contact` | A declared touch is out of tolerance (FAIL), or a solved or `facing` contact needs attention (WARN, below) | See [Contacts](#contacts) |
| `feet` | A planted foot slides, lifts or sinks | Reduce hips offset or pelvis rotation; keep `plantFeet` |
| `loopSeam` | A loop's end does not meet its start, or speed jumps there | Match end keys and keep motion consistent across the seam |
| `parity` | A bone turns differently on the two Avatars | Report it: this indicates a conversion bug, not an authoring choice |

The oscillation check reads each body joint component (not eyes, fingers or
toes) and ignores swings under 1.5°. Three cycles are three peaks and three
troughs, six reversals in a row. Their rate is timed over whole cycles, peak
to peak and trough to trough, so an uneven pulse (a quick rise and a slower
fall) counts at its true cycle rate. Two quick cycles do not warn.

Finger capsules are sized from each Avatar's finger spacing. The thumb is
not checked against the fingers of its own hand, because fitted fist, point,
peace, pinch and OK shapes press it onto them.

## Contacts

Declare intended touches so the checks verify them and stop flagging them.
`from` and `to` are seconds from the named beat, so the touch moves with it.
The fields (`point`, `targetPoint`, `offset`, `tolerance`, `facing`, `solve`)
are described in the [clip format](clip-format.md#contacts):

```json
"contacts": [
  { "bone": "rightHand", "point": "palm", "target": "head", "offset": [0, -0.05, 0.1],
    "beat": "touch", "from": 0, "to": 0.8, "facing": true, "solve": {} }
]
```

`bone` and `target` are VRM humanoid bone names, for example `head`, `neck`,
`chest`, `upperChest`, `spine`, `hips`, `leftHand`, `rightIndexDistal`,
`rightThumbDistal`, `leftLowerArm`. The checks measure from `bone`'s `point`
to `target`'s `targetPoint` moved by `offset`. `offset` is metres for a 1.25 m
Avatar in the target bone's rest-aligned frame (x Avatar's left, y up,
z forward); each Avatar scales it by its height. The `head` bone sits at the
skull base with the eyes about 6 cm above it, so the chin is roughly level with
it and 5–7 cm forward. A hand resting under the chin has its palm about
`[0, -0.05, 0.1]` from `head` and its wrist about `[0, -0.055, 0.11]`; confirm
with the reported actual offset. A failed or warned contact reports where its
point actually is as an offset from the target point, at the same 1.25 m
scale. That tells you which way to move the arm, or which offset you really
meant.

The offset axes are the target bone's T-pose axes carried along with the
bone: for a hand target, the palm faces −y and the fingers point outward
(+x for the left hand, −x for the right).

**Unsolved contacts** are only measured, within `tolerance` (default 6 cm).
The Included Avatars' arms are about as long, but Andrew's shoulder joints
sit about 15 cm further apart and his torso is broader, so a touch keyed by
joint angles lands a few centimetres apart on them. Use tolerances of 4–7 cm
and look at the touch on both Avatars, or solve the contact.

**Solved contacts** (`solve`) move the upper arm and elbow on each Avatar so
the point lands. They are held to `min(tolerance, 1.5 cm)`; a miss reads
"unreachable on this Avatar": the arm cannot stretch or fold that far within
the elbow's range. Move the target or offset nearer the shoulder, or bend the
authored elbow so the reach is comfortable. Further solved-contact findings:

- **WARN reach correction**: during the window, the authored (unsolved) point
  is more than 8 cm (scaled) from the target, so the solver, not your arm, is
  doing the reach. Big corrections bend the elbow and swing the arm
  differently on each Avatar and can spike speed on the blend ramps. Pose the
  authored arm within a few centimetres of the touch, using the reported
  offset.
- **WARN solved head contact with live layers**: a solved contact on the head,
  neck, eyes or jaw while `sway`, `bounce`, `headNod`, `headSideTilt`,
  `cursorLookAt` or `emotionPosture` is not muted. Those layers turn the head
  or neck after the clip, so the hand would be left behind. Mute the layers the
  finding names; `breathing` moves it only by millimetres.
- Range and smoothness are also reported for the solved arms
  (`<side>UpperArm`, `<side>LowerArm`) of each Avatar after the first: the
  solve differs per Avatar, and blend ramps or a near-straight arm can jump.
  Lengthen `blendIn`/`blendOut` or pose the authored arm nearer the touch.
- Parity is measured on the authored arms before solving, so a per-Avatar
  solve is never reported as a conversion bug.

**WARN palm not facing** (`facing: true`): the palm of `bone`'s hand turns
more than 45° away from the target bone during the window. The direction runs
from the middle of the palm to the target bone: a hand target's centre, the
middle of the head (halfway from the `head` joint to the eyes) for head, eye
and jaw targets, and for any other bone the point of its segment nearest the
palm (from its joint to the next joint, for example elbow to wrist for a
`LowerArm`; a finger's segment runs to its tip). A palm resting anywhere along
a forearm, upper arm or the spine therefore aims straight into it. `offset`
and `targetPoint` are ignored, because during a touch the touch point lies on
the palm or at the fingertips. Turn the palm with forearm `supination`,
upper-arm `rotation` and wrist `flexion`/`deviation`; the solver keeps your
wrist as keyed.

A contact also clears intersections, but only between the two body volumes it
names: a hand or finger bone covers the hand, a `LowerArm` bone the forearm,
`head` the head and neck, torso bones the torso. Declare a second contact if
the forearm also rests on the body. Finger collisions are allowed only between
the parts a contact names: two digits, or a digit and its palm, of one hand, or
any parts of the two hands when a contact joins them. A contact allows these
over its window and, when solved, over its blend ramps, while the solver moves
the hand onto and off the target.

While a contact joins the two hands, each hand is measured only against the
part of the other forearm more than a palm length from its wrist: pressed
palms (a clap, prayer hands) put the wrists inside the capsules' radii, and a
hand pressed into the forearm itself still fails. Declare only the solved
palm-to-palm contact; no check-only contacts are needed.
