#!/usr/bin/env python3

import concurrent.futures
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "labeler"))
import server as srv


def compute_metrics(rows, th):
    tp = fp = tn = fn = errs = 0
    for r in rows:
        sc = r.get("score")
        if not isinstance(sc, (int, float)):
            errs += 1
            continue
        pred = sc >= th
        truth = bool(r["human_is_ai"])
        if pred and truth:
            tp += 1
        elif pred and not truth:
            fp += 1
        elif not pred and not truth:
            tn += 1
        else:
            fn += 1
    valid = tp + fp + tn + fn
    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    acc = (tp + tn) / valid if valid else 0.0
    return {"th": th, "tp": tp, "fp": fp, "tn": tn, "fn": fn, "errs": errs, "valid": valid, "prec": prec, "rec": rec, "f1": f1, "acc": acc}


def compute_auc(rows):
    valid = [(r["score"], 1 if r["human_is_ai"] else 0) for r in rows if isinstance(r.get("score"), (int, float))]
    pos = [s for s, y in valid if y == 1]
    neg = [s for s, y in valid if y == 0]
    if not pos or not neg:
        return 0.0
    wins = 0.0
    for p in pos:
        for n in neg:
            if p > n:
                wins += 1.0
            elif p == n:
                wins += 0.5
    return wins / (len(pos) * len(neg))


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 prompts/eval_prompt.py prompts/v1.json")
        sys.exit(1)

    prompt_path = Path(sys.argv[1]).resolve()
    prompt_cfg = json.loads(prompt_path.read_text(encoding="utf-8"))
    jev_env = srv.get_jev_env()

    replies = srv.load_replies()
    labels = srv.load_labels()
    targets = []
    for r in replies:
        rid = str(r.get("reply_id", ""))
        lb = labels.get(rid)
        if not lb or lb.get("decision") != "keep" or lb.get("is_ai") not in (True, False):
            continue
        targets.append((r, lb))

    t0 = time.time()
    chunks = srv.chunk_by_post([t[0] for t in targets], batch_size=12)
    results_by_id = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futs = [pool.submit(srv.score_group_items, ch, prompt_cfg, jev_env) for ch in chunks]
        for fut in concurrent.futures.as_completed(futs):
            results_by_id.update(fut.result())

    elapsed = round(time.time() - t0, 2)
    rows = []
    for r, lb in targets:
        rid = str(r.get("reply_id", ""))
        pred = results_by_id.get(rid) or {"score": None, "category": None, "error": "missing"}
        rows.append({
            "reply_id": rid,
            "target_account": r.get("target_account"),
            "post_text": (r.get("post_text") or "")[:140],
            "reply_text": r.get("reply_text") or "",
            "author": r.get("author") or {},
            "has_media": r.get("has_media"),
            "human_is_ai": bool(lb["is_ai"]),
            "note": lb.get("note", ""),
            "score": pred.get("score"),
            "category": pred.get("category"),
            "error": pred.get("error"),
        })

    auc = compute_auc(rows)
    cur_th = float(prompt_cfg.get("threshold", 0.6))
    cur_m = compute_metrics(rows, cur_th)

    best_m = None
    for t in range(5, 96):
        m = compute_metrics(rows, round(t / 100, 2))
        if best_m is None or m["f1"] > best_m["f1"] or (m["f1"] == best_m["f1"] and m["acc"] > best_m["acc"]):
            best_m = m

    print(f"=== {prompt_path.name} ({len(rows)} samples, {elapsed}s, model={jev_env['model']}) ===")
    print(f"ROC-AUC: {auc:.4f} | API Errors: {cur_m['errs']}")
    print(f"At config th={cur_th:.2f}: F1={cur_m['f1']*100:.2f}% P={cur_m['prec']*100:.2f}% R={cur_m['rec']*100:.2f}% Acc={cur_m['acc']*100:.2f}% (TP={cur_m['tp']} FP={cur_m['fp']} FN={cur_m['fn']} TN={cur_m['tn']})")
    print(f"At BEST   th={best_m['th']:.2f}: F1={best_m['f1']*100:.2f}% P={best_m['prec']*100:.2f}% R={best_m['rec']*100:.2f}% Acc={best_m['acc']*100:.2f}% (TP={best_m['tp']} FP={best_m['fp']} FN={best_m['fn']} TN={best_m['tn']})")


    out_report = prompt_path.with_suffix(".eval.json")
    out_report.write_text(json.dumps({
        "prompt_file": prompt_path.name,
        "elapsed_sec": elapsed,
        "auc": round(auc, 4),
        "config_metrics": cur_m,
        "best_metrics": best_m,
        "rows": rows,
    }, ensure_ascii=False, indent=2), encoding="utf-8")


    th = best_m["th"]
    fps = sorted([r for r in rows if isinstance(r["score"], (int, float)) and r["score"] >= th and not r["human_is_ai"]], key=lambda x: -x["score"])
    fns = sorted([r for r in rows if isinstance(r["score"], (int, float)) and r["score"] < th and r["human_is_ai"]], key=lambda x: x["score"])

    print(f"\n--- FP ({len(fps)}: Human labeled, Model >= {th:.2f}) ---")
    for r in fps:
        a = r["author"]
        print(f"  score={r['score']:.2f} @{a.get('handle')} ({a.get('name')}, blue={a.get('blue_verified')}): {r['reply_text'].replace(chr(10), ' ')[:110]}")

    print(f"\n--- FN ({len(fns)}: AI labeled, Model < {th:.2f}) ---")
    for r in fns:
        a = r["author"]
        print(f"  score={r['score']:.2f} @{a.get('handle')} ({a.get('name')}, blue={a.get('blue_verified')}): {r['reply_text'].replace(chr(10), ' ')[:110]}")


if __name__ == "__main__":
    main()
