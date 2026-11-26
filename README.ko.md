<p align="center">
  <a href="https://youtu.be/8ji_NNOfsP8">
    <img src="docs/assets/readme-trailer.jpg" alt="Animama 출시 트레일러 보기" width="560">
  </a>
</p>

<p align="center">
  <a href="https://youtu.be/sWw4bSrriDE">둘러보기 영상</a> ·
  <a href="https://docs.animama.ai/ko/">문서</a> ·
  <a href="https://discord.gg/pUHHRrZ2xg">Discord</a>
  <br>
  README: <a href="README.md">English</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.zh-Hans.md">简体中文</a>
</p>

<p align="center">
  <b>새 소식</b>
  <br>
  2026년 11월 18일 · Animama를 정식 출시하고 오픈소스로 공개했습니다
</p>

# Animama

새로운 책상 친구, Anima를 소개합니다.

Animama는 매력적이고 표정이 풍부한 컴패니언을 화면 한쪽에 데려와, 일할 때도 놀
때도 바쁜 하루를 보낼 때도 곁을 지켜 줍니다.

## 기능

### 앱

- **[프라이버시와 셀프 호스팅](https://docs.animama.ai/ko/self-host):** ChatGPT 플랜, 자신의
  API 키나 로컬 모델(Ollama, LM Studio, llama.cpp, vLLM)로 내 컴퓨터에서
  실행됩니다. 셀프 호스팅해 브라우저에서 쓰거나 데스크톱 앱을 직접 빌드할 수
  있습니다.
- **[나만의 Anima로](https://docs.animama.ai/ko/animas):** Anima의 정체성, 기억, 행동을 마음에 들
  때까지 편집할 수 있습니다.
- **[VRM 아바타](https://docs.animama.ai/ko/avatars):** VRM 0.x 또는 1.0 아바타라면 무엇이든 쓸 수
  있으며, VRoid Studio 아바타가 가장 잘 맞습니다. VRChat 아바타는
  [Animama Avatar Converter](https://github.com/raymond-van/animama-avatar-converter)로,
  다른 3D 모델은 Blender에서
  [VRM Add-on for Blender](https://github.com/saturday06/VRM-Addon-for-Blender)로
  변환할 수 있습니다.
- **[음성 모드](https://docs.animama.ai/ko/voice):** 말이 끝나는 시점을 자동으로 감지해 핸즈프리로
  대화할 수 있습니다. 음성 처리는 모두 로컬에서 실행할 수도 있습니다.
- **[화면 속 화면](https://docs.animama.ai/ko/configuration#picture-in-picture):** Anima가 다른 창
  위, 화면 한쪽에 떠 있습니다. 빠른 채팅과 전역 단축키도 쓸 수 있습니다.
- **[크리에이터 도구](https://docs.animama.ai/ko/effects):** 제스처, 리액션, 아바타·파티클·장면
  효과를 앱에서 직접 만들 수 있습니다. 포함된 [스킬](.agents/skills)을 쓰면 AI
  코딩 에이전트에게 설명만으로 만들게 할 수도 있습니다.
- **[언어](https://docs.animama.ai/ko/configuration#app-settings):** 앱과 음성 입력이 English,
  日本語, 한국어, 简体中文을 지원합니다.

### 나의 Anima

- **[개성](https://docs.animama.ai/ko/animas#anima-instructions):** Anima마다 고유한 정체성과
  목소리가 있습니다.
- **[기억](https://docs.animama.ai/ko/memory):** 대화가 끝나도 이어지는 장기 기억. Anima가 사용자에
  대한 정보와 함께한 시간을 메모로 남깁니다. 메모는 파일이라 직접 읽고,
  편집하고, 이전 상태로 되돌릴 수 있습니다.
- **[감정](https://docs.animama.ai/ko/emotions):** 함께하는 시간에 따라 변하는 24가지 감정을 얼굴,
  몸, 목소리로 표현합니다.
- **[제스처](https://docs.animama.ai/ko/behaviors#gestures):** 대화하면서 고르는 몸짓. 엉뚱한
  장난부터 로맨틱한 몸짓까지, 300가지가 넘는 제스처와 리액션이 들어 있습니다.
- **[리액션](https://docs.animama.ai/ko/behaviors#reactions):** 모든 감정에 '약함'부터 '매우
  강함'까지 네 단계의 표정이 있고, 애니메이션풍 효과가 함께 나옵니다.

## 다운로드

| 플랫폼 | 요구 사항 | 설치 파일 | 크기 |
| --- | --- | --- | --- |
| macOS | macOS 15 이상, Apple 실리콘 | [Animama-0.1.5-arm64.dmg](https://downloads.animama.ai/desktop/v0.1.5/Animama-0.1.5-arm64.dmg) | 418 MB(설치 후 889 MB) |
| Windows | Windows 11 x64, 빌드 22000 이상 | [Animama-0.1.6-x64-setup.exe](https://downloads.animama.ai/desktop/v0.1.6/Animama-0.1.6-x64-setup.exe) | 377 MB(설치 후 988 MB) |

Windows에서는 Animama가 새로 나온 앱이라 SmartScreen에 "Windows의 PC 보호"가
표시될 수 있습니다. **추가 정보**를 선택하고 게시자가 Raymond Van인지 확인한 뒤
**실행**을 선택하세요.

## AI 모델

처음 설정할 때나 **앱 설정**에서 [ChatGPT 플랜](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)이나 내 API 키를 골라 쓰세요. 키는
암호화되어 내 컴퓨터에 저장됩니다.

### [채팅](https://docs.animama.ai/ko/#setup)

| 제공자 | 연결 방법 | 모델 |
| --- | --- | --- |
| OpenAI | ChatGPT 플랜 | 플랜에 포함된 모델 |
| OpenAI | API 키 | GPT-6 Luna(추천) |
| Anthropic | API 키 | Claude Haiku 5.5(추천) |
| OpenRouter 또는 기타 OpenAI 호환 엔드포인트 | API 키 | 자유롭게 선택 |

ChatGPT 플랜을 쓰려면 **ChatGPT로 계속하기**를 선택하고 OpenAI에서 로그인하세요.
API 키는 필요 없고, 사용량은 플랜 한도에 포함됩니다.
셀프 호스팅할 때는 Animama를 실행하는 컴퓨터의 브라우저에서 로그인하세요. 현재
설치 파일에는 아직 들어 있지 않으며, 소스에서 셀프 호스팅하면 쓸 수 있습니다.

추천 API 모델은 비용이 낮아서 몇 달러어치 API 사용량으로도 오래 쓸 수 있습니다.

#### 로컬 모델

Ollama, LM Studio, llama.cpp, vLLM을 쓸 수 있지만 실험적으로 지원합니다. 추론
엔진은 엄격한 JSON 출력을, 모델은 도구 호출을 지원해야 합니다. 설정 방법은
[로컬 모델 서버](docs/backend/operations/local-models.md)(영문)를 참고하세요.

### [음성 인식(STT)](https://docs.animama.ai/ko/voice#speech-to-text)

두 엔진 모두 내 컴퓨터에서 실행됩니다. 말하는 동안 글자가 바로 표시되는
GPU(WebGPU) 버전을 추천합니다.

| 엔진 | 언어 |
| --- | --- |
| Parakeet | 영어 |
| SenseVoice | 일본어·한국어·중국어 |

### [음성 합성(TTS)](https://docs.animama.ai/ko/voice#text-to-speech)

| 엔진 | 비용 | 특징 |
| --- | --- | --- |
| [ElevenLabs](https://elevenlabs.io)(추천) | 무료 요금제로 매달 약 20분 | 가장 표현력 있는 목소리. [보이스 라이브러리](https://elevenlabs.io/voice-library)에서 고를 수 있습니다 |
| Pocket TTS | 무료, 기본 내장 | 내 컴퓨터에서 실행되며 음성 복제도 지원합니다 |

## 셀프 호스팅

<details>
<summary><h3>데스크톱</h3></summary>

데스크톱 앱을 직접 빌드합니다. 서명되지 않은 빌드이므로 내 컴퓨터에서만
쓰세요. 자세한 내용은 [데스크톱 빌드](docs/frontend/desktop/platforms.md)(영문)를
참고하세요.

<details>
<summary><h4>macOS</h4></summary>

Xcode 명령줄 도구, Node 24, pnpm, uv, Git LFS가 설치된 Apple 실리콘 Mac이
필요합니다.

```bash
git clone https://github.com/raymond-van/animama.git
cd animama
git lfs pull
python3 scripts/models/browser_speech.py acquire
cd src/frontend
pnpm install --frozen-lockfile
pnpm desktop:mac:build:run
```

앱은 `src/frontend/desktop/release/mac/Animama.app`에 만들어집니다.

</details>

<details>
<summary><h4>Windows</h4></summary>

Visual Studio 2022(MSVC v143 14.44 도구 집합, Windows SDK 10.0.26100), Node 24,
pnpm, uv, Git LFS가 설치된 Windows 11 x64가 필요합니다. PowerShell에서
실행하세요.

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

설치 파일은 `src/frontend/desktop/release/`에 만들어집니다. Windows 10 22H2와
Windows 11에 설치할 수 있습니다.

</details>

</details>

<details>
<summary><h3>웹</h3></summary>

Animama를 내 컴퓨터에서 서버로 실행하고 브라우저에서 사용합니다. macOS 또는
Linux(Windows는 WSL), Docker와 Compose, Git LFS, Python 3.11 이상이 필요합니다.

```bash
git clone https://github.com/raymond-van/animama.git
cd animama
git lfs pull
python3 scripts/models/browser_speech.py acquire  # 선택 사항: Pocket TTS와 Smart Turn
ANIMAMA_WEB_BUILD_MODE=production ./reset.sh
```

그런 다음 <http://localhost:8000>을 엽니다. API 키는 체크아웃 밖에 둔 환경
파일로 서버에 전달합니다. 방법은
[자격 증명](docs/backend/operations/development.md#credentials-and-nonsecret-configuration)(영문)을 참고하세요.

서버는 내 컴퓨터에서만 연결을 받습니다. 다른 기기에서 접속하려면 직접 구성한
TLS와 인증을 앞단에 두세요.

</details>

## 기여하기

버그 제보, 기능 제안, 풀 리퀘스트를 환영합니다. 버그를 발견하면
[버그 제보 양식](https://github.com/raymond-van/animama/issues/new?template=bug.yml)(영어)으로 알려 주세요.
풀 리퀘스트를 열기 전에
[기여 가이드](.github/CONTRIBUTING.md)(영어)를 읽어 주세요.

## 감사의 말

- [Pocket TTS](https://github.com/kyutai-labs/pocket-tts)(Kyutai): 기기에서 실행되는
  음성 합성
- [Smart Turn](https://github.com/pipecat-ai/smart-turn)(Pipecat): 말이 끝났는지
  감지
- [Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2)(NVIDIA)와
  [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)(FunAudioLLM): 음성 인식
- [three-vrm](https://github.com/pixiv/three-vrm)과
  [VRoid](https://vroid.com/en)(pixiv): 아바타 렌더링과 기본 제공 아바타
- [Mochiya Avatar Tools](https://github.com/mochiya-labs/unity-avatar-tools)와
  [three-liltoon](https://github.com/mochiya-labs/three-liltoon)(Mochiya Labs):
  VRChat 아바타 변환과 lilToon 머티리얼
- [three.quarks](https://github.com/Alchemist0823/three.quarks): 파티클 효과
- [Lapwing](https://booth.pm/ko/items/4993931) ©kuji
