"""Claude Agent SDK runtime for the in-app assistant.

Exposes the assistant's existing tool handlers to the official `claude-agent-sdk`
as ONE in-process MCP server, so the agent loop (run by the bundled Claude Code
CLI subprocess) drives the SAME tools the raw-API loop uses. The tool handlers
run IN-PROCESS in this Python worker (DuckDB access via get_duckdb), not in the
subprocess — only orchestration is in the CLI.

Per-request state (the products / templates / screen / rip-cluster accumulators)
lives on a `_Capture` instance carried through a ContextVar, so the shared @tool
wrappers fold each call's result into the in-flight request even though the tool
functions are module-level singletons. ContextVar is task-local under asyncio, so
concurrent requests don't cross-contaminate.

Lazy by design: the SDK is imported only when an agent actually runs, so the app
boots fine where the SDK/CLI isn't installed (the flag-off default).
"""
from __future__ import annotations

import contextvars
import json
import os
import tempfile

# The in-flight request's capture object (backend.assistant._Capture).
_REQUEST: contextvars.ContextVar = contextvars.ContextVar("celr_assistant_capture")

_SERVER = None        # built once, lazily
_CWD: str | None = None


def _isolated_cwd() -> str:
    """A fixed empty working dir for the CLI so its session files never land in
    the repo (paired with setting_sources=[] so no project .claude/ is read)."""
    global _CWD
    if _CWD is None:
        _CWD = tempfile.mkdtemp(prefix="celr_agent_")
    return _CWD


def _sdk_model(model: str) -> str:
    """Map a full Anthropic id to the alias the Claude Code CLI expects. The CLI
    model config takes aliases or full ids; a dated Haiku id can be rejected, so
    normalize the tiers."""
    m = (model or "").lower()
    if "haiku" in m:
        return "haiku"
    if "sonnet" in m:
        return "sonnet"
    if "opus" in m:
        return "opus"
    return model


def _build_server():
    """One in-process MCP server ('celr') wrapping every assistant tool. Each
    @tool handler calls the SAME _Capture.run_tool used by the raw-API loop, so
    capture/templates/screen behave identically on both paths."""
    from claude_agent_sdk import tool, create_sdk_mcp_server
    from backend.db import get_duckdb
    from backend import assistant as A

    sdk_tools = []
    for spec in A._tool_specs():
        def _make(tool_name, tool_desc, tool_schema):
            @tool(tool_name, tool_desc, tool_schema)
            async def _handler(args):
                cap = _REQUEST.get(None)
                if cap is None:
                    return {"content": [{"type": "text", "text": json.dumps({"error": "no request context"})}],
                            "is_error": True}
                try:
                    with get_duckdb() as con:
                        out = cap.run_tool(con, tool_name, args or {})
                except Exception as e:
                    return {"content": [{"type": "text", "text": json.dumps({"error": type(e).__name__})}],
                            "is_error": True}
                return {"content": [{"type": "text", "text": json.dumps(out, default=str)[:6000]}]}
            return _handler

        sdk_tools.append(_make(spec["name"], spec["description"], spec["input_schema"]))
    return create_sdk_mcp_server("celr", "1.0.0", sdk_tools)


def _server():
    global _SERVER
    if _SERVER is None:
        _SERVER = _build_server()
    return _SERVER


def _compose_prompt(question: str, history: list | None) -> str:
    """Fold prior turns into a transcript preamble (stateless — no session files).
    The current question is clearly delimited so the model treats history as
    context, not instructions."""
    from backend.assistant import _history_messages
    try:
        msgs = _history_messages(history)
    except Exception:
        msgs = []
    if not msgs:
        return question
    lines = ["Earlier in this conversation:"]
    for m in msgs:
        role = "User" if m.get("role") == "user" else "Assistant"
        lines.append(f"{role}: {m.get('content', '')}")
    lines.append("")
    lines.append(f"Current question: {question}")
    return "\n".join(lines)


async def run_agent_assistant(question, history, cap, *, page, page_path, model, max_turns):
    """Drive one assistant turn through the Agent SDK. Sets the request ContextVar,
    runs the loop (tools execute in-process via cap.run_tool), and returns the SDK
    AgentResult (text + usage). The caller (assistant.ask_async) then runs the
    shared _finalize_response on the captured state."""
    from backend import assistant as A
    from backend import llm_client

    system = A._compose_system_prompt(page, page_path)
    prompt = _compose_prompt(question, history)
    env = {"DISABLE_AUTOUPDATER": "1"}
    if os.getenv("ANTHROPIC_API_KEY"):
        env["ANTHROPIC_API_KEY"] = os.environ["ANTHROPIC_API_KEY"]

    token = _REQUEST.set(cap)
    try:
        return await llm_client.run_agent(
            system=system,
            prompt=prompt,
            mcp_servers={"celr": _server()},
            allowed_tools=["mcp__celr__*"],
            model=_sdk_model(model),
            max_turns=max_turns,
            cwd=_isolated_cwd(),
            env=env,
        )
    finally:
        _REQUEST.reset(token)
