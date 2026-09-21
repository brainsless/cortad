# Loaded into your Python app by the command that started it (through PYTHONPATH), and only then.
# The same job as trace.cjs does for Node: it watches for a request to your app during which your
# app called a model. That request is your AI's door, with the exact body it takes and the sign-in
# it carried. What it sees is written to a file only you can read, in the command's own folder on
# this machine. Nothing here talks to a network, and nothing here may ever stop your app starting.
# ponytail: shadows a sitecustomize of the project's own, which is rare; chain to it if one shows up.
import os

_FILE = os.environ.get("CORTAD_TRACE_FILE")


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
    model_host = re.compile(r"(?:^|\.)(?:openai\.com|anthropic\.com|fireworks\.ai|openrouter\.ai|groq\.com|mistral\.ai|together\.xyz|together\.ai|deepseek\.com|cohere\.ai|cohere\.com|perplexity\.ai|x\.ai|openai\.azure\.com|cognitiveservices\.azure\.com|replicate\.com|huggingface\.co|cerebras\.ai|deepinfra\.com|novita\.ai|moonshot\.cn|dashscope\.aliyuncs\.com|bigmodel\.cn)$", re.I)
    model_path = re.compile(r"/(?:chat/completions|completions|responses|messages|embeddings)$|:(?:generateContent|streamGenerateContent)|/invoke(?:-with-response-stream)?$|/api/(?:chat|generate)$", re.I)

    def write(row):
        try:
            fd = os.open(_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
        except OSError:
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
        return tokens_of(usage or None), model

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

    def meter(url, sent, status, kind, raw):
        try:
            tokens, model = read_reply(kind, (raw or "")[:reply_max])
            parts = urlsplit(str(url))
            row = {"at": int(time.time() * 1000), "host": parts.netloc.replace(":443", ""), "model": str(asked_for(url, sent) or model or "")[:160],
                   "status": int(status or 0), "usage": tokens is not None}
            row.update(tokens or {"promptTokens": 0, "cachedTokens": 0, "completionTokens": 0})
            write({"call": row})
        except Exception:
            pass

    def started(method, path, headers):
        return {"method": method, "path": path, "headers": headers, "chunks": [], "size": 0, "noted": False}

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

    # What is patched, once the module it lives in has been imported by the app itself.
    def patch_uvicorn(module):
        load = module.Config.load

        def loaded(self, *a, **k):
            out = load(self, *a, **k)
            if not isinstance(self.loaded_app, Asgi):
                self.loaded_app = Asgi(self.loaded_app)
            return out

        module.Config.load = loaded

    def patch_werkzeug(module):
        run_simple = module.run_simple

        def run(hostname, port, application, *a, **k):
            return run_simple(hostname, port, wsgi(application), *a, **k)

        module.run_simple = run

    def patch_django(module):
        call = module.WSGIHandler.__call__

        def called(self, environ, start_response):
            return wsgi(lambda e, s: call(self, e, s))(environ, start_response)

        module.WSGIHandler.__call__ = called

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
            if not is_model_call(request.url):
                return response
            kind = response.headers.get("content-type", "")
            if getattr(response, "_content", None) is not None:
                meter(request.url, sent, response.status_code, kind, response.content.decode("utf-8", "replace"))
                return response
            done = lambda raw: meter(request.url, sent, response.status_code, kind, unpacked(raw, response.headers.get("content-encoding")))
            stream = response.stream
            if hasattr(stream, "__aiter__") and hasattr(stream, "aclose"):
                response.stream = AsyncKept(stream, done)
            elif hasattr(stream, "__iter__"):
                response.stream = SyncKept(stream, done)
            else:
                meter(request.url, sent, response.status_code, kind, "")
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
                    except Exception:
                        if is_model_call(request.url):
                            meter(request.url, sent, 0, "", "")
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
                    except Exception:
                        if is_model_call(request.url):
                            meter(request.url, sent, 0, "", "")
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
            response = send(self, request, *a, **k)
            try:
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
            response = await request(self, method, str_or_url, *a, **k)
            if is_model_call(str_or_url):
                response._cortad = (str_or_url, text(body))
            return response

        # Metered when your app reads the reply, or, for one it streams, when the reply is let go.
        read, release = module.ClientResponse.read, module.ClientResponse.release

        async def read_kept(self, *a, **k):
            raw = await read(self, *a, **k)
            call = getattr(self, "_cortad", None)
            if call:
                self._cortad = None
                meter(call[0], call[1], self.status, self.headers.get("content-type", ""), (raw or b"").decode("utf-8", "replace"))
            return raw

        def release_kept(self, *a, **k):
            call = getattr(self, "_cortad", None)
            if call:
                self._cortad = None
                meter(call[0], call[1], self.status, self.headers.get("content-type", ""), "")
            return release(self, *a, **k)

        module.ClientSession._request = requested
        module.ClientResponse.read = read_kept
        module.ClientResponse.release = release_kept

    exact = {"uvicorn.config": patch_uvicorn, "werkzeug.serving": patch_werkzeug, "django.core.handlers.wsgi": patch_django,
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
