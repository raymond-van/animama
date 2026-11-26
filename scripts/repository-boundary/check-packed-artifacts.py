#!/usr/bin/env python3
"""Install reviewed artifacts outside the checkout and run their real consumers.

The wheel and tarballs are inputs, never editable/workspace dependencies. The
consumer directory is retained as evidence, including build/test logs and the
browser screenshot. Network access installs dependencies only; fixture product
requests use injected transports and no hosted service.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).with_name("consumers")
PACKAGES = ("@animama/runtime-contracts", "@animama/product-ui", "@animama/discover-client")
# A line each package's third-party notice must carry for the code it contains
# (licenses/third-party/adapted-code.md lists the files).
THIRD_PARTY_NOTICES = {
    "@animama/runtime-contracts": "Copyright (c) Hey API",
    "@animama/product-ui": "Copyright (c) 2023 shadcn",
}
# The licence texts the wheel's dist-info must carry, each with a line it must
# contain: the AGPL and the upstream licences of the backend code adapted from
# Letta and the OpenAI Agents SDK (licenses/third-party/adapted-code.md).
WHEEL_LICENSES = {
    "LICENSE": "GNU AFFERO GENERAL PUBLIC LICENSE",
    "licenses/third-party/adapted-code.md": "src/backend/animama/domain/usage.py",
    "licenses/third-party/code-Apache-2.0.txt": "Apache License",
    "licenses/third-party/code-letta-LICENSE.txt": "Apache License",
    "licenses/third-party/code-openai-agents-LICENSE.txt": "Copyright (c) 2025 OpenAI",
}
# Wall time of each consumer step in run order, reported in summary.json.
PHASES: list[dict] = []


@contextmanager
def phase(name: str):
    """Record one step's wall time, including a failed step's time before it raised."""
    started = time.monotonic()
    try:
        yield
    finally:
        PHASES.append({"name": name, "seconds": round(time.monotonic() - started, 1)})


def digest(path: Path) -> str:
    """Fingerprint exactly the artifact that the isolated consumer installs."""
    result = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def export_targets(value):
    """Walk conditional exports without guessing which condition a tool selects."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from export_targets(child)
    elif isinstance(value, list):
        for child in value:
            yield from export_targets(child)


def inspect_tarball(path: Path) -> dict:
    """Reject malformed packages and source-bound dependency/export contracts."""
    with tarfile.open(path, "r:gz") as archive:
        files = {}
        for member in archive.getmembers():
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] != "package" or ".." in parts or member.name.startswith("/"):
                raise ValueError(f"Unsafe package member in {path.name}: {member.name}")
            if member.issym() or member.islnk():
                raise ValueError(f"Package contains a link: {member.name}")
            if member.isfile():
                files[member.name.removeprefix("package/")] = archive.extractfile(member).read()
        metadata = json.loads(files["package.json"])
        if metadata.get("name") not in PACKAGES:
            raise ValueError(f"Unexpected package: {metadata.get('name')}")
        exports = metadata.get("exports", {})
        if "." not in exports:
            raise ValueError(f"Missing root export: {metadata['name']}")
        for target in export_targets(exports):
            if not target.startswith("./dist/") or target[2:] not in files:
                raise ValueError(f"Export must name emitted artifact bytes: {metadata['name']} {target}")
        for group in ("dependencies", "peerDependencies", "optionalDependencies"):
            for name, version in metadata.get(group, {}).items():
                if version.startswith(("workspace:", "file:", "link:")):
                    raise ValueError(f"Source dependency in packed manifest: {name}={version}")
        if not any(path.endswith(".d.ts") for path in files):
            raise ValueError(f"Missing declarations: {metadata['name']}")
        if not files.get("dist/LICENSE", b"").strip():
            raise ValueError(f"Missing licence: {metadata['name']}")
        required = THIRD_PARTY_NOTICES.get(metadata["name"])
        if required and required.encode() not in files.get("dist/THIRD_PARTY_NOTICES.md", b""):
            raise ValueError(f"Missing third-party notice: {metadata['name']}")
        if metadata["name"] == "@animama/product-ui" and "./styles.css" not in exports:
            raise ValueError("Product UI must export its CSS")
        for name, data in files.items():
            if name.endswith((".js", ".mjs", ".d.ts")):
                for forbidden in (b'from "@/', b"from '@/", b"/src/frontend/web/", b"node_modules/.pnpm/"):
                    if forbidden in data:
                        raise ValueError(f"Checkout-bound import in {metadata['name']}/{name}")
        return {"name": metadata["name"], "version": metadata["version"], "files": len(files), "sha256": digest(path)}


