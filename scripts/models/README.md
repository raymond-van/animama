# Verified speech model setup

Run from the Animama checkout with Python 3.11+ on macOS, Linux or native Windows.
On Windows, use `py -3` where these examples use `python3`. Setup uses only
Python's standard library and the pinned public sources each manifest names;
no account, API key or Hugging Face SDK is required.

```sh
python3 scripts/models/parakeet.py acquire
python3 scripts/models/parakeet.py verify
python3 scripts/models/parakeet.py path
```

`acquire` is the only operation that can download. `verify` and `path` always
verify the complete local inventory without network access. Each successful
command prints only the verified absolute model directory. Exit 2 means a store
or selected version has not been acquired; exit 1 means invalid configuration,
corrupt data or another setup failure. Desktop core-only tooling may distinguish
an absent default cache from invalid explicitly selected input.

The default store is `~/Library/Caches/Animama/models` on macOS and
`${XDG_CACHE_HOME:-$HOME/.cache}/animama/models` on Linux (including WSL), and
`%LOCALAPPDATA%\Animama\models` on native Windows. An absolute
`ANIMAMA_MODEL_ROOT` selects another store; `--root /absolute/store` overrides it.
Use persistent storage writable by your setup user for self-host installations:

```sh
python3 scripts/models/parakeet.py acquire --root /var/lib/animama/models
python3 scripts/models/parakeet.py path --root /var/lib/animama/models --offline
```

The resolved directory is `<store>/parakeet-tdt-0.6b-v2/<manifest-digest>`, where
the digest is SHA-256 of the exact checked-in manifest bytes. Seven required
files are size/hash verified, including Animama's preserved README and
attribution. Changes create separate version directories; worktrees sharing
this manifest reuse the same bytes. `--manifest PATH` selects a local reviewed
manifest or small build/test fixture; it never accepts arbitrary upstream URLs,
repositories, moving revisions or inventory paths.

`acquire` downloads the original pinned upstream weights from Hugging Face and
uses the checked-in notices. Until `downloads.animama.ai` is disconnected,
`--source animama` instead fetches Animama's published objects,
`https://downloads.animama.ai/models/parakeet-tdt-0.6b-v2/<sha256>/<filename>`,
including both notices; a missing object fails without falling back to another
source. After the cut-off that option only fails.

```sh
python3 scripts/models/parakeet.py acquire                   # pinned upstream (default)
python3 scripts/models/parakeet.py acquire --source animama  # until the cut-off
```

Both sources produce the same verified directory; existing valid caches and
offline imports need no new download. The full/cold-cache Validation workflow
names `--source upstream` explicitly. Other model setup scripts retain their own
manifest sources.

To adopt an existing model copy without downloading:

```sh
python3 scripts/models/parakeet.py acquire --offline \
  --import-from /absolute/existing/parakeet-tdt-0.6b-v2
```

Import copies and verifies each required file; it leaves the original intact.
Only remove an old copy after its consumers use the verified store. Import and
fresh acquisition need enough free space for one complete new model set. A
successful fresh acquisition retains one set plus a small empty lock file; it
does not create an additional SDK download cache.

A per-version process lock serializes acquisition. Downloads stream with strict
size bounds into a private staging directory and are promoted together only
after every SHA-256 matches. An interrupted command safely restarts, without
publishing partial data. Normal exceptions remove its staging directory; a
killed process can leave a hidden `.partial-*` directory. Explicitly remove such
leftovers only after confirming no acquisition process still owns them.

Existing corrupt versions are reported and never overwritten automatically.
Stop stacks/applications using that version, quarantine or remove that exact
version directory, then run `acquire` again. Do not delete other versions or an
entire cache as a repair ritual. Store cleanup is explicit: inspect active
stack records and processes before removing unused versions. Files are made
read-only to discourage accidental edits, but the owning user can still alter
them; consumers verify before use.

Requests and redirects use HTTPS and a fixed reviewed host list: Hugging Face
hosts by default, or Animama's download origin with `--source animama` until
the cut-off.
The downloader sends no credentials and does not inherit environment proxies.
HTTP errors, including throttling, fail with instructions to retry later; no
automatic retries hide repeated failures. Interrupted/failed transfers restart
rather than attempting unvalidated byte-range resume. Serving and ordinary
startup never download or choose a different model version.

