# Joints, ranges and base pose

## Joints and components

Joints that share components are listed together. Each component gives its
meaning, then its natural range and its anatomical limit in degrees.

```text
hips
  flexion: Bend forward (+) or back (−). Natural -16..24, limit -20..30.
  lateralFlexion: Bend toward the Avatar's own left (+) or right (−). Natural -16..16, limit -20..20.
  rotation: Turn toward the Avatar's own left (+) or right (−). Natural -24..24, limit -30..30.
spine
  flexion: Bend forward (+) or back (−). Natural -12..24, limit -15..30.
  lateralFlexion: Bend toward the Avatar's own left (+) or right (−). Natural -12..12, limit -15..15.
  rotation: Turn toward the Avatar's own left (+) or right (−). Natural -12..12, limit -15..15.
chest
  flexion: Bend forward (+) or back (−). Natural -8..20, limit -10..25.
  lateralFlexion: Bend toward the Avatar's own left (+) or right (−). Natural -12..12, limit -15..15.
  rotation: Turn toward the Avatar's own left (+) or right (−). Natural -12..12, limit -15..15.
upperChest
  flexion: Bend forward (+) or back (−). Natural -8..16, limit -10..20.
  lateralFlexion: Bend toward the Avatar's own left (+) or right (−). Natural -8..8, limit -10..10.
  rotation: Turn toward the Avatar's own left (+) or right (−). Natural -12..12, limit -15..15.
neck
  flexion: Bend forward (+) or back (−). Natural -24..20, limit -30..25.
  lateralFlexion: Bend toward the Avatar's own left (+) or right (−). Natural -20..20, limit -25..25.
  rotation: Turn toward the Avatar's own left (+) or right (−). Natural -32..32, limit -40..40.
head
  flexion: Bend forward (+) or back (−). Natural -24..20, limit -30..25.
  lateralFlexion: Bend toward the Avatar's own left (+) or right (−). Natural -16..16, limit -20..20.
  rotation: Turn toward the Avatar's own left (+) or right (−). Natural -32..32, limit -40..40.
eyes
  yaw: Look toward the Avatar's own left (+) or right (−). Natural -15..15, limit -25..25.
  pitch: Look up (+) or down (−). Natural -12..12, limit -20..20.
  roll (auxiliary, leave at base): Roll the eyes about the line of sight.
leftShoulder, rightShoulder
  elevation: Shrug the shoulder girdle up (+) or depress it (−). Natural -10..25, limit -15..35.
  protraction: Round the shoulder forward (+) or pull it back (−). Natural -15..15, limit -20..20.
  rotation (auxiliary, leave at base): Turn the shoulder girdle about the collarbone.
leftUpperArm, rightUpperArm
  elevation: Raise the arm away from the body: 0 hangs down, 90 is horizontal, 180 is overhead. Natural 0..170, limit 0..180.
  planeOfElevation: Direction of the raise: 0 out to the side, 90 straight forward, above 90 across the body, below 0 behind. Natural -60..120, limit -90..140.
  rotation: Axial rotation: external (+) turns the palm forward from the hanging, palm-in position; internal (−). Natural -75..90, limit -95..105.
leftLowerArm, rightLowerArm
  flexion: Bend the elbow (+). Natural 0..140, limit -5..150.
  supination: Forearm rotation: supination (+) turns the palm up or forward; pronation (−) turns it down or back. Natural -75..80, limit -85..90.
  deviation (auxiliary, leave at base): Swing the forearm sideways at the elbow.
leftHand, rightHand
  flexion: Bend the wrist toward the palm (+) or back (−). Natural -60..70, limit -70..80.
  deviation: Tilt the hand toward the thumb (+) or little finger (−). Natural -30..20, limit -40..25.
  rotation (auxiliary, leave at base): Twist the hand about the forearm (forearm supination normally does this).
leftUpperLeg, rightUpperLeg
  flexion: Swing the thigh forward (+) or back (−). Natural -15..100, limit -20..120.
  abduction: Swing the thigh outward (+) or across the midline (−). Natural -20..35, limit -25..45.
  rotation: Turn the knee and toes outward (+) or inward (−). Natural -30..35, limit -40..45.
leftLowerLeg, rightLowerLeg
  flexion: Bend the knee (+). Natural -3..120, limit -5..140.
  rotation (auxiliary, leave at base): Twist the shin about its length.
  deviation (auxiliary, leave at base): Swing the shin sideways at the knee.
leftFoot, rightFoot
  dorsiflexion: Lift the toes (+) or point the foot (−). Natural -40..15, limit -50..20.
  inversion: Turn the sole inward (+) or outward (−). Natural -15..25, limit -20..35.
  rotation (auxiliary, leave at base): Turn the foot about the shin.
leftToes, rightToes
  flexion: Curl the toes down (+) or lift them (−). Natural -30..30, limit -40..40.
  rotation (auxiliary, leave at base): Turn the toes about the foot's vertical axis.
  deviation (auxiliary, leave at base): Tilt the toes sideways.
leftIndexProximal, leftIndexIntermediate, leftIndexDistal, leftMiddleProximal, leftMiddleIntermediate, leftMiddleDistal, leftRingProximal, leftRingIntermediate, leftRingDistal, leftLittleProximal, leftLittleIntermediate, leftLittleDistal, rightIndexProximal, rightIndexIntermediate, rightIndexDistal, rightMiddleProximal, rightMiddleIntermediate, rightMiddleDistal, rightRingProximal, rightRingIntermediate, rightRingDistal, rightLittleProximal, rightLittleIntermediate, rightLittleDistal
  curl: Bend the segment toward the palm (+) or back (−). Natural -5..90, limit -20..100.
  splay: Fan the segment toward the thumb side (+) or the little-finger side (−); use on proximal segments. Natural -22..22, limit -30..30.
  twist (auxiliary, leave at base): Roll the segment about its own length.
leftThumbProximal, leftThumbDistal, rightThumbProximal, rightThumbDistal
  curl: Fold the thumb across the palm (+) or extend it away (−), as the Hands tool's thumb Curl. Natural -50..70, limit -60..80.
  palmarAbduction: Lift the thumb out of the hand's plane toward the palm side (+) or back (−). Natural -35..40, limit -45..50.
  twist: Roll the thumb about its own length. Natural -30..30, limit -45..45.
```

