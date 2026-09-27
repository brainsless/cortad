# Loaded into your Python app by the command that started it (through PYTHONPATH), and only then.
# The same job as trace.cjs does for Node: it watches for a request to your app during which your
# app called a model. That request is your AI's door, with the exact body it takes and the sign-in
# it carried. What it sees is written to a file only you can read, in the command's own folder on
# this machine. Nothing here talks to a network, and nothing here may ever stop your app starting.
# ponytail: shadows a sitecustomize of the project's own, which is rare; chain to it if one shows up.
import os

_FILE = os.environ.get("CORTAD_TRACE_FILE")
_RULES = os.environ.get("CORTAD_RULES_FILE")
_WRITES = os.environ.get("CORTAD_WRITES_DIR")
_APP_ROOT = os.environ.get("CORTAD_APP_ROOT")


# What the app writes into its own folder while a run is on: each file copied once before its first
# write, so the command puts every one back when the run ends (lib/writes.mjs). Trials wrote carts
# and tickets into an app's data/*.json and the developer's own tests read them afterwards.
def _install_writes():
    import builtins
    import hashlib
    import io
    import json
    import re
    import shutil

    roots = {os.path.realpath(_APP_ROOT), os.path.abspath(_APP_ROOT)}
    not_data = re.compile(r"(?:^|/)(?:node_modules|\.git|\.next|\.cache|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|dist|build|coverage|\.cortad)(?:/|$)|\.(?:log|pyc|tmp|swp)$")
    state = {"run": None, "at": -1, "seen": set()}
    real_open = builtins.open
    real_os_open = os.open
    real_rename, real_replace, real_remove, real_unlink, real_truncate = os.rename, os.replace, os.remove, os.unlink, os.truncate

    # The run marker names the run; a new one starts the record over, none stops it.
    def run_now():
        try:
            marker = os.path.join(_WRITES, "run")
            at = os.stat(marker).st_mtime_ns
            if at != state["at"]:
                state["at"] = at
                with real_open(marker, encoding="utf-8") as f:
                    state["run"] = f.read().strip()
                state["seen"] = set()
            return state["run"]
        except Exception:
            state["run"], state["at"], state["seen"] = None, -1, set()
            return None

    def note(target):
        try:
            if isinstance(target, int) or target is None:
                return
            path = os.fspath(target)
            if isinstance(path, bytes):
                path = path.decode("utf-8", "replace")
            ab = os.path.abspath(path)
            root = next((r for r in roots if ab.startswith(r + os.sep)), None)
            if root is None:
                return
            rel = os.path.relpath(ab, root)
            if not_data.search(rel):
                return
            run = run_now()
            if not run or rel in state["seen"]:
                return
            state["seen"].add(rel)
            before = None
            if os.path.isfile(ab):
                before = os.path.join(_WRITES, "before", hashlib.sha1(rel.encode("utf-8")).hexdigest())
                os.makedirs(os.path.dirname(before), mode=0o700, exist_ok=True)
                shutil.copyfile(ab, before)
            fd = real_os_open(os.path.join(_WRITES, "written.jsonl"), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as f:
                f.write(json.dumps({"run": run, "path": rel, "before": before}) + "\n")
        except Exception:
            pass

    def opened(file, mode="r", *a, **kw):
        m = kw.get("mode", mode)
        if isinstance(m, str) and any(c in m for c in "wax+"):
            note(file)
        return real_open(file, mode, *a, **kw)

    def os_opened(path, flags, mode=0o777, *a, **kw):
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_TRUNC | os.O_CREAT):
            note(path)
        return real_os_open(path, flags, mode, *a, **kw)

    def two(orig):
        def moved(src, dst, *a, **kw):
            note(src)
            note(dst)
            return orig(src, dst, *a, **kw)
        return moved

    def one(orig):
        def gone(path, *a, **kw):
            note(path)
            return orig(path, *a, **kw)
        return gone

    builtins.open = opened
    io.open = opened
    os.open = os_opened
    os.rename, os.replace = two(real_rename), two(real_replace)
    os.remove, os.unlink, os.truncate = one(real_remove), one(real_unlink), one(real_truncate)


