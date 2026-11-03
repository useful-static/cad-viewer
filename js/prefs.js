// The viewer's remembered choices (style, units, palette, background, a
// model's picked colours...), in localStorage under "cadv.*" keys. Storage
// may be off (a private window, a blocked site, a sandboxed frame), when every
// access throws: then a read is null and a write does nothing, so a choice is
// simply not remembered and nothing else fails.

const store = () => {
  try { return globalThis.localStorage || null; } catch { return null; }
};

// the stored string, or null (none stored, or storage off)
export function getPref(key) {
  try { return store()?.getItem(key) ?? null; } catch { return null; }
}

// store a string; null or undefined removes the key
export function setPref(key, value) {
  try {
    const s = store();
    if (!s) return;
    if (value === null || value === undefined) s.removeItem(key);
    else s.setItem(key, String(value));
  } catch { /* storage off or full */ }
}

// a stored JSON value, or `fallback` (none stored, storage off, or not JSON)
export function getPrefJSON(key, fallback = null) {
  const s = getPref(key);
  if (s === null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export const setPrefJSON = (key, value) => setPref(key, value === null || value === undefined ? null : JSON.stringify(value));
