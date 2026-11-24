# Install and use Animama Desktop

Animama 0.1.5 is the current stable macOS release and 0.1.6 the current stable
Windows release; installed apps receive later stable versions through their
platform's update feed. Signed macOS preview builds 0.1.0 to 0.1.4 and the
Windows 0.1.6 preview have also been published for testing.
Animama's prebuilt downloads, update feed and model downloads end before
2027-01-01; before then, a final release stops checking for updates and
explains what has changed. Installed apps keep working afterwards: chat,
Avatars and the three built-in voices need nothing from Animama's servers.
Developers building from source should use [Platform builds](platforms.md).

## Supported target

| Platform                                     | Current position                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Apple silicon Mac, macOS 15 or later         | Signed previews published. macOS 15 and clean-machine testing are part of each release's acceptance. |
| Windows x64: Windows 10 22H2 or Windows 11   | Signed per-user installer published; 0.1.6 is the first stable release, accepted by installing it over signed 0.1.5. The published 0.1.6 installs only on Windows 11 (build 22000 or later); later releases and builds from current source also install on Windows 10. Clean-machine and Windows 10 22H2 testing remain open. |
| Intel Mac, universal Mac, Windows ARM, Linux | No supported self-contained release.                                                              |

On Windows, the installer and the app accept Windows 10 from version 1903
(build 18362), but only Windows 10 22H2 and Windows 11 are supported; earlier
Windows 10 versions are untested. Microsoft ended support for Windows 10 on
14 October 2025, so it no longer receives free security updates. PCs limited to
Windows 10 often have older graphics hardware, where Avatar rendering can be
slow; performance there is best effort.

The installed app contains its own local services and database. It does not
require Docker, Python, Node.js, PostgreSQL, Homebrew or a source checkout.

## First launch

1. Until downloads end, download the macOS arm64 DMG from the announced
   Animama release page, using its release notes and checksums; do not
   substitute an unsigned development build. A Windows installer, built from
   source as `Animama-<version>-x64-setup.exe`, installs as described below.
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
   tab per provider; [build flags](../features/model-settings.md#connections)
   can change which are offered. A local server's tab looks for it when opened. The model
   you set up last (saving the OpenAI key, saving the Anthropic key for Claude
   Haiku 5.5, or adding a model) becomes the default Chat model, and the
   starter Animas switch to it. **Skip for now** keeps the default.
6. **Voice** chooses speech recognition by engine, then CPU or GPU: the
   engine for the app's language comes first and is recommended (SenseVoice
   for Japanese, Korean and Chinese, Parakeet for English), and each version
   offers its download. It also offers the Text-to-Speech provider: built-in
   PocketTTS, on by default, or ElevenLabs with its key. Both choices are
   saved at **Finish**. Nothing downloads unless you choose it, and downloads
   keep going after you finish. After the final release, a version that is not
   installed stays unavailable instead. Choose **Finish**, then confirm
   that you are 18 or older and agree to the
   [Terms of Service](https://animama.ai/terms/) in the short modal before
   Annie's chat opens; it also links the
   [Privacy Notice](https://animama.ai/privacy/). Later launches open the last Anima you visited, or the
   first available Anima if that Anima has been deleted.

Fresh installations create Annie and Andrew. Starter defaults do not overwrite
existing Animas or restore a deliberately deleted starter.

## Provider keys and speech

Setup asks for the OpenAI or Anthropic key in its AI step and the ElevenLabs
key in its Voice step. After setup, the OpenAI and Anthropic keys are on their
cards in App Settings → Models, and the ElevenLabs key is in App Settings →
Voice. The Gemini key for [Gemini voices](../runtime/gemini-tts.md), which setup
does not ask for, is in App Settings → Voice when Gemini is chosen. All four are
also in App Settings → API Keys; each place edits the same saved key. Other model servers, such as OpenRouter or a local Ollama, LM Studio or
llama.cpp server, are added in App Settings → Models (Cloud or Local), with
their key (if any) on the connection. Text chat through an
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

PocketTTS and microphone permission do not require a speech recognition model.
Offline dictation and Voice Mode require the offline speech recognition CPU
model for the app's language, downloaded in setup's Voice step or App Settings
→ Voice without restarting the app. It cannot be downloaded after the final
release; an installation that downloaded it earlier keeps it, and can remove it
in App Settings → Voice. Open the app
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
Downloading speech models or an app update needs Internet access, as do
configured remote AI/voice providers; the final release downloads neither. An installed offline speech model
transcribes offline; that does not make
remote chat work offline. Desktop does not need an Animama account for local use.

To open Animama when you log in, turn on Settings → General → **Launch at
login**. If macOS or Windows blocks it, the setting says where to allow it.

Starter portraits and speech-engine assets are included; your own Local media
can be imported. Complete starter animation acquisition remains a release gate. See
[Content policy](../../../content/included/README.md).

## Updates, backup and removal

A configured release checks for updates without blocking startup, and
Settings → General offers **Check for updates**. The final release never checks
and offers none; after downloads end, older builds' checks fail quietly. The
preview builds 0.1.0 to 0.1.2 also send your system language and a random ID
that stays the same for each installation; the
[safety and crisis protocol](../../safety/crisis-protocol.md#your-data) lists
what the desktop app sends and when. **Download update** and **Restart to
install** are separate decisions; ordinary Quit never installs an update.
Unconfigured development builds do not have a working update feed.
An update can refuse to proceed while a pack is busy or in-use content would
become unavailable. Keep using the current version until the issue is resolved.

Replacing or removing the application does not erase your local data.
Reinstalling is not a reset. On Windows, uninstalling from Settings → Apps asks
afterwards whether to delete `%LOCALAPPDATA%\Animama` as well, naming the
folder and defaulting to keeping it; upgrades never ask. Uninstalling on
Windows also removes Launch at login; upgrades and reinstalls keep it. Quit Animama before a coordinated backup of the
whole data tree; database migration snapshots alone do not include your files
or vault. Secure-storage recovery can require the original macOS login keychain
or the same Windows account, so copying the directory is not a guaranteed
cross-machine migration.

See [Backup and recovery](troubleshooting.md#backups-and-recovery) before
restoring, downgrading or deleting anything. There is no supported one-click
desktop full-reset or cross-device migration flow available.
