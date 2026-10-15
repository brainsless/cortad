"""Legal research API: a lawyer asks, the answer is written in the background from the legislation
the search index finds, and the client polls."""
import asyncio
import datetime
import os
import uuid

import asyncpg
import firebase_admin
import uvicorn
from elasticsearch import AsyncElasticsearch
from fastapi import Depends, FastAPI, Header, HTTPException
from firebase_admin import auth as firebase_auth
from motor.motor_asyncio import AsyncIOMotorClient
from openai import AsyncOpenAI, OpenAIError
from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV = os.environ.get("ENV", "local")
# Local reads the test file first, then the developer's own; the process environment wins over both.
ENV_FILES = {"local": (".env.test", ".env.local"), "test": (".env.test",)}.get(ENV, (".env",))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILES, extra="ignore")

    PORT: int = 8000
    OPENAI_API_KEY: str
    OPENAI_BASE_URL: str = "https://api.openai.com/v1"
    MODEL: str = "gpt-6-astra"
    MONGO_URI: str
    MONGO_DB: str = "research"
    PG_DSN: str
    ELASTICSEARCH_URL: str
    FIREBASE_AUTH_EMULATOR_HOST: str = ""
    FIREBASE_PROJECT_ID: str = "demo-twin"
    ADMIN_TOKEN: str = ""


settings = Settings()
if settings.FIREBASE_AUTH_EMULATOR_HOST:
    os.environ.setdefault("FIREBASE_AUTH_EMULATOR_HOST", settings.FIREBASE_AUTH_EMULATOR_HOST)
firebase_admin.initialize_app(options={"projectId": settings.FIREBASE_PROJECT_ID})

ANSWERER_PROMPT = """You are the quick-answer stage of a legal research system for Jordanian litigators.
- Write in Legal Arabic only.
- Name at least one text, with its citation, and say plainly when no text read states the point.
- Never open with yes or no, and never answer as a verdict.
- Copy every number from a text; never compute one.
- Never draft a document or advise on strategy."""

app = FastAPI(title="Research API")
mongo = AsyncIOMotorClient(settings.MONGO_URI)
threads = mongo[settings.MONGO_DB]["threads"]
library = mongo[settings.MONGO_DB]["library"]
search = AsyncElasticsearch(settings.ELASTICSEARCH_URL)
model = AsyncOpenAI(api_key=settings.OPENAI_API_KEY, base_url=settings.OPENAI_BASE_URL)
pool: asyncpg.Pool | None = None
answering: set[asyncio.Task] = set()


@app.on_event("startup")
async def startup() -> None:
    global pool
    pool = await asyncpg.create_pool(settings.PG_DSN, min_size=1, max_size=4)
    async with pool.acquire() as conn:
        await conn.execute("create table if not exists usage_log (thread_id text, at timestamptz, ok boolean, tokens int)")


def caller(authorization: str = Header(default="")) -> str:
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "sign in first")
    try:
        return firebase_auth.verify_id_token(token)["uid"]
    except Exception as err:  # an expired, forged or emulator-less token is the same refusal
        raise HTTPException(401, f"invalid token: {type(err).__name__}")


class Ask(BaseModel):
    request: str
    mode: str = "quick"
    attachment_ids: list[str] = []
    thread_id: str | None = None


async def answer(thread_id: str) -> None:
    await threads.update_one({"_id": thread_id}, {"$set": {"status": "running"}})
    thread = await threads.find_one({"_id": thread_id})
    asked = thread["turns"][-1]["text"]
    edition = (await library.find_one({"_id": "edition"}) or {}).get("name", "")
    hits = (await search.search(index="legislation", query={"match": {"text": asked}}, size=3))["hits"]["hits"]
    found = [h["_source"] for h in hits]
    await search.index(index="asks", document={"thread_id": thread_id, "asked": asked, "at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    await threads.update_one({"_id": thread_id}, {"$set": {"edition": edition, "sources": [t["cite"] for t in found]}})
    sources = "\n".join(f"[{t['cite']}] {t['text']}" for t in found)
    messages = [{"role": "system", "content": f"{ANSWERER_PROMPT}\n\nLibrary edition: {edition}\nTexts read for this request:\n{sources}"}]
    messages += [{"role": t["role"], "content": t["text"]} for t in thread["turns"]]
    ok, tokens = False, 0
    try:
        reply = await model.chat.completions.create(model=settings.MODEL, messages=messages)
        said = reply.choices[0].message.content or ""
        tokens = reply.usage.total_tokens if reply.usage else 0
        ok = True
        await threads.update_one({"_id": thread_id}, {"$set": {"status": "answered", "answer": said}, "$push": {"turns": {"role": "assistant", "text": said}}})
    except OpenAIError as err:
        await threads.update_one({"_id": thread_id}, {"$set": {"status": "failed", "error": str(err)[:300]}})
    async with pool.acquire() as conn:
        await conn.execute("insert into usage_log values ($1, $2, $3, $4)", thread_id, datetime.datetime.now(datetime.timezone.utc), ok, tokens)


@app.post("/v2/research/ask")
async def ask(body: Ask, uid: str = Depends(caller)) -> dict:
    if body.thread_id:
        thread_id = body.thread_id
        found = await threads.find_one({"_id": thread_id, "owner": uid})
        if not found:
            raise HTTPException(404, "no such thread")
        await threads.update_one({"_id": thread_id}, {"$set": {"status": "pending", "answer": None}, "$push": {"turns": {"role": "user", "text": body.request}}})
    else:
        thread_id = uuid.uuid4().hex
        await threads.insert_one({"_id": thread_id, "owner": uid, "mode": body.mode, "status": "pending", "answer": None, "turns": [{"role": "user", "text": body.request}]})
    task = asyncio.create_task(answer(thread_id))
    # The loop keeps only a weak reference to a task; one nothing holds can vanish mid-answer.
    answering.add(task)
    task.add_done_callback(answering.discard)
    return {"thread_id": thread_id, "status": "pending"}


@app.get("/v2/research/threads/{thread_id}")
async def thread(thread_id: str, uid: str = Depends(caller)) -> dict:
    found = await threads.find_one({"_id": thread_id, "owner": uid})
    if not found:
        raise HTTPException(404, "no such thread")
    return {"thread_id": thread_id, "status": found["status"], "answer": found.get("answer"), "error": found.get("error"), "edition": found.get("edition"), "sources": found.get("sources")}


@app.post("/v1/admin/billing/{org_id}/suspend")
async def suspend(org_id: str, x_admin_token: str = Header(default="")) -> dict:
    if not settings.ADMIN_TOKEN or x_admin_token != settings.ADMIN_TOKEN:
        raise HTTPException(403, "admin only")
    return {"suspended": org_id}


@app.get("/health")
async def health() -> dict:
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=settings.PORT)
