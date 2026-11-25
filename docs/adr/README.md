# Architecture decision records

ADRs explain significant product and architecture choices, generally developed
through human–AI collaboration. They preserve why a choice was made; current
architecture docs explain how the system works and the [glossary](../../GLOSSARY.md)
establishes common meanings between Raymond and agents.

## Index

Records 0001–0005 document foundational decisions retrospectively; records 0006–0007
record lifecycle and planning ownership decisions; later records document product
decisions, except 0027, which amends the lifecycle with risk-tiered review, and
0037, which opens the repository to outside contributions. Each record states its decision basis
and dates. Acceptance is not proof of unknown historical human approval,
production readiness or publication rights.

| ID   | Decision                                                                                                                                           | Status                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 0001 | [Independent local product and packaged sharing](0001-independent-local-product-and-packaged-sharing.md)                                           | accepted                                                      |
| 0002 | [Accountless installation ownership and local HTTP admission](0002-accountless-installation-and-http-admission.md)                                 | accepted                                                      |
| 0003 | [Request-local direct chat and streamed delivery](0003-request-local-streamed-chat.md)                                                             | accepted                                                      |
| 0004 | [Filesystem content, catalog persistence and recoverable mutations](0004-filesystem-content-and-recoverable-mutations.md)                          | accepted                                                      |
| 0005 | [Client-rendered shared UI and local/native composition](0005-client-rendered-ui-and-local-native-composition.md)                                  | accepted                                                      |
| 0006 | [Human and AI software development lifecycle](0006-human-ai-software-development-lifecycle.md)                                                     | accepted; planning superseded by 0007, review amended by 0027 |
| 0007 | [Repository-owned specifications and execution plans](0007-repository-owned-planning.md)                                                           | accepted                                                      |
| 0008 | [Non-overridable companion guardrail](0008-non-overridable-companion-guardrail.md)                                                                 | accepted; placement amended by 0023 and on 2026-10-25                           |
| 0009 | [Shared user memory and per-Anima relationship memory](0009-shared-user-memory-and-per-anima-relationship-memory.md)                               | accepted; partly superseded by 0034                           |
| 0010 | [Shared voice model objects and optional downloads](0010-shared-model-object-distribution.md)                                                      | accepted; partly superseded by 0012 and 0036; amended on 2026-11-04 |
| 0011 | [Application-owned companion features and composition catalog policy](0011-application-owned-companion-features-and-composition-catalog-policy.md) | accepted; amended on 2026-09-30 and 2026-11-03                |
| 0012 | [Parakeet speech models as backend model assets](0012-backend-parakeet-model-assets.md)                                                            | accepted; amended on 2026-11-04; partly superseded by 0036    |
| 0013 | [Native Windows desktop packaging](0013-native-windows-desktop-packaging.md)                                                                       | accepted                                                      |
| 0014 | [Track-based Anima Pose Clips organised by beats](0014-track-based-anima-pose-clips.md)                                                            | accepted; partly superseded by 0016 and 0019                  |
| 0015 | [One Avatar Effect definition source and model-agnostic face parts](0015-avatar-effect-definition-source-and-face-parts.md)                        | accepted                                                      |
| 0016 | [animaPoseClip/2.0 is the only clip format](0016-anima-pose-clip-2-only.md)                                                                        | accepted                                                      |
| 0017 | [Common web application and hosted artifact](0017-common-web-application-and-hosted-artifact.md)                                                   | accepted                                                      |
| 0018 | [Non-portable Included content for licensed built-in motion](0018-non-portable-included-content.md)                                                | accepted; Idle Style part superseded by 0026                  |
| 0019 | [Hand keys with fitted presets and per-finger offsets](0019-hand-keys-with-fitted-presets-and-finger-offsets.md)                                   | accepted                                                      |
| 0020 | [Solved hand contacts](0020-solved-hand-contacts.md)                                                                                               | accepted                                                      |
| 0021 | [Shared product HTTP routes for every composition](0021-shared-product-http-routes.md)                                                             | accepted                                                      |
| 0022 | [Optional licensed sounds for built-in effects](0022-optional-licensed-effect-sounds.md)                                                           | proposed; amended by 0025 and on 2026-10-16                   |
| 0023 | [Native Anthropic Messages provider](0023-native-anthropic-messages-provider.md)                                                                   | accepted; amended on 2026-11-01                               |
| 0024 | [The UI Locale is the conversation language](0024-ui-locale-is-the-conversation-language.md)                                                       | accepted; amended by 0029 and 0031                            |
| 0025 | [Per-use Avatar Effect overrides](0025-per-use-avatar-effect-overrides.md)                                                                         | accepted                                                      |
| 0026 | [One built-in Idle pool per Anima replaces Idle Style content](0026-built-in-idle-pool-per-anima.md)                                               | accepted                                                      |
| 0027 | [Risk-tiered review and a single suite run per candidate](0027-risk-tiered-review-and-single-suite-run.md)                                         | accepted; amends 0006                                         |
| 0028 | [Browser-cacheable runtime revision members](0028-cacheable-runtime-revision-members.md)                                                           | accepted; amended on 2026-10-28                               |
| 0029 | [SenseVoice-Small for Japanese, Korean and Chinese offline speech recognition](0029-sensevoice-offline-speech-recognition.md)                      | accepted; amended by 0031 and on 2026-11-04                   |
| 0030 | [An Anima's Gestures are its binding rows](0030-anima-gestures-are-binding-rows.md)                                                                | accepted                                                      |
| 0031 | [The offline speech engine is the owner's choice](0031-offline-speech-engine-is-the-owners-choice.md)                                              | accepted; amends 0024 and 0029                                |
| 0032 | [VRM stays the Avatar container; ARKit shapes are a face capability](0032-vrm-container-with-arkit-face-shapes.md)                                 | accepted                                                      |
| 0033 | [Digest-keyed URLs for Included content files](0033-digest-keyed-included-content-file-urls.md)                                                    | proposed                                                      |
| 0034 | [Automatic episode processing and the profile in every turn](0034-automatic-episode-processing-and-profile-context.md)                             | accepted; partly supersedes 0009                              |
| 0035 | [Released schemas change only through forward migrations](0035-released-schema-changes-use-forward-migrations.md)                                 | accepted                                                      |
| 0036 | [Uploads are processed in the core server without Docling](0036-uploads-processed-in-core-server.md)                                               | accepted; partly supersedes 0010 and 0012                     |
| 0037 | [Outside contributions are accepted under a contributor licence agreement](0037-outside-contributions-under-a-cla.md)                              | accepted; amended on 2026-11-25                               |
| 0038 | [Chat images are saved as references to one stored copy](0038-chat-images-saved-as-references.md)                                                  | accepted                                                      |
| 0039 | [A ChatGPT plan sign-in is a model connection's credential](0039-chatgpt-plan-sign-in-and-connection.md)                                         | accepted                                                      |

## When and how to record a decision

Create an ADR when reversal has meaningful cost, the choice needs its context to
be understood, and there is a genuine trade-off between alternatives. Routine
implementation details and task progress belong in their existing records.

1. Read relevant glossary entries, ADRs, current docs and representative source.
   Surface contradictions; distinguish observed behavior from documented intent.
2. Use the next sequential `NNNN-short-slug.md` in this repository. Recheck before
   landing concurrent additions and repair links if an unaccepted record is renumbered.
3. Write concise context, decision and rationale, with evidence. Include alternatives
   and consequences when they explain a real trade-off; do not invent past deliberation.
4. Mark unresolved choices `proposed`. An AI agent may mark a record `accepted`
   only when it records a decision the owner already made or a contract the
   system already implements; a new choice stays `proposed` until the owner
   decides it. Record the decision basis; this grants no authority to make
   otherwise unauthorized product or architecture changes.
5. Add the record and its status to this index. Correct current documentation
   made incomplete or misleading by the decision; an ADR is not a usage guide.

## History, corrections and supersession

Use `proposed`, `accepted`, `deprecated` or `superseded`. Deprecated means the
choice no longer applies without a replacement; superseded records link a successor.
A changed significant decision gets a new ADR, with reciprocal links and the index
updated when the successor is accepted. Preserve the old decision and rationale.
Corrections may clarify facts or evidence without silently replacing the original choice.

A retrospective record separates its recording date from original decision dates.
Write unknown dates, authorship or rationale as unknown. Identify present-day
justification as such. Accepting a record today does not prove who approved the
original implementation or why they chose it. Unknown historical rationale alone
does not prevent accepting an accurately evidenced current boundary.

References must resolve within Animama or to independently accessible material.
Do not link private plans, copy approval transcripts or require a Cloud checkout.
Keep detailed historical investigation and private evidence with their private
planning owner; state any uncertainty needed to understand the record here.

## Authoring template

Copy this structure into the new record; replace all placeholders. Recording dates
use `YYYY-MM-DD`. Evidence should link
specific source files or durable docs, with symbols or sections when helpful.

```markdown
# NNNN: Decision title

- Status: proposed
- Recorded: YYYY-MM-DD
- Retrospective: yes / no
- Original decision date: YYYY-MM-DD with evidence, or unknown
- Decision basis: documented decision / observed current contract / new proposal

## Context

The problem and relevant constraints.

## Decision

The chosen boundary or behavior.

## Rationale and consequences

Documented reasons, present-day justification and unknown historical rationale,
clearly distinguished. Alternatives and consequences only when useful.

## Evidence

Links supporting the claims; explain what each establishes.
```

Follow the [domain documentation guide](../agents/domain.md) for terminology
conflicts, current documentation and authorization boundaries.
