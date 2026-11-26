# Send images to the Anima in chat

Status: Agreed
Owner decision: accepted by the owner on 2026-11-24 with the recommended
defaults recorded under Open questions and decisions.
Authority: [#904](https://github.com/raymond-van/animama/issues/904). This file
is a snapshot of that issue captured 2026-11-24T16:51:31Z; change the issue,
not this file.

## Problem and intended users

An Anima cannot see images. The chat composer accepts 14 document formats
(text, Markdown, CSV, HTML, Office and PDF) and rejects image files. Accepted
documents become text that the Anima reads through `search_uploaded_files` and
`read_uploaded_file_chunks`; images inside documents (DOCX pictures, scanned PDF
pages) are skipped.

The model catalog already records which models accept images
(`accepts: {"text", "image"}`), and Model settings shows those models with a
**Vision** chip. Chat never uses it: a user message is a plain string from
`message_builders.user_provider_message` through every model adapter, so even a
vision-capable model receives text only.

Intended users are people who chat with their Anima in the desktop app or a
self-hosted stack and want to show it something: a screenshot of an error, a
photo, a drawing or a page they are reading.

## Goals, scope and non-goals

Goals:

- Attach images to a chat turn from the composer by picking, pasting or
  dragging them in.
- A model that accepts images receives them with the message, on every model
  adapter family: OpenAI Responses, OpenAI-compatible Chat Completions and
  Anthropic Messages.
- Images appear as thumbnails in the composer, in the sent message and in
  reloaded chat history.
- With a model that does not accept images, the composer says so and no image
  is sent.

Non-goals:

- Image output: the Anima generating or returning images.
- OCR or other text extraction from images, including images inside documents
  and scanned PDFs.
- The hosted composition, which excludes chat uploads from its route inventory.
- Video and audio files.
- Showing images from other origins in replies; the same-origin Markdown image
  policy (#829) is unchanged.
- Camera or screen capture.

## Required behavior

### R1: Accepting and storing images

- **R1.1** The composer accepts PNG, JPEG, WebP and GIF images (a GIF
  contributes its first frame) through the existing attachment button
  (**Upload from computer**), by pasting from the clipboard and by drag and
  drop, in the web app and the desktop app. A turn carries at most 4 images,
  and an uploaded image is at most 20 MiB.
- **R1.2** The server identifies an image by its content, not its extension,
  and validates it with the existing bounded image validator
  (`content_image.py`): pixel and dimension limits, and a decode that fails on
  corrupt data.
- **R1.3** The server stores only a canonical copy through private file
  storage: orientation applied, metadata (EXIF, including GPS location)
  removed, and scaled down so its long edge is at most 2000 px. The uploaded
  original is not kept.
- **R1.4** An image is a user-file record. It is ready once stored, with no
  processing job, and is not chunked, embedded or returned by
  `search_uploaded_files`. Library → Chat uploads lists it with a thumbnail and
  the existing delete control, and the composer can attach it again from the
  list of existing files.
- **R1.5** A refused image shows the reason in the composer: unsupported
  format (the message names formats such as HEIC that are not accepted), too
  large, too many pixels, too many images in one turn, or unreadable.

### R2: Sending images to the model

- **R2.1** When the selected model's catalog capabilities accept `image`, the
  turn's user message carries its text and its images, in each adapter's own
  request format.
- **R2.2** When the selected model does not accept images, the composer
  disables image attachments and explains why. The chat API rejects a turn
  with image attachments with a clear error instead of dropping them silently.
- **R2.3** Image bytes never appear in `chat_messages.content`,
  `raw_provider_message`, stream events, logs or diagnostics. Persisted
  messages refer to their images by reference.
- **R2.4** Context fitting (`context_fit.py`) counts each image with a
  per-provider token estimate, so history trimming stays within the context
  window.
- **R2.5** Images from earlier turns are sent again while their turn remains
  in the fitted history, newest first, up to 20 images in one request. An
  image that is not sent appears to the model as a text placeholder that names
  it, so follow-up questions about a recent image work without attaching it
  again.
- **R2.6** Which earlier images are sent changes only when history is trimmed
  or the 20-image bound is passed, so provider prompt caching keeps working
  from turn to turn.

### R3: Showing images in chat

- **R3.1** A sent user message shows its images as thumbnails, both while
  chatting and after reloading the chat. Opening a thumbnail shows the image
  larger.
- **R3.2** An authorized same-origin route serves image bytes to the
  installation owner. No route serves user-file bytes today.
- **R3.3** Deleting a chat, or the image itself, removes its stored bytes. A
  message whose image is gone shows a placeholder.

### R4: Other readers of chat text

- **R4.1** The Memory Manager, episode processing, compaction summaries,
  chat full-text search and copied text see the image placeholder from R2.5,
  never image bytes.
- **R4.2** Local compositions add no moderation of image content; the selected
  provider's own safeguards apply. Text moderation is unchanged.

## Constraints

- Local compositions only: packaged desktop, built self-host and development.
- Privacy: images leave the machine only in requests to the chat model provider
  the person selected. Location and other metadata are removed before storage.
- Schema changes need a new Alembic revision with the ORM change (ADR 0035).
  Image references may fit in the existing `chat_messages.message_data` JSONB
  field without one.
- Before implementation, verify the request formats, size and count limits and
  token accounting for images against each provider's current official
  documentation.
- Accessibility: thumbnails have text alternatives (the filename), and
  attached images can be removed with the keyboard.
- API changes regenerate the frontend client through `pnpm openapi-ts`.

## Acceptance criteria

- [ ] For each adapter family (OpenAI Responses, OpenAI-compatible Chat
  Completions and Anthropic Messages), tests show the request the adapter
  builds for a turn with text and images. A manual check with a real
  vision model for each family gets a reply that describes the image.
- [ ] With a model that does not accept images, the composer disables image
  attachments with an explanation, and the API rejects a turn with images.
- [ ] Picking, pasting and dragging images work in the web app and the desktop
  app.
- [ ] A reloaded chat shows its thumbnails, and a deleted image shows a
  placeholder.
- [ ] Tests show that stored images carry no EXIF or GPS metadata, and that
  image bytes appear in no chat message row, stream event, log or memory file.
- [ ] Tests show that a follow-up turn sends the earlier image again, that the
  21st image in a request becomes a placeholder, and that context fitting
  counts images.
- [ ] Library → Chat uploads lists an image with its thumbnail, and deleting
  it there leaves a placeholder in the chat.
- [ ] Backend tests, `pnpm verify` and the affected browser tests pass. The
  user-files, chat and model-settings documentation describes the behavior.

## Open questions and decisions

Decisions (2026-11-24). People pay for their own provider usage in local
compositions, so the defaults favour behavior that works without surprises and
keep the cost of each turn bounded and predictable.

1. **Formats.** PNG, JPEG, WebP and the first frame of a GIF. HEIC/HEIF is
   deferred: it needs an extra decoder in the desktop bundle. It is refused
   with a message that names the format.
2. **Limits.** 4 images per turn, 20 MiB per uploaded image, and a stored long
   edge of 2000 px. The ExecPlan lowers a limit where a provider's documented
   limit requires it.
3. **Replay.** Earlier images are sent again while their turn is in the fitted
   history, up to 20 images in one request (R2.5, R2.6). Follow-up questions
   work on every provider, and a stable set of sent images keeps prompt caching
   effective.
4. **Storage model.** Images are user-file records and appear in Library → Chat
   uploads (R1.4).
5. **Moderation.** None is added for image content (R4.2).
6. **Originals.** Only the canonical copy is kept (R1.3).

Open questions: none blocking.

## Spec

This issue.

## ExecPlan

Required before implementation; not yet written. The change spans storage,
three model adapters, context fitting, a new byte route and the composer.

## Delivery links

To be added when the ExecPlan is written.
