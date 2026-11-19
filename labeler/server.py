#!/usr/bin/env python3

import argparse
import concurrent.futures
import datetime
import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

LABELER_DIR = Path(__file__).resolve().parent
ROOT = LABELER_DIR.parent
ENV_PATH = LABELER_DIR / ".env"
DATASET_DIR = ROOT / "dataset"
REPLIES_PATH = DATASET_DIR / "replies.jsonl"
LABELS_PATH = DATASET_DIR / "labels.json"
LABELED_JSONL_PATH = DATASET_DIR / "labeled.jsonl"
SUGGESTIONS_PATH = DATASET_DIR / "suggestions.json"
PROMPT_CONFIG_PATH = DATASET_DIR / "prompt_config.json"
REGRESSION_LATEST_PATH = DATASET_DIR / "regression_latest.json"
INDEX_HTML_PATH = LABELER_DIR / "index.html"
REGRESSION_HTML_PATH = LABELER_DIR / "regression.html"

DEFAULT_AI_SLOP_INSTRUCTIONS = (
    "这条 X (Twitter) 回复是不是由 AI 自动生成或 AI 辅助批量刷评的「AI Slop」（包括中文蓝V养号/引流号的模板化技术点评，以及英文 reply-guy 刷评）？\n"
    "常见特征（满足任意一两条就很可疑，请结合回复正文、原帖内容、作者简介及同帖其他回复综合判断）：\n"
    "1) 「概括肯定 + 抽象权衡 + 礼貌追问」的经典 AI 养号三段式：开头精准改写原帖关键词并轻度肯定（如\"把XX沉淀成YY很有效\"\"这个分工挺有意思\"\"XX确实值得琢磨\"），中间用工整句式补一句四平八稳的抽象维度或转折（\"不过关键在于…\"\"最难的不是A而是B：X、Y、Z\"），结尾常附带一个语法完美、客套的开放式提问（\"好奇你在XX会不会…？\"\"你们现在主要是A还是B？\"）；\n"
    "2) 中英文 LLM 高频套话与对称修辞：中文如\"不仅…更…\"\"本质上是\"\"归根结底\"\"值得注意的是\"\"总而言之\"\"这不仅是X，更是Y\"\"更具想象空间\"；英文如\"Great point!\"\"This really highlights\"\"It's not just X, it's Y\"\"game-changer\"\"rapidly evolving landscape\"\"What do you think?\"，以及高频长破折号（—— / —）、冒号分点列举；\n"
    "3) 缺乏真实个人经历与情绪的「完美书面腔」：全篇标点规范、逻辑滴水不漏、语气像公关/咨询顾问或教科书，没有口语停顿、主观吐槽、具体踩坑细节或真实立场；\n"
    "4) 账号人设与回复内容割裂（强旁证）：作者简介是引流/卖号/代充/\"有关必回\"/\"AI资讯工具汇总\"/\"A股短线\"/\"AI | SaaS | Web3\"等营销或养号人设（常见蓝V），却在硬核技术帖下发出极其工整、面面俱到的抽象点评；\n"
    "5) 整楼同质化：同一帖子下多个不同账号发出结构雷同的\"肯定原帖 + 抽象补充 + 互动提问\"回复，属于典型的 AI 养号/刷互动行为。\n"
    "以下正常人类回复不算 AI Slop（注意避免误伤）：\n"
    "- 简短口语互动、玩梗、吐槽、直接发问（如\"笑死\"\"确实\"\"请问数据库也合了吗\"\"之前那个版本真的垃圾\"\"+1\"\"lmao\"）；\n"
    "- 包含具体个人实操经历、真实情绪或鲜明主观偏好的长评（如\"我去年也踩过这个坑，实测完马上切过去了\"\"讲的毕竟是人话\"），即使逻辑清晰、字数较多也算人类。"
)

