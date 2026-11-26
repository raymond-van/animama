"""The installation's ChatGPT plan session: sign-in, token renewal, the background rule and sign-out.

One service instance per installation owns the session. It keeps the record
in memory after the first read and writes every change through the store
before anything uses it, so a refreshed token set is on disk before its access
token leaves this module (T5). One asyncio lock serializes sign-in completion,
refreshes, preference changes and sign-out; reading a still-fresh token takes
no lock.

Sign-in is OAuth with PKCE in the system browser. ``begin`` holds one pending
attempt for ten minutes; ``complete`` accepts only a return whose ``state``
matches it, compared in constant time and consumed once, and a wrong ``state``
leaves the attempt pending (T2). A new account replaces the stored one only
after its ID token validates (R1.6).

Every token request names its purpose. A ``background`` request (work the
backend starts by itself) needs the person's agreement and is refused while a
usage limit pauses the plan; an ``interactive`` request that succeeds clears
the pause (T7, R4, R5.1). The pause lives in memory: a restart is a new try.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import secrets
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime

from animama.app.ports.chatgpt_plan_port import (
    REGISTRATION_ERRORS,
    AuthorizeRequest,
    ChatGPTPlanIdentityError,
    ChatGPTPlanIdentityPort,
    ChatGPTPlanSessionStorePort,
    TokenGrant,
)
from animama.domain.chatgpt_plan import (
    ChatGPTPlanAccount,
    ChatGPTPlanPurpose,
    ChatGPTPlanRecord,
    ChatGPTPlanSignInError,
    ChatGPTPlanSignOutResult,
    ChatGPTPlanState,
    ChatGPTPlanStatus,
    ChatGPTPlanTokens,
    ChatGPTPlanUnavailableError,
)

logger = logging.getLogger(__name__)

ATTEMPT_LIFETIME_SECONDS = 600.0
REFRESH_MARGIN_SECONDS = 300.0
REFRESH_RETRY_SECONDS = 30.0
"""After a temporary refresh failure, no other refresh is tried for this long, however many requests wait."""


@dataclass(frozen=True, slots=True)
class _Attempt:
    """One pending sign-in. The verifier and nonce never leave the backend."""

    client_id: str | None = field(repr=False)
    redirect_uri: str
    state: str = field(repr=False)
    nonce: str = field(repr=False)
    verifier: str = field(repr=False)
    created_at: float


def _challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _same(left: object, right: str) -> bool:
    return isinstance(left, str) and hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


class ChatGPTPlanSessionService:
    """Own the session record and every request to OpenAI's sign-in service."""

    def __init__(
        self,
        *,
        identity: ChatGPTPlanIdentityPort,
        store: ChatGPTPlanSessionStorePort,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._identity = identity
        self._store = store
        self._clock = clock
        self._lock = asyncio.Lock()
        self._record: ChatGPTPlanRecord | None = None
        self._persisted = False
        self._attempt: _Attempt | None = None
        self._failure: str | None = None
        self._paused = False
        self._refresh_retry_at = 0.0
        # A completed sign-in whose follow-up (storing the account's models) is still running.
        self._finishing = 0

    # --- reading ------------------------------------------------------------

    async def status(self) -> ChatGPTPlanStatus:
        record = await self._load()
        account = record.account
        state: ChatGPTPlanState = "signed_out"
        if account is not None:
            state = "signed_in" if account.tokens is not None else "sign_in_required"
        granted = bool(account and account.plan_use_granted)
        return ChatGPTPlanStatus(
            state=state,
            email=account.email if account else None,
            plan_use_granted=granted,
            sign_in_pending=self._pending_attempt() is not None or self._finishing > 0,
            confirmation_due=state == "signed_in" and granted and account is not None and account.confirmed_at is None,
            background_agreed=bool(account and account.background_agreed),
            paused=self._paused,
            failure=self._failure,
        )

    async def access_token(self, purpose: ChatGPTPlanPurpose) -> str:
        """Return an access token for a request of this purpose, renewing it first when it is due."""

        tokens = self._usable_tokens(await self._load(), purpose)
        if not self._refresh_due(tokens):
            return tokens.access_token
        async with self._lock:
            record = await self._load()
            tokens = self._usable_tokens(record, purpose)
            if not self._refresh_due(tokens):
                return tokens.access_token
            try:
                return await self._refresh(record)
            except ChatGPTPlanUnavailableError as error:
                now = self._clock()
                if error.code == "temporarily_unavailable" and now < tokens.expires_at and now < self._refresh_retry_at:
                    # OpenAI could not be reached and the token is still valid: use it, and renew after the backoff.
                    # A failed save is not that case, so a set OpenAI rejected or rotated is never handed out.
                    return tokens.access_token
                raise

    async def refresh_rejected(self, stale_access_token: str, purpose: ChatGPTPlanPurpose) -> str:
        """Renew after OpenAI refused ``stale_access_token``, once however many callers saw the refusal."""

        async with self._lock:
            record = await self._load()
            tokens = self._usable_tokens(record, purpose)
            if not _same(stale_access_token, tokens.access_token):
                return tokens.access_token
            return await self._refresh(record)

    # --- signing in ---------------------------------------------------------

    async def begin(self, *, redirect_uri: str, enable_plan_use: bool = False) -> str:
        """Start an attempt, replacing any pending one, and return the URL the browser opens.

        ``enable_plan_use`` asks OpenAI to show the consent screen again, for a
        person who declined plan use the first time. The URL carries the
        attempt's state, so it is returned once and never logged.
        """

        async with self._lock:
            record = await self._load()
            if not self._persisted:
                # The host id must be the same on the return and at every later sign-in.
                await self._save(record)
            attempt = _Attempt(
                client_id=record.client_id,
                redirect_uri=redirect_uri,
                state=secrets.token_urlsafe(32),
                nonce=secrets.token_urlsafe(32),
                verifier=secrets.token_urlsafe(64),
                created_at=self._clock(),
            )
            self._attempt = attempt
            self._failure = None
            account = record.account
            return self._identity.authorize_url(
                AuthorizeRequest(
                    client_id=record.client_id,
                    host_id=record.host_id,
                    redirect_uri=redirect_uri,
                    state=attempt.state,
                    nonce=attempt.nonce,
                    code_challenge=_challenge(attempt.verifier),
                    login_hint=account.email if account else None,
                    prompt_consent=enable_plan_use,
                )
            )

    async def cancel(self) -> None:
        self._attempt = None

    async def complete(
        self, params: Mapping[str, str], *, after_sign_in: Callable[[], Awaitable[None]] | None = None
    ) -> ChatGPTPlanStatus:
        """Finish the pending attempt from the sign-in return's query parameters.

        ``after_sign_in`` runs once the account is saved and before the sign-in
        stops reading as pending, outside the session's lock so it can use the
        new tokens: the return stores the account's models there, so a page
        that sees the sign-in finish also finds the models.
        """

        async with self._lock:
            attempt = self._attempt
            if attempt is None:
                raise ChatGPTPlanSignInError("no_pending_sign_in")
            if self._expired(attempt):
                self._attempt = None
                raise ChatGPTPlanSignInError("sign_in_expired")
            if not _same(params.get("state"), attempt.state):
                # Neither completes nor cancels: the person's own return may still arrive.
                raise ChatGPTPlanSignInError("state_mismatch")
            try:
                await self._complete(attempt, params)
            except ChatGPTPlanSignInError as error:
                self._failure = error.code
                raise
            finally:
                # Consumed once, whatever happened. Until then status still reads as pending;
                # the lock keeps a replayed return waiting until this one is done.
                self._attempt = None
            self._finishing += 1
        try:
            if after_sign_in is not None:
                await after_sign_in()
        finally:
            self._finishing -= 1
        return await self.status()

    async def _complete(self, attempt: _Attempt, params: Mapping[str, str]) -> None:
        returned_error = params.get("error")
        if returned_error is not None:
            raise ChatGPTPlanSignInError("access_denied" if returned_error == "access_denied" else "sign_in_refused")
        code = params.get("code")
        if not code:
            raise ChatGPTPlanSignInError("sign_in_refused")
        returned_issuer = params.get("iss")
        if returned_issuer is not None and returned_issuer != self._identity.issuer:
            # A return from another authorization server must not spend this attempt's verifier there.
            raise ChatGPTPlanSignInError("sign_in_refused", "the return names another issuer")
        returned_client = params.get("client_id") or None
        if attempt.client_id is None:
            if returned_client is None:
                raise ChatGPTPlanSignInError("sign_in_refused", "the return carried no issued client id")
            client_id = returned_client
        else:
            if returned_client is not None and returned_client != attempt.client_id:
                raise ChatGPTPlanSignInError("client_mismatch")
            client_id = attempt.client_id

        try:
            grant = await self._identity.exchange_code(
                client_id=client_id, code=code, verifier=attempt.verifier, redirect_uri=attempt.redirect_uri
            )
        except ChatGPTPlanIdentityError as error:
            raise ChatGPTPlanSignInError("sign_in_refused" if error.rejected else "temporarily_unavailable") from error
        try:
            if grant.id_token is None:
                raise ChatGPTPlanIdentityError("id_token_missing", rejected=True)
            claims = await self._identity.validate_id_token(grant.id_token, client_id=client_id, nonce=attempt.nonce)
        except ChatGPTPlanIdentityError as error:
            # The code is spent and a session is open at OpenAI: end it rather than keep unverified tokens.
            await self._identity.revoke(client_id=client_id, refresh_token=grant.refresh_token)
            raise ChatGPTPlanSignInError("id_token_invalid" if error.rejected else "temporarily_unavailable") from error

        record = await self._load()
        previous = record.account
        same_account = previous is not None and previous.subject == claims.subject
        account = ChatGPTPlanAccount(
            subject=claims.subject,
            email=claims.email,
            scopes=grant.scopes or (),
            tokens=self._tokens(grant, id_token=grant.id_token),
            # The confirmation and the background choice belong to the account that made them (D7).
            confirmed_at=previous.confirmed_at if same_account and previous else None,
            background_agreed=bool(same_account and previous and previous.background_agreed),
        )
        try:
            await self._save(replace(record, client_id=client_id, account=account))
        except ChatGPTPlanUnavailableError as error:
            await self._identity.revoke(client_id=client_id, refresh_token=grant.refresh_token)
            raise ChatGPTPlanSignInError("temporarily_unavailable") from error
        self._paused = False
        self._refresh_retry_at = 0.0
        if not same_account and previous is not None and previous.tokens is not None and record.client_id is not None:
            # Another account's session would otherwise stay valid at OpenAI until it expired. The same
            # account's is left to expire: revoking it might also end the grant that just replaced it.
            await self._identity.revoke(client_id=record.client_id, refresh_token=previous.tokens.refresh_token)

    # --- choices and limits -------------------------------------------------

    async def set_preferences(
        self, *, confirmed: bool = False, background_agreed: bool | None = None
    ) -> ChatGPTPlanStatus:
        """Record the one-time confirmation and the background choice for the signed-in account."""

        async with self._lock:
            record = await self._load()
            account = record.account
            if account is None:
                raise ChatGPTPlanUnavailableError("not_signed_in")
            if confirmed and account.confirmed_at is None:
                account = replace(account, confirmed_at=datetime.fromtimestamp(self._clock(), UTC))
            if background_agreed is not None:
                account = replace(account, background_agreed=background_agreed)
            await self._save(replace(record, account=account))
        return await self.status()

    async def record_usage_limit(self) -> None:
        """A plan request hit a usage limit: pause background use until an interactive request succeeds."""

        self._paused = True

    async def record_interactive_success(self) -> None:
        self._paused = False

    # --- signing out --------------------------------------------------------

    async def sign_out(self) -> ChatGPTPlanSignOutResult:
        """End the session at OpenAI and remove the account. The registration and host id stay."""

        async with self._lock:
            self._attempt = None
            self._paused = False
            self._failure = None
            record = await self._load()
            account = record.account
            if account is None:
                return ChatGPTPlanSignOutResult(was_signed_in=False, confirmed=True)
            confirmed = True
            if account.tokens is not None:
                confirmed = record.client_id is not None and await self._identity.revoke(
                    client_id=record.client_id, refresh_token=account.tokens.refresh_token
                )
            await self._save(replace(record, account=None))
            return ChatGPTPlanSignOutResult(was_signed_in=True, confirmed=confirmed)

    # --- internals ----------------------------------------------------------

    async def _load(self) -> ChatGPTPlanRecord:
        if self._record is None:
            try:
                loaded = await asyncio.to_thread(self._store.load)
            except OSError as error:
                # Nothing is cached, so the next call reads the file again.
                raise ChatGPTPlanUnavailableError("temporarily_unavailable") from error
            # Another caller may have read and changed the record while this read waited.
            if self._record is None:
                self._persisted = loaded is not None
                self._record = loaded or ChatGPTPlanRecord(host_id=f"urn:uuid:{uuid.uuid4()}")
        return self._record

    async def _save(self, record: ChatGPTPlanRecord) -> None:
        """Write first; the in-memory record changes only once the file holds the new one."""

        try:
            await asyncio.to_thread(self._store.save, record)
        except OSError as error:
            raise ChatGPTPlanUnavailableError("temporarily_unavailable") from error
        self._record = record
        self._persisted = True

    def _pending_attempt(self) -> _Attempt | None:
        attempt = self._attempt
        return attempt if attempt is not None and not self._expired(attempt) else None

    def _expired(self, attempt: _Attempt) -> bool:
        return self._clock() - attempt.created_at > ATTEMPT_LIFETIME_SECONDS

    def _usable_tokens(self, record: ChatGPTPlanRecord, purpose: ChatGPTPlanPurpose) -> ChatGPTPlanTokens:
        account = record.account
        if account is None:
            raise ChatGPTPlanUnavailableError("not_signed_in")
        if account.tokens is None:
            raise ChatGPTPlanUnavailableError("sign_in_required")
        if not account.plan_use_granted:
            raise ChatGPTPlanUnavailableError("plan_use_not_granted")
        if purpose != "interactive":
            # Anything but the person's own request follows the background rule.
            if not account.background_agreed:
                raise ChatGPTPlanUnavailableError("background_not_agreed")
            if self._paused:
                raise ChatGPTPlanUnavailableError("paused")
        return account.tokens

    def _refresh_due(self, tokens: ChatGPTPlanTokens) -> bool:
        now = self._clock()
        if now >= tokens.expires_at:
            return True
        if now < tokens.expires_at - REFRESH_MARGIN_SECONDS:
            return False
        # Inside the margin a scheduled refresh still waits for OpenAI's earliest time.
        return tokens.earliest_refresh_at is None or now >= tokens.earliest_refresh_at

    def _tokens(self, grant: TokenGrant, *, id_token: str) -> ChatGPTPlanTokens:
        return ChatGPTPlanTokens(
            access_token=grant.access_token,
            refresh_token=grant.refresh_token,
            id_token=id_token,
            expires_at=self._clock() + grant.expires_in,
            earliest_refresh_at=grant.earliest_refresh_at,
        )

    async def _refresh(self, record: ChatGPTPlanRecord) -> str:
        """Renew under the lock and save the rotated set before returning its access token."""

        account = record.account
        if account is None or account.tokens is None or record.client_id is None:
            raise ChatGPTPlanUnavailableError("sign_in_required")
        if self._clock() < self._refresh_retry_at:
            raise ChatGPTPlanUnavailableError("temporarily_unavailable")
        try:
            grant = await self._identity.refresh(client_id=record.client_id, refresh_token=account.tokens.refresh_token)
        except ChatGPTPlanIdentityError as error:
            if not error.rejected:
                self._refresh_retry_at = self._clock() + REFRESH_RETRY_SECONDS
                raise ChatGPTPlanUnavailableError("temporarily_unavailable") from error
            logger.warning("OpenAI rejected the ChatGPT plan refresh (%s); sign-in is required", error.code)
            cleared = replace(record, account=replace(account, tokens=None))
            if error.code in REGISTRATION_ERRORS:
                cleared = replace(cleared, client_id=None)
            await self._save(cleared)
            raise ChatGPTPlanUnavailableError("sign_in_required") from error
        id_token = account.tokens.id_token
        if grant.id_token is not None:
            try:
                claims = await self._identity.validate_id_token(grant.id_token, client_id=record.client_id, nonce=None)
                if claims.subject == account.subject:
                    id_token = grant.id_token
            except ChatGPTPlanIdentityError:
                # The tokens are already rotated at OpenAI, so they are kept; only the ID token is not.
                logger.warning("A refreshed ChatGPT plan ID token did not validate; keeping the previous one")
        tokens = self._tokens(grant, id_token=id_token)
        scopes = grant.scopes if grant.scopes is not None else account.scopes
        # Written before use: if this save fails, the caller gets an error, never this token (T5).
        await self._save(replace(record, account=replace(account, scopes=scopes, tokens=tokens)))
        self._refresh_retry_at = 0.0
        return tokens.access_token
