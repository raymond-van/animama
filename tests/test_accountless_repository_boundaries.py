"""Repository guards for the accountless local composition."""

from __future__ import annotations

import re
from collections.abc import Iterable
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
# Locust needs an absolute target; React must continue to derive its own origin.
LOAD_TOOL_APPLICATION_DEFAULT = '_env("ANIMAMA_PUBLIC_ORIGIN", "http://localhost:8000")'
HOSTED_ADMISSION_ADAPTER = Path("src/frontend/web/src/app/hosted-runtime/hosted-composition.ts")
CALLER_PATTERNS = {
    "hard-coded local API origin": re.compile(r"https?://(?:localhost|127\.0\.0\.1):8000"),
    "browser API-origin configuration": re.compile(r"VITE_ANIMAMA_API|NEXT_PUBLIC_ANIMAMA_API|ANIMAMA_SERVER_BASE_URL"),
    "bearer credential": re.compile(r"\bBearer\s+", re.IGNORECASE),
}


def _source_files(root: Path, suffixes: tuple[str, ...]) -> Iterable[Path]:
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix not in suffixes:
            continue
        relative = path.relative_to(REPO_ROOT).as_posix()
        if any(part in relative for part in ("/node_modules/", "/dist/", "/__pycache__/")):
            continue
        if ".test." in path.name or path.name.startswith("test_"):
            continue
        if relative.startswith("src/frontend/packages/runtime-contracts/src/generated/"):
            continue
        yield path


def _matches(
    files: Iterable[Path],
    patterns: dict[str, re.Pattern[str]],
    *,
    application_origin_default: Path | None = None,
) -> list[str]:
    violations: list[str] = []
    for path in files:
        source = path.read_text(encoding="utf-8")
        if path == application_origin_default:
            # Exempt only the one canonical CLI target declaration, not other
            # absolute URLs, separate API configuration, or credential paths.
            source = source.replace(LOAD_TOOL_APPLICATION_DEFAULT, "", 1)
        for label, pattern in patterns.items():
            if pattern.search(source):
                violations.append(f"{path.relative_to(REPO_ROOT).as_posix()}: {label}")
    return violations


def test_active_local_code_has_no_credential_era_auth_or_security_mode_switch() -> None:
    """Prevent an account or deployment mode from returning to the local build."""

    files = [
        *_source_files(REPO_ROOT / "src/backend/animama", (".py",)),
        *_source_files(REPO_ROOT / "src/frontend/web/src", (".ts", ".tsx")),
        *_source_files(REPO_ROOT / "src/frontend/packages", (".ts", ".tsx")),
        *_source_files(REPO_ROOT / "tests/loadtest", (".py",)),
        REPO_ROOT / "docker-compose.yml",
        REPO_ROOT / "reset.sh",
        REPO_ROOT / "docker-compose.development.yml",
        REPO_ROOT / "src/frontend/web/package.json",
    ]
    patterns = {
        "local Better Auth": re.compile(r"better-auth|BetterAuth|BETTER_AUTH|/api/auth/"),
        "test-user authentication bypass": re.compile(r"X-Test-User|ANIMAMA_AUTH_BYPASS"),
        "retired authenticated-network mode": re.compile(r"authenticated_network|loopback_single_user"),
        "security-changing composition mode": re.compile(
            r"\b(?:ANIMAMA_MODE|DEPLOYMENT_MODE)\b|\bhosted\s*=\s*true\b",
            re.IGNORECASE,
        ),
    }
    assert _matches(files, patterns) == []


def test_browser_and_load_tools_have_no_separate_api_origin_or_bearer_path() -> None:
    """Browser-shaped callers must use the application origin without bearer state."""

    browser_files = [
        *_source_files(REPO_ROOT / "src/frontend/web/src", (".ts", ".tsx")),
        *_source_files(REPO_ROOT / "src/frontend/packages", (".ts", ".tsx")),
        *_source_files(REPO_ROOT / "tests/loadtest", (".py",)),
    ]
    assert (
        _matches(
            browser_files,
            CALLER_PATTERNS,
            application_origin_default=REPO_ROOT / "tests/loadtest/common.py",
        )
        == []
    )

    authorization_violations: list[str] = []
    authored_browser_files = [
        *_source_files(REPO_ROOT / "src/frontend/web/src", (".ts", ".tsx")),
        *_source_files(REPO_ROOT / "src/frontend/packages", (".ts", ".tsx")),
    ]
    for path in authored_browser_files:
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            # The hosted consumer returns one validated identity-navigation URL.
            # This named wire field is not an Authorization header or stored credential;
            # all other authorization text, including headers in this adapter, stays guarded.
            if path.relative_to(REPO_ROOT) == HOSTED_ADMISSION_ADAPTER:
                line = re.sub(r"\bauthorization_url\b", "", line)
            if "authorization" not in line.lower():
                continue
            if re.search(r"\.delete\(\s*[\"']authorization[\"']\s*\)", line, re.IGNORECASE):
                continue
            authorization_violations.append(f"{path.relative_to(REPO_ROOT).as_posix()}:{line_number}")
    assert authorization_violations == []


