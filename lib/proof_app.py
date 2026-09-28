# A chat app for the proof tests, run under the Python hook with uvicorn: FastAPI, the OpenAI SDK
# pointed at a provider on a local port, and three doors that each keep a conversation their own way.
import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from openai import OpenAI

SYSTEM = "You are Rio, a cooking helper. Always name one ingredient you would swap."
histories = {}


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        sent = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        if "/points/search" in self.path:
            return self.answer("application/json", json.dumps({"result": []}).encode())
        asks = [m["content"] for m in sent["messages"] if m["role"] == "user"]
        text = "For %s, swap butter for olive oil." % asks[-1]
        if len(asks) > 1:
            text += " You also asked about %s." % " and ".join(asks[:-1])
        usage = {"prompt_tokens": 30 + 10 * len(asks), "completion_tokens": 9, "total_tokens": 39 + 10 * len(asks)}
        if not sent.get("stream"):
            body = {"id": "c1", "object": "chat.completion", "created": 1, "model": sent["model"],
                    "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": text}}], "usage": usage}
            return self.answer("application/json", json.dumps(body).encode())
        chunks = [{"id": "c1", "object": "chat.completion.chunk", "created": 1, "model": sent["model"], "choices": [{"index": 0, "delta": {"content": w}}]} for w in text.split(" ")]
        for c in chunks[1:]:
            c["choices"][0]["delta"]["content"] = " " + c["choices"][0]["delta"]["content"]
        chunks.append({"id": "c1", "object": "chat.completion.chunk", "created": 1, "model": sent["model"], "choices": [], "usage": usage})
        self.answer("text/event-stream", "".join("data: %s\n\n" % json.dumps(c) for c in chunks).encode() + b"data: [DONE]\n\n")

    def answer(self, kind, body):
        self.send_response(200)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


provider = HTTPServer(("127.0.0.1", 0), Provider)
threading.Thread(target=provider.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % provider.server_port
client = OpenAI(api_key="not-a-key", base_url=base + "/v1", max_retries=0)
app = FastAPI()


def complete(history, stream=False):
    return client.chat.completions.create(model="fixture-model", messages=[{"role": "system", "content": SYSTEM}, *history], stream=stream,
                                          **({"stream_options": {"include_usage": True}} if stream else {}))


# The app names the conversation in a cookie it sets on the first reply.
@app.post("/chat")
async def chat(request: Request):
    body = await request.json()
    conv = request.cookies.get("conv") or uuid.uuid4().hex
    history = histories.setdefault(conv, [])
    history.append({"role": "user", "content": body["message"]})
    answer = complete(history).choices[0].message.content
    history.append({"role": "assistant", "content": answer})
    reply = JSONResponse({"answer": answer})
    reply.set_cookie("conv", conv)
    return reply


# The client mints the conversation's id and sends it with every message; the reply streams.
@app.post("/ask")
async def ask(request: Request):
    body = await request.json()
    history = histories.setdefault(body["thread_id"], [])
    history.append({"role": "user", "content": body["question"]})

    def tokens():
        said = ""
        for chunk in complete(history, stream=True):
            if chunk.choices and chunk.choices[0].delta.content:
                said += chunk.choices[0].delta.content
                yield "data: %s\n\n" % json.dumps({"token": chunk.choices[0].delta.content})
        history.append({"role": "assistant", "content": said})

    return StreamingResponse(tokens(), media_type="text/event-stream")


# Looks the question up in a vector store that has nothing, then answers anyway.
@app.post("/recipes")
async def recipes(request: Request):
    body = await request.json()
    found = httpx.post(base + "/collections/recipes/points/search", json={"query": body["q"], "limit": 3}).json()["result"]
    answer = complete([{"role": "user", "content": body["q"] + "\n\nRecipes: " + json.dumps(found)}]).choices[0].message.content
    return {"answer": answer}
