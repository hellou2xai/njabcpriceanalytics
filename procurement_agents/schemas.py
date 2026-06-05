"""Structured-output schemas: the typed handoffs between agents.

Agents communicate through these objects (and ultimately through Postgres),
never through prose. output_config.format guarantees the final message is
valid JSON matching the schema.
"""

_CANDIDATE = {
    "type": "object",
    "properties": {
        "upc": {"type": "string"},
        "product_name": {"type": "string"},
        "wholesaler": {"type": "string"},
        "reason_code": {"type": "string", "enum": [
            "low_stock", "price_drop", "new_rip", "lapsed_reorder",
            "expiring_deal", "closeout", "tier_stretch", "velocity_deal"]},
        "rationale": {"type": "string"},
        "suggested_cases": {"type": "integer"},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
    },
    "required": ["upc", "product_name", "wholesaler", "reason_code",
                 "rationale", "suggested_cases", "confidence"],
    "additionalProperties": False,
}

SCOUT_REPORT = {
    "type": "json_schema",
    "schema": {
        "type": "object",
        "properties": {
            "candidates": {"type": "array", "items": _CANDIDATE},
            "skipped_note": {"type": "string",
                             "description": "What was considered but left out, one short paragraph."},
        },
        "required": ["candidates", "skipped_note"],
        "additionalProperties": False,
    },
}

_LINE = {
    "type": "object",
    "properties": {
        "upc": {"type": "string"},
        "product_name": {"type": "string"},
        "chosen_wholesaler": {"type": "string"},
        "cases": {"type": "integer"},
        "effective_case_price": {"type": "number"},
        "alt_wholesaler": {"type": ["string", "null"]},
        "alt_effective_price": {"type": ["number", "null"]},
        "savings_vs_alt": {"type": ["number", "null"]},
        "rip_code": {"type": ["string", "null"]},
        "sourcing_note": {"type": "string"},
    },
    "required": ["upc", "product_name", "chosen_wholesaler", "cases",
                 "effective_case_price", "alt_wholesaler", "alt_effective_price",
                 "savings_vs_alt", "rip_code", "sourcing_note"],
    "additionalProperties": False,
}

SOURCING_PLAN = {
    "type": "json_schema",
    "schema": {
        "type": "object",
        "properties": {
            "lines": {"type": "array", "items": _LINE},
            "summary": {"type": "string"},
        },
        "required": ["lines", "summary"],
        "additionalProperties": False,
    },
}
