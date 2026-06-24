"""The shared traced agent loop.

One function runs any agent: manual tool-use loop (so the gate between model
and money stays in our code), structured output on the final message, prompt
caching on the system block, a hard per-run token budget, and a trace entry
for every LLM turn and tool call.
"""

import json
import time
import types

import anthropic

from .config import MAX_RUN_TOKENS, MAX_TURNS
from .registry import ToolBox, clip_result


class RunBudgetExceeded(RuntimeError):
    pass


def run_agent(trace, agent: str, model: str, system: str, box: ToolBox,
              user_message: str, output_format: dict) -> dict:
    """Run one agent to completion; returns the parsed structured output.

    Routes to the Claude Agent SDK when CELR_USE_AGENT_SDK is on, else the raw-API
    loop below (kept intact for instant rollback)."""
    from backend import llm_client
    if llm_client.use_agent_sdk():
        try:
            return _run_agent_sdk(trace, agent, model, system, box, user_message, output_format)
        except Exception as e:
            # Degrade to the proven raw-API loop on any SDK/subprocess failure
            # rather than failing the whole procurement run.
            trace.note(f"{agent}: Agent SDK failed ({type(e).__name__}); using raw-API loop")
    return _run_agent_rawapi(trace, agent, model, system, box, user_message, output_format)


def _run_agent_sdk(trace, agent: str, model: str, system: str, box: ToolBox,
                   user_message: str, output_format: dict) -> dict:
    """Agent SDK path: drive the loop via claude-agent-sdk over an in-process MCP
    server built from `box`. Structured output via output_format; one trace turn
    for the run's aggregate usage."""
    import asyncio
    import os
    from backend import llm_client, agent_runtime
    from .sdk_tools import build_mcp_server

    mcp_servers, allowed = build_mcp_server(box)
    env = {"DISABLE_AUTOUPDATER": "1"}
    if os.getenv("ANTHROPIC_API_KEY"):
        env["ANTHROPIC_API_KEY"] = os.environ["ANTHROPIC_API_KEY"]

    trace.note(f"{agent}: thinking (Agent SDK)")
    t0 = time.monotonic()
    res = asyncio.run(llm_client.run_agent(
        system=system,
        prompt=user_message,
        mcp_servers=mcp_servers,
        allowed_tools=allowed,
        model=agent_runtime._sdk_model(model),
        max_turns=MAX_TURNS,
        cwd=agent_runtime._isolated_cwd(),
        env=env,
        extra_options={"output_format": output_format},
    ))
    usage = types.SimpleNamespace(
        input_tokens=res.input_tokens, output_tokens=res.output_tokens,
        cache_read_input_tokens=res.cache_read, cache_creation_input_tokens=res.cache_write)
    trace.llm_turn(agent, model, usage, int((time.monotonic() - t0) * 1000),
                   "refusal" if res.is_error else "end_turn")
    if res.structured_output is not None:
        return res.structured_output
    if res.text:
        return json.loads(res.text)
    raise RuntimeError(f"{agent} produced no final output (Agent SDK)")


def _run_agent_rawapi(trace, agent: str, model: str, system: str, box: ToolBox,
                      user_message: str, output_format: dict) -> dict:
    """Run one agent to completion via the raw Messages API; returns parsed output."""
    client = anthropic.Anthropic()
    # cache_control on the system block: turns 2..N of this loop reread the
    # (system + tools) prefix from cache at ~0.1x instead of full price.
    system_blocks = [{"type": "text", "text": system,
                      "cache_control": {"type": "ephemeral"}}]
    messages = [{"role": "user", "content": user_message}]

    resp = None
    for turn in range(MAX_TURNS + 1):
        if trace.input_tokens + trace.output_tokens > MAX_RUN_TOKENS:
            raise RunBudgetExceeded(
                f"run exceeded {MAX_RUN_TOKENS} tokens during {agent}")
        force_final = turn == MAX_TURNS
        trace.note(f"{agent}: thinking (turn {turn + 1})"
                   + (" - writing final output" if force_final else ""))
        t0 = time.monotonic()
        resp = client.messages.create(
            model=model,
            max_tokens=16000,
            system=system_blocks,
            tools=box.specs,
            tool_choice={"type": "none"} if force_final else {"type": "auto"},
            messages=messages if not force_final else messages + [{
                "role": "user",
                "content": "Tool budget exhausted. Produce your final structured "
                           "output now from what you already know."}],
            output_config={"format": output_format},
        )
        trace.llm_turn(agent, model, resp.usage,
                       int((time.monotonic() - t0) * 1000), resp.stop_reason)
        if resp.stop_reason != "tool_use":
            break
        messages.append({"role": "assistant", "content": resp.content})
        results = []
        for block in resp.content:
            if block.type == "tool_use":
                out = box.call(block.name, block.input)
                results.append({
                    "type": "tool_result", "tool_use_id": block.id,
                    "content": clip_result(json.dumps(out, default=str)),
                })
        messages.append({"role": "user", "content": results})

    text = next((b.text for b in resp.content if b.type == "text"), None)
    if not text:
        raise RuntimeError(f"{agent} produced no final text "
                           f"(stop_reason={resp.stop_reason})")
    return json.loads(text)
