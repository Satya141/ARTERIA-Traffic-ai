"""
ARTERIA — Laya decision sidecar.

Laya is a non-autoregressive System 1 decision engine: it answers typed
questions (choice / score / yes-no) about a piece of text in a single forward
pass, with calibrated probabilities and no generated text to parse.

Every discrete decision a signal controller makes is exactly that shape:

    which road gets the green next?        -> choice
    should this green be extended?         -> noul (yes/no)
    does an emergency need priority?       -> noul
    how badly is traffic building up?      -> score

So this service takes the junction state the cameras produced, written out in
plain language, and asks Laya those questions for all six junctions in one
batched call. The browser applies the answers.

Run it with:

    pip install -r server/requirements.txt
    python server/laya_service.py

The simulation runs perfectly well without it — the controller falls back to
its own heuristic — but with it, Laya is doing the deciding.
"""

from __future__ import annotations

import os
import time
from typing import Any, Dict, List

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

MODEL_NAME = os.environ.get("ARTERIA_LAYA_MODEL", "")  # "" = let the Router pick
DEVICE = os.environ.get("ARTERIA_LAYA_DEVICE", "")     # "" = auto (cuda if present)

# A checkpoint fine-tuned on this simulator's decisions, if one has been trained.
# The shipped checkpoint has never seen a traffic decision and answers this
# domain at close to chance, so the fine-tuned one is strongly preferred.
_FT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "models", "laya-arteria")
FINE_TUNED = _FT if os.path.isdir(_FT) else ""
HOST = os.environ.get("ARTERIA_LAYA_HOST", "127.0.0.1")
PORT = int(os.environ.get("ARTERIA_LAYA_PORT", "8077"))

# ---------------------------------------------------------------------------
#  The question set. This is the controller's decision surface, written once.
# ---------------------------------------------------------------------------
ROAD_CRITERIA = {
    "north": "the north road should be released next",
    "east": "the east road should be released next",
    "south": "the south road should be released next",
    "west": "the west road should be released next",
}

QUESTIONS: Dict[str, Dict[str, Any]] = {
    "next_road": {
        "type": "choice",
        "instructions": (
            "One road at a time may have a green light. Given how many vehicles are "
            "waiting on each road and how long they have been waiting, which road "
            "should be given the green light next?"
        ),
        "criteria": ROAD_CRITERIA,
    },
    "extend": {
        "type": "noul",
        "instructions": (
            "The road that currently has the green still has vehicles moving through. "
            "Should its green be held for a few more seconds rather than switching now?"
        ),
    },
    "emergency": {
        "type": "noul",
        "instructions": (
            "Is there an emergency vehicle, such as an ambulance, that must be given "
            "a green light immediately ahead of normal traffic?"
        ),
    },
    "pressure": {
        "type": "score",
        "instructions": "How badly is traffic building up at this junction overall?",
        "criteria": ["light", "building", "heavy"],
    },
}


class Junction(BaseModel):
    id: str
    state: str


class DecideRequest(BaseModel):
    junctions: List[Junction]


app = FastAPI(title="ARTERIA Laya sidecar")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # local dev only; the sidecar binds to loopback
    allow_methods=["*"],
    allow_headers=["*"],
)

_router = None
_info: Dict[str, Any] = {"ready": False}


def get_router():
    """Load the Router once, on the first request that needs it."""
    global _router, _info
    if _router is None:
        t0 = time.perf_counter()
        dev = DEVICE or None
        if dev is None:
            try:
                import torch
                dev = "cuda" if torch.cuda.is_available() else "cpu"
            except Exception:
                dev = "cpu"

        if FINE_TUNED:
            from laya import load
            _router = load(FINE_TUNED, device=dev)
            kind = "laya-arteria (fine-tuned on simulator decisions)"
        else:
            from laya import Router
            _router = Router(device=dev)
            kind = "laya (base checkpoint, zero-shot)"

        _info = {
            "ready": True,
            "load_seconds": round(time.perf_counter() - t0, 2),
            "engine": "laya",
            "checkpoint": kind,
            "device": dev,
            "fine_tuned": bool(FINE_TUNED),
        }
        try:
            import laya

            _info["version"] = getattr(laya, "__version__", "unknown")
        except Exception:
            pass
        print(f"[laya] router ready in {_info['load_seconds']}s")
    return _router


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True, **_info}


@app.post("/decide")
def decide(req: DecideRequest) -> Dict[str, Any]:
    """Answer the full question set for every junction in one batched pass."""
    router = get_router()

    requests: List[Dict[str, Any]] = []
    for j in req.junctions:
        entry: Dict[str, Any] = {"state": j.state, "questions": QUESTIONS}
        if MODEL_NAME:
            entry["model"] = MODEL_NAME
        requests.append(entry)

    t0 = time.perf_counter()
    if FINE_TUNED:
        # laya.load() returns an Agent: same questions for every state
        results = router.predict_batch([r["state"] for r in requests], QUESTIONS)
    else:
        results = router.predict_batch(requests)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    out: Dict[str, Any] = {}
    for j, res in zip(req.junctions, results):
        answers = res.get("answers", {}) or {}
        nxt = answers.get("next_road", {}) or {}
        ext = answers.get("extend", {}) or {}
        eme = answers.get("emergency", {}) or {}
        pre = answers.get("pressure", {}) or {}

        out[j.id] = {
            "next_road": {
                "choice": nxt.get("choice"),
                "probabilities": nxt.get("probabilities", {}),
                "confidence": nxt.get("confidence"),
            },
            "extend": {
                "yes": ext.get("noul"),
                "confidence": ext.get("confidence"),
            },
            "emergency": {
                "yes": eme.get("noul"),
                "confidence": eme.get("confidence"),
            },
            "pressure": {
                # expected value over ["light", "building", "heavy"]
                "score": pre.get("score"),
                "legend": pre.get("legend", {}),
                "confidence": pre.get("confidence"),
            },
            "model": (res.get("routing", {}) or {}).get("model"),
        }

    return {
        "decisions": out,
        "latency_ms": round(elapsed_ms, 1),
        "per_junction_ms": round(elapsed_ms / max(len(req.junctions), 1), 2),
        "engine": "laya",
    }


if __name__ == "__main__":
    import uvicorn

    # Load the checkpoint BEFORE serving. Loading it lazily on the first request
    # means that request hangs for as long as the download takes, the browser
    # gives up on it, and Laya is marked offline just as it becomes ready.
    print("[laya] loading checkpoint (first run downloads it; this can take a while)")
    get_router()
    print(f"[laya] ARTERIA decision sidecar ready on http://{HOST}:{PORT}")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