DEFAULT_CATEGORIES = {
    "human": "正常人类回复：有真实情绪/立场/口语感、具体个人经历或实操细节、简短提问/吐槽/玩梗，哪怕字数较长或有条理也算人类",
    "likely_ai": "疑似 AI 润色或半自动回复：与原帖相关且有一定信息量，但句式过度工整、书面化公关腔或模板感偏重，像经 LLM 生成/改写后发出",
    "ai_slop": "典型 AI Slop（AI 刷评/养号回复）：空洞复述原帖 + 四平八稳抽象权衡 + 礼貌互动追问，或营销/蓝V养号账号发出的高度模板化 LLM 点评、英文 reply-guy 刷评",
}

DEFAULT_INPUT_FIELDS = [
    "post_text",
    "author.name",
    "author.handle",
    "author.blue_verified",
    "reply_text",
    "has_media",
]

DEFAULT_PROMPT_CONFIG = {
    "schema_version": 1,
    "threshold": 0.60,
    "use_thread_context": True,
    "input_fields": DEFAULT_INPUT_FIELDS,
    "instructions": DEFAULT_AI_SLOP_INSTRUCTIONS,
    "categories": DEFAULT_CATEGORIES,
}

FILE_LOCK = threading.Lock()


def load_env_file(path: Path) -> dict:
    env = {}
    if not path.exists():
        return env
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        env[k] = v
    return env


def get_jev_env() -> dict:
    file_env = load_env_file(ENV_PATH)
    url = os.environ.get("JEV_URL") or file_env.get("JEV_URL") or "https://generativelanguage.googleapis.com/v1beta/decisions"
    key = os.environ.get("JEV_API_KEY") or file_env.get("JEV_API_KEY") or ""
    model = os.environ.get("JEV_MODEL") or file_env.get("JEV_MODEL") or "gemini-decision-1"
    return {"url": url.strip(), "api_key": key.strip(), "model": model.strip()}


