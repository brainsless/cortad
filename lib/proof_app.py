# A chat app for the proof tests, run under the Python hook with uvicorn: FastAPI, the OpenAI SDK
# pointed at a provider on a local port, doors that each keep a conversation their own way, and doors
# whose model call runs outside the request: on the app's own queue, or on a thread pool.
import asyncio
import json
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
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
jobs = asyncio.Queue()
events = {}
threads = {}


# The app's own queue worker, started with the app and outside every request, the way a UI framework
# runs the handlers it queues. "show" puts the message on screen and calls no model; "answer" answers
# it on the thread the show step opened for the client's session.
async def work():
    while True:
        session, event_id, fn, data = await jobs.get()
        if fn == "show":
            threads.setdefault(session, uuid.uuid4().hex)
            output = [data[1] + [{"role": "user", "content": data[0]}]]
        else:
            history = histories.setdefault(threads.get(session) or event_id, [])
            history.append({"role": "user", "content": data[0][-1]["content"]})
            answer = (await asyncio.to_thread(complete, history)).choices[0].message.content
            history.append({"role": "assistant", "content": answer})
            output = [data[0] + [{"role": "assistant", "content": answer}]]
        await events.setdefault(session, asyncio.Queue()).put({"msg": "process_completed", "event_id": event_id, "output": {"data": output}})


@asynccontextmanager
async def lifespan(_app):
    worker = asyncio.create_task(work())
    yield
    worker.cancel()


app = FastAPI(lifespan=lifespan)
pool = ThreadPoolExecutor(2)


# The client joins the queue with a session id of its own and reads the answer from that session's
# stream of events.
@app.post("/queue/join")
async def join(request: Request):
    body = await request.json()
    event_id = uuid.uuid4().hex
    await jobs.put((body["session"], event_id, body["fn"], body["data"]))
    return {"event_id": event_id}


@app.get("/queue/data")
async def queue_data(session: str):
    async def stream():
        yield "data: %s\n\n" % json.dumps({"msg": "estimation", "rank": 0})
        yield "data: %s\n\n" % json.dumps(await events.setdefault(session, asyncio.Queue()).get())
    return StreamingResponse(stream(), media_type="text/event-stream")


# The app hands back an event id, and the answer is fetched at an address that names it.
@app.post("/call/answer")
async def call(request: Request):
    body = await request.json()
    event_id = uuid.uuid4().hex
    await jobs.put((event_id, event_id, "answer", [[{"role": "user", "content": body["data"][0]}]]))
    return {"event_id": event_id}


@app.get("/call/answer/{event_id}")
async def call_answer(event_id: str):
    async def stream():
        done = await events.setdefault(event_id, asyncio.Queue()).get()
        yield "event: complete\ndata: %s\n\n" % json.dumps([done["output"]["data"][0][-1]["content"]])
    return StreamingResponse(stream(), media_type="text/event-stream")


# The handler waits on a thread pool that does not carry the request's context with it.
@app.post("/pool")
async def pooled(request: Request):
    body = await request.json()
    answer = await asyncio.get_running_loop().run_in_executor(pool, complete, [{"role": "user", "content": body["message"]}])
    return {"answer": answer.choices[0].message.content}


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
