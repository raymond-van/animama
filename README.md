<p align="center">
  <a href="https://youtu.be/8ji_NNOfsP8">
    <img src="docs/assets/readme-trailer.jpg" alt="Watch the Animama launch trailer" width="560">
  </a>
</p>

<p align="center">
  <a href="https://youtu.be/sWw4bSrriDE">Walkthrough video</a> ·
  <a href="https://docs.animama.ai">Docs</a> ·
  <a href="https://discord.gg/pUHHRrZ2xg">Discord</a>
  <br>
  README: <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.zh-Hans.md">简体中文</a> ·
  <a href="README.tr.md">Türkçe</a>
</p>

<p align="center">
  <b>News</b>
  <br>
  November 18, 2026 · Animama has officially launched and is open source
</p>

# Animama

Your new desk buddy is an Anima.

Animama puts a charming and expressive companion in the corner of your screen,
keeping you company while you work, play and power through the day.

## Features

### The app

- **[Private and self-hostable](https://docs.animama.ai/self-host):** runs on your computer with
  your ChatGPT plan, your own API keys or a local model (Ollama, LM Studio,
  llama.cpp or vLLM). Self-host it in your browser or build the desktop app
  yourself.
- **[Make them yours](https://docs.animama.ai/animas):** edit your Anima's identity, memories and
  behaviors until they feel just right.
- **[VRM avatars](https://docs.animama.ai/avatars):** bring any VRM 0.x or 1.0 avatar; VRoid Studio
  avatars work best. Convert VRChat avatars with the
  [Animama Avatar Converter](https://github.com/raymond-van/animama-avatar-converter),
  and other 3D models in Blender with the
  [VRM Add-on for Blender](https://github.com/saturday06/VRM-Addon-for-Blender).
- **[Voice mode](https://docs.animama.ai/voice):** talk hands-free with automatic end-of-turn
  detection. Voice can run fully locally.
- **[Picture-in-picture](https://docs.animama.ai/configuration#picture-in-picture):** your Anima
  floats in a corner above your other windows, with quick chat and global
  shortcuts.
- **[Creator tools](https://docs.animama.ai/effects):** make your own Gestures, Reactions, and
  Avatar, Particle and Scene Effects in the app, or describe one to an AI coding
  agent with the included [skills](.agents/skills).
- **[Languages](https://docs.animama.ai/configuration#app-settings):** the app and voice input in
  English, 日本語, 한국어 and 简体中文.

### Your Anima

- **[Personality](https://docs.animama.ai/animas#anima-instructions):** each Anima has their own
  identity and voice.
- **[Memories](https://docs.animama.ai/memory):** long-term memory across conversations. Your Anima
  keeps notes about you and your time together, in files you can read, edit and
  roll back.
- **[Emotions](https://docs.animama.ai/emotions):** 24 emotions that shift over your time together
  and show in their face, body and voice.
- **[Gestures](https://docs.animama.ai/behaviors#gestures):** body language picked as they talk,
  from goofy antics to romantic gestures. Over 300 gestures and reactions are
  included.
- **[Reactions](https://docs.animama.ai/behaviors#reactions):** an expression for every emotion at
  four intensities, from mild to intense, with anime-style effects.

## Download

| Platform | Requires | Installer | Size |
| --- | --- | --- | --- |
| macOS | macOS 15 or later, Apple silicon | [Animama-0.1.5-arm64.dmg](https://downloads.animama.ai/desktop/v0.1.5/Animama-0.1.5-arm64.dmg) | 418 MB (889 MB installed) |
| Windows | Windows 11 x64, build 22000 or later | [Animama-0.1.6-x64-setup.exe](https://downloads.animama.ai/desktop/v0.1.6/Animama-0.1.6-x64-setup.exe) | 377 MB (988 MB installed) |

On Windows, SmartScreen may say "Windows protected your PC" because Animama is
new. Select **More info**, check that the publisher is Raymond Van, then select
**Run anyway**.

## AI Models

Use your [ChatGPT plan](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)
or your own API keys, chosen during setup or in **App Settings**. Keys stay
encrypted on your computer.

### [Chat](https://docs.animama.ai/#setup)

| Provider | Connect with | Model |
| --- | --- | --- |
| OpenAI | ChatGPT plan | The models your plan includes |
| OpenAI | API key | GPT-6 Luna (recommended) |
| Anthropic | API key | Claude Haiku 5.5 (recommended) |
| OpenRouter or any OpenAI-compatible endpoint | API key | Your choice |

To use your ChatGPT plan, select **Continue with ChatGPT** and sign in at
OpenAI. No API key is needed, and usage counts toward your plan's limits.
When self-hosting, sign in from a browser on the computer that runs Animama.
The current installers don't include it yet; self-hosting from source does.

The recommended API models are low-cost, so a few dollars of API usage goes a
long way.

#### Local models

Ollama, LM Studio, llama.cpp and vLLM work, but are experimental. The inference
engine should support strict JSON output, and the model should support tool
calling. [Local model servers](docs/backend/operations/local-models.md) covers setup.

### [STT](https://docs.animama.ai/voice#speech-to-text)

Both engines run on your computer. The GPU (WebGPU) version is recommended: it
shows your words as you speak.

| Engine | Languages |
| --- | --- |
| Parakeet | English |
| SenseVoice | Japanese, Korean, Chinese |

### [TTS](https://docs.animama.ai/voice#text-to-speech)

| Engine | Cost | Notes |
| --- | --- | --- |
| [ElevenLabs](https://elevenlabs.io) (recommended) | About 20 free minutes a month | The most expressive voices; pick from its [voice library](https://elevenlabs.io/voice-library) |
| Pocket TTS | Free, built in | Runs on your computer and can clone a voice |

## Self-host

<details>
<summary><h3>Desktop</h3></summary>

Build the desktop app yourself. The build is unsigned, for your own computer.
[Desktop builds](docs/frontend/desktop/platforms.md) has the details.

<details>
<summary><h4>macOS</h4></summary>

Requires an Apple silicon Mac with Xcode command-line tools, Node 24, pnpm, uv
and Git LFS.

```bash
git clone https://github.com/raymond-van/animama.git
cd animama
git lfs pull
python3 scripts/models/browser_speech.py acquire
cd src/frontend
pnpm install --frozen-lockfile
pnpm desktop:mac:build:run
```

The app is written to `src/frontend/desktop/release/mac/Animama.app`.

</details>

<details>
<summary><h4>Windows</h4></summary>

Requires Windows 11 x64 with Visual Studio 2022 (MSVC v143 14.44 toolset,
Windows SDK 10.0.26100), Node 24, pnpm, uv and Git LFS. In PowerShell:

```powershell
git clone -c core.autocrlf=false https://github.com/raymond-van/animama.git
cd animama
git lfs pull
py -3 scripts/models/browser_speech.py acquire
cd src/frontend
pnpm install --frozen-lockfile
pnpm desktop:runtime:stage -- --platform win32 --arch x64
pnpm desktop:runtime:audit -- --platform win32 --arch x64
pnpm desktop:win:installer
```

The installer is written to `src/frontend/desktop/release/`. It installs on
Windows 10 22H2 and on Windows 11.

</details>

</details>

<details>
<summary><h3>Web</h3></summary>

Run Animama as a server on your computer and use it in your browser. Requires
macOS or Linux (Windows through WSL), Docker with Compose, Git LFS and Python
3.11 or later.

```bash
git clone https://github.com/raymond-van/animama.git
cd animama
git lfs pull
python3 scripts/models/browser_speech.py acquire  # optional: Pocket TTS and Smart Turn
ANIMAMA_WEB_BUILD_MODE=production ./reset.sh
```

Then open <http://localhost:8000>. Give the server your API keys through an
environment file outside the checkout, as
[credentials](docs/backend/operations/development.md#credentials-and-nonsecret-configuration)
describes.

The server listens only on your computer. To reach it from another device, put
your own TLS and authentication in front of it.

</details>

## Contributing

Bug reports, feature ideas and pull requests are welcome. Found a bug? Use the
[bug report form](https://github.com/raymond-van/animama/issues/new?template=bug.yml).
Read the [contributing guide](.github/CONTRIBUTING.md) before you open a pull
request.

## Acknowledgements

- [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) by Kyutai: on-device
  voices
- [Smart Turn](https://github.com/pipecat-ai/smart-turn) by Pipecat: knowing
  when you've finished speaking
- [Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) by NVIDIA and
  [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) by FunAudioLLM:
  speech recognition
- [three-vrm](https://github.com/pixiv/three-vrm) and
  [VRoid](https://vroid.com/en) by pixiv: avatar rendering and the included
  avatars
- [Mochiya Avatar Tools](https://github.com/mochiya-labs/unity-avatar-tools) and
  [three-liltoon](https://github.com/mochiya-labs/three-liltoon) by Mochiya
  Labs: VRChat avatar conversion and lilToon materials
- [three.quarks](https://github.com/Alchemist0823/three.quarks): particle
  effects
- [Lapwing](https://booth.pm/ja/items/4993931) ©kuji
