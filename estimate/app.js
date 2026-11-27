// Everyspace public income estimator. UI and glue only: every number shown comes from the /core modules.
// Nothing the visitor types is stored (no localStorage, cookies, analytics or account); everything lives in memory.
// Network: address suggestions while typing (address-suggest.js) and, only after an explicit submit, the property lookup
// (county-path.js): Los Angeles County's public services first, the older OpenStreetMap path only when those cannot answer.
// The property screen appears as soon as the address and the parcel records are in; building-derived values and the
// optional map extras fill in afterwards without moving focus or replacing anything the owner typed.
import { runCountyPath, runOlderPath, sessionFetch, mergeProfile } from './county-path.js';
import { attachAddressSuggest, getPickedLocation, setPickedLocation } from './address-suggest.js';
import { createProfile } from '../core/profile.js';
import { confidenceLabel } from '../core/provenance.js';
import { identifyOpportunities, missingEvidence, defaultResourceCapacity } from '../core/opportunities.js';
import { defaultInputs, withOverrides, estimateOpportunity, summarize, INPUT_KEYS } from '../core/revenue.js';
import { optimize, GOALS } from '../core/optimizer.js';
import { SCENARIO_NAMES } from '../core/data/scenarios.js';
import { ATTRIBUTE_QUESTIONS } from '../core/data/categories.js';
import { initLotMap } from './lot-map.js';

// ---------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowIso = () => new Date().toISOString();
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const pct = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
/** Money from integer cents (formatting only). */
const money = (cents) => usd0.format(cents / 100);
const money2 = (cents) => usd2.format(cents / 100);
const dateText = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

// ---------------------------------------------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------------------------------------------
const TAG_WORDS = { measured: 'Measured', estimated: 'Estimated', 'owner-confirmed': 'You confirmed', unavailable: 'Not set' };
const TAG_CLASS = { measured: 'ok', estimated: 'warn', 'owner-confirmed': 'accent', unavailable: '' };
const TAG_HELP = {
  measured: 'Read from an official record or computed from a recorded outline.',
  estimated: 'Worked out by a rule of thumb. Change it if you know better.',
  'owner-confirmed': 'You entered or confirmed this value, so it is used instead of the planning default.',
  unavailable: 'Enter it to include it.',
};
const CONF_WORDS = { low: 'Low', medium: 'Medium', high: 'High' };
const GOAL_LABELS = {
  max_net_income: 'Most net income',
  min_upfront: 'Least money up front',
  min_effort: 'Least effort',
  privacy: 'Most privacy',
  fastest_payback: 'Fastest payback',
};
const GOAL_HELP = {
  max_net_income: 'The combination with the highest yearly net income.',
  min_upfront: 'The highest first-year cash after start-up costs.',
  min_effort: 'Only low-effort uses, then the highest net income.',
  privacy: 'Only uses that keep strangers out of your home, then the highest net income.',
  fastest_payback: 'The shortest time to earn back start-up costs.',
};
const BASIS_WORDS = { existing: 'Ready now', setup: 'Needs small setup', permit: 'Needs a permit first', construction: 'Needs building work first' };
const NOW_BASES = new Set(['existing', 'setup']);
const PROPERTY_TYPES = [
  ['single_family', 'Single-family home'], ['condo', 'Condo or apartment'], ['multi_family', 'Multi-family (2+ units)'],
  ['land', 'Vacant land'], ['commercial', 'Commercial'],
];
const EQUIPMENT = [['atv', 'ATV'], ['snowmobile', 'Snowmobile'], ['kayak', 'Kayak'], ['boat', 'Boat'], ['jet_ski', 'Jet ski'], ['ebike', 'E-bike'], ['camper', 'Camper']];

// ---- the owner's property list --------------------------------------------------------------------------------------
/** Always listed, in this order (an empty input when nothing was found). */
const FACT_ORDER = ['lot_area_sqft', 'living_area_sqft', 'bedrooms', 'bathrooms', 'floors', 'year_built', 'remodeled_year', 'roof_area_sqft', 'front_yard_sqft',
  'back_yard_sqft', 'yard_area_sqft', 'building_footprint_sqft', 'pool_present', 'parking_spaces', 'garage_present', 'property_type'];
/** Listed right after the yard lines, only when the lookup supplied a value (or the owner typed one). */
const AFTER_YARD = ['green_area_sqft', 'paved_area_sqft', 'pool_area_sqft', 'tree_cover_sqft'];
/** Listed after those when the profile has a value for them, in this order; any other owner-meaningful attribute follows. */
const MORE_ORDER = ['units', 'driveway_area_sqft', 'adu_present', 'zoning', 'transit_distance_m'];
/** Never listed: map and record internals. Address and parcel number appear once in the heading. */
const HIDDEN = new Set(['side_yard_sqft', 'address', 'location', 'jurisdiction', 'parcel_id', 'parcel_boundary', 'use_code', 'use_type', 'buildings', 'place_id',
  'demand_generators', 'equipment_owned', 'lat', 'lng', 'apn']);
const HIDDEN_RE = /(^|_)(id|ids|code|codes|boundary|polygon|geometry|location|lat|lng|source|sources|url|count|counts|mapped|raw|fips|method)$/;
const LABELS = {
  lot_area_sqft: 'Lot size', living_area_sqft: 'Home size', bedrooms: 'Bedrooms', bathrooms: 'Bathrooms', floors: 'Floors', year_built: 'Year built', remodeled_year: 'Remodeled (year)',
  green_area_sqft: 'Lawn and planting', paved_area_sqft: 'Paved area (driveway, patio)', pool_area_sqft: 'Pool size', tree_cover_sqft: 'Tree cover',
  roof_area_sqft: 'Roof area', front_yard_sqft: 'Front yard', back_yard_sqft: 'Back yard', usable_yard_sqft: 'Usable yard', usable_front_yard_sqft: 'Usable front yard', usable_back_yard_sqft: 'Usable back yard', yard_area_sqft: 'Yard (total open ground)',
  building_footprint_sqft: 'Building footprint', pool_present: 'Pool', parking_spaces: 'Parking spaces', garage_present: 'Garage', property_type: 'Property type',
  units: 'Units', driveway_area_sqft: 'Driveway area', adu_present: 'Guest house or ADU', zoning: 'Zoning', transit_distance_m: 'Nearest bus or train stop',
  address: 'Address', parcel_id: 'Parcel number',
};
const factLabel = (k) => LABELS[k] ?? cap(k.replace(/_(sqft|present|available|m|ft)$/, '').replace(/_/g, ' '));
const INT_KEYS = new Set(['year_built', 'remodeled_year', 'bedrooms', 'units', 'parking_spaces', 'floors']);
const NUMBER_KEYS = new Set(['lot_area_sqft', 'year_built', 'remodeled_year', 'bedrooms', 'bathrooms', 'floors', 'front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft', 'living_area_sqft', 'units',
  'building_footprint_sqft', 'roof_area_sqft', 'yard_area_sqft', 'driveway_area_sqft', 'parking_spaces', 'transit_distance_m']);
/** Unit shown next to a number, and the factor from the stored value to what is shown (metres are shown in feet). */
function unitOf(key) {
  if (/_sqft$/.test(key)) return { label: 'sq ft', store: 'sqft', factor: 1 };
  if (/_m$/.test(key)) return { label: 'ft', store: 'm', factor: 3.28084 };
  if (/_ft$/.test(key)) return { label: 'ft', store: 'ft', factor: 1 };
  return { label: '', store: undefined, factor: 1 };
}
const isBoolKey = (k) => /_(present|available)$/.test(k) || k === 'waterfront_access';
function kindOf(key, value) {
  if (key === 'property_type') return 'type';
  if (key === 'equipment_owned') return 'equipment';
  if (isBoolKey(key) || typeof value === 'boolean') return 'bool';
  if (NUMBER_KEYS.has(key) || typeof value === 'number' || /_(sqft|m|ft|spaces)$/.test(key)) return 'number';
  if (typeof value === 'string' || key === 'zoning') return 'text';
  return null; // objects and lists are not owner facts
}
const ESTIMATE_TIP = 'Estimated — change it if you know the exact figure';

// ---- earnings inputs ----------------------------------------------------------------------------------------------------
const INPUT_LABEL = (key, unit) => ({
  priceCents: `Price per ${unit}`, unitsPerMonth: `${cap(unit)}s rented per month`, capacityUnitsPerMonth: `${cap(unit)}s available per month`,
  bookingsPerMonth: 'Bookings per month', platformFeeRate: 'Listing-site fee', cleaningCentsPerBooking: 'Cleaning cost per booking',
  utilitiesCentsPerMonth: 'Extra utilities per month', insuranceCentsPerMonth: 'Extra insurance per month', taxRate: 'Occupancy or sales tax',
  permitCentsPerYear: 'Permit or registration fee per year', upfrontCents: 'Start-up cost (one time)', seasonality: 'Seasonality',
}[key] ?? key);
const CENTS_KEYS = new Set(['priceCents', 'cleaningCentsPerBooking', 'utilitiesCentsPerMonth', 'insuranceCentsPerMonth', 'permitCentsPerYear', 'upfrontCents']);
const RATE_KEYS = new Set(['platformFeeRate', 'taxRate']);
const NEEDED_KEYS = ['priceCents', 'unitsPerMonth', 'capacityUnitsPerMonth'];
const COST_LINES = [
  ['grossCentsPerMonth', 'Gross income', []],
  ['platformFeeCentsPerMonth', 'Listing-site fees', ['platformFeeRate']],
  ['cleaningCentsPerMonth', 'Cleaning', ['cleaningCentsPerBooking', 'bookingsPerMonth']],
  ['utilitiesCentsPerMonth', 'Extra utilities', ['utilitiesCentsPerMonth']],
  ['insuranceCentsPerMonth', 'Extra insurance', ['insuranceCentsPerMonth']],
  ['taxAndPermitCentsPerMonth', 'Taxes and permits', ['taxRate', 'permitCentsPerYear']],
];
function badge(tag) {
  return `<span class="chip ${TAG_CLASS[tag] ?? ''}" title="${esc(TAG_HELP[tag] ?? '')}">${esc(TAG_WORDS[tag] ?? tag)}</span>`;
}
const confText = (label) => `${CONF_WORDS[label] ?? label} confidence`;
/** Earnings notes from core name attributes by key; show them as words. */
const humanKeys = (t) => t.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (k) => factLabel(k).toLowerCase());

