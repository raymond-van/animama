<p align="center">
  <a href="https://youtu.be/8ji_NNOfsP8">
    <img src="docs/assets/readme-trailer.jpg" alt="Animama のローンチトレーラーを見る" width="560">
  </a>
</p>

<p align="center">
  <a href="https://youtu.be/sWw4bSrriDE">ウォークスルー動画</a> ·
  <a href="https://docs.animama.ai/ja/">ドキュメント</a> ·
  <a href="https://discord.gg/pUHHRrZ2xg">Discord</a>
  <br>
  README: <a href="README.md">English</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.zh-Hans.md">简体中文</a>
</p>

<p align="center">
  <b>お知らせ</b>
  <br>
  2026年11月18日 · Animama を正式リリースし、オープンソースとして公開しました
</p>

# Animama

あなたの新しいデスクの相棒は Anima です。

Animama は、魅力たっぷりで表情豊かなコンパニオンを画面の隅に呼び出し、仕事中も遊んでいるときも、がんばる一日にずっと寄り添います。

## 機能

### アプリ

- **[プライベートでセルフホスト可能](https://docs.animama.ai/ja/self-host):** 自分の API キーまたはローカルモデル（Ollama、LM Studio、llama.cpp、vLLM）を使って、あなたのコンピューター上で動きます。セルフホストしてブラウザーで使うことも、デスクトップアプリを自分でビルドすることもできます。
- **[あなた好みに](https://docs.animama.ai/ja/animas):** Anima のアイデンティティ、記憶、ふるまいを、しっくりくるまで編集できます。
- **[VRM アバター](https://docs.animama.ai/ja/avatars):** VRM 0.x / 1.0 のアバターなら何でも使えます。VRoid Studio のアバターがいちばん相性良好です。VRChat アバターは [Animama Avatar Converter](https://github.com/raymond-van/animama-avatar-converter)で、その他の 3D モデルは Blender と [VRM Add-on for Blender](https://github.com/saturday06/VRM-Addon-for-Blender)で変換できます。
- **[音声モード](https://docs.animama.ai/ja/voice):** 話し終わりを自動で検出するので、ハンズフリーで会話できます。音声処理はすべてローカルで動かすこともできます。
- **[ピクチャー・イン・ピクチャー](https://docs.animama.ai/ja/configuration#picture-in-picture):** Anima がほかのウィンドウの上、画面の隅に浮かびます。クイックチャットやグローバルショートカットも使えます。
- **[クリエイターツール](https://docs.animama.ai/ja/effects):** ジェスチャー、リアクション、アバター・パーティクル・シーンエフェクトをアプリ内で作れます。同梱の[スキル](.agents/skills)を使えば、AI コーディングエージェントに説明するだけで作ることもできます。
- **[言語](https://docs.animama.ai/ja/configuration#app-settings):** アプリと音声入力は English、日本語、한국어、简体中文 に対応しています。

### あなたの Anima

- **[個性](https://docs.animama.ai/ja/animas#anima-instructions):** Anima にはそれぞれ独自のアイデンティティと声があります。
- **[記憶](https://docs.animama.ai/ja/memory):** 会話をまたいで続く長期記憶。あなたのことや一緒に過ごした時間を Anima がメモに残します。メモはファイルとして読む、編集する、以前の状態に戻すことができます。
- **[感情](https://docs.animama.ai/ja/emotions):** 一緒に過ごすうちに移り変わる 24 種類の感情を、表情、体、声で表現します。
- **[ジェスチャー](https://docs.animama.ai/ja/behaviors#gestures):** 話しながら選ばれるボディランゲージ。おちゃめなおふざけからロマンチックなしぐさまで、300 種類以上のジェスチャーとリアクションを収録しています。
- **[リアクション](https://docs.animama.ai/ja/behaviors#reactions):** すべての感情に「弱め」から「とても強い」まで 4 段階の表情があり、アニメ風のエフェクトも付きます。

## ダウンロード

| プラットフォーム | 動作環境 | インストーラー | サイズ |
| --- | --- | --- | --- |
| macOS | macOS 15 以降、Apple シリコン | [Animama-0.1.5-arm64.dmg](https://downloads.animama.ai/desktop/v0.1.5/Animama-0.1.5-arm64.dmg) | 418 MB（インストール後 889 MB） |
| Windows | Windows 11 x64、ビルド 22000 以降 | [Animama-0.1.6-x64-setup.exe](https://downloads.animama.ai/desktop/v0.1.6/Animama-0.1.6-x64-setup.exe) | 377 MB（インストール後 988 MB） |

Windows では、Animama が新しいアプリのため、SmartScreen に「Windows によって PC が保護されました」と表示されることがあります。**詳細情報** を選び、発行元が Raymond Van であることを確認してから **実行** を選んでください。

## AI モデル（BYOK）

自分の API キーを使う BYOK（Bring Your Own Key）方式です。セットアップ中または **アプリ設定** で、選んだプロバイダーの API キーを追加してください。キーは暗号化されて、あなたのコンピューターに保存されます。

### [チャット](https://docs.animama.ai/ja/#setup)

おすすめのモデルは低コストなので、数ドル分の API 利用でも長く使えます。

| プロバイダー | モデル |
| --- | --- |
| OpenAI | GPT-6 Luna（おすすめ） |
| Anthropic | Claude Haiku 5.5（おすすめ） |
| OpenRouter またはその他の OpenAI 互換エンドポイント | 自由に選べます |

#### ローカルモデル

Ollama、LM Studio、llama.cpp、vLLM が使えますが、試験的な対応です。推論エンジンは厳密な JSON 出力に、モデルはツール呼び出しに対応している必要があります。設定方法は[ローカルモデルサーバー](docs/backend/operations/local-models.md)（英語）を参照してください。

### [音声認識（STT）](https://docs.animama.ai/ja/voice#speech-to-text)

どちらのエンジンもあなたのコンピューター上で動きます。話している途中から文字が表示される GPU（WebGPU）版をおすすめします。

| エンジン | 言語 |
| --- | --- |
| Parakeet | 英語 |
| SenseVoice | 日本語・韓国語・中国語 |

### [読み上げ（TTS）](https://docs.animama.ai/ja/voice#text-to-speech)

| エンジン | 料金 | 特長 |
| --- | --- | --- |
| [ElevenLabs](https://elevenlabs.io)（おすすめ） | 無料プランで毎月約 20 分 | いちばん表現豊かな声。[ボイスライブラリ](https://elevenlabs.io/voice-library)から選べます |
| Pocket TTS | 無料・内蔵 | あなたのコンピューター上で動き、音声クローンにも対応しています |

## セルフホスト

<details>
<summary><h3>デスクトップ</h3></summary>

デスクトップアプリを自分でビルドします。署名なしのビルドなので、自分のコンピューターで使うためのものです。詳しくは[デスクトップビルド](docs/frontend/desktop/platforms.md)（英語）を参照してください。

<details>
<summary><h4>macOS</h4></summary>

Xcode コマンドラインツール、Node 24、pnpm、uv、Git LFS を入れた Apple シリコン搭載の Mac が必要です。

```bash
git clone https://github.com/raymond-van/animama.git
cd animama
git lfs pull
python3 scripts/models/browser_speech.py acquire
cd src/frontend
pnpm install --frozen-lockfile
pnpm desktop:mac:build:run
```

アプリは `src/frontend/desktop/release/mac/Animama.app` に出力されます。

</details>

<details>
<summary><h4>Windows</h4></summary>

Visual Studio 2022（MSVC v143 14.44 ツールセット、Windows SDK 10.0.26100）、Node 24、pnpm、uv、Git LFS を入れた Windows 11 x64 が必要です。PowerShell で実行します。

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

インストーラーは `src/frontend/desktop/release/` に出力されます。

</details>

</details>

<details>
<summary><h3>Web</h3></summary>

Animama を自分のコンピューター上でサーバーとして動かし、ブラウザーで使います。macOS または Linux（Windows は WSL 経由）、Docker と Compose、Git LFS、Python 3.11 以降が必要です。

```bash
git clone https://github.com/raymond-van/animama.git
cd animama
git lfs pull
python3 scripts/models/browser_speech.py acquire  # 任意: Pocket TTS と Smart Turn
ANIMAMA_WEB_BUILD_MODE=production ./reset.sh
```

続いて <http://localhost:8000> を開きます。API キーは、チェックアウトの外に置いた環境ファイルでサーバーに渡します。手順は[認証情報](docs/backend/operations/development.md#credentials-and-nonsecret-configuration)（英語）を参照してください。

サーバーはあなたのコンピューター内でのみ待ち受けます。ほかのデバイスからアクセスするには、独自の TLS と認証を前段に置いてください。

</details>

## コントリビュート

バグ報告、機能の提案、プルリクエストを歓迎します。バグを見つけたら
[バグ報告フォーム](https://github.com/raymond-van/animama/issues/new?template=bug.yml)（英語）からお知らせください。
プルリクエストを送る前に
[コントリビューションガイド](.github/CONTRIBUTING.md)（英語）をお読みください。

## 謝辞

- [Pocket TTS](https://github.com/kyutai-labs/pocket-tts)（Kyutai）: デバイス上で動く音声合成
- [Smart Turn](https://github.com/pipecat-ai/smart-turn)（Pipecat）: 話し終わりの検出
- [Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2)（NVIDIA）と [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)（FunAudioLLM）: 音声認識
- [three-vrm](https://github.com/pixiv/three-vrm) と [VRoid](https://vroid.com/)（pixiv）: アバターの描画と同梱アバター
- [Mochiya Avatar Tools](https://github.com/mochiya-labs/unity-avatar-tools) と [three-liltoon](https://github.com/mochiya-labs/three-liltoon)（Mochiya Labs）: VRChat アバターの変換と lilToon マテリアル
- [three.quarks](https://github.com/Alchemist0823/three.quarks): パーティクルエフェクト
- [Lapwing](https://booth.pm/ja/items/4993931) ©kuji
