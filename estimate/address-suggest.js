// Address suggestions for the homepage and the estimator: a small, accessible combobox that is only an enhancement of a
// plain text input (without JavaScript, or when the service fails, the field works as before).
// Rules: nothing is sent until MIN_CHARS characters are typed; requests are debounced (300 ms); at most one request is in
// flight (a new one cancels the old one); at most MAX_ITEMS suggestions; every failure is silent. Choosing a suggestion only
// fills the field: submitting the form is still the only thing that starts a lookup. Suggestion text is shown as text, never
// as markup. Nothing is stored.
import { laCamsAddress } from '../core/providers/la-cams-address.js';

export const MIN_CHARS = 5;
export const DEBOUNCE_MS = 300;
export const MAX_ITEMS = 5;

/**
 * A suggestion source: {id, label, suggest(text, {signal}) -> Promise<string[]>}. Throwing or returning nothing is fine.
 * Los Angeles County's public address service (the CAMS locator `suggest` call; CORS verified for the site origin).
 */
export const countySource = {
  id: 'la-county', label: "Los Angeles County's public address service",
  async suggest(text, { signal }) {
    // core/providers fetch helper makes its own AbortController; link ours to it so a new keystroke cancels the request.
    const linked = (url, init = {}) => {
      const ctl = new AbortController();
      const stop = () => ctl.abort();
      if (signal?.aborted) ctl.abort(); else signal?.addEventListener('abort', stop, { once: true });
      if (init.signal) init.signal.addEventListener('abort', stop, { once: true });
      return fetch(url, { ...init, signal: ctl.signal });
    };
    const r = await laCamsAddress.suggest(text, { fetch: linked, now: new Date().toISOString() });
    return r.ok ? r.suggestions.map((s) => s.text) : [];
  },
};

/**
 * EXTENSION POINT. Add a source here to get its suggestions too (they are asked after the county's, only when it returns
 * fewer than MAX_ITEMS). A Google Places source can be plugged in later, once there is a browser key restricted by referrer
 * and Places terms are accepted: it would implement the same {id, label, suggest} shape and be pushed onto this array.
 * No Google code, key or script tag exists in this build.
 */
export const EXTRA_SOURCES = [];

let uid = 0;

/**
 * @param {HTMLInputElement} input   a text input inside a positioned wrapper (`.suggest-wrap`)
 * @param {{sources?:Array<{suggest:Function}>, debounceMs?:number, minChars?:number, maxItems?:number}} [opts]
 */
export function attachAddressSuggest(input, opts = {}) {
  if (!input || input.dataset.suggest === 'on') return null;
  const wrap = input.closest('.suggest-wrap') ?? input.parentElement;
  if (!wrap) return null;
  const sources = opts.sources ?? [countySource, ...EXTRA_SOURCES];
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS, minChars = opts.minChars ?? MIN_CHARS, maxItems = opts.maxItems ?? MAX_ITEMS;
  const id = `addr-sug-${++uid}`;

  const list = document.createElement('ul');
  list.id = `${id}-list`; list.className = 'suggest-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Address suggestions'); list.hidden = true;
  const live = document.createElement('div');
  live.className = 'sr-only'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
  wrap.append(list, live);
  input.dataset.suggest = 'on';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-haspopup', 'listbox');

  let items = [], active = -1, timer = null, ctl = null, seq = 0;

  const close = () => {
    list.hidden = true; list.textContent = ''; items = []; active = -1;
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  };
  const cancel = () => { seq++; if (timer) { clearTimeout(timer); timer = null; } if (ctl) { ctl.abort(); ctl = null; } };
  const setActive = (i) => {
    active = i;
    [...list.children].forEach((li, k) => { li.setAttribute('aria-selected', k === i ? 'true' : 'false'); li.classList.toggle('active', k === i); });
    if (i >= 0) { input.setAttribute('aria-activedescendant', `${id}-o${i}`); list.children[i]?.scrollIntoView?.({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
  };
  const choose = (i) => {
    const t = items[i];
    if (typeof t !== 'string') return;
    input.value = t; // programmatic: fires no `input` event, so no new request and no submit
    close(); live.textContent = '';
  };
  const open = (texts) => {
    items = texts; list.textContent = '';
    texts.forEach((t, i) => {
      const li = document.createElement('li');
      li.id = `${id}-o${i}`; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false'); li.textContent = t; // text, never markup
      li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field
      li.addEventListener('click', () => { choose(i); input.focus(); });
      list.append(li);
    });
    list.hidden = false; active = -1;
    input.setAttribute('aria-expanded', 'true'); input.removeAttribute('aria-activedescendant');
    live.textContent = `${texts.length} address suggestion${texts.length === 1 ? '' : 's'}. Use the up and down arrow keys, then Enter.`;
  };

  async function ask(text, mine) {
    const out = [];
    try {
      for (const src of sources) {
        if (out.length >= maxItems) break;
        const got = await src.suggest(text, { signal: ctl?.signal });
        if (mine !== seq) return; // text changed meanwhile
        for (const t of Array.isArray(got) ? got : []) if (typeof t === 'string' && t.trim() && !out.includes(t)) out.push(t.slice(0, 200));
      }
    } catch { /* silent: the field still works as a plain input */ }
    if (mine !== seq) return;
    ctl = null;
    if (out.length && document.activeElement === input) open(out.slice(0, maxItems)); else close();
  }

  input.addEventListener('input', () => {
    cancel(); close();
    const text = input.value.trim();
    if (text.length < minChars) return;
    const mine = seq;
    timer = setTimeout(() => {
      timer = null;
      if (mine !== seq) return;
      ctl = new AbortController();
      ask(text, mine);
    }, debounceMs);
  });
  input.addEventListener('keydown', (e) => {
    const isOpen = !list.hidden && items.length > 0;
    if (e.key === 'ArrowDown' && isOpen) { e.preventDefault(); setActive((active + 1) % items.length); }
    else if (e.key === 'ArrowUp' && isOpen) { e.preventDefault(); setActive(active <= 0 ? items.length - 1 : active - 1); }
    else if (e.key === 'Enter' && isOpen && active >= 0) { e.preventDefault(); choose(active); } // only fills the field; a second Enter submits
    else if (e.key === 'Escape' && isOpen) { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', () => { cancel(); close(); });
  input.form?.addEventListener('submit', () => { cancel(); close(); });
  return { close, destroy() { cancel(); close(); list.remove(); live.remove(); delete input.dataset.suggest; } };
}
