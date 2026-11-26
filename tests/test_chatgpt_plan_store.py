"""The ChatGPT plan session file: owner-only, atomic, encrypted under a key when one is given (T6)."""

from __future__ import annotations

import errno
import os
import stat
from datetime import UTC, datetime
from pathlib import Path

import pytest

from animama.adapters.chatgpt_plan import session_store as store_module
from animama.adapters.chatgpt_plan.session_store import FileChatGPTPlanSessionStore
from animama.domain.chatgpt_plan import ChatGPTPlanAccount, ChatGPTPlanRecord, ChatGPTPlanTokens

KEY = bytes(range(32))
SECRETS = ("access-sentinel", "refresh-sentinel", "id-sentinel", "person@example.test", "subject-sentinel")


def _record() -> ChatGPTPlanRecord:
    tokens = ChatGPTPlanTokens(
        access_token="access-sentinel",
        refresh_token="refresh-sentinel",
        id_token="id-sentinel",
        expires_at=1_800_003_600.0,
        earliest_refresh_at=1_800_003_240.0,
    )
    account = ChatGPTPlanAccount(
        subject="subject-sentinel",
        email="person@example.test",
        scopes=("chatgpt.tokens.use.direct", "openid"),
        tokens=tokens,
        confirmed_at=datetime(2026, 11, 24, 12, 0, tzinfo=UTC),
        background_agreed=True,
    )
    return ChatGPTPlanRecord(
        host_id="urn:uuid:00000000-0000-4000-8000-000000000000", client_id="app_1", account=account
    )


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission bits")
def test_a_self_hosted_record_is_an_owner_only_file_in_an_owner_only_directory(tmp_path: Path) -> None:
    directory = tmp_path / "internal" / "chatgpt-plan"
    store = FileChatGPTPlanSessionStore(directory, key=None)

    store.save(_record())

    assert sorted(item.name for item in directory.iterdir()) == ["session.json"]
    assert _mode(directory) == 0o700 and _mode(directory / "session.json") == 0o600
    assert store.load() == _record()
    assert FileChatGPTPlanSessionStore(directory, key=None).load() == _record()


def test_with_a_key_the_file_is_ciphertext_that_only_that_key_opens(tmp_path: Path) -> None:
    directory = tmp_path / "chatgpt-plan"
    FileChatGPTPlanSessionStore(directory, key=KEY).save(_record())

    stored = (directory / "session.bin").read_bytes()
    assert not (directory / "session.json").exists()
    assert all(secret.encode() not in stored for secret in SECRETS)
    assert FileChatGPTPlanSessionStore(directory, key=KEY).load() == _record()


def test_a_wrong_key_or_tampered_bytes_mean_signed_out_and_the_file_is_removed(tmp_path: Path) -> None:
    directory = tmp_path / "chatgpt-plan"
    FileChatGPTPlanSessionStore(directory, key=KEY).save(_record())

    assert FileChatGPTPlanSessionStore(directory, key=bytes(32)).load() is None
    assert not (directory / "session.bin").exists()

    FileChatGPTPlanSessionStore(directory, key=KEY).save(_record())
    stored = bytearray((directory / "session.bin").read_bytes())
    stored[-1] ^= 0x01
    (directory / "session.bin").write_bytes(bytes(stored))
    assert FileChatGPTPlanSessionStore(directory, key=KEY).load() is None
    assert not (directory / "session.bin").exists()


def test_with_a_key_a_plain_file_is_never_read(tmp_path: Path) -> None:
    directory = tmp_path / "chatgpt-plan"
    FileChatGPTPlanSessionStore(directory, key=None).save(_record())

    assert FileChatGPTPlanSessionStore(directory, key=KEY).load() is None


@pytest.mark.parametrize(
    "content",
    [b"not json", b"[]", b'{"schema_version": 99, "host_id": "urn:uuid:x"}', b'{"schema_version": 1}'],
)
def test_a_malformed_record_means_signed_out_and_is_removed(tmp_path: Path, content: bytes) -> None:
    directory = tmp_path / "chatgpt-plan"
    directory.mkdir(mode=0o700)
    (directory / "session.json").write_bytes(content)

    assert FileChatGPTPlanSessionStore(directory, key=None).load() is None
    assert not (directory / "session.json").exists()


