"""ToolBox: a scoped, traced slice of the tool surface for one agent.

Assistant tools come straight from backend.assistant's registries (functions
AND schemas, via the public accessors), so nothing is duplicated. Local tools
(the POS signals) are passed in as {name: (fn, spec)} where fn(args, ctx).
"""

import time

from backend.assistant import tool_registry, tool_specs_for
from backend.db import get_duckdb

from .config import TOOL_RESULT_CHAR_CAP


class ToolBox:
    def __init__(self, assistant_tools: list[str], local_tools: dict,
                 ctx: dict, trace, agent: str):
        data, ctxt = tool_registry()
        self._dispatch = {}
        for n in assistant_tools:
            if n in data:
                self._dispatch[n] = ("data", data[n][0])
            elif n in ctxt:
                self._dispatch[n] = ("ctx", ctxt[n][0])
            else:
                raise KeyError(f"unknown assistant tool: {n}")
        self.specs = tool_specs_for(assistant_tools)
        for name, (fn, spec) in (local_tools or {}).items():
            self._dispatch[name] = ("local", fn)
            self.specs.append(spec)
        self.ctx, self.trace, self.agent = ctx, trace, agent

    def call(self, name: str, args: dict) -> object:
        args = args or {}
        self.trace.note(f"{self.agent}: running tool {name}")
        t0 = time.monotonic()
        try:
            kind, fn = self._dispatch[name]
            if kind == "local":
                out = fn(args, self.ctx)
            else:
                with get_duckdb() as con:
                    out = fn(con, args) if kind == "data" else fn(con, args, self.ctx)
            self.trace.tool_call(self.agent, name, args, out,
                                 int((time.monotonic() - t0) * 1000))
            return out
        except Exception as e:
            self.trace.tool_call(self.agent, name, args, None,
                                 int((time.monotonic() - t0) * 1000), error=str(e))
            return {"error": f"tool {name} failed: {e}"}


def clip_result(payload: str) -> str:
    if len(payload) <= TOOL_RESULT_CHAR_CAP:
        return payload
    return payload[:TOOL_RESULT_CHAR_CAP] + '... [truncated]"'
