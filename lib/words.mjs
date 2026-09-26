// The small pieces every rendering shares: numbers with their units, file and line, whose side a
// stop is on, and the pages a long answer is cut into.

// Copilot cuts a result past about 10 KB; a page stays under this.
export const PAGE_CHARS = 9000;
export const SIDE = { theirs: "on the app's side", ours: "on Cortad's side" };

export const has = (v) => v !== undefined && v !== null;
export const num = (x) => (typeof x === "number" ? Math.round(x).toLocaleString("en-US") : String(x));
export const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
export const upper = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
export const at = (path, line) => `${path}${has(line) ? `:${line}` : ""}`;
export const clip = (s, max) => (String(s).length > max ? `${String(s).slice(0, max - 3)}...` : String(s));

// One page of many, with the call that reads the next one: `next(2)` gives "findings with page 2".
export function pageOf(pages, page, next) {
  const n = Math.min(Math.max(1, Math.floor(Number(page)) || 1), pages.length);
  const tail = pages.length === 1 ? "" : n < pages.length ? `\npage ${n} of ${pages.length}, call ${next(n + 1)}` : `\npage ${n} of ${pages.length}`;
  return `${pages[n - 1]}${tail}`;
}

// Lines packed into pages under PAGE_CHARS; every page after the first opens with `continued`.
export function pack(head, lines, continued, budget = PAGE_CHARS - 80) {
  const pages = [];
  let page = head;
  let filled = false;
  for (const line of lines) {
    if (filled && page.length + line.length + 1 > budget) {
      pages.push(page);
      page = continued;
      filled = false;
    }
    page += `\n${line}`;
    filled = true;
  }
  return [...pages, page];
}
