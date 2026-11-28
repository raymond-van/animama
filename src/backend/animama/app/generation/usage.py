"""Token use and estimated cost of the assistant's runs (spec #942 R6.3).

A run adds up what its model responses reported and stores the total with its
assistant turn, beside the model row it ran on. A response whose provider
reported no usage still counts, with the figures its adapter gave it (a rough
count on a server that streams no usage). Where the row had a price when the
run started and every response reported its usage, the turn also stores an
estimate of the run's cost. The
estimate itself is stored, not the price it came from, so a later price
change, a removed model or another model choice leaves a conversation's
history as it was.

A run on the ChatGPT plan never gets an estimate: the plan's allowance is not
billed by the token, and the page shows the plan's own notice instead.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Final

from animama.app.chat.api_standard import CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE
from animama.app.util.model_pricing import estimate_model_token_cost
from animama.domain import ModelProvider
from animama.domain.generation import GenerationMessage
from animama.domain.usage import Usage

_AMOUNT_STEP: Final = Decimal("0.000001")
"""An estimate is kept to a millionth of its currency unit: a run of a few thousand tokens still shows."""
_MAX_CURRENCY_LENGTH: Final = 8


@dataclass(frozen=True)
class RunUsage:
    """Tokens the run's model responses reported, added up; ``requests`` counts the responses."""

    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    requests: int = 0

    def plus(self, usage: Usage) -> RunUsage:
        return RunUsage(
            input_tokens=self.input_tokens + (usage.input_tokens or 0),
            cached_input_tokens=self.cached_input_tokens + (usage.input_tokens_details.cached_tokens or 0),
            output_tokens=self.output_tokens + (usage.output_tokens or 0),
            reasoning_tokens=self.reasoning_tokens + (usage.output_tokens_details.reasoning_tokens or 0),
            requests=self.requests + 1,
        )

    def added(self, other: RunUsage) -> RunUsage:
        return RunUsage(
            input_tokens=self.input_tokens + other.input_tokens,
            cached_input_tokens=self.cached_input_tokens + other.cached_input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
            reasoning_tokens=self.reasoning_tokens + other.reasoning_tokens,
            requests=self.requests + other.requests,
        )


@dataclass(frozen=True)
class CostEstimate:
    """An estimated cost in one currency, from the model row's listed prices. Not a bill."""

    currency: str
    amount: Decimal

    def stored(self) -> dict[str, str]:
        """The estimate as a turn keeps it: the amount as a decimal string, so no precision is lost in JSON."""

        return {"currency": self.currency, "amount": format(self.amount.quantize(_AMOUNT_STEP), "f")}


def runs_on_plan(model_provider: ModelProvider) -> bool:
    """Whether a model row spends the owner's ChatGPT plan instead of a key."""

    return model_provider.provider_type == CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE


class RunCostMeter:
    """Adds up the estimated cost of one run, a model response at a time.

    Each response is priced by ``estimate_model_token_cost`` against the
    model row as the run read it when it started. One response that cannot
    be priced leaves the whole run without an estimate, since a partial sum
    would read as the run's cost: the row lists no price, the response
    reports prompt-cache writes (which the catalog has no rate for), or the
    provider reported no usage for it, so its figures are the adapter's own
    rough count or nothing. A ChatGPT plan row is never priced.

    The same holds for a request that was started and never returned a final
    response (``unfinished``): the run was stopped or ran out of time while
    it was open, or it failed. What such a request used is not known, and
    the provider may bill it, so the run has no estimate. A request the
    provider refused outright before producing anything
    (``request_refused``: a stored response it no longer has) used nothing
    and is not counted.
    """

    def __init__(self, model_provider: ModelProvider) -> None:
        self._model_provider = model_provider
        self._amount = Decimal(0)
        self._currency: str | None = None
        self._priced = not runs_on_plan(model_provider)
        self._responses = 0
        self._started = 0

    def request_started(self) -> None:
        """Count one model request as it leaves; ``add`` counts its final response when one arrives."""

        self._started += 1

    def request_refused(self) -> None:
        """Take back a started request the provider refused before producing anything: it used no tokens."""

        self._started = max(0, self._started - 1)

    @property
    def unfinished(self) -> int:
        """Requests that were started and returned no final response."""

        return max(0, self._started - self._responses)

    def add(self, usage: Usage, *, reported: bool) -> None:
        """Count one response; ``reported`` is whether the provider itself reported ``usage``."""

        self._responses += 1
        if not self._priced:
            return
        if not reported:
            self._priced = False
            return
        cost = estimate_model_token_cost(model_provider=self._model_provider, usage=usage)
        if not cost.priced or cost.total_cost is None or not cost.currency:
            self._priced = False
            return
        self._currency = cost.currency
        self._amount += cost.total_cost

    def estimate(self) -> CostEstimate | None:
        """The run's estimate; ``None`` when a response could not be priced, none arrived, or a request the
        run started never returned one (the sum would then be an understated cost)."""

        if not self._priced or self._responses == 0 or self._currency is None or self.unfinished:
            return None
        return CostEstimate(currency=self._currency, amount=self._amount)


