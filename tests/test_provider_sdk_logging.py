from __future__ import annotations

import logging

import pytest

from animama import logging_config


@pytest.mark.parametrize("sdk", ["anthropic", "openai"])
def test_provider_sdks_never_log_request_bodies_even_in_debug(monkeypatch: pytest.MonkeyPatch, sdk: str) -> None:
    # At DEBUG the SDKs log each request body, which can hold a chat's images.
    monkeypatch.setattr(logging_config, "_DEBUG_ENABLED", True)

    config = logging_config._build_logging_config()

    assert config["loggers"][sdk]["level"] == "INFO"
    assert logging.getLevelName(config["loggers"]["anima"]["level"]) == "DEBUG"
