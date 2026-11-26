"""State tooling must use the selected graph and preserve backup compatibility."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]


def _clean_environment(tmp_path: Path) -> dict[str, str]:
    env_file = tmp_path / "empty.env"
    env_file.touch()
    return {
        **{key: value for key, value in os.environ.items() if not key.startswith(("ANIMAMA_", "COMPOSE_"))},
        "COMPOSE_ENV_FILES": str(env_file),
    }


@pytest.mark.parametrize("mode", ["development", "production"])
def test_state_commands_select_the_same_graph_as_reset(tmp_path: Path, mode: str) -> None:
    docker = tmp_path / "docker"
    docker.write_text(
        "#!/usr/bin/env python3\nimport json, os, sys\n"
        'if "--environment" not in sys.argv:\n'
        '    print(json.dumps({"files": os.environ["COMPOSE_FILE"], "args": sys.argv[1:]}))\n',
    )
    docker.chmod(0o755)
    env = {
        **_clean_environment(tmp_path),
        "PATH": f"{tmp_path}:{os.environ['PATH']}",
        "ANIMAMA_WEB_BUILD_MODE": mode,
        "ANIMAMA_PARAKEET_MODEL_DIR": "/verified/models",
        "ANIMAMA_BROWSER_MODEL_DIR": "/verified/browser-models",
    }
    env.pop("COMPOSE_FILE", None)
    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; animama_state_configure p3; animama_state_compose ps',
            "bash",
            str(REPO_ROOT / "scripts/local-stack-state-common.sh"),
        ],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    actual = json.loads(result.stdout)
    expected = str(REPO_ROOT / "docker-compose.yml")
    if mode == "development":
        expected += ":" + str(REPO_ROOT / "docker-compose.development.yml")
    assert actual == {"files": expected, "args": ["compose", "-p", "animama-p3", "ps"]}


def test_state_commands_preserve_the_recorded_graph(tmp_path: Path) -> None:
    docker = tmp_path / "docker"
    docker.write_text('#!/usr/bin/env bash\nprintf "%s" "$COMPOSE_FILE"\n')
    docker.chmod(0o755)
    recorded = "/fixture/base.yml:/fixture/development.yml"
    env = {
        **_clean_environment(tmp_path),
        "PATH": f"{tmp_path}:{os.environ['PATH']}",
        "COMPOSE_FILE": recorded,
        "ANIMAMA_PARAKEET_MODEL_DIR": "/verified/models",
        "ANIMAMA_BROWSER_MODEL_DIR": "/verified/browser-models",
        "ANIMAMA_WEB_BUILD_MODE": "production",
    }
    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; animama_state_configure p3; animama_state_compose ps',
            "bash",
            str(REPO_ROOT / "scripts/local-stack-state-common.sh"),
        ],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    assert result.stdout == recorded


def test_backup_keeps_legacy_exclusions_without_recreating_gateway_credentials() -> None:
    backup = (REPO_ROOT / "scripts/backup-local.sh").read_text()
    restore = (REPO_ROOT / "scripts/restore-local.sh").read_text()
    assert "--exclude='./internal/gateway/token'" in backup
    assert (
        "ANIMAMA_BACKUP_EXCLUDED=content-included,browser-cache,model-cache,downloaded-model-assets,secrets,gateway-token,"
        "chatgpt-plan-session" in backup
    )
    # Downloaded model assets are large; a restore keeps the installed ones.
    for script in (backup, restore):
        assert "--exclude='./internal/model-assets'" in script
        assert "--exclude='./staging/model-assets'" in script
    # The ChatGPT plan session holds tokens: never archived, and never extracted by a restore.
    common = (REPO_ROOT / "scripts/local-stack-state-common.sh").read_text()
    for script in (backup, restore):
        assert "--exclude='./internal/chatgpt-plan'" in script
    assert 'tar -xzf "$archive" -C "$root" --exclude=\'./internal/chatgpt-plan\'' in common
    assert "gateway_token" not in restore
    assert "local-gateway-token.sh" not in restore
    assert "content_cli" in restore
    assert 'replacement_started" = false' in restore


@pytest.mark.parametrize("explicit_empty", [False, True])
def test_state_commands_match_reset_empty_selector_rules(tmp_path: Path, explicit_empty: bool) -> None:
    docker = tmp_path / "docker"
    docker.write_text(
        "#!/usr/bin/env bash\n"
        'if [[ "$*" == *"config --environment"* ]]; then\n'
        '  printf "ANIMAMA_WEB_BUILD_MODE=\\n"\n'
        "else\n"
        '  printf "%s" "$COMPOSE_FILE"\n'
        "fi\n"
    )
    docker.chmod(0o755)
    env = {
        **_clean_environment(tmp_path),
        "PATH": f"{tmp_path}:{os.environ['PATH']}",
        "ANIMAMA_PARAKEET_MODEL_DIR": "/verified/models",
        "ANIMAMA_BROWSER_MODEL_DIR": "/verified/browser-models",
    }
    env.pop("COMPOSE_FILE", None)
    env.pop("ANIMAMA_WEB_BUILD_MODE", None)
    if explicit_empty:
        env["ANIMAMA_WEB_BUILD_MODE"] = ""
    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; animama_state_configure p3; animama_state_compose ps',
            "bash",
            str(REPO_ROOT / "scripts/local-stack-state-common.sh"),
        ],
        env=env,
        capture_output=True,
        text=True,
    )
    if explicit_empty:
        assert result.returncode == 2
        assert "must be development or production" in result.stderr
    else:
        assert result.returncode == 0
        assert result.stdout.endswith("/docker-compose.development.yml")


@pytest.mark.parametrize("selector", ["default", "environment", "dotenv", "production"])
def test_state_commands_resolve_missing_model_record_offline(tmp_path: Path, selector: str) -> None:
    scripts = tmp_path / "scripts"
    (scripts / "models").mkdir(parents=True)
    helper = scripts / "local-stack-state-common.sh"
    helper.write_text((REPO_ROOT / "scripts/local-stack-state-common.sh").read_text())
    (scripts / "models/parakeet.py").write_text(
        "import os, sys\n"
        "assert sys.argv[1] == 'path'\n"
        "assert not os.environ.get('TEST_FORBID_PARAKEET'), 'built graphs never resolve Parakeet'\n"
        "root = sys.argv[sys.argv.index('--root') + 1] if '--root' in sys.argv else '/default-model-store'\n"
        "print(root + '/parakeet-tdt-0.6b-v2/verified-version')\n"
    )
    (scripts / "models/browser_speech.py").write_text((scripts / "models/parakeet.py").read_text())
    (scripts / "models/sensevoice.py").write_text(
        (scripts / "models/parakeet.py").read_text().replace("parakeet-tdt-0.6b-v2", "sensevoice-small")
    )
    docker = tmp_path / "docker"
    docker.write_text(
        "#!/usr/bin/env bash\n"
        'if [[ "$*" == *"config --environment"* ]]; then\n'
        '  printf "ANIMAMA_MODEL_ROOT=%s\\n" "$TEST_DOTENV_ROOT"\n'
        "else\n"
        '  printf "%s|%s" "$ANIMAMA_PARAKEET_MODEL_DIR" "$ANIMAMA_SENSEVOICE_MODEL_DIR"\n'
        "fi\n"
    )
    docker.chmod(0o755)
    environment = _clean_environment(tmp_path)
    # Only the development graph mounts the host Parakeet set.
    environment.update(PATH=f"{tmp_path}:{os.environ['PATH']}", ANIMAMA_WEB_BUILD_MODE="development")
    root = "/default-model-store"
    if selector == "production":
        environment.update(ANIMAMA_WEB_BUILD_MODE="production", TEST_FORBID_PARAKEET="1")
    if selector == "environment":
        root = "/environment models"
        environment["ANIMAMA_MODEL_ROOT"] = root
    if selector == "dotenv":
        root = "/dotenv models"
        environment["TEST_DOTENV_ROOT"] = root
    result = subprocess.run(
        ["bash", "-c", 'source "$1"; animama_state_configure p2; animama_state_compose ps', "bash", str(helper)],
        env=environment,
        capture_output=True,
        text=True,
        check=True,
    )
    expected = (
        "|"
        if selector == "production"
        else f"{root}/parakeet-tdt-0.6b-v2/verified-version|{root}/sensevoice-small/verified-version"
    )
    assert result.stdout == expected


@pytest.mark.parametrize("project", ["animama-state-fixture", "custom-project"])
def test_state_selected_files_supply_project_and_host_roots_without_importing_secrets(
    tmp_path: Path, project: str
) -> None:
    # Copy the existing helper/graph, so this test cannot read repository .env.
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    helper = scripts / "local-stack-state-common.sh"
    shutil.copyfile(REPO_ROOT / "scripts/local-stack-state-common.sh", helper)
    shutil.copyfile(REPO_ROOT / "docker-compose.yml", tmp_path / "docker-compose.yml")
    shared = tmp_path / "shared secrets.env"
    shared.write_text("OPENAI_API_KEY=fixture-provider-secret\nPOSTGRES_PASSWORD=fixture-postgres-secret\n")
    shared.chmod(0o600)
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        f"COMPOSE_PROJECT_NAME={project}\n"
        f"ANIMAMA_INCLUDED_CONTENT_HOST_PATH={tmp_path / 'included'}\n"
        f"ANIMAMA_LOCAL_CONTENT_HOST_PATH={tmp_path / 'local'}\n"
        f"ANIMAMA_DATA_HOST_PATH={tmp_path / 'data'}\n"
    )
    env = _clean_environment(tmp_path)
    env["COMPOSE_ENV_FILES"] = "shared secrets.env,.env"
    env.pop("OPENAI_API_KEY", None)
    env.pop("POSTGRES_PASSWORD", None)
    command = """source "$1"
