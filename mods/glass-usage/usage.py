# ── Agent limits from Omarchy cache ───────────────────────────
import glob
import json
import os
import re
from datetime import datetime

CACHE = os.path.expanduser("~/.cache/omarchy/agent-usage")


def newest(pattern):
    files = glob.glob(os.path.join(CACHE, pattern))
    return max(files, key=os.path.getmtime) if files else None


def epoch(stamp):
    try:
        return int(datetime.fromisoformat(stamp).timestamp())
    except (TypeError, ValueError):
        return None


def window(limits, pattern):
    for entry in limits:
        if entry.get("title") or not re.search(pattern, entry.get("label", ""), re.I):
            continue
        try:
            used = float(entry["percent"]) * 100
        except (KeyError, TypeError, ValueError):
            continue
        return {"used": max(0.0, min(100.0, used)), "resets": epoch(entry.get("resetsAt"))}
    return None


def reading(pattern):
    path = newest(pattern)
    if not path:
        return None
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    limits = data.get("limits") or []
    return {
        "at": int((data.get("fetchedAtMs") or os.path.getmtime(path) * 1000) / 1000),
        "five": window(limits, r"5.?h|session"),
        "week": window(limits, r"7.?day|weekly"),
        "plan": data.get("tierLabel"),
    }


print(json.dumps({"claude": reading("claude-limits-*.json"), "codex": reading("codex-limits-*.json")}))
