"""The page the system browser shows after OpenAI sends it back to the installation.

It is static: one of four fixed messages in the person's language, chosen from
the outcome alone. Nothing from the request (the code, the state or an error
text) is ever placed in it, and it loads nothing, so its URL cannot leak through
a referrer or a subresource. The app page shows the details; this tab only says
whether to go back.
"""

from __future__ import annotations

from html import escape
from typing import Literal

from fastapi.responses import HTMLResponse

from animama.domain.settings import UiLocale

ReturnOutcome = Literal["signed_in", "declined", "expired", "failed"]

_TEXT: dict[UiLocale, dict[str, str]] = {
    "en": {
        "title": "Animama",
        "signed_in": "You're signed in with ChatGPT. You can close this tab and return to Animama.",
        "declined": "Sign-in was cancelled. You can close this tab; Animama explains what to do next.",
        "expired": "This sign-in has expired. Return to Animama and choose Continue with ChatGPT again.",
        "failed": "Sign-in didn't complete. Return to Animama to see why and try again.",
    },
    "ja": {
        "title": "Animama",
        "signed_in": "ChatGPT でサインインしました。このタブを閉じて Animama に戻ってください。",
        "declined": "サインインはキャンセルされました。このタブを閉じてください。次の手順は Animama に表示されます。",
        "expired": (
            "このサインインは有効期限が切れました。Animama に戻り、もう一度「ChatGPT で続ける」を選んでください。"
        ),
        "failed": "サインインを完了できませんでした。Animama に戻って理由を確認し、もう一度お試しください。",
    },
    "ko": {
        "title": "Animama",
        "signed_in": "ChatGPT로 로그인했습니다. 이 탭을 닫고 Animama로 돌아가세요.",
        "declined": "로그인이 취소되었습니다. 이 탭을 닫으세요. 다음 단계는 Animama에서 안내합니다.",
        "expired": "이 로그인은 만료되었습니다. Animama로 돌아가 'ChatGPT로 계속하기'를 다시 선택하세요.",
        "failed": "로그인을 완료하지 못했습니다. Animama로 돌아가 이유를 확인하고 다시 시도하세요.",
    },
    "zh-Hans": {
        "title": "Animama",
        "signed_in": "你已使用 ChatGPT 登录。可以关闭此标签页并返回 Animama。",
        "declined": "登录已取消。可以关闭此标签页，Animama 会说明接下来怎么做。",
        "expired": "此次登录已过期。请返回 Animama，再次选择“使用 ChatGPT 继续”。",
        "failed": "登录未完成。请返回 Animama 查看原因并重试。",
    },
    "zh-Hant": {
        "title": "Animama",
        "signed_in": "你已使用 ChatGPT 登入。可以關閉此分頁並返回 Animama。",
        "declined": "登入已取消。可以關閉此分頁，Animama 會說明接下來怎麼做。",
        "expired": "此次登入已過期。請返回 Animama，再次選擇「使用 ChatGPT 繼續」。",
        "failed": "登入未完成。請返回 Animama 查看原因並重試。",
    },
}

_HTML_LANG: dict[UiLocale, str] = {"en": "en", "ja": "ja", "ko": "ko", "zh-Hans": "zh-Hans", "zh-Hant": "zh-Hant"}

# The page loads nothing and runs nothing; inline style is its only resource.
_HEADERS = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
}


def return_page(outcome: ReturnOutcome, locale: UiLocale | None) -> HTMLResponse:
    """Render the fixed page for ``outcome``; an unknown language falls back to English."""

    language: UiLocale = locale if locale in _TEXT else "en"
    text = _TEXT[language]
    body = (
        "<!doctype html>"
        f'<html lang="{_HTML_LANG[language]}"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{escape(text['title'])}</title>"
        "<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;"
        "min-height:100vh;background:#f6f6f7;color:#1d1d1f}main{max-width:28rem;padding:2rem}"
        "@media (prefers-color-scheme:dark){body{background:#151516;color:#f5f5f7}}</style>"
        f"</head><body><main><h1>{escape(text['title'])}</h1><p>{escape(text[outcome])}</p></main></body></html>"
    )
    return HTMLResponse(body, status_code=200 if outcome == "signed_in" else 400, headers=_HEADERS)
