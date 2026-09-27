# Loaded into your Python app by the command that started it (through PYTHONPATH), and only then.
# The same job as trace.cjs does for Node: it watches for a request to your app during which your
# app called a model. That request is your AI's door, with the exact body it takes and the sign-in
# it carried. What it sees is written to a file only you can read, in the command's own folder on
# this machine. Nothing here talks to a network, and nothing here may ever stop your app starting.
# ponytail: shadows a sitecustomize of the project's own, which is rare; chain to it if one shows up.
import os

_FILE = os.environ.get("CORTAD_TRACE_FILE")
_RULES = os.environ.get("CORTAD_RULES_FILE")


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

    def person_said(m):
        return m.get("role") == "user" and not any(isinstance(c, dict) and c.get("type") == "tool_result" for c in (m.get("content") if isinstance(m.get("content"), list) else []))

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
        return out or None

    # What the model asked the app to run: chat tool_calls (a stream's pieces joined by position), a
    # legacy function_call, a responses function_call item, an Anthropic or Bedrock tool use, a
    # Gemini functionCall. Read off the model's reply, and off this turn's earlier calls as the
    # prompt resends them. Names and arguments only: every value clipped, a secret never written.
    calls_max, value_max, args_max = 12, 200, 1200
    secret_key = re.compile(r"(?:^|_)(?:pass(?:word|phrase)?|secret|token|api_?key|authorization|cookie|session(?:_id)?|credentials?|private_key)$")
    secret_value = re.compile(r"^(?:Bearer\s|Basic\s|sk-|pk_|rk_|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|AIza|eyJ[\w-]{10,}\.)")

    def clipped(v, depth=0):
        if isinstance(v, str):
            return "[secret]" if secret_value.match(v) else (v[:value_max] + "…" if len(v) > value_max else v)
        if isinstance(v, list):
            return [] if depth > 4 else [clipped(x, depth + 1) for x in v[:20]]
        if isinstance(v, dict):
            if depth > 4:
                return {}
            return {k: ("[secret]" if secret_key.search(re.sub(r"([a-z])([A-Z])", r"\1_\2", str(k)).lower()) else clipped(x, depth + 1)) for k, x in list(v.items())[:40]}
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

    def called_in(sent, events):
        body = parsed(sent) if isinstance(sent, str) else None
        out = []
        for c in (called_before(body) if isinstance(body, dict) else []) + calls_of(events):
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

    # A framework that folds its tools' answers into the next prompt as plain text sends no tool
    # message to find: within one turn, what a later call's prompt carries that the call before did
    # not, outside the model's own words, is that material. The first call holds the customer's
    # message and the system prompt, present in every later call, so neither is ever counted.
    seen_by_turn = {}

    def texts_of(body):
        out = set()

        def take(v):
            t = text_of(v).strip()
            if t:
                out.add(t[:tool_text])
        for m in body.get("messages") if isinstance(body.get("messages"), list) else []:
            if isinstance(m, dict) and m.get("role") != "assistant":
                take(m.get("content"))
        for it in body.get("input") if isinstance(body.get("input"), list) else []:
            if isinstance(it, dict) and it.get("role") != "assistant" and it.get("type") != "function_call":
                take(it.get("content") if it.get("content") is not None else it.get("output"))
        if isinstance(body.get("system"), str):
            take(body["system"])
        for c in body.get("contents") if isinstance(body.get("contents"), list) else []:
            if isinstance(c, dict) and c.get("role") != "model":
                for p in c.get("parts") if isinstance(c.get("parts"), list) else []:
                    if isinstance(p, dict) and isinstance(p.get("text"), str):
                        take(p["text"])
        return out

    def material_in(sent, turn):
        if not turn:
            return None
        body = parsed(sent) if isinstance(sent, str) else None
        if not isinstance(body, dict):
            return None
        now = texts_of(body)
        before = seen_by_turn.get(turn)
        seen_by_turn[turn] = now
        if len(seen_by_turn) > 200:
            seen_by_turn.pop(next(iter(seen_by_turn)))
        if before is None:
            return None
        fresh = [{"name": "", "text": t} for t in now if t not in before][:tools_max]
        return fresh or None

    def rules_in(sent):
        found = rules_now()
        if found is None:
            return None
        body = norm(sent)
        return [rid for rid, parts in found if all(p in body for p in parts)]

    def write(row):
        try:
            fd = os.open(_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
        except OSError:
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
            tools = tools_in(as_text) or material_in(as_text, turn)
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

    def started(method, path, headers):
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