def _install():
    import contextvars
    import importlib.abc
    import importlib.util
    import json
    import re
    import sys
    import time
    from urllib.parse import urlsplit

    ctx = contextvars.ContextVar("cortad_request", default=None)
    limit = 65536
    said = set()
    model_host = re.compile(r"(?:^|\.)(?:openai\.com|anthropic\.com|fireworks\.ai|openrouter\.ai|groq\.com|mistral\.ai|together\.xyz|together\.ai|deepseek\.com|cohere\.ai|cohere\.com|perplexity\.ai|x\.ai|openai\.azure\.com|cognitiveservices\.azure\.com|replicate\.com|huggingface\.co|cerebras\.ai|deepinfra\.com|novita\.ai|moonshot\.cn|dashscope\.aliyuncs\.com|bigmodel\.cn|ai-gateway\.vercel\.sh|gateway\.ai\.cloudflare\.com|helicone\.ai|portkey\.ai)$", re.I)
    model_path = re.compile(r"/(?:chat/completions|completions|responses|messages|embeddings)$|:(?:generateContent|streamGenerateContent)|/invoke(?:-with-response-stream)?$|/api/(?:chat|generate)$", re.I)

    # The turn a message came in under, when the run tagged it (one opaque id per request), so a
    # model call and its prompt can be pinned to the reply they produced while turns overlap.
    turn_ok = re.compile(r"^[A-Za-z0-9:_.-]{1,80}$")

    def turn_now():
        req = ctx.get()
        return req.get("turn") if req else None

    # The customer's own rule sentences, written beside the trace by the run, so each model call can
    # say which of them its prompt carried. Absent file, nothing is claimed. Reloaded on change.
    rules_at = [-1.0]
    rules = [None]
    slot = re.compile(r"\{[^}]*\}|\$\{[^}]*\}|%[sd]|<[^>]{1,40}>")

    def norm(s):
        s = str(s or "")
        s = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), s)
        s = re.sub(r"\\[nrt]", " ", s).replace('\\"', '"').replace("\\\\", "\\")
        return re.sub(r"\s+", " ", s.lower()).strip()

    def rules_now():
        if not _RULES:
            return None
        try:
            at = os.stat(_RULES).st_mtime
            if at != rules_at[0]:
                rules_at[0] = at
                with open(_RULES, encoding="utf-8") as f:
                    raw = json.load(f)
                out = []
                for r in raw if isinstance(raw, list) else []:
                    if not isinstance(r, dict) or not isinstance(r.get("id"), str) or not isinstance(r.get("text"), str):
                        continue
                    parts = [p for p in (norm(x) for x in slot.split(r["text"])) if len(p) >= 12]
                    if parts:
                        out.append((r["id"], parts))
                rules[0] = out
        except Exception:
            pass
        return rules[0]

    # What the app's tools answered, as the prompt of the next model call carries them (chat tool
    # messages, responses function outputs, Anthropic tool_result blocks, Gemini functionResponse
    # parts): the material a reply's facts rest on. Bounded per call.
    tool_text, tools_max = 3000, 12

    def text_of(v):
        if isinstance(v, str):
            return v
        if isinstance(v, list):
            return "\n".join(p for p in ((x.get("text") or x.get("content") or "") if isinstance(x, dict) else str(x or "") for x in v) if p)
        if isinstance(v, dict):
            try:
                return json.dumps(v, ensure_ascii=False)
            except (TypeError, ValueError):
                return ""
        return ""

    def items(v):
        return [x for x in v if isinstance(x, dict)] if isinstance(v, list) else []

    # Only what came after the person's latest message belongs to this turn: a thread the app
    # resends whole carries every earlier turn's tool answers too.
    def since(seq, is_person):
        at = -1
        for i, m in enumerate(seq):
            if is_person(m):
                at = i
        return seq[at + 1:]

    # A user message that only hands a tool's answer back ("Observation: ...", <tool_response>) is
    # the agent loop talking, not the person.
    handed_back = re.compile(r"^\s*(?:Observation\s*:|<(?:tool_response|tool_result|function_results?)>)", re.I)

    def person_said(m):
        return m.get("role") == "user" and not any(isinstance(c, dict) and c.get("type") == "tool_result" for c in (m.get("content") if isinstance(m.get("content"), list) else [])) and not handed_back.match(text_of(m.get("content")))

    def person_asked(c):
        return c.get("role") == "user" and not any(p.get("functionResponse") for p in items(c.get("parts")))

    def tools_in(sent):
        body = parsed(sent) if isinstance(sent, str) else None
        if not isinstance(body, dict):
            return None
        out, names = [], {}

        def add(name, text):
            t = text_of(text)[:tool_text]
            if t.strip() and len(out) < tools_max and all(o["text"] != t for o in out):
                out.append({"name": str(name or "")[:80], "text": t})

        messages = items(body.get("messages"))
        for m in messages:
            for c in items(m.get("tool_calls")):
                if c.get("id") and isinstance(c.get("function"), dict):
                    names[c["id"]] = c["function"].get("name")
            for c in items(m.get("content")):
                if c.get("type") == "tool_use" and c.get("id"):
                    names[c["id"]] = c.get("name")
        for m in since(messages, person_said):
            if m.get("role") in ("tool", "function"):
                add(m.get("name") or names.get(m.get("tool_call_id")), m.get("content"))
            for c in items(m.get("content")):
                if c.get("type") == "tool_result":
                    add(names.get(c.get("tool_use_id")), c.get("content"))
        inputs = items(body.get("input"))
        for it in inputs:
            if it.get("type") == "function_call" and it.get("call_id"):
                names[it["call_id"]] = it.get("name")
        for it in since(inputs, lambda x: x.get("role") == "user"):
            if it.get("type") == "function_call_output":
                add(names.get(it.get("call_id")), it.get("output"))
        for c in since(items(body.get("contents")), person_asked):
            for p in items(c.get("parts")):
                if isinstance(p.get("functionResponse"), dict):
                    add(p["functionResponse"].get("name"), p["functionResponse"].get("response"))
        declared = declared_in(body)
        for name, said in observed_in(turn_texts(body, True, declared), declared):
            add(name, said)
        return out or None

    # What the model asked the app to run: chat tool_calls (a stream's pieces joined by position), a
    # legacy function_call, a responses function_call item, an Anthropic or Bedrock tool use, a
    # Gemini functionCall. Read off the model's reply, and off this turn's earlier calls as the
    # prompt resends them. Names and arguments only: every value clipped, a secret never written.
    calls_max, value_max, args_max = 12, 200, 1200
    secret_key = re.compile(r"(?:^|_)(?:pass(?:word|phrase)?|secret|token|api_?key|authorization|cookie|session(?:_id)?|credentials?|private_key)$")
    secret_value = re.compile(r"^(?:Bearer\s|Basic\s|sk-|pk_|rk_|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|AIza|eyJ[\w-]{10,}\.)")

    def clipped(v, depth=0, most=value_max):
        if isinstance(v, str):
            return "[secret]" if secret_value.match(v) else (v[:most] + "…" if len(v) > most else v)
        if isinstance(v, list):
            return [] if depth > 4 else [clipped(x, depth + 1, most) for x in v[:20]]
        if isinstance(v, dict):
            if depth > 4:
                return {}
            return {k: ("[secret]" if secret_key.search(re.sub(r"([a-z])([A-Z])", r"\1_\2", str(k)).lower()) else clipped(x, depth + 1, most)) for k, x in list(v.items())[:40]}
        return v

    def args_text(raw):
        v = raw
        if isinstance(raw, str):
            v = parsed(raw) if raw.strip() else {}
            if v is None:
                v = raw
        return json.dumps(clipped({} if v is None else v), ensure_ascii=False, separators=(",", ":"))[:args_max]

    def calls_of(events):
        whole, parts, n = {}, {}, [0]

        def put(key, name, args):
            if name:
                if not key:
                    n[0] += 1
                    key = "w%d" % n[0]
                whole[key] = (name, args)

        def piece(key, name, args):
            p = parts.setdefault(key, ["", ""])
            if name and not p[0]:
                p[0] = name
            if isinstance(args, str):
                p[1] += args

        def blocks(content):
            for b in items(content):
                if b.get("type") == "tool_use":
                    put(b.get("id"), b.get("name"), b.get("input"))
                if isinstance(b.get("toolUse"), dict):
                    put(b["toolUse"].get("toolUseId"), b["toolUse"].get("name"), b["toolUse"].get("input"))

        for e in events:
            if not isinstance(e, dict):
                continue
            for c in items(e.get("choices")):
                m = c.get("message") if isinstance(c.get("message"), dict) else None
                if m:
                    for t in items(m.get("tool_calls")):
                        f = t.get("function") if isinstance(t.get("function"), dict) else None
                        if f:
                            put(t.get("id"), f.get("name"), f.get("arguments"))
                    if isinstance(m.get("function_call"), dict):
                        put(None, m["function_call"].get("name"), m["function_call"].get("arguments"))
                d = c.get("delta") if isinstance(c.get("delta"), dict) else None
                if d:
                    for t in items(d.get("tool_calls")):
                        f = t.get("function") if isinstance(t.get("function"), dict) else {}
                        piece("c%s.%s" % (c.get("index") or 0, t.get("index", t.get("id"))), f.get("name"), f.get("arguments"))
                    if isinstance(d.get("function_call"), dict):
                        piece("f%s" % (c.get("index") or 0), d["function_call"].get("name"), d["function_call"].get("arguments"))
            resp = e.get("response") if isinstance(e.get("response"), dict) else {}
            for it in items(e.get("output")) + items([e.get("item")]) + items(resp.get("output")):
                if it.get("type") == "function_call":
                    put(it.get("call_id") or it.get("id"), it.get("name"), it.get("arguments"))
            blocks(e.get("content"))
            if isinstance(e.get("message"), dict):
                blocks(e["message"].get("content"))
            if isinstance(e.get("output"), dict) and isinstance(e["output"].get("message"), dict):
                blocks(e["output"]["message"].get("content"))
            cb = e.get("content_block") if isinstance(e.get("content_block"), dict) else {}
            if e.get("type") == "content_block_start" and cb.get("type") == "tool_use":
                piece("a%s" % e.get("index"), cb.get("name"), "")
            delta = e.get("delta") if isinstance(e.get("delta"), dict) else {}
            if e.get("type") == "content_block_delta" and delta.get("type") == "input_json_delta":
                piece("a%s" % e.get("index"), "", delta.get("partial_json"))
            for c in items(e.get("candidates")):
                for p in items((c.get("content") or {}).get("parts") if isinstance(c.get("content"), dict) else None):
                    if isinstance(p.get("functionCall"), dict):
                        put(None, p["functionCall"].get("name"), p["functionCall"].get("args"))
        found = list(whole.values()) + [tuple(p) for p in parts.values()]
        return [{"name": str(name)[:80], "arguments": args_text(args)} for name, args in found if name]

    # This turn's earlier calls, as the prompt resends them after the person's latest message.
    def called_before(body):
        events = []
        for m in since(items(body.get("messages")), person_said):
            if m.get("role") == "assistant":
                events.append({"choices": [{"message": m}], "content": m.get("content")})
        events.append({"output": since(items(body.get("input")), lambda x: x.get("role") == "user")})
        for c in since(items(body.get("contents")), person_asked):
            if c.get("role") == "model":
                events.append({"candidates": [{"content": c}]})
        return calls_of(events)

    # Tool use a model writes in its words instead of as a structured call. A ReAct agent (CrewAI,
    # LangChain) writes "Action: name" then "Action Input: {...}" and is handed "Observation: ..."
    # back in its next prompt; others write <tool_call>{...}</tool_call>, <function=name>,
    # <invoke name="..."> or a JSON object that names the tool. A name counts only when the request
    # declares that tool, in its tools field or in the tool list its prompt carries, so a thought, a
    # "Final Answer" or prose that says Action is never a call.
    final = re.compile(r"final[\s_-]*answer", re.I)
    tool_name = re.compile(r"[A-Za-z_][\w.-]{0,79}", re.A)

    def prompt_text(body):
        inp = body.get("input")
        return "\n".join(
            [text_of(m.get("content")) for m in items(body.get("messages")) if m.get("role") != "assistant"]
            + [text_of(body.get("system")), text_of(body.get("instructions")), body.get("prompt") if isinstance(body.get("prompt"), str) else "", inp if isinstance(inp, str) else ""]
            + [text_of(x.get("content")) for x in items(inp) if x.get("role") and x.get("role") != "assistant"]
            + [text_of((body.get("systemInstruction") or {}).get("parts") if isinstance(body.get("systemInstruction"), dict) else None)]
            + [text_of(c.get("parts")) for c in items(body.get("contents")) if c.get("role") != "model"])

    def declared_in(body):
        out = set()

        def add(n):
            v = n.strip().strip("\"'`") if isinstance(n, str) else ""
            if tool_name.fullmatch(v) and not final.fullmatch(v):
                out.add(v)

        def get(d, k):
            return d.get(k) if isinstance(d, dict) else None

        for t in items(body.get("tools")):
            add(t.get("name"))
            add(get(t.get("function"), "name"))
            add(get(t.get("toolSpec"), "name"))
            for d in items(t.get("functionDeclarations") or t.get("function_declarations")):
                add(d.get("name"))
        for f in items(body.get("functions")):
            add(f.get("name"))
        for t in items(get(body.get("toolConfig"), "tools")):
            add(get(t.get("toolSpec"), "name"))
        text = prompt_text(body)[:200000]
        for m in re.finditer(r"^[ \t]*Tool Name:[ \t]*([^\n]+)", text, re.I | re.M):
            add(m.group(1))
        for m in re.finditer(r"\b(?:one of|name of|names? from)[ \t]*\[([^\]\n]{1,2000})\]", text, re.I):
            for x in m.group(1).split(","):
                add(x)
        for m in re.finditer(r"valid \"?action\"? values?:?[ \t]*([^\n]{1,2000})", text, re.I):
            for x in re.split(r",|\bor\b", m.group(1)):
                add(x)
        for m in re.finditer(r"<(tools|functions)>([\s\S]*?)</\1>", text, re.I):
            for k in re.finditer(r"\"name\"\s*:\s*\"([^\"]+)\"", m.group(2)):
                add(k.group(1))
        for m in re.finditer(r"\"name\"\s*:\s*\"([^\"]+)\"\s*,\s*\"(?:description|parameters|input_schema)\"", text):
            add(m.group(1))
        for m in re.finditer(r"<(?:tool|function)\s+name\s*=\s*[\"']([^\"']+)[\"']", text, re.I):
            add(m.group(1))
        return out

    react = re.compile(r"(?:^|\n)[ \t>*_#]*Action[ \t]*\d*[ \t*_]*:[ \t*_`]*([^\n`*]*?)[ \t*_`]*\n+[ \t>*_#]*Action[ \t]*\d*[ \t_]*Input[ \t*_]*:[ \t*_]*([\s\S]*?)(?=\n[ \t>*_#]*(?:Observation|Thought|Final[ \t]*Answer|Action)\b|\x00|\Z)", re.I)
    tag_call = re.compile(r"<(tool_call|function_call|tool_use)>([\s\S]*?)</\1>", re.I)
    fn_tag = re.compile(r"<function=([\w.-]+)>([\s\S]*?)</function>", re.I)
    invoke = re.compile(r"<invoke\s+name\s*=\s*[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)</invoke>", re.I)
    observed = re.compile(r"(?:^|\n)[ \t>*_]*Observation[ \t*_]*:[ \t]*([\s\S]*?)(?=\n[ \t>*_#]*(?:Thought|Action|Final[ \t]*Answer)\b|\x00|\Z)|<(tool_response|tool_result|function_results?|observation)>([\s\S]*?)</\2>", re.I)

    def params_of(s):
        return {m.group(1): m.group(2).strip() for m in re.finditer(r"<parameter(?:=|\s+name\s*=\s*[\"'])([\w.-]+)[\"']?\s*>([\s\S]*?)</parameter>", s, re.I)}

    # Each balanced JSON object in the text, outermost first; its insides are not read again.
    def objects_in(text):
        out, i = [], text.find("{")
        while i != -1 and len(out) < 20:
            depth, in_str, esc, end = 0, False, False, -1
            for j in range(i, min(len(text), i + 20000)):
                ch = text[j]
                if in_str:
                    if esc:
                        esc = False
                    elif ch == "\\":
                        esc = True
                    elif ch == '"':
                        in_str = False
                    continue
                if ch == '"':
                    in_str = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        end = j
                        break
            v = parsed(text[i:end + 1]) if end != -1 else None
            if isinstance(v, dict):
                out.append((i, v))
                i = end
            i = text.find("{", i + 1)
        return out

    # An Action Input that opens with a JSON object is that object: a model that runs on past it
    # ("Observ: ...") does not put its own invention into the arguments.
    def leading_json(s):
        t = s.strip()
        o = objects_in(t)[:1] if t.startswith("{") else []
        return o[0][1] if o and o[0][0] == 0 else t

    # A tool's schema carries a description; a call does not.
    def json_call(v):
        f = v["function"] if isinstance(v.get("function"), dict) else v
        if "description" in f:
            return None
        name = next((x for x in (f.get("name"), v.get("tool"), v.get("tool_name"), v.get("action"), v.get("function") if isinstance(v.get("function"), str) else None) if isinstance(x, str)), None)
        if not name:
            return None
        args = next((x for x in (f.get("arguments"), f.get("args"), f.get("parameters"), v.get("action_input"), v.get("tool_input"), v.get("input"), v.get("args"), v.get("arguments"), v.get("parameters")) if x is not None), None)
        return name, args

    def written_calls(text, declared):
        found = []
        if not text or not declared:
            return found
        s = text[:50000]

        def take(at, name, args):
            n = str(name or "").strip()
            if n in declared:
                found.append((at, n, args.strip() if isinstance(args, str) else args))

        for m in react.finditer(s):
            take(m.start(), m.group(1), leading_json(m.group(2)))
        for m in tag_call.finditer(s):
            v = parsed(m.group(2).strip())
            c = json_call(v) if isinstance(v, dict) else None
            if c:
                take(m.start(), *c)
        for m in fn_tag.finditer(s):
            v = parsed(m.group(2).strip())
            take(m.start(), m.group(1), v if isinstance(v, (dict, list)) else params_of(m.group(2)))
        for m in invoke.finditer(s):
            take(m.start(), m.group(1), params_of(m.group(2)))
        for at, v in objects_in(s):
            c = json_call(v)
            if c:
                take(at, *c)
        return sorted(found, key=lambda c: c[0])

    # What a tool answered, named by the call written just before it.
    def observed_in(text, declared):
        s = str(text or "")[:50000]
        calls = written_calls(s, declared)
        out = []
        if calls:
            for m in observed.finditer(s):
                before = [c for c in calls if c[0] < m.start()]
                if before:
                    out.append((before[-1][1], (m.group(1) if m.group(1) is not None else m.group(3)).strip()))
        return out

    # The model's own words: the text it answered, whole or streamed, in every provider's shape.
    def reply_text(events):
        s = []
        for e in events:
            if not isinstance(e, dict):
                continue
            for c in items(e.get("choices")):
                if isinstance(c.get("message"), dict):
                    s.append(text_of(c["message"].get("content")))
                if isinstance(c.get("delta"), dict) and isinstance(c["delta"].get("content"), str):
                    s.append(c["delta"]["content"])
                if isinstance(c.get("text"), str):
                    s.append(c["text"])
            if e.get("type") == "response.output_text.delta" and isinstance(e.get("delta"), str):
                s.append(e["delta"])
            resp = e.get("response") if isinstance(e.get("response"), dict) else {}
            for it in items(e.get("output")) + items(resp.get("output")):
                if it.get("type") == "message":
                    s.extend(p["text"] for p in items(it.get("content")) if isinstance(p.get("text"), str))
            delta = e.get("delta") if isinstance(e.get("delta"), dict) else {}
            if e.get("type") == "content_block_delta" and isinstance(delta.get("text"), str):
                s.append(delta["text"])
            msg = e.get("message") if isinstance(e.get("message"), dict) else {}
            out_msg = e["output"].get("message") if isinstance(e.get("output"), dict) and isinstance(e["output"].get("message"), dict) else {}
            for b in items(e.get("content")) + items(msg.get("content")) + items(out_msg.get("content")):
                if isinstance(b.get("text"), str):
                    s.append(b["text"])
            if isinstance(msg.get("content"), str) and not e.get("choices"):
                s.append(msg["content"])
            for c in items(e.get("candidates")):
                for p in items((c.get("content") or {}).get("parts") if isinstance(c.get("content"), dict) else None):
                    if isinstance(p.get("text"), str) and not p.get("thought"):
                        s.append(p["text"])
            if isinstance(e.get("response"), str):
                s.append(e["response"])
        return "".join(s)

    # This turn as the prompt carries it: the model's earlier words after the person's latest
    # message, and everything from that message on, where a single-prompt agent keeps its scratchpad.
    # A user message right after the model wrote a tool call is the agent loop's nudge ("Analyze the
    # tool result"), never the person: after a call, only the loop speaks.
    def turn_texts(body, with_person, declared):
        def since_person(seq, is_person):
            at = -1
            for i, m in enumerate(seq):
                if is_person(m):
                    at = i
            return seq[max(0, at):] if with_person else seq[at + 1:]

        def ours(role):
            return role not in ("system", "developer") if with_person else role in ("assistant", "model")

        inp = body.get("input")
        ms = items(body.get("messages"))
        after_call = {i for i in range(1, len(ms)) if ms[i - 1].get("role") == "assistant" and written_calls(text_of(ms[i - 1].get("content")), declared)}
        out = [text_of(m.get("content")) for m in since_person([dict(m, _i=i) for i, m in enumerate(ms)], lambda m: person_said(m) and m["_i"] not in after_call) if ours(m.get("role"))]
        out += [text_of(x.get("content") if x.get("content") is not None else x.get("output")) for x in since_person(items(inp), lambda x: x.get("role") == "user") if ours(x.get("role"))]
        out += [text_of(c.get("parts")) for c in since_person(items(body.get("contents")), person_asked) if ours(c.get("role"))]
        if with_person:
            out += [body.get("prompt") if isinstance(body.get("prompt"), str) else "", inp if isinstance(inp, str) else ""]
        return "\x00\n".join(out)

    def called_in(sent, events):
        body = parsed(sent) if isinstance(sent, str) else None
        out = []
        declared = declared_in(body) if isinstance(body, dict) else set()
        written = [{"name": n, "arguments": args_text(a)} for _, n, a in written_calls(turn_texts(body, False, declared) if isinstance(body, dict) else "", declared) + written_calls(reply_text(events), declared)]
        for c in (called_before(body) if isinstance(body, dict) else []) + calls_of(events) + written:
            if len(out) < calls_max and not any(o["name"] == c["name"] and o["arguments"] == c["arguments"] for o in out):
                out.append(c)
        return out or None

    # The passages the prompt carried as retrieved context: a block the app itself labels as
    # context, documents, knowledge, sources or search results, in its system prompt or from the
    # person's latest message on, and Anthropic document and search_result blocks. The app's own
    # instructions are not passages: only what sits under such a label is.
    passage_text, passages_max = 3000, 6
    material = re.compile(r"\b(?:retriev\w*|context|knowledge|documents?|sources?|search[ _-]?results?|references?|passages?|excerpts?|snippets?|chunks?|background|faq)\b|检索|知识|参考资料|资料|上下文|文档|背景", re.I)
    heading = re.compile(r"^\s*(?:#{1,6}\s+[^\n]{1,80}|[^\n]{1,80}[:：]\s*(?:\([^\n)]*\))?|\[[^\n\]]{1,80}\]|={2,}\s*[^\n]{1,80}?\s*={2,})\s*$")
    # An inline label is a noun phrase that ends in the material word ("context:", "background:",
    # "retrieved passages:"): "4. Knowledge:" in a numbered instruction and a JSON key are not.
    inline = re.compile(r"^\s*(?:[-*]\s+)?([A-Za-z\u4e00-\u9fff][A-Za-z\u4e00-\u9fff '’_-]{0,29})[:：]\s*\S")
    named = re.compile(r"(?:" + material.pattern + r")\s*$", re.I)
    tagged = re.compile(r"<([A-Za-z][\w-]*)[^>]*>([\s\S]*?)</\1>")

    def labelled(text, add):
        def lift(m):
            if material.search(m.group(1).replace("_", " ")):
                add(m.group(1), m.group(2))
                return ""
            return m.group(0)
        paras = re.split(r"\n\s*\n", tagged.sub(lift, str(text or "")))
        i = 0
        while i < len(paras):
            lines = paras[i].split("\n")
            head = lines[0]
            if heading.match(head) and material.search(head):
                body = "\n".join(lines[1:])
                # A heading alone on its paragraph labels what follows, up to the next heading.
                if not body.strip():
                    while i + 1 < len(paras) and len(body) < passage_text and not heading.match(paras[i + 1].split("\n")[0]):
                        i += 1
                        body += ("\n\n" if body else "") + paras[i]
                add(re.sub(r"[#:：\[\]=]", "", head).strip(), body)
            else:
                label = next((m for m in (inline.match(l) for l in lines) if m and named.search(m.group(1))), None)
                if label:
                    add(label.group(1).strip(), paras[i])
            i += 1

    def passages_in(sent):
        body = parsed(sent) if isinstance(sent, str) else None
        if not isinstance(body, dict):
            return None
        out = []

        def add(name, text):
            t = str(text or "").strip()[:passage_text]
            if len(t) >= 20 and len(out) < passages_max and all(o["text"] != t for o in out):
                out.append({"name": str(name or "")[:80], "text": t})

        def scan(content):
            if isinstance(content, str):
                return labelled(content, add)
            for b in items(content):
                if b.get("type") == "document":
                    src = b.get("source") if isinstance(b.get("source"), dict) else None
                    add(b.get("title") or "document", text_of(src.get("data") if src and src.get("data") is not None else (src or {}).get("content")) if src else text_of(b.get("content")))
                elif b.get("type") == "search_result":
                    add(b.get("title") or b.get("source") or "search result", text_of(b.get("content")))
                elif isinstance(b.get("text"), str):
                    labelled(b["text"], add)

        messages = items(body.get("messages"))
        for m in messages:
            if m.get("role") in ("system", "developer"):
                scan(m.get("content"))
        last = max([i for i, m in enumerate(messages) if person_said(m)] or [0])
        for m in messages[last:]:
            if m.get("role") == "user":
                scan(m.get("content"))
        scan(body.get("system"))
        scan(body.get("instructions"))
        if isinstance(body.get("systemInstruction"), dict):
            scan(body["systemInstruction"].get("parts"))
        inputs = [{"role": "user", "content": body["input"]}] if isinstance(body.get("input"), str) else items(body.get("input"))
        last = max([i for i, it in enumerate(inputs) if it.get("role") == "user"] or [0])
        for it in inputs[last:]:
            if it.get("role") in ("user", "system", "developer"):
                scan(it.get("content"))
        return out or None

    # The passages a retrieval call answered with: a vector store, a search index or a web search,
    # read off its reply when it is JSON. Text fields only, bounded like the rest.
    retrieval_host = re.compile(r"pinecone\.io|qdrant|weaviate|chroma|zilliz|milvus|turbopuffer|upstash\.io|algolia|typesense|meilisearch|elastic|opensearch|vespa|tavily\.com|exa\.ai|serper\.dev|serpapi\.com|search\.brave\.com|bing\.microsoft\.com|jina\.ai", re.I)
    retrieval_path = re.compile(r"/(?:query|search|_search|retrieve|similarity_search|rerank|hybrid)(?:/|$)|/points/(?:search|query)|/rpc/match\w*", re.I)
    passage_key = re.compile(r"^(?:text|content|page_?content|pageContent|chunk|snippet|passage|body|document|documents|description|answer|raw_content|highlights?|excerpt)$", re.I)

    def is_retrieval(url):
        try:
            parts = urlsplit(str(url))
        except ValueError:
            return False
        return bool(retrieval_host.search(parts.hostname or "")) or bool(retrieval_path.search(parts.path or ""))

    def passages_from(raw):
        out, nodes = [], [0]

        def walk(v, key, depth):
            nodes[0] += 1
            if len(out) >= passages_max or depth > 7 or nodes[0] > 4000:
                return
            if isinstance(v, str):
                t = v.strip()[:passage_text]
                if passage_key.match(key) and len(t) >= 20 and all(o["text"] != t for o in out):
                    out.append({"name": key, "text": t})
            elif isinstance(v, list):
                for x in v:
                    walk(x, key, depth + 1)
            elif isinstance(v, dict):
                for k, x in v.items():
                    walk(x, str(k), depth + 1)
        walk(parsed(raw) if isinstance(raw, str) else None, "", 0)
        return out or None

    def rules_in(sent):
        found = rules_now()
        if found is None:
            return None
        body = norm(sent)
        return [rid for rid, parts in found if all(p in body for p in parts)]

    # Every value this file writes passes one mask, whichever path wrote it: a key inside a value
    # ("sk-...", a bearer token, a JWT) and what anyone wrote after "password is" or "token:". The
    # door row's sign-in headers are kept on purpose: the command replays them from this machine.
    secret_text = [
        re.compile(r"""((?:pass(?:word|phrase|wd)|pwd|密码|口令)["']?\s*(?:is\b|was\b|[:=：]|是|为)\s*["']?)([^\s"'\\,;}，。；、]+)""", re.I),
        re.compile(r"""((?:secret(?:[ _-]?key)?|api[ _-]?key|apikey|access[ _-]?key|private[ _-]?key|client[ _-]?secret|(?:auth|access|refresh)[ _-]?token|token)["']?\s*[:=：]\s*["']?)([^\s"'\\,;}，。；、]+)""", re.I),
    ]
    secret_word = re.compile(r"\b(?:Bearer\s+(?=[\w.~+/=-]*\d)[\w.~+/=-]{16,}|[spr]k[-_](?=[\w-]*\d)[\w-]{8,}|gh[po]_\w{16,}|github_pat_\w{16,}|xox[abpr]-[\w-]{8,}|AKIA[0-9A-Z]{12,}|AIza[\w-]{20,}|eyJ[\w-]{10,}\.[\w-]{4,}\.[\w-]*)", re.A)

    def mask_text(t):
        for pattern in secret_text:
            t = pattern.sub(r"\1[secret]", t)
        return secret_word.sub("[secret]", t)

    def scrub(v, depth=0):
        if isinstance(v, str):
            return mask_text(v)
        if isinstance(v, (list, tuple)):
            return [scrub(x, depth + 1) for x in v]
        if isinstance(v, dict) and depth < 12:
            return {k: (x if k == "headers" and depth == 0 else scrub(x, depth + 1)) for k, x in v.items()}
        return v

    # A door's body goes up to the run as JSON, so it is masked as JSON: its string values, never its shape.
    def body_scrubbed(raw):
        b = parsed(raw)
        return json.dumps(scrub(b), ensure_ascii=False) if isinstance(b, (dict, list)) else mask_text(raw)

    def write(row):
        try:
            if not (row.get("hello") or row.get("listen") or row.get("routes")):
                out = scrub(row)
                if isinstance(row.get("body"), str):
                    out["body"] = body_scrubbed(row["body"])
                row = out
            fd = os.open(_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
        except Exception:
            pass

    # Every other outbound call: the host and what it answered, never a byte of it. A search
    # provider over its limit for a whole run was invisible until this row existed.
    # A store on this machine (a local Qdrant or Chroma) is said too when it answered with passages.
    def dep(url, status, code=None, passages=None, turn=None):
        try:
            host = (urlsplit(str(url)).hostname or "").lower()
            if not host or (host in ("localhost", "127.0.0.1", "::1") and not passages):
                return
            turn = turn or turn_now()
            write({"dep": {"at": int(time.time() * 1000), "host": host[:253], "status": int(status or 0), **({"code": str(code)[:40]} if code else {}), **({"turn": turn} if turn else {}), **({"passages": passages} if passages else {})}})
        except Exception:
            pass
    def is_model_call(url):
        try:
            parts = urlsplit(str(url))
        except ValueError:
            return False
        host = (parts.hostname or "").lower()
        path = parts.path or ""
        if host.endswith("googleapis.com"):
            return bool(re.search(r"generativelanguage|aiplatform", host)) and bool(model_path.search(path))
        if host.endswith("amazonaws.com"):
            return host.startswith("bedrock")
        return bool(model_host.search(host)) or (bool(model_path.search(path)) and bool(re.search(r"/v\d|/api/", path)))

    def text(body):
        if body is None:
            return ""
        if isinstance(body, (bytes, bytearray)):
            return bytes(body[:limit]).decode("utf-8", "replace")
        if isinstance(body, str):
            return body[:limit]
        try:
            return json.dumps(body)[:limit]
        except (TypeError, ValueError):
            return ""

    def note(url, body):
        req = ctx.get()
        if not req or req["noted"] or not is_model_call(url):
            return
        req["noted"] = True
        key = req["method"] + " " + req["path"].split("?")[0]
        if key in said:
            return
        said.add(key)
        write({"at": int(time.time() * 1000), "method": req["method"], "path": req["path"], "headers": req["headers"],
               "body": b"".join(req["chunks"]).decode("utf-8", "replace")[:limit], "sent": text(body)})

    # The meter: one row per model call your app makes, with the provider's own token counts and
    # never the reply's text.
    reply_max = 8 * 1024 * 1024

    def number(v):
        return v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else 0

    def tokens_of(u):
        if not isinstance(u, dict):
            return None
        if isinstance(u.get("tokens"), dict):
            return tokens_of(u["tokens"])
        if "prompt_tokens" in u:
            return {"promptTokens": number(u.get("prompt_tokens")), "cachedTokens": number((u.get("prompt_tokens_details") or {}).get("cached_tokens")), "completionTokens": number(u.get("completion_tokens"))}
        if "input_tokens" in u and isinstance(u.get("input_tokens_details"), dict):
            return {"promptTokens": number(u.get("input_tokens")), "cachedTokens": number(u["input_tokens_details"].get("cached_tokens")), "completionTokens": number(u.get("output_tokens"))}
        if "input_tokens" in u:
            read = number(u.get("cache_read_input_tokens"))
            return {"promptTokens": number(u.get("input_tokens")) + read + number(u.get("cache_creation_input_tokens")), "cachedTokens": read, "completionTokens": number(u.get("output_tokens"))}
        if "inputTokens" in u:
            read = number(u.get("cacheReadInputTokens"))
            return {"promptTokens": number(u.get("inputTokens")) + read + number(u.get("cacheWriteInputTokens")), "cachedTokens": read, "completionTokens": number(u.get("outputTokens"))}
        if "promptTokenCount" in u:
            return {"promptTokens": number(u.get("promptTokenCount")), "cachedTokens": number(u.get("cachedContentTokenCount")), "completionTokens": number(u.get("candidatesTokenCount"))}
        return None

    def parsed(raw):
        try:
            return json.loads(raw)
        except (TypeError, ValueError):
            return None

    def read_reply(kind, raw):
        if "event-stream" in (kind or "").lower():
            events = [parsed(line[5:].strip()) for line in raw.split("\n") if line.startswith("data:")]
        else:
            body = parsed(raw)
            events = body if isinstance(body, list) else [body]
        usage, model = {}, None
        for e in events:
            if not isinstance(e, dict):
                continue
            msg = e["message"] if isinstance(e.get("message"), dict) else {}
            resp = e["response"] if isinstance(e.get("response"), dict) else {}
            part = e.get("usage") or msg.get("usage") or resp.get("usage") or e.get("usageMetadata")
            if isinstance(part, dict):
                usage.update(part)
            model = e.get("model") or msg.get("model") or resp.get("model") or e.get("modelVersion") or model
        return tokens_of(usage or None), model, events

    def asked_for(url, sent):
        body = parsed(sent) if isinstance(sent, str) else None
        if isinstance(body, dict) and isinstance(body.get("model"), str):
            return body["model"]
        m = re.search(r"/models/([^/:]+):|/model/([^/]+)/(?:invoke|converse)", urlsplit(str(url)).path or "")
        return (m.group(1) or m.group(2)) if m else ""

    def unpacked(raw, encoding):
        import zlib
        try:
            e = (encoding or "").lower()
            if e == "gzip":
                raw = zlib.decompress(raw, 16 + zlib.MAX_WBITS)
            elif e == "deflate":
                raw = zlib.decompress(raw)
            elif e == "br":
                return ""
            return raw.decode("utf-8", "replace")
        except Exception:
            return ""

    def meter(url, sent, status, kind, raw, turn=None):
        try:
            tokens, model, events = read_reply(kind, (raw or "")[:reply_max])
            parts = urlsplit(str(url))
            row = {"at": int(time.time() * 1000), "host": parts.netloc.replace(":443", ""), "model": str(asked_for(url, sent) or model or "")[:160],
                   "status": int(status or 0), "usage": tokens is not None}
            row.update(tokens or {"promptTokens": 0, "cachedTokens": 0, "completionTokens": 0})
            turn = turn or turn_now()
            if turn:
                row["turn"] = turn
            as_text = sent if isinstance(sent, str) else text(sent)
            found = rules_in(as_text)
            if found is not None:
                row["rules"] = found
            tools = tools_in(as_text)
            if tools:
                row["tools"] = tools
            called = called_in(as_text, events)
            if called:
                row["called"] = called
            passages = passages_in(as_text)
            if passages:
                row["passages"] = passages
            write({"call": row})
        except Exception:
            pass

    # The app's own functions the read names as its tools. An app whose code picks the tool itself
    # (a classifier answers {"intent":"order"} and the code calls query_order()) never names one on
    # the wire, so the function is wrapped where it is defined and wherever it was imported by name:
    # each call writes its name, its clipped arguments and what it returned, on the turn it ran in.
    # The run writes the list beside the rules, after the app has loaded, so it is applied to the
    # modules already loaded and looked at again when more load.
    tools_file = os.environ.get("CORTAD_TOOLS_FILE")
    ident = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
    targets, swept, wrappers = [[]], [None], {}
    unsaid = set()

    def unwatched(t, why):
        if (t["file"], t["fn"]) in unsaid:
            return
        unsaid.add((t["file"], t["fn"]))
        try:
            sys.stderr.write("cortad: calls to %s in %s are not recorded: %s.\n" % (t["name"], t["file"], why))
        except Exception:
            pass

    def plain_of(v, depth=0):
        if v is None or isinstance(v, (str, bool, int, float)):
            return v
        if depth > 4:
            return "[%s]" % type(v).__name__
        if isinstance(v, (list, tuple, set)):
            return [plain_of(x, depth + 1) for x in list(v)[:20]]
        if isinstance(v, dict):
            return {str(k): plain_of(x, depth + 1) for k, x in list(v.items())[:40]}
        dump = getattr(v, "model_dump", None)
        if callable(dump):
            try:
                return plain_of(dump(), depth + 1)
            except Exception:
                pass
        return "[%s]" % type(v).__name__

    # The returned value's shape and a clipped text: a string as it is, anything else named by kind.
    def returned(v):
        if v is None:
            return "returned nothing"
        if isinstance(v, str):
            return v
        kind = "list of %d" % len(v) if isinstance(v, (list, tuple)) else "object" if isinstance(v, dict) or hasattr(v, "model_dump") else "value"
        return "%s: %s" % (kind, json.dumps(clipped(plain_of(v), 0, tool_text), ensure_ascii=False, separators=(",", ":")))

    def tool_row(name, sig, a, k, value, error, turn):
        try:
            try:
                named = dict(sig.bind_partial(*a, **k).arguments) if sig else None
            except TypeError:
                named = None
            if named is None:
                named = {**{str(i): x for i, x in enumerate(a)}, **k}
            text = "raised %s: %s" % (type(error).__name__, error) if error is not None else returned(value)
            row = {"at": int(time.time() * 1000), "host": "in-app", "status": 200,
                   "called": [{"name": name, "arguments": args_text(plain_of(named))}],
                   "tools": [{"name": name, "text": str(text)[:tool_text]}]}
            if turn:
                row["turn"] = turn
            write({"dep": row})
        except Exception:
            pass

    def wrap_tool(fn, name):
        import functools
        import inspect
        try:
            sig = inspect.signature(fn)
        except (TypeError, ValueError):
            sig = None
        if inspect.iscoroutinefunction(fn):
            async def wrapped(*a, **k):
                turn = turn_now()
                try:
                    out = await fn(*a, **k)
                except Exception as e:
                    tool_row(name, sig, a, k, None, e, turn)
                    raise
                tool_row(name, sig, a, k, out, None, turn)
                return out
        else:
            def wrapped(*a, **k):
                turn = turn_now()
                try:
                    out = fn(*a, **k)
                except Exception as e:
                    tool_row(name, sig, a, k, None, e, turn)
                    raise
                tool_row(name, sig, a, k, out, None, turn)
                return out
        functools.update_wrapper(wrapped, fn)
        wrapped.__cortad_tool__ = fn
        return wrapped

    def targets_now():
        if not tools_file:
            return []
        try:
            with open(tools_file, encoding="utf-8") as f:
                raw = json.load(f)
        except Exception:
            return []
        out = []
        for t in raw if isinstance(raw, list) else []:
            if isinstance(t, dict) and isinstance(t.get("name"), str) and t["name"] and isinstance(t.get("file"), str) and t["file"].endswith(".py") and ident.match(str(t.get("function"))):
                out.append({"name": t["name"][:80], "file": re.sub(r"^\.?/+", "", t["file"]), "fn": t["function"]})
        # One function named twice (by its own name, and as "query_order (fallback)" where a router
        # imported it) is recorded under its own name.
        return sorted(out, key=lambda t: t["name"] != t["fn"])

    def sweep_tools():
        if not tools_file:
            return
        try:
            at = os.stat(tools_file).st_mtime
        except OSError:
            return
        mark = (at, len(sys.modules))
        if swept[0] == mark:
            return
        if swept[0] is None or swept[0][0] != at:
            targets[0] = targets_now()
        swept[0] = mark
        if not targets[0]:
            return
        import inspect
        loaded = list(sys.modules.values())
        by_file = {}
        for m in loaded:
            f = getattr(m, "__file__", None)
            if isinstance(f, str) and f.endswith(".py"):
                by_file.setdefault(f.replace(os.sep, "/"), m)
        fresh = {}
        for t in targets[0]:
            m = next((mod for f, mod in by_file.items() if f == t["file"] or f.endswith("/" + t["file"])), None)
            if m is None:
                continue
            fn = getattr(m, t["fn"], None)
            if getattr(fn, "__cortad_tool__", None) is not None:
                continue
            if not (inspect.isfunction(fn) or inspect.ismethod(fn)):
                unwatched(t, "the file has no function named %s" % t["fn"] if fn is None else "%s there is not a function this hook can wrap" % t["fn"])
                continue
            held = wrappers.get(id(fn))
            w = held[1] if held is not None and held[0] is fn else wrap_tool(fn, t["name"])
            wrappers[id(fn)] = (fn, w)
            try:
                setattr(m, t["fn"], w)
            except Exception:
                unwatched(t, "its module does not let %s be replaced" % t["fn"])
                continue
            fresh[id(fn)] = (fn, w)
        if not fresh:
            return
        # Wherever the app imported it by name (from tools import query_order) or put it in a table
        # of its own (ROUTES = {"order": query_order}), the same function is swapped for the wrapper.
        here = os.getcwd().replace(os.sep, "/") + "/"
        for m in loaded:
            d = getattr(m, "__dict__", None)
            if not isinstance(d, dict):
                continue
            f = str(getattr(m, "__file__", "") or "").replace(os.sep, "/")
            ours = f.startswith(here) and "/site-packages/" not in f and "/dist-packages/" not in f
            for k, v in list(d.items()):
                hit = fresh.get(id(v))
                if hit is not None and hit[0] is v:
                    d[k] = hit[1]
                elif ours and isinstance(v, dict):
                    for kk, vv in list(v.items()):
                        hit = fresh.get(id(vv))
                        if hit is not None and hit[0] is vv:
                            v[kk] = hit[1]

    def started(method, path, headers):
        try:
            sweep_tools()
        except Exception:
            pass
        turn = headers.pop("x-cortad-turn", None)
        return {"method": method, "path": path, "headers": headers, "chunks": [], "size": 0, "noted": False,
                "turn": turn if isinstance(turn, str) and turn_ok.match(turn) else None}

    def keep(req, chunk):
        if chunk and req["size"] < limit:
            req["chunks"].append(bytes(chunk))
            req["size"] += len(chunk)

    # Inbound, ASGI: FastAPI, Starlette, Django under uvicorn, Quart, Litestar.
    class Asgi:
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            if scope.get("type") != "http" or scope.get("method") in ("GET", "HEAD", "OPTIONS"):
                return await self.app(scope, receive, send)
            query = scope.get("query_string") or b""
            req = started(scope["method"], scope.get("path", "/") + ("?" + query.decode("latin-1") if query else ""),
                          {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []})

            async def seen():
                message = await receive()
                if message.get("type") == "http.request":
                    keep(req, message.get("body") or b"")
                return message

            token = ctx.set(req)
            try:
                return await self.app(scope, seen, send)
            finally:
                ctx.reset(token)

    # Inbound, WSGI: Flask, Django's runserver, anything under werkzeug.
    class Tee:
        def __init__(self, stream, req):
            self.stream, self.req = stream, req

        def read(self, *a):
            chunk = self.stream.read(*a)
            keep(self.req, chunk)
            return chunk

        def readline(self, *a):
            chunk = self.stream.readline(*a)
            keep(self.req, chunk)
            return chunk

        def __iter__(self):
            for chunk in self.stream:
                keep(self.req, chunk)
                yield chunk

        def __getattr__(self, name):
            return getattr(self.stream, name)

    def inside(req, iterable):
        # A streamed reply is produced after the handler returns: the model call happens here.
        it = iter(iterable)
        try:
            while True:
                token = ctx.set(req)
                try:
                    item = next(it)
                except StopIteration:
                    return
                finally:
                    ctx.reset(token)
                yield item
        finally:
            close = getattr(iterable, "close", None)
            if close:
                close()

    def wsgi(app):
        if getattr(app, "_brainsless", False):
            return app

        def wrapped(environ, start_response):
            method = environ.get("REQUEST_METHOD", "GET")
            if method in ("GET", "HEAD", "OPTIONS"):
                return app(environ, start_response)
            headers = {k[5:].replace("_", "-").lower(): v for k, v in environ.items() if k.startswith("HTTP_")}
            if environ.get("CONTENT_TYPE"):
                headers["content-type"] = environ["CONTENT_TYPE"]
            query = environ.get("QUERY_STRING") or ""
            req = started(method, (environ.get("SCRIPT_NAME", "") + environ.get("PATH_INFO", "/")) + ("?" + query if query else ""), headers)
            if environ.get("wsgi.input") is not None:
                environ["wsgi.input"] = Tee(environ["wsgi.input"], req)
            token = ctx.set(req)
            try:
                return inside(req, app(environ, start_response))
            finally:
                ctx.reset(token)

        wrapped._brainsless = True
        return wrapped

    # The app's own route table, read off the app object the server was handed, so the run knows
    # every door the app has before a message is sent. Read only: nothing here changes the app.
    route_max, openapi_max = 400, 8 * 1024 * 1024
    verbs = ("GET", "POST", "PUT", "PATCH", "DELETE")
    served_port = [None]

    def template(path):
        # One syntax for every framework's path parameters: OpenAPI's {name}.
        p = re.sub(r"\(\?P<(\w+)>(?:[^()]|\([^()]*\))*\)", r"{\1}", str(path))
        p = re.sub(r"<(?:[^<>:]+:)?(\w+)>", r"{\1}", p)
        p = re.sub(r"\{(\w+):[^{}]*\}", r"{\1}", p)
        p = re.sub(r"(?:\$|\\Z)$", "", re.sub(r"^\^", "", p))
        return p.replace("\\.", ".").replace("/?", "/")

    def source_of(fn):
        import inspect
        try:
            fn = inspect.unwrap(fn)
        except Exception:
            pass
        code = getattr(fn, "__code__", None)
        path = code.co_filename if code else getattr(sys.modules.get(getattr(fn, "__module__", None) or ""), "__file__", None) or ""
        rel = os.path.relpath(path, os.getcwd()) if path else ""
        theirs = rel and not rel.startswith("..") and "site-packages" not in rel and "dist-packages" not in rel
        return (rel if theirs else ""), str(getattr(fn, "__name__", "") or "")

    def add(out, methods, path, fn):
        # Methods unknown: the two a door is asked with.
        file, handler = source_of(fn) if fn is not None else ("", "")
        for m in ("POST", "GET") if methods is None else methods:
            m = str(m).upper()
            if m not in ("HEAD", "OPTIONS") and len(out) < route_max:
                out.append({"method": m, "path": ("/" + template(path).lstrip("/"))[:1024], "file": file[:512], "handler": handler[:200]})

    def class_methods(cls):
        return [m for m in verbs if callable(getattr(cls, m.lower(), None))]

    def starlette_routes(routes, prefix, out):
        for r in routes or []:
            path = prefix + (getattr(r, "path", "") or "")
            sub = getattr(r, "routes", None)
            # FastAPI 0.14x keeps an included router whole and resolves its routes on demand.
            if callable(getattr(r, "effective_route_contexts", None)):
                for c in r.effective_route_contexts():
                    if c.starlette_route is not None:
                        starlette_routes([c.starlette_route], prefix, out)
                    else:
                        add(out, c.methods, prefix + c.path, c.endpoint)
            elif sub is not None:
                starlette_routes(sub, path, out)
            elif getattr(r, "endpoint", None) is not None and "WebSocket" not in type(r).__name__:
                fn = r.endpoint
                add(out, getattr(r, "methods", None) or (class_methods(fn) if isinstance(fn, type) else None), path, fn)

    def flask_routes(app, out):
        for rule in app.url_map.iter_rules():
            if rule.endpoint != "static" and not rule.endpoint.endswith(".static"):
                add(out, rule.methods, rule.rule, app.view_functions.get(rule.endpoint))

    def django_routes(_app, out):
        from django.urls import URLResolver, get_resolver

        def walk(patterns, prefix):
            for p in patterns:
                path = prefix + template(str(p.pattern))
                if isinstance(p, URLResolver):
                    walk(p.url_patterns, path)
                    continue
                cb = p.callback
                actions = getattr(cb, "actions", None)
                cls = getattr(cb, "cls", None) or getattr(cb, "view_class", None)
                add(out, list(actions) if isinstance(actions, dict) else class_methods(cls) if cls else None, path, cls or cb)

        walk(get_resolver().url_patterns, "/")

    def litestar_routes(app, out):
        for r in app.routes:
            for h in getattr(r, "route_handlers", None) or []:
                methods = [m for m in getattr(h, "http_methods", ()) if str(m).upper() in verbs]
                if methods:
                    add(out, methods, r.path, getattr(h, "fn", None))

    def aiohttp_routes(app, out):
        for r in app.router.routes():
            add(out, None if r.method == "*" else [r.method], r.resource.canonical if r.resource else "", r.handler)

    def asgi_routes(app, out):
        starlette_routes(app.routes, "", out)

    walkers = (("fastapi", "routes", asgi_routes), ("starlette", "routes", asgi_routes),
               ("quart", "url_map", flask_routes), ("flask", "url_map", flask_routes),
               ("litestar", "routes", litestar_routes), ("aiohttp", "router", aiohttp_routes),
               ("django", None, django_routes))

    def app_in(obj):
        # Servers hand the app over inside their own middleware, and each layer keeps the next.
        for _ in range(12):
            if obj is None:
                break
            tops = {c.__module__.split(".")[0] for c in type(obj).__mro__}
            for name, attr, walk in walkers:
                if name in tops and (attr is None or hasattr(obj, attr)):
                    return name, obj, walk
            inner = getattr(obj, "app", None)
            obj = inner if inner is not None else getattr(obj, "application", None)
        return None, None, None

    def openapi_of(name, app):
        try:
            if name == "fastapi":
                # openapi() caches what it builds; the app's own cache is put back as it was.
                kept = app.openapi_schema
                try:
                    doc = app.openapi()
                finally:
                    app.openapi_schema = kept
            elif name == "litestar":
                doc = app.openapi_schema.to_schema()
            else:
                return None
            return doc if isinstance(doc, dict) and len(json.dumps(doc)) <= openapi_max else None
        except Exception:
            return None

    def publish_routes(app, port):
        name, found, out = None, None, []
        try:
            name, found, walk = app_in(app)
            if walk:
                walk(found, out)
        except Exception:
            pass
        port = port if isinstance(port, int) and not isinstance(port, bool) else None
        write({"routes": {"framework": name or "unknown", "port": port, "routes": out, "openapi": openapi_of(name, found)}})

    # What is patched, once the module it lives in has been imported by the app itself.
    def patch_uvicorn(module):
        load = module.Config.load

        def loaded(self, *a, **k):
            out = load(self, *a, **k)
            # Under gunicorn, uvicorn's own port is its default and the socket is gunicorn's.
            port = served_port[0] or getattr(self, "port", None)
            publish_routes(self.loaded_app, port)
            if not isinstance(self.loaded_app, Asgi):
                self.loaded_app = Asgi(self.loaded_app)
            if isinstance(port, int):
                write({"listen": port, "pid": os.getpid()})
            return out

        module.Config.load = loaded

    def patch_werkzeug(module):
        run_simple = module.run_simple

        def run(hostname, port, application, *a, **k):
            if isinstance(port, int):
                write({"listen": port, "pid": os.getpid()})
            publish_routes(application, port)
            return run_simple(hostname, port, wsgi(application), *a, **k)

        module.run_simple = run

    def patch_django(module):
        call = module.WSGIHandler.__call__

        def called(self, environ, start_response):
            return wsgi(lambda e, s: call(self, e, s))(environ, start_response)

        module.WSGIHandler.__call__ = called

    def patch_django_server(module):
        run = module.run

        def running(addr, port, wsgi_handler, *a, **k):
            publish_routes(wsgi_handler, port)
            return run(addr, port, wsgi_handler, *a, **k)

        module.run = running

    def patch_gunicorn(module):
        load = module.Worker.load_wsgi

        def loaded(self):
            out = load(self)
            try:
                bound = [s.getsockname() for s in self.sockets]
                served_port[0] = next((at[1] for at in bound if isinstance(at, tuple)), None)
            except Exception:
                pass
            publish_routes(self.wsgi, served_port[0])
            return out

        module.Worker.load_wsgi = loaded

    def patch_hypercorn(module):
        serve = module.worker_serve

        def serving(app, config, *a, **k):
            port = None
            try:
                port = int(str(config.bind[0]).rsplit(":", 1)[1])
            except Exception:
                pass
            publish_routes(app, port)
            return serve(app, config, *a, **k)

        module.worker_serve = serving

    def patch_aiohttp_web(module):
        run_app = module.run_app

        def run(app, *a, **k):
            if isinstance(app, module.Application):
                publish_routes(app, k.get("port") or 8080)
            return run_app(app, *a, **k)

        module.run_app = run

    def sent_of(request):
        try:
            return text(request.content)
        except Exception:
            return ""

    def patch_httpx(module):
        # A streamed reply is read by your app after send returns: its raw bytes are kept as they go
        # past and the row is written when the stream closes. A read reply is metered at once.
        class Kept:
            def __init__(self, stream, done):
                self.stream, self.done, self.got, self.size = stream, done, [], 0

            def keep(self, chunk):
                if self.size < reply_max:
                    self.got.append(bytes(chunk))
                    self.size += len(chunk)

            def finish(self):
                done, self.done = self.done, None
                if done:
                    done(b"".join(self.got))

        class SyncKept(module.SyncByteStream, Kept):
            def __iter__(self):
                for chunk in self.stream:
                    self.keep(chunk)
                    yield chunk

            def close(self):
                try:
                    self.stream.close()
                finally:
                    self.finish()

        class AsyncKept(module.AsyncByteStream, Kept):
            async def __aiter__(self):
                async for chunk in self.stream:
                    self.keep(chunk)
                    yield chunk

            async def aclose(self):
                try:
                    await self.stream.aclose()
                finally:
                    self.finish()

        def watch(request, response, sent):
            model = is_model_call(request.url)
            if not model and not is_retrieval(request.url):
                dep(request.url, response.status_code)
                return response
            kind = response.headers.get("content-type", "")
            if getattr(response, "_content", None) is not None:
                if model:
                    meter(request.url, sent, response.status_code, kind, response.content.decode("utf-8", "replace"))
                else:
                    dep(request.url, response.status_code, passages=passages_from(response.content.decode("utf-8", "replace")))
                return response
            turn = turn_now()
            if model:
                done = lambda raw: meter(request.url, sent, response.status_code, kind, unpacked(raw, response.headers.get("content-encoding")), turn)
            else:
                done = lambda raw: dep(request.url, response.status_code, passages=passages_from(unpacked(raw, response.headers.get("content-encoding"))), turn=turn)
            stream = response.stream
            if hasattr(stream, "__aiter__") and hasattr(stream, "aclose"):
                response.stream = AsyncKept(stream, done)
            elif hasattr(stream, "__iter__"):
                response.stream = SyncKept(stream, done)
            elif model:
                meter(request.url, sent, response.status_code, kind, "")
            else:
                dep(request.url, response.status_code)
            return response

        for cls in (module.Client, module.AsyncClient):
            send = cls.send
            if cls is module.Client:
                def sync_send(self, request, *a, _send=send, **k):
                    sent = sent_of(request)
                    try:
                        note(request.url, sent)
                    except Exception:
                        pass
                    try:
                        response = _send(self, request, *a, **k)
                    except Exception as err:
                        if is_model_call(request.url):
                            meter(request.url, sent, 0, "", "")
                        else:
                            dep(request.url, 0, type(err).__name__)
                        raise
                    try:
                        return watch(request, response, sent)
                    except Exception:
                        return response
                cls.send = sync_send
            else:
                async def async_send(self, request, *a, _send=send, **k):
                    sent = sent_of(request)
                    try:
                        note(request.url, sent)
                    except Exception:
                        pass
                    try:
                        response = await _send(self, request, *a, **k)
                    except Exception as err:
                        if is_model_call(request.url):
                            meter(request.url, sent, 0, "", "")
                        else:
                            dep(request.url, 0, type(err).__name__)
                        raise
                    try:
                        return watch(request, response, sent)
                    except Exception:
                        return response
                cls.send = async_send

    def patch_requests(module):
        send = module.Session.send

        def sent(self, request, *a, **k):
            try:
                note(request.url, request.body)
            except Exception:
                pass
            try:
                response = send(self, request, *a, **k)
            except Exception as err:
                if not is_model_call(request.url):
                    dep(request.url, 0, type(err).__name__)
                raise
            try:
                if not is_model_call(request.url):
                    read = is_retrieval(request.url) and not k.get("stream")
                    dep(request.url, response.status_code, passages=passages_from(response.content.decode("utf-8", "replace")) if read else None)
                if is_model_call(request.url):
                    # A streamed reply is counted as a call whose counts were not read.
                    raw = response.content.decode("utf-8", "replace") if getattr(response, "_content_consumed", False) else ""
                    meter(request.url, text(request.body), response.status_code, response.headers.get("content-type", ""), raw)
            except Exception:
                pass
            return response

        module.Session.send = sent

    def patch_aiohttp(module):
        request = module.ClientSession._request

        async def requested(self, method, str_or_url, *a, **k):
            body = k.get("json") if k.get("json") is not None else k.get("data")
            try:
                note(str_or_url, body)
            except Exception:
                pass
            try:
                response = await request(self, method, str_or_url, *a, **k)
            except Exception as err:
                if not is_model_call(str_or_url):
                    dep(str_or_url, 0, type(err).__name__)
                raise
            if is_model_call(str_or_url):
                response._cortad = (str_or_url, text(body), turn_now())
            elif is_retrieval(str_or_url):
                response._cortad_dep = (str_or_url, turn_now())
            else:
                dep(str_or_url, response.status)
            return response

        # Metered when your app reads the reply, or, for one it streams, when the reply is let go.
        read, release = module.ClientResponse.read, module.ClientResponse.release

        async def read_kept(self, *a, **k):
            raw = await read(self, *a, **k)
            store = getattr(self, "_cortad_dep", None)
            if store:
                self._cortad_dep = None
                dep(store[0], self.status, passages=passages_from((raw or b"").decode("utf-8", "replace")), turn=store[1])
            call = getattr(self, "_cortad", None)
            if call:
                self._cortad = None
                meter(call[0], call[1], self.status, self.headers.get("content-type", ""), (raw or b"").decode("utf-8", "replace"), call[2])
            return raw

        def release_kept(self, *a, **k):
            store = getattr(self, "_cortad_dep", None)
            if store:
                self._cortad_dep = None
                dep(store[0], self.status, turn=store[1])
            call = getattr(self, "_cortad", None)
            if call:
                self._cortad = None
                meter(call[0], call[1], self.status, self.headers.get("content-type", ""), "", call[2])
            return release(self, *a, **k)

        module.ClientSession._request = requested
        module.ClientResponse.read = read_kept
        module.ClientResponse.release = release_kept

    exact = {"uvicorn.config": patch_uvicorn, "werkzeug.serving": patch_werkzeug, "django.core.handlers.wsgi": patch_django,
             "django.core.servers.basehttp": patch_django_server, "gunicorn.workers.base": patch_gunicorn,
             "hypercorn.asyncio.run": patch_hypercorn, "hypercorn.trio.run": patch_hypercorn, "aiohttp.web": patch_aiohttp_web,
             "requests.sessions": patch_requests, "aiohttp.client": patch_aiohttp}
    # By family, not by name: the OpenAI SDK moved to a renamed copy of httpx (httpx2), and a patch
    # keyed on "httpx" alone saw none of its calls.
    families = [(re.compile(r"httpx\d*$"), patch_httpx)]

    def patch_for(name):
        if name in exact:
            return exact[name]
        for pattern, patch in families:
            if pattern.match(name):
                return patch
        return None

    busy = set()

    class Finder(importlib.abc.MetaPathFinder):
        def find_spec(self, name, path=None, target=None):
            patch = patch_for(name)
            if patch is None or name in busy:
                return None
            busy.add(name)
            try:
                spec = importlib.util.find_spec(name)
            except Exception:
                spec = None
            finally:
                busy.discard(name)
            if spec is None or spec.loader is None or not hasattr(spec.loader, "exec_module"):
                return None
            run = spec.loader.exec_module

            def exec_module(module, _run=run, _patch=patch):
                _run(module)
                try:
                    _patch(module)
                except Exception:
                    pass

            try:
                spec.loader.exec_module = exec_module
            except Exception:
                return None
            return spec

    sys.meta_path.insert(0, Finder())
    write({"hello": "python", "pid": os.getpid()})


if _FILE:
    try:
        _install()
    except Exception:
        pass
    if _WRITES and _APP_ROOT:
        try:
            _install_writes()
        except Exception:
            pass
