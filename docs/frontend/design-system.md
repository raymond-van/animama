# Design system

Animama's web and desktop UI is built from Tailwind CSS v4 utilities, theme
tokens and shadcn-style components. This guide records the visual rules that
keep screens consistent. Agents should also use the `animama-ui` skill for the
design and visual-verification workflow.

## Principles

- **The Avatar is the focal point.** Where an Avatar is visible, the
  surrounding UI frames it; UI motion and color must not compete with Gestures
  or emotion changes.
- **Restraint.** One primary action per view, muted secondary text, borders
  before shadows, and whitespace before dividers.
- **Design every state.** Empty, loading, error, overflowing content, both
  themes and keyboard focus are part of the design, not follow-up work.
- **Extend, do not fork.** Reuse the nearest existing screen's layout and
  components before introducing a new pattern.

## Where the tokens live

| Source | Owns |
| --- | --- |
| `src/frontend/packages/product-ui/src/theme.css` | Color, status, radius, shadow and `text-2xs` tokens for light and dark themes |
| `src/frontend/web/src/styles/globals.css` | Typeface, body weight and app-wide base styles |
| `src/frontend/web/src/lib/theme/appearance-overrides.ts` | Owner color overrides in Settings > Appearance |

The web app consumes the built package stylesheet, so run `pnpm check` (or the
package build) after editing `theme.css`.

## Color

Use the semantic token classes, never hex, `rgb()` or Tailwind palette colors,
for surfaces, text, borders and brand color.

| Role | Classes |
| --- | --- |
| Page and panels | `bg-background`, `bg-card`, `bg-popover`, `bg-sidebar` |
| Text | `text-foreground`; `text-muted-foreground` for secondary copy and metadata |
| Brand | `bg-primary text-primary-foreground`, `bg-secondary`, `bg-accent` (accent is also the hover wash for ghost and outline controls) |
| Danger | `bg-destructive`, `text-destructive` |
| Status | `text-success`, `text-warning`, `text-info` |
| Lines and focus | `border` (color defaults to `--border`), `border-input`, `ring-ring` |

Brand hues (primary, secondary, accent and their sidebar and ring
counterparts) are provisional, particularly in dark mode. Design by role and do
not rely on a token's current hue. Owners can also override colors in
Settings, so contrast must hold for the role rather than one specific value.

Status tokens are text and icon hues. Build status surfaces from the same
token with opacity, typically `/10` (or `/5` for quieter) surfaces and `/30`
borders:

```tsx
<div className="border-warning/30 bg-warning/10 text-warning rounded-md border p-3">
```

Use solid `bg-success`, `bg-warning` or `bg-info` only for small indicators such
as status dots. Palette colors remain acceptable for decorative illustration
and data categories, such as diff lines, timeline track kinds or file-type
icons.

Chat bubbles are borderless frosted glass: `MessageContent` draws the
`--bubble-user` and `--bubble-anima` tints with the `.animama-glass-bubble`
surface in `theme.css`. `--bubble-user-glass` and `--bubble-anima-glass` choose
glass (1) or a plain solid fill (0). Bubbles are solid under
`prefers-reduced-transparency`, inside `.animama-solid-bubbles` (Quick Chat's
transparent window, where glass has nothing to blur) and for a Primary or
Secondary override, whose text colour is chosen for a solid fill. Where
`backdrop-filter` is unsupported the tint is opaque.

## Typography

- The root font size is 18px; rem-based Tailwind sizes scale with it.
- Sizes: `text-2xs` for compact metadata and badges, `text-xs` for dense creator
  panels and captions, `text-sm` for most UI text, `text-base` and larger for
  headings. Do not use pixel sizes such as `text-[11px]`; they do not scale with
  the root.
- Weight: body text is regular (400). Use `font-medium` for labels and controls,
  `font-semibold` for headings and emphasis, and `font-bold` sparingly.
- The typeface is DM Sans, self-hosted through `@fontsource-variable/dm-sans`.

## Spacing, shape and elevation

- Use the 4px Tailwind spacing scale. Reserve arbitrary `[Npx]` values for
  fixed media, canvas or viewport sizes.
- Radius derives from `--radius` (0.5rem): `rounded-md` for controls,
  `rounded-lg` or `rounded-xl` for cards and panels, and `rounded-full` for
  avatars, pills and dots. Keep one radius per component level.
- Keep shadows subtle (`shadow-xs`, `shadow-sm`); use `shadow-lg` and above only
  for floating layers such as dialogs and popovers.

## Components and icons

Import primitives from `@/ui/components/*` rather than hand-rolling `<button>`,
`<input>` or `<select>` elements; primitives carry consistent focus, hover and
disabled states.

| Button variant | Use |
| --- | --- |
| `default` | The single primary action in a view |
| `outline` | Secondary actions |
| `ghost` | Toolbars and low-emphasis actions |
| `destructive` | Confirmed destructive actions |
| `link` | Inline navigation |

Use `size="sm"` and `size="icon-sm"` in dense creator panels. Icons come from
`lucide-react`; icon-only buttons need an accessible label and usually a
Tooltip.

## Motion

Animate state changes, not decoration: `duration-150` or `duration-200`
transitions for hover and disclosure, and `motion` for layout and presence
changes. Respect reduced-motion preferences, as required by the
[frontend guide](../../src/frontend/AGENTS.md).