// ---------------------------------------------------------------------------------------------------------------
// state (in memory only)
// ---------------------------------------------------------------------------------------------------------------
const S = {
  run: 0, busy: false, address: '', phase: 'address', // address | confirm | candidates | results
  result: null, confirmed: false, path: '', countyMatched: '', // path: 'county' | 'fallback' (which lookup produced the profile)
  base: null, extra: {}, owner: {}, profile: null, loading: new Set(), notFound: false, hints: {},
  includeInvestments: false, overrides: {}, editInput: null,
  goal: 'max_net_income', maxUpfront: '', noStrangers: false, onlyKnownRules: false,
  open: new Set(), focusId: null, error: '', limiter: { lastAt: null }, keepStatus: false,
  page: 'property', // which of the two views is showing: 'property' | 'earn' (the same document; the History API links them)
  dirty: false, discardOk: false, // dirty = the owner has typed a correction this session; discardOk = they were warned that searching again drops it
};

const MAX_ADDRESS = 300; // same cap as the input's maxlength; a street address is never longer
const MAIN_MAX_MS = 10000; // the property screen (or the "add your details" list) is shown within this long after a submit
const els = { form: $('#address-form'), input: $('#address'), submit: $('#address-submit'), status: $('#status'), lookup: $('#lookup'), results: $('#results'), progress: $('#progress'),
  viewProperty: $('#view-property'), earn: $('#view-earn'), nextBar: $('#next-bar'), next: $('#next-earn') };
/** The satellite view of the lot (estimate/lot-map.js). It only reads the profile and pushes owner corrections back; it loads its own helpers lazily. */
const lotMap = initLotMap({ getProfile: () => S.profile, applyOwnerCorrections: (b) => applyOwnerCorrections(b), clearOwnerCorrections: (k) => clearOwnerCorrections(k), mount: document.getElementById('lot-map') });
/** Every lookup request goes through one in-memory session cache: the same question is never asked twice. */
const lookupFetch = sessionFetch((url, init) => fetch(url, init));

function announce(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('err', isError);
}
function recompute() {
  S.profile = S.base ? mergeProfile(S.base, S.extra, S.owner, nowIso()) : null;
  // the outlines the lookup measured (lot, buildings, street side, zones), for the satellite view; not an attribute, so it rides alongside
  if (S.profile && S.geometry) S.profile.geometry = S.geometry;
}

// ---------------------------------------------------------------------------------------------------------------
// progress bar: advances by finished stages, creeps slowly inside a stage, never goes back, never reaches 100 while busy
// ---------------------------------------------------------------------------------------------------------------
const STAGES = [['address', 'Finding your property…', 3, 25], ['records', 'Getting property records…', 25, 55], ['buildings', 'Measuring buildings and yard…', 55, 82], ['finishing', 'Finishing up…', 82, 96]];
const progress = {
  on: false, i: 0, value: 0, t0: 0, ts: 0, timer: null,
  start() {
    this.on = true; this.i = 0; this.value = STAGES[0][2]; this.t0 = performance.now(); this.ts = this.t0;
    clearInterval(this.timer); this.timer = setInterval(() => this.paint(), 250);
    els.progress.hidden = false; this.paint();
  },
  stage(name) {
    const j = STAGES.findIndex((s) => s[0] === name);
    if (!this.on || j <= this.i) return;
    this.i = j; this.ts = performance.now(); this.value = Math.max(this.value, STAGES[j][2]); this.paint();
  },
  paint() {
    if (!this.on) return;
    const [, label, from, to] = STAGES[this.i];
    const t = (performance.now() - this.ts) / 1000;
    this.value = Math.max(this.value, Math.round(from + (to - from) * 0.9 * (1 - Math.exp(-t / 2.5))));
    const secs = Math.floor((performance.now() - this.t0) / 1000);
    const bar = els.progress.querySelector('[role="progressbar"]');
    bar.setAttribute('aria-valuenow', String(this.value));
    bar.setAttribute('aria-valuetext', `${label} ${secs}s`);
    bar.querySelector('i').style.width = `${this.value}%`;
    els.progress.querySelector('.progress-label').textContent = `${label} ${secs}s`;
  },
  done() { this.on = false; clearInterval(this.timer); this.timer = null; els.progress.hidden = true; },
};

// ---------------------------------------------------------------------------------------------------------------
// lookups
// ---------------------------------------------------------------------------------------------------------------
async function lookup(extra = {}) {
  if (S.busy) return;
  const run = ++S.run;
  const t0 = Date.now();
  S.busy = true; els.submit.disabled = true; els.submit.classList.add('busy');
  announce('Finding your property…');
  if (S.phase === 'confirm' || S.phase === 'candidates') S.phase = 'address';
  progress.start();
  renderAll();
  const now = nowIso();
  const onStage = (s) => { if (run === S.run) progress.stage(s); };
  let out = null;
  // A candidate pick, or a confirmation that came from the older path, continues on the older path.
  const stayOld = Boolean(extra.parcelApn) || (extra.confirmMatchedAddress && S.path === 'fallback');
  if (!stayOld) {
    try {
      const c = await runCountyPath(S.address, { fetch: lookupFetch, now, onStage, nominatimLimiter: S.limiter, ...(S.picked ? { picked: S.picked } : {}), ...(extra.confirmMatchedAddress && S.countyMatched ? { confirmedAddress: S.countyMatched } : {}) });
      if (c.kind === 'ok') { out = c; S.path = 'county'; }
      else if (c.kind === 'confirm') { out = c; S.path = 'county'; S.countyMatched = c.matchedAddress; }
    } catch { /* the older path below answers instead */ }
  }
  if (!out && run === S.run) {
    S.path = 'fallback';
    const query = extra.confirmMatchedAddress && S.countyMatched && !extra.parcelApn ? S.countyMatched : S.address;
    out = await new Promise((resolve) => {
      const left = MAIN_MAX_MS - (Date.now() - t0);
      const t = setTimeout(() => resolve({ kind: 'none', profile: createProfile(), pending: [] }), Math.max(500, left));
      runOlderPath(query, { fetch: lookupFetch, now, onStage, nominatimLimiter: S.limiter, ...(extra.confirmMatchedAddress ? { confirmMatchedAddress: true } : {}), ...(extra.parcelApn ? { parcelApn: extra.parcelApn } : {}) })
        .then((r) => { clearTimeout(t); resolve(r); }, () => { clearTimeout(t); resolve({ kind: 'none', profile: createProfile(), pending: [] }); });
    });
    if (out.kind === 'confirm') S.countyMatched = out.matchedAddress;
  }
  if (run !== S.run) return;
  S.busy = false; els.submit.disabled = false; els.submit.classList.remove('busy');
  S.result = out;
  if (out.kind === 'confirm') {
    progress.done(); S.phase = 'confirm'; S.base = null; recompute(); S.focusId = 'confirm-yes';
    announce(`We found ${out.matchedAddress}. Is this your property?`);
  } else if (out.kind === 'candidates') {
    progress.done(); S.phase = 'candidates'; S.base = null; recompute(); S.focusId = 'cand-none';
    announce('Several properties match. Pick yours from the list.');
  } else if (out.kind === 'ok') {
    S.phase = 'results'; S.notFound = false; S.base = out.profile; S.extra = {}; recompute();
    announce('Here is your property. Type over anything that is not right.');
    S.focusId = 'h-profile';
    follow(run, out.pending ?? []);
  } else {
    progress.done(); S.phase = 'results'; S.notFound = true; S.base = out.profile ?? createProfile(); S.extra = {}; recompute();
    announce("We couldn't find that address automatically. Add your property details below.");
    S.focusId = 'h-profile';
  }
  S.keepStatus = S.phase === 'results';
  renderAll();
}

/** Fill in the values that arrive after the first screen. Each arrival re-renders without moving focus or typed text. */
function follow(run, pending) {
  const parts = pending.filter((p) => p && p.promise);
  if (!parts.length) { progress.done(); return; }
  for (const p of parts) for (const k of p.keys ?? []) S.loading.add(k);
  const left = new Set(parts);
  const nextStage = () => {
    if (!left.size) { progress.done(); return; }
    progress.stage([...left].some((p) => p.part === 'buildings') ? 'buildings' : 'finishing');
  };
  nextStage();
  for (const p of parts) {
    p.promise.then((v) => v, () => null).then((v) => {
      if (run !== S.run) return;
      if (v?.profile) S.base = v.profile;
      if (v?.attrs) Object.assign(S.extra, v.attrs);
      if (v?.geometry) S.geometry = v.geometry;
      for (const k of p.keys ?? []) S.loading.delete(k);
      left.delete(p);
      recompute(); S.keepStatus = S.page === 'property';
      renderAll();
      nextStage();
    });
  }
}