Packaged desktop and built self-host download speech-to-text sets through their
own backend model-asset service into the application's data root, until the
final release turns downloads off. The developer store is a build/setup input, not the
installed application's model store.

Native Windows model-store tests can be run with
`uv run --no-project --with pytest==9.2.0 python -m pytest --noconftest -o addopts= tests/test_model_store.py -q`.
This tests model tooling without installing the backend dependency graph.
The single hosted Validation job runs on Linux; native Windows execution is a
separate validation step and is not established by that job. Native Windows
application/packaging support remains separately gated.

## Optional WebGPU encoder

`python3 scripts/models/parakeet_webgpu.py acquire|verify|path` manages the
optional FP16 encoder used by the experimental WebGPU speech setting. It uses the
same store, options and exit codes as `parakeet.py`. It downloads about 1.24 GB
from the pinned `ysdede/parakeet-tdt-0.6b-v2-onnx` revision and verifies a
three-file inventory (encoder, README and attribution) under
`<store>/parakeet-tdt-0.6b-v2-webgpu/<manifest-digest>`. The base Parakeet set
remains required.

## SenseVoice multilingual sets

`python3 scripts/models/sensevoice.py acquire|verify|path` manages the
SenseVoice-Small set that transcribes Japanese, Korean, Mandarin (Simplified and
Traditional) and Cantonese offline on the CPU: the INT8 graph, its token table,
`metadata.json` (the graph's front-end parameters, which the browser runtime
cannot read from ONNX) and the two notices, about 240 MB under
`<store>/sensevoice-small/<manifest-digest>`. It uses the same store, acquire
options (`--root`, `--offline`, `--import-from`, `--source`) and exit codes as
`parakeet.py`: the default source downloads the pinned
`csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` revision, and
`--source animama` Animama's published objects until the cut-off.

`python3 scripts/models/sensevoice_webgpu.py acquire|verify|path` manages the
optional FP32 graph (about 940 MB) used on WebGPU, where the INT8 graph's
quantized operators have no kernels. It acquires from the same pinned upstream
revision and requires the base SenseVoice set. Both sets are licensed under the
FunASR Model License 1.1, which requires attributing the source and author and
keeping the model name.

## Browser core and optional cloning

`python3 scripts/models/browser_speech.py acquire|verify|path` manages the 11
core model files: Pocket generation with Eve, Azelma and Michael, plus Smart
Turn. Vite combines them with 11 pinned dependency files into the 22-file
browser runtime. Ordinary serving and builds verify these inputs offline; they do not
require optional voices or the cloning encoder.

`python3 scripts/models/pocket_cloning.py acquire|verify|path` manages the
optional Mimi encoder and its two notices for release and voice-authoring
preparation; it always acquires from the reviewed upstream. The installed
application downloads it only after an explicit cloning or download action.

## Release-only bootstrap

An unpublished release cannot fetch its own new model objects. From a clean,
reviewed checkout, populate a producer store explicitly:

```sh
python3 scripts/models/release_inputs.py \
  --root /absolute/release-model-store \
  --work-dir /absolute/voice-producer-work
```

This acquires pinned base Parakeet, GPU, SenseVoice, browser core and cloning inputs; fetches
the reviewed voice sources; and encodes only the 24 selected VCTK sources with
the locked script environment. It requires the existing encoded hashes, never
uses `--rehash`, rejects changes to generated tracked inventories, then imports
the complete 36-voice set offline. Encoding drift fails the release preparation;
do not approve new hashes to make a different platform pass.

`pocket_voices.py acquire` fetches the 24 VCTK states Animama encoded from
`downloads.animama.ai`, their only published copy, so after the cut-off it
works only with `--offline --import-from` an existing set (or through this
helper, which encodes them again).

Add `--import-voices /absolute/import-voice-set` to reuse an existing complete
producer inventory instead of encoding. The same size/hash checks apply. Set
`ANIMAMA_MODEL_ROOT` to the chosen store for subsequent release commands. This
helper neither scans nor publishes; continue through the separate
[release gates](../../docs/frontend/desktop/release-process.md).