def inspect_wheel(path: Path) -> dict:
    """Require an ordinary installable wheel with its licence texts, never an editable source redirect."""
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if not any(name.startswith("animama/domain/") for name in names):
            raise ValueError("Wheel does not contain the shared domain package")
        if any(name.endswith(".pth") or "__editable__" in name for name in names):
            raise ValueError("Editable import redirects are not an artifact boundary")
        licences = {name.split(".dist-info/licenses/", 1)[1]: name for name in names if ".dist-info/licenses/" in name}
        for licence, line in WHEEL_LICENSES.items():
            if licence not in licences or line.encode() not in archive.read(licences[licence]):
                raise ValueError(f"Wheel is missing licence text: {licence}")
        return {"name": path.name, "files": len(names), "sha256": digest(path)}


def run(command: list[str], *, cwd: Path, logs: Path, name: str, env: dict) -> None:
    """Keep verbose tool output in evidence files and fail with a bounded tail."""
    print(f"{name}: running", flush=True)
    output = logs / f"{name}.log"
    with phase(name), output.open("w") as stream:
        result = subprocess.run(command, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT)
    if result.returncode:
        tail = "\n".join(output.read_text(errors="replace").splitlines()[-35:])
        raise RuntimeError(f"{name} failed ({result.returncode}) after {PHASES[-1]['seconds']} s; {output}\n{tail}")
    print(f"{name}: passed in {PHASES[-1]['seconds']} s", flush=True)


def assert_no_checkout_links(directory: Path) -> None:
    """A package-manager store may copy bytes, but must not link source into tests."""
    for parent, directories, files in os.walk(directory, followlinks=False):
        for name in directories + files:
            path = Path(parent) / name
            if path.is_symlink() and path.resolve().is_relative_to(ROOT):
                raise ValueError(f"Consumer resolves back into checkout: {path}")


def consumer_package(fixture: dict, tarballs: dict[str, str]) -> dict:
    """Point the fixture at the packed tarballs, keeping its own dependency holds.

    Registry dependencies otherwise resolve fresh. A fixture override holds a
    transitive dependency back only while an upstream release breaks a
    consumer for reasons outside these packages (see README.md).
    """
    if "resolutions" in fixture:
        raise ValueError("Hold fixture dependencies with pnpm.overrides, not resolutions")
    held = fixture.get("pnpm", {}).get("overrides", {})
    # Any selector form (`name@range`, `parent>name`) still names the package.
    if redirected := sorted(key for key in held if any(name in key for name in tarballs)):
        raise ValueError(f"Fixture overrides cannot name packed packages: {', '.join(redirected)}")
    package = json.loads(json.dumps(fixture))
    package["dependencies"].update(tarballs)
    # Only overrides: other pnpm settings could reshape a packed package's graph.
    package["pnpm"] = {"overrides": {**held, **tarballs}}
    return package


def dependency_receipt(paths: list[Path], work: Path) -> dict:
    """Bind fresh-resolution evidence without claiming a frozen consumer build."""
    return {
        "mode": "fresh-resolution",
        "source_lockfiles_used": False,
        "evidence": [{"path": str(path.relative_to(work)), "sha256": digest(path)} for path in paths],
    }


