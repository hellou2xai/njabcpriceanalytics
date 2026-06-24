"""THE single AI/LLM seam for CELR. Every model call goes through here.

Two surfaces:

  - ``complete(...)``  — one-shot Messages-API call (catalog query, search
    expansion, blurbs). Provider-pluggable: ``anthropic`` today, ``openrouter``
    later (OpenRouter exposes an Anthropic-compatible Messages endpoint, so the
    same call shape works — only base_url / api_key / the model id differ).
  - ``run_agent(...)`` — the agentic loop, delegated to the official
    ``claude-agent-sdk`` (Claude Code as a library). CLAUDE-ONLY: the Agent SDK
    drives a Claude-tuned CLI subprocess, so the provider seam does NOT apply to
    it. Bounded by a concurrency semaphore (each call spawns a CLI subprocess).

Prompt caching is ON by default for ``complete()`` (system + last tool get an
``ephemeral`` cache_control breakpoint) so repeated boilerplate is billed at
~0.1x on reuse. The agent path relies on the SDK's automatic system+tools
caching.

Model tiers (Haiku/Sonnet) and the per-feature CELR_*_MODEL env defaults live
here; ``backend/model_router.py`` re-exports ``choose_model``/``HAIKU``/``SONNET``
from this module so existing imports keep working.
"""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Model tiers + per-feature defaults (single source of truth).
# ---------------------------------------------------------------------------
HAIKU = os.getenv("CELR_HAIKU_MODEL", "claude-haiku-4-5-20251001")
SONNET = os.getenv("CELR_SONNET_MODEL", os.getenv("CELR_SEARCH_AI_MODEL", "claude-sonnet-4-6"))

# Per-feature model ids (kept as the existing env names / defaults).
CATALOG_MODEL = os.getenv("CELR_CATALOG_AI_MODEL", HAIKU)
SEARCH_MODEL = os.getenv("CELR_SEARCH_AI_MODEL", SONNET)
BLURB_MODEL = os.getenv("CELR_BLURB_AI_MODEL", SEARCH_MODEL)
PRODUCT_BLURB_MODEL = os.getenv("CELR_PRODUCT_BLURB_AI_MODEL", BLURB_MODEL)
MOVER_BLURB_MODEL = os.getenv("CELR_MOVER_BLURB_AI_MODEL", BLURB_MODEL)
SCOUT_MODEL = os.getenv("CELR_AGENT_SCOUT_MODEL", SONNET)
SOURCING_MODEL = os.getenv("CELR_AGENT_SOURCING_MODEL", SONNET)

# Signals that a question needs Sonnet-level reasoning (cost router).
_COMPLEX = (
    "compare", "comparison", "vs ", "versus", "trend", "why", "analy", "breakdown",
    "break down", "distribut", "across", "recommend", "suggest", "summar", "margin",
    "forecast", "explain", "over time", "history", "chart", "graph", "plot",
    "best value", "which is", "how many", "average", "most ", "least ", "top ",
)
_DISCOVERY = (
    "show", "list", "find", "cheapest", "under $", "under ", "discount", "deal",
    "deals", "rebate", "rip", "best", "top ", "wines", "wine", "compare", "which",
    "lowest", "highest", "biggest",
)


def choose_model(question: str, *, force: str | None = None, standalone: bool = False) -> str:
    """Cheapest model that can handle the question (cost-efficiency router).
    Moved verbatim from model_router so all tiering lives in one place."""
    if force == "haiku":
        return HAIKU
    if force == "sonnet":
        return SONNET
    q = (question or "").lower().strip()
    if not q:
        return HAIKU
    if len(q) > 160 or q.count("?") > 1 or (" and " in q and len(q) > 90):
        return SONNET
    if any(k in q for k in _COMPLEX):
        return SONNET
    if standalone and any(k in q for k in _DISCOVERY):
        return SONNET
    return HAIKU


# ---------------------------------------------------------------------------
# Provider selection (single-shot path only).
# ---------------------------------------------------------------------------
class Provider(str, Enum):
    ANTHROPIC = "anthropic"
    OPENROUTER = "openrouter"


def _provider() -> Provider:
    try:
        return Provider((os.getenv("CELR_LLM_PROVIDER") or "anthropic").lower())
    except ValueError:
        return Provider.ANTHROPIC


