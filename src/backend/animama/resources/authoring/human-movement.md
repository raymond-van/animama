# Human movement

Use when choosing joint values. Angles are degrees in Animama's anatomical
convention; the canonical basis has the Avatar facing +Z with its own left at
+X. The [joint list](joints.md) gives every component's meaning, natural
(soft) range and anatomical (hard) limit; values beyond the soft range are
reported as warnings, beyond the hard limit as failures. Limits summarize AAOS
and Soucie et al. (2011) adult normative ranges, distributed by Animama across
rig segments.

## Components at a glance

| Joint | Components (positive direction) |
| --- | --- |
| hips, spine, chest, upperChest, neck, head | `flexion` forward, `lateralFlexion` toward own left, `rotation` turn to own left |
| eyes | `yaw` look to own left, `pitch` look up. Live gaze (cursor look-at and the model's look-at) can override keyed eyes; mute `cursorLookAt`, keep eye moves small and let the head carry direction |
| Shoulder (girdle) | `elevation` shrug up, `protraction` round forward |
| UpperArm | `elevation` 0 hanging … 90 horizontal … 180 overhead; `planeOfElevation` 0 to the side, 90 straight forward, >90 across the body, <0 behind; `rotation` external (+) |
| LowerArm | `flexion` bend elbow; `supination` palm up/forward (+), pronation (−) |
| Hand | `flexion` toward the palm; `deviation` toward the thumb (+) |
| UpperLeg / LowerLeg / Foot / Toes | hip `flexion`, `abduction`, `rotation`; knee `flexion`; ankle `dorsiflexion`, `inversion` (only with `plantFeet: false`); toe `flexion` (always keyable) |
| Finger segments | `curl` toward the palm, `splay` toward the thumb side (proximal) |
| Thumb segments | `curl` across the palm, `palmarAbduction`, `twist` |

Base (Relaxed Rest) has arms hanging at about 17° elevation, elbows 6°,
wrists 6°; the torso and legs are neutral.

## Coupled motion

Real joints rarely move alone. Add the partners:

- **Arm above ~90°:** the shoulder girdle elevates (10–20°) and the chest
  leans slightly away; overhead reaches also protract the shoulder 5–10°.
- **Turning to look:** eyes and head lead, neck follows, chest turns about a
  third as much, hips barely; split a 40° turn roughly head 20, neck 12,
  upperChest 5, chest 3.
- **Bending forward or back:** distribute across spine, chest and upperChest
  (for example 6/8/6) rather than one joint; add hips flexion for big bows.
- **Weight shift:** hips offset 2–4 cm toward the supporting side with a
  1–2 cm drop, pelvis lateral flexion 2–4° away, chest counter-tilt 2–3°.
  `plantFeet` bends the knees to keep the feet down.
- **One-arm gestures:** turn the chest a few degrees toward the acting arm
  (right arm → negative chest `rotation`) so the gesture opens to the viewer,
  lean the chest slightly away from it (left `lateralFlexion` for a right arm
  raise) and shift the hips away (toward the Avatar's left, +x) as
  counterbalance. The wave example does all three.
- **Laughing or excitement:** chest flexion/extension pulses 3–6° with
  shoulder elevation pulses; head tilts back 5–10° at the peak. Pace the
  pulses as in [Laughing and bouncing](#laughing-and-bouncing).

## Laughing and bouncing

Repeated pulses (laughs, giggles, bounces, sobs) read as shivering above
about 4 Hz; the checks warn when three cycles or more run that fast
(`oscillation`). Pace them like breathing:

- **Rhythm:** 2.5–3.3 Hz, so 0.15–0.2 s from each peak to the next trough.
  Key every turn explicitly; a pulse is a peak and a trough, not a value at
  every frame.
- **Bursts:** 3–4 cycles per burst, each about a third smaller than the one
  before, then a breath (0.3–0.6 s of slower recovery) before any next
  burst. A long laugh is several such bursts, not one steady buzz.
- **Staggered chain:** the trunk leads and the rest follows, 0.03–0.06 s
  apart down the chain (spine and chest, then upperChest and shoulders, then
  neck and head), so the pulse travels instead of every joint ticking
  together. Arms ride the torso: keep elbows and wrists still or give them one
  slow drift per burst, not a flap per pulse.
- **Shape:** a quick contraction (forward chest flexion, shoulders up) and a
  slightly slower release reads as a laugh. The checks rate whole cycles, so
  the asymmetry is fine as long as each contraction plus release takes
  0.3–0.4 s.
- Pulse offsets keyed with `dt` on one beat do not change when the beat is
  retimed; give each burst its own beat so it can be moved.

## Arm orientation

- **Where a bent forearm points is set by upper-arm rotation.** With the arm
  raised to the side and ~80° external rotation, elbow flexion lifts the
  forearm vertically (waving, hand up). Unwind that rotation before or while
  lowering the arm, or the forearm swings out to the side; internal rotation
  brings it in front of the body.
- **Palm direction** comes from forearm `supination` plus upper-arm rotation:
  arm hanging, supination 0 → palm faces the thigh; +80 → palm forward;
  −60 → palm back. Declare `facing` on the contact (or a large-tolerance
  contact on the part the palm should face) and the checks warn when the palm
  turns more than 45° away. Measured on Annie and the VRoid VRM 0 test fixture
  (not yet re-measured on Andrew):
  - **Wave, palm to the viewer:** external rotation ~80 and elbow 90–110,
    then either plane 0 with supination 0 (about 16° from the viewer at
    elevation 60–90), or plane ~20 with supination −20 and elbow ~110 (8° at
    elevation 90, 13° at 75, 18° at 60). Mixing the two (plane 20 with
    supination 0, or plane 0 with −20) lands 20–31° off, and positive
    supination turns the palm further away (about 45° at +20 with plane 20).
    For a small wave keep the wrist out from the body centre, about shoulder
    width.
  - **Face palm, palm on the face:** elevation 75–90, plane 80–110, external
    rotation 60–80, elbow ~125, supination ~60, wrist 0 to −20 put the palm
    over the eyes, facing the face.
  - **Kiss, fingertips at the lips with the palm toward the mouth:**
    elevation ~35, plane ~110, external rotation ~80, elbow ~140,
    supination ~40, wrist 0 to −30 (bent back). Keep the palm turned toward
    the mouth on the way up as well.
- **Reaching forward:** `planeOfElevation` 70–100 with elevation 60–90 and
  elbow 20–60; across the body uses plane 110–135.
- **Palms up, forearms out (shrug, "who knows"):** upper arm elevation ~20,
  plane ~15, external rotation ~45; elbow ~85; supination ~75–80; wrist
  `flexion` −10 to −20 (bent back); `open-together` hands. Elbows stay near the ribs.
- **Hands meeting in front (clap, prayer):** arms forward and slightly
  raised with upper-arm rotation bringing the forearms together (about 43°
  closed, 60–70° open), elbows 70–100 and wrists bent back −30 so the palms
  face each other. Find the exact values with a declared hand-to-hand contact
  and the reported actual offset rather than by eye.
- **Pointing or reaching to the side:** plane 15–30 (slightly forward reads
  more natural than pure lateral), elevation 70–85, elbow 5–15, rotation near
  0 and supination near 0 for a palm-down point; add the `point` hand preset.
- **Touching the head or chest:** combine elevation, plane and elbow flexion
  to bring the hand there, check with a declared contact, then fine-tune. With
  the arm forward, positive (external) rotation lifts the bent forearm toward
  the face; for a hand under the chin try elevation ~60, plane ~90,
  rotation ~55, elbow ~140. A forearm folded across the body under the other
  elbow uses rotation ~20 and elbow ~80.

## Planted feet

With `plantFeet` true, playback solves hip, knee and ankle each frame on each
Avatar's own rig, so both keep their feet still. Keep pelvis rotation within
±15° and offsets within a few centimetres so the legs can reach; the checks
report slides and lifts on each Avatar.
