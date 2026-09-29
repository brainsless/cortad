# Which request a model call belongs to when it is made outside every request: a framework that
# queues the handler and runs it later on its own worker (a UI framework's queue), an app that hands
# the work to a thread pool, a job whose result is fetched on a second request.
#
# The call is pinned to the request that asked: the one still open whose words are in the prompt, the
# one an open request is tied to by an id it sent or got back (the answer is being fetched), or, when
# the call starts before that fetch, the newest request whose words are in the prompt, if every such
# request shares its id (one client's turn). Anything less pins nothing: never a guess.
#
# The request that asked answered only when it ended with none of its calls still running; otherwise
# the next request tied to it by an id carries the answer, and completes the exchange when it ends.
import collections
import json
import re
import time
from urllib.parse import parse_qsl

# A value made to name one thing: a session hash, an event id, a job number.
ID = re.compile(r"^(?=.*\d)[\w.:-]{6,200}$")
RECENT_KEPT, RECENT_MS = 32, 300000
# The requests a client sends just before the one that asked, carrying the same id, are part of its
# turn (a chat UI shows the message with one event, then answers it with the next).
BEFORE_MS = 60000
PROMPTS_KEPT, PROMPT_HEAD = 64, 500


def _scalars(v, out, depth=0):
    if depth > 12 or len(out) > 2000:
        return out
    if isinstance(v, str) or (isinstance(v, int) and not isinstance(v, bool)):
        out.append(str(v))
    elif isinstance(v, list):
        for x in v:
            _scalars(x, out, depth + 1)
    elif isinstance(v, dict):
        for x in v.values():
            _scalars(x, out, depth + 1)
    return out


def _json(raw):
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def _address_ids(req):
    path, _, query = req["path"].partition("?")
    return {v for v in path.split("/") + [v for _, v in parse_qsl(query)] if ID.match(v)}


class Tied:
    # `body_of(req)` and `reply_of(req)` read what a request carried and what the app answered.
    def __init__(self, norm, body_of, reply_of):
        self.norm, self.body_of, self.reply_of = norm, body_of, reply_of
        self.open = {}
        self.recent = collections.deque(maxlen=RECENT_KEPT)
        # The heads of the prompts this process sent: one arriving at a server in the same process (an
        # app that serves its own model) is a model call, never a person asking.
        self.prompts = collections.deque(maxlen=PROMPTS_KEPT)

    def _ids(self, req):
        if "ids" not in req:
            got = _scalars(_json(self.body_of(req)), []) + _scalars(_json(self.reply_of(req)), [])
            req["ids"] = _address_ids(req) | {v for v in got if ID.match(v)}
        return req["ids"]

    # The person's words: a value with a space or a letter outside ASCII, long enough to be a sentence.
    def _says(self, req, prompt):
        return any(len(v) >= 8 and (" " in v or not v.isascii()) and self.norm(v) in prompt for v in _scalars(_json(self.body_of(req)), []))

    # The newest request that asked before `req` and shares an id with its address.
    def _asker(self, req, pinned_only=False):
        mine = _address_ids(req)
        now = int(time.time() * 1000)
        for t in reversed(list(self.recent)) if mine else []:
            if t["at"] <= req["at"] and now - t["at"] <= RECENT_MS and (t.get("pinned") or not pinned_only):
                shared = mine & self._ids(t)
                if shared:
                    return t, shared
        return None

    def opened(self, req):
        self.open[req["id"]] = req
        found = self._asker(req, pinned_only=True)
        if found:
            req["asker"], req["tie"] = found

    # The requests of the exchange this request completes, the one that asked last, or None. A
    # request that asked and has not answered is kept to be answered on a later one.
    def closed(self, req):
        self.open.pop(req["id"], None)
        asker = req.get("asker")
        if asker and asker.get("kept") and not asker.get("written") and not asker.get("calls_open"):
            before = [p for p in list(self.recent) if p is not asker and p["at"] < asker["at"] and asker["at"] - p["at"] <= BEFORE_MS and self._ids(p) & req["tie"]]
            for s in before + [asker]:
                try:
                    self.recent.remove(s)
                except ValueError:
                    pass
            return before + [asker]
        if req["method"] != "GET" and self.body_of(req)[:PROMPT_HEAD] not in self.prompts and (not req.get("noted") or req.get("calls_open")):
            self.recent.append(req)
        return None

    def sent(self, prompt):
        self.prompts.append(prompt[:PROMPT_HEAD])

    # The request that asked for the call made with `sent`, or None.
    def pinned(self, sent):
        prompt = self.norm(sent)
        found = {}
        for r in list(self.open.values()):
            if r.get("asker"):
                found[id(r["asker"])] = (r["asker"], None)
            elif r["method"] != "GET" and self._says(r, prompt):
                found[id(r)] = (r, None)
            else:
                asker = self._asker(r)
                if asker:
                    found[id(asker[0])] = (asker[0], (r, asker[1]))
        if not found:
            sayers = [t for t in list(self.recent) if self._says(t, prompt)]
            if sayers and all(self._ids(t) & self._ids(sayers[-1]) for t in sayers[:-1]):
                found[id(sayers[-1])] = (sayers[-1], None)
        if len(found) > 1:
            found = {k: f for k, f in found.items() if self._says(f[0], prompt)}
        if len(found) != 1:
            return None
        asker, fetch = next(iter(found.values()))
        if fetch:
            fetch[0]["asker"], fetch[0]["tie"] = asker, fetch[1]
        asker["pinned"] = True
        asker["calls_open"] = asker.get("calls_open", 0) + 1
        return asker

    # A pinned call has answered or failed.
    @staticmethod
    def done(req):
        if req and req.get("pinned"):
            req["calls_open"] = max(0, req.get("calls_open", 0) - 1)
