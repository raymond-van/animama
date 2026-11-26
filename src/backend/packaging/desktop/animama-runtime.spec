# -*- mode: python ; coding: utf-8 -*-
"""Python 3.12 onedir core, including the upload parsers (the ``documents`` extra).

The parse child imports each parser library only for its format; the analysis
still follows those imports, and pyinstaller-hooks-contrib collects their native
and data files (PDFium's library and version files, lxml, the python-docx and
python-pptx templates).
"""
import importlib.metadata
import re
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata
from PyInstaller.config import CONF

repo = Path(SPECPATH).resolve().parents[3]
sys.path.insert(0, str(repo / "src/backend"))
from animama.runtime.resources import RESOURCE_INPUTS

datas = collect_data_files("animama", excludes=["**/__pycache__/**"])
for target, relative in RESOURCE_INPUTS.items():
    source = repo / relative
    if not source.exists():
        raise RuntimeError(f"Missing frozen resource input: {relative}")
    if source.is_file():
        # The two web-owned manifests deliberately have stable packaged names.
        staged = Path(CONF["workpath"]) / "resource-inputs" / target
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(source.read_bytes())
        datas.append((str(staged), "animama/resources/runtime"))
    else:
        for file in sorted(source.rglob("*")):
            if file.is_file() and "__pycache__" not in file.parts and file.suffix != ".pyc":
                folder = Path("animama/resources/runtime") / target / file.parent.relative_to(source)
                datas.append((str(file), str(folder)))

# Metadata is used by provider SDKs and telemetry entrypoints. The build venv
# contains only the locked core dependency closure plus freezer tools.
for distribution in importlib.metadata.distributions():
    datas += copy_metadata(distribution.metadata["Name"])
for package in ("tiktoken_ext", "llama_index.core", "certifi", "agents"):
    datas += collect_data_files(package)

hiddenimports = collect_submodules("animama") + collect_submodules("uvicorn")
hiddenimports += collect_submodules("psycopg_binary") + collect_submodules("tiktoken_ext")
# Namespace packages and telemetry plugins are imported via package entrypoints.
hiddenimports += collect_submodules("opentelemetry")

a = Analysis(
    [str(repo / "src/backend/packaging/desktop/entrypoint.py")],
    pathex=[str(repo / "src/backend")],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    excludes=["pytest", "debugpy", "IPython", "tkinter"],
    noarchive=False,
)
# Editable-install metadata is a build-machine locator, not a runtime resource.
a.datas = [entry for entry in a.datas if Path(entry[0]).name != "direct_url.json"]
if sys.platform == "win32":
    # Windows 10 and later provide the Universal CRT; its forwarder copies add nothing.
    a.binaries = [
        entry
        for entry in a.binaries
        if not re.fullmatch(r"(api-ms-win-.+|ucrtbase)\.dll", Path(entry[0]).name, re.IGNORECASE)
    ]
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [], exclude_binaries=True, name="animama-runtime",
    debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
    console=True, target_arch="arm64" if sys.platform == "darwin" else None,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="animama-runtime")
