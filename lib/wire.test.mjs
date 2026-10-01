import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const { isModelCall } = createRequire(import.meta.url)("./wire.cjs");

// Ask A Question calls its model through LiteLLM's proxy at http://127.0.0.1:4115/chat/completions:
// five calls a request, none seen, and the run measured nothing.
const CASES = [
  ["127.0.0.1:4115", "/chat/completions", true],
  ["localhost:4000", "/completions", true],
  ["127.0.0.1:4115", "/embeddings", true],
  ["localhost:11434", "/v1/chat/completions", true],
  ["localhost:11434", "/api/chat", true],
  ["api.openai.com", "/v1/responses", true],
  ["slack.com", "/api/chat.postMessage", false],
  ["hooks.example.com", "/messages", false],
  ["crm.example.com", "/responses", false],
  ["api.example.com", "/chat", false],
];

test("an OpenAI-shaped path is a model call on any host; other model paths need a version or /api/", () => {
  for (const [host, path, want] of CASES) assert.equal(isModelCall(host, path), want, `${host}${path}`);
});

// The Python hook's own function, lifted out of sitecustomize.py with the patterns it reads, run on
// the same cases: the two hooks never disagree on what a model call is.
test("the Python hook draws the same line", () => {
  const out = execFileSync("python3", ["-c", `
import json, re, sys
from urllib.parse import urlsplit
text = open("lib/pyhook/sitecustomize.py").read()
ns = {"re": re, "urlsplit": urlsplit}
for name in ("model_host", "model_path"):
    m = re.search(r"^\\s*" + name + r" = (re\\.compile\\(.*\\))$", text, re.M)
    ns[name] = eval(m.group(1), {"re": re})
start = text.index("    def is_model_call(url):")
body = text[start:text.index("\\n\\n", start)]
exec("\\n".join(l[4:] for l in body.splitlines()), ns)
cases = json.loads(sys.argv[1])
print(json.dumps([ns["is_model_call"]("http://" + c[0] + c[1]) for c in cases]))
`, JSON.stringify(CASES)], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), CASES.map((c) => c[2]));
});

// MIT Learn AI's search results ran to 8,000 characters and were kept at 3,000; a podcast episode in the
// part cut off was graded as made up.
test("a tool answer is kept to 12,000 characters, and one longer says it was cut", () => {
  const { toolText } = createRequire(import.meta.url)("./wire.cjs");
  const eight = "episode ".repeat(1000);
  assert.deepEqual(toolText("search_courses", eight), { name: "search_courses", text: eight });
  const long = toolText("search_courses", "x".repeat(12_500), { provider: true });
  assert.equal(long.text.length, 12_000);
  assert.equal(long.cut, true);
  assert.equal(long.provider, true);
});
