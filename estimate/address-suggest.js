// Address suggestions for the homepage and the estimator: an accessible combobox that only enhances a plain text input
// (without JavaScript, or when every source fails, the field works as before, and the browser's own address autofill,
// autocomplete="street-address", keeps working alongside it).
// Rules: nothing is sent before MIN_CHARS characters; requests are debounced (DEBOUNCE_MS); at most one suggest request in
// flight (a new keystroke cancels the old one and its address checks); the previous list stays visible while the next one loads; answers are cached per
// typed text for the session, in memory only; at most MAX_ITEMS suggestions, the typed part highlighted; every failure is
// silent. Choosing a suggestion only fills the field: submitting the form is still the only thing that starts a lookup.
// Suggestion text is shown as text, never as markup. Nothing is stored.
//
// Sources are pluggable: registerSuggestionSource({id, suggest(text, signal), appliesTo?(text)}) adds one; they are asked
// in order until one returns suggestions. Sources exposed by core/providers/browser.js (optional `suggestionSources()`
// export) are asked after the registered ones.

import { parseUnit, withUnit, sameAddress } from './unit-adapter.js';

export const MIN_CHARS = 3;
export const DEBOUNCE_MS = 150;
export const MAX_ITEMS = 6;

/** Query string with %20 for spaces (ArcGIS-safe). */
const qs = (params) => new URLSearchParams(params).toString().replace(/\+/g, '%20');
const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
/** The US state the typed text ends with (", IL" or ", IL 60602"), or null. */
const typedState = (t) => { const m = /,\s*([A-Za-z]{2})\b(?:\s+\d{5}(?:-\d{4})?)?\s*$/.exec(String(t).trim()); const st = m?.[1].toUpperCase(); return st && US_STATES.has(st) ? st : null; };
const COUNTY_LOCATOR = 'https://public.gis.lacounty.gov/public/rest/services/CAMS_Locator/GeocodeServer';
const COUNTY_SUGGEST = `${COUNTY_LOCATOR}/suggest`;
const COUNTY_FIND = `${COUNTY_LOCATOR}/findAddressCandidates`;

// The county's `suggest` call does not check that the house number exists: for "5741 Corbin Ave" it offers that number in
// every community the street runs through (Chatsworth, Northridge, ...), and only one of them is a real address (seen live
// 2026-11-28; choosing a wrong one ended in "address not found"). So a suggestion that starts with a house number is checked
// against the county's address matcher, the same call the lookup makes, and the list shows the addresses that really match.
/** Fewest points the county matcher must give a candidate (the lookup's own cutoff, core/providers/la-cams-address.js). */
export const MIN_MATCH_SCORE = 85;
/** A check that takes longer than this is given up and the suggestion is shown as the county sent it. */
export const CHECK_TIMEOUT_MS = 2500;

/** "5741 Corbin Avenue, Chatsworth, CA" -> "5741 Corbin Avenue"; null when the suggestion has no house number (a street, a place). */
export function streetPart(suggestion) {
  const m = /^\s*(\d+[A-Za-z]?(?:\s+\d\/\d)?\s+[^,]+?)\s*,/.exec(String(suggestion ?? ''));
  return m ? m[1].replace(/\s+/g, ' ') : null;
}
const houseNumber = (s) => String(s ?? '').trim().split(/\s+/)[0].toLowerCase();
/** The matcher writes "…, Los Angeles, CA, 91356"; shown as "…, Los Angeles, CA 91356". */
const tidyMatch = (a) => a.trim().replace(/\s+/g, ' ').replace(/,\s*(\d{5}(?:-\d{4})?)$/, ' $1');

/**
 * The real addresses among the matcher's candidates for one street address: same house number, score at or above the cutoff,
 * best first, no repeats. Pure (exported for tests).
 * @param {string} street  e.g. "5741 Corbin Avenue"
 * @param {any} json       the findAddressCandidates answer
 * @returns {string[]|null} null when the answer is not usable
 */
export function realAddresses(street, json) {
  if (!Array.isArray(json?.candidates)) return null;
  const no = houseNumber(street);
  const ok = json.candidates.filter((c) => Number.isFinite(Number(c?.score)) && Number(c.score) >= MIN_MATCH_SCORE && typeof c?.address === 'string' && houseNumber(c.address) === no);
  ok.sort((a, b) => Number(b.score) - Number(a.score));
  return [...new Set(ok.map((c) => tidyMatch(c.address).slice(0, 200)))];
}

