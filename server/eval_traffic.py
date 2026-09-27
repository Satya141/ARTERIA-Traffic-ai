"""
Evaluate a Laya checkpoint on held-out traffic decisions.

    python server/eval_traffic.py                  # fine-tuned vs base
    python server/eval_traffic.py --base-only

Reports, per question type:
  * choice  - top-1 accuracy against the oracle's preferred road
  * noul    - accuracy at the 0.5 threshold, and Brier score
  * score   - mean absolute error in levels

The decisive number is the FOUR-WAY ROAD ACCURACY. Chance is 25%. The base
checkpoint scored 1/4 on a hand-built probe by naming the same road every time,
so the degenerate-answer check below is reported explicitly: if a model's
answers collapse onto one road it will show up as a near-100% share.
"""

from __future__ import annotations

import collections
import json
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEST = os.path.join(ROOT, "data", "traffic_decisions.test.jsonl")
FT_DIR = os.path.join(ROOT, "models", "laya-arteria")


def load_rows(path, limit=None):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            rows.append(json.loads(line))
            if limit and len(rows) >= limit:
                break
    return rows


def evaluate(predict_batch, rows, label):
    states = [json.loads(r["state"]) for r in rows]
    golds = [json.loads(r["gold"]) for r in rows]

    # Chunked. Handing the whole split to predict_batch at once asks for one
    # forward pass over 1,200 x 4 sequences, which tries to allocate several GB.
    CHUNK = 24
    t0 = time.perf_counter()
    results = []
    for i in range(0, len(states), CHUNK):
        results.extend(predict_batch(states[i:i + CHUNK]))
        if i and i % (CHUNK * 10) == 0:
            print(f"    {i}/{len(states)} ...", flush=True)
    elapsed = time.perf_counter() - t0

    n = len(rows)
    choice_hits = 0
    noul_hits = {"extend": 0, "emergency": 0}
    noul_brier = {"extend": 0.0, "emergency": 0.0}
    score_err = 0.0
    picked = collections.Counter()

    for res, gold in zip(results, golds):
        ans = res.get("answers", {}) or {}

        g = gold["next_road"]["probabilities"]
        want = max(g, key=g.get)
        got = (ans.get("next_road") or {}).get("choice")
        picked[got] += 1
        if got == want:
            choice_hits += 1

        for q in ("extend", "emergency"):
            p_true = float(gold[q]["probabilities"]["true"])
            p_hat = float((ans.get(q) or {}).get("noul", 0.5))
            if (p_hat >= 0.5) == (p_true >= 0.5):
                noul_hits[q] += 1
            noul_brier[q] += (p_hat - p_true) ** 2

        gp = gold["pressure"]["probabilities"]
        g_lvl = max(range(3), key=lambda i: gp[str(i)])
        p_lvl = float((ans.get("pressure") or {}).get("score", 1.0))
        score_err += abs(p_lvl - g_lvl)

    top = picked.most_common(1)[0] if picked else ("-", 0)
    print(f"\n=== {label} ===")
    print(f"  cases                 : {n}   ({elapsed:.1f}s, {elapsed/n*1000:.0f} ms/case)")
    print(f"  road choice (4-way)   : {choice_hits/n*100:.1f}%   (chance 25%)")
    print(f"  most-picked road      : {top[0]} on {top[1]/n*100:.0f}% of cases"
          f"{'   <-- DEGENERATE' if top[1]/n > 0.6 else ''}")
    print(f"  extend    accuracy    : {noul_hits['extend']/n*100:.1f}%   "
          f"Brier {noul_brier['extend']/n:.3f}")
    print(f"  emergency accuracy    : {noul_hits['emergency']/n*100:.1f}%   "
          f"Brier {noul_brier['emergency']/n:.3f}")
    print(f"  pressure  mean abs err: {score_err/n:.2f} levels (of 0..2)")
    return {"choice": choice_hits / n, "top_share": top[1] / n}


def main():
    limit = None
    for a in sys.argv[1:]:
        if a.startswith("--limit="):
            limit = int(a.split("=")[1])
    base_only = "--base-only" in sys.argv

    if not os.path.exists(TEST):
        print(f"ERROR: {TEST} not found. Run: node tools/make_dataset.mjs 3000")
        sys.exit(1)

    rows = load_rows(TEST, limit)
    sys.path.insert(0, os.path.join(ROOT, "server"))
    from laya_service import QUESTIONS

    import torch
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"device: {dev}   test cases: {len(rows)}")

    results = {}

    if not base_only and os.path.isdir(FT_DIR):
        from laya import load
        agent = load(FT_DIR, device=dev)
        try:
            print("  fine-tuned model device:",
                  next(agent.model.parameters()).device)
        except Exception:
            pass
        results["fine-tuned"] = evaluate(
            lambda states: agent.predict_batch(states, QUESTIONS),
            rows, "laya-arteria (fine-tuned on simulator decisions)")
        del agent
        torch.cuda.empty_cache()

    from laya import Router
    router = Router(device=dev)
    results["base"] = evaluate(
        lambda states: router.predict_batch(
            [{"state": s, "questions": QUESTIONS} for s in states]),
        rows, "laya (base checkpoint, zero-shot)")

    if "fine-tuned" in results:
        ft, bs = results["fine-tuned"]["choice"], results["base"]["choice"]
        print(f"\n  road-choice accuracy: base {bs*100:.1f}%  ->  fine-tuned {ft*100:.1f}%"
              f"   ({(ft-bs)*100:+.1f} points)")


if __name__ == "__main__":
    main()
