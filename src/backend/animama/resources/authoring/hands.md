# Hands

Key hands in `hands.left` and `hands.right`. Each key names a `preset`, then
optional whole-hand `curl` (±90°) and `spread` (±30°), then optional per-finger
`fingers` offsets, applied in that order. Presets are fitted to each Avatar's
fingers when the Gesture plays.

| Preset | Use for |
| --- | --- |
| `relaxed` | Rest, idle hands and the moments between actions |
| `open-together` | Presenting, waving, "stop" |
| `open-spread` | Surprise, excitement, big reveals |
| `palm-flat` | A palm resting or pressed on something: hips, forearm, chest, cheek |
| `cupped` | Claps, cradling, holding something round |
| `soft-claw` | Paws, "rawr", playful grabbing |
| `fist` | Determination, cheering, punching |
| `point` | Pointing with the index |
| `peace` | The V sign |
| `thumbs-up` | Thumbs up; turn the forearm for thumbs down |
| `pinch` | Index and thumb pads together, other fingers folded: a blown kiss, "a little bit", holding something small |
| `ok` | The OK sign: a pinch with the other fingers raised and fanned |

`pinch` and `ok` curl the index and aim the thumb on each Avatar so the pads
meet. Offsets on their index or thumb pull the pads apart; vary the other
fingers instead.

```json
"hands": {
  "right": [
    { "beat": "start", "preset": "relaxed" },
    { "beat": "raise", "dt": -0.1, "preset": "open-together", "spread": 8 },
    { "beat": "lower", "dt": -0.2, "preset": "open-together", "spread": 8 },
    { "beat": "settle", "dt": -0.2, "preset": "relaxed" }
  ]
}
```

- Each key is a held shape; the hand eases between neighbouring keys and
  settles on each. Put the shape change slightly before the arm arrives
  (0.05–0.15 s) and repeat a key to hold a shape.
- Before the first key and after the last the hand holds that shape; a hand
  without keys stays at Relaxed Rest. Thumb metacarpals are never changed.
- If a shape still needs work, say so in your note: it can be finished in the
  creator's Hands tool on that beat.

## Finger offsets

`fingers.<digit>` (`thumb`, `index`, `middle`, `ring`, `little`) adjusts one
digit of the key's shape, in the joint model's degrees:

- Fingers: `curl` (+ toward the palm) and `splay` (+ toward the thumb side;
  proximal segment only).
- Thumb: `curl` (+ folds across the palm), and on its proximal segment
  `palmarAbduction` (+ lifts it out of the hand's plane toward the palm side)
  and `twist` (rolls it about its length).
- `curl` is one value for every segment or a list of one value per segment
  from the knuckle out: three for a finger, two for the thumb. Other fields are
  single values. Every value is from −90 to 90.
- Offsets belong to the key's beat and blend to the neighbouring keys with the
  preset. A digit without offsets keeps the shape; zero offsets are dropped on
  save.

A softer point, the index slightly bent and the middle finger half open:

```json
{
  "beat": "point",
  "preset": "point",
  "fingers": {
    "index": { "curl": [0, 10, 15] },
    "middle": { "curl": [-25, -15, 0] }
  }
}
```

## When to key finger joints

Key finger segments in `joints` (for example `rightIndexDistal.curl`) only for
what offsets cannot express: a finger twist, splay beyond the proximal segment,
or a finger moving on its own throughout the clip (tapping, wiggling). A keyed
finger joint replaces the hand key on that segment for the whole clip, so the
hand keys no longer shape it.

## Contact shapes

When a hand touches something, choose the shape for the contact:

- A palm resting on the body or pressed flat on something: `palm-flat`.
- Claps: `cupped`, so the palms meet with slightly bowed fingers.
- Fingertips meeting (a kiss, a pinch, the OK sign): `pinch` or `ok`.
- A chin resting on the hand: a soft fist, either `cupped` with `curl` 30–40
  or `fist` with offsets that open the knuckles (`"curl": [-30, -15, 0]` on each
  finger). Do not use `fist` with a negative `curl`: it reads as a claw.