function resetSession() {
  S.result = null; S.confirmed = false; S.base = null; S.extra = {}; S.owner = {}; S.geometry = null; S.profile = null; S.loading = new Set(); S.notFound = false; S.hints = {};
  S.overrides = {}; S.editInput = null; S.phase = 'address'; S.error = ''; S.dirty = false; S.discardOk = false;
  S.path = ''; S.countyMatched = ''; S.picked = null;
  progress.done();
}

/** Start a new search or manual session only when nothing typed by the owner would be lost silently. */
function canRestart() {
  if (S.busy) { announce('Still finding your property. One moment.'); return false; }
  if (S.dirty && !S.discardOk) {
    S.discardOk = true;
    announce('You have changes on this page. Starting again clears them. Press the same button again to start over, or keep working below.', true);
    return false;
  }
  return true;
}

els.form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const q = els.input.value.trim().slice(0, MAX_ADDRESS);
  if (S.busy) { announce('Still finding your property. One moment.'); return; }
  if (!q) { announce('Please type an address first.', true); els.input.focus(); return; }
  if (!canRestart()) return;
  resetSession(); S.address = q; S.picked = getPickedLocation(q); S.run++; renderAll();
  lookup();
});
$('#manual-start').addEventListener('click', () => {
  if (!canRestart()) return;
  resetSession(); S.run++; S.address = els.input.value.trim(); S.phase = 'results'; S.base = createProfile(); recompute();
  announce('Add what you know about your property below.');
  S.keepStatus = true; S.focusId = 'h-profile';
  renderAll();
});

// ---------------------------------------------------------------------------------------------------------------
// compute (all numbers come from /core)
// ---------------------------------------------------------------------------------------------------------------
function compute() {
  const now = nowIso();
  const profile = S.profile;
  const opps = identifyOpportunities(profile, { now, includeInvestmentIdeas: S.includeInvestments });
  /** @type {Record<string, any>} */
  const estimates = {};
  for (const o of opps) {
    let inputs = defaultInputs(o, profile);
    const ov = S.overrides[o.id];
    if (ov && Object.keys(ov).length) {
      try { inputs = withOverrides(inputs, ov, now); } catch (e) { S.error = 'That value could not be used. Check it and try again.'; delete S.overrides[o.id]; }
    }
    estimates[o.id] = estimateOpportunity(o, inputs);
  }
  const constraints = { allowUnknownRegulatory: !S.onlyKnownRules, resourceCapacity: defaultResourceCapacity(profile) };
  if (S.noStrangers) constraints.noStrangersInHome = true;
  const mu = parseFloat(S.maxUpfront);
  if (S.maxUpfront !== '' && Number.isFinite(mu) && mu >= 0) constraints.maxUpfrontCents = Math.round(mu * 100); // dollars typed by the owner -> cents
  const opt = optimize(opps, estimates, { goal: S.goal, scenario: 'baseline', constraints });
  const byId = Object.fromEntries(opps.map((o) => [o.id, o]));
  return { now, opps, estimates, opt, byId };
}

// ---------------------------------------------------------------------------------------------------------------
// rendering. Every render keeps focus where it was and keeps text the owner is typing (late values never overwrite it).
// ---------------------------------------------------------------------------------------------------------------
function renderAll() {
  const explicit = S.focusId;
  S.focusId = null;
  const a = document.activeElement;
  const inPage = a && a !== document.body && a.id && (els.results.contains(a) || els.lookup.contains(a) || els.earn.contains(a));
  const keep = !explicit && inPage && a instanceof HTMLInputElement && a.type !== 'checkbox'
    ? { value: a.value, s: a.selectionStart, e: a.selectionEnd, invalid: a.getAttribute('aria-invalid') } : null;
  const target = explicit ?? (inPage ? a.id : null);
  if (S.page === 'earn') renderEarn();
  else { renderLookup(); renderResults(); }
  try { lotMap.update(); } catch { /* the picture is optional */ }
  if (!target) return;
  const el = document.getElementById(target);
  if (!el) return;
  if (keep && el instanceof HTMLInputElement) {
    el.value = keep.value;
    if (keep.invalid) el.setAttribute('aria-invalid', keep.invalid);
  }
  if (document.activeElement !== el) el.focus({ preventScroll: !explicit });
  if (keep && el instanceof HTMLInputElement) { try { el.setSelectionRange(keep.s, keep.e); } catch { /* not a text field */ } }
}

function dKey(key, label, body, _unused = false, cls = 'panel') {
  const open = S.open.has(key);
  return `<details class="${cls}" data-dk="${esc(key)}"${open ? ' open' : ''}><summary>${label}</summary>${body}</details>`;
}

function renderLookup() {
  const parts = [];
  if (S.phase === 'confirm' && S.result) {
    parts.push(`<section class="card" aria-labelledby="h-confirm"><h2 id="h-confirm">Is this your property?</h2>
      <p class="stack" style="margin-top:8px">We found <strong id="matched-address">${esc(S.result.matchedAddress)}</strong>. Is this your property?</p>
      <p class="small muted" style="margin-top:6px">You typed: ${esc(S.address)}</p>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="confirm-yes" type="button" data-act="confirm-yes">Yes, that is my property</button>
      <button class="btn" id="confirm-no" type="button" data-act="confirm-no">No, edit the address</button></div></section>`);
  }
  if (S.phase === 'candidates' && S.result) {
    const list = S.result.candidates.map((c, i) => `<li class="row between" style="padding:8px 0;border-top:${i ? '1px solid var(--line)' : '0'}">
        <span>${c.address ? esc(c.address) : 'Property with no street address'}${c.apn ? ` <span class="muted small">(parcel ${esc(c.apn)})</span>` : ''}</span>
        <button class="btn sm" id="pick-${safeId(c.apn ?? i)}" type="button" data-act="pick" data-apn="${esc(c.apn ?? '')}"${c.apn ? '' : ' disabled'}>This is mine</button></li>`).join('');
    parts.push(`<section class="card" aria-labelledby="h-cands"><h2 id="h-cands">Which one is yours?</h2>
      <p class="small muted" style="margin-top:6px">Several properties match that address. Pick yours.</p>
      <ul class="plain" style="list-style:none;padding:0;margin-top:8px">${list}</ul>
      <div style="margin-top:10px"><button class="btn" id="cand-none" type="button" data-act="cand-none">None of these. I will add the details myself</button></div></section>`);
  }
  els.lookup.innerHTML = parts.join('');
}

/** Page 1: the property list and the questions. No earnings content at all; nothing is computed here. */
function renderResults() {
  const ready = S.phase === 'results' && Boolean(S.profile);
  els.nextBar.hidden = !(ready || S.busy);
  els.next.disabled = !ready;
  const holder = document.getElementById('lot-map-holder'), mnt = document.getElementById('lot-map');
  if (holder && mnt && !holder.contains(mnt)) holder.append(mnt); // keep the mount point alive across the re-render
  if (!ready) { els.results.innerHTML = ''; return; }
  els.results.innerHTML = `<div class="stack">
    ${profileHtml()}
    <p class="small muted" id="session-note">Nothing is saved. If you reload or leave this page, everything you entered here is cleared and you start again.</p>
  </div>`;
  // the map agent's mount point lives in index.html (#lot-map); put it back between the heading and the list after each render
  const slot = document.getElementById('lot-map-slot'), mount = document.getElementById('lot-map');
  if (slot && mount) slot.append(mount);
  S.keepStatus = false;
}

// ---- profile -------------------------------------------------------------------------------------------------

const hasValue = (a) => Boolean(a) && a.tag !== 'unavailable' && a.value !== null && a.value !== undefined;
/** The keys listed, in order: the fixed list, then the extras that have something, then any other owner fact. */
function factKeys() {
  const attrs = S.profile.attributes;
  const keys = [...FACT_ORDER];
  const present = (k) => (hasValue(attrs[k]) || k in S.owner) && !attrs[k]?.hidden;
  // usable lines sit right after the line they refine; only when the lookup (or the owner) supplied them
  const put = (after, ...ks) => { const w = ks.filter(present); keys.splice(keys.indexOf(after) + 1, 0, ...w); };
  put('yard_area_sqft', ...AFTER_YARD); put('yard_area_sqft', 'usable_yard_sqft'); put('back_yard_sqft', 'usable_back_yard_sqft'); put('front_yard_sqft', 'usable_front_yard_sqft');
  const extra = (k) => !keys.includes(k) && !HIDDEN.has(k) && !HIDDEN_RE.test(k) && !attrs[k]?.hidden && (hasValue(attrs[k]) || k in S.owner) && kindOf(k, attrs[k]?.value) !== null && kindOf(k, attrs[k]?.value) !== 'equipment';
  for (const k of MORE_ORDER) if (extra(k)) keys.push(k);
  for (const k of Object.keys(attrs)) if (extra(k)) keys.push(k);
  return keys.filter((k) => !attrs[k]?.hidden);
}