def atomic_write(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def load_replies() -> list:
    if not REPLIES_PATH.exists():
        return []
    rows = []
    with REPLIES_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def load_labels() -> dict:
    return load_json(LABELS_PATH, {})


def load_suggestions() -> dict:
    return load_json(SUGGESTIONS_PATH, {})


def load_prompt_config() -> dict:
    saved = load_json(PROMPT_CONFIG_PATH, {})
    cfg = dict(DEFAULT_PROMPT_CONFIG)
    if isinstance(saved, dict):
        if isinstance(saved.get("instructions"), str) and saved["instructions"].strip():
            cfg["instructions"] = saved["instructions"]
        if isinstance(saved.get("categories"), dict) and saved["categories"]:
            cfg["categories"] = saved["categories"]
        if isinstance(saved.get("threshold"), (int, float)):
            cfg["threshold"] = max(0.05, min(0.95, float(saved["threshold"])))
        if isinstance(saved.get("use_thread_context"), bool):
            cfg["use_thread_context"] = saved["use_thread_context"]
    cfg["schema_version"] = 1
    cfg["input_fields"] = list(DEFAULT_INPUT_FIELDS)
    return cfg


def save_prompt_config(patch: dict) -> dict:
    with FILE_LOCK:
        cfg = load_prompt_config()
        if "instructions" in patch and isinstance(patch["instructions"], str) and patch["instructions"].strip():
            cfg["instructions"] = patch["instructions"].strip()
        if "categories" in patch and isinstance(patch["categories"], dict):
            cfg["categories"] = patch["categories"]
        if "threshold" in patch and isinstance(patch["threshold"], (int, float)):
            cfg["threshold"] = round(max(0.05, min(0.95, float(patch["threshold"]))), 4)
        if "use_thread_context" in patch:
            cfg["use_thread_context"] = bool(patch["use_thread_context"])
        cfg["schema_version"] = 1
        cfg["input_fields"] = list(DEFAULT_INPUT_FIELDS)
        atomic_write(PROMPT_CONFIG_PATH, json.dumps(cfg, ensure_ascii=False, indent=2))
        return cfg


def save_labels_and_export(labels: dict):
    with FILE_LOCK:
        atomic_write(LABELS_PATH, json.dumps(labels, ensure_ascii=False, indent=2))
        replies = load_replies()
        out_lines = []
        for r in replies:
            rid = str(r.get("reply_id", ""))
            lb = labels.get(rid)
            if not lb:
                continue
            merged = dict(r)
            merged["sample_decision"] = lb.get("decision")
            merged["is_ai"] = lb.get("is_ai")
            merged["label_note"] = lb.get("note", "")
            merged["labeled_at"] = lb.get("labeled_at")
            out_lines.append(json.dumps(merged, ensure_ascii=False))
        atomic_write(LABELED_JSONL_PATH, "\n".join(out_lines) + ("\n" if out_lines else ""))


def save_suggestions_patch(patch: dict):
    with FILE_LOCK:
        cur = load_suggestions()
        cur.update(patch)
        atomic_write(SUGGESTIONS_PATH, json.dumps(cur, ensure_ascii=False, indent=2))


def build_single_input(item: dict, include_post: bool = True) -> str:
    a = item.get("author") or {}
    lines = [
        f"回复作者显示名: {a.get('name') or '(空)'}",
        f"回复作者 @handle: @{a.get('handle') or ''}",
        f"蓝V认证: {'是' if a.get('blue_verified') else '否'}",
        f"回复内容: {item.get('reply_text') or '(无文字，可能只有图片/视频/表情)'}",
        f"附带媒体: {'是' if item.get('has_media') else '否'}",
    ]
    if include_post and item.get("post_text"):
        lines.append(f"被回复的原帖内容: {str(item.get('post_text'))[:600]}")
    return "\n".join(lines)[:4000]


def build_thread_input(items: list, post_text: str) -> str:
    head = f"原帖内容: {(post_text or '(未知)')[:1000]}\n\n待探测的回复:\n"
    blocks = []
    for i, it in enumerate(items, 1):
        a = it.get("author") or {}
        parts = [
            f"[r{i}] 显示名: {a.get('name') or '(空)'} | @{a.get('handle') or ''} | 蓝V: {'是' if a.get('blue_verified') else '否'}",
            f"    回复: {it.get('reply_text') or '(无文字，可能只有图片/视频)'}",
            f"    附带媒体: {'是' if it.get('has_media') else '否'}",
        ]
        blocks.append("\n".join(parts))
    return (head + "\n".join(blocks))[:24000]


def is_input_blocked(err_msg: str) -> bool:
    return bool(re.search(r"http_400|Input blocked|sensitive words|Prohibited Use", str(err_msg or ""), re.I))


def call_decision_api(text_input: str, questions: dict, jev_env: dict, timeout: int = 25) -> dict:
    url = jev_env["url"]
    key = jev_env["api_key"]
    model = jev_env["model"]
    if not key or not url:
        raise RuntimeError("未配置 JEV_URL 或 JEV_API_KEY（请检查 labeler/.env）")

    is_gemini = "generativelanguage.googleapis.com" in url
    headers = {"Content-Type": "application/json"}
    if is_gemini:
        headers["x-goog-api-key"] = key
        payload = {"model": model, "input": text_input, "questions": questions}
    else:
        headers["Authorization"] = f"Bearer {key}"
        payload = {"model": model, "state": text_input, "questions": questions}

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    last_err = None
    for attempt in range(3):
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            err_body = ""
            try:
                err_body = e.read().decode("utf-8", errors="ignore")
            except Exception:
                pass
            if e.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(1.0 * (attempt + 1))
                last_err = f"http_{e.code} {err_body[:200]}"
                continue
            try:
                j = json.loads(err_body)
                msg = j.get("error", {}).get("message") if isinstance(j.get("error"), dict) else (j.get("error") or err_body[:200])
            except Exception:
                msg = err_body[:200]
            raise RuntimeError(f"http_{e.code} {msg}")
        except Exception as e:
            if attempt < 2:
                time.sleep(0.8 * (attempt + 1))
                last_err = str(e)
                continue
            raise RuntimeError(str(e))
    raise RuntimeError(last_err or "api_retry_exhausted")


def read_noul(ans):
    if isinstance(ans, (int, float)):
        return float(ans)
    if isinstance(ans, dict):
        for k in ("noul", "probability"):
            if isinstance(ans.get(k), (int, float)):
                return float(ans[k])
    return None


def read_choice(ans):
    if isinstance(ans, str):
        return ans
    if isinstance(ans, dict) and isinstance(ans.get("choice"), str):
        return ans["choice"]
    return None


def score_single_item(item: dict, prompt_cfg: dict, jev_env: dict) -> dict:
    questions = {
        "ai_slop": {"type": "noul", "instructions": prompt_cfg["instructions"]},
        "category": {"type": "choice", "instructions": "这条回复最符合哪一类？", "criteria": prompt_cfg["categories"]},
    }
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        text_in = build_single_input(item, include_post=True)
        resp = call_decision_api(text_in, questions, jev_env)
    except Exception as e:
        if is_input_blocked(str(e)):
            try:
                text_in = build_single_input(item, include_post=False)
                resp = call_decision_api(text_in, questions, jev_env)
            except Exception as e2:
                return {"score": None, "category": None, "error": str(e2), "model": jev_env["model"], "updated_at": now_iso}
        else:
            return {"score": None, "category": None, "error": str(e), "model": jev_env["model"], "updated_at": now_iso}

    answers = resp.get("answers") or resp.get("data", {}).get("answers") or {}
    score = read_noul(answers.get("ai_slop"))
    if score is None:
        return {"score": None, "category": None, "error": "bad_decision_response", "model": jev_env["model"], "updated_at": now_iso}
    cat = read_choice(answers.get("category"))
    return {
        "score": round(score, 4),
        "category": cat,
        "error": None,
        "model": resp.get("model") or jev_env["model"],
        "updated_at": now_iso,
    }


def score_group_items(items: list, prompt_cfg: dict, jev_env: dict, should_stop=None) -> dict:

    out = {}
    if not items or (should_stop and should_stop()):
        return out
    use_thread = prompt_cfg.get("use_thread_context", True) and len(items) > 1
    if not use_thread:
        for it in items:
            if should_stop and should_stop():
                break
            out[str(it["reply_id"])] = score_single_item(it, prompt_cfg, jev_env)
        return out

    post_text = items[0].get("post_text") or ""
    questions = {}
    for i in range(1, len(items) + 1):
        questions[f"r{i}"] = {
            "type": "noul",
            "instructions": f"针对回复 [r{i}]：\n" + prompt_cfg["instructions"],
        }
        questions[f"r{i}_cat"] = {
            "type": "choice",
            "instructions": f"回复 [r{i}] 最符合哪一类？",
            "criteria": prompt_cfg["categories"],
        }

    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        text_in = build_thread_input(items, post_text)
        resp = call_decision_api(text_in, questions, jev_env, timeout=30)
        answers = resp.get("answers") or resp.get("data", {}).get("answers") or {}
        model = resp.get("model") or jev_env["model"]
        for i, it in enumerate(items, 1):
            rid = str(it["reply_id"])
            sc = read_noul(answers.get(f"r{i}"))
            if sc is None:
                out[rid] = {"score": None, "category": None, "error": "bad_decision_response", "model": model, "updated_at": now_iso}
            else:
                out[rid] = {
                    "score": round(sc, 4),
                    "category": read_choice(answers.get(f"r{i}_cat")),
                    "error": None,
                    "model": model,
                    "updated_at": now_iso,
                }
        return out
    except Exception as e:
        if is_input_blocked(str(e)):
            for it in items:
                if should_stop and should_stop():
                    break
                out[str(it["reply_id"])] = score_single_item(it, prompt_cfg, jev_env)
            return out
        for it in items:
            out[str(it["reply_id"])] = {"score": None, "category": None, "error": str(e), "model": jev_env["model"], "updated_at": now_iso}
        return out


def chunk_by_post(items: list, batch_size: int = 12) -> list:
    by_post = {}
    for it in items:
        pid = str(it.get("post_id") or "")
        by_post.setdefault(pid, []).append(it)
    chunks = []
    for group in by_post.values():
        for i in range(0, len(group), batch_size):
            chunks.append(group[i:i + batch_size])
    return chunks


SUGGEST_JOB = {"running": False, "stop": False, "done": 0, "total": 0, "errors": 0, "last_error": None}
REGRESSION_JOB = {"running": False, "stop": False, "done": 0, "total": 0, "errors": 0, "last_error": None}


def run_suggest_batch(mode: str = "missing", account: str = "all", limit: int = 100, hide_op: bool = True):
    SUGGEST_JOB.update({"running": True, "stop": False, "done": 0, "total": 0, "errors": 0, "last_error": None})
    try:
        replies = load_replies()
        existing = load_suggestions()
        prompt_cfg = load_prompt_config()
        jev_env = get_jev_env()

        targets = []
        for r in replies:
            if account != "all" and r.get("target_account") != account:
                continue
            if hide_op and r.get("is_op_reply"):
                continue
            rid = str(r.get("reply_id", ""))
            if mode == "missing" and rid in existing and existing[rid].get("score") is not None:
                continue
            targets.append(r)
            if limit and limit > 0 and len(targets) >= limit:
                break

        SUGGEST_JOB["total"] = len(targets)
        chunks = chunk_by_post(targets, batch_size=12)

        pool = concurrent.futures.ThreadPoolExecutor(max_workers=3)
        try:
            futs = [pool.submit(score_group_items, ch, prompt_cfg, jev_env, lambda: SUGGEST_JOB["stop"]) for ch in chunks]
            for fut in concurrent.futures.as_completed(futs):
                if SUGGEST_JOB["stop"]:
                    for f in futs:
                        f.cancel()
                    break
                res_map = fut.result()
                if res_map:
                    save_suggestions_patch(res_map)
                    SUGGEST_JOB["done"] += len(res_map)
                    for v in res_map.values():
                        if v.get("error"):
                            SUGGEST_JOB["errors"] += 1
                            SUGGEST_JOB["last_error"] = v["error"]
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
    except Exception as e:
        SUGGEST_JOB["last_error"] = str(e)
    finally:
        SUGGEST_JOB["running"] = False


def run_regression_job(prompt_cfg: dict):
    REGRESSION_JOB.update({"running": True, "stop": False, "done": 0, "total": 0, "errors": 0, "last_error": None})
    t0 = time.time()
    try:
        replies = load_replies()
        labels = load_labels()
        jev_env = get_jev_env()

        targets = []
        for r in replies:
            rid = str(r.get("reply_id", ""))
            lb = labels.get(rid)
            if not lb or lb.get("decision") != "keep" or lb.get("is_ai") not in (True, False):
                continue
            targets.append((r, lb))

        REGRESSION_JOB["total"] = len(targets)
        chunks = chunk_by_post([t[0] for t in targets], batch_size=12)
        results_by_id = {}

        pool = concurrent.futures.ThreadPoolExecutor(max_workers=3)
        try:
            futs = [pool.submit(score_group_items, ch, prompt_cfg, jev_env, lambda: REGRESSION_JOB["stop"]) for ch in chunks]
            for fut in concurrent.futures.as_completed(futs):
                if REGRESSION_JOB["stop"]:
                    for f in futs:
                        f.cancel()
                    break
                res_map = fut.result()
                if res_map:
                    results_by_id.update(res_map)
                    REGRESSION_JOB["done"] += len(res_map)
                    for v in res_map.values():
                        if v.get("error"):
                            REGRESSION_JOB["errors"] += 1
                            REGRESSION_JOB["last_error"] = v["error"]
        finally:
            pool.shutdown(wait=False, cancel_futures=True)

        rows = []
        for r, lb in targets:
            rid = str(r.get("reply_id", ""))
            pred = results_by_id.get(rid) or {"score": None, "category": None, "error": "not_run"}
            rows.append({
                "reply_id": rid,
                "target_account": r.get("target_account"),
                "post_url": r.get("post_url"),
                "post_text": r.get("post_text"),
                "reply_url": r.get("reply_url"),
                "reply_text": r.get("reply_text"),
                "reply_created_at": r.get("reply_created_at"),
                "author": r.get("author"),
                "human_is_ai": bool(lb["is_ai"]),
                "label_note": lb.get("note", ""),
                "score": pred.get("score"),
                "category": pred.get("category"),
                "error": pred.get("error"),
            })

        report = {
            "ran_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "elapsed_sec": round(time.time() - t0, 2),
            "model": jev_env["model"],
            "jev_url": jev_env["url"],
            "prompt_config": prompt_cfg,
            "total": len(rows),
            "rows": rows,
        }
        with FILE_LOCK:
            atomic_write(REGRESSION_LATEST_PATH, json.dumps(report, ensure_ascii=False, indent=2))
    except Exception as e:
        REGRESSION_JOB["last_error"] = str(e)
    finally:
        REGRESSION_JOB["running"] = False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, path: Path):
        html = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.end_headers()
        self.wfile.write(html)

    def read_body_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            self.send_html(INDEX_HTML_PATH)
            return
        if parsed.path in ("/regression", "/regression.html"):
            self.send_html(REGRESSION_HTML_PATH)
            return

        if parsed.path == "/api/config":
            env = get_jev_env()
            self.send_json({
                "jev_url": env["url"],
                "jev_model": env["model"],
                "has_key": bool(env["api_key"]),
                "prompt_config": load_prompt_config(),
            })
            return

        if parsed.path == "/api/dataset":
            replies = load_replies()
            labels = load_labels()
            suggestions = load_suggestions()
            items = []
            for r in replies:
                rid = str(r.get("reply_id", ""))
                item = dict(r)
                item["label"] = labels.get(rid)
                item["suggestion"] = suggestions.get(rid)
                items.append(item)
            self.send_json({
                "items": items,
                "total": len(items),
                "labeledCount": len(labels),
                "suggestedCount": sum(1 for v in suggestions.values() if v.get("score") is not None),
                "prompt_config": load_prompt_config(),
            })
            return

        if parsed.path == "/api/suggest/status":
            self.send_json(dict(SUGGEST_JOB))
            return

        if parsed.path == "/api/regression/status":
            self.send_json({
                "job": dict(REGRESSION_JOB),
                "latest": load_json(REGRESSION_LATEST_PATH, None),
            })
            return

        if parsed.path == "/api/export":
            qs = parse_qs(parsed.query)
            mode = qs.get("mode", ["kept"])[0]
            replies = load_replies()
            labels = load_labels()
            suggestions = load_suggestions()
            lines = []
            for r in replies:
                rid = str(r.get("reply_id", ""))
                lb = labels.get(rid)
                sg = suggestions.get(rid)
                if mode == "kept" and (not lb or lb.get("decision") != "keep"):
                    continue
                if mode == "labeled" and not lb:
                    continue
                merged = dict(r)
                merged["sample_decision"] = lb.get("decision") if lb else None
                merged["is_ai"] = lb.get("is_ai") if lb else None
                merged["label_note"] = lb.get("note", "") if lb else ""
                merged["labeled_at"] = lb.get("labeled_at") if lb else None
                merged["jev_suggestion"] = sg
                lines.append(json.dumps(merged, ensure_ascii=False))
            body = ("\n".join(lines) + ("\n" if lines else "")).encode("utf-8")
            filename = f"anti-xai-{mode}.jsonl"
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_error(404)

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            payload = self.read_body_json()
        except Exception:
            self.send_json({"ok": False, "error": "invalid_json"}, 400)
            return

        if parsed.path == "/api/label":
            rid = str(payload.get("reply_id") or "").strip()
            if not rid:
                self.send_json({"ok": False, "error": "missing_reply_id"}, 400)
                return
            labels = load_labels()
            if payload.get("clear"):
                labels.pop(rid, None)
                save_labels_and_export(labels)
                self.send_json({"ok": True, "label": None})
                return
            decision = payload.get("decision")
            if decision not in ("keep", "discard"):
                self.send_json({"ok": False, "error": "invalid_decision"}, 400)
                return
            is_ai = payload.get("is_ai")
            if is_ai not in (True, False, None) or decision == "discard":
                is_ai = None
            entry = {
                "decision": decision,
                "is_ai": is_ai,
                "note": str(payload.get("note") or "").strip(),
                "labeled_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }
            labels[rid] = entry
            save_labels_and_export(labels)
            self.send_json({"ok": True, "label": entry})
            return

        if parsed.path == "/api/prompt":
            cfg = save_prompt_config(payload)
            self.send_json({"ok": True, "prompt_config": cfg})
            return

        if parsed.path == "/api/suggest":
            rids = payload.get("reply_ids") or ([payload.get("reply_id")] if payload.get("reply_id") else [])
            rids = {str(x) for x in rids if x}
            if not rids:
                self.send_json({"ok": False, "error": "missing_reply_id"}, 400)
                return
            replies = [r for r in load_replies() if str(r.get("reply_id", "")) in rids]
            if not replies:
                self.send_json({"ok": False, "error": "not_found"}, 404)
                return
            prompt_cfg = load_prompt_config()
            jev_env = get_jev_env()
            res_map = score_group_items(replies, prompt_cfg, jev_env)
            save_suggestions_patch(res_map)
            self.send_json({"ok": True, "results": res_map})
            return

        if parsed.path == "/api/suggest/batch":
            if SUGGEST_JOB["running"]:
                self.send_json({"ok": False, "error": "already_running", "job": dict(SUGGEST_JOB)}, 409)
                return
            mode = payload.get("mode", "missing")
            account = payload.get("account", "all")
            raw_limit = payload.get("limit", 100)
            limit = int(raw_limit) if isinstance(raw_limit, (int, float)) or (isinstance(raw_limit, str) and raw_limit.isdigit()) else 100
            hide_op = bool(payload.get("hide_op", True))
            threading.Thread(target=run_suggest_batch, args=(mode, account, limit, hide_op), daemon=True).start()
            self.send_json({"ok": True})
            return

        if parsed.path == "/api/suggest/stop":
            SUGGEST_JOB["stop"] = True
            SUGGEST_JOB["running"] = False
            self.send_json({"ok": True})
            return

        if parsed.path == "/api/regression/start":
            if REGRESSION_JOB["running"]:
                self.send_json({"ok": False, "error": "already_running", "job": dict(REGRESSION_JOB)}, 409)
                return

            cfg = save_prompt_config(payload) if any(k in payload for k in ("instructions", "categories", "threshold", "use_profile", "use_thread_context")) else load_prompt_config()
            threading.Thread(target=run_regression_job, args=(cfg,), daemon=True).start()
            self.send_json({"ok": True, "prompt_config": cfg})
            return

        if parsed.path == "/api/regression/stop":
            REGRESSION_JOB["stop"] = True
            REGRESSION_JOB["running"] = False
            self.send_json({"ok": True})
            return

        self.send_error(404)


def main():
    parser = argparse.ArgumentParser(description="Anti-XAI 数据集标注与回归验证服务")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    env = get_jev_env()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Anti-XAI Labeler running at http://{args.host}:{args.port}")
    print(f"  Labeling:   http://{args.host}:{args.port}/")
    print(f"  Regression: http://{args.host}:{args.port}/regression")
    print(f"  JEV_URL:    {env['url']} | JEV_MODEL: {env['model']} | KEY: {'OK' if env['api_key'] else 'MISSING'}")
    server.serve_forever()


if __name__ == "__main__":
    main()