/** Street address (lower case) -> its real addresses. Session memory only; a failed check is not remembered. */
const checked = new Map();
async function checkStreet(street, signal) {
  const key = street.toLowerCase();
  if (checked.has(key)) return checked.get(key);
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), CHECK_TIMEOUT_MS); });
  const ask = (async () => {
    const res = await fetch(`${COUNTY_FIND}?${qs({ 'Single Line Input': street, outSR: '4326', maxLocations: '20', f: 'json' })}`, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const list = realAddresses(street, await res.json());
    if (list && !signal?.aborted) checked.set(key, list);
    return list;
  })().catch(() => null);
  try { return await Promise.race([ask, late]); } finally { clearTimeout(timer); }
}

/**
 * Replace each house-numbered suggestion by the addresses that really exist for its street address (in the order the
 * streets were suggested). A street whose check found nothing real is dropped; a check that failed leaves its suggestions
 * as they were; suggestions without a house number pass through.
 * @param {string[]} suggestions
 * @param {(street:string)=>Promise<string[]|null>} check
 */
export async function onlyRealAddresses(suggestions, check) {
  const streets = [...new Set(suggestions.map(streetPart).filter((s) => s !== null).map((s) => s.toLowerCase()))]; // at most MAX_ITEMS suggestions, so at most that many checks
  const answers = new Map(await Promise.all(streets.map(async (k) => /** @type {[string, string[]|null]} */ ([k, await check(suggestions.map(streetPart).find((s) => s?.toLowerCase() === k)).catch(() => null)]))));
  const out = [], done = new Set();
  for (const s of suggestions) {
    const k = streetPart(s)?.toLowerCase();
    if (!k) { out.push(s); continue; }
    const real = answers.get(k) ?? null;
    if (real === null) { out.push(s); continue; }
    if (!done.has(k)) { done.add(k); out.push(...real); }
  }
  return [...new Set(out)];
}

