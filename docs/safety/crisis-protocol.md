# Animama safety and crisis protocol

**If you are in immediate danger, call your local emergency number now.**

Animas are AI characters, not people. They are not a substitute for
professional help and do not provide therapy, counseling or medical treatment.
Like any AI, they can make mistakes, and they cannot call for help for you.

## Who Animama is for

Animama is for adults 18 and older; AI companions may not be suitable for some
minors. Setup asks you to confirm your age. Animama does not verify it.

## Knowing you're talking to an AI

- If you sincerely ask whether an Anima is a person, it is instructed to say it
  is an AI (it may play along inside a story you set up).
- The app shows a short notice, "You're talking with *name*, an AI — not a
  person," on your first message each day and after every 3 hours of
  continuing conversation. You can make the reminder more frequent in
  Settings → Safety.
- Animas are also instructed not to claim to be a therapist, not to pressure or
  guilt you into staying, and to support your relationships with other people.

## If you mention suicide or self-harm

- Animas are instructed to respond with care, encourage you to reach out to
  someone you trust or a crisis line, and never give methods or encouragement.
- A moderation check also reads your message. If it flags possible suicide or
  self-harm, the app shows a crisis card after the reply with crisis lines for
  your region. The Anima cannot hide or change the card.
  - On Animama Cloud, the web demo, OpenAI's moderation service checks every
    message, whichever model the Anima uses.
  - Elsewhere, including the desktop app, only OpenAI Responses models used
    with an API key check messages, as part of the same request. Other
    providers, such as Anthropic, and models used through a ChatGPT plan have
    no check and no card, so only the Anima's instructions above apply.
- The check can miss or misread messages. Chat is never blocked because of it.

## Crisis lines

| Region | Service | Contact | Emergency |
| --- | --- | --- | --- |
| United States | [988 Suicide & Crisis Lifeline](https://988lifeline.org/get-help/) | Call or text 988; chat online | 911 |
| Canada | [9-8-8: Suicide Crisis Helpline](https://988.ca/get-help) | Call or text 988 | 911 |
| United Kingdom | [Samaritans](https://www.samaritans.org/how-we-can-help/contact-samaritan/) | Call 116 123 | 999 |
| Ireland | [Samaritans Ireland](https://www.samaritans.org/ireland/how-we-can-help/contact-samaritan/) | Call 116 123 | 112 |
| Australia | [Lifeline](https://www.lifeline.org.au/) | Call 13 11 14; text 0477 13 11 14; chat online | 000 |
| New Zealand | [1737, Need to talk?](https://1737.org.nz/) | Call or text 1737 | 111 |

Last verified 2026-11-01. Your region comes from your system settings; change
it in Settings → Safety. Elsewhere, contact a local crisis line or emergency
number.

## Your data

- Except on Animama Cloud, the safety features send nothing beyond your normal
  request to the model provider you chose.
- On Animama Cloud, I also send the text of each of your messages to OpenAI's
  moderation service for the check.
  [OpenAI says](https://developers.openai.com/api/docs/guides/your-data) it
  doesn't train on or keep these requests.
- Animama reports crisis cards to no one. Animama Cloud's telemetry and
  conversation traces are described in its
  [Privacy Notice](https://animama.ai/privacy/).
- The desktop app sends no usage data, crash reports or diagnostic traces. It
  connects to other services only for the following, and each connection
  reveals your IP address:
  - Until the final release: update checks to downloads.animama.ai, about 15
    seconds after the app finishes starting and when you choose Check for
    updates, and downloads from there of what you choose to use: an update, a
    speech model or a voice. A check also shows whether you use macOS or
    Windows. In the preview builds 0.1.0 to 0.1.2 it also shows your system
    language and a random ID that stays the same for each installation, so the
    server could tell which checks came from the same installation. The final
    release contacts downloads.animama.ai for neither.
  - On Windows, a spell-check dictionary for your system language, which the
    app downloads from Google the first time it needs one.
  - A voice's sample from huggingface.co when you play it. This request also
    shows the app's version, your system language, whether you use macOS or
    Windows, and your installation's local port number. That number doesn't
    change, so huggingface.co could tell which plays came from the same
    installation.
  - Requests to the model, voice and web search services you set up, carrying
    what each needs, such as your messages and the Anima's memories. Each
    service handles them under its own terms.
- Chats are saved as usual. Animas are instructed not to save details of a
  suicide or self-harm crisis to memory unless you ask them to.
- For safety, Animama stores only when the AI notice was last shown, your age
  confirmation and your Safety settings. It never logs or stores crisis-check
  results.

A self-hosted server's operator can change or turn off the notice and crisis
card, and may log message previews. The desktop app always uses the defaults.

## Contact

To report a safety concern or a problem with this protocol, email
ray@animama.ai. Last updated 2026-11-04.