def main() -> int:
    """Run both ecosystems in a retained directory outside the source repository."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path, help="Directory containing one wheel and all three npm tarballs")
    parser.add_argument("--offline", action="store_true", help="Use previously cached dependency artifacts only")
    parser.add_argument("--work-dir", type=Path, help="New, empty consumer directory outside the repository")
    parser.add_argument(
        "--pnpm-store", type=Path, help="Optional content-addressed pnpm cache (copied, never source-linked)"
    )
    parser.add_argument(
        "--previous-app-set", type=Path, help="Verified clean format-2+ predecessor for actual app upgrade/rollback"
    )
    args = parser.parse_args()
    artifact_dir = args.artifacts.resolve()
    # Verification tooling is reviewed public code; runtime consumers below
    # receive only copied fixtures, installed artifacts and verified app bytes.
    sys.path.insert(0, str(ROOT / "scripts/package-sets"))
    from application import require_distinct_resources, unpack_application
    from package_set import compare, verify

    with phase("verify-set"):
        manifest = verify(artifact_dir)
    artifacts = {}
    reports = []
    for path in sorted(artifact_dir.glob("*.tgz")):
        report = inspect_tarball(path)
        if report["name"] in artifacts:
            raise ValueError(f"Multiple tarballs for {report['name']}")
        artifacts[report["name"]] = path
        reports.append(report)
    if set(artifacts) != set(PACKAGES):
        raise ValueError(f"Require exactly these packed packages: {', '.join(PACKAGES)}")
    wheels = list(artifact_dir.glob("*.whl"))
    if len(wheels) != 1:
        raise ValueError("Require exactly one public backend wheel in the artifact directory")
    wheel = wheels[0]
    wheel_report = inspect_wheel(wheel)
    work = args.work_dir.resolve() if args.work_dir else Path(tempfile.mkdtemp(prefix="animama-packed-consumer-"))
    if work.is_relative_to(ROOT) or ROOT.is_relative_to(work):
        raise ValueError("The consumer directory must be outside the checkout")
    if work.exists() and any(work.iterdir()):
        raise ValueError("The consumer directory must be empty")
    work.mkdir(parents=True, exist_ok=True)
    logs = work / "logs"
    logs.mkdir()
    # Remove implicit runtime search paths and project selection. Never load the
    # maintainer's .env or inherited application credentials in these consumers.
    allowed = {"PATH", "HOME", "TMPDIR", "SYSTEMROOT", "UV_CACHE_DIR", "PLAYWRIGHT_BROWSERS_PATH"}
    env = {key: value for key, value in os.environ.items() if key in allowed}
    env.update(CI="true", PYTHONNOUSERSITE="1", UV_NO_SOURCES="1", UV_NO_CONFIG="1")
    frontend = work / "frontend"
    shutil.copytree(FIXTURES / "frontend", frontend)
    inputs = frontend / "artifacts"
    inputs.mkdir()
    tarballs = {}
    for name, path in artifacts.items():
        shutil.copy2(path, inputs / path.name)
        tarballs[name] = f"file:artifacts/{path.name}"
    package = consumer_package(json.loads((frontend / "package.json").read_text()), tarballs)
    (frontend / "package.json").write_text(json.dumps(package, indent=2) + "\n")
    install = [
        "pnpm",
        "install",
        "--ignore-workspace",
        "--no-frozen-lockfile",
        "--ignore-scripts",
        "--package-import-method=copy",
    ]
    if args.offline:
        install.append("--offline")
    if args.pnpm_store:
        install += ["--store-dir", str(args.pnpm_store.resolve())]
    run(install, cwd=frontend, logs=logs, name="frontend-install", env=env)
    # Preserve the resolved graph before any check can fail or CI reclaims the
    # environment. This consumer deliberately tests fresh dependency resolution.
    frontend_lock = logs / "frontend-pnpm-lock.yaml"
    shutil.copy2(frontend / "pnpm-lock.yaml", frontend_lock)
    run(
        ["pnpm", "list", "--depth", "Infinity", "--json"],
        cwd=frontend,
        logs=logs,
        name="frontend-dependencies",
        env=env,
    )
    assert_no_checkout_links(frontend)
    run(["pnpm", "exec", "tsc", "--noEmit"], cwd=frontend, logs=logs, name="frontend-types", env=env)
    run(["pnpm", "exec", "vite", "build"], cwd=frontend, logs=logs, name="frontend-build", env=env)
    run(["node", "verify.mjs"], cwd=frontend, logs=logs, name="frontend-browser", env=env)

    application = None
    whole_app = None
    if manifest.get("applications"):
        record = manifest["applications"][0]
        application = work / "application"
        with phase("unpack-application"):
            app_manifest = unpack_application(
                artifact_dir / record["file"],
                application,
                manifest["source"]["commit"],
                record["version"],
                manifest["contracts"],
                archive_sha256=record["sha256"],
                source_tree=manifest["source"]["tree"],
            )
        tooling = frontend / "hosted-app"
        shutil.copytree(FIXTURES / "hosted-app", tooling)
        shutil.copy2(
            ROOT / "src/frontend/web/scripts/fixtures/hosted-workflows-http.mjs", tooling / "hosted-workflows-http.mjs"
        )
        if args.previous_app_set:
            previous_directory = args.previous_app_set.resolve()
            with phase("previous-application"):
                previous = verify(previous_directory)
                if previous["schema_version"] < 2 or previous["source"]["dirty"] or manifest["source"]["dirty"]:
                    raise ValueError("Actual app upgrade/rollback requires two clean application (format 2+) sets")
                if (
                    previous["source"]["commit"] == manifest["source"]["commit"]
                    or previous["source"]["tree"] == manifest["source"]["tree"]
                ):
                    raise ValueError("Actual edited-data rollback requires two genuine distinct source generations")
                compare(previous_directory, artifact_dir)
                previous_record = previous["applications"][0]
                previous_application = work / "previous-application"
                previous_app = unpack_application(
                    previous_directory / previous_record["file"],
                    previous_application,
                    previous["source"]["commit"],
                    previous_record["version"],
                    previous["contracts"],
                    archive_sha256=previous_record["sha256"],
                    source_tree=previous["source"]["tree"],
                )
            # Before any browser work: byte-identical apps cannot claim an upgrade.
            require_distinct_resources(previous_app, app_manifest)
            selection_kind = "verified-clean-package-set-pair"
        else:
            spec = importlib.util.spec_from_file_location("selection_fixture", tooling / "selection_fixture.py")
            fixture = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(fixture)
            with phase("controlled-variant"):
                previous_application = fixture.previous_resource_fixture(
                    application, work / "controlled-selection", manifest["contracts"]
                )
            selection_kind = "controlled-resource-variant"
        run(
            ["node", "verify.mjs", str(application), str(previous_application), selection_kind],
            cwd=tooling,
            logs=logs,
            name="whole-application-browser",
            env=env,
        )
        browser_receipt = json.loads((tooling / "whole-app-receipt.json").read_text())
        clip_receipt = browser_receipt["clip_compatibility"]
        if (
            clip_receipt["mode"] != "v2-edited-data"
            or clip_receipt["minimum_edited_data_rollback_format"] != "animaPoseClip/2.0"
            or any(row["emitted_schema"] != "animaPoseClip/2.0" for row in clip_receipt["format_generations"])
        ):
            raise ValueError("The primary pair must prove the explicit 2.0 clip format")
        if args.previous_app_set and not clip_receipt["exact_edited_data_rollback"]:
            raise ValueError("The genuine predecessor must pass edited-data rollback")
        whole_app = {
            "artifact": record,
            "manifest_sha256": digest(application / "app-manifest.json"),
            "catalog_seed": app_manifest["catalog_seed"],
            "selection_kind": selection_kind,
            "exact_clean_upgrade_rollback": (
                selection_kind == "verified-clean-package-set-pair" and clip_receipt["exact_edited_data_rollback"]
            ),
            "minimum_edited_data_rollback": {
                "clip_format": "animaPoseClip/2.0",
                "predecessor_source": previous["source"] if args.previous_app_set else None,
                "predecessor_manifest_sha256": digest(previous_directory / "manifest.json")
                if args.previous_app_set
                else None,
                "current_source": manifest["source"],
                "current_manifest_sha256": digest(artifact_dir / "manifest.json"),
                "product_runtime_difference_asserted": False,
            },
            "browser_receipt": {
                "path": str((tooling / "whole-app-receipt.json").relative_to(work)),
                "sha256": digest(tooling / "whole-app-receipt.json"),
            },
            "fixture_inputs": {
                str(path.relative_to(ROOT)): digest(path)
                for path in sorted((FIXTURES / "hosted-app").glob("*"))
                if path.is_file()
            },
        }

    backend = work / "backend"
    backend.mkdir()
    for fixture in ("backend", "contracts", "content", "catalog_seed", "product_http"):
        shutil.copy2(FIXTURES / f"{fixture}.py", backend / f"{fixture}_consumer.py")
    shutil.copy2(wheel, backend / wheel.name)
    run(
        ["uv", "venv", "--python", sys.executable, str(backend / ".venv")],
        cwd=backend,
        logs=logs,
        name="backend-environment",
        env=env,
    )
    python = backend / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    install = ["uv", "pip", "install", "--python", str(python), str(backend / wheel.name)]
    if args.offline:
        install.append("--offline")
    run(install, cwd=backend, logs=logs, name="backend-install", env=env)
    # Name/version inventory contains no inherited registry credentials or
    # developer paths. It describes installed distributions, not wheel hashes.
    run(
        [
            str(python),
            "-I",
            "-c",
            "import importlib.metadata as m, json; "
            "print(json.dumps(sorted([{'name': d.metadata['Name'], 'version': d.version} "
            "for d in m.distributions()], key=lambda d: d['name'].lower()), indent=2))",
        ],
        cwd=backend,
        logs=logs,
        name="backend-dependencies",
        env=env,
    )
    assert_no_checkout_links(backend)
    run(
        [str(python), "-I", "backend_consumer.py", "--forbid-source", str(ROOT)],
        cwd=backend,
        logs=logs,
        name="backend-consumer",
        env=env,
    )
    for fixture in ("contracts", "content", "product_http"):
        run(
            [str(python), "-I", f"{fixture}_consumer.py"],
            cwd=backend,
            logs=logs,
            name=f"backend-{fixture}-consumer",
            env=env,
        )
    if application:
        run(
            [str(python), "-I", "catalog_seed_consumer.py", str(application / "catalog-seed")],
            cwd=backend,
            logs=logs,
            name="backend-included-seed-consumer",
            env=env,
        )
    dependencies = dependency_receipt(
        [frontend_lock, logs / "frontend-dependencies.log", logs / "backend-dependencies.log"],
        work,
    )
    summary = {
        "artifacts": reports,
        "wheel": wheel_report,
        "consumer_directory": str(work),
        "dependency_resolution": dependencies,
        "whole_application": whole_app,
        "source_checkout_available_to_consumers": False,
        "result": "passed",
        "phases": PHASES,
    }
    (work / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError, OSError, KeyError) as error:
        print(f"Packed artifact check failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
