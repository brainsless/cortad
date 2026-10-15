"""A model provider for the twin, speaking OpenAI's wire: it lists models and answers chat
completions for one key and refuses every other key the way OpenAI does. A file named `slow` beside
it holds each answer that many seconds, and one named `down` makes it answer 503: the provider's own
failures, made on purpose."""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
KEY = os.environ["TWIN_PROVIDER_KEY"]
REFUSED = {"error": {"message": "Incorrect API key provided. You can find your API key at https://platform.openai.com/account/api-keys.", "type": "invalid_request_error", "param": None, "code": "invalid_api_key"}}


def reply_for(messages: list) -> str:
    system = next((m["content"] for m in messages if m["role"] == "system"), "")
    cite = system.split("[", 1)[1].split("]", 1)[0] if "[" in system else ""
    asked = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    if not cite:
        return "لم يرد في النصوص المقروءة ما ينص على هذه المسألة."
    return f"تنص {cite} على ما يتصل بالسؤال «{asked[:80]}»، ويقتصر الجواب على ما ورد في هذا النص."


class Provider(BaseHTTPRequestHandler):
    def send(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def allowed(self) -> bool:
        if self.headers.get("authorization", "") == f"Bearer {KEY}":
            return True
        self.send(401, REFUSED)
        return False

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/v1/models" and self.allowed():
            self.send(200, {"object": "list", "data": [{"id": "gpt-6-astra", "object": "model"}]})
        elif self.path.rstrip("/") != "/v1/models":
            self.send(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        if self.path.rstrip("/") != "/v1/chat/completions":
            return self.send(404, {"error": {"message": "not found"}})
        if not self.allowed():
            return
        if (HERE / "down").exists():
            return self.send(503, {"error": {"message": "The server is overloaded.", "type": "server_error"}})
        slow = HERE / "slow"
        if slow.exists():
            time.sleep(float(slow.read_text().strip() or "30"))
        said = reply_for(body.get("messages", []))
        self.send(200, {
            "id": f"chatcmpl-{time.time_ns()}", "object": "chat.completion", "created": int(time.time()), "model": body.get("model", "gpt-6-astra"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": said}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 180, "completion_tokens": 40, "total_tokens": 220},
        })

    def log_message(self, *_args) -> None:
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Provider).serve_forever()
