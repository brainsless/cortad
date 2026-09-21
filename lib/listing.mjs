// Where a provider key is asked for its model listing: the base URL their app is pointed at, when
// their env sets one beside the key (OPENAI_BASE_URL beside OPENAI_API_KEY), else the provider's own
// host. A Fireworks key under OPENAI_API_KEY is refused by api.openai.com and works where it is sent.
export function listingUrl(name, canonical, values) {
  const prefix = name.replace(/_API_KEY$/, "");
  const base = values[`${prefix}_BASE_URL`] || values[`${prefix}_API_BASE`];
  if (!base) return canonical;
  try {
    const u = new URL(base);
    return /^https?:$/.test(u.protocol) ? `${base.replace(/\/+$/, "")}/models` : canonical;
  } catch { return canonical; }
}