/** What the input shows for a stored value. */
function shownText(key, a) {
  if (!hasValue(a)) return '';
  const v = a.value;
  if (typeof v !== 'number') return String(v);
  if (key === 'year_built' || key === 'remodeled_year') return String(v);
  const u = unitOf(key);
  const shown = v * u.factor;
  return u.factor === 1 ? nf.format(shown) : new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(shown);
}

function factRow(key) {
  const a = S.profile.attributes[key];
  const kind = kindOf(key, a?.value) ?? 'number';
  const has = hasValue(a);
  const mine = key in S.owner;
  const loading = !has && !mine && S.loading.has(key);
  const est = has && !mine && a.tag === 'estimated';
  const id = `f-${safeId(key)}`;
  const label = factLabel(key);
  const approx = `<span class="approx"${est ? ` title="${esc(ESTIMATE_TIP)}"` : ' aria-hidden="true"'}>${est ? `<span aria-hidden="true">≈</span><span class="sr-only">Estimated:</span>` : ''}</span>`;
  const hint = S.hints[key] ? `<p class="fact-hint" id="hint-${safeId(key)}" role="alert">${esc(S.hints[key])}</p>` : '';
  const describe = S.hints[key] ? ` aria-describedby="hint-${safeId(key)}" aria-invalid="true"` : '';
  let labelHtml, ctl;
  if (kind === 'bool') {
    labelHtml = `<span class="flabel" id="${id}-l">${esc(label)}</span>`;
    ctl = `${approx}<span class="yn${loading ? ' loading' : ''}" role="group" aria-labelledby="${id}-l"${loading ? ' aria-busy="true"' : ''}>${['yes', 'no'].map((v) => `<button type="button" class="yn-b" id="${id}-${v}" data-act="fact-bool" data-key="${esc(key)}" data-v="${v}" aria-pressed="${has && a.value === (v === 'yes') ? 'true' : 'false'}"${est ? ` title="${esc(ESTIMATE_TIP)}"` : ''}>${v === 'yes' ? 'Yes' : 'No'}</button>`).join('')}</span>`;
  } else if (kind === 'type') {
    labelHtml = `<label class="flabel" for="${id}">${esc(label)}</label>`;
    ctl = `${approx}<select id="${id}" data-fact="${esc(key)}"${est ? ` title="${esc(ESTIMATE_TIP)}"` : ''}><option value="">Add</option>${PROPERTY_TYPES.map(([k, l]) => `<option value="${k}"${has && a.value === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  } else {
    const u = kind === 'number' ? unitOf(key) : { label: '' };
    labelHtml = `<label class="flabel" for="${id}">${esc(label)}</label>`;
    ctl = `${approx}<input id="${id}" type="text" ${kind === 'number' ? 'inputmode="decimal" ' : ''}autocomplete="off" spellcheck="false" data-fact="${esc(key)}" data-kind="${kind}" value="${esc(shownText(key, a))}" placeholder="Add"${loading ? ' class="loading" aria-busy="true"' : ''}${est ? ` title="${esc(ESTIMATE_TIP)}"` : ''}${describe}>${kind === 'number' ? `<span class="unit"${u.label ? '' : ' aria-hidden="true"'}>${esc(u.label)}</span>` : ''}`;
  }
  const meta = mine ? `<span class="edited">Edited by you</span><button type="button" class="linkbtn" id="undo-${safeId(key)}" data-act="undo" data-key="${esc(key)}" aria-label="Undo your change to ${esc(label)}">Undo</button>` : '';
  return `<div class="fact${kind === 'number' ? ' num' : ''}" data-key="${esc(key)}" data-state="${mine ? 'edited' : loading ? 'loading' : has ? (est ? 'estimated' : 'value') : 'empty'}">
    ${labelHtml}<div class="fact-ctl">${ctl}</div><div class="fact-meta">${meta}</div>${hint}</div>`;
}

function sourcesHtml(keys) {
  const rows = [];
  const attrs = S.profile.attributes;
  for (const k of ['address', 'parcel_id', ...keys]) {
    const a = attrs[k];
    if (!hasValue(a) && !(k in S.owner)) continue;
    const src = a.tag === 'owner-confirmed' ? 'You' : a.source;
    rows.push(`<tr data-src="${esc(k)}"><th scope="row">${esc(factLabel(k))}</th><td>${esc(src)}</td><td>${esc(dateText(a.retrievedAt))}</td></tr>`);
  }
  if (!rows.length) return '';
  return dKey('sources', 'Where these numbers come from', `<div class="tablewrap"><table class="sources" id="sources-table"><caption class="sr-only">Where each number came from</caption>
    <thead><tr><th scope="col">Fact</th><th scope="col">Source</th><th scope="col">Date</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`, false, 'panel sources');
}

const YARD_GROUP = ['front_yard_sqft', 'usable_front_yard_sqft', 'back_yard_sqft', 'usable_back_yard_sqft', 'yard_area_sqft', 'usable_yard_sqft'];
/** The fact lines; one short helper line closes the yard group when usable-yard lines are shown. */
function factRowsHtml(keys) {
  const usable = keys.some((k) => k.startsWith('usable_'));
  const last = usable ? keys.filter((k) => YARD_GROUP.includes(k)).pop() : null;
  return keys.map((k) => factRow(k) + (k === last ? '<p class="yard-note small muted" id="yard-note">Usable yard leaves out strips too narrow to use.</p>' : '')).join('');
}

function profileHtml() {
  const attrs = S.profile.attributes;
  const addr = hasValue(attrs.address) ? String(attrs.address.value) : S.address;
  const apn = hasValue(attrs.parcel_id) ? String(attrs.parcel_id.value) : '';
  const keys = factKeys();
  const typeHint = hasValue(attrs.property_type) ? '' : '<p class="small muted" id="type-hint">Choose a property type to see more ideas.</p>';
  return `<section class="card" aria-labelledby="h-profile" id="property">
    <div class="prop-head"><h2 id="h-profile" tabindex="-1">${addr ? esc(addr) : 'Your property'}</h2>
      ${apn ? `<p class="small muted" id="prop-parcel">Parcel ${esc(apn)}</p>` : ''}
      <button class="btn primary sm next-top" id="next-earn-top" type="button" data-act="next-earn">Next: see what it could earn</button></div>
    ${S.notFound ? `<p class="callout" id="not-found">We couldn't find that address automatically. Add your property details below.</p>` : ''}
    <p class="small muted" id="facts-help">Type over any number that is not right. Everything below updates at once.</p>
    <div id="lot-map-slot"></div>
    <div class="facts" id="facts">${factRowsHtml(keys)}</div>
    ${typeHint}
    <div style="margin-top:12px">${questionsHtml(new Set(keys))}</div>
    <div style="margin-top:12px">${sourcesHtml(keys)}</div>
  </section>`;
}

function questionList(shown) {
  const items = missingEvidence(S.profile);
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const keys = it.needs.filter((k) => !seen.has(k) && !shown.has(k));
    if (!keys.length) continue;
    keys.forEach((k) => seen.add(k));
    const question = keys.length === 1 ? (ATTRIBUTE_QUESTIONS[keys[0]] ?? it.question) : it.question;
    out.push({ ...it, keys, question });
  }
  return out;
}

function questionControl(key, q) {
  const kind = kindOf(key, undefined);
  const id = `q-${safeId(key)}`;
  if (kind === 'bool') return `<span class="yn" role="group" aria-label="${esc(q)}">${['yes', 'no'].map((v) => `<button type="button" class="yn-b" id="${id}-${v}" data-act="fact-bool" data-key="${esc(key)}" data-v="${v}" aria-pressed="false">${v === 'yes' ? 'Yes' : 'No'}</button>`).join('')}</span>`;
  if (kind === 'type') return `<select id="${id}" data-fact="${esc(key)}" aria-label="${esc(q)}"><option value="">Choose&hellip;</option>${PROPERTY_TYPES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>`;
  if (kind === 'equipment') return `<div class="stack" id="${id}">${EQUIPMENT.map(([k, l]) => `<label class="check"><input type="checkbox" id="${id}-${k}" data-change="equip" data-key="${esc(key)}" value="${k}">${l}</label>`).join('')}
    <button class="btn sm" id="${id}-none" type="button" data-act="equip-none">I do not own any of these</button></div>`;
  const u = kind === 'number' ? unitOf(key) : { label: '' };
  return `<span class="fact-ctl"><input id="${id}" type="text" ${kind === 'number' ? 'inputmode="decimal" ' : ''}autocomplete="off" data-fact="${esc(key)}" data-kind="${kind ?? 'text'}" placeholder="Add" aria-label="${esc(factLabel(key))}${u.label ? ` (${u.label})` : ''}">${u.label ? `<span class="unit">${esc(u.label)}</span>` : ''}</span>${S.hints[key] ? `<p class="fact-hint" role="alert">${esc(S.hints[key])}</p>` : ''}`;
}

function questionsHtml(shown) {
  const qs = questionList(shown);
  if (!qs.length) return '';
  const body = qs.map((q) => `<div class="q"><div class="qtext">${esc(q.question)}</div>${q.keys.map((k) => questionControl(k, q.question)).join('<div style="height:6px"></div>')}</div>`).join('');
  return dKey('questions', `More things you could rent (${qs.length} question${qs.length === 1 ? '' : 's'})`, `<p class="small muted" style="margin-bottom:6px">Answer any you know. A yes adds that idea to the list below.</p>${body}`);
}

// ---- opportunities ---------------------------------------------------------------------------------------------

const RULE_WORDS = {
  feasible: ['ok', 'Allowed under the rules we have on file'],
  restricted: ['warn', 'Allowed with conditions'],
  prohibited: ['bad', 'Not allowed under the rules we have on file'],
  unknown: ['warn', 'Local rules not checked — confirm with your city'],
};
const EFFECT_WORDS = { allow: 'allowed', restrict: 'restricted', prohibit: 'not allowed', require: 'requirement' };

function whyConfidence(o, e) {
  const price = e.inputs.priceCents.tag === 'owner-confirmed', units = e.inputs.unitsPerMonth.tag === 'owner-confirmed';
  const reasons = [];
  if (!price && !units) reasons.push('price and bookings are Everyspace planning defaults, not market data');
  else if (!price) reasons.push('the price is an Everyspace planning default, not market data');
  else if (!units) reasons.push('the bookings are an Everyspace planning default, not market data');
  const f = o.feasibility;
  if (f.status === 'unknown') reasons.push('local rules were not checked');
  else if (f.rules.some((r) => !r.verified)) reasons.push('the local rule text is not yet verified');
  const costMissing = e.missing.filter((k) => !NEEDED_KEYS.includes(k) && k !== 'seasonality');
  if (costMissing.length) reasons.push('some costs are not included');
  for (const n of e.notIncluded ?? []) reasons.push(n.reason);
  const fee = e.inputs.platformFeeRate;
  if (fee.tag === 'estimated') reasons.push('the listing-site fee is an unverified estimate');
  if ((o.unit === 'night' || o.unit === 'hour') && e.inputs.seasonality.tag === 'estimated') reasons.push('busy and quiet months are not set (flat year assumed)');
  if (o.evidenceConfidence < 0.4) reasons.push('the property details behind it are estimated');
  if (!reasons.length) return `${CONF_WORDS[e.confidenceLabel]}: you entered your own price and bookings and the local rules are on file.`;
  return `${CONF_WORDS[e.confidenceLabel]}: ${reasons.join(', and ')}.`;
}

function scenarioTable(o, e) {
  const head = SCENARIO_NAMES.map((s) => `<th scope="col">${cap(s)}</th>`).join('');
  const cells = (period, field, cls = '') => SCENARIO_NAMES.map((s) => {
    const c = e.scenarios[s][field];
    return `<td class="${cls}" data-opp="${esc(o.id)}" data-scenario="${s}" data-period="${period}" data-cents="${c}">${money(c)}</td>`;
  }).join('');
  const breakdownRows = COST_LINES.map(([field, label, keys]) => {
    const allMissing = keys.length && keys.every((k) => e.inputs[k].tag === 'unavailable');
    const cs = SCENARIO_NAMES.map((s) => (allMissing ? '<td class="muted">Not included</td>' : `<td>${field === 'grossCentsPerMonth' ? '' : '−'}${money(e.scenarios[s][field])}</td>`)).join('');
    return `<tr><th scope="row">${label}</th>${cs}</tr>`;
  }).join('');
  const net = SCENARIO_NAMES.map((s) => `<td><strong>${money(e.scenarios[s].noiCentsPerMonth)}</strong></td>`).join('');
  const upfront = SCENARIO_NAMES.map((s) => `<td>${e.inputs.upfrontCents.tag === 'unavailable' ? '<span class="muted">Unknown</span>' : money(e.scenarios[s].upfrontCents)}</td>`).join('');
  const gy = SCENARIO_NAMES.map((s) => `<td>${money(e.scenarios[s].grossCentsPerYear)}</td>`).join('');
  return `<div class="tablewrap"><table class="scen" data-scen-table="${esc(o.id)}"><caption class="sr-only">Estimated net income for ${esc(o.label)}</caption>
    <thead><tr><th scope="col">Net income</th>${head}</tr></thead>
    <tbody><tr><th scope="row">Per month</th>${cells('month', 'noiCentsPerMonth')}</tr>
    <tr><th scope="row">Per year</th>${cells('year', 'noiCentsPerYear', 'big')}</tr></tbody></table></div>
    ${dKey(`bd-${o.id}`, 'Where the money goes (per month)', `<div class="tablewrap"><table class="scen"><caption class="sr-only">Monthly breakdown for ${esc(o.label)}</caption>
      <thead><tr><th scope="col">Line</th>${head}</tr></thead><tbody>${breakdownRows}
      <tr><th scope="row">Net income</th>${net}</tr>
      <tr><th scope="row">Gross income per year</th>${gy}</tr>
      <tr><th scope="row">Start-up cost</th>${upfront}</tr></tbody></table></div>`, false, 'panel')}`;
}

function inputValueText(key, s) {
  if (s.tag === 'unavailable') return 'Not set';
  if (key === 'seasonality') return s.value.every((x) => x === s.value[0]) ? 'Flat across the year (no seasonal data)' : '12 monthly multipliers';
  if (CENTS_KEYS.has(key)) return money2(s.value);
  if (RATE_KEYS.has(key)) return pct.format(s.value);
  return nf.format(s.value);
}
function inputEditor(o, key, idp) {
  const id = `${idp}-${safeId(o.id)}-${key}`;
  const unit = CENTS_KEYS.has(key) ? '$' : RATE_KEYS.has(key) ? '%' : '';
  return `<div class="edit-inline"><label class="sr-only" for="${id}">${esc(INPUT_LABEL(key, o.unit))}</label>${unit === '$' ? '<span aria-hidden="true">$</span>' : ''}<input id="${id}" type="number" min="0" step="any" inputmode="decimal" data-input-edit="${esc(o.id)}|${key}">${unit === '%' ? '<span aria-hidden="true">%</span>' : ''}
    <button class="btn sm primary" id="${idp}-save-${safeId(o.id)}-${key}" type="button" data-act="save-input" data-oid="${esc(o.id)}" data-key="${key}" data-field="${id}">Apply</button>
    ${idp === 'ei' ? `<button class="btn sm" id="ei-cancel-${safeId(o.id)}-${key}" type="button" data-act="cancel-input">Cancel</button>` : ''}</div>`;
}

function assumptionsHtml(o, e) {
  const rows = INPUT_KEYS.map((key) => {
    const s = e.inputs[key];
    const editing = S.editInput && S.editInput.oppId === o.id && S.editInput.key === key;
    const overridden = S.overrides[o.id] && key in S.overrides[o.id];
    const actions = key === 'seasonality' ? '<span class="small muted">Not editable</span>'
      : editing ? inputEditor(o, key, 'ei')
        : `<button class="btn sm" id="ei-edit-${safeId(o.id)}-${key}" type="button" data-act="edit-input" data-oid="${esc(o.id)}" data-key="${key}" aria-label="${s.tag === 'unavailable' ? 'Fill in' : 'Edit'} ${esc(INPUT_LABEL(key, o.unit))}">${s.tag === 'unavailable' ? 'Fill in' : 'Edit'}</button>`
        + (overridden ? ` <button class="btn sm ghost" id="ei-reset-${safeId(o.id)}-${key}" type="button" data-act="reset-input" data-oid="${esc(o.id)}" data-key="${key}" aria-label="Reset ${esc(INPUT_LABEL(key, o.unit))} to the planning default">Reset</button>` : '');
    return `<tr data-input="${key}"><th scope="row">${esc(INPUT_LABEL(key, o.unit))}</th>
      <td data-label="Value" class="num">${esc(inputValueText(key, s))}</td>
      <td data-label="Where it came from">${badge(s.tag)}</td>
      <td data-label="Source">${s.tag === 'unavailable' ? '<span class="muted">—</span>' : esc(s.source)}${s.note ? `<div class="tiny muted">${esc(s.note)}</div>` : ''}</td>
      <td data-label="Confidence">${s.tag === 'unavailable' ? '<span class="muted">—</span>' : esc(confText(confidenceLabel(s.confidence)))}</td>
      <td data-label="Change">${actions}</td></tr>`;
  }).join('');
  const assumptions = e.assumptions.filter((a) => !a.text.startsWith('Not included')).map((a) => `<li>${esc(a.text)} <span class="muted">(${esc(a.source)})</span></li>`).join('');
  const notIncluded = e.missing.filter((k) => !NEEDED_KEYS.includes(k) && k !== 'seasonality');
  const notInc = notIncluded.length ? `<h4 style="margin-top:12px">Not included</h4><ul class="plain">${notIncluded.map((k) => `<li>${esc(INPUT_LABEL(k, o.unit))}: not set.${k === 'upfrontCents' ? '' : ' Not subtracted from the estimate; enter it to include it.'}</li>`).join('')}</ul>` : '';
  return dKey(`as-${o.id}`, 'Assumptions and sources', `<div class="tablewrap"><table class="stack-sm" data-assumptions="${esc(o.id)}"><caption class="sr-only">Inputs for ${esc(o.label)}</caption>
    <thead><tr><th scope="col">Input</th><th scope="col">Value</th><th scope="col">Where it came from</th><th scope="col">Source</th><th scope="col">Confidence</th><th scope="col">Change</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${assumptions ? `<h4 style="margin-top:12px">Assumptions</h4><ul class="plain">${assumptions}</ul>` : ''}${notInc}`);
}

function ruleHtml(o) {
  const f = o.feasibility;
  const [cls, words] = RULE_WORDS[f.status] ?? RULE_WORDS.unknown;
  const unverified = f.status !== 'unknown' && f.rules.some((r) => !r.verified) ? ' (rule text not yet verified)' : '';
  const reqs = f.requirements.length ? `<div class="small" style="margin-top:6px"><strong>What you would need:</strong><ul class="plain">${f.requirements.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>` : '';
  const rules = f.rules.filter((r) => r.effect !== 'require').map((r) => `<li>${esc(r.summary)} <span class="muted">(${EFFECT_WORDS[r.effect] ?? r.effect}, ${r.verified ? 'verified' : 'not verified'}${r.sourceUrl && /^https?:\/\//.test(r.sourceUrl) ? `, <a href="${esc(r.sourceUrl)}" rel="noopener noreferrer">source</a>` : ''})</span></li>`).join('');
  return `<span class="chip ${cls}" data-rule-status="${esc(f.status)}">${esc(words)}${unverified}</span>
    ${f.note && f.status !== 'unknown' ? `<p class="small muted" style="margin-top:6px">${esc(f.note)}</p>` : ''}
    ${f.status === 'unknown' ? `<p class="small muted" style="margin-top:6px">${esc(f.note ?? '')}</p>` : ''}
    ${rules ? `<ul class="plain small" style="margin-top:6px">${rules}</ul>` : ''}${reqs}`;
}

function needHtml(o, e) {
  const need = e.missing.filter((k) => NEEDED_KEYS.includes(k));
  const keys = need.length ? need : e.missing.filter((k) => k !== 'seasonality');
  return `<div class="callout warn" data-unavailable="${esc(o.id)}"><strong>No estimate yet.</strong> We need: ${keys.map((k) => esc(INPUT_LABEL(k, o.unit).toLowerCase())).join(', ')}. Enter ${keys.length === 1 ? 'it' : 'them'} to see a range.
    <div class="stack" style="margin-top:8px">${keys.map((k) => `<div><div class="small"><strong>${esc(INPUT_LABEL(k, o.unit))}</strong></div>${inputEditor(o, k, 'need')}</div>`).join('')}</div></div>`;
}

/** A way's yearly range, or why there is none yet. */
function rangeText(e, suffix = '') {
  return e?.available ? `About ${money(e.scenarios.conservative.noiCentsPerYear)} to ${money(e.scenarios.optimistic.noiCentsPerYear)} a year${suffix}` : '';
}

/** One way to earn as a compact card: name, yearly range, and the full breakdown, assumptions and editors under "Details". */
function earnCard(o, e, { suffix = '', reason = '' } = {}) {
  const notes = o.notes.length ? `<ul class="plain small muted">${o.notes.map((n) => `<li>${esc(humanKeys(n))}</li>`).join('')}</ul>` : '';
  const range = rangeText(e, suffix);
  const inner = `<div class="chips">${ruleHtml(o)}</div>
    ${e.available ? `${scenarioTable(o, e)}<p class="why small" data-confidence="${esc(e.confidenceLabel)}">${esc(whyConfidence(o, e))}</p>` : ''}
    ${notes}
    <div style="margin-top:8px">${assumptionsHtml(o, e)}</div>`;
  return `<article class="card opp compact" data-opp-card="${esc(o.id)}" aria-labelledby="oh-${safeId(o.id)}">
    <header><h3 id="oh-${safeId(o.id)}">${esc(o.label)}</h3><span class="chip">${esc(BASIS_WORDS[o.basis] ?? o.basis)}</span></header>
    ${range ? `<p class="range" data-range="${esc(o.id)}">${esc(range)}</p>` : ''}
    ${reason ? `<p class="small muted reason" data-rejected="${esc(o.id)}">${esc(reason)}</p>` : ''}
    ${e.available ? '' : needHtml(o, e)}
    ${dKey(`det-${o.id}`, 'Details', inner, false, 'panel opp-details')}
  </article>`;
}

// ---- page 2: what it could earn -------------------------------------------------------------------------------------

function nameize(text, byId) {
  let t = text.replace(/(\d+) cents/g, (_, n) => money(Number(n)));
  for (const id of Object.keys(byId).sort((a, b) => b.length - a.length)) t = t.replace(new RegExp(`\\b${id}\\b`, 'g'), byId[id].label.toLowerCase());
  return t;
}

const BACK_LINK = '<a href="./" class="back" id="back-property" data-act="back-property">&larr; Back to my property</a>';

function controlsHtml() {
  const goalOpts = GOALS.map((g) => `<option value="${g}"${S.goal === g ? ' selected' : ''}>${GOAL_LABELS[g] ?? g}</option>`).join('');
  return `<section class="card" aria-labelledby="h-goal"><h2 id="h-goal">What matters to you</h2>
    <div class="fields" style="margin-top:10px">
      <label class="f" for="goal">What matters most to you?<select id="goal" data-change="goal">${goalOpts}</select></label>
      <label class="f" for="max-upfront">Most you would spend up front (optional)<input id="max-upfront" type="number" min="0" step="any" inputmode="decimal" data-change="maxUpfront" value="${esc(S.maxUpfront)}" placeholder="No limit"></label>
    </div>
    <p class="small muted" id="goal-help" style="margin-top:6px">${esc(GOAL_HELP[S.goal] ?? '')}</p>
    <div class="stack" style="margin-top:8px">
      <label class="check" for="no-strangers"><input type="checkbox" id="no-strangers" data-change="noStrangers"${S.noStrangers ? ' checked' : ''}>No strangers inside my home</label>
      <label class="check" for="only-known"><input type="checkbox" id="only-known" data-change="onlyKnown"${S.onlyKnownRules ? ' checked' : ''}>Only include uses whose local rules are on file</label>
      <label class="check" for="include-investments"><input type="checkbox" id="include-investments" data-change="investments"${S.includeInvestments ? ' checked' : ''}>Also show ideas that need building work or permits</label>
    </div></section>`;
}

function earnHtml(view) {
  const { opt, estimates, byId, opps } = view;
  const err = S.error ? `<div class="callout bad" role="alert" id="input-error">${esc(S.error)}</div>` : '';
  S.error = '';
  const totalsFor = (scn) => summarize(estimates, opt.selected, scn);
  const lo = opt.selected.length ? totalsFor('conservative').noiCentsPerYear : 0;
  const hi = opt.selected.length ? totalsFor('optimistic').noiCentsPerYear : 0;
  const found = opt.selected.length > 0 && hi > 0;
  const notice = `<div class="callout warn notice" id="notice"><p id="plan-note"><strong>These are planning estimates, not promises.</strong> Prices and bookings are Everyspace planning defaults unless you enter your own.</p>${S.onlyKnownRules ? '' : '<p id="rules-caution"><strong>Caution:</strong> local rules were not checked for the uses listed here. Confirm each one with your city before you start.</p>'}</div>`;
  let head;
  if (found) {
    head = `<p class="headline" id="earn-headline" data-low-cents="${lo}" data-high-cents="${hi}">Your property could earn about <strong>${money(lo)} to ${money(hi)}</strong> a year</p>
      <p class="small muted">After the costs we could count, for the best combination for the goal "${esc(GOAL_LABELS[S.goal] ?? S.goal)}". It is a range, not a promise.</p>`;
  } else if (!opps.length) {
    head = `<p class="headline none" id="earn-headline" data-empty="true">We have not found a way to earn yet. Add a few details about your property and we can show what it could earn.</p>
      <p style="margin-top:8px">${BACK_LINK}</p>`;
  } else {
    head = `<p class="headline none" id="earn-headline" data-empty="true">No combination fits your choices yet. Loosen a choice below, or add a few details about your property and we can show what it could earn.</p>
      <p style="margin-top:8px">${BACK_LINK}</p>`;
  }
  const inSel = new Set(opt.selected), inInv = new Set(opt.investments);
  const included = opt.selected.map((id) => earnCard(byId[id], estimates[id])).join('');
  const sameSet = opt.eligibleIds.length === opt.selected.length && opt.eligibleIds.every((id) => opt.selected.includes(id));
  let totalsBlock = '';
  if (opt.selected.length) {
    const totals = SCENARIO_NAMES.map((s) => ({ s, t: summarize(estimates, opt.selected, s) }));
    const th = SCENARIO_NAMES.map((s) => `<th scope="col">${cap(s)}</th>`).join('');
    const shown = (f, t) => (f === 'upfrontCents' && t.upfrontUnknownIds.length ? (t[f] === 0 ? 'Unknown' : `${money(t[f])} + unknown`) : money(t[f]));
    const row = (title, f, cls = '', attr = '') => `<tr><th scope="row">${title}</th>${totals.map(({ s, t }) => `<td class="${cls}" ${attr ? `data-scenario="${s}" data-period="${attr}" data-cents="${t[f]}"` : ''}>${shown(f, t)}</td>`).join('')}</tr>`;
    totalsBlock = dKey('combo-details', 'How the total adds up', `<div class="tablewrap"><table class="scen" id="combo-totals"><caption class="sr-only">Combined net income of the best combination</caption>
        <thead><tr><th scope="col">Combined</th>${th}</tr></thead><tbody>
        ${row('Net income per month', 'noiCentsPerMonth', '', 'month')}${row('Net income per year', 'noiCentsPerYear', 'big', 'year')}
        ${row('Gross income per year', 'grossCentsPerYear')}${row('Start-up cost', 'upfrontCents')}</tbody></table></div>
      ${sameSet ? '' : `<p class="why" id="combo-naive" style="margin-top:10px">Adding everything up would give <strong data-naive-cents="${opt.naiveSumNoiCentsPerYear}">${money(opt.naiveSumNoiCentsPerYear)}</strong>, but some of these cannot run together (they share the same space or resources, or would go over your start-up budget), so the realistic total is <strong data-real-cents="${opt.totals.noiCentsPerYear}">${money(opt.totals.noiCentsPerYear)}</strong>.
        <span class="muted small">Baseline net income per year.</span></p>`}
      <p class="small muted">Confidence: ${esc(CONF_WORDS[totals[1].t.confidenceLabel])}. ${totals[1].t.upfrontUnknownIds.length ? 'Start-up cost is unknown for some of these.' : ''}</p>`, false, 'panel');
  }
  const rejectedIds = new Map(opt.rejected.filter((r) => !inInv.has(r.id)).map((r) => [r.id, r.reason]));
  const leftIds = opps.map((o) => o.id).filter((id) => !inSel.has(id) && !inInv.has(id));
  const left = leftIds.length ? `<section aria-labelledby="h-left" id="combo-rejected"><div class="section-title"><h2 id="h-left">Left out of the best combination</h2><span class="small muted">${leftIds.length} option${leftIds.length === 1 ? '' : 's'}</span></div>
    ${leftIds.map((id) => earnCard(byId[id], estimates[id], { reason: rejectedIds.has(id) ? nameize(rejectedIds.get(id), byId) : '' })).join('')}</section>` : '';
  const inv = opt.investments.length ? `<section aria-labelledby="h-inv" id="combo-investments"><div class="section-title"><h2 id="h-inv">Needs a permit or building work first</h2><span class="small muted">Not in the total above</span></div>
    <p class="small muted">These need a permit, registration or building work before they can start. Start-up costs are unknown unless you enter them.</p>
    ${opt.investments.map((id) => earnCard(byId[id], estimates[id], { suffix: ' before start-up costs' })).join('')}</section>` : '';
  return `<div class="stack">
    <p>${BACK_LINK}</p>
    <h1 id="h-earn" tabindex="-1">What your property could earn</h1>
    <section class="card headcard" aria-label="Summary">${head}</section>
    ${notice}
    ${err}
    ${controlsHtml()}
    ${opt.selected.length ? `<section aria-labelledby="h-incl"><div class="section-title"><h2 id="h-incl">Ways in your best combination</h2><span class="small muted">${opt.selected.length} of ${opps.length} option${opps.length === 1 ? '' : 's'}</span></div>
      <div id="combo-selected" class="stack">${included}</div>${totalsBlock ? `<div style="margin-top:12px">${totalsBlock}</div>` : ''}</section>` : ''}
    ${left}
    ${inv}
    <p><a href="../host/">Already renting? Manage your spaces in the Host Console</a></p>
  </div>`;
}

/** Page 2. Computed here, on demand: the page-1 list never pays for it. */
function renderEarn() {
  if (!(S.phase === 'results' && S.profile)) { showProperty(false); return; }
  let view;
  try { view = compute(); } catch (e) {
    els.earn.innerHTML = `<div class="stack"><p>${BACK_LINK}</p><h1 id="h-earn" tabindex="-1">What your property could earn</h1><div class="callout bad" role="alert">Something went wrong while working out the estimates. Go back, change a value and try again.</div></div>`;
    return;
  }
  S.view = view;
  els.earn.innerHTML = earnHtml(view);
  if (S.keepStatus) { S.keepStatus = false; return; }
  const n = view.opps.length;
  announce(`Estimates updated: ${n} way${n === 1 ? '' : 's'} to earn found.`);
}

// ---- the two views: one document, linked by the History API (#earn) ---------------------------------------------------
const canEarn = () => S.phase === 'results' && Boolean(S.profile);
const TITLE_PROPERTY = document.title;
function showEarn(push) {
  if (!canEarn()) return false;
  S.page = 'earn';
  if (push) { try { history.pushState({ v: 'earn' }, '', '#earn'); } catch { /* ignore */ } }
  els.viewProperty.hidden = true; els.earn.hidden = false;
  document.title = 'What your property could earn - Everyspace';
  announce('Showing what your property could earn.');
  S.keepStatus = true; S.focusId = 'h-earn';
  renderAll();
  window.scrollTo(0, 0);
  return true;
}
function showProperty(fix) {
  const was = S.page;
  S.page = 'property';
  els.earn.hidden = true; els.viewProperty.hidden = false; els.earn.innerHTML = '';
  document.title = TITLE_PROPERTY;
  if (fix) { try { if (location.hash === '#earn') history.replaceState(null, '', location.pathname); } catch { /* ignore */ } }
  if (was === 'earn') { announce('Back to your property. Everything you entered is still here.'); S.keepStatus = true; S.focusId = 'h-address'; }
  renderAll();
  if (was === 'earn') window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => {
  if (location.hash === '#earn' && canEarn()) showEarn(false);
  else if (S.page === 'earn' || location.hash === '#earn') showProperty(true);
});

// ---------------------------------------------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------------------------------------------
/** One place that decides whether a number typed for a property fact is acceptable. Short, plain hints. */
function checkNumber(key, n) {
  if (!Number.isFinite(n) || n < 0) return { error: 'Enter a number, like 6,500.' };
  if (n > 1e9) return { error: 'That number looks too large.' };
  if (INT_KEYS.has(key) && !Number.isInteger(n)) return { error: 'Enter a whole number.' };
  if (key === 'remodeled_year') {
    const now = new Date().getUTCFullYear();
    if (!Number.isInteger(n) || n < 1800 || n > now) return { error: `Enter a 4-digit year from 1800 to ${now}.` };
    const built = S.profile?.attributes.year_built;
    if (hasValue(built) && typeof built.value === 'number' && n < built.value) return { error: `That is before the year built (${built.value}). Enter a later year.` };
    return { value: n };
  }
  if (key === 'year_built' && (n < 1600 || n > new Date().getUTCFullYear() + 2)) return { error: `Enter a year between 1600 and ${new Date().getUTCFullYear() + 2}.` };
  if (key === 'units' && n < 1) return { error: 'Enter at least 1.' };
  if (key === 'floors' && n < 1) return { error: 'Enter at least 1.' };
  return { value: n };
}
/** Typed text -> stored value, or {error}. Commas and spaces are fine; feet are converted back to metres where stored so. */
function parseFact(key, kind, raw) {
  if (kind === 'text') return { value: raw };
  const cleaned = raw.replace(/[,\s]/g, '').replace(/^[≈~]/, '');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(cleaned)) return { error: key === 'year_built' ? 'Enter a year, like 1962.' : key === 'remodeled_year' ? 'Enter a 4-digit year, like 2015.' : 'Enter a number, like 6,500.' };
  const u = unitOf(key);
  const r = checkNumber(key, Number(cleaned));
  if (r.error) return r;
  return { value: u.factor === 1 ? r.value : Math.round((r.value / u.factor) * 100) / 100 };
}

function setOwner(key, value) {
  S.dirty = true;
  S.owner = { ...S.owner, [key]: { value, at: nowIso(), unit: unitOf(key).store } };
  delete S.hints[key];
  recompute();
}

function showHint(input, key, msg) {
  S.hints[key] = msg;
  const row = input.closest('.fact, .q');
  row?.querySelectorAll('.fact-hint').forEach((n) => n.remove());
  const p = document.createElement('p');
  p.className = 'fact-hint'; p.id = `hint-${safeId(key)}`; p.setAttribute('role', 'alert'); p.textContent = msg;
  const fact = input.closest('.fact');
  if (fact) fact.append(p); else (input.closest('.fact-ctl') ?? input).after(p);
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', p.id);
}
function clearHint(input, key) {
  if (!S.hints[key]) return;
  delete S.hints[key];
  input.closest('.fact, .q')?.querySelectorAll('.fact-hint').forEach((n) => n.remove());
  input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby');
}

/** Apply what the owner typed into a fact input (Enter or leaving the field). Returns true when something changed. */
function applyFact(input, { keepFocus }) {
  const key = input.dataset.fact;
  const kind = input.dataset.kind ?? 'number';
  if (!key || !S.profile) return false;
  const cur = S.profile.attributes[key];
  const before = shownText(key, cur);
  const raw = input.value.trim();
  if (raw === before) { clearHint(input, key); return false; }
  if (raw === '') { input.value = before; clearHint(input, key); return false; }
  const r = parseFact(key, kind, raw);
  if (r.error) { input.value = before; showHint(input, key, r.error); announce(r.error, true); return false; }
  if (hasValue(cur) && cur.value === r.value) { input.value = before; clearHint(input, key); return false; }
  setOwner(key, r.value);
  if (keepFocus) S.focusId = input.id;
  renderAll();
  return true;
}

document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'next-earn') { if (!els.next.disabled) showEarn(true); return; }
  if (act === 'back-property') {
    ev.preventDefault();
    if (history.state && history.state.v === 'earn') history.back(); else showProperty(true);
    return;
  }
  if (act === 'confirm-yes') { S.confirmed = true; lookup({ confirmMatchedAddress: true }); return; }
  if (act === 'confirm-no') { S.phase = 'address'; S.result = null; announce('Edit the address and search again.'); renderAll(); els.input.focus(); els.input.select(); return; }
  if (act === 'pick') { lookup({ confirmMatchedAddress: S.confirmed, parcelApn: b.dataset.apn }); return; }
  if (act === 'cand-none') {
    S.phase = 'results'; S.notFound = false; S.base = S.result?.profile ?? createProfile(); S.extra = {}; recompute();
    announce('Add what you know about your property below.'); S.keepStatus = true; S.focusId = 'h-profile'; renderAll(); return;
  }
  if (act === 'fact-bool') {
    const key = b.dataset.key, v = b.dataset.v === 'yes';
    const cur = S.profile?.attributes[key];
    if (!(key in S.owner) && hasValue(cur) && cur.value === v && cur.tag !== 'estimated') return; // already says so
    setOwner(key, v);
    const rowId = `f-${safeId(key)}-${b.dataset.v}`;
    S.focusId = document.getElementById(rowId) || b.id === rowId ? rowId : b.id;
    renderAll();
    // a question that was answered becomes a line in the list: keep focus on that answer
    if (!document.getElementById(b.id)) (document.getElementById(rowId) ?? $('details[data-dk="questions"] > summary'))?.focus();
    return;
  }
  if (act === 'undo') {
    const key = b.dataset.key;
    const { [key]: _gone, ...rest } = S.owner;
    S.owner = rest; delete S.hints[key];
    recompute();
    const k = kindOf(key, S.profile.attributes[key]?.value);
    S.focusId = k === 'bool' ? `f-${safeId(key)}-yes` : `f-${safeId(key)}`;
    renderAll();
    announce(`${factLabel(key)} is back to the looked-up value.`);
    return;
  }
  if (act === 'equip-none') { setOwner('equipment_owned', []); renderAll(); return; }
  if (act === 'edit-input') { S.editInput = { oppId: b.dataset.oid, key: b.dataset.key }; S.open.add(`as-${b.dataset.oid}`); S.focusId = `ei-${safeId(b.dataset.oid)}-${b.dataset.key}`; renderAll(); return; }
  if (act === 'cancel-input') { const e = S.editInput; S.editInput = null; if (e) S.focusId = `ei-edit-${safeId(e.oppId)}-${e.key}`; renderAll(); return; }
  if (act === 'save-input') { saveInput(b.dataset.oid, b.dataset.key, b.dataset.field); return; }
  if (act === 'reset-input') {
    const ov = S.overrides[b.dataset.oid]; if (ov) { delete ov[b.dataset.key]; if (!Object.keys(ov).length) delete S.overrides[b.dataset.oid]; }
    S.focusId = `ei-edit-${safeId(b.dataset.oid)}-${b.dataset.key}`; renderAll();
  }
});

function parseInputRaw(key, raw) {
  const n = Number(String(raw).replace(/[,\s$%]/g, ''));
  if (String(raw).trim() === '' || !Number.isFinite(n) || n < 0) return { error: 'Enter a number that is zero or more.' };
  if (CENTS_KEYS.has(key)) return { value: Math.round(n * 100) }; // dollars typed by the owner -> integer cents
  if (RATE_KEYS.has(key)) return n > 100 ? { error: 'A percentage cannot be more than 100.' } : { value: n / 100 };
  return { value: n };
}
/** Show a rejected value next to the control as well as in the status line, so it is seen where the person is looking. */
function inlineError(el, msg) {
  if (!el) return;
  const host = el.closest('.edit-inline') ?? el.parentElement;
  host?.querySelector(':scope > .inline-err')?.remove();
  const p = document.createElement('p');
  p.className = 'inline-err'; p.setAttribute('role', 'alert'); p.textContent = msg;
  host?.append(p);
  el.setAttribute('aria-invalid', 'true');
}
function saveInput(oppId, key, fieldId) {
  const el = document.getElementById(fieldId);
  const r = parseInputRaw(key, el?.value ?? '');
  if (r.error) { announce(r.error, true); inlineError(el, r.error); el?.focus(); return; }
  S.dirty = true; S.overrides[oppId] = { ...(S.overrides[oppId] ?? {}), [key]: r.value };
  S.editInput = null; S.focusId = `ei-edit-${safeId(oppId)}-${key}`;
  renderAll();
}

document.addEventListener('keydown', (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLInputElement) || t.type === 'checkbox') return;
  if (t.dataset.fact) {
    if (ev.key === 'Enter') { ev.preventDefault(); applyFact(t, { keepFocus: true }); }
    else if (ev.key === 'Escape') {
      ev.preventDefault();
      t.value = shownText(t.dataset.fact, S.profile?.attributes[t.dataset.fact]);
      clearHint(t, t.dataset.fact);
      t.select();
    }
    return;
  }
  if (ev.key !== 'Enter') return;
  if (t.dataset.inputEdit) { ev.preventDefault(); const [oppId, key] = t.dataset.inputEdit.split('|'); saveInput(oppId, key, t.id); }
});
// Leaving a fact input applies it; wait one tick so the next focused control is known and keeps its focus.
document.addEventListener('focusout', (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLInputElement) || !t.dataset.fact) return;
  setTimeout(() => { if (document.body.contains(t)) applyFact(t, { keepFocus: false }); }, 0);
});
document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t instanceof HTMLInputElement && t.dataset.fact && S.hints[t.dataset.fact]) clearHint(t, t.dataset.fact);
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;
  if (t instanceof HTMLSelectElement && t.dataset.fact) {
    const key = t.dataset.fact;
    setTimeout(() => {
      if (t.value) { setOwner(key, t.value); if (document.activeElement === t || document.activeElement === document.body) S.focusId = t.id; renderAll(); }
    }, 0);
    return;
  }
  if (!t.dataset.change) return;
  const kind = t.dataset.change;
  // let focus settle on the next control (Tab) before the view is rebuilt
  setTimeout(() => {
    if (kind === 'equip') {
      const checked = [...document.querySelectorAll('[data-change="equip"]')].filter((c) => c.checked).map((c) => c.value);
      setOwner('equipment_owned', checked);
    } else if (kind === 'investments') S.includeInvestments = t.checked;
    else if (kind === 'goal') S.goal = t.value;
    else if (kind === 'maxUpfront') {
      S.maxUpfront = t.value.trim().replace(/[,$\s]/g, '');
      const mu = Number(S.maxUpfront);
      if (S.maxUpfront !== '' && (!Number.isFinite(mu) || mu < 0)) { S.maxUpfront = ''; S.error = 'Enter the most you would spend as a number that is zero or more, or leave it empty for no limit. No limit is applied for now.'; }
    }
    else if (kind === 'noStrangers') S.noStrangers = t.checked;
    else if (kind === 'onlyKnown') S.onlyKnownRules = t.checked;
    renderAll();
  }, 0);
});

