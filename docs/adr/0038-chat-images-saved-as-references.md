# 0038: Chat images are saved as references to one stored copy

- Status: accepted (owner, 2026-11-24)
- Recorded: 2026-11-24
- Retrospective: no
- Original decision date: 2026-11-24 (owner approval of the plan for
  [issue #904](https://github.com/raymond-van/animama/issues/904))
- Decision basis: Agent proposals D1 and D2 in the
  [execution plan](../plans/chat-image-input/chat-image-input-execplan.md)
  Decision Log, approved by the owner with the plan; the agreed behavior is in
  the [specification snapshot](../plans/chat-image-input/chat-image-input-spec.md)
- Amended: 2026-11-26, deleting an Anima deletes the images only its chats use,
  reversing D13 (owner decision in
  [issue #950](https://github.com/raymond-van/animama/issues/950); see
  Consequences).

## Context

Local compositions let the person attach images to a chat message, and the
Anima's model sees them. Every adapter replays earlier turns from saved
messages: a user row keeps a Chat Completions-style `raw_provider_message`,
which the executor resends while the turn stays in the fitted history
(R2.5). Image bytes have to come from somewhere on every such request.

The images are the person's own pictures and screenshots, often private. The
specification requires that their bytes never appear in `chat_messages`
content, `raw_provider_message`, stream events, logs or diagnostics (R2.3),
that the server keep only a canonical copy with metadata removed (R1.3), and
that deleting an image remove its bytes (R3.3).

## Decision

1. **Saved messages refer to images; they never hold bytes (D1).** A user
   message with images is saved as its text plus one reference part per
   image (the user-file ID, name, width and height). The message text names
   each image as an `[Image: name]` line for every reader without images
   (memory, search, compaction), and `data` keeps the person's own text for
   the chat bubble. Just before a request, the executor loads the
   referenced bytes from private storage into the request beside the prompt,
   and each adapter writes them in its provider's format. An image whose bytes
   are gone is sent as its placeholder line.
2. **One stored copy per image (D2).** When an upload is finalized, the
   canonical copy (orientation applied, metadata removed, long edge at most
   2,000 px, PNG or JPEG) replaces the uploaded bytes at the same private
   locator. The image is an ordinary user file: the existing delete, storage
   accounting and ownership checks apply, and the same copy serves the model,
   the transcript and the owner-only byte route.

## Alternatives

- **Inline bytes in saved messages.** Simplest to replay, but every user row
  would carry base64 data: rows grow by megabytes, history reads, logs,
  exports and diagnostics would all have to strip it, deleting an image would
  mean rewriting messages, and token estimates would count the base64 text.
- **Provider file uploads.** OpenAI and Anthropic offer file APIs, so a
  message could refer to a provider file ID. Each provider and connection would
  hold its own copy with its own lifetime, a model switch would upload again,
  OpenAI-compatible local servers have no such API, and deleting an image in
  Animama would not delete it at the provider.
- **A separate image store.** A dedicated table and storage area for chat
  images would duplicate the user-file lifecycle (upload, finalize, delete,
  ownership, Library listing) that images already fit.

## Consequences

- Bytes are read from storage once per turn and held in memory only for that
  turn's requests (tool rounds and a retry), at most 20 images per request
  (newest first).
- A deleted or changed image leaves its reference: history shows a
  placeholder, the model sees the placeholder line, and the turn that attached
  it stays readable.
- Deleting a chat deletes the images only that chat uses (D12). Deleting an
  Anima first left its chats' images in the Library (D13). Amended 2026-11-26:
  [issue #950](https://github.com/raymond-van/animama/issues/950) reverses
  D13, and deleting an Anima now deletes the images only its chats use, by the
  same rule.
- OpenAI Responses conversations that OpenAI stores (`store: true`, used for
  the `previous_response_id` cursor) hold the images the provider received;
  that copy follows the provider's retention, not Animama's delete.
- Animama Cloud must add the two repository methods chat deletion uses
  (`image_file_ids_only_in_chat`, `record_file_deleted`) to its user-file port
  when it adopts this release: the shared chat delete route calls them, so
  without them every hosted chat delete fails.

## Evidence

- Phases 1–4 of the execution plan, with their check records and reviews:
  `content_image.py` (canonical copy), `server/routers/user_files.py`
  (`_store_canonical_image` at finalize and `:process`) with
  `user_file_service.py` (the locked storage write), `app/model_clients/image_parts.py`
  (reference parts, selection, placeholders), `app/chat/attached_images.py`
  and the three adapters' `request.py`.
