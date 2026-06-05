"""Temp: inspect an agent run's trace."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.pg import get_pg

run_id = int(sys.argv[1]) if len(sys.argv) > 1 else 2
with get_pg() as pg:
    run = pg.execute("SELECT * FROM agent_runs WHERE id=%s", (run_id,)).fetchone()
    print({k: run[k] for k in ("status", "candidates", "lines_kept", "lines_vetoed",
                               "est_total_usd", "est_savings_usd", "input_tokens",
                               "output_tokens", "cost_usd", "duration_ms")})
    print("\nsteps:")
    steps = pg.execute("SELECT * FROM agent_steps WHERE run_id=%s ORDER BY seq",
                       (run_id,)).fetchall()
    for s in steps:
        line = (f"  {s['seq']:>2} {s['agent']:<9} {s['kind']:<9} {s['name']:<28} "
                f"{s['duration_ms']:>6}ms")
        if s["kind"] == "llm_turn":
            line += (f"  in={s['input_tokens']:>6} out={s['output_tokens']:>5} "
                     f"cr={s['cache_read_tokens']:>6} cw={s['cache_write_tokens']:>6} "
                     f"${s['cost_usd']:.4f}")
        print(line)
    gate = next(s for s in steps if s["name"] == "money_gate")
    detail = json.loads(gate["detail"])
    print("\nveto breakdown:")
    from collections import Counter
    for reason, n in Counter(v["reason"] for v in detail["vetoed_lines"]).items():
        print(f"  {reason}: {n}")
    for v in detail["vetoed_lines"][:8]:
        print(f"    {v['reason']:<16} {str(v['name'])[:38]:<40} {str(v['detail'])[:70]}")
