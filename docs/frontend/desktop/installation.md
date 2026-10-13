# Install and use Animama Desktop

**No signed public release is available.** This guide describes the implemented
desktop flow and the intended installer. Fresh-source staging, complete starter
inputs, signed/native tests and publication approval remain pending. Local
signed candidates can be transferred privately after signing and input review.
Developers should use [Platform builds](platforms.md).

## Supported target

| Platform                                     | Current position                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Apple silicon Mac, macOS 15 or later         | Declared minimum; fresh build, macOS 15 testing, clean-machine and signed acceptance remain open. |
| Windows 11 x64 (build 22000 or later)        | Per-user installer; signed candidates build, and clean-machine acceptance and a real signed upgrade remain open. |
| Intel Mac, universal Mac, Windows ARM, Linux | No supported self-contained release.                                                              |

The installed app contains its own local services and database. It does not
require Docker, Python, Node.js, PostgreSQL, Homebrew or a source checkout.

## First launch, once an approved installer is available

1. Download the installer for your computer from the announced Animama release
   page: the macOS arm64 DMG, or `Animama-<version>-x64-setup.exe` for Windows.
   Use its release notes and checksums; do not substitute an unsigned
   development build.
2. **macOS:** open the DMG, copy **Animama.app** to Applications, and open it
   through Finder. If macOS reports a damaged or unverified app, stop and use
   [Troubleshooting](troubleshooting.md). Do not disable Gatekeeper or strip
   quarantine.

   **Windows:** run the installer. It installs for your Windows account only,
   in `%LOCALAPPDATA%\Programs\Animama`, without an administrator prompt, adds
   Start menu and desktop shortcuts and opens Animama. Until the publisher has
   download reputation, Microsoft Defender SmartScreen may show "Windows
   protected your PC". Choose **More info**; continue with **Run anyway** only
   if the publisher shown matches the one named in the release notes and the
   file's SHA-256 matches the release checksums; otherwise stop. Open Animama normally, never with **Run as administrator**,
   which it refuses.
3. Let Animama prepare its private database. No local account, password or hosted
   Animama account is required. One internal installation owner is generated
   automatically and retained across restarts.
4. Setup has three steps. **Welcome** asks what Animama should call you;
   a nonblank name is private personalization, not a
   username or credential.
5. **AI** chooses the model your Animas chat with: **Cloud** (OpenAI or
   Anthropic with your key, or another provider) or **Local** (a running
   Ollama, LM Studio, llama.cpp or vLLM server, or a custom one), each with a
   tab per provider. A local server's tab looks for it when opened. The model
   you set up last (saving the OpenAI key, saving the Anthropic key for Claude
   Haiku 5.5, or adding a model) becomes the default Chat model, and the
   starter Animas switch to it. **Skip for now** keeps the default.
6. **Voice** offers Parakeet speech recognition downloads (CPU, and GPU
   acceleration) and the Text-to-Speech provider: built-in PocketTTS, on by
   default, or ElevenLabs with its key. Nothing downloads unless you choose it,
   and downloads keep going after you finish. Choose **Finish**, then confirm
   that you are 18 or older in the short modal before Annie's chat opens. Later launches open the last Anima you visited, or the
   first available Anima if that Anima has been deleted.

Fresh installations create Annie and Caitlyn. Starter defaults do not overwrite
existing Animas or restore a deliberately deleted starter.

## Provider keys and speech

Setup asks for the OpenAI or Anthropic key in its AI step and the ElevenLabs
key in its Voice step. After setup, the OpenAI and Anthropic keys are on their
cards in App Settings → Models, and the ElevenLabs key is in App Settings →
Voice. The Gemini key for [Gemini voices](../runtime/gemini-tts.md), which setup
does not ask for, is in App Settings → Voice when Gemini is chosen. All four are
also in App Settings → API Keys; each place edits the same saved key. Other model servers, such as DeepSeek, OpenRouter or a local Ollama,
LM Studio or llama.cpp server, are added in App Settings → Models (Cloud or
Local), with their key (if any) on the connection. Text chat through an
external model requires that provider to be configured and reachable and can
incur its charges. There is no bundled offline chat model; a local server on
this computer keeps chat fully local. The app reaches local servers at
`127.0.0.1` on their usual port; start the server and load a model before
testing it. See [Local model servers](../../backend/operations/local-models.md)
for server setup and context windows.

Keys are encrypted with the operating system's secure storage (the macOS
login keychain, or Windows data protection for your Windows account) and are
never read back into the browser. Saving, replacing or removing keys, in setup, Settings → API Keys or on
a model connection, takes effect for the next chat or voice request without
reloading the window or restarting the backend. Replies already in progress finish
on the key they started with. Up to 32 connection keys can be stored. Never put
a key in a URL or send it to support.

If the running service cannot take the change, Animama restarts its local
services from the saved keys, which reloads the window. If that restart fails,
runtime recovery's Retry uses the saved keys; do not remove the vault or
re-enter a key merely to repair it.

PocketTTS and microphone permission do not require Parakeet. Offline dictation
and Voice Mode require the offline speech recognition CPU model, downloaded in
setup's Voice step or App Settings → Voice without restarting the app. Open the app
normally through Finder for microphone permission tests and allow Animama in
macOS Privacy & Security when prompted. On Windows, microphone access follows
Settings → Privacy & security → Microphone, including **Let desktop apps access
your microphone**. See [Speech model downloads](feature-packs.md#speech-model-downloads)
and [Microphone troubleshooting](troubleshooting.md#microphone-and-speech).

## Local storage and offline use

Your data lives at `~/Library/Application Support/Animama` on macOS and
`%LOCALAPPDATA%\Animama` on Windows, separately from the app itself. It includes the private database, encrypted vault, Local content,
uploads, logs, downloaded speech models and installed packs. Included content in the app is read-only;
content you create/import belongs in the writable Local library. The app uses
private loopback services and is not a shared LAN application.

Local content, history and installed local speech assets remain on the computer.
Downloading speech models, a pack or an app update needs Internet access, as do
configured remote AI/voice providers. An installed offline speech model
transcribes offline; that does not make
remote chat work offline. Desktop does not need an Animama account for local use.

Starter portraits and speech-engine assets are included; your own Local media
can be imported. Complete starter animation acquisition remains a release gate. See
[Content policy](../../../content/included/README.md).

## Updates, backup and removal

A configured release checks for updates without blocking startup. Settings →
General offers **Check for updates**. **Download update** and **Restart to
install** are separate decisions; ordinary Quit never installs an update.
Current unconfigured development builds do not have a working update feed.
An update can refuse to proceed while a pack is busy or in-use content would
become unavailable. Keep using the current version until the issue is resolved.

Replacing or removing the application does not erase your local data.
Reinstalling is not a reset. On Windows, uninstalling from Settings → Apps asks
afterwards whether to delete `%LOCALAPPDATA%\Animama` as well, naming the
folder and defaulting to keeping it; upgrades never ask. Quit Animama before a coordinated backup of the
whole data tree; database migration snapshots alone do not include your files
or vault. Secure-storage recovery can require the original macOS login keychain
or the same Windows account, so copying the directory is not a guaranteed
cross-machine migration.

See [Backup and recovery](troubleshooting.md#backups-and-recovery) before
restoring, downgrading or deleting anything. There is no supported one-click
desktop full-reset or cross-device migration flow available.