/** Los Angeles County's public address service (the CAMS locator `suggest` call, checked by its address matcher; CORS verified for the site origin). */
export const countySource = {
  id: 'la-county',
  // The county service only knows Los Angeles County: when the typed text names another state (", IL", "Chicago, IL 60602") it is not asked.
  appliesTo: (text) => { const st = typedState(text); return !st || st === 'CA'; },
  async suggest(text, signal) {
    const res = await fetch(`${COUNTY_SUGGEST}?${qs({ text: text.slice(0, 200), maxSuggestions: String(MAX_ITEMS), f: 'json' })}`, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const j = await res.json();
    const raw = Array.isArray(j?.suggestions) ? j.suggestions.map((s) => s?.text).filter((t) => typeof t === 'string') : [];
    return onlyRealAddresses(raw, (street) => checkStreet(street, signal));
  },
};

/** The registered sources, asked in this order. */
const SOURCES = [];
/**
 * Add a suggestion source. `suggest(text, signal)` returns strings (or {text} objects); throwing or returning nothing is fine.
 * `appliesTo(text)` may limit a source to some addresses. Registering the same id again replaces it.
 * @param {{id:string, suggest:(text:string, signal?:AbortSignal)=>Promise<any>, appliesTo?:(text:string)=>boolean}} source
 */
export function registerSuggestionSource(source) {
  if (!source || typeof source.id !== 'string' || typeof source.suggest !== 'function') throw new TypeError('registerSuggestionSource: {id, suggest} required');
  const i = SOURCES.findIndex((s) => s.id === source.id);
  if (i >= 0) SOURCES[i] = source; else SOURCES.push(source);
}
registerSuggestionSource(countySource);

/** Sources offered by core/providers/browser.js, loaded once when first needed (shape: {id, suggest(text, deps)}). */
let providerSources = null;
function loadProviderSources() {
  providerSources ??= import('../core/providers/browser.js').then((m) => {
    const list = typeof m.suggestionSources === 'function' ? m.suggestionSources() : [];
    return (Array.isArray(list) ? list : []).filter((s) => s && typeof s.id === 'string' && typeof s.suggest === 'function').map((s) => ({
      id: s.id, appliesTo: s.appliesTo,
      suggest: (text, signal) => s.suggest(text, { fetch: (u, init = {}) => fetch(u, { ...init, signal }), now: new Date().toISOString(), signal }),
    }));
  }).catch(() => []);
  return providerSources;
}

/** Suggestion text -> its coordinates, for sources that return them (Photon). Session memory only. */
const located = new Map();
/** The suggestion the owner last chose, with its coordinates (null when it had none, or after the owner types again). */
let picked = null;
/**
 * Coordinates of the chosen suggestion, if `text` is exactly that suggestion; otherwise null. The lookup uses them to skip geocoding.
 * @param {string} text
 * @returns {{text:string, lat:number, lng:number, precision?:string, source?:string}|null}
 */
export function getPickedLocation(text) {
  // a unit the owner added after choosing ("... Apt 4") does not change which address was chosen
  return picked && typeof text === 'string' && (picked.text === text.trim() || sameAddress(parseUnit(text).base, picked.text)) ? { ...picked } : null;
}

/**
 * Remember a location for an address that arrived already chosen (the homepage passes the chosen suggestion's coordinates to
 * the estimator in the URL fragment so the lookup does not geocode it a second time). Ignored unless the numbers are valid.
 * @param {{text:string, lat:number, lng:number, precision?:string, source?:string}} p
 */
export function setPickedLocation(p) {
  const lat = Number(p?.lat), lng = Number(p?.lng), text = typeof p?.text === 'string' ? p.text.trim() : '';
  if (!text || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  picked = { text: parseUnit(text).base, lat, lng, ...(typeof p.precision === 'string' && p.precision ? { precision: p.precision.slice(0, 40) } : {}), ...(typeof p.source === 'string' && p.source ? { source: p.source.slice(0, 60) } : {}) };
  return true;
}

/** Normalise any source answer to a list of strings (remembering the coordinates a suggestion carries). */
function texts(got) {
  const arr = Array.isArray(got) ? got : Array.isArray(got?.suggestions) ? got.suggestions : [];
  return arr.map((x) => {
    const t = typeof x === 'string' ? x : x?.text;
    if (typeof t !== 'string' || !t.trim()) return null;
    const text = t.slice(0, 200);
    if (x && typeof x === 'object' && Number.isFinite(x.lat) && Number.isFinite(x.lng)) located.set(text, { text, lat: x.lat, lng: x.lng, ...(typeof x.precision === 'string' ? { precision: x.precision } : {}), ...(typeof x.source === 'string' ? { source: x.source } : {}) });
    return text;
  }).filter((t) => t !== null);
}

/** Session cache, shared by every field on the page: typed text (normalised) -> suggestions. */
const cache = new Map();
const keyOf = (t) => t.trim().replace(/\s+/g, ' ').toLowerCase();

/** Ask the sources in order until one has suggestions. */
async function suggestFor(text, signal, sources) {
  const key = keyOf(text);
  if (cache.has(key)) return cache.get(key);
  const ask = async (list) => {
    for (const src of list) {
      if (signal?.aborted) return null;
      try {
        if (typeof src.appliesTo === 'function' && !src.appliesTo(text)) continue;
        const out = [...new Set(texts(await src.suggest(text, signal)))];
        if (signal?.aborted) return null;
        if (out.length) return out;
      } catch { if (signal?.aborted) return null; /* silent: try the next source */ }
    }
    return [];
  };
  let out = await ask(sources ?? SOURCES);
  if (out && !out.length && !sources) {
    const extra = (await loadProviderSources()).filter((s) => !SOURCES.some((r) => r.id === s.id));
    if (extra.length) out = await ask(extra);
  }
  if (out === null) return null;
  if (out.length) cache.set(key, out); // an empty or failed answer is asked again next time
  return out;
}

/** Append `text` to `el`, with the first case-insensitive occurrence of `typed` wrapped in <mark> (as text, never markup). */
function highlight(el, text, typed) {
  const t = typed.trim();
  const i = t ? text.toLowerCase().indexOf(t.toLowerCase()) : -1;
  if (i < 0) { el.textContent = text; return; }
  const m = document.createElement('mark');
  m.textContent = text.slice(i, i + t.length);
  el.append(document.createTextNode(text.slice(0, i)), m, document.createTextNode(text.slice(i + t.length)));
}

let uid = 0;

/**
 * @param {HTMLInputElement} input   a text input inside a positioned wrapper (`.suggest-wrap`)
 * @param {{sources?:Array<{id?:string, suggest:Function, appliesTo?:Function}>, debounceMs?:number, minChars?:number, maxItems?:number}} [opts]
 */
export function attachAddressSuggest(input, opts = {}) {
  if (!input || input.dataset.suggest === 'on') return null;
  const wrap = input.closest('.suggest-wrap') ?? input.parentElement;
  if (!wrap) return null;
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
    list.hidden = true; list.textContent = ''; items = []; active = -1; list.classList.remove('stale');
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  };
  const cancel = () => { seq++; if (timer) { clearTimeout(timer); timer = null; } if (ctl) { ctl.abort(); ctl = null; } list.classList.remove('stale'); };
  const setActive = (i) => {
    active = i;
    [...list.children].forEach((li, k) => { li.setAttribute('aria-selected', k === i ? 'true' : 'false'); li.classList.toggle('active', k === i); });
    if (i >= 0) { input.setAttribute('aria-activedescendant', `${id}-o${i}`); list.children[i]?.scrollIntoView?.({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
  };
  const choose = (i) => {
    const t = items[i];
    if (typeof t !== 'string') return;
    input.value = withUnit(t, parseUnit(input.value).designator); // programmatic: fires no `input` event, so no new request and no submit; a unit the owner typed stays
    picked = located.get(t) ?? null; // a source that returned coordinates lets the lookup skip geocoding
    cancel(); close(); live.textContent = '';
  };
  const open = (found, typed) => {
    items = found; list.textContent = ''; list.classList.remove('stale');
    found.forEach((t, i) => {
      const li = document.createElement('li');
      li.id = `${id}-o${i}`; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false');
      highlight(li, t, typed);
      li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field
      li.addEventListener('click', () => { choose(i); input.focus(); });
      list.append(li);
    });
    list.hidden = false; active = -1;
    input.setAttribute('aria-expanded', 'true'); input.removeAttribute('aria-activedescendant');
    live.textContent = `${found.length} address suggestion${found.length === 1 ? '' : 's'}. Use the up and down arrow keys, then Enter.`;
  };
  const show = (found, text) => {
    if (found && found.length && document.activeElement === input) open(found.slice(0, maxItems), text); else close();
  };

  input.addEventListener('input', () => {
    cancel();
    // the suggestions are asked for the address without its unit ("123 Main St Apt 4" asks for "123 Main St"); a chosen address stays chosen when only a unit is added
    const pu = parseUnit(input.value);
    if (!(picked && pu.unit && sameAddress(pu.base, picked.text))) picked = null;
    const text = (pu.unit ? pu.base : input.value).trim();
    if (text.length < minChars) { close(); return; }
    const hit = cache.get(keyOf(text));
    if (hit && !opts.sources) { show(hit, text); return; } // answered before in this session: instant, no request
    if (!list.hidden) list.classList.add('stale'); // keep the previous list visible while the next one loads
    const mine = seq;
    timer = setTimeout(async () => {
      timer = null;
      if (mine !== seq) return;
      ctl = new AbortController();
      const found = await suggestFor(text, ctl.signal, opts.sources);
      if (mine !== seq || found === null) return;
      ctl = null;
      show(found, text);
    }, debounceMs);
  });
  input.addEventListener('keydown', (e) => {
    const isOpen = !list.hidden && items.length > 0;
    if (e.key === 'ArrowDown' && isOpen) { e.preventDefault(); setActive((active + 1) % items.length); }
    else if (e.key === 'ArrowUp' && isOpen) { e.preventDefault(); setActive(active <= 0 ? items.length - 1 : active - 1); }
    else if (e.key === 'Enter' && isOpen && active >= 0) { e.preventDefault(); choose(active); } // only fills the field; a second Enter submits
    else if (e.key === 'Tab' && isOpen && active >= 0 && !e.shiftKey) choose(active); // fill, and let focus move on
    else if (e.key === 'Escape' && isOpen) { e.preventDefault(); e.stopPropagation(); cancel(); close(); }
    else if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', () => { cancel(); close(); });
  input.form?.addEventListener('submit', () => { cancel(); close(); });
  return { close, destroy() { cancel(); close(); list.remove(); live.remove(); delete input.dataset.suggest; } };
}