def test_a_missing_record_is_signed_out_and_creates_nothing(tmp_path: Path) -> None:
    directory = tmp_path / "chatgpt-plan"

    assert FileChatGPTPlanSessionStore(directory, key=None).load() is None
    assert not directory.exists()


@pytest.mark.skipif(os.name != "posix", reason="symbolic links")
def test_links_are_never_followed(tmp_path: Path) -> None:
    elsewhere = tmp_path / "elsewhere.json"
    directory = tmp_path / "chatgpt-plan"
    store = FileChatGPTPlanSessionStore(directory, key=None)
    store.save(_record())
    (directory / "session.json").unlink()
    elsewhere.write_text("{}")
    (directory / "session.json").symlink_to(elsewhere)

    assert store.load() is None
    assert elsewhere.read_text() == "{}"
    store.save(_record())
    assert elsewhere.read_text() == "{}" and not (directory / "session.json").is_symlink()

    linked = tmp_path / "linked"
    linked.symlink_to(tmp_path / "target", target_is_directory=True)
    (tmp_path / "target").mkdir()
    with pytest.raises(OSError):
        FileChatGPTPlanSessionStore(linked, key=None).save(_record())
    assert list((tmp_path / "target").iterdir()) == []


def test_an_interrupted_write_leaves_the_previous_record(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    directory = tmp_path / "chatgpt-plan"
    store = FileChatGPTPlanSessionStore(directory, key=KEY)
    store.save(_record())
    before = (directory / "session.bin").read_bytes()

    def fail(source: Path, destination: Path) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(store_module, "replace", fail)
    with pytest.raises(OSError):
        store.save(ChatGPTPlanRecord(host_id="urn:uuid:other"))

    assert (directory / "session.bin").read_bytes() == before
    assert sorted(item.name for item in directory.iterdir()) == ["session.bin"]


def test_a_signed_out_record_keeps_the_registration(tmp_path: Path) -> None:
    store = FileChatGPTPlanSessionStore(tmp_path / "chatgpt-plan", key=None)
    signed_out = ChatGPTPlanRecord(host_id="urn:uuid:00000000-0000-4000-8000-000000000000", client_id="app_1")

    store.save(signed_out)

    assert store.load() == signed_out


def test_a_key_must_be_32_bytes() -> None:
    with pytest.raises(ValueError, match="32 bytes"):
        FileChatGPTPlanSessionStore(Path("unused"), key=b"short")


def test_no_secret_appears_in_a_repr() -> None:
    printed = repr(_record()) + repr(FileChatGPTPlanSessionStore(Path("unused"), key=KEY))
    assert all(secret not in printed for secret in (*SECRETS, "app_1", KEY.hex()))


def test_a_temporary_read_failure_keeps_the_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    directory = tmp_path / "chatgpt-plan"
    store = FileChatGPTPlanSessionStore(directory, key=None)
    store.save(_record())

    for failure in (errno.EMFILE, errno.EACCES, errno.EIO):

        def fail(path: object, flags: int, mode: int = 0o777, code: int = failure) -> int:
            raise OSError(code, os.strerror(code))

        monkeypatch.setattr(store_module, "open_no_follow", fail)
        with pytest.raises(OSError):
            store.load()
        monkeypatch.undo()
        assert store.load() == _record()


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission bits")
def test_an_existing_directory_is_made_owner_only(tmp_path: Path) -> None:
    directory = tmp_path / "chatgpt-plan"
    directory.mkdir(mode=0o755)
    os.chmod(directory, 0o755)

    FileChatGPTPlanSessionStore(directory, key=None).save(_record())

    assert _mode(directory) == 0o700


def test_a_write_left_by_a_crash_is_swept(tmp_path: Path) -> None:
    directory = tmp_path / "chatgpt-plan"
    directory.mkdir(mode=0o700)
    leftover = directory / ".session.json.0123abcd.tmp"
    leftover.write_text('{"tokens": "refresh-sentinel"}')
    store = FileChatGPTPlanSessionStore(directory, key=None)

    # A read leaves it: a save running at the same time may own it. The next save sweeps it.
    assert store.load() is None
    assert leftover.exists()
    store.save(_record())
    assert sorted(item.name for item in directory.iterdir()) == ["session.json"]
