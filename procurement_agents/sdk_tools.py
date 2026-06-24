"""Wrap a procurement ToolBox as an in-process Claude Agent SDK MCP server.

The Scout/Sourcing agents reuse assistant tools via ToolBox (registry.py). To run
them through claude-agent-sdk we expose the SAME ToolBox.call dispatch (which
already traces + clips) as an in-process MCP server, so no tool logic is forked
and the trace UI keeps working. Lazy SDK import so importing this module never
requires the SDK to be installed.
"""
from __future__ import annotations

import json

from .registry import ToolBox, clip_result


def build_mcp_server(box: ToolBox):
    """Return (mcp_servers_dict, allowed_tools) for `box`. Each SDK tool calls
    box.call(name, args) — same dispatch + tracing the manual loop used."""
    from claude_agent_sdk import tool, create_sdk_mcp_server

    sdk_tools = []
    names = []
    for spec in box.specs:
        names.append(spec["name"])

        def _make(tool_name, tool_desc, tool_schema):
            @tool(tool_name, tool_desc, tool_schema)
            async def _handler(args):
                out = box.call(tool_name, args or {})
                return {"content": [{"type": "text", "text": clip_result(json.dumps(out, default=str))}]}
            return _handler

        sdk_tools.append(_make(spec["name"], spec["description"], spec["input_schema"]))

    server = create_sdk_mcp_server("celr_agent", "1.0.0", sdk_tools)
    return {"celr_agent": server}, ["mcp__celr_agent__" + n for n in names]