def _model_map() -> dict:
    """Optional Anthropic-id -> provider-id remap (JSON in CELR_LLM_MODEL_MAP)."""
    raw = os.getenv("CELR_LLM_MODEL_MAP")
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


def _map_model(model: str) -> str:
    return _model_map().get(model, model)


_CLIENT = None
_CLIENT_KEY: tuple | None = None


def _single_client():
    """Build (and cache) the one-shot Messages-API client for the active
    provider. Returns None when no key is configured (callers fall back)."""
    global _CLIENT, _CLIENT_KEY
    prov = _provider()
    if prov is Provider.OPENROUTER:
        key = os.getenv("OPENROUTER_API_KEY")
        base = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
        cache_key = ("openrouter", base, bool(key))
    else:
        key = os.getenv("ANTHROPIC_API_KEY")
        base = None
        cache_key = ("anthropic", None, bool(key))
    if not key:
        return None
    if _CLIENT is not None and _CLIENT_KEY == cache_key:
        return _CLIENT
    try:
        import anthropic
    except Exception:
        return None
    try:
        _CLIENT = anthropic.Anthropic(base_url=base, api_key=key) if base else anthropic.Anthropic(api_key=key)
    except Exception:
        _CLIENT = None
        return None
    _CLIENT_KEY = cache_key
    return _CLIENT


def enabled() -> bool:
    """True when the single-shot LLM path is configured (key present)."""
    return _single_client() is not None


def single_client():
    """The underlying provider Messages client (or None). Exposed for the few
    transitional call sites that still build requests by hand; new code should
    use ``complete()``."""
    return _single_client()


# ---------------------------------------------------------------------------
# Single-shot completion.
# ---------------------------------------------------------------------------
@dataclass
class Completion:
    text: Optional[str]
    tool_use: Optional[dict]          # {"name": str, "input": dict} for the first tool_use block
    input_tokens: int
    output_tokens: int
    cache_read: int
    cache_write: int
    model: str
    raw: Any