// remember which <details> are open across re-renders
document.addEventListener('toggle', (ev) => {
  const d = ev.target;
  if (!(d instanceof HTMLDetailsElement) || !d.dataset.dk) return;
  if (d.open) S.open.add(d.dataset.dk); else S.open.delete(d.dataset.dk);
}, true);

// Nothing is saved, so arriving at #earn (a reload, a bookmark) has no property to show: start on page 1.
try { if (location.hash === '#earn') history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
renderAll();
attachAddressSuggest(els.input);

// An address submitted on the homepage arrives in the URL fragment (#address=...) or, without JavaScript there,
// the query (?address=...). Start the lookup once, as if the button had been pressed, then clear it from the address bar.
(function startFromUrl() {
  let addr = '';
  /** @type {URLSearchParams|null} */
  let frag = null;
  try {
    frag = new URLSearchParams(location.hash.replace(/^#/, ''));
    addr = frag.get('address') || new URLSearchParams(location.search).get('address') || '';
  } catch { addr = ''; }
  addr = addr.trim().slice(0, MAX_ADDRESS);
  if (!addr) return;
  try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  els.input.value = addr;
  // A suggestion chosen on the homepage carries its coordinates in the fragment, so this lookup need not find the address again.
  if (frag && frag.get('lat') !== null && frag.get('lng') !== null) {
    setPickedLocation({ text: addr, lat: Number(frag.get('lat')), lng: Number(frag.get('lng')), precision: frag.get('precision') ?? undefined, source: frag.get('source') ?? undefined });
  }
  els.form.requestSubmit();
})();

// ---------------------------------------------------------------------------------------------------------------
// What the satellite-map view (mounted in #lot-map, see index.html) needs from this page.
// ---------------------------------------------------------------------------------------------------------------
/** The current property profile (looked-up values with the owner's corrections applied), including `profile.geometry` when present; null before a property is shown. */
export function getProfile() { return S.profile; }
/**
 * Apply a batch of owner corrections `{[attributeKey]: value}` through the same path as typing into the list: the lines show
 * "Edited by you" (with Undo), page 2 recomputes, and nothing is stored. Values are stored as given (square feet for `_sqft`).
 * @param {Record<string, any>} batch
 */
export function applyOwnerCorrections(batch) {
  if (!S.profile || !batch || typeof batch !== 'object') return false;
  for (const [k, v] of Object.entries(batch)) if (v !== undefined && v !== null) setOwner(k, v);
  renderAll();
  return true;
}

/** Take owner corrections back off the list (as Undo does), for the map's "Reset outlines" and for lines its outlines produced. */
export function clearOwnerCorrections(keys) {
  let changed = false;
  for (const k of keys ?? []) if (k in S.owner) { const { [k]: _g, ...rest } = S.owner; S.owner = rest; delete S.hints[k]; changed = true; }
  if (changed) { recompute(); renderAll(); }
  return changed;
}
