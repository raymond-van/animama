# Let hosted compositions supply one consistent UI locale

Status: Published snapshot of [#576](https://github.com/raymond-van/animama/issues/576).
Publication capture: 2026-10-15T19:23:50Z; exact body verified.
Owner decision: 2026-10-15, approved the hosted locale prerequisite and requested
workspace setup and execution planning. Implementation awaits ExecPlan review.
Accepted revision: `hosted-locale-contract-2026-10-15-r1`.

## Problem and intended users

The emitted hosted app initializes language from an origin-local applied-language
cache and the browser language list. Once product admission is ready it resolves
the saved settings locale against that browser list. A visitor's explicit choice
made on another site cannot participate, and the applied-language cache does not
record whether a choice was explicit.

Hosted visitors and account holders need the resolution described in
[internationalization #385 R12–R15](https://github.com/raymond-van/animama/issues/385)
without a composition rebuilding or modifying emitted product screens. Local
desktop and self-hosted users must retain their existing behavior.

## Goals, scope and non-goals

Add the public composition contracts and emitted-app behavior needed for hosted
locale input before admission, subsequent refresh/switching and explicit settings
mutation intent. Ship the contracts in ordinary immutable artifacts and prove
them through public fixtures that run without private services or source.

Service-owned account storage, cross-site cookie configuration, email templates,
private service migrations, geolocation, deployment and artifact publication are
outside this repository-scoped outcome. No new locales or conversation-language
policy are introduced.

## Required behavior

- **H1 Initial resolution.** The hosted composition can provide a nullable saved
  account preference and a nullable explicit visitor preference before the first
  meaningful hosted screen renders, including signed-out and denied admission.
  Resolve account, visitor, ordered browser languages, then English using #385's
  existing matching contract. Keep both inputs distinct from the resolved tag.
  A stale applied-language cache cannot outrank them. Invalid/unavailable hints
  fall back safely without changing account or authentication authority.
- **H2 Switching and refresh.** Account changes, successful language changes and
  return to a tab refresh locale independently of authorization transitions.
  Preserve unsent chat text, creator edits, navigation, query ownership and audio.
  A delayed response belonging to a prior account or request cannot overwrite
  the newer state. Clear account-derived locale state on sign-out/account change.
- **H3 Picker meaning.** The nullable saved value remains System default. Its
  label describes the result after clearing this browser's visitor choice.
  Explicit locale/null changes are distinguishable from unrelated settings
  updates, and reset-all expresses an explicit clear. The composition owns the
  durable result and browser-persistence side effects; reusable UI contains no
  fixed parent domain or private-service URL.
- **H4 Server composition.** Shared settings handlers expose validated mutation
  intent to the composition before materialization loses omitted-versus-null
  information. Invalid or unauthorized requests must not trigger remote effects.
  A composition can perform an asynchronous authority update and report a
  confirmed or uncertain partial outcome without pretending to roll back an
  already committed remote preference. Preserve local transaction ownership and
  existing post-commit notifications; do not add a distributed transaction layer.
- **H5 Failure behavior.** Show translated retry/reconciliation messages for
  conflicts, unavailable authority and partial saves. Never claim an account
  preference was saved before confirmation, or unchanged after a confirmed remote
  save. Refresh authoritative state before retrying an uncertain outcome. Locale
  failure does not grant admission or discard private in-progress work.
- **H6 Compatibility.** Local/desktop resolution and settings behavior remain
  unchanged. The shared chat client continues sending the resolved `ui_locale`;
  the separate browser-region `locale` keeps its existing meaning. New contracts
  are documented/versioned and independently consumable. Older hosted backends
  lacking the optional locale input retain their existing fallback behavior.

## Constraints

Use existing supported-locale, matching, formatting and catalog helpers. No Cloud
checkout, private source, account credential or provider access may be required
to build or test this change. Preserve the closed same-origin transport and
accountless local runtime. Do not hand-edit generated SDK files or emitted assets.

Follow ADR 0017's common application boundary, ADR 0021's shared-route composition
boundary and ADR 0024's locale/conversation distinction. An internal Python port
change and a browser runtime contract need explicit compatibility review even
when the normal settings endpoint's JSON schema does not change.

## Acceptance criteria

- [ ] Public hosted fixtures demonstrate saved-over-visitor precedence, an
      anonymous visitor choice, all supported mappings, stale applied cache,
      invalid/missing inputs and English fallback before ready admission.
- [ ] Switching, focus refresh, sign-out and account changes preserve state;
      stale asynchronous responses cannot overwrite the active session's locale.
- [ ] Picker tests distinguish saved, unset and effective values; explicit null
      clears the visitor fallback and an unrelated settings update leaves it alone.
- [ ] Shared settings-route tests preserve omitted/null/reset intent and confirm
      no remote hook runs for invalid, conflicting-create or unauthorized input.
      Tests cover confirmed remote save followed by local failure and uncertain
      remote outcome, without unsafe compensating writes.
- [ ] Local settings and local/desktop startup regression checks pass; outgoing
      `ui_locale` follows every switch while browser-region `locale` is unchanged.
- [ ] Package boundary/isolated consumer tests and local builds pass. Rendered
      desktop and narrow checks use public fixtures; the appropriate fast browser
      journeys run on a disposable named built stack. Full journeys also run if
      actual implementation changes loadout/content behavior.
- [ ] The released artifacts can be consumed unchanged; no private dependencies,
      hard-coded account domains, credentials or injected application bytes exist.

## Open questions and decisions

The outcome is accepted. Exact interfaces and version increments are engineering
choices described in the draft ExecPlan, subject to compatibility evidence.
Implementation, exact-candidate merge, billed validation and artifact publication
retain their normal review and authorization gates.

## Spec

[#576](https://github.com/raymond-van/animama/issues/576) is authoritative; this
file is its dated snapshot.

## ExecPlan

[Hosted locale contract ExecPlan](hosted-locale-contract-execplan.md), draft pending
review. It contains only this repository's implementation and public fixtures.

## Delivery links

Source requirements: [#385](https://github.com/raymond-van/animama/issues/385).
Branch: `feat/hosted-locale-contract`; source base:
`dca4af86da2ce21386b21ebed6d8175c674d58be`.
Phases: [#577](https://github.com/raymond-van/animama/issues/577), then
[#578](https://github.com/raymond-van/animama/issues/578).