@pytest.mark.parametrize(
    "extra_source, expected_label",
    [
        ('client.get("http://localhost:8000/v1/chats")', "hard-coded local API origin"),
        ('API = "http://127.0.0.1:8000"', "hard-coded local API origin"),
        ('API = os.getenv("ANIMAMA_SERVER_BASE_URL")', "browser API-origin configuration"),
        ('headers = {"Authorization": "Bearer token"}', "bearer credential"),
    ],
)
def test_load_tool_application_default_does_not_exempt_separate_api_or_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, extra_source: str, expected_label: str
) -> None:
    monkeypatch.setattr(f"{__name__}.REPO_ROOT", tmp_path)
    load_tool = tmp_path / "common.py"
    load_tool.write_text(LOAD_TOOL_APPLICATION_DEFAULT, encoding="utf-8")
    assert _matches([load_tool], CALLER_PATTERNS, application_origin_default=load_tool) == []
    # The identical default is forbidden in browser code, which has no exemption.
    assert _matches([load_tool], CALLER_PATTERNS) == ["common.py: hard-coded local API origin"]
    load_tool.write_text(f"{LOAD_TOOL_APPLICATION_DEFAULT}\n{extra_source}", encoding="utf-8")
    assert _matches([load_tool], CALLER_PATTERNS, application_origin_default=load_tool) == [
        f"common.py: {expected_label}"
    ]


def test_python_route_tests_do_not_restore_header_authentication_fixtures() -> None:
    """Route-unit ownership uses dependency overrides, never magic headers."""

    # These boundary tests deliberately send forged credentials to prove that
    # the resolver ignores them and the collector never receives them. They do
    # not grant route-unit ownership through headers or introduce an auth mode.
    # Model-store tests send a synthetic upstream credential only to verify
    # that cross-host download redirects strip it, and key-redirect tests that
    # provider clients drop or refuse it on a cross-origin redirect;
    # model-connection credential tests, OpenRouter connection tests and
    # live-credential tests assert which synthetic upstream key each request
    # sends; ChatGPT plan tests assert which synthetic access token each
    # request to OpenAI carries and that error text quoting it is redacted.
    # None of them calls local routes with it.
    credential_rejection_tests = {
        "test_chatgpt_plan_background.py",
        "test_chatgpt_plan_client.py",
        "test_chatgpt_plan_models.py",
        "test_key_redirects.py",
        "test_live_credentials.py",
        "test_local_http_lifecycle.py",
        "test_local_http_telemetry.py",
        "test_model_connection_credentials.py",
        "test_model_store.py",
        "test_openrouter_connection.py",
    }
    files = [
        path
        for path in (REPO_ROOT / "tests").glob("test_*.py")
        if path.name not in {Path(__file__).name, *credential_rejection_tests}
    ]
    assert (
        _matches(
            files,
            {
                "test-user authentication header": re.compile(r"X-Test-User|ANIMAMA_AUTH_BYPASS"),
                "browser bearer fixture": re.compile(r"[\"']Authorization[\"']\s*:|\bBearer\s+"),
            },
        )
        == []
    )


def test_shared_backend_layers_do_not_import_local_server_composition() -> None:
    """Shared domain and application code receive adapters instead of local globals."""

    files = [
        *_source_files(REPO_ROOT / "src/backend/animama/app", (".py",)),
        *_source_files(REPO_ROOT / "src/backend/animama/domain", (".py",)),
    ]
    assert (
        _matches(
            files,
            {"local server import": re.compile(r"^(?:from|import)\s+animama\.server\b", re.MULTILINE)},
        )
        == []
    )

    shared_services = _source_files(REPO_ROOT / "src/backend/animama/app/services", (".py",))
    assert (
        _matches(
            shared_services,
            {
                "installation singleton dependency": re.compile(
                    r"installation_settings|ORMInstallationSettings|InstallationPrincipalService"
                )
            },
        )
        == []
    )