def run_model(model_provider: ModelProvider, reasoning_effort: str | None) -> dict[str, Any]:
    """What a run's turn records of the model it ran on: ids and the chosen effort, never a credential."""

    recorded: dict[str, Any] = {
        "model_provider_id": model_provider.id,
        "model": model_provider.model,
        "provider_type": model_provider.provider_type,
    }
    if reasoning_effort is not None:
        recorded["reasoning_effort"] = reasoning_effort
    return recorded


# --- Reading stored turns -----------------------------------------------------------------


@dataclass(frozen=True)
class StoredRunUsage:
    """One stored run's token use, as its assistant turn recorded it."""

    run_id: str | None
    model_provider_id: str | None
    plan: bool
    usage: RunUsage
    cost: CostEstimate | None
    unfinished_requests: int = 0
    """Model requests of the run that returned no final response; ``usage`` counts completed responses only."""

    @property
    def asked_a_model(self) -> bool:
        """Whether the run made any model request, answered or not."""

        return self.usage.requests > 0 or self.unfinished_requests > 0


@dataclass(frozen=True)
class ConversationUsage:
    """A conversation's token use over its stored runs.

    ``cost`` adds the runs that have an estimate, when they share one
    currency. ``cost_complete`` is false when a run that made a model request
    has none (a ChatGPT plan run, a model without a listed price, a run with
    a request that never returned a final response, or a run from before
    estimates were stored), so the page can say the figure covers only part
    of the conversation. ``usage`` adds up completed responses only.
    """

    usage: RunUsage
    runs: int
    cost: CostEstimate | None
    cost_complete: bool
    last_run: StoredRunUsage | None


def _count(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _stored_usage(value: object) -> RunUsage | None:
    if not isinstance(value, Mapping):
        return None
    return RunUsage(
        input_tokens=_count(value.get("input_tokens")),
        cached_input_tokens=_count(value.get("cached_input_tokens")),
        output_tokens=_count(value.get("output_tokens")),
        reasoning_tokens=_count(value.get("reasoning_tokens")),
        requests=_count(value.get("requests")),
    )


def _stored_cost(value: object) -> CostEstimate | None:
    if not isinstance(value, Mapping):
        return None
    currency, amount = value.get("currency"), value.get("amount")
    if not isinstance(currency, str) or not 0 < len(currency) <= _MAX_CURRENCY_LENGTH or not isinstance(amount, str):
        return None
    try:
        parsed = Decimal(amount)
    except InvalidOperation:
        return None
    return CostEstimate(currency=currency, amount=parsed) if parsed.is_finite() and parsed >= 0 else None


def _stored_run(message: GenerationMessage) -> StoredRunUsage | None:
    """A stored assistant turn as a run's usage; ``None`` for a turn that records none."""

    if message.role != "assistant":
        return None
    usage = _stored_usage(message.data.get("usage"))
    if usage is None:
        return None
    model = message.data.get("model")
    model = model if isinstance(model, Mapping) else {}
    run_id, model_provider_id = message.data.get("run_id"), model.get("model_provider_id")
    plan = model.get("provider_type") == CHATGPT_PLAN_RESPONSES_PROVIDER_TYPE
    return StoredRunUsage(
        run_id=run_id if isinstance(run_id, str) else None,
        model_provider_id=model_provider_id if isinstance(model_provider_id, str) else None,
        plan=plan,
        usage=usage,
        # A stored amount is never shown for a plan run, whatever the turn holds.
        cost=None if plan else _stored_cost(message.data.get("cost")),
        unfinished_requests=_count(message.data.get("unfinished_requests")),
    )


def conversation_usage(messages: Sequence[GenerationMessage]) -> ConversationUsage:
    """Add up a conversation's stored runs. Turns are read tolerantly: what a turn does not record counts as zero."""

    runs = [run for run in map(_stored_run, messages) if run is not None]
    total = RunUsage()
    for run in runs:
        total = total.added(run.usage)
    costs = [run.cost for run in runs if run.cost is not None]
    currencies = {cost.currency for cost in costs}
    cost = (
        CostEstimate(currency=costs[0].currency, amount=sum((cost.amount for cost in costs), Decimal(0)))
        if len(currencies) == 1
        else None
    )
    return ConversationUsage(
        usage=total,
        runs=len(runs),
        cost=cost,
        cost_complete=cost is not None and all(run.cost is not None for run in runs if run.asked_a_model),
        last_run=runs[-1] if runs else None,
    )


__all__ = [
    "ConversationUsage",
    "CostEstimate",
    "RunCostMeter",
    "RunUsage",
    "StoredRunUsage",
    "conversation_usage",
    "run_model",
    "runs_on_plan",
]
