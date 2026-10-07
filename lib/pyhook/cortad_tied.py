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
# A request whose reply went out before any model call was made for it (a webhook that queues the
# message and answers at once) and that no request comes to fetch is answered later, by its model:
# the exchange is written once its calls have gone quiet.
import collections
import contextvars
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
# How much of a sentence the model wrote a fetched reply has to carry to be the answer.
CARRY = 60
# tied.cjs UNDER_WAY: a job's own word for work still going on.
UNDER_WAY = re.compile(r"^(?:queued|pending|waiting|scheduled|submitted|accepted|created|starting|started|running|processing|generating|working|thinking|searching|retrieving|streaming|in[_ -]?progress|not[_ -]?(?:started|ready))$", re.I)


def _under_way(v, depth=0):
    if depth > 4:
        return False
    if isinstance(v, list):
        return bool(v) and _under_way(v[-1], depth + 1)
    if not isinstance(v, dict):
        return False
    state = v.get("status", v.get("state"))
    if isinstance(state, str) and UNDER_WAY.match(state):
        return True
    return any(isinstance(x, (list, dict)) and _under_way(x, depth + 1) for x in v.values())
# The ask the last call pinned in this handler's context was made for. A queue runs each handler in a
# context of its own, so its later calls, which carry none of the person's words, are told apart by
# it when several asks are open at once. Only a tiebreak: it never outranks what the rules decide.
_HELD = contextvars.ContextVar("cortad_asker", default=None)


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


def _sentence(v):
    return len(v) >= 8 and (any(c.isspace() for c in v) or not v.isascii())


# Whether a reply says something of its own, read as the person's words are: an "ok" or an id says nothing.
def _speaks(text):
    v = _json(text)
    return any(_sentence(x) for x in (_scalars(v, []) if v is not None else [str(text or "")]))


def _address_ids(req):
    path, _, query = req["path"].partition("?")
    return {v for v in path.split("/") + [v for _, v in parse_qsl(query)] if ID.match(v)}


# tied.cjs saidSentences: a JSON answer the clip cut short is read by its strings.
def _said_sentences(text):
    text = text.decode("utf-8", "replace") if isinstance(text, (bytes, bytearray)) else str(text or "")
    v = _json(text)
    whole = [s for s in (_scalars(v, []) if v is not None else [text]) if _sentence(s)]
    if len(whole) != 1 or not re.match(r"\s*[\[{]", whole[0]):
        return whole
    return [m for m in re.findall(r'"((?:[^"\\]|\\.){8,})"', whole[0]) if _sentence(m)]