## Base pose

The Relaxed Rest value of each component in degrees, which `"base"` stands
for.

```text
hips: flexion 0, lateralFlexion 0, rotation 0
spine: flexion 0, lateralFlexion 0, rotation 0
chest: flexion 0, lateralFlexion 0, rotation 0
upperChest: flexion 0, lateralFlexion 0, rotation 0
neck: flexion 0, lateralFlexion 0, rotation 0
head: flexion 0, lateralFlexion 0, rotation 0
eyes: yaw 0, pitch 0, roll 0
leftShoulder: elevation -2.9, protraction 0, rotation 0
leftUpperArm: elevation 16.6, planeOfElevation -10.2, rotation 0
leftLowerArm: flexion 5.6, supination 0, deviation 0
leftHand: flexion 6.1, deviation 0, rotation 0
leftUpperLeg: flexion 0, abduction 0, rotation 0
leftLowerLeg: flexion 0, rotation 0, deviation 0
leftFoot: dorsiflexion 0, inversion 0, rotation 0
leftToes: flexion 0, rotation 0, deviation 0
leftIndexProximal: curl 10.2, splay 0, twist 0
leftIndexIntermediate: curl 20.4, splay 0, twist 0
leftIndexDistal: curl 15.3, splay 0, twist 0
leftMiddleProximal: curl 10.2, splay 0, twist 0
leftMiddleIntermediate: curl 20.4, splay 0, twist 0
leftMiddleDistal: curl 15.3, splay 0, twist 0
leftRingProximal: curl 9.7, splay 0, twist 0
leftRingIntermediate: curl 19.4, splay 0, twist 0
leftRingDistal: curl 14.3, splay 0, twist 0
leftLittleProximal: curl 9.2, splay 0, twist 0
leftLittleIntermediate: curl 18.4, splay 0, twist 0
leftLittleDistal: curl 13.3, splay 0, twist 0
leftThumbProximal: curl 0, palmarAbduction 8.2, twist 0
leftThumbDistal: curl 0, palmarAbduction 6.1, twist 0
rightShoulder: elevation -2.7, protraction 0, rotation 0
rightUpperArm: elevation 19.4, planeOfElevation -9.8, rotation 0
rightLowerArm: flexion 5.4, supination 0, deviation 0
rightHand: flexion 5.9, deviation 0, rotation 0
rightUpperLeg: flexion 0, abduction 0, rotation 0
rightLowerLeg: flexion 0, rotation 0, deviation 0
rightFoot: dorsiflexion 0, inversion 0, rotation 0
rightToes: flexion 0, rotation 0, deviation 0
rightIndexProximal: curl 9.8, splay 0, twist 0
rightIndexIntermediate: curl 19.6, splay 0, twist 0
rightIndexDistal: curl 14.7, splay 0, twist 0
rightMiddleProximal: curl 9.8, splay 0, twist 0
rightMiddleIntermediate: curl 19.6, splay 0, twist 0
rightMiddleDistal: curl 14.7, splay 0, twist 0
rightRingProximal: curl 9.3, splay 0, twist 0
rightRingIntermediate: curl 18.6, splay 0, twist 0
rightRingDistal: curl 13.7, splay 0, twist 0
rightLittleProximal: curl 8.8, splay 0, twist 0
rightLittleIntermediate: curl 17.6, splay 0, twist 0
rightLittleDistal: curl 12.7, splay 0, twist 0
rightThumbProximal: curl 0, palmarAbduction 7.8, twist 0
rightThumbDistal: curl 0, palmarAbduction 5.9, twist 0
```
