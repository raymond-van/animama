<p align="center">
  <a href="https://youtu.be/8ji_NNOfsP8">
    <img src="docs/assets/readme-trailer.jpg" alt="Animama tanıtım fragmanını izle" width="560">
  </a>
</p>

<p align="center">
  <a href="https://youtu.be/sWw4bSrriDE">Tanıtım videosu</a> ·
  <a href="https://docs.animama.ai">Belgeler</a> ·
  <a href="https://discord.gg/pUHHRrZ2xg">Discord</a>
  <br>
  README: <a href="README.md">English</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.zh-Hans.md">简体中文</a> ·
  <strong>Türkçe</strong>
</p>

<p align="center">
  <b>Haberler</b>
  <br>
  18 Kasım 2026 · Animama resmen yayınlandı ve açık kaynak oldu
</p>

# Animama

Yeni masaüstü arkadaşınız bir Anima.

Animama, ekranınızın köşesine sevimli ve ifadeli bir yol arkadaşı yerleştirerek
çalışırken, oyun oynarken ve gününüzü geçirirken size eşlik eder.

## Özellikler

### Uygulama

- **[Özel ve kendi sunucunuzda barındırılabilir](https://docs.animama.ai/self-host):** Bilgisayarınızda
  ChatGPT planınızla, kendi API anahtarlarınızla veya yerel bir modelle (Ollama, LM Studio,
  llama.cpp veya vLLM) çalışır. Tarayıcınızda kendiniz barındırın ya da masaüstü uygulamasını
  kendiniz derleyin.
- **[Onları kendinize göre özelleştirin](https://docs.animama.ai/animas):** Anima'nızın kimliğini, anılarını ve
  davranışlarını tam istediğiniz gibi olana kadar düzenleyin.
- **[VRM avatarları](https://docs.animama.ai/avatars):** Herhangi bir VRM 0.x veya 1.0 avatarı getirin; VRoid Studio
  avatarları en iyi sonucu verir. VRChat avatarlarını
  [Animama Avatar Converter](https://github.com/raymond-van/animama-avatar-converter) ile,
  diğer 3D modelleri ise Blender'da
  [VRM Add-on for Blender](https://github.com/saturday06/VRM-Addon-for-Blender) ile dönüştürün.
- **[Sesli mod](https://docs.animama.ai/voice):** Otomatik konuşma sonu algılama ile eller serbest konuşun.
  Ses tamamen yerel olarak çalışabilir.
- **[Resim içinde resim](https://docs.animama.ai/configuration#picture-in-picture):** Anima'nız
  hızlı sohbet ve genel kısayollarla diğer pencerelerinizin üzerinde bir köşede durur.
- **[Oluşturucu araçları](https://docs.animama.ai/effects):** Uygulama içinde kendi Hareketlerinizi, Tepkilerinizi ve
  Avatar, Parçacık ve Sahne Efektlerinizi oluşturun ya da dahil edilen [beceriler](.agents/skills) ile
  bir yapay zeka kodlama ajanına tarif edin.
- **[Diller](https://docs.animama.ai/configuration#app-settings):** Uygulama ve ses girişi
  English, 日本語, 한국어 ve 简体中文 dillerinde kullanılabilir.

### Anima'nız

- **[Kişilik](https://docs.animama.ai/animas#anima-instructions):** Her Anima'nın kendi
  kimliği ve sesi vardır.
- **[Anılar](https://docs.animama.ai/memory):** Sohbetler boyunca uzun süreli bellek. Anima'nız
  sizin ve birlikte geçirdiğiniz zaman hakkında okuyabileceğiniz, düzenleyebileceğiniz ve
  geri alabileceğiniz dosyalarda notlar tutar.
- **[Duygular](https://docs.animama.ai/emotions):** Birlikte geçirdiğiniz zamana göre değişen ve
  yüzünde, vücudunda ve sesinde görünen 24 duygu.
- **[Hareketler](https://docs.animama.ai/behaviors#gestures):** Konuşurken seçilen vücut dili;
  eğlenceli hareketlerden romantik jestlere kadar. 300'den fazla hareket ve tepki
  dahildir.
- **[Tepkiler](https://docs.animama.ai/behaviors#reactions):** Anime tarzı efektlerle hafiften
  yoğuna dört şiddet düzeyinde her duygu için bir ifade.

## İndir

| Platform | Gereksinim | Yükleyici | Boyut |
| --- | --- | --- | --- |
| macOS | macOS 15 veya üzeri, Apple silicon | [Animama-0.1.5-arm64.dmg](https://downloads.animama.ai/desktop/v0.1.5/Animama-0.1.5-arm64.dmg) | 418 MB (kurulu 889 MB) |
| Windows | Windows 11 x64, derleme 22000 veya üzeri | [Animama-0.1.6-x64-setup.exe](https://downloads.animama.ai/desktop/v0.1.6/Animama-0.1.6-x64-setup.exe) | 377 MB (kurulu 988 MB) |

Windows'ta Animama yeni olduğu için SmartScreen "Windows bilgisayarınızı korudu" diyebilir.
**Ek bilgi**'yi seçin, yayıncının Raymond Van olduğunu doğrulayın, ardından
**Yine de çalıştır**'ı seçin.

## Yapay Zeka Modelleri

Kurulum sırasında veya **App Settings** bölümünden seçeceğiniz [ChatGPT planınızı](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)
ya da kendi API anahtarlarınızı kullanın. Anahtarlar bilgisayarınızda şifreli olarak saklanır.

### [Sohbet](https://docs.animama.ai/#setup)

| Sağlayıcı | Bağlantı yöntemi | Model |
| --- | --- | --- |
| OpenAI | ChatGPT planı | Planınızın içerdiği modeller |
| OpenAI | API anahtarı | GPT-6 Luna (önerilen) |
| Anthropic | API anahtarı | Claude Haiku 5.5 (önerilen) |
| OpenRouter veya OpenAI uyumlu herhangi bir uç nokta | API anahtarı | Kendi seçiminiz |

ChatGPT planınızı kullanmak için **Continue with ChatGPT**'yi seçin ve OpenAI'da oturum
açın. API anahtarı gerekmez ve kullanım plan limitlerinize dahil edilir.
Kendi sunucunuzda barındırırken, Animama'yı çalıştıran bilgisayardaki bir tarayıcıdan oturum açın.
Mevcut yükleyiciler henüz bunu içermez; kaynaktan kendi sunucunuzda çalıştırırken desteklenir.

Önerilen API modelleri düşük maliyetlidir; bu nedenle birkaç dolarlık API kullanımı uzun süre yeter.

#### Yerel modeller

Ollama, LM Studio, llama.cpp ve vLLM çalışır ancak deneyseldir. Çıkarım motoru
katı JSON çıktısını, model ise araç çağırmayı desteklemelidir. Kurulum için
[Yerel model sunucuları](docs/backend/operations/local-models.md) belgesine bakın.

### [STT](https://docs.animama.ai/voice#speech-to-text)

Her iki motor da bilgisayarınızda çalışır. GPU (WebGPU) sürümü önerilir:
konuşurken kelimelerinizi anlık olarak gösterir.

| Motor | Diller |
| --- | --- |
| Parakeet | İngilizce |
| SenseVoice | Japonca, Korece, Çince |

### [TTS](https://docs.animama.ai/voice#text-to-speech)

| Motor | Maliyet | Notlar |
| --- | --- | --- |
| [ElevenLabs](https://elevenlabs.io) (önerilen) | Ayda yaklaşık 20 dakika ücretsiz | En ifadeli sesler; [ses kütüphanesinden](https://elevenlabs.io/voice-library) seçin |
| Pocket TTS | Ücretsiz, yerleşik | Bilgisayarınızda çalışır ve ses klonlayabilir |

## Kendi Sunucunuzda Barındırma

<details>
<summary><h3>Masaüstü</h3></summary>

Masaüstü uygulamasını kendiniz derleyin. Derleme imzasızdır ve kendi bilgisayarınız içindir.
Ayrıntılar için [Masaüstü derlemeleri](docs/frontend/desktop/platforms.md) belgesine bakın.

<details>
<summary><h4>macOS</h4></summary>

Xcode komut satırı araçları, Node 24, pnpm, uv ve Git LFS yüklü bir Apple silicon Mac gerektirir.

```bash
git clone https://github.com/raymond-van/animama.git
cd animama
git lfs pull
python3 scripts/models/browser_speech.py acquire
cd src/frontend
pnpm install --frozen-lockfile
pnpm desktop:mac:build:run
```

Uygulama `src/frontend/desktop/release/mac/Animama.app` konumuna yazılır.

</details>

<details>
<summary><h4>Windows</h4></summary>

Visual Studio 2022 (MSVC v143 14.44 araç takımı, Windows SDK 10.0.26100), Node 24, pnpm, uv
ve Git LFS yüklü Windows 11 x64 gerektirir. PowerShell'de:

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

Yükleyici `src/frontend/desktop/release/` konumuna yazılır. Windows 10 22H2 ve Windows 11
üzerine kurulabilir.

</details>

</details>

<details>
<summary><h3>Web</h3></summary>

Animama'yı bilgisayarınızda bir sunucu olarak çalıştırın ve tarayıcınızda kullanın. macOS veya
Linux (WSL üzerinden Windows), Compose ile Docker, Git LFS ve Python 3.11 veya üzerini
gerektirir.

```bash
git clone https://github.com/raymond-van/animama.git
cd animama
git lfs pull
python3 scripts/models/browser_speech.py acquire  # isteğe bağlı: Pocket TTS ve Smart Turn
ANIMAMA_WEB_BUILD_MODE=production ./reset.sh
```

Ardından <http://localhost:8000> adresini açın. Sunucuya API anahtarlarınızı,
[kimlik bilgileri](docs/backend/operations/development.md#credentials-and-nonsecret-configuration)
bölümünde açıklandığı gibi depo dışındaki bir ortam dosyası üzerinden verin.

Sunucu yalnızca bilgisayarınızı dinler. Başka bir cihazdan erişmek için önüne kendi
TLS ve kimlik doğrulama katmanınızı ekleyin.

</details>

## Katkıda Bulunma

Hata raporları, özellik fikirleri ve pull request'ler memnuniyetle karşılanır. Bir hata mı buldunuz?
[Hata bildirim formunu](https://github.com/raymond-van/animama/issues/new?template=bug.yml) kullanın.
Pull request açmadan önce [katkı rehberini](.github/CONTRIBUTING.md) okuyun.

## Teşekkürler

- Kyutai tarafından [Pocket TTS](https://github.com/kyutai-labs/pocket-tts): cihaz içi
  sesler
- Pipecat tarafından [Smart Turn](https://github.com/pipecat-ai/smart-turn): konuşmayı
  ne zaman bitirdiğinizi anlama
- NVIDIA tarafından [Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) ve
  FunAudioLLM tarafından [SenseVoice](https://github.com/FunAudioLLM/SenseVoice):
  konuşma tanıma
- pixiv tarafından [three-vrm](https://github.com/pixiv/three-vrm) ve
  [VRoid](https://vroid.com/en): avatar oluşturma ve dahil edilen avatarlar
- Mochiya Labs tarafından [Mochiya Avatar Tools](https://github.com/mochiya-labs/unity-avatar-tools) ve
  [three-liltoon](https://github.com/mochiya-labs/three-liltoon): VRChat avatar dönüştürme ve lilToon materyalleri
- [three.quarks](https://github.com/Alchemist0823/three.quarks): parçacık
  efektleri
- [Lapwing](https://booth.pm/ja/items/4993931) ©kuji