class Tied:
    # `body_of(req)` and `reply_of(req)` read what a request carried and what the app answered.
    # `said_of(req)`: what the model calls made for an ask answered later have written, one entry a
    # call and none before one has, None where the hook hears none (tied.cjs saidOf).
    def __init__(self, norm, body_of, reply_of, said_of=None):
        self.norm, self.body_of, self.reply_of = norm, body_of, reply_of
        self.said_of = said_of or (lambda req: None)
        self.open = {}
        self.recent = collections.deque(maxlen=RECENT_KEPT)
        # The heads of the prompts this process sent: one arriving at a server in the same process (an
        # app that serves its own model) is a model call, never a person asking.
        self.prompts = collections.deque(maxlen=PROMPTS_KEPT)
        # The ask each id's last answered turn was made by: no request up to it is a step of a later
        # turn, even one that never became an exchange.
        self.answered = collections.OrderedDict()

    def _ids(self, req):
        if "ids" not in req:
            got = _scalars(_json(self.body_of(req)), []) + _scalars(_json(self.reply_of(req)), [])
            req["ids"] = _address_ids(req) | {v for v in got if ID.match(v)}
        return req["ids"]

    # The person's words: a value with a space or a letter outside ASCII, long enough to be a sentence.
    def _words(self, req):
        return [v for v in _scalars(_json(self.body_of(req)), []) if _sentence(v)]

    # tied.cjs sentencesIn: a body that is not JSON (a form post, plain text) is read as the text it is.
    def sentences(self, req):
        raw = self.body_of(req)
        v = _json(raw)
        text = raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else str(raw or "")
        return [s for s in (_scalars(v, []) if v is not None else [text]) if _sentence(s)]

    def _says(self, req, prompt):
        return any(self.norm(v) in prompt for v in self._words(req))

    # Among one client's requests whose words the prompt carries, the one being answered: the one whose
    # calls have begun and that has not settled (a later step of its work, while the next message sits
    # in the prompt as history the app saved as it arrived), else the one whose own words sit last in
    # the prompt. Requests that all carry the same words are the steps of one turn, the newest the one
    # answered (a chat UI shows the message with one event and answers it with the next). None when
    # that still leaves more than one: a missing answer, never a wrong one.
    def _answering(self, sayers, prompt):
        if len(sayers) == 1:
            return sayers[0]
        begun = [t for t in sayers if t.get("pinned")]
        if len(begun) == 1:
            return begun[0]
        pool = begun or sayers
        words = {id(t): self._words(t) for t in pool}
        own = {id(t): [v for v in words[id(t)] if self.norm(v) in prompt and not any(o is not t and v in words[id(o)] for o in pool)] for t in pool}
        if not any(own.values()):
            return pool[-1]
        first, second = sorted(((max([prompt.rfind(self.norm(v)) for v in own[id(t)]], default=-1), t) for t in pool), key=lambda p: p[0], reverse=True)[:2]
        return first[1] if first[0] >= 0 and first[0] != second[0] else None

    # The newest request that asked before `req` and shares an id with its address.
    def _asker(self, req, pinned_only=False):
        mine = _address_ids(req)
        now = int(time.time() * 1000)
        for t in reversed(list(self.recent)) if mine else []:
            # A request answered later is fetched afterwards only by a read of it, never by a new message.
            if t["at"] <= req["at"] and now - t.get("call_at", t["at"]) <= RECENT_MS and (t.get("pinned") or not pinned_only) and (not t.get("settled") or req["method"] == "GET"):
                shared = mine & self._ids(t)
                if shared:
                    return t, shared
        return None

    def opened(self, req):
        self.open[req["id"]] = req
        found = self._asker(req, pinned_only=True)
        if found:
            req["asker"], req["tie"] = found
            found[0]["fetched"] = True

    # The requests of the exchange this request completes, the one that asked last, or None. A
    # request that asked and has not answered is kept to be answered on a later one. Once answered it
    # leaves, written or not: a later turn's fetch tied by the same id is never pinned to it.
    def closed(self, req):
        self.open.pop(req["id"], None)
        asker = req.get("asker")
        if asker and not asker.get("written") and not asker.get("calls_open") and self._carries(req, asker):
            since = max([self.answered[i] for i in req["tie"] if self.answered.get(i, asker["at"]) < asker["at"]], default=0)
            before = [p for p in list(self.recent) if p is not asker and not p.get("settled") and since < p["at"] < asker["at"] and asker["at"] - p["at"] <= BEFORE_MS and self._ids(p) & req["tie"]]
            for s in before + [asker]:
                try:
                    self.recent.remove(s)
                except ValueError:
                    pass
            asker["answered"] = True
            self._answered(req["tie"], asker["at"])
            return before + [asker]
        if req["method"] != "GET" and self.body_of(req)[:PROMPT_HEAD] not in self.prompts and (not req.get("noted") or req.get("calls_open") or req.get("late")):
            self.recent.append(req)
        return None

    # tied.cjs carries: a page polling for an answer several calls build comes back many times
    # between two of them, on a document with no answer in it yet.
    def _carries(self, fetch, asker):
        said = self.said_of(asker)
        if said is None:
            return True
        raw = self.reply_of(fetch)
        if _under_way(_json(raw)):
            return False
        reply = self.norm(raw)
        return any(self.norm(w)[:CARRY] in reply for one in (said if isinstance(said, (list, tuple)) else [said]) for w in _said_sentences(one))

    def _answered(self, tie, at):
        for i in tie:
            self.answered.pop(i, None)
            self.answered[i] = at
        while len(self.answered) > RECENT_KEPT * 8:
            self.answered.popitem(last=False)

    def sent(self, prompt):
        self.prompts.append(prompt[:PROMPT_HEAD])

    # Asks reached through one session are one client's turns, the newest the one being answered: a
    # client holds a second stream open on its session (a heartbeat) that points at an older ask.
    @staticmethod
    def _one_client(found):
        ties = [f[2] for f in found.values()]
        return all(ties) and bool(set.intersection(*map(set, ties)))

    # The request that asked for the call made with `sent`, or None. `held`: the request whose context
    # the call was made in after that request's reply went out, which only breaks a tie.
    def pinned(self, sent, held=None):
        prompt = self.norm(sent)
        found = {}
        # Each: the ask, the open fetch to tie to it, and the ids of the session it was reached through.
        # A read of a request already answered later can complete that request's exchange, never be
        # the one a new call answers. A read stands for a request still working, except for a call that
        # carries another unsettled request's words and none of its own: that call is the other one's
        # (a page polling the sender while the next message is worked on). A receipt's fetch carries no
        # message.
        def reads(asker):
            if asker.get("settled"):
                return False
            others = list(self.recent) + list(self.open.values())
            return self._says(asker, prompt) or not any(t is not asker and t["method"] != "GET" and not t.get("settled") and self._says(t, prompt) for t in others)
        for r in list(self.open.values()):
            if r.get("asker"):
                if reads(r["asker"]):
                    found[id(r["asker"])] = (r["asker"], None, r.get("tie") or set())
            # A request whose own context made a model call is served there; a call outside it is not its.
            elif r["method"] != "GET" and (not r.get("noted") or r.get("pinned")) and self._says(r, prompt):
                found[id(r)] = (r, None, set())
            else:
                asker = self._asker(r)
                if asker and reads(asker[0]):
                    found[id(asker[0])] = (asker[0], (r, asker[1]), asker[1])
        sayers = []
        if not found:
            sayers = [t for t in list(self.recent) if not t.get("settled") and self._says(t, prompt)]
            turn = self._answering(sayers, prompt) if sayers and all(self._ids(t) & self._ids(sayers[-1]) for t in sayers[:-1]) else None
            if turn:
                found[id(turn)] = (turn, None, set())
        candidates = dict(found) or {id(t): (t, None, set()) for t in sayers}
        if len(found) > 1 and not self._one_client(found):
            found = {k: f for k, f in found.items() if self._says(f[0], prompt)}
        if len(found) > 1 and self._one_client(found):
            newest = max(found.values(), key=lambda f: f[0]["at"])
            found = {id(newest[0]): newest}
        if len(found) != 1:
            held = next((h for h in (_HELD.get(), held) if h and not h.get("answered") and (not candidates or id(h) in candidates)), None)
            if not held:
                return None
            found = {id(held): candidates.get(id(held), (held, None, set()))}
        asker, fetch, _ = next(iter(found.values()))
        if fetch:
            fetch[0]["asker"], fetch[0]["tie"] = asker, fetch[1]
            asker["fetched"] = True
        if not asker.get("noted") and asker.get("finished"):
            asker["late"] = True
        asker["pinned"] = True
        asker["calls_open"] = asker.get("calls_open", 0) + 1
        asker["call_at"] = int(time.time() * 1000)
        _HELD.set(asker)
        return asker

    # A call made for the request has answered or failed. Each call is counted once, in `waiting` (its
    # own, while it has not been answered later) or in `calls_open`: the two together are its calls
    # still running, and one ending takes one off.
    @staticmethod
    def done(req):
        if not req:
            return
        if req.get("waiting"):
            req["waiting"] -= 1
        else:
            req["calls_open"] = max(0, req.get("calls_open", 0) - 1)

    # A call made in a request's own context: its own, unless the request's reply went out before any
    # model call answered it. Then a loop the request started (a queue drained from its handler) can
    # keep its context while it works through later messages, so the call is its own only when the
    # prompt carries its words, and is otherwise pinned as a call made outside every request is, the
    # context breaking a tie. A request that answered with its own model call keeps every later one
    # (a title written after the reply). A request whose reply went out before its first call is
    # answered later.
    def inside(self, req, sent):
        if req.get("finished") and (not req.get("noted") or req.get("late")) and not self._says(req, self.norm(sent)):
            return self.pinned(sent, req)
        if not req.get("noted") and req.get("finished"):
            req["late"] = True
        if req.get("late"):
            req["pinned"] = True
            req["calls_open"] = req.get("calls_open", 0) + 1
            req["call_at"] = int(time.time() * 1000)
        else:
            req["waiting"] = req.get("waiting", 0) + 1
        return req

    # The request's reply has gone out, with `status`, and `text()` reads it. One whose reply only took
    # the message (a 2xx that says nothing of its own) while its model calls are still running and
    # none of them has answered (a task the handler started without waiting on it) is answered later,
    # those calls with it. A reply that says something, an apology after a time limit or an error, is
    # the answer the person got. `heard`: a model call made for it got its response, set as the
    # response arrives, so a stream the app passes straight on is never taken for one (lib/tied.cjs).
    @staticmethod
    def replied(req, status, text):
        req["finished"] = True
        if req.get("heard") or req.get("late") or not (req.get("waiting") or req.get("calls_open")):
            return
        if not (200 <= int(status or 0) < 300) or _speaks(text()):
            return
        req["late"] = req["pinned"] = True
        req["calls_open"] = req.get("calls_open", 0) + req.get("waiting", 0)
        req["waiting"] = 0

    # Whether a request answered later is done, once: it has ended, none of its calls is open, and no
    # request tied to it came to fetch the answer. It stays where a fetch that comes later can still
    # find it and complete the exchange on a second request, but no call is pinned to it by its words.
    def settled(self, req):
        if not req or not req.get("late") or not req.get("ended") or req.get("calls_open") or req.get("waiting") or req.get("written") or req.get("settled") or (req.get("fetched") and self.said_of(req) is None):
            return False
        req["settled"] = req["answered"] = True
        return True