def _cache_system(system):
    """Wrap a plain system string in a cached text block. Pass-through if the
    caller already supplied structured blocks (they control their own caching)."""
    if isinstance(system, str) and system:
        return [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
    return system


def _cache_last_tool(tools):
    """Add an ephemeral breakpoint to the last tool if none is set, so the tool
    schema is cached alongside the system prompt."""
    if not tools:
        return tools
    if any(isinstance(t, dict) and "cache_control" in t for t in tools):
        return tools
    last = tools[-1]
    if isinstance(last, dict):
        return [*tools[:-1], {**last, "cache_control": {"type": "ephemeral"}}]
    return tools


def complete(
    *,
    model: str,
    messages: list,
    system: Any = None,
    tools: list | None = None,
    tool_choice: dict | None = None,
    max_tokens: int = 512,
    cache: bool = True,
) -> Completion:
    """One-shot Messages-API call through the active provider. Prompt caching is
    ON by default (system + last tool get an ephemeral breakpoint). Raises if the
    provider is not configured — callers gate on ``enabled()`` and fall back."""
    client = _single_client()
    if client is None:
        raise RuntimeError("LLM provider not configured")

    kwargs: dict = {"model": _map_model(model), "max_tokens": max_tokens, "messages": messages}
    if system is not None:
        kwargs["system"] = _cache_system(system) if cache else system
    if tools:
        kwargs["tools"] = _cache_last_tool(tools) if cache else tools
    if tool_choice:
        kwargs["tool_choice"] = tool_choice

    msg = client.messages.create(**kwargs)

    text = "".join(
        getattr(b, "text", "") for b in (msg.content or []) if getattr(b, "type", "") == "text"
    ).strip() or None
    tool_use = None
    for b in msg.content or []:
        if getattr(b, "type", None) == "tool_use":
            tool_use = {"name": getattr(b, "name", ""), "input": getattr(b, "input", {}) or {}}
            break

    u = getattr(msg, "usage", None)
    return Completion(
        text=text,
        tool_use=tool_use,
        input_tokens=getattr(u, "input_tokens", 0) or 0,
        output_tokens=getattr(u, "output_tokens", 0) or 0,
        cache_read=getattr(u, "cache_read_input_tokens", 0) or 0,
        cache_write=getattr(u, "cache_creation_input_tokens", 0) or 0,
        model=model,
        raw=msg,
    )


# ---------------------------------------------------------------------------
# Agentic loop (claude-agent-sdk). Claude-only; bounded by a semaphore.
# ---------------------------------------------------------------------------
def _agent_concurrency() -> int:
    try:
        return max(1, int(os.getenv("CELR_AGENT_MAX_CONCURRENCY", "1")))
    except ValueError:
        return 1


_AGENT_SEM: asyncio.Semaphore | None = None


def _agent_sem() -> asyncio.Semaphore:
    # Lazily created on the running loop so import never needs an event loop.
    global _AGENT_SEM
    if _AGENT_SEM is None:
        _AGENT_SEM = asyncio.Semaphore(_agent_concurrency())
    return _AGENT_SEM


def use_agent_sdk() -> bool:
    """Rollout flag — when off, callers keep their existing raw-API loop."""
    return (os.getenv("CELR_USE_AGENT_SDK") or "0").strip().lower() in ("1", "true", "yes", "on")


@dataclass
class AgentResult:
    text: str
    structured_output: Any
    input_tokens: int
    output_tokens: int
    cache_read: int
    cache_write: int
    total_cost_usd: Optional[float]
    num_turns: int
    is_error: bool
    model: str


async def run_agent(
    *,
    system: str,
    prompt: Any,
    mcp_servers: dict,
    allowed_tools: list,
    model: str,
    fallback_model: str | None = None,
    max_turns: int = 8,
    cwd: str | None = None,
    env: dict | None = None,
    effort: str | None = None,
    extra_options: dict | None = None,
) -> AgentResult:
    """Run one agentic task via claude-agent-sdk and collect the final text +
    usage. The in-process MCP servers in ``mcp_servers`` execute tools inside this
    Python worker; only the agent loop runs in the spawned CLI subprocess.

    The SDK auto-caches the (string) system prompt + tool schemas, so prompt
    caching is preserved on the agent path without manual cache_control."""
    # Lazy import so this module loads even where the SDK/CLI isn't installed yet.
    from claude_agent_sdk import (
        query,
        ClaudeAgentOptions,
        AssistantMessage,
        TextBlock,
        ResultMessage,
    )

    opt_kwargs: dict = dict(
        model=model,
        system_prompt=system,
        setting_sources=[],          # ignore repo .claude/CLAUDE.md/skills/settings
        mcp_servers=mcp_servers,
        allowed_tools=allowed_tools,
        tools=[],                     # strip ALL built-in (Read/Write/Bash/...) tools
        permission_mode="bypassPermissions",
        max_turns=max_turns,
        env=(env or {}),
    )
    if fallback_model:
        opt_kwargs["fallback_model"] = fallback_model
    if cwd:
        opt_kwargs["cwd"] = cwd
    if effort:
        opt_kwargs["effort"] = effort
    if extra_options:
        opt_kwargs.update(extra_options)
    options = ClaudeAgentOptions(**opt_kwargs)

    parts: list[str] = []
    final_text = ""
    structured: Any = None
    in_tok = out_tok = cache_r = cache_w = num_turns = 0
    cost: float | None = None
    is_error = False

    async with _agent_sem():
        async for msg in query(prompt=prompt, options=options):
            if isinstance(msg, AssistantMessage):
                parts = [b.text for b in msg.content if isinstance(b, TextBlock)]
            elif isinstance(msg, ResultMessage):
                u = getattr(msg, "usage", None) or {}
                in_tok = int(u.get("input_tokens", 0) or 0)
                out_tok = int(u.get("output_tokens", 0) or 0)
                cache_r = int(u.get("cache_read_input_tokens", 0) or 0)
                cache_w = int(u.get("cache_creation_input_tokens", 0) or 0)
                cost = getattr(msg, "total_cost_usd", None)
                num_turns = getattr(msg, "num_turns", 0) or 0
                is_error = bool(getattr(msg, "is_error", False))
                structured = getattr(msg, "structured_output", None)
                final_text = getattr(msg, "result", None) or "".join(parts)

    return AgentResult(
        text=final_text or "".join(parts),
        structured_output=structured,
        input_tokens=in_tok,
        output_tokens=out_tok,
        cache_read=cache_r,
        cache_write=cache_w,
        total_cost_usd=cost,
        num_turns=num_turns,
        is_error=is_error,
        model=model,
    )
