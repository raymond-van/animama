# Frontend Docs

The frontend workspace contains the Vite app in `web/` and Electron runtime in
`desktop/`. For desktop use, start with
[Installation and availability](desktop/installation.md); no signed public
release is available yet.

Start here:

- `architecture/overview.md`: source map, route/provider flow, data flow, and
  commands.
- `architecture/routing.md`: TanStack Router route ownership and conventions.
- `architecture/auth-server.md`: FastAPI local HTTP serving, request policy,
  development proxy, renderer capability, and accountless runtime-readiness seam.
- `architecture/data-layer.md`: generated client and TanStack Query patterns.
- `architecture/i18n.md`: UI Locale resolution, catalogs, translation workflow,
  checks and the pseudo-locale.
- `architecture/content-and-workers.md`: runtime content, workers, and LFS notes.
- `architecture/local-content-runtime.md`: authenticated local HTTP byte
  delivery, ephemeral prepared mounts, degraded playback, no-hot-swap, and the
  shared web/Electron boundary.

Design:

- `design-system.md`: visual principles, theme tokens, type scale, component
  usage and motion.

Feature guides:

- `features/custom-anima-creation.md`: five-step live creator, exact sources,
  confirmed uploads, owner-scoped draft/retry recovery, and first-chat handoff.
- `features/anima-management.md`
- `features/avatar-releases-and-appearance.md`
- `features/anima-memory.md` (filesystem workspace and Memory Manager)
- `features/user-file-uploads.md`
- `features/model-settings.md` (model connections, models, roles and web search)
- `features/content-generation.md` (the Generate page: asking the content
  assistant for a Gesture, drafts and their checks, saving, and what reaches
  the model provider; local compositions only)
- `features/library.md`
- `features/user-profiles.md` (private display-name setup, 18+ confirmation,
  and personalization)
- `features/emotional-voice-catalog.md`

Runtime guides:

- `runtime/chat.md` (includes companion safety: AI notice, crisis card, Quick
  Chat mirror, Settings → Safety, and the protocol dialog and `/safety` page;
  see the [safety and crisis protocol](../safety/crisis-protocol.md))
- `runtime/voice.md`
- `runtime/elevenlabs-tts.md` (ElevenLabs realtime TTS with Eleven v4 Turbo)
- `runtime/gemini-tts.md` (Gemini cloud voice: availability, key, settings,
  errors and Google's terms)
- `runtime/sound.md`
- `runtime/avatar-animation.md`
- `runtime/vrm-optimization.md`: shrinking the VRMs Animama ships without changing them.
- `runtime/vrchat-avatar-conversion.md`: converting a licensed VRChat Avatar to VRM with Mochiya Avatar Tools.
- `runtime/mixamo-acquisition.md`: private manual-download checklist and deferred conversion.
- `runtime/content-previews.md`
- `runtime/avatar-planner.md`
- `runtime/avatar-lipsync.md`
- `runtime/avatar-emotion.md`
- `runtime/avatar-vfx.md`
- `runtime/avatar-particle-vfx.md`
- `runtime/scene-vfx.md`
- `runtime/vrm-inspector-editor.md`

Website:

- `landing-page.md`: the animama.ai home page: development server,
  production build and preview, closed-beta setting, shipped content and
  security headers.

Testing guides:

- `testing/browser-journeys.md`: isolated accountless Playwright setup,
  playback/creator/sharing journeys, exact receipt-based cleanup, and retained
  evidence; separate guidance covers manual main-stack checks.

For repository ownership, see [Repository boundaries](../architecture/repository-boundaries.md).

Desktop:

- [Installation and availability](desktop/installation.md)
- [Optional feature packs](desktop/feature-packs.md)
- [Troubleshooting, storage and recovery](desktop/troubleshooting.md)
- [Maintainer release process](desktop/release-process.md)
- [Runtime architecture](desktop/overview.md)
- [Platform development builds](desktop/platforms.md)
- [Runtime staging and inventory review](desktop/runtime-staging.md)
- [Size exception decisions](desktop/size-decisions.md)
- [Redistribution source evidence and outstanding review](desktop/redistribution-review.md)
- [Signing, acceptance and publisher reference](desktop/releases.md)
- [Picture-in-picture](desktop/picture-in-picture.md)
- [Quick chat](desktop/quick-chat.md)
- [Keyboard shortcuts](desktop/keyboard-shortcuts.md)