animama_state_configure ""
printf '%s\\n' "$ANIMAMA_STATE_PROJECT" "$ANIMAMA_STATE_INCLUDED_ROOT" "$ANIMAMA_STATE_LOCAL_ROOT"
printf '%s\\n' "$ANIMAMA_STATE_DATA_ROOT" "$COMPOSE_ENV_FILES" "${OPENAI_API_KEY-unset}" "${POSTGRES_PASSWORD-unset}"
"""
    result = subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", command, "bash", str(helper)],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, "State configuration should accept the explicit fake env files"
    assert result.stdout.splitlines() == [
        project,
        str(tmp_path / "included"),
        str(tmp_path / "local"),
        str(tmp_path / "data"),
        f"{shared},{dotenv}",
        "unset",
        "unset",
    ]


@pytest.mark.parametrize("recorded_checkout", [False, True])
def test_state_rejects_cross_project_record_before_using_its_roots(tmp_path: Path, recorded_checkout: bool) -> None:
    env = _clean_environment(tmp_path)
    env.update(
        COMPOSE_PROJECT_NAME="animama-old",
        COMPOSE_FILE="/fixture/old-compose.yml",
        ANIMAMA_LOCAL_CONTENT_HOST_PATH=str(tmp_path / "old-local"),
        ANIMAMA_DATA_HOST_PATH=str(tmp_path / "old-data"),
    )
    if recorded_checkout:
        env["ANIMAMA_STACK_REPO_ROOT"] = str(REPO_ROOT)
    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; animama_state_configure new',
            "bash",
            str(REPO_ROOT / "scripts/local-stack-state-common.sh"),
        ],
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 2
    assert "sourced stack belongs to another project" in result.stderr
    assert not (tmp_path / "old-local").exists()
    assert not (tmp_path / "old-data").exists()


def test_state_rejects_record_from_another_checkout(tmp_path: Path) -> None:
    env = _clean_environment(tmp_path)
    env["ANIMAMA_STACK_REPO_ROOT"] = str(tmp_path / "other-checkout")
    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; animama_state_configure ""',
            "bash",
            str(REPO_ROOT / "scripts/local-stack-state-common.sh"),
        ],
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 2
    assert "sourced stack belongs to another checkout" in result.stderr


def test_restore_keeps_installed_model_assets_and_replaces_everything_else(tmp_path: Path) -> None:
    """Model assets are not in backups, so a restore keeps the installed ones."""
    root = tmp_path / "data"
    (root / "internal/model-assets/parakeet-stt/v1").mkdir(parents=True)
    (root / "internal/model-assets/parakeet-stt/v1/model.onnx").write_text("installed")
    (root / "internal/gateway").mkdir(parents=True)
    (root / "internal/gateway/live").write_text("live")
    (root / "staging/model-assets/voice").mkdir(parents=True)
    (root / "staging/model-assets/voice/part").write_text("partial")
    (root / "live-only").write_text("live")
    backup = tmp_path / "backup"
    (backup / "internal/gateway").mkdir(parents=True)
    (backup / "internal/gateway/restored").write_text("restored")
    (backup / "restored-only").write_text("restored")
    archive = tmp_path / "data.tar.gz"
    subprocess.run(["tar", "-C", str(backup), "-czf", str(archive), "."], check=True)

    subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; animama_state_replace_data_root "$2"',
            "restore",
            str(REPO_ROOT / "scripts/local-stack-state-common.sh"),
            str(archive),
        ],
        env={**os.environ, "ANIMAMA_STATE_DATA_ROOT": str(root)},
        check=True,
    )

    files = sorted(str(path.relative_to(root)) for path in root.rglob("*") if path.is_file())
    assert files == [
        "internal/gateway/restored",
        "internal/model-assets/parakeet-stt/v1/model.onnx",
        "restored-only",
    ]
